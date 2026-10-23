/**
 * Nova Pitch · mode Élastique : allonger, raccourcir, déplacer des notes.
 *
 * Logique pure (tests/novaPitchElastic.test.ts). Les notes restent dans
 * l'ordre, ne se chevauchent jamais et ne laissent pas de trou :
 *  - deux notes collées (voix liée, pas de silence entre elles) partagent leur
 *    bord : il bouge pour les deux ;
 *  - le blanc entre deux notes garde ses consonnes (« s », « t ») à leur
 *    vitesse : seule sa partie calme (silence) peut se resserrer ou s'allonger ;
 *    s'il n'y en a pas, la note voisine s'adapte ;
 *  - option « décaler la suite » : tout ce qui suit avance ou recule (la fin du
 *    clip aussi) ;
 *  - rapport d'étirement d'une note : ×0,25 à ×4 (et jamais moins de 20 ms).
 * Les temps sont en secondes depuis le début de la région ; `dt0` / `dt1`
 * sont les décalages du début / de la fin de chaque note (NoteEdit).
 */
import type { PitchNote } from '../../utils/pitchAnalysis';
import { NEUTRAL_EDIT, type NoteEdit } from '../../utils/pitchCorrect';

export const MIN_FACTOR = 0.25;
export const MAX_FACTOR = 4;
export const MIN_NOTE_SEC = 0.02;
/** Silence minimal pour qu'un blanc puisse changer de durée (s). */
const QUIET_MIN = 0.01;
/** Marge gardée dans un silence resserré (s). */
const QUIET_KEEP = 0.005;

export interface ElasticCtx {
  notes: PitchNote[];
  edits: (NoteEdit | undefined)[];
  /** Plus long silence (s) dans le blanc [a, b] (temps source). */
  quietLen: (a: number, b: number) => number;
  /** Durée de la région (s). */
  regionLen: number;
  /** Fin du son rendu décalée (s). */
  extend: number;
  ripple?: boolean;
}

export interface ElasticResult { edits: (NoteEdit | undefined)[]; extend: number }

const ds = (c: ElasticCtx, k: number) => c.notes[k].start + (c.edits[k]?.dt0 || 0);
const de = (c: ElasticCtx, k: number) => c.notes[k].end + (c.edits[k]?.dt1 || 0);
const origLen = (c: ElasticCtx, k: number) => c.notes[k].end - c.notes[k].start;
const minLen = (c: ElasticCtx, k: number) => Math.max(MIN_NOTE_SEC, MIN_FACTOR * origLen(c, k));
const maxLen = (c: ElasticCtx, k: number) => MAX_FACTOR * origLen(c, k);
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Bornes de la durée rendue du blanc avant la note k (k = notes.length : blanc final). */
function gapLimits(c: ElasticCtx, k: number): { min: number; max: number } {
  const a = k > 0 ? c.notes[k - 1].end : 0;
  const b = k < c.notes.length ? c.notes[k].start : c.regionLen;
  const src = Math.max(0, b - a);
  const q = src > 0 ? c.quietLen(a, b) : 0;
  if (q >= QUIET_MIN) return { min: Math.max(0, src - q + QUIET_KEEP), max: Infinity };
  return { min: src, max: src };
}

function withTiming(e: NoteEdit | undefined, dt0: number, dt1: number): NoteEdit | undefined {
  const base = { ...(e || NEUTRAL_EDIT) };
  const a = r5(dt0), b = r5(dt1);
  if (Math.abs(a) >= 1e-5) base.dt0 = a; else delete base.dt0;
  if (Math.abs(b) >= 1e-5) base.dt1 = b; else delete base.dt1;
  return base;
}

/** Copie des décalages (début, fin) rendus de chaque note. */
const spans = (c: ElasticCtx) => c.notes.map((_, k) => [ds(c, k), de(c, k)] as [number, number]);

