import { describe, expect, it } from 'vitest';
import { buildTempoMap, barToTime, beatsInRange, quartersToTime, timeToQuarters } from '../utils/tempoMap';
import { rollFollowsMap, mapSnap, mapCell, mapGridLines, mapSnapBeat, spanQuarters, mapBarBeat } from '../utils/rollGrid';
import { quantize } from '../utils/midiTools';
import type { MidiNote } from '../types';

// Rampe 120 → 100 BPM sur les mesures 1 à 4 (arrivée au début de la mesure 5), puis 100 fixe.
const ramp = buildTempoMap(120, { numerator: 4, denominator: 4 }, [{ id: 'r', bar: 4, bpm: 100, ramp: true }]);
const q2t = (q: number) => quartersToTime(ramp, q);

describe('piano roll : grille sur la carte de tempo réelle (rampes)', () => {
  it('ne suit la carte que si elle n\'est pas un simple 4/4 à tempo fixe, et si c\'est bien celle du projet', () => {
    expect(rollFollowsMap(buildTempoMap(120, { numerator: 4, denominator: 4 }, []), 120)).toBe(false);
    expect(rollFollowsMap(ramp, 120)).toBe(true);
    expect(rollFollowsMap(ramp, 90)).toBe(false);   // carte d'un autre projet (pas encore à jour)
    expect(rollFollowsMap(buildTempoMap(120, { numerator: 7, denominator: 8 }, []), 120)).toBe(true);
  });

  it('traits de mesure, de temps et de doubles-croches = ceux de l\'arrangement (au µs près)', () => {
    const t1 = barToTime(ramp, 6);
    const L = mapGridLines(ramp, 0, t1, '1/16');
    expect(L.bars.map(b => b.bar)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    L.bars.forEach(b => expect(b.time).toBeCloseTo(barToTime(ramp, b.bar), 9));
    const beats = beatsInRange(ramp, 0, t1).filter(b => !b.downbeat).map(b => b.time);
    expect(L.beats).toEqual(beats);
    // Doubles-croches : chaque trait tombe sur une position exacte en noires (k × 0,25), aucune régulière.
    expect(L.subs.length).toBe(6 * 12);
    L.subs.forEach(t => { const q = timeToQuarters(ramp, t); expect(Math.abs(q * 4 - Math.round(q * 4))).toBeLessThan(1e-6); });
    // Dans la rampe (ralentissement), les cases s'allongent : la grille d'avant (tempo du début du clip) dérivait.
    const regular = 0.125;   // 1/16 à 120 BPM
    expect(q2t(15) - regular * 30).toBeGreaterThan(0.1);   // > 100 ms d'écart à la mesure 4 avec l'ancienne grille
  });

  it('aimantation : trait le plus proche et case cliquée, exacts dans la rampe', () => {
    for (const q of [1.37, 5.62, 9.13, 13.88, 15.5]) {
      const t = q2t(q);
      expect(mapSnap(ramp, t, '1/16')).toBeCloseTo(q2t(Math.round(q * 4) / 4), 9);
      expect(mapSnap(ramp, t, '1/16', 'floor')).toBeCloseTo(q2t(Math.floor(q * 4) / 4), 9);
      const [a, b] = mapCell(ramp, t, '1/16');
      expect(a).toBeCloseTo(q2t(Math.floor(q * 4) / 4), 9);
      expect(b).toBeCloseTo(q2t(Math.floor(q * 4) / 4 + 0.25), 9);
    }
    // Cases plus longues en fin de ralentissement qu'au début.
    const [a0, b0] = mapCell(ramp, 0.01, '1/16');
    const [a1, b1] = mapCell(ramp, q2t(15.1), '1/16');
    expect(b1 - a1).toBeGreaterThan(b0 - a0);
    expect(spanQuarters(ramp, q2t(8), 1)).toBeCloseTo(q2t(9) - q2t(8), 9);
    expect(mapSnapBeat(ramp, q2t(6.4))).toBeCloseTo(q2t(6), 9);
  });

  it('mesures composées (7/8) : la grille à la noire repart à chaque mesure', () => {
    const m = buildTempoMap(120, { numerator: 7, denominator: 8 }, []);
    const bar1 = barToTime(m, 1);   // 3,5 noires = 1,75 s
    expect(bar1).toBeCloseTo(1.75, 9);
    expect(mapSnap(m, bar1 + 0.49, '1/4')).toBeCloseTo(bar1 + 0.5, 9);
    expect(mapSnap(m, bar1 - 0.1, '1/4')).toBeCloseTo(bar1, 9);   // trait « boiteux » : le début de mesure est plus proche
    expect(mapBarBeat(m, bar1 + 0.26)).toEqual({ bar: 1, beat: 1 });
  });

  it('quantification : sur les traits de la carte (swing compris) ; sans carte, inchangée', () => {
    const clipStart = q2t(4);
    const notes: MidiNote[] = [5.13, 9.6, 13.07].map((q, i) => ({ id: `n${i}`, pitch: 60, start: q2t(q) - clipStart, duration: 0.1, velocity: 0.8 }));
    const out = quantize(notes, null, { bpm: 120, clipStart, tempoMap: ramp }, { grid: '1/16', strength: 1, swing: 50 });
    [5.25, 9.5, 13].forEach((q, i) => expect(clipStart + out[i].start).toBeCloseTo(q2t(q), 9));
    const sw = quantize(notes, null, { bpm: 120, clipStart, tempoMap: ramp }, { grid: '1/16', strength: 1, swing: 75 });
    expect(clipStart + sw[0].start).toBeCloseTo(q2t(5.25 + 0.125), 9);   // trait impair : retardé d'un demi-pas
    const plain = quantize(notes, null, { bpm: 120, clipStart }, { grid: '1/16', strength: 1, swing: 50 });
    plain.forEach(n => expect(Math.abs((clipStart + n.start) / 0.125 - Math.round((clipStart + n.start) / 0.125))).toBeLessThan(1e-9));
  });
});
