
/**
 * Service de détection de tempo (BPM) ultra-rapide
 * Analyse les pics d'énergie dans les basses fréquences
 */
export class TempoDetector {
  /**
   * Analyse un AudioBuffer pour en extraire le BPM probable
   */
  public static async detect(buffer: AudioBuffer): Promise<number> {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    
    // On analyse une portion représentative (30s au milieu du morceau)
    const duration = Math.min(buffer.duration, 30);
    const startOffset = Math.max(0, (buffer.duration / 2) - 15);
    const startIndex = Math.floor(startOffset * sampleRate);
    const endIndex = Math.floor((startOffset + duration) * sampleRate);
    
    const partData = rawData.slice(startIndex, endIndex);
    
    // 1. Détection de pics simple (Energy threshold)
    const peaks: number[] = [];
    const threshold = 0.8; // Seuil d'énergie
    const minDistance = sampleRate * 0.25; // Minimum 240 BPM (0.25s entre pics)
    
    let lastPeak = -minDistance;
    for (let i = 0; i < partData.length; i++) {
      if (Math.abs(partData[i]) > threshold && (i - lastPeak) > minDistance) {
        peaks.push(i);
        lastPeak = i;
      }
    }

    if (peaks.length < 2) return 120; // Valeur par défaut si échec

    // 2. Calcul des intervalles
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push(peaks[i] - peaks[i - 1]);
    }

    // 3. Trouver l'intervalle le plus fréquent (Histogramme simple)
    const counts: Record<number, number> = {};
    intervals.forEach(interval => {
      // On arrondit pour grouper les intervalles similaires
      const rounded = Math.round(interval / 100) * 100;
      counts[rounded] = (counts[rounded] || 0) + 1;
    });

    let bestInterval = 0;
    let maxCount = 0;
    for (const [interval, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        bestInterval = Number(interval);
      }
    }

    // 4. Conversion en BPM
    let bpm = Math.round((60 * sampleRate) / bestInterval);
    
    // Normalisation (rester entre 60 et 180 BPM)
    while (bpm < 60) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    return Math.round(bpm);
  }
}
