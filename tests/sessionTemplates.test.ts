// @vitest-environment jsdom
/**
 * Modèles de session : aller-retour, restriction « privé : romain », plugin absent,
 * fiche → modèle (règles de mix du studio), variantes de noms de plugins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DAWState, PluginInstance, TrackType } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import {
  canAccessTemplate, createTemplateFromState, instantiateTemplate, parseTemplate, serializeTemplate, SessionTemplate, visibleTemplates,
} from '../utils/sessionTemplate';
import {
  deleteTemplate, duplicateTemplate, getTemplate, importTemplateText, listTemplates, memoryBackend, renameTemplate, saveTemplate,
  setBundledLoader, setTemplateBackend,
} from '../services/TemplateStore';
import { resolveAccountEmail, setAccountClients, verifiedEmail } from '../services/templateAccount';
import { buildTemplateFromSpec, checkMixRules, matchParamName, settingForParam, TemplateSpec } from '../utils/templateSpec';
import { baseName, channelsOf, resolveVst, VstCandidate } from '../utils/vstMatch';

const ROMAIN = 'romain.scheyvaerts@gmail.com';
const ROOT = path.resolve(__dirname, '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/specs/romain-voix-lead.spec.json'), 'utf-8')) as TemplateSpec;
const KB = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vst-knowledge/plugins.json'), 'utf-8')).plugins;
const BUNDLED_TEXT = fs.readFileSync(path.join(ROOT, 'templates/romain-voix-lead.novatemplate'), 'utf-8');

const vst = (id: string, name: string, vendor: string, p: string, extra: Record<string, any> = {}, enabled = true): PluginInstance => ({
  id, name, type: 'VST3', isEnabled: enabled, latency: 0,
  params: { name, vendor, localPath: p, pluginName: null, novaQuiet: true, stateB64: 'QUJD', novaSettings: [{ name: 'ratio', text: '2.00:1' }], ...extra },
});

const PROC3 = 'C:\\Program Files\\Common Files\\VST3\\FabFilter\\FabFilter Pro-C 3.vst3';

/** Session réaliste : voix → bus voix → master, envois, une prise audio et un clip MIDI. */
function session(): DAWState {
  const voice = makeTrack({
    id: 'voix', name: 'VOIX LEAD', outputTrackId: 'bus-vox', volume: 0.9, pan: -0.1,
    sends: [{ id: 'send-verb-short', level: 0.2, isEnabled: true }, { id: 'send-delay', level: 0.1, isEnabled: false, preFader: true }],
    clips: [makeClip({ id: 'prise-1', bufferId: 'buf-1', audioRef: 'blob:http://x/1' })],
    plugins: [
      vst('pl-c3', 'Pro-C 3', 'FabFilter', PROC3),
      { id: 'pl-eq', name: 'PROEQ12', type: 'PROEQ12', isEnabled: false, latency: 0, params: { masterGain: 1, bands: [{ id: 0, frequency: 90 }] } },
    ],
    isTrackArmed: true,
    frozenClip: makeClip({ id: 'gel' }),
    isFrozen: true,
  });
  const keys = makeTrack({ id: 'keys', name: 'KEYS', type: TrackType.MIDI, clips: [makeClip({ id: 'midi-1', type: TrackType.MIDI, notes: [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 100 }] })] });
  const bus = makeTrack({ id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, sends: [], plugins: [{ id: 'pl-comp', name: 'COMPRESSOR', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { ratio: 2, threshold: -20, mode: 'OPTO' } }] });
  const verb = makeTrack({ id: 'send-verb-short', name: 'Reverb courte', type: TrackType.SEND, sends: [], plugins: [{ id: 'pl-rv', name: 'REVERB', type: 'REVERB', isEnabled: true, latency: 0, params: { decay: 1.2, mix: 1 } }] });
  const master = makeTrack({ id: 'master', name: 'MASTER BUS', type: TrackType.BUS, outputTrackId: '', sends: [] });
  return makeState([voice, keys, bus, verb, master], { bpm: 140, projectKey: 6, projectScale: 'MINOR', markers: [{ id: 'm1', name: 'Refrain', time: 10, type: 'MARKER', color: '#fff' }] });
}

