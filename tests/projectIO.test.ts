// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { pluginsSignature } from '../utils/freeze';
import { DAWState, PluginInstance, PluginType, Track } from '../types';
import { makeBuffer, parseWavHeader } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

// Moteur audio : seul le décodage sert au chargement (WAV PCM 16 bits relu pour de vrai).
vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
// Dépendances du gel VST (pont du PC) : inutiles ici.
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const zipOf = async (blob: Blob) => JSZip.loadAsync(blob);
const jsonOf = async (zip: JSZip) => JSON.parse(await zip.file('project.json')!.async('string'));
const reload = (blob: Blob) => ProjectIO.loadProject(new File([blob], 'projet.zip'));

const vst = (id: string): PluginInstance => ({ id, name: 'Serum FX', type: 'VST3' as PluginType, isEnabled: true, params: { a: 1 }, latency: 0 });

/** Beat du catalogue (licence) + voix avec une prise découpée en deux clips + une deuxième prise. */
function project(): DAWState {
  audioBufferRegistry.register(makeBuffer(2, 4410, 44100), 'beat-buf');
  audioBufferRegistry.register(makeBuffer(1, 8820, 44100), 'rec-1');
  audioBufferRegistry.register(makeBuffer(1, 2205, 44100), 'rec-2');
  const beat = makeTrack({
    id: 'instrumental', name: 'Beat', instrumentId: 'cat-uuid-1',
    clips: [makeClip({ id: 'beat-clip', name: 'Mon beat', bufferId: 'beat-buf', duration: 0.1 })],
  });
  const lead = makeTrack({
    id: 'track-rec-main', name: 'Voix',
    clips: [
      makeClip({ id: 'c1', name: 'Prise 1', takeNumber: 1, bufferId: 'rec-1', start: 2, duration: 0.05, offset: 0, fadeIn: 0.01 }),
      makeClip({ id: 'c2', name: 'Prise 1 · 2', takeNumber: 1, bufferId: 'rec-1', start: 3, duration: 0.1, offset: 0.1, fadeOut: 0.02, gain: 0.7 }),
      makeClip({ id: 'c3', name: 'Prise 2', takeNumber: 2, bufferId: 'rec-2', start: 5, duration: 0.05, isMuted: true }),
    ],
  });
  return makeState([beat, lead], { bpm: 92, lyrics: 'yeah' });
}

beforeEach(() => audioBufferRegistry.clear());

describe('ProjectIO.saveProject', () => {
  it('écrit project.json et un WAV par enregistrement (prise découpée écrite une fois)', async () => {
    const zip = await zipOf(await ProjectIO.saveProject(project(), []));
    const files = Object.keys(zip.files).filter(f => !zip.files[f].dir).sort();
    expect(files).toEqual(['audio/rec-1.wav', 'audio/rec-2.wav', 'project.json']);
    const h = parseWavHeader(await zip.file('audio/rec-1.wav')!.async('arraybuffer'));
    expect(h).toMatchObject({ numChannels: 1, sampleRate: 44100, dataSize: 8820 * 2 });
  });

  it('JSON : audioRef à la place de bufferId, beat sans licence marqué et SANS audio', async () => {
    const json = await jsonOf(await zipOf(await ProjectIO.saveProject(project(), [])));
    const [beat, lead] = json.tracks;
    expect(beat.clips[0]).toMatchObject({ audioRef: 'audio/beat-buf.wav', isUnlicensed: true });
    expect(beat.clips[0].bufferId).toBeUndefined();
    expect(lead.clips.map((c: any) => c.audioRef)).toEqual(['audio/rec-1.wav', 'audio/rec-1.wav', 'audio/rec-2.wav']);
    expect(lead.clips.every((c: any) => c.bufferId === undefined && c.buffer === undefined)).toBe(true);
    expect(json.bpm).toBe(92);
    expect(json.lyrics).toBe('yeah');
  });

  it('beat acheté : son audio est inclus (id comparé en texte, entier ou UUID)', async () => {
    const st = project();
    st.tracks[0].instrumentId = 42;
    const zip = await zipOf(await ProjectIO.saveProject(st, ['42']));
    expect(zip.file('audio/beat-buf.wav')).not.toBeNull();
    const json = await jsonOf(zip);
    expect(json.tracks[0].clips[0].isUnlicensed).toBeUndefined();

    const st2 = project();
    const zip2 = await zipOf(await ProjectIO.saveProject(st2, ['cat-uuid-1']));
    expect(zip2.file('audio/beat-buf.wav')).not.toBeNull();
  });

  it("ne modifie pas l'état d'origine", async () => {
    const st = project();
    const before = JSON.stringify(st);
    await ProjectIO.saveProject(st, []);
    expect(JSON.stringify(st)).toBe(before);
    expect(st.tracks[1].clips[0].bufferId).toBe('rec-1');
  });
});

