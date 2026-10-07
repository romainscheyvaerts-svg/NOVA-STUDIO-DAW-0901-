// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Melodyne / VocAlign (ARA) côté NOVA : disponibilité (site, pont, plugin),
 * clip validé et retour à l'original, sauvegarde et réouverture (archive ARA
 * et prise d'origine), collaboration (le son rendu voyage), guide et clips à
 * caler pour VocAlign, fenêtre commune guide / doubles.
 */
vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { channel: () => ({}), removeChannel: async () => 'ok' } }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));

import { ProjectIO } from '../services/ProjectIO';
import { contentBufferIds, contentOf } from '../services/Collab';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { trackBufferIds } from '../utils/freeze';
import {
  AraContext, alignCandidates, alignWindow, araAvailability, araClipPatch, araPersistentId, araPluginKey, araRegion,
  araReopenInfo, araRevertPatch, araSource, archiveFor, clipInWindow, guessLeadTrack, windowRegionStart,
} from '../utils/araEdit';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

beforeEach(() => audioBufferRegistry.clear());
const has = (id: string) => audioBufferRegistry.has(id);

const SITE: AraContext = { bridgeConnected: false, bridgeAra: false, plugins: {} };
const OLD_BRIDGE: AraContext = { bridgeConnected: true, bridgeAra: false, plugins: {} };
const NO_PLUGIN: AraContext = { bridgeConnected: true, bridgeAra: true, plugins: {} };
const STUDIO: AraContext = { bridgeConnected: true, bridgeAra: true, plugins: { melodyne: { path: 'Melodyne.vst3' }, vocalign: { path: 'VocAlign6Standard.vst3' } } };

