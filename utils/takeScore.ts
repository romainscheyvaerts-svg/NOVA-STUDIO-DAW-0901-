/**
 * « Meilleure prise » (V22) : note d'une prise de voix, calculée en local
 * (aucun service externe, aucune dépendance). Testée dans tests/takeScore.test.ts.
 *
 * Quatre critères, notés de 0 à 100 :
 *   - justesse : écart (en cents) de la hauteur chantée à la note la plus
 *     proche (de la gamme si la tonalité est connue), détection de hauteur YIN ;
 *   - calage : distance des attaques (onsets) à la double croche la plus proche ;
 *   - niveau : niveau moyen de la voix (ni trop bas, ni saturé) ;
 *   - bruit : écart entre la voix et le bruit de fond (souffle, pièce).
 */

export interface TakeScore { total: number; pitch: number; timing: number; level: number; noise: number }

export interface ScoreOptions {
  bpm: number;
  /** Tonalité : fondamentale (0 = do … 11 = si) et gamme ; absente = chromatique. */
  key?: { root: number; scale?: string } | null;
  /** Gain appliqué au clip (niveau entendu). */
  gain?: number;
  /** Instant du projet du 1er échantillon (pour le calage sur la grille). */
  t0?: number;
}

const ANALYSIS_SR = 16000;
const FRAME = 512;   // 32 ms à 16 kHz : deux périodes à 70 Hz
const HOP = 256;     // 16 ms

const clamp = (x: number, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const dbOf = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -120);

/** Ré-échantillonne grossièrement à ~16 kHz (moyenne par paquets) : assez pour la voix. */
export function downsample(x: Float32Array, sr: number): { y: Float32Array; sr: number } {
  const f = Math.max(1, Math.round(sr / ANALYSIS_SR));
  if (f === 1) return { y: x, sr };
  const y = new Float32Array(Math.floor(x.length / f));
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += x[i * f + k];
    y[i] = s / f;
  }
  return { y, sr: sr / f };
}

/** Hauteur (Hz) d'une trame par YIN, ou null si la trame n'est pas voisée. */
export function yinPitch(x: Float32Array, from: number, sr: number, fmin = 70, fmax = 1000, thr = 0.15): number | null {
  const W = FRAME;
  const tauMin = Math.floor(sr / fmax), tauMax = Math.min(Math.floor(sr / fmin), W - 1);
  if (from + W + tauMax > x.length) return null;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W - tauMax; i++) { const v = x[from + i] - x[from + i + tau]; s += v * v; }
    d[tau] = s;
  }
  let run = 0;
  let best = -1;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    const cm = run > 0 ? (d[tau] * tau) / run : 1;
    d[tau] = cm;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < thr) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau; break;
    }
  }
  if (best < 0) return null;
  // Interpolation parabolique autour du minimum.
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
  const den = a + c - 2 * b;
  const shift = Math.abs(den) > 1e-12 ? (a - c) / (2 * den) : 0;
  return sr / (best + shift);
}

const SCALES: Record<string, number[]> = {
  MAJOR: [0, 2, 4, 5, 7, 9, 11], MINOR: [0, 2, 3, 5, 7, 8, 10],
  HARMONIC_MINOR: [0, 2, 3, 5, 7, 8, 11], DORIAN: [0, 2, 3, 5, 7, 9, 10], PHRYGIAN: [0, 1, 3, 5, 7, 8, 10],
};

/** Écart (cents, absolu) à la note permise la plus proche. */
export function centsOff(f0: number, key?: ScoreOptions['key']): number {
  const midi = 69 + 12 * Math.log2(f0 / 440);
  const allowed = key && key.scale && SCALES[key.scale.toUpperCase()] ? SCALES[key.scale.toUpperCase()].map(s => (s + key.root) % 12) : null;
  let best = Infinity;
  for (let m = Math.floor(midi) - 1; m <= Math.ceil(midi) + 1; m++) {
    if (allowed && !allowed.includes(((m % 12) + 12) % 12)) continue;
    best = Math.min(best, Math.abs(midi - m) * 100);
  }
  return best === Infinity ? 50 : best;
}

