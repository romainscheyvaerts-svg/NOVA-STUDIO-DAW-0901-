
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { breathGainAt } from '../utils/breathEnvelope';
import { requestBreaths } from '../utils/breathBus';
import { isVoiceTrack } from '../utils/vocalRoles';
import { Track, TrackType, PluginType, PluginInstance, Clip, EditorTool, ContextMenuItem, AutomationLane, AutomationPoint, Marker } from '../types';
import TrackHeader from './TrackHeader';
import ContextMenu from './ContextMenu';
import { midiClipMenuItems, midiTrackMenuItems } from './MidiFileMenu';
import { midiBus, isMidiFile } from '../utils/midiBus';
import TimelineGridMenu from './TimelineGridMenu'; 
import { ChordLaneToggleButton, ChordLaneView } from './ChordLane';
import LiveRecordingClip from './LiveRecordingClip'; 
import AutomationLaneComponent from './AutomationLane';
import { drawExpandedLanes } from '../utils/automationDraw';
import { snapToGrid, gridSubdivisionsPerBar, isBeatLine, timeGridStep } from '../utils/grid';
import { editModeStore, effectiveMode, EDIT_MODE_INFO, GRID_KIND_LABEL, moveClipStart, snapPoint, sessionSampleRate, snapsToGrid, syncOffsetOf, syncPointAt, toSample, trimEdgeTime, useEditMode } from '../utils/editModes';
import { SELECT_CLIP_EVENT, shuffleDrag, shuffleEditClip, shuffleGroupDrag } from '../hooks/useEditModes';
import EditModeSelector from './EditModeSelector';
import SpotDialog from './SpotDialog';
import { useArrangementCommands } from '../hooks/useArrangementCommands';
import { openNovaWindow } from '../utils/novaWindows';
import WaveformRenderer from './WaveformRenderer';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { playheadStore } from '../utils/playheadStore';
import { visibleEnvelope } from '../utils/waveformPeaks';
import { useLatestCallback } from '../utils/useLatestCallback';
import { useSimpleMode } from '../utils/simpleMode';
import { gainToDbText } from '../utils/db';
import { PunchSettings } from '../types';
import { hasPunchZone, movePunchPoint } from '../utils/punch';
import { crossfadeZones, fadeInShape, fadeOutShape, FADE_CURVES, FADE_CURVE_INFO, junctionNear, makeCrossfade, handlesOf, NUDGE_UNITS, NudgeUnit } from '../utils/fades';
import { editSelectionStore, editPrefsStore, useEditPrefs, useEditSelection } from '../utils/editSelection';
import { makeSelection, tracksBetween } from '../utils/timeSelection';
import RangeActionsBar from './RangeActionsBar';
import type { EditCommands } from '../hooks/useEditCommands';
import { bufferDurationOf } from '../hooks/useEditCommands';
import { CrossfadeCurve } from '../types';
import { STEMS_TOOLTIP } from '../services/StemSeparation';
import { araAvailability } from '../utils/araEdit';
import { useAraContext } from './AraDialog';
import { TakeLanesApi, TakeLaneHeaders, TakeLanesOverlay, TAKE_LANE_H, takeColor } from './PlaylistLanes';
import { listLanes, mainRowClips, clipAtTime, takeCount, TakeLane } from '../utils/playlists';
import { takeNumberOf } from '../utils/takes';
import { dragTipText, FADE_PRESETS, fadeWithPreset } from '../utils/dragLabels';
import { canvasTheme } from '../utils/canvasTheme';
import { useTheme } from '../utils/themeStore';

// En-tetes de piste memoises : ils ne se re-rendent plus a chaque rendu de
// l'arrangement (defilement, selection...), seulement quand leur piste change.
const TrackHeaderMemo = React.memo(TrackHeader);

interface ArrangementViewProps {
  tracks: Track[];
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
  onUpdateTrack: (track: Track) => void;
  onReorderTracks: (sourceTrackId: string, destTrackId: string) => void;
  /** Inutilise : la tete de lecture est lue dans playheadStore. */
  currentTime?: number;
  isLoopActive: boolean;
  loopStart: number;
  loopEnd: number;
  onSetLoop: (start: number, end: number) => void;
  onSeek: (time: number) => void;
  bpm: number;
  // NEW: Markers support (inspired by Pro Tools/Reaper)
  markers?: Marker[];
  onAddMarker?: (time: number, name?: string) => void;
  onUpdateMarker?: (marker: Marker) => void;
  onDeleteMarker?: (markerId: string) => void;
  /** Crée une région (marqueur avec début et fin) : elle cale le prompteur de paroles. */
  onAddRegion?: (start: number, end: number, name?: string) => void;
  // Plugins
  onDropPluginOnTrack: (trackId: string, type: PluginType, metadata?: any) => void;
  onMovePlugin?: (sourceTrackId: string, destTrackId: string, pluginId: string) => void;
  onMoveClip?: (sourceTrackId: string, destTrackId: string, clipId: string) => void;
  onSelectPlugin?: (trackId: string, plugin: PluginInstance) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void;
  onAddTrack?: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
  onDuplicateTrack?: (trackId: string) => void;
  onDeleteTrack?: (trackId: string) => void;
  onFreezeTrack?: (trackId: string) => void;
  onImportFile?: (file: File) => void;
  onEditClip?: (trackId: string, clipId: string, action: string, payload?: any) => void;
  isRecording?: boolean;
  isPlaying?: boolean;
  recStartTime: number | null;
  onCreatePattern?: (trackId: string, time: number) => void;
  /** Decale d'un meme delta un ensemble de clips (deplacement groupe). */
  onMoveClipsBy?: (items: {trackId:string, clipId:string, start:number}[], delta: number) => void;
  onSwapInstrument?: (trackId: string) => void; 
  onEditMidi?: (trackId: string, clipId: string) => void;
  /** « Séparer en stems » (menu du clip audio) : voix, batterie, basse, autres. */
  onSeparateStems?: (trackId: string, clipId: string) => void;
  onAudioDrop?: (trackId: string, url: string, name: string, time: number) => void;
  /** Points de punch (poignées rouges dans la règle). utils/punch */
  punch?: PunchSettings;
  onUpdatePunch?: (patch: Partial<PunchSettings>) => void;
  /** Commandes d'édition Pro Tools (fondus, crossfades, nudge, plage). hooks/useEditCommands */
  editCommands?: EditCommands;
  /** Couloirs de prises (Playlists) et comp à la souris. components/PlaylistLanes */
  takeLanes?: TakeLanesApi;
  /** Piste d'accords (V20, components/ChordLane) : absente quand le couloir est masqué. */
  chordLane?: { height: number; render: (v: ChordLaneView) => React.ReactNode };
}

