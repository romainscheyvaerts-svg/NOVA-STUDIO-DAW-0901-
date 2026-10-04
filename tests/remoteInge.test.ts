import { describe, expect, it, vi } from 'vitest';
import { Clip, PluginInstance, PluginType, Track, TrackType } from '../types';
import { anchorClipsToRender, busFrozenSlices, frozenPlayback, isFeedCovered, pluginsSignature } from '../utils/freeze';
import {
  acceptReturn, acceptSend, applyFxOnArtist, applyReturnOnArtist, applySendOnEngineer, artistBusId, artistNeedsSend, artistStatus,
  buildFxPayload, buildReturnPayload, buildSendPayload, checkPluginAdd, enforceRemoteMixRule, fxSignature, installedForRemote,
  isTemporalPlugin, mapRenderedRefs, markSent, moveInsertToSend, needsProcessing, parseRemoteLink, rawSignature, remoteRuleIssues,
  RemoteOutbox, revertOnArtist, sendBufferIds, shouldSendReturn,
} from '../utils/remoteInge';
import type { MixPlan, KnownPlugin } from '../utils/mixPlanner';
import { makeClip, makeTrack } from './helpers/fixtures';

const vst = (id: string, name: string, extra: Record<string, any> = {}): PluginInstance =>
  ({ id, name, type: 'VST3' as PluginType, isEnabled: true, latency: 0, params: { name, localPath: `C:\\VST3\\${name}.vst3`, stateB64: 'c3RhdGU=', ...extra } });
const native = (id: string, type: PluginType, params: Record<string, any> = {}): PluginInstance =>
  ({ id, name: type, type, isEnabled: true, latency: 0, params });

/** Session de l'artiste : une piste lead (3 phrases, une prise), sa reverb de NOVA. */
function artistSession() {
  const clips: Clip[] = [
    makeClip({ id: 'p1', name: 'Phrase 1', start: 1, offset: 1, duration: 2, bufferId: 'take1' }),
    makeClip({ id: 'p2', name: 'Phrase 2', start: 4, offset: 4, duration: 2, bufferId: 'take1' }),
    makeClip({ id: 'p3', name: 'Phrase 3', start: 7, offset: 7, duration: 2, bufferId: 'take1' }),
  ];
  const lead = makeTrack({ id: 'lead', name: 'LEAD', clips, plugins: [native('a-eq', 'PROEQ12')], sends: [{ id: 'send-verb-short', level: 0.2, isEnabled: true }], remote: { peerTrackId: 'lead', slot: 'lead' } });
  const verb = makeTrack({ id: 'send-verb-short', name: 'VERB PRO', type: TrackType.SEND, sends: [], plugins: [native('a-verb', 'REVERB', { decay: 1.2, mix: 1 })] });
  const master = makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] });
  return [lead, verb, master];
}

/** Gel simulé chez l'ingé (ce que fait VstFreeze.applyFreezeResult + applyBusFreezeResult). */
function engineerFreeze(tracks: Track[], trackId: string, busId: string, stamp: string) {
  const t = tracks.find(x => x.id === trackId)!;
  const bus = tracks.find(x => x.id === busId)!;
  const renderId = `frozen-${trackId}-${stamp}`;
  const anchors = anchorClipsToRender(t.clips, renderId);
  t.clips = t.clips.map(c => ({ ...c, freezeRef: anchors.get(c.id) }));
  t.isFrozen = true;
  t.frozenClip = makeClip({ id: renderId, bufferId: renderId, start: 0, offset: 0, duration: 12 });
  t.frozenUpToPluginIndex = t.plugins.length - 1;
  t.frozenClipIds = t.clips.map(c => c.id);
  t.frozenPluginSig = pluginsSignature(t.plugins, t.plugins.length - 1);
  const busRender = `frozen-${busId}-${stamp}`;
  bus.isFrozen = true;
  bus.frozenClip = makeClip({ id: busRender, bufferId: busRender, duration: 0.05 });
  bus.frozenUpToPluginIndex = bus.plugins.length - 1;
  bus.frozenClipIds = [];
  bus.frozenPluginSig = pluginsSignature(bus.plugins, bus.plugins.length - 1);
  t.sendFreezes = [{
    busId, busRenderId: busRender, anchorId: renderId, volume: t.volume, level: t.sends.find(s => s.id === busId)!.level, sig: 'x',
    clip: makeClip({ id: `send-${trackId}-${busId}-${stamp}`, bufferId: `send-${trackId}-${busId}-${stamp}`, duration: 15 }),
  }];
}

