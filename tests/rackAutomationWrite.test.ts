/**
 * Rack parallèle (22/10/2026) : écrire l'automation en touchant un réglage dans la fenêtre d'un
 * effet d'une branche (modes Touch / Latch / Write), comme pour les autres effets.
 *  - règles pures (engine/fxRack.ts) : réglages changés, valeurs fixes imbriquées ;
 *  - enregistreur (services/AutomationManager) : voie « plugin::<rack>::<effet>/<réglage> », référence
 *    = valeur d'avant, valeur fixe du projet écrite DANS la branche (jamais une clé parasite du rack).
 */
import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { AutomationRecorder, AutomationCommit } from '../services/AutomationManager';
import { rackAutomationChanges, rackNestedValue, withRackNestedValue, sanitizeRack, rackChildKey } from '../engine/fxRack';
import { staticParamValue, valueAtPoints, withStaticParamValue, paramSpec } from '../utils/automationWrite';

const comp = (makeupGain = 1) => ({ id: 'fx-comp', name: 'Compresseur', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { threshold: -18, ratio: 4, makeupGain, isEnabled: true } });
const rackParams = (makeupGain = 1, level1 = -6) => sanitizeRack({
  mode: 'parallele', mix: 100, outGain: 0,
  branches: [{ id: 'rb-1', level: level1, plugins: [comp(makeupGain)] }, { id: 'rb-2', level: -6, plugins: [] }],
});
const KEY = rackChildKey('fx-comp', 'makeupGain');

function rackTrack(mode: Track['automationMode'], params = rackParams()): Track {
  return {
    id: 'voix', name: 'Voix', type: 'AUDIO' as any, color: '#0ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], totalLatency: 0, automationMode: mode, automationLanes: [],
    plugins: [{ id: 'rack', type: 'FXRACK', name: 'Rack parallèle', isEnabled: true, latency: 0, params } as any],
  };
}

function recorder(mode: Track['automationMode']) {
  let tracks: Track[] = [rackTrack(mode)];
  const env = { time: 1, wall: 0, playing: true, commits: [] as AutomationCommit[], overrides: [] as [string, number | null][] };
  const rec = new AutomationRecorder();
  rec.configure({
    getTracks: () => tracks, getTime: () => env.time, isPlaying: () => env.playing,
    setOverride: (_t, p, v) => { env.overrides.push([p, v]); }, beginUndoStep: () => { /* */ },
    commit: (c) => {
      env.commits.push(c);
      tracks = tracks.map(t => {
        let n: Track = { ...t, automationLanes: [...t.automationLanes.filter(l => l.parameterName !== c.param), { id: 'n', parameterName: c.param, points: c.points, color: '', isExpanded: false, min: c.spec.min, max: c.spec.max }] };
        if (c.staticValue !== null && Number.isFinite(c.staticValue)) n = withStaticParamValue(n, c.param, c.staticValue);
        return n;
      });
    },
    setTrackMode: () => { /* */ }, wallClock: () => env.wall,
  });
  const run = (sec: number) => { for (let i = 0; i < Math.round(sec * 60); i++) { env.time += 1 / 60; env.wall += 1000 / 60; rec.tick(); } };
  return { rec, env, run, tracks: () => tracks };
}