describe('ProjectIO : aller-retour save -> load', () => {
  it('structure, timing des clips et buffers décodés', async () => {
    const st = project();
    const blob = await ProjectIO.saveProject(st, []);
    audioBufferRegistry.clear();
    const loaded = await reload(blob);

    expect(loaded.tracks.map(t => t.id)).toEqual(['instrumental', 'track-rec-main']);
    expect(loaded.bpm).toBe(92);
    const lead = loaded.tracks[1];
    expect(lead.clips.map(c => [c.id, c.start, c.duration, c.offset, c.fadeIn, c.fadeOut, c.takeNumber, !!c.isMuted]))
      .toEqual(st.tracks[1].clips.map(c => [c.id, c.start, c.duration, c.offset, c.fadeIn, c.fadeOut, c.takeNumber, !!c.isMuted]));
    expect(lead.clips[1].gain).toBe(0.7);
    // Plus aucune référence interne au zip
    expect(lead.clips.every(c => c.audioRef === undefined)).toBe(true);

    // Les deux morceaux d'une même prise partagent un seul buffer décodé
    const [c1, c2, c3] = lead.clips;
    expect(c1.bufferId).toBeTruthy();
    expect(c2.bufferId).toBe(c1.bufferId);
    expect(c3.bufferId).not.toBe(c1.bufferId);
    const b1 = audioBufferRegistry.get(c1.bufferId!)!;
    const b3 = audioBufferRegistry.get(c3.bufferId!)!;
    expect([b1.numberOfChannels, b1.length, b1.sampleRate]).toEqual([1, 8820, 44100]);
    expect([b3.numberOfChannels, b3.length]).toEqual([1, 2205]);
  });

  it('beat sans licence : clip hors ligne, grisé, sans buffer', async () => {
    const blob = await ProjectIO.saveProject(project(), []);
    audioBufferRegistry.clear();
    const beat = (await reload(blob)).tracks[0];
    expect(beat.clips[0].bufferId).toBeUndefined();
    expect(beat.clips[0].name).toBe('🚫 Mon beat (Licence requise)');
    expect(beat.clips[0].color).toBe('#555555');
    expect(audioBufferRegistry.size).toBe(2); // rec-1 et rec-2 seulement
  });

  it('beat acheté : rechargé avec son audio stéréo', async () => {
    const blob = await ProjectIO.saveProject(project(), ['cat-uuid-1']);
    audioBufferRegistry.clear();
    const beat = (await reload(blob)).tracks[0];
    const b = audioBufferRegistry.get(beat.clips[0].bufferId!)!;
    expect(b.numberOfChannels).toBe(2);
    expect(beat.clips[0].name).toBe('Mon beat');
  });
});

