/**
 * Lot 7 · Notifications : règles pures côté NOVA (aucun React, aucun réseau).
 *  - réglages : un interrupteur général et un réglage par type (commentaires, versions,
 *    invitations, prises reçues), mêmes noms de colonnes que la table nova_notify_prefs ;
 *  - quand DEMANDER : jamais au chargement, seulement après une première collaboration ou un
 *    premier commentaire, au plus 2 fois, 14 jours d'écart, jamais après « Ne plus demander » ;
 *  - ce que l'appareil sait faire (Web Push, appli Windows, iPhone sans l'appli installée…) ;
 *  - lien d'ouverture d'une notification (séance, commentaire, version, instant).
 * Tests : tests/pushPrefs.test.ts.
 */

export type NotifType = 'comment' | 'version' | 'invite' | 'take';
export type PrefKey = 'comments' | 'versions' | 'invites' | 'takes';

export interface NotifPrefs {
  enabled: boolean;
  comments: boolean;
  versions: boolean;
  invites: boolean;
  takes: boolean;
}

export const DEFAULT_PREFS: NotifPrefs = { enabled: true, comments: true, versions: true, invites: true, takes: true };

export const PREF_KEYS: PrefKey[] = ['comments', 'versions', 'invites', 'takes'];

export const PREF_OF: Record<NotifType, PrefKey> = { comment: 'comments', version: 'versions', invite: 'invites', take: 'takes' };

/** Libellés des réglages (montrés tels quels). */
export const PREF_LABELS: Record<PrefKey, { emoji: string; label: string; help: string }> = {
  comments: { emoji: '💬', label: 'Commentaires', help: 'Un commentaire ou une réponse sur ta séance, avec l’instant (« 1:12 »).' },
  versions: { emoji: '📨', label: 'Versions du mix', help: 'Une nouvelle version envoyée, validée ou à retoucher.' },
  invites: { emoji: '👥', label: 'Invitations', help: 'Quelqu’un rejoint ta séance, ou le studio t’en envoie une.' },
  takes: { emoji: '🎙️', label: 'Prises reçues', help: 'Une prise envoyée en direct par un artiste de ta séance.' },
};

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Ligne de la base (ou rien) → réglages complets. */
export function normalizePrefs(row: Partial<Record<keyof NotifPrefs, unknown>> | null | undefined): NotifPrefs {
  const r = row || {};
  return {
    enabled: bool(r.enabled, DEFAULT_PREFS.enabled),
    comments: bool(r.comments, true),
    versions: bool(r.versions, true),
    invites: bool(r.invites, true),
    takes: bool(r.takes, true),
  };
}

/** Une notification de ce type passe-t-elle ? (même règle que le serveur, supabase/functions/nova-push/messages.ts) */
export function prefAllows(p: NotifPrefs | null | undefined, type: NotifType): boolean {
  return !!p && p.enabled && p[PREF_OF[type]] !== false;
}

/** Bascule un réglage. Tout couper puis rallumer garde les choix par type. */
export function togglePref(p: NotifPrefs, key: keyof NotifPrefs, on: boolean): NotifPrefs {
  const next = { ...p, [key]: on };
  // Rallumer un type quand tout était coupé rallume le général (sinon le clic ne ferait rien).
  if (key !== 'enabled' && on && !p.enabled) next.enabled = true;
  return next;
}

/** « 3 sur 4 », « tout coupé »… (résumé dans les réglages). */
export function prefsSummary(p: NotifPrefs): string {
  if (!p.enabled) return 'Tout est coupé';
  const n = PREF_KEYS.filter(k => p[k]).length;
  if (n === PREF_KEYS.length) return 'Tout est activé';
  if (n === 0) return 'Aucun type choisi';
  return `${n} type${n > 1 ? 's' : ''} sur ${PREF_KEYS.length}`;
}

// ─── Quand demander ───────────────────────────────────────────────────────────

export type AskTrigger = 'collab' | 'comment';

export interface AskMemory {
  /** Nombre de fois où la carte a été montrée. */
  shown: number;
  /** Dernière fois (ms). */
  lastAt: number;
  /** « Ne plus demander ». */
  never: boolean;
}

export const EMPTY_ASK: AskMemory = { shown: 0, lastAt: 0, never: false };
export const ASK_MAX = 2;
export const ASK_GAP_MS = 14 * 86400_000;

export function parseAskMemory(raw: string | null | undefined): AskMemory {
  try {
    const v = JSON.parse(raw || 'null');
    if (!v || typeof v !== 'object') return { ...EMPTY_ASK };
    return {
      shown: Number.isFinite(v.shown) ? Math.max(0, Math.floor(v.shown)) : 0,
      lastAt: Number.isFinite(v.lastAt) ? v.lastAt : 0,
      never: v.never === true,
    };
  } catch {
    return { ...EMPTY_ASK };
  }
}

export interface AskContext {
  /** Clé publique configurée ET appareil capable (sinon la fonction est cachée). */
  available: boolean;
  loggedIn: boolean;
  /** Notification.permission (« default » : jamais demandé à cet appareil). */
  permission: 'default' | 'granted' | 'denied' | 'unsupported';
  /** Déjà activées sur cet appareil. */
  subscribed: boolean;
  /** Pendant une prise / un décompte : on attend. */
  busy: boolean;
  memory: AskMemory;
  now: number;
}

