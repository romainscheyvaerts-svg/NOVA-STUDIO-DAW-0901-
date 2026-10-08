/**
 * Clavier de l'ordinateur = clavier MIDI (V14), comme le Computer MIDI
 * Keyboard d'Ableton Live et le Typing Keyboard to Piano de FL Studio.
 *
 * Les touches sont lues par POSITION physique (`KeyboardEvent.code`) : la
 * forme du piano reste la même en QWERTY et en AZERTY.
 *   rangée du milieu  A S D F G H J K L ; '  → touches blanches (Do Ré Mi…)
 *   rangée du dessus  W E   T Y U   O P      → touches noires
 *   Z / X : octave − / +        C / V : vélocité − / +
 * (en AZERTY : Q S D F G H J K L M ù pour les blanches, Z E T Y U O P pour
 *  les noires, W / X pour l'octave, C / V pour la vélocité).
 */

/** Demi-tons au-dessus du Do de l'octave courante, par code de touche. */
export const KEY_TO_SEMITONE: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

export const OCTAVE_DOWN = 'KeyZ';
export const OCTAVE_UP = 'KeyX';
export const VELOCITY_DOWN = 'KeyC';
export const VELOCITY_UP = 'KeyV';

/** Codes captés quand le clavier est actif (et SEULEMENT quand il l'est). */
export const isComputerKeyboardCode = (code: string): boolean =>
  code in KEY_TO_SEMITONE || code === OCTAVE_DOWN || code === OCTAVE_UP || code === VELOCITY_DOWN || code === VELOCITY_UP;

/** Lettre affichée par défaut (QWERTY) ; l'interface la remplace par celle du clavier réel si le navigateur la donne. */
export const defaultKeyLabel = (code: string): string =>
  code === 'Semicolon' ? ';' : code === 'Quote' ? "'" : code.replace(/^Key/, '');

export const MIN_OCTAVE = -1;
export const MAX_OCTAVE = 8;
/** Paliers de vélocité (comme Live : 20, 40… 127). */
export const VELOCITY_STEPS = [20, 40, 60, 80, 100, 127];

export interface KeyboardState {
  /** Octave du Do de la touche A (3 → Do3 = MIDI 60, comme Live). */
  octave: number;
  /** Vélocité MIDI 1-127. */
  velocity: number;
}

export const DEFAULT_KEYBOARD_STATE: KeyboardState = { octave: 3, velocity: 100 };

export type KeyboardAction =
  | { type: 'noteOn'; pitch: number; velocity: number }
  | { type: 'noteOff'; pitch: number }
  | { type: 'state'; state: KeyboardState }
  | { type: 'none' };

/** Do de l'octave → note MIDI (Do3 = 60). */
export const octaveBase = (octave: number) => (octave + 2) * 12;

const clampVelocityStep = (v: number, dir: 1 | -1) => {
  if (dir > 0) return VELOCITY_STEPS.find(s => s > v) ?? 127;
  const lower = VELOCITY_STEPS.filter(s => s < v);
  return lower.length ? lower[lower.length - 1] : VELOCITY_STEPS[0];
};

/**
 * Petit automate : gère les touches tenues (une note ne se rejoue pas à la
 * répétition automatique) et relâche la BONNE note même si l'octave a changé
 * entre l'appui et le relâchement.
 */
export class ComputerKeyboard {
  state: KeyboardState;
  private held = new Map<string, number>();

  constructor(state: KeyboardState = DEFAULT_KEYBOARD_STATE) {
    this.state = { ...state };
  }

