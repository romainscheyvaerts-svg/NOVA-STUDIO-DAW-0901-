import React, { useEffect, useRef, useState } from 'react';
import type { CollabMessage } from './CollabPanel';
import type { CollabStatusView } from '../utils/collabStatus';
import type { PeerView } from '../utils/collabPeers';
import { PEER_STATE_TONE } from '../utils/collabPeers';
import MicLevelMeter from './MicLevelMeter';

/**
 * « Artiste invité » : l'écran de l'artiste qui rejoint la séance de l'ingé
 * (souvent depuis son téléphone, sans rien connaître au studio).
 *
 * Avant, il arrivait dans le DAW complet (outils d'édition, mixer, effets,
 * « Mix auto » qui changeait le volume du beat de l'ingé…) et tout ce qui
 * l'intéressait était caché dans le panneau Collaboration, au bout d'un menu
 * et d'un défilement : écouter le mix de l'ingé, voir qu'il lui parle, lui
 * écrire. Ici, une seule page, au doigt, dans l'ordre d'une prise :
 *  1. où je suis et qui est là (et l'état de la connexion, en clair) ;
 *  2. casque et micro (guidé s'il n'a pas de casque) ;
 *  3. écouter le mix de l'ingé ;
 *  4. enregistrer (gros bouton, décompte, paroles sous les yeux) ;
 *  5. réécouter, recommencer, choisir sa prise ;
 *  6. parler à l'ingé (maintenir) ou lui écrire.
 * Le reste de la séance est à l'ingé : visible en lecture seule seulement.
 */

export interface GuestTake { n: number; name: string; start: number; end: number; used: number }

export interface GuestStudioProps {
  sessionName: string;
  engineer: { name: string; online: boolean; label: string } | null;
  /** Les autres participants (sans moi ni l'ingé). */
  others: PeerView[];
  me: { name: string; color: string };
  status: CollabStatusView | null;
  onRetry: () => void;
  /** L'ingé lui a permis de régler le son de sa voix. */
  canMixOwn: boolean;
  // Casque et micro
  headphones: 'casque' | 'haut-parleurs' | null;
  onHeadphones: (has: boolean) => void;
  monitoring: boolean;
  onMonitoring: (on: boolean) => void;
  /** Piste armée (micro ouvert) : vumètre. */
  micTrackId: string | null;
  onTestMic: () => void;
  // Mix de l'ingé en direct
  mixFrom: string | null;
  listening: boolean;
  mixStatus?: 'connexion' | 'ecoute' | 'silence' | 'echec';
  onToggleListen: () => void;
  onRetryMix?: () => void;
  // Transport
  isPlaying: boolean;
  isRecording: boolean;
  onPlay: () => void;
  onRecord: () => void;
  position: () => number;
  // Paroles
  lyrics: string;
  /** Prompteur (réglages des paroles du projet) : position de la 1re ligne (s), lignes par minute. */
  lyricsStart: number;
  lyricsSpeed: number;
  onLyrics: (text: string) => void;
  // Prises
  takes: GuestTake[];
  auditionN: number | null;
  onAudition: (n: number | null) => void;
  onKeep: (n: number) => void;
  /** 📌 Prises mises de côté (zone « Prises gardées » de l'ingé). */
  keptTakes?: number[];
  /** Mettre de côté / retirer (absent : l'ingé ne te laisse pas modifier la piste). */
  onPin?: (n: number) => void;
  /** Prochaine prise : au même endroit que la précédente, ou à la suite. */
  nextTakeFrom: 'same' | 'next';
  onNextTakeFrom: (v: 'same' | 'next') => void;
  onDelete: (n: number) => void;
  // Parler à l'ingé
  talkOn: boolean;
  onTalk: (on: boolean) => void;
  talking: string[];
  messages: CollabMessage[];
  onSend: (text: string) => void;
  /** Dernier message de l'appli (refus, prise envoyée…) : affiché ici, sinon invisible au téléphone. */
  notice: { text: string; id: number } | null;
  onLeave: () => void;
  onShowSession: () => void;
  /** Chantier 11 : carte « Retours » (commentaires horodatés, versions à valider), components/CommentsPanel. */
  review?: React.ReactNode;
  /** Commentaires ouverts + versions en attente de son avis (pastille du bouton 💬). */
  reviewBadge?: number;
  /** B3 : où en est l'envoi de ma prise (« Prise en cours d'envoi… 80 % », « Prise reçue par Max ✓ »). */
  takeSend?: React.ReactNode;
  /** B3 : test de connexion en un bouton (verdict, temps d'arrivée d'une prise). */
  netTest?: React.ReactNode;
  /** Chantier 17 : télécommande de cabine permise par l'ingé (components/CabinRemote). */
  cabin?: { onOpen: () => void } | null;
}

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

