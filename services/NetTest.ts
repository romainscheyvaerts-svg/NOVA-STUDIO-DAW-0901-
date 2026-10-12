/**
 * Test de connexion avant la séance (B3) : mesures vers le serveur de la collaboration.
 *
 *  - aller-retour : petits appels « info » (rien n'est modifié) ;
 *  - pertes : appels restés sans réponse (délai dépassé ou erreur réseau) ;
 *  - débit montant : un paquet de données joint à un appel « info » (le serveur l'ignore,
 *    rien n'est enregistré) ; la taille grandit tant que l'envoi est trop court pour être mesuré.
 * Le verdict (utils/netTest) est le même dans l'écran de l'artiste et dans le panneau.
 */

import { call, CloudLink } from './SessionCloud';
import { judgeNetwork, NetMeasure, NetVerdict, rttStats, TakeFormat } from '../utils/netTest';

export interface NetTestResult { measure: NetMeasure; verdict: NetVerdict; at: number }

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(new Error('délai dépassé')), ms);
  p.then(v => { clearTimeout(id); resolve(v); }, e => { clearTimeout(id); reject(e); });
});

const pad = (bytes: number): string => {
  // Texte quelconque (les envois ne sont pas compressés) ; varié pour ne rien laisser deviner.
  const chunk = Array.from({ length: 1024 }, (_, i) => String.fromCharCode(97 + ((i * 7 + bytes) % 26))).join('');
  return chunk.repeat(Math.ceil(bytes / 1024)).slice(0, bytes);
};

export async function runNetTest(link: CloudLink, format: TakeFormat, opts: { pings?: number; onStep?: (text: string) => void } = {}): Promise<NetTestResult> {
  const base = { id: link.id, secret: link.secret };
  const pings = opts.pings ?? 8;
  const rtts: number[] = [];
  let lost = 0;
  opts.onStep?.('Mesure du temps de réponse…');
  for (let i = 0; i < pings; i++) {
    const t0 = performance.now();
    try {
      await withTimeout(call('info', base), 2500);
      rtts.push(performance.now() - t0);
    } catch { lost++; }
  }
  opts.onStep?.('Mesure de l’envoi…');
  const { median, jitter } = rttStats(rtts);
  let upKbps = 0;
  // 64 Ko, puis plus gros tant que l'envoi dure moins de 0,8 s (mesure trop courte sinon).
  for (const size of [64 * 1024, 256 * 1024, 1024 * 1024]) {
    const t0 = performance.now();
    try {
      await withTimeout(call('info', { ...base, pad: pad(size) }), 20000);
    } catch { lost++; break; }
    const sec = Math.max(0.001, (performance.now() - t0 - median) / 1000);
    upKbps = Math.round((size * 8) / sec / 1000);
    if (sec > 0.8) break;
  }
  const total = pings + 1;
  const measure: NetMeasure = { upKbps, rttMs: rtts.length ? median : 9999, lossPct: Math.round((100 * lost) / total), jitterMs: jitter };
  return { measure, verdict: judgeNetwork(measure, format), at: Date.now() };
}
