import { describe, expect, it } from 'vitest';
import {
  barSeconds, cutAroundPunch, effectivePostRoll, effectivePreRoll, EMPTY_PUNCH, hasPunchZone, movePunchPoint,
  planRecording, punchFromRange, quickPunchStopDelay, rollBars, rollLabel, trimTake, PUNCH_TAIL_SEC,
} from '../utils/punch';
import { PunchSettings } from '../types';
import { makeClip } from './helpers/fixtures';

const ts = { numerator: 4, denominator: 4 };
const punch = (over: Partial<PunchSettings> = {}): PunchSettings => ({ ...EMPTY_PUNCH, enabled: true, punchIn: 10, punchOut: 14, ...over });

describe('pré-roll / post-roll', () => {
  it('mesure = 2 s à 120 BPM en 4/4, 1,5 s en 3/4', () => {
    expect(barSeconds(120, ts)).toBeCloseTo(2);
    expect(barSeconds(120, { numerator: 3, denominator: 4 })).toBeCloseTo(1.5);
    expect(barSeconds(0)).toBeCloseTo(2);
  });

  it('mesures réglées, sinon secondes d\'un ancien projet, sinon 2 / 1 mesures', () => {
    expect(rollBars({ preRollBars: 4 }, 'pre', 120, ts)).toBe(4);
    expect(rollBars({ preRoll: 4 }, 'pre', 120, ts)).toBe(2);
    expect(rollBars({}, 'pre', 120, ts)).toBe(2);
    expect(rollBars({}, 'post', 120, ts)).toBe(1);
    expect(rollBars({ postRollBars: 0 }, 'post', 120, ts)).toBe(0);
  });

  it('pré-roll non réglé : en punch seulement (comportement d\'avant)', () => {
    expect(effectivePreRoll({}, true, 120, ts)).toBeCloseTo(4);
    expect(effectivePreRoll({}, false, 120, ts)).toBe(0);
    expect(effectivePreRoll({ preRollOn: true, preRollBars: 1 }, false, 120, ts)).toBeCloseTo(2);
    expect(effectivePreRoll({ preRollOn: false }, true, 120, ts)).toBe(0);
    expect(effectivePostRoll({ postRollOn: false }, 120, ts)).toBe(0);
    expect(effectivePostRoll({ postRollBars: 0.5 }, 120, ts)).toBeCloseTo(1);
  });

  it('libellés', () => {
    expect(rollLabel(2, true)).toBe('2');
    expect(rollLabel(0.5, true)).toBe('½');
    expect(rollLabel(2, false)).toBe('off');
  });
});

describe('points de punch', () => {
  it('zone depuis une plage, bornée et ordonnée', () => {
    expect(punchFromRange(EMPTY_PUNCH, 8, 3)).toMatchObject({ enabled: true, punchIn: 3, punchOut: 8 });
    expect(punchFromRange(EMPTY_PUNCH, 3, 3.01)).toBeNull();
    expect(hasPunchZone(punch())).toBe(true);
    expect(hasPunchZone(EMPTY_PUNCH)).toBe(false);
  });

  it('poignées : un point ne passe jamais l\'autre', () => {
    expect(movePunchPoint(punch(), 'IN', 20).punchIn).toBeCloseTo(13.95);
    expect(movePunchPoint(punch(), 'OUT', 2).punchOut).toBeCloseTo(10.05);
    expect(movePunchPoint(punch(), 'IN', -3).punchIn).toBe(0);
  });
});

describe('plan d\'une prise', () => {
  it('punch : pré-roll, zone gardée, arrêt après le post-roll', () => {
    const p = planRecording({ playhead: 0, punch: punch({ preRollBars: 1, postRollBars: 2 }), bpm: 120, ts });
    expect(p).toEqual({ startAt: 8, keepFrom: 10, keepTo: 14, autoStopAt: 18, isPunch: true });
  });

  it('punch sans post-roll : petite marge pour récupérer la latence', () => {
    const p = planRecording({ playhead: 0, punch: punch({ postRollOn: false }), bpm: 120, ts });
    expect(p.autoStopAt).toBeCloseTo(14 + PUNCH_TAIL_SEC);
  });

  it('pré-roll près du début : on ne repart jamais avant 0', () => {
    expect(planRecording({ playhead: 0, punch: punch({ punchIn: 1, punchOut: 3 }), bpm: 120, ts }).startAt).toBe(0);
  });

  it('prise normale : à la tête de lecture, ou avec pré-roll si on l\'a activé', () => {
    expect(planRecording({ playhead: 5, punch: EMPTY_PUNCH, bpm: 120, ts })).toEqual({ startAt: 5, keepFrom: null, keepTo: null, autoStopAt: null, isPunch: false });
    expect(planRecording({ playhead: 5, punch: { ...EMPTY_PUNCH, preRollOn: true, preRollBars: 1 }, bpm: 120, ts }))
      .toMatchObject({ startAt: 3, keepFrom: 5, keepTo: null, isPunch: false });
    // Punch désactivé : la zone est ignorée.
    expect(planRecording({ playhead: 5, punch: punch({ enabled: false }), bpm: 120, ts }).isPunch).toBe(false);
  });
});

