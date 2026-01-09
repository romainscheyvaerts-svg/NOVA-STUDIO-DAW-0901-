
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
  // FIX: Updated onAddTrack to match the signature in App.tsx
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
}

// Zones d'interaction intelligentes
type InteractionZone = 'BODY' | 'RESIZE_L' | 'RESIZE_R' | 'FADE_IN' | 'FADE_OUT' | 'GAIN' | 'NONE';
type DragAction = 'MOVE' | 'TRIM_START' | 'TRIM_END' | 'ADJUST_FADE_IN' | 'ADJUST_FADE_OUT' | 'ADJUST_GAIN' | 'SEEK' | 'SELECT_REGION' | 'MOVE_AUTOMATION' | 'SCRUB' | null;
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
  onCreatePattern, onSwapInstrument, onEditMidi
}) => {
  const [activeTool, setActiveTool] = useState<EditorTool>('SELECT');
  const [zoomV, setZoomV] = useState(120); 
  const [zoomH, setZoomH] = useState(40);  
  const [snapEnabled, setSnapEnabled] = useState(true);
  
  const [gridSize, setGridSize] = useState<string>('1/4');
  const [gridMenu, setGridMenu] = useState<{ x: number, y: number } | null>(null);

  const [dragAction, setDragAction] = useState<DragAction | null>(null);
  const [activeClip, setActiveClip] = useState<{trackId: string, clip: Clip} | null>(null);
  const [hoveredTrackId, setHoveredTrackId] = useState<string | null>(null);
  
  const [loopDragMode, setLoopDragMode] = useState<LoopDragMode>(null);
  const [initialLoopState, setInitialLoopState] = useState<{ start: number, end: number } | null>(null);

  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartY, setDragStartY] = useState(0);
  const [initialClipState, setInitialClipState] = useState<Clip | null>(null);
  const [lastScrubTime, setLastScrubTime] = useState<number>(0);
  const [lastScrubTimestamp, setLastScrubTimestamp] = useState<number>(0);

  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, items: (ContextMenuItem | 'separator')[] } | null>(null);

  const [headerWidth, setHeaderWidth] = useState(256);
  const [isResizingHeader, setIsResizingHeader] = useState(false);
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);

  const isShiftDownRef = useRef(false);
  
  // Refs pour la synchronisation du scroll
  const isSyncingLeft = useRef(false);
  const isSyncingRight = useRef(false);

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

  // --- SYNCHRONISATION DU SCROLL ---
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const scrollTop = target.scrollTop;
    const scrollLeftVal = target.scrollLeft;

    if (target === scrollContainerRef.current) {
        setScrollLeft(scrollLeftVal);
    }

    if (target === scrollContainerRef.current) {
        if (sidebarContainerRef.current) {
            if (isSyncingLeft.current) {
                isSyncingLeft.current = false;
                return;
            }
            isSyncingRight.current = true;
            sidebarContainerRef.current.scrollTop = scrollTop;
        }
    } else if (target === sidebarContainerRef.current) {
        if (scrollContainerRef.current) {
            if (isSyncingRight.current) {
                isSyncingRight.current = false;
                return;
            }
            isSyncingLeft.current = true;
            scrollContainerRef.current.scrollTop = scrollTop;
        }
    }
  };

  const handleSidebarWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollLeft += e.deltaX;
        }
    }
  };

  const visibleTracks = useMemo(() => {
    return tracks.filter(t => t.id === 'instrumental' || t.id === 'track-rec-main' || t.type === TrackType.AUDIO || t.type === TrackType.MIDI || t.type === TrackType.BUS || t.type === TrackType.SEND || t.type === TrackType.SAMPLER);
  }, [tracks]);

  const projectDuration = useMemo(() => {
      const maxClipEnd = Math.max(...tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 0);
      return Math.max(maxClipEnd + 30, 300); 
  }, [tracks]);

  const totalContentWidth = useMemo(() => {
    return projectDuration * zoomH;
  }, [projectDuration, zoomH]);

  const totalArrangementHeight = useMemo(() => {
    let h = 40 + 500; 
    visibleTracks.forEach(t => { 
        h += zoomV; 
        t.automationLanes.forEach(l => { if (l.isExpanded) h += 80; }); 
    });
    return h;
  }, [visibleTracks, zoomV]);

  const handleHeaderResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizingHeader(true);
      
      const startX = e.clientX;
      const startWidth = headerWidth;
      
      const onMove = (moveEvent: MouseEvent) => {
          const delta = moveEvent.clientX - startX;
          const newWidth = Math.max(150, Math.min(600, startWidth + delta));
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

  // --- HANDLE DROP ON TIMELINE (Catalog or File) ---
  const handleTimelineDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
  };

  const handleTimelineDrop = (e: React.DragEvent) => {
      e.preventDefault();
      
      // 1. Check for Internal Audio from Catalog
      const audioUrl = e.dataTransfer.getData('audio-url');
      if (audioUrl) {
          const audioName = e.dataTransfer.getData('audio-name');
          if ((window as any).DAW_CORE) {
              (window as any).DAW_CORE.handleAudioImport(audioUrl, audioName || 'Beat');
          }
          return;
      }

      // 2. Check for External Files
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          if (onImportFile) {
              onImportFile(e.dataTransfer.files[0]);
          }
      }
  };

  // --- PRO MINIMAP RENDERING ---
  useEffect(() => {
    const canvas = minimapRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#08090b';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#1e2229';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); 
    ctx.stroke();

    const scale = w / Math.max(totalContentWidth, 1);
    const trackHeight = h / Math.max(visibleTracks.length, 1);
    
    visibleTracks.forEach((t, tIdx) => {
        const y = tIdx * trackHeight;
        
        if (tIdx % 2 === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.02)';
            ctx.fillRect(0, y, w, trackHeight);
        }

        ctx.fillStyle = t.color; 
        ctx.globalAlpha = 0.4;
        
        t.clips.forEach(c => {
             const cx = (c.start * zoomH) * scale;
             const cw = (c.duration * zoomH) * scale;
             ctx.fillRect(cx, y + 1, Math.max(2, cw), Math.max(1, trackHeight - 2));
        });
        ctx.globalAlpha = 1.0;
    });

    const phX = (currentTime * zoomH) * scale;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath(); 
    ctx.moveTo(phX, 0); 
    ctx.lineTo(phX, h); 
    ctx.stroke();

    const viewportWidth = viewportSize.width;
    const vx = scrollLeft * scale;
    const vw = viewportWidth * scale;

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, vx, h);
    ctx.fillRect(vx + vw, 0, w - (vx + vw), h);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, 0, vw, h);
    
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(vx, 0, vw, h);

  }, [visibleTracks, totalContentWidth, scrollLeft, viewportSize, zoomH, currentTime]);

  // --- MINIMAP INTERACTION ---
  const handleMinimapMouseDown = (e: React.MouseEvent) => {
      const canvas = minimapRef.current;
      if (!canvas || !scrollContainerRef.current) return;
      
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      
      const scale = canvas.width / Math.max(totalContentWidth, 1);
      const viewportW = viewportSize.width;
      const vx = scrollLeft * scale;
      const vw = viewportW * scale;

      if (clickX >= vx && clickX <= vx + vw) {
          setIsDraggingMinimap(true);
          setDragStartX(clickX); 
      } else {
          const newScrollLeft = (clickX / scale) - (viewportW / 2);
          scrollContainerRef.current.scrollLeft = Math.max(0, newScrollLeft);
          setIsDraggingMinimap(true); 
          setDragStartX(clickX);
      }
      
      const onMove = (moveEvent: MouseEvent) => {
          const moveRect = canvas.getBoundingClientRect();
          const currentX = moveEvent.clientX - moveRect.left;
          const newScroll = (currentX / scale) - (viewportW / 2);
          if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollLeft = Math.max(0, newScroll);
          }
      };
      
      const onUp = () => {
          setIsDraggingMinimap(false);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  };

  const handleTrackContextMenu = (e: React.MouseEvent, trackId: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Duplicate Track', onClick: () => onDuplicateTrack?.(trackId), icon: 'fa-copy' },
        { label: 'Delete Track', danger: true, onClick: () => onDeleteTrack?.(trackId), icon: 'fa-trash' },
        { label: 'Freeze Track', onClick: () => onFreezeTrack?.(trackId), icon: 'fa-snowflake' }
      ]
    });
  };

  const handleClipContextMenu = (e: React.MouseEvent, trackId: string, clipId: string) => {
    e.preventDefault();
    const track = tracks.find(t => t.id === trackId);
    const clip = track?.clips.find(c => c.id === clipId);
    if (!clip || !track) return;
    
    const menuItems: (ContextMenuItem | 'separator')[] = [
        { label: 'Renommer', icon: 'fa-pen', shortcut: 'Ctrl+R', onClick: () => { const name = prompt("Nouveau nom :", clip.name); if(name) onEditClip?.(trackId, clipId, 'RENAME', { name }); } },
        { 
            label: 'Couleur', 
            icon: 'fa-palette', 
            onClick: () => {}, 
            component: (
                <div className="grid grid-cols-5 gap-1 p-1">
                    {['#ff0000', '#f97316', '#eab308', '#22c55e', '#00f2ff', '#3b82f6', '#a855f7', '#ec4899', '#ffffff', '#64748b'].map(color => (
                        <div 
                            key={color} 
                            onClick={(e) => {
                                e.stopPropagation();
                                onEditClip?.(trackId, clipId, 'UPDATE_PROPS', { color });
                                setContextMenu(null);
                            }}
                            className="w-4 h-4 rounded-sm cursor-pointer hover:scale-125 transition-transform border border-white/20"
                            style={{ backgroundColor: color }}
                        />
                    ))}
                </div>
            )
        },
        'separator',
        ...(track.type === TrackType.MIDI ? [
            { label: 'Quantifier', icon: 'fa-magnet', shortcut: 'Q', onClick: () => onEditClip?.(trackId, clipId, 'QUANTIZE') },
            { label: 'Transposer +1', icon: 'fa-arrow-up', onClick: () => onEditClip?.(trackId, clipId, 'TRANSPOSE', { amount: 1 }) },
            { label: 'Transposer -1', icon: 'fa-arrow-down', onClick: () => onEditClip?.(trackId, clipId, 'TRANSPOSE', { amount: -1 }) },
            { label: 'Transposer Octave', icon: 'fa-level-up-alt', onClick: () => onEditClip?.(trackId, clipId, 'TRANSPOSE', { amount: 12 }) },
            { label: 'Export MIDI', icon: 'fa-file-export', onClick: () => {
                const midiData = JSON.stringify(clip.notes);
                const blob = new Blob([midiData], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${clip.name}.mid.json`;
                a.click();
                URL.revokeObjectURL(url);
            } },
            'separator' as const
        ] : []),
        { label: 'Couper', icon: 'fa-cut', shortcut: 'Ctrl+X', onClick: () => onEditClip?.(trackId, clipId, 'CUT') },
        { label: 'Copier', icon: 'fa-copy', shortcut: 'Ctrl+C', onClick: () => onEditClip?.(trackId, clipId, 'COPY') },
        { label: 'Dupliquer', icon: 'fa-clone', shortcut: 'Ctrl+D', onClick: () => onEditClip?.(trackId, clipId, 'DUPLICATE') },
        'separator',
        { label: clip.isMuted ? 'Unmute Clip' : 'Mute Clip', icon: clip.isMuted ? 'fa-volume-up' : 'fa-volume-mute', onClick: () => onEditClip?.(trackId, clipId, 'MUTE') },
        { label: 'Scinder (Split)', icon: 'fa-cut', shortcut: 'Ctrl+E', onClick: () => onEditClip?.(trackId, clipId, 'SPLIT', { time: currentTime }) },
        { label: 'Consolider', icon: 'fa-link', shortcut: 'Ctrl+J', onClick: () => onEditClip?.(trackId, clipId, 'MERGE') },
        'separator',
        ...(track.type === TrackType.AUDIO ? [
             { label: 'Normaliser', icon: 'fa-wave-square', onClick: () => onEditClip?.(trackId, clipId, 'NORMALIZE') },
             { label: 'Renverser (Reverse)', icon: 'fa-history', onClick: () => onEditClip?.(trackId, clipId, 'REVERSE') },
             'separator' as const
        ] : []),
        { label: 'Supprimer', icon: 'fa-trash', danger: true, shortcut: 'Del', onClick: () => onEditClip?.(trackId, clipId, 'DELETE') },
    ];

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: menuItems
    });
  };

  const drawWaveform = (ctx: CanvasRenderingContext2D, buffer: AudioBuffer, x: number, y: number, w: number, h: number, color: string, startOffset: number) => {
    const data = buffer.getChannelData(0);
    const pixelWidth = w;
    const startSample = Math.floor(startOffset * buffer.sampleRate);
    
    const step = Math.max(1, Math.floor((w / zoomH) * buffer.sampleRate / pixelWidth));
    const amp = h / 2;
    const centerY = y + h / 2;

    ctx.beginPath();
    ctx.strokeStyle = color; 
    ctx.lineWidth = 1;

    for (let i = 0; i < pixelWidth; i++) {
        let min = 1.0;
        let max = -1.0;
        
        const chunkStart = startSample + Math.floor(i * step);
        const chunkEnd = startSample + Math.floor((i + 1) * step);
        const scanStep = Math.max(1, Math.floor((chunkEnd - chunkStart) / 10)); 

        if (chunkStart >= data.length) break;

        for (let j = chunkStart; j < chunkEnd && j < data.length; j += scanStep) {
            const val = data[j];
            if (val < min) min = val;
            if (val > max) max = val;
        }

        if (min > max) { min = 0; max = 0; }
        
        const yMin = centerY + min * amp;
        const yMax = centerY + max * amp;

        ctx.moveTo(x + i, yMin);
        ctx.lineTo(x + i, yMax);
    }
    ctx.stroke();
  };

  const drawClip = (ctx: CanvasRenderingContext2D, clip: Clip, trackColor: string, x: number, y: number, w: number, h: number, isSelected: boolean) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.clip(); 

    ctx.fillStyle = clip.isMuted ? '#111' : '#1e2229';
    ctx.fill();
    ctx.fillStyle = (clip.color || trackColor) + (clip.isMuted ? '05' : '15'); 
    ctx.fill();

    const displayColor = clip.isMuted ? '#555' : (clip.color || trackColor);

    if (clip.buffer) {
        const audioDuration = clip.buffer.duration;
        const pxPerSec = zoomH;
        const offset = clip.offset; 
        
        let currentX = x;
        let remainingWidth = w;
        
        const firstSegDuration = Math.min(clip.duration, audioDuration - offset);
        const firstSegWidth = firstSegDuration * pxPerSec;
        
        drawWaveform(ctx, clip.buffer, currentX, y + 2, firstSegWidth, h - 4, displayColor, offset);
        
        currentX += firstSegWidth;
        remainingWidth -= firstSegWidth;

        while (remainingWidth > 1) { 
            ctx.beginPath();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]); 
            ctx.moveTo(currentX, y);
            ctx.lineTo(currentX, y + h);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.fillStyle = '#fff';
            ctx.beginPath(); 
            ctx.moveTo(currentX - 4, y + h); 
            ctx.lineTo(currentX + 4, y + h); 
            ctx.lineTo(currentX, y + h - 6); 
            ctx.fill();

            const segDur = Math.min(pixelsToTime(remainingWidth), audioDuration);
            const segWidth = segDur * pxPerSec;
            
            drawWaveform(ctx, clip.buffer, currentX, y + 2, segWidth, h - 4, displayColor, 0);
            
            currentX += segWidth;
            remainingWidth -= segWidth;
        }
    } else if (clip.type === TrackType.MIDI) {
        if (clip.notes) {
            const pxPerSec = zoomH;
            clip.notes.forEach(note => {
                const nx = x + note.start * pxPerSec;
                const nw = note.duration * pxPerSec;
                const relPitch = Math.max(0, Math.min(1, (note.pitch - 36) / 60));
                const ny = y + h - (relPitch * h);
                
                if (nx + nw > x && nx < x + w) {
                    ctx.fillStyle = isSelected ? '#fff' : (clip.isMuted ? '#555' : (clip.color || trackColor));
                    ctx.fillRect(Math.max(x, nx), ny - 2, Math.min(w - (nx - x), nw), 4);
                }
            });
        } else {
             ctx.fillStyle = 'rgba(255,255,255,0.05)';
             ctx.fillRect(x, y, w, h);
             ctx.fillStyle = displayColor;
             ctx.font = '10px Inter';
             ctx.fillText("Empty Pattern", x + 10, y + h/2);
        }
    }

    ctx.strokeStyle = isSelected ? '#ffffff' : (displayColor + '44');
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(x, y, w, h);

    if (clip.type === TrackType.AUDIO) {
        const fadeInPx = timeToPixels(clip.fadeIn);
        const fadeOutPx = timeToPixels(clip.fadeOut);
        
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ffffff';
        
        if (fadeInPx > 0) {
            ctx.beginPath();
            ctx.moveTo(x, y); 
            ctx.lineTo(x, y + h);
            ctx.bezierCurveTo(x + fadeInPx * 0.5, y + h, x + fadeInPx * 0.5, y, x + fadeInPx, y);
            ctx.fill();
        }

        if (fadeOutPx > 0) {
            ctx.beginPath();
            ctx.moveTo(x + w, y); 
            ctx.lineTo(x + w, y + h); 
            ctx.bezierCurveTo(x + w - fadeOutPx * 0.5, y + h, x + w - fadeOutPx * 0.5, y, x + w - fadeOutPx, y);
            ctx.fill();
        }
    }

    ctx.restore(); 
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px Inter';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 4;
    ctx.fillText(clip.name, x + 6, y + 14);
    ctx.shadowBlur = 0;
  };

  const drawTimeline = useCallback(() => {
    const canvas = canvasRef.current;
    const scroll = scrollContainerRef.current;
    if (!canvas || !scroll) return;
    
    if (canvas.width !== viewportSize.width || canvas.height !== viewportSize.height) {
        canvas.width = viewportSize.width;
        canvas.height = viewportSize.height;
    }

    const ctx = canvas.getContext('2d', { alpha: false })!;
    const w = canvas.width;
    const h = canvas.height;
    const scrollX = scroll.scrollLeft;
    const scrollTop = scroll.scrollTop;

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const BG_COLOR = isLight ? '#334155' : '#0c0d10';
    const GRID_MAIN = isLight ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.08)';
    const GRID_SUB = isLight ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.03)';

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 1;
    const beatPx = (60 / bpm) * zoomH;
    const startTime = pixelsToTime(scrollX);
    const endTime = pixelsToTime(scrollX + w);
    const startBar = Math.floor(startTime * (bpm / 60) / 4);
    const endBar = Math.ceil(endTime * (bpm / 60) / 4);

    for (let i = startBar; i <= endBar; i++) {
      const time = i * 4 * (60 / bpm);
      const x = timeToPixels(time) - scrollX; 
      
      ctx.strokeStyle = GRID_MAIN;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      
      let subDivs = gridSize === '1/8' ? 8 : (gridSize === '1/16' ? 16 : 4);
      const subStep = (4 * beatPx) / subDivs;

      ctx.strokeStyle = GRID_SUB;
      for(let j=1; j<subDivs; j++) {
         const bx = x + j * subStep;
         ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, h); ctx.stroke();
      }
    }

    if (isLoopActive && loopEnd > loopStart) {
        const lx = timeToPixels(loopStart) - scrollX;
        const lw = timeToPixels(loopEnd - loopStart);
        if (lx + lw > 0 && lx < w) {
            ctx.fillStyle = 'rgba(234, 179, 8, 0.1)';
            ctx.fillRect(lx, 40, lw, h - 40); 
            ctx.strokeStyle = '#eab308';
            ctx.setLineDash([5, 5]);
            ctx.beginPath(); ctx.moveTo(lx, 40); ctx.lineTo(lx, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(lx + lw, 40); ctx.lineTo(lx + lw, h); ctx.stroke();
            ctx.setLineDash([]);
        }
        if (lx < w && lx + lw > 0) {
            ctx.fillStyle = 'rgba(234, 179, 8, 0.3)';
            ctx.fillRect(Math.max(0, lx), 0, Math.min(w, lx + lw) - Math.max(0, lx), 40);
            ctx.strokeStyle = '#eab308'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, 40); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(lx + lw, 0); ctx.lineTo(lx + lw, 40); ctx.stroke();
        }
    }

    ctx.save();
    ctx.translate(0, -scrollTop);

    let currentY = 40; 
    
    visibleTracks.forEach((track) => {
      const trackH = zoomV;
      
      if (currentY + trackH > scrollTop && currentY < scrollTop + h) {
          if (hoveredTrackId === track.id && dragAction === 'MOVE') {
             ctx.fillStyle = 'rgba(0, 242, 255, 0.05)';
             ctx.fillRect(0, currentY, w, trackH);
          }

          ctx.strokeStyle = isLight ? '#475569' : '#1e2229';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, currentY + trackH); ctx.lineTo(w, currentY + trackH); ctx.stroke();

          track.clips.forEach(clip => {
            if (activeClip?.clip.id === clip.id && dragAction === 'MOVE') return;

            const x = timeToPixels(clip.start) - scrollX;
            const width = timeToPixels(clip.duration);
            
            if (x + width > 0 && x < w) {
                drawClip(ctx, clip, track.color, x, currentY + 2, width, trackH - 4, activeClip?.clip.id === clip.id);
            }
          });
      }
      currentY += trackH;
      track.automationLanes.forEach(l => { if (l.isExpanded) currentY += 80; });
    });
    ctx.restore();

    if (dragAction === 'MOVE' && activeClip && initialClipState && hoveredTrackId) {
        const mouseTimeAtStart = pixelsToTime(dragStartX);
        const relativeOffset = mouseTimeAtStart - initialClipState.start;
        const rawNewStart = hoverTime! - relativeOffset;
        const useSnap = snapEnabled && !isShiftDownRef.current;
        const newStartTime = Math.max(0, getSnappedTime(rawNewStart, bpm, gridSize, useSnap));

        let ghostY = 40;
        let targetTrack: Track | undefined;
        for (const t of visibleTracks) {
            if (t.id === hoveredTrackId) {
                targetTrack = t;
                break;
            }
            ghostY += zoomV + (t.automationLanes.filter(l=>l.isExpanded).length * 80);
        }
        
        let isCompatible = false;
        if (targetTrack) {
            if (activeClip.clip.type === TrackType.MIDI) {
                 isCompatible = (targetTrack.type === TrackType.MIDI || targetTrack.type === TrackType.SAMPLER);
            } else if (activeClip.clip.type === TrackType.AUDIO) {
                 isCompatible = (targetTrack.type === TrackType.AUDIO);
            }
        }
        if (activeClip.trackId === hoveredTrackId) isCompatible = true;
        
        ctx.save();
        ctx.globalAlpha = 0.5;
        const gx = timeToPixels(newStartTime) - scrollX;
        const gw = timeToPixels(initialClipState.duration);
        const ghostColor = isCompatible ? '#fff' : '#ef4444';
        
        drawClip(ctx, initialClipState, ghostColor, gx, ghostY + 2 - scrollTop, gw, zoomV - 4, true);
        ctx.restore();
    }

    ctx.strokeStyle = isLight ? '#475569' : '#1e2229';
    ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(w, 40); ctx.stroke();

    ctx.fillStyle = isLight ? '#64748b' : '#94a3b8';
    ctx.font = 'bold 10px Inter';
    for (let i = Math.floor(startTime * (bpm / 60) / 4); i <= endBar; i++) {
        const time = i * 4 * (60 / bpm);
        const x = timeToPixels(time) - scrollX;
        if (x >= 0) ctx.fillText((i+1).toString(), x + 4, 24);
    }

    const phX = timeToPixels(currentTime) - scrollX;
    if (phX >= 0 && phX <= w) {
      const phColor = isRecording ? '#ef4444' : '#00f2ff';
      ctx.strokeStyle = phColor;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
      ctx.fillStyle = phColor;
      ctx.beginPath(); ctx.moveTo(phX-5, 0); ctx.lineTo(phX+5, 0); ctx.lineTo(phX, 10); ctx.fill();
    }

    requestRef.current = requestAnimationFrame(drawTimeline);
  }, [visibleTracks, zoomV, zoomH, currentTime, isRecording, activeClip, isLoopActive, loopStart, loopEnd, bpm, viewportSize, hoveredTrackId, dragAction, hoverTime, dragStartX, gridSize, snapEnabled]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(drawTimeline);
    return () => cancelAnimationFrame(requestRef.current);
  }, [drawTimeline]);

  const getInteractionZone = (absX: number, relY: number, clip: Clip, clipHeight: number): InteractionZone => {
    const clipStartPx = timeToPixels(clip.start);
    const localX = absX - clipStartPx;
    const w = timeToPixels(clip.duration);
    
    const CORNER_SIZE = 15;
    const EDGE_SIZE = 10;
    const GAIN_BAR_HEIGHT = 15;
    
    if (relY < 20) {
        if (localX < CORNER_SIZE) return 'FADE_IN';
        if (localX > w - CORNER_SIZE) return 'FADE_OUT';
        if (localX > CORNER_SIZE && localX < w - CORNER_SIZE && relY < GAIN_BAR_HEIGHT) return 'GAIN';
    }

    if (relY > 20) { 
        if (localX < EDGE_SIZE) return 'RESIZE_L';
        if (localX > w - EDGE_SIZE) return 'RESIZE_R';
    }

    return 'BODY';
  };

  const getCursorStyle = (zone: InteractionZone): string => {
    switch (zone) {
      case 'RESIZE_L': return 'col-resize';
      case 'RESIZE_R': return 'col-resize';
      case 'GAIN': return 'ns-resize';
      case 'FADE_IN': case 'FADE_OUT': return 'pointer'; 
      case 'BODY': return activeTool === 'SPLIT' ? 'cell' : 'move';
      default: return 'default';
    }
  };

  const handlePointerDown = (clientX: number, clientY: number, button: number, shiftKey: boolean, target: EventTarget | null, detail: number = 1) => {
    if (!scrollContainerRef.current) return;
    if (target instanceof Element && target.closest('.automation-lane-container')) return;
    if (target === minimapRef.current) return;

    const rect = scrollContainerRef.current.getBoundingClientRect();
    const scrollLeft = scrollContainerRef.current.scrollLeft;
    const scrollTop = scrollContainerRef.current.scrollTop;
    
    const viewportX = clientX - rect.left;
    const viewportY = clientY - rect.top;
    const absX = viewportX + scrollLeft;
    const absY = viewportY + scrollTop;
    const time = pixelsToTime(absX);

    // --- HEADER INTERACTION ---
    if (viewportY < 40) {
      if (button === 0) {
         if (isLoopActive) {
             const startPx = timeToPixels(loopStart) - scrollLeft;
             const endPx = timeToPixels(loopEnd) - scrollLeft;
             if (Math.abs(viewportX - startPx) < 15) { setLoopDragMode('START'); setDragStartX(absX); return; }
             if (Math.abs(viewportX - endPx) < 15) { setLoopDragMode('END'); setDragStartX(absX); return; }
             if (viewportX > startPx + 15 && viewportX < endPx - 15) { setLoopDragMode('BODY'); setDragStartX(absX); setInitialLoopState({ start: loopStart, end: loopEnd }); return; }
         }
         setDragAction('SCRUB');
         setLastScrubTime(time);
         setLastScrubTimestamp(Date.now());
         onSeek(getSnappedTime(time, bpm, gridSize, snapEnabled && !shiftKey));
      }
      return;
    }

    // --- CLIP INTERACTION ---
    let currentY = 40;
    
    for (const t of visibleTracks) {
      if (absY >= currentY && absY < currentY + zoomV) {
        const clip = t.clips.find(c => time >= c.start && time <= c.start + c.duration);
        if (clip) {
          if (detail === 2 && t.type === TrackType.MIDI && onEditMidi) {
              onEditMidi(t.id, clip.id);
              return;
          }

          if (button === 2) { handleClipContextMenu({ clientX, clientY } as any, t.id, clip.id); return; }
          
          const clipStartPx = timeToPixels(clip.start);
          const clickRelY = absY - currentY;
          const zone = getInteractionZone(absX, clickRelY, clip, zoomV);

          setDragStartX(absX);
          setDragStartY(absY);
          setInitialClipState({...clip}); 
          setActiveClip({ trackId: t.id, clip });
          onSelectTrack(t.id);

          if (activeTool === 'SPLIT') {
             const useSnap = snapEnabled && !shiftKey;
             onEditClip?.(t.id, clip.id, 'SPLIT', { time: getSnappedTime(time, bpm, gridSize, useSnap) });
             setDragAction(null);
          } else if (activeTool === 'ERASE') {
             onEditClip?.(t.id, clip.id, 'DELETE');
             setDragAction(null);
          } else {
             if (zone === 'RESIZE_L') setDragAction('TRIM_START');
             else if (zone === 'RESIZE_R') setDragAction('TRIM_END');
             else if (zone === 'FADE_IN') setDragAction('ADJUST_FADE_IN');
             else if (zone === 'FADE_OUT') setDragAction('ADJUST_FADE_OUT');
             else if (zone === 'GAIN') setDragAction('ADJUST_GAIN');
             else setDragAction('MOVE');
          }
          return; 
        } else {
             if (button === 2 && (t.type === TrackType.MIDI || t.type === TrackType.SAMPLER)) {
                 const snapTime = getSnappedTime(time, bpm, gridSize, true); 
                 setContextMenu({
                     x: clientX,
                     y: clientY,
                     items: [
                         { 
                             label: 'Ajouter Pattern MIDI', 
                             icon: 'fa-plus-square', 
                             onClick: () => {
                                 if (onCreatePattern) {
                                    onCreatePattern(t.id, snapTime);
                                 }
                             }
                         },
                         { label: 'Paste', onClick: () => { if((window as any).clipClipboard) onEditClip?.(t.id, 'paste', 'PASTE'); }, icon: 'fa-paste', disabled: !(window as any).clipClipboard }
                     ]
                 });
                 return;
             }
        }
      }
      currentY += zoomV;
      t.automationLanes.forEach(l => { if (l.isExpanded) currentY += 80; });
    }

    if (button === 0) {
      setActiveClip(null);
      setDragAction('SCRUB');
      setLastScrubTime(time);
      setLastScrubTimestamp(Date.now());
      onSeek(getSnappedTime(time, bpm, gridSize, snapEnabled && !shiftKey));
    } 
    else if (button === 2) {
      setGridMenu({ x: clientX, y: clientY });
    }
  };

  const handlePointerMove = (clientX: number, clientY: number, shiftKey: boolean) => {
    if (!scrollContainerRef.current) return;
    const rect = scrollContainerRef.current.getBoundingClientRect();
    const scrollLeft = scrollContainerRef.current.scrollLeft;
    const scrollTop = scrollContainerRef.current.scrollTop;
    
    const viewportX = clientX - rect.left;
    const viewportY = clientY - rect.top;
    const absX = viewportX + scrollLeft;
    const absY = viewportY + scrollTop;

    const currentTimeAtMouse = pixelsToTime(absX);
    setHoverTime(currentTimeAtMouse);
    setTooltipPos({ x: clientX, y: clientY - 30 });

    let currentY = 40;
    let foundTrackId = null;
    for (const t of visibleTracks) {
        if (absY >= currentY && absY < currentY + zoomV) {
            foundTrackId = t.id;
            break;
        }
        currentY += zoomV;
        t.automationLanes.forEach(l => { if (l.isExpanded) currentY += 80; });
    }
    setHoveredTrackId(foundTrackId);

    const useSnap = snapEnabled && !shiftKey;

    if (loopDragMode) {
        document.body.style.cursor = loopDragMode === 'BODY' ? 'grabbing' : 'ew-resize';
        const rawTime = pixelsToTime(absX);
        const snappedMouseTime = getSnappedTime(rawTime, bpm, gridSize, useSnap);
        if (loopDragMode === 'START') onSetLoop(Math.min(Math.max(0, snappedMouseTime), loopEnd - 0.1), loopEnd);
        else if (loopDragMode === 'END') onSetLoop(loopStart, Math.max(snappedMouseTime, loopStart + 0.1));
        else if (loopDragMode === 'BODY' && initialLoopState) {
            const mouseDeltaTime = pixelsToTime(absX - dragStartX);
            let newStart = initialLoopState.start + mouseDeltaTime;
            if (useSnap) newStart = getSnappedTime(newStart, bpm, gridSize, true);
            const duration = initialLoopState.end - initialLoopState.start;
            onSetLoop(Math.max(0, newStart), Math.max(0, newStart) + duration);
        }
        return;
    }

    if (activeClip && initialClipState && dragAction) {
       const deltaPx = absX - dragStartX;
       const deltaTime = pixelsToTime(deltaPx);
       const { trackId, clip } = activeClip;
       
       let newStart, newDuration, newOffset, newFadeIn, newFadeOut, newGain;

       switch (dragAction) {
          case 'MOVE':
             document.body.style.cursor = 'grabbing';
             break;
          case 'TRIM_START':
             const rawNewStart = getSnappedTime(initialClipState.start + deltaTime, bpm, gridSize, useSnap);
             const maxStart = initialClipState.start + initialClipState.duration - 0.1;
             newStart = Math.min(Math.max(0, rawNewStart), maxStart);
             const diff = newStart - initialClipState.start;
             newDuration = initialClipState.duration - diff;
             newOffset = initialClipState.offset + diff;
             if (newOffset < 0) { newOffset = 0; newDuration = initialClipState.duration + initialClipState.offset; newStart = initialClipState.start - initialClipState.offset; }
             onEditClip?.(trackId, clip.id, 'UPDATE_PROPS', { start: newStart, duration: newDuration, offset: newOffset });
             break;
          case 'TRIM_END':
             const proposedEnd = initialClipState.start + initialClipState.duration + deltaTime;
             const snappedEnd = getSnappedTime(proposedEnd, bpm, gridSize, useSnap);
             newDuration = Math.max(0.1, snappedEnd - initialClipState.start);
             onEditClip?.(trackId, clip.id, 'UPDATE_PROPS', { duration: newDuration });
             break;
          case 'ADJUST_GAIN':
             const deltaY = dragStartY - absY;
             const gainChange = deltaY * 0.01;
             newGain = Math.max(0, Math.min(2.0, (initialClipState.gain || 1.0) + gainChange));
             onEditClip?.(trackId, clip.id, 'UPDATE_PROPS', { gain: newGain });
             break;
       }
    } 
    else if (dragAction === 'SCRUB') {
       onSeek(currentTimeAtMouse);
    } 
    else {
         let cursorSet = false;
        let cy = 40;
        if (viewportY < 40 && isLoopActive) { /* Loop Cursor Logic */ }
        if (!cursorSet) {
            for (const t of visibleTracks) {
                if (absY >= cy && absY < cy + zoomV) {
                    const clip = t.clips.find(c => currentTimeAtMouse >= c.start && currentTimeAtMouse <= c.start + c.duration);
                    if (clip) {
                        const zone = getInteractionZone(absX, absY - cy, clip, zoomV);
                        document.body.style.cursor = activeTool === 'SPLIT' ? 'cell' : getCursorStyle(zone);
                        cursorSet = true;
                    }
                }
                cy += zoomV + (t.automationLanes.filter(l => l.isExpanded).length * 80);
            }
        }
        if (!cursorSet) document.body.style.cursor = 'default';
    }
  };

  const handlePointerUp = () => {
    if (dragAction === 'MOVE' && activeClip && initialClipState && hoveredTrackId) {
        const targetTrack = tracks.find(t => t.id === hoveredTrackId);
        let isCompatible = false;
        
        if (targetTrack) {
            if (activeClip.clip.type === TrackType.MIDI) {
                 isCompatible = (targetTrack.type === TrackType.MIDI || targetTrack.type === TrackType.SAMPLER);
            } else if (activeClip.clip.type === TrackType.AUDIO) {
                 isCompatible = (targetTrack.type === TrackType.AUDIO);
            }
        }
        if (activeClip.trackId === hoveredTrackId) isCompatible = true;

        if (isCompatible) {
            const mouseTimeAtStart = pixelsToTime(dragStartX);
            const relativeOffset = mouseTimeAtStart - initialClipState.start;
            const rawNewStart = hoverTime! - relativeOffset;
            const useSnap = snapEnabled && !isShiftDownRef.current;
            const newStartTime = Math.max(0, getSnappedTime(rawNewStart, bpm, gridSize, useSnap));

            if (activeClip.trackId !== hoveredTrackId) {
                onMoveClip?.(activeClip.trackId, hoveredTrackId, activeClip.clip.id);
                setTimeout(() => {
                    onEditClip?.(hoveredTrackId, activeClip.clip.id, 'UPDATE_PROPS', { start: newStartTime });
                }, 50);
            } else {
                onEditClip?.(activeClip.trackId, activeClip.clip.id, 'UPDATE_PROPS', { start: newStartTime });
            }
        }
    }

    setLoopDragMode(null);
    setInitialLoopState(null);
    setDragAction(null);
    setInitialClipState(null);
    document.body.style.cursor = 'default';
  };

  const handleMouseDown = (e: React.MouseEvent) => handlePointerDown(e.clientX, e.clientY, e.button, e.shiftKey, e.target, e.detail);
  const handleMouseMove = (e: React.MouseEvent) => handlePointerMove(e.clientX, e.clientY, e.shiftKey);
  const handleMouseUp = () => handlePointerUp();

  const containerStyle = { backgroundColor: 'var(--bg-main)', color: 'var(--text-primary)', cursor: isResizingHeader ? 'col-resize' : 'default' };
  const headerStyle = { backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' };
  const sidebarStyle = { backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' };

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative select-none" style={containerStyle} onContextMenu={(e) => e.preventDefault()}>
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
            style={{ 
                ...sidebarStyle, 
                width: `${headerWidth}px`,
                scrollbarWidth: 'none', 
                msOverflowStyle: 'none'
            }}
        >
          <style>{`
                div.sidebar-no-scroll::-webkit-scrollbar {
                    display: none;
                }
          `}</style>
          
          <div style={{ height: 40, flexShrink: 0 }} />

          {visibleTracks.map((track) => (
            <div key={track.id} style={{ flexShrink: 0, position: 'relative' }}>
              <div style={{ height: `${zoomV}px` }}>
                <TrackHeader 
                   track={track} 
                   isSelected={selectedTrackId === track.id} 
                   onSelect={() => onSelectTrack(track.id)} 
                   onUpdate={onUpdateTrack} 
                   onDropPlugin={onDropPluginOnTrack} 
                   onMovePlugin={onMovePlugin} 
                   onSelectPlugin={onSelectPlugin} 
                   onRemovePlugin={onRemovePlugin} 
                   onRequestAddPlugin={onRequestAddPlugin} 
                   onContextMenu={handleTrackContextMenu} 
                   onDragStartTrack={() => {}} 
                   onDragOverTrack={() => {}} 
                   onDropTrack={() => {}}
                   onSwapInstrument={onSwapInstrument}
                />
              </div>
              {track.automationLanes.map(lane => {
                 if (!lane.isExpanded) return null;
                 return (
                   <div key={lane.id} style={{ height: '80px', position: 'relative' }}>
                     <AutomationLaneComponent trackId={track.id} lane={lane} width={0} zoomH={zoomH} scrollLeft={0} onUpdatePoints={() => {}} onRemoveLane={() => { const newLanes = track.automationLanes.map(l => l.id === lane.id ? { ...l, isExpanded: false } : l); onUpdateTrack({ ...track, automationLanes: newLanes }); }} variant="header" />
                   </div>
                 );
              })}
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
      
      {gridMenu && (
        <TimelineGridMenu x={gridMenu.x} y={gridMenu.y} onClose={() => setGridMenu(null)} gridSize={gridSize} onSetGridSize={setGridSize} snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled(!snapEnabled)} onAddTrack={() => onAddTrack && onAddTrack(TrackType.AUDIO)} onResetZoom={() => { setZoomH(40); setZoomV(120); }} onPaste={() => {}} />
      )}

      {hoverTime !== null && dragAction !== null && (
        <div className="fixed z-[200] px-3 py-1.5 bg-black/90 border border-cyan-500/30 rounded-lg shadow-2xl pointer-events-none text-[10px] font-black text-cyan-400 font-mono" style={{ left: tooltipPos.x + 15, top: tooltipPos.y }}>
           {hoverTime.toFixed(3)}s {dragAction && <span className="ml-2 text-white opacity-50">[{dragAction}]</span>}
        </div>
      )}
    </div>
  );
};
export default ArrangementView;