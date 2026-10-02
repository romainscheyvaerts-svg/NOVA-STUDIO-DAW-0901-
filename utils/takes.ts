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

// --- Comping par zone ------------------------------------------------------------
//
// Comme les « take lanes » d'Ableton / les playlists de Pro Tools : on garde la
// prise n seulement dans une zone (une partie du morceau, la boucle…). Les clips
// des prises sont coupés aux bords de la zone (fondus de 5 ms, pas de clic) ;
// dans la zone, seule la prise n reste audible ; hors zone, rien ne change.
// Les clips coupés gardent leur numéro de prise et leur ancrage de gel.

export interface CompZone { start: number; end: number; label: string }

const EDGE_FADE = 0.005;

export function compTakeInZone(track: Track, n: number, zone: CompZone): Track['clips'] {
  const { start: a, end: b } = zone;
  if (!(b > a)) return track.clips;
  const out: Track['clips'] = [];
  let k = 0;
  for (const c of track.clips) {
    const tn = takeNumberOf(c);
    const cEnd = c.start + c.duration;
    if (tn === null || cEnd <= a || c.start >= b) { out.push(c); continue; }
    const off = c.offset || 0;
    const piece = (from: number, to: number, inside: boolean) => {
      const isFirst = from <= c.start + 1e-9;
      const isLast = to >= cEnd - 1e-9;
      out.push({
        ...c,
        id: isFirst && isLast ? c.id : `${c.id}-c${Date.now().toString(36)}${k++}`,
        start: from,
        offset: off + (from - c.start),
        duration: to - from,
        fadeIn: isFirst ? c.fadeIn : EDGE_FADE,
        fadeOut: isLast ? c.fadeOut : EDGE_FADE,
        isMuted: inside ? tn !== n : c.isMuted,
      });
    };
    if (c.start < a) piece(c.start, a, false);
    piece(Math.max(a, c.start), Math.min(b, cEnd), true);
    if (cEnd > b) piece(b, cEnd, false);
  }
  return out;
}

/** Prise audible dans la zone (null : aucune ou plusieurs). */
export function activeTakeInZone(track: Track, zone: CompZone): number | null {
  const set = new Set<number>();
  for (const c of track.clips) {
    const tn = takeNumberOf(c);
    if (tn === null || c.isMuted) continue;
    if (c.start < zone.end && c.start + c.duration > zone.start) set.add(tn);
  }
  return set.size === 1 ? Array.from(set)[0] : null;
}
