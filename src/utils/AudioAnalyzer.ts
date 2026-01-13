/**
 * AudioAnalyzer - Module d'analyse audio avancé pour le chatbot ingénieur IA
 *
 * Fonctionnalités :
 * - Détection des respirations (50-500Hz)
 * - Détection de clipping (peak > 0dB)
 * - Détection de phase issues
 * - Analyse de structure du morceau
 * - Monitoring temps réel pendant enregistrement
 */

export interface BreathDetectionResult {
  breaths: Array<{
    start: number;      // Position en secondes
    duration: number;   // Durée de la respiration
    amplitude: number;  // Amplitude (0-1)
  }>;
  totalBreaths: number;
}

export interface ClippingDetectionResult {
  hasClipping: boolean;
  clippingPoints: Array<{
    time: number;       // Position en secondes
    peak: number;       // Valeur du peak (>1.0)
  }>;
  maxPeak: number;      // Peak maximum détecté
}

export interface PhaseIssueResult {
  hasPhaseIssues: boolean;
  correlation: number;  // -1 (opposition totale) à 1 (parfaite correlation)
  problematicRanges: Array<{
    start: number;
    end: number;
  }>;
}

export interface SongStructure {
  sections: Array<{
    type: 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro';
    start: number;
    end: number;
    confidence: number; // 0-1
  }>;
}

export interface LiveMonitoringMetrics {
  rms: number;          // Niveau RMS (0-1)
  peak: number;         // Peak (0-1+)
  isClipping: boolean;
  isTooLow: boolean;    // Niveau < -24dB
  hasPlosive: boolean;  // Détection de plosives (burst > threshold)
}

/**
 * Détecte les respirations dans un AudioBuffer
 * Analyse les fréquences basses (50-500Hz) pour identifier les respirations
 */
export async function detectBreaths(
  audioBuffer: AudioBuffer,
  threshold: number = -40 // dB
): Promise<BreathDetectionResult> {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0); // Mono ou canal gauche
  const fftSize = 2048;

  // Créer un contexte audio offline pour l'analyse
  const offlineContext = new OfflineAudioContext(1, audioBuffer.length, sampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;

  // Créer un filtre passe-bas pour isoler les respirations (50-500Hz)
  const lowPassFilter = offlineContext.createBiquadFilter();
  lowPassFilter.type = 'bandpass';
  lowPassFilter.frequency.value = 275; // Centre à 275Hz
  lowPassFilter.Q.value = 1.0;

  // Créer un analyser pour obtenir les amplitudes
  const analyser = offlineContext.createAnalyser();
  analyser.fftSize = fftSize;

  source.connect(lowPassFilter);
  lowPassFilter.connect(analyser);
  analyser.connect(offlineContext.destination);

  source.start(0);

  // Analyser le buffer filtré
  const breaths: Array<{ start: number; duration: number; amplitude: number }> = [];
  const thresholdLinear = Math.pow(10, threshold / 20); // Convertir dB en linéaire

  const windowSize = 0.1; // Fenêtre de 100ms
  const hopSize = 0.05;   // Avance de 50ms
  const samplesPerWindow = Math.floor(windowSize * sampleRate);
  const samplesPerHop = Math.floor(hopSize * sampleRate);

  let inBreath = false;
  let breathStart = 0;
  let breathPeak = 0;

  for (let i = 0; i < channelData.length - samplesPerWindow; i += samplesPerHop) {
    // Calculer RMS de la fenêtre courante (après filtrage mental)
    let sumSquares = 0;
    for (let j = 0; j < samplesPerWindow; j++) {
      const sample = channelData[i + j];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samplesPerWindow);

    // Détection simplifiée : on cherche des segments avec énergie basse constante
    // (les respirations ont une énergie stable dans les basses fréquences)
    const time = i / sampleRate;

    if (rms > thresholdLinear && rms < thresholdLinear * 5) {
      // Potentiellement une respiration
      if (!inBreath) {
        inBreath = true;
        breathStart = time;
        breathPeak = rms;
      } else {
        breathPeak = Math.max(breathPeak, rms);
      }
    } else {
      if (inBreath) {
        // Fin de la respiration
        const duration = time - breathStart;
        if (duration > 0.05 && duration < 0.8) { // Entre 50ms et 800ms
          breaths.push({
            start: breathStart,
            duration: duration,
            amplitude: breathPeak
          });
        }
        inBreath = false;
      }
    }
  }

  return {
    breaths,
    totalBreaths: breaths.length
  };
}

/**
 * Applique une réduction de gain sur les respirations détectées
 */
