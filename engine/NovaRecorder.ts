/**
 * Enregistreur de prises calé à l'échantillon près.
 *
 * Le MediaRecorder du navigateur démarrait avec un retard variable (et
 * compressait la voix) : on ne savait pas exactement à quel instant de la
 * timeline correspondait le début de la prise. Ici un AudioWorklet capte le
 * signal dans le graphe audio et note le numéro d'échantillon (horloge du
 * contexte) du premier échantillon capté : la position de la prise est
 * exacte, il ne reste qu'à retirer la latence d'entrée / sortie mesurée.
 *
 * R14 · Multipiste : en mode « discret » (option `channels`), le même enregistreur
 * capte K canaux à la fois (une ou deux par piste armée) : UN seul n° de premier
 * échantillon pour toutes les pistes, donc des prises alignées à l'échantillon.
 *
 * Horloge : une fois la prise commencée, CHAQUE bloc de rendu (128 échantillons)
 * est écrit, même quand l'entrée ne porte aucun canal (source débranchée ou
 * inactive) : du silence à sa place, jamais un raccourcissement. Mesuré
 * (qa/prise_horloge.py) : le mode mono sautait ces blocs, la suite de la prise
 * arrivait jusqu'à 50 ms trop tôt après 2 coupures de 0,3 s.
 */

import { retireWorkletNode } from './workletGuard';
import { takeRingSource, canShareMemory, createTakeRing } from './takeRing';
import type { TakeWriterClient, TakeTarget, TakeWriterEnded } from './takeWriter';

/**
 * Code de l'AudioWorklet (exporté pour tests/novaRecorderClock.test.ts).
 *
 * Trois façons de sortir les échantillons du fil audio :
 *  - « ring » (page isolée, SharedArrayBuffer) : anneau sans verrou lu par l'écrivain de prises
 *    (engine/takeRing, engine/takeWriter.worker) ; AUCUNE allocation, aucun message pendant la prise ;
 *  - « port » (sans isolation) : morceaux de 2048 images envoyés directement au Worker par un port
 *    dédié, dans des tampons préalloués qu'il renvoie (réserve de 48, soit 2 s) ;
 *  - « post » (ancien chemin) : morceaux de 8192 images postés à la page.
 */
