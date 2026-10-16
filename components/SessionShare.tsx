import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState } from '../types';
import { catalogSupabase } from '../services/supabase';
import { claimSession, signInAccount } from '../services/SessionCloud';
import { createForkLink, ForkError, listForkLinks, openForkCopy, revokeForkLink, type ForkCopy, type SessionKey } from '../services/SessionFork';
import { getPublicTrack, publishTrack, PublicTrackError, setPublished } from '../services/PublicTracks';
import { exportAccess, type ExportAccess } from '../services/Billing';
import { appBase } from '../utils/listenLink';
import { catalogIdsOf, projectUsesKits } from '../utils/exportProject';
import { exportKeyOf } from '../utils/exportRights';
import {
  copiesText, forkErrorCode, forkErrorView, forkUrl, MAX_FORK_LINKS, parseForkToken, withoutForkToken,
  type ForkErrorCode, type ForkLinkInfo,
} from '../utils/sessionFork';
import {
  embedCode, EXTRAIT_SECONDES, fmtDuration, playsText, publicTrackUrl, publishChoices,
  type PublicKind, type PublicTrackOwner,
} from '../utils/publicTrack';

/**
 * 1.5.1 · Partager sa séance autrement (masqué en mode simple : palette Ctrl+K, guide, chatbot) :
 *  - « Faire sa version » (lot 9a) : un lien qui donne à CHACUN sa propre copie privée de la
 *    séance (pistes, tempo, accords), sans accès à l'original. Pour le beatmaker qui envoie sa
 *    séance à plusieurs rappeurs. Compteur de copies, lien désactivable.
 *  - « Page publique » (lot 9b) : une page du morceau (lecteur, pochette, crédits, paroles en
 *    option), un lecteur à intégrer sur un site, et « Réserver au studio Make Music ». Publication
 *    par choix explicite, désactivable ; l'extrait ou le mix, jamais les pistes ; pas de téléchargement.
 *  - L'ARRIVÉE du destinataire d'un lien « Faire sa version » (#copie=… dans l'adresse) : il se
 *    connecte (compte gratuit) et reçoit sa version, ouverte dans le studio.
 */

export type ShareTab = 'fork' | 'public';

interface Props {
  /** Fenêtre ouverte sur un onglet (null : fermée ; l'arrivée d'un lien s'affiche quand même). */
  tab: ShareTab | null;
  onTab: (tab: ShareTab | null) => void;
  state: DAWState;
  ownedInstrumentIds: (string | number)[];
  /** Séance en ligne de CE projet, sans rien envoyer (null : pas encore en ligne). */
  currentSession: () => SessionKey | null;
  /** Met la séance en ligne (ou envoie ses derniers changements) ; null : impossible. */
  ensureOnline: () => Promise<SessionKey | null>;
  /** Le destinataire a sa copie : l'ouvrir dans le studio. */
  onOpenCopy: (copy: ForkCopy) => void;
  notify: (msg: string) => void;
}

const btn = 'nova-hit-tactile inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-[13px] font-black transition-colors disabled:opacity-50';
const field = 'w-full min-h-11 rounded-xl border border-white/10 bg-black/30 px-3 text-[14px] text-white placeholder:text-slate-500';

const baseUrl = () => {
  try { return appBase(window.location, !!(window as any).__novaDesktop, import.meta.env.BASE_URL); } catch { return appBase(null, true); }
};

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* repli */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Connecté au compte Make Music ? (suit les connexions / déconnexions) */
function useSignedIn(): boolean | null {
  const [signed, setSigned] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void catalogSupabase.auth.getUser().then(({ data }) => { if (live) setSigned(!!data?.user); }).catch(() => { if (live) setSigned(false); });
    const { data } = catalogSupabase.auth.onAuthStateChange((_e, s) => { if (live) setSigned(!!s?.user); });
    return () => { live = false; data?.subscription?.unsubscribe(); };
  }, []);
  return signed;
}

