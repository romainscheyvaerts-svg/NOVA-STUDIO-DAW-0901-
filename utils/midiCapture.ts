/**
 * Capture MIDI (V25), comme Capture MIDI d'Ableton Live : NOVA écoute EN
 * PERMANENCE ce que tu joues (clavier MIDI ou clavier de l'ordinateur), même
 * sans enregistrer, lecture lancée ou à l'arrêt. « Capturer » transforme ce que
 * tu viens de jouer en clip.
 *
 * - Pendant la lecture : chaque note garde sa place dans le morceau.
 * - À l'arrêt : la phrase jouée en dernier (après un silence de plus de
 *   PHRASE_GAP s) ; si le projet est vide, le tempo est deviné à partir de ce
 *   que tu as joué (comme Live).
 *
 * Logique pure (horloge et transport injectés) : tests/midiCapture.test.ts.
 */
import { MidiNote } from '../types';

export interface CapturedEvent {
  pitch: number;
  /** 1-127 */
  velocity: number;
  /** Horloge murale (s) de l'attaque et du relâchement. */
  on: number;
  off?: number;
  /** Position dans le morceau (s) si la lecture tournait, sinon null. */
  songOn: number | null;
  songOff?: number | null;
  /** Numéro de la lecture en cours (une capture prend une seule lecture). */
  playId: number;
  /** Piste qui a joué (clavier de l'ordinateur dans le piano roll). */
  trackId?: string | null;
}

export interface TransportInfo { playing: boolean; time: number }

/** Silence qui sépare deux phrases jouées à l'arrêt (s). */
export const PHRASE_GAP = 6;
/** Mémoire : 10 minutes, 4000 notes au plus. */
const MAX_AGE = 600;
const MAX_EVENTS = 4000;

export class MidiCaptureBuffer {
  private events: CapturedEvent[] = [];
  private open = new Map<number, CapturedEvent>();
  private playId = 0;
  private wasPlaying = false;
  private listeners = new Set<() => void>();

  constructor(
    private now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
    private transport: () => TransportInfo = () => ({ playing: false, time: 0 }),
  ) {}

  setTransport(fn: () => TransportInfo) { this.transport = fn; }
  setClock(fn: () => number) { this.now = fn; }

  /** À appeler quand la lecture démarre ou s'arrête : chaque lecture est une prise à part. */
  setPlaying(playing: boolean) {
    if (playing && !this.wasPlaying) this.playId++;
    this.wasPlaying = playing;
  }

  private tick(): TransportInfo {
    const tr = this.transport();
    if (tr.playing && !this.wasPlaying) this.playId++;
    this.wasPlaying = tr.playing;
    return tr;
  }

  noteOn(pitch: number, velocity: number, trackId?: string | null) {
    const tr = this.tick();
    const t = this.now();
    if (this.open.has(pitch)) this.noteOff(pitch);
    const ev: CapturedEvent = { pitch, velocity: Math.max(1, Math.min(127, Math.round(velocity))), on: t, songOn: tr.playing ? tr.time : null, playId: tr.playing ? this.playId : -1, trackId };
    this.open.set(pitch, ev);
    this.events.push(ev);
    this.prune(t);
    this.emit();
  }

  noteOff(pitch: number) {
    const ev = this.open.get(pitch);
    if (!ev) return;
    const tr = this.tick();
    this.open.delete(pitch);
    ev.off = this.now();
    ev.songOff = ev.songOn !== null && tr.playing ? tr.time : null;
  }

  private prune(t: number) {
    const cut = t - MAX_AGE;
    if (this.events.length > MAX_EVENTS || (this.events[0] && this.events[0].on < cut)) {
      this.events = this.events.filter(e => e.on >= cut).slice(-MAX_EVENTS);
    }
  }

  clear() { this.events = []; this.open.clear(); this.emit(); }

  /** Notes en mémoire (pour le badge du bouton). */
  get size() { return this.events.length; }

  /** Dernière phrase jouée (voir l'en-tête). */
  lastPhrase(): CapturedEvent[] {
    if (!this.events.length) return [];
    const last = this.events[this.events.length - 1];
    if (last.songOn !== null) return this.events.filter(e => e.playId === last.playId && e.songOn !== null);
    // À l'arrêt : on remonte tant que les attaques se suivent de près.
    const out: CapturedEvent[] = [last];
    for (let i = this.events.length - 2; i >= 0; i--) {
      const e = this.events[i];
      if (e.songOn !== null) break;
      if (out[0].on - (e.off ?? e.on) > PHRASE_GAP && out[0].on - e.on > PHRASE_GAP) break;
      out.unshift(e);
    }
    return out;
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(f => { try { f(); } catch { /* */ } }); }
}

