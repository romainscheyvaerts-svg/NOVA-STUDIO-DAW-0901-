/**
 * FLAC (Free Lossless Audio Codec) écrit en TypeScript, sans service ni wasm :
 * l'export « FLAC » de Logic, Ableton et FL, en local et gratuit.
 *
 * Encodeur : blocs de 4096 échantillons, sous-trames CONSTANT, FIXED (ordres 0
 * à 4, choisi par la plus petite somme des résidus, comme libFLAC en mode
 * rapide) ou VERBATIM, codage de Rice partitionné (ordre de partition choisi
 * par estimation), décorrélation stéréo gauche / côté quand elle gagne, CRC-8
 * d'en-tête et CRC-16 de trame. Métadonnées : STREAMINFO (avec la signature
 * MD5 des échantillons), VORBIS_COMMENT (TITLE, ARTIST, BPM, INITIALKEY, ISRC…)
 * et PICTURE (pochette).
 * Décodeur : de quoi relire les fichiers de NOVA et ceux de libFLAC (LPC compris),
 * pour les tests d'aller-retour bit à bit.
 *
 * Référence : RFC 9639 (FLAC), 2024.
 */
import type { AudioMeta } from './audioFormats';
import { describe, quantize } from './audioFormats';
import { md5 } from './md5';

export type FlacBits = 16 | 24;

