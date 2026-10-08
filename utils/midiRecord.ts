/**
 * Enregistrement MIDI armé (R16), comme Pro Tools, FL Studio et Live : la
 * piste MIDI armée écrit ce que tu joues au clavier MIDI (ou au clavier de
 * l'ordinateur), à la position exacte.
 *
 * Timing : chaque message Web MIDI porte son instant (`event.timeStamp`,
 * horloge `performance.now()`). On le convertit dans le temps de
 * l'AudioContext avec `getOutputTimestamp()`, qui donne le temps du son QUE
 * L'ON ENTEND à cet instant : la latence de sortie est donc compensée (tu joues
 * sur ce que tu entends), et l'arrivée tardive d'un message (USB, système,
 * navigateur occupé) ne décale rien. Un décalage réglable (Pro Tools : MIDI
 * Input Offset) corrige un clavier lent.
 *
 * Modes (Pro Tools : MIDI Merge / Replace, Loop Record ; FL : Overdub, Loop) :
 * - remplacer : la zone enregistrée est effacée puis réécrite ;
 * - fusionner : les notes s'ajoutent à celles déjà là ;
 * - boucle : la prise tourne sur la boucle ; soit une prise par tour (la
 *   dernière jouée, les autres muettes en dessous, à comparer), soit tous les
 *   tours fusionnés (on empile batterie, puis charley…).
 * Punch, pré-roll et décompte : seule la zone gardée est écrite. Quantification
 * à l'entrée en option (Pro Tools : Input Quantize).
 *
 * Logique pure : tests/midiRecord.test.ts.
 */
import { Clip, MidiNote, TrackType } from '../types';
import { MidiCcMap, MidiCcPoint, ccDefault, ccValueAt, replacePoints, shiftCc, sortPoints, thinPoints } from './midiCc';

/** Pistes qui enregistrent du MIDI (synthé, 808, sampler, batterie, instrument VST). */
export const isMidiRecordTrack = (t: { type: TrackType } | null | undefined): boolean =>
  !!t && (t.type === TrackType.MIDI || t.type === TrackType.SAMPLER || t.type === TrackType.DRUM_RACK || t.type === TrackType.MELODIC_SAMPLER);

// ---------------------------------------------------------------------------
// Préférences
// ---------------------------------------------------------------------------

export type MidiRecMode = 'replace' | 'merge' | 'loop';
export type LoopRecStyle = 'takes' | 'merge';

export interface MidiRecPrefs {
  mode: MidiRecMode;
  /** En boucle : une prise par tour, ou tout fusionner. */
  loopStyle: LoopRecStyle;
  /** Quantification à l'entrée (Pro Tools : Input Quantize). */
  quantizeOnInput: boolean;
  /** Grille de quantification en temps (0,25 = double-croche). */
  quantizeGrid: number;
  /** Force 0-1. */
  quantizeStrength: number;
  /** La piste armée joue ce que tu joues (MIDI Thru). */
  thru: boolean;
  /** Décalage MIDI en ms (+ = notes placées plus tôt), comme MIDI Input Offset. */
  offsetMs: number;
}

export const DEFAULT_MIDI_REC_PREFS: MidiRecPrefs = {
  mode: 'merge', loopStyle: 'takes', quantizeOnInput: false, quantizeGrid: 0.25, quantizeStrength: 1, thru: true, offsetMs: 0,
};

const PREFS_KEY = 'nova.midiRec';

export function loadMidiRecPrefs(): MidiRecPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return normalizeMidiRecPrefs(raw);
  } catch { return { ...DEFAULT_MIDI_REC_PREFS }; }
}

