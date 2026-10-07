/**
 * Outils de spectre partagés par l'audio → MIDI (V20) : FFT radix 2,
 * sous-échantillonnage, mélange en mono. Logique pure, sans DOM.
 */

/** FFT en place (radix 2, taille puissance de 2). re / im : parties réelle et imaginaire. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Spectre d'amplitude (n/2 + 1 cases) d'une fenêtre de `n` échantillons
 * commençant à `start` (zéros hors du signal), fenêtrée par Hann.
 */
export function magnitudeAt(x: ArrayLike<number>, start: number, n: number, out?: Float64Array): Float64Array {
  const re = new Float64Array(n), im = new Float64Array(n);
  const w = hann(n);
  for (let i = 0; i < n; i++) {
    const k = start + i;
    re[i] = k >= 0 && k < x.length ? x[k] * w[i] : 0;
  }
  fft(re, im);
  const m = out && out.length === n / 2 + 1 ? out : new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) m[i] = Math.hypot(re[i], im[i]);
  return m;
}

/** Sous-échantillonnage par un facteur entier (moyenne glissante = passe-bas grossier). */
export function decimate(x: ArrayLike<number>, factor: number): Float32Array {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return Float32Array.from(x as ArrayLike<number>);
  const n = Math.floor(x.length / f);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const b = i * f;
    for (let k = 0; k < f; k++) s += x[b + k];
    out[i] = s / f;
  }
  return out;
}

/** Canaux mélangés en mono. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0]?.length || 0;
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

/** Tranche [start, end[ (s) d'un AudioBuffer, en mono. */
export function monoSlice(buffer: { sampleRate: number; length: number; numberOfChannels: number; getChannelData(c: number): Float32Array }, start: number, end: number): Float32Array {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(start * sr)), b = Math.min(buffer.length, Math.ceil(end * sr));
  const n = Math.max(0, b - a);
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[a + i] / ch;
  }
  return out;
}
