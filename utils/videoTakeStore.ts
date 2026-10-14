/**
 * Lot 2b · Vidéos des prises, gardées sur l'appareil (IndexedDB, comme les prises audio).
 *
 * Dans l'appli Windows (WebView2), IndexedDB est un dossier du profil de l'appli sur le
 * disque : rien ne part dans le cloud ni dans la collaboration.
 *
 *  - `takes` : une fiche par vidéo (format, codec, horodatages, calage, prise liée) ;
 *  - `chunks` : les images encodées (H.264), par paquets d'environ 1 s.
 */
import type { ClockPair, OriginSegment, VideoFormat } from './videoTake';

export interface VideoTakeMeta {
  id: string;
  projectId: string | null;
  projectName: string;
  createdAt: number;
  /** recording : en cours (ou page fermée pendant la prise) ; partial : arrêtée avant la fin (stockage). */
  status: 'recording' | 'ok' | 'partial';
  stopReason?: string;
  format: VideoFormat;
  width: number;
  height: number;
  codec: string;
  description?: ArrayBuffer;
  cameraLabel: string;
  cameraKey: string;
  facing?: 'user' | 'environment';
  /** Capture : 'mstp' (toutes les images, horodatage de capture) ou 'rvfc' (images affichées). */
  method: 'mstp' | 'rvfc';
  frames: number;
  bytes: number;
  seqs: number;
  dropped: number;
  /** Horodatage de chaque image encodée (µs depuis la 1re image) et image clé. */
  chunkTs: number[];
  keyframes: number[];
  /** Instant de capture de l'image 0 (ms, performance.now()). */
  firstCaptureMs: number;
  /** Luminosité et mouvement de chaque image (même ordre que chunkTs) : mesure du clap. */
  luma: number[];
  motion: number[];
  clock: ClockPair[];
  clockSource: 'sortie' | 'contexte';
  renderLead: number;
  outputSide: number;
  segments: OriginSegment[];
  offsetMs: number;
  /** Calculé à la fin de la prise : temps du morceau de chaque image, et tour de boucle. */
  times?: number[];
  passes?: number[];
  loop: { start: number; end: number } | null;
  trackIds: string[];
  bufferIds: string[];
  /** Clips audio de la prise (tampon `clipId`, posé à `start`). */
  linked?: { trackId: string; clipId: string; start: number; duration: number }[];
  takeStart?: number;
  takeEnd?: number;
  durationSec: number;
}

export interface StoredChunk { ts: number; key: boolean; off: number; len: number }
interface ChunkRecord { takeId: string; seq: number; data: ArrayBuffer; items: StoredChunk[] }

const DB_NAME = 'nova-video-takes';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function videoDbAvailable(): boolean {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('takes')) {
        const s = db.createObjectStore('takes', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['takeId', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Base vidéo bloquée par un autre onglet'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Écriture annulée'));
});

export async function putMeta(meta: VideoTakeMeta): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('takes', 'readwrite');
  tx.objectStore('takes').put(meta);
  await done(tx);
}

export async function getMeta(id: string): Promise<VideoTakeMeta | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('takes').objectStore('takes').get(id);
    r.onsuccess = () => resolve((r.result as VideoTakeMeta) || null);
    r.onerror = () => reject(r.error);
  });
}

/** Toutes les vidéos (d'un projet si `projectId` est donné), les plus récentes d'abord. */
export async function listMeta(projectId?: string | null): Promise<VideoTakeMeta[]> {
  const db = await openDb();
  const all = await new Promise<VideoTakeMeta[]>((resolve, reject) => {
    const r = db.transaction('takes').objectStore('takes').getAll();
    r.onsuccess = () => resolve((r.result as VideoTakeMeta[]) || []);
    r.onerror = () => reject(r.error);
  });
  return all.filter(m => projectId === undefined || m.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
}

export async function putChunks(takeId: string, seq: number, data: ArrayBuffer, items: StoredChunk[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').put({ takeId, seq, data, items } as ChunkRecord);
  await done(tx);
}

/** Images encodées d'une vidéo, dans l'ordre (paquet par paquet : la mémoire reste petite). */
export async function* readChunks(takeId: string): AsyncGenerator<{ index: number; ts: number; key: boolean; data: Uint8Array }> {
  const db = await openDb();
  let seq = 0, index = 0;
  for (;;) {
    const rec = await new Promise<ChunkRecord | undefined>((resolve, reject) => {
      const r = db.transaction('chunks').objectStore('chunks').get([takeId, seq]);
      r.onsuccess = () => resolve(r.result as ChunkRecord | undefined);
      r.onerror = () => reject(r.error);
    });
    if (!rec) return;
    for (const it of rec.items) yield { index: index++, ts: it.ts, key: it.key, data: new Uint8Array(rec.data, it.off, it.len) };
    seq++;
  }
}

export async function deleteTake(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['takes', 'chunks'], 'readwrite');
  tx.objectStore('takes').delete(id);
  tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  await done(tx);
}

/** Place disponible pour le site (ou l'appli) : { usage, quota } ; null si inconnu. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || !e.quota) return null;
    return { usage: e.usage || 0, quota: e.quota };
  } catch { return null; }
}

/** Demande au navigateur de ne pas effacer les vidéos quand le disque se remplit. */
export async function askPersistence(): Promise<boolean> {
  try { return !!(await navigator.storage?.persist?.()); } catch { return false; }
}

export const isQuotaError = (e: unknown): boolean => {
  const n = (e as any)?.name || '';
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(String((e as any)?.message || ''));
};
