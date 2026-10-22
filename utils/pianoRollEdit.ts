import { MidiNote } from '../types';
import { newNoteId } from './pianoRollPro';

/**
 * Piano roll pratique (22/10/2026) : gestes d'édition du quotidien, sans
 * interface (testés seuls, une seule écriture par geste dans le piano roll).
 * - Souder (FL : Glue) : les notes de même hauteur qui se suivent ne font plus qu'une ;
 * - Épaissir : la même note une octave au-dessus (ou au-dessous) ;
 * - Replier aux notes utilisées (FL : Fold) ;
 * - Quantification d'entrée de la prise (Live : Record Quantization) ;
 * - Cadrage de la vue sur la sélection (Live : Zoom to selection).
 */

type Ids = Set<string> | null | undefined;
const all = (ids: Ids) => !ids || ids.size === 0;
const byTime = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch;

/**
 * Souder : parmi les notes visées (sinon tout le clip), chaque suite de notes de même
 * hauteur qui se touchent ou se chevauchent (écart ≤ `gap` s) devient une seule note,
 * du début de la première à la fin de la dernière. La 1re garde sa vélocité et son glissé.
 */
export function glueNotes(notes: MidiNote[], ids: Ids, gap = 0.002): { notes: MidiNote[]; merged: number } {
  const target = notes.filter(n => all(ids) || ids!.has(n.id));
  const rest = notes.filter(n => !(all(ids) || ids!.has(n.id)));
  const byPitch = new Map<number, MidiNote[]>();
  target.forEach(n => { const l = byPitch.get(n.pitch) || []; l.push(n); byPitch.set(n.pitch, l); });
  const out: MidiNote[] = [];
  let merged = 0;
  byPitch.forEach(list => {
    list.sort(byTime);
    let cur: MidiNote | null = null;
    for (const n of list) {
      if (cur && n.start <= cur.start + cur.duration + gap) {
        cur = { ...cur, duration: Math.max(cur.start + cur.duration, n.start + n.duration) - cur.start };
        merged++;
      } else {
        if (cur) out.push(cur);
        cur = n;
      }
    }
    if (cur) out.push(cur);
  });
  return { notes: [...rest, ...out].sort(byTime), merged };
}

/** Outil Souder (un clic) : la note rejoint la note suivante de même hauteur, quel que soit l'écart. */
export function glueWithNext(notes: MidiNote[], id: string): { notes: MidiNote[]; ok: boolean } {
  const a = notes.find(n => n.id === id);
  if (!a) return { notes, ok: false };
  const next = notes.filter(n => n.id !== id && n.pitch === a.pitch && n.start > a.start + 1e-6).sort(byTime)[0];
  if (!next) return { notes, ok: false };
  const end = Math.max(a.start + a.duration, next.start + next.duration);
  return { notes: notes.filter(n => n.id !== next.id).map(n => (n.id === id ? { ...n, duration: end - n.start } : n)), ok: true };
}

/**
 * Épaissir : ajoute la même note `semis` demi-tons plus haut (12 = octave), un peu
 * moins forte (×0,85), sans doublon. Renvoie les notes ajoutées (nouvelle sélection).
 */
export function thicken(notes: MidiNote[], ids: Ids, semis = 12, makeId: () => string = newNoteId): { notes: MidiNote[]; added: MidiNote[] } {
  const target = notes.filter(n => all(ids) || ids!.has(n.id));
  const has = new Set(notes.map(n => `${n.pitch}@${Math.round(n.start * 1e4)}`));
  const added: MidiNote[] = [];
  for (const n of target) {
    const p = n.pitch + semis;
    if (p < 0 || p > 127) continue;
    const k = `${p}@${Math.round(n.start * 1e4)}`;
    if (has.has(k)) continue;
    has.add(k);
    const { slide, ...rest } = n; void slide;
    added.push({ ...rest, id: makeId(), pitch: p, velocity: Math.max(0.05, Math.min(1, n.velocity * 0.85)) });
  }
  return { notes: [...notes, ...added].sort(byTime), added };
}

/** Lignes du piano roll repliées aux hauteurs utilisées (de l'aigu au grave). Vide : rien à replier. */
export function usedRows(notes: MidiNote[], extra: number[] = []): number[] {
  return Array.from(new Set([...notes.map(n => n.pitch), ...extra])).filter(p => p >= 0 && p <= 127).sort((a, b) => b - a);
}

/**
 * Quantification d'entrée : chaque note jouée commence sur la grille (`snap` donne le temps
 * calé), sa longueur est gardée (au moins `minLen`). Les notes d'un accord restent ensemble.
 */
export function quantizeInput<T extends { start: number; duration: number }>(notes: T[], snap: (t: number) => number, minLen = 0.01): T[] {
  return notes.map(n => ({ ...n, start: Math.max(0, snap(n.start)), duration: Math.max(minLen, n.duration) }));
}

/** Cadre de la vue : zoom horizontal (px/s), hauteur de ligne et défilement pour voir tout le passage. */
export function fitView(p: {
  t0: number; t1: number; rowTop: number; rowBottom: number; viewW: number; viewH: number;
  zoomMin: number; zoomMax: number; rowMin: number; rowMax: number;
}): { zoomX: number; rowH: number; scrollLeft: number; scrollTop: number } {
  const span = Math.max(0.05, p.t1 - p.t0);
  const zoomX = Math.max(p.zoomMin, Math.min(p.zoomMax, (p.viewW * 0.86) / span));
  const nRows = Math.max(1, p.rowBottom - p.rowTop + 1);
  const rowH = Math.max(p.rowMin, Math.min(p.rowMax, Math.floor((p.viewH * 0.8) / nRows)));
  const scrollLeft = Math.max(0, p.t0 * zoomX - (p.viewW - span * zoomX) / 2);
  const scrollTop = Math.max(0, ((p.rowTop + p.rowBottom + 1) / 2) * rowH - p.viewH / 2);
  return { zoomX, rowH, scrollLeft, scrollTop };
}

/**
 * Suivre la lecture (pages, comme FL / Live) : nouveau défilement quand la tête sort
 * de la vue (ou va en sortir), sinon null.
 */
export function followScroll(headPx: number, scrollLeft: number, viewW: number, margin = 24): number | null {
  if (headPx < scrollLeft || headPx > scrollLeft + viewW - margin) return Math.max(0, headPx - margin);
  return null;
}
