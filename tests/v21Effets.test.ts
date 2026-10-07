import { describe, it, expect } from 'vitest';
import { createTimeFxCore } from '../engine/timeFxCore';
import { createDjFilterCore, createLofiCore } from '../engine/colorFxCore';
import { psolaLatencySamples } from '../engine/psolaCore';
import { V21_SPECS, V21_PRESETS, V21_DEFAULTS, sanitizeV21, V21Type } from '../engine/v21Params';
import { harmonizerToCore, voiceShiftToCore } from '../engine/v21Nodes';
import { getRegisteredPlugin, registryBrowserItems, registryMenuItems, usesProjectKey } from '../engine/pluginRegistry';
import { NOVA_FX_NAMES, pluginIcon } from '../utils/pluginLabel';
import { automationParamLabel } from '../utils/automationLabels';

const SR = 48000;

/** Passe un signal dans un cœur (blocs de 128), avec des réglages appliqués à des instants donnés (s). */
function run(core: any, x: Float32Array, events: [number, Record<string, any>][] = []) {
  const out = new Float32Array(x.length);
  const ev = [...events].sort((a, b) => a[0] - b[0]);
  for (let s = 0; s < x.length; s += 128) {
    while (ev.length && ev[0][0] * SR <= s) core.setParams(ev.shift()![1]);
    const k = Math.min(128, x.length - s);
    core.process(x.subarray(s, s + k), null, out.subarray(s, s + k), null, k);
  }
  return out;
}

const sine = (f: number, sec: number, a = 0.5) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => a * Math.sin(2 * Math.PI * f * i / SR));

