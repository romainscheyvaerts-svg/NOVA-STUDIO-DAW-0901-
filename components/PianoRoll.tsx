
import { matchShortcut } from '../utils/keymap';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Track, MidiNote, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { usePlayheadTime } from '../utils/playheadStore';
import { isInScale, snapToScale, scaleRows, buildChord, chordLabelFr, keyLabelFr, noteNameFr, CHORD_CHOICES, SCALE_CHOICES, NOTE_NAMES_FR, ChordKind } from '../utils/scales';
import MidiToolsPanel from './MidiToolsPanel';
import { useCaptureCount, CAPTURE_HINT } from './MidiFileMenu';
import { midiBus } from '../utils/midiBus';
import ChordRollOverlay from './ChordRollOverlay';
import { useTempoMap } from './TempoLane';
import { tempoAt, TempoMap } from '../utils/tempoMap';
import { rollFollowsMap, mapSnap, mapCell, spanQuarters, beatLenAt, mapSnapBeat, mapGridLines, mapBarBeat } from '../utils/rollGrid';
import { linkCounts, makeUnique } from '../utils/linkedClips';
import { NoteRecorder, defaultKeyLabel, KEY_TO_SEMITONE, computerKeyboardStore } from '../utils/computerKeyboard';
import { useComputerKeyboard } from './MidiInputHost';
import { midiInput } from '../services/MidiInput';
import MidiCcLanes from './MidiCcLanes';
import { MidiCcPoint } from '../utils/midiCc';
import { StepInput, STEP_VALUES, stepSeconds } from '../utils/stepInput';
import { useTheme } from '../utils/themeStore';
import { useSimpleMode } from '../utils/simpleMode';
import { quantize as quantizeTool, legato as legatoTool, invert as invertTool, retrograde as retrogradeTool, ToolId } from '../utils/midiTools';
import { glueNotes, glueWithNext, thicken, usedRows, quantizeInput, fitView, followScroll } from '../utils/pianoRollEdit';
import RollMenu, { RollMenuEntry } from './pianoroll/RollMenu';
import NoteProps from './pianoroll/NoteProps';
import {
  GRID_CHOICES, gridSec, snapTime as snapGrid, floorTime, newNoteId, paintNotes, splitNoteAt, duplicateRight, copyNotes, pasteNotes,
  NoteClipboard, humanize, toggleSlide, slideOrigins, velocityColor, inkOn, resizeNotesBy, copyForDrag,
} from '../utils/pianoRollPro';
import './pianoroll/pianoroll.css';

/**
 * Piano roll (éditeur de notes MIDI).
 *
 * 15/10/2026, « piano roll pro » : outils crayon, pinceau, sélection, couteau,
 * gomme (FL Studio : P, B, E, C, D) ; grille 1/1 à 1/64 avec triolets et
 * magnétisme coupable (Alt pour passer outre) ; quantification avec force,
 * swing et fins de notes ; glissés par note (FL : Slide) ; couleurs selon la
 * vélocité ; règle des mesures avec boucle ; copier / coller, Ctrl+B ; aperçu
 * du son ; zoom à la molette (Ctrl) et au pincement ; barre d'outils avancée
 * repliable (mode simple, téléphone).
 */

/** Raccourcis du piano roll (contexte « pianoroll » de utils/keymap, remappables). */
const PIANO_ROLL_SHORTCUT_IDS = [
  'pr.close', 'nova.muteNotes', 'pr.delete', 'pr.selectAll', 'pr.double', 'pr.up', 'pr.down', 'pr.octUp', 'pr.octDown', 'pr.quantize', 'pr.humanize',
  'pr.copy', 'pr.cut', 'pr.paste', 'pr.left', 'pr.right', 'pr.slide', 'pr.longer', 'pr.shorter', 'pr.legato',
  'pr.toolDraw', 'pr.toolPaint', 'pr.toolSelect', 'pr.toolSlice', 'pr.toolErase',
  'pr.toolGlue', 'pr.toolMute', 'pr.zoomSel', 'pr.props', 'pr.glue',
];

type RollTool = 'DRAW' | 'PAINT' | 'SELECT' | 'SPLIT' | 'ERASE' | 'GLUE' | 'MUTE';
/** Outil affiché : les outils de la grille, plus le tampon d'accords et le glissé (crayon spécialisé). */
type ShownTool = RollTool | 'CHORD' | 'SLIDE';
const TOOLS: { id: ShownTool; icon: string; label: string; keys: string; hint: string }[] = [
  { id: 'DRAW', icon: 'fa-pencil-alt', label: 'Crayon', keys: 'P', hint: 'Crayon (P) : clic = une note (longueur de la dernière), glisser = l’allonger, clic droit = effacer, Alt = sans grille, Maj + clic = note glissée' },
  { id: 'PAINT', icon: 'fa-paint-brush', label: 'Pinceau', keys: 'B', hint: 'Pinceau (B) : glisse pour peindre des notes à la suite, une par case de grille (hi-hats, 808)' },
  { id: 'SELECT', icon: 'fa-mouse-pointer', label: 'Sélection', keys: 'E', hint: 'Sélection (E) : encadre des notes, déplace-les, Maj = ajouter' },
  { id: 'SPLIT', icon: 'fa-cut', label: 'Couteau', keys: 'C', hint: 'Couteau (C) : coupe une note en deux sur la grille ; glisser verticalement coupe plusieurs notes' },
  { id: 'GLUE', icon: 'fa-link', label: 'Souder', keys: 'G', hint: 'Souder (G) : clic sur une note = elle rejoint la suivante de même hauteur' },
  { id: 'MUTE', icon: 'fa-volume-mute', label: 'Sourdine', keys: 'T', hint: 'Sourdine (T) : clic ou glisser sur les notes = muettes (gardées, grisées, jamais jouées) ou réactivées' },
  { id: 'ERASE', icon: 'fa-eraser', label: 'Gomme', keys: 'D', hint: 'Gomme (D) : clic ou glisser sur les notes pour les effacer' },
  { id: 'CHORD', icon: 'fa-layer-group', label: 'Tampon d’accords', keys: '', hint: 'Tampon d’accords : un clic pose tout l’accord de la gamme du projet, glisser règle sa longueur' },
  { id: 'SLIDE', icon: 'fa-level-up-alt', label: 'Glissé (808)', keys: 'S', hint: 'Glissé (S) : la note posée pendant une note tenue la fait glisser jusqu’à sa hauteur (Maj + clic avec le crayon aussi)' },
];

/**
 * Clavier du piano roll : de vraies touches blanches et noires dans les deux
 * thèmes (couleurs fixes, hors des jetons qui inversent blanc et noir en clair).
 * Noms : contraste ≥ 4,5:1 sur la touche, même grisée (hors gamme).
 */
const KEY_COLORS = {
  white: '#f8fafc', whiteOut: '#c9cfd8', black: '#0b0c0f', blackOut: '#2b3039', held: '#22d3ee',
  nameOnWhite: '#164e63', rootOnWhite: '#92400e', nameOnBlack: '#67e8f9', rootOnBlack: '#fcd34d',
};
const isBlackKey = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

/** Couleurs de la grille, par thème (lisibles en sombre comme en clair). */
const GRID_THEME = {
  dark: { white: '#17191e', black: '#111317', row: 'rgba(255,255,255,0.035)', octave: 'rgba(255,255,255,0.12)', sub: 'rgba(255,255,255,0.045)', beat: 'rgba(255,255,255,0.10)', bar: 'rgba(255,255,255,0.26)', barShade: 'rgba(255,255,255,0.018)', playhead: '#ffffff', ghostAlpha: '22' },
  light: { white: '#f7f8fa', black: '#e7eaf0', row: 'rgba(15,23,42,0.06)', octave: 'rgba(15,23,42,0.22)', sub: 'rgba(15,23,42,0.06)', beat: 'rgba(15,23,42,0.14)', bar: 'rgba(15,23,42,0.38)', barShade: 'rgba(15,23,42,0.025)', playhead: '#0b0c0f', ghostAlpha: '33' },
};

/** Préférences d'affichage du piano roll, gardées sur cet appareil. */
const PREFS_KEY = 'nova.pianoroll.prefs';
type RollPrefs = {
  highlight: boolean; snap: boolean; fold: boolean; ghosts: boolean; preview: boolean; velColors: boolean; advanced?: boolean; gridId: string; magnet: boolean;
  /** Replier aux notes utilisées (FL : Fold). */
  foldUsed?: boolean;
  /** La vue suit la tête de lecture (par pages). */
  follow?: boolean;
  /** Quantification d'entrée : la prise commence sur la grille. */
  inputQuant?: boolean;
  /** Couloirs de vélocité et de contrôleurs affichés (oui par défaut). */
  lanes?: boolean;
};
const readPrefs = (): RollPrefs => {
  const def: RollPrefs = { highlight: true, snap: false, fold: false, ghosts: true, preview: true, velColors: true, gridId: '1/16', magnet: true, foldUsed: false, follow: true, inputQuant: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
};
const writePrefs = (p: RollPrefs) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } };

/** Presse-papiers des notes, partagé entre les clips (copier dans un clip, coller dans un autre). */
let noteClipboard: NoteClipboard | null = null;

/** Humaniser : trois dosages (H = moyen). */
type HumanizeLevel = 'leger' | 'moyen' | 'fort';
const HUMANIZE: Record<HumanizeLevel, { label: string; timingMs: number; velocity: number; length: number }> = {
  leger: { label: 'léger', timingMs: 6, velocity: 0.05, length: 0.03 },
  moyen: { label: 'moyen', timingMs: 12, velocity: 0.08, length: 0.05 },
  fort: { label: 'fort', timingMs: 25, velocity: 0.15, length: 0.1 },
};

const coarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

/** Trait de lecture : seul lui se re-rend pendant la lecture, pas tout le piano roll. */
const PianoRollPlayhead: React.FC<{ clipStart: number; zoomX: number; color: string }> = ({ clipStart, zoomX, color }) => {
  const t = usePlayheadTime();
  return <div className="absolute top-0 bottom-0 w-0.5 z-50 pointer-events-none" style={{ left: (t - clipStart) * zoomX, backgroundColor: color }} />;
};

/** Petit triangle de la tête de lecture sur la règle. */
const RulerPlayhead: React.FC<{ clipStart: number; zoomX: number }> = ({ clipStart, zoomX }) => {
  const t = usePlayheadTime();
  return <div className="absolute bottom-0 pointer-events-none" style={{ left: (t - clipStart) * zoomX - 5, width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '8px solid #22d3ee' }} />;
};

interface LoopState { active: boolean; start: number; end: number }

/**
 * Règle des mesures (FL : barre de temps, Live : règle du clip) : clic = place la
 * tête de lecture, glisser = boucle d'écoute (calée sur les temps).
 */
const Ruler: React.FC<{
  clipStart: number; clipDuration: number; width: number; zoomX: number; bpm: number; light: boolean;
  loop?: LoopState; onSeek?: (t: number) => void; onSetLoop?: (start: number, end: number, active: boolean) => void;
  innerRef: React.RefObject<HTMLDivElement>; height: number;
  /** Carte de tempo suivie (rampes, changements, mesures) : mesures et temps à leur vraie place. */
  map?: TempoMap | null;
  /** Autres clips ouverts ensemble : leur étendue sous la règle (clic = éditer ce clip). */
  spans?: { id: string; start: number; end: number; color: string; label: string; onClick: () => void }[];
}> = ({ clipStart, clipDuration, width, zoomX, bpm, light, loop, onSeek, onSetLoop, innerRef, height, map, spans }) => {
  const beat = 60 / bpm, bar = beat * 4;
  // Carte de tempo : traits calculés (une rampe resserre ou écarte les mesures).
  const mapLines = useMemo(() => (map ? mapGridLines(map, clipStart, clipStart + width / zoomX, '1/4', Infinity) : null), [map, clipStart, width, zoomX]);
  const barPx = mapLines && mapLines.bars.length > 1 ? Math.min(...mapLines.bars.slice(1).map((b, i) => b.time - mapLines.bars[i].time)) * zoomX : bar * zoomX;
  const every = barPx >= 36 ? 1 : barPx >= 18 ? 2 : barPx >= 9 ? 4 : 8;
  const first = Math.floor(clipStart / bar);
  const last = Math.ceil((clipStart + width / zoomX) / bar);
  const labels: { x: number; n: number }[] = [];
  if (mapLines) mapLines.bars.forEach(b => { if (b.bar % every === 0) labels.push({ x: (b.time - clipStart) * zoomX, n: b.bar + 1 }); });
  else for (let k = first; k <= last; k++) if ((k % every) === 0) labels.push({ x: (k * bar - clipStart) * zoomX, n: k + 1 });
  // Temps numérotés (« 2.3 ») quand le zoom laisse la place : règle claire, mesures et temps.
  const beatLabels: { x: number; t: string }[] = [];
  if (barPx >= 150) {
    if (mapLines) {
      let bi = 0;
      mapLines.beats.forEach(t => {
        while (bi + 1 < mapLines.bars.length && mapLines.bars[bi + 1].time <= t + 1e-9) bi++;
        const b = mapLines.bars[bi];
        if (!b || Math.abs(t - b.time) < 1e-6) return;
        const k = mapLines.beats.filter(x => x > b.time + 1e-6 && x <= t + 1e-9).length + 1;
        beatLabels.push({ x: (t - clipStart) * zoomX, t: `${b.bar + 1}.${k}` });
      });
    } else {
      const fb = Math.floor(clipStart / beat), lb = Math.ceil((clipStart + width / zoomX) / beat);
      for (let k = fb; k <= lb; k++) { const inBar = ((k % 4) + 4) % 4; if (inBar) beatLabels.push({ x: (k * beat - clipStart) * zoomX, t: `${Math.floor(k / 4) + 1}.${inBar + 1}` }); }
    }
  }
  const offset = -((clipStart % bar) * zoomX);
  const drag = useRef<{ x0: number; t0: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null);
  const toT = (clientX: number) => {
    const r = (innerRef.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    return Math.max(0, (clientX - (r?.left || 0)) / zoomX);
  };
  const snapBeat = (t: number) => (map ? mapSnapBeat(map, clipStart + t) : Math.round((clipStart + t) / beat) * beat) - clipStart;
  const beatAt = (t: number) => (map ? beatLenAt(map, clipStart + t) : beat);
  const lineCol = light ? 'rgba(15,23,42,0.35)' : 'rgba(255,255,255,0.28)';
  const tickCol = light ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.14)';
  const shown = draft ? { active: true, start: clipStart + Math.min(draft.a, draft.b), end: clipStart + Math.max(draft.a, draft.b) } : loop;
  return (
    <div ref={innerRef} className="flex-1 overflow-hidden relative pr-ruler" style={{ height }}>
      <div data-nova-roll-ruler="" role="slider" aria-label="Règle des mesures : clic pour placer la lecture, glisser pour une boucle" aria-valuemin={0} aria-valuemax={Math.round(clipDuration)} aria-valuenow={0}
        data-nova-roll-tempo={mapLines ? 'carte' : 'fixe'}
        className="relative h-full cursor-pointer" style={mapLines ? { width, touchAction: 'none' } : { width, touchAction: 'none',
          backgroundImage: `linear-gradient(to right, ${lineCol} 1px, transparent 1px), linear-gradient(to right, ${tickCol} 1px, transparent 1px)`,
          backgroundSize: `${barPx}px 100%, ${beat * zoomX}px 40%`, backgroundRepeat: 'repeat-x', backgroundPosition: `${offset}px 0, ${offset}px 100%` }}
        onPointerDown={e => { if (e.pointerType === 'mouse' && e.button !== 0) return; try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* pointeur relâché */ } const t = toT(e.clientX); drag.current = { x0: e.clientX, t0: t, moved: false }; }}
        onPointerMove={e => { const d = drag.current; if (!d || !onSetLoop) return; if (Math.abs(e.clientX - d.x0) > 6) { d.moved = true; setDraft({ a: snapBeat(d.t0), b: snapBeat(toT(e.clientX)) }); } }}
        onPointerUp={e => {
          const d = drag.current; drag.current = null; setDraft(null);
          if (!d) return;
          if (d.moved && onSetLoop) {
            const a = snapBeat(d.t0), b = snapBeat(toT(e.clientX));
            if (Math.abs(b - a) >= beatAt(Math.min(a, b)) * 0.99) onSetLoop(clipStart + Math.min(a, b), clipStart + Math.max(a, b), true);
            return;
          }
          onSeek?.(clipStart + d.t0);
        }}
        onPointerCancel={() => { drag.current = null; setDraft(null); }}>
        {shown && shown.end > shown.start && (
          <div data-nova-roll-loop={shown.active ? 'on' : 'off'} className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: (shown.start - clipStart) * zoomX, width: (shown.end - shown.start) * zoomX,
              background: shown.active ? 'rgba(245,158,11,0.28)' : 'rgba(148,163,184,0.16)', borderLeft: `2px solid ${shown.active ? '#f59e0b' : '#94a3b8'}`, borderRight: `2px solid ${shown.active ? '#f59e0b' : '#94a3b8'}` }} />
        )}
        {mapLines && (
          <svg aria-hidden className="absolute inset-0 pointer-events-none" width={width} height={height} shapeRendering="crispEdges">
            <path data-nova-roll-ruler-bars="" d={mapLines.bars.map(b => `M${((b.time - clipStart) * zoomX + 0.5).toFixed(2)} 0V${height}`).join('')} stroke={lineCol} strokeWidth={1} />
            <path d={mapLines.beats.map(t => `M${((t - clipStart) * zoomX + 0.5).toFixed(2)} ${(height * 0.6).toFixed(1)}V${height}`).join('')} stroke={tickCol} strokeWidth={1} />
          </svg>
        )}
        {labels.map(l => (
          <span key={l.n} className="absolute top-0.5 text-[10px] font-bold font-mono pointer-events-none" style={{ left: l.x + 3 }}>{l.n}</span>
        ))}
        {beatLabels.map(l => (
          <span key={`b${l.t}`} aria-hidden className="absolute top-1 text-[9px] font-mono pointer-events-none opacity-70" style={{ left: l.x + 3 }}>{l.t}</span>
        ))}
        {(spans || []).map(sp => (
          <button key={sp.id} type="button" data-nova-roll-span={sp.id} title={`${sp.label} : clic pour éditer ce clip`}
            onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); sp.onClick(); }}
            className="absolute bottom-0 h-[5px] rounded-t-sm cursor-pointer" style={{ left: Math.max(0, (sp.start - clipStart) * zoomX), width: Math.max(4, (sp.end - Math.max(sp.start, clipStart)) * zoomX), background: sp.color, opacity: 0.85 }} aria-label={`Éditer ${sp.label}`} />
        ))}
        <RulerPlayhead clipStart={clipStart} zoomX={zoomX} />
      </div>
    </div>
  );
};

interface PianoRollProps {
  track: Track;
  clipId: string;
  bpm: number;
  /** Inutilise : la tete de lecture est lue dans playheadStore. */
  currentTime?: number;
  onUpdateTrack: (track: Track) => void;
  onClose: () => void;
  /** Élément ajouté dans la barre d'outils (choix du son en mode instru). */
  toolbarExtra?: React.ReactNode;
  /** Lecture / pause du projet depuis l'éditeur (il couvre la barre de transport). */
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Tonalité du projet (0 = Do … 11 = Si), détectée à l'import ou lue sur le beat. */
  projectKey?: number;
  projectScale?: string;
  /** Change la tonalité du projet (une étape d'annulation). */
  onSetProjectKey?: (root: number, scale: string) => void;
  /** Toutes les pistes : notes fantômes des autres pistes MIDI. */
  allTracks?: Track[];
  /** Boucle du projet (temps du morceau) et son réglage : règle et bouton « Boucler le clip ». */
  loop?: LoopState;
  onSetLoop?: (start: number, end: number, active: boolean) => void;
  /** Place la tête de lecture (temps du morceau). */
  onSeek?: (time: number) => void;
  /** Métronome du projet (la barre de transport est cachée sous l'éditeur). */
  metronomeOn?: boolean;
  onToggleMetronome?: () => void;
}

type DragMode = 'MOVE' | 'RESIZE_R' | 'SELECT' | 'PAINT' | 'ERASE' | 'SLICE' | 'MUTE' | null;

