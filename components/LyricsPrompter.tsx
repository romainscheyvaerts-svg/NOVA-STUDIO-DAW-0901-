import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

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
}

const LINE_H = 1.45; // interligne (em)

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

  // Défilement synchronisé sur la position du projet
  useEffect(() => {
    if (!p.open || editing) return;
    let raf = 0;
    const tick = () => {
      const el = scrollRef.current;
      if (el) {
        const t = p.isPlaying ? audioEngine.getCurrentTime() : p.currentTime;
        const linesElapsed = Math.max(0, (t - p.start) * (p.speed / 60));
        const lineH = fontSize * LINE_H;
        el.scrollTop = linesElapsed * lineH;
        setActiveLine(Math.floor(linesElapsed));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.open, editing, p.isPlaying, p.currentTime, p.start, p.speed, fontSize]);

  if (!p.open) return null;

  const saveDraft = () => {
    p.onLyricsChange(draft);
    setEditing(false);
  };

  const btn = 'h-9 min-w-9 px-2.5 rounded-lg bg-white/10 text-white text-[12px] font-bold hover:bg-white/20 active:scale-95 transition-all';

  return (
    <div
      className="fixed z-[420] left-1/2 -translate-x-1/2 w-[min(94vw,560px)] top-[150px] md:top-[170px] rounded-2xl border border-white/15 bg-black/85 backdrop-blur-md shadow-2xl flex flex-col"
      style={{ height: editing ? 'min(60vh, 460px)' : 'min(40vh, 340px)' }}
      role="region"
      aria-label="Prompteur de paroles"
    >
      {/* Barre d'outils */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/10">
        <span className="text-[12px] font-black text-white mr-auto">📝 Mes paroles</span>
        {editing ? (
          <button type="button" onClick={saveDraft} className="h-9 px-3 rounded-lg bg-cyan-500 text-black text-[12px] font-black">
            ✓ Prêt
          </button>
        ) : (
          <>
            <button type="button" className={btn} title="Plus lent" aria-label="Plus lent"
              onClick={() => p.onSpeedChange(Math.max(4, p.speed - 2))}>🐢</button>
            <span className="text-[11px] text-slate-300 tabular-nums w-14 text-center" title="Lignes par minute">{p.speed} l/min</span>
            <button type="button" className={btn} title="Plus rapide" aria-label="Plus rapide"
              onClick={() => p.onSpeedChange(Math.min(60, p.speed + 2))}>🐇</button>
            <button type="button" className={btn} aria-label="Texte plus petit" onClick={() => setFontSize(f => Math.max(16, f - 2))}>A−</button>
            <button type="button" className={btn} aria-label="Texte plus grand" onClick={() => setFontSize(f => Math.min(44, f + 2))}>A+</button>
            <button type="button" className={btn} title="La première ligne démarre à la position actuelle du beat"
              onClick={() => p.onStartChange(p.isPlaying ? audioEngine.getCurrentTime() : p.currentTime)}>⏱ Commencer ici</button>
            <button type="button" className={btn} aria-label="Modifier les paroles" onClick={() => { setDraft(p.lyrics); setEditing(true); }}>✏️</button>
          </>
        )}
        <button type="button" className={btn} aria-label="Fermer le prompteur" onClick={() => { if (editing) saveDraft(); p.onClose(); }}>✕</button>
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
            Elles défilent pendant que tu enregistres. Règle la vitesse avec 🐢 / 🐇 et utilise « Commencer ici » pour caler la première ligne sur ton entrée.
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
                  {l || ' '}
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
