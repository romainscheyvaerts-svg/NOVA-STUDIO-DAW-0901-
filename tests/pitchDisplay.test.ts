import { describe, expect, it } from 'vitest';
import { analyzePitch } from '../utils/pitchAnalysis';
import { displayPitchCurve } from '../utils/pitchCorrect';
import { synthVoice, synthPitchAt } from './helpers/synthVoice';

const SR = 44100;
const f32 = (a: number[]) => Float32Array.from(a);

describe('courbe de justesse affichée : pas de petit pic en fin de note', () => {
  it('trame de bord qui saute (fenêtre à cheval sur le blanc) : masquée, le reste intact', () => {
    // Fin de note réelle relevée sur la preuve V19 : 58,60 58,62 58,61 58,64 puis 59,15, puis silence.
    const v = f32([NaN, 64.16, 63.64, 63.66, 63.68, 63.7, NaN, 58.6, 58.62, 58.61, 58.64, 59.15, NaN]);
    const d = displayPitchCurve(v);
    expect(Number.isNaN(d[1])).toBe(true);   // début de passage qui saute
    expect(Number.isNaN(d[11])).toBe(true);  // fin de passage qui saute
    expect(Array.from(d.slice(2, 6))).toEqual(Array.from(v.slice(2, 6)));
    expect(Array.from(d.slice(7, 11))).toEqual(Array.from(v.slice(7, 11)));
  });
  it('une vraie glissade en bord de passage et les sauts entre notes restent affichés', () => {
    const glide = f32([NaN, 55, 55.2, 55.4, 55.6, 55.8, 56, 58, 58, 58, NaN]);
    expect(Array.from(displayPitchCurve(glide))).toEqual(Array.from(glide));
  });
  it('voix synthétique qui s’arrête net : après filtrage, aucune trame à plus d’un tiers de demi-ton de la note chantée', () => {
    const notes = [{ midi: 57.4, at: 0.1, len: 0.5 }, { midi: 59.6, at: 0.8, len: 0.4 }];
    const x = synthVoice(SR, 1.4, notes);
    const tr = analyzePitch(x, SR);
    const hop = tr.hop / tr.sr;
    const shown = displayPitchCurve(tr.midi);
    let worstRaw = 0, worstShown = 0;
    for (let i = 0; i < tr.midi.length; i++) {
      const truth = synthPitchAt(notes, i * hop);
      if (Number.isNaN(truth) || Number.isNaN(tr.midi[i])) continue;
      worstRaw = Math.max(worstRaw, Math.abs(tr.midi[i] - truth));
      if (!Number.isNaN(shown[i])) worstShown = Math.max(worstShown, Math.abs(shown[i] - truth));
    }
    expect(worstShown).toBeLessThan(0.34);
    expect(worstShown).toBeLessThanOrEqual(worstRaw);
  });
});
