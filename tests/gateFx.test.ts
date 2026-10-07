import { describe, expect, it } from 'vitest';
import { createGateCore } from '../engine/gateCore';
import { DEFAULT_GATEFX, GATEFX_PRESETS, gatePattern, gateSteps, sanitizeV21, V21_DEFAULTS } from '../engine/v21Params';
import { gateToCore, V21EffectNode } from '../engine/v21Nodes';
import { getRegisteredPlugin, registryBrowserItems, registryMenuItems } from '../engine/pluginRegistry';
import { NOVA_FX_NAMES, pluginIcon } from '../utils/pluginLabel';
import { automationParamLabel } from '../utils/automationLabels';

const SR = 48000;
const ones = (sec: number) => new Float32Array(Math.round(sec * SR)).fill(1);

/** Passe un signal dans le cœur par blocs de 128, l'horloge partant de `t0` (s du morceau). */
function run(core: any, x: Float32Array, t0 = 0) {
  const out = new Float32Array(x.length);
  core.setClock(t0);
  for (let s = 0; s < x.length; s += 128) {
    const k = Math.min(128, x.length - s);
    core.process(x.subarray(s, s + k), x.subarray(s, s + k), out.subarray(s, s + k), null, k);
  }
  return out;
}
const at = (y: Float32Array, t: number) => y[Math.round(t * SR)];

describe('Gate rythmique : cœur', () => {
  it('motif 1/16 à 120 BPM : ouvert puis fermé, une double croche (125 ms) chacun', () => {
    const c = createGateCore(SR);
    c.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([1, 0]), rate: 4, attack: 1, release: 2, bpm: 120 }));
    const y = run(c, ones(1));
    for (let k = 0; k < 8; k++) {
      const mid = k * 0.125 + 0.0625;
      expect(at(y, mid), `pas ${k}`).toBeCloseTo(k % 2 === 0 ? 1 : 0, 3);
    }
  });

  it('calé sur la grille du morceau : une lecture qui démarre au milieu d’un pas tombe sur le bon pas', () => {
    const c = createGateCore(SR);
    c.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([1, 0, 0, 0]), rate: 4, attack: 0.5, release: 1, bpm: 120 }));
    // Départ à 1,03 s : pas 8 (1,000–1,125 s) = 1er pas du motif → ouvert ; 1,15 s = pas 9 → fermé.
    const y = run(c, ones(0.3), 1.03);
    expect(at(y, 0.05)).toBeCloseTo(1, 2);
    expect(at(y, 0.15)).toBeCloseTo(0, 3);
    expect(c.stepAt(1.03)).toBe(8); // 9e pas du motif de 16 (même niveau que le 1er)
    expect(c.stepAt(-0.01)).toBe(15); // avant le début du morceau (pré-roll) : jamais d'indice négatif
  });

  it('profondeur 50 % : un pas fermé est baissé de moitié ; triolets : 3 pas par temps', () => {
    const c = createGateCore(SR);
    c.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([1, 0]), rate: 4, depth: 0.5, attack: 1, release: 1, bpm: 120 }));
    expect(at(run(c, ones(0.3)), 0.19)).toBeCloseTo(0.5, 3);
    const t = createGateCore(SR);
    t.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([1, 1, 0]), rate: 3, length: 12, bpm: 120 }));
    // Un temps = 0,5 s → 3 pas de 166,7 ms : le 3e (0,333–0,5 s) est fermé.
    expect(t.stepAt(0.42)).toBe(2);
    expect(t.targetAt(0.42)).toBe(0);
    expect(t.targetAt(0.1)).toBe(1);
  });

  it('jamais de clic : le gain change progressivement (attaque / relâchement)', () => {
    const c = createGateCore(SR);
    c.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([1, 0]), rate: 8, attack: 2, release: 4, bpm: 140 }));
    const y = run(c, ones(1));
    let maxStep = 0;
    for (let i = 1; i < y.length; i++) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
    expect(maxStep).toBeLessThan(0.02);
    // Relâchement long = pompe : à mi-pas fermé, le son n'est pas encore éteint.
    const p = createGateCore(SR);
    p.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([1, 0]), rate: 4, attack: 1, release: 120, bpm: 120 }));
    expect(at(run(p, ones(0.3)), 0.19)).toBeGreaterThan(0.4);
  });
});

