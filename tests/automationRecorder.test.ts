import { describe, expect, it, beforeEach } from 'vitest';
import type { Track } from '../types';
import { AutomationRecorder, AutomationCommit } from '../services/AutomationManager';
import { valueAtPoints } from '../utils/automationWrite';

/** Hôte factice : horloge du projet, pistes, moteur et historique simulés. */
function setup(mode: Track['automationMode'], lanePoints: [number, number][] = []) {
  let tracks: Track[] = [{
    id: 'v', name: 'Voix', type: 'AUDIO' as any, color: '#0ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], totalLatency: 0, automationMode: mode,
    automationLanes: [{ id: 'l', parameterName: 'volume', color: '', isExpanded: false, min: 0, max: 1.5,
      points: lanePoints.map(([time, value], i) => ({ id: `o${i}`, time, value })) }],
  }];
  const env = { time: 0, playing: true, wall: 0, undo: 0, overrides: [] as [string, number | null][], commits: [] as AutomationCommit[], modes: [] as string[] };
  const rec = new AutomationRecorder();
  rec.configure({
    getTracks: () => tracks,
    getTime: () => env.time,
    isPlaying: () => env.playing,
    setOverride: (_t, p, v) => { env.overrides.push([p, v]); },
    beginUndoStep: () => { env.undo++; },
    commit: (c) => {
      env.commits.push(c);
      tracks = tracks.map(t => t.id !== c.trackId ? t : { ...t, automationLanes: t.automationLanes.map(l => l.parameterName === c.param ? { ...l, points: c.points } : l) });
    },
    setTrackMode: (_id, m) => { env.modes.push(m); tracks = tracks.map(t => ({ ...t, automationMode: m })); },
    wallClock: () => env.wall,
  });
  /** Avance la lecture jusqu'à `to` (s) en appelant tick à 60 Hz, `move` donne la position du fader. */
  const play = (to: number, move?: (t: number) => number | undefined) => {
    while (env.time < to - 1e-9) {
      env.time = Math.min(to, env.time + 1 / 60);
      env.wall += 1000 / 60;
      const v = move?.(env.time);
      if (v !== undefined) rec.change('v', 'volume', v);
      rec.tick();
    }
  };
  const lane = () => tracks[0].automationLanes[0].points;
  return { rec, env, play, lane, tracks: () => tracks };
}

