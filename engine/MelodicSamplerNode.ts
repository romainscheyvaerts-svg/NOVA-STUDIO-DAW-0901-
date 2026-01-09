
export interface MelodicSamplerParams {
  // Source
  rootKey: number;        // MIDI Note (0-127)
  fineTune: number;       // Cents (-100 to 100)
  glide: number;          // Portamento time (0 to 1s)
  loop: boolean;
  loopStart: number;      // 0-1
  loopEnd: number;        // 0-1
  
  // ADSR
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  
  // Filter
  filterCutoff: number;   // Hz
  filterRes: number;      // Q
  velocityToFilter: number; // 0-1 amount
  
  // LFO
  lfoRate: number;        // Hz
  lfoAmount: number;      // 0-1
  lfoDest: 'PITCH' | 'FILTER' | 'VOLUME';
  
  // FX Chain
  saturation: number;     // 0-1 Drive
  bitCrush: number;       // 0-1 (Reduction)
  chorus: number;         // 0-1 Mix
  width: number;          // 0-1 Stereo Width
  
  isEnabled: boolean;
}

/**
 * Single Voice Logic
 * Handles one note instance with its own filter and envelope
 */
class Voice {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  env: GainNode;
  panner: StereoPannerNode; // Per voice panning if needed, but usually global
  
  constructor(ctx: AudioContext, destination: AudioNode) {
    this.source = ctx.createBufferSource();
    this.filter = ctx.createBiquadFilter();
    this.env = ctx.createGain();
    
    this.source.connect(this.filter);
    this.filter.connect(this.env);
    this.env.connect(destination);
    
    this.filter.type = 'lowpass';
    this.env.gain.value = 0;
  }
  
  stop(time: number) {
    try {
        this.source.stop(time);
        // Clean disconnect after stop?
        setTimeout(() => {
            this.source.disconnect();
            this.filter.disconnect();
            this.env.disconnect();
        }, (time - this.source.context.currentTime + 1) * 1000);
    } catch(e) {}
  }
}

export class MelodicSamplerNode {
  private ctx: AudioContext;
  public input: GainNode; 
  public output: GainNode;
  
  // FX Chain
  private saturator: WaveShaperNode;
  private bitCrushGain: GainNode; // Simulated
  private filterChain: GainNode;
  private chorusNode: GainNode; // Placeholder for internal chorus logic or insert
  private widthNode: ChannelSplitterNode; // Mid/Side
  private widthMerger: ChannelMergerNode;
  private masterGain: GainNode;
  
  private buffer: AudioBuffer | null = null;
  private activeVoices: Map<number, Voice> = new Map();
  private lastNoteFreq: number | null = null; // For Glide
  
  // Global LFO
  private lfo: OscillatorNode;
  private lfoGain: GainNode;

  private params: MelodicSamplerParams = {
    rootKey: 60, // C4
    fineTune: 0,
    glide: 0.05,
    loop: false,
    loopStart: 0,
    loopEnd: 1,
    attack: 0.01,
    decay: 0.3,
    sustain: 0.5,
    release: 0.5,
    filterCutoff: 20000,
    filterRes: 0,
    velocityToFilter: 0.5,
    lfoRate: 4,
    lfoAmount: 0,
    lfoDest: 'PITCH',
    saturation: 0,
    bitCrush: 0,
    chorus: 0,
    width: 0.5,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // --- FX CHAIN SETUP ---
    // Voices -> Input -> Saturator -> Width -> Master -> Output
    
    this.saturator = ctx.createWaveShaper();
    this.makeDistortionCurve(0); // Init linear
    
    this.widthNode = ctx.createChannelSplitter(2);
    this.widthMerger = ctx.createChannelMerger(2);
    this.masterGain = ctx.createGain();

    // Input -> Saturator
    this.input.connect(this.saturator);
    
    // Saturator -> M/S Width (Simplified)
    // We use channel splitter/merger to offset phases
    const delaySide = ctx.createDelay();
    delaySide.delayTime.value = 0; // 0 to 20ms based on width
    
    this.saturator.connect(delaySide);
    delaySide.connect(this.widthMerger, 0, 0); // L -> L
    this.saturator.connect(this.widthMerger, 0, 1); // L -> R (Mono source assumed or summed)
    
    this.widthMerger.connect(this.masterGain);
    this.masterGain.connect(this.output);
    
    // LFO Setup
    this.lfo = ctx.createOscillator();
    this.lfoGain = ctx.createGain();
    this.lfo.connect(this.lfoGain);
    this.lfo.start();
  }

  private makeDistortionCurve(amount: number) {
    const k = amount * 100;
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      // Soft clipping curve
      curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    this.saturator.curve = curve;
  }
  
  // Bitcrusher Simulation via Quantization curve
  private makeBitCrushCurve(amount: number) {
     if (amount <= 0) return this.makeDistortionCurve(this.params.saturation);
     
     const steps = Math.pow(2, 16 - (amount * 12)); // Reduce resolution
     const n = 44100;
     const curve = new Float32Array(n);
     for (let i = 0; i < n; i++) {
         const x = (i * 2) / n - 1;
         curve[i] = Math.round(x * steps) / steps;
     }
     this.saturator.curve = curve;
  }

