/**
 * Détection de hauteur (engine/pitch/detect.ts) : banc avant → après sur voix synthétiques dont
 * la hauteur est connue à chaque instant.
 *
 *  « avant » = analyse historique de Nova Tune (option `legacy`), « après » = analyse actuelle.
 *  Mesures : erreurs grossières (> 50 cents) et d'octave, voisement manqué, faux voisement
 *  (souffle, consonnes, bruit), erreur fine (cents) sur les trames justes.
 *  Avec NOVATUNE_OUT=dossier, le tableau est écrit dans <dossier>/detection.json.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createPitchDetector, detectPitchTrack } from '../engine/pitch/detect';
import { synthPitchAt, synthVoice, type SynthNote } from './helpers/synthVoice';

const SR = 48000;

interface Case {
  name: string; notes: SynthNote[]; dur: number; amp?: number; noise?: number; bursts?: [number, number][]; formants?: [number, number, number][];
  /** Voix à impulsions glottiques : alternance d'amplitude d'une période à l'autre (voix éraillée), gigue, souffle mêlé. */
  pulse?: { alt?: number; jitter?: number; breath?: number };
  /** Bruit grave (bruit blanc intégré, filtré), amplitude crête. */
  brown?: number;
  /** Moments où les harmoniques impaires s'effondrent (timbre « ou ») : [début, durée] (s). */
  flips?: [number, number][];
}

/**
 * Voix à impulsions glottiques filtrées par 3 formants : chaque période peut varier en durée
 * (gigue, en fraction) et en amplitude (une sur deux plus faible : voix éraillée / « fry »,
 * piège classique des erreurs d'octave vers le bas) ; souffle mêlé à la voix (bruit filtré).
 */
/** Voix additive dont les harmoniques impaires chutent brièvement (piège d'octave vers le haut). */
function flipVoice(c: Case): Float32Array {
  const n = Math.round(c.dur * SR);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const m = synthPitchAt(c.notes, t);
    if (Number.isNaN(m)) continue;
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    ph += f0 / SR;
    let g = 1;
    for (const [a, len] of c.flips || []) {
      const r = 0.004;
      if (t > a - r && t < a + len + r) g = Math.min(g, t < a ? 1 - 0.92 * (t - a + r) / r : t > a + len ? 0.08 + 0.92 * (t - a - len) / r : 0.08);
    }
    let s = 0;
    for (let h = 1; h * f0 < 5000; h++) s += (h % 2 ? g : 1) * Math.sin(2 * Math.PI * h * ph) / h;
    x[i] = 0.2 * s;
  }
  return x;
}
export function __pulse(c: Case): Float32Array { return pulseVoice(c); }
function pulseVoice(c: Case): Float32Array {
  const n = Math.round(c.dur * SR);
  const src = new Float32Array(n);
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const p = c.pulse || {};
  let t = 0, k = 0;
  while (t < n) {
    const m = synthPitchAt(c.notes, t / SR);
    if (Number.isNaN(m)) { t += 32; continue; }
    const T = SR / (440 * Math.pow(2, (m - 69) / 12)) * (1 + (p.jitter || 0) * 2 * rnd());
    const a = k % 2 ? 1 - (p.alt || 0) : 1;
    // Impulsion glottique (dérivée de Rosenberg) sur une période.
    for (let i = 0; i < T && t + i < n; i++) {
      const ph = i / T;
      const g = ph < 0.4 ? Math.sin(Math.PI * ph / 0.4) * Math.PI / 0.4 * 0.5 : ph < 0.6 ? -Math.sin(Math.PI * (ph - 0.4) / 0.4) * Math.PI / 0.4 : 0;
      src[Math.floor(t + i)] += a * g / T;
    }
    t += T; k++;
  }
  // Souffle mêlé à la voix (là où elle chante).
  if (p.breath) for (let i = 0; i < n; i++) if (!Number.isNaN(synthPitchAt(c.notes, i / SR))) src[i] += p.breath * 0.02 * rnd();
  const out = new Float32Array(n);
  (c.formants || [[700, 130, 1], [1220, 190, 0.6], [2600, 250, 0.3]]).forEach(([fc, bw, g]) => {
    const r = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * fc / SR;
    const a1 = -2 * r * Math.cos(th), a2 = r * r;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const y = src[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = y; out[i] += g * y; }
  });
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= (c.amp ?? 0.25) / pk;
  return out;
}

/** Rafales de bruit blanc (consonnes « s », « t », « ch ») ajoutées au signal. */
function addBursts(x: Float32Array, bursts: [number, number][], amp = 0.2) {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const [at, len] of bursts) for (let i = Math.round(at * SR); i < Math.min(x.length, Math.round((at + len) * SR)); i++) x[i] += amp * 2 * rnd();
}

