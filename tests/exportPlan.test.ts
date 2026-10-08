import { describe, it, expect } from 'vitest';
import { Track, TrackType } from '../types';
import { planStems, stemsSumToMix, lastHopBeforeMaster, isStemSource } from '../utils/stemPlan';
import { deliveryFileName, safePart, uniqueNames, keyForFile, extensionOf, stemFileNames } from '../utils/exportNaming';
import { exportSpan, finalLength, applyTail, lastAudibleIndex } from '../utils/exportTail';
import { VOID_OUTPUT } from '../utils/trackStructure';

const mk = (id: string, over: Partial<Track> = {}): Track => ({
  id, name: id, type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [{ id: `c-${id}`, start: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, name: 'c', color: '#fff', type: TrackType.AUDIO, bufferId: `b-${id}` }],
  plugins: [], automationLanes: [], totalLatency: 0, ...over,
});

function session(): Track[] {
  return [
    mk('master', { type: TrackType.BUS, clips: [], outputTrackId: '', plugins: [{ id: 'lim', type: 'LIMITER', name: 'Limiteur', isEnabled: true, params: {} } as any] }),
    mk('instrumental', { name: 'Beat', instrumentId: 12 }),
    mk('lead', { name: 'Voix lead', outputTrackId: 'busv', sends: [{ id: 'verb', level: 0.3, isEnabled: true }] }),
    mk('back', { name: 'Backs', outputTrackId: 'busv', sends: [{ id: 'verb', level: 0.2, isEnabled: true }] }),
    mk('kick', { name: 'Kick', type: TrackType.DRUM_RACK, parentFolderId: 'fold', clips: [{ id: 'k', start: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, name: 'k', color: '#fff', type: TrackType.MIDI, notes: [{ id: 'n', pitch: 36, start: 0, duration: 0.1, velocity: 100 }] }] }),
    mk('snare', { name: 'Snare', parentFolderId: 'fold' }),
    mk('fold', { name: 'Batterie', type: TrackType.BUS, clips: [], folder: { kind: 'basic' } }),
    mk('busv', { name: 'Bus voix', type: TrackType.BUS, clips: [] }),
    mk('verb', { name: 'Reverb', type: TrackType.SEND, clips: [] }),
    mk('guide', { name: 'Guide topliner', isGuide: true }),
    mk('mute', { name: 'Muette', isMuted: true }),
  ];
}

describe('plan des stems', () => {
  it('par piste : une source = un fichier, ni guide, ni muette, ni bus', () => {
    const p = planStems(session(), { grouping: 'tracks', returns: 'in-stems', withMasterFx: true });
    expect(p.map(s => s.label)).toEqual(['Beat', 'Voix lead', 'Backs', 'Kick', 'Snare']);
    const lead = p[1];
    // solo de la seule source du stem, envois gardés (la réverbe est dans le stem)
    expect(lead.tracks.filter(t => t.isSolo).map(t => t.id)).toEqual(['lead']);
    expect(lead.tracks.find(t => t.id === 'lead')!.sends).toHaveLength(1);
    expect(lead.tracks.find(t => t.id === 'master')!.plugins).toHaveLength(1);
    expect(lead.tracks.some(t => t.id === 'guide')).toBe(false);
  });
  it('par bus : les voix ensemble (bus voix), le reste à part', () => {
    const p = planStems(session(), { grouping: 'buses', returns: 'in-stems', withMasterFx: false });
    expect(p.map(s => `${s.kind}:${s.label}:${s.memberIds.join('+')}`)).toEqual([
      'track:Beat:instrumental', 'bus:Bus voix:lead+back', 'track:Kick:kick', 'track:Snare:snare',
    ]);
    // sans les effets du master
    expect(p[1].tracks.find(t => t.id === 'master')!.plugins).toEqual([]);
    expect(lastHopBeforeMaster('lead', session())).toBe('busv');
  });
  it('par dossier : la batterie du dossier ensemble', () => {
    const p = planStems(session(), { grouping: 'folders', returns: 'in-stems', withMasterFx: true });
    expect(p.map(s => `${s.label}:${s.memberIds.join('+')}`)).toEqual(['Beat:instrumental', 'Voix lead:lead', 'Backs:back', 'Batterie:kick+snare']);
  });
  it('instru / voix séparés pour l\'ingé', () => {
    const p = planStems(session(), { grouping: 'instru-voix', returns: 'in-stems', withMasterFx: false });
    expect(p.map(s => `${s.label}:${s.memberIds.join('+')}`)).toEqual(['Instru:instrumental+kick+snare', 'Voix:lead+back']);
  });
  it('retours en stems séparés : stems secs + un fichier par retour alimenté, chemins secs coupés', () => {
    const p = planStems(session(), { grouping: 'tracks', returns: 'separate', withMasterFx: false });
    expect(p.map(s => s.label)).toEqual(['Beat', 'Voix lead', 'Backs', 'Kick', 'Snare', 'Reverb']);
    expect(p[1].tracks.find(t => t.id === 'lead')!.sends).toEqual([]);
    const ret = p[5];
    expect(ret.kind).toBe('return');
    const r = (id: string) => ret.tracks.find(t => t.id === id)!;
    expect(r('verb').outputTrackId).toBe('master');
    expect(r('busv').outputTrackId).toBe(VOID_OUTPUT);       // le sec des voix ne va plus au master
    expect(r('instrumental').outputTrackId).toBe(VOID_OUTPUT);
    expect(r('lead').outputTrackId).toBe('busv');            // mais rejoint toujours son bus… dont le sec est coupé
    expect(r('lead').sends).toHaveLength(1);                 // l'envoi vers la réverbe reste
  });
  it('retour routé vers un bus FX (modèle par défaut) : le chemin retour → bus FX → master reste', () => {
    const t = session().map(x => (x.id === 'verb' ? { ...x, outputTrackId: 'busfx' } : x));
    t.push(mk('busfx', { name: 'Bus FX', type: TrackType.BUS, clips: [] }));
    const p = planStems(t, { grouping: 'tracks', returns: 'separate', withMasterFx: false });
    const ret = p.find(s => s.kind === 'return')!;
    const r = (id: string) => ret.tracks.find(x => x.id === id)!;
    expect(r('verb').outputTrackId).toBe('busfx');
    expect(r('busfx').outputTrackId).toBe('master');
    expect(r('busv').outputTrackId).toBe(VOID_OUTPUT);
  });
  it('sans retours : stems secs, et la somme n\'est plus le mix', () => {
    const t = session();
    const p = planStems(t, { grouping: 'tracks', returns: 'none', withMasterFx: false });
    expect(p.every(s => s.tracks.every(x => !(x.sends || []).some(sd => sd.id === 'verb')))).toBe(true);
    expect(stemsSumToMix({ grouping: 'tracks', returns: 'none', withMasterFx: false }, t)).toBe(false);
    expect(stemsSumToMix({ grouping: 'tracks', returns: 'in-stems', withMasterFx: false }, t)).toBe(true);
    expect(stemsSumToMix({ grouping: 'tracks', returns: 'in-stems', withMasterFx: true }, t)).toBe(false);
  });
  it('une piste MIDI sans note ne fait pas de stem', () => {
    expect(isStemSource(mk('m', { type: TrackType.MIDI, clips: [{ id: 'x', start: 0, duration: 1, offset: 0, fadeIn: 0, fadeOut: 0, name: '', color: '', type: TrackType.MIDI, notes: [] }] }))).toBe(false);
  });
});

