/**
 * Lot 2b · La caméra pendant la prise : ouverture de la caméra (image seulement, jamais le
 * son), aperçu, et enregistrement de la vidéo pendant chaque prise audio de NOVA.
 *
 * Le moteur annonce la prise (AudioEngine : nova:take-start, nova:take-stop, nova:take-done) ;
 * la vidéo démarre et s'arrête aux mêmes instants. Chaque image garde son instant de capture,
 * puis est replacée sur le temps du morceau comme la prise audio (utils/videoTake).
 *
 * Capture :
 *  - MediaStreamTrackProcessor (Chrome, Edge, appli Windows, Chrome Android) : toutes les
 *    images, avec l'horodatage de capture de la caméra, même onglet en arrière-plan ;
 *  - sinon requestVideoFrameCallback sur l'aperçu (captureTime quand le navigateur le donne).
 * Encodage : WebCodecs H.264 (720 × 1280 ou 1280 × 720), gardé dans IndexedDB par paquets.
 */
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from './audioBufferRegistry';
import {
  BYTES_PER_SEC, CAPTURE_BITRATE, CAPTURE_FPS, STORAGE_STOP_BYTES, audioOnsets, cameraKey, captureOffset, coverCrop, fitClock, formatSize,
  frameTimelines, measureSync, storageAdvice, visualEvents, addOrigin,
  type ClockPair, type OriginSegment, type StorageAdvice, type SyncMeasure, type TakeSync, type VideoFormat,
} from './videoTake';
import { askPersistence, deleteTake, isQuotaError, putChunks, putMeta, getMeta, storageEstimate, type StoredChunk, type VideoTakeMeta } from './videoTakeStore';

export type CamStatus = 'off' | 'asking' | 'on' | 'denied' | 'notfound' | 'busy' | 'error' | 'unsupported';

export interface CamDevice { deviceId: string; label: string }

export interface CamState {
  status: CamStatus;
  error: string | null;
  devices: CamDevice[];
  deviceId: string | null;
  label: string;
  facing: 'user' | 'environment';
  format: VideoFormat;
  /** Résolution réelle de la caméra. */
  size: { width: number; height: number } | null;
  /** Filmer les prises (la caméra peut rester allumée sans filmer). */
  armed: boolean;
  recording: boolean;
  recSince: number | null;
  frames: number;
  bytes: number;
  dropped: number;
  codec: string | null;
  storage: StorageAdvice;
  offsetMs: number;
  /** Dernière vidéo gardée (ou arrêtée) : pour le message du panneau. */
  last: { id: string; status: VideoTakeMeta['status']; durationSec: number; bytes: number; reason?: string } | null;
  /** Message ponctuel (vidéo arrêtée faute de place, etc.). */
  notice: string | null;
}

const OFFSETS_KEY = 'nova_video_sync_offsets';
const PREFS_KEY = 'nova_video_prefs';

const readOffsets = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(OFFSETS_KEY) || '{}') || {}; } catch { return {}; } };
const readPrefs = (): { format?: VideoFormat; deviceId?: string; facing?: 'user' | 'environment' } => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } };

const H264 = ['avc1.42001f', 'avc1.4d001f', 'avc1.640028', 'avc1.42e01f', 'avc1.4d0028'];
const FALLBACK = ['vp8', 'vp09.00.10.08'];

/** Le navigateur sait-il filmer une prise (caméra + encodeur vidéo) ? */
export async function captureSupport(format: VideoFormat): Promise<{ ok: boolean; codec?: string; reason?: string }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'caméra inaccessible dans ce navigateur' };
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { ok: false, reason: 'encodeur vidéo absent (WebCodecs)' };
  const { width, height } = formatSize(format);
  for (const codec of [...H264, ...FALLBACK]) {
    try {
      const cfg: VideoEncoderConfig = { codec, width, height, bitrate: CAPTURE_BITRATE, framerate: CAPTURE_FPS, latencyMode: 'realtime', ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) } as VideoEncoderConfig;
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return { ok: true, codec };
    } catch { /* suivant */ }
  }
  return { ok: false, reason: 'aucun encodeur vidéo disponible' };
}