export function normalizeMidiRecPrefs(raw: any): MidiRecPrefs {
  const d = DEFAULT_MIDI_REC_PREFS;
  const num = (v: any, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def);
  return {
    mode: raw?.mode === 'replace' || raw?.mode === 'loop' || raw?.mode === 'merge' ? raw.mode : d.mode,
    loopStyle: raw?.loopStyle === 'merge' ? 'merge' : 'takes',
    quantizeOnInput: !!raw?.quantizeOnInput,
    quantizeGrid: num(raw?.quantizeGrid, d.quantizeGrid, 1 / 16, 4),
    quantizeStrength: num(raw?.quantizeStrength, d.quantizeStrength, 0, 1),
    thru: raw?.thru === undefined ? d.thru : !!raw.thru,
    offsetMs: num(raw?.offsetMs, 0, -200, 200),
  };
}

export function saveMidiRecPrefs(p: MidiRecPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ }
}

export const MODE_LABELS: Record<MidiRecMode, { label: string; hint: string }> = {
  replace: { label: 'Remplacer', hint: 'La zone enregistrée est effacée puis réécrite (Pro Tools : MIDI Merge éteint, FL : Replace).' },
  merge: { label: 'Fusionner', hint: 'Tes notes s’ajoutent à celles déjà là (Pro Tools : MIDI Merge, FL : Overdub, Live : MIDI Arrangement Overdub).' },
  loop: { label: 'Boucle', hint: 'La prise tourne sur la boucle (Pro Tools : Loop Record, FL : Loop recording).' },
};

// ---------------------------------------------------------------------------
// Temps : horodatage Web MIDI → temps de l'AudioContext → position du morceau
// ---------------------------------------------------------------------------

export interface OutputStamp { contextTime: number; performanceTime: number }

/**
 * Instant (temps de l'AudioContext) du son qu'on ENTENDAIT quand le message
 * MIDI a été émis.
 * - Avec `getOutputTimestamp()` : contextTime + (ts − performanceTime).
 * - Sinon : maintenant − âge du message − latence de sortie.
 * `offsetMs` (préférence) avance (+) ou recule (−) les notes.
 */
export function midiTimestampToContextTime(ts: number | undefined, o: {
  stamp?: OutputStamp | null; ctxNow: number; perfNow: number; outputLatency?: number; offsetMs?: number;
  /** Écart d'horloges stabilisé (ClockOffset), prioritaire sur `stamp`. */
  clockOffset?: number | null;
}): number {
  const t = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : o.perfNow;
  const off = (o.offsetMs || 0) / 1000;
  if (typeof o.clockOffset === 'number' && Number.isFinite(o.clockOffset)) return o.clockOffset + t / 1000 - off;
  const s = o.stamp;
  if (s && Number.isFinite(s.contextTime) && Number.isFinite(s.performanceTime) && s.performanceTime > 0) {
    return s.contextTime + (t - s.performanceTime) / 1000 - off;
  }
  return o.ctxNow - (o.perfNow - t) / 1000 - (o.outputLatency || 0) - off;
}

/**
 * Écart entre l'horloge du son et celle de performance.now() (s), estimé sur
 * les dernières secondes. Un seul `getOutputTimestamp()` tremble de ±1,4 ms
 * (mesuré dans Chrome : le temps du son avance par blocs) ; la MÉDIANE de
 * quelques dizaines de relevés est stable à quelques centièmes de ms, et suit
 * la lente dérive des deux horloges.
 */
export class ClockOffset {
  private samples: { at: number; off: number }[] = [];
  constructor(private windowMs = 3000, private max = 96) {}

  /** `off` = contextTime − performanceTime / 1000 ; `atMs` = performance.now(). */
  push(off: number, atMs: number) {
    if (!Number.isFinite(off)) return;
    this.samples.push({ at: atMs, off });
    const cut = atMs - this.windowMs;
    while (this.samples.length > this.max || (this.samples.length > 8 && this.samples[0].at < cut)) this.samples.shift();
  }

  get count() { return this.samples.length; }

