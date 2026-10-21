import { useSyncExternalStore } from 'react';

/**
 * Pistes épinglées (écart 25 « grosses séances ») : elles restent visibles en haut de
 * l'arrangement quand on fait défiler 80 pistes (bandeau components/PinnedTracksPane).
 *
 * Réglage d'AFFICHAGE, comme le zoom : gardé par projet sur cet appareil (stockage
 * local), jamais dans le projet ni en collaboration ; rien ne change dans le son.
 */
const KEY = 'nova_track_pins_v1';
const MAX_PINS = 8;
type Stored = Record<string, string[]>;

let stored: Stored = (() => {
  try { const t = localStorage.getItem(KEY); const v = t ? JSON.parse(t) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
})();
let project = '';
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch { /* stockage indisponible */ }
  listeners.forEach(fn => fn());
};

/** Projet affiché (App le donne) : les épingles sont rangées par projet. */
export function setPinsProject(id: string | null | undefined) {
  const p = id || '';
  if (p === project) return;
  project = p;
  version++;
  listeners.forEach(fn => fn());
}

export const pinnedIds = (): string[] => stored[project] || [];
export const isPinned = (trackId: string) => pinnedIds().includes(trackId);

/** Épingle / désépingle ; renvoie le nouvel état (vrai = épinglée). 8 au plus : la plus ancienne part. */
export function togglePin(trackId: string, on?: boolean): boolean {
  const cur = pinnedIds();
  const want = on ?? !cur.includes(trackId);
  const next = want ? [...cur.filter(x => x !== trackId), trackId].slice(-MAX_PINS) : cur.filter(x => x !== trackId);
  stored = { ...stored, [project]: next };
  if (!next.length) { const { [project]: _d, ...rest } = stored; stored = rest; }
  changed();
  return want;
}

export function clearPins() { const { [project]: _d, ...rest } = stored; stored = rest; changed(); }

/** Retire les épingles des pistes supprimées. */
export function prunePins(existing: Set<string>) {
  const cur = pinnedIds();
  const next = cur.filter(id => existing.has(id));
  if (next.length !== cur.length) { stored = { ...stored, [project]: next }; changed(); }
}

export const pinsStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  version: () => version,
};
export const usePinnedIds = (): string[] => {
  useSyncExternalStore(pinsStore.subscribe, () => version, () => 0);
  return pinnedIds();
};

/** Pour les tests. */
export const __resetPinsForTests = () => { stored = {}; project = ''; version = 0; };
