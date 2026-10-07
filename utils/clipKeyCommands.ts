import type { Clip } from '../types';

/**
 * Commandes clavier sur un clip, à la position de la tête de lecture
 * (Commands Keyboard Focus de Pro Tools : A, S, D, G). Chaque fonction renvoie
 * les propriétés à changer (action UPDATE_PROPS), ou null si la tête de
 * lecture n'est pas dans le clip.
 */
const inside = (clip: Clip, t: number) => t > clip.start + 1e-4 && t < clip.start + clip.duration - 1e-4;

/** A : le clip commence à la tête de lecture (le son ne bouge pas). */
export const trimStartTo = (clip: Clip, t: number): Partial<Clip> | null => {
  if (!inside(clip, t)) return null;
  const cut = t - clip.start;
  return { start: t, offset: (clip.offset || 0) + cut, duration: clip.duration - cut, fadeIn: Math.min(clip.fadeIn || 0, clip.duration - cut) };
};

/** S : le clip s'arrête à la tête de lecture. */
export const trimEndTo = (clip: Clip, t: number): Partial<Clip> | null => {
  if (!inside(clip, t)) return null;
  const duration = t - clip.start;
  return { duration, fadeOut: Math.min(clip.fadeOut || 0, duration) };
};

/** D : fondu d'entrée du début du clip jusqu'à la tête de lecture. */
export const fadeInTo = (clip: Clip, t: number): Partial<Clip> | null =>
  inside(clip, t) ? { fadeIn: Math.min(t - clip.start, clip.duration - (clip.fadeOut || 0)) } : null;

/** G : fondu de sortie de la tête de lecture jusqu'à la fin du clip. */
export const fadeOutTo = (clip: Clip, t: number): Partial<Clip> | null =>
  inside(clip, t) ? { fadeOut: Math.min(clip.start + clip.duration - t, clip.duration - (clip.fadeIn || 0)) } : null;

/** Fondus rapides anti-clic (10 ms) aux deux bouts, sans raccourcir un fondu plus long. */
export const QUICK_FADE_SEC = 0.01;
export const quickFades = (clip: Clip): Partial<Clip> => {
  const q = Math.min(QUICK_FADE_SEC, clip.duration / 4);
  return { fadeIn: Math.max(clip.fadeIn || 0, q), fadeOut: Math.max(clip.fadeOut || 0, q) };
};