export const NOVA_RECORDER_WORKLET = takeRingSource() + `
class NovaRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    // k > 0 : K canaux gardés séparés (multipiste) ; sinon mono (moyenne des canaux).
    this.k = Math.max(0, Math.min(32, o.channels || 0));
    // keepClock (par défaut) : un bloc sans entrée après le début de la prise devient du
    // silence au lieu d'être sauté ; sinon la suite de la prise glisserait plus tôt sur
    // l'horloge. keepClock: false = ancien comportement (gardé pour les tests de mesure).
    this.keepClock = o.keepClock !== false;
    this.kk = Math.max(1, this.k);
    this.mode = o.ring ? 'ring' : (o.pool ? 'port' : 'post');
    this.on = false;
    this.first = -1;
    this.n = 0;
    this.allocs = 0;
    if (this.mode === 'ring') {
      this.h = new Int32Array(o.ring.header);
      this.d = new Float32Array(o.ring.data);
      this.cap = o.ring.capacity;
      this.f64 = new Float64Array(o.ring.header, 32, 1);
    } else if (this.mode === 'port') {
      this.size = o.pool.frames;
      this.free = [];
      for (let i = 0; i < o.pool.count; i++) this.free.push(new Float32Array(this.size * this.kk));
      this.cur = null;
      this.wport = null;
    } else {
      this.chunk = new Float32Array(8192);
      this.chunks = [];
      for (let c = 0; c < this.k; c++) this.chunks.push(new Float32Array(8192));
    }
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m === 'start') { this.on = true; this.first = -1; this.n = 0; }
      else if (m === 'stop') {
        if (this.mode === 'ring') Atomics.store(this.h, 3, 2);
        else if (this.mode === 'port') { if (this.n > 0) this.send(); if (this.wport) this.wport.postMessage({ eos: true, allocs: this.allocs }); }
        else this.flush();
        this.on = false;
        this.port.postMessage({ type: 'done', first: this.first, allocs: this.allocs });
      } else if (m && m.type === 'port' && e.ports && e.ports[0]) {
        this.wport = e.ports[0];
        this.wport.onmessage = (ev) => { const b = ev.data && ev.data.b; if (b && b.length === this.size * this.kk) this.free.push(b); };
      }
    };
  }
  flush() {
    if (this.n > 0) {
      if (this.k > 0) {
        const outs = this.chunks.map(c => c.slice(0, this.n));
        this.port.postMessage({ type: 'multi', data: outs, first: this.first }, outs.map(o => o.buffer));
      } else {
        const out = this.chunk.slice(0, this.n);
        this.port.postMessage({ type: 'data', data: out, first: this.first }, [out.buffer]);
      }
      this.n = 0;
    }
  }
  send() {
    const b = this.cur;
    this.cur = null;
    if (b && this.wport) this.wport.postMessage({ f: this.first, n: this.n, b }, [b.buffer]);
    this.n = 0;
  }
  /** Port : un bloc (canaux absents = silence ; mono = moyenne des canaux présents). */
  portWrite(inp, len, mono) {
    let i = 0;
    while (i < len) {
      if (!this.cur) { this.cur = this.free.pop() || null; if (!this.cur) { this.allocs++; this.cur = new Float32Array(this.size * this.kk); } }
      const b = this.cur, size = this.size;
      const m = Math.min(len - i, size - this.n);
      if (mono) {
        const nIn = inp ? inp.length : 0;
        for (let j = 0; j < m; j++) { let v = 0; for (let c = 0; c < nIn; c++) v += inp[c][i + j]; b[this.n + j] = nIn > 1 ? v / nIn : v; }
      } else {
        for (let c = 0; c < this.k; c++) {
          const src = inp && c < inp.length ? inp[c] : null, base = c * size + this.n;
          if (src) for (let j = 0; j < m; j++) b[base + j] = src[i + j]; else for (let j = 0; j < m; j++) b[base + j] = 0;
        }
      }
      this.n += m; i += m;
      if (this.n === size) this.send();
    }
  }
  /** Bloc capté, quel que soit le chemin. inp = null : silence (horloge gardée). */
  write(inp, len, mono) {
    if (this.mode === 'ring') ringWrite(this.h, this.d, this.cap, this.kk, inp, len, mono);
    else this.portWrite(inp, len, mono);
  }
  begin() {
    this.first = currentFrame;
    if (this.mode === 'ring') { this.f64[0] = currentFrame; Atomics.store(this.h, 3, 1); }
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    if (this.on && this.mode !== 'post') {
      const has = inp && inp.length;
      const len = has ? inp[0].length : 128;
      if (this.k > 0) { if (this.first < 0) this.begin(); this.write(has ? inp : null, len, false); }
      else if (has) { if (this.first < 0) this.begin(); this.write(inp, len, true); }
      else if (this.first >= 0 && this.keepClock) this.write(null, 128, true);
    } else if (this.on && this.k > 0) {
      // Multipiste : chaque canal à part ; un canal absent (entrée débranchée) = silence.
      const len = inp && inp.length ? inp[0].length : 128;
      if (this.first < 0) this.first = currentFrame;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < this.k; c++) this.chunks[c][this.n] = inp && c < inp.length ? inp[c][i] : 0;
        this.n++;
        if (this.n === 8192) this.flush();
      }
    } else if (this.on && inp && inp.length) {
      const len = inp[0].length;
      if (this.first < 0) this.first = currentFrame;
      // Mono : moyenne des canaux présents (une voix sur un seul canal reste à niveau plein)
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < inp.length; c++) v += inp[c][i];
        this.chunk[this.n++] = inp.length > 1 ? v / inp.length : v;
        if (this.n === this.chunk.length) this.flush();
      }
    } else if (this.on && this.first >= 0 && this.keepClock) {
      for (let i = 0; i < 128; i++) {
        this.chunk[this.n++] = 0;
        if (this.n === this.chunk.length) this.flush();
      }
    } else if (this.on && this.first < 0) {
      // Entrée pas encore alimentée : l'horloge avance quand même
    }
    const out = outputs[0];
    if (out) for (const c of out) c.fill(0);
    return true;
  }
}
registerProcessor('nova-recorder', NovaRecorder);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export async function ensureRecorderModule(ctx: AudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([NOVA_RECORDER_WORKLET], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, p);
    p.catch(() => loaded.delete(ctx));
  }
  return p;
}

export class NovaRecorderSession {
  private node: AudioWorkletNode;
  private sink: GainNode;
  private chunks: Float32Array[] = [];
  private donePromise: Promise<number>;
  private resolveDone!: (first: number) => void;
  /** Chaque morceau capté (≈ 0,37 s), au fil de l'eau : journal de prise (récupération après plantage). */
  public onChunk: ((chunk: Float32Array) => void) | null = null;
  /** Multipiste : chaque morceau, un tableau par canal. */
  public onChunks: ((chunks: Float32Array[]) => void) | null = null;
  private multi: Float32Array[][] = [];
  /** Canaux gardés séparés (0 = mono). */
  public readonly channels: number;
  /** N° (horloge du contexte) du 1er échantillon capté, connu dès le 1er morceau (-1 avant). */
  public firstFrame = -1;
  /**
   * Chemin des échantillons : « ring » (anneau partagé → écrivain de prises), « port » (port direct
   * vers l'écrivain), « post » (ancien : morceaux postés à la page, aucun écrivain).
   */
  public readonly transport: 'ring' | 'port' | 'post';
  /** Compte de l'écrivain à l'arrêt (images reçues, écrites durablement, perdues). */
  public writerReport: TakeWriterEnded | null = null;
  /** Avertissement de l'écrivain (base pleine…) : la prise continue, la récupération est moins sûre. */
  public writerWarning: string | null = null;
  private writer: TakeWriterClient | null = null;
  private writerId = '';
  private ringHeader: Int32Array | null = null;
  private ringCap = 0;

  /** Anneau (prise en cours) : images publiées, en attente, perdues ; null hors anneau partagé. */
  ringStatus(): { written: number; pending: number; lost: number; capacity: number } | null {
    const h = this.ringHeader;
    if (!h) return null;
    const w = Atomics.load(h, 0), r = Atomics.load(h, 1);
    return { written: w >>> 0, pending: (w - r) | 0, lost: Atomics.load(h, 2), capacity: this.ringCap };
  }

  /**
   * `keepClock: false` : ancien comportement (blocs sans entrée sautés), pour la mesure seulement.
   * `writer` : les échantillons partent du fil audio vers l'écrivain de prises (Worker), qui les écrit
   * dans la base de récupération (`targets` : une prise du journal par piste) et les renvoie à la page.
   */
  constructor(private ctx: AudioContext, source: AudioNode, opts: { channels?: number; keepClock?: boolean; writer?: TakeWriterClient | null; targets?: TakeTarget[] } = {}) {
    this.channels = Math.max(0, Math.min(32, Math.floor(opts.channels || 0)));
    const k = this.channels;
    const writer = opts.writer || null;
    const ring = writer && canShareMemory() ? createTakeRing(Math.max(1, k), ctx.sampleRate) : null;
    this.transport = writer ? (ring ? 'ring' : 'port') : 'post';
    if (ring) { this.ringHeader = new Int32Array(ring.header); this.ringCap = ring.capacity; }
    const transportOpts = ring ? { ring: { header: ring.header, data: ring.data, capacity: ring.capacity } }
      : writer ? { pool: { frames: 2048, count: 48 } } : {};
    const po = { ...(k > 0 ? { channels: k } : {}), ...(opts.keepClock === false ? { keepClock: false } : {}), ...transportOpts };
    this.node = new AudioWorkletNode(ctx, 'nova-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      ...(k > 0 ? { channelCount: k, channelCountMode: 'explicit' as ChannelCountMode, channelInterpretation: 'discrete' as ChannelInterpretation } : {}),
      ...(Object.keys(po).length ? { processorOptions: po } : {}),
    });
    this.donePromise = new Promise(r => { this.resolveDone = r; });
    if (writer) {
      this.writer = writer;
      this.writerId = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      let port: MessagePort | undefined;
      if (!ring) {
        const mc = new MessageChannel();
        this.node.port.postMessage({ type: 'port' }, [mc.port1]);
        port = mc.port2;
      }
      writer.begin({ id: this.writerId, k: Math.max(1, k), sr: ctx.sampleRate, ...(ring ? { ring: { header: ring.header, data: ring.data, capacity: ring.capacity } } : {}), ...(port ? { port } : {}), targets: opts.targets || [] }, {
        onChunk: (ch, first) => {
          if (this.firstFrame < 0 && first >= 0) this.firstFrame = first;
          if (k > 0) { this.multi.push(ch); try { this.onChunks?.(ch); } catch { /* le journal ne doit jamais gêner la prise */ } }
          else { this.chunks.push(ch[0]); try { this.onChunk?.(ch[0]); } catch { /* idem */ } }
        },
        onWarn: (m) => { this.writerWarning = m; console.warn('[Prise] écrivain :', m); },
      });
    }
    this.node.port.onmessage = (e) => {
      if (this.firstFrame < 0 && typeof e.data?.first === 'number' && e.data.first >= 0) this.firstFrame = e.data.first;
      if (e.data?.type === 'data') {
        const c = e.data.data as Float32Array;
        this.chunks.push(c);
        try { this.onChunk?.(c); } catch { /* le journal ne doit jamais gêner la prise */ }
      }
      else if (e.data?.type === 'multi') {
        const cs = e.data.data as Float32Array[];
        this.multi.push(cs);
        try { this.onChunks?.(cs); } catch { /* idem */ }
      }
      else if (e.data?.type === 'done') this.resolveDone(Number(e.data.first));
    };
    // Le nœud doit être relié à la sortie pour être cadencé ; il n'y envoie que du silence.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.node.port.postMessage('start');
  }

  /**
   * Arrête la capture ; renvoie les échantillons mono et le n° d'échantillon (horloge du
   * contexte) du premier. Multipiste : `channels` = un tableau par canal, même premier n°.
   */
  async stop(source: AudioNode): Promise<{ samples: Float32Array; firstFrame: number; channels?: Float32Array[] }> {
    this.node.port.postMessage('stop');
    let firstFrame = await Promise.race([this.donePromise, new Promise<number>(r => setTimeout(() => r(-1), 2000))]);
    // Écrivain : l'anneau est vidé et le reste écrit ; ses derniers morceaux arrivent avant son compte.
    if (this.writer) {
      this.writerReport = await this.writer.end(this.writerId);
      if (firstFrame < 0 && this.writerReport && this.writerReport.first >= 0) firstFrame = this.writerReport.first;
    }
    try { source.disconnect(this.node); } catch { /* déjà déconnecté */ }
    try { this.node.disconnect(); this.sink.disconnect(); } catch { /* */ }
    // Sinon le processeur de chaque prise restait vivant et calculé (fuite mesurée).
    retireWorkletNode(this.node);
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { samples.set(c, o); o += c.length; }
    this.chunks = [];
    let channels: Float32Array[] | undefined;
    if (this.channels > 0) {
      const len = this.multi.reduce((s, m) => s + (m[0]?.length || 0), 0);
      channels = [];
      for (let c = 0; c < this.channels; c++) {
        const x = new Float32Array(len);
        let p = 0;
        for (const m of this.multi) { if (m[c]) x.set(m[c], p); p += m[0]?.length || 0; }
        channels.push(x);
      }
      this.multi = [];
    }
    return { samples, firstFrame, channels };
  }
}

/**
 * WAV PCM 24 bits (sauvegarde du projet : pas de perte, contrairement au MediaRecorder).
 * Mono (un tableau) ou plusieurs canaux (R14 : prise d'une entrée stéréo).
 */
export function encodeWav24(samples: Float32Array | Float32Array[], sampleRate: number): Blob {
  const chs = Array.isArray(samples) ? samples : [samples];
  const nc = Math.max(1, chs.length);
  const n = chs[0]?.length || 0;
  const bytes = n * 3 * nc;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 3 * nc, true); v.setUint16(32, 3 * nc, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const x = Math.max(-1, Math.min(1, chs[c][i] || 0));
      const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
      v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff);
      o += 3;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
