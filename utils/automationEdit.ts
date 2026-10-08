import type { AutomationLane, AutomationPoint, Track } from '../types';
import { parsePluginParam, sortedPoints, valueAtPoints } from './automationWrite';

/**
 * R8 · Copier / coller l'automation d'une plage, et automation qui suit les
 * clips (Pro Tools : « Automation Follows Edit », préférence activée par défaut).
 *
 * Logique pure sur les voies d'automation (aucun React, aucun Web Audio) :
 *  - copyAutomationRange : la courbe de [début, fin[ de chaque voie, en temps
 *    relatifs, avec ses valeurs aux deux bords (une rampe coupée en deux reste
 *    exacte) ;
 *  - pasteAutomationRange : remplace la courbe de [à, à + longueur] par le
 *    morceau copié ; avant et après, la courbe d'origine ne bouge pas (points
 *    d'ancrage aux bords) ;
 *  - clearAutomationRange : la plage n'a plus de point ; la courbe va en ligne
 *    droite de la valeur au début à la valeur à la fin ;
 *  - moveAutomationWithClips : un clip déplacé (dans le temps ou vers une
 *    autre piste) emporte la courbe de sa durée ; là où il était, la courbe se
 *    referme en ligne droite.
 */

/** Écart minimal entre un ancrage et le point voisin (s). */
const EPS = 1e-4;

export interface AutomationClipLane {
  parameterName: string;
  min: number;
  max: number;
  color?: string;
  /** Points en temps relatifs au début de la plage (0 … length), triés, ancrés aux bords. */
  points: AutomationPoint[];
}

export interface AutomationClipboard {
  length: number;
  /** Piste d'origine (les voies d'effets ne se collent que sur la même piste ou un effet du même type). */
  trackId: string;
  lanes: AutomationClipLane[];
  /** Effet de chaque voie d'effet (type), pour coller sur un effet du même type d'une autre piste. */
  pluginTypes?: Record<string, string>;
}

let uid = 0;
const nid = (tag: string) => `ae-${tag}-${Date.now().toString(36)}${(uid++).toString(36)}`;

/** Morceau de courbe de [start, end] en temps relatifs, ancré aux deux bords. */
export function sliceLane(points: AutomationPoint[], start: number, end: number): AutomationPoint[] {
  const pts = sortedPoints(points);
  if (!pts.length || end <= start) return [];
  const out: AutomationPoint[] = [];
  const at = (t: number) => valueAtPoints(pts, t, pts[0].value);
  out.push({ id: nid('a'), time: 0, value: at(start), curveType: curveAt(pts, start) });
  for (const p of pts) {
    if (p.time > start + EPS && p.time < end - EPS) out.push({ ...p, id: nid('c'), time: p.time - start });
  }
  out.push({ id: nid('z'), time: end - start, value: at(end), curveType: curveAt(pts, end) });
  return out;
}

/** Courbe du segment qui contient `t` (celle du point qui le commence). */
function curveAt(pts: AutomationPoint[], t: number): AutomationPoint['curveType'] {
  let c: AutomationPoint['curveType'] = pts[0]?.curveType;
  for (const p of pts) { if (p.time <= t) c = p.curveType; else break; }
  return c;
}

/**
 * Remplace la courbe de [at, at + len] par `piece` (temps relatifs). Hors de la
 * plage, la courbe d'origine est gardée telle quelle : un ancrage à la valeur
 * d'origine est posé juste avant et juste après.
 */
export function replaceRange(points: AutomationPoint[], piece: AutomationPoint[], at: number, len: number): AutomationPoint[] {
  const pts = sortedPoints(points);
  const end = at + len;
  const out: AutomationPoint[] = [];
  if (pts.length) {
    const before = pts.filter(p => p.time < at - EPS);
    const after = pts.filter(p => p.time > end + EPS);
    out.push(...before);
    // Ancrages : la courbe d'origine jusqu'au bord, puis le morceau collé.
    if (at > EPS) out.push({ id: nid('l'), time: at - EPS, value: valueAtPoints(pts, at - EPS, pts[0].value), curveType: 'LINEAR' });
    out.push(...piece.map(p => ({ ...p, id: nid('p'), time: at + p.time })));
    out.push({ id: nid('r'), time: end + EPS, value: valueAtPoints(pts, end + EPS, pts[0].value), curveType: curveAt(pts, end + EPS) });
    out.push(...after);
  } else {
    out.push(...piece.map(p => ({ ...p, id: nid('p'), time: at + p.time })));
  }
  return dedupe(out);
}

/** Trie et retire les points confondus (même instant et même valeur). */
function dedupe(points: AutomationPoint[]): AutomationPoint[] {
  const s = points.filter(p => p.time >= 0).sort((a, b) => a.time - b.time);
  const out: AutomationPoint[] = [];
  for (const p of s) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.time - p.time) < 1e-9 && Math.abs(q.value - p.value) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

