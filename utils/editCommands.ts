import { recordAction } from './feedbackLog';
/**
 * Bus des commandes d'édition (point d'accroche des raccourcis Pro Tools).
 *
 * La table des raccourcis (utils/keymap) n'appelle jamais directement
 * l'arrangement : elle demande une commande par son identifiant. Qui sait la
 * faire s'enregistre ici :
 * - ArrangementView fournit les versions de base (séparer, dupliquer, zoom,
 *   hauteur des pistes…) sur la sélection de clips qu'il connaît ;
 * - hooks/useEditCommands.ts (sélection de plage, nudge, fondus, Smart Tool —
 *   vagues V1 à V3) pourra s'enregistrer à son tour : le dernier inscrit passe
 *   en premier, sans rien changer à la table des raccourcis.
 *
 * Un gestionnaire renvoie `false` s'il n'a rien pu faire (rien de sélectionné) :
 * la commande passe alors au suivant, puis au repli prévu par l'appelant.
 */

export type EditCommandId =
  | 'split' | 'duplicate' | 'copy' | 'cut' | 'paste' | 'delete' | 'mute'
  | 'nudgeLeft' | 'nudgeRight'
  | 'quickFades' | 'fadeInToCursor' | 'fadeOutToCursor' | 'trimStartToCursor' | 'trimEndToCursor'
  | 'renameClip' | 'clipColor' | 'stripSilence' | 'selectAllClips'
  | 'zoomIn' | 'zoomOut' | 'zoomPreset' | 'zoomToSelection'
  | 'trackHeight' | 'trackHeightUp' | 'trackHeightDown';

export type EditCommandHandler = (arg?: any) => boolean | void;

const stacks = new Map<EditCommandId, EditCommandHandler[]>();

/**
 * Inscrit des gestionnaires ; renvoie la fonction de désinscription.
 * `priority` : les plus hautes passent d'abord (à égalité, le dernier inscrit).
 * Les commandes de sélection (plage, nudge) s'inscrivent en priorité 10, pour
 * rester devant les versions de base même quand l'arrangement se réinscrit.
 */
export function registerEditCommands(map: Partial<Record<EditCommandId, EditCommandHandler>>, priority = 0): () => void {
  const entries = Object.entries(map) as [EditCommandId, EditCommandHandler][];
  for (const [id, fn] of entries) {
    const list = stacks.get(id) || [];
    (fn as any).__prio = priority;
    list.push(fn);
    // Tri stable : priorité croissante (le dispatch lit la liste à l'envers).
    list.sort((a, b) => ((a as any).__prio || 0) - ((b as any).__prio || 0));
    stacks.set(id, list);
  }
  return () => {
    for (const [id, fn] of entries) {
      const list = stacks.get(id);
      if (!list) continue;
      const i = list.lastIndexOf(fn);
      if (i > -1) list.splice(i, 1);
      if (!list.length) stacks.delete(id);
    }
  };
}

/** Lance une commande : true si quelqu'un l'a faite. */
export function runEditCommand(id: EditCommandId, arg?: any): boolean {
  recordAction(`edit:${id}`);
  const list = stacks.get(id);
  if (!list) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      if (list[i](arg) !== false) return true;
    } catch (e) {
      console.warn(`[editCommands] ${id} :`, e);
    }
  }
  return false;
}

export const hasEditCommand = (id: EditCommandId) => (stacks.get(id)?.length || 0) > 0;
