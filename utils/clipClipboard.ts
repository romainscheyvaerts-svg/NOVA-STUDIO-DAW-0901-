import type { Clip, Track } from '../types';

/**
 * Presse-papiers de PLUSIEURS clips (Ctrl+C / Ctrl+X / Ctrl+V), tour « édition et navigation »
 * 22/10/2026. Avant : Ctrl+C sur 4 clips sélectionnés n'en copiait qu'un ; Ctrl+X les supprimait
 * tous mais n'en gardait qu'un (le dernier) : Ctrl+V n'en rendait qu'un, les 3 autres étaient
 * perdus (sauf Ctrl+Z).
 *
 * Comme dans les DAW : les clips gardent leurs écarts dans le temps et leurs pistes relatives ;
 * le collage part de la tête de lecture sur la piste choisie (la plus haute des pistes copiées y
 * tombe). Un clip dont la piste d'arrivée n'existe pas ou n'est pas du même type reste sur la
 * piste choisie.
 */
export interface ClipboardEntry { clip: Clip; dt: number; dTrack: number; kind: string }

/** Pistes dans l'ordre de l'écran (sans le master ni les retours). */
const editable = (tracks: Track[]) => tracks.filter(t => t.id !== 'master' && String(t.type) !== 'SEND');

export function buildClipboard(tracks: Track[], items: { trackId: string; clipId: string }[]): ClipboardEntry[] {
  const order = editable(tracks);
  const found: { clip: Clip; row: number; kind: string }[] = [];
  for (const it of items) {
    const row = order.findIndex(t => t.id === it.trackId);
    const clip = row >= 0 ? order[row].clips.find(c => c.id === it.clipId) : undefined;
    if (clip) found.push({ clip, row, kind: String(order[row].type) });
  }
  if (!found.length) return [];
  const t0 = Math.min(...found.map(f => f.clip.start));
  const r0 = Math.min(...found.map(f => f.row));
  return found.map(f => ({ clip: { ...f.clip }, dt: f.clip.start - t0, dTrack: f.row - r0, kind: f.kind }));
}

/** Où va chaque clip collé : piste d'arrivée et début. */
export function planPaste(tracks: Track[], entries: ClipboardEntry[], targetTrackId: string, time: number): { trackId: string; clip: Clip; start: number }[] {
  const order = editable(tracks);
  const base = order.findIndex(t => t.id === targetTrackId);
  return entries.map(e => {
    const dest = base >= 0 ? order[base + e.dTrack] : undefined;
    const trackId = dest && String(dest.type) === e.kind ? dest.id : targetTrackId;
    return { trackId, clip: e.clip, start: Math.max(0, time + e.dt) };
  });
}
