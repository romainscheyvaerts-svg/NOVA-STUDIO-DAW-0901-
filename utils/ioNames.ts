import { useSyncExternalStore } from 'react';
import type { RecordInput } from '../types';
import { inputLabel } from './multiRecord';

/**
 * Entrées nommées (Pro Tools : I/O Setup, onglet Input, simplifié) : « Entrée 1 »
 * devient « Micro cabine », « Entrée 3 » « Guitare DI »… Les noms décrivent le
 * câblage du STUDIO (la carte son de ce poste) : ils sont gardés sur ce poste,
 * pas dans le projet, comme le réglage d'E/S de Pro Tools sur la machine.
 * Les sélecteurs d'entrée des pistes les affichent partout.
 * Module pur + petit magasin (tests/proToolsEcarts.test.ts).
 */

const KEY = 'nova_io_input_names';
export const MAX_NAMED_INPUTS = 32;

const read = (): Record<number, string> => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return sanitizeNames(raw);
  } catch { return {}; }
};

/** Noms propres : index 0-31, texte court non vide. */
export function sanitizeNames(raw: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= MAX_NAMED_INPUTS || typeof v !== 'string') continue;
    const n = v.trim().slice(0, 40);
    if (n) out[i] = n;
  }
  return out;
}

let names: Record<number, string> = read();
const subs = new Set<() => void>();

export const ioNamesStore = {
  get: () => names,
  set(next: Record<number, string>) {
    names = sanitizeNames(next);
    try { localStorage.setItem(KEY, JSON.stringify(names)); } catch { /* stockage indisponible */ }
    subs.forEach(f => f());
  },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

export const useIoNames = () => useSyncExternalStore(ioNamesStore.subscribe, ioNamesStore.get, ioNamesStore.get);

/** « Micro cabine » (mono), « Overheads » (paire 1-2 : nom de la paire, sinon les deux noms). */
export function inputName(spec: RecordInput | null | undefined, map: Record<number, string> = names): string | null {
  if (!spec || !Number.isInteger(spec.ch)) return null;
  const a = map[spec.ch];
  if (!spec.stereo) return a || null;
  const b = map[spec.ch + 1];
  if (a && b) return a === b ? a : `${a} + ${b}`;
  return a || b || null;
}

/** Libellé d'une entrée avec son nom : « In 1 · Micro cabine », « Entrée 1 · Micro cabine ». */
export function namedInputLabel(spec: RecordInput | null | undefined, short = false, map: Record<number, string> = names): string {
  const base = inputLabel(spec, short);
  const n = inputName(spec, map);
  return n ? (short ? n : `${base} · ${n}`) : base;
}
