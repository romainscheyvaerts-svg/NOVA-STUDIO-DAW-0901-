import React, { useEffect, useRef, useState } from 'react';
import { CollabRole, Marker } from '../types';
import { CollabMember, ROLE_LABEL } from '../services/Collab';
import type { CollabStatusView } from '../utils/collabStatus';
import { ARRIVAL_ROLE_HELP, formatInviteCode, formatPosition, MAX_PARTICIPANTS, parseTimeMentions, PeerView, PEER_STATE_TONE, withPosition } from '../utils/collabPeers';
import { agoShort, type HistoryEntry } from '../utils/collabHistory';

/**
 * Collaboration à distance : inviter (un lien, un code à 6 caractères ; la
 * personne choisit son rôle en arrivant), voir qui est là et ce qu'il fait
 * (connecté, enregistre, écoute, en retard, hors ligne), « Écouter
 * ensemble », repères partagés, discuter (« à 0:42 » place la tête de
 * lecture). Qui fait quoi : chaque artiste enregistre sur SES pistes (son
 * nom, sa couleur, personne ne les écrase), l'ingé son règle le mix, le
 * beatmaker ajoute ses pistes.
 */
export interface CollabMessage { id: string; from: string; role: CollabRole; text: string; at: number; mine?: boolean; /** Pas encore parti (hors ligne) : « envoi… ». */ pending?: boolean }

/** Audio en direct (services/CollabRtc) : talkback, mix de l'ingé diffusé. */
export interface LiveAudioView {
  /** Talkback ouvert (je parle). */
  talkOn: boolean;
  onTalk: (on: boolean) => void;
  /** Ingé : peut diffuser son mix ; diffusion en cours. */
  canMixOut: boolean;
  mixOutOn: boolean;
  onToggleMixOut: () => void;
  /** Mix reçu en direct (nom de la personne qui le diffuse), et si je l'écoute. */
  remoteMixFrom: string | null;
  listening: boolean;
  onToggleListen: () => void;
  /** Qui me parle en ce moment (talkback reçu). */
  talking: string[];
}

export interface ListenView {
  /** Je suis l'hôte (je peux guider la lecture). */
  canHost: boolean;
  /** « Écouter ensemble » en cours. */
  on: boolean;
  /** Qui guide (null : personne). */
  hostName: string | null;
  /** C'est moi qui guide. */
  mine: boolean;
  /** Invité : je suis la lecture de l'hôte. */
  follow: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  active: boolean;
  role: CollabRole | null;
  name: string;
  members: CollabMember[];
  messages: CollabMessage[];
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
  /** Lien reçu (?inge=…) : le panneau s'ouvre sur « Ingé à distance » (rôle ingé, ou artiste invité sur le lien). */
  remoteLinkFromUrl?: string | null;
  remoteRoleFromUrl?: 'artist' | 'engineer' | null;
  /** Lien enregistré avec le projet mais pas connecté : « Reprendre ». */
  savedRemote?: { role: 'artist' | 'engineer' } | null;
  /** En direct, côté ingé : réglage à distance des VST du PC de l'artiste. */
  liveVst?: React.ReactNode;
  /** État de la connexion (en direct, rattrapage, hors ligne, envoi…). */
  status?: CollabStatusView | null;
  onRetry?: () => void;
  onReload?: () => void;
  // --- « Feat à distance » ---
  /** Qui est dans la session (moi en premier). */
  peers?: PeerView[];
  /** Lien d'invitation unique (la personne choisit son rôle en arrivant). */
  inviteLink?: string | null;
  inviteCode?: { code: string; expiresAt?: string } | 'unavailable' | 'loading' | null;
  onRefreshCode?: () => void;
  /** Arrivée par une invitation : choisir son rôle. */
  arrival?: { sessionName: string; suggestedRole: CollabRole | null } | null;
  defaultName?: string;
  onJoin?: (role: CollabRole, name: string) => void;
  onCancelArrival?: () => void;
  /** Rejoindre avec un code reçu (6 caractères). */
  onJoinCode?: (code: string) => Promise<void>;
  /** Créer une piste à mon nom. */
  onCreateMyTrack?: () => void;
  listen?: ListenView | null;
  onToggleListen?: () => void;
  onToggleFollow?: () => void;
  markers?: Marker[];
  onAddMarker?: (name: string) => void;
  onSeek?: (seconds: number) => void;
  /** Position de la tête de lecture (pour « à 0:42 »). */
  position?: () => number;
  // --- Collaboration « pro » ---
  /** Historique « qui a changé quoi » (les plus récentes d'abord), avec « Annuler ». */
  history?: (HistoryEntry & { canUndo: boolean })[];
  onUndo?: (id: string) => void;
  /** Aller-retour avec le serveur (ms) et avec chaque personne par le direct (clé → ms). */
  latency?: { serverMs: number | null; peers: Record<string, number> };
  /** Vérification des empreintes : chacun a-t-il la même session que moi ? */
  sync?: Record<string, { ok: boolean; at: number; diff?: string[] }>;
  audio?: LiveAudioView | null;
}

