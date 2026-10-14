/**
 * Accordeur NOVA (lot 11b) : logique pure, sans DOM (tests/tuner.test.ts).
 *
 * - `readNote` : note la plus proche, octave et écart en cents d'une hauteur,
 *   selon le mode (chromatique, guitare, basse, tonalité du morceau) ;
 * - `TunerSmoother` : lissage de l'affichage (médiane des dernières trames,
 *   tenue brève quand le son s'arrête, pas de saut d'octave isolé) ;
 * - `holdStats` : justesse d'une note tenue (voix), en cents.
 *
 * Noms des notes : convention française de NOVA (Do3 = Do central = MIDI 60,
 * La3 = 440 Hz), avec le nom anglo-saxon en complément (A4) pour les
 * guitaristes et les bassistes qui suivent des tablatures.
 */
import { NOTE_NAMES_FR, scalePitchClasses } from './scales';

export type TunerMode = 'chromatique' | 'guitare' | 'basse' | 'tonalite';

const NOTE_NAMES_EN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const mod12 = (n: number) => ((Math.round(n) % 12) + 12) % 12;

/** Cordes à vide (MIDI), de la plus grave à la plus aiguë. */
export const GUITAR_STRINGS = [40, 45, 50, 55, 59, 64];   // Mi1 La1 Ré2 Sol2 Si2 Mi3 (E2 A2 D3 G3 B3 E4)
export const BASS_STRINGS = [28, 33, 38, 43];             // Mi0 La0 Ré1 Sol1 (E1 A1 D2 G2)

/** Plages de détection (Hz) par mode : la basse descend sous 41 Hz, la voix et la guitare non. */
export const MODE_RANGE: Record<TunerMode, { fmin: number; fmax: number }> = {
  chromatique: { fmin: 30, fmax: 1600 },
  guitare: { fmin: 70, fmax: 1000 },
  basse: { fmin: 28, fmax: 420 },
  tonalite: { fmin: 55, fmax: 1300 },
};

export const midiOf = (hz: number, a4 = 440) => 69 + 12 * Math.log2(hz / a4);
export const hzOf = (midi: number, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12);

/** « La3 » (convention française de NOVA). */
export const nameFr = (midi: number) => `${NOTE_NAMES_FR[mod12(midi)]}${Math.floor(Math.round(midi) / 12) - 2}`;
/** « A4 » (notation anglo-saxonne). */
export const nameEn = (midi: number) => `${NOTE_NAMES_EN[mod12(midi)]}${Math.floor(Math.round(midi) / 12) - 1}`;

export interface TunerReading {
  hz: number;
  /** Note visée (MIDI entier). */
  target: number;
  /** Écart (cents, signé : + = trop haut). */
  cents: number;
  /** « La » (sans octave). */
  note: string;
  /** Octave française (La3 → 3). */
  octave: number;
  /** « A4 ». */
  en: string;
  /** Corde visée (guitare, basse) : 1 = la plus aiguë, comme sur une tablature. */
  string?: number;
}

export interface KeyInfo { root: number; scale?: string }

/** Note visée par le mode, pour une hauteur MIDI fractionnaire. */
export function targetFor(m: number, mode: TunerMode, key?: KeyInfo | null): { target: number; string?: number } {
  if (mode === 'guitare' || mode === 'basse') {
    const strings = mode === 'guitare' ? GUITAR_STRINGS : BASS_STRINGS;
    // Loin de toute corde à vide (> 2,5 demi-tons) : note chromatique (une corde très désaccordée reste lisible).
    let best = strings[0];
    for (const s of strings) if (Math.abs(s - m) < Math.abs(best - m)) best = s;
    if (Math.abs(best - m) <= 2.5) return { target: best, string: strings.length - strings.indexOf(best) };
    return { target: Math.round(m) };
  }
  if (mode === 'tonalite' && key && Number.isFinite(key.root)) {
    const pcs = scalePitchClasses(key.root, key.scale);
    let best = Math.round(m), dist = Infinity;
    for (let c = Math.floor(m) - 6; c <= Math.ceil(m) + 6; c++) {
      if (!pcs.has(mod12(c))) continue;
      const dd = Math.abs(c - m);
      if (dd < dist) { dist = dd; best = c; }
    }
    return { target: best };
  }
  return { target: Math.round(m) };
}

