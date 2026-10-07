/** Petits outils de spectre pour les tests audio (FFT radix 2, harmoniques). */
import { envelope } from './synthVoice';

export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k), s = Math.sin(a * k);
        const p = i + k, q = i + k + len / 2;
        const vr = re[q] * c - im[q] * s, vi = re[q] * s + im[q] * c;
        re[q] = re[p] - vr; im[q] = im[p] - vi;
        re[p] += vr; im[p] += vi;
      }
    }
  }
}

/**
 * Niveau (dB) de chaque harmonique de f0 jusqu'à 4 kHz, mesuré entre a et b
 * (s), moins la vraie enveloppe de la voyelle : 0 partout = formants intacts.
 * Normalisé sur la 3e harmonique.
 */
export function harmonicsVsEnvelope(x: Float32Array, sr: number, a: number, b: number, f0: number, N = 8192): number[] {
  const spec = new Float64Array(N / 2);
  let c = 0;
  for (let s = Math.round(a * sr); s + N <= b * sr; s += N / 4) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) spec[k] += Math.hypot(re[k], im[k]);
    c++;
  }
  const out: number[] = [];
  for (let h = 1; h * f0 < 4000; h++) {
    const k = Math.round((h * f0 * N) / sr);
    let m = 0;
    for (let q = k - 4; q <= k + 4; q++) m = Math.max(m, spec[q]);
    out.push(20 * Math.log10(m / Math.max(1, c) + 1e-12) - 20 * Math.log10(envelope(h * f0)));
  }
  const ref = out[2];
  return out.map(v => v - ref);
}
