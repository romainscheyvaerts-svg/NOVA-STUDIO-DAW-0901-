/**
 * Formats de livraison de NOVA (R1), sans dépendance et testables tels quels :
 *  - WAV PCM 16 / 24 bits et 32 bits flottants, avec BWF (chunk « bext » v2 :
 *    description, origine, date, position, loudness), « acid » (tempo, mesure),
 *    repères (« cue » + « labl »), LIST INFO (titre, artiste, ISRC…) et tags ID3 ;
 *  - AIFF 16 / 24 bits (AIFF-C « fl32 » pour le 32 bits flottant), avec NAME,
 *    AUTH, ANNO, MARK et ID3 ;
 *  - ID3v2.3 pour le MP3 (titre, artiste, BPM, tonalité, ISRC, pochette) ;
 *  - quantification, dither TPDF reproductible, mono-somme et double mono.
 * Le FLAC est dans utils/flac.ts.
 *
 * Pro Tools (Bounce Mix), Logic (Bounce), Ableton (Export Audio/Video) et FL
 * (Export) écrivent ces mêmes chunks ; ici ils portent aussi le BPM, la tonalité
 * et la loudness mesurée, pour l'ingé qui reçoit les fichiers.
 */

export type ChannelLayout = 'stereo' | 'mono' | 'mono-sum' | 'dual-mono';

export interface AudioMarker { name: string; time: number }

export interface AudioMeta {
  title?: string;
  artist?: string;
  album?: string;
  bpm?: number;
  /** Tonalité lisible (« Do mineur ») ; `keyId3` = notation courte anglaise (« Cm »). */
  key?: string;
  keyId3?: string;
  isrc?: string;
  comment?: string;
  genre?: string;
  /** Pochette (JPEG / PNG), pour le MP3, le FLAC et l'AIFF / WAV (ID3). */
  cover?: { mime: string; data: Uint8Array };
  /** Repères, en secondes depuis le début du fichier. */
  markers?: AudioMarker[];
  /** Position du début du fichier dans le morceau, en secondes (BWF TimeReference). */
  timeReference?: number;
  /** Mesure (chunk acid). */
  timeSignature?: { numerator: number; denominator: number };
  /** Loudness mesurée (BWF v2). */
  loudness?: { lufs?: number; truePeak?: number; lra?: number };
  /** Date de création (par défaut : maintenant). */
  date?: Date;
  software?: string;
}

// --- Quantification ---------------------------------------------------------------

/** Entier signé sur `bits` (arrondi, écrêté) : la même règle partout, donc des allers-retours bit à bit. */
export function quantize(x: number, bits: number): number {
  const full = 2 ** (bits - 1);
  const v = Math.round(x * full);
  return v > full - 1 ? full - 1 : v < -full ? -full : v;
}

export const dequantize = (v: number, bits: number): number => v / 2 ** (bits - 1);

export function quantizeChannels(chs: Float32Array[], bits: number): Int32Array[] {
  return chs.map(c => {
    const out = new Int32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = quantize(c[i], bits);
    return out;
  });
}

/** Générateur pseudo-aléatoire reproductible (xorshift32). */
export function makeRng(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Dither TPDF de ±1 LSB (triangulaire), avant la réduction à `bits`. Modifie en
 * place. L'ancien code ajoutait ±½ LSB au mauvais pas (1 / 2^bits) : pas assez
 * pour décorréler l'erreur de quantification en 16 bits.
 */
export function applyTpdfDither(chs: Float32Array[], bits: number, rng: () => number = makeRng()): void {
  if (bits >= 32) return;
  const lsb = 1 / 2 ** (bits - 1);
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] += (rng() - rng()) * lsb;
}

/**
 * Stéréo, mono (canal gauche seul : une source mono enregistrée en stéréo),
 * mono-somme ((G + D) / 2, Pro Tools « Mono (Summed) ») ou double mono (deux
 * fichiers G et D, Pro Tools « Multiple Mono »).
 */
export function applyLayout(chs: Float32Array[], layout: ChannelLayout): Float32Array[][] {
  const L = chs[0] || new Float32Array(0);
  const R = chs[1] || L;
  if (layout === 'mono-sum') {
    const m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) * 0.5;
    return [[m]];
  }
  if (layout === 'dual-mono') return [[L], [R]];
  if (layout === 'mono') return [[L]];
  return [chs.length >= 2 ? [L, R] : [L, L]];
}

