import { Instrument, User } from '../types';
import { supabase } from './supabase';
import { leavePage } from '../utils/saveBeforeLeave';

/**
 * StripeManager : achat d'une licence d'instru (Stripe Checkout).
 *
 * Avant, une erreur du module de paiement proposait de « simuler un paiement
 * réussi » puis quittait la page (travail non sauvegardé perdu, et faux succès
 * possible en production). Maintenant :
 *  - le projet est TOUJOURS sauvegardé avant d'aller sur Stripe (utils/saveBeforeLeave) ;
 *    si la sauvegarde échoue, la page reste ouverte ;
 *  - en cas d'erreur, un message clair est renvoyé et la page reste ouverte ;
 *  - la simulation n'existe qu'en développement local (`vite` en mode dev) ET avec
 *    VITE_NOVA_SIMULATE_PAYMENT=1 : jamais dans un build de production.
 */

/** Simulation de paiement autorisée ? Seulement en dev local, sur demande explicite. */
export function paymentSimulationAllowed(env: { DEV?: boolean; VITE_NOVA_SIMULATE_PAYMENT?: string } = (import.meta as any).env || {}): boolean {
  return !!env.DEV && env.VITE_NOVA_SIMULATE_PAYMENT === '1';
}

export const PAYMENT_ERROR_MESSAGE =
  "Le paiement n'a pas pu démarrer (connexion au module de paiement impossible). "
  + "Ton projet est intact et la page reste ouverte : réessaie dans un instant. Si ça continue, écris-nous depuis « Signaler un problème ».";

export class StripeManager {
  private static instance: StripeManager;

  private constructor() {}

  public static getInstance(): StripeManager {
    if (!StripeManager.instance) {
      StripeManager.instance = new StripeManager();
    }
    return StripeManager.instance;
  }

  public async buyInstrument(
    instrument: Instrument,
    licenseType: 'BASIC' | 'PREMIUM' | 'EXCLUSIVE',
    _user: User,
    deps: { go?: (url: string) => void; env?: Parameters<typeof paymentSimulationAllowed>[0]; confirm?: (msg: string) => boolean } = {},
  ): Promise<{ error?: string }> {
    if (!supabase) return { error: 'Backend Supabase non configuré.' };

    let url: string;
    try {
      const price = licenseType === 'BASIC' ? instrument.price_basic
        : licenseType === 'PREMIUM' ? instrument.price_premium
          : instrument.price_exclusive;
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { instrumentId: instrument.id, instrumentName: instrument.name, priceType: licenseType, amount: price },
      });
      if (error) throw new Error(error.message || "Erreur lors de l'appel à la fonction de paiement.");
      if (data?.error) throw new Error(data.error);
      if (!data?.url) throw new Error('URL de paiement non reçue.');
      url = String(data.url);
    } catch (e: any) {
      console.error('[Stripe] Paiement impossible :', e?.message || e);
      if (paymentSimulationAllowed(deps.env)) {
        // DÉVELOPPEMENT LOCAL uniquement (vite dev + VITE_NOVA_SIMULATE_PAYMENT=1).
        const ask = deps.confirm || ((m: string) => window.confirm(m));
        if (ask(`[DEV] Module de paiement injoignable (${e?.message}).\n\nSimuler un paiement réussi ?`)) {
          const mock = `${window.location.origin}${window.location.pathname}?payment_success=true&session_id=mock-session-${Date.now()}`;
          return leavePage(mock, deps.go);
        }
      }
      return { error: PAYMENT_ERROR_MESSAGE };
    }
    // Vers Stripe : le projet est sauvegardé d'abord (sinon la page reste ouverte).
    return leavePage(url, deps.go);
  }
}

export const stripeManager = StripeManager.getInstance();
