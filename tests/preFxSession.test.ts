// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { anchorClipsToRender, busFrozenSlices, isFeedCovered, pluginsSignature, sendFreezeSlices } from '../utils/freeze';
import { makeFreezeBase, preFxOps, setEditAuthor } from '../utils/preFxEdits';
import { applyRefreeze, applyThaw, missingPlugins, planThaw, replaySummary, thawCandidates } from '../utils/preFxThaw';
import { PluginInstance, PluginType, SendFreeze, Track, TrackType } from '../types';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const VERB = 'C:\\Program Files\\Common Files\\VST3\\Valhalla.vst3';
const COMP = 'C:\\Program Files\\Common Files\\VST3\\Comp.vst3';
const vst = (id: string, path: string, name: string): PluginInstance =>
  ({ id, name, type: 'VST3' as PluginType, isEnabled: true, params: { localPath: path, name }, latency: 0 });

/**
 * Session « PC » telle que la sauvegarde la gèle : voix (VST compresseur en
 * insert, envoi vers une reverb VST) + bus reverb VST gelé, rendus par source.
 */
function pcSession() {
  audioBufferRegistry.register(makeBuffer(1, 44100 * 1, 44100), 'rec');
  audioBufferRegistry.register(makeBuffer(2, 44100 * 1, 44100), 'fz-voix');
  audioBufferRegistry.register(makeBuffer(2, 2205, 44100), 'fz-bus');
  audioBufferRegistry.register(makeBuffer(2, 44100 * 1, 44100), 'snd-voix');
  const verbPlugins = [vst('pv', VERB, 'Valhalla')];
  const bus = makeTrack({
    id: 'verb', name: 'Reverb VST', type: TrackType.SEND, clips: [], sends: [], plugins: verbPlugins,
    isFrozen: false, frozenClip: makeClip({ id: 'fz-bus', bufferId: 'fz-bus', duration: 0.05 }),
    frozenUpToPluginIndex: 0, frozenClipIds: [], frozenPluginSig: pluginsSignature(verbPlugins, 0),
  });
  const compPlugins = [vst('pc', COMP, 'Comp')];
  const clips = [
    makeClip({ id: 'a', name: 'Phrase A', bufferId: 'rec', start: 0, offset: 0, duration: 0.3 }),
    makeClip({ id: 'b', name: 'Phrase B', bufferId: 'rec', start: 0.5, offset: 0.4, duration: 0.3 }),
  ];
  const anchors = anchorClipsToRender(clips, 'fz-voix');
  const sf: SendFreeze = {
    busId: 'verb', busRenderId: 'fz-bus', anchorId: 'fz-voix', volume: 0.8, level: 0.5, sig: 's',
    clip: makeClip({ id: 'snd-voix', bufferId: 'snd-voix', duration: 1 }),
  };
  const voix = makeTrack({
    id: 'voix', name: 'Voix lead', plugins: compPlugins, volume: 0.8,
    sends: [{ id: 'verb', level: 0.5, isEnabled: true }],
    clips: clips.map(c => ({ ...c, freezeRef: anchors.get(c.id) })),
    isFrozen: false, frozenClip: makeClip({ id: 'fz-voix', bufferId: 'fz-voix', duration: 1 }),
    frozenUpToPluginIndex: 0, frozenClipIds: ['a', 'b'], frozenPluginSig: pluginsSignature(compPlugins, 0),
    sendFreezes: [sf],
  });
  voix.freezeBase = makeFreezeBase(voix, 'fz-voix', "l'ingé", 5);
  return makeState([voix, bus]);
}

const zipOf = async (blob: Blob) => JSZip.loadAsync(blob);
const jsonOf = async (zip: JSZip) => JSON.parse(await zip.file('project.json')!.async('string'));
const reload = (blob: Blob) => ProjectIO.loadProject(new File([blob], 'projet.zip'));

beforeEach(() => { audioBufferRegistry.clear(); setEditAuthor(''); });

