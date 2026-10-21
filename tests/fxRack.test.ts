/**
 * Rack d'effets parallèles (écart 13, 22/10/2026) : règles pures (engine/fxRack.ts) et câblage du
 * nœud (engine/FxRackNode.ts) rendu par un mini moteur Web Audio hors ligne (gains, retards entiers,
 * filtres biquad aux formules du Web Audio, séparateur / fusion de canaux).
 *  - réglages par défaut (2 branches vides à −6,02 dB) : sortie = entrée AU BIT PRÈS ;
 *  - 2 branches vides à 0 dB : +6,02 dB exact (×2) ; mélange 0 % : le son d'origine au bit près ;
 *  - 2 et 3 bandes : la somme se reconstruit à ±0,1 dB (50 Hz – 16 kHz) ; centre / côtés vides : G, D rendus ;
 *  - branche avec un effet à latence : branches et son sec réalignés (écart nul), latence annoncée ;
 *  - coupure, solo, niveaux ; effets ajoutés / retirés (créés / libérés) ; registre, automation.
 */
import { describe, it, expect } from 'vitest';
import { FxRackNode, type RackHost } from '../engine/FxRackNode';
import {
  sanitizeRack, rackDefaults, rackAlignment, levelToGain, branchGain, branchLabel, withMode, withChildParams, rackStructureKey,
  HALF_DB, RACK_AUTOMATABLE, RACK_EXCLUDED,
} from '../engine/fxRack';
import { getRegisteredPlugin, registryMenuItems } from '../engine/pluginRegistry';

const SR = 48000;

// ── Mini moteur Web Audio hors ligne (rendu du signal entier, sans boucle) ──────────────
class P { value: number; constructor(v: number) { this.value = v; }
  setValueAtTime(v: number) { this.value = v; return this; } setTargetAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; return this; } cancelScheduledValues() { return this; } }
type Edge = { from: N; out: number; inp: number };
class N {
  ins: Edge[] = []; outs: { to: N; out: number; inp: number }[] = [];
  gain = new P(1); delayTime = new P(0); frequency = new P(350); Q = new P(1);
  type: string = 'lowpass';
  channelCount = 2; channelCountMode = 'max'; channelInterpretation = 'speakers';
  cache: Float64Array[][] | null = null;
  constructor(public kind: 'gain' | 'delay' | 'biquad' | 'split' | 'merge' | 'src', public data: Float64Array[] = []) {}
  connect(dest: N, out = 0, inp = 0) { dest.ins.push({ from: this, out, inp }); this.outs.push({ to: dest, out, inp }); return dest; }
  disconnect(dest?: N) {
    const drop = this.outs.filter(o => !dest || o.to === dest);
    for (const o of drop) o.to.ins = o.to.ins.filter(e => !(e.from === this && e.out === o.out && e.inp === o.inp));
    this.outs = this.outs.filter(o => !drop.includes(o));
  }
}
let LEN = 0;
const zeros = () => new Float64Array(LEN);
function mixTo(chs: Float64Array[][], n: number): Float64Array[] {
  const out = Array.from({ length: n }, zeros);
  for (const c of chs) {
    if (c.length === n) c.forEach((x, k) => { for (let i = 0; i < LEN; i++) out[k][i] += x[i]; });
    else if (c.length === 1 && n === 2) for (let i = 0; i < LEN; i++) { out[0][i] += c[0][i]; out[1][i] += c[0][i]; }
    else if (c.length === 2 && n === 1) for (let i = 0; i < LEN; i++) out[0][i] += 0.5 * (c[0][i] + c[1][i]);
  }
  return out;
}
function biquad(x: Float64Array, type: string, f0: number, qDb: number): Float64Array {
  const w0 = 2 * Math.PI * f0 / SR, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * Math.pow(10, qDb / 20));
  const lp = type === 'lowpass';
  const b0 = lp ? (1 - cw) / 2 : (1 + cw) / 2, b1 = lp ? 1 - cw : -(1 + cw), b2 = b0, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  const y = zeros(); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < LEN; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const f32 = (a: Float64Array) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.fround(a[i]); return o; };