describe('ProjectIO : rendus gelés', () => {
  function frozenTrack(over: Partial<Track>): Track {
    audioBufferRegistry.register(makeBuffer(2, 1000, 44100), 'fz-buf');
    return makeTrack({
      id: 'track-vst', name: 'Voix VST',
      clips: [makeClip({ id: 'v1', bufferId: 'rec-1', start: 0, duration: 0.1 })],
      frozenClip: makeClip({ id: 'fz-1', bufferId: 'fz-buf', duration: 0.2, name: 'Rendu' }),
      frozenClipIds: ['v1'],
      ...over,
    });
  }

  it('piste gelée : rendu sauvegardé et rechargé, piste toujours gelée', async () => {
    const st = project();
    st.tracks.push(frozenTrack({ isFrozen: true, frozenUpToPluginIndex: 0, plugins: [vst('p-1')] }));
    const zip = await zipOf(await ProjectIO.saveProject(st, []));
    expect(zip.file('audio/frozen-track-vst.wav')).not.toBeNull();
    const json = await jsonOf(zip);
    expect(json.tracks[2].frozenClip.audioRef).toBe('audio/frozen-track-vst.wav');
    expect(json.tracks[2].frozenClip.bufferId).toBeUndefined();
    expect(json.tracks[2].isFrozen).toBe(true);

    audioBufferRegistry.clear();
    const t = (await reload(await zip.generateAsync({ type: 'blob' }))).tracks[2];
    expect(t.isFrozen).toBe(true);
    expect(t.frozenClip!.bufferId).toBe('fz-1');
    expect(t.frozenClip!.audioRef).toBeUndefined();
    expect(audioBufferRegistry.get('fz-1')!.length).toBe(1000);
    expect(t.frozenClipIds).toEqual(['v1']);
  });

  it('rendu VST à jour (cache PC, piste non gelée) : sauvegardé, le projet s\'ouvre gelé ailleurs', async () => {
    const plugins = [vst('p-1')];
    const st = project();
    st.tracks.push(frozenTrack({ isFrozen: false, frozenUpToPluginIndex: 0, plugins, frozenPluginSig: pluginsSignature(plugins, 0) }));
    const json = await jsonOf(await zipOf(await ProjectIO.saveProject(st, [])));
    expect(json.tracks[2].isFrozen).toBe(true);
    expect(json.tracks[2].frozenClip.audioRef).toBe('audio/frozen-track-vst.wav');
  });

  it('rendu VST périmé (effet modifié depuis) : abandonné', async () => {
    const plugins = [vst('p-1')];
    const st = project();
    st.tracks.push(frozenTrack({ isFrozen: false, frozenUpToPluginIndex: 0, plugins, frozenPluginSig: 'ancienne-empreinte' }));
    const zip = await zipOf(await ProjectIO.saveProject(st, []));
    expect(zip.file('audio/frozen-track-vst.wav')).toBeNull();
    const t = (await jsonOf(zip)).tracks[2];
    expect(t.frozenClip).toBeUndefined();
    expect(t.frozenClipIds).toBeUndefined();
    expect(t.isFrozen).toBe(false);
  });

  it('jamais de rendu gelé pour le beat (licence)', async () => {
    const st = project();
    audioBufferRegistry.register(makeBuffer(2, 1000), 'fz-beat');
    Object.assign(st.tracks[0], { isFrozen: true, frozenClip: makeClip({ id: 'fz-b', bufferId: 'fz-beat' }) });
    const zip = await zipOf(await ProjectIO.saveProject(st, ['cat-uuid-1']));
    expect(zip.file('audio/frozen-instrumental.wav')).toBeNull();
    const beat = (await jsonOf(zip)).tracks[0];
    expect(beat.frozenClip).toBeUndefined();
    expect(beat.isFrozen).toBe(false);
  });

  it('au chargement, rendu gelé absent du zip : la piste repasse en direct', async () => {
    const st = project();
    st.tracks.push(frozenTrack({ isFrozen: true, plugins: [vst('p-1')] }));
    const zip = await zipOf(await ProjectIO.saveProject(st, []));
    zip.remove('audio/frozen-track-vst.wav');
    audioBufferRegistry.clear();
    const t = (await reload(await zip.generateAsync({ type: 'blob' }))).tracks[2];
    expect(t.frozenClip).toBeUndefined();
    expect(t.isFrozen).toBe(false);
  });
});

