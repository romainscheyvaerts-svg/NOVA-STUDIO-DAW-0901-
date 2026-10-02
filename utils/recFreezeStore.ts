import { useEffect, useState } from 'react';

/**
 * Pistes figées automatiquement le temps d'une prise (effets à latence) :
 * jamais sauvegardé, seulement affiché (badge ❄️ sur l'en-tête de piste).
 */
let ids = new Set<string>();
const listeners = new Set<() => void>();

export const recFreezeStore = {
  get: () => ids,
  set(next: Set<string>) {
    ids = new Set(next);
    listeners.forEach(cb => cb());
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

export const useRecFrozen = (trackId: string): boolean => {
  const [on, setOn] = useState(() => ids.has(trackId));
  useEffect(() => {
    const update = () => setOn(ids.has(trackId));
    update();
    return recFreezeStore.subscribe(update);
  }, [trackId]);
  return on;
};
