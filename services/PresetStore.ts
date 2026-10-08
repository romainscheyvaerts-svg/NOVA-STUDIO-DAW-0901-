/**
 * Rangement des presets d'effets et des Track Presets (R4) :
 *  - presets de l'utilisateur sur l'appareil (IndexedDB « nova-presets », repli
 *    localStorage si IndexedDB est refusé, mémoire dans les tests) ;
 *  - Track Presets livrés avec NOVA (templates/presets/*.novachain), en lecture
 *    seule (on les duplique pour les modifier) ;
 *  - favoris (étoile) rangés à part : un preset livré peut aussi être favori.
 *
 * Cloud : les modèles de session (services/TemplateStore) n'ont pas encore de
 * stockage en ligne (pas de table Supabase) ; les presets restent donc sur
 * l'appareil, avec export / import de fichiers .novapreset et .novachain pour
 * les emporter (et ils voyagent dans le projet et en collaboration, avec l'effet).
 */
import {
  AnyPreset, CHAIN_FORMAT, newPresetId, parsePresetFile, PluginPreset, presetFilename, presetMatches, PRESET_FORMAT,
  serializePreset, TrackPreset,
} from '../utils/presets';
import type { PluginInstance } from '../types';

export interface PresetBackend {
  all(): Promise<AnyPreset[]>;
  put(p: AnyPreset): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'nova-presets';
const STORE = 'presets';
const LS_KEY = 'nova_presets_v1';
const FAV_KEY = 'nova_preset_favorites_v1';

const idbBackend = (): PresetBackend => {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  };
  return {
    all: () => run<AnyPreset[]>('readonly', s => s.getAll() as IDBRequest<AnyPreset[]>),
    put: async p => { await run('readwrite', s => s.put(p)); },
    remove: async id => { await run('readwrite', s => s.delete(id)); },
  };
};

const lsBackend = (): PresetBackend => {
  const read = (): AnyPreset[] => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
  const write = (list: AnyPreset[]) => { localStorage.setItem(LS_KEY, JSON.stringify(list)); };
  return {
    all: async () => read(),
    put: async p => { write([...read().filter(x => x.id !== p.id), p]); },
    remove: async id => { write(read().filter(x => x.id !== id)); },
  };
};

export const memoryPresetBackend = (): PresetBackend => {
  const m = new Map<string, AnyPreset>();
  return {
    all: async () => [...m.values()].map(x => JSON.parse(JSON.stringify(x))),
    put: async p => { m.set(p.id, JSON.parse(JSON.stringify(p))); },
    remove: async id => { m.delete(id); },
  };
};

let backend: PresetBackend | null = null;
const getBackend = (): PresetBackend => {
  if (backend) return backend;
  if (typeof indexedDB !== 'undefined') backend = idbBackend();
  else if (typeof localStorage !== 'undefined') backend = lsBackend();
  else backend = memoryPresetBackend();
  return backend;
};
/** Tests : stockage à utiliser. */
export const setPresetBackend = (b: PresetBackend | null) => { backend = b; favCache = null; };

const userPresets = async (): Promise<AnyPreset[]> => {
  try { return await getBackend().all(); } catch (e) {
    if (typeof localStorage !== 'undefined') { backend = lsBackend(); return backend.all(); }
    throw e;
  }
};

// ─── Favoris ───────────────────────────────────────────────────────────────────

let favCache: Set<string> | null = null;
const favorites = (): Set<string> => {
  if (favCache) return favCache;
  try { favCache = new Set(JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(FAV_KEY)) || '[]')); } catch { favCache = new Set(); }
  return favCache;
};
const saveFavorites = () => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(FAV_KEY, JSON.stringify([...favorites()])); } catch { /* stockage plein ou refusé */ } };

export const isFavorite = (id: string) => favorites().has(id);
export const setFavorite = (id: string, on: boolean) => { const f = favorites(); if (on) f.add(id); else f.delete(id); saveFavorites(); };

// ─── Livrés avec NOVA ──────────────────────────────────────────────────────────

