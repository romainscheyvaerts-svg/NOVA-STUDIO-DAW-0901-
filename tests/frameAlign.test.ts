import { describe, expect, it } from 'vitest';
import { applyGainEvents, clipGainEvents, frameAlignedCurve, frameTime, nearestFrame, FRAME_CURVE_MAX } from '../utils/fades';
import { createKeepAlive, KEEPALIVE_HOLD_S } from '../engine/keepAlive';
import { makeClip } from './helpers/fixtures';

const audio = (over: Parameters<typeof makeClip>[0] = {}) => makeClip({ bufferId: 'buf', ...over });

describe('Lecture = export : temps posés sur les échantillons (utils/fades)', () => {
  it('demi-échantillon : toujours arrondi vers le haut, quel que soit le bruit de calcul', () => {
    // Fondu de 5 ms à 44,1 kHz : fin à 13 450,5 échantillons après un clip à 0,3 s.
    const t = 0.305;
    expect(nearestFrame(t, 44100)).toBe(13451);
    expect(nearestFrame(t + 1e-13, 44100)).toBe(13451);
    expect(nearestFrame(t - 1e-13, 44100)).toBe(13451);
    // Même instant lu sur une horloge déjà avancée (lecture, origine posée sur un échantillon) : même décision.
    const zero = 54444439 / 44100;
    expect(nearestFrame(zero + t, 44100) - nearestFrame(zero, 44100)).toBe(13451);
    expect(nearestFrame(0.3, 48000)).toBe(14400);
  });

  it('frameTime : instant × fréquence tombe pile sur l’échantillon (au bit près quand ce flottant existe)', () => {
    // Pour une part des échantillons, AUCUN flottant x ne donne x × fréquence = f exactement
    // (mesuré : environ 1 départ sur 10 en lecture) ; on s'en approche alors à 1e-6 près.
    for (const sr of [44100, 48000, 96000]) {
      let exact = 0, n = 0;
      for (let k = 0; k < 400; k++) {
        const t = 0.3 + k * 0.0123457 + (k % 3) * 1e-12;
        const x = frameTime(t, sr);
        const f = nearestFrame(t, sr);
        expect(Math.abs(x * sr - f)).toBeLessThan(1e-6);
        if (x * sr === f) exact++;
        n++;
      }
      expect(exact / n).toBeGreaterThan(0.75);
    }
    expect(frameTime(0.5, 44100) * 44100).toBe(22050);
    expect(frameTime(NaN, 48000)).toBeNaN();
    expect(frameTime(1.5, 0)).toBe(1.5);
  });

  it('frameAlignedCurve : un point par échantillon, mêmes valeurs en lecture et à l’export', () => {
    const coarse = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const sr = 44100;
    const live = frameAlignedCurve(coarse, 43555555 / sr + 0.3, 0.005, sr)!;
    const exp = frameAlignedCurve(coarse, 0.3, 0.005, sr)!;
    expect(live).not.toBeNull();
    // 5 ms à 44,1 kHz = 220,5 échantillons : 221 (demi vers le haut), donc 222 points.
    expect(exp.values.length).toBe(222);
    expect(Array.from(live.values)).toEqual(Array.from(exp.values));
    expect(exp.values[0]).toBe(0);
    expect(exp.values[exp.values.length - 1]).toBe(1);
    // Début sur un échantillon, fin jamais au-delà de l'échantillon de fin.
    expect(Math.abs(exp.at * sr - Math.round(exp.at * sr))).toBeLessThan(1e-6);
    expect(exp.at + exp.d).toBeLessThanOrEqual(frameTime(nearestFrame(0.305, sr) / sr, sr));
    // Courbe trop longue : points d'origine gardés.
    expect(frameAlignedCurve(coarse, 0, (FRAME_CURVE_MAX + 10) / sr, sr)).toBeNull();
  });

  it('applyGainEvents avec la fréquence : courbes recalées ; sans elle, ancien comportement', () => {
    const ev = clipGainEvents(audio({ duration: 1, fadeIn: 0.01, fadeOut: 0.02 }), 0);
    const curves: [number, number, number][] = [];
    const param = {
      setValueAtTime: () => {},
      setValueCurveAtTime: (v: Float32Array | number[], t: number, d: number) => { curves.push([v.length, t, d]); },
    };
    applyGainEvents(param, ev, 100, 48000);
    expect(curves.map(c => c[0])).toEqual([481, 961]);
    // Fin du fondu d'entrée <= début du fondu de sortie (aucun chevauchement).
    expect(curves[0][1] + curves[0][2]).toBeLessThanOrEqual(curves[1][1]);
    curves.length = 0;
    applyGainEvents(param, ev, 100);
    expect(curves.map(c => c[0])).toEqual([(ev[0] as any).values.length, (ev[1] as any).values.length]);
  });
});

describe('Source muette des chaînes (engine/keepAlive)', () => {
  it('offset 0 tenu par une automation (bloc calculé, pas « silencieux ») et démarré', () => {
    const calls: string[] = [];
    const offset = {
      value: 1,
      setValueAtTime: (v: number, t: number) => calls.push(`set ${v}@${t}`),
      linearRampToValueAtTime: (v: number, t: number) => calls.push(`ramp ${v}@${t}`),
    };
    const node = { offset, start: (t: number) => calls.push(`start ${t}`) };
    const ka = createKeepAlive({ createConstantSource: () => node } as any);
    expect(ka).toBe(node);
    expect(offset.value).toBe(0);
    expect(calls).toEqual(['set 0@0', `ramp 0@${KEEPALIVE_HOLD_S}`, 'start 0']);
  });

  it('contexte simulé sans automation : offset 0 fixe, la source démarre quand même', () => {
    const calls: string[] = [];
    const node = { offset: { value: 1 }, start: (t: number) => calls.push(`start ${t}`) };
    createKeepAlive({ createConstantSource: () => node } as any);
    expect(node.offset.value).toBe(0);
    expect(calls).toEqual(['start 0']);
  });
});
