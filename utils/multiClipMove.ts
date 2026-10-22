/**
 * Sélection de plusieurs clips glissée vers une autre piste (tour « édition et navigation »,
 * 22/10/2026). Avant, un groupe ne bougeait que dans le temps : pour passer les 4 prises d'un
 * couplet sur les pistes du dessous, il fallait les tirer une par une.
 *
 * Comme dans les DAW : toute la sélection se décale du même nombre de pistes que le clip tenu
 * par la souris, chaque clip garde sa piste relative, et rien ne bouge verticalement si un des
 * clips tomberait hors des pistes ou sur une piste d'un autre type (audio sur MIDI…).
 */
export interface MoveTrack { id: string; kind: string }
export interface MoveItem { trackId: string; clipId: string }

/** Décalage de pistes voulu : de la piste d'origine du clip tenu à la piste sous la souris. */
export function multiShiftFor(order: MoveTrack[], originTrackId: string, pointerTrackId: string): number {
  const from = order.findIndex(t => t.id === originTrackId);
  const to = order.findIndex(t => t.id === pointerTrackId);
  return from < 0 || to < 0 ? 0 : to - from;
}

/** Piste d'arrivée de chaque clip pour ce décalage, ou null s'il est impossible. */
export function planMultiShift(order: MoveTrack[], items: MoveItem[], shift: number): { shift: number; dest: Record<string, string> } | null {
  const dest: Record<string, string> = {};
  for (const it of items) {
    const i = order.findIndex(t => t.id === it.trackId);
    if (i < 0) { if (shift !== 0) return null; dest[it.clipId] = it.trackId; continue; }
    const d = order[i + shift];
    if (!d || d.kind !== order[i].kind) return null;
    dest[it.clipId] = d.id;
  }
  return { shift, dest };
}
