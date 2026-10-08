import { Clip, CrossfadeCurve, TrackType } from '../types';
import { breathGainAt, breathRampsInClip, clipHasBreaths } from './breathEnvelope';
import { envelopeGainAt, envelopeRampsInClip, hasGainPoints } from './clipGain';
import { timeGridStep } from './grid';

/**
 * Fondus et crossfades « façon Pro Tools » : logique pure, partagée par la
 * lecture (AudioEngine.playClipSource) et l'export (AudioEngine.renderProject).
 * Les deux appliquent exactement le même plan de gain (clipGainEvents), donc
 * un fondu sonne pareil à l'écoute et dans le fichier exporté.
 *
 * Un crossfade n'est pas un objet à part : c'est un chevauchement de deux clips
 * d'une même piste, le premier en fondu de sortie, le second en fondu d'entrée,
 * de même longueur et de courbes complémentaires (comme un crossfade Pro Tools
 * centré sur la jonction). Rien à ajouter au format du projet ni à la collab :
 * fadeIn / fadeOut / fadeInCurve / fadeOutCurve existent déjà sur Clip.
 */

export const FADE_CURVES: CrossfadeCurve[] = ['LINEAR', 'EQUAL_POWER', 'EXPONENTIAL', 'S_CURVE'];

/** Libellés (tutoiement) et équivalent Pro Tools de chaque courbe. */
export const FADE_CURVE_INFO: Record<CrossfadeCurve, { label: string; short: string; hint: string }> = {
  LINEAR: { label: 'Linéaire', short: 'Lin', hint: 'Gain égal (« Equal Gain » dans Pro Tools) : idéal entre deux morceaux du même son.' },
  EQUAL_POWER: { label: 'Puissance égale', short: 'PE', hint: 'Puissance égale (« Equal Power » dans Pro Tools) : pas de creux de niveau entre deux prises différentes.' },
  EXPONENTIAL: { label: 'Exponentielle', short: 'Exp', hint: 'Démarre doucement puis monte vite : naturel pour une fin de phrase ou une queue de reverb.' },
  S_CURVE: { label: 'En S', short: 'S', hint: 'Courbe en S (« S-Curve » dans Pro Tools) : entrée et sortie très douces.' },
};

/** Durée d'un crossfade posé par défaut (Smart Tool, Ctrl+F sur une jonction). */
export const DEFAULT_XFADE_SEC = 0.02;
/** Au-delà de ce chevauchement, on ne crossfade pas automatiquement (prises empilées). */
export const AUTO_XFADE_MAX_OVERLAP = 2;
/** Crossfade auto posé sur deux clips bout à bout (anti-clic). */
export const AUTO_XFADE_BUTT_SEC = 0.01;

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const EXP_FLOOR = 1e-3; // -60 dB

/**
 * Forme d'un fondu d'ENTRÉE : x = avancement dans le fondu (0 → 1), renvoie un
 * gain 0 → 1. Le fondu de sortie est la même courbe lue à l'envers.
 */
export function fadeInShape(curve: CrossfadeCurve | undefined, x: number): number {
  const t = clamp01(x);
  switch (curve) {
    case 'EQUAL_POWER': return Math.sin((t * Math.PI) / 2);
    case 'EXPONENTIAL': return t <= 0 ? 0 : clamp01((Math.pow(10, 3 * (t - 1)) - EXP_FLOOR) / (1 - EXP_FLOOR));
    case 'S_CURVE': return (1 - Math.cos(Math.PI * t)) / 2;
    case 'LINEAR':
    default: return t;
  }
}

/** Fondu de SORTIE : x = avancement (0 = début du fondu, gain 1 → 1 = fin, gain 0). */
export function fadeOutShape(curve: CrossfadeCurve | undefined, x: number): number {
  return fadeInShape(curve, 1 - clamp01(x));
}

/** Gain du clip (fondus + gain de clip) à la position t (s, depuis le début du clip). */
/** Champs d'un clip qui comptent pour son plan de gain (respirations traitées comprises). */
type GainClip = Pick<Clip, 'duration' | 'fadeIn' | 'fadeOut' | 'fadeInCurve' | 'fadeOutCurve' | 'gain'> & Partial<Pick<Clip, 'offset' | 'breaths' | 'isReversed' | 'gainPoints'>>;

