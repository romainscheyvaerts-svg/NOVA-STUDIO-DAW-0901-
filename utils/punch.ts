import { Clip, PunchSettings, TimeSignature } from '../types';

/**
 * Punch-in / punch-out, pré-roll / post-roll et QuickPunch « façon Pro Tools ».
 * Logique pure (testée dans tests/punch.test.ts) ; App.tsx ne fait que brancher.
 *
 * - Les points de punch sont indépendants de la boucle (posés dans la règle ou
 *   depuis la sélection).
 * - Pré-roll : la lecture repart avant le point d'entrée, l'enregistrement ne
 *   garde que ce qui suit le point d'entrée.
 * - Post-roll : la lecture continue après le point de sortie, puis s'arrête.
 * - Aux deux bords, un crossfade court (10 ms par défaut, puissance égale)
 *   enchaîne l'ancienne prise et la nouvelle, centré sur le point de punch.
 */

export const DEFAULT_PRE_ROLL_BARS = 2;
export const DEFAULT_POST_ROLL_BARS = 1;
export const DEFAULT_PUNCH_XFADE_MS = 10;
/** Choix proposés dans la barre de transport (mesures). */
export const ROLL_CHOICES_BARS = [0, 0.5, 1, 2, 4];
/** Zone de punch la plus courte acceptée (s). */
export const MIN_PUNCH_SEC = 0.05;
/**
 * Marge d'enregistrement après la sortie (s) quand le post-roll est coupé : la
 * prise est recalée de la latence, il faut capter un peu au-delà du point de
 * sortie pour avoir l'audio jusqu'à lui (+ la moitié du crossfade).
 */
export const PUNCH_TAIL_SEC = 0.25;

export const EMPTY_PUNCH: PunchSettings = { enabled: false, punchIn: 0, punchOut: 0, preRoll: 0, postRoll: 0 };

/** Durée d'une mesure (s). */
export function barSeconds(bpm: number, ts?: Pick<TimeSignature, 'numerator' | 'denominator'> | null): number {
  const b = bpm > 0 ? bpm : 120;
  const num = ts?.numerator || 4;
  const den = ts?.denominator || 4;
  return (60 / b) * num * (4 / den);
}

/** Pré/post-roll en mesures, d'après les réglages (anciens projets : secondes). */
export function rollBars(p: Partial<PunchSettings> | null | undefined, which: 'pre' | 'post', bpm: number, ts?: TimeSignature): number {
  const bars = which === 'pre' ? p?.preRollBars : p?.postRollBars;
  if (typeof bars === 'number' && Number.isFinite(bars) && bars >= 0) return bars;
  const secs = which === 'pre' ? p?.preRoll : p?.postRoll;
  if (typeof secs === 'number' && secs > 0) return Math.round((secs / barSeconds(bpm, ts)) * 100) / 100;
  return which === 'pre' ? DEFAULT_PRE_ROLL_BARS : DEFAULT_POST_ROLL_BARS;
}

/** Choix de pré / post-roll en secondes (R2 : comme Pro Tools en min:sec). */
export const ROLL_CHOICES_SEC = [1, 2, 3, 5];

/** Pré/post-roll en secondes : réglé en secondes (R2), sinon en mesures. */
export function rollSeconds(p: Partial<PunchSettings> | null | undefined, which: 'pre' | 'post', bpm: number, ts?: TimeSignature): number {
  const sec = which === 'pre' ? p?.preRollSec : p?.postRollSec;
  if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0) return Math.min(30, sec);
  return rollBars(p, which, bpm, ts) * barSeconds(bpm, ts);
}

/**
 * Pré-roll effectif en secondes. Non réglé (projet d'avant) : seulement en punch,
 * comme avant. Réglé : comme dans Pro Tools, pour toute prise.
 */