function evalN(n: N, out = 0): Float64Array[] {
  if (n.kind === 'src') return n.data;
  if (!n.cache) {
    const all = (inp?: number) => n.ins.filter(e => inp === undefined || e.inp === inp).map(e => evalN(e.from, e.out));
    const ins = all();
    const ch = n.channelCountMode === 'explicit' ? n.channelCount : Math.max(1, ...ins.map(c => c.length));
    let res: Float64Array[];
    if (n.kind === 'gain') res = mixTo(ins, ch).map(c => f32(c.map(v => v * n.gain.value)));
    else if (n.kind === 'delay') { const d = Math.round(n.delayTime.value * SR); res = mixTo(ins, ch).map(c => { const o = zeros(); for (let i = d; i < LEN; i++) o[i] = c[i - d]; return o; }); }
    else if (n.kind === 'biquad') res = mixTo(ins, ch).map(c => f32(biquad(c, n.type, n.frequency.value, n.Q.value)));
    else if (n.kind === 'split') res = mixTo(ins, 2);
    else res = [mixTo(all(0), 1)[0], mixTo(all(1), 1)[0]].map(f32);
    n.cache = n.kind === 'split' ? res.map(c => [c]) as any : [res] as any;
  }
  return n.kind === 'split' ? (n.cache as any)[out] : (n.cache as any)[0];
}
function makeCtx() {
  const nodes: N[] = [];
  const mk = (k: N['kind']) => { const x = new N(k); nodes.push(x); return x; };
  const ctx: any = {
    sampleRate: SR, currentTime: 0, startRendering: () => null,
    createGain: () => mk('gain'), createDelay: () => mk('delay'), createBiquadFilter: () => mk('biquad'),
    createChannelSplitter: () => mk('split'), createChannelMerger: () => mk('merge'),
  };
  return { ctx: ctx as BaseAudioContext, reset: () => nodes.forEach(x => { x.cache = null; }) };
}
/** Effet factice : gain, et éventuellement une latence (retard entier, annoncé). */
function fakeHost(ctx: BaseAudioContext, made: string[] = [], freed: string[] = []): RackHost {
  return {
    createPlugin: (p) => {
      made.push(p.id);
      const c: any = ctx;
      const input = c.createGain();
      const lat = +(p.params?.lat || 0);
      let output = input;
      if (lat) { const d = c.createDelay(); d.delayTime.value = lat / SR; input.connect(d); output = d; }
      const g = c.createGain(); g.gain.value = p.params?.gain ?? 1; output.connect(g);
      return { input, output: g, node: { latency: lat / SR, updateParams: (q: any) => { if (typeof q.gain === 'number') g.gain.value = q.gain; }, dispose: () => freed.push(p.id) } };
    },
  };
}
function render(params: any, L: Float64Array, R: Float64Array, host?: (ctx: BaseAudioContext) => RackHost) {
  LEN = L.length;
  const { ctx } = makeCtx();
  const node = new FxRackNode(ctx, { id: 'r', name: 'Rack', type: 'FXRACK', isEnabled: true, latency: 0, params } as any, host ? host(ctx) : fakeHost(ctx));
  const src = new N('src', [L, R]);
  src.connect(node.input as any);
  const [oL, oR] = evalN(node.output as any);
  return { oL, oR, node };
}
function noise(n: number, seed: number) { let s = seed; const x = new Float64Array(n); for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = Math.fround(0.4 * (s / 0x7fffffff * 2 - 1)); } return x; }
const sine = (f: number, n: number) => { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = Math.fround(0.3 * Math.sin(2 * Math.PI * f * i / SR)); return x; };
const rms = (x: Float64Array, a = 0) => { let s = 0; for (let i = a; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length - a)); };
const maxDiff = (a: Float64Array, b: Float64Array, shift = 0) => { let m = 0; for (let i = shift; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i - shift])); return m; };

