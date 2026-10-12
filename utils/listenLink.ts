/**
 * Lien d'écoute client SANS COMPTE (chantier 12) : fonctions pures partagées
 * par le panneau de l'ingé (components/ListenLinksPanel) et la page du client
 * (components/ListenPage, entrée séparée ecoute.html).
 *
 * Le lien a la forme  <appli>/ecoute.html#t=<jeton>  : le jeton est dans le
 * fragment (#), qui n'est jamais envoyé aux serveurs (ni journaux, ni
 * en-tête Referer). Le serveur (supabase/functions/daw-listen) ne donne
 * qu'une lecture : direct, versions, commentaires.
 *
 * Module pur : tests/listenLink.test.ts.
 */

export const LISTEN_TOKEN_RE = /^[A-Za-z0-9]{32}$/;

/** Durées proposées (heures) : 24 h, 7 jours, 30 jours. */
export const LISTEN_TTL_OPTIONS = [
  { hours: 24, label: '24 h' },
  { hours: 168, label: '7 jours' },
  { hours: 720, label: '30 jours' },
] as const;
export type ListenTtlHours = typeof LISTEN_TTL_OPTIONS[number]['hours'];

/** Au plus autant de clients en direct par lien (chacun reçoit ~512 kb/s envoyés par l'ingé). */
export const MAX_LISTENERS_PER_LINK = 10;

/** Lien public de l'appli quand on tourne dans l'application Windows (pas d'adresse partageable en local). */
export const PUBLIC_APP_BASE = 'https://nova-studio-daw-0901.vercel.app/';

/** Ce que l'ingé voit d'un lien (réponse de listen_create / listen_list). */
export interface ListenLinkInfo {
  id: string;
  token: string;
  label: string;
  live: boolean;
  versions: boolean;
  comments: boolean;
  has_password: boolean;
  created_at: string;
  expires_at: string;
  channel: string;
  opens: number;
  last_opened_at: string | null;
}

/** Ce que le client reçoit (listen_open). */
export interface ListenOpenResult {
  link: { label: string; expires_at: string; live: boolean; versions: boolean; comments: boolean };
  session: { name: string };
  channel: string | null;
  comments: ListenComment[] | null;
  versions: ListenVersion[] | null;
  server_time: string;
}
export interface ListenComment {
  id: string; t: number; end: number | null; text: string; author: string; role: string | null;
  status: 'open' | 'resolved'; created_at: number; replies: { author: string; text: string; at: number }[];
}
export interface ListenVersion {
  id: string; n: number; name: string; note: string | null; sent_at: number; sent_by: string;
  decision: { kind: 'approved' | 'changes'; by: string; at: number; comment: string | null } | null;
  audio: { parts: string[]; size: number; duration: number } | null;
  /** Liens signés des morceaux de l'audio (2 h) ; null : pas d'écoute possible. */
  urls?: Record<string, string> | null;
}

