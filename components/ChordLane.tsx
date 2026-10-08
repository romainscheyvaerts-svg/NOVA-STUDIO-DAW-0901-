import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { produce } from 'immer';
import type { DAWState, Track } from '../types';
import { TrackType } from '../types';
import { CHORD_QUALITIES, chordAt, chordNameFr, chordSymbol, ChordEvent, ChordQuality, diatonicChords } from '../utils/chordDetect';
import { chordLaneStore, chordLaneVisible, detectChordsInClips, newChordId, placeChord, replaceRange, resizeChord, sanitizeChords, useChordLanePref } from '../utils/chordTrack';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { usePlayheadTime } from '../utils/playheadStore';
import { useSimpleMode } from '../utils/simpleMode';
import { keyLabelFr } from '../utils/scales';

/**
 * Piste d'accords (V20) : un couloir collé à la règle de l'arrangement qui
 * montre les accords (Am, F, C, G…), comme la Chord Track de Logic.
 *  - clic dans le vide : poser un accord (ceux de la gamme proposés d'abord) ;
 *  - clic sur un accord : le changer, l'allonger, le raccourcir, le retirer ;
 *  - bord droit : glisser pour changer sa durée (calée sur les temps) ;
 *  - « Détecter » : lit les accords du beat (Chord ID de Logic, « Convert
 *    Harmony to MIDI » d'Ableton Live).
 * Les accords sont dans le projet (DAWState.chords) : sauvegardés, annulables
 * (Ctrl+Z) et partagés en collaboration.
 */

export const CHORD_LANE_H = 30;
const LANE_TIP = 'Piste d’accords (comme la Chord Track de Logic) : clique dans le couloir pour poser un accord, ou « Détecter » pour lire les accords du beat (Chord ID de Logic, Convert Harmony d’Ableton Live). Le piano roll surligne les notes de l’accord en cours.';
const notify = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const NOTE_BUTTONS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUALITY_LABEL: Record<ChordQuality, string> = { maj: 'Majeur', min: 'Mineur', '7': '7', maj7: 'Maj7', min7: 'm7', sus2: 'sus2', sus4: 'sus4', dim: 'dim' };

/** Couleur d'un accord : une teinte par fondamentale (même accord = même couleur). */
export const chordColor = (root: number) => `hsl(${(root * 30 + 190) % 360} 70% 60%)`;

// ---------------------------------------------------------------------------
// Choix d'un accord
// ---------------------------------------------------------------------------

interface PickerProps {
  x: number; y: number;
  title: string;
  current?: { root: number; quality: ChordQuality };
  projectKey?: number; projectScale?: string;
  onPick: (root: number, quality: ChordQuality) => void;
  onClose: () => void;
  extra?: React.ReactNode;
}

