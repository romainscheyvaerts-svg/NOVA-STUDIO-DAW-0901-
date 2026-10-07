/**
 * Justesse note par note (V19) : analyse et rendu hors du fil principal,
 * pour que l'interface reste fluide (téléphone compris).
 */
import { runJob, PitchJob } from './pitchEdit';

self.onmessage = (e: MessageEvent<PitchJob>) => {
  try {
    const res = runJob(e.data);
    const transfer: ArrayBuffer[] = [];
    if (res.channels) res.channels.forEach(c => transfer.push(c.buffer as ArrayBuffer));
    (self as unknown as Worker).postMessage(res, transfer);
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ error: String(err?.message || err) });
  }
};
