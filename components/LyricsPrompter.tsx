import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import type { Marker } from '../types';
import { autoRegionMap, lyricBlocks, prompterLine, regionAnchors } from '../utils/lyricsTiming';
import { lineWordTimes, normWord, TimedWord, timedAnchors, wordIndexAt } from '../utils/voiceLyrics';
import { hitWhere, type TakeWordHit } from '../utils/voiceSearch';

interface LyricsPrompterProps {
  open: boolean;
  onClose: () => void;
  lyrics: string;
  onLyricsChange: (text: string) => void;
  /** Position (s) du projet où la première ligne passe sur la ligne de lecture. */
  start: number;
  onStartChange: (t: number) => void;
  /** Vitesse de défilement, en lignes par minute. */
  speed: number;
  onSpeedChange: (v: number) => void;
  isPlaying: boolean;
  isRecording: boolean;
  /** Position courante quand le projet est à l'arrêt (ou si le moteur ne répond pas). */
  currentTime: number;
  /** Régions de la fenêtre d'édition (marqueurs avec début et fin). */
  regions?: Marker[];
  /** Bloc de paroles (n°) → id de région. */
  regionMap?: Record<string, string>;
  onRegionMapChange?: (map: Record<string, string>) => void;
  /** Crée une région (boucle active, sinon 8 mesures à la tête de lecture) et renvoie son id. */
  onCreateRegion?: (name: string) => string;
  bpm?: number;
  /** R24 : mots transcrits des clips voix (temps du morceau) : le texte défile quand il est chanté. */
  timedWords?: TimedWord[];
  /** B7 : chercher un mot chanté dans les prises transcrites (toutes, même mises de côté). */
  searchWords?: (query: string) => TakeWordHit[];
  /** B7 : la tête de lecture va sur le mot choisi. */
  onJumpToWord?: (hit: TakeWordHit) => void;
  /** Au moins une prise transcrite dans le projet. */
  hasTranscripts?: boolean;
}

/**
 * B7 · « Trouver un mot chanté » : champ toujours visible en haut du prompteur. Les résultats
 * (toutes les prises transcrites, même mutées) s'affichent par-dessus le texte ; un clic, ou
 * Entrée pour le premier, place la tête de lecture sur le mot.
 */