// --- Écriture binaire -------------------------------------------------------------

class ByteWriter {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  u16le(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32le(v: number) { this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24); }
  u16be(v: number) { this.u8(v >>> 8); this.u8(v); }
  u32be(v: number) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  ascii(s: string, fixed?: number) {
    const n = fixed ?? s.length;
    for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0xff : 0);
  }
  patch32le(at: number, v: number) { this.buf[at] = v & 0xff; this.buf[at + 1] = (v >>> 8) & 0xff; this.buf[at + 2] = (v >>> 16) & 0xff; this.buf[at + 3] = (v >>> 24) & 0xff; }
  patch32be(at: number, v: number) { this.buf[at] = (v >>> 24) & 0xff; this.buf[at + 1] = (v >>> 16) & 0xff; this.buf[at + 2] = (v >>> 8) & 0xff; this.buf[at + 3] = v & 0xff; }
  out() { return this.buf.slice(0, this.len); }
}

/** ASCII strict (chunk bext, noms Pascal de l'AIFF) : accents retirés, le reste remplacé. */
const asciiOnly = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e]/g, '?');
/** Texte UTF-8 en « chaîne d'octets » (LIST INFO, NAME / AUTH / ANNO) : lu correctement par ffmpeg, Audacity, Reaper. */
const utf8Bytes = (s: string) => Array.from(new TextEncoder().encode(s), b => String.fromCharCode(b)).join('');


// --- ID3v2.3 -------------------------------------------------------------------------

/** Tonalité NOVA (0 = Do … 11 = Si, gamme) → notation ID3 / Camelot courte (« Cm », « F# »). */
export function keyToId3(root?: number, scale?: string): string | undefined {
  if (typeof root !== 'number' || !Number.isFinite(root)) return undefined;
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const n = names[((Math.round(root) % 12) + 12) % 12];
  return /MINOR/i.test(scale || 'MINOR') ? `${n}m` : n;
}

function id3TextFrame(id: string, text: string): Uint8Array {
  const isLatin = /^[\u0000-\u00ff]*$/.test(text);
  const w = new ByteWriter();
  if (isLatin) { w.u8(0); w.ascii(text); }
  else {
    w.u8(1); w.u8(0xff); w.u8(0xfe);
    for (let i = 0; i < text.length; i++) w.u16le(text.charCodeAt(i));
  }
  return id3Frame(id, w.out());
}

function id3Frame(id: string, body: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.ascii(id, 4); w.u32be(body.length); w.u16be(0); w.bytes(body);
  return w.out();
}

/** Tag ID3v2.3 complet (en-tête compris). Vide si aucune donnée. */
export function buildId3v2(meta: AudioMeta): Uint8Array {
  const frames: Uint8Array[] = [];
  if (meta.title) frames.push(id3TextFrame('TIT2', meta.title));
  if (meta.artist) frames.push(id3TextFrame('TPE1', meta.artist));
  if (meta.album) frames.push(id3TextFrame('TALB', meta.album));
  if (meta.genre) frames.push(id3TextFrame('TCON', meta.genre));
  if (meta.bpm && meta.bpm > 0) frames.push(id3TextFrame('TBPM', String(Math.round(meta.bpm))));
  if (meta.keyId3) frames.push(id3TextFrame('TKEY', meta.keyId3.slice(0, 3)));
  if (meta.isrc) frames.push(id3TextFrame('TSRC', meta.isrc));
  frames.push(id3TextFrame('TYER', String((meta.date || new Date()).getFullYear())));
  frames.push(id3TextFrame('TSSE', meta.software || 'NOVA Studio'));
  const comment = meta.comment ?? describe(meta);
  if (comment) {
    const isLatin = /^[\u0000-\u00ff]*$/.test(comment);
    const w = new ByteWriter();
    if (isLatin) { w.u8(0); w.ascii('fra'); w.u8(0); w.ascii(comment); }
    else { w.u8(1); w.ascii('fra'); w.u8(0xff); w.u8(0xfe); w.u16le(0); w.u8(0xff); w.u8(0xfe); for (let i = 0; i < comment.length; i++) w.u16le(comment.charCodeAt(i)); }
    frames.push(id3Frame('COMM', w.out()));
  }
  if (meta.cover && meta.cover.data.length) {
    const w = new ByteWriter();
    w.u8(0); w.ascii(meta.cover.mime); w.u8(0); w.u8(3 /* couverture */); w.u8(0); w.bytes(meta.cover.data);
    frames.push(id3Frame('APIC', w.out()));
  }
  const size = frames.reduce((s, f) => s + f.length, 0);
  const w = new ByteWriter();
  w.ascii('ID3'); w.u8(3); w.u8(0); w.u8(0);
  // Taille « syncsafe » : 4 × 7 bits.
  w.u8((size >>> 21) & 0x7f); w.u8((size >>> 14) & 0x7f); w.u8((size >>> 7) & 0x7f); w.u8(size & 0x7f);
  frames.forEach(f => w.bytes(f));
  return w.out();
}

