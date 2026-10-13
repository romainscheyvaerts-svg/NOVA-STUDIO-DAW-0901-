/**
 * Lot 1 « Voix propre » : lance le nettoyage d'une voix, avec le meilleur moteur
 * disponible sur ce poste.
 *  - appli Windows, module voix installé : DeepFilterNet 3 par le pont (bruit, et
 *    réverbe de la pièce si cochée), puis la finition (dosage, niveau) dans le Worker ;
 *    si le pont lâche en route, le calcul repasse tout seul par le navigateur ;
 *  - partout ailleurs (site, téléphone) : RNNoise WASM dans services/VoiceCleanWorker.
 * Un calcul à la fois ; `cancelVoiceClean` l'arrête net (le Worker est relancé).
 */
import { novaBridge, VoiceError } from './NovaBridge';
import type { CleanEngineId, CleanOptions, CleanStats } from '../utils/voiceClean';
import type { CleanWorkerRequest } from './VoiceCleanWorker';

export interface CleanJobInput {
  /** Identifie le son (clip + région) : changer la force ne refait pas le premier passage. */
  key: string;
  channels: Float32Array[];
  sampleRate: number;
  options: CleanOptions;
  engine: CleanEngineId;
}

export interface CleanJobOutput {
  channels: Float32Array[];
  sampleRate: number;
  stats: CleanStats;
  /** Le pont n'a pas répondu : le navigateur a pris le relais. */
  fellBack?: string;
}

export type CleanProgress = (pct: number, message: string) => void;

export { cleanEngineFor } from '../utils/voiceClean';

export const RNNOISE_WASM_PATH = 'wasm/rnnoise/rnnoise.wasm';

const wasmUrl = () => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';
  try { return new URL(`${base}${RNNOISE_WASM_PATH}`, window.location.href).href; } catch { return `${base}${RNNOISE_WASM_PATH}`; }
};

// ─── Worker ─────────────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let seq = 1;
interface Pending { resolve: (r: CleanJobOutput) => void; reject: (e: unknown) => void; onProgress?: CleanProgress; base: number; span: number }
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./VoiceCleanWorker.ts', import.meta.url), { type: 'module' });
  } catch { worker = null; return null; }
  worker.onmessage = (e: MessageEvent<any>) => {
    const m = e.data;
    const p = pending.get(m?.id);
    if (!p) return;
    if (m.type === 'progress') p.onProgress?.(p.base + (p.span * m.pct) / 100, m.message);
    else if (m.type === 'done') { pending.delete(m.id); p.resolve({ channels: m.channels, sampleRate: m.sampleRate, stats: m.stats }); }
    else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); }
  };
  worker.onerror = (ev) => {
    ev.preventDefault?.();
    const err = new Error(ev.message || 'mémoire insuffisante ou calcul interrompu');
    for (const [id, p] of [...pending]) { pending.delete(id); p.reject(err); }
    try { worker?.terminate(); } catch { /* déjà arrêté */ }
    worker = null;
  };
  return worker;
}

function runInWorker(req: Omit<CleanWorkerRequest, 'type' | 'id' | 'wasmUrl'>, onProgress: CleanProgress | undefined, base = 0, span = 100): Promise<CleanJobOutput> {
  const w = getWorker();
  if (!w) return runOnMainThread(req, onProgress, base, span);
  const id = seq++;
  // Copies : le clip d'origine n'est jamais touché, et les tableaux partent sans copie supplémentaire.
  const channels = req.channels.map(c => new Float32Array(c));
  const external = req.external ? { ...req.external, channels: req.external.channels.map(c => new Float32Array(c)) } : null;
  const transfer = [...channels, ...(external?.channels || [])].map(c => c.buffer);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress, base, span });
    w.postMessage({ ...req, external, channels, type: 'clean', id, wasmUrl: wasmUrl() } as CleanWorkerRequest, transfer);
  });
}

