import { Clip, TrackType } from '../types';
import type { DrumMachine, DrumRow } from './drumKits';

/**
 * V16 · Plusieurs motifs de batterie (comme les Patterns de FL Studio).
 *
 * Forme rétrocompatible de `drumMachine` :
 * - `rows[].steps` reste le motif AFFICHÉ (le motif actif). Une ancienne
 *   version de Nova lit ces pas et rejoue ce motif partout, comme avant ;
 * - `patterns` garde tous les motifs (A, B, C…), `activePattern` celui qu'on
 *   édite, `song` le motif de chaque mesure du morceau, `fill` la variation de
 *   fin de phrase et `groove` le groove (champs ignorés par une ancienne version).
 *
 * Toute la logique est pure (testée dans tests/drumPatterns.test.ts).
 */

export const STEPS_PER_BAR = 16;
export const MAX_PATTERNS = 12;

export interface DrumPattern {
  id: string;
  /** Nom affiché (« A », « Couplet »…). */
  name: string;
  color: string;
  bars: 1 | 2 | 4;
  /** Vélocité 0-127 par pas, par pad (clé = id du pad). */
  steps: Record<string, number[]>;
  /** Rolls par pas, par pad. */
  ratchet: Record<string, number[]>;
  /** R18 : panoramique et hauteur par pas, par pad (absents : 0). */
  pan?: Record<string, number[]>;
  pitch?: Record<string, number[]>;
}

// ===== R18 · Résolution et longueur par rangée (FL Studio, Bitwig, Live) =====

/** Résolution d'une rangée : 1/16, 1/32, triolets de croches (1/8 T) ou de doubles-croches (1/16 T). */
export type StepRate = '16' | '32' | '8t' | '16t';
export const STEP_RATES: { id: StepRate; label: string; perBar: number; hint: string }[] = [
  { id: '16', label: '1/16', perBar: 16, hint: 'Doubles-croches : la grille classique de FL Studio.' },
  { id: '32', label: '1/32', perBar: 32, hint: 'Triples-croches : hi-hats trap très rapides.' },
  { id: '16t', label: '1/16 T', perBar: 24, hint: 'Triolets de doubles-croches (rolls drill, comme la grille « triplet » de FL Studio et Live).' },
  { id: '8t', label: '1/8 T', perBar: 12, hint: 'Triolets de croches : sensation ternaire.' },
];
/** Pas par mesure d'une rangée. */
export const rowStepsPerBar = (r: { rate?: StepRate }): number => STEP_RATES.find(x => x.id === r.rate)?.perBar || STEPS_PER_BAR;
/** Nombre de pas d'une rangée dans un motif de `bars` mesures (sa longueur propre si elle en a une). */
export const rowLength = (r: { rate?: StepRate; len?: number }, bars: number): number =>
  r.len && r.len > 0 ? Math.max(1, Math.min(rowStepsPerBar(r) * 4, Math.round(r.len))) : rowStepsPerBar(r) * barsOf(bars);

export interface DrumFill {
  /** Toutes les 4 ou 8 mesures (0 = pas de fill). */
  every: 0 | 4 | 8;
  /** Motif joué en fill ; absent = variation automatique du motif en cours. */
  patternId?: string | null;
}

export const PATTERN_COLORS = ['#f97316', '#22d3ee', '#a78bfa', '#f43f5e', '#84cc16', '#eab308', '#ec4899', '#14b8a6'];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const fit = (a: number[] | undefined, len: number, fill: number): number[] => {
  const src = a && a.length ? a : null;
  return Array.from({ length: len }, (_, i) => (src ? (src[i] ?? src[i % src.length] ?? fill) : fill));
};

const barsOf = (b: number | undefined): 1 | 2 | 4 => (b === 4 ? 4 : b === 2 ? 2 : 1);

