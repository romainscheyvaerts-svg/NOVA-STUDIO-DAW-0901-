// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_MSG, desktopSupportsGoogle, getDesktopTransport, googleLoginErrorMessage, isLoopbackRedirect,
  parseDesktopMessage, sessionFromResult, startDesktopGoogleLogin,
  type DesktopMessage, type GooglePhase,
} from '../utils/desktopGoogleLogin';

/** Appli Windows : connexion Google par le navigateur par défaut, retour sur 127.0.0.1. */

const STATE = 'A'.repeat(43);
const REDIRECT = `http://127.0.0.1:48817/cb?nova_state=${STATE}`;
const AUTH_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(REDIRECT);

function fakeTransport() {
  const sent: Record<string, any>[] = [];
  let listener: ((m: DesktopMessage) => void) | null = null;
  return {
    sent,
    transport: {
      send: (m: Record<string, unknown>) => { sent.push(m); },
      subscribe: (fn: (m: DesktopMessage) => void) => { listener = fn; return () => { listener = null; }; },
    },
    emit: (m: DesktopMessage) => listener?.(m),
    get subscribed() { return listener !== null; },
  };
}

function fakeAuth(over: Partial<{ url: string | null; oauthError: any; sessionError: any; user: any }> = {}) {
  return {
    signInWithOAuth: vi.fn(async () => ({
      data: { url: over.url === undefined ? AUTH_URL : over.url }, error: over.oauthError ?? null,
    })),
    setSession: vi.fn(async () => ({
      data: { user: over.user === undefined ? { id: 'u1', email: 'a@b.c' } : over.user, session: {} },
      error: over.sessionError ?? null,
    })),
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

function start(auth = fakeAuth(), t = fakeTransport(), prepareTimeoutMs = 8000) {
  const phases: GooglePhase[] = [];
  const ctrl = startDesktopGoogleLogin({ auth, transport: t.transport, onPhase: p => phases.push(p), prepareTimeoutMs, attemptId: 'essai1' });
  return { auth, t, phases, ctrl };
}

afterEach(() => { vi.useRealTimers(); delete (window as any).__novaDesktop; delete (window as any).chrome; });

describe('lecture des messages de l\'appli', () => {
  it('accepte les messages nova-google (chaîne JSON ou objet)', () => {
    expect(parseDesktopMessage('{"type":"nova-google:ready","attempt":"x"}')).toEqual({ type: 'nova-google:ready', attempt: 'x' });
    expect(parseDesktopMessage({ type: 'nova-google:result', ok: true })).toEqual({ type: 'nova-google:result', ok: true });
  });
  it('ignore le reste (autres messages, JSON invalide, valeurs vides)', () => {
    expect(parseDesktopMessage('nova-desktop:apply-update')).toBeNull();
    expect(parseDesktopMessage('{pas du json')).toBeNull();
    expect(parseDesktopMessage('{"type":"autre"}')).toBeNull();
    expect(parseDesktopMessage(null)).toBeNull();
    expect(parseDesktopMessage(42)).toBeNull();
  });
});

describe('adresse de retour (state)', () => {
  it('127.0.0.1, chemin /cb et state long : acceptée', () => {
    expect(isLoopbackRedirect(REDIRECT)).toBe(true);
  });
  it('tout le reste est refusé', () => {
    expect(isLoopbackRedirect(`http://localhost:48817/cb?nova_state=${STATE}`)).toBe(false);
    expect(isLoopbackRedirect(`https://127.0.0.1:48817/cb?nova_state=${STATE}`)).toBe(false);
    expect(isLoopbackRedirect(`http://127.0.0.1:48817/cb?nova_state=court`)).toBe(false);
    expect(isLoopbackRedirect(`http://127.0.0.1:48817/autre?nova_state=${STATE}`)).toBe(false);
    expect(isLoopbackRedirect(`http://evil.com/?x=http://127.0.0.1:48817/cb?nova_state=${STATE}`)).toBe(false);
    expect(isLoopbackRedirect(undefined)).toBe(false);
  });
});

describe('jetons et erreurs', () => {
  it('lit les jetons d\'un retour réussi', () => {
    expect(sessionFromResult({ type: GOOGLE_MSG.result, ok: true, access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
      .toEqual({ access_token: 'at', refresh_token: 'rt' });
  });
  it('retour « réussi » sans jetons : erreur claire', () => {
    expect(() => sessionFromResult({ type: GOOGLE_MSG.result, ok: true, access_token: 'at' })).toThrow(/incomplète/);
  });
  it('chaque échec a un message qui dit quoi faire', () => {
    expect(googleLoginErrorMessage('access_denied')).toMatch(/annulée.*e-mail/);
    expect(googleLoginErrorMessage('timeout')).toMatch(/5 minutes.*Continuer avec Google/);
    expect(googleLoginErrorMessage('state')).toMatch(/refusé/);
    expect(googleLoginErrorMessage('port')).toMatch(/Redémarre Nova Studio/);
    expect(googleLoginErrorMessage('no_app')).toMatch(/mets-la à jour/);
    expect(googleLoginErrorMessage('oauth_error', 'Unverified email')).toMatch(/Unverified email/);
    expect(googleLoginErrorMessage(undefined)).toMatch(/Réessaie/);
  });
});

describe('déroulé complet', () => {
  it('prepare → ready → URL ouverte dans le navigateur → jetons → setSession → porte ouverte', async () => {
    const { auth, t, phases } = start();
    expect(t.sent[0]).toEqual({ type: GOOGLE_MSG.prepare, attempt: 'essai1' });
    expect(phases).toEqual([{ phase: 'preparing' }]);

    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: REDIRECT, timeoutS: 300 });
    await flush();
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google', options: { redirectTo: REDIRECT, skipBrowserRedirect: true },
    });
    expect(t.sent[1]).toEqual({ type: GOOGLE_MSG.open, attempt: 'essai1', url: AUTH_URL });
    expect(phases.at(-1)).toEqual({ phase: 'waiting', timeoutS: 300 });

    t.emit({ type: GOOGLE_MSG.result, attempt: 'essai1', ok: true, access_token: 'at', refresh_token: 'rt' });
    await flush();
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' });
    expect(phases.at(-2)).toEqual({ phase: 'finishing' });
    expect(phases.at(-1)).toEqual({ phase: 'done', user: { id: 'u1', email: 'a@b.c' } });
    expect(t.subscribed).toBe(false);
  });

  it('les réponses d\'un autre essai sont ignorées (pas de session injectée)', async () => {
    const { auth, t, phases } = start();
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'autre', redirectTo: REDIRECT });
    t.emit({ type: GOOGLE_MSG.result, attempt: 'autre', ok: true, access_token: 'x', refresh_token: 'y' });
    await flush();
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(phases).toEqual([{ phase: 'preparing' }]);
  });

  it('adresse de retour suspecte : on annule sans rien ouvrir', async () => {
    const { auth, t, phases } = start();
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: 'https://evil.example/cb' });
    await flush();
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
    expect(t.sent.at(-1)).toEqual({ type: GOOGLE_MSG.cancel, attempt: 'essai1' });
    expect(phases.at(-1)).toMatchObject({ phase: 'error', code: 'bad_url' });
  });

  it('annulation par Google : message clair, aucune session', async () => {
    const { auth, t, phases } = start();
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: REDIRECT });
    await flush();
    t.emit({ type: GOOGLE_MSG.result, attempt: 'essai1', ok: false, error: 'access_denied' });
    await flush();
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(phases.at(-1)).toMatchObject({ phase: 'error', code: 'access_denied', message: expect.stringMatching(/annulée/) });
  });

  it('délai de 5 min dépassé (côté appli) : message clair', async () => {
    const { t, phases } = start();
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: REDIRECT });
    await flush();
    t.emit({ type: GOOGLE_MSG.result, attempt: 'essai1', ok: false, error: 'timeout' });
    await flush();
    expect(phases.at(-1)).toMatchObject({ phase: 'error', code: 'timeout' });
  });

  it('jetons refusés par Supabase : erreur « session », pas de porte ouverte', async () => {
    const { t, phases } = start(fakeAuth({ sessionError: { message: 'Invalid JWT' }, user: null }));
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: REDIRECT });
    await flush();
    t.emit({ type: GOOGLE_MSG.result, attempt: 'essai1', ok: true, access_token: 'at', refresh_token: 'rt' });
    await flush();
    expect(phases.at(-1)).toMatchObject({ phase: 'error', code: 'session' });
  });

  it('appli trop ancienne (pas de réponse au prepare) : message après le délai', async () => {
    vi.useFakeTimers();
    const { phases } = start(fakeAuth(), fakeTransport(), 8000);
    vi.advanceTimersByTime(8001);
    expect(phases.at(-1)).toMatchObject({ phase: 'error', code: 'no_app' });
  });

  it('Annuler : prévient l\'appli et ignore une réponse tardive', async () => {
    const { auth, t, phases, ctrl } = start();
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: REDIRECT });
    await flush();
    ctrl.cancel();
    expect(t.sent.at(-1)).toEqual({ type: GOOGLE_MSG.cancel, attempt: 'essai1' });
    t.emit({ type: GOOGLE_MSG.result, attempt: 'essai1', ok: true, access_token: 'at', refresh_token: 'rt' });
    await flush();
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(phases.at(-1)).toMatchObject({ phase: 'waiting' });
  });

  it('Rouvrir la page Google : la même URL est renvoyée à l\'appli', async () => {
    const { t, ctrl } = start();
    t.emit({ type: GOOGLE_MSG.ready, attempt: 'essai1', redirectTo: REDIRECT });
    await flush();
    ctrl.reopen();
    expect(t.sent.filter(m => m.type === GOOGLE_MSG.open)).toHaveLength(2);
    expect(t.sent.at(-1)).toEqual({ type: GOOGLE_MSG.open, attempt: 'essai1', url: AUTH_URL });
  });
});

