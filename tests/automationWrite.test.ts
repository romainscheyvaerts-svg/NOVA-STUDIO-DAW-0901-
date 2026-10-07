import { describe, expect, it } from 'vitest';
import type { AutomationPoint, Track } from '../types';
import {
  automationModeOf, clearTrackAutomation, commitSegment, isWriteMode, parsePluginParam, paramSpec, playedLanes,
  pluginParamName, simplifySamples, staticParamValue, trimValue, valueAtPoints, withStaticParamValue,
} from '../utils/automationWrite';

const gain = paramSpec('volume');
const pts = (...xs: [number, number][]): AutomationPoint[] => xs.map(([time, value], i) => ({ id: `p${i}`, time, value }));
const track = (extra: Partial<Track> = {}): Track => ({
  id: 't1', name: 'Voix', type: 'AUDIO' as any, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [{ id: 'send-delay', level: 0.5, isEnabled: true }], clips: [],
  plugins: [{ id: 'cmp', name: 'Comp', type: 'COMPRESSOR', isEnabled: true, params: { threshold: -18, mode: 'x' }, latency: 0 } as any],
  automationLanes: [], totalLatency: 0, ...extra,
});

describe('modes d’automation', () => {
  it('Read par défaut (projets d’avant), Off ne rejoue rien', () => {
    expect(automationModeOf(track())).toBe('read');
    expect(automationModeOf({ automationMode: 'WRITE' })).toBe('write');
    expect(automationModeOf({ automationMode: 'n’importe quoi' })).toBe('read');
    const lanes = [{ id: 'l', parameterName: 'volume', points: pts([0, 1]), color: '', isExpanded: false, min: 0, max: 1.5 }];
    expect(playedLanes(track({ automationLanes: lanes }))).toHaveLength(1);
    expect(playedLanes(track({ automationLanes: lanes, automationMode: 'off' }))).toHaveLength(0);
    expect(['touch', 'latch', 'write', 'trim'].every(m => isWriteMode(m as any))).toBe(true);
    expect(isWriteMode('read')).toBe(false);
  });
});

describe('simplification des points écrits', () => {
  it('10 s de geste échantillonné à 60 Hz → quelques dizaines de points, forme gardée', () => {
    const samples = Array.from({ length: 601 }, (_, i) => ({ time: i / 60, value: 0.6 + 0.4 * Math.sin(i / 60) }));
    const out = simplifySamples(samples, gain);
    expect(out.length).toBeLessThan(60);
    expect(out[0].time).toBe(0);
    expect(out[out.length - 1].time).toBeCloseTo(10);
    // Erreur maximale sur la course du fader < 1 %
    const sorted = out.map((s, i) => ({ id: String(i), ...s }));
    for (const s of samples) {
      const v = valueAtPoints(sorted, s.time, 0);
      expect(Math.abs(Math.sqrt(v / 1.5) - Math.sqrt(s.value / 1.5))).toBeLessThan(0.01);
    }
  });
  it('un palier tenu donne deux points', () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({ time: i / 60, value: 0.8 }));
    expect(simplifySamples(samples, gain)).toHaveLength(2);
  });
});