/** Pas et rolls des pads (motif affiché). */
export function captureRows(dm: DrumMachine): Pick<DrumPattern, 'steps' | 'ratchet' | 'pan' | 'pitch'> {
  const steps: Record<string, number[]> = {};
  const ratchet: Record<string, number[]> = {};
  const pan: Record<string, number[]> = {};
  const pitch: Record<string, number[]> = {};
  dm.rows.forEach(r => {
    const len = rowLength(r, dm.bars);
    steps[r.id] = fit(r.steps, len, 0); ratchet[r.id] = fit(r.ratchet, len, 1);
    if (r.stepPan?.some(v => v)) pan[r.id] = fit(r.stepPan, len, 0);
    if (r.stepPitch?.some(v => v)) pitch[r.id] = fit(r.stepPitch, len, 0);
  });
  // Champs absents quand rien n'est réglé : les projets d'avant R18 restent identiques.
  return { steps, ratchet, ...(Object.keys(pan).length ? { pan } : {}), ...(Object.keys(pitch).length ? { pitch } : {}) };
}

/** Projet d'avant la V16 : son motif unique devient le motif A. */
export function ensurePatterns(dm: DrumMachine): DrumMachine {
  if (dm.patterns && dm.patterns.length) {
    if (dm.activePattern && dm.patterns.some(p => p.id === dm.activePattern)) return dm;
    return { ...dm, activePattern: dm.patterns[0].id };
  }
  const a: DrumPattern = { id: 'A', name: 'A', color: PATTERN_COLORS[0], bars: barsOf(dm.bars), ...captureRows(dm) };
  return { ...dm, patterns: [a], activePattern: 'A' };
}

/** Le motif affiché (rows) est recopié dans la banque. */
export function commitActive(dm: DrumMachine): DrumMachine {
  const d = ensurePatterns(dm);
  return {
    ...d,
    patterns: d.patterns!.map(p => {
      if (p.id !== d.activePattern) return p;
      const { pan: _p, pitch: _h, ...rest } = p;
      return { ...rest, bars: barsOf(d.bars), ...captureRows(d) };
    }),
  };
}

/** Charge un motif dans la grille (le motif quitté est gardé tel quel). */
export function selectPattern(dm: DrumMachine, id: string): DrumMachine {
  return loadPattern(commitActive(dm), id);
}

/** Affiche un motif de la banque dans la grille (sans recopier la grille dans la banque). */
function loadPattern(d: DrumMachine, id: string): DrumMachine {
  const p = d.patterns!.find(x => x.id === id);
  if (!p) return d;
  return {
    ...d, activePattern: p.id, bars: p.bars,
    rows: d.rows.map(r => {
      const len = rowLength(r, p.bars);
      const { stepPan: _sp, stepPitch: _sh, ...base } = r;
      return {
        ...base, steps: fit(p.steps[r.id], len, 0), ratchet: fit(p.ratchet[r.id], len, 1),
        ...(p.pan?.[r.id] ? { stepPan: fit(p.pan[r.id], len, 0) } : {}),
        ...(p.pitch?.[r.id] ? { stepPitch: fit(p.pitch[r.id], len, 0) } : {}),
      };
    }),
  };
}

/** Prochaine lettre libre (A, B, C…). */
export function nextPatternName(dm: DrumMachine): string {
  const used = new Set((dm.patterns || []).map(p => p.name));
  for (const l of LETTERS) if (!used.has(l)) return l;
  return `M${(dm.patterns || []).length + 1}`;
}

let seq = 0;
const newId = (dm: DrumMachine) => {
  const ids = new Set((dm.patterns || []).map(p => p.id));
  let id = '';
  do { id = `p${Date.now().toString(36)}${(seq++).toString(36)}`; } while (ids.has(id));
  return id;
};

/** Nouveau motif (vide, ou copie d'un motif : « dupliquer »), aussitôt affiché. */
export function addPattern(dm: DrumMachine, opts: { copyFrom?: string; name?: string } = {}): DrumMachine {
  const d = commitActive(dm);
  if (d.patterns!.length >= MAX_PATTERNS) return d;
  const src = opts.copyFrom ? d.patterns!.find(p => p.id === opts.copyFrom) : undefined;
  const bars = src ? src.bars : barsOf(d.bars);
  const steps: Record<string, number[]> = {};
  const ratchet: Record<string, number[]> = {};
  const pan: Record<string, number[]> = {};
  const pitch: Record<string, number[]> = {};
  d.rows.forEach(r => {
    const len = rowLength(r, bars);
    steps[r.id] = src ? fit(src.steps[r.id], len, 0) : new Array(len).fill(0);
    ratchet[r.id] = src ? fit(src.ratchet[r.id], len, 1) : new Array(len).fill(1);
    if (src?.pan?.[r.id]) pan[r.id] = fit(src.pan[r.id], len, 0);
    if (src?.pitch?.[r.id]) pitch[r.id] = fit(src.pitch[r.id], len, 0);
  });
  const p: DrumPattern = {
    id: newId(d), name: opts.name || nextPatternName(d),
    color: PATTERN_COLORS[d.patterns!.length % PATTERN_COLORS.length], bars, steps, ratchet,
    ...(Object.keys(pan).length ? { pan } : {}), ...(Object.keys(pitch).length ? { pitch } : {}),
  };
  // Comme dans FL Studio, créer un motif ne change pas ce que joue le morceau :
  // sans placement, l'ancien motif reste partout (un placement d'une seule
  // mesure vaut pour tout le morceau).
  const song = d.song && d.song.length ? d.song : [d.activePattern!];
  return selectPattern({ ...d, song, patterns: [...d.patterns!, p] }, p.id);
}