/** Lecture complète d'une hauteur. */
export function readNote(hz: number, mode: TunerMode = 'chromatique', key?: KeyInfo | null, a4 = 440): TunerReading {
  const m = midiOf(hz, a4);
  const { target, string } = targetFor(m, mode, key);
  return {
    hz, target, cents: (m - target) * 100,
    note: NOTE_NAMES_FR[mod12(target)], octave: Math.floor(target / 12) - 2, en: nameEn(target),
    ...(string ? { string } : {}),
  };
}

/** Juste (vert), presque (orange), faux (rouge). Seuils : 5 cents ≈ seuil d'écoute, 15 cents = net. */
export function tuneState(cents: number): 'juste' | 'presque' | 'faux' {
  const a = Math.abs(cents);
  return a <= 5 ? 'juste' : a <= 15 ? 'presque' : 'faux';
}

/**
 * Lissage : médiane des N dernières hauteurs (en MIDI), saut d'octave isolé
 * ignoré, dernière lecture gardée `holdMs` après la fin du son.
 */
export class TunerSmoother {
  private buf: { m: number; t: number }[] = [];
  private lastAt = -Infinity;
  private last: number | null = null;
  constructor(private size = 5, private holdMs = 600, private windowMs = 250) {}

  /** `hz` = null quand la trame n'a pas de hauteur. Renvoie la hauteur lissée (Hz) ou null. */
  push(hz: number | null, nowMs: number): number | null {
    this.buf = this.buf.filter(b => nowMs - b.t <= this.windowMs);
    if (hz && hz > 0) {
      let m = midiOf(hz);
      // Saut d'octave isolé (harmonique ou sous-harmonique) : ramené près de la médiane.
      if (this.last !== null && this.buf.length >= 2) {
        const d = m - this.last;
        if (Math.abs(Math.abs(d) - 12) < 0.7) m -= 12 * Math.sign(d);
      }
      this.buf.push({ m, t: nowMs });
      if (this.buf.length > this.size) this.buf.shift();
    }
    if (this.buf.length) {
      const s = this.buf.map(b => b.m).sort((a, b) => a - b);
      this.last = s[s.length >> 1];
      this.lastAt = nowMs;
      return hzOf(this.last);
    }
    if (this.last !== null && nowMs - this.lastAt <= this.holdMs) return hzOf(this.last);
    this.last = null;
    return null;
  }

  reset() { this.buf = []; this.last = null; this.lastAt = -Infinity; }
}

export interface HoldStats {
  /** Trames avec une hauteur. */
  frames: number;
  /** Écart moyen (signé) à la cible, en cents. */
  meanCents: number;
  /** Écart absolu médian (cents). */
  medianAbsCents: number;
  /** Stabilité : écart-type (cents). */
  spreadCents: number;
  /** Part des trames à ±25 cents de la cible (0-1). */
  inTune: number;
  /** Note 0-100. */
  score: number;
}

/**
 * Justesse d'une note tenue. `target` (MIDI) absent : la note la plus proche
 * de la médiane chantée (tenir « n'importe quelle » note juste).
 */
export function holdStats(midis: number[], target?: number): HoldStats {
  const v = midis.filter(Number.isFinite);
  if (v.length < 3) return { frames: v.length, meanCents: 0, medianAbsCents: 0, spreadCents: 0, inTune: 0, score: 0 };
  const sorted = [...v].sort((a, b) => a - b);
  const tgt = target ?? Math.round(sorted[sorted.length >> 1]);
  const c = v.map(m => (m - tgt) * 100);
  const mean = c.reduce((a, b) => a + b, 0) / c.length;
  const abs = c.map(Math.abs).sort((a, b) => a - b);
  const med = abs[abs.length >> 1];
  const spread = Math.sqrt(c.reduce((a, b) => a + (b - mean) * (b - mean), 0) / c.length);
  const inTune = c.filter(x => Math.abs(x) <= 25).length / c.length;
  // 100 à 0 cent, 70 à 15 cents, 40 à 30 cents d'écart médian ; la stabilité compte pour un quart.
  const acc = Math.max(0, 100 - med * 2);
  const stab = Math.max(0, 100 - spread * 2);
  const score = Math.round(Math.max(0, Math.min(100, 0.75 * acc + 0.25 * stab)));
  return { frames: v.length, meanCents: Math.round(mean * 10) / 10, medianAbsCents: Math.round(med * 10) / 10, spreadCents: Math.round(spread * 10) / 10, inTune: Math.round(inTune * 1000) / 1000, score };
}
