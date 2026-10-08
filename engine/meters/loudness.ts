/**
 * Loudness en direct (R11) : ITU-R BS.1770-4 / EBU R128 (Tech 3341, 3342).
 *
 * Entrée : l'énergie pondérée K de chaque sous-bloc de 100 ms (somme sur les
 * canaux des moyennes des carrés, poids 1,0 pour G et D), calculée dans
 * l'AudioWorklet (engine/meters/meterCore.ts).
 *
 *  - momentané  : fenêtre de 400 ms (4 sous-blocs), glissante toutes les 100 ms ;
 *  - court terme : fenêtre de 3 s (30 sous-blocs) ;
 *  - intégré    : blocs de 400 ms recouverts à 75 % (pas de 100 ms), portillon
 *                 absolu −70 LUFS puis relatif −10 LU ;
 *  - LRA (Tech 3342) : valeurs court terme (pas de 100 ms), portillon absolu
 *                 −70 LUFS puis relatif −20 LU, écart entre le 10e et le
 *                 95e centile.
 *
 * L = −0,691 + 10·log10(énergie).
 */

export const LUFS_FLOOR = -70;
const ABS_GATE_E = Math.pow(10, (LUFS_FLOOR + 0.691) / 10);

export const energyToLufs = (e: number): number => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
export const lufsToEnergy = (l: number): number => Math.pow(10, (l + 0.691) / 10);

/** Moyenne des énergies au-dessus des deux portillons (BS.1770-4) ; -Infinity si rien ne passe. */
export function gatedLoudness(blocks: ArrayLike<number>, count: number, relativeLu = -10): number {
  let s = 0, c = 0;
  for (let i = 0; i < count; i++) { const e = blocks[i]; if (e > ABS_GATE_E) { s += e; c++; } }
  if (!c) return -Infinity;
  const relE = (s / c) * Math.pow(10, relativeLu / 10);
  let s2 = 0, c2 = 0;
  for (let i = 0; i < count; i++) { const e = blocks[i]; if (e > ABS_GATE_E && e > relE) { s2 += e; c2++; } }
  return c2 ? energyToLufs(s2 / c2) : -Infinity;
}

/** LRA (EBU Tech 3342) à partir d'énergies court terme. */
export function loudnessRange(st: ArrayLike<number>, count: number): number {
  const passed: number[] = [];
  let s = 0;
  for (let i = 0; i < count; i++) { const e = st[i]; if (e > ABS_GATE_E) { passed.push(e); s += e; } }
  if (passed.length < 2) return 0;
  const relE = (s / passed.length) * Math.pow(10, -20 / 10);
  const kept = passed.filter(e => e > relE).map(energyToLufs).sort((a, b) => a - b);
  if (kept.length < 2) return 0;
  const pct = (p: number) => {
    // Centile « nearest rank » arrondi comme libebur128 / ffmpeg.
    const idx = Math.min(kept.length - 1, Math.max(0, Math.round((kept.length - 1) * p)));
    return kept[idx];
  };
  return pct(0.95) - pct(0.10);
}

/** Tableau de flottants qui grandit (sessions longues : 10 valeurs / s). */
class Growable {
  data = new Float64Array(1024);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) { const d = new Float64Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data[this.length++] = v;
  }
  clear() { this.length = 0; }
}

export interface LoudnessSnapshot {
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  /** Plus haut momentané / court terme depuis la remise à zéro. */
  momentaryMax: number;
  shortTermMax: number;
  /** Durée mesurée (s). */
  seconds: number;
}

export class LoudnessMeter {
  /** Derniers sous-blocs de 100 ms (anneau de 30 = 3 s). */
  private ring = new Float64Array(30);
  private ringPos = 0;
  private filled = 0;
  private blocks = new Growable();   // énergies des blocs de 400 ms (intégré)
  private shorts = new Growable();   // énergies des fenêtres de 3 s (LRA)
  private mMax = -Infinity;
  private sMax = -Infinity;
  private subCount = 0;
  private cache: { at: number; integrated: number; lra: number } = { at: -1, integrated: -Infinity, lra: 0 };

  /** Ajoute l'énergie d'un sous-bloc de 100 ms. */
  push(e: number) {
    this.ring[this.ringPos] = e;
    this.ringPos = (this.ringPos + 1) % 30;
    if (this.filled < 30) this.filled++;
    this.subCount++;
    if (this.filled >= 4) {
      const m = this.window(4);
      this.blocks.push(m);
      const l = energyToLufs(m);
      if (l > this.mMax) this.mMax = l;
    }
    if (this.filled >= 30) {
      const s = this.window(30);
      this.shorts.push(s);
      const l = energyToLufs(s);
      if (l > this.sMax) this.sMax = l;
    }
  }

  pushMany(es: ArrayLike<number>) { for (let i = 0; i < es.length; i++) this.push(es[i]); }

  /** Moyenne des n derniers sous-blocs. */
  private window(n: number): number {
    let s = 0;
    for (let i = 1; i <= n; i++) s += this.ring[(this.ringPos - i + 30) % 30];
    return s / n;
  }

  momentary(): number { return this.filled >= 4 ? energyToLufs(this.window(4)) : (this.filled ? energyToLufs(this.window(this.filled) * this.filled / 4) : -Infinity); }
  shortTerm(): number { return this.filled >= 30 ? energyToLufs(this.window(30)) : (this.filled ? energyToLufs(this.window(this.filled) * this.filled / 30) : -Infinity); }

  integrated(): number {
    if (this.cache.at !== this.subCount) this.recompute();
    return this.cache.integrated;
  }

  lra(): number {
    if (this.cache.at !== this.subCount) this.recompute();
    return this.cache.lra;
  }

  private recompute() {
    this.cache = {
      at: this.subCount,
      integrated: gatedLoudness(this.blocks.data, this.blocks.length, -10),
      lra: loudnessRange(this.shorts.data, this.shorts.length),
    };
  }

  snapshot(): LoudnessSnapshot {
    return {
      momentary: this.momentary(), shortTerm: this.shortTerm(), integrated: this.integrated(), lra: this.lra(),
      momentaryMax: this.mMax, shortTermMax: this.sMax, seconds: this.subCount / 10,
    };
  }

  reset() {
    this.ring.fill(0); this.ringPos = 0; this.filled = 0;
    this.blocks.clear(); this.shorts.clear();
    this.mMax = -Infinity; this.sMax = -Infinity; this.subCount = 0;
    this.cache = { at: -1, integrated: -Infinity, lra: 0 };
  }
}

/** Corrélation de phase à partir des sommes (+1 mono, 0 décorrélé, −1 phase inversée). */
export function correlationOf(lr: number, ll: number, rr: number): number {
  const d = Math.sqrt(ll * rr);
  if (!(d > 1e-12)) return 0;
  return Math.max(-1, Math.min(1, lr / d));
}
