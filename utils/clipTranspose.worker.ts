/**
 * R13 · Rendu d'un clip transposé / étiré / recalé hors du fil principal :
 * l'interface reste fluide (un beat entier prend quelques secondes).
 */
import { renderElastic, ElasticJob, ElasticResult } from './clipTranspose';

self.onmessage = (e: MessageEvent<ElasticJob>) => {
  try {
    const res: ElasticResult = renderElastic(e.data);
    (self as unknown as Worker).postMessage(res, res.channels.map(c => c.buffer as ArrayBuffer));
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ error: String(err?.message || err) });
  }
};
