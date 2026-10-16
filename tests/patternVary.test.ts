import { describe, expect, it } from 'vitest';
import type { MidiNote } from '../types';
import { extendNotes, isAllowed, isChordal, noteDistance, snapNote, stepInScale, varyNotes, varyVariants, VARY_RULES, type VaryContext } from '../utils/patternVary';
import { buildBeat } from '../utils/beatStarter';

const bpm = 120, six = 60 / bpm / 4, bar = six * 16;
let k = 0;
const N = (pitch: number, step: number, len = 2): MidiNote => ({ id: `n${k++}`, pitch, start: step * six, duration: len * six, velocity: 0.8 });
/** Mélodie de 2 mesures en La mineur. */
const melody: MidiNote[] = [N(69, 0, 4), N(72, 4, 2), N(71, 6, 2), N(69, 8, 4), N(67, 12, 4), N(64, 16, 4), N(65, 20, 2), N(67, 22, 2), N(69, 24, 8)];
const ctx: VaryContext = { bpm, root: 9, scale: 'MINOR', seed: 3 };

describe('Varier (règles, sans IA)', () => {
  it('4 règles, chacune décrite', () => {
    expect(VARY_RULES.map(r => r.id)).toEqual(['rythme', 'inversion', 'deplacement', 'transposition']);
    for (const r of VARY_RULES) expect(r.hint.length).toBeGreaterThan(20);
  });

  it('chaque règle : 3 variantes distinctes (≥ 30 % des notes), toutes les notes dans la gamme', () => {
    for (const r of VARY_RULES) {
      const vs = varyVariants(melody, r.id, ctx, 2 * bar);
      expect(vs.length, r.id).toBe(3);
      for (const v of vs) {
        expect(noteDistance(v, melody), r.id).toBeGreaterThanOrEqual(0.3);
        for (const n of v) {
          expect(isAllowed(n.pitch, n.start, ctx), `${r.id} ${n.pitch}`).toBe(true);
          expect(n.start).toBeGreaterThanOrEqual(0);
          expect(n.start).toBeLessThan(2 * bar);
        }
      }
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(noteDistance(vs[i], vs[j]), `${r.id} ${i}/${j}`).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('reproductible : même graine, même résultat', () => {
    const a = varyNotes(melody, 'rythme', ctx, 0, 2 * bar).map(n => [n.pitch, n.start]);
    const b = varyNotes(melody, 'rythme', ctx, 0, 2 * bar).map(n => [n.pitch, n.start]);
    expect(a).toEqual(b);
  });

  it('accords : l’inversion fait des renversements (mêmes notes, autre octave)', () => {
    const sk = buildBeat({ genre: 'rnb', root: 0 });
    const chords = sk.chordNotes;
    expect(isChordal(chords)).toBe(true);
    const inv = varyNotes(chords, 'inversion', { bpm: sk.bpm, root: 0, scale: sk.scale }, 0, 8 * 4 * 60 / sk.bpm);
    expect(inv.length).toBe(chords.length);
    const pcs = (ns: MidiNote[]) => ns.map(n => n.pitch % 12).sort().join(',');
    expect(pcs(inv)).toBe(pcs(chords));
    expect(noteDistance(inv, chords)).toBeGreaterThanOrEqual(0.3);
    // Le dé sur des accords de 7e : 3 voicings bien différents.
    expect(varyVariants(chords, 'inversion', { bpm: sk.bpm, root: 0, scale: sk.scale }, 8 * 4 * 60 / sk.bpm).length).toBe(3);
  });

  it('avec une piste d’accords : la note hors gamme mais dans l’accord est permise', () => {
    const c: VaryContext = { bpm, root: 9, scale: 'MINOR', chords: [{ id: 'c', start: 0, end: bar, root: 4, quality: '7' }], clipStart: 0 };
    expect(isAllowed(68, 0.1, c)).toBe(true); // Sol# : tierce de Mi7 (mineur harmonique)
    expect(isAllowed(68, bar + 0.1, c)).toBe(false);
    expect(snapNote(68, bar + 0.1, c)).toBe(67);
  });

  it('transposition diatonique : on reste dans la gamme', () => {
    expect(stepInScale(69, 2, 9, 'MINOR')).toBe(72);
    expect(stepInScale(69, -2, 9, 'MINOR')).toBe(65);
    expect(stepInScale(60, 1, null)).toBe(61);
  });
});

describe('Prolonger', () => {
  it('ajoute 1, 2, 4 ou 8 mesures, notes dans la gamme, l’original intact au début', () => {
    for (const bars of [1, 2, 4, 8]) for (const mode of ['repeter', 'varier'] as const) {
      const r = extendNotes(melody, { bars, clipLen: 2 * bar, ctx, mode, rule: 'rythme' });
      expect(r.duration, `${bars} ${mode}`).toBeCloseTo((2 + bars) * bar, 6);
      const head = r.notes.filter(n => n.start < 2 * bar - 1e-6);
      expect(head.map(n => [n.pitch, n.start])).toEqual(melody.map(n => [n.pitch, n.start]));
      expect(r.notes.length).toBeGreaterThan(melody.length);
      for (const n of r.notes) {
        expect(isAllowed(n.pitch, n.start, ctx)).toBe(true);
        expect(n.start + n.duration).toBeLessThanOrEqual(r.duration + 1e-6);
      }
    }
  });

  it('« répéter » recopie le motif à l’identique ; « varier » change une reprise sur deux', () => {
    const rep = extendNotes(melody, { bars: 2, clipLen: 2 * bar, ctx, mode: 'repeter' });
    const tail = rep.notes.filter(n => n.start >= 2 * bar - 1e-6).map(n => ({ ...n, start: n.start - 2 * bar }));
    expect(noteDistance(tail, melody)).toBe(0);
    const v = extendNotes(melody, { bars: 2, clipLen: 2 * bar, ctx, mode: 'varier', rule: 'inversion' });
    const vt = v.notes.filter(n => n.start >= 2 * bar - 1e-6).map(n => ({ ...n, start: n.start - 2 * bar }));
    expect(noteDistance(vt, melody)).toBeGreaterThanOrEqual(0.3);
  });

  it('prolonger d’une mesure un clip de 2 mesures reprend la dernière mesure', () => {
    const r = extendNotes(melody, { bars: 1, clipLen: 2 * bar, ctx, mode: 'repeter' });
    const tail = r.notes.filter(n => n.start >= 2 * bar - 1e-6).map(n => [n.pitch, Math.round((n.start - 2 * bar) / six)]);
    expect(tail).toEqual(melody.filter(n => n.start >= bar - 1e-6).map(n => [n.pitch, Math.round((n.start - bar) / six)]));
  });
});
