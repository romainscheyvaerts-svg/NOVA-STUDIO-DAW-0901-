import { useSyncExternalStore } from 'react';

/**
 * Vidéo à l'image (écart 24) : importer un clip vidéo pour caler la musique ou poser
 * une voix dessus. La vidéo se cale sur la timeline à une position (`offset`, s) ;
 * l'image suit la tête de lecture, son son peut être importé en piste audio.
 *
 * Réglage de l'appareil, comme les épingles : la vidéo (souvent lourde) est gardée dans
 * le navigateur (IndexedDB), par projet ; le projet lui-même ne change pas de poids.
 *
 * Fonctions pures (calage, vignettes, images d'export) : tests/videoTrack.test.ts.
 */
export interface VideoTrackMeta {
  id: string;
  name: string;
  /** Position du début de la vidéo sur la timeline (s). */
  offset: number;
  duration: number;
  width: number;
  height: number;
  size: number;
  /** Cadence estimée (images/s), 30 par défaut. */
  fps: number;
  /** Piste audio du son de la vidéo (si importé). */
  audioTrackId?: string;
  /** Clip de ce son (calage son / image). */
  audioClipId?: string;
  addedAt: number;
}

export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
export const isVideoFile = (f: { name: string; type?: string }) => VIDEO_EXT.test(f.name) || /^video\//.test(f.type || '');

// --- Calage ----------------------------------------------------------------------------------

/** Instant de la vidéo (s) qui correspond à la tête de lecture ; null hors de la vidéo. */
export function videoTimeAt(playhead: number, meta: Pick<VideoTrackMeta, 'offset' | 'duration'>): number | null {
  const t = playhead - meta.offset;
  if (t < -1e-6 || t > meta.duration + 1e-6) return null;
  return Math.max(0, Math.min(meta.duration, t));
}

export type SyncAction = { kind: 'none' } | { kind: 'seek'; to: number } | { kind: 'play'; from: number } | { kind: 'pause'; at: number } | { kind: 'hide' } | { kind: 'rate'; rate: number };

/**
 * Que faire de l'élément vidéo : en lecture, il joue librement ; un petit écart est
 * rattrapé en douceur (vitesse ±8 %, l'image ne saute pas), au-delà d'une image il est
 * recalé d'un coup ; à l'arrêt, il montre exactement l'image de la tête de lecture.
 */
export function syncAction(o: { playhead: number; playing: boolean; videoTime: number; videoPaused: boolean; rate?: number; meta: Pick<VideoTrackMeta, 'offset' | 'duration' | 'fps'> }): SyncAction {
  const want = videoTimeAt(o.playhead, o.meta);
  if (want === null) return o.videoPaused ? { kind: 'hide' } : { kind: 'pause', at: o.playhead < o.meta.offset ? 0 : o.meta.duration };
  const frame = 1 / Math.max(1, o.meta.fps || 30);
  if (o.playing) {
    if (o.videoPaused) return { kind: 'play', from: want };
    const d = o.videoTime - want;
    if (Math.abs(d) > frame) return { kind: 'seek', to: want };
    // En avance : un peu plus lent ; en retard : un peu plus vite ; à moins de 4 ms : vitesse normale.
    const rate = Math.abs(d) < 0.004 ? 1 : Math.round((1 - Math.max(-0.08, Math.min(0.08, d * 3))) * 1000) / 1000;
    return Math.abs((o.rate ?? 1) - rate) > 1e-3 ? { kind: 'rate', rate } : { kind: 'none' };
  }
  if (!o.videoPaused) return { kind: 'pause', at: want };
  return Math.abs(o.videoTime - want) > frame / 2 ? { kind: 'seek', to: want } : { kind: 'none' };
}

/** Décalage d'une image (−1 / +1), arrondi à l'image. */
export const nudgeOffset = (offset: number, frames: number, fps = 30) => Math.round((offset + frames / fps) * fps * 1000) / (fps * 1000);

/**
 * Vignettes du couloir pour la partie visible [t0, t1] de la timeline : une tous les
 * `thumbW` pixels, à des instants de la vidéo arrondis à `step` s (cache réutilisable).
 */
