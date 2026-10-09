import { describe, expect, it } from 'vitest';
import { trimVolumeRange, parseDb, fmtDb, RANGE_RAMP } from '../utils/automationRange';
import { valueAtPoints } from '../utils/automationWrite';

const db = (g: number) => 20 * Math.log10(g);
const track = (extra: any = {}) => ({ volume: 1, color: '#0ff', automationLanes: [] as any[], ...extra });
const vol = (t: any) => t.automationLanes.find((l: any) => l.parameterName === 'volume');
const at = (t: any, s: number) => valueAtPoints([...vol(t).points].sort((a: any, b: any) => a.time - b.time), s, t.volume);

describe('Volume de la plage (+N dB sur le refrain, comme le Trim de Pro Tools)', () => {
  it('sans voie : la crée (dépliée), +2 dB exacts dans la plage, rien ailleurs, rampes de 10 ms', () => {
    const r = trimVolumeRange(track(), 6.857, 13.714, 2);
    const t = r.track;
    expect(vol(t).isExpanded).toBe(true);
    expect(db(at(t, 8))).toBeCloseTo(2, 6);
    expect(db(at(t, 6.857))).toBeCloseTo(2, 6);
    expect(db(at(t, 13.714))).toBeCloseTo(2, 6);
    expect(at(t, 6.857 - RANGE_RAMP)).toBeCloseTo(1, 9);
    expect(at(t, 3)).toBeCloseTo(1, 9);
    expect(at(t, 20)).toBeCloseTo(1, 9);
    expect(r.clamped).toBe(false);
  });

  it('garde les mouvements existants dans la plage (tous montés) et ceux d’à côté', () => {
    const lanes = [{ id: 'v', parameterName: 'volume', color: '#0ff', isExpanded: false, min: 0, max: 1.5,
      points: [{ id: 'a', time: 0, value: 1 }, { id: 'b', time: 8, value: 0.5 }, { id: 'c', time: 12, value: 1 }, { id: 'd', time: 16, value: 0.8 }] }];
    const t = trimVolumeRange(track({ automationLanes: lanes }), 7, 13, -3).track;
    const p = vol(t).points;
    expect(db(p.find((x: any) => x.id === 'b').value) - db(0.5)).toBeCloseTo(-3, 6);
    expect(db(p.find((x: any) => x.id === 'c').value)).toBeCloseTo(-3, 6);
    expect(p.find((x: any) => x.id === 'd').value).toBe(0.8);
    expect(at(t, 7 - RANGE_RAMP)).toBeCloseTo(valueAtPoints(lanes[0].points, 7 - RANGE_RAMP, 1), 9);
  });

  it('appliqué deux fois : les dB s’additionnent, sans points en double aux bords', () => {
    const t1 = trimVolumeRange(track(), 4, 8, 2).track;
    const t2 = trimVolumeRange(t1, 4, 8, 1).track;
    expect(db(at(t2, 6))).toBeCloseTo(3, 6);
    expect(at(t2, 2)).toBeCloseTo(1, 9);
    const times = vol(t2).points.map((x: any) => x.time);
    expect(new Set(times).size).toBe(times.length);
  });

  it('plafonné au maximum de la voie (+3,5 dB) et signalé', () => {
    const r = trimVolumeRange(track(), 1, 2, 12);
    expect(r.clamped).toBe(true);
    expect(at(r.track, 1.5)).toBeCloseTo(1.5, 9);
  });

  it('plage à 0 s : pas de point avant le début', () => {
    const t = trimVolumeRange(track(), 0, 2, -6).track;
    expect(vol(t).points[0].time).toBe(0);
    expect(db(at(t, 0))).toBeCloseTo(-6, 6);
  });

  it('saisie et affichage des dB', () => {
    expect(parseDb('+2')).toBe(2);
    expect(parseDb('−1,5 dB')).toBe(-1.5);
    expect(parseDb('abc')).toBeNull();
    expect(fmtDb(2)).toBe('+2 dB');
    expect(fmtDb(-1.5)).toBe('−1,5 dB');
  });
});