export const duplicatePattern = (dm: DrumMachine, id: string) => addPattern(dm, { copyFrom: id });

export function renamePattern(dm: DrumMachine, id: string, name: string): DrumMachine {
  const n = name.trim().slice(0, 24);
  if (!n) return dm;
  const d = ensurePatterns(dm);
  return { ...d, patterns: d.patterns!.map(p => (p.id === id ? { ...p, name: n } : p)) };
}

export function recolorPattern(dm: DrumMachine, id: string, color: string): DrumMachine {
  const d = ensurePatterns(dm);
  return { ...d, patterns: d.patterns!.map(p => (p.id === id ? { ...p, color } : p)) };
}

/** Supprime un motif (jamais le dernier) ; ses mesures passent au premier motif restant. */
export function deletePattern(dm: DrumMachine, id: string): DrumMachine {
  let d = commitActive(dm);
  if (d.patterns!.length <= 1 || !d.patterns!.some(p => p.id === id)) return d;
  const rest = d.patterns!.filter(p => p.id !== id);
  d = {
    ...d, patterns: rest,
    song: d.song ? d.song.map(x => (x === id ? rest[0].id : x)) : d.song,
    fill: d.fill && d.fill.patternId === id ? { ...d.fill, patternId: null } : d.fill,
  };
  return d.activePattern === id ? selectPattern({ ...d, activePattern: rest[0].id }, rest[0].id) : d;
}

/** Pas d'un motif pour un pad (le motif affiché se lit dans `rows`). */
interface PatternData {
  bars: number;
  steps: (r: DrumRow) => number[];
  ratchet: (r: DrumRow) => number[];
  pan: (r: DrumRow) => number[] | undefined;
  pitch: (r: DrumRow) => number[] | undefined;
}
function patternData(dm: DrumMachine, patternId: string | undefined): PatternData | null {
  if (patternId === '') return null;
  const activeId = dm.activePattern || dm.patterns?.[0]?.id;
  if (!dm.patterns?.length || !patternId || patternId === activeId) {
    return { bars: barsOf(dm.bars), steps: r => r.steps, ratchet: r => r.ratchet, pan: r => r.stepPan, pitch: r => r.stepPitch };
  }
  const p = dm.patterns!.find(x => x.id === patternId);
  if (!p) return null;
  return { bars: p.bars, steps: r => p.steps[r.id] || [], ratchet: r => p.ratchet[r.id] || [], pan: r => p.pan?.[r.id], pitch: r => p.pitch?.[r.id] };
}

// ===== Placement dans le morceau (comme la Playlist de FL Studio) =====

/** Motif de chaque mesure, sur `totalBars` mesures (absent = le motif actif partout). */
export function songBars(dm: DrumMachine, totalBars: number): string[] {
  const d = ensurePatterns(dm);
  const def = d.activePattern!;
  if (!d.song || !d.song.length) return new Array(totalBars).fill(def);
  const last = d.song[d.song.length - 1];
  return Array.from({ length: totalBars }, (_, i) => (i < d.song!.length ? d.song![i] : last));
}

/** Place un motif sur des mesures (fin exclue) ; '' = silence. */
export function placePattern(dm: DrumMachine, patternId: string, fromBar: number, toBar: number, totalBars: number): DrumMachine {
  const d = ensurePatterns(dm);
  const n = Math.max(totalBars, toBar);
  const song = songBars(d, n);
  for (let b = Math.max(0, fromBar); b < toBar; b++) song[b] = patternId;
  return { ...d, song };
}

