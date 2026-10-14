/**
 * Lot 2b · Export de la performance : l'image filmée pendant la prise + le MIX du morceau
 * (rendu comme l'export : utils/demoExport · renderClipMix), calés sur le temps du projet,
 * avec les paroles du lot 2a en option. MP4 H.264 + AAC (WebCodecs + mp4-muxer), dans le
 * navigateur ou l'appli Windows, sans serveur.
 *
 * Chaque image filmée garde son instant exact (vidéo à fréquence variable, utils/videoTake ·
 * planExportFrames) : rien n'est arrondi sur une grille, l'écart image ↔ son reste celui de la
 * capture.
 */
import type { DAWState } from '../types';
import { renderClipMix } from './demoExport';
import { ClipCancelled, encodeClip, type ClipEncodeResult } from './clipVideoEncode';
import { drawLyricsOverlay, type ClipLook } from './lyricVideoDraw';
import type { ClipLine } from './lyricVideo';
import { planExportFrames, type ExportFrame } from './videoTake';
import { readChunks, type VideoTakeMeta } from './videoTakeStore';

export interface PerformanceExportInput {
  meta: VideoTakeMeta;
  state: DAWState;
  range: { start: number; duration: number };
  pass?: number;
  lyrics?: { look: ClipLook; lines: ClipLine[] } | null;
  onProgress?: (p: number, phase: 'mix' | 'video') => void;
  signal?: AbortSignal;
}

export interface PerformanceExportResult extends ClipEncodeResult {
  plan: ExportFrame[];
  filmedFrames: number;
}

/** Débit de l'export (720 × 1280) : bonne qualité pour Instagram, TikTok, YouTube. */
const EXPORT_BITRATE = 5_000_000;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Bande sombre derrière les paroles : lisibles sur n'importe quelle image. */
function lyricsBand(g: Ctx, W: number, H: number, vertical: boolean) {
  const y0 = vertical ? H * 0.6 : H * 0.55;
  const grad = g.createLinearGradient(0, y0, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = grad;
  g.fillRect(0, y0, W, H - y0);
}

export async function exportPerformance(input: PerformanceExportInput): Promise<PerformanceExportResult> {
  const { meta, range, signal } = input;
  if (!meta.times || !meta.chunkTs.length) throw new Error('vidéo vide');
  if (typeof VideoDecoder === 'undefined') throw new Error('décodeur vidéo absent');
  const W = meta.width, H = meta.height;
  const plan = planExportFrames(meta.times, meta.keyframes, range, { passes: meta.passes, pass: input.pass });

  // 1. Le mix (comme l'export).
  const audio = await renderClipMix(input.state, range.start, range.duration, p => input.onProgress?.(p * 0.3, 'mix'));
  if (signal?.aborted) throw new ClipCancelled();

  // 2. Décodage des images filmées, au fil de l'encodage (mémoire bornée).
  const needed = new Set(plan.frames.filter(f => f.src >= 0).map(f => f.src));
  const tsToIndex = new Map<number, number>();
  meta.chunkTs.forEach((ts, i) => tsToIndex.set(ts, i));
  const ready = new Map<number, VideoFrame>();
  let decodeError: unknown = null;
  const decoder = new VideoDecoder({
    output: f => {
      const i = tsToIndex.get(f.timestamp);
      if (i === undefined || !needed.has(i)) { f.close(); return; }
      ready.set(i, f);
    },
    error: e => { decodeError = e; },
  });
  decoder.configure({ codec: meta.codec, codedWidth: W, codedHeight: H, ...(meta.description ? { description: meta.description } : {}) });
  const it = readChunks(meta.id);
  let fed = -1, exhausted = false;
  const feedOne = async (): Promise<boolean> => {
    if (exhausted) return false;
    const n = await it.next();
    if (n.done) { exhausted = true; try { await decoder.flush(); } catch { /* */ } return false; }
    const c = n.value;
    fed = c.index;
    if (plan.decodeFrom < 0 || c.index < plan.decodeFrom) return true;
    if (c.index > plan.decodeTo) { exhausted = true; try { await decoder.flush(); } catch { /* */ } return false; }
    decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.data }));
    return true;
  };

  let current: VideoFrame | null = null;
  const prepareFrame = async (i: number) => {
    const src = plan.frames[i].src;
    if (src < 0) return;
    if (current && (current as any).__src === src) return;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    let guard = 0;
    while (!ready.has(src)) {
      if (decodeError) throw decodeError instanceof Error ? decodeError : new Error(String(decodeError));
      if (signal?.aborted) throw new ClipCancelled();
      if (decoder.decodeQueueSize > 6) { await sleep(1); continue; }
      // Quelques paquets d'avance : certains décodeurs ne rendent une image qu'à l'arrivée de la suivante.
      if (!exhausted && fed < src + 2) { await feedOne(); continue; }
      if (decoder.decodeQueueSize > 0) { await sleep(1); continue; }
      if (exhausted) {
        // Tout est décodé et l'image manque (paquet illisible) : on garde l'image d'avant.
        if (++guard > 20) return;
        await sleep(2); continue;
      }
      await feedOne();
    }
    try { current?.close(); } catch { /* */ }
    current = ready.get(src)!;
    (current as any).__src = src;
    ready.delete(src);
    // Les images plus anciennes ne serviront plus.
    for (const [k, f] of ready) if (k < src) { try { f.close(); } catch { /* */ } ready.delete(k); }
  };

  const lyr = input.lyrics && input.lyrics.lines.length ? input.lyrics : null;
  const drawFrame = (g: Ctx, t: number) => drawPerformanceFrame(g as CanvasRenderingContext2D, W, H, current as any, lyr, range.start + t, range);

  try {
    const res = await encodeClip({
      audio, duration: range.duration, signal, force: 'webcodecs', width: W, height: H, bitrate: EXPORT_BITRATE,
      frameTimes: plan.frames.map(f => f.t), prepareFrame, drawFrame,
      onProgress: p => input.onProgress?.(0.3 + 0.7 * p, 'video'),
    });
    return { ...res, plan: plan.frames, filmedFrames: needed.size };
  } finally {
    try { current?.close(); } catch { /* */ }
    ready.forEach(f => { try { f.close(); } catch { /* */ } });
    try { if (decoder.state !== 'closed') decoder.close(); } catch { /* */ }
    try { await it.return(undefined); } catch { /* */ }
  }
}

