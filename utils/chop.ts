import type { DrumMachine, DrumRow } from './drumKits';
import { addPattern, ensurePatterns, STEPS_PER_BAR } from './drumPatterns';
import { MAX_PADS, PadSampleInfo, userRef, userSampleId } from './drumSamples';

/**
 * V17 · Découper un sample sur des pads (comme Slicex / Fruity Slicer dans
 * FL Studio, ou Simpler en mode Slice dans Ableton).
 *
 * On découpe une boucle sur ses transitoires, sur la grille ou à la main ;
 * chaque tranche devient un pad (même sample, zone début / fin différente),
 * jouable dans le séquenceur et au clavier. Un motif « Découpe » rejoue les
 * tranches à leur place d'origine : on le réordonne ensuite à sa guise.
 *
 * Logique pure (testée dans tests/chop.test.ts).
 */

export type ChopMode = 'transients' | 'grid' | 'manual';
export const MAX_SLICES = 16;

const mono = (channels: Float32Array[]): Float32Array => {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  channels.forEach(c => { for (let i = 0; i < n; i++) out[i] += c[i] / channels.length; });
  return out;
};

/** Point de passage par zéro le plus proche (évite le clic au début d'une tranche). */
export function snapToZero(x: Float32Array, pos: number, radius = 96): number {
  const p = Math.max(1, Math.min(x.length - 1, Math.round(pos)));
  for (let d = 0; d <= radius; d++) {
    for (const i of [p - d, p + d]) {
      if (i < 1 || i >= x.length) continue;
      if ((x[i - 1] <= 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] <= 0)) return i;
    }
  }
  return p;
}

/**
 * Transitoires (attaques) d'un son : saut d'énergie des aigus d'une trame à la
 * suivante. `sensitivity` 0-1 (1 = trouve les attaques les plus faibles).
 * Renvoie des positions en échantillons, 0 compris.
 */
export function detectTransients(channels: Float32Array[], sampleRate: number, opts: { sensitivity?: number; minGapMs?: number; maxSlices?: number } = {}): number[] {
  const x = mono(channels);
  const sens = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5));
  const maxSlices = Math.max(1, Math.min(MAX_SLICES, opts.maxSlices ?? MAX_SLICES));
  const hop = Math.max(64, Math.round(sampleRate * 0.005));
  const win = hop * 2;
  const frames = Math.max(0, Math.floor((x.length - win) / hop));
  if (frames < 3) return [0];
  const L = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const s0 = f * hop;
    let e = 0;
    for (let i = s0 + 1; i < s0 + win; i++) { const d = x[i] - x[i - 1]; e += d * d + 0.25 * x[i] * x[i]; }
    e /= win;
    if (e > peak) peak = e;
    L[f] = Math.log10(1e-10 + e);
  }
  // Seuil de niveau : 10 dB (sensibilité 0) à 50 dB (sensibilité 1) sous la trame la plus forte.
  const gate = Math.log10(1e-10 + peak) - (1 + 4 * sens);
  const o = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const prev = Math.max(L[f - 1], f > 1 ? L[f - 2] : L[f - 1]);
    o[f] = L[f] > gate ? Math.max(0, L[f] - prev) : 0;
  }
  let mean = 0; for (let f = 0; f < frames; f++) mean += o[f]; mean /= frames;
  let sd = 0; for (let f = 0; f < frames; f++) sd += (o[f] - mean) ** 2; sd = Math.sqrt(sd / frames);
  const thr = Math.max(0.15, mean + (2.6 - 2.2 * sens) * sd);
  const minGap = Math.max(1, Math.round(((opts.minGapMs ?? 70) / 1000) * sampleRate / hop));
  const cands: { f: number; v: number }[] = [];
  for (let f = 1; f < frames; f++) {
    if (o[f] < thr) continue;
    let isMax = true;
    for (let k = Math.max(1, f - 3); k <= Math.min(frames - 1, f + 3); k++) if (o[k] > o[f]) { isMax = false; break; }
    if (isMax) cands.push({ f, v: o[f] });
  }
  // Les plus fortes d'abord, en respectant l'écart minimal.
  cands.sort((a, b) => b.v - a.v);
  const kept: number[] = [];
  for (const c of cands) {
    if (kept.every(k => Math.abs(k - c.f) >= minGap)) kept.push(c.f);
    if (kept.length >= maxSlices - 1) break;
  }
  const pts = kept.map(f => {
    // Début réel de l'attaque : premier échantillon au-dessus de 20 % du pic local, 2 ms avant.
    const a = Math.max(0, f * hop - hop), b = Math.min(x.length, f * hop + win * 2);
    let pk = 0; for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(x[i]));
    let i = a; while (i < b && Math.abs(x[i]) < pk * 0.2) i++;
    return snapToZero(x, Math.max(0, i - Math.round(sampleRate * 0.002)));
  });
  const minSamples = minGap * hop;
  return normalizePoints([0, ...pts], x.length).filter((p, i, arr) => i === 0 || p - arr[i - 1] >= minSamples * 0.5);
}

