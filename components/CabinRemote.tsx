import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Marker } from '../types';
import { lyricBlocks, prompterLine, regionAnchors } from '../utils/lyricsTiming';
import { cabinButtons, cabinLink, cabinPosition, type CabinCmd, type CabinState } from '../utils/cabinRemote';
import type { CabinResult } from '../hooks/useCabinRemote';

/**
 * Mode « cabine » du téléphone de l'artiste (chantier 17 · B6).
 *
 * L'artiste est en cabine, casque sur la tête, le micro du studio est sur le PC
 * de l'ingé. Son téléphone devient une télécommande pensée pour ce moment :
 *  - trois commandes énormes (REC/STOP, Lecture, Début), utilisables sans
 *    viser, avec un retour immédiat (« C'est parti chez Max ») ;
 *  - un voyant REC impossible à rater (écran bordé de rouge qui pulse) ;
 *  - le décompte de l'ingé en très grand ;
 *  - ses paroles au rythme de la lecture de l'ingé (même calage que le
 *    prompteur du studio : utils/lyricsTiming, rien n'est recalculé à part) ;
 *  - l'écran reste allumé (Wake Lock) ; rien ne part sans liaison sûre.
 * Les droits restent ceux décidés par l'ingé (utils/guestRights.remote).
 */

export interface CabinRemoteProps {
  engineerName: string;
  /** L'ingé est dans la séance (présence). */
  engineerHere: boolean;
  /** L'ingé a permis la télécommande (droit « remote »). */
  allowed: boolean;
  state: CabinState | null;
  receivedAt: number | null;
  pending: CabinCmd | null;
  last: CabinResult | null;
  onCommand: (cmd: CabinCmd, tapAt: number) => void;
  onRetry: () => void;
  lyrics: string;
  lyricsStart: number;
  lyricsSpeed: number;
  regions: Marker[];
  regionMap: Record<string, string>;
  talkOn: boolean;
  onTalk: (on: boolean) => void;
  talking: string[];
  onClose: () => void;
}

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