export function effectivePreRoll(p: Partial<PunchSettings> | null | undefined, punchActive: boolean, bpm: number, ts?: TimeSignature): number {
  const on = p?.preRollOn === undefined ? punchActive : p.preRollOn;
  return on ? rollSeconds(p, 'pre', bpm, ts) : 0;
}

export function effectivePostRoll(p: Partial<PunchSettings> | null | undefined, bpm: number, ts?: TimeSignature): number {
  const on = p?.postRollOn === undefined ? true : p.postRollOn;
  return on ? rollSeconds(p, 'post', bpm, ts) : 0;
}

export const punchXfadeSec = (p: Partial<PunchSettings> | null | undefined): number =>
  Math.max(0, Math.min(200, p?.crossfadeMs ?? DEFAULT_PUNCH_XFADE_MS)) / 1000;

/** Zone de punch valable ? */
export const hasPunchZone = (p: Partial<PunchSettings> | null | undefined): boolean =>
  !!p && typeof p.punchIn === 'number' && typeof p.punchOut === 'number' && p.punchOut - p.punchIn >= MIN_PUNCH_SEC;

/** Points de punch depuis une plage (sélection, boucle) ; null si trop courte. */
export function punchFromRange(p: PunchSettings, start: number, end: number): PunchSettings | null {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  if (b - a < MIN_PUNCH_SEC) return null;
  return { ...p, enabled: true, punchIn: a, punchOut: b };
}

/** Déplace un point de punch (poignée dans la règle) sans croiser l'autre. */
export function movePunchPoint(p: PunchSettings, edge: 'IN' | 'OUT', t: number): PunchSettings {
  const time = Math.max(0, t);
  if (edge === 'IN') return { ...p, punchIn: Math.min(time, p.punchOut - MIN_PUNCH_SEC) };
  return { ...p, punchOut: Math.max(time, p.punchIn + MIN_PUNCH_SEC) };
}

/** Plan d'une prise lancée avec REC. */
export interface RecordPlan {
  /** Position où repartent lecture et enregistreur. */
  startAt: number;
  /** Début de ce qu'on garde (null = tout depuis startAt). */
  keepFrom: number | null;
  /** Fin de ce qu'on garde (null = jusqu'à l'arrêt). */
  keepTo: number | null;
  /** Arrêt automatique (fin de zone + post-roll), null = à la main. */
  autoStopAt: number | null;
  /** Prise en punch : l'ancienne prise est découpée autour de la zone. */
  isPunch: boolean;
}

export function planRecording(opts: { playhead: number; punch?: PunchSettings | null; bpm: number; ts?: TimeSignature }): RecordPlan {
  const { playhead, punch, bpm, ts } = opts;
  if (punch?.enabled && hasPunchZone(punch)) {
    const pre = effectivePreRoll(punch, true, bpm, ts);
    const post = effectivePostRoll(punch, bpm, ts);
    return {
      startAt: Math.max(0, punch.punchIn - pre),
      keepFrom: punch.punchIn,
      keepTo: punch.punchOut,
      autoStopAt: punch.punchOut + Math.max(post, PUNCH_TAIL_SEC),
      isPunch: true,
    };
  }
  const pre = effectivePreRoll(punch, false, bpm, ts);
  const at = Math.max(0, playhead);
  return {
    startAt: Math.max(0, at - pre),
    keepFrom: pre > 0 ? at : null,
    keepTo: null,
    autoStopAt: null,
    isPunch: false,
  };
}

type TakeLike = Pick<Clip, 'start' | 'duration' | 'offset' | 'fadeIn' | 'fadeOut'>;

/**
 * Ne garde de la prise que la fenêtre [keepFrom, keepTo], élargie de la moitié
 * du crossfade de chaque côté (le crossfade est centré sur le point de punch).
 * null si rien d'utile n'a été capté.
 */
