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

/**
 * DAW intégré dans le site Make Music (page /daw, cadre) ou dans l'application iPhone :
 * il suit le réglage noir / blanc DU SITE. Avant le 13/10/2026, le site passait en blanc
 * et le DAW restait noir (son propre bouton de thème était masqué avec la barre de marque).
 *
 *  1. adresse du cadre : `?theme=light` ou `?theme=dark` ;
 *  2. message du site (cadre d'un autre domaine) : `{ type: 'NOVA_THEME', theme: 'light' | 'dark' }`,
 *     envoyé à chaque changement et en réponse à `NOVA_READY_FOR_THEME` ;
 *  3. même domaine (copie embarquée dans l'appli iPhone) : lecture directe de <html class="dark">
 *     du site, suivie en direct.
 * Le choix du site devient le choix mémorisé du DAW (il reste modifiable dans le DAW).
 */
const HOST_ORIGIN = /^(https:\/\/(www\.)?studiomakemusic\.com|(capacitor|ionic):\/\/localhost|https?:\/\/(localhost|127\.0\.0\.1|[\w-]+\.localhost)(:\d+)?)$/;

export function hostThemeFromMessage(data: unknown): Theme | null {
  const d = data as { type?: unknown; theme?: unknown } | null;
  if (!d || d.type !== 'NOVA_THEME') return null;
  return d.theme === 'light' || d.theme === 'dark' ? d.theme : null;
}

let following = false;
export function followHostTheme() {
  if (following || typeof window === 'undefined') return;
  following = true;
  const follow = (t: Theme | null) => { if (t && (pref !== t)) themeStore.setPref(t); };
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'light' || q === 'dark') follow(q);
  } catch { /* adresse illisible */ }
  if (window.parent === window) return;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !HOST_ORIGIN.test(e.origin)) return;
    follow(hostThemeFromMessage(e.data));
  });
  // Même domaine : le site pose ses couleurs sur <html> (variable --background) et la classe « dark ».
  try {
    const host = window.parent.document.documentElement;
    if (host && host.style.getPropertyValue('--background')) {
      const read = () => follow(host.classList.contains('dark') ? 'dark' : 'light');
      read();
      new MutationObserver(read).observe(host, { attributes: true, attributeFilter: ['class'] });
    }
  } catch { /* autre domaine : on attend le message du site */ }
  try { window.parent.postMessage({ type: 'NOVA_READY_FOR_THEME' }, '*'); } catch { /* */ }
}

export function useTheme() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}