interface RecSession {
  meta: VideoTakeMeta;
  encoder: VideoEncoder;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  small: HTMLCanvasElement | OffscreenCanvas;
  sg: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  prevGrid: Float32Array | null;
  raw0: number | null;
  lastKey: number;
  startPerf: number;
  stopPerf: number | null;
  pending: { ts: number; key: boolean; data: Uint8Array }[];
  pendingBytes: number;
  writing: Promise<void>;
  sig: Map<number, [number, number]>;
  clockTimer: ReturnType<typeof setInterval> | null;
  storageTimer: ReturnType<typeof setInterval> | null;
  outputSides: number[];
  failed: string | null;
  done: Promise<{ origin: number | null; takes: { trackId: string; clipId: string; start: number; duration: number }[] } | null>;
  resolveDone: (d: { origin: number | null; takes: { trackId: string; clipId: string; start: number; duration: number }[] } | null) => void;
  finished: boolean;
}

const debugOn = (): boolean => { try { return localStorage.getItem('nova_qa_video_debug') === '1'; } catch { return false; } };

function makeCanvas(w: number, h: number, read = false): { c: HTMLCanvasElement | OffscreenCanvas; g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    return { c, g: c.getContext('2d', { alpha: false, ...(read ? { willReadFrequently: true } : {}) }) as OffscreenCanvasRenderingContext2D };
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return { c, g: c.getContext('2d', { alpha: false, ...(read ? { willReadFrequently: true } : {}) }) as CanvasRenderingContext2D };
}

