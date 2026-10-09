import type { DAWState } from '../types';

/**
 * Règles de l'historique d'annulation (App.tsx, useUndoRedo).
 *
 * - Profondeur : 256 étapes. Avant : 100, une séance d'édition de 200 gestes ne
 *   pouvait pas revenir à son début (Pro Tools : 64 niveaux au maximum ; un ingé
 *   qui comp, nettoie et mixe en fait bien plus en une heure). Les étapes partagent
 *   leur structure (Immer) : seules les pistes modifiées sont copiées.
 * - Changer de projet (ouvrir un fichier, une session du cloud, un modèle, une
 *   version, récupérer après un plantage) vide l'historique, comme Pro Tools à
 *   l'ouverture d'une session. Avant, Ctrl+Z juste après l'ouverture ramenait le
 *   projet PRÉCÉDENT (souvent la session vide du démarrage) : le travail ouvert
 *   disparaissait d'un seul raccourci.
 */
export const UNDO_LIMIT = 256;

/**
 * Le nouvel état est-il un AUTRE projet ? Identifiant différent ET pistes
 * entièrement remplacées. La 1re sauvegarde dans le cloud change l'identifiant
 * sans toucher aux pistes : l'historique est gardé (on annule après avoir sauvé).
 */
export function isProjectSwitch(prev: Pick<DAWState, 'id' | 'tracks'>, next: Pick<DAWState, 'id' | 'tracks'>): boolean {
  if (!prev || !next || prev.id === next.id || prev.tracks === next.tracks) return false;
  const before = new Set(prev.tracks || []);
  return !(next.tracks || []).some(t => before.has(t));
}
