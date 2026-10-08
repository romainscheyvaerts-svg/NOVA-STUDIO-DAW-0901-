/**
 * Routeur MIDI de NOVA (R16) : tout ce que tu joues (clavier MIDI branché,
 * clavier de l'ordinateur, clavier à l'écran) passe par ici.
 *
 * - Thru (Pro Tools : MIDI Thru) : la piste armée (sinon la piste ouverte dans
 *   le piano roll, sinon la piste MIDI sélectionnée) joue la note tout de suite.
 *   La pédale de sustain tient les notes comme sur un piano.
 * - Prise armée : pendant l'enregistrement, chaque message est placé à
 *   l'instant où il a été joué (horodatage Web MIDI, voir utils/midiRecord).
 * - MIDI Learn : les CC reliés pilotent leur réglage (utils/midiLearn).
 * - Capture MIDI (V25) : tout est gardé, même sans enregistrer.
 * - Écouteurs : piano roll (notes tenues, saisie pas à pas), barre de transport.
 */
import { audioEngine } from '../engine/AudioEngine';
import { midiCapture } from '../utils/midiCapture';
import { midiLearn, LearnHit, LearnMapping } from '../utils/midiLearn';
import {
  MidiRecPrefs, loadMidiRecPrefs, saveMidiRecPrefs, normalizeMidiRecPrefs, midiTimestampToContextTime, MidiTakeRecorder, LoopRange, RecNote, ClockOffset,
} from '../utils/midiRecord';
import { SUSTAIN, pedalDown, ccNumber } from '../utils/midiCc';

export type MidiSource = 'hw' | 'kb' | 'screen';

export interface MidiInOpts {
  source: MidiSource;
  /** Horodatage (horloge performance.now()) : Web MIDI ou KeyboardEvent. */
  timeStamp?: number;
  channel?: number;
  /** CC brut (MIDI Learn). */
  cc?: number;
  /** Piste imposée (clavier du piano roll). */
  trackId?: string | null;
}

export interface MidiInEvent {
  type: 'on' | 'off' | 'control';
  pitch?: number;
  velocity?: number;
  key?: string;
  value?: number;
  source: MidiSource;
  /** Piste qui a joué (Thru). */
  trackId: string | null;
  /** Temps du contexte audio du son entendu quand la touche a été jouée. */
  ctxTime: number;
}

interface RecSession {
  trackId: string;
  /** Temps du contexte qui correspond au début du morceau (lecture lancée). */
  anchor: number;
  rec: MidiTakeRecorder;
}

export interface MidiContext {
  armedTrackId: string | null;
  selectedTrackId: string | null;
  /** Piste ouverte dans le piano roll. */
  focusTrackId: string | null;
  isMidiTrack: (id: string) => boolean;
}

class MidiInputHub {
  prefs: MidiRecPrefs = typeof localStorage !== 'undefined' ? loadMidiRecPrefs() : normalizeMidiRecPrefs({});
  private ctx: MidiContext = { armedTrackId: null, selectedTrackId: null, focusTrackId: null, isMidiTrack: () => false };
  private session: RecSession | null = null;
  private listeners = new Set<(e: MidiInEvent) => void>();
  private prefListeners = new Set<() => void>();
  private learnHandler: ((hits: LearnHit[], learned?: LearnMapping) => void) | null = null;
  /** Notes jouées en Thru : touche → piste (relâcher la bonne note même si la piste change). */
  private sounding = new Map<number, string>();
  /** Pédale enfoncée par piste, et notes relâchées qu'elle tient. */
  private pedal = new Map<string, Set<number>>();
  private lastEventAt = 0;

  setContext(c: Partial<MidiContext>) { this.ctx = { ...this.ctx, ...c }; }
  getContext() { return this.ctx; }

  setPrefs(p: Partial<MidiRecPrefs>) {
    this.prefs = normalizeMidiRecPrefs({ ...this.prefs, ...p });
    saveMidiRecPrefs(this.prefs);
    this.prefListeners.forEach(f => { try { f(); } catch { /* */ } });
  }
  onPrefs(f: () => void) { this.prefListeners.add(f); return () => { this.prefListeners.delete(f); }; }

