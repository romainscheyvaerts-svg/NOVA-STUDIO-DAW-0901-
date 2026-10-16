// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

/**
 * « Gérer mon abonnement » (portail client Stripe, action « portal » de nova-billing, simulée) :
 * montré seulement à un abonné Stripe, onglet ouvert sur le portail, message clair sinon.
 */

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { functions: { invoke: h.invoke } } }));

import { openBillingPortal, type BillingStatus } from '../services/Billing';
import {
  cachedBillingStatus, canManageSubscription, knownSubscriber, portalErrorMessage, rememberBillingStatus, resetBillingStatusCache, subscriptionLabel,
} from '../utils/billingPortal';
import ManageSubscription from '../components/ManageSubscription';

const ok = (data: unknown) => ({ data, error: null });
const ko = (message: string, body?: unknown) => ({ data: null, error: { message, context: body === undefined ? undefined : { json: async () => body } } });

const pro = (over: Partial<NonNullable<BillingStatus['pro']>> = {}): BillingStatus['pro'] => ({
  active: true, source: 'abonnement', paid: true, interval: 'month', until: '2026-11-16T00:00:00Z',
  cadeau: { active: false, until: null, days_left: 0, total_days: 0, sources: [] }, ...over,
});
const abonne: BillingStatus = { plans: [{ plan: 'nova_pro', status: 'active', current_period_end: null, interval: 'month' }], admin: false, pro: pro() };
const cadeau: BillingStatus = { plans: [], admin: false, pro: pro({ source: 'cadeau', paid: false, interval: null }) };
const admin: BillingStatus = { plans: [], admin: true, pro: pro({ source: 'admin', paid: false, interval: null }) };
const gratuit: BillingStatus = { plans: [], admin: false, pro: null };

const STRIPE_SANS_PORTAIL = 'No configuration provided and your live mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in live mode at https://dashboard.stripe.com/settings/billing/portal.';

beforeEach(() => { h.invoke.mockReset(); resetBillingStatusCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('qui voit « Gérer mon abonnement »', () => {
  it('abonné Nova Pro payé (mensuel / annuel) : oui', () => {
    expect(canManageSubscription(abonne)).toBe(true);
    expect(canManageSubscription({ plans: [], pro: pro({ interval: 'year' }) })).toBe(true);
  });
  it('ancien abonnement Stripe encore en cours (même paiement en retard) : oui', () => {
    expect(canManageSubscription({ plans: [{ plan: 'collab', status: 'past_due', current_period_end: null }], pro: null })).toBe(true);
    expect(canManageSubscription({ plans: [{ plan: 'collab', status: 'canceled', current_period_end: null }], pro: null })).toBe(false);
  });
  it('Nova Pro offert, admin, gratuit, statut inconnu : non (rien à gérer chez Stripe)', () => {
    expect(canManageSubscription(cadeau)).toBe(false);
    expect(canManageSubscription(admin)).toBe(false);
    expect(canManageSubscription(gratuit)).toBe(false);
    expect(canManageSubscription(null)).toBe(false);
  });
  it('libellé de la formule', () => {
    expect(subscriptionLabel(abonne)).toBe('Nova Pro mensuel');
    expect(subscriptionLabel({ plans: [], pro: pro({ interval: 'year' }) })).toBe('Nova Pro annuel');
  });
});

describe('messages clairs quand le portail ne s\'ouvre pas', () => {
  it('portail client pas activé dans Stripe', () => {
    const m = portalErrorMessage(new Error(STRIPE_SANS_PORTAIL));
    expect(m).toMatch(/pas encore ouverte/);
    expect(m).toMatch(/continue normalement/);
    expect(m).not.toMatch(/configuration/i);
  });
  it('pas connecté, serveur pas à jour, réseau, adresse refusée, autre', () => {
    expect(portalErrorMessage(new Error("Connecte-toi d'abord"))).toMatch(/Connecte-toi à ton compte Make Music/);
    expect(portalErrorMessage(new Error('Action inconnue'))).toMatch(/pas encore disponible sur le serveur/);
    expect(portalErrorMessage(new Error('Failed to fetch'))).toMatch(/Vérifie ta connexion/);
    expect(portalErrorMessage(new Error('Adresse de retour refusée'))).toMatch(/studiomakemusic\.com/);
    expect(portalErrorMessage(new Error('boum'))).toMatch(/Réessaie dans un instant/);
  });
});

describe('openBillingPortal', () => {
  it('ouvre le portail dans un nouvel onglet (action « portal » + adresse de retour)', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as any);
    h.invoke.mockResolvedValue(ok({ url: 'https://billing.stripe.com/p/session/test_123' }));
    await openBillingPortal();
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', { body: { action: 'portal', return_url: expect.stringMatching(/^http/) } });
    expect(tab.location.href).toBe('https://billing.stripe.com/p/session/test_123');
    expect(tab.close).not.toHaveBeenCalled();
  });
  it('erreur : l\'onglet vide est refermé et l\'erreur remonte', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as any);
    h.invoke.mockResolvedValue(ko('Edge Function returned a non-2xx status code', { error: STRIPE_SANS_PORTAIL }));
    await expect(openBillingPortal()).rejects.toThrow(/customer portal settings/);
    expect(tab.close).toHaveBeenCalled();
  });
});

describe('statut gardé quelques minutes (menu du compte)', () => {
  it('un seul appel au serveur pendant 5 min, par compte', async () => {
    const load = vi.fn(async () => abonne);
    await cachedBillingStatus('u1', load, 1000);
    await cachedBillingStatus('u1', load, 1000 + 60_000);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedBillingStatus('u1', load, 1000 + 6 * 60_000);
    await cachedBillingStatus('u2', load, 1000 + 6 * 60_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('palette Ctrl+K : seulement pour l\'abonné connu', () => {
    expect(knownSubscriber()).toBe(false);
    rememberBillingStatus('u1', abonne);
    expect(knownSubscriber()).toBe(true);
    rememberBillingStatus('u1', cadeau);
    expect(knownSubscriber()).toBe(false);
    rememberBillingStatus('u1', abonne);
    resetBillingStatusCache(); // déconnexion
    expect(knownSubscriber()).toBe(false);
  });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe('bouton « Gérer mon abonnement »', () => {
  let root: Root;
  let el: HTMLDivElement;
  beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
  afterEach(() => { act(() => root.unmount()); el.remove(); });
  const render = (status: BillingStatus | null, variant: 'panel' | 'menu' | 'icon') =>
    act(() => { root.render(React.createElement(ManageSubscription, { status, variant })); });

  it('caché pour un Nova Pro offert et pour le gratuit', () => {
    render(cadeau, 'menu');
    expect(el.querySelector('[data-testid="manage-subscription"]')).toBeNull();
    render(gratuit, 'panel');
    expect(el.querySelector('[data-testid="manage-subscription"]')).toBeNull();
  });
  it('abonné : visible ; portail indisponible → message clair, pas d\'onglet vide laissé ouvert', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as any);
    h.invoke.mockResolvedValue(ko('Edge Function returned a non-2xx status code', { error: STRIPE_SANS_PORTAIL }));
    render(abonne, 'panel');
    expect(el.textContent).toContain('Nova Pro mensuel');
    const b = el.querySelector<HTMLButtonElement>('[data-testid="manage-subscription"]')!;
    expect(b.textContent).toContain('Gérer mon abonnement');
    await act(async () => { b.click(); });
    expect(tab.close).toHaveBeenCalled();
    const err = el.querySelector('[data-testid="billing-portal-error"]');
    expect(err?.textContent).toMatch(/pas encore ouverte chez notre prestataire de paiement/);
  });
});