/** Touches qui restent permises au clavier (lecture, REC) : le reste du DAW est à l'ingé. */
const GUEST_KEYS = new Set([' ', 'r', 'R', 'Escape', 'Enter', 'Tab']);

const GuestStudio: React.FC<GuestStudioProps> = (p) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [text, setText] = useState('');
  const [editLyrics, setEditLyrics] = useState(!p.lyrics.trim());
  const [draft, setDraft] = useState(p.lyrics);
  const [shownNotice, setShownNotice] = useState<{ text: string; id: number } | null>(null);
  const [now, setNow] = useState(0);
  // Réglages du casque : repliés dès la première prise (les prises passent en haut), rouvrables d'un toucher.
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  const setupExpanded = setupOpen ?? p.takes.length === 0;
  const chatRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const eng = p.engineer?.name || "l'ingé";

  // Raccourcis du DAW coupés (Ctrl+Z annulait chez lui les réglages de l'ingé, Suppr effaçait une piste…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (GUEST_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => { if (!editLyrics) setDraft(p.lyrics); }, [p.lyrics, editLyrics]);
  useEffect(() => {
    if (!p.notice) return;
    setShownNotice(p.notice);
    const id = window.setTimeout(() => setShownNotice(n => (n?.id === p.notice!.id ? null : n)), 8000);
    return () => window.clearTimeout(id);
  }, [p.notice]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [p.messages.length]);
  // Ligne de paroles qui suit la lecture (position du morceau, comme le prompteur du studio).
  const positionRef = useRef(p.position);
  positionRef.current = p.position;
  useEffect(() => {
    if (!p.isPlaying && !p.isRecording) return;
    setNow(positionRef.current());
    const id = window.setInterval(() => setNow(positionRef.current()), 250);
    return () => window.clearInterval(id);
  }, [p.isPlaying, p.isRecording]);

  const lines = p.lyrics.split('\n').map(l => l.trim()).filter(Boolean);
  // Même rythme que le prompteur de paroles du studio (position de départ, lignes par minute).
  const lineAt = lines.length && (p.isPlaying || p.isRecording) && now >= p.lyricsStart
    ? Math.min(lines.length - 1, Math.floor(((now - p.lyricsStart) * Math.max(1, p.lyricsSpeed)) / 60)) : -1;
  const lineRef = useRef<HTMLLIElement>(null);
  const linesBoxRef = useRef<HTMLOListElement>(null);
  // La ligne en cours reste visible dans la carte (sans faire sauter la page).
  useEffect(() => {
    const li = lineRef.current, box = linesBoxRef.current;
    if (li && box) box.scrollTop = Math.max(0, li.offsetTop - box.offsetTop - 32);
  }, [lineAt]);
  const statusBad = p.status && (p.status.tone === 'warn' || p.status.tone === 'error');
  const send = () => { const t = text.trim(); if (t) { p.onSend(t); setText(''); } };
  const card = 'rounded-3xl border border-white/10 bg-white/[0.04] p-4 space-y-3';
  const big = 'min-h-[52px] rounded-2xl px-4 text-[15px] font-black transition-colors disabled:opacity-40';

  return (
    <div data-testid="guest-studio" className="fixed inset-0 z-[560] flex flex-col bg-nv-bg text-white" role="main" aria-label={`Séance de ${eng}`}>
      {/* 1. Où je suis, qui est là */}
      <header className="shrink-0 border-b border-white/10 bg-nv-surface/95 px-4 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-bold text-slate-400">Tu es dans la séance de <b className="text-amber-300">{eng}</b></p>
            <h1 className="truncate text-[18px] font-black leading-tight">{p.sessionName}</h1>
            <p data-testid="guest-who" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-200">
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${p.engineer?.online ? 'bg-emerald-400' : 'bg-slate-500'}`} aria-hidden />
                <b>{eng}</b> (ingé son) · {p.engineer ? p.engineer.label : 'pas encore arrivé'}
              </span>
              {p.others.map(o => (
                <span key={o.key} className="inline-flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-full ${PEER_STATE_TONE[o.state]}`} aria-hidden />
                  <b style={{ color: o.color || undefined }}>{o.name}</b> · {o.label}
                </span>
              ))}
            </p>
          </div>
          {p.review && (
            <button type="button" data-testid="guest-review-jump" aria-label={`Commentaires et versions${p.reviewBadge ? ` (${p.reviewBadge})` : ''}`}
              onClick={() => reviewRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
              className="relative h-12 shrink-0 rounded-2xl bg-amber-400/90 px-3 text-[14px] font-black text-black">💬
              {!!p.reviewBadge && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-500 px-1 text-[11px] leading-5 text-white">{p.reviewBadge}</span>}
            </button>
          )}
          <div className="relative shrink-0">
            <button type="button" data-testid="guest-menu" aria-label="Plus d'options" aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}
              className="h-12 w-12 rounded-2xl bg-white/10 text-[20px] font-black">⋯</button>
            {menuOpen && (
              <div className="absolute right-0 top-14 z-10 w-64 space-y-1 rounded-2xl border border-white/10 bg-nv-surface p-2 shadow-2xl" role="menu">
                <button type="button" role="menuitem" data-testid="guest-show-session" onClick={() => { setMenuOpen(false); p.onShowSession(); }}
                  className="min-h-12 w-full rounded-xl px-3 text-left text-[14px] font-bold hover:bg-white/10">👀 Voir toute la séance (sans rien toucher)</button>
                <button type="button" role="menuitem" data-testid="guest-leave" onClick={() => { setMenuOpen(false); setConfirmLeave(true); }}
                  className="min-h-12 w-full rounded-xl px-3 text-left text-[14px] font-bold text-red-200 hover:bg-white/10">🚪 Quitter la séance</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Ce qui se passe maintenant : l'ingé parle, la connexion a un souci, un message de l'appli */}
      <div className="shrink-0 space-y-2 px-4 pt-2" aria-live="polite">
        <div className="mx-auto w-full max-w-5xl space-y-2">
          {p.talking.length > 0 && (
            <p role="status" data-testid="guest-talking" className="rounded-2xl bg-sky-400 px-4 py-3 text-[16px] font-black text-black">🔊 {p.talking.join(', ')} te parle…</p>
          )}
          {statusBad && (
            <div role="status" data-testid="guest-status" data-tone={p.status!.tone} className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-[14px] font-bold ${p.status!.tone === 'error' ? 'bg-red-500/20 text-red-100' : 'bg-amber-500/20 text-amber-100'}`}>
              <span className="min-w-0 flex-1">{p.status!.code === 'offline'
                ? '📡 Connexion perdue. Pas de panique : tes prises et tes messages sont gardés sur ton appareil et partiront toutes seules quand le réseau revient.'
                : p.status!.label}</span>
              {p.status!.action && <button type="button" data-testid="guest-retry" onClick={p.onRetry} className="h-11 shrink-0 rounded-xl bg-white px-3 text-[13px] font-black text-black">{p.status!.action === 'reload' ? 'Recharger' : 'Réessayer'}</button>}
            </div>
          )}
          {p.takeSend}
          {shownNotice && (
            <p role="status" data-testid="guest-notice" className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2.5 text-[13px] font-semibold text-cyan-50">{shownNotice.text}</p>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-32 pt-2">
        <div className="mx-auto grid w-full max-w-5xl gap-3 md:grid-cols-2">
          {/* Au studio, en cabine : le téléphone devient la télécommande (droit donné par l'ingé) */}
          {p.cabin && (
            <section className="rounded-3xl border border-red-400/40 bg-red-500/10 p-4 space-y-3 md:col-span-2" data-testid="guest-cabin" aria-labelledby="guest-cabin-t">
              <h2 id="guest-cabin-t" className="text-[15px] font-black">🎛️ Tu es en cabine au studio ?</h2>
              <p className="text-[14px] text-slate-200">Ton téléphone devient la télécommande : <b>REC</b>, lecture, retour au début, et tes paroles en grand. C'est le micro du studio qui enregistre, chez {eng}.</p>
              <button type="button" data-testid="guest-cabin-open" onClick={p.cabin.onOpen} className={`${big} w-full bg-red-500 text-white`}>Passer en mode cabine</button>
            </section>
          )}

          {/* 2. Casque et micro */}
          <section className={card} data-testid="guest-setup" data-open={setupExpanded ? '1' : '0'} aria-labelledby="guest-setup-t">
            <div className="flex items-center justify-between gap-2">
              <h2 id="guest-setup-t" className="text-[15px] font-black">🎧 Ton casque et ton micro</h2>
              {!setupExpanded && <button type="button" onClick={() => setSetupOpen(true)} className="h-11 rounded-xl bg-white/10 px-3 text-[13px] font-bold">Régler</button>}
            </div>
            {!setupExpanded ? (
              <p className="text-[13px] text-slate-300">{p.headphones === 'casque' ? '✅ Casque' : p.headphones === 'haut-parleurs' ? '🔈 Sans casque (haut-parleurs)' : '❔ Casque : pas encore dit'} · {p.monitoring ? 'ta voix dans le casque' : 'sans retour de ta voix'}</p>
            ) : <>
            {p.headphones === 'casque' ? (
              <p data-testid="guest-headphones" data-state="casque" className="text-[14px] text-emerald-200">✅ Casque branché : tu entends le beat et ta voix pendant la prise.</p>
            ) : p.headphones === 'haut-parleurs' ? (
              <div data-testid="guest-headphones" data-state="haut-parleurs" className="space-y-2 rounded-2xl bg-amber-500/15 p-3 text-[14px] text-amber-50">
                <p><b>Pas de casque ?</b> Le micro va reprendre le son du beat et ta prise sera moins propre.</p>
                <p>👉 Branche des écouteurs (même ceux du téléphone, filaires si possible). Sinon, baisse le son et éloigne le téléphone de ta bouche.</p>
                <button type="button" onClick={() => p.onHeadphones(true)} className={`${big} w-full bg-white text-black`}>J'ai branché un casque</button>
              </div>
            ) : (
              <div data-testid="guest-headphones" data-state="inconnu" className="space-y-2">
                <p className="text-[14px] text-slate-200">Tu as un casque ou des écouteurs ?</p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => p.onHeadphones(true)} className={`${big} bg-cyan-500 text-black`}>Oui</button>
                  <button type="button" onClick={() => p.onHeadphones(false)} className={`${big} bg-white/10`}>Non</button>
                </div>
              </div>
            )}
            {p.micTrackId ? (
              <div data-testid="guest-mic"><MicLevelMeter trackId={p.micTrackId} /></div>
            ) : (
              <button type="button" data-testid="guest-test-mic" onClick={p.onTestMic} className={`${big} w-full bg-white/10`}>🎤 Tester mon micro</button>
            )}
            <button type="button" role="switch" aria-checked={p.monitoring} data-testid="guest-monitoring" onClick={() => p.onMonitoring(!p.monitoring)}
              className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-3 text-left">
              <span className="text-[14px]">Entendre ma voix dans le casque</span>
              <span aria-hidden className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${p.monitoring ? 'bg-cyan-400' : 'bg-white/20'}`}>
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${p.monitoring ? 'left-6' : 'left-1'}`} />
              </span>
            </button>
            {p.monitoring && p.headphones === 'haut-parleurs' && <p className="text-[12px] text-amber-200">Sans casque, ta voix ressort dans les haut-parleurs et peut siffler (larsen) : coupe cette option.</p>}
            </>}
          </section>

          {/* Connexion : un test avant la séance */}
          {p.netTest && (
            <section className={card} data-testid="guest-net" aria-labelledby="guest-net-t">
              <h2 id="guest-net-t" className="text-[15px] font-black">📶 Ta connexion</h2>
              {p.netTest}
            </section>
          )}

          {/* 3. Le mix de l'ingé */}
          <section className={card} data-testid="guest-listen" aria-labelledby="guest-listen-t">
            <h2 id="guest-listen-t" className="text-[15px] font-black">🔊 Écouter le son de {eng}</h2>
            {p.mixFrom ? (
              <>
                <button type="button" data-testid="guest-listen-toggle" aria-pressed={p.listening} onClick={p.onToggleListen}
                  className={`${big} w-full ${p.listening ? 'bg-sky-400 text-black' : 'bg-white/10'}`}>
                  {p.listening ? `✓ Tu écoutes le son de ${p.mixFrom}` : `🎧 Écouter le son de ${p.mixFrom}`}
                </button>
                {p.listening && p.mixStatus && (
                  <p data-testid="guest-mix-status" data-state={p.mixStatus} className={`text-[13px] font-bold ${p.mixStatus === 'ecoute' ? 'text-emerald-200' : p.mixStatus === 'echec' ? 'text-red-200' : 'text-slate-300'}`}>
                    {p.mixStatus === 'ecoute' ? '🟢 Le son arrive.'
                      : p.mixStatus === 'silence' ? `⏸️ Bien relié : ${p.mixFrom} n'a pas encore lancé la lecture.`
                        : p.mixStatus === 'connexion' ? '⏳ Connexion au son…'
                          : <>⚠️ Le son n'arrive pas : tu entends ta propre version. {p.onRetryMix && <button type="button" onClick={p.onRetryMix} className="ml-1 underline">Réessayer</button>}</>}
                  </p>
                )}
                <p className="text-[12px] text-slate-400">Tu entends exactement ce qu'entend {p.mixFrom}, avec un petit décalage. Pendant ta prise, tu entends le beat de ton côté, en rythme.</p>
              </>
            ) : (
              <p data-testid="guest-listen-wait" className="text-[14px] text-slate-300">{eng} n'envoie pas encore son son. En attendant, tu entends la séance de ton côté (bouton ▶ en bas).</p>
            )}
          </section>

          {/* 4. Paroles */}
          <section className={card} data-testid="guest-lyrics" aria-labelledby="guest-lyrics-t">
            <div className="flex items-center justify-between gap-2">
              <h2 id="guest-lyrics-t" className="text-[15px] font-black">📝 Tes paroles</h2>
              {!editLyrics && <button type="button" onClick={() => { setDraft(p.lyrics); setEditLyrics(true); }} className="h-11 rounded-xl bg-white/10 px-3 text-[13px] font-bold">Modifier</button>}
            </div>
            {editLyrics ? (
              <>
                <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={5} data-testid="guest-lyrics-input" aria-label="Tes paroles"
                  placeholder="Colle ou écris tes paroles ici : elles défilent pendant ta prise."
                  className="w-full rounded-2xl border border-white/10 bg-black/40 p-3 text-[15px] leading-snug text-white" />
                <button type="button" data-testid="guest-lyrics-save" onClick={() => { p.onLyrics(draft); setEditLyrics(false); }} className={`${big} w-full bg-cyan-500 text-black`}>Garder mes paroles</button>
              </>
            ) : (
              <ol ref={linesBoxRef} data-testid="guest-lyrics-lines" className="max-h-48 space-y-1 overflow-y-auto text-[16px] leading-snug">
                {lines.map((l, i) => (
                  <li key={i} ref={i === lineAt ? lineRef : undefined} data-now={i === lineAt ? '1' : undefined} className={i === lineAt ? 'font-black text-cyan-200' : 'text-slate-300'}>{l}</li>
                ))}
              </ol>
            )}
          </section>

          {/* 5. Prises */}
          <section className={`${card} ${p.takes.length ? 'order-first' : ''}`} data-testid="guest-takes" aria-labelledby="guest-takes-t">
            <h2 id="guest-takes-t" className="text-[15px] font-black">🎙️ Tes prises</h2>
            {p.takes.length === 0 ? (
              <p className="text-[14px] text-slate-300">Pas encore de prise. Quand {eng} te dit « vas-y », appuie sur le gros bouton rouge ● en bas : un décompte part, puis chante.</p>
            ) : (
              <ul className="space-y-2">
                {p.takes.map(t => {
                  const kept = t.used > 0.05;
                  const playing = p.auditionN === t.n;
                  const pinned = !!p.keptTakes?.includes(t.n);
                  return (
                    <li key={t.n} data-testid="guest-take" data-n={t.n} data-kept={kept ? '1' : '0'} className={`rounded-2xl border p-3 ${kept ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
                      <p className="text-[14px] font-black">{t.name} <span className="font-normal text-slate-400">· {fmt(t.end - t.start)}</span>{kept && <span className="ml-2 rounded-lg bg-emerald-400 px-2 py-0.5 text-[11px] font-black text-black">gardée</span>}{pinned && <span className="ml-2 rounded-lg bg-amber-400 px-2 py-0.5 text-[11px] font-black text-black">📌 de côté</span>}</p>
                      <div className={`mt-2 grid ${p.onPin ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'} gap-2`}>
                        <button type="button" data-testid="guest-take-play" aria-pressed={playing} onClick={() => p.onAudition(playing ? null : t.n)}
                          className={`h-12 rounded-xl text-[13px] font-black ${playing ? 'bg-sky-400 text-black' : 'bg-white/10'}`}>{playing ? '■ Stop' : '▶ Écouter'}</button>
                        <button type="button" data-testid="guest-take-keep" disabled={kept} onClick={() => p.onKeep(t.n)}
                          className="h-12 rounded-xl bg-emerald-500/80 text-[13px] font-black text-black disabled:opacity-40">✓ Garder</button>
                        {p.onPin && (
                          <button type="button" data-testid="guest-take-pin" aria-pressed={pinned} onClick={() => p.onPin!(t.n)}
                            className={`h-12 rounded-xl text-[13px] font-black ${pinned ? 'bg-amber-400 text-black' : 'bg-amber-500/15 text-amber-200'}`}>{pinned ? '📌 Retirer' : '📌 De côté'}</button>
                        )}
                        <button type="button" data-testid="guest-take-delete" onClick={() => p.onDelete(t.n)}
                          className="h-12 rounded-xl bg-white/10 text-[13px] font-black text-red-200">🗑 Effacer</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {p.takes.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Prochaine prise">
                  <button type="button" role="radio" aria-checked={p.nextTakeFrom === 'same'} data-testid="guest-next-same" onClick={() => p.onNextTakeFrom('same')}
                    className={`min-h-12 rounded-xl px-2 text-[13px] font-bold ${p.nextTakeFrom === 'same' ? 'bg-white text-black' : 'bg-white/10'}`}>⟲ Refaire au même endroit</button>
                  <button type="button" role="radio" aria-checked={p.nextTakeFrom === 'next'} data-testid="guest-next-next" onClick={() => p.onNextTakeFrom('next')}
                    className={`min-h-12 rounded-xl px-2 text-[13px] font-bold ${p.nextTakeFrom === 'next' ? 'bg-white text-black' : 'bg-white/10'}`}>⏭ Continuer à la suite</button>
                </div>
                <p className="text-[12px] text-slate-400">« Garder » : c'est celle-là que {eng} entend dans le morceau.{p.onPin ? ` « 📌 De côté » : tu la mets de côté pour choisir la meilleure à la fin avec ${eng}.` : ''} Pour recommencer, appuie à nouveau sur ●.</p>
              </>
            )}
          </section>

          {/* Retours : commentaires sur la timeline, versions envoyées par l'ingé (à valider) */}
          {p.review && <div ref={reviewRef} className="scroll-mt-2 md:col-span-2" data-testid="guest-review">{p.review}</div>}

          {/* 6. Parler à l'ingé */}
          <section className={`${card} md:col-span-2`} data-testid="guest-chat" aria-labelledby="guest-chat-t">
            <h2 id="guest-chat-t" className="text-[15px] font-black">💬 Écrire à {eng}</h2>
            <div ref={chatRef} className="max-h-48 space-y-2 overflow-y-auto">
              {p.messages.length === 0 && <p className="text-[13px] text-slate-400">Pas encore de message. Tu peux aussi lui parler de vive voix : maintiens « Parler » en bas.</p>}
              {p.messages.map(m => (
                <div key={m.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-[14px] ${m.mine ? 'ml-auto bg-cyan-500/20' : 'bg-white/10'}`}>
                  {!m.mine && <p className="text-[11px] font-black text-amber-200">{m.from}</p>}
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  {m.pending && <p className="text-[11px] text-slate-400">part dès que le réseau revient…</p>}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') send(); }}
                placeholder={`Message à ${eng}…`} aria-label={`Message à ${eng}`} data-testid="guest-chat-input"
                className="h-12 min-w-0 flex-1 rounded-2xl border border-white/10 bg-black/40 px-3 text-[15px] text-white" />
              <button type="button" data-testid="guest-chat-send" onClick={send} disabled={!text.trim()} className="h-12 min-w-[84px] rounded-2xl bg-cyan-500 px-3 text-[14px] font-black text-black disabled:opacity-40">Envoyer</button>
            </div>
          </section>
        </div>
      </div>

      {/* Pendant la prise : les paroles sous les yeux, en grand, juste au-dessus du bouton */}
      {p.isRecording && lines.length > 0 && (
        <div data-testid="guest-prompter" className="pointer-events-none absolute inset-x-0 bottom-[112px] z-[1] px-4">
          <div className="mx-auto w-full max-w-3xl rounded-3xl border border-red-400/40 bg-black/85 px-5 py-4 text-center shadow-2xl">
            <p className="text-[12px] font-black uppercase tracking-widest text-red-300">● Enregistrement</p>
            <p className="mt-1 text-[22px] font-black leading-tight text-white">{lines[Math.max(0, lineAt)]}</p>
            {lines[Math.max(0, lineAt) + 1] && <p className="mt-1 text-[16px] leading-tight text-slate-400">{lines[Math.max(0, lineAt) + 1]}</p>}
          </div>
        </div>
      )}

      {/* Barre du pouce : réécouter, enregistrer, parler */}
      <footer className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-nv-surface/95 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-[1fr_auto_1fr] items-center gap-3">
          <button type="button" data-testid="guest-play" onClick={p.onPlay} disabled={p.isRecording}
            className={`${big} ${p.isPlaying ? 'bg-white text-black' : 'bg-white/10'}`}>{p.isPlaying ? '■ Stop' : '▶ Écouter'}</button>
          <button type="button" data-testid="guest-rec" onClick={p.onRecord} aria-label={p.isRecording ? 'Arrêter la prise' : 'Enregistrer une prise'}
            className={`flex h-20 w-20 items-center justify-center rounded-full border-4 text-[13px] font-black ${p.isRecording ? 'animate-pulse border-white bg-red-600' : 'border-red-300/60 bg-red-500'}`}>
            {p.isRecording ? '■ STOP' : '● REC'}
          </button>
          <button type="button" data-testid="guest-talk" aria-pressed={p.talkOn}
            onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } p.onTalk(true); }}
            onPointerUp={() => p.onTalk(false)} onPointerCancel={() => p.onTalk(false)}
            onLostPointerCapture={() => { if (p.talkOn) p.onTalk(false); }}
            onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !p.talkOn) { e.preventDefault(); e.stopPropagation(); p.onTalk(true); } }}
            onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') p.onTalk(false); }}
            className={`${big} select-none touch-none leading-tight ${p.talkOn ? 'animate-pulse bg-red-500' : 'bg-white/10'}`}>
            {p.talkOn ? `${eng} t'entend…` : `🎙️ Parler à ${eng}`}
            <span className="block text-[11px] font-semibold text-slate-300">{p.talkOn ? 'relâche pour couper' : 'maintenir'}</span>
          </button>
        </div>
      </footer>

      {confirmLeave && (
        <div className="fixed inset-0 z-[570] flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="guest-leave-t">
          <div className="w-full max-w-sm space-y-3 rounded-3xl border border-white/10 bg-nv-surface p-5">
            <h2 id="guest-leave-t" className="text-[17px] font-black">Quitter la séance de {eng} ?</h2>
            <p className="text-[14px] text-slate-300">Tes prises déjà envoyées restent chez {eng}. Pour revenir plus tard, rouvre simplement le lien qu'il t'a envoyé.</p>
            <button type="button" data-testid="guest-leave-confirm" onClick={() => { setConfirmLeave(false); p.onLeave(); }} className={`${big} w-full bg-red-500`}>Quitter</button>
            <button type="button" onClick={() => setConfirmLeave(false)} className={`${big} w-full bg-white/10`}>Rester</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GuestStudio;
