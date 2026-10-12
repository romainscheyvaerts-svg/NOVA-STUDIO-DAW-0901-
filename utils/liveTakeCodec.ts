/**
 * Prise envoyée pendant l'enregistrement (B3) : codage SANS PERTE d'un morceau de prise.
 *
 * Ce qui voyage est exactement le fichier de la prise : PCM 24 bits (même arrondi que
 * engine/NovaRecorder.encodeWav24, le WAV de la prise gardé dans le projet). Avant,
 * l'ingé recevait un WAV 16 bits (wavOf) : 8 bits de moins que la prise.
 *
 * Méthode (celle de FLAC, sans dépendance ; WebCodecs ne sait pas encoder le FLAC) :
 *  - bits inutilisés retirés (une source 16 bits ne coûte que 16 bits) ;
 *  - stéréo : gauche + différence (droite − gauche) quand c'est moins cher (micro mono
 *    sur une entrée stéréo : la différence est nulle, elle ne coûte presque rien) ;
 *  - prédiction polynomiale d'ordre 0 à 4 (la meilleure, canal par canal) ;
 *  - résidus codés en Rice par paquets de 1024 échantillons, avec échappement pour les pics ;
 *  - repli « tel quel » (octets 24 bits) si le codage ne gagne rien (bruit pur).
 * Chaque morceau porte la somme de contrôle (CRC-32) de ses octets PCM 24 bits : le
 * décodage la vérifie, un morceau abîmé est refusé.
 */

export const LT_VERSION = 1;
/** « NLT1 » */
const MAGIC = [0x4e, 0x4c, 0x54, 0x31];
const HEADER = 20;
const PART = 1024;
/** Quotient Rice au-delà duquel la valeur est écrite telle quelle (pics). */
const ESC = 24;
const RAW_BITS = 31;
const MAX_ORDER = 4;
/** Paramètre Rice réservé : paquet entièrement nul. */
const ZERO_PART = 31;

// --- Quantification (identique au WAV 24 bits de la prise) -------------------------------

/** Échantillon flottant → entier 24 bits, exactement comme encodeWav24. */
export const toInt24 = (x: number): number => {
  const v = x > 1 ? 1 : x < -1 ? -1 : (x || 0);
  return Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
};
/** Entier 24 bits → flottant, comme le décodage d'un WAV 24 bits par le navigateur. */
export const fromInt24 = (s: number): number => s / 0x800000;

// --- CRC-32 (au fil de l'eau) -------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 en continu : crc32Update(crc32Update(START, a), b) = CRC de a + b. */
export const CRC_START = 0xffffffff;
export const crc32Update = (crc: number, bytes: Uint8Array): number => {
  let c = crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
};
export const crc32Final = (crc: number): number => (crc ^ 0xffffffff) >>> 0;
export const crc32 = (bytes: Uint8Array): number => crc32Final(crc32Update(CRC_START, bytes));

/**
 * Somme de contrôle d'échantillons 24 bits, au fil de l'eau, sur les octets PCM entrelacés
 * (petit-boutiste) : la même que celle des données d'un WAV 24 bits. `channels[c][i]`.
 */
export class Pcm24Crc {
  private crc = CRC_START;
  private tmp = new Uint8Array(3 * 4096);
  frames = 0;
  update(channels: ArrayLike<number>[], from = 0, to = channels[0]?.length ?? 0) {
    const nc = channels.length;
    const step = Math.max(1, Math.floor(4096 / nc));
    for (let i = from; i < to; i += step) {
      const end = Math.min(to, i + step);
      let o = 0;
      for (let k = i; k < end; k++) {
        for (let c = 0; c < nc; c++) {
          const s = channels[c][k];
          this.tmp[o] = s & 0xff; this.tmp[o + 1] = (s >> 8) & 0xff; this.tmp[o + 2] = (s >> 16) & 0xff;
          o += 3;
        }
      }
      this.crc = crc32Update(this.crc, this.tmp.subarray(0, o));
    }
    this.frames += Math.max(0, to - from);
    return this;
  }
  /** Mêmes échantillons, donnés en flottant (quantifiés en 24 bits au passage). */
  updateFloat(channels: Float32Array[], from = 0, to = channels[0]?.length ?? 0) {
    const nc = channels.length;
    const block = 4096;
    const ints = Array.from({ length: nc }, () => new Int32Array(block));
    for (let i = from; i < to; i += block) {
      const end = Math.min(to, i + block);
      for (let c = 0; c < nc; c++) for (let k = i; k < end; k++) ints[c][k - i] = toInt24(channels[c][k]);
      this.update(ints, 0, end - i);
    }
    return this;
  }
  value(): number { return crc32Final(this.crc); }
}