/** Sections du morceau (couplet, refrain…) → motifs : les parties les plus pleines prennent `fullId`. */
export function songFromSections(
  dm: DrumMachine,
  sections: { start: number; end: number; full?: boolean; kind?: string }[],
  bpm: number, totalBars: number, ids: { base: string; full: string; intro?: string },
): DrumMachine {
  const bar = 240 / bpm;
  const d = ensurePatterns(dm);
  const song = songBars(d, totalBars).map(() => ids.base);
  sections.forEach(s => {
    const a = Math.max(0, Math.round(s.start / bar));
    const b = Math.min(totalBars, Math.round(s.end / bar));
    const id = s.full ? ids.full : (s.kind === 'intro' || s.kind === 'outro') && ids.intro !== undefined ? ids.intro : ids.base;
    for (let k = a; k < b; k++) song[k] = id;
  });
  return { ...d, song };
}

/** Fin de la batterie : la boucle du morceau, ou plus loin si des motifs y sont placés. */
export function drumSongEnd(dm: DrumMachine, bpm: number, loopEnd: number): number {
  return Math.max(loopEnd, (dm.song?.length || 0) * (240 / bpm));
}

/** Régions du morceau (repères Intro, Partie, Refrain…) → sections pour `songFromSections`. */
export function sectionsFromMarkers(markers: { type?: string; name: string; time: number; endTime?: number; color?: string }[]) {
  return markers
    .filter(m => m.type === 'REGION' && typeof m.endTime === 'number' && m.endTime > m.time)
    .map(m => ({
      start: m.time, end: m.endTime!, name: m.name,
      full: (m.color || '').toLowerCase() === '#f472b6' || /refrain|chorus|hook|drop/i.test(m.name),
      kind: /intro/i.test(m.name) ? 'intro' : /outro/i.test(m.name) ? 'outro' : 'part',
    }));
}

export interface BarPlan {
  /** Motif placé sur la mesure ('' = silence). */
  patternId: string;
  /** Mesure du motif à jouer (0 … bars-1). */
  barInPattern: number;
  /** Fin de phrase : variation (fill). */
  fill: boolean;
}

/** Ce qui joue à chaque mesure : motif, mesure du motif, fill. */
export function planBars(dm: DrumMachine, totalBars: number): BarPlan[] {
  const d = ensurePatterns(dm);
  const song = songBars(d, totalBars);
  const every = d.fill?.every || 0;
  let runStart = 0;
  return song.map((id, b) => {
    if (b > 0 && song[b - 1] !== id) runStart = b;
    const pat = patternData(d, id);
    const barInPattern = pat ? (b - runStart) % pat.bars : 0;
    const fill = !!id && every > 0 && b % every === every - 1;
    return { patternId: id, barInPattern, fill };
  });
}

/**
 * Variation automatique de fin de phrase : roulement de caisse claire sur le
 * dernier temps (crescendo), charleston doublé, kick retiré du dernier temps.
 */
export function autoFillBar(rows: { id: string; steps: number[]; ratchet: number[] }[]): { id: string; steps: number[]; ratchet: number[] }[] {
  const out = rows.map(r => ({ id: r.id, steps: [...r.steps], ratchet: [...r.ratchet] }));
  const hits = (r: { steps: number[] }) => r.steps.some(v => v > 0);
  const roll = out.find(r => r.id === 'snare' && hits(r)) || out.find(r => r.id === 'clap' && hits(r))
    || out.find(r => r.id === 'snare') || out.find(r => r.id !== 'kick' && hits(r));
  const vel = [72, 88, 104, 122];
  if (roll) for (let i = 0; i < 4; i++) { roll.steps[12 + i] = vel[i]; roll.ratchet[12 + i] = i === 3 ? 2 : 1; }
  const kick = out.find(r => r.id === 'kick');
  if (kick) for (let i = 13; i < 16; i++) { kick.steps[i] = 0; kick.ratchet[i] = 1; }
  const hat = out.find(r => r.id === 'hatc');
  if (hat) for (let i = 12; i < 16; i++) if (hat.steps[i] > 0) hat.ratchet[i] = Math.max(2, hat.ratchet[i] || 1);
  return out;
}