/** Contour d'un fondu (courbe choisie) : zone assombrie au-dessus de la courbe + trait. */
const drawFadeShape = (ctx: CanvasRenderingContext2D, x0: number, fw: number, y: number, h: number, curve: CrossfadeCurve | undefined, dir: 'in' | 'out', stroke: string) => {
    const n = Math.max(8, Math.min(64, Math.round(fw / 2)));
    const pt = (u: number) => {
        const g = dir === 'in' ? fadeInShape(curve, u) : fadeOutShape(curve, u);
        return [x0 + fw * u, y + h * (1 - g)] as const;
    };
    ctx.fillStyle = canvasTheme().veil(0.55);
    ctx.beginPath();
    ctx.moveTo(x0, y); ctx.lineTo(x0 + fw, y);
    for (let i = n; i >= 0; i--) { const [px, py] = pt(i / n); ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const [px, py] = pt(i / n); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.stroke();
};

const FADE_HANDLE_PX = 14;

// Poignée de gain de clip (ligne horizontale sur les clips audio) :
// +12 dB tout en haut de la forme d'onde, 0 dB à 20 % sous le haut, -40 dB en bas.
const CLIP_GAIN_MAX_DB = 12;
const CLIP_GAIN_MIN_DB = -40;
/** Hauteur de la barre d'outils de l'arrangement (h-12). */
const TOOLBAR_H = 48;
/**
 * Hauteur de la règle (mesures, marqueurs, boucle, punch), dessinée en haut du
 * calque. Le couloir d'accords (s'il est affiché) vient juste dessous, comme
 * la Chord Track de Logic, puis les pistes : `tracksTop` = règle + couloir.
 */
export const RULER_H = 40;
const CLIP_GAIN_ZERO_FRAC = 0.8;
const CLIP_GAIN_GRAB_PX = 5;
const clipGainToFrac = (g: number): number => {
    const db = g > 0 ? 20 * Math.log10(g) : CLIP_GAIN_MIN_DB;
    if (db >= 0) return CLIP_GAIN_ZERO_FRAC + (1 - CLIP_GAIN_ZERO_FRAC) * Math.min(1, db / CLIP_GAIN_MAX_DB);
    return CLIP_GAIN_ZERO_FRAC * (1 - Math.min(1, db / CLIP_GAIN_MIN_DB));
};
const fracToClipGain = (f: number): number => {
    const c = Math.max(0, Math.min(1, f));
    const db = c >= CLIP_GAIN_ZERO_FRAC
        ? ((c - CLIP_GAIN_ZERO_FRAC) / (1 - CLIP_GAIN_ZERO_FRAC)) * CLIP_GAIN_MAX_DB
        : (1 - c / CLIP_GAIN_ZERO_FRAC) * CLIP_GAIN_MIN_DB;
    return Math.pow(10, db / 20);
};
/** Ordonnée de la poignée de gain, relative au haut du clip (zone de forme d'onde : y+18 … y+h-4). */
const clipGainHandleY = (clipH: number, gain: number): number => 18 + Math.max(4, clipH - 22) * (1 - clipGainToFrac(gain));

type DragAction = 'MOVE' | 'SCRUB' | 'TRIM_START' | 'TRIM_END' | 'FADE_IN' | 'FADE_OUT' | 'GAIN' | 'XFADE' | 'RANGE' | null;
type LoopDragMode = 'START' | 'END' | 'BODY' | null;

// Grille : 1/1 à 1/32 et triolets (utils/grid) ; hors grille, à l'échantillon près (Slip).
const getSnappedTime = (time: number, bpm: number, gridSize: string, enabled: boolean): number => (enabled ? snapToGrid(time, bpm, gridSize, true) : toSample(time));

const ArrangementView: React.FC<ArrangementViewProps> = ({ 
  tracks, selectedTrackId, onSelectTrack, onUpdateTrack, onReorderTracks, 
  isLoopActive, loopStart, loopEnd, onSetLoop, onSeek, bpm, 
  markers = [], onAddMarker, onUpdateMarker, onDeleteMarker, onAddRegion, isPlaying = false,
  onDropPluginOnTrack, onMovePlugin, onMoveClip, onSelectPlugin, onRemovePlugin, onRequestAddPlugin,
  onAddTrack, onDuplicateTrack, onDeleteTrack, onFreezeTrack, onImportFile, onEditClip: onEditClipRaw, isRecording, recStartTime,
  onCreatePattern, onSwapInstrument, onEditMidi, onSeparateStems, onAudioDrop, onMoveClipsBy,
  punch, onUpdatePunch, editCommands, takeLanes, chordLane
}) => {
  // Piste d'accords (V20) : couloir sous la règle (comme Logic), au-dessus des pistes.
  const chordH = chordLane ? chordLane.height : 0;
  /** Haut des pistes, dans le contenu défilant comme dans le calque : règle + couloir d'accords. */
  const tracksTop = RULER_H + chordH;
  // Thème affiché : le canvas se redessine quand on passe en clair / sombre.
  const { theme: uiTheme } = useTheme();
  const editPrefs = useEditPrefs();
  // Modes d'édition Pro Tools (utils/editModes) : Shuffle / Slip / Spot / Grid.
  const em = useEditMode();
  // En Shuffle, supprimer / couper / coller / dupliquer un clip recolle ou pousse
  // la suite (hooks/useEditModes) ; tout le reste passe tel quel.
  const onEditClip = useCallback((trackId: string, clipId: string, action: string, payload?: any) => {
    if (editModeStore.get().mode === 'SHUFFLE' && shuffleEditClip(trackId, clipId, action, payload)) return;
    onEditClipRaw?.(trackId, clipId, action, payload);
  }, [onEditClipRaw]);
  /** Inversion temporaire Grid ⇄ Slip : Ctrl (Pro Tools) ou Maj (habitude NOVA) pendant le geste. */
  const invertOf = (ev?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } | null) =>
    isShiftDownRef.current || ctrlDownRef.current || !!(ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey));
  const snapNow = (ev?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } | null) => snapsToGrid(effectiveMode(editModeStore.get(), invertOf(ev)));
  // Shuffle : clips de la piste au début du glissement (chaque mouvement repart d'eux).
  // group : toutes les pistes (ordre affiché) pour déplacer la sélection, changement de piste compris.
  const shuffleInitRef = useRef<{ trackId: string; clips: Clip[]; group: { id: string; kind: string; clips: Clip[] }[]; ids: string[]; shift: number } | null>(null);
  // Le clip a-t-il vraiment bougé (Spot : un simple clic ouvre « Position exacte ») ?
  const movedRef = useRef(false);
  const [dragInvert, setDragInvert] = useState(false);
  const [spotTarget, setSpotTarget] = useState<{ trackId: string; clipId: string } | null>(null);
  // Après un appui long qui a ouvert le Spot, Chrome envoie encore un clic droit
  // synthétique (menu du clip) : on l'ignore un instant.
  const suppressCtxUntilRef = useRef(0);
  // Crossfade en cours de réglage (Smart Tool : bas d'une jonction entre deux clips).
  const xfadeDragRef = useRef<{ trackId: string; a: Clip; b: Clip; at: number } | null>(null);
  const [xfadeTip, setXfadeTip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Poignée de punch en cours de déplacement (règle).
  const punchDragRef = useRef<'IN' | 'OUT' | null>(null);
  // Smart Tool (Pro Tools) par défaut à la souris ; au doigt, le Grabber (déplacement) comme avant.
  const [activeTool, setActiveTool] = useState<EditorTool>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'SELECT' : 'SMART');
  // Sélection de plage (Sélecteur / moitié haute du Smart Tool) : partagée avec les commandes.
  const { time: timeSel } = useEditSelection();
  const rangeDragRef = useRef<{ anchor: number; anchorTrack: string; clickClip?: { trackId: string; clip: Clip } } | null>(null);
  const [zoomV, setZoomV] = useState(120); 
  const [zoomH, setZoomH] = useState(40);  
  // Grille et mode : préférence + projet (utils/editModes), plus un état local.
  const gridSize = em.gridSize;
  const setGridSize = (g: string) => editModeStore.set({ gridSize: g });
  const snapEnabled = em.mode === 'GRID';
  const [gridMenu, setGridMenu] = useState<{ x: number, y: number } | null>(null);

  const [dragAction, setDragAction] = useState<DragAction | null>(null);
  const [activeClip, setActiveClip] = useState<{trackId: string, clip: Clip} | null>(null);
  // Selection qui survit au relachement de la souris (surlignage + raccourcis).
  const [selectedClip, setSelectedClip] = useState<{trackId: string, clip: Clip} | null>(null);
  // Selection multiple : selectedClip reste l'ancre (celle qu'on manipule),
  // selectedClipIds contient l'ensemble des clips selectionnes.
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  // Sélection partagée avec les commandes d'édition (nudge, Ctrl+F…).
  useEffect(() => {
    const ids = selectedClipIds.size ? Array.from(selectedClipIds) : (selectedClip ? [selectedClip.clip.id] : []);
    editSelectionStore.set({ clipIds: ids });
  }, [selectedClipIds, selectedClip]);
  useEffect(() => { editSelectionStore.set({ focusTrackId: selectedTrackId }); }, [selectedTrackId]);
  // Alt+Tab / Ctrl+Alt+→ (clip suivant) : hooks/useEditModes demande la sélection d'un clip.
  useEffect(() => {
    const onSelect = (ev: Event) => {
      const d = (ev as CustomEvent<{ trackId: string; clipId: string }>).detail;
      const c = d && tracks.find(t => t.id === d.trackId)?.clips.find(x => x.id === d.clipId);
      if (!c) return;
      setSelectedClip({ trackId: d.trackId, clip: c });
      setSelectedClipIds(new Set([c.id]));
      editSelectionStore.set({ time: null });
    };
    window.addEventListener(SELECT_CLIP_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_CLIP_EVENT, onSelect);
  }, [tracks]);
  const [marquee, setMarquee] = useState<{x0:number,y0:number,x1:number,y1:number} | null>(null);
  const marqueeOriginRef = useRef<{x:number,y:number} | null>(null);
  // Positions de depart des clips selectionnes, capturees au debut du glissement.
  const multiDragRef = useRef<{trackId:string, clipId:string, start:number}[] | null>(null);
  
  const [loopDragMode, setLoopDragMode] = useState<LoopDragMode>(null);
  // Tactile (iPad, téléphone) : vrai pendant un appui au doigt / stylet.
  const touchRef = useRef(false);
  const dragActionRef = useRef<DragAction | null>(null);
  const loopDragRef = useRef<LoopDragMode>(null);
  const [initialLoopState, setInitialLoopState] = useState<{ start: number, end: number } | null>(null);

  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartY, setDragStartY] = useState(0);
  const [initialClipState, setInitialClipState] = useState<Clip | null>(null);

  const [hoverTime, setHoverTime] = useState<number | null>(null);
  // Bulle « -3.5 dB » pendant le réglage du gain de clip
  const [gainTip, setGainTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const gainDragRef = useRef<{ lastY: number; frac: number } | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  // Bulle de glissement en français (G8) et aide au survol des coins de fondu (G7).
  const [dragTipPos, setDragTipPos] = useState<{ x: number; y: number } | null>(null);
  const [hoverHint, setHoverHint] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, items: (ContextMenuItem | 'separator')[] } | null>(null);
  const [clipContextMenu, setClipContextMenu] = useState<{ x: number; y: number; trackId: string; clip: Clip } | null>(null);
  // Melodyne / VocAlign : pont + plugins présents ? (commandes grisées sinon)
  const araCtx = useAraContext();
  // Reordonnancement des pistes par glisser-deposer (le TrackHeader emettait
  // deja les evenements, mais ArrangementView les ignorait).
  const dragTrackIdRef = useRef<string | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);

  const handleDragStartTrack = useCallback((trackId: string) => {
    dragTrackIdRef.current = trackId;
  }, []);

  const handleDragOverTrack = useCallback((trackId: string) => {
    setDragOverTrackId(prev => (prev === trackId ? prev : trackId));
  }, []);

  const handleDropTrack = useCallback(() => {
    const source = dragTrackIdRef.current;
    const dest = dragOverTrackId;
    dragTrackIdRef.current = null;
    setDragOverTrackId(null);
    if (source && dest && source !== dest) onReorderTracks(source, dest);
  }, [dragOverTrackId, onReorderTracks]);

  const [markerContextMenu, setMarkerContextMenu] = useState<{ x: number; y: number; marker: Marker } | null>(null);
  // Un seul menu à la fois (G3) : ouvrir un menu ferme les autres (avant, le
  // menu de la grille restait ouvert sous le menu de la règle).
  useEffect(() => { if (contextMenu || markerContextMenu || clipContextMenu) setGridMenu(null); }, [contextMenu, markerContextMenu, clipContextMenu]);
  useEffect(() => { if (gridMenu) { setContextMenu(null); setMarkerContextMenu(null); setClipContextMenu(null); } }, [gridMenu]);
  // Bord de région en cours de déplacement (début ou fin) : règle aussi la vitesse du prompteur.
  const regionDragRef = useRef<{ marker: Marker; edge: 'START' | 'END' } | null>(null);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);

  // 296 px : nom de piste lisible avec FX, M, S, envois et R sur la même ligne.
  // Écran tactile en vue PC (iPad paysage) : boutons espacés au pas de 40 px,
  // 40 px de plus pour que le nom reste lisible.
  const [headerWidth, setHeaderWidth] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1024 && window.matchMedia?.('(pointer: coarse)').matches ? 336 : 296);
  const [isResizingHeader, setIsResizingHeader] = useState(false);
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);

  const isShiftDownRef = useRef(false);
  const ctrlDownRef = useRef(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sidebarContainerRef = useRef<HTMLDivElement>(null); 
  const minimapRef = useRef<HTMLCanvasElement>(null);
  
  const requestRef = useRef<number>(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const timeToPixels = useCallback((time: number) => time * zoomH, [zoomH]);
  const pixelsToTime = useCallback((pixels: number) => pixels / zoomH, [zoomH]);

  // (window.gridSize / isSnapEnabled sont publiés par utils/editModes.)

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const handleKD = (e: KeyboardEvent) => {
      if (e.key === 'Shift') isShiftDownRef.current = true;
      if (e.key === 'Control' || e.key === 'Meta') ctrlDownRef.current = true;
      if (isTypingTarget(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;
      const sel = selectedClip;

      // Outils : 1 sélection, 2 ciseaux, 3 gomme (annoncés dans les infobulles)
      if (!mod && !e.altKey) {
        if (e.key === '4') { setActiveTool('RANGE'); return; }
        if (e.key === '5') { setActiveTool('SMART'); return; }
        if (e.key === '1') { setActiveTool('SELECT'); return; }
        if (e.key === '2') { setActiveTool('SPLIT'); return; }
        if (e.key === '3') { setActiveTool('ERASE'); return; }
      }

      // Nudge (Pro Tools) : ← / → déplacent la sélection d'un pas (réglable), Maj = 10 pas.
      if (!mod && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && editCommands
          && !document.querySelector('[data-nova-pianoroll]')) {
        const s = editSelectionStore.get();
        if (s.clipIds.length || s.time) {
          e.preventDefault();
          editCommands.nudge(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey ? 10 : 1);
          return;
        }
      }

      // Coller se fait sur la piste selectionnee, meme sans clip selectionne.
      // Sélection de plage (Pro Tools) : Ctrl+E séparer, Ctrl+F fondus, Alt+Maj+3 consolider,
      // Ctrl+C / X / D et Suppr sur la plage, Ctrl+V colle une plage copiée.
      if (editCommands) {
        const ts = editSelectionStore.get().time;
        if (mod && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); editCommands.separate(); return; }
        if (ts && mod && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); editCommands.fadesFromSelection(); return; }
        if (ts && e.altKey && e.shiftKey && e.code === 'Digit3') { e.preventDefault(); void editCommands.consolidateSelection(); return; }
        if (ts && mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); editCommands.copySelection(); return; }
        if (ts && mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); editCommands.cutSelection(); return; }
        if (ts && mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); editCommands.duplicateSelection(); return; }
        if (ts && !mod && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); editCommands.deleteSelection(); return; }
        if (mod && (e.key === 'v' || e.key === 'V') && editCommands.hasRangeClipboard()) { e.preventDefault(); editCommands.pasteRange(); return; }
        if (mod && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) editCommands.markClipClipboard();
      }

      if (mod && (e.key === 'v' || e.key === 'V')) {
        const target = sel?.trackId || selectedTrackId;
        if (target) { e.preventDefault(); onEditClip?.(target, '', 'PASTE', { time: playheadStore.get() }); }
        return;
      }

      // Cibles des actions : la selection multiple si elle existe, sinon le clip
      // ancre. Un rectangle de selection laisse l'ancre a null, il ne faut donc
      // pas sortir sur `!sel` avant d'avoir consulte la selection.
      const cibles: {trackId: string, clipId: string}[] = selectedClipIds.size > 0
        ? tracks.flatMap(tr => tr.clips.filter(c => selectedClipIds.has(c.id)).map(c => ({ trackId: tr.id, clipId: c.id })))
        : (sel ? [{ trackId: sel.trackId, clipId: sel.clip.id }] : []);

      if (cibles.length === 0) return;

      if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); if (sel) onEditClip?.(sel.trackId, sel.clip.id, 'COPY'); return; }
      if (mod && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        cibles.forEach(c => onEditClip?.(c.trackId, c.clipId, 'CUT'));
        setSelectedClip(null); setSelectedClipIds(new Set());
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        cibles.forEach(c => onEditClip?.(c.trackId, c.clipId, 'DUPLICATE'));
        return;
      }
      if (mod) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        cibles.forEach(c => onEditClip?.(c.trackId, c.clipId, 'DELETE'));
        setSelectedClip(null); setSelectedClipIds(new Set());
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        cibles.forEach(c => onEditClip?.(c.trackId, c.clipId, 'MUTE'));
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        // La decoupe s'applique a tous les clips traverses par la tete de lecture.
        const t = playheadStore.get();
        cibles.forEach(c => onEditClip?.(c.trackId, c.clipId, 'SPLIT', { time: t }));
        return;
      }
    };

    const handleKU = (e: KeyboardEvent) => { if (e.key === 'Shift') isShiftDownRef.current = false; if (e.key === 'Control' || e.key === 'Meta') ctrlDownRef.current = false; };
    // Fenêtre quittée touche enfoncée (Alt+Tab…) : on ne garde pas une inversion fantôme.
    const handleBlur = () => { isShiftDownRef.current = false; ctrlDownRef.current = false; };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleKD);
    window.addEventListener('keyup', handleKU);
    return () => { window.removeEventListener('keydown', handleKD); window.removeEventListener('keyup', handleKU); window.removeEventListener('blur', handleBlur); };
  }, [selectedClip, selectedClipIds, tracks, selectedTrackId, onEditClip, editCommands]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Zoom au Ctrl/Cmd + molette, ancre sous le curseur.
   * C'est le geste reflexe dans tous les DAW ; seul le curseur de la barre
   * d'outils permettait de zoomer jusqu'ici.
   * Listener non passif : indispensable pour pouvoir annuler le zoom natif
   * du navigateur.
   */
  const pendingZoomAnchorRef = useRef<{ time: number; pointerX: number } | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      // La timeline commence après la colonne des en-têtes de pistes (même repère que les clics).
      const timeUnderPointer = Math.max(0, (el.scrollLeft + pointerX - headerWidth) / zoomH);

      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextZoom = Math.min(300, Math.max(10, zoomH * factor));
      if (nextZoom === zoomH) return;

      // Le repositionnement se fait apres le rendu (useLayoutEffect ci-dessous) :
      // avant, la nouvelle largeur du contenu n'est pas encore appliquee.
      pendingZoomAnchorRef.current = { time: timeUnderPointer, pointerX };
      setZoomH(nextZoom);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomH, headerWidth]);

  // Recale le defilement une fois la nouvelle largeur appliquee, pour garder
  // le meme instant sous le curseur pendant le zoom.
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const el = scrollContainerRef.current;
    if (!anchor || !el) return;
    pendingZoomAnchorRef.current = null;
    el.scrollLeft = Math.max(0, anchor.time * zoomH + headerWidth - anchor.pointerX);
    setScrollLeft(el.scrollLeft);
  }, [zoomH, headerWidth]);

  // --- Suivi du playhead pendant la lecture ---
  // La tete de lecture sortait de l'ecran et il fallait defiler a la main.
  const autoScrollRef = useRef(false);
  const followSuspendedUntilRef = useRef(0);

  // (Le suivi lui-meme est fait par l'abonnement a playheadStore, plus bas :
  // il ne provoque plus de rendu React a chaque image.)

  const isSyncingScroll = useRef(false);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (isSyncingScroll.current) return;
    
    isSyncingScroll.current = true;
    if (target === scrollContainerRef.current) {
        // Defilement a l'initiative de l'utilisateur : on laisse le suivi
        // tranquille quelques secondes pour ne pas le ramener de force.
        if (autoScrollRef.current) autoScrollRef.current = false;
        else followSuspendedUntilRef.current = Date.now() + 3000;
        setScrollLeft(target.scrollLeft);
        setScrollTop(target.scrollTop);
        if (sidebarContainerRef.current) sidebarContainerRef.current.scrollTop = target.scrollTop;
    } else if (target === sidebarContainerRef.current) {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = target.scrollTop;
            setScrollTop(target.scrollTop);
        }
    }
    
    requestAnimationFrame(() => { isSyncingScroll.current = false; });
  };
  
  const handleSidebarWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && scrollContainerRef.current) {
        scrollContainerRef.current.scrollLeft += e.deltaX;
    }
  };

  // Mode simple : ni bus ni lignes d'automation à l'écran (gardés dans le projet).
  const { simple } = useSimpleMode();
  const visibleTracks = useMemo(() => {
    const list = tracks.filter(t => t.type !== TrackType.SEND && t.id !== 'master' && !(simple && t.type === TrackType.BUS));
    if (!simple) return list;
    return list.map(t => t.automationLanes.some(l => l.isExpanded)
      ? { ...t, automationLanes: t.automationLanes.map(l => ({ ...l, isExpanded: false })) }
      : t);
  }, [tracks, simple]);
  // Couloirs de prises : listés pour les pistes à prises, dépliés à la demande.
  const lanesByTrack = useMemo(() => {
    const m = new Map<string, TakeLane[]>();
    visibleTracks.forEach(t => { if (t.clips.some(c => takeNumberOf(c) !== null)) m.set(t.id, listLanes(t)); });
    return m;
  }, [visibleTracks]);
  const openLanesOf = (t: Track): TakeLane[] => (takeLanes?.open[t.id] ? lanesByTrack.get(t.id) || [] : []);
  /** Hauteur sous la ligne de clips : lignes d'automation + couloirs de prises. */
  const extraH = (t: Track) => t.automationLanes.filter(l => l.isExpanded).length * 80 + openLanesOf(t).length * TAKE_LANE_H;
  const lanesKey = visibleTracks.map(t => `${t.id}:${openLanesOf(t).length}`).join(',');
  /** Clips de la ligne principale (les prises mutées cachées dessous vont dans les couloirs). */
  const rowClips = (t: Track) => (lanesByTrack.has(t.id) ? mainRowClips(t) : t.clips);
  // Pastille « Prises (N) ▾ » sur le clip entendu (B3 de l'audit) : menu Écouter / Garder.
  const TAKE_BADGE_W = 82, TAKE_BADGE_H = 18;
  const takeBadgeX = (t: Track, clip: Clip): number | null => {
    if (!takeLanes || clip.isMuted || takeNumberOf(clip) === null || (lanesByTrack.get(t.id)?.length || 0) < 2) return null;
    if (clip.duration * zoomH < TAKE_BADGE_W + 60) return null;
    return (clip.start + clip.duration) * zoomH - TAKE_BADGE_W - 20;
  };
  const openTakeMenu = (trackId: string, x: number, y: number) => {
    if (!takeLanes) return;
    const lanes = lanesByTrack.get(trackId) || [];
    const isOpen = !!takeLanes.open[trackId];
    setContextMenu({ x, y, items: [
      { label: isOpen ? 'Replier les couloirs de prises' : `Afficher les couloirs (${lanes.length} prises)`, icon: isOpen ? 'fa-chevron-up' : 'fa-layer-group',
        onClick: () => { takeLanes.onToggle(trackId); setContextMenu(null); } },
      ...(takeLanes.onAutoComp && lanes.length > 1 ? [{ label: '✨ Meilleure prise (IA, sur ton ordi)', icon: 'fa-wand-magic-sparkles', onClick: () => { takeLanes.onAutoComp!(trackId); setContextMenu(null); } }] : []),
      'separator' as const,
      ...lanes.flatMap(l => [
        { label: `Écouter ${l.label}`, icon: 'fa-headphones', onClick: () => { takeLanes.onAudition(trackId, l.n); setContextMenu(null); } },
        { label: l.used > 0.05 && Math.abs(l.used - l.duration) < 0.05 ? `✓ ${l.name} gardée` : `Garder ${l.name}`, icon: 'fa-check', onClick: () => { takeLanes.onKeep(trackId, l.n); setContextMenu(null); } },
      ]),
    ] });
  };
  const openLaneMenu = (trackId: string, x: number, y: number, l: TakeLane) => {
    if (!takeLanes) return;
    setContextMenu({ x, y, items: [
      { label: `Écouter ${l.name} seule`, icon: 'fa-headphones', onClick: () => { takeLanes.onAudition(trackId, l.n); setContextMenu(null); } },
      { label: 'Garder toute la prise', icon: 'fa-check', onClick: () => { takeLanes.onKeep(trackId, l.n); setContextMenu(null); } },
      { label: 'Renommer…', icon: 'fa-pen', onClick: () => {
          setContextMenu(null);
          window.dispatchEvent(new CustomEvent('nova:rename-take', { detail: { trackId, n: l.n } }));
        } },
      { label: 'Dupliquer dans un nouveau couloir', icon: 'fa-clone', onClick: () => { takeLanes.onDuplicate(trackId, l.n); setContextMenu(null); } },
      'separator' as const,
      { label: 'Supprimer cette prise', icon: 'fa-trash', danger: true, onClick: () => { takeLanes.onDelete(trackId, l.n); setContextMenu(null); } },
    ] as any });
  };
  const projectDuration = useMemo(() => Math.max(...tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 300), [tracks]);
  const totalContentWidth = useMemo(() => projectDuration * zoomH, [projectDuration, zoomH]);
  // Raccourcis Pro Tools (utils/keymap → utils/editCommands) : versions de base sur la sélection de clips.
  useArrangementCommands({ tracks, selectedTrackId, selectedClip, selectedClipIds, setSelectedClipIds, onEditClip, zoomH, setZoomH, zoomV, setZoomV, bpm,
    viewportWidth: viewportSize.width - headerWidth, scrollTo: (left) => { if (scrollContainerRef.current) scrollContainerRef.current.scrollLeft = left; } });
  const totalArrangementHeight = useMemo(() => tracksTop + 500 + visibleTracks.reduce((acc, t) => acc + zoomV + extraH(t), 0), [visibleTracks, zoomV, lanesKey, tracksTop]);

  // Mode avancé (G13) : FX, M, S, envois et R mangeaient le nom (« LEAD C... ») ;
  // colonne un peu plus large sur grand écran, tant que l'utilisateur ne l'a pas réglée.
  const headerResizedRef = useRef(false);
  useEffect(() => {
    if (headerResizedRef.current || typeof window === 'undefined' || window.innerWidth < 1440) return;
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    setHeaderWidth(simple ? 296 : 336);
  }, [simple]);

  const handleHeaderResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizingHeader(true);
      const startX = e.clientX;
      const startWidth = headerWidth;
      const onMove = (moveEvent: MouseEvent) => {
          const newWidth = Math.max(150, Math.min(600, startWidth + moveEvent.clientX - startX));
          headerResizedRef.current = true;
          setHeaderWidth(newWidth);
      };
      const onUp = () => {
          setIsResizingHeader(false);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
  };
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('audio-url') || 
        e.dataTransfer.types.includes('Files')) {
        e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      
      console.log('[ArrangementView Drop] Drop détecté');
      
      if (!scrollContainerRef.current) {
          console.warn('[ArrangementView Drop] scrollContainerRef.current est null');
          return;
      }
      
      const rect = scrollContainerRef.current.getBoundingClientRect();
      // headerWidth : le canvas commence apres la colonne des en-tetes de pistes.
      const x = e.clientX - rect.left - headerWidth + scrollContainerRef.current.scrollLeft;
      const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
      const dropTime = Math.max(0, x / zoomH);
      
      
      let targetTrackId: string | null = null;
      let currentY = tracksTop;
      for (const t of visibleTracks) {
          if (y >= currentY && y < currentY + zoomV) {
              targetTrackId = t.id;
              break;
          }
          currentY += zoomV + extraH(t);
      }

      // Fichiers .mid (V25) : pistes ou clips créés à l'endroit du dépôt (components/MidiHost).
      const midiDropped = Array.from(e.dataTransfer.files || []).filter(isMidiFile);
      midiDropped.forEach(f => midiBus.emit({ type: 'import-file', file: f, trackId: targetTrackId, time: dropTime }));
      if (midiDropped.length && midiDropped.length === e.dataTransfer.files.length) return;
      
      if (!targetTrackId) {
          targetTrackId = visibleTracks.find(t => t.id === 'instrumental')?.id || 
                          visibleTracks.find(t => t.type === TrackType.AUDIO)?.id || 
                          null;
      }
      
      if (!targetTrackId) {
          console.warn('[ArrangementView Drop] Aucune piste cible trouvée!');
          return;
      }
      
      const audioUrl = e.dataTransfer.getData('audio-url');
      
      if (audioUrl && onAudioDrop) {
          const audioName = e.dataTransfer.getData('audio-name') || 'Imported Audio';
          onAudioDrop(targetTrackId, audioUrl, audioName, dropTime);
          return;
      }
      
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && onAudioDrop) {
          // Windows ne donne pas toujours de type MIME (.aif, .flac…) : on regarde aussi l'extension.
          const AUDIO_EXT = /\.(wav|wave|mp3|aif|aiff|flac|ogg|oga|opus|m4a|aac|webm|caf)$/i;
          const files = Array.from(e.dataTransfer.files);
          const audio = files.filter(f => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
          const refused = files.length - audio.length - midiDropped.length;
          // Plusieurs fichiers : un par piste, à partir de celle visée (comme dans les autres DAW).
          const startIdx = Math.max(0, visibleTracks.findIndex(t => t.id === targetTrackId));
          const targets = visibleTracks.slice(startIdx).filter(t => t.type === TrackType.AUDIO);
          // Au-delà des pistes existantes : une nouvelle piste par fichier (id vide).
          audio.forEach((file, i) => {
              const tid = targets[i]?.id || (i === 0 ? targetTrackId! : '');
              onAudioDrop(tid, URL.createObjectURL(file), file.name, dropTime);
          });
          const notes: string[] = [];
          if (refused) notes.push(`${refused} fichier${refused > 1 ? 's' : ''} ignoré${refused > 1 ? 's' : ''} (pas de l'audio : WAV, MP3, AIFF, FLAC, OGG, M4A acceptés)`);
          if (notes.length) window.dispatchEvent(new CustomEvent('nova:notify', { detail: notes.join(' · ') }));
      }
  };

  // Taille de la minimap suivie par ResizeObserver. Avant, elle etait relue
  // (getBoundingClientRect) a chaque image et, la largeur CSS n'etant pas
  // entiere, le canvas etait realloue a chaque image.
  const [minimapSize, setMinimapSize] = useState({ w: 0, h: 0 });
  const minimapScaleRef = useRef(0);
  const minimapPlayheadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = minimapRef.current; if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect; if (!r) return;
      const w = Math.round(r.width), h = Math.round(r.height);
      setMinimapSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Fond de la minimap (pistes, clips, boucle, fenetre visible) : redessine
  // seulement quand il change. La tete de lecture est un trait DOM deplace
  // par l'abonnement a playheadStore.
  useEffect(() => {
    const canvas = minimapRef.current; if (!canvas) return;
    if (minimapSize.w <= 0 || minimapSize.h <= 0) return;
    if (canvas.width !== minimapSize.w || canvas.height !== minimapSize.h) { canvas.width = minimapSize.w; canvas.height = minimapSize.h; }
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h); const cv = canvasTheme(); ctx.fillStyle = cv.panel; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = cv.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
    const scale = w / Math.max(totalContentWidth, 1);
    minimapScaleRef.current = scale;
    if (minimapPlayheadRef.current) minimapPlayheadRef.current.style.transform = `translateX(${playheadStore.get() * zoomH * scale}px)`;
    const trackHeight = h / Math.max(visibleTracks.length, 1);
    visibleTracks.forEach((t, tIdx) => {
        const y = tIdx * trackHeight;
        if (tIdx % 2 === 0) { ctx.fillStyle = cv.ink(0.03); ctx.fillRect(0, y, w, trackHeight); }
        ctx.fillStyle = t.color; ctx.globalAlpha = 0.4;
        t.clips.forEach(c => {
             const cx = (c.start * zoomH) * scale;
             const cw = (c.duration * zoomH) * scale;
             ctx.fillRect(cx, y + 1, Math.max(2, cw), Math.max(1, trackHeight - 2));
        });
        ctx.globalAlpha = 1.0;
    });

    if (isLoopActive && loopEnd > loopStart) {
        const loopX = (loopStart * zoomH) * scale;
        const loopW = ((loopEnd - loopStart) * zoomH) * scale;
        ctx.fillStyle = cv.accentFill(0.3);
        ctx.fillRect(loopX, 0, loopW, h);
        ctx.strokeStyle = cv.accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(loopX, 0, loopW, h);
    }
    
    const viewportWidth = Math.max(0, viewportSize.width - headerWidth);
    const vx = scrollLeft * scale;
    const vw = viewportWidth * scale;
    ctx.fillStyle = cv.veil(0.5); ctx.fillRect(0, 0, vx, h); ctx.fillRect(vx + vw, 0, w - (vx + vw), h);
    ctx.strokeStyle = cv.ink(0.9); ctx.lineWidth = 1.5; ctx.strokeRect(vx, 0, vw, h);
    ctx.fillStyle = cv.ink(0.05); ctx.fillRect(vx, 0, vw, h);
  }, [visibleTracks, totalContentWidth, scrollLeft, viewportSize, headerWidth, zoomH, isLoopActive, loopStart, loopEnd, minimapSize, uiTheme]);

  const handleMinimapMouseDown = (e: React.MouseEvent) => {
      const canvas = minimapRef.current; if (!canvas || !scrollContainerRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const scale = canvas.width / Math.max(totalContentWidth, 1);
      const viewportW = Math.max(0, viewportSize.width - headerWidth);
      const vx = scrollLeft * scale;
      const vw = viewportW * scale;
      if (clickX >= vx && clickX <= vx + vw) { setIsDraggingMinimap(true); setDragStartX(clickX); }
      else { scrollContainerRef.current.scrollLeft = Math.max(0, (clickX / scale) - (viewportW / 2)); setIsDraggingMinimap(true); setDragStartX(clickX); }
      const onMove = (moveEvent: MouseEvent) => {
          const moveRect = canvas.getBoundingClientRect();
          const currentX = moveEvent.clientX - moveRect.left;
          if (scrollContainerRef.current) scrollContainerRef.current.scrollLeft = Math.max(0, (currentX / scale) - (viewportW / 2));
      };
      const onUp = () => { setIsDraggingMinimap(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  };

  const handleTrackContextMenu = (e: React.MouseEvent, trackId: string) => {
    e.preventDefault();
    const menuItems: (ContextMenuItem | 'separator')[] = [ { label: 'Dupliquer la piste', onClick: () => onDuplicateTrack?.(trackId), icon: 'fa-copy' },
      { label: 'Couleur de la piste…', onClick: () => openNovaWindow('track-color', { trackId }), icon: 'fa-palette' }, ];
    const target = tracks.find(t => t.id === trackId);
    if (isVoiceTrack(target)) menuItems.push({ label: 'Respirations…', icon: 'fa-wind', shortcut: 'Ctrl+Alt+R', title: 'Baisser les respirations (lead) ou les supprimer (backs), comme Breath Control de Waves / De-breath de RX', onClick: () => requestBreaths({ mode: 'dialog', trackIds: [trackId], reason: 'menu' }) });
    if (trackId !== 'track-rec-main') menuItems.push({ label: 'Supprimer la piste', danger: true, onClick: () => onDeleteTrack?.(trackId), icon: 'fa-trash' });
    if (!simple || target?.isFrozen) menuItems.push({
      label: target?.isFrozen ? 'Dégeler la piste' : 'Geler la piste (freeze)',
      onClick: () => onFreezeTrack?.(trackId),
      icon: target?.isFrozen ? 'fa-fire' : 'fa-snowflake'
    });
    if (onSwapInstrument && target && (target.type === TrackType.MIDI || target.type === TrackType.SAMPLER || target.type === TrackType.DRUM_RACK)) {
      menuItems.push({ label: "Changer d'instrument", onClick: () => onSwapInstrument(trackId), icon: 'fa-exchange-alt' });
    }
    menuItems.push(...midiTrackMenuItems(target, () => setContextMenu(null)));
    setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
  };
  
  // Gestionnaires stables pour les en-tetes memoises (ils appellent toujours la
  // derniere version des props, sans fermeture perimee).
  // Les lignes d'automation masquées en mode simple ne sont jamais réécrites.
  const headerOnUpdate = useLatestCallback((t: Track) => {
    const orig = simple ? tracks.find(x => x.id === t.id) : undefined;
    onUpdateTrack(orig ? { ...t, automationLanes: orig.automationLanes } : t);
  });
  const headerOnDropPlugin = useLatestCallback(onDropPluginOnTrack);
  const headerOnMovePlugin = useLatestCallback(onMovePlugin);
  const headerOnSelectPlugin = useLatestCallback(onSelectPlugin);
  const headerOnRemovePlugin = useLatestCallback(onRemovePlugin);
  const headerOnRequestAddPlugin = useLatestCallback(onRequestAddPlugin);
  const headerOnSwapInstrument = useLatestCallback(onSwapInstrument);
  const headerOnContextMenu = useLatestCallback(handleTrackContextMenu);
  const headerOnDropTrack = useLatestCallback(handleDropTrack);
  const selectTrackStable = useLatestCallback(onSelectTrack);
  const selectHandlersRef = useRef(new Map<string, () => void>());
  const selectTrackHandler = (id: string) => {
    let fn = selectHandlersRef.current.get(id);
    if (!fn) { fn = () => selectTrackStable(id); selectHandlersRef.current.set(id, fn); }
    return fn;
  };

  // Pendant qu'on déplace / rogne un clip au doigt, la page ne doit pas défiler.
  dragActionRef.current = dragAction;
  loopDragRef.current = loopDragMode;
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onTouchMove = (ev: TouchEvent) => { if (dragActionRef.current || loopDragRef.current) ev.preventDefault(); };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  /** Clip sous un point de l'écran (même calcul que le clic), ou null. */
  const clipAtPoint = (clientX: number, clientY: number): { trackId: string; clip: Clip } | null => {
    const sc = scrollContainerRef.current;
    if (!sc) return null;
    const rect = sc.getBoundingClientRect();
    if (clientX - rect.left < headerWidth || clientY - rect.top < tracksTop) return null;
    const x = clientX - rect.left - headerWidth + sc.scrollLeft;
    const y = clientY - rect.top + sc.scrollTop;
    let currentY = tracksTop;
    for (const t of visibleTracks) {
      if (y >= currentY && y < currentY + zoomV) {
        const clip = clipAtTime(rowClips(t), x / zoomH);
        return clip ? { trackId: t.id, clip } : null;
      }
      currentY += zoomV + extraH(t);
    }
    return null;
  };
  /** Appui long du doigt sur un clip (tablette) : son menu, comme le clic droit. */
  const longPressRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const cancelLongPress = () => { if (longPressRef.current) { window.clearTimeout(longPressRef.current.timer); longPressRef.current = null; } };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    const rect = scrollContainerRef.current.getBoundingClientRect();
    // La colonne des en-tetes gere ses propres evenements.
    if (e.clientX - rect.left < headerWidth) return;
    if (e.button === 2 && Date.now() < suppressCtxUntilRef.current) { e.preventDefault(); return; }
    const x = e.clientX - rect.left - headerWidth + scrollContainerRef.current.scrollLeft;
    const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
    const time = (x / zoomH);
    const useSnap = snapNow(e);

    if (e.clientY - rect.top < RULER_H) {
        // --- Marqueurs (drapeaux dessines dans les 14 premiers pixels du ruler)
        const localY = e.clientY - rect.top;
        const hitMarker = localY < 16
          ? markers.find(mk => { const mx = mk.time * zoomH; return x >= mx - 4 && x <= mx + 16; })
          : undefined;

        if (hitMarker) {
            e.preventDefault();
            if (e.button === 2) setMarkerContextMenu({ x: e.clientX, y: e.clientY, marker: hitMarker });
            else onSeek(hitMarker.time);
            return;
        }

        // Poignées de punch (bas de la règle) : avant la boucle, qui a une grande zone d'accroche.
        if (e.button !== 2 && onUpdatePunch && punch && hasPunchZone(punch) && localY >= 22) {
            const grab = touchRef.current ? 14 : 7;
            const dIn = Math.abs(x - punch.punchIn * zoomH), dOut = Math.abs(x - punch.punchOut * zoomH);
            if (Math.min(dIn, dOut) <= grab) {
                e.preventDefault();
                punchDragRef.current = dIn <= dOut ? 'IN' : 'OUT';
                return;
            }
        }

        if (e.button === 2 && onAddMarker) {
            e.preventDefault();
            const markerTime = getSnappedTime(time, bpm, gridSize, useSnap);
            const bar = (60 / (bpm || 120)) * 4;
            const pz = punch || { enabled: false, punchIn: 0, punchOut: 0, preRoll: 0, postRoll: 0 };
            const punchItems: ContextMenuItem[] = onUpdatePunch ? [
                { label: 'Punch-in ici', icon: 'fa-right-to-bracket', onClick: () => {
                    const base = hasPunchZone(pz) && pz.punchOut > markerTime ? pz : { ...pz, punchOut: markerTime + bar };
                    onUpdatePunch(movePunchPoint({ ...base, punchIn: markerTime }, 'IN', markerTime)); setContextMenu(null); } },
                { label: 'Punch-out ici', icon: 'fa-right-from-bracket', onClick: () => {
                    const base = hasPunchZone(pz) && pz.punchIn < markerTime ? pz : { ...pz, punchIn: Math.max(0, markerTime - bar) };
                    onUpdatePunch(movePunchPoint({ ...base, punchOut: markerTime }, 'OUT', markerTime)); setContextMenu(null); } },
                ...(loopEnd > loopStart + 0.05 ? [{ label: 'Punch = la boucle', icon: 'fa-repeat', onClick: () => { onUpdatePunch({ punchIn: loopStart, punchOut: loopEnd }); setContextMenu(null); } }] : []),
                ...(hasPunchZone(pz) ? [{ label: 'Effacer les points de punch', icon: 'fa-xmark', onClick: () => { onUpdatePunch({ enabled: false, punchIn: 0, punchOut: 0 }); setContextMenu(null); } }] : []),
            ] : [];
            setContextMenu({ x: e.clientX, y: e.clientY, items: [
                ...punchItems,
                ...(punchItems.length ? ['separator' as const] : []),
                { label: 'Ajouter un marqueur ici', icon: 'fa-map-pin', onClick: () => { onAddMarker(markerTime); setContextMenu(null); } },
                ...(onAddRegion ? [
                    { label: 'Créer une région ici (8 mesures)', icon: 'fa-arrows-left-right', onClick: () => { onAddRegion(markerTime, markerTime + bar * 8); setContextMenu(null); } },
                    ...(isLoopActive && loopEnd > loopStart ? [{ label: 'Créer une région = la boucle', icon: 'fa-repeat', onClick: () => { onAddRegion(loopStart, loopEnd); setContextMenu(null); } }] : []),
                ] : []),
            ]});
            return;
        }

        // Bords de région : on les tire pour caler une partie (et le prompteur).
        if (e.button !== 2 && onUpdateMarker) {
            const edgeHit = touchRef.current ? 14 : 6;
            for (const mk of markers) {
                if (mk.type !== 'REGION' || !mk.endTime) continue;
                if (Math.abs(x - mk.endTime * zoomH) < edgeHit) { regionDragRef.current = { marker: mk, edge: 'END' }; e.preventDefault(); return; }
                if (Math.abs(x - mk.time * zoomH) < edgeHit) { regionDragRef.current = { marker: mk, edge: 'START' }; e.preventDefault(); return; }
            }
        }

        if (isLoopActive && loopEnd > loopStart) {
            const loopStartX = loopStart * zoomH;
            const loopEndX = loopEnd * zoomH;
            const hitZone = 20 * (zoomH / 40); // Scale hitzone with zoom (increased from 10 to 20 for better UX)

            if (Math.abs(x - loopStartX) < hitZone) { setLoopDragMode('START'); setInitialLoopState({ start: loopStart, end: loopEnd }); setDragStartX(x); return; }
            if (Math.abs(x - loopEndX) < hitZone) { setLoopDragMode('END'); setInitialLoopState({ start: loopStart, end: loopEnd }); setDragStartX(x); return; }
            if (x > loopStartX && x < loopEndX) { setLoopDragMode('BODY'); setInitialLoopState({ start: loopStart, end: loopEnd }); setDragStartX(x); return; }
        }
        onSeek(getSnappedTime(time, bpm, gridSize, useSnap));
        setDragAction('SCRUB');
        return;
    }
    
    // Sous la règle, le couloir d'accords (au-dessus) reçoit ses propres clics.
    if (e.clientY - rect.top < tracksTop) return;
    let currentY = tracksTop;
    for (const t of visibleTracks) {
        if (y >= currentY && y < currentY + zoomV) {
            const clip = clipAtTime(rowClips(t), time);
            if (clip) {
                const bx = takeBadgeX(t, clip);
                if (bx !== null && x >= bx - 2 && x <= bx + TAKE_BADGE_W + 2 && y - currentY >= 1 && y - currentY <= TAKE_BADGE_H + 6) {
                    e.preventDefault(); e.stopPropagation();
                    openTakeMenu(t.id, e.clientX, e.clientY);
                    return;
                }
                if (e.button === 2) { e.preventDefault(); e.stopPropagation(); setClipContextMenu({ x: e.clientX, y: e.clientY, trackId: t.id, clip }); return; }
                setActiveClip({ trackId: t.id, clip });
                setSelectedClip({ trackId: t.id, clip });

                // Shift/Ctrl : on ajoute ou retire de la selection.
                // Sinon : clic sur un clip deja selectionne = on garde le groupe
                // (pour pouvoir le deplacer), clic ailleurs = selection unique.
                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                    setSelectedClipIds(prev => {
                        const next = new Set(prev);
                        if (next.has(clip.id)) next.delete(clip.id); else next.add(clip.id);
                        return next;
                    });
                } else if (!selectedClipIds.has(clip.id)) {
                    setSelectedClipIds(new Set([clip.id]));
                }

                // Positions initiales pour un deplacement groupe.
                if (selectedClipIds.size > 1 && selectedClipIds.has(clip.id)) {
                    const items: {trackId:string, clipId:string, start:number}[] = [];
                    visibleTracks.forEach(tr => rowClips(tr).forEach(c => {
                        if (selectedClipIds.has(c.id)) items.push({ trackId: tr.id, clipId: c.id, start: c.start });
                    }));
                    multiDragRef.current = items;
                } else {
                    multiDragRef.current = null;
                }

                setDragStartX(x); setDragStartY(y);
                setInitialClipState({ ...clip });
                movedRef.current = false;
                // Shuffle : photo des clips de la piste (Alt+glisser = copie libre, hors Shuffle).
                shuffleInitRef.current = editModeStore.get().mode === 'SHUFFLE' && !e.altKey ? {
                    trackId: t.id, clips: t.clips.map(c => ({ ...c })),
                    group: visibleTracks.map(tr => ({ id: tr.id, kind: tr.type === TrackType.MIDI ? 'MIDI' : tr.type === TrackType.AUDIO ? 'AUDIO' : String(tr.type), clips: tr.clips })),
                    ids: multiDragRef.current && multiDragRef.current.length > 1 ? multiDragRef.current.map(it => it.clipId) : [clip.id], shift: 0,
                } : null;
                // Ne re-sélectionner la piste que si elle change : chaque setState du
                // studio relance l'anti-rebond de l'historique (300 ms), et le début
                // d'un glissement (déplacement, rognage, fondu, gain) n'était alors
                // plus annulable.
                if (selectedTrackId !== t.id) onSelectTrack(t.id);

                // Zones d'accroche : coins superieurs = fondus, bords = rognage,
                // reste = deplacement. Jusqu'ici seul le deplacement existait sur
                // desktop : impossible de rogner un clip ou de poser un fondu.
                const clipStartX = clip.start * zoomH;
                const clipEndX = (clip.start + clip.duration) * zoomH;
                const relY = y - currentY;
                const inFadeRow = relY < zoomV * 0.35;
                const edge = Math.min(10, Math.max(4, (clipEndX - clipStartX) * 0.15));

                // Alt+glisser : on laisse une copie sur place et on deplace
                // l'original, comme dans les DAW.
                if (e.altKey) {
                    onEditClip?.(t.id, clip.id, 'DUPLICATE', { start: clip.start });
                    setDragAction('MOVE');
                    return;
                }

                // Poignée de gain (clips audio) : glisser verticalement, double-clic = 0 dB.
                const onGainHandle = !!clip.bufferId && (clipEndX - clipStartX) > 16
                    && x - clipStartX >= edge && clipEndX - x >= edge
                    && Math.abs(relY - (2 + clipGainHandleY(zoomV - 4, clip.gain ?? 1))) <= CLIP_GAIN_GRAB_PX;

                // Bas d'une jonction entre deux clips : crossfade (Smart Tool de Pro Tools).
                const junction = !touchRef.current && editCommands && relY > zoomV * 0.55
                    ? junctionNear(t.clips, time, Math.max(6, edge) / zoomH) : null;
                if (junction) {
                    const a = t.clips.find(c => c.id === junction.a)!, b = t.clips.find(c => c.id === junction.b)!;
                    xfadeDragRef.current = { trackId: t.id, a: { ...a }, b: { ...b }, at: junction.at };
                    setActiveClip(null);
                    setDragAction('XFADE');
                    return;
                }
                // Sélecteur, ou moitié haute du clip avec le Smart Tool (hors bords, coins de fondu et poignée de gain).
                const nearEdge = x - clipStartX < edge || clipEndX - x < edge;
                const onFadeCorner = inFadeRow && (x - clipStartX < FADE_HANDLE_PX || clipEndX - x < FADE_HANDLE_PX);
                if (activeTool === 'RANGE' || (activeTool === 'SMART' && !touchRef.current && relY < zoomV * 0.5 && !onGainHandle && !nearEdge && !onFadeCorner)) {
                    // Simple clic (sans glisser) dans le haut du clip : le clip est sélectionné, comme avant.
                    startRange(t.id, time, useSnap, { trackId: t.id, clip });
                    return;
                }
                editSelectionStore.set({ time: null });
                if (inFadeRow && x - clipStartX < FADE_HANDLE_PX) setDragAction('FADE_IN');
                else if (inFadeRow && clipEndX - x < FADE_HANDLE_PX) setDragAction('FADE_OUT');
                else if (onGainHandle) {
                    if (e.detail >= 2) {
                        onEditClip?.(t.id, clip.id, 'UPDATE_PROPS', { gain: 1 });
                        setGainTip({ x: e.clientX, y: e.clientY, text: '0.0 dB' });
                        setTimeout(() => setGainTip(null), 700);
                        setDragAction(null);
                        return;
                    }
                    gainDragRef.current = { lastY: y, frac: clipGainToFrac(clip.gain ?? 1) };
                    setGainTip({ x: e.clientX, y: e.clientY, text: gainToDbText(clip.gain ?? 1) });
                    setDragAction('GAIN');
                }
                else if (x - clipStartX < edge) setDragAction('TRIM_START');
                else if (clipEndX - x < edge) setDragAction('TRIM_END');
                else setDragAction('MOVE');
                return;
            }
        }
        currentY += zoomV + extraH(t);
    }
    
    if (e.button === 2) {
      e.preventDefault();
      // Zone vide d'une piste instrument : proposer la creation d'un pattern MIDI.
      let laneY = tracksTop;
      let laneTrack: Track | undefined;
      for (const t of visibleTracks) {
        const trackHeight = zoomV + extraH(t);
        if (y >= laneY && y < laneY + trackHeight) { laneTrack = t; break; }
        laneY += trackHeight;
      }
      const isInstrument = laneTrack && (laneTrack.type === TrackType.MIDI || laneTrack.type === TrackType.SAMPLER || laneTrack.type === TrackType.DRUM_RACK);
      if (isInstrument && onCreatePattern) {
        const patternTime = getSnappedTime(time, bpm, gridSize, useSnap);
        setContextMenu({ x: e.clientX, y: e.clientY, items: [
          { label: 'Créer un pattern MIDI ici', icon: 'fa-music', onClick: () => { onCreatePattern(laneTrack!.id, Math.max(0, patternTime)); setContextMenu(null); } }
        ]});
        return;
      }
      setGridMenu({ x: e.clientX, y: e.clientY });
      return;
    }

    // Zone vide d'une piste : Sélecteur, ou moitié haute avec le Smart Tool → plage de temps.
    {
      let laneY = tracksTop;
      for (const t of visibleTracks) {
        const laneH = zoomV + extraH(t);
        if (y >= laneY && y < laneY + zoomV) {
          if (activeTool === 'RANGE' || (activeTool === 'SMART' && !touchRef.current && y - laneY < zoomV * 0.5)) { startRange(t.id, time, useSnap); return; }
          break;
        }
        laneY += laneH;
      }
    }
    editSelectionStore.set({ time: null });
    setSelectedClip(null);
    if (!(e.shiftKey || e.ctrlKey || e.metaKey)) setSelectedClipIds(new Set());
    // Un simple clic deplace la tete de lecture ; si l'utilisateur glisse, cela
    // devient un rectangle de selection (comportement habituel des DAW).
    onSeek(getSnappedTime(time, bpm, gridSize, useSnap));
    // Au doigt, glisser sur une zone vide fait défiler l'arrangement.
    if (touchRef.current) { marqueeOriginRef.current = null; setDragAction(null); return; }
    marqueeOriginRef.current = { x, y };
    setDragAction('SCRUB');
};

/** Début d'une sélection de plage (point d'ancrage) : la tête de lecture y va, comme dans Pro Tools. */
const startRange = (trackId: string, rawTime: number, useSnap: boolean, clickClip?: { trackId: string; clip: Clip }) => {
    const t0 = Math.max(0, getSnappedTime(rawTime, bpm, gridSize, useSnap));
    rangeDragRef.current = { anchor: t0, anchorTrack: trackId, clickClip };
    setSelectedClip(null); setSelectedClipIds(new Set()); setActiveClip(null);
    editSelectionStore.set({ time: null });
    if (selectedTrackId !== trackId) onSelectTrack(trackId);
    onSeek(t0);
    setDragAction('RANGE');
};

const handleMouseMove = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    const rect = scrollContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - headerWidth + scrollContainerRef.current.scrollLeft;
    const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
    const useSnap = snapNow(e);
    if (dragAction === 'MOVE' || dragAction === 'TRIM_START' || dragAction === 'TRIM_END' || dragAction === 'FADE_IN' || dragAction === 'FADE_OUT') {
        setDragTipPos({ x: e.clientX, y: e.clientY });
        if (hoverHint) setHoverHint(null);
    }

    if (punchDragRef.current && punch && onUpdatePunch) {
        const tSnap = Math.max(0, getSnappedTime(x / zoomH, bpm, gridSize, useSnap));
        const next = movePunchPoint(punch, punchDragRef.current, tSnap);
        onUpdatePunch({ punchIn: next.punchIn, punchOut: next.punchOut });
        return;
    }

    const rd = regionDragRef.current;
    if (rd && onUpdateMarker) {
        const tSnap = Math.max(0, getSnappedTime(x / zoomH, bpm, gridSize, useSnap));
        const beat = 60 / (bpm || 120);
        const m = rd.marker;
        const next = rd.edge === 'END'
          ? { ...m, endTime: Math.max(m.time + beat, tSnap) }
          : { ...m, time: Math.min((m.endTime ?? tSnap + beat) - beat, tSnap) };
        regionDragRef.current = { ...rd, marker: next };
        onUpdateMarker(next);
        return;
    }

    if (loopDragMode && initialLoopState) {
        const dx = x - dragStartX;
        const dt = dx / zoomH;
        if (loopDragMode === 'START') {
            const newStart = Math.max(0, getSnappedTime(initialLoopState.start + dt, bpm, gridSize, useSnap));
            if (newStart < initialLoopState.end - 0.1) onSetLoop(newStart, initialLoopState.end);
        } else if (loopDragMode === 'END') {
            const newEnd = Math.max(0.1, getSnappedTime(initialLoopState.end + dt, bpm, gridSize, useSnap));
            if (newEnd > initialLoopState.start + 0.1) onSetLoop(initialLoopState.start, newEnd);
        } else if (loopDragMode === 'BODY') {
            const loopDuration = initialLoopState.end - initialLoopState.start;
            const newStart = Math.max(0, getSnappedTime(initialLoopState.start + dt, bpm, gridSize, useSnap));
            onSetLoop(newStart, newStart + loopDuration);
        }
        return;
    }

    // Rectangle de selection : des que le pointeur s'eloigne du point de depart,
    // on bascule du deplacement de tete de lecture vers la selection.
    if (marqueeOriginRef.current && dragAction === 'SCRUB') {
        const o = marqueeOriginRef.current;
        if (Math.abs(x - o.x) > 4 || Math.abs(y - o.y) > 4) {
            const x0 = Math.min(o.x, x), x1 = Math.max(o.x, x);
            const y0 = Math.min(o.y, y), y1 = Math.max(o.y, y);
            setMarquee({ x0, y0, x1, y1 });

            const t0 = x0 / zoomH, t1 = x1 / zoomH;
            const ids = new Set<string>();
            let laneY = tracksTop;
            for (const t of visibleTracks) {
                const laneHeight = zoomV + extraH(t);
                // La bande de clips occupe zoomV, les voies d'automation sont ignorees.
                if (y1 >= laneY && y0 <= laneY + zoomV) {
                    rowClips(t).forEach(c => {
                        if (c.start < t1 && c.start + c.duration > t0) ids.add(c.id);
                    });
                }
                laneY += laneHeight;
            }
            setSelectedClipIds(ids);
            return; // pas de deplacement de tete de lecture pendant la selection
        }
    }

    // Survol (aucun glissement) : curseur adapté à la zone du clip.
    if (!dragAction && !loopDragMode) {
        let cursor = '';
        let hint: string | null = null;
        let hovered: string | null = null;
        const tHover = x / zoomH;
        let laneY = tracksTop;
        for (const t of visibleTracks) {
            if (y >= laneY && y < laneY + zoomV) {
                const c = clipAtTime(rowClips(t), tHover);
                if (c) {
                    hovered = c.id;
                    const cx0 = c.start * zoomH, cx1 = (c.start + c.duration) * zoomH;
                    const edge = Math.min(10, Math.max(4, (cx1 - cx0) * 0.15));
                    const relY = y - laneY;
                    if (c.bufferId && (cx1 - cx0) > 16 && x - cx0 >= edge && cx1 - x >= edge
                        && Math.abs(relY - (2 + clipGainHandleY(zoomV - 4, c.gain ?? 1))) <= CLIP_GAIN_GRAB_PX) cursor = 'ns-resize';
                    else if (editCommands && relY > zoomV * 0.55 && junctionNear(t.clips, tHover, Math.max(6, edge) / zoomH)) cursor = 'col-resize';
                    else if (relY < zoomV * 0.35 && (x - cx0 < FADE_HANDLE_PX || cx1 - x < FADE_HANDLE_PX)) {
                        cursor = 'nwse-resize';
                        hint = x - cx0 < FADE_HANDLE_PX ? "Glisser vers la droite : fondu d'entrée" : 'Glisser vers la gauche : fondu de sortie';
                    }
                    else if (x - cx0 < edge || cx1 - x < edge) cursor = 'ew-resize';
                    // Smart Tool : moitié haute = Sélecteur (curseur texte), moitié basse = Grabber (main).
                    else if (activeTool === 'RANGE' || (activeTool === 'SMART' && relY < zoomV * 0.5)) cursor = 'text';
                    else if (activeTool === 'SMART') cursor = 'grab';
                } else if (activeTool === 'RANGE' || (activeTool === 'SMART' && y - laneY < zoomV * 0.5)) cursor = 'text';
                break;
            }
            laneY += zoomV + extraH(t);
        }
        const el = scrollContainerRef.current;
        if (el.style.cursor !== cursor) el.style.cursor = cursor;
        if (hint) setHoverHint({ x: e.clientX, y: e.clientY, text: hint });
        else if (hoverHint) setHoverHint(null);
        if (hovered !== hoveredClipId) setHoveredClipId(hovered);
    }

    const time = getSnappedTime(x / zoomH, bpm, gridSize, useSnap);
    if (dragAction === 'RANGE' && rangeDragRef.current) {
        // Plage : du point d'ancrage au pointeur, sur toutes les pistes traversées.
        const rd = rangeDragRef.current;
        let overId = rd.anchorTrack;
        let laneY = tracksTop;
        for (const t of visibleTracks) {
            const laneH = zoomV + extraH(t);
            if (y >= laneY && y < laneY + laneH) { overId = t.id; break; }
            laneY += laneH;
        }
        const ids = tracksBetween(visibleTracks.map(t => t.id), rd.anchorTrack, overId);
        const tNow = Math.max(0, getSnappedTime(x / zoomH, bpm, gridSize, useSnap));
        editSelectionStore.set({ time: makeSelection(rd.anchor, tNow, ids) });
        return;
    }
    if (dragAction === 'XFADE' && xfadeDragRef.current && editCommands) {
        // Longueur = 2 × la distance à la jonction (crossfade centré, comme Pro Tools).
        const xf = xfadeDragRef.current;
        const len = Math.max(0.002, 2 * Math.abs(x / zoomH - xf.at));
        const r = makeCrossfade(xf.a, xf.b, len, editPrefsStore.get().xfadeCurve, handlesOf(xf.a, xf.b, bufferDurationOf));
        if (r) {
            editCommands.patchClips(xf.trackId, { [xf.a.id]: r.a, [xf.b.id]: r.b });
            setXfadeTip({ x: e.clientX, y: e.clientY, text: `Crossfade ${Math.round((r.end - r.start) * 1000)} ms · ${FADE_CURVE_INFO[editPrefsStore.get().xfadeCurve].label}` });
        } else {
            setXfadeTip({ x: e.clientX, y: e.clientY, text: 'Pas assez d\'audio au-delà des bords' });
        }
        return;
    }
    if (dragAction === 'GAIN' && activeClip && gainDragRef.current) {
        // Maj = réglage fin (5x plus précis) ; cran à 0 dB.
        const g = gainDragRef.current;
        const waveH = Math.max(10, zoomV - 4 - 22);
        g.frac = Math.max(0, Math.min(1, g.frac - ((y - g.lastY) / waveH) * (e.shiftKey ? 0.2 : 1)));
        g.lastY = y;
        let gain = fracToClipGain(g.frac);
        if (!e.shiftKey && Math.abs(20 * Math.log10(gain)) < 0.3) gain = 1;
        onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', { gain });
        setGainTip({ x: e.clientX, y: e.clientY, text: gainToDbText(gain) });
        return;
    }
    if (dragAction === 'MOVE' && activeClip && initialClipState) {
        const dx = x - dragStartX;
        // Seuil de 4 px : un simple clic (ou une main qui tremble) ne déplace plus
        // la prise. Avant, le moindre mouvement la recalait sur la grille.
        if (!movedRef.current && Math.abs(dx) < 4 && Math.abs(y - dragStartY) < 4) return;
        movedRef.current = true;
        const dt = dx / zoomH;
        const inv = invertOf(e);
        if (inv !== dragInvert) setDragInvert(inv);
        // Shuffle (Pro Tools) : toute la sélection s'insère au bord le plus proche, les
        // pistes de départ se recollent, celles d'arrivée avancent ; on peut changer de piste.
        const shInit = shuffleInitRef.current;
        if (editModeStore.get().mode === 'SHUFFLE' && shInit) {
            const from = shInit.group.findIndex(g => g.id === shInit.trackId);
            let row = -1, yy = 40;
            for (let i = 0; i < visibleTracks.length; i++) {
                const hh = zoomV + extraH(visibleTracks[i]);
                if (y >= yy && y < yy + hh) { row = i; break; }
                yy += hh;
            }
            const wantShift = row >= 0 && from >= 0 ? row - from : shInit.shift;
            const r = shuffleGroupDrag(shInit.group, shInit.ids, activeClip.clip.id, initialClipState.start + dt, wantShift);
            if (r && r.trackShift !== shInit.shift) {
                shInit.shift = r.trackShift;
                const dest = shInit.group[from + r.trackShift];
                if (dest) setActiveClip({ trackId: dest.id, clip: activeClip.clip });
            }
            return;
        }
        // Grid relatif : on aimante le déplacement (la prise garde son décalage) ;
        // Grid absolu : le début (ou le point de synchro) tombe sur la grille ;
        // Slip / Spot : libre, à l'échantillon près (utils/editModes).
        const newStart = moveClipStart({ settings: editModeStore.get(), invert: inv, bpm, origStart: initialClipState.start,
            rawStart: initialClipState.start + dt, syncOffset: syncOffsetOf(initialClipState) });

        // Détecter la piste cible en fonction de la position Y
        let targetTrackId = activeClip.trackId;
        let currentY = tracksTop;
        for (const t of visibleTracks) {
            const trackHeight = zoomV + extraH(t);
            if (y >= currentY && y < currentY + trackHeight) {
                targetTrackId = t.id;
                break;
            }
            currentY += trackHeight;
        }

        // Si changement de piste, déplacer le clip vers la nouvelle piste
        // (uniquement en selection simple : un groupe se deplace dans le temps).
        if (targetTrackId !== activeClip.trackId && !(multiDragRef.current && multiDragRef.current.length > 1) && editModeStore.get().mode !== 'SHUFFLE') {
            onMoveClip?.(activeClip.trackId, targetTrackId, activeClip.clip.id);
            setActiveClip({ trackId: targetTrackId, clip: activeClip.clip });
        }

        // Deplacement groupe : on applique le meme decalage a tous les clips
        // selectionnes, en une seule mise a jour d'etat.
        if (multiDragRef.current && multiDragRef.current.length > 1) {
            const delta = newStart - initialClipState.start;
            onMoveClipsBy?.(multiDragRef.current, delta);
            return;
        }

        // Mettre à jour la position temporelle
        if (newStart !== activeClip.clip.start) {
            onEditClip?.(targetTrackId, activeClip.clip.id, 'UPDATE_PROPS', { start: newStart });
        }
    } else if (dragAction === 'TRIM_START' && activeClip && initialClipState) {
        // Rogner le debut : on avance le point de depart ET la lecture dans le
        // buffer, pour que le contenu audio ne glisse pas.
        const init = initialClipState;
        const shInit = shuffleInitRef.current;
        if (editModeStore.get().mode === 'SHUFFLE' && shInit && shInit.trackId === activeClip.trackId) {
            // Shuffle : le clip reste en place, la suite recule / avance d'autant.
            shuffleDrag(shInit.trackId, shInit.clips, activeClip.clip.id, 'TRIM_START', toSample(init.start + (x - dragStartX) / zoomH));
            return;
        }
        // Grid relatif : le bord avance par pas de grille en gardant son décalage (Pro Tools).
        const rawStart = trimEdgeTime({ settings: editModeStore.get(), invert: invertOf(e), bpm, origEdge: init.start, rawEdge: init.start + (x - dragStartX) / zoomH });
        const maxStart = init.start + init.duration - 0.05;
        const minStart = init.start - (init.offset || 0);
        const newStart = Math.min(maxStart, Math.max(0, Math.max(minStart, rawStart)));
        const delta = newStart - init.start;
        onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', {
            start: newStart,
            offset: Math.max(0, (init.offset || 0) + delta),
            duration: Math.max(0.05, init.duration - delta),
            fadeIn: Math.min(init.fadeIn || 0, Math.max(0, init.duration - delta))
        });
    } else if (dragAction === 'TRIM_END' && activeClip && initialClipState) {
        const init = initialClipState;
        const shInit = shuffleInitRef.current;
        if (editModeStore.get().mode === 'SHUFFLE' && shInit && shInit.trackId === activeClip.trackId) {
            shuffleDrag(shInit.trackId, shInit.clips, activeClip.clip.id, 'TRIM_END', toSample(init.start + init.duration + (x - dragStartX) / zoomH));
            return;
        }
        const rawEnd = trimEdgeTime({ settings: editModeStore.get(), invert: invertOf(e), bpm, origEdge: init.start + init.duration, rawEdge: init.start + init.duration + (x - dragStartX) / zoomH });
        const newDuration = Math.max(0.05, rawEnd - init.start);
        onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', {
            duration: newDuration,
            fadeOut: Math.min(init.fadeOut || 0, newDuration)
        });
    } else if (dragAction === 'FADE_IN' && activeClip && initialClipState) {
        const init = initialClipState;
        const fadeIn = Math.min(init.duration, Math.max(0, (x - init.start * zoomH) / zoomH));
        onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', { fadeIn });
    } else if (dragAction === 'FADE_OUT' && activeClip && initialClipState) {
        const init = initialClipState;
        const clipEndX = (init.start + init.duration) * zoomH;
        const fadeOut = Math.min(init.duration, Math.max(0, (clipEndX - x) / zoomH));
        onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', { fadeOut });
    } else if (dragAction === 'SCRUB') {
        onSeek(time);
    }
};

