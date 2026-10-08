// @vitest-environment jsdom
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ProjectIO } from '../services/ProjectIO';
import { wavOf } from '../services/AudioUtils';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { repairProject, salvageJson } from '../utils/projectRepair';
import { makeBuffer } from './helpers/audio';

/**
 * Projets abîmés : JSON tronqué (coupure pendant l'écriture), sons manquants ou
 * corrompus, identifiants en double, valeurs absurdes, références cassées.
 * Chaque projet doit s'ouvrir (sauf s'il n'y a VRAIMENT rien à récupérer),
 * avec un rapport clair et un état cohérent.
 */

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const summary: { cas: string; ouvert: boolean; erreur?: string; pistes?: number; clips?: number; horsLigne?: number; rapport: string[] }[] = [];

const wav = () => wavOf(makeBuffer(1, 4410, 44100));
const clip = (id: string, ref: string, start = 0, extra: Record<string, unknown> = {}) =>
  ({ id, name: `Clip ${id}`, start, duration: 0.1, offset: 0, fadeIn: 0, fadeOut: 0, color: '#f00', type: 'AUDIO', audioRef: ref, ...extra });
const track = (id: string, clips: any[], extra: Record<string, unknown> = {}) =>
  ({ id, name: id.toUpperCase(), type: 'AUDIO', color: '#0f0', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
     volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0, ...extra });
const fx = (id: string | undefined, type = 'COMPRESSOR') => ({ ...(id ? { id } : {}), name: type, type, isEnabled: true, params: { a: 1 }, latency: 0 });

/** Projet de référence (voix, chœurs, bus, master) avec 3 sons. */
function baseProject() {
  return {
    id: 'p1', name: 'Session', bpm: 92, timeSignature: { numerator: 4, denominator: 4 }, markers: [{ id: 'm1', name: 'Couplet', time: 4, type: 'MARKER', color: '#fff' }],
    tracks: [
      track('voix', [clip('c1', 'audio/a.wav', 1), clip('c2', 'audio/b.wav', 2)], {
        plugins: [fx('eq', 'PROEQ12'), fx('comp')], sends: [{ id: 'verb', level: 0.4, isEnabled: true }], outputTrackId: 'bus',
        automationLanes: [{ id: 'l1', parameterName: 'volume', color: '#0f0', isExpanded: false, min: 0, max: 1.5, points: [{ id: 'p1', time: 0, value: 1 }, { id: 'p2', time: 3, value: 0.5 }] }],
      }),
      track('choeurs', [clip('c3', 'audio/c.wav', 0.5)], { outputTrackId: 'bus' }),
      track('bus', [], { type: 'BUS' }),
      track('verb', [], { type: 'SEND', plugins: [fx('rv', 'REVERB')] }),
      track('master', [], { type: 'BUS', outputTrackId: '' }),
    ],
  };
}

async function zipOf(files: Record<string, string | Blob | Uint8Array>): Promise<Blob> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v as any);
  return z.generateAsync({ type: 'blob' });
}
const sounds = () => ({ 'audio/a.wav': wav(), 'audio/b.wav': wav(), 'audio/c.wav': wav() });
const open = (b: Blob) => ProjectIO.loadProject(new File([b], 'projet.novaproj.zip'));

