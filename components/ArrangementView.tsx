
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Track, TrackType, PluginType, PluginInstance, Clip, EditorTool, ContextMenuItem, AutomationLane, AutomationPoint, Marker } from '../types';
import TrackHeader from './TrackHeader';
import ContextMenu from './ContextMenu';
import TimelineGridMenu from './TimelineGridMenu'; 
import LiveRecordingClip from './LiveRecordingClip'; 
import AutomationLaneComponent from './AutomationLane';
import WaveformRenderer from './WaveformRenderer';

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
  // NEW: Markers support (inspired by Pro Tools/Reaper)
  markers?: Marker[];
  onAddMarker?: (time: number, name?: string) => void;
  onUpdateMarker?: (marker: Marker) => void;
  onDeleteMarker?: (markerId: string) => void;
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
  recStartTime: number | null;
  onCreatePattern?: (trackId: string, time: number) => void;
  onSwapInstrument?: (trackId: string) => void; 
  onEditMidi?: (trackId: string, clipId: string) => void;
  onAudioDrop?: (trackId: string, url: string, name: string, time: number) => void;
}

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
  markers = [], onAddMarker, onUpdateMarker, onDeleteMarker,
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
  const [markerContextMenu, setMarkerContextMenu] = useState<{ x: number; y: number; marker: Marker } | null>(null);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);

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

  const isSyncingScroll = useRef(false);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (isSyncingScroll.current) return;
    
    isSyncingScroll.current = true;
    if (target === scrollContainerRef.current) {
        setScrollLeft(target.scrollLeft);
        if (sidebarContainerRef.current) sidebarContainerRef.current.scrollTop = target.scrollTop;
    } else if (target === sidebarContainerRef.current) {
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = target.scrollTop;
    }
    
    requestAnimationFrame(() => { isSyncingScroll.current = false; });
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
      
      if (!scrollContainerRef.current) return;
      
      const rect = scrollContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
      const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
      const dropTime = x / zoomH;
      
      let targetTrackId: string | null = null;
      let currentY = 40;
      for (const t of visibleTracks) {
          if (y >= currentY && y < currentY + zoomV) {
              targetTrackId = t.id;
              break;
          }
          currentY += zoomV + (t.automationLanes.filter(l => l.isExpanded).length * 80);
      }
      
      if (!targetTrackId) {
          targetTrackId = visibleTracks.find(t => t.id === 'instrumental')?.id || 
                          visibleTracks.find(t => t.type === TrackType.AUDIO)?.id || 
                          null;
      }
      
      if (!targetTrackId) return;
      
      const audioUrl = e.dataTransfer.getData('audio-url');
      if (audioUrl && onAudioDrop) {
          const audioName = e.dataTransfer.getData('audio-name') || 'Imported Audio';
          onAudioDrop(targetTrackId, audioUrl, audioName, dropTime);
          return;
      }
      
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          if (file.type.startsWith('audio/') && onAudioDrop) {
              const blobUrl = URL.createObjectURL(file);
              onAudioDrop(targetTrackId, blobUrl, file.name, dropTime);
          }
      }
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

    if (isLoopActive && loopEnd > loopStart) {
        const loopX = (loopStart * zoomH) * scale;
        const loopW = ((loopEnd - loopStart) * zoomH) * scale;
        ctx.fillStyle = 'rgba(0, 242, 255, 0.3)';
        ctx.fillRect(loopX, 0, loopW, h);
        ctx.strokeStyle = '#00f2ff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(loopX, 0, loopW, h);
    }
    
    const phX = (currentTime * zoomH) * scale;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
    const viewportWidth = viewportSize.width;
    const vx = scrollLeft * scale;
    const vw = viewportWidth * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, vx, h); ctx.fillRect(vx + vw, 0, w - (vx + vw), h);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.strokeRect(vx, 0, vw, h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(vx, 0, vw, h);
  }, [visibleTracks, totalContentWidth, scrollLeft, viewportSize, zoomH, currentTime, isLoopActive, loopStart, loopEnd]);

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
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
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
            const hitZone = 20 * (zoomH / 40); // Scale hitzone with zoom (increased from 10 to 20 for better UX)

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
                if (e.button === 2) { e.preventDefault(); e.stopPropagation(); setClipContextMenu({ x: e.clientX, y: e.clientY, trackId: t.id, clip }); return; }
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
    
    if (e.button === 2) {
      e.preventDefault();
      setGridMenu({ x: e.clientX, y: e.clientY });
      return;
    }

    onSeek(getSnappedTime(time, bpm, gridSize, useSnap));
    setDragAction('SCRUB');
};

