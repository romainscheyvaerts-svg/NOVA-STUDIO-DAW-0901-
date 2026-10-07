// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { TrackType } from '../types';
import { makeDrumMachine } from '../utils/drumKits';
import { addPattern, placePattern } from '../utils/drumPatterns';
import { assignSample, padSampleKey } from '../utils/drumSamples';
import { chopIntoPads, pointsToSlices, equalPoints } from '../utils/chop';
import { makeBuffer } from './helpers/audio';
import { makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

/** Batterie avec motifs, placement, un sample perso et une boucle découpée. */
function drumProject() {
  audioBufferRegistry.register(makeBuffer(1, 2205, 44100), padSampleKey('kick1'));
  audioBufferRegistry.register(makeBuffer(2, 8820, 44100), padSampleKey('loop1'));
  let dm = makeDrumMachine('trap');
  dm = assignSample(dm, 'kick1', { name: 'Mon kick', duration: 0.05 }, { rowIndex: 0 })!.dm;
  dm = chopIntoPads(dm, 'loop1', { name: 'Boucle', duration: 0.2, bpm: 100 }, pointsToSlices(equalPoints(8820, 4), 8820), { bufferBpm: 100, duration: 0.2 }).dm;
  dm = addPattern(dm);
  dm = placePattern(dm, dm.patterns![0].id, 0, 2, 4);
  const drums = makeTrack({ id: 'track-drums', type: TrackType.DRUM_RACK, drumMachine: dm });
  return makeState([drums]);
}

describe('kit perso sauvé avec le projet', () => {
  it('un WAV par sample perso, relu à l\'ouverture ; motifs et placement intacts', async () => {
    const st = drumProject();
    const blob = await ProjectIO.saveProject(st, []);
    const zip = await JSZip.loadAsync(blob);
    expect(Object.keys(zip.files).filter(f => !zip.files[f].dir).sort()).toEqual(['audio/pad-kick1.wav', 'audio/pad-loop1.wav', 'project.json']);
    const json = JSON.parse(await zip.file('project.json')!.async('string'));
    expect(json.tracks[0].drumMachine.samples.kick1.audioRef).toBe('audio/pad-kick1.wav');

    audioBufferRegistry.clear();
    const loaded = await ProjectIO.loadProject(new File([blob], 'projet.zip'));
    const dm = loaded.tracks[0].drumMachine!;
    expect(audioBufferRegistry.get(padSampleKey('kick1'))!.length).toBe(2205);
    expect(audioBufferRegistry.get(padSampleKey('loop1'))!.numberOfChannels).toBe(2);
    expect(dm.samples!.kick1).toEqual({ name: 'Mon kick', duration: 0.05 });
    expect(dm.patterns!.map(p => p.name)).toEqual(st.tracks[0].drumMachine!.patterns!.map(p => p.name));
    expect(dm.song).toEqual(st.tracks[0].drumMachine!.song);
    expect(dm.rows.filter(r => r.slice).map(r => [r.start, r.end])).toEqual([[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]]);
  });

  it('un projet d\'avant la V16 (motif unique, sans samples) s\'ouvre tel quel', async () => {
    const old = makeDrumMachine('trap');
    const st = makeState([makeTrack({ id: 'track-drums', type: TrackType.DRUM_RACK, drumMachine: old })]);
    const loaded = await ProjectIO.loadProject(new File([await ProjectIO.saveProject(st, [])], 'p.zip'));
    expect(loaded.tracks[0].drumMachine).toEqual(JSON.parse(JSON.stringify(old)));
  });
});
