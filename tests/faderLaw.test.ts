import { describe, expect, it } from 'vitest';
import {
  clampFaderGain, dbToFaderPos, FADER_MAX_DB, FADER_MAX_GAIN, FADER_TICKS, FADER_UNITY_POS,
  faderPosToDb, faderPosToGain, gainToFaderPos,
} from '../utils/faderLaw';
import { dbTextToGain } from '../plugins/hw/valueEntry';
import { gainToDbText } from '../utils/db';
import { sendLevelAt, sendPos } from '../utils/sendFader';
import { faderToVolume, volumeToFader } from '../utils/surfaceProtocol';

const dB = (g: number) => 20 * Math.log10(g);

describe('Échelle des faders (−∞ … +12 dB)', () => {
  it('butée haute = +12 dB, 0 dB aux 3/4 de la course, bas = −∞', () => {
    expect(FADER_MAX_DB).toBe(12);
    expect(faderPosToGain(1)).toBeCloseTo(FADER_MAX_GAIN, 12);
    expect(dB(FADER_MAX_GAIN)).toBeCloseTo(12, 12);
    expect(FADER_UNITY_POS).toBe(0.75);
    expect(faderPosToGain(0.75)).toBe(1);
    expect(gainToFaderPos(1)).toBe(0.75);
    expect(faderPosToGain(0)).toBe(0);
    expect(gainToFaderPos(0)).toBe(0);
    expect(faderPosToDb(0)).toBe(-Infinity);
  });

  it('graduations exactes : +12, +6, 0, −5, −10, −20, −30, −40, −60, −∞', () => {
    expect(FADER_TICKS.map(t => t.db)).toEqual([12, 6, 0, -5, -10, -20, -30, -40, -60, -Infinity]);
    expect(FADER_TICKS.map(t => t.label)).toEqual(['+12', '+6', '0', '−5', '−10', '−20', '−30', '−40', '−60', '−∞']);
    for (const t of FADER_TICKS) {
      if (t.db === -Infinity) { expect(faderPosToGain(t.pos)).toBe(0); continue; }
      expect(faderPosToDb(t.pos)).toBe(t.db);
      expect(dbToFaderPos(t.db)).toBe(t.pos);
      expect(dB(faderPosToGain(t.pos))).toBeCloseTo(t.db, 9);
    }
  });

  it('aller-retour position ↔ gain et monotonie sur toute la course', () => {
    let prev = -1;
    for (let i = 0; i <= 4000; i++) {
      const p = i / 4000;
      const g = faderPosToGain(p);
      expect(g).toBeGreaterThan(prev);
      prev = g;
      expect(gainToFaderPos(g)).toBeCloseTo(p, 9);
    }
    for (const db of [-119, -80, -45, -12, -3, -0.1, 0.1, 3.5, 6, 9, 11.9]) expect(dB(faderPosToGain(dbToFaderPos(db)))).toBeCloseTo(db, 9);
  });

  it('résolution plus fine autour de 0 dB qu’en bas de course', () => {
    const dbPerTenth = (p: number) => faderPosToDb(p + 0.05) - faderPosToDb(p - 0.05);
    expect(dbPerTenth(0.75)).toBeLessThanOrEqual(5);
    expect(dbPerTenth(0.12)).toBeGreaterThan(15);
  });

  it('anciens niveaux (1,5 = +3,5 dB) : gain intact, seule la position change', () => {
    for (const g of [0, 0.01, 0.5, 1, 1.2, 1.5]) expect(faderPosToGain(gainToFaderPos(g))).toBeCloseTo(g, 12);
    expect(gainToFaderPos(1.5)).toBeGreaterThan(0.75);
    expect(gainToFaderPos(1.5)).toBeLessThan(0.875);
  });

  it('borne : clampFaderGain et positions hors course', () => {
    expect(clampFaderGain(10)).toBeCloseTo(FADER_MAX_GAIN, 12);
    expect(clampFaderGain(-1)).toBe(0);
    expect(clampFaderGain(NaN)).toBe(0);
    expect(gainToFaderPos(100)).toBe(1);
    expect(faderPosToGain(2)).toBeCloseTo(FADER_MAX_GAIN, 12);
  });

  it('saisie au clavier : « +6 », « +12 » acceptés, « +15 » borné à +12, affichage honnête', () => {
    expect(dB(dbTextToGain('+6')!)).toBeCloseTo(6, 9);
    expect(gainToDbText(dbTextToGain('+6')!)).toBe('+6.0 dB');
    expect(dB(dbTextToGain('+12')!)).toBeCloseTo(12, 9);
    expect(gainToDbText(dbTextToGain('+12')!)).toBe('+12.0 dB');
    expect(dbTextToGain('+15')).toBeCloseTo(FADER_MAX_GAIN, 12);
    expect(gainToDbText(dbTextToGain('+15')!)).toBe('+12.0 dB');
    expect(dbTextToGain('0')).toBe(1);
  });

  it('envois et surface de contrôle : même échelle que les faders', () => {
    for (const p of [0, 0.1, 0.4, 0.75, 0.9, 1]) {
      expect(sendLevelAt(p)).toBeCloseTo(faderPosToGain(p), 12);
      expect(faderToVolume(p)).toBeCloseTo(faderPosToGain(p), 12);
    }
    expect(sendPos(1)).toBe(0.75);
    expect(volumeToFader(1)).toBe(0.75);
    expect(volumeToFader(FADER_MAX_GAIN)).toBe(1);
  });
});