export function clipGainAt(clip: GainClip, t: number): number {
  const { fi, fo } = fadeLengths(clip);
  let g = clip.gain ?? 1;
  // Respirations baissées / supprimées (utils/breaths) : zones de l'audio source.
  if (clip.breaths?.length && !clip.isReversed) g *= breathGainAt(clip.breaths, (clip.offset || 0) + t);
  // Ligne de gain du clip (utils/clipGain) : points en temps de l'audio source.
  if (clip.gainPoints?.length) g *= envelopeGainAt(clip.gainPoints, (clip.offset || 0) + t);
  if (fi > 0 && t < fi) g *= fadeInShape(clip.fadeInCurve, t / fi);
  if (fo > 0 && t > clip.duration - fo) g *= fadeOutShape(clip.fadeOutCurve, (t - (clip.duration - fo)) / fo);
  if (t < 0 || t > clip.duration) return 0;
  return g;
}

/** Longueurs de fondu effectives (jamais plus longues que le clip, jamais croisées). */
export function fadeLengths(clip: Pick<Clip, 'duration' | 'fadeIn' | 'fadeOut'>): { fi: number; fo: number } {
  const d = Math.max(0, clip.duration || 0);
  const fi = Math.max(0, Math.min(clip.fadeIn || 0, d));
  const fo = Math.max(0, Math.min(clip.fadeOut || 0, d - fi));
  return { fi, fo };
}

/** Évènement de gain, en secondes depuis le début du clip (position 0 du clip). */
export type GainEvent =
  | { kind: 'set'; t: number; v: number }
  | { kind: 'curve'; t: number; d: number; values: Float32Array };

/** Nombre de points d'une courbe : un toutes les ~2 ms, de 8 à 1024. */
export const curvePoints = (d: number) => Math.max(8, Math.min(1024, Math.ceil(d * 500) + 1));

function sampleCurve(fn: (x: number) => number, x0: number, x1: number, gain: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gain * fn(x0 + ((x1 - x0) * i) / (n - 1));
  return out;
}

/**
 * Plan de gain d'un clip joué à partir de la position `from` (s dans le clip) :
 * une valeur de départ, puis les courbes de fondu restantes. Les courbes sont
 * échantillonnées (setValueCurveAtTime) : même rendu en lecture et à l'export.
 * Jamais deux évènements qui se chevauchent (contrainte de la Web Audio API).
 */
export function clipGainEvents(
  clip: GainClip,
  from = 0,
): GainEvent[] {
  if (clipHasBreaths(clip) || hasGainPoints(clip)) return breathAwareGainEvents(clip, from);
  const d = Math.max(0, clip.duration || 0);
  const g = clip.gain ?? 1;
  const { fi, fo } = fadeLengths(clip);
  const p0 = Math.max(0, Math.min(from, d));
  const ev: GainEvent[] = [];
  const foStart = d - fo;
  // Pas de « set » au même instant qu'une courbe (Chrome refuse les évènements
  // superposés) : une courbe pose elle-même sa valeur de départ, et la valeur
  // reste tenue entre deux courbes.
  if (fi > 0 && p0 < fi) {
    const dur = fi - p0;
    ev.push({ kind: 'curve', t: p0, d: dur, values: sampleCurve(x => fadeInShape(clip.fadeInCurve, x), p0 / fi, 1, g, curvePoints(dur)) });
  } else if (!(fo > 0 && p0 >= foStart)) {
    ev.push({ kind: 'set', t: p0, v: clipGainAt(clip, p0) });
  }
  if (fo > 0) {
    const s = Math.max(p0, foStart);
    const dur = d - s;
    if (dur > 1e-6) {
      ev.push({ kind: 'curve', t: s, d: dur, values: sampleCurve(x => fadeOutShape(clip.fadeOutCurve, x), (s - foStart) / fo, 1, g, curvePoints(dur)) });
    } else if (!ev.length) {
      ev.push({ kind: 'set', t: p0, v: 0 });
    }
  }
  return ev;
}

