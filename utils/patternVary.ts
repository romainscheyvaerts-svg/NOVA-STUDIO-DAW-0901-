/**
 * Lot 10 · « Prolonger » et « Varier » un clip MIDI, par des RÈGLES musicales (aucune IA) :
 *
 *  - inversion : renversement mélodique autour d'un axe (mélodie) ou renversement d'accord
 *    (la note grave monte d'une octave) quand le clip joue des accords ;
 *  - déplacement : décalage rythmique (double-croche, croche ou temps), les notes qui sortent
 *    du clip reviennent au début (le motif tourne sur lui-même) ;
 *  - rythme : variation rythmique (notes longues coupées en répétitions, syncopes d'une
 *    double-croche, petites liaisons), tirée au hasard mais reproductible (graine) ;
 *  - transposition : la mélodie monte ou descend de degrés DANS la gamme (transposition diatonique).
 *
 * Chaque note produite est dans la gamme du projet ou dans l'accord joué à cet instant (piste
 * d'accords) : `snapNote` la ramène sinon à la note permise la plus proche.
 * Données pures (aucun React) : tests/patternVary.test.ts.
 */
import type { MidiNote } from '../types';
import { chordAt, chordTones, type ChordEvent } from './chordDetect';
import { scaleIntervals } from './scales';

export type VaryRule = 'inversion' | 'deplacement' | 'rythme' | 'transposition';

export const VARY_RULES: { id: VaryRule; label: string; hint: string }[] = [
  { id: 'rythme', label: 'Rythme', hint: 'Même notes, autre rythme : notes longues répétées, syncopes, liaisons.' },
  { id: 'inversion', label: 'Inversion', hint: 'La mélodie à l’envers (ce qui montait descend). Sur des accords : renversements.' },
  { id: 'deplacement', label: 'Déplacement', hint: 'Le motif décalé d’une double-croche, d’une croche ou d’un temps.' },
  { id: 'transposition', label: 'Transposition', hint: 'La mélodie monte ou descend dans la gamme (les notes restent dans le ton).' },
];
export const varyRuleOf = (id: string | undefined | null): VaryRule | null =>
  (VARY_RULES.find(r => r.id === id)?.id) ?? null;