describe('rack parallèle : son', () => {
  const L = noise(4000, 3), R = noise(4000, 9);

  it('réglages par défaut (2 branches vides à −6,02 dB) : sortie = entrée au bit près, latence nulle', () => {
    const { oL, oR, node } = render(rackDefaults(), L, R);
    expect(Array.from(oL)).toEqual(Array.from(L));
    expect(Array.from(oR)).toEqual(Array.from(R));
    expect(node.latency).toBe(0);
  });

  it('2 branches vides à 0 dB : +6,02 dB exact (×2)', () => {
    const p = rackDefaults(); p.branches.forEach(b => { b.level = 0; });
    const { oL } = render(p, L, R);
    for (let i = 0; i < L.length; i++) expect(oL[i]).toBe(2 * L[i]);
  });

  it('mélange 0 % : le son d’origine au bit près, quelles que soient les branches', () => {
    const p = rackDefaults(); p.mix = 0; p.branches[1].plugins = [{ id: 'g', name: 'g', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { gain: 3 } }];
    const { oL } = render(p, L, R);
    expect(Array.from(oL)).toEqual(Array.from(L));
  });

  it('coupure et solo : seule la branche entendue sonne', () => {
    const p = rackDefaults();
    p.branches[0].level = 0; p.branches[1].level = 0;
    p.branches[1].plugins = [{ id: 'g', name: 'g', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { gain: 0.25 } }];
    p.branches[1].solo = true;
    const solo = render(p, L, R).oL;
    for (let i = 0; i < L.length; i++) expect(solo[i]).toBe(Math.fround(L[i] * 0.25));
    p.branches[1].solo = false; p.branches[1].mute = true;
    expect(Array.from(render(p, L, R).oL)).toEqual(Array.from(L));
  });

  it('branche avec un effet à latence (100 éch.) : branches et son sec réalignés, latence annoncée', () => {
    const p = rackDefaults();
    p.branches[1].plugins = [{ id: 'lat', name: 'lat', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { lat: 100 } }];
    p.mix = 60;
    const { oL, node } = render(p, L, R);
    expect(Math.round(node.latency * SR)).toBe(100);
    // Branches vides = le son retardé de 100 ; sec retardé de 100 aussi : la sortie est l'entrée retardée.
    expect(maxDiff(oL, L, 100)).toBeLessThan(1e-7);
    for (let i = 0; i < 100; i++) expect(oL[i]).toBe(0);
  });

  it('bandes (2 et 3) : la somme se reconstruit à ±0,1 dB de 50 Hz à 16 kHz', () => {
    for (const bandCount of [2, 3]) {
      const p = withMode(rackDefaults(), 'bandes', bandCount);
      expect(p.branches.length).toBe(bandCount);
      for (const f of [50, 150, 200, 500, 1000, 3000, 6000, 16000]) {
        const x = sine(f, 24000);
        const { oL } = render(p, x, x);
        const gdb = 20 * Math.log10(rms(oL, 12000) / rms(x, 12000));
        expect(Math.abs(gdb)).toBeLessThan(0.1);
      }
    }
  });

  it('centre / côtés, branches vides : gauche et droite rendus (écart < 1e-7)', () => {
    const p = withMode(rackDefaults(), 'ms');
    expect(p.branches.length).toBe(2);
    const { oL, oR } = render(p, L, R);
    expect(maxDiff(oL, L)).toBeLessThan(1e-7);
    expect(maxDiff(oR, R)).toBeLessThan(1e-7);
  });

  it('centre / côtés : couper les côtés rend un son mono (G = D = (G + D) / 2)', () => {
    const p = withMode(rackDefaults(), 'ms'); p.branches[1].mute = true;
    const { oL, oR } = render(p, L, R);
    for (let i = 0; i < 50; i++) { expect(Math.abs(oL[i] - oR[i])).toBeLessThan(1e-7); expect(Math.abs(oL[i] - (L[i] + R[i]) / 2)).toBeLessThan(1e-7); }
  });
});

