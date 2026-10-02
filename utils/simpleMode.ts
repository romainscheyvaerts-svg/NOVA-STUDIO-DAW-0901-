import { useSyncExternalStore } from 'react';
import { track } from './analytics';

/**
 * Mode simple : l'artiste ne voit que ce qui sert à poser sa voix (beat, REC,
 * prises, Mix auto, Paroles, Nova, partage). Le mode avancé ré-affiche tout
 * (console, effets, VST, automation) ; rien n'est retiré du projet.
 *
 * Choix mémorisé (nova_simple_mode, activé par défaut). Le mode instru et les
 * rôles ingé son / beatmaker passent d'office en mode avancé (`forced`).
 */
const KEY = 'nova_simple_mode';
const readPref = (): boolean => {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
};

export interface SimpleModeState {
  /** Mode simple effectivement appliqué. */
  simple: boolean;
  /** Choix de l'artiste. */
  pref: boolean;
  /** Mode avancé imposé (mode instru, ingé son, beatmaker). */
  forced: boolean;
}

let pref = readPref();
let forced = false;
let snapshot: SimpleModeState = { simple: pref && !forced, pref, forced };
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = { simple: pref && !forced, pref, forced };
  listeners.forEach(l => l());
};

export const simpleModeStore = {
  get: (): SimpleModeState => snapshot,
  /** Choix de l'artiste (menu ☰, réglages). */
  setPref(on: boolean) {
    if (on === pref) return;
    pref = on;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ }
    track('simple_mode_toggled', { mode: on ? 'on' : 'off' });
    emit();
  },
  setForced(f: boolean) {
    if (f === forced) return;
    forced = f;
    emit();
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export const useSimpleMode = (): SimpleModeState =>
  useSyncExternalStore(simpleModeStore.subscribe, simpleModeStore.get, simpleModeStore.get);
