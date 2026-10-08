/**
 * Décompte avant la prise (R2) : 0, 1, 2 ou 4 mesures, ou 1, 2, 4 temps, au
 * tempo et à la mesure de l'endroit où la prise commence (Pro Tools : Count
 * Off en mesures ; Logic : décompte en mesures ou en temps ; Ableton : Count-In).
 *
 * Avant R2, le décompte était figé à 4 temps et le réglage enregistré
 * (metronome.countIn) n'était jamais lu.
 */
import type { MetronomeSettings } from '../types';
import { segmentAtTime, type TempoMap } from './tempoMap';

export type CountInUnit = 'bars' | 'beats';
export const COUNT_IN_CHOICES = [0, 1, 2, 4];

/** Réglage effectif. Projet d'avant R2 (unité absente, 0) : 1 mesure, l'ancien comportement (4 temps en 4/4). */
export function resolveCountIn(m: Partial<MetronomeSettings> | undefined, enabled: boolean): { count: number; unit: CountInUnit } {
  if (!enabled) return { count: 0, unit: 'bars' };
  const unit: CountInUnit = m?.countInUnit === 'beats' ? 'beats' : 'bars';
  const legacy = m?.countInUnit === undefined && !m?.countIn;
  const count = legacy ? 1 : Math.max(0, Math.min(8, Math.round(Number(m?.countIn) || 0)));
  return { count, unit };
}

export interface CountInPlan {
  /** Clics, en s depuis le début du décompte ; accent au premier temps de chaque mesure. */
  clicks: { at: number; accent: boolean; label: number }[];
  /** Durée totale (s) : la prise démarre à la fin. */
  duration: number;
  beatSec: number;
}

/** Plan du décompte pour une prise qui commence à `startAt` (s dans le morceau). */
export function planCountIn(map: TempoMap, startAt: number, s: { count: number; unit: CountInUnit }): CountInPlan {
  const seg = segmentAtTime(map, Math.max(0, startAt));
  const beats = s.unit === 'bars' ? s.count * seg.num : s.count;
  const clicks = Array.from({ length: Math.max(0, beats) }, (_, i) => ({
    at: i * seg.beatSec,
    accent: s.unit === 'bars' ? i % seg.num === 0 : i === 0,
    // Chiffre affiché : le temps dans la mesure (1, 2, 3…), à rebours en temps.
    label: s.unit === 'bars' ? (i % seg.num) + 1 : beats - i,
  }));
  return { clicks, duration: beats * seg.beatSec, beatSec: seg.beatSec };
}
