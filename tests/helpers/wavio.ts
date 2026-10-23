/** Lecture / écriture WAV minimales (PCM 16/24/32 bits, float 32) pour les mesures. */
import { readFileSync, writeFileSync } from 'fs';

export function readWav(path: string): { sr: number; ch: Float32Array[] } {
  const b = readFileSync(path);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12, fmt = 1, nch = 1, sr = 44100, bits = 16, dataOff = -1, dataLen = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') { fmt = dv.getUint16(p + 8, true); nch = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); bits = dv.getUint16(p + 22, true); if (fmt === 0xfffe) fmt = dv.getUint16(p + 32, true); }
    if (id === 'data') { dataOff = p + 8; dataLen = Math.min(len, b.length - p - 8); break; }
    p += 8 + len + (len & 1);
  }
  const bps = bits / 8, n = Math.floor(dataLen / (bps * nch));
  const ch = Array.from({ length: nch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const o = dataOff + (i * nch + c) * bps;
    let v: number;
    if (fmt === 3) v = dv.getFloat32(o, true);
    else if (bits === 16) v = dv.getInt16(o, true) / 32768;
    else if (bits === 24) { let x = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
    else v = dv.getInt32(o, true) / 2147483648;
    ch[c][i] = v;
  }
  return { sr, ch };
}

/** WAV float 32 bits (aucune perte : les mesures relues sont celles du rendu). */
export function writeWav(path: string, sr: number, ch: Float32Array[]) {
  const n = ch[0].length, nch = ch.length;
  const b = Buffer.alloc(44 + n * nch * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nch * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(nch, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * nch * 4, 28); b.writeUInt16LE(nch * 4, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * nch * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { b.writeFloatLE(ch[c][i], o); o += 4; }
  writeFileSync(path, b);
}
