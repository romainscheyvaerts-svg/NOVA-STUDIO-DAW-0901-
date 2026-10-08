import { describe, it, expect } from 'vitest';
import { createMeterCore, MeterCoreOptions } from '../engine/meters/meterCore';
import { LoudnessMeter, correlationOf, gatedLoudness } from '../engine/meters/loudness';
import { truePeakOf } from '../utils/audioMeasure';
import { METER_SCALES, scaleFrac } from '../engine/meters/scales';
import { octaveSmooth } from '../engine/meters/spectrum';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);

/** Sinus stéréo identique G / D (amplitude crête en dBFS). */
function sine(seconds: number, freq: number, dbfs: number, phase = 0, sr = SR) {
  const n = Math.round(seconds * sr), a = Math.pow(10, dbfs / 20);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * freq * i / sr + phase);
  return x;
}
/**
 * Même sinus avec une attaque douce de 20 ms : un départ brutal (sin(φ) ≠ 0 au
 * premier échantillon) crée une VRAIE crête inter-échantillons (phénomène de
 * Gibbs) qui fausserait la comparaison avec l'amplitude.
 */
function softSine(seconds: number, freq: number, dbfs: number, phase = 0, sr = SR) {
  const x = sine(seconds, freq, dbfs, phase, sr), f = Math.round(0.02 * sr);
  for (let i = 0; i < f; i++) x[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / f);
  return x;
}
const concat = (...xs: Float32Array[]) => { const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

/** Fait passer G / D dans le noyau par blocs de 128 (comme l'AudioWorklet), relève tout. */
function measure(L: Float32Array, R: Float32Array | null, opt: MeterCoreOptions = { loudness: true, tpTaps: 16 }, sr = SR) {
  const core = createMeterCore(sr, opt);
  const lm = new LoudnessMeter();
  let peakL = 0, peakR = 0, tpL = 0, tpR = 0, sumL = 0, sumR = 0, lr = 0, n = 0;
  let mMax = -Infinity;
  for (let s = 0; s < L.length; s += 128) {
    const k = Math.min(128, L.length - s);
    core.process(L.subarray(s, s + k), R ? R.subarray(s, s + k) : null, k);
    if ((s / 128) % 12 === 11 || s + k >= L.length) {
      const t = core.take();
      peakL = Math.max(peakL, t.peakL); peakR = Math.max(peakR, t.peakR);
      tpL = Math.max(tpL, t.tpL); tpR = Math.max(tpR, t.tpR);
      sumL += t.sumL; sumR += t.sumR; lr += t.lr; n += t.n;
      for (const e of t.k) { lm.push(e); mMax = Math.max(mMax, lm.momentary()); }
    }
  }
  return { peakL, peakR, tpL, tpR, rmsL: Math.sqrt(sumL / n), rmsR: Math.sqrt(sumR / n), corr: correlationOf(lr, sumL, sumR), lm, n };
}

describe('Loudness EBU R128 : signaux de test Tech 3341 / 3342', () => {
  it('cas 1 : sinus 1 kHz stéréo à −23 dBFS = −23,0 LUFS (M, S, I)', () => {
    const x = sine(20, 1000, -23);
    const r = measure(x, x);
    expect(r.lm.momentary()).toBeCloseTo(-23, 1);
    expect(r.lm.shortTerm()).toBeCloseTo(-23, 1);
    expect(Math.abs(r.lm.integrated() + 23)).toBeLessThan(0.1);
  });

  it('cas 2 : sinus 1 kHz stéréo à −33 dBFS = −33,0 LUFS', () => {
    const x = sine(20, 1000, -33);
    const r = measure(x, x);
    expect(Math.abs(r.lm.integrated() + 33)).toBeLessThan(0.1);
    expect(Math.abs(r.lm.momentary() + 33)).toBeLessThan(0.1);
  });

  it('cas 3 : −36 / −23 / −36 dBFS (10 + 60 + 10 s) = −23 LUFS (portillon relatif)', () => {
    const x = concat(sine(10, 1000, -36), sine(60, 1000, -23), sine(10, 1000, -36));
    const r = measure(x, x);
    expect(Math.abs(r.lm.integrated() + 23)).toBeLessThan(0.1);
  });

  it('cas 4 : −72 / −36 / −23 / −36 / −72 dBFS (10 + 10 + 60 + 10 + 10 s) = −23 LUFS (portillon absolu)', () => {
    const x = concat(sine(10, 1000, -72), sine(10, 1000, -36), sine(60, 1000, -23), sine(10, 1000, -36), sine(10, 1000, -72));
    const r = measure(x, x);
    expect(Math.abs(r.lm.integrated() + 23)).toBeLessThan(0.1);
  });

  it('cas 5 : −26 / −20 / −26 dBFS (20 + 20,1 + 20 s) = −23 LUFS', () => {
    const x = concat(sine(20, 1000, -26), sine(20.1, 1000, -20), sine(20, 1000, -26));
    const r = measure(x, x);
    expect(Math.abs(r.lm.integrated() + 23)).toBeLessThan(0.1);
  });

  it('filtre K : 100 Hz et 10 kHz suivent la courbe BS.1770 (≈ −1,85 dB et +3,35 dB par rapport à 1 kHz)', () => {
    const ref = measure(sine(5, 1000, -23), sine(5, 1000, -23)).lm.integrated();
    const lo = measure(sine(5, 100, -23), sine(5, 100, -23)).lm.integrated();
    const hi = measure(sine(5, 10000, -23), sine(5, 10000, -23)).lm.integrated();
    // Passe-haut RLB (38 Hz, Q 0,5) : −1,17 dB à 100 Hz ; plateau +4 dB : +0,69 dB à 1 kHz, +4,0 dB à 10 kHz.
    expect(lo - ref).toBeGreaterThan(-2.1);
    expect(lo - ref).toBeLessThan(-1.6);
    expect(hi - ref).toBeGreaterThan(3.1);
    expect(hi - ref).toBeLessThan(3.6);
    // 20 Hz très atténué par le passe-haut RLB
    const sub = measure(sine(5, 20, -23), sine(5, 20, -23)).lm.integrated();
    expect(sub - ref).toBeLessThan(-8);
  });

  it('mono (une seule voie) compte une fois : sinus −23 dBFS sur une voie = −26 LUFS', () => {
    const x = sine(10, 1000, -23);
    const r = measure(x, null);
    expect(Math.abs(r.lm.integrated() + 26.0)).toBeLessThan(0.15);
  });

  it('Tech 3342 : LRA de −20 / −30 dBFS (20 + 20 s) = 10 LU ±1', () => {
    const x = concat(sine(20, 1000, -20), sine(20, 1000, -30));
    expect(Math.abs(measure(x, x).lm.lra() - 10)).toBeLessThan(1);
  });

  it('Tech 3342 : LRA de −20 / −15 = 5 LU, −40 / −20 = 20 LU, −50 / −35 / −20 / −35 / −50 = 15 LU', () => {
    const a = concat(sine(20, 1000, -20), sine(20, 1000, -15));
    expect(Math.abs(measure(a, a).lm.lra() - 5)).toBeLessThan(1);
    const b = concat(sine(20, 1000, -40), sine(20, 1000, -20));
    expect(Math.abs(measure(b, b).lm.lra() - 20)).toBeLessThan(1);
    const c = concat(sine(20, 1000, -50), sine(20, 1000, -35), sine(20, 1000, -20), sine(20, 1000, -35), sine(20, 1000, -50));
    expect(Math.abs(measure(c, c).lm.lra() - 15)).toBeLessThan(1);
  });

  it('remise à zéro : l’intégré repart de rien', () => {
    const x = sine(5, 1000, -23);
    const r = measure(x, x);
    r.lm.reset();
    expect(r.lm.integrated()).toBe(-Infinity);
    expect(gatedLoudness([], 0)).toBe(-Infinity);
  });
});

describe('Crête vraie (×4) sur des signaux inter-échantillons connus', () => {
  it('sinus à fs/4 déphasé de 45° : échantillons à −3,01 dB, crête vraie à 0,0 dBTP', () => {
    const x = sine(1, SR / 4, 0, Math.PI / 4);
    const r = measure(x, x, { tpTaps: 16 });
    expect(db(r.peakL)).toBeCloseTo(-3.01, 1);
    expect(Math.abs(db(r.tpL))).toBeLessThan(0.2);
  });

  it('sinus à fs/4 déphasé de 45° à −6 dBFS : 8 coefficients par phase, avec portillon (pistes) = −6,0 dBTP ±0,2', () => {
    const x = sine(1, SR / 4, -6, Math.PI / 4);
    const r = measure(x, x, { tpTaps: 8, tpGate: true });
    expect(Math.abs(db(r.tpL) + 6)).toBeLessThan(0.2);
  });

  it('sinus à fs/6, fs/8, 997 Hz, 15 et 18 kHz (master, 16 coefficients) : crête vraie à ±0,2 dB de l’amplitude, quelle que soit la phase', () => {
    for (const [f, ph] of [[SR / 6, 0.3], [SR / 6, 1.1], [997, 0.7], [SR / 8, Math.PI / 8], [15000, 0.4], [18000, 0.4]] as [number, number][]) {
      const x = softSine(0.5, f, -1, ph);
      const r = measure(x, x, { tpTaps: 16 });
      expect(Math.abs(db(r.tpL) + 1)).toBeLessThan(0.2);
      expect(r.tpL).toBeGreaterThanOrEqual(r.peakL);
    }
  });

  it('suit la mesure de référence de l’export (×8, 64 coefficients) sur du bruit filtré', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    const n = SR;
    const L = new Float32Array(n), R = new Float32Array(n);
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) { a = 0.7 * a + 0.3 * rnd(); b = 0.6 * b + 0.4 * rnd(); L[i] = a * 1.4; R[i] = b * 1.2; }
    const ref = truePeakOf([L, R]);
    const r = measure(L, R, { tpTaps: 16 });
    expect(Math.abs(db(Math.max(r.tpL, r.tpR)) - ref)).toBeLessThan(0.25);
    const g = measure(L, R, { tpTaps: 8, tpGate: true });
    expect(Math.abs(db(Math.max(g.tpL, g.tpR)) - ref)).toBeLessThan(0.3);
  });
});

