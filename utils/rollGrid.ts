/**
 * Grille du piano roll sur la carte de tempo réelle (22/10/2026).
 *
 * Avant, le piano roll prenait le tempo au début du clip et posait une grille
 * régulière : dans une rampe (accélération, ralentissement) ou après un
 * changement de tempo ou de mesure, ses traits ne tombaient plus sur ceux de
 * l'arrangement. Ici, tout passe par utils/tempoMap (calcul exact des rampes) :
 * traits de mesure, de temps et de cases, aimantation, case du crayon et du
 * pinceau, quantification, règle. Grille ancrée sur chaque mesure, comme
 * l'arrangement (snapTimeToMap) : en 7/8, les traits repartent à chaque mesure.
 *
 * Toutes les fonctions prennent et rendent des temps du MORCEAU (s).
 */
import {
  TempoMap, isPlain44, timeToPosition, quartersPerBar, quartersInSegment, secondsInSegment, barToTime,
  gridStepQuarters, gridLinesInRange, barsInRange, beatsInRange, timeToQuarters, quartersToTime, segmentAtTime,
} from './tempoMap';

/**
 * Le piano roll suit-il la carte ? Oui dès qu'elle n'est pas un simple 4/4 à
 * tempo fixe (changements, rampes, autre mesure) et qu'elle est bien celle du
 * projet affiché (même tempo de départ). Sinon : grille régulière d'avant,
 * inchangée au bit près.
 */
export function rollFollowsMap(m: TempoMap | null | undefined, projectBpm: number): m is TempoMap {
  return !!m && m.segments.length > 0 && Math.abs(m.segments[0].bpm - projectBpm) < 1e-6 && !isPlain44(m);
}

interface Cell { x0: number; xt: number; step: number; qpb: number; seg: TempoMap['segments'][number]; bar: number }

const cellAt = (m: TempoMap, t: number, gridId: string): Cell | null => {
  const tt = Math.max(0, t);
  const p = timeToPosition(m, tt);
  const step = gridStepQuarters(p.seg, gridId);
  if (!step) return null;
  const qpb = quartersPerBar(p.seg);
  const x0 = (p.bar - p.seg.bar) * qpb;
  const xt = quartersInSegment(p.seg, tt - p.seg.time) - x0;
  return { x0, xt, step, qpb, seg: p.seg, bar: p.bar };
};

/** Instant du k-ième trait de la mesure (borné au début de la mesure suivante). */
const lineTime = (m: TempoMap, c: Cell, k: number, swingQ = 0): number => {
  const nextBar = barToTime(m, c.bar + 1);
  const x = k * c.step + (k % 2 !== 0 ? swingQ : 0);
  if (x >= c.qpb - 1e-9) return nextBar;
  return Math.min(nextBar, c.seg.time + secondsInSegment(c.seg, c.x0 + x));
};

/**
 * Aimantation : trait le plus proche (`round`) ou trait de la case où tombe `t`
 * (`floor`, le crayon pose dans la case cliquée). `swingQ` (en noires) décale
 * les traits impairs (quantification avec swing).
 */
export function mapSnap(m: TempoMap, t: number, gridId: string, mode: 'round' | 'floor' = 'round', swingQ = 0): number {
  const c = cellAt(m, t, gridId);
  if (!c) return Math.max(0, t);
  if (mode === 'floor') return lineTime(m, c, Math.floor(c.xt / c.step + 1e-9));
  const cand = lineTime(m, c, Math.round(c.xt / c.step), swingQ);
  // Le début de la mesure suivante peut être plus proche que le dernier trait (mesure « boiteuse »).
  const nextBar = barToTime(m, c.bar + 1);
  return Math.abs(nextBar - t) < Math.abs(cand - t) ? nextBar : cand;
}

/** Case de grille qui contient `t` : [début, fin[ (s). */
export function mapCell(m: TempoMap, t: number, gridId: string): [number, number] {
  const c = cellAt(m, t, gridId);
  if (!c) return [Math.max(0, t), Math.max(0, t)];
  const k = Math.floor(c.xt / c.step + 1e-9);
  return [lineTime(m, c, k), lineTime(m, c, k + 1)];
}

/** Durée (s) de `q` noires à partir de `t` (dans une rampe, elle dépend de l'endroit). */
export function spanQuarters(m: TempoMap, t: number, q: number): number {
  return quartersToTime(m, timeToQuarters(m, t) + q) - t;
}

/** Durée (s) d'un temps (unité du dénominateur) à l'endroit `t`. */
export function beatLenAt(m: TempoMap, t: number): number {
  return spanQuarters(m, t, 4 / segmentAtTime(m, Math.max(0, t)).den);
}

/** Cale sur le temps le plus proche (règle : boucle d'écoute calée sur les temps). */
export function mapSnapBeat(m: TempoMap, t: number): number {
  return mapSnap(m, t, `1/${segmentAtTime(m, Math.max(0, t)).den}`);
}

/** Traits à dessiner dans [t0, t1] : mesures, temps, cases (cases plus étroites que `minSubSec` omises). */
export function mapGridLines(m: TempoMap, t0: number, t1: number, gridId: string, minSubSec = 0): { bars: { bar: number; time: number }[]; beats: number[]; subs: number[] } {
  const bars = barsInRange(m, t0, t1).map(b => ({ bar: b.bar, time: b.time }));
  const beats = beatsInRange(m, t0, t1 + 1e-9).filter(b => !b.downbeat).map(b => b.time);
  const subs = gridLinesInRange(m, t0, t1, gridId, minSubSec).filter(l => l.kind === 'sub').map(l => l.time);
  return { bars, beats, subs };
}

/** Mesure et temps (0 = le premier) à l'instant `t`. */
export function mapBarBeat(m: TempoMap, t: number): { bar: number; beat: number } {
  const p = timeToPosition(m, t + 1e-9);
  return { bar: p.bar, beat: p.beat };
}
