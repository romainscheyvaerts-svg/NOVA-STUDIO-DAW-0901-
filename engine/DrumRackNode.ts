
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

    // Garbage Collection
    source.onended = () => {
        source.disconnect();
        gainNode.disconnect();
        panner.disconnect();
    };
  }
}
