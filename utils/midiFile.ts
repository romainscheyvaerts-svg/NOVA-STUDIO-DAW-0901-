/**
 * Fichiers MIDI standard (.mid), lecteur et écrivain maison, sans dépendance (V25).
 *
 * - Formats 0 (une seule piste, tous les canaux mélangés) et 1 (plusieurs
 *   pistes synchrones, la première porte en général le tempo) ; le format 2
 *   (pistes indépendantes) est lu comme un format 1.
 * - Running status (octet de statut omis quand il se répète) en lecture, et en
 *   écriture par défaut (fichiers plus petits, comme la plupart des DAW).
 * - Note On de vélocité 0 = Note Off. Notes empilées sur la même hauteur :
 *   la plus ancienne se ferme d'abord (FIFO, comme Live et Logic).
 * - Tempo (FF 51), mesure (FF 58), nom de piste (FF 03), programme (Cx).
 * - Canal 10 (index 9) = batterie General MIDI.
 *
 * Les positions restent en ticks : la conversion en secondes (carte des
 * tempos) est faite par `ticksToSeconds` / `secondsToTicks`.
 */

export interface MidiFileNote {
  pitch: number;
  /** 1-127 */
  velocity: number;
  startTick: number;
  durationTicks: number;
  /** 0-15 (9 = batterie) */
  channel: number;
}

export interface MidiFileTrack {
  name?: string;
  notes: MidiFileNote[];
  /** Programme General MIDI (0-127) du premier Program Change. */
  program?: number;
}

export interface MidiTempo { tick: number; /** microsecondes par noire */ usPerQuarter: number; bpm: number }
export interface MidiTimeSig { tick: number; numerator: number; denominator: number }

export interface MidiFileData {
  format: 0 | 1 | 2;
  /** Ticks par noire (PPQ). */
  ppq: number;
  tracks: MidiFileTrack[];
  tempos: MidiTempo[];
  timeSignatures: MidiTimeSig[];
  /** Fin du morceau (tick du dernier événement, End of Track compris). */
  endTick?: number;
}

export const DRUM_CHANNEL = 9;
export const DEFAULT_PPQ = 960;

const usToBpm = (us: number) => 60_000_000 / us;
export const bpmToUs = (bpm: number) => Math.round(60_000_000 / Math.max(1, bpm));

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export class MidiParseError extends Error {}

class Reader {
  pos = 0;
  constructor(public b: Uint8Array, public end = b.length) {}
  u8() { if (this.pos >= this.end) throw new MidiParseError('Fichier MIDI tronqué'); return this.b[this.pos++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8(); }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) { const c = this.u8(); v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) return v; }
    throw new MidiParseError('Longueur variable invalide');
  }
  bytes(n: number) { if (this.pos + n > this.end) throw new MidiParseError('Fichier MIDI tronqué'); const out = this.b.subarray(this.pos, this.pos + n); this.pos += n; return out; }
}

const decodeText = (bytes: Uint8Array): string => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* latin-1 */ }
  let s = ''; for (const c of bytes) s += String.fromCharCode(c); return s;
};

