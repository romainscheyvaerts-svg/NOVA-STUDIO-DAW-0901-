/**
 * Écart 7 · Plosives (« p », « b » qui tapent dans le micro) : un souffle de
 * grave très court (surtout sous 100-150 Hz) qui sature la membrane.
 *
 * Le son est séparé en deux bandes complémentaires sans déphasage : le grave
 * (passe-bas Butterworth d'ordre 4 à 120 Hz, appliqué aller-retour : la bande
 * tombe de 48 dB par octave) et tout le reste (le son moins le grave). Une
 * plosive = un instant où le grave dépasse nettement la voix au-dessus de 120 Hz.
 * Pendant ces instants seulement, le grave est baissé jusqu'au niveau de la voix
 * (au plus 30 dB), avec des transitions de quelques millisecondes ;
 * partout ailleurs, la sortie est le son d'origine, à l'échantillon près.
 * La voix au-dessus de 200 Hz n'est pas touchée (la bande grave y vaut −36 dB).
 *
 * C'est le principe des « de-plosive » des suites de restauration : filtre
 * passe-haut dynamique déclenché par l'énergie grave.
 */
import type { RepairStrength } from './pipeline';
import { BUTTER4_Q, dbToLin, filtfilt, lowpass } from './dsp';

export interface PlosiveStats { count: number; maxReductionDb: number }

/** Coupure de la bande grave (Hz). */
export const PLOSIVE_CUTOFF = 120;
/** Déclenchement : le grave dépasse le reste de N dB (Léger : seulement les grosses plosives). */
export const PLOSIVE_TRIGGER_DB: Record<RepairStrength, number> = { light: 9, medium: 4, strong: 0 };
/** Grave ramené à N dB sous le reste (le grave naturel d'une voix reste en dessous). */
const TARGET_BELOW_DB = 6;
const MAX_REDUCTION_DB = 30;
/** Plancher : rien sous −50 dBFS de grave (bruit de fond, silence). */
const FLOOR_DB = -50;

/** Bande grave (phase nulle) d'un signal mono. */
export function lowBand(x: Float32Array | Float64Array, sampleRate: number): Float64Array {
  const f = BUTTER4_Q.map(q => lowpass(PLOSIVE_CUTOFF, q, sampleRate));
  return filtfilt(x, f, Math.round(0.05 * sampleRate));
}

/** Gain de la bande grave, échantillon par échantillon (1 = intact). */
export function plosiveGain(mono: Float32Array, sampleRate: number, strength: RepairStrength): { gain: Float32Array | null; count: number; maxReductionDb: number } {
  const n = mono.length;
  const low = lowBand(mono, sampleRate);
  const hop = Math.max(16, Math.round(0.0025 * sampleRate));
  // 20 ms : au moins deux périodes d'une voix grave (100 Hz), sinon le grave « oscille » d'une fenêtre à l'autre.
  const win = Math.max(hop, Math.round(0.02 * sampleRate));
  const nf = Math.ceil(n / hop);
  const target = new Float64Array(nf).fill(1);
  const trig = PLOSIVE_TRIGGER_DB[strength] ?? PLOSIVE_TRIGGER_DB.medium;
  const flags = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    const c = f * hop, a = Math.max(0, c - (win >> 1)), b = Math.min(n, c + (win >> 1));
    let el = 0, eh = 0;
    for (let i = a; i < b; i++) { const l = low[i], h = mono[i] - l; el += l * l; eh += h * h; }
    if (b - a < 0.75 * win) continue; // fenêtre tronquée au bord du son : mesure peu fiable
    const m = Math.max(1, b - a);
    const ldb = 10 * Math.log10(el / m + 1e-20), hdb = 10 * Math.log10(eh / m + 1e-20);
    if (ldb < FLOOR_DB || ldb - hdb < trig) continue;
    const red = Math.min(MAX_REDUCTION_DB, ldb - (hdb - TARGET_BELOW_DB));
    if (red <= 0.5) continue;
    target[f] = dbToLin(-red);
    flags[f] = 1;
  }
  let count = 0, maxRed = 0;
  for (let f = 0; f < nf; f++) {
    if (flags[f] && (f === 0 || !flags[f - 1])) count++;
    if (flags[f]) maxRed = Math.max(maxRed, -20 * Math.log10(target[f]));
  }
  if (!count) return { gain: null, count: 0, maxReductionDb: 0 };
  // Lissage : minimum sur ±7,5 ms (on prend le début de la plosive), puis moyenne glissante sur ±5 ms.
  const spread = Math.max(1, Math.round(0.0075 * sampleRate / hop));
  const mins = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    let m = 1;
    for (let k = Math.max(0, f - spread); k <= Math.min(nf - 1, f + spread); k++) if (target[k] < m) m = target[k];
    mins[f] = m;
  }
  const avg = Math.max(1, Math.round(0.005 * sampleRate / hop));
  const smooth = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    // Que des 1 autour : la somme vaut exactement c, donc le gain exactement 1 (son intact).
    let s = 0, c = 0;
    for (let k = Math.max(0, f - avg); k <= Math.min(nf - 1, f + avg); k++) { s += mins[k]; c++; }
    smooth[f] = s / c;
  }
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / hop, f = Math.floor(p), fr = p - f;
    const g0 = smooth[Math.min(nf - 1, f)], g1 = smooth[Math.min(nf - 1, f + 1)];
    gain[i] = g0 === 1 && g1 === 1 ? 1 : g0 + (g1 - g0) * fr;
  }
  return { gain, count, maxReductionDb: Math.round(maxRed * 10) / 10 };
}

/** Adoucit les plosives ; détection sur la somme des canaux, même gain partout (image stéréo gardée). */
export function reducePlosives(chs: Float32Array[], sampleRate: number, strength: RepairStrength): { channels: Float32Array[]; stats: PlosiveStats } {
  const n = chs[0]?.length || 0;
  const mono = chs.length === 1 ? chs[0] : (() => { const m = new Float32Array(n); for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] / chs.length; return m; })();
  const { gain, count, maxReductionDb } = plosiveGain(mono, sampleRate, strength);
  if (!gain) return { channels: chs, stats: { count: 0, maxReductionDb: 0 } };
  const out = chs.map(c => {
    const low = lowBand(c, sampleRate);
    const y = new Float32Array(c);
    for (let i = 0; i < n; i++) { const g = gain[i]; if (g !== 1) y[i] = c[i] - (1 - g) * low[i]; }
    return y;
  });
  return { channels: out, stats: { count, maxReductionDb } };
}