const handleMouseUp = () => {
    setDragTipPos(null);
    if (longPressRef.current) { clearTimeout(longPressRef.current.timer); longPressRef.current = null; }
    // Spot (Pro Tools) : un clic (sans glisser) sur un clip ouvre « Position exacte ».
    if (dragAction === 'MOVE' && activeClip && !movedRef.current && editModeStore.get().mode === 'SPOT') {
        setSpotTarget({ trackId: activeClip.trackId, clipId: activeClip.clip.id });
    }
    shuffleInitRef.current = null;
    if (dragInvert) setDragInvert(false);
    regionDragRef.current = null;
    punchDragRef.current = null;
    if (xfadeDragRef.current) { xfadeDragRef.current = null; setXfadeTip(null); }
    const rd = rangeDragRef.current;
    if (rd?.clickClip && !editSelectionStore.get().time) {
        setSelectedClip(rd.clickClip);
        setSelectedClipIds(new Set([rd.clickClip.clip.id]));
    }
    rangeDragRef.current = null;
    // Crossfade automatique quand un clip déplacé / rogné touche ou chevauche un voisin.
    if (editCommands && activeClip && (dragAction === 'MOVE' || dragAction === 'TRIM_START' || dragAction === 'TRIM_END')) {
        const ids = multiDragRef.current && multiDragRef.current.length > 1 ? multiDragRef.current : [{ trackId: activeClip.trackId, clipId: activeClip.clip.id }];
        const byTrack = new Map<string, string[]>();
        ids.forEach(it => byTrack.set(it.trackId, [...(byTrack.get(it.trackId) || []), it.clipId]));
        // Après le dernier rendu (la position finale du clip est dans l'état).
        setTimeout(() => byTrack.forEach((cids, tid) => editCommands.autoCrossfade(tid, cids)), 0);
    }
    if (gainDragRef.current) { gainDragRef.current = null; setGainTip(null); }
    setDragAction(null);
    setActiveClip(null);
    setLoopDragMode(null);
    setInitialLoopState(null);
    setInitialClipState(null);
    marqueeOriginRef.current = null;
    multiDragRef.current = null;
    setMarquee(null);
};

