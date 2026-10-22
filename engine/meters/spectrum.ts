/**
 * Analyseur de spectre du master (R11) : lissage par fraction d'octave et
 * maintien des crêtes, à partir des bins dB de l'AnalyserNode (FFT).
 */

/**
 * Lissage par fraction d'octave (1/3, 1/6…), à la façon d'un analyseur en temps réel
 * (RTA) : SOMME de la puissance sur [f / 2^(frac/2), f · 2^(frac/2)] autour de chaque
 * bin (au moins ±3,5 bins : tout le lobe principal de la fenêtre de Blackman), bords
 * fractionnaires, en O(N) par sommes cumulées. Entrée et sortie en dB.
 *
 * Avec SPECTRUM_SINE_DB, un sinus se lit à son niveau de crête en dBFS, à sa fréquence,
 * quelle que soit la fraction d'octave. Avant (22/10/2026) : MOYENNE de la puissance de la
 * bande, sans calibration : un sinus à −12 dBFS s'affichait vers −31 dB à 100 Hz et plus
 * bas encore dans les aigus (plus la bande est large, plus la moyenne le diluait).
 */
export function octaveSmooth(binsDb: ArrayLike<number>, sampleRate: number, fraction = 1 / 3, out?: Float32Array): Float32Array {
  const n = binsDb.length;
  const res = out && out.length === n ? out : new Float32Array(n);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const d = binsDb[i];
    cum[i + 1] = cum[i] + (Number.isFinite(d) ? Math.pow(10, d / 10) : 0);
  }
  const half = Math.pow(2, fraction / 2);
  // Puissance cumulée jusqu'à la position x (en bins ; le bin j couvre [j − ½, j + ½]) :
  // bords de bande fractionnaires, pas d'élargissement par arrondi dans les graves.
  const F = (x: number) => {
    const xc = Math.max(-0.5, Math.min(n - 0.5, x));
    const j = Math.min(n - 1, Math.floor(xc + 0.5));
    return cum[j] + (cum[j + 1] - cum[j]) * (xc + 0.5 - j);
  };
  for (let i = 0; i < n; i++) {
    const a = Math.min(i / half, i - 3.5), b = Math.max(i * half, i + 3.5);
    const p = F(b) - F(a);
    res[i] = p > 0 ? 10 * Math.log10(p) : -140;
  }
  return res;
}

/** Maintien des crêtes du spectre : tient `holdMs`, puis retombe de `fallDbS` dB/s. */
export class SpectrumHold {
  private v: Float32Array = new Float32Array(0);
  private at: Float64Array = new Float64Array(0);
  constructor(private holdMs = 1500, private fallDbS = 12) {}
  update(cur: Float32Array, now: number, dt: number): Float32Array {
    if (this.v.length !== cur.length) { this.v = Float32Array.from(cur); this.at = new Float64Array(cur.length).fill(now); return this.v; }
    for (let i = 0; i < cur.length; i++) {
      if (cur[i] >= this.v[i]) { this.v[i] = cur[i]; this.at[i] = now; }
      else if (now - this.at[i] > this.holdMs) this.v[i] = Math.max(cur[i], this.v[i] - this.fallDbS * dt);
    }
    return this.v;
  }
  reset() { this.v = new Float32Array(0); }
}

/** Fréquence → position horizontale (0…1) sur une échelle log de 20 Hz à 20 kHz. */
export const freqToX = (f: number) => Math.max(0, Math.min(1, Math.log10(Math.max(20, f) / 20) / 3));

/**
 * Calibration de l'AnalyserNode (spec Web Audio : fenêtre de Blackman α = 0,16, |X[k]| / N) :
 * la puissance totale d'un sinus d'amplitude A, sommée sur ses bins, vaut A² · mean(w²) / 4
 * (mean(w²) = 0,42² + 0,5²/2 + 0,08²/2 = 0,3046). Ajouter ce décalage à une bande lissée
 * (octaveSmooth) donne le niveau de crête du sinus en dBFS : +11,18 dB.
 */
export const SPECTRUM_SINE_DB = -10 * Math.log10((0.42 * 0.42 + 0.5 * 0.5 / 2 + 0.08 * 0.08 / 2) / 4);
