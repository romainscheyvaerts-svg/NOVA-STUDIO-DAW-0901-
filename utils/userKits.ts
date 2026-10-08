import type { DrumMachine, DrumRow } from './drumKits';
import { STEPS_PER_BAR, rowLength } from './drumPatterns';
import { PadSampleInfo, userSampleId } from './drumSamples';

/**
 * R18 · Kits perso réutilisables d'un projet à l'autre (FL : « Save channel
 * state / kit », Live : preset de Drum Rack, Logic : patch de Drum Machine
 * Designer). Un kit garde les SONS et les RÉGLAGES des pads (nom, son,
 * volume, pan, accordage, longueur, zone jouée, choke, mix, résolution,
 * longueur et swing de la rangée), jamais le motif : le charger dans un autre
 * projet change les sons et garde les pas des pads de même nom.
 *
 * Stockage local (IndexedDB « nova-kits », repli mémoire), export / import en
 * fichier `.novakit` (zip : kit.json + samples/<id>.wav). Le cloud viendra
 * avec R19. Logique pure ici ; le stockage et le zip sont plus bas.
 */

export const KIT_EXT = '.novakit';
export const KIT_FORMAT = 1;

/** Réglages d'un pad gardés dans un kit (tout sauf le motif). */
export type KitPad = Omit<DrumRow, 'steps' | 'ratchet' | 'stepPan' | 'stepPitch' | 'muted' | 'solo'>;

export interface UserKit {
  id: string;
  name: string;
  format: number;
  createdAt: number;
  updatedAt: number;
  /** Style d'origine (sons de la bibliothèque proposés par style). */
  kitId: string;
  swing?: number;
  pads: KitPad[];
  /** Samples perso : infos + son (WAV). */
  samples: Record<string, { info: PadSampleInfo; wav?: ArrayBuffer }>;
}