/** Lecture d'un tag ID3v2.3 / 2.4 (tests et vérifications) : cadres texte et pochette. */
export function parseId3v2(bytes: Uint8Array): { frames: Record<string, string>; cover?: { mime: string; size: number }; size: number } | null {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  const ver = bytes[3];
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const frames: Record<string, string> = {};
  let cover: { mime: string; size: number } | undefined;
  let p = 10;
  const end = 10 + size;
  const dec = (b: Uint8Array) => {
    const enc = b[0];
    const body = b.subarray(1);
    if (enc === 0) return String.fromCharCode(...body).replace(/\0+$/, '');
    if (enc === 3) return new TextDecoder('utf-8').decode(body).replace(/\0+$/, '');
    let s = '';
    let i = 0;
    let le = true;
    if (body[0] === 0xff && body[1] === 0xfe) i = 2; else if (body[0] === 0xfe && body[1] === 0xff) { i = 2; le = false; }
    for (; i + 1 < body.length; i += 2) s += String.fromCharCode(le ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1]);
    return s.replace(/\0+$/, '');
  };
  while (p + 10 <= end) {
    const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fs = ver === 4
      ? ((bytes[p + 4] & 0x7f) << 21) | ((bytes[p + 5] & 0x7f) << 14) | ((bytes[p + 6] & 0x7f) << 7) | (bytes[p + 7] & 0x7f)
      : ((bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7]) >>> 0;
    const body = bytes.subarray(p + 10, p + 10 + fs);
    if (id === 'APIC') {
      let q = 1; let mime = '';
      while (q < body.length && body[q] !== 0) mime += String.fromCharCode(body[q++]);
      q += 2; while (q < body.length && body[q] !== 0) q++; q++;
      cover = { mime, size: body.length - q };
    } else if (id === 'COMM') {
      const enc = body[0];
      const rest = body.subarray(4);
      if (enc === 0) { const z = rest.indexOf(0); frames[id] = String.fromCharCode(...rest.subarray(z + 1)); }
      else frames[id] = dec(new Uint8Array([enc, ...rest])).split('\u0000').pop() || '';
    } else if (id[0] === 'T') frames[id] = dec(body);
    p += 10 + fs;
  }
  return { frames, cover, size: 10 + size };
}

/** « Titre — Artiste · 140 BPM · Do mineur » (description BWF, commentaires). */
export function describe(meta: AudioMeta): string {
  const head = [meta.title, meta.artist].filter(Boolean).join(' - ');
  const tail = [meta.bpm ? `${Math.round(meta.bpm * 100) / 100} BPM` : '', meta.key || '', meta.timeSignature ? `${meta.timeSignature.numerator}/${meta.timeSignature.denominator}` : ''].filter(Boolean).join(' · ');
  return [head, tail].filter(Boolean).join(' · ');
}

// --- WAV (RIFF / BWF) -----------------------------------------------------------------

export type WavBits = 16 | 24 | 32;

export interface PcmSpec {
  sampleRate: number;
  bits: WavBits;
  /** 32 bits flottants (sinon entier). */
  float?: boolean;
}

const pad2 = (w: ByteWriter, n: number) => { if (n & 1) w.u8(0); };

