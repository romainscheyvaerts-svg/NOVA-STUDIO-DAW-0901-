export interface SamplerADSR {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/**
 * Polyphonic Audio Sampler
 * Handles sample playback, pitch shifting (re-sampling), and ADSR envelopes.
 */
export class AudioSampler {
  private ctx: AudioContext;
  public output: GainNode;
  private buffer: AudioBuffer | null = null;
  
  // ADSR Params (seconds/gain)
  private adsr: SamplerADSR = {
    attack: 0.01,
    decay: 0.2,
    sustain: 0.8,
    release: 0.5
  };

  // Active Voices: Map<NoteID, { source, gain }>
  // NoteID is typical MidiPitch but handles polyphony by storing multiple instances if needed,
  // though typically we key by Pitch to allow re-triggering/stealing.
  private activeVoices: Map<number, { source: AudioBufferSourceNode, gain: GainNode }> = new Map();
  
  // Root key for the sample (C4 = 60)
  private rootKey: number = 60;

  // FIX: The constructor now accepts a BPM argument to match the call in AudioEngine.
  // FIX: Added bpm argument to constructor to match the call signature.
  constructor(ctx: AudioContext, bpm: number) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  public loadBuffer(buffer: AudioBuffer) {
    this.buffer = buffer;
  }

  public setADSR(params: Partial<SamplerADSR>) {
    this.adsr = { ...this.adsr, ...params };
  }

  public getADSR() {
    return { ...this.adsr };
  }

  public getBuffer() {
      return this.buffer;
  }

  /**
   * Trigger a note on.
   * @param pitch MIDI pitch (0-127)
   * @param velocity Velocity (0-1)
   * @param time AudioContext time to schedule start
   */
  public triggerAttack(pitch: number, velocity: number = 1.0, time: number = 0) {
    if (!this.buffer) return;

    // 1. Voice Stealing / Monophonic per key behavior
    // If key is already pressed, stop it (fast release) to retrigger
    this.triggerRelease(pitch, time);

    const now = Math.max(time, this.ctx.currentTime);
    
    // 2. Create Voice Graph
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    
    // Pitch Calculation
    // Rate = 2 ^ ((Note - Root) / 12)
    const semitoneRatio = Math.pow(2, 1/12);
    const semitoneDiff = pitch - this.rootKey;
    const playbackRate = Math.pow(semitoneRatio, semitoneDiff);
    source.playbackRate.value = playbackRate;

    const env = this.ctx.createGain();
    
    // 3. ADSR Envelope
    const { attack, decay, sustain } = this.adsr;
    
    // Initial silence
    env.gain.setValueAtTime(0, now);
    // Attack
    env.gain.linearRampToValueAtTime(velocity, now + attack);
    // Decay -> Sustain
    env.gain.exponentialRampToValueAtTime(Math.max(0.001, velocity * sustain), now + attack + decay);

    // 4. Connect
    source.connect(env);
    env.connect(this.output);

    source.start(now);

    // 5. Track Voice
    this.activeVoices.set(pitch, { source, gain: env });
    
    // Auto-cleanup on end (if sample finishes before release)
    source.onended = () => {
        // Only cleanup if this is still the active voice for this pitch
        const current = this.activeVoices.get(pitch);
        if (current && current.source === source) {
            this.activeVoices.delete(pitch);
        }
    };
  }

  /**
   * Trigger a note off (Release phase).
   * @param pitch MIDI pitch
   * @param time AudioContext time to schedule release
   */
  public triggerRelease(pitch: number, time: number = 0) {
    const voice = this.activeVoices.get(pitch);
    if (!voice) return;

    const now = Math.max(time, this.ctx.currentTime);
    const { release } = this.adsr;

    // Cancel planned updates (sustain hold)
    voice.gain.gain.cancelScheduledValues(now);
    
    // Current value check to avoid clicking
    // (Web Audio automation handles interpolation from 'now', 
    // but setValueAtTime is safer to anchor the ramp)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    
    // Release Ramp
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
    
    // Stop Source
    voice.source.stop(now + release + 0.1); // Small buffer to ensure silence

    // Remove from active map immediately so new notes can take slot
    this.activeVoices.delete(pitch);
  }

  public stopAll() {
    const now = this.ctx.currentTime;
    this.activeVoices.forEach(voice => {
        try {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
            voice.gain.gain.linearRampToValueAtTime(0, now + 0.05);
            voice.source.stop(now + 0.05);
        } catch(e) {}
    });
    this.activeVoices.clear();
  }
}