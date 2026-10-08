/**
 * Grille de l'arrangement (mode Grid de Pro Tools) : valeurs binaires jusqu'à
 * la triple croche (1/32) et triolets. Calcul en 4/4, comme le reste de la
 * timeline de NOVA.
 */

import { tempoMapStore, isPlain44, snapTimeToMap } from './tempoMap';

export interface GridOption {
  value: string; label: string; title: string;
  /** 'temps' : grille en millisecondes ou en images (Pro Tools : min:sec, timecode), indépendante du tempo. */
  kind?: 'musique' | 'temps';
}

export const GRID_OPTIONS: GridOption[] = [
  { value: '1/1', label: 'Mesure', title: 'Une mesure (Pro Tools : grille 1 bar)' },
  { value: '1/2', label: '1/2', title: 'Blanche (Pro Tools : grille 1/2)' },
  { value: '1/4', label: '1/4 (temps)', title: 'Noire, un temps (Pro Tools : grille 1/4)' },
  { value: '1/8', label: '1/8', title: 'Croche (Pro Tools : grille 1/8)' },
  { value: '1/16', label: '1/16', title: 'Double croche (Pro Tools : grille 1/16)' },
  { value: '1/32', label: '1/32', title: 'Triple croche, pour caler un hi-hat ou une syllabe (Pro Tools : grille 1/32)' },
  { value: '1/4T', label: '1/4 triolet', title: 'Triolet de noires (Pro Tools : grille 1/4 avec triolet)' },
  { value: '1/8T', label: '1/8 triolet', title: 'Triolet de croches, les flows en triolets (Pro Tools : grille 1/8 avec triolet)' },
  { value: '1/16T', label: '1/16 triolet', title: 'Triolet de doubles, les rolls de hi-hats trap (Pro Tools : grille 1/16 avec triolet)' },
  // En temps (Pro Tools : échelle min:sec et timecode) : pour l'image, un podcast, un son sans tempo.
  { value: 'ms:10', label: '10 ms', title: '10 millisecondes (Pro Tools : grille min:sec 10 ms)', kind: 'temps' },
  { value: 'ms:100', label: '100 ms', title: '100 millisecondes (Pro Tools : grille min:sec 100 ms)', kind: 'temps' },
  { value: 'ms:1000', label: '1 s', title: 'Une seconde (Pro Tools : grille min:sec 1 s)', kind: 'temps' },
  { value: 'fps:24', label: '1 image 24', title: 'Une image à 24 images/s, cinéma (Pro Tools : grille timecode 1 frame)', kind: 'temps' },
  { value: 'fps:25', label: '1 image 25', title: 'Une image à 25 images/s, vidéo européenne (Pro Tools : grille timecode 1 frame)', kind: 'temps' },
  { value: 'fps:30', label: '1 image 30', title: 'Une image à 30 images/s, vidéo des réseaux (Pro Tools : grille timecode 1 frame)', kind: 'temps' },
];

/** Grille en temps (ms, images) : son pas en secondes, sinon null (grille musicale). */
export const timeGridStep = (gridSize: string): number | null => {
  const m = /^(ms|fps):(\d+(?:\.\d+)?)$/.exec(String(gridSize || '').trim());
  if (!m) return null;
  const v = parseFloat(m[2]);
  if (!(v > 0)) return null;
  return m[1] === 'ms' ? v / 1000 : 1 / v;
};

/** Divisions d'une mesure de 4/4 (1/8T = 12 par mesure). */
export const gridSubdivisionsPerBar = (gridSize: string): number => {
  const m = /^1\/(\d+)(T?)$/.exec(String(gridSize || '').trim());
  if (!m) return 4;
  const n = Math.max(1, parseInt(m[1], 10));
  return m[2] ? (n * 3) / 2 : n;
};

/** Pas de la grille en secondes. */
export const gridStepSeconds = (gridSize: string, bpm: number): number => {
  const t = timeGridStep(gridSize);
  if (t) return t;
  const bar = (4 * 60) / (bpm > 0 ? bpm : 120);
  return bar / gridSubdivisionsPerBar(gridSize);
};

/**
 * Temps aimanté sur la grille (Maj = sans grille, géré par l'appelant).
 * Piste tempo (R2) : avec une mesure autre que 4/4 ou des changements de tempo,
 * la grille suit la carte du projet (traits ancrés sur chaque mesure).
 */
export const snapToGrid = (time: number, bpm: number, gridSize: string, enabled: boolean): number => {
  if (!enabled) return time;
  const map = tempoMapStore.get();
  if (!timeGridStep(gridSize) && !isPlain44(map) && Math.abs(map.segments[0].bpm - bpm) < 1e-6) return snapTimeToMap(map, time, gridSize);
  const step = gridStepSeconds(gridSize, bpm);
  return Math.round(time / step) * step;
};

/** La j-ième division tombe-t-elle sur un temps (trait un peu plus visible) ? */
export const isBeatLine = (j: number, subdivisionsPerBar: number): boolean => {
  const beats = (j * 4) / subdivisionsPerBar;
  return Math.abs(beats - Math.round(beats)) < 1e-6;
};

export const gridLabel = (gridSize: string): string =>
  GRID_OPTIONS.find(o => o.value === gridSize)?.label || gridSize;
