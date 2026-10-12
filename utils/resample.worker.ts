/**
 * Rééchantillonnage studio hors du fil principal (utils/resample) : un canal
 * de 3 min se convertit en ~1,7 s ; dans le fil principal, l'interface figeait.
 * Un canal par message (les canaux d'un même son partent en parallèle).
 */
import { resampleChannel } from './resample';

export interface DemandeConversion { id: number; canal: Float32Array; de: number; vers: number }
export interface ReponseConversion { id: number; canal?: Float32Array; erreur?: string }

self.onmessage = (e: MessageEvent<DemandeConversion>) => {
  const { id, canal, de, vers } = e.data;
  try {
    const out = resampleChannel(canal, de, vers);
    const copie = out === canal ? new Float32Array(out) : out;
    (self as unknown as Worker).postMessage({ id, canal: copie } as ReponseConversion, [copie.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, erreur: String((err as Error)?.message || err) } as ReponseConversion);
  }
};
