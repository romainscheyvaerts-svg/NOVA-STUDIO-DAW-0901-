/**
 * Zoom horizontal de l'arrangement (pixels par seconde), tour « édition et navigation » 22/10/2026.
 *
 * Avant : 10 à 300 px/s. Un morceau de 3 min 30 ne tenait pas à l'écran (2 100 px au plus
 * large, « Zoom préréglé 1 = tout le morceau » restait coupé) et le zoom le plus serré
 * montrait encore 160 échantillons par pixel : impossible de couper sur un passage à zéro
 * ou de retirer un clic, ce que tous les DAW permettent jusqu'à l'échantillon.
 *
 * Maintenant : 1 px/s (20 min dans 1 200 px) à 48 000 px/s (un échantillon par pixel à
 * 48 kHz), borné pour que la largeur du contenu reste sous la limite d'un élément de
 * Chrome (~33,5 millions de pixels).
 *
 * Zoom au clavier, au curseur ou au menu : ancré sur la tête de lecture si elle est à
 * l'écran, sinon sur le milieu de la vue (avant : sur le bord gauche en pixels, la vue
 * sautait ailleurs dans le morceau et la tête de lecture sortait de l'écran).
 */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 48000;
/** Largeur maximale du contenu défilant (px). */
export const MAX_CONTENT_PX = 30_000_000;
/** Zoom par défaut d'un projet (et « Zoom par défaut » du menu). */
export const ZOOM_DEFAULT = 40;

/** Zoom le plus serré pour un morceau de cette durée (s). */
export const zoomMaxFor = (durationS?: number): number =>
  Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, durationS && durationS > 0 ? MAX_CONTENT_PX / durationS : ZOOM_MAX));

export const clampZoom = (z: number, durationS?: number): number =>
  Number.isFinite(z) ? Math.max(ZOOM_MIN, Math.min(zoomMaxFor(durationS), z)) : ZOOM_DEFAULT;

/** Curseur logarithmique (0 à 1000) : chaque cran compte autant au large qu'au plus près. */
export const SLIDER_STEPS = 1000;
export const zoomToSlider = (z: number): number =>
  Math.round(SLIDER_STEPS * Math.log(clampZoom(z) / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN));
export const sliderToZoom = (v: number): number =>
  ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, Math.max(0, Math.min(SLIDER_STEPS, v)) / SLIDER_STEPS);

/** Point fixe d'un zoom : l'instant `time` reste à `px` pixels du bord gauche des pistes. */
export interface ZoomAnchor { time: number; px: number }

/**
 * Ancre d'un zoom sans souris (clavier, curseur, menu) : la tête de lecture si elle est
 * visible, sinon le milieu de la vue.
 */
export function zoomAnchor(o: { playhead: number; scrollLeft: number; viewWidth: number; zoom: number }): ZoomAnchor {
  const w = Math.max(1, o.viewWidth);
  const phX = o.playhead * o.zoom - o.scrollLeft;
  if (Number.isFinite(phX) && phX >= 0 && phX <= w) return { time: o.playhead, px: phX };
  return { time: Math.max(0, (o.scrollLeft + w / 2) / o.zoom), px: w / 2 };
}

/** Défilement qui garde l'ancre au même endroit après le zoom. */
export const scrollForAnchor = (a: ZoomAnchor, zoom: number): number => Math.max(0, a.time * zoom - a.px);

/** Zoom et défilement pour montrer [start, end] (marge de 5 % de chaque côté). */
export function fitRange(start: number, end: number, viewWidth: number, durationS?: number): { zoom: number; scroll: number } {
  const span = Math.max(0.0005, end - start);
  const zoom = clampZoom(Math.max(50, viewWidth) / (span * 1.1), durationS);
  return { zoom, scroll: Math.max(0, (start - span * 0.05) * zoom) };
}