describe('bus reverb VST gelé : tranches par source', () => {
  const frozen = () => {
    const st = pcSession();
    st.tracks.forEach(t => { t.isFrozen = true; t.frozenAuto = true; });
    return st.tracks as [Track, Track];
  };

  it('le bus joue les tranches de la voix ; l\'envoi direct de la voix est coupé', () => {
    const [voix, bus] = frozen();
    expect(isFeedCovered(voix, 'verb', [voix, bus])).toBe(true);
    const slices = busFrozenSlices(bus, [voix, bus]);
    expect(slices.map(s => s.id)).toEqual(['voix:a~snd-verb', 'voix:b~snd-verb']);
    expect(slices.every(s => s.isFreezeSlice && s.bufferId === 'snd-voix')).toBe(true);
  });

  it('voix supprimée sur la tablette : sa reverb part avec elle', () => {
    const [voix, bus] = frozen();
    const edited = { ...voix, clips: voix.clips.filter(c => c.id !== 'b') };
    expect(sendFreezeSlices(edited, bus).map(s => s.id)).toEqual(['voix:a~snd-verb']);
  });

  it('fader de la voix ou niveau d\'envoi changés : la reverb suit ; voix mutée : plus rien', () => {
    const [voix, bus] = frozen();
    const louder = { ...voix, volume: 0.4, sends: [{ id: 'verb', level: 1, isEnabled: true }] };
    expect(sendFreezeSlices(louder, bus)[0].gain).toBeCloseTo((0.4 / 0.8) * (1 / 0.5));
    expect(sendFreezeSlices({ ...voix, isMuted: true }, bus)).toEqual([]);
  });

  it('bus dégelé (PC) : plus de tranches, l\'envoi direct revient', () => {
    const [voix, bus] = frozen();
    const live = { ...bus, isFrozen: false };
    expect(isFeedCovered(voix, 'verb', [voix, live])).toBe(false);
    expect(busFrozenSlices(live, [voix, live])).toEqual([]);
  });
});

describe('retour sur le PC : dégel automatique', () => {
  it('plugins présents : piste et bus dégelés ; plugin manquant : gelé et signalé', () => {
    const st = pcSession();
    st.tracks.forEach(t => { t.isFrozen = true; t.frozenAuto = true; });
    expect(thawCandidates(st.tracks).map(t => t.id)).toEqual(['voix', 'verb']);
    expect(missingPlugins(st.tracks[1], [COMP])).toEqual(['Valhalla']);
    const plan = planThaw(st.tracks, [COMP.toUpperCase().replace(/\\/g, '/')]);
    expect(plan.thaw).toEqual(['voix']);
    expect(plan.missing).toEqual([{ trackId: 'verb', trackName: 'Reverb VST', plugins: ['Valhalla'] }]);
    applyThaw(st.tracks, plan.thaw);
    expect(st.tracks[0]).toMatchObject({ isFrozen: false });
    expect(st.tracks[0].frozenAuto).toBeUndefined();
    applyRefreeze(st.tracks, plan.thaw);
    expect(st.tracks[0]).toMatchObject({ isFrozen: true, frozenAuto: true });
  });

  it('gel manuel (CPU) : jamais dégelé tout seul', () => {
    const st = pcSession();
    st.tracks[0].isFrozen = true;
    expect(thawCandidates(st.tracks)).toEqual([]);
  });

  it('résumé : « N éditions de <auteur> réappliquées avant les effets », y compris via le bus', () => {
    const st = pcSession();
    const voix = st.tracks[0];
    voix.clips = voix.clips.filter(c => c.id !== 'b').map(c => ({ ...c, fadeOut: 0.1 }));
    voix.preFxJournal = { v: 1, renderId: 'fz-voix', ops: preFxOps(voix).map(o => ({ ...o, by: "L'AMG", ts: 1 })) };
    const s = replaySummary(st.tracks, ['verb']); // seule la reverb est dégelée : la voix l'alimente
    expect(s.total).toBe(2);
    expect(s.line).toBe("2 éditions de L'AMG réappliquées avant les effets");
    expect(s.tracks[0].trackId).toBe('voix');
    expect(s.tracks[0].text.split(', ').sort()).toEqual(['1 clip supprimé', '1 fondu']);
  });
});

