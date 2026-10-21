/**
 * L5 · écart 7 : réparation de la voix et éditeur spectral, hors du fil de
 * l'interface (l'écran ne gèle pas, même sur un PC modeste).
 *
 * Messages reçus :
 *   { type: 'repair', id, channels, sampleRate, options }
 *   { type: 'spectrogram', id, channels, sampleRate, from, to, cols, rows }
 *   { type: 'spectral-edit', id, channels, sampleRate, zone, op }
 * Messages envoyés :
 *   { type: 'progress', id, pct, message }
 *   { type: 'done', id, channels?, stats?, spectrogram?, changed? }   (tableaux transférés)
 *   { type: 'error', id, message }
 */
import { repairChannels, type RepairOptions } from '../utils/repair/pipeline';
import { editZone, spectrogram, type SpectralZone, type ZoneOp } from '../utils/spectral/stft';

export type RepairWorkerRequest =
  | { type: 'repair'; id: number; channels: Float32Array[]; sampleRate: number; options: RepairOptions }
  | { type: 'spectrogram'; id: number; channels: Float32Array[]; sampleRate: number; from?: number; to?: number; cols?: number; rows?: number }
  | { type: 'spectral-edit'; id: number; channels: Float32Array[]; sampleRate: number; zone: SpectralZone; op: ZoneOp };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

function uniqueBuffers(chs: Float32Array[]): Transferable[] {
  const seen = new Set<ArrayBufferLike>();
  for (const c of chs) seen.add(c.buffer);
  return [...seen] as Transferable[];
}

self.onmessage = (e: MessageEvent<RepairWorkerRequest>) => {
  const m = e.data;
  if (!m) return;
  try {
    if (m.type === 'repair') {
      let last = -1;
      const r = repairChannels(m.channels, m.sampleRate, m.options, (pct, message) => { if (pct !== last) { last = pct; post({ type: 'progress', id: m.id, pct, message }); } });
      post({ type: 'done', id: m.id, channels: r.channels, stats: r.stats }, uniqueBuffers(r.channels));
    } else if (m.type === 'spectrogram') {
      const s = spectrogram(m.channels, m.sampleRate, { from: m.from, to: m.to, cols: m.cols, rows: m.rows });
      post({ type: 'done', id: m.id, spectrogram: s }, [s.data.buffer]);
    } else if (m.type === 'spectral-edit') {
      const r = editZone(m.channels, m.sampleRate, m.zone, m.op);
      post({ type: 'done', id: m.id, channels: r.channels, changed: r.changed }, uniqueBuffers(r.channels));
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err as Error)?.message || err) });
  }
};