describe('enregistreur d’automation', () => {
  let s: ReturnType<typeof setup>;

  describe('Touch', () => {
    beforeEach(() => { s = setup('touch', [[0, 0.8], [20, 0.8]]); s.rec.onPlay(); });
    it('écrit pendant l’appui puis revient à la courbe au relâchement', () => {
      s.play(2);
      s.rec.setPointerDown(true);
      s.rec.touch('v', 'volume');
      s.play(4, () => 0.3);
      s.rec.release('v', 'volume');
      s.rec.setPointerDown(false);
      s.play(8);
      s.rec.onStop(8);
      const pts = s.lane();
      expect(valueAtPoints(pts, 1, 0)).toBeCloseTo(0.8);
      expect(valueAtPoints(pts, 3, 0)).toBeCloseTo(0.3);
      expect(valueAtPoints(pts, 5, 0)).toBeCloseTo(0.8);
      expect(s.env.undo).toBe(1);            // une seule étape d'annulation
      expect(pts.length).toBeLessThan(10);   // points simplifiés
      // Le moteur a suivi le fader puis a rendu la main à la courbe.
      expect(s.env.overrides.at(-1)).toEqual(['volume', null]);
    });
  });

  describe('Latch', () => {
    beforeEach(() => { s = setup('latch', [[0, 0.8]]); s.rec.onPlay(); });
    it('garde la dernière valeur jusqu’à l’arrêt', () => {
      s.play(1);
      s.rec.touch('v', 'volume');
      s.play(2, () => 0.4);
      s.rec.release('v', 'volume');
      s.play(6);
      s.rec.onStop(6);
      const pts = s.lane();
      expect(valueAtPoints(pts, 0.5, 0)).toBeCloseTo(0.8);
      expect(valueAtPoints(pts, 5.9, 0)).toBeCloseTo(0.4);
      expect(valueAtPoints(pts, 7, 0)).toBeCloseTo(0.8);
    });
  });

  describe('Write', () => {
    beforeEach(() => { s = setup('write', [[0, 0.2], [3, 1.2], [6, 0.2]]); });
    it('écrase tout le passage lu, même sans toucher, puis repasse en Touch', () => {
      s.env.time = 1;
      s.rec.onPlay();
      s.play(5);
      s.rec.onStop(5);
      const pts = s.lane();
      const start = valueAtPoints([{ id: 'a', time: 0, value: 0.2 }, { id: 'b', time: 3, value: 1.2 }], 1, 0);
      expect(valueAtPoints(pts, 3, 0)).toBeCloseTo(start);   // la bosse d'origine a disparu
      expect(valueAtPoints(pts, 4.9, 0)).toBeCloseTo(start);
      expect(valueAtPoints(pts, 0.5, 0)).toBeCloseTo(0.2 + 1 / 3 * 0.5, 2); // avant le passage : intact
      expect(s.env.modes).toEqual(['touch']);
      expect(s.env.undo).toBe(1);
    });
    it('écrit le mouvement du fader pendant le passage', () => {
      s.rec.onPlay();
      s.play(4, t => (t > 1 ? 0.5 : undefined));
      s.rec.onStop(4);
      expect(valueAtPoints(s.lane(), 3, 0)).toBeCloseTo(0.5);
    });
  });

  describe('Trim', () => {
    beforeEach(() => { s = setup('trim', [[0, 0.5], [10, 1.0]]); s.rec.onPlay(); });
    it('décale la courbe d’origine du rapport du fader', () => {
      s.play(2);
      s.rec.setPointerDown(true);
      s.rec.touch('v', 'volume');
      const ref = 0.6; // valeur affichée au moment de l'appui
      s.play(6, () => ref / 2);
      s.rec.release('v', 'volume');
      s.rec.onStop(7);
      const pts = s.lane();
      expect(valueAtPoints(pts, 4, 0)).toBeCloseTo(0.7 / 2, 2);
      expect(valueAtPoints(pts, 8, 0)).toBeCloseTo(0.9, 2);
    });
  });

  describe('Read / Off', () => {
    it('ne capture rien', () => {
      s = setup('read', [[0, 0.8]]);
      s.rec.onPlay();
      s.play(1);
      expect(s.rec.change('v', 'volume', 0.2)).toBe(false);
      s.rec.onStop(2);
      expect(s.env.commits).toHaveLength(0);
      expect(s.env.undo).toBe(0);
    });
    it('à l’arrêt, rien n’est capturé non plus', () => {
      s = setup('touch');
      s.env.playing = false;
      expect(s.rec.change('v', 'volume', 0.2)).toBe(false);
    });
  });

  describe('captures depuis l’état', () => {
    it('un mouvement de fader est capturé (pas d’étape d’annulation par mouvement), un autre changement non', () => {
      s = setup('latch');
      s.rec.onPlay();
      s.play(1);
      const t = s.tracks()[0];
      expect(s.rec.captureTrackUpdate(t, { ...t, volume: 0.4 })).toBe(true);
      expect(s.rec.captureTrackUpdate(t, { ...t, volume: 0.4, isMuted: true })).toBe(false);
    });
    it('un réglage à la molette se relâche tout seul', () => {
      s = setup('touch', [[0, 1]]);
      s.rec.onPlay();
      s.play(1);
      s.rec.change('v', 'volume', 0.5);
      expect(s.rec.isCapturing('v')).toBe(true);
      s.play(3);
      expect(s.rec.isCapturing('v')).toBe(false);
      expect(s.env.commits).toHaveLength(1);
    });
  });
});
