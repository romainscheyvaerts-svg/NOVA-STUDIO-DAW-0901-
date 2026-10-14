/**
 * Lot 2a · Encodage du clip vertical, sans serveur.
 *
 *  1. WebCodecs (Chrome, Edge, WebView2 de l'appli Windows, Chrome Android) : H.264 + AAC
 *     multiplexés en MP4 par mp4-muxer 5.2.1 (MIT, Vanilagy), vendorisé dans vendor/mp4-muxer
 *     (chargé seulement au moment de l'export). Plus rapide que le temps réel : chaque image
 *     est dessinée puis encodée l'une après l'autre, le son est encodé à part, et les deux
 *     pistes partagent la même horloge (image n = n / 30 s ; échantillon k = k / fréquence).
 *  2. Sinon MediaRecorder (MP4 si le navigateur sait, sinon WebM) : enregistrement en temps
 *     réel, comme l'ancienne vidéo de l'extrait.
 */
import { CLIP_FPS, CLIP_H, CLIP_W } from './lyricVideo';
import { makeCanvas } from './lyricVideoDraw';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface ClipEncodeInput {
  audio: AudioBuffer;
  duration: number;
  /** Dessine l'image au temps `clipT` (s depuis le début du clip). */
  drawFrame: (g: Ctx, clipT: number, index: number) => void;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
  /** Contexte audio de l'appli (repli MediaRecorder seulement). */
  getAudioContext?: () => Promise<AudioContext>;
  /** Forcer le repli (tests). */
  force?: 'webcodecs' | 'mediarecorder';
  width?: number;
  height?: number;
  fps?: number;
  /**
   * Lot 2b · Instant exact de chaque image (s depuis le début, croissant ; WebCodecs seulement).
   * La vidéo est alors à fréquence variable, comme celle d'un téléphone : chaque image de la
   * caméra garde SON instant, sans arrondi sur une grille de 30 images/s.
   */
  frameTimes?: number[];
  /** Appelé avant de dessiner l'image i (ex. : décoder l'image filmée). */
  prepareFrame?: (index: number) => Promise<void>;
  /** Débit vidéo (b/s), 8 Mb/s par défaut. */
  bitrate?: number;
}

export interface ClipEncodeResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  mime: string;
  method: 'webcodecs' | 'mediarecorder';
  videoCodec: string;
  audioCodec: string;
  frames: number;
  encodeMs: number;
  /** Temps passé à dessiner les images (ms), le reste est l'encodage. */
  drawMs?: number;
}

const H264_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.640029', 'avc1.420028'];
const AAC = 'mp4a.40.2';
const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 192_000;

export class ClipCancelled extends Error {
  constructor() { super('Création du clip annulée'); this.name = 'ClipCancelled'; }
}

const hasWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined';

/** Codecs utilisables pour le MP4 (H.264 + AAC), ou la raison du repli. */
export async function webCodecsSupport(width = CLIP_W, height = CLIP_H, sampleRate = 48000): Promise<{ ok: boolean; video?: string; audio?: string; reason?: string }> {
  if (!hasWebCodecs()) return { ok: false, reason: 'WebCodecs absent' };
  let video: string | undefined;
  for (const codec of H264_CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: VIDEO_BITRATE, framerate: CLIP_FPS, avc: { format: 'avc' } } as VideoEncoderConfig);
      if (r.supported) { video = codec; break; }
    } catch { /* codec suivant */ }
  }
  if (!video) return { ok: false, reason: 'H.264 indisponible' };
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: AAC, sampleRate: aacRate(sampleRate), numberOfChannels: 2, bitrate: AUDIO_BITRATE });
    if (!r.supported) return { ok: false, video, reason: 'AAC indisponible' };
  } catch { return { ok: false, video, reason: 'AAC indisponible' }; }
  return { ok: true, video, audio: AAC };
}

/** Fréquences acceptées par l'encodeur AAC des navigateurs. */
const aacRate = (sr: number) => (sr === 44100 || sr === 48000 ? sr : 48000);

