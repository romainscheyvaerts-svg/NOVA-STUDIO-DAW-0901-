import { describe, expect, it } from 'vitest';
import { enabledParams, glideAll, glideParam, glidePoints, spanRange, writeAllToSpan, writeParamToSpan, writeValueOnSpan } from '../utils/automationSpan';
import { valueAtPoints } from '../utils/automationWrite';
import { makeTrack } from './helpers/fixtures';
import type { AutomationLane } from '../types';

const v = (pts: { time: number; value: number }[], t: number) => valueAtPoints(pts as any, t, NaN);
const lane = (name: string, points: [number, number][], extra: Partial<AutomationLane> = {}): AutomationLane =>
  ({ id: `l-${name}`, parameterName: name, points: points.map(([time, value], i) => ({ id: `${name}${i}`, time, value })), color: '#fff', isExpanded: false, min: 0, max: 1.5, ...extra });

describe('Write to Start / End / All / Punch : étendue visée', () => {
  const ctx = { sel: { start: 4, end: 8 }, playhead: 2, songEnd: 60, punch: { punchIn: 10, punchOut: 14 } };
  it('Start : du début à la fin de la sélection ; sans sélection : jusqu’à la tête de lecture', () => {
    expect(spanRange('start', ctx)).toEqual({ a: 0, b: 8 });
    expect(spanRange('start', { ...ctx, sel: null })).toEqual({ a: 0, b: 2 });
    expect(spanRange('start', { ...ctx, sel: null, playhead: 0 })).toBeNull();
  });
  it('End : du début de la sélection (ou de la tête) jusqu’au bout ; All : tout ; Punch : la zone de punch', () => {
    expect(spanRange('end', ctx)).toEqual({ a: 4, b: Infinity });
    expect(spanRange('end', { ...ctx, sel: null })).toEqual({ a: 2, b: Infinity });
    expect(spanRange('all', ctx)).toEqual({ a: 0, b: Infinity });
    expect(spanRange('punch', ctx)).toEqual({ a: 10, b: 14 });
    expect(spanRange('punch', { ...ctx, punch: { punchIn: 3, punchOut: 3 } })).toBeNull();
    expect(spanRange('punch', { ...ctx, punch: { punchIn: 9, punchOut: 5 } })).toEqual({ a: 5, b: 9 });
  });
});

describe('écrire la valeur actuelle sur une étendue', () => {
  const before = [{ id: 'a', time: 0, value: 0.5 }, { id: 'b', time: 10, value: 1 }, { id: 'c', time: 20, value: 0.2 }];
  it('jusqu’au bout : palier tenu, plus aucun point après, la courbe d’avant ne bouge pas', () => {
    const pts = writeValueOnSpan(before, 5, Infinity, 0.3, 1);
    expect(v(pts, 2)).toBeCloseTo(v(before, 2), 6);
    expect(v(pts, 4.99)).toBeCloseTo(v(before, 4.99), 6);
    expect(v(pts, 5)).toBe(0.3);
    expect(v(pts, 15)).toBe(0.3);
    expect(v(pts, 500)).toBe(0.3);
    expect(pts.every(p => p.time <= 5)).toBe(true);
  });
  it('tout le morceau : un seul point, courbe plate', () => {
    const pts = writeValueOnSpan(before, 0, Infinity, 0.4, 1);
    expect(pts).toHaveLength(1);
    expect(v(pts, 0)).toBe(0.4);
    expect(v(pts, 99)).toBe(0.4);
  });
  it('Write to Start (0 → 8) : palier du début à 8 s, rampe de 10 ms, la suite intacte', () => {
    const pts = writeValueOnSpan(before, 0, 8, 0.25, 1);
    expect(v(pts, 0)).toBe(0.25);
    expect(v(pts, 8)).toBe(0.25);
    expect(v(pts, 8.01)).toBeCloseTo(v(before, 8.01), 6);
    expect(v(pts, 15)).toBeCloseTo(v(before, 15), 6);
  });
  it('sur une piste : la valeur du fader, la voie créée et dépliée ; Punch = la zone', () => {
    const t = makeTrack({ volume: 0.5, automationLanes: [lane('volume', [[0, 1], [30, 1]])] });
    const r = writeParamToSpan(t, 'volume', 10, 14);
    const l = r.track.automationLanes.find(x => x.parameterName === 'volume')!;
    expect(r.params).toEqual(['volume']);
    expect(l.isExpanded).toBe(true);
    expect(v(l.points, 12)).toBe(0.5);
    expect(v(l.points, 9)).toBe(1);
    expect(v(l.points, 20)).toBe(1);
  });
  it('tous les réglages activés jusqu’à la fin : volume + voies qui ont une courbe', () => {
    const t = makeTrack({ volume: 0.7, pan: -0.5, automationLanes: [lane('pan', [[0, 0.4]], { min: -1, max: 1 })] });
    expect(enabledParams(t).sort()).toEqual(['pan', 'volume']);
    const r = writeAllToSpan(t, 3, Infinity);
    expect(r.params.sort()).toEqual(['pan', 'volume']);
    const at = (n: string, x: number) => v(r.track.automationLanes.find(l => l.parameterName === n)!.points, x);
    expect(at('pan', 1)).toBeCloseTo(0.4);
    expect(at('pan', 50)).toBeCloseTo(-0.5);
    expect(at('volume', 50)).toBeCloseTo(0.7);
  });
  it('réglage absent ou étendue vide : rien', () => {
    const t = makeTrack();
    expect(writeParamToSpan(t, 'send::inconnu', 0, 5).params).toEqual([]);
    expect(writeParamToSpan(t, 'volume', 4, 4).params).toEqual([]);
  });
});