export function trimTake(take: TakeLike, keepFrom: number | null, keepTo: number | null, xfade: number): (TakeLike & Pick<Clip, 'fadeInCurve' | 'fadeOutCurve'>) | null {
  const tStart = take.start;
  const tEnd = take.start + take.duration;
  const half = xfade / 2;
  const from = keepFrom !== null ? Math.max(tStart, keepFrom - half) : tStart;
  const to = keepTo !== null ? Math.min(tEnd, keepTo + half) : tEnd;
  if (to - from < MIN_PUNCH_SEC) return null;
  if (keepFrom !== null && keepFrom >= to) return null;
  const out: TakeLike & Pick<Clip, 'fadeInCurve' | 'fadeOutCurve'> = {
    start: from,
    duration: to - from,
    offset: (take.offset || 0) + (from - tStart),
    fadeIn: take.fadeIn,
    fadeOut: take.fadeOut,
  };
  if (keepFrom !== null) {
    out.fadeIn = Math.max(0.002, Math.min(xfade || 0.002, keepFrom + half - from));
    out.fadeInCurve = 'EQUAL_POWER';
  }
  if (keepTo !== null) {
    out.fadeOut = Math.max(0.002, Math.min(xfade || 0.002, to - (keepTo - half)));
    out.fadeOutCurve = 'EQUAL_POWER';
  }
  const maxOut = Math.max(0, out.duration - out.fadeIn);
  if (out.fadeOut > maxOut) out.fadeOut = maxOut;
  return out;
}

/**
 * Punch : les anciennes prises sont découpées autour de [punchIn, punchOut]. Ce
 * qui précède garde l'audio jusqu'à punchIn + xfade/2 (fondu de sortie), ce qui
 * suit repart de punchOut − xfade/2 (fondu d'entrée) : crossfades à puissance
 * égale avec la nouvelle prise. Les clips mutés et ceux hors zone ne bougent pas.
 */
export function cutAroundPunch(
  clips: Clip[], punchIn: number, punchOut: number, xfade: number, stamp: string,
): { clips: Clip[]; replaced: number } {
  const half = xfade / 2;
  const next: Clip[] = [];
  let replaced = 0;
  for (const c of clips) {
    const cEnd = c.start + c.duration;
    if (c.isMuted || cEnd <= punchIn || c.start >= punchOut) { next.push(c); continue; }
    replaced++;
    if (c.start < punchIn) {
      const end = Math.min(punchIn + half, cEnd);
      const dur = end - c.start;
      const fo = Math.max(0.002, Math.min(xfade || 0.002, end - (punchIn - half), dur));
      next.push({ ...c, id: `${c.id}-a${stamp}`, duration: dur, fadeOut: fo, fadeOutCurve: 'EQUAL_POWER', fadeIn: Math.min(c.fadeIn || 0, Math.max(0, dur - fo)) });
    }
    if (cEnd > punchOut) {
      const start = Math.max(punchOut - half, c.start);
      const dur = cEnd - start;
      const fi = Math.max(0.002, Math.min(xfade || 0.002, (punchOut + half) - start, dur));
      next.push({ ...c, id: `${c.id}-b${stamp}`, start, offset: (c.offset || 0) + (start - c.start), duration: dur, fadeIn: fi, fadeInCurve: 'EQUAL_POWER', fadeOut: Math.min(c.fadeOut || 0, Math.max(0, dur - fi)) });
    }
  }
  return { clips: next, replaced };
}

// ------------------------------------------------------------------ QuickPunch

/**
 * Délai avant d'arrêter l'enregistreur après un punch-out QuickPunch : la prise
 * est recalée de la latence (elle arrive en retard), on capte donc encore la
 * latence + la moitié du crossfade + une petite marge.
 */
export function quickPunchStopDelay(latencySec: number, xfade: number): number {
  return Math.max(0, latencySec) + xfade / 2 + 0.06;
}

/** Libellé court d'un pré/post-roll (barre de transport). */
export function rollLabel(bars: number, on: boolean): string {
  if (!on || bars <= 0) return 'off';
  if (bars === 0.5) return '½';
  return String(bars);
}
