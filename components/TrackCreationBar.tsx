import React, { useState } from 'react';
import { TrackType, PluginType } from '../types';

interface TrackCreationBarProps {
  onCreateTrack: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
}

const TrackCreationBar: React.FC<TrackCreationBarProps> = ({ onCreateTrack }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const trackTypes = [
    { type: TrackType.AUDIO, icon: 'fa-wave-square', label: 'Audio', name: 'New Audio', color: '#3b82f6' },
    { type: TrackType.BUS, icon: 'fa-layer-group', label: 'Bus', name: 'New Bus', color: '#fbbf24' },
    { type: TrackType.SEND, icon: 'fa-share-alt', label: 'Send', name: 'New Send', color: '#a855f7' },
  ];

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] flex flex-col items-center gap-2">
      {/* Expanded panel with track creation buttons */}
      {isExpanded && (
        <div className="bg-[#0c0d10]/95 backdrop-blur-xl border border-white/20 rounded-2xl p-3 flex gap-2 shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200">
          {trackTypes.map((item, idx) => (
            <button
              key={`${item.type}-${idx}`}
              onClick={() => {
                onCreateTrack(item.type, item.name, (item as any).plugin);
                setIsExpanded(false); // Auto-close after creating
              }}
              className="w-14 h-14 rounded-xl bg-white/5 hover:bg-white/15 active:scale-95 border border-white/10 text-white/80 hover:text-white transition-all flex flex-col items-center justify-center gap-0.5 group"
              style={{ borderColor: item.color + '40' }}
              title={item.name}
            >
              <i 
                className={`fas ${item.icon} text-base transition-transform group-hover:scale-110`}
                style={{ color: item.color }}
              ></i>
              <span className="text-[7px] font-black uppercase tracking-wider opacity-70">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Toggle button - Always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all active:scale-95 ${
          isExpanded 
            ? 'bg-cyan-500 text-white rotate-45 shadow-cyan-500/30' 
            : 'bg-[#1a1c21] border border-white/20 text-white/60 hover:text-white hover:border-cyan-500/50'
        }`}
      >
        <i className={`fas fa-plus text-lg transition-transform ${isExpanded ? '' : ''}`}></i>
      </button>
    </div>
  );
};

export default TrackCreationBar;
