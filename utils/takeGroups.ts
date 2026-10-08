import type { Clip, TakeMeta, Track } from '../types';
import { compSwipe, CompResult } from './comping';
import { deleteTake, keepTake } from './playlists';

/**
 * R14 · Groupes de prises (take groups) : les prises d'un même passage enregistré sur
 * plusieurs pistes (batterie, duo, 2 micros) portent le même TakeMeta.group. Elles se
 * coupent et se compent ensemble, comme les playlists d'un groupe d'édition dans Pro
 * Tools : garder le 2e couplet de la prise 3 sur la voix garde aussi le 2e couplet de
 * la prise 3 sur le micro d'ambiance — la phase entre les micros est préservée.
 *
 * Le lien suit les groupes R12 : « Suspendre les groupes » (Ctrl+Maj+G) et Maj+Ctrl
 * pendant le geste le coupent (la piste seule).
 */

let seq = 0;
export const newTakeGroupId = () => `tg-${Date.now().toString(36)}${(seq++).toString(36)}`;

type MetaTrack = Pick<Track, 'id' | 'takeMeta'>;

export const takeGroupOf = (track: MetaTrack | undefined, n: number): string | undefined =>
  (track?.takeMeta as TakeMeta[] | undefined)?.find(m => m.n === n)?.group;

/** Prises du même passage sur les AUTRES pistes : [{ trackId, n }]. */
export function takeGroupMates(tracks: MetaTrack[], trackId: string, n: number): { trackId: string; n: number }[] {
  const g = takeGroupOf(tracks.find(t => t.id === trackId), n);
  if (!g) return [];
  const out: { trackId: string; n: number }[] = [];
  for (const t of tracks) {
    if (t.id === trackId) continue;
    const m = (t.takeMeta as TakeMeta[] | undefined)?.find(x => x.group === g);
    if (m) out.push({ trackId: t.id, n: m.n });
  }
  return out;
}

/** Le lien du groupe de prises est-il actif pour ce geste ? (groupes suspendus / Maj+Ctrl) */
export const takeGroupLinked = (o: { suspended?: boolean; invert?: boolean }): boolean => !o.suspended && !o.invert;

/** Comp (balayage d'un passage) appliqué à la prise et à ses jumelles : nouveaux clips par piste. */
export function compTakeGroup(tracks: (MetaTrack & Pick<Track, 'clips'>)[], trackId: string, n: number, a: number, b: number, linked = true):
  { results: Map<string, CompResult>; mates: number } {
  const results = new Map<string, CompResult>();
  const self = tracks.find(t => t.id === trackId);
  if (!self) return { results, mates: 0 };
  results.set(trackId, compSwipe(self.clips as Clip[], n, a, b));
  let mates = 0;
  if (linked) {
    for (const m of takeGroupMates(tracks, trackId, n)) {
      const t = tracks.find(x => x.id === m.trackId);
      if (!t) continue;
      const r = compSwipe(t.clips as Clip[], m.n, a, b);
      if (r.changed) { results.set(m.trackId, r); mates++; }
    }
  }
  return { results, mates };
}

/** « Garder cette prise en entier » sur la prise et ses jumelles. */
export function keepTakeGroup(tracks: (MetaTrack & Pick<Track, 'clips'>)[], trackId: string, n: number, linked = true): Map<string, Clip[]> {
  const out = new Map<string, Clip[]>();
  const self = tracks.find(t => t.id === trackId);
  if (!self) return out;
  out.set(trackId, keepTake(self.clips as Clip[], n));
  if (linked) for (const m of takeGroupMates(tracks, trackId, n)) {
    const t = tracks.find(x => x.id === m.trackId);
    if (t) out.set(m.trackId, keepTake(t.clips as Clip[], m.n));
  }
  return out;
}

/** Supprimer la prise et ses jumelles (même passage). */
export function deleteTakeGroup(tracks: (MetaTrack & Pick<Track, 'clips'>)[], trackId: string, n: number, linked = true) {
  const out = new Map<string, ReturnType<typeof deleteTake> & { n: number }>();
  const self = tracks.find(t => t.id === trackId);
  if (!self) return out;
  out.set(trackId, { ...deleteTake(self, n), n });
  if (linked) for (const m of takeGroupMates(tracks, trackId, n)) {
    const t = tracks.find(x => x.id === m.trackId);
    if (t) out.set(m.trackId, { ...deleteTake(t, m.n), n: m.n });
  }
  return out;
}

/**
 * Coupe à la tête de lecture : pistes dont le clip joué à `at` appartient au même
 * passage que celui de `trackId` (elles se coupent ensemble).
 */
export function takeGroupTracksAt(tracks: (MetaTrack & Pick<Track, 'clips'>)[], trackId: string, at: number): string[] {
  const self = tracks.find(t => t.id === trackId);
  if (!self) return [];
  const playing = (t: Pick<Track, 'clips'>) => (t.clips as Clip[]).find(c => !c.isMuted && c.start <= at && at < c.start + c.duration && typeof c.takeNumber === 'number');
  const c = playing(self);
  const g = c ? takeGroupOf(self, c.takeNumber!) : undefined;
  if (!g) return [];
  return tracks.filter(t => t.id !== trackId && (t.takeMeta as TakeMeta[] | undefined)?.some(m => m.group === g)).map(t => t.id);
}
