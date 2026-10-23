/**
 * Nova Pitch (éditeur de notes de la voix) : moteur mesuré.
 * Exigence : précision 2 cents (1/50 de demi-ton) → hauteur obtenue = hauteur
 * demandée à ±1 cent, durée inchangée, formants gardés, consonnes intactes,
 * pas de clic ; mode élastique : durée ±1 ms, hauteur ±1 cent, vibrato ±5 %.
 */
import { describe, expect, it } from 'vitest';
import { analyzePitch, segmentNotes, type PitchNote, type PitchTrack } from '../utils/pitchAnalysis';
import type { NoteEdit } from '../utils/pitchCorrect';
import { voiceMarks, irregularMarks } from '../engine/pitch/marks';
import { voiceTrack } from '../engine/pitch/analysis';
import { noteShape } from '../engine/pitch/notes';
import { buildPlan } from '../engine/pitch/plan';
import { renderVoice } from '../engine/pitch/render';
import { mapLength } from '../engine/pitch/timeMap';
import { synthVoice, envelope, type SynthNote } from './helpers/synthVoice';
import { clickDb, diffDb, harmonicEnvelope, envelopeGap, meanPitch, pitchByAnalysis, pitchBySpectrum, vibratoRate, bestLag } from './helpers/pitchMeasure';

const SR = 48000;

