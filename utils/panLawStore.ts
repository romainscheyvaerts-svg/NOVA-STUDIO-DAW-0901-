import { useSyncExternalStore } from 'react';
import { DEFAULT_PAN_LAW, sanitizePanLaw, type PanLaw } from './panLaw';

/**
 * Loi de pan du projet affichée dans les menus (Options ▾, menu du pan). L'état du projet
 * (DAWState.panLaw) reste la source : l'appli la recopie ici ; un menu demande un changement
 * par l'événement « nova:set-pan-law » (l'appli l'écrit dans le projet : Ctrl+Z, sauvegarde,
 * collaboration).
 */
let current: PanLaw = DEFAULT_PAN_LAW;
const listeners = new Set<() => void>();

export const getShownPanLaw = (): PanLaw => current;

/** Appelé par l'appli quand la loi du projet change (ouverture, Ctrl+Z, collaboration). */
export function showPanLaw(law: unknown) {
  const next = sanitizePanLaw(law);
  if (next === current) return;
  current = next;
  listeners.forEach(fn => fn());
}

/** Demande de changement depuis un menu. */
export function requestPanLaw(law: PanLaw) {
  try { window.dispatchEvent(new CustomEvent('nova:set-pan-law', { detail: { law } })); } catch { /* hors navigateur */ }
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePanLaw = (): PanLaw => useSyncExternalStore(subscribe, getShownPanLaw, getShownPanLaw);
