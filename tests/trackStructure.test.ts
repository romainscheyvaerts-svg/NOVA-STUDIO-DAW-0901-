// @vitest-environment jsdom
/**
 * Structure façon Pro Tools (utils/trackStructure) : bypass ≠ inactif (graphe
 * et PDC), pistes inactives hors du moteur et de l'export, dossiers (routage
 * mesuré), VCA (dB relatifs), envois a-j avec pan et mute, bus nommés,
 * liste des pistes, modèles (sauvegarde / fiche LENNON) et collaboration.
 */
import { describe, expect, it } from 'vitest';
import { PluginInstance, Track, TrackType } from '../types';
import { makeState, makeTrack } from './helpers/fixtures';
import { mixImpulse } from './helpers/structureMix';
import {
  busUsage, chainLatency, chainPlan, createBus, createFolder, createVca, dbToGain, deleteBus, engineView, filterTrackList,
  isEffectivelyInactive, isShownInEdit, moveIntoFolder, moveOutOfFolder, pluginClickAction, pluginState, readyToUseTracks,
  renameBus, sendSlots, setAllHidden, setSendSlot, setTrackInputBus, setTrackOutput, setTracksHidden, setTracksInactive,
  showAndActivate, structureSig, VOID_OUTPUT, withPluginInactive, withPluginState,
} from '../utils/trackStructure';
import { computePdc, PdcNode } from '../utils/pdc';
import { createTemplateFromState, instantiateTemplate, parseTemplate, serializeTemplate, templateInfo } from '../utils/sessionTemplate';
import { buildTemplateFromSpec, TemplateSpec } from '../utils/templateSpec';
import { applyMixFields, changedFields, fieldSigsOf, mixFieldsOf } from '../utils/collabMerge';

const fx = (id: string, extra: Partial<PluginInstance> = {}): PluginInstance => ({ id, name: id, type: 'COMPRESSOR', isEnabled: true, params: {}, latency: 0, ...extra });
const T = (id: string, extra: Partial<Track> = {}): Track => makeTrack({ id, name: id.toUpperCase(), volume: 1, pan: 0, sends: [], ...extra });
const BUS = (id: string, extra: Partial<Track> = {}) => T(id, { type: TrackType.BUS, ...extra });
const RET = (id: string, extra: Partial<Track> = {}) => T(id, { type: TrackType.SEND, ...extra });
const MASTER = () => T('master', { type: TrackType.BUS, outputTrackId: '' });
const close = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);

// ─── 1. Effets : bypass ≠ inactif ──────────────────────────────────────────────

describe('effets : bypass ≠ inactif (graphe et PDC)', () => {
  const plugins = [fx('a'), fx('b', { isEnabled: false }), fx('c', { isInactive: true }), fx('d', { isEnabled: false, isInactive: true })];
  const LAT: Record<string, number> = { a: 0.010, b: 0.020, c: 0.030, d: 0.040 };

  it('graphe : l’inactif n’y est pas, le bypass y reste (contourné)', () => {
    expect(chainPlan(plugins)).toEqual([{ id: 'a', mode: 'process' }, { id: 'b', mode: 'bypass' }]);
    expect(plugins.map(pluginState)).toEqual(['active', 'bypass', 'inactive', 'inactive']);
  });

  it('PDC : la latence d’un effet en bypass reste compensée, celle d’un inactif disparaît', () => {
    close(chainLatency(plugins, id => LAT[id]), 0.030);
    // Voix (10 ms actif + 20 ms bypass) et beat sans effet : la voix part 30 ms plus tôt.
    const nodes = new Map<string, PdcNode>([['voix', { latency: chainLatency(plugins, id => LAT[id]), outputs: [''] }], ['beat', { latency: 0, outputs: [''] }]]);
    const r = computePdc(nodes);
    close(r.get('voix')!.total, 0.030);
    // Rendre « b » inactif : il ne compte plus (PDC recalculée).
    const after = plugins.map(p => (p.id === 'b' ? withPluginInactive(p, true) : p));
    close(chainLatency(after, id => LAT[id]), 0.010);
  });

  it('états : actif / bypass / inactif, réactivation, raccourcis Pro Tools', () => {
    const p = fx('x');
    expect(pluginState(withPluginState(p, 'bypass'))).toBe('bypass');
    const ina = withPluginState(withPluginState(p, 'bypass'), 'inactive');
    expect(pluginState(ina)).toBe('inactive');
    expect(ina.isEnabled).toBe(false); // le bypass est gardé sous l'inactivité
    expect(pluginState(withPluginInactive(ina, false))).toBe('bypass');
    expect(withPluginState(ina, 'active')).not.toHaveProperty('isInactive');
    expect(pluginClickAction({ ctrlKey: true })).toBe('bypass');
    expect(pluginClickAction({ ctrlKey: true, altKey: true })).toBe('inactive');
    expect(pluginClickAction({ metaKey: true, altKey: true })).toBe('inactive');
    expect(pluginClickAction({})).toBeNull();
  });

  it('les réglages d’un effet inactif (et l’état d’un VST) sont gardés', () => {
    const vst = fx('v', { type: 'VST3', params: { stateB64: 'QUJD', localPath: 'C:\\x.vst3' } });
    const ina = withPluginState(vst, 'inactive');
    expect(ina.params).toEqual(vst.params);
    expect(withPluginState(ina, 'active').params.stateB64).toBe('QUJD');
  });
});

