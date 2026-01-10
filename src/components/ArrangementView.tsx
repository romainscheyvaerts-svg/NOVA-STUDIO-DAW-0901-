import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Track, TrackType, PluginType, PluginInstance, Clip, EditorTool, ContextMenuItem, AutomationLane, AutomationPoint } from '../types';
import TrackHeader from './TrackHeader';
import ContextMenu from './ContextMenu';
import TimelineGridMenu from './TimelineGridMenu'; 
import LiveRecordingClip from './LiveRecordingClip'; 
import AutomationLaneComponent from './AutomationLane';

interface ArrangementViewProps {
  tracks: Track[];
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
  onUpdateTrack: (track: Track) => void;
  onReorderTracks: (sourceTrackId: string, destTrackId: string) => void;
  currentTime: number;
  isLoopActive: boolean;
  loopStart: number;
  loopEnd: number;
  onSetLoop: (start: number, end: number) => void;
  onSeek: (time: number) => void;
  bpm: number;
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
  recStartTime: number | null;
  onCreatePattern?: (trackId: string, time: number) => void;
  onSwapInstrument?: (trackId: string) => void; 
  onEditMidi?: (trackId: string, clipId: string) => void;
  onAudioDrop?: (trackId: string, url: string, name: string) => void;
}

// Zones d'interaction intelligentes
type DragAction = 'MOVE' | 'SCRUB' | null;
type LoopDragMode = 'START' | 'END' | 'BODY' | null;

const getSnappedTime = (time: number, bpm: number, gridSize: string, enabled: boolean): number => {
    if (!enabled) return time;
    const beatDuration = 60 / bpm;
    let subDiv = beatDuration; // 1/4 default
    if (gridSize === '1/8') subDiv = beatDuration / 2;
    else if (gridSize === '1/16') subDiv = beatDuration / 4;
    else if (gridSize === '1/1') subDiv = beatDuration * 4; 
    
    return Math.round(time / subDiv) * subDiv;
};