type BundledLoader = () => Promise<AnyPreset[]>;
const defaultBundled: BundledLoader = async () => {
  const files = import.meta.glob('../templates/presets/*.{novachain,novapreset}', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
  const out: AnyPreset[] = [];
  for (const [path, load] of Object.entries(files)) {
    try { out.push({ ...parsePresetFile(await load()), bundled: true }); } catch (e) { console.warn('[Presets] Preset livré illisible :', path, e); }
  }
  return out;
};
let bundledLoader: BundledLoader = defaultBundled;
let bundledCache: Promise<AnyPreset[]> | null = null;
/** Tests : presets livrés à utiliser. */
export const setBundledPresetLoader = (l: BundledLoader | null) => { bundledLoader = l || defaultBundled; bundledCache = null; };
const bundledPresets = () => { if (!bundledCache) bundledCache = bundledLoader().catch(() => []); return bundledCache; };

// ─── API ───────────────────────────────────────────────────────────────────────

const byFavThenName = (a: AnyPreset, b: AnyPreset) =>
  Number(isFavorite(b.id)) - Number(isFavorite(a.id)) || Number(!!b.bundled) - Number(!!a.bundled) || a.name.localeCompare(b.name, 'fr');

const all = async (): Promise<AnyPreset[]> => {
  const [b, u] = await Promise.all([bundledPresets(), userPresets()]);
  return [...b, ...u.filter(x => !b.some(y => y.id === x.id))];
};

/** Presets qui se chargent sur cet effet : favoris d'abord, puis par nom. */
export const listPluginPresets = async (plugin: PluginInstance): Promise<PluginPreset[]> =>
  (await all()).filter((p): p is PluginPreset => p.format === PRESET_FORMAT && presetMatches(p, plugin)).sort(byFavThenName);

/** Track Presets : favoris, livrés, puis par nom. */
export const listTrackPresets = async (): Promise<TrackPreset[]> =>
  (await all()).filter((p): p is TrackPreset => p.format === CHAIN_FORMAT).sort(byFavThenName);

export const getPreset = async (id: string): Promise<AnyPreset | null> => (await all()).find(p => p.id === id) || null;

/** Enregistre (un preset livré n'est jamais écrasé : copie). */
export const savePreset = async <T extends AnyPreset>(p: T): Promise<T> => {
  const b = await bundledPresets();
  const copy = { ...p, id: b.some(x => x.id === p.id) ? newPresetId(p.format === CHAIN_FORMAT ? 'c' : 'p') : p.id, updatedAt: Date.now() } as T;
  delete (copy as any).bundled;
  await getBackend().put(copy);
  return copy;
};

export const renamePreset = async (id: string, name: string): Promise<AnyPreset> => {
  const p = await getPreset(id);
  if (!p) throw new Error('Ce preset n’existe plus sur cet appareil.');
  if (p.bundled) throw new Error('Les presets livrés avec NOVA ne se renomment pas : enregistre-le sous un autre nom.');
  const clean = name.trim();
  if (!clean) throw new Error('Donne un nom au preset.');
  const next = { ...p, name: clean.slice(0, 80), updatedAt: Date.now() };
  await getBackend().put(next);
  return next;
};

export const deletePreset = async (id: string): Promise<void> => {
  const p = await getPreset(id);
  if (!p) return;
  if (p.bundled) throw new Error('Les presets livrés avec NOVA ne se suppriment pas.');
  await getBackend().remove(id);
  setFavorite(id, false);
};

/** Fichier à télécharger (.novapreset / .novachain). */
export const exportPresetFile = (p: AnyPreset): { blob: Blob; filename: string } => ({
  blob: new Blob([serializePreset(p)], { type: 'application/json' }),
  filename: presetFilename(p),
});

/** Importe un fichier (un id déjà pris devient une copie). */
export const importPresetText = async (text: string): Promise<AnyPreset> => {
  const p = parsePresetFile(text);
  const existing = await all();
  const clash = existing.some(x => x.id === p.id);
  const saved = { ...p, id: clash ? newPresetId(p.format === CHAIN_FORMAT ? 'c' : 'p') : p.id, updatedAt: Date.now() } as AnyPreset;
  await getBackend().put(saved);
  return saved;
};
