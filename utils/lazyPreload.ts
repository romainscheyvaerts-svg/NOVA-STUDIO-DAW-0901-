import React from 'react';

/**
 * React.lazy + préchargement « vrai ». Importer le module d'avance ne suffit pas : à la 1re
 * ouverture, React.lazy suspend quand même une fois, et React 19 retient alors l'affichage
 * ~300 ms (fenêtres Exporter, Tempo, Master Nova… mesurées à 300-450 ms à l'ouverture).
 * `preload()` initialise le composant paresseux lui-même : une fois le module arrivé, la
 * fenêtre s'affiche dans la même image que le clic. Sans effet si React change ses détails
 * internes (on retombe sur le comportement normal de React.lazy).
 */
export type PreloadableLazy<T extends React.ComponentType<any>> = React.LazyExoticComponent<T> & { preload: () => void };

export function lazyWithPreload<T extends React.ComponentType<any>>(factory: () => Promise<{ default: T }>): PreloadableLazy<T> {
  const C = React.lazy(factory) as PreloadableLazy<T>;
  C.preload = () => {
    const c = C as any;
    if (typeof c._init !== 'function') { void factory().catch(() => { /* réessayé à l'ouverture */ }); return; }
    try { c._init(c._payload); } catch (p) {
      if (p && typeof (p as any).then === 'function') (p as Promise<unknown>).then(() => {}, () => {});
    }
  };
  return C;
}

/**
 * Précharge une liste de composants l'un après l'autre quand le navigateur est libre
 * (après `delayMs`), pour ne pas gêner l'ouverture du studio ni une prise en cours.
 */
export function preloadWhenIdle(items: { preload: () => void }[], delayMs = 2500): () => void {
  if (typeof window === 'undefined') return () => {};
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  let stopped = false;
  let idle: number | null = null;
  let timer: number | null = null;
  let i = 0;
  const step = () => {
    if (stopped || i >= items.length) return;
    try { items[i++].preload(); } catch { /* suivant */ }
    if (w.requestIdleCallback) idle = w.requestIdleCallback(step, { timeout: 2000 });
    else timer = window.setTimeout(step, 50);
  };
  const t = window.setTimeout(step, delayMs);
  return () => { stopped = true; window.clearTimeout(t); if (idle !== null) w.cancelIdleCallback?.(idle); if (timer !== null) window.clearTimeout(timer); };
}
