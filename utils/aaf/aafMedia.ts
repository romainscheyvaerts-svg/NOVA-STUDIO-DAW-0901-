/**
 * Médias d'un AAF : décodage des sons intégrés (PCM brut, WAVE ou AIFF complets) et
 * des fichiers liés (WAV / BWF / AIFF), et recherche des fichiers liés par leur nom.
 * Module pur : tests/aafRead.test.ts.
 */

export interface PcmAudio { channels: Float32Array[]; sampleRate: number; bits: number }

export interface WaveFormat { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number }

const ascii = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.subarray(at, at + n));

/** Échantillons entiers petit-boutistes (ou flottants 32/64) → canaux en flottant. */
export function decodePcm(data: Uint8Array, channels: number, bits: number, opts: { float?: boolean; bigEndian?: boolean } = {}): Float32Array[] {
  const bytes = Math.max(1, bits >> 3);
  const frame = bytes * channels;
  const n = frame > 0 ? Math.floor(data.length / frame) : 0;
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = !opts.bigEndian;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const o = i * frame + c * bytes;
      let v: number;
      if (opts.float) v = bytes === 8 ? dv.getFloat64(o, le) : dv.getFloat32(o, le);
      else if (bytes === 1) v = (data[o] - 128) / 128;
      else if (bytes === 2) v = dv.getInt16(o, le) / 32768;
      else if (bytes === 3) {
        const x = le ? (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) : ((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
        v = ((x << 8) >> 8) / 8388608;
      } else v = dv.getInt32(o, le) / 2147483648;
      out[c][i] = v;
    }
  }
  return out;
}

/** Chunk « fmt » d'un en-tête RIFF/WAVE (fichier complet ou résumé WAVEDescriptor). */
export function parseWaveFormat(b: Uint8Array): WaveFormat | null {
  if (b.length < 12 || ascii(b, 0) !== 'RIFF' || ascii(b, 8) !== 'WAVE') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = ascii(b, at);
    const size = dv.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 8 + 16 <= b.length) {
      let format = dv.getUint16(at + 8, true);
      const bits = dv.getUint16(at + 22, true);
      if (format === 0xfffe && size >= 40 && at + 8 + 26 <= b.length) format = dv.getUint16(at + 8 + 24, true);
      return { format, channels: dv.getUint16(at + 10, true), sampleRate: dv.getUint32(at + 12, true), bits, blockAlign: dv.getUint16(at + 20, true) };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** Fichier WAV / BWF complet → canaux. */
export function decodeWav(b: Uint8Array): PcmAudio | null {
  const fmt = parseWaveFormat(b);
  if (!fmt) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = ascii(b, at);
    let size = dv.getUint32(at + 4, true);
    if (id === 'data') {
      size = Math.min(size, b.length - at - 8);
      const data = b.subarray(at + 8, at + 8 + size);
      return { channels: decodePcm(data, fmt.channels, fmt.bits, { float: fmt.format === 3 }), sampleRate: fmt.sampleRate, bits: fmt.bits };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** Flottant étendu 80 bits (fréquence des AIFF). */
function ieee80(b: Uint8Array, at: number): number {
  const exp = ((b[at] & 0x7f) << 8) | b[at + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[at + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  return (b[at] & 0x80 ? -1 : 1) * mant * Math.pow(2, exp - 16383 - 63);
}

export interface AiffFormat { channels: number; sampleRate: number; bits: number; frames: number; compression: string }

export function parseAiffFormat(b: Uint8Array): AiffFormat | null {
  if (b.length < 12 || ascii(b, 0) !== 'FORM' || !/^AIF[FC]$/.test(ascii(b, 8))) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = ascii(b, at);
    const size = dv.getUint32(at + 4, false);
    if (id === 'COMM' && at + 26 <= b.length) {
      return {
        channels: dv.getInt16(at + 8, false), frames: dv.getUint32(at + 10, false), bits: dv.getInt16(at + 14, false),
        sampleRate: Math.round(ieee80(b, at + 16)), compression: size >= 22 && at + 30 <= b.length ? ascii(b, at + 26) : 'NONE',
      };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

export function decodeAiff(b: Uint8Array): PcmAudio | null {
  const fmt = parseAiffFormat(b);
  if (!fmt) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = ascii(b, at);
    const size = dv.getUint32(at + 4, false);
    if (id === 'SSND') {
      const off = dv.getUint32(at + 8, false);
      const data = b.subarray(at + 16 + off, Math.min(b.length, at + 8 + size));
      const comp = fmt.compression.toLowerCase();
      return {
        channels: decodePcm(data, fmt.channels, fmt.bits, { bigEndian: comp !== 'sowt', float: comp === 'fl32' || comp === 'fl64' }),
        sampleRate: fmt.sampleRate, bits: fmt.bits,
      };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** Son complet (WAV, BWF, AIFF) quel que soit son type. */
export function decodeAudioFile(b: Uint8Array): PcmAudio | null {
  return decodeWav(b) || decodeAiff(b);
}

/** Nom de fichier d'un localisateur (« file:///C:/…/Audio%20Files/Voix_01.wav » → « Voix_01.wav »). */
export function fileNameOfUrl(url: string): string {
  let s = url.replace(/^file:\/*/i, '').replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch { /* garder tel quel */ }
  return s.split('/').filter(Boolean).pop() || s;
}

const stem = (n: string) => n.toLowerCase().replace(/\.(wav|wave|bwf|aif|aiff|aifc)$/i, '');

/**
 * Fichier lié retrouvé parmi ceux choisis par l'utilisateur : même nom (sans tenir
 * compte de la casse), puis même nom sans extension.
 */
export function matchLinkedFile<F extends { name: string }>(wanted: string, files: F[]): F | null {
  const w = wanted.toLowerCase();
  return files.find(f => f.name.toLowerCase() === w) || files.find(f => stem(f.name) === stem(wanted)) || null;
}