  subscribe(f: (e: MidiInEvent) => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  setLearnHandler(f: ((hits: LearnHit[], learned?: LearnMapping) => void) | null) { this.learnHandler = f; }

  /** Piste qui joue ce qu'on joue. */
  targetTrack(forced?: string | null): string | null {
    if (forced) return forced;
    const c = this.ctx;
    if (c.armedTrackId && c.isMidiTrack(c.armedTrackId)) return c.armedTrackId;
    if (c.focusTrackId && c.isMidiTrack(c.focusTrackId)) return c.focusTrackId;
    if (c.selectedTrackId && c.isMidiTrack(c.selectedTrackId)) return c.selectedTrackId;
    return null;
  }

  // Horloges du son et de performance.now() : écart relevé régulièrement (médiane, voir ClockOffset).
  private clock = new ClockOffset();
  private clockTimer: number | null = null;
  private clockUntil = 0;

  private sampleClock(): { contextTime: number; performanceTime: number } | null {
    const ac: any = audioEngine.ctx;
    if (!ac || typeof ac.getOutputTimestamp !== 'function') return null;
    let s: { contextTime: number; performanceTime: number } | null = null;
    try { s = ac.getOutputTimestamp(); } catch { s = null; }
    if (s && s.performanceTime > 0 && ac.state === 'running') this.clock.push(s.contextTime - s.performanceTime / 1000, performance.now());
    return s;
  }

  /** Relève l'écart d'horloges toutes les 40 ms pendant `ms` (prise, jeu au clavier). */
  keepClockFresh(ms = 10000) {
    this.clockUntil = Math.max(this.clockUntil, performance.now() + ms);
    if (this.clockTimer !== null || typeof window === 'undefined') return;
    this.clockTimer = window.setInterval(() => {
      if (performance.now() > this.clockUntil && !this.session) { window.clearInterval(this.clockTimer!); this.clockTimer = null; return; }
      this.sampleClock();
    }, 40);
  }

  /** Temps (contexte audio) du son entendu à l'instant `timeStamp`. */
  contextTimeOf(timeStamp?: number): number {
    const ac: any = audioEngine.ctx;
    if (!ac) return 0;
    const stamp = this.sampleClock();
    this.keepClockFresh();
    return midiTimestampToContextTime(timeStamp, {
      stamp, ctxNow: ac.currentTime, perfNow: performance.now(), outputLatency: (ac.outputLatency || 0) + (ac.baseLatency || 0), offsetMs: this.prefs.offsetMs,
      clockOffset: this.clock.count >= 5 ? this.clock.value() : null,
    });
  }

  // --------------------------------------------------------------------------
  // Messages
  // --------------------------------------------------------------------------

  noteOn(pitch: number, velocity: number, o: MidiInOpts) {
    const ctxTime = this.contextTimeOf(o.timeStamp);
    // Pendant une prise, tout ce qu'on joue part sur la piste qui enregistre.
    const trackId = this.session?.trackId ?? this.targetTrack(o.trackId);
    this.lastEventAt = performance.now();
    if (trackId && this.prefs.thru) {
      void audioEngine.resume?.();
      // Même touche encore tenue par la pédale : on la relâche avant de la rejouer.
      const prev = this.sounding.get(pitch);
      if (prev) audioEngine.triggerTrackRelease(prev, pitch);
      this.pedal.get(trackId)?.delete(pitch);
      audioEngine.triggerTrackAttack(trackId, pitch, velocity / 127);
      this.sounding.set(pitch, trackId);
    }
    midiCapture.noteOn(pitch, velocity, trackId);
    if (this.session) this.session.rec.noteOn(pitch, velocity, ctxTime - this.session.anchor);
    this.emit({ type: 'on', pitch, velocity, source: o.source, trackId, ctxTime });
  }

  noteOff(pitch: number, o: MidiInOpts) {
    const ctxTime = this.contextTimeOf(o.timeStamp);
    const trackId = this.sounding.get(pitch) ?? this.targetTrack(o.trackId);
    const held = trackId ? this.pedal.get(trackId) : undefined;
    if (trackId && held) held.add(pitch); // la pédale tient la note
    else if (trackId) { audioEngine.triggerTrackRelease(trackId, pitch); this.sounding.delete(pitch); }
    midiCapture.noteOff(pitch);
    if (this.session) this.session.rec.noteOff(pitch, ctxTime - this.session.anchor);
    this.emit({ type: 'off', pitch, source: o.source, trackId, ctxTime });
  }

  /** Contrôleur : « pb », « at » ou « ccN », valeur MIDI brute. */
  control(key: string, value: number, o: MidiInOpts) {
    const ctxTime = this.contextTimeOf(o.timeStamp);
    // MIDI Learn : un bouton relié pilote son réglage (et ne part pas sur la piste).
    const n = ccNumber(key);
    if (n !== null && o.source === 'hw') {
      const r = midiLearn.handleCc(o.channel || 1, n, value);
      if (r.learned || r.hits.length) {
        try { this.learnHandler?.(r.hits, r.learned); } catch { /* */ }
        return;
      }
    }
    const trackId = this.session?.trackId ?? this.targetTrack(o.trackId);
    if (trackId && this.prefs.thru) {
      if (key === SUSTAIN) this.setPedal(trackId, pedalDown(value));
      else audioEngine.sendTrackController(trackId, key, value);
    }
    if (this.session) this.session.rec.control(key, value, ctxTime - this.session.anchor);
    this.emit({ type: 'control', key, value, source: o.source, trackId, ctxTime });
  }

  private setPedal(trackId: string, down: boolean) {
    if (down) { if (!this.pedal.has(trackId)) this.pedal.set(trackId, new Set()); return; }
    const held = this.pedal.get(trackId);
    this.pedal.delete(trackId);
    held?.forEach(p => {
      if (this.sounding.get(p) === trackId) { audioEngine.triggerTrackRelease(trackId, p); this.sounding.delete(p); }
    });
  }

  /** Tout relâcher (panique, perte de focus). */
  panic() {
    this.sounding.forEach((t, p) => audioEngine.triggerTrackRelease(t, p));
    this.sounding.clear();
    this.pedal.clear();
  }

  private emit(e: MidiInEvent) { this.listeners.forEach(f => { try { f(e); } catch { /* */ } }); }

  // --------------------------------------------------------------------------
  // Prise armée
  // --------------------------------------------------------------------------

  get isRecording() { return !!this.session; }
  get recordingTrackId() { return this.session?.trackId ?? null; }

  startRecording(o: { trackId: string; anchor: number; recStart: number; loop?: LoopRange | null; keepFrom?: number | null; keepTo?: number | null }) {
    this.keepClockFresh();
    this.session = { trackId: o.trackId, anchor: o.anchor, rec: new MidiTakeRecorder({ recStart: o.recStart, loop: o.loop, keepFrom: o.keepFrom, keepTo: o.keepTo }) };
  }

  /** Recale l'ancre (la lecture a démarré plus tard que prévu, après le décompte). */
  setAnchor(anchor: number) { if (this.session) this.session.anchor = anchor; }

  /** Notes en cours de prise (affichage), en temps du morceau. */
  recPreview(): { trackId: string; notes: RecNote[] } | null {
    const s = this.session;
    const ac = audioEngine.ctx;
    if (!s || !ac) return null;
    return { trackId: s.trackId, notes: s.rec.preview(this.contextTimeOf() - s.anchor) };
  }

  /** Fin de prise : rend la prise (et ferme les notes tenues à l'instant de l'arrêt). */
  stopRecording(endCtxTime?: number) {
    const s = this.session;
    this.session = null;
    if (!s) return null;
    const end = (endCtxTime ?? this.contextTimeOf()) - s.anchor;
    return { trackId: s.trackId, take: s.rec.finish(end), loop: s.rec.loop };
  }

  /** Quelqu'un joue en ce moment (indicateur de la barre). */
  get lastActivity() { return this.lastEventAt; }
}

export const midiInput = new MidiInputHub();