  /** Médiane des relevés (null sans relevé). */
  value(): number | null {
    if (!this.samples.length) return null;
    const v = this.samples.map(x => x.off).sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  clear() { this.samples = []; }
}

/** Une note jouée un peu avant le début de la zone (ou du tour suivant) est ramenée dessus. */
export const PICKUP = 0.04;

export interface LoopRange { start: number; end: number }

/**
 * Position linéaire (temps écoulé depuis le début du morceau, comme si la
 * boucle n'existait pas) → tour de boucle et position dans le morceau.
 */
export function foldLoop(linear: number, loop: LoopRange | null | undefined, pickup = 0): { pass: number; pos: number } {
  if (!loop || !(loop.end - loop.start > 1e-6)) return { pass: 0, pos: linear };
  const L = loop.end - loop.start;
  // Un peu avant la fin d'un tour : c'est le temps 1 du tour suivant.
  if (linear < loop.end) {
    if (pickup > 0 && linear >= loop.end - pickup && linear >= loop.start) return { pass: 1, pos: loop.start };
    return { pass: 0, pos: linear };
  }
  const k = Math.floor((linear - loop.end) / L + 1e-9);
  let pos = loop.start + (linear - loop.end) - k * L;
  let pass = k + 1;
  if (pickup > 0 && loop.end - pos <= pickup) { pass++; pos = loop.start; }
  return { pass, pos: Math.max(loop.start, Math.min(loop.end, pos)) };
}

// ---------------------------------------------------------------------------
// Prise
// ---------------------------------------------------------------------------

export interface RecNote {
  pitch: number;
  /** 1-127 */
  velocity: number;
  /** Position dans le morceau (s). */
  start: number;
  duration: number;
  pass: number;
}

export type SongCc = Record<string, MidiCcPoint[]>;

export interface TakePass {
  pass: number;
  notes: RecNote[];
  /** Contrôleurs en temps du morceau. */
  cc: SongCc;
  /** Tour joué jusqu'au bout (boucle) : arrêter au milieu d'un tour ne le rend pas actif. */
  complete?: boolean;
}

export interface MidiTake {
  passes: TakePass[];
  loop: LoopRange | null;
  /** Zone gardée (morceau). */
  from: number;
  to: number;
}

interface OpenNote { pitch: number; velocity: number; pass: number; pos: number; linear: number }
interface RawCc { key: string; v: number; linear: number; pass: number; pos: number }

/**
 * Enregistreur d'une prise : reçoit les messages en temps LINÉAIRE (secondes
 * écoulées depuis le début du morceau, boucle dépliée) et rend des notes en
 * temps du morceau, tour par tour.
 */
export class MidiTakeRecorder {
  private open = new Map<number, OpenNote>();
  private notes: RecNote[] = [];
  private ccs: RawCc[] = [];
  readonly loop: LoopRange | null;
  readonly keepFrom: number | null;
  readonly keepTo: number | null;
  readonly recStart: number;

  constructor(opts: { recStart: number; loop?: LoopRange | null; keepFrom?: number | null; keepTo?: number | null }) {
    this.recStart = opts.recStart;
    this.loop = opts.loop && opts.loop.end - opts.loop.start > 1e-6 ? opts.loop : null;
    this.keepFrom = opts.keepFrom ?? null;
    this.keepTo = opts.keepTo ?? null;
  }

  private fold(linear: number) {
    return foldLoop(linear, this.loop, this.loop ? PICKUP : 0);
  }

  noteOn(pitch: number, velocity: number, linear: number) {
    if (this.open.has(pitch)) this.noteOff(pitch, linear);
    const f = this.fold(linear);
    this.open.set(pitch, { pitch, velocity: Math.max(1, Math.min(127, Math.round(velocity))), pass: f.pass, pos: f.pos, linear });
  }

  noteOff(pitch: number, linear: number) {
    const o = this.open.get(pitch);
    if (!o) return;
    this.open.delete(pitch);
    this.notes.push(this.close(o, linear));
  }

