/**
 * Calculs purs des boutons rotatifs (testés dans tests/hwKit.test.ts) :
 * course linéaire ou logarithmique, crans, pas, angle du pointeur.
 */
export interface KnobRange {
  min: number;
  max: number;
  /** Pas de la valeur (0 = continu). */
  step?: number;
  /** 'log' : fréquences, temps (min > 0). */
  curve?: 'lin' | 'log';
  /** Positions discrètes (sélecteur à crans) : la valeur ne prend que ces valeurs. */
  detents?: { v: number }[];
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const isLog = (r: KnobRange) => r.curve === 'log' && r.min > 0 && r.max > r.min;

/** Valeur → position 0..1 sur la course. */
export function toNorm(r: KnobRange, v: number): number {
  if (r.detents && r.detents.length > 1) return detentIndex(r, v) / (r.detents.length - 1);
  const x = Number.isFinite(v) ? v : r.min;
  if (isLog(r)) return clamp01(Math.log(Math.max(r.min, x) / r.min) / Math.log(r.max / r.min));
  return clamp01((x - r.min) / ((r.max - r.min) || 1));
}

/** Position 0..1 → valeur (arrondie au pas, ou au cran le plus proche). */
export function fromNorm(r: KnobRange, n: number): number {
  const c = clamp01(n);
  if (r.detents && r.detents.length > 1) return r.detents[Math.round(c * (r.detents.length - 1))].v;
  const raw = isLog(r) ? r.min * Math.pow(r.max / r.min, c) : r.min + c * (r.max - r.min);
  return quantize(r, raw);
}

/** Arrondi au pas (sans erreur d'arrondi flottant), borné. */
export function quantize(r: KnobRange, v: number): number {
  let x = Math.max(r.min, Math.min(r.max, v));
  const s = r.step || 0;
  if (s > 0) {
    x = r.min + Math.round((x - r.min) / s) * s;
    const dec = Math.min(6, Math.max(0, -Math.floor(Math.log10(s)) + 1));
    x = +x.toFixed(dec);
    x = Math.max(r.min, Math.min(r.max, x));
  }
  return x;
}

/** Index du cran le plus proche d'une valeur. */
export function detentIndex(r: KnobRange, v: number): number {
  const d = r.detents || [];
  let best = 0;
  for (let i = 1; i < d.length; i++) if (Math.abs(d[i].v - v) < Math.abs(d[best].v - v)) best = i;
  return best;
}

/** Valeur après un cran de clavier ou de molette (dir = ±1 ; fine = Maj ; big = Page). */
export function nudge(r: KnobRange, v: number, dir: 1 | -1, opts: { fine?: boolean; big?: boolean } = {}): number {
  if (r.detents && r.detents.length > 1) {
    const i = Math.max(0, Math.min(r.detents.length - 1, detentIndex(r, v) + dir * (opts.big ? 2 : 1)));
    return r.detents[i].v;
  }
  const frac = opts.big ? 0.1 : opts.fine ? 0.001 : 0.01;
  let next = fromNorm(r, toNorm(r, v) + dir * frac);
  // Un pas au moins : un cran de clavier doit toujours faire bouger la valeur.
  if (next === quantize(r, v) && r.step) next = quantize(r, v + dir * r.step);
  return next;
}

/** Angle du pointeur (degrés, 0 = midi) pour une position 0..1. */
export const angleOf = (n: number, sweep = 270) => -sweep / 2 + clamp01(n) * sweep;
