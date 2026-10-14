/**
 * Mesures audio sur des canaux bruts (Float32Array), utilisables dans le
 * navigateur ET dans les tests : loudness intégrée (LUFS, BS.1770 via
 * `utils/loudness.ts`), crête vraie (dBTP) par suréchantillonnage à sinus
 * cardinal long, dynamique (PLR) et étendue de loudness (LRA simplifiée).
 */
import { integratedLufs, truePeakChannels } from './loudness';

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
 * Étendue de loudness simplifiée (LRA, EBU Tech 3342) : écart entre les
 * percentiles 10 et 95 des loudness court terme (3 s, pas de 1 s), après
 * portillon absolu -70 LUFS et relatif -20 LU. Non pondérée K (estimation).
 */
export function loudnessRangeOf(ch: Chans, sampleRate: number): number {
  const win = Math.round(3 * sampleRate), hop = Math.round(sampleRate);
  const n = ch[0]?.length || 0;
  const vals: number[] = [];
  for (let s = 0; s + win <= n; s += hop) {
    let z = 0;
    for (const x of ch) { let a = 0; for (let i = s; i < s + win; i++) a += x[i] * x[i]; z += a / win; }
    const l = -0.691 + 10 * Math.log10(Math.max(z, 1e-20));
    if (l > -70) vals.push(l);
  }
  if (vals.length < 2) return 0;
  const mean = 10 * Math.log10(vals.reduce((a, l) => a + Math.pow(10, l / 10), 0) / vals.length);
  const g = vals.filter(l => l > mean - 20).sort((a, b) => a - b);
  if (g.length < 2) return 0;
  const pct = (q: number) => g[Math.min(g.length - 1, Math.max(0, Math.round(q * (g.length - 1))))];
  return pct(0.95) - pct(0.1);
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
