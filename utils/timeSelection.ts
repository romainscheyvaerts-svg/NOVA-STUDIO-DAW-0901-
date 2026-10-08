import { Clip, MidiNote, TrackType } from '../types';
import { splitCc } from './midiCc';

/**
 * Sélection de plage de temps (Sélecteur / Smart Tool de Pro Tools) et
 * opérations sur la plage : couper, copier, coller, supprimer, dupliquer,
 * séparer, consolider. Logique pure sur des listes de clips par piste
 * (Record<trackId, Clip[]>) ; hooks/useEditCommands applique le résultat à
 * l'état du projet en une seule étape d'annulation.
 */

export interface TimeSelection {
  start: number;
  end: number;
  /** Pistes couvertes, dans l'ordre d'affichage. */
  trackIds: string[];
}

export type ClipsByTrack = Record<string, Clip[]>;

/** Presse-papiers de plage : un couloir par piste copiée, temps relatifs au début de la plage. */
export interface RangeClipboard {
  length: number;
  lanes: Clip[][];
  /** Pistes d'origine (même ordre que lanes). */
  trackIds: string[];
}

export type IdGen = (base: string) => string;

/** Fabrique d'identifiants uniques pour une opération. */
export function idGenerator(tag: string): IdGen {
  let n = 0;
  const stamp = Date.now().toString(36);
  return (base: string) => `${base.replace(/~.*$/, '')}-${tag}${stamp}${(n++).toString(36)}`;
}

export const selLength = (s: TimeSelection | null | undefined): number => (s ? Math.max(0, s.end - s.start) : 0);

/** Plage normalisée (début < fin), null si c'est un simple point d'insertion. */
export function makeSelection(a: number, b: number, trackIds: string[]): TimeSelection | null {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.max(0, Math.max(a, b));
  if (end - start < 1e-4 || trackIds.length === 0) return null;
  return { start, end, trackIds: [...trackIds] };
}

/** Pistes entre deux pistes (glisser vertical du Sélecteur), dans l'ordre affiché. */
export function tracksBetween(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a), j = order.indexOf(b);
  if (i < 0 && j < 0) return [];
  if (i < 0) return [b];
  if (j < 0) return [a];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Décale une sélection (nudge) sans passer sous zéro. */
export function shiftSelection(s: TimeSelection, delta: number): TimeSelection {
  const d = Math.max(-s.start, delta);
  return { ...s, start: s.start + d, end: s.end + d };
}

const end = (c: Clip) => c.start + c.duration;

function splitNotes(notes: MidiNote[] | undefined, rel: number): [MidiNote[], MidiNote[]] {
  const a: MidiNote[] = [], b: MidiNote[] = [];
  for (const n of notes || []) {
    if (n.start < rel) a.push(n.start + n.duration > rel ? { ...n, duration: rel - n.start } : n);
    else b.push({ ...n, start: n.start - rel });
  }
  return [a, b];
}

/**
 * Coupe un clip à l'instant t (Séparer / Ctrl+E de Pro Tools). Les fondus
 * qui ne tiennent plus dans une moitié sont raccourcis, la coupe elle-même
 * n'a pas de fondu (l'audio est continu). MIDI : les notes sont réparties.
 */
export function splitClipAt(c: Clip, t: number, newId: string): [Clip, Clip] | null {
  if (!(t > c.start + 1e-6 && t < end(c) - 1e-6)) return null;
  const d1 = t - c.start;
  const d2 = end(c) - t;
  const a: Clip = { ...c, duration: d1, fadeIn: Math.min(c.fadeIn || 0, d1), fadeOut: 0 };
  const b: Clip = { ...c, id: newId, start: t, duration: d2, offset: (c.offset || 0) + d1, fadeIn: 0, fadeOut: Math.min(c.fadeOut || 0, d2) };
  delete a.fadeOutCurve;
  delete b.fadeInCurve;
  if (c.type === TrackType.MIDI || c.notes) {
    const [na, nb] = splitNotes(c.notes, d1);
    a.notes = na;
    b.notes = nb;
    b.offset = c.offset || 0;
    // Contrôleurs (R16) : la moitié droite repart avec la valeur tenue à la coupe.
    if (c.cc) {
      const [ca, cb] = splitCc(c.cc, d1);
      if (ca) a.cc = ca; else delete a.cc;
      if (cb) b.cc = cb; else delete b.cc;
    }
  }
  return [a, b];
}

/** Coupe tous les clips traversés par l'un des instants donnés. */
export function splitClipsAt(clips: Clip[], times: number[], gen: IdGen): Clip[] {
  let out = [...clips];
  for (const t of times) {
    const next: Clip[] = [];
    for (const c of out) {
      const parts = splitClipAt(c, t, gen(c.id));
      if (parts) next.push(parts[0], parts[1]); else next.push(c);
    }
    out = next;
  }
  return out;
}

const inside = (c: Clip, s: number, e: number) => c.start >= s - 1e-6 && end(c) <= e + 1e-6;

