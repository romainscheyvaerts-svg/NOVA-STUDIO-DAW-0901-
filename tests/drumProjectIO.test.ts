// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { TrackType } from '../types';
import { makeDrumMachine } from '../utils/drumKits';
import { addPattern, ensurePatterns, placePattern, setStepParam } from '../utils/drumPatterns';
import { assignSample, padSampleKey, setPadLayer } from '../utils/drumSamples';
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

describe('séquenceur pro et sampler de pad sauvés avec le projet (.zip)', () => {
  it('réglages par pas, sampler du pad et couche perso (son compris) : relus à l’identique', async () => {
    audioBufferRegistry.register(makeBuffer(1, 2205, 44100), padSampleKey('kick1'));
    audioBufferRegistry.register(makeBuffer(1, 1102, 44100), padSampleKey('layer1'));
    let dm = makeDrumMachine('trap');
    dm = assignSample(dm, 'kick1', { name: 'Mon kick', duration: 0.05 }, { rowIndex: 0 })!.dm;
    dm = setStepParam(setStepParam(setStepParam(dm, 0, 0, 'prob', 40), 0, 0, 'nudge', -12), 0, 0, 'gate', 2);
    dm = setPadLayer(dm, 0, null, 'user:layer1', 'Couche', { id: 'layer1', info: { name: 'Couche', duration: 0.025 } });
    dm = { ...dm, seed: 3, rows: dm.rows.map((r, i) => (i === 0 ? { ...r, shift: 10, smp: { ...r.smp, attack: 0.01, filterType: 'lp' as const, cutoff: 800, layerMode: 'rr' as const } } : r)) };
    dm = addPattern(dm, { copyFrom: ensurePatterns(dm).activePattern });
    const st = makeState([makeTrack({ id: 'track-drums', type: TrackType.DRUM_RACK, drumMachine: dm })]);
    const blob = await ProjectIO.saveProject(st, []);
    const zip = await JSZip.loadAsync(blob);
    expect(Object.keys(zip.files)).toContain('audio/pad-layer1.wav');
    audioBufferRegistry.clear();
    const loaded = (await ProjectIO.loadProject(new File([blob], 'p.zip'))).tracks[0].drumMachine!;
    expect(audioBufferRegistry.get(padSampleKey('layer1'))!.length).toBe(1102);
    const strip = (d: typeof dm) => JSON.parse(JSON.stringify({ ...d, samples: Object.keys(d.samples || {}).sort() }));
    expect(strip(loaded)).toEqual(strip(dm));
    expect(loaded.rows[0].smp).toMatchObject({ attack: 0.01, filterType: 'lp', cutoff: 800, layerMode: 'rr', layers: [{ sound: 'user:layer1' }] });
    expect(loaded.patterns![1].prob!.kick).toEqual(dm.patterns![1].prob!.kick);
  });
});

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
