/**
 * Connexion Google dans l'application Windows « Nova Studio ».
 *
 * Google refuse de s'authentifier dans une WebView (« disallowed_useragent »). Comme dans
 * l'app iPhone du site Make Music (src/lib/authNative.ts), la page Google s'ouvre donc dans
 * le navigateur par défaut, et le retour se fait par un petit serveur local temporaire
 * (desktop/google_login.py) :
 *
 *   page ──prepare──▶ Python : serveur 127.0.0.1 + state à usage unique
 *   page ◀──ready──── adresse de retour http://127.0.0.1:<port>/cb?nova_state=…
 *   page : signInWithOAuth({ redirectTo, skipBrowserRedirect: true }) → URL Google
 *   page ──open─────▶ Python ouvre l'URL dans le navigateur par défaut
 *   navigateur → Google → Supabase → 127.0.0.1/cb (jetons dans le fragment, state vérifié)
 *   page ◀──result─── jetons → supabase.auth.setSession
 *
 * Supabase accepte d'office les adresses de retour en 127.0.0.1 (n'importe quel port) :
 * aucune « Redirect URL » à ajouter. Sur le web, rien de tout ça : la porte n'existe pas.
 */

import { AUTH_DOWN_MESSAGE } from './authStatus';

export const GOOGLE_MSG = {
  prepare: 'nova-google:prepare',
  ready: 'nova-google:ready',
  open: 'nova-google:open',
  cancel: 'nova-google:cancel',
  result: 'nova-google:result',
} as const;

/** Délai d'attente de la réponse de l'appli au « prepare » (ancienne version de l'appli ?). */
export const PREPARE_TIMEOUT_MS = 8000;

export interface DesktopMessage { type: string; attempt?: string; [k: string]: unknown }

export interface DesktopTransport {
  send(msg: Record<string, unknown>): void;
  subscribe(fn: (msg: DesktopMessage) => void): () => void;
}

/** Message « nova-google:* » venu de l'appli (chaîne JSON ou objet), sinon null. */
export function parseDesktopMessage(data: unknown): DesktopMessage | null {
  let v: unknown = data;
  if (typeof v === 'string') {
    if (!v.startsWith('{') || v.length > 65536) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const t = (v as any).type;
  return typeof t === 'string' && t.startsWith('nova-google:') ? (v as DesktopMessage) : null;
}

/** L'appli Windows sait-elle faire la connexion Google ? (elle l'annonce dans __novaDesktop.features) */
export function desktopSupportsGoogle(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  const features = w.__novaDesktop?.features;
  return Array.isArray(features) && features.includes('google-login')
    && typeof w.chrome?.webview?.postMessage === 'function';
}

/** Canal page ↔ appli Windows (WebView2 : chrome.webview.postMessage / événements « message »). */
export function getDesktopTransport(): DesktopTransport | null {
  if (typeof window === 'undefined') return null;
  const wv = (window as any).chrome?.webview;
  if (!wv || typeof wv.postMessage !== 'function' || typeof wv.addEventListener !== 'function') return null;
  return {
    send: (msg) => wv.postMessage(JSON.stringify(msg)),
    subscribe: (fn) => {
      const h = (e: any) => { const m = parseDesktopMessage(e?.data); if (m) fn(m); };
      wv.addEventListener('message', h);
      return () => { try { wv.removeEventListener('message', h); } catch { /* */ } };
    },
  };
}

/** Adresse de retour attendue : 127.0.0.1 uniquement, chemin /cb et state de 256 bits. */
export function isLoopbackRedirect(url: unknown): url is string {
  return typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}\/cb\?nova_state=[A-Za-z0-9_-]{40,64}$/.test(url);
}

/** Identifiant d'essai : les réponses d'un essai précédent (ou d'ailleurs) sont ignorées. */
export function newAttemptId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** Message clair (et quoi faire) pour chaque échec. */
export function googleLoginErrorMessage(code: string | undefined, description?: string): string {
  switch (code) {
    case 'access_denied':
    case 'cancelled':
      return 'Connexion Google annulée. Tu peux réessayer, ou te connecter avec ton e-mail.';
    case 'timeout':
      return 'Connexion Google non terminée en 5 minutes. Clique à nouveau sur « Continuer avec Google ».';
    case 'expired':
      return 'Cette demande de connexion a expiré. Clique à nouveau sur « Continuer avec Google ».';
    case 'state':
      return 'Retour de connexion refusé (lien déjà utilisé ou trop ancien). Clique à nouveau sur « Continuer avec Google ».';
    case 'port':
      return 'Nova Studio n’a pas pu préparer la connexion Google (port local occupé). Redémarre Nova Studio, ou connecte-toi avec ton e-mail.';
    case 'no_app':
      return 'Nova Studio n’a pas répondu. Redémarre l’appli (ou mets-la à jour), ou connecte-toi avec ton e-mail.';
    case 'missing_tokens':
      return 'La réponse de Google est incomplète. Réessaie, ou connecte-toi avec ton e-mail.';
    case 'bad_url':
      return 'Adresse de connexion inattendue : connexion Google arrêtée par sécurité. Réessaie.';
    case 'network':
      return 'Pas de connexion Internet : vérifie le Wi-Fi et réessaie.';
    case 'auth_down':
      // Sonde de l'appli (desktop/google_login.py) : 402 du projet restreint, 5xx ou injoignable.
      // Avant : le navigateur s'ouvrait sur une page noire avec le JSON brut du 402.
      return AUTH_DOWN_MESSAGE;
    case 'session':
      return 'Google a bien répondu, mais ta session n’a pas pu être ouverte. Réessaie dans un instant.';
    default: {
      const d = (description || '').trim();
      return d
        ? `Connexion Google refusée : ${d}. Réessaie, ou connecte-toi avec ton e-mail.`
        : 'La connexion Google n’a pas abouti. Réessaie, ou connecte-toi avec ton e-mail.';
    }
  }
}

