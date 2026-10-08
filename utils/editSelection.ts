import { useSyncExternalStore } from 'react';
import { CrossfadeCurve } from '../types';
import { NudgeUnit } from './fades';
import type { TimeSelection } from './timeSelection';

/**
 * Sélection d'édition partagée hors de l'état React (même principe que
 * playheadStore) : la vue Pistes l'écrit, les commandes d'édition
 * (hooks/useEditCommands), l'export et le punch la lisent. Rien n'est sauvé dans
 * le projet ni dans l'historique (comme dans Pro Tools, la sélection n'est pas
 * une édition).
 */
export interface EditSelectionState {
  /** Plage de temps sélectionnée (Sélecteur / Smart Tool), ou null. */
  time: TimeSelection | null;
  /** Clips sélectionnés (Grabber, rectangle). */
  clipIds: string[];
  /** Piste du dernier clic (cible du collage). */
  focusTrackId: string | null;
}

type Listener = () => void;
let state: EditSelectionState = { time: null, clipIds: [], focusTrackId: null };
const listeners = new Set<Listener>();

export const editSelectionStore = {
  get: (): EditSelectionState => state,
  set(patch: Partial<EditSelectionState>) {
    const next = { ...state, ...patch };
    if (next.time === state.time && next.clipIds === state.clipIds && next.focusTrackId === state.focusTrackId) return;
    state = next;
    listeners.forEach(l => l());
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

export function useEditSelection(): EditSelectionState {
  return useSyncExternalStore(editSelectionStore.subscribe, editSelectionStore.get, editSelectionStore.get);
}

// ------------------------------------------------------- préférences d'édition

export interface EditPrefs {
  nudge: NudgeUnit;
  /** Courbe des crossfades posés (Smart Tool, Ctrl+F, auto). */
  xfadeCurve: CrossfadeCurve;
  /** Crossfade automatique quand un clip déplacé / rogné touche ou chevauche un voisin. */
  autoXfade: boolean;
  /**
   * L'automation suit les éditions (Pro Tools « Automation Follows Edit », R8) :
   * un clip déplacé emporte sa courbe ; copier / couper / coller / effacer /
   * dupliquer une plage portent aussi l'automation. Activé par défaut.
   */
  automationFollowsEdit: boolean;
}

const PREFS_KEY = 'nova_edit_prefs';
const readPrefs = (): EditPrefs => {
  const def: EditPrefs = { nudge: 'GRID', xfadeCurve: 'EQUAL_POWER', autoXfade: true, automationFollowsEdit: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw);
    return { ...def, ...(p && typeof p === 'object' ? p : {}) };
  } catch { return def; }
};
let prefs: EditPrefs = readPrefs();
const prefListeners = new Set<Listener>();

export const editPrefsStore = {
  get: (): EditPrefs => prefs,
  set(patch: Partial<EditPrefs>) {
    prefs = { ...prefs, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* stockage indisponible */ }
    prefListeners.forEach(l => l());
  },
  subscribe(l: Listener): () => void {
    prefListeners.add(l);
    return () => { prefListeners.delete(l); };
  },
};

export function useEditPrefs(): EditPrefs {
  return useSyncExternalStore(editPrefsStore.subscribe, editPrefsStore.get, editPrefsStore.get);
}

// ------------------------------------------- export de la sélection de plage

let selectionExportRequested = false;
/** « Exporter la plage » : la fenêtre d'export s'ouvrira sur la sélection. */
export const requestSelectionExport = () => { selectionExportRequested = true; };
/** Lu une fois par la fenêtre d'export à son ouverture. */
export const consumeSelectionExport = (): boolean => { const v = selectionExportRequested; selectionExportRequested = false; return v; };