describe('rack parallèle : réglages touchés dans les branches (règles pures)', () => {
  it('réglage d’un effet d’une branche et niveau d’une branche : changements avec la valeur d’avant', () => {
    const r = rackAutomationChanges(rackParams(1, -6), rackParams(2, -3));
    expect(r.structurel).toBe(false);
    expect(r.changes).toEqual(expect.arrayContaining([
      { key: KEY, value: 2, before: 1 },
      { key: 'br1Level', value: -3, before: -6 },
    ]));
    expect(r.changes).toHaveLength(2);
  });

  it('effet ajouté, contourné, branche coupée, réglage non numérique : changement ordinaire (pas d’automation)', () => {
    const base = rackParams();
    const added = { ...base, branches: base.branches.map((b, i) => (i === 1 ? { ...b, plugins: [{ ...comp(), id: 'fx-2' }] } : b)) };
    expect(rackAutomationChanges(base, added).structurel).toBe(true);
    const bypass = { ...base, branches: base.branches.map((b, i) => (i === 0 ? { ...b, plugins: [{ ...b.plugins[0], isEnabled: false }] } : b)) };
    expect(rackAutomationChanges(base, bypass).structurel).toBe(true);
    const muted = { ...base, branches: base.branches.map((b, i) => (i === 0 ? { ...b, mute: true } : b)) };
    expect(rackAutomationChanges(base, muted).structurel).toBe(true);
    const text = { ...base, branches: base.branches.map((b, i) => (i === 0 ? { ...b, plugins: [{ ...b.plugins[0], params: { ...b.plugins[0].params, mode: 'opto' } }] } : b)) };
    expect(rackAutomationChanges(base, text).structurel).toBe(true);
    expect(rackAutomationChanges(base, base)).toEqual({ changes: [], structurel: false });
  });

  it('valeurs fixes imbriquées : lues et écrites dans la branche, jamais à plat dans le rack', () => {
    const p = rackParams(1.5, -4);
    expect(rackNestedValue(p, KEY)).toBe(1.5);
    expect(rackNestedValue(p, 'br1Level')).toBe(-4);
    expect(rackNestedValue(p, 'mix')).toBeUndefined();
    const w = withRackNestedValue(p, KEY, 2)!;
    expect(w.branches[0].plugins[0].params.makeupGain).toBe(2);
    expect((w as any)[KEY]).toBeUndefined();
    expect(withRackNestedValue(p, 'br2Level', -12)!.branches[1].level).toBe(-12);
    expect(withRackNestedValue(p, 'mix', 50)).toBeNull();
    const t = rackTrack('touch', p);
    expect(staticParamValue(t, `plugin::rack::${KEY}`)).toBe(1.5);
    expect(staticParamValue(t, 'plugin::rack::br1Level')).toBe(-4);
    const t2 = withStaticParamValue(t, `plugin::rack::${KEY}`, 3);
    expect(t2.plugins[0].params.branches[0].plugins[0].params.makeupGain).toBe(3);
    expect(t2.plugins[0].params[KEY]).toBeUndefined();
    // Course : celle du réglage, jamais déduite de l'id de l'effet (« fx-mixdb » contient « mix » et « db »).
    expect(paramSpec(`plugin::rack::${rackChildKey('fx-mixdb', 'ratio')}`, 4)).toMatchObject({ min: 1, max: 20 });
  });
});

describe('rack parallèle : écriture depuis la fenêtre d’un effet d’une branche', () => {
  it('Touch : le gain de compensation bougé dans la branche est écrit ; relâché, la voie reprend', () => {
    const { rec, env, run } = recorder('touch');
    rec.onPlay();
    expect(rec.capturePluginParams('voix', 'rack', rackParams(2))).toBe(true);
    expect(env.overrides.some(([p, v]) => p === `plugin::rack::${KEY}` && v === 2)).toBe(true);
    run(1);
    rec.setPointerDown(false); rec.releaseImplicit();
    run(0.5);
    rec.onStop(env.time);
    const c = env.commits.find(x => x.param === `plugin::rack::${KEY}`)!;
    expect(c).toBeTruthy();
    expect(valueAtPoints(c.points, 0.5, 0)).toBeCloseTo(1, 3);    // avant le geste : la valeur d'avant
    expect(valueAtPoints(c.points, 1.5, 0)).toBeCloseTo(2, 3);    // pendant : la valeur écrite
  });

  it('Latch et Write : la valeur touchée reste jusqu’à l’arrêt, rien de parasite dans le rack', () => {
    for (const mode of ['latch', 'write'] as const) {
      const { rec, env, run, tracks } = recorder(mode);
      rec.onPlay();
      run(0.5);
      expect(rec.capturePluginParams('voix', 'rack', rackParams(2))).toBe(true);
      run(0.3);
      rec.setPointerDown(false); rec.releaseImplicit();
      run(1);
      rec.onStop(env.time);
      const c = env.commits.find(x => x.param === `plugin::rack::${KEY}`)!;
      expect(c).toBeTruthy();
      expect(valueAtPoints(c.points, env.time - 0.05, 0)).toBeCloseTo(2, 3);
      expect(tracks()[0].plugins[0].params[KEY]).toBeUndefined();
    }
  });

  it('niveau d’une branche touché : voie « br1Level » ; Read ou arrêt : rien n’est écrit', () => {
    const { rec, env, run } = recorder('touch');
    rec.onPlay();
    expect(rec.capturePluginParams('voix', 'rack', rackParams(1, -2))).toBe(true);
    run(0.5);
    rec.onStop(env.time);
    expect(env.commits.some(x => x.param === 'plugin::rack::br1Level')).toBe(true);
    const r2 = recorder('read');
    r2.rec.onPlay();
    expect(r2.rec.capturePluginParams('voix', 'rack', rackParams(2))).toBe(false);
    const r3 = recorder('touch');
    r3.env.playing = false;
    expect(r3.rec.capturePluginParams('voix', 'rack', rackParams(2))).toBe(false);
  });

  it('effet ajouté dans une branche pendant la lecture : réglage ordinaire, pas d’automation', () => {
    const { rec, env } = recorder('touch');
    rec.onPlay();
    const base = rackParams();
    const added = { ...base, branches: base.branches.map((b, i) => (i === 1 ? { ...b, plugins: [{ ...comp(), id: 'fx-2' }] } : b)) };
    expect(rec.capturePluginParams('voix', 'rack', added)).toBe(false);
    expect(env.overrides).toHaveLength(0);
  });
});