const handleMouseMove = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    const rect = scrollContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
    const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
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

        // Détecter la piste cible en fonction de la position Y
        let targetTrackId = activeClip.trackId;
        let currentY = 40;
        for (const t of visibleTracks) {
            const trackHeight = zoomV + (t.automationLanes.filter(l => l.isExpanded).length * 80);
            if (y >= currentY && y < currentY + trackHeight) {
                targetTrackId = t.id;
                break;
            }
            currentY += trackHeight;
        }

        // Si changement de piste, déplacer le clip vers la nouvelle piste
        if (targetTrackId !== activeClip.trackId) {
            onMoveClip?.(activeClip.trackId, targetTrackId, activeClip.clip.id);
            setActiveClip({ trackId: targetTrackId, clip: activeClip.clip });
        }

        // Mettre à jour la position temporelle
        if (newStart !== activeClip.clip.start) {
            onEditClip?.(targetTrackId, activeClip.clip.id, 'UPDATE_PROPS', { start: newStart });
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

const drawClip = (ctx: CanvasRenderingContext2D, clip: Clip, trackColor: string, x: number, y: number, w: number, h: number, isSelected: boolean) => {
    if (x + w < 0 || x > ctx.canvas.width) return;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.clip();

    ctx.fillStyle = clip.isMuted ? '#111' : '#1e2229';
    ctx.fill();
    ctx.fillStyle = (clip.color || trackColor) + (clip.isMuted ? '11' : '33');
    ctx.fill();

    ctx.strokeStyle = isSelected ? '#fff' : (clip.color || trackColor);
    ctx.lineWidth = isSelected ? 1.5 : 1;
    ctx.stroke();

    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px Inter';
    ctx.fillText(clip.name, x + 8, y + 14, w - 16);
};

const drawTimeline = useCallback(() => {
    const canvas = canvasRef.current;
    const scroll = scrollContainerRef.current;
    if (!canvas || !scroll) return;
    
    if (canvas.width !== viewportSize.width || canvas.height !== viewportSize.height) {
        canvas.width = viewportSize.width;
        canvas.height = viewportSize.height;
    }

    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const scrollX = scroll.scrollLeft;
    const scrollTop = scroll.scrollTop;
    
    ctx.clearRect(0, 0, w, h);
    
    const beatPx = (60 / bpm) * zoomH;
    const startTime = pixelsToTime(scrollX);
    const endTime = pixelsToTime(scrollX + w);
    const startBar = Math.floor(startTime * (bpm / 60) / 4);
    const endBar = Math.ceil(endTime * (bpm / 60) / 4);
    
    let subDivisionsPerBar = 4;
    if (gridSize === '1/1') subDivisionsPerBar = 1;
    else if (gridSize === '1/8') subDivisionsPerBar = 8;
    else if (gridSize === '1/16') subDivisionsPerBar = 16;
    const subStepPx = (4 * beatPx) / subDivisionsPerBar;

    ctx.lineWidth = 1;
    for (let i = startBar; i <= endBar; i++) {
        const time = i * 4 * (60 / bpm);
        const x = timeToPixels(time) - scrollX;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        
        if (subStepPx > 5 && subDivisionsPerBar > 1) {
            for (let j = 1; j < subDivisionsPerBar; j++) {
                const subX = x + j * subStepPx;
                if (j % (subDivisionsPerBar / 4) === 0) {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
                } else {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
                }
                ctx.beginPath(); ctx.moveTo(subX, 0); ctx.lineTo(subX, h); ctx.stroke();
            }
        }
    }

    if (isLoopActive && loopEnd > loopStart) {
        const loopStartX = timeToPixels(loopStart) - scrollX;
        const loopEndX = timeToPixels(loopEnd) - scrollX;
        const loopWidth = timeToPixels(loopEnd - loopStart);
        if (loopStartX + loopWidth > 0 && loopStartX < w) {
            // Zone de loop avec opacité augmentée
            ctx.fillStyle = 'rgba(0, 242, 255, 0.15)';
            ctx.fillRect(loopStartX, 40, loopWidth, h - 40);

            // Lignes verticales de début et fin de loop plus visibles
            ctx.strokeStyle = '#00f2ff';
            ctx.lineWidth = 3;

            // Ligne de début
            ctx.beginPath();
            ctx.moveTo(loopStartX, 40);
            ctx.lineTo(loopStartX, h);
            ctx.stroke();

            // Ligne de fin
            ctx.beginPath();
            ctx.moveTo(loopEndX, 40);
            ctx.lineTo(loopEndX, h);
            ctx.stroke();

            // Poignées en haut pour mieux visualiser les curseurs
            ctx.fillStyle = '#00f2ff';
            // Poignée début (triangle)
            ctx.beginPath();
            ctx.moveTo(loopStartX - 8, 40);
            ctx.lineTo(loopStartX + 8, 40);
            ctx.lineTo(loopStartX, 55);
            ctx.fill();

            // Poignée fin (triangle)
            ctx.beginPath();
            ctx.moveTo(loopEndX - 8, 40);
            ctx.lineTo(loopEndX + 8, 40);
            ctx.lineTo(loopEndX, 55);
            ctx.fill();
        }
    }
    
    ctx.save();
    ctx.translate(0, -scrollTop);

    let currentY = 40;
    visibleTracks.forEach((track) => {
        const trackH = zoomV;
        const totalAutomationHeight = track.automationLanes.filter(l => l.isExpanded).length * 80;

        if (currentY + trackH > scrollTop && currentY < scrollTop + h) {
            track.clips.forEach(clip => {
                const cx = timeToPixels(clip.start) - scrollX;
                const cw = timeToPixels(clip.duration);
                if (cx + cw > 0 && cx < w) {
                    drawClip(ctx, clip, track.color, cx, currentY + 2, cw, trackH - 4, activeClip?.clip.id === clip.id);
                }
            });
        }
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, currentY + trackH + totalAutomationHeight);
        ctx.lineTo(w + scrollX, currentY + trackH + totalAutomationHeight);
        ctx.stroke();

        currentY += trackH + totalAutomationHeight;
    });
    ctx.restore();

    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, w, 40);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(w, 40); ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 10px Inter';
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
                ctx.fillRect(markerX, 0, endX - markerX, 40);
                ctx.strokeStyle = marker.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(markerX, 0); ctx.lineTo(markerX, 40);
                ctx.moveTo(endX, 0); ctx.lineTo(endX, 40);
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
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px Inter';
            ctx.fillText(marker.name, markerX + 14, 10);
        }
    });

    const phX = timeToPixels(currentTime) - scrollX;
    if (phX >= 0 && phX <= w) {
      ctx.strokeStyle = isRecording ? '#ef4444' : '#00f2ff';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
      ctx.fillStyle = isRecording ? '#ef4444' : '#00f2ff';
      ctx.beginPath(); ctx.moveTo(phX-5, 0); ctx.lineTo(phX+5, 0); ctx.lineTo(phX, 10); ctx.fill();
    }
}, [visibleTracks, zoomV, zoomH, currentTime, isRecording, activeClip, isLoopActive, loopStart, loopEnd, bpm, viewportSize.width, viewportSize.height, gridSize, scrollLeft, onEditClip, onSelectTrack, markers]);