const drawClip = (ctx: CanvasRenderingContext2D, clip: Clip, trackColor: string, x: number, y: number, w: number, h: number, isSelected: boolean, zoomH: number, isHovered = false) => {
    if (x + w < 0 || x > ctx.canvas.width) return;

    const clipColor = clip.color || trackColor;
    const cv = canvasTheme();
    
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.clip();

    // Fond du clip
    const gradient = ctx.createLinearGradient(x, y, x, y + h);
    gradient.addColorStop(0, clip.isMuted ? cv.clipMutedTop : cv.clipTop);
    gradient.addColorStop(1, clip.isMuted ? cv.clipMutedBottom : cv.clipBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);

    // Bordure colorée en haut (style Pro Tools)
    ctx.fillStyle = clipColor + (clip.isMuted ? '44' : 'aa');
    ctx.fillRect(x, y, w, 3);

    // ========== WAVEFORM RENDERING (Pro Tools style) ==========
    // Seule la partie visible du clip est tracee, a partir des cretes min/max
    // pre-calculees (utils/waveformPeaks) : plus de rebalayage du buffer au zoom.
    if (clip.bufferId) {
        const buffer = audioBufferRegistry.get(clip.bufferId);
        if (buffer) {
            const sampleRate = buffer.sampleRate;
            const offset = clip.offset || 0;
            const clipDuration = clip.duration;

            // Calculer les samples à afficher
            const startSample = Math.floor(offset * sampleRate);
            const endSample = Math.min(buffer.length, Math.floor((offset + clipDuration) * sampleRate));
            const totalSamples = endSample - startSample;

            // Waveform area (avec padding pour le nom du clip)
            const waveY = y + 18;
            const waveH = h - 22;
            const centerY = waveY + waveH / 2;

            if (w > 2 && totalSamples > 0 && waveH > 4) {
                const waveColor = clip.isMuted ? cv.mutedWave : clipColor;
                const largeurPx = Math.max(1, Math.round(w));
                // Pixels du clip reellement visibles dans le canvas.
                const px0 = Math.max(0, Math.floor(-x));
                const px1 = Math.min(largeurPx, Math.ceil(ctx.canvas.width - x) + 1);

                if (px1 > px0) {
                    const n = px1 - px0;
                    const amp = waveH * 0.45;
                    // Un clip inverse jouait a l'envers mais s'affichait a l'endroit :
                    // on lit la portion miroir du buffer pour que la forme d'onde
                    // corresponde a ce qu'on entend.
                    const env = visibleEnvelope(buffer, startSample, endSample, largeurPx, px0, px1, !!clip.isReversed);
                    // Forme d'onde à l'échelle du gain du clip (écrêtée visuellement à 100 %).
                    const clipGain = clip.gain ?? 1;
                    if (clipGain !== 1) for (let i = 0; i < n; i++) env[i] = Math.min(1, env[i] * clipGain);
                    const x0 = x + px0;
                    // Respirations baissées / supprimées (utils/breaths) : la forme d'onde
                    // montre le creux, et un trait violet en bas du clip les repère.
                    if (clip.breaths?.length && !clip.isReversed) {
                        const off = clip.offset || 0;
                        for (let i = 0; i < n; i++) env[i] *= breathGainAt(clip.breaths, off + ((px0 + i + 0.5) / largeurPx) * clip.duration);
                        for (const b of clip.breaths) {
                            const bx0 = x + ((b.start - off) / clip.duration) * largeurPx, bx1 = x + ((b.end - off) / clip.duration) * largeurPx;
                            if (bx1 <= x || bx0 >= x + largeurPx) continue;
                            const l = Math.max(x, bx0), wd = Math.max(2, Math.min(x + largeurPx, bx1) - l);
                            ctx.fillStyle = 'rgba(167,139,250,0.16)';
                            ctx.fillRect(l, waveY, wd, waveH);
                            ctx.fillStyle = '#a78bfa';
                            ctx.fillRect(l, waveY + waveH - 3, wd, 3);
                        }
                    }

                    // ===== STYLE PRO TOOLS: Filled waveform avec outline =====
                    ctx.fillStyle = waveColor + '55';  // Semi-transparent fill
                    ctx.beginPath();
                    ctx.moveTo(x0, centerY);
                    for (let i = 0; i < n; i++) ctx.lineTo(x0 + i, centerY - env[i] * amp);
                    for (let i = n - 1; i >= 0; i--) ctx.lineTo(x0 + i, centerY + env[i] * amp);
                    ctx.closePath();
                    ctx.fill();

                    // Contour superieur et inferieur, en un seul trace.
                    ctx.strokeStyle = waveColor + 'aa';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x0, centerY - env[0] * amp);
                    for (let i = 1; i < n; i++) ctx.lineTo(x0 + i, centerY - env[i] * amp);
                    ctx.moveTo(x0, centerY + env[0] * amp);
                    for (let i = 1; i < n; i++) ctx.lineTo(x0 + i, centerY + env[i] * amp);
                    ctx.stroke();

                    // Ligne centrale (0 dB)
                    ctx.strokeStyle = cv.ink(0.1);
                    ctx.lineWidth = 1;
                    ctx.setLineDash([2, 4]);
                    ctx.beginPath();
                    ctx.moveTo(x0, centerY);
                    ctx.lineTo(x0 + n, centerY);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }
        }
    }

    ctx.restore();
    
    // Bordure extérieure du clip
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.strokeStyle = isSelected ? cv.ink(0.95) : (clipColor + '66');
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();
    ctx.restore();

    // Point de synchro (Pro Tools : Sync Point) : trait pointillé + petit triangle en bas.
    const syncRel = syncOffsetOf(clip);
    if (syncRel !== null && w > 6) {
        const sx = Math.round(x + syncRel * zoomH) + 0.5;
        ctx.save();
        ctx.strokeStyle = 'rgba(234,179,8,0.85)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx, y + 4); ctx.lineTo(sx, y + h - 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#eab308';
        ctx.beginPath(); ctx.moveTo(sx - 5, y + h - 1); ctx.lineTo(sx + 5, y + h - 1); ctx.lineTo(sx, y + h - 8); ctx.closePath(); ctx.fill();
        ctx.restore();
    }

    // Fondus : zone assombrie + poignee dans le coin superieur.
    // Ils etaient appliques a la lecture mais totalement invisibles et non
    // reglables depuis l'arrangement.
    const fadeInW = clip.duration > 0 ? Math.min(w, ((clip.fadeIn || 0) / clip.duration) * w) : 0;
    const fadeOutW = clip.duration > 0 ? Math.min(w, ((clip.fadeOut || 0) / clip.duration) * w) : 0;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.clip();

    // Courbe réelle du fondu (linéaire, puissance égale, exponentielle, en S).
    if (fadeInW > 1) drawFadeShape(ctx, x, fadeInW, y, h, clip.fadeInCurve, 'in', cv.ink(0.75));
    if (fadeOutW > 1) drawFadeShape(ctx, x + w - fadeOutW, fadeOutW, y, h, clip.fadeOutCurve, 'out', cv.ink(0.75));
    ctx.restore();

    // Poignees de fondu : bien visibles au survol et sur le clip selectionne (G7)
    if (isSelected || isHovered || w > 60) {
        ctx.fillStyle = isSelected || isHovered ? cv.ink(0.9) : cv.ink(0.35);
        const hx = x + Math.max(0, fadeInW);
        ctx.fillRect(Math.min(hx, x + w - 6), y + 2, 6, 6);
        const hx2 = x + w - Math.max(0, fadeOutW) - 6;
        ctx.fillRect(Math.max(hx2, x), y + 2, 6, 6);
    }

    // Nom du clip avec fond, dessiné APRÈS les fondus : la ligne de fondu ne le traverse plus (F3).
    if (w > 30) {
        ctx.font = '600 11px Inter';
        ctx.fillStyle = cv.labelBg;
        ctx.fillRect(x + 4, y + 3, Math.min(ctx.measureText(clip.name).width + 10, w - 8), 15);
        ctx.fillStyle = clip.isMuted ? cv.labelMuted : cv.labelText;
        ctx.fillText(clip.name, x + 9, y + 14, w - 18);
    }

    // Poignée de gain de clip
    if (clip.bufferId && w > 16 && h > 30) {
        const g = clip.gain ?? 1;
        const hy = Math.round(y + clipGainHandleY(h, g)) + 0.5;
        const modified = Math.abs(g - 1) > 0.001;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 4);
        ctx.clip();
        ctx.strokeStyle = modified ? 'rgba(251,191,36,0.9)' : (isSelected ? cv.ink(0.55) : cv.ink(0.22));
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 2, hy); ctx.lineTo(x + w - 2, hy); ctx.stroke();
        // petit curseur au centre (zone visible du clip)
        const vx0 = Math.max(x, 0), vx1 = Math.min(x + w, ctx.canvas.width);
        const cxm = (vx0 + vx1) / 2;
        ctx.fillStyle = modified ? '#fbbf24' : (isSelected ? cv.ink(1) : cv.ink(0.5));
        ctx.fillRect(Math.round(cxm - 7), Math.round(hy - 2.5), 14, 5);
        if (modified && w > 50) {
            const label = gainToDbText(g);
            ctx.font = '700 10px Inter';
            const tw = ctx.measureText(label).width;
            const ly = hy - 4 < y + 30 ? hy + 13 : hy - 5;
            // Étiquette entière ou rien (F3 : « -4.8 d » coupé au bord du clip).
            const right = Math.min(x + w, ctx.canvas.width) - 2;
            const lx = cxm + 10 + tw + 6 <= right ? cxm + 10 : (cxm - 10 - tw - 6 >= Math.max(x, 0) + 2 ? cxm - 10 - tw - 6 : null);
            if (lx !== null) {
                ctx.fillStyle = cv.labelBg;
                ctx.fillRect(lx, ly - 10, tw + 6, 13);
                ctx.fillStyle = '#fbbf24';
                ctx.fillText(label, lx + 3, ly);
            }
        }
        ctx.restore();
    }

    // Indicateur de mute
    if (clip.isMuted) {
        ctx.fillStyle = 'rgba(255,0,0,0.3)';
        ctx.fillRect(x, y, w, h);
    }
};

