import { describe, expect, it } from 'vitest';
import { analyzePitch, segmentNotes } from '../utils/pitchAnalysis';
import { clampFormant, correctionCurve, formantCurve, hasFormant, isNeutral, NEUTRAL_EDIT, type NoteEdit } from '../utils/pitchCorrect';
import { renderPitch } from '../utils/pitchRender';
import { editsForNotes, storeEdits } from '../utils/pitchEdit';
import { synthVoice } from './helpers/synthVoice';

const SR = 44100;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
function measured(x: Float32Array, t0: number, t1: number): number {
  const tr = analyzePitch(x, SR);
  const v: number[] = [];
  for (let i = 0; i < tr.midi.length; i++) { const t = (i * tr.hop) / SR; if (t >= t0 && t <= t1 && !Number.isNaN(tr.midi[i])) v.push(tr.midi[i]); }
  return median(v);
}
/** Centre de gravité du spectre (Hz) entre 100 Hz et 5 kHz, moyenné sur quelques fenêtres. */
function centroid(x: Float32Array, t0: number, t1: number): number {
  const N = 2048;
  let num = 0, den = 0;
  for (let t = t0; t + N / SR <= t1; t += 0.08) {
    const a = Math.round(t * SR);
    for (let k = Math.round(100 * N / SR); k <= Math.round(5000 * N / SR); k++) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); const s = x[a + i] * w; re += s * Math.cos((2 * Math.PI * k * i) / N); im -= s * Math.sin((2 * Math.PI * k * i) / N); }
      const p = re * re + im * im;
      num += p * (k * SR / N); den += p;
    }
  }
  return num / den;
}

describe('formant par note (éditeur de justesse)', () => {
  const x = synthVoice(SR, 1.0, [{ midi: 57, at: 0.1, len: 0.8 }]);
  const tr = analyzePitch(x, SR);
  const notes = segmentNotes(tr);
  const render = (f: number) => {
    const edits: (NoteEdit | undefined)[] = notes.map(() => ({ ...NEUTRAL_EDIT, formant: f }));
    return renderPitch([x], tr, correctionCurve(tr, notes, edits), undefined, formantCurve(tr, notes, edits))[0];
  };

  it('une note trouvée, formant neutre = rendu identique à l’original', () => {
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const plain = renderPitch([x], tr, correctionCurve(tr, notes, notes.map(() => undefined)))[0];
    const zero = render(0);
    let d = 0;
    for (let i = 0; i < plain.length; i++) d = Math.max(d, Math.abs(plain[i] - zero[i]));
    expect(d).toBe(0);
  });

  it('+5 demi-tons : timbre plus clair, même hauteur ; −5 : plus sombre, même hauteur', () => {
    const c0 = centroid(x, 0.3, 0.7);
    const up = render(5), down = render(-5);
    expect(centroid(up, 0.3, 0.7)).toBeGreaterThan(c0 * 1.12);
    expect(centroid(down, 0.3, 0.7)).toBeLessThan(c0 * 0.9);
    expect(Math.abs(measured(up, 0.3, 0.7) - 57) * 100).toBeLessThan(15);
    expect(Math.abs(measured(down, 0.3, 0.7) - 57) * 100).toBeLessThan(15);
    // Durée inchangée, pas de saturation.
    expect(up.length).toBe(x.length);
    expect(Math.max(...Array.from(up).map(Math.abs))).toBeLessThan(1);
  });

  it('la courbe de formant suit chaque note, avec un fondu aux bords, et 0 ailleurs', () => {
    const edits = notes.map(() => ({ ...NEUTRAL_EDIT, formant: 4 }));
    const fc = formantCurve(tr, notes, edits);
    const n = notes[0];
    const mid = Math.round((n.i0 + n.i1) / 2);
    expect(fc[mid]).toBeCloseTo(4, 5);
    expect(Math.abs(fc[n.i0])).toBeLessThan(4);
    expect(fc[Math.max(0, n.i0 - 2)]).toBe(0);
  });

  it('modèle : neutre, bornes, rangement dans le projet et relecture', () => {
    expect(isNeutral({ ...NEUTRAL_EDIT, formant: 0 })).toBe(true);
    expect(isNeutral({ ...NEUTRAL_EDIT, formant: 2 })).toBe(false);
    expect(hasFormant([undefined, { ...NEUTRAL_EDIT, formant: -1 }])).toBe(true);
    expect(clampFormant(30)).toBe(12);
    expect(clampFormant(-3.333)).toBe(-3.3);
    const stored = storeEdits(notes, notes.map(() => ({ ...NEUTRAL_EDIT, formant: 3 })), 0);
    expect(stored[0].formant).toBe(3);
    expect(editsForNotes(notes, stored, 0)[0]?.formant).toBe(3);
  });
});
