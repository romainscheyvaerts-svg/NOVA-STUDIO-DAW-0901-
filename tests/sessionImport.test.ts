import { describe, expect, it } from 'vitest';
import { applyImport, ALL_PARTS, planImport, importSummary } from '../utils/sessionImport';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { DAWState, PluginInstance, TrackType } from '../types';

const comp = (id: string, over: Partial<PluginInstance> = {}): PluginInstance => ({ id, name: 'Compresseur', type: 'COMPRESSOR', isEnabled: true, params: { threshold: -18, ratio: 4 }, latency: 0, ...over });
const verb = (id: string): PluginInstance => ({ id, name: 'Reverb', type: 'REVERB', isEnabled: true, params: { mix: 1, decay: 2.2 }, latency: 0 });

/** Projet source : LEAD (compresseur, envoi vers RV, sortie VOX BUS), BACK, BEAT MIDI, bus RV et VOX BUS, master avec bus nommé. */
function source(): DAWState {
  const lane = { id: 'l1', parameterName: 'volume', color: '#fff', isExpanded: false, min: 0, max: 1.5, points: [{ id: 'p0', time: 2, value: 0.5 }, { id: 'p1', time: 4, value: 1 }] };
  return makeState([
    makeTrack({ id: 'lead', name: 'LEAD', color: '#ef4444', volume: 0.7, pan: -0.2, plugins: [comp('cmp-lead', { sidechainSourceId: 'kick' })],
      sends: [{ id: 'rv', level: 0.3, isEnabled: true, preFader: true }], outputTrackId: 'voxbus', automationLanes: [lane], comment: 'SM7B, à 10 cm',
      clips: [makeClip({ id: 'c-lead', start: 2, duration: 4, bufferId: 'imp-buf-lead' })] }),
    makeTrack({ id: 'back', name: 'BACK', sends: [], outputBusId: 'b-vox', clips: [makeClip({ id: 'c-back', start: 4, duration: 2, bufferId: 'imp-buf-back' })] }),
    makeTrack({ id: 'keys', name: 'KEYS', type: TrackType.MIDI, sends: [], clips: [makeClip({ id: 'c-keys', type: TrackType.MIDI, start: 4, duration: 2, notes: [{ id: 'n1', pitch: 60, start: 0.5, duration: 0.5, velocity: 100 }] })] }),
    makeTrack({ id: 'kick', name: 'KICK', sends: [], clips: [] }),
    makeTrack({ id: 'rv', name: 'RV', type: TrackType.BUS, sends: [], plugins: [verb('rv-1')] }),
    makeTrack({ id: 'voxbus', name: 'VOX BUS', type: TrackType.BUS, sends: [{ id: 'rv', level: 0.1, isEnabled: true }], plugins: [comp('cmp-bus')] }),
    makeTrack({ id: 'voxaux', name: 'VOX AUX', type: TrackType.BUS, sends: [], inputBusId: 'b-vox' }),
    makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [], outputTrackId: '', ioBuses: [{ id: 'b-vox', name: 'VOX ALL' }] }),
  ], { id: 'src', bpm: 120 });
}

function target(extra: any[] = []): DAWState {
  return makeState([
    makeTrack({ id: 'beat', name: 'BEAT', sends: [], clips: [makeClip({ id: 'c-beat', bufferId: 'buf-beat' })] }),
    ...extra,
    makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [], outputTrackId: '' }),
  ], { id: 'tgt', bpm: 120 });
}

let n = 0;
const gen = (b: string) => `${b}-i${++n}`;