// ─── 2. Pistes inactives ───────────────────────────────────────────────────────

describe('pistes inactives : hors du moteur et de l’export', () => {
  const session = () => [
    T('lead', { outputTrackId: 'busa', sends: [{ id: 'rv', level: 0.5, isEnabled: true }] }),
    T('backb', { isInactive: true, isHidden: true, outputTrackId: 'busb' }),
    BUS('busa'), BUS('busb', { isInactive: true }), T('vers-busb', { outputTrackId: 'busb' }),
    RET('rv'), MASTER(),
  ];

  it('une piste inactive n’est pas jouée ; ce qui y sort part dans le vide', () => {
    const v = engineView(session());
    expect(v.excluded).toEqual(new Set(['backb', 'busb']));
    expect(v.byId.has('backb')).toBe(false);
    expect(v.byId.get('vers-busb')!.outputTrackId).toBe(VOID_OUTPUT);
    // Export mesuré : rien n'arrive de BACK B (inactive), ni de la piste qui sort vers un bus inactif.
    const m = mixImpulse(session(), { lead: 1, backb: 1, 'vers-busb': 1 });
    close(m.master[0], 1 + 0.5); // lead (1) + son envoi reverb (0.5)
    // Réactivée en un clic : elle rejoue.
    const on = showAndActivate(setTracksInactive(session(), ['busb'], false), 'backb');
    const m2 = mixImpulse(on, { lead: 1, backb: 1, 'vers-busb': 1 });
    close(m2.master[0], 1.5 + 1 + 1);
  });

  it('une piste inactive n’ajoute aucune latence (elle n’est pas dans la PDC du moteur)', () => {
    const tracks = [T('voix', { plugins: [fx('lat')] }), T('backb', { isInactive: true, plugins: [fx('lat2')] }), MASTER()];
    const ids = engineView(tracks).tracks.map(t => t.id);
    expect(ids).toEqual(['voix', 'master']);
  });

  it('vue idempotente et pistes inchangées gardées telles quelles (pas de recâblage inutile)', () => {
    const s = session();
    const v = engineView(s);
    expect(engineView(v.tracks)).toBe(v);
    expect(v.byId.get('lead')).toBe(s[0]);
    // La signature change quand une autre piste devient inactive.
    expect(structureSig(s)).not.toBe(structureSig(setTracksInactive(s, ['busa'], true)));
  });
});

// ─── 3. Dossiers ───────────────────────────────────────────────────────────────

