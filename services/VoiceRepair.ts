/**
 * L5 · écart 7 : lance la réparation de la voix et les calculs de l'éditeur
 * spectral dans services/VoiceRepairWorker (un seul Worker, gardé entre deux
 * calculs). Sans Worker (navigateur ancien, CSP) : même calcul dans la page.
 * Tout reste sur l'appareil : aucun service en ligne.
 */
import type { RepairOptions, RepairStats } from '../utils/repair/pipeline';
import type { Spectrogram, SpectralZone, ZoneOp } from '../utils/spectral/stft';

export type RepairProgress = (pct: number, message: string) => void;

type Req =
  | { type: 'repair'; channels: Float32Array[]; sampleRate: number; options: RepairOptions }
  | { type: 'spectrogram'; channels: Float32Array[]; sampleRate: number; from?: number; to?: number; cols?: number; rows?: number }
  | { type: 'spectral-edit'; channels: Float32Array[]; sampleRate: number; zone: SpectralZone; op: ZoneOp };

interface Pending { resolve: (r: any) => void; reject: (e: unknown) => void; onProgress?: RepairProgress }
let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./VoiceRepairWorker.ts', import.meta.url), { type: 'module' });
  } catch { worker = null; return null; }
  worker.onmessage = (e: MessageEvent<any>) => {
    const m = e.data;
    const p = pending.get(m?.id);
    if (!p) return;
    if (m.type === 'progress') p.onProgress?.(m.pct, m.message);
    else if (m.type === 'done') { pending.delete(m.id); p.resolve(m); }
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

async function runHere(req: Req, onProgress?: RepairProgress): Promise<any> {
  await new Promise(r => setTimeout(r, 30)); // laisse l'interface afficher « en cours »
  if (req.type === 'repair') {
    const { repairChannels } = await import('../utils/repair/pipeline');
    const r = repairChannels(req.channels, req.sampleRate, req.options, onProgress);
    return { channels: r.channels, stats: r.stats };
  }
  const { editZone, spectrogram } = await import('../utils/spectral/stft');
  if (req.type === 'spectrogram') return { spectrogram: spectrogram(req.channels, req.sampleRate, { from: req.from, to: req.to, cols: req.cols, rows: req.rows }) };
  const r = editZone(req.channels, req.sampleRate, req.zone, req.op);
  return { channels: r.channels, changed: r.changed };
}

async function run(req: Req, onProgress?: RepairProgress): Promise<any> {
  // Copies : le son du clip n'est jamais touché, et les tableaux partent sans autre copie.
  const channels = req.channels.map(c => new Float32Array(c));
  const w = getWorker();
  if (!w) return runHere({ ...req, channels } as Req, onProgress);
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ ...req, channels, id }, channels.map(c => c.buffer));
  });
}

/** Canaux d'un AudioBuffer entre deux échantillons (copies). */
export function channelsOf(buf: AudioBuffer, from = 0, to = buf.length): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c).slice(Math.max(0, from), Math.min(buf.length, to)));
  return out;
}

/** AudioBuffer à partir de canaux (même fréquence que le son d'origine). */
export function bufferOf(chs: Float32Array[], sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ numberOfChannels: chs.length, length: Math.max(1, chs[0]?.length || 1), sampleRate });
  chs.forEach((c, i) => buf.getChannelData(i).set(c));
  return buf;
}

export async function runRepair(channels: Float32Array[], sampleRate: number, options: RepairOptions, onProgress?: RepairProgress): Promise<{ channels: Float32Array[]; stats: RepairStats }> {
  const r = await run({ type: 'repair', channels, sampleRate, options }, onProgress);
  return { channels: r.channels, stats: r.stats };
}

export async function runSpectrogram(channels: Float32Array[], sampleRate: number, o: { from?: number; to?: number; cols?: number; rows?: number }): Promise<Spectrogram> {
  const r = await run({ type: 'spectrogram', channels, sampleRate, ...o });
  return r.spectrogram;
}

export async function runSpectralEdit(channels: Float32Array[], sampleRate: number, zone: SpectralZone, op: ZoneOp): Promise<{ channels: Float32Array[]; changed: [number, number] | null }> {
  const r = await run({ type: 'spectral-edit', channels, sampleRate, zone, op });
  return { channels: r.channels, changed: r.changed };
}
