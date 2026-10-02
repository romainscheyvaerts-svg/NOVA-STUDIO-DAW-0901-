import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Instruments VST3 du PC : le pont (NovaBridge) est simulé, le rendu passe par un vrai registre de buffers. */

const h = vi.hoisted(() => ({
  bridge: {
    connected: true,
    subscribe: vi.fn(() => () => {}),
    isConnected: vi.fn(() => h.bridge.connected),
    loadPlugin: vi.fn(async (_o: any) => ({ isInstrument: true, name: 'Serum', stateB64: 'INIT' })),
    onSlotEvent: vi.fn(() => () => {}),
    unloadPlugin: vi.fn(),
    renderInstrument: vi.fn(async (_o: any) => [new Float32Array(4410)] as Float32Array[]),
  },
}));
vi.mock('../services/NovaBridge', () => ({ novaBridge: h.bridge }));
vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});

import {
  applyInstrumentRender, clearInstrumentRender, ensureInstrumentSlot, instrumentNotes, instrumentRenderSig, instrumentSlotId,
  isInstrumentRenderCurrent, onInstrumentState, renderInstrumentTrack, unloadInstrumentSlot,
} from '../services/VstInstrument';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { Clip, Track, TrackType } from '../types';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeTrack } from './helpers/fixtures';

const midi = (id: string, start: number, duration: number, notes: any[], over: Partial<Clip> = {}) =>
  makeClip({ id, type: TrackType.MIDI, start, duration, notes, ...over });
const n = (pitch: number, start: number, duration: number, velocity?: number) => ({ id: `${pitch}-${start}`, pitch, start, duration, velocity });

let tid = 0;
function synthTrack(clips: Clip[], over: Partial<Track> = {}): Track {
  return makeTrack({
    id: `synth-${++tid}`, name: 'Synth', type: TrackType.MIDI, clips,
    vstInstrument: { name: 'Serum', path: 'C:/VST3/Serum.vst3' },
    ...over,
  });
}

beforeEach(() => {
  h.bridge.connected = true;
  h.bridge.loadPlugin.mockClear();
  h.bridge.renderInstrument.mockClear();
  audioBufferRegistry.clear();
});

describe('instrumentNotes', () => {
  it('temps absolus, limités au clip, clips muets ignorés, triés', () => {
    const t = synthTrack([
      midi('m1', 4, 2, [n(60.4, 1, 0.5, 2), n(64, 0, 5), n(67, 3, 1), n(50, -1, 1), n(51, 0.5, 0)]),
      midi('m2', 0, 4, [n(72, 0, 1, 0.5), n(48, 0, 1)]),
      midi('muet', 10, 4, [n(40, 0, 1)], { isMuted: true }),
      makeClip({ id: 'audio' }),
    ]);
    const r = instrumentNotes(t);
    expect(r.clipIds).toEqual(['m1', 'm2', 'muet']);
    expect(r.notes).toEqual([
      { pitch: 48, start: 0, duration: 1, velocity: 0.8 },
      { pitch: 72, start: 0, duration: 1, velocity: 0.5 },
      { pitch: 64, start: 4, duration: 2, velocity: 0.8 },     // coupée à la fin du clip
      { pitch: 60, start: 5, duration: 0.5, velocity: 1 },     // vélocité bornée, hauteur arrondie
    ]);
    expect(r.end).toBe(6);
  });

  it('piste sans clip MIDI : rien', () => {
    expect(instrumentNotes(synthTrack([]))).toEqual({ notes: [], clipIds: [], end: 0 });
  });
});

