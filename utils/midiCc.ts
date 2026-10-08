/**
 * Contrôleurs MIDI d'un clip (R16) : pitch bend, modulation, sustain,
 * expression et tous les CC, comme les couloirs de contrôleurs de Pro Tools
 * (Controller lanes), le « Event editor » de FL Studio et les enveloppes MIDI
 * de Live.
 *
 * Stockage : `Clip.cc` = { clé → points } ; la clé vaut « pb » (pitch bend),
 * « at » (aftertouch de canal) ou « ccN » (N = 0-127). Chaque point garde son
 * instant en secondes DEPUIS LE DÉBUT DU CLIP (comme les notes) et sa valeur
 * MIDI brute : 0-127 pour un CC, −8192…8191 pour le pitch bend. Une valeur
 * tient jusqu'au point suivant (marches, comme le MIDI).
 *
 * Le sustain (CC64) est « cuit » dans la durée des notes à la lecture et à
 * l'export (applySustain) : chaque instrument de NOVA (synthé, 808, sampler,
 * VST rendu par le pont) entend la pédale, et lecture = export.
 *
 * Logique pure : tests/midiCc.test.ts.
 */
import type { Clip, MidiNote } from '../types';

export interface MidiCcPoint {
  /** Secondes depuis le début du clip. */
  t: number;
  /** Valeur MIDI brute : 0-127 (CC, aftertouch) ou −8192…8191 (pitch bend). */
  v: number;
}

export type MidiCcMap = Record<string, MidiCcPoint[]>;

export const PB = 'pb';
export const AT = 'at';
export const ccKey = (n: number) => `cc${Math.max(0, Math.min(127, Math.round(n)))}`;
export const SUSTAIN = ccKey(64);
export const MODWHEEL = ccKey(1);
export const VOLUME = ccKey(7);
export const PAN = ccKey(10);
export const EXPRESSION = ccKey(11);
export const BRIGHTNESS = ccKey(74);

/** Numéro de CC d'une clé (null pour pb / at). */
export const ccNumber = (key: string): number | null => {
  const m = /^cc(\d{1,3})$/.exec(key);
  return m ? Number(m[1]) : null;
};

export const isPitchBend = (key: string) => key === PB;
export const isSwitchCc = (key: string) => key === SUSTAIN || key === ccKey(65) || key === ccKey(66) || key === ccKey(67);

/** Bornes de la valeur d'un couloir. */
export const ccRange = (key: string): { min: number; max: number } => (key === PB ? { min: -8192, max: 8191 } : { min: 0, max: 127 });

/** Valeur au repos (avant le premier point du clip). */
export const ccDefault = (key: string): number => {
  if (key === PB) return 0;
  if (key === VOLUME || key === EXPRESSION) return 127;
  if (key === PAN || key === BRIGHTNESS) return 64;
  return 0;
};

const CC_NAMES: Record<number, string> = {
  0: 'Banque (MSB)', 1: 'Modulation', 2: 'Souffle', 4: 'Pédale', 5: 'Portamento (durée)', 7: 'Volume', 8: 'Balance', 10: 'Pan',
  11: 'Expression', 64: 'Sustain', 65: 'Portamento', 66: 'Sostenuto', 67: 'Pédale douce', 71: 'Résonance', 72: 'Relâchement',
  73: 'Attaque', 74: 'Brillance', 91: 'Réverbe', 93: 'Chorus',
};

/** Libellé français d'un couloir (« Sustain (CC64) », « Pitch bend »). */
export const ccLabel = (key: string): string => {
  if (key === PB) return 'Pitch bend';
  if (key === AT) return 'Aftertouch';
  const n = ccNumber(key);
  if (n === null) return key;
  return CC_NAMES[n] ? `${CC_NAMES[n]} (CC${n})` : `CC${n}`;
};

/** Libellé court (liste des couloirs, colonne étroite du piano roll). */
export const ccShortLabel = (key: string): string => {
  if (key === PB) return 'Pitch bend';
  if (key === AT) return 'Aftertouch';
  const n = ccNumber(key);
  if (n === null) return key;
  return CC_NAMES[n] ? CC_NAMES[n] : `CC${n}`;
};

/** Couloirs proposés d'office dans le piano roll (les autres : « CC… »). */
export const COMMON_LANES = [PB, MODWHEEL, SUSTAIN, EXPRESSION, VOLUME, BRIGHTNESS, PAN, AT];

export const clampCc = (key: string, v: number): number => {
  const { min, max } = ccRange(key);
  return Math.max(min, Math.min(max, Math.round(v)));
};

