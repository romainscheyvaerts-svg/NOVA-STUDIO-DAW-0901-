/** Commandes de l'échange DAWproject (menus, palette, glisser-déposer, fenêtre Exporter). */
export type DawProjectCommand = { kind: 'import'; files?: File[] } | { kind: 'export' };

const listeners = new Set<(c: DawProjectCommand) => void>();

export const dawProjectBus = {
  on(fn: (c: DawProjectCommand) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  emit(c: DawProjectCommand) { listeners.forEach(fn => fn(c)); },
};

/** « Ouvrir un projet DAWproject » ; `files` : .dawproject déjà choisi ou déposé. */
export const openDawProjectImport = (files?: File[]) => dawProjectBus.emit({ kind: 'import', files });
/** « Exporter en DAWproject ». */
export const openDawProjectExport = () => dawProjectBus.emit({ kind: 'export' });
