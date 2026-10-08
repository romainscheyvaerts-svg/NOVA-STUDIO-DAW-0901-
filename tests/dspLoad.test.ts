import { describe, expect, it } from 'vitest';
import { makeClip, makeTrack } from './helpers/fixtures';
import { FX_COST_MS, estimatedLoadPct, pickAutoFreeze, pluginCostMs, rankHeavyTracks, safeToAutoFreeze, trackCostMs, TRACK_BASE_MS } from '../utils/dspLoad';
import { DspMonitor } from '../engine/dspMonitor';
import type { PluginInstance, Track } from '../types';
import { TrackType } from '../types';

const fx = (type: string, over: Partial<PluginInstance> = {}): PluginInstance => ({ id: `${type}-${Math.random()}`, name: type, type: type as any, isEnabled: true, params: {}, ...over });
const ok = { isRecording: false, bridgeConnected: false };

describe('Coût estimé des pistes (utils/dspLoad)', () => {
  it('somme des effets actifs ; effet contourné ou inactif = 0', () => {
    expect(pluginCostMs(fx('REVERB'))).toBe(FX_COST_MS.REVERB);
    expect(pluginCostMs(fx('REVERB', { isEnabled: false }))).toBe(0);
    expect(pluginCostMs(fx('REVERB', { isInactive: true }))).toBe(0);
    expect(pluginCostMs(fx('INCONNU'))).toBeGreaterThan(0);
    const t = makeTrack({ clips: [makeClip()], plugins: [fx('REVERB'), fx('COMPRESSOR'), fx('DELAY', { isEnabled: false })] });
    expect(trackCostMs(t)).toBeCloseTo(TRACK_BASE_MS + FX_COST_MS.REVERB + FX_COST_MS.COMPRESSOR + 0.3, 1);
  });

  it('piste gelée : le rendu remplace les effets (coût quasi nul) ; piste inactive = 0', () => {
    const t = makeTrack({ clips: [makeClip()], plugins: [fx('REVERB'), fx('CHORUS')] });
    const frozen = { ...t, isFrozen: true, frozenClip: makeClip({ id: 'gel' }), frozenUpToPluginIndex: 1 } as Track;
    expect(trackCostMs(frozen)).toBeLessThan(2);
    expect(trackCostMs({ ...t, isInactive: true })).toBe(0);
  });

  it('synthé MIDI compté ; charge estimée en % du budget', () => {
    const midi = makeTrack({ type: TrackType.MIDI, clips: [makeClip({ type: TrackType.MIDI })] });
    expect(trackCostMs(midi)).toBeGreaterThan(20);
    const heavy = Array.from({ length: 10 }, () => makeTrack({ clips: [makeClip()], plugins: [fx('REVERB')] }));
    expect(estimatedLoadPct(heavy)).toBeGreaterThan(100);
  });

  it('classement : les plus lourdes d\'abord, sans bus ni retours ni pistes gelées', () => {
    const a = makeTrack({ id: 'a', name: 'A', clips: [makeClip()], plugins: [fx('COMPRESSOR')] });
    const b = makeTrack({ id: 'b', name: 'B', clips: [makeClip()], plugins: [fx('REVERB'), fx('DELAY')] });
    const c = makeTrack({ id: 'c', name: 'C', clips: [makeClip()], plugins: [fx('CHORUS')] });
    const bus = makeTrack({ id: 'bus', type: TrackType.BUS, plugins: [fx('REVERB'), fx('REVERB')] });
    const r = rankHeavyTracks([a, b, c, bus], 3);
    expect(r.map(x => x.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('Gel automatique sans risque (mode sécurité)', () => {
  const base = () => makeTrack({ id: 'v', name: 'Voix', clips: [makeClip()], plugins: [fx('REVERB')] });
  it('accepte une piste ordinaire chargée en effets', () => {
    expect(safeToAutoFreeze(base(), ok)).toEqual({ ok: true });
  });
  it.each([
    ['prise en cours', (t: Track) => t, { ...ok, isRecording: true }],
    ['piste armée', (t: Track) => ({ ...t, isTrackArmed: true }), ok],
    ['déjà gelée', (t: Track) => ({ ...t, isFrozen: true }), ok],
    ['beat sous licence', (t: Track) => ({ ...t, id: 'instrumental' }), ok],
    ['beat du catalogue', (t: Track) => ({ ...t, instrumentId: 'abc' }), ok],
    ['bus', (t: Track) => ({ ...t, type: TrackType.BUS }), ok],
    ['retour d\'effet', (t: Track) => ({ ...t, type: TrackType.SEND }), ok],
    ['master', (t: Track) => ({ ...t, id: 'master' }), ok],
    ['VST sans pont', (t: Track) => ({ ...t, plugins: [fx('VST3')] }), ok],
    ['rien à geler', (t: Track) => ({ ...t, clips: [] }), ok],
    ['aucun effet', (t: Track) => ({ ...t, plugins: [] }), ok],
    ['collaborateur', (t: Track) => t, { ...ok, busyTrackIds: ['v'] }],
  ])('refuse : %s', (_label, mut, ctx) => {
    expect(safeToAutoFreeze(mut(base()), ctx as any).ok).toBe(false);
  });
  it('VST avec le pont connecté : accepté', () => {
    expect(safeToAutoFreeze({ ...base(), plugins: [fx('VST3')] }, { ...ok, bridgeConnected: true }).ok).toBe(true);
  });
  it('choisit la plus lourde parmi celles qu\'on peut geler', () => {
    const armed = makeTrack({ id: 'x', name: 'X', isTrackArmed: true, clips: [makeClip()], plugins: [fx('REVERB'), fx('REVERB')] });
    const v = base();
    const light = makeTrack({ id: 'l', name: 'L', clips: [makeClip()], plugins: [fx('FLANGER')] });
    expect(pickAutoFreeze([armed, light, v], ok)?.id).toBe('v');
    expect(pickAutoFreeze([armed], ok)).toBeNull();
  });
});

describe('Surveillance de la charge (engine/dspMonitor)', () => {
  function rig(opts: { stats?: boolean } = {}) {
    let wall = 0;
    let active = true;
    let late = 0;
    const stats = { underrunEvents: 0, underrunDuration: 0 };
    const ctx: any = { state: 'running', currentTime: 0 };
    if (opts.stats !== false) ctx.playbackStats = stats;
    let longCb: (ms: number) => void = () => {};
    const m = new DspMonitor({ now: () => wall, observeLongTasks: cb => { longCb = cb; }, setInterval: () => 1, clearInterval: () => {} });
    m.attach({ getContext: () => ctx, isActive: () => active, getLateTicks: () => late, getEstimatedLoad: () => 30 });
    const step = (o: { under?: number; underS?: number; ctxAdv?: number; late?: number; long?: number } = {}) => {
      wall += 500;
      ctx.currentTime += o.ctxAdv ?? 0.5;
      stats.underrunEvents += o.under ?? 0;
      stats.underrunDuration += o.underS ?? 0;
      late += o.late ?? 0;
      if (o.long) longCb(o.long);
      m.tick();
      return m.getState();
    };
    return { m, step, setActive: (a: boolean) => { active = a; } };
  }

  it('calme : niveau ok, charge = estimation', () => {
    const { step } = rig();
    step(); const s = step();
    expect(s.level).toBe('ok');
    expect(s.dsp).toBe(30);
    expect(s.source).toBe('playbackStats');
  });

  it('surcharge confirmée seulement après plusieurs fenêtres, puis fin d\'épisode', () => {
    const { m, step } = rig();
    const events: string[] = [];
    m.onEpisode(e => events.push(e.type));
    step();
    step({ under: 10, underS: 0.05 });
    expect(m.getState().level).toBe('surcharge');
    expect(m.getState().confirmed).toBe(false);
    for (let i = 0; i < 4; i++) step({ under: 10, underS: 0.05 });
    expect(m.getState().confirmed).toBe(false);
    step({ under: 10, underS: 0.05 });
    expect(m.getState().confirmed).toBe(true);
    expect(m.getState().underrunsPerMin).toBe(60);
    expect(m.getState().dsp).toBeGreaterThanOrEqual(85);
    expect(events).toEqual(['overload']);
    for (let i = 0; i < 12; i++) step();
    expect(m.getState().confirmed).toBe(false);
    expect(events).toEqual(['overload', 'recovered']);
  });

  it('un à-coup isolé (chargement) ne confirme rien ; à l\'arrêt, aucune confirmation', () => {
    const { m, step, setActive } = rig();
    step(); step({ under: 30, underS: 0.2 }); step(); step(); step({ under: 30, underS: 0.2 });
    expect(m.getState().confirmed).toBe(false);
    setActive(false);
    for (let i = 0; i < 6; i++) step({ under: 10, underS: 0.05 });
    expect(m.getState().confirmed).toBe(false);
  });

  it('salves (une fenêtre calme sur deux) : la surcharge est quand même confirmée', () => {
    const { m, step } = rig();
    step();
    for (let i = 0; i < 8; i++) step(i % 2 ? {} : { under: 6, underS: 0.03 });
    expect(m.getState().confirmed).toBe(true);
  });

  it('surcharge qui dure : signalée de nouveau toutes les 15 s (le mode sécurité gèle une piste de plus)', () => {
    const { m, step } = rig();
    const events: string[] = [];
    m.onEpisode(e => events.push(e.type));
    step();
    for (let i = 0; i < 40; i++) step({ under: 5, underS: 0.03 });
    expect(events).toEqual(['overload', 'overload']);
  });

  it('retards du planificateur = surcharge', () => {
    const { m, step } = rig();
    step();
    for (let i = 0; i < 6; i++) step({ late: 2 });
    expect(m.getState().confirmed).toBe(true);
    expect(m.getState().lateEvents).toBe(12);
  });

  it('sans playbackStats : dérive de l\'horloge audio', () => {
    const { m, step } = rig({ stats: false });
    step();
    const s = step({ ctxAdv: 0.4 });
    expect(s.source).toBe('drift');
    expect(s.level).toBe('surcharge');
    step(); step();
    expect(step().level).not.toBe('surcharge');
    expect(m.getState().underrunsPerMin).toBeGreaterThan(0);
  });

  it('charge de l\'interface (tâches longues)', () => {
    const { step } = rig();
    step();
    const s = step({ long: 400 });
    expect(s.ui).toBe(80);
    expect(s.level).toBe('charge');
  });
});
