import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ListenError, openListenLink } from '../services/ListenLinks';
import { ListenReceiver, type ReceiverState } from '../services/ListenReceiver';
import { mixQualityLabel } from '../utils/opusSdp';
import {
  errorCodeOf, fmtClock, fmtDay, listenErrorView, parseListenToken,
  type ListenComment, type ListenErrorCode, type ListenOpenResult, type ListenVersion,
} from '../utils/listenLink';

/**
 * Page d'écoute du CLIENT (artiste, label, manager) : ouverte depuis le lien
 * de l'ingé, sur téléphone, en navigation privée, SANS COMPTE. Chargée par
 * ecoute.html, sans le DAW (chunk séparé, léger).
 *
 *  - grand bouton « Écouter » (débloque le son sur iPhone : le geste lance la lecture) ;
 *  - « En direct » / « Hors ligne » : l'ingé diffuse-t-il son mix en ce moment ;
 *  - versions envoyées (avec leur écoute) et commentaires, en lecture seule ;
 *  - lien expiré, désactivé, protégé : un message clair, et quoi faire.
 *
 * Aucune écriture : la page n'a aucun bouton qui modifie la séance, et le
 * serveur refuse toute écriture avec ce jeton (supabase/functions/daw-listen).
 */

/** WAV silencieux (44 octets d'en-tête + 2 échantillons) : déverrouille l'élément audio dans le geste (iOS). */
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAAAA';
const REFRESH_MS = 30_000;

type View =
  | { kind: 'loading' }
  | { kind: 'error'; code: ListenErrorCode; message?: string | null }
  | { kind: 'ready'; data: ListenOpenResult };

const btn = 'nova-hit-tactile inline-flex items-center justify-center gap-2 rounded-2xl font-black transition-colors disabled:opacity-50';

