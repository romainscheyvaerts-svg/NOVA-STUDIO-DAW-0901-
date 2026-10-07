/**
 * Grille de l'arrangement (mode Grid de Pro Tools) : valeurs binaires jusqu'à
 * la triple croche (1/32) et triolets. Calcul en 4/4, comme le reste de la
 * timeline de NOVA.
 */

export interface GridOption { value: string; label: string; title: string }

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
];

/** Divisions d'une mesure de 4/4 (1/8T = 12 par mesure). */
export const gridSubdivisionsPerBar = (gridSize: string): number => {
  const m = /^1\/(\d+)(T?)$/.exec(String(gridSize || '').trim());
  if (!m) return 4;
  const n = Math.max(1, parseInt(m[1], 10));
  return m[2] ? (n * 3) / 2 : n;
};

/** Pas de la grille en secondes. */
export const gridStepSeconds = (gridSize: string, bpm: number): number => {
  const bar = (4 * 60) / (bpm > 0 ? bpm : 120);
  return bar / gridSubdivisionsPerBar(gridSize);
};

/** Temps aimanté sur la grille (Maj = sans grille, géré par l'appelant). */
export const snapToGrid = (time: number, bpm: number, gridSize: string, enabled: boolean): number => {
  if (!enabled) return time;
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