describe('R21 · importer depuis une session', () => {
  it('planImport : pistes de la source, même nom repéré, dépendances listées', () => {
    const p = planImport(target([makeTrack({ id: 'x', name: 'lead', sends: [] })]), source());
    const lead = p.find(r => r.id === 'lead')!;
    expect(lead.existingId).toBe('x');
    expect(lead.dependsOn).toEqual(expect.arrayContaining(['VOX BUS', 'RV', 'KICK']));
    expect(p.find(r => r.id === 'back')!.dependsOn).toContain('VOX ALL');
    expect(p.some(r => r.id === 'master')).toBe(false);
  });

  it('tout importer : clips, effets, envois, routage ; bus manquants créés avec leurs effets', () => {
    const r = applyImport(target(), source(), [{ sourceId: 'lead', parts: ALL_PARTS }], { sameName: 'add', matchTempo: false }, gen);
    const s = r.state;
    const lead = s.tracks.find(t => t.name === 'LEAD')!;
    expect(lead.clips).toHaveLength(1);
    expect(lead.clips[0].bufferId).toBe('imp-buf-lead');
    expect(lead.volume).toBe(0.7);
    expect(lead.pan).toBe(-0.2);
    expect(lead.comment).toBe('SM7B, à 10 cm');
    expect(lead.plugins[0].params).toEqual({ threshold: -18, ratio: 4 });
    expect(lead.automationLanes[0].points.map(p => p.time)).toEqual([2, 4]);
    // Bus manquants : VOX BUS (sortie), RV (envoi, et envoi du VOX BUS), KICK (side-chain).
    expect(r.report.busesCreated.sort()).toEqual(['KICK', 'RV', 'VOX BUS']);
    const vox = s.tracks.find(t => t.name === 'VOX BUS')!;
    const rv = s.tracks.find(t => t.name === 'RV')!;
    expect(lead.outputTrackId).toBe(vox.id);
    expect(lead.sends[0]).toMatchObject({ id: rv.id, level: 0.3, preFader: true });
    expect(vox.sends[0].id).toBe(rv.id);
    expect(vox.plugins[0].type).toBe('COMPRESSOR');
    expect(rv.plugins[0].params.decay).toBe(2.2);
    expect(rv.clips).toEqual([]);
    expect(lead.plugins[0].sidechainSourceId).toBe(s.tracks.find(t => t.name === 'KICK')!.id);
    // Les nouvelles pistes sont rangées avant le master.
    expect(s.tracks[s.tracks.length - 1].id).toBe('master');
    expect(importSummary(r.report)).toMatch(/1 piste ajoutée/);
  });

  it('bus déjà présent dans le projet (même nom) : réutilisé, pas recréé', () => {
    const t = target([makeTrack({ id: 'myrv', name: 'rv', type: TrackType.BUS, sends: [] }), makeTrack({ id: 'mybus', name: 'Vox Bus', type: TrackType.BUS, sends: [] }), makeTrack({ id: 'k', name: 'KICK', sends: [] })]);
    const r = applyImport(t, source(), [{ sourceId: 'lead', parts: ALL_PARTS }], { sameName: 'add', matchTempo: false }, gen);
    expect(r.report.busesCreated).toEqual([]);
    const lead = r.state.tracks.find(x => x.name === 'LEAD')!;
    expect(lead.outputTrackId).toBe('mybus');
    expect(lead.sends[0].id).toBe('myrv');
  });

  it('bus nommé : ajouté au master, et l’aux qui l’écoute est créé', () => {
    const r = applyImport(target(), source(), [{ sourceId: 'back', parts: ALL_PARTS }], { sameName: 'add', matchTempo: false }, gen);
    const master = r.state.tracks.find(t => t.id === 'master')!;
    expect(master.ioBuses?.map(b => b.name)).toEqual(['VOX ALL']);
    const back = r.state.tracks.find(t => t.name === 'BACK')!;
    expect(back.outputBusId).toBe(master.ioBuses![0].id);
    const aux = r.state.tracks.find(t => t.name === 'VOX AUX')!;
    expect(aux.inputBusId).toBe(master.ioBuses![0].id);
    expect(r.report.namedBusesCreated).toEqual(['VOX ALL']);
  });

  it('même nom : « remplacer » ne prend que les parties choisies, « ajouter » crée « LEAD 2 »', () => {
    const mine = makeTrack({ id: 'myLead', name: 'LEAD', color: '#123456', volume: 0.9, sends: [], plugins: [comp('autre', { params: { threshold: -3 } })], clips: [makeClip({ id: 'mine-c' })] });
    const r1 = applyImport(target([mine]), source(), [{ sourceId: 'lead', parts: ['plugins'] }], { sameName: 'replace', matchTempo: false }, gen);
    const l1 = r1.state.tracks.find(t => t.id === 'myLead')!;
    expect(r1.report.replaced).toEqual(['LEAD']);
    expect(l1.plugins[0].params.threshold).toBe(-18);
    expect(l1.volume).toBe(0.7);
    expect(l1.clips.map(c => c.id)).toEqual(['mine-c']); // clips gardés
    expect(l1.color).toBe('#123456');
    expect(r1.state.tracks.filter(t => t.name.startsWith('LEAD'))).toHaveLength(1);

    const r2 = applyImport(target([mine]), source(), [{ sourceId: 'lead', parts: ['clips'] }], { sameName: 'add', matchTempo: false }, gen);
    expect(r2.state.tracks.map(t => t.name)).toContain('LEAD 2');
    const l2 = r2.state.tracks.find(t => t.name === 'LEAD 2')!;
    expect(l2.plugins).toEqual([]);
    expect(l2.outputTrackId).toBe('master');
    expect(r2.report.busesCreated).toEqual([]); // pas de routage demandé
  });

  it('identifiants : une piste ou un clip qui existe déjà reçoit un nouvel identifiant', () => {
    const t = target([makeTrack({ id: 'lead', name: 'Autre', sends: [], clips: [makeClip({ id: 'c-lead' })] })]);
    const r = applyImport(t, source(), [{ sourceId: 'lead', parts: ['clips'] }], { sameName: 'add', matchTempo: false }, gen);
    const imported = r.state.tracks.find(x => x.name === 'LEAD')!;
    expect(imported.id).not.toBe('lead');
    expect(imported.clips[0].id).not.toBe('c-lead');
    const ids = r.state.tracks.map(x => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('faire correspondre au tempo : mêmes mesures, MIDI et automation suivent, audio à étirer', () => {
    const t = { ...target(), bpm: 90 };
    const r = applyImport(t, source(), [{ sourceId: 'lead', parts: ['clips', 'automation'] }, { sourceId: 'keys', parts: ['clips'] }], { sameName: 'add', matchTempo: true }, gen);
    const k = 120 / 90;
    const lead = r.state.tracks.find(x => x.name === 'LEAD')!;
    expect(lead.clips[0].start).toBeCloseTo(2 * k, 9);
    expect(lead.clips[0].duration).toBe(4); // l'étirement est rendu par l'hôte
    expect(r.report.toStretch).toEqual([{ trackId: lead.id, clipId: lead.clips[0].id }]);
    expect(lead.automationLanes[0].points.map(p => p.time)).toEqual([2 * k, 4 * k]);
    const keys = r.state.tracks.find(x => x.name === 'KEYS')!;
    expect(keys.clips[0].start).toBeCloseTo(4 * k, 9);
    expect(keys.clips[0].duration).toBeCloseTo(2 * k, 9);
    expect(keys.clips[0].notes![0].start).toBeCloseTo(0.5 * k, 9);
    expect(r.report.tempoRatio).toBeCloseTo(k, 9);
    // Sans l'option : rien ne bouge.
    const r0 = applyImport(t, source(), [{ sourceId: 'lead', parts: ['clips'] }], { sameName: 'add', matchTempo: false }, gen);
    expect(r0.state.tracks.find(x => x.name === 'LEAD')!.clips[0].start).toBe(2);
    expect(r0.report.toStretch).toEqual([]);
  });

  it('la source n’est jamais modifiée', () => {
    const src = source();
    const before = JSON.stringify(src);
    applyImport(target(), src, [{ sourceId: 'lead', parts: ALL_PARTS }, { sourceId: 'back', parts: ALL_PARTS }], { sameName: 'add', matchTempo: true }, gen);
    expect(JSON.stringify(src)).toBe(before);
  });
});
