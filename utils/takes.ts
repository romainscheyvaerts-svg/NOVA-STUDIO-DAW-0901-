import { AIAction, Track } from '../types';

/**
 * Prises d'une piste voix (« Prise 1 », « Prise 2 · 3 »…). Une nouvelle prise
 * coupe (mute) l'ancienne qu'elle recouvre : ici on retrouve chaque prise pour
 * en écouter une et garder la meilleure, comme le « comping » d'un vrai DAW.
 */
export interface TakeInfo {
  n: number;
  clipIds: string[];
  start: number;
  end: number;
  active: boolean;
}

/** Numéro de prise d'un clip : champ dédié, sinon le nom (anciens projets). */
export function takeNumberOf(c: { takeNumber?: number; name?: string }): number | null {
  if (typeof c.takeNumber === 'number' && c.takeNumber > 0) return c.takeNumber;
  const m = /^Prise (\d+)/.exec(c.name || '');
  return m ? parseInt(m[1], 10) : null;
}

export function listTakes(track: Track): TakeInfo[] {
  const map = new Map<number, TakeInfo>();
  for (const c of track.clips) {
    const n = takeNumberOf(c);
    if (n === null) continue;
    const t = map.get(n) || { n, clipIds: [], start: Infinity, end: 0, active: false };
    t.clipIds.push(c.id);
    t.start = Math.min(t.start, c.start);
    t.end = Math.max(t.end, c.start + c.duration);
    if (!c.isMuted) t.active = true;
    map.set(n, t);
  }
  return Array.from(map.values()).sort((a, b) => a.n - b.n);
}

/** Actions qui rendent la prise n audible et coupent les autres prises qui la recouvrent. */
export function selectTakeActions(track: Track, n: number): AIAction[] | null {
  const takes = listTakes(track);
  const chosen = takes.find(t => t.n === n);
  if (!chosen) return null;
  const actions: AIAction[] = [];
  for (const t of takes) {
    const overlaps = t.start < chosen.end && t.end > chosen.start;
    const wantMuted = t.n === n ? false : overlaps ? true : null;
    if (wantMuted === null) continue;
    for (const id of t.clipIds) {
      const clip = track.clips.find(c => c.id === id);
      if (clip && !!clip.isMuted !== wantMuted) {
        actions.push({ action: 'MUTE_CLIP', payload: { trackId: track.id, clipId: id, isMuted: wantMuted } });
      }
    }
  }
  return actions;
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