// ===== Groove (comme le Groove Pool d'Ableton / le swing de FL Studio) =====

export interface GrooveDef {
  id: string;
  name: string;
  hint: string;
  /** Décalage de chaque double-croche, en fraction de pas (+ = en retard). */
  timing: number[];
  /** Multiplicateur de vélocité de chaque double-croche. */
  velocity: number[];
}

const rep = (four: number[]) => [...four, ...four, ...four, ...four];

export const GROOVES: GrooveDef[] = [
  { id: 'none', name: 'Droit', hint: 'Sans groove : tout tombe pile sur la grille.', timing: rep([0, 0, 0, 0]), velocity: rep([1, 1, 1, 1]) },
  { id: 'mpc', name: 'MPC 16e', hint: 'Swing de double-croches façon MPC 60 (66 %), comme les grooves « MPC » du Groove Pool d\'Ableton.', timing: rep([0, 0.33, 0, 0.33]), velocity: rep([1, 0.78, 0.92, 0.78]) },
  { id: 'shuffle', name: 'Shuffle', hint: 'Croches ternaires (sensation triolet), boom bap et R&B.', timing: rep([0, 0.25, 0.67, 0.5]), velocity: rep([1, 0.7, 0.86, 0.7]) },
  { id: 'laidback', name: 'En arrière', hint: 'Caisse claire et contretemps un peu en retard : groove posé, façon Dilla.', timing: [0, 0.1, 0.05, 0.12, 0.14, 0.1, 0.05, 0.12, 0, 0.1, 0.05, 0.12, 0.14, 0.1, 0.05, 0.12], velocity: rep([1, 0.8, 0.9, 0.8]) },
  { id: 'push', name: 'En avant', hint: 'Contretemps légèrement en avance : drill, afro, énergie qui pousse.', timing: rep([0, -0.08, -0.04, -0.1]), velocity: rep([1, 0.85, 0.95, 0.88]) },
  { id: 'human', name: 'Humain', hint: 'Petites imperfections de timing et de force, comme un batteur (toujours les mêmes : rien ne change à chaque lecture).', timing: [0, 0.05, -0.03, 0.07, 0.02, -0.04, 0.06, 0.03, -0.02, 0.06, 0.01, -0.05, 0.04, 0.02, -0.03, 0.06], velocity: [1, 0.86, 0.95, 0.82, 0.97, 0.88, 0.93, 0.8, 0.99, 0.84, 0.94, 0.86, 0.96, 0.83, 0.9, 0.87] },
];

export const grooveOf = (id?: string) => GROOVES.find(g => g.id === id) || GROOVES[0];

// ===== Rendu : un clip MIDI par suite de mesures d'un même motif =====

type Note = { id: string; pitch: number; start: number; duration: number; velocity: number; pan?: number; tune?: number };

/** Une rangée sur une mesure : pas, rolls, pan et hauteur (dans la résolution de la rangée). */
interface BarRow { id: string; steps: number[]; ratchet: number[]; pan?: number[]; pitch?: number[] }

/**
 * Clips de la batterie de 0 à `end` (s) : un clip par motif placé (couleur et
 * nom du motif), avec swing, groove, rolls et fills. R18 : chaque rangée a sa
 * résolution (1/16, 1/32, triolets), sa longueur (polymétrie), son swing, et
 * chaque pas sa vélocité, son panoramique et sa hauteur (Graph Editor de FL).
 */