/** Secours sans Worker (navigateur ancien, CSP) : même calcul, dans la page. */
async function runOnMainThread(req: Omit<CleanWorkerRequest, 'type' | 'id' | 'wasmUrl'>, onProgress: CleanProgress | undefined, base: number, span: number): Promise<CleanJobOutput> {
  const [{ createRnnoise }, { cleanVoice, STRENGTHS }] = await Promise.all([import('../utils/rnnoise'), import('../utils/voiceClean')]);
  const needEngine = req.external ? STRENGTHS[req.options.strength]?.silenceDb > 0 : req.options.noise;
  let engine = null;
  if (needEngine) {
    const r = await fetch(wasmUrl());
    if (!r.ok) throw new Error(`wasm introuvable (${r.status})`);
    engine = await createRnnoise(await r.arrayBuffer());
  }
  await new Promise(r => setTimeout(r, 30)); // laisse la barre de progression s'afficher
  const res = cleanVoice({ channels: req.channels, sampleRate: req.sampleRate, options: req.options }, {
    engine, external: req.external || null, onProgress: (p, m) => onProgress?.(base + (span * p) / 100, m),
  });
  return { channels: res.channels, sampleRate: res.sampleRate, stats: res.stats };
}

// ─── Calcul ─────────────────────────────────────────────────────────────────────

let currentBridgeJob: string | null = null;
/** Dernière voix rendue par DeepFilterNet 3 : changer Léger / Moyen / Fort ne relance pas le PC. */
let lastDfn: { key: string; late: boolean; channels: Float32Array[]; rt60: number | null } | null = null;

/** Nettoie une voix ; la progression va de 0 à 100. */
export async function runVoiceClean(input: CleanJobInput, onProgress?: CleanProgress): Promise<CleanJobOutput> {
  const { key, channels, sampleRate, options } = input;
  if (input.engine === 'deepfilter' && (options.noise || options.reverb)) {
    const jobId = `clean-${Date.now().toString(36)}`;
    currentBridgeJob = jobId;
    const off = novaBridge.onVoiceEvent(e => {
      if (e.jobId !== jobId) return;
      if (e.event === 'progress') onProgress?.(Math.min(85, (e.pct ?? 0) * 0.85), e.message || 'Calcul sur ton PC');
    });
    try {
      let dfn = lastDfn && lastDfn.key === key && lastDfn.late === options.reverb ? lastDfn : null;
      if (!dfn) {
        onProgress?.(1, 'Envoi de la voix à Nova Studio');
        const res = await novaBridge.deverbVoice({ jobId, channels, sampleRate, late: options.reverb });
        if (currentBridgeJob !== jobId) throw new VoiceError('Calcul annulé.', 'cancelled');
        dfn = lastDfn = { key, late: options.reverb, channels: res.channels, rt60: res.rt60 ?? null };
      }
      const out = await runInWorker({ key: `${key}|dfn3|${options.reverb ? 1 : 0}`, channels, sampleRate, options,
        external: { channels: dfn.channels, reverb: options.reverb, rt60: dfn.rt60 } }, onProgress, 86, 14);
      return out;
    } catch (e) {
      if ((e as VoiceError)?.code === 'cancelled' || currentBridgeJob !== jobId) throw new VoiceError('Calcul annulé.', 'cancelled');
      // Le pont n'a pas répondu (appli fermée, module cassé) : le navigateur prend le relais.
      const out = await runInWorker({ key, channels, sampleRate, options }, onProgress);
      return { ...out, fellBack: 'L’appli Windows n’a pas répondu : voix nettoyée dans le navigateur (RNNoise), sans la réverbe.' };
    } finally {
      off();
      if (currentBridgeJob === jobId) currentBridgeJob = null;
    }
  }
  return runInWorker({ key, channels, sampleRate, options }, onProgress);
}

/** Arrête le calcul en cours (le Worker est relancé au prochain calcul). */
export function cancelVoiceClean(): void {
  if (currentBridgeJob) {
    const id = currentBridgeJob;
    currentBridgeJob = null;
    novaBridge.voiceCancel({ jobId: id }).catch(() => undefined);
  }
  if (worker) {
    try { worker.terminate(); } catch { /* déjà arrêté */ }
    worker = null;
  }
  const err = new VoiceError('Calcul annulé.', 'cancelled');
  for (const [id, p] of [...pending]) { pending.delete(id); p.reject(err); }
}
