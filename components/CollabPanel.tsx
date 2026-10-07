import React, { useEffect, useRef, useState } from 'react';
import { CollabRole } from '../types';
import { CollabMember, ROLE_LABEL } from '../services/Collab';
import type { CollabStatusView } from '../utils/collabStatus';

/**
 * Collaboration à distance : inviter un ingé son / un beatmaker / un artiste
 * (lien par rôle), voir qui est connecté, discuter. Qui fait quoi :
 * l'artiste enregistre et édite ses voix, l'ingé son règle le mix (effets
 * Nova, ou ses VST en gelant la piste), le beatmaker ajoute ses pistes.
 */
export interface CollabMessage { id: string; from: string; role: CollabRole; text: string; at: number; mine?: boolean; /** Pas encore parti (hors ligne) : « envoi… ». */ pending?: boolean }

interface Props {
  open: boolean;
  onClose: () => void;
  active: boolean;
  role: CollabRole | null;
  name: string;
  members: CollabMember[];
  messages: CollabMessage[];
  inviteUrl: (role: CollabRole) => string | null;
  onStart: (role: CollabRole, name: string) => void;
  onLeave: () => void;
  onSend: (text: string) => void;
  busy?: string | null;
  /** Il faut d'abord se connecter (compte Make Music) ou s'abonner (5 €/mois). */
  gate?: 'login' | 'subscribe' | null;
  onSignIn?: (email: string, password: string) => Promise<void>;
  onSubscribe?: () => void;
  /** Mode « Ingé à distance (ses propres VST) » : chacun sa session (voir RemoteIngePanel). */
  onStartRemote?: (role: 'artist' | 'engineer', name: string, link?: string) => void;
  remoteBusy?: string | null;
  remoteError?: string | null;
  /** Lien reçu (?inge=…) : le panneau s'ouvre sur « Ingé à distance », rôle ingé. */
  remoteLinkFromUrl?: string | null;
  /** Lien enregistré avec le projet mais pas connecté : « Reprendre ». */
  savedRemote?: { role: 'artist' | 'engineer' } | null;
  /** En direct, côté ingé : réglage à distance des VST du PC de l'artiste. */
  liveVst?: React.ReactNode;
  /** État de la connexion (en direct, rattrapage, hors ligne, envoi…). */
  status?: CollabStatusView | null;
  onRetry?: () => void;
  onReload?: () => void;
}

const STATUS_TONE: Record<CollabStatusView['tone'], { dot: string; text: string; box: string }> = {
  ok: { dot: 'bg-emerald-400', text: 'text-emerald-200', box: 'border-emerald-500/20 bg-emerald-500/[0.06]' },
  busy: { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-200', box: 'border-sky-500/20 bg-sky-500/[0.06]' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-100', box: 'border-amber-500/30 bg-amber-500/10' },
  error: { dot: 'bg-red-400', text: 'text-red-100', box: 'border-red-500/30 bg-red-500/10' },
};

export type CollabMode = 'live' | 'remote';

/** Les deux modes, expliqués en une phrase au moment du choix. */
export const MODE_INFO: Record<CollabMode, { title: string; help: string }> = {
  live: {
    title: 'En direct',
    help: "L'ingé travaille dans TA session, comme à côté de toi : mêmes effets (ceux de NOVA et les VST installés sur ton PC), tout se voit en direct.",
  },
  remote: {
    title: 'Ingé à distance (ses propres VST)',
    help: "Chacun garde sa session : tu envoies tes pistes, l'ingé les traite avec SES VST (que tu n'as pas) et te renvoie le rendu, que tu peux encore éditer.",
  },
};

const ROLE_HELP: Record<CollabRole, string> = {
  artist: 'enregistre et édite ses voix ; peut verrouiller le volume d\'une piste',
  engineer: 'règle volumes, effets Nova et envois (ou ses VST : la piste est gelée puis envoyée)',
  beatmaker: 'ajoute batterie, basse et ses propres pistes',
};
const REMOTE_ROLE_HELP: Record<CollabRole, string> = {
  artist: "enregistre, envoie ses pistes à l'ingé et reçoit ses réglages (navigateur, tablette ou téléphone : pas besoin de VST)",
  engineer: "reçoit les pistes dans SA session et les traite avec ses VST (appli NOVA Studio pour Windows), puis les renvoie",
  beatmaker: '',
};
const ROLE_COLOR: Record<CollabRole, string> = { artist: 'text-cyan-300', engineer: 'text-amber-300', beatmaker: 'text-violet-300' };

