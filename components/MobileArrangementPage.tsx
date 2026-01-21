import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip, TrackType } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

interface MobileArrangementPageProps {
  tracks: Track[];
  currentTime: number;
  isPlaying: boolean;
  bpm?: number;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onSeek: (time: number) => void;
  onUpdateClip?: (trackId: string, clipId: string, updates: Partial<Clip>) => void;
  onSelectClip?: (trackId: string, clip: Clip) => void;
  onTogglePlay?: () => void;
  onStop?: () => void;
  onUpdateTrack?: (track: Track) => void;
  onDeleteClip?: (trackId: string, clipId: string) => void;
  onOpenSends?: (trackId: string) => void;
}

type EditTool = 'SELECT' | 'TRIM' | 'SPLIT' | 'ERASE';
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

// Constants - Logic Pro iPad inspired
const TRACK_HEADER_WIDTH = 100;
const TRACK_HEIGHT = 64;
const TIMELINE_HEIGHT = 44;
const MIN_ZOOM = 20;
const MAX_ZOOM = 300;

/**
 * Mobile Arrangement Page - Professional DAW Timeline
 * Inspired by Logic Pro iPad, Cubasis, and GarageBand
 */
const MobileArrangementPage: React.FC<MobileArrangementPageProps> = ({
  tracks,
  currentTime,
  isPlaying,
  bpm = 120,
  selectedTrackId,
  onSelectTrack,
  onSeek,
  onUpdateClip,
  onSelectClip,
  onTogglePlay,
  onStop,
  onUpdateTrack,
  onDeleteClip
}) => {
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  // State
  const [zoom, setZoom] = useState(80); // pixels per beat
  const [scrollX, setScrollX] = useState(0);
  const [selectedClip, setSelectedClip] = useState<{ trackId: string; clip: Clip } | null>(null);
  const [activeTool, setActiveTool] = useState<EditTool>('SELECT');
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pinchStart, setPinchStart] = useState<{ dist: number; zoom: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; trackId: string; clip: Clip } | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [gridDivision, setGridDivision] = useState<number>(1); // 1 = beat, 0.5 = 1/8, 0.25 = 1/16

  // Derived values
  const visibleTracks = useMemo(() => 
    tracks.filter(t => t.type !== TrackType.SEND && t.id !== 'master'),
    [tracks]
  );
  
  const beatsPerSecond = bpm / 60;
  const pixelsPerSecond = zoom * beatsPerSecond;
  
  const maxDuration = useMemo(() => Math.max(
    60,
    ...visibleTracks.flatMap(t => t.clips.map(c => c.start + c.duration + 10))
  ), [visibleTracks]);

  const totalBeats = Math.ceil(maxDuration * beatsPerSecond);
  const totalWidth = totalBeats * zoom;

  // Convert time <-> beats
  const timeToBeat = useCallback((time: number) => time * beatsPerSecond, [beatsPerSecond]);
  const beatToTime = useCallback((beat: number) => beat / beatsPerSecond, [beatsPerSecond]);
  const timeToX = useCallback((time: number) => time * pixelsPerSecond, [pixelsPerSecond]);
  const xToTime = useCallback((x: number) => x / pixelsPerSecond, [pixelsPerSecond]);

  // Snap helper
  const snapTime = useCallback((time: number): number => {
    if (!snapToGrid) return time;
    const beatTime = 60 / bpm;
    const snapInterval = beatTime * gridDivision;
    return Math.round(time / snapInterval) * snapInterval;
  }, [snapToGrid, bpm, gridDivision]);

  // Format time as bars:beats
  const formatBarsBeat = useCallback((time: number): string => {
    const totalBeats = time * beatsPerSecond;
    const bars = Math.floor(totalBeats / 4) + 1;
    const beats = Math.floor(totalBeats % 4) + 1;
    return `${bars}.${beats}`;
  }, [beatsPerSecond]);

  // Auto-scroll to playhead
  useEffect(() => {
    if (isPlaying && scrollContainerRef.current) {
      const playheadX = timeToX(currentTime);
      const containerWidth = scrollContainerRef.current.clientWidth - TRACK_HEADER_WIDTH;
      const scrollLeft = scrollContainerRef.current.scrollLeft;
      
      if (playheadX > scrollLeft + containerWidth - 100 || playheadX < scrollLeft + 50) {
        scrollContainerRef.current.scrollLeft = Math.max(0, playheadX - containerWidth / 2);
      }
    }
  }, [currentTime, isPlaying, timeToX]);

  // Handle timeline tap to seek
  const handleTimelineTap = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left + scrollX;
    const time = xToTime(x);
    onSeek(Math.max(0, time));
  }, [scrollX, xToTime, onSeek]);

  // Handle clip interaction
  const handleClipTouchStart = useCallback((
    e: React.TouchEvent | React.MouseEvent,
    trackId: string,
    clip: Clip
  ) => {
    e.stopPropagation();
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const relativeX = clientX - rect.left;
    const clipWidth = clip.duration * pixelsPerSecond;

    setSelectedClip({ trackId, clip });
    onSelectTrack(trackId);
    if (onSelectClip) onSelectClip(trackId, clip);

    // Tool-specific behavior
    if (activeTool === 'ERASE' && onDeleteClip) {
      onDeleteClip(trackId, clip.id);
      setSelectedClip(null);
      return;
    }

    if (activeTool === 'SPLIT' && onUpdateClip) {
      const splitTime = xToTime(relativeX) + clip.start;
      // TODO: Implement split
      return;
    }

    // Determine drag mode based on tool and click position
    let mode: DragMode = 'move';
    const isTrimTool = activeTool === 'TRIM';
    if (isTrimTool || relativeX < 16) {
      mode = 'resize-start';
    } else if (relativeX > clipWidth - 16) {
      mode = 'resize-end';
    }

    setDragState({
      mode,
      trackId,
      clip,
      startX: clientX,
      startTime: clip.start,
      startDuration: clip.duration,
      startOffset: clip.offset || 0
    });
  }, [activeTool, pixelsPerSecond, xToTime, onSelectTrack, onSelectClip, onDeleteClip, onUpdateClip]);

  // Handle drag
  const handleTouchMove = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    // Pinch zoom
    if ('touches' in e && e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      
      if (pinchStart) {
        const scale = dist / pinchStart.dist;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStart.zoom * scale));
        setZoom(newZoom);
      } else {
        setPinchStart({ dist, zoom });
      }
      return;
    }

    if (!dragState || !onUpdateClip) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const deltaX = clientX - dragState.startX;
    const deltaTime = deltaX / pixelsPerSecond;

    if (dragState.mode === 'move') {
      const newStart = snapTime(Math.max(0, dragState.startTime + deltaTime));
      onUpdateClip(dragState.trackId, dragState.clip.id, { start: newStart });
    } else if (dragState.mode === 'resize-start') {
      const newStart = snapTime(dragState.startTime + deltaTime);
      const newDuration = dragState.startDuration - deltaTime;
      const newOffset = dragState.startOffset + deltaTime;
      if (newDuration > 0.1 && newStart >= 0) {
        onUpdateClip(dragState.trackId, dragState.clip.id, {
          start: newStart,
          duration: newDuration,
          offset: Math.max(0, newOffset)
        });
      }
    } else if (dragState.mode === 'resize-end') {
      const newDuration = snapTime(Math.max(0.1, dragState.startDuration + deltaTime));
      onUpdateClip(dragState.trackId, dragState.clip.id, { duration: newDuration });
    }
  }, [dragState, pinchStart, zoom, pixelsPerSecond, snapTime, onUpdateClip]);

  const handleTouchEnd = useCallback(() => {
    setDragState(null);
    setPinchStart(null);
  }, []);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollX(e.currentTarget.scrollLeft);
  }, []);

  // Render waveform
  const renderWaveform = useCallback((
    clip: Clip,
    width: number,
    height: number,
    color: string
  ) => {
    const buffer = clip.bufferId ? audioBufferRegistry.get(clip.bufferId) : clip.buffer;
    if (!buffer) return null;

    const channelData = buffer.getChannelData(0);
    const samples = channelData.length;
    const step = Math.max(1, Math.floor(samples / width));
    const offsetSamples = Math.floor((clip.offset || 0) * buffer.sampleRate);
    
    const points: string[] = [];
    const pointsNeg: string[] = [];
    const centerY = height / 2;

    for (let i = 0; i < width; i++) {
      const sampleIndex = offsetSamples + i * step;
      if (sampleIndex >= samples) break;

      let min = 1, max = -1;
      for (let j = 0; j < step && sampleIndex + j < samples; j++) {
        const sample = channelData[sampleIndex + j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }

      const y1 = centerY + max * centerY * 0.85;
      const y2 = centerY + min * centerY * 0.85;
      points.push(`${i},${y1}`);
      pointsNeg.unshift(`${i},${y2}`);
    }

    return (
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`waveGrad-${clip.id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.8" />
            <stop offset="50%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0.8" />
          </linearGradient>
        </defs>
        <polygon
          points={[...points, ...pointsNeg].join(' ')}
          fill={`url(#waveGrad-${clip.id})`}
        />
        <line x1="0" y1={centerY} x2={width} y2={centerY} stroke={color} strokeOpacity="0.2" strokeWidth="1" />
      </svg>
    );
  }, []);

  // Tools config
  const tools: { id: EditTool; icon: string; label: string }[] = [
    { id: 'SELECT', icon: 'fa-arrow-pointer', label: 'Select' },
    { id: 'TRIM', icon: 'fa-scissors', label: 'Trim' },
    { id: 'SPLIT', icon: 'fa-cut', label: 'Split' },
    { id: 'ERASE', icon: 'fa-eraser', label: 'Erase' },
  ];

  return (
    <div className="flex flex-col h-full bg-[#0a0b0d] select-none">
      {/* === TOP BAR - Mini Transport === */}
      <div className="flex items-center h-12 px-3 bg-gradient-to-b from-[#1a1c21] to-[#14161a] border-b border-white/10 gap-2">
        {/* Play/Stop */}
        <div className="flex items-center gap-1">
          <button
            onClick={onStop}
            className="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 active:bg-white/15 flex items-center justify-center transition-all"
          >
            <i className="fas fa-stop text-white/70 text-sm"></i>
          </button>
          <button
            onClick={onTogglePlay}
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
              isPlaying 
                ? 'bg-cyan-500 text-white shadow-lg shadow-cyan-500/30' 
                : 'bg-white/5 hover:bg-white/10 text-white/70'
            }`}
          >
            <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-sm`}></i>
          </button>
        </div>

        {/* Time Display */}
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-black/40 rounded-lg px-3 py-1 border border-white/10">
            <span className="text-cyan-400 font-mono text-sm font-bold tracking-wider">
              {formatBarsBeat(currentTime)}
            </span>
            <span className="text-white/30 font-mono text-xs ml-2">
              {currentTime.toFixed(1)}s
            </span>
          </div>
        </div>

        {/* BPM & Zoom */}
        <div className="flex items-center gap-2">
          <div className="text-[10px] font-bold text-white/50 bg-white/5 px-2 py-1 rounded">
            {bpm} BPM
          </div>
          <button
            onClick={() => setZoom(z => Math.max(MIN_ZOOM, z - 20))}
            className="w-7 h-7 rounded bg-white/5 hover:bg-white/10 flex items-center justify-center"
          >
            <i className="fas fa-minus text-white/50 text-[10px]"></i>
          </button>
          <button
            onClick={() => setZoom(z => Math.min(MAX_ZOOM, z + 20))}
            className="w-7 h-7 rounded bg-white/5 hover:bg-white/10 flex items-center justify-center"
          >
            <i className="fas fa-plus text-white/50 text-[10px]"></i>
          </button>
        </div>
      </div>

      {/* === TOOL BAR === */}
      <div className="flex items-center h-10 px-2 bg-[#0f1114] border-b border-white/5 gap-1">
        {tools.map(tool => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`flex items-center gap-1.5 px-3 h-7 rounded-md text-[10px] font-bold uppercase tracking-wide transition-all ${
              activeTool === tool.id
                ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'
            }`}
          >
            <i className={`fas ${tool.icon}`}></i>
            <span className="hidden sm:inline">{tool.label}</span>
          </button>
        ))}

        <div className="flex-1" />

        {/* Snap toggle */}
        <button
          onClick={() => setSnapToGrid(!snapToGrid)}
          className={`flex items-center gap-1.5 px-3 h-7 rounded-md text-[10px] font-bold transition-all ${
            snapToGrid
              ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
              : 'bg-white/5 text-white/40'
          }`}
        >
          <i className="fas fa-magnet"></i>
          <span className="hidden sm:inline">Snap</span>
        </button>

        {/* Grid division */}
        <select
          value={gridDivision}
          onChange={e => setGridDivision(Number(e.target.value))}
          className="h-7 px-2 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold text-white/70"
        >
          <option value={1}>1/4</option>
          <option value={0.5}>1/8</option>
          <option value={0.25}>1/16</option>
          <option value={2}>1/2</option>
          <option value={4}>1 Bar</option>
        </select>
      </div>

      {/* === MAIN AREA === */}
      <div className="flex-1 flex overflow-hidden">
        {/* === TRACK HEADERS (Fixed) === */}
        <div className="flex-shrink-0 bg-[#0c0d10] border-r border-white/10 z-10" style={{ width: TRACK_HEADER_WIDTH }}>
          {/* Timeline header spacer */}
          <div 
            className="flex items-center justify-center border-b border-white/10 bg-[#0f1114]"
            style={{ height: TIMELINE_HEIGHT }}
          >
            <span className="text-[9px] font-bold text-white/30 uppercase">Tracks</span>
          </div>

          {/* Track headers */}
          <div className="overflow-y-auto" style={{ height: `calc(100% - ${TIMELINE_HEIGHT}px)` }}>
            {visibleTracks.map(track => (
              <div
                key={track.id}
                onClick={() => onSelectTrack(track.id)}
                className={`flex flex-col justify-center px-2 border-b border-white/5 cursor-pointer transition-all ${
                  selectedTrackId === track.id
                    ? 'bg-white/10'
                    : 'bg-transparent hover:bg-white/5'
                }`}
                style={{ height: TRACK_HEIGHT }}
              >
                {/* Track name */}
                <div className="flex items-center gap-1.5 mb-1">
                  <div 
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: track.color }}
                  />
                  <span className="text-[10px] font-bold text-white/90 truncate">
                    {track.name}
                  </span>
                </div>

                {/* Track controls M/S/R/Send */}
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onUpdateTrack) onUpdateTrack({ ...track, isMuted: !track.isMuted });
                    }}
                    className={`w-5 h-5 rounded text-[7px] font-black transition-all ${
                      track.isMuted
                        ? 'bg-red-500 text-white'
                        : 'bg-white/10 text-white/40 hover:bg-white/20'
                    }`}
                  >
                    M
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onUpdateTrack) onUpdateTrack({ ...track, isSolo: !track.isSolo });
                    }}
                    className={`w-5 h-5 rounded text-[7px] font-black transition-all ${
                      track.isSolo
                        ? 'bg-yellow-500 text-black'
                        : 'bg-white/10 text-white/40 hover:bg-white/20'
                    }`}
                  >
                    S
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onUpdateTrack) onUpdateTrack({ ...track, isTrackArmed: !track.isTrackArmed });
                    }}
                    className={`w-5 h-5 rounded text-[7px] font-black transition-all ${
                      track.isTrackArmed
                        ? 'bg-red-600 text-white animate-pulse'
                        : 'bg-white/10 text-white/40 hover:bg-white/20'
                    }`}
                  >
                    R
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* === SCROLLABLE TIMELINE AREA === */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto"
          onScroll={handleScroll}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseMove={handleTouchMove}
          onMouseUp={handleTouchEnd}
          onMouseLeave={handleTouchEnd}
          style={{ touchAction: 'pan-x pan-y' }}
        >
          <div style={{ width: totalWidth, minHeight: '100%' }}>
            {/* === TIMELINE RULER === */}
            <div
              ref={timelineRef}
              className="sticky top-0 z-20 bg-[#0f1114] border-b border-cyan-500/30 cursor-pointer"
              style={{ height: TIMELINE_HEIGHT }}
              onTouchStart={handleTimelineTap}
              onMouseDown={handleTimelineTap}
            >
              {/* Bar markers */}
              {Array.from({ length: Math.ceil(totalBeats / 4) + 1 }, (_, bar) => {
                const x = bar * 4 * zoom;
                return (
                  <React.Fragment key={bar}>
                    {/* Bar line */}
                    <div
                      className="absolute top-0 bottom-0 border-l border-white/20"
                      style={{ left: x }}
                    />
                    {/* Bar number */}
                    <div
                      className="absolute top-1 text-[10px] font-bold text-white/60"
                      style={{ left: x + 4 }}
                    >
                      {bar + 1}
                    </div>
                    {/* Beat subdivisions */}
                    {[1, 2, 3].map(beat => (
                      <div
                        key={beat}
                        className="absolute bottom-0 border-l border-white/10"
                        style={{ left: x + beat * zoom, height: 8 }}
                      />
                    ))}
                  </React.Fragment>
                );
              })}

              {/* Playhead marker on ruler */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 z-30"
                style={{ left: timeToX(currentTime) }}
              >
                <div className="absolute -top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-cyan-400" />
              </div>
            </div>

            {/* === TRACKS CONTENT === */}
            <div className="relative">
              {/* Grid lines */}
              <div className="absolute inset-0 pointer-events-none">
                {Array.from({ length: Math.ceil(totalBeats / 4) + 1 }, (_, bar) => (
                  <div
                    key={bar}
                    className="absolute top-0 bottom-0 border-l border-white/5"
                    style={{ left: bar * 4 * zoom }}
                  />
                ))}
              </div>

              {/* Playhead line */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 z-20 pointer-events-none shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                style={{ left: timeToX(currentTime) }}
              />

              {/* Track rows */}
              {visibleTracks.map((track, index) => (
                <div
                  key={track.id}
                  className={`relative border-b border-white/5 ${
                    index % 2 === 0 ? 'bg-[#0c0d10]' : 'bg-[#0e1013]'
                  } ${selectedTrackId === track.id ? 'bg-white/5' : ''}`}
                  style={{ height: TRACK_HEIGHT }}
                  onClick={() => onSelectTrack(track.id)}
                >
                  {/* Clips */}
                  {track.clips.map(clip => {
                    const clipX = timeToX(clip.start);
                    const clipWidth = Math.max(20, clip.duration * pixelsPerSecond);
                    const isSelected = selectedClip?.clip.id === clip.id;
                    const isDragging = dragState?.clip.id === clip.id;

                    return (
                      <div
                        key={clip.id}
                        className={`absolute top-1 bottom-1 rounded-md overflow-hidden cursor-pointer transition-shadow ${
                          isSelected
                            ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-500/30'
                            : 'ring-1 ring-white/20 hover:ring-white/40'
                        } ${isDragging ? 'opacity-80 scale-[1.02]' : ''} ${
                          clip.isMuted ? 'opacity-40' : ''
                        }`}
                        style={{
                          left: clipX,
                          width: clipWidth,
                          backgroundColor: (clip.color || track.color) + '30',
                        }}
                        onTouchStart={(e) => handleClipTouchStart(e, track.id, clip)}
                        onMouseDown={(e) => handleClipTouchStart(e, track.id, clip)}
                      >
                        {/* Waveform */}
                        {renderWaveform(clip, clipWidth, TRACK_HEIGHT - 8, clip.color || track.color)}

                        {/* Clip header */}
                        <div 
                          className="absolute top-0 left-0 right-0 h-4 px-1.5 flex items-center"
                          style={{ backgroundColor: (clip.color || track.color) + '60' }}
                        >
                          <span className="text-[9px] font-bold text-white truncate drop-shadow">
                            {clip.name}
                          </span>
                        </div>

                        {/* Resize handles */}
                        {isSelected && (
                          <>
                            <div className="absolute left-0 top-0 bottom-0 w-3 bg-cyan-400/50 cursor-ew-resize" />
                            <div className="absolute right-0 top-0 bottom-0 w-3 bg-cyan-400/50 cursor-ew-resize" />
                          </>
                        )}

                        {/* Muted overlay */}
                        {clip.isMuted && (
                          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <i className="fas fa-volume-mute text-red-400 text-sm"></i>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Empty track hint */}
                  {track.clips.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="text-[10px] text-white/20 font-medium">Empty</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* === SELECTED CLIP INFO BAR === */}
      {selectedClip && (
        <div className="h-12 px-3 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-t border-cyan-500/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div 
              className="w-3 h-3 rounded"
              style={{ backgroundColor: selectedClip.clip.color || '#22d3ee' }}
            />
            <div>
              <div className="text-xs font-bold text-white">{selectedClip.clip.name}</div>
              <div className="text-[10px] text-white/50">
                {formatBarsBeat(selectedClip.clip.start)} · {selectedClip.clip.duration.toFixed(2)}s
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onUpdateClip?.(selectedClip.trackId, selectedClip.clip.id, { 
                isMuted: !selectedClip.clip.isMuted 
              })}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                selectedClip.clip.isMuted
                  ? 'bg-red-500/20 text-red-400'
                  : 'bg-white/10 text-white/50 hover:bg-white/20'
              }`}
            >
              <i className={`fas ${selectedClip.clip.isMuted ? 'fa-volume-mute' : 'fa-volume-up'} text-sm`}></i>
            </button>
            <button
              onClick={() => {
                onDeleteClip?.(selectedClip.trackId, selectedClip.clip.id);
                setSelectedClip(null);
              }}
              className="w-8 h-8 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center transition-all"
            >
              <i className="fas fa-trash text-sm"></i>
            </button>
            <button
              onClick={() => setSelectedClip(null)}
              className="w-8 h-8 rounded-lg bg-white/10 text-white/50 hover:bg-white/20 flex items-center justify-center transition-all"
            >
              <i className="fas fa-times text-sm"></i>
            </button>
          </div>
        </div>
      )}

      {/* === BOTTOM PADDING FOR NAV === */}
      <div className="h-16 bg-[#0a0b0d]" />
    </div>
  );
};

export default MobileArrangementPage;
