/**
 * BWF (Broadcast Wave) horodaté pour Pro Tools — pont Pro Tools (chantier 9, B2).
 *
 * Chaque prise de l'artiste posée chez l'ingé est aussi écrite en WAV BWF :
 *  - chunk « bext » : TimeReference = position du PREMIER échantillon du fichier
 *    dans le morceau, en ÉCHANTILLONS ENTIERS (jamais en secondes arrondies plus
 *    tard), plus le décalage de départ de la séance Pro Tools (01:00:00:00…) ;
 *  - chunk « iXML » : projet, piste (SCENE), n° de prise (TAKE), horodatage en
 *    échantillons depuis minuit, fréquence, nom de la piste ;
 *  - PCM 24 bits (le standard des séances Pro Tools) ou 32 bits flottants (le
 *    son de NOVA au bit près, sans arrondi).
 * Pro Tools l'importe en mode Spot (« Original Time Stamp ») à l'échantillon près.
 *
 * Module pur (aucune dépendance au navigateur) : testé tel quel (tests/bwf.test.ts)
 * et relu en Python par le pont et par qa/pont_protools.py.
 */

export type BwfFormat = '24' | '32f';

export const BWF_FORMATS: { id: BwfFormat; label: string; hint: string }[] = [
  { id: '24', label: '24 bits', hint: 'Standard des séances Pro Tools' },
  { id: '32f', label: '32 bits flottants', hint: 'Le son de NOVA au bit près (Pro Tools 2022.4 et plus récent)' },
];

/** Cadences du timecode de départ de séance (images non droppées). */
export const TIMECODE_FPS = [24, 25, 30] as const;
export type TimecodeFps = typeof TIMECODE_FPS[number];

export interface BwfTakeInfo {
  /** Nom du projet NOVA (iXML PROJECT). */
  project?: string;
  /** Nom de la piste (iXML SCENE, nom de canal). */
  track: string;
  /** Numéro de prise (iXML TAKE). */
  take: number;
  /** Artiste qui a fait la prise (iXML NOTE, description bext). */
  artist?: string;
  /** Cadence du timecode de la séance (iXML TIMECODE_RATE). */
  fps?: TimecodeFps;
}

export interface BwfInput {
  /** Canaux (1 = mono, 2 = stéréo…), même longueur. */
  channels: Float32Array[];
  sampleRate: number;
  format: BwfFormat;
  /** Position du premier échantillon du fichier, en échantillons depuis minuit (séance Pro Tools). */
  timeReference: number;
  info: BwfTakeInfo;
  /** Date de création (bext OriginationDate / Time). */
  date?: Date;
}

// --- Écriture binaire -------------------------------------------------------------------

class Bytes {
  private buf = new Uint8Array(4096);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number) { this.grow(1); this.buf[this.len++] = v & 0xff; }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32(v: number) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  /** Texte ASCII, complété par des zéros jusqu'à `size` octets (si donné). */
  ascii(s: string, size?: number) {
    const n = size ?? s.length;
    this.grow(n);
    for (let i = 0; i < n; i++) this.buf[this.len++] = i < s.length ? s.charCodeAt(i) & 0x7f : 0;
  }
  bytes(b: Uint8Array) { this.grow(b.length); this.buf.set(b, this.len); this.len += b.length; }
  patch32(at: number, v: number) { this.buf[at] = v & 0xff; this.buf[at + 1] = (v >>> 8) & 0xff; this.buf[at + 2] = (v >>> 16) & 0xff; this.buf[at + 3] = (v >>> 24) & 0xff; }
  out(): Uint8Array { return this.buf.slice(0, this.len); }
}

const chunk = (w: Bytes, id: string, body: Uint8Array) => {
  w.ascii(id, 4); w.u32(body.length); w.bytes(body);
  if (body.length & 1) w.u8(0);
};

/** ASCII strict (bext) : accents retirés, le reste remplacé par « _ ». */
export const asciiOnly = (s: string): string =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');

const xmlEscape = (s: string): string => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

const two = (n: number) => String(n).padStart(2, '0');

