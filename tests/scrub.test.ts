import { beforeEach, describe, expect, it } from 'vitest';
import { hannCurve, planGrains, SCRUB_GRAIN, SCRUB_HOP, SCRUB_MAX_RATE, SCRUB_MIN_RATE } from '../engine/Scrubber';
import { TrackType, type Track } from '../types';
import { BUILT_IN_LAYOUTS, __resetLayoutsForTests, applyLayout, captureLayout, getLayout, registerLayoutPart, resetLayout, saveLayout } from '../utils/windowLayouts';

const fakeBuffer = (duration: number) => ({ duration, length: Math.round(duration * 48000), sampleRate: 48000, numberOfChannels: 1 }) as unknown as AudioBuffer;
const track = (over: Partial<Track> = {}): Track => ({
  id: 't1', name: 'Voix', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
  outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
  clips: [{ id: 'c1', name: 'prise', start: 2, duration: 4, offset: 1, fadeIn: 0, fadeOut: 0, type: TrackType.AUDIO, color: '#fff', buffer: fakeBuffer(10) } as any],
  ...over,
} as Track);

describe('R17 · scrub granulaire', () => {
  it('fenêtre de Hann : commence et finit à 0, deux grains à 50 % s’additionnent à 1 (niveau constant, aucun clic)', () => {
    const n = 257;
    const w = hannCurve(n);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[n - 1]).toBeCloseTo(0, 6);
    const half = (n - 1) / 2;
    for (let i = 0; i < half; i++) expect(w[i] + w[i + half]).toBeCloseTo(1, 2);
    expect(SCRUB_GRAIN).toBeCloseTo(2 * SCRUB_HOP, 9);
  });

  it('le grain lit le fichier à la bonne position, vitesse = vitesse du geste', () => {
    const g = planGrains([track()], 3, 2);
    expect(g).toHaveLength(1);
    expect(g[0].offset).toBeCloseTo(1 + (3 - 2), 9); // décalage du clip + position dans le clip
    expect(g[0].rate).toBe(2);
    expect(g[0].reverse).toBe(false);
  });

  it('en arrière : le fichier inversé, lu au point miroir', () => {
    const g = planGrains([track()], 3, -0.5)[0];
    expect(g.reverse).toBe(true);
    expect(g.offset).toBeCloseTo(10 - 2, 9);
    expect(g.rate).toBe(0.5);
  });

  it('vitesse bornée (1/16 à ×4), silence à l’arrêt, hors clip, piste muette ou MIDI', () => {
    expect(planGrains([track()], 3, 50)[0].rate).toBe(SCRUB_MAX_RATE);
    expect(planGrains([track()], 3, 0.001)[0].rate).toBe(SCRUB_MIN_RATE);
    expect(planGrains([track()], 3, 0)).toEqual([]);
    expect(planGrains([track()], 7, 1)).toEqual([]);
    expect(planGrains([track({ isMuted: true })], 3, 1)).toEqual([]);
    expect(planGrains([track({ type: TrackType.MIDI })], 3, 1)).toEqual([]);
    expect(planGrains([track()], 3, 1, () => true)).toEqual([]);
  });
});

describe('R17 · dispositions de fenêtres', () => {
  beforeEach(() => __resetLayoutsForTests());

  it('3 dispositions livrées : Enregistrement, Édition, Mix', () => {
    expect(BUILT_IN_LAYOUTS.map(l => l.name)).toEqual(['Enregistrement', 'Édition', 'Mix']);
    expect(getLayout(3)?.parts.view).toBe('MIXER');
  });

  it('enregistre la vue actuelle et la rappelle', () => {
    let view = 'ARRANGEMENT', zoom = { h: 40, v: 120 };
    registerLayoutPart('view', { get: () => view, set: v => { view = v; } });
    registerLayoutPart('zoom', { get: () => zoom, set: z => { zoom = z; } });
    view = 'MIXER'; zoom = { h: 200, v: 90 };
    saveLayout(4, 'Mon mix');
    expect(captureLayout()).toEqual({ view: 'MIXER', zoom: { h: 200, v: 90 } });
    view = 'ARRANGEMENT'; zoom = { h: 40, v: 120 };
    expect(applyLayout(4)?.name).toBe('Mon mix');
    expect(view).toBe('MIXER');
    expect(zoom).toEqual({ h: 200, v: 90 });
    applyLayout(1);
    expect(view).toBe('ARRANGEMENT');
    expect(applyLayout(5)).toBeNull();
    resetLayout(4);
    expect(getLayout(4)).toBeNull();
  });
});
