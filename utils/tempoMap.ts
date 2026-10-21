/**
 * Carte des tempos et des mesures (R2) : la piste tempo / mesure des DAW pro.
 *
 * Le projet garde son tempo et sa mesure de départ (DAWState.bpm et
 * timeSignature) ; `tempoEvents` ajoute des changements, posés au début d'une
 * mesure. Le tempo est en noires par minute (convention de tous les DAW) ; le
 * « temps » du clic et du décompte suit le dénominateur : en 6/8, six croches
 * par mesure.
 *
 * Rampes (L3) : un changement marqué `ramp` est ATTEINT progressivement — le
 * tempo glisse depuis le changement précédent (accélération ou ralentissement).
 * Dans une rampe, le tempo varie linéairement avec la position musicale (en
 * noires) : bpm(x) = b0 + (b1 − b0)·x / L. Le temps écoulé en découle
 * exactement : t(x) = 60·L / (b1 − b0) · ln(bpm(x) / b0), et sa réciproque
 * x(t) = b0·(e^(t·(b1 − b0) / (60·L)) − 1)·L / (b1 − b0). Pas d'approximation
 * pas à pas : clic, grille, notes et export tombent au même endroit.
 *
 * Tout est rangé en secondes ailleurs dans NOVA (clips, notes, automation) :
 * quand la carte change, `utils/tempoFollow` déplace le contenu pour qu'il
 * garde sa position musicale (même mesure | temps | tick).
 */
import type { TimeSignature } from '../types';

export interface TempoEvent {
  id: string;
  /** Mesure (0 = la première) où le changement commence. */
  bar: number;
  bpm?: number;
  numerator?: number;
  denominator?: number;
  /**
   * Rampe : le tempo glisse depuis le changement précédent pour arriver à
   * `bpm` au début de cette mesure (accélération / ralentissement). Absent :
   * le tempo change d'un coup (marche). Une ancienne version l'ignore.
   */
  ramp?: boolean;
}

export interface TempoSegment {
  /** Première mesure du segment (0 = la première du morceau). */
  bar: number;
  /** Début du segment (s). */
  time: number;
  /** Noires écoulées depuis le début du morceau au début du segment. */
  q: number;
  /** Tempo au début du segment. */
  bpm: number;
  /** Rampe : tempo atteint à la fin du segment (absent : tempo constant). */
  bpmEnd?: number;
  /** Rampe : longueur du segment en noires. */
  qLen?: number;
  num: number;
  den: number;
  /** Durée d'un temps (unité du dénominateur), en s, au tempo de départ du segment. */
  beatSec: number;
  /** Durée d'une mesure (s), au tempo de départ du segment. */
  barSec: number;
}

export interface TempoMap { segments: TempoSegment[] }

export const METER_CHOICES: { num: number; den: number; label: string }[] = [
  { num: 4, den: 4, label: '4/4' }, { num: 3, den: 4, label: '3/4' }, { num: 2, den: 4, label: '2/4' }, { num: 5, den: 4, label: '5/4' },
  { num: 6, den: 8, label: '6/8' }, { num: 7, den: 8, label: '7/8' }, { num: 9, den: 8, label: '9/8' }, { num: 12, den: 8, label: '12/8' },
];

const clampBpm = (b: number) => (Number.isFinite(b) && b > 0 ? Math.max(20, Math.min(999, b)) : 120);
const okNum = (n: number | undefined, d: number) => (Number.isFinite(n) && (n as number) >= 1 && (n as number) <= 32 ? Math.round(n as number) : d);
const okDen = (n: number | undefined, d: number) => ([1, 2, 4, 8, 16, 32].includes(Number(n)) ? Number(n) : d);

function segment(bar: number, time: number, bpm: number, num: number, den: number): TempoSegment {
  const beatSec = (60 / bpm) * (4 / den);
  return { bar, time, q: 0, bpm, num, den, beatSec, barSec: beatSec * num };
}

/** Noires par mesure d'un segment (6/8 = 3 noires). */
export const quartersPerBar = (s: Pick<TempoSegment, 'num' | 'den'>) => (s.num * 4) / s.den;

