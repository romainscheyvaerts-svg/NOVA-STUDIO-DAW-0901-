/**
 * Outils MIDI du piano roll (V25) : transformations de Live 12 (Strum, Arpeggiate,
 * Chop, Velocity Shaper, Ornament…) et outils du piano roll de FL (Strum,
 * Arpeggiate, Chop, Flam, Randomize, Legato, Flip…).
 *
 * Chaque outil est une fonction pure : (notes du clip, sélection, contexte,
 * réglages) → nouvelles notes du clip. Sans sélection, l'outil agit sur tout
 * le clip. Le piano roll écrit le résultat en UNE fois (une étape d'annulation,
 * une seule opération de collaboration) et peut l'afficher en aperçu avant.
 *
 * Unités : secondes depuis le début du clip, vélocité 0-1 (comme MidiNote).
 */
import { MidiNote } from '../types';
import { ArpPattern, ArpRate, ChordGenerator, ChordType, arpRateBeats, arpSequence, quantizePitchToScale, ScaleType } from '../services/MidiEffectsService';

export interface ToolContext {
  bpm: number;
  /** Début du clip dans le morceau (s) : la grille de quantification est celle du morceau. */
  clipStart?: number;
  /** Tonalité : 0 = Do … 11 = Si, et gamme (MINOR, MAJOR…). */
  keyRoot?: number;
  keyScale?: string;
  /** Aléatoire reproductible (tests, aperçu stable). */
  rand?: () => number;
}

export type Selection = Set<string> | null | undefined;

