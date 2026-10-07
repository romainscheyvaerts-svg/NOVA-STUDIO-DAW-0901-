/**
 * Synthé NOVA (V24) : réglages, calculs purs et répartition des voix.
 *
 * Tout ce qui ne touche pas au Web Audio vit ici, pour être testé en vitest :
 * normalisation des réglages (projets anciens, collaboration), unisson,
 * vélocité, coupure du filtre, niveau entre préréglages et choix des voix
 * (polyphonie, mono / legato, glissé) en fonction du TEMPS des notes, pour
 * que la lecture et l'export donnent exactement le même résultat.
 *
 * Une piste MIDI SANS `novaSynth` garde l'ancien synthé simple (engine/Synthesizer.ts) :
 * les anciens projets sonnent comme avant.
 */

export type OscWave = 'sine' | 'triangle' | 'sawtooth' | 'square';
export type FilterType = 'lowpass' | 'highpass' | 'bandpass';
export type LfoDest = 'off' | 'filter' | 'pitch' | 'amp';

export interface SynthOsc {
  on: boolean;
  wave: OscWave;
  /** Octave (-3 à +3). */
  octave: number;
  /** Demi-tons (-12 à +12). */
  semi: number;
  /** Désaccord fin en cents (-100 à +100). */
  fine: number;
  /** Niveau (0 à 1). */
  level: number;
  /** Voix d'unisson (1 à 7). */
  unison: number;
  /** Écart total de l'unisson en cents (0 à 100). */
  detune: number;
  /** Étalement stéréo de l'unisson (0 à 1). */
  spread: number;
}

export interface SynthEnv { a: number; d: number; s: number; r: number }

export interface NovaSynthSettings {
  v: 1;
  /** Préréglage d'origine (les réglages peuvent avoir été retouchés). */
  presetId?: string;
  name?: string;
  osc: [SynthOsc, SynthOsc, SynthOsc];
  noise: { level: number };
  filter: {
    type: FilterType;
    /** Coupure en Hz (20 à 20000). */
    cutoff: number;
    /** Résonance (Q, 0.1 à 20). */
    reso: number;
    /** 24 dB/oct (deux filtres en série) au lieu de 12. */
    steep: boolean;
    /** Suivi du clavier (0 à 1 : 1 = la coupure suit la note). */
    keytrack: number;
    /** Enveloppe de filtre, en octaves (-4 à +6). */
    envAmount: number;
    /** Vélocité vers le filtre, en octaves (0 à 4). */
    velAmount: number;
  };
  ampEnv: SynthEnv;
  filterEnv: SynthEnv;
  lfo: { wave: OscWave; rate: number; dest: LfoDest; amount: number };
  mono: boolean;
  /** Mono : une note liée ne relance pas l'attaque. */
  legato: boolean;
  /** Glissé / portamento en secondes (0 = aucun). */
  glide: number;
  /** Vélocité vers le volume (0 = toujours fort, 1 = très dynamique). */
  velToAmp: number;
  fx: {
    chorus: { mix: number; rate: number; depth: number };
    delay: { mix: number; time: number; feedback: number };
  };
  /** Volume du préréglage (0 à 1). */
  level: number;
}

// --- Constantes anti-clic --------------------------------------------------------------

/** Attaque minimale (s) : en dessous, l'attaque claque. */
export const MIN_ATTACK = 0.003;
/** Relâchement minimal (s). */
export const MIN_RELEASE = 0.012;
/** Fondu quand une voix est volée ou remplacée (s). */
export const STEAL_FADE = 0.008;
/** Polyphonie maximale par piste. */
export const MAX_VOICES = 16;
/** Après setTargetAtTime(0, t, r/4), la voix est arrêtée à t + r × RELEASE_TAIL (≈ -70 dB). */
export const RELEASE_TAIL = 2;

const clamp = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(hi, Math.max(lo, n));
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

