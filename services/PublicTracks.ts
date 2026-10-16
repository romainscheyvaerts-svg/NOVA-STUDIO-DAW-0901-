import { catalogSupabase } from './supabase';
import type { PublicKind, PublicTrackOwner, PublicTrackView } from '../utils/publicTrack';

/**
 * Lot 9b (1.5.1) · Appels à la fonction serveur daw-listen pour la page PUBLIQUE d'un morceau :
 *  - propriétaire (compte connecté + lien de sa séance) : lire, publier, retirer / remettre ;
 *  - visiteur (sans compte) : ouvrir la page (lecture seule).
 * Module léger : la page publique (morceau.html) le charge sans le DAW.
 */

export class PublicTrackError extends Error {
  constructor(message: string, public status?: number, public code?: string) { super(message); }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  let res: { data: any; error: any };
  try {
    res = await catalogSupabase.functions.invoke('daw-listen', { body });
  } catch (e: any) {
    throw new PublicTrackError(e?.message || 'Erreur réseau', undefined, 'network');
  }
  const { data, error } = res;
  if (error) {
    let payload: any = null;
    try { payload = await (error as any).context?.json?.(); } catch { /* corps illisible */ }
    const status = (error as any).context?.status;
    const net = typeof status !== 'number';
    if (status === 404 && !payload?.error) throw new PublicTrackError('Les pages publiques ne sont pas encore activées sur le serveur : elles arrivent avec la prochaine mise à jour.', 404, 'not_deployed');
    // Fonction d'avant la 1.5.1 : elle ne connaît pas encore ces actions.
    if (status === 400 && /Action inconnue/i.test(String(payload?.error || ''))) throw new PublicTrackError('Les pages publiques ne sont pas encore activées sur le serveur : elles arrivent avec la prochaine mise à jour.', 400, 'not_deployed');
    throw new PublicTrackError(payload?.error || (net ? 'Pas de connexion au serveur' : error.message) || 'Erreur', status, payload?.code || (net ? 'network' : undefined));
  }
  return data as T;
}

export interface SessionKey { id: string; secret: string }

export interface PublishInput {
  title: string; artist: string; credits: string; lyrics: string; showLyrics: boolean; kind: PublicKind;
  audio: { parts: string[]; size: number; duration: number; mime: string };
  coverPart: string | null;
  exportKey: string; kits: boolean;
}

export const getPublicTrack = (s: SessionKey) => invoke<{ page: PublicTrackOwner | null }>({ action: 'public_get', id: s.id, secret: s.secret }).then(r => r.page);

export const publishTrack = (s: SessionKey, p: PublishInput) => invoke<{ page: PublicTrackOwner }>({
  action: 'public_publish', id: s.id, secret: s.secret, consent: true,
  title: p.title, artist: p.artist, credits: p.credits, lyrics: p.lyrics, show_lyrics: p.showLyrics, kind: p.kind,
  audio: p.audio, cover_part: p.coverPart, export_key: p.exportKey, kits: p.kits,
}).then(r => r.page);

export const setPublished = (s: SessionKey, published: boolean) => invoke<{ page: PublicTrackOwner }>({ action: 'public_set', id: s.id, secret: s.secret, published }).then(r => r.page);

export const openPublicTrack = (id: string, opts: { refresh?: boolean } = {}) =>
  invoke<PublicTrackView>({ action: 'public_open', page: id, ...(opts.refresh ? { refresh: true } : {}) });