function setup(x: Float32Array) {
  const track = voiceTrack(x, SR);
  const notes = segmentNotes(track);
  const shapes = notes.map(n => noteShape(track, n));
  const marks = voiceMarks(x, track);
  return { track, notes, shapes, marks };
}
function render(x: Float32Array, s: ReturnType<typeof setup>, edits: (NoteEdit | undefined)[], extend = 0, notes?: PitchNote[]) {
  const ns = notes ?? s.notes;
  const shapes = notes ? ns.map(n => noteShape(s.track, n)) : s.shapes;
  return renderVoice([x], s.marks, buildPlan({ track: s.track, notes: ns, shapes, edits, extend }))[0];
}
const sine = (midi: number, dur: number, amp = 0.3) => {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const x = new Float32Array(Math.round(dur * SR));
  for (let i = 0; i < x.length; i++) {
    const env = Math.min(1, i / (0.01 * SR), (x.length - i) / (0.02 * SR));
    x[i] = amp * env * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return x;
};
const E = (shift: number, extra: Partial<NoteEdit> = {}): NoteEdit => ({ shift, drift: 0, vibrato: 1, ...extra });

describe('analyse : courbe fine et justesse', () => {
  it('trames de 5 ms, justesse ≤ 1 cent sur sinus et voix de synthèse (45 à 80 MIDI)', () => {
    for (const m of [45.37, 52.81, 60.13, 67.49, 74.02, 79.6]) {
      for (const x of [sine(m, 0.8), synthVoice(SR, 0.8, [{ midi: m, at: 0.05, len: 0.7 }])]) {
        // Détecteur commun de NOVA (engine/pitch/detect, partagé avec Nova Tune) sur la grille de l'éditeur.
        const tr = voiceTrack(x, SR);
        expect((tr.hop / SR) * 1000).toBeLessThanOrEqual(5);
        expect(Math.abs(pitchByAnalysis(x, SR, 0.2, 0.6, tr) - m) * 100).toBeLessThan(1);
      }
    }
  });

  it('parties sans hauteur (souffle, consonnes) repérées ; note : partie tenue, vibrato, dérive', () => {
    const x = synthVoice(SR, 2.2, [{ midi: 60.2, at: 0.3, len: 1.5, vibratoCents: 40, vibratoHz: 5.5, driftCents: 30 }], { noise: 0.004 });
    const s = setup(x);
    expect(Number.isNaN(s.track.midi[Math.round(0.1 / 0.005)])).toBe(true);
    expect(s.notes.length).toBe(1);
    const sh = s.shapes[0];
    expect(sh.s0).toBeGreaterThan(s.notes[0].start);
    expect(sh.s1).toBeLessThan(s.notes[0].end);
    expect(Math.abs(sh.vibRate - 5.5) / 5.5).toBeLessThan(0.05);
    expect(sh.vibDepth).toBeGreaterThan(25);
    expect(sh.driftCents).toBeGreaterThan(5);
  });
});

describe('rendu : hauteur demandée à ±1 cent', () => {
  const shifts = [0.02, -0.02, 1, 3.5, -5, 0.5];
  it.each([46.3, 57.4, 64.1, 71.8])('voix de synthèse à %s : écart ≤ 1 cent (analyse ET spectre indépendant)', (m) => {
    const x = synthVoice(SR, 1.2, [{ midi: m, at: 0.1, len: 1.0 }]);
    const s = setup(x);
    const before = pitchBySpectrum(x, SR, 0.3, 0.9, m);
    for (const sh of shifts) {
      const y = render(x, s, s.notes.map(() => E(sh)));
      expect(y.length).toBe(x.length);
      const errA = (pitchByAnalysis(y, SR, 0.3, 0.9) - pitchByAnalysis(x, SR, 0.3, 0.9, s.track) - sh) * 100;
      const errS = (pitchBySpectrum(y, SR, 0.3, 0.9, m + sh) - before - sh) * 100;
      expect(Math.abs(errA)).toBeLessThan(1);
      expect(Math.abs(errS)).toBeLessThan(1);
    }
  });

  it('note avec vibrato : centre déplacé à ±1 cent, vibrato gardé', () => {
    const x = synthVoice(SR, 1.4, [{ midi: 69.7, at: 0.1, len: 1.2, vibratoCents: 40, vibratoHz: 5.5 }]);
    const s = setup(x);
    // Moyenne sur un nombre entier de cycles (5 cycles de 5,5 Hz).
    const a = 0.3, b = 0.3 + 5 / 5.5;
    for (const sh of [0.02, 2, -3]) {
      const y = render(x, s, s.notes.map(() => E(sh)));
      const ty = analyzePitch(y, SR);
      expect(Math.abs((meanPitch(ty, a, b) - meanPitch(s.track, a, b) - sh) * 100)).toBeLessThan(1);
      expect(Math.abs(vibratoRate(ty, 0.25, 1.2) - 5.5)).toBeLessThan(0.15);
    }
  });

  it('pas de 2 cents réellement appliqué (cinq pas successifs)', () => {
    const x = synthVoice(SR, 1.0, [{ midi: 62.0, at: 0.1, len: 0.8 }]);
    const s = setup(x);
    const got: number[] = [];
    for (let k = 0; k <= 5; k++) got.push(pitchBySpectrum(render(x, s, s.notes.map(() => E(0.02 * k))), SR, 0.25, 0.8, 62));
    for (let k = 1; k <= 5; k++) expect(Math.abs((got[k] - got[k - 1]) * 100 - 2)).toBeLessThan(0.5);
  });

  it('sans retouche : sortie identique ; souffle et consonnes recopiés à l’identique', () => {
    const x = synthVoice(SR, 1.6, [{ midi: 57.3, at: 0.3, len: 0.5 }, { midi: 61, at: 1.0, len: 0.5 }], { noise: 0.01 });
    const s = setup(x);
    const y0 = render(x, s, s.notes.map(() => undefined));
    let md = 0;
    for (let i = 0; i < x.length; i++) md = Math.max(md, Math.abs(x[i] - y0[i]));
    expect(md).toBeLessThan(1e-6);
    // Note 1 montée de 3 demi-tons : le bruit entre les notes reste identique.
    const y = render(x, s, s.notes.map((_, k) => (k === 0 ? E(3) : undefined)));
    expect(diffDb(x, y, Math.round(0.85 * SR), Math.round(0.97 * SR))).toBeLessThan(-80);
    expect(diffDb(x, y, 0, Math.round(0.25 * SR))).toBeLessThan(-80);
  });

  it('formants gardés : +4 et −5 demi-tons, enveloppe à moins de 2 dB de la voyelle (vitesse changée : bien plus)', () => {
    const m = 55;
    const x = synthVoice(SR, 1.2, [{ midi: m, at: 0.1, len: 1.0 }]);
    const s = setup(x);
    const truth = (f0: number) => {
      const g: number[] = [], d: number[] = [];
      for (let f = 300; f <= 4000; f += 25) { g.push(f); d.push(20 * Math.log10(envelope(f))); }
      void f0; return d;
    };
    for (const sh of [4, -5]) {
      const y = render(x, s, s.notes.map(() => E(sh)));
      const f0 = 440 * 2 ** ((m + sh - 69) / 12);
      const env = harmonicEnvelope(y, SR, 0.3, 0.9, f0);
      expect(envelopeGap(env.db, truth(f0))).toBeLessThan(2);
      // Référence : la même hauteur par simple changement de vitesse (chipmunk).
      const r = 2 ** (sh / 12);
      const z = new Float32Array(Math.floor(x.length / r));
      for (let i = 0; i < z.length; i++) { const p = i * r, k = Math.floor(p); z[i] = x[k] + ((x[k + 1] ?? 0) - x[k]) * (p - k); }
      const envZ = harmonicEnvelope(z, SR, 0.3 / r, 0.9 / r, f0);
      expect(envelopeGap(envZ.db, truth(f0))).toBeGreaterThan(envelopeGap(env.db, truth(f0)) + 1.5);
    }
  });

  it('aucun clic aux bords des notes (mélodie liée, notes déplacées de ±3 demi-tons)', () => {
    const notes: SynthNote[] = [
      { midi: 57.3, at: 0.2, len: 0.45 }, { midi: 60.1, at: 0.65, len: 0.4, glide: 0.06 }, { midi: 62.2, at: 1.05, len: 0.5, glide: 0.06 },
    ];
    const x = synthVoice(SR, 1.8, notes);
    const s = setup(x);
    const y = render(x, s, s.notes.map((_, k) => E(k % 2 ? -3 : 3)));
    const zones: [number, number][] = s.notes.flatMap(n => [[n.start - 0.03, n.start + 0.03], [n.end - 0.03, n.end + 0.03]] as [number, number][]);
    // Énergie très aiguë (> 6 kHz) en blocs de 1 ms aux jonctions : pas plus que dans l'original + 6 dB.
    expect(clickDb(y, SR, zones)).toBeLessThan(clickDb(x, SR, zones) + 6);
  });

  it('gain par note : niveau demandé à ±0,2 dB au cœur de la note, le reste intact', () => {
    const x = synthVoice(SR, 1.6, [{ midi: 57, at: 0.2, len: 0.5 }, { midi: 60, at: 0.9, len: 0.5 }]);
    const s = setup(x);
    const y = render(x, s, s.notes.map((_, k) => (k === 0 ? E(0, { gainDb: -6 }) : undefined)));
    const rms = (v: Float32Array, a: number, b: number) => { let e = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) e += v[i] * v[i]; return Math.sqrt(e / ((b - a) * SR)); };
    expect(Math.abs(20 * Math.log10(rms(y, 0.3, 0.6) / rms(x, 0.3, 0.6)) + 6)).toBeLessThan(0.2);
    expect(Math.abs(20 * Math.log10(rms(y, 1.0, 1.3) / rms(x, 1.0, 1.3)))).toBeLessThan(0.05);
  });
});

