/// <reference lib="webworker" />
/**
 * Lot 6c : Worker de la séparation en stems dans le navigateur (voir utils/stemsWeb.ts).
 *
 * 1. Moteur : onnxruntime-web 1.30.0, version figée, téléchargé depuis jsDelivr ; le module et
 *    son .wasm sont vérifiés (SHA-256) avant d'être exécutés, puis gardés dans Cache Storage.
 * 2. Modèle : htdemucs_6s (~246 Mo), lu dans Cache Storage, sinon téléchargé une fois depuis
 *    Hugging Face (adresse figée sur un commit), vérifié (SHA-256) puis gardé.
 * 3. Calcul : carte graphique (WebGPU) si possible, sinon processeur (WASM, 1 cœur : le site
 *    n'est pas « cross-origin isolated »). La carte graphique qui lâche en route → le calcul
 *    continue sur le processeur, sans rien perdre.
 *
 * Annuler = la page termine ce Worker (téléchargement et calcul s'arrêtent net ; un modèle
 * à moitié téléchargé n'est jamais gardé).
 */
import {
  ORT_WEB, STEMS_WEB_CACHE, STEMS_WEB_MODEL, STEMS_WEB_SEGMENT, STEMS_WEB_SOURCES, separateChannels,
  type WebModelSource, type WebStemSet,
} from '../utils/stemsWeb';

export type StemsWebRequest = {
  type: 'separate';
  channels: Float32Array[];
  sampleRate: number;
  set: WebStemSet;
  backend: 'webgpu' | 'wasm';
};

export type StemsWebMessage =
  | { type: 'phase'; phase: 'engine' | 'download' | 'verify' | 'load' | 'separate'; message: string }
  | { type: 'download'; loaded: number; total: number }
  | { type: 'backend'; backend: 'webgpu' | 'wasm'; fallback?: string }
  | { type: 'progress'; done: number; total: number; etaSec: number | null }
  | { type: 'done'; stems: { key: string; channels: Float32Array[] }[]; seconds: number; backend: 'webgpu' | 'wasm'; downloaded: boolean }
  | { type: 'error'; code: string; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: StemsWebMessage, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

async function openCache(): Promise<Cache | null> {
  try { return typeof caches !== 'undefined' ? await caches.open(STEMS_WEB_CACHE) : null; } catch { return null; }
}

/** Fichier du moteur (petit) : cache, sinon CDN ; empreinte vérifiée dans les deux cas. */
async function engineFile(cache: Cache | null, file: string, sha: string): Promise<ArrayBuffer> {
  const url = ORT_WEB.base + file;
  let buf: ArrayBuffer | null = null;
  try { const hit = await cache?.match(url); if (hit) buf = await hit.arrayBuffer(); } catch { buf = null; }
  if (buf && (await sha256Hex(buf)) === sha) return buf;
  let res: Response;
  try { res = await fetch(url, { mode: 'cors', credentials: 'omit' }); } catch { throw fail('engine', 'moteur injoignable'); }
  if (!res.ok) throw fail('engine', `moteur indisponible (${res.status})`);
  buf = await res.arrayBuffer();
  if ((await sha256Hex(buf)) !== sha) throw fail('engine', 'empreinte du moteur incorrecte');
  try { await cache?.put(url, new Response(buf.slice(0), { headers: { 'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } })); } catch { /* quota : tant pis */ }
  return buf;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ort = any;
let ortPromise: Promise<Ort> | null = null;

function loadOrt(cache: Cache | null): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const [js, wasm] = await Promise.all([
        engineFile(cache, ORT_WEB.js.file, ORT_WEB.js.sha256),
        engineFile(cache, ORT_WEB.wasm.file, ORT_WEB.wasm.sha256),
      ]);
      const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
      let ort: Ort;
      try { ort = await import(/* @vite-ignore */ url); } catch (e) { throw fail('engine', String((e as Error)?.message || e)); }
      ort = ort.default && !ort.InferenceSession ? ort.default : ort;
      ort.env.wasm.wasmBinary = wasm;
      ort.env.wasm.numThreads = 1; // pas de SharedArrayBuffer sans COOP/COEP
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';
      return ort;
    })();
    ortPromise.catch(() => { ortPromise = null; });
  }
  return ortPromise;
}

/** Modèle : en cache ? (sans vérifier l'empreinte, faite au téléchargement). */
async function cachedModel(cache: Cache | null): Promise<{ buf: ArrayBuffer; source: WebModelSource } | null> {
  if (!cache) return null;
  for (const s of STEMS_WEB_MODEL.sources) {
    try {
      const hit = await cache.match(s.url);
      if (!hit) continue;
      const buf = await hit.arrayBuffer();
      if (buf.byteLength === s.bytes) return { buf, source: s };
      await cache.delete(s.url);
    } catch { /* entrée illisible : on retélécharge */ }
  }
  return null;
}

async function downloadModel(cache: Cache | null): Promise<ArrayBuffer> {
  let lastErr: Error | null = null;
  for (const s of STEMS_WEB_MODEL.sources) {
    try {
      post({ type: 'phase', phase: 'download', message: 'Téléchargement du modèle (une seule fois)' });
      const res = await fetch(s.url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok || !res.body) throw fail('network', `modèle indisponible (${res.status})`);
      const total = s.bytes;
      // Un seul tableau de la taille exacte (pas de morceaux + copie) : moins de mémoire au pic.
      const bytes = new Uint8Array(total);
      const reader = res.body.getReader();
      let loaded = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.length > total) throw fail('model', 'fichier plus gros que prévu');
        bytes.set(value, loaded);
        loaded += value.length;
        if (loaded - last > 1_000_000) { last = loaded; post({ type: 'download', loaded, total }); }
      }
      post({ type: 'download', loaded, total });
      if (loaded !== total) throw fail('network', 'téléchargement incomplet');
      post({ type: 'phase', phase: 'verify', message: 'Vérification du modèle' });
      if ((await sha256Hex(bytes.buffer)) !== s.sha256) throw fail('model', 'empreinte du modèle incorrecte');
      try { await cache?.put(s.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(total) } })); } catch { /* quota plein : il sera retéléchargé */ }
      return bytes.buffer;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr || fail('network', 'modèle injoignable');
}

