/**
 * Accords (V20) : nom, notes, et détection des accords d'un sample ou d'un
 * beat, comme Chord ID / la piste d'accords de Logic ou « Convert Harmony to
 * MIDI » d'Ableton Live.
 *
 * Méthode (logique pure, sans DOM, tests/chordDetect.test.ts) :
 *  1. Chroma : spectre (FFT 4096 sur l'audio ramené à ~11 kHz, toutes les
 *     ~93 ms), chaque case de fréquence versée dans sa classe de note (Do…Si),
 *     pondérée par sa proximité au demi-ton ; la basse (sous ~200 Hz) à part.
 *  2. Un chroma par temps du morceau (grille au tempo du projet).
 *  3. Gabarits majeur, mineur, 7, maj7, m7, sus2, sus4, dim, avec les
 *     harmoniques de chaque note (la quinte et la tierce majeure qu'ajoute
 *     un son réel) ; score = cosinus + petit bonus si la basse joue la
 *     fondamentale.
 *  4. Lissage (Viterbi) : changer d'accord coûte, moins sur le 1er temps de
 *     la mesure ; les changements tombent donc sur les temps, de préférence
 *     en début de mesure.
 */
import { decimate, magnitudeAt } from './spectrum';
import { scaleIntervals } from './scales';

export type ChordQuality = 'maj' | 'min' | '7' | 'maj7' | 'min7' | 'sus2' | 'sus4' | 'dim';

/** Un accord de la piste d'accords (temps en secondes, comme les repères). */
export interface ChordEvent {
  id: string;
  start: number;
  end: number;
  /** Fondamentale (0 = Do … 11 = Si). */
  root: number;
  quality: ChordQuality;
  /** Trouvé par l'analyse (et pas posé à la main). */
  auto?: boolean;
  /** Collaboration : qui l'a posé. */
  by?: string;
}

export const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7], dim: [0, 3, 6],
};
export const CHORD_QUALITIES: ChordQuality[] = ['maj', 'min', '7', 'maj7', 'min7', 'sus2', 'sus4', 'dim'];

const NAMES_EN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NAMES_FR = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const SUFFIX: Record<ChordQuality, string> = { maj: '', min: 'm', '7': '7', maj7: 'maj7', min7: 'm7', sus2: 'sus2', sus4: 'sus4', dim: 'dim' };
const QUALITY_FR: Record<ChordQuality, string> = {
  maj: 'majeur', min: 'mineur', '7': '7', maj7: 'majeur 7', min7: 'mineur 7', sus2: 'sus2', sus4: 'sus4', dim: 'diminué',
};

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;

/** « Am », « F », « C7 », « Gsus4 »… (notation des grilles d'accords). */
export const chordSymbol = (root: number, quality: ChordQuality): string => `${NAMES_EN[pc(root)]}${SUFFIX[quality] ?? ''}`;
/** « La mineur », « Fa majeur »… (infobulles). */
export const chordNameFr = (root: number, quality: ChordQuality): string => `${NAMES_FR[pc(root)]} ${QUALITY_FR[quality] ?? ''}`.trim();
/** Classes de notes de l'accord (0-11). */
export const chordTones = (root: number, quality: ChordQuality): number[] => (QUALITY_INTERVALS[quality] || QUALITY_INTERVALS.maj).map(i => pc(root + i));

