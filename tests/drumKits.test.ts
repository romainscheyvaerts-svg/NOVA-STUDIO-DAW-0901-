// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { bakeRefusal, canBakeTrack } from '../utils/freeze';
import { makeDrumMachine } from '../utils/drumKits';
import type { DrumMachine } from '../utils/drumKits';
import {
  applyKitDef, KIT_BAKE_REFUSAL, kitFetchCount, KitIndex, kitRef, KitSoundError, loadKitSound, parseKitIndex,
  setKitIndexForTests, setPadKitSound, usesKitSounds,
} from '../utils/drumKitLibrary';
import { kitFromDrumMachine } from '../utils/userKits';
import { contentBufferIds } from '../services/Collab';
import { planNovaExport } from '../utils/aaf/novaToAaf';
import { exportKeyOf, mixNeedsTag } from '../utils/exportRights';
import { normalizeSampler, DEFAULT_SAMPLER, samplerBufferKey } from '../utils/melodicSampler';
import { DAWState, TrackType } from '../types';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100), auditionBuffers: () => {}, stopAudition: () => {} } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const ROOT = join(__dirname, '..');
const ix: KitIndex = parseKitIndex(JSON.parse(readFileSync(join(ROOT, 'data', 'drum-kits', 'index.json'), 'utf-8')));
const kick = ix.sounds.find(s => s.cat === 'kick')!;
const b808 = ix.sounds.find(s => s.cat === '808' && s.midi)!;
const trap = ix.kits.find(k => k.style === 'trap')!;

/** Projet « instru sur mélodie » : mélodie du catalogue + batterie en sons de kits + sampler 808 de kit. */
function melodyProject(owned = false): DAWState {
  audioBufferRegistry.register(makeBuffer(2, 4410, 44100), 'beat-buf');
  audioBufferRegistry.register(makeBuffer(1, 4410, 44100), samplerBufferKey('s808'));
  const dm = applyKitDef(makeDrumMachine('empty'), trap, ix);
  dm.rows[0].steps[0] = 110;
  const melody = makeTrack({ id: 'instrumental', name: 'MÉLODIE', instrumentId: 'mel-1', clips: [makeClip({ id: 'm', bufferId: 'beat-buf', duration: 0.1 })] });
  const drums = makeTrack({ id: 'track-drums', name: 'PERCUSSIONS', type: TrackType.DRUM_RACK, drumMachine: dm, clips: [makeClip({ id: 'd', type: TrackType.DRUM_RACK, notes: [] as any, duration: 2 })] });
  const sampler = makeTrack({
    id: 'smp', name: 'Sampler 808', type: TrackType.MIDI,
    melodicSampler: normalizeSampler({ ...DEFAULT_SAMPLER, sampleId: 's808', kitRef: kitRef(b808.id), kitRoot: 9 }),
  });
  return makeState([melody, drums, sampler], { id: 'proj-1', exportKey: owned ? 'exp-paid' : undefined });
}

beforeEach(() => { audioBufferRegistry.clear(); setKitIndexForTests(ix); });

describe('Kits → pads', () => {
  it('« Charger ce kit » : sons « kit:… », noms génériques, pas gardés, pads perso conservés', () => {
    let dm: DrumMachine = makeDrumMachine('empty');
    dm = { ...dm, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, steps: r.steps.map((_, i) => (i % 4 === 0 ? 100 : 0)) } : r)) };
    dm.rows.push({ id: 'pad9', name: 'Ma voix', sound: 'user:s1', steps: new Array(16).fill(0), ratchet: new Array(16).fill(1), volume: 1, pan: 0 });
    dm.samples = { s1: { name: 'Ma voix', duration: 1 } };
    const out = applyKitDef(dm, trap, ix);
    expect(out.kitId).toBe(`nova:${trap.id}`);
    const k = out.rows.find(r => r.id === 'kick')!;
    expect(k.sound).toBe(kitRef(trap.pads.kick!));
    expect(k.steps.filter(v => v > 0).length).toBe(4);
    expect(k.name).toMatch(/^Kick \d+$/);
    expect(out.rows.find(r => r.id === 'k808')?.sound).toBe(kitRef(trap.pads['808']!));
    expect(out.rows.some(r => r.id === 'pad9')).toBe(true);
    expect(out.samples).toEqual({ s1: { name: 'Ma voix', duration: 1 } });
  });
  it('« Poser » un son : sur un pad (il remplace le sample perso) ou sur un nouveau pad', () => {
    const dm = makeDrumMachine('empty');
    const a = setPadKitSound(dm, kick.id, 1, ix)!;
    expect(a.dm.rows[1]).toMatchObject({ sound: kitRef(kick.id), name: kick.name });
    const b = setPadKitSound(dm, kick.id, null, ix)!;
    expect(b.rowIndex).toBe(dm.rows.length);
    expect(b.dm.rows.at(-1)!.steps.length).toBe(16);
  });
});

