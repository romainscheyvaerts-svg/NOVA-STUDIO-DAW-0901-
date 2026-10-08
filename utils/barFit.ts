/**
 * Barre du haut (transport) : repli des éléments secondaires selon la place
 * RÉELLEMENT disponible (mesure, pas de seuils de largeur figés).
 *
 * Chaque élément repliable porte `data-bar-item` (nom) et `data-bar-prio`
 * (petit = replié en premier). Les essentiels (lecture, stop, REC, boucle,
 * compteur, BPM, Tempo, LUFS, CPU) n'en portent pas : ils restent toujours.
 * Un élément replié reçoit `data-bar-folded` (masqué par styles/tailwind.css) ;
 * la barre reçoit alors `data-bar-menu`, qui affiche le menu ☰ où tout se retrouve.
 */
export const BAR_FOLDED = 'data-bar-folded';
export const BAR_MENU = 'data-bar-menu';

/** Attributs d'un élément repliable de la barre. */
export const barItem = (item: string, prio: number) => ({ 'data-bar-item': item, 'data-bar-prio': prio });

const overflowing = (bar: HTMLElement): boolean => {
  if (bar.scrollWidth > bar.clientWidth + 1) return true;
  for (const g of Array.from(bar.children) as HTMLElement[]) {
    if (g.scrollWidth > g.clientWidth + 1) return true;
  }
  return false;
};

/**
 * Déplie tout, mesure, puis replie par priorité croissante jusqu'à ce que rien
 * ne dépasse. Renvoie les noms des éléments repliés (dans l'ordre du repli).
 * Idempotent : même largeur, mêmes éléments → même résultat (pas d'oscillation).
 */
export function fitBar(bar: HTMLElement): string[] {
  const items = Array.from(bar.querySelectorAll<HTMLElement>('[data-bar-prio]'));
  for (const el of items) el.removeAttribute(BAR_FOLDED);
  bar.removeAttribute(BAR_MENU);
  if (!overflowing(bar)) return [];
  // Le menu ☰ apparaît (il porte ce qui est replié) : on mesure avec lui.
  bar.setAttribute(BAR_MENU, '');
  const order = items
    .map((el, i) => ({ el, i, p: Number(el.dataset.barPrio) || 0 }))
    // Même priorité : on replie d'abord le plus à droite.
    .sort((a, b) => a.p - b.p || b.i - a.i);
  const folded: string[] = [];
  for (const { el } of order) {
    if (!overflowing(bar)) break;
    if (!el.getClientRects().length) continue; // déjà masqué (téléphone, ou parent replié)
    el.setAttribute(BAR_FOLDED, '');
    folded.push(el.dataset.barItem || '?');
  }
  return folded;
}