function riffChunk(w: ByteWriter, id: string, body: Uint8Array) {
  w.ascii(id, 4); w.u32le(body.length); w.bytes(body); pad2(w, body.length);
}

function bextChunk(meta: AudioMeta, spec: PcmSpec, channels: number): Uint8Array {
  const w = new ByteWriter();
  const d = meta.date || new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  w.ascii(asciiOnly(describe(meta)).slice(0, 256), 256);
  w.ascii('NOVA Studio', 32);
  w.ascii(asciiOnly((meta.isrc ? `ISRC:${meta.isrc}` : `NOVA-${d.getTime().toString(36)}`)).slice(0, 32), 32);
  w.ascii(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, 10);
  w.ascii(`${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`, 8);
  const ref = Math.max(0, Math.round((meta.timeReference || 0) * spec.sampleRate));
  w.u32le(ref % 4294967296); w.u32le(Math.floor(ref / 4294967296));
  w.u16le(2); // version 2 : champs de loudness (EBU R 128)
  for (let i = 0; i < 64; i++) w.u8(0); // UMID
  const l = meta.loudness || {};
  const lv = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-32768, Math.min(32767, Math.round(v * 100))) : 0x7fff);
  const s16 = (v: number) => w.u16le(v & 0xffff);
  s16(lv(l.lufs)); s16(lv(l.lra)); s16(lv(l.truePeak)); s16(0x7fff); s16(0x7fff);
  for (let i = 0; i < 180; i++) w.u8(0);
  w.ascii(`A=${spec.float ? 'PCM_FLOAT' : 'PCM'},F=${spec.sampleRate},W=${spec.bits},M=${channels === 1 ? 'mono' : 'stereo'},T=NOVA Studio\r\n`);
  return w.out();
}

function acidChunk(meta: AudioMeta, frames: number, sr: number): Uint8Array {
  const w = new ByteWriter();
  const ts = meta.timeSignature || { numerator: 4, denominator: 4 };
  const bpm = meta.bpm || 120;
  w.u32le(0); w.u16le(60); w.u16le(0x8000);
  const f = new DataView(new ArrayBuffer(4));
  f.setFloat32(0, 0, true); w.bytes(new Uint8Array(f.buffer));
  w.u32le(Math.max(0, Math.round((frames / sr) * (bpm / 60)))); // nombre de noires
  w.u16le(ts.denominator); w.u16le(ts.numerator);
  const t = new DataView(new ArrayBuffer(4));
  t.setFloat32(0, bpm, true); w.bytes(new Uint8Array(t.buffer));
  return w.out();
}

function infoList(meta: AudioMeta): Uint8Array {
  const w = new ByteWriter();
  w.ascii('INFO');
  const item = (id: string, v?: string) => {
    if (!v) return;
    const s = utf8Bytes(v);
    w.ascii(id, 4); w.u32le(s.length + 1); w.ascii(s); w.u8(0); pad2(w, s.length + 1);
  };
  item('INAM', meta.title);
  item('IART', meta.artist);
  item('IPRD', meta.album);
  item('IGNR', meta.genre);
  item('ICMT', meta.comment ?? describe(meta));
  item('ICRD', (meta.date || new Date()).toISOString().slice(0, 10));
  item('ISFT', meta.software || 'NOVA Studio');
  item('ISRC', meta.isrc);
  item('IKEY', meta.key);
  return w.out();
}

function cueChunks(markers: AudioMarker[], sr: number, frames: number): { cue: Uint8Array; adtl: Uint8Array } | null {
  const list = markers.map(m => ({ ...m, pos: Math.round(m.time * sr) })).filter(m => m.pos >= 0 && m.pos <= frames);
  if (!list.length) return null;
  const c = new ByteWriter();
  c.u32le(list.length);
  list.forEach((m, i) => { c.u32le(i + 1); c.u32le(m.pos); c.ascii('data'); c.u32le(0); c.u32le(0); c.u32le(m.pos); });
  const a = new ByteWriter();
  a.ascii('adtl');
  list.forEach((m, i) => {
    const s = utf8Bytes(m.name || `Repère ${i + 1}`);
    a.ascii('labl'); a.u32le(4 + s.length + 1); a.u32le(i + 1); a.ascii(s); a.u8(0); pad2(a, s.length + 1);
  });
  return { cue: c.out(), adtl: a.out() };
}

