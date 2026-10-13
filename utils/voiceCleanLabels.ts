/**
 * Lot 1 « Voix propre » : ce dont le menu du clip, la barre du téléphone et la palette
 * ont besoin, sans charger le moteur (utils/voiceClean, chargé avec la fenêtre).
 */
import type { Clip } from '../types';

export const CLEAN_MENU_LABEL = '✨ Nettoyer la voix…';

export const CLEAN_TOOLTIP =
  'Retire le bruit de fond (ventilo, clim, souffle, rue) et égalise le niveau de la voix en un clic, et la réverbe de la pièce dans Nova Studio pour Windows. Marche sur le site et au téléphone ; l’original est gardé.';

/**
 * Clip visé par la palette (Ctrl+K) : le clip sélectionné, sinon celui de la piste
 * sélectionnée sous la tête de lecture, sinon le premier clip audio de cette piste.
 */
export function pickCleanTarget(
  tracks: { id: string; clips: Pick<Clip, 'id' | 'start' | 'duration' | 'notes' | 'type'>[] }[],
  o: { clipIds: string[]; trackId?: string | null; playhead?: number },
): { trackId: string; clipId: string } | null {
  const audio = (c: Pick<Clip, 'notes' | 'type'>) => !c.notes && String(c.type) !== 'MIDI';
  for (const t of tracks) for (const c of t.clips) if (o.clipIds.includes(c.id) && audio(c)) return { trackId: t.id, clipId: c.id };
  const tr = tracks.find(t => t.id === o.trackId);
  if (!tr) return null;
  const clips = tr.clips.filter(audio);
  const ph = o.playhead ?? -1;
  const under = clips.find(c => ph >= c.start && ph < c.start + c.duration);
  const c = under || clips[0];
  return c ? { trackId: tr.id, clipId: c.id } : null;
}
