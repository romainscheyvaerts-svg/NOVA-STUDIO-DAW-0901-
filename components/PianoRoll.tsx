
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Track, Clip, MidiNote, EditorTool, TrackType } from '../types';
import { NOTES } from '../plugins/AutoTunePlugin';
import { audioEngine } from '../engine/AudioEngine';
import { midiEffectsService } from '../services/MidiEffectsService';
import { usePlayheadTime } from '../utils/playheadStore';
import { isInScale, snapToScale, scaleRows, buildChord, chordLabelFr, keyLabelFr, noteNameFr, CHORD_CHOICES, SCALE_CHOICES, NOTE_NAMES_FR, ChordKind } from '../utils/scales';
import { ComputerKeyboard, NoteRecorder, isComputerKeyboardCode, defaultKeyLabel, octaveBase, KEY_TO_SEMITONE, DEFAULT_KEYBOARD_STATE, KeyboardState } from '../utils/computerKeyboard';

/** Préférences d'affichage du piano roll, gardées sur cet appareil. */
const PREFS_KEY = 'nova.pianoroll.prefs';
type RollPrefs = { highlight: boolean; snap: boolean; fold: boolean; ghosts: boolean };
const readPrefs = (): RollPrefs => {
  const def: RollPrefs = { highlight: true, snap: false, fold: false, ghosts: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
};
const writePrefs = (p: RollPrefs) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } };

/** Trait de lecture : seul lui se re-rend pendant la lecture, pas tout le piano roll. */
const PianoRollPlayhead: React.FC<{ clipStart: number; zoomX: number }> = ({ clipStart, zoomX }) => {
  const t = usePlayheadTime();
  return <div className="absolute top-0 bottom-0 w-0.5 bg-white z-50 pointer-events-none" style={{ left: (t - clipStart) * zoomX }} />;
};

// Quantize options (inspired by Ableton/Logic)
type QuantizeStrength = 25 | 50 | 75 | 100;
type QuantizeValue = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/4T' | '1/8T' | '1/16T';

const QUANTIZE_VALUES: { value: QuantizeValue; beats: number; label: string }[] = [
  { value: '1/1', beats: 4, label: '1 Bar' },
  { value: '1/2', beats: 2, label: '1/2' },
  { value: '1/4', beats: 1, label: '1/4' },
  { value: '1/8', beats: 0.5, label: '1/8' },
  { value: '1/16', beats: 0.25, label: '1/16' },
  { value: '1/32', beats: 0.125, label: '1/32' },
  { value: '1/4T', beats: 1/1.5, label: '1/4T' },
  { value: '1/8T', beats: 0.5/1.5, label: '1/8T' },
  { value: '1/16T', beats: 0.25/1.5, label: '1/16T' },
];

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
}

// Configuration
const ROW_HEIGHT = 16; 
const DRUM_ROW_HEIGHT = 24; // Bigger rows for drum names
const VELOCITY_HEIGHT = 150; 

type DragMode = 'MOVE' | 'RESIZE_R' | 'VELOCITY' | 'SELECT' | 'DRAW' | null;