/** Ligne de gain : un point toutes les ~2 ms jusqu'à 32 s de pente (points exacts à 0,1 dB près). */
const envelopeCurvePoints = (d: number) => Math.max(8, Math.min(16384, Math.ceil(d * 500) + 1));

/**
 * Plan de gain d'un clip dont des respirations sont traitées ou qui a une
 * ligne de gain : le gain (fondus × gain de clip × respirations × ligne) est
 * constant entre les zones où il varie (fondus du clip, fondus d'entrée /
 * sortie de chaque respiration, pentes de la ligne de gain). Une
 * courbe échantillonnée par zone qui varie, la valeur tenue entre deux : pas
 * d'évènements superposés, et le même rendu en lecture et à l'export.
 */
function breathAwareGainEvents(clip: GainClip, from: number): GainEvent[] {
  const d = Math.max(0, clip.duration || 0);
  const p0 = Math.max(0, Math.min(from, d));
  const { fi, fo } = fadeLengths(clip);
  const zones: [number, number][] = [];
  if (fi > 0) zones.push([0, fi]);
  if (fo > 0) zones.push([d - fo, d]);
  if (!clip.isReversed) zones.push(...breathRampsInClip(clip.breaths, clip.offset || 0, d));
  const env = hasGainPoints(clip);
  if (env) zones.push(...envelopeRampsInClip(clip.gainPoints, clip.offset || 0, d));
  zones.sort((a, b) => a[0] - b[0]);
  // Zones qui se touchent ou se chevauchent : une seule courbe.
  const merged: [number, number][] = [];
  for (const z of zones) {
    const last = merged[merged.length - 1];
    if (last && z[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], z[1]);
    else merged.push([z[0], z[1]]);
  }
  const ev: GainEvent[] = [];
  let first = true;
  for (const [a, b] of merged) {
    if (b <= p0 + 1e-6) continue;
    const s = Math.max(a, p0);
    if (first && s > p0 + 1e-6) ev.push({ kind: 'set', t: p0, v: clipGainAt(clip, p0) });
    first = false;
    const dur = b - s;
    const n = env ? envelopeCurvePoints(dur) : curvePoints(dur);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = clipGainAt(clip, Math.min(b, s + (dur * i) / (n - 1)));
    // Fin de clip : la dernière valeur tombe pile sur d (gain 0 hors clip) → valeur juste avant.
    if (b >= d - 1e-9 && n > 1) values[n - 1] = fo > 0 ? 0 : clipGainAt(clip, d - 1e-6);
    ev.push({ kind: 'curve', t: s, d: dur, values });
  }
  if (first) ev.push({ kind: 'set', t: p0, v: p0 >= d ? 0 : clipGainAt(clip, p0) });
  return ev;
}

/** Ce dont applyGainEvents a besoin d'un AudioParam (testable sans Web Audio). */
export interface GainParamLike {
  setValueAtTime(v: number, t: number): unknown;
  setValueCurveAtTime(values: Float32Array | number[], t: number, d: number): unknown;
  linearRampToValueAtTime?(v: number, t: number): unknown;
}

/**
 * Programme le plan de gain sur un AudioParam. `clipZero` = instant (horloge du
 * contexte) où le clip serait à sa position 0. Repli sur des rampes linéaires
 * par morceaux si le navigateur refuse une courbe.
 */
/** Avance de la valeur de départ d'une courbe (≈ 5 échantillons à 48 kHz). */
const PRE_CURVE_SEC = 1e-4;

export function applyGainEvents(param: GainParamLike, events: GainEvent[], clipZero: number): void {
  // La source peut démarrer un échantillon avant la courbe (arrondi à
  // l'échantillon) : sans valeur posée juste avant, ce premier échantillon
  // passait au gain par défaut (1) → un clic au début d'un fondu d'entrée.
  const first = events[0];
  if (first?.kind === 'curve' && clipZero + first.t > PRE_CURVE_SEC) param.setValueAtTime(first.values[0], clipZero + first.t - PRE_CURVE_SEC);
  for (const e of events) {
    const at = clipZero + e.t;
    if (e.kind === 'set') { param.setValueAtTime(e.v, at); continue; }
    try {
      param.setValueCurveAtTime(e.values, at, e.d);
    } catch {
      // Repli : segments linéaires (même forme à 2 ms près).
      const n = e.values.length;
      param.setValueAtTime(e.values[0], at);
      for (let i = 1; i < n; i++) param.linearRampToValueAtTime?.(e.values[i], at + (e.d * i) / (n - 1));
    }
  }
}

