/**
 * Quitter la page (paiement Stripe, portail d'abonnement) SANS perdre le travail.
 *
 * Avant : un achat redirigeait l'onglet vers Stripe (et, en cas d'erreur, vers une
 * fausse page « paiement réussi ») sans rien sauvegarder : les changements faits
 * depuis la dernière sauvegarde automatique (jusqu'à 15 s) étaient perdus.
 *
 * Maintenant : le studio enregistre ici sa fonction de sauvegarde ; tout départ de
 * la page passe par `leavePage()`, qui sauvegarde d'abord. Si la sauvegarde échoue,
 * la page reste ouverte et un message dit quoi faire.
 */

export type ProjectSaver = () => Promise<boolean>;

let saver: ProjectSaver | null = null;

/** Le studio donne sa sauvegarde (null quand il se démonte). */
export function registerSaveBeforeLeave(fn: ProjectSaver | null): void {
  saver = fn;
}

/**
 * Sauvegarde le projet ouvert. true : sauvegardé, ou rien à sauvegarder.
 * false : échec ou trop long (le départ doit être annulé).
 */
export async function saveBeforeLeaving(timeoutMs = 10_000): Promise<boolean> {
  if (!saver) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      saver().catch(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const SAVE_FAILED_MESSAGE =
  "Ton projet n'a pas pu être sauvegardé, donc la page reste ouverte pour ne rien perdre. "
  + 'Exporte-le (Session › Exporter le projet .zip), puis réessaie.';

/**
 * Quitte la page vers `url` après avoir sauvegardé le projet.
 * Renvoie une erreur (la page reste) si la sauvegarde a échoué.
 */
export async function leavePage(url: string, go: (u: string) => void = u => { window.location.href = u; }): Promise<{ error?: string }> {
  if (!(await saveBeforeLeaving())) return { error: SAVE_FAILED_MESSAGE };
  go(url);
  return {};
}
