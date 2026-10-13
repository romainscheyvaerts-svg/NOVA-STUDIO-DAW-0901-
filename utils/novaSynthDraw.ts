/**
 * Dessins des écrans du synthé NOVA (formes d'onde, courbe du filtre, enveloppes,
 * LFO) : calculs purs qui renvoient des chemins SVG, testés en vitest
 * (tests/novaSynthDraw.test.ts). Aucun lien avec le moteur : l'écran montre les
 * réglages, il ne lit pas le son.
 */
import type { FilterType, NovaSynthSettings, OscWave, SynthEnv } from './novaSynth';

/** Valeur d'une forme d'onde à la phase ph (0 … 1), entre -1 et 1. */
export function waveSample(w: OscWave, ph: number): number {
  const p = ph - Math.floor(ph);
  switch (w) {
    case 'sine': return Math.sin(2 * Math.PI * p);
    case 'triangle': return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 'sawtooth': return p < 0.5 ? 2 * p : 2 * p - 2;
    case 'square': return p < 0.5 ? 1 : -1;
  }
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** Chemin SVG d'une forme d'onde : `cycles` périodes dans w × h (amplitude `amp` ≤ 1), décalée de `phase`. */
export function wavePath(wave: OscWave, w: number, h: number, cycles = 2, amp = 0.8, phase = 0): string {
  const n = Math.max(32, Math.round(w * 1.5));
  const mid = h / 2, a = (h / 2) * amp;
  let d = '';
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * w;
    const y = mid - waveSample(wave, phase + (i / n) * cycles) * a;
    d += `${i ? 'L' : 'M'}${f1(x)} ${f1(y)}`;
  }
  return d;
}

/**
 * Gain (dB) d'un filtre biquad du Web Audio à la fréquence f. Comme dans la
 * spécification : pour le passe-bas et le passe-haut, Q est en dB (pic de
 * résonance) ; pour le passe-bande, Q est le facteur de qualité (pic à 0 dB).
 */
export function biquadMagDb(type: FilterType, f0: number, q: number, f: number, sr = 48000): number {
  const w0 = 2 * Math.PI * Math.min(f0, sr / 2 - 1) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  let b0: number, b1: number, b2: number, alpha: number;
  if (type === 'bandpass') {
    alpha = sw / (2 * Math.max(1e-4, q));
    b0 = alpha; b1 = 0; b2 = -alpha;
  } else {
    alpha = sw / (2 * Math.pow(10, q / 20));
    if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const w = 2 * Math.PI * f / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
  return 20 * Math.log10(Math.max(1e-12, mag));
}

/** Réponse du filtre du synthé (1 ou 2 biquads en série, comme le moteur), en dB. */
export function synthFilterDb(f: NovaSynthSettings['filter'], cutoff: number, freq: number): number {
  let db = biquadMagDb(f.type, cutoff, f.reso, freq);
  if (f.steep) db += biquadMagDb(f.type, cutoff, f.type === 'bandpass' ? 0.7 : 0.707, freq);
  return db;
}

export const FREQ_MIN = 20, FREQ_MAX = 20000;
/** Fréquence → x (échelle logarithmique 20 Hz … 20 kHz). */
export const freqToX = (f: number, w: number) => (Math.log(Math.max(FREQ_MIN, f) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN)) * w;

/** Chemin SVG de la courbe du filtre (dB entre dbMin et dbMax). `cutoff` permet de tracer l'ouverture par l'enveloppe. */
export function filterPath(f: NovaSynthSettings['filter'], w: number, h: number, cutoff = f.cutoff, dbMin = -42, dbMax = 24): string {
  const n = Math.max(48, Math.round(w));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * w;
    const freq = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, i / n);
    const db = Math.min(dbMax, Math.max(dbMin, synthFilterDb(f, Math.min(20000, Math.max(20, cutoff)), freq)));
    const y = ((dbMax - db) / (dbMax - dbMin)) * h;
    d += `${i ? 'L' : 'M'}${f1(x)} ${f1(y)}`;
  }
  return d;
}

/**
 * Enveloppe ADSR dessinée : attaque linéaire, déclin et relâchement exponentiels
 * (τ = durée / 4, comme le moteur). Les segments ont une largeur proportionnelle à
 * la racine de leur durée : une attaque de 3 ms et un relâchement de 3 s restent lisibles.
 */
export function envPoints(env: SynthEnv, w: number, h: number, pad = 2): { d: string; marks: [number, number][] } {
  const seg = (t: number) => Math.sqrt(Math.max(0.003, t));
  const hold = 0.35;
  const wa = seg(env.a), wd = seg(env.d) , wr = seg(env.r);
  const total = wa + wd + hold + wr;
  const k = (w - 2 * pad) / total;
  const top = pad, bot = h - pad, amp = bot - top;
  const yOf = (v: number) => bot - v * amp;
  const xA = pad + wa * k, xD = xA + wd * k, xS = xD + hold * k, xR = xS + wr * k;
  let d = `M${f1(pad)} ${f1(bot)}L${f1(xA)} ${f1(top)}`;
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    d += `L${f1(xA + (xD - xA) * u)} ${f1(yOf(env.s + (1 - env.s) * Math.exp(-4 * u)))}`;
  }
  const sEnd = env.s + (1 - env.s) * Math.exp(-4);
  d += `L${f1(xS)} ${f1(yOf(sEnd))}`;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    d += `L${f1(xS + (xR - xS) * u)} ${f1(yOf(sEnd * Math.exp(-4 * u)))}`;
  }
  return { d, marks: [[xA, top], [xD, yOf(sEnd)], [xS, yOf(sEnd)], [xR, bot]] };
}

/** LFO dessiné sur `seconds` secondes : forme, vitesse (Hz) et intensité (0 … 1). */
export function lfoPath(wave: OscWave, rate: number, amount: number, w: number, h: number, seconds = 2): string {
  const cycles = Math.max(0.05, rate) * seconds;
  const amp = 0.08 + 0.84 * Math.max(0, Math.min(1, amount));
  // Au-delà de ~24 cycles visibles, on plafonne le dessin (sinon un aplat illisible).
  return wavePath(wave, w, h, Math.min(cycles, 24), amp);
}