  keyDown(code: string, repeat = false): KeyboardAction {
    if (code === OCTAVE_DOWN || code === OCTAVE_UP) {
      if (repeat) return { type: 'none' };
      const octave = Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, this.state.octave + (code === OCTAVE_UP ? 1 : -1)));
      this.state = { ...this.state, octave };
      return { type: 'state', state: this.state };
    }
    if (code === VELOCITY_DOWN || code === VELOCITY_UP) {
      if (repeat) return { type: 'none' };
      this.state = { ...this.state, velocity: clampVelocityStep(this.state.velocity, code === VELOCITY_UP ? 1 : -1) };
      return { type: 'state', state: this.state };
    }
    const semi = KEY_TO_SEMITONE[code];
    if (semi === undefined) return { type: 'none' };
    if (repeat || this.held.has(code)) return { type: 'none' };
    const pitch = octaveBase(this.state.octave) + semi;
    if (pitch < 0 || pitch > 127) return { type: 'none' };
    this.held.set(code, pitch);
    return { type: 'noteOn', pitch, velocity: this.state.velocity };
  }

  keyUp(code: string): KeyboardAction {
    const pitch = this.held.get(code);
    if (pitch === undefined) return { type: 'none' };
    this.held.delete(code);
    return { type: 'noteOff', pitch };
  }

  /** Relâche tout (perte de focus, clavier coupé) : renvoie les notes à arrêter. */
  releaseAll(): number[] {
    const out = Array.from(this.held.values());
    this.held.clear();
    return out;
  }

  heldPitches(): number[] {
    return Array.from(this.held.values());
  }
}

/**
 * Enregistrement des notes jouées au clavier : chaque note commence à
 * l'appui et finit au relâchement (temps du projet, en secondes).
 */
export interface RecordedNote { pitch: number; start: number; duration: number; velocity: number }

export class NoteRecorder {
  private open = new Map<number, { start: number; velocity: number }>();
  notes: RecordedNote[] = [];

  noteOn(pitch: number, time: number, velocity: number) {
    if (this.open.has(pitch)) this.noteOff(pitch, time);
    this.open.set(pitch, { start: time, velocity });
  }

  noteOff(pitch: number, time: number) {
    const o = this.open.get(pitch);
    if (!o) return;
    this.open.delete(pitch);
    this.notes.push({ pitch, start: o.start, duration: Math.max(0.02, time - o.start), velocity: o.velocity });
  }

  /** Ferme les notes encore tenues et rend tout ce qui a été joué. */
  finish(time: number): RecordedNote[] {
    Array.from(this.open.keys()).forEach(p => this.noteOff(p, time));
    const out = this.notes;
    this.notes = [];
    return out;
  }

  /** Notes en cours (pour l'affichage pendant la prise). */
  pending(time: number): RecordedNote[] {
    return [
      ...this.notes,
      ...Array.from(this.open.entries()).map(([pitch, o]) => ({ pitch, start: o.start, duration: Math.max(0.02, time - o.start), velocity: o.velocity })),
    ];
  }
}

// ---------------------------------------------------------------------------
// Clavier de l'ordinateur pour toute l'appli (R16) : allumé depuis la barre de
// transport (Ctrl+Maj+K) ou le piano roll, il joue sur la piste armée, sinon
// sur la piste sélectionnée, sans ouvrir le piano roll (Computer MIDI Keyboard
// de Live). Un seul automate, partagé : le piano roll n'en a plus à lui.
// ---------------------------------------------------------------------------

type KbListener = () => void;

class ComputerKeyboardStore {
  on = false;
  kb = new ComputerKeyboard();
  held: number[] = [];
  /** Piste imposée (piano roll ouvert) : le clavier joue sur elle. */
  forcedTrackId: string | null = null;
  private listeners = new Set<KbListener>();

  get state(): KeyboardState { return this.kb.state; }

  /** Allumé depuis le piano roll : il s'éteint avec lui (comme avant R16). */
  fromRoll = false;

  setOn(on: boolean, fromRoll = false) {
    this.fromRoll = on && fromRoll;
    if (this.on === on) return;
    this.on = on;
    this.emit();
  }
  toggle() { this.setOn(!this.on); }

  setHeld(h: number[]) { this.held = h; this.emit(); }
  touch() { this.emit(); }

  subscribe(f: KbListener) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private emit() { this.listeners.forEach(f => { try { f(); } catch { /* */ } }); }
}

export const computerKeyboardStore = new ComputerKeyboardStore();
