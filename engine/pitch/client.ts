/**
 * Nova Pitch · accès au worker (fil principal).
 *
 * Un seul worker, créé à la demande et arrêté après 30 s sans travail (rien ne
 * tourne quand on ne touche à rien). Sans Worker (tests, vieux navigateur) :
 * même calcul dans le fil principal.
 */
import type { PitchTrack } from '../../utils/pitchAnalysis';
import { analysisCache, type VoiceAnalysis } from './analysis';
import { PitchStore, type RenderJob, type WorkerIn, type WorkerOut } from './jobs';

const IDLE_MS = 30_000;

let worker: Worker | null = null;
let failed = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (m: WorkerOut) => void; reject: (e: unknown) => void; onProgress?: (p: number) => void }>();
/** Régions déjà envoyées au worker (il les garde tant qu'il vit). */
const loaded = new Set<string>();
const inline = new PitchStore();

function getWorker(): Worker | null {
  if (failed || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      if ('progress' in m) { p.onProgress?.(m.progress); return; }
      pending.delete(m.id);
      if ('error' in m) p.reject(new Error(m.error)); else p.resolve(m);
      armIdle();
    };
    worker.onerror = ev => {
      console.warn('[Nova Pitch] worker en échec, calcul dans la page', ev);
      failed = true;
      stop();
      for (const [, p] of pending) p.reject(new Error('worker'));
      pending.clear();
    };
  } catch (e) {
    console.warn('[Nova Pitch] worker indisponible', e);
    failed = true;
    worker = null;
  }
  return worker;
}

function stop() {
  try { worker?.terminate(); } catch { /* déjà arrêté */ }
  worker = null;
  loaded.clear();
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!pending.size) stop(); }, IDLE_MS);
}

function call(msg: WorkerIn & { id: number }, transfer: Transferable[], onProgress?: (p: number) => void): Promise<WorkerOut> {
  const w = getWorker()!;
  if (idleTimer) clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject, onProgress });
    w.postMessage(msg, transfer);
  });
}

const copy = (chs: Float32Array[]) => chs.map(c => new Float32Array(c));

/** Analyse d'une région (copie des canaux), avec avancement ; résultat mis en cache. */
export async function analyzeInBackground(key: string, channels: Float32Array[], sr: number, onProgress?: (p: number) => void): Promise<VoiceAnalysis> {
  const cached = analysisCache.get(key);
  if (cached) { onProgress?.(1); return cached; }
  const w = getWorker();
  let a: VoiceAnalysis;
  if (!w) {
    a = inline.analyze(key, channels, sr, onProgress);
  } else {
    try {
      const chs = copy(channels);
      const r = await call({ type: 'analyze', id: ++seq, key, channels: chs, sr }, chs.map(c => c.buffer as ArrayBuffer), onProgress);
      if (!('analysis' in r)) throw new Error('analyse');
      a = r.analysis;
      loaded.add(key);
    } catch (e) {
      if (!failed) throw e;
      a = inline.analyze(key, channels, sr, onProgress);
    }
  }
  analysisCache.set(key, a);
  return a;
}

/** Rendu d'une région déjà analysée. `channels`/`track` servent si le worker l'a oubliée. */
export async function renderInBackground(key: string, channels: Float32Array[], track: PitchTrack, job: RenderJob): Promise<Float32Array[]> {
  const w = getWorker();
  const local = () => {
    if (!inline.has(key)) inline.load(key, channels, track);
    return inline.render(key, job)!;
  };
  if (!w) return local();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!loaded.has(key)) {
        const chs = copy(channels);
        w.postMessage({ type: 'load', key, channels: chs, track } as WorkerIn, chs.map(c => c.buffer as ArrayBuffer));
        loaded.add(key);
      }
      const r = await call({ type: 'render', id: ++seq, key, job }, []);
      if ('channels' in r) return r.channels;
      if ('need' in r) { loaded.delete(key); continue; }
    }
    throw new Error('rendu');
  } catch (e) {
    if (!failed) throw e;
    return local();
  }
}
