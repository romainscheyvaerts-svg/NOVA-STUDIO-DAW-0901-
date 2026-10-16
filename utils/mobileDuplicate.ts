/**
 * « Dupliquer » de la page Arrangement du téléphone (bouton DUP et outil Dupliquer).
 *
 * Avant : sans la fonction de duplication de l'appli, la page affichait quand même
 * « ✨ Clip dupliqué » alors que rien n'était copié. Maintenant, on ne dit « dupliqué »
 * que si la copie a vraiment été demandée à l'appli (handleEditClip « DUPLICATE » :
 * copie posée juste après le clip, sur la même piste).
 */
export interface DuplicateTarget { trackId: string; clip: { id: string } }

export interface DuplicateResult { ok: boolean; message: string }

export function duplicateClip(
  target: DuplicateTarget | null | undefined,
  onDuplicate: ((trackId: string, clipId: string) => void) | undefined,
): DuplicateResult {
  if (!target) return { ok: false, message: "Touche d'abord un clip pour le choisir." };
  if (!onDuplicate) return { ok: false, message: "Dupliquer n'est pas possible ici." };
  onDuplicate(target.trackId, target.clip.id);
  return { ok: true, message: '✨ Clip dupliqué juste après' };
}
