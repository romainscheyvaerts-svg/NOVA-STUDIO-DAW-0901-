import { useEffect, useMemo, useRef } from 'react';
import { DAWState } from '../types';

/**
 * Commandes d'édition « façon Pro Tools » appelables de partout (clavier,
 * menus, barre d'actions, IA). Le système de raccourcis global (autre chantier)
 * n'a qu'à appeler ces fonctions : `useEditCommands` les renvoie, et
 * `getEditCommands()` les donne hors de React.
 *
 * Toutes les éditions passent par `setState` (immer) : une commande = une
 * étape d'annulation (Ctrl+Z).
 */
export interface EditCommands {
  /** État courant du projet (lecture seule). */
  getState: () => DAWState;
  // --- Punch (vague 1)
  togglePunch: () => void;
  toggleQuickPunch: () => void;
}

export interface EditCommandDeps {
  stateRef: React.MutableRefObject<DAWState>;
  togglePunch: () => void;
  toggleQuickPunch: () => void;
}

let current: EditCommands | null = null;
/** Commandes d'édition du studio ouvert (null avant son montage). */
export const getEditCommands = (): EditCommands | null => current;

export function useEditCommands(deps: EditCommandDeps): EditCommands {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const commands = useMemo<EditCommands>(() => ({
    getState: () => depsRef.current.stateRef.current,
    togglePunch: () => depsRef.current.togglePunch(),
    toggleQuickPunch: () => depsRef.current.toggleQuickPunch(),
  }), []);
  useEffect(() => {
    current = commands;
    // Accès pour les tests de bout en bout (navigateur headless) et la console.
    (window as any).__novaEdit = commands;
    return () => {
      if (current === commands) current = null;
      if ((window as any).__novaEdit === commands) delete (window as any).__novaEdit;
    };
  }, [commands]);
  return commands;
}