export interface VaryContext {
  bpm: number;
  /** Tonique du projet (0-11), null = inconnue (on ne garde alors que les notes des accords, s'il y en a). */
  root: number | null;
  scale?: string;
  /** Piste d'accords du projet (temps du morceau, en s). */
  chords?: ChordEvent[];
  /** Début du clip dans le morceau (s) : pour lire l'accord joué sous chaque note. */
  clipStart?: number;
  seed?: number;
}

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;
const EPS = 1e-4;

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idSeq = 0;
const newId = (p = 'nv') => `${p}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/** Classes de notes permises à l'instant t (s, temps du clip) : gamme ∪ accord en cours. */
export function allowedPcs(tClip: number, ctx: VaryContext): Set<number> {
  const s = new Set<number>();
  if (ctx.root !== null && ctx.root !== undefined) scaleIntervals(ctx.scale).forEach(i => s.add(pc(ctx.root! + i)));
  const ch = ctx.chords?.length ? chordAt(ctx.chords, (ctx.clipStart || 0) + tClip + EPS) : null;
  if (ch) chordTones(ch.root, ch.quality).forEach(x => s.add(x));
  if (!s.size) for (let i = 0; i < 12; i++) s.add(i);
  return s;
}

export const isAllowed = (pitch: number, tClip: number, ctx: VaryContext) => allowedPcs(tClip, ctx).has(pc(pitch));

/** Note permise la plus proche (à égale distance : vers le bas, comme l'aimant de gamme). */
export function snapNote(pitch: number, tClip: number, ctx: VaryContext): number {
  const ok = allowedPcs(tClip, ctx);
  const p = Math.round(pitch);
  for (let d = 0; d <= 6; d++) {
    if (ok.has(pc(p - d))) return clampPitch(p - d);
    if (ok.has(pc(p + d))) return clampPitch(p + d);
  }
  return clampPitch(p);
}
const clampPitch = (p: number) => Math.max(0, Math.min(127, p));

/** Monte / descend de `deg` degrés dans la gamme (chromatique si la tonique est inconnue). */
export function stepInScale(pitch: number, deg: number, root: number | null, scale?: string): number {
  if (root === null || root === undefined) return clampPitch(pitch + deg);
  const iv = scaleIntervals(scale);
  const pcs = new Set(iv.map(i => pc(root + i)));
  let p = Math.round(pitch);
  if (!pcs.has(pc(p))) { let d = 0; while (d < 12 && !pcs.has(pc(p - d))) d++; p -= d; }
  const dir = deg >= 0 ? 1 : -1;
  for (let k = 0; k < Math.abs(deg); k++) { do { p += dir; } while (!pcs.has(pc(p))); }
  return clampPitch(p);
}

/** Le clip joue-t-il surtout des accords (notes qui démarrent ensemble) ? */
export function isChordal(notes: MidiNote[]): boolean {
  if (notes.length < 3) return false;
  const starts = new Map<number, number>();
  notes.forEach(n => { const k = Math.round(n.start * 1000); starts.set(k, (starts.get(k) || 0) + 1); });
  let stacked = 0;
  notes.forEach(n => { if ((starts.get(Math.round(n.start * 1000)) || 0) >= 2) stacked++; });
  return stacked / notes.length >= 0.5;
}

const sortNotes = (a: MidiNote[]) => [...a].sort((x, y) => x.start - y.start || x.pitch - y.pitch);
const fresh = (n: Omit<MidiNote, 'id'> & { id?: string }): MidiNote => {
  const { isSelected: _s, ...rest } = n as MidiNote;
  return { ...rest, id: newId('vr') };
};

/** Arrondi au 1/32 de temps pour comparer des positions. */
const q = (t: number) => Math.round(t * 1000);

// ── Règles ────────────────────────────────────────────────────────────────────────────

/** Renversement : mélodie à l'envers autour d'un axe ; accords : renversements successifs. */
function invert(notes: MidiNote[], ctx: VaryContext, which: number): MidiNote[] {
  if (!notes.length) return [];
  if (isChordal(notes)) {
    // Accords : renversements. Variante 0 : les notes graves montent d'une octave ; 1 : les notes
    // aiguës descendent d'une octave ; 2 : la plus grave monte ET la plus aiguë descend (voicing resserré).
    const groups = new Map<number, MidiNote[]>();
    notes.forEach(n => { const k = q(n.start); groups.set(k, [...(groups.get(k) || []), n]); });
    const out: MidiNote[] = [];
    const w = which % 3;
    for (const g of groups.values()) {
      const s = [...g].sort((a, b) => a.pitch - b.pitch);
      const k = s.length > 1 ? Math.max(1, Math.ceil(s.length * 0.3)) : 0;
      const half = Math.max(1, Math.ceil(k / 2));
      const up = !k ? 0 : w === 0 ? k : w === 1 ? 0 : half;
      const down = !k ? 0 : w === 1 ? k : w === 0 ? 0 : Math.min(half, s.length - up);
      s.forEach((n, i) => out.push(fresh({ ...n, pitch: clampPitch(i < up ? n.pitch + 12 : i >= s.length - down ? n.pitch - 12 : n.pitch) })));
    }
    return sortNotes(out);
  }
  const ps = notes.map(n => n.pitch);
  const axis = which === 0 ? notes[0].pitch : which === 1 ? Math.round((Math.max(...ps) + Math.min(...ps)) / 2) : Math.max(...ps);
  return sortNotes(notes.map(n => fresh({ ...n, pitch: snapNote(2 * axis - n.pitch, n.start, ctx) })));
}

/** Déplacement rythmique : `amount` en s, les notes qui sortent du clip reviennent au début. */
function displace(notes: MidiNote[], ctx: VaryContext, which: number, clipLen: number): MidiNote[] {
  const beat = 60 / (ctx.bpm || 120);
  const amount = [beat / 4, beat / 2, beat][which % 3];
  const len = clipLen > 0 ? clipLen : Math.max(...notes.map(n => n.start + n.duration), beat * 4);
  return sortNotes(notes.map(n => {
    let s = n.start + amount;
    if (s >= len - EPS) s -= len;
    const d = Math.min(n.duration, len - s);
    return fresh({ ...n, start: s, duration: Math.max(beat / 8, d), pitch: snapNote(n.pitch, s, ctx) });
  }));
}

/** Variation rythmique tirée au hasard (graine) : coupe, syncope, liaison. */
function rhythm(notes: MidiNote[], ctx: VaryContext, seed: number, clipLen: number): MidiNote[] {
  const r = rng(seed);
  const six = 60 / (ctx.bpm || 120) / 4;
  const len = clipLen > 0 ? clipLen : Math.max(...notes.map(n => n.start + n.duration));
  const s = sortNotes(notes);
  const out: MidiNote[] = [];
  let changed = 0;
  s.forEach((n, i) => {
    const roll = r();
    const next = s.find((m, j) => j > i && m.start > n.start + EPS);
    if (roll < 0.34 && n.duration >= 2 * six - EPS) {
      // Coupe : deux (ou trois) répétitions de la même note.
      const parts = n.duration >= 4 * six - EPS && r() < 0.5 ? 3 : 2;
      const d = n.duration / parts;
      for (let k = 0; k < parts; k++) out.push(fresh({ ...n, start: n.start + k * d, duration: d * 0.9, velocity: Math.max(0.3, n.velocity * (k ? 0.85 : 1)) }));
      changed++;
    } else if (roll < 0.67) {
      // Syncope : une double-croche plus tôt (ou plus tard au début du clip).
      const dir = n.start - six >= -EPS ? -1 : 1;
      const st = Math.max(0, Math.min(len - six, n.start + dir * six));
      out.push(fresh({ ...n, start: st, duration: Math.max(six / 2, Math.min(n.duration, len - st)), pitch: snapNote(n.pitch, st, ctx) }));
      changed++;
    } else if (next && roll < 0.85) {
      // Liaison : la note tient jusqu'à la suivante.
      out.push(fresh({ ...n, duration: Math.max(n.duration, next.start - n.start) }));
      if (next.start - n.start > n.duration + EPS) changed++;
    } else {
      out.push(fresh({ ...n }));
    }
  });
  // Toujours une vraie variation : au moins 30 % des notes bougent.
  if (s.length && changed / s.length < 0.3) return rhythm(notes, ctx, seed + 7919, clipLen);
  return sortNotes(out);
}

/** Transposition diatonique : chaque note monte / descend de `deg` degrés de la gamme. */
function transpose(notes: MidiNote[], ctx: VaryContext, which: number): MidiNote[] {
  const deg = [2, -2, 4][which % 3];
  return sortNotes(notes.map(n => fresh({ ...n, pitch: snapNote(stepInScale(n.pitch, deg, ctx.root, ctx.scale), n.start, ctx) })));
}

/**
 * Variation d'un clip selon une règle. `which` (0, 1, 2) choisit la variante de la règle
 * (axe de l'inversion, valeur du déplacement, sens de la transposition, graine du rythme).
 */
export function varyNotes(notes: MidiNote[], rule: VaryRule, ctx: VaryContext, which = 0, clipLen = 0): MidiNote[] {
  const live = notes.filter(n => !n.muted);
  if (!live.length) return [];
  switch (rule) {
    case 'inversion': return invert(live, ctx, which);
    case 'deplacement': return displace(live, ctx, which, clipLen);
    case 'transposition': return transpose(live, ctx, which);
    case 'rythme':
    default: return rhythm(live, ctx, (ctx.seed ?? 1) * 31 + which * 977, clipLen);
  }
}

/** Part des notes de `a` absentes de `b` (même hauteur et même départ à 1 ms près), dans les deux sens. */
export function noteDistance(a: MidiNote[], b: MidiNote[]): number {
  if (!a.length && !b.length) return 0;
  const key = (n: MidiNote) => `${n.pitch}@${q(n.start)}`;
  const sa = new Set(a.map(key)), sb = new Set(b.map(key));
  const missA = a.filter(n => !sb.has(key(n))).length / Math.max(1, a.length);
  const missB = b.filter(n => !sa.has(key(n))).length / Math.max(1, b.length);
  return Math.max(missA, missB);
}

/**
 * Le dé : 3 variantes distinctes d'une règle (au moins 30 % des notes différentes entre
 * chaque paire, et par rapport à l'original). Une variante trop proche est retirée.
 */
export function varyVariants(notes: MidiNote[], rule: VaryRule, ctx: VaryContext, clipLen = 0, seed = ctx.seed ?? 1): MidiNote[][] {
  const out: MidiNote[][] = [];
  const live = notes.filter(n => !n.muted);
  for (let attempt = 0; attempt < 12 && out.length < 3; attempt++) {
    const which = rule === 'rythme' ? attempt : attempt % 3;
    const c = varyNotes(live, rule, { ...ctx, seed: seed + attempt * 13 }, which, clipLen);
    if (!c.length) break;
    if (noteDistance(c, live) < 0.3) continue;
    if (out.some(o => noteDistance(o, c) < 0.3)) continue;
    out.push(c);
  }
  return out;
}

export type ExtendMode = 'repeter' | 'varier';

/**
 * Prolonge un clip de `bars` mesures : le motif reprend (le dernier morceau de `bars` mesures
 * quand on prolonge de moins que la longueur du clip). En mode « varier », une reprise sur
 * deux passe par la règle choisie : la suite ne sonne pas comme un copier-coller.
 */
export function extendNotes(notes: MidiNote[], o: {
  bars: number; clipLen: number; ctx: VaryContext; beatsPerBar?: number; mode?: ExtendMode; rule?: VaryRule;
}): { notes: MidiNote[]; duration: number } {
  const bar = (60 / (o.ctx.bpm || 120)) * (o.beatsPerBar || 4);
  const srcBars = Math.max(1, Math.round(o.clipLen / bar));
  const srcLen = srcBars * bar;
  const add = Math.max(1, Math.round(o.bars));
  const live = notes.filter(n => !n.muted && n.start < srcLen - EPS);
  const out: MidiNote[] = notes.map(n => ({ ...n }));
  // Source : tout le clip, ou ses `add` dernières mesures si on ajoute moins.
  const from = add < srcBars ? srcLen - add * bar : 0;
  const unit = live.filter(n => n.start >= from - EPS).map(n => ({ ...n, start: n.start - from }));
  const unitLen = Math.min(srcLen, add * bar);
  let t = srcLen, k = 0;
  while (t < srcLen + add * bar - EPS) {
    const span = Math.min(unitLen, srcLen + add * bar - t);
    let piece = unit.filter(n => n.start < span - EPS);
    if (o.mode === 'varier' && k % 2 === 0 && piece.length) {
      const v = varyNotes(piece, o.rule || 'rythme', { ...o.ctx, clipStart: (o.ctx.clipStart || 0) + t, seed: (o.ctx.seed ?? 1) + k }, k % 3, span);
      if (v.length) piece = v;
    }
    piece.forEach(n => {
      const st = t + n.start;
      out.push(fresh({ ...n, start: st, duration: Math.min(n.duration, srcLen + add * bar - st), pitch: snapNote(n.pitch, st, o.ctx) }));
    });
    t += span; k++;
  }
  return { notes: sortNotes(out), duration: srcLen + add * bar };
}
