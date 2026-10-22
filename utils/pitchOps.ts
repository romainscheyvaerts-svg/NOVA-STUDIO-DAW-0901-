/**
 * Nova Pitch : gestes de hauteur sur les notes (logique pure, testée dans
 * tests/novaPitchOps.test.ts). Pas fin = 2 cents (1/50 de demi-ton) : les
 * hauteurs visées tombent sur une grille absolue de 2 cents.
 */
import type { PitchNote } from './pitchAnalysis';
import { NEUTRAL_EDIT, nearestScaleNote, nudgeEdit, targetCenter, type NoteEdit } from './pitchCorrect';
import { FINE_STEP, roundFine } from './pitchText';

export type Magnet = 'scale' | 'semi' | 'free';
export interface Key { root?: number; scale?: string }

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Pose la hauteur visée d'une note (MIDI fractionnaire). */
export const withTarget = (note: PitchNote, edit: NoteEdit | undefined, target: number): NoteEdit =>
  ({ ...(edit || NEUTRAL_EDIT), shift: r6(target - note.center) });

/** Hauteur visée d'après l'aimant : gamme, demi-ton ou libre (grille de 2 cents). */
export function magnetize(target: number, magnet: Magnet, key: Key): number {
  if (magnet === 'scale') return nearestScaleNote(target, key.root, key.scale);
  if (magnet === 'semi') return Math.round(target);
  return roundFine(target);
}

/**
 * Glisser vertical : chaque note part de sa hauteur au début du geste
 * (`base`) et monte de `delta` demi-tons, puis l'aimant s'applique.
 */
export function dragPitch(notes: PitchNote[], base: (NoteEdit | undefined)[], idx: number[], delta: number, magnet: Magnet, key: Key): (NoteEdit | undefined)[] {
  const out = base.slice();
  for (const i of idx) {
    const n = notes[i];
    if (!n) continue;
    const t = magnetize(targetCenter(n, base[i]) + delta, magnet, key);
    out[i] = withTarget(n, base[i], t);
  }
  return out;
}

/** Flèches : ±1 demi-ton (la note retombe sur un demi-ton juste) ou ±2 cents (grille absolue). */
export function nudge(note: PitchNote, edit: NoteEdit | undefined, dir: 1 | -1, fine: boolean): NoteEdit {
  const e = edit || NEUTRAL_EDIT;
  if (!fine) return nudgeEdit(note, e, dir, 'semitone');
  const now = targetCenter(note, e);
  const onGrid = Math.abs(now - roundFine(now)) < 1e-6;
  const t = onGrid ? roundFine(now) + dir * FINE_STEP : dir > 0 ? Math.ceil(now / FINE_STEP - 1e-9) * FINE_STEP : Math.floor(now / FINE_STEP + 1e-9) * FINE_STEP;
  return withTarget(note, e, r6(t));
}

/** Centre de hauteur : 0 % = comme chanté, 100 % = pile sur la note de la gamme la plus proche. */
export function withCenter(note: PitchNote, edit: NoteEdit | undefined, pct: number, key: Key): NoteEdit {
  const goal = nearestScaleNote(note.center, key.root, key.scale);
  const a = Math.max(0, Math.min(100, pct)) / 100;
  return { ...(edit || NEUTRAL_EDIT), shift: r6(a * (goal - note.center)) };
}

/** Centre de hauteur actuel (%), si la note n'a pas été déplacée ailleurs (sinon null). */
export function centerOf(note: PitchNote, edit: NoteEdit | undefined, key: Key): number | null {
  const goal = nearestScaleNote(note.center, key.root, key.scale);
  const span = goal - note.center;
  const s = edit?.shift || 0;
  if (Math.abs(span) < 1e-6) return Math.abs(s) < 1e-6 ? 100 : null;
  const a = s / span;
  return a >= -1e-6 && a <= 1 + 1e-6 ? Math.round(a * 100) : null;
}

/** « Corriger la sélection » : centre et dérive à X % en un geste (timing, formant et gain gardés). */
export function correctNotes(notes: PitchNote[], edits: (NoteEdit | undefined)[], idx: number[], key: Key, centerPct: number, driftPct: number): (NoteEdit | undefined)[] {
  const out = edits.slice();
  for (const i of idx) {
    const n = notes[i];
    if (!n) continue;
    const e = withCenter(n, edits[i], centerPct, key);
    out[i] = { ...e, drift: Math.max(0, Math.min(1, driftPct / 100)) };
  }
  return out;
}

/** Retouches quand la note k est coupée en deux (`offsetAtCut` : décalage de timing au point de coupe, s). */
export function editsAfterCut(edits: (NoteEdit | undefined)[], k: number, offsetAtCut: number): (NoteEdit | undefined)[] {
  const e = edits[k];
  const out = edits.slice();
  if (!e) { out.splice(k, 1, undefined, undefined); return out; }
  const left: NoteEdit = { ...e }, right: NoteEdit = { ...e };
  const off = Math.round(offsetAtCut * 1e5) / 1e5;
  if (Math.abs(off) >= 1e-5) { left.dt1 = off; right.dt0 = off; } else { delete left.dt1; delete right.dt0; }
  out.splice(k, 1, left, right);
  return out;
}

/** Retouches quand les notes k et k+1 sont fusionnées (réglages de la première, fin de la seconde). */
export function editsAfterJoin(edits: (NoteEdit | undefined)[], k: number): (NoteEdit | undefined)[] {
  const a = edits[k], b = edits[k + 1];
  const out = edits.slice();
  let merged: NoteEdit | undefined = a ? { ...a } : b && (b.dt1 !== undefined) ? { ...NEUTRAL_EDIT } : undefined;
  if (merged) {
    if (b?.dt1 !== undefined) merged.dt1 = b.dt1; else delete merged.dt1;
  }
  if (merged && !a && !b) merged = undefined;
  out.splice(k, 2, merged);
  return out;
}

/** Ensemble d'indices après insertion (+1) ou retrait (−1) d'une note à la place k. */
export function remapIndices(set: Set<number>, k: number, delta: 1 | -1): Set<number> {
  const out = new Set<number>();
  set.forEach(i => {
    if (delta > 0) { if (i < k) out.add(i); else if (i === k) { out.add(i); out.add(i + 1); } else out.add(i + 1); }
    else { if (i <= k) out.add(i); else out.add(i - 1); }
  });
  return out;
}