/** Échantillons → (poids fort, poids faible) sur 32 bits chacun (TimeReference 64 bits). */
export const splitU64 = (v: number): [number, number] => {
  const x = Math.max(0, Math.floor(v));
  return [Math.floor(x / 4294967296), x % 4294967296];
};

function bextBody(inp: BwfInput, bits: number, float: boolean): Uint8Array {
  const w = new Bytes();
  const d = inp.date || new Date();
  const { track, take, artist } = inp.info;
  w.ascii(asciiOnly(`NOVA - ${track} - Prise ${take}${artist ? ` - ${artist}` : ''}`).slice(0, 256), 256); // Description
  w.ascii('NOVA Studio', 32);                                                                               // Originator
  w.ascii(asciiOnly(`NOVA-${take}-${d.getTime().toString(36)}`).slice(0, 32), 32);                        // OriginatorReference
  w.ascii(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, 10);                          // OriginationDate
  w.ascii(`${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`, 8);                        // OriginationTime
  const [hi, lo] = splitU64(inp.timeReference);
  w.u32(lo); w.u32(hi);                                                                                     // TimeReference (low, high)
  w.u16(1);                                                                                                 // Version 1 (UMID)
  for (let i = 0; i < 64; i++) w.u8(0);                                                                     // UMID
  for (let i = 0; i < 190; i++) w.u8(0);                                                                    // loudness (v2) + réservé
  const nc = inp.channels.length;
  w.ascii(`A=${float ? 'PCM_FLOAT' : 'PCM'},F=${inp.sampleRate},W=${bits},M=${nc === 1 ? 'mono' : nc === 2 ? 'stereo' : 'multitrack'},T=NOVA Studio\r\n`);
  return w.out();
}

