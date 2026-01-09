import React from 'react';
import { TrackType, PluginType } from '../types';

interface TrackCreationBarProps {
  onCreateTrack: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
}

const TrackCreationBar: React.FC<TrackCreationBarProps> = ({ onCreateTrack }) => {
  const trackTypes = [
    { type: TrackType.AUDIO, icon: 'fa-wave-square', label: 'Audio', name: 'New Audio' },
    { type: TrackType.BUS, icon: 'fa-layer-group', label: 'Bus', name: 'New Bus' },
    { type: TrackType.SEND, icon: 'fa-share-alt', label: 'Send', name: 'New Send' },
  ];

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 bg-black/40 backdrop-blur-md border border-white/10 rounded-2xl p-2 flex space-x-2 shadow-2xl">
      {trackTypes.map((item, idx) => (
        <button
          key={`${item.type}-${idx}`}
          onClick={() => onCreateTrack(item.type, item.name, (item as any).plugin)}
          className="w-16 h-16 rounded-xl bg-white/5 hover:bg-cyan-500 hover:text-black border border-white/10 text-slate-400 hover:border-cyan-400 transition-all flex flex-col items-center justify-center space-y-1 group active:scale-95"
          title={item.name}
        >
          <i className={`fas ${item.icon} text-lg transition-transform group-hover:scale-110`}></i>
          <span className="text-[8px] font-black uppercase tracking-widest">{item.label}</span>
        </button>
      ))}
    </div>
  );
};

export default TrackCreationBar;