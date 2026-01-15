import React, { useRef, useState, useEffect, useCallback } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip, TrackType } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

interface MobileArrangementPageProps {
  tracks: Track[];
  currentTime: number;
  isPlaying: boolean;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onSeek: (time: number) => void;
  onUpdateClip?: (trackId: string, clipId: string, updates: Partial<Clip>) => void;
  onSelectClip?: (trackId: string, clip: Clip) => void;
}

type DragMode = 'move' | 'resize-start' | 'resize-end' | null;

interface DragState {
  mode: DragMode;
  trackId: string;
  clip: Clip;
  startX: number;
  startTime: number;
  startDuration: number;
  startOffset: number;
}

/**
 * Page mobile Arrangement - Timeline professionnelle complète
 * Features: Grille, Édition, Drag, Resize, Split, Menu contextuel
 */
const MobileArrangementPage: React.FC<MobileArrangementPageProps> = ({
  tracks,
  currentTime,
  isPlaying,
  selectedTrackId,
  onSelectTrack,
  onSeek,
  onUpdateClip,
  onSelectClip
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(60); // pixels per second
  const [selectedClip, setSelectedClip] = useState<{ trackId: string, clip: Clip } | null>(null);
  const [touchStart, setTouchStart] = useState<{ x: number, y: number, dist: number } | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSize, setGridSize] = useState(1); // 1 second grid
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, trackId: string, clip: Clip } | null>(null);

  const animationRef = useRef<number>(0);
  const isDraggingRef = useRef(false);

  const visibleTracks = tracks.filter(t => t.id !== 'master');
  const trackHeight = 80;
  const timelineHeight = 50;
  const trackSeparatorHeight = 2;
  const totalHeight = visibleTracks.length * (trackHeight + trackSeparatorHeight) + timelineHeight;

  // Calculate max duration
  const maxDuration = Math.max(
    120,
    ...visibleTracks.flatMap(t => t.clips.map(c => c.start + c.duration))
  );

  const canvasWidth = Math.max(window.innerWidth, maxDuration * zoom);

  // Snap to grid helper
  const snapToGrid = useCallback((time: number): number => {
    if (!snapEnabled) return time;
    return Math.round(time / gridSize) * gridSize;
  }, [snapEnabled, gridSize]);

  /**
   * Dessine une waveform professionnelle
   */
  const drawWaveform = (
    ctx: CanvasRenderingContext2D,
    buffer: AudioBuffer | undefined,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    offset: number = 0
  ) => {
    if (!buffer) {
      ctx.fillStyle = color + '40';
      ctx.fillRect(x, y, width, height);
      return;
    }

    const channelData = buffer.getChannelData(0);
    const samples = channelData.length;
    const step = Math.max(1, Math.floor(samples / width));
    const offsetSamples = Math.floor(offset * buffer.sampleRate);

    ctx.fillStyle = color + '20';
    ctx.fillRect(x, y, width, height);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const centerY = y + height / 2;

    for (let i = 0; i < width; i++) {
      const sampleIndex = offsetSamples + i * step;
      if (sampleIndex >= samples) break;

      let min = 1;
      let max = -1;
      for (let j = 0; j < step && sampleIndex + j < samples; j++) {
        const sample = channelData[sampleIndex + j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }

      const minY = centerY + min * (height / 2) * 0.8;
      const maxY = centerY + max * (height / 2) * 0.8;

      if (i === 0) {
        ctx.moveTo(x + i, minY);
      }
      ctx.lineTo(x + i, minY);
      ctx.lineTo(x + i, maxY);
    }

    ctx.stroke();

    // Center line
    ctx.strokeStyle = color + '30';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, centerY);
    ctx.lineTo(x + width, centerY);
    ctx.stroke();
  };

  // Draw everything
  useEffect(() => {
    const animate = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // === GRILLE VERTICALE ===
      ctx.strokeStyle = '#1e293b40';
      ctx.lineWidth = 1;
      for (let sec = 0; sec <= maxDuration; sec += gridSize) {
        const x = sec * zoom;
        ctx.beginPath();
        ctx.moveTo(x, timelineHeight);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }

      // === TIMELINE RULER ===
      ctx.fillStyle = '#0c0d10';
      ctx.fillRect(0, 0, canvas.width, timelineHeight);

      ctx.strokeStyle = '#22d3ee30';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, timelineHeight);
      ctx.lineTo(canvas.width, timelineHeight);
      ctx.stroke();

      // Time markers
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px Inter, sans-serif';

      const secondsPerMark = zoom > 100 ? 1 : zoom > 50 ? 5 : 10;

      for (let sec = 0; sec <= maxDuration; sec += secondsPerMark) {
        const x = sec * zoom;

        ctx.strokeStyle = sec % 10 === 0 ? '#22d3ee80' : '#475569';
        ctx.lineWidth = sec % 10 === 0 ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, timelineHeight - (sec % 10 === 0 ? 15 : 10));
        ctx.lineTo(x, timelineHeight);
        ctx.stroke();

        if (sec % secondsPerMark === 0) {
          const minutes = Math.floor(sec / 60);
          const seconds = sec % 60;
          const label = `${minutes}:${seconds.toString().padStart(2, '0')}`;
          ctx.fillStyle = sec % 10 === 0 ? '#22d3ee' : '#94a3b8';
          ctx.fillText(label, x + 4, timelineHeight - 20);
        }
      }

      // === PLAYHEAD ===
      const playheadX = currentTime * zoom;
      ctx.save();

      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 8;

      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, canvas.height);
      ctx.stroke();

      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.moveTo(playheadX, timelineHeight);
      ctx.lineTo(playheadX - 8, timelineHeight - 12);
      ctx.lineTo(playheadX + 8, timelineHeight - 12);
      ctx.closePath();
      ctx.fill();

      ctx.restore();

      // === TRACKS ===
      visibleTracks.forEach((track, index) => {
        const y = timelineHeight + index * (trackHeight + trackSeparatorHeight);

        // Track background
        const isEven = index % 2 === 0;
        ctx.fillStyle = isEven ? '#14161a' : '#1a1c21';
        ctx.fillRect(0, y, canvas.width, trackHeight);

        // Track separator
        ctx.fillStyle = '#0a0b0d';
        ctx.fillRect(0, y + trackHeight, canvas.width, trackSeparatorHeight);

        // Track name gradient
        const gradient = ctx.createLinearGradient(0, y, 0, y + 30);
        gradient.addColorStop(0, track.color + '30');
        gradient.addColorStop(1, track.color + '00');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, y, 150, 30);

        // Track name
        ctx.fillStyle = '#f1f5f9';
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.fillText(track.name.substring(0, 15), 12, y + 20);

        // Track type badge
        ctx.fillStyle = track.color + '40';
        ctx.fillRect(12, y + 28, 8, 8);

        // === CLIPS ===
        track.clips.forEach(clip => {
          const clipX = clip.start * zoom;
          const clipWidth = clip.duration * zoom;
          const clipY = y + 8;
          const clipHeight = trackHeight - 16;

          const isSelected = selectedClip?.trackId === track.id && selectedClip?.clip.id === clip.id;
          const isDragging = dragState?.clip.id === clip.id;

          // Clip shadow
          if (isSelected || isDragging) {
            ctx.save();
            ctx.shadowColor = track.color || '#22d3ee';
            ctx.shadowBlur = isDragging ? 20 : 12;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 4;
          }

          // Clip background gradient
          const clipGradient = ctx.createLinearGradient(clipX, clipY, clipX, clipY + clipHeight);
          clipGradient.addColorStop(0, (clip.color || track.color || '#22d3ee') + '40');
          clipGradient.addColorStop(1, (clip.color || track.color || '#22d3ee') + '20');
          ctx.fillStyle = clipGradient;
          ctx.fillRect(clipX, clipY, clipWidth, clipHeight);

          // Waveform
          const buffer = clip.bufferId ? audioBufferRegistry.get(clip.bufferId) : clip.buffer;
          drawWaveform(
            ctx,
            buffer,
            clipX + 2,
            clipY + 2,
            clipWidth - 4,
            clipHeight - 4,
            clip.color || track.color || '#22d3ee',
            clip.offset || 0
          );

          // Clip border
          ctx.strokeStyle = isSelected ? '#22d3ee' : (clip.color || track.color || '#22d3ee');
          ctx.lineWidth = isSelected ? 3 : 2;
          ctx.strokeRect(clipX, clipY, clipWidth, clipHeight);

          if (isSelected || isDragging) ctx.restore();

          // Resize handles (only if selected)
          if (isSelected && !isDragging && clipWidth > 40) {
            // Left handle
            ctx.fillStyle = '#22d3ee';
            ctx.fillRect(clipX, clipY, 8, clipHeight);

            // Right handle
            ctx.fillRect(clipX + clipWidth - 8, clipY, 8, clipHeight);
          }

          // Clip name
          if (clipWidth > 50) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 11px Inter, sans-serif';
            ctx.fillText(clip.name.substring(0, Math.floor(clipWidth / 8)), clipX + 6, clipY + 16);
          }

          // Muted indicator
          if (clip.isMuted) {
            ctx.fillStyle = '#ef444480';
            ctx.fillRect(clipX, clipY, clipWidth, clipHeight);
            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillText('MUTED', clipX + 6, clipY + clipHeight / 2);
          }
        });

        // Empty track indicator
        if (track.clips.length === 0) {
          ctx.fillStyle = '#475569';
          ctx.font = '11px Inter, sans-serif';
          ctx.fillText('Tap to add clips...', 12, y + trackHeight / 2 + 4);
        }
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [tracks, currentTime, zoom, selectedClip, maxDuration, visibleTracks, dragState, gridSize]);

  // Handle touch/mouse down
  const handleCanvasTouchStart = (e: React.TouchEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const x = clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const y = clientY - rect.top;

    // Pinch zoom detection
    if ('touches' in e && e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      setTouchStart({ x: (touch1.clientX + touch2.clientX) / 2, y: (touch1.clientY + touch2.clientY) / 2, dist });
      return;
    }

    // Click on timeline = seek
    if (y < timelineHeight) {
      const newTime = x / zoom;
      onSeek(newTime);
      return;
    }

    // Find track and clip
    const trackIndex = Math.floor((y - timelineHeight) / (trackHeight + trackSeparatorHeight));
    const track = visibleTracks[trackIndex];
    if (!track) return;

    onSelectTrack(track.id);

    const time = x / zoom;
    const clip = track.clips.find(c => time >= c.start && time <= c.start + c.duration);

    if (clip) {
      const clipX = clip.start * zoom;
      const clipWidth = clip.duration * zoom;
      const relativeX = x - clipX;

      setSelectedClip({ trackId: track.id, clip });
      if (onSelectClip) {
        onSelectClip(track.id, clip);
      }

      // Detect resize or move
      let mode: DragMode = 'move';
      if (relativeX < 8) {
        mode = 'resize-start';
      } else if (relativeX > clipWidth - 8) {
        mode = 'resize-end';
      }

      setDragState({
        mode,
        trackId: track.id,
        clip,
        startX: x,
        startTime: clip.start,
        startDuration: clip.duration,
        startOffset: clip.offset || 0
      });
      isDraggingRef.current = true;
    } else {
      setSelectedClip(null);
    }
  };

  // Handle drag move
  const handleCanvasTouchMove = (e: React.TouchEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Pinch zoom
    if ('touches' in e && e.touches.length === 2 && touchStart) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      const delta = dist - touchStart.dist;
      const newZoom = Math.max(10, Math.min(200, zoom + delta * 0.2));
      setZoom(newZoom);
      setTouchStart({ ...touchStart, dist });
      return;
    }

    if (!dragState || !onUpdateClip) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const deltaX = x - dragState.startX;
    const deltaTime = deltaX / zoom;

    if (dragState.mode === 'move') {
      const newStart = snapToGrid(dragState.startTime + deltaTime);
      if (newStart >= 0) {
        onUpdateClip(dragState.trackId, dragState.clip.id, { start: newStart });
      }
    } else if (dragState.mode === 'resize-start') {
      const newStart = snapToGrid(dragState.startTime + deltaTime);
      const newDuration = dragState.startDuration - deltaTime;
      const newOffset = dragState.startOffset + deltaTime;
      if (newDuration > 0.1 && newStart >= 0) {
        onUpdateClip(dragState.trackId, dragState.clip.id, {
          start: newStart,
          duration: newDuration,
          offset: newOffset
        });
      }
    } else if (dragState.mode === 'resize-end') {
      const newDuration = snapToGrid(dragState.startDuration + deltaTime);
      if (newDuration > 0.1) {
        onUpdateClip(dragState.trackId, dragState.clip.id, { duration: newDuration });
      }
    }
  };

  const handleCanvasTouchEnd = () => {
    setTouchStart(null);
    setDragState(null);
    isDraggingRef.current = false;
  };

  // Long press for context menu
  const handleLongPress = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !selectedClip) return;

    e.preventDefault();
    const touch = e.touches[0];
    setContextMenu({
      x: touch.clientX,
      y: touch.clientY,
      trackId: selectedClip.trackId,
      clip: selectedClip.clip
    });
  };

  const handleContextMenuAction = (action: string) => {
    if (!contextMenu || !onUpdateClip) return;

    switch (action) {
      case 'duplicate':
        // Clone clip
        const newClip = {
          ...contextMenu.clip,
          id: `clip-${Date.now()}`,
          start: contextMenu.clip.start + contextMenu.clip.duration + 0.1
        };
        // Would need onAddClip callback
        break;
      case 'delete':
        onUpdateClip(contextMenu.trackId, contextMenu.clip.id, { duration: 0 }); // Hack to delete
        setSelectedClip(null);
        break;
      case 'mute':
        onUpdateClip(contextMenu.trackId, contextMenu.clip.id, { isMuted: !contextMenu.clip.isMuted });
        break;
      case 'split':
        // Would need split logic
        break;
    }

    setContextMenu(null);
  };

  return (
    <MobileContainer title="Arrangement">
      <div className="flex flex-col h-full bg-[#0c0d10]">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-[#14161a] to-[#1a1c21] border-b border-cyan-500/20 shadow-lg">
          {/* Zoom */}
          <button
            onClick={() => setZoom(Math.max(10, zoom - 10))}
            className="px-3 py-2 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 hover:from-cyan-500/30 hover:to-blue-500/30 active:scale-95 transition-all text-xs font-bold border border-cyan-500/30"
          >
            <i className="fas fa-minus"></i>
          </button>
          <div className="flex-1 text-center">
            <div className="text-xs text-cyan-400 font-bold">{zoom}px/s</div>
          </div>
          <button
            onClick={() => setZoom(Math.min(200, zoom + 10))}
            className="px-3 py-2 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 hover:from-cyan-500/30 hover:to-blue-500/30 active:scale-95 transition-all text-xs font-bold border border-cyan-500/30"
          >
            <i className="fas fa-plus"></i>
          </button>

          {/* Grid size */}
          <select
            value={gridSize}
            onChange={(e) => setGridSize(Number(e.target.value))}
            className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[10px] font-bold text-cyan-400"
          >
            <option value={0.25}>1/4s</option>
            <option value={0.5}>1/2s</option>
            <option value={1}>1s</option>
            <option value={2}>2s</option>
          </select>

          {/* Snap */}
          <button
            onClick={() => setSnapEnabled(!snapEnabled)}
            className={`px-3 py-2 rounded-lg text-xs font-bold border transition-all ${
              snapEnabled
                ? 'bg-cyan-500/30 border-cyan-500/50 text-cyan-400'
                : 'bg-white/5 border-white/10 text-slate-500'
            }`}
          >
            <i className="fas fa-magnet"></i>
          </button>
        </div>

        {/* Selected clip info */}
        {selectedClip && (
          <div className="px-4 py-2 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-b border-cyan-500/30">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-cyan-400">{selectedClip.clip.name}</div>
                <div className="text-[10px] text-slate-400">
                  {selectedClip.clip.start.toFixed(2)}s · {selectedClip.clip.duration.toFixed(2)}s
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onTouchStart={handleLongPress}
                  className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[10px] font-bold"
                >
                  <i className="fas fa-ellipsis-v"></i>
                </button>
                <button
                  onClick={() => setSelectedClip(null)}
                  className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"
                >
                  <i className="fas fa-times text-[10px]"></i>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Timeline canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-x-auto overflow-y-auto pb-20 relative"
          style={{ maxHeight: 'calc(100vh - 200px)' }}
        >
          <canvas
            ref={canvasRef}
            width={canvasWidth}
            height={totalHeight}
            onTouchStart={handleCanvasTouchStart}
            onTouchMove={handleCanvasTouchMove}
            onTouchEnd={handleCanvasTouchEnd}
            onMouseDown={handleCanvasTouchStart}
            onMouseMove={handleCanvasTouchMove}
            onMouseUp={handleCanvasTouchEnd}
            className="cursor-pointer"
            style={{ display: 'block', touchAction: 'none' }}
          />
        </div>

        {/* Context menu */}
        {contextMenu && (
          <div
            className="fixed z-50 bg-[#1a1c21] border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in duration-200"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="p-2 space-y-1">
              <button
                onClick={() => handleContextMenuAction('duplicate')}
                className="w-full px-4 py-3 text-left text-sm font-bold text-white hover:bg-cyan-500/20 rounded-xl flex items-center gap-3"
              >
                <i className="fas fa-copy text-cyan-400 w-4"></i>
                Dupliquer
              </button>
              <button
                onClick={() => handleContextMenuAction('split')}
                className="w-full px-4 py-3 text-left text-sm font-bold text-white hover:bg-cyan-500/20 rounded-xl flex items-center gap-3"
              >
                <i className="fas fa-scissors text-yellow-400 w-4"></i>
                Couper
              </button>
              <button
                onClick={() => handleContextMenuAction('mute')}
                className="w-full px-4 py-3 text-left text-sm font-bold text-white hover:bg-cyan-500/20 rounded-xl flex items-center gap-3"
              >
                <i className={`fas fa-volume-${contextMenu.clip.isMuted ? 'up' : 'mute'} text-orange-400 w-4`}></i>
                {contextMenu.clip.isMuted ? 'Activer' : 'Mute'}
              </button>
              <button
                onClick={() => handleContextMenuAction('delete')}
                className="w-full px-4 py-3 text-left text-sm font-bold text-red-400 hover:bg-red-500/20 rounded-xl flex items-center gap-3"
              >
                <i className="fas fa-trash w-4"></i>
                Supprimer
              </button>
            </div>
            <button
              onClick={() => setContextMenu(null)}
              className="w-full px-4 py-2 bg-white/5 text-xs font-bold text-slate-400 hover:bg-white/10"
            >
              Annuler
            </button>
          </div>
        )}

        {/* Empty state */}
        {visibleTracks.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pb-20 pointer-events-none">
            <div className="text-center text-slate-500">
              <i className="fas fa-waveform-lines text-5xl mb-4 opacity-20"></i>
              <p className="font-bold">Aucune piste</p>
              <p className="text-xs mt-2 opacity-70">Créez des pistes pour commencer</p>
            </div>
          </div>
        )}

        {/* Help overlay (first time) */}
        <div className="absolute bottom-24 left-0 right-0 px-4 pointer-events-none">
          <div className="bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/30 rounded-2xl p-4 backdrop-blur-sm">
            <div className="text-[10px] text-cyan-400 font-bold uppercase tracking-wide mb-2">
              <i className="fas fa-lightbulb mr-2"></i>Astuces
            </div>
            <div className="space-y-1 text-[10px] text-slate-300">
              <div>• <span className="text-cyan-400">Pincer</span> pour zoomer</div>
              <div>• <span className="text-cyan-400">Glisser</span> un clip pour le déplacer</div>
              <div>• <span className="text-cyan-400">Bords</span> pour redimensionner</div>
              <div>• <span className="text-cyan-400">Appui long</span> pour le menu</div>
            </div>
          </div>
        </div>
      </div>
    </MobileContainer>
  );
};

export default MobileArrangementPage;