/** Copie l'automation de [start, end[ de toutes les voies (avec points) d'une piste. */
export function copyAutomationRange(track: Pick<Track, 'id' | 'automationLanes' | 'plugins'>, start: number, end: number): AutomationClipboard | null {
  if (!(end > start)) return null;
  const lanes: AutomationClipLane[] = [];
  const pluginTypes: Record<string, string> = {};
  for (const l of track.automationLanes || []) {
    if (!l.points?.length) continue;
    lanes.push({ parameterName: l.parameterName, min: l.min, max: l.max, color: l.color, points: sliceLane(l.points, start, end) });
    const pp = parsePluginParam(l.parameterName);
    const pl = pp && (track.plugins || []).find(x => x.id === pp.pluginId);
    if (pl) pluginTypes[l.parameterName] = pl.type;
  }
  return lanes.length ? { length: end - start, trackId: track.id, lanes, pluginTypes } : null;
}

/**
 * Voie de destination d'une voie copiée : même nom ; sur une autre piste, un
 * réglage d'effet va sur le 1er effet du même type (sinon il est ignoré).
 */
function targetName(track: Pick<Track, 'id' | 'plugins'>, clip: AutomationClipboard, name: string): string | null {
  const pp = parsePluginParam(name);
  if (!pp || track.id === clip.trackId) return name;
  const type = clip.pluginTypes?.[name];
  const pl = type && (track.plugins || []).find(x => x.type === type && !x.isInactive);
  return pl ? `plugin::${pl.id}::${pp.key}` : null;
}

/** Colle le presse-papiers d'automation à `at` (une étape pour toutes les voies). Crée les voies manquantes. */
export function pasteAutomationRange<T extends Pick<Track, 'id' | 'automationLanes' | 'plugins' | 'color'>>(track: T, clip: AutomationClipboard, at: number): { track: T; pasted: number; skipped: string[] } {
  const lanes = [...(track.automationLanes || [])];
  let pasted = 0;
  const skipped: string[] = [];
  for (const cl of clip.lanes) {
    const name = targetName(track, clip, cl.parameterName);
    if (!name) { skipped.push(cl.parameterName); continue; }
    const i = lanes.findIndex(l => l.parameterName === name);
    if (i >= 0) {
      lanes[i] = { ...lanes[i], points: replaceRange(lanes[i].points || [], cl.points, at, clip.length), isExpanded: true };
    } else {
      lanes.push({ id: nid('lane'), parameterName: name, points: replaceRange([], cl.points, at, clip.length), color: cl.color || track.color, isExpanded: true, min: cl.min, max: cl.max } as AutomationLane);
    }
    pasted++;
  }
  return { track: { ...track, automationLanes: lanes }, pasted, skipped };
}

/** Efface les points de [start, end] de chaque voie (ligne droite entre les valeurs aux bords). */
export function clearAutomationRange<T extends Pick<Track, 'automationLanes'>>(track: T, start: number, end: number): T {
  if (!(end > start)) return track;
  const lanes = (track.automationLanes || []).map(l => {
    if (!l.points?.length) return l;
    const pts = sortedPoints(l.points);
    const inside = pts.some(p => p.time >= start && p.time <= end);
    if (!inside) return l;
    const v0 = valueAtPoints(pts, start, pts[0].value), v1 = valueAtPoints(pts, end, pts[0].value);
    return { ...l, points: replaceRange(pts, [{ id: nid('s'), time: 0, value: v0, curveType: 'LINEAR' }, { id: nid('e'), time: end - start, value: v1, curveType: curveAt(pts, end) }], start, end - start) };
  });
  return { ...track, automationLanes: lanes };
}

export interface ClipMove {
  clipId: string;
  fromTrackId: string;
  toTrackId: string;
  /** Début et durée AVANT le déplacement. */
  fromStart: number;
  duration: number;
  /** Début APRÈS le déplacement. */
  toStart: number;
}

/**
 * Automation qui suit les clips déplacés : la courbe de [fromStart, fromStart
 * + durée] part avec le clip (vers toStart, sur la piste d'arrivée) ; à
 * l'ancienne place, elle se referme en ligne droite. Les voies d'effets ne
 * suivent un clip vers une autre piste que si celle-ci porte un effet du même
 * type. Une seule transformation des pistes (une étape d'annulation).
 */
export function moveAutomationWithClips<T extends Pick<Track, 'id' | 'automationLanes' | 'plugins' | 'color'>>(tracks: T[], moves: ClipMove[]): T[] {
  const real = moves.filter(m => m.duration > 0 && (Math.abs(m.toStart - m.fromStart) > 1e-6 || m.fromTrackId !== m.toTrackId));
  if (!real.length) return tracks;
  const byId = new Map(tracks.map(t => [t.id, t] as const));
  // 1. Morceaux pris sur l'état d'avant (plusieurs clips d'une même piste : chacun le sien).
  const pieces = real.map(m => {
    const src = byId.get(m.fromTrackId);
    return { m, clip: src ? copyAutomationRange(src, m.fromStart, m.fromStart + m.duration) : null };
  }).filter(x => x.clip);
  if (!pieces.length) return tracks;
  // 2. Places libérées : refermées.
  for (const { m } of pieces) {
    const t = byId.get(m.fromTrackId);
    if (t) byId.set(t.id, clearAutomationRange(t, m.fromStart, m.fromStart + m.duration));
  }
  // 3. Morceaux collés à la nouvelle place.
  for (const { m, clip } of pieces) {
    const t = byId.get(m.toTrackId);
    if (t) byId.set(t.id, pasteAutomationRange(t, clip!, Math.max(0, m.toStart)).track);
  }
  return tracks.map(t => byId.get(t.id) || t);
}