describe('rack parallèle : structure et réglages', () => {
  it('effets créés à l’ajout, gardés quand seul un réglage change, libérés au retrait', () => {
    LEN = 256;
    const { ctx } = makeCtx();
    const made: string[] = [], freed: string[] = [];
    const p = rackDefaults();
    p.branches[0].plugins = [{ id: 'a', name: 'a', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: {} }];
    const node = new FxRackNode(ctx, { id: 'r', name: 'r', type: 'FXRACK', isEnabled: true, latency: 0, params: p } as any, fakeHost(ctx, made, freed));
    expect(made).toEqual(['a']);
    node.updateParams(withChildParams(sanitizeRack(p), 'rb-1', 'a', { gain: 0.5 }));
    expect(made).toEqual(['a']);
    const p2 = sanitizeRack(p); p2.branches[1].plugins = [{ id: 'b', name: 'b', type: 'REVERB', isEnabled: true, latency: 0, params: {} }]; p2.branches[0].plugins = [];
    node.updateParams(p2);
    expect(made).toEqual(['a', 'b']);
    expect(freed).toEqual(['a']);
    node.dispose();
    expect(freed.sort()).toEqual(['a', 'b']);
  });

  it('règles : −6,02 dB = ×0,5 exact, alignement, niveaux, solo, noms, division', () => {
    expect(levelToGain(HALF_DB)).toBe(0.5);
    expect(levelToGain(-80)).toBe(0);
    expect(rackAlignment([0, 100, 37])).toEqual({ latency: 100, delays: [100, 0, 63] });
    const p = rackDefaults(); p.branches[0].solo = true;
    expect(branchGain(p, 1)).toBe(0); expect(branchGain(p, 0)).toBe(0.5);
    expect(branchLabel(withMode(p, 'bandes', 3), 1)).toBe('Médium');
    expect(branchLabel(withMode(p, 'ms'), 1)).toBe('Côtés');
    const four = sanitizeRack({ ...p, branches: [...p.branches, ...p.branches, ...p.branches] });
    expect(four.branches.length).toBe(4);
    expect(sanitizeRack({ mode: 'ms', branches: four.branches }).branches.length).toBe(2);
    // Un VST, l'Auto-Tune ou un rack ne vont pas dans une branche.
    const bad = sanitizeRack({ branches: [{ id: 'x', level: 0, plugins: [{ id: 'v', type: 'VST3', params: {} }, { id: 'r', type: 'FXRACK', params: {} }, { id: 'e', type: 'PROEQ12', params: {} }] }, { id: 'y', level: 0, plugins: [] }] });
    expect(bad.branches[0].plugins.map(x => x.type)).toEqual(['PROEQ12']);
    expect(RACK_EXCLUDED.has('AUTOTUNE')).toBe(true);
    // Structure : un réglage d'effet ne recâble pas ; un contournement si.
    const s0 = rackStructureKey(sanitizeRack({ ...rackDefaults(), branches: [{ id: 'a', level: 0, plugins: [{ id: 'e', type: 'PROEQ12', params: { g: 1 } }] }, { id: 'b', level: 0, plugins: [] }] }));
    const s1 = rackStructureKey(sanitizeRack({ ...rackDefaults(), branches: [{ id: 'a', level: 0, plugins: [{ id: 'e', type: 'PROEQ12', params: { g: 2 } }] }, { id: 'b', level: 0, plugins: [] }] }));
    const s2 = rackStructureKey(sanitizeRack({ ...rackDefaults(), branches: [{ id: 'a', level: 0, plugins: [{ id: 'e', type: 'PROEQ12', isEnabled: false, params: {} }] }, { id: 'b', level: 0, plugins: [] }] }));
    expect(s0).toBe(s1); expect(s0).not.toBe(s2);
  });

  it('déclaré comme un effet : registre, menu « + », automation, réglages par défaut neutres', () => {
    const reg = getRegisteredPlugin('FXRACK')!;
    expect(reg).toBeTruthy();
    expect(reg.name).toBe('Rack parallèle');
    expect(registryMenuItems().some(m => m.id === 'FXRACK')).toBe(true);
    expect(reg.automatable!.map(a => a.id)).toEqual(RACK_AUTOMATABLE.map(a => a.id));
    const d = reg.defaultParams();
    expect(d.branches.length).toBe(2);
    expect(d.branches.every((b: any) => b.level === HALF_DB && b.plugins.length === 0)).toBe(true);
    expect(d.mix).toBe(100);
    // Aucun nom de concurrent dans ce qui s'affiche.
    expect(`${reg.name} ${reg.description}`).not.toMatch(/Ableton|Live|Reaper|Bitwig|Studio One|Cubase|Logic|Pro Tools|Avid|FL Studio/i);
  });
});
