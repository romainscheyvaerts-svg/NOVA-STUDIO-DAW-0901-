/**
 * Analyseur de spectre du master (R11) : lissage par fraction d'octave et
 * maintien des crêtes, à partir des bins dB de l'AnalyserNode (FFT).
 */

/**
 * Lissage par fraction d'octave (1/3, 1/6…) : moyenne de PUISSANCE sur
 * [f / 2^(frac/2), f · 2^(frac/2)] autour de chaque bin, en O(N) par sommes
 * cumulées. Entrée et sortie en dB.
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
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, Math.floor(i / half));
    const hi = Math.min(n - 1, Math.ceil(i * half));
    const p = (cum[hi + 1] - cum[lo]) / (hi - lo + 1);
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