export const WAVES: readonly OscWave[] = ['sine', 'triangle', 'sawtooth', 'square'];
export const FILTER_TYPES: readonly FilterType[] = ['lowpass', 'highpass', 'bandpass'];
export const LFO_DESTS: readonly LfoDest[] = ['off', 'filter', 'pitch', 'amp'];

export const defaultOsc = (over: Partial<SynthOsc> = {}): SynthOsc => ({
  on: false, wave: 'sawtooth', octave: 0, semi: 0, fine: 0, level: 0.8, unison: 1, detune: 0, spread: 0, ...over,
});

export const defaultSynth = (): NovaSynthSettings => ({
  v: 1,
  osc: [defaultOsc({ on: true }), defaultOsc({ wave: 'square', octave: -1, level: 0.5 }), defaultOsc({ wave: 'sine', level: 0.5 })],
  noise: { level: 0 },
  filter: { type: 'lowpass', cutoff: 2400, reso: 1, steep: false, keytrack: 0.3, envAmount: 1.5, velAmount: 1 },
  ampEnv: { a: 0.005, d: 0.3, s: 0.7, r: 0.25 },
  filterEnv: { a: 0.005, d: 0.4, s: 0.3, r: 0.3 },
  lfo: { wave: 'sine', rate: 5, dest: 'off', amount: 0.2 },
  mono: false, legato: true, glide: 0,
  velToAmp: 0.6,
  fx: { chorus: { mix: 0, rate: 0.6, depth: 0.4 }, delay: { mix: 0, time: 0.375, feedback: 0.3 } },
  level: 0.7,
});

const normOsc = (raw: any, d: SynthOsc): SynthOsc => {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    on: bool(o.on, d.on),
    wave: oneOf(o.wave, WAVES, d.wave),
    octave: Math.round(clamp(o.octave, -3, 3, d.octave)),
    semi: Math.round(clamp(o.semi, -12, 12, d.semi)),
    fine: clamp(o.fine, -100, 100, d.fine),
    level: clamp(o.level, 0, 1, d.level),
    unison: Math.round(clamp(o.unison, 1, 7, d.unison)),
    detune: clamp(o.detune, 0, 100, d.detune),
    spread: clamp(o.spread, 0, 1, d.spread),
  };
};
const normEnv = (raw: any, d: SynthEnv): SynthEnv => {
  const e = raw && typeof raw === 'object' ? raw : {};
  return { a: clamp(e.a, 0, 10, d.a), d: clamp(e.d, 0, 10, d.d), s: clamp(e.s, 0, 1, d.s), r: clamp(e.r, 0, 15, d.r) };
};

/**
 * Réglages sûrs à partir de n'importe quoi (projet ancien, version plus récente,
 * collaborateur) : champs manquants complétés, valeurs bornées, inconnues ignorées.
 */