describe('Sons des kits : jamais un fichier audio séparé', () => {
  it('sauvegarde .zip : le motif et les références, AUCUN audio de kit (ni pad, ni sampler)', async () => {
    const st = melodyProject(true);
    const zip = await JSZip.loadAsync(await ProjectIO.saveProject(st, ['mel-1']));
    const audio = Object.keys(zip.files).filter(f => f.startsWith('audio/') && !zip.files[f].dir);
    expect(audio).toEqual(['audio/beat-buf.wav']); // la mélodie achetée seulement
    const json = JSON.parse(await zip.file('project.json')!.async('string'));
    const drums = json.tracks.find((t: any) => t.id === 'track-drums');
    expect(drums.drumMachine.rows.map((r: any) => r.sound).filter((s: string) => s.startsWith('kit:')).length).toBeGreaterThan(8);
    const smp = json.tracks.find((t: any) => t.id === 'smp');
    expect(smp.melodicSampler.kitRef).toBe(kitRef(b808.id));
    expect(smp.melodicSampler.audioRef).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/data:audio|base64/);
  });
  it('kit perso .novakit : les sons de kit restent des références (aucun WAV)', () => {
    const st = melodyProject();
    const kit = kitFromDrumMachine(st.tracks[1].drumMachine!, 'Mon kit', () => new ArrayBuffer(8));
    expect(kit.samples).toEqual({});
    expect(kit.pads.some(p => p.sound.startsWith('kit:'))).toBe(true);
  });
  it('collaboration / cloud : aucun son de kit envoyé (l’autre poste charge sa propre bibliothèque)', () => {
    const st = melodyProject();
    expect(contentBufferIds(st.tracks[1])).toEqual([]);
    expect(contentBufferIds(st.tracks[2])).not.toContain(samplerBufferKey('s808'));
  });
  it('gel, commit, impression, rendu : refusés pour une piste qui joue des sons de kits', () => {
    const st = melodyProject();
    expect(usesKitSounds(st.tracks[1])).toBe(true);
    expect(usesKitSounds(st.tracks[2])).toBe(true);
    expect(canBakeTrack(st.tracks[1])).toBe(false);
    expect(canBakeTrack(st.tracks[2])).toBe(false);
    expect(bakeRefusal(st.tracks[1])).toBe(KIT_BAKE_REFUSAL);
    expect(canBakeTrack(makeTrack({ id: 'v', name: 'Voix' }))).toBe(true);
  });
  it('AAF (BWF) : batterie de kits et mélodie sans licence jamais exportées ; admin : mélodie OK', () => {
    const st = melodyProject();
    st.tracks[1].frozenClip = makeClip({ id: 'fz', bufferId: 'beat-buf', duration: 0.1 }) as any; // ancien rendu gelé
    const get = (id: string) => { const b = audioBufferRegistry.get(id); return b ? { channels: [b.getChannelData(0)], sampleRate: b.sampleRate } : null; };
    const plan = planNovaExport(st, get, { embed: false, trackVolumePan: true, owned: [] });
    expect(plan.input.tracks.length).toBe(0);
    expect(plan.skipped.join('\n')).toMatch(/kits NOVA/);
    expect(plan.skipped.join('\n')).toMatch(/sans licence/);
    const admin = planNovaExport(st, get, { embed: false, trackVolumePan: true, owned: 'all' });
    expect(admin.input.tracks.map(t => t.name)).toEqual(['MÉLODIE']);
  });
});