// --- CRC ------------------------------------------------------------------------------

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; t[i] = c; }
  return t;
})();
const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; t[i] = c; }
  return t;
})();
export const crc8 = (b: Uint8Array, from: number, to: number) => { let c = 0; for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]; return c; };
export const crc16 = (b: Uint8Array, from: number, to: number) => { let c = 0; for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

// --- Écriture de bits -------------------------------------------------------------

class BitWriter {
  buf: Uint8Array;
  pos = 0;      // octets complets
  acc = 0;      // bits en attente (au plus 31)
  nacc = 0;
  constructor(cap = 1 << 20) { this.buf = new Uint8Array(cap); }
  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
  }
  /** Écrit les `n` bits de poids faible de `v` (n ≤ 24 par appel). */
  private put(v: number, n: number) {
    this.acc = (this.acc << n) | (v & ((1 << n) - 1));
    this.nacc += n;
    while (this.nacc >= 8) {
      this.nacc -= 8;
      this.buf[this.pos++] = (this.acc >>> this.nacc) & 0xff;
    }
    this.acc &= (1 << this.nacc) - 1;
  }
  bits(v: number, n: number) {
    this.ensure(8);
    if (n <= 24) { this.put(v, n); return; }
    // jusqu'à 36 bits (nombre total d'échantillons) : en deux morceaux
    const hi = Math.floor(v / 2 ** 24);
    this.put(hi, n - 24);
    this.put(v - hi * 2 ** 24, 24);
  }
  signed(v: number, n: number) { this.bits(n >= 32 ? v >>> 0 : (v < 0 ? v + 2 ** n : v), n); }
  zeros(n: number) {
    this.ensure((n >> 3) + 8);
    while (n >= 24) { this.put(0, 24); n -= 24; }
    if (n) this.put(0, n);
  }
  alignByte() { if (this.nacc) this.put(0, 8 - this.nacc); }
  bytes(b: Uint8Array) { this.alignByte(); this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  out() { this.alignByte(); return this.buf.slice(0, this.pos); }
}

// --- Encodage -------------------------------------------------------------------------

const BLOCK = 4096;
const SR_CODES: Record<number, number> = { 88200: 0b0001, 176400: 0b0010, 192000: 0b0011, 8000: 0b0100, 16000: 0b0101, 22050: 0b0110, 24000: 0b0111, 32000: 0b1000, 44100: 0b1001, 48000: 0b1010, 96000: 0b1011 };
const BPS_CODES: Record<number, number> = { 8: 0b001, 12: 0b010, 16: 0b100, 20: 0b101, 24: 0b110, 32: 0b111 };

function fixedResidual(x: Int32Array | Float64Array, order: number, out: Float64Array): void {
  const n = x.length;
  for (let i = order; i < n; i++) {
    let r: number;
    switch (order) {
      case 0: r = x[i]; break;
      case 1: r = x[i] - x[i - 1]; break;
      case 2: r = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    out[i - order] = r;
  }
}

/** Codage de Rice partitionné d'un résidu (ordre de partition et paramètres choisis ici). */
function writeResidual(w: BitWriter, res: Float64Array, len: number, blockSize: number, predOrder: number) {
  // Valeurs repliées (zigzag) et sommes préfixes pour estimer chaque ordre de partition.
  const u = new Float64Array(len);
  for (let i = 0; i < len; i++) { const r = res[i]; u[i] = r >= 0 ? 2 * r : -2 * r - 1; }
  const prefix = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + u[i];
  const paramFor = (sum: number, n: number) => {
    if (n <= 0) return 0;
    const mean = sum / n;
    return mean < 1 ? 0 : Math.min(30, Math.floor(Math.log2(mean)));
  };
  let bestOrder = 0, bestBits = Infinity;
  for (let po = 0; po <= 8; po++) {
    if (blockSize % (1 << po)) break;
    const part = blockSize >> po;
    if (part <= predOrder) break;
    let bits = 0, start = 0;
    for (let p = 0; p < (1 << po); p++) {
      const n = p === 0 ? part - predOrder : part;
      const sum = prefix[start + n] - prefix[start];
      const k = paramFor(sum, n);
      bits += 5 + n * (k + 1) + sum / 2 ** k;
      start += n;
    }
    if (bits < bestBits) { bestBits = bits; bestOrder = po; }
  }
  const parts = 1 << bestOrder;
  const part = blockSize >> bestOrder;
  // Paramètres exacts : on teste k−1, k, k+1 en comptant les bits réels.
  const params: number[] = [];
  let start = 0;
  for (let p = 0; p < parts; p++) {
    const n = p === 0 ? part - predOrder : part;
    const k0 = paramFor(prefix[start + n] - prefix[start], n);
    let bk = k0, bb = Infinity;
    for (const k of [k0 - 1, k0, k0 + 1]) {
      if (k < 0 || k > 30) continue;
      let b = n * (k + 1);
      const d = 2 ** k;
      for (let i = start; i < start + n; i++) b += Math.floor(u[i] / d);
      if (b < bb) { bb = b; bk = k; }
    }
    params.push(bk);
    start += n;
  }
  const method = params.some(k => k > 14) ? 1 : 0;
  w.bits(method, 2);
  w.bits(bestOrder, 4);
  start = 0;
  for (let p = 0; p < parts; p++) {
    const n = p === 0 ? part - predOrder : part;
    const k = params[p];
    w.bits(k, method ? 5 : 4);
    const d = 2 ** k;
    for (let i = start; i < start + n; i++) {
      const v = u[i];
      const q = Math.floor(v / d);
      if (q) w.zeros(q);
      w.bits(1, 1);
      if (k) w.bits(v - q * d, k);
    }
    start += n;
  }
}

/** Taille approximative (bits) d'une sous-trame fixe (somme des résidus repliés). */
function fixedCost(x: Int32Array | Float64Array, order: number, scratch: Float64Array): number {
  fixedResidual(x, order, scratch);
  let s = 0;
  const n = x.length - order;
  for (let i = 0; i < n; i++) s += Math.abs(scratch[i]);
  return s;
}

function writeSubframe(w: BitWriter, x: Float64Array, bps: number, scratch: Float64Array) {
  const n = x.length;
  // Constante (silence, DC)
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) { w.bits(0, 1); w.bits(0, 6); w.bits(0, 1); w.signed(x[0], bps); return; }
  let best = 0, bestCost = Infinity;
  for (let o = 0; o <= Math.min(4, n - 1); o++) {
    const c = fixedCost(x, o, scratch);
    if (c < bestCost) { bestCost = c; best = o; }
  }
  // Estimation grossière : si le résidu moyen dépasse la résolution, VERBATIM.
  const meanRes = bestCost / Math.max(1, n - best);
  const estBits = n * (Math.max(0, Math.log2(meanRes + 1)) + 2);
  if (estBits >= n * bps) {
    w.bits(0, 1); w.bits(1, 6); w.bits(0, 1);
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }
  w.bits(0, 1); w.bits(0b001000 | best, 6); w.bits(0, 1);
  for (let i = 0; i < best; i++) w.signed(x[i], bps);
  fixedResidual(x, best, scratch);
  writeResidual(w, scratch, n - best, n, best);
}

function utf8Number(v: number): number[] {
  if (v < 0x80) return [v];
  const out: number[] = [];
  let n = 1; while (v >= 2 ** (5 * n + 6) && n < 6) n++;
  // n octets de continuation
  for (let i = 0; i < n; i++) { out.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); }
  const lead = (0xff << (7 - n)) & 0xff;
  out.unshift(lead | v);
  return out;
}

