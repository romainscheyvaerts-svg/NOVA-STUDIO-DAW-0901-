import { useSyncExternalStore } from 'react';
import { catalogSupabase } from './supabase';
import { deviceLabel } from './SessionCloud';
import { isNovaDesktop } from '../utils/desktopApp';
import { track } from '../utils/analytics';
import {
  DEFAULT_PREFS, appKeyOf, b64urlToBytes, bytesToB64url, isVapidPublicKey, normalizePrefs, parseAskMemory, pushSupport,
  shouldAsk, togglePref, type AskMemory, type AskTrigger, type NotifPrefs, type NotifTarget, type PushSupport,
} from '../utils/pushPrefs';

/**
 * Lot 7 · Notifications NOVA (navigateur, appli installée, appli Windows).
 *
 * - Web Push : le navigateur s'abonne avec la clé PUBLIQUE VAPID du projet (lue dans la config :
 *   VITE_NOVA_VAPID_PUBLIC_KEY, sinon la fonction nova-push « config ») ; l'abonnement est rangé
 *   par nova_push_subscribe (RLS : chacun ses lignes). Le serveur envoie (supabase/functions/nova-push),
 *   public/sw.js affiche.
 * - Appli Windows (WebView2, pas de service worker) : la boîte nova_notifications est écoutée en
 *   temps réel tant que Nova Studio est ouvert ; notification Windows si la fenêtre n'est pas devant.
 * - Sans clé publique (serveur pas encore prêt) ou sur un appareil incapable : tout reste caché,
 *   sans erreur ni requête répétée.
 * - Jamais de demande de permission au chargement : `enable()` n'est appelé que par un geste
 *   (carte « Être prévenu… » montrée après une 1re collaboration ou un 1er commentaire, ou réglages).
 */

export type Availability = 'unknown' | 'checking' | 'yes' | 'no';
export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export interface PushState {
  availability: Availability;
  support: PushSupport;
  loggedIn: boolean;
  permission: PermissionState;
  /** Cet appareil reçoit (abonnement Web Push, ou appli Windows avec réglages actifs). */
  deviceOn: boolean;
  /** Réglages du compte ; null = jamais activées (aucune ligne). */
  prefs: NotifPrefs | null;
  busy: string | null;
  error: string | null;
  info: string | null;
  /** Carte « Être prévenu… » à montrer. */
  ask: { trigger: AskTrigger; other: string | null } | null;
  /** Nouveauté reçue NOVA ouverte (petite carte dans la page). */
  inApp: InAppNotif | null;
}

export interface InAppNotif { title: string; body: string; target: NotifTarget | null; url: string | null; at: number }

const ASK_KEY = 'nova_push_ask';

let state: PushState = {
  availability: 'unknown', support: 'unsupported', loggedIn: false, permission: 'unsupported', deviceOn: false,
  prefs: null, busy: null, error: null, info: null, ask: null, inApp: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<PushState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };

export const pushStore = {
  get: (): PushState => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};
export const usePushState = (): PushState => useSyncExternalStore(pushStore.subscribe, pushStore.get, pushStore.get);

// ─── Appareil ─────────────────────────────────────────────────────────────────

function detectSupport(): PushSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  let standalone = false;
  try { standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true; } catch { /* */ }
  let desktop = false;
  try { desktop = isNovaDesktop(); } catch { /* */ }
  // Appli iPhone / Android (Capacitor) : pas de service worker web.
  if ((window as any).Capacitor) return 'unsupported';
  return pushSupport({
    desktopApp: desktop,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: typeof (window as any).PushManager !== 'undefined',
    notification: typeof (window as any).Notification !== 'undefined',
    ios,
    standalone,
    secure: !!window.isSecureContext,
  });
}

function permissionNow(): PermissionState {
  try {
    const N = (window as any).Notification;
    if (!N) return 'unsupported';
    const p = N.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
  } catch {
    return 'unsupported';
  }
}