/** iXML (v2.10) : ce que Pro Tools, Reaper, Nuendo et les logiciels de tournage affichent. */
export function ixmlText(inp: BwfInput, bits: number): string {
  const { project, track, take, artist } = inp.info;
  const fps = inp.info.fps || 25;
  const [hi, lo] = splitU64(inp.timeReference);
  const sr = inp.sampleRate;
  const tracks = inp.channels.map((_c, i) => `<TRACK><CHANNEL_INDEX>${i + 1}</CHANNEL_INDEX><INTERLEAVE_INDEX>${i + 1}</INTERLEAVE_INDEX><NAME>${xmlEscape(inp.channels.length === 1 ? track : `${track} ${i === 0 ? 'G' : i === 1 ? 'D' : i + 1}`)}</NAME></TRACK>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<BWFXML>'
    + '<IXML_VERSION>2.10</IXML_VERSION>'
    + `<PROJECT>${xmlEscape(project || 'NOVA')}</PROJECT>`
    + `<SCENE>${xmlEscape(track)}</SCENE>`
    + `<TAKE>${Math.max(0, Math.floor(take))}</TAKE>`
    + '<TAPE>NOVA</TAPE>'
    + `<NOTE>${xmlEscape(`Prise ${take}${artist ? ` de ${artist}` : ''}, reçue par la collaboration NOVA`)}</NOTE>`
    + '<SPEED><MASTER_SPEED>1/1</MASTER_SPEED><CURRENT_SPEED>1/1</CURRENT_SPEED>'
    + `<TIMECODE_RATE>${fps}/1</TIMECODE_RATE><TIMECODE_FLAG>NDF</TIMECODE_FLAG>`
    + `<FILE_SAMPLE_RATE>${sr}</FILE_SAMPLE_RATE><AUDIO_BIT_DEPTH>${bits}</AUDIO_BIT_DEPTH><DIGITIZER_SAMPLE_RATE>${sr}</DIGITIZER_SAMPLE_RATE>`
    + `<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>${hi}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>${lo}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>`
    + `<TIMESTAMP_SAMPLE_RATE>${sr}</TIMESTAMP_SAMPLE_RATE></SPEED>`
    + `<TRACK_LIST><TRACK_COUNT>${inp.channels.length}</TRACK_COUNT>${tracks}</TRACK_LIST>`
    + '<USER>NOVA Studio</USER>'
    + '</BWFXML>';
}

/** Échantillon flottant → entier 24 bits (arrondi, écrêté) : même règle que les exports de NOVA. */
export const toInt24 = (x: number): number => {
  const v = Math.round(x * 8388608);
  return v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v;
};

/** Fichier BWF complet (fmt, bext, iXML, data). */
export function encodeBwf(inp: BwfInput): Uint8Array {
  const nc = Math.max(1, inp.channels.length);
  const frames = inp.channels[0]?.length || 0;
  const float = inp.format === '32f';
  const bits = float ? 32 : 24;
  const bps = bits / 8;
  if (!Number.isInteger(inp.sampleRate) || inp.sampleRate <= 0) throw new Error('Fréquence invalide');
  if (!Number.isFinite(inp.timeReference) || inp.timeReference < 0) throw new Error('Position invalide (avant le début de la séance)');
  const w = new Bytes();
  w.ascii('RIFF'); w.u32(0); w.ascii('WAVE');
  const fmt = new Bytes();
  fmt.u16(float ? 3 : 1); fmt.u16(nc); fmt.u32(inp.sampleRate); fmt.u32(inp.sampleRate * nc * bps); fmt.u16(nc * bps); fmt.u16(bits);
  if (float) fmt.u16(0);
  chunk(w, 'fmt ', fmt.out());
  if (float) { const f = new Bytes(); f.u32(frames); chunk(w, 'fact', f.out()); }
  chunk(w, 'bext', bextBody(inp, bits, float));
  chunk(w, 'iXML', new TextEncoder().encode(ixmlText(inp, bits)));
  const size = frames * nc * bps;
  w.ascii('data'); w.u32(size);
  const data = new Uint8Array(size + (size & 1));
  const dv = new DataView(data.buffer);
  let o = 0;
  if (float) {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) { dv.setFloat32(o, inp.channels[c][i], true); o += 4; }
  } else {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) {
      const v = toInt24(inp.channels[c][i]);
      data[o] = v & 0xff; data[o + 1] = (v >> 8) & 0xff; data[o + 2] = (v >> 16) & 0xff; o += 3;
    }
  }
  w.bytes(data);
  const out = w.out();
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// --- Lecture (tests, vérifications) ---------------------------------------------------------

export interface ParsedBwf {
  sampleRate: number;
  channels: number;
  bits: number;
  float: boolean;
  frames: number;
  timeReference: number;
  description: string;
  originator: string;
  codingHistory: string;
  ixml: string | null;
  /** Échantillons (flottants pour 32f, entiers pour 24 bits), par canal. */
  samples: (Float32Array | Int32Array)[];
}

const readAscii = (b: Uint8Array, o: number, n: number) => {
  let s = '';
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
  return s;
};

export function parseBwf(bytes: Uint8Array): ParsedBwf {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o: number) => readAscii(bytes, o, 4);
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('Pas un WAV');
  let p = 12, fmtTag = 1, nc = 1, sr = 0, bits = 16, tref = 0, desc = '', orig = '', hist = '';
  let ixml: string | null = null;
  let data: Uint8Array | null = null;
  while (p + 8 <= bytes.length) {
    const cid = id(p);
    const size = dv.getUint32(p + 4, true);
    const body = bytes.subarray(p + 8, p + 8 + size);
    if (cid === 'fmt ') { fmtTag = dv.getUint16(p + 8, true); nc = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); bits = dv.getUint16(p + 22, true); }
    if (cid === 'bext') {
      desc = readAscii(body, 0, 256); orig = readAscii(body, 256, 32);
      const bd = new DataView(body.buffer, body.byteOffset, body.byteLength);
      tref = bd.getUint32(338, true) + bd.getUint32(342, true) * 4294967296;
      hist = readAscii(body, 602, body.length - 602);
    }
    if (cid === 'iXML') ixml = new TextDecoder().decode(body);
    if (cid === 'data') data = body;
    p += 8 + size + (size & 1);
  }
  if (!data) throw new Error('Chunk data absent');
  const float = fmtTag === 3;
  const bps = bits / 8;
  const frames = Math.floor(data.length / (bps * nc));
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples: (Float32Array | Int32Array)[] = Array.from({ length: nc }, () => (float ? new Float32Array(frames) : new Int32Array(frames)));
  for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nc; c++, o += bps) {
    if (float) samples[c][i] = ddv.getFloat32(o, true);
    else if (bits === 24) { const v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16); samples[c][i] = (v << 8) >> 8; }
    else if (bits === 16) samples[c][i] = ddv.getInt16(o, true);
    else samples[c][i] = ddv.getInt32(o, true);
  }
  return { sampleRate: sr, channels: nc, bits, float, frames, timeReference: tref, description: desc, originator: orig, codingHistory: hist, ixml, samples };
}

// --- Timecode de départ de séance -----------------------------------------------------------

/** « 01:00:00:00 » → échantillons (images arrondies à l'échantillon le plus proche). null : invalide. */
export function timecodeToSamples(tc: string, fps: number, sampleRate: number): number | null {
  const m = /^\s*(\d{1,2})[:;.](\d{2})[:;.](\d{2})(?:[:;.](\d{2}))?\s*$/.exec(String(tc || ''));
  if (!m) return null;
  const [h, mi, s, f] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)];
  if (h > 23 || mi > 59 || s > 59 || f >= fps) return null;
  return (h * 3600 + mi * 60 + s) * sampleRate + Math.round((f * sampleRate) / fps);
}

/** Échantillons → « HH:MM:SS:FF » (affichage). */
export function samplesToTimecode(samples: number, fps: number, sampleRate: number): string {
  const totalS = Math.floor(samples / sampleRate);
  const f = Math.floor(((samples - totalS * sampleRate) * fps) / sampleRate);
  return `${two(Math.floor(totalS / 3600) % 24)}:${two(Math.floor(totalS / 60) % 60)}:${two(totalS % 60)}:${two(f)}`;
}

// --- Prise → fichier --------------------------------------------------------------------------

/** Partie d'une prise posée (clip) : où elle commence dans le morceau et dans son son, en échantillons. */
export interface TakeRegion {
  /** Position dans le morceau du premier échantillon écrit. */
  position: number;
  /** Premier échantillon du son (début du clip dans sa prise). */
  from: number;
  /** Nombre d'échantillons écrits. */
  length: number;
}

/**
 * Ce qu'on entend de la prise dans NOVA (clip : début, décalage dans le son, durée),
 * en échantillons entiers à la fréquence du son. Un clip qui commencerait avant le
 * début du morceau est coupé à 0 (Pro Tools n'a rien avant le départ de la séance).
 */
export function takeRegion(clip: { start: number; offset?: number; duration: number }, bufferLength: number, sampleRate: number): TakeRegion | null {
  let position = Math.round((Number(clip.start) || 0) * sampleRate);
  let from = Math.round((Number(clip.offset) || 0) * sampleRate);
  let length = Math.round((Number(clip.duration) || 0) * sampleRate);
  if (position < 0) { from -= position; length += position; position = 0; }
  if (from < 0) { length += from; position -= from; from = 0; }
  length = Math.min(length, bufferLength - from);
  if (!(length > 0)) return null;
  return { position, from, length };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Morceau de nom de fichier sûr (Windows, Pro Tools) : caractères interdits retirés, longueur bornée. */
export function safeFilePart(s: string, fallback: string, max = 48): string {
  // eslint-disable-next-line no-control-regex
  let t = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/_+/g, '-').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[ .]+$/, '');
  if (!t || RESERVED.test(t)) t = fallback;
  return t;
}

/** `<piste>_<prise n>_<artiste>.wav` (« Voix lead_Prise 3_Lina.wav »). */
export function takeFileName(track: string, take: number, artist: string): string {
  return `${safeFilePart(track, 'Piste')}_Prise ${Math.max(1, Math.floor(take) || 1)}_${safeFilePart(artist, 'Artiste', 32)}.wav`;
}
