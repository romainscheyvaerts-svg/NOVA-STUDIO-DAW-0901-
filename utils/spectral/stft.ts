/**
 * Écart 7 · Éditeur spectral : le calcul (sans DOM ; Worker et tests).
 *
 *  - `spectrogram` : image temps × fréquence d'un son (somme des canaux),
 *    fréquences en échelle logarithmique (comme l'oreille), niveaux en dB ramenés
 *    sur 0-255 pour l'affichage ;
 *  - `editZone` : une zone temps × fréquence est atténuée de N dB, ou « remplie
 *    depuis le voisinage » (le niveau de chaque fréquence y est remplacé par celui
 *    juste avant et juste après la zone, fondu de l'un à l'autre, phase gardée :
 *    une toux, un téléphone, une chaise qui grince disparaissent dans le fond).
 *
 * Méthode : transformée de Fourier à court terme (fenêtre de Hann de 2048
 * échantillons, recouvrement 75 %, somme des fenêtres au carré constante = 1,5).
 * Seule la DIFFÉRENCE voulue est resynthétisée et ajoutée au son : y = x + Δ. Hors
 * des trames touchées, le son est donc identique à l'échantillon près, et une
 * zone sans changement ne bouge rien.
 */
import { fftInPlace } from '../../engine/phaseVocoder';

export const SPEC_N = 2048;
export const SPEC_HOP = SPEC_N / 4;
/** Σ w² des fenêtres de Hann périodiques à 75 % de recouvrement (constante). */
const OLA_NORM = (3 / 8) * (SPEC_N / SPEC_HOP);
/** Fréquence la plus basse affichée. */
export const SPEC_F_MIN = 30;

const hann = (() => {
  const w = new Float64Array(SPEC_N);
  for (let i = 0; i < SPEC_N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEC_N);
  return w;
})();

export interface Spectrogram {
  /** rows × cols, ligne 0 = fréquence la plus HAUTE (prête à dessiner), 0-255. */
  data: Uint8Array;
  cols: number;
  rows: number;
  /** Durée représentée (s) et fréquences extrêmes (Hz). */
  duration: number;
  fMin: number;
  fMax: number;
  /** Niveau du pixel le plus fort (dB, pleine échelle = 0) ; 255 ↔ topDb, 0 ↔ topDb − range. */
  topDb: number;
  rangeDb: number;
}

/** Ligne de l'image (0 = haut) → fréquence (Hz), échelle logarithmique. */
export const rowToFreq = (row: number, rows: number, fMin: number, fMax: number) => fMin * Math.pow(fMax / fMin, 1 - (row + 0.5) / rows);
/** Fréquence (Hz) → position verticale 0 (haut) … 1 (bas). */
export const freqToY = (f: number, fMin: number, fMax: number) => 1 - Math.log(Math.max(fMin, Math.min(fMax, f)) / fMin) / Math.log(fMax / fMin);
/** Position verticale 0 (haut) … 1 (bas) → fréquence (Hz). */
export const yToFreq = (y: number, fMin: number, fMax: number) => fMin * Math.pow(fMax / fMin, 1 - Math.max(0, Math.min(1, y)));

