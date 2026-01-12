import React from 'react';
import { Track, TrackType } from '../../../types';

interface TrackDetailPanelProps {
  track: Track | null;
  onUpdateTrack: (track: Track) => void;
  onDeleteTrack?: (trackId: string) => void;
  onOpenPlugin?: (trackId: string, pluginId: string) => void;
}

const TrackDetailPanel: React.FC<TrackDetailPanelProps> = ({ 
  track, 
  onUpdateTrack,
  onDeleteTrack = () => {},
  onOpenPlugin = () => {}
}) => {
  if (!track) {
    return (
      <div className="p-8 text-center text-white/50">
        <i className="fas fa-music text-4xl mb-4 block"></i>
        <p>Sélectionnez une piste pour voir les détails</p>
      </div>
    );
  }
  
  const isAudioTrack = track.type === TrackType.AUDIO || track.type.toString().includes('VOCAL');
  
  return (
    <div className="p-4 pb-safe space-y-6">
      {/* Track name */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-2 block">NOM DE LA PISTE</label>
        <input
          type="text"
          value={track.name}
          onChange={(e) => onUpdateTrack({ ...track, name: e.target.value })}
          className="w-full bg-white/10 text-white px-4 py-3 rounded-xl font-bold text-lg border-2 border-white/20 focus:border-cyan-500 outline-none transition-colors"
        />
      </div>
      
      {/* M/S/R Buttons */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-3 block">CONTRÔLES</label>
        <div className="flex gap-3">
          <button
            onClick={() => onUpdateTrack({ ...track, isMuted: !track.isMuted })}
            className={`flex-1 h-16 rounded-xl text-lg font-bold transition-all ${
              track.isMuted
                ? 'bg-red-500 text-white'
                : 'bg-white/10 text-white/70 hover:bg-white/20'
            }`}
          >
            <i className="fas fa-volume-mute mr-2"></i>
            MUTE
          </button>
          <button
            onClick={() => onUpdateTrack({ ...track, isSolo: !track.isSolo })}
            className={`flex-1 h-16 rounded-xl text-lg font-bold transition-all ${
              track.isSolo
                ? 'bg-yellow-500 text-black'
                : 'bg-white/10 text-white/70 hover:bg-white/20'
            }`}
          >
            <i className="fas fa-headphones mr-2"></i>
            SOLO
          </button>
          {isAudioTrack && (
            <button
              onClick={() => onUpdateTrack({ ...track, isTrackArmed: !track.isTrackArmed })}
              className={`flex-1 h-16 rounded-xl text-lg font-bold transition-all ${
                track.isTrackArmed
                  ? 'bg-red-600 text-white'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              <i className="fas fa-circle mr-2"></i>
              REC
            </button>
          )}
        </div>
      </div>
      
      {/* Volume slider */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-2 block">VOLUME</label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={track.volume}
          onChange={(e) => onUpdateTrack({ ...track, volume: parseFloat(e.target.value) })}
          className="w-full h-3 appearance-none bg-white/10 rounded-lg cursor-pointer"
          style={{ accentColor: track.color }}
        />
        <div className="text-white text-center mt-2 font-mono text-2xl font-bold">
          {Math.round(track.volume * 100)}%
        </div>
      </div>
      
      {/* Pan slider */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-2 block">PANORAMIQUE</label>
        <input
          type="range"
          min="-1"
          max="1"
          step="0.01"
          value={track.pan}
          onChange={(e) => onUpdateTrack({ ...track, pan: parseFloat(e.target.value) })}
          className="w-full h-3 appearance-none bg-white/10 rounded-lg cursor-pointer"
          style={{ accentColor: track.color }}
        />
        <div className="text-white text-center mt-2 font-mono">
          {track.pan < -0.01 ? `L ${Math.abs(Math.round(track.pan * 100))}` : 
           track.pan > 0.01 ? `R ${Math.round(track.pan * 100)}` : 
           'CENTER'}
        </div>
      </div>
      
      {/* Plugins list */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-3 block">PLUGINS ({track.plugins.length})</label>
        <div className="space-y-2">
          {track.plugins.map((plugin, index) => (
            <div 
              key={plugin.id}
              className="bg-white/5 rounded-lg p-3 flex items-center justify-between"
            >
              <span className="text-white text-sm">{plugin.name}</span>
              <span className={`px-2 py-1 rounded text-xs font-bold ${
                plugin.isEnabled ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white/50'
              }`}>
                {plugin.isEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
          ))}
          {track.plugins.length === 0 && (
            <p className="text-white/30 text-sm text-center py-4">Aucun plugin</p>
          )}
        </div>
      </div>
      
      {/* Delete button */}
      <button
        onClick={() => onDeleteTrack(track.id)}
        className="w-full h-14 bg-red-500/20 text-red-400 rounded-xl font-bold hover:bg-red-500/30 transition-colors"
      >
        <i className="fas fa-trash mr-2"></i>
        Supprimer la piste
      </button>
    </div>
  );
};

export default TrackDetailPanel;
