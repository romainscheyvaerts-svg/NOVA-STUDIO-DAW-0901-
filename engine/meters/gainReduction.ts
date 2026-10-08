/**
 * Réduction de gain remontée sur la tranche (R11), comme le mètre GR de la
 * console et de l'en-tête de piste de Pro Tools.
 *
 * Chaque effet de dynamique NOVA expose déjà sa mesure, sous deux formes :
 *  - `getReduction()` : dB ≤ 0 (compresseur vocal, de-esser) ;
 *  - `getMeters().grDb` : dB ≥ 0 (limiteur / maximiseur V15).
 * On les ramène toutes à une réduction POSITIVE en dB. Sur une piste à
 * plusieurs dynamiques en série, la tranche affiche la somme (la réduction
 * totale subie par le signal) et le détail par effet dans l'info-bulle.
 */

export interface GrPart { pluginId: string; db: number }

/** Réduction (dB ≥ 0) lue sur une instance d'effet ; null si l'effet n'en mesure pas. */
export function readGainReduction(instance: any): number | null {
  if (!instance) return null;
  try {
    if (typeof instance.getReduction === 'function') {
      const r = Number(instance.getReduction());
      return Number.isFinite(r) ? Math.abs(r) : 0;
    }
    if (typeof instance.getMeters === 'function') {
      const m = instance.getMeters();
      if (m && typeof m.grDb === 'number' && Number.isFinite(m.grDb)) return Math.max(0, m.grDb);
      if (m && 'grDb' in m) return 0;
    }
  } catch { /* effet en cours de libération */ }
  return null;
}

/** Somme des réductions (dB) ; `parts` vide = aucune dynamique sur la piste. */
export function sumGainReduction(parts: GrPart[]): number {
  let s = 0;
  for (const p of parts) s += p.db;
  return s;
}
