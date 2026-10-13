/**
 * Master express (lot 4a), côté navigateur :
 *  - lecture du fichier (WAV, MP3, FLAC…) à SA fréquence d'échantillonnage ;
 *  - moteur dans un Worker (utils/quickMaster.worker.ts), ou dans le fil
 *    principal si le Worker est indisponible : même code, même résultat ;
 *  - lecteur A/B (original, master, référence) synchronisé, au même volume
 *    perçu ;
 *  - export WAV 24 bits et MP3 320 kb/s du tampon ÉCOUTÉ (pas d'un 2e rendu).
 */
import { analyzeTrack, renderQuickMaster, QmAnalysis, QmCache, QmCancelled, QmOptions, QmResult } from '../utils/quickMaster';
import { encodeWav } from '../utils/audioFormats';
import { decodeFlac } from '../utils/flac';

// ---------------------------------------------------------------------------
// Lecture du fichier
// ---------------------------------------------------------------------------

const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Fréquence d'échantillonnage lue dans l'en-tête (WAV, FLAC, MP3) ; null si inconnue. */
export function sniffSampleRate(b: Uint8Array): number | null {
  const s = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length > 12 && s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 12;
    while (p + 8 <= b.length) {
      const size = dv.getUint32(p + 4, true);
      if (s(p, 4) === 'fmt ') return dv.getUint32(p + 12, true) || null;
      p += 8 + size + (size & 1);
    }
    return null;
  }
  if (b.length > 22 && s(0, 4) === 'fLaC') {
    const sr = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
    return sr || null;
  }
  // MP3 : saute l'ID3v2, puis cherche une trame valide.
  let p = 0;
  if (s(0, 3) === 'ID3' && b.length > 10) p = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  for (const end = Math.min(b.length - 4, p + 65536); p < end; p++) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, sri = (b[p + 2] >> 2) & 3, br = b[p + 2] >> 4;
    if (ver === 1 || layer === 0 || sri === 3 || br === 0 || br === 15) continue;
    return MP3_RATES[ver]?.[sri] ?? null;
  }
  return null;
}

export interface DecodedFile { ch: Float32Array[]; sampleRate: number; duration: number; bytes: Uint8Array; name: string }

export const MAX_SECONDS = 12 * 60;

/** Décode un fichier audio à sa fréquence d'origine (aucun rééchantillonnage). Toujours en stéréo. */
export async function decodeAudioFile(file: File): Promise<DecodedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sr = sniffSampleRate(bytes) || 48000;
  let ch: Float32Array[];
  try {
    const ctx = new OfflineAudioContext(2, 1, Math.max(8000, Math.min(192000, sr)));
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    ch = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => new Float32Array(buf.getChannelData(c)));
  } catch (e) {
    // FLAC que le navigateur ne lit pas (anciens Safari) : décodeur NOVA.
    if (bytes[0] === 0x66 && bytes[1] === 0x4c) {
      const d = decodeFlac(bytes);
      const scale = 2 ** (d.bps - 1);
      ch = d.channels.slice(0, 2).map(x => Float32Array.from(x, v => v / scale));
      if (!ch.length) throw new Error('FLAC illisible');
    } else throw new Error('Format non pris en charge (WAV, MP3 ou FLAC).');
  }
  if (ch.length === 1) ch = [ch[0], new Float32Array(ch[0])];
  const duration = ch[0].length / sr;
  if (duration < 1) throw new Error('Fichier trop court (moins d’une seconde).');
  if (duration > MAX_SECONDS) throw new Error(`Fichier trop long (${Math.round(duration / 60)} min) : 12 minutes au plus.`);
  return { ch, sampleRate: sr, duration, bytes, name: file.name };
}

// ---------------------------------------------------------------------------
// Moteur (Worker, ou fil principal en secours)
// ---------------------------------------------------------------------------

export type Progress = (label: string, p: number) => void;

