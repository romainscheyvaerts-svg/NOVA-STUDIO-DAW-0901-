/**
 * Compte connecté, pour l'accès aux modèles privés (config/templateAccess.ts).
 *
 * NOVA connaît l'utilisateur par deux connexions Supabase :
 *  - le compte Make Music (catalogSupabase : appli Windows, sessions en ligne,
 *    feedback, porte d'entrée DesktopAccessGate) ;
 *  - l'ancien compte du DAW (supabase : AuthScreen, projets cloud).
 * On prend l'e-mail d'une session VÉRIFIÉE par le serveur (auth.getUser contrôle
 * le jeton). Hors ligne, la session gardée sur l'appareil suffit (comme la porte
 * de l'appli Windows). Pas de session : invité → null (aucun modèle privé).
 */
import { isNetworkError } from '../utils/desktopAccess';

export interface AuthClientLike {
  auth: {
    getSession(): Promise<{ data: { session: any } | null; error?: any }>;
    getUser(): Promise<{ data: { user: any } | null; error?: any }>;
  };
}

/** E-mail du compte de ce client Supabase (null : pas connecté / jeton refusé). */
export const verifiedEmail = async (client: AuthClientLike | null | undefined): Promise<string | null> => {
  if (!client) return null;
  let sessionEmail: string | null = null;
  try {
    const { data } = await client.auth.getSession();
    sessionEmail = data?.session?.user?.email || null;
  } catch { return null; }
  if (!sessionEmail) return null;
  try {
    const { data, error } = await client.auth.getUser();
    if (data?.user?.email) return String(data.user.email);
    if (error && isNetworkError(error)) return sessionEmail;
    return null;
  } catch (e) {
    return isNetworkError(e) ? sessionEmail : null;
  }
};

let clientsLoader: () => Promise<(AuthClientLike | null)[]> = async () => {
  const m = await import('./supabase');
  return [m.catalogSupabase as unknown as AuthClientLike, m.supabase as unknown as AuthClientLike];
};
/** Tests : clients à interroger. */
export const setAccountClients = (f: (() => Promise<(AuthClientLike | null)[]>) | null) => {
  if (f) clientsLoader = f;
};

/** E-mail du compte connecté (compte Make Music d'abord), ou null pour un invité. */
export const resolveAccountEmail = async (): Promise<string | null> => {
  let clients: (AuthClientLike | null)[] = [];
  try { clients = await clientsLoader(); } catch { return null; }
  for (const c of clients) {
    const e = await verifiedEmail(c);
    if (e) return e.trim().toLowerCase();
  }
  return null;
};
