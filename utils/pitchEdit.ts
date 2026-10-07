/**
 * Justesse note par note (V19) : le lien entre l'éditeur, le projet et le
 * calcul (analyse + rendu dans un worker).
 *
 * Non destructif : le clip corrigé joue un NOUVEL audio, rendu une fois hors
 * ligne (lecture et export identiques : c'est le même son). Le son d'origine
 * reste en mémoire et dans la sauvegarde (`Clip.pitchEdit.sourceBufferId`),
 * pour revenir en arrière ou retoucher sans dégrader (on repart toujours de
 * la prise d'origine). Ctrl+Z annule aussi la correction.
 *
 * En collaboration, le clip corrigé voyage comme un clip audio normal. La
 * prise d'origine reste chez celui qui a corrigé : chez l'autre, l'éditeur
 * repart du son corrigé.
 */
import type { Clip, PitchEditInfo, StoredNoteEdit } from '../types';
import { analyzePitch, monoOf, segmentNotes, PitchNote, PitchTrack } from './pitchAnalysis';
import { correctionCurve, CorrectStyle, NoteEdit, isNeutral } from './pitchCorrect';
import { renderPitch } from './pitchRender';

export type { StoredNoteEdit, PitchEditInfo } from '../types';

/** Marge d'audio prise autour du clip (s) : les fins de notes restent naturelles si on rallonge le clip. */
export const REGION_PAD = 0.25;

/** Partie du son à analyser et à rendre pour un clip : [début, fin[ en secondes dans le son. */
export function clipRegion(clip: Pick<Clip, 'offset' | 'duration'>, bufferDuration: number): { start: number; end: number } {
  const start = Math.max(0, (clip.offset || 0) - REGION_PAD);
  const end = Math.min(bufferDuration, (clip.offset || 0) + clip.duration + REGION_PAD);
  return { start, end: Math.max(start, end) };
}

/**
 * Le clip tel qu'on l'édite : pour un clip déjà corrigé dont on a encore la
 * prise d'origine, on repart d'elle (offset ramené dans le son d'origine).
 */
export function editingSource(clip: Clip, hasBuffer: (id: string) => boolean): { bufferId?: string; offset: number; fromOriginal: boolean } {
  const pe = clip.pitchEdit;
  if (pe?.sourceBufferId && hasBuffer(pe.sourceBufferId)) {
    return { bufferId: pe.sourceBufferId, offset: (clip.offset || 0) + pe.regionStart, fromOriginal: true };
  }
  return { bufferId: clip.bufferId, offset: clip.offset || 0, fromOriginal: false };
}

/** Retouches enregistrées → retouches des notes trouvées (par recouvrement dans le temps). */
export function editsForNotes(notes: PitchNote[], stored: StoredNoteEdit[] | undefined, regionStart: number): (NoteEdit | undefined)[] {
  if (!stored?.length) return notes.map(() => undefined);
  return notes.map(n => {
    const a = n.start + regionStart, b = n.end + regionStart;
    let best: StoredNoteEdit | undefined, bestOv = 0;
    for (const s of stored) {
      const ov = Math.min(b, s.t1) - Math.max(a, s.t0);
      if (ov > bestOv) { bestOv = ov; best = s; }
    }
    if (!best || bestOv < 0.5 * Math.min(b - a, best.t1 - best.t0)) return undefined;
    const { t0: _a, t1: _b, manual: _m, ...edit } = best;
    return edit;
  });
}

/** Notes retouchées à la main d'après les retouches enregistrées. */
export function manualNotes(notes: PitchNote[], stored: StoredNoteEdit[] | undefined, regionStart: number): Set<number> {
  const out = new Set<number>();
  if (!stored?.length) return out;
  notes.forEach((n, k) => {
    const a = n.start + regionStart, b = n.end + regionStart;
    if (stored.some(s => s.manual && Math.min(b, s.t1) - Math.max(a, s.t0) >= 0.5 * Math.min(b - a, s.t1 - s.t0))) out.add(k);
  });
  return out;
}

/** Retouches des notes → forme rangée dans le projet (seulement les notes retouchées). */
export function storeEdits(notes: PitchNote[], edits: (NoteEdit | undefined)[], regionStart: number, manual?: Set<number>): StoredNoteEdit[] {
  const out: StoredNoteEdit[] = [];
  notes.forEach((n, k) => {
    const e = edits[k];
    if (!e || isNeutral(e)) return;
    const r = (v: number) => Math.round(v * 10000) / 10000;
    out.push({ t0: r(n.start + regionStart), t1: r(n.end + regionStart), shift: r(e.shift), drift: r(e.drift), vibrato: r(e.vibrato), ...(e.transitionMs !== undefined ? { transitionMs: Math.round(e.transitionMs) } : {}), ...(manual?.has(k) ? { manual: true } : {}) });
  });
  return out;
}