const ArrangementView: React.FC<ArrangementViewProps> = ({ 
  tracks, selectedTrackId, onSelectTrack, onUpdateTrack, onReorderTracks, currentTime, 
  isLoopActive, loopStart, loopEnd, onSetLoop, onSeek, bpm, 
  onDropPluginOnTrack, onMovePlugin, onMoveClip, onSelectPlugin, onRemovePlugin, onRequestAddPlugin,
  onAddTrack, onDuplicateTrack, onDeleteTrack, onFreezeTrack, onImportFile, onEditClip, isRecording, recStartTime,
  onCreatePattern, onSwapInstrument, onEditMidi, onAudioDrop
}) => {
  const [activeTool, setActiveTool] = useState<EditorTool>('SELECT');
  const [zoomV, setZoomV] = useState(120); 
  const [zoomH, setZoomH] = useState(40);  
  const [snapEnabled, setSnapEnabled] = useState(true);
  
  const [gridSize, setGridSize] = useState<string>('1/4');
  const [gridMenu, setGridMenu] = useState<{ x: number, y: number } | null>(null);

  const [dragAction, setDragAction] = useState<DragAction | null>(null);
  const [activeClip, setActiveClip] = useState<{trackId: string, clip: Clip} | null>(null);
  
  const [loopDragMode, setLoopDragMode] = useState<LoopDragMode>(null);
  const [initialLoopState, setInitialLoopState] = useState<{ start: number, end: number } | null>(null);

  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartY, setDragStartY] = useState(0);
  const [initialClipState, setInitialClipState] = useState<Clip | null>(null);

  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, items: (ContextMenuItem | 'separator')[] } | null>(null);
  const [clipContextMenu, setClipContextMenu] = useState<{ x: number; y: number; trackId: string; clip: Clip } | null>(null);

  const [headerWidth, setHeaderWidth] = useState(256);
  const [isResizingHeader, setIsResizingHeader] = useState(false);
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);

  const isShiftDownRef = useRef(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sidebarContainerRef = useRef<HTMLDivElement>(null); 
  const minimapRef = useRef<HTMLCanvasElement>(null);
  
  const requestRef = useRef<number>(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [scrollLeft, setScrollLeft] = useState(0);

  const timeToPixels = useCallback((time: number) => time * zoomH, [zoomH]);
  const pixelsToTime = useCallback((pixels: number) => pixels / zoomH, [zoomH]);

  useEffect(() => {
    (window as any).gridSize = gridSize;
    (window as any).isSnapEnabled = snapEnabled;
  }, [gridSize, snapEnabled]);

  useEffect(() => {
    const handleKD = (e: KeyboardEvent) => { if (e.key === 'Shift') isShiftDownRef.current = true; };
    const handleKU = (e: KeyboardEvent) => { if (e.key === 'Shift') isShiftDownRef.current = false; };
    window.addEventListener('keydown', handleKD);
    window.addEventListener('keyup', handleKU);
    return () => { window.removeEventListener('keydown', handleKD); window.removeEventListener('keyup', handleKU); };
  }, []);

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

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const scrollTop = target.scrollTop;
    const scrollLeftVal = target.scrollLeft;
    if (target === scrollContainerRef.current) { setScrollLeft(scrollLeftVal); }
    if (sidebarContainerRef.current) { sidebarContainerRef.current.scrollTop = scrollTop; }
  };

  const handleSidebarWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && scrollContainerRef.current) {
        scrollContainerRef.current.scrollLeft += e.deltaX;
    }
  };

  const visibleTracks = useMemo(() => tracks.filter(t => t.type !== TrackType.SEND), [tracks]);
  const projectDuration = useMemo(() => Math.max(...tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 300), [tracks]);
  const totalContentWidth = useMemo(() => projectDuration * zoomH, [projectDuration, zoomH]);
  const totalArrangementHeight = useMemo(() => 40 + 500 + visibleTracks.reduce((acc, t) => acc + zoomV + t.automationLanes.filter(l => l.isExpanded).length * 80, 0), [visibleTracks, zoomV]);

  const handleHeaderResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizingHeader(true);
      const startX = e.clientX;
      const startWidth = headerWidth;
      const onMove = (moveEvent: MouseEvent) => {
          const newWidth = Math.max(150, Math.min(600, startWidth + moveEvent.clientX - startX));
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
  
  const handleTimelineDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const handleTimelineDrop = (e: React.DragEvent) => {
      e.preventDefault();
      const audioUrl = e.dataTransfer.getData('audio-url');
      if (audioUrl) {
          onAudioDrop?.(selectedTrackId || 'instrumental', audioUrl, e.dataTransfer.getData('audio-name') || 'Beat');
          return;
      }
      if (e.dataTransfer.files?.length > 0) onImportFile?.(e.dataTransfer.files[0]);
  };

  useEffect(() => {
    const canvas = minimapRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) { canvas.width = rect.width; canvas.height = rect.height; }
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#08090b'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1e2229'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
    const scale = w / Math.max(totalContentWidth, 1);
    const trackHeight = h / Math.max(visibleTracks.length, 1);
    visibleTracks.forEach((t, tIdx) => {
        const y = tIdx * trackHeight;
        if (tIdx % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.02)'; ctx.fillRect(0, y, w, trackHeight); }
        ctx.fillStyle = t.color; ctx.globalAlpha = 0.4;
        t.clips.forEach(c => {
             const cx = (c.start * zoomH) * scale;
             const cw = (c.duration * zoomH) * scale;
             ctx.fillRect(cx, y + 1, Math.max(2, cw), Math.max(1, trackHeight - 2));
        });
        ctx.globalAlpha = 1.0;
    });
    const phX = (currentTime * zoomH) * scale;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
    const viewportWidth = viewportSize.width;
    const vx = scrollLeft * scale;
    const vw = viewportWidth * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, vx, h); ctx.fillRect(vx + vw, 0, w - (vx + vw), h);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.strokeRect(vx, 0, vw, h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(vx, 0, vw, h);
  }, [visibleTracks, totalContentWidth, scrollLeft, viewportSize, zoomH, currentTime]);

  const handleMinimapMouseDown = (e: React.MouseEvent) => {
      const canvas = minimapRef.current; if (!canvas || !scrollContainerRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const scale = canvas.width / Math.max(totalContentWidth, 1);
      const viewportW = viewportSize.width;
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
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  };

  const handleTrackContextMenu = (e: React.MouseEvent, trackId: string) => {
    e.preventDefault();
    const menuItems: (ContextMenuItem | 'separator')[] = [ { label: 'Duplicate Track', onClick: () => onDuplicateTrack?.(trackId), icon: 'fa-copy' }, ];
    if (trackId !== 'track-rec-main') menuItems.push({ label: 'Delete Track', danger: true, onClick: () => onDeleteTrack?.(trackId), icon: 'fa-trash' });
    menuItems.push({ label: 'Freeze Track', onClick: () => onFreezeTrack?.(trackId), icon: 'fa-snowflake' });
    setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
  };
  
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    const rect = scrollContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
    const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
    const time = (x / zoomH);
    const useSnap = snapEnabled && !isShiftDownRef.current;

    if (e.clientY - rect.top < 40) {
        if (isLoopActive && loopEnd > loopStart) {
            const loopStartX = loopStart * zoomH;
            const loopEndX = loopEnd * zoomH;
            const hitZone = 10 * (zoomH / 40); // Scale hitzone with zoom

            if (Math.abs(x - loopStartX) < hitZone) { setLoopDragMode('START'); setInitialLoopState({ start: loopStart, end: loopEnd }); setDragStartX(x); return; }
            if (Math.abs(x - loopEndX) < hitZone) { setLoopDragMode('END'); setInitialLoopState({ start: loopStart, end: loopEnd }); setDragStartX(x); return; }
            if (x > loopStartX && x < loopEndX) { setLoopDragMode('BODY'); setInitialLoopState({ start: loopStart, end: loopEnd }); setDragStartX(x); return; }
        }
        onSeek(getSnappedTime(time, bpm, gridSize, useSnap));
        setDragAction('SCRUB');
        return;
    }
    
    let currentY = 40;
    for (const t of visibleTracks) {
        if (y >= currentY && y < currentY + zoomV) {
            const clip = t.clips.find(c => time >= c.start && time <= c.start + c.duration);
            if (clip) {
                if (e.button === 2) { e.preventDefault(); setClipContextMenu({ x: e.clientX, y: e.clientY, trackId: t.id, clip }); return; }
                setActiveClip({ trackId: t.id, clip });
                setDragStartX(x); setDragStartY(y);
                setInitialClipState({ ...clip });
                setDragAction('MOVE');
                onSelectTrack(t.id);
                return;
            }
        }
        currentY += zoomV + (t.automationLanes.filter(l => l.isExpanded).length * 80);
    }
    
    onSeek(getSnappedTime(time, bpm, gridSize, useSnap));
    setDragAction('SCRUB');
};

