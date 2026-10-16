import React, { useEffect, useRef, useState } from 'react';
import { CollabRole, Marker } from '../types';
import { CollabMember, ROLE_LABEL } from '../services/Collab';
import type { CollabStatusView } from '../utils/collabStatus';
import { ARRIVAL_ROLE_HELP, formatInviteCode, formatPosition, MAX_PARTICIPANTS, parseTimeMentions, PeerView, PEER_STATE_TONE, withPosition } from '../utils/collabPeers';
import { agoShort, type HistoryEntry } from '../utils/collabHistory';
import { GUEST_RIGHTS_HELP, type GuestRights } from '../utils/guestRights';
import { useNovaPricing, proMoisTexte } from '../hooks/useNovaPricing';

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
  /** Ingé : choix de la source du mix diffusé (master NOVA ou entrée système : pont Pro Tools). */
  mixSource?: React.ReactNode;
  /** Mix reçu en direct (nom de la personne qui le diffuse), et si je l'écoute. */
  remoteMixFrom: string | null;
  listening: boolean;
  onToggleListen: () => void;
  /**
   * Pendant l'écoute : ce qui arrive vraiment (mesuré) — en écoute, liaison OK
   * mais rien ne joue, connexion en cours, ou pas de son reçu (repli sur sa version).
   */
  mixStatus?: 'connexion' | 'ecoute' | 'silence' | 'echec';
  /** Qualité réelle du mix reçu (« stéréo · 509 kb/s ») ; warn : il arrive en mono. */
  mixQuality?: { text: string; warn: boolean } | null;
  onRetryMix?: () => void;
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
  /** Il faut d'abord se connecter (compte Make Music) ou prendre Nova Pro (pour HÉBERGER : les invités ne paient rien). */
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
  /** B3 : envoi de ma dernière prise, et test de connexion avant la séance. */
  takeSend?: React.ReactNode;
  netTest?: React.ReactNode;
  /** Côté ingé : pont Pro Tools (dossier des prises BWF, source du mix diffusé). */
  proTools?: React.ReactNode;
  /** Côté ingé : liens d'écoute client sans compte (components/ListenLinksPanel). */
  listenLinks?: React.ReactNode;
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
  /** Arrivée par une invitation : choisir son rôle (host : qui a ouvert la séance, s'il est connu). */
  arrival?: { sessionName: string; suggestedRole: CollabRole | null; host?: { role: CollabRole; name: string } | null } | null;
  /** Compte connecté (sinon : e-mail et mot de passe directement sur la carte d'arrivée). */
  signedIn?: boolean;
  /** Créer un compte sans quitter NOVA. */
  onSignUp?: (email: string, password: string) => Promise<void>;
  /** Ingé : ce que l'artiste invité peut modifier dans sa séance (utils/guestRights). */
  guestRights?: { value: GuestRights; onChange: (patch: Partial<GuestRights>) => void } | null;
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
  const grille = useNovaPricing(p.gate === 'subscribe');
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
  const [showRoles, setShowRoles] = useState(false);
  const [signUpMode, setSignUpMode] = useState(false);
  const [joining, setJoining] = useState(false);
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
  // Invité de l'ingé : rôle Artiste déjà choisi, une seule carte (les 3 rôles restent à un toucher).
  const quickArtist = !!p.arrival && arrivalRole === 'artist' && (p.arrival.host?.role === 'engineer' || p.arrival.suggestedRole === 'artist');
  // Pas de compte connecté : on se connecte (ou on crée son compte) sur la même carte.
  const inlineLogin = !!p.arrival && p.signedIn === false && !!p.onSignIn;
  const joinNow = async () => {
    if (!arrivalRole || !p.arrival) return;
    setSignErr(null);
    if (inlineLogin) {
      setJoining(true);
      try {
        if (signUpMode && p.onSignUp) await p.onSignUp(email, password); else await p.onSignIn!(email, password);
        setPassword('');
      } catch (e: any) { setSignErr(e?.message || 'Connexion impossible'); setJoining(false); return; }
      setJoining(false);
    }
    const nm = arrivalName.trim() || (email.includes('@') ? email.split('@')[0] : '') || ROLE_LABEL[arrivalRole];
    p.onJoin?.(arrivalRole, nm);
  };
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
          <p className="text-[12px] font-bold text-white">Héberger une collaboration : Nova Pro{proMoisTexte(grille) ? ` · ${proMoisTexte(grille)}` : ''}</p>
          <p className="text-[11px] text-slate-300">Seul l'hôte a besoin de Nova Pro : tes invités (artiste, ingé son, beatmaker) n'ont rien à payer. Sans engagement, résiliable quand tu veux.</p>
          <button type="button" disabled={!!p.busy} onClick={p.onSubscribe} className={`${btn} w-full bg-violet-600 text-white`}>{p.busy || "M'abonner (paiement sécurisé Stripe)"}</button>
        </div>
      )}
    </>
  );

  return (
    <>
    {/* Arrivée par une invitation : la séance derrière est assombrie et inactive (avant : les boutons du DAW
        restaient sous le doigt pendant qu'on lisait la carte). */}
    {!p.active && p.arrival && <div aria-hidden data-testid="collab-arrival-backdrop" className="fixed inset-0 z-[639] bg-black/75 backdrop-blur-[2px]" />}
    <div className="fixed right-3 bottom-20 md:bottom-4 z-[640] w-[min(400px,calc(100vw-24px))] max-h-[min(700px,calc(100vh-110px))] flex flex-col rounded-3xl border border-white/10 bg-nv-surface/[0.97] shadow-2xl backdrop-blur" role="dialog" aria-labelledby="collab-title">
      <div className="flex items-center gap-2 p-4 border-b border-white/5">
        <h2 id="collab-title" className="flex-1 text-[14px] font-black text-white">👥 Collaboration</h2>
        {p.active && p.status && <span data-testid="collab-status-short" className={`inline-flex items-center gap-1.5 text-[10px] font-black ${STATUS_TONE[p.status.tone].text}`}><span className={`w-1.5 h-1.5 rounded-full ${STATUS_TONE[p.status.tone].dot}`} />{p.status.short}</span>}
        {p.active && p.latency?.serverMs != null && (
          <span data-testid="collab-latency" title="Aller-retour d'une modification avec le serveur (médiane des derniers envois)"
            className={`font-mono text-[10px] font-black ${latencyTone(p.latency.serverMs)}`}>{p.latency.serverMs} ms</span>
        )}
        {p.active && p.role && <span className={`text-[11px] font-black ${ROLE_COLOR[p.role]}`}>{ROLE_LABEL[p.role]}</span>}
        <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-11 h-11 rounded-xl bg-white/5 text-slate-300">✕</button>
      </div>

      {!p.active && p.arrival ? (
        // Arrivée par une invitation. Séance d'un ingé : « Max (ingé son) t'invite », rôle Artiste déjà choisi,
        // un seul bouton ; sans compte, e-mail et mot de passe sur la même carte (avant : 3 rôles à lire,
        // puis un 2e écran de connexion, et « créer un compte » ouvrait un autre site).
        <div className="p-4 space-y-3 overflow-y-auto" data-testid="collab-arrival">
          {p.arrival.host ? (
            <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3">
              <p className="text-[15px] font-black text-white" data-testid="arrival-host"><span className={ROLE_COLOR[p.arrival.host.role]}>{p.arrival.host.name}</span> ({ROLE_LABEL[p.arrival.host.role].toLowerCase()}) t'invite dans sa séance</p>
              <p className="text-[13px] text-slate-300">« {p.arrival.sessionName} »</p>
            </div>
          ) : (
            <p className="text-[13px] font-black text-white">Tu rejoins « {p.arrival.sessionName} »</p>
          )}
          {quickArtist && !showRoles ? (
            <div className="rounded-2xl border border-cyan-400/40 bg-cyan-500/10 p-3" data-testid="arrival-role-artist" data-quick="1">
              <p className="text-[14px] font-black text-cyan-200">🎙️ Tu viens enregistrer ta voix</p>
              <p className="mt-1 text-[12px] leading-snug text-slate-300">Tu enregistres sur ta piste à ton nom, tu écoutes le son de {p.arrival.host?.name || "l'ingé"} et tu lui parles. Le mix, c'est lui.</p>
              <button type="button" onClick={() => setShowRoles(true)} className="mt-1 min-h-11 text-[12px] text-slate-400 underline">Je ne suis pas l'artiste</button>
            </div>
          ) : (
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
          )}
          <input value={arrivalName} onChange={e => setArrivalName(e.target.value)} placeholder="Ton prénom ou ton nom d'artiste" aria-label="Ton nom"
            className="h-12 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[15px] text-white" />
          {inlineLogin ? (
            <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="arrival-login">
              <p className="text-[12px] font-bold text-white">{signUpMode ? 'Crée ton compte Make Music (gratuit, 1 minute)' : 'Ton compte Make Music'}</p>
              <input type="email" autoComplete="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mail" aria-label="E-mail" className="h-12 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[15px] text-white" />
              <input type="password" autoComplete={signUpMode ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={signUpMode ? 'Choisis un mot de passe (6 caractères min.)' : 'Mot de passe'} aria-label="Mot de passe" className="h-12 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[15px] text-white" />
              {signErr && <p role="alert" className="text-[12px] text-red-300">{signErr}</p>}
              {p.onSignUp && (
                <button type="button" onClick={() => { setSignUpMode(m => !m); setSignErr(null); }} data-testid="arrival-signup-toggle" className="min-h-11 w-full text-center text-[12px] text-cyan-300 underline">
                  {signUpMode ? "J'ai déjà un compte" : 'Pas encore de compte ? Crée-le ici'}
                </button>
              )}
            </div>
          ) : gateBlock}
          <button type="button" data-testid="arrival-join" disabled={!!p.busy || joining || !arrivalRole || (inlineLogin && (!email || !password))}
            onClick={() => void joinNow()}
            className={`${btn} h-12 w-full bg-cyan-500 text-[14px] text-black`}>{p.busy || (joining ? 'Connexion…' : !arrivalRole ? 'Choisis ton rôle pour rejoindre'
              : quickArtist && !showRoles ? (inlineLogin ? (signUpMode ? 'Créer mon compte et rejoindre' : 'Me connecter et rejoindre') : `Rejoindre la séance${p.arrival.host ? ` de ${p.arrival.host.name}` : ''}`)
                : `Rejoindre comme ${ROLE_LABEL[arrivalRole].toLowerCase()}`)}</button>
          {/* Lot 3 (1.5.1) : l'invité rejoint gratuitement, il ne paie jamais pour rejoindre. */}
          <p data-testid="arrival-free" className="text-center text-[12px] font-bold text-emerald-300">🎟️ Gratuit pour toi : {p.arrival.host?.name ? `${p.arrival.host.name} héberge` : "l'hôte héberge"} la séance, tu n'as rien à payer.</p>
          <button type="button" onClick={p.onCancelArrival} className="w-full min-h-11 text-center text-[12px] text-slate-400 underline">Pas maintenant (juste regarder la séance)</button>
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
          {(p.takeSend || p.netTest) && (
            <div className="p-4 space-y-2 border-b border-white/5" data-testid="collab-net">
              {p.takeSend}
              {p.netTest}
            </div>
          )}
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
          {p.guestRights && (
            <div className="p-4 space-y-2 border-b border-white/5" data-testid="collab-guest-rights">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Ce que l'artiste peut faire</p>
              <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl bg-white/[0.03] px-2.5 py-2">
                <input type="checkbox" data-testid="guest-rights-limited" checked={p.guestRights.value.limited} onChange={e => p.guestRights!.onChange({ limited: e.target.checked })} className="mt-0.5 h-5 w-5 accent-cyan-400" />
                <span className="text-[12px] leading-snug text-slate-200"><b>Mode simple (conseillé)</b> — {GUEST_RIGHTS_HELP.limited}</span>
              </label>
              {p.guestRights.value.limited && (
                <>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-white/[0.03] px-2.5 py-2">
                    <input type="checkbox" data-testid="guest-rights-ownmix" checked={!!p.guestRights.value.ownMix} onChange={e => p.guestRights!.onChange({ ownMix: e.target.checked })} className="h-5 w-5 accent-cyan-400" />
                    <span className="text-[12px] text-slate-200">{GUEST_RIGHTS_HELP.ownMix}</span>
                  </label>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-white/[0.03] px-2.5 py-2">
                    <input type="checkbox" data-testid="guest-rights-markers" checked={!!p.guestRights.value.markers} onChange={e => p.guestRights!.onChange({ markers: e.target.checked })} className="h-5 w-5 accent-cyan-400" />
                    <span className="text-[12px] text-slate-200">{GUEST_RIGHTS_HELP.markers}</span>
                  </label>
                </>
              )}
              {!p.guestRights.value.limited && <p className="text-[11px] text-amber-200">{GUEST_RIGHTS_HELP.free}</p>}
              <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl bg-white/[0.03] px-2.5 py-2">
                <input type="checkbox" data-testid="guest-rights-remote" checked={!!p.guestRights.value.remote} onChange={e => p.guestRights!.onChange({ remote: e.target.checked })} className="mt-0.5 h-5 w-5 accent-red-400" />
                <span className="text-[12px] leading-snug text-slate-200">🎛️ {GUEST_RIGHTS_HELP.remote}{p.guestRights.value.remote ? ' · tu es prévenu à chaque commande.' : ''}</span>
              </label>
            </div>
          )}
          {p.audio && (
            <div className="p-4 space-y-2 border-b border-white/5" data-testid="collab-audio">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Audio en direct</p>
              <button type="button" data-testid="collab-talk"
                onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } p.audio!.onTalk(true); }}
                onPointerUp={() => p.audio!.onTalk(false)} onPointerCancel={() => p.audio!.onTalk(false)}
                onLostPointerCapture={() => { if (p.audio!.talkOn) p.audio!.onTalk(false); }}
                onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !p.audio!.talkOn) { e.preventDefault(); p.audio!.onTalk(true); } }}
                onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') p.audio!.onTalk(false); }}
                aria-pressed={p.audio.talkOn}
                className={`${btn} h-12 w-full select-none touch-none ${p.audio.talkOn ? 'bg-red-500 text-white animate-pulse' : 'bg-white/10 text-white hover:bg-white/15'}`}>
                {p.audio.talkOn ? '🎙️ On t’entend… (relâche pour couper)' : '🎙️ Maintenir pour parler (talkback)'}
              </button>
              {p.audio.talking.length > 0 && <p role="status" data-testid="collab-talking" className="text-[12px] font-bold text-sky-200">🔊 {p.audio.talking.join(', ')} te parle{p.audio.talking.length > 1 ? 'nt' : ''}…</p>}
              {p.audio.canMixOut && p.audio.mixSource}
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
              {p.audio.remoteMixFrom && p.audio.listening && p.audio.mixStatus && (
                <div role="status" data-testid="collab-mix-status" data-state={p.audio.mixStatus}
                  className={`rounded-xl px-3 py-2 text-[12px] font-bold ${p.audio.mixStatus === 'ecoute' ? 'bg-emerald-500/15 text-emerald-200'
                    : p.audio.mixStatus === 'echec' ? 'bg-red-500/15 text-red-200' : 'bg-white/5 text-slate-300'}`}>
                  {p.audio.mixStatus === 'ecoute' && <>🟢 Mix de {p.audio.remoteMixFrom} : en écoute{p.audio.mixQuality && (
                    <span data-testid="collab-mix-quality" data-warn={p.audio.mixQuality.warn ? '1' : '0'}
                      className={`ml-1 font-mono ${p.audio.mixQuality.warn ? 'text-amber-300' : 'text-emerald-300/80'}`}>· {p.audio.mixQuality.text}</span>
                  )}{p.audio.mixQuality?.warn && <span className="block text-[11px] font-semibold text-amber-200">Il arrive en mono : demande à {p.audio.remoteMixFrom} d’arrêter puis de relancer « Diffuser mon mix ».</span>}</>}
                  {p.audio.mixStatus === 'silence' && <>⏸️ Mix de {p.audio.remoteMixFrom} : bien relié, mais rien ne joue en ce moment (lecture à l’arrêt ou passage silencieux)</>}
                  {p.audio.mixStatus === 'connexion' && <>⏳ Mix de {p.audio.remoteMixFrom} : connexion…</>}
                  {p.audio.mixStatus === 'echec' && (
                    <span className="flex items-center justify-between gap-2">
                      <span>⚠️ Pas de son reçu : tu réentends ta propre version.</span>
                      {p.audio.onRetryMix && (
                        <button type="button" data-testid="collab-mix-retry" onClick={p.audio.onRetryMix} className={`${btn} h-9 px-3 bg-white text-black shrink-0`}>Réessayer</button>
                      )}
                    </span>
                  )}
                </div>
              )}
              <p className="text-[11px] text-slate-500">
                {p.audio.remoteMixFrom
                  ? `Tu entends le mix de ${p.audio.remoteMixFrom} tel qu’il l’entend (environ 0,2 s de décalage) ; ton propre son est coupé pendant l’écoute.`
                  : p.audio.canMixOut ? 'Ton mix part tel que tu l’entends (Opus stéréo haut débit) : l’artiste l’écoute même sans tes VST, sur téléphone ou tablette.'
                    : p.role === 'artist'
                      ? 'Le talkback passe par ton micro (annulation d’écho). Pendant ta prise, celui des autres est coupé chez toi.'
                      : 'Le talkback passe par ton micro (annulation d’écho) ; il est coupé chez l’artiste pendant une prise.'}
              </p>
            </div>
          )}
          {p.listenLinks}
          {p.proTools}
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
    </>
  );
};

export default CollabPanel;