describe('dossiers : routage (mesuré), simples, Muet / Solo / inactif appliqués aux enfants', () => {
  const vox = () => createFolder([T('lead'), T('double', { volume: 0.5 }), T('beat'), MASTER()], { id: 'vox', name: 'VOX', kind: 'routing', childIds: ['lead', 'double'] });

  it('dossier de routage = un bus : les enfants y sont routés et mixés', () => {
    const tracks = vox().map(t => (t.id === 'vox' ? { ...t, volume: 0.5 } : t));
    expect(tracks.map(t => t.id)).toEqual(['vox', 'lead', 'double', 'beat', 'master']);
    expect(tracks.find(t => t.id === 'lead')!.outputTrackId).toBe('vox');
    const m = mixImpulse(tracks, { lead: 1, double: 1 });
    close(m.inputs.vox[0], 1 + 0.5); // somme des enfants à l'entrée du dossier
    close(m.master[0], (1 + 0.5) * 0.5); // fader du dossier
  });

  it('Muet, Solo et inactif du dossier appliqués aux enfants', () => {
    const muted = vox().map(t => (t.id === 'vox' ? { ...t, isMuted: true } : t));
    close(mixImpulse(muted, { lead: 1, double: 1, beat: 1 }).master[0], 1); // reste le beat
    const solo = vox().map(t => (t.id === 'vox' ? { ...t, isSolo: true } : t));
    close(mixImpulse(solo, { lead: 1, double: 1, beat: 1 }).master[0], 1.5); // beat coupé par le solo
    const off = setTracksInactive(vox(), ['vox'], true);
    expect(engineView(off).tracks.map(t => t.id)).toEqual(['beat', 'master']);
    expect(isEffectivelyInactive(off.find(t => t.id === 'lead')!, off)).toBe(true);
  });

  it('dossier simple : range seulement (pas de son), son Muet s’applique aux enfants', () => {
    const basic = createFolder([T('kick'), T('snare'), MASTER()], { id: 'beat', name: 'BEAT', kind: 'basic', childIds: ['kick', 'snare'] });
    expect(basic.find(t => t.id === 'kick')!.outputTrackId).toBe('master');
    expect(engineView(basic).excluded.has('beat')).toBe(true);
    close(mixImpulse(basic, { kick: 1, snare: 1 }).master[0], 2);
    const m = basic.map(t => (t.id === 'beat' ? { ...t, isMuted: true } : t));
    close(mixImpulse(m, { kick: 1, snare: 1 }).master[0], 0);
  });

  it('glisser dedans / dehors, replier : affichage et sortie', () => {
    let tracks = vox();
    tracks = moveIntoFolder(tracks, 'beat', 'vox');
    expect(tracks.map(t => t.id)).toEqual(['vox', 'lead', 'double', 'beat', 'master']);
    expect(tracks.find(t => t.id === 'beat')!.outputTrackId).toBe('vox');
    tracks = moveOutOfFolder(tracks, 'beat');
    expect(tracks.find(t => t.id === 'beat')!.parentFolderId).toBeUndefined();
    expect(tracks.find(t => t.id === 'beat')!.outputTrackId).toBe('master');
    const closed = tracks.map(t => (t.id === 'vox' ? { ...t, folder: { kind: 'routing' as const, isOpen: false } } : t));
    expect(isShownInEdit(closed.find(t => t.id === 'lead')!, closed)).toBe(false);
    expect(isShownInEdit(closed.find(t => t.id === 'vox')!, closed)).toBe(true);
  });
});

// ─── 4. VCA ────────────────────────────────────────────────────────────────────

describe('VCA : dB relatifs, Muet / Solo, membres à la main ou par groupe', () => {
  const base = () => createVca([T('lead', { volume: 0.8 }), T('double', { volume: 0.4, groupId: 'grp-vox' }), T('beat'), MASTER()], { id: 'vca', name: 'PRE ALL VOX', memberIds: ['lead'] })
    .map(t => (t.id === 'vca' ? { ...t, vcaGroupId: 'grp-vox' } : t));

  it('le fader du VCA multiplie les membres (−6 dB = ×0,501), sans passer le son', () => {
    const tracks = base().map(t => (t.id === 'vca' ? { ...t, volume: dbToGain(-6) } : t));
    const v = engineView(tracks);
    expect(v.excluded.has('vca')).toBe(true);
    close(v.byId.get('lead')!.volume, 0.8 * dbToGain(-6));
    close(v.byId.get('double')!.volume, 0.4 * dbToGain(-6)); // membre par le groupe
    close(v.byId.get('beat')!.volume, 1);
    const m = mixImpulse(tracks, { lead: 1, double: 1, beat: 1 });
    close(m.master[0], (0.8 + 0.4) * dbToGain(-6) + 1);
    // En dB : chaque membre baisse exactement de 6 dB.
    close(20 * Math.log10(v.byId.get('lead')!.volume / 0.8), -6, 1e-9);
  });

  it('Muet / Solo du VCA appliqués aux membres ; VCA imbriqué', () => {
    const muted = base().map(t => (t.id === 'vca' ? { ...t, isMuted: true } : t));
    close(mixImpulse(muted, { lead: 1, double: 1, beat: 1 }).master[0], 1);
    const solo = base().map(t => (t.id === 'vca' ? { ...t, isSolo: true } : t));
    close(mixImpulse(solo, { lead: 1, double: 1, beat: 1 }).master[0], 1.2);
    const nested = createVca(base(), { id: 'all', name: 'ALL' }).map(t => (t.id === 'vca' ? { ...t, vcaId: 'all' } : t.id === 'all' ? { ...t, volume: 0.5 } : t));
    close(engineView(nested).byId.get('lead')!.volume, 0.8 * 0.5);
  });

  it('automation du volume d’un membre : la courbe passe aussi par le VCA', () => {
    const tracks = base().map(t => (t.id === 'lead' ? { ...t, automationLanes: [{ id: 'l', parameterName: 'volume', points: [{ id: 'p', time: 0, value: 1 }], color: '#fff', isExpanded: false, min: 0, max: 1.5 }] } : t.id === 'vca' ? { ...t, volume: 0.5 } : t));
    expect(engineView(tracks).byId.get('lead')!.automationLanes[0].points[0].value).toBe(0.5);
  });
});

