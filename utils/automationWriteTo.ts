import type { AutomationLane, AutomationPoint, Track } from '../types';
import { findLane, laneDisplayName, newLane, paramSpec, sortedPoints, staticParamValue, valueAtPoints } from './automationWrite';
import { RANGE_RAMP } from './automationRange';

/**
 * « Écrire l'automation sur la sélection » (Pro Tools : Édition › Automation ›
 * Write to Current, Ctrl+/ ; Write to All Enabled, Ctrl+Alt+/).
 *
 * Geste type de l'ingé : à l'arrêt, il pose une plage (le refrain), règle le
 * fader (ou le pan, un envoi, un effet) à l'oreille, puis écrit CETTE valeur sur
 * toute la plage d'un raccourci. La courbe hors de la plage ne bouge pas ; une
 * rampe courte (10 ms) à chaque bord évite le clic.
 *
 * Module pur : tests/automationWriteTo.test.ts.
 */

let seq = 0;
const pid = () => `wt-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Remplace la courbe sur [a, b] par `value` (palier), avec des points d'ancrage
 * juste avant / après (valeur d'origine) : le reste du morceau garde sa courbe.
 * `base` : valeur quand la voie n'a encore aucun point (réglage statique).
 */
export function writeValueOnRange(points: AutomationPoint[] | undefined, a: number, b: number, value: number, base: number): AutomationPoint[] {
  const s = Math.max(0, Math.min(a, b));
  const e = Math.max(a, b);
  const pts = sortedPoints(points).length ? sortedPoints(points) : [{ id: pid(), time: 0, value: base }];
  if (e - s < 1e-4 || !Number.isFinite(value)) return pts;
  const at = (t: number) => valueAtPoints(pts, t, base);
  const preT = s - RANGE_RAMP;
  const postT = e + RANGE_RAMP;
  const kept = pts.filter(p => p.time < Math.max(0, preT) - 1e-9 || p.time > postT + 1e-9);
  const added: AutomationPoint[] = [];
  if (preT > 1e-6) added.push({ id: pid(), time: preT, value: at(preT) });
  added.push({ id: pid(), time: s, value });
  added.push({ id: pid(), time: e, value });
  added.push({ id: pid(), time: postT, value: at(postT) });
  return [...kept, ...added].sort((p, q) => p.time - q.time);
}

export interface WriteToResult {
  track: Track;
  /** Paramètres écrits (« volume », « send::verb »…). */
  params: string[];
}

/** Écrit la valeur actuelle (réglage du fader / potard / effet) de `param` sur la plage. */
export function writeParamToRange(track: Track, param: string, a: number, b: number): WriteToResult {
  const value = staticParamValue(track, param);
  if (value === null || !Number.isFinite(value) || Math.abs(b - a) < 1e-4) return { track, params: [] };
  const lanes = track.automationLanes || [];
  const existing = findLane(track, param);
  const spec = paramSpec(param, value);
  const points = writeValueOnRange(existing?.points, a, b, value, value);
  const lane: AutomationLane = existing
    ? { ...existing, points, isExpanded: true, min: Math.min(existing.min, spec.min, value), max: Math.max(existing.max, spec.max, value) }
    : { ...newLane(param, track.color || '#00f2ff', spec), points, isExpanded: true };
  return {
    track: { ...track, automationLanes: existing ? lanes.map(l => (l === existing ? lane : l)) : [...lanes, lane] },
    params: [param],
  };
}

/**
 * Pro Tools « Write to All Enabled » : tous les paramètres qui ont déjà une
 * courbe sur la piste, plus le volume (toujours activé).
 */
export function writeAllToRange(track: Track, a: number, b: number): WriteToResult {
  const names = new Set<string>(['volume']);
  for (const l of track.automationLanes || []) if (l.points.length && staticParamValue(track, l.parameterName) !== null) names.add(l.parameterName);
  let t = track;
  const params: string[] = [];
  for (const n of names) {
    const r = writeParamToRange(t, n, a, b);
    if (r.params.length) { t = r.track; params.push(n); }
  }
  return { track: t, params };
}

/** Paramètres qu'on peut écrire sur une piste (menu « Écrire sur la sélection »). */
export function writableParams(track: Track): { param: string; label: string }[] {
  const out: { param: string; label: string }[] = [{ param: 'volume', label: 'Volume' }, { param: 'pan', label: 'Pan' }];
  for (const s of track.sends || []) out.push({ param: `send::${s.id}`, label: laneDisplayName(`send::${s.id}`, track) });
  for (const l of track.automationLanes || []) {
    if (out.some(o => o.param === l.parameterName) || staticParamValue(track, l.parameterName) === null) continue;
    out.push({ param: l.parameterName, label: laneDisplayName(l.parameterName, track) });
  }
  return out;
}

/** Valeur lisible pour le message (« −6,0 dB », « G 30 », « 0,42 »). */
export function fmtParamValue(param: string, v: number): string {
  if (param === 'volume' || param.startsWith('send::')) {
    if (v <= 1e-6) return '−∞ dB';
    const db = 20 * Math.log10(v);
    return `${db > 0.05 ? '+' : db < -0.05 ? '−' : ''}${Math.abs(db).toFixed(1).replace('.', ',')} dB`;
  }
  if (param === 'pan') return Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v) * 100)}`;
  return (Math.round(v * 100) / 100).toString().replace('.', ',');
}