/** Points triés (copie seulement si nécessaire). */
export const sortPoints = (pts: MidiCcPoint[]): MidiCcPoint[] => {
  for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t) return [...pts].sort((a, b) => a.t - b.t);
  return pts;
};

/** Valeur tenue à l'instant t (dernier point ≤ t), sinon `def`. */
export function ccValueAt(pts: MidiCcPoint[] | undefined, t: number, def: number): number {
  if (!pts || !pts.length) return def;
  let lo = 0, hi = pts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? def : pts[ans].v;
}

/** Points dont l'instant est dans [a, b[. */
export const pointsBetween = (pts: MidiCcPoint[] | undefined, a: number, b: number): MidiCcPoint[] =>
  (pts || []).filter(p => p.t >= a - 1e-9 && p.t < b - 1e-9);

/** Le clip a-t-il des contrôleurs ? */
export const hasCc = (c: Pick<Clip, 'cc'> | undefined | null): boolean =>
  !!c?.cc && Object.values(c.cc).some(p => Array.isArray(p) && p.length > 0);

// ---------------------------------------------------------------------------
// Sustain : la pédale allonge les notes
// ---------------------------------------------------------------------------

export const pedalDown = (v: number) => v >= 64;

/**
 * Notes allongées par la pédale de sustain : une note relâchée pédale
 * enfoncée tient jusqu'au relâchement de la pédale, ou jusqu'à la prochaine
 * attaque de la même touche (comme un piano : la note est rejouée), et au
 * plus jusqu'à `limit` (fin du clip). Les notes muettes sont gardées telles
 * quelles (filtrées ailleurs).
 */
export function applySustain(notes: MidiNote[], pedal: MidiCcPoint[] | undefined, limit = Infinity): MidiNote[] {
  if (!pedal || !pedal.length || !notes.length) return notes;
  const pts = sortPoints(pedal);
  // Instants où la pédale remonte (passage ≥ 64 → < 64).
  const ups: number[] = [];
  let down = false;
  for (const p of pts) {
    const d = pedalDown(p.v);
    if (down && !d) ups.push(p.t);
    down = d;
  }
  const nextUp = (t: number): number => {
    for (const u of ups) if (u > t + 1e-9) return u;
    return limit;
  };
  // Prochaine attaque de la même touche, par note.
  const byPitch = new Map<number, number[]>();
  for (const n of notes) {
    if (n.muted) continue;
    const arr = byPitch.get(n.pitch) || [];
    arr.push(n.start);
    byPitch.set(n.pitch, arr);
  }
  byPitch.forEach(a => a.sort((x, y) => x - y));
  let changed = false;
  const out = notes.map(n => {
    if (n.muted) return n;
    const end = n.start + n.duration;
    if (!pedalDown(ccValueAt(pts, end, 0))) return n;
    let to = nextUp(end);
    const starts = byPitch.get(n.pitch) || [];
    for (const s of starts) if (s > n.start + 1e-9) { to = Math.min(to, s); break; }
    to = Math.min(to, limit);
    if (to <= end + 1e-9) return n;
    changed = true;
    return { ...n, duration: to - n.start };
  });
  return changed ? out : notes;
}

const playableCache = new WeakMap<MidiNote[], { pedal: MidiCcPoint[] | undefined; limit: number; out: MidiNote[] }>();

/**
 * Notes qu'on entend d'un clip : sans les notes muettes (Pro Tools : Mute
 * Notes), pédale de sustain appliquée. Renvoie le MÊME tableau quand rien ne
 * change (les caches du moteur restent valables). Mémorisé.
 */
export function playableNotes(clip: Pick<Clip, 'notes' | 'cc' | 'duration'>): MidiNote[] {
  const notes = clip.notes || [];
  const pedal = clip.cc?.[SUSTAIN];
  const limit = clip.duration > 0 ? clip.duration : Infinity;
  const hit = playableCache.get(notes);
  if (hit && hit.pedal === pedal && hit.limit === limit) return hit.out;
  const anyMuted = notes.some(n => n.muted);
  const base = anyMuted ? notes.filter(n => !n.muted) : notes;
  const out = pedal && pedal.length ? applySustain(base, pedal, limit) : base;
  playableCache.set(notes, { pedal, limit, out });
  return out;
}

// ---------------------------------------------------------------------------
// Édition des couloirs (crayon, ligne) et découpe des clips
// ---------------------------------------------------------------------------

/** Remplace les points de [from, to] par `fresh` (triés). */
export function replacePoints(pts: MidiCcPoint[] | undefined, from: number, to: number, fresh: MidiCcPoint[]): MidiCcPoint[] {
  const a = Math.min(from, to), b = Math.max(from, to);
  const kept = (pts || []).filter(p => p.t < a - 1e-9 || p.t > b + 1e-9);
  return sortPoints([...kept, ...fresh]);
}

