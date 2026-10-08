// @vitest-environment jsdom
/**
 * R6 · AudioSuite : la prise d'origine voyage avec le projet (sauvegarde,
 * réouverture, « Revenir à l'original » après coup) et reste en mémoire tant
 * que le clip traité existe (annuler / rétablir).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { trackBufferIds } from '../utils/freeze';
import { audioSuitePatch, audioSuiteRevertPatch, patchClip } from '../utils/clipProcess';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

describe('AudioSuite dans le fichier projet', () => {
  it('la prise d’origine reste en mémoire tant que le clip traité existe', () => {
    const t = makeTrack({ clips: [makeClip({ id: 'c', bufferId: 'as-1', audioSuite: { version: 1, sourceBufferId: 'rec-1', regionStart: 0, steps: [] } })] });
    expect(trackBufferIds(t)).toEqual(expect.arrayContaining(['as-1', 'rec-1']));
  });

  it('aller-retour fichier : le son traité joue, l’original revient après réouverture', async () => {
    audioBufferRegistry.register(makeBuffer(1, 8820, 44100), 'rec-1');
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'as-1');
    const original = makeClip({ id: 'c1', name: 'Prise 1', bufferId: 'rec-1', start: 1, offset: 0.05, duration: 0.08 });
    const treated = patchClip(original, audioSuitePatch(original, { newBufferId: 'as-1', from: 0.03, step: { type: 'DEESSER', name: 'De-esser', at: 1 } }));
    const blob = await ProjectIO.saveProject(makeState([makeTrack({ id: 'track-rec-main', name: 'Voix', clips: [treated] })]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const c = st.tracks[0].clips[0];
    expect(c.bufferId && audioBufferRegistry.get(c.bufferId)?.length).toBe(4410);
    expect(c.audioSuite?.sourceRef).toBeUndefined();
    expect(c.audioSuite?.sourceBufferId && audioBufferRegistry.get(c.audioSuite.sourceBufferId)?.length).toBe(8820);
    const back = patchClip(c, audioSuiteRevertPatch(c, id => audioBufferRegistry.has(id))!);
    expect([back.name, back.start, back.offset, back.duration, back.audioSuite]).toEqual(['Prise 1', 1, 0.05, 0.08, undefined]);
    expect(audioBufferRegistry.get(back.bufferId!)?.length).toBe(8820);
  });
});
