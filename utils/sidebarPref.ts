import { simpleModeStore } from './simpleMode';

/**
 * Navigateur latéral (store de beats, effets, VST) : 320 px pris à la fenêtre
 * d'édition. Le choix de l'utilisateur est mémorisé (avant : rouvert à chaque
 * séance, l'ingé le refermait à chaque fois). Sans choix mémorisé : ouvert pour
 * l'artiste (mode simple : il y choisit son beat) ; FERMÉ en mode avancé sauf sur
 * un très grand écran (≥ 1920 px), où 320 px pèsent peu. Avant, il restait ouvert
 * à 1600 px à la toute 1re séance d'un PC en mode avancé.
 */
const KEY = 'nova_sidebar_open';
/** Largeur à partir de laquelle le navigateur reste ouvert d'office, même en mode avancé. */
export const WIDE_SCREEN_PX = 1920;

/** Choix mémorisé (true / false), ou null s'il n'y en a pas encore. */
export function rememberedSidebar(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* stockage indisponible */ }
  return null;
}

/** Ouvert d'office ? (sans choix mémorisé) */
export function defaultSidebarOpen(simple: boolean, width: number): boolean {
  return simple || width >= WIDE_SCREEN_PX;
}

export function initialSidebarOpen(width = typeof window !== 'undefined' ? window.innerWidth : 1600): boolean {
  const v = rememberedSidebar();
  if (v !== null) return v;
  return defaultSidebarOpen(simpleModeStore.get().simple, width);
}

/** Choix de l'utilisateur (bouton, menu, Ctrl+Alt+B) : gardé pour les séances suivantes. */
export function rememberSidebar(open: boolean) {
  try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* stockage indisponible */ }
}

/**
 * Passage en mode avancé APRÈS l'ouverture (rôle ingé son, mode instru, réglage) :
 * sans choix mémorisé, le navigateur suit la règle du mode avancé. Renvoie l'état
 * voulu, ou null s'il ne faut rien changer.
 */
export function sidebarAfterModeChange(wasSimple: boolean, isSimple: boolean, width: number): boolean | null {
  if (wasSimple === isSimple || rememberedSidebar() !== null) return null;
  return defaultSidebarOpen(isSimple, width);
}
