import { describe, expect, it } from 'vitest';
import {
  THIRD_OCTAVE_CENTERS, applyEq, biquadCoeffs, biquadMagDb, eqResponseDb, fitEqToCurve, matchToReference,
  proEq12ParamsFor, spectralDistance, thirdOctaveSpectrum, curveDiff, MATCH_MAX_DB, EqBand,
} from '../utils/referenceMatch';

const SR = 44100;

function noise(n: number, seed = 1): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = ((s / 4294967296) * 2 - 1) * 0.3; }
  return out;
}

describe('Filtres (formules Web Audio, comme le Pro-EQ 12)', () => {
  it('cloche +6 dB : +6 dB au centre, ~0 dB loin', () => {
    const c = biquadCoeffs({ type: 'peaking', freq: 1000, q: 1, gainDb: 6 }, SR);
    expect(biquadMagDb(c, 1000, SR)).toBeCloseTo(6, 2);
    expect(Math.abs(biquadMagDb(c, 50, SR))).toBeLessThan(0.1);
  });
  it('plateaux : gain plein loin de la fréquence, moitié à la fréquence', () => {
    const lo = biquadCoeffs({ type: 'lowshelf', freq: 100, q: 0.7, gainDb: 4 }, SR);
    expect(biquadMagDb(lo, 15, SR)).toBeCloseTo(4, 1);
    expect(biquadMagDb(lo, 100, SR)).toBeCloseTo(2, 1);
    const hi = biquadCoeffs({ type: 'highshelf', freq: 8000, q: 0.7, gainDb: -4 }, SR);
    expect(biquadMagDb(hi, 18000, SR)).toBeLessThan(-3.5);
    expect(Math.abs(biquadMagDb(hi, 200, SR))).toBeLessThan(0.05);
  });
  it('applyEq donne, sur un sinus, le gain prévu par la réponse', () => {
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * i / SR);
    const [y] = applyEq([x], SR, [{ type: 'peaking', freq: 1000, q: 1, gainDb: 6 }]);
    let a = 0, b = 0;
    for (let i = SR / 2; i < n; i++) { a = Math.max(a, Math.abs(x[i])); b = Math.max(b, Math.abs(y[i])); }
    expect(20 * Math.log10(b / a)).toBeCloseTo(6, 1);
  });
});

describe('Spectre par tiers d’octave', () => {
  it('26 bandes de 50 Hz à 16 kHz', () => {
    expect(THIRD_OCTAVE_CENTERS).toHaveLength(26);
    expect(THIRD_OCTAVE_CENTERS[0]).toBe(50);
    expect(THIRD_OCTAVE_CENTERS[25]).toBe(16000);
  });
  it('bruit blanc : +1 dB par tiers d’octave (largeur de bande proportionnelle à la fréquence)', () => {
    const x = noise(SR * 6, 3);
    const c = thirdOctaveSpectrum([x, x], SR);
    const slope = (c[20] - c[8]) / 12;
    expect(slope).toBeGreaterThan(0.8);
    expect(slope).toBeLessThan(1.2);
  });
  it('écart nul entre une courbe et elle-même décalée en niveau', () => {
    const x = noise(SR * 3, 5);
    const c = thirdOctaveSpectrum([x], SR);
    expect(spectralDistance(c, c.map(v => v - 7))).toBeLessThan(1e-9);
    expect(curveDiff(c, c.map(v => v + 3)).every(v => Math.abs(v) < 1e-9)).toBe(true);
  });
});

describe('Correction d’EQ vers la référence', () => {
  it('jamais plus de ±4 dB par bande, même pour un écart de 15 dB', () => {
    const target = THIRD_OCTAVE_CENTERS.map(f => (f < 200 ? 15 : f > 5000 ? -15 : 0));
    const bands = fitEqToCurve(target, SR);
    expect(bands).toHaveLength(6);
    for (const b of bands) expect(Math.abs(b.gainDb)).toBeLessThanOrEqual(MATCH_MAX_DB);
  });

  it('retrouve une EQ connue : la référence = le mix passé dans un plateau grave −3 dB et un plateau aigu +3 dB', () => {
    const x = noise(SR * 8, 11), y = noise(SR * 8, 12);
    const truth: EqBand[] = [{ type: 'lowshelf', freq: 120, q: 0.7, gainDb: -3 }, { type: 'highshelf', freq: 6000, q: 0.7, gainDb: 3 }];
    const ref = applyEq([x, y], SR, truth);
    const mixC = thirdOctaveSpectrum([x, y], SR), refC = thirdOctaveSpectrum(ref, SR);
    const m = matchToReference(mixC, refC, SR, 1);
    for (const b of m.bands) expect(Math.abs(b.gainDb)).toBeLessThanOrEqual(4);
    // Le mix corrigé, MESURÉ (pas seulement prévu), se rapproche de la référence d'au moins 60 %.
    const fixedC = thirdOctaveSpectrum(applyEq([x, y], SR, m.bands), SR);
    const before = spectralDistance(mixC, refC), after = spectralDistance(fixedC, refC);
    expect(before).toBeGreaterThan(1);
    expect(after).toBeLessThan(before * 0.4);
    expect(m.predicted).toBeLessThan(before * 0.4);
  });

  it('dosage : à 50 %, la correction est environ deux fois plus petite', () => {
    const mix = THIRD_OCTAVE_CENTERS.map(() => 0);
    const ref = THIRD_OCTAVE_CENTERS.map(f => 3 * Math.log2(1000 / f) / 4.3);
    const full = matchToReference(mix, ref, SR, 1), half = matchToReference(mix, ref, SR, 0.5);
    const span = (b: EqBand[]) => Math.max(...b.map(x => x.gainDb)) - Math.min(...b.map(x => x.gainDb));
    expect(span(half.bands)).toBeLessThan(span(full.bands) * 0.7);
  });

  it('réglages du Pro-EQ 12 : passe-haut 22 Hz + les 6 bandes, 12 bandes en tout', () => {
    const bands = fitEqToCurve(THIRD_OCTAVE_CENTERS.map(f => (f > 3000 ? 2 : 0)), SR);
    const p = proEq12ParamsFor(bands);
    expect(p.bands).toHaveLength(12);
    expect(p.bands[0]).toMatchObject({ type: 'highpass', frequency: 22 });
    expect(p.bands.slice(1, 7).map((b: any) => b.gain)).toEqual(bands.map(b => b.gainDb));
    expect(p.bands.slice(7).every((b: any) => !b.isEnabled)).toBe(true);
    // La réponse prévue est celle de ces filtres.
    const r = eqResponseDb(bands, [10000], SR)[0];
    expect(r).toBeGreaterThan(0.5);
  });
});