// ----------------------------------------------------------------- crossfades

type XClip = Pick<Clip, 'id' | 'start' | 'duration' | 'offset' | 'fadeIn' | 'fadeOut' | 'fadeInCurve' | 'fadeOutCurve' | 'isMuted' | 'type' | 'bufferId'> & { buffer?: { duration: number } };

const isAudioClip = (c: XClip) => c.type !== TrackType.MIDI && !!(c.bufferId || c.buffer);
const endOf = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration;

/** Limites de l'audio disponible autour d'un clip (« handles » de Pro Tools). */
export interface Handles { aMaxEnd: number; bMinStart: number }

/** Jonction entre deux clips d'une piste : a se termine sur (ou après) le début de b. */
export interface Junction { a: string; b: string; at: number; overlap: number }

/**
 * Jonctions d'une piste : paires de clips audio actifs qui se touchent (à `tol`
 * près) ou se chevauchent (sans que l'un contienne l'autre).
 */
export function findJunctions(clips: XClip[], tol = 0.002, maxOverlap = Infinity): Junction[] {
  const active = clips.filter(c => !c.isMuted && isAudioClip(c));
  // Un clip entièrement recouvert par un autre (prise cachée) n'a pas de jonction.
  const hidden = (c: XClip) => active.some(o => o !== c && o.start <= c.start + 1e-9 && endOf(o) >= endOf(c) - 1e-9 && (o.start < c.start || endOf(o) > endOf(c)));
  const list = active.filter(c => !hidden(c)).sort((x, y) => x.start - y.start);
  const out: Junction[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (b.start > endOf(a) + tol) break;
      if (endOf(b) <= endOf(a) + 1e-9) continue;           // b caché dans a : pas une jonction
      const overlap = endOf(a) - b.start;
      if (overlap > maxOverlap) continue;
      out.push({ a: a.id, b: b.id, at: overlap > tol ? (b.start + endOf(a)) / 2 : b.start, overlap: Math.max(0, overlap) });
    }
  }
  return out;
}

/** Jonction la plus proche d'un instant (Smart Tool : bas du clip, entre deux clips). */
export function junctionNear(clips: XClip[], time: number, tolSec: number): Junction | null {
  let best: Junction | null = null;
  let bestD = Infinity;
  for (const j of findJunctions(clips, Math.max(0.002, tolSec / 4))) {
    const d = Math.abs(j.at - time);
    if (d <= tolSec + j.overlap / 2 && d < bestD) { best = j; bestD = d; }
  }
  return best;
}

/** Limites d'audio d'un clip à partir de la durée de son buffer. */
export function handlesOf(a: XClip, b: XClip, bufferDuration: (c: XClip) => number | undefined): Handles {
  const da = bufferDuration(a);
  return {
    aMaxEnd: da !== undefined ? a.start - (a.offset || 0) + da : endOf(a),
    bMinStart: b.start - (b.offset || 0),
  };
}

/**
 * Crossfade de `length` secondes entre a (avant) et b (après), centré sur la
 * jonction comme dans Pro Tools ; si un clip n'a pas assez d'audio au-delà de
 * son bord, le crossfade glisse du côté où il y en a. Renvoie les
 * modifications à appliquer aux deux clips, ou null si impossible.
 */
