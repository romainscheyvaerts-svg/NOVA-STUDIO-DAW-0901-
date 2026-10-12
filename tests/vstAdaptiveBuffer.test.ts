import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  VstAdaptiveController, nextPrebufferStep, prebufferSteps, shrinkTarget, vstLateMessage,
  VST_PREBUFFER_FRAMES, VST_PREBUFFER_MAX_FRAMES, VST_SHRINK_CALM_S, VST_LATE_WINDOW_MS,
} from '../utils/vstAdaptiveBuffer';

/**
 * C6 — silence du pont VST : le VRAI worklet (public/worklets/vst-bridge-processor-v6.js),
 * sans Web Audio, face à un pont simulé qui répond avec un retard choisi (en blocs).
 */

const N = 128;

function loadWorklet() {
  const src = fs.readFileSync(path.resolve(__dirname, '../public/worklets/vst-bridge-processor-v6.js'), 'utf8');
  let Cls: any = null;
  class AudioWorkletProcessor { port: any = { postMessage: () => { /* */ }, onmessage: null }; }
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', src)(AudioWorkletProcessor, (_n: string, c: any) => { Cls = c; });
  return Cls;
}

/**
 * Lecture simulée : bloc k = valeur (k + 1) / 1e5 (unique, non nulle) ; le pont « plugin neutre »
 * renvoie le bloc `delay(seq)` blocs plus tard (livré avant le process() de ce bloc-là).
 * Sortie : n° du bloc rendu (-1 = silence) pour chaque process().
 */
function run(opts: { adaptive: boolean; blocks: number; delay: (seq: number, k: number) => number; onBlock?: (k: number, proc: any) => void }) {
  const Cls = loadWorklet();
  const proc = new Cls({ processorOptions: { prebufferFrames: VST_PREBUFFER_FRAMES, ...(opts.adaptive ? { maxPrebufferFrames: VST_PREBUFFER_MAX_FRAMES } : {}) } });
  const msgs: any[] = [];
  proc.port.postMessage = (m: any) => msgs.push(m);
  const pending: { at: number; m: any }[] = [];
  let k = 0;
  proc.port.onmessage({ data: { type: 'port', port: {
    postMessage: (m: any) => { pending.push({ at: k + Math.max(1, opts.delay(m.seq, k)), m: { seq: m.seq, data: new Float32Array(m.data.subarray(0, 2 * N)) } }); },
    set onmessage(_f: any) { /* */ },
  } } });
  proc.port.onmessage({ data: { type: 'active', on: true } });
  const params: Record<string, Float32Array> = {};
  for (let i = 0; i < 32; i++) params[`p${i}`] = new Float32Array([-1]);
  const out: number[] = [];
  for (k = 0; k < opts.blocks; k++) {
    // Retours arrivés avant ce bloc (ordre d'arrivée).
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= k) proc.onProcessed(pending.shift()!.m);
    opts.onBlock?.(k, proc);
    const v = (k + 1) / 1e5;
    const inL = new Float32Array(N).fill(v), inR = new Float32Array(N).fill(v);
    const oL = new Float32Array(N), oR = new Float32Array(N);
    proc.process([[inL, inR], []], [[oL, oR]], params);
    out.push(oL[0] === 0 ? -1 : Math.round(oL[0] * 1e5) - 1);
  }
  const stats = msgs.filter(m => m.type === 'stats');
  return { out, msgs, stats, last: stats[stats.length - 1], proc };
}

/** Blocs rendus : jamais un bloc sauté ni répété (suite strictement consécutive). */
const consecutive = (out: number[]) => {
  const played = out.filter(x => x >= 0);
  for (let i = 1; i < played.length; i++) if (played[i] !== played[i - 1] + 1) return false;
  return true;
};
const silencesAfter = (out: number[], from: number) => out.slice(from).filter(x => x < 0).length;

describe('C6 · paliers du tampon', () => {
  it('2048 → 3072 → 4096 → 6144 → 8192 (plafond)', () => {
    expect(prebufferSteps()).toEqual([2048, 3072, 4096, 6144, 8192]);
    expect(nextPrebufferStep(2048)).toBe(3072);
    expect(nextPrebufferStep(6144)).toBe(8192);
    expect(nextPrebufferStep(8192)).toBe(8192);
  });
  it('descente : le plus petit palier qui couvre l’âge mesuré des retours + la marge', () => {
    expect(shrinkTarget(8192, 300)).toBe(2048);       // pont redevenu rapide : retour à la base
    expect(shrinkTarget(8192, 3000)).toBe(4096);      // 3000 + 512 > 3072
    expect(shrinkTarget(4096, 7000)).toBe(4096);      // jamais au-dessus du palier actuel
  });
});

