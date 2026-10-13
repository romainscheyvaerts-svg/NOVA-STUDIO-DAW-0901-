import { describe, expect, it } from 'vitest';
import { waveSample, wavePath, biquadMagDb, synthFilterDb, filterPath, envPoints, lfoPath, freqToX } from '../utils/novaSynthDraw';
import { presetSettings } from '../utils/novaSynthPresets';

describe('Écrans du synthé : calculs de dessin', () => {
  it('formes d\'onde entre -1 et 1, périodiques', () => {
    for (const w of ['sine', 'triangle', 'sawtooth', 'square'] as const) {
      for (let i = 0; i < 50; i++) {
        const v = waveSample(w, i / 50);
        expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-9);
        expect(waveSample(w, i / 50 + 3)).toBeCloseTo(v, 9);
      }
    }
    expect(waveSample('sine', 0.25)).toBeCloseTo(1, 9);
    expect(waveSample('square', 0.1)).toBe(1);
    expect(waveSample('square', 0.6)).toBe(-1);
  });

  it('chemin SVG d\'une onde : commence par M, reste dans le cadre', () => {
    const d = wavePath('sawtooth', 120, 40);
    expect(d.startsWith('M0 ')).toBe(true);
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.-]+)/g)].map(m => +m[1]);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(40);
  });

  it('biquad comme le Web Audio : Q en dB (passe-bas / passe-haut), pic à 0 dB (passe-bande)', () => {
    // Passe-bas : à la coupure, le gain vaut Q (dB) ; une décade au-dessus, environ -40 dB.
    expect(biquadMagDb('lowpass', 1000, 12, 1000)).toBeCloseTo(12, 0);
    expect(biquadMagDb('lowpass', 1000, 0, 100)).toBeCloseTo(0, 0);
    expect(biquadMagDb('lowpass', 1000, 0, 10000)).toBeLessThan(-35);
    expect(biquadMagDb('highpass', 1000, 0, 100)).toBeLessThan(-35);
    expect(biquadMagDb('bandpass', 800, 3, 800)).toBeCloseTo(0, 1);
    expect(biquadMagDb('bandpass', 800, 3, 200)).toBeLessThan(-10);
  });

  it('24 dB/oct : deux filtres en série, pente deux fois plus raide', () => {
    const f = { ...presetSettings('init').filter, cutoff: 1000, reso: 0, type: 'lowpass' as const };
    const one = synthFilterDb({ ...f, steep: false }, 1000, 8000);
    const two = synthFilterDb({ ...f, steep: true }, 1000, 8000);
    expect(two).toBeLessThan(one * 1.7);
  });

  it('courbe du filtre bornée au cadre', () => {
    const s = presetSettings('lead-acide');
    const d = filterPath(s.filter, 200, 60);
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.-]+)/g)].map(m => +m[1]);
    expect(ys.length).toBeGreaterThan(100);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(60);
    expect(freqToX(20, 200)).toBe(0);
    expect(freqToX(20000, 200)).toBeCloseTo(200, 6);
  });

  it('enveloppe : 4 repères dans l\'ordre, de gauche à droite', () => {
    const { d, marks } = envPoints({ a: 0.003, d: 0.4, s: 0.5, r: 3 }, 160, 50);
    expect(d.startsWith('M')).toBe(true);
    for (let i = 1; i < marks.length; i++) expect(marks[i][0]).toBeGreaterThan(marks[i - 1][0]);
    expect(marks[3][0]).toBeLessThanOrEqual(160);
    // Une attaque de 3 ms reste visible (au moins 2 px).
    expect(marks[0][0]).toBeGreaterThan(2 + 2);
  });

  it('LFO : plus d\'intensité = plus d\'amplitude', () => {
    const amp = (d: string) => { const ys = [...d.matchAll(/[ML][\d.]+ ([\d.-]+)/g)].map(m => +m[1]); return Math.max(...ys) - Math.min(...ys); };
    expect(amp(lfoPath('sine', 2, 1, 100, 40))).toBeGreaterThan(amp(lfoPath('sine', 2, 0.1, 100, 40)) * 3);
  });
});