// ─── 5. Envois a-j ─────────────────────────────────────────────────────────────

describe('envois a à j : niveau, pan, mute, pré / post', () => {
  it('pan propre de l’envoi (mesuré) et mute (routé mais à zéro)', () => {
    const lead = T('lead', { pan: 0, sends: [{ id: 'rv', level: 1, isEnabled: true, pan: -1 }] });
    const m = mixImpulse([lead, RET('rv', { volume: 1 }), MASTER()], { lead: 1 });
    close(m.inputs.rv[0], 2); close(m.inputs.rv[1], 0); // tout à gauche (L + R repliés à gauche)
    const muted = { ...lead, sends: [{ ...lead.sends[0], isMuted: true }] };
    const m2 = mixImpulse([muted, RET('rv'), MASTER()], { lead: 1 });
    close(m2.inputs.rv[0], 0);
    expect(engineView([muted, RET('rv'), MASTER()]).byId.get('lead')!.sends).toHaveLength(1); // toujours câblé
  });

  it('pré-fader : le fader de la piste ne change pas l’envoi', () => {
    const lead = T('lead', { volume: 0.1, sends: [{ id: 'rv', level: 0.5, isEnabled: true, preFader: true }] });
    close(mixImpulse([lead, RET('rv'), MASTER()], { lead: 1 }).inputs.rv[0], 0.5);
  });

  it('10 emplacements, lettres stables, un bus = un envoi par piste', () => {
    let sends = setSendSlot([], 2, { id: 'rv', level: 0.5, isEnabled: true });
    sends = setSendSlot(sends, 0, { id: 'dl', level: 0.3, isEnabled: true });
    const slots = sendSlots(sends);
    expect(slots).toHaveLength(10);
    expect(slots[0]!.id).toBe('dl');
    expect(slots[2]!.id).toBe('rv');
    sends = setSendSlot(sends, 5, { id: 'rv', level: 0.5, isEnabled: true });
    expect(sendSlots(sends)[2]).toBeNull();
    expect(sendSlots(sends)[5]!.id).toBe('rv');
    // Anciens envois sans emplacement : rangés dans l'ordre.
    expect(sendSlots([{ id: 'a', level: 1, isEnabled: true }, { id: 'b', level: 1, isEnabled: true }]).map(s => s?.id).slice(0, 3)).toEqual(['a', 'b', undefined]);
  });
});

// ─── 6. Bus nommés ─────────────────────────────────────────────────────────────

