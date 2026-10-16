/**
 * Lots 5 et 10 · Branchement des fenêtres « Sons » (navigateur, Palette), « Démarrer un beat »
 * et « Prolonger / Varier » : un seul magasin partagé, hors de l'état React du projet.
 *
 * - `sonsBeatStore.open(...)` : ouvre une fenêtre (palette Ctrl+K, parcours, chat, bouton).
 * - `projectInfoStore` : tempo, tonalité et instru chargée du projet, pour le navigateur intégré
 *   au panneau de gauche (il n'a pas l'état du projet).
 * - `requestSoundPlace` : demande de pose d'un son ou d'une boucle (traitée par SonsBeatHost).
 * - `sonsBeatStore.run(action, payload)` : actions du chatbot (START_BEAT, VARY_MIDI).
 */
import { useSyncExternalStore } from 'react';

export type SonsTab = 'sons' | 'boucles' | 'palette' | 'favoris';
export type SonsBeatPanel =
  | { kind: 'sons'; tab?: SonsTab }
  | { kind: 'beat' }
  | { kind: 'vary'; mode: 'prolonger' | 'varier'; trackId?: string; clipId?: string };

type Listener = () => void;

let panel: SonsBeatPanel | null = null;
const listeners = new Set<Listener>();
let runner: ((action: string, payload: Record<string, unknown>) => void) | null = null;
let helpers: { ensureEngine?: () => Promise<unknown>; notify?: (msg: string) => void } = {};

export const sonsBeatStore = {
  get: (): SonsBeatPanel | null => panel,
  open(p: SonsBeatPanel) { panel = p; listeners.forEach(l => l()); },
  close() { if (!panel) return; panel = null; listeners.forEach(l => l()); },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** SonsBeatHost s'enregistre ici pour exécuter les actions du chat. */
  setRunner(f: typeof runner) { runner = f; },
  run(action: string, payload: Record<string, unknown>) { runner?.(action, payload); return !!runner; },
  /** Moteur audio et messages de NOVA, pour le navigateur intégré au panneau de gauche. */
  setHelpers(h: typeof helpers) { helpers = h; },
  helpers: () => helpers,
};

export const useSonsBeatPanel = () => useSyncExternalStore(sonsBeatStore.subscribe, sonsBeatStore.get, () => null);

export interface ProjectInfo { bpm: number; root: number | null; scale: string | null; hasBeat: boolean; beatsPerBar: number }
let info: ProjectInfo = { bpm: 120, root: null, scale: null, hasBeat: false, beatsPerBar: 4 };
const infoListeners = new Set<Listener>();
export const projectInfoStore = {
  get: () => info,
  set(p: ProjectInfo) {
    if (p.bpm === info.bpm && p.root === info.root && p.scale === info.scale && p.hasBeat === info.hasBeat && p.beatsPerBar === info.beatsPerBar) return;
    info = p; infoListeners.forEach(l => l());
  },
  subscribe(l: Listener) { infoListeners.add(l); return () => { infoListeners.delete(l); }; },
};
export const useProjectInfo = () => useSyncExternalStore(projectInfoStore.subscribe, projectInfoStore.get, projectInfoStore.get);

/** Glisser d'une boucle NOVA (navigateur → timeline). */
export const LOOP_DRAG_TYPE = 'application/x-nova-loop';
/** Pose demandée (bouton « Poser », dépôt sur la timeline) : `at` en s (début de mesure), absent = tête de lecture. */
export const SOUND_PLACE_EVENT = 'nova:sound-place';
export interface SoundPlaceRequest { ref: string; at?: number; name?: string; /** Palette : plusieurs boucles posées ensemble (une seule annulation). */ refs?: string[] }
export const requestSoundPlace = (r: SoundPlaceRequest) => {
  try { window.dispatchEvent(new CustomEvent(SOUND_PLACE_EVENT, { detail: r })); } catch { /* hors navigateur */ }
};