const PianoRoll: React.FC<PianoRollProps> = ({ track, clipId, bpm: projectBpm, onUpdateTrack, onClose, toolbarExtra, isPlaying, onTogglePlay, projectKey, projectScale, onSetProjectKey, allTracks, loop, onSetLoop, onSeek, metronomeOn, onToggleMetronome }) => {
  const light = useTheme().theme === 'light';
  const G = light ? GRID_THEME.light : GRID_THEME.dark;
  const { simple } = useSimpleMode();
  const clipIndex = track.clips.findIndex(c => c.id === clipId);
  const clip = track.clips[clipIndex];
  // Piste tempo (R2) : la grille et la quantification du clip suivent le tempo à l'endroit du clip.
  const tempoMap = useTempoMap();
  const bpm = Math.abs(tempoMap.segments[0].bpm - projectBpm) < 1e-6 ? tempoAt(tempoMap, clip?.start ?? 0) : projectBpm;
  // Rampe, changement de tempo ou de mesure : grille, aimantation et règle suivent la carte réelle
  // (utils/rollGrid), comme l'arrangement. 4/4 à tempo fixe : grille régulière d'avant.
  const followMap = rollFollowsMap(tempoMap, projectBpm) ? tempoMap : null;
  const bpmEnd = followMap && clip ? tempoAt(followMap, clip.start + clip.duration - 1e-6) : bpm;
  const beatSec = 60 / bpm;
  const linkedCount = useMemo(() => (clip?.linkId ? linkCounts(allTracks || [track]).get(clip.linkId) || 0 : 0), [clip?.linkId, allTracks, track]);
  const barSec = beatSec * 4;
  const clipStart = clip?.start || 0;

  const isDrumMode = track.type === TrackType.DRUM_RACK;
  const touch = useMemo(coarsePointer, []);
  const [rowH, setRowH] = useState<number>(() => (isDrumMode ? (touch ? 32 : 24) : (touch ? 22 : 16)));
  const currentRowHeight = rowH;

  // --- PRÉFÉRENCES (gamme, grille, aperçu, couleurs, barre avancée) ---
  const [prefs, setPrefsState] = useState<RollPrefs>(readPrefs);
  const setPrefs = (patch: Partial<RollPrefs>) => setPrefsState(p => { const n = { ...p, ...patch }; writePrefs(n); return n; });


  // --- GAMME (Scale Highlighting de FL, Keys and Scales de Live 12) ---
  // Tonalité choisie ici quand le projet n'en a pas (ou sans branchement).
  const [localKey, setLocalKey] = useState<{ root: number; scale: string } | null>(null);
  const keyRoot = typeof projectKey === 'number' && Number.isFinite(projectKey) ? ((projectKey % 12) + 12) % 12 : localKey?.root;
  const keyScale = (typeof projectKey === 'number' ? projectScale : localKey?.scale) || 'MINOR';
  const hasKey = !isDrumMode && typeof keyRoot === 'number' && keyScale.toUpperCase() !== 'CHROMATIC';
  const highlight = hasKey && prefs.highlight;
  const snapOn = hasKey && prefs.snap;
  const foldOn = hasKey && prefs.fold;
  const inKey = useCallback((p: number) => !hasKey || isInScale(p, keyRoot!, keyScale), [hasKey, keyRoot, keyScale]);
  const setKey = (root: number, scale: string) => {
    if (onSetProjectKey) onSetProjectKey(root, scale); else setLocalKey({ root, scale });
  };

  // Replier aux notes utilisées (FL : Fold) : seules les hauteurs du clip restent (un clip vide montre tout).
  const usedKey = prefs.foldUsed ? Array.from(new Set((clip?.notes || []).map(n => n.pitch))).sort((a, b) => b - a).join(',') : '';
  const foldUsedOn = !!prefs.foldUsed && usedKey !== '';
  const anyFold = foldOn || foldUsedOn;
  // Lignes affichées, de haut en bas (toutes, seulement celles de la gamme, ou seulement celles utilisées).
  const rows = useMemo<number[]>(() => {
    if (foldUsedOn) return usedKey.split(',').map(Number);
    if (isDrumMode) return Array.from({ length: 30 }, (_, i) => 89 - i);
    if (foldOn) return scaleRows(keyRoot!, keyScale, true);
    return Array.from({ length: 128 }, (_, i) => 127 - i);
  }, [isDrumMode, foldOn, keyRoot, keyScale, foldUsedOn, usedKey]);
  const rowIndex = useMemo(() => { const m = new Map<number, number>(); rows.forEach((p, i) => m.set(p, i)); return m; }, [rows]);
  const totalRows = rows.length;

  /** Ligne d'une note ; une note hors gamme en mode « seulement la gamme » s'affiche sur la note de gamme juste en dessous. */
  const rowOf = (pitch: number) => {
    const i = rowIndex.get(pitch);
    if (i !== undefined) return i;
    if (foldUsedOn) { let best = 0; rows.forEach((p, k) => { if (Math.abs(p - pitch) < Math.abs(rows[best] - pitch)) best = k; }); return best; }
    if (foldOn) { const j = rowIndex.get(snapToScale(pitch, keyRoot!, keyScale, 'down')); if (j !== undefined) return j; }
    return Math.max(0, Math.min(rows.length - 1, isDrumMode ? 89 - pitch : 127 - pitch));
  };
  /** Déplace une note de `delta` lignes (en mode gamme : de degré en degré). */
  const shiftPitch = (pitch: number, deltaRows: number) => {
    if (anyFold) return rows[Math.max(0, Math.min(rows.length - 1, rowOf(pitch) - deltaRows))];
    if (isDrumMode) return Math.max(60, Math.min(89, pitch + deltaRows));
    const p = Math.max(0, Math.min(127, pitch + deltaRows));
    return snapOn && deltaRows !== 0 ? snapToScale(p, keyRoot!, keyScale, deltaRows > 0 ? 'up' : 'down') : p;
  };

  // --- GRILLE ET QUANTIFICATION ---
  const gridId = GRID_CHOICES.some(g => g.id === prefs.gridId) ? prefs.gridId : '1/16';
  const grid = gridSec(gridId, bpm);
  const magnet = prefs.magnet;
  const [quantizeStrength, setQuantizeStrength] = useState(100);
  const [quantizeSwing, setQuantizeSwing] = useState(50);
  const [quantizeEnds, setQuantizeEnds] = useState(false);
  const [showQuantizeMenu, setShowQuantizeMenu] = useState(false);
  // Position du menu de quantification : affiché hors de la barre (qui défile en largeur et le coupait).
  const [quantPos, setQuantPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // --- ÉTAT ---
  // Zoom de départ : un temps = 80 px (une mesure bien lisible, les doubles-croches à 20 px) ; au téléphone 60 px (plus d'une mesure à l'écran).
  const [zoomX, setZoomX] = useState(() => Math.max(40, Math.min(400, (coarsePointer() ? 60 : 80) / (60 / (projectBpm || 120)))));
  const [tool, setTool] = useState<RollTool>('DRAW');
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  // Longueur et vélocité des nouvelles notes : celles de la dernière note touchée (FL Studio).
  const [noteLen, setNoteLen] = useState<number | null>(null);
  const [noteVel, setNoteVel] = useState(0.8);
  const [slideDraw, setSlideDraw] = useState(false);
  /** Longueur des glissés (808) : gardée à part, un glissé est court (une case par défaut). */
  const [slideLen, setSlideLen] = useState<number | null>(null);
  /** Menu ouvert : outil, outils, notes, vue, clic droit (ctx). */
  const [dropdown, setDropdown] = useState<{ name: 'outil' | 'outils' | 'notes' | 'vue' | 'ctx'; x: number; y: number; t?: number; row?: number } | null>(null);
  /** Autres clips ouverts ensemble (ids), voir « Vue ▾ ». */
  const [openClips, setOpenClips] = useState<string[]>([]);
  /** Propriétés des notes (double-clic). */
  const [propsFor, setPropsFor] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  /** Clic droit dans le vide : menu si la souris n'a presque pas bougé et rien n'a été effacé. */
  const rightRef = useRef<{ x: number; y: number; erased: boolean; t: number; row: number } | null>(null);
  /** Outil sourdine glissé : notes déjà touchées, et l'état choisi par la première. */
  const muteDragRef = useRef<{ seen: Set<string>; mute: boolean } | null>(null);

  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStart, setDragStart] = useState<{ x: number, y: number, time: number, pitch: number, row: number } | null>(null);
  const [initialNotes, setInitialNotes] = useState<MidiNote[]>([]);
  const [selectionBox, setSelectionBox] = useState<{ startX: number, startY: number, endX: number, endY: number } | null>(null);
  const paintRef = useRef<{ cells: Set<number>; added: MidiNote[]; base: MidiNote[] } | null>(null);
  const lastPreviewPitch = useRef<number | null>(null);
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  /** Note qu'on vient de poser au crayon : glisser règle sa fin sous la souris (FL), puis elle est désélectionnée. */
  const drawResizeRef = useRef<{ id: string; moved: boolean; ids?: Set<string> } | null>(null);
  /** Ctrl ou Maj + glisser une note : copie (l'original reste). `copies` = original → copie, posé au 1er vrai mouvement. */
  const copyDragRef = useRef<{ ids: Set<string>; copies: Map<string, string> | null; base: MidiNote[] } | null>(null);

  // --- OUTILS MIDI (V25) : menu « Outils » avec aperçu, groove, capture ---
  const [toolsAnchor, setToolsAnchor] = useState<{ x: number; y: number } | null | false>(false);
  const [toolsInitial, setToolsInitial] = useState<ToolId | undefined>(undefined);
  const [toolPreview, setToolPreview] = useState<MidiNote[] | null>(null);
  const captureCount = useCaptureCount();
  const toolCtx = useMemo(() => ({ bpm, clipStart: clip?.start || 0, keyRoot: hasKey ? keyRoot : undefined, keyScale, ...(followMap ? { tempoMap: followMap } : {}) }), [bpm, clip?.start, hasKey, keyRoot, keyScale, followMap]);
  /** Résultat d'un outil : une seule écriture (une étape d'annulation, une opération de collaboration). */
  const applyToolResult = (next: MidiNote[], label: string) => {
    const end = next.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
    const ids = new Set(next.map(n => n.id));
    onUpdateTrack({ ...track, clips: track.clips.map(c => (c.id === clipId ? { ...c, notes: next, duration: Math.max(c.duration, end) } : c)) });
    setSelectedNoteIds(prev => new Set(Array.from(prev).filter(id => ids.has(id))));
    window.dispatchEvent(new CustomEvent('nova:notify', { detail: `${label} appliqué : ${next.length} note${next.length > 1 ? 's' : ''} (Ctrl+Z pour annuler).` }));
  };

  const gridRef = useRef<HTMLDivElement>(null);
  void gridRef;
  const keysRef = useRef<HTMLDivElement>(null);
  const velocityRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // --- HELPERS ---
  /** Cale un temps du clip sur la grille du morceau (sauf magnétisme coupé ou Alt tenu). */
  const snapTime = useCallback((t: number, free = false) => (followMap && magnet && !free ? mapSnap(followMap, clipStart + t, gridId) - clipStart : snapGrid(t, grid, clipStart, magnet && !free)), [grid, gridId, clipStart, magnet, followMap]);
  const cellTime = useCallback((t: number, free = false) => (followMap && magnet && !free ? mapSnap(followMap, clipStart + t, gridId, 'floor') - clipStart : floorTime(t, grid, clipStart, magnet && !free)), [grid, gridId, clipStart, magnet, followMap]);
  /** Longueur de la case qui contient `t` (dans le clip) : elle varie dans une rampe. */
  const cellLenAt = (t: number) => { if (!followMap) return grid; const [a, b] = mapCell(followMap, clipStart + Math.max(0, t), gridId); return b - a > 1e-6 ? b - a : grid; };
  /** Durée d'une noire à l'endroit `t` (dans le clip). */
  const quarterAt = (t: number) => (followMap ? spanQuarters(followMap, clipStart + Math.max(0, t), 1) : beatSec);
  const minLenAt = (t: number) => (magnet ? cellLenAt(t) : 0.02);
  /** Case du pinceau (une note par case) : index régulier, ou début exact de la case sur la carte. */
  const paintKey = (abs: number) => (followMap ? Math.round(mapSnap(followMap, abs, gridId, 'floor') * 1e6) : Math.floor(abs / grid + 1e-9));
  /** Pinceau sur la carte : une note au début exact de la case (déjà prise à cette hauteur : rien). */
  const paintOnMap = (from: number, pitch: number, existing: MidiNote[]): MidiNote[] => {
    if (from < 0 || existing.some(n => n.pitch === pitch && Math.abs(n.start - from) < 1e-6)) return [];
    const len = isDrumMode ? Math.min(cellLenAt(from), quarterAt(from) / 4) : (noteLen ?? cellLenAt(from));
    return [{ id: newNoteId(), pitch, start: Math.round(from * 1e9) / 1e9, duration: Math.max(0.01, len), velocity: Math.max(0.01, Math.min(1, noteVel)), ...(slideDraw && !isDrumMode ? { slide: true } : {}) }];
  };

  // --- OUTILS : accords, clavier d'ordinateur, fantômes ---
  const [chordKind, setChordKind] = useState<ChordKind | null>(null);
  const [chordInv, setChordInv] = useState(0);
  const [menu, setMenu] = useState<{ kind: 'scale' | 'chord'; x: number; y: number } | null>(null);
  const [lastChord, setLastChord] = useState<string | null>(null);
  useEffect(() => { if (!lastChord) return; const id = window.setTimeout(() => setLastChord(null), 4000); return () => window.clearTimeout(id); }, [lastChord]);
  const openMenu = (kind: 'scale' | 'chord', e: React.MouseEvent) => {
    if (menu?.kind === kind) { setMenu(null); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = 288;
    setMenu({ kind, x: Math.max(8, Math.min(window.innerWidth - w - 8, r.left)), y: r.bottom + 6 });
  };
  const getRowFromY = (y: number, scrollTop: number) => Math.max(0, Math.min(rows.length - 1, Math.floor((y + scrollTop) / currentRowHeight)));
  const getYFromPitch = (pitch: number) => rowOf(pitch) * currentRowHeight;
  const getTimeFromX = (x: number, scrollLeft: number) => (x + scrollLeft) / zoomX;

  // --- SYNC SCROLL ---
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target === containerRef.current) {
        if (keysRef.current) keysRef.current.scrollTop = target.scrollTop;
        if (velocityRef.current) velocityRef.current.scrollLeft = target.scrollLeft;
        if (rulerRef.current) rulerRef.current.scrollLeft = target.scrollLeft;
    }
  };

  const updateNotes = (newNotes: MidiNote[]) => {
      // Le clip s'allonge si des notes dépassent sa fin (pinceau, coller, dupliquer).
      const end = newNotes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
      const dur = end > clip.duration + 1e-6 ? Math.ceil(end / barSec - 1e-6) * barSec : clip.duration;
      onUpdateTrack({ ...track, clips: track.clips.map(c => c.id === clipId ? { ...c, notes: newNotes, duration: dur } : c) });
  };

  const deleteNotes = (ids: string[]) => {
      if (!ids.length) return;
      const set = new Set(ids);
      updateNotes((clip.notes || []).filter(n => !set.has(n.id)));
      setSelectedNoteIds(new Set());
  };

  // --- APERÇU DU SON (FL : preview, Live : Preview, Cubase : Acoustic Feedback) ---
  const playPreview = (pitch: number | number[]) => {
    if (!prefs.preview) return;
    const list = Array.isArray(pitch) ? pitch : [pitch];
    try {
      if (isDrumMode) list.forEach(p => audioEngine.triggerTrackAttack(track.id, p, 0.9));
      else list.forEach(p => audioEngine.previewMidiNote(track.id, p, 0.35));
    } catch { /* moteur pas encore prêt */ }
  };

  // --- POINTER HANDLERS (souris, doigt, stylet) ---
  // Au doigt, avec le crayon, un glissé sur la grille la fait défiler : on ne pose la
  // note qu'au relâchement, si le doigt n'a presque pas bougé.
  const pendingDrawRef = useRef<{ x: number; y: number; time: number; pitch: number; alt: boolean; shift: boolean } | null>(null);
  /** Pose une note (ou un accord avec le tampon) ; Maj (ou le mode glissé) : une note glissée, de la longueur des glissés. */
  const addNoteAt = (absTime: number, pitch: number, free = false, asSlide = false): MidiNote[] => {
    const start = Math.max(0, cellTime(absTime, free));
    const slideNote = !isDrumMode && !chordKind && (asSlide || slideDraw);
    const duration = isDrumMode ? Math.max(0.05, Math.min(cellLenAt(start), quarterAt(start) / 4))
      : slideNote ? (slideLen ?? cellLenAt(start)) : (noteLen ?? Math.max(cellLenAt(start), quarterAt(start) / 4));
    const mk = (p: number): MidiNote => ({ id: newNoteId(), pitch: p, start, duration, velocity: noteVel, ...(slideNote ? { slide: true } : {}) });
    // Tampon d'accord (Chord Stamp de FL) : toutes les notes de l'accord en un clic.
    if (chordKind && !isDrumMode) {
      const pitches = buildChord(pitch, chordKind, { root: hasKey ? keyRoot : undefined, scale: keyScale, snap: snapOn || chordKind === 'SCALE', inversion: chordInv });
      const notes = pitches.map(p => mk(p));
      updateNotes([...(clip.notes || []), ...notes]);
      setLastChord(chordLabelFr(pitches));
      playPreview(pitches);
      return notes;
    }
    const newNote = mk(snapOn ? snapToScale(pitch, keyRoot!, keyScale) : pitch);
    updateNotes([...(clip.notes || []), newNote]);
    playPreview(newNote.pitch);
    return [newNote];
  };
  /** Rend muettes (ou réactive) des notes : une écriture. */
  const setMuted = (ids: Set<string>, mute: boolean, base: MidiNote[] = clip.notes || []) => {
    updateNotes(base.map(n => {
      if (!ids.has(n.id)) return n;
      if (mute) return n.muted ? n : { ...n, muted: true };
      if (!n.muted) return n;
      const { muted, ...rest } = n; void muted;
      return rest;
    }));
  };
  const addNoteRef = useRef(addNoteAt);
  addNoteRef.current = addNoteAt;

  /** Note sous le pointeur (ligne affichée, pas seulement la hauteur : notes hors gamme repliées). */
  const noteAt = (absTime: number, row: number): MidiNote | undefined => {
    const list = clip.notes || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      if (rowOf(n.pitch) === row && absTime >= n.start && absTime <= n.start + Math.max(n.duration, 4 / zoomX)) return n;
    }
    return undefined;
  };

  const startBoxSelect = (e: React.PointerEvent, x: number, y: number, scrollLeft: number, scrollTop: number) => {
    if (!e.shiftKey && !e.ctrlKey) setSelectedNoteIds(new Set());
    setDragMode('SELECT');
    setDragStart({ x: e.clientX, y: e.clientY, time: 0, pitch: 0, row: 0 });
    setSelectionBox({ startX: x + scrollLeft, startY: y + scrollTop, endX: x + scrollLeft, endY: y + scrollTop });
  };

  const handleMouseDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (pinchRef.current) return;
    const isTouch = e.pointerType !== 'mouse';
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scrollLeft = containerRef.current.scrollLeft;
    const scrollTop = containerRef.current.scrollTop;

    const absTime = getTimeFromX(x, scrollLeft);
    const row = getRowFromY(y, scrollTop);
    const pitch = rows[row];
    const clickedNote = noteAt(absTime, row);

    // Clic droit (FL Studio) : efface la note, glisser efface tout le passage.
    // Clic droit dans le vide (sans glisser) : menu des notes, au relâchement.
    if (e.pointerType === 'mouse' && e.button === 2) {
        e.preventDefault();
        if (clickedNote) deleteNotes([clickedNote.id]);
        rightRef.current = { x: e.clientX, y: e.clientY, erased: !!clickedNote, t: absTime, row };
        setInitialNotes(clip.notes || []);
        setDragMode('ERASE');
        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        return;
    }

    if (tool === 'ERASE') {
        if (clickedNote) deleteNotes([clickedNote.id]);
        setDragMode('ERASE');
        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        return;
    }
    // Couteau : coupe au relâchement (une note, ou toutes celles du trait vertical).
    if (tool === 'SPLIT') {
        setDragMode('SLICE');
        setDragStart({ x: e.clientX, y: e.clientY, time: snapTime(absTime, e.altKey), pitch, row });
        return;
    }
    // Souder : la note rejoint la suivante de même hauteur ; dans le vide : encadrer.
    if (tool === 'GLUE' && clickedNote) {
        const res = glueWithNext(clip.notes || [], clickedNote.id);
        if (res.ok) { updateNotes(res.notes); setSelectedNoteIds(new Set([clickedNote.id])); playPreview(clickedNote.pitch); setLastChord('Notes soudées : une seule note tenue (Ctrl+Z pour annuler)'); }
        else setLastChord(`Rien à souder : aucune note ${noteNameFr(clickedNote.pitch)} plus loin`);
        return;
    }
    // Sourdine : clic ou glisser, l'état de la première note touchée décide (muette ↔ réactivée).
    if (tool === 'MUTE') {
        const mute = clickedNote ? !clickedNote.muted : true;
        muteDragRef.current = { seen: new Set(clickedNote ? [clickedNote.id] : []), mute };
        if (clickedNote) { setMuted(new Set([clickedNote.id]), mute); if (!mute) playPreview(clickedNote.pitch); }
        setDragMode('MUTE');
        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        return;
    }

    // Pinceau : peint des notes à la suite (une par case) en glissant.
    if (tool === 'PAINT' && !clickedNote) {
        const base = clip.notes || [];
        const p = snapOn ? snapToScale(pitch, keyRoot!, keyScale) : pitch;
        const first = followMap && magnet && !e.altKey
          ? paintOnMap(cellTime(absTime), p, base)
          : paintNotes({ from: cellTime(absTime, e.altKey), to: cellTime(absTime, e.altKey), pitch: p, step: magnet && !e.altKey ? grid : Math.max(grid, 0.05), length: isDrumMode ? Math.min(grid, beatSec / 4) : (noteLen ?? grid), velocity: noteVel, existing: base, slide: slideDraw && !isDrumMode });
        paintRef.current = { cells: new Set(first.map(n => (followMap ? paintKey(clipStart + n.start) : Math.round((clipStart + n.start) / grid)))), added: first, base };
        if (first.length) { updateNotes([...base, ...first]); playPreview(p); lastPreviewPitch.current = p; }
        setDragMode('PAINT');
        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        return;
    }

    // Crayon sur une case vide : pose une note (Ctrl+glisser = encadrer, comme dans FL).
    if ((tool === 'DRAW' || tool === 'PAINT') && !clickedNote) {
        if (e.ctrlKey || e.metaKey) { if (!isTouch) startBoxSelect(e, x, y, scrollLeft, scrollTop); return; }
        if (isTouch) { pendingDrawRef.current = { x: e.clientX, y: e.clientY, time: absTime, pitch, alt: e.altKey, shift: e.shiftKey }; return; }
        const added = addNoteAt(absTime, pitch, e.altKey, e.shiftKey);
        // Glisser après le clic allonge la note posée (longueur au tracé), l'accord entier avec le tampon.
        if (!isDrumMode && added.length) {
            const ids = new Set(added.map(n => n.id));
            setSelectedNoteIds(ids);
            setInitialNotes([...(clip.notes || []), ...added]);
            drawResizeRef.current = { id: added[0].id, moved: false, ids };
            setDragMode('RESIZE_R');
            setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        }
        return;
    }

    if (clickedNote) {
        // Double clic (ou double touche) sur une note : ses propriétés (hauteur, vélocité, longueur, glissé…).
        const now = performance.now();
        if (lastTap.current && lastTap.current.id === clickedNote.id && now - lastTap.current.t < 350) {
          lastTap.current = null;
          const ids = selectedNoteIds.has(clickedNote.id) && selectedNoteIds.size > 1 ? Array.from(selectedNoteIds) : [clickedNote.id];
          if (ids.length === 1) setSelectedNoteIds(new Set(ids));
          setDragMode(null); setDragStart(null);
          setPropsFor({ ids, x: e.clientX + 12, y: e.clientY + 12 });
          return;
        }
        lastTap.current = { id: clickedNote.id, t: now };
        // Sélection
        const newSelected = new Set(selectedNoteIds);
        if (!newSelected.has(clickedNote.id) && !e.ctrlKey && !e.shiftKey) {
            newSelected.clear();
            newSelected.add(clickedNote.id);
        } else if (e.ctrlKey) {
            if (newSelected.has(clickedNote.id)) newSelected.delete(clickedNote.id);
            else newSelected.add(clickedNote.id);
        } else {
             newSelected.add(clickedNote.id);
        }
        setSelectedNoteIds(newSelected);
        // Les prochaines notes prennent sa longueur et sa vélocité (FL Studio) ; un glissé règle la longueur des glissés.
        if (clickedNote.slide) setSlideLen(clickedNote.duration); else setNoteLen(clickedNote.duration);
        setNoteVel(clickedNote.velocity);

        // Poignée de durée : les 8 px de droite (16 px au doigt) ; une note courte se rallonge par son tiers droit (sa moitié au doigt).
        const edge = isTouch ? 16 : 8;
        const wPx = clickedNote.duration * zoomX;
        const fromEnd = (clickedNote.start + clickedNote.duration) * zoomX - absTime * zoomX;
        const isRightEdge = wPx > edge * 2 ? fromEnd < edge : fromEnd < wPx / (isTouch ? 2 : 3);

        setInitialNotes(clip.notes || []);
        copyDragRef.current = null;
        if (isRightEdge && !isDrumMode) setDragMode('RESIZE_R');
        else {
          setDragMode('MOVE');
          // Ctrl / Maj tenu : si la souris bouge, on emporte une COPIE (la note cliquée comprise).
          if (e.ctrlKey || e.shiftKey || e.metaKey) copyDragRef.current = { ids: new Set([...newSelected, clickedNote.id]), copies: null, base: clip.notes || [] };
        }

        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        lastPreviewPitch.current = clickedNote.pitch;
        playPreview(clickedNote.pitch);
    }
    else {
        if (isTouch && tool !== 'SELECT') { if (!e.shiftKey) setSelectedNoteIds(new Set()); return; } // au doigt : glisser fait défiler la grille
        startBoxSelect(e, x, y, scrollLeft, scrollTop);
    }
  };

  const handleMouseMove = useCallback((e: PointerEvent) => {
    if (!dragMode || !dragStart || !containerRef.current) return;

    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const deltaTime = dx / zoomX;
    const deltaRows = Math.round(-dy / currentRowHeight);
    const rect = containerRef.current.getBoundingClientRect();
    const scrollLeft = containerRef.current.scrollLeft;
    const scrollTop = containerRef.current.scrollTop;
    const absTime = getTimeFromX(e.clientX - rect.left, scrollLeft);
    const row = getRowFromY(e.clientY - rect.top, scrollTop);

    if (dragMode === 'MOVE') {
        let previewPitch: number | null = null;
        const cd = copyDragRef.current;
        if (cd && !cd.copies && Math.hypot(dx, dy) > 4) {
            const res = copyForDrag(cd.base, cd.ids);
            cd.copies = res.copies;
            cd.base = res.notes;
        }
        const moving = cd?.copies ? new Set(cd.copies.values()) : selectedNoteIds;
        const updatedNotes = (cd?.copies ? cd.base : initialNotes).map(n => {
            if (moving.has(n.id)) {
                const newStart = snapTime(n.start + deltaTime, e.altKey);
                const p = shiftPitch(n.pitch, deltaRows);
                if (previewPitch === null) previewPitch = p;
                return { ...n, start: Math.max(0, newStart), pitch: p };
            }
            return n;
        });
        updateNotes(updatedNotes);
        // Aperçu quand la hauteur change (Cubase : Acoustic Feedback).
        if (previewPitch !== null && previewPitch !== lastPreviewPitch.current) { lastPreviewPitch.current = previewPitch; playPreview(previewPitch); }
    }
    else if (dragMode === 'RESIZE_R') {
        let len: number | null = null;
        let lenSlide = false;
        const dr = drawResizeRef.current;
        if (dr && Math.abs(dx) > 3) dr.moved = true;
        const updatedNotes = initialNotes.map(n => {
            // Note (ou accord) qu'on vient de poser : sa fin suit la souris (FL Studio), au moins une case.
            if (dr && (dr.id === n.id || dr.ids?.has(n.id))) {
                if (!dr.moved) return n;
                const free = e.altKey || !magnet;
                const end = free ? absTime : snapTime(absTime);
                const d = Math.max(free ? 0.02 : minLenAt(n.start), end - n.start);
                len = d; lenSlide = !!n.slide;
                return { ...n, duration: d };
            }
            if (selectedNoteIds.has(n.id)) {
                let newDuration = Math.max(0.02, n.duration + deltaTime);
                const free = e.altKey || !magnet;
                if (!free) newDuration = Math.max(minLenAt(n.start), snapTime(n.start + newDuration) - n.start);
                len = newDuration; lenSlide = !!n.slide;
                return { ...n, duration: newDuration };
            }
            return n;
        });
        updateNotes(updatedNotes);
        if (len !== null) { if (lenSlide) setSlideLen(len); else setNoteLen(len); }
    }
    else if (dragMode === 'PAINT' && paintRef.current) {
        const pr = paintRef.current;
        const step = grid;
        const cell = paintKey(clipStart + absTime);
        if (absTime >= 0 && !pr.cells.has(cell)) {
            pr.cells.add(cell);
            const raw = rows[row];
            const p = snapOn ? snapToScale(raw, keyRoot!, keyScale) : raw;
            const [n] = followMap
              ? paintOnMap(cellTime(absTime), p, pr.base)
              : paintNotes({ from: cell * step - clipStart, to: cell * step - clipStart, pitch: p, step, length: isDrumMode ? Math.min(grid, beatSec / 4) : (noteLen ?? grid), velocity: noteVel, existing: pr.base, slide: slideDraw && !isDrumMode });
            if (n) {
              pr.added = [...pr.added, n];
              updateNotes([...pr.base, ...pr.added]);
              if (p !== lastPreviewPitch.current || isDrumMode) { lastPreviewPitch.current = p; playPreview(p); }
            }
        }
    }
    else if (dragMode === 'ERASE') {
        const hit = noteAt(absTime, row);
        if (hit) { deleteNotes([hit.id]); if (rightRef.current) rightRef.current.erased = true; }
        if (rightRef.current && Math.hypot(e.clientX - rightRef.current.x, e.clientY - rightRef.current.y) > 5) rightRef.current.erased = true;
    }
    else if (dragMode === 'MUTE' && muteDragRef.current) {
        const hit = noteAt(absTime, row);
        const md = muteDragRef.current;
        if (hit && !md.seen.has(hit.id)) { md.seen.add(hit.id); setMuted(new Set([hit.id]), md.mute); }
    }
    else if (dragMode === 'SELECT') {
        const curX = e.clientX - rect.left + scrollLeft;
        const curY = e.clientY - rect.top + scrollTop;
        const box = {
            startX: Math.min(selectionBox!.startX, curX),
            endX: Math.max(selectionBox!.startX, curX),
            startY: Math.min(selectionBox!.startY, curY),
            endY: Math.max(selectionBox!.startY, curY)
        };
        setSelectionBox({ startX: selectionBox!.startX, startY: selectionBox!.startY, endX: curX, endY: curY });
        const newSelection = new Set<string>(e.shiftKey ? selectedNoteIds : []);
        (clip.notes || []).forEach(n => {
            const nx = n.start * zoomX;
            const ny = getYFromPitch(n.pitch);
            const nw = n.duration * zoomX;
            if (nx < box.endX && nx + nw > box.startX && ny < box.endY && ny + currentRowHeight > box.startY) newSelection.add(n.id);
        });
        setSelectedNoteIds(newSelection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragMode, dragStart, initialNotes, selectedNoteIds, zoomX, grid, magnet, bpm, selectionBox, clip.notes, currentRowHeight, rows, noteLen, noteVel, slideDraw, prefs.preview, snapTime, snapOn, foldOn, anyFold, rows, keyRoot, keyScale]);

  const handleMouseUp = (e?: Event) => {
    const pending = pendingDrawRef.current;
    pendingDrawRef.current = null;
    if (pending && e && e.type === 'pointerup' && !pinchRef.current) {
        const pe = e as PointerEvent;
        if (Math.hypot(pe.clientX - pending.x, pe.clientY - pending.y) < 10) addNoteRef.current(pending.time, pending.pitch, pending.alt, pending.shift);
    }
    if (dragMode === 'SLICE' && dragStart && containerRef.current && e && e.type === 'pointerup') {
        const pe = e as PointerEvent;
        const rect = containerRef.current.getBoundingClientRect();
        const row2 = getRowFromY(pe.clientY - rect.top, containerRef.current.scrollTop);
        const lo = Math.min(dragStart.row, row2), hi = Math.max(dragStart.row, row2);
        const t = dragStart.time;
        let notes = clip.notes || [];
        let cut = 0;
        const ids = new Set<string>();
        for (const n of notes) {
          const r = rowOf(n.pitch);
          if (r < lo || r > hi || !(t > n.start && t < n.start + n.duration)) continue;
          const res = splitNoteAt(notes, n.id, t);
          if (res.newId) { notes = res.notes; cut++; ids.add(n.id); ids.add(res.newId); }
        }
        if (cut) { updateNotes(notes); setSelectedNoteIds(ids); setLastChord(`${cut} note${cut > 1 ? 's' : ''} coupée${cut > 1 ? 's' : ''} en deux (Ctrl+Z pour annuler)`); }
    }
    if (dragMode === 'PAINT' && paintRef.current) {
        const k = paintRef.current.added.length;
        if (k > 1) setLastChord(`${k} notes peintes (Ctrl+Z pour annuler)`);
        paintRef.current = null;
    }
    // Une note posée au crayon n'est pas laissée sélectionnée (FL) : « Glissé », « Q »… visent la sélection voulue.
    if (drawResizeRef.current) { drawResizeRef.current = null; setSelectedNoteIds(new Set()); }
    // Glisser-copier : les copies deviennent la sélection.
    const cd = copyDragRef.current;
    copyDragRef.current = null;
    if (cd?.copies && cd.copies.size) {
        setSelectedNoteIds(new Set(cd.copies.values()));
        setLastChord(`${cd.copies.size} note${cd.copies.size > 1 ? 's' : ''} copiée${cd.copies.size > 1 ? 's' : ''} en glissant (Ctrl+Z pour annuler)`);
    }
    // Clic droit sans glisser, dans le vide : le menu des notes.
    const rr = rightRef.current;
    rightRef.current = null;
    if (rr && !rr.erased && e && e.type === 'pointerup') {
        const pe = e as PointerEvent;
        if (Math.hypot(pe.clientX - rr.x, pe.clientY - rr.y) <= 5) setDropdown({ name: 'ctx', x: pe.clientX + 2, y: pe.clientY + 2, t: rr.t, row: rr.row });
    }
    muteDragRef.current = null;
    lastPreviewPitch.current = null;
    setDragMode(null);
    setDragStart(null);
    setSelectionBox(null);
  };

  useEffect(() => {
      window.addEventListener('pointermove', handleMouseMove);
      window.addEventListener('pointerup', handleMouseUp);
      window.addEventListener('pointercancel', handleMouseUp);
      return () => {
          window.removeEventListener('pointermove', handleMouseMove);
          window.removeEventListener('pointerup', handleMouseUp);
          window.removeEventListener('pointercancel', handleMouseUp);
      };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleMouseMove, dragMode, dragStart]);

  // --- MOLETTE : défiler ; Ctrl + molette = zoom horizontal (centré sur la souris) ; Alt + molette
  // (ou Ctrl + Maj) = zoom vertical ; Maj + Alt + molette sur une note = vélocité ; pincer au téléphone.
  const zoomRef = useRef({ zoomX, rowH });
  zoomRef.current = { zoomX, rowH };
  const rowLimits = isDrumMode ? [16, 44] : [8, 32];
  const setZoomAt = useCallback((nextZoom: number, anchorClientX?: number) => {
    const el = containerRef.current;
    const z0 = zoomRef.current.zoomX;
    const z = Math.max(20, Math.min(600, nextZoom));
    if (el && anchorClientX !== undefined) {
      const r = el.getBoundingClientRect();
      const px = anchorClientX - r.left;
      const t = (px + el.scrollLeft) / z0;
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, t * z - px); });
    }
    setZoomX(z);
  }, []);
  const setRowHAt = useCallback((h: number) => {
    const el = containerRef.current;
    const h0 = zoomRef.current.rowH;
    const n = Math.max(rowLimits[0], Math.min(rowLimits[1], Math.round(h)));
    if (el) { const mid = el.scrollTop + el.clientHeight / 2; requestAnimationFrame(() => { el.scrollTop = Math.max(0, mid / h0 * n - el.clientHeight / 2); }); }
    setRowH(n);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrumMode]);
  /** Zoom sur la sélection (sinon sur toutes les notes) : horizontal et vertical. */
  const zoomToSel = () => {
    const el = containerRef.current;
    const all = clip.notes || [];
    const list = selectedNoteIds.size ? all.filter(n => selectedNoteIds.has(n.id)) : all;
    if (!el || !list.length) { setLastChord('Pas de notes à cadrer : pose d’abord des notes.'); return; }
    const t0 = Math.min(...list.map(n => n.start)), t1 = Math.max(...list.map(n => n.start + n.duration));
    const rs = list.map(n => rowOf(n.pitch));
    const f = fitView({ t0, t1, rowTop: Math.min(...rs), rowBottom: Math.max(...rs), viewW: el.clientWidth, viewH: el.clientHeight, zoomMin: 20, zoomMax: 600, rowMin: rowLimits[0], rowMax: rowLimits[1] });
    setZoomX(f.zoomX); setRowH(f.rowH);
    requestAnimationFrame(() => requestAnimationFrame(() => { el.scrollLeft = f.scrollLeft; el.scrollTop = f.scrollTop; }));
    setLastChord(selectedNoteIds.size ? `Zoom sur ${countLabel(list.length, 'sélectionnée')}` : 'Zoom sur toutes les notes du clip');
  };
  /** Tout le clip à l'écran (largeur). */
  const zoomToClip = () => {
    const el = containerRef.current;
    if (!el || !clip) return;
    setZoomX(Math.max(20, Math.min(600, (el.clientWidth - 24) / Math.max(0.1, clip.duration))));
    requestAnimationFrame(() => { el.scrollLeft = 0; });
  };
  const notesRef = useRef<MidiNote[]>([]);
  notesRef.current = clip?.notes || [];
  const wheelVelRef = useRef<(e: WheelEvent) => boolean>(() => false);
  wheelVelRef.current = (e: WheelEvent) => {
    const el = containerRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const t = (e.clientX - r.left + el.scrollLeft) / zoomRef.current.zoomX;
    const row = getRowFromY(e.clientY - r.top, el.scrollTop);
    const hit = noteAt(t, row);
    if (!hit) return false;
    const ids = selectedNoteIds.has(hit.id) ? selectedNoteIds : new Set([hit.id]);
    // Maj + molette : Windows donne souvent un défilement horizontal (deltaX).
    const d = (e.deltaY || e.deltaX) < 0 ? 0.04 : -0.04;
    updateNotes(notesRef.current.map(n => (ids.has(n.id) ? { ...n, velocity: Math.max(0.01, Math.min(1, n.velocity + d)) } : n)));
    setLastChord(`Vélocité ${Math.round(Math.max(0.01, Math.min(1, hit.velocity + d)) * 127)} (Maj + Alt + molette)`);
    return true;
  };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey && e.shiftKey) { e.preventDefault(); wheelVelRef.current(e); return; }
      const dy = e.deltaY || e.deltaX;
      if (e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setRowHAt(zoomRef.current.rowH * Math.exp(-dy * 0.002)); return; }
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const f = Math.exp(-dy * 0.0015);
      if (e.shiftKey) setRowHAt(zoomRef.current.rowH * f);
      else setZoomAt(zoomRef.current.zoomX * f, e.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoomAt, setRowHAt]);

  // Pincer (deux doigts) : écart horizontal = zoom horizontal, écart vertical = hauteur des lignes.
  const pinchRef = useRef<{ dx: number; dy: number; z: number; h: number; cx: number } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const spread = (t: TouchList) => ({ dx: Math.abs(t[0].clientX - t[1].clientX), dy: Math.abs(t[0].clientY - t[1].clientY), cx: (t[0].clientX + t[1].clientX) / 2 });
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const s = spread(e.touches);
      pinchRef.current = { dx: s.dx, dy: s.dy, z: zoomRef.current.zoomX, h: zoomRef.current.rowH, cx: s.cx };
      pendingDrawRef.current = null;
    };
    const onMove = (e: TouchEvent) => {
      const p = pinchRef.current;
      if (!p || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const s = spread(e.touches);
      if (p.dx > 30) setZoomAt(p.z * (s.dx / p.dx), p.cx);
      if (p.dy > 30) setRowHAt(p.h * (s.dy / p.dy));
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2 && pinchRef.current) window.setTimeout(() => { pinchRef.current = null; }, 60); };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd); };
  }, [setZoomAt, setRowHAt]);

  /** Notes muettes (Pro Tools : Mute Notes) : gardées, grisées, jamais jouées ni exportées. */
  const toggleMuteNotes = (ids: string[] = Array.from(selectedNoteIds)) => {
      const set = new Set(ids);
      const target = (clip.notes || []).filter(n => set.has(n.id));
      if (!target.length) { setLastChord('Sélectionne des notes, puis Ctrl+M (ou l’outil Sourdine, T) pour les rendre muettes.'); return; }
      const mute = target.some(n => !n.muted);
      updateNotes((clip.notes || []).map(n => {
        if (!set.has(n.id)) return n;
        if (mute) return { ...n, muted: true };
        const { muted, ...rest } = n; void muted;
        return rest;
      }));
      const k = target.length, pl = k > 1 ? 's' : '';
      setLastChord(mute ? `${k} note${pl} muette${pl} : gardée${pl}, grisée${pl}, jamais jouée${pl} (Ctrl+Z pour annuler)` : `${k} note${pl} réactivée${pl} (Ctrl+Z pour annuler)`);
  };
  /** Couloirs (R16) : contrôleurs du clip, une étape d'annulation par geste. */
  const updateClipCc = (key: string, points: MidiCcPoint[], label: string) => {
      const next = { ...(clip.cc || {}) };
      if (points.length) next[key] = points; else delete next[key];
      onUpdateTrack({ ...track, clips: track.clips.map(c => (c.id === clipId ? { ...c, cc: Object.keys(next).length ? next : undefined } : c)) });
      setLastChord(`${label} (Ctrl+Z pour annuler)`);
  };

  // --- QUANTIFICATION : force, swing, fins (Live : Quantize Settings, Logic : Q-Strength / Q-Swing) ---
  const applyQuantize = useCallback(() => {
    const all = clip.notes || [];
    if (!all.length) { setLastChord('Rien à quantifier : pose d’abord des notes.'); return; }
    const sel = selectedNoteIds.size > 0 ? selectedNoteIds : null;
    const next = quantizeTool(all, sel, { bpm, clipStart }, { grid: gridId, strength: quantizeStrength / 100, swing: quantizeSwing, ends: quantizeEnds });
    const k = sel ? sel.size : all.length;
    // Déjà sur la grille : rien n'est écrit (avant, une étape d'annulation vide : Ctrl+Z « ne faisait rien »).
    const byId = new Map(all.map(n => [n.id, n]));
    if (next.length === all.length && next.every(n => { const o = byId.get(n.id); return !!o && Math.abs(o.start - n.start) < 1e-6 && Math.abs(o.duration - n.duration) < 1e-6; })) {
      setLastChord(`${k > 1 ? 'Les notes sont déjà' : 'La note est déjà'} sur la grille ${GRID_CHOICES.find(g => g.id === gridId)?.label}.`);
      return;
    }
    updateNotes(next);
    setLastChord(`${k} note${k > 1 ? 's' : ''} quantifiée${k > 1 ? 's' : ''} sur ${GRID_CHOICES.find(g => g.id === gridId)?.label} · force ${quantizeStrength} %${quantizeSwing > 50 ? ` · swing ${quantizeSwing} %` : ''} (Ctrl+Z pour annuler)`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, gridId, quantizeStrength, quantizeSwing, quantizeEnds, bpm, clip.notes, clipStart]);

  // --- SELECT ALL ---
  const selectAll = useCallback(() => {
    setSelectedNoteIds(new Set((clip.notes || []).map(n => n.id)));
  }, [clip.notes]);

  // --- DUPLIQUER À LA SUITE (FL : Ctrl+B, Live : Ctrl+D) ---
  const doubleNotes = useCallback(() => {
    if (selectedNoteIds.size === 0) { setLastChord('Sélectionne des notes (Ctrl+A : tout), puis Ctrl+D pour les recopier à la suite.'); return; }
    const res = duplicateRight(clip.notes || [], selectedNoteIds, grid, barSec);
    updateNotes(res.notes);
    setSelectedNoteIds(new Set(res.added.map(n => n.id)));
    setLastChord(`${res.added.length} note${res.added.length > 1 ? 's' : ''} recopiée${res.added.length > 1 ? 's' : ''} à la suite (Ctrl+Z pour annuler)`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, clip.notes, grid, barSec]);

  // --- COPIER / COUPER / COLLER ---
  const copySel = (cut = false) => {
    const cb = copyNotes(clip.notes || [], selectedNoteIds);
    if (!cb) { setLastChord('Sélectionne des notes à copier.'); return; }
    noteClipboard = cb;
    if (cut) deleteNotes(Array.from(selectedNoteIds));
    setLastChord(`${cb.notes.length} note${cb.notes.length > 1 ? 's' : ''} ${cut ? 'coupée' : 'copiée'}${cb.notes.length > 1 ? 's' : ''} : Ctrl+V pour coller à la tête de lecture`);
  };
  const paste = (where?: number) => {
    if (!noteClipboard) { setLastChord('Rien à coller : copie d’abord des notes (Ctrl+C).'); return; }
    const head = audioEngine.getCurrentTime() - clipStart;
    const all = clip.notes || [];
    // Clic droit : là où on a cliqué ; sinon à la tête de lecture si elle est dans le clip, sinon après la dernière note (à la mesure).
    const after = all.length ? Math.ceil(Math.max(...all.map(n => n.start + n.duration)) / barSec - 1e-6) * barSec : 0;
    const at = typeof where === 'number' ? cellTime(where) : head >= 0 && head < clip.duration ? snapTime(head) : after;
    const res = pasteNotes(all, noteClipboard, Math.max(0, at));
    updateNotes(res.notes);
    setSelectedNoteIds(new Set(res.added.map(n => n.id)));
    setLastChord(`${res.added.length} note${res.added.length > 1 ? 's' : ''} collée${res.added.length > 1 ? 's' : ''} (Ctrl+Z pour annuler)`);
  };

  // --- DÉPLACER LA SÉLECTION D'UNE CASE (← / →, Live) ---
  const nudge = (dir: number) => {
    if (!selectedNoteIds.size) return;
    updateNotes((clip.notes || []).map(n => (selectedNoteIds.has(n.id) ? { ...n, start: Math.max(0, followMap ? snapTime(n.start + dir * cellLenAt(dir < 0 ? n.start - 1e-6 : n.start)) : n.start + dir * grid) } : n)));
  };

  // --- LONGUEUR AU CLAVIER (Maj + ← / →) et LEGATO (Ctrl+L) ---
  const resizeSel = (dir: number) => {
    if (!selectedNoteIds.size) { setLastChord('Sélectionne des notes, puis Maj + → / ← pour les allonger ou les raccourcir.'); return; }
    const cell = followMap ? cellLenAt(0) : grid;
    updateNotes(resizeNotesBy(clip.notes || [], selectedNoteIds, dir * cell, cell));
  };
  const legatoSel = () => {
    const all = clip.notes || [];
    if (all.length < 2) { setLastChord('Legato : il faut au moins deux notes.'); return; }
    const sel = selectedNoteIds.size > 0 ? selectedNoteIds : null;
    updateNotes(legatoTool(all, sel, { bpm, clipStart }));
    setLastChord(`Legato : ${sel ? 'les notes sélectionnées s’allongent' : 'chaque note s’allonge'} jusqu’à la suivante (Ctrl+Z pour annuler)`);
  };

  // --- TRANSPOSE (inspired by Logic Pro) ---
  const transpose = useCallback((semitones: number) => {
    if (selectedNoteIds.size === 0) return;
    let first: number | null = null;
    const transposedNotes = (clip.notes || []).map(note => {
      if (!selectedNoteIds.has(note.id)) return note;
      const newPitch = note.pitch + semitones;
      let p: number;
      if (isDrumMode) p = Math.max(60, Math.min(89, newPitch));
      // Aimant de gamme : ↑ / ↓ passent à la note de gamme suivante (comme Live en Scale Mode).
      else if (snapOn && Math.abs(semitones) < 12) p = Math.max(0, Math.min(127, snapToScale(newPitch, keyRoot!, keyScale, semitones > 0 ? 'up' : 'down')));
      else p = Math.max(0, Math.min(127, newPitch));
      if (first === null) first = p;
      return { ...note, pitch: p };
    });
    updateNotes(transposedNotes);
    if (first !== null) playPreview(first);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, clip.notes, isDrumMode, snapOn, keyRoot, keyScale, prefs.preview]);

  /** Ramène les notes (sélection, sinon tout le clip) dans la gamme : une seule étape d'annulation. */
  const fitToScale = useCallback(() => {
    if (!hasKey) return;
    const all = clip.notes || [];
    const target = selectedNoteIds.size > 0 ? selectedNoteIds : new Set(all.map(n => n.id));
    let moved = 0;
    const next = all.map(n => {
      if (!target.has(n.id)) return n;
      const p = snapToScale(n.pitch, keyRoot!, keyScale);
      if (p !== n.pitch) moved++;
      return p === n.pitch ? n : { ...n, pitch: p };
    });
    if (moved > 0) updateNotes(next);
    setLastChord(moved > 0 ? `${moved} note${moved > 1 ? 's' : ''} remise${moved > 1 ? 's' : ''} dans la gamme` : 'Toutes les notes sont déjà dans la gamme');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, clip.notes, selectedNoteIds, keyRoot, keyScale]);

  // --- HUMANISER : ±12 ms, ±8 % de vélocité, ±5 % de longueur ; un accord bouge d'un bloc ---
  const humanizeNotes = useCallback((level: HumanizeLevel = 'moyen') => {
    const all = clip.notes || [];
    if (!all.length) return;
    const sel = selectedNoteIds.size > 0 ? selectedNoteIds : null;
    const h = HUMANIZE[level] || HUMANIZE.moyen;
    updateNotes(humanize(all, sel, { timingMs: h.timingMs, velocity: h.velocity, length: h.length, seed: Date.now() & 0xffffff }));
    const k = sel ? sel.size : all.length;
    setLastChord(`${k} note${k > 1 ? 's' : ''} humanisée${k > 1 ? 's' : ''} (${h.label}) : ±${h.timingMs} ms, ±${Math.round(h.velocity * 127)} de vélocité (Ctrl+Z pour annuler)`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, clip.notes]);

  // --- TRANSFORMATIONS DU QUOTIDIEN (sélection, sinon tout le clip ; une écriture chacune) ---
  const selOrAll = () => (selectedNoteIds.size > 0 ? selectedNoteIds : null);
  const countLabel = (k: number, word: string) => `${k} note${k > 1 ? 's' : ''} ${word}${k > 1 ? 's' : ''}`;
  /** Souder (FL : Glue) : les notes de même hauteur qui se touchent n'en font plus qu'une. */
  const glueSel = () => {
    const res = glueNotes(clip.notes || [], selOrAll());
    if (!res.merged) { setLastChord('Rien à souder : il faut des notes de même hauteur qui se touchent (ou l’outil Souder, G).'); return; }
    updateNotes(res.notes);
    setSelectedNoteIds(new Set());
    setLastChord(`${res.merged} soudure${res.merged > 1 ? 's' : ''} : les notes qui se suivent n’en font plus qu’une (Ctrl+Z pour annuler)`);
  };
  /** Épaissir : la même note une octave au-dessus (ou au-dessous). */
  const thickenSel = (semis: number) => {
    const res = thicken(clip.notes || [], selOrAll(), semis);
    if (!res.added.length) { setLastChord('Rien à épaissir : pose ou sélectionne d’abord des notes.'); return; }
    updateNotes(res.notes);
    setSelectedNoteIds(new Set(res.added.map(n => n.id)));
    playPreview(res.added.slice(0, 4).map(n => n.pitch));
    setLastChord(`${countLabel(res.added.length, 'ajoutée')} une octave ${semis > 0 ? 'au-dessus' : 'au-dessous'} (Ctrl+Z pour annuler)`);
  };
  /** Miroir : la mélodie à l'envers en hauteur (dans la gamme) ; rétrograde : à l'envers dans le temps. */
  const mirrorSel = (kind: 'pitch' | 'time') => {
    const all = clip.notes || [];
    if (!all.length) { setLastChord('Pas encore de notes à retourner.'); return; }
    const sel = selOrAll();
    updateNotes(kind === 'pitch' ? invertTool(all, sel, toolCtx) : retrogradeTool(all, sel));
    setLastChord(kind === 'pitch' ? 'Miroir : les notes montent là où elles descendaient (dans la gamme) (Ctrl+Z pour annuler)' : 'Rétrograde : la phrase jouée à l’envers (Ctrl+Z pour annuler)');
  };

  // --- GLISSÉS (FL : Slide notes) ---
  const slideAction = () => {
    if (isDrumMode) return;
    if (selectedNoteIds.size > 0) {
      const res = toggleSlide(clip.notes || [], selectedNoteIds);
      updateNotes(res.notes);
      setSlideDraw(false);
      setLastChord(res.on
        ? `${res.count} note${res.count > 1 ? 's' : ''} glissée${res.count > 1 ? 's' : ''} : posée${res.count > 1 ? 's' : ''} pendant une note tenue, ${res.count > 1 ? 'elles la font' : 'elle la fait'} glisser jusqu'à ${res.count > 1 ? 'leur' : 'sa'} hauteur (Ctrl+Z pour annuler)`
        : `${res.count} note${res.count > 1 ? 's' : ''} redevenue${res.count > 1 ? 's' : ''} normale${res.count > 1 ? 's' : ''}`);
      return;
    }
    setSlideDraw(v => !v);
    setLastChord(!slideDraw ? 'Glissés : les notes que tu poses glissent depuis la note tenue (pose-les pendant une note longue, comme une 808 qui glisse).' : 'Glissés coupés : notes normales.');
  };

  // --- BOUCLE DU CLIP ---
  const clipEndAbs = clipStart + (clip?.duration || 0);
  const loopOnClip = !!loop && loop.active && Math.abs(loop.start - clipStart) < 1e-3 && Math.abs(loop.end - clipEndAbs) < 1e-3;
  const toggleClipLoop = () => {
    if (!onSetLoop || !clip) return;
    if (loopOnClip) { onSetLoop(loop!.start, loop!.end, false); setLastChord('Boucle coupée'); return; }
    onSetLoop(clipStart, clipEndAbs, true);
    setLastChord('Le clip tourne en boucle pendant la lecture');
  };

  // --- CLAVIER DE L'ORDINATEUR (Computer MIDI Keyboard de Live, Typing Keyboard de FL) ---
  // Partagé avec toute l'appli (R16, components/MidiInputHost) : le piano roll impose seulement sa piste.
  useComputerKeyboard();
  const kbOn = computerKeyboardStore.on;
  const kbState = computerKeyboardStore.state;
  const setKbOn = (v: boolean | ((x: boolean) => boolean)) => computerKeyboardStore.setOn(typeof v === 'function' ? v(computerKeyboardStore.on) : v, true);
  /** Notes tenues sur cette piste (clavier de l'ordinateur ou clavier MIDI). */
  const [heldPitches, setHeldPitches] = useState<number[]>([]);
  const heldRef = useRef(new Set<number>());
  const [recArmed, setRecArmed] = useState(false);
  const [recPreview, setRecPreview] = useState<{ pitch: number; start: number; duration: number; velocity: number }[]>([]);
  const [keyLabels, setKeyLabels] = useState<Record<string, string>>({});
  const recRef = useRef<NoteRecorder | null>(null);
  // Dernières valeurs pour les écouteurs clavier (sans les ré-enregistrer à chaque rendu).
  const liveRef = useRef({ track, clip, isPlaying: !!isPlaying, inputQuant: !!prefs.inputQuant, snap: (t: number) => snapTime(t) });
  liveRef.current = { track, clip, isPlaying: !!isPlaying, inputQuant: !!prefs.inputQuant, snap: (t: number) => snapTime(t) };

  // Le clavier de l'ordinateur et le clavier MIDI jouent sur la piste ouverte ici.
  useEffect(() => {
    computerKeyboardStore.forcedTrackId = track.id;
    midiInput.setContext({ focusTrackId: track.id });
    return () => {
      if (computerKeyboardStore.forcedTrackId === track.id) computerKeyboardStore.forcedTrackId = null;
      // Allumé depuis le piano roll : il s'éteint en le fermant (les lettres retrouvent leurs raccourcis).
      if (computerKeyboardStore.on && computerKeyboardStore.fromRoll) computerKeyboardStore.setOn(false);
      if (midiInput.getContext().focusTrackId === track.id) midiInput.setContext({ focusTrackId: null });
    };
  }, [track.id]);

  // Lettres du clavier RÉEL (AZERTY : Q S D F… au lieu de A S D F…) quand le navigateur les donne.
  useEffect(() => {
    if (!kbOn) return;
    const kb: any = (navigator as any).keyboard;
    if (!kb?.getLayoutMap) return;
    kb.getLayoutMap().then((m: Map<string, string>) => {
      const out: Record<string, string> = {};
      [...Object.keys(KEY_TO_SEMITONE), 'KeyZ', 'KeyX', 'KeyC', 'KeyV'].forEach(c => { const v = m.get(c); if (v) out[c] = v.toUpperCase(); });
      setKeyLabels(out);
    }).catch(() => {});
  }, [kbOn]);
  const keyLabel = (code: string) => keyLabels[code] || defaultKeyLabel(code);

  /** Temps de la tête de lecture dans le clip (s). */
  const clipTimeNow = () => audioEngine.getCurrentTime() - liveRef.current.clip.start;

  /** Écrit la prise dans le clip : une seule étape d'annulation. */
  const commitRecording = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    let played = rec.finish(clipTimeNow()).filter(n => n.start >= 0);
    // Quantification d'entrée (Live : Record Quantization) : la prise commence sur la grille.
    if (liveRef.current.inputQuant) played = quantizeInput(played, t => liveRef.current.snap(t), 0.02);
    setRecPreview([]);
    if (!played.length) return;
    const { track: t, clip: c } = liveRef.current;
    const notes: MidiNote[] = played.map(n => ({
      id: newNoteId(),
      pitch: n.pitch, start: n.start, duration: n.duration, velocity: Math.max(0.05, Math.min(1, n.velocity / 127)),
    }));
    const end = Math.max(...notes.map(n => n.start + n.duration));
    onUpdateTrack({ ...t, clips: t.clips.map(x => x.id === c.id ? { ...x, notes: [...(x.notes || []), ...notes], duration: Math.max(x.duration, end) } : x) });
    setLastChord(`${notes.length} note${notes.length > 1 ? 's' : ''} enregistrée${notes.length > 1 ? 's' : ''} (Ctrl+Z pour annuler)`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onUpdateTrack]);

  // La prise démarre avec la lecture et s'écrit à l'arrêt.
  useEffect(() => {
    if (recArmed && isPlaying && !recRef.current) recRef.current = new NoteRecorder();
    if ((!isPlaying || !recArmed) && recRef.current) commitRecording();
  }, [recArmed, isPlaying, commitRecording]);
  useEffect(() => () => { commitRecording(); }, [commitRecording]);

  // Affichage des notes en cours de prise.
  useEffect(() => {
    if (!recArmed || !isPlaying) return;
    const id = window.setInterval(() => { if (recRef.current) setRecPreview(recRef.current.pending(clipTimeNow())); }, 80);
    return () => window.clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recArmed, isPlaying]);

  // --- SAISIE PAS À PAS (Pro Tools : MIDI Step Input, FL : Step recording) ---
  const [stepOn, setStepOn] = useState(false);
  const [stepValueId, setStepValueId] = useState('1/16');
  const [stepPos, setStepPos] = useState(0);
  const [chordHold, setChordHold] = useState(false);
  const [stepFixedVel, setStepFixedVel] = useState(false);
  const stepRef = useRef<StepInput | null>(null);
  const stepQueue = useRef<{ add?: MidiNote[]; remove?: string[] }[]>([]);
  const stepRaf = useRef(0);
  const stepValue = STEP_VALUES.find(v => v.id === stepValueId) || STEP_VALUES[4];
  useEffect(() => {
    if (!stepOn) { stepRef.current = null; return; }
    const rel = Math.max(0, audioEngine.getCurrentTime() - clip.start);
    const st = new StepInput({ step: stepSeconds(stepValue, bpm), pos: rel <= clip.duration ? rel : 0, prefix: `st-${Date.now().toString(36)}` });
    st.chordHold = chordHold;
    st.fixedVelocity = stepFixedVel ? 100 : null;
    stepRef.current = st;
    setStepPos(st.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepOn]);
  useEffect(() => { if (stepRef.current) stepRef.current.step = stepSeconds(stepValue, bpm); }, [stepValue, bpm]);
  useEffect(() => { if (stepRef.current) stepRef.current.chordHold = chordHold; }, [chordHold]);
  useEffect(() => { if (stepRef.current) stepRef.current.fixedVelocity = stepFixedVel ? 100 : null; }, [stepFixedVel]);
  /** Les pas arrivent vite (accords) : on les écrit ensemble, une étape d'annulation par image. */
  const flushSteps = () => {
    stepRaf.current = 0;
    const q = stepQueue.current;
    stepQueue.current = [];
    if (!q.length) return;
    const { track: t, clip: c } = liveRef.current;
    let notes = [...(c.notes || [])];
    for (const e of q) {
      if (e.remove?.length) { const rm = new Set(e.remove); notes = notes.filter(n => !rm.has(n.id)); }
      if (e.add?.length) notes.push(...e.add);
    }
    const end = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
    const bar = (60 / bpm) * 4;
    const dur = end > c.duration ? Math.ceil(end / bar - 1e-6) * bar : c.duration;
    onUpdateTrack({ ...t, clips: t.clips.map(x => (x.id === c.id ? { ...x, notes, duration: dur } : x)) });
  };
  const applyStep = (e: { add?: MidiNote[]; remove?: string[]; pos: number }) => {
    setStepPos(e.pos);
    if (!e.add?.length && !e.remove?.length) return;
    stepQueue.current.push(e);
    if (!stepRaf.current) stepRaf.current = requestAnimationFrame(flushSteps);
  };
  const applyStepRef = useRef(applyStep);
  applyStepRef.current = applyStep;

  // Notes jouées (clavier de l'ordinateur, clavier MIDI, touches à l'écran) sur cette piste :
  // touches allumées, prise du piano roll, saisie pas à pas.
  useEffect(() => midiInput.subscribe(e => {
    if (e.trackId !== liveRef.current.track.id || e.pitch === undefined) return;
    if (e.type === 'on') {
      heldRef.current.add(e.pitch);
      if (recRef.current && liveRef.current.isPlaying) recRef.current.noteOn(e.pitch, clipTimeNow(), e.velocity || 100);
      if (stepRef.current) applyStepRef.current(stepRef.current.noteOn(e.pitch, e.velocity || 100));
    } else if (e.type === 'off') {
      heldRef.current.delete(e.pitch);
      if (recRef.current && liveRef.current.isPlaying) recRef.current.noteOff(e.pitch, clipTimeNow());
      if (stepRef.current) applyStepRef.current(stepRef.current.noteOff(e.pitch));
    }
    setHeldPitches(Array.from(heldRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // --- NOTES FANTÔMES (Ghost notes de FL) : les autres pistes MIDI en filigrane ---
  const ghostNotes = useMemo(() => {
    if (!prefs.ghosts || isDrumMode || !allTracks) return [] as { key: string; pitch: number; start: number; duration: number; color: string; name: string }[];
    const out: { key: string; pitch: number; start: number; duration: number; color: string; name: string }[] = [];
    const span = clip.duration + 4;
    for (const t of allTracks) {
      if (t.id === track.id || t.type === TrackType.DRUM_RACK) continue;
      for (const c of t.clips || []) {
        if (!c.notes?.length || openClips.includes(c.id)) continue;
        for (const n of c.notes) {
          const start = c.start + n.start - clip.start;
          if (start + n.duration < 0 || start > span) continue;
          out.push({ key: `${t.id}:${c.id}:${n.id}`, pitch: n.pitch, start, duration: n.duration, color: t.color || '#94a3b8', name: t.name });
          if (out.length >= 3000) return out;
        }
      }
    }
    return out;
  }, [prefs.ghosts, isDrumMode, allTracks, track.id, clip.start, clip.duration, openClips]);
  const ghostTrackCount = useMemo(() => new Set(ghostNotes.map(g => g.name)).size, [ghostNotes]);

  // Glissés portés : d'où part chaque glissé (courbe dessinée).
  const origins = useMemo(() => slideOrigins(clip?.notes || []), [clip?.notes]);

  // --- OUTIL ACTIF : crayon, pinceau… ; tampon d'accords et glissé sont des crayons spécialisés ---
  const lastChordKindRef = useRef<ChordKind>('SCALE');
  if (chordKind) lastChordKindRef.current = chordKind;
  const shownTool: ShownTool = chordKind && !isDrumMode ? 'CHORD' : slideDraw && !isDrumMode ? 'SLIDE' : tool;
  const shownToolInfo = TOOLS.find(t => t.id === shownTool) || TOOLS[0];
  const pickTool = (id: ShownTool) => {
    if (id === 'CHORD') { setChordKind(k => k ?? lastChordKindRef.current); setSlideDraw(false); setTool('DRAW'); setLastChord(null); return; }
    if (id === 'SLIDE') { slideAction(); setChordKind(null); setTool('DRAW'); return; }
    setChordKind(null); setSlideDraw(false); setTool(id);
  };

  // --- SUIVRE LA LECTURE (par pages, comme FL et Live) ---
  const dragModeRef = useRef<DragMode>(null);
  dragModeRef.current = dragMode;
  useEffect(() => {
    if (!isPlaying || !prefs.follow) return;
    let raf = 0;
    const tick = () => {
      const el = containerRef.current;
      if (el && !dragModeRef.current) {
        const head = (audioEngine.getCurrentTime() - clipStart) * zoomRef.current.zoomX;
        const next = head >= 0 && head <= el.scrollWidth ? followScroll(head, el.scrollLeft, el.clientWidth) : null;
        if (next !== null) el.scrollLeft = next;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, prefs.follow, clipStart]);

  // --- PLUSIEURS CLIPS OUVERTS ENSEMBLE (Cubase : parties ouvertes ensemble, une seule « active ») ---
  // Les notes des clips ouverts se voient en couleur, à leur place ; un clic sur l'une d'elles rend son clip actif.
  const otherClips = useMemo(() => {
    const out: { track: Track; clip: NonNullable<typeof clip>; linked: boolean }[] = [];
    for (const t of allTracks || [track]) {
      if (t.type !== TrackType.MIDI && t.type !== TrackType.DRUM_RACK) continue;
      for (const c of t.clips || []) {
        if (c.id === clipId || c.type !== TrackType.MIDI && !c.notes) continue;
        out.push({ track: t, clip: c, linked: !!c.linkId && c.linkId === clip?.linkId });
      }
    }
    // La même piste d'abord, puis dans l'ordre du temps.
    return out.sort((a, b) => (a.track.id === track.id ? 0 : 1) - (b.track.id === track.id ? 0 : 1) || a.clip.start - b.clip.start).slice(0, 24);
  }, [allTracks, track, clipId, clip?.linkId]);
  const openNotes = useMemo(() => {
    const out: { key: string; trackId: string; clipId: string; noteId: string; pitch: number; start: number; duration: number; color: string; muted?: boolean }[] = [];
    for (const o of otherClips) {
      if (!openClips.includes(o.clip.id)) continue;
      for (const n of o.clip.notes || []) {
        if (n.start >= o.clip.duration) continue;
        const start = o.clip.start + n.start - clipStart;
        if (start + n.duration < 0) continue;
        out.push({ key: `${o.clip.id}:${n.id}`, trackId: o.track.id, clipId: o.clip.id, noteId: n.id, pitch: n.pitch, start, duration: Math.min(n.duration, o.clip.duration - n.start), color: o.track.color || '#94a3b8', muted: n.muted });
      }
    }
    return out;
  }, [otherClips, openClips, clipStart]);
  /** Passe sur un autre clip : il devient actif, celui-ci reste ouvert à côté ; la vue garde sa place. */
  const pendingSwitchRef = useRef<{ dx: number; noteId?: string } | null>(null);
  const switchToClip = (trackId: string, targetId: string, noteId?: string) => {
    const target = otherClips.find(o => o.clip.id === targetId);
    if (!target) return;
    setOpenClips(prev => [...prev.filter(id => id !== targetId), clipId]);
    pendingSwitchRef.current = { dx: target.clip.start - clipStart, noteId };
    window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId, clipId: targetId } }));
  };
  useEffect(() => {
    const p = pendingSwitchRef.current;
    pendingSwitchRef.current = null;
    setSelectedNoteIds(p?.noteId ? new Set([p.noteId]) : new Set());
    setPropsFor(null);
    const el = containerRef.current;
    if (p && el) el.scrollLeft = Math.max(0, el.scrollLeft - p.dx * zoomRef.current.zoomX);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      // Clavier de l'ordinateur allumé : les lettres jouent des notes, pas des outils.
      if (computerKeyboardStore.on && !e.ctrlKey && !e.metaKey && !e.altKey && /^[a-z]$/i.test(e.key)) return;
      // Table ACTIVE des raccourcis (utils/keymapStore : préréglage + remappages).
      const id = matchShortcut(e, PIANO_ROLL_SHORTCUT_IDS);
      switch (id) {
        case 'pr.close':
          e.preventDefault();
          // Un menu ouvert se ferme d'abord, le piano roll ensuite.
          if (menu || showQuantizeMenu || toolsAnchor !== false) { setMenu(null); setShowQuantizeMenu(false); setToolsAnchor(false); setToolPreview(null); return; }
          onClose(); return;
        // Notes muettes (Pro Tools : Mute Notes, Ctrl+M).
        case 'nova.muteNotes': e.preventDefault(); toggleMuteNotes(); return;
        case 'pr.delete': deleteNotes(Array.from(selectedNoteIds)); return;
        case 'pr.selectAll': e.preventDefault(); selectAll(); return;
        case 'pr.double': e.preventDefault(); doubleNotes(); return;
        case 'pr.up': e.preventDefault(); transpose(1); return;
        case 'pr.down': e.preventDefault(); transpose(-1); return;
        case 'pr.octUp': e.preventDefault(); transpose(12); return;
        case 'pr.octDown': e.preventDefault(); transpose(-12); return;
        case 'pr.quantize': e.preventDefault(); applyQuantize(); return;
        case 'pr.humanize': e.preventDefault(); humanizeNotes(); return;
        case 'pr.copy': e.preventDefault(); copySel(false); return;
        case 'pr.cut': e.preventDefault(); copySel(true); return;
        case 'pr.paste': e.preventDefault(); paste(); return;
        case 'pr.left': e.preventDefault(); nudge(-1); return;
        case 'pr.right': e.preventDefault(); nudge(1); return;
        case 'pr.longer': e.preventDefault(); resizeSel(1); return;
        case 'pr.shorter': e.preventDefault(); resizeSel(-1); return;
        case 'pr.legato': e.preventDefault(); legatoSel(); return;
        case 'pr.slide': e.preventDefault(); slideAction(); return;
        case 'pr.toolDraw': e.preventDefault(); pickTool('DRAW'); return;
        case 'pr.toolPaint': e.preventDefault(); pickTool('PAINT'); return;
        case 'pr.toolSelect': e.preventDefault(); pickTool('SELECT'); return;
        case 'pr.toolSlice': e.preventDefault(); pickTool('SPLIT'); return;
        case 'pr.toolErase': e.preventDefault(); pickTool('ERASE'); return;
        case 'pr.toolGlue': e.preventDefault(); pickTool('GLUE'); return;
        case 'pr.toolMute': e.preventDefault(); pickTool('MUTE'); return;
        case 'pr.zoomSel': e.preventDefault(); zoomToSel(); return;
        case 'pr.glue': e.preventDefault(); glueSel(); return;
        case 'pr.props': e.preventDefault(); openPropsForSelection(); return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, applyQuantize, selectAll, doubleNotes, transpose, humanizeNotes, onClose, clip.notes, grid, slideDraw, isDrumMode, rows, menu, showQuantizeMenu, toolsAnchor, zoomX]);

  // Saisie pas à pas : Tab = silence, Retour arrière = effacer le dernier pas (avant les autres raccourcis).
  useEffect(() => {
    if (!stepOn) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Chiffres 1 à 8 : valeur du pas (1 = ronde … 4 = croche, 5 = double), comme le pavé numérique des saisies pas à pas.
      if (/^[1-8]$/.test(e.key) && STEP_VALUES[Number(e.key) - 1]) { e.preventDefault(); e.stopImmediatePropagation(); setStepValueId(STEP_VALUES[Number(e.key) - 1].id); return; }
      if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); if (stepRef.current) applyStepRef.current(stepRef.current.rest()); }
      else if (e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); if (stepRef.current) applyStepRef.current(stepRef.current.back()); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stepOn]);

  // --- CLAVIER VERTICAL (touches blanches et noires) ou PADS ---
  const renderKeys = () => {
      if (isDrumMode) {
          // Noms des pads (son chargé) ; une ligne par pad, ou seulement les pads utilisés (replié).
          return rows.map(pitch => {
              const padId = pitch - 59;
              const pad = track.drumPads?.find(p => p.id === padId);
              const label = pad ? (pad.sampleName !== 'Empty' ? pad.sampleName : `Pad ${padId}`) : `Pad ${padId}`;
              const isHeld = heldPitches.includes(pitch);
              return (
                <div
                    key={padId}
                    data-pitch={pitch}
                    title={`${label} (clic : écouter)`}
                    className={`flex items-center justify-between px-2 text-[10px] font-bold border-b border-black/20 box-border cursor-pointer truncate ${isHeld ? 'bg-cyan-400 text-black' : 'bg-nv-raised text-slate-300 hover:text-white'}`}
                    style={{ height: currentRowHeight }}
                    onPointerDown={() => { if (stepOn) { midiInput.noteOn(pitch, 100, { source: 'screen', trackId: track.id }); midiInput.noteOff(pitch, { source: 'screen', trackId: track.id }); return; } try { audioEngine.triggerTrackAttack(track.id, pitch, 0.9); } catch { /* moteur pas prêt */ } }}
                >
                    <span className="truncate w-full">{label}</span>
                </div>
              );
          });
      }

      // Clavier : vraies touches (les noires sur 62 % de la largeur), notes hors gamme estompées,
      // tonique marquée, touches jouées allumées. En mode « seulement la gamme » : une touche par ligne.
      const held = new Set([...heldPitches]);
      const K = KEY_COLORS;
      return rows.map(pitch => {
        const isBlack = isBlackKey(pitch);
        const isC = pitch % 12 === 0;
        const out = highlight && !inKey(pitch);
        const isRoot = hasKey && ((pitch - keyRoot!) % 12 + 12) % 12 === 0;
        const showName = (anyFold || isC || isRoot) && currentRowHeight >= 10;
        const isHeld = held.has(pitch);
        const whiteBg = isHeld && !isBlack ? K.held : (out && !isBlack ? K.whiteOut : K.white);
        const blackBg = isHeld ? K.held : (out ? K.blackOut : K.black);
        const ink = isHeld ? '#000' : isBlack && anyFold ? (isRoot ? K.rootOnBlack : K.nameOnBlack) : (isRoot ? K.rootOnWhite : K.nameOnWhite);
        // Séparation entre deux touches blanches voisines (Mi | Fa et Si | Do) plus marquée.
        const pc = ((pitch % 12) + 12) % 12;
        const border = pc === 0 || pc === 5 ? '1px solid rgba(0,0,0,0.35)' : '1px solid rgba(0,0,0,0.12)';
        return (
            <div
                key={pitch}
                data-pitch={pitch}
                data-hors-gamme-touche={hasKey && highlight ? (out ? '1' : '0') : undefined}
                className="relative flex items-center justify-end pr-1 text-[9px] font-mono box-border cursor-pointer"
                style={{ height: currentRowHeight, backgroundColor: anyFold && isBlack ? blackBg : whiteBg, color: ink, borderBottom: anyFold ? '1px solid rgba(0,0,0,0.22)' : (isBlack ? 'none' : border) }}
                title={`${noteNameFr(pitch)}${hasKey ? (out ? ' · hors gamme' : ' · dans la gamme') : ''} (clic : écouter)`}
                onPointerDown={() => { if (stepOn) { midiInput.noteOn(pitch, 100, { source: 'screen', trackId: track.id }); midiInput.noteOff(pitch, { source: 'screen', trackId: track.id }); } else { try { audioEngine.previewMidiNote(track.id, pitch, 0.4); } catch { /* moteur pas prêt */ } } }}
            >
                {isBlack && !anyFold && (
                  <span aria-hidden className="absolute left-0 top-0 bottom-0 rounded-r-[3px]"
                    style={{ width: '62%', background: isHeld ? K.held : `linear-gradient(90deg, ${blackBg} 0%, ${blackBg} 80%, ${out ? '#3b414c' : '#2a2d33'} 100%)`, boxShadow: '1px 1px 2px rgba(0,0,0,0.45)' }} />
                )}
                {isRoot && !isHeld && <span className="relative w-1.5 h-1.5 rounded-full mr-auto ml-1" style={{ backgroundColor: '#f59e0b', marginLeft: isBlack && !anyFold ? '66%' : undefined }} aria-hidden />}
                {showName && <span className="relative font-bold mr-0.5">{noteNameFr(pitch)}</span>}
            </div>
        );
      });
  };

  const renderGridRows = () => {
     return rows.map((pitch, i) => {
         const isBlack = !isDrumMode && isBlackKey(pitch);
         const isAlt = isDrumMode && (i % 2 === 0);
         const out = highlight && !inKey(pitch);
         const isRoot = hasKey && ((pitch - keyRoot!) % 12 + 12) % 12 === 0;
         // Gamme surlignée : lignes de la gamme claires, hors gamme hachurées (Scale Highlighting de FL).
         const bg = highlight
           ? (out ? (light ? 'repeating-linear-gradient(135deg, #dde2ea 0 4px, #e9edf3 4px 8px)' : 'repeating-linear-gradient(135deg, #0b0c0f 0 4px, #101217 4px 8px)')
             : isRoot ? (light ? 'rgba(217,119,6,0.14)' : 'rgba(251,191,36,0.10)') : (light ? 'rgba(8,145,178,0.07)' : 'rgba(34,211,238,0.06)'))
           : (isBlack || isAlt ? G.black : undefined);
         const octave = !isDrumMode && !anyFold && pitch % 12 === 0;
         return (
             <div
                 key={`bg-${pitch}`}
                 data-hors-gamme-ligne={highlight ? (out ? '1' : '0') : undefined}
                 className="absolute left-0 right-0"
                 style={{ top: i * currentRowHeight, height: currentRowHeight, background: bg, borderBottom: `1px solid ${octave ? G.octave : G.row}` }}
             />
         );
     });
  };

  // Défilement de départ : 808 dans le grave, sinon autour du Do 4 (ou des notes du clip).
  useEffect(() => {
      if (containerRef.current) {
          if (isDrumMode) {
             containerRef.current.scrollTop = 0;
          } else {
             const ns = clip?.notes || [];
             const center = ns.length ? Math.round(ns.reduce((s, n) => s + n.pitch, 0) / ns.length) : (track.bass808 ? 36 : 72);
             containerRef.current.scrollTop = rowOf(center) * currentRowHeight - (containerRef.current.clientHeight / 2);
          }
      }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrumMode, foldOn, foldUsedOn]);

  // --- MENUS DÉROULANTS (Outil ▾, Outils ▾, Notes ▾, Vue ▾) ET CLIC DROIT ---
  const toggleDrop = (name: 'outil' | 'outils' | 'notes' | 'vue', e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu(null); setShowQuantizeMenu(false);
    setDropdown(d => (d?.name === name ? null : { name, x: r.left, y: r.bottom + 6 }));
  };
  /** Ancre d'un menu existant (grille, accords) ouvert depuis un menu déroulant : sous le bouton de l'outil. */
  const barAnchor = (sel: string) => {
    const el = document.querySelector(`[data-nova-pianoroll] ${sel}`) as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    return { x: Math.max(8, Math.min((r?.left ?? 8), window.innerWidth - 296)), y: (r?.bottom ?? 56) + 6 };
  };
  const openChordMenu = () => { const a = barAnchor('[data-nova-roll-menu-btn="outil"]'); setMenu({ kind: 'chord', x: a.x, y: a.y }); };
  const openQuantizeSettings = () => { const a = barAnchor('[data-nova-roll="grille"]'); setQuantPos(a); setShowQuantizeMenu(true); };
  const openToolsPanel = (initial?: ToolId) => {
    const a = barAnchor('[data-nova-roll-menu-btn="outils"]');
    setToolsInitial(initial);
    setToolsAnchor(window.innerWidth < 640 ? null : a);
  };
  const openPropsForSelection = () => {
    const ids = Array.from(selectedNoteIds);
    if (!ids.length) { setLastChord('Sélectionne une note (ou double-clique dessus) pour voir ses propriétés.'); return; }
    const el = containerRef.current;
    const n = (clip.notes || []).find(x => x.id === ids[0]);
    let x = window.innerWidth / 2 - 144, y = 120;
    if (el && n) { const r = el.getBoundingClientRect(); x = r.left + n.start * zoomX - el.scrollLeft; y = r.top + getYFromPitch(n.pitch) - el.scrollTop + currentRowHeight + 6; }
    setPropsFor({ ids, x, y });
  };
  const toolEntries = (only?: ShownTool[]): RollMenuEntry[] => TOOLS
    .filter(t => !(isDrumMode && (t.id === 'CHORD' || t.id === 'SLIDE')) && (!only || only.includes(t.id)))
    .map(t => ({
      label: t.label, icon: t.icon, keys: t.keys || undefined, hint: t.hint, checked: shownTool === t.id,
      id: t.id === 'SLIDE' ? 'glisse' : undefined, attrs: { 'data-nova-roll-tool': t.id },
      onSelect: () => pickTool(t.id),
    }));
  const menuEntries = (name: 'outil' | 'outils' | 'notes' | 'vue' | 'ctx', at?: number): (RollMenuEntry | false)[] => {
    const nSel = selectedNoteIds.size;
    const what = nSel ? 'la sélection' : 'tout le clip';
    if (name === 'outil') return [
      { kind: 'section', label: 'Outil de la grille' },
      ...toolEntries(),
      !isDrumMode && { kind: 'sep' },
      !isDrumMode && { id: 'accords', label: 'Accords : type et renversement…', icon: 'fa-sliders-h', hint: 'Accord de la gamme, majeur, mineur, 7e… et renversements pour le tampon d’accords', onSelect: openChordMenu },
    ];
    if (name === 'outils') return [
      { kind: 'section', label: `Placement · ${what}` },
      { id: 'quantifier', label: 'Quantifier', icon: 'fa-magnet', keys: 'Q', disabled: !nNotes, hint: `Sur ${gridLabel}, force ${quantizeStrength} %${quantizeSwing > 50 ? `, swing ${quantizeSwing} %` : ''}${quantizeEnds ? ', fins comprises' : ''}`, onSelect: applyQuantize },
      { id: 'quantifier-reglages', label: 'Réglages : grille, force, swing, fins…', icon: 'fa-sliders-h', onSelect: openQuantizeSettings },
      { id: 'humaniser-leger', label: 'Humaniser léger', icon: 'fa-random', disabled: !nNotes, hint: '±6 ms, ±6 de vélocité', onSelect: () => humanizeNotes('leger') },
      { id: 'humaniser', label: 'Humaniser', icon: 'fa-random', keys: 'H', disabled: !nNotes, hint: '±12 ms, ±10 de vélocité ; un accord bouge d’un bloc', onSelect: () => humanizeNotes('moyen') },
      { id: 'humaniser-fort', label: 'Humaniser fort', icon: 'fa-random', disabled: !nNotes, hint: '±25 ms, ±19 de vélocité', onSelect: () => humanizeNotes('fort') },
      { id: 'legato', label: 'Legato', icon: 'fa-grip-lines', keys: 'Ctrl+L', disabled: nNotes < 2, hint: 'Chaque note s’allonge jusqu’à la suivante', onSelect: legatoSel },
      { id: 'souder', label: 'Souder les notes qui se suivent', icon: 'fa-link', keys: 'Ctrl+G', disabled: nNotes < 2, onSelect: glueSel },
      { kind: 'section', label: 'Hauteur' },
      !isDrumMode && hasKey && { id: 'dans-gamme', label: `Remettre dans la gamme (${keyLabelFr(keyRoot, keyScale)})`, icon: 'fa-compress-arrows-alt', disabled: !nNotes, onSelect: fitToScale },
      !isDrumMode && { id: 'miroir', label: 'Miroir (haut ↔ bas)', icon: 'fa-arrows-alt-v', disabled: !nNotes, hint: 'Les notes montent là où elles descendaient, dans la gamme', onSelect: () => mirrorSel('pitch') },
      { id: 'retrograde', label: 'Rétrograde (à l’envers)', icon: 'fa-arrows-alt-h', disabled: !nNotes, onSelect: () => mirrorSel('time') },
      !isDrumMode && { id: 'epaissir', label: 'Épaissir : + octave', icon: 'fa-clone', disabled: !nNotes, hint: 'La même note une octave au-dessus (un peu moins forte)', onSelect: () => thickenSel(12) },
      !isDrumMode && { id: 'epaissir-bas', label: 'Épaissir : − octave', icon: 'fa-clone', disabled: !nNotes, onSelect: () => thickenSel(-12) },
      { kind: 'section', label: 'Transformations' },
      !isDrumMode && { id: 'outil-strum', label: 'Strum (guitare)…', icon: 'fa-guitar', disabled: !nNotes, onSelect: () => openToolsPanel('strum') },
      !isDrumMode && { id: 'outil-arp', label: 'Arpège figé en notes…', icon: 'fa-stream', disabled: !nNotes, onSelect: () => openToolsPanel('arp') },
      { id: 'outils', label: 'Roll, chop, flam, courbe de vélocité, aléatoire…', icon: 'fa-toolbox', disabled: !nNotes, onSelect: () => openToolsPanel() },
      { kind: 'section', label: 'Piste' },
      !simple && track.type === TrackType.MIDI && { label: `Effets MIDI en direct${track.midiFx?.some(s => s.on) ? ` · ${track.midiFx.filter(s => s.on).length} actif${track.midiFx.filter(s => s.on).length > 1 ? 's' : ''}` : ''}`, icon: 'fa-wand-magic-sparkles',
        hint: 'Arpège, accord d’une touche, gamme forcée : réglables pendant la lecture, figeables en notes', attrs: { 'data-testid': 'roll-midi-fx' },
        onSelect: () => window.dispatchEvent(new CustomEvent('nova:open-midi-fx', { detail: { trackId: track.id } })) },
      { id: 'groove', label: `Swing et groove du clip${clip.groove ? ' (actif)' : ''}`, icon: 'fa-drum', onSelect: () => midiBus.emit({ type: 'groove', trackId: track.id, clipId }) },
      { id: 'capturer', label: `Capturer ce que je viens de jouer${captureCount > 0 ? ` (${captureCount > 99 ? '99+' : captureCount})` : ''}`, icon: 'fa-hand-sparkles', hint: CAPTURE_HINT, onSelect: () => midiBus.emit({ type: 'capture', trackId: track.id }) },
      { id: 'mid-export', label: 'Exporter le clip en .mid', icon: 'fa-file-export', disabled: !nNotes, onSelect: () => midiBus.emit({ type: 'export', scope: 'clip', trackId: track.id, clipId }) },
      { id: 'mid-import', label: 'Importer un .mid', icon: 'fa-file-import', onSelect: () => midiBus.emit({ type: 'import-pick', trackId: track.id }) },
    ];
    if (name === 'notes') return [
      { kind: 'section', label: nSel ? `${nSel} note${nSel > 1 ? 's' : ''} sélectionnée${nSel > 1 ? 's' : ''}` : 'Sélection' },
      { id: 'tout', label: 'Tout sélectionner', icon: 'fa-object-group', keys: 'Ctrl+A', disabled: !nNotes, onSelect: selectAll },
      { id: 'dupliquer', label: 'Dupliquer à la suite', icon: 'fa-clone', keys: 'Ctrl+B', disabled: !nSel, onSelect: doubleNotes },
      { id: 'copier', label: 'Copier', icon: 'fa-copy', keys: 'Ctrl+C', disabled: !nSel, onSelect: () => copySel(false) },
      { id: 'couper', label: 'Couper', icon: 'fa-cut', keys: 'Ctrl+X', disabled: !nSel, onSelect: () => copySel(true) },
      { id: 'coller', label: 'Coller', icon: 'fa-paste', keys: 'Ctrl+V', disabled: !noteClipboard, onSelect: () => paste() },
      { id: 'effacer', label: 'Effacer', icon: 'fa-trash', keys: 'Suppr', disabled: !nSel, onSelect: () => deleteNotes(Array.from(selectedNoteIds)) },
      { kind: 'section', label: 'Modifier' },
      { id: 'monter', label: 'Monter d’un demi-ton', icon: 'fa-arrow-up', keys: '↑', disabled: !nSel, onSelect: () => transpose(1), keepOpen: true },
      { id: 'descendre', label: 'Descendre d’un demi-ton', icon: 'fa-arrow-down', keys: '↓', disabled: !nSel, onSelect: () => transpose(-1), keepOpen: true },
      !isDrumMode && { id: 'octave-plus', label: 'Une octave plus haut', icon: 'fa-angle-double-up', keys: 'Maj+↑', disabled: !nSel, onSelect: () => transpose(12) },
      !isDrumMode && { id: 'octave-moins', label: 'Une octave plus bas', icon: 'fa-angle-double-down', keys: 'Maj+↓', disabled: !nSel, onSelect: () => transpose(-12) },
      { id: 'muet', label: 'Rendre muettes / réactiver', icon: 'fa-volume-mute', keys: 'Ctrl+M', disabled: !nSel, onSelect: () => toggleMuteNotes() },
      !isDrumMode && { id: 'glisse-notes', label: 'Glissé (808) oui / non', icon: 'fa-level-up-alt', keys: 'S', disabled: !nSel, onSelect: slideAction },
      { id: 'proprietes', label: 'Propriétés…', icon: 'fa-info-circle', keys: 'Alt+Entrée', disabled: !nSel, hint: 'Hauteur, début, longueur, vélocité, glissé (double-clic sur une note aussi)', onSelect: openPropsForSelection },
      { kind: 'section', label: 'Jouer et enregistrer' },
      { id: 'clavier', label: 'Jouer avec le clavier de l’ordinateur', checked: kbOn, keepOpen: false, onSelect: () => setKbOn(v => !v),
        hint: 'Les lettres jouent des notes (Q S D F… = Do Ré Mi Fa…) ; les raccourcis à une lettre reviennent quand il est coupé' },
      { id: 'rec-midi', label: 'Enregistrer ce que je joue', checked: recArmed, hint: 'Clavier MIDI ou de l’ordinateur : la prise s’écrit dans le clip à l’arrêt (lance la lecture)',
        onSelect: () => { const on = !recArmed; setRecArmed(on); if (on && !isPlaying) onTogglePlay?.(); } },
      { id: 'pas-a-pas', label: 'Saisie pas à pas', checked: stepOn, hint: 'Chaque note jouée (clavier MIDI, de l’ordinateur ou touches à l’écran) avance d’un pas, sans lecture', onSelect: () => setStepOn(v => !v) },
      { id: 'quantif-entree', label: `Prise calée sur la grille (${gridLabel})`, checked: !!prefs.inputQuant, keepOpen: true, hint: 'Quantification d’entrée : chaque note enregistrée commence sur la grille', onSelect: () => setPrefs({ inputQuant: !prefs.inputQuant }) },
    ];
    if (name === 'vue') return [
      { kind: 'section', label: 'Zoom' },
      { id: 'zoom-selection', label: nSel ? 'Zoom sur la sélection' : 'Zoom sur les notes', icon: 'fa-search', keys: 'Z', disabled: !nNotes, onSelect: zoomToSel },
      { id: 'zoom-clip', label: 'Tout le clip en largeur', icon: 'fa-arrows-alt-h', onSelect: zoomToClip },
      { id: 'zoom-plus', label: 'Zoom avant', icon: 'fa-search-plus', keys: 'Ctrl+molette', keepOpen: true, onSelect: () => setZoomAt(zoomX * 1.25) },
      { id: 'zoom-moins', label: 'Zoom arrière', icon: 'fa-search-minus', keepOpen: true, onSelect: () => setZoomAt(zoomX / 1.25) },
      { id: 'lignes-plus', label: 'Lignes plus hautes', icon: 'fa-expand-alt', keys: 'Alt+molette', keepOpen: true, onSelect: () => setRowHAt(rowH + 3) },
      { id: 'lignes-moins', label: 'Lignes moins hautes', icon: 'fa-compress-alt', keepOpen: true, onSelect: () => setRowHAt(rowH - 3) },
      { kind: 'section', label: 'Lignes du clavier' },
      { id: 'replier-non', label: isDrumMode ? 'Tous les pads' : 'Toutes les notes', checked: !prefs.foldUsed && !foldOn, keepOpen: true, onSelect: () => setPrefs({ foldUsed: false, fold: false }) },
      !isDrumMode && { id: 'replier-gamme', label: hasKey ? `Seulement la gamme (${keyLabelFr(keyRoot, keyScale)})` : 'Seulement la gamme (choisis-la d’abord)', checked: foldOn && !foldUsedOn, disabled: !hasKey, keepOpen: true, onSelect: () => setPrefs({ fold: true, foldUsed: false }) },
      { id: 'replier-utilisees', label: isDrumMode ? 'Seulement les pads utilisés' : 'Seulement les notes utilisées', checked: !!prefs.foldUsed, disabled: !nNotes, keepOpen: true, hint: 'Replier : une ligne par hauteur jouée dans le clip, rien d’autre', onSelect: () => setPrefs({ foldUsed: !prefs.foldUsed }) },
      { kind: 'section', label: 'Afficher' },
      !isDrumMode && { id: 'fantomes', label: `Notes fantômes des autres pistes${ghostTrackCount ? ` (${ghostTrackCount})` : ''}`, checked: prefs.ghosts, keepOpen: true, onSelect: () => setPrefs({ ghosts: !prefs.ghosts }) },
      { id: 'couleurs', label: 'Couleur selon la vélocité', checked: prefs.velColors, keepOpen: true, hint: 'Violet = doux, rouge = fort', onSelect: () => setPrefs({ velColors: !prefs.velColors }) },
      { id: 'couloirs', label: 'Couloir de vélocité et contrôleurs', checked: prefs.lanes !== false, keepOpen: true, onSelect: () => setPrefs({ lanes: prefs.lanes === false }) },
      { id: 'suivre', label: 'Suivre la lecture', checked: !!prefs.follow, keepOpen: true, hint: 'La vue tourne la page quand la tête de lecture en sort', onSelect: () => setPrefs({ follow: !prefs.follow }) },
      { id: 'apercu', label: 'Entendre les notes en les posant', checked: prefs.preview, keepOpen: true, onSelect: () => setPrefs({ preview: !prefs.preview }) },
      { kind: 'section', label: 'Lecture' },
      onSetLoop && { id: 'boucle', label: 'Boucler le clip', checked: loopOnClip, keepOpen: true, hint: 'Sur la règle : glisser pour choisir une autre boucle', onSelect: toggleClipLoop },
      onToggleMetronome && { id: 'metronome', label: 'Métronome', checked: !!metronomeOn, keepOpen: true, onSelect: onToggleMetronome },
      otherClips.length > 0 && { kind: 'section', label: 'Autres clips ouverts ensemble' },
      ...otherClips.slice(0, 12).map(o => ({
        label: `${o.linked ? '∞ ' : ''}${o.clip.name || 'Clip'} · ${o.track.name} · mes. ${Math.floor(o.clip.start / barSec + 1e-6) + 1}`,
        checked: openClips.includes(o.clip.id), keepOpen: true, attrs: { 'data-nova-open-clip': o.clip.id },
        hint: 'Ses notes s’affichent en couleur à leur place ; clic sur l’une d’elles pour éditer ce clip',
        onSelect: () => setOpenClips(prev => (prev.includes(o.clip.id) ? prev.filter(id => id !== o.clip.id) : [...prev, o.clip.id])),
      } as RollMenuEntry)),
    ];
    // Clic droit dans le vide.
    return [
      noteClipboard && { id: 'ctx-coller', label: 'Coller ici', icon: 'fa-paste', keys: 'Ctrl+V', onSelect: () => paste(at) },
      nSel > 0 && { kind: 'section', label: `${nSel} note${nSel > 1 ? 's' : ''} sélectionnée${nSel > 1 ? 's' : ''}` },
      nSel > 0 && { id: 'ctx-copier', label: 'Copier', icon: 'fa-copy', keys: 'Ctrl+C', onSelect: () => copySel(false) },
      nSel > 0 && { id: 'ctx-dupliquer', label: 'Dupliquer à la suite', icon: 'fa-clone', keys: 'Ctrl+B', onSelect: doubleNotes },
      nSel > 0 && { id: 'ctx-quantifier', label: 'Quantifier', icon: 'fa-magnet', keys: 'Q', onSelect: applyQuantize },
      nSel > 0 && { id: 'ctx-muet', label: 'Rendre muettes / réactiver', icon: 'fa-volume-mute', keys: 'Ctrl+M', onSelect: () => toggleMuteNotes() },
      nSel > 0 && { id: 'ctx-proprietes', label: 'Propriétés…', icon: 'fa-info-circle', keys: 'Alt+Entrée', onSelect: openPropsForSelection },
      nSel > 0 && { id: 'ctx-effacer', label: 'Effacer', icon: 'fa-trash', keys: 'Suppr', onSelect: () => deleteNotes(Array.from(selectedNoteIds)) },
      { kind: 'section', label: 'Clip' },
      { id: 'ctx-tout', label: 'Tout sélectionner', icon: 'fa-object-group', keys: 'Ctrl+A', disabled: !nNotes, onSelect: selectAll },
      { id: 'ctx-zoom', label: 'Zoom sur les notes', icon: 'fa-search', keys: 'Z', disabled: !nNotes, onSelect: zoomToSel },
      { kind: 'section', label: 'Outil' },
      ...toolEntries(['DRAW', 'PAINT', 'SELECT', 'CHORD', 'SLIDE']),
    ];
  };

  const contentWidth = Math.max((clip.duration + 4) * zoomX, 2000);
  const sideW = isDrumMode ? 'w-32' : 'w-16';
  const barPx = barSec * zoomX, beatPx = beatSec * zoomX, gridPx = grid * zoomX;
  const gridOffset = -((clipStart % barSec) * zoomX);
  const nNotes = (clip.notes || []).length;
  const hasSel = selectedNoteIds.size > 0;
  const gridLabel = GRID_CHOICES.find(g => g.id === gridId)?.label || gridId;
  const TOGGLE = (on: boolean) => ({ 'aria-pressed': on });
  // Grille des temps : fond en dégradés (mesures, temps, cases), sans milliers de traits dans le DOM.
  // Carte de tempo : traits calculés (SVG), une rampe resserre ou écarte les mesures et les cases.
  const mapLines = useMemo(() => (followMap ? mapGridLines(followMap, clipStart, clipStart + contentWidth / zoomX, gridId, 5 / zoomX) : null), [followMap, clipStart, contentWidth, zoomX, gridId]);
  const gridBg = {
    backgroundImage: [
      `linear-gradient(to right, ${G.bar} 1px, transparent 1px)`,
      `linear-gradient(to right, ${G.beat} 1px, transparent 1px)`,
      gridPx >= 5 && gridPx < beatPx - 0.5 ? `linear-gradient(to right, ${G.sub} 1px, transparent 1px)` : 'none',
      `linear-gradient(to right, ${G.barShade} 50%, transparent 50%)`,
    ].join(', '),
    backgroundSize: `${barPx}px 100%, ${beatPx}px 100%, ${gridPx}px 100%, ${barPx * 2}px 100%`,
    backgroundPosition: `${gridOffset}px 0, ${gridOffset}px 0, ${gridOffset}px 0, ${gridOffset}px 0`,
  } as React.CSSProperties;

  return (
    <div data-nova-pianoroll="" className="w-full h-full flex flex-col bg-nv-surface select-none text-white font-inter">
       {/* BARRE (piano roll pratique, 22/10/2026) : pas de mur de boutons. Visibles : l'outil actif, la grille, la gamme ;
           le reste dans « Outils ▾ », « Notes ▾ », « Vue ▾ » et au clic droit dans la grille. Fermer reste à droite. */}
       <div data-nova-roll="barre" className="pr-bar min-h-14 flex items-center gap-2 px-3 shrink-0">
       <div className="flex-1 min-w-0 h-full flex items-center justify-between gap-3 overflow-x-auto no-scrollbar py-1.5">
          <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="md:hidden shrink-0 w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center"><i className="fas fa-times"></i></button>
          <div className="flex items-center gap-2 shrink-0">
             <div className="hidden lg:flex items-center space-x-2">
                <div className={`w-8 h-8 rounded flex items-center justify-center border ${isDrumMode ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-green-500/20 text-green-400 border-green-500/30'}`}>
                    <i className={`fas ${isDrumMode ? 'fa-drum' : 'fa-keyboard'}`}></i>
                </div>
                <div>
                    <h3 className="text-[10px] font-black text-white uppercase tracking-widest">{isDrumMode ? 'Séquenceur de batterie' : 'Piano roll'}</h3>
                    <p className="text-[9px] text-slate-500 font-mono max-w-[120px] truncate">{clip.name}</p>
                </div>
             </div>

             {/* L3 · Copie liée (utils/linkedClips) : ce qu'on modifie ici change aussi les autres copies. */}
             {linkedCount > 1 && (
               <button type="button" data-testid="roll-linked" className="pr-cap shrink-0" style={{ color: '#22d3ee' }}
                 onClick={() => onUpdateTrack({ ...track, clips: track.clips.map(c => (c.id === clip.id ? makeUnique(c) : c)) })}
                 title={`Copie liée : ${linkedCount} copies de ce motif. Chaque note modifiée ici change aussi les ${linkedCount - 1} autres. Clic : rendre cette copie unique (Ctrl+Z pour revenir).`}
                 aria-label={`Copie liée, ${linkedCount} copies. Rendre unique`}>
                 <span className="font-black">∞ {linkedCount}</span><span className="hidden min-[1200px]:inline">copies liées · Rendre unique</span>
               </button>
             )}

             {onTogglePlay && (
               <button type="button" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Lecture'} title="Écouter / pause (barre d'espace)"
                 className={`shrink-0 w-10 h-10 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 rounded-full flex items-center justify-center ${isPlaying ? 'bg-cyan-400 text-black' : 'bg-white text-black'}`}>
                 <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-sm`}></i>
               </button>
             )}

             {/* Son de la piste (mode instru : synthé NOVA, instrument VST du PC, 808) */}
             {toolbarExtra}

             <div className="pr-sep"></div>

             {/* Outil actif (FL Studio : P, B, E, C, G, T, D) : un seul bouton, la liste dans le menu. */}
             <button type="button" data-nova-roll-menu-btn="outil" data-nova-roll-active-tool={shownTool} aria-haspopup="menu" aria-expanded={dropdown?.name === 'outil'}
               onClick={e => toggleDrop('outil', e)} title={`${shownToolInfo.hint}. Clic : changer d'outil`} aria-label={`Outil : ${shownToolInfo.label}`}
               className="pr-cap pr-drop" data-on={shownTool !== 'DRAW' ? 'true' : undefined}
               style={shownTool === 'ERASE' ? { background: '#ef4444', color: '#fff' } : shownTool === 'CHORD' ? { background: '#d946ef', color: '#000' } : shownTool === 'SLIDE' ? { background: '#fb923c', color: '#000' } : undefined}>
               <i className={`fas ${shownToolInfo.icon} text-[11px] ${shownTool === 'SLIDE' ? 'rotate-90' : ''}`}></i>
               <span>{shownTool === 'CHORD' && chordKind ? (CHORD_CHOICES.find(c => c.id === chordKind)?.label || shownToolInfo.label) : shownToolInfo.label}</span>
               <i className="fas fa-chevron-down"></i>
             </button>

             {/* Grille, magnétisme, quantification (force, swing) */}
             <button
               onClick={e => {
                 if (showQuantizeMenu) { setShowQuantizeMenu(false); return; }
                 const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                 setQuantPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - 288)), y: r.bottom + 6 });
                 setShowQuantizeMenu(true);
               }}
               data-nova-roll="grille" aria-haspopup="dialog" aria-expanded={showQuantizeMenu} title="Grille, magnétisme et quantification (force, swing)"
               className="pr-cap pr-drop"
             >
               <i className={`fas ${magnet ? 'fa-magnet' : 'fa-th'} text-[10px]`} style={{ color: magnet ? '#c084fc' : undefined }}></i>
               <span>{magnet ? gridLabel : 'Libre'}</span>
               <i className="fas fa-chevron-down"></i>
             </button>

             {/* Gamme du morceau */}
             {!isDrumMode && (
               <button type="button" data-nova-roll="gamme" onClick={e => openMenu('scale', e)} aria-expanded={menu?.kind === 'scale'}
                 title="Gamme du morceau : grise les notes hors gamme, aimant, seulement la gamme"
                 className={`pr-cap pr-drop ${hasKey ? '!bg-amber-500/15 !border-amber-500/50 !text-amber-300' : ''}`}>
                 <i className="fas fa-music text-[9px]"></i>
                 <span>{hasKey ? keyLabelFr(keyRoot, keyScale) : 'Gamme'}</span>
                 {snapOn && <i className="fas fa-magnet text-[8px]" title="Aimant de gamme actif"></i>}
                 <i className="fas fa-chevron-down"></i>
               </button>
             )}

             <div className="pr-sep"></div>

             <button type="button" data-nova-roll-menu-btn="outils" aria-haspopup="menu" aria-expanded={dropdown?.name === 'outils'} onClick={e => toggleDrop('outils', e)}
               title="Transformations : quantifier, humaniser, legato, strum, arpège, miroir, épaissir, souder, effets MIDI, .mid" className="pr-cap pr-drop">
               <span>Outils</span><i className="fas fa-chevron-down"></i>
             </button>
             <button type="button" data-nova-roll-menu-btn="notes" aria-haspopup="menu" aria-expanded={dropdown?.name === 'notes'} onClick={e => toggleDrop('notes', e)}
               title="Notes : sélection, copier, coller, dupliquer, transposer, muettes, propriétés, clavier, enregistrement, pas à pas" className="pr-cap pr-drop">
               <span>Notes</span><i className="fas fa-chevron-down"></i>
             </button>
             <button type="button" data-nova-roll-menu-btn="vue" aria-haspopup="menu" aria-expanded={dropdown?.name === 'vue'} onClick={e => toggleDrop('vue', e)}
               title="Vue : zoom, replier, notes fantômes, couleurs, suivre la lecture, boucle, métronome, autres clips" className="pr-cap pr-drop">
               <span>Vue</span><i className="fas fa-chevron-down"></i>
             </button>

             {/* États en cours seulement (pas de bouton permanent) : prise armée. */}
             {recArmed && (
               <button type="button" data-nova-roll="rec-actif" onClick={() => setRecArmed(false)} aria-label="Arrêter d'enregistrer"
                 title="Prise MIDI armée : ce que tu joues pendant la lecture s’écrit dans le clip (à l’arrêt). Clic pour désarmer."
                 className="pr-cap !bg-red-600 !text-white animate-pulse"><span className="w-2 h-2 rounded-full bg-white"></span><span>Prise</span></button>
             )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
             <div className="text-[10px] text-slate-400 whitespace-nowrap" role="status">
                {hasSel ? <span className="text-cyan-400 font-bold">{selectedNoteIds.size} sélectionnée{selectedNoteIds.size > 1 ? 's' : ''}</span> : <span>{nNotes} note{nNotes > 1 ? 's' : ''}</span>}
             </div>
          </div>
       </div>
          <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="hidden md:flex shrink-0 w-8 h-8 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-red-500/20 items-center justify-center"><i className="fas fa-times"></i></button>
       </div>

       {dropdown && (
         <RollMenu name={dropdown.name} anchor={{ x: dropdown.x, y: dropdown.y }} onClose={() => setDropdown(null)}
           label={dropdown.name === 'outil' ? 'Outil' : dropdown.name === 'outils' ? 'Outils' : dropdown.name === 'notes' ? 'Notes' : dropdown.name === 'vue' ? 'Vue' : 'Menu des notes'}
           entries={menuEntries(dropdown.name, dropdown.t)} width={dropdown.name === 'outil' ? 250 : 286} />
       )}

       {propsFor && (() => {
         const set = new Set(propsFor.ids);
         const ns = (clip.notes || []).filter(n => set.has(n.id));
         if (!ns.length) return null;
         return (
           <NoteProps notes={ns} anchor={{ x: propsFor.x, y: propsFor.y }} beatSec={quarterAt(ns[0].start)} isDrum={isDrumMode}
             onApply={(fn, label) => { updateNotes((clip.notes || []).map(n => (set.has(n.id) ? fn(n) : n))); setLastChord(`${label} (Ctrl+Z pour annuler)`); }}
             onDelete={() => deleteNotes(propsFor.ids)} onPreview={p => playPreview(p)} onClose={() => setPropsFor(null)} />
         );
       })()}
       {/* Saisie pas à pas (R16) */}
       {stepOn && (
         <div data-nova-roll="pas-a-pas-barre" className="shrink-0 px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-emerald-400/30 bg-emerald-500/[0.06] text-[11px] text-slate-200">
           <span className="text-emerald-300 font-bold"><i className="fas fa-shoe-prints mr-1"></i>Pas à pas</span>
           <span className="flex flex-wrap gap-1" role="radiogroup" aria-label="Valeur d'un pas">
             {STEP_VALUES.map((v, i) => (
               <button key={v.id} type="button" role="radio" aria-checked={stepValueId === v.id} onClick={() => setStepValueId(v.id)} title={`${v.hint} (touche ${i + 1})`} data-nova-step-value={v.id}
                 className={`h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md text-[10px] font-bold ${stepValueId === v.id ? 'bg-emerald-400 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{v.label}</button>
             ))}
           </span>
           <button type="button" data-nova-step="rest" onClick={() => stepRef.current && applyStep(stepRef.current.rest())} title="Silence : avance d'un pas sans note (Tab)"
             className="h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md bg-white/5 hover:bg-white/10 font-bold">Silence <span className="text-slate-500">Tab</span></button>
           <button type="button" data-nova-step="back" onClick={() => stepRef.current && applyStep(stepRef.current.back())} title="Efface le dernier pas et recule (Retour arrière)"
             className="h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md bg-white/5 hover:bg-white/10 font-bold"><i className="fas fa-backspace mr-1"></i>Retour</button>
           <label className="flex items-center gap-1.5 min-h-7" title="Accord tenu : les notes s'empilent au même endroit, même jouées l'une après l'autre ; « Suivant » avance">
             <input type="checkbox" className="w-4 h-4 accent-emerald-400" checked={chordHold} onChange={e => setChordHold(e.target.checked)} />Accord tenu
           </label>
           {chordHold && <button type="button" data-nova-step="next" onClick={() => stepRef.current && applyStep(stepRef.current.next())} className="h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md bg-emerald-500/20 border border-emerald-400/40 font-bold">Suivant →</button>}
           <label className="flex items-center gap-1.5 min-h-7" title="Vélocité fixe à 100, ou celle que tu joues">
             <input type="checkbox" className="w-4 h-4 accent-emerald-400" checked={stepFixedVel} onChange={e => setStepFixedVel(e.target.checked)} />Vélocité fixe (100)
           </label>
           <button type="button" onClick={() => { stepRef.current?.moveTo(0); setStepPos(0); }} className="h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md bg-white/5 hover:bg-white/10" title="Curseur au début du clip">↺ Début</button>
           <button type="button" data-nova-step="stop" onClick={() => setStepOn(false)} className="h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md bg-emerald-400 text-black font-bold" title="Terminer la saisie pas à pas">Terminer</button>
           <span className="text-slate-400" role="status">{followMap
             ? (() => { const a = mapBarBeat(followMap, clipStart), b = mapBarBeat(followMap, clipStart + stepPos); return `Mesure ${b.bar - a.bar + 1}, temps ${b.beat + 1}`; })()
             : `Mesure ${Math.floor(stepPos / ((60 / bpm) * 4)) + 1}, temps ${(Math.floor(stepPos / (60 / bpm)) % 4) + 1}`} · joue une note ou un accord · chiffres 1 à 8 : valeur du pas</span>
         </div>
       )}

       {/* Bandeau d'état : clavier de l'ordinateur, accord posé, gamme, retours des actions */}
       {(kbOn || lastChord || chordKind || slideDraw) && (
         <div data-nova-roll="bandeau" className="shrink-0 min-h-8 px-4 py-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 bg-nv-surface text-[11px] text-slate-300">
           {kbOn && (
             <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
               <span className="text-cyan-300 font-bold"><i className="fas fa-keyboard mr-1"></i>Joue avec les lettres</span>
               <button type="button" data-nova-roll="clavier-couper" onClick={() => setKbOn(false)} className="h-7 [@media(pointer:coarse)]:h-11 px-2 rounded-md bg-cyan-400 text-black font-bold"
                 title="Couper le clavier de l'ordinateur : les lettres redeviennent des raccourcis">Couper</button>
               <span className="font-mono text-slate-400">{['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'].map(keyLabel).join(' ')} = Do Ré Mi Fa Sol La Si Do · {['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU'].map(keyLabel).join(' ')} = dièses</span>
               <span>Octave <b className="text-white">Do{kbState.octave}</b> <span className="text-slate-500">({keyLabel('KeyZ')} / {keyLabel('KeyX')})</span></span>
               <span>Vélocité <b className="text-white">{kbState.velocity}</b> <span className="text-slate-500">({keyLabel('KeyC')} / {keyLabel('KeyV')})</span></span>
               {heldPitches.length > 0 && <span className="text-cyan-300 font-bold">{heldPitches.length > 2 ? chordLabelFr([...heldPitches].sort((a, b) => a - b)) : heldPitches.map(noteNameFr).join(' + ')}</span>}
               <span className="text-slate-500">Sur la piste « {track.name} »</span>
             </span>
           )}
           {chordKind && !isDrumMode && <span className="text-fuchsia-300"><i className="fas fa-layer-group mr-1"></i>Clique dans la grille pour poser {chordKind === 'SCALE' ? "l'accord de la gamme" : `un accord ${CHORD_CHOICES.find(c => c.id === chordKind)?.label.toLowerCase()}`}{hasKey ? ` dans ${keyLabelFr(keyRoot, keyScale)}` : ''}{chordInv ? ` · ${chordInv === 1 ? '1er' : '2e'} renversement` : ''}</span>}
           {slideDraw && !isDrumMode && <span className="text-orange-300"><i className="fas fa-level-up-alt rotate-90 mr-1"></i>Glissés : pose la note pendant une note tenue, elle la fera glisser (Maj + clic au crayon : un glissé sans changer d’outil)</span>}
           {lastChord && <span className="text-amber-200" role="status">{lastChord}</span>}
         </div>
       )}

       {toolsAnchor !== false && (
         <MidiToolsPanel notes={clip.notes || []} selectedIds={selectedNoteIds} ctx={toolCtx} anchor={toolsAnchor} initialTool={toolsInitial}
           onPreview={setToolPreview} onApply={applyToolResult} onClose={() => { setToolsAnchor(false); setToolPreview(null); }} />
       )}

       {/* Menu grille / quantification : en position fixe, sinon la barre (qui défile en largeur) le coupait */}
       {showQuantizeMenu && (
         <>
           <div className="fixed inset-0 z-[290]" onPointerDown={() => setShowQuantizeMenu(false)} />
           <div data-nova-roll-menu="quantize" role="dialog" aria-label="Grille et quantification" className="fixed z-[300] bg-nv-raised border border-white/20 rounded-xl shadow-2xl p-3 w-72 max-h-[75vh] overflow-y-auto" style={{ left: quantPos.x, top: quantPos.y }}>
             <button type="button" role="switch" aria-checked={magnet} aria-label="Magnétisme de la grille" onClick={() => setPrefs({ magnet: !magnet })}
               title="Magnétisme : les notes se calent sur la grille. Coupé : placement libre. Alt tenu : libre le temps d'un geste."
               className="w-full flex items-center justify-between gap-2 mb-2 min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-lg px-1 hover:bg-white/5">
               <span className="text-[11px] font-bold text-white"><i className="fas fa-magnet mr-1.5 text-purple-400"></i>Magnétisme (grille)</span>
               <span aria-hidden className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${magnet ? 'bg-purple-500' : 'bg-white/15'}`}>
                 <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${magnet ? 'left-[18px]' : 'left-0.5'}`} />
               </span>
             </button>
             <div className="text-[9px] font-black uppercase text-slate-400 mb-1.5">Grille</div>
             <div className="grid grid-cols-4 gap-1 mb-1">
               {GRID_CHOICES.filter(q => !q.triplet).map(q => (
                 <button key={q.id} type="button" data-nova-grid={q.id} title={q.hint} onClick={() => setPrefs({ gridId: q.id, magnet: true })}
                   className={`py-1.5 min-h-8 [@media(pointer:coarse)]:min-h-11 rounded text-[10px] font-bold ${gridId === q.id ? 'bg-purple-600 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{q.label}</button>
               ))}
             </div>
             <div className="text-[9px] font-black uppercase text-slate-400 mb-1.5 mt-2">Triolets</div>
             <div className="grid grid-cols-4 gap-1 mb-3">
               {GRID_CHOICES.filter(q => q.triplet).map(q => (
                 <button key={q.id} type="button" data-nova-grid={q.id} title={q.hint} onClick={() => setPrefs({ gridId: q.id, magnet: true })}
                   className={`py-1.5 min-h-8 [@media(pointer:coarse)]:min-h-11 rounded text-[10px] font-bold ${gridId === q.id ? 'bg-purple-600 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{q.label}</button>
               ))}
             </div>

             <div className="text-[9px] font-black uppercase text-slate-400 mb-1.5">Force de la quantification</div>
             <div className="flex gap-1 mb-3">
               {[25, 50, 75, 100].map(s => (
                 <button key={s} type="button" onClick={() => setQuantizeStrength(s)} data-nova-q-force={s}
                   className={`flex-1 py-1.5 min-h-8 [@media(pointer:coarse)]:min-h-11 rounded text-[10px] font-bold ${quantizeStrength === s ? 'bg-purple-600 text-white' : 'bg-white/5 text-slate-300'}`}>{s} %</button>
               ))}
             </div>
             <label className="block mb-3" title="Swing : les contretemps de la grille sont retardés (50 % = droit, 66 % = ternaire).">
               <span className="flex justify-between text-[9px] font-black uppercase text-slate-400 mb-1"><span>Swing</span><b className="text-white">{quantizeSwing} %</b></span>
               <input type="range" min={50} max={75} value={quantizeSwing} onChange={e => setQuantizeSwing(Number(e.target.value))} aria-label="Swing de la quantification" className="w-full accent-purple-500 h-8 [@media(pointer:coarse)]:h-11" />
             </label>
             <button type="button" role="switch" aria-checked={quantizeEnds} onClick={() => setQuantizeEnds(v => !v)}
               className="w-full flex items-center justify-between gap-2 mb-3 min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-lg px-1 text-[11px] text-slate-200 hover:bg-white/5">
               <span>Caler aussi les fins de notes</span>
               <span aria-hidden className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${quantizeEnds ? 'bg-purple-500' : 'bg-white/15'}`}>
                 <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${quantizeEnds ? 'left-[18px]' : 'left-0.5'}`} />
               </span>
             </button>
             <button type="button" onClick={() => { applyQuantize(); setShowQuantizeMenu(false); }} disabled={!nNotes} data-nova-roll="quantifier-menu"
               className={`w-full py-2 min-h-9 [@media(pointer:coarse)]:min-h-11 rounded text-[11px] font-bold ${nNotes ? 'bg-purple-600 text-white' : 'bg-white/5 text-slate-500'}`}>
               Quantifier {hasSel ? 'la sélection' : 'tout le clip'} (Q)
             </button>
           </div>
         </>
       )}

       {menu && (
         <>
           <div className="fixed inset-0 z-[290]" onPointerDown={() => setMenu(null)} />
           <div role="dialog" aria-label={menu.kind === 'scale' ? 'Gamme du morceau' : 'Outil accords'} data-nova-roll-menu={menu.kind}
             className="fixed z-[300] w-72 max-h-[70vh] overflow-y-auto rounded-xl border border-white/15 bg-nv-raised p-3 shadow-2xl text-[11px] text-slate-200"
             style={{ left: menu.x, top: menu.y }}>
             {menu.kind === 'scale' ? (
               <div className="space-y-3">
                 <div>
                   <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Tonalité du morceau</div>
                   <div className="flex gap-2">
                     <select aria-label="Note de la tonalité" value={typeof keyRoot === 'number' ? keyRoot : ''} onChange={e => setKey(Number(e.target.value), keyScale)}
                       className="flex-1 h-9 [@media(pointer:coarse)]:h-11 rounded-lg bg-black/40 border border-white/15 px-2 text-white">
                       {typeof keyRoot !== 'number' && <option value="">Choisir…</option>}
                       {NOTE_NAMES_FR.map((n, i) => <option key={n} value={i}>{n}</option>)}
                     </select>
                     <select aria-label="Gamme" value={keyScale.toUpperCase()} onChange={e => setKey(typeof keyRoot === 'number' ? keyRoot : 0, e.target.value)}
                       className="flex-1 h-9 [@media(pointer:coarse)]:h-11 rounded-lg bg-black/40 border border-white/15 px-2 text-white">
                       {SCALE_CHOICES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                     </select>
                   </div>
                   <p className="mt-1 text-[10px] text-slate-500">{typeof projectKey === 'number' ? 'Détectée sur ton beat. La changer règle aussi tes Auto-Tune (annulable).' : "Pas encore de tonalité : choisis-la, Nova s'en souviendra pour le projet."}</p>
                 </div>
                 {([
                   ['highlight', 'Griser les notes hors gamme', 'Les lignes et les notes hors gamme sont hachurées et grisées.'],
                   ['snap', 'Coller à la gamme', 'Chaque note posée ou déplacée tombe sur une note de la gamme ; ↑ / ↓ passent de note en note.'],
                   ['fold', 'Montrer seulement la gamme', 'Cache les lignes hors gamme : impossible de jouer faux.'],
                 ] as [keyof RollPrefs, string, string][]).map(([k, label, hint]) => (
                   <label key={k} className={`flex items-start gap-2 rounded-lg p-2 ${hasKey ? 'hover:bg-white/5 cursor-pointer' : 'opacity-40'}`} title={hint}>
                     <input type="checkbox" className="mt-0.5 accent-amber-400" disabled={!hasKey} checked={!!prefs[k]} onChange={e => setPrefs({ [k]: e.target.checked } as Partial<RollPrefs>)} />
                     <span><b className="text-white">{label}</b><br /><span className="text-slate-400 text-[10px]">{hint}</span></span>
                   </label>
                 ))}
                 <button type="button" disabled={!hasKey} onClick={() => { fitToScale(); setMenu(null); }}
                   title="Ramène sur la gamme les notes sélectionnées (ou toutes les notes du clip) : une seule étape d'annulation"
                   className="w-full h-9 [@media(pointer:coarse)]:h-11 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-200 font-bold disabled:opacity-40">
                   <i className="fas fa-compress-arrows-alt mr-1.5"></i>Remettre {selectedNoteIds.size > 0 ? 'la sélection' : 'tout le clip'} dans la gamme
                 </button>
               </div>
             ) : (
               <div className="space-y-1">
                 <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Renversement</div>
                 <div className="flex gap-1 mb-2" role="radiogroup" aria-label="Renversement de l'accord">
                   {[['0', 'Fondamental'], ['1', '1er'], ['2', '2e']].map(([v, l]) => (
                     <button key={v} type="button" role="radio" aria-checked={chordInv === Number(v)} data-nova-chord-inv={v} onClick={() => setChordInv(Number(v))}
                       title={v === '0' ? 'Fondamentale en bas' : v === '1' ? 'La fondamentale passe une octave au-dessus (son plus doux, voicing R&B)' : 'Les deux notes du bas passent une octave au-dessus'}
                       className={`flex-1 min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-lg font-bold ${chordInv === Number(v) ? 'bg-fuchsia-500 text-black' : 'bg-white/5 hover:bg-white/10'}`}>{l}</button>
                   ))}
                 </div>
                 <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Accord posé en un clic</div>
                 {CHORD_CHOICES.map(c => (
                   <button key={c.id} type="button" onClick={() => { setChordKind(c.id); setTool('DRAW'); setMenu(null); setLastChord(null); }} title={c.hint}
                     className={`w-full text-left rounded-lg px-2.5 py-1.5 [@media(pointer:coarse)]:min-h-11 ${chordKind === c.id ? 'bg-fuchsia-500 text-black' : 'hover:bg-white/5'}`}>
                     <b>{c.label}</b> <span className={chordKind === c.id ? 'text-black/70' : 'text-slate-500'}>· {c.hint}</span>
                   </button>
                 ))}
                 <button type="button" onClick={() => { setChordKind(null); setMenu(null); setLastChord(null); }} disabled={!chordKind}
                   className="mt-2 w-full h-9 [@media(pointer:coarse)]:h-11 rounded-lg bg-white/5 border border-white/10 font-bold disabled:opacity-40">Notes simples (couper l'outil accords)</button>
               </div>
             )}
           </div>
         </>
       )}

       <div className="flex-1 flex flex-col overflow-hidden">
          {/* RÈGLE : mesures, boucle, tête de lecture */}
          <div className="flex shrink-0">
            <div className={`flex-shrink-0 ${sideW} pr-ruler border-r border-white/10 flex items-center justify-center text-[9px] font-bold text-slate-400`} title={Math.round(bpmEnd) !== Math.round(bpm) ? `Tempo de ${Math.round(bpm)} à ${Math.round(bpmEnd)} BPM dans ce clip : la grille suit` : `${Math.round(bpm)} BPM`}>{Math.round(bpmEnd) !== Math.round(bpm) ? `${Math.round(bpm)}→${Math.round(bpmEnd)}` : `${Math.round(bpm)} BPM`}</div>
            <Ruler clipStart={clipStart} clipDuration={clip.duration} width={contentWidth} zoomX={zoomX} bpm={bpm} light={light} loop={loop} onSeek={onSeek} onSetLoop={onSetLoop} innerRef={rulerRef} height={touch ? 30 : 22} map={followMap}
              spans={otherClips.filter(o => openClips.includes(o.clip.id)).map(o => ({ id: o.clip.id, start: o.clip.start, end: o.clip.start + o.clip.duration, color: o.track.color || '#94a3b8', label: `${o.clip.name || 'Clip'} · ${o.track.name}`, onClick: () => switchToClip(o.track.id, o.clip.id) }))} />
          </div>
          <div className="flex-1 flex overflow-hidden relative" style={{ minHeight: '60%' }}>

              {/* CLAVIER (ou pads) */}
              <div ref={keysRef} className={`flex-shrink-0 bg-nv-bg border-r border-white/10 overflow-hidden relative z-20 shadow-xl no-scrollbar ${sideW}`}>
                 <div style={{ height: totalRows * currentRowHeight, position: 'relative' }}>
                    {renderKeys()}
                 </div>
              </div>

              {/* GRILLE */}
              <div
                 ref={containerRef}
                 data-nova-roll-grid=""
                 data-nova-zoom={Math.round(zoomX)} data-nova-row-h={rowH} data-nova-clip-start={clipStart}
                 data-nova-rows={anyFold ? rows.join(',') : undefined} data-nova-tool={shownTool}
                 className={`flex-1 overflow-auto relative custom-scroll ${tool === 'ERASE' ? 'cursor-not-allowed' : tool === 'SPLIT' ? 'cursor-col-resize' : tool === 'SELECT' ? 'cursor-default' : 'cursor-crosshair'}`}
                 style={{ touchAction: tool === 'DRAW' ? 'pan-x pan-y' : 'none', backgroundColor: G.white }}
                 onScroll={handleScroll}
                 onPointerDown={handleMouseDown}
                 onContextMenu={e => e.preventDefault()}
              >
                 <div style={{ width: contentWidth, height: totalRows * currentRowHeight, position: 'relative' }}>
                    {renderGridRows()}
                    {/* Temps, mesures, cases de la grille */}
                    {mapLines ? (
                      <svg aria-hidden data-nova-roll-grid-tempo="" data-nova-roll-zoom={zoomX} data-nova-roll-start={clipStart} className="absolute inset-0 pointer-events-none" width={contentWidth} height={totalRows * currentRowHeight} shapeRendering="crispEdges">
                        {mapLines.bars.map((b, i) => (b.bar % 2 === 0 ? <rect key={b.bar} x={(b.time - clipStart) * zoomX} y={0} width={Math.max(0, ((mapLines.bars[i + 1]?.time ?? clipStart + contentWidth / zoomX) - b.time) * zoomX)} height="100%" fill={G.barShade} /> : null))}
                        <path d={mapLines.subs.map(t => `M${((t - clipStart) * zoomX + 0.5).toFixed(2)} 0V${totalRows * currentRowHeight}`).join('')} stroke={G.sub} strokeWidth={1} />
                        <path d={mapLines.beats.map(t => `M${((t - clipStart) * zoomX + 0.5).toFixed(2)} 0V${totalRows * currentRowHeight}`).join('')} stroke={G.beat} strokeWidth={1} />
                        <path data-nova-roll-bars={mapLines.bars.map(b => ((b.time - clipStart) * zoomX).toFixed(2)).join(' ')} d={mapLines.bars.map(b => `M${((b.time - clipStart) * zoomX + 0.5).toFixed(2)} 0V${totalRows * currentRowHeight}`).join('')} stroke={G.bar} strokeWidth={1} />
                      </svg>
                    ) : <div aria-hidden className="absolute inset-0 pointer-events-none" style={gridBg} />}
                    {/* Fin du clip */}
                    <div aria-hidden className="absolute top-0 bottom-0 pointer-events-none" style={{ left: clip.duration * zoomX, right: 0, background: light ? 'rgba(15,23,42,0.06)' : 'rgba(0,0,0,0.28)', borderLeft: `2px solid ${light ? 'rgba(15,23,42,0.35)' : 'rgba(255,255,255,0.25)'}` }} />
                    {/* Piste d'accords (V20) : notes de l'accord en cours surlignées */}
                    <ChordRollOverlay clipStart={clip.start} clipDuration={clip.duration} zoomX={zoomX} rows={rows} rowHeight={currentRowHeight} hidden={isDrumMode} />

                    {/* NOTES FANTÔMES : autres pistes MIDI, non cliquables */}
                    {ghostNotes.map(g => (
                      <div key={`gh-${g.key}`} className="absolute rounded-[2px] pointer-events-none" data-nova-ghost=""
                        style={{ left: g.start * zoomX, top: getYFromPitch(g.pitch) + 2, width: Math.max(4, g.duration * zoomX - 1), height: Math.max(2, currentRowHeight - 4),
                          border: `1px dashed ${g.color}`, backgroundColor: `${g.color}${G.ghostAlpha}`, opacity: 0.55 }} />
                    ))}

                    {/* NOTES DES AUTRES CLIPS OUVERTS (Vue ▾) : à leur place, en couleur ; clic = éditer ce clip */}
                    {openNotes.map(o => (
                      <div key={`oc-${o.key}`} data-nova-open-note={o.clipId} className="absolute rounded-[3px] cursor-pointer"
                        title="Note d’un autre clip ouvert : clic pour éditer ce clip"
                        style={{ left: o.start * zoomX, top: getYFromPitch(o.pitch) + 1, width: Math.max(5, o.duration * zoomX - 1), height: Math.max(3, currentRowHeight - 2),
                          backgroundColor: o.color, opacity: o.muted ? 0.25 : 0.5, border: `1px solid ${light ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.45)'}`, zIndex: 1 }}
                        onPointerDown={e => { if (e.pointerType === 'mouse' && e.button !== 0) return; e.stopPropagation(); switchToClip(o.trackId, o.clipId, o.noteId); }} />
                    ))}

                    {/* Courbes des glissés : de la hauteur de la note tenue à celle du glissé */}
                    {origins.size > 0 && (
                      <svg className="absolute inset-0 pointer-events-none z-[5]" width={contentWidth} height={totalRows * currentRowHeight} aria-hidden>
                        {(clip.notes || []).filter(n => origins.has(n.id)).map(n => {
                          const y0 = getYFromPitch(origins.get(n.id)!) + currentRowHeight / 2;
                          const y1 = getYFromPitch(n.pitch) + currentRowHeight / 2;
                          const x0 = n.start * zoomX, x1 = (n.start + n.duration) * zoomX;
                          return <path key={`sl-${n.id}`} data-nova-slide-curve="" d={`M ${x0} ${y0} C ${(x0 + x1) / 2} ${y0}, ${(x0 + x1) / 2} ${y1}, ${x1} ${y1}`} fill="none" stroke="#fb923c" strokeWidth={2} strokeDasharray="5 3" />;
                        })}
                      </svg>
                    )}

                    {/* NOTES */}
                    {(clip.notes || []).map(note => {
                        const isSelected = selectedNoteIds.has(note.id);
                        const outOfKey = highlight && !inKey(note.pitch);
                        const base = note.muted ? '#475569' : outOfKey ? '#64748b' : prefs.velColors ? velocityColor(note.velocity, light) : (isDrumMode ? '#f97316' : (track.color || '#22d3ee'));
                        const ink = prefs.velColors && !note.muted && !outOfKey ? inkOn(note.velocity, light) : '#000';
                        const w = Math.max(note.slide ? 14 : 5, note.duration * zoomX - 1);
                        return (
                            <div
                                key={note.id}
                                data-nova-note={note.pitch}
                                data-hors-gamme={outOfKey ? '1' : undefined}
                                data-muette={note.muted ? '1' : undefined}
                                data-glisse={note.slide ? '1' : undefined}
                                data-vel={Math.round(note.velocity * 127)}
                                title={`${noteNameFr(note.pitch)} · vélocité ${Math.round(note.velocity * 127)}${note.slide ? ' · glissé' : ''}${outOfKey ? ' · hors gamme' : ''}${note.muted ? ' · muette (Ctrl+M ou l’outil Sourdine pour la réactiver)' : ''}`}
                                className={`absolute rounded-[3px] flex items-center overflow-hidden ${note.slide ? 'pr-note-slide' : ''}`}
                                style={{
                                    left: note.start * zoomX,
                                    top: getYFromPitch(note.pitch) + 1,
                                    width: w,
                                    height: Math.max(3, currentRowHeight - 2),
                                    backgroundColor: base,
                                    border: note.muted ? '1px dashed rgba(148,163,184,0.8)' : outOfKey && !isSelected ? '1px solid rgba(248,113,113,0.7)' : '1px solid rgba(0,0,0,0.35)',
                                    boxShadow: isSelected ? `0 0 0 2px ${light ? '#0b0c0f' : '#ffffff'}, 0 0 8px ${light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.45)'}` : 'inset 0 1px 0 rgba(255,255,255,0.25)',
                                    opacity: toolPreview ? 0.2 : note.muted ? (isSelected ? 0.7 : 0.4) : outOfKey ? 0.6 : 1,
                                    zIndex: isSelected ? 3 : 2,
                                    // Glisser une note au doigt la déplace (pas de défilement)
                                    touchAction: 'none'
                                }}
                            >
                                {!isDrumMode && w > 22 && currentRowHeight >= 11 && <span className="text-[8px] font-bold ml-1.5 pointer-events-none whitespace-nowrap" style={{ color: ink }}>{note.slide ? '↗ ' : ''}{noteNameFr(note.pitch)}</span>}
                                {/* Poignée de durée (bord droit) */}
                                {!isDrumMode && w > 14 && <span aria-hidden className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize" style={{ background: 'rgba(0,0,0,0.18)' }} />}
                            </div>
                        );
                    })}

                    {/* Aperçu d'un outil MIDI (V25) : contours, les notes actuelles s'estompent */}
                    {toolPreview && toolPreview.map(n => (
                      <div key={`pv-${n.id}-${n.start}`} data-nova-preview={n.pitch} className="absolute rounded-[2px] pointer-events-none border-2 border-cyan-300 bg-cyan-300/25 z-10"
                        style={{ left: n.start * zoomX, top: getYFromPitch(n.pitch) + 1, width: Math.max(4, n.duration * zoomX - 1), height: currentRowHeight - 2, opacity: 0.35 + 0.65 * n.velocity }} />
                    ))}

                    {/* Notes en cours de prise au clavier */}
                    {recPreview.map((n, i) => (
                      <div key={`rec-${i}`} className="absolute rounded-[2px] pointer-events-none bg-red-500/80 border border-red-300"
                        style={{ left: n.start * zoomX, top: getYFromPitch(n.pitch) + 1, width: Math.max(4, n.duration * zoomX), height: currentRowHeight - 2 }} />
                    ))}

                    {/* Tête de lecture */}
                    <PianoRollPlayhead clipStart={clip.start} zoomX={zoomX} color={G.playhead} />
                    {/* Curseur de la saisie pas à pas */}
                    {stepOn && <div data-nova-step-cursor={stepPos.toFixed(4)} className="absolute top-0 bottom-0 w-0.5 bg-emerald-400 z-40 pointer-events-none shadow-[0_0_8px_rgba(52,211,153,0.8)]" style={{ left: stepPos * zoomX }} />}

                    {selectionBox && (
                         <div className="absolute border border-cyan-500 bg-cyan-500/20 pointer-events-none z-30" style={{ left: Math.min(selectionBox.startX, selectionBox.endX), top: Math.min(selectionBox.startY, selectionBox.endY), width: Math.abs(selectionBox.endX - selectionBox.startX), height: Math.abs(selectionBox.endY - selectionBox.startY) }} />
                    )}
                 </div>
              </div>
              {/* Clip vide : comment commencer */}
              {nNotes === 0 && !stepOn && !recArmed && (
                <div data-nova-roll="vide" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none max-w-[86%] text-center rounded-xl px-4 py-3 text-[12px] font-semibold shadow-xl"
                  style={{ background: light ? 'rgba(255,255,255,0.94)' : 'rgba(10,11,14,0.88)', color: light ? '#1f2937' : '#e5e7eb', border: `1px solid ${light ? 'rgba(15,23,42,0.15)' : 'rgba(255,255,255,0.12)'}` }}>
                  {touch
                    ? <>Touche la grille pour poser une note.<br /><span className="font-normal opacity-80">Glisse pour défiler, pince pour zoomer, outil Pinceau pour peindre.</span></>
                    : <>Clique dans la grille pour poser une note, glisse pour l’allonger.<br /><span className="font-normal opacity-80">Clic droit : effacer (dans le vide : menu) · double-clic : propriétés · Maj + clic : glissé · Ctrl + molette : zoom</span></>}
                </div>
              )}
          </div>

          {/* Couloirs : vélocité (rampes à la ligne), pitch bend, CC (R16) ; masquables (Vue ▾) */}
          {prefs.lanes !== false && (
          <MidiCcLanes notes={clip.notes || []} cc={clip.cc} duration={clip.duration} zoomX={zoomX} width={contentWidth}
            sideWidth={sideW} selectedIds={selectedNoteIds} color={track.color || '#22d3ee'} innerRef={velocityRef} velColors={prefs.velColors} light={light}
            onNotes={(next, label) => { updateNotes(next); setLastChord(`${label} (Ctrl+Z pour annuler)`); }} onCc={updateClipCc} />
          )}
       </div>
    </div>
  );
};

export default PianoRoll;
