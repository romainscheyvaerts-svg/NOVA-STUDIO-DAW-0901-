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
