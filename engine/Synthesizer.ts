

/**
 * Simple Polyphonic Synthesizer
 * Uses native Web Audio Oscillators to replace Tone.PolySynth
 */
export class Synthesizer {
  private ctx: AudioContext;
  public output: GainNode;
  
  // FIX: The `activeVoices` map now includes the `filter` node to ensure it can be properly disconnected upon note release, preventing memory leaks.
  private activeVoices: Map<number, { osc: OscillatorNode, env: GainNode, filter: BiquadFilterNode }> = new Map();
  
  private params = {
    attack: 0.01,
    decay: 0.1,
    sustain: 0.5,
    release: 0.2,
    type: 'sawtooth' as OscillatorType,
    filterCutoff: 2000
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.5; // Main volume
  }

  public triggerAttack(pitch: number, velocity: number = 0.8, time: number = 0) {
    // Stop existing voice if any (monophonic per key)
    this.triggerRelease(pitch, time);

    const t = Math.max(time, this.ctx.currentTime);
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = this.params.type;
    osc.frequency.setValueAtTime(freq, t);

    // Simple Filter
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(this.params.filterCutoff, t);
    filter.Q.value = 1;

    // Connections
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.output);

    // ADSR Envelope
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity, t + this.params.attack);
    env.gain.linearRampToValueAtTime(velocity * this.params.sustain, t + this.params.attack + this.params.decay);

    osc.start(t);

    this.activeVoices.set(pitch, { osc, env, filter });
  }

  public triggerRelease(pitch: number, time: number = 0) {
    const voice = this.activeVoices.get(pitch);
    if (voice) {
      const t = Math.max(time, this.ctx.currentTime);
      // Release envelope
      try {
        voice.env.gain.cancelScheduledValues(t);
        voice.env.gain.setValueAtTime(voice.env.gain.value, t);
        voice.env.gain.exponentialRampToValueAtTime(0.001, t + this.params.release);
        voice.osc.stop(t + this.params.release + 0.1); // Stop after release
        
        // FIX: Added a delayed disconnection for all nodes in the voice. This prevents memory leaks by ensuring audio nodes are cleaned up after they have finished playing.
        setTimeout(() => {
            try { voice.filter.disconnect(); } catch(e) {}
            try { voice.osc.disconnect(); } catch(e) {}
            try { voice.env.disconnect(); } catch(e) {}
        }, (this.params.release + 0.2) * 1000);

      } catch (e) {
          // Ignore scheduling errors
      }
      this.activeVoices.delete(pitch);
    }
  }

  public releaseAll() {
    const now = this.ctx.currentTime;
    this.activeVoices.forEach((voice, pitch) => {
        try {
            voice.env.gain.cancelScheduledValues(now);
            voice.env.gain.setValueAtTime(voice.env.gain.value, now);
            voice.env.gain.linearRampToValueAtTime(0, now + 0.05);
            voice.osc.stop(now + 0.05);
            // FIX: Added a delayed disconnection for all nodes during `releaseAll`. This ensures a clean shutdown of all voices without causing audio artifacts from immediate disconnection.
            setTimeout(() => {
                try { voice.filter.disconnect(); voice.osc.disconnect(); voice.env.disconnect(); } catch(e) {}
            }, 100);
        } catch(e) {}
    });
    this.activeVoices.clear();
  }
}