/**
 * AUDIO ANALYSIS ENGINE (DSP v3.0 - PROFESSIONAL)
 * Moteur de traitement avancé avec FFT et autocorrélation.
 * Détection BPM et Key de qualité professionnelle.
 */

// FIX: Changed import path to resolve module error. Other files use this path.
import { NOTES } from '../plugins/AutoTunePlugin';

const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export class AudioAnalysisEngine {

  public static async analyzeTrack(buffer: AudioBuffer): Promise<{ bpm: number, rootKey: number, scale: 'MAJOR' | 'MINOR', firstTransient: number }> {
    console.log("[DSP v3.0] Démarrage de l'analyse professionnelle...");
    
    if (buffer.length === 0 || buffer.duration < 2) {
      throw new Error("Buffer audio vide ou trop court (min 2s).");
    }

    // Utiliser une portion centrale du morceau (éviter intro/outro)
    const startTime = Math.min(10, buffer.duration * 0.2);
    const analysisLength = Math.min(30, buffer.duration * 0.6);

    // 1. Détection BPM avec autocorrélation
    const bpm = await this.detectBPMAdvanced(buffer, startTime, analysisLength);
    console.log(`[DSP] BPM détecté: ${bpm}`);

    // 2. Détection Tonalité avec FFT Chroma
    const keyData = await this.detectKeyFFT(buffer, startTime, analysisLength);
    console.log(`[DSP] Key détectée: ${keyData.root} ${keyData.scale}`);

    // 3. Détection du premier transient fort (drop)
    const firstTransient = await this.detectFirstHeavyTransient(buffer, 60);

    return {
      bpm,
      rootKey: keyData.root,
      scale: keyData.scale,
      firstTransient
    };
  }

  /**
   * DÉTECTION BPM AVANCÉE
   * Utilise l'autocorrélation de l'enveloppe d'énergie
   */
  public static async detectBPMAdvanced(buffer: AudioBuffer, startTime: number, duration: number): Promise<number> {
    const sampleRate = 11025; // Sous-échantillonnage pour rapidité
    const actualDuration = Math.min(duration, buffer.duration - startTime);
    
    const offlineCtx = new OfflineAudioContext(1, actualDuration * sampleRate, sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    // Filtre passe-bande pour les fréquences rythmiques (60-200 Hz = kick/bass)
    const lowpass = offlineCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 200;
    
    const highpass = offlineCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 60;
    
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(offlineCtx.destination);
    source.start(0, startTime, actualDuration);
    
    const rendered = await offlineCtx.startRendering();
    const data = rendered.getChannelData(0);
    
    // 1. Calculer l'enveloppe d'énergie (onset strength)
    const hopSize = Math.floor(sampleRate * 0.01); // 10ms hop
    const frameSize = Math.floor(sampleRate * 0.02); // 20ms frame
    const envelope: number[] = [];
    
    for (let i = 0; i < data.length - frameSize; i += hopSize) {
      let energy = 0;
      for (let j = 0; j < frameSize; j++) {
        energy += data[i + j] * data[i + j];
      }
      envelope.push(Math.sqrt(energy / frameSize));
    }
    
    // 2. Différenciation (onset detection)
    const onsetStrength: number[] = [0];
    for (let i = 1; i < envelope.length; i++) {
      onsetStrength.push(Math.max(0, envelope[i] - envelope[i - 1]));
    }
    
    // 3. Autocorrélation pour trouver la périodicité
    const minLag = Math.floor(60 / 200 * (sampleRate / hopSize)); // 200 BPM max
    const maxLag = Math.floor(60 / 60 * (sampleRate / hopSize));  // 60 BPM min
    
    const autocorr: number[] = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < onsetStrength.length - lag; i++) {
        sum += onsetStrength[i] * onsetStrength[i + lag];
        count++;
      }
      autocorr.push(sum / count);
    }
    
    // 4. Trouver le pic maximum (= période dominante)
    let maxCorr = 0;
    let bestLag = minLag;
    for (let i = 0; i < autocorr.length; i++) {
      if (autocorr[i] > maxCorr) {
        maxCorr = autocorr[i];
        bestLag = minLag + i;
      }
    }
    
    // Convertir lag en BPM
    const beatPeriodSec = (bestLag * hopSize) / sampleRate;
    let bpm = 60 / beatPeriodSec;
    
    // Normaliser dans la plage 70-180 BPM
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    
    // Arrondir au BPM entier le plus proche
    return Math.round(bpm);
  }

  /**
   * DÉTECTION KEY AVEC FFT ET CHROMA
   */
  public static async detectKeyFFT(buffer: AudioBuffer, startTime: number, duration: number): Promise<{ root: number, scale: 'MAJOR' | 'MINOR' }> {
    const sampleRate = buffer.sampleRate;
    const actualDuration = Math.min(duration, buffer.duration - startTime);
    
    // Extraire les données mono
    const startSample = Math.floor(startTime * sampleRate);
    const numSamples = Math.floor(actualDuration * sampleRate);
    const channelData = buffer.getChannelData(0);
    const data = channelData.slice(startSample, startSample + numSamples);
    
    // Paramètres FFT
    const fftSize = 8192;
    const hopSize = 4096;
    const chroma = new Float32Array(12).fill(0);
    let frameCount = 0;
    
    // Fenêtre de Hann
    const hannWindow = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }
    
    // Analyse par frames
    for (let frameStart = 0; frameStart < data.length - fftSize; frameStart += hopSize) {
      // Appliquer fenêtre
      const frame = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        frame[i] = data[frameStart + i] * hannWindow[i];
      }
      
      // FFT simple (DFT pour les fréquences qui nous intéressent)
      const spectrum = this.computeSpectrum(frame, sampleRate);
      
      // Accumuler dans les bins chroma
      for (let note = 0; note < 12; note++) {
        // Sommer l'énergie de toutes les octaves pour cette note (C0-C8)
        for (let octave = 1; octave <= 7; octave++) {
          const freq = 440 * Math.pow(2, (note - 9 + (octave - 4) * 12) / 12);
          const bin = Math.round(freq * fftSize / sampleRate);
          if (bin > 0 && bin < spectrum.length) {
            chroma[note] += spectrum[bin];
          }
        }
      }
      frameCount++;
    }
    
    // Normaliser
    if (frameCount > 0) {
      const maxChroma = Math.max(...chroma);
      if (maxChroma > 0) {
        for (let i = 0; i < 12; i++) {
          chroma[i] /= maxChroma;
        }
      }
    }
    
    // Corrélation avec profils Krumhansl-Schmuckler
    let bestCorr = -Infinity;
    let bestRoot = 0;
    let bestScale: 'MAJOR' | 'MINOR' = 'MAJOR';
    
    for (let root = 0; root < 12; root++) {
      const corrMaj = this.correlate(chroma, this.rotate(PROFILE_MAJOR, root));
      const corrMin = this.correlate(chroma, this.rotate(PROFILE_MINOR, root));
      
      if (corrMaj > bestCorr) {
        bestCorr = corrMaj;
        bestRoot = root;
        bestScale = 'MAJOR';
      }
      if (corrMin > bestCorr) {
        bestCorr = corrMin;
        bestRoot = root;
        bestScale = 'MINOR';
      }
    }
    
    return { root: bestRoot, scale: bestScale };
  }

  /**
   * Calcul du spectre de magnitude (DFT simplifié)
   */
  private static computeSpectrum(frame: Float32Array, sampleRate: number): Float32Array {
    const N = frame.length;
    const spectrum = new Float32Array(N / 2);
    
    // On ne calcule que les bins utiles (20Hz - 5000Hz)
    const minBin = Math.floor(20 * N / sampleRate);
    const maxBin = Math.min(Math.floor(5000 * N / sampleRate), N / 2);
    
    for (let k = minBin; k < maxBin; k++) {
      let real = 0;
      let imag = 0;
      for (let n = 0; n < N; n++) {
        const angle = -2 * Math.PI * k * n / N;
        real += frame[n] * Math.cos(angle);
        imag += frame[n] * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(real * real + imag * imag);
    }
    
    return spectrum;
  }

  /**
   * Détection du premier transient fort (drop)
   */
  public static async detectFirstHeavyTransient(buffer: AudioBuffer, scanDuration: number): Promise<number> {
    const targetSampleRate = 8000;
    const actualDuration = Math.min(buffer.duration, scanDuration);
    
    const offlineCtx = new OfflineAudioContext(1, actualDuration * targetSampleRate, targetSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    // Filtre passe-bas pour les basses (kick/drop)
    const lowpass = offlineCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 150;
    lowpass.Q.value = 0.7;

    source.connect(lowpass);
    lowpass.connect(offlineCtx.destination);
    source.start(0);
    
    const rendered = await offlineCtx.startRendering();
    const data = rendered.getChannelData(0);

    // Trouver le maximum global
    let maxAmp = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > maxAmp) maxAmp = abs;
    }
    
    // Seuil à 60% du max pour le drop
    const threshold = maxAmp * 0.6;
    
    // Ignorer les 2 premières secondes (souvent intro calme)
    const startSample = Math.floor(2 * targetSampleRate);
    
    for (let i = startSample; i < data.length; i++) {
      if (Math.abs(data[i]) > threshold) {
        return i / targetSampleRate;
      }
    }
    
    return 2; // Fallback: 2 secondes
  }

  private static correlate(v1: Float32Array, v2: number[]): number {
    let sum = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < 12; i++) {
      sum += v1[i] * v2[i];
      norm1 += v1[i] * v1[i];
      norm2 += v2[i] * v2[i];
    }
    // Corrélation normalisée (Pearson)
    return sum / (Math.sqrt(norm1) * Math.sqrt(norm2) + 0.0001);
  }

  private static rotate(arr: number[], n: number): number[] {
    const res = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      res[i] = arr[(i + n) % arr.length];
    }
    return res;
  }
}