import React, { useEffect, useRef, useState } from 'react';
import { catalogSupabase } from '../services/supabase';
import { signInAccount } from '../services/SessionCloud';
import { billingStatus, hasPlan, loadPricing, euros, type BillingStatus, type Grille } from '../services/Billing';
import NovaProPlans from './NovaProPlans';

/**
 * Nova Pro, mensuel ou annuel (prix lus sur le serveur, économie de l'annuel affichée) :
 * exports illimités, projets en ligne, collaboration en hôte, import de ses instrus,
 * mélodie offerte chaque mois. Poser sa voix sur les instrus et mélodies du catalogue
 * reste gratuit. Connexion au compte Make Music puis abonnement Stripe (nouvel onglet).
 */
interface Props {
  open: boolean;
  reason: string;
  onDone: (ok: boolean) => void;
}

const ProGateModal: React.FC<Props> = ({ open, reason, onDone }) => {
  const [logged, setLogged] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [grille, setGrille] = useState<Grille | null>(null);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const closeRef = useRef(() => onDone(false));
  closeRef.current = () => onDone(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    let live = true;
    void loadPricing().then(g => { if (live) setGrille(g); });
    catalogSupabase.auth.getUser().then(({ data }) => {
      if (!live) return;
      setLogged(!!data?.user);
      if (data?.user) void billingStatus().then(st => { if (live) setStatus(st); });
    }).catch(() => { if (live) setLogged(false); });
    return () => { live = false; };
  }, [open]);
  if (!open) return null;

  const afterLogin = async () => {
    const st = await billingStatus();
    setStatus(st);
    if (hasPlan(st, 'collab')) onDone(true);
    else setLogged(true);
  };
  const confirmPaid = async () => {
    // Le serveur confirme (abonnement enregistré) avant de débloquer.
    const st = await billingStatus();
    setStatus(st);
    if (hasPlan(st, 'collab')) onDone(true);
    else setMsg("Paiement reçu, l'activation prend quelques secondes : réessaie dans un instant.");
  };
  const input = 'h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white outline-none focus:border-cyan-500';
  const btn = 'h-12 w-full rounded-xl text-[13px] font-black disabled:opacity-40';
  const titrePrix = grille && !grille.unavailable
    ? `${euros(grille.pro.mois_cents)} / mois${grille.pro.an_cents ? ` ou ${euros(grille.pro.an_cents)} / an` : ''}`
    : '';

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="pro-title" onClick={() => closeRef.current()}>
      <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl border border-violet-500/30 bg-nv-surface p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()} data-testid="pro-gate">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id="pro-title" className="text-lg font-black text-white">⭐ Nova Pro{titrePrix ? <span className="block text-[13px] font-bold text-violet-200">{titrePrix}</span> : null}</h2>
            <p className="mt-1 text-[12px] text-slate-300">{reason}</p>
          </div>
          <button type="button" onClick={() => closeRef.current()} aria-label="Fermer" className="w-10 h-10 rounded-xl bg-white/5 text-slate-300">✕</button>
        </div>
        <NovaProPlans grille={grille} status={status} loggedIn={!!logged} onSubscribed={() => { void confirmPaid(); }} />
        {grille && !grille.unavailable && !grille.legacy && grille.cadeaux.instru_jours > 0 && (
          <p className="text-[11px] text-slate-400">
            🎁 Tu achètes une instru de la boutique ? Son export est offert et tu reçois {Math.round(grille.cadeaux.instru_jours / 30)} mois de Nova Pro
            {grille.cadeaux.melodie_jours ? ` (une mélodie : ${grille.cadeaux.melodie_jours} jours)` : ''}. Poser ta voix sur nos instrus et mélodies reste gratuit.
          </p>
        )}
        {logged === false && (
          <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[12px] font-bold text-white">Connecte-toi avec ton compte Make Music pour t'abonner</p>
            <input className={input} type="email" autoComplete="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} />
            <input className={input} type="password" autoComplete="current-password" placeholder="Mot de passe" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="button" disabled={!email || !password} className={`${btn} bg-white text-black`}
              onClick={async () => { setMsg(null); try { await signInAccount(email, password); setPassword(''); await afterLogin(); } catch (e: any) { setMsg(e?.message || 'Connexion impossible'); } }}>
              Se connecter
            </button>
            <a href="https://www.studiomakemusic.com/auth" target="_blank" rel="noopener noreferrer" className="block text-center text-[11px] text-cyan-300 underline">Créer un compte sur studiomakemusic.com</a>
          </div>
        )}
        {msg && <p className="text-[12px] text-red-300" role="status">⚠️ {msg}</p>}
      </div>
    </div>
  );
};

export default ProGateModal;
