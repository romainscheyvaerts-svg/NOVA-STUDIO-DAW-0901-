import { useSyncExternalStore } from 'react';

/**
 * Position de la tête de lecture, hors de l'état React.
 *
 * Pendant la lecture, App écrivait `currentTime` dans son état à chaque image :
 * tout le studio (≈ 4000 lignes de composants) se re-rendait 60 fois par
 * seconde. La position « vivante » vit désormais ici ; seuls les composants qui
 * l'affichent (horloge, tête de lecture, prompteur…) s'y abonnent.
 *
 * `state.currentTime` reste la position « validée » (arrêt, pause, saut) : la
 * boutique est resynchronisée sur elle à chacun de ces moments.
 */
type Listener = () => void;

let time = 0;
const listeners = new Set<Listener>();

export const playheadStore = {
  get: (): number => time,
  set(t: number) {
    if (!Number.isFinite(t) || t === time) return;
    time = t;
    listeners.forEach(l => l());
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

/**
 * Position de lecture pour un composant React. `step` (en secondes) arrondit la
 * valeur : le composant ne se re-rend que quand la valeur arrondie change
 * (0.01 pour une horloge au centième, 0.1 pour un affichage au dixième…).
 */
export function usePlayheadTime(step = 0): number {
  const snap = step > 0 ? () => Math.floor(time / step) * step : () => time;
  return useSyncExternalStore(playheadStore.subscribe, snap, snap);
}
