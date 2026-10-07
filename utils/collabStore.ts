import { useSyncExternalStore } from 'react';
import { CollabRole } from '../types';

/**
 * Rôle de cet appareil dans une collaboration en cours (null : pas de
 * collaboration). Lu par les en-têtes de piste (verrou de volume) sans passer
 * par toute la chaîne de composants.
 */
let role: CollabRole | null = null;
const listeners = new Set<() => void>();

export const collabRoleStore = {
  get: () => role,
  set(r: CollabRole | null) {
    if (r === role) return;
    role = r;
    listeners.forEach(l => l());
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export const useCollabRole = (): CollabRole | null =>
  useSyncExternalStore(collabRoleStore.subscribe, collabRoleStore.get, collabRoleStore.get);

/** Demande de (dé)verrouillage du volume d'une piste, traitée par App. */
export const requestVolumeLock = (trackId: string) =>
  window.dispatchEvent(new CustomEvent('nova:volume-lock', { detail: trackId }));

/**
 * « Feat à distance » : ce que les en-têtes de piste montrent en direct —
 * qui je suis (pour « à toi ») et qui enregistre sur quelle piste (pastille
 * REC, piste verrouillée chez les autres).
 */
export interface CollabLive { meKey: string | null; recs: Record<string, string> }
let live: CollabLive = { meKey: null, recs: {} };
const liveListeners = new Set<() => void>();

export const collabLiveStore = {
  get: () => live,
  set(next: CollabLive) {
    if (next.meKey === live.meKey && JSON.stringify(next.recs) === JSON.stringify(live.recs)) return;
    live = next;
    liveListeners.forEach(l => l());
  },
  subscribe(l: () => void) { liveListeners.add(l); return () => { liveListeners.delete(l); }; },
};

export const useCollabLive = (): CollabLive =>
  useSyncExternalStore(collabLiveStore.subscribe, collabLiveStore.get, collabLiveStore.get);
