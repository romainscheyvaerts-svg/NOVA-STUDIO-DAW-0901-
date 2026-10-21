import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleButton, GoogleLogo } from './GoogleButton';
import { catalogSupabase } from '../services/supabase';
import { isNovaDesktop, isOfflineEdition } from '../utils/desktopApp';
import { useNovaPricing, exportTexte } from '../hooks/useNovaPricing';
import {
  decideGate, friendlyAuthError, isNetworkError, readAccessCache, writeAccessCache,
} from '../utils/desktopAccess';
import {
  desktopSupportsGoogle, getDesktopTransport, googleLoginErrorMessage, startDesktopGoogleLogin,
  type GoogleLoginController, type GooglePhase,
} from '../utils/desktopGoogleLogin';
import { passwordOk, passwordRules, signUpMakeMusic, PASSWORD_MIN } from '../services/makeMusicSignup';

/**
 * Application Windows uniquement : connexion obligatoire (compte Make Music
 * gratuit) avant de démarrer le studio. Sur le web, ne fait rien.
 * Le studio n'est monté qu'après la première connexion ; s'il l'est déjà et que
 * l'on se déconnecte, la porte le recouvre sans le démonter (rien n'est perdu).
 */

const SITE = 'https://www.studiomakemusic.com';
const AUTH_STORAGE_KEY = 'sb-mxdrxpzxbgybchzzvpkf-auth-token';

type Stage = 'checking' | 'login' | 'signup' | 'forgot' | 'signup_sent' | 'offline_expired' | 'open';

/** Utilisateur de la session gardée par l'appli (lisible même hors ligne). */
function storedUser(): { id: string; email: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    const u = raw?.user || raw?.currentSession?.user;
    return u?.id ? { id: String(u.id), email: String(u.email || '') } : null;
  } catch { return null; }
}

/** Vérification par le serveur Supabase : utilisateur, null (pas connecté) ou 'network'. */
async function serverUser(): Promise<{ id: string; email: string } | null | 'network'> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network';
  try {
    const timeout = new Promise<'network'>(r => setTimeout(() => r('network'), 8000));
    const run = (async () => {
      const { data: s, error: se } = await catalogSupabase.auth.getSession();
      if (se && isNetworkError(se)) return 'network' as const;
      if (!s?.session) return storedUser() ? ('network' as const) : null;
      const { data, error } = await catalogSupabase.auth.getUser();
      if (error) return isNetworkError(error) ? ('network' as const) : null;
      return data?.user ? { id: data.user.id, email: data.user.email || '' } : null;
    })();
    return await Promise.race([run, timeout]);
  } catch (e) {
    return isNetworkError(e) ? 'network' : null;
  }
}

const openExternal = (url: string) => { window.open(url, '_blank', 'noopener'); };

const DesktopAccessGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const desktop = isNovaDesktop();
  // Édition hors ligne (clé USB) : pas de compte demandé, le studio s'ouvre directement.
  if (!desktop || isOfflineEdition()) return <>{children}</>;
  return <Gate>{children}</Gate>;
};

