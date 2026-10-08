/**
 * Carte des tempos et des mesures (R2) : la « piste tempo » de Pro Tools, la
 * Global Tempo Track de Logic, l'automation de tempo d'Ableton et de FL.
 *
 * Le projet garde son tempo et sa mesure de départ (DAWState.bpm et
 * timeSignature) ; `tempoEvents` ajoute des changements, posés au début d'une
 * mesure (comme dans Pro Tools par défaut). Le tempo est en noires par minute
 * (convention de tous les DAW) ; le « temps » du clic et du décompte suit le
 * dénominateur : en 6/8, six croches par mesure.
 *
 * Tout est en secondes ailleurs dans NOVA (clips, notes, automation) : la carte
 * ne déplace rien, elle sert à la grille, à l'aimantation, à la règle, au clic,
 * au décompte, au compteur en mesures, à l'export MIDI et aux métadonnées.
 */
import type { TimeSignature } from '../types';

export interface TempoEvent {
  id: string;
  /** Mesure (0 = la première) où le changement commence. */
  bar: number;
  bpm?: number;
  numerator?: number;
  denominator?: number;
}

export interface TempoSegment {
  /** Première mesure du segment (0 = la première du morceau). */
  bar: number;
  /** Début du segment (s). */
  time: number;
  bpm: number;
  num: number;
  den: number;
  /** Durée d'un temps (unité du dénominateur), en s. */
  beatSec: number;
  /** Durée d'une mesure (s). */
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
  return { bar, time, bpm, num, den, beatSec, barSec: beatSec * num };
}

/** Carte construite du tempo et de la mesure de départ, puis des changements. */
export function buildTempoMap(bpm: number, ts: Pick<TimeSignature, 'numerator' | 'denominator'> | undefined | null, events?: TempoEvent[] | null): TempoMap {
  let cur = segment(0, 0, clampBpm(bpm), okNum(ts?.numerator, 4), okDen(ts?.denominator, 4));
  const segs: TempoSegment[] = [cur];
  const sorted = [...(events || [])].filter(e => e && Number.isFinite(e.bar) && e.bar >= 0).sort((a, b) => a.bar - b.bar);
  for (const e of sorted) {
    const bar = Math.round(e.bar);
    const bpmN = e.bpm !== undefined ? clampBpm(e.bpm) : cur.bpm;
    const num = okNum(e.numerator, cur.num);
    const den = okDen(e.denominator, cur.den);
    if (bar === cur.bar) {
      // Même mesure : le changement remplace (mesure 0 = départ du morceau).
      cur = segment(cur.bar, cur.time, bpmN, num, den);
      segs[segs.length - 1] = cur;
      continue;
    }
    const time = cur.time + (bar - cur.bar) * cur.barSec;
    if (bpmN === cur.bpm && num === cur.num && den === cur.den) continue;
    cur = segment(bar, time, bpmN, num, den);
    segs.push(cur);
  }
  return { segments: segs };
}

/** Vrai si la carte se réduit à 4/4 sans changement (anciens calculs, plus rapides). */
export const isPlain44 = (m: TempoMap) => m.segments.length === 1 && m.segments[0].num === 4 && m.segments[0].den === 4;

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

/** Début de la mesure `bar` (0 = la première), en s. */
export function barToTime(m: TempoMap, bar: number): number {
  const seg = segmentAtBar(m, Math.floor(bar));
  return seg.time + (bar - seg.bar) * seg.barSec;
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
  const beats = (tt - seg.time) / seg.beatSec;
  const whole = Math.floor(beats + 1e-9);
  const barIn = Math.floor(whole / seg.num);
  return { bar: seg.bar + barIn, beat: whole - barIn * seg.num, frac: Math.max(0, beats - whole), seg };
}

export function positionToTime(m: TempoMap, bar: number, beat = 0, frac = 0): number {
  const seg = segmentAtBar(m, bar);
  return seg.time + (bar - seg.bar) * seg.barSec + (beat + frac) * seg.beatSec;
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

export function tempoAt(m: TempoMap, t: number): number { return segmentAtTime(m, t).bpm; }
export function meterAt(m: TempoMap, t: number): { numerator: number; denominator: number } {
  const s = segmentAtTime(m, t); return { numerator: s.num, denominator: s.den };
}

// --- Grille ---------------------------------------------------------------------------

/** Pas de grille musicale en s pour un segment ('1/1' = la mesure du segment, '1/8T'…). Null si grille en temps. */
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
  const step = gridStepInSegment(p.seg, gridSize);
  if (!step) return tt;
  const k = Math.round((tt - barStart) / step);
  let cand = barStart + k * step;
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
    const step = gridStepInSegment(seg, gridSize);
    if (step && step >= minStepSec && step < seg.barSec - 1e-9) {
      for (let x = bt + step; x < end - 1e-9; x += step) {
        if (x < t0 || x > t1) continue;
        const beats = (x - bt) / seg.beatSec;
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
  const ev = [...(events || [])].sort((a, b) => a.bar - b.bar).map(e => `${e.bar}:${e.bpm ?? ''}:${e.numerator ?? ''}/${e.denominator ?? ''}`).join(',');
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

/** Noires écoulées depuis le début du morceau à l'instant t (export MIDI : ticks = noires × PPQ). */
export function quartersAt(m: TempoMap, t: number): number {
  let q = 0;
  const segs = m.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const end = i + 1 < segs.length ? segs[i + 1].time : Infinity;
    if (t <= s.time) break;
    q += (Math.min(t, end) - s.time) * (s.bpm / 60);
    if (t <= end) break;
  }
  return q;
}
