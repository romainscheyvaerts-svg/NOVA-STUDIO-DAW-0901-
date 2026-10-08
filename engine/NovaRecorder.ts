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
 */

import { retireWorkletNode } from './workletGuard';

const WORKLET = `
class NovaRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    // k > 0 : K canaux gardés séparés (multipiste) ; sinon mono (moyenne des canaux).
    this.k = Math.max(0, Math.min(32, o.channels || 0));
    this.on = false;
    this.first = -1;
    this.chunk = new Float32Array(8192);
    this.chunks = [];
    for (let c = 0; c < this.k; c++) this.chunks.push(new Float32Array(8192));
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.first = -1; this.n = 0; }
      else if (e.data === 'stop') {
        this.flush();
        this.on = false;
        this.port.postMessage({ type: 'done', first: this.first });
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
  process(inputs, outputs) {
    const inp = inputs[0];
    if (this.on && this.k > 0) {
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
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
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

  constructor(private ctx: AudioContext, source: AudioNode, opts: { channels?: number } = {}) {
    this.channels = Math.max(0, Math.min(32, Math.floor(opts.channels || 0)));
    const k = this.channels;
    this.node = new AudioWorkletNode(ctx, 'nova-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      ...(k > 0 ? { channelCount: k, channelCountMode: 'explicit' as ChannelCountMode, channelInterpretation: 'discrete' as ChannelInterpretation, processorOptions: { channels: k } } : {}),
    });
    this.donePromise = new Promise(r => { this.resolveDone = r; });
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
    const firstFrame = await Promise.race([this.donePromise, new Promise<number>(r => setTimeout(() => r(-1), 2000))]);
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
