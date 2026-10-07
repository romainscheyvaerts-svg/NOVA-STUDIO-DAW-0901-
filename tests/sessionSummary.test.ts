import { describe, expect, it } from 'vitest';
import { countVoiceTakes } from '../utils/sessionSummary';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('countVoiceTakes (F10)', () => {
  it('une prise coupée en 2 morceaux = 1 prise', () => {
    const rec = makeTrack({ id: 'rec', clips: [makeClip({ name: 'Prise 1 · 1', takeNumber: 1 }), makeClip({ name: 'Prise 1 · 2', takeNumber: 1 })] });
    expect(countVoiceTakes([rec])).toBe(1);
  });
  it('compte par piste, ignore le beat et les clips sans numéro', () => {
    const beat = makeTrack({ id: 'instrumental', clips: [makeClip({ name: 'Prise 9' })] });
    const a = makeTrack({ id: 'a', clips: [makeClip({ takeNumber: 1 }), makeClip({ takeNumber: 2 }), makeClip({ name: 'Import' })] });
    const b = makeTrack({ id: 'b', clips: [makeClip({ takeNumber: 1 })] });
    expect(countVoiceTakes([beat, a, b])).toBe(3);
  });
});