const drawTimeline = useCallback(() => {
    const canvas = canvasRef.current;
    const scroll = scrollContainerRef.current;
    if (!canvas || !scroll) return;
    
    // La resolution interne doit suivre la taille CSS reelle du canvas,
    // sinon le contenu dessine est etire horizontalement.
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth > 0 && cssHeight > 0 && (canvas.width !== cssWidth || canvas.height !== cssHeight)) {
        canvas.width = cssWidth;
        canvas.height = cssHeight;
    }

    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const scrollX = scroll.scrollLeft;
    const scrollTop = scroll.scrollTop;
    
    ctx.clearRect(0, 0, w, h);
    const cv = canvasTheme();
    
    const beatPx = (60 / bpm) * zoomH;
    const startTime = pixelsToTime(scrollX);
    const endTime = pixelsToTime(scrollX + w);
    const startBar = Math.floor(startTime * (bpm / 60) / 4);
    const endBar = Math.ceil(endTime * (bpm / 60) / 4);
    
    const subDivisionsPerBar = gridSubdivisionsPerBar(gridSize);
    const subStepPx = (4 * beatPx) / subDivisionsPerBar;
    // Grille en temps (ms, images) : traits réguliers indépendants du tempo, par-dessus les mesures.
    const timeStep = timeGridStep(gridSize);

    ctx.lineWidth = 1;
    for (let i = startBar; i <= endBar; i++) {
        const time = i * 4 * (60 / bpm);
        const x = timeToPixels(time) - scrollX;
        ctx.strokeStyle = cv.ink(0.08);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        
        if (!timeStep && subStepPx > 5 && subDivisionsPerBar > 1) {
            for (let j = 1; j < subDivisionsPerBar; j++) {
                const subX = x + j * subStepPx;
                if (isBeatLine(j, subDivisionsPerBar)) {
                    ctx.strokeStyle = cv.ink(0.05);
                } else {
                    ctx.strokeStyle = cv.ink(0.035);
                }
                ctx.beginPath(); ctx.moveTo(subX, 0); ctx.lineTo(subX, h); ctx.stroke();
            }
        }
    }
    if (timeStep && timeToPixels(timeStep) > 5) {
        ctx.strokeStyle = cv.ink(0.04);
        for (let k = Math.max(0, Math.floor(startTime / timeStep)); k * timeStep <= endTime; k++) {
            const tx = timeToPixels(k * timeStep) - scrollX;
            ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, h); ctx.stroke();
        }
    }

    if (isLoopActive && loopEnd > loopStart) {
        const loopStartX = timeToPixels(loopStart) - scrollX;
        const loopEndX = timeToPixels(loopEnd) - scrollX;
        const loopWidth = timeToPixels(loopEnd - loopStart);
        if (loopStartX + loopWidth > 0 && loopStartX < w) {
            // Zone de loop avec opacité augmentée
            ctx.fillStyle = cv.accentFill(0.15);
            ctx.fillRect(loopStartX, tracksTop, loopWidth, h - tracksTop);

            // Lignes verticales de début et fin de loop plus visibles
            ctx.strokeStyle = cv.accent;
            ctx.lineWidth = 3;

            // Ligne de début
            ctx.beginPath();
            ctx.moveTo(loopStartX, tracksTop);
            ctx.lineTo(loopStartX, h);
            ctx.stroke();

            // Ligne de fin
            ctx.beginPath();
            ctx.moveTo(loopEndX, tracksTop);
            ctx.lineTo(loopEndX, h);
            ctx.stroke();

            // Poignées en haut pour mieux visualiser les curseurs
            ctx.fillStyle = cv.accent;
            // Poignée début (triangle)
            ctx.beginPath();
            ctx.moveTo(loopStartX - 8, tracksTop);
            ctx.lineTo(loopStartX + 8, tracksTop);
            ctx.lineTo(loopStartX, tracksTop + 15);
            ctx.fill();

            // Poignée fin (triangle)
            ctx.beginPath();
            ctx.moveTo(loopEndX - 8, tracksTop);
            ctx.lineTo(loopEndX + 8, tracksTop);
            ctx.lineTo(loopEndX, tracksTop + 15);
            ctx.fill();
        }
    }
    
    // Dessiner les clips SANS translate - coordonnées relatives au viewport
    let currentY = tracksTop; // Position absolue dans le document
    visibleTracks.forEach((track) => {
        const trackH = zoomV;
        const totalAutomationHeight = extraH(track);
        
        // Position Y relative au viewport (après scroll)
        const viewportY = currentY - scrollTop;

        // Vérifier si la piste est visible dans le viewport
        if (viewportY + trackH > tracksTop && viewportY < h) {
            rowClips(track).forEach(clip => {
                const cx = timeToPixels(clip.start) - scrollX;
                const cw = timeToPixels(clip.duration);
                if (cx + cw > 0 && cx < w) {
                    // Dessiner le clip à sa position relative dans le viewport
                    const clipY = Math.max(viewportY + 2, tracksTop); // Ne pas dessiner sous la règle ni le couloir d'accords
                    const clipH = Math.min(trackH - 4, viewportY + trackH - 2 - clipY);
                    if (clipH > 0) {
                        drawClip(ctx, clip, track.color, cx, clipY, cw, clipH, (selectedClip?.clip.id === clip.id) || (activeClip?.clip.id === clip.id) || selectedClipIds.has(clip.id), zoomH, hoveredClipId === clip.id);
                        const bx = takeBadgeX(track, clip);
                        if (bx !== null && viewportY + 3 >= tracksTop) {
                            const n = lanesByTrack.get(track.id)!.length;
                            const x0 = bx - scrollX, y0 = viewportY + 3;
                            ctx.save();
                            ctx.fillStyle = cv.labelBg;
                            ctx.strokeStyle = takeColor(takeNumberOf(clip)!);
                            ctx.lineWidth = 1;
                            ctx.beginPath();
                            (ctx as any).roundRect ? (ctx as any).roundRect(x0, y0, TAKE_BADGE_W, TAKE_BADGE_H, 9) : ctx.rect(x0, y0, TAKE_BADGE_W, TAKE_BADGE_H);
                            ctx.fill(); ctx.stroke();
                            ctx.fillStyle = cv.labelText;
                            ctx.font = '700 10px Inter, sans-serif';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(`Prises (${n}) ▾`, x0 + 9, y0 + TAKE_BADGE_H / 2 + 0.5);
                            ctx.restore();
                        }
                    }
                }
            });
        }
        
        // Crossfades (zone commune de deux clips en fondu croisé) : les deux courbes, en ambre.
        if (viewportY + trackH > tracksTop && viewportY < h) {
            for (const z of crossfadeZones(track.clips)) {
                const a = track.clips.find(c => c.id === z.a)!, b = track.clips.find(c => c.id === z.b)!;
                const zx = timeToPixels(z.start) - scrollX, zw = timeToPixels(z.end - z.start);
                if (zx + zw < 0 || zx > w || zw < 2) continue;
                const zy = Math.max(viewportY + 2, tracksTop), zh = Math.min(trackH - 4, viewportY + trackH - 2 - zy);
                if (zh <= 0) continue;
                ctx.save();
                ctx.fillStyle = 'rgba(251,191,36,0.10)';
                ctx.fillRect(zx, zy, zw, zh);
                const n = Math.max(8, Math.min(64, Math.round(zw / 2)));
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(251,191,36,0.95)';
                ctx.beginPath();
                for (let i = 0; i <= n; i++) { const u = i / n; const py = zy + zh * (1 - fadeOutShape(a.fadeOutCurve, u)); if (i) ctx.lineTo(zx + zw * u, py); else ctx.moveTo(zx, py); }
                ctx.stroke();
                ctx.beginPath();
                for (let i = 0; i <= n; i++) { const u = i / n; const py = zy + zh * (1 - fadeInShape(b.fadeInCurve, u)); if (i) ctx.lineTo(zx + zw * u, py); else ctx.moveTo(zx, py); }
                ctx.stroke();
                ctx.restore();
            }
        }
        // Voies d'automation ouvertes : la courbe écrite ou dessinée (utils/automationDraw).
        if (totalAutomationHeight > 0) drawExpandedLanes(ctx, track, viewportY + trackH, w, h, zoomH, scrollX);

        // Dessiner les séparateurs de pistes (position relative au viewport)
        if (viewportY + trackH + totalAutomationHeight > tracksTop && viewportY < h) {
            const lineY = viewportY + trackH + totalAutomationHeight;
            ctx.strokeStyle = cv.ink(0.1);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, lineY);
            ctx.lineTo(w, lineY);
            ctx.stroke();
        }

        currentY += trackH + totalAutomationHeight;
    });

    ctx.fillStyle = cv.surface;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = cv.ink(0.1);
    ctx.beginPath(); ctx.moveTo(0, RULER_H); ctx.lineTo(w, RULER_H); ctx.stroke();

    ctx.fillStyle = cv.textMuted;
    ctx.font = '600 11px Inter';
    for (let i = startBar; i <= endBar; i++) {
        const time = i * 4 * (60 / bpm);
        const x = timeToPixels(time) - scrollX;
        if (x >= -50) ctx.fillText((i+1).toString(), x + 4, 24);
    }
    
    // Draw Markers (inspired by Pro Tools/Reaper)
    markers.forEach(marker => {
        const markerX = timeToPixels(marker.time) - scrollX;
        
        if (markerX >= -20 && markerX <= w + 20) {
            if (marker.type === 'REGION' && marker.endTime) {
                // Region marker (like Pro Tools Memory Locations)
                const endX = timeToPixels(marker.endTime) - scrollX;
                ctx.fillStyle = marker.color + '22';
                ctx.fillRect(markerX, 0, endX - markerX, RULER_H);
                ctx.strokeStyle = marker.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(markerX, 0); ctx.lineTo(markerX, RULER_H);
                ctx.moveTo(endX, 0); ctx.lineTo(endX, RULER_H);
                ctx.stroke();
            }
            
            // Marker flag
            ctx.fillStyle = marker.color;
            ctx.beginPath();
            ctx.moveTo(markerX, 0);
            ctx.lineTo(markerX + 12, 0);
            ctx.lineTo(markerX + 12, 8);
            ctx.lineTo(markerX + 6, 12);
            ctx.lineTo(markerX, 8);
            ctx.closePath();
            ctx.fill();
            
            // Marker line
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(markerX, 12);
            ctx.lineTo(markerX, h);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // Marker name
            ctx.fillStyle = cv.text;
            ctx.font = 'bold 8px Inter';
            ctx.fillText(marker.name, markerX + 14, 10);
        }
    });

    // Zone de punch (Pro Tools : barre rouge dans la règle, points d'entrée / de sortie).
    if (punch && hasPunchZone(punch)) {
        const px0 = timeToPixels(punch.punchIn) - scrollX;
        const px1 = timeToPixels(punch.punchOut) - scrollX;
        if (px1 > -20 && px0 < w + 20) {
            const on = !!punch.enabled;
            ctx.fillStyle = on ? 'rgba(239, 68, 68, 0.55)' : 'rgba(239, 68, 68, 0.2)';
            ctx.fillRect(px0, 31, px1 - px0, 8);
            if (on) {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
                ctx.fillRect(px0, tracksTop, px1 - px0, h - tracksTop);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(px0 + 0.5, tracksTop); ctx.lineTo(px0 + 0.5, h); ctx.moveTo(px1 - 0.5, tracksTop); ctx.lineTo(px1 - 0.5, h); ctx.stroke();
                ctx.setLineDash([]);
            }
            // Poignées : crochets d'entrée et de sortie.
            ctx.fillStyle = on ? '#ef4444' : 'rgba(239, 68, 68, 0.6)';
            ctx.beginPath(); ctx.moveTo(px0, 26); ctx.lineTo(px0 + 7, 26); ctx.lineTo(px0, RULER_H); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(px1, 26); ctx.lineTo(px1 - 7, 26); ctx.lineTo(px1, RULER_H); ctx.closePath(); ctx.fill();
            if (px1 - px0 > 50) {
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 8px Inter';
                ctx.fillText('PUNCH', px0 + 9, 38);
            }
        }
    }

    // Sélection de plage (Sélecteur / Smart Tool) : bande claire sur les pistes choisies + repère dans la règle.
    if (timeSel) {
        const sx = timeToPixels(timeSel.start) - scrollX;
        const sw = Math.max(1, timeToPixels(timeSel.end - timeSel.start));
        if (sx + sw > 0 && sx < w) {
            let ly = tracksTop;
            visibleTracks.forEach(t => {
                const laneH = zoomV + extraH(t);
                if (timeSel.trackIds.includes(t.id)) {
                    const vy = ly - scrollTop;
                    const top = Math.max(tracksTop, vy), bottom = Math.min(h, vy + zoomV);
                    if (bottom > top) {
                        ctx.fillStyle = 'rgba(186, 230, 253, 0.22)';
                        ctx.fillRect(sx, top, sw, bottom - top);
                        ctx.strokeStyle = 'rgba(125, 211, 252, 0.9)';
                        ctx.lineWidth = 1;
                        ctx.strokeRect(sx + 0.5, top + 0.5, sw - 1, bottom - top - 1);
                    }
                }
                ly += laneH;
            });
            ctx.fillStyle = 'rgba(125, 211, 252, 0.8)';
            ctx.fillRect(sx, 22, sw, 4);
        }
    }

    // Rectangle de selection
    if (marquee) {
        const mx = marquee.x0 - scrollX, my = marquee.y0 - scrollTop;
        const mw = marquee.x1 - marquee.x0, mh = marquee.y1 - marquee.y0;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
        ctx.fillRect(mx, my, mw, mh);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
        ctx.setLineDash([]);
    }

    // La tete de lecture est dessinee sur le calque superieur (drawPlayhead).
}, [visibleTracks, zoomV, zoomH, activeClip, selectedClip, isLoopActive, loopStart, loopEnd, bpm, viewportSize.width, viewportSize.height, headerWidth, gridSize, scrollLeft, scrollTop, markers, selectedClipIds, marquee, punch, timeSel, lanesKey, lanesByTrack, hoveredClipId, uiTheme, tracksTop]);

