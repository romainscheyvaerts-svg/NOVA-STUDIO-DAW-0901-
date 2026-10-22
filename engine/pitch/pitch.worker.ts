/**
 * Nova Pitch · worker : analyse (avec avancement) et rendu hors du fil
 * principal, pour que l'interface reste fluide.
 */
import { PitchStore, type WorkerIn, type WorkerOut } from './jobs';

const store = new PitchStore();
const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  try {
    if (m.type === 'load') { store.load(m.key, m.channels, m.track); return; }
    if (m.type === 'drop') { store.drop(m.key); return; }
    if (m.type === 'analyze') {
      let last = -1;
      const analysis = store.analyze(m.key, m.channels, m.sr, p => {
        const q = Math.round(p * 100);
        if (q !== last) { last = q; post({ id: m.id, progress: p }); }
      });
      post({ id: m.id, analysis });
      return;
    }
    if (m.type === 'render') {
      const ch = store.render(m.key, m.job);
      if (!ch) { post({ id: m.id, need: true }); return; }
      post({ id: m.id, channels: ch }, ch.map(c => c.buffer as ArrayBuffer));
    }
  } catch (err: any) {
    if ('id' in m) post({ id: m.id, error: String(err?.message || err) });
  }
};
