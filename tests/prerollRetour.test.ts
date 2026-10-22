import { describe, expect, it } from 'vitest';
import { planRecording, recordReturnPoint } from '../utils/punch';

/**
 * Séance d'enregistrement voix (audit du 22/10/2026) : avec un pré-roll, chaque reprise repartait 2 s plus tôt (10 s → 8 s → 6 s).
 */

describe('Pré-roll : chaque reprise repart du même point (utils/punch.recordReturnPoint)', () => {
  const punch = { enabled: false, punchIn: 0, punchOut: 0, preRoll: 0, postRoll: 0, preRollOn: true, preRollSec: 2 };
  it('sans punch : retour au point d’enregistrement (10 s), pas au début du pré-roll (8 s)', () => {
    let at = 10;
    for (let i = 0; i < 3; i++) {
      const plan = planRecording({ playhead: at, punch, bpm: 90 });
      expect(plan.startAt).toBeCloseTo(8);
      at = recordReturnPoint(plan);
      expect(at).toBeCloseTo(10);
    }
  });
  it('sans pré-roll : le début de la prise ; en punch : le début du pré-roll (la zone décide)', () => {
    expect(recordReturnPoint(planRecording({ playhead: 5, punch: { ...punch, preRollOn: false }, bpm: 90 }))).toBeCloseTo(5);
    const p = planRecording({ playhead: 0, punch: { ...punch, enabled: true, punchIn: 6, punchOut: 8 }, bpm: 90 });
    expect(recordReturnPoint(p)).toBeCloseTo(4);
  });
});
