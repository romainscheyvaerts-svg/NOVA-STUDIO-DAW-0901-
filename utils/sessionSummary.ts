import { Track, TrackType } from '../types';
import { takeNumberOf } from './takes';

/**
 * Nombre de PRISES (pas de fragments) des pistes voix (audit F10) : le
 * nettoyage des blancs coupe une prise en morceaux (« Prise 1 · 1 », « · 2 »),
 * l'accueil annonçait alors « 2 prises » après une seule.
 */
export function countVoiceTakes(tracks: Track[]): number {
  const seen = new Set<string>();
  for (const t of tracks) {
    if (t.type !== TrackType.AUDIO || t.id === 'instrumental' || t.instrumentId) continue;
    for (const c of t.clips) {
      const n = takeNumberOf(c);
      if (n !== null) seen.add(`${t.id}:${n}`);
    }
  }
  return seen.size;
}
