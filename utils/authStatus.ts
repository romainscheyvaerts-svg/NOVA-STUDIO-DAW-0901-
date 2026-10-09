/**
 * Service de connexion (Supabase Auth, projet mxdrx) restreint ou injoignable.
 *
 * Le 09/10/2026, le projet restreint (quota dépassé) répondait 402 avec un JSON brut :
 * l'appli Windows affichait une page noire « Service for this project is restricted… »
 * et le formulaire e-mail un message technique en anglais. Ici, on reconnaît ces cas
 * (402, erreurs 5xx, serveur injoignable alors que l'appareil est en ligne) pour
 * afficher un message clair dans NOVA.
 */

export const AUTH_DOWN_MESSAGE =
  'Le service de connexion est momentanément indisponible. Réessaie dans quelques minutes ; tes projets locaux restent accessibles.';

export const NO_INTERNET_MESSAGE = 'Pas de connexion Internet : vérifie le Wi-Fi et réessaie. Tes projets locaux restent accessibles.';

const statusOf = (e: unknown): number | undefined => {
  const s = (e as any)?.status ?? (e as any)?.code;
  return typeof s === 'number' ? s : (typeof s === 'string' && /^\d{3}$/.test(s) ? Number(s) : undefined);
};

const messageOf = (e: unknown): string =>
  typeof e === 'string' ? e : String((e as any)?.message || (e as any)?.error_description || (e as any)?.msg || e || '');

/** Restriction / panne du service (402, 5xx, « restricted », « exceed_…_quota », réponse non JSON). */
export function isAuthServiceDown(e: unknown): boolean {
  const st = statusOf(e);
  if (st === 402 || (st !== undefined && st >= 500 && st < 600)) return true;
  const m = messageOf(e);
  return /exceed_\w*quota|service for this project is restricted|payment required|bad gateway|service unavailable|gateway time-?out|upstream/i.test(m);
}

/** Échec réseau (pas de réponse du serveur). */
export function isFetchFailure(e: unknown): boolean {
  const m = messageOf(e).toLowerCase();
  const name = String((e as any)?.name || '');
  return (name === 'AuthRetryableFetchError' && !(statusOf(e)! >= 500)) || statusOf(e) === 0
    || /failed to fetch|networkerror|network request failed|load failed|err_name_not_resolved|timeout/.test(m);
}

/**
 * Message clair pour une erreur de connexion due au SERVICE (et non aux identifiants),
 * ou null si ce n'est pas le cas. Réseau en échec alors que l'appareil est en ligne
 * (nom introuvable, serveur muet) : le service est en cause, pas le Wi-Fi.
 */
export function authServiceMessage(e: unknown, online = typeof navigator === 'undefined' ? true : navigator.onLine !== false): string | null {
  if (isAuthServiceDown(e)) return AUTH_DOWN_MESSAGE;
  if (isFetchFailure(e)) return online ? AUTH_DOWN_MESSAGE : NO_INTERNET_MESSAGE;
  return null;
}
