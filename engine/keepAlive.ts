/**
 * Source muette qui garde les chaînes d'effets « actives » (lecture et export) : sans elle,
 * Chrome arrête un filtre (EQ 12 bandes, de-esser…) quand plus rien n'y entre et coupe sa
 * résonance sous un seuil (voir ensureTrackDSP et renderProject).
 *
 * Piège mesuré le 14/10/2026 (qa/veille_fidelite.py, puis graphe Web Audio pur sans NOVA) :
 * un ConstantSourceNode d'offset 0 FIXE rend un bloc marqué « silencieux » ; pour les nœuds en
 * aval, c'est une entrée muette. Les BiquadFilter finissent leur queue puis cessent de calculer,
 * leur état reste figé, et en temps réel l'instant où ils s'arrêtent n'est pas déterministe.
 * Lecture ≠ export de 0,17 à 0,25 LSB16 sur 3 filtres seuls, de 0,4 à 1,4 LSB16 une fois
 * amplifié par le compresseur ou la saturation (deux lectures du même morceau ne donnaient pas
 * le même son). Offset 0 TENU par une automation (rampe 0 → 0 jusqu'à très loin) : Chrome
 * calcule la valeur échantillon par échantillon et écrit de vrais zéros, bloc non silencieux,
 * les filtres continuent de calculer, comme à l'export. Aucun continu ajouté : le silence
 * reste exactement 0.
 */

/** Fin de la rampe qui tient l'offset à 0 (s) : bien au-delà de toute séance. */
export const KEEPALIVE_HOLD_S = 1e7;

export function createKeepAlive(ctx: BaseAudioContext): ConstantSourceNode {
  const ka = ctx.createConstantSource();
  ka.offset.value = 0;
  try {
    ka.offset.setValueAtTime(0, 0);
    ka.offset.linearRampToValueAtTime(0, KEEPALIVE_HOLD_S);
  } catch { /* contexte simulé sans automation : offset 0 fixe (ancien comportement) */ }
  ka.start(0);
  return ka;
}
