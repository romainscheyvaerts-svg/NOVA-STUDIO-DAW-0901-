// @vitest-environment jsdom
/**
 * R4 · Presets d'effets et Track Presets : aller-retour identique (effet NOVA
 * et VST), Comparer (A/B de Pro Tools), rangement (favoris, renommer,
 * supprimer, import / export), Track Presets livrés fidèles aux règles du
 * studio, rappel sur une piste existante et à la création, collaboration
 * (une seule opération).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PluginInstance, Track, TrackType } from '../types';
import { makeTrack } from './helpers/fixtures';
import {
  applyPluginPreset, applyTrackPreset, compareInit, compareModified, compareOnEdit, compareReadback, compareToggle, comparing,
  createTrackFromPreset, makePluginPreset, makeTrackPreset, matchesPreset, parsePresetFile, presetMatches, presetTargetKey,
  resolvePresetPlugins, sameSettings, serializePreset, soundSettingsOf, TrackPreset, trackPresetSummary, withSoundSettings,
} from '../utils/presets';
import {
  deletePreset, exportPresetFile, getPreset, importPresetText, isFavorite, listPluginPresets, listTrackPresets, memoryPresetBackend,
  renamePreset, savePreset, setBundledPresetLoader, setFavorite, setPresetBackend,
} from '../services/PresetStore';
import { changedFields, fieldSigsOf, mixFieldsOf } from '../utils/collabMerge';
import { createBus } from '../utils/trackStructure';

const ROOT = path.resolve(__dirname, '..');
const bundledText = (f: string) => fs.readFileSync(path.join(ROOT, 'templates/presets', f), 'utf-8');

const comp = (id: string, over: Record<string, any> = {}, extra: Partial<PluginInstance> = {}): PluginInstance => ({
  id, name: 'Compresseur', type: 'COMPRESSOR', isEnabled: true, latency: 0,
  params: { threshold: -18, ratio: 4, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1.6, mode: 'CLEAN', isEnabled: true, ...over },
  ...extra,
});
const proc3 = (id: string, state: string, extra: Record<string, any> = {}): PluginInstance => ({
  id, name: 'FabFilter Pro-C 3', type: 'VST3', isEnabled: true, latency: 0,
  params: { name: 'FabFilter Pro-C 3', vendor: 'FabFilter', localPath: 'C:\\Program Files\\Common Files\\VST3\\FabFilter\\FabFilter Pro-C 3.vst3', pluginName: null, stateB64: state, ...extra },
});

beforeEach(() => {
  setPresetBackend(memoryPresetBackend());
  localStorage.clear();
  setBundledPresetLoader(async () => [
    { ...parsePresetFile(bundledText('voix-lead-make-music.novachain')), bundled: true },
    { ...parsePresetFile(bundledText('back-double.novachain')), bundled: true },
  ]);
});
afterEach(() => { setPresetBackend(null); setBundledPresetLoader(null); });

describe('Preset d’effet NOVA : aller-retour identique', () => {
  it('enregistrer → fichier → importer → charger redonne exactement le même son', () => {
    const tuned = comp('a', { threshold: -24, ratio: 2, attack: 0.01, mode: 'OPTO', bpm: 140 });
    const preset = makePluginPreset(tuned, 'Voix rap · 2:1');
    expect(preset.params.bpm).toBeUndefined(); // tempo de la session : pas dans le preset
    const reread = parsePresetFile(serializePreset(preset));
    expect(reread).toEqual(preset);
    const other = comp('b', { bpm: 92 }, { isEnabled: false });
    const { plugin, patch } = applyPluginPreset(other, reread as any);
    expect(sameSettings(soundSettingsOf(plugin), soundSettingsOf(tuned))).toBe(true);
    expect(plugin.id).toBe('b');
    expect(plugin.isEnabled).toBe(false); // bypass gardé
    expect(plugin.params.bpm).toBe(92); // tempo de CETTE session gardé
    expect(patch.ratio).toBe(2);
    expect(matchesPreset(plugin, preset)).toBe(true);
  });

  it('un preset ne se charge que sur le même effet', () => {
    const p = makePluginPreset(comp('a'), 'X');
    const eq: PluginInstance = { id: 'e', name: 'EQ', type: 'PROEQ12', isEnabled: true, latency: 0, params: {} };
    expect(presetMatches(p, eq)).toBe(false);
    expect(() => applyPluginPreset(eq, p)).toThrow(/fait pour/);
  });
});

describe('Preset VST : état du pont + relecture', () => {
  it('garde l’état binaire, le recharge à l’identique, retire les anciens réglages texte', () => {
    const saved = makePluginPreset(proc3('v', 'U1RBVEUtQQ=='), 'Lead 2:1', { readback: [{ name: 'Ratio', text: '2.00:1' }, { name: 'Threshold', text: '-18.0 dB' }] });
    expect(saved.vst?.name).toBe('FabFilter Pro-C 3');
    expect(saved.params).toEqual({ stateB64: 'U1RBVEUtQQ==' });
    const target = proc3('w', 'QVVUUkU=', { novaSettings: [{ name: 'ratio', text: '4.00:1' }] });
    const { plugin, patch } = applyPluginPreset(target, parsePresetFile(serializePreset(saved)) as any);
    expect(plugin.params.stateB64).toBe('U1RBVEUtQQ==');
    expect(plugin.params.novaSettings).toBeUndefined();
    expect(plugin.params.localPath).toBe(target.params.localPath);
    expect(patch).toEqual({ stateB64: 'U1RBVEUtQQ==' });
    // Relecture : identique → aucun écart ; un paramètre qui diffère est signalé.
    expect(compareReadback(saved.readback, [{ name: 'Threshold', text: '-18.0 dB' }, { name: 'Ratio', text: '2.00:1' }]).diffs).toEqual([]);
    expect(compareReadback(saved.readback, [{ name: 'Ratio', text: '4.00:1' }, { name: 'Threshold', text: '-18.0 dB' }]).diffs).toEqual([{ name: 'Ratio', want: '2.00:1', got: '4.00:1' }]);
  });

  it('Pro-C 3 et Pro-Q 4 ne partagent pas leurs presets', () => {
    const q4: PluginInstance = { ...proc3('q', 'x'), params: { ...proc3('q', 'x').params, name: 'FabFilter Pro-Q 4', localPath: 'C:\\VST3\\FabFilter Pro-Q 4.vst3' } };
    expect(presetTargetKey(proc3('a', 'x'))).not.toBe(presetTargetKey(q4));
    expect(presetMatches(makePluginPreset(proc3('a', 'x'), 'P'), q4)).toBe(false);
  });
});

describe('Comparer (Pro Tools « Compare »)', () => {
  it('écoute le preset, puis retrouve les modifications ; une retouche pendant la comparaison repart de là', () => {
    const loaded = soundSettingsOf(comp('a', { ratio: 2 }));
    let cs = compareInit(loaded, 'Voix 2:1');
    const edited = soundSettingsOf(comp('a', { ratio: 3, threshold: -30 }));
    expect(compareModified(cs, loaded)).toBe(false);
    expect(compareToggle(cs, loaded)).toBeNull(); // rien à comparer
    expect(compareModified(cs, edited)).toBe(true);
    const a = compareToggle(cs, edited)!;
    expect(a.apply).toEqual(loaded); // on entend le preset
    cs = a.next;
    expect(comparing(cs)).toBe(true);
    const b = compareToggle(cs, a.apply)!;
    expect(b.apply).toEqual(edited); // et on retrouve ses modifications, à l'identique
    expect(comparing(b.next)).toBe(false);
    // Retouche pendant qu'on écoute le preset : les modifications mises de côté sont oubliées.
    const c = compareToggle(b.next, edited)!;
    expect(comparing(compareOnEdit(c.next))).toBe(false);
  });

  it('un VST se compare par son état complet', () => {
    const p = proc3('v', 'QQ==');
    const cs = compareInit(soundSettingsOf(p), 'A');
    const next = withSoundSettings(p, { stateB64: 'Qg==' }).plugin;
    const t = compareToggle(cs, soundSettingsOf(next))!;
    expect(withSoundSettings(next, t.apply).plugin.params.stateB64).toBe('QQ==');
  });
});

describe('Rangement des presets', () => {
  it('enregistrer, lister par effet, favori en tête, renommer, supprimer', async () => {
    const a = await savePreset(makePluginPreset(comp('x', { ratio: 2 }), 'Zèbre'));
    const b = await savePreset(makePluginPreset(comp('x', { ratio: 6 }), 'Alpha'));
    await savePreset(makePluginPreset(proc3('v', 'QQ=='), 'Pro-C'));
    let list = await listPluginPresets(comp('y'));
    expect(list.map(p => p.name)).toEqual(['Alpha', 'Zèbre']);
    setFavorite(a.id, true);
    list = await listPluginPresets(comp('y'));
    expect(list.map(p => p.name)).toEqual(['Zèbre', 'Alpha']);
    expect(isFavorite(a.id)).toBe(true);
    await renamePreset(b.id, '  Bêta  ');
    expect((await getPreset(b.id))!.name).toBe('Bêta');
    await deletePreset(a.id);
    expect(isFavorite(a.id)).toBe(false);
    expect((await listPluginPresets(comp('y'))).map(p => p.name)).toEqual(['Bêta']);
  });

  it('les presets livrés sont en lecture seule ; import = copie si l’id est pris ; export nommé', async () => {
    const chains = await listTrackPresets();
    const lead = chains.find(c => c.name === 'Voix lead Make Music')!;
    await expect(renamePreset(lead.id, 'X')).rejects.toThrow(/livrés/);
    await expect(deletePreset(lead.id)).rejects.toThrow(/livrés/);
    const copy = await savePreset({ ...lead, name: 'Ma voix' });
    expect(copy.id).not.toBe(lead.id);
    const f = exportPresetFile(copy);
    expect(f.filename).toBe('ma-voix.novachain');
    const imported = await importPresetText(await f.blob.text());
    expect(imported.id).not.toBe(copy.id);
    expect(imported.name).toBe('Ma voix');
    expect(() => parsePresetFile('{"format":"autre"}')).toThrow(/pas un preset NOVA/);
    expect(() => parsePresetFile('pas du json')).toThrow(/JSON abîmé/);
  });
});

describe('Track Presets livrés (règles de Romain)', () => {
  it('Voix lead Make Music : low cut 80 Hz, opto puis FET en 2:1, de-esser 8 kHz, envois reverb + délai', () => {
    const p = parsePresetFile(bundledText('voix-lead-make-music.novachain')) as TrackPreset;
    expect(p.plugins.map(x => x.type)).toEqual(['PROEQ12', 'COMPRESSOR', 'COMPRESSOR', 'DEESSER']);
    const hp = p.plugins[0].params.bands[0];
    expect([hp.type, hp.frequency, hp.isEnabled]).toEqual(['highpass', 80, true]);
    expect(p.plugins[0].params.bands[11].isEnabled).toBe(false);
    expect(p.plugins[1].params).toMatchObject({ mode: 'OPTO', ratio: 2 });
    expect(p.plugins[2].params).toMatchObject({ mode: 'FET', ratio: 2 });
    expect(p.plugins[2].params.attack).toBeLessThan(p.plugins[1].params.attack); // FET plus rapide
    expect(p.plugins[3].params.frequency).toBe(8000);
    const to = p.sends.filter(s => s.level > 0).map(s => s.to.name);
    expect(to).toEqual(expect.arrayContaining(['Reverb courte', 'Écho 1/4']));
    expect(p.returns!.find(r => r.id === 'send-verb-short')!.plugins[0].type).toBe('REVERB');
    expect(p.returns!.find(r => r.id === 'send-delay')!.plugins[0].type).toBe('DELAY');
    expect(trackPresetSummary(p)).toMatch(/4 effets · 3 envois .* sortie BUS VOX/);
  });

  it('Back / double : low cut 200 Hz, high cut 15 kHz', () => {
    const p = parsePresetFile(bundledText('back-double.novachain')) as TrackPreset;
    const b = p.plugins[0].params.bands;
    expect([b[0].type, b[0].frequency]).toEqual(['highpass', 200]);
    expect([b[11].type, b[11].frequency, b[11].isEnabled]).toEqual(['lowpass', 15000, true]);
  });
});

const session = (): Track[] => [
  makeTrack({ id: 'lead', name: 'Lead', outputTrackId: 'bus-vox' }),
  makeTrack({ id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, sends: [] }),
  makeTrack({ id: 'send-verb-short', name: 'Reverb courte', type: TrackType.SEND, sends: [], plugins: [{ id: 'rv', name: 'Rv', type: 'REVERB', isEnabled: true, latency: 0, params: { decay: 1.2 } }] }),
  makeTrack({ id: 'send-delay', name: 'Écho 1/4', type: TrackType.SEND, sends: [], plugins: [{ id: 'dl', name: 'Dl', type: 'DELAY', isEnabled: true, latency: 0, params: { division: '1/4' } }] }),
  makeTrack({ id: 'master', name: 'MASTER BUS', type: TrackType.BUS, outputTrackId: '', sends: [] }),
];

describe('Track Preset : enregistrer et rappeler', () => {
  it('toute la chaîne (ordre, actif / bypass / inactif, envois, volume, pan, sortie) revient à l’identique', () => {
    let tracks = session();
    const bus = createBus(tracks, 'LEAD A');
    tracks = bus.tracks.map(t => (t.id === 'lead' ? {
      ...t, volume: 0.71, pan: -0.2, outputBusId: bus.bus.id,
      plugins: [comp('c1', { ratio: 2, mode: 'OPTO' }), comp('c2', { ratio: 2, mode: 'FET' }, { isEnabled: false }), comp('c3', {}, { isInactive: true }), proc3('v', 'QQ==')],
      sends: [{ id: 'send-verb-short', level: 0.2, isEnabled: true, preFader: true, pan: -0.5, slot: 3 }, { id: 'send-delay', level: 0.13, isEnabled: true, isMuted: true }],
    } : t));
    // L'aux qui écoute LEAD A
    tracks = tracks.map(t => (t.id === 'bus-vox' ? { ...t, inputBusId: bus.bus.id } : t));
    const lead = tracks.find(t => t.id === 'lead')!;
    const preset = parsePresetFile(serializePreset(makeTrackPreset(lead, tracks, 'Voix lead · Romain'))) as TrackPreset;

    // Autre session : mêmes retours et même bus, piste vierge.
    let other = session();
    const b2 = createBus(other, 'LEAD A');
    other = b2.tracks.map(t => (t.id === 'bus-vox' ? { ...t, inputBusId: b2.bus.id } : t));
    other = [...other.slice(0, 1), makeTrack({ id: 'nouvelle', name: 'Nouvelle', plugins: [comp('old')] }), ...other.slice(1)];
    const r = applyTrackPreset(other, 'nouvelle', preset);
    const got = r.tracks.find(t => t.id === 'nouvelle')!;
    const strip = (ps: PluginInstance[]) => ps.map(p => ({ type: p.type, name: p.name, isEnabled: p.isEnabled, isInactive: !!p.isInactive, s: soundSettingsOf(p) }));
    expect(strip(got.plugins)).toEqual(strip(lead.plugins));
    expect(new Set(got.plugins.map(p => p.id)).has('c1')).toBe(false); // nouveaux identifiants
    expect(got.sends).toEqual(lead.sends);
    expect([got.volume, got.pan]).toEqual([0.71, -0.2]);
    expect(got.outputBusId).toBe(b2.bus.id);
    expect(got.outputTrackId).toBe('bus-vox');
    expect(r.report.messages).toEqual([]);
  });

  it('retours absents : créés depuis le preset ; sortie absente : master, avec un message', () => {
    const preset = parsePresetFile(bundledText('voix-lead-make-music.novachain')) as TrackPreset;
    const bare = [makeTrack({ id: 'v', name: 'Voix', sends: [] }), makeTrack({ id: 'master', name: 'MASTER BUS', type: TrackType.BUS, outputTrackId: '', sends: [] })];
    const r = applyTrackPreset(bare, 'v', preset);
    expect(r.report.created).toEqual(['Écho 1/4', 'Reverb courte', 'Reverb longue']);
    expect(r.tracks.map(t => t.id)).toEqual(['v', 'send-delay', 'send-verb-short', 'send-verb-long', 'master']);
    const v = r.tracks.find(t => t.id === 'v')!;
    expect(v.sends.map(s => [s.id, s.level])).toEqual([['send-delay', 0.13], ['send-verb-short', 0.2], ['send-verb-long', 0.08]]);
    expect(v.outputTrackId).toBe('master');
    expect(r.report.messages.join(' ')).toMatch(/BUS VOX.*master/);
  });

  it('rappel partiel : seulement les effets', () => {
    const preset = parsePresetFile(bundledText('back-double.novachain')) as TrackPreset;
    const t = session();
    const before = t.find(x => x.id === 'lead')!;
    const r = applyTrackPreset(t, 'lead', preset, { inserts: true, sends: false, volumePan: false, output: false });
    const got = r.tracks.find(x => x.id === 'lead')!;
    expect(got.plugins.map(p => p.type)).toEqual(['PROEQ12']);
    expect(got.sends).toEqual(before.sends);
    expect(got.volume).toBe(before.volume);
    expect(got.outputTrackId).toBe(before.outputTrackId);
  });

  it('à la création d’une piste : la piste naît avec sa chaîne, juste après la piste choisie', () => {
    const preset = parsePresetFile(bundledText('voix-lead-make-music.novachain')) as TrackPreset;
    const r = createTrackFromPreset(session(), preset, { id: 'neuve', name: 'Lead refrain', afterId: 'lead' });
    expect(r.tracks.map(t => t.id).slice(0, 2)).toEqual(['lead', 'neuve']);
    const t = r.tracks.find(x => x.id === 'neuve')!;
    expect(t.name).toBe('Lead refrain');
    expect(t.plugins.map(p => p.type)).toEqual(['PROEQ12', 'COMPRESSOR', 'COMPRESSOR', 'DEESSER']);
    expect(t.outputTrackId).toBe('bus-vox');
    expect(r.report.created).toEqual(['Reverb longue']); // les 2 autres retours existaient
  });

  it('VST absent du PC : remplacé par l’effet NOVA proche ; pont absent : en attente', () => {
    const preset = makeTrackPreset(makeTrack({ id: 'l', plugins: [proc3('v', 'QQ==')] }), session(), 'P');
    const none = resolvePresetPlugins(preset, []);
    expect(none.plugins[0].type).toBe('COMPRESSOR');
    expect(none.report.replaced.length).toBe(1);
    const waiting = resolvePresetPlugins(preset, null);
    expect(waiting.plugins[0].type).toBe('VST3');
    expect(waiting.report.waitingBridge).toBe(1);
  });
});

describe('Collaboration : appliquer un preset = une seule opération', () => {
  it('preset d’effet : un seul champ de mix change (l’effet)', () => {
    const t = makeTrack({ id: 'l', plugins: [comp('c1'), comp('c2')] });
    const known = fieldSigsOf(mixFieldsOf(t));
    const p = makePluginPreset(comp('z', { ratio: 2 }), 'P');
    const next: Track = { ...t, plugins: t.plugins.map(x => (x.id === 'c2' ? applyPluginPreset(x, p).plugin : x)) };
    expect(Object.keys(changedFields(known, mixFieldsOf(next)))).toEqual(['plugin:c2']);
  });

  it('Track Preset : tout part dans le mix d’une seule piste (et les retours créés comme pistes)', () => {
    const preset = parsePresetFile(bundledText('voix-lead-make-music.novachain')) as TrackPreset;
    const tracks = session();
    const r = applyTrackPreset(tracks, 'lead', preset);
    const changedTracks = r.tracks.filter(t => { const before = tracks.find(x => x.id === t.id); return !before || before !== t; }).map(t => t.id);
    expect(changedTracks).toEqual(['lead', 'send-verb-long']);
  });
});