describe('marques de période régulières', () => {
  it('voix aiguë avec vibrato : < 1 % d’espacements faux', () => {
    const x = synthVoice(SR, 1.2, [{ midi: 71.8, at: 0.1, len: 1.0, vibratoCents: 40 }]);
    const tr = voiceTrack(x, SR);
    expect(irregularMarks(voiceMarks(x, tr), tr)).toBeLessThan(0.01);
  });
});

describe('élastique : allonger / raccourcir une note', () => {
  /** Note tenue (sans vibrato ou avec) + consonne bruitée + note suivante. */
  const scene = (vib: number) => {
    const x = synthVoice(SR, 4.2, [
      { midi: 60.3, at: 0.2, len: 1.6, vibratoCents: vib, vibratoHz: 5.6 },
      { midi: 64.1, at: 2.05, len: 1.2 },
    ]);
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const c0 = Math.round(1.86 * SR), c1 = Math.round(2.0 * SR);
    for (let i = c0; i < c1; i++) x[i] += 0.2 * rnd() * Math.sin((Math.PI * (i - c0)) / (c1 - c0));
    return x;
  };
  for (const factor of [2, 0.5, 4, 0.25]) {
    it(`×${factor} : durée exacte (consonne suivante décalée de Δ à l’échantillon près), hauteur ±1 cent, consonne intacte`, () => {
      const x = scene(0);
      const s = setup(x);
      const L = s.notes[0].end - s.notes[0].start;
      const d = Math.round(L * (factor - 1) * SR) / SR;
      const edits = s.notes.map((_, k) => (k === 0 ? E(0, { dt1: d }) : E(0, { dt0: d, dt1: d })));
      const plan = buildPlan({ track: s.track, notes: s.notes, shapes: s.shapes, edits, extend: d });
      const y = renderVoice([x], s.marks, plan)[0];
      expect(mapLength(plan.map)).toBe(x.length + Math.round(d * SR));
      // Consonne entre les notes : retrouvée exactement Δ plus loin (durée de la note = demandée à l'échantillon).
      const lag = bestLag(x, y, Math.round(1.87 * SR), Math.round(1.99 * SR), 96, Math.round(d * SR));
      expect(Math.abs(lag - Math.round(d * SR)) / SR * 1000).toBeLessThanOrEqual(1);
      expect(diffDb(x, y, Math.round(1.87 * SR), Math.round(1.99 * SR), Math.round(d * SR))).toBeLessThan(-60);
      // Hauteur de la note étirée inchangée.
      const ty = analyzePitch(y, SR);
      const a = 0.35, b = 0.2 + L * factor - 0.12;
      expect(Math.abs((pitchByAnalysis(y, SR, a, b, ty) - pitchByAnalysis(x, SR, 0.35, 1.68, s.track)) * 100)).toBeLessThan(1);
      // Note suivante : intacte, décalée.
      expect(diffDb(x, y, Math.round(2.3 * SR), Math.round(3.0 * SR), Math.round(d * SR))).toBeLessThan(-60);
      // Pas de discontinuité aux jonctions.
      const zones: [number, number][] = [[0.15, 0.3], [0.2 + L * factor - 0.1, 0.2 + L * factor + 0.1]];
      expect(clickDb(y, SR, zones)).toBeLessThan(clickDb(x, SR, [[0.15, 0.3], [1.7, 1.9]]) + 6);
    });
  }

  for (const factor of [2, 0.5, 4]) {
    it(`×${factor} : vibrato à sa vitesse naturelle (±5 %)`, () => {
      const x = scene(45);
      const s = setup(x);
      expect(s.shapes[0].vibRate).toBeGreaterThan(5);
      const L = s.notes[0].end - s.notes[0].start;
      const d = Math.round(L * (factor - 1) * SR) / SR;
      const edits = s.notes.map((_, k) => (k === 0 ? E(0, { dt1: d }) : E(0, { dt0: d, dt1: d })));
      const y = render(x, s, edits, d);
      const ty = analyzePitch(y, SR);
      const rate = vibratoRate(ty, 0.3, 0.2 + L * factor - 0.15);
      expect(Math.abs(rate - 5.6) / 5.6).toBeLessThan(0.05);
    });
  }
});

export type { PitchTrack };
