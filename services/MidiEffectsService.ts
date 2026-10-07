
/**
 * MIDI EFFECTS SERVICE
 * Professional MIDI processing inspired by Ableton Live and Logic Pro
 * 
 * Features:
 * - Arpeggiator (multiple patterns, rates, gate)
 * - Chord Generator (various chord types)
 * - Scale Quantizer
 * - Humanizer (timing/velocity variations)
 */

import { CHORD_INTERVALS as SHARED_CHORD_INTERVALS } from '../utils/scales';

import { MidiNote } from '../types';

// ============================================
// ARPEGGIATOR (inspired by Ableton/Logic)
// ============================================

export type ArpPattern = 
  | 'UP' 
  | 'DOWN' 
  | 'UP_DOWN' 
  | 'DOWN_UP' 
  | 'RANDOM' 
  | 'ORDER' 
  | 'CONVERGE' 
  | 'DIVERGE'
  | 'PINKY_UP'    // Thumb + alternating up
  | 'PINKY_DOWN'; // Thumb + alternating down

export type ArpRate = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/4T' | '1/8T' | '1/16T';

export interface ArpeggiatorSettings {
  enabled: boolean;
  pattern: ArpPattern;
  rate: ArpRate;
  gate: number;        // 0-200% (note length relative to rate)
  octaves: number;     // 1-4 octaves
  swing: number;       // -100 to +100
  velocity: 'AS_PLAYED' | 'FULL' | 'ACCENT';
  accentEvery: number; // Accent every N notes (0 = off)
  hold: boolean;       // Hold notes after release
  retrigger: boolean;  // Restart pattern on new note
}

export const DEFAULT_ARP_SETTINGS: ArpeggiatorSettings = {
  enabled: false,
  pattern: 'UP',
  rate: '1/8',
  gate: 80,
  octaves: 1,
  swing: 0,
  velocity: 'AS_PLAYED',
  accentEvery: 0,
  hold: false,
  retrigger: true,
};

// Rate to beat multiplier
const RATE_TO_BEATS: Record<ArpRate, number> = {
  '1/1': 4,
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
  '1/4T': 1 / 1.5,   // Triplet
  '1/8T': 0.5 / 1.5,
  '1/16T': 0.25 / 1.5,
};

class Arpeggiator {
  private settings: ArpeggiatorSettings = { ...DEFAULT_ARP_SETTINGS };
  private heldNotes: number[] = [];
  private currentIndex: number = 0;
  private lastNoteTime: number = 0;
  private patternSequence: number[] = [];
  
  public setSettings(settings: Partial<ArpeggiatorSettings>) {
    this.settings = { ...this.settings, ...settings };
    if (settings.pattern || settings.octaves) {
      this.buildPattern();
    }
  }
  
  public getSettings(): ArpeggiatorSettings {
    return { ...this.settings };
  }
  
  public noteOn(pitch: number) {
    if (!this.heldNotes.includes(pitch)) {
      this.heldNotes.push(pitch);
      this.heldNotes.sort((a, b) => a - b);
      this.buildPattern();
      if (this.settings.retrigger) {
        this.currentIndex = 0;
      }
    }
  }
  
  public noteOff(pitch: number) {
    if (!this.settings.hold) {
      this.heldNotes = this.heldNotes.filter(n => n !== pitch);
      this.buildPattern();
    }
  }
  
  public releaseAll() {
    this.heldNotes = [];
    this.patternSequence = [];
    this.currentIndex = 0;
  }
  
  public hasNotes(): boolean {
    return this.heldNotes.length > 0;
  }
  
  /**
   * Get next note(s) to play based on current time and BPM
   */
  public process(currentTime: number, bpm: number): { pitch: number; velocity: number; duration: number }[] {
    if (!this.settings.enabled || this.patternSequence.length === 0) {
      return [];
    }
    
    const beatDuration = 60 / bpm;
    const stepDuration = beatDuration * RATE_TO_BEATS[this.settings.rate];
    
    // Apply swing
    const swingOffset = this.currentIndex % 2 === 1 
      ? stepDuration * (this.settings.swing / 100) * 0.3 
      : 0;
    
    const timeSinceLastNote = currentTime - this.lastNoteTime;
    
    if (timeSinceLastNote >= stepDuration + swingOffset) {
      const pitch = this.patternSequence[this.currentIndex];
      const noteDuration = stepDuration * (this.settings.gate / 100);
      
      // Velocity handling
      let velocity = 100;
      if (this.settings.velocity === 'ACCENT' && this.settings.accentEvery > 0) {
        velocity = this.currentIndex % this.settings.accentEvery === 0 ? 127 : 80;
      } else if (this.settings.velocity === 'FULL') {
        velocity = 127;
      }
      
      this.currentIndex = (this.currentIndex + 1) % this.patternSequence.length;
      this.lastNoteTime = currentTime;
      
      return [{ pitch, velocity, duration: noteDuration }];
    }
    
    return [];
  }
  
