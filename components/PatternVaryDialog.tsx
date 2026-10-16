import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, MidiNote, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { extendNotes, varyVariants, VARY_RULES, type ExtendMode, type VaryContext, type VaryRule } from '../utils/patternVary';
import { renderNotes } from '../utils/soundPreview';

/**
 * Lot 10 · « Prolonger » et « Varier » un clip MIDI par des règles (inversion, déplacement,
 * variation rythmique, transposition dans la gamme). Aucune IA : 3 variantes au dé, notes
 * toujours dans la gamme du projet ou dans l'accord en cours. Une seule étape d'annulation.
 */

export interface PatternVaryDialogProps {
  mode: 'prolonger' | 'varier';
  track: Track | null;
  clip: Clip | null;
  ctx: VaryContext;
  beatsPerBar: number;
  /** Début du clip suivant sur la piste (s), pour ne pas le recouvrir. */
  nextClipStart: number | null;
  isMobile: boolean;
  ensureEngine?: () => Promise<unknown>;
  notify?: (msg: string) => void;
  onApply: (notes: MidiNote[], duration: number, label: string) => void;
  onClose: () => void;
}

const PatternVaryDialog: React.FC<PatternVaryDialogProps> = p => {
  const [mode, setMode] = useState(p.mode);
  const [bars, setBars] = useState(4);
  const [extMode, setExtMode] = useState<ExtendMode>('varier');
  const [rule, setRule] = useState<VaryRule>('rythme');
  const [seed, setSeed] = useState(1);
  const [pick, setPick] = useState(0);
  const [playing, setPlaying] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const h = p.isMobile ? 'h-11' : 'h-10';
  const notes = p.clip?.notes || [];
  const bar = (60 / (p.ctx.bpm || 120)) * p.beatsPerBar;
  const clipBars = p.clip ? Math.max(1, Math.round(p.clip.duration / bar)) : 0;
  const room = p.clip && p.nextClipStart !== null ? Math.floor((p.nextClipStart - (p.clip.start + clipBars * bar) + 1e-6) / bar) : Infinity;

  useEffect(() => () => { audioEngine.stopAudition(); if (timer.current) window.clearTimeout(timer.current); }, []);

  const variants = useMemo(() => (mode === 'varier' && notes.length ? varyVariants(notes, rule, p.ctx, p.clip?.duration || 0, seed) : []), [mode, notes, rule, p.ctx, p.clip, seed]);
  const extended = useMemo(() => (mode === 'prolonger' && p.clip && notes.length
    ? extendNotes(notes, { bars: Math.min(bars, room), clipLen: p.clip.duration, ctx: { ...p.ctx, seed }, beatsPerBar: p.beatsPerBar, mode: extMode, rule })
    : null), [mode, notes, bars, room, p.clip, p.ctx, p.beatsPerBar, extMode, rule, seed]);

  const is808 = !!p.track?.bass808;
  const instrument = p.track?.melodicSampler?.instrument || 'piano';
  const stop = () => { audioEngine.stopAudition(); setPlaying(null); if (timer.current) window.clearTimeout(timer.current); };
  const listen = async (i: number, ns: MidiNote[]) => {
    if (playing === i) { stop(); return; }
    try {
      await p.ensureEngine?.();
      const c = audioEngine.ctx;
      if (!c) throw new Error('audio');
      if (c.state !== 'running') await c.resume().catch(() => {});
      const buf = await renderNotes(ns, c.sampleRate, { instrument, is808 });
      audioEngine.auditionBuffers([{ buffer: buf, at: 0 }]);
      setPlaying(i);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPlaying(x => (x === i ? null : x)), buf.duration * 1000 + 100);
    } catch { p.notify?.('La pré-écoute ne démarre pas : réessaie, ou applique puis écoute dans le projet (Ctrl+Z pour revenir).'); }
  };

  const empty = !p.clip || !notes.length;
  const apply = () => {
    stop();
    if (mode === 'varier') { const v = variants[pick]; if (v) p.onApply(v, p.clip!.duration, `Variation « ${VARY_RULES.find(r => r.id === rule)?.label} »`); }
    else if (extended) p.onApply(extended.notes, extended.duration, `Clip prolongé de ${Math.min(bars, room)} mesure${Math.min(bars, room) > 1 ? 's' : ''}`);
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => { stop(); p.onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="vary-title" data-testid="pattern-vary" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[94vh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="vary-title" className="text-[15px] font-black">🔀 Prolonger ou varier</h2>
            <p className="text-[11px] text-nv-muted truncate">{p.clip ? `${p.track?.name || 'Piste'} · ${p.clip.name || 'clip'} · ${clipBars} mesure${clipBars > 1 ? 's' : ''}, ${notes.length} notes` : 'Aucun clip MIDI choisi'}</p>
          </div>
          <button type="button" onClick={() => { stop(); p.onClose(); }} aria-label="Fermer Prolonger ou varier" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" aria-hidden /></button>
        </div>

        {empty ? (
          <p className="text-[12.5px] text-nv-muted rounded-xl bg-nv-well px-3 py-3" data-testid="vary-empty">
            Sélectionne d’abord un clip MIDI qui a des notes (clic dessus dans la timeline) : une mélodie, des accords ou une 808. Pas de clip ? « 🎲 Démarrer un beat » en pose un.
          </p>
        ) : (
          <>
            <div className="flex gap-1.5" role="tablist" aria-label="Prolonger ou varier">
              {(['prolonger', 'varier'] as const).map(m => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { stop(); setMode(m); setPick(0); }} data-testid={`vary-mode-${m}`}
                  className={`flex-1 ${h} rounded-xl text-[13px] font-black ${mode === m ? 'bg-cyan-500/15 ring-1 ring-cyan-400/70' : 'bg-nv-well'}`}>{m === 'prolonger' ? '➕ Prolonger' : '🔀 Varier'}</button>
              ))}
            </div>

            <div className="space-y-1.5">
              <p className="text-[12px] font-black">{mode === 'prolonger' ? 'Règle des reprises' : 'Règle'}</p>
              <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Règle">
                {VARY_RULES.map(r => (
                  <button key={r.id} type="button" role="radio" aria-checked={rule === r.id} title={r.hint} onClick={() => { stop(); setRule(r.id); setPick(0); }} data-testid={`vary-rule-${r.id}`}
                    disabled={mode === 'prolonger' && extMode === 'repeter'}
                    className={`min-h-[2.75rem] rounded-xl px-2.5 py-1 text-left disabled:opacity-40 ${rule === r.id ? 'bg-cyan-500/15 ring-1 ring-cyan-400/70' : 'bg-nv-well'}`}>
                    <span className="block text-[12.5px] font-black">{r.label}</span>
                    <span className="block text-[10.5px] text-nv-muted leading-tight">{r.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {mode === 'prolonger' ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Mesures à ajouter">
                  <span className="text-[12px] text-nv-muted mr-1">Ajouter</span>
                  {[1, 2, 4, 8].map(n => (
                    <button key={n} type="button" role="radio" aria-checked={bars === n} disabled={n > room} onClick={() => setBars(n)} data-testid={`vary-bars-${n}`}
                      className={`${h} min-w-[3rem] px-3 rounded-xl font-bold disabled:opacity-40 ${bars === n ? 'bg-cyan-500/15 ring-1 ring-cyan-400/70' : 'bg-nv-well'}`}>{n}</button>
                  ))}
                  <span className="text-[12px] text-nv-muted">mesure{bars > 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Manière">
                  {([['varier', 'Reprendre en variant'], ['repeter', 'Répéter tel quel']] as [ExtendMode, string][]).map(([m, l]) => (
                    <button key={m} type="button" role="radio" aria-checked={extMode === m} onClick={() => setExtMode(m)} data-testid={`vary-ext-${m}`}
                      className={`flex-1 ${h} rounded-xl text-[12px] font-bold ${extMode === m ? 'bg-cyan-500/15 ring-1 ring-cyan-400/70' : 'bg-nv-well'}`}>{l}</button>
                  ))}
                </div>
                {room < 1 && <p className="text-[12px] text-amber-600" role="alert">Un autre clip suit juste après sur cette piste : déplace-le pour pouvoir prolonger.</p>}
                {room >= 1 && room < 8 && <p className="text-[11px] text-nv-muted">Un autre clip commence {room} mesure{room > 1 ? 's' : ''} plus loin : on ne va pas au-delà.</p>}
                {extended && (
                  <div className="flex items-center gap-2 rounded-xl bg-nv-well px-3 py-2">
                    <p className="flex-1 text-[12px]" data-testid="vary-extend-summary">{clipBars} → {Math.round(extended.duration / bar)} mesures · {extended.notes.length} notes</p>
                    <button type="button" onClick={() => void listen(9, extended.notes.filter(n => n.start >= (clipBars - 1) * bar))} data-testid="vary-listen-ext"
                      className={`${h} px-3 rounded-xl text-[12px] font-bold ${playing === 9 ? 'bg-cyan-500 text-black' : 'bg-nv-panel'}`}>
                      <i className={`fas ${playing === 9 ? 'fa-stop' : 'fa-play'} mr-1.5`} aria-hidden />{playing === 9 ? 'Stop' : 'Écouter la suite'}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-black">3 variantes</p>
                  <button type="button" onClick={() => { stop(); setSeed(s => s + 3); setPick(0); }} data-testid="vary-dice" className={`${h} px-3 rounded-xl bg-nv-well text-[12px] font-bold`}>🎲 Autres variantes</button>
                </div>
                {variants.length === 0 ? (
                  <p className="text-[12px] text-nv-muted" data-testid="vary-none">Cette règle ne change presque rien sur ce clip (trop peu de notes). Essaie une autre règle.</p>
                ) : (
                  <div className="grid gap-1.5" role="radiogroup" aria-label="Variante">
                    {variants.map((v, i) => (
                      <div key={i} className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 ${pick === i ? 'bg-cyan-500/10 ring-1 ring-cyan-400/60' : 'bg-nv-well'}`}>
                        <button type="button" role="radio" aria-checked={pick === i} onClick={() => setPick(i)} className="flex-1 text-left text-[12.5px] font-bold" data-testid={`vary-variant-${i}`}>
                          Variante {String.fromCharCode(65 + i)} <span className="text-nv-muted font-normal">· {v.length} notes</span>
                        </button>
                        <button type="button" onClick={() => void listen(i, v)} aria-label={`${playing === i ? 'Arrêter' : 'Écouter'} la variante ${String.fromCharCode(65 + i)}`}
                          className={`${h} w-11 rounded-xl ${playing === i ? 'bg-cyan-500 text-black' : 'bg-nv-panel'}`}><i className={`fas ${playing === i ? 'fa-stop' : 'fa-play'}`} aria-hidden /></button>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" onClick={() => void listen(8, notes)} className="text-[11px] font-bold text-cyan-600 hover:underline">{playing === 8 ? 'Arrêter l’original' : 'Écouter l’original'}</button>
              </div>
            )}
            <p className="text-[10.5px] text-nv-muted">Toutes les notes restent dans la gamme du projet ou dans l’accord joué à ce moment. Ctrl+Z annule en une fois.</p>
          </>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={() => { stop(); p.onClose(); }} className={`${h} px-4 rounded-xl bg-nv-well font-bold`}>Fermer</button>
          <button type="button" onClick={apply} disabled={empty || (mode === 'varier' ? !variants.length : !extended || room < 1)} data-testid="vary-apply"
            className={`flex-1 ${h} rounded-xl font-black bg-cyan-500 text-black hover:bg-cyan-400 disabled:opacity-40`}>{mode === 'prolonger' ? 'Prolonger le clip' : 'Remplacer par cette variante'}</button>
        </div>
      </div>
    </div>
  );
};

export default PatternVaryDialog;