/** Invariants d'un projet ouvert : ids uniques, références valides, nombres finis. */
function expectCoherent(st: any) {
  const ids = st.tracks.map((t: any) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  const clipIds = st.tracks.flatMap((t: any) => t.clips.map((c: any) => c.id));
  expect(new Set(clipIds).size).toBe(clipIds.length);
  const valid = new Set([...ids, 'master', '', '__nova_void__']);
  for (const t of st.tracks) {
    expect(valid.has(t.outputTrackId)).toBe(true);
    expect(Number.isFinite(t.volume) && Number.isFinite(t.pan)).toBe(true);
    for (const s of t.sends) expect(ids.includes(s.id)).toBe(true);
    const pids = t.plugins.map((p: any) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    for (const p of t.plugins) expect(typeof p.type).toBe('string');
    for (const c of t.clips) {
      for (const f of ['start', 'duration', 'offset', 'fadeIn', 'fadeOut']) expect(Number.isFinite(c[f])).toBe(true);
      expect(c.duration).toBeGreaterThan(0);
      // Un clip audio a son son, ou il est marqué hors ligne / licence.
      if (c.type === 'AUDIO' && !c.notes) expect(!!c.bufferId || c.isOffline || c.isUnlicensed).toBe(true);
    }
    for (const l of t.automationLanes) {
      const times = l.points.map((p: any) => p.time);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      for (const p of l.points) expect(Number.isFinite(p.time) && Number.isFinite(p.value)).toBe(true);
    }
  }
}

async function record(cas: string, b: Blob) {
  try {
    const st: any = await open(b);
    const rapport = ProjectIO.repairReportOf(st) || [];
    summary.push({
      cas, ouvert: true, pistes: st.tracks.length, clips: st.tracks.reduce((n: number, t: any) => n + t.clips.length, 0),
      horsLigne: st.tracks.reduce((n: number, t: any) => n + t.clips.filter((c: any) => c.isOffline).length, 0), rapport,
    });
    return { st, rapport };
  } catch (e: any) {
    summary.push({ cas, ouvert: false, erreur: e?.message, rapport: [] });
    throw e;
  }
}

beforeEach(() => audioBufferRegistry.clear());

afterAll(async () => {
  const out = process.env.NOVA_STAB_OUT;
  if (!out) return;
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'reparation_projets.json'), JSON.stringify({ date: new Date().toISOString(), cas: summary }, null, 1), 'utf-8');
});

describe('salvageJson : JSON tronqué', () => {
  const full = JSON.stringify(baseProject());

  it('JSON intact : lu tel quel', () => {
    expect(salvageJson(full)).toEqual({ value: baseProject(), truncated: false });
  });

  it('coupé au milieu d\'une chaîne : les valeurs complètes d\'avant sont gardées', () => {
    const at = full.indexOf('Clip c2') + 3;
    const r = salvageJson(full.slice(0, at));
    expect(r.truncated).toBe(true);
    expect(r.value.tracks[0].clips[0]).toMatchObject({ id: 'c1', duration: 0.1 });
    expect(r.value.tracks[0].clips[1].id).toBe('c2');
    expect(r.value.tracks[0].clips[1].name).toBeUndefined();
  });

  it('coupé au milieu d\'un nombre : le nombre partiel n\'est pas pris', () => {
    const at = full.indexOf('"bpm":92') + '"bpm":9'.length;
    const r = salvageJson(full.slice(0, at));
    expect(r.value.bpm).toBeUndefined();
    expect(r.value.name).toBe('Session');
  });

  it('coupé dans le tableau des clips, après une virgule ou une clé', () => {
    for (const cut of [full.indexOf('{"id":"c2"'), full.indexOf('"start":2') + 8]) {
      const r = salvageJson(full.slice(0, cut));
      expect(r.value.tracks[0].clips[0].id).toBe('c1');
    }
  });

  it('jamais d\'exception, quelle que soit la coupe', () => {
    for (let i = 0; i <= full.length; i += 3) {
      const r = salvageJson(full.slice(0, i));
      expect(r.truncated || i === full.length).toBe(true);
      if (r.value !== null) expect(typeof r.value).toBe('object');
    }
    expect(salvageJson('').value).toBeNull();
    expect(salvageJson('n\'importe quoi').value).toBeNull();
  });

  it('échappements dans les chaînes (guillemets, barres obliques inverses)', () => {
    const s = JSON.stringify({ a: 'il a dit "yo" \\ ok', b: [1, 2] });
    expect(salvageJson(s.slice(0, s.indexOf('[') + 3)).value).toEqual({ a: 'il a dit "yo" \\ ok', b: [1] });
  });
});

