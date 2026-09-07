/**
 * Étirement temporel exécuté hors du fil principal.
 *
 * Le calcul WSOLA coûte plusieurs secondes sur un morceau entier (mesuré :
 * 4,6 s pour 162 s de stéréo). Le faire dans le fil principal figeait
 * l'interface pendant tout ce temps, sans même laisser React afficher le
 * message d'attente. Le worker reçoit les canaux bruts, rend les canaux
 * étirés, et l'AudioBuffer est reconstruit côté appelant.
 */
import { etirerCanaux } from './timeStretch';

export interface DemandeEtirement {
  canaux: Float32Array[];
  facteur: number;
}

export interface ReponseEtirement {
  canaux: Float32Array[];
}

self.onmessage = (e: MessageEvent<DemandeEtirement>) => {
  const { canaux, facteur } = e.data;
  const resultat = etirerCanaux(canaux, facteur);
  // Transfert de propriété : évite une copie de plusieurs mégaoctets.
  (self as unknown as Worker).postMessage(
    { canaux: resultat } as ReponseEtirement,
    resultat.map(c => c.buffer)
  );
};