// Calque statique (grille, clips, formes d'onde, reperes) : redessine seulement
// quand son contenu change, plus a chaque image de la lecture.
useEffect(() => {
    requestRef.current = requestAnimationFrame(drawTimeline);
    return () => cancelAnimationFrame(requestRef.current);
}, [drawTimeline]);

// --- Calque de la tete de lecture (et curseur d'enregistrement) ---
// Redessine a chaque image depuis playheadStore, sans rendu React : on efface
// seulement la bande de l'ancienne position.
const overlayRef = useRef<HTMLCanvasElement>(null);
const lastPlayheadXRef = useRef<number | null>(null);
const isPlayingRef = useRef(isPlaying);
isPlayingRef.current = isPlaying;
const viewportWidthRef = useRef(viewportSize.width);
viewportWidthRef.current = viewportSize.width;

const drawPlayhead = useCallback(() => {
    const ov = overlayRef.current;
    const scroll = scrollContainerRef.current;
    if (!ov || !scroll) return;
    const ctx = ov.getContext('2d');
    if (!ctx) return;
    const w = ov.width, h = ov.height;
    const t = playheadStore.get();

    // Suivi du playhead pendant la lecture : on avance d'une "page" plutot que
    // de recentrer en continu (bien moins fatigant a l'oeil, comme les DAW).
    if (isPlayingRef.current && Date.now() >= followSuspendedUntilRef.current) {
        const playheadX = t * zoomH;
        const viewStart = scroll.scrollLeft;
        const cw = viewportWidthRef.current || scroll.clientWidth;
        if (playheadX > viewStart + cw - cw * 0.12 || playheadX < viewStart) {
            autoScrollRef.current = true;
            scroll.scrollLeft = Math.max(0, playheadX - cw * 0.15);
        }
    }

    const last = lastPlayheadXRef.current;
    if (last !== null) ctx.clearRect(Math.floor(last) - 7, 0, 15, h);
    lastPlayheadXRef.current = null;

    if (minimapPlayheadRef.current) {
        minimapPlayheadRef.current.style.transform = `translateX(${t * zoomH * minimapScaleRef.current}px)`;
    }

    const phX = Math.round(t * zoomH - scroll.scrollLeft) + 0.5;
    if (phX >= 0 && phX <= w) {
        const color = isRecording ? '#ef4444' : '#00f2ff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(phX - 5, 0); ctx.lineTo(phX + 5, 0); ctx.lineTo(phX, 10); ctx.fill();
        lastPlayheadXRef.current = phX;
    }
}, [zoomH, isRecording]);