const isRamp = (s: TempoSegment) => s.bpmEnd !== undefined && !!s.qLen && Math.abs(s.bpmEnd - s.bpm) > 1e-9;

/** Secondes écoulées après `x` noires depuis le début du segment (rampe exacte). */
export function secondsInSegment(s: TempoSegment, x: number): number {
  if (!isRamp(s) || x <= 0) return (x * 60) / s.bpm;
  const L = s.qLen as number, b0 = s.bpm, b1 = s.bpmEnd as number;
  const k = (b1 - b0) / L;
  if (x > L) return (60 / k) * Math.log(b1 / b0) + ((x - L) * 60) / b1;
  return (60 / k) * Math.log((b0 + k * x) / b0);
}

/** Noires écoulées `t` secondes après le début du segment (réciproque de secondsInSegment). */
export function quartersInSegment(s: TempoSegment, t: number): number {
  if (!isRamp(s) || t <= 0) return (t * s.bpm) / 60;
  const L = s.qLen as number, b0 = s.bpm, b1 = s.bpmEnd as number;
  const k = (b1 - b0) / L;
  const T = (60 / k) * Math.log(b1 / b0);
  if (t > T) return L + ((t - T) * b1) / 60;
  return (b0 * (Math.exp((t * k) / 60) - 1)) / k;
}

/** Carte construite du tempo et de la mesure de départ, puis des changements. */
export function buildTempoMap(bpm: number, ts: Pick<TimeSignature, 'numerator' | 'denominator'> | undefined | null, events?: TempoEvent[] | null): TempoMap {
  let cur = segment(0, 0, clampBpm(bpm), okNum(ts?.numerator, 4), okDen(ts?.denominator, 4));
  const segs: TempoSegment[] = [cur];
  // Rampe vers le segment d'indice i (posée par le changement qui l'ouvre).
  const rampTo = new Set<TempoSegment>();
  const sorted = [...(events || [])].filter(e => e && Number.isFinite(e.bar) && e.bar >= 0).sort((a, b) => a.bar - b.bar);
  for (const e of sorted) {
    const bar = Math.round(e.bar);
    const bpmN = e.bpm !== undefined ? clampBpm(e.bpm) : cur.bpm;
    const num = okNum(e.numerator, cur.num);
    const den = okDen(e.denominator, cur.den);
    if (bar === cur.bar) {
      // Même mesure : le changement remplace (mesure 0 = départ du morceau).
      const was = rampTo.has(cur);
      rampTo.delete(cur);
      cur = segment(cur.bar, cur.time, bpmN, num, den);
      segs[segs.length - 1] = cur;
      if ((was || e.ramp) && bar > 0) rampTo.add(cur);
      continue;
    }
    if (bpmN === cur.bpm && num === cur.num && den === cur.den) continue;
    cur = segment(bar, 0, bpmN, num, den);
    segs.push(cur);
    if (e.ramp && e.bpm !== undefined) rampTo.add(cur);
  }
  // Positions : noires et secondes cumulées ; un segment suivi d'une rampe glisse vers son tempo.
  let q = 0, time = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    s.q = q; s.time = time;
    const next = segs[i + 1];
    if (!next) break;
    const L = (next.bar - s.bar) * quartersPerBar(s);
    if (rampTo.has(next) && Math.abs(next.bpm - s.bpm) > 1e-9) { s.bpmEnd = next.bpm; s.qLen = L; }
    time += secondsInSegment(s, L);
    q += L;
  }
  return { segments: segs };
}

/** Vrai si la carte se réduit à 4/4 sans changement (anciens calculs, plus rapides). */
export const isPlain44 = (m: TempoMap) => m.segments.length === 1 && m.segments[0].num === 4 && m.segments[0].den === 4;

/** La carte contient-elle au moins une rampe ? */
export const hasRamps = (m: TempoMap) => m.segments.some(isRamp);

export function segmentAtTime(m: TempoMap, t: number): TempoSegment {
  const s = m.segments;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].time <= t + 1e-9) lo = mid; else hi = mid - 1; }
  return s[lo];
}

export function segmentAtBar(m: TempoMap, bar: number): TempoSegment {
  const s = m.segments;
  let r = s[0];
  for (const x of s) { if (x.bar <= bar) r = x; else break; }
  return r;
}