/** Somme de contrôle (texte court) d'une prise entière donnée en flottant. */
export const takeSum = (channels: Float32Array[], from = 0, frames?: number): string => {
  const to = frames === undefined ? (channels[0]?.length ?? 0) : Math.min(channels[0]?.length ?? 0, from + frames);
  const h = new Pcm24Crc().updateFloat(channels, from, to);
  return `${h.frames}:${h.value().toString(16).padStart(8, '0')}`;
};

// --- Écriture / lecture de bits ---------------------------------------------------------

class BitWriter {
  buf: Uint8Array;
  pos = 0;      // octets pleins écrits
  acc = 0;      // bits en attente (au plus 31)
  n = 0;
  constructor(size: number) { this.buf = new Uint8Array(Math.max(64, size)); }
  private grow(extra: number) {
    if (this.pos + extra + 8 <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 64));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  /** Écrit les `bits` bits de poids faible de v (bits ≤ 24). */
  private put(v: number, bits: number) {
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }
  write(v: number, bits: number) {
    this.grow(8);
    // Jusqu'à 32 bits, en deux fois.
    if (bits > 16) { this.put(Math.floor(v / 65536) & 0xffff, bits - 16); this.put(v & 0xffff, 16); } else if (bits > 0) this.put(v, bits);
  }
  zeros(count: number) {
    this.grow(Math.ceil(count / 8) + 1);
    while (count > 16) { this.put(0, 16); count -= 16; }
    if (count > 0) this.put(0, count);
  }
  bytes(): Uint8Array {
    if (this.n > 0) { this.grow(1); this.buf[this.pos++] = (this.acc << (8 - this.n)) & 0xff; this.acc = 0; this.n = 0; }
    return this.buf.subarray(0, this.pos);
  }
}