const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (v: number[], p: number) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Note d'un passage de voix (échantillons mono). */
export function scoreTake(samples: Float32Array, sampleRate: number, opts: ScoreOptions): TakeScore {
  const gain = opts.gain ?? 1;
  const { y, sr } = downsample(samples, sampleRate);
  const frames: { rms: number; peak: number; t: number }[] = [];
  for (let i = 0; i + FRAME <= y.length; i += HOP) {
    let s = 0, p = 0;
    for (let k = 0; k < FRAME; k++) { const v = y[i + k] * gain; s += v * v; p = Math.max(p, Math.abs(v)); }
    frames.push({ rms: Math.sqrt(s / FRAME), peak: p, t: (opts.t0 ?? 0) + i / sr });
  }
  // Pics réels (avant la moyenne du ré-échantillonnage) pour la saturation.
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i] * gain) >= 0.985) clipped++;
  if (!frames.length) return { total: 0, pitch: 0, timing: 0, level: 0, noise: 0 };

  const rmsDb = frames.map(f => dbOf(f.rms));
  const floorDb = pct(rmsDb, 0.1);
  const loudDb = pct(rmsDb, 0.9);
  const voicedThr = Math.max(floorDb + 10, loudDb - 25, -55);
  const voiced = frames.map((f, i) => rmsDb[i] >= voicedThr);

  // Justesse
  const cents: number[] = [];
  frames.forEach((f, i) => {
    if (!voiced[i]) return;
    const f0 = yinPitch(y, i * HOP, sr);
    if (f0) cents.push(centsOff(f0, opts.key));
  });
  const pitch = cents.length >= 3 ? clamp(100 - median(cents) * 2) : 50;

  // Calage : attaques (montée nette de niveau) contre la double croche la plus proche.
  const sixteenth = 60 / (opts.bpm > 0 ? opts.bpm : 120) / 4;
  const onsets: number[] = [];
  for (let i = 3; i < frames.length; i++) {
    const prev = (rmsDb[i - 1] + rmsDb[i - 2] + rmsDb[i - 3]) / 3;
    if (!(voiced[i] && rmsDb[i] - prev >= 8)) continue;
    // Position fine de l'attaque : 1er bloc de 2 ms qui dépasse la moitié du niveau de la trame.
    const from = Math.max(0, (i - 1) * HOP), to = Math.min(y.length, i * HOP + FRAME);
    const blk = Math.max(8, Math.round(sr * 0.002));
    const want = frames[i].rms / gain * 0.5;
    let at = frames[i].t;
    for (let k = from; k + blk <= to; k += blk) {
      let e = 0;
      for (let m = k; m < k + blk; m++) e += y[m] * y[m];
      if (Math.sqrt(e / blk) >= want) { at = (opts.t0 ?? 0) + k / sr; break; }
    }
    if (!onsets.length || at - onsets[onsets.length - 1] > 0.12) onsets.push(at);
  }
  const dist = onsets.map(t => { const r = t / sixteenth; return Math.abs(r - Math.round(r)) * sixteenth; });
  const timing = onsets.length ? clamp(100 * (1 - (dist.reduce((a, b) => a + b, 0) / dist.length) / (sixteenth / 2))) : 70;

  // Niveau : voix entre -24 et -12 dBFS en moyenne, pas de saturation.
  const vDb = rmsDb.filter((_, i) => voiced[i]);
  const avg = vDb.length ? dbOf(Math.sqrt(vDb.reduce((a, d) => a + Math.pow(10, d / 10), 0) / vDb.length)) : -120;
  const off = avg < -24 ? -24 - avg : avg > -12 ? avg - -12 : 0;
  const level = clamp(100 - off * 4 - (clipped / Math.max(1, samples.length)) * 20000);

  // Bruit : voix contre bruit de fond (trames non voisées), en dB.
  const snr = (vDb.length ? median(vDb) : -120) - floorDb;
  const noise = clamp((snr - 10) * 2.5);

  const total = Math.round(0.4 * pitch + 0.25 * timing + 0.15 * level + 0.2 * noise);
  return { total, pitch: Math.round(pitch), timing: Math.round(timing), level: Math.round(level), noise: Math.round(noise) };
}
