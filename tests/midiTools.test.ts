import { describe, expect, it } from 'vitest';
import { MidiNote } from '../types';
import {
  strum, arpeggiate, flam, chop, roll, velocityCurve, randomize, legato, invert, retrograde, quantize, chordify, chordGroups, seededRandom, MIDI_TOOLS, curveValue,
} from '../utils/midiTools';
import { arpSequence } from '../services/MidiEffectsService';

/** V25 : menu « Outils » du piano roll (Live 12 MIDI Transformations, outils de FL). */

const BPM = 120; // temps = 0,5 s
const ctx = { bpm: BPM, clipStart: 0 };
const N = (id: string, pitch: number, start: number, duration = 0.5, velocity = 0.8): MidiNote => ({ id, pitch, start, duration, velocity });
const chord = () => [N('a', 60, 0, 1), N('b', 64, 0, 1), N('c', 67, 0, 1)];

describe('strum', () => {
  it('montant : grave d’abord, 30 ms d’écart, fins de notes gardées', () => {
    const out = strum(chord(), null, ctx, { direction: 'up', spreadMs: 30 });
    expect(out.map(n => [n.pitch, +n.start.toFixed(3)])).toEqual([[60, 0], [64, 0.03], [67, 0.06]]);
    out.forEach(n => expect(n.start + n.duration).toBeCloseTo(1, 9));
  });
  it('descendant, et alterné d’un accord à l’autre', () => {
    const down = strum(chord(), null, ctx, { direction: 'down', spreadMs: 20 });
    expect(down.find(n => n.pitch === 67)!.start).toBe(0);
    expect(down.find(n => n.pitch === 60)!.start).toBeCloseTo(0.04, 9);
    const two = [...chord(), N('d', 60, 2, 1), N('e', 64, 2, 1)];
    const alt = strum(two, null, ctx, { direction: 'alternate', spreadMs: 10 });
    expect(alt.find(n => n.id === 'e')!.start).toBe(2);
    expect(alt.find(n => n.id === 'd')!.start).toBeCloseTo(2.01, 9);
  });
});

describe('arpège (Arpeggiator branché)', () => {
  it('accord d’une ronde → doubles-croches montantes sur 2 octaves, gate 50 %', () => {
    const out = arpeggiate([N('a', 60, 0, 2), N('b', 64, 0, 2), N('c', 67, 0, 2)], null, ctx, { pattern: 'UP', rate: '1/16', octaves: 2, gate: 50 });
    expect(out).toHaveLength(16);
    expect(out.slice(0, 7).map(n => n.pitch)).toEqual([60, 64, 67, 72, 76, 79, 60]);
    expect(out[1].start).toBeCloseTo(0.125, 9);
    expect(out[0].duration).toBeCloseTo(0.0625, 9);
  });
  it('motifs du service : monte-descend, convergent', () => {
    expect(arpSequence([60, 64, 67], 'UP_DOWN')).toEqual([60, 64, 67, 64]);
    expect(arpSequence([60, 64, 67], 'DOWN_UP')).toEqual([67, 64, 60, 64]);
    expect(arpSequence([60, 62, 64, 65], 'CONVERGE')).toEqual([60, 65, 62, 64]);
  });
});

describe('flam, chop, roll de hi-hats', () => {
  it('flam : une petite note 25 ms avant, plus douce', () => {
    const out = flam([N('a', 38, 1, 0.2, 1)], null, ctx, { offsetMs: 25, velocity: 0.5 });
    expect(out).toHaveLength(2);
    expect(out[0].start).toBeCloseTo(0.975, 9);
    expect(out[0].velocity).toBeCloseTo(0.5, 9);
  });
  it('chop : une noire → 4 doubles-croches ; en 1/32 → 8', () => {
    expect(chop([N('a', 42, 0, 0.5)], null, ctx, { grid: '1/16' }).map(n => n.start)).toEqual([0, 0.125, 0.25, 0.375]);
    expect(chop([N('a', 42, 0, 0.5)], null, ctx, { grid: '1/32' })).toHaveLength(8);
  });
  it('roll 1/32 sur une croche : 4 coups, vélocité en montée de 40 % à 100 %', () => {
    const out = roll([N('h', 42, 1, 0.25)], null, ctx, { rate: '1/32', ramp: 'up', from: 0.4, to: 1 });
    expect(out.map(n => +n.start.toFixed(4))).toEqual([1, 1.0625, 1.125, 1.1875]);
    expect(out.map(n => +n.velocity.toFixed(2))).toEqual([0.4, 0.6, 0.8, 1]);
  });
  it('roll en triolets de doubles-croches (1/16T) sur une noire : 6 coups', () => {
    const out = roll([N('h', 42, 0, 0.5)], null, ctx, { rate: '1/16T', ramp: 'down', from: 0.3, to: 0.9 });
    expect(out).toHaveLength(6);
    expect(out[1].start).toBeCloseTo(0.5 / 6, 9);
    expect(out[0].velocity).toBeCloseTo(0.9, 9); // rampe descendante : du plus fort au plus faible
    expect(out[5].velocity).toBeCloseTo(0.3, 9);
  });
  it('seule la sélection est touchée', () => {
    const notes = [N('a', 42, 0, 0.5), N('b', 42, 0.5, 0.5)];
    const out = chop(notes, new Set(['b']), ctx, { grid: '1/16' });
    expect(out).toHaveLength(5);
    expect(out.find(n => n.id === 'a')).toEqual(notes[0]);
  });
});

