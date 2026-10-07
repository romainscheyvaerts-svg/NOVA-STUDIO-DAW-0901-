import { describe, expect, it } from 'vitest';
import { analyzePitch, segmentNotes } from '../utils/pitchAnalysis';
import { autoCorrect, correctionCurve, nearestScaleNote, nudgeEdit, snapEdit, NEUTRAL_EDIT } from '../utils/pitchCorrect';
import { renderPitch, pitchMarks } from '../utils/pitchRender';
import { synthVoice, SynthNote } from './helpers/synthVoice';

const SR = 44100;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

/** Hauteur médiane mesurée (MIDI) entre deux instants. */
function measured(x: Float32Array, t0: number, t1: number): number {
  const tr = analyzePitch(x, SR);
  const v: number[] = [];
  for (let i = 0; i < tr.midi.length; i++) {
    const t = (i * tr.hop) / SR;
    if (t >= t0 && t <= t1 && !Number.isNaN(tr.midi[i])) v.push(tr.midi[i]);
  }
  return median(v);
}

describe('analyse de hauteur', () => {
  it('mesure une note au cent près', () => {
    for (const midi of [45.4, 57.4, 64.37, 72.8]) {
      const x = synthVoice(SR, 0.6, [{ midi, at: 0.05, len: 0.5 }]);
      expect(Math.abs(measured(x, 0.15, 0.45) - midi) * 100).toBeLessThan(1.5);
    }
  });

  it('ne trouve pas de hauteur dans le silence ou le souffle', () => {
    const x = synthVoice(SR, 0.5, [], { noise: 0.02 });
    const tr = analyzePitch(x, SR);
    expect(Array.from(tr.midi).filter(v => !Number.isNaN(v)).length).toBeLessThan(tr.midi.length * 0.05);
  });
});

describe('découpage en notes', () => {
  it('trois notes liées avec glissades et vibrato = trois notes', () => {
    const notes: SynthNote[] = [
      { midi: 57.3, at: 0.1, len: 0.5, vibratoCents: 35, vibratoHz: 5.5 },
      { midi: 60.2, at: 0.6, len: 0.4, glide: 0.06 },
      { midi: 62.1, at: 1.0, len: 0.6, glide: 0.08, vibratoCents: 40 },
    ];
    const x = synthVoice(SR, 1.8, notes);
    const found = segmentNotes(analyzePitch(x, SR));
    expect(found.length).toBe(3);
    found.forEach((n, k) => {
      expect(Math.abs(n.center - notes[k].midi)).toBeLessThan(0.12);
      expect(Math.abs(n.start - notes[k].at)).toBeLessThan(0.08);
    });
  });

  it('deux syllabes séparées par un silence = deux notes', () => {
    const x = synthVoice(SR, 1.2, [{ midi: 60, at: 0.1, len: 0.4 }, { midi: 60, at: 0.6, len: 0.4 }]);
    expect(segmentNotes(analyzePitch(x, SR)).length).toBe(2);
  });
});

