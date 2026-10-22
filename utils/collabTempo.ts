/**
 * Collaboration (R2) : le tempo, la mesure et la piste tempo voyagent chez les
 * autres membres de la session (opération « tempo » du journal, la dernière
 * écriture gagne). Avant R2, changer le tempo ne partait chez personne : l'ingé
 * et l'artiste n'avaient plus la même grille ni le même clic.
 */
import type { DAWState, TimeSignature } from '../types';
import { tempoSignature, type TempoEvent } from './tempoMap';
import { sanitizeFollow, followTempo, keepAudioFor, isMidiClip, isWarpedClip, type TempoFollowWire, type FollowState, type TempoFollowReport } from './tempoFollow';

/**
 * `follow` (L3, absent d'une ancienne version) : le changement déplace le
 * contenu pour qu'il garde sa mesure (utils/tempoFollow). Chaque membre fait le
 * même calcul en le recevant ; l'option audio part avec lui.
 */
export interface TempoOp { bpm: number; timeSignature: TimeSignature; tempoEvents: TempoEvent[]; follow?: TempoFollowWire }

export const tempoOpOf = (s: Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents'>): TempoOp => ({
  bpm: s.bpm,
  timeSignature: { numerator: s.timeSignature?.numerator || 4, denominator: s.timeSignature?.denominator || 4 },
  tempoEvents: (s.tempoEvents || []).map(e => ({ ...e })),
});

export const tempoOpSig = (o: Pick<TempoOp, 'bpm' | 'timeSignature' | 'tempoEvents'>): string => tempoSignature(o.bpm, o.timeSignature, o.tempoEvents);

/** Opération reçue, nettoyée (valeurs hors bornes ou mal formées ignorées). Null si inutilisable. */
export function sanitizeTempoOp(raw: unknown): TempoOp | null {
  const r = raw as Record<string, any> | null;
  if (!r || typeof r !== 'object') return null;
  const bpm = Number(r.bpm);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) return null;
  const n = Number(r.timeSignature?.numerator), d = Number(r.timeSignature?.denominator);
  const ts: TimeSignature = { numerator: Number.isInteger(n) && n >= 1 && n <= 32 ? n : 4, denominator: [1, 2, 4, 8, 16, 32].includes(d) ? d : 4 };
  const events: TempoEvent[] = (Array.isArray(r.tempoEvents) ? r.tempoEvents : []).slice(0, 512).flatMap((e: any) => {
    const bar = Math.round(Number(e?.bar));
    if (!Number.isFinite(bar) || bar < 0 || bar > 100000) return [];
    const ev: TempoEvent = { id: typeof e.id === 'string' ? e.id.slice(0, 64) : `tempo-${bar}`, bar };
    const b = Number(e.bpm);
    if (Number.isFinite(b) && b >= 20 && b <= 999) ev.bpm = b;
    const en = Number(e.numerator), ed = Number(e.denominator);
    if (Number.isInteger(en) && en >= 1 && en <= 32 && [1, 2, 4, 8, 16, 32].includes(ed)) { ev.numerator = en; ev.denominator = ed; }
    if (e.ramp === true) ev.ramp = true;
    return [ev];
  });
  const follow = sanitizeFollow(r.follow);
  return { bpm, timeSignature: ts, tempoEvents: events, ...(follow ? { follow } : {}) };
}

/** Applique l'opération à l'état (même référence si rien ne change). */
export function applyTempoOp<S extends Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents'>>(state: S, op: TempoOp): S {
  if (tempoOpSig(tempoOpOf(state)) === tempoOpSig(op)) return state;
  return { ...state, bpm: op.bpm, timeSignature: op.timeSignature, tempoEvents: op.tempoEvents };
}

/**
 * Opération reçue avec `follow` (L3) : le tempo change ET le contenu garde sa
 * mesure, par le même calcul que chez l'auteur. Sans `follow` (ancienne
 * version, annulation) : le tempo seul, comme avant.
 */
export function applyTempoOpFollowing<S extends FollowState>(state: S, op: TempoOp): { state: S; report: TempoFollowReport | null } {
  if (tempoOpSig(tempoOpOf(state)) === tempoOpSig(op)) return { state, report: null };
  if (!op.follow) return { state: applyTempoOp(state, op), report: null };
  return followTempo(state, { bpm: op.bpm, timeSignature: op.timeSignature, tempoEvents: op.tempoEvents }, { keepAudio: op.follow.keepAudio, epoch: op.follow.id });
}

/**
 * Annuler / rétablir un changement de tempo : l'option « garder les clips audio à leur place »
 * du changement d'origine, retrouvée dans les deux états (un clip audio non calé qui a bougé :
 * l'audio suivait ; aucun n'a bougé : il était gardé). Sans clip audio non calé : réglage du projet.
 */
export function undoKeepsAudio(present: Pick<FollowState, 'tracks' | 'tempoAudioMode'>, target: Pick<FollowState, 'tracks'>): boolean {
  const before = new Map<string, number>();
  target.tracks.forEach(t => t.clips.forEach(c => before.set(c.id, c.start)));
  let seen = false;
  for (const t of present.tracks) for (const c of t.clips) {
    if (c.lock || isMidiClip(c) || isWarpedClip(c)) continue;
    const s = before.get(c.id);
    if (s === undefined) continue;
    if (Math.abs(s - c.start) > 1e-9) return false;
    seen = true;
  }
  return seen ? true : keepAudioFor(present);
}

/**
 * Collaboration · annuler / rétablir (Ctrl+Z, Ctrl+Y) un changement de tempo (22/10/2026) :
 * l'opération inverse part AVEC le suivi (`follow`, nouvel identifiant), comme le changement
 * lui-même. Avant, l'annulation renvoyait le tempo seul : chez les autres, les clips des pistes que
 * l'auteur ne possède pas restaient déplacés. Ici, l'auteur ne reprend pas l'instantané tel quel
 * pour le contenu : il fait le MÊME calcul que les autres (utils/tempoFollow) depuis le même état,
 * donc tout le monde arrive au même endroit (à la nanoseconde de l'instantané). Les réglages hors
 * temps (nom, groupes…) viennent de l'instantané. Null : l'étape ne change pas le tempo.
 */
export function tempoHistoryMove<S extends FollowState>(present: S, restored: S, o: { epoch: string; keepAudio: boolean }): { op: TempoOp; state: S } | null {
  const op = tempoOpOf(restored);
  if (tempoOpSig(op) === tempoOpSig(tempoOpOf(present))) return null;
  const f = followTempo(present, op, { keepAudio: o.keepAudio, epoch: o.epoch }).state;
  return {
    op: { ...op, follow: { id: o.epoch, keepAudio: o.keepAudio } },
    state: { ...restored, tracks: f.tracks, markers: f.markers, ...(f.chords !== undefined ? { chords: f.chords } : {}), loopStart: f.loopStart, loopEnd: f.loopEnd },
  };
}
