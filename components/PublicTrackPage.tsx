import React, { useCallback, useEffect, useRef, useState } from 'react';
import { openPublicTrack, PublicTrackError } from '../services/PublicTracks';
import {
  fmtDuration, parsePublicLocation, playsText, publicErrorCode, publicErrorView,
  type PublicErrorCode, type PublicTrackView,
} from '../utils/publicTrack';

/**
 * Lot 9b (1.5.1) · Page PUBLIQUE d'un morceau (morceau.html, chargée sans le DAW) :
 * pochette, titre, artiste, lecteur, crédits, paroles (si l'auteur l'a choisi) et
 * « Réserver une session au studio Make Music ». Avec &embed=1 : le lecteur compact à
 * intégrer dans une <iframe> sur un autre site.
 *
 * Aucun téléchargement : pas de bouton, pas de lecteur natif (menu « Enregistrer sous »),
 * le son n'est chargé qu'au premier « Écouter » (liens signés valables 1 h). La page ne
 * montre jamais les pistes séparées : le serveur ne donne que l'extrait ou le mix publié.
 */

type View = { kind: 'loading' } | { kind: 'error'; code: PublicErrorCode } | { kind: 'ready'; data: PublicTrackView };

const btn = 'nova-hit-tactile inline-flex items-center justify-center gap-2 rounded-2xl font-black transition-colors disabled:opacity-50';