class BitReader {
  private pos: number;
  private bit = 0; // bits déjà lus dans l'octet courant
  constructor(private buf: Uint8Array, start: number) { this.pos = start; }
  readBit(): number {
    if (this.pos >= this.buf.length) throw new Error('Morceau de prise tronqué');
    const b = (this.buf[this.pos] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return b;
  }
  read(bits: number): number {
    let v = 0;
    while (bits > 0) {
      if (this.bit === 0 && bits >= 8) {
        if (this.pos >= this.buf.length) throw new Error('Morceau de prise tronqué');
        v = v * 256 + this.buf[this.pos++];
        bits -= 8;
      } else { v = v * 2 + this.readBit(); bits--; }
    }
    return v;
  }
}

// --- Codage d'un canal ------------------------------------------------------------------

const zig = (e: number) => (e >= 0 ? 2 * e : -2 * e - 1);
const unzig = (z: number) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Résidu d'ordre p (polynôme fixe) à l'indice i (i ≥ p). */
const residual = (x: ArrayLike<number>, i: number, p: number): number => {
  switch (p) {
    case 0: return x[i];
    case 1: return x[i] - x[i - 1];
    case 2: return x[i] - 2 * x[i - 1] + x[i - 2];
    case 3: return x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
    default: return x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
  }
};
const predict = (x: ArrayLike<number>, i: number, p: number): number => {
  switch (p) {
    case 0: return 0;
    case 1: return x[i - 1];
    case 2: return 2 * x[i - 1] - x[i - 2];
    case 3: return 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
    default: return 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
  }
};

/** Ordre de prédiction le moins coûteux (somme des |résidus|). */
const bestOrder = (x: ArrayLike<number>): { order: number; cost: number } => {
  const n = x.length;
  const s = [0, 0, 0, 0, 0];
  for (let i = MAX_ORDER; i < n; i++) {
    const a = x[i], b = x[i - 1], c = x[i - 2], d = x[i - 3], e = x[i - 4];
    s[0] += Math.abs(a);
    s[1] += Math.abs(a - b);
    s[2] += Math.abs(a - 2 * b + c);
    s[3] += Math.abs(a - 3 * b + 3 * c - d);
    s[4] += Math.abs(a - 4 * b + 6 * c - 4 * d + e);
  }
  let order = 0;
  for (let p = 1; p <= MAX_ORDER; p++) if (s[p] < s[order]) order = p;
  return { order: Math.min(order, Math.max(0, n - 1)), cost: s[order] };
};

const riceCost = (z: Float64Array, a: number, b: number, k: number): number => {
  let bits = 0;
  const div = 2 ** k;
  for (let i = a; i < b; i++) {
    const q = Math.floor(z[i] / div);
    bits += q >= ESC ? ESC + 1 + RAW_BITS : q + 1 + k;
  }
  return bits;
};

function encodeChannel(w: BitWriter, x: ArrayLike<number>) {
  const n = x.length;
  const { order } = bestOrder(x);
  w.write(order, 3);
  const warm = Math.min(order, n);
  for (let i = 0; i < warm; i++) w.write(zig(x[i]), 32);
  const m = n - warm;
  const z = new Float64Array(m);
  for (let i = warm; i < n; i++) z[i - warm] = zig(residual(x, i, order));
  for (let a = 0; a < m; a += PART) {
    const b = Math.min(m, a + PART);
    let sum = 0;
    for (let i = a; i < b; i++) sum += z[i];
    // Paquet entièrement nul (silence numérique, différence d'une stéréo « mono ») : 5 bits en tout.
    if (sum === 0) { w.write(ZERO_PART, 5); continue; }
    const mean = sum / (b - a);
    const k0 = mean > 1 ? Math.max(0, Math.min(30, Math.floor(Math.log2(mean * 0.69)))) : 0;
    let k = k0, best = riceCost(z, a, b, k0);
    for (const kk of [k0 - 2, k0 - 1, k0 + 1, k0 + 2]) {
      if (kk < 0 || kk > 30) continue;
      const c = riceCost(z, a, b, kk);
      if (c < best) { best = c; k = kk; }
    }
    w.write(k, 5);
    const div = 2 ** k;
    for (let i = a; i < b; i++) {
      const v = z[i];
      const q = Math.floor(v / div);
      if (q >= ESC) { w.zeros(ESC); w.write(1, 1); w.write(v, RAW_BITS); continue; }
      w.zeros(q);
      w.write(1, 1);
      if (k) w.write(v - q * div, k);
    }
  }
}

function decodeChannel(r: BitReader, n: number): Float64Array {
  const x = new Float64Array(n);
  const order = r.read(3);
  if (order > MAX_ORDER) throw new Error('Morceau de prise illisible (ordre)');
  const warm = Math.min(order, n);
  for (let i = 0; i < warm; i++) { const v = r.read(32); x[i] = unzig(v); }
  const m = n - warm;
  for (let a = 0; a < m; a += PART) {
    const b = Math.min(m, a + PART);
    const k = r.read(5);
    if (k === ZERO_PART) {
      for (let i = a; i < b; i++) { const idx = warm + i; x[idx] = predict(x, idx, order); }
      continue;
    }
    const div = 2 ** k;
    for (let i = a; i < b; i++) {
      let q = 0;
      while (q < ESC && r.readBit() === 0) q++;
      let z: number;
      if (q >= ESC) { r.readBit(); z = r.read(RAW_BITS); } else z = q * div + (k ? r.read(k) : 0);
      const idx = warm + i;
      x[idx] = unzig(z) + predict(x, idx, order);
    }
  }
  return x;
}

// --- Morceau complet --------------------------------------------------------------------

export interface DecodedSegment {
  /** Échantillons 24 bits, un tableau par canal. */
  ints: Int32Array[];
  frames: number;
  channels: number;
  crc: number;
}

/** Nombre de bits de poids faible nuls dans TOUS les échantillons (source 16 bits : 8). */
const wastedBits = (chs: Int32Array[]): number => {
  let or = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { or |= c[i]; if (or & 1) return 0; }
  if (or === 0) return 0;
  let s = 0;
  while (s < 23 && !(or & (1 << s))) s++;
  return s;
};

/**
 * Code un morceau (échantillons 24 bits, un tableau par canal, même longueur).
 * Sans perte : decodeSegment(encodeSegment(x)).ints === x, au bit près.
 */
export function encodeSegment(chs: Int32Array[]): Uint8Array {
  const nc = chs.length;
  if (nc < 1 || nc > 8) throw new Error('Morceau de prise : 1 à 8 canaux');
  const n = chs[0].length;
  const crc = new Pcm24Crc().update(chs).value();
  const shift = wastedBits(chs);
  const div = 2 ** shift;
  let planes: ArrayLike<number>[] = chs.map(c => (shift ? Float64Array.from(c, v => v / div) : c));
  let stereo = 0;
  if (nc === 2) {
    const side = new Float64Array(n);
    for (let i = 0; i < n; i++) side[i] = planes[1][i] - planes[0][i];
    if (bestOrder(side).cost < bestOrder(planes[1]).cost) { planes = [planes[0], side]; stereo = 1; }
  }
  const w = new BitWriter(Math.ceil(n * nc * 2) + HEADER);
  for (let i = 0; i < HEADER; i++) w.write(0, 8);
  for (const p of planes) encodeChannel(w, p);
  let out = w.bytes();
  let mode = 0;
  const raw = 3 * n * nc;
  if (out.length - HEADER > raw) {
    // Rien à gagner (bruit) : octets 24 bits tels quels.
    mode = 1;
    out = new Uint8Array(HEADER + raw);
    let o = HEADER;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const s = chs[c][i]; out[o] = s & 0xff; out[o + 1] = (s >> 8) & 0xff; out[o + 2] = (s >> 16) & 0xff; o += 3; }
  } else out = out.slice();
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  MAGIC.forEach((b, i) => v.setUint8(i, b));
  v.setUint8(4, LT_VERSION);
  v.setUint8(5, nc);
  v.setUint8(6, mode);
  v.setUint8(7, mode === 0 ? stereo : 0);
  v.setUint32(8, n, true);
  v.setUint32(12, crc, true);
  v.setUint8(16, mode === 0 ? shift : 0);
  return out;
}

