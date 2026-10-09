import { describe, expect, it } from 'vitest';
import { TrackType } from '../types';
import { circuitFrom, insertIndexAfter, trackNameFromFile } from '../utils/importPlacement';

const backs: any = { id: 'backs', name: 'Backs', type: TrackType.AUDIO, outputTrackId: 'bus-vox',
  plugins: [{ id: 'p1', name: 'EQ', type: 'EQ', isEnabled: true, params: { bands: [{ f: 200 }] }, latency: 0 }],
  sends: [{ id: 'send-verb-long', level: 0.1, isEnabled: true }] };

describe('2 backs lâchés sur « Backs » : la piste en plus suit le circuit de « Backs »', () => {
  it('nom sans extension', () => {
    expect(trackNameFromFile('back_2_basse.wav')).toBe('back_2_basse');
    expect(trackNameFromFile('Lead final v3.aiff')).toBe('Lead final v3');
    expect(trackNameFromFile('')).toBe('Audio');
  });
  it('même bus, effets copiés (nouvel id, réglages séparés), mêmes envois', () => {
    const c = circuitFrom(backs);
    expect(c.outputTrackId).toBe('bus-vox');
    expect(c.plugins[0].id).not.toBe('p1');
    expect(c.plugins[0].params).toEqual(backs.plugins[0].params);
    expect(c.plugins[0].params).not.toBe(backs.plugins[0].params);
    expect(c.sends).toEqual(backs.sends);
    expect(c.sends[0]).not.toBe(backs.sends[0]);
  });
  it('piste visée = le beat ou un instrument : piste vierge au master', () => {
    expect(circuitFrom({ ...backs, id: 'instrumental' })).toEqual({ outputTrackId: 'master', plugins: [], sends: [] });
    expect(circuitFrom(undefined)).toEqual({ outputTrackId: 'master', plugins: [], sends: [] });
  });
  it('posée juste sous la piste visée', () => {
    const tracks = [{ id: 'instrumental' }, { id: 'voix-lead' }, { id: 'backs' }, { id: 'bus-vox' }];
    expect(insertIndexAfter(tracks, 'backs')).toBe(3);
    expect(insertIndexAfter(tracks, 'absente')).toBe(1);
  });
});
