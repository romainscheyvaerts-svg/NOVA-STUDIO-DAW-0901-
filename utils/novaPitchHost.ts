/**
 * Nova Pitch : rendu en arrière-plan des clips retouchés.
 *
 * Après chaque geste de l'éditeur (une étape d'annulation : les retouches),
 * le son est calculé ici puis posé dans le clip SANS nouvelle étape
 * (`setSilently`). Même chose quand les retouches changent sans l'éditeur :
 * annuler / rétablir, collaboration, son rendu libéré de la mémoire. Un seul
 * chemin de rendu : l'éditeur écoute les mêmes sons que la lecture et l'export.
 *
 * Mémoire : les rendus qui ne servent plus au projet présent (seulement à
 * l'historique d'annulation) sont libérés au-delà de 256 Mo ; si on revient
 * dessus (Ctrl+Z), ils sont recalculés à l'identique sous le même nom.
 */
import type { Clip, DAWState, Track } from '../types';
import { audioBufferRegistry } from './audioBufferRegistry';
import { analysisKey, analysisCache, type VoiceAnalysis } from '../engine/pitch/analysis';
import { analyzeInBackground, renderInBackground } from '../engine/pitch/client';
import { applyLayout } from '../engine/pitch/notes';
import { editingSource, editsForNotes, sliceChannels } from './pitchEdit';
import { infoSig, layoutOf, needsRender, pitchRegion, renderedPatch } from './novaPitch';

export interface ClipVoice {
  key: string;
  sourceBufferId: string;
  source: AudioBuffer;
  /** Instant du son d'origine où le clip commence. */
  sourceOffset: number;
  region: { start: number; end: number };
  channels: Float32Array[];
  analysis: VoiceAnalysis;
}

/** Son d'origine d'un clip, région analysée et analyse (en cache, sinon calculée dans le worker). */
export async function loadClipVoice(clip: Clip, onProgress?: (p: number) => void): Promise<ClipVoice> {
  const src = editingSource(clip, id => audioBufferRegistry.has(id));
  const source = src.bufferId ? audioBufferRegistry.get(src.bufferId) : undefined;
  if (!source || !src.bufferId) throw new Error("Le son de ce clip n'est pas chargé : lance la lecture une fois puis réessaie.");
  const region = pitchRegion(clip, src.offset, source.duration);
  const key = analysisKey(src.bufferId, region.start, region.end);
  const channels = sliceChannels(source, region.start, region.end);
  const analysis = await analyzeInBackground(key, channels, source.sampleRate, onProgress);
  return { key, sourceBufferId: src.bufferId, source, sourceOffset: src.offset, region, channels, analysis };
}

const toBuffer = (channels: Float32Array[], sampleRate: number): AudioBuffer => {
  const b = new AudioBuffer({ length: Math.max(1, channels[0]?.length || 1), numberOfChannels: Math.max(1, channels.length), sampleRate });
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
};

/** Rendu des retouches rangées dans un clip (son d'origine requis). */
export async function renderClipEdits(clip: Clip): Promise<AudioBuffer> {
  const pe = clip.pitchEdit;
  if (!pe?.sourceBufferId) throw new Error('pas de retouche');
  const source = audioBufferRegistry.get(pe.sourceBufferId);
  if (!source) throw new Error("La prise d'origine n'est pas sur cet appareil.");
  const region = { start: pe.regionStart, end: pe.regionEnd ?? Math.min(source.duration, pe.regionStart + clip.duration + 0.5) };
  const key = analysisKey(pe.sourceBufferId, region.start, region.end);
  const channels = sliceChannels(source, region.start, region.end);
  const analysis = analysisCache.get(key) ?? await analyzeInBackground(key, channels, source.sampleRate);
  const notes = applyLayout(analysis.track, analysis.notes, layoutOf(pe, region.start));
  const edits = editsForNotes(notes, pe.edits, region.start);
  const out = await renderInBackground(key, channels, analysis.track, { notes, edits, extend: pe.extend });
  return toBuffer(out, source.sampleRate);
}

// ---------------------------------------------------------------------------
// Suivi : rendus en cours, attente côté éditeur
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
const inflight = new Map<string, string>(); // clipId → signature en cours de rendu
const waiters = new Map<string, { sig: string; resolve: (b: AudioBuffer | null) => void }[]>();
const failedSig = new Map<string, string>();
let seq = 0;

const emit = () => listeners.forEach(l => { try { l(); } catch { /* écouteur */ } });

export const pitchRenderStatus = {
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Un rendu est en cours pour ce clip. */
  busy: (clipId: string) => inflight.has(clipId),
};