/** Découpe sur la grille : `perBar` tranches par mesure au tempo de la boucle. */
export function gridPoints(length: number, sampleRate: number, bpm: number, perBar: number, maxSlices = MAX_SLICES): number[] {
  const step = (240 / bpm / perBar) * sampleRate;
  const pts: number[] = [];
  for (let k = 0; k * step < length - step * 0.25 && pts.length < maxSlices; k++) pts.push(Math.round(k * step));
  return pts.length ? pts : [0];
}

/** N tranches égales. */
export const equalPoints = (length: number, n: number): number[] =>
  Array.from({ length: Math.max(1, Math.min(MAX_SLICES, n)) }, (_, k) => Math.round((k * length) / Math.max(1, Math.min(MAX_SLICES, n))));

/** Points triés, uniques, dans le son, 0 en tête. */
export function normalizePoints(points: number[], length: number): number[] {
  const s = Array.from(new Set(points.map(p => Math.max(0, Math.min(length - 1, Math.round(p)))))).sort((a, b) => a - b);
  if (s[0] !== 0) s.unshift(0);
  return s.slice(0, MAX_SLICES);
}

/** Points → tranches [début, fin[ en fraction du son (0-1). */
export function pointsToSlices(points: number[], length: number): { start: number; end: number }[] {
  const p = normalizePoints(points, length);
  return p.map((a, i) => ({ start: a / length, end: (i + 1 < p.length ? p[i + 1] : length) / length }));
}

/** Ajoute ou retire un repère à la main (tap sur la forme d'onde). */
export function toggleMarker(points: number[], at: number, length: number, tolerance: number): number[] {
  const near = points.findIndex(p => p !== 0 && Math.abs(p - at) <= tolerance);
  if (near >= 0) return points.filter((_, i) => i !== near);
  if (points.length >= MAX_SLICES) return points;
  return normalizePoints([...points, at], length);
}

/**
 * Tempo d'une boucle d'après sa durée : nombre entier de mesures (1, 2, 4, 8),
 * tempo le plus proche de celui du projet.
 */
export function estimateLoopBpm(durationSec: number, hintBpm = 120): { bpm: number; bars: number } {
  let best = { bpm: hintBpm, bars: 1, score: Infinity };
  for (const bars of [1, 2, 4, 8, 16]) {
    const bpm = (240 * bars) / durationSec;
    if (bpm < 55 || bpm > 210) continue;
    const score = Math.abs(Math.log2(bpm / hintBpm));
    if (score < best.score) best = { bpm, bars, score };
  }
  return { bpm: Math.round(best.bpm * 100) / 100, bars: best.bars };
}

export interface ChopOptions {
  /** Tempo du son posé sur les pads (après étirement éventuel). */
  bufferBpm: number;
  /** Durée de ce son (s). */
  duration: number;
  /** Les tranches se coupent entre elles (lecture mono, comme Simpler en Slice). */
  choke?: boolean;
  /** Remplacer les tranches d'une découpe précédente. */
  replace?: boolean;
  /** Créer le motif « Découpe » qui rejoue les tranches dans l'ordre. */
  makePattern?: boolean;
}

const CHOKE_SLICES = 9;

/** Pas (double-croche) où tombe une tranche, au tempo du son. */
export const stepOfSlice = (startFrac: number, opts: Pick<ChopOptions, 'bufferBpm' | 'duration'>) =>
  Math.round((startFrac * opts.duration) / (60 / opts.bufferBpm / 4));

