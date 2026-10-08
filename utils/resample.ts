/**
 * Rééchantillonnage de qualité studio (sinus cardinal fenêtré, Kaiser), sans
 * dépendance : utilisable dans le navigateur ET dans les tests.
 *
 * Pourquoi : un OfflineAudioContext réglé sur 44,1 kHz lit des prises en 48 kHz
 * avec l'interpolation du navigateur (linéaire dans Chromium), qui laisse passer
 * du repliement (aliasing). NOVA rend le mix à la fréquence de ses sources, puis
 * convertit ici, avec un vrai filtre anti-repliement (comme le SRC de Pro Tools,
 * Logic ou Ableton à l'export).
 *
 * Filtre polyphasé : pour un rapport L/M (après réduction par le PGCD), chaque
 * phase a sa table de coefficients. Coupure à 0,46 × la plus basse des deux
 * fréquences (≈ 20,3 kHz pour 44,1 kHz), 16 passages par zéro, Kaiser β = 8,6
 * (réjection ≈ −80 dB).
 */

const gcd = (a: number, b: number): number => { while (b) { const t = a % b; a = b; b = t; } return a; };

function besselI0(x: number): number {
  let s = 1, t = 1;
  for (let k = 1; k < 200; k++) { const h = x / (2 * k); t *= h * h; s += t; if (t < 1e-14 * s) break; }
  return s;
}

export interface ResampleOptions {
  /** Passages par zéro de chaque côté (qualité / vitesse). 16 par défaut. */
  zeroCrossings?: number;
  /** Bêta de la fenêtre de Kaiser. 8,6 par défaut. */
  beta?: number;
  /** Coupure relative à la Nyquist la plus basse (0,92 par défaut). */
  rolloff?: number;
}

/** Longueur de sortie exacte pour `n` échantillons d'entrée. */
export const resampledLength = (n: number, from: number, to: number): number =>
  from === to ? n : Math.round((n * to) / from);

/** Rééchantillonne un canal. Renvoie le même tableau si les fréquences sont égales. */
export function resampleChannel(input: Float32Array, from: number, to: number, opts: ResampleOptions = {}): Float32Array {
  if (from === to || input.length === 0) return input;
  if (!(from > 0 && to > 0)) throw new Error('Fréquence invalide');
  const g = gcd(Math.round(from), Math.round(to));
  const L = Math.round(to) / g;   // facteur de suréchantillonnage
  const M = Math.round(from) / g; // facteur de décimation
  const ratio = to / from;
  const zc = opts.zeroCrossings ?? 16;
  const beta = opts.beta ?? 8.6;
  // Coupure normalisée (1 = Nyquist de l'entrée).
  const fc = Math.min(1, ratio) * (opts.rolloff ?? 0.92);
  const K = Math.ceil(zc / fc);        // demi-largeur en échantillons d'entrée
  const taps = 2 * K;
  const ib = besselI0(beta);
  // Table polyphasée : phase p = décalage fractionnaire p / L.
  const table = new Float32Array(L * taps);
  for (let p = 0; p < L; p++) {
    const frac = p / L;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = (j - K + 1) - frac;            // distance (en échantillons d'entrée)
      const x = t * fc;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const r = t / (K + 1);
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / ib;
      const v = fc * sinc * w;
      table[p * taps + j] = v;
      sum += v;
    }
    // Gain unité exact à chaque phase (pas de ronflement de phase).
    if (sum !== 0) for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
  }
  const outLen = resampledLength(input.length, from, to);
  const out = new Float32Array(outLen);
  const n = input.length;
  for (let o = 0; o < outLen; o++) {
    const num = o * M;
    const base = Math.floor(num / L);
    const p = num - base * L;
    const off = p * taps;
    let acc = 0;
    const i0 = base - K + 1;
    if (i0 >= 0 && i0 + taps <= n) {
      for (let j = 0; j < taps; j++) acc += input[i0 + j] * table[off + j];
    } else {
      for (let j = 0; j < taps; j++) {
        const i = i0 + j;
        if (i >= 0 && i < n) acc += input[i] * table[off + j];
      }
    }
    out[o] = acc;
  }
  return out;
}

export function resampleChannels(chs: Float32Array[], from: number, to: number, opts?: ResampleOptions): Float32Array[] {
  return chs.map(c => resampleChannel(c, from, to, opts));
}
