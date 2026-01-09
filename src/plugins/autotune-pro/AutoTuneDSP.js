
/**
 * AutoTunePro Processor (DSP) v2.0
 * --------------------------------
 * Algorithme optimisé pour la correction vocale temps réel.
 */

class AutoTuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // --- AUDIO BUFFERING (Ring Buffer) ---
    this.bufferSize = 4096;
    this.bufferMask = this.bufferSize - 1;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;

    // --- PITCH DETECTION (ACF) ---
    this.analysisBuffer = new Float32Array(1024);
    this.analysisIndex = 0;
    this.lastDetectedFreq = 440; // Hz
    this.framesSinceLastAnalysis = 0;
    this.sampleRate = 44100; // Défaut, sera mis à jour

    // --- PITCH SHIFTING (Granular / PSOLA simplified) ---
    this.phase = 0;
    this.grainSize = 2048;
    this.currentRatio = 1.0;

    // --- MUSICAL DATA ---
    this.scales = {
      'CHROMATIC': [0,1,2,3,4,5,6,7,8,9,10,11],
      'MAJOR': [0,2,4,5,7,9,11],
      'MINOR': [0,2,3,5,7,8,10],
      'MINOR_HARMONIC': [0,2,3,5,7,8,11],
      'PENTATONIC': [0,3,5,7,10],
      'TRAP_DARK': [0,1,4,5,7,8,11]
    };
  }

  static get parameterDescriptors() {
    return [
      { name: 'retuneSpeed', defaultValue: 0.1, minValue: 0.0, maxValue: 1.0 },
      { name: 'amount', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'rootKey', defaultValue: 0, minValue: 0, maxValue: 11 },
      { name: 'scaleType', defaultValue: 0, minValue: 0, maxValue: 5 },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 }
    ];
  }

  detectPitch(buffer) {
    const SIZE = buffer.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    
    // Noise Gate
    if (rms < 0.01) return 0; 

    // Range Vocal Utile (80Hz - 1000Hz)
    // sampleRate / freq = period (samples)
    const minPeriod = 44; // ~1000Hz à 44.1k
    const maxPeriod = 551; // ~80Hz à 44.1k

    let bestCorrelation = 0;
    let bestOffset = -1;

    // Autocorrélation Optimisée (Sauts de 2 samples)
    for (let offset = minPeriod; offset < maxPeriod; offset++) {
      let correlation = 0;
      for (let i = 0; i < SIZE - offset; i += 2) { 
        correlation += buffer[i] * buffer[i + offset];
      }
      
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = offset;
      }
    }

    if (bestCorrelation > 0.5 && bestOffset > 0) {
      return currentFrame >= 0 ? (globalThis.sampleRate || 44100) / bestOffset : 44100 / bestOffset;
    }
    return 0;
  }

  getNearestFreq(inputFreq, rootKey, scaleIdx) {
    if (inputFreq <= 0) return inputFreq;

    const midi = 69 + 12 * Math.log2(inputFreq / 440);
    const note = Math.round(midi);
    
    // Sélection Gamme
    const scaleNames = ['CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC', 'TRAP_DARK'];
    const currentScale = this.scales[scaleNames[scaleIdx]] || this.scales['CHROMATIC'];
    
    const noteInOctave = note % 12;
    const relativeNote = (noteInOctave - rootKey + 12) % 12;

    let minDiff = Infinity;
    let targetRelative = relativeNote;

    // Nearest Neighbor dans la gamme
    for (let i = 0; i < currentScale.length; i++) {
      const scaleNote = currentScale[i];
      let diff = Math.abs(relativeNote - scaleNote);
      if (diff > 6) diff = 12 - diff; // Wrap autour de 12

      if (diff < minDiff) {
        minDiff = diff;
        targetRelative = scaleNote;
      }
    }

    // Reconstruction MIDI
    let octaveShift = 0;
    const dist = targetRelative - relativeNote;
    if (dist > 6) octaveShift = -1;
    if (dist < -6) octaveShift = 1;

    const targetMidi = (Math.floor(midi / 12) + octaveShift) * 12 + targetRelative + rootKey;
    
    return 440 * Math.pow(2, (targetMidi - 69) / 12);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const bypass = parameters.bypass[0];

    // Bypass Hardware
    if (bypass > 0.5 || !input || !input[0]) {
      if (input && input[0] && output && output[0]) {
          output[0].set(input[0]);
          if(output[1] && input[1]) output[1].set(input[1]);
      }
      return true;
    }

    const channelData = input[0]; // Mono processing for pitch detection
    const outL = output[0];
    const outR = output[1] || outL; // Fallback mono->stereo
    const blockSize = channelData.length;

    // Paramètres
    const retuneSpeed = parameters.retuneSpeed[0];
    const amount = parameters.amount[0];
    const rootKey = Math.round(parameters.rootKey[0]);
    const scaleType = Math.round(parameters.scaleType[0]);

    // 1. ANALYSE
    if (this.analysisIndex + blockSize < this.analysisBuffer.length) {
      this.analysisBuffer.set(channelData, this.analysisIndex);
      this.analysisIndex += blockSize;
    } else {
      const detected = this.detectPitch(this.analysisBuffer);
      if (detected > 0) {
        this.lastDetectedFreq = detected;
      }
      this.analysisIndex = 0;
    }

    // 2. CIBLE
    const targetFreq = this.getNearestFreq(this.lastDetectedFreq, rootKey, scaleType);
    let targetRatio = 1.0;

    if (this.lastDetectedFreq > 50 && targetFreq > 50) {
      targetRatio = targetFreq / this.lastDetectedFreq;
    }
    
    // Clamp pour éviter les artefacts extrêmes
    targetRatio = Math.max(0.5, Math.min(2.0, targetRatio));
    
    // 3. LISSAGE (Retune Speed)
    // 0.1 (Fast) -> 0.99 (Slow)
    const smoothing = 0.1 + (retuneSpeed * 0.89); 
    this.currentRatio = (this.currentRatio * smoothing) + (targetRatio * (1 - smoothing));

    // 4. SYNTHÈSE GRANULAIRE (Pitch Shifting)
    for (let i = 0; i < blockSize; i++) {
      this.buffer[this.writeIndex] = channelData[i];

      // Modulation de phase (Vitesse de lecture)
      this.phase += (1.0 - this.currentRatio) / this.grainSize;
      
      if (this.phase > 1) this.phase -= 1;
      if (this.phase < 0) this.phase += 1;

      // Double tête de lecture (Crossfade)
      const offsetA = this.phase * this.grainSize;
      const offsetB = ((this.phase + 0.5) % 1) * this.grainSize;

      let readPosA = this.writeIndex - offsetA;
      let readPosB = this.writeIndex - offsetB;

      // Buffer Wrap
      if (readPosA < 0) readPosA += this.bufferSize;
      if (readPosB < 0) readPosB += this.bufferSize;

      // Interpolation
      const idxA = Math.floor(readPosA);
      const fracA = readPosA - idxA;
      const valA = this.buffer[idxA & this.bufferMask] * (1-fracA) + 
                   this.buffer[(idxA+1) & this.bufferMask] * fracA;

      const idxB = Math.floor(readPosB);
      const fracB = readPosB - idxB;
      const valB = this.buffer[idxB & this.bufferMask] * (1-fracB) + 
                   this.buffer[(idxB+1) & this.bufferMask] * fracB;

      // Fenêtrage (Triangle)
      const winA = 1 - 2 * Math.abs(this.phase - 0.5);
      const winB = 1 - 2 * Math.abs(((this.phase + 0.5) % 1) - 0.5);

      const wet = (valA * winA) + (valB * winB);
      
      // Mixage final
      const signal = (wet * amount) + (channelData[i] * (1 - amount));
      outL[i] = signal;
      if (outR) outR[i] = signal;

      this.writeIndex = (this.writeIndex + 1) & this.bufferMask;
    }

    // 5. UI FEEDBACK (Throttled)
    if (this.framesSinceLastAnalysis++ > 8) {
      this.port.postMessage({
        pitch: this.lastDetectedFreq,
        target: targetFreq,
        cents: 1200 * Math.log2(this.currentRatio)
      });
      this.framesSinceLastAnalysis = 0;
    }

    return true;
  }
}

registerProcessor('auto-tune-pro-processor', AutoTuneProcessor);