/** Fréquence instantanée moyenne d'une fenêtre (passages par zéro montants, interpolés). */
function zcFreq(x: Float32Array, from: number, to: number): number {
  const a = Math.round(from * SR), b = Math.round(to * SR);
  const cross: number[] = [];
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) cross.push(i - 1 + (-x[i - 1]) / (x[i] - x[i - 1]));
  if (cross.length < 2) return 0;
  return (cross.length - 1) / ((cross[cross.length - 1] - cross[0]) / SR);
}
const rmsOf = (x: Float32Array, from: number, to: number) => { let s = 0; const a = Math.round(from * SR), b = Math.round(to * SR); for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

describe('Tape stop : courbes', () => {
  const core = createTimeFxCore(SR);
  it('la vitesse part de 1 et arrive à 0, sans jamais remonter, pour toutes les courbes', () => {
    for (const c of [-1, -0.5, 0, 0.4, 1]) {
      expect(core.curve(0, c)).toBeCloseTo(1, 9);
      expect(core.curve(1, c)).toBeCloseTo(0, 9);
      let prev = 1;
      for (let i = 1; i <= 100; i++) { const v = core.curve(i / 100, c); expect(v).toBeLessThanOrEqual(prev + 1e-12); prev = v; }
    }
  });
  it('courbe 0 = linéaire (vinyle freiné) ; courbe + tient plus longtemps ; courbe − chute plus vite', () => {
    expect(core.curve(0.5, 0)).toBeCloseTo(0.5, 9);
    expect(core.curve(0.5, 1)).toBeGreaterThan(0.9);
    expect(core.curve(0.5, -1)).toBeLessThan(0.1);
    // Distance parcourue (∫ vitesse) : linéaire = ½ de la durée.
    let d = 0; for (let i = 0; i < 1000; i++) d += core.curve((i + 0.5) / 1000, 0) / 1000;
    expect(d).toBeCloseTo(0.5, 4);
  });
});

describe('Tape stop / half-time / stutter : rendu', () => {
  it('au repos, la sortie est exactement l\'entrée (aucune latence)', () => {
    const x = sine(220, 0.5);
    const y = run(createTimeFxCore(SR), x, [[0, { bpm: 120 }]]);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBe(x[i]);
  });
  it('tape stop 1 temps à 120 BPM : la hauteur descend jusqu\'à l\'arrêt en 0,5 s, puis silence', () => {
    const x = sine(440, 2);
    const y = run(createTimeFxCore(SR), x, [[0, { bpm: 120, stopBeats: 1, stopCurve: 0 }], [0.5, { stop: 1 }]]);
    // Avant : 440 Hz. Pendant : vitesse linéaire 1 → 0 sur 0,5 s ⇒ f ≈ 440 × (1 − u).
    expect(zcFreq(y, 0.3, 0.49)).toBeCloseTo(440, 0);
    const f = [0.1, 0.2, 0.3].map(u => zcFreq(y, 0.5 + 0.5 * u - 0.02, 0.5 + 0.5 * u + 0.02));
    expect(f[0]).toBeGreaterThan(f[1]); expect(f[1]).toBeGreaterThan(f[2]);
    f.forEach((v, k) => expect(Math.abs(v - 440 * (1 - [0.1, 0.2, 0.3][k])) / 440).toBeLessThan(0.04));
    // Au-delà de la durée de l'arrêt : silence.
    expect(rmsOf(y, 1.02, 2)).toBe(0);
  });
  it('tape stop relâché avec redémarrage : retombe pile sur le temps réel (sortie = entrée)', () => {
    const x = sine(330, 3);
    const y = run(createTimeFxCore(SR), x, [[0, { bpm: 120, stopBeats: 1, startBeats: 1 }], [0.5, { stop: 1 }], [1.5, { stop: 0 }]]);
    // Redémarrage 1 temps = 0,5 s, puis retour exact (après le fondu de 8 ms).
    const from = Math.round(2.05 * SR);
    let maxErr = 0; for (let i = from; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    expect(maxErr).toBeLessThan(1e-6);
    // Pendant le redémarrage, la hauteur remonte.
    expect(zcFreq(y, 1.62, 1.7)).toBeLessThan(zcFreq(y, 1.85, 1.95));
  });
  it('half-time : une octave plus bas pendant la zone, puis retour exact', () => {
    const x = sine(440, 3);
    const y = run(createTimeFxCore(SR), x, [[0, { bpm: 120, halfBeats: 4 }], [0.5, { half: 1 }], [2.5, { half: 0 }]]);
    expect(zcFreq(y, 0.6, 1.4)).toBeCloseTo(220, 0);
    const from = Math.round(2.53 * SR);
    let maxErr = 0; for (let i = from; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    expect(maxErr).toBeLessThan(1e-6);
  });
  it('stutter 1/16 à 120 BPM : la tranche de 125 ms se répète', () => {
    const x = Float32Array.from({ length: SR * 2 }, (_, i) => Math.sin(2 * Math.PI * 3 * i / SR)); // signal lent, jamais périodique sur 125 ms
    const y = run(createTimeFxCore(SR), x, [[0, { bpm: 120, stutterDiv: 0.25 }], [0.5, { stutter: 1 }]]);
    const L = Math.round(0.125 * SR), s0 = Math.round(0.5 * SR);
    for (const k of [1, 2, 4]) {
      const i = s0 + k * L + Math.round(0.05 * SR);
      expect(Math.abs(y[i] - x[s0 + Math.round(0.05 * SR)])).toBeLessThan(1e-3);
    }
  });
});

describe('Filtre DJ et lo-fi', () => {
  it('filtre au centre : transparent (gain 0 dB)', () => {
    const x = sine(1000, 0.3);
    const y = run(createDjFilterCore(SR), x, [[0, { filter: 0, output: 0 }]]);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i], 9);
  });
  it('à gauche coupe les aigus, à droite coupe les graves', () => {
    const hi = sine(6000, 0.6), lo = sine(80, 0.6);
    const lp = (x: Float32Array) => run(createDjFilterCore(SR), x, [[0, { filter: -0.7, resonance: 0 }]]);
    const hp = (x: Float32Array) => run(createDjFilterCore(SR), x, [[0, { filter: 0.7, resonance: 0 }]]);
    const att = (y: Float32Array, x: Float32Array) => 20 * Math.log10(rmsOf(y, 0.3, 0.6) / rmsOf(x, 0.3, 0.6));
    expect(att(lp(hi), hi)).toBeLessThan(-30);
    expect(att(lp(lo), lo)).toBeGreaterThan(-3);
    expect(att(hp(lo), lo)).toBeLessThan(-30);
    expect(att(hp(hi), hi)).toBeGreaterThan(-3);
  });
  it('lo-fi « téléphone » : bande 400–3 400 Hz, et réglages neutres = transparent', () => {
    const neutral = { bits: 16, rate: 48000, lowCut: 20, highCut: 20000, drive: 0, noise: 0, mix: 1, output: 0 };
    const x = sine(1000, 0.3);
    const y = run(createLofiCore(SR), x, [[0, neutral]]);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i], 9);
    const tel = V21_PRESETS.LOFI.find(p => p.id === 'telephone')!.params as any;
    const att = (f: number) => { const s = sine(f, 0.6, 0.1); const o = run(createLofiCore(SR), s, [[0, { ...tel, noise: 0, drive: 0, bits: 16, output: 0 }]]); return 20 * Math.log10(rmsOf(o, 0.3, 0.6) / rmsOf(s, 0.3, 0.6)); };
    expect(att(100)).toBeLessThan(-20);
    expect(att(1000)).toBeGreaterThan(-3);
    expect(att(7000)).toBeLessThan(-20);
  });
});