/** Lit un fichier .mid. Lève MidiParseError si ce n'est pas un fichier MIDI. */
export function parseMidi(input: ArrayBuffer | Uint8Array): MidiFileData {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(b);
  // Certains fichiers (RIFF RMID) emballent le MIDI : on cherche « MThd ».
  let start = 0;
  for (; start + 4 <= Math.min(b.length, 64); start++) if (b[start] === 0x4d && b[start + 1] === 0x54 && b[start + 2] === 0x68 && b[start + 3] === 0x64) break;
  if (start + 4 > b.length || r.b[start] !== 0x4d) throw new MidiParseError("Ce n'est pas un fichier MIDI (en-tête MThd absent)");
  r.pos = start + 4;
  const hlen = r.u32();
  const hEnd = r.pos + hlen;
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = hEnd;
  let ppq: number;
  if (division & 0x8000) {
    // Temps SMPTE : images/s × ticks par image = ticks par seconde ; à 120 BPM, une noire = 0,5 s.
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    ppq = Math.max(1, Math.round((fps * tpf) / 2));
  } else ppq = division || DEFAULT_PPQ;

  const tracks: MidiFileTrack[] = [];
  const tempos: MidiTempo[] = [];
  const sigs: MidiTimeSig[] = [];
  let endTick = 0;

  for (let t = 0; t < ntrks && r.pos + 8 <= b.length; t++) {
    const id = r.str(4);
    const len = r.u32();
    const chunkEnd = Math.min(b.length, r.pos + len);
    if (id !== 'MTrk') { r.pos = chunkEnd; t--; continue; } // bloc inconnu : ignoré
    const tr = new Reader(b, chunkEnd); tr.pos = r.pos;
    const track: MidiFileTrack = { notes: [] };
    const open = new Map<number, { tick: number; vel: number }[]>(); // clé = canal*128 + note
    let tick = 0;
    let status = 0;
    const closeNote = (ch: number, pitch: number, at: number) => {
      const q = open.get(ch * 128 + pitch);
      const o = q?.shift();
      if (!o) return;
      track.notes.push({ pitch, velocity: o.vel, startTick: o.tick, durationTicks: Math.max(0, at - o.tick), channel: ch });
    };
    try {
      while (tr.pos < chunkEnd) {
        tick += tr.vlq();
        let s = tr.b[tr.pos];
        if (s & 0x80) { tr.pos++; } else {
          // Running status : l'octet lu est déjà une donnée.
          if (!status) throw new MidiParseError('Running status sans statut précédent');
          s = status;
        }
        if (s === 0xff) {
          const type = tr.u8();
          const l = tr.vlq();
          const data = tr.bytes(l);
          if (type === 0x2f) { break; }
          if (type === 0x51 && l >= 3) {
            const us = (data[0] << 16) | (data[1] << 8) | data[2];
            if (us > 0) tempos.push({ tick, usPerQuarter: us, bpm: usToBpm(us) });
          } else if (type === 0x58 && l >= 2) {
            sigs.push({ tick, numerator: data[0], denominator: 2 ** data[1] });
          } else if (type === 0x03 && track.name === undefined) {
            const name = decodeText(data).replace(/\0+$/, '').trim();
            if (name) track.name = name;
          }
          // Les méta-événements n'altèrent pas le running status (spécification : ils l'annulent ; sans effet en pratique).
          continue;
        }
        if (s === 0xf0 || s === 0xf7) { const l = tr.vlq(); tr.bytes(l); status = 0; continue; }
        if (s >= 0xf8) continue; // temps réel : sans données
        if (s >= 0xf1) { const sz = s === 0xf2 ? 2 : (s === 0xf1 || s === 0xf3) ? 1 : 0; tr.bytes(sz); status = 0; continue; }
        status = s;
        const kind = s & 0xf0;
        const ch = s & 0x0f;
        const d1 = tr.u8() & 0x7f;
        if (kind === 0xc0 || kind === 0xd0) {
          if (kind === 0xc0 && track.program === undefined && ch !== DRUM_CHANNEL) track.program = d1;
          continue;
        }
        const d2 = tr.u8() & 0x7f;
        if (kind === 0x90 && d2 > 0) {
          const key = ch * 128 + d1;
          const q = open.get(key) || [];
          q.push({ tick, vel: d2 });
          open.set(key, q);
        } else if (kind === 0x80 || kind === 0x90) {
          closeNote(ch, d1, tick);
        }
      }
    } catch (e) {
      // Piste abîmée : on garde ce qui a été lu (comme les autres DAW).
      if (!(e instanceof MidiParseError)) throw e;
    }
    // Notes jamais relâchées : fermées en fin de piste.
    open.forEach((q, key) => q.forEach(o => track.notes.push({ pitch: key % 128, velocity: o.vel, startTick: o.tick, durationTicks: Math.max(1, tick - o.tick), channel: Math.floor(key / 128) })));
    track.notes.sort((a, c) => a.startTick - c.startTick || a.pitch - c.pitch);
    endTick = Math.max(endTick, tick);
    tracks.push(track);
    r.pos = chunkEnd;
  }

  tempos.sort((a, c) => a.tick - c.tick);
  sigs.sort((a, c) => a.tick - c.tick);
  return {
    format: (format === 0 || format === 2 ? format : 1) as 0 | 1 | 2,
    ppq,
    tracks,
    tempos: dedupeByTick(tempos),
    timeSignatures: dedupeByTick(sigs),
    endTick,
  };
}

