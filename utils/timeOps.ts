import type { AutomationLane, AutomationPoint, Clip, Marker, TimeSignature, Track } from '../types';
import type { ChordEvent } from './chordDetect';
import { buildTempoMap, timeToPosition, barToTime, TempoEvent, TempoMap } from './tempoMap';
import { extractRange, removeRange, splitClipsAt, IdGen } from './timeSelection';
import { sortedPoints, valueAtPoints } from './automationWrite';
import { nextMarkerNumber } from './memoryLocations';

/**
 * R12 · Opérations sur le temps (Pro Tools : Insert Silence, Snap to Insert
 * Time, Event › Time Operations › Insert Time / Cut Time ; Logic / Studio One :
 * piste Arrangement, déplacer ou dupliquer une section).
 *
 *  - Insérer du temps : à un instant, sur toutes les pistes ou sur certaines.
 *    Les clips qui traversent l'instant sont coupés, la suite recule ; la courbe
 *    d'automation reste plate pendant le blanc ; repères, accords, tempo et
 *    boucle suivent (option « règles » : oui par défaut sur toutes les pistes).
 *  - Supprimer du temps : la plage disparaît, la suite avance.
 *  - Section (règle / piste Arrangement) : déplacer ou dupliquer une section
 *    entière (clips, automation, accords, repères, tempo).
 *
 * La piste tempo est rangée en mesures (utils/tempoMap) : elle est traitée
 * mesure par mesure (tableau de mesures). Quand l'insertion tombe sur une barre
 * de mesure, ou dans une mesure avec un nombre entier de temps, le résultat est
 * EXACT (une mesure de 2/4 est ajoutée si l'on insère 2 temps en 4/4) ; sinon le
 * rapport le dit (`exactTempo: false`).
 *
 * Collaboration : une opération = un objet JSON (TimeOp) ; les identifiants
 * créés dérivent de `op.id`, donc chaque participant obtient le même projet.
 * Module pur : tests/timeOps.test.ts.
 */

export type TimeScope = 'all' | string[];

export interface InsertTimeOp { kind: 'insert'; id: string; at: number; length: number; tracks: TimeScope; rulers: boolean }
export interface DeleteTimeOp { kind: 'delete'; id: string; start: number; end: number; tracks: TimeScope; rulers: boolean }
export interface SectionOp { kind: 'section'; id: string; mode: 'move' | 'copy'; start: number; end: number; to: number }
export type TimeOp = InsertTimeOp | DeleteTimeOp | SectionOp;

export interface TimeState {
  tracks: Track[];
  markers: Marker[];
  chords?: ChordEvent[];
  bpm: number;
  timeSignature: TimeSignature;
  tempoEvents?: TempoEvent[];
  loopStart: number;
  loopEnd: number;
}

export interface TimeOpReport {
  /** La piste tempo a suivi à l'échantillon près. */
  exactTempo: boolean;
  /** Pistes modifiées. */
  tracks: number;
  /** Phrase courte pour l'utilisateur. */
  summary: string;
}

const EPS = 1e-6;
/** Écart des ancrages d'automation autour d'une jonction (0,1 ms). */
const ANCHOR = 1e-4;

/** Identifiants déterministes (mêmes chez tous les collaborateurs). */
export function opIdGen(tag: string): IdGen {
  let n = 0;
  return (base: string) => `${base.replace(/~.*$/, '')}~${tag}${(n++).toString(36)}`;
}