describe('C6 · worklet face à un pont en retard', () => {
  it('pont toujours en retard (30 blocs > 16 de tampon), tampon FIXE : tout est silence (le défaut d’avant), mais compté', () => {
    const r = run({ adaptive: false, blocks: 1500, delay: () => 30 });
    expect(silencesAfter(r.out, 0)).toBe(1500);
    expect(r.last.late).toBeGreaterThan(1000);
    expect(r.last.dropouts).toBeGreaterThanOrEqual(1);     // avant C6 : 0, silence muet
    expect(r.last.delayFrames).toBe(2048);
  });

  it('tampon ADAPTATIF : agrandi (avec marge) à 6144, plus aucun silence ensuite, aucun bloc sauté', () => {
    const r = run({ adaptive: true, blocks: 1500, delay: () => 30 });
    const grows = r.msgs.filter(m => m.type === 'delay');
    // 3072 ; pendant l'attente, des retours d'âge 30 : marge de 8 blocs → 6144, dans le même trou.
    expect(grows.map(m => m.frames)).toEqual([3072, 6144]);
    expect(r.last.delayFrames).toBe(6144);
    expect(r.last.dropouts).toBe(1);
    expect(silencesAfter(r.out, 500)).toBe(0);
    expect(consecutive(r.out)).toBe(true);
    // Seuls les blocs de la mise en route du plugin (≈ 1 s après son chargement : ses premiers
    // passages peuvent tarder, ce n'est pas un pont lent) sont perdus ; ensuite, plus rien.
    expect(r.out.find(x => x >= 0)).toBeLessThanOrEqual(375);
  });

  it('pont à gigue (5 à 40 blocs, retours dans le désordre) : tampon ≤ 6144, 0 silence après stabilisation', () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const r = run({ adaptive: true, blocks: 6000, delay: () => 5 + Math.floor(rnd() * 36) });
    expect(r.last.delayFrames).toBeLessThanOrEqual(6144);
    // Un seul trou après la mise en route : la marge absorbe les pics de gigue suivants.
    const after = r.out.slice(400);   // après la mise en route (want ≥ 375)
    let gaps = 0; for (let i = 0; i < after.length; i++) if (after[i] < 0 && (i === 0 || after[i - 1] >= 0)) gaps++;
    expect(gaps).toBeLessThanOrEqual(1);
    const firstOk = r.out.findIndex((x, i) => i > 0 && x >= 0 && r.out.slice(i).every(y => y >= 0));
    expect(firstOk).toBeGreaterThan(375);
    expect(firstOk).toBeLessThan(375 + 750);     // < 2 s après la mise en route (48 kHz)
    // Après la mise en route : plus aucun bloc sauté (les blocs en retard sont attendus).
    const afterWarmup = r.out.slice(400);
    expect(consecutive(afterWarmup)).toBe(true);
  });

  it('pont à l’heure : sortie identique au tampon fixe, au bloc près (fidélité inchangée)', () => {
    const a = run({ adaptive: true, blocks: 800, delay: () => 3 });
    const b = run({ adaptive: false, blocks: 800, delay: () => 3 });
    expect(a.out).toEqual(b.out);
    expect(a.msgs.some(m => m.type === 'delay')).toBe(false);
    expect(a.last.delayFrames).toBe(2048);
    expect(a.last.dropouts).toBe(0);
  });

  it('descente sur ordre (transport arrêté) : tampon 2048, id renvoyé dans les stats, plus de silence', () => {
    let fast = false;
    const r = run({
      adaptive: true, blocks: 2400, delay: () => (fast ? 2 : 30),
      onBlock: (k, proc) => {
        if (k === 1000) fast = true;
        if (k === 1400) proc.port.onmessage({ data: { type: 'delay', frames: 2048, id: 1 } });
      },
    });
    expect(r.last.delayFrames).toBe(2048);
    expect(r.last.delayId).toBe(1);
    expect(silencesAfter(r.out, 1400)).toBe(0);
  });

  it('pont en retard sur du SILENCE (plugin qui se charge, rien à entendre) : ni coupure ni agrandissement', () => {
    const Cls = loadWorklet();
    const proc = new Cls({ processorOptions: { prebufferFrames: VST_PREBUFFER_FRAMES, maxPrebufferFrames: VST_PREBUFFER_MAX_FRAMES } });
    const msgs: any[] = []; proc.port.postMessage = (m: any) => msgs.push(m);
    const pending: { at: number; m: any }[] = []; let k = 0;
    proc.port.onmessage({ data: { type: 'port', port: { postMessage: (m: any) => pending.push({ at: k + 30, m: { seq: m.seq, data: new Float32Array(256) } }), set onmessage(_f: any) { /* */ } } } });
    proc.port.onmessage({ data: { type: 'active', on: true } });
    const params: Record<string, Float32Array> = {}; for (let i = 0; i < 32; i++) params[`p${i}`] = new Float32Array([-1]);
    for (k = 0; k < 1200; k++) {
      while (pending.length && pending[0].at <= k) proc.onProcessed(pending.shift()!.m);
      proc.process([[new Float32Array(N), new Float32Array(N)], []], [[new Float32Array(N), new Float32Array(N)]], params);
    }
    expect(msgs.filter(m => m.type === 'delay')).toEqual([]);
    expect(msgs.filter(m => m.type === 'stats').pop().dropouts).toBe(0);
  });

  it('âge des retours mesuré (stats.ageMaxFrames)', () => {
    const r = run({ adaptive: true, blocks: 800, delay: () => 10 });
    expect(r.last.ageMaxFrames).toBe(10 * 128);
    expect(r.last.recvPeriod).toBeGreaterThan(300);
  });
});