describe('bus nommés (I/O Setup) : entrée, sortie, qui envoie où', () => {
  it('sortie vers un bus = la piste qui l’écoute ; personne n’écoute = le vide', () => {
    let tracks: Track[] = [T('lead'), T('lead2'), BUS('leadabus'), RET('rv'), MASTER()];
    const r = createBus(tracks, 'LEAD A'); tracks = r.tracks;
    expect(r.bus).toEqual({ id: 'bus:lead-a', name: 'LEAD A' });
    tracks = setTrackOutput(tracks, 'lead', { kind: 'bus', id: r.bus.id });
    expect(engineView(tracks).byId.get('lead')!.outputTrackId).toBe(VOID_OUTPUT);
    tracks = setTrackInputBus(tracks, 'leadabus', r.bus.id);
    tracks = setTrackOutput(tracks, 'lead2', { kind: 'bus', id: r.bus.id });
    expect(tracks.find(t => t.id === 'lead')!.outputTrackId).toBe('leadabus'); // les anciennes versions suivent
    expect(engineView(tracks).byId.get('lead')!.outputTrackId).toBe('leadabus');
    close(mixImpulse(tracks, { lead: 1, lead2: 1 }).inputs.leadabus[0], 2);
    tracks = renameBus(tracks, r.bus.id, 'LEAD A VOX');
    const u = busUsage(tracks)[0];
    expect(u.bus.name).toBe('LEAD A VOX');
    expect(u.listeners.map(t => t.id)).toEqual(['leadabus']);
    expect(u.outputs.map(t => t.id)).toEqual(['lead', 'lead2']);
    tracks = deleteBus(tracks, r.bus.id);
    expect(tracks.find(t => t.id === 'lead')!.outputTrackId).toBe('master');
  });

  it('deux pistes écoutent le même bus : le son arrive dans les deux', () => {
    let tracks: Track[] = [T('lead'), BUS('a'), BUS('b'), MASTER()];
    const { bus, tracks: t1 } = createBus(tracks, 'VOX ALL'); tracks = t1;
    tracks = setTrackInputBus(setTrackInputBus(tracks, 'a', bus.id), 'b', bus.id);
    tracks = setTrackOutput(tracks, 'lead', { kind: 'bus', id: bus.id });
    const m = mixImpulse(tracks, { lead: 1 });
    close(m.inputs.a[0], 1); close(m.inputs.b[0], 1);
  });
});

// ─── 7. Liste des pistes ───────────────────────────────────────────────────────

describe('liste des pistes : masquer, tout afficher, prêtes à servir', () => {
  const lennon = () => {
    let t: Track[] = [T('ldb', { isHidden: true, isInactive: true }), T('backb', { isHidden: true, isInactive: true }), T('lead'), MASTER()];
    t = createFolder(t, { id: 'back', name: 'BACK', kind: 'routing', childIds: ['backb'] });
    return setTracksInactive(setTracksHidden(t, ['back'], true), ['back'], true);
  };
  it('Ctrl+clic : tout masquer / tout afficher (le master ne se masque pas)', () => {
    const all = setAllHidden(lennon(), true);
    expect(all.filter(t => t.isHidden).map(t => t.id).sort()).toEqual(['back', 'backb', 'ldb', 'lead']);
    expect(setAllHidden(all, false).some(t => t.isHidden)).toBe(false);
  });
  it('« Afficher et activer » en un geste (dossier parent compris) ; une piste masquée active joue', () => {
    const before = lennon();
    expect(readyToUseTracks(before).map(t => t.id).sort()).toEqual(['back', 'backb', 'ldb']);
    const after = showAndActivate(before, 'backb');
    const b = after.find(t => t.id === 'backb')!;
    expect(b.isHidden || b.isInactive).toBeFalsy();
    expect(after.find(t => t.id === 'back')!.isInactive).toBeFalsy();
    expect(engineView(after).byId.has('backb')).toBe(true);
    // Masquée mais active : jouée.
    const hiddenActive = setTracksHidden(after, ['lead'], true);
    expect(engineView(hiddenActive).byId.has('lead')).toBe(true);
    expect(filterTrackList(hiddenActive, 'hidden').map(t => t.id)).toContain('lead');
    expect(filterTrackList(before, 'inactive').map(t => t.id)).toEqual(['ldb', 'back', 'backb']);
  });
});

// ─── 8. Modèles : sauvegarde + fiche LENNON ────────────────────────────────────

