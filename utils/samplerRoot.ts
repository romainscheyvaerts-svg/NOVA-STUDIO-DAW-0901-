import { analyzePitch, centerOf } from './pitchAnalysis';

/**
 * R18 · Note racine d'un sample, trouvée toute seule (comme le « Detect
 * pitch » du Sampler de FL, l'analyse de Simpler ou le Quick Sampler de Logic).
 *
 * On mesure la hauteur trame par trame (YIN de utils/pitchAnalysis) sur le
 * début du son (4 s au plus), on garde les trames fortes et stables, et on
 * prend leur centre (moyenne autour de la médiane, robuste au vibrato).
 * Résultat : la note MIDI la plus proche et l'accord fin (cents) à appliquer
 * pour que la note jouée tombe juste. Pur et synchrone (testé).
 */
export interface DetectedRoot {
  /** Note racine (MIDI). */
  midi: number;
  /** Accord fin à appliquer (cents, −50 … +50) : -écart mesuré. */
  fineTune: number;
  /** Hauteur mesurée (MIDI fractionnaire). */
  measured: number;
  /** Part des trames où une hauteur a été trouvée (0-1) : confiance. */
  voiced: number;
}

export function detectRoot(channels: Float32Array[], sampleRate: number, opts: { maxSec?: number } = {}): DetectedRoot | null {
  if (!channels.length || !channels[0].length) return null;
  const n = Math.min(channels[0].length, Math.round((opts.maxSec ?? 4) * sampleRate));
  const x = new Float32Array(n);
  channels.forEach(c => { for (let i = 0; i < n; i++) x[i] += c[i] / channels.length; });
  const track = analyzePitch(x, sampleRate, { fmin: 30, fmax: 2200, threshold: 0.15 });
  // Trames fortes (moins de 30 dB sous la plus forte) : l'attaque bruitée et la queue sont écartées.
  let loud = -180;
  for (let i = 0; i < track.rmsDb.length; i++) if (track.rmsDb[i] > loud) loud = track.rmsDb[i];
  const vals: number[] = [];
  let considered = 0;
  for (let i = 0; i < track.midi.length; i++) {
    if (track.rmsDb[i] < loud - 30) continue;
    considered++;
    const m = track.midi[i];
    if (!Number.isNaN(m)) vals.push(m);
  }
  if (vals.length < 6) return null;
  const measured = centerOf(vals);
  if (!isFinite(measured)) return null;
  const midi = Math.round(measured);
  return { midi, fineTune: Math.round((midi - measured) * 1000) / 10, measured, voiced: considered ? vals.length / considered : 0 };
}
