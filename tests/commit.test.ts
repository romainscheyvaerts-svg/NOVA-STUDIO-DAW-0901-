// @vitest-environment jsdom
/**
 * R6 · Commit, Consolider avec effets (bounce in place), impression de bus,
 * AudioSuite : transformations pures (une seule étape d'annulation), retour à
 * l'identique (« Restaurer la piste d'origine », « Revenir à l'original »),
 * graphe de rendu d'un bus, collaboration (le rendu part comme un clip audio).
 */
import { describe, expect, it } from 'vitest';
import { AutomationLane, Clip, PluginInstance, Track, TrackType } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';
import {
  bounceTracks, busUpstream, canCommit, canPrintBus, canRestore, CAPTURE, captureGraph, captureIds, commitTracks, printBusTracks, restoreCommitted,
} from '../utils/commit';
import {
  audioSuiteBlock, audioSuitePatch, audioSuiteRegion, audioSuiteRevertPatch, clipsForRange, patchClip,
} from '../utils/clipProcess';
import { pluginParamName } from '../utils/automationWrite';
import { PRE_VOLUME } from '../utils/preFxEdits';
import { contentBufferIds, contentOf } from '../services/Collab';
import { engineView } from '../utils/trackStructure';

const fx = (id: string, type: PluginInstance['type'] = 'COMPRESSOR', extra: Partial<PluginInstance> = {}): PluginInstance =>
  ({ id, name: id, type, isEnabled: true, latency: 0, params: { ratio: 2 }, ...extra });
const lane = (name: string): AutomationLane => ({ id: `l-${name}`, parameterName: name, points: [{ id: 'p', time: 1, value: 0.5 } as any], color: '#fff', isExpanded: false, min: 0, max: 1 });
const rendered = (id: string, start = 1): Clip => makeClip({ id, start, duration: 5, bufferId: id, name: 'rendu' });

const session = (): Track[] => [
  makeTrack({
    id: 'lead', name: 'Lead', volume: 0.7, pan: -0.3, outputTrackId: 'bus-vox', color: '#123456',
    clips: [makeClip({ id: 'c1', start: 1, duration: 2, bufferId: 'b1' }), makeClip({ id: 'c2', start: 4, duration: 2, bufferId: 'b2' })],
    plugins: [fx('eq', 'PROEQ12'), fx('comp'), fx('verb', 'REVERB')],
    sends: [{ id: 'send-verb-short', level: 0.2, isEnabled: true, preFader: true }],
    automationLanes: [lane('volume'), lane('pan'), lane(PRE_VOLUME), lane(pluginParamName('comp', 'threshold')), lane(pluginParamName('verb', 'mix'))],
    collabOwner: 'artist', collabOwnerKey: 'u:a',
  }),
  makeTrack({ id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, sends: [], plugins: [fx('bus-comp')], volume: 0.9, pan: 0.1 }),
  makeTrack({ id: 'send-verb-short', name: 'Reverb courte', type: TrackType.SEND, sends: [], plugins: [fx('rv', 'REVERB')] }),
  makeTrack({ id: 'beat', name: 'Beat', sends: [], clips: [makeClip({ id: 'k', bufferId: 'bk', duration: 8 })] }),
  makeTrack({ id: 'master', name: 'MASTER BUS', type: TrackType.BUS, outputTrackId: '', sends: [] }),
];

