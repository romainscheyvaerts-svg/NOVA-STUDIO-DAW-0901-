import React, { useState } from 'react';
import { Track, TrackType } from '../../types';
import MobileTrackSheet from './MobileTrackSheet';

interface MobileArrangementViewProps {
  tracks: Track[];
  currentTime: number;
  isPlaying: boolean;
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
  onUpdateTrack: (track: Track) => void;
  onDeleteTrack?: (trackId: string) => void;
}

/**
 * Simplified arrangement view for mobile
 * - Compact track headers (name + color indicator only)
 * - Tap on track header → opens MobileTrackSheet
 * - Horizontal scroll for timeline
 */
const MobileArrangementView: React.FC<MobileArrangementViewProps> = ({
  tracks,
  currentTime,
  isPlaying,
  selectedTrackId,
  onSelectTrack,
  onUpdateTrack,
  onDeleteTrack,
}) => {
  const [trackSheetOpen, setTrackSheetOpen] = useState<Track | null>(null);

  // Filter to only show main tracks (not sends/buses in mobile view)
  const mainTracks = tracks.filter(
    (t) => t.type === TrackType.AUDIO || t.type === TrackType.MIDI || t.type === TrackType.DRUM_RACK
  );

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleTrackTap = (track: Track) => {
    onSelectTrack(track.id);
    setTrackSheetOpen(track);
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0c0d10] overflow-hidden">
      {/* Timeline Header */}
      <div className="flex-shrink-0 bg-[#08090b] border-b border-white/10 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                isPlaying ? 'bg-green-500 animate-pulse' : 'bg-slate-600'
              }`}
            />
            <span className="font-mono text-xl text-cyan-400 font-bold">{formatTime(currentTime)}</span>
          </div>
          <div className="text-xs text-slate-500">
            {mainTracks.length} {mainTracks.length === 1 ? 'track' : 'tracks'}
          </div>
        </div>
      </div>

      {/* Tracks List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {mainTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <i className="fas fa-layer-group text-4xl text-slate-700 mb-4"></i>
            <p className="text-sm text-slate-500">No tracks yet</p>
            <p className="text-xs text-slate-600 mt-1">Tap the + button to add a track</p>
          </div>
        ) : (
          mainTracks.map((track) => (
            <div
              key={track.id}
              onClick={() => handleTrackTap(track)}
              className={`p-4 rounded-xl border transition-all active:scale-[0.98] ${
                selectedTrackId === track.id
                  ? 'bg-white/10 border-cyan-500/50 shadow-lg shadow-cyan-500/10'
                  : 'bg-white/5 border-white/10 active:bg-white/10'
              }`}
              style={{
                borderLeftWidth: '4px',
                borderLeftColor: track.color,
              }}
            >
              <div className="flex items-center justify-between">
                {/* Left: Track Info */}
                <div className="flex items-center gap-3 flex-1">
                  {/* Color/Type Icon */}
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: track.color + '30' }}
                  >
                    <i
                      className={`fas ${
                        track.type === TrackType.AUDIO
                          ? 'fa-waveform'
                          : track.type === TrackType.DRUM_RACK
                          ? 'fa-drum'
                          : 'fa-music'
                      } text-white text-xl`}
                    ></i>
                  </div>

                  {/* Track Name & Info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-bold text-white truncate">{track.name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-500">{track.clips?.length || 0} clips</span>
                      {(track.plugins?.length || 0) > 0 && (
                        <>
                          <span className="text-slate-700">•</span>
                          <span className="text-xs text-slate-500">{track.plugins.length} FX</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right: Quick Controls */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Mute */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateTrack({ ...track, isMuted: !track.isMuted });
                    }}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                      track.isMuted ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-slate-500'
                    }`}
                  >
                    <i className="fas fa-volume-mute text-sm"></i>
                  </button>

                  {/* Solo */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateTrack({ ...track, isSolo: !track.isSolo });
                    }}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                      track.isSolo ? 'bg-yellow-500/20 text-yellow-400' : 'bg-white/5 text-slate-500'
                    }`}
                  >
                    <span className="text-xs font-black">S</span>
                  </button>
                </div>
              </div>

              {/* Volume Indicator */}
              <div className="mt-3 flex items-center gap-2">
                <i className="fas fa-volume-up text-slate-500 text-xs"></i>
                <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, track.volume * 67)}%`,
                      backgroundColor: track.color,
                    }}
                  />
                </div>
                <span className="text-xs font-mono text-slate-500 w-10 text-right">
                  {Math.round(track.volume * 100)}%
                </span>
              </div>
            </div>
          ))
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

export default MobileArrangementView;