  private close(o: OpenNote, linear: number): RecNote {
    let dur = Math.max(0.005, linear - o.linear);
    // Une note tenue au-delà de la fin de boucle s'arrête à la fin du tour.
    if (this.loop) dur = Math.min(dur, Math.max(0.005, this.loop.end - o.pos));
    return { pitch: o.pitch, velocity: o.velocity, start: o.pos, duration: dur, pass: o.pass };
  }

  /** Contrôleur : clé « pb », « at » ou « ccN », valeur MIDI brute. */
  control(key: string, value: number, linear: number) {
    const f = this.loop ? foldLoop(linear, this.loop, 0) : { pass: 0, pos: linear };
    this.ccs.push({ key, v: Math.round(value), linear, pass: f.pass, pos: f.pos });
  }

  /** Notes en cours (affichage pendant la prise). */
  preview(linear: number): RecNote[] {
    return [...this.notes, ...Array.from(this.open.values()).map(o => this.close(o, linear))];
  }

  get noteCount() { return this.notes.length + this.open.size; }

  /** Ferme les notes tenues et rend la prise (zone gardée seulement). */
  finish(linearEnd: number): MidiTake {
    Array.from(this.open.keys()).forEach(p => this.noteOff(p, linearEnd));
    const loop = this.loop;
    const from = this.keepFrom ?? (loop ? loop.start : this.recStart);
    const to = this.keepTo ?? (loop ? loop.end : Math.max(from, linearEnd));
    const keepNote = (n: RecNote): RecNote | null => {
      let s = n.start, d = n.duration;
      if (s < from) {
        if (from - s > PICKUP) return null;
        d = Math.max(0.005, d - (from - s));
        s = from;
      }
      if (s >= to - 1e-9) return null;
      d = Math.min(d, to - s);
      return { ...n, start: s, duration: Math.max(0.005, d) };
    };
    const byPass = new Map<number, TakePass>();
    const passOf = (k: number) => {
      let p = byPass.get(k);
      if (!p) { p = { pass: k, notes: [], cc: {} }; byPass.set(k, p); }
      return p;
    };
    for (const n of this.notes) {
      const k = keepNote(n);
      if (k) passOf(n.pass).notes.push(k);
    }
    // Contrôleurs : points de la zone, plus la valeur tenue au début de chaque tour (chasse).
    const keys = Array.from(new Set(this.ccs.map(c => c.key)));
    const passes = Array.from(new Set([...byPass.keys(), ...this.ccs.filter(c => c.pos >= from - 1e-9 && c.pos < to).map(c => c.pass)])).sort((a, b) => a - b);
    for (const key of keys) {
      const evs = this.ccs.filter(c => c.key === key).sort((a, b) => a.linear - b.linear);
      for (const k of passes) {
        const passStartLinear = k === 0 || !loop ? from : loop.end + (k - 1) * (loop.end - loop.start);
        const passStartPos = k === 0 || !loop ? from : loop.start;
        const inPass = evs.filter(c => c.pass === k && c.pos >= from - 1e-9 && c.pos < to - 1e-9 && c.linear >= passStartLinear - 1e-9).map(c => ({ t: c.pos, v: c.v }));
        const before = evs.filter(c => c.linear < passStartLinear - 1e-9);
        const held = before.length ? before[before.length - 1].v : null;
        const pts: MidiCcPoint[] = [];
        if (held !== null && held !== ccDefault(key) && !(inPass[0] && inPass[0].t <= passStartPos + 1e-9)) pts.push({ t: passStartPos, v: held });
        pts.push(...inPass);
        if (pts.length) passOf(k).cc[key] = thinPoints(pts);
      }
    }
    if (loop) {
      const L = loop.end - loop.start;
      byPass.forEach(p => { p.complete = linearEnd >= loop.end + p.pass * L - PICKUP; });
    }
    const out = Array.from(byPass.values()).filter(p => p.notes.length || Object.keys(p.cc).length).sort((a, b) => a.pass - b.pass);
    out.forEach(p => p.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch));
    return { passes: out, loop, from, to };
  }
}