const seq = (midis: number[], len: number, gap: number, extra: Partial<SynthNote> = {}): SynthNote[] =>
  midis.map((m, i) => ({ midi: m, at: 0.1 + i * (len + gap), len, ...extra }));

export const CASES: Case[] = [
  { name: 'Voix grave de rap (82–110 Hz, fondamentale faible)', notes: seq([45, 43, 41, 40, 42, 45], 0.35, 0.06), dur: 2.6 },
  { name: 'Voix aiguë (523–988 Hz)', notes: seq([72, 76, 79, 83, 81, 74], 0.3, 0.05), dur: 2.3 },
  { name: 'Chant avec vibrato ±50 cents et glissés', notes: [
    { midi: 57, at: 0.1, len: 0.6, vibratoCents: 50, vibratoHz: 5.5 },
    { midi: 60, at: 0.7, len: 0.6, glide: 0.12, vibratoCents: 40 },
    { midi: 55, at: 1.3, len: 0.7, glide: 0.15, vibratoCents: 50, vibratoHz: 6 },
  ], dur: 2.2 },
  { name: 'Souffle entre les phrases (bruit −37 dBFS)', notes: seq([52, 55, 50], 0.35, 0.35), dur: 2.1, noise: 0.028 },
  { name: 'Consonnes (rafales de bruit) entre les notes', notes: seq([50, 53, 57, 52], 0.3, 0.12), dur: 2.0, bursts: [[0.41, 0.07], [0.83, 0.08], [1.25, 0.07], [1.67, 0.06]] },
  { name: 'Voix très douce (−50 dBFS)', notes: seq([55, 57, 59], 0.4, 0.08), dur: 1.7, amp: 0.006 },
  { name: 'Voix éraillée grave (une période sur deux à −6 dB, gigue 1,5 %)', notes: seq([43, 45, 41, 44, 40], 0.35, 0.05), dur: 2.1, pulse: { alt: 0.5, jitter: 0.015 } },
  { name: 'Voix éraillée médium (une période sur deux à −4 dB)', notes: seq([50, 52, 48, 53], 0.35, 0.05), dur: 1.8, pulse: { alt: 0.37, jitter: 0.01 } },
  { name: 'Voix soufflée (souffle mêlé, gigue 2 %)', notes: seq([55, 57, 52, 59], 0.35, 0.05), dur: 1.8, pulse: { breath: 1, jitter: 0.02 } },
  { name: 'Changement de timbre bref (harmoniques impaires à −22 dB pendant 25–35 ms)', notes: [{ midi: 45, at: 0.05, len: 1.6 }], dur: 1.7,
    flips: [[0.3, 0.025], [0.7, 0.03], [1.1, 0.035]] },
  { name: 'Bruit blanc seul (souffle fort, −20 dBFS)', notes: [], dur: 1.5, noise: 0.35 },
  { name: 'Bruit grave seul (ronflement de pièce, souffle dans le micro)', notes: [], dur: 1.5, brown: 0.3 },
  { name: 'Voix grave, timbre « téléphone » (fondamentale absente)', notes: seq([46, 44, 48, 43], 0.35, 0.06), dur: 1.8,
    formants: [[900, 120, 1], [1500, 150, 0.7], [2600, 200, 0.4]] },
];

interface Score { gross: number; octave: number; missed: number; falseVoiced: number; fineCents: number; frames: number }

export function score(c: Case, legacy: boolean, extra: Record<string, any> = {}): Score {
  const x = c.flips ? flipVoice(c) : c.pulse ? pulseVoice(c) : synthVoice(SR, c.dur, c.notes, { amp: c.amp, noise: c.noise, formants: c.formants });
  if (c.bursts) addBursts(x, c.bursts);
  if (c.brown) {
    let seed = 3, y = 0, z = 0, pk = 1e-9;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const b = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { y = 0.995 * y + rnd(); z = 0.9 * z + 0.1 * y; b[i] = z; pk = Math.max(pk, Math.abs(z)); }
    for (let i = 0; i < x.length; i++) x[i] += c.brown * b[i] / pk;
  }
  const frames = detectPitchTrack(x, SR, { legacy, median: true, ...extra });
  let voicedTruth = 0, gross = 0, octave = 0, missed = 0, unvTruth = 0, falseV = 0, judged = 0;
  const fine: number[] = [];
  const margin = 0.03 + (c.pulse ? 0.015 : 0);
  for (const f of frames) {
    const t = f.time;
    const truth = synthPitchAt(c.notes, t);
    const near = (dt: number) => !Number.isNaN(synthPitchAt(c.notes, t - dt)) !== !Number.isNaN(synthPitchAt(c.notes, t + dt));
    if (near(margin) || near(margin / 2)) continue;   // trames à cheval sur un début / une fin de note
    if (Number.isNaN(truth)) {
      unvTruth++;
      if (f.voiced) falseV++;
      continue;
    }
    voicedTruth++;
    if (!f.voiced) { missed++; continue; }
    judged++;
    const err = (f.midi - truth) * 100;
    if (Math.abs(err) > 50) gross++;
    if (Math.abs(err) > 600) octave++;
    else if (Math.abs(err) <= 50) fine.push(Math.abs(err));
  }
  fine.sort((a, b) => a - b);
  return {
    gross: judged ? gross / judged : 0, octave: judged ? octave / judged : 0,
    missed: voicedTruth ? missed / voicedTruth : 0, falseVoiced: unvTruth ? falseV / unvTruth : 0,
    fineCents: fine.length ? fine[Math.floor(fine.length / 2)] : NaN, frames: frames.length,
  };
}

