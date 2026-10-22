/**
 * Vitesse de correction de Nova Tune : réglage `speed` (0–1) ↔ temps affiché (ms).
 *
 * Moteur (inchangé depuis la v2) : l'écart à la note est corrigé par une décroissance
 * exponentielle de constante de temps τ = 0,3 · speed² s.
 *
 * Temps affiché (22/10/2026) : convention du marché, MESURÉE en boîte noire sur la référence
 * (CONTENU/nova-tune/boite_noire/mesures.json) : sa « vitesse » de 5 à 400 ms est le temps pour
 * corriger la MOITIÉ de l'écart (demi-vie), courbe exponentielle (t90 / t50 = 3,3 = ln 10 / ln 2).
 * Donc ms affichés = τ · ln 2. Une recette publiée « vitesse 20 ms » se règle à 20 ms ici et
 * corrige à la même allure. Avant, l'écran affichait τ (63 % du chemin) : 1,44 × plus long que
 * la convention du marché pour un même son ; le pont VST envoyait speed × 100 ms, troisième
 * convention : la prise (Nova) et la lecture (plugin du PC) ne corrigeaient pas à la même allure.
 */
export const TUNE_TAU_MAX_S = 0.3;

/** Temps de correction affiché (ms, demi-vie de l'écart) pour un réglage `speed`. */
export function retuneMsFromSpeed(speed: number): number {
  const s = Math.max(0, Math.min(1, Number.isFinite(+speed) ? +speed : 0));
  return TUNE_TAU_MAX_S * 1000 * s * s * Math.LN2;
}

/** Réglage `speed` (0–1) pour un temps de correction (ms, demi-vie), arrondi au millième. */
export function speedFromRetuneMs(ms: number): number {
  const v = Math.sqrt(Math.max(0, +ms || 0) / (TUNE_TAU_MAX_S * 1000 * Math.LN2));
  return Math.min(1, Math.round(v * 1000) / 1000);
}

/** Temps maximal affichable (ms) : speed = 1. */
export const RETUNE_MS_MAX = retuneMsFromSpeed(1);