const PianoRoll: React.FC<PianoRollProps> = ({ track, clipId, bpm, onUpdateTrack, onClose, toolbarExtra, isPlaying, onTogglePlay, projectKey, projectScale, onSetProjectKey, allTracks }) => {
  const clipIndex = track.clips.findIndex(c => c.id === clipId);
  const clip = track.clips[clipIndex];
  
  const isDrumMode = track.type === TrackType.DRUM_RACK;
  const currentRowHeight = isDrumMode ? DRUM_ROW_HEIGHT : ROW_HEIGHT;

  // --- GAMME (Scale Highlighting de FL, Keys and Scales de Live 12) ---
  const [prefs, setPrefsState] = useState<RollPrefs>(readPrefs);
  const setPrefs = (patch: Partial<RollPrefs>) => setPrefsState(p => { const n = { ...p, ...patch }; writePrefs(n); return n; });
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

  // --- STATE ---
  const [zoomX, setZoomX] = useState(100); 
  const [quantize, setQuantize] = useState(0.25);
  const [quantizeValue, setQuantizeValue] = useState<QuantizeValue>('1/16');
  const [quantizeStrength, setQuantizeStrength] = useState<QuantizeStrength>(100);
  const [showQuantizeMenu, setShowQuantizeMenu] = useState(false);
  const [tool, setTool] = useState<EditorTool>('DRAW');
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStart, setDragStart] = useState<{ x: number, y: number, time: number, pitch: number } | null>(null);
  const [initialNotes, setInitialNotes] = useState<MidiNote[]>([]); 
  const [selectionBox, setSelectionBox] = useState<{ startX: number, startY: number, endX: number, endY: number } | null>(null);
  
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const velocityRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // --- HELPERS ---
  const snapTime = useCallback((t: number) => {
    if (quantize === 0) return t; 
    const beatTime = 60 / bpm;
    const gridSize = beatTime * (quantize * 4); 
    return Math.round(t / gridSize) * gridSize;
  }, [bpm, quantize]);

  // --- OUTILS : accords, clavier d'ordinateur, fantômes ---
  const [chordKind, setChordKind] = useState<ChordKind | null>(null);
  const [menu, setMenu] = useState<{ kind: 'scale' | 'chord'; x: number; y: number } | null>(null);
  const [lastChord, setLastChord] = useState<string | null>(null);
  useEffect(() => { if (!lastChord) return; const id = window.setTimeout(() => setLastChord(null), 4000); return () => window.clearTimeout(id); }, [lastChord]);
  const openMenu = (kind: 'scale' | 'chord', e: React.MouseEvent) => {
    if (menu?.kind === kind) { setMenu(null); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = 288;
    setMenu({ kind, x: Math.max(8, Math.min(window.innerWidth - w - 8, r.left)), y: r.bottom + 6 });
  };
  const getPitchFromY = (y: number, scrollTop: number) => {
      const i = Math.max(0, Math.min(rows.length - 1, Math.floor((y + scrollTop) / currentRowHeight)));
      return rows[i];
  };

  const getYFromPitch = (pitch: number) => rowOf(pitch) * currentRowHeight;

  const getTimeFromX = (x: number, scrollLeft: number) => {
    return (x + scrollLeft) / zoomX;
  };

  const getNoteName = (pitch: number) => {
    if (isDrumMode) return ''; // No note name on grid for drums
    const note = NOTES[pitch % 12];
    const octave = Math.floor(pitch / 12) - 1;
    return `${note}${octave}`;
  };
  
  const getDrumName = (pitch: number) => {
      // Pitch 60 = Pad 1
      const padId = pitch - 59;
      const pad = track.drumPads?.find(p => p.id === padId);
      if (!pad) return `Pad ${padId}`;
      return pad.sampleName !== 'Empty' ? pad.sampleName : `Pad ${padId}`;
  };

  // --- SYNC SCROLL ---
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target === containerRef.current) {
        if (keysRef.current) keysRef.current.scrollTop = target.scrollTop;
        if (velocityRef.current) velocityRef.current.scrollLeft = target.scrollLeft;
    }
  };

  // --- POINTER HANDLERS (souris, doigt, stylet) ---
  // Au doigt, un glissé sur la grille la fait défiler : on ne pose la note qu'au
  // relâchement, si le doigt n'a presque pas bougé.
  const pendingDrawRef = useRef<{ x: number; y: number; time: number; pitch: number } | null>(null);
  const addNoteAt = (absTime: number, pitch: number) => {
    const start = snapTime(absTime);
    const duration = isDrumMode ? 0.1 : (60 / bpm * quantize * 4); // Short fixed duration for drums
    const mk = (p: number): MidiNote => ({
        id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        pitch: p,
        start,
        duration,
        velocity: 0.8
    });
    // Tampon d'accord (Chord Stamp de FL) : toutes les notes de l'accord en un clic.
    if (chordKind && !isDrumMode) {
      const pitches = buildChord(pitch, chordKind, { root: hasKey ? keyRoot : undefined, scale: keyScale, snap: snapOn || chordKind === 'SCALE' });
      const notes = pitches.map(mk);
      updateNotes([...(clip.notes || []), ...notes]);
      setLastChord(chordLabelFr(pitches));
      return notes[0];
    }
    const newNote = mk(snapOn ? snapToScale(pitch, keyRoot!, keyScale) : pitch);
    updateNotes([...(clip.notes || []), newNote]);
    playPreview(newNote.pitch);
    return newNote;
  };
  const addNoteRef = useRef(addNoteAt);
  addNoteRef.current = addNoteAt;

  const handleMouseDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const isTouch = e.pointerType !== 'mouse';
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scrollLeft = containerRef.current.scrollLeft;
    const scrollTop = containerRef.current.scrollTop;
    
    const absTime = getTimeFromX(x, scrollLeft);
    const pitch = getPitchFromY(y, scrollTop);
    
    // Check click on note
    const clickedNote = clip.notes?.find(n => 
        n.pitch === pitch && 
        absTime >= n.start && 
        absTime <= n.start + n.duration
    );

    if (tool === 'ERASE') {
        if (clickedNote) deleteNotes([clickedNote.id]);
        return;
    }

    // DRAW or TRIGGER (Drum)
    if (tool === 'DRAW' && !clickedNote) {
        if (isTouch) { pendingDrawRef.current = { x: e.clientX, y: e.clientY, time: absTime, pitch }; return; }
        const n = addNoteAt(absTime, pitch);
        // Clavier : glisser après le clic allonge la note posée (longueur au tracé).
        if (!isDrumMode && !chordKind) {
            setSelectedNoteIds(new Set([n.id]));
            setInitialNotes([...(clip.notes || []), n]);
            setDragMode('RESIZE_R');
            setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch });
        }
        return; // Drum mode usually single click placement
    }

    if (clickedNote) {
        // Selection Logic
        let newSelected = new Set(selectedNoteIds);
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

        const isRightEdge = (absTime * zoomX) > ((clickedNote.start + clickedNote.duration) * zoomX - 10);
        
        setInitialNotes(clip.notes || []); 
        if (isRightEdge && !isDrumMode) setDragMode('RESIZE_R'); // Resize usually disabled for trigger mode unless intentional
        else setDragMode('MOVE');

        setDragStart({ x: e.clientX, y: e.clientY, time: absTime, pitch });
        playPreview(clickedNote.pitch);
    } 
    else {
        if (!e.shiftKey) setSelectedNoteIds(new Set()); 
        if (isTouch) return; // au doigt : glisser fait défiler la grille
        setDragMode('SELECT');
        setDragStart({ x: e.clientX, y: e.clientY, time: 0, pitch: 0 }); 
        setSelectionBox({ startX: x + scrollLeft, startY: y + scrollTop, endX: x + scrollLeft, endY: y + scrollTop });
    }
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragMode || !dragStart || !containerRef.current) return;
    
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const deltaTime = dx / zoomX;
    const deltaPitch = Math.round(-dy / currentRowHeight); 

    if (dragMode === 'MOVE') {
        const updatedNotes = initialNotes.map(n => {
            if (selectedNoteIds.has(n.id)) {
                let newStart = n.start + deltaTime;
                if (quantize > 0) newStart = snapTime(newStart);
                return { 
                    ...n, 
                    start: Math.max(0, newStart), 
                    pitch: shiftPitch(n.pitch, deltaPitch)
                };
            }
            return n;
        });
        updateNotes(updatedNotes);
    } 
    else if (dragMode === 'RESIZE_R') {
        const updatedNotes = initialNotes.map(n => {
            if (selectedNoteIds.has(n.id)) {
                let newDuration = Math.max(0.05, n.duration + deltaTime);
                if (quantize > 0) {
                     const endTime = n.start + newDuration;
                     const snappedEnd = snapTime(endTime);
                     newDuration = Math.max(quantize * (60/bpm), snappedEnd - n.start);
                }
                return { ...n, duration: newDuration };
            }
            return n;
        });
        updateNotes(updatedNotes);
    }
    else if (dragMode === 'SELECT') {
        const rect = containerRef.current.getBoundingClientRect();
        const scrollLeft = containerRef.current.scrollLeft;
        const scrollTop = containerRef.current.scrollTop;
        const curX = e.clientX - rect.left + scrollLeft;
        const curY = e.clientY - rect.top + scrollTop;
        
        const box = {
            startX: Math.min(selectionBox!.startX, curX),
            endX: Math.max(selectionBox!.startX, curX),
            startY: Math.min(selectionBox!.startY, curY),
            endY: Math.max(selectionBox!.startY, curY)
        };
        setSelectionBox(box as any);
        
        const newSelection = new Set<string>();
        (clip.notes || []).forEach(n => {
            const nx = n.start * zoomX;
            const ny = getYFromPitch(n.pitch);
            const nw = n.duration * zoomX;
            const nh = currentRowHeight;
            
            if (nx < box.endX && nx + nw > box.startX && ny < box.endY && ny + nh > box.startY) {
                newSelection.add(n.id);
            }
        });
        setSelectedNoteIds(newSelection);
    }
  }, [dragMode, dragStart, initialNotes, selectedNoteIds, zoomX, quantize, bpm, selectionBox, clip.notes]);

  const handleMouseUp = (e?: Event) => {
    const pending = pendingDrawRef.current;
    pendingDrawRef.current = null;
    if (pending && e && e.type === 'pointerup') {
        const pe = e as PointerEvent;
        if (Math.hypot(pe.clientX - pending.x, pe.clientY - pending.y) < 10) addNoteRef.current(pending.time, pending.pitch);
    }
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
  }, [handleMouseMove]);

  const updateNotes = (newNotes: MidiNote[]) => {
      const updatedTrack = { 
          ...track, 
          clips: track.clips.map(c => c.id === clipId ? { ...c, notes: newNotes } : c)
      };
      onUpdateTrack(updatedTrack);
  };

  const deleteNotes = (ids: string[]) => {
      const remaining = (clip.notes || []).filter(n => !ids.includes(n.id));
      updateNotes(remaining);
      setSelectedNoteIds(new Set());
  };

  // NOTE: Preview sound disabled to avoid unwanted audio feedback
  // Users can enable this in preferences if needed
  const playPreview = (pitch: number) => {
     // Sound preview disabled to avoid noise pollution during editing
     // If you want to re-enable, uncomment the code below:
     /*
     if (isDrumMode) {
         audioEngine.triggerTrackAttack(track.id, pitch, 1.0);
     } else {
         audioEngine.previewMidiNote(track.id, pitch, 0.5);
     }
     */
  };
  
  // --- QUANTIZE FUNCTION (inspired by Ableton/Logic) ---
  const applyQuantize = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    
    const beatDuration = 60 / bpm;
    const gridSize = beatDuration * (QUANTIZE_VALUES.find(q => q.value === quantizeValue)?.beats || 0.25);
    const strength = quantizeStrength / 100;
    
    const quantizedNotes = (clip.notes || []).map(note => {
      if (!selectedNoteIds.has(note.id)) return note;
      
      // Quantize start time
      const nearestGridPoint = Math.round(note.start / gridSize) * gridSize;
      const startOffset = nearestGridPoint - note.start;
      const newStart = note.start + (startOffset * strength);
      
      // Optionally quantize duration (to grid)
      const newDuration = Math.max(gridSize * 0.25, 
        Math.round(note.duration / gridSize) * gridSize
      );
      
      return {
        ...note,
        start: Math.max(0, newStart),
        duration: strength === 1 ? newDuration : note.duration
      };
    });
    
    updateNotes(quantizedNotes);
  }, [selectedNoteIds, quantizeValue, quantizeStrength, bpm, clip.notes]);
  
  // --- SELECT ALL ---
  const selectAll = useCallback(() => {
    const allIds = new Set((clip.notes || []).map(n => n.id));
    setSelectedNoteIds(allIds);
  }, [clip.notes]);
  
  // --- DOUBLE NOTES (inspired by Ableton) ---
  const doubleNotes = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    
    const selectedNotes = (clip.notes || []).filter(n => selectedNoteIds.has(n.id));
    if (selectedNotes.length === 0) return;
    
    // Find the range of selected notes
    const minStart = Math.min(...selectedNotes.map(n => n.start));
    const maxEnd = Math.max(...selectedNotes.map(n => n.start + n.duration));
    const range = maxEnd - minStart;
    
    // Create duplicates shifted by range
    const duplicates: MidiNote[] = selectedNotes.map(n => ({
      ...n,
      id: `n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      start: n.start + range
    }));
    
    updateNotes([...(clip.notes || []), ...duplicates]);
  }, [selectedNoteIds, clip.notes]);
  
  // --- TRANSPOSE (inspired by Logic Pro) ---
  const transpose = useCallback((semitones: number) => {
    if (selectedNoteIds.size === 0) return;
    
    const transposedNotes = (clip.notes || []).map(note => {
      if (!selectedNoteIds.has(note.id)) return note;
      const newPitch = note.pitch + semitones;
      if (isDrumMode) {
        return { ...note, pitch: Math.max(60, Math.min(89, newPitch)) };
      }
      // Aimant de gamme : ↑ / ↓ passent à la note de gamme suivante (comme Live en Scale Mode).
      if (snapOn && Math.abs(semitones) < 12) {
        return { ...note, pitch: Math.max(0, Math.min(127, snapToScale(newPitch, keyRoot!, keyScale, semitones > 0 ? 'up' : 'down'))) };
      }
      return { ...note, pitch: Math.max(0, Math.min(127, newPitch)) };
    });
    
    updateNotes(transposedNotes);
  }, [selectedNoteIds, clip.notes, isDrumMode, snapOn, keyRoot, keyScale]);

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
  }, [hasKey, clip.notes, selectedNoteIds, keyRoot, keyScale]);
  
  // --- HUMANIZE (inspired by Ableton) ---
  const humanizeNotes = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    
    const humanizedNotes = (clip.notes || []).map(note => {
      if (!selectedNoteIds.has(note.id)) return note;
      
      const result = midiEffectsService.humanizer.humanize({
        time: note.start,
        velocity: note.velocity * 127
      });
      
      return {
        ...note,
        start: Math.max(0, result.time),
        velocity: result.velocity / 127
      };
    });
    
    updateNotes(humanizedNotes);
  }, [selectedNoteIds, clip.notes]);
  
  // --- CLAVIER DE L'ORDINATEUR (Computer MIDI Keyboard de Live, Typing Keyboard de FL) ---
  const [kbOn, setKbOn] = useState(false);
  const [kbState, setKbState] = useState<KeyboardState>(DEFAULT_KEYBOARD_STATE);
  const [heldPitches, setHeldPitches] = useState<number[]>([]);
  const [recArmed, setRecArmed] = useState(false);
  const [recPreview, setRecPreview] = useState<{ pitch: number; start: number; duration: number; velocity: number }[]>([]);
  const [keyLabels, setKeyLabels] = useState<Record<string, string>>({});
  const kbRef = useRef<ComputerKeyboard | null>(null);
  const recRef = useRef<NoteRecorder | null>(null);
  // Dernières valeurs pour les écouteurs clavier (sans les ré-enregistrer à chaque rendu).
  const liveRef = useRef({ track, clip, isPlaying: !!isPlaying });
  liveRef.current = { track, clip, isPlaying: !!isPlaying };

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
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pitch: n.pitch, start: n.start, duration: n.duration, velocity: Math.max(0.05, Math.min(1, n.velocity / 127)),
    }));
    const end = Math.max(...notes.map(n => n.start + n.duration));
    onUpdateTrack({ ...t, clips: t.clips.map(x => x.id === c.id ? { ...x, notes: [...(x.notes || []), ...notes], duration: Math.max(x.duration, end) } : x) });
    setLastChord(`${notes.length} note${notes.length > 1 ? 's' : ''} enregistrée${notes.length > 1 ? 's' : ''} (Ctrl+Z pour annuler)`);
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
  }, [recArmed, isPlaying]);

  useEffect(() => {
    if (!kbOn) return;
    const kb = kbRef.current || (kbRef.current = new ComputerKeyboard(kbState));
    const typing = (el: EventTarget | null) => {
      const n = el as HTMLElement | null;
      if (!n || !n.tagName) return false;
      const tag = n.tagName.toLowerCase();
      if (tag === 'input') return !['range', 'button', 'checkbox'].includes((n as HTMLInputElement).type);
      return tag === 'textarea' || tag === 'select' || n.isContentEditable;
    };
    const release = (pitch: number) => {
      audioEngine.triggerTrackRelease(liveRef.current.track.id, pitch);
      if (recRef.current && liveRef.current.isPlaying) recRef.current.noteOff(pitch, clipTimeNow());
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !isComputerKeyboardCode(e.code)) return;
      // Touche du clavier musical : elle ne déclenche aucun autre raccourci.
      e.preventDefault();
      e.stopImmediatePropagation();
      const a = kb.keyDown(e.code, e.repeat);
      if (a.type === 'state') setKbState(a.state);
      if (a.type === 'noteOn') {
        void audioEngine.resume();
        audioEngine.triggerTrackAttack(liveRef.current.track.id, a.pitch, a.velocity / 127);
        if (recRef.current && liveRef.current.isPlaying) recRef.current.noteOn(a.pitch, clipTimeNow(), a.velocity);
        setHeldPitches(kb.heldPitches());
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isComputerKeyboardCode(e.code)) return;
      const a = kb.keyUp(e.code);
      if (a.type === 'noteOff') { e.stopImmediatePropagation(); release(a.pitch); setHeldPitches(kb.heldPitches()); }
    };
    const onBlur = () => { kb.releaseAll().forEach(release); setHeldPitches([]); };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, [kbOn]);

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

  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      
      if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteNotes(Array.from(selectedNoteIds));
      }
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        selectAll();
      }
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        doubleNotes();
      }
      if (e.key === 'ArrowUp' && !e.shiftKey) {
        e.preventDefault();
        transpose(e.ctrlKey ? 12 : 1);
      }
      if (e.key === 'ArrowDown' && !e.shiftKey) {
        e.preventDefault();
        transpose(e.ctrlKey ? -12 : -1);
      }
      if (e.key === 'q') {
        applyQuantize();
      }
      if (e.key === 'h') {
        humanizeNotes();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNoteIds, applyQuantize, selectAll, doubleNotes, transpose, humanizeNotes, onClose]);

  // --- DRUM ROW RENDERING ---
  const renderKeys = () => {
      if (isDrumMode) {
          // Render 30 Rows for Pads (Top down: 30 to 1)
          return Array.from({ length: 30 }).map((_, i) => {
              const padId = 30 - i;
              const pitch = 59 + padId;
              const pad = track.drumPads?.find(p => p.id === padId);
              const label = pad ? (pad.sampleName !== 'Empty' ? pad.sampleName : `Pad ${padId}`) : `Pad ${padId}`;
              
              return (
                <div 
                    key={padId}
                    className="flex items-center justify-between px-2 text-[10px] font-bold border-b border-black/20 box-border bg-[#1a1c22] text-slate-400 hover:bg-[#252830] hover:text-white cursor-pointer truncate"
                    style={{ height: currentRowHeight }}
                    onPointerDown={() => playPreview(pitch)}
                >
                    <span className="truncate w-full">{label}</span>
                </div>
              );
          });
      }

      // Clavier : notes hors gamme estompées, tonique marquée, touches jouées allumées.
      const held = new Set([...heldPitches]);
      return rows.map(pitch => {
        const isBlack = [1, 3, 6, 8, 10].includes(pitch % 12);
        const isC = pitch % 12 === 0;
        const out = highlight && !inKey(pitch);
        const isRoot = hasKey && ((pitch - keyRoot!) % 12 + 12) % 12 === 0;
        const showName = foldOn || isC || isRoot;
        return (
            <div 
                key={pitch} 
                data-pitch={pitch}
                className={`flex items-center justify-end pr-1 text-[9px] font-mono border-b border-black/20 box-border cursor-pointer ${held.has(pitch) ? 'bg-cyan-400 text-black' : isBlack ? 'bg-black text-slate-500' : 'bg-white text-slate-500'}`}
                style={{ height: currentRowHeight, opacity: out && !held.has(pitch) ? 0.45 : 1 }}
                title={`${noteNameFr(pitch)}${hasKey ? (out ? ' · hors gamme' : ' · dans la gamme') : ''} (clic : écouter)`}
                onPointerDown={() => audioEngine.previewMidiNote(track.id, pitch, 0.4)}
            >
                {isRoot && !held.has(pitch) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mr-auto ml-1" aria-hidden />}
                {showName && <span className={`font-bold mr-0.5 ${isRoot ? 'text-amber-600' : 'text-cyan-700'}`}>{noteNameFr(pitch)}</span>}
            </div>
        );
      });
  };

  const renderGridRows = () => {
     return rows.map((pitch, i) => {
         const isBlack = !isDrumMode && [1, 3, 6, 8, 10].includes(pitch % 12);
         const isAlt = isDrumMode && (i % 2 === 0);
         const out = highlight && !inKey(pitch);
         const isRoot = hasKey && ((pitch - keyRoot!) % 12 + 12) % 12 === 0;
         // Gamme surlignée : lignes de la gamme claires, hors gamme hachurées (Scale Highlighting de FL).
         const bg = highlight
           ? (out ? 'repeating-linear-gradient(135deg, #0b0c0f 0 4px, #101217 4px 8px)' : isRoot ? 'rgba(251,191,36,0.10)' : 'rgba(34,211,238,0.06)')
           : undefined;
         return (
             <div 
                 key={`bg-${pitch}`} 
                 className={`absolute left-0 right-0 border-b border-white/[0.03] ${!highlight ? (isBlack ? 'bg-[#0f1115]' : (isAlt ? 'bg-[#1a1c22]' : '')) : ''}`}
                 style={{ top: i * currentRowHeight, height: currentRowHeight, background: bg }}
             />
         );
     });
  };

  // Initial Scroll
  useEffect(() => {
      if (containerRef.current) {
          if (isDrumMode) {
             containerRef.current.scrollTop = 0; // Top for drums
          } else {
             // 808 : registre grave (Do 1 – Do 3) au centre.
             containerRef.current.scrollTop = rowOf(track.bass808 ? 36 : 72) * currentRowHeight - (containerRef.current.clientHeight / 2);
          }
      }
  }, [isDrumMode, foldOn]);

  return (
    <div data-nova-pianoroll="" className="w-full h-full flex flex-col bg-[#14161a] select-none text-white font-inter">
       {/* TOOLBAR (Enhanced with Quantize and Actions) */}
       <div className="h-14 border-b border-white/10 flex items-center justify-between gap-4 px-4 bg-[#0c0d10] shrink-0 overflow-x-auto no-scrollbar">
          <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="md:hidden shrink-0 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center"><i className="fas fa-times"></i></button>
          <div className="flex items-center space-x-4 shrink-0">
             <div className="flex items-center space-x-2">
                <div className={`w-8 h-8 rounded flex items-center justify-center border ${isDrumMode ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-green-500/20 text-green-400 border-green-500/30'}`}>
                    <i className={`fas ${isDrumMode ? 'fa-drum' : 'fa-keyboard'}`}></i>
                </div>
                <div>
                    <h3 className="text-[10px] font-black text-white uppercase tracking-widest">{isDrumMode ? 'Drum Sequencer' : 'Piano Roll'}</h3>
                    <p className="text-[9px] text-slate-500 font-mono">{clip.name}</p>
                </div>
             </div>

             {onTogglePlay && (
               <button type="button" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Lecture'} title="Écouter / pause (barre d'espace)"
                 className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${isPlaying ? 'bg-cyan-400 text-black' : 'bg-white text-black'}`}>
                 <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-sm`}></i>
               </button>
             )}

             {/* Son de la piste (mode instru : instrument VST du PC, 808) */}
             {toolbarExtra}

             <div className="h-8 w-px bg-white/10"></div>
             
             {/* Tools */}
             <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
                <button onClick={() => setTool('DRAW')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'DRAW' ? 'bg-cyan-500 text-black' : 'text-slate-500 hover:text-white'}`} title="Draw (D)"><i className="fas fa-pencil-alt text-xs"></i></button>
                <button onClick={() => setTool('SELECT')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'SELECT' ? 'bg-cyan-500 text-black' : 'text-slate-500 hover:text-white'}`} title="Select (S)"><i className="fas fa-mouse-pointer text-xs"></i></button>
                <button onClick={() => setTool('ERASE')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'ERASE' ? 'bg-red-500 text-black' : 'text-slate-500 hover:text-white'}`} title="Erase (E)"><i className="fas fa-eraser text-xs"></i></button>
             </div>
             
             <div className="h-8 w-px bg-white/10"></div>
             
             {/* Gamme, accords, fantômes, clavier de l'ordinateur (V14) */}
             {!isDrumMode && (
               <div className="flex items-center gap-1.5 shrink-0">
                 <button type="button" data-nova-roll="gamme" onClick={e => openMenu('scale', e)} aria-expanded={menu?.kind === 'scale'}
                   title="Gamme du morceau : grise les notes hors gamme, aimant, seulement la gamme (comme Scale Highlighting dans FL Studio et Scale Mode dans Live)"
                   className={`h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-[10px] font-bold ${hasKey ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}>
                   <i className="fas fa-music text-[9px]"></i>
                   <span>{hasKey ? keyLabelFr(keyRoot, keyScale) : 'Gamme'}</span>
                   {snapOn && <i className="fas fa-magnet text-[8px]" title="Aimant de gamme actif"></i>}
                   <i className="fas fa-chevron-down text-[8px]"></i>
                 </button>
                 <button type="button" data-nova-roll="accords" onClick={e => openMenu('chord', e)} aria-pressed={!!chordKind}
                   title="Outil accords : un clic pose tout l'accord, dans la gamme (comme Chord Stamp dans FL Studio)"
                   className={`h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-[10px] font-bold ${chordKind ? 'bg-fuchsia-500 border-fuchsia-400 text-black' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}>
                   <i className="fas fa-layer-group text-[9px]"></i>
                   <span>{chordKind ? CHORD_CHOICES.find(c => c.id === chordKind)?.label : 'Accords'}</span>
                 </button>
                 <button type="button" data-nova-roll="fantomes" onClick={() => setPrefs({ ghosts: !prefs.ghosts })} aria-pressed={prefs.ghosts}
                   title={`Notes fantômes : les notes des autres pistes MIDI en filigrane, pour écrire la 808 en voyant la mélodie (comme Ghost Notes dans FL Studio)${ghostTrackCount ? ` · ${ghostTrackCount} piste${ghostTrackCount > 1 ? 's' : ''}` : ''}`}
                   className={`h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-[10px] font-bold ${prefs.ghosts ? 'bg-slate-200/10 border-slate-300/40 text-slate-200' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}>
                   <i className="fas fa-ghost text-[9px]"></i><span>Fantômes</span>
                 </button>
                 <button type="button" data-nova-roll="clavier" onClick={() => { setKbOn(v => !v); if (kbOn) setRecArmed(false); }} aria-pressed={kbOn}
                   title={kbOn ? "Clavier de l'ordinateur ACTIF : les lettres jouent des notes. Clic pour le couper et retrouver les raccourcis." : "Jouer avec le clavier de l'ordinateur (comme Computer MIDI Keyboard dans Live et Typing Keyboard dans FL Studio)"}
                   className={`h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-[10px] font-bold ${kbOn ? 'bg-cyan-400 border-cyan-300 text-black' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}>
                   <i className="fas fa-keyboard text-[9px]"></i><span>{kbOn ? 'Clavier actif' : 'Clavier'}</span>
                 </button>
                 {kbOn && (
                   <button type="button" data-nova-roll="rec-midi" onClick={() => { const on = !recArmed; setRecArmed(on); if (on && !isPlaying) onTogglePlay?.(); }} aria-pressed={recArmed}
                     title={recArmed ? 'Prise MIDI armée : ce que tu joues pendant la lecture s’écrit dans le clip (à l’arrêt). Clic pour désarmer.' : 'Enregistrer ce que tu joues au clavier dans le clip (lance la lecture)'}
                     className={`h-8 px-2.5 rounded-lg border flex items-center gap-1.5 text-[10px] font-black ${recArmed ? 'bg-red-600 border-red-400 text-white animate-pulse' : 'bg-white/5 border-white/10 text-red-400 hover:text-white'}`}>
                     <span className={`w-2 h-2 rounded-full ${recArmed ? 'bg-white' : 'bg-red-500'}`}></span><span>{recArmed ? 'Prise…' : 'Enregistrer'}</span>
                   </button>
                 )}
               </div>
             )}

             <div className="h-8 w-px bg-white/10"></div>

             {/* Quantize Controls (inspired by Ableton) */}
             <div className="flex items-center space-x-2 relative">
                <button
                  onClick={() => setShowQuantizeMenu(!showQuantizeMenu)}
                  className="h-8 px-3 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 flex items-center space-x-2 text-[10px] font-bold"
                >
                  <i className="fas fa-th text-[9px]"></i>
                  <span>{quantizeValue}</span>
                  <i className="fas fa-chevron-down text-[8px]"></i>
                </button>
                
                {/* Quantize Dropdown */}
                {showQuantizeMenu && (
                  <div className="absolute top-full left-0 mt-2 bg-[#1a1c22] border border-white/20 rounded-xl shadow-2xl z-[200] p-3 w-56">
                    <div className="text-[9px] font-black uppercase text-slate-400 mb-2">Quantize Grid</div>
                    <div className="grid grid-cols-3 gap-1 mb-3">
                      {QUANTIZE_VALUES.map(q => (
                        <button
                          key={q.value}
                          onClick={() => {
                            setQuantizeValue(q.value);
                            setQuantize(q.beats * (60 / bpm));
                          }}
                          className={`py-1.5 rounded text-[9px] font-bold ${quantizeValue === q.value ? 'bg-purple-500 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                        >
                          {q.label}
                        </button>
                      ))}
                    </div>
                    
                    <div className="text-[9px] font-black uppercase text-slate-400 mb-2">Strength</div>
                    <div className="flex space-x-1 mb-3">
                      {([25, 50, 75, 100] as QuantizeStrength[]).map(s => (
                        <button
                          key={s}
                          onClick={() => setQuantizeStrength(s)}
                          className={`flex-1 py-1.5 rounded text-[9px] font-bold ${quantizeStrength === s ? 'bg-purple-500 text-white' : 'bg-white/5 text-slate-400'}`}
                        >
                          {s}%
                        </button>
                      ))}
                    </div>
                    
                    <button
                      onClick={() => { applyQuantize(); setShowQuantizeMenu(false); }}
                      disabled={selectedNoteIds.size === 0}
                      className={`w-full py-2 rounded text-[10px] font-bold ${selectedNoteIds.size > 0 ? 'bg-purple-500 text-white' : 'bg-white/5 text-slate-600'}`}
                    >
                      Quantize Selected (Q)
                    </button>
                  </div>
                )}
                
                {/* Quick Quantize Button */}
                <button
                  onClick={applyQuantize}
                  disabled={selectedNoteIds.size === 0}
                  className={`h-8 px-3 rounded-lg flex items-center space-x-1 text-[10px] font-bold ${selectedNoteIds.size > 0 ? 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30' : 'bg-white/5 text-slate-600'}`}
                  title="Apply Quantize (Q)"
                >
                  <i className="fas fa-magnet text-[9px]"></i>
                  <span>Q</span>
                </button>
             </div>
             
             <div className="h-8 w-px bg-white/10"></div>
             
             {/* Edit Actions (inspired by Logic Pro) */}
             <div className="flex items-center space-x-1">
                <button
                  onClick={() => transpose(1)}
                  disabled={selectedNoteIds.size === 0}
                  className={`h-8 px-2 rounded text-[10px] ${selectedNoteIds.size > 0 ? 'text-slate-400 hover:text-white hover:bg-white/10' : 'text-slate-600'}`}
                  title="Transpose Up (↑)"
                >
                  <i className="fas fa-arrow-up"></i>
                </button>
                <button
                  onClick={() => transpose(-1)}
                  disabled={selectedNoteIds.size === 0}
                  className={`h-8 px-2 rounded text-[10px] ${selectedNoteIds.size > 0 ? 'text-slate-400 hover:text-white hover:bg-white/10' : 'text-slate-600'}`}
                  title="Transpose Down (↓)"
                >
                  <i className="fas fa-arrow-down"></i>
                </button>
                <button
                  onClick={doubleNotes}
                  disabled={selectedNoteIds.size === 0}
                  className={`h-8 px-3 rounded text-[10px] font-bold ${selectedNoteIds.size > 0 ? 'text-amber-400 hover:bg-amber-500/10' : 'text-slate-600'}`}
                  title="Double Notes (Ctrl+D)"
                >
                  <i className="fas fa-clone mr-1"></i>2x
                </button>
                <button
                  onClick={humanizeNotes}
                  disabled={selectedNoteIds.size === 0}
                  className={`h-8 px-3 rounded text-[10px] font-bold ${selectedNoteIds.size > 0 ? 'text-green-400 hover:bg-green-500/10' : 'text-slate-600'}`}
                  title="Humanize (H)"
                >
                  <i className="fas fa-random mr-1"></i>H
                </button>
             </div>
          </div>
          
          {/* Right side: Info and Close */}
          <div className="flex items-center space-x-4 shrink-0">
             <div className="text-[9px] text-slate-500">
                {selectedNoteIds.size > 0 && <span className="text-cyan-400">{selectedNoteIds.size} selected</span>}
                {selectedNoteIds.size === 0 && <span>{(clip.notes || []).length} notes</span>}
             </div>
             <div className="flex items-center space-x-1">
                <i className="fas fa-search-plus text-[10px] text-slate-500"></i>
                <input
                  type="range"
                  min="50"
                  max="300"
                  value={zoomX}
                  onChange={(e) => setZoomX(parseInt(e.target.value))}
                  className="w-20 accent-cyan-500"
                />
             </div>
             <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="hidden md:flex w-8 h-8 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-red-500/20 flex items-center justify-center"><i className="fas fa-times"></i></button>
          </div>
       </div>

       {/* Bandeau d'état : clavier de l'ordinateur, accord posé, gamme */}
       {!isDrumMode && (kbOn || lastChord || chordKind) && (
         <div data-nova-roll="bandeau" className="shrink-0 min-h-8 px-4 py-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 bg-[#101216] text-[11px] text-slate-300">
           {kbOn && (
             <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
               <span className="text-cyan-300 font-bold"><i className="fas fa-keyboard mr-1"></i>Joue avec les lettres</span>
               <span className="font-mono text-slate-400">{['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'].map(keyLabel).join(' ')} = Do Ré Mi Fa Sol La Si Do · {['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU'].map(keyLabel).join(' ')} = dièses</span>
               <span>Octave <b className="text-white">Do{kbState.octave}</b> <span className="text-slate-500">({keyLabel('KeyZ')} / {keyLabel('KeyX')})</span></span>
               <span>Vélocité <b className="text-white">{kbState.velocity}</b> <span className="text-slate-500">({keyLabel('KeyC')} / {keyLabel('KeyV')})</span></span>
               {heldPitches.length > 0 && <span className="text-cyan-300 font-bold">{heldPitches.length > 2 ? chordLabelFr([...heldPitches].sort((a, b) => a - b)) : heldPitches.map(noteNameFr).join(' + ')}</span>}
               <span className="text-slate-500">Sur la piste « {track.name} »</span>
             </span>
           )}
           {chordKind && <span className="text-fuchsia-300"><i className="fas fa-layer-group mr-1"></i>Clique dans la grille pour poser un accord {CHORD_CHOICES.find(c => c.id === chordKind)?.label.toLowerCase()}{hasKey ? ` dans ${keyLabelFr(keyRoot, keyScale)}` : ''}</span>}
           {lastChord && <span className="text-amber-200" role="status">{lastChord}</span>}
         </div>
       )}

       {menu && (
         <>
           <div className="fixed inset-0 z-[290]" onPointerDown={() => setMenu(null)} />
           <div role="dialog" aria-label={menu.kind === 'scale' ? 'Gamme du morceau' : 'Outil accords'} data-nova-roll-menu={menu.kind}
             className="fixed z-[300] w-72 max-h-[70vh] overflow-y-auto rounded-xl border border-white/15 bg-[#1a1c22] p-3 shadow-2xl text-[11px] text-slate-200"
             style={{ left: menu.x, top: menu.y }}>
             {menu.kind === 'scale' ? (
               <div className="space-y-3">
                 <div>
                   <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Tonalité du morceau</div>
                   <div className="flex gap-2">
                     <select aria-label="Note de la tonalité" value={typeof keyRoot === 'number' ? keyRoot : ''} onChange={e => setKey(Number(e.target.value), keyScale)}
                       className="flex-1 h-9 rounded-lg bg-black/40 border border-white/15 px-2 text-white">
                       {typeof keyRoot !== 'number' && <option value="">Choisir…</option>}
                       {NOTE_NAMES_FR.map((n, i) => <option key={n} value={i}>{n}</option>)}
                     </select>
                     <select aria-label="Gamme" value={keyScale.toUpperCase()} onChange={e => setKey(typeof keyRoot === 'number' ? keyRoot : 0, e.target.value)}
                       className="flex-1 h-9 rounded-lg bg-black/40 border border-white/15 px-2 text-white">
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
                   className="w-full h-9 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-200 font-bold disabled:opacity-40">
                   <i className="fas fa-compress-arrows-alt mr-1.5"></i>Remettre {selectedNoteIds.size > 0 ? 'la sélection' : 'tout le clip'} dans la gamme
                 </button>
               </div>
             ) : (
               <div className="space-y-1">
                 <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Accord posé en un clic</div>
                 {CHORD_CHOICES.map(c => (
                   <button key={c.id} type="button" onClick={() => { setChordKind(c.id); setTool('DRAW'); setMenu(null); setLastChord(null); }} title={c.hint}
                     className={`w-full text-left rounded-lg px-2.5 py-1.5 ${chordKind === c.id ? 'bg-fuchsia-500 text-black' : 'hover:bg-white/5'}`}>
                     <b>{c.label}</b> <span className={chordKind === c.id ? 'text-black/70' : 'text-slate-500'}>· {c.hint}</span>
                   </button>
                 ))}
                 <button type="button" onClick={() => { setChordKind(null); setMenu(null); setLastChord(null); }} disabled={!chordKind}
                   className="mt-2 w-full h-9 rounded-lg bg-white/5 border border-white/10 font-bold disabled:opacity-40">Notes simples (couper l'outil accords)</button>
               </div>
             )}
           </div>
         </>
       )}

       <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden relative" style={{ minHeight: '70%' }}>
              
              {/* SIDEBAR (Keys or Pads) */}
              <div ref={keysRef} className={`flex-shrink-0 bg-[#0c0d10] border-r border-white/10 overflow-hidden relative z-20 shadow-xl no-scrollbar ${isDrumMode ? 'w-32' : 'w-16'}`}>
                 <div style={{ height: totalRows * currentRowHeight, position: 'relative' }}>
                    {renderKeys()}
                 </div>
              </div>

              {/* GRID */}
              <div 
                 ref={containerRef}
                 className="flex-1 overflow-auto bg-[#14161a] relative cursor-crosshair custom-scroll"
                 style={{ touchAction: 'pan-x pan-y' }}
                 onScroll={handleScroll}
                 onPointerDown={handleMouseDown}
              >
                 <div style={{ width: Math.max((clip.duration + 4) * zoomX, 2000), height: totalRows * currentRowHeight, position: 'relative' }}>
                    {renderGridRows()}

                    {/* Beat Grid */}
                    {Array.from({ length: Math.ceil((clip.duration + 4) / (quantize || 0.25)) }).map((_, i) => (
                        <div 
                            key={`grid-${i}`}
                            className={`absolute top-0 bottom-0 border-r pointer-events-none ${Math.abs((i * (quantize || 0.25)) % (240/bpm)) < 0.01 ? 'border-white/10' : 'border-white/[0.03]'}`}
                            style={{ left: i * (quantize || 0.25) * zoomX }}
                        />
                    ))}

                    {/* NOTES FANTÔMES : autres pistes MIDI, non cliquables */}
                    {ghostNotes.map(g => (
                      <div key={`gh-${g.key}`} className="absolute rounded-[2px] pointer-events-none" data-nova-ghost=""
                        style={{ left: g.start * zoomX, top: getYFromPitch(g.pitch) + 2, width: Math.max(4, g.duration * zoomX - 1), height: currentRowHeight - 4,
                          border: `1px dashed ${g.color}`, backgroundColor: `${g.color}22`, opacity: 0.55 }} />
                    ))}

                    {/* NOTES */}
                    {(clip.notes || []).map(note => {
                        const isSelected = selectedNoteIds.has(note.id);
                        const outOfKey = highlight && !inKey(note.pitch);
                        return (
                            <div
                                key={note.id}
                                data-nova-note={note.pitch}
                                data-hors-gamme={outOfKey ? '1' : undefined}
                                title={`${noteNameFr(note.pitch)}${outOfKey ? ' · hors gamme' : ''}`}
                                className={`absolute rounded-[2px] border flex items-center overflow-hidden ${outOfKey && !isSelected ? 'border-red-400/70' : 'border-black/30'}`}
                                style={{
                                    left: note.start * zoomX,
                                    top: getYFromPitch(note.pitch) + 1,
                                    width: Math.max(5, note.duration * zoomX - 1),
                                    height: currentRowHeight - 2,
                                    backgroundColor: isSelected ? '#fff' : (isDrumMode ? '#f97316' : outOfKey ? '#64748b' : track.color),
                                    opacity: isSelected ? 1 : outOfKey ? 0.55 : 0.8,
                                    // Glisser une note au doigt la déplace (pas de défilement)
                                    touchAction: 'none'
                                }}
                            >
                                {!isDrumMode && (note.duration * zoomX) > 20 && <span className="text-[7px] text-black ml-1 font-bold">{noteNameFr(note.pitch)}</span>}
                            </div>
                        );
                    })}

                    {/* Notes en cours de prise au clavier */}
                    {recPreview.map((n, i) => (
                      <div key={`rec-${i}`} className="absolute rounded-[2px] pointer-events-none bg-red-500/80 border border-red-300"
                        style={{ left: n.start * zoomX, top: getYFromPitch(n.pitch) + 1, width: Math.max(4, n.duration * zoomX), height: currentRowHeight - 2 }} />
                    ))}

                    {/* Playhead */}
                    <PianoRollPlayhead clipStart={clip.start} zoomX={zoomX} />
                    
                    {selectionBox && (
                         <div className="absolute border border-cyan-500 bg-cyan-500/20 pointer-events-none" style={{ left: Math.min(selectionBox.startX, selectionBox.endX), top: Math.min(selectionBox.startY, selectionBox.endY), width: Math.abs(selectionBox.endX - selectionBox.startX), height: Math.abs(selectionBox.endY - selectionBox.startY) }} />
                    )}
                 </div>
              </div>
          </div>
          
          {/* Velocity Panel (Simple version) */}
          <div className="h-[30%] border-t border-white/10 bg-[#0f1115] flex relative z-30">
               {/* Just spacer for sidebar alignment */}
               <div className={`flex-shrink-0 border-r border-white/10 bg-[#0c0d10] ${isDrumMode ? 'w-32' : 'w-16'}`}></div>
               <div ref={velocityRef} className="flex-1 overflow-hidden relative">
                    <div style={{ width: Math.max((clip.duration + 4) * zoomX, 2000), height: '100%', position: 'relative' }}>
                        {(clip.notes || []).map(note => (
                            <div key={`vel-${note.id}`} className="absolute bottom-0 w-1.5 bg-slate-500 hover:bg-white" style={{ left: note.start * zoomX, height: `${note.velocity * 100}%` }} />
                        ))}
                    </div>
               </div>
          </div>
       </div>
    </div>
  );
};

export default PianoRoll;
