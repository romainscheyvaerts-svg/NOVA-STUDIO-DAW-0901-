import { catalogSupabase } from './supabase';
import type { ListenLinkInfo, ListenOpenResult, ListenTtlHours } from '../utils/listenLink';

/**
 * Appels à la fonction serveur daw-listen (supabase/functions/daw-listen) :
 *  - ingé (compte connecté + lien de la séance) : créer, lister, révoquer ;
 *  - client (le jeton seul, sans compte) : ouvrir, en lecture seule.
 */

export class ListenError extends Error {
  constructor(message: string, public status?: number, public code?: string, public extra?: Record<string, unknown>) { super(message); }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  let res: { data: any; error: any };
  try {
    res = await catalogSupabase.functions.invoke('daw-listen', { body });
  } catch (e: any) {
    throw new ListenError(e?.message || 'Erreur réseau', undefined, 'network');
  }
  const { data, error } = res;
  if (error) {
    let payload: any = null;
    try { payload = await (error as any).context?.json?.(); } catch { /* corps illisible */ }
    const status = (error as any).context?.status;
    const net = typeof status !== 'number';
    // 404 sans réponse de daw-listen = fonction pas encore mise en ligne (pas un lien inconnu).
    if (status === 404 && !payload?.error) throw new ListenError("Le lien d'écoute client n'est pas encore activé sur le serveur : il arrive avec la prochaine mise en ligne.", 404, 'not_deployed');
    throw new ListenError(payload?.error || (net ? 'Pas de connexion au serveur' : error.message) || 'Erreur', status, payload?.code || (net ? 'network' : undefined), payload || undefined);
  }
  return data as T;
}

export interface SessionKey { id: string; secret: string }

export const createListenLink = (s: SessionKey, opts: { ttlHours: ListenTtlHours; live: boolean; versions: boolean; comments: boolean; password?: string; label?: string }) =>
  invoke<{ link: ListenLinkInfo }>({
    action: 'listen_create', id: s.id, secret: s.secret, ttl_hours: opts.ttlHours,
    live: opts.live, versions: opts.versions, comments: opts.comments,
    ...(opts.password ? { password: opts.password } : {}), ...(opts.label ? { label: opts.label } : {}),
  }).then(r => r.link);

export const listListenLinks = (s: SessionKey) => invoke<{ links: ListenLinkInfo[] }>({ action: 'listen_list', id: s.id, secret: s.secret }).then(r => r.links || []);

export const revokeListenLink = (s: SessionKey, linkId: string) => invoke<{ ok: boolean }>({ action: 'listen_revoke', id: s.id, secret: s.secret, link_id: linkId });

export const openListenLink = (token: string, opts: { password?: string; refresh?: boolean } = {}) =>
  invoke<ListenOpenResult>({ action: 'listen_open', token, ...(opts.password ? { password: opts.password } : {}), ...(opts.refresh ? { refresh: true } : {}) });
