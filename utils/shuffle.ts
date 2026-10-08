import type { Clip, CrossfadeCurve } from '../types';
import { AUTO_XFADE_MAX_OVERLAP, autoCrossfadePatches } from './fades';
import { toSample } from './editModes';

/**
 * Mode Shuffle de Pro Tools : logique pure sur les clips d'UNE piste.
 *
 * - supprimer / couper un clip : les clips qui suivent reculent de sa longueur ;
 * - rogner : la fin du clip bouge et la suite suit (le début d'un clip rogné
 *   reste en place, comme dans Pro Tools) ;
 * - coller / insérer : ce qui suit le point d'insertion avance de la longueur
 *   collée (un clip coupé en deux par le point est séparé) ;
 * - déplacer : le clip quitte sa place (la suite se recolle) puis s'insère au
 *   bord de clip le plus proche (la suite avance) — les clips s'échangent.
 *
 * Crossfades : un crossfade est un chevauchement (utils/fades). Avant de
 * sortir un clip de la file, ses crossfades sont défaits proprement (jonction
 * remise au milieu de l'ancien chevauchement, fondus enlevés) ; après coup,
 * les nouvelles jonctions reçoivent le crossfade anti-clic automatique (si la
 * préférence est active). Les prises cachées qui suivent avancent ou reculent
 * avec le reste : les couloirs de prises restent alignés.
 *
 * Toutes les fonctions renvoient une NOUVELLE liste (rien n'est modifié) : une
 * opération Shuffle = un setState = une étape d'annulation = une opération de
 * collaboration par piste.
 */

const EPS = 1e-6;
/** Morceau le plus court qu'une insertion Shuffle accepte de couper (20 ms). */
const MIN_PIECE = 0.02;
const endOf = (c: Clip) => c.start + c.duration;

export interface ShuffleOptions {
  /** Crossfade anti-clic sur les nouvelles jonctions (préférence « Fondu enchaîné auto »). */
  autoXfade?: boolean;
  curve?: CrossfadeCurve;
  /** Durée de l'audio d'un clip (limite des rognages et des crossfades). */
  bufferDuration?: (c: Clip) => number | undefined;
  /** Fabrique d'identifiants (clips coupés en deux par une insertion). */
  makeId?: () => string;
}