export function segmentAtQuarter(m: TempoMap, q: number): TempoSegment {
  const s = m.segments;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].q <= q + 1e-9) lo = mid; else hi = mid - 1; }
  return s[lo];
}

/** Noires écoulées depuis le début du morceau à l'instant t (négatif avant 0, au tempo de départ). */
export function timeToQuarters(m: TempoMap, t: number): number {
  if (t <= 0) return (t * m.segments[0].bpm) / 60;
  const seg = segmentAtTime(m, t);
  return seg.q + quartersInSegment(seg, t - seg.time);
}

/** Instant (s) où tombe la position `q` (en noires depuis le début du morceau). */
export function quartersToTime(m: TempoMap, q: number): number {
  if (q <= 0) return (q * 60) / m.segments[0].bpm;
  const seg = segmentAtQuarter(m, q);
  return seg.time + secondsInSegment(seg, q - seg.q);
}

/** Début de la mesure `bar` (0 = la première), en s. */
export function barToTime(m: TempoMap, bar: number): number {
  const seg = segmentAtBar(m, Math.floor(bar));
  return seg.time + secondsInSegment(seg, (bar - seg.bar) * quartersPerBar(seg));
}

export interface MusicalPosition {
  /** Mesure (0 = la première). */
  bar: number;
  /** Temps dans la mesure (0 = le premier), unité du dénominateur. */
  beat: number;
  /** Fraction du temps (0…1). */
  frac: number;
  seg: TempoSegment;
}

export function timeToPosition(m: TempoMap, t: number): MusicalPosition {
  const tt = Math.max(0, t);
  const seg = segmentAtTime(m, tt);
  const beats = (quartersInSegment(seg, tt - seg.time) * seg.den) / 4;
  const whole = Math.floor(beats + 1e-9);
  const barIn = Math.floor(whole / seg.num);
  return { bar: seg.bar + barIn, beat: whole - barIn * seg.num, frac: Math.max(0, beats - whole), seg };
}

export function positionToTime(m: TempoMap, bar: number, beat = 0, frac = 0): number {
  const seg = segmentAtBar(m, bar);
  return seg.time + secondsInSegment(seg, (bar - seg.bar) * quartersPerBar(seg) + ((beat + frac) * 4) / seg.den);
}

/** Mesures dont le début tombe dans [t0, t1] (règle, traits de mesure). */
export function barsInRange(m: TempoMap, t0: number, t1: number): { bar: number; time: number; seg: TempoSegment }[] {
  const out: { bar: number; time: number; seg: TempoSegment }[] = [];
  let bar = timeToPosition(m, Math.max(0, t0)).bar;
  for (let guard = 0; guard < 100000; guard++, bar++) {
    const time = barToTime(m, bar);
    if (time > t1 + 1e-9) break;
    if (time >= t0 - 1e-9) out.push({ bar, time, seg: segmentAtBar(m, bar) });
  }
  return out;
}

/** Temps (clic) dans [t0, t1[ : instant, mesure, temps, premier temps ou non. */
export function beatsInRange(m: TempoMap, t0: number, t1: number): { time: number; bar: number; beat: number; downbeat: boolean }[] {
  const out: { time: number; bar: number; beat: number; downbeat: boolean }[] = [];
  if (!(t1 > t0)) return out;
  const p = timeToPosition(m, Math.max(0, t0));
  let bar = p.bar, beat = p.beat;
  // Le temps courant s'il tombe pile au début de la fenêtre, sinon le suivant.
  if (p.frac > 1e-7) beat += 1;
  for (let guard = 0; guard < 100000; guard++) {
    const seg = segmentAtBar(m, bar);
    if (beat >= seg.num) { bar += 1; beat = 0; continue; }
    const time = positionToTime(m, bar, beat);
    if (time >= t1 - 1e-12) break;
    if (time >= t0 - 1e-9) out.push({ time, bar, beat, downbeat: beat === 0 });
    beat += 1;
  }
  return out;
}

