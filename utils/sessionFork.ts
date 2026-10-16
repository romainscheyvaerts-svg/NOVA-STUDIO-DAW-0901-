/**
 * Lot 9a (1.5.1) · Lien « Faire sa version » : fonctions PURES partagées par le panneau de
 * l'hôte et l'arrivée du destinataire (components/SessionShare), et le service
 * services/SessionFork (fonction serveur daw-fork).
 *
 * Le lien a la forme  <appli>/#copie=<jeton>  : le jeton est dans le fragment (#), jamais
 * envoyé aux serveurs (ni journaux, ni en-tête Referer). Il ne donne qu'une COPIE privée :
 * jamais l'accès à la séance d'origine.
 *
 * Module pur : tests/sessionFork.test.ts.
 */
import type { DAWState } from '../types';
import { newExportKey } from './exportRights';

export const FORK_TOKEN_RE = /^[A-Za-z0-9]{32}$/;
/** Liens actifs au plus par séance (comme le serveur). */
export const MAX_FORK_LINKS = 5;

/** Ce que l'hôte voit d'un lien (fork_create / fork_list). */
export interface ForkLinkInfo {
  id: string;
  token: string;
  label: string;
  name: string;
  version: number;
  created_at: string;
  copies: number;
  last_copy_at: string | null;
  files: number;
}

export const forkUrl = (token: string, base: string): string => `${base.endsWith('/') ? base : `${base}/`}#copie=${token}`;

/** Jeton lu dans le fragment (« #copie=… ») ; null s'il manque ou est abîmé. */
export function parseForkToken(hash: string | null | undefined): string | null {
  const h = String(hash || '').replace(/^#/, '').trim();
  if (!h) return null;
  let t: string | null = null;
  try { t = new URLSearchParams(h).get('copie'); } catch { /* fragment brut */ }
  t = (t || '').trim();
  return FORK_TOKEN_RE.test(t) ? t : null;
}

/** Adresse sans le jeton (après ouverture : un rechargement ne refait pas la copie). */
export function withoutForkToken(href: string): string {
  try {
    const u = new URL(href);
    const params = new URLSearchParams(u.hash.replace(/^#/, ''));
    if (!params.has('copie')) return href;
    params.delete('copie');
    const rest = params.toString();
    u.hash = rest ? `#${rest}` : '';
    return u.toString().replace(/#$/, '');
  } catch { return href; }
}

/** Nom de la copie : « Ma version · Beat de Max ». */
export const copyName = (name: string): string => `Ma version · ${(name || 'Séance').replace(/^Ma version · /, '').trim() || 'Séance'}`.slice(0, 80);

/**
 * Le projet reçu devient un projet À SOI : nouvel identifiant (jamais celui de la séance d'origine,
 * donc jamais synchronisé avec elle), sa propre clé d'export (il n'hérite pas d'un export payé par
 * l'hôte), et plus rien de la collaboration de l'hôte (hôte, droits d'invité, journal, liens d'ingé,
 * commentaires et versions envoyées, propriétaires des pistes). Pistes, audio, tempo, accords,
 * marqueurs, notes et paroles restent.
 */
export function prepareForkCopy<T extends Partial<DAWState> & { tracks?: any[] }>(st: T, opts: { name: string; now?: number; exportKey?: string }): T {
  const now = opts.now ?? Date.now();
  const out: any = { ...st, id: `proj-${now}`, name: copyName(opts.name || (st as any).name || ''), exportKey: opts.exportKey || newExportKey() };
  for (const k of ['collabSeq', 'collabHost', 'collabGuestRights', 'collabTimeOps', 'remoteInge', 'timelineComments', 'mixVersions']) delete out[k];
  out.tracks = (st.tracks || []).map((t: any) => {
    const c = { ...t };
    for (const k of ['collabOwner', 'collabOwnerKey', 'collabOwnerName', 'collabOwnerColor', 'remote']) delete c[k];
    return c;
  });
  return out as T;
}

export type ForkErrorCode = 'unknown' | 'revoked' | 'gone' | 'login' | 'not_deployed' | 'network' | 'damaged';

/** Écran d'erreur de l'arrivée : titre, texte, et si « Réessayer » a un sens. */
export function forkErrorView(code: ForkErrorCode, serverMessage?: string | null): { title: string; text: string; retry: boolean } {
  const msg = (serverMessage || '').trim();
  switch (code) {
    case 'revoked': return { title: 'Ce lien a été désactivé', text: "La personne qui l'a créé l'a désactivé : demande-lui un nouveau lien.", retry: false };
    case 'gone': return { title: "La séance d'origine n'est plus en ligne", text: msg || 'Demande un nouveau lien à la personne qui te l’a envoyé.', retry: false };
    case 'login': return { title: 'Connecte-toi pour récupérer ta version', text: 'Un compte gratuit suffit : ta copie sera rien qu’à toi.', retry: false };
    case 'not_deployed': return { title: 'Bientôt disponible', text: "Les liens « Faire sa version » arrivent avec la prochaine mise à jour du serveur. Réessaie un peu plus tard.", retry: true };
    case 'network': return { title: 'Pas de connexion', text: 'Vérifie ta connexion internet, puis réessaie.', retry: true };
    case 'damaged': return { title: 'Copie incomplète', text: 'Un fichier audio est arrivé abîmé : réessaie (rien n’a été modifié).', retry: true };
    default: return { title: 'Lien introuvable', text: msg || 'Vérifie qu’il est complet (copie-le en entier), ou demande un nouveau lien.', retry: false };
  }
}

/** Code d'erreur d'une réponse du serveur (statut HTTP + champ code). */
export function forkErrorCode(status: number | undefined, code: unknown): ForkErrorCode {
  const c = String(code || '');
  if (['unknown', 'revoked', 'gone', 'login', 'not_deployed', 'network', 'damaged'].includes(c)) return c as ForkErrorCode;
  if (status === 401) return 'login';
  if (status === 410) return 'revoked';
  if (status === 404) return 'unknown';
  return 'network';
}

/** « 3 copies », « 1 copie », « aucune copie pour l'instant ». */
export const copiesText = (n: number): string => (n <= 0 ? 'aucune copie pour l’instant' : n === 1 ? '1 copie' : `${n} copies`);

/**
 * Empreinte de l'audio d'un projet : SHA-1 de chaque fichier, triés par nom. Deux projets ont
 * le même son au bit près si leurs empreintes sont égales (preuve de la copie).
 */
export function audioFingerprint(files: Record<string, string>): string {
  return Object.keys(files).sort().map(k => `${k}:${files[k]}`).join('|');
}
