import { describe, it, expect } from 'vitest';
import { createTakeRing, ringWrite, ringRead, RING_LOST, takeRingSource } from '../engine/takeRing';
import { probePattern, findDelay } from '../engine/latencyProbe';
import { RecoveryStore, memoryBackend, TAKE_CHUNKS } from '../utils/recoveryStore';
import { NOVA_RECORDER_WORKLET } from '../engine/NovaRecorder';

describe('anneau des prises (fil audio → écrivain)', () => {
  it('écrit et relit à l\'échantillon près, en faisant le tour de l\'anneau', () => {
    const r = createTakeRing(2, 1000, 0.5);      // 512 images
    const h = new Int32Array(r.header), d = new Float32Array(r.data);
    const got: number[][] = [[], []];
    let v = 0;
    for (let b = 0; b < 40; b++) {
      const a = new Float32Array(128), c = new Float32Array(128);
      for (let i = 0; i < 128; i++) { a[i] = v; c[i] = -v; v++; }
      expect(ringWrite(h, d, r.capacity, 2, [a, c], 128, false)).toBe(true);
      if (b % 3 === 2) { const x = ringRead(h, d, r.capacity, 2, 10_000)!; got[0].push(...x[0]); got[1].push(...x[1]); }
    }
    const x = ringRead(h, d, r.capacity, 2, 10_000);
    if (x) { got[0].push(...x[0]); got[1].push(...x[1]); }
    expect(got[0].length).toBe(40 * 128);
    expect(got[0].every((y, i) => y === i)).toBe(true);
    expect(got[1].every((y, i) => y === -i)).toBe(true);
    expect(Atomics.load(h, RING_LOST)).toBe(0);
  });

  it('anneau plein : le fil audio n\'attend pas, les images sont comptées perdues, rien n\'est écrasé', () => {
    const r = createTakeRing(1, 1000, 0.25);     // 256 images
    const h = new Int32Array(r.header), d = new Float32Array(r.data);
    const blk = new Float32Array(128).fill(1);
    expect(ringWrite(h, d, r.capacity, 1, [blk], 128, false)).toBe(true);
    expect(ringWrite(h, d, r.capacity, 1, [blk], 128, false)).toBe(true);
    expect(ringWrite(h, d, r.capacity, 1, [blk], 128, false)).toBe(false);
    expect(Atomics.load(h, RING_LOST)).toBe(128);
    expect(ringRead(h, d, r.capacity, 1, 1000)![0].length).toBe(256);
  });

  it('mono : moyenne des canaux présents, silence quand l\'entrée manque (horloge gardée)', () => {
    const r = createTakeRing(1, 1000, 0.25);
    const h = new Int32Array(r.header), d = new Float32Array(r.data);
    ringWrite(h, d, r.capacity, 1, [new Float32Array(128).fill(1), new Float32Array(128).fill(0)], 128, true);
    ringWrite(h, d, r.capacity, 1, null, 128, true);
    const x = ringRead(h, d, r.capacity, 1, 1000)![0];
    expect(x.length).toBe(256);
    expect(x[0]).toBe(0.5);
    expect(x[200]).toBe(0);
  });

  it('le code du worklet embarque l\'écriture de l\'anneau (fonction autonome)', () => {
    expect(takeRingSource()).toMatch(/^const ringWrite = \(/);
    expect(NOVA_RECORDER_WORKLET).toContain('const ringWrite');
    expect(NOVA_RECORDER_WORKLET).toContain("registerProcessor('nova-recorder'");
    // Le code injecté s'évalue seul (aucune référence extérieure).
    // eslint-disable-next-line no-new-func
    const f = new Function(`${takeRingSource()} return ringWrite;`)();
    expect(typeof f).toBe('function');
  });

  it("le module complet de l'enregistreur s'évalue (aucune erreur de syntaxe dans le code du worklet)", () => {
    const code = NOVA_RECORDER_WORKLET.replace("registerProcessor('nova-recorder', NovaRecorder);", '');
    // eslint-disable-next-line no-new-func
    const K = new Function('AudioWorkletProcessor', code + '; return NovaRecorder;')(class { port = { postMessage() {}, onmessage: null }; });
    expect(typeof K).toBe('function');
  });
});

describe('mesure de la latence par boucle', () => {
  it('retrouve le retard exact du balayage dans une capture bruitée', () => {
    const sr = 48000, pat = probePattern(sr);
    const cap = new Float32Array(Math.round(sr * 0.6));
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let i = 0; i < cap.length; i++) cap[i] = rnd() * 0.02;
    const D = 1234;
    for (let i = 0; i < pat.length; i++) cap[D + i] += pat[i] * 0.3;
    const r = findDelay(cap, pat);
    expect(r.lag).toBe(D);
    expect(r.clarity).toBeGreaterThan(8);
  });

  it('sans balayage (micro loin, silence) : non reconnu', () => {
    const sr = 48000, pat = probePattern(sr);
    const cap = new Float32Array(Math.round(sr * 0.2));
    let seed = 7;
    for (let i = 0; i < cap.length; i++) { seed = (seed * 16807) % 2147483647; cap[i] = (seed / 2147483647 - 0.5) * 0.1; }
    expect(findDelay(cap, pat).clarity).toBeLessThan(8);
  });
});

describe('journal de prise écrit par l\'écrivain de prises', () => {
  it('external() : le journal garde la description, push() ne stocke plus rien, la récupération relit les morceaux de l\'écrivain', async () => {
    const db = memoryBackend();
    const store = new RecoveryStore(db, () => 1000);
    const j = store.beginTake({ takeId: 't1', projectId: 'p', trackId: 'v', trackName: 'Voix', sampleRate: 48000, recordedAt: 2, latency: 0.02 });
    j.external();
    j.push(new Float32Array(48000));
    j.annotate({ lead: 0.5 });
    // Ce que l'écrivain (Worker) écrit : [prise, n°].
    await db.put(TAKE_CHUNKS, ['t1', 0], new Float32Array(12000).fill(0.1));
    await db.put(TAKE_CHUNKS, ['t1', 1], new Float32Array(6000).fill(0.2));
    const takes = await store.takesToRecover();
    expect(takes.length).toBe(1);
    expect(takes[0].samples.length).toBe(18000);
    expect(takes[0].meta.lead).toBe(0.5);
    await j.finish();
    expect(j.isExternal).toBe(true);
  });
});
