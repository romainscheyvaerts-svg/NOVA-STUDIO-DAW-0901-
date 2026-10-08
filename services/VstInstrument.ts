import { Clip, Track, TrackType, VstInstrument } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { freezeSignature } from '../utils/freeze';
import { instrumentStore } from '../utils/instrumentStore';
import { novaBridge, BridgePlugin, InstrumentNote, InstrumentController } from './NovaBridge';
import { playableNotes, ccNumber, PB, AT } from '../utils/midiCc';

/**
 * Instruments VST3 du PC sur les pistes MIDI (mode instru).
 *
 * Pas de temps réel : les notes de la piste sont rendues par le pont
 * (RENDER_INSTRUMENT) dans un audio rangé comme un rendu gelé (frozenClip,
 * isFrozen, aucun effet inclus). La lecture, la sauvegarde, l'export et la
 * collaboration réutilisent donc le chemin du gel : le son du VST se joue
 * aussi sur un téléphone sans pont. Le rendu est refait quand les notes, le
 * tempo ou le son (fenêtre du plugin) changent.
 */

/** Queue après la dernière note (relâchement, réverbe du synthé). */
export const INSTRUMENT_TAIL_SECONDS = 2;

export const instrumentSlotId = (trackId: string) => `inst:${trackId}`.slice(0, 200);

