import { useEffect, useState } from 'react';

/**
 * Pistes figées automatiquement le temps d'une prise (effets à latence) :
 * jamais sauvegardé, seulement affiché (badge ❄️ sur l'en-tête de piste).
 * `pending` : rendus en cours depuis plus de 300 ms (petit indicateur animé).
 */
let ids = new Set<string>();
let pending = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(cb => cb());

export const recFreezeStore = {
  get: () => ids,
  set(next: Set<string>) {
    ids = new Set(next);
    pending = new Set(Array.from(pending).filter(id => !ids.has(id)));
    notify();
  },
  setPending(next: Set<string>) {
    pending = new Set(next);
    notify();
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

export type RecFreezeStatus = 'none' | 'pending' | 'frozen';

export const useRecFrozen = (trackId: string): RecFreezeStatus => {
  const read = (): RecFreezeStatus => (ids.has(trackId) ? 'frozen' : pending.has(trackId) ? 'pending' : 'none');
  const [status, setStatus] = useState<RecFreezeStatus>(read);
  useEffect(() => {
    const update = () => setStatus(read());
    update();
    return recFreezeStore.subscribe(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);
  return status;
};
