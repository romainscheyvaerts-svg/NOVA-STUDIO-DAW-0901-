// @vitest-environment jsdom
/**
 * Chantier 6 — paiement : plus de « simuler un paiement réussi » en production, et
 * jamais de départ vers Stripe sans avoir sauvegardé le projet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../services/supabase', () => ({ supabase: { functions: { invoke: h.invoke } }, catalogSupabase: { functions: { invoke: h.invoke } } }));

import { StripeManager, paymentSimulationAllowed, PAYMENT_ERROR_MESSAGE } from '../services/StripeManager';
import { registerSaveBeforeLeave, saveBeforeLeaving, leavePage, SAVE_FAILED_MESSAGE } from '../utils/saveBeforeLeave';

const instrument = { id: 7, name: 'Beat', price_basic: 30, price_premium: 60, price_exclusive: 300 } as any;
const user = { id: 'u', email: 'a@b.c' } as any;
const PROD = { DEV: false, VITE_NOVA_SIMULATE_PAYMENT: '1' };

describe('paiement sans perte (services/StripeManager, utils/saveBeforeLeave)', () => {
  beforeEach(() => { h.invoke.mockReset(); registerSaveBeforeLeave(null); });

  it('simulation : seulement en dev local ET avec VITE_NOVA_SIMULATE_PAYMENT=1', () => {
    expect(paymentSimulationAllowed({ DEV: false, VITE_NOVA_SIMULATE_PAYMENT: '1' })).toBe(false);
    expect(paymentSimulationAllowed({ DEV: true })).toBe(false);
    expect(paymentSimulationAllowed({ DEV: true, VITE_NOVA_SIMULATE_PAYMENT: '1' })).toBe(true);
  });

  it('erreur du module de paiement en production : message clair, AUCUNE simulation proposée, la page reste', async () => {
    h.invoke.mockResolvedValue({ data: null, error: { message: 'FunctionsFetchError' } });
    const go = vi.fn();
    const confirm = vi.fn(() => true);
    const r = await StripeManager.getInstance().buyInstrument(instrument, 'BASIC', user, { go, env: PROD, confirm });
    expect(r.error).toBe(PAYMENT_ERROR_MESSAGE);
    expect(confirm).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('vers Stripe : le projet est sauvegardé AVANT de quitter la page (prix inchangé)', async () => {
    h.invoke.mockResolvedValue({ data: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' }, error: null });
    const order: string[] = [];
    registerSaveBeforeLeave(async () => { order.push('sauvegarde'); return true; });
    const go = vi.fn(() => order.push('départ'));
    const r = await StripeManager.getInstance().buyInstrument(instrument, 'PREMIUM', user, { go, env: PROD });
    expect(r.error).toBeUndefined();
    expect(order).toEqual(['sauvegarde', 'départ']);
    expect(go).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(h.invoke.mock.calls[0][1].body).toMatchObject({ priceType: 'PREMIUM', amount: 60 });
  });

  it('sauvegarde impossible : on NE part PAS, message actionnable', async () => {
    h.invoke.mockResolvedValue({ data: { url: 'https://checkout.stripe.com/x' }, error: null });
    registerSaveBeforeLeave(async () => false);
    const go = vi.fn();
    const r = await StripeManager.getInstance().buyInstrument(instrument, 'BASIC', user, { go, env: PROD });
    expect(r.error).toBe(SAVE_FAILED_MESSAGE);
    expect(go).not.toHaveBeenCalled();
  });

  it('dev local avec simulation : confirmée, elle sauvegarde puis part vers la fausse page de succès', async () => {
    h.invoke.mockRejectedValue(new Error('réseau'));
    const saved = vi.fn(async () => true);
    registerSaveBeforeLeave(saved);
    const go = vi.fn();
    await StripeManager.getInstance().buyInstrument(instrument, 'BASIC', user, { go, env: { DEV: true, VITE_NOVA_SIMULATE_PAYMENT: '1' }, confirm: () => true });
    expect(saved).toHaveBeenCalled();
    expect(go.mock.calls[0][0]).toMatch(/payment_success=true/);
  });

  it('sauvegarde trop longue : abandon au délai (la page reste)', async () => {
    registerSaveBeforeLeave(() => new Promise(() => { /* jamais */ }));
    expect(await saveBeforeLeaving(20)).toBe(false);
    const go = vi.fn();
    registerSaveBeforeLeave(async () => { throw new Error('IndexedDB'); });
    expect((await leavePage('https://x', go)).error).toBe(SAVE_FAILED_MESSAGE);
    expect(go).not.toHaveBeenCalled();
  });
});