describe('vélocité, aléatoire, legato, inversion, rétrograde', () => {
  const line = () => [0, 1, 2, 3, 4].map(i => N(`n${i}`, 60 + i * 2, i * 0.5, 0.25));
  it('courbe de vélocité : montée, descente, vague, dessin', () => {
    expect(velocityCurve(line(), null, ctx, { shape: 'up', min: 0.2, max: 1 }).map(n => +n.velocity.toFixed(2))).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    expect(velocityCurve(line(), null, ctx, { shape: 'down', min: 0.2, max: 1 })[0].velocity).toBeCloseTo(1, 9);
    expect(curveValue({ shape: 'sine', min: 0, max: 1, cycles: 1 }, 0.5)).toBeCloseTo(1, 9);
    expect(curveValue({ shape: 'drawn', min: 0, max: 1, points: [0, 1, 0] }, 0.25)).toBeCloseTo(0.5, 9);
  });
  it('aléatoire reproductible, hauteurs restées dans la gamme (Do mineur)', () => {
    const a = randomize(line(), null, { ...ctx, keyRoot: 0, keyScale: 'MINOR', rand: seededRandom(7) }, { pitch: 3, velocity: 0.2, timingMs: 10 });
    const b = randomize(line(), null, { ...ctx, keyRoot: 0, keyScale: 'MINOR', rand: seededRandom(7) }, { pitch: 3, velocity: 0.2, timingMs: 10 });
    expect(a).toEqual(b);
    const minor = [0, 2, 3, 5, 7, 8, 10];
    a.forEach(n => expect(minor).toContain(n.pitch % 12));
    a.forEach((n, i) => expect(Math.abs(n.start - line()[i].start)).toBeLessThanOrEqual(0.010001));
  });
  it('legato : chaque note va jusqu’à la suivante', () => {
    const out = legato(line(), null, ctx);
    expect(out.slice(0, 4).map(n => n.duration)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
  it('inversion : le grave devient l’aigu', () => {
    expect(invert(line(), null, ctx).map(n => n.pitch)).toEqual([68, 66, 64, 62, 60]);
  });
  it('rétrograde : la phrase à l’envers', () => {
    const out = retrograde(line(), null);
    expect(out[0].pitch).toBe(68);
    expect(out[0].start).toBeCloseTo(0, 9);
    expect(out[4].pitch).toBe(60);
    expect(out[4].start).toBeCloseTo(2, 9);
  });
});

describe('quantification avec intensité et swing', () => {
  it('pile, à moitié, et avec swing 60 %', () => {
    const notes = [N('a', 60, 0.03, 0.1), N('b', 60, 0.14, 0.1)];
    const full = quantize(notes, null, ctx, { grid: '1/16', strength: 1, swing: 50 });
    expect(full.map(n => +n.start.toFixed(4))).toEqual([0, 0.125]);
    const half = quantize(notes, null, ctx, { grid: '1/16', strength: 0.5, swing: 50 });
    expect(half[0].start).toBeCloseTo(0.015, 9);
    const sw = quantize(notes, null, ctx, { grid: '1/16', strength: 1, swing: 60 });
    expect(sw[1].start).toBeCloseTo(0.125 + 0.2 * 0.125, 9);
  });
});

describe('accord sur chaque note (ChordGenerator branché)', () => {
  it('mineur 7 : 4 notes, vélocité des notes ajoutées réduite', () => {
    const out = chordify([N('a', 57, 0, 1, 1)], null, ctx, { chordType: 'MIN7', inversion: 0, velocityScale: 80, strumMs: 0 });
    expect(out.map(n => n.pitch)).toEqual([57, 60, 64, 67]);
    expect(out[1].velocity).toBeCloseTo(Math.round(127 * 0.8) / 127, 6);
  });
});

describe('catalogue', () => {
  it('chaque outil a un libellé français et une infobulle qui cite un autre DAW', () => {
    expect(MIDI_TOOLS.length).toBeGreaterThanOrEqual(12);
    MIDI_TOOLS.forEach(t => expect(t.hint).toMatch(/Live|FL|Logic|Pro Tools/));
    expect(chordGroups(chord())).toHaveLength(1);
  });
});