function vorbisComment(meta: AudioMeta | undefined): Uint8Array {
  const enc = new TextEncoder();
  const vendor = enc.encode('NOVA Studio FLAC');
  const tags: string[] = [];
  if (meta) {
    if (meta.title) tags.push(`TITLE=${meta.title}`);
    if (meta.artist) tags.push(`ARTIST=${meta.artist}`);
    if (meta.album) tags.push(`ALBUM=${meta.album}`);
    if (meta.genre) tags.push(`GENRE=${meta.genre}`);
    if (meta.bpm) tags.push(`BPM=${Math.round(meta.bpm * 100) / 100}`);
    if (meta.keyId3) tags.push(`INITIALKEY=${meta.keyId3}`);
    if (meta.key) tags.push(`KEY=${meta.key}`);
    if (meta.isrc) tags.push(`ISRC=${meta.isrc}`);
    const c = meta.comment ?? describe(meta);
    if (c) tags.push(`COMMENT=${c}`);
    tags.push(`DATE=${(meta.date || new Date()).toISOString().slice(0, 10)}`);
    tags.push(`ENCODER=${meta.software || 'NOVA Studio'}`);
  }
  const parts = tags.map(t => enc.encode(t));
  const size = 4 + vendor.length + 4 + parts.reduce((s, p) => s + 4 + p.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, vendor.length, true); o += 4; out.set(vendor, o); o += vendor.length;
  dv.setUint32(o, parts.length, true); o += 4;
  for (const p of parts) { dv.setUint32(o, p.length, true); o += 4; out.set(p, o); o += p.length; }
  return out;
}

function pictureBlock(cover: { mime: string; data: Uint8Array }): Uint8Array {
  const mime = new TextEncoder().encode(cover.mime);
  const out = new Uint8Array(32 + mime.length + cover.data.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, 3); o += 4;                      // couverture (recto)
  dv.setUint32(o, mime.length); o += 4; out.set(mime, o); o += mime.length;
  dv.setUint32(o, 0); o += 4;                      // description vide
  dv.setUint32(o, 0); o += 4; dv.setUint32(o, 0); o += 4; dv.setUint32(o, 0); o += 4; dv.setUint32(o, 0); o += 4;
  dv.setUint32(o, cover.data.length); o += 4; out.set(cover.data, o);
  return out;
}

/** Octets PCM petit-boutiste entrelacés (signature MD5 de STREAMINFO, comme libFLAC). */
function pcmBytes(ints: Int32Array[], bps: number): Uint8Array {
  const n = ints[0]?.length || 0;
  const bb = bps / 8;
  const out = new Uint8Array(n * ints.length * bb);
  let o = 0;
  for (let i = 0; i < n; i++) for (const c of ints) {
    const v = c[i];
    for (let k = 0; k < bb; k++) out[o++] = (v >> (8 * k)) & 0xff;
  }
  return out;
}