function result(c: ElasticCtx, sp: [number, number][], extend: number): ElasticResult {
  const edits = c.edits.slice();
  sp.forEach(([a, b], k) => {
    const n = c.notes[k];
    if (Math.abs(a - ds(c, k)) < 1e-9 && Math.abs(b - de(c, k)) < 1e-9) return;
    edits[k] = withTiming(c.edits[k], a - n.start, b - n.end);
  });
  return { edits, extend: r5(extend) };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Bouger le bord droit (fin) de la note k vers `t` (s, temps rendu).
 * Avec « décaler la suite » : tout ce qui suit glisse d'autant.
 */
export function stretchEnd(c: ElasticCtx, k: number, t: number): ElasticResult {
  const sp = spans(c);
  const [a, b] = sp[k];
  let end = clamp(t, a + minLen(c, k), a + maxLen(c, k));
  const N = c.notes.length;
  if (c.ripple) {
    const d = end - b;
    for (let j = k + 1; j < N; j++) { sp[j][0] += d; sp[j][1] += d; }
    sp[k][1] = end;
    return result(c, sp, c.extend + d);
  }
  const g = gapLimits(c, k + 1);
  if (k + 1 < N) {
    const [na, nb] = sp[k + 1];
    // La note suivante garde sa fin ; son début suit le blanc (bornes du blanc et de sa durée).
    const hiEnd = nb - minLen(c, k + 1) - g.min;
    const loEnd = g.max === Infinity ? -Infinity : nb - maxLen(c, k + 1) - g.max;
    end = clamp(end, Math.max(a + minLen(c, k), loEnd), Math.min(a + maxLen(c, k), hiEnd));
    let start2 = na;
    if (start2 - end < g.min) start2 = end + g.min;
    if (start2 - end > g.max) start2 = end + g.max;
    sp[k][1] = end; sp[k + 1][0] = start2;
  } else {
    const fin = c.regionLen + c.extend;
    end = clamp(end, a + minLen(c, k), Math.min(a + maxLen(c, k), fin - g.min));
    if (g.max !== Infinity) end = Math.max(end, fin - g.max);
    sp[k][1] = end;
  }
  return result(c, sp, c.extend);
}

/** Bouger le bord gauche (début) de la note k vers `t` (s, temps rendu). */
export function stretchStart(c: ElasticCtx, k: number, t: number): ElasticResult {
  const sp = spans(c);
  const [a, b] = sp[k];
  let start = clamp(t, b - maxLen(c, k), b - minLen(c, k));
  const g = gapLimits(c, k);
  if (k > 0) {
    const [pa, pb] = sp[k - 1];
    const loStart = pa + minLen(c, k - 1) + g.min;
    const hiStart = g.max === Infinity ? Infinity : pa + maxLen(c, k - 1) + g.max;
    start = clamp(start, Math.max(b - maxLen(c, k), loStart), Math.min(b - minLen(c, k), hiStart));
    let end0 = pb;
    if (start - end0 < g.min) end0 = start - g.min;
    if (start - end0 > g.max) end0 = start - g.max;
    sp[k][0] = start; sp[k - 1][1] = end0;
  } else {
    start = clamp(start, Math.max(b - maxLen(c, k), g.min), b - minLen(c, k));
    if (g.max !== Infinity) start = Math.min(start, g.max);
    sp[k][0] = start;
  }
  return result(c, sp, c.extend);
}

/** Déplacer la note k de `d` secondes (les voisines s'adaptent ; ou tout ce qui suit, en mode « décaler la suite »). */
export function moveNote(c: ElasticCtx, k: number, d: number): ElasticResult {
  const sp = spans(c);
  const [a, b] = sp[k];
  const N = c.notes.length;
  let lo = -Infinity, hi = Infinity;
  const gPrev = gapLimits(c, k), gNext = gapLimits(c, k + 1);
  // Côté gauche : la note précédente (ou le début de la région) s'adapte.
  if (k > 0) {
    const [pa] = sp[k - 1];
    lo = Math.max(lo, pa + minLen(c, k - 1) + gPrev.min - a);
    if (gPrev.max !== Infinity) hi = Math.min(hi, pa + maxLen(c, k - 1) + gPrev.max - a);
  } else {
    lo = Math.max(lo, gPrev.min - a);
    if (gPrev.max !== Infinity) hi = Math.min(hi, gPrev.max - a);
  }
  // Côté droit : la note suivante s'adapte (sauf « décaler la suite » : tout glisse).
  if (!c.ripple) {
    if (k + 1 < N) {
      const [, nb] = sp[k + 1];
      hi = Math.min(hi, nb - minLen(c, k + 1) - gNext.min - b);
      if (gNext.max !== Infinity) lo = Math.max(lo, nb - maxLen(c, k + 1) - gNext.max - b);
    } else {
      const fin = c.regionLen + c.extend;
      hi = Math.min(hi, fin - gNext.min - b);
      if (gNext.max !== Infinity) lo = Math.max(lo, fin - gNext.max - b);
    }
  }
  const dd = lo > hi ? 0 : clamp(d, lo, hi);
  sp[k] = [a + dd, b + dd];
  if (k > 0) {
    const s = sp[k][0];
    if (s - sp[k - 1][1] < gPrev.min) sp[k - 1][1] = s - gPrev.min;
    if (s - sp[k - 1][1] > gPrev.max) sp[k - 1][1] = s - gPrev.max;
  }
  if (c.ripple) {
    for (let j = k + 1; j < N; j++) { sp[j][0] += dd; sp[j][1] += dd; }
    return result(c, sp, c.extend + dd);
  }
  if (k + 1 < N) {
    const e = sp[k][1];
    if (sp[k + 1][0] - e < gNext.min) sp[k + 1][0] = e + gNext.min;
    if (sp[k + 1][0] - e > gNext.max) sp[k + 1][0] = e + gNext.max;
  }
  return result(c, sp, c.extend);
}

/**
 * Étirer plusieurs notes ensemble : de la première à la dernière note choisie,
 * chaque note choisie est mise à l'échelle `f` (×0,25 à ×4 de sa durée
 * d'origine), les blancs et les notes non choisies entre elles gardent leur
 * durée ; ce qui suit s'adapte (ou glisse, en mode « décaler la suite »).
 */
export function stretchGroup(c: ElasticCtx, selected: number[], f: number): ElasticResult {
  const sel = [...new Set(selected)].filter(k => k >= 0 && k < c.notes.length).sort((x, y) => x - y);
  if (!sel.length) return { edits: c.edits, extend: c.extend };
  const first = sel[0], last = sel[sel.length - 1];
  const sp0 = spans(c);
  const tryF = (ff: number): ElasticResult | null => {
    const sp = sp0.map(s => [s[0], s[1]] as [number, number]);
    let cursor = sp0[first][0];
    for (let k = first; k <= last; k++) {
      const gap = k > first ? sp0[k][0] - sp0[k - 1][1] : 0;
      const len = sp0[k][1] - sp0[k][0];
      const nl = sel.includes(k) ? clamp(len * ff, minLen(c, k), maxLen(c, k)) : len;
      const s = cursor + gap;
      sp[k] = [s, s + nl];
      cursor = s + nl;
    }
    const d = sp[last][1] - sp0[last][1];
    if (c.ripple) {
      for (let j = last + 1; j < c.notes.length; j++) { sp[j][0] += d; sp[j][1] += d; }
      return result(c, sp, c.extend + d);
    }
    // La suite s'adapte comme pour un bord tiré à la main.
    const inner: ElasticCtx = { ...c, edits: result(c, sp, c.extend).edits };
    const r = stretchEnd(inner, last, sp[last][1]);
    const got = de({ ...c, edits: r.edits }, last);
    if (Math.abs(got - sp[last][1]) > 1e-4) return null;
    return r;
  };
  // Rapport réalisable le plus proche (la suite peut limiter l'étirement).
  let r = tryF(f);
  if (r) return r;
  let lo = 1, hi = f;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const t = tryF(mid);
    if (t) { r = t; lo = mid; } else hi = mid;
  }
  return r || { edits: c.edits, extend: c.extend };
}

