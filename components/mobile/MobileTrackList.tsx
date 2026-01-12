import React from 'react';
import { Track } from '../../types';

interface MobileTrackListProps {
  tracks: Track[];
  onSelectTrack: (id: string) => void;
}

const MobileTrackList: React.FC<MobileTrackListProps> = ({ tracks, onSelectTrack }) => {
  // Filter out send and bus tracks for cleaner mobile view
  const displayTracks = tracks.filter(t => t.type !== 'SEND' && t.type !== 'BUS' || t.id === 'bus-vox');

  return (
    <div className="flex flex-col gap-2 p-4 overflow-y-auto">
      {displayTracks.map(track => (
        <button
          key={track.id}
          onClick={() => onSelectTrack(track.id)}
          className="w-full bg-white/5 backdrop-blur rounded-xl p-4 flex items-center justify-between active:bg-white/10 transition-all"
        >
          {/* Indicateur couleur */}
          <div 
            className="w-3 h-12 rounded-full mr-4 flex-shrink-0" 
            style={{ backgroundColor: track.color }} 
          />
          
          {/* Infos piste */}
          <div className="flex-1 text-left min-w-0">
            <div className="text-white font-bold text-sm truncate">{track.name}</div>
            <div className="text-white/50 text-xs">
              {track.clips.length} clip(s) • {track.plugins.length} FX
            </div>
          </div>
          
          {/* Indicateurs M/S */}
          <div className="flex gap-2 ml-2 flex-shrink-0">
            {track.isMuted && (
              <span className="w-6 h-6 rounded bg-red-500/20 text-red-400 text-xs flex items-center justify-center font-bold">
                M
              </span>
            )}
            {track.isSolo && (
              <span className="w-6 h-6 rounded bg-yellow-500/20 text-yellow-400 text-xs flex items-center justify-center font-bold">
                S
              </span>
            )}
          </div>
          
          {/* Volume */}
          <div className="w-16 ml-4 flex-shrink-0">
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div 
                className="h-full bg-cyan-500 rounded-full" 
                style={{ width: `${track.volume * 100}%` }} 
              />
            </div>
            <div className="text-white/50 text-[10px] text-center mt-1">
              {Math.round(track.volume * 100)}%
            </div>
          </div>
          
          {/* Chevron */}
          <i className="fas fa-chevron-right text-white/30 ml-4 flex-shrink-0"></i>
        </button>
      ))}
    </div>
  );
};

export default MobileTrackList;
