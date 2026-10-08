import { describe, expect, it } from 'vitest';
import { clippedShare, compareScores, findRedoSpots, splitPhrases } from '../utils/repunch';
import { redoPunchZone, EMPTY_PUNCH, planRecording } from '../utils/punch';
import { synthVoice, SynthNote } from './helpers/synthVoice';

const SR = 44100;
const BPM = 100;
const BEAT = 60 / BPM;

/**
 * Prise de 4 phrases (une par 2 mesures) en La mineur, notes sur les croches.
 * La phrase `bad` est chantée 45 cents trop haut et 90 ms en retard.
 */
function take(bad: number | null, opts: { origin?: number; clipPhrase?: number } = {}) {
  const o = opts.origin ?? 0;
  const scale = [57, 59, 60, 62, 64, 65, 67, 69];
  const notes: SynthNote[] = [];
  for (let ph = 0; ph < 4; ph++) {
    const t0 = o + ph * 8 * BEAT;
    for (let k = 0; k < 6; k++) {
      const late = ph === bad ? 0.09 : 0;
      const detune = ph === bad ? 0.45 : 0;
      notes.push({ midi: scale[(k * 3 + ph) % scale.length] + detune, at: t0 + k * BEAT / 2 * 2 + late, len: BEAT * 0.8 });
    }
  }
  const x = synthVoice(SR, o + 4 * 8 * BEAT + 0.5, notes, { amp: 0.3, noise: 0.0005 });
  if (opts.clipPhrase !== undefined) {
    const a = Math.round((o + opts.clipPhrase * 8 * BEAT + 0.2) * SR);
    for (let i = a; i < a + SR; i++) x[i] = Math.max(-1, Math.min(1, x[i] * 8));
  }
  return x;
}

describe('repères « à refaire »', () => {
  it('phrases coupées dans les silences', () => {
    const ph = splitPhrases(take(null), SR, 0, BPM);
    expect(ph.length).toBe(4);
    ph.forEach((p, i) => expect(Math.abs(p.start - i * 8 * BEAT)).toBeLessThan(0.05));
  });

  it('une phrase fausse et décalée est repérée (justesse, calage), les autres non', () => {
    const spots = findRedoSpots(take(2), SR, 0, { trackId: 'v', bpm: BPM, key: { root: 9, scale: 'MINOR' } });
    expect(spots.length).toBe(1);
    expect(spots[0].start).toBeGreaterThan(2 * 8 * BEAT - 0.1);
    expect(spots[0].end).toBeLessThan(3 * 8 * BEAT + 0.1);
    expect(spots[0].reasons).toEqual(expect.arrayContaining(['justesse', 'calage']));
    expect(spots[0].label).toMatch(/^Justesse/);
  });

  it('une prise propre : rien à refaire', () => {
    expect(findRedoSpots(take(null), SR, 0, { trackId: 'v', bpm: BPM, key: { root: 9, scale: 'MINOR' } })).toEqual([]);
  });

  it('la grille part du premier temps du beat', () => {
    // Beat dont le 1er temps est à 0,23 s : la prise est calée dessus.
    const x = take(null, { origin: 0.23 });
    expect(findRedoSpots(x, SR, 0, { trackId: 'v', bpm: BPM, gridOrigin: 0.23 }).filter(s => s.reasons.includes('calage'))).toEqual([]);
    const off = findRedoSpots(x, SR, 0, { trackId: 'v', bpm: BPM, gridOrigin: 0, thresholds: { timing: 90 } });
    expect(off.some(s => s.reasons.includes('calage'))).toBe(true);
  });

  it('saturation repérée', () => {
    const spots = findRedoSpots(take(null, { clipPhrase: 1 }), SR, 0, { trackId: 'v', bpm: BPM });
    expect(spots.length).toBeGreaterThanOrEqual(1);
    expect(spots[0].reasons).toContain('saturation');
    expect(clippedShare(new Float32Array([1, 1, 1, 0, 0.99, 0.99]))).toBeCloseTo(0.5, 6);
  });

  it('avant / après', () => {
    const a = { total: 50, pitch: 40, timing: 45, level: 70, noise: 70 };
    const b = { total: 80, pitch: 85, timing: 80, level: 70, noise: 70 };
    expect(compareScores(a, b).better).toBe('new');
    expect(compareScores(a, b).text).toMatch(/justesse, calage/);
    expect(compareScores(b, a).better).toBe('old');
    expect(compareScores(a, { ...a, total: 52 }).better).toBe('same');
    expect(compareScores(null, a).better).toBe('same');
  });
});

describe('« Refaire ce passage » : la zone de punch', () => {
  it('bords sur les temps qui encadrent le passage, pré-roll d’au moins une mesure', () => {
    const p = redoPunchZone({ ...EMPTY_PUNCH }, { start: 4.83, end: 7.1 }, BPM);
    expect(p.enabled).toBe(true);
    expect(p.punchIn).toBeCloseTo(4.2, 6);
    expect(p.punchOut).toBeCloseTo(7.2, 6);
    expect(p.preRollOn).toBe(true);
    // Pré-roll par défaut : 2 mesures (gardé).
    const plan = planRecording({ playhead: 0, punch: p, bpm: BPM });
    expect(plan.isPunch).toBe(true);
    expect(plan.startAt).toBe(0);
    expect(plan.keepFrom).toBeCloseTo(4.2, 6);
    // Pré-roll coupé ou trop court : une mesure.
    const q = redoPunchZone({ ...EMPTY_PUNCH, preRollSec: 0.5 }, { start: 8, end: 9 }, BPM);
    expect(q.preRollBars).toBe(1);
    expect(q.preRollSec).toBeUndefined();
    expect(planRecording({ playhead: 0, punch: q, bpm: BPM }).startAt).toBeCloseTo(q.punchIn - 2.4, 6);
  });
  it('grille décalée du premier temps ; pré-roll réglé gardé ; jamais avant 0', () => {
    const p = redoPunchZone({ ...EMPTY_PUNCH, preRollSec: 3 }, { start: 1.0, end: 1.5 }, BPM, undefined, 0.23);
    expect(p.punchIn).toBeCloseTo(0.83, 6);
    expect(p.punchOut).toBeCloseTo(2.03, 6);
    expect(p.preRollSec).toBe(3);
    expect(redoPunchZone({ ...EMPTY_PUNCH }, { start: 0.01, end: 0.4 }, BPM).punchIn).toBe(0);
  });
});
