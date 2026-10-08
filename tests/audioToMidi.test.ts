import { describe, expect, it } from 'vitest';
import { analyzePitch, segmentNotes } from '../utils/pitchAnalysis';
import {
  applyDrumSteps, buildMidiTrack, chordsToNotes, clipDurationFor, clipStartFor, detectDrumHits, hitsToGmNotes, hitsToSteps,
  loopBars, melodyAccuracy, melodyNotes, octaveShiftFor, pitchForSung, DrumKind,
} from '../utils/audioToMidi';
import { makeDrumMachine } from '../utils/drumKits';
import { synthVoice, SynthNote } from './helpers/synthVoice';

const SR = 44100;

describe('Fredonne → MIDI : mélodie', () => {
  // Voix chantée un peu faux et un peu en avance / en retard, à 120 BPM (un temps = 0,5 s).
  const sung: SynthNote[] = [
    { midi: 57.3, at: 0.52, len: 0.42, vibratoCents: 25 },   // La2 + 30 ct, ~temps 2
    { midi: 60.2, at: 1.03, len: 0.4 },                       // Do3
    { midi: 61.8, at: 1.48, len: 0.45 },                      // Ré3 − 20 ct
    { midi: 64.4, at: 2.02, len: 0.7, vibratoCents: 30 },     // Mi3 + 40 ct
    { midi: 65.65, at: 2.97, len: 0.5 },                      // entre Fa et Fa# (Fa# hors de La mineur)
  ];
  const x = synthVoice(SR, 3.8, sung, { noise: 0.004 });
  const tr = analyzePitch(x, SR);
  const notes = segmentNotes(tr);

  it('retrouve les notes chantées (hauteur et timing)', () => {
    const out = melodyNotes(notes, tr, { bpm: 120, gridAmount: 0, scaleAmount: 0, instrument: 'piano', fitOctave: false });
    expect(out.map(n => n.pitch)).toEqual([57, 60, 62, 64, 66]);
    out.forEach((n, i) => {
      expect(Math.abs(n.start - sung[i].at)).toBeLessThan(0.04);
      expect(Math.abs(n.start + n.duration - (sung[i].at + sung[i].len))).toBeLessThan(0.06);
    });
    const acc = melodyAccuracy(out);
    expect(acc.within).toBe(1);
    expect(acc.median).toBeLessThan(0.45);
  });

  it('cale sur la gamme (La mineur) et sur la grille quand on le demande', () => {
    const out = melodyNotes(notes, tr, { bpm: 120, keyRoot: 9, scale: 'MINOR', scaleAmount: 1, gridAmount: 1, gridBeats: 0.5, instrument: 'piano', fitOctave: false });
    expect(out.map(n => n.pitch)).toEqual([57, 60, 62, 64, 65]);
    for (const n of out) {
      expect(Math.abs(n.start / 0.25 - Math.round(n.start / 0.25))).toBeLessThan(1e-6);
    }
    expect(out[0].start).toBeCloseTo(0.5, 6);
    expect(out[4].start).toBeCloseTo(3.0, 6);
  });

  it('dosage du calage : à 50 % la note est à moitié ramenée vers la grille', () => {
    const full = melodyNotes(notes, tr, { bpm: 120, gridAmount: 0, scaleAmount: 0, fitOctave: false });
    const half = melodyNotes(notes, tr, { bpm: 120, gridAmount: 0.5, gridBeats: 0.5, scaleAmount: 0, fitOctave: false });
    const q = (t: number) => Math.round(t / 0.25) * 0.25;
    full.forEach((n, i) => expect(half[i].start).toBeCloseTo(n.start + 0.5 * (q(n.start) - n.start), 3));
  });

  it('808 : une ou deux octaves plus bas, notes liées ; vélocités gardées ou non', () => {
    const b = melodyNotes(notes, tr, { bpm: 120, gridAmount: 1, gridBeats: 0.25, instrument: '808', keyRoot: 9, scale: 'MINOR' });
    expect(b[0].pitch).toBe(33); // La1 : la médiane (Ré3, 62) descend de deux octaves (31-43)
    const med = [...b.map(n => n.pitch)].sort((a, c) => a - c)[2];
    expect(med).toBeGreaterThanOrEqual(31); expect(med).toBeLessThanOrEqual(43);
    for (let i = 0; i + 1 < b.length; i++) expect(b[i].start + b[i].duration).toBeLessThanOrEqual(b[i + 1].start + 1e-9);
    const flat = melodyNotes(notes, tr, { bpm: 120, keepVelocity: false });
    expect(new Set(flat.map(n => n.velocity))).toEqual(new Set([0.8]));
  });

  it('éclat isolé (harmonique, consonne) ignoré ; 808 jamais inaudible', () => {
    const mk = (center: number, start: number, end: number, i: number) => ({ index: i, i0: 0, i1: 0, start, end, center, spread: 0 });
    const ns = [mk(62, 0, 0.4, 0), mk(81, 0.45, 0.55, 1), mk(62, 0.6, 1, 2), mk(60, 1.05, 1.5, 3), mk(36, 1.55, 1.65, 4), mk(60, 1.7, 2.2, 5)];
    const out = melodyNotes(ns, { rmsDb: new Float32Array(0) }, { bpm: 120, gridAmount: 0, scaleAmount: 0, fitOctave: false });
    expect(out.map(n => n.pitch)).toEqual([62, 62, 60, 60]);
    const low = melodyNotes([mk(62, 0, 0.4, 0), mk(43, 0.5, 1, 1), mk(62, 1.1, 1.5, 2)], { rmsDb: new Float32Array(0) }, { bpm: 120, gridAmount: 0, scaleAmount: 0, instrument: '808' });
    expect(low.every(n => n.pitch >= 28 && n.pitch <= 52)).toBe(true);
  });

  it('calage gamme dosé', () => {
    // Fa# (66) chanté 65,65 : Fa (65) est à 0,65 demi-ton, Fa# à 0,35.
    expect(pitchForSung(65.65, { keyRoot: 9, scale: 'MINOR', scaleAmount: 1 })).toBe(65);
    expect(pitchForSung(65.65, { keyRoot: 9, scale: 'MINOR', scaleAmount: 0.2 })).toBe(66);
    expect(pitchForSung(65.65, { keyRoot: 9, scale: 'MINOR', scaleAmount: 0.3 })).toBe(65);
    expect(pitchForSung(64.4, { keyRoot: 9, scale: 'MINOR', scaleAmount: 1 })).toBe(64);
    expect(octaveShiftFor([60, 62, 64], [31, 43])).toBe(-2);
  });
});

