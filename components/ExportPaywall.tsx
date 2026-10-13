import React, { useState } from 'react';
import { euros, type BillingStatus, type ExportAccess, type Grille } from '../services/Billing';
import NovaProPlans, { joursOffertsLabel } from './NovaProPlans';

/**
 * Bandeau de la fenêtre d'export : ce que le SERVEUR a décidé pour ce projet, dit en clair,
 * avec l'action suivante (payer l'export, Nova Pro, acheter la licence, réessayer).
 * Aucun prix en dur : ils viennent de la grille du serveur.
 */
interface Props {
  access: ExportAccess | null;
  grille: Grille | null;
  status?: BillingStatus | null;
  /** Paiement de l'export de ce projet en cours. */
  paying: boolean;
  onPayExport: () => void;
  onCancelPay: () => void;
  onBuyLicence: () => void;
  onRetry: () => void;
  /** Nova Pro payé : le serveur est interrogé de nouveau. */
  onProActive: () => void;
  /** Bouton « Acheter la licence » (la fenêtre d'export a déjà le sien). */
  showBuy?: boolean;
  /** Réponse du serveur pour « mes pistes seules » (sans l'instru), quand l'instru n'est pas achetée. */
  voix?: ExportAccess | null;
}

const box = 'rounded-2xl border px-4 py-3 text-[12px]';
/** 30 → « 1 mois » ; 60 → « 2 mois » ; 7 → « 7 jours ». */
export const dureeOfferte = (jours: number) => (jours >= 30 && jours % 30 === 0 ? `${jours / 30} mois` : `${jours} jours`);

