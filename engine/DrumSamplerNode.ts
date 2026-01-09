
export interface DrumSamplerParams {
  gain: number;         // -60 to +12 dB
  transpose: number;    // -24 to +24 semitones
  fineTune: number;     // -100 to +100 cents
  sampleStart: number;  // 0 to 1 (Ratio)
  sampleEnd: number;    // 0 to 1 (Ratio)
  
  // AHDSR Envelope
  attack: number;       // Seconds
  hold: number;         // Seconds
  decay: number;        // Seconds
  sustain: number;      // 0 to 1 Gain
  release: number;      // Seconds

  // Filter
  cutoff: number;       // 20 to 20000 Hz
  resonance: number;    // 0 to 20 Q

  // Stereo & Dynamics
  pan: number;          // -1 to 1
  velocitySens: number; // 0 to 1 (How much velocity affects gain)
  
  // Toggles
  reverse: boolean;
  normalize: boolean;
  
  // System
  chokeGroup: number;   // 0 = Off, 1-8 = Group ID
  isEnabled: boolean;
}

export class DrumSamplerNode {
  private ctx: AudioContext;
  public input: GainNode; // Dummy input for chain consistency
  public output: GainNode;
  
  private buffer: AudioBuffer | null = null;
  private reversedBuffer: AudioBuffer | null = null;
  
  // Active state for choking
  private activeSource: AudioBufferSourceNode | null = null;
  private activeGain: GainNode | null = null;
  
  private params: DrumSamplerParams = {
    gain: 0,
    transpose: 0,
    fineTune: 0,
    sampleStart: 0.0,
    sampleEnd: 1.0,
    attack: 0.005,
    hold: 0.05,
    decay: 0.2,
    sustain: 0, 
    release: 0.1,
    cutoff: 20000,
    resonance: 0,
    pan: 0,
    velocitySens: 0.8,
    reverse: false,
    normalize: false,
    chokeGroup: 1, 
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain(); 
    this.output = ctx.createGain();
  }

  public loadBuffer(buffer: AudioBuffer) {
    this.buffer = buffer;
    this.generateReversedBuffer();
  }

  private generateReversedBuffer() {
    if (!this.buffer) return;
    const ctx = this.ctx;
    const channels = this.buffer.numberOfChannels;
    const reversed = ctx.createBuffer(channels, this.buffer.length, this.buffer.sampleRate);
    
    for (let i = 0; i < channels; i++) {
        const data = this.buffer.getChannelData(i);
        const revData = reversed.getChannelData(i);
        // Copy and reverse
        for (let j = 0; j < data.length; j++) {
            revData[j] = data[data.length - 1 - j];
        }
    }
    this.reversedBuffer = reversed;
  }

  public updateParams(p: Partial<DrumSamplerParams>) {
    const oldReverse = this.params.reverse;
    this.params = { ...this.params, ...p };
    
    // If reverse toggled and buffer missing, generate it
    if (this.params.reverse !== oldReverse && this.params.reverse && !this.reversedBuffer && this.buffer) {
        this.generateReversedBuffer();
    }
  }

  public getParams() { return { ...this.params }; }
  public getBuffer() { return this.buffer; }

  // --- TRIGGER LOGIC ---
  public trigger(velocity: number = 1.0, time: number = 0) {
    if (!this.params.isEnabled) return;
    const bufferToUse = this.params.reverse ? this.reversedBuffer : this.buffer;
    if (!bufferToUse) return;

    const now = Math.max(time, this.ctx.currentTime);

    // 1. Choke (Monophonic behavior for drums / Hi-Hats)
    // If a new note is triggered, stop the previous one immediately
    this.stop(now);

    // 2. Source Setup
    const source = this.ctx.createBufferSource();
    source.buffer = bufferToUse;

    // Pitch Calculation
    const totalSemitones = this.params.transpose + (this.params.fineTune / 100);
    const playbackRate = Math.pow(2, totalSemitones / 12);
    source.playbackRate.value = playbackRate;

    // 3. Filter Setup
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.max(20, Math.min(20000, this.params.cutoff));
    filter.Q.value = this.params.resonance;

    // 4. Amp Envelope (AHDSR)
    const envNode = this.ctx.createGain();
    const velFactor = 1 - this.params.velocitySens + (velocity * this.params.velocitySens);
    
    // Gain dB to Linear
    const masterGainLinear = Math.pow(10, this.params.gain / 20);
    const peakGain = masterGainLinear * velFactor;
    
    // Normalize Logic (Boost if peak is low)
    const normGain = this.params.normalize ? 1.5 : 1.0; 
    const finalPeak = Math.max(0, peakGain * normGain);

    // Panner
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = this.params.pan;

    // --- CONNECT GRAPH ---
    source.connect(filter);
    filter.connect(envNode);
    envNode.connect(panner);
    panner.connect(this.output);

    // --- SCHEDULE ENVELOPE ---
    envNode.gain.cancelScheduledValues(now);
    envNode.gain.setValueAtTime(0, now);
    
    // Attack
    const attackEnd = now + Math.max(0.001, this.params.attack);
    envNode.gain.linearRampToValueAtTime(finalPeak, attackEnd);
    
    // Hold
    const holdEnd = attackEnd + Math.max(0, this.params.hold);
    envNode.gain.setValueAtTime(finalPeak, holdEnd);
    
    // Decay -> Sustain
    const decayEnd = holdEnd + Math.max(0.001, this.params.decay);
    const sustainLevel = finalPeak * this.params.sustain;
    envNode.gain.exponentialRampToValueAtTime(Math.max(0.001, sustainLevel), decayEnd);
    
    // 5. Start / End Offset
    const bufferDuration = bufferToUse.duration;
    const startPos = this.params.sampleStart * bufferDuration;
    const endPos = this.params.sampleEnd * bufferDuration;
    let playDuration = Math.abs(endPos - startPos);
    
    // Correction if speed changes duration
    if (playDuration <= 0) playDuration = 0.01;

    // Adjust playback duration by rate
    const adjustedDuration = playDuration / playbackRate;

    source.start(now, startPos, playDuration);

    // Register active voice for choking
    this.activeSource = source;
    this.activeGain = envNode;
    
    // Force stop (Release logic is usually for NoteOff, but here we treat as One Shot with Release tail)
    // If sustain is 0, we let the decay finish. If sustain > 0, we hold until... well, drums usually decay.
    // We add a safety stop.
    const safetyStop = now + adjustedDuration + this.params.release + 1.0;
    
    // Cleanup callback
    source.onended = () => {
        if (this.activeSource === source) {
            this.activeSource = null;
            this.activeGain = null;
        }
        try {
           source.disconnect();
           filter.disconnect();
           envNode.disconnect();
           panner.disconnect();
        } catch(e) {}
    };
  }

  public stop(time: number = 0) {
      if (this.activeSource) {
          try {
              const now = Math.max(time, this.ctx.currentTime);
              // Quick fade out to avoid clicks (Choke)
              if (this.activeGain) {
                  this.activeGain.gain.cancelScheduledValues(now);
                  this.activeGain.gain.setValueAtTime(this.activeGain.gain.value, now);
                  this.activeGain.gain.linearRampToValueAtTime(0, now + 0.005);
              }
              this.activeSource.stop(now + 0.01);
          } catch(e) {}
          this.activeSource = null;
          this.activeGain = null;
      }
  }
}