/** Image du son entre `from` et `to` (échantillons), `cols` colonnes au plus, `rows` lignes. */
export function spectrogram(chs: Float32Array[], sampleRate: number, o: { from?: number; to?: number; cols?: number; rows?: number; rangeDb?: number } = {}): Spectrogram {
  const len = chs[0]?.length || 0;
  const from = Math.max(0, Math.floor(o.from ?? 0)), to = Math.min(len, Math.ceil(o.to ?? len));
  const span = Math.max(1, to - from);
  const cols = Math.max(1, Math.min(o.cols ?? 1200, Math.ceil(span / 64)));
  const rows = Math.max(16, o.rows ?? 256);
  const fMax = sampleRate / 2, fMin = Math.min(SPEC_F_MIN, fMax / 4);
  const rangeDb = o.rangeDb ?? 90;
  const mags = new Float32Array(rows * cols);
  // Cases FFT de chaque ligne (au moins une : en bas, les lignes sont plus fines que les cases).
  const kLo = new Int32Array(rows), kHi = new Int32Array(rows);
  for (let r = 0; r < rows; r++) {
    const fHi = fMin * Math.pow(fMax / fMin, 1 - r / rows), fLo = fMin * Math.pow(fMax / fMin, 1 - (r + 1) / rows);
    const a = Math.max(1, Math.round((fLo * SPEC_N) / sampleRate)), b = Math.min(SPEC_N / 2 - 1, Math.round((fHi * SPEC_N) / sampleRate));
    kLo[r] = Math.min(a, b); kHi[r] = Math.max(a, b);
  }
  const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
  let top = 1e-20;
  const inv = 1 / chs.length;
  for (let c = 0; c < cols; c++) {
    const center = from + ((c + 0.5) / cols) * span;
    const s0 = Math.round(center - SPEC_N / 2);
    for (let i = 0; i < SPEC_N; i++) {
      const idx = s0 + i;
      let v = 0;
      if (idx >= 0 && idx < len) for (const ch of chs) v += ch[idx];
      re[i] = v * inv * hann[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let r = 0; r < rows; r++) {
      let m = 0;
      for (let k = kLo[r]; k <= kHi[r]; k++) { const p = re[k] * re[k] + im[k] * im[k]; if (p > m) m = p; }
      mags[r * cols + c] = m;
      if (m > top) top = m;
    }
  }
  // Pleine échelle : un sinus d'amplitude 1 donne |X| = N/4 avec la fenêtre de Hann.
  const ref = (SPEC_N / 4) ** 2;
  const topDb = 10 * Math.log10(top / ref);
  const data = new Uint8Array(rows * cols);
  for (let i = 0; i < data.length; i++) {
    const d = 10 * Math.log10(mags[i] / ref + 1e-30) - topDb;
    data[i] = Math.max(0, Math.min(255, Math.round(255 * (1 + d / rangeDb))));
  }
  return { data, cols, rows, duration: span / sampleRate, fMin, fMax, topDb, rangeDb };
}

export interface SpectralZone {
  /** Début et fin (s, dans le son traité), fréquences basse et haute (Hz). */
  t0: number;
  t1: number;
  f0: number;
  f1: number;
}

export type ZoneOp = { kind: 'attenuate'; db: number } | { kind: 'fill' };

/** Atténuations proposées (dB). */
export const ATTENUATIONS = [6, 12, 20, 40];

/**
 * Applique une retouche à une zone ; renvoie de NOUVEAUX canaux (les autres
 * échantillons, recopiés tels quels). `changed` : échantillons modifiés [début, fin).
 */
export function editZone(chs: Float32Array[], sampleRate: number, zone: SpectralZone, op: ZoneOp): { channels: Float32Array[]; changed: [number, number] | null } {
  const len = chs[0]?.length || 0;
  const a = Math.max(0, Math.min(len, Math.round(Math.min(zone.t0, zone.t1) * sampleRate)));
  const b = Math.max(0, Math.min(len, Math.round(Math.max(zone.t0, zone.t1) * sampleRate)));
  const kf0 = Math.max(1, Math.ceil((Math.min(zone.f0, zone.f1) * SPEC_N) / sampleRate));
  const kf1 = Math.min(SPEC_N / 2 - 1, Math.floor((Math.max(zone.f0, zone.f1) * SPEC_N) / sampleRate));
  if (b - a < 1 || kf1 < kf0) return { channels: chs, changed: null };
  // Trames : début s_m = m·hop − (N − hop) ; centre = s_m + N/2.
  const startOf = (m: number) => m * SPEC_HOP - (SPEC_N - SPEC_HOP);
  const centerOf = (m: number) => startOf(m) + SPEC_N / 2;
  let m0 = Math.ceil((a - SPEC_N / 2 + (SPEC_N - SPEC_HOP)) / SPEC_HOP);
  let m1 = Math.floor((b - SPEC_N / 2 + (SPEC_N - SPEC_HOP)) / SPEC_HOP);
  if (m1 < m0) { const mid = Math.round(((a + b) / 2 - SPEC_N / 2 + (SPEC_N - SPEC_HOP)) / SPEC_HOP); m0 = m1 = mid; }
  const gain = op.kind === 'attenuate' ? Math.pow(10, -Math.abs(op.db) / 20) : 1;
  const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
  const frame = (x: Float32Array, m: number) => {
    const s = startOf(m);
    for (let i = 0; i < SPEC_N; i++) { const idx = s + i; re[i] = idx >= 0 && idx < len ? x[idx] * hann[i] : 0; im[i] = 0; }
    fftInPlace(re, im);
  };
  // Trames de référence (remplissage) : jusqu'à 3 de chaque côté, centrées au moins N/4 hors de la zone.
  const refMags = (x: Float32Array, side: -1 | 1): Float64Array | null => {
    const acc = new Float64Array(kf1 - kf0 + 1);
    let count = 0;
    for (let step = 0, m = side < 0 ? m0 - 1 : m1 + 1; step < 12 && count < 3; step++, m += side) {
      const c = centerOf(m);
      if (c < 0 || c >= len) break;
      if (side < 0 ? c > a - SPEC_N / 4 : c < b + SPEC_N / 4) continue;
      frame(x, m);
      for (let k = kf0; k <= kf1; k++) acc[k - kf0] += Math.hypot(re[k], im[k]);
      count++;
    }
    if (!count) return null;
    for (let i = 0; i < acc.length; i++) acc[i] /= count;
    return acc;
  };
  const dRe = new Float64Array(SPEC_N), dIm = new Float64Array(SPEC_N);
  let lo = Infinity, hi = -Infinity;
  const out = chs.map(x => {
    let L: Float64Array | null = null, R: Float64Array | null = null;
    if (op.kind === 'fill') {
      L = refMags(x, -1); R = refMags(x, 1);
      if (!L && !R) return x;
      L = L || R; R = R || L;
    }
    const y = new Float64Array(len);
    let touched = false;
    for (let m = m0; m <= m1; m++) {
      frame(x, m);
      dRe.fill(0); dIm.fill(0);
      const alpha = m1 > m0 ? (m - m0) / (m1 - m0) : 0.5;
      let any = false;
      for (let k = kf0; k <= kf1; k++) {
        let nr: number, ni: number;
        if (op.kind === 'attenuate') { nr = re[k] * gain; ni = im[k] * gain; }
        else {
          const target = (1 - alpha) * L![k - kf0] + alpha * R![k - kf0];
          const mag = Math.hypot(re[k], im[k]);
          if (mag > 1e-12) { nr = (re[k] / mag) * target; ni = (im[k] / mag) * target; } else { nr = target; ni = 0; }
        }
        const dr = nr - re[k], di = ni - im[k];
        if (dr === 0 && di === 0) continue;
        any = true;
        dRe[k] = dr; dIm[k] = di;
        dRe[SPEC_N - k] = dr; dIm[SPEC_N - k] = -di; // symétrie : signal réel
      }
      if (!any) continue;
      fftInPlace(dRe, dIm, true);
      const s = startOf(m);
      for (let i = 0; i < SPEC_N; i++) {
        const idx = s + i;
        if (idx < 0 || idx >= len) continue;
        y[idx] += (dRe[i] / SPEC_N) * hann[i] / OLA_NORM;
        if (idx < lo) lo = idx;
        if (idx > hi) hi = idx;
      }
      touched = true;
    }
    if (!touched) return x;
    const o2 = new Float32Array(x);
    for (let i = Math.max(0, lo); i <= Math.min(len - 1, hi); i++) if (y[i] !== 0) o2[i] = x[i] + y[i];
    return o2;
  });
  return { channels: out, changed: Number.isFinite(lo) ? [lo, hi + 1] : null };
}