const structuredState = () => {
  let tracks: Track[] = [
    T('lead', { plugins: [fx('tune', { isEnabled: false }), fx('comp'), fx('sat', { isInactive: true })], sends: [{ id: 'rv', level: 0.4, isEnabled: true, pan: -0.3, isMuted: true, slot: 2 }] }),
    T('backb', { isHidden: true, isInactive: true }), RET('rv'), MASTER(),
  ];
  tracks = createFolder(tracks, { id: 'vox', name: 'VOX', kind: 'routing', childIds: ['lead', 'backb'] });
  tracks = createVca(tracks, { id: 'vca', name: 'PRE ALL VOX', memberIds: ['lead'] });
  const r = createBus(tracks, 'LEAD A');
  tracks = setTrackInputBus(r.tracks, 'rv', r.bus.id);
  return makeState(tracks);
};

describe('modèles de session : tout est enregistré et recréé', () => {
  it('sauvegarde → fichier → nouveau projet : masqué, inactif, bypass, dossiers, VCA, envois, bus', () => {
    const tpl = parseTemplate(serializeTemplate(createTemplateFromState(structuredState(), { name: 'LENNON', id: 'tpl', now: 1 })));
    const info = templateInfo(tpl);
    expect(info).toMatchObject({ folders: 1, vcas: 1, hiddenTracks: 1, inactiveTracks: 1, namedBuses: 1 });
    const { state } = instantiateTemplate(tpl, { plugins: null });
    const by = new Map(state.tracks.map(t => [t.id, t]));
    expect(by.get('lead')!.plugins.map(pluginState)).toEqual(['bypass', 'active', 'inactive']);
    expect(by.get('lead')!.sends[0]).toMatchObject({ id: 'rv', pan: -0.3, isMuted: true, slot: 2 });
    expect(by.get('lead')!.parentFolderId).toBe('vox');
    expect(by.get('lead')!.vcaId).toBe('vca');
    expect(by.get('vox')!.folder).toEqual({ kind: 'routing', isOpen: true });
    expect(by.get('vca')!.isVca).toBe(true);
    expect(by.get('backb')).toMatchObject({ isHidden: true, isInactive: true });
    expect(by.get('master')!.ioBuses).toEqual([{ id: 'bus:lead-a', name: 'LEAD A' }]);
    expect(by.get('rv')!.inputBusId).toBe('bus:lead-a');
  });

  it('« activer tous les effets » : l’inactif devient actif, la trace est gardée', () => {
    const tpl = createTemplateFromState(structuredState(), { name: 'x', id: 'x', now: 1 });
    const { state, report } = instantiateTemplate(tpl, { plugins: null, enableAll: true });
    const sat = state.tracks.find(t => t.id === 'lead')!.plugins[2];
    expect(pluginState(sat)).toBe('active');
    expect(sat.params.templateWasInactive).toBe(true);
    expect(report.enabled).toBe(2);
  });

  it('fiche (format LENNON) : dossiers, VCA, bus, états, envois avec pan / mute, pistes masquées / inactives', () => {
    const spec: TemplateSpec = {
      format: 'nova-template-spec', version: 1, name: 'LENNON départ',
      buses: ['LEAD A', { name: 'VOX ALL' }],
      tracks: [
        { name: 'VOX', kind: 'folder', folderKind: 'routing', output: 'VOX ALL' },
        { name: 'LEAD A', kind: 'audio', folder: { kind: 'routing', name: 'COUPLET' }, output: 'LEAD A', vca: 'PRE ALL VOX',
          inserts: [{ plugin: 'Auto-Tune Pro', vendor: 'Antares', state: 'bypass' }, { plugin: 'COMPRESSOR', vendor: 'NOVA' }, { plugin: 'Gem Dopamine', vendor: 'Overloud', active: false }],
          sends: [{ to: 'RV', levelDb: -12, pan: '<30', mute: true, slot: 'c' }, { to: 'DL 1/4', levelDb: -18, pre: true }] },
        { name: 'LEAD A BUS', kind: 'aux', input: 'LEAD A', folder: 'COUPLET' },
        { name: 'BACK B', kind: 'audio', hidden: true, inactive: true, parent: 'VOX' },
        { name: 'RV', kind: 'aux' }, { name: 'DL 1/4', kind: 'aux' },
        { name: 'ALL VOX', kind: 'aux', input: 'VOX ALL' },
        { name: 'MASTER', kind: 'master' },
      ],
    };
    const { template } = buildTemplateFromSpec(spec, { plugins: [], id: 'l', now: 1 });
    const t = new Map(template.session.tracks.map(x => [x.name, x]));
    const coupletId = t.get('COUPLET')!.id;
    expect(t.get('COUPLET')!.folder).toEqual({ kind: 'routing', isOpen: true }); // créé, avant sa 1re piste
    expect(template.session.tracks.findIndex(x => x.name === 'COUPLET')).toBeLessThan(template.session.tracks.findIndex(x => x.name === 'LEAD A'));
    expect(t.get('LEAD A')!.parentFolderId).toBe(coupletId);
    expect(t.get('LEAD A')!.outputBusId).toBe('bus:lead-a');
    expect(t.get('LEAD A')!.outputTrackId).toBe(t.get('LEAD A BUS')!.id);
    expect(t.get('LEAD A BUS')!.inputBusId).toBe('bus:lead-a');
    expect(t.get('LEAD A BUS')!.outputTrackId).toBe(coupletId); // dans un dossier de routage : sortie = dossier
    expect(t.get('VOX')!.outputTrackId).toBe(t.get('ALL VOX')!.id);
    expect(t.get('PRE ALL VOX')!.isVca).toBe(true);
    expect(t.get('LEAD A')!.vcaId).toBe(t.get('PRE ALL VOX')!.id);
    expect(t.get('BACK B')).toMatchObject({ isHidden: true, isInactive: true, parentFolderId: t.get('VOX')!.id });
    expect(t.get('LEAD A')!.plugins.map(pluginState)).toEqual(['bypass', 'active', 'inactive']);
    const s0 = t.get('LEAD A')!.sends[0];
    expect(s0).toMatchObject({ id: t.get('RV')!.id, isMuted: true, slot: 2 });
    close(s0.pan!, -0.3);
    expect(t.get('LEAD A')!.sends[1]).toMatchObject({ preFader: true });
    expect(template.session.tracks.find(x => x.id === 'master')!.ioBuses!.map(b => b.name)).toEqual(['LEAD A', 'VOX ALL']);
    // « Activer tous les effets inactifs » : Gem Dopamine actif, trace gardée ; le bypass reste.
    const act = buildTemplateFromSpec(spec, { plugins: [], activateAll: true }).template.session.tracks.find(x => x.name === 'LEAD A')!;
    expect(act.plugins.map(pluginState)).toEqual(['bypass', 'active', 'active']);
    expect(act.plugins[2].params.templateWasInactive).toBe(true);
    expect(act.plugins[2].params.templateSpec.state).toBe('inactive');
    // Le projet issu du modèle joue la bonne chose : BACK B inactive hors du moteur, LEAD A vers son bus.
    const { state } = instantiateTemplate(template, { plugins: null });
    const v = engineView(state.tracks);
    expect(v.excluded.has(t.get('BACK B')!.id)).toBe(true);
    expect(v.byId.get(t.get('LEAD A')!.id)!.outputTrackId).toBe(t.get('LEAD A BUS')!.id);
  });
});

