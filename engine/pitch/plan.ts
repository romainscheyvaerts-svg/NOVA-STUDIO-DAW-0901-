/**
 * Nova Pitch · plan de rendu : des retouches note par note (hauteur, dérive,
 * vibrato, transition, formant, gain, timing) au plan que suit le rendu
 * (engine/pitch/render). Logique pure.
 */
import type { PitchNote, PitchTrack } from '../../utils/pitchAnalysis';
import { correctionParts, formantCurve, hasFormant, type NoteEdit } from '../../utils/pitchCorrect';
import type { NoteShape } from './notes';
import { buildTimeMap, quietFinder, srcToDst, type TimeMap, type TimingNote } from './timeMap';
import type { GainSeg, RenderPlan, VibClock } from './render';

export interface PlanInput {
  track: PitchTrack;
  notes: PitchNote[];
  shapes: NoteShape[];
  edits: (NoteEdit | undefined)[];
  /** Fin du son rendu décalée (s) : option « décaler la suite ». */
  extend?: number;
}

/** Décalages de timing en échantillons entiers (alignement à l'échantillon). */
const samples = (sec: number | undefined, sr: number) => Math.round((sec || 0) * sr);

export function timeMapOf(input: PlanInput): TimeMap {
  const { track, notes, shapes, edits } = input;
  const sr = track.sr;
  const tn: TimingNote[] = notes.map((n, k) => ({
    start: Math.round(n.start * sr), end: Math.round(n.end * sr),
    s0: Math.round((shapes[k]?.s0 ?? n.start) * sr), s1: Math.round((shapes[k]?.s1 ?? n.end) * sr),
    d0: samples(edits[k]?.dt0, sr), d1: samples(edits[k]?.dt1, sr),
  }));
  return buildTimeMap(tn, track.length, samples(input.extend, sr), quietFinder(track.rmsDb, track.hop, sr));
}

/**
 * Période (échantillons) d'une oscillation de 3,5 à 9 Hz dans `v` (trames
 * [i0, i1[) : pic d'autocorrélation interpolé ; 0 si rien de net.
 */
export function vibPeriod(v: Float32Array, i0: number, i1: number, hop: number, sr: number): number {
  const fps = sr / hop;
  const lo = Math.max(2, Math.floor(fps / 9)), hi = Math.ceil(fps / 3.5);
  const n = i1 - i0;
  if (n < hi * 1.5) return 0;
  const ac = (lag: number) => { let s = 0, e = 0; for (let i = i0; i + lag < i1; i++) { s += v[i] * v[i + lag]; e += v[i] * v[i]; } return e > 0 ? s / e : 0; };
  let best = -1, bv = -Infinity;
  for (let lag = lo; lag <= hi; lag++) { const c = ac(lag); if (c > bv && c >= ac(lag - 1) && c >= ac(lag + 1)) { bv = c; best = lag; } }
  if (best < 0 || bv < 0.3) return 0;
  const y0 = ac(best - 1), y1 = ac(best), y2 = ac(best + 1), den = y0 + y2 - 2 * y1;
  return (best + (Math.abs(den) > 1e-12 ? (y0 - y2) / (2 * den) : 0)) * hop;
}

export function buildPlan(input: PlanInput): RenderPlan {
  const { track, notes, shapes, edits } = input;
  const sr = track.sr;
  const { corr, vib } = correctionParts(track, notes, edits);
  const formant = hasFormant(edits) ? formantCurve(track, notes, edits) : undefined;
  const map = timeMapOf(input);
  const clocks: VibClock[] = [];
  const gains: GainSeg[] = [];
  notes.forEach((n, k) => {
    const e = edits[k];
    const sh = shapes[k];
    if (sh && (e?.dt0 || e?.dt1) && sh.vibRate > 0) {
      const s0 = Math.round(sh.s0 * sr), s1 = Math.round(sh.s1 * sr);
      const t0 = srcToDst(map, s0), t1 = srcToDst(map, s1);
      if (Math.abs((t1 - t0) - (s1 - s0)) >= 1) {
        // Période du vibrato RELU par l'horloge (la part vibrato de la hauteur visée), mesurée
        // sur la partie tenue ; à défaut, celle de l'analyse de la note.
        const P = vibPeriod(vib, Math.round(s0 / track.hop), Math.round(s1 / track.hop), track.hop, sr) || sr / sh.vibRate;
        clocks.push({ t0, t1, P, F: Math.min(0.08 * sr, 0.25 * (t1 - t0), P) });
      }
    }
    if (e?.gainDb && Math.abs(e.gainDb) >= 0.05) {
      gains.push({ a: srcToDst(map, Math.round(n.start * sr)), b: srcToDst(map, Math.round(n.end * sr)), db: e.gainDb });
    }
  });
  return { track, corr, vib, ...(formant ? { formant } : {}), map, ...(clocks.length ? { clocks } : {}), ...(gains.length ? { gains } : {}) };
}
