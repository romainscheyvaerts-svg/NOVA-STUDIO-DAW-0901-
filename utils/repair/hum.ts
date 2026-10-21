/**
 * Écart 7 · Bourdonnement secteur (ronflette) : 50 Hz en Europe et en Afrique,
 * 60 Hz en Amérique du Nord (fréquence du réseau électrique), avec ses
 * harmoniques (100, 150, 200 Hz… ; un « buzz » en a beaucoup).
 *
 * 1. Détection : spectre moyen très fin (Welch, ~0,2 Hz par case) ; pour 50 et
 *    60 Hz, on mesure de combien chaque harmonique dépasse le fond voisin.
 *    La fréquence exacte (49,9 Hz, 60,1 Hz…) est affinée sur les pics.
 * 2. Retrait : une cascade de filtres coupe-bande très étroits (1,5 Hz + 0,2 Hz
 *    par rang d'harmonique), appliquée aller-retour (phase nulle, aucun décalage).
 *    Le son est prolongé de façon périodique avant et après le clip : les
 *    filtres sont déjà « en régime » au premier échantillon (pas de résidu au début).
 */
import { fftInPlace } from '../../engine/phaseVocoder';
import { filtfilt, notch, type Biquad } from './dsp';

export type HumMode = 'off' | 'auto' | '50' | '60';

export interface HumStats {
  /** Fondamentale retirée (Hz), null si rien trouvé. */
  f0: number | null;
  /** Harmoniques retirées (fondamentale comprise). */
  harmonics: number;
  /** Dépassement moyen du fond des harmoniques trouvées (dB). */
  prominenceDb: number;
}

const FFT_N = 1 << 18;
/** Une harmonique compte si elle dépasse le fond voisin de 6 dB. */
const PROMINENCE_DB = 6;
/** … et une raie étroite : 12 dB de plus qu'à ±1 Hz (une voix qui glisse ne l'est jamais). */
const NARROW_DB = 12;
/** Harmoniques retirées au plus (jusqu'à ~1,2 kHz). */
const MAX_HARM = 24;
const MAX_FREQ = 1250;

