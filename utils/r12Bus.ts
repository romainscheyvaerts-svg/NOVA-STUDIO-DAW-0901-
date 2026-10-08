import type { GroupsState } from './editGroups';
import type { TimeOp } from './timeOps';

/**
 * R12 : commandes des groupes et des opérations sur le temps, envoyées par
 * n'importe quel écran (liste des groupes, piste Arrangement, menus, VCA,
 * téléphone) et appliquées par App (une étape d'annulation, collaboration),
 * sans faire passer de nouvelles props dans les gros composants.
 */
export type R12Panel = 'groups' | 'time';

/** Préréglage de la fenêtre « Temps » (ouverte depuis la règle, une plage, la tête de lecture). */
export interface TimeDialogPreset { mode: 'insert' | 'delete'; at: number; length?: number; end?: number; trackIds?: string[] }

export type R12Command =
  /** Transformation pure des groupes (utils/editGroups) ; `label` : message affiché. */
  | { kind: 'groups'; apply: (s: GroupsState) => GroupsState; label?: string }
  /** Opération sur le temps (utils/timeOps). */
  | { kind: 'timeop'; op: TimeOp }
  /** Ouvre (ou ferme, null) la liste des groupes ou la fenêtre « Temps ». */
  | { kind: 'panel'; panel: R12Panel | null; preset?: TimeDialogPreset; newGroup?: boolean };

type Listener = (cmd: R12Command) => void;
const listeners = new Set<Listener>();

export const r12Bus = {
  on(cb: Listener): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; },
  emit(cmd: R12Command) { listeners.forEach(cb => { try { cb(cmd); } catch (e) { console.warn('[R12]', e); } }); },
};

export const applyGroups = (apply: (s: GroupsState) => GroupsState, label?: string) => r12Bus.emit({ kind: 'groups', apply, label });
export const runTimeOp = (op: TimeOp) => r12Bus.emit({ kind: 'timeop', op });
export const openR12Panel = (panel: R12Panel | null, extra: { preset?: TimeDialogPreset; newGroup?: boolean } = {}) => r12Bus.emit({ kind: 'panel', panel, ...extra });