const tplOf = (s: DAWState, extra: Partial<Parameters<typeof createTemplateFromState>[1]> = {}) =>
  createTemplateFromState(s, { name: 'Mon modèle', id: 'tpl-test', now: 1000, ...extra });

beforeEach(() => {
  setTemplateBackend(memoryBackend());
  setBundledLoader(async () => [{ ...parseTemplate(BUNDLED_TEXT), bundled: true }]);
});
afterEach(() => { setTemplateBackend(null); setBundledLoader(null); });

// ─── Sérialisation et chargement ────────────────────────────────────────────────

describe('modèle de session : enregistrement', () => {
  it('garde pistes, routage, envois (pré/post), effets et réglages, sans audio ni gel', () => {
    const tpl = tplOf(session());
    const voice = tpl.session.tracks.find(t => t.id === 'voix')!;
    expect(voice.outputTrackId).toBe('bus-vox');
    expect(voice.volume).toBe(0.9);
    expect(voice.pan).toBe(-0.1);
    expect(voice.sends).toEqual([{ id: 'send-verb-short', level: 0.2, isEnabled: true }, { id: 'send-delay', level: 0.1, isEnabled: false, preFader: true }]);
    expect(voice.plugins.map(p => [p.name, p.isEnabled])).toEqual([['Pro-C 3', true], ['PROEQ12', false]]);
    expect(voice.plugins[0].params).toMatchObject({ localPath: PROC3, stateB64: 'QUJD', novaSettings: [{ name: 'ratio', text: '2.00:1' }] });
    expect(voice.clips).toBeUndefined();
    expect((voice as any).frozenClip).toBeUndefined();
    expect((voice as any).isTrackArmed).toBeUndefined();
    expect(JSON.stringify(tpl)).not.toMatch(/blob:|buf-1/);
    expect(tpl.session).toMatchObject({ bpm: 140, projectKey: 6, projectScale: 'MINOR' });
    expect(tpl.session.markers).toBeUndefined();
  });

  it('aller-retour fichier .novatemplate identique', () => {
    const tpl = tplOf(session(), { privateTo: 'romain' });
    const back = parseTemplate(serializeTemplate(tpl));
    expect(back).toEqual(tpl);
  });

  it('aller-retour session → modèle → session → modèle identique', () => {
    const tpl = tplOf(session());
    const { state } = instantiateTemplate(tpl, { plugins: null });
    const again = createTemplateFromState(state, { name: 'Mon modèle', id: 'tpl-test', now: 1000, source: tpl.source });
    // Les pistes recréées reçoivent une courbe de volume vide : sans objet dans le modèle.
    expect(again.session).toEqual(tpl.session);
    expect(state.tracks.find(t => t.id === 'voix')!.isTrackArmed).toBe(false);
    expect(state.tracks.find(t => t.id === 'voix')!.automationLanes[0].parameterName).toBe('volume');
  });

  it('« garder les clips » : MIDI et repères gardés, prise audio locale jamais', () => {
    const tpl = tplOf(session(), { keepClips: true });
    expect(tpl.session.tracks.find(t => t.id === 'keys')!.clips!.map(c => c.id)).toEqual(['midi-1']);
    expect(tpl.session.tracks.find(t => t.id === 'voix')!.clips).toEqual([]);
    expect(tpl.session.markers!.map(m => m.name)).toEqual(['Refrain']);
  });

  it('refuse un fichier qui n’est pas un modèle, en français', () => {
    expect(() => parseTemplate('{"format":"autre"}')).toThrow(/pas un modèle NOVA/);
    expect(() => parseTemplate('pas du json')).toThrow(/JSON/);
  });
});

// ─── Restriction d'accès ───────────────────────────────────────────────────────

