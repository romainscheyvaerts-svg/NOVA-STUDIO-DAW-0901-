import React from 'react';
/**
 * Bandeau du bas (ordinateur / tablette) : les libellés se replient en icônes
 * selon la place RÉELLE (mesure, pas de seuil de largeur figé), comme la barre
 * du haut (utils/barFit).
 *
 * Chaque bouton repliable porte `data-dock-prio` (petit = replié en premier)
 * et son libellé `data-dock-label`. Un bouton replié reçoit `data-dock-compact` :
 * son libellé est masqué (styles/tailwind.css), l'icône reste, et le nom reste
 * lisible dans l'infobulle et pour les lecteurs d'écran (aria-label).
 * Avant : à 1024 px (tablette), « Mix auto » sortait à droite de l'écran.
 */
export const DOCK_COMPACT = 'data-dock-compact';

/** Attributs d'un bouton repliable du bandeau. */
export const dockItem = (prio: number) => ({ 'data-dock-prio': prio });

const overflowing = (dock: HTMLElement): boolean => {
  if (dock.scrollWidth > dock.clientWidth + 1) return true;
  for (const el of Array.from(dock.querySelectorAll<HTMLElement>('[data-dock-scroll]'))) {
    if (el.scrollWidth > el.clientWidth + 1) return true;
  }
  return false;
};

/**
 * Déplie tout, mesure, puis replie par priorité croissante jusqu'à ce que rien
 * ne dépasse. Renvoie le nombre de boutons repliés. Idempotent.
 */
export function fitDock(dock: HTMLElement): number {
  const items = Array.from(dock.querySelectorAll<HTMLElement>('[data-dock-prio]'));
  for (const el of items) el.removeAttribute(DOCK_COMPACT);
  if (!overflowing(dock)) return 0;
  const order = items
    .map((el, i) => ({ el, i, p: Number(el.dataset.dockPrio) || 0 }))
    // Même priorité : d'abord le plus à gauche (les gestes voix, à droite, gardent leur nom).
    .sort((a, b) => a.p - b.p || a.i - b.i);
  let n = 0;
  for (const { el } of order) {
    if (!overflowing(dock)) break;
    if (!el.getClientRects().length) continue;
    el.setAttribute(DOCK_COMPACT, '');
    n++;
  }
  return n;
}

/**
 * Refait le repli à chaque changement de taille du bandeau ou de son contenu
 * (fenêtre, navigateur ouvert / fermé, « 3 en ligne · Chat », style de mix choisi…).
 */
export function useDockFit(dock: HTMLElement | null): void {
  React.useLayoutEffect(() => {
    if (!dock) return;
    let raf = 0;
    const run = () => { raf = 0; fitDock(dock); };
    run();
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(schedule);
    ro.observe(dock);
    // Libellés qui changent (« Groupes · 2 », nom du style…) : sans changement de taille du bandeau.
    const mo = new MutationObserver(schedule);
    mo.observe(dock, { subtree: true, childList: true, characterData: true });
    return () => { ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [dock]);
}