describe('C6 · thread principal : coupures sur 10 s, descente, alerte', () => {
  const stats = (o: any) => ({ seq: 0, dropouts: 0, delayFrames: 2048, delayId: 0, ageMaxFrames: 256, recvPeriod: 375, ...o });

  it('compte les coupures des 10 dernières secondes', () => {
    const c = new VstAdaptiveController();
    c.onStats(stats({ seq: 375, dropouts: 0 }), 0);
    c.onStats(stats({ seq: 750, dropouts: 5 }), 1000);
    c.onStats(stats({ seq: 1125, dropouts: 12 }), 2000);
    expect(c.dropouts10s(2000)).toBe(12);
    expect(c.dropouts10s(1000 + VST_LATE_WINDOW_MS + 1)).toBe(7);
    expect(c.dropouts10s(2000 + VST_LATE_WINDOW_MS + 1)).toBe(0);
    expect(c.dropoutsTotal).toBe(12);
  });

  it('agrandissement suivi, descente seulement à l’arrêt et après 15 s de flux sans coupure', () => {
    const c = new VstAdaptiveController();
    expect(c.onGrow(6144)).toBe(true);
    expect(c.prebuffer).toBe(6144);
    let seq = 0;
    for (let s = 0; s < VST_SHRINK_CALM_S - 1; s++) c.onStats(stats({ seq: (seq += 375), delayFrames: 6144 }), s * 1000);
    expect(c.shrink(false)).toBeNull();                 // pas encore assez calme
    c.onStats(stats({ seq: (seq += 375), delayFrames: 6144 }), 20000);
    c.onStats(stats({ seq: (seq += 375), delayFrames: 6144 }), 21000);
    expect(c.shrink(true)).toBeNull();                  // en lecture : jamais
    expect(c.shrink(false)).toEqual({ frames: 2048, id: 1 });
    expect(c.prebuffer).toBe(2048);
    // Stats d'avant l'ordre (id 0) : ignorées ; celles d'après : adoptées.
    expect(c.onStats(stats({ seq: (seq += 375), delayFrames: 6144, delayId: 0 }), 22000)).toBe(false);
    expect(c.prebuffer).toBe(2048);
  });

  it('pont toujours lent (âge mesuré élevé) : redescend seulement au palier qui suffit', () => {
    const c = new VstAdaptiveController();
    c.onGrow(8192);
    for (let s = 1; s <= 20; s++) c.onStats(stats({ seq: s * 375, delayFrames: 8192, ageMaxFrames: 4800 }), s * 1000);
    expect(c.shrink(false)?.frames).toBe(6144);
  });

  it('pont lent PUIS redevenu rapide : seules les 15 dernières secondes comptent → retour à la base', () => {
    const c = new VstAdaptiveController();
    c.onGrow(6144);
    let s = 0;
    for (; s < 10; s++) c.onStats(stats({ seq: (s + 1) * 375, delayFrames: 6144, ageMaxFrames: 5760 }), s * 1000);
    for (; s < 26; s++) c.onStats(stats({ seq: (s + 1) * 375, delayFrames: 6144, ageMaxFrames: 512 }), s * 1000);
    expect(c.calmAgeMax).toBe(512);
    expect(c.shrink(false)?.frames).toBe(2048);
  });

  it('une coupure remet le compteur de calme à zéro', () => {
    const c = new VstAdaptiveController();
    c.onGrow(4096);
    for (let s = 1; s <= 20; s++) c.onStats(stats({ seq: s * 375, delayFrames: 4096 }), s * 1000);
    c.onStats(stats({ seq: 21 * 375, delayFrames: 4096, dropouts: 1 }), 21000);
    expect(c.shrink(false)).toBeNull();
  });

  it('alerte : au plus une toutes les 4 s, message compréhensible', () => {
    const c = new VstAdaptiveController();
    c.onStats(stats({ seq: 375, dropouts: 12 }), 1000);
    expect(c.alertDue(1000)).toBe(true);
    expect(c.alertDue(2000)).toBe(false);
    expect(c.alertDue(2000, true)).toBe(true);
    c.onGrow(6144);
    expect(vstLateMessage('Pro-C 3', c.state(2000), 48000))
      .toBe('Le plugin Pro-C 3 a pris du retard : 12 coupures en 10 s. Tampon agrandi à 128 ms, retard compensé : la piste reste calée.');
    c.onGrow(8192);
    expect(vstLateMessage('Pro-C 3', c.state(2000), 48000)).toMatch(/Tampon déjà au maximum \(171 ms\) : gèle la piste/);
  });
});