export function normalizeSynth(raw: unknown): NovaSynthSettings {
  const d = defaultSynth();
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const osc = Array.isArray(r.osc) ? r.osc : [];
  const f = r.filter || {}, l = r.lfo || {}, fx = r.fx || {}, ch = fx.chorus || {}, dl = fx.delay || {};
  return {
    v: 1,
    ...(typeof r.presetId === 'string' ? { presetId: r.presetId } : {}),
    ...(typeof r.name === 'string' ? { name: r.name.slice(0, 60) } : {}),
    osc: [normOsc(osc[0], d.osc[0]), normOsc(osc[1], { ...d.osc[1], on: false }), normOsc(osc[2], { ...d.osc[2], on: false })],
    noise: { level: clamp(r.noise?.level, 0, 1, 0) },
    filter: {
      type: oneOf(f.type, FILTER_TYPES, d.filter.type),
      cutoff: clamp(f.cutoff, 20, 20000, d.filter.cutoff),
      reso: clamp(f.reso, 0.1, 20, d.filter.reso),
      steep: bool(f.steep, d.filter.steep),
      keytrack: clamp(f.keytrack, 0, 1, d.filter.keytrack),
      envAmount: clamp(f.envAmount, -4, 6, d.filter.envAmount),
      velAmount: clamp(f.velAmount, 0, 4, d.filter.velAmount),
    },
    ampEnv: normEnv(r.ampEnv, d.ampEnv),
    filterEnv: normEnv(r.filterEnv, d.filterEnv),
    lfo: { wave: oneOf(l.wave, WAVES, d.lfo.wave), rate: clamp(l.rate, 0.05, 20, d.lfo.rate), dest: oneOf(l.dest, LFO_DESTS, d.lfo.dest), amount: clamp(l.amount, 0, 1, d.lfo.amount) },
    mono: bool(r.mono, d.mono),
    legato: bool(r.legato, d.legato),
    glide: clamp(r.glide, 0, 2, d.glide),
    velToAmp: clamp(r.velToAmp, 0, 1, d.velToAmp),
    fx: {
      chorus: { mix: clamp(ch.mix, 0, 1, 0), rate: clamp(ch.rate, 0.05, 8, d.fx.chorus.rate), depth: clamp(ch.depth, 0, 1, d.fx.chorus.depth) },
      delay: { mix: clamp(dl.mix, 0, 1, 0), time: clamp(dl.time, 0.02, 1.5, d.fx.delay.time), feedback: clamp(dl.feedback, 0, 0.9, d.fx.delay.feedback) },
    },
    level: clamp(r.level, 0, 1, d.level),
  };
}

// --- Calculs du son -----------------------------------------------------------------------

export const noteFreq = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12);

/** Décalages (cents) et panoramiques des voix d'unisson, symétriques autour de 0. */
export function unisonVoices(n: number, detuneCents: number, spread: number): { cents: number; pan: number }[] {
  const k = Math.max(1, Math.round(n));
  if (k === 1) return [{ cents: 0, pan: 0 }];
  return Array.from({ length: k }, (_, i) => {
    const x = (i / (k - 1)) * 2 - 1; // -1 … +1
    return { cents: x * detuneCents / 2, pan: Math.max(-1, Math.min(1, x * spread)) };
  });
}

/** Désaccord fixe d'un oscillateur (octave, demi-tons, fin) en cents. */
export const oscCents = (o: SynthOsc) => o.octave * 1200 + o.semi * 100 + o.fine;

/** Gain de vélocité : vel 0..1 → 1 - amt + amt × vel² (courbe douce, comme un piano). */
export const velocityGain = (vel: number, amt: number) => {
  const v = Math.min(1, Math.max(0, vel));
  return 1 - amt + amt * v * v;
};

/** Coupure du filtre pour une note (suivi du clavier + vélocité), bornée 20 Hz … 20 kHz. */
export function cutoffFor(s: NovaSynthSettings, pitch: number, vel: number): number {
  const v = Math.min(1, Math.max(0, vel));
  const oct = s.filter.keytrack * (pitch - 60) / 12 + s.filter.velAmount * (v - 1);
  return Math.min(20000, Math.max(20, s.filter.cutoff * Math.pow(2, oct)));
}

/**
 * Gain par voix d'oscillateur pour garder un niveau cohérent : les voix d'unisson
 * s'additionnent en puissance (√N) et plusieurs oscillateurs aussi.
 */
export function mixNorm(s: NovaSynthSettings): number {
  let p = 0;
  for (const o of s.osc) if (o.on) p += o.level * o.level * o.unison;
  p += s.noise.level * s.noise.level * 0.5;
  return p > 0 ? 1 / Math.sqrt(Math.max(1, p)) : 1;
}

/** Valeur de l'enveloppe ADSR (attaque linéaire, déclin exponentiel τ = d/4) à t secondes de l'attaque. */
export function envValue(env: SynthEnv, t: number): number {
  const a = Math.max(MIN_ATTACK, env.a);
  if (t <= 0) return 0;
  if (t < a) return t / a;
  const tau = Math.max(1e-4, env.d / 4);
  return env.s + (1 - env.s) * Math.exp(-(t - a) / tau);
}

