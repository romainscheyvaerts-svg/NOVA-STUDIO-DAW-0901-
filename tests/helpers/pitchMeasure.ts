/**
 * Mesures de l'éditeur de notes (Nova Pitch) : hauteur, formants, clics,
 * vibrato, alignement. Utilisées par les tests (tests/novaPitch*.test.ts) et
 * par le banc de mesure (scripts/novaPitchBench.ts → RAPPORT.md).
 *
 * La hauteur est mesurée de deux façons :
 *  - « analyse » : le détecteur de NOVA (YIN + affinage), trame par trame ;
 *  - « spectre » : détecteur INDÉPENDANT (pics des harmoniques dans une FFT
 *    très zéro-paddée, interpolation parabolique sur le log du module, moyenne
 *    pondérée f_h / h) — sans rien en commun avec YIN.
 */
import { analyzePitch, centerOf, type PitchTrack } from '../../utils/pitchAnalysis';
import { fft } from './spectrum';

export const midiOfHz = (f: number) => 69 + 12 * Math.log2(f / 440);
export const hzOfMidi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Hauteur perçue (MIDI) entre a et b (s) d'après le détecteur de NOVA. */
export function pitchByAnalysis(x: Float32Array, sr: number, a: number, b: number, track?: PitchTrack): number {
  const tr = track ?? analyzePitch(x, sr);
  const v: number[] = [];
  for (let i = 0; i < tr.midi.length; i++) {
    const t = (i * tr.hop) / sr;
    if (t >= a && t <= b && !Number.isNaN(tr.midi[i])) v.push(tr.midi[i]);
  }
  return centerOf(v);
}

/** Moyenne simple de la hauteur trame par trame (vibrato sur un nombre entier de cycles). */
export function meanPitch(tr: PitchTrack, a: number, b: number): number {
  let s = 0, c = 0;
  for (let i = 0; i < tr.midi.length; i++) {
    const t = (i * tr.hop) / tr.sr;
    if (t >= a && t <= b && !Number.isNaN(tr.midi[i])) { s += tr.midi[i]; c++; }
  }
  return c ? s / c : NaN;
}

/**
 * Hauteur (MIDI) par le spectre : fenêtre de Hann sur [a, b], FFT zéro-paddée
 * à 2^18, pics des harmoniques 1..H autour de h·f0 approché, interpolation
 * parabolique (log), estimation f0 = Σ f_h·w / Σ h·w (w = amplitude).
 */
export function pitchBySpectrum(x: Float32Array, sr: number, a: number, b: number, guessMidi: number, H = 6): number {
  const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(x.length, Math.round(b * sr));
  const L = i1 - i0;
  const N = 1 << 18;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < L; i++) re[i] = x[i0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / L));
  fft(re, im);
  const mag = (k: number) => Math.log(Math.hypot(re[k], im[k]) + 1e-20);
  const f0g = hzOfMidi(guessMidi);
  let num = 0, den = 0;
  for (let h = 1; h <= H; h++) {
    const fc = h * f0g;
    if (fc > sr / 2 - 200) break;
    const span = Math.max(3, Math.round((fc * 0.03 * N) / sr));
    const kc = Math.round((fc * N) / sr);
    let best = kc, bv = -Infinity;
    for (let k = kc - span; k <= kc + span; k++) { const v = mag(k); if (v > bv) { bv = v; best = k; } }
    const y0 = mag(best - 1), y1 = mag(best), y2 = mag(best + 1);
    const d = y0 + y2 - 2 * y1;
    const sh = Math.abs(d) > 1e-12 ? (y0 - y2) / (2 * d) : 0;
    const f = ((best + sh) * sr) / N;
    const w = Math.exp(y1);
    num += f * w; den += h * w;
  }
  return midiOfHz(num / den);
}

