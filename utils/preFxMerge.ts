import { Clip, DAWState, Track } from '../types';
import { mergePreFx, PreFxConflict, PRE_VOLUME, sourceOf } from './preFxEdits';

/**
 * Deux versions d'une même session (PC de l'ingé / tablette de l'artiste)
 * modifiées en parallèle : on garde la version de cet appareil et on y ajoute
 * les éditions pré-effet de l'autre sur les pistes gelées qui partagent la même
 * photo. Même passage modifié des deux côtés = conflit expliqué (cette version
 * gardée, l'autre à un clic).
 */

export interface SessionConflict extends PreFxConflict {
  trackId: string;
  trackName: string;
}

export interface SessionMerge {
  state: DAWState;
  conflicts: SessionConflict[];
  /** Pistes dont des éditions de l'autre version ont été reprises. */
  mergedTrackIds: string[];
  /** Pistes présentes seulement dans l'autre version (ajoutées). */
  addedTrackIds: string[];
}

const preVolPoints = (t: Track) => (t.automationLanes || []).find(l => l.parameterName === PRE_VOLUME)?.points || [];
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mergeSessionEdits(mine: DAWState, theirs: DAWState): SessionMerge {
  const conflicts: SessionConflict[] = [];
  const mergedTrackIds: string[] = [];
  const tracks: Track[] = mine.tracks.map(t => {
    const o = theirs.tracks.find(x => x.id === t.id);
    const base = t.freezeBase;
    if (!o || !base || !o.freezeBase || o.freezeBase.renderId !== base.renderId) return t;
    const m = mergePreFx(base, t.clips || [], o.clips || []);
    m.conflicts.forEach(c => conflicts.push({ ...c, trackId: t.id, trackName: t.name }));
    let next: Track = { ...t, clips: m.clips };
    // Volume avant effets : repris de l'autre version s'il n'a bougé que là-bas.
    const baseVol = base.preVolume || [];
    const mineVol = preVolPoints(t);
    const theirVol = preVolPoints(o);
    const volTaken = !sameJson(theirVol, baseVol) && sameJson(mineVol, baseVol);
    if (volTaken) {
      const lane = (o.automationLanes || []).find(l => l.parameterName === PRE_VOLUME)!;
      next = { ...next, automationLanes: [...(t.automationLanes || []).filter(l => l.parameterName !== PRE_VOLUME), lane] };
    }
    // Journal : les éditions venues d'ailleurs gardent leur auteur.
    if (o.preFxJournal && o.preFxJournal.renderId === base.renderId) {
      const known = new Set((t.preFxJournal?.ops || []).map(x => JSON.stringify([x.kind, x.baseClipId, x.at])));
      next.preFxJournal = { v: 1, renderId: base.renderId, ops: [...(t.preFxJournal?.ops || []), ...o.preFxJournal.ops.filter(x => !known.has(JSON.stringify([x.kind, x.baseClipId, x.at])))] };
    }
    if (m.takenTheirs > 0 || volTaken || m.clips.length !== (t.clips || []).length) mergedTrackIds.push(t.id);
    return next;
  });
  const addedTrackIds: string[] = [];
  theirs.tracks.forEach(o => {
    if (!mine.tracks.some(t => t.id === o.id)) { tracks.push(o); addedTrackIds.push(o.id); }
  });
  return { state: { ...mine, tracks }, conflicts, mergedTrackIds, addedTrackIds };
}

/** Prendre, pour un passage en conflit, la version de l'autre (ses morceaux de ce clip). */
export function takeTheirsFor(track: Track, theirs: Track, baseClipId: string): Clip[] {
  const base = track.freezeBase;
  if (!base) return track.clips;
  const keep = (track.clips || []).filter(c => sourceOf(c, base) !== baseClipId);
  const add = (theirs.clips || []).filter(c => sourceOf(c, base) === baseClipId);
  const ids = new Set(keep.map(c => c.id));
  return [...keep, ...add.map(c => (ids.has(c.id) ? { ...c, id: `${c.id}-v2` } : c))].sort((a, b) => a.start - b.start);
}