describe('noms de livraison', () => {
  it('Titre_BPM_Ton_Piste.ext, sans accents ni espaces', () => {
    expect(deliveryFileName({ title: 'Nuit blanche', bpm: 142, key: keyForFile(0, 'MINOR'), part: 'Voix lead', ext: 'wav' })).toBe('Nuit-blanche_142BPM_Cm_Voix-lead.wav');
    expect(deliveryFileName({ title: 'Été (remix)', bpm: 87.5, key: keyForFile(6, 'MINOR'), part: 'Kick #1', ext: 'flac' })).toBe('Ete-remix_87.5BPM_Fdm_Kick-d1.flac');
    expect(deliveryFileName({ title: '', ext: 'mp3' })).toBe('Morceau.mp3');
    expect(safePart('  Œuvre / A:B  ')).toBe('oeuvre-A-B');
    expect(uniqueNames(['a.wav', 'A.wav', 'b.wav', 'a.wav'])).toEqual(['a.wav', 'A-2.wav', 'b.wav', 'a-3.wav']);
    expect(extensionOf('AIFF')).toBe('aif');
  });
});

describe('bug R1 : extension des stems', () => {
  it('en MP3, les stems du zip finissent par .mp3 (et non .wav)', () => {
    const n = stemFileNames('MP3', { title: 'Nuit', bpm: 140, key: 'Cm' }, ['Voix lead', 'Beat', 'Voix lead']);
    expect(n).toEqual(['Nuit_140BPM_Cm_Voix-lead.mp3', 'Nuit_140BPM_Cm_Beat.mp3', 'Nuit_140BPM_Cm_Voix-lead-2.mp3']);
    expect(n.every(x => !x.endsWith('.wav'))).toBe(true);
    expect(stemFileNames('FLAC', { title: 'Nuit' }, ['Beat'])).toEqual(['Nuit_Beat.flac']);
    expect(stemFileNames('AIFF', { title: 'Nuit' }, ['Beat'])).toEqual(['Nuit_Beat.aif']);
  });
});

describe('queue et plage', () => {
  const SR = 1000;
  const decay = (n: number, cut: number) => Float32Array.from({ length: n }, (_, i) => (i < cut ? 0.5 * Math.exp(-(i - 0) / 200) : 0));
  it('plage et durée de rendu selon la queue', () => {
    expect(exportSpan(2, 10, { mode: 'cut', seconds: 0 }).renderDuration).toBe(8);
    expect(exportSpan(2, 10, { mode: 'manual', seconds: 3 }).renderDuration).toBe(11);
    expect(exportSpan(2, 10, { mode: 'auto', seconds: 0 }).renderDuration).toBe(18);
  });
  it('auto : coupe quand tout est retombé sous −80 dBFS (+50 ms)', () => {
    const x = decay(15000, 15000);
    const last = lastAudibleIndex([x]);
    // 0,5·e^(−i/200) < 1e-4  ⇔  i > 200·ln(5000) ≈ 1703
    expect(last).toBeGreaterThan(1690); expect(last).toBeLessThan(1710);
    expect(finalLength([x], SR, 1, { mode: 'auto', seconds: 0 })).toBe(last + 1 + 50);
    // jamais plus court que la plage
    expect(finalLength([decay(15000, 10)], SR, 5, { mode: 'auto', seconds: 0 })).toBe(5000);
    expect(finalLength([x], SR, 1, { mode: 'cut', seconds: 0 })).toBe(1000);
    expect(finalLength([x], SR, 1, { mode: 'manual', seconds: 2 })).toBe(3000);
  });
  it('boucle : la queue revient au début', () => {
    const x = new Float32Array([1, 0, 0, 0, 0.5, 0.25]);
    const [y] = applyTail([x], 4, 'wrap');
    expect(Array.from(y)).toEqual([1.5, 0.25, 0, 0]);
    expect(Array.from(applyTail([x], 4, 'cut')[0])).toEqual([1, 0, 0, 0]);
  });
});