/** Tempo à l'instant t (dans une rampe : le tempo du moment). */
export function tempoAt(m: TempoMap, t: number): number {
  const seg = segmentAtTime(m, Math.max(0, t));
  if (!isRamp(seg)) return seg.bpm;
  const x = Math.min(seg.qLen as number, quartersInSegment(seg, Math.max(0, t) - seg.time));
  return seg.bpm + ((seg.bpmEnd as number) - seg.bpm) * (x / (seg.qLen as number));
}

// --- Grille ---------------------------------------------------------------------------

/** Pas de grille musicale en noires ('1/1' = la mesure du segment, '1/8T'…). Null si grille en temps. */
export function gridStepQuarters(seg: Pick<TempoSegment, 'num' | 'den'>, gridSize: string): number | null {
  const g = String(gridSize || '').trim();
  if (/^(ms|fps):/.test(g)) return null;
  if (g === '1/1') return quartersPerBar(seg);
  const mm = /^1\/(\d+)(T?)$/.exec(g);
  const n = mm ? Math.max(1, parseInt(mm[1], 10)) : 4;
  const step = 4 / n;
  return mm && mm[2] ? (step * 2) / 3 : step;
}

/** Pas de grille musicale en s pour un segment, au tempo de départ du segment. Null si grille en temps. */
export function gridStepInSegment(seg: TempoSegment, gridSize: string): number | null {
  const g = String(gridSize || '').trim();
  if (/^(ms|fps):/.test(g)) return null;
  if (g === '1/1') return seg.barSec;
  const mm = /^1\/(\d+)(T?)$/.exec(g);
  const n = mm ? Math.max(1, parseInt(mm[1], 10)) : 4;
  const quarter = 60 / seg.bpm;
  const step = quarter * (4 / n);
  return mm && mm[2] ? (step * 2) / 3 : step;
}

/**
 * Aimantation sur la grille, ancrée sur chaque début de mesure (Pro Tools) :
 * en 7/8 avec une grille à la noire, les traits repartent à chaque mesure.
 */
export function snapTimeToMap(m: TempoMap, t: number, gridSize: string): number {
  const tt = Math.max(0, t);
  const p = timeToPosition(m, tt);
  const barStart = barToTime(m, p.bar);
  const nextBar = barToTime(m, p.bar + 1);
  const step = gridStepQuarters(p.seg, gridSize);
  if (!step) return tt;
  // En noires depuis le début de la mesure : exact aussi dans une rampe.
  const x0 = (p.bar - p.seg.bar) * quartersPerBar(p.seg);
  const xt = quartersInSegment(p.seg, tt - p.seg.time) - x0;
  const k = Math.round(xt / step);
  let cand = isRamp(p.seg) ? p.seg.time + secondsInSegment(p.seg, x0 + k * step) : barStart + k * gridStepInSegment(p.seg, gridSize)!;
  if (cand > nextBar - 1e-9) cand = nextBar;
  // Le début de la mesure suivante peut être plus proche que le dernier trait (mesure « boiteuse »).
  return Math.abs(nextBar - tt) < Math.abs(cand - tt) ? nextBar : cand;
}

/** Traits de grille dans [t0, t1] : temps et sous-divisions, ancrés sur les mesures. */
export function gridLinesInRange(m: TempoMap, t0: number, t1: number, gridSize: string, minStepSec = 0): { time: number; kind: 'bar' | 'beat' | 'sub' }[] {
  const out: { time: number; kind: 'bar' | 'beat' | 'sub' }[] = [];
  const startBar = Math.max(0, timeToPosition(m, Math.max(0, t0)).bar);
  for (let bar = startBar, guard = 0; guard < 20000; bar++, guard++) {
    const bt = barToTime(m, bar);
    if (bt > t1) break;
    const seg = segmentAtBar(m, bar);
    const end = barToTime(m, bar + 1);
    out.push({ time: bt, kind: 'bar' });
    const ramp = isRamp(seg);
    const stepQ = gridStepQuarters(seg, gridSize);
    const step = gridStepInSegment(seg, gridSize);
    const qpb = quartersPerBar(seg);
    if (stepQ && step && step >= minStepSec && stepQ < qpb - 1e-9) {
      const x0 = (bar - seg.bar) * qpb;
      for (let k = 1; k * stepQ < qpb - 1e-9; k++) {
        // Tempo constant : les mêmes additions qu'avant (traits identiques au bit près).
        const x = ramp ? seg.time + secondsInSegment(seg, x0 + k * stepQ) : bt + k * step;
        if (x >= end - 1e-9) break;
        if (x < t0 || x > t1) continue;
        const beats = (k * stepQ * seg.den) / 4;
        out.push({ time: x, kind: Math.abs(beats - Math.round(beats)) < 1e-6 ? 'beat' : 'sub' });
      }
    }
  }
  return out;
}

