/**
 * Piano roll « pro » (15/10/2026) : fonctions pures du piano roll, testées sans
 * navigateur (tests/pianoRollPro.test.ts).
 *
 * - Grille : 1/1 à 1/64, triolets, magnétisme coupé (FL : Snap « none », Alt
 *   pour passer outre ; Live : Ctrl+4 coupe la grille).
 * - Pinceau (FL : Paint, touche B) : glisser peint des notes à la suite.
 * - Couteau (FL : Slice ; Live : Split ; Cubase : Split) : coupe une note en deux.
 * - Dupliquer à la suite (FL : Ctrl+B ; Live : Ctrl+D), copier / coller.
 * - Humaniser (décalages de temps, de vélocité et de longueur, reproductibles).
 * - Glissés par note (FL : Slide notes) : une note « glissée » qui chevauche une
 *   note tenue ne se rejoue pas ; elle fait glisser la hauteur de la note en
 *   cours jusqu'à la sienne, pendant sa propre durée. C'est le glissé de la 808
 *   et des leads trap.
 * - Couleur des notes selon la vélocité (Logic, Studio One : violet doux → rouge fort).
 *
 * Unités : secondes depuis le début du clip, vélocité 0-1 (comme MidiNote).
 */
import { MidiNote } from '../types';
import { seededRandom } from './midiTools';

// ---------------------------------------------------------------------------
// Grille
// ---------------------------------------------------------------------------

export interface GridChoice { id: string; label: string; beats: number; triplet?: boolean; hint: string }

/** Valeurs de grille (en temps : 1 = une noire). */
export const GRID_CHOICES: GridChoice[] = [
  { id: '1/1', label: '1 mesure', beats: 4, hint: 'Une mesure' },
  { id: '1/2', label: '1/2', beats: 2, hint: 'Blanche' },
  { id: '1/4', label: '1/4', beats: 1, hint: 'Noire (un temps)' },
  { id: '1/8', label: '1/8', beats: 0.5, hint: 'Croche' },
  { id: '1/16', label: '1/16', beats: 0.25, hint: 'Double croche : la grille trap' },
  { id: '1/32', label: '1/32', beats: 0.125, hint: 'Triple croche : rolls de hi-hats' },
  { id: '1/64', label: '1/64', beats: 0.0625, hint: 'Quadruple croche : rolls très serrés' },
  { id: '1/4T', label: '1/4 T', beats: 2 / 3, triplet: true, hint: 'Triolet de noires' },
  { id: '1/8T', label: '1/8 T', beats: 1 / 3, triplet: true, hint: 'Triolet de croches (flow triolet, afro)' },
  { id: '1/16T', label: '1/16 T', beats: 1 / 6, triplet: true, hint: 'Triolet de doubles : rolls trap' },
  { id: '1/32T', label: '1/32 T', beats: 1 / 12, triplet: true, hint: 'Triolet de triples : rolls très rapides' },
];

export const gridBeats = (id: string): number => GRID_CHOICES.find(g => g.id === id)?.beats ?? 0.25;
export const gridSec = (id: string, bpm: number): number => gridBeats(id) * (60 / (bpm || 120));

/**
 * Cale `t` (dans le clip) sur la grille du MORCEAU (le clip peut commencer
 * hors grille). `snap = false` : temps inchangé (magnétisme coupé, ou Alt tenu).
 */
export function snapTime(t: number, g: number, clipStart = 0, snap = true): number {
  if (!snap || !(g > 0)) return t;
  const abs = clipStart + t;
  return Math.round(abs / g + 1e-9) * g - clipStart;
}

/** Comme snapTime, mais toujours vers la case où se trouve `t` (le crayon pose la note dans la case cliquée). */
export function floorTime(t: number, g: number, clipStart = 0, snap = true): number {
  if (!snap || !(g > 0)) return t;
  const abs = clipStart + t;
  return Math.floor(abs / g + 1e-9) * g - clipStart;
}

// ---------------------------------------------------------------------------
// Identifiants
// ---------------------------------------------------------------------------

