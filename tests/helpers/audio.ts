/**
 * Web Audio minimal pour Node : un AudioBuffer (canaux Float32) et un
 * AudioContext qui sait créer des buffers et décoder les WAV PCM 16 bits
 * écrits par services/AudioUtils (audioBufferToWav / wavOf).
 *
 * Volontairement strict : le décodeur lit les vrais en-têtes RIFF et refuse
 * tout ce qui n'est pas du PCM 16 bits, pour qu'un WAV mal écrit fasse
 * échouer le test au lieu d'être « décodé » par complaisance.
 */

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(opts: { numberOfChannels: number; length: number; sampleRate: number }) {
    if (opts.numberOfChannels < 1) throw new Error('numberOfChannels < 1');
    if (opts.length < 1) throw new Error('length < 1');
    this.numberOfChannels = opts.numberOfChannels;
    this.length = opts.length;
    this.sampleRate = opts.sampleRate;
    this.channels = Array.from({ length: opts.numberOfChannels }, () => new Float32Array(opts.length));
  }

  get duration(): number { return this.length / this.sampleRate; }

  getChannelData(c: number): Float32Array {
    const ch = this.channels[c];
    if (!ch) throw new Error(`Canal ${c} inexistant`);
    return ch;
  }

  copyToChannel(src: Float32Array, c: number, start = 0): void {
    this.getChannelData(c).set(src.subarray(0, this.length - start), start);
  }

  copyFromChannel(dst: Float32Array, c: number, start = 0): void {
    dst.set(this.getChannelData(c).subarray(start, start + dst.length));
  }
}

/** Buffer rempli par une fonction (canal, index) -> échantillon. */
export function makeBuffer(
  numberOfChannels: number,
  length: number,
  sampleRate = 44100,
  fill: (ch: number, i: number) => number = (ch, i) => Math.sin(i / 10 + ch) * 0.5,
): AudioBuffer {
  const b = new FakeAudioBuffer({ numberOfChannels, length, sampleRate });
  for (let c = 0; c < numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < length; i++) d[i] = fill(c, i);
  }
  return b as unknown as AudioBuffer;
}

const readTag = (v: DataView, off: number) =>
  String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));

export interface ParsedWav {
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  riffSize: number;
  dataOffset: number;
  dataSize: number;
}

/** Lit les en-têtes d'un WAV (parcours des blocs RIFF). */
export function parseWavHeader(ab: ArrayBuffer): ParsedWav {
  const v = new DataView(ab);
  if (ab.byteLength < 12 || readTag(v, 0) !== 'RIFF' || readTag(v, 8) !== 'WAVE') throw new Error('Pas un fichier RIFF/WAVE');
  let off = 12;
  let fmt: Omit<ParsedWav, 'riffSize' | 'dataOffset' | 'dataSize'> | null = null;
  while (off + 8 <= ab.byteLength) {
    const id = readTag(v, off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const format = v.getUint16(off + 8, true);
      if (format !== 1) throw new Error(`Format WAV non PCM (${format})`);
      fmt = {
        numChannels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        byteRate: v.getUint32(off + 16, true),
        blockAlign: v.getUint16(off + 20, true),
        bitsPerSample: v.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('Bloc data avant fmt');
      if (off + 8 + size > ab.byteLength) throw new Error('Bloc data tronqué');
      return { ...fmt, riffSize: v.getUint32(4, true), dataOffset: off + 8, dataSize: size };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('Bloc data introuvable');
}

/** Décodage WAV PCM 16 bits -> FakeAudioBuffer (comme decodeAudioData). */
export function decodeWav(ab: ArrayBuffer): AudioBuffer {
  const h = parseWavHeader(ab);
  if (h.bitsPerSample !== 16) throw new Error(`Seul le PCM 16 bits est géré (${h.bitsPerSample})`);
  if (h.blockAlign !== h.numChannels * 2) throw new Error('blockAlign incohérent');
  const frames = h.dataSize / h.blockAlign;
  if (!Number.isInteger(frames) || frames < 1) throw new Error('Taille de données incohérente');
  const v = new DataView(ab, h.dataOffset, h.dataSize);
  const b = new FakeAudioBuffer({ numberOfChannels: h.numChannels, length: frames, sampleRate: h.sampleRate });
  for (let c = 0; c < h.numChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < frames; i++) d[i] = v.getInt16((i * h.numChannels + c) * 2, true) / 32768;
  }
  return b as unknown as AudioBuffer;
}

/** AudioContext réduit à ce qu'utilisent la sauvegarde, la collab et les rendus. */
export class FakeAudioContext {
  constructor(public sampleRate = 44100) {}
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new FakeAudioBuffer({ numberOfChannels, length, sampleRate }) as unknown as AudioBuffer;
  }
  async decodeAudioData(ab: ArrayBuffer): Promise<AudioBuffer> {
    return decodeWav(ab);
  }
}

/** Contenu binaire d'un Blob (Node ou jsdom). */
export async function blobBytes(b: Blob): Promise<ArrayBuffer> {
  if (typeof (b as any).arrayBuffer === 'function') return (b as any).arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(b);
  });
}
