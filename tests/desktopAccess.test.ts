// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Appli Windows : porte de connexion (compte obligatoire) et paiement ouvert dans le navigateur. */

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { functions: { invoke: h.invoke } } }));

import {
  ACCESS_CACHE_KEY, OFFLINE_GRACE_MS, decideGate, friendlyAuthError, isNetworkError, readAccessCache, writeAccessCache,
} from '../utils/desktopAccess';
import { openCheckout } from '../services/Billing';

const U = { id: 'u1', email: 'a@b.c' };
const NOW = 1_800_000_000_000;

beforeEach(() => { localStorage.clear(); h.invoke.mockReset(); delete (window as any).__novaDesktop; });
afterEach(() => { delete (window as any).__novaDesktop; });

describe('decideGate', () => {
  it('connecté (vérifié par le serveur) : le studio s\'ouvre', () => {
    expect(decideGate(U, U, null, NOW)).toEqual({ state: 'open', email: 'a@b.c', offline: false });
  });
  it('le serveur dit « pas connecté » : porte, même avec une ancienne vérification', () => {
    expect(decideGate(null, U, { userId: 'u1', email: 'a@b.c', checkedAt: NOW - 1000 }, NOW)).toEqual({ state: 'signed_out' });
  });
  it('hors ligne sans session locale : porte de connexion', () => {
    expect(decideGate('network', null, null, NOW)).toEqual({ state: 'signed_out' });
  });
  it('hors ligne, vérifié il y a moins de 7 jours : ouvert (mode hors ligne)', () => {
    const cache = { userId: 'u1', email: 'a@b.c', checkedAt: NOW - (OFFLINE_GRACE_MS - 60_000) };
    expect(decideGate('network', U, cache, NOW)).toEqual({ state: 'open', email: 'a@b.c', offline: true });
  });
  it('hors ligne, vérifié il y a plus de 7 jours : connexion Internet demandée', () => {
    const cache = { userId: 'u1', email: 'a@b.c', checkedAt: NOW - OFFLINE_GRACE_MS - 1 };
    expect(decideGate('network', U, cache, NOW)).toEqual({ state: 'offline_expired', email: 'a@b.c' });
  });
  it('hors ligne : la vérification d\'un autre compte ne compte pas', () => {
    const cache = { userId: 'autre', email: 'x@y.z', checkedAt: NOW - 1000 };
    expect(decideGate('network', U, cache, NOW).state).toBe('offline_expired');
  });
  it('date de vérification dans le futur (horloge trafiquée) : refusée', () => {
    const cache = { userId: 'u1', email: 'a@b.c', checkedAt: NOW + 3600_000 };
    expect(decideGate('network', U, cache, NOW).state).toBe('offline_expired');
  });
});

describe('cache de vérification', () => {
  it('écrit, relit, efface', () => {
    expect(readAccessCache()).toBeNull();
    writeAccessCache({ userId: 'u1', email: 'a@b.c', checkedAt: 5 });
    expect(readAccessCache()).toEqual({ userId: 'u1', email: 'a@b.c', checkedAt: 5 });
    writeAccessCache(null);
    expect(localStorage.getItem(ACCESS_CACHE_KEY)).toBeNull();
  });
  it('valeur abîmée : ignorée', () => {
    localStorage.setItem(ACCESS_CACHE_KEY, '{pas du json');
    expect(readAccessCache()).toBeNull();
    localStorage.setItem(ACCESS_CACHE_KEY, JSON.stringify({ userId: 1 }));
    expect(readAccessCache()).toBeNull();
  });
});

describe('messages', () => {
  it('erreurs Supabase en français', () => {
    expect(friendlyAuthError('Invalid login credentials')).toMatch(/incorrect/);
    expect(friendlyAuthError('Email not confirmed')).toMatch(/confirmé/);
    expect(friendlyAuthError('User already registered')).toMatch(/existe déjà/);
    // Réseau en échec alors que l'appareil est en ligne : c'est le service (DNS, panne), pas le Wi-Fi.
    expect(friendlyAuthError('Failed to fetch')).toMatch(/service de connexion est momentanément indisponible/);
    const off = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(friendlyAuthError('Failed to fetch')).toMatch(/Internet/);
    off.mockRestore();
  });
  it('service de connexion restreint (402 du quota Supabase) : message clair, jamais le JSON brut', () => {
    const e402 = Object.assign(new Error('Service for this project is restricted due to the following violations: exceed_egress_quota'), { status: 402 });
    expect(friendlyAuthError(e402)).toBe('Le service de connexion est momentanément indisponible. Réessaie dans quelques minutes ; tes projets locaux restent accessibles.');
    expect(friendlyAuthError(Object.assign(new Error('upstream'), { status: 503 }))).toMatch(/momentanément indisponible/);
    expect(friendlyAuthError('{"message":"Service for this project is restricted"}')).toMatch(/momentanément indisponible/);
    expect(friendlyAuthError(Object.assign(new Error('Invalid login credentials'), { status: 400 }))).toMatch(/incorrect/);
  });
  it('erreur réseau reconnue', () => {
    expect(isNetworkError({ name: 'AuthRetryableFetchError', message: '' })).toBe(true);
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError({ message: 'invalid JWT', status: 401 })).toBe(false);
  });
});

describe('paiement depuis l\'appli Windows', () => {
  it('ouvre directement la page Stripe (le navigateur de l\'ordinateur), sans onglet vide', async () => {
    (window as any).__novaDesktop = { version: '1.1.3' };
    window.history.replaceState(null, '', '/?x=1');
    h.invoke.mockResolvedValue({ data: { url: 'https://checkout.stripe.com/c/pay/cs_test_1', session_id: 'cs_test_1' }, error: null });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(openCheckout('export_voices', { project_key: 'proj-123' })).resolves.toBe('cs_test_1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1', '_blank');
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', {
      body: { action: 'checkout', product: 'export_voices', return_url: `${window.location.origin}/`, project_key: 'proj-123' },
    });
  });
  it('erreur serveur : aucune fenêtre ouverte, erreur remontée', async () => {
    (window as any).__novaDesktop = { version: '1.1.3' };
    h.invoke.mockResolvedValue({ data: null, error: { message: 'Produit inconnu' } });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(openCheckout('export_voices', { project_key: 'proj-123' })).rejects.toThrow('Produit inconnu');
    expect(open).not.toHaveBeenCalled();
  });
});