/** Attend le son rendu des retouches `sig` d'un clip (null si abandonné). */
export function whenRendered(clipId: string, sig: string): Promise<AudioBuffer | null> {
  return new Promise(resolve => {
    const list = waiters.get(clipId) || [];
    list.push({ sig, resolve });
    waiters.set(clipId, list);
  });
}

function settle(clipId: string, sig: string, buf: AudioBuffer | null) {
  const list = waiters.get(clipId);
  if (!list) return;
  const keep = list.filter(w => {
    if (w.sig === sig || !buf) { w.resolve(buf); return false; }
    return true;
  });
  if (keep.length) waiters.set(clipId, keep); else waiters.delete(clipId);
}

const RENDER_PREFIX = 'nvp-';
const BUDGET_BYTES = 256 * 1024 * 1024;
const born = new Map<string, number>();

/** Libère les rendus que le projet présent ne joue plus, au-delà du budget mémoire. */
function evict(tracks: Track[]) {
  const used = new Set<string>();
  for (const t of tracks) for (const c of t.clips) if (c.bufferId) used.add(c.bufferId);
  const spare = audioBufferRegistry.ids().filter(id => id.startsWith(RENDER_PREFIX) && !used.has(id));
  const size = (id: string) => { const b = audioBufferRegistry.get(id); return b ? b.length * b.numberOfChannels * 4 : 0; };
  let total = spare.reduce((s, id) => s + size(id), 0);
  spare.sort((a, b) => (born.get(a) || 0) - (born.get(b) || 0));
  for (const id of spare) {
    if (total <= BUDGET_BYTES) break;
    total -= size(id);
    audioBufferRegistry.remove(id);
    born.delete(id);
  }
}

export interface HostOps {
  getTracks: () => Track[];
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  notify?: (msg: string) => void;
}

const findClip = (tracks: Track[], clipId: string): { track: Track; clip: Clip } | null => {
  for (const t of tracks) { const c = t.clips.find(x => x.id === clipId); if (c) return { track: t, clip: c }; }
  return null;
};

/** Lance les rendus nécessaires (à appeler à chaque changement des pistes). */
export function syncPitchRenders(tracks: Track[], ops: HostOps) {
  const has = (id: string) => audioBufferRegistry.has(id);
  for (const t of tracks) for (const clip of t.clips) {
    if (!needsRender(clip, has)) continue;
    const pe = clip.pitchEdit!;
    if (!pe.sourceBufferId || !has(pe.sourceBufferId)) continue;
    const sig = infoSig(pe);
    if (inflight.get(clip.id) === sig || failedSig.get(clip.id) === sig) continue;
    // Rendu plus ancien en cours : le nouveau prendra la suite à son retour.
    if (inflight.has(clip.id)) continue;
    inflight.set(clip.id, sig);
    emit();
    const snapshot = clip;
    void renderClipEdits(snapshot).then(buf => {
      const now = findClip(ops.getTracks(), snapshot.id);
      const live = now?.clip;
      if (!live?.pitchEdit || infoSig(live.pitchEdit) !== sig) { settle(snapshot.id, sig, null); return; }
      if (live.pitchEdit.renderSig === sig && live.bufferId && live.bufferId !== live.pitchEdit.sourceBufferId) {
        // Son libéré puis redemandé (annuler) : même nom, même son.
        audioBufferRegistry.register(buf, live.bufferId);
        born.set(live.bufferId, Date.now());
      } else {
        const id = `${RENDER_PREFIX}${snapshot.id}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
        audioBufferRegistry.register(buf, id);
        born.set(id, Date.now());
        const trackId = now!.track.id;
        ops.setSilently(prev => {
          const tracks2 = prev.tracks.map(tr => tr.id !== trackId ? tr : {
            ...tr,
            clips: tr.clips.map(c => {
              if (c.id !== snapshot.id || !c.pitchEdit || infoSig(c.pitchEdit) !== sig) return c;
              const patch = renderedPatch(c, id, sig);
              if (!patch) return c;
              const next: any = { ...c };
              for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
              return next as Clip;
            }),
          });
          return { ...prev, tracks: tracks2 };
        });
      }
      settle(snapshot.id, sig, buf);
      evict(ops.getTracks());
    }).catch(e => {
      failedSig.set(snapshot.id, sig);
      settle(snapshot.id, sig, null);
      ops.notify?.(`❌ Notes de la voix : rendu impossible (${e?.message || e}).`);
    }).finally(() => {
      inflight.delete(snapshot.id);
      emit();
      // Retouches changées pendant le rendu : on enchaîne.
      queueMicrotask(() => syncPitchRenders(ops.getTracks(), ops));
    });
  }
}