const handleMouseMove = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    const rect = scrollContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
    const useSnap = snapEnabled && !isShiftDownRef.current;
    
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
    
    const time = getSnappedTime(x / zoomH, bpm, gridSize, useSnap);
    if (dragAction === 'MOVE' && activeClip && initialClipState) {
        const dx = x - dragStartX;
        const dt = dx / zoomH;
        const newStart = Math.max(0, getSnappedTime(initialClipState.start + dt, bpm, gridSize, useSnap));
        if (newStart !== activeClip.clip.start) {
            onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', { start: newStart });
        }
    } else if (dragAction === 'SCRUB') {
        onSeek(time);
    }
};

const handleMouseUp = () => {
    setDragAction(null);
    setActiveClip(null);
    setLoopDragMode(null);
    setInitialLoopState(null);
    setInitialClipState(null);
};

  const handleMouseDown = (e: React.MouseEvent) => handlePointerDown(e.clientX, e.clientY, e.button, e.shiftKey, e.target, e.detail);
  const handleMouseMove = (e: React.MouseEvent) => handlePointerMove(e.clientX, e.clientY, e.shiftKey);
  const handleMouseUp = () => handlePointerUp();

  // FIX: Define missing style variables.
  const containerStyle = { backgroundColor: 'var(--bg-main)', color: 'var(--text-primary)', cursor: isResizingHeader ? 'col-resize' : 'default' };
  const headerStyle = { backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' };
  const sidebarStyle = { backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' };

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative select-none" style={containerStyle} onContextMenu={e => e.preventDefault()}>
      <div className="h-12 border-b flex items-center px-4 gap-4 z-30 shrink-0" style={headerStyle}>
        <div className="flex items-center space-x-4 shrink-0">
          <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5" style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}>
            <button onClick={() => setActiveTool('SELECT')} className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${activeTool === 'SELECT' ? 'bg-[#38bdf8] text-black' : 'text-slate-500 hover:text-white'}`} title="Smart Tool (1)"><i className="fas fa-mouse-pointer text-[10px]"></i></button>
            <button onClick={() => setActiveTool('SPLIT')} className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${activeTool === 'SPLIT' ? 'bg-[#38bdf8] text-black' : 'text-slate-500 hover:text-white'}`} title="Split Tool (2)"><i className="fas fa-cut text-[10px]"></i></button>
            <button onClick={() => setActiveTool('ERASE')} className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${activeTool === 'ERASE' ? 'bg-red-500 text-white' : 'text-slate-500 hover:text-white'}`} title="Erase Tool (3)"><i className="fas fa-eraser text-[10px]"></i></button>
          </div>
          <button onClick={() => setSnapEnabled(!snapEnabled)} className={`px-4 py-2 rounded-xl border transition-all text-[9px] font-black uppercase tracking-widest ${snapEnabled ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400' : 'bg-white/5 border-white/10 text-slate-500'}`} style={{ backgroundColor: snapEnabled ? 'var(--bg-item)' : 'transparent', borderColor: snapEnabled ? 'var(--accent-neon)' : 'var(--border-dim)', color: snapEnabled ? 'var(--accent-neon)' : 'var(--text-secondary)' }}>
            <i className="fas fa-magnet mr-2"></i> {snapEnabled ? 'Snap ON' : 'Snap OFF'}
          </button>
        </div>
        <div className="flex-1 h-full py-2 px-4 flex items-center min-w-0 justify-center">
            <div 
              className={`w-full h-full max-w-4xl bg-black/40 border border-white/10 rounded overflow-hidden relative group ${isDraggingMinimap ? 'cursor-grabbing' : 'cursor-grab'}`}
              onMouseDown={handleMinimapMouseDown}
            >
                 <canvas ref={minimapRef} className="w-full h-full block" />
            </div>
        </div>
        <div className="flex items-center space-x-3 shrink-0">
             <i className="fas fa-search-plus text-[10px]" style={{ color: 'var(--text-secondary)' }}></i>
             <input type="range" min="10" max="300" step="1" value={zoomH} onChange={(e) => setZoomH(parseInt(e.target.value))} className="w-24 accent-cyan-500 h-1 bg-white/5 rounded-full" />
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden relative">
        <div 
            ref={sidebarContainerRef} 
            onScroll={handleScroll} 
            onWheel={handleSidebarWheel}
            className="flex-shrink-0 border-r z-40 flex flex-col overflow-y-auto overflow-x-hidden transition-colors relative sidebar-no-scroll" 
            style={{ ...sidebarStyle, width: `${headerWidth}px`, scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          <div style={{ height: 40, flexShrink: 0 }} />
          {visibleTracks.map((track) => (
            <div key={track.id} style={{ flexShrink: 0, position: 'relative' }}>
              <div style={{ height: `${zoomV}px` }}>
                <TrackHeader 
                   track={track} isSelected={selectedTrackId === track.id} onSelect={() => onSelectTrack(track.id)} onUpdate={onUpdateTrack} 
                   onDropPlugin={onDropPluginOnTrack} onMovePlugin={onMovePlugin} onSelectPlugin={onSelectPlugin} onRemovePlugin={onRemovePlugin} onRequestAddPlugin={onRequestAddPlugin} 
                   onContextMenu={handleTrackContextMenu} onDragStartTrack={() => {}} onDragOverTrack={() => {}} onDropTrack={() => {}} onSwapInstrument={onSwapInstrument}
                />
              </div>
              {track.automationLanes.map(lane => lane.isExpanded && (
                   <div key={lane.id} style={{ height: '80px', position: 'relative' }}>
                     <AutomationLaneComponent trackId={track.id} lane={lane} width={0} zoomH={zoomH} scrollLeft={0} onUpdatePoints={() => {}} onRemoveLane={() => onUpdateTrack({ ...track, automationLanes: track.automationLanes.map(l => l.id === lane.id ? { ...l, isExpanded: false } : l) })} variant="header" />
                   </div>
              ))}
            </div>
          ))}
          <div style={{ height: 500 }} />
          <div className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-cyan-500/50 active:bg-cyan-500 z-50 flex items-center justify-center group" onMouseDown={handleHeaderResizeStart}><div className="w-0.5 h-8 bg-white/20 rounded-full group-hover:bg-white/50 pointer-events-none" /></div>
        </div>
        <div 
            ref={scrollContainerRef} 
            className="flex-1 overflow-auto relative custom-scroll scroll-smooth touch-pan-x touch-pan-y" 
            onMouseDown={handleMouseDown} 
            onMouseMove={handleMouseMove} 
            onMouseUp={handleMouseUp} 
            onMouseLeave={handleMouseUp} 
            onScroll={handleScroll}
            onDragOver={handleTimelineDragOver}
            onDrop={handleTimelineDrop}
            onContextMenu={(e) => e.preventDefault()}
        >
          <div style={{ width: totalContentWidth, height: totalArrangementHeight }} className="absolute top-0 left-0 pointer-events-none" />
          <canvas ref={canvasRef} className="sticky top-0 left-0" style={{ display: 'block' }} />
          {isRecording && recStartTime !== null && (
             visibleTracks.map((track, idx) => {
               if (!track.isTrackArmed) return null;
               let topY = 40; for (let i = 0; i < idx; i++) topY += zoomV + (visibleTracks[i].automationLanes.filter(l => l.isExpanded).length * 80);
               return <div key={`live-${track.id}`} style={{ position: 'absolute', top: `${topY + 2}px`, height: `${zoomV - 4}px`, left: 0, right: 0, pointerEvents: 'none' }}><LiveRecordingClip trackId={track.id} recStartTime={recStartTime} currentTime={currentTime} zoomH={zoomH} height={zoomV - 4} /></div>;
             })
          )}
        </div>
      </div>
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      {gridMenu && <TimelineGridMenu x={gridMenu.x} y={gridMenu.y} onClose={() => setGridMenu(null)} gridSize={gridSize} onSetGridSize={setGridSize} snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled(!snapEnabled)} onAddTrack={() => onAddTrack && onAddTrack(TrackType.AUDIO)} onResetZoom={() => { setZoomH(40); setZoomV(120); }} onPaste={() => {}} />}
      {hoverTime !== null && dragAction !== null && <div className="fixed z-[200] px-3 py-1.5 bg-black/90 border border-cyan-500/30 rounded-lg shadow-2xl pointer-events-none text-[10px] font-black text-cyan-400 font-mono" style={{ left: tooltipPos.x + 15, top: tooltipPos.y }}>{hoverTime.toFixed(3)}s {dragAction && <span className="ml-2 text-white opacity-50">[{dragAction}]</span>}</div>}
      {clipContextMenu && (
        <ContextMenu
            x={clipContextMenu.x} y={clipContextMenu.y} onClose={() => setClipContextMenu(null)}
            items={[
                { label: 'Couper', icon: 'fa-cut', shortcut: 'Ctrl+X', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'CUT'); setClipContextMenu(null); }},
                { label: 'Copier', icon: 'fa-copy', shortcut: 'Ctrl+C', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'COPY'); setClipContextMenu(null); }},
                { label: 'Coller', icon: 'fa-paste', shortcut: 'Ctrl+V', onClick: () => { onEditClip?.(clipContextMenu.trackId, '', 'PASTE', { time: currentTime }); setClipContextMenu(null); }},
                { label: 'separator' },
                { label: 'Dupliquer', icon: 'fa-clone', shortcut: 'Ctrl+D', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'DUPLICATE'); setClipContextMenu(null); }},
                { label: 'Diviser', icon: 'fa-scissors', shortcut: 'S', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'SPLIT', { time: currentTime }); setClipContextMenu(null); }},
                { label: 'separator' },
                { label: clipContextMenu.clip.isMuted ? 'Réactiver' : 'Muter', icon: clipContextMenu.clip.isMuted ? 'fa-volume-up' : 'fa-volume-mute', shortcut: 'M', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'MUTE'); setClipContextMenu(null); }},
                { label: clipContextMenu.clip.isReversed ? 'Annuler Reverse' : 'Inverser (Reverse)', icon: 'fa-backward', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'REVERSE'); setClipContextMenu(null); }},
                { label: 'separator' },
                { label: 'Gain +3 dB', icon: 'fa-plus', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'SET_GAIN', { gain: Math.min(2, (clipContextMenu.clip.gain || 1) * 1.41) }); setClipContextMenu(null); }},
                { label: 'Gain -3 dB', icon: 'fa-minus', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'SET_GAIN', { gain: Math.max(0.1, (clipContextMenu.clip.gain || 1) / 1.41) }); setClipContextMenu(null); }},
                { label: 'Normaliser', icon: 'fa-compress-arrows-alt', onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'NORMALIZE'); setClipContextMenu(null); }},
                { label: 'separator' },
                { label: 'Renommer...', icon: 'fa-i-cursor', shortcut: 'F2', onClick: () => { const newName = prompt('Nouveau nom:', clipContextMenu.clip.name); if (newName) onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'RENAME', { name: newName }); setClipContextMenu(null); }},
                { label: 'separator' },
                { label: 'Supprimer', icon: 'fa-trash', shortcut: 'Suppr', danger: true, onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'DELETE'); setClipContextMenu(null); }}
            ]}
        />
    )}
    </div>
  );
};
export default ArrangementView;