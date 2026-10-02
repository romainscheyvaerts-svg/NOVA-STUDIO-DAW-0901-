// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Paiements : la fonction nova-billing du site est simulée. */

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { functions: { invoke: h.invoke } } }));

import {
  billingStatus, hasPlan, isExportVoicesUnlocked, markExportVoicesUnlocked, openCheckout, spendExportCredit, waitPaid,
} from '../services/Billing';

const ok = (data: unknown) => ({ data, error: null });
const ko = (message: string, body?: unknown) => ({
  data: null,
  error: { message, context: body === undefined ? undefined : { json: async () => body } },
});

beforeEach(() => { h.invoke.mockReset(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('hasPlan', () => {
  it('admin : tous les plans', () => {
    expect(hasPlan({ plans: [], admin: true }, 'collab')).toBe(true);
    expect(hasPlan({ plans: [], admin: true }, 'beatmaker')).toBe(true);
  });
  it('plan présent / absent', () => {
    const st = { plans: [{ plan: 'collab' }], admin: false };
    expect(hasPlan(st, 'collab')).toBe(true);
    expect(hasPlan(st, 'beatmaker')).toBe(false);
    expect(hasPlan({ plans: [], admin: false }, 'collab')).toBe(false);
  });
});

describe('isExportVoicesUnlocked : toujours confirmé par le serveur', () => {
  it('appel nova-billing / export_unlocked avec la clé du projet', async () => {
    h.invoke.mockResolvedValue(ok({ unlocked: false }));
    expect(await isExportVoicesUnlocked('proj-a')).toBe(false);
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', { body: { action: 'export_unlocked', project_key: 'proj-a' } });
  });

  it('refus : pas mis en cache, on redemande au serveur', async () => {
    h.invoke.mockResolvedValue(ok({ unlocked: false }));
    await isExportVoicesUnlocked('proj-b');
    await isExportVoicesUnlocked('proj-b');
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it('débloqué : mis en cache mémoire (un seul appel)', async () => {
    h.invoke.mockResolvedValue(ok({ unlocked: true }));
    expect(await isExportVoicesUnlocked('proj-c')).toBe(true);
    expect(await isExportVoicesUnlocked('proj-c')).toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('une valeur dans localStorage ne débloque rien', async () => {
    for (const k of ['nova_export_unlocked', 'nova_export_unlocked_proj-d', 'export_voices_proj-d', 'proj-d']) localStorage.setItem(k, '1');
    localStorage.setItem('nova_export_voices_unlocked', JSON.stringify(['proj-d']));
    h.invoke.mockResolvedValue(ok({ unlocked: false }));
    expect(await isExportVoicesUnlocked('proj-d')).toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('erreur serveur / réseau : verrouillé, et rien en cache', async () => {
    h.invoke.mockResolvedValueOnce(ko('500'));
    expect(await isExportVoicesUnlocked('proj-e')).toBe(false);
    h.invoke.mockRejectedValueOnce(new Error('offline'));
    expect(await isExportVoicesUnlocked('proj-e')).toBe(false);
    h.invoke.mockResolvedValueOnce(ok({ unlocked: true }));
    expect(await isExportVoicesUnlocked('proj-e')).toBe(true);
  });

  it('markExportVoicesUnlocked : débloque pour la session sans appel serveur', async () => {
    markExportVoicesUnlocked('proj-f');
    expect(await isExportVoicesUnlocked('proj-f')).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
    // Rien d'écrit dans le navigateur
    expect(localStorage.length).toBe(0);
  });
});

describe('waitPaid', () => {
  it('vérifie toutes les 3 s jusqu\'au paiement', async () => {
    vi.useFakeTimers();
    h.invoke
      .mockResolvedValueOnce(ok({ paid: false }))
      .mockResolvedValueOnce(ok({ paid: false }))
      .mockResolvedValueOnce(ok({ paid: true }));
    const p = waitPaid('cs_1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', { body: { action: 'verify', session_id: 'cs_1' } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });

  it('annulation : s\'arrête au prochain tour, sans nouvel appel', async () => {
    vi.useFakeTimers();
    h.invoke.mockResolvedValue(ok({ paid: false }));
    let cancelled = false;
    const p = waitPaid('cs_2', () => cancelled);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('déjà annulé : aucun appel', async () => {
    await expect(waitPaid('cs_3', () => true)).resolves.toBe(false);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('erreur réseau : on réessaie', async () => {
    vi.useFakeTimers();
    h.invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok({ paid: true }));
    const p = waitPaid('cs_4');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe(true);
  });

  it('abandon après 20 minutes', async () => {
    vi.useFakeTimers();
    h.invoke.mockResolvedValue(ok({ paid: false }));
    const p = waitPaid('cs_5');
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 3000);
    await expect(p).resolves.toBe(false);
    expect(h.invoke.mock.calls.length).toBeGreaterThanOrEqual(400);
    expect(h.invoke.mock.calls.length).toBeLessThanOrEqual(401);
  });
});

describe('openCheckout / billingStatus / spendExportCredit', () => {
  it('ouvre l\'onglet pendant le clic puis y charge Stripe ; URL de retour sans paramètres', async () => {
    window.history.replaceState(null, '', '/studio?session=abc#x');
    const tab = { location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    h.invoke.mockResolvedValue(ok({ url: 'https://checkout.stripe.com/c/1', session_id: 'cs_9' }));
    await expect(openCheckout('collab', { project_key: 'p' })).resolves.toBe('cs_9');
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('https://checkout.stripe.com/c/1');
    const body = h.invoke.mock.calls[0][1].body;
    expect(body).toMatchObject({ action: 'checkout', product: 'collab', project_key: 'p' });
    expect(body.return_url).toBe(`${window.location.origin}/studio`);
  });

  it('échec : l\'onglet vide est refermé et l\'erreur du serveur remonte', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    h.invoke.mockResolvedValue(ko('Edge Function returned a non-2xx status code', { error: 'Produit inconnu' }));
    await expect(openCheckout('beatmaker')).rejects.toThrow('Produit inconnu');
    expect(tab.close).toHaveBeenCalled();
  });

  it('billingStatus : valeur sûre en cas d\'erreur', async () => {
    h.invoke.mockResolvedValue(ko('down'));
    await expect(billingStatus()).resolves.toEqual({ plans: [], admin: false });
  });

  it('spendExportCredit : verrouillé en cas d\'erreur', async () => {
    h.invoke.mockRejectedValue(new Error('offline'));
    await expect(spendExportCredit('p')).resolves.toEqual({ unlocked: false, remaining: 0 });
  });
});
