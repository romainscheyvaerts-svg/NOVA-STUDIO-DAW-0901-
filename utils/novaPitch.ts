/**
 * Nova Pitch (éditeur de notes de la voix) : le lien entre les retouches et
 * le clip du projet. Logique pure (tests/novaPitch*.test.ts).
 *
 * Chaque geste de l'éditeur pose UNE étape d'annulation : les retouches
 * (`Clip.pitchEdit`) changent tout de suite ; le son rendu arrive ensuite,
 * calculé en arrière-plan, et remplace le son joué SANS nouvelle étape
 * (utils/novaPitchHost). `renderSig` dit pour quelles retouches le son joué a
 * été rendu : s'il ne correspond plus (annuler, rétablir, collaboration), le
 * son est recalculé. Lecture et export jouent le même son rendu.
 */
import type { Clip, PitchEditInfo, StoredNoteEdit } from '../types';
import { REGION_PAD, shiftBreaths } from './pitchEdit';
import type { NoteLayout } from '../engine/pitch/notes';

/** Région du son d'origine analysée pour un clip : la région rangée si le clip y tient encore. */
export function pitchRegion(clip: Pick<Clip, 'duration' | 'pitchEdit'>, sourceOffset: number, bufferDuration: number): { start: number; end: number } {
  const pe = clip.pitchEdit;
  const ext = pe?.extend || 0;
  // Partie du son d'origine jouée par le clip (sans l'allongement « décaler la suite »).
  const a = sourceOffset, b = sourceOffset + Math.max(0, clip.duration - ext);
  if (pe && typeof pe.regionEnd === 'number' && pe.regionStart <= a + 1e-6 && pe.regionEnd >= b - 1e-6 && pe.regionEnd <= bufferDuration + 1e-6) {
    return { start: pe.regionStart, end: pe.regionEnd };
  }
  const start = Math.max(0, a - REGION_PAD);
  const end = Math.min(bufferDuration, b + REGION_PAD);
  return { start, end: Math.max(start, end) };
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Signature des retouches d'un clip (ce que le son rendu doit refléter). */
export function infoSig(pe: Pick<PitchEditInfo, 'edits' | 'cuts' | 'joins' | 'extend' | 'regionStart' | 'regionEnd'> | undefined): string {
  if (!pe) return '';
  const s = JSON.stringify([r4(pe.regionStart), pe.regionEnd !== undefined ? r4(pe.regionEnd) : null, pe.edits.map(e => [e.t0, e.t1, e.shift, e.drift, e.vibrato, e.transitionMs ?? null, e.formant ?? 0, e.gain ?? 0, e.dt0 ?? 0, e.dt1 ?? 0]), pe.cuts || [], pe.joins || [], pe.extend || 0]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length}:${h.toString(16)}`;
}

/** Découpage rangé (instants du son d'origine) → découpage de la région (s depuis son début). */
export function layoutOf(pe: Pick<PitchEditInfo, 'cuts' | 'joins'> | undefined, regionStart: number): NoteLayout {
  const rel = (v: number[] | undefined) => (v?.length ? v.map(t => r4(t - regionStart)) : undefined);
  const cuts = rel(pe?.cuts), joins = rel(pe?.joins);
  return { ...(cuts ? { cuts } : {}), ...(joins ? { joins } : {}) };
}

/** Découpage de la région → instants du son d'origine. */
export function storeLayout(layout: NoteLayout | undefined, regionStart: number): Pick<PitchEditInfo, 'cuts' | 'joins'> {
  const abs = (v: number[] | undefined) => (v?.length ? v.map(t => r4(t + regionStart)) : undefined);
  const cuts = abs(layout?.cuts), joins = abs(layout?.joins);
  return { ...(cuts ? { cuts } : {}), ...(joins ? { joins } : {}) };
}

export interface PendingOpts {
  /** Son d'origine et instant où le clip y commence. */
  sourceBufferId: string;
  sourceOffset: number;
  region: { start: number; end: number };
  edits: StoredNoteEdit[];
  layout?: NoteLayout;
  extend?: number;
  amount?: number;
  style?: 'naturel' | 'robot';
  at?: number;
}

/**
 * Changements du clip pour un geste de l'éditeur (une étape d'annulation) :
 * nouvelles retouches ; le son joué ne change pas encore (il sera remplacé
 * par le rendu). Si la région analysée change alors que le clip joue un
 * ancien rendu, le clip revient d'abord à la prise d'origine (son et position
 * toujours cohérents).
 */
export function pendingPatch(clip: Clip, o: PendingOpts): Partial<Clip> {
  const prev = clip.pitchEdit;
  const playsSource = !prev || clip.bufferId === o.sourceBufferId;
  const sameRegion = !!prev && Math.abs(prev.regionStart - o.region.start) < 1e-6;
  const extend = Math.round((o.extend || 0) * 1e5) / 1e5;
  const info: PitchEditInfo = {
    version: 1,
    sourceBufferId: o.sourceBufferId,
    regionStart: o.region.start,
    regionEnd: o.region.end,
    edits: o.edits,
    ...storeLayout(o.layout, o.region.start),
    ...(Math.abs(extend) >= 1e-5 ? { extend } : {}),
    ...(o.amount !== undefined ? { amount: o.amount } : prev?.amount !== undefined ? { amount: prev.amount } : {}),
    ...(o.style ? { style: o.style } : prev?.style ? { style: prev.style } : {}),
    sourceWarp: prev ? prev.sourceWarp : clip.warp,
    sourceName: prev?.sourceName ?? clip.name,
    at: o.at,
    renderSig: playsSource || !sameRegion ? '' : prev?.renderSig ?? '',
  };
  const patch: Partial<Clip> = { pitchEdit: info };
  const dExt = extend - (prev?.extend || 0);
  if (Math.abs(dExt) >= 1e-6) patch.duration = Math.max(0.01, clip.duration + dExt);
  if (!playsSource && !sameRegion) {
    // Retour à la prise d'origine en attendant le nouveau rendu.
    patch.bufferId = o.sourceBufferId;
    patch.offset = o.sourceOffset;
    if (clip.breaths?.length) patch.breaths = shiftBreaths(clip.breaths, o.sourceOffset - (clip.offset || 0));
  }
  return patch;
}

/**
 * Changements du clip quand le rendu des retouches `sig` est prêt (sans
 * étape d'annulation) : le clip joue le son rendu, qui commence au début de
 * la région analysée.
 */
export function renderedPatch(clip: Clip, newBufferId: string, sig: string): Partial<Clip> | null {
  const pe = clip.pitchEdit;
  if (!pe?.sourceBufferId) return null;
  const playsSource = clip.bufferId === pe.sourceBufferId;
  const offset = playsSource ? Math.max(0, (clip.offset || 0) - pe.regionStart) : clip.offset || 0;
  const baseName = pe.sourceName ?? clip.name;
  return {
    bufferId: newBufferId,
    offset,
    ...(playsSource && clip.breaths?.length ? { breaths: shiftBreaths(clip.breaths, offset - (clip.offset || 0)) } : {}),
    warp: undefined,
    name: /justesse|notes retouchées/i.test(baseName) ? baseName : `${baseName} (notes retouchées)`,
    pitchEdit: { ...pe, renderSig: sig },
  };
}

/** Le son joué ne reflète pas (ou plus) les retouches : un rendu est à faire. */
export function needsRender(clip: Clip, hasBuffer: (id: string) => boolean): boolean {
  const pe = clip.pitchEdit;
  if (!pe || typeof pe.renderSig !== 'string' || !pe.sourceBufferId) return false;
  return pe.renderSig !== infoSig(pe) || !hasBuffer(clip.bufferId || '');
}