/**
 * Pose les tranches sur des pads (+ motif « Découpe » à leur place d'origine).
 * Renvoie la batterie et les index des pads créés.
 */
export function chopIntoPads(dm: DrumMachine, sampleId: string, info: PadSampleInfo, slices: { start: number; end: number }[], opts: ChopOptions): { dm: DrumMachine; padIndexes: number[] } {
  let d = ensurePatterns(dm);
  if (opts.replace) {
    const old = new Set(d.rows.filter(r => r.slice).map(r => r.id));
    d = { ...d, rows: d.rows.filter(r => !old.has(r.id)) };
  }
  const room = Math.max(0, MAX_PADS - d.rows.length);
  const used = slices.slice(0, Math.min(room, MAX_SLICES));
  const ids = new Set(d.rows.map(r => r.id));
  const len = STEPS_PER_BAR * (d.bars || 1);
  const newRows: DrumRow[] = used.map((s, i) => {
    let id = `sl${sampleId.slice(-4)}-${i + 1}`;
    while (ids.has(id)) id += 'b';
    ids.add(id);
    return {
      id, name: `Tranche ${i + 1}`, sound: userRef(sampleId), slice: i + 1,
      start: s.start, end: s.end, steps: new Array(len).fill(0), ratchet: new Array(len).fill(1),
      volume: 0.85, pan: 0, ...(opts.choke !== false ? { choke: CHOKE_SLICES } : {}),
    };
  });
  const first = d.rows.length;
  d = { ...d, rows: [...d.rows, ...newRows], samples: { ...(d.samples || {}), [sampleId]: { name: info.name, duration: info.duration, ...(info.bpm ? { bpm: info.bpm } : {}) } } };
  // Samples d'anciennes tranches remplacées : oubliés s'ils ne servent plus.
  const usedSamples = new Set(d.rows.map(r => userSampleId(r.sound)).filter(Boolean) as string[]);
  d.samples = Object.fromEntries(Object.entries(d.samples!).filter(([id]) => usedSamples.has(id)));
  if (opts.makePattern !== false && newRows.length) {
    const totalSteps = Math.ceil(opts.duration / (60 / opts.bufferBpm / 4) - 0.25);
    const bars = totalSteps > 32 ? 4 : totalSteps > 16 ? 2 : 1;
    d = addPattern(d, { name: 'Découpe' });
    const L = STEPS_PER_BAR * bars;
    d = {
      ...d, bars,
      rows: d.rows.map(r => {
        const steps = new Array(L).fill(0);
        const k = newRows.findIndex(n => n.id === r.id);
        if (k >= 0) { const st = stepOfSlice(used[k].start, opts); if (st < L) steps[st] = 110; }
        return { ...r, steps, ratchet: new Array(L).fill(1) };
      }),
    };
  }
  return { dm: d, padIndexes: newRows.map((_, i) => first + i) };
}

/**
 * Rejoue les tranches dans un autre ordre : la place de la tranche k (dans le
 * motif affiché) joue désormais la tranche order[k]. Comme « Randomize » de Slicex.
 */
export function reorderSlices(dm: DrumMachine, order: number[]): DrumMachine {
  const slices = dm.rows.map((r, i) => ({ r, i })).filter(x => x.r.slice).sort((a, b) => a.r.slice! - b.r.slice!);
  if (!slices.length) return dm;
  const rows = dm.rows.map(r => ({ ...r, steps: [...r.steps], ratchet: [...r.ratchet] }));
  const before = slices.map(s => ({ steps: [...s.r.steps], ratchet: [...s.r.ratchet] }));
  slices.forEach(s => { rows[s.i].steps.fill(0); rows[s.i].ratchet.fill(1); });
  slices.forEach((_, k) => {
    const target = slices[order[k] ?? k];
    if (!target) return;
    before[k].steps.forEach((v, si) => {
      if (v > 0) { rows[target.i].steps[si] = v; rows[target.i].ratchet[si] = before[k].ratchet[si]; }
    });
  });
  return { ...dm, rows };
}

/** Ordre mélangé (reproductible avec la même graine). */
export function shuffledOrder(n: number, seed: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = (seed >>> 0) || 1;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  // Jamais identique à l'ordre d'origine si on peut l'éviter.
  if (n > 1 && a.every((v, i) => v === i)) [a[0], a[1]] = [a[1], a[0]];
  return a;
}
