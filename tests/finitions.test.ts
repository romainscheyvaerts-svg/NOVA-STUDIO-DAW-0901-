import { describe, expect, it } from 'vitest';
import { tonaliteFr } from '../utils/keyName';
import { capTruePeak, truePeakDb, MP3_TRUE_PEAK_CEILING } from '../utils/loudness';
import { makeBuffer } from './helpers/audio';

describe('tonaliteFr (cartes du catalogue en français)', () => {
  it('traduit les écritures du catalogue', () => {
    expect(tonaliteFr('F# minor')).toBe('Fa# mineur');
    expect(tonaliteFr('Bb min')).toBe('Si♭ mineur');
    expect(tonaliteFr('C # minor')).toBe('Do# mineur');
    expect(tonaliteFr('B HAMONIC minor')).toBe('Si mineur harmonique');
    expect(tonaliteFr('B harmonic minor')).toBe('Si mineur harmonique');
    expect(tonaliteFr('E MAJOR')).toBe('Mi majeur');
    expect(tonaliteFr('A')).toBe('La mineur');
  });
  it('rend tel quel ce qui est illisible, vide si absent', () => {
    expect(tonaliteFr('???')).toBe('???');
    expect(tonaliteFr('')).toBe('');
    expect(tonaliteFr(null)).toBe('');
  });
});

describe('capTruePeak (plafond avant encodage MP3)', () => {
  it('baisse un mix qui dépasse le plafond', () => {
    const buf = makeBuffer(2, 44100, 44100, (ch, i) => Math.sin(i / 3 + ch) * 1.2);
    expect(truePeakDb(buf)).toBeGreaterThan(0);
    const g = capTruePeak(buf, MP3_TRUE_PEAK_CEILING);
    expect(g).toBeLessThan(0);
    expect(truePeakDb(buf)).toBeLessThanOrEqual(MP3_TRUE_PEAK_CEILING + 0.01);
  });
  it('ne remonte jamais un mix déjà sous le plafond', () => {
    const buf = makeBuffer(1, 4410, 44100, (_c, i) => Math.sin(i / 20) * 0.1);
    const avant = truePeakDb(buf);
    expect(capTruePeak(buf, MP3_TRUE_PEAK_CEILING)).toBe(0);
    expect(truePeakDb(buf)).toBeCloseTo(avant, 6);
  });
  it('le plafond MP3 vise au moins 1 dB sous 0 dBTP', () => {
    expect(MP3_TRUE_PEAK_CEILING).toBeLessThanOrEqual(-1);
  });
});
