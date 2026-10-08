// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { snapshotOf } from '../utils/recoverySnapshot';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

function project() {
  audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
  audioBufferRegistry.register(makeBuffer(1, 2205, 44100), 'gone-1');
  return makeState([makeTrack({ id: 'lead', name: 'LEAD', comment: 'U87', clips: [makeClip({ id: 'c1', bufferId: 'rec-1', duration: 0.1 })] })], {
    lyrics: 'Couplet', projectNotes: { mix: 'voix devant', references: 'Réf' }, sessionVersion: 3,
    arrangements: [{ id: 'a1', name: 'Clean', sections: ['m1'], mutedClipIds: [], mutedRanges: [{ trackId: 'lead', start: 0, end: 0.05 }] }],
    clipBin: [{ ...makeClip({ id: 'old', name: 'Prise retirée', bufferId: 'gone-1', duration: 0.05 }), fromTrackId: 'lead', fromTrackName: 'LEAD', removedAt: 1 }],
  });
}

describe('R21 · session pro dans le fichier projet', () => {
  it('notes, commentaires, arrangements, numéro de version et clips hors timeline survivent au .zip (son compris)', async () => {
    const blob = await ProjectIO.saveProject(project(), []);
    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('audio/gone-1.wav')).not.toBeNull();
    const json = JSON.parse(await zip.file('project.json')!.async('string'));
    expect(json.clipBin[0]).toMatchObject({ id: 'old', audioRef: 'audio/gone-1.wav' });
    expect(json.clipBin[0].bufferId).toBeUndefined();
    audioBufferRegistry.clear();
    const s = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(s.projectNotes).toMatchObject({ mix: 'voix devant', references: 'Réf' });
    expect(s.tracks[0].comment).toBe('U87');
    expect(s.arrangements![0].mutedRanges).toEqual([{ trackId: 'lead', start: 0, end: 0.05 }]);
    expect(s.sessionVersion).toBe(3);
    expect(s.clipBin![0].bufferId).toBeTruthy();
    expect(audioBufferRegistry.get(s.clipBin![0].bufferId!)?.length).toBe(2205);
  });

  it('import : les sons du projet importé ont un préfixe (rien n’est écrasé dans le projet ouvert)', async () => {
    const blob = await ProjectIO.saveProject(project(), []);
    audioBufferRegistry.clear();
    audioBufferRegistry.register(makeBuffer(1, 999, 44100), 'c1');
    const s = await ProjectIO.loadProject(new File([blob], 'p.zip'), { bufferPrefix: 'imp-' });
    expect(s.tracks[0].clips[0].bufferId).toBe('imp-c1');
    expect(audioBufferRegistry.get('c1')?.length).toBe(999);
  });

  it('historique de l’appareil : le son des clips hors timeline est gardé', () => {
    const snap = snapshotOf(project());
    expect(snap.audioIds.sort()).toEqual(['gone-1', 'rec-1']);
  });
});
