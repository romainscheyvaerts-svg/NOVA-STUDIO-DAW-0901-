import type { AutomationPoint, Track } from '../types';
import { playedLanes, sortedPoints } from './automationWrite';

/**
 * R8 · Automation du mute (Pro Tools : voie « mute »).
 *
 * Voie `mute` : 0 = son, 1 = muet (≥ 0,5 = muet), toujours en paliers. Le
 * moteur la joue sur un gain placé juste après la chaîne d'effets (avant le
 * fader) : la piste, ses envois pré- et post-fader sont coupés ensemble,
 * comme le bouton Mute. Le mute fixe de la piste (bouton M) reste à part.
 * La clé de side-chain « avant fader » est prise AVANT ce gain : un kick muet
 * continue de faire pomper la 808 (kick fantôme), comme une clé pré-fader.
 *
 * Le gain est calé sur la musique : il change avec l'avance de compensation
 * (PDC) de la piste, en lecture comme à l'export.
 */
export const MUTE_PARAM = 'mute';
export const isMuteParam = (name: string) => name === MUTE_PARAM;

const cache = new WeakMap<AutomationPoint[], AutomationPoint[]>();

/** Points de la voie « Muet » (1 = muet) → gain 0 / 1 en paliers, triés. */
export const muteGainPoints = (points: AutomationPoint[]): AutomationPoint[] => {
  let r = cache.get(points);
  if (!r) {
    r = sortedPoints(points).map(p => ({ ...p, value: p.value >= 0.5 ? 0 : 1, curveType: 'HOLD' as const }));
    cache.set(points, r);
  }
  return r;
};

/** Voie « Muet » jouée (avec au moins un point), ou undefined. */
export const muteLaneOf = (track: Track) => playedLanes(track).find(l => isMuteParam(l.parameterName) && l.points.length > 0);

/** Muet à l'instant `t` d'après la voie (faux sans voie). */
export const isMutedAt = (track: Track, t: number): boolean => {
  const lane = muteLaneOf(track);
  if (!lane) return false;
  const pts = sortedPoints(lane.points);
  let v = pts[0].value;
  for (const p of pts) { if (p.time <= t) v = p.value; else break; }
  return v >= 0.5;
};

export const muteValueText = (v: number) => (v >= 0.5 ? 'Muet' : 'Son');