const ChordPicker: React.FC<PickerProps> = ({ x, y, title, current, projectKey, projectScale, onPick, onClose, extra }) => {
  const [root, setRoot] = useState<number>(current?.root ?? (typeof projectKey === 'number' ? projectKey : 0));
  const ref = useRef<HTMLDivElement>(null);
  const hasKey = typeof projectKey === 'number' && !!projectScale && !/CHROMATIC/i.test(projectScale);
  const inKey = useMemo(() => (hasKey ? diatonicChords(projectKey!, projectScale) : []), [hasKey, projectKey, projectScale]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    const t = window.setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); window.clearTimeout(t); };
  }, [onClose]);
  const W = 300;
  const left = Math.max(8, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8));
  const top = Math.max(8, Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 360));
  const isCur = (r: number, q: ChordQuality) => current && current.root === r && current.quality === q;
  return createPortal(
    <div ref={ref} role="dialog" aria-label={title} data-testid="chord-picker"
      className="fixed z-[700] rounded-xl border border-white/10 shadow-2xl p-3 text-white"
      style={{ left, top, width: W, backgroundColor: 'var(--bg-surface, #12141a)' }}>
      <div className="text-[12px] font-black mb-2 flex items-center justify-between">
        <span>{title}</span>
        <button type="button" onClick={onClose} aria-label="Fermer" className="w-7 h-7 rounded-lg hover:bg-white/10 text-slate-400"><i className="fas fa-times" /></button>
      </div>
      {hasKey ? (
        <>
          <div className="text-[10px] font-semibold text-slate-400 mb-1" title="Les 7 accords construits sur la gamme du morceau : ils sonnent toujours juste ensemble.">
            Dans la gamme ({keyLabelFr(projectKey, projectScale)})
          </div>
          <div className="grid grid-cols-4 gap-1 mb-3">
            {inKey.map(c => (
              <button key={`${c.root}-${c.quality}`} type="button" data-chord={chordSymbol(c.root, c.quality)}
                onClick={() => onPick(c.root, c.quality)} title={`${chordNameFr(c.root, c.quality)} (degré ${ROMAN[c.degree - 1]})`}
                className={`h-11 rounded-lg border text-[13px] font-black leading-tight ${isCur(c.root, c.quality) ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                {chordSymbol(c.root, c.quality)}
                <span className="block text-[9px] font-semibold opacity-60">{c.quality === 'maj' ? ROMAN[c.degree - 1] : c.quality === 'dim' ? `${ROMAN[c.degree - 1].toLowerCase()}°` : ROMAN[c.degree - 1].toLowerCase()}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-[10px] text-amber-300 mb-2">Pas de tonalité dans le projet : choisis la fondamentale et le type d’accord. (Détecte la tonalité du beat pour avoir les accords de la gamme en premier.)</p>
      )}
      <div className="text-[10px] font-semibold text-slate-400 mb-1">Tous les accords</div>
      <div className="grid grid-cols-6 gap-1 mb-2" role="radiogroup" aria-label="Fondamentale">
        {NOTE_BUTTONS.map((n, i) => (
          <button key={n} type="button" role="radio" aria-checked={root === i} onClick={() => setRoot(i)}
            className={`h-9 rounded-md text-[12px] font-bold border ${root === i ? 'bg-white text-black border-white' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>{n}</button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {CHORD_QUALITIES.map(q => (
          <button key={q} type="button" data-chord={chordSymbol(root, q)} onClick={() => onPick(root, q)} title={chordNameFr(root, q)}
            className={`h-10 rounded-md text-[12px] font-black border ${isCur(root, q) ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
            {chordSymbol(root, q)}<span className="block text-[9px] font-semibold opacity-60">{QUALITY_LABEL[q]}</span>
          </button>
        ))}
      </div>
      {extra}
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// Couloir
// ---------------------------------------------------------------------------

export interface ChordLaneView { zoomH: number; scrollLeft: number; headerWidth: number; width: number }

interface LaneProps extends ChordLaneView {
  chords: ChordEvent[];
  bpm: number;
  beatsPerBar: number;
  projectKey?: number;
  projectScale?: string;
  onChange: (next: ChordEvent[]) => void;
  onDetect: () => void;
  detecting: boolean;
}

const ChordLane: React.FC<LaneProps> = ({ chords, zoomH, scrollLeft, headerWidth, width, bpm, beatsPerBar, projectKey, projectScale, onChange, onDetect, detecting }) => {
  const beat = 60 / Math.max(20, bpm || 120);
  const bar = beat * Math.max(1, beatsPerBar || 4);
  const [picker, setPicker] = useState<null | { x: number; y: number; id?: string; start: number; end: number }>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const t = usePlayheadTime(beat / 2);
  const active = chordAt(chords, t + 1e-6);
  const drag = useRef<{ id: string; x0: number; end0: number; moved: boolean } | null>(null);

  const timeAt = (clientX: number) => {
    const r = areaRef.current?.getBoundingClientRect();
    return Math.max(0, ((clientX - (r?.left || 0)) + scrollLeft) / Math.max(1e-6, zoomH));
  };
  const openAt = (e: React.MouseEvent) => {
    if (drag.current?.moved) return;
    const tt = timeAt(e.clientX);
    const hit = chordAt(chords, tt);
    if (hit) { setPicker({ x: e.clientX - 20, y: e.clientY + 14, id: hit.id, start: hit.start, end: hit.end }); return; }
    // Vide : un accord d'une mesure à partir du temps cliqué (sans empiéter sur le suivant).
    const start = Math.floor(tt / beat + 1e-6) * beat;
    const next = chords.find(c => c.start > start + 1e-6);
    const end = Math.min(start + bar, next ? next.start : Infinity);
    setPicker({ x: e.clientX - 20, y: e.clientY + 14, start, end });
  };

  const edit = picker?.id ? chords.find(c => c.id === picker.id) : undefined;
  const apply = (root: number, quality: ChordQuality) => {
    if (!picker) return;
    const ev: ChordEvent = edit ? { ...edit, root, quality, auto: undefined } : { id: newChordId(), start: picker.start, end: picker.end, root, quality };
    if (!ev.auto) delete ev.auto;
    onChange(placeChord(chords, ev));
    setPicker(null);
  };
  const stretch = (delta: number) => {
    if (!edit) return;
    onChange(resizeChord(chords, edit.id, edit.end + delta, beat));
    setPicker(null);
  };

  // Bord droit : durée au doigt ou à la souris, calée sur les temps.
  const onEdgeDown = (e: React.PointerEvent, c: ChordEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { id: c.id, x0: e.clientX, end0: c.end, moved: false };
  };
  const onEdgeMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / Math.max(1e-6, zoomH);
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    const end = Math.round((d.end0 + dt) / beat) * beat;
    if (d.moved) onChange(resizeChord(chords, d.id, end, beat));
  };
  const onEdgeUp = () => { window.setTimeout(() => { drag.current = null; }, 0); };

  const visible = chords.filter(c => c.end * zoomH >= scrollLeft - 4 && c.start * zoomH <= scrollLeft + width);
  return (
    <div className="shrink-0 flex border-b relative z-30" data-testid="chord-lane" style={{ height: CHORD_LANE_H, borderColor: 'var(--border-dim)', backgroundColor: 'var(--bg-surface)' }}>
      <div className="shrink-0 flex items-center gap-1 px-2 border-r" style={{ width: headerWidth, borderColor: 'var(--border-dim)' }} title={LANE_TIP}>
        <i className="fas fa-guitar text-[10px] text-cyan-300" aria-hidden />
        <span className="text-[11px] font-black text-slate-200 truncate">Accords</span>
        <button type="button" onClick={onDetect} disabled={detecting} data-testid="chord-detect"
          title="Détecter les accords du beat : NOVA écoute l’instru et remplit la piste d’accords, calée sur les temps (comme Chord ID dans Logic ou Convert Harmony to MIDI dans Ableton Live)."
          className="ml-auto h-6 px-2 rounded-md text-[10px] font-bold border border-cyan-400/40 text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-60 whitespace-nowrap">
          {detecting ? <><i className="fas fa-circle-notch fa-spin mr-1" />Analyse…</> : <><i className="fas fa-wand-magic-sparkles mr-1" />Détecter</>}
        </button>
        <button type="button" onClick={() => chordLaneStore.set(false)} aria-label="Masquer la piste d’accords" title="Masquer la piste d’accords (menu ☰ → Affichage, ou le bouton « Accords » de la barre, pour la remettre)"
          className="w-6 h-6 rounded-md text-slate-500 hover:text-white hover:bg-white/10 shrink-0"><i className="fas fa-eye-slash text-[10px]" /></button>
      </div>
      <div ref={areaRef} className="relative flex-1 overflow-hidden cursor-pointer" onClick={openAt} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
        title="Clique pour poser ou changer un accord ; glisse le bord droit d’un accord pour changer sa durée">
        {/* Barres de mesure */}
        {(() => {
          const lines: React.ReactNode[] = [];
          const first = Math.floor(scrollLeft / zoomH / bar);
          const last = Math.ceil((scrollLeft + width) / zoomH / bar);
          if (bar * zoomH >= 12) for (let b = first; b <= last && lines.length < 400; b++) {
            lines.push(<div key={b} className="absolute top-0 bottom-0 border-l border-white/[0.06] pointer-events-none" style={{ left: b * bar * zoomH - scrollLeft }} />);
          }
          return lines;
        })()}
        {visible.map(c => {
          const left = c.start * zoomH - scrollLeft;
          const w = Math.max(6, (c.end - c.start) * zoomH - 2);
          const isActive = active?.id === c.id;
          const col = chordColor(c.root);
          return (
            <div key={c.id} data-chord-event={chordSymbol(c.root, c.quality)} data-start={c.start.toFixed(3)}
              title={`${chordNameFr(c.root, c.quality)}${c.auto ? ' (détecté)' : ''}${c.by ? ` · posé par ${c.by}` : ''}`}
              className={`absolute top-[3px] bottom-[3px] rounded-md flex items-center px-1.5 overflow-hidden select-none ${isActive ? 'ring-2 ring-white/80' : ''}`}
              style={{ left, width: w, backgroundColor: `color-mix(in srgb, ${col} ${isActive ? 45 : 26}%, transparent)`, border: `1px solid ${col}`, borderStyle: c.auto ? 'dashed' : 'solid' }}>
              <span className="text-[11px] font-black text-white truncate drop-shadow">{chordSymbol(c.root, c.quality)}</span>
              <span className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/30 [@media(pointer:coarse)]:w-4"
                onPointerDown={e => onEdgeDown(e, c)} onClick={e => e.stopPropagation()} aria-hidden />
            </div>
          );
        })}
        {!chords.length && (
          <div className="absolute inset-0 flex items-center px-3 text-[10px] text-slate-500 pointer-events-none truncate">
            Clique ici pour poser un accord, ou « Détecter » pour lire les accords du beat.
          </div>
        )}
      </div>
      {picker && (
        <ChordPicker x={picker.x} y={picker.y} title={edit ? `Accord ${chordSymbol(edit.root, edit.quality)}` : 'Poser un accord'}
          current={edit ? { root: edit.root, quality: edit.quality } : undefined} projectKey={projectKey} projectScale={projectScale}
          onPick={apply} onClose={() => setPicker(null)}
          extra={edit && (
            <div className="grid grid-cols-3 gap-1 mt-3">
              <button type="button" onClick={() => stretch(-beat)} className="h-9 rounded-md text-[11px] font-bold bg-white/5 border border-white/10 hover:bg-white/10" title="Raccourcir d’un temps">− 1 temps</button>
              <button type="button" onClick={() => stretch(beat)} className="h-9 rounded-md text-[11px] font-bold bg-white/5 border border-white/10 hover:bg-white/10" title="Allonger d’un temps (jusqu’à l’accord suivant)">+ 1 temps</button>
              <button type="button" data-testid="chord-delete" onClick={() => { onChange(chords.filter(c => c.id !== edit.id)); setPicker(null); }}
                className="h-9 rounded-md text-[11px] font-bold bg-rose-500/15 border border-rose-400/40 text-rose-200 hover:bg-rose-500/25">Retirer</button>
            </div>
          )} />
      )}
    </div>
  );
};

export default ChordLane;

// ---------------------------------------------------------------------------
// Branchement dans App (un crochet) et bascules d'affichage
// ---------------------------------------------------------------------------

/** Couloir affiché ? (choix de l'artiste ; sans choix : avancé oui, simple non). */
export const useChordLaneShown = (): boolean => {
  const pref = useChordLanePref();
  const { simple } = useSimpleMode();
  return chordLaneVisible(pref, simple);
};

/** Clips du beat à analyser : la piste « instrumental », sinon les pistes audio de beat / sample. */
export function beatClipsOf(tracks: Track[]) {
  const withBuf = (t: Track) => t.clips.filter(c => !c.isMuted && (c.buffer || (c.bufferId && audioBufferRegistry.has(c.bufferId))))
    .map(c => ({ start: c.start, duration: c.duration, offset: c.offset || 0, buffer: (c.buffer || audioBufferRegistry.get(c.bufferId!))! }));
  const beat = tracks.find(t => t.id === 'instrumental');
  if (beat && withBuf(beat).length) return withBuf(beat);
  const cands = tracks.filter(t => t.type === TrackType.AUDIO && (t.instrumentId || /beat|instru|sample|m[ée]lod|loop|boucle/i.test(t.name)));
  return cands.flatMap(withBuf);
}

/**
 * Tout ce que l'arrangement doit savoir pour afficher le couloir (ou
 * undefined s'il est masqué). App : `chordLane={useChordLaneProp(...)}`.
 */
export function useChordLaneProp(o: {
  chords?: ChordEvent[]; tracks: Track[]; bpm: number; beatsPerBar?: number; projectKey?: number; projectScale?: string;
  setState: (fn: (prev: DAWState) => DAWState) => void; disabled?: boolean;
}): { height: number; render: (v: ChordLaneView) => React.ReactNode } | undefined {
  const shown = useChordLaneShown();
  const [detecting, setDetecting] = useState(false);
  const tracksRef = useRef(o.tracks);
  tracksRef.current = o.tracks;
  const { setState, bpm } = o;
  const bpb = o.beatsPerBar || 4;
  const onChange = useCallback((next: ChordEvent[]) => {
    setState(prev => produce(prev, (d: DAWState) => { d.chords = sanitizeChords(next); }));
  }, [setState]);
  const onDetect = useCallback(() => {
    const clips = beatClipsOf(tracksRef.current);
    if (!clips.length) { notify('🎸 Pas de beat à écouter : importe une instru (ou un sample), ou utilise « Convertir en MIDI → Harmonie » dans le menu d’un clip.'); return; }
    setDetecting(true);
    // Laisse s'afficher « Analyse… » avant le calcul (~0,3 s par minute d'audio).
    window.setTimeout(() => {
      try {
        const found = detectChordsInClips(clips, bpm, bpb);
        setState(prev => produce(prev, (d: DAWState) => {
          let next = sanitizeChords(d.chords);
          for (const c of clips) next = replaceRange(next, c.start, c.start + c.duration, found.filter(f => f.start >= c.start - 1e-6 && f.start < c.start + c.duration));
          d.chords = next;
        }));
        const list = found.slice(0, 6).map(c => chordSymbol(c.root, c.quality)).join(' · ');
        notify(found.length
          ? `🎸 ${found.length} accord${found.length > 1 ? 's' : ''} trouvé${found.length > 1 ? 's' : ''} : ${list}${found.length > 6 ? '…' : ''}. Clique un accord pour le corriger (Ctrl+Z pour revenir).`
          : '🎸 Je n’ai pas trouvé d’accords clairs dans ce beat (batterie seule ?). Pose-les à la main en cliquant dans le couloir.');
      } catch (e: any) {
        notify(`Détection des accords impossible : ${e?.message || e}`);
      } finally { setDetecting(false); }
    }, 30);
  }, [bpm, bpb, setState]);
  const chords = useMemo(() => sanitizeChords(o.chords), [o.chords]);
  const render = useCallback((v: ChordLaneView) => (
    <ChordLane {...v} chords={chords} bpm={bpm} beatsPerBar={bpb} projectKey={o.projectKey} projectScale={o.projectScale}
      onChange={onChange} onDetect={onDetect} detecting={detecting} />
  ), [chords, bpm, bpb, o.projectKey, o.projectScale, onChange, onDetect, detecting]);
  return useMemo(() => (shown && !o.disabled ? { height: CHORD_LANE_H, render } : undefined), [shown, o.disabled, render]);
}

/** Bouton « Accords » de la barre de l'arrangement (grands écrans sans menu ☰). */
export const ChordLaneToggleButton: React.FC = () => {
  const shown = useChordLaneShown();
  return (
    <button type="button" onClick={() => chordLaneStore.set(!shown)} aria-pressed={shown} data-testid="chord-lane-toggle"
      title={`${shown ? 'Masquer' : 'Afficher'} la piste d’accords (Chord Track de Logic) sous la barre d’outils`}
      className={`h-8 px-2 rounded-lg border text-[10px] font-bold whitespace-nowrap ${shown ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}>
      <i className="fas fa-guitar mr-1" />Accords
    </button>
  );
};

/** Ligne « Piste d’accords » du menu ☰ (section Affichage). */
export const ChordLaneMenuToggle: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
  const shown = useChordLaneShown();
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Affichage</div>
      <button type="button" role="switch" aria-checked={shown} data-testid="menu-chord-lane"
        onClick={() => { chordLaneStore.set(!shown); onDone?.(); }}
        title="Couloir des accords sous la barre d’outils de l’arrangement (comme la Chord Track de Logic)"
        className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
        <i className="fas fa-guitar w-5 text-center text-cyan-300" />
        <span className="flex-1 text-left">Piste d’accords</span>
        <span className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${shown ? 'bg-cyan-500' : 'bg-white/15'}`}>
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${shown ? 'translate-x-5' : ''}`} />
        </span>
      </button>
    </div>
  );
};
