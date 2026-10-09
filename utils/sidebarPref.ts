import { simpleModeStore } from './simpleMode';

/**
 * Navigateur latéral (store de beats, effets, VST) : 320 px pris à la fenêtre
 * d'édition. Le choix de l'utilisateur est mémorisé (avant : rouvert à chaque
 * séance, l'ingé le refermait à chaque fois). Sans choix mémorisé : ouvert pour
 * l'artiste (mode simple : il y choisit son beat) et sur grand écran ; fermé en
 * mode avancé sous 1500 px (portable 1366 × 768 : la fenêtre d'édition d'abord).
 */
const KEY = 'nova_sidebar_open';

export function initialSidebarOpen(width = typeof window !== 'undefined' ? window.innerWidth : 1600): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* stockage indisponible */ }
  return simpleModeStore.get().simple || width >= 1500;
}

/** Choix de l'utilisateur (bouton, menu, Ctrl+Alt+B) : gardé pour les séances suivantes. */
export function rememberSidebar(open: boolean) {
  try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* stockage indisponible */ }
}
