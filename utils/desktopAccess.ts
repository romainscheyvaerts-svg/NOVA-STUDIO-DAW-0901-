/**
 * Porte d'entrée de l'application Windows « Nova Studio » : il faut être connecté
 * avec un compte Make Music (gratuit) pour démarrer le studio. Une fois connecté,
 * tout le monde utilise le studio ; seul l'export est payant pour les non-abonnés
 * (parcours existant : services/Billing + ExportModal, vérifié par la fonction
 * nova-billing côté serveur).
 *
 * La connexion est vérifiée par Supabase (auth.getUser : le jeton est contrôlé par
 * le serveur). Hors ligne, la session gardée par l'appli (profil WebView2) suffit
 * si la dernière vérification en ligne date de moins de 7 jours.
 */

export const OFFLINE_GRACE_MS = 7 * 24 * 3600_000;
export const ACCESS_CACHE_KEY = 'nova_desktop_access_v1';

export interface AccessCache {
  userId: string;
  email: string;
  /** Dernière vérification en ligne réussie (ms). */
  checkedAt: number;
}

export type GateDecision =
  | { state: 'open'; email: string; offline: boolean }
  | { state: 'signed_out' }
  | { state: 'offline_expired'; email?: string };

/**
 * Décide l'état de la porte.
 *  - server : réponse de Supabase (utilisateur vérifié, ou null = pas connecté),
 *    ou 'network' si le serveur n'a pas pu être joint.
 *  - storedUser : utilisateur de la session gardée localement (peut exister hors ligne).
 */
export function decideGate(
  server: { id: string; email: string } | null | 'network',
  storedUser: { id: string; email: string } | null,
  cache: AccessCache | null,
  now: number,
): GateDecision {
  if (server && server !== 'network') return { state: 'open', email: server.email, offline: false };
  if (server === null) return { state: 'signed_out' };
  // Hors ligne : session locale + dernière vérification récente pour ce même compte.
  if (!storedUser) return { state: 'signed_out' };
  if (cache && cache.userId === storedUser.id && now - cache.checkedAt >= 0 && now - cache.checkedAt < OFFLINE_GRACE_MS) {
    return { state: 'open', email: storedUser.email, offline: true };
  }
  return { state: 'offline_expired', email: storedUser.email };
}

export function readAccessCache(): AccessCache | null {
  try {
    const v = JSON.parse(localStorage.getItem(ACCESS_CACHE_KEY) || 'null');
    if (v && typeof v.userId === 'string' && typeof v.checkedAt === 'number') return v as AccessCache;
  } catch { /* stockage indisponible */ }
  return null;
}

export function writeAccessCache(c: AccessCache | null): void {
  try {
    if (c) localStorage.setItem(ACCESS_CACHE_KEY, JSON.stringify(c));
    else localStorage.removeItem(ACCESS_CACHE_KEY);
  } catch { /* stockage indisponible */ }
}

/** Erreur réseau (serveur injoignable) plutôt que refus du serveur. */
export function isNetworkError(e: unknown): boolean {
  const m = String((e as any)?.message || e || '').toLowerCase();
  const name = String((e as any)?.name || '');
  return name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|network request failed|load failed|timeout|fetch/.test(m)
    || (e as any)?.status === 0;
}

/** Messages d'erreur Supabase traduits en français clair. */
export function friendlyAuthError(msg: string): string {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-mail ou mot de passe incorrect.';
  if (m.includes('email not confirmed')) return "Ton e-mail n'est pas encore confirmé : clique sur le lien reçu par mail, puis reconnecte-toi.";
  if (m.includes('already registered') || m.includes('already been registered')) return 'Un compte existe déjà avec cet e-mail : connecte-toi.';
  if (m.includes('password should be') || m.includes('at least 6')) return 'Mot de passe trop court (6 caractères minimum).';
  if (m.includes('rate limit') || m.includes('too many')) return 'Trop de tentatives : patiente une minute et réessaie.';
  if (isNetworkError({ message: msg })) return "Pas de connexion Internet : vérifie le Wi-Fi et réessaie.";
  return msg || 'Une erreur est survenue, réessaie.';
}
