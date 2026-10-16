import React, { useState } from 'react';
import {
  passwordRules, signUpMakeMusic, resendConfirmation, signupProblem, SITE_URL, type SignupResult,
} from '../services/makeMusicSignup';

/**
 * Formulaire « Créer mon compte » de NOVA : crée le compte Make Music (celui de studiomakemusic.com),
 * avec les règles du site (services/makeMusicSignup). Utilisé par la fenêtre « Se connecter » (barre,
 * accueil), Nova Pro, « Emporter la session », la collaboration et le partage de séance.
 *
 * Après l'envoi : « Confirme ton e-mail » (lien reçu), « Renvoyer l'e-mail », « J'ai confirmé, me connecter ».
 */
interface Props {
  /** E-mail déjà tapé dans le formulaire de connexion. */
  initialEmail?: string;
  /** Appli Windows : le lien de confirmation ouvre le site, puis on revient se connecter ici. */
  desktop?: boolean;
  /** Compte ouvert tout de suite (serveur sans confirmation d'e-mail). */
  onSignedIn?: (r: Extract<SignupResult, { status: 'signed_in' }>) => void;
  /** « J'ai déjà un compte » / « J'ai confirmé, me connecter » (e-mail repris). */
  onWantLogin?: (email: string) => void;
  /** Version resserrée, dans une carte (Nova Pro, collaboration…). */
  compact?: boolean;
  testid?: string;
}

const MakeMusicSignupForm: React.FC<Props> = ({ initialEmail = '', desktop, onSignedIn, onWantLogin, compact, testid = 'mm-signup' }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const rules = passwordRules(password);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setInfo(null);
    const problem = signupProblem({ name, email, password });
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      const r = await signUpMakeMusic({ name, email, password }, { desktop });
      setPassword('');
      if (r.status === 'signed_in') onSignedIn?.(r);
      else setSentTo(r.email);
    } catch (err: any) {
      setError(err?.message || 'Création du compte impossible : réessaie dans un instant.');
    } finally { setBusy(false); }
  };

  const resend = async () => {
    if (!sentTo) return;
    setError(null); setInfo(null); setBusy(true);
    try { await resendConfirmation(sentTo, { desktop }); setInfo('E-mail renvoyé ✓ Regarde aussi dans les spams.'); }
    catch (err: any) { setError(err?.message || 'Renvoi impossible : réessaie dans un instant.'); }
    finally { setBusy(false); }
  };

  const h = compact ? 'h-11 text-[13px]' : 'h-12 text-[14px]';
  const input = `${h} w-full rounded-xl border border-white/10 bg-black/40 px-3 text-white placeholder:text-slate-500 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20 transition`;
  const primary = `${h} w-full rounded-xl bg-cyan-500 font-black text-black hover:bg-cyan-400 disabled:opacity-40 transition`;
  const link = 'min-h-10 text-[12px] text-cyan-300 underline-offset-2 hover:underline';
  const label = 'block space-y-1 text-[11px] font-bold text-slate-300';

  if (sentTo) {
    return (
      <div className="space-y-3 text-center" data-testid={`${testid}-sent`} data-mm-signup="sent" role="status" aria-live="polite">
        <p className="text-3xl" aria-hidden="true">📩</p>
        <p className="text-[15px] font-black text-white">Confirme ton e-mail</p>
        <p className="text-[12px] leading-relaxed text-slate-300">
          On t'a envoyé un lien à <span className="font-bold text-white break-all">{sentTo}</span>. Clique dessus (regarde aussi dans les spams) :
          {desktop ? ' il s’ouvre dans ton navigateur, puis reviens ici et connecte-toi.' : ' il t’ouvre le studio sur studiomakemusic.com, déjà connecté. Tu peux aussi revenir ici et te connecter.'}
        </p>
        {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">{error}</p>}
        {info && <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">{info}</p>}
        {onWantLogin && (
          <button type="button" className={primary} data-testid={`${testid}-confirmed`} onClick={() => onWantLogin(sentTo)}>J'ai confirmé, me connecter</button>
        )}
        <button type="button" className={link} disabled={busy} data-testid={`${testid}-resend`} onClick={() => void resend()}>{busy ? 'Envoi…' : 'Je n’ai rien reçu : renvoyer l’e-mail'}</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={compact ? 'space-y-2' : 'space-y-3'} data-testid={testid} data-mm-signup="form" noValidate>
      <p className={`${compact ? 'text-[12px]' : 'text-[13px]'} font-bold text-white`}>Crée ton compte Make Music (gratuit)</p>
      <p className="text-[11px] text-slate-400">Le même compte que sur studiomakemusic.com : instrus, réservations, Nova Pro, collaboration.</p>
      <label className={label}><span>Nom ou nom d'artiste</span>
        <input className={input} autoComplete="name" value={name} onChange={e => setName(e.target.value)} data-testid={`${testid}-name`} />
      </label>
      <label className={label}><span>E-mail</span>
        <input className={input} type="email" inputMode="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="toi@exemple.com" data-testid={`${testid}-email`} />
      </label>
      <label className={label}><span>Mot de passe</span>
        <span className="relative block">
          <input className={`${input} pr-24`} type={show ? 'text' : 'password'} autoComplete="new-password" value={password}
            onChange={e => setPassword(e.target.value)} aria-describedby={`${testid}-rules`} data-testid={`${testid}-password`} />
          <button type="button" onClick={() => setShow(s => !s)} aria-pressed={show}
            className="absolute right-1 top-1/2 -translate-y-1/2 min-h-9 rounded-lg px-2 text-[11px] font-bold text-slate-300 hover:text-white">
            {show ? 'Masquer' : 'Afficher'}
          </button>
        </span>
      </label>
      <ul id={`${testid}-rules`} className="flex flex-wrap gap-1.5" aria-label="Le mot de passe doit contenir">
        {rules.map(r => (
          <li key={r.id} data-ok={r.ok ? '1' : '0'}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${r.ok ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300' : 'border-white/10 bg-white/[0.03] text-slate-400'}`}>
            {r.ok ? '✓ ' : ''}{r.label}
          </li>
        ))}
      </ul>
      {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert" data-testid={`${testid}-error`}>{error}</p>}
      <button type="submit" disabled={busy} className={primary} data-testid={`${testid}-submit`}>{busy ? 'Création…' : 'Créer mon compte'}</button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {onWantLogin && <button type="button" className={link} onClick={() => onWantLogin(email)}>J'ai déjà un compte</button>}
        <a className="text-[11px] text-slate-500 underline" href={`${SITE_URL}/cgv`} target="_blank" rel="noopener noreferrer">Conditions du compte</a>
      </div>
    </form>
  );
};

export default MakeMusicSignupForm;
