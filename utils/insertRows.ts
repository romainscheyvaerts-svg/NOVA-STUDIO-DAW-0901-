/**
 * Console (audit B5) : combien d'effets montrer dans une tranche. Tout ce qui
 * tient est affiché en entier ; sinon la dernière ligne devient « +N » (qui
 * ouvre la liste complète) : jamais d'effet caché sans indication.
 */
export const MIXER_INSERT_ROWS = { mouse: 8, touch: 5 } as const;

export function splitInserts<T>(plugins: T[], maxRows: number): { shown: T[]; hidden: T[] } {
  const rows = Math.max(1, Math.floor(maxRows));
  if (plugins.length <= rows) return { shown: plugins, hidden: [] };
  return { shown: plugins.slice(0, rows - 1), hidden: plugins.slice(rows - 1) };
}

/** Lignes d'effets toujours offertes à la souris (comme les inserts A-D d'une console). */
export const MIXER_INSERT_MIN_ROWS = 4;

/**
 * Hauteur des zones du haut de la console (audit mix 22/10) : la même pour toutes les tranches
 * (faders alignés), mais à la taille de la séance. Avant : 104 px d'envois et 8 lignes d'effets
 * réservés sur chaque tranche, même vides ; sur un écran de 900 px le fader ne gardait que 57 px
 * et le nom de la piste passait sous le bord.
 *  - effets : la plus longue chaîne + une ligne libre pour « + », au moins 4, au plus 8 (souris) ;
 *    au doigt, 5 lignes comme avant ;
 *  - envois : la zone n'existe que si une tranche de la console a un envoi (ou en vue d'un envoi).
 */
export function consoleSections(maxPlugins: number, anySends: boolean, coarse: boolean, sendView: boolean): { insertRows: number; showSends: boolean } {
  const insertRows = coarse
    ? MIXER_INSERT_ROWS.touch
    : Math.min(MIXER_INSERT_ROWS.mouse, Math.max(MIXER_INSERT_MIN_ROWS, Math.floor(maxPlugins) + 1));
  return { insertRows, showSends: sendView || anySends };
}

/** Hauteur (px) de la zone d'effets pour `rows` lignes à la souris : marges, en-tête, lignes de 20 px et espaces de 2 px (au doigt : 200). */
export const insertAreaHeight = (rows: number, coarse: boolean): number =>
  coarse ? 200 : 29 + 22 * Math.max(1, Math.floor(rows));