function writeSamplesLE(w: ByteWriter, chs: Float32Array[], spec: PcmSpec) {
  const n = chs[0]?.length || 0;
  const nc = chs.length;
  const bps = spec.bits / 8;
  const total = n * nc * bps;
  const data = new Uint8Array(total);
  const dv = new DataView(data.buffer);
  let o = 0;
  if (spec.float) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { dv.setFloat32(o, chs[c][i], true); o += 4; }
  } else if (spec.bits === 16) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { dv.setInt16(o, quantize(chs[c][i], 16), true); o += 2; }
  } else if (spec.bits === 24) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      const v = quantize(chs[c][i], 24);
      data[o] = v & 0xff; data[o + 1] = (v >> 8) & 0xff; data[o + 2] = (v >> 16) & 0xff; o += 3;
    }
  } else {
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { dv.setInt32(o, quantize(chs[c][i], 32), true); o += 4; }
  }
  w.bytes(data);
}

/**
 * Fichier WAV complet. `meta` facultatif : sans lui, un WAV « nu » (fmt + data),
 * identique à l'ancien encodeur (sauf la quantification, désormais arrondie).
 */
export function encodeWav(chs: Float32Array[], spec: PcmSpec, meta?: AudioMeta): Uint8Array {
  const nc = chs.length;
  const frames = chs[0]?.length || 0;
  const float = !!spec.float && spec.bits === 32;
  const s: PcmSpec = { ...spec, float };
  const w = new ByteWriter();
  w.ascii('RIFF'); w.u32le(0); w.ascii('WAVE');
  // fmt
  const fmt = new ByteWriter();
  fmt.u16le(float ? 3 : 1); fmt.u16le(nc); fmt.u32le(spec.sampleRate);
  fmt.u32le(spec.sampleRate * nc * (spec.bits / 8)); fmt.u16le(nc * (spec.bits / 8)); fmt.u16le(spec.bits);
  if (float) fmt.u16le(0);
  riffChunk(w, 'fmt ', fmt.out());
  if (float) { const f = new ByteWriter(); f.u32le(frames); riffChunk(w, 'fact', f.out()); }
  if (meta) {
    riffChunk(w, 'bext', bextChunk(meta, s, nc));
    if (meta.bpm) riffChunk(w, 'acid', acidChunk(meta, frames, spec.sampleRate));
    const cue = meta.markers?.length ? cueChunks(meta.markers, spec.sampleRate, frames) : null;
    if (cue) { riffChunk(w, 'cue ', cue.cue); riffChunk(w, 'LIST', cue.adtl); }
    riffChunk(w, 'LIST', infoList(meta));
    riffChunk(w, 'id3 ', buildId3v2(meta));
  }
  const dataSize = frames * nc * (spec.bits / 8);
  w.ascii('data'); w.u32le(dataSize);
  writeSamplesLE(w, chs, s);
  pad2(w, dataSize);
  w.patch32le(4, w.len - 8);
  return w.out();
}

export interface DecodedPcm {
  sampleRate: number;
  bits: number;
  float: boolean;
  /** Entiers (PCM) ou flottants (32 bits flottants). */
  ints?: Int32Array[];
  floats?: Float32Array[];
  /** Chunks rencontrés, dans l'ordre (identifiant → contenu). */
  chunks: { id: string; data: Uint8Array }[];
}

