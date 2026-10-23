import { FADER_MAX_GAIN } from '../utils/faderLaw';
import { describe, expect, it } from 'vitest';
import { dbTextToGain, panTextToValue, parseShown, solveTypedValue, startsValueEntry } from '../plugins/hw/valueEntry';
import { gainToDbText, panToText } from '../utils/db';

const hz = (v: number) => (v >= 1000 ? `${String(Math.round(v / 100) / 10).replace('.', ',')} kHz` : `${Math.round(v)} Hz`);
const ms = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${String(Math.round(v * 100) / 100).replace('.', ',')} s`);

describe('saisie d\'une valeur au clavier', () => {
  it('lit les nombres affichés et tapés', () => {
    expect(parseShown('-3,5 dB')).toEqual({ num: -3.5, unit: 'db' });
    expect(parseShown('−12.0 dB')).toEqual({ num: -12, unit: 'db' });
    expect(parseShown('2.5k')).toEqual({ num: 2.5, unit: 'k' });
    expect(parseShown('G 30')).toEqual({ num: -30, unit: null });
    expect(parseShown('R20')).toEqual({ num: 20, unit: null });
    expect(parseShown('C')).toEqual({ num: 0, unit: null });
    expect(parseShown('-∞')?.num).toBe(-Infinity);
    expect(parseShown('abc')).toBeNull();
    expect(parseShown('')).toBeNull();
  });

  it('fréquence logarithmique en Hz / kHz : « 800 », « 2,5 », « 2.5k », « 4 kHz »', () => {
    const r = { min: 20, max: 20000, curve: 'log' as const };
    expect(solveTypedValue(r, hz, '800', 2500)).toBeCloseTo(800, -1);
    expect(solveTypedValue(r, hz, '2,5', 2500)).toBeCloseTo(2500, -2);
    expect(solveTypedValue(r, hz, '2.5k', 300)).toBeCloseTo(2500, -2);
    expect(solveTypedValue(r, hz, '4 kHz', 300)).toBeCloseTo(4000, -2);
    expect(solveTypedValue(r, hz, '99999', 300)).toBe(20000);
    expect(solveTypedValue(r, hz, '5', 300)).toBe(20);
  });

  it('temps en secondes affiché en ms ou en s : « 30 », « 0,2 s », « 300 » sur un affichage en s', () => {
    const r = { min: 0.001, max: 2, curve: 'log' as const };
    expect(solveTypedValue(r, ms, '30', 0.01)).toBeCloseTo(0.03, 3);
    expect(solveTypedValue(r, ms, '0,2 s', 0.01)).toBeCloseTo(0.2, 2);
    expect(solveTypedValue(r, ms, '300', 1.2)).toBeCloseTo(0.3, 2);
  });

  it('gain linéaire affiché en dB (fader) et pas du réglage respecté', () => {
    const fader = { min: 0, max: 1.5 };
    const g = solveTypedValue(fader, gainToDbText, '-6', 1)!;
    expect(20 * Math.log10(g)).toBeCloseTo(-6, 1);
    expect(solveTypedValue(fader, gainToDbText, '-inf', 1)).toBe(0);
    const stepped = solveTypedValue({ min: -24, max: 24, step: 0.5 }, v => `${v.toFixed(1)} dB`, '3,3', 0);
    expect(stepped).toBe(3.5);
  });

  it('crans : le cran affiché le plus proche', () => {
    const r = { min: 1, max: 20, detents: [{ v: 1 }, { v: 2 }, { v: 4 }, { v: 8 }, { v: 20 }] };
    expect(solveTypedValue(r, v => `${v}:1`, '7', 2)).toBe(8);
  });

  it('dB → gain, pan au clavier, touches qui ouvrent la saisie', () => {
    expect(dbTextToGain('-6')).toBeCloseTo(0.501, 3);
    expect(20 * Math.log10(dbTextToGain('+10')!)).toBeCloseTo(10, 9);
    expect(dbTextToGain('+15')).toBe(FADER_MAX_GAIN);
    expect(dbTextToGain('-inf')).toBe(0);
    expect(dbTextToGain('2 kHz')).toBeNull();
    expect(panTextToValue('G 30')).toBeCloseTo(-0.3, 6);
    expect(panTextToValue('L30')).toBeCloseTo(-0.3, 6);
    expect(panTextToValue('D 100')).toBe(1);
    expect(panTextToValue('-200')).toBe(-1);
    expect(panTextToValue('C')).toBe(0);
    expect(panToText(panTextToValue('G 45')!)).toBe('G 45');
    expect(startsValueEntry('5')).toBe(true);
    expect(startsValueEntry('-')).toBe(true);
    expect(startsValueEntry('a')).toBe(false);
  });
});