function readAsk(): AskMemory {
  try { return parseAskMemory(localStorage.getItem(ASK_KEY)); } catch { return parseAskMemory(null); }
}
function writeAsk(m: AskMemory) {
  try { localStorage.setItem(ASK_KEY, JSON.stringify(m)); } catch { /* stockage indisponible */ }
}

// ─── Clé publique (config) ────────────────────────────────────────────────────

let publicKey: string | null = null;
let probing: Promise<boolean> | null = null;

async function fetchPublicKey(): Promise<string | null> {
  const fromEnv = (import.meta as any).env?.VITE_NOVA_VAPID_PUBLIC_KEY;
  if (isVapidPublicKey(fromEnv)) return String(fromEnv).trim();
  try {
    const { data, error } = await catalogSupabase.functions.invoke('nova-push', { body: { action: 'config' } });
    if (error) return null; // fonction pas encore en ligne : caché, sans bruit
    return isVapidPublicKey(data?.public_key) ? String(data.public_key).trim() : null;
  } catch {
    return null;
  }
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await catalogSupabase.auth.getSession();
    return data?.session?.user?.id || null;
  } catch {
    return null;
  }
}

/** Disponible ici ? (clé publique posée + appareil capable + compte connecté). Une seule vérification par chargement. */
export function probe(): Promise<boolean> {
  if (state.availability === 'yes' || state.availability === 'no') return Promise.resolve(state.availability === 'yes');
  if (probing) return probing;
  probing = (async () => {
    const support = detectSupport();
    set({ support, permission: permissionNow(), availability: 'checking' });
    if (support === 'unsupported') { set({ availability: 'no' }); return false; }
    const uid = await currentUserId();
    if (!uid) { set({ availability: 'unknown', loggedIn: false }); probing = null; return false; }
    publicKey = await fetchPublicKey();
    if (!publicKey) { set({ availability: 'no', loggedIn: true }); return false; }
    set({ availability: 'yes', loggedIn: true });
    await refresh();
    return true;
  })();
  return probing;
}

// ─── État de l'appareil et du compte ──────────────────────────────────────────

async function registration(create: boolean): Promise<ServiceWorkerRegistration | null> {
  try {
    const sw = navigator.serviceWorker;
    if (!sw) return null;
    const reg = await sw.getRegistration();
    if (reg || !create) return reg || null;
    // Le site n'enregistre son service worker qu'en ligne (https) : on le fait ici si besoin.
    if (window.location.protocol !== 'https:') return null;
    return await sw.register('/sw.js');
  } catch {
    return null;
  }
}

async function loadPrefs(): Promise<NotifPrefs | null> {
  try {
    const { data, error } = await catalogSupabase.from('nova_notify_prefs').select('*').maybeSingle();
    if (error) return null;
    return data ? normalizePrefs(data) : null;
  } catch {
    return null;
  }
}

/** Relit l'état (réglages, abonnement de cet appareil) et se réabonne si la clé a changé. */
export async function refresh(): Promise<void> {
  if (state.availability !== 'yes') return;
  const prefs = await loadPrefs();
  let deviceOn = false;
  if (state.support === 'push') {
    const reg = await registration(false);
    let sub: PushSubscription | null = null;
    try { sub = (await reg?.pushManager.getSubscription()) || null; } catch { sub = null; }
    deviceOn = !!sub && permissionNow() === 'granted';
    // Clé VAPID changée côté serveur : l'ancien abonnement ne reçoit plus rien → on se réabonne.
    if (sub && publicKey) {
      const used = bytesToB64url((sub.options as any)?.applicationServerKey || null);
      if (used && used !== publicKey) {
        try { await sub.unsubscribe(); } catch { /* */ }
        deviceOn = false;
        if (prefs?.enabled && permissionNow() === 'granted') { try { deviceOn = await subscribeDevice(); } catch { deviceOn = false; } }
      }
    }
  } else if (state.support === 'desktop') {
    deviceOn = !!prefs?.enabled && permissionNow() !== 'denied';
  }
  set({ prefs, deviceOn, permission: permissionNow() });
  syncInbox();
}