// ----- Batterie synthétique -----
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
function addKick(x: Float32Array, at: number, amp = 0.9) {
  const a = Math.round(at * SR);
  let ph = 0;
  for (let i = 0; i < 0.35 * SR && a + i < x.length; i++) {
    const t = i / SR;
    const f = 48 + 110 * Math.exp(-t * 30);
    ph += (2 * Math.PI * f) / SR;
    x[a + i] += amp * Math.sin(ph) * Math.exp(-t * 9);
  }
}
function addSnare(x: Float32Array, at: number, amp = 0.6) {
  const a = Math.round(at * SR);
  let lp = 0;
  for (let i = 0; i < 0.2 * SR && a + i < x.length; i++) {
    const t = i / SR;
    lp = lp * 0.6 + rnd() * 0.4;
    const noise = lp * Math.cos(2 * Math.PI * 2600 * t) * 1.6;
    x[a + i] += amp * (0.55 * noise * Math.exp(-t * 22) + 0.35 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 35));
  }
}
function addHat(x: Float32Array, at: number, amp = 0.25) {
  const a = Math.round(at * SR);
  let lp = 0;
  for (let i = 0; i < 0.06 * SR && a + i < x.length; i++) {
    const t = i / SR;
    lp = lp * 0.3 + rnd() * 0.7;
    x[a + i] += amp * lp * Math.cos(2 * Math.PI * 10500 * t) * Math.exp(-t * 70);
  }
}