const pct = (v: number) => `${(100 * v).toFixed(1)} %`;

describe('Détection de hauteur : avant → après (voix synthétiques)', () => {
  const rows: any[] = [];
  for (const c of CASES) {
    it(c.name, () => {
      const a = score(c, true), b = score(c, false);
      rows.push({ cas: c.name, avant: a, apres: b });
      // eslint-disable-next-line no-console
      console.log(`${c.name}\n  avant : grossières ${pct(a.gross)}, octave ${pct(a.octave)}, manquées ${pct(a.missed)}, faux voisement ${pct(a.falseVoiced)}, fine ${a.fineCents.toFixed(2)} c\n  après : grossières ${pct(b.gross)}, octave ${pct(b.octave)}, manquées ${pct(b.missed)}, faux voisement ${pct(b.falseVoiced)}, fine ${b.fineCents.toFixed(2)} c`);
      // Jamais pire qu'avant (petite marge pour les trames de bord), et plafonds absolus.
      expect(b.gross).toBeLessThanOrEqual(a.gross + 0.01);
      expect(b.missed).toBeLessThanOrEqual(a.missed + 0.02);
      expect(b.falseVoiced).toBeLessThanOrEqual(a.falseVoiced + 0.02);
      expect(b.falseVoiced).toBeLessThan(0.02);
      expect(b.gross).toBeLessThan(0.03);
      expect(b.octave).toBeLessThan(0.015);
      if (c.notes.length) expect(b.fineCents).toBeLessThan(c.pulse?.jitter ? 12 : c.notes.some(n => n.vibratoCents) ? 8 : 3);
    });
  }
  it('journal', () => {
    const out = process.env.NOVATUNE_OUT;
    if (out && rows.length) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'detection.json'), JSON.stringify(rows, null, 1)); }
  });
});

describe('Détection de hauteur : API', () => {
  it('voix tenue : note MIDI à 0,02 demi-ton près, fiabilité élevée, centre de trame cohérent', () => {
    const x = synthVoice(SR, 1, [{ midi: 57.37, at: 0, len: 1 }]);
    const fr = detectPitchTrack(x, SR).filter(f => f.time > 0.1 && f.time < 0.9);
    expect(fr.length).toBeGreaterThan(100);
    for (const f of fr) { expect(f.voiced).toBe(true); expect(Math.abs(f.midi - 57.37)).toBeLessThan(0.02); expect(f.confidence).toBeGreaterThan(0.8); }
  });
  it('silence → aucune trame voisée ; plage restreinte (type de voix) respectée', () => {
    const det = createPitchDetector(SR);
    det.push(new Float32Array(4800));
    expect(det.estimate().voiced).toBe(false);
    const x = synthVoice(SR, 0.5, [{ midi: 69, at: 0, len: 0.5 }]);
    const fr = detectPitchTrack(x, SR, { range: [75, 300] }).filter(f => f.voiced && f.time > 0.1 && f.time < 0.4);
    // 440 Hz hors de la plage 75–300 Hz : au mieux l'octave du dessous, jamais 440.
    for (const f of fr) expect(f.f0).toBeLessThan(310);
  });
  it('44,1 / 48 / 96 kHz : même hauteur', () => {
    for (const sr of [44100, 48000, 96000]) {
      const x = synthVoice(sr, 0.6, [{ midi: 50.2, at: 0, len: 0.6 }]);
      const fr = detectPitchTrack(x, sr).filter(f => f.time > 0.1 && f.time < 0.5);
      for (const f of fr) expect(Math.abs(f.midi - 50.2)).toBeLessThan(0.02);
    }
  });
});