const CollabPanel: React.FC<Props> = (p) => {
  const [text, setText] = useState('');
  const [startRole, setStartRole] = useState<CollabRole>(p.remoteLinkFromUrl ? 'engineer' : 'artist');
  const [mode, setMode] = useState<CollabMode>(p.remoteLinkFromUrl || p.savedRemote ? 'remote' : 'live');
  const [remoteLink, setRemoteLink] = useState(p.remoteLinkFromUrl || '');
  useEffect(() => { if (p.remoteLinkFromUrl) { setMode('remote'); setStartRole('engineer'); setRemoteLink(p.remoteLinkFromUrl); } }, [p.remoteLinkFromUrl]);
  const [startName, setStartName] = useState('');
  const [copied, setCopied] = useState<CollabRole | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signErr, setSignErr] = useState<string | null>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [p.messages.length, p.open]);
  if (!p.open) return null;

  const copy = async (r: CollabRole) => {
    const url = p.inviteUrl(r);
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(r); setTimeout(() => setCopied(null), 1600); } catch { /* */ }
  };
  const send = () => { const t = text.trim(); if (t) { p.onSend(t); setText(''); } };
  const btn = 'h-10 rounded-xl px-3 text-[12px] font-black transition-colors disabled:opacity-40';

  return (
    <div className="fixed right-3 bottom-20 md:bottom-4 z-[640] w-[min(380px,calc(100vw-24px))] max-h-[min(640px,calc(100vh-110px))] flex flex-col rounded-3xl border border-white/10 bg-[#121418]/[0.97] shadow-2xl backdrop-blur" role="dialog" aria-labelledby="collab-title">
      <div className="flex items-center gap-2 p-4 border-b border-white/5">
        <h2 id="collab-title" className="flex-1 text-[14px] font-black text-white">👥 Collaboration</h2>
        {p.active && p.status && <span data-testid="collab-status-short" className={`inline-flex items-center gap-1.5 text-[10px] font-black ${STATUS_TONE[p.status.tone].text}`}><span className={`w-1.5 h-1.5 rounded-full ${STATUS_TONE[p.status.tone].dot}`} />{p.status.short}</span>}
        {p.active && p.role && <span className={`text-[11px] font-black ${ROLE_COLOR[p.role]}`}>{ROLE_LABEL[p.role]}</span>}
        <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-9 h-9 rounded-xl bg-white/5 text-slate-300">✕</button>
      </div>

      {!p.active ? (
        <div className="p-4 space-y-3 overflow-y-auto">
          <fieldset className="space-y-1.5" aria-label="Mode de collaboration">
            <legend className="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1">Comment vous travaillez ?</legend>
            {(['live', 'remote'] as CollabMode[]).map(m => (
              <label key={m} data-testid={`collab-mode-${m}`} className={`block cursor-pointer rounded-2xl border p-3 transition-colors ${mode === m ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]'}`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="collab-mode" checked={mode === m} onChange={() => { setMode(m); if (m === 'remote' && startRole === 'beatmaker') setStartRole('artist'); }} className="accent-cyan-400" />
                  <span className="text-[13px] font-black text-white">{MODE_INFO[m].title}</span>
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-slate-300">{MODE_INFO[m].help}</span>
              </label>
            ))}
          </fieldset>
          <label className="block text-[11px] text-slate-400">Ton rôle
            <select value={startRole} onChange={e => setStartRole(e.target.value as CollabRole)} data-testid="collab-role"
              className="mt-1 h-11 w-full rounded-xl border border-white/10 bg-black/40 px-2 text-[13px] font-bold text-white">
              {(mode === 'remote' ? ['artist', 'engineer'] as CollabRole[] : ['artist', 'engineer', 'beatmaker'] as CollabRole[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-slate-500">{ROLE_LABEL[startRole]} : {mode === 'remote' ? REMOTE_ROLE_HELP[startRole] : ROLE_HELP[startRole]}.</p>
          {mode === 'remote' && startRole === 'engineer' && (
            <input value={remoteLink} onChange={e => setRemoteLink(e.target.value)} placeholder="Colle le lien envoyé par l'artiste (…?inge=…)" aria-label="Lien de l'artiste" data-testid="remote-link-input"
              className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[12px] text-white" />
          )}
          <input value={startName} onChange={e => setStartName(e.target.value)} placeholder="Ton nom (affiché aux autres)"
            className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
          {p.gate === 'login' && p.onSignIn && (
            <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[12px] font-bold text-white">Connecte-toi avec ton compte Make Music</p>
              <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mail" className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
              <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mot de passe" className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
              <button type="button" disabled={!email || !password} className={`${btn} w-full bg-white text-black`}
                onClick={async () => { setSignErr(null); try { await p.onSignIn!(email, password); setPassword(''); } catch (e: any) { setSignErr(e?.message || 'Connexion impossible'); } }}>Se connecter</button>
              {signErr && <p className="text-[11px] text-red-300">{signErr}</p>}
              <a href="https://www.studiomakemusic.com/auth" target="_blank" rel="noopener noreferrer" className="block text-center text-[11px] text-cyan-300 underline">Créer un compte sur studiomakemusic.com</a>
            </div>
          )}
          {p.gate === 'subscribe' && p.onSubscribe && (
            <div className="space-y-2 rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3">
              <p className="text-[12px] font-bold text-white">Abonnement collaboration : 5 € / mois</p>
              <p className="text-[11px] text-slate-300">Pour chaque compte qui collabore (artiste, ingé son, beatmaker). Sans engagement, résiliable quand tu veux.</p>
              <button type="button" disabled={!!p.busy} onClick={p.onSubscribe} className={`${btn} w-full bg-violet-500 text-white`}>{p.busy || "M'abonner (paiement sécurisé Stripe)"}</button>
            </div>
          )}
          {mode === 'live' ? (
            <>
              <button type="button" disabled={!!p.busy} onClick={() => p.onStart(startRole, startName.trim() || ROLE_LABEL[startRole])}
                className={`${btn} w-full bg-cyan-500 text-black`}>{p.busy || 'Démarrer la collaboration en direct'}</button>
              <p className="text-[10px] text-slate-500">La session est mise en ligne (audio des voix compris, jamais le beat non acheté).</p>
            </>
          ) : (
            <>
              <button type="button" data-testid="remote-start" disabled={!!p.remoteBusy || (startRole === 'engineer' && !remoteLink.trim())}
                onClick={() => p.onStartRemote?.(startRole === 'engineer' ? 'engineer' : 'artist', startName.trim() || ROLE_LABEL[startRole], startRole === 'engineer' ? remoteLink.trim() : undefined)}
                className={`${btn} w-full bg-cyan-500 text-black`}>{p.remoteBusy || (startRole === 'engineer' ? "Me relier à l'artiste" : 'Créer le lien avec mon ingé')}</button>
              {startRole === 'engineer' && !remoteLink.trim() && <p className="text-[11px] text-slate-500">Il te faut le lien que l'artiste copie dans son panneau « Ingé à distance ».</p>}
              {p.savedRemote && <p className="text-[11px] text-slate-400">Ce projet a déjà un lien ({p.savedRemote.role === 'artist' ? 'avec ton ingé' : "avec l'artiste"}) : il sera repris.</p>}
              <p className="text-[10px] text-slate-500">Seules les pistes que tu envoies voyagent (audio brut + éditions), jamais le beat.</p>
            </>
          )}
          {p.remoteError && <p role="alert" className="text-[12px] text-red-300">{p.remoteError}</p>}
        </div>
      ) : (
        <>
          {p.status && (p.status.code !== 'live' || p.status.action) && (
            <div data-testid="collab-status" role="status" className={`mx-4 mt-3 rounded-2xl border p-2.5 ${STATUS_TONE[p.status.tone].box}`}>
              <p className={`text-[11px] leading-snug ${STATUS_TONE[p.status.tone].text}`}>{p.status.label}</p>
              {p.status.action && (
                <button type="button" data-testid="collab-status-action"
                  onClick={() => (p.status!.action === 'reload' ? p.onReload?.() : p.onRetry?.())}
                  className={`${btn} mt-2 h-9 ${p.status.action === 'reload' ? 'bg-red-400 text-black' : 'bg-white/10 text-white'}`}>{p.status.actionLabel}</button>
              )}
            </div>
          )}
          <div className="p-4 space-y-2 border-b border-white/5">
            <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Inviter</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(['artist', 'engineer', 'beatmaker'] as CollabRole[]).map(r => (
                <button key={r} type="button" onClick={() => copy(r)} className={`${btn} bg-white/5 text-white hover:bg-white/10 text-[11px]`} title={`Copier le lien d'invitation ${ROLE_LABEL[r]}`}>
                  {copied === r ? 'Copié ✓' : `+ ${ROLE_LABEL[r]}`}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Connectés" data-testid="collab-members">
              {p.members.length === 0 && <span className="text-[11px] text-slate-500">Présence en direct indisponible pour l'instant.</span>}
              {p.members.map(m => (
                <span key={m.member_key} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{m.display_name} <span className={ROLE_COLOR[m.role] || ''}>· {ROLE_LABEL[m.role] || m.role}</span>
                </span>
              ))}
            </div>
          </div>
          {p.liveVst}
          <div ref={listRef} className="flex-1 min-h-[160px] overflow-y-auto p-4 space-y-2" aria-live="polite">
            {p.messages.length === 0 && <p className="text-[12px] text-slate-500">Pas encore de message. Dis bonjour !</p>}
            {p.messages.map(m => (
              <div key={m.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] ${m.mine ? 'ml-auto bg-cyan-500/20 text-white' : 'bg-white/5 text-slate-100'}`}>
                {!m.mine && <p className={`text-[10px] font-black ${ROLE_COLOR[m.role] || 'text-slate-400'}`}>{m.from} · {ROLE_LABEL[m.role] || m.role}</p>}
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                {m.pending && <p className="mt-0.5 text-[10px] text-slate-400">envoi… (partira au retour du réseau)</p>}
              </div>
            ))}
          </div>
          <div className="flex gap-2 p-3 border-t border-white/5">
            <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') send(); }}
              placeholder="Message…" aria-label="Message" className="h-11 flex-1 min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
            <button type="button" onClick={send} className={`${btn} bg-cyan-500 text-black`} aria-label="Envoyer">➤</button>
          </div>
          <button type="button" onClick={p.onLeave} className="pb-3 text-[11px] text-slate-500 underline">Quitter la collaboration</button>
        </>
      )}
    </div>
  );
};

export default CollabPanel;
