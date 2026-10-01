/**
 * Beat du catalogue en cours de glisser-déposer.
 *
 * Le dataTransfer ne transporte que des chaînes : à l'arrivée on ne savait plus
 * quel beat c'était (tonalité, BPM, id), et le dépôt ne réglait ni le tempo ni
 * l'Auto-Tune. On garde donc l'objet ici le temps du geste.
 */
let dragged: { inst: any; url: string } | null = null;

export const setDraggedBeat = (inst: any, url: string) => { dragged = { inst, url }; };

/** Rend le beat glissé si l'URL déposée est la sienne (et l'oublie). */
export const takeDraggedBeat = (url: unknown): any | null => {
  if (!dragged || typeof url !== 'string' || url !== dragged.url) return null;
  const inst = dragged.inst;
  dragged = null;
  return inst;
};