/** Nom du fichier : « Titre - performance.mp4 ». */
export function performanceFileName(title: string, ext: string): string {
  const base = (title || 'ma performance').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'ma performance';
  return `${base} - performance.${ext}`;
}

/**
 * Image filmée à l'instant `t` du morceau (aperçu de la fenêtre d'export) : décodée depuis
 * l'image clé précédente. null si rien n'est filmé à cet instant.
 */
export async function frameAt(meta: VideoTakeMeta, t: number, pass?: number): Promise<ImageBitmap | null> {
  if (!meta.times || typeof VideoDecoder === 'undefined') return null;
  let idx = -1;
  for (let i = 0; i < meta.times.length; i++) {
    if (pass !== undefined && meta.passes && meta.passes[i] !== pass) continue;
    if (meta.times[i] <= t && (idx < 0 || meta.times[i] >= meta.times[idx])) idx = i;
  }
  if (idx < 0) return null;
  let from = 0;
  for (const k of meta.keyframes) if (k <= idx && k > from) from = k;
  let last: VideoFrame | null = null;
  let err: unknown = null;
  const dec = new VideoDecoder({ output: f => { try { last?.close(); } catch { /* */ } last = f; }, error: e => { err = e; } });
  dec.configure({ codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height, ...(meta.description ? { description: meta.description } : {}) });
  try {
    for await (const c of readChunks(meta.id)) {
      if (c.index < from) continue;
      if (c.index > idx) break;
      dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.data }));
    }
    await dec.flush();
    if (err || !last) return null;
    const bmp = await createImageBitmap(last as any);
    return bmp;
  } catch { return null; } finally {
    try { (last as VideoFrame | null)?.close(); } catch { /* */ }
    try { if (dec.state !== 'closed') dec.close(); } catch { /* */ }
  }
}

/** Dessine une image de la performance (aperçu = export) : image filmée, bande et paroles. */
export function drawPerformanceFrame(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, W: number, H: number, img: CanvasImageSource | null, lyr: { look: ClipLook; lines: ClipLine[] } | null, t: number, clip: { start: number; duration: number }) {
  const vertical = H > W;
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (img) g.drawImage(img, 0, 0, W, H); else { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
  if (lyr && lyr.lines.length) {
    lyricsBand(g, W, H, vertical);
    const f = { t, clipT: t - clip.start, duration: clip.duration, lines: lyr.lines, spectrum: null, backdrop: null, cover: null };
    if (vertical) { const s = W / 1080; g.setTransform(s, 0, 0, s, 0, 0); drawLyricsOverlay(g, lyr.look, f, 1480); }
    else { const s = W / 1920; g.setTransform(s, 0, 0, s, 420 * s, 0); drawLyricsOverlay(g, lyr.look, f, 860); }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