export const newKitId = () => `kit${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Nom propre d'un kit (1 à 40 caractères). */
export const kitName = (n: string) => (n || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Mon kit';

const padOf = (r: DrumRow): KitPad => {
  const { steps: _s, ratchet: _r, stepPan: _p, stepPitch: _h, muted: _m, solo: _o, ...pad } = r;
  return JSON.parse(JSON.stringify(pad));
};

/** Kit à partir de la batterie du projet (le son des samples perso est fourni par `wavOf`). */
export function kitFromDrumMachine(dm: DrumMachine, name: string, wavOf: (sampleId: string) => ArrayBuffer | undefined, now = Date.now()): UserKit {
  const samples: UserKit['samples'] = {};
  dm.rows.forEach(r => {
    const id = userSampleId(r.sound);
    if (id && !samples[id]) {
      const info = dm.samples?.[id] || { name: r.name, duration: 0 };
      const { audioRef: _a, ...clean } = info;
      samples[id] = { info: clean, wav: wavOf(id) };
    }
  });
  return {
    id: newKitId(), name: kitName(name), format: KIT_FORMAT, createdAt: now, updatedAt: now,
    kitId: dm.kitId, ...(dm.swing ? { swing: dm.swing } : {}), pads: dm.rows.map(padOf), samples,
  };
}

/**
 * Charge un kit dans la batterie d'un projet : les pads du kit remplacent les
 * pads actuels ; un pad de même id (ou, à défaut, de même nom) garde ses pas
 * dans tous les motifs. Sans batterie : batterie vide avec les pads du kit.
 */
export function applyKit(dm: DrumMachine | null, kit: UserKit): DrumMachine {
  const bars = dm?.bars || 1;
  const old = dm?.rows || [];
  const match = (p: KitPad) => old.find(r => r.id === p.id) || old.find(r => r.name.toLowerCase() === p.name.toLowerCase());
  const rows: DrumRow[] = kit.pads.map(p => {
    const prev = match(p);
    const len = rowLength(p, bars);
    const keep = prev && rowLength(prev, bars) === len;
    return {
      ...JSON.parse(JSON.stringify(p)),
      steps: keep ? [...prev!.steps] : new Array(len).fill(0),
      ratchet: keep ? [...prev!.ratchet] : new Array(len).fill(1),
      ...(keep && prev!.stepPan ? { stepPan: [...prev!.stepPan] } : {}),
      ...(keep && prev!.stepPitch ? { stepPitch: [...prev!.stepPitch] } : {}),
    } as DrumRow;
  });
  // Motifs : les pas suivent le pad renommé (id du kit) ; les pads retirés disparaissent.
  const renamed = new Map<string, string>();
  kit.pads.forEach(p => { const prev = match(p); if (prev && prev.id !== p.id) renamed.set(prev.id, p.id); });
  const ids = new Set(rows.map(r => r.id));
  const remap = <T,>(rec: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!rec) return rec;
    const out: Record<string, T> = {};
    Object.entries(rec).forEach(([k, v]) => { const id = renamed.get(k) || k; if (ids.has(id)) out[id] = v; });
    return out;
  };
  const patterns = dm?.patterns?.map(p => ({
    ...p, steps: remap(p.steps)!, ratchet: remap(p.ratchet)!,
    ...(p.pan ? { pan: remap(p.pan) } : {}), ...(p.pitch ? { pitch: remap(p.pitch) } : {}),
  }));
  const samples: Record<string, PadSampleInfo> = {};
  Object.entries(kit.samples).forEach(([id, s]) => { samples[id] = { ...s.info }; });
  return {
    ...(dm || { bars: 1 as const, swing: 0 }),
    kitId: kit.kitId || dm?.kitId || 'empty',
    ...(typeof kit.swing === 'number' ? { swing: kit.swing } : {}),
    rows,
    ...(patterns ? { patterns } : {}),
    samples,
  } as DrumMachine;
}

/** Les sons et réglages de deux batteries sont-ils les mêmes ? (preuve « kit identique ») */
export const kitSignature = (dm: DrumMachine): string => JSON.stringify(dm.rows.map(padOf));

/** Kit lu d'un fichier ou de la base : vérifié et borné. */
export function parseKit(raw: unknown): UserKit | null {
  const k = raw as Partial<UserKit> | null;
  if (!k || typeof k !== 'object' || !Array.isArray(k.pads) || !k.pads.length) return null;
  const pads = k.pads.slice(0, 30).filter(p => p && typeof p.id === 'string' && typeof p.sound === 'string' && typeof p.name === 'string');
  if (!pads.length) return null;
  const samples: UserKit['samples'] = {};
  Object.entries(k.samples || {}).forEach(([id, s]) => {
    if (/^[\w-]{1,48}$/.test(id) && s && typeof s === 'object' && (s as { info?: unknown }).info) samples[id] = s as UserKit['samples'][string];
  });
  return {
    id: typeof k.id === 'string' && /^[\w-]{1,48}$/.test(k.id) ? k.id : newKitId(),
    name: kitName(String(k.name || '')), format: KIT_FORMAT,
    createdAt: Number(k.createdAt) || Date.now(), updatedAt: Number(k.updatedAt) || Date.now(),
    kitId: typeof k.kitId === 'string' ? k.kitId : 'empty',
    ...(typeof k.swing === 'number' ? { swing: Math.max(0, Math.min(0.6, k.swing)) } : {}),
    pads: pads.map(p => ({ ...p, volume: Number.isFinite(p.volume) ? p.volume : 0.85, pan: Number.isFinite(p.pan) ? p.pan : 0 })),
    samples,
  };
}

/** Pas vides d'un nouveau pad (utilisé par les tests). */
export const blankSteps = (bars = 1) => new Array(STEPS_PER_BAR * bars).fill(0);

// ===== Stockage local (IndexedDB) =====

export interface KitBackend {
  all(): Promise<UserKit[]>;
  put(k: UserKit): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'nova-kits';
const STORE = 'kits';

const idbBackend = (): KitBackend => {
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
    all: () => run<UserKit[]>('readonly', s => s.getAll() as IDBRequest<UserKit[]>),
    put: async k => { await run('readwrite', s => s.put(k)); },
    remove: async id => { await run('readwrite', s => s.delete(id)); },
  };
};

export const memoryKitBackend = (): KitBackend => {
  const m = new Map<string, UserKit>();
  return { all: async () => [...m.values()], put: async k => { m.set(k.id, k); }, remove: async id => { m.delete(id); } };
};

let backend: KitBackend | null = null;
const getBackend = (): KitBackend => {
  if (!backend) backend = typeof indexedDB !== 'undefined' ? idbBackend() : memoryKitBackend();
  return backend;
};
/** Tests : stockage à utiliser. */
export const setKitBackend = (b: KitBackend | null) => { backend = b; };

const listeners = new Set<() => void>();
const changed = () => listeners.forEach(l => l());
export const onKitsChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export async function listKits(): Promise<UserKit[]> {
  try { return (await getBackend().all()).map(k => parseKit(k)!).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt); } catch { return []; }
}
export async function getKit(id: string): Promise<UserKit | null> {
  try { const k = (await getBackend().all()).find(x => x.id === id); return k ? { ...parseKit(k)!, samples: k.samples } : null; } catch { return null; }
}
export async function saveKit(k: UserKit): Promise<void> { await getBackend().put(k); changed(); }
export async function renameKit(id: string, name: string): Promise<void> {
  const k = await getKit(id);
  if (!k) return;
  await getBackend().put({ ...k, name: kitName(name), updatedAt: Date.now() });
  changed();
}
export async function deleteKit(id: string): Promise<void> { await getBackend().remove(id); changed(); }

// ===== Fichier .novakit (zip) =====

export async function kitToFile(k: UserKit): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const meta = { ...k, samples: Object.fromEntries(Object.entries(k.samples).map(([id, s]) => [id, { info: s.info, file: s.wav ? `samples/${id}.wav` : undefined }])) };
  zip.file('kit.json', JSON.stringify(meta, null, 1));
  Object.entries(k.samples).forEach(([id, s]) => { if (s.wav) zip.file(`samples/${id}.wav`, s.wav); });
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export async function kitFromFile(data: ArrayBuffer | Blob): Promise<UserKit> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(data);
  const f = zip.file('kit.json');
  if (!f) throw new Error('Ce fichier n’est pas un kit NOVA (.novakit).');
  const meta = JSON.parse(await f.async('string')) as UserKit & { samples: Record<string, { info: PadSampleInfo; file?: string }> };
  const samples: UserKit['samples'] = {};
  for (const [id, s] of Object.entries(meta.samples || {})) {
    const wf = s.file && /^samples\/[\w-]+\.wav$/.test(s.file) ? zip.file(s.file) : null;
    samples[id] = { info: s.info, ...(wf ? { wav: await wf.async('arraybuffer') } : {}) };
  }
  const k = parseKit({ ...meta, samples });
  if (!k) throw new Error('Kit illisible ou vide.');
  return { ...k, samples, id: newKitId(), updatedAt: Date.now() };
}