export function mediaRecorderType(): { mime: string; ext: 'mp4' | 'webm' } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const opts: { mime: string; ext: 'mp4' | 'webm' }[] = [
    { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  return opts.find(o => MediaRecorder.isTypeSupported(o.mime)) || null;
}

/** Le navigateur sait-il fabriquer le clip (MP4 rapide ou repli) ? */
export async function clipVideoSupport(): Promise<{ ok: boolean; method: 'webcodecs' | 'mediarecorder' | null; ext: 'mp4' | 'webm' | null }> {
  const wc = await webCodecsSupport();
  if (wc.ok) return { ok: true, method: 'webcodecs', ext: 'mp4' };
  const mr = mediaRecorderType();
  const canCapture = typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  if (mr && canCapture) return { ok: true, method: 'mediarecorder', ext: mr.ext };
  return { ok: false, method: null, ext: null };
}

async function to(audio: AudioBuffer, sampleRate: number): Promise<AudioBuffer> {
  if (audio.sampleRate === sampleRate && audio.numberOfChannels === 2) return audio;
  const len = Math.max(1, Math.round(audio.duration * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

export async function encodeClip(input: ClipEncodeInput): Promise<ClipEncodeResult> {
  if (input.force !== 'mediarecorder') {
    const wc = await webCodecsSupport(input.width ?? CLIP_W, input.height ?? CLIP_H, input.audio.sampleRate);
    if (wc.ok) return encodeWebCodecs(input, wc.video!);
    if (input.force === 'webcodecs') throw new Error(`WebCodecs indisponible (${wc.reason})`);
  }
  return encodeMediaRecorder(input);
}

async function encodeWebCodecs(input: ClipEncodeInput, videoCodec: string): Promise<ClipEncodeResult> {
  const t0 = performance.now();
  const W = input.width ?? CLIP_W, H = input.height ?? CLIP_H, fps = input.fps ?? CLIP_FPS;
  const sr = aacRate(input.audio.sampleRate);
  const audio = await to(input.audio, sr);
  const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer/mp4-muxer.mjs');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    // Fréquence variable : base de temps fine (1/57 600 s), sinon les instants seraient arrondis à 1/30 s.
    video: input.frameTimes ? { codec: 'avc', width: W, height: H } : { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: sr },
    fastStart: 'in-memory',
    // Même décalage pour les deux pistes : le calage son / image reste exact.
    firstTimestampBehavior: 'cross-track-offset',
  });
  let failure: unknown = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  venc.configure({ codec: videoCodec, width: W, height: H, bitrate: input.bitrate ?? VIDEO_BITRATE, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' } as VideoEncoderConfig);
  const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { failure = e; } });
  aenc.configure({ codec: AAC, sampleRate: sr, numberOfChannels: 2, bitrate: AUDIO_BITRATE });
  const check = () => {
    if (input.signal?.aborted) throw new ClipCancelled();
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  };
  try {
    // Son : tout le clip, exactement `duration` secondes.
    const total = Math.min(audio.length, Math.round(input.duration * sr));
    const L = audio.getChannelData(0), R = audio.getChannelData(1);
    const CH = 4096;
    for (let i = 0; i < total; i += CH) {
      const n = Math.min(CH, total - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0);
      data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / sr) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    check();
    // Images : dessinées et encodées une par une.
    const ft = input.frameTimes;
    const frames = ft ? ft.length : Math.max(1, Math.round(input.duration * fps));
    const canvas = makeCanvas(W, H);
    const g = (canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d')) as Ctx;
    const frameDur = Math.round(1e6 / fps);
    let drawMs = 0;
    let lastKey = -Infinity;
    for (let i = 0; i < frames; i++) {
      if (input.prepareFrame) { await input.prepareFrame(i); check(); }
      const t = ft ? ft[i] : i / fps;
      const d0 = performance.now();
      input.drawFrame(g, t, i);
      drawMs += performance.now() - d0;
      const dur = ft ? Math.max(1, Math.round(((i + 1 < frames ? ft[i + 1] : input.duration) - t) * 1e6)) : frameDur;
      const frame = new VideoFrame(canvas as any, { timestamp: Math.round(t * 1e6), duration: dur });
      const key = ft ? t - lastKey >= 2 : i % (fps * 2) === 0;
      if (key) lastKey = t;
      venc.encode(frame, { keyFrame: key });
      frame.close();
      while (venc.encodeQueueSize > 6) { await new Promise(r => setTimeout(r, 2)); check(); }
      if (i % 6 === 0) { input.onProgress?.(i / frames); await tick(); check(); }
    }
    await venc.flush();
    await aenc.flush();
    check();
    muxer.finalize();
    input.onProgress?.(1);
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return { blob, ext: 'mp4', mime: 'video/mp4', method: 'webcodecs', videoCodec, audioCodec: AAC, frames, encodeMs: Math.round(performance.now() - t0), drawMs: Math.round(drawMs) };
  } finally {
    try { if (venc.state !== 'closed') venc.close(); } catch { /* */ }
    try { if (aenc.state !== 'closed') aenc.close(); } catch { /* */ }
  }
}

async function encodeMediaRecorder(input: ClipEncodeInput): Promise<ClipEncodeResult> {
  const type = mediaRecorderType();
  if (!type || typeof document === 'undefined') throw new Error('Ce navigateur ne sait pas créer de vidéo.');
  if (!input.getAudioContext) throw new Error('Son indisponible pour la vidéo.');
  const t0 = performance.now();
  const W = input.width ?? CLIP_W, H = input.height ?? CLIP_H, fps = input.fps ?? CLIP_FPS;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const ctx = await input.getAudioContext();
  if (ctx.state !== 'running') await ctx.resume().catch(() => { /* */ });
  const src = ctx.createBufferSource();
  src.buffer = input.audio;
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest); // pas vers les haut-parleurs : l'enregistrement est muet pour l'artiste
  const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  input.drawFrame(g, 0, 0);
  rec.start(250);
  const start = ctx.currentTime + 0.05;
  src.start(start);
  let frames = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const loop = () => {
        if (input.signal?.aborted) { reject(new ClipCancelled()); return; }
        const t = ctx.currentTime - start;
        input.drawFrame(g, Math.max(0, Math.min(input.duration, t)), frames++);
        input.onProgress?.(Math.min(1, t / input.duration));
        if (t >= input.duration + 0.15) resolve(); else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  } finally {
    await new Promise<void>(resolve => { rec.onstop = () => resolve(); try { rec.stop(); } catch { resolve(); } });
    try { src.stop(); } catch { /* */ }
    try { src.disconnect(); } catch { /* */ }
  }
  const mime = type.mime.split(';')[0];
  return { blob: new Blob(chunks, { type: mime }), ext: type.ext, mime, method: 'mediarecorder', videoCodec: type.mime, audioCodec: type.mime, frames, encodeMs: Math.round(performance.now() - t0) };
}
