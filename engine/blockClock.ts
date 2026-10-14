/**
 * Horloge des blocs d'un processeur AudioWorklet : combien d'échantillons ont été SAUTÉS
 * depuis le bloc précédent (chaîne décâblée par la veille des effets, engine/effectSleep).
 *
 * Piège mesuré le 14/10/2026 (qa/veille_fidelite.py) : sous charge, Chrome rend parfois
 * plusieurs blocs de 128 d'affilée en gardant le MÊME `currentFrame` (étiquette en retard de
 * 128 ou 256), puis rattrape d'un coup au bloc suivant. Lire « currentFrame a avancé de plus
 * d'un bloc » comme une veille faisait rattraper au compresseur (et au de-esser) des blocs
 * qu'il venait de calculer : détecteurs relâchés comme sur du silence, ligne de pré-lecture
 * décalée de 128, donc une bouffée jusqu'à −30 dBFS d'écart avec l'export, alors que la
 * veille était coupée.
 *
 * Règle : l'horloge du processeur ne recule jamais. Le bloc attendu est le précédent + n ;
 * une étiquette en retard est ignorée (le bloc est bien celui attendu), seule une étiquette
 * EN AVANCE sur l'attendu signale des blocs sautés. Quand l'étiquette est juste, le résultat
 * est exactement l'ancien (currentFrame − dernier − n).
 *
 * Fonction autonome (aucune référence extérieure) : injectée telle quelle dans le code des
 * worklets par `blockClockSource()`.
 */
export interface BlockClockState { next: number }

export function framesSkipped(st: BlockClockState, frame: number, n: number): number {
  const skip = st.next >= 0 && frame > st.next ? frame - st.next : 0;
  st.next = (st.next >= 0 && frame < st.next ? st.next : frame) + n;
  return skip;
}

/** Source JavaScript à placer en tête d'un module de worklet (définit `framesSkipped`). */
export const blockClockSource = (): string => `const framesSkipped = (${framesSkipped.toString()});\n`;