  private buildPattern() {
    this.patternSequence = arpSequence(this.heldNotes, this.settings.pattern, this.settings.octaves);
  }
}

/**
 * Suite de notes jouée par l'arpégiateur (pure, réutilisée par l'outil
 * « Arpège » du piano roll, V25). `notes` : hauteurs dans l'ordre joué
 * (ORDER) ; les autres motifs les trient.
 */
export function arpSequence(notes: number[], pattern: ArpPattern, octaves = 1, rand: () => number = Math.random): number[] {
  if (notes.length === 0) return [];
  const oct = Math.max(1, Math.min(4, Math.round(octaves)));
  const sortedIn = [...notes].sort((a, b) => a - b);
  const expanded: number[] = [];
  for (let o = 0; o < oct; o++) expanded.push(...sortedIn.map(n => n + o * 12));
  switch (pattern) {
    case 'UP': return [...expanded];
    case 'DOWN': return [...expanded].reverse();
    case 'UP_DOWN': return [...expanded, ...expanded.slice(1, -1).reverse()];
    case 'DOWN_UP': { const down = [...expanded].reverse(); return [...down, ...expanded.slice(1, -1)]; }
    case 'RANDOM': {
      const a = [...expanded];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    }
    case 'ORDER': {
      const out: number[] = [];
      for (let o = 0; o < oct; o++) out.push(...notes.map(n => n + o * 12));
      return out;
    }
    case 'CONVERGE': {
      const a = [...expanded]; const out: number[] = [];
      while (a.length) { out.push(a.shift()!); if (a.length) out.push(a.pop()!); }
      return out;
    }
    case 'DIVERGE': {
      const out: number[] = [];
      const mid = Math.floor(expanded.length / 2);
      let l = mid - 1, r = mid;
      while (l >= 0 || r < expanded.length) { if (r < expanded.length) out.push(expanded[r++]); if (l >= 0) out.push(expanded[l--]); }
      return out;
    }
    case 'PINKY_UP': {
      if (expanded.length < 2) return [...expanded];
      const out: number[] = [];
      for (let i = 1; i < expanded.length; i++) out.push(expanded[0], expanded[i]);
      return out;
    }
    case 'PINKY_DOWN': {
      if (expanded.length < 2) return [...expanded];
      const out: number[] = []; const last = expanded.length - 1;
      for (let i = last - 1; i >= 0; i--) out.push(expanded[last], expanded[i]);
      return out;
    }
  }
  return [...expanded];
}

/** Durée (temps) d'un pas de l'arpégiateur. */
export const arpRateBeats = (rate: ArpRate): number => RATE_TO_BEATS[rate];

// ============================================
// CHORD GENERATOR (inspired by Logic/Ableton)
// ============================================

export type ChordType = 
  | 'MAJOR' 
  | 'MINOR' 
  | 'DIM' 
  | 'AUG' 
  | 'SUS2' 
  | 'SUS4'
  | 'MAJ7'
  | 'MIN7'
  | 'DOM7'
  | 'DIM7'
  | 'MAJ9'
  | 'MIN9'
  | 'ADD9'
  | 'POWER';

export interface ChordGeneratorSettings {
  enabled: boolean;
  chordType: ChordType;
  inversion: number;     // 0, 1, 2, 3
  spread: number;        // Octave spread (-2 to +2)
  velocityScale: number; // % for added notes (50-100)
  strumDelay: number;    // ms between chord notes (0 = simultaneous)
}

export const DEFAULT_CHORD_SETTINGS: ChordGeneratorSettings = {
  enabled: false,
  chordType: 'MAJOR',
  inversion: 0,
  spread: 0,
  velocityScale: 80,
  strumDelay: 0,
};

// Intervalles partagés avec le tampon d'accord du piano roll (utils/scales.ts).
const CHORD_INTERVALS: Record<ChordType, number[]> = SHARED_CHORD_INTERVALS;

export class ChordGenerator {
  private settings: ChordGeneratorSettings = { ...DEFAULT_CHORD_SETTINGS };
  
  public setSettings(settings: Partial<ChordGeneratorSettings>) {
    this.settings = { ...this.settings, ...settings };
  }
  