// ---------------------------------------------------------------------------
// Quantification à l'entrée
// ---------------------------------------------------------------------------

/** Débuts de notes rapprochés de la grille (`grid` en s, depuis le début du morceau). */
export function quantizeRecNotes<T extends { start: number }>(notes: T[], grid: number, strength = 1): T[] {
  if (!(grid > 0) || !(strength > 0)) return notes;
  const s = Math.max(0, Math.min(1, strength));
  return notes.map(n => {
    const target = Math.round(n.start / grid) * grid;
    return { ...n, start: Math.max(0, n.start + (target - n.start) * s) };
  });
}

// ---------------------------------------------------------------------------
// Écriture de la prise dans les clips de la piste
// ---------------------------------------------------------------------------

export interface ApplyTakeOpts {
  mode: 'replace' | 'merge';
  /** Zone enregistrée (remplacer : effacée). */
  range: { start: number; end: number };
  /** Durée d'une mesure (s) : un nouveau clip commence et finit sur une mesure. */
  bar: number;
  quantize?: { grid: number; strength: number } | null;
  stamp: string;
  takeNumber: number;
  name: string;
  color: string;
}

export interface ApplyResult {
  clips: Clip[];
  /** Clip qui a reçu la prise. */
  clipId: string | null;
  added: number;
  removed: number;
}

const isMidiClip = (c: Clip) => c.type === TrackType.MIDI && Array.isArray(c.notes);

const toMidiNotes = (notes: RecNote[], origin: number, stamp: string, base = 0): MidiNote[] =>
  notes.map((n, i) => ({
    id: `rec-${stamp}-${base + i}`, pitch: n.pitch, start: Math.max(0, n.start - origin), duration: n.duration,
    velocity: Math.max(1 / 127, Math.min(1, n.velocity / 127)),
  }));

const songCcToClip = (cc: SongCc, origin: number): MidiCcMap => {
  const out: MidiCcMap = {};
  for (const [k, pts] of Object.entries(cc)) if (pts.length) out[k] = pts.map(p => ({ t: Math.max(0, p.t - origin), v: p.v }));
  return out;
};

/** Efface la zone [a, b[ des clips MIDI (notes qui y commencent, contrôleurs). */
export function eraseMidiZone(clips: Clip[], a: number, b: number): { clips: Clip[]; removed: number } {
  let removed = 0;
  const out: Clip[] = [];
  for (const c of clips) {
    if (!isMidiClip(c) || c.start >= b || c.start + c.duration <= a) { out.push(c); continue; }
    const ra = a - c.start, rb = b - c.start;
    const notes: MidiNote[] = [];
    for (const n of c.notes || []) {
      if (n.start >= ra - 1e-9 && n.start < rb - 1e-9) { removed++; continue; }
      if (n.start < ra && n.start + n.duration > ra) notes.push({ ...n, duration: Math.max(0.005, ra - n.start) });
      else notes.push(n);
    }
    let cc: MidiCcMap | undefined;
    if (c.cc) {
      cc = {};
      for (const [k, pts] of Object.entries(c.cc)) {
        const s = sortPoints(pts);
        const heldAfter = ccValueAt(s, rb, ccDefault(k));
        const kept = s.filter(p => p.t < ra - 1e-9 || p.t >= rb - 1e-9);
        // Ce qui suit la zone garde sa valeur : point de reprise en fin de zone.
        if (rb < c.duration && heldAfter !== ccValueAt(kept, rb, ccDefault(k)) && !kept.some(p => Math.abs(p.t - rb) < 1e-9)) kept.push({ t: rb, v: heldAfter });
        if (kept.length) cc[k] = sortPoints(kept);
      }
      if (!Object.keys(cc).length) cc = undefined;
    }
    const inside = c.start >= a - 1e-9 && c.start + c.duration <= b + 1e-9;
    if (inside && !notes.length && !cc) continue;
    out.push({ ...c, notes, ...(c.cc || cc ? { cc } : {}) });
  }
  return { clips: out, removed };
}