describe('sauvegarde : format v2 et rétrocompatibilité', () => {
  it('PC : gel automatique (frozenAuto), rendu d\'envoi, photo et son d\'un clip supprimé gardés', async () => {
    const st = pcSession();
    // Tablette : l'artiste a supprimé la phrase B (dont le son n'est plus utilisé par aucun clip)…
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-b');
    st.tracks[0].freezeBase!.clips[1] = { ...st.tracks[0].freezeBase!.clips[1], bufferId: 'rec-b' } as any;
    st.tracks[0].clips = st.tracks[0].clips.filter(c => c.id !== 'b');
    setEditAuthor("L'AMG");
    const zip = await zipOf(await ProjectIO.saveProject(st, []));
    const json = await jsonOf(zip);
    expect(json.schemaVersion).toBe(2);
    const [voix, bus] = json.tracks;
    expect(voix).toMatchObject({ isFrozen: true, frozenAuto: true });
    expect(bus).toMatchObject({ isFrozen: true, frozenAuto: true });
    expect(voix.sendFreezes[0].clip.audioRef).toBe('audio/send-voix-verb.wav');
    expect(zip.file('audio/send-voix-verb.wav')).not.toBeNull();
    expect(voix.freezeBase.clips.map((c: any) => c.audioRef)).toEqual(['audio/rec.wav', 'audio/rec-b.wav']);
    expect(zip.file('audio/rec-b.wav')).not.toBeNull();
    expect(voix.preFxJournal.ops).toEqual([expect.objectContaining({ kind: 'delete', baseClipId: 'b', by: "L'AMG" })]);

    audioBufferRegistry.clear();
    const back = await reload(await zip.generateAsync({ type: 'blob' }));
    const v = back.tracks[0];
    expect(v.sendFreezes![0].clip.bufferId).toBe('snd-voix');
    expect(audioBufferRegistry.get(v.sendFreezes![0].clip.bufferId!)).toBeTruthy();
    expect((v.freezeBase!.clips[0] as any).bufferId).toBe(v.clips[0].bufferId); // même fichier = même son
    expect(audioBufferRegistry.get((v.freezeBase!.clips[1] as any).bufferId)).toBeTruthy();
    expect(preFxOps(v).map(o => o.kind)).toEqual(['delete']);
  });

  it('bus VST dont l\'effet a changé : rendu abandonné, ses rendus d\'envoi aussi', async () => {
    const st = pcSession();
    st.tracks[1].plugins[0].params.stateB64 = 'nouveau-reglage';
    const json = await jsonOf(await zipOf(await ProjectIO.saveProject(st, [])));
    expect(json.tracks[1].isFrozen).toBe(false);
    expect(json.tracks[0].sendFreezes).toBeUndefined();
    expect(json.tracks[0].freezeBase).toBeDefined(); // la voix garde son propre rendu
  });

  it('ancienne session (sans version, sans photo) : s\'ouvre comme avant', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'old');
    const legacy = makeState([makeTrack({ id: 'v', clips: [makeClip({ id: 'c', bufferId: 'old' })] })]) as any;
    const zip = new JSZip();
    const blob = await ProjectIO.saveProject(legacy, []);
    const z = await zipOf(blob);
    const j = await jsonOf(z);
    delete j.schemaVersion;
    z.file('project.json', JSON.stringify(j));
    audioBufferRegistry.clear();
    const back = await reload(await z.generateAsync({ type: 'blob' }));
    expect(back.tracks[0].clips[0].bufferId).toBeTruthy();
    expect(back.tracks[0].freezeBase).toBeUndefined();
    expect(back.tracks[0].sendFreezes).toBeUndefined();
    expect(zip).toBeTruthy();
  });
});

describe('fusion de deux versions de la session (conflit en ligne)', () => {
  it('éditions de l\'artiste reprises, conflit expliqué, nouvelle piste ajoutée, l\'autre version à un clic', async () => {
    const { mergeSessionEdits, takeTheirsFor } = await import('../utils/preFxMerge');
    const mine = pcSession();                       // PC de l'ingé
    const theirs = JSON.parse(JSON.stringify(pcSession())); // tablette de l'artiste
    // Ingé : fondu sur la phrase B. Artiste : supprime la phrase A, change aussi la phrase B, ajoute une piste.
    mine.tracks[0].clips = mine.tracks[0].clips.map(c => (c.id === 'b' ? { ...c, fadeOut: 0.2 } : c));
    theirs.tracks[0].clips = theirs.tracks[0].clips.filter((c: any) => c.id !== 'a').map((c: any) => (c.id === 'b' ? { ...c, gain: 0.5 } : c));
    theirs.tracks.push(makeTrack({ id: 'chœurs', name: 'Chœurs' }));
    const m = mergeSessionEdits(mine, theirs);
    const voix = m.state.tracks[0];
    expect(voix.clips.map(c => c.id)).toEqual(['b']);              // A supprimée (artiste)
    expect(voix.clips[0].fadeOut).toBe(0.2);                        // B : version de l'ingé gardée
    expect(voix.clips[0].gain ?? 1).toBe(1);
    expect(m.conflicts).toEqual([expect.objectContaining({ trackId: 'voix', baseClipId: 'b', mine: '1 fondu', theirs: '1 volume de clip' })]);
    expect(m.addedTrackIds).toEqual(['chœurs']);
    expect(m.mergedTrackIds).toEqual(['voix']);
    const alt = takeTheirsFor(voix, theirs.tracks[0], 'b');
    expect(alt.find(c => c.freezeRef?.srcClipId === 'b')).toMatchObject({ gain: 0.5, fadeOut: 0 });
  });

  it('photos différentes (re-rendu entre-temps) : aucune fusion de clips, version de cet appareil gardée', async () => {
    const { mergeSessionEdits } = await import('../utils/preFxMerge');
    const mine = pcSession();
    const theirs = JSON.parse(JSON.stringify(pcSession()));
    theirs.tracks[0].freezeBase.renderId = 'autre-rendu';
    theirs.tracks[0].clips = [];
    const m = mergeSessionEdits(mine, theirs);
    expect(m.state.tracks[0].clips.map(c => c.id)).toEqual(['a', 'b']);
    expect(m.conflicts).toEqual([]);
  });
});