describe('gamme et corrections', () => {
  it('note de la gamme la plus proche', () => {
    // La mineur : La Si Do Ré Mi Fa Sol.
    expect(nearestScaleNote(57.4, 9, 'MINOR')).toBe(57);
    expect(nearestScaleNote(56.4, 9, 'MINOR')).toBe(57); // Sol# hors gamme → La
    expect(nearestScaleNote(61.6, 9, 'MINOR')).toBe(62); // Do# → Ré
    expect(nearestScaleNote(60.6, 9, 'MINOR')).toBe(60); // Do + 60 cents → Do
    expect(nearestScaleNote(61.4)).toBe(61); // tonalité inconnue : chromatique
  });

  const note = (center: number) => ({ index: 0, i0: 0, i1: 10, start: 0, end: 0.05, center, spread: 0 });

  it('tout corriger : dosage et style', () => {
    const notes = [note(57.4), note(59.8)];
    const full = autoCorrect(notes, { root: 9, scale: 'MINOR' }, 1, 'naturel');
    expect(full[0].shift).toBeCloseTo(-0.4, 6);
    expect(full[1].shift).toBeCloseTo(0.2, 6);
    expect(full[0].vibrato).toBe(1);
    const half = autoCorrect(notes, { root: 9, scale: 'MINOR' }, 0.5, 'naturel');
    expect(half[0].shift).toBeCloseTo(-0.2, 6);
    const robot = autoCorrect(notes, { root: 9, scale: 'MINOR' }, 1, 'robot');
    expect(robot[0]).toMatchObject({ drift: 1, vibrato: 0, transitionMs: 0 });
    const none = autoCorrect(notes, { root: 9, scale: 'MINOR' }, 0, 'robot');
    expect(none[0].shift).toBeCloseTo(0, 6);
    expect(none[0].vibrato).toBe(1);
  });

  it('monter / descendre au demi-ton ou au cent', () => {
    const n = note(57.4);
    expect(nudgeEdit(n, NEUTRAL_EDIT, 1, 'semitone').shift).toBeCloseTo(0.6, 6);   // → 58
    expect(nudgeEdit(n, NEUTRAL_EDIT, -1, 'semitone').shift).toBeCloseTo(-0.4, 6); // → 57
    const on = nudgeEdit(n, NEUTRAL_EDIT, -1, 'semitone');
    expect(nudgeEdit(n, on, -1, 'semitone').shift).toBeCloseTo(-1.4, 6);          // 57 → 56
    expect(nudgeEdit(n, NEUTRAL_EDIT, 5, 'cent').shift).toBeCloseTo(0.05, 6);
    expect(snapEdit(note(61.6), NEUTRAL_EDIT, { root: 9, scale: 'MINOR' }).shift).toBeCloseTo(0.4, 6);
  });

  it('courbe : décalage constant, vibrato retiré, aucune correction hors des notes', () => {
    const x = synthVoice(SR, 1.0, [{ midi: 57.4, at: 0.1, len: 0.8, vibratoCents: 40 }]);
    const tr = analyzePitch(x, SR);
    const notes = segmentNotes(tr);
    expect(notes.length).toBe(1);
    const curve = correctionCurve(tr, notes, [{ shift: -0.4, drift: 1, vibrato: 0 }]);
    // Hauteur visée bien droite au cœur de la note.
    const tgt: number[] = [];
    for (let i = notes[0].i0 + 30; i < notes[0].i1 - 30; i++) tgt.push(tr.midi[i] + curve[i]);
    const dev = Math.max(...tgt.map(v => Math.abs(v - 57)));
    expect(dev).toBeLessThan(0.08);
    expect(curve[2]).toBe(0);
  });
});

describe('rendu PSOLA', () => {
  it('sans correction : sortie identique à l’entrée', () => {
    const x = synthVoice(SR, 0.8, [{ midi: 57, at: 0.1, len: 0.6, vibratoCents: 30 }], { noise: 0.003 });
    const tr = analyzePitch(x, SR);
    const [y] = renderPitch([x], tr, new Float32Array(tr.midi.length));
    expect(y.length).toBe(x.length);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    expect(err).toBeLessThan(1e-5);
  });

  it('voix fausse de 40 cents corrigée à moins de 5 cents, même durée', () => {
    const notes: SynthNote[] = [
      { midi: 57.4, at: 0.1, len: 0.45 },
      { midi: 59.4, at: 0.55, len: 0.45, glide: 0.05 },
      { midi: 60.4, at: 1.0, len: 0.5, glide: 0.05 },
    ];
    const x = synthVoice(SR, 1.7, notes);
    const tr = analyzePitch(x, SR);
    const found = segmentNotes(tr);
    expect(found.length).toBe(3);
    const edits = autoCorrect(found, { root: 9, scale: 'MINOR' }, 1, 'naturel');
    const [y] = renderPitch([x], tr, correctionCurve(tr, found, edits));
    expect(y.length).toBe(x.length);
    const want = [57, 59, 60];
    notes.forEach((n, k) => {
      const got = measured(y, n.at + 0.12, n.at + n.len - 0.08);
      expect(Math.abs(got - want[k]) * 100).toBeLessThan(5);
    });
  });

  it('note avec vibrato : le centre corrigé tombe juste (moyenne perçue, pas la médiane)', () => {
    const x = synthVoice(SR, 1.0, [{ midi: 63.6, at: 0.1, len: 0.6, vibratoCents: 15, vibratoHz: 5.5 }]);
    const tr = analyzePitch(x, SR);
    const found = segmentNotes(tr);
    const [y] = renderPitch([x], tr, correctionCurve(tr, found, autoCorrect(found, { root: 9, scale: 'MINOR' }, 1, 'naturel')));
    // Hauteur perçue = moyenne sur des cycles entiers de vibrato (3 cycles de 5,5 Hz).
    const t2 = analyzePitch(y, SR);
    const v: number[] = [];
    for (let i = 0; i < t2.midi.length; i++) { const t = (i * t2.hop) / SR; if (t >= 0.2 && t < 0.2 + 3 / 5.5 && !Number.isNaN(t2.midi[i])) v.push(t2.midi[i]); }
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.abs(mean - 64) * 100).toBeLessThan(3);
  });

  it('marques de période : une par cycle dans une note', () => {
    const x = synthVoice(SR, 0.5, [{ midi: 57, at: 0.05, len: 0.4 }]);
    const tr = analyzePitch(x, SR);
    const m = pitchMarks(x, tr);
    const P = SR / 220;
    const gaps: number[] = [];
    for (let k = 1; k < m.pos.length; k++) if (m.voiced[k] && m.voiced[k - 1]) gaps.push(m.pos[k] - m.pos[k - 1]);
    expect(Math.abs(median(gaps) - P)).toBeLessThan(1.5);
  });
});

