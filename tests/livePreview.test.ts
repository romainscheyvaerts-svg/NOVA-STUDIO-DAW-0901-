import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anchorClipsToWindow, applyPreviewOnEngineer, clearPreviewOnEngineer, hasArtistVst, NO_ANSWER, PREVIEW_RENDER_TIMEOUT_MS, PREVIEW_TIMEOUT_MS,
  PreviewPayload, PreviewScheduler, PreviewTracker, previewView, previewWindow,
} from '../services/LivePreview';
import { frozenPlayback, isTrackFrozen } from '../utils/freeze';
import type { PluginInstance, Track } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * « En direct » : l'ingé entend les VST de l'artiste (aperçu rendu par le pont
 * de l'artiste). Pont, réseau et rendu simulés.
 */

const vst = (id: string, path = 'C:/VST3/Comp.vst3'): PluginInstance =>
  ({ id, name: 'Comp', type: 'VST3', isEnabled: true, latency: 0, params: { name: 'Comp', localPath: path } } as PluginInstance);
const eq = (id: string): PluginInstance => ({ id, name: 'EQ', type: 'PROEQ12', isEnabled: true, latency: 0, params: {} } as PluginInstance);

/** Voix : 3 phrases (10-20 s, 40-50 s, 70-80 s) d'une même prise. */
const voice = (over: Partial<Track> = {}): Track => makeTrack({
  id: 'voix', name: 'Voix', plugins: [eq('e1'), vst('v1'), eq('e2')],
  clips: [
    makeClip({ id: 'p1', start: 10, offset: 10, duration: 10, bufferId: 'prise' }),
    makeClip({ id: 'p2', start: 40, offset: 40, duration: 10, bufferId: 'prise' }),
    makeClip({ id: 'p3', start: 70, offset: 70, duration: 10, bufferId: 'prise' }),
  ],
  ...over,
});

afterEach(() => { vi.useRealTimers(); });

describe('fenêtre d\'aperçu', () => {
  it('morceau court : tout ; boucle active : la boucle ; sinon 30 s depuis 2 s avant la tête de lecture', () => {
    expect(previewWindow({ trackEnd: 40, playhead: 12 })).toEqual({ from: 0, to: 40 });
    expect(previewWindow({ trackEnd: 180, playhead: 12, loop: { start: 60, end: 76 } })).toEqual({ from: 60, to: 76 });
    expect(previewWindow({ trackEnd: 180, playhead: 62 })).toEqual({ from: 60, to: 90 });
    expect(previewWindow({ trackEnd: 180, playhead: 179 })).toEqual({ from: 150, to: 180 }); // fin du morceau
    expect(previewWindow({ trackEnd: 180, playhead: 0, loop: { start: 0, end: 300 } })).toEqual({ from: 0, to: 60 }); // boucle trop longue : bornée
  });
  it('hasArtistVst : un VST avec un chemin de plugin (PC de l\'artiste), actif', () => {
    expect(hasArtistVst(voice())).toBe(true);
    expect(hasArtistVst(voice({ plugins: [eq('e1')] }))).toBe(false);
    expect(hasArtistVst(voice({ plugins: [{ ...vst('v1'), isEnabled: false }] }))).toBe(false);
  });
});

describe('ancrages dans un rendu qui commence au début de la fenêtre', () => {
  it('chaque clip joue la bonne tranche du rendu, à sa place ; hors fenêtre : en direct (sans VST)', () => {
    const t = voice();
    const win = { from: 35, to: 75 };
    const refs = anchorClipsToWindow(t.clips, 'pv1', win);
    expect(Object.keys(refs).sort()).toEqual(['p2', 'p3']);
    expect(refs.p2).toMatchObject({ anchor: 0 - 35, from: 40, to: 50 }); // source 40 s → rendu 5 s
    expect(refs.p3).toMatchObject({ from: 70, to: 75, fadeOut: 0 }); // coupé par la fenêtre
    const p: PreviewPayload = { trackId: 'voix', clip: makeClip({ id: 'pv1', start: 0, offset: 0, duration: 42, bufferId: 'pv1' }), upTo: 1, refs, win };
    expect(applyPreviewOnEngineer(t, p, 1000)).toEqual({ released: [] });
    const play = frozenPlayback(t);
    const slice2 = play.render.find(c => c.id.startsWith('p2'))!;
    expect(slice2).toMatchObject({ start: 40, offset: 5, bufferId: 'pv1' }); // 40 s du morceau = 5 s du rendu
    expect(slice2.duration).toBeCloseTo(10 + 1, 5); // fin d'origine : + queue des effets (1 s)
    const slice3 = play.render.find(c => c.id.startsWith('p3'))!;
    expect(slice3).toMatchObject({ start: 70, offset: 35 });
    expect(slice3.duration).toBeCloseTo(5, 5); // coupée par la fenêtre : la suite joue en direct, sans queue rendue
    // Phrase 1 (hors fenêtre) et la fin de la phrase 3 : en direct.
    expect(play.live.map(c => c.id).sort()).toEqual(['p1', 'p3~post']);
  });
});

describe('aperçu chez l\'ingé', () => {
  const payload = (id: string, win = { from: 0, to: 40 }): PreviewPayload =>
    ({ trackId: 'voix', clip: makeClip({ id, start: 0, offset: 0, duration: 42, bufferId: id }), upTo: 1, refs: anchorClipsToWindow(voice().clips, id, win), win });

  it('joue l\'aperçu (rendu jusqu\'au dernier VST : les effets de NOVA après restent en direct) ; le suivant remplace et libère le précédent', () => {
    const t = voice();
    applyPreviewOnEngineer(t, payload('pv1'), 1000);
    expect(isTrackFrozen(t)).toBe(true);
    expect(t.frozenUpToPluginIndex).toBe(1);
    expect(t.livePreview).toEqual({ renderId: 'pv1', from: 0, to: 40, at: 1000 });
    expect(applyPreviewOnEngineer(t, payload('pv2'), 2000)).toEqual({ released: ['pv1'] });
    expect(t.clips.find(c => c.id === 'p1')!.freezeRef!.renderId).toBe('pv2');
  });

  it('ne remplace jamais un gel fait par l\'ingé avec SES VST', () => {
    const t = voice({ isFrozen: true, frozenClip: makeClip({ id: 'gel-inge', bufferId: 'gel-inge' }) });
    expect(applyPreviewOnEngineer(t, payload('pv1'))).toBeNull();
    expect(t.frozenClip!.id).toBe('gel-inge');
  });

  it('fin de la collaboration : l\'aperçu disparaît, la piste rejoue normalement', () => {
    const t = voice();
    applyPreviewOnEngineer(t, payload('pv1'));
    expect(clearPreviewOnEngineer(t)).toBe('pv1');
    expect(isTrackFrozen(t)).toBe(false);
    expect(t.livePreview).toBeUndefined();
    expect(t.clips.some(c => c.freezeRef)).toBe(false);
  });
});

describe('PreviewScheduler (PC de l\'artiste)', () => {
  it('réglages en rafale : UN rendu, 1 s après le dernier ; un réglage pendant le rendu en relance un seul', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    let release!: () => void;
    const states: string[] = [];
    const s = new PreviewScheduler({
      run: async (id) => { runs.push(id); if (runs.length === 1) await new Promise<void>(r => { release = r; }); },
      onState: (_id, st) => states.push(st),
    });
    for (let i = 0; i < 5; i++) { s.request('voix'); await vi.advanceTimersByTimeAsync(300); }
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(runs).toEqual(['voix']);
    s.request('voix'); s.request('voix');
    await vi.advanceTimersByTimeAsync(1100); // le rendu 1 est toujours en cours
    expect(runs).toEqual(['voix']);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual(['voix', 'voix']);
    expect(states).toEqual(['rendering', 'rendering']);
  });

  it('artiste en train d\'enregistrer : en attente (dit à l\'ingé), repart après la prise', async () => {
    vi.useFakeTimers();
    let recording = true;
    const runs: unknown[] = [];
    const states: [string, string | undefined][] = [];
    const s = new PreviewScheduler({
      blockedReason: () => (recording ? "l'artiste enregistre une prise" : null),
      run: async (_id, win) => { runs.push(win); },
      onState: (_id, st, msg) => states.push([st, msg]),
    });
    s.request('voix', { from: 10, to: 40 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(states).toEqual([['waiting', "l'artiste enregistre une prise"]]);
    recording = false;
    s.resume();
    await vi.advanceTimersByTimeAsync(1100);
    expect(runs).toEqual([{ from: 10, to: 40 }]); // la fenêtre demandée est gardée
  });

  it('pont coupé pendant le rendu : erreur claire transmise', async () => {
    vi.useFakeTimers();
    const states: [string, string | undefined][] = [];
    const s = new PreviewScheduler({
      run: async () => { throw new Error("Le pont VST de l'artiste n'est pas connecté : il doit ouvrir NOVA Studio pour Windows."); },
      onState: (_id, st, msg) => states.push([st, msg]),
    });
    s.request('voix');
    await vi.advanceTimersByTimeAsync(1100);
    expect(states.at(-1)).toEqual(['error', "Le pont VST de l'artiste n'est pas connecté : il doit ouvrir NOVA Studio pour Windows."]);
  });
});

describe('PreviewTracker (chez l\'ingé)', () => {
  it('en cours de calcul → à jour ; libellés clairs', () => {
    let now = 0;
    const tr = new PreviewTracker(() => now);
    tr.expect('voix', { from: 62, to: 92 });
    expect(previewView(tr.get('voix'))).toMatchObject({ tone: 'busy', retry: false });
    expect(previewView(tr.get('voix'))!.label).toMatch(/en cours de calcul/);
    tr.remote('voix', 'rendering');
    now = 5000;
    tr.ready('voix', { from: 62, to: 92 });
    const v = previewView(tr.get('voix'))!;
    expect(v.tone).toBe('ok');
    expect(v.label).toMatch(/à jour \(1:02 – 1:32\)/);
  });

  it('pont de l\'artiste muet : erreur « ne répond pas » avec Réessayer ; rendu trop long aussi', () => {
    let now = 0;
    const tr = new PreviewTracker(() => now);
    tr.expect('voix');
    now = PREVIEW_TIMEOUT_MS - 1;
    expect(tr.tick()).toBe(false);
    now = PREVIEW_TIMEOUT_MS + 1;
    expect(tr.tick()).toBe(true);
    expect(previewView(tr.get('voix'))).toEqual({ label: NO_ANSWER, tone: 'error', retry: true });
    tr.expect('b'); tr.remote('b', 'rendering');
    now += PREVIEW_RENDER_TIMEOUT_MS + 1;
    tr.tick();
    expect(tr.get('b')!.code).toBe('error');
  });

  it('erreur / attente envoyées par l\'artiste : affichées telles quelles, avec Réessayer', () => {
    const tr = new PreviewTracker(() => 0);
    tr.remote('voix', 'error', "Le pont VST de l'artiste n'est pas connecté : il doit ouvrir NOVA Studio pour Windows.");
    expect(previewView(tr.get('voix'))).toMatchObject({ tone: 'error', retry: true, label: expect.stringMatching(/pont VST de l'artiste/) });
    tr.remote('voix', 'waiting', "l'artiste enregistre une prise");
    expect(previewView(tr.get('voix'))!.label).toMatch(/l'artiste enregistre une prise.*partira tout seul/);
  });
});

describe('aller-retour complet avec un pont simulé', () => {
  it('réglage à distance → rendu chez l\'artiste → aperçu joué chez l\'ingé ; pont coupé → message chez l\'ingé', async () => {
    vi.useFakeTimers();
    // « Réseau » : les opérations de l'artiste arrivent chez l'ingé.
    const engineerTrack = voice();
    const tracker = new PreviewTracker(() => Date.now());
    let bridgeUp = true;
    const deliver = (kind: string, op: any) => {
      if (kind === 'vst_preview_state') tracker.remote(op.trackId, op.state, op.message);
      if (kind === 'vst_preview') { applyPreviewOnEngineer(engineerTrack, op); tracker.ready(op.trackId, op.win); }
    };
    const artistTrack = voice();
    const renders: number[] = [];
    const sched = new PreviewScheduler({
      onState: (trackId, state, message) => deliver('vst_preview_state', { trackId, state, message }),
      run: async (trackId, win) => {
        if (!bridgeUp) throw new Error("Le pont VST de l'artiste n'est pas connecté : il doit ouvrir NOVA Studio pour Windows.");
        renders.push(Date.now());
        const w = win!;
        const id = `pv${renders.length}`;
        deliver('vst_preview', { trackId, clip: makeClip({ id, start: 0, offset: 0, duration: w.to - w.from + 2, bufferId: id }), upTo: 1, refs: anchorClipsToWindow(artistTrack.clips, id, w), win: w });
      },
    });
    // L'ingé règle le ratio (3 réglages en 600 ms) en écoutant 0:38 → 1:08.
    const win = { from: 38, to: 68 };
    for (let i = 0; i < 3; i++) { tracker.expect('voix', win); sched.request('voix', win); await vi.advanceTimersByTimeAsync(200); }
    expect(previewView(tracker.get('voix'))!.tone).toBe('busy');
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toHaveLength(1);
    expect(previewView(tracker.get('voix'))!.label).toMatch(/à jour \(0:38 – 1:08\)/);
    expect(engineerTrack.livePreview?.renderId).toBe('pv1');
    expect(frozenPlayback(engineerTrack).render.map(c => c.id.split('~')[0]).sort()).toEqual(['p2']);
    // L'artiste ferme NOVA Studio : l'ingé le voit.
    bridgeUp = false;
    tracker.expect('voix', win); sched.request('voix', win);
    await vi.advanceTimersByTimeAsync(1100);
    expect(previewView(tracker.get('voix'))).toMatchObject({ tone: 'error', retry: true });
    expect(engineerTrack.livePreview?.renderId).toBe('pv1'); // l'aperçu précédent reste joué
  });
});