/** Encode des entiers déjà quantifiés (aller-retour bit à bit). */
export function encodeFlacInts(ints: Int32Array[], sampleRate: number, bps: FlacBits, meta?: AudioMeta): Uint8Array {
  const nc = ints.length;
  if (nc < 1 || nc > 8) throw new Error('FLAC : 1 à 8 canaux');
  const total = ints[0].length;
  const w = new BitWriter(Math.max(1 << 16, total * nc * (bps / 8) + 65536));
  w.bytes(new Uint8Array([0x66, 0x4c, 0x61, 0x43])); // « fLaC »
  const blocks: { type: number; data: Uint8Array }[] = [];
  // STREAMINFO
  const si = new BitWriter(64);
  si.bits(Math.min(BLOCK, Math.max(16, total)), 16); si.bits(BLOCK, 16);
  si.bits(0, 24); si.bits(0, 24);
  si.bits(sampleRate, 20); si.bits(nc - 1, 3); si.bits(bps - 1, 5); si.bits(total, 36);
  si.bytes(md5(pcmBytes(ints, bps)));
  blocks.push({ type: 0, data: si.out() });
  blocks.push({ type: 4, data: vorbisComment(meta) });
  if (meta?.cover?.data.length) blocks.push({ type: 6, data: pictureBlock(meta.cover) });
  blocks.forEach((b, i) => {
    w.bits(i === blocks.length - 1 ? 1 : 0, 1); w.bits(b.type, 7); w.bits(b.data.length, 24);
    w.bytes(b.data);
  });

  const srCode = SR_CODES[sampleRate] ?? 0;
  const bpsCode = BPS_CODES[bps] ?? 0;
  const scratch = new Float64Array(BLOCK);
  const chBuf = Array.from({ length: Math.max(2, nc) }, () => new Float64Array(BLOCK));
  let frame = 0;
  for (let start = 0; start < total; start += BLOCK, frame++) {
    const n = Math.min(BLOCK, total - start);
    for (let c = 0; c < nc; c++) { const src = ints[c]; const dst = chBuf[c]; for (let i = 0; i < n; i++) dst[i] = src[start + i]; }
    const views = chBuf.map(b => b.subarray(0, n));
    // Stéréo : gauche / côté (côté = G − D, un bit de plus) si le côté coûte moins que la droite.
    let assignment = nc - 1;
    let side: Float64Array | null = null;
    if (nc === 2 && n > 8) {
      side = new Float64Array(n);
      for (let i = 0; i < n; i++) side[i] = views[0][i] - views[1][i];
      const costR = Math.min(fixedCost(views[1], 1, scratch), fixedCost(views[1], 2, scratch));
      const costS = Math.min(fixedCost(side, 1, scratch), fixedCost(side, 2, scratch));
      if (costS < costR * 0.9) assignment = 0b1000; else side = null;
    }
    const frameStart = w.pos;
    w.alignByte();
    w.bits(0b11111111111110, 14); w.bits(0, 1); w.bits(0, 1);
    const bsCode = n === BLOCK ? 0b1100 : 0b0111;
    w.bits(bsCode, 4); w.bits(srCode, 4);
    w.bits(assignment, 4); w.bits(bpsCode, 3); w.bits(0, 1);
    for (const b of utf8Number(frame)) w.bits(b, 8);
    if (bsCode === 0b0111) w.bits(n - 1, 16);
    w.alignByte();
    w.bits(crc8(w.buf, frameStart, w.pos), 8);
    for (let c = 0; c < nc; c++) {
      if (c === 1 && side) writeSubframe(w, side, bps + 1, scratch);
      else writeSubframe(w, views[c], bps, scratch);
    }
    w.alignByte();
    w.bits(crc16(w.buf, frameStart, w.pos), 16);
  }
  return w.out();
}

/** Encode des canaux flottants (−1…1) en FLAC 16 ou 24 bits. */
export function encodeFlac(chs: Float32Array[], sampleRate: number, bps: FlacBits, meta?: AudioMeta): Uint8Array {
  const ints = chs.map(c => { const o = new Int32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = quantize(c[i], bps); return o; });
  return encodeFlacInts(ints, sampleRate, bps, meta);
}

// --- Décodage -------------------------------------------------------------------------