describe('gamme devinée d’après la voix', () => {
  it('mélodie en la mineur', async () => {
    const { guessKey } = await import('../utils/pitchCorrect');
    const mk = (centers: number[]) => centers.map((c, i) => ({ index: i, i0: 0, i1: 1, start: i * 0.4, end: i * 0.4 + (c % 12 === 9 ? 0.6 : 0.3), center: c, spread: 0 }));
    expect(guessKey(mk([57, 60, 64, 62, 60, 59, 57, 55, 57, 64, 65, 64, 57]))).toEqual({ root: 9, scale: 'MINOR' });
    expect(guessKey(mk([60]))).toBeNull();
  });
});

describe('timbre gardé (formants, aigus)', () => {
  it('note corrigée dans une mélodie : les harmoniques suivent toujours la voyelle (aigus compris)', async () => {
    const { harmonicsVsEnvelope } = await import('./helpers/spectrum');
    const M: [number, number, number, number, number, number][] = [[57, 40, 0.5, 0.55, 0, 10], [60, -40, 1.05, 0.45, 0.05, 0], [62, 40, 1.5, 0.5, 0.06, 12], [64, -40, 2.2, 0.6, 0, 15]];
    const x = synthVoice(SR, 3.0, M.map(([m, c, at, len, glide, vib]) => ({ midi: m + c / 100, at, len, glide, vibratoCents: vib })));
    const tr = analyzePitch(x, SR);
    const notes = segmentNotes(tr);
    const [y] = renderPitch([x], tr, correctionCurve(tr, notes, autoCorrect(notes, { root: 9, scale: 'MINOR' }, 1, 'naturel')));
    for (const [m, c, at, len] of M) {
      const a = harmonicsVsEnvelope(x, SR, at + 0.08, at + len - 0.05, 440 * 2 ** ((m + c / 100 - 69) / 12));
      const b = harmonicsVsEnvelope(y, SR, at + 0.08, at + len - 0.05, 440 * 2 ** ((m - 69) / 12));
      const n = Math.min(a.length, b.length);
      // Écart harmonique par harmonique (avant la correction, après) : jamais plus de 3,5 dB,
      // moins de 1,5 dB en moyenne sur les aigus (au-dessus de la 8e harmonique, ~2 kHz).
      // Avant le recalage des marques sur les impulsions, la 1re note perdait 10 dB vers 3-4 kHz.
      for (let h = 0; h < n; h++) expect(Math.abs(b[h] - a[h])).toBeLessThan(3.5);
      const hi = Array.from({ length: n - 8 }, (_, k) => Math.abs(b[k + 8] - a[k + 8]));
      expect(hi.reduce((s, v) => s + v, 0) / hi.length).toBeLessThan(1.5);
    }
  });

  it('note montée de 4 demi-tons : formants à leur place (contre l’effet « chipmunk » d’un changement de vitesse)', async () => {
    const { harmonicsVsEnvelope } = await import('./helpers/spectrum');
    const x = synthVoice(SR, 1.2, [{ midi: 57, at: 0.1, len: 1.0 }]);
    const tr = analyzePitch(x, SR);
    const notes = segmentNotes(tr);
    const [y] = renderPitch([x], tr, correctionCurve(tr, notes, [{ shift: 4, drift: 0, vibrato: 1 }]));
    const r = 2 ** (4 / 12);
    const chip = new Float32Array(Math.floor(x.length / r));
    for (let i = 0; i < chip.length; i++) { const p = i * r, k = Math.floor(p); chip[i] = x[k] + (x[k + 1] - x[k]) * (p - k); }
    const f1 = 440 * 2 ** ((61 - 69) / 12);
    const mean = (v: number[]) => v.reduce((s, q) => s + Math.abs(q), 0) / v.length;
    const psola = mean(harmonicsVsEnvelope(y, SR, 0.3, 1.0, f1));
    const speed = mean(harmonicsVsEnvelope(chip, SR, 0.3 / r, 1.0 / r, f1));
    expect(psola).toBeLessThan(2);
    expect(speed).toBeGreaterThan(psola * 2);
    expect(Math.abs(measured(y, 0.3, 1.0) - 61) * 100).toBeLessThan(5);
  });
});
