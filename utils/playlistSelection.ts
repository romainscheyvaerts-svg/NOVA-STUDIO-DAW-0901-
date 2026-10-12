import type { Clip, Track, TrackPlaylist } from '../types';
import { nextPlaylistName, playlistsOf } from './trackPlaylists';
import { extractRange, removeRange } from './timeSelection';

/**
 * Copier / déplacer la sélection vers une nouvelle playlist (Pro Tools :
 * Édition › Copier la sélection vers › Nouvelle playlist ; « Move Selection
 * to New Playlist »). Suite de utils/trackPlaylists.
 *
 * Geste type : dans la prise, l'ingé garde un bon passage (« la 2e phrase est
 * parfaite ») dans une version à part, pour le comp ou pour le retrouver après
 * un nettoyage. On continue d'entendre la même version (comme Pro Tools) ; la
 * nouvelle playlist contient seulement la plage, à la même place dans le temps.
 *  - copier : la version qu'on entend ne change pas ;
 *  - déplacer : la plage est retirée de la version qu'on entend (un blanc).
 *
 * Module pur (tests/playlistSelection.test.ts).
 */

let seq = 0;

export interface SelectionPlaylistResult {
  track: Track;
  /** Nouvelle playlist (null : rien dans la plage). */
  id: string | null;
  name: string;
  /** Clips (morceaux) copiés. */
  clips: number;
}

/** Clips de la piste qui touchent la plage [s, e]. */
export const clipsInRange = (clips: Clip[], s: number, e: number): Clip[] =>
  clips.filter(c => c.start < e - 1e-6 && c.start + c.duration > s + 1e-6);

export function selectionToNewPlaylist(
  t: Track, start: number, end: number,
  opts: { move?: boolean; name?: string; stamp?: string; now?: number } = {},
): SelectionPlaylistResult {
  const s = Math.max(0, Math.min(start, end)), e = Math.max(start, end);
  const stamp = opts.stamp ?? Date.now().toString(36);
  const gen = (id: string) => `${id}-s${stamp}${(seq++).toString(36)}`;
  const clips = t.clips || [];
  if (e - s < 1e-4 || !clipsInRange(clips, s, e).length) return { track: t, id: null, name: '', clips: 0 };
  // Morceaux de la plage, remis à leur place dans le temps (nouveaux identifiants, même son).
  const piece = extractRange(clips, s, e, gen).map(c => ({ ...c, id: gen(c.id), start: c.start + s }));
  const { list, activeId } = playlistsOf(t);
  const name = (opts.name || '').trim() || nextPlaylistName(t.name, list.map(p => p.name));
  const id = `pl-${stamp}${(seq++).toString(36)}`;
  const entry: TrackPlaylist = { id, name, clips: piece, createdAt: opts.now ?? Date.now() };
  // La liste existe désormais (l'active y garde son entrée, sans clips : ils jouent depuis track.clips).
  const nextList = [...list.map(p => (p.id === activeId ? { ...p, clips: [] } : p)), entry];
  const track: Track = {
    ...t,
    playlists: nextList,
    activePlaylistId: activeId,
    // Maj+← (préréglage Pro Tools) ou « Playlist d'avant » : écouter tout de suite la nouvelle.
    recentPlaylistId: id,
    clips: opts.move ? removeRange(clips, s, e, gen) : clips,
  };
  return { track, id, name, clips: piece.length };
}