/** Lecture d'un WAV PCM / flottant (tests, vérifications). */
export function decodeWav(bytes: Uint8Array): DecodedPcm {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('Pas un WAV');
  let p = 12;
  let fmtTag = 1, nc = 2, sr = 44100, bits = 16;
  let data: Uint8Array | null = null;
  const chunks: { id: string; data: Uint8Array }[] = [];
  while (p + 8 <= bytes.length) {
    const cid = id(p);
    const size = dv.getUint32(p + 4, true);
    const body = bytes.subarray(p + 8, p + 8 + size);
    chunks.push({ id: cid, data: body });
    if (cid === 'fmt ') { fmtTag = dv.getUint16(p + 8, true); nc = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); bits = dv.getUint16(p + 22, true); }
    if (cid === 'data') data = body;
    p += 8 + size + (size & 1);
  }
  if (!data) throw new Error('Chunk data absent');
  const float = fmtTag === 3;
  const bps = bits / 8;
  const frames = Math.floor(data.length / (bps * nc));
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (float) {
    const floats = Array.from({ length: nc }, () => new Float32Array(frames));
    for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nc; c++, o += 4) floats[c][i] = ddv.getFloat32(o, true);
    return { sampleRate: sr, bits, float, floats, chunks };
  }
  const ints = Array.from({ length: nc }, () => new Int32Array(frames));
  for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nc; c++, o += bps) {
    if (bits === 16) ints[c][i] = ddv.getInt16(o, true);
    else if (bits === 24) { const v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16); ints[c][i] = (v << 8) >> 8; }
    else ints[c][i] = ddv.getInt32(o, true);
  }
  return { sampleRate: sr, bits, float, ints, chunks };
}

// --- AIFF / AIFF-C ----------------------------------------------------------------

/** Nombre flottant étendu 80 bits (IEEE 754) d'une fréquence entière. */
function extended80(v: number): Uint8Array {
  const out = new Uint8Array(10);
  if (v <= 0) return out;
  const e = Math.floor(Math.log2(v));
  const exp = 16383 + e;
  out[0] = (exp >> 8) & 0x7f; out[1] = exp & 0xff;
  // Mantisse sur 64 bits : v × 2^(63 − e), entier (v entier < 2^32).
  const hi = Math.floor(v * 2 ** (31 - e)) >>> 0;
  const lo = Math.round((v * 2 ** (63 - e)) - hi * 2 ** 32) >>> 0;
  out[2] = hi >>> 24; out[3] = (hi >>> 16) & 0xff; out[4] = (hi >>> 8) & 0xff; out[5] = hi & 0xff;
  out[6] = lo >>> 24; out[7] = (lo >>> 16) & 0xff; out[8] = (lo >>> 8) & 0xff; out[9] = lo & 0xff;
  return out;
}

function readExtended80(b: Uint8Array): number {
  const exp = ((b[0] & 0x7f) << 8) | b[1];
  const hi = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
  const lo = ((b[6] << 24) | (b[7] << 16) | (b[8] << 8) | b[9]) >>> 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

function aiffChunk(w: ByteWriter, id: string, body: Uint8Array) {
  w.ascii(id, 4); w.u32be(body.length); w.bytes(body); pad2(w, body.length);
}

const pstring = (w: ByteWriter, s: string) => {
  const t = asciiOnly(s).slice(0, 255);
  w.u8(t.length); w.ascii(t);
  if ((t.length + 1) & 1) w.u8(0);
};

/** AIFF (16 / 24 / 32 bits entiers) ou AIFF-C « fl32 » (32 bits flottants), comme le Bounce de Logic. */
export function encodeAiff(chs: Float32Array[], spec: PcmSpec, meta?: AudioMeta): Uint8Array {
  const nc = chs.length;
  const frames = chs[0]?.length || 0;
  const float = !!spec.float && spec.bits === 32;
  const w = new ByteWriter();
  w.ascii('FORM'); w.u32be(0); w.ascii(float ? 'AIFC' : 'AIFF');
  if (float) { const f = new ByteWriter(); f.u32be(0xa2805140); aiffChunk(w, 'FVER', f.out()); }
  const comm = new ByteWriter();
  comm.u16be(nc); comm.u32be(frames); comm.u16be(spec.bits); comm.bytes(extended80(spec.sampleRate));
  if (float) { comm.ascii('fl32'); pstring(comm, '32-bit floating point'); }
  aiffChunk(w, 'COMM', comm.out());
  if (meta) {
    const text = (id: string, v?: string) => { if (v) { const t = utf8Bytes(v); const b = new ByteWriter(); b.ascii(t); aiffChunk(w, id, b.out()); } };
    text('NAME', meta.title);
    text('AUTH', meta.artist);
    text('ANNO', meta.comment ?? describe(meta));
    const marks = (meta.markers || []).map(m => ({ ...m, pos: Math.round(m.time * spec.sampleRate) })).filter(m => m.pos >= 0 && m.pos <= frames);
    if (marks.length) {
      const m = new ByteWriter();
      m.u16be(marks.length);
      marks.forEach((k, i) => { m.u16be(i + 1); m.u32be(k.pos); pstring(m, k.name || `Repère ${i + 1}`); });
      aiffChunk(w, 'MARK', m.out());
    }
    aiffChunk(w, 'ID3 ', buildId3v2(meta));
  }
  const bps = spec.bits / 8;
  const dataSize = frames * nc * bps;
  w.ascii('SSND'); w.u32be(dataSize + 8); w.u32be(0); w.u32be(0);
  const data = new Uint8Array(dataSize);
  const dv = new DataView(data.buffer);
  let o = 0;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) {
    const x = chs[c][i];
    if (float) { dv.setFloat32(o, x, false); o += 4; }
    else if (spec.bits === 16) { dv.setInt16(o, quantize(x, 16), false); o += 2; }
    else if (spec.bits === 24) { const v = quantize(x, 24); data[o] = (v >> 16) & 0xff; data[o + 1] = (v >> 8) & 0xff; data[o + 2] = v & 0xff; o += 3; }
    else { dv.setInt32(o, quantize(x, 32), false); o += 4; }
  }
  w.bytes(data);
  pad2(w, dataSize);
  w.patch32be(4, w.len - 8);
  return w.out();
}