/**
 * Écrit une prise (notes et contrôleurs en temps du morceau) sur la piste.
 * - remplacer : la zone est effacée d'abord ;
 * - fusionner : les notes rejoignent le clip MIDI qui couvre le passage
 *   (agrandi au besoin), sinon un nouveau clip calé sur les mesures.
 * Rien d'enregistré : rien ne change (un REC par erreur n'efface rien).
 */
export function applyMidiTake(clips: Clip[], rawNotes: RecNote[], cc: SongCc, opts: ApplyTakeOpts): ApplyResult {
  const ccKeys = Object.keys(cc).filter(k => cc[k]?.length);
  if (!rawNotes.length && !ccKeys.length) return { clips, clipId: null, added: 0, removed: 0 };
  const notes = opts.quantize ? quantizeRecNotes(rawNotes, opts.quantize.grid, opts.quantize.strength) : rawNotes;
  let removed = 0;
  let work = clips;
  if (opts.mode === 'replace') {
    const r = eraseMidiZone(clips, opts.range.start, opts.range.end);
    work = r.clips;
    removed = r.removed;
  }
  const allT = [...notes.map(n => n.start), ...ccKeys.flatMap(k => cc[k].map(p => p.t))];
  const takeStart = Math.min(...allT);
  const takeEnd = Math.max(takeStart + 0.005, ...notes.map(n => n.start + n.duration), ...ccKeys.flatMap(k => cc[k].map(p => p.t)));
  const bar = opts.bar > 0 ? opts.bar : 2;
  const floorBar = (t: number) => Math.max(0, Math.floor(t / bar + 1e-6) * bar);
  const ceilBar = (t: number) => Math.ceil(t / bar - 1e-6) * bar;

  // Clip hôte : le clip MIDI qui recouvre le plus la prise.
  let host: Clip | null = null, best = 0;
  for (const c of work) {
    if (!isMidiClip(c)) continue;
    const ov = Math.min(c.start + c.duration, takeEnd) - Math.max(c.start, takeStart);
    if (ov > best + 1e-9 || (ov >= 0 && !host && c.start <= takeStart + 1e-9 && c.start + c.duration >= takeStart - 1e-9)) { best = Math.max(best, ov); host = c; }
  }

  if (host) {
    const newStart = takeStart < host.start - 1e-9 ? Math.min(host.start, floorBar(takeStart)) : host.start;
    const shift = host.start - newStart;
    const newEnd = Math.max(host.start + host.duration, takeEnd > host.start + host.duration + 1e-9 ? ceilBar(takeEnd) : 0);
    const old = (host.notes || []).map(n => (shift ? { ...n, start: n.start + shift } : n));
    const added = toMidiNotes(notes, newStart, opts.stamp);
    let hostCc = shift ? shiftCc(host.cc, shift) : host.cc;
    if (ccKeys.length) {
      const fresh = songCcToClip(cc, newStart);
      const next: MidiCcMap = { ...(hostCc || {}) };
      for (const k of Object.keys(fresh)) {
        const pts = fresh[k];
        next[k] = replacePoints(next[k], pts[0].t, pts[pts.length - 1].t, pts);
      }
      hostCc = next;
    }
    const updated: Clip = { ...host, start: newStart, duration: newEnd - newStart, notes: [...old, ...added], ...(hostCc ? { cc: hostCc } : {}) };
    return { clips: work.map(c => (c.id === host!.id ? updated : c)), clipId: host.id, added: added.length, removed };
  }

  const start = floorBar(takeStart);
  const end = Math.max(start + bar, ceilBar(takeEnd));
  const id = `clip-midi-${opts.stamp}`;
  const clipCc = ccKeys.length ? songCcToClip(cc, start) : undefined;
  const clip: Clip = {
    id, start, duration: end - start, offset: 0, fadeIn: 0, fadeOut: 0, name: opts.name, color: opts.color,
    type: TrackType.MIDI, notes: toMidiNotes(notes, start, opts.stamp), isMuted: false, gain: 1, takeNumber: opts.takeNumber,
    ...(clipCc ? { cc: clipCc } : {}),
  };
  return { clips: [...work, clip], clipId: id, added: clip.notes!.length, removed };
}

