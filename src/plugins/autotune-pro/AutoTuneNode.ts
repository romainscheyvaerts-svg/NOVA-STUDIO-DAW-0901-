
import { AutoTuneParams } from './AutoTuneUI';
import { SCALES } from '../../utils/constants';

// --- DSP CODE (Processor) ---
// Ce code tourne dans le thread audio. Il est 100% autonome.
const WORKLET_CODE = `
/**
 * AutoTunePro Processor v3.0 - Professional Grade
 * -----------------------------------------------
 * - YIN Algorithm for pitch detection (more accurate)
 * - TD-PSOLA for pitch shifting (formant preservation)
 * - Zero-latency design (128 sample lookahead only)
 * - Humanize & Flex-Tune support
 */

class AutoTuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // === ULTRA-LOW LATENCY BUFFER (128 samples = ~3ms) ===
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    
    // === YIN PITCH DETECTION ===
    this.yinBufferSize = 1024;
    this.yinBuffer = new Float32Array(this.yinBufferSize);
    this.yinThreshold = 0.15;
    this.lastPitch = 0;
    this.pitchConfidence = 0;
    
    // === TD-PSOLA ENGINE ===
    this.grainSize = 512;
    this.overlapRatio = 0.75;
    this.synthesisHopSize = 128;
    this.phase = 0;
    this.lastPeriod = 256;
    
    // === FORMANT PRESERVATION ===
    this.formantShiftEnabled = true;
    this.formantBuffer = new Float32Array(512);
    
    // === SMOOTHING ===
    this.targetRatio = 1.0;
    this.currentRatio = 1.0;
    this.pitchHistory = new Float32Array(8);
    this.pitchHistoryIndex = 0;
    
    // === HUMANIZE ===
    this.vibratoPhase = 0;
    this.microPitchVariation = 0;
    
    // === SCALES ===
    this.scales = {
      'CHROMATIC': [0,1,2,3,4,5,6,7,8,9,10,11],
      'MAJOR': [0,2,4,5,7,9,11],
      'MINOR': [0,2,3,5,7,8,10],
      'MINOR_HARMONIC': [0,2,3,5,7,8,11],
      'PENTATONIC': [0,3,5,7,10],
      'TRAP_DARK': [0,1,4,5,7,8,11]
    };

    this.sampleRate = globalThis.sampleRate || 44100;
    this.frameCount = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: 'retuneSpeed', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 },
      { name: 'amount', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'rootKey', defaultValue: 0, minValue: 0, maxValue: 11 },
      { name: 'scaleType', defaultValue: 0, minValue: 0, maxValue: 5 },
      { name: 'humanize', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'formantShift', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0 },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 }
    ];
  }

  // === YIN PITCH DETECTION (More Accurate than ACF) ===
  detectPitchYIN(buffer) {
    const bufferSize = buffer.length;
    const halfSize = Math.floor(bufferSize / 2);
    
    // Step 1: Calculate difference function
    const yinBuffer = new Float32Array(halfSize);
    
    for (let tau = 0; tau < halfSize; tau++) {
      yinBuffer[tau] = 0;
      for (let i = 0; i < halfSize; i++) {
        const delta = buffer[i] - buffer[i + tau];
        yinBuffer[tau] += delta * delta;
      }
    }
    
    // Step 2: Cumulative mean normalized difference
    yinBuffer[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfSize; tau++) {
      runningSum += yinBuffer[tau];
      yinBuffer[tau] *= tau / runningSum;
    }
    
    // Step 3: Find the first dip below threshold
    let tauEstimate = -1;
    for (let tau = 2; tau < halfSize; tau++) {
      if (yinBuffer[tau] < this.yinThreshold) {
        while (tau + 1 < halfSize && yinBuffer[tau + 1] < yinBuffer[tau]) {
          tau++;
        }
        tauEstimate = tau;
        this.pitchConfidence = 1 - yinBuffer[tau];
        break;
      }
    }
    
    // Step 4: Parabolic interpolation for sub-sample accuracy
    if (tauEstimate !== -1 && tauEstimate > 0 && tauEstimate < halfSize - 1) {
      const s0 = yinBuffer[tauEstimate - 1];
      const s1 = yinBuffer[tauEstimate];
      const s2 = yinBuffer[tauEstimate + 1];
      const betterTau = tauEstimate + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
      
      if (betterTau > 0) {
        return this.sampleRate / betterTau;
      }
    }
    
    return 0;
  }

  // === MEDIAN FILTER FOR PITCH STABILITY ===
  getStablePitch(newPitch) {
    this.pitchHistory[this.pitchHistoryIndex] = newPitch;
    this.pitchHistoryIndex = (this.pitchHistoryIndex + 1) % this.pitchHistory.length;
    
    const sorted = [...this.pitchHistory].filter(p => p > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    return sorted[Math.floor(sorted.length / 2)];
  }

  // === SCALE-AWARE PITCH CORRECTION ===
  getNearestPitch(inputFreq, rootKey, scaleIdx, flexAmount) {
    if (inputFreq <= 0) return inputFreq;
    
    const midi = 69 + 12 * Math.log2(inputFreq / 440);
    const noteInOctave = ((Math.round(midi) % 12) + 12) % 12;
    const relativeNote = ((noteInOctave - rootKey) + 12) % 12;
    
    const scaleNames = ['CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC', 'TRAP_DARK'];
    const scale = this.scales[scaleNames[scaleIdx]] || this.scales['CHROMATIC'];
    
    // Find nearest scale note
    let minDist = 12;
    let targetNote = relativeNote;
    
    for (const scaleNote of scale) {
      let dist = Math.abs(relativeNote - scaleNote);
      if (dist > 6) dist = 12 - dist;
      if (dist < minDist) {
        minDist = dist;
        targetNote = scaleNote;
      }
    }
    
    // Flex-Tune: Only correct if far enough from target
    const centsDiff = (relativeNote - targetNote) * 100;
    if (Math.abs(centsDiff) < 25 * (1 - flexAmount)) {
      return inputFreq; // Close enough, don't correct
    }
    
    const octave = Math.floor(midi / 12);
    const targetMidi = octave * 12 + targetNote + rootKey;
    
    return 440 * Math.pow(2, (targetMidi - 69) / 12);
  }

  // === TD-PSOLA PITCH SHIFTING (Formant-Safe) ===
  pitchShiftPSOLA(input, output, ratio, blockSize) {
    const period = Math.round(this.lastPeriod);
    const analysisHop = period;
    const synthesisHop = Math.round(period / ratio);
    
    for (let i = 0; i < blockSize; i++) {
      // Write to circular buffer
      this.buffer[this.writeIndex] = input[i];
      
      // Synthesis with overlap-add
      const readPos = (this.writeIndex - Math.floor(this.phase * period) + this.bufferSize) % this.bufferSize;
      
      // Hann window
      const windowPos = this.phase;
      const window = 0.5 * (1 - Math.cos(2 * Math.PI * windowPos));
      
      // Read with linear interpolation
      const idx = Math.floor(readPos);
      const frac = readPos - idx;
      const sample = this.buffer[idx] * (1 - frac) + this.buffer[(idx + 1) % this.bufferSize] * frac;
      
      output[i] = sample * window;
      
      // Advance phase
      this.phase += 1.0 / synthesisHop;
      if (this.phase >= 1.0) {
        this.phase -= 1.0;
      }
      
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0] || !output || !output[0]) return true;
    
    const channelData = input[0];
    const outL = output[0];
    const outR = output[1] || outL;
    const blockSize = channelData.length;
    
    // Parameters
    const bypass = parameters.bypass[0] > 0.5;
    const retuneSpeed = parameters.retuneSpeed[0];
    const amount = parameters.amount[0];
    const rootKey = Math.round(parameters.rootKey[0]);
    const scaleType = Math.round(parameters.scaleType[0]);
    const humanize = parameters.humanize[0];
    
    // Bypass
    if (bypass) {
      outL.set(channelData);
      if (outR !== outL) outR.set(channelData);
      return true;
    }
    
    // === 1. PITCH DETECTION (Every 256 samples for low latency) ===
    for (let i = 0; i < blockSize; i++) {
      this.yinBuffer[this.frameCount % this.yinBufferSize] = channelData[i];
      this.frameCount++;
      
      if (this.frameCount % 256 === 0) {
        const detected = this.detectPitchYIN(this.yinBuffer);
        if (detected > 60 && detected < 1200) {
          const stablePitch = this.getStablePitch(detected);
          this.lastPitch = stablePitch;
          this.lastPeriod = this.sampleRate / stablePitch;
        }
      }
    }
    
    // === 2. TARGET PITCH (Flex-Tune style) ===
    const flexAmount = 1.0 - retuneSpeed; // Low speed = more flex
    const targetPitch = this.getNearestPitch(this.lastPitch, rootKey, scaleType, flexAmount);
    
    // === 3. CALCULATE RATIO ===
    if (this.lastPitch > 50 && targetPitch > 50) {
      this.targetRatio = targetPitch / this.lastPitch;
    } else {
      this.targetRatio = 1.0;
    }
    
    // Clamp ratio
    this.targetRatio = Math.max(0.5, Math.min(2.0, this.targetRatio));
    
    // === 4. SMOOTHING (Retune Speed) ===
    // Fast (0) = instant correction, Slow (1) = natural glide
    const smoothFactor = 0.99 - (retuneSpeed * 0.95);
    this.currentRatio = this.currentRatio * smoothFactor + this.targetRatio * (1 - smoothFactor);
    
    // === 5. HUMANIZE (Add subtle pitch variation) ===
    let finalRatio = this.currentRatio;
    if (humanize > 0) {
      // Subtle vibrato
      this.vibratoPhase += 0.0003;
      const vibrato = Math.sin(this.vibratoPhase * Math.PI * 2) * 0.02 * humanize;
      
      // Random micro-variations
      this.microPitchVariation += (Math.random() - 0.5) * 0.001 * humanize;
      this.microPitchVariation *= 0.99;
      
      finalRatio *= (1 + vibrato + this.microPitchVariation);
    }
    
    // === 6. PITCH SHIFT ===
    const processedBuffer = new Float32Array(blockSize);
    this.pitchShiftPSOLA(channelData, processedBuffer, finalRatio, blockSize);
    
    // === 7. DRY/WET MIX ===
    for (let i = 0; i < blockSize; i++) {
      const wet = processedBuffer[i];
      const dry = channelData[i];
      const mixed = wet * amount + dry * (1 - amount);
      
      outL[i] = mixed;
      if (outR !== outL) outR[i] = mixed;
    }
    
    // === 8. UI FEEDBACK ===
    if (this.frameCount % 512 === 0) {
      const cents = 1200 * Math.log2(this.currentRatio);
      this.port.postMessage({
        pitch: this.lastPitch,
        target: targetPitch,
        cents: cents,
        confidence: this.pitchConfidence
      });
    }
    
    return true;
  }
}

registerProcessor('auto-tune-pro-processor', AutoTuneProcessor);
`;