describe('ProjectIO.loadProject : fichiers invalides', () => {
  const zipWith = async (files: Record<string, string>) => {
    const z = new JSZip();
    Object.entries(files).forEach(([k, v]) => z.file(k, v));
    return z.generateAsync({ type: 'blob' });
  };

  it('sans project.json', async () => {
    await expect(reload(await zipWith({ 'autre.txt': 'x' }))).rejects.toThrow('project.json manquant');
  });

  it('JSON corrompu', async () => {
    await expect(reload(await zipWith({ 'project.json': '{pas du json' }))).rejects.toThrow('Fichier projet corrompu');
  });

  it('sans pistes', async () => {
    await expect(reload(await zipWith({ 'project.json': '{"name":"x"}' }))).rejects.toThrow('Format de projet invalide');
  });

  it('audio manquant (pas une licence) : clip gardé, sans buffer, nom intact', async () => {
    const st = project();
    const zip = await zipOf(await ProjectIO.saveProject(st, []));
    zip.remove('audio/rec-2.wav');
    audioBufferRegistry.clear();
    const lead = (await reload(await zip.generateAsync({ type: 'blob' }))).tracks[1];
    expect(lead.clips[2].bufferId).toBeUndefined();
    expect(lead.clips[2].name).toBe('Prise 2');
    expect(lead.clips[0].bufferId).toBeTruthy();
  });
});

describe('ProjectIO : piste 808', () => {
  it('réglages 808 et notes conservés (sauvegarde puis rechargement)', async () => {
    const st = project();
    const notes = [{ id: 'a', pitch: 31, start: 0, duration: 0.5, velocity: 0.9 }, { id: 'b', pitch: 38, start: 0.4, duration: 0.5, velocity: 0.8 }];
    st.tracks.push(makeTrack({ id: 'track-808', name: '808', type: 'MIDI' as any, bass808: { style: '808-dist', glide: true, glideTime: 0.07 },
      clips: [makeClip({ id: 'c808', type: 'MIDI' as any, duration: 2, notes })] }));
    const loaded = await reload(await ProjectIO.saveProject(st, []));
    const t = loaded.tracks.find(x => x.id === 'track-808')!;
    expect(t.bass808).toEqual({ style: '808-dist', glide: true, glideTime: 0.07 });
    expect(t.clips[0].notes).toEqual(notes);
  });
});

describe('couloirs de prises (V4) : sauvegarde et anciens projets', () => {
  it('les couloirs (prises mutées + takeMeta) et le comp survivent à la sauvegarde', async () => {
    const { compSwipe, readComp } = await import('../utils/comping');
    const { listLanes } = await import('../utils/playlists');
    const st = project();
    const lead = st.tracks[1];
    lead.clips = [
      makeClip({ id: 'p1', name: 'Prise 1', takeNumber: 1, bufferId: 'rec-1', start: 0, duration: 0.2, isMuted: true }),
      makeClip({ id: 'p2', name: 'Prise 2', takeNumber: 2, bufferId: 'rec-2', start: 0, duration: 0.05 }),
    ];
    lead.clips = compSwipe(lead.clips, 1, 0.1, 0.2, { xfade: 0.01 }).clips;
    lead.takeMeta = [{ n: 1, name: 'Couplet', recordedAt: 123, loopPass: 2 }];
    const loaded = await reload(await ProjectIO.saveProject(st, []));
    const l2 = loaded!.tracks.find(t => t.id === lead.id)!;
    expect(l2.takeMeta).toEqual(lead.takeMeta);
    expect(readComp(l2.clips)).toEqual(readComp(lead.clips));
    expect(listLanes(l2).map(l => l.n)).toEqual([1, 2]);
    expect(l2.clips.every(c => !c.bufferId || audioBufferRegistry.has(c.bufferId))).toBe(true);
  });

  it('ancien projet sans takeMeta (prises « Prise N ») : s’ouvre, couloirs déduits', async () => {
    const { listLanes } = await import('../utils/playlists');
    const loaded = await reload(await ProjectIO.saveProject(project(), []));
    const lead = loaded!.tracks.find(t => t.id === 'track-rec-main')!;
    expect(lead.takeMeta).toBeUndefined();
    expect(listLanes(lead).map(l => [l.n, l.name])).toEqual([[1, 'Prise 1'], [2, 'Prise 2']]);
  });
});