export function drumSongClips(dm: DrumMachine, bpm: number, end: number, idBase: string): Clip[] {
  const d = ensurePatterns(dm);
  const stepDur = 60 / bpm / 4;
  const minLen = STEPS_PER_BAR * barsOf(d.bars) * stepDur;
  const nSteps = Math.floor(Math.max(minLen, end) / stepDur + 1e-6);
  const totalBars = Math.ceil(nSteps / STEPS_PER_BAR);
  const plan = planBars(d, totalBars);
  const groove = grooveOf(d.groove);
  const gAmt = Math.max(0, Math.min(1, d.grooveAmount ?? 1));
  const fillPat = d.fill?.patternId ? patternData(d, d.fill.patternId) : null;

  const clips: Clip[] = [];
  let cur: { id: string; startStep: number; notes: (Note & { o: number; ri: number; k: number })[]; endStep: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const p = d.patterns!.find(x => x.id === cur!.id);
    // Ordre du temps (les rangées en 1/32 ou en triolets s'intercalent).
    // Ordre d'avant R18 : pas, puis rangée, puis roll (les pas en 1/32 ou en triolets s'intercalent).
    const notes = cur.notes.sort((x, y) => x.o - y.o || x.ri - y.ri || x.k - y.k).map(({ o: _o, ri: _r, k: _k, ...n }) => n);
    clips.push({
      id: `${idBase}-${clips.length}`, name: p ? `Motif ${p.name}` : 'Batterie', type: TrackType.MIDI,
      start: cur.startStep * stepDur, duration: (cur.endStep - cur.startStep) * stepDur, offset: 0,
      fadeIn: 0, fadeOut: 0, color: p?.color || '#f97316', notes,
    } as unknown as Clip);
    cur = null;
  };

  for (let b = 0; b < totalBars; b++) {
    const pl = plan[b];
    if (!cur || cur.id !== pl.patternId) { flush(); if (pl.patternId) cur = { id: pl.patternId, startStep: b * STEPS_PER_BAR, notes: [], endStep: b * STEPS_PER_BAR }; }
    if (!cur) continue;
    const pat = patternData(d, pl.patternId);
    const lastStep = Math.min(nSteps, (b + 1) * STEPS_PER_BAR);
    cur.endStep = lastStep;
    if (!pat) continue;
    const src = pl.fill && fillPat ? fillPat : pat;
    const barIdx = pl.fill && fillPat ? fillPat.bars - 1 : pl.barInPattern;
    // Mesures écoulées depuis le début du motif (rangées à longueur propre).
    const runBars = b - cur.startStep / STEPS_PER_BAR;
    // Pas de la mesure, dans la résolution de chaque rangée (fill compris).
    let bar: BarRow[] = d.rows.map(r => {
      const spb = rowStepsPerBar(r);
      const s = src.steps(r), k = src.ratchet(r), pn = src.pan(r), ph = src.pitch(r);
      const len = r.len && r.len > 0 ? rowLength(r, src.bars) : 0;
      const at = (i: number) => (len ? (runBars * spb + i) % len : barIdx * spb + i);
      const pick = (a: number[] | undefined, i: number, dflt: number) => (a ? a[at(i)] ?? a[i] ?? dflt : dflt);
      return {
        id: r.id,
        steps: Array.from({ length: spb }, (_, i) => pick(s, i, 0)),
        ratchet: Array.from({ length: spb }, (_, i) => pick(k, i, 1)),
        ...(pn ? { pan: Array.from({ length: spb }, (_, i) => pick(pn, i, 0)) } : {}),
        ...(ph ? { pitch: Array.from({ length: spb }, (_, i) => pick(ph, i, 0)) } : {}),
      };
    });
    if (pl.fill && !fillPat) {
      // Variation automatique : seulement sur les rangées en 1/16 sans longueur propre.
      const plain = (ri: number) => rowStepsPerBar(d.rows[ri]) === STEPS_PER_BAR && !((d.rows[ri].len || 0) > 0);
      const filled = autoFillBar(bar.filter((_, ri) => plain(ri)));
      bar = bar.map((x, ri) => (plain(ri) ? { ...x, ...filled.find(f => f.id === x.id)! } : x));
    }
    const barT = (b * STEPS_PER_BAR - cur.startStep) * stepDur;
    bar.forEach((r, ri) => {
      const row = d.rows[ri];
      const spb = r.steps.length;
      const cell = STEPS_PER_BAR / spb; // durée d'un pas de la rangée, en doubles-croches
      const triplet = spb % 3 === 0;
      const sw = typeof row.swing === 'number' ? Math.max(0, Math.min(0.6, row.swing)) : d.swing;
      for (let i = 0; i < spb; i++) {
        const v = r.steps[i] || 0;
        if (v <= 0) continue;
        const pos16 = i * cell;
        if (b * STEPS_PER_BAR + pos16 >= lastStep - 1e-9) break;
        const i16 = Math.floor(pos16 + 1e-9) % STEPS_PER_BAR;
        // Swing et groove sur les grilles binaires (les triolets sont déjà « swingués »).
        const swing = !triplet && i16 % 2 === 1 ? sw * stepDur * 0.5 : 0;
        const shift = triplet ? 0 : groove.timing[i16] * gAmt * stepDur;
        const vMul = 1 + (groove.velocity[i16] - 1) * gAmt;
        const n = Math.max(1, Math.min(8, r.ratchet[i] || 1));
        const cellDur = cell * stepDur;
        const pan = r.pan ? Math.max(-1, Math.min(1, r.pan[i] || 0)) : 0;
        const tune = r.pitch ? Math.max(-24, Math.min(24, r.pitch[i] || 0)) : 0;
        for (let k = 0; k < n; k++) {
          const t = Math.max(0, barT + pos16 * stepDur + swing + shift + (k * cellDur) / n);
          const s16 = b * STEPS_PER_BAR + i16;
          cur!.notes.push({
            id: spb === STEPS_PER_BAR ? `d${s16}-${ri}-${k}` : `d${b}_${i}r${spb}-${ri}-${k}`,
            pitch: 60 + ri, start: t, duration: Math.min(0.1, cellDur / n),
            velocity: Math.min(1, (v / 127) * vMul * (k === 0 ? 1 : 0.8)),
            ...(pan ? { pan } : {}), ...(tune ? { tune } : {}),
            o: b * STEPS_PER_BAR + pos16, ri, k,
          });
        }
      }
    });
  }
  flush();
  return clips;
}

