// @vitest-environment jsdom
/**
 * Nova Pitch : sauvegarde .zip (retouches + analyse de la voix), réouverture,
 * et collaboration (les retouches passent dans l'op « content » avec le clip).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { channel: () => ({}), removeChannel: async () => 'ok' } }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));

import { ProjectIO } from '../services/ProjectIO';
import { contentBufferIds, contentOf } from '../services/Collab';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { analysisCache, analysisKey } from '../engine/pitch/analysis';
import { analyzePitch, segmentNotes } from '../utils/pitchAnalysis';
import { infoSig } from '../utils/novaPitch';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { synthVoice } from './helpers/synthVoice';

beforeEach(() => { audioBufferRegistry.clear(); analysisCache.clear(); });

const pe = {
  version: 1 as const, sourceBufferId: 'rec-1', regionStart: 0.02, regionEnd: 0.09,
  edits: [{ t0: 0.03, t1: 0.05, shift: 0.02, drift: 0, vibrato: 1, gain: -3, dt1: 0.004 }],
  cuts: [0.04], extend: 0.004, renderSig: '',
};

describe('sauvegarde .zip : retouches et analyse', () => {
  it('aller-retour : retouches (gain, timing, découpage) et analyse gardées, pas de nouvelle analyse', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
    audioBufferRegistry.register(makeBuffer(1, 3270, 44100), 'nvp-c1-1');
    const x = synthVoice(44100, 0.1, [{ midi: 60, at: 0.01, len: 0.08 }]);
    const track = analyzePitch(x, 44100);
    analysisCache.set(analysisKey('rec-1', 0.02, 0.09), { track, notes: segmentNotes(track) });
    const info = { ...pe, renderSig: infoSig(pe) };
    const lead = makeTrack({ id: 'track-rec-main', name: 'Voix', clips: [makeClip({ id: 'c1', name: 'Prise 1 (notes retouchées)', bufferId: 'nvp-c1-1', start: 1, offset: 0.01, duration: 0.034, pitchEdit: info })] });
    const blob = await ProjectIO.saveProject(makeState([lead]), []);
    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('pitch/c1.bin')).toBeTruthy();
    audioBufferRegistry.clear();
    analysisCache.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const c = st.tracks[0].clips[0];
    const p = c.pitchEdit!;
    expect(p.edits[0]).toMatchObject({ shift: 0.02, gain: -3, dt1: 0.004 });
    expect(p.cuts).toEqual([0.04]);
    expect(p.extend).toBe(0.004);
    expect(p.renderSig).toBe(infoSig(p));
    expect(analysisCache.get(analysisKey(p.sourceBufferId!, 0.02, 0.09))?.track.midi.length).toBe(track.midi.length);
  });

  it('rendu encore en attente au moment de sauver : la prise d’origine est le son du clip, une seule fois', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
    const lead = makeTrack({ clips: [makeClip({ id: 'c1', bufferId: 'rec-1', duration: 0.05, pitchEdit: pe })] });
    const blob = await ProjectIO.saveProject(makeState([lead]), []);
    const zip = await JSZip.loadAsync(blob);
    expect(Object.keys(zip.files).filter(f => f.startsWith('audio/') && f.endsWith('.wav'))).toHaveLength(1);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const c = st.tracks[0].clips[0];
    expect(c.bufferId).toBe(c.pitchEdit?.sourceBufferId);
  });
});

describe('collaboration : les retouches voyagent dans le contenu du clip', () => {
  it('op « content » : retouches, découpage, signature ; son rendu et prise d’origine envoyés', () => {
    const info = { ...pe, renderSig: infoSig(pe) };
    const t = makeTrack({ id: 'v', clips: [makeClip({ id: 'c1', bufferId: 'nvp-c1-1', pitchEdit: info })] });
    const wire = JSON.parse(JSON.stringify(contentOf(t)));
    expect(wire.clips[0].pitchEdit).toMatchObject({ cuts: [0.04], extend: 0.004, renderSig: infoSig(pe) });
    expect(wire.clips[0].pitchEdit.edits[0]).toMatchObject({ gain: -3, dt1: 0.004 });
    expect(contentBufferIds(t)).toEqual(['nvp-c1-1', 'rec-1']);
  });
});
