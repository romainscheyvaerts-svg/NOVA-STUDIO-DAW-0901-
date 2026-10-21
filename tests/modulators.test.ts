import { describe, it, expect } from 'vitest';
import { TrackType, type AutomationLane, type Track } from '../types';
import { lfoAt, modulateLane, modulatedLanes, defaultModulator, sanitizeModulators, staticValueOf, type Modulator } from '../utils/modulators';
import { playedLanes, valueAtPoints } from '../utils/automationWrite';
import { buildTempoMap, quartersToTime } from '../utils/tempoMap';

const TS = { numerator: 4, denominator: 4 };
const lane = (parameterName: string, min: number, max: number, points: { time: number; value: number }[] = []): AutomationLane =>
  ({ id: `l-${parameterName}`, parameterName, color: '#fff', isExpanded: false, min, max, points: points.map((p, i) => ({ id: `p${i}`, ...p, curveType: 'LINEAR' })) } as AutomationLane);
const track = (lanes: AutomationLane[], modulators?: Modulator[], extra: Partial<Track> = {}): Track => ({
  id: 't', name: 't', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 0.8, pan: 0,
  outputTrackId: 'master', sends: [], clips: [], automationLanes: lanes, totalLatency: 0,
  plugins: [{ id: 'dj', name: 'DJ', type: 'DJFILTER', isEnabled: true, latency: 0, params: { filter: 0, output: 0 } } as any],
  ...(modulators ? { modulators } : {}), ...extra,
});
const mod = (over: Partial<Modulator> = {}): Modulator => ({ ...defaultModulator('plugin::dj::filter', 'm1'), rate: '1/4', depth: 1, ...over });

describe('modulateurs (L3, écart 11)', () => {
  const m120 = buildTempoMap(120, TS, []);
  it('LFO à la noire sur la coupure du filtre DJ : période = 1 temps (sommets exacts, ±1 échantillon à 48 kHz)', () => {
    const t = track([lane('plugin::dj::filter', -1, 1)], [mod()]);
    const lanes = playedLanes(t);
    const pts = lanes[0].points;
    expect(pts.length).toBeGreaterThan(100);
    // Sommets du sinus (1/4 de période) : un point pile dessus, valeur +1 (base 0, amplitude ±1).
    for (let k = 0; k < 8; k++) {
      const peak = quartersToTime(m120, k + 0.25);
      const p = pts.find(x => Math.abs(x.time - peak) < 1 / 48000);
      expect(p, `sommet ${k}`).toBeTruthy();
      expect(p!.value).toBeCloseTo(1, 9);
    }
    // Période mesurée entre deux passages montants par 0 : 0,5 s (un temps à 120).
    const zeros = pts.filter((p, i) => i > 0 && pts[i - 1].value < 0 && p.value >= 0).map(p => p.time);
    for (let i = 1; i < 4; i++) expect(Math.abs(zeros[i] - zeros[i - 1] - 0.5)).toBeLessThan(1 / 48000);
  });
  it('suit la piste tempo, rampes comprises (période = 1 temps à tout tempo)', () => {
    const m = buildTempoMap(90, TS, [{ id: 'r', bar: 4, bpm: 150, ramp: true }]);
    const pts = modulateLane(lane('pan', -1, 1), 0, [{ ...mod({ target: 'pan' }) }], m, 20)!;
    for (const q of [0.25, 5.25, 12.25, 20.25]) {
      const t = quartersToTime(m, q);
      expect(valueAtPoints(pts, t, 0)).toBeCloseTo(1, 6);
    }
  });
  it('modulateur et automation se cumulent sans saut ; borné à la plage', () => {
    const base = lane('volume', 0, 1.5, [{ time: 0, value: 0.2 }, { time: 4, value: 1.0 }]);
    const pts = modulateLane(base, 0.8, [mod({ target: 'volume', depth: 0.2 })], m120, 8)!;
    // À chaque instant : automation + LFO (amplitude ± 0,15 = 0,2 × 1,5 / 2).
    for (const tt of [0.37, 1.1, 2.6, 3.3]) {
      const expected = valueAtPoints(base.points, tt, 0) + 0.15 * lfoAt('sine', tt / 0.5);
      expect(valueAtPoints(pts, tt, 0)).toBeCloseTo(expected, 2);
    }
    // Pas de saut : deux points voisins diffèrent de moins d'un 1/16 de période d'amplitude.
    for (let i = 1; i < pts.length; i++) if (pts[i].time < 7.9) expect(Math.abs(pts[i].value - pts[i - 1].value)).toBeLessThan(0.07);
    const sat = modulateLane(lane('volume', 0, 1), 0.95, [mod({ target: 'volume', depth: 1 })], m120, 4)!;
    expect(Math.max(...sat.map(p => p.value))).toBeLessThanOrEqual(1);
  });
  it('sans point : autour de la valeur fixe du réglage (volume, pan, effet) ; mode Off : le LFO joue quand même', () => {
    const t = track([lane('volume', 0, 1.5)], [mod({ target: 'volume', depth: 0.1, polarity: 'down' })], { automationMode: 'off' });
    expect(staticValueOf(t, 'volume')).toBe(0.8);
    expect(staticValueOf(t, 'plugin::dj::filter')).toBe(0);
    const lanes = playedLanes(t);
    expect(lanes.length).toBe(1);
    const vals = lanes[0].points.map(p => p.value);
    expect(Math.max(...vals)).toBeLessThanOrEqual(0.8 + 1e-9);
    expect(Math.min(...vals)).toBeCloseTo(0.8 - 0.15, 6);
  });
  it('carré et aléatoire : en marches (HOLD), sauts pile sur la grille, reproductibles', () => {
    const sq = modulateLane(lane('pan', -1, 1), 0, [mod({ target: 'pan', shape: 'square' })], m120, 4)!;
    expect(sq.every(p => p.curveType === 'HOLD')).toBe(true);
    expect(sq.map(p => +p.time.toFixed(9)).slice(0, 4)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(sq.map(p => p.value).slice(0, 4)).toEqual([1, -1, 1, -1]);
    const r1 = modulateLane(lane('pan', -1, 1), 0, [mod({ target: 'pan', shape: 'random' })], m120, 4)!;
    const r2 = modulateLane(lane('pan', -1, 1), 0, [mod({ target: 'pan', shape: 'random' })], m120, 4)!;
    expect(r1).toEqual(r2);
  });
  it('coût : calcul mémorisé (même objet à la lecture suivante) ; LFO coupé = voies d’origine', () => {
    const t = track([lane('plugin::dj::filter', -1, 1)], [mod({ rate: '1/16' })]);
    const t0 = performance.now();
    const a = modulatedLanes(t, t.automationLanes, m120, 240);
    const ms = performance.now() - t0;
    expect(modulatedLanes(t, t.automationLanes, m120, 240)).toBe(a);
    expect(a[0].points.length).toBeLessThanOrEqual(40001);
    expect(ms).toBeLessThan(500);
    const off = track(t.automationLanes, [{ ...mod(), on: false }]);
    expect(playedLanes(off)).toBe(off.automationLanes);
    expect(playedLanes(track(t.automationLanes))).toBe(t.automationLanes);
  });
  it('réglages reçus bornés', () => {
    const s = sanitizeModulators([{ target: 'volume', depth: 4, rate: '1/3', shape: 'x', phase: -1 }, { depth: 1 }]);
    expect(s).toEqual([{ id: 'mod-0', on: true, target: 'volume', shape: 'sine', rate: '1/1', depth: 1, phase: 0, polarity: 'bi' }]);
  });
});
