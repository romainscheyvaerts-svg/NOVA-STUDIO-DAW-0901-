import { useSyncExternalStore } from 'react';
import type { Track } from '../types';

/**
 * Mode de solo, comme Pro Tools (Options › Mode Solo) :
 *  - « Verrouiller » (Latch, par défaut, celui de la session LENNON) : chaque
 *    solo s'ajoute aux précédents ;
 *  - « X-OR » (exclusif) : soloer une piste annule les solos précédents — on
 *    passe d'une voix à l'autre d'un seul clic, sans « effacer les solos ».
 * Un solo posé sur plusieurs pistes d'un même geste (Maj+S sur une sélection,
 * groupe, VCA) reste un seul « solo » : elles restent toutes en solo ensemble.
 *
 * Choix d'écoute de l'ingé : réglage du poste (stocké localement), pas du
 * projet — il ne voyage pas en collaboration, comme dans Pro Tools où c'est
 * une option de la machine.
 *
 * Module pur + petit magasin (tests/soloModes.test.ts).
 */

export type SoloLatch = 'latch' | 'xor';

const KEY = 'nova_solo_mode';

const read = (): SoloLatch => {
  try { return localStorage.getItem(KEY) === 'xor' ? 'xor' : 'latch'; } catch { return 'latch'; }
};

let current: SoloLatch = read();
const subs = new Set<() => void>();

export const soloModeStore = {
  get: (): SoloLatch => current,
  set(mode: SoloLatch) {
    if (mode === current) return;
    current = mode;
    try { localStorage.setItem(KEY, mode); } catch { /* stockage indisponible */ }
    subs.forEach(f => f());
  },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** Tests : relit le stockage. */
  reload() { current = read(); subs.forEach(f => f()); },
};

/** Mode de solo courant (re-rendu quand il change). */
export const useSoloMode = (): SoloLatch => useSyncExternalStore(soloModeStore.subscribe, soloModeStore.get, soloModeStore.get);

/**
 * X-OR : après un geste qui a mis `soloedNow` en solo, les autres pistes
 * perdent leur solo. Le master, les pistes du geste et les solos safe ne
 * changent pas. Renvoie le même tableau si rien ne change.
 */
export function exclusiveSolo(tracks: Track[], soloedNow: string[]): Track[] {
  if (!soloedNow.length) return tracks;
  const keep = new Set(soloedNow);
  let changed = false;
  const out = tracks.map(t => {
    if (keep.has(t.id) || t.id === 'master' || !t.isSolo) return t;
    changed = true;
    return { ...t, isSolo: false };
  });
  return changed ? out : tracks;
}

/** Pistes qui viennent de passer en solo entre deux états (pour appliquer le X-OR). */
export function newlySoloed(before: Pick<Track, 'id' | 'isSolo'>[], after: Pick<Track, 'id' | 'isSolo'>[]): string[] {
  const was = new Set(before.filter(t => t.isSolo).map(t => t.id));
  return after.filter(t => t.isSolo && !was.has(t.id) && t.id !== 'master').map(t => t.id);
}