describe('modèles « privé : romain »', () => {
  it('visible seulement avec le bon e-mail (casse ignorée), jamais pour un invité', () => {
    const priv = { privateTo: 'romain' };
    expect(canAccessTemplate(priv, ROMAIN)).toBe(true);
    expect(canAccessTemplate(priv, 'Romain.Scheyvaerts@Gmail.com ')).toBe(true);
    expect(canAccessTemplate(priv, 'autre@exemple.com')).toBe(false);
    expect(canAccessTemplate(priv, 'guest@novastudio.app')).toBe(false);
    expect(canAccessTemplate(priv, null)).toBe(false);
    expect(canAccessTemplate({ privateTo: 'groupe-inconnu' }, ROMAIN)).toBe(false);
    expect(canAccessTemplate({}, null)).toBe(true);
    expect(visibleTemplates([priv, {}], null)).toHaveLength(1);
  });

  it('le modèle livré apparaît pour romain, pas pour un autre compte ni un invité', async () => {
    await saveTemplate(tplOf(session()));
    const ids = async (e: string | null) => (await listTemplates(e)).map(t => t.id);
    expect(await ids(ROMAIN)).toEqual(['tpl-romain-voix-lead', 'tpl-test']);
    expect(await ids('autre@exemple.com')).toEqual(['tpl-test']);
    expect(await ids(null)).toEqual(['tpl-test']);
    await expect(getTemplate('tpl-romain-voix-lead', null)).rejects.toThrow(/privé : romain/);
    await expect(getTemplate('tpl-romain-voix-lead', ROMAIN)).resolves.toMatchObject({ bundled: true });
  });

  it('import refusé pour un autre compte, accepté pour romain', async () => {
    await expect(importTemplateText(BUNDLED_TEXT, 'autre@exemple.com')).rejects.toThrow(/connecte-toi avec le bon compte/);
    const t = await importTemplateText(BUNDLED_TEXT, ROMAIN);
    expect(t.id).not.toBe('tpl-romain-voix-lead'); // l'id du modèle livré est déjà pris
    expect(t.source?.kind).toBe('import');
  });

  it('renommer, dupliquer, supprimer ; le modèle livré reste en lecture seule', async () => {
    const saved = await saveTemplate(tplOf(session()));
    await renameTemplate(saved.id, 'Voix rap', null);
    const dup = await duplicateTemplate(saved.id, null);
    expect(dup.name).toBe('Voix rap (copie)');
    await deleteTemplate(saved.id, null);
    expect((await listTemplates(null)).map(t => t.name)).toEqual(['Voix rap (copie)']);
    await expect(deleteTemplate('tpl-romain-voix-lead', ROMAIN)).rejects.toThrow(/ne se suppriment pas/);
    const copy = await duplicateTemplate('tpl-romain-voix-lead', ROMAIN);
    expect(copy.privateTo).toBe('romain');
    expect((await listTemplates(null)).some(t => t.id === copy.id)).toBe(false);
  });

  it('compte connecté : e-mail vérifié par le serveur, invité = null, hors ligne = session gardée', async () => {
    const client = (email: string | null, server: 'ok' | 'refuse' | 'network') => ({
      auth: {
        getSession: async () => ({ data: { session: email ? { user: { email } } : null } }),
        getUser: async () => server === 'ok' ? { data: { user: { email } } } : server === 'refuse' ? { data: { user: null }, error: { message: 'invalid JWT', status: 401 } } : { data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' } },
      },
    });
    expect(await verifiedEmail(client(ROMAIN, 'ok'))).toBe(ROMAIN);
    expect(await verifiedEmail(client(ROMAIN, 'refuse'))).toBeNull();
    expect(await verifiedEmail(client(ROMAIN, 'network'))).toBe(ROMAIN);
    expect(await verifiedEmail(client(null, 'ok'))).toBeNull();
    setAccountClients(async () => [client(null, 'ok'), client('Romain.Scheyvaerts@gmail.com', 'ok')]);
    expect(await resolveAccountEmail()).toBe(ROMAIN);
    setAccountClients(async () => [client(null, 'ok'), null]);
    expect(await resolveAccountEmail()).toBeNull();
  });
});

// ─── Plugin absent ─────────────────────────────────────────────────────────────

describe('nouveau projet depuis un modèle : plugins absents', () => {
  const onPc: VstCandidate[] = [{ name: 'Pro-Q 4', vendor: 'FabFilter', path: 'C:\\VST3\\FabFilter Pro-Q 4.vst3' }];

  it('Pro-C 3 manquant : remplacé par le compresseur NOVA (2:1), sans planter', () => {
    const { state, report } = instantiateTemplate(tplOf(session()), { plugins: onPc, missingVst: 'replace' });
    const p = state.tracks.find(t => t.id === 'voix')!.plugins[0];
    expect(p.type).toBe('COMPRESSOR');
    expect(p.params.ratio).toBe(2);
    expect(p.params.templateReplaced).toMatchObject({ name: 'Pro-C 3', vendor: 'FabFilter' });
    expect(report.messages).toContain('Pro-C 3 manquant sur VOIX LEAD : remplacé par le compresseur NOVA.');
  });

  it('ou laissé inactif, au choix', () => {
    const { state, report } = instantiateTemplate(tplOf(session()), { plugins: onPc, missingVst: 'disable' });
    const p = state.tracks.find(t => t.id === 'voix')!.plugins[0];
    expect(p).toMatchObject({ type: 'VST3', isEnabled: false });
    expect(p.params.templateMissing).toBe(true);
    expect(report.messages[0]).toBe('Pro-C 3 manquant sur VOIX LEAD : laissé inactif.');
  });

  it('plugin installé ailleurs (autre dossier) : retrouvé par son nom', () => {
    const { state, report } = instantiateTemplate(tplOf(session()), { plugins: [{ name: 'FabFilter Pro-C 3', vendor: 'FabFilter', path: 'D:\\Plugins\\FabFilter Pro-C 3.vst3' }] });
    expect(state.tracks.find(t => t.id === 'voix')!.plugins[0].params.localPath).toBe('D:\\Plugins\\FabFilter Pro-C 3.vst3');
    expect(report.relinked).toHaveLength(1);
  });

  it('pont absent : rien n’est remplacé, les VST attendent le pont', () => {
    const { report } = instantiateTemplate(tplOf(session()), { plugins: null });
    expect(report.waitingBridge).toBe(1);
    expect(report.replaced).toHaveLength(0);
  });

  it('« activer tous les effets » active aussi ceux désactivés dans le modèle', () => {
    const { state, report } = instantiateTemplate(tplOf(session()), { plugins: null, enableAll: true });
    expect(state.tracks.find(t => t.id === 'voix')!.plugins.every(p => p.isEnabled)).toBe(true);
    expect(report.enabled).toBe(1);
  });
});

// ─── Variantes de noms ─────────────────────────────────────────────────────────

describe('plugins : noms et variantes', () => {
  const list: VstCandidate[] = [
    { name: 'CLA-76 Mono', vendor: 'Waves', path: 'C:\\VST3\\WaveShell1-VST3 17.1_x64.vst3', pluginName: 'CLA-76 Mono' },
    { name: 'CLA-76 Stereo', vendor: 'Waves', path: 'C:\\VST3\\WaveShell1-VST3 17.1_x64.vst3', pluginName: 'CLA-76 Stereo' },
    { name: 'FabFilter Pro-C 3', vendor: 'FabFilter', path: 'C:\\VST3\\FabFilter Pro-C 3.vst3' },
    { name: 'Pro-Q 4', vendor: 'FabFilter', path: 'C:\\VST3\\Pro-Q 4.vst3' },
    { name: 'Virtual Mix Rack', vendor: 'Slate Digital', path: 'C:\\VST3\\Slate Digital\\Virtual Mix Rack.vst3' },
    { name: 'VerbSuite Classics', vendor: 'Slate Digital', path: 'C:\\VST3\\Slate Digital\\VerbSuite Classics.vst3' },
    { name: 'SSL Native Channel Strip 2', vendor: 'Solid State Logic', path: 'C:\\VST3\\SSL Native Channel Strip 2.vst3' },
  ];
  it('variantes mono / stéréo et « (s) » de Pro Tools', () => {
    expect(channelsOf('CLA-76 (s)')).toBe('stereo');
    expect(baseName('CLA-76 Mono/Stereo')).toBe('cla-76');
    expect(resolveVst('CLA-76 (s)', 'Waves', list)!.plugin.name).toBe('CLA-76 Stereo');
    expect(resolveVst('CLA-76 (m)', 'Waves', list)!.plugin.name).toBe('CLA-76 Mono');
    // Sans précision : stéréo (NOVA traite tout en stéréo).
    expect(resolveVst('CLA-76', 'Waves', list)).toMatchObject({ kind: 'variant', plugin: { name: 'CLA-76 Stereo' } });
  });
  it('éditeur dans le nom, tirets, autre version (signalée)', () => {
    expect(resolveVst('Pro-C3', 'FabFilter', list)).toMatchObject({ kind: 'exact', plugin: { name: 'FabFilter Pro-C 3' } });
    expect(resolveVst('FabFilter Pro-Q 4', '', list)!.kind).toBe('exact');
    expect(resolveVst('Pro-Q 3', 'FabFilter', list)).toMatchObject({ kind: 'other-version', plugin: { name: 'Pro-Q 4' } });
    expect(resolveVst('Pro-Q 3', 'FabFilter', list, { allowOtherVersion: false })).toBeNull();
  });
  it('Slate exclu sauf VerbSuite Classics / MetaTune ; SSL exclu', () => {
    expect(resolveVst('Virtual Mix Rack', 'Slate Digital', list)).toBeNull();
    expect(resolveVst('VerbSuite Classics', 'Slate Digital', list)!.plugin.name).toBe('VerbSuite Classics');
    expect(resolveVst('SSL Native Channel Strip 2', 'Solid State Logic', list)).toBeNull();
  });
});

// ─── Fiche → modèle ────────────────────────────────────────────────────────────

describe('fiche (Pro Tools relevé) → modèle NOVA', () => {
  it('construit pistes, routage, envois, plugins résolus et réglages en valeurs texte', () => {
    const { template, report } = buildTemplateFromSpec(SPEC, { knowledge: KB, id: 'tpl-x', now: 1 });
    const ids = template.session.tracks.map(t => t.id);
    expect(ids).toEqual(['instrumental', 'voix-lead', 'bus-vox', 'send-verb-short', 'send-verb-long', 'send-delay', 'master']);
    const lead = template.session.tracks[1];
    expect(lead.outputTrackId).toBe('bus-vox');
    expect(lead.sends.map(s => s.id)).toEqual(['send-verb-short', 'send-verb-long', 'send-delay']);
    expect(lead.sends[0].level).toBeCloseTo(Math.pow(10, -14 / 20), 5);
    expect(lead.plugins.map(p => p.params.templateSpec.plugin)).toEqual(['Auto-Tune Pro', 'Pro-Q 4', 'Pro-C 3', 'Pro-DS']);
    const c3 = lead.plugins[2];
    expect(c3.params.localPath).toMatch(/Pro-C 3\.vst3$/);
    expect(c3.params.novaSettings).toContainEqual({ name: 'ratio', text: '2.00:1' });
    expect(c3.params.novaSettings).toContainEqual({ name: 'threshold', real: -18 });
    expect(lead.plugins[3].params.novaSettings).toContainEqual({ name: 'high_pass_frequency', real: 6000 });
    expect(template.session.tracks[3].type).toBe(TrackType.SEND);
    expect(template.session.tracks[2].type).toBe(TrackType.BUS);
    const master = template.session.tracks[6];
    // « désactivé » dans Pro Tools = INACTIF (retiré du graphe), pas bypass (utils/trackStructure).
    expect(master.plugins.map(p => [p.params.templateSpec.plugin, p.isInactive ? 'inactive' : p.isEnabled ? 'active' : 'bypass'])).toEqual([['Pro-Q 4', 'active'], ['Pro-L 2', 'inactive']]);
    expect(template.privateTo).toBe('romain');
    expect(template.session).toMatchObject({ bpm: 140, projectKey: 6, projectScale: 'MINOR' });
    expect(report.mixRules).toEqual([]);
    expect(report.inserts.filter(i => !i.match)).toHaveLength(0);
  });

  it('« activer tous les effets » : Pro-L 2 (désactivé dans la session) devient actif', () => {
    const { template } = buildTemplateFromSpec(SPEC, { knowledge: KB, activateAll: true });
    expect(template.session.tracks.flatMap(t => t.plugins).every(p => p.isEnabled)).toBe(true);
  });

  it('plugin absent de la liste : gardé dans le modèle, signalé', () => {
    const spec: TemplateSpec = { format: 'nova-template-spec', version: 1, name: 'x', tracks: [{ name: 'Voix', kind: 'audio', inserts: [{ plugin: 'Plugin Inconnu 9', vendor: 'Personne' }] }, { name: 'Master', kind: 'master' }] };
    const { template, report } = buildTemplateFromSpec(spec, { plugins: [] });
    expect(template.session.tracks[0].plugins[0].params.templateMissing).toBe(true);
    expect(report.warnings[0]).toMatch(/absent de ce PC/);
  });

  it('règles de mix : ratio ≠ 2:1, un seul étage, SSL → signalés', () => {
    const spec: TemplateSpec = {
      format: 'nova-template-spec', version: 1, name: 'mauvais',
      tracks: [
        { name: 'Voix', kind: 'audio', inserts: [{ vendor: 'FabFilter', plugin: 'Pro-C 3', params: { Ratio: '4.00:1' } }, { vendor: 'Solid State Logic', plugin: 'SSL Native Vocalstrip 2' }] },
        { name: 'Master', kind: 'master' },
      ],
    };
    const { report } = buildTemplateFromSpec(spec, { knowledge: KB });
    expect(report.mixRules.join('\n')).toMatch(/exclu/);
    expect(report.mixRules.join('\n')).toMatch(/4:1 au lieu de 2:1/);
    expect(report.mixRules.join('\n')).toMatch(/un seul étage/);
  });

  it('réglages : clé réelle par nom affiché, unités converties', () => {
    const params = [{ name: 'retune_speed_ms', displayName: 'Retune Speed' }, { name: 'high_pass_frequency', display_name: 'High-Pass Frequency', text: '7000.0 Hz' }];
    expect(matchParamName('retune speed', params)).toBe('retune_speed_ms');
    expect(matchParamName('High-Pass Frequency', params)).toBe('high_pass_frequency');
    expect(settingForParam(params[1], 'high_pass_frequency', '6 kHz')).toEqual({ name: 'high_pass_frequency', real: 6000 });
    expect(settingForParam({ name: 'feedback', text: '0.00', range: [0, 1.25, 0.01] }, 'feedback', '35 %')).toEqual({ name: 'feedback', real: 0.35 });
    expect(settingForParam({ name: 'style', values: ['Clean', 'Vocal'] }, 'style', 'Vocal')).toEqual({ name: 'style', text: 'Vocal' });
  });

  it('le modèle livré (relu sur le pont) respecte les règles de mix et est privé', () => {
    const t: SessionTemplate = parseTemplate(BUNDLED_TEXT);
    expect(t.privateTo).toBe('romain');
    expect(checkMixRules(t)).toEqual([]);
    const lead = t.session.tracks.find(x => x.id === 'voix-lead')!;
    expect(lead.plugins.every(p => p.type === 'VST3' && typeof p.params.stateB64 === 'string')).toBe(true);
  });
});