  public getSettings(): ChordGeneratorSettings {
    return { ...this.settings };
  }
  
  /**
   * Generate chord notes from a single input note
   */
  public generateChord(rootPitch: number, velocity: number): { pitch: number; velocity: number; delay: number }[] {
    if (!this.settings.enabled) {
      return [{ pitch: rootPitch, velocity, delay: 0 }];
    }
    
    let intervals = [...CHORD_INTERVALS[this.settings.chordType]];
    
    // Apply inversion
    if (this.settings.inversion > 0) {
      for (let i = 0; i < this.settings.inversion && i < intervals.length; i++) {
        const note = intervals.shift()!;
        intervals.push(note + 12);
      }
    }
    
    // Apply spread
    if (this.settings.spread !== 0) {
      intervals = intervals.map((int, idx) => {
        const octaveShift = Math.floor(idx * this.settings.spread / intervals.length) * 12;
        return int + octaveShift;
      });
    }
    
    // Generate notes
    return intervals.map((interval, idx) => ({
      pitch: rootPitch + interval,
      velocity: idx === 0 ? velocity : Math.round(velocity * this.settings.velocityScale / 100),
      delay: idx * this.settings.strumDelay,
    }));
  }
}

// ============================================
// SCALE QUANTIZER
// ============================================

export type ScaleType = 
  | 'CHROMATIC'
  | 'MAJOR'
  | 'MINOR'
  | 'DORIAN'
  | 'PHRYGIAN'
  | 'LYDIAN'
  | 'MIXOLYDIAN'
  | 'LOCRIAN'
  | 'HARMONIC_MINOR'
  | 'MELODIC_MINOR'
  | 'PENTATONIC_MAJOR'
  | 'PENTATONIC_MINOR'
  | 'BLUES';

export interface ScaleQuantizerSettings {
  enabled: boolean;
  rootNote: number;  // 0-11 (C=0, C#=1, etc.)
  scale: ScaleType;
  direction: 'NEAREST' | 'UP' | 'DOWN';
}

const SCALE_INTERVALS: Record<ScaleType, number[]> = {
  'CHROMATIC': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'MAJOR': [0, 2, 4, 5, 7, 9, 11],
  'MINOR': [0, 2, 3, 5, 7, 8, 10],
  'DORIAN': [0, 2, 3, 5, 7, 9, 10],
  'PHRYGIAN': [0, 1, 3, 5, 7, 8, 10],
  'LYDIAN': [0, 2, 4, 6, 7, 9, 11],
  'MIXOLYDIAN': [0, 2, 4, 5, 7, 9, 10],
  'LOCRIAN': [0, 1, 3, 5, 6, 8, 10],
  'HARMONIC_MINOR': [0, 2, 3, 5, 7, 8, 11],
  'MELODIC_MINOR': [0, 2, 3, 5, 7, 9, 11],
  'PENTATONIC_MAJOR': [0, 2, 4, 7, 9],
  'PENTATONIC_MINOR': [0, 3, 5, 7, 10],
  'BLUES': [0, 3, 5, 6, 7, 10],
};

class ScaleQuantizer {
  private settings: ScaleQuantizerSettings = {
    enabled: false,
    rootNote: 0,
    scale: 'MAJOR',
    direction: 'NEAREST',
  };
  
  public setSettings(settings: Partial<ScaleQuantizerSettings>) {
    this.settings = { ...this.settings, ...settings };
  }
  
  public quantize(pitch: number): number {
    if (!this.settings.enabled || this.settings.scale === 'CHROMATIC') {
      return pitch;
    }
    
    const scaleNotes = SCALE_INTERVALS[this.settings.scale];
    const noteInOctave = (pitch - this.settings.rootNote + 120) % 12;
    const octave = Math.floor((pitch - this.settings.rootNote) / 12);
    
    // Find nearest scale note
    let nearestUp = -1;
    let nearestDown = -1;
    
    for (let i = 0; i < scaleNotes.length; i++) {
      if (scaleNotes[i] === noteInOctave) {
        return pitch; // Already in scale
      }
      if (scaleNotes[i] < noteInOctave) {
        nearestDown = scaleNotes[i];
      }
      if (scaleNotes[i] > noteInOctave && nearestUp === -1) {
        nearestUp = scaleNotes[i];
      }
    }
    
    // Handle wrap-around
    if (nearestUp === -1) nearestUp = scaleNotes[0] + 12;
    if (nearestDown === -1) nearestDown = scaleNotes[scaleNotes.length - 1] - 12;
    
    const distUp = nearestUp - noteInOctave;
    const distDown = noteInOctave - nearestDown;
    
    let quantizedNote: number;
    switch (this.settings.direction) {
      case 'UP':
        quantizedNote = nearestUp;
        break;
      case 'DOWN':
        quantizedNote = nearestDown;
        break;
      default: // NEAREST
        quantizedNote = distUp <= distDown ? nearestUp : nearestDown;
    }
    
    return this.settings.rootNote + octave * 12 + quantizedNote;
  }
}