describe('Commit', () => {
  it('la piste rendue remplace l’originale (inactive et masquée), même mix ; restaurer redonne la session à l’identique', () => {
    const before = session();
    const after = commitTracks(before, 'lead', { id: 'lead-cm', clip: rendered('r1'), upTo: 2, tail: 3, at: 1 });
    expect(after.map(t => t.id)).toEqual(['lead', 'lead-cm', 'bus-vox', 'send-verb-short', 'beat', 'master']);
    const src = after[0], cm = after[1];
    expect([src.isInactive, src.isHidden]).toEqual([true, true]);
    expect(src.clips).toEqual(before[0].clips); // rien de perdu
    expect(cm.type).toBe(TrackType.AUDIO);
    expect(cm.clips).toEqual([rendered('r1')]);
    expect(cm.plugins).toEqual([]);
    expect([cm.volume, cm.pan, cm.outputTrackId, cm.color]).toEqual([0.7, -0.3, 'bus-vox', '#123456']);
    expect(cm.sends).toEqual(before[0].sends);
    // Volume / pan gardés ; volume avant effets et automation des effets rendus : dans le son.
    expect(cm.automationLanes.map(l => l.parameterName)).toEqual(['volume', 'pan']);
    expect(cm.collabOwner).toBeUndefined(); // la nouvelle piste appartient à qui l'a créée
    expect(cm.commit).toMatchObject({ kind: 'commit', sourceTrackId: 'lead', upTo: 2, tail: 3, sourceWasHidden: false, sourceWasInactive: false });
    // Le moteur ne joue plus l'originale.
    expect(engineView(after).excluded.has('lead')).toBe(true);
    expect(canRestore(cm, after)).toBe(true);
    const r = restoreCommitted(after, 'lead-cm');
    expect(r.tracks).toEqual(before);
    expect(r.bufferIds).toEqual(['r1']);
  });

  it('« jusqu’à l’effet n » : les effets suivants restent actifs (nouveaux ids) et leur automation suit', () => {
    const after = commitTracks(session(), 'lead', { id: 'cm', clip: rendered('r'), upTo: 1, tail: 0 });
    const cm = after.find(t => t.id === 'cm')!;
    expect(cm.plugins.map(p => p.type)).toEqual(['REVERB']);
    expect(cm.plugins[0].id).not.toBe('verb');
    expect(cm.automationLanes.map(l => l.parameterName)).toEqual(['volume', 'pan', pluginParamName(cm.plugins[0].id, 'mix')]);
  });

  it('une piste déjà masquée le reste après restauration ; bus, master et dossiers ne se « commitent » pas', () => {
    const before = session().map(t => (t.id === 'lead' ? { ...t, isHidden: true } : t));
    const back = restoreCommitted(commitTracks(before, 'lead', { id: 'cm', clip: rendered('r'), upTo: 2, tail: 0 }), 'cm').tracks;
    expect(back.find(t => t.id === 'lead')!.isHidden).toBe(true);
    expect(back.find(t => t.id === 'lead')!.isInactive).toBeUndefined();
    expect(canCommit(before.find(t => t.id === 'bus-vox'))).toBe(false);
    expect(canCommit(before.find(t => t.id === 'master'))).toBe(false);
    expect(() => commitTracks(before, 'bus-vox', { id: 'x', clip: rendered('r'), upTo: 0, tail: 0 })).toThrow(/Imprimer le bus/);
  });
});

describe('Consolider avec effets (bounce in place)', () => {
  it('nouvelle piste avec la plage rendue ; clips d’origine coupés aux bords et muets dedans ; restaurer les rallume', () => {
    const before = session();
    const after = bounceTracks(before, 'lead', { id: 'bn', clip: rendered('rb', 1.5), upTo: 2, tail: 2, range: { start: 1.5, end: 5 } });
    const src = after.find(t => t.id === 'lead')!;
    const audible = src.clips.filter(c => !c.isMuted).map(c => [c.start, c.duration]);
    // Restent audibles : 1 → 1,5 (début de c1) et 5 → 6 (fin de c2).
    expect(audible).toEqual([[1, 0.5], [5, 1]]);
    const bn = after.find(t => t.id === 'bn')!;
    expect(bn.commit).toMatchObject({ kind: 'bounce', range: { start: 1.5, end: 5 } });
    expect(bn.commit!.mutedClipIds!.length).toBe(2);
    expect(src.isInactive).toBeUndefined(); // la piste continue de jouer hors de la plage
    const back = restoreCommitted(after, 'bn').tracks.find(t => t.id === 'lead')!;
    expect(back.clips.every(c => !c.isMuted)).toBe(true);
    // Même son qu'avant : mêmes morceaux de mêmes fichiers, bout à bout.
    const cover = (cs: Clip[]) => cs.filter(c => !c.isMuted).map(c => [c.bufferId, +(c.start - (c.offset || 0)).toFixed(6)]).sort().map(x => x.join('@'));
    expect(new Set(cover(back.clips))).toEqual(new Set(cover(before[0].clips)));
  });
});