/** Durée d'origine de la note k (double-clic) : sa fin revient à début + durée chantée. */
export function resetLength(c: ElasticCtx, k: number): ElasticResult {
  return stretchEnd(c, k, ds(c, k) + origLen(c, k));
}

/** Début et fin rendus de la note k (s). */
export const renderedSpan = (c: Pick<ElasticCtx, 'notes' | 'edits'>, k: number): [number, number] =>
  [c.notes[k].start + (c.edits[k]?.dt0 || 0), c.notes[k].end + (c.edits[k]?.dt1 || 0)];

/** Plus long silence (s) d'un blanc, d'après le niveau par trame. */
export function quietLenFrom(rmsDb: Float32Array, hopSec: number, floorDb: number) {
  return (a: number, b: number): number => {
    const f0 = Math.max(0, Math.ceil(a / hopSec)), f1 = Math.min(rmsDb.length, Math.floor(b / hopSec));
    let best = 0, run = 0;
    for (let f = f0; f < f1; f++) { if (rmsDb[f] < floorDb) { run++; best = Math.max(best, run); } else run = 0; }
    return best * hopSec;
  };
}

/** Seuil de silence d'une voix : 40 dB sous ses passages forts (jamais sous −70 dBFS). */
export function silenceFloor(rmsDb: Float32Array): number {
  const s = Array.from(rmsDb).sort((x, y) => x - y);
  const loud = s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : -120;
  return Math.max(-70, loud - 40);
}