/** Couleur d'une latence (aller-retour). */
const latencyTone = (ms: number) => (ms < 150 ? 'text-emerald-300' : ms < 400 ? 'text-amber-200' : 'text-red-300');

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
  artist: 'enregistre et édite ses voix, sur SES pistes (personne ne les écrase) ; peut verrouiller le volume d\'une piste',
  engineer: 'règle volumes, effets Nova et envois (ou ses VST : la piste est gelée puis envoyée)',
  beatmaker: 'ajoute batterie, basse et ses propres pistes',
};
const REMOTE_ROLE_HELP: Record<CollabRole, string> = {
  artist: "enregistre, envoie ses pistes à l'ingé et reçoit ses réglages (navigateur, tablette ou téléphone : pas besoin de VST)",
  engineer: "reçoit les pistes dans SA session et les traite avec ses VST (appli NOVA Studio pour Windows), puis les renvoie",
  beatmaker: '',
};
const ROLE_COLOR: Record<CollabRole, string> = { artist: 'text-cyan-300', engineer: 'text-amber-300', beatmaker: 'text-violet-300' };
const ROLES: CollabRole[] = ['artist', 'engineer', 'beatmaker'];

/** Texte d'un message : « à 0:42 » devient un bouton qui place la tête de lecture. */
const MessageText: React.FC<{ text: string; onSeek?: (s: number) => void }> = ({ text, onSeek }) => (
  <p className="whitespace-pre-wrap break-words">
    {parseTimeMentions(text).map((part, i) => (part.kind === 'time' && onSeek
      ? <button key={i} type="button" onClick={() => onSeek(part.seconds)} aria-label={`Aller à ${part.text}`} title={`Placer la tête de lecture à ${part.text}`}
          className="mx-0.5 inline-flex items-center rounded-md bg-cyan-400/20 px-1.5 py-0.5 font-mono text-[12px] font-black text-cyan-200 underline decoration-dotted underline-offset-2 hover:bg-cyan-400/30">▶ {part.text}</button>
      : <React.Fragment key={i}>{part.text}</React.Fragment>))}
  </p>
);