// ─── 9. Collaboration ──────────────────────────────────────────────────────────

describe('collaboration : masqué, inactif, dossiers, VCA, effets inactifs voyagent', () => {
  it('un changement de structure part comme un champ de mix et s’applique chez l’autre', () => {
    const mine = T('backb', { plugins: [fx('sat')] });
    const theirs: Track = JSON.parse(JSON.stringify(mine));
    const known = fieldSigsOf(mixFieldsOf(mine));
    const changed: Track = { ...mine, isHidden: true, isInactive: true, parentFolderId: 'back', plugins: [withPluginState(mine.plugins[0], 'inactive')] };
    const fields = changedFields(known, mixFieldsOf(changed));
    expect(Object.keys(fields).sort()).toEqual(['plugin:sat', 'structure']);
    const applied = applyMixFields(theirs, JSON.parse(JSON.stringify(fields)), () => true);
    expect(applied).toContain('structure');
    expect(theirs).toMatchObject({ isHidden: true, isInactive: true, parentFolderId: 'back' });
    expect(pluginState(theirs.plugins[0])).toBe('inactive');
    // Et retour : réactivée chez l'un = réactivée chez l'autre.
    const back = applyMixFields(theirs, mixFieldsOf(showAndActivate([changed], 'backb')[0]), () => true);
    expect(back).toContain('structure');
    expect(theirs.isHidden).toBeUndefined();
    expect(theirs.isInactive).toBeUndefined();
  });
});
