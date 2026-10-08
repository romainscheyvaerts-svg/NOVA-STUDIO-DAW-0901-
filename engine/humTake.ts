/**
 * « Fredonne → MIDI » au micro (V20) : placement de la prise sur la timeline.
 *
 * La prise est captée par l'enregistreur calé (NovaRecorder) dans le contexte
 * du moteur : on connaît le numéro d'échantillon (horloge du contexte) du
 * premier échantillon capté. Comme pour une prise normale
 * (AudioEngine.stopCalibratedRecording), l'échantillon i correspond au temps
 * du projet (firstFrame + i) / sr − playStart − latence, où playStart est
 * l'instant (horloge) du temps 0 du projet et la latence = sortie (ce que
 * l'artiste entend) + entrée (sa voix jusqu'à l'enregistreur) + réglage fin.
 *
 * On ne garde que ce qui suit `from` (fin du décompte) : la voix chantée sur
 * le temps 1 tombe sur le temps 1, même avec 30 à 80 ms de latence.
 */
export interface HumPlacement {
  /** Échantillons gardés (à partir de `start`). */
  data: Float32Array;
  /** Temps du projet (s) du premier échantillon gardé. */
  start: number;
  /** Échantillons retirés au début (décompte + latence). */
  skipped: number;
}

export function placeHumTake(samples: Float32Array, sr: number, firstFrame: number, playStart: number, latency: number, from: number): HumPlacement {
  const t0 = firstFrame / sr - playStart - latency;     // temps du projet du 1er échantillon capté
  const i0 = Math.ceil((from - t0) * sr - 1e-6);
  if (i0 <= 0) return { data: samples, start: t0, skipped: 0 };
  const k = Math.min(samples.length, i0);
  return { data: samples.subarray(k), start: t0 + k / sr, skipped: k };
}
