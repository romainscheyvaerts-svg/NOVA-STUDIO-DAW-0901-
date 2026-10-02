
import { DrumPad } from '../types';

/**
 * Drum Rack Engine
 * Manages 30 distinct sample pads with individual volume/pan.
 * Triggered by MIDI notes 60 (Pad 1) to 89 (Pad 30).
 */
export class DrumRackNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  // Map Pad ID (1-30) to Buffer
  private buffers: Map<number, AudioBuffer> = new Map();
  
  // Internal State (Vol/Pan/Mute) to apply on trigger
  private pads: Map<number, DrumPad> = new Map();
  // « Choke » : un pad coupe les autres du même groupe (hi-hat fermé / ouvert, 808).
  private chokeVoices: Map<number, { src: AudioBufferSourceNode; gain: GainNode }[]> = new Map();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain(); // Aux Input (rarely used for DrumRack but good for chain)
    this.output = ctx.createGain();
    
    // Pass-through input to output if any
    this.input.connect(this.output);
  }

  public updatePadsState(pads: DrumPad[]) {
    pads.forEach(pad => {
      this.pads.set(pad.id, pad);
      if (pad.buffer) {
        this.buffers.set(pad.id, pad.buffer);
      }
    });
  }

  /** Expose les samples charges (utilise par l'export offline). */
  public getBuffers(): Map<number, AudioBuffer> {
    return this.buffers;
  }

  public loadSample(padId: number, buffer: AudioBuffer) {
    this.buffers.set(padId, buffer);
  }

  /**
   * Triggers a specific Pad by ID (1-30) or MIDI Note (60-89)
   */
  public trigger(padIdOrNote: number, velocity: number = 1.0, time: number = 0) {
    // Determine Pad ID. If > 30, assume it's a MIDI note.
    // MIDI 60 = Pad 1.
    const padId = padIdOrNote > 30 ? padIdOrNote - 59 : padIdOrNote;

    if (padId < 1 || padId > 30) return;

    const pad = this.pads.get(padId);
    if (!pad) return; // Pad state not found?
    
    // Mute/Solo Logic
    // Check global solo status (if any pad is soloed, this one must be soloed to play)
    const isAnySolo = Array.from(this.pads.values()).some(p => p.isSolo);
    if (pad.isMuted) return;
    if (isAnySolo && !pad.isSolo) return;

    const buffer = this.buffers.get(padId);
    if (!buffer) return;

    const now = Math.max(time, this.ctx.currentTime);

    // Create Source
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Create Gain (Volume * Velocity)
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = pad.volume * velocity;

    // Create Panner
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pad.pan;

    // Graph: Source -> Gain -> Panner -> Output
    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.output);

    source.start(now);

    const group = (pad as any).chokeGroup as number | undefined;
    if (group) {
      const voices = this.chokeVoices.get(group) || [];
      // Coupe brève (5 ms) des voix du groupe encore en train de sonner.
      voices.forEach(v => {
        try { v.gain.gain.setTargetAtTime(0, now, 0.005); v.src.stop(now + 0.05); } catch { /* déjà arrêtée */ }
      });
      this.chokeVoices.set(group, [{ src: source, gain: gainNode }]);
    }

    // Garbage Collection
    source.onended = () => {
        source.disconnect();
        gainNode.disconnect();
        panner.disconnect();
    };
  }
}
