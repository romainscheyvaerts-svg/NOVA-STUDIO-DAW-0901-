import { useCallback, useSyncExternalStore } from 'react';

/**
 * Valeurs d'automation entendues pendant la lecture, pour que les faders
 * bougent avec la courbe (comme Pro Tools en Read / Touch / Latch).
 *
 * Hors de l'état React : seuls les faders concernés se redessinent, et
 * seulement quand leur valeur change vraiment.
 */

const values = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export const liveKey = (trackId: string, param: string) => `${trackId}|${param}`;

const notify = (key: string) => listeners.get(key)?.forEach(fn => fn());

/** Publie une valeur (undefined : le fader reprend son réglage). */
export const publishLive = (key: string, value: number | undefined) => {
  const prev = values.get(key);
  if (value === undefined) {
    if (prev === undefined) return;
    values.delete(key);
    notify(key);
    return;
  }
  if (prev !== undefined && Math.abs(prev - value) < 1e-4) return;
  values.set(key, value);
  notify(key);
};

/** Fin de lecture : tous les faders reprennent leur réglage. */
export const clearLive = (keep?: Set<string>) => {
  for (const key of [...values.keys()]) if (!keep?.has(key)) { values.delete(key); notify(key); }
};

export const liveKeys = () => [...values.keys()];
export const getLive = (key: string) => values.get(key);

const subscribe = (key: string, fn: () => void) => {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (!set!.size) listeners.delete(key); };
};

/** Valeur à afficher : l'automation entendue pendant la lecture, sinon `fallback`. */
export const useLiveParam = (trackId: string, param: string, fallback: number): number => {
  const key = liveKey(trackId, param);
  const sub = useCallback((fn: () => void) => subscribe(key, fn), [key]);
  const v = useSyncExternalStore(sub, () => values.get(key), () => undefined);
  return v === undefined ? fallback : v;
};
