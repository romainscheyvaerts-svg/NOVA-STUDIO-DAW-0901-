import React, { useEffect, useRef, useState } from 'react';
import { euros, openCheckout, productFor, waitPaid, type BillingStatus, type Grille } from '../services/Billing';
import { track } from '../utils/analytics';

/**
 * Nova Pro, mensuel ou annuel (prix et économie lus sur le serveur), et jours de Nova Pro
 * offerts restants. Utilisé par la fenêtre Nova Pro et par l'export.
 */
interface Props {
  grille: Grille | null;
  status?: BillingStatus | null;
  /** Abonnement payé et confirmé par le serveur. */
  onSubscribed: () => void;
  /** Rien à afficher sans compte : la fenêtre parente demande la connexion. */
  loggedIn?: boolean;
  compact?: boolean;
}

export const joursOffertsLabel = (n: number) => (n <= 1 ? 'dernier jour' : `${n} jours restants`);

/** Bandeau « Nova Pro offert : X jours restants » (achat d'une licence, séance au studio). */
export const ProGiftCounter: React.FC<{ status?: BillingStatus | null }> = ({ status }) => {
  const c = status?.pro?.cadeau;
  if (!c?.active || status?.pro?.paid) return null;
  const pourquoi = c.sources.some(s => s.source === 'studio') ? 'séance au studio'
    : c.sources.some(s => s.source === 'instru' || s.source === 'melodie_exclusive') ? 'licence achetée'
    : 'mélodie achetée';
  const fin = c.until ? new Date(c.until).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' }) : '';
  return (
    <p className="rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 py-2 text-[12px] text-violet-100" role="status" data-testid="pro-gift-counter">
      🎁 <b>Nova Pro offert</b> ({pourquoi}) : <b>{joursOffertsLabel(c.days_left)}</b>{fin ? `, jusqu'au ${fin}` : ''}.
    </p>
  );
};

const NovaProPlans: React.FC<Props> = ({ grille, status, onSubscribed, loggedIn = true, compact = false }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cancelRef = useRef(false);
  useEffect(() => () => { cancelRef.current = true; }, []);

  if (!grille) return <p className="text-[12px] text-slate-400" role="status"><i className="fas fa-circle-notch fa-spin mr-1" />Chargement des prix…</p>;
  if (grille.unavailable) return <p className="text-[12px] text-amber-200" role="status">⚠️ Prix indisponibles (pas de connexion au serveur). Réessaie dans un instant.</p>;

  const annuel = productFor(grille, 'pro_year');
  const subscribe = async (what: 'pro_month' | 'pro_year') => {
    setMsg(null);
    const product = productFor(grille, what);
    if (!product) return;
    try {
      cancelRef.current = false;
      const sid = await openCheckout(product);
      track('pro_checkout_open', { plan: what });
      setBusy('En attente du paiement (onglet Stripe)…');
      const ok = await waitPaid(sid, () => cancelRef.current);
      if (cancelRef.current) return;
      setBusy(null);
      if (ok) onSubscribed();
      else setMsg("Paiement pas encore reçu. S'il est fait, il sera détecté à la prochaine ouverture.");
    } catch (e: any) {
      setBusy(null);
      setMsg(`${e?.message || 'Paiement impossible'}. Vérifie ta connexion puis réessaie.`);
    }
  };
  const card = 'flex-1 min-w-[150px] rounded-2xl border p-3 text-left disabled:opacity-50';
  const pro = grille.pro;

  return (
    <div className="space-y-2" data-testid="nova-pro-plans">
      <ProGiftCounter status={status} />
      {!compact && (
        <ul className="space-y-1 text-[12px] text-slate-200">
          <li>💿 Exports illimités de tous tes projets</li>
          <li>☁️ Projets en ligne sans limite{pro.stockage_go ? ` (usage raisonnable : ${pro.stockage_go} Go)` : ''}</li>
          <li>👥 Collaboration en hôte : tes invités n'ont rien à payer</li>
          <li>🎧 Importe tes propres instrus</li>
          {pro.melodies_offertes_par_mois > 0 && <li>🎁 {pro.melodies_offertes_par_mois} mélodie du catalogue offerte chaque mois</li>}
        </ul>
      )}
      {loggedIn && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!!busy} onClick={() => void subscribe('pro_month')} data-testid="pro-month"
            className={`${card} border-violet-400/40 bg-violet-500/15 hover:bg-violet-500/25`}>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-violet-200">Mensuel</span>
            <span className="block text-[18px] font-black text-white">{euros(pro.mois_cents)}<span className="text-[12px] font-bold text-slate-300"> / mois</span></span>
            <span className="block text-[11px] text-slate-300">Résiliable à tout moment</span>
          </button>
          {annuel && pro.an_cents && (
            <button type="button" disabled={!!busy} onClick={() => void subscribe('pro_year')} data-testid="pro-year"
              className={`${card} border-emerald-400/50 bg-emerald-500/15 hover:bg-emerald-500/25 relative`}>
              {pro.economie_an_cents > 0 && (
                <span className="absolute -top-2 right-2 rounded-full bg-emerald-400 px-2 py-0.5 text-[10px] font-black text-black">−{pro.economie_an_pourcent} %</span>
              )}
              <span className="block text-[11px] font-bold uppercase tracking-wide text-emerald-200">Annuel</span>
              <span className="block text-[18px] font-black text-white">{euros(pro.an_cents)}<span className="text-[12px] font-bold text-slate-300"> / an</span></span>
              <span className="block text-[11px] text-emerald-200">Tu économises {euros(pro.economie_an_cents)} (soit {euros(Math.round(pro.an_cents / 12))} / mois)</span>
            </button>
          )}
        </div>
      )}
      {grille.legacy && (
        <p className="text-[11px] text-amber-200" role="note">ℹ️ Les nouveaux tarifs ne sont pas encore actifs sur le serveur : tu paies le prix actuel ({euros(pro.mois_cents)}/mois).</p>
      )}
      {busy && (
        <div className="flex items-center justify-between gap-2 text-[12px] text-slate-300" role="status">
          <span><i className="fas fa-circle-notch fa-spin mr-1" />{busy}</span>
          <button type="button" className="underline" onClick={() => { cancelRef.current = true; setBusy(null); }}>Annuler l'attente</button>
        </div>
      )}
      {msg && <p className="text-[12px] text-red-300" role="alert">⚠️ {msg}</p>}
    </div>
  );
};

export default NovaProPlans;