/** Tampon partagé de l'application. */
export const midiCapture = new MidiCaptureBuffer();

// ---------------------------------------------------------------------------
// Tempo deviné et clip capturé
// ---------------------------------------------------------------------------

/**
 * Tempo le plus probable d'une suite d'attaques (s) : celui dont la grille de
 * croches colle le mieux aux attaques, entre 70 et 180 BPM ; à égalité, le
 * plus proche de 120 (rap, trap : 70-160).
 */
export function guessTempo(onsets: number[], min = 70, max = 180): number | null {
  const t = Array.from(new Set(onsets.map(x => Math.round(x * 1000) / 1000))).sort((a, b) => a - b);
  if (t.length < 3) return null;
  const t0 = t[0];
  let best: { bpm: number; score: number } | null = null;
  // Score = écart moyen à la grille de croches (fraction de case) + un peu pour
  // chaque attaque à contretemps (un tempo 1,5 × plus rapide colle aussi aux
  // croches, mais met la moitié des attaques à contretemps) + préférence 90-140.
  const scoreOf = (bpm: number) => {
    const slot = 60 / bpm / 2; // croches
    let err = 0, off = 0;
    for (const x of t) {
      const d = (x - t0) / slot;
      const k = Math.round(d);
      err += Math.abs(d - k);
      if (k % 2 !== 0) off++;
    }
    return err / t.length + (0.06 * off) / t.length + Math.abs(bpm - 120) / 6000;
  };
  for (let bpm = min; bpm <= max + 1e-9; bpm += 0.5) {
    const score = scoreOf(bpm);
    if (!best || score < best.score - 1e-9) best = { bpm, score };
  }
  if (!best || best.score > 0.25) return null;
  // Affinage à 0,05 BPM près autour du meilleur.
  let fine = best;
  for (let bpm = best.bpm - 0.5; bpm <= best.bpm + 0.5 + 1e-9; bpm += 0.05) {
    const score = scoreOf(bpm);
    if (score < fine.score) fine = { bpm, score };
  }
  return Math.round(fine.bpm * 10) / 10;
}

export interface CaptureResult {
  /** Début du clip dans le morceau (s), calé sur la mesure. */
  start: number;
  duration: number;
  notes: MidiNote[];
  /** Tempo deviné (projet vide à l'arrêt), sinon null. */
  guessedBpm: number | null;
  /** Mode : pendant la lecture ou à l'arrêt. */
  mode: 'playing' | 'stopped';
}

/**
 * Clip à créer à partir d'une phrase capturée. `projectEmpty` : on peut
 * changer le tempo du projet. `at` : position du clip à l'arrêt (tête de lecture).
 */
export function buildCapture(events: CapturedEvent[], opts: { bpm: number; beatsPerBar?: number; projectEmpty: boolean; at: number; now?: number }): CaptureResult | null {
  if (!events.length) return null;
  const bpb = opts.beatsPerBar || 4;
  const now = opts.now ?? Math.max(...events.map(e => e.off ?? e.on)) + 0.25;
  if (events[0].songOn !== null) {
    const bar = (60 / opts.bpm) * bpb;
    const first = Math.min(...events.map(e => e.songOn!));
    const start = Math.max(0, Math.floor(first / bar + 1e-6) * bar);
    const notes = events.map((e, i) => {
      const s = e.songOn! - start;
      const end = e.songOff != null && e.songOff > e.songOn! ? e.songOff : e.songOn! + ((e.off ?? now) - e.on);
      return { id: `cap-${Date.now().toString(36)}-${i}`, pitch: e.pitch, start: Math.max(0, s), duration: Math.max(0.02, end - e.songOn!), velocity: e.velocity / 127 };
    });
    const end = Math.max(...notes.map(n => n.start + n.duration));
    return { start, duration: Math.max(bar, Math.ceil(end / bar - 1e-6) * bar), notes, guessedBpm: null, mode: 'playing' };
  }
  const guessed = opts.projectEmpty ? guessTempo(events.map(e => e.on)) : null;
  const bpm = guessed || opts.bpm;
  const beat = 60 / bpm;
  const bar = beat * bpb;
  const t0 = Math.min(...events.map(e => e.on));
  const notes = events.map((e, i) => ({
    id: `cap-${Date.now().toString(36)}-${i}`, pitch: e.pitch,
    start: e.on - t0, duration: Math.max(0.02, (e.off ?? now) - e.on), velocity: e.velocity / 127,
  }));
  const end = Math.max(...notes.map(n => n.start + n.duration));
  const start = guessed ? 0 : Math.max(0, Math.round(opts.at / bar) * bar);
  return { start, duration: Math.max(bar, Math.ceil(end / bar - 1e-6) * bar), notes, guessedBpm: guessed, mode: 'stopped' };
}
