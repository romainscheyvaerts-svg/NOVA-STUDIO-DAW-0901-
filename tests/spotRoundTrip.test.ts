import { describe, expect, it } from 'vitest';
import {
  formatSpot, parseSpot, readSpotField, SpotFormat, spotField, spotStart, switchSpotFormat, typeSpotField,
} from '../utils/spotTime';

/**
 * Constat R1 (audit UX du 08/10) : la fenêtre Spot proposait 14 999 au lieu de
 * 14 994 échantillons. Cause : en passant de Mesures (ou Min:sec) à Échantillons,
 * la position était relue depuis le texte arrondi au tick (ou à la ms).
 * Ici : aller-retour exact à l'échantillon près, 3 formats, 44,1 et 48 kHz.
 */
const FORMATS: SpotFormat[] = ['BARS', 'MINSEC', 'SAMPLES'];
const RATES = [44100, 48000];
const TEMPOS = [120, 93.7, 174];
const SAMPLES = [0, 1, 7, 14994, 14999, 22051, 44099, 123457, 529199, 1_234_567, 9_999_991];

describe('Spot : aller-retour exact à l’échantillon près', () => {
  it('reproduit le constat sans le champ exact (relecture du texte arrondi)', () => {
    const ctx = { bpm: 120, sr: 44100 };
    const t = 14994 / 44100;
    const bars = formatSpot(t, 'BARS', ctx);
    const relu = parseSpot(bars, 'BARS', ctx)!.time;
    expect(Math.round(relu * 44100)).toBe(14999); // l'ancien décalage de 5 échantillons
  });

  for (const sr of RATES) for (const bpm of TEMPOS) {
    it(`${sr} Hz, ${bpm} BPM : toutes les suites de formats rendent l’échantillon de départ`, () => {
      const ctx = { bpm, sr };
      for (const s of SAMPLES) {
        const t = s / sr;
        for (const f0 of FORMATS) for (const f1 of FORMATS) for (const f2 of FORMATS) {
          let f = spotField(t, f0, ctx);
          f = switchSpotFormat(f, f1, ctx, -1);
          f = switchSpotFormat(f, f2, ctx, -1);
          const r = readSpotField(f, ctx)!;
          expect(r.time).toBe(t);
          expect(Math.round(r.time * sr)).toBe(s);
          // Placer sans retoucher : le début tombe exactement sur l'échantillon.
          expect(Math.round(spotStart({ start: 0, duration: 1 }, 'START', r.time)! * sr)).toBe(s);
          // Dans le format Échantillons, le texte affiché est l'échantillon exact.
          expect(switchSpotFormat(f, 'SAMPLES', ctx, -1).text).toBe(String(s));
        }
      }
    });

    it(`${sr} Hz, ${bpm} BPM : une valeur tapée en échantillons est relue exactement`, () => {
      const ctx = { bpm, sr };
      for (const s of SAMPLES) {
        const f = typeSpotField(spotField(0.5, 'SAMPLES', ctx), String(s));
        const r = readSpotField(f, ctx)!;
        expect(Math.round(r.time * sr)).toBe(s);
        // … et repasse par Mesures puis Min:sec sans dériver.
        const back = switchSpotFormat(switchSpotFormat(switchSpotFormat(f, 'BARS', ctx, -1), 'MINSEC', ctx, -1), 'SAMPLES', ctx, -1);
        expect(back.text).toBe(String(s));
      }
    });
  }

  it('un texte retapé est relu tel quel ; retaper le même texte retrouve l’instant exact', () => {
    const ctx = { bpm: 120, sr: 48000 };
    const f = spotField(14994 / 48000, 'BARS', ctx);
    const typed = typeSpotField(f, '8|1|000');
    expect(readSpotField(typed, ctx)!.time).toBeCloseTo(14, 12);
    expect(readSpotField(typeSpotField(typed, f.text), ctx)!.time).toBe(14994 / 48000);
    expect(readSpotField(typeSpotField(f, 'n’importe quoi'), ctx)).toBeNull();
    expect(switchSpotFormat(typeSpotField(f, 'abc'), 'SAMPLES', ctx, 1).text).toBe('48000');
  });
});