async function createSession(ort: Ort, model: ArrayBuffer, backend: 'webgpu' | 'wasm') {
  // logSeverityLevel 3 : pas d'avertissement « nœuds sur le processeur » dans la console (normal pour ce modèle).
  return ort.InferenceSession.create(new Uint8Array(model), { executionProviders: [backend], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
}

async function separate(req: StemsWebRequest) {
  const t0 = performance.now();
  const cache = await openCache();
  post({ type: 'phase', phase: 'engine', message: 'Chargement du moteur de calcul' });
  const ort = await loadOrt(cache);

  let hit = await cachedModel(cache);
  const downloaded = !hit;
  // Les octets du modèle sont lâchés dès la session créée (ORT en garde sa copie) ; en cas de
  // repli sur le processeur, on les relit dans le cache.
  const modelBytes = async (): Promise<ArrayBuffer> => (await cachedModel(cache))?.buf ?? downloadModel(cache);

  let backend = req.backend;
  let session: Ort;
  {
    let buf: ArrayBuffer | null = hit ? hit.buf : await downloadModel(cache);
    post({ type: 'phase', phase: 'load', message: 'Préparation du modèle' });
    try {
      session = await createSession(ort, buf, backend);
    } catch (e) {
      if (backend !== 'webgpu') throw e;
      backend = 'wasm';
      post({ type: 'backend', backend, fallback: 'La carte graphique n’a pas pu charger le modèle : calcul sur le processeur (plus lent).' });
      session = await createSession(ort, buf, backend);
    }
    buf = null;
    hit = null;
  }
  post({ type: 'backend', backend });

  const inName = session.inputNames[0];
  const outName = session.outputNames[0];
  const want = STEMS_WEB_SOURCES.length * 2 * STEMS_WEB_SEGMENT;
  const runOnce = async (input: Float32Array): Promise<Float32Array> => {
    const out = await session.run({ [inName]: new ort.Tensor('float32', input, [1, 2, STEMS_WEB_SEGMENT]) });
    const t = out[outName];
    const data = t.data as Float32Array;
    if (data.length !== want) throw fail('model', `sortie du modèle inattendue (${(t.dims || []).join('×')})`);
    const copy = new Float32Array(data);
    try { t.dispose?.(); } catch { /* rien */ }
    return copy;
  };

  post({ type: 'phase', phase: 'separate', message: backend === 'webgpu' ? 'Séparation sur la carte graphique' : 'Séparation sur le processeur' });
  const stems = await separateChannels(req.channels, req.sampleRate, req.set, async (input) => {
    try {
      return await runOnce(input);
    } catch (e) {
      if (backend !== 'webgpu' || (e as { code?: string })?.code === 'model') throw e;
      // Carte graphique perdue en route (pilote, mémoire) : le reste passe par le processeur.
      backend = 'wasm';
      post({ type: 'backend', backend, fallback: 'La carte graphique a décroché : la suite se calcule sur le processeur (plus lent).' });
      try { await session.release?.(); } catch { /* rien */ }
      session = await createSession(ort, await modelBytes(), 'wasm');
      return runOnce(input);
    }
  }, { onProgress: p => post({ type: 'progress', ...p }) });
  try { await session.release?.(); } catch { /* rien */ }

  const transfer: Transferable[] = [];
  for (const s of stems) for (const c of s.channels) transfer.push(c.buffer);
  post({ type: 'done', stems, seconds: (performance.now() - t0) / 1000, backend, downloaded }, transfer);
}

ctx.onmessage = (e: MessageEvent<StemsWebRequest>) => {
  if (e.data?.type !== 'separate') return;
  separate(e.data).catch((err) => {
    const er = err as { code?: string; message?: string; name?: string };
    const code = er?.code || (er?.name === 'RangeError' ? 'memory' : 'error');
    post({ type: 'error', code, message: String(er?.message || err) });
  });
};