describe('empreinte et rendu à jour', () => {
  const clips = () => [midi('m1', 0, 4, [n(60, 0, 1)])];

  it('instrumentRenderSig : notes, tempo, instrument, son réglé', () => {
    const t = synthTrack(clips());
    const s = instrumentRenderSig(t, 120);
    expect(instrumentRenderSig(synthTrack(clips()), 120)).toBe(s);
    expect(instrumentRenderSig(t, 121)).not.toBe(s);
    expect(instrumentRenderSig(synthTrack([midi('m1', 0, 4, [n(62, 0, 1)])]), 120)).not.toBe(s);
    expect(instrumentRenderSig(synthTrack(clips(), { vstInstrument: { name: 'Serum', path: 'C:/VST3/Serum.vst3', stateB64: 'X' } }), 120)).not.toBe(s);
    expect(instrumentRenderSig(synthTrack(clips(), { vstInstrument: { name: 'Pigments', path: 'C:/VST3/Pigments.vst3' } }), 120)).not.toBe(s);
    expect(instrumentRenderSig(synthTrack(clips(), { vstInstrument: undefined }), 120)).toBe('');
  });

  it('isInstrumentRenderCurrent', () => {
    const t = synthTrack(clips());
    expect(isInstrumentRenderCurrent(t, 120)).toBe(false); // jamais rendu
    t.vstInstrument!.renderSig = instrumentRenderSig(t, 120);
    expect(isInstrumentRenderCurrent(t, 120)).toBe(false); // des notes mais pas de rendu
    t.frozenClip = makeClip({ bufferId: 'r1' });
    expect(isInstrumentRenderCurrent(t, 120)).toBe(false); // audio absent du registre
    audioBufferRegistry.register(makeBuffer(2, 10), 'r1');
    expect(isInstrumentRenderCurrent(t, 120)).toBe(true);
    expect(isInstrumentRenderCurrent(t, 100)).toBe(false); // tempo changé

    const empty = synthTrack([]);
    empty.vstInstrument!.renderSig = instrumentRenderSig(empty, 120);
    expect(isInstrumentRenderCurrent(empty, 120)).toBe(true); // rien à jouer
  });

  it('applyInstrumentRender / clearInstrumentRender', () => {
    const t = synthTrack(clips(), { frozenPluginSig: 'old' });
    const clip = makeClip({ id: 'r', bufferId: 'r' });
    applyInstrumentRender(t, { clip, clipIds: ['m1'], sig: 'S', sourceSig: 'SS', path: 'p' });
    expect(t).toMatchObject({ isFrozen: true, frozenClip: clip, frozenUpToPluginIndex: -1, frozenClipIds: ['m1'], frozenSourceSig: 'SS' });
    expect(t.vstInstrument!.renderSig).toBe('S');
    expect('frozenPluginSig' in t).toBe(false);

    applyInstrumentRender(t, { clip: null, clipIds: [], sig: 'S2', sourceSig: '', path: 'p' });
    expect(t.isFrozen).toBe(false);
    expect(t.vstInstrument!.renderSig).toBe('S2');
    for (const k of ['frozenClip', 'frozenUpToPluginIndex', 'frozenClipIds', 'frozenSourceSig']) expect(k in t).toBe(false);

    // Sans instrument : rien
    const plain = makeTrack();
    applyInstrumentRender(plain, { clip, clipIds: [], sig: 'S', sourceSig: '', path: '' });
    expect(plain.frozenClip).toBeUndefined();
    clearInstrumentRender(plain);
    expect(plain.isFrozen).toBe(false);
  });
});

describe('pont : slot et rendu', () => {
  it('ensureInstrumentSlot : chargé une fois, état d\'origine transmis à la piste', async () => {
    const states: [string, string][] = [];
    const off = onInstrumentState((id, s) => states.push([id, s]));
    const t = synthTrack([]);
    expect(await ensureInstrumentSlot(t)).toBe(instrumentSlotId(t.id));
    await ensureInstrumentSlot(t);
    expect(h.bridge.loadPlugin).toHaveBeenCalledTimes(1);
    expect(h.bridge.loadPlugin.mock.calls[0][0]).toMatchObject({ slotId: `inst:${t.id}`, path: 'C:/VST3/Serum.vst3', sampleRate: 44100 });
    expect(states).toEqual([[t.id, 'INIT']]);
    off();
    unloadInstrumentSlot(t.id);
    expect(h.bridge.unloadPlugin).toHaveBeenCalledWith(`inst:${t.id}`);
  });

  it('pont déconnecté / pas un instrument : erreur, le slot n\'est pas gardé', async () => {
    h.bridge.connected = false;
    await expect(ensureInstrumentSlot(synthTrack([]))).rejects.toThrow('Connecte le pont VST');
    h.bridge.connected = true;
    const t = synthTrack([]);
    h.bridge.loadPlugin.mockResolvedValueOnce({ isInstrument: false, name: 'OTT', stateB64: '' });
    await expect(ensureInstrumentSlot(t)).rejects.toThrow("OTT n'est pas un instrument");
    await ensureInstrumentSlot(t);
    expect(h.bridge.loadPlugin).toHaveBeenCalledTimes(2);
  });

  it('renderInstrumentTrack : notes envoyées au pont, rendu stéréo enregistré', async () => {
    const t = synthTrack([midi('m1', 1, 2, [n(60, 0, 1)])]);
    const r = await renderInstrumentTrack(t, 120);
    const req = h.bridge.renderInstrument.mock.calls[0][0];
    expect(req).toMatchObject({
      slotId: `inst:${t.id}`, path: 'C:/VST3/Serum.vst3', sampleRate: 44100, lengthSeconds: 2, tailSeconds: 2,
      notes: [{ pitch: 60, start: 1, duration: 1, velocity: 0.8 }],
    });
    expect(r.clip).toMatchObject({ start: 0, offset: 0, duration: 0.1, type: TrackType.AUDIO, gain: 1 });
    expect(r.clip!.bufferId).toBe(r.clip!.id);
    const b = audioBufferRegistry.get(r.clip!.bufferId!)!;
    expect([b.numberOfChannels, b.length, b.sampleRate]).toEqual([2, 4410, 44100]);
    expect(r.sig).toBe(instrumentRenderSig(t, 120));
    expect(r.clipIds).toEqual(['m1']);
  });

  it('sans notes : pas d\'appel au pont, clip null', async () => {
    const r = await renderInstrumentTrack(synthTrack([midi('m1', 0, 2, [])]), 120);
    expect(r.clip).toBeNull();
    expect(h.bridge.renderInstrument).not.toHaveBeenCalled();
  });

  it('rendu vide : erreur', async () => {
    h.bridge.renderInstrument.mockResolvedValueOnce([]);
    await expect(renderInstrumentTrack(synthTrack([midi('m1', 0, 2, [n(60, 0, 1)])]), 120)).rejects.toThrow('Rendu vide');
  });
});