describe('ProjectIO.loadProject : projets abîmés', () => {
  it('JSON tronqué au milieu d\'une chaîne : projet ouvert, clip coupé gardé hors ligne, rapport', async () => {
    const full = JSON.stringify(baseProject());
    const at = full.indexOf('audio/c.wav') + 4;
    const { st, rapport } = await record('JSON tronqué au milieu d\'une chaîne', await zipOf({ 'project.json': full.slice(0, at), ...sounds() }));
    expectCoherent(st);
    expect(st.tracks.map((t: any) => t.id)).toEqual(['voix', 'choeurs']);
    expect(st.tracks[0].clips.map((c: any) => c.id)).toEqual(['c1', 'c2']);
    expect(st.tracks[0].clips.every((c: any) => c.bufferId)).toBe(true);
    expect(st.tracks[0].plugins.map((p: any) => p.id)).toEqual(['eq', 'comp']);
    expect(rapport[0]).toMatch(/incomplet/);
    // Le clip c3 a été coupé avant sa référence de son : gardé à sa place, hors ligne.
    expect(st.tracks[1].clips[0]).toMatchObject({ id: 'c3', start: 0.5, isOffline: true });
    expect(rapport.join('\n')).toMatch(/1 clip dont le son est introuvable : gardé hors ligne \(muet\) \(« CHOEURS »\)/);
    // Sorties vers le bus disparu dans la coupe : vers le master ; envoi vers « verb » retiré.
    expect(st.tracks[0].outputTrackId).toBe('master');
    expect(rapport.join('\n')).toMatch(/sorties vers des pistes absentes redirigées/);
  });

  it('JSON tronqué au milieu du tableau des clips et au milieu d\'un nombre', async () => {
    const full = JSON.stringify(baseProject());
    for (const [cas, cut] of [
      ['JSON tronqué dans le tableau des clips', full.indexOf('{"id":"c2"') + 5],
      ['JSON tronqué au milieu d\'un nombre', full.indexOf('"start":0.5') + 9],
    ] as const) {
      audioBufferRegistry.clear();
      const { st, rapport } = await record(cas, await zipOf({ 'project.json': full.slice(0, cut), ...sounds() }));
      expectCoherent(st);
      expect(st.tracks[0].clips[0]).toMatchObject({ id: 'c1', start: 1 });
      expect(rapport.length).toBeGreaterThan(0);
    }
  });

  it('coupe à n\'importe quel endroit (balayage) : le projet s\'ouvre toujours, cohérent', async () => {
    const full = JSON.stringify(baseProject());
    let opened = 0;
    for (let i = 0; i < full.length; i += 23) {
      audioBufferRegistry.clear();
      const st: any = await open(await zipOf({ 'project.json': full.slice(0, i), ...sounds() }));
      expectCoherent(st);
      opened++;
    }
    summary.push({ cas: `Balayage : JSON coupé à ${opened} endroits différents`, ouvert: true, rapport: [`${opened} / ${opened} ouverts, tous cohérents`] });
    expect(opened).toBeGreaterThan(20);
  });

  it('son manquant dans l\'archive : clip gardé hors ligne (nom intact), le reste joue', async () => {
    const files: any = { 'project.json': JSON.stringify(baseProject()), ...sounds() };
    delete files['audio/b.wav'];
    const { st, rapport } = await record('Son (WAV) manquant', await zipOf(files));
    expectCoherent(st);
    const c2 = st.tracks[0].clips[1];
    expect(c2).toMatchObject({ id: 'c2', name: 'Clip c2', isOffline: true });
    expect(c2.bufferId).toBeUndefined();
    expect(st.tracks[0].clips[0].bufferId).toBeTruthy();
    expect(rapport).toEqual(['1 clip dont le son est introuvable : gardé hors ligne (muet) (« VOIX »).']);
  });

  it('WAV corrompu : seul ce clip est hors ligne, le chargement continue', async () => {
    const files: any = { 'project.json': JSON.stringify(baseProject()), ...sounds(), 'audio/a.wav': new Uint8Array([1, 2, 3, 4, 5]) };
    const { st, rapport } = await record('WAV corrompu (illisible)', await zipOf(files));
    expectCoherent(st);
    expect(st.tracks[0].clips[0].isOffline).toBe(true);
    expect(st.tracks[0].clips[1].bufferId).toBeTruthy();
    expect(st.tracks[1].clips[0].bufferId).toBeTruthy();
    expect(rapport.join('\n')).toMatch(/1 clip dont le son est abîmé \(illisible\)/);
  });

  it('pistes et clips en double, effets sans identifiant ou en double, effet sans type', async () => {
    const p: any = baseProject();
    p.tracks.push(track('voix', [clip('c1', 'audio/a.wav', 8), clip('c1', 'audio/a.wav', 9)], { name: 'VOIX (copie)' }));
    p.tracks[1].plugins = [fx(undefined), fx(undefined, 'DELAY'), fx('x'), fx('x', 'REVERB'), { id: 'casse', name: 'Sans type' }];
    const { st, rapport } = await record('Pistes, clips et effets en double / sans identifiant', await zipOf({ 'project.json': JSON.stringify(p), ...sounds() }));
    expectCoherent(st);
    expect(st.tracks.map((t: any) => t.id)).toEqual(['voix', 'choeurs', 'bus', 'verb', 'master', 'voix-2']);
    expect(st.tracks[5].clips.map((c: any) => c.id)).toEqual(['c1-r2', 'c1-r3']);
    expect(st.tracks[5].clips.every((c: any) => c.bufferId)).toBe(true);
    expect(st.tracks[1].plugins.map((x: any) => x.type)).toEqual(['COMPRESSOR', 'DELAY', 'COMPRESSOR', 'REVERB']);
    const r = rapport.join('\n');
    expect(r).toMatch(/1 piste en double renommée \(« VOIX \(copie\) »\)/);
    expect(r).toMatch(/2 clips en double renommés/);
    expect(r).toMatch(/2 effets sans identifiant/);
    expect(r).toMatch(/1 effet en double renommé/);
    expect(r).toMatch(/1 effet illisible retiré/);
  });

  it('sortie vers un bus inexistant, envoi vers une piste absente, liens de dossier cassés', async () => {
    const p: any = baseProject();
    p.tracks[1].outputTrackId = 'bus-supprime';
    p.tracks[1].sends = [{ id: 'fantome', level: 0.5, isEnabled: true }, { id: 'verb', level: 0.2, isEnabled: true }];
    p.tracks[1].parentFolderId = 'dossier-disparu';
    const { st, rapport } = await record('Sortie vers un bus inexistant, envoi vers une piste absente', await zipOf({ 'project.json': JSON.stringify(p), ...sounds() }));
    expectCoherent(st);
    expect(st.tracks[1].outputTrackId).toBe('master');
    expect(st.tracks[1].sends.map((s: any) => s.id)).toEqual(['verb']);
    expect(st.tracks[1].parentFolderId).toBeUndefined();
    expect(rapport).toEqual(expect.arrayContaining([
      '1 sortie vers une piste absente redirigée vers le master (« CHOEURS »).',
      '1 envoi vers une piste absente (ou en double) retiré (« CHOEURS »).',
      '1 lien de dossier / VCA vers une piste absente retiré (« CHOEURS »).',
    ]));
  });

  it('valeurs absurdes dans le fichier (1e999 = Infinity, null, texte, durée nulle, automation en désordre)', async () => {
    const p: any = baseProject();
    const json = JSON.stringify(p)
      .replace('"bpm":92', '"bpm":1e999')
      .replace('"volume":1', '"volume":"fort"')
      .replace('"start":2', '"start":-3')
      .replace('"duration":0.1,"offset":0,"fadeIn":0,"fadeOut":0,"color":"#f00","type":"AUDIO","audioRef":"audio/c.wav"', '"duration":0,"offset":0,"fadeIn":0,"fadeOut":0,"color":"#f00","type":"AUDIO","audioRef":"audio/c.wav"')
      .replace('[{"id":"p1","time":0,"value":1},{"id":"p2","time":3,"value":0.5}]', '[{"id":"p2","time":3,"value":0.5},{"id":"p1","time":0,"value":1},{"id":"p3","time":null,"value":1}]');
    const { st, rapport } = await record('Valeurs absurdes (Infinity, texte, négatif, durée nulle)', await zipOf({ 'project.json': json, ...sounds() }));
    expectCoherent(st);
    expect(st.bpm).toBe(120);
    expect(st.tracks[0].volume).toBe(1);
    expect(st.tracks[0].clips[1].start).toBe(0);
    expect(st.tracks[1].clips).toHaveLength(0);
    expect(st.tracks[0].automationLanes[0].points.map((q: any) => q.id)).toEqual(['p1', 'p2']);
    const r = rapport.join('\n');
    for (const re of [/Tempo invalide/, /volume invalide/, /position ou fondu de clip invalide/, /durée nulle retiré/, /points invalides/, /ordre du temps/]) expect(r).toMatch(re);
  });

  it('pas de liste de pistes, mais des sons : remis sur des pistes « Son récupéré »', async () => {
    const { st, rapport } = await record('Liste des pistes absente (sons présents)', await zipOf({ 'project.json': '{"name":"x","bpm":90}', ...sounds() }));
    expectCoherent(st);
    expect(st.tracks.map((t: any) => t.name)).toEqual(['Son récupéré 1', 'Son récupéré 2', 'Son récupéré 3']);
    expect(st.tracks[0].clips[0].duration).toBeCloseTo(0.1, 5);
    expect(st.bpm).toBe(90);
    expect(rapport[0]).toMatch(/3 sons de l'archive remis sur des pistes/);
  });

  it('project.json absent ou totalement illisible, sons présents : sons récupérés', async () => {
    for (const [cas, files] of [
      ['project.json absent (sons présents)', sounds()],
      ['project.json illisible (sons présents)', { 'project.json': '<<<pas du json>>>', ...sounds() }],
    ] as const) {
      audioBufferRegistry.clear();
      const { st, rapport } = await record(cas, await zipOf(files as any));
      expectCoherent(st);
      expect(st.tracks).toHaveLength(3);
      expect(rapport[0]).toMatch(/remis sur des pistes « Son récupéré »/);
    }
  });

  it('rien de récupérable : erreurs claires (pas de plantage)', async () => {
    const cases: [string, Blob, RegExp][] = [
      ['Archive illisible (pas un zip)', new Blob([new Uint8Array([0, 1, 2, 3])]), /Archive illisible/],
      ['Ni project.json ni sons', await zipOf({ 'autre.txt': 'x' }), /project\.json manquant/],
      ['JSON illisible sans aucun son', await zipOf({ 'project.json': '{pas du json' }), /Fichier projet corrompu/],
    ];
    for (const [cas, blob, re] of cases) {
      await expect(record(cas, blob)).rejects.toThrow(re);
    }
  });

  it('projet intact : aucun rapport', async () => {
    const { rapport } = await record('Projet intact (témoin)', await zipOf({ 'project.json': JSON.stringify(baseProject()), ...sounds() }));
    expect(rapport).toEqual([]);
  });

  it('le rapport ne part jamais dans une sauvegarde (non énumérable)', async () => {
    const files: any = { 'project.json': JSON.stringify(baseProject()), ...sounds() };
    delete files['audio/b.wav'];
    const st: any = await open(await zipOf(files));
    expect(ProjectIO.repairReportOf(st)).toHaveLength(1);
    expect(JSON.stringify(st)).not.toMatch(/__repairReport/);
    expect(ProjectIO.repairReportOf({ ...st })).toBeNull();
    const again = await JSZip.loadAsync(await ProjectIO.saveProject(st, []));
    expect(await again.file('project.json')!.async('string')).not.toMatch(/__repairReport/);
  });
});

describe('repairProject (état en mémoire : NaN, Infinity, sons inconnus)', () => {
  it('NaN / Infinity / bufferId inconnu', () => {
    const p: any = baseProject();
    p.tracks[0].volume = NaN;
    p.tracks[0].pan = Infinity;
    p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], audioRef: undefined, bufferId: 'inconnu', offset: NaN };
    p.tracks[1].clips[0].duration = Infinity;
    p.timeSignature = { numerator: 0, denominator: 3 };
    const r = repairProject(p, { knownBufferIds: id => id !== 'inconnu' });
    expect(r.repaired).toBe(true);
    expect(r.state.tracks[0]).toMatchObject({ volume: 1, pan: 0 });
    expect(r.state.tracks[0].clips[0]).toMatchObject({ isOffline: true, offset: 0 });
    expect(r.state.tracks[0].clips[0].bufferId).toBeUndefined();
    expect(r.state.tracks[1].clips).toHaveLength(0);
    expect(r.state.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    expectCoherentLoose(r.state);
  });

  it('entrée qui n\'est pas un projet : fatal, sans exception', () => {
    for (const x of [null, 42, 'texte', [1, 2]]) expect(repairProject(x).fatal).toBeTruthy();
  });

  it('pas de piste « master » recréée en double, et une piste « master » en double est renommée', () => {
    const p: any = baseProject();
    p.tracks.push(track('master', [], { type: 'BUS' }));
    const r = repairProject(p);
    expect(r.state.tracks.filter((t: any) => t.id === 'master')).toHaveLength(1);
    expect(r.state.tracks[r.state.tracks.length - 1].id).toBe('master-2');
  });
});

function expectCoherentLoose(st: any) {
  const ids = st.tracks.map((t: any) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const t of st.tracks) expect(Number.isFinite(t.volume) && Number.isFinite(t.pan)).toBe(true);
}
