
/**
 * Service d'analyse spectrale et temporelle pour le nettoyage des pistes.
 */
export class SilenceDetector {
  /**
   * Identifie les régions de silence dans un AudioBuffer.
   * @param buffer Le buffer à analyser
   * @param thresholdDB Seuil en décibels (ex: -45)
   * @param minSilenceDuration Durée minimale du silence en secondes
   */
  public static detectSilences(
    buffer: AudioBuffer, 
    thresholdDB: number = -45, 
    minSilenceDuration: number = 0.5
  ): { start: number; end: number }[] {
    const data = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    
    // Paramètres de fenêtrage (100ms pour l'analyse RMS)
    const windowSize = Math.floor(sampleRate * 0.1); 
    const thresholdLinear = Math.pow(10, thresholdDB / 20);
    
    const silences: { start: number; end: number }[] = [];
    let silenceStart: number | null = null;

    for (let i = 0; i < data.length; i += windowSize) {
      // Calcul du RMS sur la fenêtre
      let sum = 0;
      const end = Math.min(i + windowSize, data.length);
      for (let j = i; j < end; j++) {
        sum += data[j] * data[j];
      }
      const rms = Math.sqrt(sum / windowSize);

      const isSilent = rms < thresholdLinear;
      const currentTime = i / sampleRate;

      if (isSilent && silenceStart === null) {
        silenceStart = currentTime;
      } else if (!isSilent && silenceStart !== null) {
        const duration = currentTime - silenceStart;
        if (duration >= minSilenceDuration) {
          silences.push({ start: silenceStart, end: currentTime });
        }
        silenceStart = null;
      }
    }

    // Gestion du silence à la fin du fichier
    if (silenceStart !== null) {
      const duration = (data.length / sampleRate) - silenceStart;
      if (duration >= minSilenceDuration) {
        silences.push({ start: silenceStart, end: data.length / sampleRate });
      }
    }

    return silences;
  }
}