/** Session de l'ingé avec la piste reçue, ses VST (insert) et sa reverb VST en envoi. */
function engineerWorks(tracks: Track[], trackId: string) {
  const t = tracks.find(x => x.id === trackId)!;
  t.plugins = [vst('i-comp', 'Pro-C 2'), native('i-deess', 'DEESSER')];
  t.sends = [{ id: 'send-vst-verb', level: 0.4, isEnabled: true }];
  const at = tracks.findIndex(x => x.id === 'master');
  tracks.splice(at, 0, makeTrack({ id: 'send-vst-verb', name: 'Valhalla', type: TrackType.SEND, sends: [], plugins: [vst('i-verb', 'ValhallaVintageVerb')] }));
}

describe('effets temporels', () => {
  it('reconnaît reverbs et délais (natifs, VST par catégorie ou par nom)', () => {
    expect(isTemporalPlugin(native('r', 'REVERB'))).toBe(true);
    expect(isTemporalPlugin(native('d', 'DELAY'))).toBe(true);
    expect(isTemporalPlugin(native('c', 'COMPRESSOR'))).toBe(false);
    expect(isTemporalPlugin(vst('v', 'ValhallaVintageVerb'))).toBe(true);
    expect(isTemporalPlugin(vst('e', 'EchoBoy'))).toBe(true);
    expect(isTemporalPlugin(vst('c', 'Pro-C 2'))).toBe(false);
    expect(isTemporalPlugin(vst('t', 'Trackspacer'))).toBe(false);
    // Catégorie de la base de connaissance prioritaire.
    expect(isTemporalPlugin(vst('x', 'Mystery FX'), () => 'reverb')).toBe(true);
    expect(isTemporalPlugin(vst('x', 'Room Tone EQ'), () => 'eq')).toBe(false);
  });

  it('règle des envois : effet temporel en insert d\'une piste échangée = problème, réparable en un clic', () => {
    const tracks = artistSession();
    tracks[0].plugins.push(native('bad', 'REVERB', { mix: 0.25 }));
    const issues = remoteRuleIssues(tracks, ['lead'], 'mixing');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'temporal-insert', pluginId: 'bad', fix: 'move-to-send' });
    const r = moveInsertToSend(tracks, 'lead', 'bad', 1000)!;
    expect(r.level).toBe(0.25);
    expect(tracks[0].plugins.map(p => p.id)).toEqual(['a-eq']);
    const bus = tracks.find(t => t.id === r.busId)!;
    expect(bus.type).toBe(TrackType.SEND);
    expect(bus.plugins[0]).toMatchObject({ id: 'bad', type: 'REVERB', params: { mix: 1 } });
    expect(tracks[0].sends.find(s => s.id === r.busId)).toMatchObject({ level: 0.25, isEnabled: true });
    expect(tracks[tracks.length - 1].id).toBe('master'); // bus inséré avant le master
    expect(remoteRuleIssues(tracks, ['lead'], 'mixing')).toHaveLength(0);
  });

  it('verrou d\'enregistrement : reverb / délai VST refusés, ceux de NOVA permis', () => {
    expect(checkPluginAdd({ phase: 'recording', isRemoteTrack: false }, vst('v', 'ValhallaRoom'))).toMatchObject({ ok: false, code: 'vst-temporal-recording' });
    expect(checkPluginAdd({ phase: 'recording', isRemoteTrack: true }, native('r', 'REVERB'))).toEqual({ ok: true });
    expect(checkPluginAdd({ phase: 'recording', isRemoteTrack: true }, vst('c', 'Pro-C 2'))).toEqual({ ok: true });
    expect(checkPluginAdd({ phase: 'mixing', isRemoteTrack: false }, vst('v', 'ValhallaRoom'))).toEqual({ ok: true });
    expect(checkPluginAdd({ phase: 'mixing', isRemoteTrack: true, forceInsert: true }, native('r', 'REVERB'))).toMatchObject({ ok: false, code: 'temporal-insert' });
    // Bus alimenté par une piste échangée : une reverb VST déjà là pendant l'enregistrement est signalée.
    const tracks = artistSession();
    tracks[1].plugins.push(vst('vv', 'ValhallaVintageVerb'));
    expect(remoteRuleIssues(tracks, ['lead'], 'recording').map(i => i.code)).toEqual(['vst-temporal-recording']);
    expect(remoteRuleIssues(tracks, ['lead'], 'mixing')).toHaveLength(0);
  });

  it('mix piloté par le chat : pas de reverb VST pendant l\'enregistrement, jamais en insert', () => {
    const known = (name: string, category: any): KnownPlugin => ({ key: name, name, vendor: '', path: name, pluginName: null, category, params: [] });
    const installed = [known('Pro-C 2', 'compressor'), known('Valhalla', 'reverb'), known('EchoBoy', 'delay')];
    expect(installedForRemote(installed, { phase: 'recording', trackIds: ['lead'] }).map(p => p.name)).toEqual(['Pro-C 2']);
    expect(installedForRemote(installed, { phase: 'mixing', trackIds: ['lead'] })).toHaveLength(3);
    expect(installedForRemote(installed, null)).toHaveLength(3);
    const plan: MixPlan = {
      tweakOnly: false, sends: [], summary: [], warnings: [],
      tracks: [
        { trackId: 'lead', trackName: 'LEAD', vst: [{ slot: 'comp1', plugin: installed[0], settings: [], says: [] }, { slot: 'width', plugin: installed[2], settings: [], says: [] }], builtin: [], pauseBuiltin: [] },
        { trackId: 'send-verb-short', trackName: 'VERB', vst: [{ slot: 'verb', plugin: installed[1], settings: [], says: [] }], builtin: [], pauseBuiltin: ['a-verb'] },
      ],
    };
    const mixing = enforceRemoteMixRule(plan, { phase: 'mixing', trackIds: ['lead'] });
    expect(mixing.tracks[0].vst.map(v => v.plugin.name)).toEqual(['Pro-C 2']); // délai retiré de l'insert
    expect(mixing.tracks[1].vst).toHaveLength(1); // reverb VST en envoi : permise au mix
    const rec = enforceRemoteMixRule(plan, { phase: 'recording', trackIds: ['lead'] });
    expect(rec.tracks[1].vst).toHaveLength(0);
    expect(rec.tracks[1].pauseBuiltin).toEqual([]); // la reverb de NOVA reste active
    expect(rec.warnings.join(' ')).toMatch(/enregistrement en cours/);
    expect(enforceRemoteMixRule(plan, null)).toBe(plan);
  });
});

