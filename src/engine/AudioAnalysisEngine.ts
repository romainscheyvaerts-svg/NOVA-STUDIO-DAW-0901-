
import { NOTES } from '../utils/constants';

/**
 * AUDIO ANALYSIS ENGINE (DSP v2.1)
 * Moteur de traitement intelligent avec segmentation contextuelle optimisée.
 * Spécialisé pour les musiques modernes (Pop/Rap/Electro) avec détection Kick-Heavy.
 */

// Profils Krumhansl-Schmuckler
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export class AudioAnalysisEngine {

  public static async analyzeTrack(buffer: AudioBuffer): Promise<{ bpm: number, rootKey: number, scale: 'MAJOR' | 'MINOR', firstTransient: number }> {
    console.log("[DSP] Démarrage de l'analyse intelligente v2.1...");
    
    if (buffer.length === 0 || buffer.duration < 1) {
        throw new Error("Buffer audio vide ou trop court.");
    }

    // 1. Segmentation Intelligente
    const segments = await this.findBestSegments(buffer);
    
    console.log(`[DSP] Segments trouvés : BPM (Zone Drums) à ${segments.bpmStartTime.toFixed(1)}s, KEY (Zone Harmonique) à ${segments.keyStartTime.toFixed(1)}s`);

    // 2. Détection BPM sur la zone riche en batterie (10s suffisent généralement pour un lock précis)
    const bpm = await this.detectBPM(buffer, segments.bpmStartTime, 10); 
    
    // 3. Détection Tonalité sur la zone calme
    const keyData = await this.detectKey(buffer, segments.keyStartTime, 15); 

    // 4. Détection du Drop pour calage
    const firstTransient = await this.detectFirstHeavyTransient(buffer, 45);

    return {
      bpm,
      rootKey: keyData.root,
      scale: keyData.scale,
      firstTransient
    };
  }

  private static async findBestSegments(buffer: AudioBuffer): Promise<{ bpmStartTime: number, keyStartTime: number }> {
    const offlineCtx = new OfflineAudioContext(1, buffer.duration * 16000, 16000);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    const lowpass = offlineCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 150;
    
    source.connect(lowpass);
    lowpass.connect(offlineCtx.destination);
    source.start(0);
    
    const rendered = await offlineCtx.startRendering();
    const data = rendered.getChannelData(0);
    
    const windowSize = 5 * 16000; 
    let maxLowEndEnergy = 0;
    let minLowEndEnergy = Infinity;
    
    let bestBpmStart = 0;
    let bestKeyStart = 0;

    for (let i = 0; i < data.length - windowSize; i += windowSize) {
      let energy = 0;
      let peaksCount = 0;
      
      for (let j = 0; j < windowSize; j += 100) {
         const val = Math.abs(data[i + j]);
         energy += val;
         if (val > 0.5) peaksCount++;
      }
      
      if (energy > maxLowEndEnergy && peaksCount > 5) {
        maxLowEndEnergy = energy;
        bestBpmStart = i / 16000;
      }

      if (energy < minLowEndEnergy && energy > (maxLowEndEnergy * 0.1)) {
        minLowEndEnergy = energy;
        bestKeyStart = i / 16000;
      }
    }

    if (maxLowEndEnergy === 0) bestBpmStart = buffer.duration / 3;
    if (bestKeyStart === 0) bestKeyStart = 0;

    return { bpmStartTime: bestBpmStart, keyStartTime: bestKeyStart };
  }

  public static async detectBPM(buffer: AudioBuffer, startTime: number, duration: number): Promise<number> {
    const offlineCtx = new OfflineAudioContext(1, duration * buffer.sampleRate, buffer.sampleRate);
    
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    const filter = offlineCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 150;
    filter.Q.value = 1;

    source.connect(filter);
    filter.connect(offlineCtx.destination);
    
    source.start(0, startTime, duration);
    
    const rendered = await offlineCtx.startRendering();
    const data = rendered.getChannelData(0);

    let maxPeak = 0;
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > maxPeak) maxPeak = Math.abs(data[i]);
    }
    
    const dynamicThreshold = maxPeak * 0.65; 
    
    const peaks: number[] = [];
    let lastPeakTime = -1;
    const minDistance = 0.25; 

    for (let i = 0; i < data.length; i++) {
      if (data[i] > dynamicThreshold) {
        const time = i / buffer.sampleRate;
        if (lastPeakTime === -1 || (time - lastPeakTime) > minDistance) {
          peaks.push(time);
          lastPeakTime = time;
        }
      }
    }

    if (peaks.length < 4) {
        console.warn("[DSP] Pas assez de pics pour détecter le BPM.");
        return 120; 
    }

    const intervals: Record<number, number> = {};
    
    for (let i = 1; i < peaks.length; i++) {
      const interval = peaks[i] - peaks[i-1];
      const quantized = Math.round(interval * 50) / 50; 
      
      if (quantized > 0.3 && quantized < 1.5) {
         intervals[quantized] = (intervals[quantized] || 0) + 1;
      }
    }

    let bestInterval = 0;
    let maxCount = 0;
    
    Object.keys(intervals).forEach(k => {
       const key = parseFloat(k);
       if (intervals[key] > maxCount) {
         maxCount = intervals[key];
         bestInterval = key;
       }
    });

    if (bestInterval === 0) return 120;

    let bpm = 60 / bestInterval;
    
    while (bpm < 75) bpm *= 2;
    while (bpm > 165) bpm /= 2;

    return Math.round(bpm);
  }

  public static async detectFirstHeavyTransient(buffer: AudioBuffer, scanDuration: number): Promise<number> {
    const offlineCtx = new OfflineAudioContext(1, Math.min(buffer.duration, scanDuration) * 10000, 10000); 
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    const lowpass = offlineCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 120; 
    lowpass.Q.value = 1.0;

    source.connect(lowpass);
    lowpass.connect(offlineCtx.destination);
    source.start(0);
    
    const rendered = await offlineCtx.startRendering();
    const data = rendered.getChannelData(0);

    let maxAmp = 0;
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > maxAmp) maxAmp = Math.abs(data[i]);
    }
    
    const threshold = maxAmp * 0.7;
    
    for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > threshold) {
            return i / 10000;
        }
    }
    return 0;
  }

  public static async detectKey(buffer: AudioBuffer, startTime: number, duration: number): Promise<{ root: number, scale: 'MAJOR' | 'MINOR' }> {
    const offlineCtx = new OfflineAudioContext(1, duration * buffer.sampleRate, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    const bandpass = offlineCtx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 400;
    bandpass.Q.value = 0.5;

    source.connect(bandpass);
    bandpass.connect(offlineCtx.destination);
    source.start(0, startTime, duration);

    const rendered = await offlineCtx.startRendering();
    const data = rendered.getChannelData(0);

    const chroma = new Float32Array(12).fill(0);
    const sampleRate = buffer.sampleRate;
    const windowSize = 4096;
    
    for (let i = 0; i < data.length; i += windowSize) {
       let rms = 0;
       for(let k=0; k<windowSize && i+k<data.length; k++) rms += data[i+k]*data[i+k];
       if (rms < 0.0001) continue;

       const chunk = data.subarray(i, i + windowSize);
       const freq = this.getPitch(chunk, sampleRate);
       
       if (freq > 50 && freq < 1000) {
          const midi = 12 * Math.log2(freq / 440) + 69;
          const noteIndex = Math.round(midi) % 12;
          if (noteIndex >= 0) chroma[noteIndex] += 1;
       }
    }

    const maxVal = Math.max(...chroma);
    const normalizedChroma = chroma.map(v => v / (maxVal || 1));

    let bestCorrelation = -Infinity;
    let bestRoot = 0;
    let bestScale: 'MAJOR' | 'MINOR' = 'MAJOR';

    for (let root = 0; root < 12; root++) {
      const corrMaj = this.correlate(normalizedChroma, this.rotate(PROFILE_MAJOR, root));
      const corrMin = this.correlate(normalizedChroma, this.rotate(PROFILE_MINOR, root));
      
      if (corrMaj > bestCorrelation) { bestCorrelation = corrMaj; bestRoot = root; bestScale = 'MAJOR'; }
      if (corrMin > bestCorrelation) { bestCorrelation = corrMin; bestRoot = root; bestScale = 'MINOR'; }
    }

    return { root: bestRoot, scale: bestScale };
  }

  private static getPitch(buffer: Float32Array, sampleRate: number): number {
    let bestOffset = -1;
    let bestCorrelation = 0;
    for (let offset = 40; offset < 900; offset++) { 
       if (offset >= buffer.length) break;
       let correlation = 0;
       for (let i = 0; i < 1000 && i + offset < buffer.length; i += 2) {
          correlation += Math.abs(buffer[i] - buffer[i + offset]);
       }
       const score = 1 / (1 + correlation);
       if (score > bestCorrelation) {
          bestCorrelation = score;
          bestOffset = offset;
       }
    }
    if (bestOffset > 0) return sampleRate / bestOffset;
    return 0;
  }

  private static correlate(v1: Float32Array, v2: number[]): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += v1[i] * v2[i];
    return sum;
  }

  private static rotate(arr: number[], n: number): number[] {
    const res = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) res[(i + n) % arr.length] = arr[i];
    return res;
  }
}
