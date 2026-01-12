import React from 'react';
import { Track } from '../../types';

interface MobileTrackDetailProps {
  track: Track;
  onClose: () => void;
  onUpdate: (track: Track) => void;
}

const MobileTrackDetail: React.FC<MobileTrackDetailProps> = ({ track, onClose, onUpdate }) => {
  return (
    <div className="fixed inset-0 bg-[#0a0b0d] z-50 flex flex-col">
      {/* Header avec bouton retour */}
      <div className="h-14 flex items-center px-5 border-b border-white/10 flex-shrink-0">
        <button 
          onClick={onClose} 
          className="w-10 h-10 flex items-center justify-center active:bg-white/10 rounded-lg transition-colors"
        >
          <i className="fas fa-arrow-left text-white"></i>
        </button>
        <div className="flex-1 text-center">
          <span className="text-white font-bold">{track.name}</span>
        </div>
        <div className="w-10" /> {/* Spacer */}
      </div>
      
      {/* Contenu avec marges de sécurité */}
      <div className="flex-1 overflow-y-auto px-5 py-6">
        {/* Gros boutons M/S/R */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <button 
            onClick={() => onUpdate({ ...track, isMuted: !track.isMuted })}
            className={`h-16 rounded-2xl text-xl font-black transition-all active:scale-95 ${
              track.isMuted ? 'bg-red-500 text-white' : 'bg-white/10 text-white/50'
            }`}
          >
            MUTE
          </button>
          <button 
            onClick={() => onUpdate({ ...track, isSolo: !track.isSolo })}
            className={`h-16 rounded-2xl text-xl font-black transition-all active:scale-95 ${
              track.isSolo ? 'bg-yellow-500 text-black' : 'bg-white/10 text-white/50'
            }`}
          >
            SOLO
          </button>
          <button 
            onClick={() => onUpdate({ ...track, isTrackArmed: !track.isTrackArmed })}
            className={`h-16 rounded-2xl text-xl font-black transition-all ${
              track.isTrackArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/10 text-white/50 active:scale-95'
            }`}
          >
            REC
          </button>
        </div>
        
        {/* Volume Slider GRAND */}
        <div className="mb-8">
          <label className="text-white/50 text-sm mb-2 block">VOLUME</label>
          <input 
            type="range" 
            min="0" 
            max="1" 
            step="0.01" 
            value={track.volume}
            onChange={(e) => onUpdate({ ...track, volume: parseFloat(e.target.value) })}
            className="w-full h-12 appearance-none bg-white/10 rounded-full cursor-pointer"
            style={{
              WebkitAppearance: 'none',
            }}
          />
          <div className="text-center text-white text-2xl font-bold mt-2">
            {Math.round(track.volume * 100)}%
          </div>
        </div>
        
        {/* Pan Slider */}
        <div className="mb-8">
          <label className="text-white/50 text-sm mb-2 block">PAN</label>
          <input 
            type="range" 
            min="-1" 
            max="1" 
            step="0.01" 
            value={track.pan}
            onChange={(e) => onUpdate({ ...track, pan: parseFloat(e.target.value) })}
            className="w-full h-12 appearance-none bg-white/10 rounded-full cursor-pointer"
            style={{
              WebkitAppearance: 'none',
            }}
          />
          <div className="text-center text-white text-lg font-bold mt-2">
            {track.pan === 0 
              ? 'C' 
              : track.pan < 0 
                ? `L${Math.round(Math.abs(track.pan) * 100)}` 
                : `R${Math.round(track.pan * 100)}`
            }
          </div>
        </div>
        
        {/* Liste des plugins */}
        <div className="mb-8">
          <label className="text-white/50 text-sm mb-2 block">PLUGINS ({track.plugins.length})</label>
          <div className="space-y-2">
            {track.plugins.map(plugin => (
              <div 
                key={plugin.id} 
                className="bg-white/5 rounded-xl p-4 flex items-center justify-between"
              >
                <span className="text-white">{plugin.name}</span>
                <button 
                  onClick={() => {
                    const updatedPlugins = track.plugins.map(p => 
                      p.id === plugin.id ? { ...p, isEnabled: !p.isEnabled } : p
                    );
                    onUpdate({ ...track, plugins: updatedPlugins });
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all active:scale-95 ${
                    plugin.isEnabled ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white/50'
                  }`}
                >
                  {plugin.isEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            ))}
            {track.plugins.length === 0 && (
              <div className="text-white/30 text-center py-4">Aucun plugin</div>
            )}
          </div>
        </div>
        
        {/* Clips info */}
        {track.clips.length > 0 && (
          <div className="mb-8">
            <label className="text-white/50 text-sm mb-2 block">CLIPS ({track.clips.length})</label>
            <div className="space-y-2">
              {track.clips.map(clip => (
                <div 
                  key={clip.id} 
                  className="bg-white/5 rounded-xl p-4"
                >
                  <div className="text-white font-medium">{clip.name}</div>
                  <div className="text-white/50 text-xs mt-1">
                    {clip.duration.toFixed(2)}s • Start: {clip.start.toFixed(2)}s
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MobileTrackDetail;
