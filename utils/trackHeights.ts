/**
 * Hauteur des pistes de l'arrangement (Pro Tools : Track Height). Toutes les
 * pistes ont la même hauteur : la géométrie de l'arrangement (clics, glisser,
 * dessin) repose sur une hauteur unique.
 */
export interface TrackHeightPreset { id: string; label: string; short: string; px: number; pt: string }

export const TRACK_HEIGHTS: TrackHeightPreset[] = [
  { id: 'mini', label: 'Mini', short: 'XS', px: 72, pt: 'Micro / Mini' },
  { id: 'small', label: 'Petite', short: 'S', px: 96, pt: 'Small' },
  { id: 'medium', label: 'Moyenne', short: 'M', px: 120, pt: 'Medium' },
  { id: 'large', label: 'Grande', short: 'L', px: 180, pt: 'Large' },
  { id: 'jumbo', label: 'Énorme', short: 'XL', px: 260, pt: 'Jumbo / Extreme' },
];

export const MIN_TRACK_HEIGHT = TRACK_HEIGHTS[0].px;
export const MAX_TRACK_HEIGHT = TRACK_HEIGHTS[TRACK_HEIGHTS.length - 1].px;

/** Préréglage suivant (+1) ou précédent (-1) à partir d'une hauteur quelconque. */
export const stepTrackHeight = (current: number, dir: 1 | -1): number => {
  const list = TRACK_HEIGHTS.map(h => h.px);
  if (dir > 0) return list.find(px => px > current + 1) ?? list[list.length - 1];
  return [...list].reverse().find(px => px < current - 1) ?? list[0];
};

export const clampTrackHeight = (px: number) => Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(px)));