describe('aller-retour artiste → ingé → artiste', () => {
  it('envoi : audio brut + éditions, sans rendu ni ancrage', () => {
    const [lead] = artistSession();
    lead.clips[0] = { ...lead.clips[0], freezeRef: { renderId: 'old', anchor: 0, from: 1, to: 3, fadeIn: 0, fadeOut: 0, gain: 1 } };
    const p = buildSendPayload(lead, 1);
    expect(p.clips.every(c => !c.freezeRef)).toBe(true);
    expect(sendBufferIds(p)).toEqual(['take1']);
    expect(p.slot).toBe('lead');
    expect(p.sig).toBe(rawSignature(lead));
  });

  it('chez l\'ingé : piste créée dans SA session, doublons et versions anciennes écartés', () => {
    const artist = artistSession();
    const engineer = [makeTrack({ id: 'lead', name: 'Autre projet' }), makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] })];
    const p1 = buildSendPayload(artist[0], 1);
    const r = applySendOnEngineer(engineer, p1);
    expect(r.created).toBe(true);
    expect(r.trackId).not.toBe('lead'); // id déjà pris dans la session de l'ingé
    const t = engineer.find(x => x.id === r.trackId)!;
    expect(t.remote).toMatchObject({ peerTrackId: 'lead', recvV: 1, slot: 'lead' });
    expect(t.clips).toHaveLength(3);
    expect(engineer[engineer.length - 1].id).toBe('master');
    expect(acceptSend(t.remote, p1)).toBe('dup');
    expect(acceptSend(t.remote, { v: 1, sig: 'autre' })).toBe('old');
    expect(acceptSend(t.remote, { v: 2, sig: 'autre' })).toBe('new');
    expect(acceptSend(undefined, p1)).toBe('new');
  });

  it('retour : rendu gelé et reverb VST par source posés sur les clips de l\'artiste ; aucune boucle', () => {
    const artist = artistSession();
    const lead = artist[0];
    const v1 = markSent(lead, rawSignature(lead));
    expect(v1).toBe(1);
    expect(artistNeedsSend(lead)).toBe(false);

    const engineer = [makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] })];
    const { trackId } = applySendOnEngineer(engineer, buildSendPayload(lead, v1));
    engineerWorks(engineer, trackId);
    engineerFreeze(engineer, trackId, 'send-vst-verb', 'a');
    const et = engineer.find(x => x.id === trackId)!;
    expect(needsProcessing(et)).toBe(false); // pas encore de renvoi automatique (premier envoi manuel)

    const { payload, bufferIds } = buildReturnPayload(et, engineer, 'mixing', 58);
    expect(payload.trackId).toBe('lead');
    expect(payload.forV).toBe(1);
    expect(payload.latencyMs).toBe(58);
    expect(payload.plugins[0].params).toEqual({ name: 'Pro-C 2', remoteBaked: true }); // ni chemin ni état du VST de l'ingé
    expect(bufferIds.sort()).toEqual(['frozen-send-vst-verb-a', `frozen-${trackId}-a`, `send-${trackId}-send-vst-verb-a`].sort());
    expect(shouldSendReturn(et.remote, payload.sig)).toBe(true);
    et.remote = { ...et.remote!, returnedV: payload.forV, returnedSig: payload.sig, auto: true };
    expect(shouldSendReturn(et.remote, buildReturnPayload(et, engineer, 'mixing').payload.sig)).toBe(false); // jamais deux fois

    const sigBefore = rawSignature(lead);
    const r = applyReturnOnArtist(artist, payload, 'Ingé')!;
    expect(r.trackId).toBe('lead');
    let al = artist.find(x => x.id === 'lead')!;
    expect(al.isFrozen).toBe(true);
    expect(al.frozenClip!.id).toBe(`frozen-${trackId}-a`);
    expect(al.clips.every(c => c.freezeRef?.renderId === `frozen-${trackId}-a`)).toBe(true);
    expect(al.clips.map(c => c.bufferId)).toEqual(['take1', 'take1', 'take1']); // la prise brute est toujours là
    expect(al.sends).toEqual([{ id: 'ri-send-vst-verb', level: 0.4, isEnabled: true }]);
    const bus = artist.find(x => x.id === artistBusId('send-vst-verb'))!;
    expect(bus.isFrozen).toBe(true);
    expect(artist.find(x => x.id === 'send-verb-short')!.plugins[0].id).toBe('a-verb'); // son bus à lui intact
    expect(al.remote!.before!.plugins.map(p => p.id)).toEqual(['a-eq']);
    // Lecture : tranches du rendu + reverb VST qui suit les clips (aucun envoi direct en double).
    expect(frozenPlayback(al).render).toHaveLength(3);
    expect(busFrozenSlices(bus, artist)).toHaveLength(3);
    expect(isFeedCovered(al, 'ri-send-vst-verb', artist)).toBe(true);
    // Pas de boucle : poser le retour ne change pas ce qui part chez l'ingé.
    expect(rawSignature(al)).toBe(sigBefore);
    expect(artistNeedsSend(al)).toBe(false);
    expect(acceptReturn(al.remote, payload)).toBe('dup');

    // L'artiste supprime la phrase 3 : sa voix et sa reverb disparaissent tout de suite (aperçu)…
    // (nouvel objet piste, comme après une modification Immer : les tranches sont en cache par piste)
    al = { ...al, clips: al.clips.filter(c => c.id !== 'p3') };
    artist[0] = al;
    expect(busFrozenSlices(bus, artist)).toHaveLength(2);
    // … et la piste repart chez l'ingé (version 2).
    expect(artistNeedsSend(al)).toBe(true);
    const v2 = markSent(al, rawSignature(al));
    const p2 = buildSendPayload(al, v2);
    expect(acceptSend(et.remote, p2)).toBe('new');
    applySendOnEngineer(engineer, p2);
    expect(et.isFrozen).toBe(false); // dégelée : la vraie chaîne rejoue l'audio sec édité
    expect(et.plugins.map(p => p.id)).toEqual(['i-comp', 'i-deess']); // le travail de l'ingé reste
    expect(et.clips.map(c => c.id)).toEqual(['p1', 'p2']);
    expect(needsProcessing(et)).toBe(true); // renvoi automatique attendu
    engineerFreeze(engineer, trackId, 'send-vst-verb', 'b');
    const back = buildReturnPayload(et, engineer, 'mixing').payload;
    expect(back.forV).toBe(2);
    expect(shouldSendReturn(et.remote, back.sig)).toBe(true);
    et.remote = { ...et.remote!, returnedV: 2, returnedSig: back.sig };
    expect(needsProcessing(et)).toBe(false);
    expect(acceptReturn(al.remote, back)).toBe('new');
    const r2 = applyReturnOnArtist(artist, back)!;
    expect(r2.released.sort()).toEqual(['frozen-send-vst-verb-a', `frozen-${trackId}-a`, `send-${trackId}-send-vst-verb-a`].sort());
    expect(al.remote!.appliedV).toBe(2);
    expect(acceptReturn(al.remote, back)).toBe('dup');
    expect(acceptReturn(al.remote, payload)).toBe('old'); // retour v1 arrivé en retard : ignoré
  });

  it('remplacement d\'un passage par une autre prise : la nouvelle prise joue en direct, les morceaux découpés gardent le rendu', () => {
    const rendered = [{ clipId: 'p2', bufferId: 'take1', ref: { renderId: 'R', anchor: 0, from: 4, to: 6, fadeIn: 0, fadeOut: 0, gain: 1, srcClipId: 'p2' } }];
    const clips = [
      makeClip({ id: 'p2a', start: 4, offset: 4, duration: 1, bufferId: 'take1' }), // découpé après l'envoi
      makeClip({ id: 'new', start: 5, offset: 0, duration: 1, bufferId: 'take2' }), // autre prise
    ];
    const m = mapRenderedRefs(clips, rendered);
    expect(m.get('p2a')?.renderId).toBe('R');
    expect(m.has('new')).toBe(false);
  });

  it('revenir à ma prise brute (annulable : réglages de l\'ingé en réserve)', () => {
    const artist = artistSession();
    const engineer = [makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] })];
    const { trackId } = applySendOnEngineer(engineer, buildSendPayload(artist[0], 1));
    engineerWorks(engineer, trackId);
    engineerFreeze(engineer, trackId, 'send-vst-verb', 'a');
    const { payload } = buildReturnPayload(engineer.find(x => x.id === trackId)!, engineer, 'mixing');
    applyReturnOnArtist(artist, payload);
    expect(revertOnArtist(artist, 'lead', payload)).toBe(true);
    const al = artist[0];
    expect(al.isFrozen).toBe(false);
    expect(al.plugins.map(p => p.id)).toEqual(['a-eq']);
    expect(al.sends).toEqual([{ id: 'send-verb-short', level: 0.2, isEnabled: true }]);
    expect(al.clips.every(c => !c.freezeRef)).toBe(true);
    expect(al.remote!.reverted).toBe(true);
    expect(al.remote!.pending.sig).toBe(payload.sig);
    expect(acceptReturn(al.remote, payload)).toBe('dup'); // pas de ré-application automatique
    expect(artistStatus(al, undefined, false).code).toBe('reverted');
    applyReturnOnArtist(artist, al.remote!.pending);
    expect(al.isFrozen).toBe(true);
    expect(al.remote!.reverted).toBe(false);
  });
});

