import JSZip from 'jszip';
import { catalogSupabase } from './supabase';
import { ProjectIO } from './ProjectIO';
import { sha1 } from './SessionCloud';
import type { DAWState } from '../types';
import { audioFingerprint, prepareForkCopy, type ForkLinkInfo } from '../utils/sessionFork';

/**
 * Lot 9a (1.5.1) · Appels à la fonction serveur daw-fork (« Faire sa version ») :
 *  - hôte (compte connecté, propriétaire de la séance) : créer, lister, désactiver un lien ;
 *  - destinataire (le jeton + un compte gratuit) : récupérer SA copie, reconstruite en projet
 *    à soi (utils/sessionFork.prepareForkCopy) ; chaque morceau audio est vérifié (SHA-1) :
 *    la copie est identique au bit près.
 */

export class ForkError extends Error {
  constructor(message: string, public status?: number, public code?: string) { super(message); }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  let res: { data: any; error: any };
  try {
    res = await catalogSupabase.functions.invoke('daw-fork', { body });
  } catch (e: any) {
    throw new ForkError(e?.message || 'Erreur réseau', undefined, 'network');
  }
  const { data, error } = res;
  if (error) {
    let payload: any = null;
    try { payload = await (error as any).context?.json?.(); } catch { /* corps illisible */ }
    const status = (error as any).context?.status;
    const net = typeof status !== 'number';
    // 404 sans réponse de daw-fork = fonction pas encore mise en ligne (pas un lien inconnu).
    if (status === 404 && !payload?.error) throw new ForkError("Les liens « Faire sa version » ne sont pas encore activés sur le serveur : ils arrivent avec la prochaine mise à jour.", 404, 'not_deployed');
    throw new ForkError(payload?.error || (net ? 'Pas de connexion au serveur' : error.message) || 'Erreur', status, payload?.code || (net ? 'network' : undefined));
  }
  return data as T;
}

export interface SessionKey { id: string; secret: string }

export const createForkLink = (s: SessionKey, opts: { label?: string; name?: string } = {}) =>
  invoke<{ link: ForkLinkInfo; catalog_tracks: number; removed_files: number }>({ action: 'fork_create', id: s.id, secret: s.secret, ...(opts.label ? { label: opts.label } : {}), ...(opts.name ? { name: opts.name } : {}) });

export const listForkLinks = (s: SessionKey) => invoke<{ links: ForkLinkInfo[] }>({ action: 'fork_list', id: s.id, secret: s.secret }).then(r => r.links || []);

export const revokeForkLink = (s: SessionKey, linkId: string) => invoke<{ ok: boolean }>({ action: 'fork_revoke', id: s.id, secret: s.secret, link_id: linkId });

type Manifest = { project: any; files: Record<string, { parts: string[]; size: number }> };

export interface ForkCopy {
  state: DAWState;
  /** Nom de la séance d'origine et « pour qui » (choisi par l'hôte). */
  name: string;
  label: string;
  /** Empreinte de l'audio reçu (SHA-1 de chaque fichier) : preuve de la copie au bit près. */
  fingerprint: string;
  files: Record<string, string>;
  copies: number;
}

const hexOf = async (bytes: Uint8Array) => sha1(bytes);

/** Récupère sa copie : télécharge, vérifie chaque morceau, reconstruit un projet à soi. */
export async function openForkCopy(token: string, onProgress?: (pct: number, msg: string) => void): Promise<ForkCopy> {
  onProgress?.(3, 'Ouverture du lien…');
  const r = await invoke<{ name: string; label: string; manifest: Manifest; urls: Record<string, string>; copies: number }>({ action: 'fork_open', token });
  if (!r.manifest?.project) throw new ForkError('Cette séance est vide.', 410, 'gone');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(r.manifest.project));
  const entries = Object.entries(r.manifest.files || {});
  const total = entries.reduce((s, [, f]) => s + (f.size || 0), 0);
  const files: Record<string, string> = {};
  let got = 0;
  for (const [name, f] of entries) {
    const buf = new Uint8Array(f.size);
    let off = 0;
    for (const p of f.parts) {
      const url = r.urls?.[p];
      if (!url) throw new ForkError('Un fichier audio de la séance est introuvable.', 410, 'gone');
      let res: Response;
      try { res = await fetch(url); } catch { throw new ForkError('Téléchargement interrompu', undefined, 'network'); }
      if (!res.ok) throw new ForkError(`Téléchargement impossible (${res.status})`, undefined, res.status === 404 ? 'gone' : 'network');
      const b = new Uint8Array(await res.arrayBuffer());
      // Chaque morceau est nommé par son SHA-1 : vérifié, la copie est identique au bit près.
      if ((await hexOf(b)) !== p) throw new ForkError('Morceau audio abîmé en route', undefined, 'damaged');
      buf.set(b.subarray(0, Math.max(0, f.size - off)), off);
      off += b.length;
      got += b.length;
      onProgress?.(5 + Math.round(85 * got / Math.max(1, total)), `Copie de l'audio… ${Math.round(got / 1048576)} / ${Math.max(1, Math.round(total / 1048576))} Mo`);
    }
    files[name] = await hexOf(buf);
    zip.file(name, buf);
  }
  onProgress?.(93, 'Création de ta version…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const loaded = await ProjectIO.loadProject(new File([blob], 'ma-version.novaproj.zip'));
  const state = prepareForkCopy(loaded, { name: r.name || loaded.name || 'Séance' }) as DAWState;
  onProgress?.(100, 'Ta version est prête');
  return { state, name: r.name || '', label: r.label || '', fingerprint: audioFingerprint(files), files, copies: Number(r.copies) || 0 };
}
