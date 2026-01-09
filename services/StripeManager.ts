
import { Instrument, User } from '../types';
import { supabase } from './supabase';

/**
 * StripeManager
 * Gère le paiement. Si le backend Supabase échoue (CORS, Config), on simule un succès pour la démo.
 */
export class StripeManager {
  private static instance: StripeManager;

  private constructor() {}

  public static getInstance(): StripeManager {
    if (!StripeManager.instance) {
      StripeManager.instance = new StripeManager();
    }
    return StripeManager.instance;
  }

  public async buyInstrument(instrument: Instrument, licenseType: 'BASIC' | 'PREMIUM' | 'EXCLUSIVE', user: User): Promise<{ error?: string }> {
    if (!supabase) {
        return { error: "Backend Supabase non configuré." };
    }

    try {
        console.log(`[Stripe] Tentative achat ${instrument.name} (${licenseType})...`);

        const price = licenseType === 'BASIC' ? instrument.price_basic : 
                      licenseType === 'PREMIUM' ? instrument.price_premium : 
                      instrument.price_exclusive;

        // Appel Edge Function
        // Supabase-js gère automatiquement le Content-Type: application/json
        const { data, error } = await supabase.functions.invoke('create-checkout-session', {
            body: {
                instrumentId: instrument.id,
                instrumentName: instrument.name, // Ajout du nom pour Stripe
                priceType: licenseType,
                amount: price
            }
        });

        if (error) {
            console.warn("[Stripe] Edge Function Error (Invoke):", error);
            // On lance une erreur pour déclencher le catch et le fallback
            throw new Error(error.message || "Erreur lors de l'appel à la fonction de paiement.");
        }

        if (data?.url) {
            console.log("[Stripe] Redirection vers:", data.url);
            window.location.href = data.url;
            return {};
        } else if (data?.error) {
            throw new Error(data.error);
        } else {
            throw new Error("URL de paiement non reçue.");
        }

    } catch (e: any) {
        console.error("Payment Error (Switching to Simulation):", e);
        
        // --- MODE SIMULATION (FALLBACK) ---
        // Permet de tester le flux UX même si la Cloud Function n'est pas déployée ou config
        
        const confirm = window.confirm(
            `Erreur de connexion au module de paiement (${e.message}).\n\nVoulez-vous simuler un paiement réussi pour tester l'interface ?`
        );

        if (confirm) {
            console.log("[Stripe] Simulation succès...");
            // Redirection vers l'app avec les params de succès
            const mockUrl = `${window.location.origin}${window.location.pathname}?payment_success=true&session_id=mock-session-${Date.now()}`;
            window.location.href = mockUrl;
            return {};
        }

        return { error: e.message || "Erreur de paiement." };
    }
  }
}

export const stripeManager = StripeManager.getInstance();