/** Jetons du message « result », ou erreur au message clair. */
export function sessionFromResult(msg: DesktopMessage): { access_token: string; refresh_token: string } {
  if (msg.ok === true && typeof msg.access_token === 'string' && typeof msg.refresh_token === 'string'
      && msg.access_token && msg.refresh_token) {
    return { access_token: msg.access_token, refresh_token: msg.refresh_token };
  }
  const code = msg.ok === true ? 'missing_tokens' : String(msg.error || '');
  const err = new Error(googleLoginErrorMessage(code, typeof msg.message === 'string' ? msg.message : ''));
  (err as any).code = code || 'unknown';
  throw err;
}

export type GooglePhase =
  | { phase: 'preparing' }
  | { phase: 'waiting'; timeoutS: number }
  | { phase: 'finishing' }
  | { phase: 'done'; user: { id: string; email: string } }
  | { phase: 'error'; code: string; message: string };

interface AuthLike {
  signInWithOAuth(args: any): Promise<{ data: { url?: string | null } | null; error: any }>;
  setSession(args: { access_token: string; refresh_token: string }): Promise<{ data: { user?: any; session?: any } | null; error: any }>;
}

export interface GoogleLoginController {
  attempt: string;
  /** Rouvre la page Google dans le navigateur (onglet fermé par erreur). */
  reopen(): void;
  /** Abandonne : le serveur local se ferme, les réponses tardives sont ignorées. */
  cancel(): void;
}

/**
 * Lance un essai de connexion Google. onPhase reçoit chaque étape ; l'essai se termine par
 * 'done' (session ouverte) ou 'error'. Une seule fin, jamais deux.
 */
export function startDesktopGoogleLogin(opts: {
  auth: AuthLike;
  transport: DesktopTransport;
  onPhase: (p: GooglePhase) => void;
  prepareTimeoutMs?: number;
  attemptId?: string;
}): GoogleLoginController {
  const { auth, transport, onPhase } = opts;
  const attempt = opts.attemptId || newAttemptId();
  let url: string | null = null;
  let finished = false;
  let unsubscribe: () => void = () => {};
  let prepareTimer: ReturnType<typeof setTimeout> | null = null;

  const end = (p: GooglePhase) => {
    if (finished) return;
    finished = true;
    if (prepareTimer) clearTimeout(prepareTimer);
    unsubscribe();
    onPhase(p);
  };
  const fail = (code: string, description?: string) =>
    end({ phase: 'error', code, message: googleLoginErrorMessage(code, description) });

  const onReady = async (msg: DesktopMessage) => {
    if (prepareTimer) { clearTimeout(prepareTimer); prepareTimer = null; }
    const redirectTo = msg.redirectTo;
    if (!isLoopbackRedirect(redirectTo)) { transport.send({ type: GOOGLE_MSG.cancel, attempt }); return fail('bad_url'); }
    try {
      const { data, error } = await auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (finished) return;
      if (error || !data?.url) throw error || new Error('URL de connexion Google absente');
      url = data.url;
    } catch (e: any) {
      transport.send({ type: GOOGLE_MSG.cancel, attempt });
      return fail(/fetch|network/i.test(String(e?.message || e)) ? 'network' : 'unknown', e?.message);
    }
    transport.send({ type: GOOGLE_MSG.open, attempt, url });
    onPhase({ phase: 'waiting', timeoutS: typeof msg.timeoutS === 'number' ? msg.timeoutS : 300 });
  };

  const onResult = async (msg: DesktopMessage) => {
    let tokens: { access_token: string; refresh_token: string };
    try { tokens = sessionFromResult(msg); } catch (e: any) {
      return end({ phase: 'error', code: e.code || 'unknown', message: e.message });
    }
    onPhase({ phase: 'finishing' });
    try {
      const { data, error } = await auth.setSession(tokens);
      const u = data?.user || data?.session?.user;
      if (error || !u?.id) throw error || new Error('session');
      end({ phase: 'done', user: { id: String(u.id), email: String(u.email || '') } });
    } catch (e: any) {
      fail(/fetch|network/i.test(String(e?.message || e)) ? 'network' : 'session');
    }
  };

  unsubscribe = transport.subscribe((msg) => {
    if (finished || msg.attempt !== attempt) return;  // réponse d'un autre essai : ignorée
    if (msg.type === GOOGLE_MSG.ready) void onReady(msg);
    else if (msg.type === GOOGLE_MSG.result) void onResult(msg);
  });

  onPhase({ phase: 'preparing' });
  prepareTimer = setTimeout(() => fail('no_app'), opts.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS);
  transport.send({ type: GOOGLE_MSG.prepare, attempt });

  return {
    attempt,
    reopen: () => { if (!finished && url) transport.send({ type: GOOGLE_MSG.open, attempt, url }); },
    cancel: () => {
      if (finished) return;
      transport.send({ type: GOOGLE_MSG.cancel, attempt });
      finished = true;
      if (prepareTimer) clearTimeout(prepareTimer);
      unsubscribe();
    },
  };
}
