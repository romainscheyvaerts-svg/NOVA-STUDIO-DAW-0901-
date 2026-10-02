import { catalogSupabase } from './supabase';

/**
 * Paiements Nova (Stripe Checkout, fonction nova-billing du site) :
 *  - export de mes pistes seules (voix, batterie) : 2 € par projet,
 *  - abonnement collaboration : 5 €/mois, abonnement beatmaker : 10 €/mois.
 * Le paiement s'ouvre dans un nouvel onglet : le studio reste ouvert (rien
 * n'est perdu) et vérifie le paiement tout seul.
 */

export type BillingProduct = 'collab' | 'beatmaker' | 'export_voices';

async function billing<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await catalogSupabase.functions.invoke('nova-billing', { body: { action, ...body } });
  if (error) {
    let msg = error.message;
    try { msg = (await (error as any).context?.json?.())?.error || msg; } catch { /* */ }
    throw new Error(msg);
  }
  return data as T;
}

/** URL de retour : la page actuelle du studio (le nouvel onglet affiche « paiement validé »). */
const returnUrl = () => {
  const u = new URL(window.location.href);
  u.search = '';
  u.hash = '';
  return u.toString();
};

/**
 * Ouvre Stripe Checkout dans un nouvel onglet (à appeler pendant le clic, pour
 * ne pas être bloqué) et renvoie l'identifiant de la session de paiement.
 */
export async function openCheckout(product: BillingProduct, extra: Record<string, unknown> = {}): Promise<string> {
  const tab = window.open('', '_blank');
  try {
    const r = await billing<{ url: string; session_id: string }>('checkout', { product, return_url: returnUrl(), ...extra });
    if (tab) tab.location.href = r.url;
    else window.location.href = r.url;
    return r.session_id;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Attend que le paiement soit validé (vérification toutes les 3 s, 20 min max). */
export async function waitPaid(sessionId: string, isCancelled: () => boolean = () => false): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60_000) {
    if (isCancelled()) return false;
    try {
      const r = await billing<{ paid: boolean }>('verify', { session_id: sessionId });
      if (r.paid) return true;
    } catch { /* réseau : on réessaie */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

export const verifyPayment = (sessionId: string) => billing<{ paid: boolean; kind?: string; project_key?: string }>('verify', { session_id: sessionId });

export interface BillingStatus { plans: { plan: string; status: string; current_period_end: string | null }[]; admin: boolean; free_exports_left?: number; free_exports_total?: number }
export async function billingStatus(): Promise<BillingStatus> {
  try { return await billing('status'); } catch { return { plans: [], admin: false }; }
}

/** Nova Pro : utilise un des 10 exports gratuits du mois pour ce projet (s'il en reste). */
export async function spendExportCredit(projectKey: string): Promise<{ unlocked: boolean; remaining: number; reason?: string }> {
  try { return await billing('use_export_credit', { project_key: projectKey }); } catch { return { unlocked: false, remaining: 0 }; }
}

export const hasPlan = (st: { plans: { plan: string }[]; admin: boolean }, plan: 'collab' | 'beatmaker') =>
  st.admin || st.plans.some(p => p.plan === plan);

// --- Export de mes pistes seules -----------------------------------------------------

const LS = (key: string) => `nova_export_voices:${key}`;

export async function isExportVoicesUnlocked(projectKey: string): Promise<boolean> {
  try { if (localStorage.getItem(LS(projectKey)) === '1') return true; } catch { /* */ }
  try {
    const r = await billing<{ unlocked: boolean }>('export_unlocked', { project_key: projectKey });
    if (r.unlocked) { try { localStorage.setItem(LS(projectKey), '1'); } catch { /* */ } }
    return r.unlocked;
  } catch { return false; }
}

export const markExportVoicesUnlocked = (projectKey: string) => {
  try { localStorage.setItem(LS(projectKey), '1'); } catch { /* */ }
};

export async function openBillingPortal(): Promise<void> {
  const tab = window.open('', '_blank');
  const r = await billing<{ url: string }>('portal', { return_url: returnUrl() });
  if (tab) tab.location.href = r.url; else window.location.href = r.url;
}
