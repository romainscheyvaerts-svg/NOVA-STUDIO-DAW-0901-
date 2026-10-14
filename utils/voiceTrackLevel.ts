/**
 * Niveau d'une prise pour le calage des presets voix (lot 8a) : LUFS intégrés des clips
 * audio non muets de la piste (gain de clip compris, 90 s au plus), en mono. Le moteur est
 * chargé à la demande (aucun nœud audio dans les tests des fonctions pures).
 */
import { lufsOf } from './audioMeasure';

export async function trackInputLufs(trackId: string): Promise<number | null> {
  try {
    const { audioEngine } = await import('../engine/AudioEngine');
    const src = audioEngine.getTrackSourceAudio(trackId, 90);
    if (!src) return null;
    const [L, R] = src.channels;
    const m = new Float32Array(L.length);
    for (let i = 0; i < m.length; i++) m[i] = (L[i] + (R ? R[i] : L[i])) / 2;
    const v = lufsOf([m], src.sampleRate);
    return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  } catch {
    return null;
  }
}