const PublicTrackPage: React.FC = () => {
  const [{ id, embed }] = useState(() => parsePublicLocation(typeof window !== 'undefined' ? window.location.search : ''));
  const [view, setView] = useState<View>(() => (id ? { kind: 'loading' } : { kind: 'error', code: 'missing' }));
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try { setView({ kind: 'ready', data: await openPublicTrack(id) }); }
    catch (e) { const err = e as PublicTrackError; setView({ kind: 'error', code: publicErrorCode(err.status, err.code) }); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const data = view.kind === 'ready' ? view.data : null;
  useEffect(() => {
    if (data?.title) document.title = `${data.title}${data.artist ? ` · ${data.artist}` : ''} · NOVA Studio`;
  }, [data?.title, data?.artist]);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el || !data) return;
    if (playing) { el.pause(); return; }
    if (!src) {
      setLoadingAudio(true); setAudioErr(null);
      try {
        let urls = data.urls;
        // Liens signés périmés (page ouverte depuis longtemps) : on les redemande.
        const fetchAll = async (list: string[]) => Promise.all(list.map(async u => { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return r.blob(); }));
        let blobs: Blob[];
        try { blobs = await fetchAll(urls); } catch {
          const fresh = await openPublicTrack(data.id, { refresh: true });
          urls = fresh.urls;
          blobs = await fetchAll(urls);
        }
        const url = URL.createObjectURL(new Blob(blobs, { type: data.mime || 'audio/mpeg' }));
        setSrc(url);
        el.src = url;
      } catch {
        setAudioErr('Lecture impossible (réseau) : recharge la page puis réessaie.');
        setLoadingAudio(false);
        return;
      }
      setLoadingAudio(false);
    }
    try { await el.play(); } catch { setAudioErr('Touche encore « Écouter » pour lancer le son.'); }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el || !src) return;
    el.currentTime = Number(e.target.value);
    setPos(el.currentTime);
  };

  const duration = data?.duration || 0;
  const player = data && (
    <div className="flex items-center gap-3" onContextMenu={e => e.preventDefault()}>
      <button type="button" onClick={() => void toggle()} disabled={loadingAudio} data-testid="pub-play" aria-pressed={playing}
        aria-label={playing ? 'Pause' : 'Écouter'}
        className={`${btn} ${embed ? 'h-12 w-12' : 'h-16 w-16'} shrink-0 rounded-full bg-cyan-400 text-[22px] text-black shadow-[0_8px_30px_rgba(34,211,238,0.35)]`}>
        {loadingAudio ? '…' : playing ? '❚❚' : '▶'}
      </button>
      <div className="min-w-0 flex-1">
        <input type="range" min={0} max={Math.max(1, duration)} step={0.1} value={Math.min(pos, duration)} onChange={seek} disabled={!src}
          aria-label="Position dans le morceau" data-testid="pub-seek" className="w-full accent-cyan-400" />
        <p className="flex justify-between font-mono text-[11px] text-slate-400"><span>{fmtDuration(pos)}</span><span>{fmtDuration(duration)}</span></p>
      </div>
    </div>
  );
  const audio = (
    <audio ref={audioRef} preload="none" controlsList="nodownload noplaybackrate" className="hidden" data-testid="pub-audio"
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
      onTimeUpdate={e => setPos(e.currentTarget.currentTime)} />
  );

  if (embed) {
    return (
      <div className="flex h-[100dvh] w-full items-center bg-nv-surface px-3 text-white" data-testid="pub-embed-page">
        {audio}
        {view.kind === 'ready' && data ? (
          <div className="flex w-full items-center gap-3">
            {data.cover_url ? <img src={data.cover_url} alt="" className="h-[112px] w-[112px] shrink-0 rounded-xl object-cover max-[420px]:hidden" onContextMenu={e => e.preventDefault()} draggable={false} />
              : <div className="grid h-[112px] w-[112px] shrink-0 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-[36px] max-[420px]:hidden" aria-hidden>♪</div>}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-[15px] font-black leading-tight" data-testid="pub-title-view">{data.title}</p>
              <p className="truncate text-[12px] text-slate-400">{data.artist || 'NOVA Studio'}{data.kind === 'extrait' ? ' · extrait' : ''}</p>
              {player}
              <a href={data.booking_url} target="_blank" rel="noopener" data-testid="pub-booking" className="inline-block text-[11px] font-black text-cyan-300 underline">Réserver au studio Make Music ↗</a>
            </div>
          </div>
        ) : view.kind === 'error' ? (
          <p className="w-full text-center text-[13px] text-slate-300" data-testid="pub-error-page" data-code={view.code}>{publicErrorView(view.code).title}</p>
        ) : <p className="w-full text-center text-[13px] text-slate-400">Chargement…</p>}
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-nv-bg text-white" data-testid="pub-page">
      {audio}
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="flex items-center gap-2 pt-1">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-[15px] font-black text-black" aria-hidden>N</span>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">NOVA Studio · morceau</p>
        </header>

        {view.kind === 'loading' && (
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center text-[14px] text-slate-300" role="status">
            <span className="mx-auto mb-3 block h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-cyan-300" aria-hidden />
            Ouverture du morceau…
          </div>
        )}

        {view.kind === 'error' && (() => {
          const ev = publicErrorView(view.code);
          return (
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5" data-testid="pub-error-page" data-code={view.code} role="alert">
              <p className="text-[34px] leading-none" aria-hidden>{view.code === 'network' ? '📶' : '🎵'}</p>
              <h1 className="mt-3 text-[20px] font-black">{ev.title}</h1>
              <p className="mt-1 text-[14px] leading-snug text-slate-300">{ev.text}</p>
              {ev.retry && <button type="button" onClick={() => { setView({ kind: 'loading' }); void load(); }} className={`${btn} mt-4 h-12 w-full bg-white text-black`}>Réessayer</button>}
              <a href="https://www.studiomakemusic.com/reservation?utm_source=nova&utm_medium=page_publique" target="_blank" rel="noopener" className={`${btn} mt-3 min-h-12 w-full px-4 py-2 text-center bg-white/10 text-[14px] text-white`}>🎙️ Réserver au studio Make Music</a>
            </div>
          );
        })()}

        {data && (
          <>
            <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04]">
              {data.cover_url ? <img src={data.cover_url} alt={`Pochette de ${data.title}`} className="aspect-square w-full object-cover" onContextMenu={e => e.preventDefault()} draggable={false} />
                : <div className="grid aspect-[2/1] w-full place-items-center bg-gradient-to-br from-cyan-500/40 to-violet-600/40 text-[56px]" aria-hidden>♪</div>}
              <div className="space-y-3 p-4">
                <div>
                  <h1 className="text-[24px] font-black leading-tight" data-testid="pub-title-view">{data.title}</h1>
                  {data.artist && <p className="text-[15px] font-bold text-slate-300">{data.artist}</p>}
                  <p className="mt-1 text-[12px] text-slate-400">{data.kind === 'extrait' ? 'Extrait' : 'Morceau entier'} · {fmtDuration(duration)} · {playsText(data.plays)}</p>
                </div>
                {player}
                {audioErr && <p role="alert" className="text-[12px] text-red-300">{audioErr}</p>}
              </div>
            </section>

            <a href={data.booking_url} target="_blank" rel="noopener" data-testid="pub-booking"
              className={`${btn} min-h-14 w-full px-4 py-3 text-center text-[16px] leading-tight bg-white text-black`}>🎙️ Réserver une session au studio Make Music</a>

            {data.credits && (
              <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4" data-testid="pub-credits-view">
                <h2 className="text-[13px] font-black uppercase tracking-wider text-slate-300">Crédits</h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-[14px] text-slate-200">{data.credits}</p>
              </section>
            )}
            {data.lyrics && (
              <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4" data-testid="pub-lyrics-view">
                <h2 className="text-[13px] font-black uppercase tracking-wider text-slate-300">Paroles</h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-slate-100">{data.lyrics}</p>
              </section>
            )}
            <footer className="space-y-1 pt-2 text-center text-[11px] text-slate-500">
              <p>Fait avec NOVA Studio · écoute seulement, pas de téléchargement.</p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

export default PublicTrackPage;
