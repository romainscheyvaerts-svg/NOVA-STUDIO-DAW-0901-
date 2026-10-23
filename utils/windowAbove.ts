/**
 * Une vraie fenêtre (export, Track Presets, palette de commandes, Strip Silence…) est-elle ouverte
 * par-dessus un panneau ancré (Nova Pitch, en bas de la fenêtre d'édition) ?
 *
 * Le panneau écoute le clavier sur toute la page (phase de capture) : sans ce garde, Échap tapé dans
 * la fenêtre du dessus fermait le panneau du dessous et la fenêtre restait ouverte (ses raccourcis
 * et ceux de l'arrangement ne répondaient plus : fenêtre modale ouverte). Constaté par
 * qa/protools_ecarts (23/10/2026) : Track Presets ouvert au-dessus de Nova Pitch.
 *
 * Ne comptent pas : ce qui est dans le panneau lui-même (ses réglages) et ses menus
 * (`data-nova-roll-menu`, rendus ailleurs dans la page).
 */
export function windowAbove(
  root: Element | null,
  doc: Document = document,
  shown: (el: HTMLElement) => boolean = el => el.getClientRects().length > 0,
): boolean {
  return Array.from(doc.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(el =>
    !(root && (root === el || root.contains(el))) && !el.closest('[data-nova-roll-menu]') && shown(el));
}