/** Empreinte du rythme : le clip n'est régénéré que si elle change. */
export function drumRhythmSig(dm: DrumMachine): string {
  const d = commitActive(dm);
  return JSON.stringify([
    d.bars, d.swing, d.groove || 'none', d.grooveAmount ?? 1, d.song || null, d.fill || null, d.activePattern,
    d.rows.map(r => [r.id, r.steps, r.ratchet, r.stepPan || 0, r.stepPitch || 0, r.rate || 0, r.len || 0, r.swing ?? null]),
    d.patterns!.map(p => [p.id, p.bars, p.steps, p.ratchet, p.pan || 0, p.pitch || 0]),
  ]);
}

/** Motif et mesure qui jouent à un instant (pour la tête de lecture du panneau). */
export function whereAt(dm: DrumMachine, bpm: number, t: number): { bar: number; patternId: string; step: number; pos16: number; runBars: number } | null {
  if (t < 0) return null;
  const stepDur = 60 / bpm / 4;
  const exact = t / stepDur;
  const abs = Math.floor(exact + 1e-9);
  const bar = Math.floor(abs / STEPS_PER_BAR);
  const plans = planBars(dm, bar + 1);
  const plan = plans[bar];
  let run = bar;
  while (run > 0 && plans[run - 1].patternId === plan.patternId) run--;
  const inBar = exact - bar * STEPS_PER_BAR;
  return {
    bar, patternId: plan.patternId, step: plan.barInPattern * STEPS_PER_BAR + (abs % STEPS_PER_BAR),
    pos16: plan.barInPattern * STEPS_PER_BAR + inBar, runBars: bar - run + inBar / STEPS_PER_BAR,
  };
}

/** Pas d'une rangée qui joue (tête de lecture du panneau), d'après `whereAt`. */
export function rowStepAt(r: Pick<DrumRow, 'rate' | 'len'>, w: { pos16: number; runBars: number }, bars: number): number {
  const spb = rowStepsPerBar(r);
  if (r.len && r.len > 0) return Math.floor(w.runBars * spb + 1e-9) % rowLength(r, bars);
  return Math.floor((w.pos16 * spb) / STEPS_PER_BAR + 1e-9);
}

