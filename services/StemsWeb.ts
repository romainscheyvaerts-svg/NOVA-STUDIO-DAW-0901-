/**
 * Lot 6c : séparation en stems dans le navigateur, côté page (le calcul est dans
 * services/StemsWebWorker.ts, la logique pure dans utils/stemsWeb.ts, l'interface dans
 * components/StemsWebPanel.tsx).
 *
 * - Un seul calcul à la fois ; il survit à la fermeture de la fenêtre (pastille en bas à droite).
 * - Annuler termine le Worker : téléchargement et calcul s'arrêtent net, rien n'est ajouté.
 * - Le Worker est aussi terminé à la fin : la mémoire du modèle (≈ 1 Go) est rendue tout de suite.
 */
import {
  cellularFrom, STEMS_WEB_CACHE, STEMS_WEB_MODEL, ORT_WEB, type WebStemSet, type WebStemsCaps,
} from '../utils/stemsWeb';
import type { StemsWebMessage, StemsWebRequest } from './StemsWebWorker';

export interface WebStemsJob {
  id: string;
  /** Clip séparé (identifiants + nom affiché). */
  target: { trackId: string; clipId: string; clipName: string };
  set: WebStemSet;
  phase: 'engine' | 'download' | 'verify' | 'load' | 'separate' | 'done' | 'error';
  message: string;
  backend: 'webgpu' | 'wasm';
  /** Note de repli (carte graphique indisponible → processeur). */
  fallback?: string;
  download?: { loaded: number; total: number };
  progress?: { done: number; total: number; etaSec: number | null };
  startedAt: number;
  error?: string;
  errorCode?: string;
  summary?: string;
  /** Pistes posées (pour « Basse → MIDI »…). */
  applied?: { key: string; name: string; trackId: string; clipId: string }[];
}

export interface WebStemsResult {
  stems: { key: string; channels: Float32Array[] }[];
  seconds: number;
  backend: 'webgpu' | 'wasm';
  downloaded: boolean;
}

// ─── Calcul en cours (partagé par la fenêtre et la pastille) ───────────────────
let job: WebStemsJob | null = null;
let worker: Worker | null = null;
/** Rejet de la séparation en cours (Annuler). */
let pendingReject: ((e: unknown) => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(cb => cb());

export const webStemsJob = {
  get: () => job,
  subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  set: (j: WebStemsJob | null) => { job = j; emit(); },
  patch: (id: string, p: Partial<WebStemsJob>) => { if (job && job.id === id) { job = { ...job, ...p }; emit(); } },
};

const stopWorker = () => { try { worker?.terminate(); } catch { /* rien */ } worker = null; pendingReject = null; };

/**
 * Lance la séparation : renvoie le résultat (canaux transférés depuis le Worker) ;
 * rejette avec { code } : 'cancelled', 'network', 'model', 'engine', 'memory', 'error'.
 */
export function runWebSeparation(j: Omit<WebStemsJob, 'phase' | 'message' | 'startedAt'>, channels: Float32Array[], sampleRate: number): Promise<WebStemsResult> {
  stopWorker();
  webStemsJob.set({ ...j, phase: 'engine', message: 'Chargement du moteur de calcul', startedAt: Date.now() });
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./StemsWebWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(Object.assign(new Error('Ton navigateur ne peut pas lancer le calcul en arrière-plan (Web Worker).'), { code: 'engine' }));
      return;
    }
    worker = w;
    pendingReject = reject;
    const done = (fn: () => void) => { if (worker === w) stopWorker(); fn(); };
    w.onmessage = (e: MessageEvent<StemsWebMessage>) => {
      const m = e.data;
      if (worker !== w) return;
      switch (m.type) {
        case 'phase': webStemsJob.patch(j.id, { phase: m.phase, message: m.message }); break;
        case 'download': webStemsJob.patch(j.id, { download: { loaded: m.loaded, total: m.total } }); break;
        case 'backend': webStemsJob.patch(j.id, { backend: m.backend, ...(m.fallback ? { fallback: m.fallback } : {}) }); break;
        case 'progress': webStemsJob.patch(j.id, { progress: { done: m.done, total: m.total, etaSec: m.etaSec } }); break;
        case 'done': done(() => resolve({ stems: m.stems, seconds: m.seconds, backend: m.backend, downloaded: m.downloaded })); break;
        case 'error': done(() => reject(Object.assign(new Error(m.message), { code: m.code }))); break;
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      done(() => reject(Object.assign(new Error(ev.message || 'Le calcul s’est arrêté.'), { code: /memory|mémoire/i.test(ev.message || '') ? 'memory' : 'engine' })));
    };
    const copies = channels.map(c => new Float32Array(c));
    const req: StemsWebRequest = { type: 'separate', channels: copies, sampleRate, set: j.set, backend: j.backend };
    w.postMessage(req, copies.map(c => c.buffer));
  });
}

/** Annule le calcul en cours (téléchargement compris). */
export function cancelWebSeparation(): void {
  const reject = pendingReject;
  stopWorker();
  reject?.(Object.assign(new Error('Séparation annulée.'), { code: 'cancelled' }));
}

// ─── Ce que peut faire cet appareil ─────────────────────────────────────────────

type NavExtra = Navigator & {
  gpu?: { requestAdapter: (o?: unknown) => Promise<unknown | null> };
  deviceMemory?: number;
  connection?: { type?: string; effectiveType?: string; saveData?: boolean };
  userAgentData?: { mobile?: boolean };
};

export async function detectWebStemsCaps(): Promise<WebStemsCaps> {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as NavExtra;
  let webgpu = false;
  try {
    if (nav.gpu?.requestAdapter) {
      const a = await Promise.race([nav.gpu.requestAdapter(), new Promise<null>(r => setTimeout(() => r(null), 3000))]);
      webgpu = !!a;
    }
  } catch { webgpu = false; }
  const ua = nav.userAgent || '';
  const mobile = nav.userAgentData?.mobile ?? (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1));
  const net = cellularFrom(nav.connection);
  return { webgpu, mobile: !!mobile, deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null, cellular: net.cellular, networkUnknown: net.unknown };
}

/** Le modèle est-il déjà sur cet appareil ? (taille gardée, 0 sinon). */
export async function webModelCached(): Promise<number> {
  try {
    if (typeof caches === 'undefined') return 0;
    const c = await caches.open(STEMS_WEB_CACHE);
    for (const s of STEMS_WEB_MODEL.sources) if (await c.match(s.url)) return s.bytes;
  } catch { /* stockage indisponible (navigation privée) */ }
  return 0;
}

/** Libère la place du modèle (et du moteur) sur cet appareil. */
export async function deleteWebModel(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const c = await caches.open(STEMS_WEB_CACHE);
    await Promise.all([...STEMS_WEB_MODEL.sources.map(s => c.delete(s.url)), c.delete(ORT_WEB.base + ORT_WEB.js.file), c.delete(ORT_WEB.base + ORT_WEB.wasm.file)]);
  } catch { /* rien */ }
}

/** Place libre pour garder le modèle (null : inconnue). */
export async function freeStorageBytes(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota == null) return null;
    return Math.max(0, est.quota - (est.usage || 0));
  } catch { return null; }
}