class BitReader {
  pos = 0; // en bits
  constructor(public b: Uint8Array) {}
  bit(): number { const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return v; }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (!(this.pos & 7) && n - i >= 8) { v = v * 256 + this.b[this.pos >> 3]; this.pos += 8; i += 7; continue; }
      v = v * 2 + this.bit();
    }
    return v;
  }
  signed(n: number): number { const v = this.bits(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  unary(): number { let q = 0; while (this.bit() === 0) q++; return q; }
  align() { this.pos = (this.pos + 7) & ~7; }
  get byte() { return this.pos >> 3; }
}

export interface FlacDecoded {
  sampleRate: number;
  bps: number;
  channels: Int32Array[];
  tags: Record<string, string>;
  picture?: { mime: string; size: number };
  md5: Uint8Array;
  /** Nombre de trames dont le CRC-16 était faux (0 attendu). */
  crcErrors: number;
}

export function decodeFlac(bytes: Uint8Array): FlacDecoded {
  if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) throw new Error('Pas un FLAC');
  let p = 4;
  let sampleRate = 0, nc = 0, bps = 0, total = 0;
  let md5sig = new Uint8Array(16);
  const tags: Record<string, string> = {};
  let picture: { mime: string; size: number } | undefined;
  for (;;) {
    const last = bytes[p] >> 7, type = bytes[p] & 0x7f;
    const len = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const body = bytes.subarray(p + 4, p + 4 + len);
    if (type === 0) {
      const r = new BitReader(body);
      r.bits(16); r.bits(16); r.bits(24); r.bits(24);
      sampleRate = r.bits(20); nc = r.bits(3) + 1; bps = r.bits(5) + 1; total = r.bits(36);
      md5sig = body.slice(18, 34);
    } else if (type === 4) {
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      let o = 4 + dv.getUint32(0, true);
      const count = dv.getUint32(o, true); o += 4;
      const dec = new TextDecoder();
      for (let i = 0; i < count; i++) {
        const l = dv.getUint32(o, true); o += 4;
        const s = dec.decode(body.subarray(o, o + l)); o += l;
        const eq = s.indexOf('=');
        if (eq > 0) tags[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1);
      }
    } else if (type === 6) {
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const ml = dv.getUint32(4);
      const mime = new TextDecoder().decode(body.subarray(8, 8 + ml));
      let o = 8 + ml; const dl = dv.getUint32(o); o += 4 + dl + 16;
      picture = { mime, size: dv.getUint32(o) };
    }
    p += 4 + len;
    if (last) break;
  }
  const out = Array.from({ length: nc }, () => new Int32Array(total));
  const r = new BitReader(bytes);
  r.pos = p * 8;
  let written = 0;
  let crcErrors = 0;
  const srTable: Record<number, number> = Object.fromEntries(Object.entries(SR_CODES).map(([k, v]) => [v, Number(k)]));
  const bpsTable: Record<number, number> = Object.fromEntries(Object.entries(BPS_CODES).map(([k, v]) => [v, Number(k)]));
  while (written < total && r.byte < bytes.length - 2) {
    const frameStart = r.byte;
    const sync = r.bits(14);
    if (sync !== 0b11111111111110) throw new Error(`FLAC : synchro perdue à l'octet ${frameStart}`);
    r.bits(1); r.bits(1);
    const bsCode = r.bits(4), srCode = r.bits(4), chAssign = r.bits(4), bpsCode = r.bits(3); r.bits(1);
    // numéro (UTF-8)
    let first = r.bits(8);
    let extra = 0; while (first & 0x80) { extra++; first = (first << 1) & 0xff; }
    for (let i = 1; i < extra; i++) r.bits(8);
    let n: number;
    if (bsCode === 0b0001) n = 192;
    else if (bsCode >= 0b0010 && bsCode <= 0b0101) n = 576 << (bsCode - 2);
    else if (bsCode === 0b0110) n = r.bits(8) + 1;
    else if (bsCode === 0b0111) n = r.bits(16) + 1;
    else n = 256 << (bsCode - 8);
    if (srCode === 0b1100) r.bits(8); else if (srCode === 0b1101 || srCode === 0b1110) r.bits(16);
    void srTable;
    const fbps = bpsCode === 0 ? bps : bpsTable[bpsCode];
    const hdrEnd = r.byte;
    const c8 = r.bits(8);
    if (c8 !== crc8(bytes, frameStart, hdrEnd)) crcErrors++;
    const chans: number[][] = [];
    const nch = chAssign < 8 ? chAssign + 1 : 2;
    for (let c = 0; c < nch; c++) {
      const sbps = fbps + ((chAssign === 0b1000 && c === 1) || (chAssign === 0b1001 && c === 0) || (chAssign === 0b1010 && c === 1) ? 1 : 0);
      chans.push(readSubframe(r, n, sbps));
    }
    r.align();
    const crcPos = r.byte;
    const c16 = r.bits(16);
    if (c16 !== crc16(bytes, frameStart, crcPos)) crcErrors++;
    for (let i = 0; i < n; i++) {
      let a = chans[0][i], b = chans[1]?.[i];
      if (chAssign === 0b1000) b = a - b;
      else if (chAssign === 0b1001) a = a + b;
      else if (chAssign === 0b1010) { const mid = a * 2 + (b & 1); const s = b; a = (mid + s) >> 1; b = (mid - s) >> 1; }
      out[0][written + i] = a;
      if (nch > 1) out[1][written + i] = b;
      for (let c = 2; c < nch; c++) out[c][written + i] = chans[c][i];
    }
    written += n;
  }
  return { sampleRate, bps, channels: out, tags, picture, md5: md5sig, crcErrors };
}