describe('fusion d’un passage', () => {
  const ramp = (a: number, b: number, v: number) => Array.from({ length: 31 }, (_, i) => ({ time: a + (b - a) * i / 30, value: v }));

  it('Touch sur une voie vide : courbe plate avant, valeur écrite, retour AutoMatch après', () => {
    const out = commitSegment([], { kind: 'touch', start: 2, end: 4, samples: ramp(2, 4, 0.5) }, { spec: gain, baseline: 1 });
    expect(valueAtPoints(out, 0, 1)).toBeCloseTo(1);
    expect(valueAtPoints(out, 1.9, 1)).toBeCloseTo(1);
    expect(valueAtPoints(out, 3, 1)).toBeCloseTo(0.5);
    expect(valueAtPoints(out, 4.25, 1)).toBeCloseTo(1);
    expect(valueAtPoints(out, 10, 1)).toBeCloseTo(1);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('Touch remplace seulement le passage touché d’une courbe existante', () => {
    const orig = pts([0, 0.2], [10, 1.2]);
    const out = commitSegment(orig, { kind: 'touch', start: 4, end: 6, samples: ramp(4, 6, 0.9) }, { spec: gain, baseline: 1 });
    expect(valueAtPoints(out, 2, 0)).toBeCloseTo(0.4);       // avant : la rampe d'origine
    expect(valueAtPoints(out, 5, 0)).toBeCloseTo(0.9);       // passage écrit
    expect(valueAtPoints(out, 8, 0)).toBeCloseTo(1.0);       // après : la rampe d'origine
  });

  it('Latch / Write : la dernière valeur tient jusqu’à la fin du passage', () => {
    const samples = [{ time: 1, value: 1 }, { time: 1.5, value: 0.3 }];
    const out = commitSegment(pts([0, 1]), { kind: 'latch', start: 1, end: 5, samples }, { spec: gain, baseline: 1 });
    expect(valueAtPoints(out, 4.9, 0)).toBeCloseTo(0.3);
    expect(valueAtPoints(out, 6, 0)).toBeCloseTo(1);
  });

  it('Trim décale la courbe existante en dB (rapport de gain)', () => {
    const orig = pts([0, 0.5], [10, 1.0]);
    // Fader touché à 1.0 puis descendu à 0.5 (-6 dB) pendant tout le passage
    const samples = [{ time: 2, value: 1 }, { time: 2.01, value: 0.5 }, { time: 8, value: 0.5 }];
    const out = commitSegment(orig, { kind: 'trim', start: 2, end: 8, samples, trimRef: 1 }, { spec: gain, baseline: 1 });
    expect(valueAtPoints(out, 5, 0)).toBeCloseTo(0.75 * 0.5, 2);
    expect(valueAtPoints(out, 1, 0)).toBeCloseTo(0.55, 2);
    expect(valueAtPoints(out, 9.5, 0)).toBeCloseTo(0.975, 2);
    expect(trimValue(paramSpec('pan'), 0.2, 0.5, 0)).toBeCloseTo(0.7);
    expect(trimValue(paramSpec('pan'), 0.8, 1, 0)).toBe(1); // borné
  });
});

describe('paramètres', () => {
  it('volume, pan, envois et effets ont leur valeur statique', () => {
    const t = track();
    expect(staticParamValue(t, 'volume')).toBe(1);
    expect(staticParamValue(t, 'send::send-delay')).toBe(0.5);
    const name = pluginParamName('cmp', 'threshold');
    expect(parsePluginParam(name)).toEqual({ pluginId: 'cmp', key: 'threshold' });
    expect(staticParamValue(t, name)).toBe(-18);
    expect(staticParamValue(t, pluginParamName('cmp', 'mode'))).toBeNull();
    expect(paramSpec(name, -18)).toMatchObject({ min: -60, max: 0 });
    expect(withStaticParamValue(t, name, -30).plugins[0].params.threshold).toBe(-30);
    expect(withStaticParamValue(t, 'send::send-delay', 1).sends[0].level).toBe(1);
  });
  it('Effacer l’automation vide les voies sans les supprimer', () => {
    const t = track({ automationLanes: [
      { id: 'a', parameterName: 'volume', points: pts([0, 1]), color: '', isExpanded: true, min: 0, max: 1.5 },
      { id: 'b', parameterName: 'pan', points: pts([0, 0.5]), color: '', isExpanded: true, min: -1, max: 1 },
    ] });
    expect(clearTrackAutomation(t).automationLanes.map(l => l.points.length)).toEqual([0, 0]);
    expect(clearTrackAutomation(t, 'pan').automationLanes.map(l => l.points.length)).toEqual([1, 0]);
  });
});