  public loadBuffer(buffer: AudioBuffer) {
    this.buffer = buffer;
  }

  public updateParams(p: Partial<MelodicSamplerParams>) {
    this.params = { ...this.params, ...p };
    
    // Apply Global Updates
    if (p.saturation !== undefined || p.bitCrush !== undefined) {
        if (this.params.bitCrush > 0) this.makeBitCrushCurve(this.params.bitCrush);
        else this.makeDistortionCurve(this.params.saturation);
    }
    
    if (p.lfoRate !== undefined) {
        this.lfo.frequency.setValueAtTime(this.params.lfoRate, this.ctx.currentTime);
    }

    if (p.width !== undefined) {
        // Simple Haas effect for width
        // Access delay node if we stored it reference, or rebuild graph. 
        // For simplicity, we just keep it minimal here.
    }
  }
  
  public getParams() { return this.params; }
  public getBuffer() { return this.buffer; }

  public triggerAttack(pitch: number, velocity: number, time: number) {
     if (!this.buffer || !this.params.isEnabled) return;
     
     const now = Math.max(time, this.ctx.currentTime);
     
     // Create Voice
     const voice = new Voice(this.ctx, this.input);
     voice.source.buffer = this.buffer;
     voice.source.loop = this.params.loop;
     
     if (this.params.loop) {
         voice.source.loopStart = this.params.loopStart * this.buffer.duration;
         voice.source.loopEnd = this.params.loopEnd * this.buffer.duration;
     }

     // Pitch Logic
     const rootFreq = 440 * Math.pow(2, (this.params.rootKey - 69) / 12);
     const targetFreq = 440 * Math.pow(2, (pitch - 69) / 12);
     
     // Fine Tune
     const detuneFactor = Math.pow(2, this.params.fineTune / 1200);
     const finalFreq = targetFreq * detuneFactor;
     
     // Portamento (Glide)
     const startFreq = (this.lastNoteFreq && this.params.glide > 0) ? this.lastNoteFreq : finalFreq;
     const basePlaybackRate = startFreq / rootFreq; // Assuming sample is at rootKey
     const targetPlaybackRate = finalFreq / rootFreq;
     
     voice.source.playbackRate.setValueAtTime(basePlaybackRate, now);
     if (this.params.glide > 0 && this.lastNoteFreq) {
         voice.source.playbackRate.linearRampToValueAtTime(targetPlaybackRate, now + this.params.glide);
     }
     this.lastNoteFreq = finalFreq;

     // Filter Logic
     // Velocity opens filter
     const cutoff = Math.min(20000, Math.max(20, this.params.filterCutoff + (velocity * this.params.velocityToFilter * 5000)));
     voice.filter.frequency.setValueAtTime(cutoff, now);
     voice.filter.Q.value = this.params.filterRes;

     // LFO Modulation (Connect Global LFO to Voice Parameter)
     if (this.params.lfoAmount > 0) {
         this.lfoGain.gain.setValueAtTime(this.params.lfoAmount * 100, now); // Scale
         this.lfoGain.disconnect();
         if (this.params.lfoDest === 'PITCH') {
             this.lfoGain.connect(voice.source.detune);
             this.lfoGain.gain.value = this.params.lfoAmount * 100; // Cents
         } else if (this.params.lfoDest === 'FILTER') {
             this.lfoGain.connect(voice.filter.frequency);
             this.lfoGain.gain.value = this.params.lfoAmount * 1000; // Hz
         } else if (this.params.lfoDest === 'VOLUME') {
             this.lfoGain.connect(voice.env.gain);
             this.lfoGain.gain.value = this.params.lfoAmount * 0.5;
         }
     }

     // ADSR Envelope
     const { attack, decay, sustain } = this.params;
     voice.env.gain.cancelScheduledValues(now);
     voice.env.gain.setValueAtTime(0, now);
     voice.env.gain.linearRampToValueAtTime(velocity, now + attack);
     voice.env.gain.exponentialRampToValueAtTime(Math.max(0.001, velocity * sustain), now + attack + decay);
     
     voice.source.start(now);
     
     // Store voice
     this.activeVoices.set(pitch, voice);
  }

  public triggerRelease(pitch: number, time: number) {
      const voice = this.activeVoices.get(pitch);
      if (voice) {
          const now = Math.max(time, this.ctx.currentTime);
          // Release phase
          voice.env.gain.cancelScheduledValues(now);
          voice.env.gain.setValueAtTime(voice.env.gain.value, now);
          voice.env.gain.exponentialRampToValueAtTime(0.0001, now + this.params.release);
          
          voice.stop(now + this.params.release + 0.1);
          this.activeVoices.delete(pitch);
      }
  }

  public stopAll() {
      const now = this.ctx.currentTime;
      this.activeVoices.forEach(v => v.stop(now));
      this.activeVoices.clear();
  }
}