const ExportPaywall: React.FC<Props> = ({ access, grille, status, paying, onPayExport, onCancelPay, onBuyLicence, onRetry, onProActive, showBuy = false, voix = null }) => {
  const [showPro, setShowPro] = useState(false);
  if (!access) {
    return <p className={`${box} border-white/10 bg-white/[0.03] text-slate-300`} role="status" data-testid="export-paywall" data-state="loading"><i className="fas fa-circle-notch fa-spin mr-1" />Vérification de l'export de ce projet…</p>;
  }
  const g = grille;
  const prixExport = g && !g.unavailable ? euros(g.export.cents) : null;
  const prixPro = g && !g.unavailable ? `${euros(g.pro.mois_cents)}/mois` : null;
  const cadeauInstru = g?.cadeaux.instru_jours ? (g.cadeaux.instru_jours >= 28 ? `${Math.round(g.cadeaux.instru_jours / 30)} mois de Nova Pro` : `${g.cadeaux.instru_jours} jours de Nova Pro`) : null;
  const legacyNote = g?.legacy && (
    <p className="mt-1 text-[11px] text-amber-200" role="note">ℹ️ Les nouveaux tarifs ne sont pas encore actifs sur le serveur : prix actuels affichés.</p>
  );
  const giftDays = access.pro?.source === 'cadeau' ? access.pro.days_left : 0;
  const giftTotal = access.pro?.source === 'cadeau' ? access.pro.total_days || 0 : 0;

  if (access.unlocked) {
    const texte = access.via === 'admin' ? null
      : access.via === 'licence' ? <>✅ <b>Licence achetée : export offert</b>{giftTotal > 0 ? <> + <b>{dureeOfferte(giftTotal)} de Nova Pro offert{giftTotal > 31 ? 's' : ''}</b> ({joursOffertsLabel(giftDays)})</> : null}.</>
      : access.via === 'achat' ? <>✅ <b>Export de ce projet payé</b> : refais ton mix et réexporte autant que tu veux.</>
      : giftDays > 0 ? <>🎁 <b>Nova Pro offert</b> ({joursOffertsLabel(giftDays)}) : exports illimités.</>
      : <>⭐ <b>Nova Pro</b> : exports illimités.</>;
    if (!texte) return null;
    return <div className={`${box} border-emerald-400/30 bg-emerald-500/10 text-emerald-100`} role="status" data-testid="export-paywall" data-state={access.via || 'ok'}>{texte}{legacyNote}</div>;
  }

  if (access.reason === 'erreur') {
    return (
      <div className={`${box} border-amber-400/40 bg-amber-500/10 text-amber-100 flex items-center justify-between gap-3`} role="alert" data-testid="export-paywall" data-state="erreur">
        <span>⚠️ {access.message || "Vérification de l'export impossible."}</span>
        <button type="button" onClick={onRetry} className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 font-bold hover:bg-white/20">Réessayer</button>
      </div>
    );
  }

  if (access.reason === 'catalogue_non_achete') {
    const noms = access.missing.map(m => m.title).filter(Boolean) as string[];
    const melodie = access.missing.length > 0 && access.missing.every(m => m.kind === 'melody');
    const cadeau = melodie && g?.cadeaux.melodie_jours ? `${g.cadeaux.melodie_jours} jours de Nova Pro` : cadeauInstru;
    return (
      <div className={`${box} border-amber-400/40 bg-amber-500/10 text-amber-50 space-y-2`} role="status" data-testid="export-paywall" data-state="catalogue">
        <p>
          🔒 {noms.length ? <>« <b>{noms.join(' », « ')}</b> » {noms.length > 1 ? 'ne sont' : "n'est"} pas encore acheté{noms.length > 1 ? 'es' : 'e'}.</> : <>Une instru du catalogue de ce projet n'est pas encore achetée.</>}
          {' '}Le morceau complet sort avec sa licence{cadeau ? <> : <b>export offert + {cadeau} offert</b></> : null}.
        </p>
        {showBuy && (
          <button type="button" onClick={onBuyLicence} data-testid="export-buy-licence" className="w-full min-h-11 rounded-xl bg-amber-400 px-3 py-2 text-left text-[13px] font-black text-black hover:bg-amber-300">
            🛒 Acheter la licence {melodie ? 'de la mélodie' : "de l'instru"}
          </button>
        )}
        {voix && (voix.unlocked
          ? <p className="text-[11px] text-amber-100/90">🎤 Tes pistes seules (sans l'instru) s'exportent déjà (Nova Pro ou projet payé).</p>
          : voix.reason === 'paiement' && prixExport
            ? <p className="text-[11px] text-amber-100/90">🎤 Tes pistes seules, sans l'instru, restent exportables : {prixExport} pour ce projet, ou incluses dans Nova Pro.</p>
            : null)}
        {access.login_required && <p className="text-[11px] text-amber-200">Déjà achetée ? Connecte-toi avec ton compte Make Music : tes licences sont reconnues toutes seules.</p>}
        {legacyNote}
      </div>
    );
  }

  // À payer : 1,99 € ce projet, ou Nova Pro.
  return (
    <div className={`${box} border-cyan-400/30 bg-cyan-500/10 text-cyan-50 space-y-2`} role="status" data-testid="export-paywall" data-state="paiement">
      <p className="text-[13px] font-black text-white" data-testid="export-offer-title">
        Exporter ce projet : {prixExport || '…'}{prixPro ? <> ou Nova Pro {prixPro}</> : null}
      </p>
      <p className="text-[11px] text-cyan-100/90">
        Le studio est gratuit ; tu paies seulement pour sortir ton morceau. Une fois payé, ce projet s'exporte autant de fois que tu veux.
        {access.kits && ' Ton projet utilise les kits de batterie NOVA : son export est toujours payant.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={paying ? onCancelPay : onPayExport} disabled={!prixExport} data-testid="export-pay"
          className="flex-1 min-w-[150px] min-h-11 rounded-xl bg-cyan-400 px-3 py-2 text-[13px] font-black text-black hover:bg-cyan-300 disabled:opacity-50">
          {paying ? 'En attente du paiement… (annuler)' : `Payer ${prixExport || ''} et exporter`}
        </button>
        <button type="button" onClick={() => setShowPro(v => !v)} aria-expanded={showPro} data-testid="export-show-pro"
          className="flex-1 min-w-[150px] min-h-11 rounded-xl border border-violet-400/50 bg-violet-500/15 px-3 py-2 text-[13px] font-bold text-violet-100 hover:bg-violet-500/25">
          ⭐ Nova Pro : exports illimités
        </button>
      </div>
      {showPro && <NovaProPlans grille={grille} status={status} onSubscribed={onProActive} compact />}
      {access.login_required && <p className="text-[11px] text-cyan-100/80">Conseil : connecte-toi avant de payer, l'achat restera lié à ton compte.</p>}
      {legacyNote}
    </div>
  );
};

export default ExportPaywall;
