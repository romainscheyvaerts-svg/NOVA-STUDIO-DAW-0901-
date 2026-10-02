
import { DrumPad } from '../types';

/**
 * Drum Rack Engine
 * Manages 30 distinct sample pads with individual volume/pan.
 * Triggered by MIDI notes 60 (Pad 1) to 89 (Pad 30).
 */
/** Durée réellement audible d'un son (jusqu'à -50 dB sous sa crête), mise en cache. */
const audibleCache = new WeakMap<AudioBuffer, number>();
function audibleLength(buf: AudioBuffer): number {
  const hit = audibleCache.get(buf);
  if (hit !== undefined) return hit;
  const d = buf.getChannelData(0);
  let pk = 0;
  for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; }
  const floor = pk * 0.00316;
  let last = d.length - 1;
  while (last > 0 && Math.abs(d[last]) < floor) last--;
  const len = Math.max(0.01, (last + 1) / buf.sampleRate);
  audibleCache.set(buf, len);
  return len;
}

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
  // Entrée de la chaîne d'effets propre à chaque pad (mix par pad) ; sinon sortie directe.
  private padInputs: Map<number, AudioNode> = new Map();

  public setPadInput(padId: number, node: AudioNode | null) {
    if (node) this.padInputs.set(padId, node); else this.padInputs.delete(padId);
  }

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
    const tune = pad.tune || 0;
    if (tune) source.playbackRate.value = Math.pow(2, tune / 12);

    // Create Gain (Volume * Velocity)
    const gainNode = this.ctx.createGain();
    const level = pad.volume * velocity;
    gainNode.gain.value = level;
    // Longueur : le son est raccourci par un fondu (comme le « decay » d'une MPC).
    const decay = pad.decay ?? 1;
    if (decay < 0.999) {
      const len = (audibleLength(buffer) / Math.pow(2, tune / 12)) * Math.max(0.05, decay);
      gainNode.gain.setValueAtTime(level, now);
      gainNode.gain.setTargetAtTime(0, now + len * 0.6, len * 0.15);
    }

    // Create Panner
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pad.pan;

    // Graph: Source -> Gain -> Panner -> Output
    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.padInputs.get(padId) || this.output);

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