const newId = () => `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

class VideoTakeController {
  private s: CamState;
  private listeners = new Set<() => void>();
  stream: MediaStream | null = null;
  private procTrack: MediaStreamTrack | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private preview: HTMLVideoElement | null = null;
  private rvfcId = 0;
  private reads: { tsUs: number; readMs: number }[] = [];
  private exact: { tsUs: number; captureMs: number }[] = [];
  private method: 'mstp' | 'rvfc' = 'mstp';
  private rec: RecSession | null = null;
  private project: { id: string | null; name: string } = { id: null, name: '' };
  private codec: string | null = null;
  private wired = false;
  /** QA : luminosité de chaque image vue (instant de capture en ms), y compris hors prise. */
  debugFrames: { p: number; L: number }[] = [];

  constructor() {
    const prefs = readPrefs();
    this.s = {
      status: 'off', error: null, devices: [], deviceId: prefs.deviceId || null, label: '', facing: prefs.facing || 'user',
      format: prefs.format || '9:16', size: null, armed: true, recording: false, recSince: null, frames: 0, bytes: 0, dropped: 0,
      codec: null, storage: { level: 'unknown', freeBytes: null, minutes: null }, offsetMs: 0, last: null, notice: null,
    };
  }

  // ── Abonnement (React : useSyncExternalStore) ──
  get state(): CamState { return this.s; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.s;
  private set(p: Partial<CamState>) { this.s = { ...this.s, ...p }; this.listeners.forEach(f => { try { f(); } catch { /* */ } }); }
  private savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ format: this.s.format, deviceId: this.s.deviceId, facing: this.s.facing })); } catch { /* */ } }

  setProject(id: string | null, name: string) { this.project = { id, name }; }
  setArmed(armed: boolean) { this.set({ armed }); }
  clearNotice() { this.set({ notice: null }); }

  setFormat(format: VideoFormat) {
    if (this.s.recording) return;
    this.set({ format }); this.savePrefs();
    void captureSupport(format).then(r => { this.codec = r.ok ? r.codec! : null; this.set({ codec: this.codec }); });
  }

  /** Décalage mesuré (ou réglé) de la caméra en cours, en ms. */
  private currentOffset(): number { return readOffsets()[cameraKey(this.s.label, this.s.deviceId || undefined)] || 0; }
  setCameraOffset(ms: number) {
    const k = cameraKey(this.s.label, this.s.deviceId || undefined);
    const all = readOffsets(); all[k] = Math.round(ms * 10) / 10;
    try { localStorage.setItem(OFFSETS_KEY, JSON.stringify(all)); } catch { /* */ }
    this.set({ offsetMs: all[k] });
  }

  async refreshStorage(): Promise<StorageAdvice> {
    const adv = storageAdvice(await storageEstimate());
    this.set({ storage: adv });
    return adv;
  }

  async listCameras(): Promise<CamDevice[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter(d => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Caméra ${i + 1}` }));
      this.set({ devices: cams });
      return cams;
    } catch { return []; }
  }

  /** Allume la caméra (image seulement : le micro et la carte son ne changent pas). */
  async open(opts: { deviceId?: string | null; facing?: 'user' | 'environment' } = {}): Promise<boolean> {
    this.wire();
    const sup = await captureSupport(this.s.format);
    if (!sup.ok) { this.set({ status: 'unsupported', error: sup.reason || null }); return false; }
    this.codec = sup.codec!;
    this.closeTracks();
    const deviceId = opts.deviceId !== undefined ? opts.deviceId : this.s.deviceId;
    const facing = opts.facing || this.s.facing;
    this.set({ status: 'asking', error: null, facing, codec: this.codec });
    const base: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: CAPTURE_FPS, max: 60 } };
    const tries: MediaStreamConstraints[] = [
      { audio: false, video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: facing } } },
      { audio: false, video: { facingMode: { ideal: facing } } },
      { audio: false, video: true },
    ];
    let stream: MediaStream | null = null;
    let lastErr: any = null;
    for (const c of tries) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e: any) {
        lastErr = e;
        if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') break;
      }
    }
    if (!stream) {
      const n = lastErr?.name || '';
      if (n === 'NotAllowedError' || n === 'SecurityError') this.set({ status: 'denied', error: null });
      else if (n === 'NotFoundError' || n === 'OverconstrainedError') this.set({ status: 'notfound', error: null });
      else if (n === 'NotReadableError' || n === 'AbortError') this.set({ status: 'busy', error: null });
      else this.set({ status: 'error', error: lastErr?.message || String(lastErr || 'inconnue') });
      return false;
    }
    // La caméra ne doit JAMAIS apporter de son (le flux est demandé sans audio ; par sécurité).
    stream.getAudioTracks().forEach(t => { t.stop(); stream!.removeTrack(t); });
    const track = stream.getVideoTracks()[0];
    const st = track.getSettings();
    this.stream = stream;
    track.addEventListener('ended', () => { if (this.stream === stream) { this.stopVideoNow('La caméra s\'est déconnectée'); this.closeTracks(); this.set({ status: 'off', notice: '🎥 La caméra s\'est déconnectée. Rallume-la pour filmer la prochaine prise.' }); } });
    const cams = await this.listCameras();
    const label = track.label || cams.find(c => c.deviceId === st.deviceId)?.label || 'Caméra';
    this.set({
      status: 'on', deviceId: st.deviceId || deviceId || null, label, size: st.width && st.height ? { width: st.width, height: st.height } : null,
      facing: (st.facingMode as any) === 'environment' ? 'environment' : (st.facingMode as any) === 'user' ? 'user' : facing,
    });
    this.set({ offsetMs: this.currentOffset() });
    this.savePrefs();
    this.startReading(track);
    void this.refreshStorage();
    void askPersistence();
    return true;
  }

  /** Coupe la caméra (le voyant s'éteint). Pendant une prise, seule la vidéo s'arrête. */
  close() {
    if (this.rec) this.stopVideoNow('Caméra coupée pendant la prise');
    this.closeTracks();
    this.set({ status: 'off', size: null });
  }

  private closeTracks() {
    try { this.reader?.cancel(); } catch { /* */ }
    this.reader = null;
    try { this.procTrack?.stop(); } catch { /* */ }
    this.procTrack = null;
    this.stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* */ } });
    this.stream = null;
    this.reads = []; this.exact = [];
    if (this.preview && this.rvfcId && (this.preview as any).cancelVideoFrameCallback) { try { (this.preview as any).cancelVideoFrameCallback(this.rvfcId); } catch { /* */ } }
    this.rvfcId = 0;
  }

  async switchFacing(): Promise<boolean> {
    if (this.s.recording) return false;
    const facing = this.s.facing === 'user' ? 'environment' : 'user';
    return this.open({ deviceId: null, facing });
  }

  async selectDevice(deviceId: string): Promise<boolean> {
    if (this.s.recording) return false;
    return this.open({ deviceId });
  }

  /** L'aperçu du panneau : sert à la capture de repli et à affiner l'horodatage. */
  attachPreview(el: HTMLVideoElement | null) {
    if (el === this.preview && (!el || this.rvfcId)) return; // déjà suivi : pas de 2e boucle (images en double)
    if (this.preview && this.rvfcId && (this.preview as any).cancelVideoFrameCallback) { try { (this.preview as any).cancelVideoFrameCallback(this.rvfcId); } catch { /* */ } }
    this.rvfcId = 0;
    this.preview = el;
    if (el) this.watchPreview();
  }

  private watchPreview() {
    const el = this.preview as any;
    if (!el || typeof el.requestVideoFrameCallback !== 'function') return;
    const cb = (_now: number, md: any) => {
      if (this.preview !== el) return;
      const cap = typeof md?.captureTime === 'number' && md.captureTime > 0 ? md.captureTime : null;
      if (this.method === 'mstp') {
        // Même image vue des deux côtés : décalage exact entre l'horloge de capture et performance.now().
        if (cap !== null && this.reads.length) {
          const est = captureOffset(this.reads.slice(-60));
          if (est !== null) {
            let best: { tsUs: number; readMs: number } | null = null;
            for (const r of this.reads.slice(-30)) if (!best || Math.abs(r.tsUs / 1000 - est - cap) < Math.abs(best.tsUs / 1000 - est - cap)) best = r;
            if (best && Math.abs(best.tsUs / 1000 - est - cap) < 6) { this.exact.push({ tsUs: best.tsUs, captureMs: cap }); if (this.exact.length > 120) this.exact.shift(); }
          }
        }
      } else {
        // Repli : l'image affichée est copiée et encodée (captureTime, sinon l'instant d'affichage moins une image).
        const pCap = cap ?? (typeof md?.presentationTime === 'number' ? md.presentationTime : performance.now() - 1000 / CAPTURE_FPS);
        try {
          const vf = new VideoFrame(el as HTMLVideoElement, { timestamp: Math.round(pCap * 1000) });
          this.onFrame(vf, pCap * 1000, performance.now(), 0);
        } catch { /* image pas prête */ }
      }
      this.rvfcId = el.requestVideoFrameCallback(cb);
    };
    this.rvfcId = el.requestVideoFrameCallback(cb);
  }

  private startReading(track: MediaStreamTrack) {
    const MSTP = (globalThis as any).MediaStreamTrackProcessor;
    if (typeof MSTP !== 'function') { this.method = 'rvfc'; return; }
    this.method = 'mstp';
    const t2 = track.clone();
    this.procTrack = t2;
    let reader: ReadableStreamDefaultReader<VideoFrame>;
    try { reader = new MSTP({ track: t2 }).readable.getReader(); } catch { this.method = 'rvfc'; return; }
    this.reader = reader;
    const loop = async () => {
      for (;;) {
        let r: ReadableStreamReadResult<VideoFrame>;
        try { r = await reader.read(); } catch { return; }
        if (r.done || this.reader !== reader) { try { r.value?.close(); } catch { /* */ } return; }
        const f = r.value;
        const readMs = performance.now();
        this.reads.push({ tsUs: f.timestamp, readMs });
        if (this.reads.length > 600) this.reads.splice(0, 300);
        this.onFrame(f, f.timestamp, readMs, null);
      }
    };
    void loop();
  }

  /** Décalage horloge de capture → performance.now() (ms) ; `fixed` pour le repli (déjà en ms). */
  private offsetNow(fixed: number | null): number {
    if (fixed !== null) return fixed;
    return captureOffset(this.reads, this.exact.length >= 3 ? this.exact : []) ?? 0;
  }

  private onFrame(f: VideoFrame, rawUs: number, readMs: number, fixedOffset: number | null) {
    const rec = this.rec;
    const dbg = debugOn();
    try {
      if (!rec && !dbg) return;
      const off = this.offsetNow(fixedOffset);
      const pCap = rawUs / 1000 - off;
      // Petit relevé 16 × 9 : luminosité et mouvement (mesure du clap, QA).
      let luma = 0, motion = 0;
      const need = !!rec || dbg;
      let grid: Float32Array | null = null;
      if (need) {
        const sg = rec ? rec.sg : (this.dbgSmall ||= makeCanvas(16, 9, true)).g;
        sg.drawImage(f as any, 0, 0, 16, 9);
        const d = sg.getImageData(0, 0, 16, 9).data;
        grid = new Float32Array(144);
        for (let i = 0, k = 0; i < d.length; i += 4, k++) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; grid[k] = y; luma += y; }
        luma /= 144;
        if (dbg) { this.debugFrames.push({ p: pCap, L: Math.round(luma) }); if (this.debugFrames.length > 3000) this.debugFrames.splice(0, 1000); }
      }
      if (!rec || rec.finished) return;
      if (pCap < rec.startPerf - 5) return;
      if (rec.stopPerf !== null && pCap > rec.stopPerf) { void this.finish(rec); return; }
      if (rec.prevGrid && grid) { let m = 0; for (let k = 0; k < 144; k++) m += Math.abs(grid[k] - rec.prevGrid[k]); motion = m / 144; }
      rec.prevGrid = grid;
      if (rec.encoder.state !== 'configured') return;
      if (rec.encoder.encodeQueueSize > 8) { rec.meta.dropped++; return; }
      if (rec.raw0 === null) { rec.raw0 = rawUs; rec.meta.firstCaptureMs = pCap; }
      const ts = Math.max(0, Math.round(rawUs - rec.raw0));
      const W = rec.meta.width, H = rec.meta.height;
      const cr = coverCrop(f.displayWidth || f.codedWidth, f.displayHeight || f.codedHeight, W, H);
      rec.g.drawImage(f as any, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, W, H);
      const key = rec.lastKey < 0 || ts - rec.lastKey >= 2_000_000;
      if (key) rec.lastKey = ts;
      rec.sig.set(ts, [Math.round(luma * 10) / 10, Math.round(motion * 10) / 10]);
      const vf = new VideoFrame(rec.canvas as any, { timestamp: ts, duration: Math.round(1e6 / CAPTURE_FPS) });
      try { rec.encoder.encode(vf, { keyFrame: key }); } finally { vf.close(); }
      void readMs;
    } catch (e) {
      console.warn('[Vidéo de la prise] image ignorée', e);
    } finally {
      try { f.close(); } catch { /* */ }
    }
  }
  private dbgSmall: { c: HTMLCanvasElement | OffscreenCanvas; g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null = null;

  // ── Prises ──

  private wire() {
    if (this.wired || typeof window === 'undefined') return;
    this.wired = true;
    window.addEventListener('nova:take-start', e => { void this.onTakeStart((e as CustomEvent).detail || {}); });
    window.addEventListener('nova:take-stop', e => { this.onTakeStop((e as CustomEvent).detail || {}); });
    window.addEventListener('nova:take-done', e => { this.rec?.resolveDone((e as CustomEvent).detail || null); });
  }

  private async onTakeStart(d: { perf?: number; trackIds?: string[] }) {
    if (this.rec || this.s.status !== 'on' || !this.s.armed || !this.codec) return;
    // Place connue (relevée à l'allumage et après chaque prise) : pas d'attente ici, sinon les
    // premières images de la prise seraient perdues. Relevé à jour en arrière-plan.
    const adv = this.s.storage;
    void this.refreshStorage();
    if (adv.level === 'full') {
      this.set({ notice: `🎥 Pas assez de place pour filmer (${adv.freeBytes !== null ? Math.round(adv.freeBytes / 1048576) : '?'} Mo libres) : la prise audio est enregistrée, sans vidéo. Supprime d'anciennes vidéos dans le panneau Caméra.` });
      return;
    }
    const { width, height } = formatSize(this.s.format);
    const { c, g } = makeCanvas(width, height);
    const small = makeCanvas(16, 9, true);
    let resolveDone!: RecSession['resolveDone'];
    const donePromise = new Promise<Parameters<RecSession['resolveDone']>[0]>(r => { resolveDone = r; });
    const ctx = audioEngine.ctx;
    const outTs = ctx && typeof (ctx as any).getOutputTimestamp === 'function' ? (ctx as any).getOutputTimestamp() : null;
    const clockSource: 'sortie' | 'contexte' = outTs && outTs.performanceTime > 0 ? 'sortie' : 'contexte';
    const info = audioEngine.videoSyncInfo();
    const meta: VideoTakeMeta = {
      id: newId(), projectId: this.project.id, projectName: this.project.name, createdAt: Date.now(), status: 'recording',
      format: this.s.format, width, height, codec: this.codec, cameraLabel: this.s.label, cameraKey: cameraKey(this.s.label, this.s.deviceId || undefined),
      facing: this.s.facing, method: this.method, frames: 0, bytes: 0, seqs: 0, dropped: 0, chunkTs: [], keyframes: [], firstCaptureMs: 0,
      luma: [], motion: [], clock: [], clockSource, renderLead: clockSource === 'sortie' ? (info?.renderLead || 0) : 0, outputSide: info?.outputSide || 0,
      segments: [], offsetMs: this.currentOffset(), loop: info?.loop || null, trackIds: d.trackIds || [], bufferIds: [], durationSec: 0,
    };
    let encoder: VideoEncoder;
    const rec: RecSession = {
      meta, encoder: null as any, canvas: c, g, small: small.c, sg: small.g, prevGrid: null, raw0: null, lastKey: -1,
      startPerf: d.perf ?? performance.now(), stopPerf: null, pending: [], pendingBytes: 0, writing: Promise.resolve(), sig: new Map(),
      clockTimer: null, storageTimer: null, outputSides: [], failed: null, done: donePromise, resolveDone, finished: false,
    };
    try {
      encoder = new VideoEncoder({
        output: (chunk, md) => this.onChunk(rec, chunk, md),
        error: e => { rec.failed = `encodeur vidéo : ${e?.message || e}`; this.stopVideoNow('L\'encodeur vidéo s\'est arrêté'); },
      });
      encoder.configure({ codec: this.codec, width, height, bitrate: CAPTURE_BITRATE, framerate: CAPTURE_FPS, latencyMode: 'realtime', ...(this.codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) } as VideoEncoderConfig);
    } catch (e: any) {
      this.set({ notice: `🎥 La vidéo n'a pas pu démarrer (${e?.message || e}). La prise audio continue normalement.` });
      return;
    }
    rec.encoder = encoder;
    this.rec = rec;
    this.sampleClock(rec);
    rec.clockTimer = setInterval(() => {
      this.sampleClock(rec);
      // Compteurs du panneau : 5 fois par seconde (pas à chaque image).
      if (this.s.frames !== rec.meta.frames || this.s.bytes !== rec.meta.bytes || this.s.dropped !== rec.meta.dropped) this.set({ frames: rec.meta.frames, bytes: rec.meta.bytes, dropped: rec.meta.dropped });
    }, 200);
    rec.storageTimer = setInterval(() => { void this.checkStorage(rec); }, 3000);
    this.set({ recording: true, recSince: rec.startPerf, frames: 0, bytes: 0, dropped: 0, notice: null });
    try { await putMeta(meta); } catch (e) { if (isQuotaError(e)) this.stopVideoNow('stockage plein'); }
  }

  private sampleClock(rec: RecSession) {
    const ctx = audioEngine.ctx;
    if (!ctx) return;
    let pair: ClockPair | null = null;
    if (rec.meta.clockSource === 'sortie') {
      try { const ts = (ctx as any).getOutputTimestamp(); if (ts && ts.performanceTime > 0) pair = { p: ts.performanceTime, c: ts.contextTime }; } catch { /* */ }
    } else pair = { p: performance.now(), c: ctx.currentTime };
    if (pair) { rec.meta.clock.push(pair); if (rec.meta.clock.length > 4000) rec.meta.clock.splice(1, 2); }
    const info = audioEngine.videoSyncInfo();
    if (!info) return;
    rec.outputSides.push(info.outputSide);
    let segs: OriginSegment[] = rec.meta.segments;
    if (info.wrap) { segs = addOrigin(segs, segs.length ? segs[segs.length - 1].from : 0, info.wrap.prev); segs = addOrigin(segs, info.wrap.at, info.origin ?? info.wrap.prev); }
    // Nouveau tour vu après coup : il commence à l'instant où le morceau est au début de la boucle.
    else if (info.playing && info.origin !== null) segs = addOrigin(segs, !segs.length ? 0 : info.loop ? info.origin + info.loop.start : ctx.currentTime, info.origin);
    rec.meta.segments = segs;
  }

  private async checkStorage(rec: RecSession) {
    if (this.rec !== rec || rec.stopPerf !== null) return;
    const est = await storageEstimate();
    if (!est) return;
    const free = est.quota - est.usage - rec.pendingBytes;
    this.set({ storage: storageAdvice(est) });
    if (free < STORAGE_STOP_BYTES) this.stopVideoNow('stockage plein');
  }

  private onChunk(rec: RecSession, chunk: EncodedVideoChunk, md?: EncodedVideoChunkMetadata) {
    const dc = md?.decoderConfig;
    if (dc) {
      rec.meta.codec = dc.codec;
      if (dc.description) {
        const src = dc.description as ArrayBuffer | ArrayBufferView;
        rec.meta.description = src instanceof ArrayBuffer ? src.slice(0) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice().buffer;
      }
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    const idx = rec.meta.chunkTs.length;
    rec.meta.chunkTs.push(chunk.timestamp);
    if (key) rec.meta.keyframes.push(idx);
    const sg = rec.sig.get(chunk.timestamp);
    rec.sig.delete(chunk.timestamp);
    rec.meta.luma.push(sg ? sg[0] : 0);
    rec.meta.motion.push(sg ? sg[1] : 0);
    rec.meta.frames++;
    rec.meta.bytes += data.byteLength;
    rec.pending.push({ ts: chunk.timestamp, key, data });
    rec.pendingBytes += data.byteLength;
    if (rec.pending.length >= 30 || rec.pendingBytes > 512 * 1024) this.flush(rec);
  }

  private flush(rec: RecSession) {
    if (!rec.pending.length) return;
    const items: StoredChunk[] = [];
    const total = rec.pending.reduce((s, p) => s + p.data.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of rec.pending) { buf.set(p.data, off); items.push({ ts: p.ts, key: p.key, off, len: p.data.byteLength }); off += p.data.byteLength; }
    rec.pending = []; rec.pendingBytes = 0;
    const seq = rec.meta.seqs++;
    rec.writing = rec.writing.then(() => putChunks(rec.meta.id, seq, buf.buffer, items)).catch(e => {
      if (!rec.failed) rec.failed = isQuotaError(e) ? 'stockage plein' : `écriture : ${e?.message || e}`;
      this.stopVideoNow(isQuotaError(e) ? 'stockage plein' : 'écriture impossible');
    });
  }

  private onTakeStop(d: { perf?: number }) {
    const rec = this.rec;
    if (!rec || rec.stopPerf !== null) return;
    rec.stopPerf = d.perf ?? performance.now();
    // Les images capturées juste avant l'arrêt arrivent encore un instant.
    setTimeout(() => { void this.finish(rec); }, 250);
  }

  /** Arrêt de la vidéo seule (stockage plein, caméra coupée) : la prise audio continue. */
  private stopVideoNow(reason: string) {
    const rec = this.rec;
    if (!rec || rec.finished) return;
    if (!rec.meta.stopReason) rec.meta.stopReason = reason;
    if (rec.stopPerf === null) rec.stopPerf = performance.now();
    void this.finish(rec);
    const at = Math.max(0, Math.round((rec.stopPerf - rec.startPerf) / 1000));
    const mmss = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}`;
    if (/stockage/.test(reason)) this.set({ notice: `🎥 Stockage plein : la vidéo s'est arrêtée à ${mmss}, ta prise audio continue. Fais de la place en supprimant d'anciennes vidéos (panneau Caméra).` });
    else this.set({ notice: `🎥 ${reason} : la vidéo s'est arrêtée à ${mmss}, ta prise audio continue.` });
  }

  private async finish(rec: RecSession) {
    if (rec.finished) return;
    rec.finished = true;
    if (rec.clockTimer) clearInterval(rec.clockTimer);
    if (rec.storageTimer) clearInterval(rec.storageTimer);
    this.sampleClock(rec);
    try { if (rec.encoder.state === 'configured') await rec.encoder.flush(); } catch { /* */ }
    try { rec.encoder.close(); } catch { /* */ }
    this.flush(rec);
    await rec.writing;
    if (this.rec === rec) this.rec = null;
    this.set({ recording: false, recSince: null });
    // Fin de la prise audio : son origine exacte et les clips créés (au plus 10 s d'attente).
    const done = await Promise.race([rec.done, new Promise<null>(r => setTimeout(() => r(null), 10000))]);
    const m = rec.meta;
    if (done?.takes?.length) {
      m.trackIds = done.takes.map(t => t.trackId);
      m.bufferIds = done.takes.map(t => t.clipId);
      m.takeStart = Math.min(...done.takes.map(t => t.start));
      m.takeEnd = Math.max(...done.takes.map(t => t.start + t.duration));
      m.linked = done.takes;
    }
    // Sans tour de boucle : exactement l'origine utilisée pour la prise audio.
    const wraps = m.segments.length > 1;
    if (!wraps && done && typeof done.origin === 'number') m.segments = [{ from: 0, t0: done.origin }];
    if (rec.outputSides.length) m.outputSide = [...rec.outputSides].sort((a, b) => a - b)[rec.outputSides.length >> 1];
    retimeMeta(m);
    m.status = m.stopReason ? 'partial' : 'ok';
    if (!m.frames) {
      try { await deleteTake(m.id); } catch { /* */ }
      this.set({ last: null, notice: rec.failed ? `🎥 La vidéo n'a pas pu être enregistrée (${rec.failed}). La prise audio est bien là.` : this.s.notice });
      return;
    }
    try { await putMeta(m); } catch (e) { console.warn('[Vidéo de la prise] fiche non écrite', e); }
    this.set({ last: { id: m.id, status: m.status, durationSec: m.durationSec, bytes: m.bytes, reason: m.stopReason } });
    try { window.dispatchEvent(new CustomEvent('nova:video-take-saved', { detail: { id: m.id, projectId: m.projectId } })); } catch { /* */ }
    void this.refreshStorage();
  }

  /**
   * Mesure du décalage caméra ↔ son sur une prise filmée (clap ou flash) : attaques de la prise
   * audio contre événements visibles. Le décalage est gardé pour cette caméra et la prise est recalée.
   */
  async measureOn(takeId: string): Promise<{ ok: true; measure: SyncMeasure; offsetMs: number } | { ok: false; why: string }> {
    const m = await getMeta(takeId);
    if (!m || !m.times) return { ok: false, why: 'Vidéo introuvable.' };
    const linked = m.linked || [];
    const l0 = linked.find(l => audioBufferRegistry.get(l.clipId));
    const buf = l0 ? audioBufferRegistry.get(l0.clipId) : undefined;
    if (!buf || !l0) return { ok: false, why: 'La prise audio de cette vidéo n\'est plus dans le projet.' };
    const onsets = audioOnsets(buf.getChannelData(0), buf.sampleRate).map(t => t + l0.start);
    if (!onsets.length) return { ok: false, why: 'Aucun clap net dans le son : tape fort dans tes mains, près du micro, 3 fois.' };
    const ev = visualEvents(m.times.map((t, i) => ({ t, luma: m.luma[i] || 0, motion: m.motion[i] || 0 })));
    if (!ev.length) return { ok: false, why: 'Aucun clap visible à l\'image : mets tes mains bien dans le cadre, en pleine lumière.' };
    const meas = measureSync(onsets, ev);
    if (!meas) return { ok: false, why: 'Les claps du son et de l\'image ne se correspondent pas (plus de 0,4 s d\'écart). Recommence en tapant 3 fois, lentement.' };
    const total = m.offsetMs + meas.offsetMs;
    m.offsetMs = total;
    retimeMeta(m);
    await putMeta(m);
    const all = readOffsets(); all[m.cameraKey] = Math.round(total * 10) / 10;
    try { localStorage.setItem(OFFSETS_KEY, JSON.stringify(all)); } catch { /* */ }
    if (cameraKey(this.s.label, this.s.deviceId || undefined) === m.cameraKey) this.set({ offsetMs: all[m.cameraKey] });
    return { ok: true, measure: meas, offsetMs: total };
  }

  /** Réglage fin à la main d'une vidéo (ms, positif = image retardée). */
  async setTakeOffset(takeId: string, offsetMs: number): Promise<VideoTakeMeta | null> {
    const m = await getMeta(takeId);
    if (!m) return null;
    m.offsetMs = Math.round(offsetMs * 10) / 10;
    retimeMeta(m);
    await putMeta(m);
    return m;
  }
}

/** Recalcule le temps du morceau de chaque image (fin de prise, clap, réglage). */
export function retimeMeta(m: VideoTakeMeta) {
  const sync: TakeSync = { fit: fitClock(m.clock), renderLead: m.renderLead, outputSide: m.outputSide, segments: m.segments, offsetMs: m.offsetMs };
  const captures = m.chunkTs.map(ts => m.firstCaptureMs + ts / 1000);
  const r = frameTimelines(captures, sync);
  m.times = r.times;
  m.passes = r.passes;
  m.durationSec = captures.length > 1 ? Math.round(((captures[captures.length - 1] - captures[0]) / 1000 + 1 / CAPTURE_FPS) * 100) / 100 : 0;
}

export const videoTake = new VideoTakeController();
export { BYTES_PER_SEC };

if (typeof window !== 'undefined' && import.meta.env?.DEV) (window as any).__novaVideoTake = videoTake;
