/**
 * Hauteur des pistes de l'arrangement (Pro Tools : Track Height). Toutes les
 * pistes ont la même hauteur : la géométrie de l'arrangement (clics, glisser,
 * dessin) repose sur une hauteur unique.
 */
export interface TrackHeightPreset { id: string; label: string; short: string; px: number; pt: string }

export const TRACK_HEIGHTS: TrackHeightPreset[] = [
  // Micro et Compacte (22/10/2026) : avant, 72 px au plus serré, soit 9 pistes sur un écran de
  // 900 px ; une séance de 60 pistes ne se voyait jamais d'un coup. En-tête réduit à une ligne.
  { id: 'micro', label: 'Micro', short: 'µ', px: 24, pt: 'Micro' },
  { id: 'compact', label: 'Compacte', short: 'XXS', px: 44, pt: 'Mini' },
  { id: 'mini', label: 'Mini', short: 'XS', px: 72, pt: 'Small' },
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

/** En-tête de piste réduit à une ligne (nom, M, S, R) sous cette hauteur. */
export const COMPACT_TRACK_HEIGHT = 72;
export const isCompactHeight = (px: number) => px < COMPACT_TRACK_HEIGHT;

/** Hauteur qui fait tenir `count` pistes dans `viewH` px (Z sans sélection : tout voir), entre Micro et Moyenne. */
export const fitTrackHeight = (viewH: number, count: number): number =>
  Math.max(MIN_TRACK_HEIGHT, Math.min(120, Math.floor(Math.max(0, viewH) / Math.max(1, count))));
