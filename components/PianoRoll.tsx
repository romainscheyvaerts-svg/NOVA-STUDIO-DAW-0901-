
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
import { tempoAt } from '../utils/tempoMap';
import { NoteRecorder, defaultKeyLabel, KEY_TO_SEMITONE, computerKeyboardStore } from '../utils/computerKeyboard';
import { useComputerKeyboard } from './MidiInputHost';
import { midiInput } from '../services/MidiInput';
import MidiCcLanes from './MidiCcLanes';
import { MidiCcPoint } from '../utils/midiCc';
import { StepInput, STEP_VALUES, stepSeconds } from '../utils/stepInput';
import { useTheme } from '../utils/themeStore';
import { useSimpleMode } from '../utils/simpleMode';
import { quantize as quantizeTool } from '../utils/midiTools';
import {
  GRID_CHOICES, gridSec, snapTime as snapGrid, floorTime, newNoteId, paintNotes, splitNoteAt, duplicateRight, copyNotes, pasteNotes,
  NoteClipboard, humanize, toggleSlide, slideOrigins, velocityColor, inkOn,
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
  'pr.copy', 'pr.cut', 'pr.paste', 'pr.left', 'pr.right', 'pr.slide',
  'pr.toolDraw', 'pr.toolPaint', 'pr.toolSelect', 'pr.toolSlice', 'pr.toolErase',
];

type RollTool = 'DRAW' | 'PAINT' | 'SELECT' | 'SPLIT' | 'ERASE';
const TOOLS: { id: RollTool; icon: string; label: string; hint: string }[] = [
  { id: 'DRAW', icon: 'fa-pencil-alt', label: 'Crayon', hint: 'Crayon (P) : clic = une note, glisser = l’allonger, clic droit = effacer, Alt = sans grille (Draw de FL Studio et de Live)' },
  { id: 'PAINT', icon: 'fa-paint-brush', label: 'Pinceau', hint: 'Pinceau (B) : glisse pour peindre des notes à la suite, une par case de grille, idéal pour les hi-hats et la 808 (Paint de FL Studio)' },
  { id: 'SELECT', icon: 'fa-mouse-pointer', label: 'Sélection', hint: 'Sélection (E) : encadre des notes, déplace-les, Maj = ajouter (Select de FL Studio)' },
  { id: 'SPLIT', icon: 'fa-cut', label: 'Couteau', hint: 'Couteau (C) : coupe une note en deux sur la grille ; glisser verticalement coupe plusieurs notes (Slice de FL Studio, Split de Live)' },
  { id: 'ERASE', icon: 'fa-eraser', label: 'Gomme', hint: 'Gomme (D) : clic ou glisser sur les notes pour les effacer' },
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
type RollPrefs = { highlight: boolean; snap: boolean; fold: boolean; ghosts: boolean; preview: boolean; velColors: boolean; advanced?: boolean; gridId: string; magnet: boolean };
const readPrefs = (): RollPrefs => {
  const def: RollPrefs = { highlight: true, snap: false, fold: false, ghosts: true, preview: true, velColors: true, gridId: '1/16', magnet: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
};
const writePrefs = (p: RollPrefs) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } };

