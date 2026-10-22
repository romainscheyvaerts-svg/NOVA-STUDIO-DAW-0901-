import { describe, expect, it } from 'vitest';
import { autoRecordTarget, canRecordOn, looksLikeVoiceTrack, recTrackOf } from '../utils/recordTarget';
import { instantiateTemplate, parseTemplate } from '../utils/sessionTemplate';
import { Track, TrackType } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Séance d'enregistrement voix (audit du 22/10/2026) : REC sans piste armée choisit la piste REC (modèle de Romain : KICK inactive, le 1er REC échouait).
 */

describe('REC sans piste armée : la bonne piste (utils/recordTarget)', () => {
  const kick = makeTrack({ id: 'kick', name: 'KICK', isInactive: true });
  const talk = makeTrack({ id: 'talkback', name: 'TALKBACK' });
  const instru = makeTrack({ id: 'instru', name: 'INSTRU', clips: [makeClip({ name: 'beat.wav' })] });
  const playlist = makeTrack({ id: 'playlist', name: 'PLAYLIST' });
  const recT = makeTrack({ id: 'rec', name: 'REC' });
  const lead = makeTrack({ id: 'lead-a', name: 'LEAD A' });
  const bus = makeTrack({ id: 'bus-vox', name: 'VOX', type: TrackType.BUS });
  const tracks = [bus, kick, talk, instru, playlist, recT, lead];

  it('modèle de Romain : KICK (inactive) sélectionnée → REC, jamais KICK', () => {
    expect(canRecordOn(kick)).toBe(false);
    expect(autoRecordTarget(tracks, 'kick')!.id).toBe('rec');
  });
  it('piste du beat ou talkback sélectionnée : la prise va sur REC (le beat ne se fait pas couper)', () => {
    expect(looksLikeVoiceTrack(instru)).toBe(false);
    expect(autoRecordTarget(tracks, 'instru')!.id).toBe('rec');
    expect(autoRecordTarget(tracks, 'talkback')!.id).toBe('rec');
  });
  it('piste voix sélectionnée : c’est elle (choix de l’ingé)', () => {
    expect(autoRecordTarget(tracks, 'lead-a')!.id).toBe('lead-a');
    expect(autoRecordTarget(tracks, 'playlist')!.id).toBe('playlist');
  });
  it('rien de sélectionné : la piste REC ; track-rec-main d’abord ; masquée / guide exclues', () => {
    expect(recTrackOf(tracks)!.id).toBe('rec');
    const main = makeTrack({ id: 'track-rec-main', name: 'Voix' });
    expect(autoRecordTarget([...tracks, main], null)!.id).toBe('track-rec-main');
    const hidden = makeTrack({ id: 'rec-h', name: 'REC', isHidden: true });
    const guide = makeTrack({ id: 'g', name: 'Lead guide', isGuide: true });
    expect(autoRecordTarget([hidden, guide, lead], null)!.id).toBe('lead-a');
  });
  it('projet sans piste voix reconnue : la sélectionnée utilisable, sinon la 1re utilisable ; aucune : null', () => {
    const d = makeTrack({ id: 'drums', name: 'DRUMS' });
    expect(autoRecordTarget([d, instru], 'instru')!.id).toBe('instru');
    expect(autoRecordTarget([d, instru], null)!.id).toBe('drums');
    expect(autoRecordTarget([kick, bus], 'kick')).toBeNull();
  });
  it('le vrai modèle LENNON : la piste sélectionnée à l’ouverture est REC', () => {
    const raw = readFileSync(resolve(__dirname, '../templates/romain-lennon-depart.novatemplate'), 'utf-8');
    const tpl = parseTemplate(raw);
    const { state } = instantiateTemplate(tpl, { name: 'Séance' }) as any;
    const sel = state.tracks.find((t: Track) => t.id === state.selectedTrackId);
    expect(sel.name.trim()).toBe('REC');
    expect(autoRecordTarget(state.tracks, state.selectedTrackId)!.id).toBe(sel.id);
  });
});
