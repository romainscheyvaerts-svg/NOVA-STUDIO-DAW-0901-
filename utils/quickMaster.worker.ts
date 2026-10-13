/**
 * Master express (lot 4a) hors du fil principal : le fichier reste dans le
 * Worker, chaque rendu peut être interrompu (un nouveau réglage annule le
 * précédent), l'étape la plus longue (Mastering Transient) est gardée en
 * cache par style et intensité.
 */
import { analyzeTrack, renderQuickMaster, QmCache, QmCancelled, QmOptions } from './quickMaster';

type Msg =
  | { type: 'load'; which: 'track' | 'ref'; ch: Float32Array[]; sr: number }
  | { type: 'clear'; which: 'ref' }
  | { type: 'render'; id: number; opts: QmOptions; useRef: boolean }
  | { type: 'cancel'; id: number };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let track: { ch: Float32Array[]; sr: number; analysis: ReturnType<typeof analyzeTrack> } | null = null;
let ref: { curve: number[] } | null = null;
let current = 0;
/** Génération du morceau chargé : un rendu de l'ancien morceau ne remplit pas le cache du nouveau. */
let gen = 0;
const store: QmCache[] = [];
const cacheFor = (g: number) => ({
  get: (k: string) => (g === gen ? store.find(c => c.key === k) : undefined),
  // Deux étapes gardées (aller-retour entre deux styles), une seule au-delà de 5 min (mémoire).
  set: (c: QmCache) => { if (g !== gen) return; store.unshift(c); const max = (c.stage[0]?.length || 0) > 48000 * 300 ? 1 : 2; while (store.length > max) store.pop(); },
});

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'cancel') { if (current === m.id) current = 0; return; }
  if (m.type === 'clear') { ref = null; return; }
  if (m.type === 'load') {
    try {
      const a = analyzeTrack(m.ch, m.sr);
      if (m.which === 'track') { track = { ch: m.ch, sr: m.sr, analysis: a }; store.length = 0; gen++; }
      else ref = { curve: a.curve };
      post({ type: 'analysis', which: m.which, analysis: a });
    } catch (err) {
      post({ type: 'error', which: m.which, message: String((err as Error)?.message || err) });
    }
    return;
  }
  if (m.type === 'render') {
    current = m.id;
    const id = m.id;
    if (!track) { post({ type: 'error', id, message: 'Aucun morceau chargé.' }); return; }
    try {
      const r = await renderQuickMaster(track.ch, track.sr, track.analysis, { ...m.opts, refCurve: m.useRef && ref ? ref.curve : null }, {
        onProgress: (label, p) => post({ type: 'progress', id, label, p }),
        yieldNow: () => new Promise(res => setTimeout(res, 0)),
        isCancelled: () => current !== id,
      }, cacheFor(gen));
      const { out, ...rest } = r;
      post({ type: 'result', id, result: rest, out }, out.map(x => x.buffer));
    } catch (err) {
      if (err instanceof QmCancelled) post({ type: 'cancelled', id });
      else post({ type: 'error', id, message: String((err as Error)?.message || err) });
    }
  }
};