export class QuickMasterEngine {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: QmResult) => void; reject: (e: Error) => void; onProgress?: Progress }>();
  private loads: { which: string; resolve: (a: QmAnalysis) => void; reject: (e: Error) => void }[] = [];
  // Secours sans Worker
  private local: { ch: Float32Array[]; sr: number; analysis: QmAnalysis } | null = null;
  private localRef: number[] | null = null;
  private localCurrent = 0;
  private localStore: QmCache[] = [];

  constructor() {
    try {
      this.worker = new Worker(new URL('../utils/quickMaster.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (ev) => { ev.preventDefault?.(); this.failWorker(); };
    } catch { this.worker = null; }
  }

  /** Worker cassé (CSP, build) : on bascule en calcul direct, en relançant ce qui attendait. */
  private failWorker() {
    try { this.worker?.terminate(); } catch { /* */ }
    this.worker = null;
    for (const l of this.loads.splice(0)) l.reject(new Error('Moteur indisponible, réessaie.'));
    for (const [, p] of this.pending) p.reject(new Error('Moteur indisponible, réessaie.'));
    this.pending.clear();
  }

  private onMessage(m: any) {
    if (m.type === 'analysis' || (m.type === 'error' && m.which)) {
      const i = this.loads.findIndex(l => l.which === m.which);
      if (i < 0) return;
      const [l] = this.loads.splice(i, 1);
      if (m.type === 'analysis') l.resolve(m.analysis); else l.reject(new Error(m.message));
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') p.onProgress?.(m.label, m.p);
    else if (m.type === 'result') { this.pending.delete(m.id); p.resolve({ ...m.result, out: m.out }); }
    else if (m.type === 'cancelled') { this.pending.delete(m.id); p.reject(new QmCancelled()); }
    else if (m.type === 'error') { this.pending.delete(m.id); p.reject(new Error(m.message)); }
  }

  /**
   * Charge le morceau dans le moteur et renvoie son analyse. `transfer` : les
   * canaux partent au Worker SANS copie (ils deviennent inutilisables ici).
   */
  load(which: 'track' | 'ref', ch: Float32Array[], sr: number, transfer = false): Promise<QmAnalysis> {
    if (this.worker) {
      const copy = transfer ? ch : ch.map(x => new Float32Array(x));
      return new Promise((resolve, reject) => {
        this.loads.push({ which, resolve, reject });
        this.worker!.postMessage({ type: 'load', which, ch: copy, sr }, copy.map(x => x.buffer));
      });
    }
    return new Promise((resolve, reject) => setTimeout(() => {
      try {
        const a = analyzeTrack(ch, sr);
        if (which === 'track') { this.local = { ch, sr, analysis: a }; this.localStore = []; } else this.localRef = a.curve;
        resolve(a);
      } catch (e) { reject(e as Error); }
    }, 0));
  }

  clearReference() { if (this.worker) this.worker.postMessage({ type: 'clear', which: 'ref' }); this.localRef = null; }

  /** Lance un rendu ; le précédent, s'il tourne encore, est annulé. */
  render(opts: QmOptions, useRef: boolean, onProgress?: Progress): Promise<QmResult> {
    const id = ++this.seq;
    for (const [pid] of this.pending) this.cancel(pid);
    if (this.worker) {
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress });
        this.worker!.postMessage({ type: 'render', id, opts, useRef });
      });
    }
    this.localCurrent = id;
    if (!this.local) return Promise.reject(new Error('Aucun morceau chargé.'));
    const l = this.local;
    return renderQuickMaster(l.ch, l.sr, l.analysis, { ...opts, refCurve: useRef ? this.localRef : null }, {
      onProgress, yieldNow: () => new Promise(r => setTimeout(r, 0)), isCancelled: () => this.localCurrent !== id,
    }, {
      get: k => this.localStore.find(c => c.key === k),
      set: c => { this.localStore.unshift(c); this.localStore.length = Math.min(2, this.localStore.length); },
    });
  }

  /** Annule tout rendu en cours (nouveau fichier). */
  cancelAll() { for (const [pid] of this.pending) this.cancel(pid); this.localCurrent = 0; }

  cancel(id: number) {
    const p = this.pending.get(id);
    if (p && this.worker) { this.worker.postMessage({ type: 'cancel', id }); }
    if (this.localCurrent === id) this.localCurrent = 0;
  }

  dispose() {
    try { this.worker?.terminate(); } catch { /* */ }
    this.worker = null;
    for (const [, p] of this.pending) p.reject(new QmCancelled());
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Lecteur A/B
// ---------------------------------------------------------------------------

export type Source = 'original' | 'master' | 'reference';

export class QuickMasterPlayer {
  private ctx: AudioContext | null = null;
  private bufs: Partial<Record<Source, AudioBuffer>> = {};
  private nodes: Partial<Record<Source, { src: AudioBufferSourceNode; gain: GainNode }>> = {};
  private levels: Record<Source, number> = { original: 1, master: 1, reference: 1 };
  private startedAt = 0;
  private offset = 0;
  playing = false;
  selected: Source = 'master';
  duration = 0;
  onChange?: () => void;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'playback' });
    }
    return this.ctx;
  }

  /** Tampon écouté : pour le master, CE tampon est celui qui part à l'export. */
  setBuffer(which: Source, ch: Float32Array[] | null, sampleRate: number) {
    if (!ch) { delete this.bufs[which]; if (which === 'original') this.duration = 0; this.restart(); return; }
    const ctx = this.ensureCtx();
    const b = ctx.createBuffer(2, ch[0].length, sampleRate);
    b.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0);
    b.copyToChannel((ch[1] || ch[0]) as Float32Array<ArrayBuffer>, 1);
    this.bufs[which] = b;
    if (which === 'original') this.duration = b.duration;
    this.restart();
  }

  /** Données réellement jouées (contrôle « écoute = export »). */
  playedChannels(which: Source): Float32Array[] | null {
    const b = this.bufs[which];
    return b ? [b.getChannelData(0), b.getChannelData(1)] : null;
  }

  has(which: Source) { return !!this.bufs[which]; }

  /** Niveaux d'écoute (dB) de chaque source. */
  setLevelsDb(l: Partial<Record<Source, number>>) {
    for (const k of Object.keys(l) as Source[]) this.levels[k] = Math.pow(10, (l[k] ?? 0) / 20);
    this.applyGains();
  }

  select(s: Source) {
    if (!this.bufs[s]) return;
    this.selected = s;
    this.applyGains();
    this.onChange?.();
  }

  private applyGains() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const k of Object.keys(this.nodes) as Source[]) {
      const n = this.nodes[k]!;
      n.gain.gain.setTargetAtTime(k === this.selected ? this.levels[k] : 0, ctx.currentTime, 0.008);
    }
  }

  position(): number {
    if (!this.playing || !this.ctx || !this.duration) return this.offset;
    return (this.ctx.currentTime - this.startedAt) % this.duration;
  }

  async play() {
    const ctx = this.ensureCtx();
    if (!this.bufs.original) return;
    try { await ctx.resume(); } catch { /* */ }
    this.stopNodes();
    const at = ctx.currentTime + 0.03;
    for (const k of Object.keys(this.bufs) as Source[]) {
      const b = this.bufs[k]!;
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = k === this.selected ? this.levels[k] : 0;
      src.connect(gain).connect(ctx.destination);
      // La référence n'a pas la même durée : elle boucle sur la sienne.
      src.start(at, this.offset % b.duration);
      this.nodes[k] = { src, gain };
    }
    this.startedAt = at - this.offset;
    this.playing = true;
    this.onChange?.();
  }

  pause() {
    this.offset = this.position();
    this.stopNodes();
    this.playing = false;
    this.onChange?.();
  }

  seek(t: number) {
    this.offset = Math.max(0, Math.min(this.duration || 0, t));
    if (this.playing) void this.play(); else this.onChange?.();
  }

  private restart() { if (this.playing) { this.offset = this.position(); void this.play(); } }

  private stopNodes() {
    for (const k of Object.keys(this.nodes) as Source[]) {
      const n = this.nodes[k]!;
      try { n.src.stop(); } catch { /* */ }
      try { n.src.disconnect(); n.gain.disconnect(); } catch { /* */ }
    }
    this.nodes = {};
  }

  dispose() { this.stopNodes(); this.playing = false; try { void this.ctx?.close(); } catch { /* */ } this.ctx = null; }
}

