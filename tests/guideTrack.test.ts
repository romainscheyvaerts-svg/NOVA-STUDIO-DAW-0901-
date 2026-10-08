import { describe, it, expect, vi } from 'vitest';
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));
import { Track, TrackType } from '../types';
import { engineView, guideFactor, GUIDE_DEFAULT_LEVEL } from '../utils/trackStructure';
import { planStems } from '../utils/stemPlan';
import { contentOf } from '../services/Collab';

const mk = (id: string, over: Partial<Track> = {}): Track => ({
  id, name: id, type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], plugins: [], totalLatency: 0,
  clips: [{ id: `c-${id}`, start: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, name: 'c', color: '#fff', type: TrackType.AUDIO, bufferId: `b-${id}` }],
  automationLanes: [], ...over,
});

describe('piste guide (R3)', () => {
  it('entendue à son niveau à part (0,7 par défaut), automation du volume comprise', () => {
    const lane = { id: 'l', parameterName: 'volume', points: [{ id: 'p', time: 0, value: 0.5 }], color: '#fff', isExpanded: false } as any;
    const tracks = [mk('voix'), mk('guide', { isGuide: true, automationLanes: [lane] }), mk('master', { type: TrackType.BUS, clips: [], outputTrackId: '' })];
    const v = engineView(tracks);
    expect(v.byId.get('voix')!.volume).toBe(0.8);
    expect(v.byId.get('guide')!.volume).toBeCloseTo(0.8 * GUIDE_DEFAULT_LEVEL, 9);
    expect(v.byId.get('guide')!.automationLanes[0].points[0].value).toBeCloseTo(0.5 * 0.7, 9);
    expect(v.vcaScale.get('guide')).toBeCloseTo(0.7, 9);   // fader déplacé à la main : le niveau du guide reste appliqué
    expect(v.vcaScale.has('voix')).toBe(false);
    const louder = engineView([mk('guide', { isGuide: true, guideLevel: 1.2 })]);
    expect(louder.byId.get('guide')!.volume).toBeCloseTo(0.96, 9);
    expect(guideFactor({ isGuide: false, guideLevel: 0.1 })).toBe(1);
  });
  it('coupée d\'un geste : muette dans le moteur (et ses envois avec)', () => {
    const v = engineView([mk('guide', { isGuide: true, guideMuted: true })]);
    expect(v.byId.get('guide')!.isMuted).toBe(true);
  });
  it('jamais dans les stems ni les voix exportées', () => {
    const plan = planStems([mk('voix'), mk('guide', { isGuide: true }), mk('master', { type: TrackType.BUS, clips: [], outputTrackId: '' })], { grouping: 'tracks', returns: 'in-stems', withMasterFx: false });
    expect(plan.map(p => p.label)).toEqual(['voix']);
    expect(plan[0].tracks.some(t => t.id === 'guide')).toBe(false);
  });
  it('voyage dans la collaboration (marquée chez tous), la coupure reste locale', () => {
    expect(contentOf(mk('g', { isGuide: true, guideLevel: 0.5, guideMuted: true })).guide).toEqual({ level: 0.5 });
    expect(contentOf(mk('v')).guide).toBeNull();
  });
});