/** Montrer la carte « Être prévenu… » maintenant ? */
export function shouldAsk(ctx: AskContext): boolean {
  if (!ctx.available || !ctx.loggedIn || ctx.busy || ctx.subscribed) return false;
  if (ctx.permission === 'denied' || ctx.permission === 'unsupported') return false;
  const m = ctx.memory;
  if (m.never || m.shown >= ASK_MAX) return false;
  if (m.lastAt && ctx.now - m.lastAt < ASK_GAP_MS) return false;
  return true;
}

/** La phrase de la carte : dit POURQUOI, au moment où ça a du sens. */
export function askText(trigger: AskTrigger, other?: string | null): { title: string; short: string; detail: string } {
  const who = (other || '').trim().slice(0, 30);
  if (trigger === 'collab') {
    return {
      title: who ? `Être prévenu quand ${who} commente ou t’envoie une prise ?` : 'Être prévenu quand ton équipe commente ou t’envoie une prise ?',
      short: who ? `Être prévenu quand ${who} t’envoie quelque chose ?` : 'Être prévenu quand ton équipe t’envoie quelque chose ?',
      detail: 'Même NOVA fermée. Tu choisis quoi recevoir, et tu coupes quand tu veux.',
    };
  }
  return {
    title: 'Être prévenu quand on répond à ton commentaire ?',
    short: 'Être prévenu des réponses, même NOVA fermée ?',
    detail: 'Même NOVA fermée : commentaires, versions, invitations et prises reçues. Tu coupes quand tu veux.',
  };
}

// ─── Ce que l'appareil sait faire ─────────────────────────────────────────────

export type PushSupport =
  /** Web Push (navigateur, appli installée) : notifications même NOVA fermé. */
  | 'push'
  /** Appli Windows (pas de service worker) : notifications tant que Nova Studio est ouvert. */
  | 'desktop'
  /** iPhone / iPad : il faut d'abord installer NOVA sur l'écran d'accueil. */
  | 'ios-install'
  | 'unsupported';

export interface SupportEnv {
  desktopApp: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  /** iPhone / iPad. */
  ios: boolean;
  /** Appli installée (écran d'accueil). */
  standalone: boolean;
  secure: boolean;
}

export function pushSupport(e: SupportEnv): PushSupport {
  if (e.desktopApp) return e.notification ? 'desktop' : 'unsupported';
  if (e.ios && !e.standalone) return 'ios-install';
  if (e.secure && e.serviceWorker && e.pushManager && e.notification) return 'push';
  return 'unsupported';
}

// ─── Clés et liens ────────────────────────────────────────────────────────────

/** Clé publique VAPID (base64url, 65 octets) → octets pour PushManager.subscribe. */
export function b64urlToBytes(s: string): Uint8Array {
  const clean = String(s || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = clean.length % 4 ? '='.repeat(4 - (clean.length % 4)) : '';
  const bin = atob(clean + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | Uint8Array | null | undefined): string {
  if (!buf) return '';
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Clé publique utilisable (65 octets, point non compressé) ? */
export function isVapidPublicKey(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{86,88}$/.test(s.trim())) return false;
  try { const b = b64urlToBytes(s); return b.length === 65 && b[0] === 4; } catch { return false; }
}

/** Empreinte courte de la clé (rangée avec l'abonnement : si la clé change, on se réabonne). */
export const appKeyOf = (publicKey: string) => publicKey.slice(0, 16);

export interface NotifTarget {
  sessionId: string | null;
  commentId: string | null;
  versionId: string | null;
  at: number | null;
}

/** Paramètres posés par une notification (`?session=…&nova_s=…&nova_c=…&nova_at=…`). */
export function parseNotifTarget(search: string | URLSearchParams): NotifTarget | null {
  let q: URLSearchParams;
  try { q = typeof search === 'string' ? new URLSearchParams(search) : search; } catch { return null; }
  const id = (k: string, re: RegExp) => { const v = q.get(k); return v && re.test(v) ? v : null; };
  const sessionId = id('nova_s', /^[a-z0-9]{12}$/);
  const commentId = id('nova_c', /^[A-Za-z0-9_-]{1,80}$/);
  const versionId = id('nova_v', /^[A-Za-z0-9_-]{1,80}$/);
  const atRaw = q.get('nova_at');
  const at = atRaw !== null && atRaw !== '' && Number.isFinite(Number(atRaw)) && Number(atRaw) >= 0 ? Number(atRaw) : null;
  if (!sessionId && !commentId && !versionId) return null;
  return { sessionId, commentId, versionId, at };
}

/** Adresse sans les paramètres de notification (on les retire une fois traités, rien ne se rejoue au F5). */
export function stripNotifParams(href: string): string {
  try {
    const u = new URL(href);
    for (const k of ['nova_s', 'nova_c', 'nova_v', 'nova_at']) u.searchParams.delete(k);
    return u.pathname + (u.searchParams.toString() ? `?${u.searchParams.toString()}` : '') + u.hash;
  } catch {
    return href;
  }
}
