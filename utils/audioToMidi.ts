/**
 * Audio → MIDI (V20) : « Convert Melody / Drums / Harmony to MIDI » d'Ableton
 * Live, « Create MIDI » du Flex Pitch de Logic.
 *
 *  - Mélodie : les notes d'une voix (utils/pitchAnalysis, V19) deviennent des
 *    notes MIDI, calées plus ou moins sur la gamme et sur la grille, avec ou
 *    sans les nuances (vélocités), à l'octave de l'instrument choisi (808,
 *    piano, lead, nappe du synthé NOVA).
 *  - Batterie : attaques d'une boucle (flux spectral), classées kick,
 *    snare / clap ou hat selon la bande d'énergie et le centroïde, puis
 *    rangées dans la boîte à rythmes ou en notes General MIDI 36 / 38 / 42.
 *  - Harmonie : accords (utils/chordDetect) joués en accords MIDI, voix
 *    serrées et enchaînées au plus près.
 *
 * Logique pure, sans DOM (tests/audioToMidi.test.ts).
 */
import type { Clip, MidiNote, Track } from '../types';
import { TrackType } from '../types';
import type { PitchNote, PitchTrack } from './pitchAnalysis';
import { isInScale, snapToScale } from './scales';
import { magnitudeAt } from './spectrum';
import { chordPitches, ChordQuality } from './chordDetect';
import { presetSettings } from './novaSynthPresets';
import type { DrumMachine, DrumRow } from './drumKits';

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export type HumInstrument = '808' | 'piano' | 'lead' | 'pad';

export const HUM_INSTRUMENTS: { id: HumInstrument; label: string; emoji: string; hint: string; presetId?: string; range: [number, number]; color: string }[] = [
  { id: '808', label: '808', emoji: '🔊', hint: 'Ta mélodie devient une ligne de 808 (une ou deux octaves plus bas), comme la 808 Bass du Synth Player de Logic.', range: [31, 43], color: '#d946ef' },
  { id: 'piano', label: 'Piano', emoji: '🎹', hint: 'Piano doux du synthé NOVA, à la hauteur où tu as chanté.', presetId: 'piano-doux', range: [55, 74], color: '#38bdf8' },
  { id: 'lead', label: 'Lead', emoji: '🎵', hint: 'Lead R&B du synthé NOVA : idéal pour une topline ou une réponse à la voix.', presetId: 'lead-rnb-sinus', range: [62, 79], color: '#22d3ee' },
  { id: 'pad', label: 'Nappe', emoji: '🌫️', hint: 'Nappe chaude du synthé NOVA, notes liées.', presetId: 'nappe-chaude', range: [55, 72], color: '#a78bfa' },
];
export const humInstrument = (id: HumInstrument) => HUM_INSTRUMENTS.find(i => i.id === id) || HUM_INSTRUMENTS[0];

// ---------------------------------------------------------------------------
// Mélodie
// ---------------------------------------------------------------------------

export interface MelodyOptions {
  bpm: number;
  /** Gamme du projet (absente : notes au demi-ton le plus proche). */
  keyRoot?: number;
  scale?: string;
  /** Calage sur la gamme, 0 (aucun) à 1 (toutes les notes dans la gamme). */
  scaleAmount?: number;
  /** Calage sur la grille, 0 (jeu libre) à 1 (pile sur la grille). */
  gridAmount?: number;
  /** Pas de grille en temps (0,25 = double croche). */
  gridBeats?: number;
  /** Garder les nuances (vélocités) du chant ; sinon toutes les notes à 80 %. */
  keepVelocity?: boolean;
  instrument?: HumInstrument;
  /** Instant (s, timeline) du début de l'audio analysé. */
  timeOffset?: number;
  /** Instant (s, timeline) d'un premier temps de la grille (0 par défaut). */
  gridOrigin?: number;
  /** Notes plus courtes ignorées (s). */
  minNoteSec?: number;
  /** Transposition à l'octave de l'instrument (par défaut : oui). */
  fitOctave?: boolean;
}

