
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Track, Clip, MidiNote, EditorTool, TrackType } from '../types';
import { NOTES } from '../plugins/AutoTunePlugin';
import { audioEngine } from '../engine/AudioEngine';
import { midiEffectsService } from '../services/MidiEffectsService';

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
  currentTime: number;
  onUpdateTrack: (track: Track) => void;
  onClose: () => void;
}

// Configuration
const ROW_HEIGHT = 16; 
const DRUM_ROW_HEIGHT = 24; // Bigger rows for drum names
const VELOCITY_HEIGHT = 150; 

type DragMode = 'MOVE' | 'RESIZE_R' | 'VELOCITY' | 'SELECT' | 'DRAW' | null;

const PianoRoll: React.FC<PianoRollProps> = ({ track, clipId, bpm, currentTime, onUpdateTrack, onClose }) => {
  const clipIndex = track.clips.findIndex(c => c.id === clipId);
  const clip = track.clips[clipIndex];
  
  const isDrumMode = track.type === TrackType.DRUM_RACK;
  const currentRowHeight = isDrumMode ? DRUM_ROW_HEIGHT : ROW_HEIGHT;
  const totalRows = isDrumMode ? 30 : 128; // 30 Pads vs 128 Keys

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

  // Y Axis:
  // Standard: 127 (Top) -> 0 (Bottom)
  // Drum: Pad 30 (Top, Index 29) -> Pad 1 (Bottom, Index 0)
  // Pad Index = y / H
  // Note Pitch:
  // Standard: 127 - (y/H)
  // Drum: For rendering, Pad 30 is top. We want Pad 30 to be MIDI 89. Pad 1 is MIDI 60.
  // Top Row (0) -> Pad 30 (89)
  // Bottom Row (29) -> Pad 1 (60)
  // Pitch = (60 + 29) - RowIndex
  const getPitchFromY = (y: number, scrollTop: number) => {
      const rowIndex = Math.floor((y + scrollTop) / currentRowHeight);
      if (isDrumMode) {
          // Row 0 is Pad 30 (89)
          // Row 29 is Pad 1 (60)
          return 89 - rowIndex; 
      }
      return 127 - rowIndex;
  };

  const getYFromPitch = (pitch: number) => {
      if (isDrumMode) {
          // Pitch 89 -> Row 0
          // Pitch 60 -> Row 29
          return (89 - pitch) * currentRowHeight;
      }
      return (127 - pitch) * currentRowHeight;
  };

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

  // --- MOUSE HANDLERS ---
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
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
        const start = snapTime(absTime);
        const duration = isDrumMode ? 0.1 : (60 / bpm * quantize * 4); // Short fixed duration for drums
        const newNote: MidiNote = {
            id: `n-${Date.now()}`,
            pitch,
            start,
            duration,
            velocity: 0.8
        };
        updateNotes([...(clip.notes || []), newNote]);
        playPreview(pitch);
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
                let newPitch = n.pitch + deltaPitch;
                if (quantize > 0) newStart = snapTime(newStart);
                return { 
                    ...n, 
                    start: Math.max(0, newStart), 
                    pitch: isDrumMode ? Math.max(60, Math.min(89, newPitch)) : Math.max(0, Math.min(127, newPitch)) 
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

  const handleMouseUp = () => {
    setDragMode(null);
    setDragStart(null);
    setSelectionBox(null);
  };

  useEffect(() => {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
          window.removeEventListener('mousemove', handleMouseMove);
          window.removeEventListener('mouseup', handleMouseUp);
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

  const playPreview = (pitch: number) => {
     if (isDrumMode) {
         // Trigger Pad (Note 60 = Pad 1)
         const padId = pitch - 59;
         // Send to engine
         audioEngine.triggerTrackAttack(track.id, pitch, 1.0);
         // Visual feedback could be added via ref
     } else {
         audioEngine.previewMidiNote(track.id, pitch, 0.5);
     }
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
      return { ...note, pitch: Math.max(0, Math.min(127, newPitch)) };
    });
    
    updateNotes(transposedNotes);
  }, [selectedNoteIds, clip.notes, isDrumMode]);
  
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
  
  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      
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
  }, [selectedNoteIds, applyQuantize, selectAll, doubleNotes, transpose, humanizeNotes]);

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
                    onMouseDown={() => playPreview(pitch)}
                >
                    <span className="truncate w-full">{label}</span>
                </div>
              );
          });
      }

      // Standard Piano
      return Array.from({ length: 128 }).map((_, i) => {
        const pitch = 127 - i;
        const isBlack = [1, 3, 6, 8, 10].includes(pitch % 12);
        const isC = pitch % 12 === 0;
        return (
            <div 
                key={pitch} 
                className={`flex items-center justify-end pr-1 text-[9px] font-mono border-b border-black/20 box-border ${isBlack ? 'bg-black text-slate-600' : 'bg-white text-slate-400'}`}
                style={{ height: currentRowHeight }}
                onMouseDown={() => playPreview(pitch)}
            >
                {isC && <span className="opacity-100 font-bold text-cyan-600 mr-1">C{Math.floor(pitch/12)-1}</span>}
            </div>
        );
      });
  };

  const renderGridRows = () => {
     return Array.from({ length: totalRows }).map((_, i) => {
         const pitch = isDrumMode ? (89 - i) : (127 - i);
         const isBlack = !isDrumMode && [1, 3, 6, 8, 10].includes(pitch % 12);
         const isAlt = isDrumMode && (i % 2 === 0);
         return (
             <div 
                 key={`bg-${pitch}`} 
                 className={`absolute left-0 right-0 border-b border-white/[0.03] ${isBlack ? 'bg-[#0f1115]' : (isAlt ? 'bg-[#1a1c22]' : '')}`}
                 style={{ top: i * currentRowHeight, height: currentRowHeight }}
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
             containerRef.current.scrollTop = (127 - 72) * currentRowHeight - (containerRef.current.clientHeight / 2);
          }
      }
  }, [isDrumMode]);

  return (
    <div className="w-full h-full flex flex-col bg-[#14161a] select-none text-white font-inter">
       {/* TOOLBAR (Enhanced with Quantize and Actions) */}
       <div className="h-14 border-b border-white/10 flex items-center justify-between px-4 bg-[#0c0d10] shrink-0">
          <div className="flex items-center space-x-4">
             <div className="flex items-center space-x-2">
                <div className={`w-8 h-8 rounded flex items-center justify-center border ${isDrumMode ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-green-500/20 text-green-400 border-green-500/30'}`}>
                    <i className={`fas ${isDrumMode ? 'fa-drum' : 'fa-keyboard'}`}></i>
                </div>
                <div>
                    <h3 className="text-[10px] font-black text-white uppercase tracking-widest">{isDrumMode ? 'Drum Sequencer' : 'Piano Roll'}</h3>
                    <p className="text-[9px] text-slate-500 font-mono">{clip.name}</p>
                </div>
             </div>
             
             <div className="h-8 w-px bg-white/10"></div>
             
             {/* Tools */}
             <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
                <button onClick={() => setTool('DRAW')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'DRAW' ? 'bg-cyan-500 text-black' : 'text-slate-500 hover:text-white'}`} title="Draw (D)"><i className="fas fa-pencil-alt text-xs"></i></button>
                <button onClick={() => setTool('SELECT')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'SELECT' ? 'bg-cyan-500 text-black' : 'text-slate-500 hover:text-white'}`} title="Select (S)"><i className="fas fa-mouse-pointer text-xs"></i></button>
                <button onClick={() => setTool('ERASE')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'ERASE' ? 'bg-red-500 text-black' : 'text-slate-500 hover:text-white'}`} title="Erase (E)"><i className="fas fa-eraser text-xs"></i></button>
             </div>
             
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
          <div className="flex items-center space-x-4">
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
             <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-red-500/20 flex items-center justify-center"><i className="fas fa-times"></i></button>
          </div>
       </div>

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
                 onScroll={handleScroll}
                 onMouseDown={handleMouseDown}
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

                    {/* NOTES */}
                    {(clip.notes || []).map(note => {
                        const isSelected = selectedNoteIds.has(note.id);
                        return (
                            <div
                                key={note.id}
                                className={`absolute rounded-[2px] border border-black/30 flex items-center overflow-hidden`}
                                style={{
                                    left: note.start * zoomX,
                                    top: getYFromPitch(note.pitch) + 1,
                                    width: Math.max(5, note.duration * zoomX - 1),
                                    height: currentRowHeight - 2,
                                    backgroundColor: isSelected ? '#fff' : (isDrumMode ? '#f97316' : track.color),
                                    opacity: isSelected ? 1 : 0.8
                                }}
                            >
                                {!isDrumMode && (note.duration * zoomX) > 20 && <span className="text-[7px] text-black ml-1 font-bold">{getNoteName(note.pitch)}</span>}
                            </div>
                        );
                    })}

                    {/* Playhead */}
                    <div className="absolute top-0 bottom-0 w-0.5 bg-white z-50 pointer-events-none" style={{ left: (currentTime - clip.start) * zoomX }} />
                    
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