/** Durée totale d'une voix relâchée à `r` (relâchement + queue). */
export const releaseTail = (env: SynthEnv) => Math.max(MIN_RELEASE, env.r) * RELEASE_TAIL;

// --- Répartition des voix (dans le temps) ----------------------------------------------

export interface VoiceSlot {
  id: number;
  pitch: number;
  start: number;
  /** Instant de relâchement (Infinity tant que la note est tenue). */
  release: number;
  /** Fin réelle du son (relâchement + queue, ou coupure). */
  end: number;
  /** Coupée (volée / remplacée) à cet instant. */
  cutAt?: number;
}

export const soundingAt = (v: VoiceSlot, t: number) => v.start <= t + 1e-9 && v.end > t + 1e-9 && (v.cutAt === undefined || v.cutAt > t + 1e-9);

/**
 * Note jouée avant `t` (pour le glissé) : la dernière commencée, si elle sonne
 * encore à `t` (ou si `always`, même relâchée).
 */
export function glideSource<V extends VoiceSlot>(voices: V[], t: number, always: boolean): V | null {
  let best: V | null = null;
  for (const v of voices) {
    if (v.start >= t - 1e-9) continue;
    if (!always && !soundingAt(v, t)) continue;
    if (!best || v.start > best.start) best = v;
  }
  return best;
}

/**
 * Voix à couper quand une note commence à `t` :
 * - mono : toutes celles qui sonnent ;
 * - poly : la même touche qui sonne encore, puis les plus anciennes au-delà de `max`.
 */
export function voicesToCut<V extends VoiceSlot>(voices: V[], t: number, pitch: number, mono: boolean, max = MAX_VOICES): V[] {
  const live = voices.filter(v => soundingAt(v, t));
  if (mono) return live;
  const cut = live.filter(v => v.pitch === pitch);
  const rest = live.filter(v => v.pitch !== pitch).sort((a, b) => a.start - b.start || a.id - b.id);
  // Les voix déjà relâchées partent en premier, puis les plus anciennes.
  rest.sort((a, b) => (Number(a.release === Infinity) - Number(b.release === Infinity)) || a.start - b.start);
  const over = rest.length + 1 - max;
  for (let i = 0; i < over; i++) cut.push(rest[i]);
  return cut;
}

/**
 * Voix relâchée par un « note off » de `pitch` à `t` : la plus ancienne encore tenue
 * de cette touche commencée avant `t`.
 */
export function voiceToRelease<V extends VoiceSlot>(voices: V[], pitch: number, t: number): V | null {
  let best: V | null = null;
  for (const v of voices) {
    if (v.pitch !== pitch || v.release !== Infinity || v.start > t + 1e-9) continue;
    if (!best || v.start < best.start) best = v;
  }
  return best;
}

/** Mono : une voix commencée après `from` et avant `to` coupe la voix précédente. */
export function nextMonoStart(voices: VoiceSlot[], self: VoiceSlot, to: number): number | null {
  let best: number | null = null;
  for (const v of voices) {
    if (v === self || v.start <= self.start + 1e-9 || v.start >= to) continue;
    if (best === null || v.start < best) best = v.start;
  }
  return best;
}

// --- Navigation dans les préréglages ----------------------------------------------------

export function stepIndex(len: number, idx: number, dir: 1 | -1): number {
  if (len <= 0) return -1;
  if (idx < 0) return dir > 0 ? 0 : len - 1;
  return (idx + dir + len) % len;
}

export function toggleFavorite(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id];
}

/** Petite empreinte des réglages (pour savoir si un préréglage a été retouché). */
export function settingsKey(s: NovaSynthSettings): string {
  const { presetId: _p, name: _n, ...rest } = s;
  return JSON.stringify(rest);
}
