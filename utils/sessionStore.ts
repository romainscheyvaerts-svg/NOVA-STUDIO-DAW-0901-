/**
 * Sauvegarde automatique de la session sur l'appareil (IndexedDB).
 *
 * Les artistes n'ont pas de compte sur le DAW : sans ça, fermer l'onglet
 * faisait perdre toutes les prises. On garde la dernière session (projet au
 * format .novaproj : JSON + WAV des prises) et on propose « Reprendre ma
 * session » à l'ouverture. Rien ne quitte l'appareil.
 */

const DB_NAME = 'nova-studio';
const STORE = 'sessions';
const KEY = 'current';

export interface SavedSessionMeta {
  savedAt: number;
  beatTitle: string | null;
  takes: number;
  hasLyrics: boolean;
}

interface SavedSession extends SavedSessionMeta {
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB indisponible')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveSession(blob: Blob, meta: SavedSessionMeta): Promise<void> {
  await run('readwrite', s => s.put({ ...meta, blob } as SavedSession, KEY));
}

export async function loadSession(): Promise<SavedSession | null> {
  try { return (await run<SavedSession | undefined>('readonly', s => s.get(KEY))) || null; } catch { return null; }
}

export async function getSessionMeta(): Promise<SavedSessionMeta | null> {
  const s = await loadSession();
  if (!s) return null;
  const { blob: _blob, ...meta } = s;
  return meta;
}

export async function clearSession(): Promise<void> {
  try { await run('readwrite', s => s.delete(KEY)); } catch { /* rien à effacer */ }
}

/** « il y a 5 min », « hier »… */
export function formatAgo(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hier' : `il y a ${d} jours`;
}