/** Connexion (ou compte gratuit créé) sans quitter NOVA. */
const InlineLogin: React.FC<{ title: string; onDone: () => void; testid: string }> = ({ title, onDone, testid }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signUp, setSignUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (signUp) {
        const { data, error } = await catalogSupabase.auth.signUp({ email: email.trim(), password });
        if (error) {
          const m = String(error.message || '');
          throw new Error(/already/i.test(m) ? 'Ce mail a déjà un compte : touche « J’ai déjà un compte ».' : /password/i.test(m) ? 'Mot de passe trop court : 6 caractères au moins.' : `Création du compte impossible : ${m}`);
        }
        if (!data?.session) throw new Error('Compte créé ! Ouvre le mail de confirmation, puis reviens ici et touche « J’ai déjà un compte ».');
      } else {
        await signInAccount(email, password);
      }
      onDone();
    } catch (e: any) { setErr(e?.message || 'Connexion impossible'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid={testid}>
      <p className="text-[13px] font-bold text-white">{signUp ? 'Crée ton compte Make Music (gratuit, 1 minute)' : title}</p>
      <input type="email" autoComplete="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mail" aria-label="E-mail" className={field} />
      <input type="password" autoComplete={signUp ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)}
        placeholder={signUp ? 'Choisis un mot de passe (6 caractères min.)' : 'Mot de passe'} aria-label="Mot de passe" className={field} />
      {err && <p role="alert" className="text-[12px] text-red-300">{err}</p>}
      <button type="submit" disabled={busy || !email || !password} className={`${btn} w-full bg-white text-black`}>{busy ? 'Connexion…' : signUp ? 'Créer mon compte' : 'Me connecter'}</button>
      <button type="button" onClick={() => { setSignUp(s => !s); setErr(null); }} className="min-h-11 w-full text-center text-[12px] text-cyan-300 underline">
        {signUp ? "J'ai déjà un compte" : 'Pas encore de compte ? Crée-le ici (gratuit)'}
      </button>
    </form>
  );
};