/** Métadonnées enregistrées sur la piste au choix d'un instrument. */
export const instrumentFromPlugin = (p: BridgePlugin): VstInstrument => ({
  name: p.name, vendor: p.vendor || undefined, path: p.path, pluginName: p.pluginName || null, uid: p.uid || undefined,
});

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}-${h.toString(16)}`;
};

// État d'un plugin : jusqu'à plusieurs Mo (Kontakt). Empreinte gardée en cache.
const stateHashes = new Map<string, string>();
const stateHash = (s: string): string => {
  let h = stateHashes.get(s);
  if (!h) {
    h = fnv(s);
    if (stateHashes.size > 16) stateHashes.clear();
    stateHashes.set(s, h);
  }
  return h;
};

const midiClipsOf = (t: Track): Clip[] => (t.clips || []).filter(c => c.type === TrackType.MIDI && Array.isArray(c.notes));

/** Notes à rendre (temps absolu), limitées à leur clip ; clips muets : silencieux. */
export function instrumentNotes(t: Track): { notes: InstrumentNote[]; clipIds: string[]; end: number } {
  const clips = midiClipsOf(t);
  const notes: InstrumentNote[] = [];
  let end = 0;
  for (const c of clips) {
    if (c.isMuted) continue;
    const clipEnd = c.start + c.duration;
    // Notes muettes exclues, pédale de sustain appliquée (R16).
    for (const n of playableNotes(c)) {
      if (!(n.start >= 0) || n.start >= c.duration || !(n.duration > 0)) continue;
      const start = c.start + n.start;
      const stop = Math.min(clipEnd, start + n.duration);
      if (stop <= start) continue;
      notes.push({ pitch: Math.round(n.pitch), start, duration: stop - start, velocity: Math.max(0, Math.min(1, n.velocity ?? 0.8)) });
      end = Math.max(end, stop);
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes, clipIds: clips.map(c => c.id), end };
}

/**
 * Contrôleurs MIDI (R16) envoyés au VST avec les notes : pitch bend, CC
 * (modulation, sustain, expression…) et aftertouch, en temps absolu.
 */
export function instrumentControllers(t: Track): InstrumentController[] {
  const out: InstrumentController[] = [];
  for (const c of midiClipsOf(t)) {
    if (c.isMuted || !c.cc) continue;
    for (const [key, pts] of Object.entries(c.cc)) {
      for (const p of pts || []) {
        if (!(p.t >= 0) || p.t > c.duration) continue;
        const time = c.start + p.t;
        if (key === PB) { const v = Math.max(0, Math.min(16383, Math.round(p.v) + 8192)); out.push({ time, status: 0xe0, data1: v & 0x7f, data2: v >> 7 }); continue; }
        if (key === AT) { out.push({ time, status: 0xd0, data1: Math.max(0, Math.min(127, Math.round(p.v))), data2: 0 }); continue; }
        const n = ccNumber(key);
        if (n !== null) out.push({ time, status: 0xb0, data1: n, data2: Math.max(0, Math.min(127, Math.round(p.v))) });
      }
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Empreinte de ce qui s'entend : notes, tempo, instrument et son réglé. */
export function instrumentRenderSig(t: Track, bpm: number): string {
  const inst = t.vstInstrument;
  if (!inst) return '';
  const { notes } = instrumentNotes(t);
  const n = notes.map(x => `${x.pitch},${x.start.toFixed(4)},${x.duration.toFixed(4)},${x.velocity.toFixed(3)}`).join(';')
    + instrumentControllers(t).map(x => `|${x.status},${x.data1},${x.data2},${x.time.toFixed(4)}`).join('');
  return fnv([inst.path, inst.pluginName || '', inst.stateB64 ? stateHash(inst.stateB64) : '', Math.round(bpm * 100), n].join('|'));
}

/** Le son actuel de la piste correspond-il à ses notes ? */
export function isInstrumentRenderCurrent(t: Track, bpm: number): boolean {
  const inst = t.vstInstrument;
  if (!inst || inst.renderSig !== instrumentRenderSig(t, bpm)) return false;
  // Aucune note : rien à jouer, pas de rendu.
  if (!t.frozenClip) return instrumentNotes(t).notes.length === 0;
  return !!t.frozenClip.bufferId && audioBufferRegistry.has(t.frozenClip.bufferId);
}

export interface InstrumentRenderResult {
  /** null : aucune note, rien à rendre. */
  clip: Clip | null;
  clipIds: string[];
  sig: string;
  sourceSig: string;
  path: string;
}

/** Range un rendu sur la piste (brouillon Immer). */
export function applyInstrumentRender(t: Track, r: InstrumentRenderResult): void {
  if (!t.vstInstrument) return;
  t.vstInstrument.renderSig = r.sig;
  if (!r.clip) { clearInstrumentRender(t); return; }
  t.isFrozen = true;
  t.frozenClip = r.clip;
  t.frozenUpToPluginIndex = -1;   // effets de la piste joués en direct, après le rendu
  t.frozenClipIds = r.clipIds;
  t.frozenSourceSig = r.sourceSig;
  delete t.frozenPluginSig;
}

/** Retour au synthé Nova (ou rendu raté) : la piste joue ses notes en direct. */
export function clearInstrumentRender(t: Track): void {
  t.isFrozen = false;
  delete t.frozenClip;
  delete t.frozenUpToPluginIndex;
  delete t.frozenClipIds;
  delete t.frozenSourceSig;
  delete t.frozenPluginSig;
}

// --- Instance sur le pont (fenêtre du plugin, son réglé) ----------------------

const slots = new Map<string, { key: string; ready: Promise<void> }>();
const slotCleanups = new Map<string, () => void>();
const watchers = new Map<string, number>();
const stateListeners = new Set<(trackId: string, stateB64: string) => void>();

/** Son changé dans la fenêtre du plugin : la piste enregistre le nouvel état. */
export const onInstrumentState = (cb: (trackId: string, stateB64: string) => void) => {
  stateListeners.add(cb);
  return () => { stateListeners.delete(cb); };
};
const emitState = (trackId: string, stateB64: string) => stateListeners.forEach(cb => { try { cb(trackId, stateB64); } catch { /* */ } });

// Pont fermé : les instances côté pont ne sont plus à nous.
novaBridge.subscribe(s => {
  if (s.status === 'connected') return;
  Array.from(slots.keys()).forEach(id => forgetSlot(id));
});

function forgetSlot(trackId: string) {
  slots.delete(trackId);
  slotCleanups.get(trackId)?.();
  slotCleanups.delete(trackId);
  stopWatch(trackId);
  instrumentStore.patch(trackId, { editorOpen: false, loading: false });
}

/** Charge (une fois) l'instrument de la piste sur le pont. Renvoie l'id du slot. */
export async function ensureInstrumentSlot(t: Track): Promise<string> {
  const inst = t.vstInstrument;
  if (!inst) throw new Error('Pas d’instrument VST sur cette piste');
  if (!novaBridge.isConnected()) throw new Error('Connecte le pont VST pour utiliser tes instruments.');
  await audioEngine.init();
  const sr = audioEngine.ctx!.sampleRate;
  const slotId = instrumentSlotId(t.id);
  const key = `${inst.path}|${inst.pluginName || ''}|${sr}`;
  const cur = slots.get(t.id);
  if (cur && cur.key === key) { await cur.ready; return slotId; }
  if (cur) forgetSlot(t.id);
  const ready = (async () => {
    instrumentStore.patch(t.id, { loading: true });
    try {
      const r = await novaBridge.loadPlugin({ slotId, path: inst.path, pluginName: inst.pluginName, sampleRate: sr, stateB64: inst.stateB64 });
      if (!r.isInstrument) throw new Error(`${r.name || inst.name} n'est pas un instrument`);
      // Premier chargement : l'état d'origine du plugin devient celui de la piste.
      if (!inst.stateB64 && r.stateB64) emitState(t.id, r.stateB64);
      slotCleanups.set(t.id, novaBridge.onSlotEvent(slotId, e => {
        if (e.action !== 'EDITOR_CLOSED') return;
        stopWatch(t.id);
        instrumentStore.patch(t.id, { editorOpen: false });
        if (e.state) emitState(t.id, e.state);
      }));
    } finally {
      instrumentStore.patch(t.id, { loading: false });
    }
  })();
  slots.set(t.id, { key, ready });
  try {
    await ready;
  } catch (e) {
    if (slots.get(t.id)?.ready === ready) slots.delete(t.id);
    throw e;
  }
  return slotId;
}

