
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Track, Clip, MidiNote, EditorTool, TrackType } from '../types';
import { NOTES } from '../plugins/AutoTunePlugin';
import { audioEngine } from '../engine/AudioEngine';

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
       {/* TOOLBAR (Same as before) */}
       <div className="h-12 border-b border-white/10 flex items-center justify-between px-4 bg-[#0c0d10] shrink-0">
          <div className="flex items-center space-x-6">
             <div className="flex items-center space-x-2">
                <div className={`w-8 h-8 rounded flex items-center justify-center border ${isDrumMode ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-green-500/20 text-green-400 border-green-500/30'}`}>
                    <i className={`fas ${isDrumMode ? 'fa-drum' : 'fa-keyboard'}`}></i>
                </div>
                <div>
                    <h3 className="text-[10px] font-black text-white uppercase tracking-widest">{isDrumMode ? 'Drum Sequencer' : 'Piano Roll'}</h3>
                    <p className="text-[9px] text-slate-500 font-mono">{clip.name}</p>
                </div>
             </div>
             {/* Tools... */}
             <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
                <button onClick={() => setTool('DRAW')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'DRAW' ? 'bg-cyan-500 text-black' : 'text-slate-500'}`}><i className="fas fa-pencil-alt text-xs"></i></button>
                <button onClick={() => setTool('SELECT')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'SELECT' ? 'bg-cyan-500 text-black' : 'text-slate-500'}`}><i className="fas fa-mouse-pointer text-xs"></i></button>
                <button onClick={() => setTool('ERASE')} className={`w-8 h-8 rounded flex items-center justify-center ${tool === 'ERASE' ? 'bg-red-500 text-black' : 'text-slate-500'}`}><i className="fas fa-eraser text-xs"></i></button>
             </div>
             {/* Quantize... */}
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 text-slate-400 hover:text-white flex items-center justify-center"><i className="fas fa-times"></i></button>
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