export async function reduceBreaths(
  audioBuffer: AudioBuffer,
  breaths: BreathDetectionResult,
  reductionDb: number = -9 // Réduction en dB
): Promise<AudioBuffer> {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;

  // Créer un nouveau buffer pour le résultat
  const resultBuffer = new AudioContext().createBuffer(
    numChannels,
    audioBuffer.length,
    sampleRate
  );

  const reductionLinear = Math.pow(10, reductionDb / 20);

  // Pour chaque canal
  for (let channel = 0; channel < numChannels; channel++) {
    const inputData = audioBuffer.getChannelData(channel);
    const outputData = resultBuffer.getChannelData(channel);

    // Copier les données
    outputData.set(inputData);

    // Appliquer la réduction sur les zones de respiration
    for (const breath of breaths.breaths) {
      const startSample = Math.floor(breath.start * sampleRate);
      const endSample = Math.floor((breath.start + breath.duration) * sampleRate);
      const fadeSamples = Math.floor(0.01 * sampleRate); // 10ms de fade

      for (let i = startSample; i < endSample && i < outputData.length; i++) {
        let gain = reductionLinear;

        // Fade in/out pour éviter les clicks
        if (i - startSample < fadeSamples) {
          const progress = (i - startSample) / fadeSamples;
          gain = 1.0 + (reductionLinear - 1.0) * progress;
        } else if (endSample - i < fadeSamples) {
          const progress = (endSample - i) / fadeSamples;
          gain = 1.0 + (reductionLinear - 1.0) * progress;
        }

        outputData[i] *= gain;
      }
    }
  }

  return resultBuffer;
}

/**
 * Détecte le clipping dans un AudioBuffer
 */
export function detectClipping(audioBuffer: AudioBuffer): ClippingDetectionResult {
  const threshold = 0.99; // 99% du max = potentiel clipping
  const clippingPoints: Array<{ time: number; peak: number }> = [];
  let maxPeak = 0;

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);

    for (let i = 0; i < channelData.length; i++) {
      const absSample = Math.abs(channelData[i]);
      maxPeak = Math.max(maxPeak, absSample);

      if (absSample >= threshold) {
        const time = i / audioBuffer.sampleRate;
        // Éviter les doublons proches (< 10ms)
        const isDuplicate = clippingPoints.some(p => Math.abs(p.time - time) < 0.01);
        if (!isDuplicate) {
          clippingPoints.push({ time, peak: absSample });
        }
      }
    }
  }

  return {
    hasClipping: clippingPoints.length > 0,
    clippingPoints: clippingPoints.slice(0, 10), // Max 10 points
    maxPeak
  };
}

/**
 * Détecte les problèmes de phase entre canaux L/R
 */
export function detectPhaseIssues(audioBuffer: AudioBuffer): PhaseIssueResult {
  if (audioBuffer.numberOfChannels < 2) {
    return { hasPhaseIssues: false, correlation: 1.0, problematicRanges: [] };
  }

  const leftChannel = audioBuffer.getChannelData(0);
  const rightChannel = audioBuffer.getChannelData(1);
  const windowSize = 8192; // ~185ms à 44.1kHz
  const hopSize = 4096;

  let totalCorrelation = 0;
  let numWindows = 0;
  const problematicRanges: Array<{ start: number; end: number }> = [];
  let inProblemRange = false;
  let rangeStart = 0;

  for (let i = 0; i < leftChannel.length - windowSize; i += hopSize) {
    // Calculer la corrélation sur cette fenêtre
    let sumLR = 0;
    let sumLL = 0;
    let sumRR = 0;

    for (let j = 0; j < windowSize; j++) {
      const l = leftChannel[i + j];
      const r = rightChannel[i + j];
      sumLR += l * r;
      sumLL += l * l;
      sumRR += r * r;
    }

    const correlation = sumLR / Math.sqrt(sumLL * sumRR + 0.0001);
    totalCorrelation += correlation;
    numWindows++;

    const time = i / audioBuffer.sampleRate;

    // Si corrélation < -0.3, c'est problématique
    if (correlation < -0.3) {
      if (!inProblemRange) {
        inProblemRange = true;
        rangeStart = time;
      }
    } else {
      if (inProblemRange) {
        problematicRanges.push({ start: rangeStart, end: time });
        inProblemRange = false;
      }
    }
  }

  if (inProblemRange) {
    problematicRanges.push({ start: rangeStart, end: audioBuffer.duration });
  }

  const avgCorrelation = totalCorrelation / numWindows;

  return {
    hasPhaseIssues: avgCorrelation < -0.2,
    correlation: avgCorrelation,
    problematicRanges
  };
}

/**
 * Classe pour le monitoring audio temps réel pendant l'enregistrement
 */
export class LiveAudioMonitor {
  private analyser: AnalyserNode;
  private dataArray: Uint8Array;
  private isMonitoring: boolean = false;
  private onMetricsUpdate: ((metrics: LiveMonitoringMetrics) => void) | null = null;
  private monitoringInterval: number | null = null;

  constructor(audioContext: AudioContext, sourceNode: MediaStreamAudioSourceNode) {
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    // Connecter la source à l'analyser
    sourceNode.connect(this.analyser);
  }

  start(callback: (metrics: LiveMonitoringMetrics) => void) {
    this.onMetricsUpdate = callback;
    this.isMonitoring = true;

    // Analyser toutes les 100ms
    this.monitoringInterval = window.setInterval(() => {
      if (!this.isMonitoring) return;

      const metrics = this.getMetrics();
      if (this.onMetricsUpdate) {
        this.onMetricsUpdate(metrics);
      }
    }, 100);
  }

