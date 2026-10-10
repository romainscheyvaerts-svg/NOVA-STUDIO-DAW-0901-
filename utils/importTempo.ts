/**
 * Tempo (et tonalité) d'un beat importé du PC : on le détecte à l'import et on
 * PROPOSE de régler le projet en un geste (jamais imposé : l'ingé peut avoir
 * déjà calé sa séance).
 *
 * Détecteurs existants réutilisés (hooks/useImportTempo) :
 * AudioAnalysisEngine.detectBPMAdvanced (autocorrélation de l'enveloppe des
 * graves) et utils/keyDetect (chromagramme + profils de Krumhansl).
 */

/** Un beat : au moins 8 s (une boucle de 4 mesures à 120). */
export const MIN_BEAT_SECONDS = 8;
/** Tempo jugé identique en dessous de cet écart (BPM). */
export const SAME_TEMPO_BPM = 0.75;

/** Nom de fichier qui annonce un beat / une instru (le dépôt hors de la piste « Beat »). */
export function looksLikeBeat(fileName: string): boolean {
  return /(beat|instru|instrumental|prod\b|type ?beat|riddim|loop|boucle)/i.test(fileName || '');
}

/** Le son importé mérite-t-il une détection du tempo ? */
export function shouldDetectTempo(o: { durationSec: number; landedOnBeatTrack: boolean; fileName: string; fromCatalog?: boolean }): boolean {
  if (o.fromCatalog) return false; // le catalogue donne déjà son tempo
  if (!(o.durationSec >= MIN_BEAT_SECONDS)) return false;
  return o.landedOnBeatTrack || looksLikeBeat(o.fileName);
}

/**
 * Tempo à proposer, ou null : tempo invalide, ou même ressenti que le projet
 * (identique, moitié, double : un beat trap à 140 se « compte » aussi à 70).
 */
export function tempoToPropose(detected: number | null | undefined, projectBpm: number): number | null {
  if (!detected || !Number.isFinite(detected) || detected < 60 || detected > 200) return null;
  const bpm = Math.round(detected * 10) / 10;
  for (const k of [1, 2, 0.5]) if (Math.abs(bpm - projectBpm * k) < SAME_TEMPO_BPM * Math.max(1, k)) return null;
  return bpm;
}

export interface ImportTempoProposal {
  /** Nom du fichier importé (sans extension). */
  name: string;
  /** Tempo détecté, à proposer (null : tempo du projet déjà bon). */
  bpm: number | null;
  /** Tempo du projet au moment de la détection. */
  projectBpm: number;
  /** Tonalité détectée (null : pas assez sûre, ou déjà celle du projet). */
  key: { rootKey: number; scale: 'MAJOR' | 'MINOR' } | null;
}

/** Tonalité à proposer : détectée (utils/keyDetect ne répond que s'il est assez sûr) et différente de celle du projet. */
export function keyToPropose(
  detected: { rootKey: number; scale: 'MAJOR' | 'MINOR'; confidence: number } | null | undefined,
  project: { rootKey?: number | null; scale?: string | null },
): { rootKey: number; scale: 'MAJOR' | 'MINOR' } | null {
  if (!detected) return null;
  if (project.rootKey === detected.rootKey && (project.scale || 'MINOR') === detected.scale) return null;
  return { rootKey: detected.rootKey, scale: detected.scale };
}