export function unloadInstrumentSlot(trackId: string) {
  if (!slots.has(trackId)) return;
  forgetSlot(trackId);
  novaBridge.unloadPlugin(instrumentSlotId(trackId));
}

/** Pistes dont l'instrument est chargé sur le pont. */
export const loadedInstrumentTracks = (): string[] => Array.from(slots.keys());

function stopWatch(trackId: string) {
  const w = watchers.get(trackId);
  if (w) window.clearInterval(w);
  watchers.delete(trackId);
}

/**
 * Ouvre la fenêtre du plugin sur le PC. Tant qu'elle est ouverte, le son
 * choisi est relu toutes les 1,5 s (empreinte seulement) : le rendu suit.
 */
export async function openInstrumentEditor(t: Track) {
  const slotId = await ensureInstrumentSlot(t);
  await novaBridge.showEditor(slotId);
  instrumentStore.patch(t.id, { editorOpen: true });
  stopWatch(t.id);
  let last: string | null = null;
  let busy = false;
  novaBridge.getPluginStateHash(slotId).then(h => { last = h; }).catch(() => { /* */ });
  watchers.set(t.id, window.setInterval(async () => {
    if (busy || !novaBridge.isConnected()) return;
    busy = true;
    try {
      const h = await novaBridge.getPluginStateHash(slotId);
      if (h && last !== null && h !== last) {
        const st = await novaBridge.getPluginState(slotId);
        if (st) emitState(t.id, st);
      }
      if (h) last = h;
    } catch { /* fenêtre fermée, pont parti : l'événement EDITOR_CLOSED suit */ }
    finally { busy = false; }
  }, 1500));
}

export async function closeInstrumentEditor(trackId: string) {
  stopWatch(trackId);
  await novaBridge.closeEditor(instrumentSlotId(trackId));
}

// --- Rendu ----------------------------------------------------------------------

/** Rend les notes de la piste avec son instrument VST3 (pont connecté). */
export async function renderInstrumentTrack(t: Track, bpm: number): Promise<InstrumentRenderResult> {
  const inst = t.vstInstrument;
  if (!inst) throw new Error('Pas d’instrument VST sur cette piste');
  const sig = instrumentRenderSig(t, bpm);
  const { notes, clipIds, end } = instrumentNotes(t);
  const sourceSig = freezeSignature(midiClipsOf(t), t.plugins || [], -1);
  if (notes.length === 0) return { clip: null, clipIds, sig, sourceSig, path: inst.path };
  await audioEngine.init();
  const ctx = audioEngine.ctx!;
  const sr = ctx.sampleRate;
  let slotId: string | null = null;
  try { slotId = await ensureInstrumentSlot(t); } catch (e) {
    // Plugin introuvable sur ce PC, etc. : l'erreur vient du rendu ci-dessous.
    if (!novaBridge.isConnected()) throw e;
  }
  const out = await novaBridge.renderInstrument({
    slotId, path: inst.path, pluginName: inst.pluginName, stateB64: inst.stateB64,
    sampleRate: sr, notes, controllers: instrumentControllers(t), lengthSeconds: end, tailSeconds: INSTRUMENT_TAIL_SECONDS,
  });
  const length = out[0]?.length || 0;
  if (!length) throw new Error('Rendu vide');
  const buffer = ctx.createBuffer(2, length, sr);
  for (let c = 0; c < 2; c++) buffer.copyToChannel(out[Math.min(c, out.length - 1)], c);
  const clipId = `vsti-${t.id}-${Date.now().toString(36)}`;
  audioBufferRegistry.register(buffer, clipId);
  const clip: Clip = {
    id: clipId, start: 0, duration: length / sr, offset: 0, fadeIn: 0, fadeOut: 0,
    name: `${t.name} (${inst.name})`, color: t.color, type: TrackType.AUDIO,
    bufferId: clipId, isMuted: false, gain: 1,
  };
  return { clip, clipIds, sig, sourceSig, path: inst.path };
}
