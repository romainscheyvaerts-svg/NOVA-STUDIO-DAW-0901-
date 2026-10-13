import type { AutomationLane, AutomationPoint, Track } from '../types';
import { findLane, newLane, paramSpec, sortedPoints, staticParamValue, valueAtPoints } from './automationWrite';
import { RANGE_RAMP } from './automationRange';
import { writeValueOnRange } from './automationWriteTo';

/**
 * Écrire l'automation sur une étendue et Glide (Pro Tools, menu Édition ›
 * Automation), à la suite de « Write to Current » (utils/automationWriteTo).
 *
 *  - Write to Start : la valeur actuelle du fader, du début du morceau jusqu'à
 *    la fin de la sélection (sans sélection : jusqu'à la tête de lecture) ;
 *  - Write to End : depuis le début de la sélection (ou la tête de lecture)
 *    jusqu'à la fin du morceau, tenue au-delà ;
 *  - Write to All : tout le morceau (la courbe devient plate) ;
 *  - Write to Punch : sur la zone de punch (punch in → punch out) ;
 *  - Glide : une rampe droite du début à la fin de la sélection, de la valeur
 *    de la courbe au début à sa valeur à la fin (les points entre les deux
 *    disparaissent) : la transition douce entre deux réglages ;
 *  - Glide to Current : même rampe, mais elle arrive sur la valeur ACTUELLE du
 *    fader à la fin de la sélection ; la courbe d'après reprend en 10 ms.
 *
 * Module pur (tests/automationSpan.test.ts) : une étape d'annulation par geste
 * côté appelant (hooks/useProToolsEcarts2).
 */

