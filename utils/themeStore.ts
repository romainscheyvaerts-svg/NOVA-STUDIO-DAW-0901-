import { useSyncExternalStore } from 'react';
import type { Theme } from '../types';

/**
 * Thème de l'interface : sombre, clair ou automatique (suit le réglage du
 * téléphone / de l'ordinateur). Le choix est mémorisé sur l'appareil
 * (localStorage « nova_theme ») et appliqué sur <html data-theme="…">.
 *
 * Avant le 07/10/2026 le thème n'était qu'un état de l'application, perdu à
 * chaque rechargement, et le « clair » était un bleu marine presque identique
 * au sombre : sur téléphone on ne voyait aucune différence.
 */
export type ThemePref = Theme | 'system';

const KEY = 'nova_theme';
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* stockage indisponible : thème par défaut */ }
  return 'dark';
}

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

let pref: ThemePref = typeof window !== 'undefined' ? readPref() : 'dark';

export function resolveTheme(p: ThemePref = pref): Theme {
  if (p === 'system') return mq?.matches ? 'light' : 'dark';
  return p;
}

let snapshot = { pref, theme: resolveTheme(pref) };

function apply() {
  const theme = resolveTheme(pref);
  snapshot = { pref, theme };
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#0c0d10');
  }
  listeners.forEach((l) => l());
}

mq?.addEventListener?.('change', () => { if (pref === 'system') apply(); });

export const themeStore = {
  get: () => snapshot,
  setPref(p: ThemePref) {
    pref = p;
    try { localStorage.setItem(KEY, p); } catch { /* ignoré */ }
    apply();
  },
  /** Bascule rapide (bouton soleil / lune) : passe au thème opposé à celui affiché. */
  toggle() { themeStore.setPref(resolveTheme() === 'dark' ? 'light' : 'dark'); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Applique le thème mémorisé au démarrage. */
  init() { apply(); },
};

export function useTheme() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}
