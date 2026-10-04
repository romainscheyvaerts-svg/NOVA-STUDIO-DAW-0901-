import { useSyncExternalStore } from 'react';

/**
 * Mode « Ingé à distance » : état affiché sur les en-têtes de piste (sans
 * passer par toute la chaîne de composants). Tenu à jour par useRemoteInge.
 */
export interface RemoteTrackBadge {
  label: string;
  tone: 'info' | 'busy' | 'ok' | 'warn';
  /** Artiste : la piste peut partir chez l'ingé (bouton sur la piste). */
  canSend?: boolean;
}

interface Snapshot { role: 'artist' | 'engineer' | null; badges: Record<string, RemoteTrackBadge> }

let snap: Snapshot = { role: null, badges: {} };
const listeners = new Set<() => void>();

export const remoteStore = {
  get: () => snap,
  set(next: Snapshot) {
    if (JSON.stringify(next) === JSON.stringify(snap)) return;
    snap = next;
    listeners.forEach(l => l());
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export const useRemoteBadge = (trackId: string): { role: Snapshot['role']; badge?: RemoteTrackBadge } => {
  const s = useSyncExternalStore(remoteStore.subscribe, remoteStore.get, remoteStore.get);
  return { role: s.role, badge: s.badges[trackId] };
};

/** Bouton « Envoyer à l'ingé » d'une piste : traité par useRemoteInge. */
export const requestRemoteSend = (trackId: string) =>
  window.dispatchEvent(new CustomEvent('nova:remote-send', { detail: trackId }));
