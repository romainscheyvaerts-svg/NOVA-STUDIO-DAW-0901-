import { useSyncExternalStore } from 'react';

/**
 * Commands Keyboard Focus (Pro Tools : bouton « a–z ») : une touche = une
 * commande d'édition. Mémorisé sur l'appareil.
 */
const KEY = 'nova_keyboard_focus';
let on = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();
const listeners = new Set<() => void>();

export const isKeyboardFocus = () => on;
export const setKeyboardFocus = (v: boolean) => {
  if (v === on) return;
  on = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* stockage indisponible */ }
  listeners.forEach(fn => fn());
};
export const toggleKeyboardFocus = () => setKeyboardFocus(!on);
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useKeyboardFocus = (): boolean => useSyncExternalStore(subscribe, () => on, () => false);