/** Supprime le contenu de la plage (laisse un blanc, comme Effacer dans Pro Tools en mode Slip). */
export function removeRange(clips: Clip[], s: number, e: number, gen: IdGen): Clip[] {
  return splitClipsAt(clips, [s, e], gen).filter(c => !inside(c, s, e));
}

/** Contenu de la plage, recalé sur 0 (début de la plage). */
export function extractRange(clips: Clip[], s: number, e: number, gen: IdGen): Clip[] {
  return splitClipsAt(clips.filter(c => c.start < e && end(c) > s), [s, e], gen)
    .filter(c => inside(c, s, e))
    .map(c => ({ ...c, start: c.start - s }));
}

/** Copie la plage des pistes sélectionnées. */
export function copyRange(byTrack: ClipsByTrack, sel: TimeSelection, gen: IdGen): RangeClipboard {
  return {
    length: selLength(sel),
    trackIds: [...sel.trackIds],
    lanes: sel.trackIds.map(id => extractRange(byTrack[id] || [], sel.start, sel.end, gen)),
  };
}

/** Couper : copie puis supprime la plage. */
export function cutRange(byTrack: ClipsByTrack, sel: TimeSelection, gen: IdGen): { clips: ClipsByTrack; clipboard: RangeClipboard } {
  const clipboard = copyRange(byTrack, sel, gen);
  const clips: ClipsByTrack = {};
  for (const id of sel.trackIds) clips[id] = removeRange(byTrack[id] || [], sel.start, sel.end, gen);
  return { clips, clipboard };
}

/** Supprimer la plage (sans copier). */
export function deleteRange(byTrack: ClipsByTrack, sel: TimeSelection, gen: IdGen): ClipsByTrack {
  const clips: ClipsByTrack = {};
  for (const id of sel.trackIds) clips[id] = removeRange(byTrack[id] || [], sel.start, sel.end, gen);
  return clips;
}

/**
 * Coller la plage à `at` : comme Pro Tools, le collage remplace ce qui occupait
 * la zone collée. Couloir i → piste cible i (si moins de pistes cibles que de
 * couloirs, les couloirs en trop sont ignorés).
 */
export function pasteRange(byTrack: ClipsByTrack, cb: RangeClipboard, at: number, targetTrackIds: string[], gen: IdGen): ClipsByTrack {
  const clips: ClipsByTrack = {};
  const s = Math.max(0, at);
  cb.lanes.forEach((lane, i) => {
    const id = targetTrackIds[i];
    if (!id) return;
    const kept = removeRange(byTrack[id] || [], s, s + cb.length, gen);
    clips[id] = [...kept, ...lane.map(c => ({ ...c, id: gen(c.id), start: c.start + s }))];
  });
  return clips;
}

/** Dupliquer : la plage est recopiée juste après elle-même ; la sélection suit la copie. */
export function duplicateRange(byTrack: ClipsByTrack, sel: TimeSelection, gen: IdGen): { clips: ClipsByTrack; selection: TimeSelection } {
  const cb = copyRange(byTrack, sel, gen);
  const clips = pasteRange(byTrack, cb, sel.end, sel.trackIds, gen);
  return { clips, selection: { ...sel, start: sel.end, end: sel.end + cb.length } };
}

/** Séparer aux bords de la plage (Ctrl+E de Pro Tools) ; point d'insertion = coupe à cet instant. */
export function separateAtSelection(byTrack: ClipsByTrack, sel: TimeSelection, gen: IdGen): ClipsByTrack {
  const clips: ClipsByTrack = {};
  const times = sel.end - sel.start > 1e-4 ? [sel.start, sel.end] : [sel.start];
  for (const id of sel.trackIds) clips[id] = splitClipsAt(byTrack[id] || [], times, gen);
  return clips;
}

/** Morceaux audio audibles d'une plage, à mixer pour la consolidation. */
export interface ConsolidatePiece { clip: Clip; at: number; from: number; to: number }

/**
 * Plan de consolidation d'une piste : les morceaux de clips audio non mutés qui
 * tombent dans la plage (positions relatives au début de la plage, et position
 * de lecture dans le clip). Les clips mutés (anciennes prises) restent en place.
 */
export function consolidatePlan(clips: Clip[], s: number, e: number): ConsolidatePiece[] {
  return clips
    .filter(c => !c.isMuted && c.type !== TrackType.MIDI && !c.notes && c.start < e && end(c) > s)
    .map(c => {
      const a = Math.max(s, c.start);
      const b = Math.min(e, end(c));
      return { clip: c, at: a - s, from: a - c.start, to: b - c.start };
    })
    .filter(p => p.to - p.from > 1e-4);
}

/**
 * Remplace les clips audibles de la plage par le clip consolidé (les clips qui
 * débordent sont coupés aux bords ; les clips mutés ne bougent pas).
 */
export function replaceWithConsolidated(clips: Clip[], s: number, e: number, consolidated: Clip, gen: IdGen): Clip[] {
  const audible = clips.filter(c => !c.isMuted && c.type !== TrackType.MIDI && !c.notes);
  const others = clips.filter(c => !audible.includes(c));
  const kept = removeRange(audible, s, e, gen);
  return [...others, ...kept, consolidated];
}