describe('effets temporels de NOVA synchronisés pendant l\'enregistrement', () => {
  it('l\'artiste entend la reverb native de l\'ingé (ses réglages), ses bus à lui restent intacts', () => {
    const artist = artistSession();
    const engineer = [
      makeTrack({ id: 'send-verb-short', name: 'VERB PRO', type: TrackType.SEND, sends: [], plugins: [native('e-verb', 'REVERB', { decay: 2.4, mix: 1 })] }),
      makeTrack({ id: 'send-vst', name: 'VST', type: TrackType.SEND, sends: [], plugins: [vst('v', 'ValhallaRoom')] }),
      makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] }),
    ];
    const { trackId } = applySendOnEngineer(engineer, buildSendPayload(artist[0], 1));
    const et = engineer.find(x => x.id === trackId)!;
    et.sends = [{ id: 'send-verb-short', level: 0.35, isEnabled: true }, { id: 'send-vst', level: 0.5, isEnabled: true }];
    const fx = buildFxPayload(engineer);
    expect(fx.buses.map(b => b.id)).toEqual(['send-verb-short']); // le bus VST ne voyage pas ici
    expect(fx.tracks).toEqual([{ trackId: 'lead', sends: [{ id: 'send-verb-short', level: 0.35, isEnabled: true }, { id: 'send-vst', level: 0.5, isEnabled: true }] }]);
    expect(applyFxOnArtist(artist, fx)).toBe(1);
    const riVerb = artist.find(x => x.id === 'ri-send-verb-short')!;
    expect(riVerb.plugins[0].params.decay).toBe(2.4);
    expect(artist.find(x => x.id === 'send-verb-short')!.plugins[0].params.decay).toBe(1.2);
    expect(artist[0].sends.map(s => s.id)).toEqual(['ri-send-verb-short', 'ri-send-vst']);
    expect(rawSignature(artist[0])).toBe(rawSignature(artistSession()[0])); // aucun renvoi provoqué
    // Réglage changé chez l'ingé → nouvelle empreinte (envoi en direct), identique → rien.
    const s1 = fxSignature(fx);
    expect(fxSignature(buildFxPayload(engineer))).toBe(s1);
    engineer.find(x => x.id === 'send-verb-short')!.plugins[0].params.decay = 3;
    expect(fxSignature(buildFxPayload(engineer))).not.toBe(s1);
  });
});

