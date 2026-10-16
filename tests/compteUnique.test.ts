// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountForBar, isMakeMusicDisplay } from '../utils/accountDisplay';
import type { User } from '../types';

/**
 * Un seul compte affiché partout : la barre du haut montrait « Se connecter » alors que le compte
 * Make Music (paiements, collaboration, appli Windows) était connecté ; « Se connecter » (ancien
 * projet) refusait les identifiants de studiomakemusic.com.
 */

const guest: User = { id: 'guest', email: 'guest@novastudio.app', username: 'Guest User', isVerified: true, plan: 'FREE', owned_instruments: [] };
const main: User = { id: 'u-main', email: 'ancien@exemple.be', username: 'ancien', isVerified: true, plan: 'FREE' };

describe('accountForBar', () => {
  it('compte principal connecté : c\'est lui qui est affiché', () => {
    expect(accountForBar(main, { id: 'mm1', email: 'x@y.be' })).toBe(main);
  });
  it('invité + compte Make Music connecté : le compte Make Music est affiché (plus de « Se connecter »)', () => {
    const u = accountForBar(guest, { id: 'mm1', email: 'artiste@exemple.be' })!;
    expect(u.id).toBe('mm:mm1');
    expect(u.username).toBe('artiste');
    expect(u.email).toBe('artiste@exemple.be');
    expect(isMakeMusicDisplay(u)).toBe(true);
    expect(isMakeMusicDisplay(main)).toBe(false);
  });
  it('aucun compte : invité (ou rien après déconnexion), comme avant', () => {
    expect(accountForBar(guest, null)).toBe(guest);
    expect(accountForBar(null, null)).toBeNull();
  });
});

describe('« Se connecter » : les mêmes identifiants ouvrent aussi le compte Make Music', () => {
  afterEach(() => { vi.doUnmock('../services/supabase'); vi.doUnmock('../services/SupabaseManager'); vi.resetModules(); });
  const load = async (mainOk: boolean, mmOk: boolean) => {
    vi.resetModules();
    const calls = { main: 0, mm: 0, mmArgs: null as any };
    const ok = (id: string) => ({ data: { user: { id, email: 'a@b.c', user_metadata: {} }, session: {} }, error: null });
    const ko = () => ({ data: { user: null, session: null }, error: Object.assign(new Error('Invalid login credentials'), { status: 400 }) });
    vi.doMock('../services/supabase', () => ({
      isSupabaseConfigured: () => true,
      supabase: { auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithPassword: async () => { calls.main++; return mainOk ? ok('u-main') : ko(); },
      } },
      catalogSupabase: { auth: { signInWithPassword: async (a: any) => { calls.mm++; calls.mmArgs = a; return mmOk ? ok('u-mm') : ko(); } } },
    }));
    vi.doMock('../services/SupabaseManager', () => ({ supabaseManager: {} }));
    const { authService } = await import('../services/AuthService');
    return { authService, calls };
  };

  it('compte Make Music seulement (créé sur studiomakemusic.com) : connexion réussie, sans compte principal', async () => {
    const { authService, calls } = await load(false, true);
    const r = await authService.login(' a@b.c ', 'secret12');
    expect(r).toEqual({ success: true, makeMusicOnly: true });
    expect(calls.mm).toBe(1);
    expect(calls.mmArgs).toEqual({ email: 'a@b.c', password: 'secret12' });
  });
  it('les deux comptes : connecté aux deux, le compte principal est rendu', async () => {
    const { authService, calls } = await load(true, true);
    const r = await authService.login('a@b.c', 'secret12');
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe('u-main');
    expect(calls).toMatchObject({ main: 1, mm: 1 });
  });
  it('mauvais identifiants partout : erreur comme avant', async () => {
    const { authService } = await load(false, false);
    const r = await authService.login('a@b.c', 'faux');
    expect(r.success).toBe(false);
    expect(r.message).toBeTruthy();
  });
});