/** Spectre de puissance moyen (Welch, fenêtre de Hann) d'un signal mono, au plus 6 tranches. */
function welch(x: Float32Array, sampleRate: number): { psd: Float64Array; df: number } {
  let n = FFT_N;
  while (n > 4096 && n > x.length) n >>= 1;
  // Résolution d'au moins ~0,4 Hz si possible (sinon le clip est trop court).
  const psd = new Float64Array(n / 2);
  const re = new Float64Array(n), im = new Float64Array(n);
  const hop = n / 2;
  const count = Math.max(1, Math.min(6, Math.floor((x.length - n) / hop) + 1));
  const span = x.length > n ? (x.length - n) / Math.max(1, count - 1 || 1) : 0;
  for (let s = 0; s < count; s++) {
    const off = Math.floor(count > 1 ? s * span : 0);
    for (let i = 0; i < n; i++) {
      const v = off + i < x.length ? x[off + i] : 0;
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < n / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  return { psd, df: sampleRate / n };
}

function peakNear(psd: Float64Array, df: number, f: number, tol: number): { f: number; p: number; floor: number; side: number } {
  const lo = Math.max(1, Math.floor((f - tol) / df)), hi = Math.min(psd.length - 2, Math.ceil((f + tol) / df));
  let best = lo;
  for (let k = lo; k <= hi; k++) if (psd[k] > psd[best]) best = k;
  // Position fine (interpolation parabolique en dB).
  const a = Math.log(psd[best - 1] + 1e-30), b = Math.log(psd[best] + 1e-30), c = Math.log(psd[best + 1] + 1e-30);
  const den = a - 2 * b + c;
  const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  // Fond : médiane de ±8 Hz autour, sans le pic.
  const w = Math.max(4, Math.round(8 / df)), guard = Math.max(2, Math.round(1.5 / df));
  const ring: number[] = [];
  for (let k = Math.max(1, best - w); k <= Math.min(psd.length - 1, best + w); k++) if (Math.abs(k - best) > guard) ring.push(psd[k]);
  ring.sort((p, q) => p - q);
  // Finesse : une raie du secteur est très étroite (stable) ; une harmonique de voix
  // qui glisse est large. Niveau à ±1 Hz du pic (moyenne des deux côtés).
  const off = Math.max(3, Math.round(1 / df));
  const side = 0.5 * ((psd[Math.max(1, best - off)] || 0) + (psd[Math.min(psd.length - 1, best + off)] || 0));
  return { f: (best + d) * df, p: psd[best], floor: ring.length ? ring[ring.length >> 1] : 1e-30, side };
}

/** Cherche un bourdonnement à `base` Hz (50 ou 60) : harmoniques présentes et fondamentale exacte. */
function score(psd: Float64Array, df: number, base: number): { f0: number; harmonics: number[]; promDb: number } {
  const found: number[] = [];
  let sumProm = 0, num = 0, den = 0;
  for (let h = 1; h <= MAX_HARM && h * base <= MAX_FREQ; h++) {
    const pk = peakNear(psd, df, h * base, Math.max(0.8, h * base * 0.006));
    const prom = 10 * Math.log10(pk.p / Math.max(1e-30, pk.floor));
    const narrow = 10 * Math.log10(pk.p / Math.max(1e-30, pk.side));
    if (prom >= PROMINENCE_DB && narrow >= NARROW_DB) { found.push(h); sumProm += prom; num += pk.f * h * prom; den += h * h * prom; }
  }
  return { f0: den > 0 ? num / den : base, harmonics: found, promDb: found.length ? sumProm / found.length : 0 };
}

/**
 * Fondamentale exacte : maximise la puissance cumulée des harmoniques trouvées
 * (transformée de Fourier aux fréquences h·f, fenêtre de Hann, jusqu'à 8 s de son),
 * par section dorée dans ±0,25 Hz autour de la première estimation. Il faut
 * une précision de quelques millièmes de hertz : à la 8e harmonique, 0,05 Hz
 * d'erreur ferait déjà perdre la moitié de l'effet des coupe-bandes.
 */
function refineF0(x: Float32Array, sampleRate: number, f0: number, harmonics: number[]): number {
  const n = Math.min(x.length, Math.round(8 * sampleRate));
  const start = Math.max(0, (x.length - n) >> 1);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const power = (f: number) => {
    let sum = 0;
    for (const h of harmonics) {
      const om = (2 * Math.PI * h * f) / sampleRate;
      // Récurrence de Goertzel.
      const coeff = 2 * Math.cos(om);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) { const s0 = w[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
      sum += s1 * s1 + s2 * s2 - coeff * s1 * s2;
    }
    return sum;
  };
  let a = f0 - 0.25, b = f0 + 0.25;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = power(c), fd = power(d);
  for (let it = 0; it < 22; it++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = power(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = power(d); }
  }
  return (a + b) / 2;
}

/** Détecte le bourdonnement (mono) ; `mode` impose 50 ou 60 Hz. */
export function detectHum(chs: Float32Array[], sampleRate: number, mode: HumMode = 'auto'): { f0: number; harmonics: number[]; promDb: number } | null {
  if (mode === 'off' || !chs.length || chs[0].length < sampleRate * 0.25) return null;
  const n = chs[0].length;
  const mono = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] / chs.length;
  const { psd, df } = welch(mono, sampleRate);
  const cands = mode === '50' ? [50] : mode === '60' ? [60] : [50, 60];
  let best: ReturnType<typeof score> | null = null;
  for (const b of cands) {
    const s = score(psd, df, b);
    // Il faut la fondamentale OU au moins 2 harmoniques (un micro coupe souvent le 50 Hz).
    if (!s.harmonics.length || (!s.harmonics.includes(1) && s.harmonics.length < 2)) continue;
    if (!best || s.harmonics.length * s.promDb > best.harmonics.length * best.promDb) best = s;
  }
  if (!best) return null;
  return { ...best, f0: refineF0(mono, sampleRate, best.f0, best.harmonics.slice(0, 8)) };
}

/** Filtres coupe-bande pour la fondamentale `f0` et les rangs `harmonics`. */
export function humFilters(f0: number, harmonics: number[], sampleRate: number): Biquad[] {
  return harmonics.filter(h => h * f0 < sampleRate / 2 - 50).map(h => notch(h * f0, 1.5 + 0.2 * h, sampleRate));
}

/** Coupe-bandes appliqués aux canaux (aller-retour, prolongement périodique). */
export function notchHum(chs: Float32Array[], sampleRate: number, f0: number, ranks: number[]): Float32Array[] {
  const filters = humFilters(f0, ranks, sampleRate);
  const period = sampleRate / f0;
  const pad = Math.round(Math.max(1, Math.round((0.6 * sampleRate) / period)) * period);
  return chs.map(c => Float32Array.from(filtfilt(c, filters, Math.min(pad, Math.max(0, c.length - 1)), period)));
}

/** Retire le bourdonnement ; sans bourdonnement trouvé, les canaux reviennent tels quels. */
export function removeHum(chs: Float32Array[], sampleRate: number, mode: HumMode): { channels: Float32Array[]; stats: HumStats; ranks: number[] } {
  const det = detectHum(chs, sampleRate, mode);
  if (!det) return { channels: chs, stats: { f0: null, harmonics: 0, prominenceDb: 0 }, ranks: [] };
  // Toutes les harmoniques jusqu'à la plus haute trouvée : celles du milieu existent aussi,
  // simplement masquées par la voix au moment de la mesure.
  const top = Math.max(...det.harmonics);
  const ranks = Array.from({ length: top }, (_, i) => i + 1).filter(h => h * det.f0 < sampleRate / 2 - 50);
  return { channels: notchHum(chs, sampleRate, det.f0, ranks), stats: { f0: Math.round(det.f0 * 100) / 100, harmonics: ranks.length, prominenceDb: Math.round(det.promDb * 10) / 10 }, ranks };
}