/** Décode un morceau et vérifie sa somme de contrôle (erreur si abîmé). */
export function decodeSegment(bytes: Uint8Array): DecodedSegment {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Morceau de prise illisible');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(4) > LT_VERSION) throw new Error('Morceau de prise d’une version plus récente de NOVA');
  const nc = v.getUint8(5), mode = v.getUint8(6), stereo = v.getUint8(7);
  const n = v.getUint32(8, true), crc = v.getUint32(12, true), shift = v.getUint8(16);
  if (nc < 1 || nc > 8 || n > 50_000_000) throw new Error('Morceau de prise illisible');
  const ints = Array.from({ length: nc }, () => new Int32Array(n));
  if (mode === 1) {
    if (bytes.length < HEADER + 3 * n * nc) throw new Error('Morceau de prise tronqué');
    let o = HEADER;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      ints[c][i] = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8;
      o += 3;
    }
  } else if (mode === 0) {
    const r = new BitReader(bytes, HEADER);
    const planes = Array.from({ length: nc }, () => decodeChannel(r, n));
    if (nc === 2 && stereo === 1) for (let i = 0; i < n; i++) planes[1][i] += planes[0][i];
    const mul = 2 ** shift;
    for (let c = 0; c < nc; c++) for (let i = 0; i < n; i++) {
      const s = planes[c][i] * mul;
      // Hors des 24 bits : morceau abîmé (la somme ne porte que sur 24 bits, elle ne le verrait pas).
      if (s < -0x800000 || s > 0x7fffff || !Number.isInteger(s)) throw new Error('Morceau de prise abîmé (valeur hors limites)');
      ints[c][i] = s;
    }
  } else throw new Error('Morceau de prise illisible (mode)');
  const got = new Pcm24Crc().update(ints).value();
  if (got !== crc) throw new Error('Morceau de prise abîmé (somme de contrôle)');
  return { ints, frames: n, channels: nc, crc };
}

/** Lit l'en-tête seul (nombre d'images, canaux, somme) sans décoder. */
export function segmentInfo(bytes: Uint8Array): { frames: number; channels: number; crc: number } | null {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { channels: v.getUint8(5), frames: v.getUint32(8, true), crc: v.getUint32(12, true) };
}