export function makeCrossfade(
  a: XClip, b: XClip, length: number, curve: CrossfadeCurve, h: Handles,
): { a: Partial<Clip>; b: Partial<Clip>; start: number; end: number } | null {
  if (!(length > 0)) return null;
  const aEnd = endOf(a), bEnd = endOf(b);
  const overlap = aEnd - b.start;
  const J = overlap > 0.002 ? (b.start + aEnd) / 2 : b.start;
  const half = length / 2;
  const aMax = Math.max(aEnd, h.aMaxEnd);
  const bMin = Math.min(b.start, Math.max(0, h.bMinStart));
  let S = Math.max(J - half, bMin, a.start + 0.001);
  let E = Math.min(J + half, aMax, bEnd - 0.001);
  if (E - S < length - 1e-9) {
    if (E < J + half - 1e-9) S = Math.max(bMin, a.start + 0.001, E - length);
    if (S > J - half + 1e-9) E = Math.min(aMax, bEnd - 0.001, S + length);
  }
  const L = E - S;
  if (L < 0.001) return null;
  const aDur = E - a.start;
  const bDur = bEnd - S;
  return {
    start: S,
    end: E,
    a: {
      duration: aDur,
      fadeOut: L,
      fadeOutCurve: curve,
      fadeIn: Math.min(a.fadeIn || 0, Math.max(0, aDur - L)),
    },
    b: {
      start: S,
      offset: (b.offset || 0) - (b.start - S),
      duration: bDur,
      fadeIn: L,
      fadeInCurve: curve,
      fadeOut: Math.min(b.fadeOut || 0, Math.max(0, bDur - L)),
    },
  };
}

/**
 * Crossfade automatique après une édition (déplacement, rognage, collage) : les
 * clips modifiés qui chevauchent un voisin (≤ 2 s) reçoivent un crossfade sur
 * toute la zone commune ; deux clips bout à bout reçoivent un crossfade anti-clic
 * de 10 ms (si l'audio le permet). Les clips cachés dans un autre ne sont pas
 * touchés (prises empilées).
 */
export function autoCrossfadePatches(
  clips: XClip[], changedIds: Set<string>, curve: CrossfadeCurve,
  bufferDuration: (c: XClip) => number | undefined,
  opts: { maxOverlap?: number; buttLength?: number } = {},
): Map<string, Partial<Clip>> {
  const maxOverlap = opts.maxOverlap ?? AUTO_XFADE_MAX_OVERLAP;
  const butt = opts.buttLength ?? AUTO_XFADE_BUTT_SEC;
  const byId = new Map(clips.map(c => [c.id, { ...c }]));
  const patches = new Map<string, Partial<Clip>>();
  const merge = (id: string, p: Partial<Clip>) => {
    patches.set(id, { ...(patches.get(id) || {}), ...p });
    Object.assign(byId.get(id)!, p);
  };
  for (const j of findJunctions(clips, 0.0005, maxOverlap)) {
    if (!changedIds.has(j.a) && !changedIds.has(j.b)) continue;
    const a = byId.get(j.a)!, b = byId.get(j.b)!;
    if (j.overlap > 0.0005) {
      // Déjà en crossfade sur cette zone : on ne refait rien.
      if (Math.abs((a.fadeOut || 0) - j.overlap) < 1e-4 && Math.abs((b.fadeIn || 0) - j.overlap) < 1e-4) continue;
      merge(a.id, { fadeOut: j.overlap, fadeOutCurve: curve, fadeIn: Math.min(a.fadeIn || 0, Math.max(0, a.duration - j.overlap)) });
      merge(b.id, { fadeIn: j.overlap, fadeInCurve: curve, fadeOut: Math.min(b.fadeOut || 0, Math.max(0, b.duration - j.overlap)) });
    } else if (butt > 0) {
      const x = makeCrossfade(a, b, butt, curve, handlesOf(a, b, bufferDuration));
      if (x) { merge(a.id, x.a); merge(b.id, x.b); }
    }
  }
  return patches;
}

/** Crossfades d'une piste à dessiner (zone commune de deux clips en fondu croisé). */
export function crossfadeZones(clips: XClip[]): { a: string; b: string; start: number; end: number }[] {
  const out: { a: string; b: string; start: number; end: number }[] = [];
  const byId = new Map(clips.map(c => [c.id, c]));
  for (const j of findJunctions(clips, 0.0005)) {
    if (j.overlap <= 0.0005) continue;
    const a = byId.get(j.a)!, b = byId.get(j.b)!;
    if ((a.fadeOut || 0) >= j.overlap - 1e-3 && (b.fadeIn || 0) >= j.overlap - 1e-3) out.push({ a: a.id, b: b.id, start: b.start, end: endOf(a) });
  }
  return out;
}