const SessionShare: React.FC<Props> = (p) => {
  // ─── Arrivée d'un lien « Faire sa version » ─────────────────────────────────────────────
  const [token, setToken] = useState<string | null>(() => (typeof window !== 'undefined' ? parseForkToken(window.location.hash) : null));
  useEffect(() => {
    const onHash = () => { const t = parseForkToken(window.location.hash); if (t) setToken(t); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const signedIn = useSignedIn();

  if (token) return <ForkArrival token={token} signedIn={signedIn} onClose={() => { setToken(null); try { window.history.replaceState(null, '', withoutForkToken(window.location.href)); } catch { /* */ } }} onOpenCopy={p.onOpenCopy} />;
  if (!p.tab) return null;
  return <ShareDialog {...p} tab={p.tab} signedIn={signedIn} />;
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Arrivée du destinataire
// ─────────────────────────────────────────────────────────────────────────────────────────

const ForkArrival: React.FC<{ token: string; signedIn: boolean | null; onClose: () => void; onOpenCopy: (c: ForkCopy) => void }> = ({ token, signedIn, onClose, onOpenCopy }) => {
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [error, setError] = useState<{ code: ForkErrorCode; message?: string } | null>(null);
  const go = async () => {
    setError(null);
    setProgress({ pct: 1, msg: 'Ouverture du lien…' });
    try {
      const copy = await openForkCopy(token, (pct, msg) => setProgress({ pct, msg }));
      (window as any).__novaFork = { last: { fingerprint: copy.fingerprint, files: copy.files, name: copy.name, copies: copy.copies } };
      onOpenCopy(copy);
      onClose();
    } catch (e: any) {
      const err = e as ForkError;
      setError({ code: forkErrorCode(err.status, err.code), message: err.message });
    } finally { setProgress(null); }
  };
  const ev = error ? forkErrorView(error.code, error.message) : null;
  return (
    <div className="fixed inset-0 z-[650] flex items-end justify-center bg-black/75 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="fork-arrival-t" data-testid="fork-arrival">
      <div className="flex max-h-[100dvh] w-full max-w-md flex-col overflow-y-auto rounded-t-3xl border border-white/10 bg-nv-surface p-5 text-white sm:rounded-3xl">
        <p className="text-[34px] leading-none" aria-hidden>🎁</p>
        <h2 id="fork-arrival-t" className="mt-2 text-[20px] font-black">On t’envoie une séance : fais ta version</h2>
        <p className="mt-1 text-[14px] leading-snug text-slate-300">Tu reçois <b>ta propre copie</b> : les pistes, le tempo et les accords. Ce que tu y changes reste chez toi, l’original ne bouge pas.</p>
        <ul className="mt-3 space-y-1 text-[13px] text-slate-300">
          <li>🎟️ Gratuit : un compte suffit.</li>
          <li>🛒 Une instru du catalogue n’est pas copiée : tu la retrouves dans le catalogue, et sa licence reste à acheter pour exporter.</li>
        </ul>
        {ev && (
          <div role="alert" data-testid="fork-arrival-error" data-code={error!.code} className="mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 p-3">
            <p className="text-[15px] font-black">{ev.title}</p>
            <p className="text-[13px] text-slate-200">{ev.text}</p>
          </div>
        )}
        {signedIn === false && (!error || error.code === 'login') ? (
          <div className="mt-4"><InlineLogin title="Connecte-toi pour récupérer ta version" testid="fork-arrival-login" onDone={() => { setError(null); }} /></div>
        ) : (
          (!ev || ev.retry || error?.code === 'login') && (
            <button type="button" data-testid="fork-arrival-go" disabled={!!progress || signedIn === null} onClick={() => void go()}
              className={`${btn} mt-4 h-12 w-full bg-cyan-400 text-[15px] text-black`}>
              {progress ? `${progress.msg} ${progress.pct} %` : ev?.retry ? 'Réessayer' : 'Créer ma version'}
            </button>
          )
        )}
        {progress && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden><div className="h-full bg-cyan-400 transition-all" style={{ width: `${progress.pct}%` }} /></div>}
        <button type="button" onClick={onClose} disabled={!!progress} className="mt-2 min-h-11 w-full text-center text-[13px] text-slate-400 underline">Pas maintenant</button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Fenêtre de l'hôte : deux onglets
// ─────────────────────────────────────────────────────────────────────────────────────────

type DialogProps = Props & { tab: ShareTab; signedIn: boolean | null };

const ShareDialog: React.FC<DialogProps> = (p) => {
  const tabBtn = (t: ShareTab, label: string) => (
    <button type="button" role="tab" aria-selected={p.tab === t} data-testid={`share-tab-${t}`} onClick={() => p.onTab(t)}
      className={`min-h-11 flex-1 rounded-xl px-2 text-[13px] font-black ${p.tab === t ? 'bg-white text-black' : 'bg-white/10 text-slate-200'}`}>{label}</button>
  );
  return (
    <div className="fixed inset-0 z-[600] flex items-end justify-center bg-black/70 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="share-session-t" data-testid="share-session"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); p.onTab(null); } }}>
      <div className="flex max-h-[100dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-nv-surface text-white sm:max-h-[92vh] sm:rounded-3xl">
        <header className="flex shrink-0 items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="share-session-t" className="text-[18px] font-black">🔗 Partager ta séance</h2>
            <p className="text-[13px] text-slate-400">Une copie pour chacun, ou une page publique de ton morceau.</p>
          </div>
          <button type="button" onClick={() => p.onTab(null)} aria-label="Fermer" className="h-11 w-11 shrink-0 rounded-xl bg-white/10 text-[16px] font-black">✕</button>
        </header>
        <div className="flex shrink-0 gap-2 px-5 pt-3" role="tablist">
          {tabBtn('fork', '🎁 Faire sa version')}
          {tabBtn('public', '🌍 Page publique')}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {p.signedIn === false ? (
            <div className="space-y-3">
              <p className="text-[14px] text-slate-300">Connecte-toi : le lien et la page sont rattachés à ton compte, toi seul peux les gérer.</p>
              <InlineLogin title="Ton compte Make Music" testid="share-login" onDone={() => { /* useSignedIn suit la connexion */ }} />
            </div>
          ) : p.tab === 'fork' ? <ForkTab {...p} /> : <PublicTab {...p} />}
        </div>
      </div>
    </div>
  );
};

/** Séance en ligne ET rattachée à mon compte (rattachée automatiquement si elle n'a pas encore de propriétaire). */
async function withOwnedSession<T>(s: SessionKey, run: (s: SessionKey) => Promise<T>): Promise<T> {
  try { return await run(s); } catch (e: any) {
    if (e?.code !== 'not_owner') throw e;
    try { await claimSession({ id: s.id, secret: s.secret }); } catch { throw new Error('Cette séance en ligne appartient à un autre compte : seul son propriétaire peut la partager ainsi.'); }
    return run(s);
  }
}

const ForkTab: React.FC<DialogProps> = (p) => {
  const [links, setLinks] = useState<ForkLinkInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** Serveur pas encore à jour (fonction daw-fork absente) : rien à créer pour l'instant. */
  const [off, setOff] = useState(false);

  // Le panneau suit la séance par une référence : App se redessine souvent, la liste n'est relue
  // qu'à l'ouverture, à la connexion et après une action (pas à chaque image).
  const sessionRef = useRef(p.currentSession);
  sessionRef.current = p.currentSession;
  const refresh = useCallback(async () => {
    const s = sessionRef.current();
    if (!s) { setLinks([]); return; }
    try { setLinks(await withOwnedSession(s, listForkLinks)); } catch (e: any) { setLinks([]); setErr(e?.message || null); if ((e as ForkError)?.code === 'not_deployed') setOff(true); }
  }, []);
  useEffect(() => { if (p.signedIn) void refresh(); }, [p.signedIn, refresh]);

  const create = async () => {
    setErr(null); setNote(null);
    setBusy('Mise en ligne de ta séance…');
    try {
      const s = await p.ensureOnline();
      if (!s) throw new Error('Ta séance n’a pas pu être mise en ligne. Vérifie ta connexion ; en gratuit, un seul projet en ligne à la fois (« Mes sessions en ligne »).');
      setBusy('Création du lien…');
      const r = await withOwnedSession(s, k => createForkLink(k, { label: label.trim(), name: p.state.name }));
      setLabel('');
      if (r.catalog_tracks > 0) setNote('L’instru du catalogue n’est pas copiée : chacun la retrouve dans le catalogue (licence à acheter pour exporter).');
      await refresh();
      const url = forkUrl(r.link.token, baseUrl());
      if (await copyText(url)) { setCopied(r.link.id); window.setTimeout(() => setCopied(c => (c === r.link.id ? null : c)), 2500); }
      p.notify('🎁 Lien « Faire sa version » créé et copié : chacun aura sa propre copie, ton original ne bouge pas.');
    } catch (e: any) { setErr(e?.message || 'Création impossible'); if ((e as ForkError)?.code === 'not_deployed') setOff(true); } finally { setBusy(null); }
  };
  const revoke = async (l: ForkLinkInfo) => {
    const s = p.currentSession();
    if (!s) return;
    setBusy('Désactivation…'); setErr(null);
    try { await withOwnedSession(s, k => revokeForkLink(k, l.id)); await refresh(); p.notify('Lien désactivé : il ne donne plus de copie (les copies déjà faites restent chez leurs auteurs).'); }
    catch (e: any) { setErr(e?.message || 'Désactivation impossible'); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4" data-testid="share-fork">
      <div className="rounded-2xl bg-white/[0.04] p-3 text-[13px] leading-snug text-slate-300">
        <p className="font-bold text-white">Pour envoyer ta séance à plusieurs artistes</p>
        <p>Chacun ouvre le lien, se connecte (gratuit) et reçoit <b>sa propre copie</b> : pistes, tempo, accords. Ce qu’il change reste chez lui ; ta séance ne bouge pas. La copie reprend ta séance telle qu’elle est quand tu crées le lien.</p>
      </div>
      <div className="space-y-2">
        <label className="block space-y-1">
          <span className="text-[12px] font-bold text-slate-300">Pour qui ? (facultatif)</span>
          <input value={label} onChange={e => setLabel(e.target.value.slice(0, 60))} placeholder="Ex. : rappeurs du 93, Nina…" data-testid="fork-label" className={field} />
        </label>
        <button type="button" data-testid="fork-create" disabled={!!busy || off || (links?.length || 0) >= MAX_FORK_LINKS} onClick={() => void create()}
          className={`${btn} h-12 w-full bg-cyan-400 text-[14px] text-black`}>{busy || '🎁 Créer le lien « Faire sa version »'}</button>
        {(links?.length || 0) >= MAX_FORK_LINKS && <p className="text-[12px] text-amber-200">{MAX_FORK_LINKS} liens actifs au plus : désactives-en un pour en créer un autre.</p>}
      </div>
      {note && <p className="rounded-xl bg-amber-500/10 p-2 text-[12px] text-amber-100" data-testid="fork-catalog-note">🛒 {note}</p>}
      {err && <p role="alert" data-testid="fork-error" className="rounded-xl bg-red-500/10 p-2 text-[13px] text-red-200">{err}</p>}
      <section aria-label="Tes liens" data-testid="fork-links" className="space-y-2">
        <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-400">Tes liens actifs</h3>
        {links === null ? <p className="text-[13px] text-slate-400">Chargement…</p>
          : links.length === 0 ? <p className="text-[13px] text-slate-400" data-testid="fork-empty">Aucun lien pour l’instant. Crée-en un ci-dessus, puis envoie-le (WhatsApp, Insta, mail).</p>
            : links.map(l => {
              const url = forkUrl(l.token, baseUrl());
              return (
                <div key={l.id} className="space-y-2 rounded-2xl bg-white/[0.04] p-3" data-testid="fork-link" data-copies={l.copies}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[14px] font-black">{l.label || l.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[12px] font-black ${l.copies > 0 ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/10 text-slate-300'}`} data-testid="fork-copies">{copiesText(l.copies)}</span>
                  </div>
                  <input readOnly value={url} onFocus={e => e.currentTarget.select()} aria-label="Lien à envoyer" data-testid="fork-url" className={`${field} font-mono text-[12px]`} />
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" data-testid="fork-copy" onClick={async () => { if (await copyText(url)) { setCopied(l.id); window.setTimeout(() => setCopied(c => (c === l.id ? null : c)), 2500); } }}
                      className={`${btn} bg-white text-black`}>{copied === l.id ? '✅ Copié' : '📋 Copier le lien'}</button>
                    <button type="button" data-testid="fork-revoke" disabled={!!busy} onClick={() => void revoke(l)} className={`${btn} bg-white/10 text-slate-200`}>Désactiver</button>
                  </div>
                </div>
              );
            })}
      </section>
    </div>
  );
};

const PublicTab: React.FC<DialogProps> = (p) => {
  const st = p.state;
  const [page, setPage] = useState<PublicTrackOwner | null | undefined>(undefined);
  const [title, setTitle] = useState(st.name || '');
  const [artist, setArtist] = useState('');
  const [credits, setCredits] = useState(st.beatTitle ? `Instru : ${st.beatTitle}` : '');
  const [showLyrics, setShowLyrics] = useState(false);
  const [kind, setKind] = useState<PublicKind>('extrait');
  const [consent, setConsent] = useState(false);
  const [access, setAccess] = useState<ExportAccess | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'embed' | null>(null);
  const [editing, setEditing] = useState(false);
  /** Serveur pas encore à jour (pages publiques absentes) : on n'envoie pas le son pour rien. */
  const [off, setOff] = useState(false);
  const hasLyrics = !!(st.lyrics || '').trim();
  const exportKey = exportKeyOf(st);
  const catalogIds = useMemo(() => catalogIdsOf(st.tracks), [st.tracks]);
  const kits = useMemo(() => projectUsesKits(st.tracks), [st.tracks]);
  const choices = publishChoices(access);

  useEffect(() => {
    if (!p.signedIn) return;
    const s = p.currentSession();
    if (!s) { setPage(null); return; }
    let live = true;
    void withOwnedSession(s, getPublicTrack).then(pg => {
      if (!live) return;
      setPage(pg);
      if (pg) { setTitle(pg.title); setArtist(pg.artist); setCredits(pg.credits); setShowLyrics(pg.show_lyrics); setKind(pg.kind); }
    }).catch((e: any) => { if (live) { setPage(null); if ((e as PublicTrackError)?.code === 'not_deployed') { setErr(e.message); setOff(true); } } });
    return () => { live = false; };
  }, [p.signedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!exportKey) { setAccess({ unlocked: false, via: null, reason: 'paiement', missing: [], login_required: false, kits, pro: null, legacy: false }); return; }
    let live = true;
    void exportAccess({ projectKey: exportKey, catalogIds, kits, scope: 'mix', owned: p.ownedInstrumentIds.map(String) }).then(a => { if (live) setAccess(a); });
    return () => { live = false; };
  }, [exportKey, catalogIds, kits, p.ownedInstrumentIds]);
  useEffect(() => { if (kind === 'mix' && access && !choices.mix) setKind('extrait'); }, [access, choices.mix, kind]);

  const url = page ? publicTrackUrl(page.id, baseUrl()) : null;
  const doCopy = async (what: 'url' | 'embed', text: string) => { if (await copyText(text)) { setCopied(what); window.setTimeout(() => setCopied(c => (c === what ? null : c)), 2500); } };

  const publish = async () => {
    setErr(null);
    if (!title.trim()) { setErr('Donne un titre au morceau.'); return; }
    if (!consent) { setErr('Coche « Je publie ce morceau » pour confirmer.'); return; }
    try {
      setBusy('Mise en ligne de ta séance…');
      const s = await p.ensureOnline();
      if (!s) throw new Error('Ta séance n’a pas pu être mise en ligne. Vérifie ta connexion ; en gratuit, un seul projet en ligne à la fois (« Mes sessions en ligne »).');
      const { renderPublicAudio, renderCover, uploadPublicAudio } = await import('../services/publicAudio');
      setBusy(kind === 'extrait' ? `Rendu de l’extrait (${EXTRAIT_SECONDES} s)…` : 'Rendu du morceau…');
      const audio = await renderPublicAudio(st, kind, pct => setBusy(`Rendu… ${Math.round(pct)} %`));
      const cover = await renderCover(st);
      setBusy('Envoi du son…');
      const up = await uploadPublicAudio(s, audio.bytes, cover);
      setBusy('Publication…');
      const pg = await withOwnedSession(s, k => publishTrack(k, {
        title: title.trim(), artist: artist.trim(), credits: credits.trim(), lyrics: hasLyrics ? st.lyrics || '' : '', showLyrics: showLyrics && hasLyrics,
        kind, audio: { parts: up.parts, size: up.size, duration: audio.duration, mime: audio.mime }, coverPart: up.coverPart, exportKey, kits,
      }));
      setPage(pg); setEditing(false); setConsent(false);
      p.notify('🌍 Ton morceau est publié : copie le lien de la page ou le lecteur à intégrer.');
    } catch (e: any) { setErr(e?.message || 'Publication impossible'); } finally { setBusy(null); }
  };
  const toggle = async (on: boolean) => {
    const s = p.currentSession();
    if (!s || !page) return;
    setBusy(on ? 'Remise en ligne…' : 'Retrait de la page…'); setErr(null);
    try { setPage(await withOwnedSession(s, k => setPublished(k, on))); p.notify(on ? '🌍 Page de nouveau en ligne.' : 'Page retirée : le lien affiche « Ce morceau n’est plus publié ».'); }
    catch (e: any) { setErr(e?.message || 'Modification impossible'); } finally { setBusy(null); }
  };

  const showForm = page === null || editing;
  return (
    <div className="space-y-4" data-testid="share-public">
      {page && (
        <section className="space-y-2 rounded-2xl bg-white/[0.04] p-3" data-testid="pub-status" data-published={page.published ? '1' : '0'}>
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[15px] font-black">{page.title}</p>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[12px] font-black ${page.published ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/10 text-slate-300'}`}>{page.published ? 'En ligne' : 'Retirée'}</span>
          </div>
          <p className="text-[12px] text-slate-400">{page.kind === 'mix' ? 'Morceau entier' : 'Extrait'} · {fmtDuration(page.duration)} · {playsText(page.plays)}</p>
          {page.published && url && (
            <>
              <input readOnly value={url} onFocus={e => e.currentTarget.select()} aria-label="Lien de la page" data-testid="pub-url" className={`${field} font-mono text-[12px]`} />
              <div className="grid grid-cols-2 gap-2">
                <button type="button" data-testid="pub-copy" onClick={() => void doCopy('url', url)} className={`${btn} bg-white text-black`}>{copied === 'url' ? '✅ Copié' : '📋 Copier le lien'}</button>
                <a href={url} target="_blank" rel="noopener noreferrer" className={`${btn} bg-white/10 text-slate-100`}>Voir la page ↗</a>
              </div>
              <label className="block space-y-1">
                <span className="text-[12px] font-bold text-slate-300">Lecteur à intégrer sur ton site</span>
                <textarea readOnly value={embedCode(page.id, baseUrl(), page.title)} rows={3} onFocus={e => e.currentTarget.select()} data-testid="pub-embed" className={`${field} py-2 font-mono text-[11px]`} />
              </label>
              <button type="button" data-testid="pub-copy-embed" onClick={() => void doCopy('embed', embedCode(page.id, baseUrl(), page.title))} className={`${btn} w-full bg-white/10 text-slate-100`}>{copied === 'embed' ? '✅ Copié' : '</> Copier le code du lecteur'}</button>
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" data-testid="pub-toggle" disabled={!!busy} onClick={() => void toggle(!page.published)} className={`${btn} ${page.published ? 'bg-white/10 text-slate-200' : 'bg-emerald-400 text-black'}`}>{page.published ? 'Retirer la page' : 'Remettre en ligne'}</button>
            <button type="button" data-testid="pub-edit" disabled={!!busy} onClick={() => setEditing(e => !e)} className={`${btn} bg-white/10 text-slate-200`}>{editing ? 'Annuler' : 'Mettre à jour le son'}</button>
          </div>
        </section>
      )}
      {page === undefined && <p className="text-[13px] text-slate-400">Chargement…</p>}
      {showForm && page !== undefined && (
        <section className="space-y-3" aria-label="Publier">
          {!page && (
            <div className="rounded-2xl bg-white/[0.04] p-3 text-[13px] leading-snug text-slate-300">
              <p className="font-bold text-white">Une page pour faire écouter ton morceau</p>
              <p>Lecteur, pochette, crédits, et un bouton « Réserver au studio Make Music ». Pas de téléchargement, jamais tes pistes séparées. Tu la retires quand tu veux.</p>
            </div>
          )}
          <label className="block space-y-1"><span className="text-[12px] font-bold text-slate-300">Titre</span>
            <input value={title} onChange={e => setTitle(e.target.value.slice(0, 80))} data-testid="pub-title" className={field} /></label>
          <label className="block space-y-1"><span className="text-[12px] font-bold text-slate-300">Artiste (facultatif)</span>
            <input value={artist} onChange={e => setArtist(e.target.value.slice(0, 60))} placeholder="Ton nom d'artiste" data-testid="pub-artist" className={field} /></label>
          <label className="block space-y-1"><span className="text-[12px] font-bold text-slate-300">Crédits (facultatif)</span>
            <input value={credits} onChange={e => setCredits(e.target.value.slice(0, 500))} placeholder="Prod., mix, featuring…" data-testid="pub-credits" className={field} /></label>
          {hasLyrics && (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-white/[0.04] px-3 text-[13px]">
              <input type="checkbox" checked={showLyrics} onChange={e => setShowLyrics(e.target.checked)} data-testid="pub-lyrics" className="h-5 w-5 accent-cyan-400" />
              <span>Afficher mes paroles sur la page</span>
            </label>
          )}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Ce que tu publies">
            <button type="button" role="radio" aria-checked={kind === 'extrait'} data-testid="pub-kind-extrait" onClick={() => setKind('extrait')}
              className={`min-h-12 rounded-xl px-2 text-[13px] font-bold ${kind === 'extrait' ? 'bg-white text-black' : 'bg-white/10 text-slate-100'}`}>Extrait {EXTRAIT_SECONDES} s</button>
            <button type="button" role="radio" aria-checked={kind === 'mix'} data-testid="pub-kind-mix" disabled={!choices.mix} onClick={() => setKind('mix')}
              className={`min-h-12 rounded-xl px-2 text-[13px] font-bold disabled:opacity-50 ${kind === 'mix' ? 'bg-white text-black' : 'bg-white/10 text-slate-100'}`}>Morceau entier</button>
          </div>
          {!choices.mix && choices.why && access && <p className="text-[12px] text-slate-400" data-testid="pub-mix-why">🔒 {choices.why}</p>}
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px]">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} data-testid="pub-consent" className="mt-0.5 h-5 w-5 shrink-0 accent-cyan-400" />
            <span><b>Je publie ce morceau.</b> La page sera visible par toute personne qui a le lien. Pas de téléchargement, pas de pistes séparées ; je peux la retirer à tout moment.</span>
          </label>
          <button type="button" data-testid="pub-publish" disabled={!!busy || off || !consent || !title.trim()} onClick={() => void publish()}
            className={`${btn} h-12 w-full bg-cyan-400 text-[14px] text-black`}>{busy || (page ? 'Mettre à jour la page' : '🌍 Publier la page')}</button>
        </section>
      )}
      {busy && !showForm && <p role="status" className="text-[13px] text-slate-300">{busy}</p>}
      {err && <p role="alert" data-testid="pub-error" className="rounded-xl bg-red-500/10 p-2 text-[13px] text-red-200">{err}</p>}
    </div>
  );
};

export default SessionShare;
