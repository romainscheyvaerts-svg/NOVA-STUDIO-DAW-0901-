/**
 * Mesures audio sur des canaux bruts (Float32Array), utilisables dans le
 * navigateur ET dans les tests : loudness intégrée (LUFS, BS.1770 via
 * `utils/loudness.ts`), crête vraie (dBTP) par suréchantillonnage à sinus
 * cardinal long, dynamique (PLR) et étendue de loudness (LRA simplifiée).
 */
import { integratedLufs } from './loudness';

type Chans = Float32Array[];

const asBuffer = (ch: Chans, sampleRate: number) => ({
  sampleRate,
  numberOfChannels: ch.length,
  length: ch[0]?.length || 0,
  getChannelData: (c: number) => ch[c],
}) as unknown as AudioBuffer;

/** Loudness intégrée (LUFS) ; -Infinity sur un silence. */
export const lufsOf = (ch: Chans, sampleRate: number): number => integratedLufs(asBuffer(ch, sampleRate));

/**
 * Crête vraie en dBTP. Par défaut ×8 avec 64 coefficients par phase
 * (plus exigeant que les 4 phases × 12 coefficients de la norme BS.1770) :
 * c'est l'arbitre des preuves du limiteur.
 */
export function truePeakOf(ch: Chans, oversample = 8, taps = 64): number {
  const half = taps / 2;
  const phases: Float64Array[] = [];
  const i0 = (x: number) => { let s = 1, t = 1; for (let k = 1; k < 200; k++) { const h = x / (2 * k); t *= h * h; s += t; if (t < 1e-14 * s) break; } return s; };
  const beta = 9, ib = i0(beta);
  for (let k = 1; k < oversample; k++) {
    const frac = k / oversample, h = new Float64Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = (j - half + 1) - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / (half + 0.5);
      h[j] = Math.abs(r) >= 1 ? 0 : sinc * i0(beta * Math.sqrt(1 - r * r)) / ib;
      sum += h[j];
    }
    for (let j = 0; j < taps; j++) h[j] /= sum;
    phases.push(h);
  }
  let pk = 0;
  for (const x of ch) {
    const n = x.length;
    for (let m = 0; m < n; m++) {
      const a = Math.abs(x[m]); if (a > pk) pk = a;
      if (m < half - 1 || m + half >= n) continue;
      // Fenêtre rapide : inutile d'interpoler loin sous la crête courante.
      if (Math.abs(x[m]) < pk * 0.5 && Math.abs(x[m + 1]) < pk * 0.5) continue;
      for (const h of phases) {
        let v = 0;
        for (let j = 0; j < taps; j++) v += h[j] * x[m + j - half + 1];
        const av = Math.abs(v); if (av > pk) pk = av;
      }
    }
  }
  return 20 * Math.log10(Math.max(pk, 1e-12));
}

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
