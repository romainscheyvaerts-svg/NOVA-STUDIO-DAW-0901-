/**
 * Gestes au doigt : UN seul arbitre de l'appui long par zone.
 *
 * Le gestionnaire global (TouchInteractionManager) transforme un appui long en
 * « clic droit » simulé partout où une zone ne gère pas elle-même ses gestes.
 * Une zone qui a son propre appui long (arrangement, marqueurs de warp, effets…)
 * le déclare avec l'attribut `data-own-longpress` : le gestionnaire global s'y
 * tait, sinon les deux se déclenchaient l'un après l'autre (menu ouvert puis
 * re-cliqué, marqueur retiré deux fois…). `data-own-longpress="off"` rend une
 * sous-zone (les en-têtes de pistes, dans le défilement de l'arrangement) au
 * gestionnaire global.
 */
export const OWN_LONG_PRESS_ATTR = 'data-own-longpress';

/** Vrai si une zone gère elle-même l'appui long du doigt à cet endroit. */
export const ownsLongPress = (target: EventTarget | null): boolean => {
  const zone = (target as Element | null)?.closest?.(`[${OWN_LONG_PRESS_ATTR}]`);
  return !!zone && zone.getAttribute(OWN_LONG_PRESS_ATTR) !== 'off';
};

/**
 * Après un appui long qui vient d'ouvrir quelque chose (menu, fenêtre), le
 * navigateur envoie encore un « clic » quand le doigt se lève, au même endroit.
 * Ce clic tombait sur l'entrée du menu ouverte sous le doigt (un menu haut est
 * recalé dans l'écran, donc sous le doigt) : l'appui long « Normalisait » le
 * clip et refermait le menu. On avale ce seul clic : celui qui arrive près du
 * doigt, avant le lever ou dans les 400 ms qui suivent.
 */
export function swallowReleaseClick(x: number, y: number): void {
  let safety = 0;
  const done = () => {
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.clearTimeout(safety);
  };
  const onUp = () => { window.clearTimeout(safety); safety = window.setTimeout(done, 400); };
  const onClick = (e: MouseEvent) => {
    if (Math.hypot(e.clientX - x, e.clientY - y) > 40) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    done();
  };
  window.addEventListener('click', onClick, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  // Doigt jamais levé (pointerup perdu) : on ne garde pas l'écouteur indéfiniment.
  safety = window.setTimeout(done, 10000);
}