describe('file d\'attente hors ligne', () => {
  const memStore = () => { let keys: string[] = []; return { load: () => keys, save: (k: string[]) => { keys = [...k]; }, get: () => keys }; };

  it('coalesce par piste, garde ce qui échoue, survit à un rechargement, un seul passage à la fois', async () => {
    const store = memStore();
    let online = false;
    const sent: string[] = [];
    const send = vi.fn(async (kind: string, id: string) => {
      await Promise.resolve();
      if (!online) throw new Error('hors ligne');
      sent.push(`${kind}:${id}`);
    });
    const box = new RemoteOutbox(store, send);
    box.add('send', 'lead');
    box.add('send', 'lead'); // deux éditions hors ligne : une seule intention
    box.add('send', 'back');
    expect(box.size()).toBe(2);
    expect(await box.flush()).toEqual({ sent: 0, failed: 2 });
    expect(store.get()).toEqual(['send:lead', 'send:back']);
    // Rechargement de la page : la file revient.
    const box2 = new RemoteOutbox(store, send);
    expect(box2.has('send', 'lead')).toBe(true);
    online = true;
    const [a, b] = [box2.flush(), box2.flush()];
    expect(a).toBe(b);
    expect(await a).toEqual({ sent: 2, failed: 0 });
    expect(sent).toEqual(['send:lead', 'send:back']);
    expect(store.get()).toEqual([]);
  });
});

