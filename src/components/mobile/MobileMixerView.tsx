import React, { useState } from 'react';
import { Track, TrackType, PluginInstance } from '../../types';
import MobileTrackSheet from './MobileTrackSheet';

interface MobileMixerViewProps {
  tracks: Track[];
  onUpdateTrack: (track: Track) => void;
  onOpenPlugin?: (trackId: string, plugin: PluginInstance) => void;
  onDeleteTrack?: (trackId: string) => void;
}

/**
 * Mobile mixer view with vertical faders in grid layout (2-3 columns)
 * Tap on fader → opens track details in bottom sheet
 */
const MobileMixerView: React.FC<MobileMixerViewProps> = ({
  tracks,
  onUpdateTrack,
  onOpenPlugin,
  onDeleteTrack,
}) => {
  const [trackSheetOpen, setTrackSheetOpen] = useState<Track | null>(null);

  // Filter to only show main tracks and buses
  const mixerTracks = tracks.filter(
    (t) =>
      t.type === TrackType.AUDIO ||
      t.type === TrackType.MIDI ||
      t.type === TrackType.DRUM_RACK ||
      t.type === TrackType.BUS ||
      t.id === 'master'
  );

  const handleFaderInteraction = (track: Track, clientY: number, rect: DOMRect) => {
    const percentage = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const newVolume = percentage * percentage * 1.5; // Quadratic curve for better control
    onUpdateTrack({ ...track, volume: newVolume });
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0c0d10] overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-[#08090b] border-b border-white/10 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Mixer</h2>
          <span className="text-xs text-slate-500">
            {mixerTracks.length} {mixerTracks.length === 1 ? 'channel' : 'channels'}
          </span>
        </div>
      </div>

      {/* Faders Grid (2-3 columns) */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-3 gap-4">
          {mixerTracks.map((track) => (
            <div key={track.id} className="flex flex-col items-center">
              {/* Fader */}
              <div className="relative w-full">
                <div
                  className="w-full h-40 bg-white/5 rounded-xl border border-white/10 relative overflow-hidden cursor-pointer"
                  onClick={() => setTrackSheetOpen(track)}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const touch = e.touches[0];
                    handleFaderInteraction(track, touch.clientY, rect);

                    const onTouchMove = (moveEvent: TouchEvent) => {
                      const moveTouch = moveEvent.touches[0];
                      handleFaderInteraction(track, moveTouch.clientY, rect);
                    };

                    const onTouchEnd = () => {
                      document.removeEventListener('touchmove', onTouchMove);
                      document.removeEventListener('touchend', onTouchEnd);
                    };

                    document.addEventListener('touchmove', onTouchMove);
                    document.addEventListener('touchend', onTouchEnd);
                  }}
                >
                  {/* Volume Fill */}
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-b-xl transition-all"
                    style={{
                      height: `${Math.min(100, Math.sqrt(track.volume / 1.5) * 100)}%`,
                      backgroundColor: track.color,
                      opacity: 0.6,
                    }}
                  />

                  {/* Volume Value */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xs font-bold text-white drop-shadow-lg">
                      {Math.round(track.volume * 100)}
                    </span>
                  </div>

                  {/* Status Indicators */}
                  <div className="absolute top-2 left-2 flex flex-col gap-1">
                    {track.isMuted && (
                      <div className="w-4 h-4 rounded bg-red-500 flex items-center justify-center">
                        <i className="fas fa-volume-mute text-[8px] text-white"></i>
                      </div>
                    )}
                    {track.isSolo && (
                      <div className="w-4 h-4 rounded bg-yellow-500 flex items-center justify-center">
                        <span className="text-[8px] font-black text-white">S</span>
                      </div>
                    )}
                    {track.isTrackArmed && (
                      <div className="w-4 h-4 rounded bg-red-500 animate-pulse flex items-center justify-center">
                        <i className="fas fa-circle text-[6px] text-white"></i>
                      </div>
                    )}
                  </div>

                  {/* FX Indicator */}
                  {(track.plugins?.length || 0) > 0 && (
                    <div className="absolute top-2 right-2">
                      <div className="w-4 h-4 rounded bg-purple-500/80 flex items-center justify-center">
                        <span className="text-[8px] font-bold text-white">{track.plugins.length}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Track Name */}
              <button
                onClick={() => setTrackSheetOpen(track)}
                className="mt-2 w-full text-center"
              >
                {/* Color Dot */}
                <div
                  className="w-2 h-2 rounded-full mx-auto mb-1"
                  style={{ backgroundColor: track.color }}
                />
                
                {/* Track Name */}
                <span className="text-xs font-bold text-white block truncate">{track.name}</span>
                
                {/* Clips Count */}
                {(track.clips?.length || 0) > 0 && (
                  <span className="text-[9px] text-slate-500 block">{track.clips.length} clips</span>
                )}
              </button>

              {/* Pan Control */}
              <div className="mt-2 w-full">
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={track.pan}
                  onChange={(e) => onUpdateTrack({ ...track, pan: parseFloat(e.target.value) })}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full h-1 rounded-full appearance-none bg-white/10"
                  style={{ accentColor: track.color }}
                />
                <div className="text-[8px] text-slate-500 text-center mt-0.5 font-mono">
                  {track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.abs(Math.round(track.pan * 100))}` : `R${Math.round(track.pan * 100)}`}
                </div>
              </div>

              {/* M/S Buttons */}
              <div className="mt-2 flex gap-1 w-full">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateTrack({ ...track, isMuted: !track.isMuted });
                  }}
                  className={`flex-1 py-1.5 rounded text-[9px] font-black ${
                    track.isMuted ? 'bg-red-500/30 text-red-400' : 'bg-white/5 text-slate-500'
                  }`}
                >
                  M
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateTrack({ ...track, isSolo: !track.isSolo });
                  }}
                  className={`flex-1 py-1.5 rounded text-[9px] font-black ${
                    track.isSolo ? 'bg-yellow-500/30 text-yellow-400' : 'bg-white/5 text-slate-500'
                  }`}
                >
                  S
                </button>
              </div>
            </div>
          ))}
        </div>

        {mixerTracks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <i className="fas fa-sliders-h text-4xl text-slate-700 mb-4"></i>
            <p className="text-sm text-slate-500">No tracks in mixer</p>
          </div>
        )}
      </div>

      {/* Track Detail Sheet */}
      {trackSheetOpen && (
        <MobileTrackSheet
          track={trackSheetOpen}
          isOpen={!!trackSheetOpen}
          onClose={() => setTrackSheetOpen(null)}
          onUpdateTrack={(updatedTrack) => {
            onUpdateTrack(updatedTrack);
            setTrackSheetOpen(updatedTrack);
          }}
          onDeleteTrack={onDeleteTrack}
        />
      )}
    </div>
  );
};

export default MobileMixerView;
