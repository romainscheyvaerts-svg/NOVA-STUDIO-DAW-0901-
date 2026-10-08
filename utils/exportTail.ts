/**
 * Durée et fin des fichiers exportés (R1).
 *
 * - Plage : tout le morceau, la boucle, la sélection, ou d'un repère à l'autre
 *   (Pro Tools : Bounce de la sélection ; Logic : « Bounce » entre localisateurs).
 * - Queue (la réverbe et le delay qui continuent après la dernière note) :
 *     auto    : NOVA rend jusqu'à 10 s de plus et coupe quand tout est retombé
 *               sous −80 dBFS (plus de réverbe coupée net, plus de 4 s de blanc) ;
 *     manual  : durée choisie en secondes ;
 *     cut     : rien après la fin (FL « Cut remainder ») ;
 *     wrap    : la queue revient au début (FL « Wrap remainder »), pour une
 *               boucle qui tourne sans trou ni clic.
 * Tous les fichiers d'un même export (mix, stems) gardent la même longueur.
 */

export type TailMode = 'auto' | 'manual' | 'cut' | 'wrap';
export type RangeMode = 'FULL' | 'LOOP' | 'SELECTION' | 'MARKERS';

export interface TailSettings { mode: TailMode; seconds: number }

/** Queue maximale rendue en mode auto (s). */
export const AUTO_TAIL_MAX = 10;
/** Seuil de silence de la queue auto (dBFS) et marge gardée après (s). */
export const AUTO_TAIL_FLOOR_DB = -80;
export const AUTO_TAIL_MARGIN = 0.05;

export interface ExportSpan {
  /** Début du rendu dans le morceau (s). */
  start: number;
  /** Fin « musicale » (s) : fin de la plage, sans la queue. */
  end: number;
  /** Durée à rendre (s), queue maximale comprise. */
  renderDuration: number;
}

export function exportSpan(start: number, end: number, tail: TailSettings): ExportSpan {
  const s = Math.max(0, start);
  const e = Math.max(s + 0.05, end);
  const extra = tail.mode === 'cut' ? 0
    : tail.mode === 'manual' ? Math.max(0, Math.min(60, tail.seconds || 0))
    : AUTO_TAIL_MAX; // auto et wrap : on rend la queue, puis on la traite
  return { start: s, end: e, renderDuration: e - s + extra };
}

/** Dernier échantillon au-dessus du seuil (−1 si tout est silencieux). */
export function lastAudibleIndex(chs: Float32Array[], floorDb = AUTO_TAIL_FLOOR_DB, from = 0): number {
  const thr = Math.pow(10, floorDb / 20);
  let last = -1;
  for (const c of chs) {
    for (let i = c.length - 1; i > Math.max(last, from - 1); i--) {
      if (c[i] > thr || c[i] < -thr) { last = i; break; }
    }
  }
  return last;
}

/**
 * Longueur finale en échantillons, d'après le rendu de référence (le mix).
 * `nominal` = fin de la plage (sans queue).
 */
export function finalLength(reference: Float32Array[], sampleRate: number, nominalSec: number, tail: TailSettings): number {
  const nominal = Math.round(nominalSec * sampleRate);
  const rendered = reference[0]?.length || 0;
  if (tail.mode === 'cut' || tail.mode === 'wrap') return Math.min(rendered, nominal);
  if (tail.mode === 'manual') return Math.min(rendered, nominal + Math.round(Math.max(0, tail.seconds) * sampleRate));
  const last = lastAudibleIndex(reference, AUTO_TAIL_FLOOR_DB, nominal);
  const end = last < nominal ? nominal : last + 1 + Math.round(AUTO_TAIL_MARGIN * sampleRate);
  return Math.min(rendered, Math.max(nominal, end));
}

/**
 * Ramène des canaux rendus à `length` échantillons. En mode boucle (« wrap »),
 * ce qui dépasse est ajouté au début (la réverbe de la fin de la boucle sonne
 * sur le premier temps, comme au deuxième tour). Renvoie de nouveaux tableaux.
 */
export function applyTail(chs: Float32Array[], length: number, mode: TailMode): Float32Array[] {
  return chs.map(c => {
    const out = new Float32Array(length);
    out.set(c.subarray(0, Math.min(length, c.length)));
    if (mode === 'wrap' && c.length > length && length > 0) {
      for (let i = length; i < c.length; i++) out[(i - length) % length] += c[i];
    }
    return out;
  });
}
