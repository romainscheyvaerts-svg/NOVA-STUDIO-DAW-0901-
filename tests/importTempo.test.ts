import { describe, expect, it } from 'vitest';
import { keyToPropose, looksLikeBeat, shouldDetectTempo, tempoToPropose } from '../utils/importTempo';

/** Beat importé du PC : tempo proposé (jamais imposé). */
describe('tempo d’un beat importé', () => {
  it('détection seulement pour un beat (piste « Beat » ou nom de beat), assez long, hors catalogue', () => {
    expect(shouldDetectTempo({ durationSec: 30, landedOnBeatTrack: true, fileName: 'x.wav' })).toBe(true);
    expect(shouldDetectTempo({ durationSec: 30, landedOnBeatTrack: false, fileName: 'Mon beat 140.wav' })).toBe(true);
    expect(shouldDetectTempo({ durationSec: 30, landedOnBeatTrack: false, fileName: 'back_2_basse.wav' })).toBe(false);
    expect(shouldDetectTempo({ durationSec: 4, landedOnBeatTrack: true, fileName: 'beat.wav' })).toBe(false);
    expect(shouldDetectTempo({ durationSec: 30, landedOnBeatTrack: true, fileName: 'beat.wav', fromCatalog: true })).toBe(false);
    expect(looksLikeBeat('Instru drill.mp3')).toBe(true);
  });
  it('tempo proposé quand il diffère du projet ; même ressenti (moitié / double) : rien à proposer', () => {
    expect(tempoToPropose(140, 120)).toBe(140);
    expect(tempoToPropose(140, 140)).toBeNull();
    expect(tempoToPropose(140.3, 140)).toBeNull();
    expect(tempoToPropose(70, 140)).toBeNull();
    expect(tempoToPropose(140, 70)).toBeNull();
    expect(tempoToPropose(0, 120)).toBeNull();
    expect(tempoToPropose(NaN, 120)).toBeNull();
    expect(tempoToPropose(250, 120)).toBeNull();
  });
  it('tonalité proposée si détectée et différente du projet', () => {
    expect(keyToPropose({ rootKey: 9, scale: 'MINOR', confidence: 0.1 }, { rootKey: 0, scale: 'MAJOR' })).toEqual({ rootKey: 9, scale: 'MINOR' });
    expect(keyToPropose({ rootKey: 9, scale: 'MINOR', confidence: 0.1 }, { rootKey: 9, scale: 'MINOR' })).toBeNull();
    expect(keyToPropose(null, {})).toBeNull();
  });
});
