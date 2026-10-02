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
