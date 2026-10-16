/**
 * Lot 9b (1.5.1) · Page PUBLIQUE d'un morceau : fonctions PURES partagées par le panneau de
 * publication (components/SessionShare) et la page elle-même (components/PublicTrackPage,
 * entrée séparée morceau.html, chargée sans le DAW).
 *
 * Adresse : <appli>/morceau.html?m=<id>  (id public de 10 caractères : la page est publique,
 * la publication est un choix explicite et désactivable). Lecteur intégrable : la même adresse
 * avec &embed=1, dans une <iframe>.
 *
 * Module pur : tests/publicTrack.test.ts.
 */

export const PUBLIC_ID_RE = /^[a-z0-9]{10}$/;
/** Durée de l'extrait (la sortie audio du gratuit). */
export const EXTRAIT_SECONDES = 30;

export type PublicKind = 'mix' | 'extrait';

/** Ce que voit le visiteur (public_open). */
export interface PublicTrackView {
  id: string;
  title: string;
  artist: string;
  credits: string;
  lyrics: string;
  kind: PublicKind;
  duration: number;
  mime: string;
  /** Liens signés (1 h) des morceaux du son, dans l'ordre. */
  urls: string[];
  cover_url: string | null;
  booking_url: string;
  plays: number;
  updated_at: string;
}

/** Ce que voit le propriétaire (public_get / public_publish / public_set). */
export interface PublicTrackOwner {
  id: string; title: string; artist: string; credits: string; lyrics: string; show_lyrics: boolean;
  kind: PublicKind; duration: number; published: boolean; plays: number;
  created_at: string; updated_at: string; unpublished_at: string | null;
}

const base = (b: string) => (b.endsWith('/') ? b : `${b}/`);
export const publicTrackUrl = (id: string, appBase: string): string => `${base(appBase)}morceau.html?m=${id}`;
export const embedUrl = (id: string, appBase: string): string => `${publicTrackUrl(id, appBase)}&embed=1`;

/** Code à coller sur un site (lecteur compact, 152 px de haut comme les lecteurs courants). */
export function embedCode(id: string, appBase: string, title = ''): string {
  const t = (title || 'Morceau').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
  return `<iframe src="${embedUrl(id, appBase)}" title="${t} · NOVA Studio" width="100%" height="152" style="border:0;border-radius:16px;max-width:560px" loading="lazy" allow="autoplay"></iframe>`;
}

/** Id et mode lus dans l'adresse (?m=…&embed=1). */
export function parsePublicLocation(search: string | null | undefined): { id: string | null; embed: boolean } {
  let p: URLSearchParams;
  try { p = new URLSearchParams(String(search || '')); } catch { return { id: null, embed: false }; }
  const id = (p.get('m') || '').trim();
  return { id: PUBLIC_ID_RE.test(id) ? id : null, embed: p.get('embed') === '1' };
}

/**
 * Ce que le propriétaire peut publier : le morceau ENTIER seulement si son export est débloqué
 * (même décision que la fenêtre Exporter, prise par le serveur) ; sinon l'extrait de 30 s.
 * Le serveur vérifie de nouveau.
 */
export function publishChoices(access: { unlocked: boolean; reason?: string | null } | null): { mix: boolean; why: string | null } {
  if (access?.unlocked) return { mix: true, why: null };
  if (access?.reason === 'catalogue_non_achete') return { mix: false, why: 'L’instru du catalogue n’est pas achetée : seul l’extrait de 30 s peut être publié.' };
  if (access?.reason === 'erreur') return { mix: false, why: 'Vérification de l’export impossible pour l’instant : l’extrait de 30 s reste possible.' };
  return { mix: false, why: 'Le morceau entier se publie quand son export est débloqué (Nova Pro ou export du projet). L’extrait de 30 s, lui, est gratuit.' };
}

export type PublicErrorCode = 'unknown' | 'unpublished' | 'gone' | 'missing' | 'network' | 'not_deployed';

export function publicErrorView(code: PublicErrorCode): { title: string; text: string; retry: boolean } {
  switch (code) {
    case 'unpublished': return { title: 'Ce morceau n’est plus publié', text: 'Son auteur a retiré la page. Le lien ne s’ouvre plus.', retry: false };
    case 'gone': return { title: 'Ce morceau n’est plus en ligne', text: 'Le son a été retiré du serveur.', retry: false };
    case 'missing': return { title: 'Lien incomplet', text: 'L’adresse ne contient pas le code du morceau : recopie le lien en entier.', retry: false };
    case 'network': return { title: 'Pas de connexion', text: 'Vérifie ta connexion internet, puis réessaie.', retry: true };
    case 'not_deployed': return { title: 'Bientôt disponible', text: 'Les pages publiques arrivent avec la prochaine mise à jour du serveur.', retry: true };
    default: return { title: 'Morceau introuvable', text: 'Vérifie le lien : il est peut-être incomplet.', retry: false };
  }
}

export function publicErrorCode(status: number | undefined, code: unknown): PublicErrorCode {
  const c = String(code || '');
  if (['unknown', 'unpublished', 'gone', 'missing', 'network', 'not_deployed'].includes(c)) return c as PublicErrorCode;
  if (status === 410) return 'unpublished';
  if (status === 404) return 'unknown';
  return 'network';
}

/** Durée : 72 → « 1:12 ». */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** « 1 écoute », « 12 écoutes ». */
export const playsText = (n: number): string => (n === 1 ? '1 écoute' : `${Math.max(0, n)} écoutes`);