function readResidual(r: BitReader, n: number, order: number, out: number[]) {
  const method = r.bits(2);
  const po = r.bits(4);
  const pbits = method === 1 ? 5 : 4;
  const esc = method === 1 ? 31 : 15;
  const parts = 1 << po;
  for (let p = 0; p < parts; p++) {
    const cnt = p === 0 ? (n >> po) - order : (n >> po);
    const k = r.bits(pbits);
    if (k === esc) {
      const raw = r.bits(5);
      for (let i = 0; i < cnt; i++) out.push(raw ? r.signed(raw) : 0);
    } else {
      for (let i = 0; i < cnt; i++) {
        const q = r.unary();
        const u = q * 2 ** k + (k ? r.bits(k) : 0);
        out.push(u % 2 === 0 ? u / 2 : -(u + 1) / 2);
      }
    }
  }
}

function readSubframe(r: BitReader, n: number, bps: number): number[] {
  r.bit();
  const type = r.bits(6);
  let wasted = 0;
  if (r.bit()) { wasted = 1; while (r.bit() === 0) wasted++; }
  const b = bps - wasted;
  let x: number[] = [];
  if (type === 0) { const v = r.signed(b); x = new Array(n).fill(v); }
  else if (type === 1) { for (let i = 0; i < n; i++) x.push(r.signed(b)); }
  else if (type >= 8 && type <= 12) {
    const order = type & 7;
    for (let i = 0; i < order; i++) x.push(r.signed(b));
    const res: number[] = [];
    readResidual(r, n, order, res);
    for (let i = order; i < n; i++) {
      const e = res[i - order];
      let pred = 0;
      if (order === 1) pred = x[i - 1];
      else if (order === 2) pred = 2 * x[i - 1] - x[i - 2];
      else if (order === 3) pred = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
      else if (order === 4) pred = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
      x.push(pred + e);
    }
  } else if (type >= 32) {
    const order = (type & 31) + 1;
    for (let i = 0; i < order; i++) x.push(r.signed(b));
    const prec = r.bits(4) + 1;
    const shift = r.signed(5);
    const coefs: number[] = [];
    for (let i = 0; i < order; i++) coefs.push(r.signed(prec));
    const res: number[] = [];
    readResidual(r, n, order, res);
    for (let i = order; i < n; i++) {
      let s = 0;
      for (let j = 0; j < order; j++) s += coefs[j] * x[i - 1 - j];
      x.push(Math.floor(s / 2 ** shift) + res[i - order]);
    }
  } else throw new Error(`FLAC : sous-trame ${type} inconnue`);
  if (wasted) x = x.map(v => v * 2 ** wasted);
  return x;
}
