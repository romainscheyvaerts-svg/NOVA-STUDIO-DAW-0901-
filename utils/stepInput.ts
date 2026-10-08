/**
 * Saisie pas à pas (R16), comme MIDI Step Input de Pro Tools et Step
 * recording de FL Studio : tu joues une note (ou un accord) et le curseur
 * avance d'une valeur choisie (noire, croche, double…), sans lecture et sans
 * pression de tempo.
 *
 * - Accord : toutes les notes enfoncées ensemble tombent au même endroit ; le
 *   curseur avance quand tu relâches tout. « Accord tenu » garde la position
 *   jusqu'à « Suivant » (pour poser un accord note par note).
 * - Silence : avance sans note. Retour : efface le dernier pas et recule.
 *
 * Logique pure (temps en secondes depuis le début du clip) : tests/stepInput.test.ts.
 */
import type { MidiNote } from '../types';

export interface StepValue { id: string; label: string; beats: number; hint: string }

export const STEP_VALUES: StepValue[] = [
  { id: '1/1', label: '𝅝 Ronde', beats: 4, hint: '4 temps' },
  { id: '1/2', label: '𝅗𝅥 Blanche', beats: 2, hint: '2 temps' },
  { id: '1/4', label: '♩ Noire', beats: 1, hint: '1 temps' },
  { id: '1/8', label: '♪ Croche', beats: 0.5, hint: '1/2 temps' },
  { id: '1/16', label: '𝅘𝅥𝅯 Double', beats: 0.25, hint: '1/4 de temps (charley trap)' },
  { id: '1/32', label: '1/32', beats: 0.125, hint: '1/8 de temps (rolls)' },
  { id: '1/8T', label: '♪ triolet', beats: 1 / 3, hint: 'croche de triolet' },
  { id: '1/16T', label: '𝅘𝅥𝅯 triolet', beats: 1 / 6, hint: 'double de triolet' },
];

export interface StepEdit {
  add?: MidiNote[];
  remove?: string[];
  /** Nouvelle position du curseur (s depuis le début du clip). */
  pos: number;
}

interface StepEntry { pos: number; ids: string[] }

export class StepInput {
  /** Position du curseur (s depuis le début du clip). */
  pos: number;
  /** Valeur d'un pas (s). */
  step: number;
  /** Durée des notes en fraction du pas (1 = legato, 0,5 = staccato). */
  gate: number;
  /** Accord tenu : la position ne bouge qu'avec next(). */
  chordHold = false;
  /** Vélocité fixe (1-127) ou null = celle jouée. */
  fixedVelocity: number | null = null;
  private held = new Set<number>();
  private current: StepEntry | null = null;
  private history: StepEntry[] = [];
  private n = 0;
  private readonly prefix: string;

  constructor(opts: { pos?: number; step: number; gate?: number; prefix?: string }) {
    this.pos = Math.max(0, opts.pos ?? 0);
    this.step = opts.step;
    this.gate = opts.gate ?? 1;
    this.prefix = opts.prefix ?? `st-${Date.now().toString(36)}`;
  }

  /** Une touche enfoncée : la note est posée tout de suite au curseur. */
  noteOn(pitch: number, velocity: number): StepEdit {
    if (!this.current) this.current = { pos: this.pos, ids: [] };
    this.held.add(pitch);
    const v = this.fixedVelocity ?? velocity;
    const note: MidiNote = {
      id: `${this.prefix}-${this.n++}`, pitch, start: this.current.pos,
      duration: Math.max(0.01, this.step * this.gate), velocity: Math.max(1, Math.min(127, v)) / 127,
    };
    this.current.ids.push(note.id);
    return { add: [note], pos: this.pos };
  }

  /** Une touche relâchée : quand tout est relâché, le curseur avance (sauf accord tenu). */
  noteOff(pitch: number): StepEdit {
    this.held.delete(pitch);
    if (this.held.size === 0 && this.current && !this.chordHold) return this.commit();
    return { pos: this.pos };
  }

  private commit(): StepEdit {
    const entry = this.current || { pos: this.pos, ids: [] };
    this.current = null;
    this.history.push(entry);
    this.pos = entry.pos + this.step;
    return { pos: this.pos };
  }

  /** Accord tenu : passe au pas suivant. */
  next(): StepEdit {
    this.held.clear();
    return this.commit();
  }

  /** Silence d'un pas. */
  rest(): StepEdit {
    if (this.current) return this.next();
    this.history.push({ pos: this.pos, ids: [] });
    this.pos += this.step;
    return { pos: this.pos };
  }

  /** Retour : efface le dernier pas (ou l'accord en cours) et recule. */
  back(): StepEdit {
    if (this.current) {
      const e = this.current;
      this.current = null;
      this.held.clear();
      this.pos = e.pos;
      return { remove: e.ids, pos: this.pos };
    }
    const e = this.history.pop();
    if (!e) return { pos: this.pos };
    this.pos = e.pos;
    return { remove: e.ids, pos: this.pos };
  }

  /** Déplace le curseur (clic dans la grille). */
  moveTo(pos: number) {
    this.pos = Math.max(0, pos);
    this.current = null;
    this.held.clear();
  }

  get holding() { return this.held.size > 0; }
}

/** Valeur d'un pas en secondes. */
export const stepSeconds = (v: StepValue, bpm: number) => v.beats * (60 / (bpm > 0 ? bpm : 120));
