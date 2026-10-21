/**
 * Scènes de mix A / B / C / D (écart 20, 22/10/2026) : utils/mixSnapshots.ts.
 *  - rappel exact : après avoir tout bougé (volumes, pans, muets, envois, effets), rappeler la scène
 *    rend la console identique à l'original (mêmes valeurs) ;
 *  - rappel partiel respecté (seulement les envois, seulement les volumes) ;
 *  - pistes / effets / envois apparus ou disparus depuis : ignorés sans casse ;
 *  - rappel = une seule étape d'annulation (utils/undoHistory) ;
 *  - collaboration : fusion « le plus récent gagne » qui converge quel que soit l'ordre, effacements ;
 *  - l'invité en mode simple ne peut pas envoyer de scène (droits) ; projet : champ facultatif.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TrackType, type Track } from '../types';
import {
  applyScene, captureScene, deleteScene, liveScenes, mergeScenes, readScenesOp, sceneMatches, upsertScene, trackSceneOf,
  ALL_PARTS, type MixScene,
} from '../utils/mixSnapshots';
import { recordChange } from '../utils/undoHistory';
import { GUEST_FORBIDDEN_KINDS } from '../utils/guestRights';

const tr = (id: string, o: Partial<Track> = {}): Track => ({
  id, name: id, type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...o,
} as Track);

function session(): Track[] {
  return [
    tr('voix', {
      volume: 0.9, pan: -0.2,
      sends: [{ id: 'rev', level: 0.3, isEnabled: true }, { id: 'dly', level: 0.1, isEnabled: true, pan: 0.4 }],
      plugins: [
        { id: 'eq', name: 'EQ', type: 'PROEQ12', isEnabled: true, latency: 0, params: { masterGain: 1, bands: [{ type: 'peaking', frequency: 2000, gain: 3, q: 1 }] } },
        { id: 'comp', name: 'Comp', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { threshold: -18, ratio: 3 } },
      ],
    }),
    tr('beat', { volume: 0.7, pan: 0.1 }),
    tr('rev', { type: TrackType.SEND, volume: 0.6, plugins: [{ id: 'r', name: 'Rev', type: 'REVERB', isEnabled: true, latency: 0, params: { decay: 2.5, mix: 1 } }] }),
    tr('dly', { type: TrackType.SEND, volume: 0.5 }),
    tr('master', { type: TrackType.BUS, outputTrackId: '', volume: 1, plugins: [{ id: 'lim', name: 'Lim', type: 'LIMITER', isEnabled: true, latency: 0, params: { ceiling: -1 } }] }),
  ];
}

function messUp(t: Track[]): Track[] {
  return t.map(x => ({
    ...x, volume: x.volume * 0.5, pan: -x.pan + 0.3, isMuted: !x.isMuted,
    sends: x.sends.map(s => ({ ...s, level: s.level + 0.2, isEnabled: !s.isEnabled, isMuted: true })),
    plugins: x.plugins.map(p => ({ ...p, isEnabled: !p.isEnabled, params: { ...p.params, threshold: -40, decay: 9, ceiling: -3 } })),
  }));
}

const consoleOf = (t: Track[]) => t.map(trackSceneOf);

describe('scènes de mix : rappel', () => {
  it('rappel complet : la console revient EXACTEMENT à la scène (toutes les pistes, master compris)', () => {
    const orig = session();
    const A = captureScene(orig, 'A', { now: 1000 });
    const moved = messUp(orig);
    expect(consoleOf(moved)).not.toEqual(consoleOf(orig));
    expect(sceneMatches(moved, A)).toBe(false);
    const r = applyScene(moved, A);
    expect(r.changed).toBe(5);
    expect(consoleOf(r.tracks)).toEqual(consoleOf(orig));
    expect(sceneMatches(r.tracks, A)).toBe(true);
    // Réglages d'effet indépendants de la scène (une modification ensuite ne change pas la scène).
    (r.tracks[0].plugins[1].params as any).ratio = 99;
    expect(A.tracks.voix.plugins[1].params.ratio).toBe(3);
  });

  it('rappel partiel : seulement les envois (le reste ne bouge pas), seulement les volumes', () => {
    const orig = session();
    const A = captureScene(orig, 'A');
    const moved = messUp(orig);
    const sendsOnly = applyScene(moved, A, ['sends']).tracks;
    expect(sendsOnly[0].sends).toEqual(orig[0].sends);
    expect(sendsOnly[0].volume).toBe(moved[0].volume);
    expect(sendsOnly[0].plugins).toBe(moved[0].plugins);
    expect(sendsOnly[0].isMuted).toBe(moved[0].isMuted);
    const volOnly = applyScene(moved, A, ['volumes']).tracks;
    expect(volOnly.map(t => t.volume)).toEqual(orig.map(t => t.volume));
    expect(volOnly[0].pan).toBe(moved[0].pan);
    expect(volOnly[2].plugins).toBe(moved[2].plugins);
  });

  it('pistes, effets et envois apparus ou disparus depuis : ignorés sans casse ; rien à faire = même tableau', () => {
    const orig = session();
    const A = captureScene(orig, 'A');
    const now = [...orig.filter(t => t.id !== 'beat'), tr('nouvelle', { volume: 0.33 })];
    now[0] = { ...now[0], plugins: [now[0].plugins[1], { id: 'sat', name: 'Sat', type: 'VOCALSATURATOR', isEnabled: true, latency: 0, params: { drive: 30 } }], sends: [now[0].sends[0]] };
    const r = applyScene(messUp(now), A);
    const nouvelle = r.tracks.find(t => t.id === 'nouvelle')!;
    expect(nouvelle.volume).toBeCloseTo(0.165, 9);
    const voix = r.tracks.find(t => t.id === 'voix')!;
    expect(voix.plugins[0].params).toEqual(orig[0].plugins[1].params);
    expect(voix.plugins[1].params.drive).toBe(30);
    const same = applyScene(orig, A);
    expect(same.changed).toBe(0);
    expect(same.tracks).toBe(orig);
  });

  it('rappel = une seule étape d’annulation', () => {
    const orig = session();
    const A = captureScene(orig, 'A');
    const moved = messUp(orig);
    const h0 = { past: [{ tracks: orig }], present: { tracks: moved }, future: [], lastChangeAt: 0 } as any;
    const h1 = recordChange(h0, { tracks: applyScene(moved, A).tracks }, 10_000, { debounceMs: 300, limit: 50, clean: (s: any) => s });
    expect(h1.past.length).toBe(h0.past.length + 1);
    expect(consoleOf(h1.present.tracks)).toEqual(consoleOf(orig));
    expect(h1.past[h1.past.length - 1].tracks).toBe(moved);
  });
});

describe('scènes de mix : liste et collaboration', () => {
  it('poser, réécrire, effacer (pierre tombale), ordre A → D', () => {
    let list: MixScene[] = [];
    list = upsertScene(list, captureScene(session(), 'C', { now: 1 }));
    list = upsertScene(list, captureScene(session(), 'A', { now: 2 }));
    expect(list.map(s => s.slot)).toEqual(['A', 'C']);
    list = deleteScene(list, 'C', 'Nina', 3);
    expect(liveScenes(list).map(s => s.slot)).toEqual(['A']);
    expect(list.find(s => s.slot === 'C')!.deleted).toBe(true);
  });

  it('fusion « le plus récent gagne » : converge quel que soit l’ordre d’arrivée', () => {
    const a1 = captureScene(session(), 'A', { now: 100, by: 'ingé' });
    const a2 = { ...captureScene(messUp(session()), 'A', { now: 200, by: 'artiste' }) };
    const bDel = deleteScene([], 'B', 'ingé', 300)[0];
    const b1 = captureScene(session(), 'B', { now: 250, by: 'artiste' });
    const order1 = mergeScenes(mergeScenes([], [a1, b1]).list, [a2, bDel]).list;
    const order2 = mergeScenes(mergeScenes([], [bDel, a2]).list, [b1, a1]).list;
    expect(order1).toEqual(order2);
    expect(order1.find(s => s.slot === 'A')!.stamp.by).toBe('artiste');
    expect(order1.find(s => s.slot === 'B')!.deleted).toBe(true);
    // Rien de nouveau : rien ne change.
    expect(mergeScenes(order1, [a1]).changed).toEqual([]);
  });

  it('opération reçue lue prudemment ; l’invité en mode simple ne peut pas l’envoyer', () => {
    const ok = captureScene(session(), 'D', { now: 5, by: 'x' });
    const r = readScenesOp({ upsert: [ok, { slot: 'Z', stamp: { t: 1, by: 'x' }, tracks: {} }, { slot: 'A' }, null] });
    expect(r.map(s => s.slot)).toEqual(['D']);
    expect(readScenesOp(null)).toEqual([]);
    expect(GUEST_FORBIDDEN_KINDS.has('scenes')).toBe(true);
    expect(ALL_PARTS).toEqual(['volumes', 'pans', 'mutes', 'sends', 'plugins']);
  });

  it('branchements : champ du projet, console (A/B/C/D), sauvegarde automatique', () => {
    const root = path.resolve(__dirname, '..');
    expect(fs.readFileSync(path.join(root, 'types.ts'), 'utf8')).toMatch(/mixScenes\?: import\('\.\/utils\/mixSnapshots'\)\.MixScene\[\]/);
    expect(fs.readFileSync(path.join(root, 'components/MixerView.tsx'), 'utf8')).toMatch(/<MixScenesPanel/);
    expect(fs.readFileSync(path.join(root, 'utils/autosavePolicy.ts'), 'utf8')).toMatch(/s\.mixScenes/);
    expect(fs.readFileSync(path.join(root, 'App.tsx'), 'utf8')).toMatch(/case SCENES_KIND:/);
  });
});