/** Enveloppe spectrale (dB) relevée aux harmoniques de f0, interpolée sur une grille 300–4000 Hz. */
export function harmonicEnvelope(x: Float32Array, sr: number, a: number, b: number, f0: number): { grid: number[]; db: number[] } {
  const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(x.length, Math.round(b * sr));
  const L = i1 - i0;
  const N = 1 << Math.ceil(Math.log2(Math.max(8192, L * 2)));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < L; i++) re[i] = x[i0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / L));
  fft(re, im);
  const pts: [number, number][] = [];
  for (let h = 1; h * f0 < 4600; h++) {
    const k = Math.round((h * f0 * N) / sr);
    let m = 0;
    for (let q = k - 4; q <= k + 4; q++) if (q > 0 && q < N / 2) m = Math.max(m, Math.hypot(re[q], im[q]));
    pts.push([h * f0, 20 * Math.log10(m + 1e-12)]);
  }
  const grid: number[] = [], db: number[] = [];
  for (let f = 300; f <= 4000; f += 25) {
    let j = 0;
    while (j + 1 < pts.length && pts[j + 1][0] < f) j++;
    const [fa, va] = pts[j], [fb, vb] = pts[Math.min(pts.length - 1, j + 1)];
    grid.push(f); db.push(fb > fa ? va + ((vb - va) * (f - fa)) / (fb - fa) : va);
  }
  return { grid, db };
}

/** Écart moyen (dB) entre deux enveloppes, niveaux alignés (médiane). */
export function envelopeGap(a: number[], b: number[]): number {
  const d = a.map((v, i) => v - b[i]);
  const med = [...d].sort((p, q) => p - q)[d.length >> 1];
  return d.reduce((s, v) => s + Math.abs(v - med), 0) / d.length;
}

/**
 * Pire « clic » d'un son : énergie au-dessus de 6 kHz par blocs de 1 ms
 * (filtre du 2e ordre en différences), relative au niveau moyen du son, en dB.
 * On la compare à celle du son d'origine sur les mêmes zones.
 */
export function clickDb(y: Float32Array, sr: number, zones: [number, number][]): number {
  const d2 = new Float32Array(y.length);
  for (let i = 2; i < y.length; i++) d2[i] = y[i] - 2 * y[i - 1] + y[i - 2];
  let tot = 0, cnt = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > 1e-4) { tot += y[i] * y[i]; cnt++; }
  const ref = Math.sqrt(tot / Math.max(1, cnt)) || 1e-9;
  const blk = Math.max(8, Math.round(0.001 * sr));
  let worst = -200;
  for (const [a, b] of zones) {
    for (let s = Math.max(2, Math.round(a * sr)); s + blk <= Math.min(y.length, Math.round(b * sr)); s += blk) {
      let e = 0;
      for (let i = s; i < s + blk; i++) e += d2[i] * d2[i];
      worst = Math.max(worst, 20 * Math.log10(Math.sqrt(e / blk) / ref + 1e-12));
    }
  }
  return worst;
}

/** Plus grand saut d'un échantillon au suivant sur des zones (rapport à celui du son d'origine). */
export function maxStep(y: Float32Array, sr: number, zones: [number, number][]): number {
  let m = 0;
  for (const [a, b] of zones) for (let i = Math.max(1, Math.round(a * sr)); i < Math.min(y.length, Math.round(b * sr)); i++) m = Math.max(m, Math.abs(y[i] - y[i - 1]));
  return m;
}

/** Erreur (dB) entre deux sons sur une zone : 10·log10(Σ(a−b)² / Σa²). −Infinity = identiques. */
export function diffDb(a: Float32Array, b: Float32Array, i0: number, i1: number, bOffset = 0): number {
  let e = 0, d = 0;
  for (let i = i0; i < i1; i++) { const u = a[i], v = b[i + bOffset] ?? 0; e += u * u; d += (u - v) * (u - v); }
  return e > 0 ? 10 * Math.log10(d / e) : d > 0 ? Infinity : -Infinity;
}

/**
 * Vitesse du vibrato (Hz) d'une courbe de hauteur trame par trame : la dérive
 * lente (moyenne glissante de ±0,12 s) est retirée, puis on compte les passages
 * à zéro montants (interpolés) du résidu lissé.
 */