describe('Latences déclarées (PDC) et registre', () => {
  it('harmoniseur et voix grave / aiguë : latence PSOLA fixe ; tape stop, filtre DJ, lo-fi : aucune', async () => {
    const { V21EffectNode } = await import('../engine/v21Nodes');
    // Contexte factice : seule la fréquence compte pour la latence (l'AudioWorklet échoue → passe-plat).
    const fakeCtx: any = { sampleRate: SR, createGain: () => ({ connect() {}, disconnect() {}, channelCount: 2, channelCountMode: 'explicit' }) };
    for (const t of ['HARMONIZER', 'VOICESHIFT'] as const) {
      const n = new V21EffectNode(fakeCtx, t, {});
      expect(n.latency).toBe(psolaLatencySamples(SR) / SR);
      await n.ready;
      expect(n.latency).toBe(0); // sans AudioWorklet : contourné, aucune latence annoncée
    }
    for (const t of ['TIMEFX', 'DJFILTER', 'LOFI'] as const) expect(new V21EffectNode(fakeCtx, t, {}).latency).toBe(0);
  });
  it('les 5 effets sont dans le registre (menu « + », navigateur PC et téléphone), avec nom et icône', () => {
    const types = ['HARMONIZER', 'VOICESHIFT', 'TIMEFX', 'DJFILTER', 'LOFI'];
    for (const t of types) {
      const reg = getRegisteredPlugin(t)!;
      expect(reg).toBeTruthy();
      expect(reg.description).toMatch(/comme/);
      expect(registryMenuItems().some(i => i.id === t)).toBe(true);
      expect(registryBrowserItems().some(i => i.id === t)).toBe(true);
      expect(NOVA_FX_NAMES[t]).toBeTruthy();
      expect(pluginIcon({ type: t as any })).not.toBe('fa-magic');
      expect(reg.automatable!.length).toBeGreaterThan(2);
    }
    expect(usesProjectKey('HARMONIZER')).toBe(true);
    expect(usesProjectKey('AUTOTUNE')).toBe(true);
    expect(usesProjectKey('LOFI')).toBe(false);
  });
  it('réglages : défauts et préréglages dans les bornes, tous automatisables en nombres', () => {
    for (const t of Object.keys(V21_SPECS) as V21Type[]) {
      const d = V21_DEFAULTS[t]();
      for (const s of V21_SPECS[t]) {
        expect(typeof d[s.id], `${t}.${s.id}`).toBe('number');
        expect(d[s.id]).toBeGreaterThanOrEqual(s.min); expect(d[s.id]).toBeLessThanOrEqual(s.max);
        expect(s.hint.length).toBeGreaterThan(20);
      }
      for (const pr of V21_PRESETS[t]) for (const [k, v] of Object.entries(pr.params)) {
        const s = V21_SPECS[t].find(x => x.id === k);
        expect(s, `${t}/${pr.id}/${k}`).toBeTruthy();
        expect(sanitizeV21(t, { [k]: v })[k]).toBe(v);
      }
    }
    expect(sanitizeV21('VOICESHIFT', { pitch: 99, formant: -40 })).toEqual({ pitch: 24, formant: -12 });
  });
  it('préréglages demandés présents', () => {
    expect(V21_PRESETS.HARMONIZER.some(p => p.name === 'Harmonie tierce + quinte')).toBe(true);
    expect(V21_PRESETS.VOICESHIFT.some(p => p.name === 'Voix démon')).toBe(true);
    expect(V21_PRESETS.TIMEFX.some(p => p.name === 'Tape stop 1 temps')).toBe(true);
  });
  it('harmoniseur : voix panoramiquées à puissance constante, humanisation = retard + désaccord', () => {
    const c = harmonizerToCore({ ...V21_DEFAULTS.HARMONIZER(), voices: 2, v1Pan: -1, v2Pan: 0, v1Level: 0, v2Level: 0, humanize: 0 });
    expect(c.voices.filter(v => v.on).length).toBe(2);
    expect(c.voices[0].gainL).toBeCloseTo(Math.SQRT2, 6); expect(c.voices[0].gainR).toBeCloseTo(0, 6);
    expect(c.voices[1].gainL).toBeCloseTo(1, 6); expect(c.voices[1].gainR).toBeCloseTo(1, 6);
    expect(c.voices[0].delayMs).toBe(0);
    const h = harmonizerToCore({ ...V21_DEFAULTS.HARMONIZER(), humanize: 1 });
    expect(h.voices[0].delayMs).toBeGreaterThan(5); expect(Math.abs(h.voices[0].detune)).toBeGreaterThan(3);
    expect(harmonizerToCore({ ...V21_DEFAULTS.HARMONIZER(), dry: -60 }).dry).toBe(0);
    const v = voiceShiftToCore({ pitch: -12, formant: -4, link: 0, mix: 0.5, output: 0 });
    expect(v.voices[0].semis).toBe(-12); expect(v.dry).toBeCloseTo(0.5, 9); expect(v.voices[0].follow).toBe(false);
  });
  it('automation : les réglages V21 ont un nom lisible', () => {
    expect(automationParamLabel('plugin::pl-1::stop')).toBe('Tape stop');
    const tracks: any = [{ id: 't', plugins: [{ id: 'pl-1', type: 'TIMEFX', name: 'TIMEFX', isEnabled: true, params: {} }] }];
    expect(automationParamLabel('plugin::pl-1::stopBeats', tracks)).toBe("Tape stop · Durée de l'arrêt");
    expect(automationParamLabel('plugin::pl-9::threshold')).toBe('pl-9::threshold');
  });
});
