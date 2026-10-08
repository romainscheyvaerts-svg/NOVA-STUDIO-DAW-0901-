import { useSyncExternalStore } from 'react';

/**
 * Dispositions de fenêtres (Pro Tools : Window Configurations), R17.
 *
 * Une disposition retient la VUE (arrangement / console), les panneaux ouverts
 * (navigateur et son onglet, liste des pistes, paroles…) et le ZOOM de
 * l'arrangement (horizontal, hauteur des pistes, défilement). Chaque morceau de
 * l'interface s'inscrit ici avec `registerLayoutPart(nom, { get, set })` :
 * App pour la vue et les panneaux, ArrangementView pour le zoom.
 *
 * 5 emplacements : 1 Enregistrement, 2 Édition, 3 Mix (livrés, modifiables,
 * « Remettre comme livrée »), 4 et 5 libres. Rappel : Ctrl+Maj+1–5 ou, comme
 * Pro Tools, pavé « . » N « * » ; enregistrer : pavé « . » N « / ».
 */

export type LayoutSnapshot = Record<string, any>;

export interface WindowLayout {
  slot: number;
  name: string;
  /** Morceaux d'interface enregistrés (les absents ne bougent pas au rappel). */
  parts: LayoutSnapshot;
  builtIn?: boolean;
  savedAt?: number;
}

interface Part { get: () => any; set: (v: any) => void }
const parts = new Map<string, Part>();

export function registerLayoutPart(name: string, part: Part): () => void {
  parts.set(name, part);
  return () => { if (parts.get(name) === part) parts.delete(name); };
}

export const LAYOUT_SLOTS = [1, 2, 3, 4, 5];

/** Dispositions livrées. */
export const BUILT_IN_LAYOUTS: WindowLayout[] = [
  { slot: 1, name: 'Enregistrement', builtIn: true, parts: { view: 'ARRANGEMENT', sidebar: false, panel: null, zoom: { h: 40, v: 160 } } },
  { slot: 2, name: 'Édition', builtIn: true, parts: { view: 'ARRANGEMENT', sidebar: false, panel: 'tracks', zoom: { h: 120, v: 120 } } },
  { slot: 3, name: 'Mix', builtIn: true, parts: { view: 'MIXER', sidebar: true, sideTab: 'FX', panel: null } },
];

const KEY = 'nova_window_layouts_v1';
type Stored = Record<number, WindowLayout>;

let stored: Stored = (() => {
  try { const t = localStorage.getItem(KEY); const v = t ? JSON.parse(t) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
})();
let version = 0;
let lastRecalled: number | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch { /* stockage indisponible */ }
  listeners.forEach(fn => fn());
};

export function getLayout(slot: number): WindowLayout | null {
  return stored[slot] || BUILT_IN_LAYOUTS.find(l => l.slot === slot) || null;
}
export const listLayouts = (): { slot: number; layout: WindowLayout | null; custom: boolean }[] =>
  LAYOUT_SLOTS.map(slot => ({ slot, layout: getLayout(slot), custom: !!stored[slot] }));

/** Photographie de l'interface actuelle. */
export function captureLayout(): LayoutSnapshot {
  const snap: LayoutSnapshot = {};
  parts.forEach((p, name) => { try { const v = p.get(); if (v !== undefined) snap[name] = v; } catch { /* morceau indisponible */ } });
  return snap;
}

/** Applique une disposition ; renvoie le nom, ou null si l'emplacement est vide. */
export function applyLayout(slot: number): WindowLayout | null {
  const l = getLayout(slot);
  if (!l) return null;
  // La vue d'abord (l'arrangement doit exister pour recevoir son zoom), le reste ensuite.
  const order = Object.keys(l.parts).sort((a, b) => (a === 'view' ? -1 : b === 'view' ? 1 : 0));
  const later: string[] = [];
  for (const name of order) {
    const p = parts.get(name);
    if (p) { try { p.set(l.parts[name]); } catch { /* ignoré */ } } else later.push(name);
  }
  // Morceaux qui n'existent qu'après le changement de vue (zoom de l'arrangement) : au rendu suivant.
  if (later.length) setTimeout(() => later.forEach(name => { const p = parts.get(name); if (p) { try { p.set(l.parts[name]); } catch { /* ignoré */ } } }), 120);
  lastRecalled = slot;
  listeners.forEach(fn => fn());
  return l;
}

export function saveLayout(slot: number, name?: string): WindowLayout {
  const prev = getLayout(slot);
  const l: WindowLayout = { slot, name: (name || prev?.name || `Disposition ${slot}`).slice(0, 40), parts: captureLayout(), savedAt: Date.now() };
  stored = { ...stored, [slot]: l };
  lastRecalled = slot;
  changed();
  return l;
}

export function renameLayout(slot: number, name: string) {
  const l = getLayout(slot);
  if (!l) return;
  stored = { ...stored, [slot]: { ...l, builtIn: false, name: name.trim().slice(0, 40) || l.name } };
  changed();
}

/** Remet la disposition livrée (ou vide l'emplacement 4 / 5). */
export function resetLayout(slot: number) {
  const { [slot]: _drop, ...rest } = stored;
  stored = rest;
  changed();
}

export const layoutsStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  version: () => version,
  lastRecalled: () => lastRecalled,
};
export const useLayoutsVersion = () => useSyncExternalStore(layoutsStore.subscribe, () => `${version}:${lastRecalled}`, () => '0');

/** Pour les tests. */
export const __resetLayoutsForTests = () => { stored = {}; parts.clear(); lastRecalled = null; version = 0; };