describe('disponibilité des commandes', () => {
  it('sur le site : grisé, avec la raison et la justesse NOVA en remplacement', () => {
    const m = araAvailability('melodyne', SITE);
    expect(m.enabled).toBe(false);
    expect(m.tooltip).toContain('Disponible dans Nova Studio sur PC avec Melodyne');
    expect(m.fallback).toBe('pitch-editor');
    expect(araAvailability('vocalign', SITE).fallback).toBe('nova-align');
  });
  it('pont trop ancien, plugin absent, tout est là', () => {
    expect(araAvailability('melodyne', OLD_BRIDGE).tooltip).toMatch(/Mets à jour Nova Studio/);
    expect(araAvailability('vocalign', NO_PLUGIN).tooltip).toMatch(/VocAlign n'est pas installé sur ce PC/);
    expect(araAvailability('melodyne', STUDIO).enabled).toBe(true);
    expect(araAvailability('vocalign', STUDIO).enabled).toBe(true);
  });
  it('reconnaît Melodyne et VocAlign à leur nom ou leur chemin', () => {
    expect(araPluginKey('C:\\Program Files\\Common Files\\VST3\\Celemony\\Melodyne\\Melodyne.vst3')).toBe('melodyne');
    expect(araPluginKey('VocAlign6Standard')).toBe('vocalign');
    expect(araPluginKey('FabFilter Pro-Q 4')).toBeNull();
  });
});

describe('Melodyne : valider, rouvrir, revenir', () => {
  const setup = () => {
    audioBufferRegistry.register(makeBuffer(1, 44100 * 10, 44100), 'rec-1');
    audioBufferRegistry.register(makeBuffer(1, 44100 * 3, 44100), 'mel-1');
    return makeClip({ id: 'c1', name: 'Prise 2', bufferId: 'rec-1', start: 8, offset: 2, duration: 2.5 });
  };

  it('envoie le clip (avec une marge) à sa place dans le morceau', () => {
    const clip = setup();
    const src = araSource(clip, has);
    const r = araRegion(clip, src.offset, 10);
    expect(r.start).toBeCloseTo(1.75);
    expect(r.end).toBeCloseTo(4.75);
    expect(r.songStart).toBeCloseTo(7.75);   // le son à 1,75 s joue à 7,75 s dans le morceau
  });

  it('valider : nouveau son, original + archive gardés ; rouvrir repart de l’original avec les retouches', () => {
    const clip = setup();
    const src = araSource(clip, has);
    const r = araRegion(clip, src.offset, 10);
    const pid = araPersistentId(src.bufferId, clip.id, r);
    const patch = araClipPatch(clip, { plugin: 'melodyne', mode: 'ara', newBufferId: 'mel-1', sourceBufferId: src.bufferId,
      sourceOffset: src.offset, regionStart: r.start, persistentId: pid, archive: 'QVJB', pluginName: 'Melodyne 5.4.2', at: 1 });
    expect(patch).toMatchObject({ bufferId: 'mel-1', offset: 0.25, name: 'Prise 2 (Melodyne)', warp: undefined });
    const edited = { ...clip, ...patch };
    // Réouverture : depuis l'original, même son → même identifiant → archive redonnée à Melodyne.
    const again = araSource(edited, has);
    expect(again).toEqual({ bufferId: 'rec-1', offset: 2, fromOriginal: true });
    const pid2 = araPersistentId(again.bufferId, edited.id, araRegion(edited, again.offset, 10));
    expect(pid2).toBe(pid);
    expect(archiveFor(edited, pid2)).toBe('QVJB');
    // Autre découpe → autre son : on ne réapplique pas des retouches qui ne correspondent plus.
    expect(archiveFor(edited, araPersistentId('rec-1', 'c1', { start: 0, end: 3 }))).toBeUndefined();
    // Retouches successives : le nom ne s'empile pas.
    expect(araClipPatch(edited, { plugin: 'melodyne', mode: 'ara', newBufferId: 'mel-2', sourceOffset: 2, regionStart: 1.75, persistentId: pid }).name).toBe('Prise 2 (Melodyne)');
    const rev = araRevertPatch(edited, has)!;
    expect(rev).toMatchObject({ bufferId: 'rec-1', offset: 2, name: 'Prise 2', araEdit: undefined });
  });

  it('la prise d’origine reste en mémoire (annuler, revenir) tant que le clip existe', () => {
    const t = makeTrack({ clips: [makeClip({ id: 'c', bufferId: 'mel-1', araEdit: { version: 1, plugin: 'melodyne', mode: 'ara', sourceBufferId: 'rec-1', regionStart: 0, persistentId: 'p' } })] });
    expect(trackBufferIds(t)).toEqual(expect.arrayContaining(['mel-1', 'rec-1']));
  });
});

describe('sauvegarde et collaboration', () => {
  it('aller-retour fichier projet : son rendu, prise d’origine et archive ARA', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
    audioBufferRegistry.register(makeBuffer(1, 2205, 44100), 'mel-1');
    const lead = makeTrack({ id: 'track-rec-main', name: 'Voix', clips: [makeClip({ id: 'c1', name: 'Prise 1 (Melodyne)', bufferId: 'mel-1', start: 1, offset: 0.01, duration: 0.03,
      araEdit: { version: 1, plugin: 'melodyne', mode: 'ara', sourceBufferId: 'rec-1', regionStart: 0.02, persistentId: 'nova:rec-1:0.020-0.070', archive: 'QVJBLWFyY2hpdmU=', pluginName: 'Melodyne 5.4.2' } })] });
    const blob = await ProjectIO.saveProject(makeState([lead]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const c = st.tracks[0].clips[0];
    expect(c.bufferId && audioBufferRegistry.get(c.bufferId)?.length).toBe(2205);
    expect(c.araEdit?.sourceRef).toBeUndefined();
    expect(c.araEdit?.sourceBufferId && audioBufferRegistry.get(c.araEdit.sourceBufferId)?.length).toBe(4410);
    expect(c.araEdit?.archive).toBe('QVJBLWFyY2hpdmU=');
    expect(c.araEdit?.persistentId).toBe('nova:rec-1:0.020-0.070');
    expect(araRevertPatch(c, has)).toMatchObject({ offset: 0.03, name: 'Prise 1' });
  });

  it('ancien projet (sans araEdit) : s’ouvre comme avant', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-1');
    const blob = await ProjectIO.saveProject(makeState([makeTrack({ clips: [makeClip({ id: 'c', bufferId: 'rec-1' })] })]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(st.tracks[0].clips[0].araEdit).toBeUndefined();
  });

  it('collaboration : le son rendu voyage, la retouche demande le plugin sur ce PC', () => {
    const clip = makeClip({ id: 'c1', name: 'Prise 1 (Melodyne)', bufferId: 'mel-1', start: 4, offset: 0.25, duration: 2,
      araEdit: { version: 1, plugin: 'melodyne', mode: 'ara', sourceBufferId: 'rec-1', regionStart: 1.75, persistentId: 'p', archive: 'QQ==' } });
    const t = makeTrack({ id: 'v', name: 'Voix', clips: [clip] });
    expect(contentBufferIds(t)).toEqual(['mel-1']);
    expect((contentOf(t) as any).clips[0].araEdit.archive).toBe('QQ==');
    const remoteHas = (id: string) => id === 'mel-1';
    // Chez l'autre sans Melodyne : message clair, pas de retouche.
    const noMel = araReopenInfo(clip, NO_PLUGIN, remoteHas);
    expect(noMel).toMatchObject({ canEdit: false, canRevert: false });
    expect(noMel.message).toBe("Melodyne n'est pas installé sur ce PC : le son corrigé est joué tel quel.");
    // Sur le site.
    expect(araReopenInfo(clip, SITE, remoteHas).message).toMatch(/le son corrigé est joué tel quel/);
    // Chez l'autre AVEC Melodyne mais sans la prise d'origine : retouche du son corrigé.
    const withMel = araReopenInfo(clip, STUDIO, remoteHas);
    expect(withMel.canEdit).toBe(true);
    expect(withMel.message).toMatch(/repartira du son corrigé/);
    expect(araSource(clip, remoteHas)).toEqual({ bufferId: 'mel-1', offset: 0.25, fromOriginal: false });
    expect(araRevertPatch(clip, remoteHas)).toBeNull();
  });
});

describe('VocAlign : guide et clips à caler', () => {
  const lead = makeTrack({ id: 'lead', name: 'Voix lead', clips: [makeClip({ id: 'l1', name: 'Couplet', bufferId: 'b', start: 10, duration: 8 })] });
  const back = makeTrack({ id: 'back', name: 'BACK', clips: [makeClip({ id: 'b1', name: 'Back 1', bufferId: 'b', start: 10.2, duration: 7 }), makeClip({ id: 'b2', name: 'Back refrain', bufferId: 'b', start: 30, duration: 8 })] });
  const dbl = makeTrack({ id: 'dbl', name: 'Double', clips: [makeClip({ id: 'd1', name: 'Double', bufferId: 'b', start: 9.8, duration: 8.2 })] });
  const harmo = makeTrack({ id: 'h', name: 'HARMO tierce', clips: [makeClip({ id: 'h1', name: 'Harmo', bufferId: 'b', start: 12, duration: 4 })] });
  const instru = makeTrack({ id: 'i', name: 'Instru', clips: [makeClip({ id: 'i1', name: 'Beat', bufferId: 'b', start: 0, duration: 60 })] });
  const tracks = [lead, back, dbl, harmo, instru];

  it('propose BACK / DOUBLE / HARMO de la même section, cochés ; l’instru non cochée ; pas l’autre section', () => {
    const c = alignCandidates(tracks, 'lead', 'l1');
    const ids = c.map(x => x.clipId);
    expect(ids).toEqual(expect.arrayContaining(['b1', 'd1', 'h1', 'i1']));
    expect(ids).not.toContain('b2');
    expect(c.filter(x => x.suggested).map(x => x.clipId).sort()).toEqual(['b1', 'd1', 'h1']);
    expect(c.find(x => x.clipId === 'i1')?.suggested).toBe(false);
  });

  it('depuis un double : la lead est retrouvée comme guide', () => {
    expect(guessLeadTrack(tracks, 'back')?.id).toBe('lead');
  });

  it('fenêtre commune : chaque clip à sa place, silence autour', () => {
    const sr = 100;
    const w = alignWindow([{ start: 1, duration: 1 }, { start: 1.5, duration: 1 }], 0);
    expect(w).toEqual({ start: 1, end: 2.5 });
    const src = new Float32Array(500).map((_, i) => i);
    const out = clipInWindow([src], sr, { start: 1.5, duration: 1 }, 3, w)[0];
    expect(out.length).toBe(150);
    expect(out[49]).toBe(0);          // avant le clip : silence
    expect(out[50]).toBe(300);        // 1,5 s du morceau = 3 s du son
    expect(out[149]).toBe(399);
    // Le rendu calé commence au début de la fenêtre : l'instant correspondant du son d'origine.
    expect(windowRegionStart(1.5, 3, w)).toBeCloseTo(2.5);
  });
});