let seq = 0;
const defaultId = () => `clip-shuf-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Clips actifs d'une piste qui forment une jonction en crossfade avec `r`. */
const isXfadePartner = (c: Clip, r: Clip) => !c.isMuted && !r.isMuted && c.id !== r.id;

/**
 * Défait les crossfades d'un clip avec ses voisins : la jonction revient au
 * milieu du chevauchement, les deux clips y sont rognés et perdent ce fondu.
 * `side` : 'left' (avec le clip d'avant), 'right' (d'après) ou 'both'.
 */
export function detachCrossfades(clips: Clip[], id: string, side: 'left' | 'right' | 'both' = 'both'): Clip[] {
  const r0 = clips.find(c => c.id === id);
  if (!r0) return clips;
  const out = clips.map(c => ({ ...c }));
  const R = out.find(c => c.id === id)!;
  const rS = r0.start, rE = endOf(r0);
  for (const c of out) {
    if (!isXfadePartner(c, r0)) continue;
    const cS = c.start, cE = endOf(c);
    // c avant r, qui le chevauche (crossfade c → r)
    if ((side === 'left' || side === 'both') && cS < rS - EPS && cE > rS + EPS && cE < rE - EPS && cE - rS <= AUTO_XFADE_MAX_OVERLAP + EPS) {
      const ov = cE - rS;
      const J = (rS + cE) / 2;
      c.fadeOut = (c.fadeOut || 0) >= ov - 1e-3 ? 0 : Math.min(c.fadeOut || 0, J - cS);
      c.duration = J - cS;
      c.fadeIn = Math.min(c.fadeIn || 0, c.duration);
      const cut = J - R.start;
      if (cut > 0) {
        R.offset = (R.offset || 0) + cut; R.duration -= cut; R.start = J;
      }
      R.fadeIn = (R.fadeIn || 0) >= ov - 1e-3 ? 0 : Math.min(R.fadeIn || 0, R.duration);
    }
    // c après r, qui le chevauche (crossfade r → c)
    if ((side === 'right' || side === 'both') && cS > rS + EPS && cS < rE - EPS && cE > rE + EPS && rE - cS <= AUTO_XFADE_MAX_OVERLAP + EPS) {
      const ov = rE - cS;
      const J = (cS + rE) / 2;
      const cut = J - cS;
      c.fadeIn = (c.fadeIn || 0) >= ov - 1e-3 ? 0 : Math.min(c.fadeIn || 0, c.duration - cut);
      c.offset = (c.offset || 0) + cut; c.duration -= cut; c.start = J;
      c.fadeOut = Math.min(c.fadeOut || 0, c.duration);
      R.fadeOut = (R.fadeOut || 0) >= ov - 1e-3 ? 0 : Math.min(R.fadeOut || 0, J - R.start);
      R.duration = J - R.start;
    }
  }
  R.fadeIn = Math.min(R.fadeIn || 0, R.duration);
  R.fadeOut = Math.min(R.fadeOut || 0, Math.max(0, R.duration - (R.fadeIn || 0)));
  return out;
}

/** Décale (delta) tous les clips qui commencent à `from` ou après (sauf `skip`). */
export function shiftFrom(clips: Clip[], from: number, delta: number, skip: Set<string> = new Set()): Clip[] {
  if (Math.abs(delta) < 1e-12) return clips;
  return clips.map(c => (!skip.has(c.id) && c.start >= from - EPS ? { ...c, start: Math.max(0, toSample(c.start + delta)) } : c));
}

/** Coupe en deux les clips qui traversent `at` (les deux morceaux perdent le fondu à la coupe). */
export function splitAt(clips: Clip[], at: number, makeId: () => string = defaultId): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if (c.start < at - EPS && endOf(c) > at + EPS) {
      const left = at - c.start;
      out.push({ ...c, duration: left, fadeOut: 0, fadeIn: Math.min(c.fadeIn || 0, left) });
      const right = c.duration - left;
      out.push({ ...c, id: makeId(), start: at, duration: right, offset: (c.offset || 0) + left, fadeIn: 0, fadeOut: Math.min(c.fadeOut || 0, right) });
    } else out.push(c);
  }
  return out;
}

/** Crossfades anti-clic sur les jonctions des clips touchés (préférence auto). */
export function recrossfade(clips: Clip[], touched: Set<string>, o: ShuffleOptions = {}): Clip[] {
  if (!o.autoXfade || !touched.size) return clips;
  const p = autoCrossfadePatches(clips, touched, o.curve || 'EQUAL_POWER', (c: any) => o.bufferDuration?.(c));
  if (!p.size) return clips;
  return clips.map(c => (p.has(c.id) ? { ...c, ...p.get(c.id)! } : c));
}

/** Clips actifs qui commencent ou finissent à `t` (jonctions à recroiser). */
const touchingAt = (clips: Clip[], t: number, into: Set<string>) => {
  clips.forEach(c => { if (!c.isMuted && (Math.abs(endOf(c) - t) < 1e-4 || Math.abs(c.start - t) < 1e-4)) into.add(c.id); });
};

/** Supprime (ou coupe) des clips en Shuffle : la suite recule de leur longueur. */
export function shuffleRemove(clips: Clip[], ids: string[], o: ShuffleOptions = {}): Clip[] {
  const wanted = new Set(ids);
  const targets = clips.filter(c => wanted.has(c.id)).sort((a, b) => b.start - a.start);
  let out = clips;
  const touched = new Set<string>();
  for (const t of targets) {
    out = detachCrossfades(out, t.id);
    const r = out.find(c => c.id === t.id)!;
    out = out.filter(c => c.id !== t.id);
    out = shiftFrom(out, endOf(r), -r.duration);
    touched.forEach(id => { if (!out.some(c => c.id === id)) touched.delete(id); });
    touchingAt(out, r.start, touched);
  }
  return recrossfade(out, touched, o);
}

/** Bornes de rognage d'un clip (début de l'audio, fin de l'audio). */
const audioBounds = (c: Clip, o: ShuffleOptions) => {
  const len = o.bufferDuration?.(c);
  return { minOffset: 0, maxEnd: len !== undefined ? c.start - (c.offset || 0) + len : Infinity };
};

/** Rogne la FIN d'un clip en Shuffle : la suite avance ou recule d'autant. */
export function shuffleTrimEnd(clips: Clip[], id: string, newEnd: number, o: ShuffleOptions = {}): Clip[] {
  let out = detachCrossfades(clips, id, 'right');
  const r = out.find(c => c.id === id);
  if (!r) return clips;
  const oldEnd = endOf(r);
  const end = Math.max(r.start + 0.01, Math.min(audioBounds(r, o).maxEnd, toSample(newEnd)));
  const delta = end - oldEnd;
  out = shiftFrom(out, oldEnd, delta, new Set([id]));
  out = out.map(c => (c.id === id ? { ...c, duration: end - c.start, fadeOut: Math.min(c.fadeOut || 0, end - c.start) } : c));
  const touched = new Set<string>([id]);
  touchingAt(out, end, touched);
  return recrossfade(out, touched, o);
}

/**
 * Rogne le DÉBUT d'un clip en Shuffle : le clip reste à sa place, son audio
 * commence plus tard (ou plus tôt) et la suite recule (ou avance) d'autant.
 * `newStart` = où l'utilisateur a posé le bord gauche.
 */
export function shuffleTrimStart(clips: Clip[], id: string, newStart: number, o: ShuffleOptions = {}): Clip[] {
  let out = detachCrossfades(clips, id, 'left');
  const r = out.find(c => c.id === id);
  if (!r) return clips;
  const oldEnd = endOf(r);
  let amount = toSample(newStart) - r.start;           // > 0 : on enlève du début
  amount = Math.max(-(r.offset || 0), Math.min(r.duration - 0.01, amount));
  out = shiftFrom(out, oldEnd, -amount, new Set([id]));
  out = out.map(c => (c.id === id ? {
    ...c, offset: (c.offset || 0) + amount, duration: c.duration - amount,
    fadeIn: Math.min(c.fadeIn || 0, c.duration - amount),
  } : c));
  const touched = new Set<string>([id]);
  touchingAt(out, r.start, touched);
  touchingAt(out, oldEnd - amount, touched);
  return recrossfade(out, touched, o);
}

/**
 * Ouvre un trou de `len` secondes à `at` (pour coller / insérer en Shuffle).
 * Un point d'insertion tombé dans un crossfade va à la jonction (le crossfade
 * est défait) ; à 1 ms d'un bord de clip, il se colle à ce bord. Renvoie le
 * point d'insertion retenu.
 */
export function openGapAt(clips: Clip[], at: number, len: number, o: ShuffleOptions = {}): { clips: Clip[]; at: number } {
  let out = clips;
  let pos = Math.max(0, at);
  // Pas de miette : un point à moins de 20 ms d'un bord de clip va sur ce bord.
  for (const c of clips) {
    if (c.isMuted || !(c.start < pos && endOf(c) > pos)) continue;
    if (pos - c.start < MIN_PIECE) pos = c.start;
    else if (endOf(c) - pos < MIN_PIECE) pos = endOf(c);
  }
  for (const a of clips) {
    if (a.isMuted) continue;
    const aE = endOf(a);
    const b = clips.find(x => !x.isMuted && x.id !== a.id && x.start > a.start + EPS && x.start < aE - EPS && endOf(x) > aE + EPS && aE - x.start <= AUTO_XFADE_MAX_OVERLAP + EPS);
    if (b && pos >= b.start - EPS && pos <= aE + EPS) {
      out = detachCrossfades(out, a.id, 'right');
      pos = (b.start + aE) / 2;
      break;
    }
  }
  for (const c of out) {
    if (c.isMuted) continue;
    for (const t of [c.start, endOf(c)]) if (Math.abs(t - pos) < 0.001) pos = t;
  }
  out = splitAt(out, pos, o.makeId || defaultId);
  return { clips: shiftFrom(out, pos, len), at: pos };
}

export const openGap = (clips: Clip[], at: number, len: number, o: ShuffleOptions = {}): Clip[] => openGapAt(clips, at, len, o).clips;

/** Insère des clips (positionnés à partir de `at`) en Shuffle : la suite avance. */
export function shuffleInsert(clips: Clip[], inserted: Clip[], at: number, o: ShuffleOptions = {}): Clip[] {
  if (!inserted.length) return clips;
  const len = Math.max(...inserted.map(c => endOf(c))) - at;
  const g = openGapAt(clips, at, len, o);
  const d = g.at - at;
  const placed = Math.abs(d) > 1e-12 ? inserted.map(c => ({ ...c, start: c.start + d })) : inserted;
  const out = [...g.clips, ...placed];
  const touched = new Set(placed.map(c => c.id));
  touchingAt(out, g.at, touched);
  touchingAt(out, g.at + len, touched);
  return recrossfade(out, touched, o);
}

/** Bords où un clip peut atterrir en Shuffle (débuts et fins des clips actifs). */
export function shuffleBoundaries(clips: Clip[]): number[] {
  const set = new Set<number>();
  clips.forEach(c => { if (!c.isMuted) { set.add(+c.start.toFixed(9)); set.add(+endOf(c).toFixed(9)); } });
  return Array.from(set).filter(t => t >= 0).sort((a, b) => a - b);
}

/**
 * Déplace un clip en Shuffle : il quitte sa place (la suite se recolle) et
 * s'insère au bord le plus proche de `rawStart` (la suite avance). Toujours
 * calculé depuis l'état du DÉBUT du glissement (pas d'accumulation).
 */
export function shuffleMove(clips: Clip[], id: string, rawStart: number, o: ShuffleOptions = {}): { clips: Clip[]; start: number } {
  let out = detachCrossfades(clips, id);
  const r = out.find(c => c.id === id);
  if (!r) return { clips, start: rawStart };
  out = out.filter(c => c.id !== id);
  out = shiftFrom(out, endOf(r), -r.duration);
  const candidates = [r.start, ...shuffleBoundaries(out)];
  let at = candidates[0], best = Infinity;
  for (const b of candidates) { const d = Math.abs(b - rawStart); if (d < best - 1e-9) { best = d; at = b; } }
  const moved: Clip = { ...r, start: at };
  return { clips: shuffleInsert(out, [moved], at, o), start: at };
}

/** Après l'effacement d'une plage [s, e] : ce qui suivait recule de e - s. */
export function closeRange(clips: Clip[], s: number, e: number, o: ShuffleOptions = {}): Clip[] {
  const out = shiftFrom(clips, e, -(e - s));
  const touched = new Set<string>();
  touchingAt(out, s, touched);
  return recrossfade(out, touched, o);
}

/** Piste vue par un déplacement Shuffle de groupe (ordre de l'arrangement). */
export interface ShuffleTrackIn {
  id: string;
  /** Genre de piste : un clip ne change de piste que vers une piste du même genre (audio / MIDI). */
  kind: string;
  clips: Clip[];
}

/**
 * Déplace TOUTE une sélection en Shuffle, comme Pro Tools : les clips choisis
 * quittent leurs pistes (chaque piste se recolle), puis s'insèrent ensemble au
 * bord le plus proche sur la piste d'arrivée (la suite avance), en gardant
 * leurs écarts. `trackShift` : nombre de pistes vers le bas (négatif : vers le
 * haut) ; refusé (0) si une piste d'arrivée manque ou n'est pas du même genre.
 * Toujours calculé depuis l'état du DÉBUT du glissement. Renvoie les nouvelles
 * listes des pistes touchées : à appliquer en UN setState (une annulation).
 */
export function shuffleMoveGroup(
  tracks: ShuffleTrackIn[], ids: string[], anchorId: string, rawStart: number, trackShift = 0, o: ShuffleOptions = {},
): { tracks: Map<string, Clip[]>; start: number; trackShift: number } | null {
  const wanted = new Set(ids);
  wanted.add(anchorId);
  const ai = tracks.findIndex(t => t.clips.some(c => c.id === anchorId));
  if (ai < 0) return null;
  const sources = tracks.map((t, i) => ({ i, sel: t.clips.filter(c => wanted.has(c.id)) })).filter(s => s.sel.length);
  // Piste d'arrivée valable pour chaque piste de départ ? Sinon, on reste sur place.
  const ok = (sh: number) => sources.every(s => { const d = tracks[s.i + sh]; return !!d && d.kind === tracks[s.i].kind; });
  const shift = trackShift && ok(trackShift) ? trackShift : 0;

  // 1. Retrait : crossfades défaits, clips sortis, chaque piste se recolle.
  const work = new Map<string, Clip[]>();
  const moved = new Map<number, Clip[]>();
  for (const s of sources) {
    let out = tracks[s.i].clips;
    for (const c of s.sel) out = detachCrossfades(out, c.id);
    const sel = out.filter(c => wanted.has(c.id));
    for (const r of [...sel].sort((a, b) => b.start - a.start)) {
      out = out.filter(c => c.id !== r.id);
      out = shiftFrom(out, endOf(r), -r.duration);
    }
    work.set(tracks[s.i].id, out);
    moved.set(s.i, sel);
  }
  const all = Array.from(moved.values()).flat();
  const blockStart = Math.min(...all.map(c => c.start));
  const anchor = all.find(c => c.id === anchorId)!;
  const anchorOff = anchor.start - blockStart;

  // 2. Point d'insertion : bord le plus proche sur la piste d'arrivée du clip saisi
  //    (ou sa place d'origine, ou le début du morceau sur une piste vide).
  const dest = tracks[ai + shift];
  const destClips = work.get(dest.id) ?? dest.clips;
  const candidates = [blockStart, ...shuffleBoundaries(destClips), ...(destClips.some(c => !c.isMuted) ? [] : [0])];
  const want = rawStart - anchorOff;
  let at = candidates[0], best = Infinity;
  for (const b of candidates) { const d = Math.abs(b - want); if (d < best - 1e-9) { best = d; at = b; } }

  // 3. Insertion : chaque piste reçoit ses clips, mêmes écarts que dans la sélection.
  for (const s of sources) {
    const d = tracks[s.i + shift];
    const base = work.get(d.id) ?? d.clips;
    const placed = moved.get(s.i)!.map(c => ({ ...c, start: at + (c.start - blockStart) }));
    work.set(d.id, shuffleInsert(base, placed, at, o));
  }
  return { tracks: work, start: at + anchorOff, trackShift: shift };
}
