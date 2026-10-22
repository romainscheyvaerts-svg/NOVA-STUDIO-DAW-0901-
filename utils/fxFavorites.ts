import { useSyncExternalStore } from 'react';

/**
 * Effets favoris et récents (audit mix 22/10/2026) : comme les « favoris » et « récemment utilisés »
 * des menus d'inserts des DAW. Partagés par le menu « Ajouter un effet » des tranches et par la liste
 * des VST du navigateur. Rangés dans ce navigateur (préférence de l'ingé, pas du projet).
 *
 * Identifiants : type d'un effet NOVA (« PROEQ12 »), ou `vst:<clé>` pour un VST du PC.
 */
const FAV_KEY = 'nova_fx_favoris';
const REC_KEY = 'nova_fx_recents';
export const RECENT_MAX = 6;
export const FAVORITE_MAX = 40;

export interface FxPrefs { favorites: string[]; recents: string[] }

const read = (k: string): string[] => {
  try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
};
const write = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible : gardé en mémoire */ } };

let state: FxPrefs = { favorites: read(FAV_KEY), recents: read(REC_KEY) };
const subs = new Set<() => void>();
const set = (next: FxPrefs) => { state = next; write(FAV_KEY, next.favorites); write(REC_KEY, next.recents); subs.forEach(f => f()); };

/** Ajoute en tête des récents (sans doublon, 6 au plus). Pur. */
export const withRecent = (recents: string[], id: string, max = RECENT_MAX): string[] => [id, ...recents.filter(x => x !== id)].slice(0, max);
/** Ajoute ou retire un favori. Pur. */
export const toggledFavorite = (favs: string[], id: string, max = FAVORITE_MAX): string[] => (favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id].slice(-max));

export const fxPrefs = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  noteUsed: (id: string) => { if (id) set({ ...state, recents: withRecent(state.recents, id) }); },
  toggleFavorite: (id: string) => set({ ...state, favorites: toggledFavorite(state.favorites, id) }),
  isFavorite: (id: string) => state.favorites.includes(id),
};

export const useFxPrefs = (): FxPrefs => useSyncExternalStore(fxPrefs.subscribe, fxPrefs.get, fxPrefs.get);

/** Identifiant stable d'un VST du PC (même plugin d'une séance à l'autre). */
export const vstFxId = (p: { path?: string; pluginName?: string | null; name: string }): string =>
  `vst:${(p.path || '').toLowerCase()}|${p.pluginName || p.name}`;