describe('Impression de bus', () => {
  it('nouvelle piste à 0 dB au centre, qui sort où sortait le bus ; le bus est coupé ; restaurer le rallume', () => {
    const before = session();
    const after = printBusTracks(before, 'bus-vox', { id: 'pr', clip: rendered('rp', 0), tail: 3, muteBus: true });
    const pr = after.find(t => t.id === 'pr')!;
    expect(after.map(t => t.id).slice(1, 3)).toEqual(['bus-vox', 'pr']);
    expect([pr.volume, pr.pan, pr.outputTrackId, pr.plugins.length, pr.isMuted]).toEqual([1, 0, 'master', 0, false]);
    expect(after.find(t => t.id === 'bus-vox')!.isMuted).toBe(true);
    expect(canPrintBus(before.find(t => t.id === 'bus-vox'))).toBe(true);
    expect(canPrintBus(before.find(t => t.id === 'lead'))).toBe(false);
    expect(restoreCommitted(after, 'pr').tracks).toEqual(before);
  });

  it('graphe de capture d’un bus : ce qui y entre joue, l’aval reste (latence) mais muet ; solo résolu', () => {
    const tr = session().map(t => (t.id === 'beat' ? { ...t, sends: [{ id: 'send-verb-short', level: 0.5, isEnabled: true }] } : t));
    expect([...busUpstream(tr, 'send-verb-short')].sort()).toEqual(['beat', 'lead']);
    expect([...busUpstream(tr, 'bus-vox')]).toEqual(['lead']);
    expect([...captureIds(tr, 'send-verb-short', 'post')].sort()).toEqual(['beat', 'bus-vox', 'lead', 'master', 'send-verb-short']);
    const g = captureGraph(tr, 'send-verb-short', 'post', new Set(['beat']));
    expect(g.map(t => t.id)).toEqual(['lead', 'bus-vox', 'send-verb-short', 'beat', 'master', CAPTURE]);
    const bus = g.find(t => t.id === 'send-verb-short')!;
    expect(bus.sends.at(-1)).toEqual({ id: CAPTURE, level: 1, isEnabled: true }); // après le fader
    expect(g.find(t => t.id === 'beat')!.isMuted).toBe(true); // coupé par un solo ailleurs
    expect(g.find(t => t.id === 'lead')!.isMuted).toBe(false);
    expect(['bus-vox', 'master'].map(id => g.find(t => t.id === id)!.isMuted)).toEqual([true, true]); // aval : muet
    expect(g.find(t => t.id === CAPTURE)!.outputTrackId).toBe('');
  });

  it('graphe de capture d’un commit : la piste avant son fader ; ses bus et retours restent muets', () => {
    const g = captureGraph(session(), 'lead', 'pre', new Set());
    expect(g.map(t => t.id)).toEqual(['lead', 'bus-vox', 'send-verb-short', 'master', CAPTURE]);
    expect(g[0].sends.at(-1)).toEqual({ id: CAPTURE, level: 1, isEnabled: true, preFader: true });
    expect(g.filter(t => t.id !== 'lead' && t.id !== CAPTURE).every(t => t.isMuted)).toBe(true);
  });
});

