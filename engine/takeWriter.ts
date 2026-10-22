/**
 * Côté page de l'écrivain de prises (engine/takeWriter.worker.ts) : un seul Worker, créé à la
 * première prise et gardé (il ne fait rien entre deux prises). Voir NovaRecorderSession.
 */

export interface TakeTarget { takeId: string; first: number; width: 1 | 2 }
export interface TakeWriterEnded { first: number; frames: number; durable: number; lost: number; allocs: number; error: string | null }

interface Handlers { onChunk(ch: Float32Array[], first: number): void; onWarn?(msg: string): void; ended?: (r: TakeWriterEnded) => void }

export class TakeWriterClient {
  private worker: Worker;
  private handlers = new Map<string, Handlers>();
  public failed: string | null = null;

  constructor(worker?: Worker) {
    this.worker = worker || new Worker(new URL('./takeWriter.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      const h = m && this.handlers.get(m.id);
      if (!h) return;
      if (m.type === 'chunk') h.onChunk(m.ch, m.first);
      else if (m.type === 'warn') h.onWarn?.(m.message);
      else if (m.type === 'ended') { this.handlers.delete(m.id); h.ended?.({ first: m.first ?? -1, frames: m.frames, durable: m.durable, lost: m.lost, allocs: m.allocs || 0, error: m.error || null }); }
    };
    this.worker.onerror = (e) => { this.failed = String((e as ErrorEvent)?.message || 'Worker arrêté'); };
  }

  begin(opts: { id: string; k: number; sr: number; ring?: { header: SharedArrayBuffer; data: SharedArrayBuffer; capacity: number }; port?: MessagePort; targets: TakeTarget[] }, h: Handlers) {
    this.handlers.set(opts.id, h);
    const { port, ...msg } = opts;
    this.worker.postMessage({ type: 'begin', ...msg }, port ? [port] : []);
  }

  /** Fin : l'anneau est vidé, le reste écrit ; rend le compte (null si le Worker ne répond pas). */
  end(id: string, timeoutMs = 6000): Promise<TakeWriterEnded | null> {
    const h = this.handlers.get(id);
    if (!h) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.handlers.delete(id); resolve(null); }, timeoutMs);
      h.ended = r => { clearTimeout(timer); resolve(r); };
      this.worker.postMessage({ type: 'end', id });
    });
  }
}

let shared: TakeWriterClient | null = null;
let disabled = false;
/** L'écrivain de l'appli (null si les Workers manquent : la prise passe alors par la page, comme avant). */
export function takeWriter(): TakeWriterClient | null {
  if (disabled || typeof Worker === 'undefined') return null;
  try {
    if (localStorage.getItem('nova_take_writer') === '0') return null;   // repli manuel (QA avant / après)
  } catch { /* */ }
  if (shared?.failed) shared = null;
  if (!shared) {
    try { shared = new TakeWriterClient(); } catch (e) { console.warn('[Prise] écrivain de prises indisponible', e); disabled = true; return null; }
  }
  return shared;
}
