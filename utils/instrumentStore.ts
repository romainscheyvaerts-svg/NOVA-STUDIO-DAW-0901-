import { useEffect, useState } from 'react';

/**
 * Instruments VST3 des pistes MIDI : état passager (jamais sauvegardé), affiché
 * sur l'en-tête de piste et dans le choix du son du piano roll.
 */
export interface InstrumentStatus {
  /** Chargement du plugin sur le pont. */
  loading?: boolean;
  /** Rendu des notes en cours (« rendu… »). */
  rendering?: boolean;
  /** Fenêtre du plugin ouverte sur le PC. */
  editorOpen?: boolean;
  /** Dernier rendu raté : le synthé Nova joue les notes. */
  error?: string | null;
}

const statuses = new Map<string, InstrumentStatus>();
const listeners = new Set<() => void>();
const EMPTY: InstrumentStatus = {};

export const instrumentStore = {
  get: (trackId: string): InstrumentStatus => statuses.get(trackId) || EMPTY,
  patch(trackId: string, patch: Partial<InstrumentStatus>) {
    statuses.set(trackId, { ...(statuses.get(trackId) || {}), ...patch });
    listeners.forEach(cb => cb());
  },
  clear(trackId: string) {
    if (!statuses.delete(trackId)) return;
    listeners.forEach(cb => cb());
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

export const useInstrumentStatus = (trackId: string): InstrumentStatus => {
  const [s, setS] = useState<InstrumentStatus>(() => instrumentStore.get(trackId));
  useEffect(() => {
    const update = () => setS(instrumentStore.get(trackId));
    update();
    return instrumentStore.subscribe(update);
  }, [trackId]);
  return s;
};