export interface MelodyNote {
  pitch: number;
  /** Début et durée (s, timeline). */
  start: number;
  duration: number;
  /** 0-1. */
  velocity: number;
  /** Hauteur chantée (MIDI fractionnaire), pour comparer. */
  sung: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Note MIDI d'une hauteur chantée, avec le calage sur la gamme dosé. */
export function pitchForSung(center: number, opts: { keyRoot?: number; scale?: string; scaleAmount?: number }): number {
  const near = Math.round(center);
  const amount = clamp(opts.scaleAmount ?? 1, 0, 1);
  if (typeof opts.keyRoot !== 'number' || !opts.scale || /CHROMATIC/i.test(opts.scale) || amount <= 0) return near;
  if (isInScale(near, opts.keyRoot, opts.scale)) return near;
  // La note de la gamme la plus proche de ce qui a été chanté (au cent près).
  const up = snapToScale(Math.ceil(center), opts.keyRoot, opts.scale, 'up');
  const down = snapToScale(Math.floor(center), opts.keyRoot, opts.scale, 'down');
  const target = Math.abs(up - center) <= Math.abs(center - down) ? up : down;
  // Dosage : à 100 % on cale toujours, à 50 % seulement si la note de la gamme est à peine plus loin.
  const extra = Math.abs(target - center) - Math.abs(near - center);
  return extra <= amount * 1.0 + 1e-9 ? target : near;
}

/** Transposition (en octaves) qui place la médiane des notes dans la tessiture de l'instrument. */
export function octaveShiftFor(pitches: number[], range: [number, number]): number {
  if (!pitches.length) return 0;
  const m = median(pitches);
  let k = 0;
  while (m + 12 * k > range[1]) k--;
  while (m + 12 * k < range[0]) k++;
  return k;
}

/** Notes MIDI d'une voix analysée (notes de pitchAnalysis + niveau trame par trame). */
export function melodyNotes(notes: PitchNote[], track: Pick<PitchTrack, 'rmsDb'>, o: MelodyOptions): MelodyNote[] {
  const beat = 60 / Math.max(20, o.bpm || 120);
  const g = Math.max(1e-3, (o.gridBeats ?? 0.25) * beat);
  const ga = clamp(o.gridAmount ?? 0.5, 0, 1);
  const origin = o.gridOrigin ?? 0;
  const off = o.timeOffset ?? 0;
  const minLen = o.minNoteSec ?? 0.07;
  const inst = humInstrument(o.instrument || 'piano');

  // Niveau de chaque note (crête du niveau de ses trames).
  const lev = notes.map(n => {
    let m = -180;
    for (let i = n.i0; i < n.i1 && i < track.rmsDb.length; i++) m = Math.max(m, track.rmsDb[i]);
    return m;
  });
  const loud = lev.length ? Math.max(...lev) : 0;

  // Éclats isolés : une note très courte qui saute loin de ses deux voisines
  // (harmonique prise pour la note, consonne, souffle) n'est pas une note chantée.
  const spike = notes.map((n, i) => {
    if (n.end - n.start >= 0.16) return false;
    const near = (m?: PitchNote) => !!m && Math.abs(m.start - n.end) < 1 && Math.abs(m.end - n.start) < 1 && Math.abs(Math.round(m.center) - Math.round(n.center)) <= 7;
    return !near(notes[i - 1]) && !near(notes[i + 1]) && (notes[i - 1] || notes[i + 1]) !== undefined;
  });

  let out: MelodyNote[] = [];
  notes.forEach((n, i) => {
    if (n.end - n.start < minLen || !Number.isFinite(n.center) || spike[i]) return;
    const pitch = pitchForSung(n.center, o);
    const velocity = o.keepVelocity === false ? 0.8 : clamp(0.3 + 0.7 * (lev[i] - (loud - 24)) / 24, 0.3, 1);
    let s = off + n.start, e = off + n.end;
    if (ga > 0) {
      const qs = origin + Math.round((s - origin) / g) * g;
      const qe = origin + Math.round((e - origin) / g) * g;
      s += ga * (qs - s);
      e += ga * (qe - e);
      if (e - s < g * ga * 0.5 + 0.03 * (1 - ga)) e = s + Math.max(g * 0.5, 0.05);
    }
    out.push({ pitch, start: Math.max(0, s), duration: Math.max(0.03, e - Math.max(0, s)), velocity, sung: n.center });
  });
  out.sort((a, b) => a.start - b.start || b.duration - a.duration);
  // Deux notes au même instant (après calage) : on garde la plus longue.
  out = out.filter((n, i) => i === 0 || Math.abs(n.start - out[i - 1].start) > 1e-4);
  // Pas de chevauchement (sur la 808, deux notes qui se chevauchent glisseraient).
  for (let i = 0; i + 1 < out.length; i++) {
    const n = out[i], nx = out[i + 1];
    if (n.start + n.duration > nx.start) n.duration = Math.max(0.02, nx.start - n.start);
    // 808 et nappe : notes liées si l'écart est plus court qu'un pas de grille.
    if ((inst.id === '808' || inst.id === 'pad') && nx.start - (n.start + n.duration) < g * 1.01) n.duration = nx.start - n.start;
  }
  if (o.fitOctave !== false) {
    const k = octaveShiftFor(out.map(n => n.pitch), inst.range);
    if (k) out.forEach(n => { n.pitch = clamp(n.pitch + 12 * k, 0, 127); });
    // 808 : une note trop grave ne s'entend plus (sous ~Mi0), trop aiguë n'est plus une basse.
    if (inst.id === '808') out.forEach(n => { while (n.pitch < 28) n.pitch += 12; while (n.pitch > 52) n.pitch -= 12; });
  }
  return out;
}

/** Comparaison avec la hauteur mesurée : écart médian (demi-tons, octave de l'instrument retirée). */
export function melodyAccuracy(notes: MelodyNote[]): { median: number; within: number } {
  if (!notes.length) return { median: NaN, within: 0 };
  const d = notes.map(n => { const x = n.pitch - n.sung; return Math.abs(x - 12 * Math.round(x / 12)); });
  return { median: median(d), within: d.filter(v => v <= 0.5 + 1e-9).length / d.length };
}

// ---------------------------------------------------------------------------
// Batterie
// ---------------------------------------------------------------------------

export type DrumKind = 'kick' | 'snare' | 'hat';

export interface DrumHit {
  /** Instant de l'attaque (s, dans l'audio analysé). */
  time: number;
  kind: DrumKind;
  /** Autre son au même instant (un hat sur le kick). */
  also?: DrumKind[];
  /** 0-1. */
  velocity: number;
  /** Part de l'énergie qui arrive : grave, bas médium, médium aigu, aigu. */
  share: [number, number, number, number];
  /** Centroïde spectral de l'attaque (Hz). */
  centroid: number;
  /** Énergie qui arrive par bande, rapportée au coup le plus fort de la boucle dans cette bande (0-1). */
  level: [number, number, number, number];
}

export const DRUM_KIND_LABEL: Record<DrumKind, string> = { kick: 'Kick', snare: 'Snare / clap', hat: 'Hi-hat' };
/** Notes General MIDI : 36 kick, 38 snare, 42 hi-hat fermé. */
export const GM_NOTE: Record<DrumKind, number> = { kick: 36, snare: 38, hat: 42 };

const BANDS: [number, number][] = [[20, 140], [140, 600], [900, 5000], [6000, 16000]];

export interface DrumDetectOptions {
  /** Sensibilité 0-1 (plus haut = plus d'attaques). */
  sensitivity?: number;
  /** Écart minimal entre deux attaques (s). */
  minGapSec?: number;
}

/** Attaques d'une boucle de batterie, classées kick / snare / hat. */
export function detectDrumHits(input: Float32Array, sr: number, o: DrumDetectOptions = {}): DrumHit[] {
  const N = sr > 60000 ? 2048 : 1024;
  const hop = Math.round(N / 4);
  // Silence ajouté devant : un coup pile au début de la boucle a lui aussi un « avant ».
  const pad = N / 2 + 3 * hop;
  const x = new Float32Array(input.length + pad);
  x.set(input, pad);
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  if (frames < 3) return [];
  const binHz = sr / N;
  const bandOf = new Int8Array(N / 2 + 1).fill(-1);
  for (let k = 0; k <= N / 2; k++) { const f = k * binHz; BANDS.forEach(([a, b], i) => { if (f >= a && f < b) bandOf[k] = i; }); }
  const pow: Float64Array[] = [];        // énergie par bande
  const logm: Float32Array[] = [];       // spectre compressé (flux)
  const mag = new Float64Array(N / 2 + 1);
  for (let i = 0; i < frames; i++) {
    // Fenêtre centrée sur le début de la trame (l'attaque n'est pas noyée dans la fin d'un coup précédent).
    magnitudeAt(x, i * hop - N / 2, N, mag);
    const p = new Float64Array(4);
    const lm = new Float32Array(N / 2 + 1);
    for (let k = 1; k <= N / 2; k++) {
      const b = bandOf[k];
      if (b >= 0) p[b] += mag[k] * mag[k];
      lm[k] = Math.log1p(100 * mag[k]);
    }
    pow.push(p); logm.push(lm);
  }
  // Flux spectral (seulement les hausses), par trame.
  const flux = new Float64Array(frames);
  for (let i = 1; i < frames; i++) {
    let s = 0;
    for (let k = 1; k <= N / 2; k++) { const d = logm[i][k] - logm[i - 1][k]; if (d > 0) s += d; }
    flux[i] = s;
  }
  // Seuil adaptatif : médiane locale (±0,2 s) + marge selon la sensibilité.
  const sens = clamp(o.sensitivity ?? 0.5, 0, 1);
  const W = Math.max(3, Math.round((0.2 * sr) / hop));
  const fmax = Math.max(...flux, 1e-9);
  const minGap = Math.max(1, Math.round(((o.minGapSec ?? 0.045) * sr) / hop));
  const peaks: number[] = [];
  for (let i = 1; i < frames - 1; i++) {
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const win: number[] = [];
    for (let k = Math.max(0, i - W); k <= Math.min(frames - 1, i + W); k++) win.push(flux[k]);
    const thr = median(win) * (1.2 + (1 - sens) * 1.2) + fmax * (0.12 - sens * 0.1);
    if (flux[i] < thr) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < minGap) {
      if (flux[i] > flux[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  // Caractéristiques : énergie qui ARRIVE dans chaque bande (après − avant).
  const raw = peaks.map(i => {
    const after = new Float64Array(4), before = new Float64Array(4);
    for (let k = i; k < Math.min(frames, i + 4); k++) for (let b = 0; b < 4; b++) after[b] = Math.max(after[b], pow[k][b]);
    let cnt = 0;
    for (let k = Math.max(0, i - 3); k < i; k++) { for (let b = 0; b < 4; b++) before[b] += pow[k][b]; cnt++; }
    const inc = Array.from(after, (v, b) => Math.max(0, v - (cnt ? before[b] / cnt : 0)));
    // Centroïde du spectre de l'attaque (trame du pic − trame d'avant).
    let num = 0, den = 0;
    const lin = (k: number, f: number) => Math.expm1(logm[f][k]) / 100;
    for (let k = 1; k <= N / 2; k++) {
      const d = lin(k, i) - (i > 0 ? lin(k, i - 1) : 0);
      if (d > 0) { num += d * d * k * binHz; den += d * d; }
    }
    // Une vraie attaque fait au moins doubler l'énergie d'une bande (la fin
    // brusque d'un son ou un craquement ne fait qu'éclabousser le spectre).
    const grows = after.some((v, b) => v > 2 * (cnt ? before[b] / cnt : 0));
    return { i, inc, grows, centroid: den > 0 ? num / den : 0 };
  });
  // Normalisation par bande sur toute la boucle (le plus fort de chaque bande = 1).
  const bandMax = [0, 1, 2, 3].map(b => Math.max(1e-12, ...raw.map(r => r.inc[b])));
  const kept = raw.filter(r => r.grows && r.inc.some((v, b) => v / bandMax[b] >= 0.04));
  // 1er passage : la famille de chaque coup (bande d'énergie et centroïde).
  const typed = kept.map(r => {
    const tot = r.inc.reduce((a, b) => a + b, 0) || 1e-12;
    const share = r.inc.map(v => v / tot) as [number, number, number, number];
    // Kick : l'énergie arrive sous ~600 Hz (sub, ou « punch » de 100-250 Hz quand le
    // sub est dans la 808), spectre sombre. Hat : surtout au-dessus de 6 kHz.
    // Snare / clap : le reste (bruit de 1 à 5 kHz, corps éventuel).
    let kind: DrumKind;
    if (share[0] >= 0.45 || (share[0] + share[1] >= 0.6 && share[2] < 0.12 && r.centroid < 1600)) kind = 'kick';
    else if (share[3] >= 0.55 || (r.centroid >= 5200 && share[3] >= share[2] * 0.6 && share[0] + share[1] < 0.3)) kind = 'hat';
    else kind = 'snare';
    return { r, share, kind };
  });
  // Niveau de référence de chaque famille : la médiane de ses coups (une snare
  // a souvent plus d'aigus qu'un hat ; un hat se compare donc aux autres hats).
  const refOf = (k: DrumKind, band: number) => {
    const v = typed.filter(t => t.kind === k).map(t => t.r.inc[band]);
    return v.length >= 2 ? median(v) : Math.max(1e-12, ...typed.map(t => t.r.inc[band]));
  };
  const hatRef = Math.max(1e-12, refOf('hat', 3)), snareRef = Math.max(1e-12, refOf('snare', 2));
  const hits: DrumHit[] = typed.map(({ r, share, kind }) => {
    const rel = r.inc.map((v, b) => v / bandMax[b]);
    const also: DrumKind[] = [];
    // Sur un kick, un autre son se lit dans les aigus (le kick n'y met presque rien) :
    // hat si l'aigu domine le médium aigu, snare / clap sinon.
    if (kind === 'kick' && r.inc[3] >= 0.35 * hatRef && r.inc[3] > 1.2 * r.inc[2]) also.push('hat');
    else if (kind === 'kick' && r.inc[2] >= 0.35 * snareRef && r.inc[2] >= 0.9 * r.inc[3]) also.push('snare');
    const main = kind === 'kick' ? 0 : kind === 'hat' ? 3 : 2;
    // Nuance : rapportée au coup le plus fort de la même famille.
    const famMax = Math.max(1e-12, ...typed.filter(t => t.kind === kind).map(t => t.r.inc[main]));
    const velocity = clamp(0.35 + 0.65 * Math.sqrt(r.inc[main] / famMax), 0.2, 1);
    const time = Math.max(0, refineOnset(x, sr, (r.i * hop) / sr, kind !== 'kick') - pad / sr);
    return { time, kind, ...(also.length ? { also } : {}), velocity, share, centroid: r.centroid, level: rel as [number, number, number, number] };
  });
  return hits;
}

/**
 * Instant précis de l'attaque (à ~1 ms) autour de `t` : premier échantillon
 * qui dépasse 40 % de la crête locale (sur la dérivée du signal pour un son
 * aigu, qui ressort ainsi au-dessus de la queue d'un kick).
 */
function refineOnset(x: Float32Array, sr: number, t: number, bright: boolean): number {
  const a = Math.max(1, Math.floor((t - 0.014) * sr)), b = Math.min(x.length - 1, Math.ceil((t + 0.025) * sr));
  const v = (i: number) => Math.abs(bright ? x[i] - x[i - 1] : x[i]);
  let peak = 0;
  for (let i = a; i <= b; i++) peak = Math.max(peak, v(i));
  if (peak <= 0) return t;
  for (let i = a; i <= b; i++) if (v(i) >= peak * 0.4) return i / sr;
  return t;
}

/** Nombre de mesures du motif (1, 2 ou 4) pour une boucle de cette durée. */
export function loopBars(durationSec: number, bpm: number, beatsPerBar = 4): 1 | 2 | 4 {
  const bars = durationSec / ((60 / Math.max(20, bpm)) * beatsPerBar);
  if (bars < 1.5) return 1;
  if (bars < 3) return 2;
  return 4;
}

export type DrumSteps = Record<DrumKind, number[]>;

/**
 * Attaques → pas de 16e (vélocité 0-127), à partir de `origin` (s, dans
 * l'audio : un premier temps de mesure), sur `bars` mesures.
 */
export function hitsToSteps(hits: DrumHit[], o: { bpm: number; origin?: number; bars: 1 | 2 | 4 }): DrumSteps {
  const step = 60 / Math.max(20, o.bpm) / 4;
  const len = 16 * o.bars;
  const out: DrumSteps = { kick: new Array(len).fill(0), snare: new Array(len).fill(0), hat: new Array(len).fill(0) };
  for (const h of hits) {
    const s = Math.round((h.time - (o.origin ?? 0)) / step);
    if (s < 0 || s >= len) continue;
    for (const k of [h.kind, ...(h.also || [])]) {
      const v = Math.round(h.velocity * 127 * (k === h.kind ? 1 : 0.85));
      out[k][s] = Math.max(out[k][s], v);
    }
  }
  return out;
}

/** Le motif de la boîte à rythmes devient celui de la boucle (kick, snare, hi-hat fermé ; le reste vidé). */
export function applyDrumSteps(dm: DrumMachine, steps: DrumSteps, bars: 1 | 2 | 4): DrumMachine {
  const len = 16 * bars;
  const rowFor: Record<string, DrumKind | undefined> = { kick: 'kick', snare: 'snare', hatc: 'hat' };
  const hasSnare = dm.rows.some(r => r.id === 'snare');
  if (!hasSnare) rowFor.clap = 'snare';
  const rows: DrumRow[] = dm.rows.map(r => {
    const k = rowFor[r.id];
    return { ...r, steps: k ? steps[k].slice(0, len) : new Array(len).fill(0), ratchet: new Array(len).fill(1) };
  });
  return { ...dm, bars, rows, song: undefined };
}

/** Attaques → notes General MIDI (36 / 38 / 42), temps relatifs à `origin` (s). */
export function hitsToGmNotes(hits: DrumHit[], origin = 0): MidiNote[] {
  const out: MidiNote[] = [];
  hits.forEach((h, i) => {
    for (const k of [h.kind, ...(h.also || [])]) {
      const t = h.time - origin;
      if (t < 0) continue;
      out.push({ id: `gm-${i}-${k}`, pitch: GM_NOTE[k], start: t, duration: 0.1, velocity: k === h.kind ? h.velocity : h.velocity * 0.85 });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Harmonie
// ---------------------------------------------------------------------------

/** Accords → notes MIDI (voix serrées, enchaînées au plus près ; basse en option). Temps relatifs à `origin`. */
export function chordsToNotes(chords: { start: number; end: number; root: number; quality: ChordQuality }[], o: { origin?: number; bass?: boolean; velocity?: number; center?: number } = {}): MidiNote[] {
  const out: MidiNote[] = [];
  let prev: number[] | undefined;
  chords.forEach((c, i) => {
    const upper = chordPitches(c.root, c.quality, { center: o.center ?? 60, prev });
    prev = upper;
    const all = o.bass ? chordPitches(c.root, c.quality, { center: o.center ?? 60, prev: upper, bass: true }).filter(p => !upper.includes(p)).concat(upper) : upper;
    const start = Math.max(0, c.start - (o.origin ?? 0));
    const dur = Math.max(0.05, c.end - c.start - 0.01);
    all.forEach((p, j) => out.push({ id: `ch-${i}-${j}`, pitch: p, start, duration: dur, velocity: o.velocity ?? 0.7 }));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Pistes créées
// ---------------------------------------------------------------------------

/** Début du clip : la mesure entière qui précède la 1re note (s, timeline). */
export function clipStartFor(firstNote: number, bpm: number, beatsPerBar = 4): number {
  const bar = (60 / Math.max(20, bpm)) * beatsPerBar;
  return Math.max(0, Math.floor((firstNote + 1e-6) / bar) * bar);
}

/** Durée du clip : jusqu'à la fin de la mesure de la dernière note. */
export function clipDurationFor(notes: { start: number; duration: number }[], bpm: number, beatsPerBar = 4): number {
  const bar = (60 / Math.max(20, bpm)) * beatsPerBar;
  const end = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  return Math.max(bar, Math.ceil((end - 1e-6) / bar) * bar);
}

export type MidiTrackKind = HumInstrument | 'keys' | 'gm-drums';

/**
 * Nouvelle piste MIDI avec son clip. `notes` : temps (s) relatifs au début du
 * clip. 808 : moteur 808 du DAW ; piano / lead / nappe / keys : synthé NOVA ;
 * gm-drums : piste MIDI simple (notes 36 / 38 / 42 pour un VST de batterie).
 */
export function buildMidiTrack(o: { id: string; clipId: string; name: string; kind: MidiTrackKind; start: number; duration: number; notes: MidiNote[] }): Track {
  const inst = o.kind === 'keys' ? null : o.kind === 'gm-drums' ? null : humInstrument(o.kind);
  const color = o.kind === 'keys' ? '#f59e0b' : o.kind === 'gm-drums' ? '#f97316' : inst!.color;
  const clip: Clip = {
    id: o.clipId, start: o.start, duration: o.duration, offset: 0, fadeIn: 0, fadeOut: 0, name: o.name, color,
    type: TrackType.MIDI, notes: o.notes, isMuted: false, gain: 1,
  };
  const track: Track = {
    id: o.id, name: o.name, type: TrackType.MIDI, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0, clips: [clip],
  };
  if (o.kind === '808') track.bass808 = { style: '808', glide: true };
  else if (o.kind === 'keys') track.novaSynth = presetSettings('keys-rnb');
  else if (inst?.presetId) track.novaSynth = presetSettings(inst.presetId);
  return track;
}