describe('découpe de la prise et de l\'ancienne prise (crossfades aux bords)', () => {
  const X = 0.01;

  it('la prise ne garde que la zone, élargie d\'un demi-crossfade', () => {
    const t = trimTake({ start: 7.97, duration: 8, offset: 0, fadeIn: 0.01, fadeOut: 0.01 }, 10, 14, X)!;
    expect(t.start).toBeCloseTo(9.995);
    expect(t.start + t.duration).toBeCloseTo(14.005);
    expect(t.offset).toBeCloseTo(9.995 - 7.97);
    expect(t.fadeIn).toBeCloseTo(X); expect(t.fadeOut).toBeCloseTo(X);
    expect(t.fadeInCurve).toBe('EQUAL_POWER'); expect(t.fadeOutCurve).toBe('EQUAL_POWER');
  });

  it('prise arrêtée avant la zone : rien à garder', () => {
    expect(trimTake({ start: 8, duration: 1.5, offset: 0, fadeIn: 0, fadeOut: 0 }, 10, 14, X)).toBeNull();
  });

  it('prise sans fin (pré-roll seul) : seul le début est coupé', () => {
    const t = trimTake({ start: 3, duration: 6, offset: 0, fadeIn: 0.01, fadeOut: 0.01 }, 5, null, X)!;
    expect(t.start).toBeCloseTo(4.995);
    expect(t.start + t.duration).toBeCloseTo(9);
    expect(t.fadeOut).toBeCloseTo(0.01);
  });

  it('QuickPunch démarré en retard : la prise commence où elle peut, fondu court', () => {
    const t = trimTake({ start: 10.002, duration: 3, offset: 0, fadeIn: 0.01, fadeOut: 0.01 }, 10, 12, X)!;
    expect(t.start).toBeCloseTo(10.002);
    expect(t.fadeIn).toBeCloseTo(0.003);
  });

  it('ancienne prise découpée autour de la zone, crossfades centrés', () => {
    const old = makeClip({ id: 'old', start: 0, duration: 20, offset: 1, fadeIn: 0.2, fadeOut: 0.3 });
    const muted = makeClip({ id: 'm', start: 0, duration: 20, isMuted: true });
    const after = makeClip({ id: 'after', start: 15, duration: 2 });
    const r = cutAroundPunch([old, muted, after], 10, 14, X, 'T');
    expect(r.replaced).toBe(1);
    const a = r.clips.find(c => c.id === 'old-aT')!;
    const b = r.clips.find(c => c.id === 'old-bT')!;
    expect(a.start).toBe(0); expect(a.duration).toBeCloseTo(10.005); expect(a.fadeOut).toBeCloseTo(X); expect(a.fadeIn).toBe(0.2);
    expect(b.start).toBeCloseTo(13.995); expect(b.offset).toBeCloseTo(1 + 13.995); expect(b.fadeIn).toBeCloseTo(X); expect(b.fadeOut).toBe(0.3);
    expect(b.start + b.duration).toBeCloseTo(20);
    expect(r.clips.find(c => c.id === 'm')).toBe(muted);
    expect(r.clips.find(c => c.id === 'after')).toBe(after);
  });

  it('ancienne prise entièrement dans la zone : retirée', () => {
    const r = cutAroundPunch([makeClip({ id: 'x', start: 11, duration: 1 })], 10, 14, X, 'T');
    expect(r.clips).toHaveLength(0);
    expect(r.replaced).toBe(1);
  });

  it('les fondus de l\'ancienne prise et de la nouvelle se croisent exactement', () => {
    const take = trimTake({ start: 6, duration: 10, offset: 0, fadeIn: 0.01, fadeOut: 0.01 }, 10, 14, X)!;
    const { clips } = cutAroundPunch([makeClip({ id: 'o', start: 0, duration: 20 })], 10, 14, X, 'T');
    const before = clips[0], after = clips[1];
    // Fin de l'ancienne = fin du fondu d'entrée de la nouvelle ; début de l'ancienne (après) = début du fondu de sortie.
    expect(before.start + before.duration).toBeCloseTo(take.start + take.fadeIn);
    expect(after.start).toBeCloseTo(take.start + take.duration - take.fadeOut);
  });

  it('QuickPunch : on capte encore la latence et la moitié du crossfade', () => {
    expect(quickPunchStopDelay(0.03, 0.01)).toBeCloseTo(0.095);
    expect(quickPunchStopDelay(-1, 0)).toBeCloseTo(0.06);
  });
});
