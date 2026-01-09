
/**
 * Simple Polyphonic Synthesizer
 * Uses native Web Audio Oscillators to replace Tone.PolySynth
 */
export class Synthesizer {
  private ctx: AudioContext;
  public output: GainNode;
  
  // Active voices: MIDI Pitch -> Oscillator/Nodes
  private activeVoices: Map<number, { osc: OscillatorNode, env: GainNode }> = new Map();
  
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

    this.activeVoices.set(pitch, { osc, env });
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
      } catch (e) {
          // Ignore scheduling errors
      }
      this.activeVoices.delete(pitch);
    }
  }

  public releaseAll() {
    const now = this.ctx.currentTime;
    this.activeVoices.forEach((voice) => {
        try {
            voice.env.gain.cancelScheduledValues(now);
            voice.env.gain.setValueAtTime(voice.env.gain.value, now);
            voice.env.gain.linearRampToValueAtTime(0, now + 0.05);
            voice.osc.stop(now + 0.05);
        } catch(e) {}
    });
    this.activeVoices.clear();
  }
}