/** « 012 | 3 | 480 » (mesures | temps | ticks à 960 par temps), comme le compteur de Pro Tools. */
export function formatBarsBeats(m: TempoMap, t: number): string {
  const p = timeToPosition(m, t + 1e-6);
  const ticks = Math.min(959, Math.floor(p.frac * 960 + 1e-6));
  return `${String(p.bar + 1).padStart(3, '0')} | ${p.beat + 1} | ${String(Math.max(0, ticks)).padStart(3, '0')}`;
}

// --- Édition -------------------------------------------------------------------------

/** Ajoute ou remplace le changement de la mesure `bar` (fusion des champs). */
export function upsertTempoEvent(events: TempoEvent[] | undefined, e: Omit<TempoEvent, 'id'> & { id?: string }): TempoEvent[] {
  const list = [...(events || [])];
  const bar = Math.max(1, Math.round(e.bar));
  const i = list.findIndex(x => x.bar === bar);
  const merged: TempoEvent = { ...(i >= 0 ? list[i] : {}), ...e, bar, id: (i >= 0 ? list[i].id : e.id) || `tempo-${bar}-${Date.now().toString(36)}` };
  if (i >= 0) list[i] = merged; else list.push(merged);
  return list.sort((a, b) => a.bar - b.bar);
}

export function removeTempoEvent(events: TempoEvent[] | undefined, id: string): TempoEvent[] {
  return (events || []).filter(e => e.id !== id);
}

/** Empreinte (collaboration) : tempo, mesure de départ et changements. */
export function tempoSignature(bpm: number, ts: TimeSignature | undefined, events: TempoEvent[] | undefined): string {
  const ev = [...(events || [])].sort((a, b) => a.bar - b.bar).map(e => `${e.bar}:${e.bpm ?? ''}:${e.numerator ?? ''}/${e.denominator ?? ''}${e.ramp ? ':r' : ''}`).join(',');
  return `${Math.round(bpm * 1000) / 1000}|${ts?.numerator ?? 4}/${ts?.denominator ?? 4}|${ev}`;
}

// --- Carte courante (lue par la grille, le clic, le compteur) --------------------------

type Listener = (m: TempoMap) => void;
let current: TempoMap = buildTempoMap(120, { numerator: 4, denominator: 4 }, []);
const listeners = new Set<Listener>();

export const tempoMapStore = {
  get: () => current,
  set(m: TempoMap) { current = m; listeners.forEach(l => l(m)); },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
};

// --- MIDI ---------------------------------------------------------------------------

/** Noires écoulées depuis le début du morceau à l'instant t (export MIDI : ticks = noires × PPQ). 0 avant le début. */
export function quartersAt(m: TempoMap, t: number): number {
  return t <= 0 ? 0 : timeToQuarters(m, t);
}

/**
 * Rampe découpée en petits paliers (export MIDI, qui ne connaît que des
 * changements de tempo en marche) : un palier toutes les `stepQ` noires, au
 * tempo qui donne EXACTEMENT la durée du palier (les notes tombent juste).
 */
export function rampSteps(seg: TempoSegment, stepQ = 0.25): { q: number; bpm: number }[] {
  if (!isRamp(seg)) return [{ q: seg.q, bpm: seg.bpm }];
  const L = seg.qLen as number;
  const out: { q: number; bpm: number }[] = [];
  for (let x = 0; x < L - 1e-9; x += stepQ) {
    const len = Math.min(stepQ, L - x);
    const dur = secondsInSegment(seg, x + len) - secondsInSegment(seg, x);
    out.push({ q: seg.q + x, bpm: (60 * len) / dur });
  }
  return out;
}