describe('Gate rythmique : effet NOVA', () => {
  it('dans le registre, nom et icône, aucune latence, réglages automatisables (profondeur, attaque, relâchement, pas)', () => {
    const reg = getRegisteredPlugin('GATEFX')!;
    expect(reg.name).toBe('Gate rythmique');
    expect(registryMenuItems().some(i => i.id === 'GATEFX')).toBe(true);
    expect(registryBrowserItems().some(i => i.id === 'GATEFX')).toBe(true);
    expect(NOVA_FX_NAMES.GATEFX).toBe('Gate rythmique');
    expect(pluginIcon({ type: 'GATEFX' })).not.toBe('fa-magic');
    const keys = reg.automatable!.map((s: any) => s.id ?? s.key ?? s);
    for (const k of ['depth', 'attack', 'release', 'rate', 's1', 's16']) expect(JSON.stringify(keys)).toContain(k);
    const fakeCtx: any = { sampleRate: SR, currentTime: 0, createGain: () => ({ connect() {}, disconnect() {}, channelCount: 2, channelCountMode: 'explicit' }) };
    const n = new V21EffectNode(fakeCtx, 'GATEFX', {});
    expect(n.latency).toBe(0);
    expect(n.followsTimeline).toBe(true);
    expect(new V21EffectNode(fakeCtx, 'LOFI', {}).followsTimeline).toBe(false);
    expect(automationParamLabel('plugin::g::depth', [{ id: 't', plugins: [{ id: 'g', type: 'GATEFX', name: 'GATEFX', isEnabled: true, params: {} }] }] as any)).toBe('Gate rythmique · Profondeur');
  });

  it('préréglages trap demandés : stutter, half, triolets ; motifs et bornes', () => {
    const ids = GATEFX_PRESETS.map(p => p.id);
    for (const id of ['stutter-32', 'stutter-16', 'half', 'triolets', 'pompe']) expect(ids).toContain(id);
    const tri = GATEFX_PRESETS.find(p => p.id === 'triolets')!.params as any;
    expect(tri.rate).toBe(3); expect(tri.length).toBe(12);
    expect(gateSteps(tri).slice(0, 6)).toEqual([1, 1, 0, 1, 1, 0]);
    expect(sanitizeV21('GATEFX', { s3: 4, rate: 9.6, attack: -2 })).toEqual({ s3: 1, rate: 8, attack: 0 });
    expect(Object.keys(V21_DEFAULTS.GATEFX()).filter(k => /^s\d+$/.test(k))).toHaveLength(16);
  });

  it('processeur AudioWorklet : l’horloge vient de l’origine du morceau (originHi + originLo), au bloc près', () => {
    const fakeCtx: any = { sampleRate: SR, currentTime: 0, createGain: () => ({ connect() {}, disconnect() {}, channelCount: 2, channelCountMode: 'explicit' }) };
    const code: string = (new V21EffectNode(fakeCtx, 'GATEFX', {}) as any).spec.code;
    const scope: any = { sampleRate: SR, currentTime: 0, registered: null as any };
    scope.AudioWorkletProcessor = class { port = { onmessage: null, postMessage() {} }; };
    scope.registerProcessor = (_n: string, cls: any) => { scope.registered = cls; };
    // eslint-disable-next-line no-new-func
    new Function('scope', `with (scope) { ${code} }`)(scope);
    const P = scope.registered;
    const desc = P.parameterDescriptors.map((d: any) => d.name);
    expect(desc).toEqual(expect.arrayContaining(['depth', 'attack', 'release', 's1', 's16', 'originHi', 'originLo']));
    const proc = new P({ processorOptions: { params: { ...DEFAULT_GATEFX, ...gatePattern([1, 0, 0, 0]), rate: 4, attack: 0.5, release: 1, bpm: 120 } } });
    const params = (oh: number, ol: number) => Object.fromEntries([...desc.map((n: string) => [n, new Float32Array([(DEFAULT_GATEFX as any)[n] ?? 0])]),
      ['originHi', new Float32Array([oh])], ['originLo', new Float32Array([ol])], ['s1', new Float32Array([1])], ['s2', new Float32Array([0])], ['s3', new Float32Array([0])], ['s4', new Float32Array([0])],
      ['s5', new Float32Array([1])], ['s6', new Float32Array([0])], ['s7', new Float32Array([0])], ['s8', new Float32Array([0])]]);
    // Contexte à 10,0 s, morceau commencé à 9,0 s (origine) → position 1,0 s = pas 8 (ouvert) ; 10,13 s → pas 9 (fermé).
    const block = (t: number) => {
      scope.currentTime = t;
      const inp = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
      const out = [new Float32Array(128), new Float32Array(128)];
      for (let k = 0; k < 40; k++) proc.process([inp], [out], params(9, 0)); // gain stabilisé
      return out[0][127];
    };
    expect(block(10.03)).toBeCloseTo(1, 2);
    expect(block(10.15)).toBeCloseTo(0, 2);
  });
});
