import React, { useEffect, useState } from 'react';
import { billingStatus, openBillingPortal, type BillingStatus } from '../services/Billing';
import { catalogSupabase } from '../services/supabase';
import { cachedBillingStatus, canManageSubscription, portalErrorMessage, rememberBillingStatus, resetBillingStatusCache, subscriptionLabel } from '../utils/billingPortal';
import { track } from '../utils/analytics';

/**
 * « Gérer mon abonnement » (portail client Stripe : carte, factures, résiliation).
 * Montré seulement à un abonné Stripe (utils/billingPortal.canManageSubscription).
 *  - variant « panel » : fenêtre Nova Pro (NovaProPlans), à la place des offres ;
 *  - variant « menu »  : menu du compte (téléphone / menu ☰) ;
 *  - variant « icon »  : pastille du compte (bureau), à côté de « Se déconnecter ».
 */

/**
 * Statut du compte Make Music connecté (celui des paiements : catalogSupabase), gardé 5 min ;
 * null tant qu'il n'est pas connu ou sans compte. Suit la connexion / déconnexion.
 */
export function useAccountBilling(): BillingStatus | null {
  const [st, setSt] = useState<BillingStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = (userId: string | null | undefined) => {
      if (!userId) { resetBillingStatusCache(); if (live) setSt(null); return; }
      cachedBillingStatus(userId, billingStatus).then(s => { rememberBillingStatus(userId, s); if (live) setSt(s); }).catch(() => {});
    };
    catalogSupabase.auth.getUser().then(({ data }) => load(data?.user?.id)).catch(() => {});
    const { data } = catalogSupabase.auth.onAuthStateChange((event: string, session: any) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') load(session?.user?.id);
    });
    return () => { live = false; data?.subscription?.unsubscribe(); };
  }, []);
  return st;
}

/** Ouvre le portail ; renvoie le message d'erreur (en français) ou null. */
export async function manageSubscription(): Promise<string | null> {
  try {
    track('billing_portal_open', {});
    await openBillingPortal();
    return null;
  } catch (e) {
    return portalErrorMessage(e);
  }
}

interface Props {
  status: BillingStatus | null | undefined;
  variant: 'panel' | 'menu' | 'icon';
}

const ManageSubscription: React.FC<Props> = ({ status, variant }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!canManageSubscription(status)) return null;
  const go = async () => {
    setErr(null);
    setBusy(true);
    const e = await manageSubscription();
    setBusy(false);
    setErr(e);
  };
  const label = subscriptionLabel(status);
  const until = status?.pro?.paid && status.pro.until ? new Date(status.pro.until).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const error = err && (
    <p className="text-[12px] text-red-300" role="alert" data-testid="billing-portal-error" ref={el => el?.scrollIntoView?.({ block: 'nearest' })}>⚠️ {err}</p>
  );

  if (variant === 'icon') {
    return (
      <span className="relative flex">
        <button type="button" onClick={() => void go()} disabled={busy} data-testid="manage-subscription"
          title={`Gérer mon abonnement (${label}) : carte, factures, résiliation`} aria-label="Gérer mon abonnement"
          className="w-7 h-7 rounded-full bg-violet-500/15 hover:bg-violet-500 text-violet-300 hover:text-white flex items-center justify-center transition-all disabled:opacity-50">
          <i className={`fas ${busy ? 'fa-circle-notch fa-spin' : 'fa-credit-card'} text-[10px]`} aria-hidden="true"></i>
        </button>
        {err && (
          <span className="absolute right-0 top-9 z-[80] w-72 rounded-xl border border-red-500/40 bg-nv-surface p-3 shadow-2xl" role="alert" data-testid="billing-portal-error">
            <span className="block text-[12px] text-red-300">⚠️ {err}</span>
            <button type="button" className="mt-2 text-[11px] text-slate-300 underline" onClick={() => setErr(null)}>Fermer</button>
          </span>
        )}
      </span>
    );
  }

  if (variant === 'menu') {
    return (
      <div className="space-y-1" data-testid="manage-subscription-menu">
        <button type="button" onClick={() => void go()} disabled={busy} data-testid="manage-subscription"
          className="w-full min-h-12 px-4 py-3 rounded-xl bg-violet-500/10 text-violet-200 font-semibold flex items-center justify-center gap-3 disabled:opacity-50">
          <i className={`fas ${busy ? 'fa-circle-notch fa-spin' : 'fa-credit-card'}`} aria-hidden="true"></i>
          <span>Gérer mon abonnement <span className="font-normal text-[12px] opacity-80">({label})</span></span>
        </button>
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-2xl border border-violet-400/30 bg-violet-500/10 p-3" data-testid="manage-subscription-panel">
      <p className="text-[12px] text-violet-100">
        ⭐ Tu es abonné <b>{label}</b>{until ? `, période en cours jusqu'au ${until}` : ''}. Change de carte, retrouve tes factures ou résilie quand tu veux.
      </p>
      <button type="button" onClick={() => void go()} disabled={busy} data-testid="manage-subscription"
        className="h-11 w-full rounded-xl bg-violet-500 text-[13px] font-black text-white disabled:opacity-50">
        <i className={`fas ${busy ? 'fa-circle-notch fa-spin' : 'fa-credit-card'} mr-2`} aria-hidden="true"></i>Gérer mon abonnement
      </button>
      {error}
    </div>
  );
};

export default ManageSubscription;