/** Deux changements au même tick : le dernier gagne. */
function dedupeByTick<T extends { tick: number }>(list: T[]): T[] {
  const out: T[] = [];
  for (const e of list) { if (out.length && out[out.length - 1].tick === e.tick) out[out.length - 1] = e; else out.push(e); }
  return out;
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export interface WriteOptions {
  /** 1 (défaut) : une piste de tempo puis une piste par piste ; 0 : tout dans une seule piste. */
  format?: 0 | 1;
  /** Omet les octets de statut répétés et écrit les Note Off en Note On vélocité 0 (défaut : oui). */
  runningStatus?: boolean;
  /** Nom du morceau (piste de tempo). */
  title?: string;
}

const vlqBytes = (v: number): number[] => {
  v = Math.max(0, Math.floor(v));
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80);
  return out;
};

const textBytes = (s: string): number[] => Array.from(new TextEncoder().encode(s));

type Ev = { tick: number; order: number; bytes: number[]; status?: number };

/** Événements d'une piste, triés : à tick égal, méta, Note Off puis Note On. */
function trackEvents(tr: MidiFileTrack, extraMeta: Ev[] = []): Ev[] {
  const evs: Ev[] = [...extraMeta];
  if (tr.name) evs.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlqBytes(textBytes(tr.name).length), ...textBytes(tr.name)] });
  const chans = new Set(tr.notes.map(n => n.channel & 0x0f));
  if (tr.program !== undefined) chans.forEach(ch => { if (ch !== DRUM_CHANNEL) evs.push({ tick: 0, order: 1, status: 0xc0 | ch, bytes: [tr.program! & 0x7f] }); });
  for (const n of tr.notes) {
    const ch = n.channel & 0x0f;
    const p = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const v = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const s = Math.max(0, Math.round(n.startTick));
    const e = s + Math.max(1, Math.round(n.durationTicks));
    evs.push({ tick: s, order: 3, status: 0x90 | ch, bytes: [p, v] });
    evs.push({ tick: e, order: 2, status: 0x80 | ch, bytes: [p, 0x40] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  return evs;
}

function encodeTrack(evs: Ev[], runningStatus: boolean): number[] {
  const out: number[] = [];
  let last = 0;
  let running = 0;
  for (const e of evs) {
    out.push(...vlqBytes(e.tick - last));
    last = e.tick;
    if (e.status === undefined) { out.push(...e.bytes); running = 0; continue; }
    let status = e.status;
    let data = e.bytes;
    // Note Off écrite en Note On vélocité 0 : le statut reste le même, le running status sert.
    if (runningStatus && (status & 0xf0) === 0x80) { status = 0x90 | (status & 0x0f); data = [data[0], 0]; }
    if (!runningStatus || status !== running) out.push(status);
    running = status;
    out.push(...data);
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  return out;
}

const chunk = (id: string, body: number[]): number[] => {
  const n = body.length;
  return [...textBytes(id), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body];
};

/** Écrit un fichier .mid (format 1 par défaut). */
export function writeMidi(data: Omit<MidiFileData, 'format'> & { format?: 0 | 1 | 2 }, opts: WriteOptions = {}): Uint8Array {
  const format = opts.format ?? (data.format === 0 ? 0 : 1);
  const rs = opts.runningStatus !== false;
  const ppq = Math.max(1, Math.min(0x7fff, Math.round(data.ppq || DEFAULT_PPQ)));
  const meta: Ev[] = [];
  if (opts.title) meta.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlqBytes(textBytes(opts.title).length), ...textBytes(opts.title)] });
  const sigs = data.timeSignatures.length ? data.timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }];
  for (const s of sigs) {
    const dd = Math.max(0, Math.round(Math.log2(Math.max(1, s.denominator))));
    meta.push({ tick: Math.round(s.tick), order: 0, bytes: [0xff, 0x58, 0x04, s.numerator & 0xff, dd, 24, 8] });
  }
  const tempos = data.tempos.length ? data.tempos : [{ tick: 0, usPerQuarter: 500000, bpm: 120 }];
  for (const t of tempos) {
    const us = Math.max(1, Math.min(0xffffff, Math.round(t.usPerQuarter || bpmToUs(t.bpm))));
    meta.push({ tick: Math.round(t.tick), order: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }

  const chunks: number[][] = [];
  if (format === 0) {
    const all: MidiFileTrack = { name: data.tracks.length === 1 ? data.tracks[0].name : undefined, notes: data.tracks.flatMap(t => t.notes), program: data.tracks.find(t => t.program !== undefined)?.program };
    chunks.push(chunk('MTrk', encodeTrack(trackEvents(all, meta), rs)));
  } else {
    chunks.push(chunk('MTrk', encodeTrack(meta.sort((a, b) => a.tick - b.tick), rs)));
    for (const t of data.tracks) chunks.push(chunk('MTrk', encodeTrack(trackEvents(t), rs)));
  }
  const header = chunk('MThd', [0, format, (chunks.length >> 8) & 0xff, chunks.length & 0xff, (ppq >> 8) & 0xff, ppq & 0xff]);
  const out = new Uint8Array(header.length + chunks.reduce((s, c) => s + c.length, 0));
  out.set(header, 0);
  let o = header.length;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Temps : ticks ⇄ secondes avec la carte des tempos
// ---------------------------------------------------------------------------

/** Convertit un tick en secondes en suivant les changements de tempo. */
export function ticksToSeconds(tick: number, ppq: number, tempos: MidiTempo[]): number {
  let sec = 0, lastTick = 0, us = 500000;
  for (const t of tempos) {
    if (t.tick >= tick) break;
    sec += ((t.tick - lastTick) * us) / ppq / 1e6;
    lastTick = t.tick; us = t.usPerQuarter;
  }
  return sec + ((tick - lastTick) * us) / ppq / 1e6;
}

/** Ticks d'un instant (s) à tempo fixe. */
export const secondsToTicks = (sec: number, bpm: number, ppq: number): number => Math.round((sec * bpm / 60) * ppq);

/** Tempo au début du morceau (120 BPM si le fichier n'en dit rien). */
export const initialBpm = (d: Pick<MidiFileData, 'tempos'>): number => {
  const t = d.tempos.find(x => x.tick === 0) || d.tempos[0];
  return t ? t.bpm : 120;
};

/** Le fichier change-t-il de tempo en cours de route ? */
export const hasTempoChanges = (d: Pick<MidiFileData, 'tempos'>): boolean =>
  new Set(d.tempos.map(t => Math.round(t.bpm * 100))).size > 1;

/** Nombre total de notes. */
export const noteCount = (d: Pick<MidiFileData, 'tracks'>): number => d.tracks.reduce((s, t) => s + t.notes.length, 0);

/** Nom de fichier sans caractères interdits, terminé par .mid. */
export const midiFileName = (name: string): string =>
  `${(name || 'nova').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'nova'}.mid`;
