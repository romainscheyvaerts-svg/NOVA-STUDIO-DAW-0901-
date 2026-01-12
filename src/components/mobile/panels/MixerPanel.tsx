import React from 'react';
import { Track } from '../../../types';

interface MixerPanelProps {
  tracks: Track[];
  onUpdateTrack: (track: Track) => void;
}

const MixerPanel: React.FC<MixerPanelProps> = ({ tracks, onUpdateTrack }) => {
  // Filter out send tracks for cleaner mixer view
  const visibleTracks = tracks.filter(t => t.type !== 'SEND');
  
  return (
    <div className="p-4 pb-safe">
      <div className="flex gap-4 overflow-x-auto pb-4">
        {visibleTracks.map(track => (
          <div key={track.id} className="flex-shrink-0 w-20 flex flex-col items-center">
            {/* VU Meter */}
            <div className="w-4 h-32 bg-black/50 rounded-full mb-2 relative overflow-hidden">
              <div 
                className="absolute bottom-0 w-full bg-gradient-to-t from-green-500 via-yellow-500 to-red-500 rounded-full transition-all"
                style={{ height: `${track.volume * 100}%` }}
              />
            </div>
            
            {/* Fader */}
            <div className="relative h-40 flex items-center justify-center my-2">
              <input
                type="range"
                min="0" 
                max="1" 
                step="0.01"
                value={track.volume}
                onChange={(e) => onUpdateTrack({ ...track, volume: parseFloat(e.target.value) })}
                className="w-32 h-3 -rotate-90 origin-center appearance-none bg-white/10 rounded-lg cursor-pointer"
                style={{
                  accentColor: track.color
                }}
              />
            </div>
            
            {/* Volume text */}
            <span className="text-[10px] text-white/50 mb-2">
              {Math.round(track.volume * 100)}%
            </span>
            
            {/* M/S Buttons */}
            <div className="flex gap-1 mt-2">
              <button 
                onClick={() => onUpdateTrack({ ...track, isMuted: !track.isMuted })}
                className={`w-8 h-8 rounded text-xs font-bold transition-all ${
                  track.isMuted 
                    ? 'bg-red-500 text-white' 
                    : 'bg-white/10 text-white/50 hover:bg-white/20'
                }`}
              >
                M
              </button>
              <button 
                onClick={() => onUpdateTrack({ ...track, isSolo: !track.isSolo })}
                className={`w-8 h-8 rounded text-xs font-bold transition-all ${
                  track.isSolo 
                    ? 'bg-yellow-500 text-black' 
                    : 'bg-white/10 text-white/50 hover:bg-white/20'
                }`}
              >
                S
              </button>
            </div>
            
            {/* Track color indicator */}
            <div 
              className="w-2 h-2 rounded-full mt-2" 
              style={{ backgroundColor: track.color }} 
            />
            
            {/* Track Name */}
            <span className="text-[10px] text-white/70 mt-1 truncate w-full text-center">
              {track.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MixerPanel;