const beatOf = (ctx: ToolContext) => 60 / (ctx.bpm || 120);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const clampVel = (v: number) => clamp(v, 0.01, 1);
let seq = 0;
const newId = () => `n-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Notes ciblées (sélection, sinon toutes) et les autres, inchangées. */
function split(notes: MidiNote[], sel: Selection): { target: MidiNote[]; rest: MidiNote[] } {
  if (!sel || sel.size === 0) return { target: [...notes], rest: [] };
  return { target: notes.filter(n => sel.has(n.id)), rest: notes.filter(n => !sel.has(n.id)) };
}

const byTime = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch;

/** Accords : notes qui commencent ensemble (à `tol` s près). */
export function chordGroups(notes: MidiNote[], tol = 0.012): MidiNote[][] {
  const sorted = [...notes].sort(byTime);
  const groups: MidiNote[][] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(n.start - g[0].start) <= tol) g.push(n); else groups.push([n]);
  }
  return groups;
}

/** Valeur de grille (texte) → durée en temps. */
export const GRID_BEATS: Record<string, number> = {
  '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125, '1/64': 0.0625,
  '1/8T': 1 / 3, '1/16T': 1 / 6, '1/32T': 1 / 12,
};
export const gridSeconds = (grid: string, bpm: number) => (GRID_BEATS[grid] ?? 0.25) * (60 / (bpm || 120));

// ---------------------------------------------------------------------------
// Strum (FL : Strum, Live : Strum)
// ---------------------------------------------------------------------------

export interface StrumParams {
  /** Montant (grave → aigu), descendant, ou alterné d'un accord à l'autre (guitare). */
  direction: 'up' | 'down' | 'alternate';
  /** Écart entre deux notes de l'accord (ms). */
  spreadMs: number;
  /** Courbe : 0 = régulier, > 0 = s'accélère, < 0 = ralentit. */
  tension?: number;
  /** Les fins de notes restent en place (comme FL) : la note retardée raccourcit. */
  keepEnds?: boolean;
}

export function strum(notes: MidiNote[], sel: Selection, ctx: ToolContext, p: StrumParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const out: MidiNote[] = [];
  chordGroups(target).forEach((g, gi) => {
    const up = p.direction === 'up' || (p.direction === 'alternate' && gi % 2 === 0);
    const order = [...g].sort((a, b) => (up ? a.pitch - b.pitch : b.pitch - a.pitch));
    const k = order.length;
    order.forEach((n, i) => {
      const x = k > 1 ? i / (k - 1) : 0;
      const tens = clamp(p.tension ?? 0, -0.9, 0.9);
      const curved = tens >= 0 ? Math.pow(x, 1 - tens) : 1 - Math.pow(1 - x, 1 + tens);
      const delay = (k - 1) * (p.spreadMs / 1000) * curved;
      const end = n.start + n.duration;
      const start = n.start + delay;
      out.push({ ...n, start, duration: p.keepEnds === false ? n.duration : Math.max(0.02, end - start) });
    });
  });
  return [...rest, ...out].sort(byTime);
}

// ---------------------------------------------------------------------------
// Arpège (Arpeggiator de MidiEffectsService, figé en notes)
// ---------------------------------------------------------------------------

export interface ArpParams {
  pattern: ArpPattern;
  rate: ArpRate;
  octaves: number;
  /** Longueur de chaque note (% du pas). */
  gate: number;
}

export function arpeggiate(notes: MidiNote[], sel: Selection, ctx: ToolContext, p: ArpParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const step = arpRateBeats(p.rate) * beatOf(ctx);
  const gate = clamp(p.gate, 5, 200) / 100;
  const out: MidiNote[] = [];
  // Accords qui se chevauchent : l'arpège d'un accord s'arrête où commence le suivant.
  const groups = chordGroups(target);
  groups.forEach((g, gi) => {
    const start = g[0].start;
    const nextStart = groups[gi + 1]?.[0].start ?? Infinity;
    const end = Math.min(nextStart, Math.max(...g.map(n => n.start + n.duration)));
    const seqP = arpSequence(g.map(n => n.pitch), p.pattern, p.octaves, ctx.rand);
    if (!seqP.length) return;
    const vel = Math.max(...g.map(n => n.velocity));
    const count = Math.max(1, Math.floor((end - start) / step + 1e-6));
    for (let i = 0; i < count; i++) {
      const pitch = clamp(seqP[i % seqP.length], 0, 127);
      out.push({ id: newId(), pitch, start: start + i * step, duration: Math.max(0.01, step * gate), velocity: vel });
    }
  });
  return [...rest, ...out].sort(byTime);
}

// ---------------------------------------------------------------------------
// Flam (FL : Flam) : une petite note juste avant chaque note
// ---------------------------------------------------------------------------

export interface FlamParams { offsetMs: number; velocity: number /* 0-1 de la note principale */ }

export function flam(notes: MidiNote[], sel: Selection, _ctx: ToolContext, p: FlamParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const off = Math.max(0.002, p.offsetMs / 1000);
  const grace: MidiNote[] = target.map(n => ({
    id: newId(), pitch: n.pitch, start: Math.max(0, n.start - off), duration: Math.min(off * 0.9, n.duration), velocity: clampVel(n.velocity * p.velocity),
  }));
  return [...rest, ...target, ...grace].sort(byTime);
}

// ---------------------------------------------------------------------------
// Chop (Live : Chop, FL : Chop) : chaque note découpée en morceaux égaux
// ---------------------------------------------------------------------------

export interface ChopParams { grid: string /* '1/16', '1/32'… */; gate?: number /* % */ }

export function chop(notes: MidiNote[], sel: Selection, ctx: ToolContext, p: ChopParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const step = gridSeconds(p.grid, ctx.bpm);
  const gate = clamp(p.gate ?? 100, 5, 100) / 100;
  const out: MidiNote[] = [];
  for (const n of target) {
    const pieces = Math.max(1, Math.round(n.duration / step - 1e-6));
    if (pieces <= 1) { out.push(n); continue; }
    for (let i = 0; i < pieces; i++) {
      out.push({ ...n, id: i === 0 ? n.id : newId(), start: n.start + i * step, duration: Math.max(0.01, Math.min(step, n.duration - i * step) * gate) });
    }
  }
  return [...rest, ...out].sort(byTime);
}

// ---------------------------------------------------------------------------
// Roll de hi-hats (FL : rolls de l'éditeur, Live : Ornament / ratchets)
// ---------------------------------------------------------------------------

export interface RollParams {
  /** Vitesse : '1/16', '1/32', '1/64', triolets '1/16T', '1/32T'. */
  rate: string;
  /** Rampe de vélocité sur le roll. */
  ramp: 'flat' | 'up' | 'down' | 'updown';
  /** Vélocités extrêmes de la rampe (0-1) ; « plate » garde la vélocité de la note. */
  from: number;
  to: number;
  /** Rampe de hauteur (demi-tons sur tout le roll : rolls de 808 / toms). */
  pitchRamp?: number;
}

export function roll(notes: MidiNote[], sel: Selection, ctx: ToolContext, p: RollParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const step = gridSeconds(p.rate, ctx.bpm);
  const out: MidiNote[] = [];
  for (const n of target) {
    const count = Math.max(1, Math.floor(n.duration / step + 1e-6));
    for (let i = 0; i < count; i++) {
      const x = count > 1 ? i / (count - 1) : 0;
      // Rampe entre la plus faible et la plus forte des deux vélocités : montée, descente ou aller-retour.
      const lo = Math.min(p.from, p.to), hi = Math.max(p.from, p.to);
      const shape = p.ramp === 'up' ? x : p.ramp === 'down' ? 1 - x : 1 - Math.abs(2 * x - 1);
      const v = p.ramp === 'flat' ? n.velocity : lo + (hi - lo) * shape;
      const pitch = clamp(Math.round(n.pitch + (p.pitchRamp || 0) * x), 0, 127);
      out.push({ id: i === 0 ? n.id : newId(), pitch, start: n.start + i * step, duration: Math.max(0.01, step * 0.9), velocity: clampVel(v) });
    }
  }
  return [...rest, ...out].sort(byTime);
}

// ---------------------------------------------------------------------------
// Courbe de vélocité (Live : Velocity Shaper, FL : Scale levels)
// ---------------------------------------------------------------------------

export interface VelocityCurveParams {
  shape: 'up' | 'down' | 'sine' | 'drawn' | 'flat';
  min: number;
  max: number;
  /** Sinus : nombre de vagues sur la sélection. */
  cycles?: number;
  /** Courbe dessinée : valeurs 0-1 réparties sur la sélection. */
  points?: number[];
}

export function curveValue(p: VelocityCurveParams, x: number): number {
  const lo = clamp(p.min, 0, 1), hi = clamp(p.max, 0, 1);
  let s: number;
  switch (p.shape) {
    case 'up': s = x; break;
    case 'down': s = 1 - x; break;
    case 'sine': s = 0.5 - 0.5 * Math.cos(2 * Math.PI * (p.cycles || 1) * x); break;
    case 'drawn': {
      const pts = p.points && p.points.length ? p.points : [1];
      if (pts.length === 1) { s = pts[0]; break; }
      const f = x * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(f));
      s = pts[i] + (pts[i + 1] - pts[i]) * (f - i);
      break;
    }
    default: s = 1;
  }
  return lo + (hi - lo) * clamp(s, 0, 1);
}

export function velocityCurve(notes: MidiNote[], sel: Selection, _ctx: ToolContext, p: VelocityCurveParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  if (!target.length) return notes;
  const t0 = Math.min(...target.map(n => n.start));
  const t1 = Math.max(...target.map(n => n.start));
  const span = t1 - t0;
  const changed = target.map(n => ({ ...n, velocity: clampVel(curveValue(p, span > 0 ? (n.start - t0) / span : 0)) }));
  return [...rest, ...changed].sort(byTime);
}

// ---------------------------------------------------------------------------
// Aléatoire (FL : Randomize, Live : Velocity / Time ranges)
// ---------------------------------------------------------------------------

export interface RandomizeParams {
  /** Hauteur : écart maximal en degrés de la gamme (0 = sans). */
  pitch: number;
  /** Vélocité : écart maximal (0-1). */
  velocity: number;
  /** Placement : écart maximal (ms). */
  timingMs: number;
  /** Probabilité qu'une note soit touchée (0-1). */
  chance?: number;
}

export function randomize(notes: MidiNote[], sel: Selection, ctx: ToolContext, p: RandomizeParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const rnd = ctx.rand || Math.random;
  const scale = (ctx.keyScale || 'CHROMATIC').toUpperCase() as ScaleType;
  const hasKey = typeof ctx.keyRoot === 'number' && scale !== 'CHROMATIC';
  const changed = target.map(n => {
    if (rnd() > (p.chance ?? 1)) return n;
    let pitch = n.pitch;
    if (p.pitch > 0) {
      const steps = Math.round((rnd() * 2 - 1) * p.pitch);
      if (hasKey) {
        // Pas de gamme en gamme (ScaleQuantizer de MidiEffectsService).
        pitch = quantizePitchToScale(pitch, ctx.keyRoot!, scale);
        for (let i = 0; i < Math.abs(steps); i++) pitch = quantizePitchToScale(pitch + Math.sign(steps), ctx.keyRoot!, scale, steps > 0 ? 'UP' : 'DOWN');
      } else pitch += steps;
    }
    const velocity = clampVel(n.velocity + (rnd() * 2 - 1) * p.velocity);
    const start = Math.max(0, n.start + (rnd() * 2 - 1) * (p.timingMs / 1000));
    return { ...n, pitch: clamp(pitch, 0, 127), velocity, start };
  });
  return [...rest, ...changed].sort(byTime);
}

// ---------------------------------------------------------------------------
// Legato, inversion, rétrograde (FL : Articulate / Flip ; Logic : Legato / Reverse)
// ---------------------------------------------------------------------------

/** Chaque note s'allonge jusqu'à l'attaque suivante (les accords restent ensemble). */
export function legato(notes: MidiNote[], sel: Selection, _ctx: ToolContext, p: { gapMs?: number } = {}): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const groups = chordGroups(target);
  const gap = (p.gapMs || 0) / 1000;
  const out: MidiNote[] = [];
  groups.forEach((g, i) => {
    const next = groups[i + 1]?.[0].start;
    g.forEach(n => out.push(next === undefined ? n : { ...n, duration: Math.max(0.01, next - n.start - gap) }));
  });
  return [...rest, ...out].sort(byTime);
}

/** Inversion des hauteurs autour du centre (dans la gamme si elle est connue). */
export function invert(notes: MidiNote[], sel: Selection, ctx: ToolContext): MidiNote[] {
  const { target, rest } = split(notes, sel);
  if (!target.length) return notes;
  const lo = Math.min(...target.map(n => n.pitch));
  const hi = Math.max(...target.map(n => n.pitch));
  const scale = (ctx.keyScale || 'CHROMATIC').toUpperCase() as ScaleType;
  const hasKey = typeof ctx.keyRoot === 'number' && scale !== 'CHROMATIC';
  const changed = target.map(n => {
    let p = lo + hi - n.pitch;
    if (hasKey) p = quantizePitchToScale(p, ctx.keyRoot!, scale);
    return { ...n, pitch: clamp(p, 0, 127) };
  });
  return [...rest, ...changed].sort(byTime);
}

/** Rétrograde : la phrase jouée à l'envers (les notes gardent leur longueur). */
export function retrograde(notes: MidiNote[], sel: Selection): MidiNote[] {
  const { target, rest } = split(notes, sel);
  if (!target.length) return notes;
  const t0 = Math.min(...target.map(n => n.start));
  const t1 = Math.max(...target.map(n => n.start + n.duration));
  const changed = target.map(n => ({ ...n, start: Math.max(0, t0 + t1 - (n.start + n.duration)) }));
  return [...rest, ...changed].sort(byTime);
}

// ---------------------------------------------------------------------------
// Quantification avec intensité et swing (Live : Quantize Settings, Logic : Q-Strength / Q-Swing)
// ---------------------------------------------------------------------------

export interface QuantizeParams {
  grid: string;
  /** 0-1 : 1 = pile sur la grille. */
  strength: number;
  /** 50-75 % : place des contretemps de la grille. */
  swing: number;
  /** Cale aussi les fins de notes. */
  ends?: boolean;
}

export function quantize(notes: MidiNote[], sel: Selection, ctx: ToolContext, p: QuantizeParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const g = gridSeconds(p.grid, ctx.bpm);
  const origin = ctx.clipStart || 0;
  const s = clamp(p.strength, 0, 1);
  const swingOff = ((2 * clamp(p.swing, 50, 75)) / 100 - 1) * g;
  const snap = (abs: number) => {
    const idx = Math.round(abs / g);
    return idx * g + (idx % 2 !== 0 ? swingOff : 0);
  };
  const changed = target.map(n => {
    const abs = origin + n.start;
    const start = n.start + (snap(abs) - abs) * s;
    let duration = n.duration;
    if (p.ends) {
      const endAbs = abs + n.duration;
      const end = n.start + n.duration + (Math.round(endAbs / g) * g - endAbs) * s;
      duration = Math.max(g * 0.25, end - start);
    }
    return { ...n, start: Math.max(0, start), duration };
  });
  return [...rest, ...changed].sort(byTime);
}

// ---------------------------------------------------------------------------
// Accord sur chaque note (ChordGenerator de MidiEffectsService ; Logic : Chord Trigger)
// ---------------------------------------------------------------------------

export interface ChordifyParams { chordType: ChordType; inversion: number; velocityScale: number; strumMs: number }

export function chordify(notes: MidiNote[], sel: Selection, _ctx: ToolContext, p: ChordifyParams): MidiNote[] {
  const { target, rest } = split(notes, sel);
  const gen = new ChordGenerator();
  gen.setSettings({ enabled: true, chordType: p.chordType, inversion: p.inversion, velocityScale: p.velocityScale, strumDelay: p.strumMs, spread: 0 });
  const out: MidiNote[] = [];
  for (const n of target) {
    gen.generateChord(n.pitch, Math.round(n.velocity * 127)).forEach((c, i) => {
      const delay = c.delay / 1000;
      out.push({ ...n, id: i === 0 ? n.id : newId(), pitch: clamp(c.pitch, 0, 127), start: n.start + delay, duration: Math.max(0.02, n.duration - delay), velocity: clampVel(c.velocity / 127) });
    });
  }
  return [...rest, ...out].sort(byTime);
}

// ---------------------------------------------------------------------------
// Catalogue (menu « Outils » du piano roll)
// ---------------------------------------------------------------------------

export type ToolId = 'strum' | 'arp' | 'flam' | 'chop' | 'roll' | 'velocity' | 'random' | 'legato' | 'invert' | 'retro' | 'quantize' | 'chord';

export interface ToolInfo {
  id: ToolId;
  label: string;
  icon: string;
  /** Infobulle : ce que fait l'outil et son équivalent ailleurs. */
  hint: string;
  /** Outil sans réglage : appliqué directement. */
  instant?: boolean;
}

export const MIDI_TOOLS: ToolInfo[] = [
  { id: 'quantize', label: 'Quantifier', icon: 'fa-magnet', hint: 'Cale les notes sur la grille avec une intensité et du swing (comme Quantize Settings dans Live, Q-Strength / Q-Swing dans Logic, Quick Quantize dans FL).' },
  { id: 'strum', label: 'Strum', icon: 'fa-guitar', hint: 'Égrène les accords comme une guitare, montant ou descendant (comme Strum dans Live 12 et dans FL Studio).' },
  { id: 'arp', label: 'Arpège', icon: 'fa-stairs', hint: 'Transforme chaque accord en arpège : motif, vitesse, octaves (comme Arpeggiate dans Live 12 et FL Studio, l’Arpeggiator de Logic figé en notes).' },
  { id: 'roll', label: 'Roll de hi-hats', icon: 'fa-bars-staggered', hint: 'Remplit chaque note de répétitions rapides (1/32, triolets) avec une rampe de vélocité : les rolls trap (comme les rolls de FL et Ornament dans Live 12).' },
  { id: 'chop', label: 'Chop', icon: 'fa-scissors', hint: 'Découpe chaque note en morceaux de 1/16 ou 1/32 (comme Chop dans Live 12 et FL Studio).' },
  { id: 'flam', label: 'Flam', icon: 'fa-angles-right', hint: 'Ajoute une petite note juste avant chaque note (comme Flam dans FL Studio et Ornament dans Live 12).' },
  { id: 'velocity', label: 'Courbe de vélocité', icon: 'fa-chart-line', hint: 'Montée, descente, vague ou courbe dessinée sur la force des notes (comme Velocity Shaper dans Live 12 et Scale Levels dans FL).' },
  { id: 'random', label: 'Aléatoire', icon: 'fa-dice', hint: 'Varie la hauteur (dans la gamme), la vélocité et le placement (comme Randomize dans FL Studio et les plages aléatoires de Live 12).' },
  { id: 'chord', label: 'Accord sur chaque note', icon: 'fa-layer-group', hint: 'Chaque note devient un accord (comme Chord Trigger dans Logic et l’effet Chord de Live).' },
  { id: 'legato', label: 'Legato', icon: 'fa-grip-lines', hint: 'Chaque note s’allonge jusqu’à la suivante (comme Legato dans Live et Logic, Articulate dans FL).', instant: true },
  { id: 'invert', label: 'Inversion', icon: 'fa-arrows-up-down', hint: 'Retourne les hauteurs (le grave devient aigu), dans la gamme (comme Flip vertical dans FL et Invert dans Live 12).', instant: true },
  { id: 'retro', label: 'Rétrograde', icon: 'fa-arrows-left-right', hint: 'Joue la phrase à l’envers (comme Flip horizontal dans FL et Reverse dans Live / Logic).', instant: true },
];

export const ARP_PATTERNS: { id: ArpPattern; label: string }[] = [
  { id: 'UP', label: 'Montant' }, { id: 'DOWN', label: 'Descendant' }, { id: 'UP_DOWN', label: 'Monte-descend' }, { id: 'DOWN_UP', label: 'Descend-monte' },
  { id: 'CONVERGE', label: 'Convergent' }, { id: 'DIVERGE', label: 'Divergent' }, { id: 'PINKY_UP', label: 'Pouce + montant' }, { id: 'ORDER', label: 'Dans l’ordre' }, { id: 'RANDOM', label: 'Au hasard' },
];