/** Lecture d'un symbole (« Am », « F#m7 », « Bb », « Gsus4 ») ; null s'il n'est pas reconnu. */
export function parseChordSymbol(s: string): { root: number; quality: ChordQuality } | null {
  const m = /^\s*([A-Ga-g])([#b♭♯]?)(.*)$/.exec(s || '');
  if (!m) return null;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let root = base[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') root++;
  if (m[2] === 'b' || m[2] === '♭') root--;
  const rest = m[3].trim().toLowerCase();
  const table: Record<string, ChordQuality> = {
    '': 'maj', maj: 'maj', m: 'min', min: 'min', '-': 'min', '7': '7', maj7: 'maj7', m7: 'min7', min7: 'min7',
    sus2: 'sus2', sus4: 'sus4', sus: 'sus4', dim: 'dim', '°': 'dim',
  };
  const q = table[rest];
  return q ? { root: pc(root), quality: q } : null;
}

/**
 * Notes MIDI d'un accord, voix serrées autour de `center` (par défaut vers
 * Do3-Do4) ; avec `bass`, la fondamentale est doublée une octave plus bas.
 */
export function chordPitches(root: number, quality: ChordQuality, opts: { center?: number; bass?: boolean; prev?: number[] } = {}): number[] {
  const center = opts.center ?? 60;
  const tones = (QUALITY_INTERVALS[quality] || QUALITY_INTERVALS.maj).map(i => pc(root + i));
  // Chaque note de l'accord à l'octave la plus proche du centre (ou de la voix précédente).
  const ref = opts.prev?.length ? opts.prev.reduce((a, b) => a + b, 0) / opts.prev.length : center;
  const notes = tones.map(t => {
    let best = t, bd = Infinity;
    for (let o = 2; o <= 7; o++) { const p = t + 12 * o; const d = Math.abs(p - ref); if (d < bd) { bd = d; best = p; } }
    return best;
  });
  notes.sort((a, b) => a - b);
  // Pas plus d'une octave et demie d'écart : on resserre.
  while (notes[notes.length - 1] - notes[0] > 14) { const hi = notes.pop()!; notes.unshift(hi - 12); notes.sort((a, b) => a - b); }
  if (opts.bass) {
    let b = pc(root) + 36;
    while (b > notes[0] - 7) b -= 12;
    if (b >= 24) notes.unshift(b);
  }
  return notes;
}

/**
 * Accords de la gamme (proposés en premier dans le choix d'accord) : triade
 * construite sur chaque degré, dans l'ordre de la gamme (I, ii, iii…).
 */
export function diatonicChords(keyRoot: number, scale?: string): { root: number; quality: ChordQuality; degree: number }[] {
  const iv = scaleIntervals(scale);
  if (iv.length !== 7) {
    const minor = /MIN/i.test(scale || '');
    return [{ root: pc(keyRoot), quality: minor ? 'min' : 'maj', degree: 1 }];
  }
  return iv.map((d, i) => {
    const third = (iv[(i + 2) % 7] - d + 12) % 12;
    const fifth = (iv[(i + 4) % 7] - d + 12) % 12;
    // (une triade augmentée, rare dans ces gammes, est proposée en majeur)
    const quality: ChordQuality = third === 4 ? 'maj' : fifth === 6 ? 'dim' : 'min';
    return { root: pc(keyRoot + d), quality, degree: i + 1 };
  });
}

// ---------------------------------------------------------------------------
// Chroma
// ---------------------------------------------------------------------------

export interface ChromaFrames {
  /** Écart entre deux trames (s) et instant du centre de la trame 0 (s). */
  hopSec: number;
  t0: number;
  /** Chroma (12 valeurs) par trame. */
  chroma: Float32Array[];
  /** Chroma de la basse (sous ~200 Hz) par trame. */
  bass: Float32Array[];
  /** Énergie de la trame (somme des amplitudes prises en compte). */
  energy: Float32Array;
}

const FFT_N = 4096;

/** Chroma trame par trame d'un signal mono. Coût : ~0,2 s de calcul par minute d'audio. */
export function chromaFrames(x: Float32Array, sr: number): ChromaFrames {
  const factor = Math.max(1, Math.round(sr / 11025));
  const y = decimate(x, factor);
  const fs = sr / factor;
  const hop = 1024;
  // Cases de fréquence utiles : classe de note et poids (proximité du demi-ton).
  const bins: { k: number; pc: number; w: number; bass: boolean; main: boolean }[] = [];
  for (let k = 1; k <= FFT_N / 2; k++) {
    const f = (k * fs) / FFT_N;
    // Sous ~100 Hz : kick et sub (souvent accordés, ils brouillent l'accord) ;
    // ils ne servent qu'au chroma de la basse.
    if (f < 40 || f > 2100) continue;
    const m = 69 + 12 * Math.log2(f / 440);
    const r = Math.round(m);
    const dev = m - r;
    const w = Math.exp(-(dev * dev) / (2 * 0.16 * 0.16));
    if (w < 0.05) continue;
    bins.push({ k, pc: ((r % 12) + 12) % 12, w, bass: f < 200, main: f >= 100 });
  }
  const frames = Math.max(0, Math.floor((y.length - FFT_N) / hop) + 1);
  const chroma: Float32Array[] = [], bass: Float32Array[] = [];
  const energy = new Float32Array(frames);
  const mag = new Float64Array(FFT_N / 2 + 1);
  const tonal = new Float64Array(FFT_N / 2 + 1);
  const cum = new Float64Array(FFT_N / 2 + 2);
  for (let i = 0; i < frames; i++) {
    magnitudeAt(y, i * hop, FFT_N, mag);
    // Seules les raies (notes) comptent : on retire le « tapis » local du
    // spectre (souffle, hi-hats, caisse claire), moyenne sur ±12 cases.
    cum[0] = 0;
    for (let k = 0; k <= FFT_N / 2; k++) cum[k + 1] = cum[k] + mag[k];
    for (let k = 0; k <= FFT_N / 2; k++) {
      const a = Math.max(0, k - 12), z = Math.min(FFT_N / 2, k + 12);
      const floor = (cum[z + 1] - cum[a]) / (z - a + 1);
      tonal[k] = Math.max(0, mag[k] - 1.6 * floor);
    }
    const c = new Float32Array(12), b = new Float32Array(12);
    let e = 0;
    for (const bn of bins) {
      const v = tonal[bn.k] * bn.w;
      if (bn.main) { c[bn.pc] += v; e += v; }
      if (bn.bass) b[bn.pc] += v;
    }
    chroma.push(c); bass.push(b); energy[i] = e;
  }
  return { hopSec: hop / fs, t0: FFT_N / 2 / fs, chroma, bass, energy };
}

/** Gabarit d'accord avec les harmoniques (son réel : octave, quinte, tierce majeure au-dessus). */
const HARM = [[0, 1], [0, 0.6], [7, 0.4], [0, 0.25], [4, 0.15]] as const;
const templates = new Map<ChordQuality, Float64Array[]>();
function templateOf(root: number, q: ChordQuality): Float64Array {
  let list = templates.get(q);
  if (!list) {
    list = [];
    for (let r = 0; r < 12; r++) {
      const t = new Float64Array(12);
      for (const iv of QUALITY_INTERVALS[q]) for (const [h, w] of HARM) t[(r + iv + h) % 12] += w;
      let n = 0; for (const v of t) n += v * v; n = Math.sqrt(n);
      for (let i = 0; i < 12; i++) t[i] /= n;
      list.push(t);
    }
    templates.set(q, list);
  }
  return list[root];
}

/** Préférence a priori : à score égal, la triade simple l'emporte. */
const PRIOR: Record<ChordQuality, number> = { maj: 1, min: 1, '7': 0.975, maj7: 0.975, min7: 0.975, sus2: 0.95, sus4: 0.95, dim: 0.94 };

export interface ChordScore { root: number; quality: ChordQuality; score: number }

/** Score de chaque accord pour un chroma (et la basse, facultative). Trié du meilleur au moins bon. */
export function scoreChroma(chroma: ArrayLike<number>, bass?: ArrayLike<number>, qualities: ChordQuality[] = CHORD_QUALITIES): ChordScore[] {
  const c = new Float64Array(12);
  let max = 0;
  for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);
  if (max <= 0) return [];
  // Compression : une note très forte (808) n'écrase pas les autres.
  for (let i = 0; i < 12; i++) c[i] = Math.log1p(8 * chroma[i] / max);
  const mean = c.reduce((a, b) => a + b, 0) / 12;
  for (let i = 0; i < 12; i++) c[i] = Math.max(0, c[i] - mean * 0.5);
  let n = 0; for (const v of c) n += v * v; n = Math.sqrt(n) || 1;
  let bmax = 0;
  if (bass) for (let i = 0; i < 12; i++) bmax = Math.max(bmax, bass[i]);
  const out: ChordScore[] = [];
  for (const q of qualities) {
    for (let r = 0; r < 12; r++) {
      const t = templateOf(r, q);
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += c[i] * t[i];
      let s = (dot / n) * PRIOR[q];
      if (bass && bmax > 0) s += 0.1 * (bass[r] / bmax);
      out.push({ root: r, quality: q, score: s });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface DetectOptions {
  bpm: number;
  /** Temps par mesure (4 en 4/4). */
  beatsPerBar?: number;
  /** Instant (s, dans l'audio analysé) d'un premier temps de mesure : la grille part de là. */
  gridOrigin?: number;
  /** Partie analysée (s) ; par défaut tout l'audio. */
  from?: number;
  to?: number;
  qualities?: ChordQuality[];
  /** Coût d'un changement d'accord (lissage). */
  changePenalty?: number;
}

export interface DetectedChord { start: number; end: number; root: number; quality: ChordQuality; score: number }

/**
 * Accords d'un signal mono : un par temps au plus, lissés, fusionnés quand
 * ils se répètent. Les temps sans harmonie (silence) ne portent pas d'accord.
 */
export function detectChords(x: Float32Array, sr: number, opts: DetectOptions): DetectedChord[] {
  const cf = chromaFrames(x, sr);
  return detectChordsFromFrames(cf, x.length / sr, opts);
}

export function detectChordsFromFrames(cf: ChromaFrames, duration: number, opts: DetectOptions): DetectedChord[] {
  const beat = 60 / Math.max(20, opts.bpm || 120);
  const bpb = Math.max(1, Math.round(opts.beatsPerBar || 4));
  const from = Math.max(0, opts.from ?? 0), to = Math.min(duration, opts.to ?? duration);
  const origin = opts.gridOrigin ?? 0;
  const quals = opts.qualities?.length ? opts.qualities : CHORD_QUALITIES;
  const lambda = opts.changePenalty ?? 0.16;

  // Temps de la grille dans [from, to[.
  const k0 = Math.ceil((from - origin) / beat - 1e-6);
  const segs: { a: number; b: number; beatIndex: number }[] = [];
  if (from < origin + k0 * beat - 1e-6) segs.push({ a: from, b: Math.min(to, origin + k0 * beat), beatIndex: k0 - 1 });
  for (let k = k0; origin + k * beat < to - 1e-6; k++) segs.push({ a: origin + k * beat, b: Math.min(to, origin + (k + 1) * beat), beatIndex: k });
  if (!segs.length) return [];

  // Chroma de chaque temps.
  const segChroma: Float64Array[] = [], segBass: Float64Array[] = [], segE: number[] = [];
  for (const s of segs) {
    const c = new Float64Array(12), b = new Float64Array(12);
    let e = 0, cnt = 0;
    for (let i = 0; i < cf.chroma.length; i++) {
      const t = cf.t0 + i * cf.hopSec;
      if (t < s.a || t >= s.b) continue;
      for (let j = 0; j < 12; j++) { c[j] += cf.chroma[i][j]; b[j] += cf.bass[i][j]; }
      e += cf.energy[i]; cnt++;
    }
    if (!cnt) {
      // Temps plus court qu'une trame : la trame la plus proche.
      const i = Math.max(0, Math.min(cf.chroma.length - 1, Math.round(((s.a + s.b) / 2 - cf.t0) / cf.hopSec)));
      if (cf.chroma[i]) { for (let j = 0; j < 12; j++) { c[j] = cf.chroma[i][j]; b[j] = cf.bass[i][j]; } e = cf.energy[i]; cnt = 1; }
    }
    segChroma.push(c); segBass.push(b); segE.push(cnt ? e / cnt : 0);
  }
  const eMax = Math.max(...segE, 1e-12);

  // États : 12 × qualités + « pas d'accord » (dernier).
  const S = 12 * quals.length;
  const NONE = S;
  const T = segs.length;
  const emit: Float64Array[] = [];
  for (let t = 0; t < T; t++) {
    const e = new Float64Array(S + 1);
    const quiet = segE[t] < eMax * 0.02;
    const sc = quiet ? [] : scoreChroma(segChroma[t], segBass[t], quals);
    for (const s of sc) e[quals.indexOf(s.quality) * 12 + s.root] = s.score;
    e[NONE] = quiet ? 1 : 0.35;
    emit.push(e);
  }
  const penaltyAt = (beatIndex: number) => {
    const pos = ((beatIndex % bpb) + bpb) % bpb;
    if (pos === 0) return lambda * 0.5;
    if (bpb % 2 === 0 && pos === bpb / 2) return lambda * 0.9;
    return lambda * 1.4;
  };
  // Viterbi.
  let prev = Float64Array.from(emit[0]);
  const back: Int16Array[] = [new Int16Array(S + 1).fill(-1)];
  for (let t = 1; t < T; t++) {
    let bestPrev = 0, bestVal = -Infinity;
    for (let j = 0; j <= S; j++) if (prev[j] > bestVal) { bestVal = prev[j]; bestPrev = j; }
    const pen = penaltyAt(segs[t].beatIndex);
    const cur = new Float64Array(S + 1);
    const bk = new Int16Array(S + 1);
    for (let j = 0; j <= S; j++) {
      const stay = prev[j];
      const move = bestVal - pen;
      if (stay >= move) { cur[j] = stay + emit[t][j]; bk[j] = j; } else { cur[j] = move + emit[t][j]; bk[j] = bestPrev; }
    }
    back.push(bk); prev = cur;
  }
  let st = 0, bv = -Infinity;
  for (let j = 0; j <= S; j++) if (prev[j] > bv) { bv = prev[j]; st = j; }
  const path = new Array<number>(T);
  for (let t = T - 1; t >= 0; t--) { path[t] = st; st = t > 0 ? back[t][st] : st; }

  // Fusion des temps consécutifs du même accord.
  const out: DetectedChord[] = [];
  for (let t = 0; t < T; t++) {
    const s = path[t];
    if (s === NONE) continue;
    const root = s % 12, quality = quals[Math.floor(s / 12)];
    const last = out[out.length - 1];
    if (last && last.root === root && last.quality === quality && Math.abs(last.end - segs[t].a) < 1e-6) {
      last.end = segs[t].b; last.score += emit[t][s];
      (last as any)._n++;
    } else {
      out.push({ start: segs[t].a, end: segs[t].b, root, quality, score: emit[t][s], _n: 1 } as DetectedChord & { _n: number });
    }
  }
  return out.map(c => { const n = (c as any)._n || 1; return { start: c.start, end: c.end, root: c.root, quality: c.quality, score: c.score / n }; });
}

/** Accord joué à l'instant t (s) dans une liste triée (null : aucun). */
export function chordAt<T extends { start: number; end: number }>(list: T[] | undefined, t: number): T | null {
  if (!list?.length) return null;
  for (const c of list) if (t >= c.start - 1e-9 && t < c.end - 1e-9) return c;
  return null;
}