export function vibratoRate(tr: PitchTrack, a: number, b: number): number {
  const hopSec = tr.hop / tr.sr;
  const v: number[] = [];
  for (let i = Math.ceil(a / hopSec); i <= Math.floor(b / hopSec); i++) v.push(tr.midi[i]);
  if (v.filter(q => !Number.isNaN(q)).length < 20) return 0;
  const avg = (r: number, src: number[]) => src.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(src.length - 1, i + r); k++) if (!Number.isNaN(src[k])) { s += src[k]; c++; } return c ? s / c : NaN; });
  const slow = avg(Math.round(0.12 / hopSec), v);
  const res = avg(2, v.map((q, i) => q - slow[i]));
  const ups: number[] = [];
  for (let i = 1; i < res.length; i++) if (res[i - 1] < 0 && res[i] >= 0) ups.push(i - 1 + -res[i - 1] / (res[i] - res[i - 1]));
  if (ups.length < 2) return 0;
  return (ups.length - 1) / ((ups[ups.length - 1] - ups[0]) * hopSec);
}

/**
 * Vitesse du vibrato (Hz) par autocorrélation du résidu (dérive lente retirée),
 * pic entre 3,5 et 9 Hz, interpolation parabolique : plus stable que les
 * passages à zéro sur une note courte (2 à 4 cycles).
 */
export function vibratoRateAc(tr: PitchTrack, a: number, b: number): number {
  const hopSec = tr.hop / tr.sr;
  const v: number[] = [];
  for (let i = Math.ceil(a / hopSec); i <= Math.floor(b / hopSec); i++) v.push(tr.midi[i]);
  const avg = (r: number, src: number[]) => src.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(src.length - 1, i + r); k++) if (!Number.isNaN(src[k])) { s += src[k]; c++; } return c ? s / c : 0; });
  const slow = avg(Math.round(0.12 / hopSec), v);
  const res = v.map((q, i) => (Number.isNaN(q) ? 0 : q - slow[i]));
  const fps = 1 / hopSec, lo = Math.floor(fps / 9), hi = Math.ceil(fps / 3.5);
  if (res.length < hi + 4) return 0;
  const ac = (lag: number) => { let s = 0, e = 0; for (let i = 0; i + lag < res.length; i++) { s += res[i] * res[i + lag]; e += res[i] * res[i]; } return e > 0 ? s / e : 0; };
  let best = -1, bv = -Infinity;
  for (let lag = lo; lag <= hi; lag++) { const c = ac(lag); if (c > bv && c >= ac(lag - 1) && c >= ac(lag + 1)) { bv = c; best = lag; } }
  if (best < 0) return 0;
  const y0 = ac(best - 1), y1 = ac(best), y2 = ac(best + 1), den = y0 + y2 - 2 * y1;
  return fps / (best + (Math.abs(den) > 1e-12 ? (y0 - y2) / (2 * den) : 0));
}

/** Écart moyen (cents) trame par trame entre deux courbes (MIDI) sur [a, b] (s), trames voisées des deux. */
export function pairedCents(x: Float32Array, y: Float32Array, hopSec: number, a: number, b: number): { mean: number; medianAbs: number; frames: number } {
  const d: number[] = [];
  for (let i = Math.ceil(a / hopSec); i <= Math.floor(b / hopSec) && i < x.length && i < y.length; i++) if (!Number.isNaN(x[i]) && !Number.isNaN(y[i])) d.push((y[i] - x[i]) * 100);
  if (!d.length) return { mean: NaN, medianAbs: NaN, frames: 0 };
  const ad = d.map(Math.abs).sort((p, q) => p - q);
  return { mean: d.reduce((s, v) => s + v, 0) / d.length, medianAbs: ad[ad.length >> 1], frames: d.length };
}

/** Décalage (échantillons) qui aligne b sur a au mieux (corrélation par force brute sur ±maxLag). */
export function bestLag(a: Float32Array, b: Float32Array, i0: number, i1: number, maxLag: number, center = 0): number {
  let best = center, bv = -Infinity;
  for (let l = center - maxLag; l <= center + maxLag; l++) {
    let s = 0;
    for (let i = i0; i < i1; i++) s += a[i] * (b[i + l] ?? 0);
    if (s > bv) { bv = s; best = l; }
  }
  return best;
}