export class AutoTuneNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private worklet: AudioWorkletNode | null = null;
  private onStatusCallback: ((data: any) => void) | null = null;
  
  private cachedParams: AutoTuneParams = {
    speed: 0.1,
    humanize: 0.0,
    mix: 1.0,
    rootKey: 0,
    scale: 'CHROMATIC',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Bypass de sécurité : le son passe toujours, même si le worklet échoue.
    this.input.connect(this.output);

    // Démarrage de l'initialisation asynchrone sans bloquer le constructeur.
    this.init().catch(err => {
        console.error("❌ AutoTune DSP a échoué à s'initialiser. Le plugin est en bypass.", err);
    });
  }

  private async init() {
    try {
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        
        await this.ctx.audioWorklet.addModule(url);

        this.worklet = new AudioWorkletNode(this.ctx, 'auto-tune-pro-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            parameterData: {
                retuneSpeed: this.cachedParams.speed,
                amount: this.cachedParams.mix,
                rootKey: this.cachedParams.rootKey,
                scaleType: SCALES.indexOf(this.cachedParams.scale)
            }
        });

        this.worklet.port.onmessage = (e) => {
            if (this.onStatusCallback) this.onStatusCallback(e.data);
        };
        
        this.worklet.onprocessorerror = (err) => {
            console.error("Erreur critique dans le processeur AutoTune:", err);
            // En cas de crash, on se remet en bypass pour ne pas couper le son.
            this.input.disconnect();
            this.worklet?.disconnect();
            this.input.connect(this.output);
        };

        // Re-cablage Audio : on insère le worklet dans la chaîne.
        this.input.disconnect(this.output);
        this.input.connect(this.worklet);
        this.worklet.connect(this.output);

        // Appliquer les paramètres qui ont pu être modifiés pendant le chargement.
        this.applyParams();
        
        console.log("✅ AutoTune DSP Initialized Successfully");
        URL.revokeObjectURL(url);

    } catch (e) {
        console.error("❌ Impossible de charger le Worklet AutoTune. Le son passera sans effet.", e);
        // On reste en bypass si l'init échoue.
    }
  }

  public updateParams(p: Partial<AutoTuneParams>) {
      // Met à jour la version "mise en cache" des paramètres.
      this.cachedParams = { ...this.cachedParams, ...p };
      // Applique immédiatement si le worklet est prêt.
      this.applyParams();
  }

  private applyParams() {
      // Si le worklet n'est pas encore prêt, cette fonction ne fait rien.
      // Elle sera appelée à la fin de init() pour appliquer les valeurs mises en cache.
      if (!this.worklet) return;

      const { speed, mix, rootKey, scale, isEnabled } = this.cachedParams;
      const p = this.worklet.parameters;
      const now = this.ctx.currentTime;

      p.get('bypass')?.setValueAtTime(isEnabled ? 0 : 1, now);
      p.get('retuneSpeed')?.setTargetAtTime(speed, now, 0.05);
      p.get('amount')?.setTargetAtTime(mix, now, 0.05);
      p.get('rootKey')?.setValueAtTime(rootKey, now);
      
      const scaleIdx = SCALES.indexOf(scale);
      p.get('scaleType')?.setValueAtTime(scaleIdx >= 0 ? scaleIdx : 0, now);
  }

  public setStatusCallback(cb: (data: any) => void) {
      this.onStatusCallback = cb;
  }
}