describe('Gauche / droite séparés, RMS et corrélation', () => {
  it('gauche et droite indépendants : sinus à −6 dBFS à gauche, silence à droite', () => {
    const L = sine(1, 1000, -6), R = new Float32Array(L.length);
    const r = measure(L, R, { tpTaps: 8, tpGate: true });
    expect(db(r.peakL)).toBeCloseTo(-6, 1);
    expect(r.peakR).toBe(0);
    expect(db(r.rmsL)).toBeCloseTo(-9.01, 1);
  });

  it('corrélation : +1 en mono, −1 en phase inversée, ≈ 0 pour deux bruits indépendants', () => {
    const x = sine(1, 440, -10);
    expect(measure(x, x, {}).corr).toBeCloseTo(1, 5);
    const inv = x.map(v => -v);
    expect(measure(x, inv, {}).corr).toBeCloseTo(-1, 5);
    let s1 = 1, s2 = 99;
    const r1 = () => { s1 = (s1 * 1664525 + 1013904223) >>> 0; return s1 / 4294967296 - 0.5; };
    const r2 = () => { s2 = (s2 * 22695477 + 1) >>> 0; return s2 / 4294967296 - 0.5; };
    const A = new Float32Array(SR).map(r1), B = new Float32Array(SR).map(r2);
    expect(Math.abs(measure(A, B, {}).corr)).toBeLessThan(0.05);
    expect(correlationOf(0, 0, 0)).toBe(0);
  });
});

describe('Échelles et analyseur', () => {
  it('échelles : 0 dBFS en haut, plancher en bas, monotones', () => {
    for (const s of METER_SCALES) {
      expect(scaleFrac(s, s.topDb)).toBeCloseTo(1, 5);
      expect(scaleFrac(s, -200)).toBe(0);
      let prev = -1;
      for (let d = s.floorDb; d <= s.topDb; d += 0.5) { const f = scaleFrac(s, d); expect(f).toBeGreaterThanOrEqual(prev); prev = f; }
    }
  });

  it('lissage par octave : un bruit blanc (plat) reste plat', () => {
    const bins = new Float32Array(1024).fill(-40);
    const out = octaveSmooth(bins, 48000, 1 / 3);
    for (let i = 10; i < 1000; i++) expect(out[i]).toBeCloseTo(-40, 3);
  });
});