describe('Version envoyée en collaboration (mix complet)', () => {
  const checks = (admin: boolean, paid: boolean) => ({ isAdmin: async () => admin, isExportPaid: async () => paid });
  it('mélodie non achetée : tag sonore ; admin : propre', async () => {
    const st = melodyProject();
    expect(await mixNeedsTag(st, [], checks(false, true))).toBe(true);
    expect(await mixNeedsTag(st, [], checks(true, false))).toBe(false);
  });
  it('sons de kits sans instru du catalogue : tag tant que l’export n’est pas payé', async () => {
    const st = melodyProject();
    st.tracks = st.tracks.filter(t => t.id !== 'instrumental');
    st.exportKey = 'exp-abc123';
    expect(await mixNeedsTag(st, [], checks(false, false))).toBe(true);
    expect(await mixNeedsTag(st, [], checks(false, true))).toBe(false);
  });
  it('clé d’export : jamais l’id partagé « proj-1 »', () => {
    expect(exportKeyOf({ id: 'proj-1' })).toBe('');
    expect(exportKeyOf({ id: 'proj-1', exportKey: 'exp-1' })).toBe('exp-1');
    expect(exportKeyOf({ id: 'cloud-42' })).toBe('cloud-42');
  });
});

describe('Chargement à la demande', () => {
  const nks = readFileSync(join(ROOT, 'public', 'drums', 'kits', `${kick.id}.nks`));
  it('rien n’est téléchargé à l’ouverture ; un son = un téléchargement, puis le cache', async () => {
    const before = kitFetchCount();
    const fetchMock = vi.fn(async () => new Response(nks, { headers: { 'Content-Type': 'application/octet-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = { sampleRate: 44100, decodeAudioData: vi.fn(async (ab: ArrayBuffer) => {
      // Le DAW ne voit le FLAC qu'en mémoire, juste avant le décodage.
      expect(String.fromCharCode(...new Uint8Array(ab, 0, 4))).toBe('fLaC');
      return makeBuffer(1, 441, 44100);
    }) } as unknown as BaseAudioContext;
    const a = await loadKitSound(kitRef(kick.id), ctx, 0);
    const b = await loadKitSound(kitRef(kick.id), ctx, 3);
    expect(a).toBe(b); // un kick ne dépend pas de la tonique
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/drums/kits/${kick.id}.nks`);
    expect(kitFetchCount() - before).toBe(1);
    vi.unstubAllGlobals();
  });
  it('erreurs actionnables : hors ligne, son introuvable (page HTML à la place)', async () => {
    const ctx = { sampleRate: 48000, decodeAudioData: async () => makeBuffer(1, 10, 48000) } as unknown as BaseAudioContext;
    const other = ix.sounds.filter(s => s.cat === 'snare');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(loadKitSound(kitRef(other[0].id), ctx)).rejects.toMatchObject({ code: 'offline' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })));
    const e = await loadKitSound(kitRef(other[1].id), ctx).catch(x => x);
    expect(e).toBeInstanceOf(KitSoundError);
    expect(e.code).toBe('missing');
    expect(e.message).toMatch(/Recharge NOVA/);
    vi.unstubAllGlobals();
  });
});

describe('Navigateur de kits : aucun téléchargement de son brut', () => {
  it('ni bouton, ni lien « télécharger », ni <a download>, ni <audio>', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { default: DrumKitBrowser } = await import('../components/DrumKitBrowser');
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const h = React.createElement;
    const props = { dm: makeDrumMachine('empty'), targetPad: null, onTargetPad: () => {}, bpm: 140, projectKey: 9, onApplyKit: () => {}, onPickSound: () => {}, onClose: () => {}, narrow: false };
    await act(async () => { root.render(h(DrumKitBrowser, props)); });
    await act(async () => { await Promise.resolve(); });
    const check = () => {
      expect(el.querySelector('[data-testid="kit-browser"]')).not.toBeNull();
      expect(el.querySelectorAll('a[download], audio, video').length).toBe(0);
      expect(el.textContent || '').not.toMatch(/t[ée]l[ée]charg|download|enregistrer sous/i);
      el.querySelectorAll('[aria-label],[title]').forEach(n => expect(`${n.getAttribute('aria-label')} ${n.getAttribute('title')}`).not.toMatch(/t[ée]l[ée]charg|download/i));
    };
    expect(el.querySelectorAll('[data-testid="kit-card"]').length).toBe(ix.kits.length);
    check();
    await act(async () => { (el.querySelector('[data-testid="kit-tab-sons"]') as HTMLButtonElement).click(); });
    expect(el.querySelectorAll('[data-testid="kit-sound"]').length).toBe(60);
    check();
    await act(async () => { root.unmount(); });
  });
});