export function thumbSlots(o: { t0: number; t1: number; pxPerSec: number; thumbW: number; meta: Pick<VideoTrackMeta, 'offset' | 'duration'>; step?: number; max?: number }): { x: number; videoT: number }[] {
  const out: { x: number; videoT: number }[] = [];
  const step = o.step ?? 0.5;
  const dt = o.thumbW / Math.max(1e-6, o.pxPerSec);
  const end = Math.min(o.meta.offset + o.meta.duration, o.t1);
  // Vignettes ancrées au début de la vidéo (elles ne « glissent » pas en défilant).
  for (let k = Math.max(0, Math.floor((o.t0 - o.meta.offset) / dt)); out.length < (o.max ?? 400); k++) {
    const t = o.meta.offset + k * dt;
    if (t >= end) break;
    const v = Math.min(o.meta.duration, Math.max(0, Math.round((t - o.meta.offset) / step) * step));
    out.push({ x: t * o.pxPerSec, videoT: v });
  }
  return out;
}

/** Instants des images d'un export (s depuis le début de la vidéo), cadence fixe. */
export const exportFrameTimes = (duration: number, fps = 30): number[] => Array.from({ length: Math.max(1, Math.round(duration * fps)) }, (_, i) => i / fps);

/** Taille de l'export : la vidéo d'origine, paire (H.264), 1920 px au plus sur le grand côté. */
export function exportSize(w: number, h: number, max = 1920): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w || 1, h || 1));
  const even = (x: number) => Math.max(2, Math.round((x * k) / 2) * 2);
  return { w: even(w || 1280), h: even(h || 720) };
}

// --- Stockage (appareil) -----------------------------------------------------------------
const META_KEY = 'nova_video_track_v1';
type MetaStore = Record<string, VideoTrackMeta>;
let metas: MetaStore = (() => { try { const v = JSON.parse(localStorage.getItem(META_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();
let project = '';
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; try { localStorage.setItem(META_KEY, JSON.stringify(metas)); } catch { /* stockage indisponible */ } listeners.forEach(fn => fn()); };

export function setVideoProject(id: string | null | undefined) {
  const p = id || '';
  if (p === project) return;
  project = p; version++; listeners.forEach(fn => fn());
}
export const currentVideo = (): VideoTrackMeta | null => metas[project] || null;
export const videoStore = { subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, version: () => version };
export const useVideoMeta = (): VideoTrackMeta | null => { useSyncExternalStore(videoStore.subscribe, () => version, () => 0); return currentVideo(); };

export function setVideoMeta(meta: VideoTrackMeta | null) {
  if (meta) metas = { ...metas, [project]: meta };
  else { const { [project]: _d, ...rest } = metas; metas = rest; }
  changed();
}
export function updateVideoMeta(patch: Partial<VideoTrackMeta>) {
  const m = currentVideo();
  if (m) setVideoMeta({ ...m, ...patch });
}

// IndexedDB : le fichier vidéo lui-même.
const DB = 'nova-video-track';
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try { r = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
export async function putVideoFile(id: string, file: Blob): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => { const tx = d.transaction('files', 'readwrite'); tx.objectStore('files').put(file, id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Écriture annulée')); });
}
export async function getVideoFile(id: string): Promise<Blob | null> {
  const d = await db();
  return new Promise((resolve, reject) => { const r = d.transaction('files').objectStore('files').get(id); r.onsuccess = () => resolve((r.result as Blob) || null); r.onerror = () => reject(r.error); });
}
export async function deleteVideoFile(id: string): Promise<void> {
  try { const d = await db(); await new Promise<void>(resolve => { const tx = d.transaction('files', 'readwrite'); tx.objectStore('files').delete(id); tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); }); } catch { /* rien */ }
}

/** Pour les tests. */
export const __resetVideoForTests = () => { metas = {}; project = ''; version = 0; };

// --- Commandes (palette, menus, glisser-déposer) -------------------------------------------
export type VideoCommand = { kind: 'import'; files?: File[] } | { kind: 'export' } | { kind: 'viewer'; show?: boolean } | { kind: 'remove' };
const cmdListeners = new Set<(c: VideoCommand) => void>();
export const videoBus = {
  on(fn: (c: VideoCommand) => void): () => void { cmdListeners.add(fn); return () => { cmdListeners.delete(fn); }; },
  emit(c: VideoCommand) { cmdListeners.forEach(fn => fn(c)); },
};
export const openVideoImport = (files?: File[]) => videoBus.emit({ kind: 'import', files });
export const openVideoExport = () => videoBus.emit({ kind: 'export' });
export const toggleVideoViewer = (show?: boolean) => videoBus.emit({ kind: 'viewer', show });