useEffect(() => {
    requestRef.current = requestAnimationFrame(drawTimeline);
    return () => cancelAnimationFrame(requestRef.current);
}, [drawTimeline]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative select-none" onContextMenu={e => e.preventDefault()}>
      <div className="h-12 flex items-center px-4 gap-4 z-30 shrink-0">
        <div className="flex items-center space-x-4 shrink-0">
          <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
            <button onClick={() => setActiveTool('SELECT')} className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${activeTool === 'SELECT' ? 'bg-[#38bdf8] text-black' : 'text-slate-500 hover:text-white'}`} title="Smart Tool (1)"><i className="fas fa-mouse-pointer text-[10px]"></i></button>
            <button onClick={() => setActiveTool('SPLIT')} className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${activeTool === 'SPLIT' ? 'bg-[#38bdf8] text-black' : 'text-slate-500 hover:text-white'}`} title="Split Tool (2)"><i className="fas fa-cut text-[10px]"></i></button>
            <button onClick={() => setActiveTool('ERASE')} className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${activeTool === 'ERASE' ? 'bg-red-500 text-white' : 'text-slate-500 hover:text-white'}`} title="Erase Tool (3)"><i className="fas fa-eraser text-[10px]"></i></button>
          </div>
          <button onClick={() => setSnapEnabled(!snapEnabled)} className={`px-4 py-2 rounded-xl border transition-all text-[9px] font-black uppercase tracking-widest ${snapEnabled ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400' : 'bg-white/5 border-white/10 text-slate-500'}`}>
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
             <i className="fas fa-search-plus text-[10px]"></i>
             <input type="range" min="10" max="300" step="1" value={zoomH} onChange={(e) => setZoomH(parseInt(e.target.value))} className="w-24 accent-cyan-500 h-1 bg-white/5 rounded-full" />
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden relative">
        <div 
            ref={sidebarContainerRef} 
            onScroll={handleScroll} 
            onWheel={handleSidebarWheel}
            className="flex-shrink-0 z-40 flex flex-col overflow-y-auto overflow-x-hidden transition-colors relative sidebar-no-scroll" 
            style={{ width: `${headerWidth}px`, scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          <style>{`.sidebar-no-scroll::-webkit-scrollbar { display: none; }`}</style>
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
            onDragOver={handleDragOver}
            onDrop={handleDrop}
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
      {gridMenu && <TimelineGridMenu x={gridMenu.x} y={gridMenu.y} onClose={() => setGridMenu(null)} gridSize={gridSize} onSetGridSize={setGridSize} snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled(!snapEnabled)} onAddTrack={() => onAddTrack && onAddTrack(TrackType.AUDIO)} onResetZoom={() => { setZoomH(40); setZoomV(120); }} onPaste={() => onEditClip?.(selectedTrackId || 'track-rec-main', '', 'PASTE', { time: currentTime })} />}
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
                { label: 'separator' },
                { label: 'Supprimer', icon: 'fa-trash', shortcut: 'Suppr', danger: true, onClick: () => { onEditClip?.(clipContextMenu.trackId, clipContextMenu.clip.id, 'DELETE'); setClipContextMenu(null); }}
            ]}
        />
    )}
    {/* Marker Context Menu (inspired by Pro Tools) */}
    {markerContextMenu && (
        <ContextMenu
            x={markerContextMenu.x} y={markerContextMenu.y} onClose={() => setMarkerContextMenu(null)}
            items={[
                { label: 'Go to Marker', icon: 'fa-crosshairs', onClick: () => { onSeek(markerContextMenu.marker.time); setMarkerContextMenu(null); }},
                { label: 'Rename', icon: 'fa-pen', onClick: () => { setEditingMarkerId(markerContextMenu.marker.id); setMarkerContextMenu(null); }},
                { label: 'Change Color', icon: 'fa-palette', onClick: () => { 
                    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899'];
                    const nextColor = colors[(colors.indexOf(markerContextMenu.marker.color) + 1) % colors.length];
                    onUpdateMarker?.({ ...markerContextMenu.marker, color: nextColor });
                    setMarkerContextMenu(null);
                }},
                { label: 'separator' },
                { label: 'Delete Marker', icon: 'fa-trash', danger: true, onClick: () => { onDeleteMarker?.(markerContextMenu.marker.id); setMarkerContextMenu(null); }}
            ]}
        />
    )}
    </div>
  );
};
export default ArrangementView;
