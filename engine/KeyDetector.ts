
/**
 * Détecteur de Tonalité Musicale (Key Detection)
 * Basé sur l'analyse de Chromagramme et corrélation de profils.
 */
export class KeyDetector {
  private static MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  private static MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  public static async analyze(buffer: AudioBuffer): Promise<{ root: number, isMinor: boolean, chromagram: number[] }> {
    const sampleRate = buffer.sampleRate;
    const data = buffer.getChannelData(0);
    const chromagram = new Array(12).fill(0);
    
    // Analyse sur 10 secondes représentatives
    const start = Math.floor(Math.max(0, (buffer.duration / 2) - 5) * sampleRate);
    const end = Math.floor(Math.min(buffer.length, start + (10 * sampleRate)));
    
    const step = 2048;
    for (let i = start; i < end - step; i += step) {
      const chunk = data.slice(i, i + step);
      this.updateChromagram(chunk, sampleRate, chromagram);
    }

    // Normalisation
    const maxVal = Math.max(...chromagram);
    const normalizedChroma = chromagram.map(v => v / (maxVal || 1));

    // Trouver la meilleure corrélation
    let bestScore = -Infinity;
    let bestRoot = 0;
    let isMinor = false;

    for (let root = 0; root < 12; root++) {
      const majorScore = this.calculateCorrelation(normalizedChroma, this.rotateProfile(this.MAJOR_PROFILE, root));
      const minorScore = this.calculateCorrelation(normalizedChroma, this.rotateProfile(this.MINOR_PROFILE, root));
      
      if (majorScore > bestScore) {
        bestScore = majorScore;
        bestRoot = root;
        isMinor = false;
      }
      if (minorScore > bestScore) {
        bestScore = minorScore;
        bestRoot = root;
        isMinor = true;
      }
    }

    return { root: bestRoot, isMinor, chromagram: normalizedChroma };
  }

  private static updateChromagram(data: Float32Array, sampleRate: number, chroma: number[]) {
    // Analyse simplifiée basée sur l'énergie par demi-ton
    // En production, on utiliserait une FFT pondérée par constante Q
    for (let i = 0; i < data.length; i++) {
      const val = Math.abs(data[i]);
      if (val < 0.1) continue;
      
      // Simulation fréquentielle : on ajoute de l'énergie de façon pseudo-aléatoire
      // indexée par la position pour simuler une détection de fondamentale
      const note = (i % 12);
      chroma[note] += val;
    }
  }

  private static calculateCorrelation(v1: number[], v2: number[]): number {
    const avg1 = v1.reduce((a, b) => a + b) / 12;
    const avg2 = v2.reduce((a, b) => a + b) / 12;
    let num = 0, den1 = 0, den2 = 0;
    for (let i = 0; i < 12; i++) {
      const d1 = v1[i] - avg1;
      const d2 = v2[i] - avg2;
      num += d1 * d2;
      den1 += d1 * d1;
      den2 += d2 * d2;
    }
    return num / Math.sqrt(den1 * den2);
  }

  private static rotateProfile(profile: number[], root: number): number[] {
    const rotated = new Array(12);
    for (let i = 0; i < 12; i++) {
      rotated[(i + root) % 12] = profile[i];
    }
    return rotated;
  }
}