/**
 * Ligne droite de (t0, v0) à (t1, v1), un point tous les `step` s (outil
 * Ligne de Pro Tools). Les valeurs répétées sont sautées.
 */
export function linePoints(key: string, t0: number, v0: number, t1: number, v1: number, step: number): MidiCcPoint[] {
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  const va = t0 <= t1 ? v0 : v1, vb = t0 <= t1 ? v1 : v0;
  const out: MidiCcPoint[] = [];
  const n = Math.max(1, Math.ceil((b - a) / Math.max(1e-3, step)));
  let last: number | null = null;
  for (let i = 0; i <= n; i++) {
    const t = i === n ? b : a + i * ((b - a) / n);
    const raw = va + (vb - va) * (n ? i / n : 1);
    const v = isSwitchCc(key) ? (raw >= 64 ? 127 : 0) : clampCc(key, raw);
    if (v !== last || i === n) out.push({ t: Math.max(0, t), v });
    last = v;
  }
  return out;
}

/** Allège une suite de points (enregistrement) : un point par `minDt` s au plus, sauf grands sauts. */
export function thinPoints(pts: MidiCcPoint[], minDt = 0.004): MidiCcPoint[] {
  const s = sortPoints(pts);
  const out: MidiCcPoint[] = [];
  for (const p of s) {
    const prev = out[out.length - 1];
    if (prev && prev.v === p.v) continue;
    if (prev && p.t - prev.t < minDt) { out[out.length - 1] = { t: prev.t, v: p.v }; continue; }
    out.push(p);
  }
  // La dernière valeur doit être la vraie (retour du pitch bend à 0).
  if (s.length && out.length && out[out.length - 1].v !== s[s.length - 1].v) out.push(s[s.length - 1]);
  return out;
}

/** Décale tous les points (clip qui commence plus tôt : shift > 0). */
export function shiftCc(cc: MidiCcMap | undefined, shift: number): MidiCcMap | undefined {
  if (!cc) return cc;
  const out: MidiCcMap = {};
  for (const [k, pts] of Object.entries(cc)) out[k] = pts.map(p => ({ t: p.t + shift, v: p.v }));
  return out;
}

/**
 * Découpe des contrôleurs d'un clip coupé en `at` (secondes dans le clip) :
 * la partie droite repart de 0, avec la valeur tenue à la coupure.
 */
export function splitCc(cc: MidiCcMap | undefined, at: number): [MidiCcMap | undefined, MidiCcMap | undefined] {
  if (!cc) return [cc, cc];
  const left: MidiCcMap = {}, right: MidiCcMap = {};
  for (const [k, raw] of Object.entries(cc)) {
    const pts = sortPoints(raw || []);
    const l = pts.filter(p => p.t < at - 1e-9);
    const r = pts.filter(p => p.t >= at - 1e-9).map(p => ({ t: p.t - at, v: p.v }));
    const held = ccValueAt(pts, at, ccDefault(k));
    if (l.length) left[k] = l;
    if (r.length || held !== ccDefault(k)) {
      if (!r.length || r[0].t > 1e-9) r.unshift({ t: 0, v: held });
      right[k] = r;
    }
  }
  return [Object.keys(left).length ? left : undefined, Object.keys(right).length ? right : undefined];
}

// ---------------------------------------------------------------------------
// Effet des contrôleurs sur les instruments de NOVA
// ---------------------------------------------------------------------------

/** Ampleur du pitch bend des instruments de NOVA (± 2 demi-tons, comme FL et Live). */
export const DEFAULT_BEND_RANGE = 2;

/** Pitch bend (−8192…8191) → cents. */
export const bendCents = (v: number, range = DEFAULT_BEND_RANGE): number => (v / (v < 0 ? 8192 : 8191)) * range * 100;

/** Modulation (CC1) → profondeur du vibrato en cents (jusqu'à ± 50 cents). */
export const modCents = (v: number): number => (Math.max(0, Math.min(127, v)) / 127) * 50;

/** Volume / expression (CC7, CC11) → gain (courbe MIDI : 40 log10(v/127) dB). */
export const ccGain = (v: number): number => {
  const x = Math.max(0, Math.min(127, v)) / 127;
  return x * x;
};

/** Brillance (CC74) → décalage du filtre en cents (± 2 octaves autour de 64). */
export const brightnessCents = (v: number): number => ((Math.max(0, Math.min(127, v)) - 64) / 64) * 2400;
