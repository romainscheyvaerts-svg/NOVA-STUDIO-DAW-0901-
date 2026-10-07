import { describe, it, expect } from 'vitest';
import { createLimiterCore, limiterLatencySamples } from '../engine/limiterCore';
import { truePeakOf, lufsOf } from '../utils/audioMeasure';

const SR = 48000;

/** Passe un signal stéréo dans le noyau, par blocs de 128 comme l'AudioWorklet. */
function run(L: Float32Array, R: Float32Array, params: Parameters<ReturnType<typeof createLimiterCore>['setParams']>[0], sr = SR) {
  const core = createLimiterCore(sr);
  core.setParams(params);
  const lat = core.latencySamples();
  const n = L.length + lat;
  const inL = new Float32Array(n), inR = new Float32Array(n);
  inL.set(L); inR.set(R);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  for (let s = 0; s < n; s += 128) {
    const k = Math.min(128, n - s);
    core.process(inL.subarray(s, s + k), inR.subarray(s, s + k), outL.subarray(s, s + k), outR.subarray(s, s + k), k);
  }
  return { L: outL.subarray(lat), R: outR.subarray(lat), lat, core };
}

/** Signal « fort » : kick + 808 + charleys + bruit, crêtes inter-échantillons fréquentes. */
function loudBeat(seconds: number, sr = SR, level = 0.9) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 12345;
  const rnd0 = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  // Bruit filtré (binomial) : comme un vrai fichier, rien à pleine puissance au ras de Nyquist.
  let z1 = 0, z2 = 0, z3 = 0;
  const rnd = () => { const v = rnd0(); const r = (v + 3 * z1 + 3 * z2 + z3) / 4; z3 = z2; z2 = z1; z1 = v; return r; };
  for (let i = 0; i < n; i++) {
    const t = i / sr, beat = t % 0.5, sixteenth = t % 0.125;
    const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 8);
    const bass = 0.6 * Math.sin(2 * Math.PI * 49 * t);
    const hat = 0.5 * rnd() * Math.exp(-sixteenth * 80);
    const lead = 0.3 * Math.sin(2 * Math.PI * 7350 * t) + 0.25 * Math.sin(2 * Math.PI * 11025.5 * t + 0.3);
    L[i] = level * (kick + bass + hat + lead);
    R[i] = level * (kick + bass - hat + lead * 0.8);
  }
  return { L, R };
}

const sine = (f: number, seconds: number, amp: number, sr = SR, phase = 0) => {
  const n = Math.round(seconds * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + phase);
  return x;
};

describe('limiteur NOVA : la crête vraie ne dépasse jamais le plafond', () => {
  it('signal fort poussé de +12 dB, plafond -1 dBTP', () => {
    const { L, R } = loudBeat(4);
    expect(truePeakOf([L, R])).toBeGreaterThan(3); // l'entrée dépasse largement 0 dBFS
    const out = run(L, R, { ceilingDb: -1, inputGainDb: 12, releaseMs: 80, lookaheadMs: 3, oversample: 4 });
    // Arbitre ×8 (64 coefficients) et mesure façon BS.1770 (×4).
    const tp = truePeakOf([out.L, out.R]);
    expect(tp).toBeLessThanOrEqual(-1);
    expect(truePeakOf([out.L, out.R], 4, 48)).toBeLessThanOrEqual(-1);
    expect(tp).toBeGreaterThan(-1.6); // il limite, il n'écrase pas tout
  });

  it('sinus 997 Hz à +6 dBFS, plafond -1 dBTP puis -0,3 dBTP', () => {
    for (const ceil of [-1, -0.3]) {
      const x = sine(997, 2, 2, SR, 0.7);
      const out = run(x, x, { ceilingDb: ceil, inputGainDb: 0, releaseMs: 200, lookaheadMs: 5, oversample: 4 });
      const tp = truePeakOf([out.L.subarray(4800), out.R.subarray(4800)]);
      expect(tp).toBeLessThanOrEqual(ceil);
      expect(tp).toBeGreaterThan(ceil - 0.3);
      expect(truePeakOf([out.L.subarray(4800)], 4, 48)).toBeLessThanOrEqual(ceil);
    }
  });

  it('sinus aigu (crêtes entre les échantillons) à 44,1 kHz', () => {
    const sr = 44100;
    // 11025 Hz déphasé de 45° : échantillons à 0,707 de la crête réelle.
    const x = sine(11025, 1, 1.2, sr, Math.PI / 4);
    const out = run(x, x, { ceilingDb: -1, inputGainDb: 0, releaseMs: 100, lookaheadMs: 2, oversample: 4 }, sr);
    expect(truePeakOf([out.L.subarray(4410)])).toBeLessThanOrEqual(-1);
  });

  it('suréchantillonnage 1 = plafond en crête échantillon seulement', () => {
    const { L, R } = loudBeat(2);
    const out = run(L, R, { ceilingDb: -1, inputGainDb: 6, oversample: 1 });
    let pk = 0; for (const v of out.L) pk = Math.max(pk, Math.abs(v));
    expect(20 * Math.log10(pk)).toBeLessThanOrEqual(-1 + 1e-6);
  });

  it('transparent sous le plafond (gain 1, simple retard)', () => {
    const x = sine(440, 0.5, 0.25);
    const out = run(x, x, { ceilingDb: -1, inputGainDb: 0, oversample: 4, lookaheadMs: 3 });
    let err = 0; for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(out.L[i] - x[i]));
    expect(err).toBeLessThan(1e-6);
  });

  it('latence exacte et déclarée (PDC)', () => {
    const imp = new Float32Array(2000); imp[100] = 0.5;
    const core = createLimiterCore(SR);
    core.setParams({ lookaheadMs: 3 });
    const lat = core.latencySamples();
    expect(lat).toBe(limiterLatencySamples(SR, 3));
    const out = new Float32Array(2000);
    core.process(imp, imp, out, null, 2000);
    expect(out.findIndex(v => Math.abs(v) > 0.25)).toBe(100 + lat);
  });

  it('le gain d’entrée monte la loudness', () => {
    const { L, R } = loudBeat(3, SR, 0.2);
    const a = run(L, R, { ceilingDb: -1, inputGainDb: 0 });
    const b = run(L, R, { ceilingDb: -1, inputGainDb: 6 });
    const c = run(L, R, { ceilingDb: -1, inputGainDb: 12 });
    const la = lufsOf([a.L, a.R], SR), lb = lufsOf([b.L, b.R], SR), lc = lufsOf([c.L, c.R], SR);
    expect(lb).toBeGreaterThan(la + 3);
    expect(lc).toBeGreaterThan(lb + 1);
    expect(truePeakOf([c.L, c.R])).toBeLessThanOrEqual(-1);
  });
});
