/**
 * Mesures audio sur des canaux bruts (Float32Array), utilisables dans le
 * navigateur ET dans les tests : loudness intégrée (LUFS, BS.1770 via
 * `utils/loudness.ts`), crête vraie (dBTP) par suréchantillonnage à sinus
 * cardinal long, dynamique (PLR) et étendue de loudness (LRA, EBU Tech 3342).
 */
import { integratedLufs, kWeighted, truePeakChannels } from './loudness';
import { loudnessRange } from '../engine/meters/loudness';

type Chans = Float32Array[];

const asBuffer = (ch: Chans, sampleRate: number) => ({
  sampleRate,
  numberOfChannels: ch.length,
  length: ch[0]?.length || 0,
  getChannelData: (c: number) => ch[c],
}) as unknown as AudioBuffer;

/** Loudness intégrée (LUFS) ; -Infinity sur un silence. */
export const lufsOf = (ch: Chans, sampleRate: number): number => integratedLufs(asBuffer(ch, sampleRate));

/** Crête vraie en dBTP (polyphase, voir utils/loudness.ts). */
export const truePeakOf = truePeakChannels;

/** Crête échantillon (dBFS). */
export function samplePeakOf(ch: Chans): number {
  let pk = 0;
  for (const x of ch) for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
  return 20 * Math.log10(Math.max(pk, 1e-12));
}

/**
 * Étendue de loudness (LRA, EBU Tech 3342) : écart entre les centiles 10 et 95 des
 * loudness court terme (fenêtres de 3 s, pas de 100 ms) PONDÉRÉES K, après portillon
 * absolu −70 LUFS et relatif −20 LU. Même calcul que le mètre en direct
 * (engine/meters/loudness.loudnessRange) : l'export et la fenêtre Loudness affichent le même LRA.
 *
 * Avant (22/10/2026) : sans pondération K et au pas de 1 s (« estimation ») : un passage
 * de graves puis d'aigus au même niveau crête (4 à 7 LU d'écart réel) donnait 0 LU.
 */
export function loudnessRangeOf(ch: Chans, sampleRate: number): number {
  const n = ch[0]?.length || 0;
  const win = Math.round(3 * sampleRate), hop = Math.max(1, Math.round(0.1 * sampleRate));
  if (n < win) return 0;
  // Somme cumulée de l'énergie pondérée K (poids 1,0 par canal, deux canaux au plus).
  const cum = new Float64Array(n + 1);
  for (const x of ch.slice(0, 2)) {
    const k = kWeighted(x, sampleRate);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += k[i] * k[i]; cum[i + 1] += acc; }
  }
  const energies: number[] = [];
  for (let s = 0; s + win <= n; s += hop) energies.push((cum[s + win] - cum[s]) / win);
  return loudnessRange(energies, energies.length);
}

export interface LoudnessReport {
  lufs: number;
  truePeak: number;
  /** Dynamique « crête / loudness » (PLR = dBTP − LUFS), en dB. */
  plr: number;
  lra: number;
}

export function loudnessReport(ch: Chans, sampleRate: number): LoudnessReport {
  const lufs = lufsOf(ch, sampleRate);
  const truePeak = truePeakOf(ch, 4, 48);
  return { lufs, truePeak, plr: Number.isFinite(lufs) ? truePeak - lufs : 0, lra: loudnessRangeOf(ch, sampleRate) };
}
