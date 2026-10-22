/**
 * Position de la fenêtre d'effet « du moment » (déplacement relatif au centre de l'écran), gardée
 * d'un effet à l'autre pendant la session. Module léger partagé par App (punaise : la suivante s'ouvre
 * décalée, comme une cascade de fenêtres) et PluginEditor (chargé à la demande).
 */
let targetOffset = { x: 0, y: 0 };
export const getPluginWindowOffset = () => targetOffset;
export const setPluginWindowOffset = (o: { x: number; y: number }) => { targetOffset = o; };
/** Après une punaise : la prochaine fenêtre s'ouvre décalée de la fenêtre gardée (elle ne la recouvre pas). */
export const cascadeAfter = (o: { x: number; y: number }) => {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1600;
  const x = o.x + 48 > w / 2 - 200 ? -w / 4 : o.x + 48;
  return { x, y: o.y + 40 > 200 ? -120 : o.y + 40 };
};
