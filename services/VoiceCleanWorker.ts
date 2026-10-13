/**
 * Lot 1 « Voix propre » : le nettoyage tourne ici, hors du fil de l'interface
 * (RNNoise WASM + utils/voiceClean). Un calcul à la fois ; le dernier premier
 * passage RNNoise est gardé : changer Léger / Moyen / Fort ne le refait pas.
 *
 * Messages reçus :
 *   { type: 'clean', id, key, channels, sampleRate, options, wasmUrl, external? }
 * Messages envoyés :
 *   { type: 'progress', id, pct, message }
 *   { type: 'done', id, channels, sampleRate, stats }   (buffers transférés)
 *   { type: 'error', id, message }
 */
import { createRnnoise, type RnnoiseEngine } from '../utils/rnnoise';
import { cleanVoice, STRENGTHS, type CleanCache, type CleanOptions } from '../utils/voiceClean';

export interface CleanWorkerRequest {
  type: 'clean';
  id: number;
  /** Identifie le son (clip + région) : même clé = premier passage réutilisé. */
  key: string;
  channels: Float32Array[];
  sampleRate: number;
  options: CleanOptions;
  wasmUrl: string;
  external?: { channels: Float32Array[]; reverb: boolean; rt60?: number | null } | null;
}

let engine: Promise<RnnoiseEngine> | null = null;
let last: { key: string; cache: CleanCache } | null = null;

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

async function loadEngine(url: string): Promise<RnnoiseEngine> {
  if (!engine) {
    engine = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`wasm introuvable (${r.status})`);
      return createRnnoise(await r.arrayBuffer());
    })();
    engine.catch(() => { engine = null; }); // réessai possible (réseau revenu)
  }
  return engine;
}

self.onmessage = async (e: MessageEvent<CleanWorkerRequest>) => {
  const m = e.data;
  if (!m || m.type !== 'clean') return;
  try {
    const cache = last && last.key === m.key ? last.cache : null;
    const needEngine = m.external
      ? STRENGTHS[m.options.strength]?.silenceDb > 0 && !(cache && cache.vad) // silences guidés par RNNoise
      : m.options.noise && !(cache && cache.den48);
    const eng = needEngine ? await loadEngine(m.wasmUrl) : null;
    let lastPct = -1;
    const res = cleanVoice({ channels: m.channels, sampleRate: m.sampleRate, options: m.options }, {
      engine: eng, cache, external: m.external || null,
      onProgress: (pct, message) => { const p = Math.round(pct); if (p !== lastPct) { lastPct = p; post({ type: 'progress', id: m.id, pct: p, message }); } },
    });
    if (res.cache) last = { key: m.key, cache: res.cache };
    // Copies transférées : le cache garde ses propres tableaux.
    const out = res.channels.map(c => (res.cache && (res.cache.x48.includes(c) || res.cache.den48?.includes(c)) ? new Float32Array(c) : c));
    post({ type: 'done', id: m.id, channels: out, sampleRate: res.sampleRate, stats: res.stats }, out.map(c => c.buffer));
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err as Error)?.message || err) });
  }
};
