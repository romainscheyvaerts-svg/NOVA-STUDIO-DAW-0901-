import { describe, expect, it } from 'vitest';
import { TrackType } from '../types';
import { sendLabel, trackDisplayName } from '../utils/sendLabels';
import { makeTrack } from './helpers/fixtures';

describe('sendLabels (G2 : un seul nom par envoi)', () => {
  const tracks = [
    makeTrack({ id: 'send-delay', name: 'DELAY 1/4', type: TrackType.SEND }),
    makeTrack({ id: 'send-verb-short', name: 'VERB PRO', type: TrackType.SEND }),
    makeTrack({ id: 'send-verb-long', name: 'Ma cathédrale', type: TrackType.SEND }),
  ];
  it('anciens noms par défaut → libellé de la table', () => {
    expect(sendLabel('send-delay', tracks)).toBe('Écho 1/4');
    expect(sendLabel('send-verb-short', tracks)).toBe('Reverb courte');
    expect(sendLabel('send-verb-short', tracks, true)).toBe('Rév. courte');
  });
  it('les deux reverbs ne portent plus le même nom', () => {
    expect(sendLabel('send-verb-short', null, true)).not.toBe(sendLabel('send-verb-long', null, true));
  });
  it('piste d’envoi renommée par l’utilisateur : son nom est gardé', () => {
    expect(sendLabel('send-verb-long', tracks)).toBe('Ma cathédrale');
  });
  it('envoi inconnu (VST) : nom de sa piste', () => {
    expect(sendLabel('send-aux-1', [makeTrack({ id: 'send-aux-1', name: 'VALHALLA' })])).toBe('VALHALLA');
    expect(trackDisplayName({ id: 'lead', name: 'LEAD' })).toBe('LEAD');
    expect(trackDisplayName(tracks[0], tracks)).toBe('Écho 1/4');
  });
});
