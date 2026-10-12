import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TimelineLfo, fadeInOnInsert, smoothSet } from '../plugins/vocalDspUtils';
import { createNoiseGateCore } from '../engine/noiseGateCore';
import { createDjFilterCore, createLofiCore } from '../engine/colorFxCore';

/**
 * « Ce que j'entends = ce que j'exporte », au bit près (12/10/2026).
 *  - LFO de modulation (reverb, chorus, flanger, doubleur, délai) calés sur la position dans
 *    le morceau : même phase en lecture (d'où qu'on parte) et à l'export ;
 *  - export (contexte hors ligne) : ni fondu d'apparition ni glissement des réglages ;
 *  - cœurs DSP : instance neuve (export) = état de repos après un silence (lecture) ;
 *  - VST : le départ de la lecture envoie un bloc marqué RESET au pont.
 */

class FakeParam {
  value = 0;
  events: { kind: string; v: number; t: number }[] = [];
  setValueAtTime(v: number, t: number) { this.events.push({ kind: 'set', v, t }); this.value = v; }
  setTargetAtTime(v: number, t: number) { this.events.push({ kind: 'target', v, t }); }
  linearRampToValueAtTime(v: number, t: number) { this.events.push({ kind: 'ramp', v, t }); }
  cancelScheduledValues() { this.events.push({ kind: 'cancel', v: 0, t: 0 }); }
}

/** Contexte simulé : oscillateurs (forme, départ, arrêt) et ondes périodiques relevés. */
function fakeCtx(currentTime: number, offline: boolean) {
  const oscs: any[] = [];
  const ctx: any = {
    currentTime,
    createOscillator() {
      const o: any = { type: 'sine', frequency: new FakeParam(), wave: null, startAt: NaN, stopAt: Infinity,
        connect() { /* */ }, disconnect() { /* */ }, setPeriodicWave(w: any) { o.wave = w; },
        start(t: number) { o.startAt = t; }, stop(t?: number) { o.stopAt = t ?? ctx.currentTime; } };
      oscs.push(o);
      return o;
    },
    createPeriodicWave(re: Float32Array, im: Float32Array) { return { re: Array.from(re), im: Array.from(im) }; },
  };
  if (offline) Object.setPrototypeOf(ctx, (globalThis as any).OfflineAudioContext.prototype);
  return { ctx, oscs };
}

/** Valeur de l'oscillateur (onde périodique relevée) à l'instant t. */
const lfoValue = (o: any, t: number) => {
  const w = 2 * Math.PI * o.frequency.value * (t - o.startAt);
  let v = 0;
  for (let k = 1; k < o.wave.re.length; k++) v += o.wave.re[k] * Math.cos(k * w) + o.wave.im[k] * Math.sin(k * w);
  return v;
};

describe('LFO calé sur le morceau', () => {
  (globalThis as any).OfflineAudioContext ??= class OfflineAudioContext {};

  it('lecture lancée de deux points différents : même valeur à la même position du morceau', () => {
    const f = 0.5;
    // Lecture 1 : le morceau commence à l'instant 10 du contexte (départ de 0).
    const a = fakeCtx(9.9, false);
    const l1 = new TimelineLfo(a.ctx, {} as any, f);
    l1.sync(10, 10);
    // Lecture 2 : départ à 1,3 s dans le morceau, à l'instant 50 du contexte (origine 48,7).
    const b = fakeCtx(49.9, false);
    const l2 = new TimelineLfo(b.ctx, {} as any, f);
    l2.sync(48.7, 50);
    for (const pos of [1.3, 1.7, 2.25, 3.9]) {
      expect(lfoValue(l1.osc, 10 + pos)).toBeCloseTo(lfoValue(l2.osc, 48.7 + pos), 6);
    }
    // sin(2π f · position) : phase = position dans le morceau.
    expect(lfoValue(l1.osc, 10 + 0.5)).toBeCloseTo(Math.sin(2 * Math.PI * f * 0.5), 6);
  });

  it('export (hors ligne) : le rendu qui commence à 1,3 s retombe sur la lecture', () => {
    const f = 1.2;
    const off = fakeCtx(0, true);
    const lx = new TimelineLfo(off.ctx, {} as any, f);
    lx.sync(-1.3);   // instant 0 du rendu = 1,3 s du morceau
    expect(lx.osc.startAt).toBe(0);
    const live = fakeCtx(99, false);
    const ll = new TimelineLfo(live.ctx, {} as any, f);
    ll.sync(100 - 1.3, 100);
    for (const d of [0, 0.01, 0.37, 1.1]) expect(lfoValue(lx.osc, d)).toBeCloseTo(lfoValue(ll.osc, 100 + d), 6);
  });

  it("l'ancien oscillateur s'arrête à l'instant exact où le nouveau démarre (aucun trou, aucun recouvrement)", () => {
    const { ctx, oscs } = fakeCtx(5, false);
    const l = new TimelineLfo(ctx, {} as any, 2);
    l.sync(4, 6);
    expect(oscs[0].stopAt).toBe(6);
    expect(oscs[1].startAt).toBe(6);
  });

  it('triangle : forme triangle exacte (crête 1) et calée elle aussi', () => {
    const { ctx } = fakeCtx(0, false);
    const l = new TimelineLfo(ctx, {} as any, 1, 0, 'triangle');
    l.sync(0, 1);
    expect(lfoValue(l.osc, 1.25)).toBeCloseTo(1, 1);
    expect(lfoValue(l.osc, 1.75)).toBeCloseTo(-1, 1);
  });
});

