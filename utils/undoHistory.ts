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
/**
 * Historique d'annulation (App.tsx, useUndoRedo). `group` regroupe plusieurs
 * modifications en UNE étape (tout ce que Nova fait pour un message du chat) :
 * 0/absent = normal, 1 = groupe ouvert sans modification encore, 2 = l'étape du
 * groupe est posée, les modifications suivantes s'y ajoutent.
 */
export interface UndoHistory<T> { past: T[]; present: T; future: T[]; lastChangeAt?: number; group?: 0 | 1 | 2 }

/**
 * Une modification RÉELLE du projet : nouvelle étape, ou fusion dans la précédente
 * (anti-rebond des gestes rapprochés, ou groupe ouvert). Pur (appelé dans un reducer).
 */
export function recordChange<T>(h: UndoHistory<T>, next: T, now: number, opts: { debounceMs: number; limit: number; clean: (s: T) => T }): UndoHistory<T> {
  if (h.group === 2) return { ...h, present: next, lastChangeAt: now };
  if (!h.group && now - (h.lastChangeAt || 0) < opts.debounceMs) return { ...h, present: next, lastChangeAt: now };
  return { past: [...h.past, opts.clean(h.present)].slice(-opts.limit), present: next, future: [], lastChangeAt: now, group: h.group === 1 ? 2 : h.group };
}

/** Ouvre un groupe : la prochaine modification pose UNE étape, les suivantes s'y fondent. */
export const openUndoGroup = <T>(h: UndoHistory<T>): UndoHistory<T> => ({ ...h, group: 1 });
/** Ferme le groupe : la modification suivante repart sur une nouvelle étape. */
export const closeUndoGroup = <T>(h: UndoHistory<T>): UndoHistory<T> => ({ ...h, group: 0, lastChangeAt: 0 });

export function isProjectSwitch(prev: Pick<DAWState, 'id' | 'tracks'>, next: Pick<DAWState, 'id' | 'tracks'>): boolean {
  if (!prev || !next || prev.id === next.id || prev.tracks === next.tracks) return false;
  const before = new Set(prev.tracks || []);
  return !(next.tracks || []).some(t => before.has(t));
}
