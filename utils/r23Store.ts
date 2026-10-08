import { useSyncExternalStore } from 'react';
import type { RedoSpot } from './repunch';

/**
 * R23 · Branchements entre l'arrangement, le panneau voix, le store de beats
 * et hooks/useR23 (changer de beat, repunch intelligent) : quelques ordres et
 * la liste des passages « à refaire » affichés sur la timeline.
 */
export type SwapSource =
  | { kind: 'catalog'; inst: any; title: string }
  | { kind: 'file'; url: string; name: string; file?: File };

export type R23Cmd =
  | { kind: 'openSwap'; source?: SwapSource }
  | { kind: 'findSpots'; trackId?: string }
  | { kind: 'redo'; spotId: string }
  | { kind: 'listenSpot'; spotId: string }
  | { kind: 'dismissSpot'; spotId: string }
  | { kind: 'clearSpots'; trackId?: string };

const cmdListeners = new Set<(c: R23Cmd) => void>();
export const r23Bus = {
  emit(c: R23Cmd) { cmdListeners.forEach(l => l(c)); },
  on(l: (c: R23Cmd) => void) { cmdListeners.add(l); return () => { cmdListeners.delete(l); }; },
};

let spots: RedoSpot[] = [];
let selected: string | null = null;
const spotListeners = new Set<() => void>();
const ping = () => spotListeners.forEach(l => l());
export const redoSpotsStore = {
  get: () => spots,
  set(list: RedoSpot[]) { spots = list; if (selected && !list.some(s => s.id === selected)) selected = null; ping(); },
  selected: () => selected,
  select(id: string | null) { selected = id; ping(); },
  subscribe(cb: () => void) { spotListeners.add(cb); return () => { spotListeners.delete(cb); }; },
};
export const useRedoSpots = (): RedoSpot[] => useSyncExternalStore(redoSpotsStore.subscribe, redoSpotsStore.get, redoSpotsStore.get);
export const useSelectedSpot = (): string | null => useSyncExternalStore(redoSpotsStore.subscribe, redoSpotsStore.selected, redoSpotsStore.selected);
