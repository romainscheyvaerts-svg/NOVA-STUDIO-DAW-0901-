import type { Marker } from '../types';
import type { TimeSelection } from './timeSelection';

/**
 * Repère qui mémorise une PLAGE (Pro Tools : Memory Location « Selection »).
 * Module pur (aucune dépendance d'interface) : sauvegarde, réparation de projet,
 * collaboration et liste des repères s'en servent. Voir utils/selectionMemory.
 */


/** Plage gardée par un repère de sélection (absente sur un repère simple). */
export interface MarkerSelection { end: number; trackIds: string[] }

export const isSelectionMarker = (m: Pick<Marker, 'selection'>): m is Pick<Marker, 'selection'> & { selection: MarkerSelection } =>
  !!m.selection && Number.isFinite(m.selection.end) && Array.isArray(m.selection.trackIds);

/** Nouveau repère qui garde la plage (Pro Tools : avec une sélection, la Memory Location est « Selection »). */
export function selectionMarker(sel: TimeSelection, opts: { id: string; number: number; color: string; name?: string }): Marker {
  return {
    id: opts.id,
    number: opts.number,
    name: opts.name || `Sélection ${opts.number}`,
    time: Math.max(0, sel.start),
    type: 'MARKER',
    color: opts.color,
    selection: { end: Math.max(sel.start, sel.end), trackIds: [...sel.trackIds] },
  };
}

/** Plage à resélectionner au rappel du repère (pistes disparues retirées ; aucune : toutes celles données). */
export function selectionFromMarker(m: Marker, existingTrackIds: string[]): TimeSelection | null {
  if (!isSelectionMarker(m)) return null;
  const known = new Set(existingTrackIds);
  const ids = m.selection.trackIds.filter(id => known.has(id));
  const end = Math.max(m.time, m.selection.end);
  if (end - m.time < 1e-4) return null;
  return { start: m.time, end, trackIds: ids.length ? ids : existingTrackIds.slice(0, 1) };
}

/** Garde-fou de chargement (fichier, collaboration) : une plage abîmée est retirée, le repère reste. */
export function cleanMarkerSelection(m: any): void {
  if (!m || m.selection === undefined) return;
  const s = m.selection;
  const ok = s && typeof s === 'object' && Number.isFinite(s.end) && s.end >= (Number.isFinite(m.time) ? m.time : 0)
    && Array.isArray(s.trackIds) && s.trackIds.every((x: unknown) => typeof x === 'string');
  if (!ok) delete m.selection;
  else m.selection = { end: +s.end, trackIds: s.trackIds.slice(0, 256) };
}
