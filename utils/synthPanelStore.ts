import { useSyncExternalStore } from 'react';

/**
 * Écran du synthé NOVA ouvert (id de la piste) : partagé entre la pastille de
 * la piste, la barre du piano roll et l'écran lui-même, sans faire passer de
 * props à travers toute l'arborescence.
 */
let openTrackId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const openSynthPanel = (trackId: string) => { openTrackId = trackId; emit(); };
export const closeSynthPanel = () => { openTrackId = null; emit(); };
export const getSynthPanelTrack = () => openTrackId;

export function useSynthPanelTrack(): string | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => openTrackId,
    () => null,
  );
}
