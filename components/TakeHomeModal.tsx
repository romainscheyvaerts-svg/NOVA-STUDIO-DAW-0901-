import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  LocalCloudSession, sessionUrl, currentAccount, signInAccount, signOutAccount, assignSession, claimSession,
} from '../services/SessionCloud';
import { formatAgo } from '../utils/sessionStore';

/**
 * « Emporter la session » : envoie la session en ligne (audio compris), donne
 * le lien / QR code au client pour continuer chez lui (iPad, ordinateur), et
 * la rattache à son compte Make Music (il la retrouve dans son espace).
 */
interface Props {
  open: boolean;
  onClose: () => void;
  session: LocalCloudSession | null;
  /** Envoi en cours : pourcentage + message ; null sinon. */
  progress: { pct: number; msg: string } | null;
  error: string | null;
  onSync: () => void;
  onForget: () => void;
}

const TakeHomeModal: React.FC<Props> = ({ open, onClose, session, progress, error, onSync, onForget }) => {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [account, setAccount] = useState<{ email: string; isAdmin: boolean } | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  const url = session?.secret ? sessionUrl({ id: session.id, secret: session.secret }) : null;

  useEffect(() => {
    if (!open) return;
    currentAccount().then(setAccount).catch(() => setAccount(null));
  }, [open]);

  useEffect(() => {
    if (!url) { setQr(null); return; }
    QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#0b0d10', light: '#ffffff' } }).then(setQr).catch(() => setQr(null));
  }, [url]);

  if (!open) return null;
  const busy = !!progress && progress.pct < 100;

  const copy = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* presse-papiers refusé */ }
  };
  const run = async (fn: () => Promise<string>) => {
    setAccountBusy(true); setAccountMsg(null);
    try { setAccountMsg(await fn()); } catch (e: any) { setAccountMsg(`⚠️ ${e?.message || 'Erreur'}`); } finally { setAccountBusy(false); }
  };
  const link = session ? { id: session.id, secret: session.secret } : null;
  const message = url ? `Ta session Make Music est prête : continue-la chez toi (iPad, ordinateur) ici 👉 ${url}` : '';

  const input = 'h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white outline-none focus:border-cyan-500';
  const btn = 'h-11 rounded-xl px-4 text-[12px] font-black transition-all disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[650] flex items-end sm:items-center justify-center bg-black/70 p-4" onClick={() => !busy && onClose()} role="dialog" aria-modal="true" aria-labelledby="takehome-title">
      <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-3xl border border-white/10 bg-nv-surface p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="takehome-title" className="text-lg font-black text-white">🏠 Emporter la session</h2>
            <p className="text-[12px] text-slate-400 mt-1">
              Toute la session (prises, réglages, effets du studio rendus) part en ligne. Le client la continue chez lui sur iPad ou ordinateur, dans le navigateur ; ses modifications reviennent ici quand on rouvre la session.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="w-10 h-10 shrink-0 rounded-xl bg-white/5 text-slate-300">✕</button>
        </div>

        {progress && (
          <div className="mt-5" role="status">
            <div className="flex justify-between text-[11px] font-bold text-cyan-300"><span>{progress.msg}</span><span>{progress.pct}%</span></div>
            <div className="mt-1.5 h-2 rounded-full bg-black/50 overflow-hidden"><div className="h-full bg-cyan-500 transition-all" style={{ width: `${progress.pct}%` }} /></div>
          </div>
        )}
        {error && <p className="mt-4 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-[12px] text-red-200">⚠️ {error}</p>}

        {!session && !busy && (
          <button type="button" onClick={onSync} className={`${btn} mt-5 w-full bg-cyan-500 text-black hover:bg-cyan-400`}>
            Mettre la session en ligne
          </button>
        )}

        {session && (
          <div className="mt-5 space-y-4">
            <div className="flex gap-4 items-center">
              {qr ? <img src={qr} alt="QR code de la session" width={120} height={120} className="rounded-xl bg-white p-1 shrink-0" /> : <div className="w-[120px] h-[120px] rounded-xl bg-white/5 shrink-0" />}
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-[12px] text-slate-300"><span className="font-black text-white">{session.name}</span><br />
                  Synchronisée {formatAgo(session.syncedAt)} · version {session.version}</p>
                <p className="text-[11px] text-slate-500">Le client scanne le QR code avec son iPad / téléphone, ou reçoit le lien.</p>
                {url && <p data-testid="takehome-url" className="break-all select-all text-[10px] text-slate-500">{url}</p>}
              </div>
            </div>
            {url && (
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={copy} className={`${btn} bg-white/10 text-white hover:bg-white/15`}>{copied ? 'Copié ✓' : 'Copier le lien'}</button>
                <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" className={`${btn} flex items-center justify-center bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30`}>WhatsApp</a>
                <a href={`mailto:?subject=${encodeURIComponent('Ta session Make Music')}&body=${encodeURIComponent(message)}`} className={`${btn} flex items-center justify-center bg-white/10 text-white hover:bg-white/15`}>E-mail</a>
              </div>
            )}
            <button type="button" onClick={onSync} disabled={busy} className={`${btn} w-full border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20`}>
              ☁️ Synchroniser maintenant
            </button>
            <p className="text-[11px] text-slate-500">Sur cet appareil, la session se synchronise toute seule après chaque modification (et à la fermeture).</p>

            {/* Compte Make Music */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
              <p className="text-[12px] font-black text-white">👤 Compte client Make Music</p>
              {account === undefined && <p className="text-[11px] text-slate-500">Vérification…</p>}
              {account === null && (
                <>
                  <p className="text-[11px] text-slate-400">Connecte-toi avec ton compte studiomakemusic.com pour ranger la session dans ton espace (retrouvable partout, même sans le lien).</p>
                  <input className={input} type="email" autoComplete="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} />
                  <input className={input} type="password" autoComplete="current-password" placeholder="Mot de passe" value={password} onChange={e => setPassword(e.target.value)} />
                  <button type="button" disabled={accountBusy || !email || !password} className={`${btn} w-full bg-white text-black`}
                    onClick={() => run(async () => { await signInAccount(email, password); setAccount(await currentAccount()); setPassword(''); return 'Connecté ✓'; })}>
                    Se connecter
                  </button>
                  <a href="https://www.studiomakemusic.com/auth" target="_blank" rel="noopener noreferrer" className="block text-center text-[11px] text-cyan-300 underline">Pas de compte ? En créer un sur studiomakemusic.com</a>
                </>
              )}
              {account && (
                <>
                  <p className="text-[11px] text-slate-400">Connecté : <span className="text-white">{account.email}</span>{account.isAdmin ? ' (studio)' : ''} · <button type="button" className="underline" onClick={() => { void signOutAccount(); setAccount(null); }}>se déconnecter</button></p>
                  {link && (
                    <button type="button" disabled={accountBusy} className={`${btn} w-full bg-white/10 text-white hover:bg-white/15`}
                      onClick={() => run(async () => { await claimSession(link); return '✅ Session rangée dans ton espace Make Music'; })}>
                      Ranger la session dans mon compte
                    </button>
                  )}
                  {account.isAdmin && link && (
                    <div className="flex gap-2">
                      <input className={input} type="email" placeholder="E-mail du client" value={clientEmail} onChange={e => setClientEmail(e.target.value)} />
                      <button type="button" disabled={accountBusy || !clientEmail} className={`${btn} shrink-0 bg-cyan-500 text-black`}
                        onClick={() => run(async () => { await assignSession(link, clientEmail); return `✅ Session attribuée à ${clientEmail} : elle apparaît dans son espace client`; })}>
                        Attribuer
                      </button>
                    </div>
                  )}
                </>
              )}
              {accountMsg && <p className="text-[12px] text-slate-200" role="status">{accountMsg}</p>}
            </div>

            <button type="button" onClick={onForget} disabled={busy} className="w-full text-center text-[11px] text-slate-500 underline">
              Détacher cet appareil de la session en ligne (la session reste en ligne)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TakeHomeModal;