describe('export : ni fondu ni glissement au départ', () => {
  it('fondu d’apparition : en direct seulement', () => {
    const live = fakeCtx(3, false).ctx, off = fakeCtx(0, true).ctx;
    const g1 = new FakeParam(), g2 = new FakeParam();
    fadeInOnInsert(g1 as any, live);
    fadeInOnInsert(g2 as any, off);
    expect(g1.events.some(e => e.kind === 'ramp')).toBe(true);
    expect(g2.events).toEqual([]);
    expect(g2.value).toBe(1);
  });
  it('réglage : lissé en direct, posé tel quel à l’export', () => {
    const live = fakeCtx(3, false).ctx, off = fakeCtx(0, true).ctx;
    const p1 = new FakeParam(), p2 = new FakeParam();
    smoothSet(p1 as any, 0.4, live);
    smoothSet(p2 as any, 0.4, off);
    expect(p1.events.map(e => e.kind)).toEqual(['target']);
    expect(p2.events.map(e => e.kind)).toEqual(['cancel', 'set']);
  });
});

const run = (core: any, x: Float32Array) => { const L = new Float32Array(x.length), R = new Float32Array(x.length); core.process(x, x, L, R, x.length); return L; };

describe('instance neuve (export) = état de repos après un silence (lecture)', () => {
  const SR = 48000;
  const burst = new Float32Array(2400).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / SR));
  it('Gate : fermé au repos, même attaque à l’export qu’en lecture', () => {
    const fresh = createNoiseGateCore(SR); fresh.setParams({ threshold: -40, range: 80 }); fresh.reset();
    const played = createNoiseGateCore(SR); played.setParams({ threshold: -40, range: 80 }); played.reset();
    run(played, burst); run(played, new Float32Array(SR));   // une écoute, puis 1 s de silence
    const a = run(fresh, burst), b = run(played, burst);
    let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    expect(d * 32768).toBeLessThan(1);
    expect(Math.abs(a[1])).toBeLessThan(0.5 * burst[1]);   // la porte s'ouvre avec son attaque (pas ouverte d'emblée)
  });
  it('Filtre DJ : le bouton est déjà à sa place (pas de balayage depuis le centre)', () => {
    const fresh = createDjFilterCore(SR); fresh.setParams({ filter: -0.5 }); fresh.reset();
    const played = createDjFilterCore(SR); played.setParams({ filter: -0.5 }); fresh.reset(); played.reset();
    run(played, new Float32Array(SR));
    const a = run(fresh, burst), b = run(played, burst);
    let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    expect(d * 32768).toBeLessThan(1);
  });
  it('Lo-fi : souffle et échantillonneur repartent pareil après une remise à zéro', () => {
    const c = createLofiCore(SR); c.setParams({ noise: 0.5, rate: 8000, bits: 10 });
    c.reset(); const a = run(c, burst);
    run(c, burst); c.reset(); const b = run(c, burst);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('VST : départ de lecture = bloc marqué RESET', () => {
  function loadWorklet() {
    const src = fs.readFileSync(path.resolve(__dirname, '../public/worklets/vst-bridge-processor-v6.js'), 'utf8');
    let Cls: any = null;
    class AudioWorkletProcessor { port: any = { postMessage: () => { /* */ }, onmessage: null }; }
    // eslint-disable-next-line no-new-func
    new Function('AudioWorkletProcessor', 'registerProcessor', src)(AudioWorkletProcessor, (_n: string, c: any) => { Cls = c; });
    return Cls;
  }
  it('le bloc qui suit le message part avec reset = true, même dans un long silence', () => {
    const Cls = loadWorklet();
    const proc = new Cls({ processorOptions: { prebufferFrames: 2048 } });
    const sent: any[] = [];
    // Le pont renvoie chaque bloc (silencieux) : au bout d'un moment, le worklet ne sollicite plus le pont.
    proc.port.onmessage({ data: { type: 'port', port: { postMessage: (m: any) => { sent.push(m); proc.onProcessed({ seq: m.seq, data: new Float32Array(256) }); }, set onmessage(_f: any) { /* */ } } } });
    proc.port.onmessage({ data: { type: 'active', on: true } });
    const params: Record<string, Float32Array> = {};
    for (let i = 0; i < 32; i++) params[`p${i}`] = new Float32Array([-1]);
    const block = () => proc.process([[new Float32Array(128), new Float32Array(128)], []], [[new Float32Array(128), new Float32Array(128)]], params);
    for (let k = 0; k < 400; k++) block();     // silence prolongé : les blocs ne partent plus
    const before = sent.length;
    block();
    expect(sent.length).toBe(before);
    proc.port.onmessage({ data: { type: 'reset' } });
    block();
    expect(sent.length).toBe(before + 1);
    expect(sent[sent.length - 1].reset).toBe(true);
    block(); block();
    expect(sent.slice(before + 1).every((m: any) => !m.reset)).toBe(true);
  });
  it('le Worker pose le drapeau 8 dans la trame', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../public/worklets/vst-bridge-worker-v6.js'), 'utf8');
    expect(src).toMatch(/\(reset \? 8 : 0\)/);
  });
});
