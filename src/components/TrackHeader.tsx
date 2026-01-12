import React from 'react';
import { TrackType } from '../../types';

interface Props {
  track: any;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
  onUpdateTrack: (updated: any) => void;
  trackHeight?: number;
}

const getTrackIcon = (type: TrackType) => {
  switch (type) {
    case TrackType.AUDIO: return 'fa-microphone';
    case TrackType.MIDI: return 'fa-music';
    default: return 'fa-music';
  }
};

const TrackHeader: React.FC<Props> = ({ track, isSelected, onSelect, onUpdateTrack, trackHeight = 80 }) => {
  return (
    <div className={`relative flex flex-col bg-[#1a1d24] border-b border-white/10 ${isSelected ? 'bg-[#1e2128]' : ''}`} style={{ height: `${trackHeight}px` }}>
      {/* ROW 1 */}
      <div className="flex items-center h-8 px-2 gap-2">
        <div className="cursor-grab text-white/30"><i className="fas fa-grip-vertical text-xs" /></div>
        <i className={`fas ${getTrackIcon(track.type)} text-white/50 text-xs`} />
        <span className="text-white text-sm font-medium truncate flex-1 min-w-0">{track.name}</span>

        <div className="flex gap-1">
          <button onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isMuted: !track.isMuted }); }} className={`w-6 h-6 rounded text-[10px] font-bold transition-all ${track.isMuted ? 'bg-red-500 text-white' : 'bg-white/10 text-white/50 hover:bg-white/20'}`}>M</button>
          <button onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isSolo: !track.isSolo }); }} className={`w-6 h-6 rounded text-[10px] font-bold transition-all ${track.isSolo ? 'bg-yellow-500 text-black' : 'bg-white/10 text-white/50 hover:bg-white/20'}`}>S</button>
          {track.type === TrackType.AUDIO && (
            <button onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isArmed: !track.isArmed }); }} className={`w-6 h-6 rounded text-[10px] font-bold transition-all ${track.isArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/10 text-white/50 hover:bg-white/20'}`}>R</button>
          )}
        </div>
      </div>

      {/* ROW 2 */}
      <div className="flex items-center h-6 px-2 gap-2">
        <div className="w-2 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: track.color || '#06b6d4' }} />
        <input type="range" min="0" max="1" step="0.01" value={track.volume} onChange={(e) => onUpdateTrack({ ...track, volume: parseFloat(e.target.value) })} className="flex-1 h-1.5 appearance-none bg-white/10 rounded-full cursor-pointer" onClick={(e) => e.stopPropagation()} />
        <span className="text-white/50 text-[10px] w-8 text-right">{Math.round(track.volume * 100)}%</span>
      </div>

      {/* ROW 3: plugins */}
      {track.plugins && track.plugins.length > 0 && (
        <div className="flex items-center h-6 px-2 gap-1 overflow-x-auto">
          {track.plugins.slice(0, 4).map((plugin: any) => (
            <div key={plugin.id} className="h-5 px-2 bg-white/5 rounded text-[9px] text-white/50 flex items-center">{plugin.name.substring(0, 8)}</div>
          ))}
          <button onClick={(e) => { e.stopPropagation(); /* ouvrir plugin browser */ }} className="w-5 h-5 rounded bg-white/5 text-white/30 text-[10px] hover:bg-white/10">+</button>
        </div>
      )}
    </div>
  );
};

export default TrackHeader;
