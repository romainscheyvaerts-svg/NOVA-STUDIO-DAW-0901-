import React, { useEffect, useState } from 'react';
import { catalogSupabase } from '../services/supabase';
import { signInAccount } from '../services/SessionCloud';
import { openCheckout, waitPaid, billingStatus, hasPlan } from '../services/Billing';

/**
 * Nova Pro (5 €/mois) : importer ses propres instrus (d'ailleurs) et collaborer
 * à distance. Poser sa voix sur les instrus et mélodies du catalogue reste
 * gratuit. Connexion au compte Make Music puis abonnement Stripe (nouvel onglet).
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
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    catalogSupabase.auth.getUser().then(({ data }) => setLogged(!!data?.user)).catch(() => setLogged(false));
  }, [open]);
  if (!open) return null;

  const afterLogin = async () => {
    const st = await billingStatus();
    if (hasPlan(st, 'collab')) onDone(true);
    else setLogged(true);
  };
  const subscribe = async () => {
    setMsg(null);
    try {
      const sid = await openCheckout('collab');
      setBusy('En attente du paiement (onglet Stripe)…');
      const ok = await waitPaid(sid, () => !open);
      setBusy(null);
      if (ok) onDone(true);
    } catch (e: any) {
      setBusy(null);
      setMsg(e?.message || 'Paiement impossible');
    }
  };
  const input = 'h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white outline-none focus:border-cyan-500';
  const btn = 'h-12 w-full rounded-xl text-[13px] font-black disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="pro-title" onClick={() => !busy && onDone(false)}>
      <div className="w-full max-w-md rounded-3xl border border-violet-500/30 bg-[#121418] p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id="pro-title" className="text-lg font-black text-white">⭐ Nova Pro · 5 € / mois</h2>
            <p className="mt-1 text-[12px] text-slate-300">{reason}</p>
          </div>
          <button type="button" onClick={() => onDone(false)} disabled={!!busy} aria-label="Fermer" className="w-10 h-10 rounded-xl bg-white/5 text-slate-300">✕</button>
        </div>
        <ul className="space-y-1.5 text-[12px] text-slate-200">
          <li>🎧 Importe tes propres instrus (d'où tu veux) et travaille dessus dans Nova</li>
          <li>👥 Collabore à distance : artiste, ingé son, beatmaker, chat</li>
          <li>🎤 Poser ta voix sur nos instrus et mélodies reste gratuit</li>
        </ul>
        {logged === false && (
          <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[12px] font-bold text-white">Connecte-toi avec ton compte Make Music</p>
            <input className={input} type="email" autoComplete="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} />
            <input className={input} type="password" autoComplete="current-password" placeholder="Mot de passe" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="button" disabled={!email || !password} className={`${btn} bg-white text-black`}
              onClick={async () => { setMsg(null); try { await signInAccount(email, password); setPassword(''); await afterLogin(); } catch (e: any) { setMsg(e?.message || 'Connexion impossible'); } }}>
              Se connecter
            </button>
            <a href="https://www.studiomakemusic.com/auth" target="_blank" rel="noopener noreferrer" className="block text-center text-[11px] text-cyan-300 underline">Créer un compte sur studiomakemusic.com</a>
          </div>
        )}
        {logged && (
          <button type="button" disabled={!!busy} onClick={subscribe} className={`${btn} bg-violet-500 text-white`}>
            {busy || "M'abonner : 5 € / mois (Stripe, résiliable)"}
          </button>
        )}
        {msg && <p className="text-[12px] text-red-300" role="status">⚠️ {msg}</p>}
      </div>
    </div>
  );
};

export default ProGateModal;