const CabinRemote: React.FC<CabinRemoteProps> = (p) => {
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [font, setFont] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('nova_cabin_font') || '', 10) || 30; } catch { return 30; }
  });
  const [awake, setAwake] = useState<'oui' | 'non' | null>(null);
  const [lastShown, setLastShown] = useState<CabinResult | null>(null);

  useEffect(() => { try { localStorage.setItem('nova_cabin_font', String(font)); } catch { /* */ } }, [font]);
  // Horloge de l'affichage : prompteur et voyant de liaison.
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 200); return () => window.clearInterval(id); }, []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  // L'écran reste allumé en cabine (repris à chaque retour sur la page).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let gone = false;
    const take = async () => {
      try {
        const wl = (navigator as any).wakeLock;
        if (!wl || document.visibilityState !== 'visible') { if (!wl) setAwake('non'); return; }
        lock = await wl.request('screen');
        if (gone) { void lock?.release(); return; }
        setAwake('oui');
      } catch { setAwake('non'); }
    };
    void take();
    const vis = () => { if (document.visibilityState === 'visible') void take(); };
    document.addEventListener('visibilitychange', vis);
    return () => { gone = true; document.removeEventListener('visibilitychange', vis); try { void lock?.release(); } catch { /* */ } };
  }, []);
  // Le dernier retour reste 6 s à l'écran (un échec reste tant qu'il n'est pas remplacé).
  useEffect(() => {
    if (!p.last) return;
    setLastShown(p.last);
    if (!p.last.ok) return;
    const id = window.setTimeout(() => setLastShown(l => (l === p.last ? null : l)), 6000);
    return () => window.clearTimeout(id);
  }, [p.last]);

  const eng = p.engineerName || "l'ingé";
  const link = cabinLink(p.receivedAt, now);
  const st = p.state ? { ...p.state, allowed: p.allowed && p.state.allowed } : null;
  const b = cabinButtons({ state: st ?? (p.allowed ? null : { rec: false, play: false, ci: null, allowed: false, eng }), link: p.allowed ? link : 'ok', online, engineerHere: p.engineerHere, pending: p.pending, eng });
  const recording = !!st && st.rec && st.ci === null;
  const counting = !!st && st.ci !== null;
  const pos = st && p.receivedAt !== null ? cabinPosition(st, p.receivedAt, now) : 0;

  // Paroles : même calage que le prompteur du studio (régions ou vitesse fixe).
  const lines = useMemo(() => p.lyrics.split('\n'), [p.lyrics]);
  const anchors = useMemo(() => regionAnchors(lyricBlocks(lines), p.regionMap, p.regions), [lines, p.regionMap, p.regions]);
  const moving = !!st && (st.play || st.rec);
  const lineF = st ? prompterLine(pos, { anchors, start: p.lyricsStart, speed: p.lyricsSpeed }) : 0;
  const idx = Math.max(0, Math.min(lines.length - 1, Math.floor(lineF)));
  const nonBlank = (from: number, dir: 1 | -1) => { for (let i = from; i >= 0 && i < lines.length; i += dir) if (lines[i].trim()) return i; return -1; };
  const cur = nonBlank(idx, 1);
  const prev = cur > 0 ? nonBlank(cur - 1, -1) : -1;
  const next1 = cur >= 0 ? nonBlank(cur + 1, 1) : -1;
  const next2 = next1 >= 0 ? nonBlank(next1 + 1, 1) : -1;
  const hasLyrics = lines.some(l => l.trim());

  const press = (cmd: CabinCmd) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const tapAt = Number((e.currentTarget as HTMLElement).dataset.down || 0) || Date.now();
    p.onCommand(cmd, tapAt);
  };
  // Instant du doigt posé (mesure honnête du délai jusqu'à la console de l'ingé).
  const down = (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.dataset.down = String(Date.now()); };

  const linkDot = !online || !p.engineerHere ? 'bg-red-500' : link === 'ok' ? 'bg-emerald-400' : link === 'lent' ? 'bg-amber-400' : 'bg-red-500';
  const linkLabel = !online ? 'Hors ligne' : !p.engineerHere ? `${eng} n'est pas là` : link === 'ok' ? `Relié à ${eng}` : link === 'lent' ? 'Liaison lente…' : link === 'attente' ? 'Connexion…' : 'Liaison perdue';
  const big = 'flex items-center justify-center rounded-3xl font-black transition-transform active:scale-95 disabled:opacity-35 select-none touch-manipulation';

  return (
    <div data-testid="cabin" data-rec={recording ? '1' : '0'} data-count={counting ? String(st!.ci) : ''} data-link={link}
      className="fixed inset-0 z-[580] flex flex-col bg-black text-white" role="main" aria-label={`Mode cabine : télécommande de la séance de ${eng}`}>
      {/* Voyant REC : tout l'écran bordé de rouge, qui pulse */}
      {recording && <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] animate-pulse border-[10px] border-red-600" />}

      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold text-slate-400">🎛️ Mode cabine</p>
          <p data-testid="cabin-link" className="flex items-center gap-2 text-[15px] font-black">
            <span className={`h-3 w-3 shrink-0 rounded-full ${linkDot}`} aria-hidden />
            <span className="truncate">{linkLabel}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Taille des paroles">
          <button type="button" data-testid="cabin-font-down" aria-label="Paroles plus petites" onClick={() => setFont(f => Math.max(20, f - 4))} className="h-12 w-12 rounded-2xl bg-white/10 text-[15px] font-black">A−</button>
          <button type="button" data-testid="cabin-font-up" aria-label="Paroles plus grandes" onClick={() => setFont(f => Math.min(56, f + 4))} className="h-12 w-12 rounded-2xl bg-white/10 text-[19px] font-black">A+</button>
        </div>
        <button type="button" data-testid="cabin-close" onClick={p.onClose} aria-label="Quitter le mode cabine" className="h-12 shrink-0 rounded-2xl bg-white/10 px-3 text-[14px] font-black">✕ Quitter</button>
      </header>

      {/* Ce qui se passe : REC, décompte, lecture, prêt */}
      <div className="shrink-0 px-4 pt-3" aria-live="assertive">
        <div data-testid="cabin-status" data-state={recording ? 'rec' : counting ? 'decompte' : st?.play ? 'lecture' : b.blocked ? 'attente' : 'pret'}
          className={`flex items-center justify-between gap-3 rounded-3xl px-5 py-4 ${recording ? 'bg-red-600 text-white' : counting ? 'bg-amber-400 text-black' : st?.play ? 'bg-sky-500/30 text-sky-50' : 'bg-white/[0.06] text-slate-100'}`}>
          <p className="text-[24px] font-black leading-none tracking-wide">
            {recording ? '● ENREGISTREMENT' : counting ? 'Prépare-toi…' : st?.play ? '▶ Lecture' : b.blocked ? 'En attente' : 'Prêt'}
          </p>
          <p className="text-[20px] font-black tabular-nums">{fmt(pos)}</p>
        </div>
        {st?.track && !recording && !counting && <p className="mt-1 px-2 text-[13px] text-slate-400">Ta voix part sur « {st.track} » chez {eng}.</p>}
      </div>

      {/* Bandeaux : l'ingé parle, liaison coupée, retour de la dernière commande */}
      <div className="shrink-0 space-y-2 px-4 pt-2">
        {p.talking.length > 0 && <p role="status" className="rounded-2xl bg-sky-400 px-4 py-3 text-[17px] font-black text-black">🔊 {p.talking.join(', ')} te parle…</p>}
        {b.blocked && (
          <div role="alert" data-testid="cabin-blocked" className="flex items-center gap-3 rounded-2xl bg-amber-500/20 px-4 py-3 text-[15px] font-bold text-amber-50">
            <span className="min-w-0 flex-1">{b.blocked}</span>
            {online && p.allowed && <button type="button" data-testid="cabin-retry" onClick={p.onRetry} className="h-12 shrink-0 rounded-xl bg-white px-4 text-[14px] font-black text-black">Réessayer</button>}
          </div>
        )}
        {!b.blocked && lastShown && (
          <p role="status" data-testid="cabin-last" data-ok={lastShown.ok ? '1' : '0'}
            className={`rounded-2xl px-4 py-3 text-[16px] font-black ${lastShown.ok ? 'bg-emerald-500/20 text-emerald-50' : 'bg-red-500/25 text-red-50'}`}>{lastShown.text}</p>
        )}
      </div>

      {/* Paroles */}
      <section data-testid="cabin-prompter" aria-label="Tes paroles" className="relative min-h-0 flex-1 overflow-hidden px-5 py-4">
        {hasLyrics ? (
          <div className="flex h-full flex-col justify-center gap-3 text-center">
            {prev >= 0 && <p className="leading-tight text-slate-500" style={{ fontSize: Math.round(font * 0.6) }}>{lines[prev]}</p>}
            {cur >= 0 && <p data-testid="cabin-line" className={`font-black leading-tight ${moving ? 'text-white' : 'text-slate-200'}`} style={{ fontSize: font }}>{lines[cur]}</p>}
            {next1 >= 0 && <p className="leading-tight text-slate-400" style={{ fontSize: Math.round(font * 0.7) }}>{lines[next1]}</p>}
            {next2 >= 0 && <p className="leading-tight text-slate-600" style={{ fontSize: Math.round(font * 0.6) }}>{lines[next2]}</p>}
          </div>
        ) : (
          <p className="flex h-full items-center justify-center text-center text-[17px] text-slate-400">Pas encore de paroles. Écris-les dans l'écran normal (« Tes paroles ») : elles défileront ici pendant la prise.</p>
        )}
        {/* Décompte en très grand, par-dessus les paroles */}
        {counting && (
          <div data-testid="cabin-countdown" className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
            <p className="text-[150px] font-black leading-none text-amber-300 tabular-nums">{st!.ci}</p>
            <p className="mt-2 text-[18px] font-black text-amber-100">Prépare-toi, ça part…</p>
          </div>
        )}
      </section>

      {/* Commandes : énormes, au pouce */}
      <footer className="shrink-0 space-y-3 border-t border-white/10 bg-white/[0.03] px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <button type="button" data-testid="cabin-home" disabled={!b.home.enabled} onPointerDown={down} onClick={press('home')}
            aria-label="Revenir au début" className={`${big} h-20 bg-white/10 text-[18px]`}>⏮ Début</button>
          <button type="button" data-testid="cabin-rec" data-cmd={b.rec.cmd} disabled={!b.rec.enabled} onPointerDown={down} onClick={press(b.rec.cmd)}
            aria-label={b.rec.cmd === 'stop' ? 'Arrêter la prise' : 'Lancer la prise (REC)'}
            className={`${big} h-32 w-32 rounded-full border-[6px] text-[24px] ${b.rec.cmd === 'stop' ? 'border-white bg-red-600 text-white' : 'border-red-300/70 bg-red-500 text-white'}`}>
            {p.pending === 'rec' || p.pending === 'stop' ? '…' : b.rec.label}
          </button>
          <button type="button" data-testid="cabin-play" data-cmd={b.play.cmd} disabled={!b.play.enabled} onPointerDown={down} onClick={press(b.play.cmd)}
            aria-label={b.play.cmd === 'stop' ? 'Arrêter la lecture' : 'Lancer la lecture'} className={`${big} h-20 bg-white/10 text-[18px]`}>{b.play.label}</button>
        </div>
        <div className="flex gap-3">
        <button type="button" data-testid="cabin-talk" aria-pressed={p.talkOn}
          onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } p.onTalk(true); }}
          onPointerUp={() => p.onTalk(false)} onPointerCancel={() => p.onTalk(false)}
          onLostPointerCapture={() => { if (p.talkOn) p.onTalk(false); }}
          className={`${big} h-14 min-w-0 flex-1 text-[16px] ${p.talkOn ? 'animate-pulse bg-red-500' : 'bg-white/10'}`}>
          {p.talkOn ? `${eng} t'entend… (relâche pour couper)` : `🎙️ Parler à ${eng} (maintenir)`}
        </button>
        {/* 📌 La prise te plaît : elle va dans les prises gardées de l'ingé (pour choisir à la fin). */}
        <button type="button" data-testid="cabin-keep" disabled={!b.keep.enabled} onPointerDown={down} onClick={press('keep')}
          aria-label="Garder la dernière prise de côté" className={`${big} h-14 shrink-0 px-4 bg-amber-400 text-[16px] text-black`}>
          {p.pending === 'keep' ? '…' : '📌 Garder'}
        </button>
        </div>
        {awake === 'non' && <p className="text-center text-[12px] text-slate-500">Ton téléphone peut se mettre en veille : touche l'écran de temps en temps, ou règle la mise en veille sur « jamais ».</p>}
      </footer>
    </div>
  );
};

export default CabinRemote;