async function subscribeDevice(): Promise<boolean> {
  if (!publicKey) return false;
  const reg = await registration(true);
  if (!reg) throw new Error('Ce navigateur ne permet pas les notifications ici. Ouvre NOVA en ligne (adresse en https) ou installe l’appli.');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) as BufferSource });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const p256dh = json.keys?.p256dh || bytesToB64url(sub.getKey?.('p256dh') || null);
  const auth = json.keys?.auth || bytesToB64url(sub.getKey?.('auth') || null);
  const { error } = await catalogSupabase.rpc('nova_push_subscribe', {
    p_endpoint: sub.endpoint || json.endpoint, p_p256dh: p256dh, p_auth: auth, p_label: deviceLabel(), p_app_key: appKeyOf(publicKey),
  });
  if (error) throw new Error('Le serveur n’a pas enregistré cet appareil. Réessaie dans un instant.');
  return true;
}

async function savePrefs(next: NotifPrefs): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error('Connecte-toi à ton compte Make Music pour régler les notifications.');
  const { error } = await catalogSupabase.from('nova_notify_prefs').upsert({ user_id: uid, ...next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error('Réglage non enregistré : vérifie ta connexion et réessaie.');
}

const DENIED_HELP = 'Les notifications sont bloquées pour NOVA dans ton navigateur. Clique sur le cadenas à gauche de l’adresse › Notifications › Autoriser, puis réessaie.';

/** Activer sur CET appareil (geste de l'utilisateur obligatoire). */
export async function enable(source: 'ask' | 'panel' = 'panel'): Promise<boolean> {
  if (state.availability !== 'yes') return false;
  set({ busy: 'Activation…', error: null, info: null });
  try {
    const N = (window as any).Notification;
    let perm: PermissionState = permissionNow();
    if (perm === 'default' && N?.requestPermission) {
      perm = (await N.requestPermission()) as PermissionState;
    }
    if (perm !== 'granted') {
      set({ busy: null, permission: perm, error: perm === 'denied' ? DENIED_HELP : 'Tu n’as pas autorisé les notifications. Tu peux les activer plus tard dans les réglages.' });
      track('push_permission', { result: perm, source });
      return false;
    }
    if (state.support === 'push') await subscribeDevice();
    const next = { ...(state.prefs || DEFAULT_PREFS), enabled: true };
    await savePrefs(next);
    set({ busy: null, prefs: next, deviceOn: true, permission: 'granted', ask: null, info: 'Notifications activées sur cet appareil.' });
    track('push_enabled', { source, support: state.support });
    syncInbox();
    return true;
  } catch (e) {
    set({ busy: null, error: (e as Error).message || 'Activation impossible pour l’instant.' });
    return false;
  }
}

/** Ne plus rien recevoir sur cet appareil (désabonnement réel du navigateur). */
export async function disableDevice(): Promise<void> {
  set({ busy: 'Désactivation…', error: null, info: null });
  try {
    if (state.support === 'push') {
      const reg = await registration(false);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        try { await catalogSupabase.from('nova_push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch { /* le serveur l'oubliera au 1er envoi refusé */ }
        await sub.unsubscribe();
      }
    }
    set({ busy: null, deviceOn: false, info: 'Cet appareil ne reçoit plus de notifications.' });
    syncInbox();
  } catch {
    set({ busy: null, error: 'Désactivation impossible pour l’instant : réessaie.' });
  }
}

/** Interrupteur général (compte, tous les appareils) ou un type. */
export async function setPref(key: keyof NotifPrefs, on: boolean): Promise<void> {
  const prev = state.prefs || DEFAULT_PREFS;
  const next = togglePref(prev, key, on);
  set({ prefs: next, error: null, info: null });
  try {
    await savePrefs(next);
    if (key === 'enabled' && !on) await disableDevice();
    if (key === 'enabled' && on && !state.deviceOn) await enable('panel');
    syncInbox();
  } catch (e) {
    set({ prefs: prev, error: (e as Error).message });
  }
}

/** Notification d'essai sur ses appareils. */
export async function sendTest(): Promise<void> {
  set({ busy: 'Envoi de l’essai…', error: null, info: null });
  try {
    if (state.support === 'desktop') {
      showSystem({ title: '🔔 Les notifications NOVA marchent', body: 'Tu seras prévenu ici tant que Nova Studio est ouvert.', target: null, url: null, at: Date.now() });
      set({ busy: null, info: 'Essai affiché.' });
      return;
    }
    const { error } = await catalogSupabase.functions.invoke('nova-push', { body: { action: 'test' } });
    if (error) {
      let msg = '';
      try { msg = (await (error as any).context?.json?.())?.error || ''; } catch { /* */ }
      throw new Error(msg || 'L’essai n’est pas parti : vérifie ta connexion.');
    }
    set({ busy: null, info: 'Essai envoyé : il arrive dans quelques secondes.' });
  } catch (e) {
    set({ busy: null, error: (e as Error).message });
  }
}

export const clearMessages = () => set({ error: null, info: null });

// ─── Carte « Être prévenu… » (le bon moment) ─────────────────────────────────

/** Après une 1re collaboration ou un 1er commentaire : propose, une fois, sans rien demander au navigateur. */
export async function requestAsk(trigger: AskTrigger, other: string | null = null, busy = false): Promise<void> {
  if (state.ask) return;
  const ok = await probe();
  if (!ok) return;
  const ctx = {
    available: true, loggedIn: state.loggedIn, permission: permissionNow(), subscribed: state.deviceOn && !!state.prefs?.enabled,
    busy, memory: readAsk(), now: Date.now(),
  };
  if (!shouldAsk(ctx)) return;
  const m = readAsk();
  writeAsk({ ...m, shown: m.shown + 1, lastAt: Date.now() });
  set({ ask: { trigger, other } });
  track('push_ask_shown', { trigger });
}

export function dismissAsk(never = false) {
  if (never) writeAsk({ ...readAsk(), never: true });
  set({ ask: null });
}

// ─── Réception NOVA ouverte (page au premier plan, appli Windows) ────────────

let inboxChannel: { unsubscribe: () => unknown } | null = null;
let inboxUser: string | null = null;

function showSystem(n: InAppNotif) {
  try {
    const N = (window as any).Notification;
    if (N && N.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      const sys = new N(n.title, { body: n.body, icon: '/icons/icon-192.png', tag: n.target?.commentId || undefined });
      sys.onclick = () => { try { window.focus(); } catch { /* */ } sys.close(); if (n.target) openTarget(n.target, n.url); };
    }
  } catch { /* notification système refusée : la carte dans la page suffit */ }
  // La carte reste aussi dans la page : on la retrouve en revenant sur NOVA (même si Windows a masqué la notification).
  set({ inApp: n });
}

function targetOf(d: any): NotifTarget | null {
  if (!d || typeof d !== 'object') return null;
  const s = typeof d.s === 'string' && /^[a-z0-9]{12}$/.test(d.s) ? d.s : null;
  const c = typeof d.c === 'string' && d.c.length <= 80 ? d.c : null;
  const v = typeof d.ver === 'string' && d.ver.length <= 80 ? d.ver : null;
  const at = typeof d.at === 'number' && Number.isFinite(d.at) && d.at >= 0 ? d.at : null;
  return s || c || v ? { sessionId: s, commentId: c, versionId: v, at } : null;
}
const safePath = (u: unknown): string | null => (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u.charAt(1) !== '\\' ? u : null);

/** Une notification ouverte : la page (NotificationsHost) va à la séance / au commentaire. */
type OpenHandler = (t: NotifTarget, url: string | null) => void;
let openHandler: OpenHandler | null = null;
export const setOpenHandler = (h: OpenHandler | null) => { openHandler = h; };
export function openTarget(t: NotifTarget, url: string | null) {
  set({ inApp: null });
  openHandler?.(t, url);
}
export const dismissInApp = () => set({ inApp: null });

/** Messages du service worker (notification touchée, ou reçue NOVA au premier plan). */
export function handleSwMessage(data: any) {
  if (!data || typeof data !== 'object') return;
  const d = data.data;
  if (data.type === 'nova-notif-open') {
    const t = targetOf(d);
    const url = safePath(d?.url);
    if (t || url) openTarget(t || { sessionId: null, commentId: null, versionId: null, at: null }, url);
  } else if (data.type === 'nova-push') {
    set({ inApp: { title: String(d?.title || 'NOVA').slice(0, 120), body: String(d?.body || '').slice(0, 300), target: targetOf(d), url: safePath(d?.url), at: Date.now() } });
  }
}

/** Appli Windows : écoute de la boîte de réception en temps réel tant que l'appli est ouverte. */
function syncInbox() {
  const want = state.availability === 'yes' && state.support === 'desktop' && !!state.prefs?.enabled && state.deviceOn;
  void (async () => {
    const uid = want ? await currentUserId() : null;
    if (uid && uid === inboxUser && inboxChannel) return;
    try { inboxChannel?.unsubscribe(); } catch { /* */ }
    inboxChannel = null; inboxUser = null;
    if (!uid) return;
    inboxUser = uid;
    try {
      const ch = (catalogSupabase as any).channel(`nova-notifs-${uid}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'nova_notifications', filter: `user_id=eq.${uid}` }, (p: any) => {
          const r = p?.new || {};
          const pl = r.payload || {};
          const prefs = state.prefs;
          const key = ({ comment: 'comments', version: 'versions', invite: 'invites', take: 'takes' } as const)[r.type as 'comment'];
          if (!prefs?.enabled || (key && prefs[key] === false)) return;
          showSystem({
            title: String(r.title || 'NOVA'), body: String(r.body || ''), url: safePath(r.url), at: Date.now(),
            target: targetOf({ s: r.session_id, c: pl.c, ver: pl.ver, at: pl.at }),
          });
        })
        .subscribe();
      inboxChannel = ch;
    } catch { /* temps réel indisponible : rien de cassé */ }
  })();
}

// ─── Démarrage (aucune requête tant qu'aucun compte n'est connecté) ─────────

let started = false;
export function startPushNotify() {
  if (started || typeof window === 'undefined') return;
  started = true;
  try { navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => handleSwMessage(e.data)); } catch { /* */ }
  try {
    catalogSupabase.auth.onAuthStateChange((event: string) => {
      if (event === 'SIGNED_OUT') {
        // Plus de compte sur ce navigateur : on coupe l'abonnement (le serveur l'oublie au 1er envoi refusé).
        void (async () => { try { const reg = await registration(false); const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe(); } catch { /* */ } })();
        probing = null;
        set({ availability: state.availability === 'no' && !state.loggedIn ? 'no' : 'unknown', loggedIn: false, prefs: null, deviceOn: false, ask: null });
        syncInbox();
      } else if (event === 'SIGNED_IN' && state.availability !== 'yes') {
        probing = null;
        if (state.availability !== 'no') set({ availability: 'unknown' });
        // Vérifié au calme (pas pendant le chargement du studio).
        window.setTimeout(() => { void probe(); }, 4000);
      }
    });
  } catch { /* */ }
  // Compte déjà connecté : vérification discrète, une fois, après le démarrage.
  window.setTimeout(() => { void probe(); }, 6000);
}

/** Pour les tests : remet le module à zéro. */
export function __resetPushNotifyForTests() {
  publicKey = null; probing = null; started = false; inboxChannel = null; inboxUser = null; openHandler = null;
  state = { availability: 'unknown', support: 'unsupported', loggedIn: false, permission: 'unsupported', deviceOn: false, prefs: null, busy: null, error: null, info: null, ask: null, inApp: null };
}