/** Change la résolution d'une rangée : ses pas sont recalés sur la nouvelle grille, dans tous les motifs. */
export function setRowRate(dm: DrumMachine, rowIndex: number, rate: StepRate): DrumMachine {
  const d = commitActive(dm);
  const row = d.rows[rowIndex];
  if (!row || (row.rate || '16') === rate) return d;
  const from = rowStepsPerBar(row), to = rowStepsPerBar({ rate });
  /** Recale un tableau de `from` pas par mesure sur `to` pas par mesure (chaque valeur au pas le plus proche). */
  const conv = (a: number[], bars: number, dflt: number, keep: (i: number) => boolean): number[] => {
    const n = to * bars;
    const out = new Array(n).fill(dflt);
    a.forEach((v, i) => {
      if (!keep(i)) return;
      const j = Math.min(n - 1, Math.round((i * to) / from));
      out[j] = v;
    });
    return out;
  };
  const patterns = d.patterns!.map(p => {
    const bars = p.bars;
    const st = fit(p.steps[row.id], from * bars, 0);
    const hit = (i: number) => st[i] > 0;
    const ext = (a: number[] | undefined, dflt: number) => (a ? conv(fit(a, from * bars, dflt), bars, dflt, hit) : undefined);
    const pan = ext(p.pan?.[row.id], 0);
    const pitch = ext(p.pitch?.[row.id], 0);
    return {
      ...p,
      steps: { ...p.steps, [row.id]: conv(st, bars, 0, hit) },
      ratchet: { ...p.ratchet, [row.id]: conv(fit(p.ratchet[row.id], from * bars, 1), bars, 1, hit) },
      ...(pan ? { pan: { ...(p.pan || {}), [row.id]: pan } } : {}),
      ...(pitch ? { pitch: { ...(p.pitch || {}), [row.id]: pitch } } : {}),
    };
  });
  const rows = d.rows.map((r, i) => (i === rowIndex ? { ...r, rate: rate === '16' ? undefined : rate, len: undefined } : r));
  return loadPattern({ ...d, rows, patterns }, d.activePattern!);
}

/** Longueur propre d'une rangée (polymétrie, comme les longueurs de rangée de Bitwig / FL) ; 0 = le motif entier. */
export function setRowLength(dm: DrumMachine, rowIndex: number, len: number): DrumMachine {
  const d = commitActive(dm);
  const row = d.rows[rowIndex];
  if (!row) return d;
  const spb = rowStepsPerBar(row);
  const n = len > 0 ? Math.max(1, Math.min(spb * 4, Math.round(len))) : 0;
  const rows = d.rows.map((r, i) => (i === rowIndex ? { ...r, len: n || undefined } : r));
  const patterns = d.patterns!.map(p => {
    const L = n || spb * p.bars;
    const cut = (a: number[] | undefined, dflt: number) => Array.from({ length: L }, (_, i) => (a || [])[i] ?? dflt);
    return {
      ...p,
      steps: { ...p.steps, [row.id]: cut(p.steps[row.id], 0) },
      ratchet: { ...p.ratchet, [row.id]: cut(p.ratchet[row.id], 1) },
      ...(p.pan?.[row.id] ? { pan: { ...p.pan, [row.id]: cut(p.pan[row.id], 0) } } : {}),
      ...(p.pitch?.[row.id] ? { pitch: { ...p.pitch, [row.id]: cut(p.pitch[row.id], 0) } } : {}),
    };
  });
  return loadPattern({ ...d, rows, patterns }, d.activePattern!);
}

/** Valeur d'un pas dans l'éditeur de graphe (vélocité 1-127, pan -1…1, hauteur -12…+12). */
export type StepParam = 'vel' | 'pan' | 'pitch';
export function setStepParam(dm: DrumMachine, rowIndex: number, step: number, param: StepParam, value: number): DrumMachine {
  const row = dm.rows[rowIndex];
  if (!row || step < 0 || step >= row.steps.length) return dm;
  const r = { ...row };
  if (param === 'vel') {
    if (!(r.steps[step] > 0)) return dm; // un pas éteint n'a pas de vélocité
    r.steps = [...r.steps]; r.steps[step] = Math.max(1, Math.min(127, Math.round(value)));
  } else if (param === 'pan') {
    const a = r.stepPan ? [...r.stepPan] : new Array(r.steps.length).fill(0);
    a[step] = Math.max(-1, Math.min(1, Math.round(value * 100) / 100));
    r.stepPan = a.some(v => v) ? a : undefined;
  } else {
    const a = r.stepPitch ? [...r.stepPitch] : new Array(r.steps.length).fill(0);
    a[step] = Math.max(-12, Math.min(12, Math.round(value)));
    r.stepPitch = a.some(v => v) ? a : undefined;
  }
  return { ...dm, rows: dm.rows.map((x, i) => (i === rowIndex ? r : x)) };
}
