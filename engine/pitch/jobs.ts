/**
 * Nova Pitch · calculs lourds (analyse, rendu), partagés entre le worker et le
 * repli dans le fil principal. Chaque région de son gardée ici garde aussi ses
 * marques de période (calculées une fois) : un nouveau rendu après une
 * retouche ne coûte que le recollement des grains.
 */
import type { PitchNote, PitchTrack } from '../../utils/pitchAnalysis';
import type { NoteEdit } from '../../utils/pitchCorrect';
import { analyzeVoice, type VoiceAnalysis } from './analysis';
import { voiceMarks } from './marks';
import { noteShape } from './notes';
import { buildPlan } from './plan';
import { renderVoice } from './render';
import type { PitchMarks } from './marks';
import { monoOf } from '../../utils/pitchAnalysis';

export interface RenderJob {
  notes: PitchNote[];
  edits: (NoteEdit | undefined)[];
  extend?: number;
}

interface Entry { channels: Float32Array[]; track?: PitchTrack; marks?: PitchMarks; used: number }

/** Régions gardées (worker ou repli). */
export class PitchStore {
  private entries = new Map<string, Entry>();
  constructor(private max = 6) {}

  has(key: string) { return this.entries.has(key); }

  load(key: string, channels: Float32Array[], track?: PitchTrack) {
    this.entries.set(key, { channels, track, used: Date.now() });
    this.trim();
  }

  drop(key: string) { this.entries.delete(key); }

  private trim() {
    while (this.entries.size > this.max) {
      let oldest = '', t = Infinity;
      for (const [k, e] of this.entries) if (e.used < t) { t = e.used; oldest = k; }
      this.entries.delete(oldest);
    }
  }

  analyze(key: string, channels: Float32Array[], sr: number, onProgress?: (p: number) => void): VoiceAnalysis {
    const a = analyzeVoice(channels, sr, onProgress);
    this.entries.set(key, { channels, track: a.track, used: Date.now() });
    this.trim();
    return a;
  }

  /** null : région inconnue (à recharger). */
  render(key: string, job: RenderJob): Float32Array[] | null {
    const e = this.entries.get(key);
    if (!e?.track) return null;
    e.used = Date.now();
    if (!e.marks) e.marks = voiceMarks(monoOf(e.channels), e.track);
    const shapes = job.notes.map(n => noteShape(e.track!, n));
    const plan = buildPlan({ track: e.track, notes: job.notes, shapes, edits: job.edits, extend: job.extend });
    return renderVoice(e.channels, e.marks, plan);
  }
}

export type WorkerIn =
  | { type: 'analyze'; id: number; key: string; channels: Float32Array[]; sr: number }
  | { type: 'load'; key: string; channels: Float32Array[]; track: PitchTrack }
  | { type: 'render'; id: number; key: string; job: RenderJob }
  | { type: 'drop'; key: string };

export type WorkerOut =
  | { id: number; progress: number }
  | { id: number; analysis: VoiceAnalysis }
  | { id: number; channels: Float32Array[] }
  | { id: number; need: true }
  | { id: number; error: string };
