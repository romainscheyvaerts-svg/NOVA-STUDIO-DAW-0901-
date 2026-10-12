/** Commandes de l'échange AAF (menus, palette, glisser-déposer, fenêtre Exporter). */
export type AafCommand = { kind: 'import'; files?: File[] } | { kind: 'export' };

const listeners = new Set<(c: AafCommand) => void>();

export const aafBus = {
  on(fn: (c: AafCommand) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  emit(c: AafCommand) { listeners.forEach(fn => fn(c)); },
};

/** « Importer une séance Pro Tools (AAF) » ; `files` : .aaf (et sons liés) déjà choisis ou déposés. */
export const openAafImport = (files?: File[]) => aafBus.emit({ kind: 'import', files });
/** « Séance pour Pro Tools (AAF + BWF) ». */
export const openAafExport = () => aafBus.emit({ kind: 'export' });