let seq = 0;
export const newNoteId = () => `n-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const byTime = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// Pinceau (FL : Paint)
// ---------------------------------------------------------------------------

export interface PaintParams {
  /** Début et fin du geste (s, dans le clip). */
  from: number;
  to: number;
  pitch: number;
  /** Pas entre deux notes (s) : la grille. */
  step: number;
  /** Longueur de chaque note (s) : celle de la dernière note posée (FL). */
  length: number;
  velocity: number;
  /** Les notes déjà là : on ne repeint pas une case occupée sur la même hauteur. */
  existing?: MidiNote[];
  slide?: boolean;
  makeId?: () => string;
}

/** Notes peintes entre `from` et `to` (dans les deux sens), une par pas. */
export function paintNotes(p: PaintParams): MidiNote[] {
  if (!(p.step > 0)) return [];
  const a = Math.min(p.from, p.to), b = Math.max(p.from, p.to);
  const first = Math.max(0, Math.floor(a / p.step + 1e-9) * p.step);
  const out: MidiNote[] = [];
  const taken = new Set((p.existing || []).filter(n => n.pitch === p.pitch).map(n => Math.round(n.start / p.step)));
  const mk = p.makeId || newNoteId;
  for (let t = first; t <= b + 1e-9; t += p.step) {
    const idx = Math.round(t / p.step);
    if (taken.has(idx)) continue;
    taken.add(idx);
    out.push({ id: mk(), pitch: p.pitch, start: Math.round(t * 1e9) / 1e9, duration: Math.max(0.01, p.length), velocity: clamp(p.velocity, 0.01, 1), ...(p.slide ? { slide: true } : {}) });
    if (out.length >= 512) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Couteau (FL : Slice)
// ---------------------------------------------------------------------------

/** Coupe la note `id` à l'instant `at` (dans le clip). Rien ne change si `at` tombe hors de la note. */
export function splitNoteAt(notes: MidiNote[], id: string, at: number, makeId: () => string = newNoteId): { notes: MidiNote[]; newId: string | null } {
  const n = notes.find(x => x.id === id);
  const MIN = 0.005;
  if (!n || at <= n.start + MIN || at >= n.start + n.duration - MIN) return { notes, newId: null };
  const left: MidiNote = { ...n, duration: at - n.start };
  const right: MidiNote = { ...n, id: makeId(), start: at, duration: n.start + n.duration - at };
  // La 2e moitié n'est plus un glissé : seule l'attaque d'origine glisse.
  delete right.slide;
  return { notes: [...notes.filter(x => x.id !== id), left, right].sort(byTime), newId: right.id };
}

// ---------------------------------------------------------------------------
// Dupliquer à la suite, copier, coller
// ---------------------------------------------------------------------------

/**
 * Longueur dont on décale une copie « à la suite » (FL : Ctrl+B) : l'étendue de
 * la sélection arrondie à la grille au-dessus ; une mesure entière dès que la
 * sélection dépasse les trois quarts d'une mesure (un motif d'une mesure se
 * recopie sur la mesure suivante, même si sa dernière note finit avant).
 */
export function duplicateSpan(sel: MidiNote[], grid: number, bar: number): { from: number; span: number } {
  if (!sel.length) return { from: 0, span: 0 };
  const from = Math.min(...sel.map(n => n.start));
  const end = Math.max(...sel.map(n => n.start + n.duration));
  const raw = end - from;
  const unit = bar > 0 && raw > bar * 0.75 ? bar : grid > 0 ? grid : raw;
  const span = Math.max(unit, Math.ceil(raw / unit - 1e-6) * unit);
  return { from, span };
}

/** Copie la sélection juste après elle. Renvoie les nouvelles notes (à sélectionner). */
export function duplicateRight(notes: MidiNote[], ids: Set<string>, grid: number, bar: number, makeId: () => string = newNoteId): { notes: MidiNote[]; added: MidiNote[] } {
  const sel = notes.filter(n => ids.has(n.id));
  if (!sel.length) return { notes, added: [] };
  const { span } = duplicateSpan(sel, grid, bar);
  const added = sel.map(n => ({ ...n, id: makeId(), start: Math.round((n.start + span) * 1e9) / 1e9 }));
  return { notes: [...notes, ...added].sort(byTime), added };
}

/**
 * Maj + ← / → : raccourcit ou allonge les notes sélectionnées d'une case de grille (geste standard
 * des piano rolls). Une note ne descend jamais sous une case (ni sous `min` s'il est plus petit).
 */
export function resizeNotesBy(notes: MidiNote[], ids: Set<string>, delta: number, cell: number): MidiNote[] {
  if (!ids.size || !delta) return notes;
  const min = Math.max(0.01, cell);
  return notes.map(n => {
    if (!ids.has(n.id)) return n;
    // Une note plus courte qu'une case passe d'abord à une case pleine.
    const base = n.duration < min - 1e-9 ? min : n.duration;
    const d = Math.max(min, Math.round((base + delta) * 1e9) / 1e9);
    return d === n.duration ? n : { ...n, duration: d };
  });
}

/**
 * Glisser en tenant Ctrl ou Maj : les notes saisies sont COPIÉES (l'original reste en place), comme
 * dans les piano rolls des autres logiciels. Renvoie les notes de départ + les copies (nouvel id)
 * et la table original → copie, pour déplacer ensuite les copies comme une sélection normale.
 */
export function copyForDrag(notes: MidiNote[], ids: Set<string>, makeId: () => string = newNoteId): { notes: MidiNote[]; copies: Map<string, string> } {
  const copies = new Map<string, string>();
  const added: MidiNote[] = [];
  for (const n of notes) {
    if (!ids.has(n.id)) continue;
    const id = makeId();
    copies.set(n.id, id);
    added.push({ ...n, id });
  }
  return { notes: [...notes, ...added], copies };
}

/** Presse-papiers de notes : départs relatifs à la première note copiée. */
export interface NoteClipboard { notes: Omit<MidiNote, 'id'>[]; span: number }

export function copyNotes(notes: MidiNote[], ids: Set<string>): NoteClipboard | null {
  const sel = notes.filter(n => ids.has(n.id));
  if (!sel.length) return null;
  const from = Math.min(...sel.map(n => n.start));
  const end = Math.max(...sel.map(n => n.start + n.duration));
  return { notes: sel.map(({ id, isSelected, ...rest }) => { void id; void isSelected; return { ...rest, start: rest.start - from }; }), span: end - from };
}

/** Colle le presse-papiers à `at` (s, dans le clip). */
export function pasteNotes(notes: MidiNote[], clip: NoteClipboard, at: number, makeId: () => string = newNoteId): { notes: MidiNote[]; added: MidiNote[] } {
  const added = clip.notes.map(n => ({ ...n, id: makeId(), start: Math.max(0, Math.round((at + n.start) * 1e9) / 1e9) } as MidiNote));
  return { notes: [...notes, ...added].sort(byTime), added };
}

// ---------------------------------------------------------------------------
// Humaniser
// ---------------------------------------------------------------------------

export interface HumanizeParams {
  /** Décalage maximal du départ (ms, ±). */
  timingMs: number;
  /** Variation maximale de vélocité (0-1, ±). */
  velocity: number;
  /** Variation maximale de longueur (fraction, ±). */
  length?: number;
  /** Graine : même graine = même résultat (aperçu, tests, collaboration). */
  seed?: number;
}

/**
 * Humaniser : petits décalages aléatoires de temps, de vélocité et de longueur
 * (Live 12 : Velocity Deviation, FL : Randomize, Logic : Humanize). Les notes
 * d'un même accord bougent ensemble en temps (sinon l'accord se désagrège),
 * chacune garde sa vélocité propre. Sans sélection : tout le clip.
 */
export function humanize(notes: MidiNote[], ids: Set<string> | null | undefined, p: HumanizeParams): MidiNote[] {
  const rand = seededRandom(p.seed ?? 0x5eed);
  const all = !ids || ids.size === 0;
  const shiftOf = new Map<number, number>();
  const tMax = Math.max(0, p.timingMs) / 1000;
  return notes.map(n => {
    if (!all && !ids!.has(n.id)) return n;
    const key = Math.round(n.start * 1000);
    let dt = shiftOf.get(key);
    if (dt === undefined) { dt = (rand() * 2 - 1) * tMax; shiftOf.set(key, dt); }
    const dv = (rand() * 2 - 1) * Math.max(0, p.velocity);
    const dl = (rand() * 2 - 1) * Math.max(0, p.length || 0);
    return {
      ...n,
      start: Math.max(0, n.start + dt),
      velocity: clamp(n.velocity + dv, 0.05, 1),
      duration: Math.max(0.01, n.duration * (1 + dl)),
    };
  }).sort(byTime);
}

/** Vélocité aléatoire entre `min` et `max` (0-1) : la vélocité des hi-hats trap. */
export function randomVelocity(notes: MidiNote[], ids: Set<string> | null | undefined, min: number, max: number, seed = 0x7e1): MidiNote[] {
  const rand = seededRandom(seed);
  const lo = clamp(Math.min(min, max), 0.01, 1), hi = clamp(Math.max(min, max), 0.01, 1);
  const all = !ids || ids.size === 0;
  return notes.map(n => (all || ids!.has(n.id) ? { ...n, velocity: lo + (hi - lo) * rand() } : n));
}

// ---------------------------------------------------------------------------
// Glissés (FL : Slide notes)
// ---------------------------------------------------------------------------

/** Bascule le glissé des notes `ids` : toutes deviennent glissées, ou toutes redeviennent normales. */
export function toggleSlide(notes: MidiNote[], ids: Set<string>): { notes: MidiNote[]; on: boolean; count: number } {
  const target = notes.filter(n => ids.has(n.id));
  const on = target.some(n => !n.slide);
  const next = notes.map(n => {
    if (!ids.has(n.id)) return n;
    if (on) return { ...n, slide: true };
    const { slide, ...rest } = n; void slide;
    return rest;
  });
  return { notes: next, on, count: target.length };
}

const absorbedCache = new WeakMap<MidiNote[], Set<MidiNote>>();

/**
 * Glissés « portés » : notes glissées qui commencent PENDANT une autre note
 * (non glissée, ou glissée elle-même portée) du même clip. Celles-là ne se
 * rejouent pas : elles font glisser la note en cours. Une note glissée seule
 * (rien ne sonne à son départ) se joue comme une note normale.
 * Décidé d'après les notes seules (pas l'ordre de programmation) : lecture et
 * export prennent la même décision. Mémorisé par tableau de notes.
 */
export function absorbedSlides(notes: MidiNote[]): Set<MidiNote> {
  const hit = absorbedCache.get(notes);
  if (hit) return hit;
  const out = new Set<MidiNote>();
  if (notes.some(n => n.slide)) {
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    const EPS = 1e-6;
    // Notes qui sonnent (attaquées) : un glissé ne prolonge pas la note qu'il porte.
    const hosts: MidiNote[] = [];
    for (const n of sorted) {
      if (n.slide && hosts.some(h => h.start < n.start - EPS && h.start + h.duration > n.start + EPS)) { out.add(n); continue; }
      hosts.push(n);
    }
  }
  absorbedCache.set(notes, out);
  return out;
}

/** Hauteur d'où part chaque glissé porté (pour dessiner la courbe du glissé). */
export function slideOrigins(notes: MidiNote[]): Map<string, number> {
  const abs = absorbedSlides(notes);
  const out = new Map<string, number>();
  if (!abs.size) return out;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const EPS = 1e-6;
  // Hauteur courante de chaque note qui sonne (un glissé la change).
  const cur = new Map<MidiNote, number>();
  for (const n of sorted) {
    if (!abs.has(n)) { cur.set(n, n.pitch); continue; }
    let host: MidiNote | null = null;
    for (const [h] of cur) if (h.start < n.start - EPS && h.start + h.duration > n.start + EPS && (!host || h.start > host.start)) host = h;
    if (host) { out.set(n.id, cur.get(host)!); cur.set(host, n.pitch); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Couleurs
// ---------------------------------------------------------------------------

/**
 * Couleur d'une note selon sa vélocité (Logic, Studio One) : violet (doux) →
 * bleu → vert → jaune → rouge (fort). Plus sombre en thème clair pour rester
 * lisible sur fond blanc.
 */
export function velocityColor(v: number, light = false): string {
  const x = clamp(Number.isFinite(v) ? v : 0.8, 0, 1);
  const hue = Math.round(265 * (1 - x));
  return `hsl(${hue} ${light ? 75 : 85}% ${light ? 42 : 58}%)`;
}

/**
 * Texte lisible sur une couleur de note : noir ou blanc, celui qui contraste le plus avec la
 * couleur RÉELLE (velocityColor). Avant, un seuil sur la teinte laissait du blanc sur l'orange
 * du thème clair (« La0 » à 4,1:1, sous le 4,5:1 demandé pour un texte de 8 px).
 */
export function inkOn(v: number, light = false): string {
  const x = clamp(Number.isFinite(v) ? v : 0.8, 0, 1);
  const h = Math.round(265 * (1 - x)) / 360, s = light ? 0.75 : 0.85, l = light ? 0.42 : 0.58;
  // HSL → RGB (CSS Color 4), puis luminance relative (WCAG).
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(8)) + 0.0722 * lin(ch(4));
  const black = (lum + 0.05) / 0.05; // noir pur : au pire 4,58:1 au point de bascule
  const white = 1.05 / (lum + 0.05);
  return black >= white ? '#000000' : '#ffffff';
}
