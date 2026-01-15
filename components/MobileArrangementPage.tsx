import React, { useRef, useState, useEffect } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip } from '../types';

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

/**
 * Page mobile pour l'arrangement - Vue timeline simplifiée
 * Affiche les clips audio sur une timeline horizontale scrollable
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
  const [zoom, setZoom] = useState(40); // pixels per second
  const [selectedClip, setSelectedClip] = useState<{ trackId: string, clip: Clip } | null>(null);

  const visibleTracks = tracks.filter(t => t.id !== 'master');
  const trackHeight = 60;
  const timelineHeight = 40;
  const totalHeight = visibleTracks.length * trackHeight + timelineHeight;

  // Calculate max duration
  const maxDuration = Math.max(
    60, // Minimum 60 seconds
    ...visibleTracks.flatMap(t => t.clips.map(c => c.start + c.duration))
  );

  const canvasWidth = Math.max(window.innerWidth, maxDuration * zoom);

  // Draw timeline
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw timeline ruler
    ctx.fillStyle = '#1e2024';
    ctx.fillRect(0, 0, canvas.width, timelineHeight);

    ctx.strokeStyle = '#2a2d35';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, timelineHeight);
    ctx.lineTo(canvas.width, timelineHeight);
    ctx.stroke();

    // Draw time markers
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px Inter';
    for (let sec = 0; sec <= maxDuration; sec += 5) {
      const x = sec * zoom;
      ctx.beginPath();
      ctx.moveTo(x, timelineHeight - 10);
      ctx.lineTo(x, timelineHeight);
      ctx.stroke();

      const minutes = Math.floor(sec / 60);
      const seconds = sec % 60;
      ctx.fillText(`${minutes}:${seconds.toString().padStart(2, '0')}`, x + 2, timelineHeight - 15);
    }

    // Draw playhead
    const playheadX = currentTime * zoom;
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, canvas.height);
    ctx.stroke();

    // Draw tracks and clips
    visibleTracks.forEach((track, index) => {
      const y = timelineHeight + index * trackHeight;

      // Track background
      ctx.fillStyle = index % 2 === 0 ? '#14161a' : '#1a1c21';
      ctx.fillRect(0, y, canvas.width, trackHeight);

      // Track separator
      ctx.strokeStyle = '#2a2d35';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();

      // Track name
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px Inter';
      ctx.fillText(track.name.substring(0, 15), 8, y + 15);

      // Draw clips
      track.clips.forEach(clip => {
        const clipX = clip.start * zoom;
        const clipWidth = clip.duration * zoom;
        const clipY = y + 20;
        const clipHeight = trackHeight - 25;

        // Clip background
        ctx.fillStyle = clip.color || '#22d3ee';
        ctx.globalAlpha = clip.isMuted ? 0.3 : 0.6;
        ctx.fillRect(clipX, clipY, clipWidth, clipHeight);
        ctx.globalAlpha = 1;

        // Clip border
        const isSelected = selectedClip?.trackId === track.id && selectedClip?.clip.id === clip.id;
        ctx.strokeStyle = isSelected ? '#06b6d4' : 'rgba(255,255,255,0.2)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(clipX, clipY, clipWidth, clipHeight);

        // Clip name
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px Inter';
        ctx.fillText(clip.name.substring(0, 20), clipX + 4, clipY + 14);
      });
    });
  }, [tracks, currentTime, zoom, selectedClip, maxDuration, visibleTracks]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top;

    // Click on timeline = seek
    if (y < timelineHeight) {
      const newTime = x / zoom;
      onSeek(newTime);
      return;
    }

    // Click on track/clip
    const trackIndex = Math.floor((y - timelineHeight) / trackHeight);
    const track = visibleTracks[trackIndex];
    if (!track) return;

    onSelectTrack(track.id);

    // Check if clicked on a clip
    const time = x / zoom;
    const clip = track.clips.find(c => time >= c.start && time <= c.start + c.duration);
    if (clip) {
      setSelectedClip({ trackId: track.id, clip });
      if (onSelectClip) {
        onSelectClip(track.id, clip);
      }
    }
  };

  return (
    <MobileContainer title="Arrangement">
      <div className="flex flex-col h-full">
        {/* Zoom controls */}
        <div className="flex items-center gap-2 px-4 py-2 bg-[#14161a] border-b border-white/10">
          <button
            onClick={() => setZoom(Math.max(20, zoom - 10))}
            className="px-3 py-1 rounded bg-white/5 hover:bg-white/10 text-xs"
          >
            <i className="fas fa-minus"></i>
          </button>
          <span className="text-xs text-slate-400 min-w-[60px] text-center">
            Zoom: {zoom}px/s
          </span>
          <button
            onClick={() => setZoom(Math.min(100, zoom + 10))}
            className="px-3 py-1 rounded bg-white/5 hover:bg-white/10 text-xs"
          >
            <i className="fas fa-plus"></i>
          </button>

          {/* Selected clip info */}
          {selectedClip && (
            <div className="ml-auto text-xs text-cyan-400">
              {selectedClip.clip.name}
            </div>
          )}
        </div>

        {/* Timeline canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-x-auto overflow-y-auto pb-20"
          style={{ maxHeight: 'calc(100vh - 180px)' }}
        >
          <canvas
            ref={canvasRef}
            width={canvasWidth}
            height={totalHeight}
            onClick={handleCanvasClick}
            className="cursor-pointer"
          />
        </div>

        {/* Empty state */}
        {visibleTracks.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pb-20">
            <div className="text-center text-slate-500">
              <i className="fas fa-waveform-lines text-4xl mb-4 opacity-30"></i>
              <p>Aucune piste</p>
              <p className="text-xs mt-2">Créez des pistes pour commencer l'arrangement</p>
            </div>
          </div>
        )}
      </div>
    </MobileContainer>
  );
};

export default MobileArrangementPage;
