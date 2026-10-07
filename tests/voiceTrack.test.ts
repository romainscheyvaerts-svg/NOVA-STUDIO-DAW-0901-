import { describe, expect, it } from 'vitest';
import { TrackType } from '../types';
import { nextVoiceName, planVoiceTrack } from '../utils/voiceTrack';
import { makeTrack } from './helpers/fixtures';

const session = () => [
  makeTrack({ id: 'instrumental', name: 'BEAT' }),
  makeTrack({ id: 'track-rec-main', name: 'REC' }),
  makeTrack({ id: 'lead-couplet', name: 'LEAD COUPLET' }),
  makeTrack({ id: 'back-1', name: 'BACK 1' }),
  makeTrack({ id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS }),
  makeTrack({ id: 'send-delay', name: 'DELAY 1/4', type: TrackType.SEND }),
];

describe('planVoiceTrack (B2 : « + Piste voix »)', () => {
  it('insère sous la piste sélectionnée et reprend son traitement', () => {
    const p = planVoiceTrack(session(), 'track-rec-main');
    expect(p.index).toBe(2);
    expect(p.templateId).toBe('track-rec-main');
    expect(p.outputTrackId).toBe('bus-vox');
    expect(p.name).toBe('VOIX');
  });

  it('beat sélectionné : juste dessous, modèle = REC', () => {
    const p = planVoiceTrack(session(), 'instrumental');
    expect(p.index).toBe(1);
    expect(p.templateId).toBe('track-rec-main');
  });

  it('rien (ou un bus) sélectionné : après la dernière piste, avant bus et envois', () => {
    expect(planVoiceTrack(session(), null).index).toBe(4);
    expect(planVoiceTrack(session(), 'send-delay').index).toBe(4);
  });

  it('sans bus des voix : sortie master', () => {
    const t = session().filter(x => x.id !== 'bus-vox');
    expect(planVoiceTrack(t, null).outputTrackId).toBe('master');
  });

  it('nom unique : VOIX, VOIX 2, VOIX 3…', () => {
    expect(nextVoiceName([makeTrack({ name: 'VOIX' })])).toBe('VOIX 2');
    expect(nextVoiceName([makeTrack({ name: 'VOIX' }), makeTrack({ name: 'voix 2' })])).toBe('VOIX 3');
    expect(nextVoiceName([])).toBe('VOIX');
  });
});