/** Changements du clip quand on applique la correction (nouveau son déjà enregistré sous `newBufferId`). */
export function correctedClipPatch(clip: Clip, opts: {
  newBufferId: string; sourceBufferId?: string; sourceOffset: number; regionStart: number;
  edits: StoredNoteEdit[]; amount?: number; style?: CorrectStyle; at?: number;
}): Partial<Clip> {
  const prev = clip.pitchEdit;
  const baseName = prev?.sourceName ?? clip.name;
  const info: PitchEditInfo = {
    version: 1,
    sourceBufferId: opts.sourceBufferId,
    regionStart: opts.regionStart,
    edits: opts.edits,
    amount: opts.amount,
    style: opts.style,
    sourceWarp: prev ? prev.sourceWarp : clip.warp,
    sourceName: baseName,
    at: opts.at,
  };
  return {
    bufferId: opts.newBufferId,
    // Le son corrigé commence à `regionStart` dans le son d'origine.
    offset: Math.max(0, opts.sourceOffset - opts.regionStart),
    // Un calage sur le tempo repartirait du son d'origine et perdrait la correction.
    warp: undefined,
    name: /justesse/i.test(baseName) ? baseName : `${baseName} (justesse)`,
    pitchEdit: info,
  };
}

/** Changements du clip pour revenir à la prise d'origine (null si elle n'est plus disponible). */
export function revertClipPatch(clip: Clip, hasBuffer: (id: string) => boolean): Partial<Clip> | null {
  const pe = clip.pitchEdit;
  if (!pe?.sourceBufferId || !hasBuffer(pe.sourceBufferId)) return null;
  return {
    bufferId: pe.sourceBufferId,
    offset: (clip.offset || 0) + pe.regionStart,
    warp: pe.sourceWarp,
    name: pe.sourceName ?? clip.name.replace(/\s*\(justesse\)$/, ''),
    pitchEdit: undefined,
  };
}

// ---------------------------------------------------------------------------
// Calcul (worker, avec repli dans le fil principal)
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  track: PitchTrack;
  notes: PitchNote[];
}

export type PitchJob =
  | { kind: 'analyze'; channels: Float32Array[]; sr: number }
  | { kind: 'render'; channels: Float32Array[]; track: PitchTrack; curve: Float32Array };

export function runJob(job: PitchJob): { analysis?: AnalysisResult; channels?: Float32Array[] } {
  if (job.kind === 'analyze') {
    const track = analyzePitch(monoOf(job.channels), job.sr);
    return { analysis: { track, notes: segmentNotes(track) } };
  }
  return { channels: renderPitch(job.channels, job.track, job.curve) };
}

/** Tranche de canaux [start, end[ (secondes) d'un AudioBuffer, copiée. */
export function sliceChannels(buffer: AudioBuffer, start: number, end: number): Float32Array[] {
  const a = Math.max(0, Math.floor(start * buffer.sampleRate));
  const b = Math.min(buffer.length, Math.max(a + 1, Math.round(end * buffer.sampleRate)));
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c).slice(a, b));
  return out;
}

async function inWorker(job: PitchJob): Promise<{ analysis?: AnalysisResult; channels?: Float32Array[] }> {
  if (typeof Worker === 'undefined') return runJob(job);
  try {
    const worker = new Worker(new URL('./pitchEdit.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => (e.data?.error ? reject(new Error(e.data.error)) : resolve(e.data));
        worker.onerror = ev => reject(ev);
        const transfer = job.channels.map(c => c.buffer as ArrayBuffer);
        worker.postMessage(job, transfer);
      });
    } finally {
      worker.terminate();
    }
  } catch (e) {
    console.warn('[justesse] worker indisponible, calcul ici', e);
    return runJob(job);
  }
}

/** Analyse la partie [start, end[ (s) d'un son. */
export async function analyzeRegion(buffer: AudioBuffer, start: number, end: number): Promise<AnalysisResult> {
  const r = await inWorker({ kind: 'analyze', channels: sliceChannels(buffer, start, end), sr: buffer.sampleRate });
  return r.analysis!;
}

/** Rend la partie [start, end[ (s) d'un son avec la courbe de correction. */
export async function renderRegion(ctx: BaseAudioContext, buffer: AudioBuffer, start: number, end: number, track: PitchTrack, notes: PitchNote[], edits: (NoteEdit | undefined)[]): Promise<AudioBuffer> {
  const curve = correctionCurve(track, notes, edits);
  const r = await inWorker({ kind: 'render', channels: sliceChannels(buffer, start, end), track, curve });
  const ch = r.channels!;
  const out = ctx.createBuffer(ch.length, ch[0].length, buffer.sampleRate);
  ch.forEach((c, i) => out.getChannelData(i).set(c));
  return out;
}