useEffect(() => {
    // Taille du calque : relue seulement quand la disposition change.
    const ov = overlayRef.current;
    if (ov) {
        const cw = ov.clientWidth, ch = ov.clientHeight;
        if (cw > 0 && ch > 0 && (ov.width !== cw || ov.height !== ch)) {
            ov.width = cw; ov.height = ch;
            lastPlayheadXRef.current = null;
        }
    }
    drawPlayhead();
    return playheadStore.subscribe(drawPlayhead);
}, [drawPlayhead, scrollLeft, viewportSize.width, viewportSize.height, headerWidth, isPlaying]);

  return (
    <div className="nova-grille flex-1 flex flex-col overflow-hidden relative select-none" onContextMenu={e => e.preventDefault()}>
      <div className="h-12 flex items-center px-4 gap-4 z-30 shrink-0">
        <div className="flex items-center space-x-4 shrink-0">
          {/* Au doigt : outils de 40 px (36 px à la souris) */}
          <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
            <button onClick={() => setActiveTool('SELECT')} className={`w-9 h-9 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-lg flex items-center justify-center transition-all ${activeTool === 'SELECT' ? 'bg-[#38bdf8] text-black nova-halo' : 'text-slate-500 hover:text-white'}`} title="Sélection / déplacement (1)" aria-label="Outil sélection"><i className="fas fa-mouse-pointer text-[12px]"></i></button>
            <button onClick={() => setActiveTool('SPLIT')} className={`w-9 h-9 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-lg flex items-center justify-center transition-all ${activeTool === 'SPLIT' ? 'bg-[#38bdf8] text-black nova-halo' : 'text-slate-500 hover:text-white'}`} title="Ciseaux : couper un clip (2)" aria-label="Outil ciseaux"><i className="fas fa-cut text-[12px]"></i></button>
            <button onClick={() => setActiveTool('SMART')} aria-pressed={activeTool === 'SMART'} className={`hidden [@media(pointer:fine)]:flex w-9 h-9 rounded-lg items-center justify-center transition-all ${activeTool === 'SMART' ? 'bg-[#38bdf8] text-black nova-halo' : 'text-slate-500 hover:text-white'}`}
              title="Smart Tool (comme dans Pro Tools) (5) : moitié haute du clip = sélection de plage, moitié basse = déplacement, bords = rognage, coins hauts = fondus, bas d'une jonction = crossfade" aria-label="Smart Tool"><i className="fas fa-wand-magic-sparkles text-[12px]"></i></button>
            <button onClick={() => setActiveTool('RANGE')} aria-pressed={activeTool === 'RANGE'} className={`w-9 h-9 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-lg flex items-center justify-center transition-all ${activeTool === 'RANGE' ? 'bg-[#38bdf8] text-black nova-halo' : 'text-slate-500 hover:text-white'}`}
              title="Sélecteur (comme dans Pro Tools) (4) : glisse pour choisir une plage de temps sur une ou plusieurs pistes, puis coupe, copie, duplique, consolide, boucle ou exporte-la" aria-label="Sélecteur de plage"><i className="fas fa-i-cursor text-[12px]"></i></button>
            <button onClick={() => setActiveTool('ERASE')} className={`w-9 h-9 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-lg flex items-center justify-center transition-all ${activeTool === 'ERASE' ? 'bg-red-500 text-white' : 'text-slate-500 hover:text-white'}`} title="Gomme : supprimer un clip (3)" aria-label="Outil gomme"><i className="fas fa-eraser text-[12px]"></i></button>
          </div>
          {/* Modes d'édition Pro Tools (remplacent l'aimant oui / non) : SHUF / SLIP / SPOT / GRID + valeur de grille. */}
          <EditModeSelector compact={simple} />
          {!simple && (
            <div className="hidden xl:flex items-center gap-1" data-nova-target="nudge">
              <label className="text-[10px] font-bold text-slate-500" htmlFor="nova-nudge" title="Décalage (« nudge » de Pro Tools) : ← / → déplacent la sélection d'un pas ; Maj = 10 pas.">Décalage</label>
              <select id="nova-nudge" value={editPrefs.nudge} onChange={e => editCommands ? editCommands.setNudgeUnit(e.target.value as NudgeUnit) : editPrefsStore.set({ nudge: e.target.value as NudgeUnit })}
                title="Pas du décalage (« Nudge value » de Pro Tools) : ← / → sur la sélection, Maj = 10 pas" aria-label="Pas du décalage"
                className="h-8 bg-black/40 border border-white/10 rounded-lg px-1 text-[11px] text-slate-300">
                {NUDGE_UNITS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
              <button onClick={() => editPrefsStore.set({ autoXfade: !editPrefs.autoXfade })} aria-pressed={editPrefs.autoXfade}
                title="Fondu enchaîné auto : quand tu poses un clip contre un autre ou par-dessus (≤ 2 s), un fondu enchaîné (crossfade) est créé tout seul."
                className={`h-8 px-2 rounded-lg border text-[10px] font-bold ${editPrefs.autoXfade ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}>
                <i className="fas fa-xmark mr-1"></i>Fondu enchaîné auto
              </button>
              <select value={editPrefs.xfadeCurve} onChange={e => editPrefsStore.set({ xfadeCurve: e.target.value as CrossfadeCurve })}
                aria-label="Courbe des fondus enchaînés"
                title="Courbe des crossfades posés à la souris (bas d'une jonction), avec Ctrl+F ou automatiquement. Puissance égale = « Equal Power » de Pro Tools, sans creux de niveau."
                className="h-8 bg-black/40 border border-white/10 rounded-lg px-1 text-[11px] text-slate-300">
                {FADE_CURVES.map(cv => <option key={cv} value={cv}>{FADE_CURVE_INFO[cv].label}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="flex-1 h-full py-2 px-4 flex items-center min-w-0 justify-center">
            <div 
              className={`w-full h-full max-w-4xl bg-black/40 border border-white/10 rounded overflow-hidden relative group ${isDraggingMinimap ? 'cursor-grabbing' : 'cursor-grab'}`}
              onMouseDown={handleMinimapMouseDown}
            >
                 <canvas ref={minimapRef} className="w-full h-full block" />
                 <div ref={minimapPlayheadRef} className="absolute top-0 bottom-0 left-0 w-px bg-white pointer-events-none" style={{ willChange: 'transform' }} />
            </div>
        </div>
        <div className="flex items-center space-x-3 shrink-0">
             {!simple && <ChordLaneToggleButton />}
             <i className="fas fa-search-plus text-[10px]"></i>
             <input type="range" min="10" max="300" step="1" value={zoomH} onChange={(e) => setZoomH(parseInt(e.target.value))} className="w-24 accent-cyan-500 h-1 bg-white/5 rounded-full" />
        </div>
      </div>
      {/* Piste d'accords : sous la règle (comme la Chord Track de Logic), fixe pendant le défilement vertical. */}
      {chordLane && (
        <div style={{ position: 'absolute', top: TOOLBAR_H + RULER_H, left: 0, right: 0, zIndex: 41 }}>
          {chordLane.render({ zoomH, scrollLeft, headerWidth, width: Math.max(0, viewportSize.width - headerWidth) })}
        </div>
      )}
      {/* SINGLE SCROLL CONTAINER - sidebar is sticky left, canvas is sticky top */}
      <div 
          ref={scrollContainerRef} 
          className="flex-1 overflow-auto relative custom-scroll"
          onMouseDown={handleMouseDown}
          onDoubleClick={(e) => {
            // Un clip MIDI etait une impasse : une fois le piano roll ferme,
            // rien ne permettait de le rouvrir depuis l'arrangement.
            const sel = selectedClip;
            if (sel && sel.clip.type === TrackType.MIDI) onEditMidi?.(sel.trackId, sel.clip.id);
            // Double-clic sur un clip audio : le renommer (Pro Tools : double-clic avec le Grabber).
            // (pas sur la poignée de gain, dont le double-clic remet 0 dB).
            else if (sel && editModeStore.get().mode === 'SPOT') setSpotTarget({ trackId: sel.trackId, clipId: sel.clip.id });
            else if (sel && !dragActionRef.current && !gainTip) openNovaWindow('clip-props', { targets: [{ trackId: sel.trackId, clipId: sel.clip.id }], focus: 'name' });
          }} 
          onMouseMove={handleMouseMove} 
          onMouseUp={handleMouseUp} 
          onMouseLeave={handleMouseUp} 
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse') return;
            // Pas d'événements souris « de compatibilité » en double après le doigt.
            e.preventDefault();
            touchRef.current = true;
            handleMouseDown(e);
            // Appui long sur un clip (doigt immobile 0,55 s) : en mode Spot, « Position exacte » ;
            // sinon le menu du clip (qui propose aussi le Spot).
            const cx = e.clientX, cy = e.clientY;
            cancelLongPress();
            longPressRef.current = { x: cx, y: cy, timer: window.setTimeout(() => {
              longPressRef.current = null;
              const hit = clipAtPoint(cx, cy);
              if (!hit) return;
              touchRef.current = false; handleMouseUp();
              if (editModeStore.get().mode === 'SPOT') {
                suppressCtxUntilRef.current = Date.now() + 1500;
                setSpotTarget({ trackId: hit.trackId, clipId: hit.clip.id });
              } else {
                setClipContextMenu({ x: cx, y: cy, trackId: hit.trackId, clip: hit.clip });
              }
            }, 550) };
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'mouse') return;
            const lp = longPressRef.current;
            if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLongPress();
            handleMouseMove(e);
          }}
          onPointerUp={(e) => { if (e.pointerType !== 'mouse') { cancelLongPress(); touchRef.current = false; handleMouseUp(); } }}
          onPointerCancel={(e) => { if (e.pointerType !== 'mouse') { cancelLongPress(); touchRef.current = false; handleMouseUp(); } }}
          onScroll={(e) => { setScrollLeft(e.currentTarget.scrollLeft); setScrollTop(e.currentTarget.scrollTop); }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onContextMenu={(e) => e.preventDefault()}
      >
        {/* Container for all content with proper dimensions */}
        <div style={{ width: totalContentWidth + headerWidth, minHeight: totalArrangementHeight, position: 'relative' }}>
          
          {/* SIDEBAR - sticky left only (scrolls vertically with content) */}
          <div 
              ref={sidebarContainerRef}
              className="z-40 flex flex-col"
              style={{ 
                  position: 'sticky', 
                  left: 0,
                  width: `${headerWidth}px`, 
                  height: 'fit-content',
                  minHeight: totalArrangementHeight,
                  backgroundColor: 'var(--bg-surface)',
                  borderRight: '1px solid var(--border-dim)'
              }}
          >
            {/* Règle + couloir d'accords */}
            <div style={{ height: tracksTop, flexShrink: 0, backgroundColor: 'var(--bg-surface)' }} />
            {/* Track Headers */}
            {visibleTracks.map((track) => (
              <div key={track.id} style={{ flexShrink: 0, position: 'relative' }}>
                <div style={{ height: `${zoomV}px`, position: 'relative' }}>
                  {takeLanes && (lanesByTrack.get(track.id)?.length || 0) > 0 && (() => {
                    const n = lanesByTrack.get(track.id)!.length;
                    const isOpen = !!takeLanes.open[track.id];
                    return (
                      <button type="button" data-takes-button={track.id}
                        onClick={(e) => { e.stopPropagation(); takeLanes.onToggle(track.id); }}
                        aria-expanded={isOpen}
                        title={`${isOpen ? 'Replier' : 'Déplier'} les couloirs de prises (comme les Playlists de Pro Tools ou les « take lanes » d'Ableton) : écoute chaque prise, balaie un passage pour le garder.`}
                        className={`absolute z-10 right-1.5 bottom-1.5 h-6 px-2 rounded-full text-[10px] font-black flex items-center gap-1 border ${isOpen ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-black/70 text-cyan-200 border-cyan-400/50 hover:bg-cyan-500/20'}`}>
                        <i className="fas fa-layer-group text-[9px]" />Prises ({n})<i className={`fas ${isOpen ? 'fa-chevron-up' : 'fa-chevron-down'} text-[8px]`} />
                      </button>
                    );
                  })()}
                  <TrackHeaderMemo 
                     track={track} isSelected={selectedTrackId === track.id} onSelect={selectTrackHandler(track.id)} onUpdate={headerOnUpdate} 
                     onDropPlugin={headerOnDropPlugin} onMovePlugin={headerOnMovePlugin} onSelectPlugin={headerOnSelectPlugin} onRemovePlugin={headerOnRemovePlugin} onRequestAddPlugin={headerOnRequestAddPlugin} 
                     onContextMenu={headerOnContextMenu} onDragStartTrack={handleDragStartTrack} onDragOverTrack={handleDragOverTrack} onDropTrack={headerOnDropTrack}
                     isDraggingOver={dragOverTrackId === track.id} onSwapInstrument={headerOnSwapInstrument}
                  />
                </div>
                {track.automationLanes.map(lane => lane.isExpanded && (
                     <div key={lane.id} style={{ height: '80px', position: 'relative' }}>
                       <AutomationLaneComponent trackId={track.id} lane={lane} width={0} zoomH={zoomH} scrollLeft={0} onUpdatePoints={() => {}} onRemoveLane={() => onUpdateTrack({ ...track, automationLanes: track.automationLanes.map(l => l.id === lane.id ? { ...l, isExpanded: false } : l) })} variant="header" />
                     </div>
                ))}
                {takeLanes && openLanesOf(track).length > 0 && (
                  <TakeLaneHeaders track={track} lanes={openLanesOf(track)} api={takeLanes} onMenu={(x, y, l) => openLaneMenu(track.id, x, y, l)} />
                )}
              </div>
            ))}
            <div style={{ flexGrow: 1 }} />
            {/* Resize handle (souris seulement : au doigt il captait les touchers destinés au bouton R) */}
            <div className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-cyan-500/50 active:bg-cyan-500 z-50 flex items-center justify-center group [@media(pointer:coarse)]:hidden" onMouseDown={handleHeaderResizeStart}>
              <div className="w-0.5 h-8 bg-white/20 rounded-full group-hover:bg-white/50 pointer-events-none" />
            </div>
          </div>
          
          
          {/* Live recording clips */}
          {isRecording && recStartTime !== null && (
             visibleTracks.map((track, idx) => {
               if (!track.isTrackArmed) return null;
               let topY = tracksTop; for (let i = 0; i < idx; i++) topY += zoomV + extraH(visibleTracks[i]);
               return <div key={`live-${track.id}`} style={{ position: 'absolute', top: `${topY + 2}px`, left: headerWidth, height: `${zoomV - 4}px`, right: 0, pointerEvents: 'none' }}><LiveRecordingClip trackId={track.id} recStartTime={recStartTime} zoomH={zoomH} height={zoomV - 4} /></div>;
             })
          )}
        </div>
      </div>
      {/* CANVAS - Overlay fixe pour la grille et la timeline */}
      <canvas 
          ref={canvasRef}
          data-tracks-top={tracksTop} 
          style={{ 
              position: 'absolute',
              top: TOOLBAR_H, // sous la barre d'outils : règle, couloir d'accords, pistes
              left: headerWidth,
              right: 0,
              bottom: 0,
              width: `calc(100% - ${headerWidth}px)`,
              height: `calc(100% - ${TOOLBAR_H}px)`,
              pointerEvents: 'none',
              zIndex: 20
          }} 
      />
      {/* Calque de la tete de lecture, redessine a chaque image sans toucher au reste */}
      <canvas
          ref={overlayRef}
          style={{
              position: 'absolute',
              top: TOOLBAR_H,
              left: headerWidth,
              right: 0,
              bottom: 0,
              width: `calc(100% - ${headerWidth}px)`,
              height: `calc(100% - ${TOOLBAR_H}px)`,
              pointerEvents: 'none',
              // Au-dessus du couloir d'accords et des couloirs de prises : la tête de lecture les traverse.
              zIndex: 42
          }}
      />
      {/* Couloirs de prises (au-dessus des calques dessinés, sous la règle) */}
      {takeLanes && visibleTracks.some(t => openLanesOf(t).length > 0) && (
        <div style={{ position: 'absolute', top: TOOLBAR_H + tracksTop, left: headerWidth, right: 0, bottom: 12, overflow: 'hidden', pointerEvents: 'none', zIndex: 22 }}>
          {(() => {
            let y = tracksTop;
            return visibleTracks.map(t => {
              const lanes = openLanesOf(t);
              const top = y + zoomV + t.automationLanes.filter(l => l.isExpanded).length * 80 - scrollTop - tracksTop;
              y += zoomV + extraH(t);
              if (!lanes.length || top > viewportSize.height || top + lanes.length * TAKE_LANE_H < 0) return null;
              return <TakeLanesOverlay key={t.id} track={t} lanes={lanes} api={takeLanes} top={top} zoomH={zoomH} scrollLeft={scrollLeft}
                width={Math.max(1, viewportSize.width - headerWidth)}
                onWheel={(e) => { const sc = scrollContainerRef.current; if (sc) { sc.scrollTop += e.deltaY; sc.scrollLeft += e.deltaX; } }} />;
            });
          })()}
        </div>
      )}
      {editingMarkerId && (() => {
        const mk = markers.find(m => m.id === editingMarkerId);
        if (!mk) return null;
        // Positionne le champ juste sous le drapeau du marqueur.
        const box = scrollContainerRef.current?.getBoundingClientRect();
        const left = (box?.left ?? 0) + headerWidth + (mk.time * zoomH) - scrollLeft;
        const top = (box?.top ?? 0) + 16;
        return (
          <input
            autoFocus
            defaultValue={mk.name}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => { onUpdateMarker?.({ ...mk, name: e.target.value.trim() || mk.name }); setEditingMarkerId(null); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const value = (e.target as HTMLInputElement).value.trim();
                onUpdateMarker?.({ ...mk, name: value || mk.name });
                setEditingMarkerId(null);
              }
              if (e.key === 'Escape') setEditingMarkerId(null);
            }}
            className="fixed z-[300] px-2 py-1 text-[11px] font-bold bg-black border rounded outline-none"
            style={{ left: Math.max((box?.left ?? 0) + headerWidth, left), top, width: 160, color: mk.color, borderColor: mk.color }}
          />
        );
      })()}
      {editCommands && <RangeActionsBar commands={editCommands} />}
      {spotTarget && (() => {
        const tr = tracks.find(t => t.id === spotTarget.trackId);
        const c = tr?.clips.find(x => x.id === spotTarget.clipId);
        if (!tr || !c) return null;
        const sr = sessionSampleRate();
        return <SpotDialog clip={c} trackName={tr.name} bpm={bpm} sampleRate={sr} onClose={() => setSpotTarget(null)}
          onApply={(start) => {
            onEditClipRaw?.(tr.id, c.id, 'UPDATE_PROPS', { start });
            if (editCommands) setTimeout(() => editCommands.autoCrossfade(tr.id, [c.id]), 0);
          }} />;
      })()}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      {gridMenu && <TimelineGridMenu x={gridMenu.x} y={gridMenu.y} onClose={() => setGridMenu(null)} gridSize={gridSize} onSetGridSize={setGridSize} snapEnabled={snapEnabled} onToggleSnap={() => editModeStore.set({ mode: snapEnabled ? 'SLIP' : 'GRID' })} onAddTrack={() => onAddTrack && onAddTrack(TrackType.AUDIO)} onResetZoom={() => { setZoomH(40); setZoomV(120); }} onPaste={() => onEditClip?.(selectedTrackId || 'track-rec-main', '', 'PASTE', { time: playheadStore.get() })} />}
      {xfadeTip && <div className="fixed z-[200] px-2 py-1 bg-black/90 border border-amber-400/40 rounded-md shadow-2xl pointer-events-none text-[11px] font-black text-amber-300" style={{ left: xfadeTip.x + 14, top: xfadeTip.y - 28 }}>{xfadeTip.text}</div>}
      {gainTip && <div className="fixed z-[200] px-2 py-1 bg-black/90 border border-amber-400/40 rounded-md shadow-2xl pointer-events-none text-[11px] font-black text-amber-300 font-mono tabular-nums" style={{ left: gainTip.x + 14, top: gainTip.y - 28 }}>Gain {gainTip.text}</div>}
      {(() => {
        // Bulle de glissement (G8) : « Fondu d'entrée · 0,25 s », « Déplacer · mes. 5.2 ».
        if (!dragTipPos || !activeClip) return null;
        const live = tracks.find(t => t.id === activeClip.trackId)?.clips.find(c => c.id === activeClip.clip.id) || activeClip.clip;
        const base = dragTipText(dragAction, live, bpm);
        if (!base) return null;
        // Mode appliqué pendant le geste (avec l'inversion Ctrl / Maj) : on voit tout de suite si on est calé ou libre.
        const eff = effectiveMode(em, dragInvert);
        const modeTxt = eff === 'SHUFFLE' ? 'Shuffle' : eff === 'GRID_ABS' ? 'Grille absolue' : eff === 'GRID_REL' ? 'Grille relative' : eff === 'SPOT' ? 'Spot (libre)' : 'Slip (libre)';
        const text = (dragAction === 'MOVE' || dragAction === 'TRIM_START' || dragAction === 'TRIM_END') ? `${base} · ${modeTxt}${dragInvert && em.mode !== 'SHUFFLE' ? ' (Ctrl/Maj)' : ''}` : base;
        return <div role="status" data-testid="drag-tip" className="fixed z-[200] px-3 py-1.5 bg-black/90 border border-cyan-500/30 rounded-lg shadow-2xl pointer-events-none text-[11px] font-bold text-cyan-200" style={{ left: dragTipPos.x + 15, top: dragTipPos.y + 12 }}>{text}</div>;
      })()}
      {hoverHint && !dragAction && (
        <div role="tooltip" data-testid="fade-hint" className="fixed z-[200] px-2.5 py-1 bg-black/90 border border-white/15 rounded-md shadow-xl pointer-events-none text-[11px] text-slate-100" style={{ left: hoverHint.x + 14, top: hoverHint.y + 14 }}>{hoverHint.text}</div>
      )}
      {clipContextMenu && (
        <ContextMenu
            x={clipContextMenu.x} y={clipContextMenu.y} onClose={() => setClipContextMenu(null)}
            items={[
                { label: 'Couper', icon: 'fa-cut', shortcut: 'Ctrl+X', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'CUT'); setClipContextMenu(null); }},
                { label: 'Copier', icon: 'fa-copy', shortcut: 'Ctrl+C', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'COPY'); setClipContextMenu(null); }},
                { label: 'Coller', icon: 'fa-paste', shortcut: 'Ctrl+V', onClick: () => { onEditClip?.(clipContextMenu.trackId, '', 'PASTE', { time: playheadStore.get() }); setClipContextMenu(null); }},
                'separator',
                { label: 'Dupliquer', icon: 'fa-clone', shortcut: 'Ctrl+D', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'DUPLICATE'); setClipContextMenu(null); }},
                { label: 'Diviser', icon: 'fa-scissors', shortcut: 'S', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'SPLIT', { time: playheadStore.get() }); setClipContextMenu(null); }},
                { label: 'Normaliser', icon: 'fa-wave-square', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'NORMALIZE'); setClipContextMenu(null); }},
                // Modes d'édition Pro Tools : Spot (position exacte) et point de synchro.
                { label: simple ? 'Position exacte…' : 'Position exacte (Spot)…', icon: 'fa-crosshairs', shortcut: 'F3 + clic', title: 'Placer le clip au tick, à la milliseconde ou à l’échantillon près, par son début, sa fin ou son point de synchro (Pro Tools : Spot, F3 puis clic)', onClick: () => { setSpotTarget({ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }); setClipContextMenu(null); }},
                { label: 'Point de synchro à la tête de lecture', icon: 'fa-location-dot', shortcut: 'Ctrl+,', onClick: () => {
                    const sp = syncPointAt(clipContextMenu.clip, playheadStore.get());
                    if (sp === null) window.dispatchEvent(new CustomEvent('nova:notify', { detail: 'Point de synchro : place d’abord la tête de lecture DANS ce clip, sur l’attaque à caler.' }));
                    else onEditClipRaw?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', { syncPoint: sp });
                    setClipContextMenu(null); }},
                ...(syncOffsetOf(clipContextMenu.clip) !== null ? [{ label: 'Enlever le point de synchro', icon: 'fa-location-pin-lock', onClick: () => { onEditClipRaw?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', { syncPoint: undefined }); setClipContextMenu(null); }}] : []),
                // Pro Tools : Rename (Ctrl+Maj+R), couleur de clip, Strip Silence (Ctrl+U).
                { label: 'Renommer…', icon: 'fa-i-cursor', shortcut: 'Ctrl+Maj+R', onClick: () => { openNovaWindow('clip-props', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }], focus: 'name' }); setClipContextMenu(null); }},
                { label: 'Couleur du clip…', icon: 'fa-palette', onClick: () => { openNovaWindow('clip-props', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }], focus: 'color' }); setClipContextMenu(null); }},
                // Justesse note par note (V19) : Flex Pitch de Logic, Melodyne, Pitch Editor de FL.
                ...(clipContextMenu.clip.type !== TrackType.MIDI ? [{ label: 'Justesse note par note…', icon: 'fa-wave-square', title: 'Comme Flex Pitch dans Logic : corrige la justesse de ta voix note par note',
                  onClick: () => { openNovaWindow('pitch-editor', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }] }); setClipContextMenu(null); }}] : []),
                // Plusieurs clips sélectionnés : « Corriger tout » sur toute la sélection (une annulation).
                ...(() => {
                    if (clipContextMenu.clip.type === TrackType.MIDI || !selectedClipIds?.has(clipContextMenu.clip.id) || selectedClipIds.size < 2) return [];
                    const targets: { trackId: string; clipId: string }[] = [];
                    tracks.forEach(tr => { if (tr.type !== TrackType.MIDI) tr.clips.forEach(c => { if (selectedClipIds.has(c.id) && c.type !== TrackType.MIDI) targets.push({ trackId: tr.id, clipId: c.id }); }); });
                    return targets.length > 1 ? [{ label: `Justesse : corriger tout (${targets.length} clips)…`, icon: 'fa-wand-magic-sparkles', title: 'Ramène toutes les notes des clips sélectionnés dans la gamme, avec dosage et style. Une seule annulation.',
                      onClick: () => { openNovaWindow('pitch-batch', { targets }); setClipContextMenu(null); } }] : [];
                })(),
                // Audio → MIDI (V20) : Convert Melody / Drums / Harmony d'Ableton Live, « Create MIDI » du Flex Pitch de Logic.
                ...(clipContextMenu.clip.type !== TrackType.MIDI ? [
                  { label: 'Mélodie → MIDI (808, piano…)…', icon: 'fa-microphone-lines', title: 'Convertir la mélodie de cette voix en notes MIDI : 808 qui la suit, piano, lead ou nappe (comme Convert Melody to MIDI d’Ableton Live ou « Create MIDI » du Flex Pitch de Logic)',
                    onClick: () => { openNovaWindow('audio-to-midi', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }], convert: { mode: 'melody' } }); setClipContextMenu(null); } },
                  { label: 'Batterie → MIDI…', icon: 'fa-drum', title: 'Convertir cette boucle de batterie en motif : kick, snare / clap, hi-hat dans la boîte à rythmes ou en piste MIDI General MIDI (comme Convert Drums to MIDI d’Ableton Live)',
                    onClick: () => { openNovaWindow('audio-to-midi', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }], convert: { mode: 'drums' } }); setClipContextMenu(null); } },
                  { label: 'Accords → MIDI…', icon: 'fa-guitar', title: 'Trouver les accords de ce sample et les rejouer en MIDI, et remplir la piste d’accords (comme Convert Harmony to MIDI d’Ableton Live ou Chord ID de Logic)',
                    onClick: () => { openNovaWindow('audio-to-midi', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }], convert: { mode: 'harmony' } }); setClipContextMenu(null); } },
                ] : []),
                // Melodyne / VocAlign (ARA2, hôte natif du pont) : grisés sur le site, avec la raison en infobulle.
                ...(clipContextMenu.clip.type !== TrackType.MIDI ? (() => {
                  const target = { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }] };
                  const mel = araAvailability('melodyne', araCtx), va = araAvailability('vocalign', araCtx);
                  return [
                    { label: clipContextMenu.clip.araEdit?.plugin === 'melodyne' ? 'Retoucher dans Melodyne (ARA)' : 'Ouvrir dans Melodyne (ARA)', icon: 'fa-wand-magic-sparkles', title: mel.tooltip, disabled: !mel.enabled,
                      onClick: () => { openNovaWindow('ara-melodyne', target); setClipContextMenu(null); } },
                    { label: 'Aligner avec VocAlign… (ARA)', icon: 'fa-align-left', title: va.tooltip, disabled: !va.enabled,
                      onClick: () => { openNovaWindow('ara-vocalign', target); setClipContextMenu(null); } },
                    ...(!va.enabled ? [{ label: 'Caler sur la lead (alignement NOVA)…', icon: 'fa-align-left', title: "Cale doubles, backs et harmonies sur la voix lead, sans plugin",
                      onClick: () => { openNovaWindow('ara-vocalign', target); setClipContextMenu(null); } }] : []),
                    ...(clipContextMenu.clip.araEdit ? [{ label: "Revenir à l'original…", icon: 'fa-rotate-left', title: 'Remet la prise d’origine (avant Melodyne / VocAlign)',
                      onClick: () => { openNovaWindow(clipContextMenu.clip.araEdit!.plugin === 'melodyne' ? 'ara-melodyne' : 'ara-vocalign', target); setClipContextMenu(null); } }] : []),
                  ];
                })() : []),
                ...(clipContextMenu.clip.type !== TrackType.MIDI ? [{ label: simple ? 'Supprimer les silences…' : 'Strip Silence…', icon: 'fa-compress-alt', shortcut: 'Ctrl+U', title: 'Supprimer les silences : découpe le clip et retire les blancs entre les phrases, avec seuil et marges réglables (Pro Tools : Strip Silence, Ctrl+U)', onClick: () => { openNovaWindow('strip-silence', { targets: [{ trackId: clipContextMenu.trackId, clipId: clipContextMenu.clip.id }] }); setClipContextMenu(null); }}] : []),
                ...(clipContextMenu.clip.type !== TrackType.MIDI ? [{ label: 'Respirations…', icon: 'fa-wind', shortcut: 'Ctrl+Alt+R', title: 'Baisser les respirations (lead) ou les supprimer (backs), comme Breath Control de Waves / De-breath de RX', onClick: () => { const ids = selectedClipIds?.has(clipContextMenu.clip.id) && selectedClipIds.size > 1 ? Array.from(selectedClipIds) : [clipContextMenu.clip.id]; requestBreaths({ mode: 'dialog', clipIds: ids, reason: 'menu' }); setClipContextMenu(null); }}] : []),
                ...(clipContextMenu.clip.type !== TrackType.MIDI && onSeparateStems ? [
                  { label: 'Séparer en stems…', icon: 'fa-layer-group', title: STEMS_TOOLTIP,
                    onClick: () => { onSeparateStems(clipContextMenu.trackId, clipContextMenu.clip.id); setClipContextMenu(null); } }
                ] : []),
                ...(clipContextMenu.clip.type === TrackType.MIDI && onEditMidi ? [
                  { label: 'Ouvrir dans le piano roll', icon: 'fa-music', onClick: () => { onEditMidi(clipContextMenu.trackId, clipContextMenu.clip.id); setClipContextMenu(null); }}
                ] : []),
                ...midiClipMenuItems(clipContextMenu.trackId, clipContextMenu.clip, () => setClipContextMenu(null)),
                'separator',
                { label: clipContextMenu.clip.isMuted ? 'Réactiver' : 'Muter', icon: clipContextMenu.clip.isMuted ? 'fa-volume-up' : 'fa-volume-mute', shortcut: 'M', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'MUTE'); setClipContextMenu(null); }},
                { label: clipContextMenu.clip.isReversed ? 'Remettre à l’endroit' : 'Inverser', icon: 'fa-rotate-left', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', { isReversed: !clipContextMenu.clip.isReversed }); setClipContextMenu(null); }},
                { label: 'Gain +3 dB', icon: 'fa-volume-high', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', { gain: Math.min(8, (clipContextMenu.clip.gain ?? 1) * 1.413) }); setClipContextMenu(null); }},
                { label: 'Gain -3 dB', icon: 'fa-volume-low', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', { gain: Math.max(0.01, (clipContextMenu.clip.gain ?? 1) / 1.413) }); setClipContextMenu(null); }},
                ...(clipContextMenu.clip.warp?.originalBpm && Math.abs(clipContextMenu.clip.warp.originalBpm - bpm) > 0.5 ? [
                  { label: `Caler sur le tempo (${Math.round(clipContextMenu.clip.warp.originalBpm)} → ${Math.round(bpm)} BPM)`, icon: 'fa-clock-rotate-left',
                    onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'FIT_TEMPO'); setClipContextMenu(null); } }
                ] : []),
                // Fondus en un clic (G7) : avant, seul le glissement du coin (sans indice) en créait.
                ...(clipContextMenu.clip.type !== TrackType.MIDI ? [{
                  label: 'Fondus', icon: 'fa-signal', onClick: () => {}, disabled: true,
                  component: (
                    <div className="px-1 space-y-1" onMouseDown={e => e.stopPropagation()}>
                      {(['in', 'out'] as const).map(which => (
                        <div key={which} className="flex items-center gap-1">
                          <span className="w-24 text-[11px] text-slate-200">{which === 'in' ? "Fondu d'entrée" : 'Fondu de sortie'}</span>
                          {FADE_PRESETS.map(fp => (
                            <button key={fp.id} type="button" data-testid={`fade-${which}-${fp.id}`}
                              title={`${which === 'in' ? "Fondu d'entrée" : 'Fondu de sortie'} de ${fp.label}`}
                              onClick={() => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', fadeWithPreset(clipContextMenu.clip, which, fp.id, bpm)); setClipContextMenu(null); }}
                              className="px-1.5 h-6 rounded text-[10px] font-bold border border-white/10 text-slate-300 hover:text-white hover:border-cyan-500/50">{fp.label}</button>
                          ))}
                        </div>
                      ))}
                    </div>
                  ),
                }] : []),
                ...((clipContextMenu.clip.fadeIn || clipContextMenu.clip.fadeOut) ? [
                  { label: 'Effacer les fondus', icon: 'fa-eraser', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'UPDATE_PROPS', { fadeIn: 0, fadeOut: 0 }); setClipContextMenu(null); } }
                ] : []),
                ...(editCommands && clipContextMenu.clip.type !== TrackType.MIDI ? [
                  { label: 'Courbes des fondus (Pro Tools)', icon: 'fa-bezier-curve', onClick: () => {}, disabled: true,
                    component: (
                      <div className="px-3 pb-2 pt-1 space-y-1" onMouseDown={e => e.stopPropagation()}>
                        {(['in', 'out'] as const).map(which => {
                          const cur = (which === 'in' ? clipContextMenu.clip.fadeInCurve : clipContextMenu.clip.fadeOutCurve) || 'LINEAR';
                          return (
                            <div key={which} className="flex items-center gap-1">
                              <span className="w-12 text-[10px] text-slate-400">{which === 'in' ? 'Entrée' : 'Sortie'}</span>
                              {FADE_CURVES.map(cv => (
                                <button key={cv} title={FADE_CURVE_INFO[cv].hint} aria-pressed={cur === cv}
                                  onClick={() => { const ids = selectedClipIds.has(clipContextMenu.clip.id) ? Array.from(selectedClipIds) : [clipContextMenu.clip.id];
                                    editCommands.setFadeCurve(clipContextMenu.trackId, ids, which, cv); setClipContextMenu(null); }}
                                  className={`px-1.5 h-6 rounded text-[10px] font-bold border ${cur === cv ? 'bg-amber-500/20 border-amber-500/50 text-amber-200' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                                  {FADE_CURVE_INFO[cv].short}
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    ) },
                  ...(() => {
                    // Crossfade avec le clip qui suit (jonction ou chevauchement).
                    const t = tracks.find(tr => tr.id === clipContextMenu.trackId);
                    const c = clipContextMenu.clip;
                    const next = t?.clips.filter(o => o.id !== c.id && !o.isMuted && o.start >= c.start && o.start <= c.start + c.duration + 0.002 && o.start + o.duration > c.start + c.duration)
                      .sort((p, q) => p.start - q.start)[0];
                    const prev = t?.clips.filter(o => o.id !== c.id && !o.isMuted && o.start < c.start && o.start + o.duration >= c.start - 0.002 && o.start + o.duration < c.start + c.duration)
                      .sort((p, q) => q.start - p.start)[0];
                    const items: ContextMenuItem[] = [];
                    if (next) items.push({ label: 'Fondu enchaîné avec le clip suivant', icon: 'fa-shuffle', onClick: () => { editCommands.crossfade(clipContextMenu.trackId, c.id, next.id); setClipContextMenu(null); } });
                    if (prev) items.push({ label: 'Fondu enchaîné avec le clip précédent', icon: 'fa-shuffle', onClick: () => { editCommands.crossfade(clipContextMenu.trackId, prev.id, c.id); setClipContextMenu(null); } });
                    return items;
                  })(),
                ] : []),
                'separator',
                { label: 'Supprimer', icon: 'fa-trash', shortcut: 'Suppr', danger: true, onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'DELETE'); setClipContextMenu(null); }}
            ]}
        />
    )}
    {/* Marker Context Menu (inspired by Pro Tools) */}
    {markerContextMenu && (
        <ContextMenu
            x={markerContextMenu.x} y={markerContextMenu.y} onClose={() => setMarkerContextMenu(null)}
            items={[
                { label: 'Aller au marqueur', icon: 'fa-crosshairs', onClick: () => { onSeek(markerContextMenu.marker.time); setMarkerContextMenu(null); }},
                { label: 'Renommer', icon: 'fa-pen', onClick: () => { setEditingMarkerId(markerContextMenu.marker.id); setMarkerContextMenu(null); }},
                ...(markerContextMenu.marker.type !== 'REGION' && onUpdateMarker ? [{ label: 'En faire une région (8 mesures)', icon: 'fa-arrows-left-right', onClick: () => {
                    onUpdateMarker({ ...markerContextMenu.marker, type: 'REGION' as const, endTime: markerContextMenu.marker.time + (60 / (bpm || 120)) * 32 });
                    setMarkerContextMenu(null);
                }}] : []),
                { label: 'Changer la couleur', icon: 'fa-palette', onClick: () => { 
                    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899'];
                    const nextColor = colors[(colors.indexOf(markerContextMenu.marker.color) + 1) % colors.length];
                    onUpdateMarker?.({ ...markerContextMenu.marker, color: nextColor });
                    setMarkerContextMenu(null);
                }},
                'separator',
                { label: 'Supprimer', icon: 'fa-trash', danger: true, onClick: () => { onDeleteMarker?.(markerContextMenu.marker.id); setMarkerContextMenu(null); }}
            ]}
        />
    )}
    </div>
  );
};
export default React.memo(ArrangementView);
