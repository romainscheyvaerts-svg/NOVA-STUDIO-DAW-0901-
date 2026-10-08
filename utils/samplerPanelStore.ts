import { useSyncExternalStore } from 'react';

/**
 * Écran du sampler mélodique ouvert (id de la piste), partagé entre la
 * pastille de la piste, la barre du piano roll et l'écran (comme synthPanelStore).
 */
let openTrackId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const openSamplerPanel = (trackId: string) => { openTrackId = trackId; emit(); };
export const closeSamplerPanel = () => { openTrackId = null; emit(); };
export const getSamplerPanelTrack = () => openTrackId;

export function useSamplerPanelTrack(): string | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => openTrackId,
    () => null,
  );
}

/** Demandes venues des menus (clip, pad, barre de création) : traitées par components/SamplerHost. */
export type SamplerRequest =
  | { kind: 'new'; instrument?: string }
  | { kind: 'from-clip'; trackId: string; clipId: string }
  | { kind: 'from-pad'; rowIndex: number }
  | { kind: 'chop-clip'; trackId: string; clipId: string };

export const SAMPLER_EVENT = 'nova:sampler';
export const requestSampler = (r: SamplerRequest) => {
  try { window.dispatchEvent(new CustomEvent(SAMPLER_EVENT, { detail: r })); } catch { /* hors navigateur */ }
};
