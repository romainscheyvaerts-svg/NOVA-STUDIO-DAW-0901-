import React, { useRef, useState, useEffect } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip } from '../types';
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

/**
 * Page mobile Arrangement - Timeline professionnelle avec waveforms
 * Design moderne inspiré de Logic Pro iPad / FL Studio Mobile
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
  const [zoom, setZoom] = useState(60); // pixels per second (augmenté de 40 à 60)
  const [selectedClip, setSelectedClip] = useState<{ trackId: string, clip: Clip } | null>(null);
  const [touchStart, setTouchStart] = useState<{ x: number, y: number, dist: number } | null>(null);
  const animationRef = useRef<number>(0);

  const visibleTracks = tracks.filter(t => t.id !== 'master');
  const trackHeight = 80; // Augmenté de 60 à 80 pour mieux voir les waveforms
  const timelineHeight = 50; // Augmenté de 40 à 50
  const trackSeparatorHeight = 2; // Séparateur entre pistes
  const totalHeight = visibleTracks.length * (trackHeight + trackSeparatorHeight) + timelineHeight;

  // Calculate max duration
  const maxDuration = Math.max(
    120, // Minimum 2 minutes
    ...visibleTracks.flatMap(t => t.clips.map(c => c.start + c.duration))
  );

  const canvasWidth = Math.max(window.innerWidth, maxDuration * zoom);

  /**
   * Dessine une waveform professionnelle à partir d'un AudioBuffer
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
      // Fallback: rectangle plein si pas de buffer
      ctx.fillStyle = color + '40';
      ctx.fillRect(x, y, width, height);
      return;
    }

    const channelData = buffer.getChannelData(0); // Canal gauche
    const samples = channelData.length;
    const step = Math.max(1, Math.floor(samples / width)); // Samples per pixel
    const offsetSamples = Math.floor(offset * buffer.sampleRate);

    ctx.fillStyle = color + '20'; // Background
    ctx.fillRect(x, y, width, height);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const centerY = y + height / 2;

    for (let i = 0; i < width; i++) {
      const sampleIndex = offsetSamples + i * step;
      if (sampleIndex >= samples) break;

      // Calcul de l'amplitude moyenne pour ce pixel
      let min = 1;
      let max = -1;
      for (let j = 0; j < step && sampleIndex + j < samples; j++) {
        const sample = channelData[sampleIndex + j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }

      // Dessine la ligne de la waveform
      const minY = centerY + min * (height / 2) * 0.8;
      const maxY = centerY + max * (height / 2) * 0.8;

      if (i === 0) {
        ctx.moveTo(x + i, minY);
      }
      ctx.lineTo(x + i, minY);
      ctx.lineTo(x + i, maxY);
    }

    ctx.stroke();

    // Ligne centrale
    ctx.strokeStyle = color + '30';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, centerY);
    ctx.lineTo(x + width, centerY);
    ctx.stroke();
  };

  // Draw timeline avec animation
  useEffect(() => {
    const animate = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // === TIMELINE RULER ===
      ctx.fillStyle = '#0c0d10'; // Darker background
      ctx.fillRect(0, 0, canvas.width, timelineHeight);

      // Timeline separator
      ctx.strokeStyle = '#22d3ee30';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, timelineHeight);
      ctx.lineTo(canvas.width, timelineHeight);
      ctx.stroke();

      // Draw time markers
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px Inter, sans-serif';

      const secondsPerMark = zoom > 100 ? 1 : zoom > 50 ? 5 : 10;

      for (let sec = 0; sec <= maxDuration; sec += secondsPerMark) {
        const x = sec * zoom;

        // Major tick
        ctx.strokeStyle = sec % 10 === 0 ? '#22d3ee80' : '#475569';
        ctx.lineWidth = sec % 10 === 0 ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, timelineHeight - (sec % 10 === 0 ? 15 : 10));
        ctx.lineTo(x, timelineHeight);
        ctx.stroke();

        // Time label
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

      // Playhead shadow/glow
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 8;

      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, canvas.height);
      ctx.stroke();

      // Playhead triangle
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

        // Track background (alternating colors)
        const isEven = index % 2 === 0;
        ctx.fillStyle = isEven ? '#14161a' : '#1a1c21';
        ctx.fillRect(0, y, canvas.width, trackHeight);

        // Track separator
        ctx.fillStyle = '#0a0b0d';
        ctx.fillRect(0, y + trackHeight, canvas.width, trackSeparatorHeight);

        // Track name background
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

          // Clip shadow
          if (isSelected) {
            ctx.save();
            ctx.shadowColor = track.color || '#22d3ee';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 4;
          }

          // Clip background gradient
          const clipGradient = ctx.createLinearGradient(clipX, clipY, clipX, clipY + clipHeight);
          clipGradient.addColorStop(0, (clip.color || track.color || '#22d3ee') + '40');
          clipGradient.addColorStop(1, (clip.color || track.color || '#22d3ee') + '20');
          ctx.fillStyle = clipGradient;
          ctx.fillRect(clipX, clipY, clipWidth, clipHeight);

          // === WAVEFORM ===
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

          if (isSelected) ctx.restore();

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
    const trackIndex = Math.floor((y - timelineHeight) / (trackHeight + trackSeparatorHeight));
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
    } else {
      setSelectedClip(null);
    }
  };

  // Pinch to zoom
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      setTouchStart({ x: (touch1.clientX + touch2.clientX) / 2, y: (touch1.clientY + touch2.clientY) / 2, dist });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStart) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      const delta = dist - touchStart.dist;
      const newZoom = Math.max(10, Math.min(200, zoom + delta * 0.2));
      setZoom(newZoom);
      setTouchStart({ ...touchStart, dist });
    }
  };

  const handleTouchEnd = () => {
    setTouchStart(null);
  };

  return (
    <MobileContainer title="Arrangement">
      <div className="flex flex-col h-full bg-[#0c0d10]">
        {/* Zoom controls */}
        <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-[#14161a] to-[#1a1c21] border-b border-cyan-500/20 shadow-lg">
          <button
            onClick={() => setZoom(Math.max(10, zoom - 10))}
            className="px-4 py-2 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 hover:from-cyan-500/30 hover:to-blue-500/30 active:scale-95 transition-all text-xs font-bold border border-cyan-500/30"
          >
            <i className="fas fa-minus"></i>
          </button>
          <div className="flex-1 text-center">
            <div className="text-xs text-cyan-400 font-bold">Zoom: {zoom}px/s</div>
            <div className="text-[10px] text-slate-500">Pinch to zoom</div>
          </div>
          <button
            onClick={() => setZoom(Math.min(200, zoom + 10))}
            className="px-4 py-2 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 hover:from-cyan-500/30 hover:to-blue-500/30 active:scale-95 transition-all text-xs font-bold border border-cyan-500/30"
          >
            <i className="fas fa-plus"></i>
          </button>
        </div>

        {/* Selected clip info */}
        {selectedClip && (
          <div className="px-4 py-2 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-b border-cyan-500/30">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-cyan-400">{selectedClip.clip.name}</div>
                <div className="text-[10px] text-slate-400">
                  {selectedClip.clip.start.toFixed(2)}s - {selectedClip.clip.duration.toFixed(2)}s
                </div>
              </div>
              <button
                onClick={() => setSelectedClip(null)}
                className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"
              >
                <i className="fas fa-times text-[10px]"></i>
              </button>
            </div>
          </div>
        )}

        {/* Timeline canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-x-auto overflow-y-auto pb-20 relative"
          style={{ maxHeight: 'calc(100vh - 200px)' }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <canvas
            ref={canvasRef}
            width={canvasWidth}
            height={totalHeight}
            onClick={handleCanvasClick}
            className="cursor-pointer"
            style={{ display: 'block' }}
          />
        </div>

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
      </div>
    </MobileContainer>
  );
};

export default MobileArrangementPage;