describe('état affiché chez l\'artiste', () => {
  it('Chez l\'ingé… puis Mise à jour reçue', () => {
    const t = makeTrack({ remote: { peerTrackId: 'x', sentV: 2, appliedV: 1, accepted: true } });
    expect(artistStatus(t, undefined, true).code).toBe('queued');
    expect(artistStatus(t, undefined, false)).toMatchObject({ code: 'sending' });
    expect(artistStatus(t, { v: 2, state: 'received' }, false)).toMatchObject({ code: 'at_engineer', label: "Chez l'ingé…" });
    expect(artistStatus(t, { v: 2, state: 'waiting_bridge' }, false).label).toMatch(/pont VST/);
    t.remote!.appliedV = 2;
    expect(artistStatus(t, { v: 2, state: 'received' }, false)).toMatchObject({ code: 'updated', label: 'Mise à jour reçue' });
    const first = makeTrack({ remote: { peerTrackId: 'x', sentV: 1, pending: { sig: 's' } } });
    expect(artistStatus(first, undefined, false).code).toBe('ready');
  });

  it('lien d\'invitation', () => {
    expect(parseRemoteLink('https://x/daw?inge=abcdefghijk1.ABCDEFGHJKLMNPQRSTUVWXYZ23')).toEqual({ id: 'abcdefghijk1', secret: 'ABCDEFGHJKLMNPQRSTUVWXYZ23' });
    expect(parseRemoteLink('abcdefghijk1.ABCDEFGHJKLMNPQRSTUVWXYZ23')).toEqual({ id: 'abcdefghijk1', secret: 'ABCDEFGHJKLMNPQRSTUVWXYZ23' });
    expect(parseRemoteLink('n\'importe quoi')).toBeNull();
  });
});
