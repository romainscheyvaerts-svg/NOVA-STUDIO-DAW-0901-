/**
 * Vidéo à l'image (écart 24) : exporter le clip vidéo avec le MIX du morceau (MP4 H.264
 * + AAC, sans serveur, utils/clipVideoEncode). Le mix est rendu sur la plage de la vidéo
 * (de `offset` à `offset + durée`) ; chaque image de l'export est l'image exacte de la
 * vidéo à son instant (élément vidéo recalé image par image) : image et son partagent la
 * même horloge, à l'échantillon et à l'image près.
 */
import type { DAWState } from '../types';
import { encodeClip, type ClipEncodeResult } from './clipVideoEncode';
import { renderClipMix } from './demoExport';
import { exportFrameTimes, exportSize, type VideoTrackMeta } from './videoTrack';

export const VIDEO_EXPORT_FPS = 30;

/** Recale l'élément vidéo sur l'instant t (s) et attend l'image. */
export async function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  const target = Math.max(0, Math.min(t, (v.duration || t) - 1e-3));
  if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', finish); clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, 2000);
    v.addEventListener('seeked', finish);
    v.currentTime = target;
  });
}

export async function loadVideoElement(file: Blob): Promise<{ v: HTMLVideoElement; url: string }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise<void>((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const ko = () => { cleanup(); reject(new Error('Vidéo illisible par ce navigateur (essaie un MP4 H.264).')); };
    const cleanup = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', ko); };
    v.addEventListener('loadeddata', ok);
    v.addEventListener('error', ko);
  });
  return { v, url };
}

export interface VideoExportResult extends ClipEncodeResult { fileName: string; width: number; height: number }

export async function exportVideoWithMix(o: { state: DAWState; meta: VideoTrackMeta; file: Blob; onProgress?: (p: number, text: string) => void; signal?: AbortSignal }): Promise<VideoExportResult> {
  const { meta } = o;
  // Vidéo posée avant 0:00 : le mix commence à 0, l'image saute le début.
  const lead = Math.max(0, -meta.offset);
  o.onProgress?.(0, 'Mix du morceau…');
  const mix = await renderClipMix(o.state, Math.max(0, meta.offset), meta.duration - lead, p => o.onProgress?.(p * 0.3, 'Mix du morceau…'));
  const { v, url } = await loadVideoElement(o.file);
  try {
    const size = exportSize(v.videoWidth || meta.width, v.videoHeight || meta.height);
    const times = exportFrameTimes(meta.duration - lead, VIDEO_EXPORT_FPS);
    const r = await encodeClip({
      audio: mix, duration: meta.duration - lead, width: size.w, height: size.h, fps: VIDEO_EXPORT_FPS, signal: o.signal,
      prepareFrame: async i => { await seekVideo(v, lead + (times[i] ?? i / VIDEO_EXPORT_FPS)); },
      drawFrame: (g) => { g.fillStyle = '#000'; g.fillRect(0, 0, size.w, size.h); g.drawImage(v, 0, 0, size.w, size.h); },
      onProgress: p => o.onProgress?.(0.3 + p * 0.7, 'Images de la vidéo…'),
    });
    const base = (meta.name || 'video').replace(/\.[a-z0-9]+$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim().slice(0, 50) || 'video';
    return { ...r, fileName: `${base} (mix NOVA).${r.ext}`, width: size.w, height: size.h };
  } finally {
    v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
  }
}