describe('AudioSuite', () => {
  const clip = makeClip({ id: 'v', start: 10, duration: 2, offset: 3.25, bufferId: 'orig', name: 'Prise 3' });

  it('poignées bornées au son disponible', () => {
    expect(audioSuiteRegion(clip, 30, 1)).toEqual({ from: 2.25, to: 6.25, lead: 1 });
    expect(audioSuiteRegion({ offset: 0.4, duration: 2 }, 2.5, 1)).toEqual({ from: 0, to: 2.5, lead: 0.4 });
  });

  it('traiter puis « Revenir à l’original » redonne le clip exact (même son, même place)', () => {
    const p1 = audioSuitePatch(clip, { newBufferId: 'p1', from: 2.25, step: { type: 'COMPRESSOR', name: 'Compresseur', at: 1 } });
    const c1 = patchClip(clip, p1);
    expect([c1.bufferId, c1.offset, c1.start, c1.duration]).toEqual(['p1', 1, 10, 2]);
    expect(c1.name).toBe('Prise 3 (AudioSuite : Compresseur)');
    expect(c1.audioSuite).toMatchObject({ sourceBufferId: 'orig', regionStart: 2.25 });
    // Deuxième traitement empilé.
    const c2 = patchClip(c1, audioSuitePatch(c1, { newBufferId: 'p2', from: 0.1, step: { type: 'REVERB', name: 'Réverbe', at: 2 } }));
    expect(c2.name).toBe('Prise 3 (AudioSuite : Compresseur + Réverbe)');
    expect(c2.audioSuite!.steps.map(s => s.name)).toEqual(['Compresseur', 'Réverbe']);
    const back = patchClip(c2, audioSuiteRevertPatch(c2, () => true)!);
    expect(back).toEqual(clip);
    // Prise d'origine absente (projet reçu en collaboration) : pas de retour possible.
    expect(audioSuiteRevertPatch(c2, () => false)).toBeNull();
  });

  it('clip recoupé après traitement : le retour suit la nouvelle découpe', () => {
    const c1 = patchClip(clip, audioSuitePatch(clip, { newBufferId: 'p1', from: 2.25, step: { type: 'DEESSER', name: 'De-esser', at: 1 } }));
    const trimmed = { ...c1, start: 10.5, offset: c1.offset + 0.5, duration: 1.5 };
    const back = patchClip(trimmed, audioSuiteRevertPatch(trimmed, () => true)!);
    expect([back.bufferId, back.start, back.offset, back.duration]).toEqual(['orig', 10.5, 3.75, 1.5]);
  });

  it('plage : les clips sont coupés aux bords, seuls ceux du dedans sont traités', () => {
    const cs = [makeClip({ id: 'a', start: 0, duration: 4, bufferId: 'x' }), makeClip({ id: 'm', start: 5, duration: 1, notes: [] as any, type: TrackType.MIDI })];
    const r = clipsForRange(cs, 1, 3);
    expect(r.clips.filter(c => r.targetIds.includes(c.id)).map(c => [c.start, c.duration])).toEqual([[1, 2]]);
    expect(r.clips.length).toBe(4);
  });

  it('refus clairs : MIDI, inversé, warp, retouche de justesse', () => {
    expect(audioSuiteBlock(makeClip({ type: TrackType.MIDI, notes: [] }))).toMatch(/MIDI/);
    expect(audioSuiteBlock(makeClip({ bufferId: 'x', isReversed: true }))).toMatch(/inversé/);
    expect(audioSuiteBlock(makeClip({ bufferId: 'x', warp: { mode: 'BEATS' } as any }))).toMatch(/warp/);
    expect(audioSuiteBlock(makeClip({ bufferId: 'x', pitchEdit: { version: 1, regionStart: 0, edits: [] } }))).toMatch(/justesse/);
    expect(audioSuiteBlock(makeClip({ bufferId: 'x' }))).toBeNull();
  });
});

describe('Collaboration : le rendu part comme un clip audio normal', () => {
  it('piste commitée : un clip audio dont le son est envoyé ; clip traité : son nouveau son est envoyé', () => {
    const after = commitTracks(session(), 'lead', { id: 'cm', clip: rendered('r9'), upTo: 2, tail: 0 });
    const cm = after.find(t => t.id === 'cm')!;
    expect(contentBufferIds(cm)).toEqual(['r9']);
    expect(contentOf(cm).clips[0]).toMatchObject({ bufferId: 'r9', type: TrackType.AUDIO });
    const t = makeTrack({ clips: [patchClip(makeClip({ id: 'v', bufferId: 'orig' }), audioSuitePatch(makeClip({ id: 'v', bufferId: 'orig' }), { newBufferId: 'p1', from: 0, step: { type: 'REVERB', name: 'R', at: 0 } }))] });
    expect(contentBufferIds(t)).toEqual(['p1']);
  });
});