describe('Audio → batterie', () => {
  it('classe des coups isolés : kick, snare, hat', () => {
    const x = new Float32Array(SR * 3);
    const truth: [number, DrumKind][] = [];
    const kinds: DrumKind[] = ['kick', 'hat', 'snare', 'hat', 'kick', 'snare', 'hat', 'kick', 'hat', 'snare', 'kick', 'hat'];
    kinds.forEach((k, i) => {
      const t = 0.1 + i * 0.23;
      truth.push([t, k]);
      if (k === 'kick') addKick(x, t, 0.6 + 0.3 * ((i % 3) / 2)); else if (k === 'snare') addSnare(x, t); else addHat(x, t, 0.15 + 0.1 * (i % 2));
    });
    const hits = detectDrumHits(x, SR);
    expect(hits.length).toBe(truth.length);
    let ok = 0;
    truth.forEach(([t, k]) => {
      const h = hits.find(q => Math.abs(q.time - t) < 0.02);
      if (h && h.kind === k) ok++;
    });
    expect(ok / truth.length).toBeGreaterThanOrEqual(0.99);
  });

  it('kick « punch » sans sub (le sub est dans la 808) : reste un kick', () => {
    const x = new Float32Array(SR * 2);
    const punch = (at: number) => {
      const a = Math.round(at * SR); let ph = 0;
      for (let i = 0; i < 0.2 * SR; i++) { const t = i / SR; ph += 2 * Math.PI * (95 + 160 * Math.exp(-t * 25)) / SR; x[a + i] += 0.8 * Math.sin(ph) * Math.exp(-t * 14) * Math.min(1, (0.2 - t) / 0.02); }
    };
    punch(0.1); addSnare(x, 0.5); punch(0.9); addHat(x, 1.3); addSnare(x, 1.6);
    expect(detectDrumHits(x, SR).map(h => h.kind)).toEqual(['kick', 'snare', 'kick', 'hat', 'snare']);
  });

  it('boucle trap (kick + hat ensemble, snare sur 2 et 4) → motif de la boîte à rythmes', () => {
    const bpm = 140, step = 60 / bpm / 4;
    const x = new Float32Array(Math.round(SR * 16 * step + SR * 0.3));
    const kick = [0, 7, 10], snare = [4, 12];
    for (let s = 0; s < 16; s++) {
      if (kick.includes(s)) addKick(x, s * step);
      if (snare.includes(s)) addSnare(x, s * step);
      if (s % 2 === 0) addHat(x, s * step, 0.2);
    }
    const hits = detectDrumHits(x, SR);
    const bars = loopBars(16 * step, bpm);
    expect(bars).toBe(1);
    const steps = hitsToSteps(hits, { bpm, bars });
    const on = (a: number[]) => a.map((v, i) => (v > 0 ? i : -1)).filter(i => i >= 0);
    expect(on(steps.kick)).toEqual(kick);
    expect(on(steps.snare)).toEqual(snare);
    // Hats : ceux seuls et ceux joués sur un kick (pas sous la snare, masqués).
    const hatOn = on(steps.hat);
    const expectedHats = [0, 2, 4, 6, 8, 10, 12, 14].filter(s => !snare.includes(s));
    const found = expectedHats.filter(s => hatOn.includes(s)).length;
    expect(found / expectedHats.length).toBeGreaterThanOrEqual(0.8);
    const dm = applyDrumSteps(makeDrumMachine('trap'), steps, bars);
    expect(on(dm.rows.find(r => r.id === 'kick')!.steps)).toEqual(kick);
    expect(dm.rows.find(r => r.id === 'clap')!.steps.every(v => v === 0)).toBe(true);
    const gm = hitsToGmNotes(hits);
    expect(gm.filter(n => n.pitch === 36).length).toBe(3);
    expect(gm.filter(n => n.pitch === 38).length).toBe(2);
  });
});

describe('Harmonie → MIDI et pistes', () => {
  it('accords en voix serrées, avec basse', () => {
    const notes = chordsToNotes([
      { start: 0, end: 2, root: 9, quality: 'min' }, { start: 2, end: 4, root: 5, quality: 'maj' },
    ], { bass: true });
    const first = notes.filter(n => n.start === 0).map(n => n.pitch % 12).sort((a, b) => a - b);
    expect(first).toEqual([0, 4, 9, 9]);
    const upper2 = notes.filter(n => n.start === 2).map(n => n.pitch).sort((a, b) => a - b);
    expect(upper2[upper2.length - 1] - upper2[1]).toBeLessThanOrEqual(12);
  });

  it('pistes créées : 808, synthé NOVA, General MIDI', () => {
    const t808 = buildMidiTrack({ id: 't1', clipId: 'c1', name: 'Fredonne 808', kind: '808', start: 2, duration: 4, notes: [] });
    expect(t808.bass808?.style).toBe('808');
    const piano = buildMidiTrack({ id: 't2', clipId: 'c2', name: 'Fredonne piano', kind: 'piano', start: 0, duration: 2, notes: [] });
    expect(piano.novaSynth?.presetId).toBe('piano-doux');
    const gm = buildMidiTrack({ id: 't3', clipId: 'c3', name: 'Batterie', kind: 'gm-drums', start: 0, duration: 2, notes: [] });
    expect(gm.novaSynth).toBeUndefined();
    expect(clipStartFor(2.7, 120)).toBe(2);
    expect(clipDurationFor([{ start: 0.1, duration: 2.5 }], 120)).toBe(4);
  });
});
