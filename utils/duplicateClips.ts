import type { Clip } from '../types';

/**
 * Dupliquer (Ctrl+D) des clips, comme dans les DAW (tour « édition et navigation », 22/10/2026) :
 * - la copie se pose JUSTE après (avant : 0,1 s de trou, une boucle de beat dupliquée sortait
 *   du temps) ;
 * - plusieurs clips sélectionnés partent en BLOC, après la fin de la sélection, en gardant leurs
 *   écarts (avant : chacun après lui-même, la copie du 1er tombait sur le 2e) ;
 * - les copies deviennent la sélection : Ctrl+D encore les enchaîne (avant : 3 × Ctrl+D posait
 *   3 copies au même endroit).
 */
export interface DuplicateStep { trackId: string; clipId: string; start: number; id: string }

let seq = 0;
export const newDuplicateId = (): string => `clip-dup-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function planDuplicate(targets: { trackId: string; clip: Pick<Clip, 'id' | 'start' | 'duration'> }[], makeId: () => string = newDuplicateId): DuplicateStep[] {
  if (!targets.length) return [];
  const start = Math.min(...targets.map(t => t.clip.start));
  const end = Math.max(...targets.map(t => t.clip.start + t.clip.duration));
  const span = end - start;
  return targets.map(t => ({ trackId: t.trackId, clipId: t.clip.id, start: t.clip.start + span, id: makeId() }));
}