// ---------------------------------------------------------------------- nudge

/** Pas du nudge (Pro Tools : « Nudge value »). */
export type NudgeUnit = 'GRID' | 'MS1' | 'MS10' | 'MS100' | 'FRAME' | 'BEAT' | 'BAR';

export const NUDGE_UNITS: { id: NudgeUnit; label: string }[] = [
  { id: 'GRID', label: 'Grille' },
  { id: 'MS1', label: '1 ms' },
  { id: 'MS10', label: '10 ms' },
  { id: 'MS100', label: '100 ms' },
  { id: 'FRAME', label: '1 image (30 i/s)' },
  { id: 'BEAT', label: '1 temps' },
  { id: 'BAR', label: '1 mesure' },
];

/** Durée d'un pas de nudge en secondes. `grid` = '1/4', '1/8', '1/16', '1/1'… */
export function nudgeSeconds(unit: NudgeUnit, bpm: number, grid = '1/4', fps = 30): number {
  const beat = 60 / (bpm > 0 ? bpm : 120);
  switch (unit) {
    case 'MS1': return 0.001;
    case 'MS10': return 0.01;
    case 'MS100': return 0.1;
    case 'FRAME': return 1 / fps;
    case 'BEAT': return beat;
    case 'BAR': return beat * 4;
    case 'GRID':
    default: {
      const tg = timeGridStep(grid);
      if (tg) return tg;
      const m = /^1\/(\d+)(t?)$/i.exec(grid || '');
      if (!m) return beat;
      const div = Number(m[1]) || 4;
      return (beat * 4) / div * (m[2] ? 2 / 3 : 1);
    }
  }
}

// ------------------------------------------------- fondus depuis une sélection

/**
 * « Créer des fondus » sur une plage (Ctrl+F de Pro Tools) : la plage couvre
 * une jonction → crossfade de la longueur de la plage, centré sur la jonction ;
 * elle couvre le début d'un clip → fondu d'entrée jusqu'à la fin de la plage ;
 * la fin d'un clip → fondu de sortie depuis le début de la plage.
 */
export function fadesForRange(
  clips: XClip[], s: number, e: number, curve: CrossfadeCurve,
  bufferDuration: (c: XClip) => number | undefined,
): Map<string, Partial<Clip>> {
  const out = new Map<string, Partial<Clip>>();
  const merge = (id: string, p: Partial<Clip>) => out.set(id, { ...(out.get(id) || {}), ...p });
  const byId = new Map(clips.map(c => [c.id, c]));
  const inXfade = new Set<string>();
  for (const j of findJunctions(clips, 0.002)) {
    if (j.at < s - 1e-6 || j.at > e + 1e-6) continue;
    const a = byId.get(j.a)!, b = byId.get(j.b)!;
    const x = makeCrossfade(a, b, Math.max(0.001, e - s), curve, handlesOf(a, b, bufferDuration));
    if (!x) continue;
    merge(a.id, x.a); merge(b.id, x.b);
    inXfade.add(`${a.id}:out`); inXfade.add(`${b.id}:in`);
  }
  for (const c of clips) {
    if (c.isMuted || !isAudioClip(c)) continue;
    const cEnd = endOf(c);
    if (!inXfade.has(`${c.id}:in`) && c.start >= s - 1e-6 && c.start < e && e < cEnd) {
      merge(c.id, { fadeIn: Math.min(e - c.start, c.duration - (c.fadeOut || 0)), fadeInCurve: curve });
    }
    if (!inXfade.has(`${c.id}:out`) && cEnd <= e + 1e-6 && cEnd > s && s > c.start) {
      merge(c.id, { fadeOut: Math.min(cEnd - s, c.duration - (out.get(c.id)?.fadeIn ?? c.fadeIn ?? 0)), fadeOutCurve: curve });
    }
  }
  return out;
}