let opSeq = 0;
export const newTimeOpId = () => `t${Date.now().toString(36)}${(opSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const inScope = (scope: TimeScope, t: Track) => (scope === 'all' ? t.id !== 'master' : scope.includes(t.id));

// ─── Clips ──────────────────────────────────────────────────────────────────────

/** Ouvre un blanc de `len` à `at` : coupe ce qui traverse `at`, décale ce qui suit. */
export function insertClipsTime(clips: Clip[], at: number, len: number, gen: IdGen): Clip[] {
  if (!(len > 0)) return clips;
  return splitClipsAt(clips, [at], gen).map(c => (c.start >= at - EPS ? { ...c, start: c.start + len } : c));
}

/** Supprime [s, e[ : ce qui suit avance de e − s. */
export function deleteClipsTime(clips: Clip[], s: number, e: number, gen: IdGen): Clip[] {
  if (!(e > s)) return clips;
  const len = e - s;
  return removeRange(clips, s, e, gen).map(c => (c.start >= e - EPS ? { ...c, start: c.start - len } : c));
}

// ─── Automation ─────────────────────────────────────────────────────────────────

const pid = (gen: IdGen, base: string) => gen(base);

/** Blanc inséré : la courbe garde sa valeur de `at` pendant `len`, la suite recule. */
export function insertLaneTime(points: AutomationPoint[], at: number, len: number, gen: IdGen): AutomationPoint[] {
  const pts = sortedPoints(points);
  if (!pts.length || !(len > 0)) return points;
  if (pts[pts.length - 1].time < at - EPS) return points;
  const v = valueAtPoints(pts, at, pts[0].value);
  const before = pts.filter(p => p.time < at - EPS);
  const after = pts.filter(p => p.time >= at - EPS).map(p => ({ ...p, time: p.time + len }));
  const out = [...before];
  if (at > EPS || before.length) out.push({ id: pid(gen, 'ai'), time: at, value: v, curveType: 'LINEAR' });
  out.push({ id: pid(gen, 'aj'), time: at + len, value: v, curveType: 'LINEAR' });
  return dedupe([...out, ...after]);
}

/** Plage supprimée : la courbe avant `s` puis celle d'après `e`, recollées. */
export function deleteLaneTime(points: AutomationPoint[], s: number, e: number, gen: IdGen): AutomationPoint[] {
  const pts = sortedPoints(points);
  if (!pts.length || !(e > s)) return points;
  if (pts[pts.length - 1].time < s - EPS) return points;
  const len = e - s;
  const vs = valueAtPoints(pts, s, pts[0].value);
  const ve = valueAtPoints(pts, e, pts[0].value);
  const before = pts.filter(p => p.time < s - EPS);
  const after = pts.filter(p => p.time > e + EPS).map(p => ({ ...p, time: p.time - len }));
  const out = [...before];
  if (before.length || s > EPS) out.push({ id: pid(gen, 'ds'), time: Math.max(0, s - (Math.abs(vs - ve) > 1e-9 ? ANCHOR : 0)), value: vs, curveType: 'LINEAR' });
  out.push({ id: pid(gen, 'de'), time: s, value: ve, curveType: curveAt(pts, e) });
  return dedupe([...out, ...after]);
}

function curveAt(pts: AutomationPoint[], t: number): AutomationPoint['curveType'] {
  let c: AutomationPoint['curveType'] = pts[0]?.curveType;
  for (const p of pts) { if (p.time <= t + EPS) c = p.curveType; else break; }
  return c || 'LINEAR';
}

/** Morceau de courbe de [s, e] en temps relatifs, ancré aux deux bords. */
export function sliceLanePoints(points: AutomationPoint[], s: number, e: number, gen: IdGen): AutomationPoint[] {
  const pts = sortedPoints(points);
  if (!pts.length || !(e > s)) return [];
  const at = (t: number) => valueAtPoints(pts, t, pts[0].value);
  const out: AutomationPoint[] = [{ id: pid(gen, 'sa'), time: 0, value: at(s), curveType: curveAt(pts, s) }];
  for (const p of pts) if (p.time > s + EPS && p.time < e - EPS) out.push({ ...p, id: pid(gen, p.id), time: p.time - s });
  out.push({ id: pid(gen, 'sz'), time: e - s, value: at(e), curveType: curveAt(pts, e) });
  return out;
}

/**
 * Pose `piece` (temps relatifs, longueur `len`) à `at` : dans [at, at+len[ la
 * courbe est exactement le morceau ; avant et après, la courbe d'origine.
 */
export function placeLanePiece(points: AutomationPoint[], piece: AutomationPoint[], at: number, len: number, gen: IdGen): AutomationPoint[] {
  const pts = sortedPoints(points);
  const end = at + len;
  if (!piece.length) return points;
  const fb = pts.length ? pts[0].value : piece[0].value;
  const before = pts.filter(p => p.time < at - EPS);
  const after = pts.filter(p => p.time > end + EPS);
  const out: AutomationPoint[] = [...before];
  // Jonctions verticales (deux points au même instant) : la courbe d'avant reste exacte
  // jusqu'à `at`, le morceau est exact dès `at` (le moteur saute d'une valeur à l'autre).
  if (at > EPS && pts.length) out.push({ id: pid(gen, 'pl'), time: at, value: valueAtPoints(pts, at - 1e-9, fb), curveType: 'LINEAR' });
  piece.forEach(p => { if (p.time < len - EPS) out.push({ ...p, id: pid(gen, 'pp'), time: at + p.time }); });
  const last = piece[piece.length - 1];
  out.push({ id: pid(gen, 'pe'), time: end, value: last.value, curveType: 'LINEAR' });
  if (pts.length) out.push({ id: pid(gen, 'pr'), time: end, value: valueAtPoints(pts, end, fb), curveType: curveAt(pts, end) });
  return dedupe([...out, ...after]);
}

function dedupe(points: AutomationPoint[]): AutomationPoint[] {
  const s = points.filter(p => p.time >= -EPS).map(p => (p.time < 0 ? { ...p, time: 0 } : p)).sort((a, b) => a.time - b.time);
  const out: AutomationPoint[] = [];
  for (const p of s) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.time - p.time) < 1e-9 && Math.abs(q.value - p.value) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

const mapLanes = (t: Track, fn: (l: AutomationLane) => AutomationPoint[]): Track => {
  if (!t.automationLanes?.some(l => l.points?.length)) return t;
  let changed = false;
  const lanes = t.automationLanes.map(l => {
    if (!l.points?.length) return l;
    const points = fn(l);
    if (points === l.points) return l;
    changed = true;
    return { ...l, points };
  });
  return changed ? { ...t, automationLanes: lanes } : t;
};

// ─── Repères, accords, boucle ──────────────────────────────────────────────────

export function insertMarkersTime(markers: Marker[], at: number, len: number): Marker[] {
  return markers.map(m => {
    if (m.time >= at - EPS) return { ...m, time: m.time + len, ...(m.endTime !== undefined ? { endTime: m.endTime + len } : {}) };
    if (m.endTime !== undefined && m.endTime > at + EPS) return { ...m, endTime: m.endTime + len };
    return m;
  });
}

export function deleteMarkersTime(markers: Marker[], s: number, e: number): Marker[] {
  const len = e - s;
  const out: Marker[] = [];
  for (const m of markers) {
    const end = m.endTime;
    if (m.time >= s - EPS && m.time < e - EPS) {
      // Repère simple dans la plage : supprimé ; région qui commence dedans : rognée.
      if (end === undefined || end <= e + EPS) continue;
      out.push({ ...m, time: s, endTime: end - len });
      continue;
    }
    if (m.time >= e - EPS) { out.push({ ...m, time: m.time - len, ...(end !== undefined ? { endTime: end - len } : {}) }); continue; }
    if (end !== undefined && end > s + EPS) out.push({ ...m, endTime: end >= e ? end - len : s });
    else out.push(m);
  }
  return out;
}

export function insertChordsTime(chords: ChordEvent[], at: number, len: number, gen: IdGen): ChordEvent[] {
  const out: ChordEvent[] = [];
  for (const c of chords) {
    if (c.start >= at - EPS) out.push({ ...c, start: c.start + len, end: c.end + len });
    else if (c.end > at + EPS) { out.push({ ...c, end: at }); out.push({ ...c, id: gen(c.id), start: at + len, end: c.end + len }); }
    else out.push(c);
  }
  return out;
}

export function deleteChordsTime(chords: ChordEvent[], s: number, e: number): ChordEvent[] {
  const len = e - s;
  const out: ChordEvent[] = [];
  for (const c of chords) {
    if (c.end <= s + EPS) { out.push(c); continue; }
    if (c.start >= e - EPS) { out.push({ ...c, start: c.start - len, end: c.end - len }); continue; }
    // Recouvre la plage : garde ce qui dépasse avant et après, recollé.
    const keepBefore = Math.max(0, s - c.start);
    const keepAfter = Math.max(0, c.end - e);
    if (keepBefore + keepAfter < 1e-3) continue;
    const start = Math.min(c.start, s);
    out.push({ ...c, start, end: start + keepBefore + keepAfter });
  }
  return out;
}

// ─── Piste tempo, mesure par mesure ────────────────────────────────────────────

interface BarDesc { bpm: number; num: number; den: number }
const same = (a: BarDesc, b: BarDesc) => Math.abs(a.bpm - b.bpm) < 1e-9 && a.num === b.num && a.den === b.den;
const barSecOf = (b: BarDesc) => (60 / b.bpm) * (4 / b.den) * b.num;
const beatSecOf = (b: BarDesc) => (60 / b.bpm) * (4 / b.den);

function toBars(map: TempoMap, n: number): BarDesc[] {
  const out: BarDesc[] = [];
  let si = 0;
  const segs = map.segments;
  for (let bar = 0; bar < n; bar++) {
    while (si + 1 < segs.length && segs[si + 1].bar <= bar) si++;
    const s = segs[si];
    out.push({ bpm: s.bpm, num: s.num, den: s.den });
  }
  return out;
}

/** Tableau de mesures → tempo de départ + changements (ids gardés quand la mesure ne bouge pas). */
function fromBars(bars: BarDesc[], old: TempoEvent[] | undefined, gen: IdGen): { bpm: number; timeSignature: TimeSignature; tempoEvents: TempoEvent[] } {
  // Les mesures identiques en fin de tableau ne changent rien : la dernière continue.
  const first = bars[0];
  const events: TempoEvent[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    if (same(p, b)) continue;
    const prev = (old || []).find(e => e.bar === i);
    const ev: TempoEvent = { id: prev?.id || gen(`tempo-${i}`), bar: i };
    if (Math.abs(p.bpm - b.bpm) > 1e-9) ev.bpm = b.bpm;
    if (p.num !== b.num || p.den !== b.den) { ev.numerator = b.num; ev.denominator = b.den; }
    events.push(ev);
  }
  return { bpm: first.bpm, timeSignature: { numerator: first.num, denominator: first.den }, tempoEvents: events };
}

const lastBar = (events: TempoEvent[] | undefined) => (events || []).reduce((m, e) => Math.max(m, e.bar || 0), 0);

interface TempoPart { bpm: number; timeSignature: TimeSignature; tempoEvents?: TempoEvent[] }

/** Position d'un instant : mesure, et s'il tombe pile sur une barre ou sur un temps. */
function where(map: TempoMap, t: number) {
  const p = timeToPosition(map, t + 1e-9);
  const barStart = barToTime(map, p.bar);
  const onBar = Math.abs(t - barStart) < 1e-6;
  const beats = (t - barStart) / p.seg.beatSec;
  const onBeat = Math.abs(beats - Math.round(beats)) < 1e-6;
  return { bar: p.bar, onBar, onBeat, beatsIn: Math.round(beats) };
}

function sizeFor(s: TempoPart, ...bars: number[]) {
  return Math.max(lastBar(s.tempoEvents), ...bars) + 3;
}

/** Tempo après l'insertion de `len` secondes à `at`. */
export function insertTempoTime(s: TempoPart, at: number, len: number, gen: IdGen): TempoPart & { exact: boolean } {
  const map = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
  const w = where(map, at);
  const bars = toBars(map, sizeFor(s, w.bar + 1));
  // Ce qu'on insère prend le tempo juste AVANT l'instant (le changement posé à `at` recule avec la suite).
  const ins = w.onBar && w.bar > 0 ? bars[w.bar - 1] : bars[w.bar];
  const k = Math.floor(len / barSecOf(ins) + 1e-6);
  const rem = len - k * barSecOf(ins);
  const r = rem / beatSecOf(ins);
  const rInt = Math.abs(r - Math.round(r)) < 1e-6 ? Math.round(r) : null;
  let exact = rInt !== null;
  const added: BarDesc[] = Array.from({ length: k }, () => ({ ...ins }));
  if (w.onBar) {
    if (rInt && rInt > 0) added.push({ ...ins, num: rInt });
    else if (rInt === null) added.push(...(Math.round(r / ins.num) > 0 ? [{ ...ins }] : []));
    bars.splice(w.bar, 0, ...added);
  } else {
    // Au milieu d'une mesure : elle s'allonge d'un nombre entier de temps, ou des mesures entières suivent.
    if (rInt && rInt > 0 && w.onBeat) bars[w.bar] = { ...bars[w.bar], num: bars[w.bar].num + rInt };
    else if (rInt && rInt > 0) exact = false;
    bars.splice(w.bar + 1, 0, ...added);
  }
  return { ...fromBars(bars, shiftEvents(s.tempoEvents, w.onBar ? w.bar : w.bar + 1, added.length), gen), exact };
}

/** Anciens changements décalés (pour garder leurs ids). */
const shiftEvents = (events: TempoEvent[] | undefined, from: number, by: number): TempoEvent[] =>
  (events || []).map(e => (e.bar >= from ? { ...e, bar: e.bar + by } : e));

/** Tempo après la suppression de [start, end[. */
export function deleteTempoTime(s: TempoPart, start: number, end: number, gen: IdGen): TempoPart & { exact: boolean } {
  const map = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
  const a = where(map, start), b = where(map, end);
  const bars = toBars(map, sizeFor(s, b.bar + 1));
  if (a.onBar && b.onBar) {
    bars.splice(a.bar, b.bar - a.bar);
    return { ...fromBars(bars, shiftEvents((s.tempoEvents || []).filter(e => e.bar < a.bar || e.bar >= b.bar), b.bar, a.bar - b.bar), gen), exact: true };
  }
  if (a.onBeat && b.onBeat && (a.bar === b.bar || b.onBar || same(bars[a.bar], bars[b.bar]))) {
    // Mesure recollée : temps gardés avant `start` + temps gardés après `end`.
    const tail = b.onBar ? 0 : bars[b.bar].num - b.beatsIn;
    const keep = a.beatsIn + tail;
    const lastRemoved = b.onBar ? b.bar - 1 : b.bar;
    const removeCount = lastRemoved - a.bar + 1;
    const insert = keep > 0 ? [{ ...bars[a.bar], num: keep }] : [];
    bars.splice(a.bar, removeCount, ...insert);
    const kept = (s.tempoEvents || []).filter(e => e.bar <= a.bar || e.bar > lastRemoved);
    return { ...fromBars(bars, shiftEvents(kept, lastRemoved + 1, insert.length - removeCount), gen), exact: true };
  }
  // Repli : on retire le nombre de mesures le plus proche.
  const n = Math.round((end - start) / barSecOf(bars[a.bar]));
  if (n > 0) bars.splice(a.onBar ? a.bar : a.bar + 1, n);
  return { ...fromBars(bars, s.tempoEvents, gen), exact: false };
}

/** Section [start, end[ (sur des barres de mesure) recopiée à `to` (barre de mesure). */
function copyTempoSection(s: TempoPart, start: number, end: number, to: number, gen: IdGen): (TempoPart & { exact: boolean }) | null {
  const map = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
  const a = where(map, start), b = where(map, end), d = where(map, to);
  if (!a.onBar || !b.onBar || !d.onBar) return null;
  const bars = toBars(map, sizeFor(s, b.bar + 1, d.bar + 1));
  const piece = bars.slice(a.bar, b.bar).map(x => ({ ...x }));
  bars.splice(d.bar, 0, ...piece);
  return { ...fromBars(bars, shiftEvents(s.tempoEvents, d.bar, piece.length), gen), exact: true };
}

// ─── Opérations complètes ──────────────────────────────────────────────────────

const fmt = (sec: number) => `${(Math.round(sec * 1000) / 1000).toString().replace('.', ',')} s`;

function insertTime<S extends TimeState>(s: S, at: number, len: number, scope: TimeScope, rulers: boolean, gen: IdGen): { state: S; exact: boolean; n: number } {
  let n = 0;
  const tracks = s.tracks.map(t => {
    if (!inScope(scope, t)) return t;
    const clips = insertClipsTime(t.clips || [], at, len, gen);
    let nt: Track = clips.some((c, i) => c !== t.clips[i]) || clips.length !== t.clips.length ? { ...t, clips } : t;
    nt = mapLanes(nt, l => insertLaneTime(l.points, at, len, gen));
    if (nt !== t) n++;
    return nt;
  });
  let out: S = { ...s, tracks };
  let exact = true;
  if (rulers) {
    const tp = insertTempoTime(s, at, len, gen);
    exact = tp.exact;
    out = {
      ...out, markers: insertMarkersTime(s.markers || [], at, len), chords: insertChordsTime(s.chords || [], at, len, gen),
      bpm: tp.bpm, timeSignature: tp.timeSignature, tempoEvents: tp.tempoEvents,
      loopStart: s.loopStart >= at - EPS ? s.loopStart + len : s.loopStart,
      loopEnd: s.loopEnd > at + EPS ? s.loopEnd + len : s.loopEnd,
    };
  }
  return { state: out, exact, n };
}

function deleteTime<S extends TimeState>(s: S, a: number, b: number, scope: TimeScope, rulers: boolean, gen: IdGen): { state: S; exact: boolean; n: number } {
  let n = 0;
  const tracks = s.tracks.map(t => {
    if (!inScope(scope, t)) return t;
    const clips = deleteClipsTime(t.clips || [], a, b, gen);
    let nt: Track = clips.length !== t.clips.length || clips.some((c, i) => c !== t.clips[i]) ? { ...t, clips } : t;
    nt = mapLanes(nt, l => deleteLaneTime(l.points, a, b, gen));
    if (nt !== t) n++;
    return nt;
  });
  let out: S = { ...s, tracks };
  let exact = true;
  if (rulers) {
    const len = b - a;
    const tp = deleteTempoTime(s, a, b, gen);
    exact = tp.exact;
    const shift = (x: number) => (x >= b ? x - len : x > a ? a : x);
    out = {
      ...out, markers: deleteMarkersTime(s.markers || [], a, b), chords: deleteChordsTime(s.chords || [], a, b),
      bpm: tp.bpm, timeSignature: tp.timeSignature, tempoEvents: tp.tempoEvents,
      loopStart: shift(s.loopStart), loopEnd: Math.max(shift(s.loopStart), shift(s.loopEnd)),
    };
  }
  return { state: out, exact, n };
}

/** Duplique la section [a, b[ à `to` (un blanc s'ouvre à `to`, puis tout est recopié dedans). */
function copySection<S extends TimeState>(s: S, a: number, b: number, to: number, gen: IdGen): { state: S; exact: boolean; n: number } {
  const len = b - a;
  // Tempo de la section recopié (barres de mesure), sinon un blanc au tempo de `to`.
  const tempo = copyTempoSection(s, a, b, to, gen);
  const opened = insertTime({ ...s }, to, len, 'all', true, gen);
  let st = opened.state;
  if (tempo) st = { ...st, bpm: tempo.bpm, timeSignature: tempo.timeSignature, tempoEvents: tempo.tempoEvents };
  let n = 0;
  const tracks = st.tracks.map((t, i) => {
    if (t.id === 'master') return t;
    const src = s.tracks[i];
    const piece = extractRange(src.clips || [], a, b, gen).map(c => ({ ...c, id: gen(c.id), start: c.start + to }));
    let nt: Track = piece.length ? { ...t, clips: [...t.clips, ...piece] } : t;
    if (src.automationLanes?.some(l => l.points?.length)) {
      nt = { ...nt, automationLanes: nt.automationLanes.map((l, li) => {
        const sl = src.automationLanes[li];
        if (!sl?.points?.length || sl.id !== l.id) return l;
        return { ...l, points: placeLanePiece(l.points, sliceLanePoints(sl.points, a, b, gen), to, len, gen) };
      }) };
    }
    if (nt !== t) n++;
    return nt;
  });
  // Accords et repères de la section, recopiés.
  const chords = [...(st.chords || [])];
  for (const c of s.chords || []) {
    const cs = Math.max(c.start, a), ce = Math.min(c.end, b);
    if (ce - cs > 1e-3) chords.push({ ...c, id: gen(c.id), start: cs - a + to, end: ce - a + to });
  }
  chords.sort((x, y) => x.start - y.start);
  const markers = [...(st.markers || [])];
  for (const m of s.markers || []) {
    if (m.time < a - EPS || m.time >= b - EPS) continue;
    const copy: Marker = { ...m, id: gen(m.id), time: m.time - a + to, number: nextMarkerNumber(markers) };
    if (m.endTime !== undefined) copy.endTime = Math.min(m.endTime, b) - a + to;
    markers.push(copy);
  }
  return { state: { ...st, tracks, chords, markers }, exact: !!tempo || opened.exact, n };
}

/** Applique une opération sur le temps. */
export function applyTimeOp<S extends TimeState>(s: S, op: TimeOp): { state: S; report: TimeOpReport } {
  const gen = opIdGen(op.id);
  if (op.kind === 'insert') {
    const r = insertTime(s, Math.max(0, op.at), Math.max(0, op.length), op.tracks, op.rulers, gen);
    return { state: r.state, report: { exactTempo: r.exact, tracks: r.n, summary: `Temps inséré : ${fmt(op.length)} à ${fmt(op.at)}` } };
  }
  if (op.kind === 'delete') {
    const a = Math.max(0, Math.min(op.start, op.end)), b = Math.max(op.start, op.end);
    const r = deleteTime(s, a, b, op.tracks, op.rulers, gen);
    return { state: r.state, report: { exactTempo: r.exact, tracks: r.n, summary: `Temps supprimé : ${fmt(b - a)} à ${fmt(a)}` } };
  }
  const a = Math.max(0, Math.min(op.start, op.end)), b = Math.max(op.start, op.end);
  const to = Math.max(0, op.to);
  const len = b - a;
  if (!(len > 1e-3) || (to > a + EPS && to < b - EPS)) {
    return { state: s, report: { exactTempo: true, tracks: 0, summary: 'Rien à faire : la destination est dans la section' } };
  }
  const c = copySection(s, a, b, to, gen);
  if (op.mode === 'copy') return { state: c.state, report: { exactTempo: c.exact, tracks: c.n, summary: `Section dupliquée à ${fmt(to)}` } };
  // Déplacer = dupliquer puis supprimer l'original (qui a reculé si la copie est avant lui).
  const oa = a >= to - EPS ? a + len : a;
  const d = deleteTime(c.state, oa, oa + len, 'all', true, gen);
  return { state: d.state, report: { exactTempo: c.exact && d.exact, tracks: Math.max(c.n, d.n), summary: `Section déplacée à ${fmt(to > a ? to - len : to)}` } };
}

// ─── Sections (repères Couplet / Refrain…) ─────────────────────────────────────

export interface Section { id: string; name: string; start: number; end: number; color: string; markerId: string }

/** Fin du morceau : dernier clip, dernier repère de région. */
export function songEnd(s: Pick<TimeState, 'tracks' | 'markers'>): number {
  let e = 0;
  for (const t of s.tracks) for (const c of t.clips || []) e = Math.max(e, c.start + c.duration);
  for (const m of s.markers || []) e = Math.max(e, m.endTime ?? m.time);
  return e;
}

/**
 * Sections de la piste Arrangement : une région = une section ; un repère
 * simple ouvre une section qui va jusqu'au repère suivant (ou la fin du morceau).
 */
export function sectionsOf(s: Pick<TimeState, 'tracks' | 'markers'>): Section[] {
  const ms = [...(s.markers || [])].sort((a, b) => a.time - b.time);
  const end = songEnd(s);
  const out: Section[] = [];
  ms.forEach((m, i) => {
    const next = ms.slice(i + 1).find(x => x.time > m.time + EPS);
    const e = m.type === 'REGION' && m.endTime !== undefined ? m.endTime : (next ? next.time : end);
    if (e - m.time > 1e-3) out.push({ id: m.id, name: m.name, start: m.time, end: e, color: m.color, markerId: m.id });
  });
  return out;
}

/** Point de dépôt le plus proche : bords de sections et fin du morceau. */
export function nearestDrop(sections: Section[], t: number, songEndTime: number): number {
  const pts = new Set<number>([0, songEndTime]);
  sections.forEach(x => { pts.add(x.start); pts.add(x.end); });
  let best = 0, bd = Infinity;
  pts.forEach(p => { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } });
  return best;
}

// ─── Collaboration ─────────────────────────────────────────────────────────────

const num = (v: unknown, lo = 0, hi = 86400) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);

/** Opération reçue vérifiée (rien d'autre ne passe). */
export function sanitizeTimeOp(raw: unknown): TimeOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.slice(0, 40) : '';
  if (!id) return null;
  const scope = (v: unknown): TimeScope | null => (v === 'all' ? 'all' : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 400) : null);
  if (r.kind === 'insert') {
    const at = num(r.at), length = num(r.length, 0, 3600), tracks = scope(r.tracks);
    if (at === null || length === null || !tracks) return null;
    return { kind: 'insert', id, at, length, tracks, rulers: !!r.rulers };
  }
  if (r.kind === 'delete') {
    const start = num(r.start), end = num(r.end), tracks = scope(r.tracks);
    if (start === null || end === null || !tracks) return null;
    return { kind: 'delete', id, start, end, tracks, rulers: !!r.rulers };
  }
  if (r.kind === 'section') {
    const start = num(r.start), end = num(r.end), to = num(r.to);
    if (start === null || end === null || to === null || (r.mode !== 'move' && r.mode !== 'copy')) return null;
    return { kind: 'section', id, mode: r.mode, start, end, to };
  }
  return null;
}