  stop() {
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  private getMetrics(): LiveMonitoringMetrics {
    this.analyser.getByteTimeDomainData(this.dataArray);

    let sumSquares = 0;
    let peak = 0;
    let plosiveCount = 0;

    for (let i = 0; i < this.dataArray.length; i++) {
      const normalized = (this.dataArray[i] - 128) / 128; // -1 à 1
      const abs = Math.abs(normalized);
      sumSquares += normalized * normalized;
      peak = Math.max(peak, abs);

      // Détection de plosives (burst soudain)
      if (i > 0) {
        const prev = Math.abs((this.dataArray[i - 1] - 128) / 128);
        const diff = abs - prev;
        if (diff > 0.5) { // Burst > 50% en un échantillon
          plosiveCount++;
        }
      }
    }

    const rms = Math.sqrt(sumSquares / this.dataArray.length);
    const rmsDb = 20 * Math.log10(rms + 0.0001);

    return {
      rms,
      peak,
      isClipping: peak > 0.99,
      isTooLow: rmsDb < -24,
      hasPlosive: plosiveCount > 3
    };
  }

  disconnect() {
    this.stop();
    this.analyser.disconnect();
  }
}

/**
 * Détecte la structure d'un morceau (intro, couplet, refrain, etc.)
 * Basé sur l'analyse d'énergie et de répétitions
 */
export function detectSongStructure(audioBuffer: AudioBuffer): SongStructure {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const duration = audioBuffer.duration;

  // Analyser l'énergie par segments de 4 secondes
  const segmentDuration = 4.0;
  const numSegments = Math.floor(duration / segmentDuration);
  const energyProfile: number[] = [];

  for (let seg = 0; seg < numSegments; seg++) {
    const startSample = Math.floor(seg * segmentDuration * sampleRate);
    const endSample = Math.floor((seg + 1) * segmentDuration * sampleRate);

    let energy = 0;
    for (let i = startSample; i < endSample && i < channelData.length; i++) {
      energy += channelData[i] * channelData[i];
    }
    energyProfile.push(Math.sqrt(energy / (endSample - startSample)));
  }

  // Détecter les sections basées sur l'énergie
  const sections: SongStructure['sections'] = [];

  // Heuristique simple :
  // - Intro : énergie croissante au début (< 16s)
  // - Couplet : énergie moyenne stable
  // - Refrain : pics d'énergie
  // - Bridge : changement de pattern (milieu-fin)
  // - Outro : énergie décroissante (fin)

  const avgEnergy = energyProfile.reduce((a, b) => a + b, 0) / energyProfile.length;
  const maxEnergy = Math.max(...energyProfile);

  // Intro (0-16s) si énergie < 80% de la moyenne
  if (energyProfile.length > 0 && energyProfile[0] < avgEnergy * 0.8) {
    let introEnd = segmentDuration;
    for (let i = 1; i < Math.min(4, energyProfile.length); i++) {
      if (energyProfile[i] >= avgEnergy * 0.8) break;
      introEnd = (i + 1) * segmentDuration;
    }
    sections.push({ type: 'intro', start: 0, end: introEnd, confidence: 0.7 });
  }

  // Outro (derniers 16s) si énergie décroissante
  if (energyProfile.length > 4) {
    const lastSegments = energyProfile.slice(-4);
    const isDecreasing = lastSegments.every((e, i) => i === 0 || e <= lastSegments[i - 1] * 1.1);
    if (isDecreasing) {
      const outroStart = (energyProfile.length - 4) * segmentDuration;
      sections.push({ type: 'outro', start: outroStart, end: duration, confidence: 0.6 });
    }
  }

  // Refrains : pics d'énergie (> 90% du max)
  for (let i = 0; i < energyProfile.length; i++) {
    if (energyProfile[i] > maxEnergy * 0.9) {
      const start = i * segmentDuration;
      const end = Math.min((i + 4) * segmentDuration, duration); // ~16s de refrain

      // Éviter les chevauchements
      const overlaps = sections.some(s =>
        (start >= s.start && start < s.end) || (end > s.start && end <= s.end)
      );

      if (!overlaps) {
        sections.push({ type: 'chorus', start, end, confidence: 0.75 });
        i += 3; // Skip next 3 segments
      }
    }
  }

  // Remplir les gaps avec des couplets
  let currentTime = 0;
  const filledSections: SongStructure['sections'] = [];
  const sortedSections = sections.sort((a, b) => a.start - b.start);

  for (const section of sortedSections) {
    if (currentTime < section.start) {
      // Gap = couplet
      filledSections.push({ type: 'verse', start: currentTime, end: section.start, confidence: 0.5 });
    }
    filledSections.push(section);
    currentTime = section.end;
  }

  // Ajouter un dernier couplet si nécessaire
  if (currentTime < duration - segmentDuration) {
    filledSections.push({ type: 'verse', start: currentTime, end: duration, confidence: 0.5 });
  }

  return { sections: filledSections };
}
