/**
 * Écart 7 · Éditeur spectral : une zone temps × fréquence atténuée exactement,
 * le reste identique (à l'échantillon près hors des trames touchées), le
 * remplissage depuis le voisinage, et l'image du spectre.
 */
import { describe, expect, it } from 'vitest';
import { editZone, freqToY, rowToFreq, spectrogram, SPEC_N, yToFreq } from '../utils/spectral/stft';

const SR = 48000;
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}
/** Amplitude d'une sinusoïde de fréquence f sur [a, b) s (projection, fenêtre rectangulaire sur un nombre entier de périodes). */
function amp(x: Float32Array, f: number, a: number, b: number): number {
  const i0 = Math.round(a * SR), n = Math.round(Math.floor((b - a) * f) / f * SR);
  let c = 0, s = 0;
  for (let i = 0; i < n; i++) { const ph = (2 * Math.PI * f * (i0 + i)) / SR; c += x[i0 + i] * Math.cos(ph); s += x[i0 + i] * Math.sin(ph); }
  return (2 * Math.hypot(c, s)) / n;
}
const db = (r: number) => 20 * Math.log10(r);

describe('Zone atténuée', () => {
  const n = 3 * SR;
  const x = new Float32Array(n);
  const r = rng(3);
  for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 3000 * i) / SR + 1) + 0.001 * r();

  it('−12 dB dans la zone à ±0,5 dB, l’autre fréquence et le reste du son intacts', () => {
    const { channels: [y], changed } = editZone([x], SR, { t0: 1, t1: 2, f0: 800, f1: 1200 }, { kind: 'attenuate', db: 12 });
    const g = db(amp(y, 1000, 1.1, 1.9) / amp(x, 1000, 1.1, 1.9));
    const other = db(amp(y, 3000, 1.1, 1.9) / amp(x, 3000, 1.1, 1.9));
    console.log(`[spectral] 1 kHz dans la zone : ${g.toFixed(2)} dB · 3 kHz : ${other.toFixed(3)} dB`);
    expect(Math.abs(g + 12)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(other)).toBeLessThanOrEqual(0.1);
    // Hors des trames touchées : identique à l'échantillon près.
    expect(changed).not.toBeNull();
    const [lo, hi] = changed!;
    expect(lo).toBeGreaterThanOrEqual(Math.round(1 * SR) - SPEC_N);
    expect(hi).toBeLessThanOrEqual(Math.round(2 * SR) + SPEC_N);
    for (let i = 0; i < lo; i++) if (y[i] !== x[i]) throw new Error(`échantillon ${i} modifié`);
    for (let i = hi; i < n; i++) if (y[i] !== x[i]) throw new Error(`échantillon ${i} modifié`);
    // Avant la zone (1 kHz) : inchangé.
    expect(Math.abs(db(amp(y, 1000, 0.2, 0.8) / amp(x, 1000, 0.2, 0.8)))).toBeLessThan(0.01);
  });

  it('0 dB : rien ne change (même tableau)', () => {
    const { channels: [y], changed } = editZone([x], SR, { t0: 1, t1: 2, f0: 800, f1: 1200 }, { kind: 'attenuate', db: 0 });
    expect(y).toBe(x);
    expect(changed).toBeNull();
  });
});

describe('Remplir depuis le voisinage', () => {
  it('un bruit parasite (2 kHz, 0,3 s) retombe au niveau du fond autour', () => {
    const n = 2 * SR;
    const x = new Float32Array(n), floor = new Float32Array(n);
    const r = rng(11);
    for (let i = 0; i < n; i++) floor[i] = 0.02 * r();
    for (let i = 0; i < n; i++) x[i] = floor[i] + (i >= SR && i < 1.3 * SR ? 0.5 * Math.sin((2 * Math.PI * 2000 * i) / SR) : 0);
    const { channels: [y] } = editZone([x], SR, { t0: 0.95, t1: 1.35, f0: 1700, f1: 2300 }, { kind: 'fill' });
    const before = db(amp(x, 2000, 1.05, 1.25) / Math.max(1e-9, amp(floor, 2000, 1.05, 1.25)));
    const tone = amp(y, 2000, 1.05, 1.25);
    console.log(`[spectral] parasite : ${db(amp(x, 2000, 1.05, 1.25)).toFixed(1)} dB → ${db(tone).toFixed(1)} dB (fond ≈ ${db(0.02 / Math.sqrt(12) * Math.sqrt(2 / (0.2 * SR))).toFixed(1)} dB)`);
    expect(before).toBeGreaterThan(20);
    expect(db(amp(x, 2000, 1.05, 1.25) / tone)).toBeGreaterThan(25);
  });
});

describe('Image du spectre', () => {
  it('un sinus de 1 kHz s’allume à la bonne hauteur', () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const s = spectrogram([x], SR, { cols: 100, rows: 200 });
    expect(s.cols).toBe(100);
    let best = 0, bestRow = 0;
    for (let rr = 0; rr < s.rows; rr++) if (s.data[rr * s.cols + 50] > best) { best = s.data[rr * s.cols + 50]; bestRow = rr; }
    const f = rowToFreq(bestRow, s.rows, s.fMin, s.fMax);
    expect(Math.abs(Math.log2(f / 1000))).toBeLessThan(0.05);
    // Pleine échelle : à 1,5 dB près (perte de la fenêtre de Hann entre deux cases).
    expect(Math.abs(s.topDb - 20 * Math.log10(0.5))).toBeLessThan(1.5);
    expect(yToFreq(freqToY(440, s.fMin, s.fMax), s.fMin, s.fMax)).toBeCloseTo(440, 6);
  });
});