const CollabPanel: React.FC<Props> = (p) => {
  const [text, setText] = useState('');
  const remoteIncoming = !!p.remoteLinkFromUrl;
  const [startRole, setStartRole] = useState<CollabRole>(remoteIncoming ? (p.remoteRoleFromUrl || 'engineer') : 'artist');
  const [mode, setMode] = useState<CollabMode>(remoteIncoming || p.savedRemote ? 'remote' : 'live');
  const [remoteLink, setRemoteLink] = useState(p.remoteLinkFromUrl || '');
  useEffect(() => { if (p.remoteLinkFromUrl) { setMode('remote'); setStartRole(p.remoteRoleFromUrl || 'engineer'); setRemoteLink(p.remoteLinkFromUrl); } }, [p.remoteLinkFromUrl, p.remoteRoleFromUrl]);
  const [startName, setStartName] = useState('');
  const [arrivalRole, setArrivalRole] = useState<CollabRole | null>(p.arrival?.suggestedRole ?? null);
  const [arrivalName, setArrivalName] = useState(p.defaultName || '');
  useEffect(() => { setArrivalRole(p.arrival?.suggestedRole ?? null); }, [p.arrival?.suggestedRole, p.arrival?.sessionName]);
  useEffect(() => { if (p.defaultName && !arrivalName) setArrivalName(p.defaultName); }, [p.defaultName]); // eslint-disable-line react-hooks/exhaustive-deps
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signErr, setSignErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [markerName, setMarkerName] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  // Panneau ouvert : les notifications d'export passent à gauche (elles recouvraient son bouton principal).
  useEffect(() => {
    if (!p.open) return;
    document.body.classList.add('nova-collab-open');
    return () => { document.body.classList.remove('nova-collab-open'); };
  }, [p.open]);
  // Nouveau message : on descend jusqu'à lui (pas à l'ouverture : les réglages restent en haut).
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [p.messages.length]);
  if (!p.open) return null;

  const copy = async () => {
    const url = p.inviteLink;
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* */ }
  };
  const share = async () => {
    const url = p.inviteLink;
    if (!url) return;
    try { await (navigator as any).share({ title: 'Session NOVA', text: 'Rejoins ma session NOVA (tu choisis ton rôle en arrivant) :', url }); } catch { await copy(); }
  };
  const send = () => { const t = text.trim(); if (t) { p.onSend(t); setText(''); } };
  const joinCode = async () => {
    if (!p.onJoinCode) return;
    setCodeErr(null); setCodeBusy(true);
    try { await p.onJoinCode(code); setCode(''); } catch (e: any) { setCodeErr(e?.message || 'Code impossible à vérifier : réessaie.'); } finally { setCodeBusy(false); }
  };
  const btn = 'h-10 rounded-xl px-3 text-[12px] font-black transition-colors disabled:opacity-40';
  const canShare = typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function';
  const peers = p.peers || [];
  const onlineCount = peers.filter(x => x.online).length;

  const gateBlock = (
    <>
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
          <button type="button" disabled={!!p.busy} onClick={p.onSubscribe} className={`${btn} w-full bg-violet-600 text-white`}>{p.busy || "M'abonner (paiement sécurisé Stripe)"}</button>
        </div>
      )}
    </>
  );

  return (
    <div className="fixed right-3 bottom-20 md:bottom-4 z-[640] w-[min(400px,calc(100vw-24px))] max-h-[min(700px,calc(100vh-110px))] flex flex-col rounded-3xl border border-white/10 bg-[#121418]/[0.97] shadow-2xl backdrop-blur" role="dialog" aria-labelledby="collab-title">
      <div className="flex items-center gap-2 p-4 border-b border-white/5">
        <h2 id="collab-title" className="flex-1 text-[14px] font-black text-white">👥 Collaboration</h2>
        {p.active && p.status && <span data-testid="collab-status-short" className={`inline-flex items-center gap-1.5 text-[10px] font-black ${STATUS_TONE[p.status.tone].text}`}><span className={`w-1.5 h-1.5 rounded-full ${STATUS_TONE[p.status.tone].dot}`} />{p.status.short}</span>}
        {p.active && p.latency?.serverMs != null && (
          <span data-testid="collab-latency" title="Aller-retour d'une modification avec le serveur (médiane des derniers envois)"
            className={`font-mono text-[10px] font-black ${latencyTone(p.latency.serverMs)}`}>{p.latency.serverMs} ms</span>
        )}
        {p.active && p.role && <span className={`text-[11px] font-black ${ROLE_COLOR[p.role]}`}>{ROLE_LABEL[p.role]}</span>}
        <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-10 h-10 rounded-xl bg-white/5 text-slate-300">✕</button>
      </div>

      {!p.active && p.arrival ? (
        // Arrivée par une invitation : le rôle se choisit ici, une phrase claire par rôle.
        <div className="p-4 space-y-3 overflow-y-auto" data-testid="collab-arrival">
          <p className="text-[13px] font-black text-white">Tu rejoins « {p.arrival.sessionName} »</p>
          <fieldset className="space-y-1.5" aria-label="Ton rôle">
            <legend className="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1">Tu arrives comme…</legend>
            {ROLES.map(r => (
              <label key={r} data-testid={`arrival-role-${r}`} className={`block cursor-pointer rounded-2xl border p-3 transition-colors ${arrivalRole === r ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]'}`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="arrival-role" checked={arrivalRole === r} onChange={() => setArrivalRole(r)} className="accent-cyan-400 w-4 h-4" />
                  <span className={`text-[13px] font-black ${ROLE_COLOR[r]}`}>{ROLE_LABEL[r]}</span>
                </span>
                <span className="mt-1 block text-[12px] leading-snug text-slate-300">{ARRIVAL_ROLE_HELP[r]}</span>
              </label>
            ))}
          </fieldset>
          <input value={arrivalName} onChange={e => setArrivalName(e.target.value)} placeholder="Ton nom (affiché aux autres)" aria-label="Ton nom"
            className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
          {gateBlock}
          <button type="button" data-testid="arrival-join" disabled={!!p.busy || !arrivalRole}
            onClick={() => arrivalRole && p.onJoin?.(arrivalRole, arrivalName.trim() || ROLE_LABEL[arrivalRole])}
            className={`${btn} h-11 w-full bg-cyan-500 text-black`}>{p.busy || (arrivalRole ? `Rejoindre comme ${ROLE_LABEL[arrivalRole].toLowerCase()}` : 'Choisis ton rôle pour rejoindre')}</button>
          <button type="button" onClick={p.onCancelArrival} className="w-full min-h-10 text-center text-[12px] text-slate-400 underline">Pas maintenant (juste écouter la session)</button>
        </div>
      ) : !p.active ? (
        <div className="p-4 space-y-3 overflow-y-auto">
          {p.onJoinCode && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
              <p className="text-[12px] font-black text-white">On t'a donné un code ?</p>
              <div className="flex gap-2">
                <input value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setCodeErr(null); }} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') void joinCode(); }}
                  placeholder="ABC 234" aria-label="Code d'invitation" maxLength={9} autoCapitalize="characters" autoComplete="off" data-testid="collab-code-input"
                  className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-[16px] tracking-[0.2em] text-white" />
                <button type="button" disabled={codeBusy || code.replace(/\s/g, '').length < 6} onClick={() => void joinCode()} data-testid="collab-code-join"
                  className={`${btn} h-11 bg-white text-black`}>{codeBusy ? '…' : 'Rejoindre'}</button>
              </div>
              {codeErr && <p role="alert" className="text-[11px] text-red-300">{codeErr}</p>}
            </div>
          )}
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
              {(mode === 'remote' ? ['artist', 'engineer'] as CollabRole[] : ROLES).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-slate-500">{ROLE_LABEL[startRole]} : {mode === 'remote' ? REMOTE_ROLE_HELP[startRole] : ROLE_HELP[startRole]}.</p>
          {mode === 'remote' && (
            <input value={remoteLink} onChange={e => setRemoteLink(e.target.value)} placeholder={startRole === 'engineer' ? "Colle le lien envoyé par l'artiste (…?inge=…)" : 'Lien du premier artiste (laisse vide pour en créer un)'} aria-label="Lien de l'artiste" data-testid="remote-link-input"
              className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[12px] text-white" />
          )}
          <input value={startName} onChange={e => setStartName(e.target.value)} placeholder="Ton nom (affiché aux autres)"
            className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
          {gateBlock}
          {mode === 'live' ? (
            <>
              <button type="button" disabled={!!p.busy} onClick={() => p.onStart(startRole, startName.trim() || ROLE_LABEL[startRole])}
                className={`${btn} w-full bg-cyan-500 text-black`}>{p.busy || 'Démarrer la collaboration en direct'}</button>
              <p className="text-[10px] text-slate-500">La session est mise en ligne (audio des voix compris, jamais le beat non acheté). Jusqu'à {MAX_PARTICIPANTS} personnes : 2 artistes, 1 ingé et 1 beatmaker, par exemple.</p>
            </>
          ) : (
            <>
              <button type="button" data-testid="remote-start" disabled={!!p.remoteBusy || (startRole === 'engineer' && !remoteLink.trim())}
                onClick={() => p.onStartRemote?.(startRole === 'engineer' ? 'engineer' : 'artist', startName.trim() || ROLE_LABEL[startRole], remoteLink.trim() || undefined)}
                className={`${btn} w-full bg-cyan-500 text-black`}>{p.remoteBusy || (startRole === 'engineer' ? "Me relier à l'artiste" : remoteLink.trim() ? 'Rejoindre le lien (deuxième artiste)' : 'Créer le lien avec mon ingé')}</button>
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
          {/* Une seule zone qui défile (invitation, VST de l'artiste, messages) : la saisie
              du message reste toujours visible (avant : poussée hors de l'écran chez l'ingé). */}
          <div ref={listRef} data-testid="collab-scroll" className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-4 space-y-2 border-b border-white/5">
            <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Dans la session · {onlineCount}/{MAX_PARTICIPANTS}</p>
            <ul className="space-y-1" aria-label="Participants" data-testid="collab-members">
              {peers.length === 0 && p.members.length === 0 && <li className="text-[11px] text-slate-500">Présence en direct indisponible pour l'instant.</li>}
              {peers.length === 0 && p.members.map(m => (
                <li key={m.member_key} className="flex items-center gap-1.5 text-[12px] text-slate-200"><span className="w-2 h-2 rounded-full bg-emerald-400" />{m.display_name} <span className={ROLE_COLOR[m.role] || ''}>· {ROLE_LABEL[m.role] || m.role}</span></li>
              ))}
              {peers.map(v => (
                <li key={v.key} data-testid="collab-peer" data-state={v.state} data-online={v.online ? '1' : '0'} className="flex items-start gap-2 rounded-xl bg-white/[0.03] px-2.5 py-1.5">
                  <span className={`mt-1 w-2.5 h-2.5 shrink-0 rounded-full ${PEER_STATE_TONE[v.state]}`} aria-hidden />
                  <span className="min-w-0 flex-1 text-[12px] leading-snug">
                    <span className="font-black" style={{ color: v.color || undefined }}>{v.name}</span>
                    {v.me && <span className="text-slate-500"> (toi)</span>}
                    <span className={`${ROLE_COLOR[v.role] || 'text-slate-400'}`}> · {ROLE_LABEL[v.role] || v.role}</span>
                    {v.host && <span className="ml-1 rounded bg-white/10 px-1 text-[9px] font-black uppercase text-slate-300">hôte</span>}
                    {(v.devices || 0) > 1 && <span className="ml-1 text-[10px] text-slate-400">· {v.devices} appareils</span>}
                    <span className={`block text-[11px] ${v.state === 'recording' ? 'text-red-300 font-bold' : v.state === 'late' ? 'text-amber-200' : v.state === 'offline' ? 'text-slate-500' : 'text-slate-400'}`}>
                      {v.state === 'recording' ? '● ' : ''}{v.label}
                      {!v.me && v.online && p.latency?.peers[v.key] != null && <span data-testid="collab-peer-latency" className={`ml-1 font-mono ${latencyTone(p.latency.peers[v.key])}`}>· {p.latency.peers[v.key]} ms</span>}
                    </span>
                    {!v.me && p.sync?.[v.key] && (
                      <span data-testid="collab-peer-sync" data-ok={p.sync[v.key].ok ? '1' : '0'} className={`block text-[10px] font-bold ${p.sync[v.key].ok ? 'text-emerald-300' : 'text-red-300'}`}>
                        {p.sync[v.key].ok ? '✓ même session que toi' : `⚠ écart avec toi${p.sync[v.key].diff?.length ? ` : ${p.sync[v.key].diff!.join(', ')}` : ''}`}
                        {!p.sync[v.key].ok && p.onReload && <button type="button" onClick={p.onReload} className="ml-1 underline">Resynchroniser</button>}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="pt-1 text-[11px] font-black uppercase tracking-wider text-slate-400">Inviter</p>
            <div className="flex gap-1.5">
              <button type="button" onClick={copy} disabled={!p.inviteLink} data-testid="collab-invite-copy" className={`${btn} flex-1 bg-white/10 text-white hover:bg-white/15`}>
                {copied ? 'Lien copié ✓' : '🔗 Copier le lien'}
              </button>
              {canShare && <button type="button" onClick={share} disabled={!p.inviteLink} className={`${btn} bg-white/10 text-white`} aria-label="Partager le lien">Partager</button>}
            </div>
            <div className="text-[12px] text-slate-300" data-testid="collab-invite-code">
              {p.inviteCode && typeof p.inviteCode === 'object' ? (
                <span>Ou donne ce code : <span className="font-mono text-[15px] font-black tracking-[0.15em] text-white">{formatInviteCode(p.inviteCode.code)}</span> <span className="text-slate-500">(valable 24 h)</span></span>
              ) : p.inviteCode === 'loading' ? <span className="text-slate-500">Code en cours de création…</span>
                : p.inviteCode === 'unavailable' ? (
                  <span className="text-slate-500">Code indisponible pour l'instant : envoie le lien. <button type="button" onClick={p.onRefreshCode} className="nova-hit-tactile underline">Réessayer</button></span>
                ) : null}
            </div>
            <p className="text-[11px] text-slate-500">La personne choisit son rôle en arrivant : artiste, ingé son ou beatmaker.</p>
          </div>
          {(p.onCreateMyTrack || p.listen) && (
            <div className="p-4 space-y-2 border-b border-white/5">
              {p.onCreateMyTrack && (
                <div>
                  <button type="button" onClick={p.onCreateMyTrack} data-testid="collab-my-track" className={`${btn} h-11 w-full bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30`}>🎙️ Créer ma piste</button>
                  <p className="mt-1 text-[11px] text-slate-500">Une piste à ton nom et à ta couleur : les autres l'entendent, personne ne peut l'écraser.</p>
                </div>
              )}
              {p.listen && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="collab-listen">
                  {p.listen.canHost ? (
                    <>
                      <button type="button" onClick={p.onToggleListen} aria-pressed={p.listen.mine} data-testid="collab-listen-toggle"
                        className={`${btn} h-11 w-full ${p.listen.mine ? 'bg-sky-400 text-black' : 'bg-white/10 text-white'}`}>
                        🎧 Écouter ensemble : {p.listen.mine ? 'activé' : 'désactivé'}
                      </button>
                      <p className="mt-1 text-[11px] text-slate-400">{p.listen.mine ? 'Ta lecture guide celle des autres : lecture, pause et position.' : 'Active-le pour que tout le monde entende la même chose au même moment.'}</p>
                    </>
                  ) : p.listen.on ? (
                    <>
                      <p className="text-[12px] text-sky-200"><b>{p.listen.hostName}</b> guide la lecture (« Écouter ensemble »).</p>
                      <button type="button" onClick={p.onToggleFollow} aria-pressed={p.listen.follow} data-testid="collab-follow-toggle"
                        className={`${btn} mt-2 h-10 w-full ${p.listen.follow ? 'bg-sky-400 text-black' : 'bg-white/10 text-white'}`}>
                        {p.listen.follow ? '✓ Je suis sa lecture' : 'Suivre sa lecture'}
                      </button>
                    </>
                  ) : (
                    <p className="text-[11px] text-slate-400">🎧 « Écouter ensemble » : l'hôte de la session peut guider la lecture de tout le monde.</p>
                  )}
                </div>
              )}
            </div>
          )}
          {p.audio && (
            <div className="p-4 space-y-2 border-b border-white/5" data-testid="collab-audio">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Audio en direct</p>
              <button type="button" data-testid="collab-talk"
                onPointerDown={(e) => { e.preventDefault(); p.audio!.onTalk(true); }}
                onPointerUp={() => p.audio!.onTalk(false)} onPointerLeave={() => { if (p.audio!.talkOn) p.audio!.onTalk(false); }} onPointerCancel={() => p.audio!.onTalk(false)}
                onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !p.audio!.talkOn) { e.preventDefault(); p.audio!.onTalk(true); } }}
                onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') p.audio!.onTalk(false); }}
                aria-pressed={p.audio.talkOn}
                className={`${btn} h-12 w-full select-none touch-none ${p.audio.talkOn ? 'bg-red-500 text-white animate-pulse' : 'bg-white/10 text-white hover:bg-white/15'}`}>
                {p.audio.talkOn ? '🎙️ On t’entend… (relâche pour couper)' : '🎙️ Maintenir pour parler (talkback)'}
              </button>
              {p.audio.talking.length > 0 && <p role="status" data-testid="collab-talking" className="text-[12px] font-bold text-sky-200">🔊 {p.audio.talking.join(', ')} te parle{p.audio.talking.length > 1 ? 'nt' : ''}…</p>}
              {p.audio.canMixOut && (
                <button type="button" data-testid="collab-mix-out" onClick={p.audio.onToggleMixOut} aria-pressed={p.audio.mixOutOn}
                  className={`${btn} h-11 w-full ${p.audio.mixOutOn ? 'bg-amber-400 text-black' : 'bg-white/10 text-white'}`}>
                  📡 Diffuser mon mix en direct : {p.audio.mixOutOn ? 'activé' : 'désactivé'}
                </button>
              )}
              {p.audio.remoteMixFrom && (
                <button type="button" data-testid="collab-mix-listen" onClick={p.audio.onToggleListen} aria-pressed={p.audio.listening}
                  className={`${btn} h-11 w-full ${p.audio.listening ? 'bg-sky-400 text-black' : 'bg-white/10 text-white'}`}>
                  🎧 Écouter le mix de {p.audio.remoteMixFrom} : {p.audio.listening ? 'en cours' : 'non'}
                </button>
              )}
              <p className="text-[11px] text-slate-500">
                {p.audio.remoteMixFrom
                  ? `Tu entends le mix de ${p.audio.remoteMixFrom} tel qu’il l’entend (environ 0,2 s de décalage) ; ton propre son est coupé pendant l’écoute.`
                  : p.audio.canMixOut ? 'Ton mix part tel que tu l’entends (Opus stéréo haut débit) : l’artiste l’écoute même sans tes VST, sur téléphone ou tablette.'
                    : 'Le talkback passe par ton micro (annulation d’écho) ; il est coupé chez l’artiste pendant une prise.'}
              </p>
            </div>
          )}
          {p.history && (
            <div className="p-4 space-y-2 border-b border-white/5" data-testid="collab-history">
              <button type="button" onClick={() => setHistoryOpen(o => !o)} aria-expanded={historyOpen} data-testid="collab-history-toggle"
                className="flex w-full min-h-10 items-center justify-between text-[11px] font-black uppercase tracking-wider text-slate-400">
                <span>Qui a changé quoi · {p.history.length}</span><span aria-hidden>{historyOpen ? '▾' : '▸'}</span>
              </button>
              {historyOpen && (p.history.length === 0
                ? <p className="text-[11px] text-slate-500">Rien pour l’instant : les modifications des autres s’afficheront ici, avec « Annuler ».</p>
                : (
                  <ul className="space-y-1 max-h-56 overflow-y-auto" aria-label="Historique des modifications">
                    {p.history.slice(0, 60).map(h => (
                      <li key={h.id} data-testid="collab-history-entry" className={`flex items-start gap-2 rounded-xl px-2 py-1.5 text-[12px] ${h.undone ? 'opacity-50' : 'bg-white/[0.03]'}`}>
                        <span className="min-w-0 flex-1 leading-snug text-slate-200">
                          <span className="font-black" style={{ color: h.color || undefined }}>{h.who}</span> {h.text}
                          <span className="block text-[10px] text-slate-500">{agoShort(h.at)}{h.undone ? ' · annulé' : ''}</span>
                        </span>
                        {h.canUndo && p.onUndo && (
                          <button type="button" onClick={() => p.onUndo!(h.id)} data-testid="collab-history-undo"
                            className="h-9 shrink-0 rounded-lg bg-white/10 px-2 text-[11px] font-black text-white hover:bg-white/15">↩ Annuler</button>
                        )}
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          )}
          {p.markers && p.onAddMarker && (
            <div className="p-4 space-y-2 border-b border-white/5" data-testid="collab-markers">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Repères partagés</p>
              {p.markers.length === 0 && <p className="text-[11px] text-slate-500">Aucun repère : pose-en un à la tête de lecture (« couplet 2 ici »).</p>}
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {p.markers.slice(0, 30).map(m => (
                  <li key={m.id} className="flex items-center gap-2 text-[12px] text-slate-200">
                    <button type="button" onClick={() => p.onSeek?.(m.time)} aria-label={`Aller au repère ${m.name}`}
                      className="h-8 shrink-0 rounded-lg bg-white/10 px-2 font-mono text-[11px] font-black text-white hover:bg-white/15">▶ {formatPosition(m.time)}</button>
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {m.by && <span className="shrink-0 text-[10px] text-slate-500">{m.by}</span>}
                  </li>
                ))}
              </ul>
              <div className="flex gap-1.5">
                <input value={markerName} onChange={e => setMarkerName(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && markerName.trim()) { p.onAddMarker!(markerName.trim()); setMarkerName(''); } }}
                  placeholder="couplet 2 ici" aria-label="Nom du repère" className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 text-[12px] text-white" />
                <button type="button" onClick={() => { p.onAddMarker!(markerName.trim()); setMarkerName(''); }} data-testid="collab-marker-add"
                  className={`${btn} bg-amber-400/90 text-black`}>📍 Poser ici</button>
              </div>
            </div>
          )}
          {p.liveVst}
          <div className="min-h-[120px] p-4 space-y-2" aria-live="polite">
            {p.messages.length === 0 && <p className="text-[12px] text-slate-500">Pas encore de message. Dis bonjour ! Astuce : « à 0:42 » dans un message place la tête de lecture chez l'autre.</p>}
            {p.messages.map(m => (
              <div key={m.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] ${m.mine ? 'ml-auto bg-cyan-500/20 text-white' : 'bg-white/5 text-slate-100'}`}>
                {!m.mine && <p className={`text-[10px] font-black ${ROLE_COLOR[m.role] || 'text-slate-400'}`}>{m.from} · {ROLE_LABEL[m.role] || m.role}</p>}
                <MessageText text={m.text} onSeek={p.onSeek} />
                {m.pending && <p className="mt-0.5 text-[10px] text-slate-400">envoi… (partira au retour du réseau)</p>}
              </div>
            ))}
          </div>
          </div>
          <div className="flex gap-2 p-3 border-t border-white/5">
            {p.position && (
              <button type="button" onClick={() => { setText(t => withPosition(t, p.position!())); inputRef.current?.focus(); }} aria-label="Ajouter la position de la tête de lecture"
                title="Ajouter « à 0:42 » (position de la tête de lecture)" data-testid="collab-chat-position" className={`${btn} h-11 w-11 shrink-0 bg-white/10 px-0 text-white`}>📍</button>
            )}
            <input ref={inputRef} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') send(); }}
              placeholder="Message… (« à 0:42 » = position)" aria-label="Message" className="h-11 flex-1 min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
            <button type="button" onClick={send} className={`${btn} h-11 min-w-11 bg-cyan-500 text-black`} aria-label="Envoyer">➤</button>
          </div>
          <button type="button" onClick={p.onLeave} className="min-h-10 pb-1 text-[12px] text-slate-400 underline">Quitter la collaboration</button>
        </>
      )}
    </div>
  );
};

export default CollabPanel;