const WordSearch: React.FC<{ search: (q: string) => TakeWordHit[]; onJump: (h: TakeWordHit) => void; ready: boolean }> = ({ search, onJump, ready }) => {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => (q.trim().length >= 2 ? search(q).slice(0, 8) : []), [q, search]);
  const pick = (h: TakeWordHit | undefined) => { if (!h) return; onJump(h); setOpen(false); };
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 rounded-lg bg-black/40 border border-white/15 focus-within:border-cyan-400/70 px-2">
        <i className="fas fa-search text-[11px] text-slate-400" aria-hidden="true" />
        <input type="search" value={q} data-testid="prompter-word-search"
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); pick(hits[0]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (q) { setQ(''); } else (e.target as HTMLInputElement).blur(); setOpen(false); }
            e.stopPropagation(); // les raccourcis du studio ne partent pas pendant la saisie
          }}
          placeholder="Trouver un mot chanté dans les prises (ex. j’arrive)"
          aria-label="Trouver un mot chanté dans les prises"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400" />
      </div>
      {open && q.trim().length >= 2 && (
        <div role="listbox" aria-label="Endroits où le mot est chanté" data-testid="prompter-word-results"
          className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[min(40vh,260px)] overflow-y-auto rounded-xl border border-white/15 bg-nv-surface shadow-2xl p-1">
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-slate-300" role="status">
              {ready
                ? <>Aucun endroit chanté « {q.trim()} » dans les prises transcrites. Vérifie l’orthographe, ou transcris les autres prises.</>
                : <>Aucune prise transcrite pour l’instant. Clic droit sur le clip voix → Voix → « Transcrire les paroles… » (appli Windows), puis cherche ici.</>}
            </p>
          ) : hits.map((h, i) => (
            <button key={h.key} type="button" role="option" aria-selected={i === 0} data-testid="prompter-word-hit"
              onClick={() => pick(h)}
              className="w-full text-left rounded-lg px-2.5 py-1.5 min-h-[44px] hover:bg-cyan-500/15 focus:bg-cyan-500/15 outline-none">
              <span className="block truncate text-[13px] text-white">
                {h.before && <span className="text-slate-400">… {h.before} </span>}
                <mark className="bg-cyan-500/30 text-cyan-100 rounded px-0.5">{h.text}</mark>
                {h.after && <span className="text-slate-400"> {h.after} …</span>}
              </span>
              <span className={`block truncate text-[11px] ${h.audible ? 'text-slate-400' : 'text-amber-300/90'}`}>
                {hitWhere(h)}{h.playlist ? ' · autre playlist' : !h.audible ? ' · prise mise de côté' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const LINE_H = 1.45; // interligne (em)

/** Ligne en cours, mot par mot : les mots déjà chantés s'allument (R24, calage sur la voix). */
const KaraokeLine: React.FC<{ text: string; sung: number }> = ({ text, sung }) => {
  let k = -1;
  return (
    <>
      {text.split(/(\s+)/).map((part, j) => {
        if (!part.trim() || !normWord(part)) return <React.Fragment key={j}>{part}</React.Fragment>;
        k++;
        return <span key={j} className={k <= sung ? 'text-cyan-300' : undefined}>{part}</span>;
      })}
    </>
  );
};

/**
 * Prompteur de paroles : le texte défile au rythme du projet, pas d'une
 * horloge à part. Revenir en arrière dans le beat fait remonter le texte,
 * Stop l'arrête : l'artiste retrouve toujours sa ligne en refaisant une prise.
 */
const LyricsPrompter: React.FC<LyricsPrompterProps> = (p) => {
  const [editing, setEditing] = useState(!p.lyrics.trim());
  const [fontSize, setFontSize] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('nova_prompter_font') || '', 10) || 26; } catch { return 26; }
  });
  const [draft, setDraft] = useState(p.lyrics);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [activeLine, setActiveLine] = useState(0);
  const [showRegions, setShowRegions] = useState(false);
  const [activeWord, setActiveWord] = useState(-1);
  // R24 : calage sur la voix transcrite (allumé par défaut quand il y a une transcription).
  const [voiceSync, setVoiceSync] = useState<boolean>(() => {
    try { return localStorage.getItem('nova_prompter_voice') !== '0'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('nova_prompter_voice', voiceSync ? '1' : '0'); } catch { /* */ } }, [voiceSync]);

  useEffect(() => { if (!editing) setDraft(p.lyrics); }, [p.lyrics, editing]);
  // À chaque ouverture : on repart des paroles du projet (session reprise, projet chargé).
  useEffect(() => {
    if (!p.open) return;
    setDraft(p.lyrics);
    setEditing(!p.lyrics.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open]);
  useEffect(() => { try { localStorage.setItem('nova_prompter_font', String(fontSize)); } catch { /* */ } }, [fontSize]);

  const lines = useMemo(() => p.lyrics.split('\n'), [p.lyrics]);
  const blocks = useMemo(() => lyricBlocks(lines), [lines]);
  const regions = useMemo(() => p.regions || [], [p.regions]);
  const regionMap = useMemo(() => p.regionMap || {}, [p.regionMap]);
  // Points de calage : chaque bloc associé défile sur la durée de sa région.
  const regionAnchorList = useMemo(() => regionAnchors(blocks, regionMap, regions), [blocks, regionMap, regions]);
  const timedWords = p.timedWords;
  const voiceAnchors = useMemo(() => (timedWords?.length ? timedAnchors(p.lyrics, timedWords) : []), [p.lyrics, timedWords]);
  const wordTimes = useMemo(() => (timedWords?.length ? lineWordTimes(p.lyrics, timedWords) : []), [p.lyrics, timedWords]);
  const hasVoice = voiceAnchors.length >= 2;
  const voiceMode = hasVoice && voiceSync;
  // Ordre de priorité : la voix transcrite, puis les régions, puis la vitesse fixe.
  const anchors = voiceMode ? voiceAnchors : regionAnchorList;
  const regionMode = !voiceMode && regionAnchorList.length > 0;
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const bars = (r: Marker) => Math.round(((r.endTime ?? r.time) - r.time) / ((60 / (p.bpm || 120)) * 4) * 10) / 10;
  const setBlockRegion = (i: number, id: string) => {
    const next = { ...regionMap };
    if (id) next[String(i)] = id; else delete next[String(i)];
    p.onRegionMapChange?.(next);
  };

  // Défilement synchronisé sur la position du projet
  useEffect(() => {
    if (!p.open || editing) return;
    let raf = 0;
    const tick = () => {
      const el = scrollRef.current;
      if (el) {
        const t = p.isPlaying ? audioEngine.getCurrentTime() : p.currentTime;
        const linesElapsed = prompterLine(t, { anchors, start: p.start, speed: p.speed });
        const lineH = fontSize * LINE_H;
        el.scrollTop = linesElapsed * lineH;
        const line = Math.floor(linesElapsed);
        setActiveLine(line);
        setActiveWord(voiceMode ? wordIndexAt(wordTimes[line], t) : -1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.open, editing, p.isPlaying, p.currentTime, p.start, p.speed, fontSize, anchors, voiceMode, wordTimes]);

  if (!p.open) return null;

  const saveDraft = () => {
    p.onLyricsChange(draft);
    setEditing(false);
  };

  const btn = 'h-9 min-w-9 px-2.5 rounded-lg bg-white/10 text-white text-[12px] font-bold hover:bg-white/20 active:scale-95 transition-all';

  return (
    <div
      className="fixed z-[420] left-1/2 -translate-x-1/2 w-[min(94vw,560px)] top-[150px] md:top-[170px] rounded-2xl border border-white/10 bg-nv-surface/[0.97] shadow-2xl flex flex-col"
      style={{ height: editing ? 'min(60vh, 460px)' : 'min(44vh, 380px)' }}
      role="region"
      aria-label="Prompteur de paroles"
      // Échap dans le prompteur : enregistre et ferme (avant, rien ne se passait).
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (editing) saveDraft(); p.onClose(); } }}
    >
      {/* Barre d'outils */}
      {/* Barre d'outils : deux rangées pour tenir sur un téléphone */}
      <div className="border-b border-white/10 px-3 py-2 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-black text-white mr-auto">📝 Mes paroles</span>
          {editing ? (
            <button type="button" onClick={saveDraft} className="h-9 px-3 rounded-lg bg-cyan-500 text-black text-[12px] font-black">
              ✓ Prêt
            </button>
          ) : (
            <button type="button" className={btn} aria-label="Modifier les paroles" onClick={() => { setDraft(p.lyrics); setEditing(true); }}>✏️ Modifier</button>
          )}
          <button type="button" className={btn} aria-label="Fermer le prompteur" onClick={() => { if (editing) saveDraft(); p.onClose(); }}>✕</button>
        </div>
        {!editing && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {hasVoice && (
              <button type="button" data-testid="prompter-voice-sync" aria-pressed={voiceSync}
                className={`${btn} ${voiceSync ? '!bg-cyan-500/25 ring-1 ring-cyan-400/60' : ''}`}
                title={voiceSync ? 'Calé sur la voix : chaque ligne passe quand elle est chantée (transcription du clip). Corrige le texte avec ✏️ : les temps suivent. Clic pour revenir à la vitesse fixe.' : 'Caler le défilement sur la voix transcrite'}
                onClick={() => setVoiceSync(v => !v)}>🎙️ Calé sur la voix</button>
            )}
            {!regionMode && !voiceMode && (<>
              <button type="button" className={btn} title="Plus lent" aria-label="Plus lent"
                onClick={() => p.onSpeedChange(Math.max(4, p.speed - 2))}>🐢</button>
              <span className="text-[11px] text-slate-300 tabular-nums w-14 text-center" title="Lignes par minute">{p.speed} l/min</span>
              <button type="button" className={btn} title="Plus rapide" aria-label="Plus rapide"
                onClick={() => p.onSpeedChange(Math.min(60, p.speed + 2))}>🐇</button>
            </>)}
            {p.onRegionMapChange && !voiceMode && (
              <button type="button" className={`${btn} ${showRegions || regionMode ? '!bg-cyan-500/25 ring-1 ring-cyan-400/60' : ''}`}
                aria-expanded={showRegions} title="Caler chaque partie des paroles sur une région de la fenêtre d'édition"
                onClick={() => setShowRegions(v => !v)}>🎯 Régions{regionMode ? ` (${blocks.filter((_, i) => regions.some(r => r.id === regionMap[String(i)])).length})` : ''}</button>
            )}
            <button type="button" className={btn} aria-label="Texte plus petit" onClick={() => setFontSize(f => Math.max(16, f - 2))}>A−</button>
            <button type="button" className={btn} aria-label="Texte plus grand" onClick={() => setFontSize(f => Math.min(44, f + 2))}>A+</button>
            {!regionMode && !voiceMode && (
              <button type="button" className={`${btn} ml-auto`} title="La première ligne démarre à la position actuelle du beat"
                onClick={() => p.onStartChange(p.isPlaying ? audioEngine.getCurrentTime() : p.currentTime)}>⏱ Commencer ici</button>
            )}
          </div>
        )}
        {!editing && p.searchWords && p.onJumpToWord && (
          <WordSearch search={p.searchWords} onJump={p.onJumpToWord} ready={!!p.hasTranscripts} />
        )}
        {!editing && showRegions && !voiceMode && (
          <div className="rounded-xl bg-white/5 border border-white/10 p-2 space-y-1.5 max-h-[38vh] overflow-y-auto">
            <p className="text-[11px] text-slate-300 leading-snug">
              Chaque partie de tes paroles défile pendant sa région. Pour aller plus vite ou plus lentement, tire les bords de la région dans la règle de la fenêtre d'édition (clic droit sur la règle pour en créer une).
            </p>
            {blocks.length === 0 && <p className="text-[11px] text-slate-400">Sépare tes parties par une ligne vide (Couplet, Refrain…).</p>}
            {blocks.map((b, i) => {
              const id = regionMap[String(i)] || '';
              const r = regions.find(x => x.id === id);
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="flex-1 min-w-0 truncate text-[12px] font-bold text-white" title={b.title}>{b.title}</span>
                  <select value={r ? id : ''} onChange={e => setBlockRegion(i, e.target.value)}
                    aria-label={`Région pour « ${b.title} »`}
                    className="h-8 max-w-[52%] rounded-lg bg-black/60 border border-white/15 text-[11px] text-white px-1.5">
                    <option value="">Vitesse fixe</option>
                    {regions.map(x => <option key={x.id} value={x.id}>{x.name} · {fmt(x.time)} ({bars(x)} mes.)</option>)}
                  </select>
                  {p.onCreateRegion && !r && (
                    <button type="button" className="h-8 px-2 rounded-lg bg-white/10 text-[11px] font-bold text-white" title="Crée une région (la boucle, ou 8 mesures à la tête de lecture)"
                      aria-label={`Créer une région pour « ${b.title} »`}
                      onClick={() => setBlockRegion(i, p.onCreateRegion!(b.title))}>＋</button>
                  )}
                </div>
              );
            })}
            {blocks.length > 0 && regions.length > 0 && (
              <div className="flex gap-1.5 pt-1">
                <button type="button" className={btn} onClick={() => p.onRegionMapChange?.(autoRegionMap(blocks, regions))}>Associer dans l'ordre</button>
                {regionMode && <button type="button" className={btn} onClick={() => p.onRegionMapChange?.({})}>Tout en vitesse fixe</button>}
              </div>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className="flex-1 flex flex-col p-3 gap-2 min-h-0">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={'Écris ou colle tes paroles ici, une ligne par phrase.\n\nCouplet 1\n…\n\nRefrain\n…'}
            className="flex-1 min-h-0 w-full resize-none rounded-xl bg-white/5 border border-white/10 p-3 text-[15px] leading-relaxed text-white placeholder:text-slate-500 outline-none focus:border-cyan-500/50"
            autoFocus
          />
          <p className="text-[11px] text-slate-400">
            {hasVoice
              ? 'Calé sur ta voix transcrite : corrige les mots ou ajoute des lignes, les temps suivent (les lignes [Refrain] sont des titres).'
              : "Elles défilent pendant que tu enregistres. Sépare tes parties (Couplet, Refrain…) par une ligne vide : avec 🎯 Régions, chacune défile pendant sa région de la fenêtre d'édition. Sinon règle la vitesse avec 🐢 / 🐇. Dans l'appli Windows, « Transcrire les paroles… » (clic droit sur le clip voix) les écrit et les cale tout seul."}
          </p>
        </div>
      ) : (
        <div className="relative flex-1 min-h-0">
          {/* Ligne de lecture (au tiers supérieur) */}
          <div className="pointer-events-none absolute left-0 right-0 z-10 border-t-2 border-cyan-400/70" style={{ top: '33%' }} />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-10 z-10 bg-gradient-to-b from-black/90 to-transparent rounded-t-2xl" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 z-10 bg-gradient-to-t from-black/90 to-transparent rounded-b-2xl" />
          <div ref={scrollRef} className="absolute inset-0 overflow-hidden px-5">
            {/* Marge haute : la 1re ligne commence sur la ligne de lecture */}
            <div style={{ height: '33%' }} />
            <div ref={textRef} style={{ fontSize, lineHeight: LINE_H }} className="font-bold text-center">
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={`transition-colors duration-150 ${i === activeLine ? 'text-white' : i < activeLine ? 'text-white/25' : 'text-white/55'}`}
                  style={{ minHeight: `${LINE_H}em` }}
                >
                  {i === activeLine && voiceMode && l ? <KaraokeLine text={l} sung={activeWord} /> : (l || ' ')}
                </div>
              ))}
            </div>
            <div style={{ height: '70%' }} />
          </div>
        </div>
      )}
    </div>
  );
};

export default LyricsPrompter;