/** Base de l'appli pour construire le lien : l'adresse publique dans l'application Windows. */
export function appBase(loc: { origin: string; pathname: string } | null, desktop: boolean, baseUrl = '/'): string {
  if (desktop || !loc || !/^https?:/.test(loc.origin)) return PUBLIC_APP_BASE;
  const b = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${loc.origin}${b.startsWith('/') ? b : `/${b}`}`;
}

export const listenUrl = (token: string, base: string): string => `${base.endsWith('/') ? base : `${base}/`}ecoute.html#t=${token}`;

/** Jeton lu dans le fragment de l'adresse (« #t=… », ou le jeton seul) ; null s'il manque ou est abîmé. */
export function parseListenToken(hash: string | null | undefined): string | null {
  const h = String(hash || '').replace(/^#/, '').trim();
  if (!h) return null;
  let t = h;
  try { t = new URLSearchParams(h).get('t') ?? h; } catch { /* fragment brut */ }
  t = t.trim();
  return LISTEN_TOKEN_RE.test(t) ? t : null;
}

/** « expire dans 6 j », « dans 23 h », « dans 12 min », « expiré ». */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'expiré';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `expire dans ${min} min`;
  const h = Math.floor(ms / 3600_000);
  if (h < 48) return `expire dans ${h} h`;
  return `expire dans ${Math.floor(ms / 86400_000)} j`;
}

/** Date courte en français (13/10 à 11:07). */
export function fmtDay(msOrIso: number | string): string {
  const d = new Date(typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} à ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Position dans le morceau : 72 → « 1:12 ». */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Résumé du contenu d'un lien : « Mix en direct · Versions · Commentaires ». */
export function contentSummary(l: { live: boolean; versions: boolean; comments: boolean }): string {
  return [l.live && 'Mix en direct', l.versions && 'Versions', l.comments && 'Commentaires'].filter(Boolean).join(' · ') || 'Rien';
}

export type ListenErrorCode = 'unknown' | 'expired' | 'revoked' | 'gone' | 'password_required' | 'password_wrong' | 'locked' | 'missing' | 'network';

/** Écran d'erreur de la page du client : titre, texte, et ce qu'il peut faire. */
export function listenErrorView(code: ListenErrorCode, serverMessage?: string | null): { title: string; text: string; retry: boolean; password: boolean } {
  const msg = (serverMessage || '').trim();
  switch (code) {
    case 'expired': return { title: 'Ce lien a expiré', text: msg || 'Demande un nouveau lien à ton ingé son.', retry: false, password: false };
    case 'revoked': return { title: 'Ce lien a été désactivé', text: "L'ingé son a désactivé ce lien : il ne s'ouvre plus. Demande-lui un nouveau lien.", retry: false, password: false };
    case 'gone': return { title: "Cette séance n'existe plus", text: msg || 'Demande un nouveau lien à ton ingé son.', retry: false, password: false };
    case 'password_required': return { title: 'Lien protégé', text: msg || 'Entre le mot de passe donné par ton ingé son.', retry: false, password: true };
    case 'password_wrong': return { title: 'Mot de passe incorrect', text: 'Vérifie les majuscules et réessaie.', retry: false, password: true };
    case 'locked': return { title: "Trop d'essais", text: msg || 'Réessaie dans quelques minutes.', retry: true, password: false };
    case 'missing': return { title: 'Lien incomplet', text: "L'adresse ne contient pas le code d'écoute : recopie le lien en entier depuis le message de ton ingé son.", retry: false, password: false };
    case 'network': return { title: 'Pas de connexion', text: 'Vérifie ta connexion internet, puis réessaie.', retry: true, password: false };
    default: return { title: 'Lien introuvable', text: msg || "Vérifie qu'il est complet, ou demande un nouveau lien à ton ingé son.", retry: false, password: false };
  }
}

/** Code d'erreur d'une réponse du serveur (statut HTTP + champ code). */
export function errorCodeOf(status: number | undefined, code: unknown): ListenErrorCode {
  const c = String(code || '');
  if (['unknown', 'expired', 'revoked', 'gone', 'password_required', 'password_wrong', 'locked'].includes(c)) return c as ListenErrorCode;
  if (status === 410) return 'expired';
  if (status === 404) return 'unknown';
  if (status === 401) return 'password_required';
  if (status === 403) return 'password_wrong';
  if (status === 429) return 'locked';
  return 'network';
}

// ─── Présence sur le canal du lien (Supabase Realtime) ────────────────────────────────────

/** Ce que chacun annonce : l'ingé (« host », diffuse ou non), les clients (« listener », veulent écouter ou non). */
export type ListenPresence = { role: 'host'; live: boolean; name?: string } | { role: 'listener'; want: boolean };
type PresenceState = Record<string, Array<Record<string, unknown>>>;

const lastMeta = (metas: Array<Record<string, unknown>> | undefined) => (metas && metas.length ? metas[metas.length - 1] : null);

/** L'ingé sur la page : présent, diffuse, son nom, sa clé. */
export function hostOf(state: PresenceState): { key: string; live: boolean; name: string } | null {
  for (const [key, metas] of Object.entries(state || {})) {
    const m = lastMeta(metas);
    if (m && m.role === 'host') return { key, live: m.live === true, name: typeof m.name === 'string' ? m.name.slice(0, 40) : '' };
  }
  return null;
}

/** Clients qui veulent écouter (clé « l-… »), au plus `max`, dans un ordre stable. */
export function listenersOf(state: PresenceState, max = MAX_LISTENERS_PER_LINK): string[] {
  return Object.entries(state || {})
    .filter(([key, metas]) => /^l-[a-z0-9]{6,32}$/.test(key) && lastMeta(metas)?.role === 'listener' && lastMeta(metas)?.want === true)
    .map(([key]) => key).sort().slice(0, max);
}

/** Nombre de clients sur la page (qu'ils écoutent ou pas). */
export const visitorsOf = (state: PresenceState): number => Object.entries(state || {}).filter(([k, m]) => /^l-/.test(k) && lastMeta(m)?.role === 'listener').length;

export const randomKey = (prefix: 'l' | 'h'): string => {
  let s = '';
  try {
    const b = crypto.getRandomValues(new Uint8Array(12));
    s = Array.from(b, x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  } catch { s = Math.random().toString(36).slice(2, 14); }
  return `${prefix}-${s}`;
};