// ---------------------------------------------------------------------------
// Export (le tampon écouté, tel quel)
// ---------------------------------------------------------------------------

export function masterWav24(ch: Float32Array[], sampleRate: number): Blob {
  const bytes = encodeWav(ch, { sampleRate, bits: 24 });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
}

/** MP3 320 kb/s, crête vraie du fichier DÉCODÉ sous −1 dBTP (encodeur NOVA, sur une copie). */
export async function masterMp3(ch: Float32Array[], sampleRate: number): Promise<Blob> {
  const { AudioEncoder } = await import('./AudioEncoder');
  const b = new AudioBuffer({ length: ch[0].length, numberOfChannels: 2, sampleRate });
  b.copyToChannel(new Float32Array(ch[0]), 0);
  b.copyToChannel(new Float32Array(ch[1] || ch[0]), 1);
  return AudioEncoder.encodeMP3Plafonne(b, 320, -1);
}

/** Crêtes min / max par colonne (aperçu de forme d'onde). */
export function waveformPeaks(ch: Float32Array[], columns: number): { min: Float32Array; max: Float32Array } {
  const n = ch[0]?.length || 0, cols = Math.max(1, columns);
  const min = new Float32Array(cols), max = new Float32Array(cols);
  const step = n / cols;
  for (let c = 0; c < cols; c++) {
    let lo = 0, hi = 0;
    const s = Math.floor(c * step), e = Math.min(n, Math.floor((c + 1) * step));
    const stride = Math.max(1, Math.floor((e - s) / 400));
    for (let i = s; i < e; i += stride) for (const x of ch) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[c] = lo; max[c] = hi;
  }
  return { min, max };
}