const ListenPage: React.FC = () => {
  const [token] = useState(() => parseListenToken(typeof window !== 'undefined' ? window.location.hash : ''));
  const [view, setView] = useState<View>(() => (token ? { kind: 'loading' } : { kind: 'error', code: 'missing' }));
  const [password, setPassword] = useState('');
  const passwordRef = useRef('');
  const [busy, setBusy] = useState(false);
  const [rx, setRx] = useState<ReceiverState | null>(null);
  const receiverRef = useRef<ListenReceiver | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const stopLive = useCallback(() => {
    receiverRef.current?.stop();
    receiverRef.current = null;
    setRx(null);
    const el = audioRef.current;
    if (el) { try { el.pause(); el.srcObject = null; } catch { /* */ } }
  }, []);

  const load = useCallback(async (opts: { refresh?: boolean } = {}) => {
    if (!token) return;
    try {
      const data = await openListenLink(token, { password: passwordRef.current || undefined, refresh: opts.refresh });
      setView({ kind: 'ready', data });
    } catch (e) {
      const err = e as ListenError;
      const code = errorCodeOf(err.status, err.code);
      // Un rafraîchissement raté pour une raison de réseau ne casse pas la page ouverte.
      if (opts.refresh && code === 'network') return;
      setView({ kind: 'error', code, message: err.message });
      if (code !== 'network') stopLive();
    }
  }, [token, stopLive]);

  useEffect(() => { void load(); }, [load]);

  // Rafraîchit versions / commentaires, et apprend une révocation ou une expiration.
  const ready = view.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => { void load({ refresh: true }); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load({ refresh: true }); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [ready, load]);

  // Expiration pendant que la page est ouverte : message sans attendre le serveur.
  const expiresAt = view.kind === 'ready' ? Date.parse(view.data.link.expires_at) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const ms = expiresAt - Date.now();
    if (ms > 2_000_000_000) return;
    const id = window.setTimeout(() => { void load({ refresh: true }); }, Math.max(0, ms) + 500);
    return () => window.clearTimeout(id);
  }, [expiresAt, load]);

  // Canal du direct : rejoint dès que la page est prête (pour afficher « En direct »), son seulement après « Écouter ».
  const channel = view.kind === 'ready' ? view.data.channel : null;
  useEffect(() => {
    if (!channel) return;
    const r = new ListenReceiver(channel, s => setRx(s));
    receiverRef.current = r;
    r.start();
    return () => { r.stop(); if (receiverRef.current === r) receiverRef.current = null; };
  }, [channel]);

  // Flux reçu → élément audio (déjà déverrouillé par le geste « Écouter »).
  const stream = rx?.want ? rx.stream : null;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (stream) {
      if (el.srcObject !== stream) {
        el.removeAttribute('src');
        el.srcObject = stream;
      }
      void el.play().catch(() => { /* rejoué au prochain geste */ });
    } else if (el.srcObject) {
      el.srcObject = null;
    }
  }, [stream]);

  useEffect(() => () => stopLive(), [stopLive]);

  // Titre de l'onglet : le nom de la séance (retrouver l'onglet parmi d'autres).
  const sessionName = view.kind === 'ready' ? view.data.session.name : null;
  useEffect(() => { if (sessionName) document.title = `Écoute · ${sessionName}`; }, [sessionName]);

  // Une seule chose à la fois : lancer une version arrête le direct (et « Écouter » arrête les versions).
  const wantRef = useRef(false);
  wantRef.current = !!rx?.want;
  useEffect(() => {
    const onPlay = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.getAttribute?.('data-testid') === 'listen-version-audio' && wantRef.current) receiverRef.current?.setWant(false);
    };
    document.addEventListener('play', onPlay, true);
    return () => document.removeEventListener('play', onPlay, true);
  }, []);

  const listen = () => {
    const r = receiverRef.current;
    if (!r) return;
    if (rx?.want) { r.setWant(false); try { audioRef.current?.pause(); } catch { /* */ } return; }
    document.querySelectorAll<HTMLAudioElement>('[data-testid=listen-version-audio]').forEach(a => { try { a.pause(); } catch { /* */ } });
    // Dans le geste (iPhone) : contexte audio repris + élément audio lancé, sinon pas de son plus tard.
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) {
        const ctx: AudioContext = ctxRef.current || new AC();
        ctxRef.current = ctx;
        void ctx.resume();
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
      }
    } catch { /* */ }
    const el = audioRef.current;
    if (el) {
      el.muted = false;
      if (!el.srcObject) el.src = SILENT_WAV;
      void el.play().catch(() => { /* */ });
    }
    r.setWant(true);
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    passwordRef.current = password;
    setBusy(true);
    await load();
    setBusy(false);
  };

  return (
    <div className="min-h-[100dvh] w-full bg-[#0c0d10] text-white" data-testid="listen-page">
      <audio ref={audioRef} data-listen-audio="mix" playsInline autoPlay className="hidden" />
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="flex items-center gap-2 pt-1">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-[15px] font-black text-black" aria-hidden>N</span>
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">NOVA Studio · écoute</p>
            {view.kind === 'ready' && <h1 className="truncate text-[19px] font-black leading-tight" data-testid="listen-session-name">{view.data.session.name}</h1>}
          </div>
        </header>

        {view.kind === 'loading' && (
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center text-[14px] text-slate-300" role="status">
            <span className="mx-auto mb-3 block h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-cyan-300" aria-hidden />
            Ouverture du lien…
          </div>
        )}

        {view.kind === 'error' && (() => {
          const ev = listenErrorView(view.code, view.message);
          return (
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5" data-testid="listen-error" data-code={view.code} role={ev.password ? undefined : 'alert'}>
              <p className="text-[34px] leading-none" aria-hidden>{ev.password ? '🔒' : view.code === 'network' ? '📶' : '⛔'}</p>
              <h2 className="mt-3 text-[20px] font-black" data-testid="listen-error-title">{ev.title}</h2>
              <p className="mt-1 text-[14px] leading-snug text-slate-300" data-testid="listen-error-text">{ev.text}</p>
              {ev.password && (
                <form onSubmit={submitPassword} className="mt-4 flex flex-col gap-2">
                  <label className="text-[12px] font-bold text-slate-300" htmlFor="listen-pw">Mot de passe</label>
                  <input id="listen-pw" type="password" autoComplete="off" autoFocus value={password} onChange={e => setPassword(e.target.value)}
                    data-testid="listen-password" className="h-12 rounded-2xl border border-white/15 bg-black/40 px-4 text-[16px] text-white" />
                  <button type="submit" disabled={busy || !password.trim()} data-testid="listen-password-submit" className={`${btn} h-12 bg-cyan-400 text-black`}>
                    {busy ? 'Vérification…' : 'Ouvrir'}
                  </button>
                </form>
              )}
              {ev.retry && <button type="button" onClick={() => { setView({ kind: 'loading' }); void load(); }} className={`${btn} mt-4 h-12 w-full bg-white text-black`}>Réessayer</button>}
            </div>
          );
        })()}

        {view.kind === 'ready' && (
          <>
            {view.data.link.label && <p className="-mt-2 text-[13px] text-slate-400">Pour : <span className="font-bold text-slate-200">{view.data.link.label}</span></p>}
            {view.data.link.live && <LiveCard rx={rx} onListen={listen} />}
            {view.data.versions && <VersionsCard versions={view.data.versions} />}
            {view.data.comments && <CommentsCard comments={view.data.comments} />}
            <footer className="space-y-1 pt-2 text-center text-[11px] text-slate-500">
              <p>🔒 Lecture seule : rien ne peut être modifié dans la séance depuis cette page.</p>
              <p>Lien valable jusqu'au {fmtDay(view.data.link.expires_at)}.</p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

const LiveCard: React.FC<{ rx: ReceiverState | null; onListen: () => void }> = ({ rx, onListen }) => {
  const live = !!rx?.host?.live;
  const want = !!rx?.want;
  const hearing = want && !!rx?.stream;
  const quality = hearing ? mixQualityLabel(rx?.quality) : null;
  const status = !want ? null
    : !live ? { tone: 'text-slate-300', text: "⏳ En attente de l'ingé : le son arrive tout seul dès qu'il diffuse." }
      : !rx?.stream ? { tone: 'text-sky-200', text: '⏳ Connexion au mix…' }
        : rx.health === 'silence' ? { tone: 'text-slate-300', text: "⏸️ Relié, mais rien ne joue en ce moment (l'ingé est à l'arrêt)." }
          : { tone: 'text-emerald-200', text: '🔊 Tu écoutes le mix en direct.' };
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4" aria-label="Mix en direct">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-black uppercase tracking-wider text-slate-300">Mix en direct</h2>
        <span data-testid="listen-live-state" data-state={live ? 'live' : 'offline'}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-black ${live ? 'bg-red-500/20 text-red-200' : 'bg-white/10 text-slate-300'}`}>
          <span className={`h-2 w-2 rounded-full ${live ? 'bg-red-400 animate-pulse' : 'bg-slate-500'}`} aria-hidden />
          {live ? 'En direct' : 'Hors ligne'}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-slate-400">
        {live ? `${rx?.host?.name ? `${rx.host.name} diffuse` : "L'ingé diffuse"} son mix maintenant, en qualité studio.`
          : rx?.channel === 'down' ? 'Connexion au direct interrompue : nouvel essai automatique…'
            : "L'ingé ne diffuse pas en ce moment. Garde la page ouverte : « En direct » s'allume dès qu'il commence."}
      </p>
      <button type="button" onClick={onListen} disabled={!rx} data-testid="listen-play" aria-pressed={want}
        className={`${btn} mt-3 h-16 w-full text-[19px] ${want ? 'bg-white/10 text-white' : 'bg-cyan-400 text-black shadow-[0_8px_30px_rgba(34,211,238,0.35)]'}`}>
        {want ? '⏸ Arrêter l’écoute' : '▶ Écouter'}
      </button>
      {status && <p role="status" data-testid="listen-status" data-hearing={hearing ? '1' : '0'} className={`mt-2 text-[13px] font-bold ${status.tone}`}>{status.text}
        {quality && <span data-testid="listen-quality" className={`ml-1 font-mono text-[12px] ${quality.warn ? 'text-amber-300' : 'text-emerald-300/80'}`}>· {quality.text}</span>}</p>}
      {!want && <p className="mt-2 text-[11px] text-slate-500">Avec un casque ou de bonnes enceintes, c'est mieux. Le son passe par le haut-parleur du téléphone sinon.</p>}
    </section>
  );
};

const DECISION: Record<'approved' | 'changes', { text: string; tone: string }> = {
  approved: { text: '✅ Validée', tone: 'bg-emerald-500/15 text-emerald-200' },
  changes: { text: '✏️ Retouches demandées', tone: 'bg-amber-500/15 text-amber-100' },
};

const VersionsCard: React.FC<{ versions: ListenVersion[] }> = ({ versions }) => (
  <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4" aria-label="Versions envoyées" data-testid="listen-versions">
    <h2 className="text-[13px] font-black uppercase tracking-wider text-slate-300">Versions envoyées · {versions.length}</h2>
    {versions.length === 0
      ? <p className="mt-2 text-[13px] text-slate-400" data-testid="listen-versions-empty">Aucune version pour l'instant. Elles apparaîtront ici dès que l'ingé en envoie une.</p>
      : <ul className="mt-2 space-y-2">{versions.map(v => <VersionRow key={v.id} v={v} />)}</ul>}
  </section>
);

const VersionRow: React.FC<{ v: ListenVersion }> = ({ v }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const canPlay = !!(v.audio && v.urls && v.audio.parts.every(p => v.urls![p]));
  const fetchAudio = async () => {
    if (!v.audio || !v.urls) return;
    setErr(null); setPct(0);
    try {
      const blobs: Blob[] = [];
      for (let i = 0; i < v.audio.parts.length; i++) {
        const r = await fetch(v.urls[v.audio.parts[i]]);
        if (!r.ok) throw new Error(String(r.status));
        blobs.push(await r.blob());
        setPct(Math.round(((i + 1) / v.audio.parts.length) * 100));
      }
      setSrc(URL.createObjectURL(new Blob(blobs, { type: 'audio/wav' })));
    } catch {
      setErr("Téléchargement impossible (lien périmé ou réseau) : recharge la page puis réessaie.");
    } finally { setPct(null); }
  };
  return (
    <li className="rounded-2xl bg-white/[0.04] p-3" data-testid="listen-version">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-black">{v.name}</p>
          <p className="text-[11px] text-slate-400">Envoyée par {v.sent_by}{v.sent_at ? ` le ${fmtDay(v.sent_at)}` : ''}{v.audio?.duration ? ` · ${fmtClock(v.audio.duration)}` : ''}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black ${v.decision ? DECISION[v.decision.kind].tone : 'bg-white/10 text-slate-300'}`}>
          {v.decision ? DECISION[v.decision.kind].text : 'En attente'}
        </span>
      </div>
      {v.note && <p className="mt-1 text-[12px] text-slate-300">« {v.note} »</p>}
      {v.decision && <p className="mt-1 text-[11px] text-slate-400">{v.decision.kind === 'approved' ? 'Validée' : 'Retouches demandées'} par {v.decision.by}{v.decision.at ? ` le ${fmtDay(v.decision.at)}` : ''}{v.decision.comment ? ` : « ${v.decision.comment} »` : ''}</p>}
      {src ? <audio controls src={src} className="mt-2 w-full" data-testid="listen-version-audio" />
        : canPlay ? (
          <button type="button" onClick={() => { void fetchAudio(); }} disabled={pct !== null} data-testid="listen-version-play" className={`${btn} mt-2 h-11 w-full bg-white/10 text-[14px] text-white`}>
            {pct !== null ? `Chargement… ${pct} %` : `▶ Écouter cette version${v.audio?.size ? ` (${(v.audio.size / 1e6).toFixed(1)} Mo)` : ''}`}
          </button>
        ) : <p className="mt-2 text-[11px] text-slate-500">Pas de fichier pour cette version : écoute-la dans le direct.</p>}
      {err && <p className="mt-1 text-[12px] text-red-300" role="alert">{err}</p>}
    </li>
  );
};

const CommentsCard: React.FC<{ comments: ListenComment[] }> = ({ comments }) => (
  <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4" aria-label="Commentaires" data-testid="listen-comments">
    <h2 className="text-[13px] font-black uppercase tracking-wider text-slate-300">Commentaires · {comments.length}</h2>
    {comments.length === 0
      ? <p className="mt-2 text-[13px] text-slate-400" data-testid="listen-comments-empty">Aucun commentaire pour l'instant.</p>
      : (
        <ul className="mt-2 space-y-2">
          {comments.map(c => (
            <li key={c.id} className={`rounded-2xl bg-white/[0.04] p-3 ${c.status === 'resolved' ? 'opacity-70' : ''}`} data-testid="listen-comment">
              <p className="text-[12px] text-slate-400">
                <span className="mr-1 rounded-md bg-cyan-400/15 px-1.5 py-0.5 font-mono font-black text-cyan-200">{fmtClock(c.t)}{c.end !== null ? ` → ${fmtClock(c.end)}` : ''}</span>
                <span className="font-bold text-slate-200">{c.author}</span>
                {c.status === 'resolved' && <span className="ml-1 text-emerald-300">· ✓ réglé</span>}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-[14px]">{c.text}</p>
              {c.replies.length > 0 && (
                <ul className="mt-1.5 space-y-1 border-l-2 border-white/10 pl-2">
                  {c.replies.map((r, i) => <li key={i} className="text-[13px] text-slate-300"><span className="font-bold text-slate-200">{r.author}</span> : {r.text}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
  </section>
);

export default ListenPage;