export function decodeAiff(bytes: Uint8Array): DecodedPcm {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (id(0) !== 'FORM' || (id(8) !== 'AIFF' && id(8) !== 'AIFC')) throw new Error('Pas un AIFF');
  let p = 12;
  let nc = 2, frames = 0, bits = 16, sr = 44100, float = false;
  let ssnd: Uint8Array | null = null;
  const chunks: { id: string; data: Uint8Array }[] = [];
  while (p + 8 <= bytes.length) {
    const cid = id(p);
    const size = dv.getUint32(p + 4, false);
    const body = bytes.subarray(p + 8, p + 8 + size);
    chunks.push({ id: cid, data: body });
    if (cid === 'COMM') {
      nc = dv.getUint16(p + 8, false); frames = dv.getUint32(p + 10, false); bits = dv.getUint16(p + 14, false);
      sr = readExtended80(bytes.subarray(p + 16, p + 26));
      if (size > 18) float = id(p + 26) === 'fl32';
    }
    if (cid === 'SSND') { const off = dv.getUint32(p + 8, false); ssnd = bytes.subarray(p + 16 + off, p + 8 + size); }
    p += 8 + size + (size & 1);
  }
  if (!ssnd) throw new Error('Chunk SSND absent');
  const sdv = new DataView(ssnd.buffer, ssnd.byteOffset, ssnd.byteLength);
  const bps = bits / 8;
  if (float) {
    const floats = Array.from({ length: nc }, () => new Float32Array(frames));
    for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nc; c++, o += 4) floats[c][i] = sdv.getFloat32(o, false);
    return { sampleRate: sr, bits, float, floats, chunks };
  }
  const ints = Array.from({ length: nc }, () => new Int32Array(frames));
  for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nc; c++, o += bps) {
    if (bits === 16) ints[c][i] = sdv.getInt16(o, false);
    else if (bits === 24) { const v = (ssnd[o] << 16) | (ssnd[o + 1] << 8) | ssnd[o + 2]; ints[c][i] = (v << 8) >> 8; }
    else ints[c][i] = sdv.getInt32(o, false);
  }
  return { sampleRate: sr, bits, float, ints, chunks };
}

/** Champs de texte RIFF INFO d'un WAV décodé (tests). */
export function readInfo(dec: DecodedPcm): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of dec.chunks) {
    if (c.id !== 'LIST' || String.fromCharCode(...c.data.subarray(0, 4)) !== 'INFO') continue;
    let p = 4;
    const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    while (p + 8 <= c.data.length) {
      const id = String.fromCharCode(...c.data.subarray(p, p + 4));
      const size = dv.getUint32(p + 4, true);
      out[id] = new TextDecoder('utf-8').decode(c.data.subarray(p + 8, p + 8 + size)).replace(/\0+$/, '');
      p += 8 + size + (size & 1);
    }
  }
  return out;
}