/** Presse-papiers des notes, partagé entre les clips (copier dans un clip, coller dans un autre). */
let noteClipboard: NoteClipboard | null = null;

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
}> = ({ clipStart, clipDuration, width, zoomX, bpm, light, loop, onSeek, onSetLoop, innerRef, height }) => {
  const beat = 60 / bpm, bar = beat * 4;
  const barPx = bar * zoomX;
  const every = barPx >= 36 ? 1 : barPx >= 18 ? 2 : barPx >= 9 ? 4 : 8;
  const first = Math.floor(clipStart / bar);
  const last = Math.ceil((clipStart + width / zoomX) / bar);
  const labels: { x: number; n: number }[] = [];
  for (let k = first; k <= last; k++) if ((k % every) === 0) labels.push({ x: (k * bar - clipStart) * zoomX, n: k + 1 });
  const offset = -((clipStart % bar) * zoomX);
  const drag = useRef<{ x0: number; t0: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null);
  const toT = (clientX: number) => {
    const r = (innerRef.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    return Math.max(0, (clientX - (r?.left || 0)) / zoomX);
  };
  const snapBeat = (t: number) => Math.round((clipStart + t) / beat) * beat - clipStart;
  const lineCol = light ? 'rgba(15,23,42,0.35)' : 'rgba(255,255,255,0.28)';
  const tickCol = light ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.14)';
  const shown = draft ? { active: true, start: clipStart + Math.min(draft.a, draft.b), end: clipStart + Math.max(draft.a, draft.b) } : loop;
  return (
    <div ref={innerRef} className="flex-1 overflow-hidden relative pr-ruler" style={{ height }}>
      <div data-nova-roll-ruler="" role="slider" aria-label="Règle des mesures : clic pour placer la lecture, glisser pour une boucle" aria-valuemin={0} aria-valuemax={Math.round(clipDuration)} aria-valuenow={0}
        className="relative h-full cursor-pointer" style={{ width, touchAction: 'none',
          backgroundImage: `linear-gradient(to right, ${lineCol} 1px, transparent 1px), linear-gradient(to right, ${tickCol} 1px, transparent 1px)`,
          backgroundSize: `${barPx}px 100%, ${beat * zoomX}px 40%`, backgroundRepeat: 'repeat-x', backgroundPosition: `${offset}px 0, ${offset}px 100%` }}
        onPointerDown={e => { if (e.pointerType === 'mouse' && e.button !== 0) return; try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* pointeur relâché */ } const t = toT(e.clientX); drag.current = { x0: e.clientX, t0: t, moved: false }; }}
        onPointerMove={e => { const d = drag.current; if (!d || !onSetLoop) return; if (Math.abs(e.clientX - d.x0) > 6) { d.moved = true; setDraft({ a: snapBeat(d.t0), b: snapBeat(toT(e.clientX)) }); } }}
        onPointerUp={e => {
          const d = drag.current; drag.current = null; setDraft(null);
          if (!d) return;
          if (d.moved && onSetLoop) {
            const a = snapBeat(d.t0), b = snapBeat(toT(e.clientX));
            if (Math.abs(b - a) >= beat * 0.99) onSetLoop(clipStart + Math.min(a, b), clipStart + Math.max(a, b), true);
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
        {labels.map(l => (
          <span key={l.n} className="absolute top-0.5 text-[10px] font-bold font-mono pointer-events-none" style={{ left: l.x + 3 }}>{l.n}</span>
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

type DragMode = 'MOVE' | 'RESIZE_R' | 'SELECT' | 'PAINT' | 'ERASE' | 'SLICE' | null;

const PianoRoll: React.FC<PianoRollProps> = ({ track, clipId, bpm: projectBpm, onUpdateTrack, onClose, toolbarExtra, isPlaying, onTogglePlay, projectKey, projectScale, onSetProjectKey, allTracks, loop, onSetLoop, onSeek, metronomeOn, onToggleMetronome }) => {
  const light = useTheme().theme === 'light';
  const G = light ? GRID_THEME.light : GRID_THEME.dark;
  const { simple } = useSimpleMode();
  const clipIndex = track.clips.findIndex(c => c.id === clipId);
  const clip = track.clips[clipIndex];
  // Piste tempo (R2) : la grille et la quantification du clip suivent le tempo à l'endroit du clip.
  const tempoMap = useTempoMap();
  const bpm = Math.abs(tempoMap.segments[0].bpm - projectBpm) < 1e-6 ? tempoAt(tempoMap, clip?.start ?? 0) : projectBpm;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const clipStart = clip?.start || 0;

  const isDrumMode = track.type === TrackType.DRUM_RACK;
  const touch = useMemo(coarsePointer, []);
  const [rowH, setRowH] = useState<number>(() => (isDrumMode ? (touch ? 32 : 24) : (touch ? 22 : 16)));
  const currentRowHeight = rowH;

  // --- PRÉFÉRENCES (gamme, grille, aperçu, couleurs, barre avancée) ---
  const [prefs, setPrefsState] = useState<RollPrefs>(readPrefs);
  const setPrefs = (patch: Partial<RollPrefs>) => setPrefsState(p => { const n = { ...p, ...patch }; writePrefs(n); return n; });
  // Barre avancée : ouverte d'office sur un grand écran hors mode simple, repliée au téléphone (choix mémorisé).
  const advancedOpen = prefs.advanced ?? (!simple && typeof window !== 'undefined' && window.innerWidth >= 1024);

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

  // Lignes affichées, de haut en bas (toutes, ou seulement celles de la gamme).
  const rows = useMemo<number[]>(() => {
    if (isDrumMode) return Array.from({ length: 30 }, (_, i) => 89 - i);
    if (foldOn) return scaleRows(keyRoot!, keyScale, true);
    return Array.from({ length: 128 }, (_, i) => 127 - i);
  }, [isDrumMode, foldOn, keyRoot, keyScale]);
  const rowIndex = useMemo(() => { const m = new Map<number, number>(); rows.forEach((p, i) => m.set(p, i)); return m; }, [rows]);
  const totalRows = rows.length;

  /** Ligne d'une note ; une note hors gamme en mode « seulement la gamme » s'affiche sur la note de gamme juste en dessous. */
  const rowOf = (pitch: number) => {
    const i = rowIndex.get(pitch);
    if (i !== undefined) return i;
    if (foldOn) { const j = rowIndex.get(snapToScale(pitch, keyRoot!, keyScale, 'down')); if (j !== undefined) return j; }
    return Math.max(0, Math.min(rows.length - 1, isDrumMode ? 89 - pitch : 127 - pitch));
  };
  /** Déplace une note de `delta` lignes (en mode gamme : de degré en degré). */
  const shiftPitch = (pitch: number, deltaRows: number) => {
    if (isDrumMode) return Math.max(60, Math.min(89, pitch + deltaRows));
    if (foldOn) return rows[Math.max(0, Math.min(rows.length - 1, rowOf(pitch) - deltaRows))];
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

  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStart, setDragStart] = useState<{ x: number, y: number, time: number, pitch: number, row: number } | null>(null);
  const [initialNotes, setInitialNotes] = useState<MidiNote[]>([]);
  const [selectionBox, setSelectionBox] = useState<{ startX: number, startY: number, endX: number, endY: number } | null>(null);
  const paintRef = useRef<{ cells: Set<number>; added: MidiNote[]; base: MidiNote[] } | null>(null);
  const lastPreviewPitch = useRef<number | null>(null);
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  /** Note qu'on vient de poser au crayon : glisser règle sa fin sous la souris (FL), puis elle est désélectionnée. */
  const drawResizeRef = useRef<{ id: string; moved: boolean } | null>(null);

  // --- OUTILS MIDI (V25) : menu « Outils » avec aperçu, groove, capture ---
  const [toolsAnchor, setToolsAnchor] = useState<{ x: number; y: number } | null | false>(false);
  const [toolPreview, setToolPreview] = useState<MidiNote[] | null>(null);
  const captureCount = useCaptureCount();
  const toolCtx = useMemo(() => ({ bpm, clipStart: clip?.start || 0, keyRoot: hasKey ? keyRoot : undefined, keyScale }), [bpm, clip?.start, hasKey, keyRoot, keyScale]);
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
  const snapTime = useCallback((t: number, free = false) => snapGrid(t, grid, clipStart, magnet && !free), [grid, clipStart, magnet]);
  const cellTime = useCallback((t: number, free = false) => floorTime(t, grid, clipStart, magnet && !free), [grid, clipStart, magnet]);
  const minLen = magnet ? grid : 0.02;

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
  const pendingDrawRef = useRef<{ x: number; y: number; time: number; pitch: number; alt: boolean } | null>(null);
  const addNoteAt = (absTime: number, pitch: number, free = false) => {
    const start = Math.max(0, cellTime(absTime, free));
    const duration = isDrumMode ? Math.max(0.05, Math.min(grid, beatSec / 4)) : (noteLen ?? Math.max(grid, beatSec / 4));
    const mk = (p: number): MidiNote => ({ id: newNoteId(), pitch: p, start, duration, velocity: noteVel, ...(slideDraw && !isDrumMode ? { slide: true } : {}) });
    // Tampon d'accord (Chord Stamp de FL) : toutes les notes de l'accord en un clic.
    if (chordKind && !isDrumMode) {
      const pitches = buildChord(pitch, chordKind, { root: hasKey ? keyRoot : undefined, scale: keyScale, snap: snapOn || chordKind === 'SCALE', inversion: chordInv });
      const notes = pitches.map(p => ({ ...mk(p), slide: undefined }));
      updateNotes([...(clip.notes || []), ...notes]);
      setLastChord(chordLabelFr(pitches));
      playPreview(pitches);
      return notes[0];
    }
    const newNote = mk(snapOn ? snapToScale(pitch, keyRoot!, keyScale) : pitch);
    updateNotes([...(clip.notes || []), newNote]);
    playPreview(newNote.pitch);
    return newNote;
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
    if (e.pointerType === 'mouse' && e.button === 2) {
        e.preventDefault();
        if (clickedNote) deleteNotes([clickedNote.id]);
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
    // Alt+clic sur une note : muette / réactivée (FL : outil Muet).
    if (clickedNote && e.altKey) { toggleMuteNotes([clickedNote.id]); return; }

    // Pinceau : peint des notes à la suite (une par case) en glissant.
    if (tool === 'PAINT' && !clickedNote) {
        const base = clip.notes || [];
        const p = snapOn ? snapToScale(pitch, keyRoot!, keyScale) : pitch;
        const first = paintNotes({ from: cellTime(absTime, e.altKey), to: cellTime(absTime, e.altKey), pitch: p, step: magnet && !e.altKey ? grid : Math.max(grid, 0.05), length: isDrumMode ? Math.min(grid, beatSec / 4) : (noteLen ?? grid), velocity: noteVel, existing: base, slide: slideDraw && !isDrumMode });
        paintRef.current = { cells: new Set(first.map(n => Math.round((clipStart + n.start) / grid))), added: first, base };
        if (first.length) { updateNotes([...base, ...first]); playPreview(p); lastPreviewPitch.current = p; }
        setDragMode('PAINT');
        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        return;
    }

    // Crayon sur une case vide : pose une note (Ctrl+glisser = encadrer, comme dans FL).
    if ((tool === 'DRAW' || tool === 'PAINT') && !clickedNote) {
        if (e.ctrlKey || e.metaKey) { if (!isTouch) startBoxSelect(e, x, y, scrollLeft, scrollTop); return; }
        if (isTouch) { pendingDrawRef.current = { x: e.clientX, y: e.clientY, time: absTime, pitch, alt: e.altKey }; return; }
        const n = addNoteAt(absTime, pitch, e.altKey);
        // Glisser après le clic allonge la note posée (longueur au tracé).
        if (!isDrumMode && !chordKind) {
            setSelectedNoteIds(new Set([n.id]));
            setInitialNotes([...(clip.notes || []), n]);
            drawResizeRef.current = { id: n.id, moved: false };
            setDragMode('RESIZE_R');
            setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch, row });
        }
        return;
    }

    if (clickedNote) {
        // Double clic (ou double touche) sur une note au crayon : effacée (Live : clic en mode dessin).
        const now = performance.now();
        if ((tool === 'DRAW' || tool === 'PAINT') && lastTap.current && lastTap.current.id === clickedNote.id && now - lastTap.current.t < 350) {
          lastTap.current = null;
          deleteNotes([clickedNote.id]);
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
        // Les prochaines notes prennent sa longueur et sa vélocité (FL Studio).
        setNoteLen(clickedNote.duration);
        setNoteVel(clickedNote.velocity);

        // Poignée de durée : les 8 px de droite (16 px au doigt) ; une note courte se rallonge par son tiers droit (sa moitié au doigt).
        const edge = isTouch ? 16 : 8;
        const wPx = clickedNote.duration * zoomX;
        const fromEnd = (clickedNote.start + clickedNote.duration) * zoomX - absTime * zoomX;
        const isRightEdge = wPx > edge * 2 ? fromEnd < edge : fromEnd < wPx / (isTouch ? 2 : 3);

        setInitialNotes(clip.notes || []);
        if (isRightEdge && !isDrumMode) setDragMode('RESIZE_R');
        else setDragMode('MOVE');

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
        const updatedNotes = initialNotes.map(n => {
            if (selectedNoteIds.has(n.id)) {
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
        const dr = drawResizeRef.current;
        if (dr && Math.abs(dx) > 3) dr.moved = true;
        const updatedNotes = initialNotes.map(n => {
            // Note qu'on vient de poser : sa fin suit la souris (FL Studio), au moins une case.
            if (dr && dr.id === n.id) {
                if (!dr.moved) return n;
                const free = e.altKey || !magnet;
                const end = free ? absTime : snapTime(absTime);
                const d = Math.max(free ? 0.02 : minLen, end - n.start);
                len = d;
                return { ...n, duration: d };
            }
            if (selectedNoteIds.has(n.id)) {
                let newDuration = Math.max(0.02, n.duration + deltaTime);
                const free = e.altKey || !magnet;
                if (!free) newDuration = Math.max(minLen, snapTime(n.start + newDuration) - n.start);
                len = newDuration;
                return { ...n, duration: newDuration };
            }
            return n;
        });
        updateNotes(updatedNotes);
        if (len !== null) setNoteLen(len);
    }
    else if (dragMode === 'PAINT' && paintRef.current) {
        const pr = paintRef.current;
        const step = grid;
        const cell = Math.floor((clipStart + absTime) / step + 1e-9);
        if (absTime >= 0 && !pr.cells.has(cell)) {
            pr.cells.add(cell);
            const raw = rows[row];
            const p = snapOn ? snapToScale(raw, keyRoot!, keyScale) : raw;
            const [n] = paintNotes({ from: cell * step - clipStart, to: cell * step - clipStart, pitch: p, step, length: isDrumMode ? Math.min(grid, beatSec / 4) : (noteLen ?? grid), velocity: noteVel, existing: pr.base, slide: slideDraw && !isDrumMode });
            if (n) {
              pr.added = [...pr.added, n];
              updateNotes([...pr.base, ...pr.added]);
              if (p !== lastPreviewPitch.current || isDrumMode) { lastPreviewPitch.current = p; playPreview(p); }
            }
        }
    }
    else if (dragMode === 'ERASE') {
        const hit = noteAt(absTime, row);
        if (hit) deleteNotes([hit.id]);
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
  }, [dragMode, dragStart, initialNotes, selectedNoteIds, zoomX, grid, magnet, bpm, selectionBox, clip.notes, currentRowHeight, rows, noteLen, noteVel, slideDraw, prefs.preview, snapTime, snapOn, foldOn, keyRoot, keyScale]);

  const handleMouseUp = (e?: Event) => {
    const pending = pendingDrawRef.current;
    pendingDrawRef.current = null;
    if (pending && e && e.type === 'pointerup' && !pinchRef.current) {
        const pe = e as PointerEvent;
        if (Math.hypot(pe.clientX - pending.x, pe.clientY - pending.y) < 10) addNoteRef.current(pending.time, pending.pitch, pending.alt);
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

  // --- ZOOM : Ctrl + molette (horizontal, centré sur la souris), Ctrl + Maj + molette (vertical),
  // Alt + molette sur une note : vélocité (FL Studio) ; pincer à deux doigts au téléphone.
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
    const d = e.deltaY < 0 ? 0.04 : -0.04;
    updateNotes(notesRef.current.map(n => (ids.has(n.id) ? { ...n, velocity: Math.max(0.01, Math.min(1, n.velocity + d)) } : n)));
    setLastChord(`Vélocité ${Math.round(Math.max(0.01, Math.min(1, hit.velocity + d)) * 127)} (Alt + molette)`);
    return true;
  };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) { if (wheelVelRef.current(e)) e.preventDefault(); return; }
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015);
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
      if (!target.length) { setLastChord('Sélectionne des notes, puis Ctrl+M (ou Alt+clic sur une note) pour les rendre muettes.'); return; }
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
    updateNotes(next);
    const k = sel ? sel.size : all.length;
    setLastChord(`${k} note${k > 1 ? 's' : ''} quantifiée${k > 1 ? 's' : ''} sur ${GRID_CHOICES.find(g => g.id === gridId)?.label} · force ${quantizeStrength} %${quantizeSwing > 50 ? ` · swing ${quantizeSwing} %` : ''} (Ctrl+Z pour annuler)`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, gridId, quantizeStrength, quantizeSwing, quantizeEnds, bpm, clip.notes, clipStart]);

  // --- SELECT ALL ---
  const selectAll = useCallback(() => {
    setSelectedNoteIds(new Set((clip.notes || []).map(n => n.id)));
  }, [clip.notes]);

  // --- DUPLIQUER À LA SUITE (FL : Ctrl+B, Live : Ctrl+D) ---
  const doubleNotes = useCallback(() => {
    if (selectedNoteIds.size === 0) { setLastChord('Sélectionne des notes (Ctrl+A : tout), puis Ctrl+B pour les recopier à la suite.'); return; }
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
  const paste = () => {
    if (!noteClipboard) { setLastChord('Rien à coller : copie d’abord des notes (Ctrl+C).'); return; }
    const head = audioEngine.getCurrentTime() - clipStart;
    const all = clip.notes || [];
    // À la tête de lecture si elle est dans le clip, sinon après la dernière note (à la mesure).
    const after = all.length ? Math.ceil(Math.max(...all.map(n => n.start + n.duration)) / barSec - 1e-6) * barSec : 0;
    const at = head >= 0 && head < clip.duration ? snapTime(head) : after;
    const res = pasteNotes(all, noteClipboard, Math.max(0, at));
    updateNotes(res.notes);
    setSelectedNoteIds(new Set(res.added.map(n => n.id)));
    setLastChord(`${res.added.length} note${res.added.length > 1 ? 's' : ''} collée${res.added.length > 1 ? 's' : ''} (Ctrl+Z pour annuler)`);
  };

  // --- DÉPLACER LA SÉLECTION D'UNE CASE (← / →, Live) ---
  const nudge = (dir: number) => {
    if (!selectedNoteIds.size) return;
    updateNotes((clip.notes || []).map(n => (selectedNoteIds.has(n.id) ? { ...n, start: Math.max(0, n.start + dir * grid) } : n)));
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
  const humanizeNotes = useCallback(() => {
    const all = clip.notes || [];
    if (!all.length) return;
    const sel = selectedNoteIds.size > 0 ? selectedNoteIds : null;
    updateNotes(humanize(all, sel, { timingMs: 12, velocity: 0.08, length: 0.05, seed: Date.now() & 0xffffff }));
    const k = sel ? sel.size : all.length;
    setLastChord(`${k} note${k > 1 ? 's' : ''} humanisée${k > 1 ? 's' : ''} : petits écarts de temps et de vélocité (Ctrl+Z pour annuler)`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, clip.notes]);

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
  const liveRef = useRef({ track, clip, isPlaying: !!isPlaying });
  liveRef.current = { track, clip, isPlaying: !!isPlaying };

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
    const played = rec.finish(clipTimeNow()).filter(n => n.start >= 0);
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
        if (!c.notes?.length) continue;
        for (const n of c.notes) {
          const start = c.start + n.start - clip.start;
          if (start + n.duration < 0 || start > span) continue;
          out.push({ key: `${t.id}:${c.id}:${n.id}`, pitch: n.pitch, start, duration: n.duration, color: t.color || '#94a3b8', name: t.name });
          if (out.length >= 3000) return out;
        }
      }
    }
    return out;
  }, [prefs.ghosts, isDrumMode, allTracks, track.id, clip.start, clip.duration]);
  const ghostTrackCount = useMemo(() => new Set(ghostNotes.map(g => g.name)).size, [ghostNotes]);

  // Glissés portés : d'où part chaque glissé (courbe dessinée).
  const origins = useMemo(() => slideOrigins(clip?.notes || []), [clip?.notes]);

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
        case 'pr.close': e.preventDefault(); onClose(); return;
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
        case 'pr.slide': e.preventDefault(); slideAction(); return;
        case 'pr.toolDraw': e.preventDefault(); setTool('DRAW'); return;
        case 'pr.toolPaint': e.preventDefault(); setTool('PAINT'); return;
        case 'pr.toolSelect': e.preventDefault(); setTool('SELECT'); return;
        case 'pr.toolSlice': e.preventDefault(); setTool('SPLIT'); return;
        case 'pr.toolErase': e.preventDefault(); setTool('ERASE'); return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, applyQuantize, selectAll, doubleNotes, transpose, humanizeNotes, onClose, clip.notes, grid, slideDraw, isDrumMode]);

  // Saisie pas à pas : Tab = silence, Retour arrière = effacer le dernier pas (avant les autres raccourcis).
  useEffect(() => {
    if (!stepOn) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); if (stepRef.current) applyStepRef.current(stepRef.current.rest()); }
      else if (e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); if (stepRef.current) applyStepRef.current(stepRef.current.back()); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stepOn]);

  // --- CLAVIER VERTICAL (touches blanches et noires) ou PADS ---
  const renderKeys = () => {
      if (isDrumMode) {
          return Array.from({ length: 30 }).map((_, i) => {
              const padId = 30 - i;
              const pitch = 59 + padId;
              const pad = track.drumPads?.find(p => p.id === padId);
              const label = pad ? (pad.sampleName !== 'Empty' ? pad.sampleName : `Pad ${padId}`) : `Pad ${padId}`;
              return (
                <div
                    key={padId}
                    className="flex items-center justify-between px-2 text-[10px] font-bold border-b border-black/20 box-border bg-nv-raised text-slate-400 hover:bg-nv-raised hover:text-white cursor-pointer truncate"
                    style={{ height: currentRowHeight }}
                    onPointerDown={() => { try { audioEngine.triggerTrackAttack(track.id, pitch, 0.9); } catch { /* moteur pas prêt */ } }}
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
        const showName = (foldOn || isC || isRoot) && currentRowHeight >= 10;
        const isHeld = held.has(pitch);
        const whiteBg = isHeld && !isBlack ? K.held : (out && !isBlack ? K.whiteOut : K.white);
        const blackBg = isHeld ? K.held : (out ? K.blackOut : K.black);
        const ink = isHeld ? '#000' : isBlack && foldOn ? (isRoot ? K.rootOnBlack : K.nameOnBlack) : (isRoot ? K.rootOnWhite : K.nameOnWhite);
        // Séparation entre deux touches blanches voisines (Mi | Fa et Si | Do) plus marquée.
        const pc = ((pitch % 12) + 12) % 12;
        const border = pc === 0 || pc === 5 ? '1px solid rgba(0,0,0,0.35)' : '1px solid rgba(0,0,0,0.12)';
        return (
            <div
                key={pitch}
                data-pitch={pitch}
                data-hors-gamme-touche={hasKey && highlight ? (out ? '1' : '0') : undefined}
                className="relative flex items-center justify-end pr-1 text-[9px] font-mono box-border cursor-pointer"
                style={{ height: currentRowHeight, backgroundColor: foldOn && isBlack ? blackBg : whiteBg, color: ink, borderBottom: foldOn ? '1px solid rgba(0,0,0,0.22)' : (isBlack ? 'none' : border) }}
                title={`${noteNameFr(pitch)}${hasKey ? (out ? ' · hors gamme' : ' · dans la gamme') : ''} (clic : écouter)`}
                onPointerDown={() => { if (stepOn) { midiInput.noteOn(pitch, 100, { source: 'screen', trackId: track.id }); midiInput.noteOff(pitch, { source: 'screen', trackId: track.id }); } else { try { audioEngine.previewMidiNote(track.id, pitch, 0.4); } catch { /* moteur pas prêt */ } } }}
            >
                {isBlack && !foldOn && (
                  <span aria-hidden className="absolute left-0 top-0 bottom-0 rounded-r-[3px]"
                    style={{ width: '62%', background: isHeld ? K.held : `linear-gradient(90deg, ${blackBg} 0%, ${blackBg} 80%, ${out ? '#3b414c' : '#2a2d33'} 100%)`, boxShadow: '1px 1px 2px rgba(0,0,0,0.45)' }} />
                )}
                {isRoot && !isHeld && <span className="relative w-1.5 h-1.5 rounded-full mr-auto ml-1" style={{ backgroundColor: '#f59e0b', marginLeft: isBlack && !foldOn ? '66%' : undefined }} aria-hidden />}
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
         const octave = !isDrumMode && !foldOn && pitch % 12 === 0;
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
  }, [isDrumMode, foldOn]);

  const contentWidth = Math.max((clip.duration + 4) * zoomX, 2000);
  const sideW = isDrumMode ? 'w-32' : 'w-16';
  const barPx = barSec * zoomX, beatPx = beatSec * zoomX, gridPx = grid * zoomX;
  const gridOffset = -((clipStart % barSec) * zoomX);
  const nNotes = (clip.notes || []).length;
  const hasSel = selectedNoteIds.size > 0;
  const gridLabel = GRID_CHOICES.find(g => g.id === gridId)?.label || gridId;
  const TOGGLE = (on: boolean) => ({ 'aria-pressed': on });
  // Grille des temps : fond en dégradés (mesures, temps, cases), sans milliers de traits dans le DOM.
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
       {/* BARRE PRINCIPALE : l'essentiel, utilisable tout de suite (débutant) ; le bouton Fermer reste à droite. */}
       <div data-nova-roll="barre" className="pr-bar min-h-14 flex items-center gap-2 px-3 shrink-0">
       <div className="flex-1 min-w-0 h-full flex items-center justify-between gap-3 overflow-x-auto no-scrollbar py-1.5">
          <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="md:hidden shrink-0 w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center"><i className="fas fa-times"></i></button>
          <div className="flex items-center gap-2.5 shrink-0">
             <div className="hidden sm:flex items-center space-x-2">
                <div className={`w-8 h-8 rounded flex items-center justify-center border ${isDrumMode ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-green-500/20 text-green-400 border-green-500/30'}`}>
                    <i className={`fas ${isDrumMode ? 'fa-drum' : 'fa-keyboard'}`}></i>
                </div>
                <div>
                    <h3 className="text-[10px] font-black text-white uppercase tracking-widest">{isDrumMode ? 'Séquenceur de batterie' : 'Piano roll'}</h3>
                    <p className="text-[9px] text-slate-500 font-mono max-w-[120px] truncate">{clip.name}</p>
                </div>
             </div>

             {onTogglePlay && (
               <button type="button" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Lecture'} title="Écouter / pause (barre d'espace)"
                 className={`shrink-0 w-10 h-10 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 rounded-full flex items-center justify-center ${isPlaying ? 'bg-cyan-400 text-black' : 'bg-white text-black'}`}>
                 <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-sm`}></i>
               </button>
             )}
             {onSetLoop && (
               <button type="button" data-nova-roll="boucle" className="pr-cap" {...TOGGLE(loopOnClip)} onClick={toggleClipLoop}
                 title="Boucler le clip : la lecture tourne sur ce clip (sur la règle, glisse pour choisir une autre boucle)" aria-label="Boucler le clip">
                 <i className="fas fa-redo text-[10px]"></i><span className="hidden min-[1500px]:inline">Boucle</span>
               </button>
             )}

             {/* Son de la piste (mode instru : synthé NOVA, instrument VST du PC, 808) */}
             {toolbarExtra}

             <div className="pr-sep"></div>

             {/* Outils (FL Studio : P, B, E, C, D) */}
             <div className="pr-seg" role="radiogroup" aria-label="Outil">
               {TOOLS.map(t => (
                 <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} aria-pressed={tool === t.id} data-tool={t.id} data-nova-roll-tool={t.id}
                   onClick={() => setTool(t.id)} title={t.hint} aria-label={t.label} className="pr-cap">
                   <i className={`fas ${t.icon} text-[11px]`}></i>
                 </button>
               ))}
             </div>

             {/* Grille, magnétisme, quantification (force, swing) */}
             <button
               onClick={e => {
                 if (showQuantizeMenu) { setShowQuantizeMenu(false); return; }
                 const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                 setQuantPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - 288)), y: r.bottom + 6 });
                 setShowQuantizeMenu(true);
               }}
               data-nova-roll="grille" aria-haspopup="dialog" aria-expanded={showQuantizeMenu} title="Grille de quantification et force"
               className="pr-cap"
             >
               <i className={`fas ${magnet ? 'fa-magnet' : 'fa-th'} text-[10px]`} style={{ color: magnet ? '#c084fc' : undefined }}></i>
               <span>{magnet ? gridLabel : 'Libre'}</span>
               <i className="fas fa-chevron-down text-[8px]"></i>
             </button>

             {/* Gamme, accords, glissés (V14, 15/10) */}
             {!isDrumMode && (
               <div className="flex items-center gap-1.5 shrink-0">
                 <button type="button" data-nova-roll="gamme" onClick={e => openMenu('scale', e)} aria-expanded={menu?.kind === 'scale'}
                   title="Gamme du morceau : grise les notes hors gamme, aimant, seulement la gamme (comme Scale Highlighting dans FL Studio et Scale Mode dans Live)"
                   className={`pr-cap ${hasKey ? '!bg-amber-500/15 !border-amber-500/50 !text-amber-300' : ''}`}>
                   <i className="fas fa-music text-[9px]"></i>
                   <span>{hasKey ? keyLabelFr(keyRoot, keyScale) : 'Gamme'}</span>
                   {snapOn && <i className="fas fa-magnet text-[8px]" title="Aimant de gamme actif"></i>}
                   <i className="fas fa-chevron-down text-[8px]"></i>
                 </button>
                 <button type="button" data-nova-roll="accords" aria-label="Outil accords" onClick={e => openMenu('chord', e)} aria-pressed={!!chordKind}
                   title="Outil accords : un clic pose tout l'accord, dans la gamme, avec renversements (comme Chord Stamp dans FL Studio)"
                   className={`pr-cap ${chordKind ? '!bg-fuchsia-500 !text-black' : ''}`}>
                   <i className="fas fa-layer-group text-[9px]"></i>
                   <span className={chordKind ? '' : 'hidden min-[1500px]:inline'}>{chordKind ? CHORD_CHOICES.find(c => c.id === chordKind)?.label : 'Accords'}</span>
                 </button>
                 <button type="button" data-nova-roll="glisse" aria-label="Glissés (slide)" onClick={slideAction} aria-pressed={slideDraw}
                   title="Glissé (S) : une note glissée posée pendant une note tenue la fait glisser jusqu'à sa hauteur, sans se rejouer, sur sa propre durée (Slide de FL Studio : la 808 et les leads trap). Avec une sélection : bascule ces notes ; sans : les prochaines notes posées seront glissées."
                   className={`pr-cap ${slideDraw ? '!bg-orange-400 !text-black' : ''}`}>
                   <i className="fas fa-level-up-alt text-[10px] rotate-90"></i><span className="hidden min-[1500px]:inline">Glissé</span>
                 </button>
               </div>
             )}

             <button type="button" data-nova-roll="apercu" className="pr-cap" {...TOGGLE(prefs.preview)} onClick={() => setPrefs({ preview: !prefs.preview })}
               aria-label="Entendre les notes en les posant" title={prefs.preview ? 'Aperçu du son ACTIF : chaque note posée, déplacée ou cliquée se fait entendre (Preview de FL Studio et Live). Clic pour couper.' : 'Aperçu du son coupé : clic pour entendre les notes en les posant.'}>
               <i className={`fas ${prefs.preview ? 'fa-volume-up' : 'fa-volume-mute'} text-[10px]`}></i>
             </button>

             {!isDrumMode && (
               <>
                 <button type="button" data-nova-roll="clavier" aria-label="Jouer avec le clavier de l'ordinateur" onClick={() => { setKbOn(v => !v); if (kbOn) setRecArmed(false); }} aria-pressed={kbOn}
                   title={kbOn ? "Clavier de l'ordinateur ACTIF : les lettres jouent des notes. Clic pour le couper et retrouver les raccourcis." : "Jouer avec le clavier de l'ordinateur (comme Computer MIDI Keyboard dans Live et Typing Keyboard dans FL Studio)"}
                   className={`pr-cap ${kbOn ? '!bg-cyan-400 !text-black' : ''}`}>
                   <i className="fas fa-keyboard text-[9px]"></i><span className="hidden min-[1800px]:inline">{kbOn ? 'Clavier actif' : 'Clavier'}</span>
                 </button>
                 {kbOn && (
                   <button type="button" data-nova-roll="rec-midi" aria-label="Enregistrer ce que tu joues" onClick={() => { const on = !recArmed; setRecArmed(on); if (on && !isPlaying) onTogglePlay?.(); }} aria-pressed={recArmed}
                     title={recArmed ? 'Prise MIDI armée : ce que tu joues pendant la lecture s’écrit dans le clip (à l’arrêt). Clic pour désarmer.' : 'Enregistrer ce que tu joues au clavier dans le clip (lance la lecture)'}
                     className={`pr-cap !font-black ${recArmed ? '!bg-red-600 !text-white animate-pulse' : '!text-red-400'}`}>
                     <span className={`w-2 h-2 rounded-full ${recArmed ? 'bg-white' : 'bg-red-500'}`}></span><span className="hidden min-[1500px]:inline">{recArmed ? 'Prise…' : 'Enregistrer'}</span>
                   </button>
                 )}
               </>
             )}
          </div>

          {/* À droite : compte, zoom, outils avancés */}
          <div className="flex items-center gap-2 shrink-0">
             <div className="text-[10px] text-slate-400 whitespace-nowrap" role="status">
                {hasSel ? <span className="text-cyan-400 font-bold">{selectedNoteIds.size} sélectionnée{selectedNoteIds.size > 1 ? 's' : ''}</span> : <span>{nNotes} note{nNotes > 1 ? 's' : ''}</span>}
             </div>
             <div className="flex items-center gap-1">
                <button type="button" className="pr-cap !px-0" aria-label="Dézoomer" title="Dézoomer (Ctrl + molette, ou pincer)" onClick={() => setZoomAt(zoomX / 1.25)}><i className="fas fa-search-minus text-[10px]"></i></button>
                <input type="range" aria-label="Zoom horizontal" title="Zoom horizontal (Ctrl + molette)" min="20" max="600" value={zoomX}
                  onChange={(e) => setZoomX(parseInt(e.target.value))} className="hidden lg:block w-20 accent-cyan-500" />
                <button type="button" className="pr-cap !px-0" aria-label="Zoomer" title="Zoomer (Ctrl + molette, ou pincer)" onClick={() => setZoomAt(zoomX * 1.25)}><i className="fas fa-search-plus text-[10px]"></i></button>
             </div>
             <button type="button" data-nova-roll="plus" className="pr-cap" aria-expanded={advancedOpen} aria-controls="nova-roll-avancee" {...TOGGLE(advancedOpen)}
               onClick={() => setPrefs({ advanced: !advancedOpen })}
               title={advancedOpen ? 'Replier les outils avancés' : 'Outils avancés : quantifier, dupliquer, copier, humaniser, pas à pas, transformations, swing, métronome, .mid…'}>
               <i className="fas fa-sliders-h text-[10px]"></i><span>{advancedOpen ? 'Moins' : 'Plus'}</span>
             </button>
          </div>
       </div>
          <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="hidden md:flex shrink-0 w-8 h-8 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-red-500/20 items-center justify-center"><i className="fas fa-times"></i></button>
       </div>

       {/* BARRE AVANCÉE (repliable) : outils de pro, cachés en mode simple et au téléphone par défaut. */}
       {advancedOpen && (
         <div id="nova-roll-avancee" data-nova-roll="barre-avancee" className="pr-bar shrink-0 px-3 py-1.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
            <button type="button" onClick={applyQuantize} disabled={!nNotes} aria-label="Quantifier la sélection" className="pr-cap" data-nova-roll="quantifier"
              title={`Quantifier ${hasSel ? 'la sélection' : 'tout le clip'} sur ${gridLabel}, force ${quantizeStrength} %${quantizeSwing > 50 ? `, swing ${quantizeSwing} %` : ''} (Q)`}>
              <i className="fas fa-magnet text-[9px]"></i><span>Q</span>
            </button>
            <div className="pr-sep"></div>
            <button type="button" onClick={() => transpose(1)} disabled={!hasSel} className="pr-cap" title="Monter d'un demi-ton (↑)" aria-label="Monter d'un demi-ton"><i className="fas fa-arrow-up text-[10px]"></i></button>
            <button type="button" onClick={() => transpose(-1)} disabled={!hasSel} className="pr-cap" title="Descendre d'un demi-ton (↓)" aria-label="Descendre d'un demi-ton"><i className="fas fa-arrow-down text-[10px]"></i></button>
            <button type="button" onClick={() => transpose(12)} disabled={!hasSel} className="pr-cap" title="Monter d'une octave (Ctrl+↑)" aria-label="Monter d'une octave">+8ve</button>
            <button type="button" onClick={() => transpose(-12)} disabled={!hasSel} className="pr-cap" title="Descendre d'une octave (Ctrl+↓)" aria-label="Descendre d'une octave">−8ve</button>
            <div className="pr-sep"></div>
            <button type="button" onClick={selectAll} disabled={!nNotes} className="pr-cap" data-nova-roll="tout" title="Tout sélectionner (Ctrl+A)" aria-label="Tout sélectionner"><i className="fas fa-object-group text-[10px]"></i></button>
            <button type="button" onClick={doubleNotes} disabled={!hasSel} className="pr-cap" data-nova-roll="dupliquer" title="Dupliquer la sélection à la suite (Ctrl+B comme FL Studio, Ctrl+D comme Live)" aria-label="Dupliquer la sélection à la suite">
              <i className="fas fa-clone text-[10px]"></i><span>2x</span>
            </button>
            <button type="button" onClick={() => copySel(false)} disabled={!hasSel} className="pr-cap" title="Copier les notes (Ctrl+C)" aria-label="Copier les notes"><i className="fas fa-copy text-[10px]"></i></button>
            <button type="button" onClick={paste} className="pr-cap" title="Coller à la tête de lecture (Ctrl+V)" aria-label="Coller les notes"><i className="fas fa-paste text-[10px]"></i></button>
            <button type="button" onClick={() => deleteNotes(Array.from(selectedNoteIds))} disabled={!hasSel} className="pr-cap" title="Effacer la sélection (Suppr)" aria-label="Effacer la sélection"><i className="fas fa-trash text-[10px]"></i></button>
            <button type="button" onClick={humanizeNotes} disabled={!nNotes} className="pr-cap" data-nova-roll="humaniser" title="Humaniser : petits écarts de placement, de vélocité et de longueur, un accord bouge d'un bloc (H)" aria-label="Humaniser">
              <i className="fas fa-random text-[10px]"></i><span>H</span>
            </button>
            <button type="button" data-nova-roll="muet" onClick={() => toggleMuteNotes()} disabled={!hasSel} className="pr-cap"
              title="Rendre muettes (ou réactiver) les notes sélectionnées, sans les effacer (Ctrl+M, ou Alt+clic sur une note ; Mute Notes, FL : outil Muet)" aria-label="Rendre muettes les notes sélectionnées">
              <i className="fas fa-volume-mute text-[10px]"></i><span className="hidden min-[1800px]:inline">Muet</span>
            </button>
            <div className="pr-sep"></div>
            <button type="button" data-nova-roll="pas-a-pas" onClick={() => setStepOn(v => !v)} aria-pressed={stepOn} className={`pr-cap ${stepOn ? '!bg-emerald-400 !text-black' : '!text-emerald-300'}`}
              title="Saisie pas à pas : chaque note jouée (clavier MIDI, clavier de l'ordinateur ou touches à l'écran) avance d'une valeur choisie, sans lecture (MIDI Step Input, FL : Step recording)" aria-label="Saisie pas à pas">
              <i className="fas fa-shoe-prints text-[10px]"></i><span>Pas à pas</span>
            </button>
            <button type="button" data-nova-roll="outils" aria-label="Outils MIDI" aria-haspopup="dialog" aria-expanded={toolsAnchor !== false}
              onClick={e => { if (toolsAnchor !== false) { setToolsAnchor(false); return; } const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setToolsAnchor(window.innerWidth < 640 ? null : { x: r.left, y: r.bottom + 6 }); }}
              title="Transformations : strum, arpège, roll de hi-hats, chop, flam, courbe de vélocité, aléatoire, legato… sur la sélection ou tout le clip (comme les MIDI Transformations de Live 12 et les outils du piano roll de FL Studio)"
              className={`pr-cap ${toolsAnchor !== false ? '!bg-cyan-400 !text-black' : ''}`}>
              <i className="fas fa-toolbox text-[10px]"></i><span>Outils</span>
            </button>
            <button type="button" data-nova-roll="groove" aria-label="Swing et groove du clip" onClick={() => midiBus.emit({ type: 'groove', trackId: track.id, clipId })} aria-pressed={!!clip.groove}
              title="Swing et groove de ce clip : 50 à 75 %, grooves MPC et trap, groove extrait d’une boucle (Groove Pool de Live, swing de FL Studio)"
              className={`pr-cap ${clip.groove ? '!bg-amber-400 !text-black' : '!text-amber-300'}`}>
              <i className="fas fa-drum text-[10px]"></i><span className="hidden min-[1500px]:inline">Swing</span>
            </button>
            <button type="button" data-nova-roll="capturer" aria-label="Capturer ce que je viens de jouer" onClick={() => midiBus.emit({ type: 'capture', trackId: track.id })} title={CAPTURE_HINT}
              className={`relative pr-cap ${captureCount > 0 ? '!text-red-200 !border-red-400/50' : ''}`}>
              <i className="fas fa-hand-sparkles text-[10px]"></i><span className="hidden min-[1800px]:inline">Capturer</span>
              {captureCount > 0 && <span className="ml-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-black leading-4 text-center">{captureCount > 99 ? '99+' : captureCount}</span>}
            </button>
            {onToggleMetronome && (
              <button type="button" data-nova-roll="metronome" className="pr-cap" {...TOGGLE(!!metronomeOn)} onClick={onToggleMetronome} aria-label="Métronome"
                title="Métronome : le clic pendant la lecture et la prise (la barre de transport est cachée sous l'éditeur)">
                <i className="fas fa-stopwatch text-[10px]"></i><span className="hidden min-[1500px]:inline">Clic</span>
              </button>
            )}
            <div className="pr-sep"></div>
            {!isDrumMode && (
              <button type="button" data-nova-roll="fantomes" aria-label="Notes fantômes" onClick={() => setPrefs({ ghosts: !prefs.ghosts })} {...TOGGLE(prefs.ghosts)} className="pr-cap"
                title={`Notes fantômes : les notes des autres pistes MIDI en filigrane, pour écrire la 808 en voyant la mélodie (comme Ghost Notes dans FL Studio)${ghostTrackCount ? ` · ${ghostTrackCount} piste${ghostTrackCount > 1 ? 's' : ''}` : ''}`}>
                <i className="fas fa-ghost text-[10px]"></i><span className="hidden min-[1800px]:inline">Fantômes</span>
              </button>
            )}
            <button type="button" data-nova-roll="couleurs" aria-label="Couleur des notes selon la vélocité" onClick={() => setPrefs({ velColors: !prefs.velColors })} {...TOGGLE(prefs.velColors)} className="pr-cap"
              title={prefs.velColors ? 'Couleurs selon la vélocité : violet = doux, rouge = fort (comme Logic et Studio One). Clic : couleur de la piste.' : 'Couleur de la piste. Clic : couleurs selon la vélocité.'}>
              <i className="fas fa-palette text-[10px]"></i>
            </button>
            <button type="button" className="pr-cap" aria-label="Lignes moins hautes" title="Zoom vertical : lignes moins hautes (Ctrl + Maj + molette)" onClick={() => setRowHAt(rowH - 3)}><i className="fas fa-compress-alt text-[10px] rotate-[-45deg]"></i></button>
            <button type="button" className="pr-cap" aria-label="Lignes plus hautes" title="Zoom vertical : lignes plus hautes (Ctrl + Maj + molette)" onClick={() => setRowHAt(rowH + 3)}><i className="fas fa-expand-alt text-[10px] rotate-[-45deg]"></i></button>
            <div className="pr-sep"></div>
            <button type="button" className="pr-cap" data-nova-roll="mid-export" disabled={!nNotes} onClick={() => midiBus.emit({ type: 'export', scope: 'clip', trackId: track.id, clipId })}
              title="Exporter ce clip en fichier .mid (pour un autre DAW)" aria-label="Exporter le clip en .mid"><i className="fas fa-file-export text-[10px]"></i><span>.mid</span></button>
            <button type="button" className="pr-cap" data-nova-roll="mid-import" onClick={() => midiBus.emit({ type: 'import-pick', trackId: track.id })}
              title="Importer un .mid sur cette piste (pack MIDI, mélodie d’un autre DAW)" aria-label="Importer un .mid"><i className="fas fa-file-import text-[10px]"></i></button>
         </div>
       )}

       {/* Saisie pas à pas (R16) */}
       {stepOn && (
         <div data-nova-roll="pas-a-pas-barre" className="shrink-0 px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-emerald-400/30 bg-emerald-500/[0.06] text-[11px] text-slate-200">
           <span className="text-emerald-300 font-bold"><i className="fas fa-shoe-prints mr-1"></i>Pas à pas</span>
           <span className="flex flex-wrap gap-1" role="radiogroup" aria-label="Valeur d'un pas">
             {STEP_VALUES.map(v => (
               <button key={v.id} type="button" role="radio" aria-checked={stepValueId === v.id} onClick={() => setStepValueId(v.id)} title={v.hint} data-nova-step-value={v.id}
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
           <span className="text-slate-400" role="status">Mesure {Math.floor(stepPos / ((60 / bpm) * 4)) + 1}, temps {(Math.floor(stepPos / (60 / bpm)) % 4) + 1} · joue une note ou un accord</span>
         </div>
       )}

       {/* Bandeau d'état : clavier de l'ordinateur, accord posé, gamme, retours des actions */}
       {(kbOn || lastChord || chordKind || slideDraw) && (
         <div data-nova-roll="bandeau" className="shrink-0 min-h-8 px-4 py-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 bg-nv-surface text-[11px] text-slate-300">
           {kbOn && !isDrumMode && (
             <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
               <span className="text-cyan-300 font-bold"><i className="fas fa-keyboard mr-1"></i>Joue avec les lettres</span>
               <span className="font-mono text-slate-400">{['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'].map(keyLabel).join(' ')} = Do Ré Mi Fa Sol La Si Do · {['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU'].map(keyLabel).join(' ')} = dièses</span>
               <span>Octave <b className="text-white">Do{kbState.octave}</b> <span className="text-slate-500">({keyLabel('KeyZ')} / {keyLabel('KeyX')})</span></span>
               <span>Vélocité <b className="text-white">{kbState.velocity}</b> <span className="text-slate-500">({keyLabel('KeyC')} / {keyLabel('KeyV')})</span></span>
               {heldPitches.length > 0 && <span className="text-cyan-300 font-bold">{heldPitches.length > 2 ? chordLabelFr([...heldPitches].sort((a, b) => a - b)) : heldPitches.map(noteNameFr).join(' + ')}</span>}
               <span className="text-slate-500">Sur la piste « {track.name} »</span>
             </span>
           )}
           {chordKind && !isDrumMode && <span className="text-fuchsia-300"><i className="fas fa-layer-group mr-1"></i>Clique dans la grille pour poser {chordKind === 'SCALE' ? "l'accord de la gamme" : `un accord ${CHORD_CHOICES.find(c => c.id === chordKind)?.label.toLowerCase()}`}{hasKey ? ` dans ${keyLabelFr(keyRoot, keyScale)}` : ''}{chordInv ? ` · ${chordInv === 1 ? '1er' : '2e'} renversement` : ''}</span>}
           {slideDraw && !isDrumMode && <span className="text-orange-300"><i className="fas fa-level-up-alt rotate-90 mr-1"></i>Glissés : pose la note pendant une note tenue, elle la fera glisser</span>}
           {lastChord && <span className="text-amber-200" role="status">{lastChord}</span>}
         </div>
       )}

       {toolsAnchor !== false && (
         <MidiToolsPanel notes={clip.notes || []} selectedIds={selectedNoteIds} ctx={toolCtx} anchor={toolsAnchor}
           onPreview={setToolPreview} onApply={applyToolResult} onClose={() => { setToolsAnchor(false); setToolPreview(null); }} />
       )}

       {/* Menu grille / quantification : en position fixe, sinon la barre (qui défile en largeur) le coupait */}
       {showQuantizeMenu && (
         <>
           <div className="fixed inset-0 z-[290]" onPointerDown={() => setShowQuantizeMenu(false)} />
           <div data-nova-roll-menu="quantize" role="dialog" aria-label="Grille et quantification" className="fixed z-[300] bg-nv-raised border border-white/20 rounded-xl shadow-2xl p-3 w-72 max-h-[75vh] overflow-y-auto" style={{ left: quantPos.x, top: quantPos.y }}>
             <button type="button" role="switch" aria-checked={magnet} aria-label="Magnétisme de la grille" onClick={() => setPrefs({ magnet: !magnet })}
               title="Magnétisme : les notes se calent sur la grille. Coupé : placement libre. Alt tenu : libre le temps d'un geste (FL Studio, Live)."
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
             <label className="block mb-3" title="Swing : les contretemps de la grille sont retardés (50 % = droit, 66 % = ternaire). Q-Swing de Logic, swing de FL Studio.">
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
                   ['highlight', 'Griser les notes hors gamme', 'Les lignes et les notes hors gamme sont hachurées et grisées (comme Scale Highlighting dans FL Studio).'],
                   ['snap', 'Coller à la gamme', 'Chaque note posée ou déplacée tombe sur une note de la gamme ; ↑ / ↓ passent de note en note (comme Scale Snap dans FL Studio).'],
                   ['fold', 'Montrer seulement la gamme', 'Cache les lignes hors gamme : impossible de jouer faux (comme Fold to Scale dans Live).'],
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
            <div className={`flex-shrink-0 ${sideW} pr-ruler border-r border-white/10 flex items-center justify-center text-[9px] font-bold text-slate-400`} title={`${Math.round(bpm)} BPM`}>{Math.round(bpm)} BPM</div>
            <Ruler clipStart={clipStart} clipDuration={clip.duration} width={contentWidth} zoomX={zoomX} bpm={bpm} light={light} loop={loop} onSeek={onSeek} onSetLoop={onSetLoop} innerRef={rulerRef} height={touch ? 30 : 22} />
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
                 className={`flex-1 overflow-auto relative custom-scroll ${tool === 'ERASE' ? 'cursor-not-allowed' : tool === 'SPLIT' ? 'cursor-col-resize' : tool === 'SELECT' ? 'cursor-default' : 'cursor-crosshair'}`}
                 style={{ touchAction: tool === 'DRAW' ? 'pan-x pan-y' : 'none', backgroundColor: G.white }}
                 onScroll={handleScroll}
                 onPointerDown={handleMouseDown}
                 onContextMenu={e => e.preventDefault()}
              >
                 <div style={{ width: contentWidth, height: totalRows * currentRowHeight, position: 'relative' }}>
                    {renderGridRows()}
                    {/* Temps, mesures, cases de la grille */}
                    <div aria-hidden className="absolute inset-0 pointer-events-none" style={gridBg} />
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
                                title={`${noteNameFr(note.pitch)} · vélocité ${Math.round(note.velocity * 127)}${note.slide ? ' · glissé' : ''}${outOfKey ? ' · hors gamme' : ''}${note.muted ? ' · muette (Ctrl+M ou Alt+clic pour la réactiver)' : ''}`}
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
                    : <>Clique dans la grille pour poser une note, glisse pour l’allonger.<br /><span className="font-normal opacity-80">Clic droit : effacer · Pinceau (B) : peindre à la suite · Ctrl + molette : zoom</span></>}
                </div>
              )}
          </div>

          {/* Couloirs : vélocité, pitch bend, CC (R16) */}
          <MidiCcLanes notes={clip.notes || []} cc={clip.cc} duration={clip.duration} zoomX={zoomX} width={contentWidth}
            sideWidth={sideW} selectedIds={selectedNoteIds} color={track.color || '#22d3ee'} innerRef={velocityRef} velColors={prefs.velColors} light={light}
            onNotes={(next, label) => { updateNotes(next); setLastChord(`${label} (Ctrl+Z pour annuler)`); }} onCc={updateClipCc} />
       </div>
    </div>
  );
};

export default PianoRoll;