/** Contrôleurs de plusieurs tours fusionnés : chaque tour réécrit ce qu'il couvre. */
export function mergePassesCc(passes: TakePass[]): SongCc {
  const out: SongCc = {};
  for (const p of passes) {
    for (const [k, pts] of Object.entries(p.cc)) {
      if (!pts.length) continue;
      out[k] = replacePoints(out[k], pts[0].t, pts[pts.length - 1].t, pts);
    }
  }
  return out;
}

export interface LoopTakeResult extends ApplyResult {
  /** Nombre de tours gardés comme prises. */
  takes: number;
  activeClipId: string | null;
}

/**
 * Boucle : « une prise par tour » (le dernier tour joué est actif, les
 * autres restent dessous, muets, pour comparer ; Pro Tools : Loop Record) ou
 * « tout fusionner » (overdub en boucle de FL et Live).
 */
export function applyLoopTake(clips: Clip[], take: MidiTake, opts: Omit<ApplyTakeOpts, 'mode' | 'range'> & { style: LoopRecStyle; mergeMode?: 'merge' | 'replace' }): LoopTakeResult {
  const loop = take.loop;
  const passes = take.passes;
  if (!loop || !passes.length) return { clips, clipId: null, added: 0, removed: 0, takes: 0, activeClipId: null };
  if (opts.style === 'merge') {
    const r = applyMidiTake(clips, passes.flatMap(p => p.notes), mergePassesCc(passes), { ...opts, mode: opts.mergeMode || 'merge', range: loop });
    return { ...r, takes: 1, activeClipId: r.clipId };
  }
  if (passes.length === 1) {
    const r = applyMidiTake(clips, passes[0].notes, passes[0].cc, { ...opts, mode: 'replace', range: loop });
    return { ...r, takes: 1, activeClipId: r.clipId };
  }
  const erased = eraseMidiZone(clips, loop.start, loop.end);
  const L = loop.end - loop.start;
  let added = 0;
  // Prise active : le dernier tour complet (arrêter au milieu d'un tour garde le précédent).
  let activeIdx = passes.length - 1;
  for (let i = passes.length - 1; i >= 0; i--) if (passes[i].complete !== false) { activeIdx = i; break; }
  const takeClips: Clip[] = passes.map((p, i) => {
    const notes = opts.quantize ? quantizeRecNotes(p.notes, opts.quantize.grid, opts.quantize.strength) : p.notes;
    const active = i === activeIdx;
    added += active ? notes.length : 0;
    const clipCc = Object.keys(p.cc).length ? songCcToClip(p.cc, loop.start) : undefined;
    return {
      id: `clip-midi-${opts.stamp}-t${i + 1}`, start: loop.start, duration: L, offset: 0, fadeIn: 0, fadeOut: 0,
      name: `Prise ${opts.takeNumber + i}`, color: opts.color, type: TrackType.MIDI,
      notes: toMidiNotes(notes, loop.start, `${opts.stamp}-t${i + 1}`), gain: 1, takeNumber: opts.takeNumber + i,
      isMuted: !active, ...(clipCc ? { cc: clipCc } : {}),
    } as Clip;
  });
  const activeClipId = takeClips[activeIdx].id;
  return { clips: [...erased.clips, ...takeClips], clipId: activeClipId, added, removed: erased.removed, takes: takeClips.length, activeClipId };
}