describe('Glide', () => {
  // Palier écrit (Ctrl+/) : 1 jusqu'à 4 s, 0,25 de 4 à 8 s, puis 1.
  const step = [{ id: 'a', time: 0, value: 1 }, { id: 'b', time: 3.99, value: 1 }, { id: 'c', time: 4, value: 0.25 }, { id: 'd', time: 8, value: 0.25 }, { id: 'e', time: 8.01, value: 1 }];
  it('entre deux points : rampe droite de la valeur du début à celle de la fin, points intermédiaires retirés', () => {
    const pts = glidePoints(step, 2, 6, 1);
    expect(v(pts, 2)).toBeCloseTo(1, 6);
    expect(v(pts, 4)).toBeCloseTo(1 + (0.25 - 1) * 0.5, 6);
    expect(v(pts, 6)).toBeCloseTo(0.25, 6);
    expect(v(pts, 7)).toBeCloseTo(0.25, 6);
    expect(v(pts, 9)).toBe(1);
    expect(pts.filter(p => p.time > 2 && p.time < 6)).toHaveLength(0);
  });
  it('vers la valeur actuelle : arrive sur le fader à la fin, puis la courbe reprend en 10 ms', () => {
    const pts = glidePoints(step, 10, 14, 1, 0.5);
    expect(v(pts, 10)).toBe(1);
    expect(v(pts, 12)).toBeCloseTo(0.75, 6);
    expect(v(pts, 14)).toBe(0.5);
    // Plus rien après dans la courbe d'origine : la valeur atteinte tient.
    expect(v(pts, 30)).toBe(0.5);
    const withAfter = [...step, { id: 'f', time: 40, value: 0.8 }];
    const p2 = glidePoints(withAfter, 10, 14, 1, 0.5);
    expect(v(p2, 14.01)).toBeCloseTo(v(withAfter, 14.01), 6);
    expect(v(p2, 40)).toBe(0.8);
  });
  it('sur une piste : sans courbe, Glide ne fait rien ; Glide to Current crée la rampe vers le fader', () => {
    const t = makeTrack({ volume: 0.5 });
    expect(glideParam(t, 'volume', 1, 3, false).params).toEqual([]);
    // Fader = courbe partout : rien à glisser.
    expect(glideParam(t, 'volume', 1, 3, true).params).toEqual([]);
    const t2 = makeTrack({ volume: 0.5, automationLanes: [lane('volume', [[0, 1]])] });
    const r = glideParam(t2, 'volume', 1, 3, true);
    expect(r.params).toEqual(['volume']);
    const l = r.track.automationLanes.find(x => x.parameterName === 'volume')!;
    expect(v(l.points, 1)).toBe(1);
    expect(v(l.points, 2)).toBeCloseTo(0.75, 6);
    expect(v(l.points, 3)).toBe(0.5);
    expect(l.isExpanded).toBe(true);
  });
  it('tous les réglages activés', () => {
    const t = makeTrack({ volume: 0.5, pan: 0.2, automationLanes: [lane('volume', [[0, 1], [10, 0.4]]), lane('pan', [[0, -1], [10, 1]], { min: -1, max: 1 })] });
    const r = glideAll(t, 2, 4, false);
    expect(r.params.sort()).toEqual(['pan', 'volume']);
  });
});
