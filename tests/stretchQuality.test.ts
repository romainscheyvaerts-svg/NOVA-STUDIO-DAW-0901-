/**
 * L5 · écart 19 · Qualité d'étirement prouvée : le banc (tests/helpers/stretchBench)
 * mesure le moteur « rapide » (WSOLA d'origine) et le moteur « haute qualité »
 * (vocodeur de phase par morceaux, attaques recopiées) à −20 % et +20 % :
 * attaques de batterie à leur place (±2 ms), pas de pré-écho ni d'attaque
 * dédoublée, image stéréo gardée, voix sans effet « phasé », partiels stables.
 */
import { describe, expect, it } from 'vitest';
import { etirerCanaux } from '../utils/timeStretch';
import { chord, crestDb, drums, onsetReport, partialReport, pulses, SR, stereoCoherence, stereoPulses } from './helpers/stretchBench';

type Q = 'haute' | 'rapide';
const measure = (q: Q, f: number) => {
  const d = drums(3);
  const t0 = performance.now();
  const yd = etirerCanaux([d.x], f, q, SR)[0];
  const ms = performance.now() - t0;
  const p = pulses(2);
  const yp = etirerCanaux([p], f, q, SR)[0];
  const yc = etirerCanaux([chord(2)], f, q, SR)[0];
  const [L, R] = stereoPulses(2);
  const ys = etirerCanaux([L, R], f, q, SR);
  return {
    len: yd.length, expectedLen: Math.round(d.x.length * f),
    on: onsetReport(yd, d.onsets.map(t => t * f)),
    crest: crestDb(yp) - crestDb(p),
    part: partialReport(yc, [220, 330, 550]),
    stereo: stereoCoherence(ys[0], ys[1]),
    ms,
  };
};

describe('Étirement : banc de mesure', () => {
  for (const f of [0.8, 1.25]) {
    it(`facteur ${f} : la haute qualité tient les objectifs, et bat le WSOLA d'origine`, () => {
      const hq = measure('haute', f), old = measure('rapide', f);
      for (const [n, m] of [['rapide (WSOLA)', old], ['haute qualité', hq]] as const) {
        console.log(`[étirement ×${f}] ${n.padEnd(15)} attaques ${m.on.meanErrMs.toFixed(2)} ms (max ${m.on.maxErrMs.toFixed(2)}) · pré-écho ${m.on.preEchoDb.toFixed(1)} dB · dédoublées ${m.on.doubled} · crête voix ${m.crest >= 0 ? '+' : ''}${m.crest.toFixed(2)} dB · ondulation ${m.part.wobbleDb.toFixed(2)} dB · hauteur ${m.part.centsErr.toFixed(2)} ct · stéréo ${m.stereo.toFixed(4)} · ${m.ms.toFixed(0)} ms pour 3 s`);
      }
      expect(hq.len).toBe(hq.expectedLen);
      // Attaques de batterie à ±2 ms, ni pré-écho, ni attaque dédoublée.
      expect(hq.on.maxErrMs).toBeLessThanOrEqual(2);
      expect(hq.on.preEchoDb).toBeLessThan(-30);
      expect(hq.on.doubled).toBe(0);
      // Voix : pas d'effet « phasé » (la crête des impulsions reste à ±1 dB) ; partiels stables, hauteur exacte.
      expect(Math.abs(hq.crest)).toBeLessThan(1);
      expect(hq.part.wobbleDb).toBeLessThan(0.1);
      expect(hq.part.centsErr).toBeLessThan(1);
      // Image stéréo gardée.
      expect(hq.stereo).toBeGreaterThan(0.99);
      // Mieux que l'ancien moteur, mesurablement.
      expect(hq.on.meanErrMs).toBeLessThan(old.on.meanErrMs / 4);
      expect(hq.stereo).toBeGreaterThan(old.stereo + 0.5);
    });
  }

  it('« rapide » reste le WSOLA d’origine (sons déjà rendus : rien ne change sans action)', () => {
    const x = chord(1);
    const a = etirerCanaux([x], 1.1, 'rapide');
    const b = etirerCanaux([x], 1.1, 'rapide', 44100);
    expect(a[0].length).toBe(Math.round(x.length * 1.1));
    expect(Array.from(a[0].subarray(0, 4096))).toEqual(Array.from(b[0].subarray(0, 4096)));
  });
});