describe('détection de l\'appli', () => {
  beforeEach(() => { delete (window as any).__novaDesktop; delete (window as any).chrome; });

  it('site web (navigateur normal) : pas de bouton Google de l\'appli', () => {
    expect(desktopSupportsGoogle()).toBe(false);
    expect(getDesktopTransport()).toBeNull();
  });
  it('ancienne appli sans la fonction : pas de bouton', () => {
    (window as any).__novaDesktop = { version: '1.2.0' };
    (window as any).chrome = { webview: { postMessage() {}, addEventListener() {}, removeEventListener() {} } };
    expect(desktopSupportsGoogle()).toBe(false);
  });
  it('appli à jour : bouton + messages JSON via chrome.webview', () => {
    const posted: string[] = [];
    const listeners: any[] = [];
    (window as any).__novaDesktop = { version: '1.3.0', features: ['google-login'] };
    (window as any).chrome = { webview: {
      postMessage: (m: string) => posted.push(m),
      addEventListener: (_: string, h: any) => listeners.push(h),
      removeEventListener: () => {},
    } };
    expect(desktopSupportsGoogle()).toBe(true);
    const tr = getDesktopTransport()!;
    const got: DesktopMessage[] = [];
    tr.subscribe(m => got.push(m));
    tr.send({ type: GOOGLE_MSG.prepare, attempt: 'a' });
    expect(JSON.parse(posted[0])).toEqual({ type: GOOGLE_MSG.prepare, attempt: 'a' });
    listeners[0]({ data: '{"type":"nova-google:ready","attempt":"a"}' });
    listeners[0]({ data: 'nova-desktop:apply-update' });
    expect(got).toEqual([{ type: 'nova-google:ready', attempt: 'a' }]);
  });
});
