/**
 * Enregistreur de prises calé à l'échantillon près.
 *
 * Le MediaRecorder du navigateur démarrait avec un retard variable (et
 * compressait la voix) : on ne savait pas exactement à quel instant de la
 * timeline correspondait le début de la prise. Ici un AudioWorklet capte le
 * signal dans le graphe audio et note le numéro d'échantillon (horloge du
 * contexte) du premier échantillon capté : la position de la prise est
 * exacte, il ne reste qu'à retirer la latence d'entrée / sortie mesurée.
 */

import { retireWorkletNode } from './workletGuard';

const WORKLET = `
class NovaRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.first = -1;
    this.chunk = new Float32Array(8192);
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
      const out = this.chunk.slice(0, this.n);
      this.port.postMessage({ type: 'data', data: out }, [out.buffer]);
      this.n = 0;
    }
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
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

  constructor(private ctx: AudioContext, source: AudioNode) {
    this.node = new AudioWorkletNode(ctx, 'nova-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.donePromise = new Promise(r => { this.resolveDone = r; });
    this.node.port.onmessage = (e) => {
      if (e.data?.type === 'data') {
        const c = e.data.data as Float32Array;
        this.chunks.push(c);
        try { this.onChunk?.(c); } catch { /* le journal ne doit jamais gêner la prise */ }
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

  /** Arrête la capture ; renvoie les échantillons mono et le n° d'échantillon (horloge du contexte) du premier. */
  async stop(source: AudioNode): Promise<{ samples: Float32Array; firstFrame: number }> {
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
    return { samples, firstFrame };
  }
}

/** WAV PCM 24 bits mono (sauvegarde du projet : pas de perte, contrairement au MediaRecorder). */
export function encodeWav24(samples: Float32Array, sampleRate: number): Blob {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 3);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 3, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, n * 3, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
    v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff);
    o += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