/** Ramène une note dans une gamme (ScaleQuantizer, réutilisé par les outils du piano roll). */
export function quantizePitchToScale(pitch: number, rootNote: number, scale: ScaleType, direction: 'NEAREST' | 'UP' | 'DOWN' = 'NEAREST'): number {
  const q = new ScaleQuantizer();
  q.setSettings({ enabled: true, rootNote: ((rootNote % 12) + 12) % 12, scale, direction });
  return q.quantize(pitch);
}

/** Notes de la gamme (intervalles depuis la tonique). */
export const scaleIntervals = (scale: ScaleType): number[] => SCALE_INTERVALS[scale] || SCALE_INTERVALS.CHROMATIC;

// ============================================
// HUMANIZER (timing/velocity variations)
// ============================================

export interface HumanizerSettings {
  enabled: boolean;
  timingVariation: number;   // 0-100% (randomize timing)
  velocityVariation: number; // 0-100% (randomize velocity)
  maxTimingMs: number;       // Max timing deviation in ms
}

class Humanizer {
  private settings: HumanizerSettings = {
    enabled: false,
    timingVariation: 30,
    velocityVariation: 20,
    maxTimingMs: 30,
  };
  
  public setSettings(settings: Partial<HumanizerSettings>) {
    this.settings = { ...this.settings, ...settings };
  }
  
  public humanize(note: { time: number; velocity: number }): { time: number; velocity: number } {
    if (!this.settings.enabled) return note;
    
    // Random timing offset
    const timingOffset = (Math.random() - 0.5) * 2 * 
      (this.settings.timingVariation / 100) * 
      (this.settings.maxTimingMs / 1000);
    
    // Random velocity variation
    const velocityOffset = (Math.random() - 0.5) * 2 * 
      (this.settings.velocityVariation / 100) * 40;
    
    return {
      time: note.time + timingOffset,
      velocity: Math.max(1, Math.min(127, Math.round(note.velocity + velocityOffset))),
    };
  }
}

// ============================================
// MAIN SERVICE
// ============================================

class MidiEffectsService {
  private static instance: MidiEffectsService;
  
  public arpeggiator = new Arpeggiator();
  public chordGenerator = new ChordGenerator();
  public scaleQuantizer = new ScaleQuantizer();
  public humanizer = new Humanizer();
  
  private constructor() {}
  
  public static getInstance(): MidiEffectsService {
    if (!MidiEffectsService.instance) {
      MidiEffectsService.instance = new MidiEffectsService();
    }
    return MidiEffectsService.instance;
  }
  
  /**
   * Process a MIDI note through all enabled effects
   */
  public processNoteOn(
    pitch: number, 
    velocity: number
  ): { pitch: number; velocity: number; delay: number }[] {
    // 1. Scale quantize
    const quantizedPitch = this.scaleQuantizer.quantize(pitch);
    
    // 2. Generate chord
    let notes = this.chordGenerator.generateChord(quantizedPitch, velocity);
    
    // 3. If arpeggiator is on, just add notes to arp (arp handles output separately)
    if (this.arpeggiator.getSettings().enabled) {
      notes.forEach(n => this.arpeggiator.noteOn(n.pitch));
      return []; // Arpeggiator will output notes via process()
    }
    
    // 4. Humanize
    notes = notes.map(n => ({
      ...n,
      ...this.humanizer.humanize({ time: 0, velocity: n.velocity }),
    }));
    
    return notes;
  }
  
  public processNoteOff(pitch: number) {
    if (this.arpeggiator.getSettings().enabled) {
      const quantizedPitch = this.scaleQuantizer.quantize(pitch);
      // Also release chord notes
      const chordNotes = this.chordGenerator.generateChord(quantizedPitch, 100);
      chordNotes.forEach(n => this.arpeggiator.noteOff(n.pitch));
    }
  }
  
  /**
   * Process arpeggiator (call this in the audio loop)
   */
  public processArpeggiator(currentTime: number, bpm: number) {
    return this.arpeggiator.process(currentTime, bpm);
  }
}

export const midiEffectsService = MidiEffectsService.getInstance();
