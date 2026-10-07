// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { trackBufferIds } from '../utils/freeze';
import { clipRegion, correctedClipPatch, editingSource, editsForNotes, revertClipPatch, storeEdits, REGION_PAD } from '../utils/pitchEdit';
import type { PitchNote } from '../utils/pitchAnalysis';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

const note = (index: number, start: number, end: number, center = 60): PitchNote => ({ index, i0: 0, i1: 1, start, end, center, spread: 0 });
const has = (id: string) => audioBufferRegistry.has(id);

describe('clip corrigé : région, retouches, aller-retour', () => {
  it('région analysée = clip + marge, bornée au son', () => {
    expect(clipRegion({ offset: 1, duration: 2 }, 10)).toEqual({ start: 1 - REGION_PAD, end: 3 + REGION_PAD });
    expect(clipRegion({ offset: 0, duration: 2 }, 2.1)).toEqual({ start: 0, end: 2.1 });
  });

  it('retouches rangées par instant puis retrouvées sur les notes', () => {
    const notes = [note(0, 0.1, 0.5), note(1, 0.5, 0.9), note(2, 1.0, 1.4)];
    const stored = storeEdits(notes, [{ shift: -0.4, drift: 0, vibrato: 1 }, undefined, { shift: 1, drift: 1, vibrato: 0, transitionMs: 0 }], 2);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ t0: 2.1, t1: 2.5, shift: -0.4 });
    // Analyse refaite : notes très légèrement décalées, retouches retrouvées.
    const again = [note(0, 0.11, 0.49), note(1, 0.5, 0.92), note(2, 1.01, 1.4)];
    const back = editsForNotes(again, stored, 2);
    expect(back[0]?.shift).toBeCloseTo(-0.4);
    expect(back[1]).toBeUndefined();
    expect(back[2]).toMatchObject({ shift: 1, vibrato: 0, transitionMs: 0 });
  });

  it('appliquer puis revenir à la prise d’origine', () => {
    audioBufferRegistry.register(makeBuffer(1, 44100 * 5, 44100), 'rec-1');
    audioBufferRegistry.register(makeBuffer(1, 44100 * 3, 44100), 'pitch-1');
    const clip = makeClip({ id: 'c1', name: 'Prise 1', bufferId: 'rec-1', start: 4, offset: 1, duration: 2, warp: { enabled: true, mode: 'BEATS', preservePitch: true, originalBpm: 90 } as any });
    const patch = correctedClipPatch(clip, { newBufferId: 'pitch-1', sourceBufferId: 'rec-1', sourceOffset: 1, regionStart: 0.75, edits: [], amount: 1, style: 'naturel' });
    expect(patch).toMatchObject({ bufferId: 'pitch-1', offset: 0.25, name: 'Prise 1 (justesse)', warp: undefined });
    const corrected = { ...clip, ...patch };
    // Le clip corrigé se retouche depuis l'original.
    expect(editingSource(corrected, has)).toEqual({ bufferId: 'rec-1', offset: 1, fromOriginal: true });
    const rev = revertClipPatch(corrected, has)!;
    expect(rev).toMatchObject({ bufferId: 'rec-1', offset: 1, name: 'Prise 1', pitchEdit: undefined });
    expect(rev.warp).toMatchObject({ originalBpm: 90 });
    // Original introuvable (projet reçu en collab) : on retouche le son corrigé, pas de retour possible.
    const remote = { ...corrected, pitchEdit: { ...corrected.pitchEdit!, sourceBufferId: 'ailleurs' } };
    expect(editingSource(remote, has)).toEqual({ bufferId: 'pitch-1', offset: 0.25, fromOriginal: false });
    expect(revertClipPatch(remote, has)).toBeNull();
  });

  it('la prise d’origine reste en mémoire (annuler, revenir) tant que le clip existe', () => {
    const t = makeTrack({ clips: [makeClip({ id: 'c', bufferId: 'pitch-1', pitchEdit: { version: 1, sourceBufferId: 'rec-1', regionStart: 0, edits: [] } })] });
    expect(trackBufferIds(t)).toEqual(expect.arrayContaining(['pitch-1', 'rec-1']));
  });
});

describe('sauvegarde : le clip corrigé et sa prise d’origine', () => {
  it('aller-retour fichier projet', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
    audioBufferRegistry.register(makeBuffer(1, 2205, 44100), 'pitch-1');
    const lead = makeTrack({
      id: 'track-rec-main', name: 'Voix',
      clips: [makeClip({ id: 'c1', name: 'Prise 1 (justesse)', bufferId: 'pitch-1', start: 1, offset: 0.01, duration: 0.03,
        pitchEdit: { version: 1, sourceBufferId: 'rec-1', regionStart: 0.02, edits: [{ t0: 0.03, t1: 0.05, shift: -0.4, drift: 0, vibrato: 1 }], amount: 1, style: 'naturel' } })],
    });
    const blob = await ProjectIO.saveProject(makeState([lead]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const c = st.tracks[0].clips[0];
    expect(c.bufferId && audioBufferRegistry.get(c.bufferId)?.length).toBe(2205);
    expect(c.pitchEdit?.sourceRef).toBeUndefined();
    expect(c.pitchEdit?.sourceBufferId && audioBufferRegistry.get(c.pitchEdit.sourceBufferId)?.length).toBe(4410);
    expect(c.pitchEdit?.edits[0].shift).toBe(-0.4);
  });

  it('ancien projet (sans justesse) : rien ne change', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
    const lead = makeTrack({ clips: [makeClip({ id: 'c1', bufferId: 'rec-1', duration: 0.05 })] });
    const blob = await ProjectIO.saveProject(makeState([lead]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(st.tracks[0].clips[0].pitchEdit).toBeUndefined();
    expect(audioBufferRegistry.get(st.tracks[0].clips[0].bufferId!)?.length).toBe(4410);
  });
});
