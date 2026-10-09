// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_DOWN_MESSAGE, NO_INTERNET_MESSAGE, authServiceMessage, isAuthServiceDown } from '../utils/authStatus';

afterEach(() => { vi.restoreAllMocks(); });

describe('service de connexion restreint ou injoignable', () => {
  it('402 du projet restreint (quota), 5xx : service en cause', () => {
    expect(isAuthServiceDown({ status: 402, message: 'x' })).toBe(true);
    expect(isAuthServiceDown({ status: 502, message: 'Bad Gateway' })).toBe(true);
    expect(isAuthServiceDown(new Error('Service for this project is restricted due to the following violations: exceed_egress_quota, exceed_cached_egress_quota'))).toBe(true);
    expect(isAuthServiceDown({ status: 400, message: 'Invalid login credentials' })).toBe(false);
    expect(isAuthServiceDown({ status: 429, message: 'rate limit' })).toBe(false);
  });

  it('message clair (et non le JSON ou l\'anglais du serveur)', () => {
    expect(authServiceMessage({ status: 402, message: '{"message":"Service for this project is restricted"}' })).toBe(AUTH_DOWN_MESSAGE);
    expect(AUTH_DOWN_MESSAGE).toBe('Le service de connexion est momentanément indisponible. Réessaie dans quelques minutes ; tes projets locaux restent accessibles.');
  });

  it('réseau en échec : service injoignable si l\'appareil est en ligne (DNS), sinon pas d\'Internet', () => {
    const dns = new TypeError('Failed to fetch');
    expect(authServiceMessage(dns, true)).toBe(AUTH_DOWN_MESSAGE);
    expect(authServiceMessage(dns, false)).toBe(NO_INTERNET_MESSAGE);
    expect(authServiceMessage({ name: 'AuthRetryableFetchError', status: 0, message: '{}' }, true)).toBe(AUTH_DOWN_MESSAGE);
  });

  it('erreur d\'identifiants : laissée aux messages habituels', () => {
    expect(authServiceMessage({ status: 400, message: 'Invalid login credentials' })).toBeNull();
  });
});

describe('connexion e-mail du site (AuthService) quand le service est restreint', () => {
  it('402 → message clair, pas d\'exception', async () => {
    vi.resetModules();
    vi.doMock('../services/supabase', () => ({
      isSupabaseConfigured: () => true,
      supabase: {
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signInWithPassword: async () => ({ data: { user: null, session: null }, error: Object.assign(new Error('Service for this project is restricted due to the following violations: exceed_egress_quota'), { status: 402, name: 'AuthApiError' }) }),
          signUp: async () => ({ data: null, error: Object.assign(new Error('Bad Gateway'), { status: 502 }) }),
        },
      },
      catalogSupabase: {},
    }));
    vi.doMock('../services/SupabaseManager', () => ({ supabaseManager: { resetPasswordForEmail: async () => { throw new TypeError('Failed to fetch'); } } }));
    const { authService } = await import('../services/AuthService');
    const r = await authService.login('a@b.c', 'secret12');
    expect(r).toEqual({ success: false, message: AUTH_DOWN_MESSAGE });
    expect((await authService.register('a@b.c', 'secret12', 'x')).message).toBe(AUTH_DOWN_MESSAGE);
    expect((await authService.sendPasswordReset('a@b.c')).message).toBe(AUTH_DOWN_MESSAGE);
    vi.doUnmock('../services/supabase');
    vi.doUnmock('../services/SupabaseManager');
  });
});