const Gate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [stage, setStage] = useState<Stage>('checking');
  const grille = useNovaPricing();
  const [mounted, setMounted] = useState(false);
  const [account, setAccount] = useState<{ email: string; offline: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Connexion Google en cours (navigateur par défaut + retour sur 127.0.0.1, cf. desktopGoogleLogin.ts)
  const [google, setGoogle] = useState<Extract<GooglePhase, { phase: 'preparing' | 'waiting' | 'finishing' }> | null>(null);
  const googleCtrl = useRef<GoogleLoginController | null>(null);
  const canGoogle = desktopSupportsGoogle();

  const check = useCallback(async () => {
    setError(null);
    const server = await serverUser();
    const local = storedUser();
    const d = decideGate(server, local, readAccessCache(), Date.now());
    if (d.state === 'open') {
      if (server && server !== 'network') writeAccessCache({ userId: server.id, email: server.email, checkedAt: Date.now() });
      setAccount({ email: d.email, offline: d.offline });
      setMounted(true);
      setStage('open');
    } else if (d.state === 'offline_expired') {
      if (d.email) setEmail(d.email);
      setStage('offline_expired');
    } else {
      writeAccessCache(null);
      setStage(s => (s === 'signup' || s === 'forgot' || s === 'signup_sent' ? s : 'login'));
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  // Déconnexion depuis le studio (ou session révoquée) : la porte revient.
  useEffect(() => {
    const { data } = catalogSupabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        writeAccessCache(null);
        setAccount(null);
        setPassword('');
        setStage('login');
      }
    });
    return () => { data?.subscription?.unsubscribe(); };
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setInfo(null);
    try { await fn(); } catch (e: any) { setError(friendlyAuthError(e)); }
    setBusy(false);
  };

  const openWith = (u: { id: string; email: string }) => {
    writeAccessCache({ userId: u.id, email: u.email, checkedAt: Date.now() });
    setPassword('');
    setAccount({ email: u.email, offline: false });
    setMounted(true);
    setStage('open');
  };

  // Fenêtre fermée / porte démontée pendant l'attente : le serveur local se ferme.
  useEffect(() => () => { googleCtrl.current?.cancel(); googleCtrl.current = null; }, []);

  const startGoogle = () => {
    setError(null); setInfo(null);
    const transport = getDesktopTransport();
    if (!transport) { setError(googleLoginErrorMessage('no_app')); return; }
    googleCtrl.current?.cancel();
    googleCtrl.current = startDesktopGoogleLogin({
      auth: catalogSupabase.auth as any,
      transport,
      onPhase: (p) => {
        if (p.phase === 'done') {
          googleCtrl.current = null;
          setGoogle(null);
          openWith(p.user);
        } else if (p.phase === 'error') {
          googleCtrl.current = null;
          setGoogle(null);
          setError(p.message);
        } else {
          setGoogle(p);
        }
      },
    });
  };

  const cancelGoogle = () => {
    googleCtrl.current?.cancel();
    googleCtrl.current = null;
    setGoogle(null);
    setInfo(null);
    setError(googleLoginErrorMessage('cancelled'));
  };

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { data, error } = await catalogSupabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      const u = data?.user;
      if (!u) throw new Error('Connexion impossible, réessaie.');
      openWith({ id: u.id, email: u.email || email.trim() });
    });
  };

  const signup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      // Même parcours que le site (règles, nom, lien de confirmation) : services/makeMusicSignup.
      const r = await signUpMakeMusic({ name, email, password }, { desktop: true });
      setPassword('');
      if (r.status === 'signed_in') { openWith({ id: r.userId, email: r.email }); return; }
      setStage('signup_sent');
    });
  };

  const forgot = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!email.trim()) throw new Error('Indique ton e-mail.');
      const { error } = await catalogSupabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${SITE}/auth` });
      if (error) throw error;
      setInfo('E-mail envoyé : clique sur le lien pour choisir un nouveau mot de passe, puis reviens ici.');
    });
  };

  const signOut = async () => {
    try { await catalogSupabase.auth.signOut(); } catch { /* hors ligne : on oublie quand même la session */ }
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* */ }
    writeAccessCache(null);
    setAccount(null);
    setStage('login');
  };

  const showGate = stage !== 'open';
  const input = 'h-12 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-[14px] text-white placeholder:text-slate-500 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20 transition';
  const primary = 'h-12 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-violet-500 text-[14px] font-black text-black shadow-lg shadow-cyan-500/20 hover:opacity-95 disabled:opacity-40 transition';
  const link = 'text-[12px] text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline';

  return (
    <>
      {mounted && (
        // Hauteur de l'écran transmise au studio : sans elle, la colonne du studio prenait la
        // hauteur de son contenu (catalogue de 3 000 px) dans Nova Studio, et le bandeau du bas
        // (Piste voix, Mix auto, Pistes, Groupes…) et les pistes du bas sortaient de l'écran.
        <div className="flex h-full min-h-0 flex-1 flex-col" aria-hidden={showGate || undefined} style={showGate ? { visibility: 'hidden' } : undefined}>
          {children}
        </div>
      )}
      {account?.offline && stage === 'open' && <OfflineNote />}
      {showGate && (
        <div data-testid="desktop-gate" className="fixed inset-0 z-[10000] flex items-center justify-center overflow-auto bg-nv-bg p-4" role="dialog" aria-modal="true" aria-labelledby="gate-title">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -top-40 -left-40 h-[520px] w-[520px] rounded-full bg-cyan-500/15 blur-[120px]" />
            <div className="absolute -bottom-40 -right-40 h-[520px] w-[520px] rounded-full bg-violet-600/20 blur-[120px]" />
          </div>
          <div className="relative grid w-full max-w-4xl overflow-hidden rounded-3xl border border-white/10 bg-nv-surface/90 shadow-2xl backdrop-blur md:grid-cols-[1.05fr_1fr]">
            <aside className="hidden flex-col justify-between bg-gradient-to-br from-cyan-500/10 via-transparent to-violet-600/15 p-10 md:flex">
              <div>
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400 to-violet-500 text-xl font-black text-black">N</div>
                  <div>
                    <p className="text-lg font-black tracking-wide text-white">NOVA STUDIO</p>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">pour Windows</p>
                  </div>
                </div>
                <h2 className="mt-10 text-2xl font-black leading-tight text-white">Ton studio, sur ton PC.</h2>
                <ul className="mt-6 space-y-3 text-[13px] text-slate-300">
                  <li className="flex gap-3"><span className="text-cyan-300">●</span>Enregistre, compose et mixe librement</li>
                  <li className="flex gap-3"><span className="text-cyan-300">●</span>Ponts ASIO et VST intégrés, ouverture sans Internet</li>
                  <li className="flex gap-3"><span className="text-cyan-300">●</span>Ta session est sauvegardée à la fermeture</li>
                  <li className="flex gap-3"><span className="text-violet-300">●</span>Export inclus avec Nova Pro{exportTexte(grille) ? `, sinon ${exportTexte(grille)} par projet` : ', ou à l\'unité par projet'}</li>
                </ul>
              </div>
              <p className="text-[11px] text-slate-500">Le même compte que sur studiomakemusic.com</p>
            </aside>

            <section className="p-8 sm:p-10">
              {stage === 'checking' && (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 text-center" role="status">
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                  <p id="gate-title" className="text-[14px] font-bold text-white">Ouverture de Nova Studio…</p>
                  <p className="text-[12px] text-slate-400">Vérification de ton compte</p>
                </div>
              )}

              {google && (stage === 'login' || stage === 'signup') && (
                <GoogleWaiting
                  phase={google.phase}
                  onReopen={() => googleCtrl.current?.reopen()}
                  onCancel={cancelGoogle}
                />
              )}

              {!google && stage === 'login' && (
                <form onSubmit={login} className="space-y-4">
                  <div>
                    <h1 id="gate-title" className="text-2xl font-black text-white">Connecte-toi pour démarrer Nova Studio</h1>
                    <p className="mt-2 text-[13px] text-slate-400">Avec ton compte Make Music (gratuit). Une fois connecté, le studio est à toi : seul l'export est payant sans abonnement.</p>
                  </div>
                  {canGoogle && <GoogleButton onClick={startGoogle} disabled={busy} />}
                  <label className="block space-y-1.5"><span className="text-[12px] font-bold text-slate-300">E-mail</span>
                    <input className={input} type="email" autoComplete="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="toi@exemple.com" required />
                  </label>
                  <label className="block space-y-1.5"><span className="text-[12px] font-bold text-slate-300">Mot de passe</span>
                    <input className={input} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Ton mot de passe" required />
                  </label>
                  {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">{error}</p>}
                  <button type="submit" disabled={busy || !email || !password} className={primary}>{busy ? 'Connexion…' : 'Se connecter'}</button>
                  <div className="flex items-center justify-between">
                    <button type="button" className={link} onClick={() => { setError(null); setInfo(null); setStage('forgot'); }}>Mot de passe oublié ?</button>
                    <button type="button" className={link} onClick={() => { setError(null); setStage('signup'); }}>Créer un compte gratuit</button>
                  </div>
                </form>
              )}

              {!google && stage === 'signup' && (
                <form onSubmit={signup} className="space-y-4">
                  <div>
                    <h1 id="gate-title" className="text-2xl font-black text-white">Crée ton compte gratuit</h1>
                    <p className="mt-2 text-[13px] text-slate-400">Il sert aussi sur studiomakemusic.com (réservations, instrus, Nova Pro).</p>
                  </div>
                  {canGoogle && <GoogleButton onClick={startGoogle} disabled={busy} />}
                  <label className="block space-y-1.5"><span className="text-[12px] font-bold text-slate-300">Nom ou nom d'artiste</span>
                    <input className={input} autoComplete="name" autoFocus value={name} onChange={e => setName(e.target.value)} required />
                  </label>
                  <label className="block space-y-1.5"><span className="text-[12px] font-bold text-slate-300">E-mail</span>
                    <input className={input} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />
                  </label>
                  <label className="block space-y-1.5"><span className="text-[12px] font-bold text-slate-300">Mot de passe ({PASSWORD_MIN} caractères minimum)</span>
                    <input className={input} type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={password} onChange={e => setPassword(e.target.value)} required aria-describedby="gate-pw-rules" />
                  </label>
                  <ul id="gate-pw-rules" className="flex flex-wrap gap-1.5" aria-label="Le mot de passe doit contenir">
                    {passwordRules(password).map(r => (
                      <li key={r.id} data-ok={r.ok ? '1' : '0'} className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${r.ok ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300' : 'border-white/10 bg-white/[0.03] text-slate-400'}`}>{r.ok ? '✓ ' : ''}{r.label}</li>
                    ))}
                  </ul>
                  {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">{error}</p>}
                  <button type="submit" disabled={busy || !email || !passwordOk(password) || !name.trim()} className={primary}>{busy ? 'Création…' : 'Créer mon compte'}</button>
                  <p className="text-center text-[12px] text-slate-400">Déjà un compte ? <button type="button" className={link} onClick={() => { setError(null); setStage('login'); }}>Se connecter</button></p>
                  <p className="text-center text-[11px] text-slate-500">En créant un compte, tu acceptes les <button type="button" className="underline" onClick={() => openExternal(`${SITE}/cgv`)}>conditions</button>.</p>
                </form>
              )}

              {stage === 'signup_sent' && (
                <div className="space-y-4 text-center">
                  <p className="text-4xl">📩</p>
                  <h1 id="gate-title" className="text-2xl font-black text-white">Confirme ton e-mail</h1>
                  <p className="text-[13px] text-slate-300">On t'a envoyé un lien à <span className="font-bold text-white">{email}</span>. Clique dessus (il s'ouvre dans ton navigateur), puis reviens ici et connecte-toi.</p>
                  <button type="button" className={primary} onClick={() => { setInfo(null); setStage('login'); }}>J'ai confirmé, me connecter</button>
                </div>
              )}

              {stage === 'forgot' && (
                <form onSubmit={forgot} className="space-y-4">
                  <div>
                    <h1 id="gate-title" className="text-2xl font-black text-white">Mot de passe oublié</h1>
                    <p className="mt-2 text-[13px] text-slate-400">On t'envoie un lien pour en choisir un nouveau.</p>
                  </div>
                  <label className="block space-y-1.5"><span className="text-[12px] font-bold text-slate-300">E-mail</span>
                    <input className={input} type="email" autoComplete="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} required />
                  </label>
                  {error && <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">{error}</p>}
                  {info && <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200" role="status">{info}</p>}
                  <button type="submit" disabled={busy || !email} className={primary}>{busy ? 'Envoi…' : 'Recevoir le lien'}</button>
                  <p className="text-center"><button type="button" className={link} onClick={() => { setError(null); setInfo(null); setStage('login'); }}>Retour à la connexion</button></p>
                </form>
              )}

              {stage === 'offline_expired' && (
                <div className="space-y-4 text-center">
                  <p className="text-4xl">📡</p>
                  <h1 id="gate-title" className="text-2xl font-black text-white">Connexion Internet nécessaire</h1>
                  <p className="text-[13px] text-slate-300">
                    Nova Studio s'ouvre sans Internet pendant 7 jours après la dernière vérification de ton compte
                    {email ? <> (<span className="font-bold text-white">{email}</span>)</> : null}. Connecte-toi au Wi-Fi une minute, puis réessaie.
                  </p>
                  {error && <p className="text-[12px] text-red-200" role="alert">{error}</p>}
                  <button type="button" disabled={busy} className={primary} onClick={() => void run(check)}>{busy ? 'Vérification…' : 'Réessayer'}</button>
                  <button type="button" className={link} onClick={() => void signOut()}>Utiliser un autre compte</button>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
};

/** Attente du retour de Google (la page s'est ouverte dans le navigateur par défaut). */
const GoogleWaiting: React.FC<{ phase: 'preparing' | 'waiting' | 'finishing'; onReopen: () => void; onCancel: () => void }> = ({ phase, onReopen, onCancel }) => (
  <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 text-center" role="status" aria-live="polite" data-testid="google-waiting">
    <div className="relative flex h-14 w-14 items-center justify-center">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
      <GoogleLogo className="h-6 w-6" />
    </div>
    <h1 id="gate-title" className="text-xl font-black text-white">
      {phase === 'preparing' ? 'Préparation de la connexion Google…'
        : phase === 'finishing' ? 'Ouverture de ta session…'
          : 'Termine la connexion dans ton navigateur…'}
    </h1>
    {phase === 'waiting' && (
      <>
        <p className="max-w-sm text-[13px] text-slate-300">
          Une page Google s'est ouverte dans ton navigateur. Choisis ton compte : Nova Studio s'ouvrira tout seul ensuite.
        </p>
        <p className="max-w-sm text-[12px] text-slate-500">Tu ne vois pas la page ? Rouvre-la. La demande expire au bout de 5 minutes.</p>
      </>
    )}
    {phase === 'finishing' && <p className="text-[13px] text-slate-300">C'est presque fini, Google a répondu.</p>}
    <div className="mt-2 flex w-full max-w-xs flex-col gap-2">
      {phase === 'waiting' && (
        <button type="button" onClick={onReopen} className="flex h-11 w-full items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] text-[13px] font-bold text-white transition hover:bg-white/[0.08]">
          <GoogleLogo className="mr-2 h-4 w-4" />Rouvrir la page Google
        </button>
      )}
      {phase !== 'finishing' && (
        <button type="button" onClick={onCancel} className="h-10 w-full rounded-xl text-[13px] text-slate-300 underline-offset-2 hover:text-white hover:underline">
          Annuler
        </button>
      )}
    </div>
  </div>
);

/** Ouvert hors ligne grâce à la dernière vérification : petit rappel discret. */
const OfflineNote: React.FC = () => {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="fixed bottom-3 left-1/2 z-[9000] -translate-x-1/2 rounded-full border border-amber-400/30 bg-[#16140c]/95 px-4 py-2 text-[11px] text-amber-100 shadow-lg" role="status">
      Hors ligne : studio ouvert avec ton compte vérifié récemment.
      <button type="button" className="ml-3 underline" onClick={() => setHidden(true)}>OK</button>
    </div>
  );
};

export default DesktopAccessGate;
