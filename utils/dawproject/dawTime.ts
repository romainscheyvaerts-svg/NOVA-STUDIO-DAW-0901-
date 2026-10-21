/**
 * Horloge temps ↔ noires du format DAWproject : un tempo de départ et des points de
 * tempo (paliers « hold » ou rampes linéaires en noires). NOVA range tout en secondes ;
 * le format range l'arrangement en noires (« beats »), d'où cette conversion exacte
 * dans les deux sens (rampe : intégrale de 60 / bpm, logarithme).
 */
import { buildTempoMap, quartersAt } from '../tempoMap';
import type { DAWState } from '../../types';

export interface TempoPoint { beat: number; bpm: number; ramp?: boolean }

interface Seg { beat: number; time: number; bpm: number; k: number }

export class BeatClock {
  private segs: Seg[];
  constructor(startBpm: number, points: TempoPoint[] = []) {
    const okBpm = (b: number) => (Number.isFinite(b) && b > 0 ? b : 120);
    const pts = [{ beat: 0, bpm: okBpm(startBpm), ramp: false }, ...points.filter(p => Number.isFinite(p.beat) && p.beat >= 0).map(p => ({ ...p, bpm: okBpm(p.bpm) }))]
      .sort((a, b) => a.beat - b.beat);
    // Point à 0 : il remplace le tempo de départ.
    const merged: TempoPoint[] = [];
    for (const p of pts) { if (merged.length && Math.abs(merged[merged.length - 1].beat - p.beat) < 1e-12) merged[merged.length - 1] = p; else merged.push(p); }
    this.segs = [];
    let time = 0;
    for (let i = 0; i < merged.length; i++) {
      const p = merged[i], nx = merged[i + 1];
      // Rampe : le tempo va linéairement (en noires) de ce point au suivant si le SUIVANT est en rampe.
      const k = nx && nx.ramp && nx.beat > p.beat ? (nx.bpm - p.bpm) / (nx.beat - p.beat) : 0;
      this.segs.push({ beat: p.beat, time, bpm: p.bpm, k });
      if (nx) time += this.span(this.segs[i], nx.beat - p.beat);
    }
  }
  private span(s: Seg, db: number): number {
    if (Math.abs(s.k) < 1e-12) return (db * 60) / s.bpm;
    return (60 / s.k) * Math.log((s.bpm + s.k * db) / s.bpm);
  }
  private segAtBeat(b: number): Seg { let r = this.segs[0]; for (const s of this.segs) { if (s.beat <= b + 1e-12) r = s; else break; } return r; }
  private segAtTime(t: number): Seg { let r = this.segs[0]; for (const s of this.segs) { if (s.time <= t + 1e-12) r = s; else break; } return r; }
  /** Noires → secondes. */
  secAt(beat: number): number {
    if (beat <= 0) return (beat * 60) / this.segs[0].bpm;
    const s = this.segAtBeat(beat);
    return s.time + this.span(s, beat - s.beat);
  }
  /** Secondes → noires. */
  beatAt(sec: number): number {
    if (sec <= 0) return (sec * this.segs[0].bpm) / 60;
    const s = this.segAtTime(sec);
    const dt = sec - s.time;
    if (Math.abs(s.k) < 1e-12) return s.beat + (dt * s.bpm) / 60;
    return s.beat + (s.bpm * Math.exp((s.k * dt) / 60) - s.bpm) / s.k;
  }
  /** Tempo à une position (noires). */
  bpmAt(beat: number): number { const s = this.segAtBeat(beat); return s.bpm + s.k * (beat - s.beat); }
  get hasRamps(): boolean { return this.segs.some(s => Math.abs(s.k) > 1e-12); }
  get points(): TempoPoint[] { return this.segs.map(s => ({ beat: s.beat, bpm: s.bpm })); }
}

/** Horloge d'un projet NOVA (tempo de départ + changements posés aux mesures). */
export function novaClock(state: Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents'>): BeatClock {
  const map = buildTempoMap(state.bpm, state.timeSignature, state.tempoEvents);
  return new BeatClock(map.segments[0].bpm, map.segments.slice(1).map(s => ({ beat: quartersAt(map, s.time), bpm: s.bpm })));
}