let seq = 0;
const pid = () => `ws-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export type WriteSpan = 'start' | 'end' | 'all' | 'punch';

export const SPAN_LABEL: Record<WriteSpan, string> = {
  start: 'du début du morceau à la fin de la sélection',
  end: 'du début de la sélection à la fin du morceau',
  all: 'sur tout le morceau',
  punch: 'sur la zone de punch',
};

export interface SpanContext {
  /** Sélection de plage (absente : la tête de lecture sert de repère). */
  sel?: { start: number; end: number } | null;
  playhead: number;
  /** Fin du morceau (dernier clip, dernier repère). */
  songEnd: number;
  punch?: { punchIn: number; punchOut: number } | null;
}

/**
 * Étendue visée [a, b] ; `b = Infinity` : jusqu'à la fin, tenue au-delà.
 * null : rien à écrire (zone de punch non posée, étendue vide).
 */
export function spanRange(kind: WriteSpan, c: SpanContext): { a: number; b: number } | null {
  const s = c.sel && c.sel.end - c.sel.start > 1e-4 ? c.sel : null;
  switch (kind) {
    case 'start': {
      const b = s ? s.end : c.playhead;
      return b > 1e-4 ? { a: 0, b } : null;
    }
    case 'end': {
      const a = Math.max(0, s ? s.start : c.playhead);
      return { a, b: Infinity };
    }
    case 'all':
      return { a: 0, b: Infinity };
    case 'punch': {
      const p = c.punch;
      if (!p || !Number.isFinite(p.punchIn) || !Number.isFinite(p.punchOut)) return null;
      const a = Math.min(p.punchIn, p.punchOut), b = Math.max(p.punchIn, p.punchOut);
      return b - a > 1e-3 ? { a: Math.max(0, a), b } : null;
    }
  }
  return null;
}

/**
 * Palier `value` sur [a, b] ; b = Infinity : de a jusqu'au bout (aucun point
 * après, la valeur tient). a = 0 et b = Infinity : courbe plate.
 */
export function writeValueOnSpan(points: AutomationPoint[] | undefined, a: number, b: number, value: number, base: number): AutomationPoint[] {
  if (!Number.isFinite(value)) return sortedPoints(points);
  if (Number.isFinite(b)) return writeValueOnRange(points, a, b, value, base);
  const s = Math.max(0, a);
  if (s < 1e-6) return [{ id: pid(), time: 0, value }];
  const pts = sortedPoints(points).length ? sortedPoints(points) : [{ id: pid(), time: 0, value: base }];
  const at = (t: number) => valueAtPoints(pts, t, base);
  const preT = s - RANGE_RAMP;
  const kept = pts.filter(p => p.time < Math.max(0, preT) - 1e-9);
  const added: AutomationPoint[] = [];
  if (preT > 1e-6) added.push({ id: pid(), time: preT, value: at(preT) });
  added.push({ id: pid(), time: s, value });
  return [...kept, ...added].sort((p, q) => p.time - q.time);
}

/**
 * Glide : rampe droite de a à b. `target` absent : de la valeur de la courbe
 * en a à sa valeur en b (Glide Automation) ; présent : jusqu'à `target` en b,
 * puis retour en 10 ms à la courbe d'origine (Glide to Current).
 */
export function glidePoints(points: AutomationPoint[] | undefined, a: number, b: number, base: number, target?: number): AutomationPoint[] {
  const s = Math.max(0, Math.min(a, b)), e = Math.max(a, b);
  const pts = sortedPoints(points).length ? sortedPoints(points) : [{ id: pid(), time: 0, value: base }];
  if (e - s < 1e-4) return pts;
  const at = (t: number) => valueAtPoints(pts, t, base);
  const va = at(s);
  const toCurrent = typeof target === 'number' && Number.isFinite(target);
  const vb = toCurrent ? (target as number) : at(e);
  const postT = e + RANGE_RAMP;
  const hi = toCurrent ? postT : e;
  const kept = pts.filter(p => p.time < s - 1e-9 || p.time > hi + 1e-9);
  const added: AutomationPoint[] = [{ id: pid(), time: s, value: va }, { id: pid(), time: e, value: vb }];
  if (toCurrent) {
    // Après la rampe : la courbe d'origine reprend (pas de point si elle n'a plus rien après).
    const after = pts.some(p => p.time > postT + 1e-9);
    added.push({ id: pid(), time: postT, value: after ? at(postT) : vb });
  }
  // Rampe droite : le point de départ est linéaire même si l'ancien point avait une courbe.
  return [...kept, ...added].sort((p, q) => p.time - q.time).map(p => (p.time === s && p.value === va ? { ...p, curveType: 'LINEAR' as const } : p));
}

export interface SpanResult {
  track: Track;
  /** Paramètres écrits (« volume », « pan »…). */
  params: string[];
}

const withLane = (track: Track, param: string, points: AutomationPoint[], sample: number): Track => {
  const lanes = track.automationLanes || [];
  const existing = findLane(track, param);
  const spec = paramSpec(param, sample);
  const vals = points.map(p => p.value);
  const lane: AutomationLane = existing
    ? { ...existing, points, isExpanded: true, min: Math.min(existing.min, spec.min, ...vals), max: Math.max(existing.max, spec.max, ...vals) }
    : { ...newLane(param, track.color || '#00f2ff', spec), points, isExpanded: true };
  return { ...track, automationLanes: existing ? lanes.map(l => (l === existing ? lane : l)) : [...lanes, lane] };
};

/** Paramètres « activés » : le volume, plus chaque voie qui a déjà une courbe (Pro Tools : All Enabled). */
export function enabledParams(track: Track): string[] {
  const names = new Set<string>(['volume']);
  for (const l of track.automationLanes || []) if (l.points.length && staticParamValue(track, l.parameterName) !== null) names.add(l.parameterName);
  return [...names];
}

/** Write to Start / End / All / Punch d'un paramètre (valeur actuelle du fader, du potard, de l'effet). */
export function writeParamToSpan(track: Track, param: string, a: number, b: number): SpanResult {
  const value = staticParamValue(track, param);
  if (value === null || !Number.isFinite(value) || !(b - a > 1e-4)) return { track, params: [] };
  const points = writeValueOnSpan(findLane(track, param)?.points, a, b, value, value);
  return { track: withLane(track, param, points, value), params: [param] };
}

/** Même chose sur tous les paramètres activés. */
export function writeAllToSpan(track: Track, a: number, b: number): SpanResult {
  let t = track;
  const params: string[] = [];
  for (const n of enabledParams(track)) {
    const r = writeParamToSpan(t, n, a, b);
    if (r.params.length) { t = r.track; params.push(n); }
  }
  return { track: t, params };
}

/**
 * Glide d'un paramètre sur [a, b]. Sans courbe (et sans Glide to Current
 * vers une autre valeur), rien ne change : params vide.
 */
export function glideParam(track: Track, param: string, a: number, b: number, toCurrent: boolean): SpanResult {
  const value = staticParamValue(track, param);
  if (value === null || !Number.isFinite(value) || Math.abs(b - a) < 1e-4) return { track, params: [] };
  const lane = findLane(track, param);
  const pts = lane?.points || [];
  const before = sortedPoints(pts);
  const at = (t: number) => valueAtPoints(before, t, value);
  if (!toCurrent && !before.length) return { track, params: [] };
  // Glide to Current sans rien à changer : la courbe est déjà sur la valeur actuelle de a à b.
  const inside = before.filter(p => p.time > Math.min(a, b) + 1e-9 && p.time < Math.max(a, b) - 1e-9);
  if (toCurrent && !inside.length && Math.abs(at(Math.max(a, b)) - value) < 1e-6 && Math.abs(at(Math.min(a, b)) - value) < 1e-6) return { track, params: [] };
  const points = glidePoints(pts, a, b, value, toCurrent ? value : undefined);
  return { track: withLane(track, param, points, value), params: [param] };
}

/** Glide sur tous les paramètres activés. */
export function glideAll(track: Track, a: number, b: number, toCurrent: boolean): SpanResult {
  let t = track;
  const params: string[] = [];
  for (const n of enabledParams(track)) {
    const r = glideParam(t, n, a, b, toCurrent);
    if (r.params.length) { t = r.track; params.push(n); }
  }
  return { track: t, params };
}
