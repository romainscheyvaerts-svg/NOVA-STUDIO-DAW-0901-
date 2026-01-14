import React, { useState } from 'react';
import MobileContainer from './MobileContainer';
import { Track, PluginInstance } from '../types';

interface MobileMixerPageProps {
  tracks: Track[];
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onUpdateTrack: (track: Track) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
  onOpenPlugin?: (trackId: string, pluginId: string) => void;
  onToggleBypass?: (trackId: string, pluginId: string) => void;
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void;
}

/**
 * Page mobile pour le mixage
 * Affiche une piste à la fois avec tous ses contrôles
 */
const MobileMixerPage: React.FC<MobileMixerPageProps> = ({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onUpdateTrack,
  onRemovePlugin,
  onOpenPlugin,
  onToggleBypass,
  onRequestAddPlugin
}) => {
  const visibleTracks = tracks.filter(t => t.id !== 'master');
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);

  const currentTrack = visibleTracks[currentTrackIndex];

  const handlePrevTrack = () => {
    if (currentTrackIndex > 0) {
      setCurrentTrackIndex(currentTrackIndex - 1);
      onSelectTrack(visibleTracks[currentTrackIndex - 1].id);
    }
  };

  const handleNextTrack = () => {
    if (currentTrackIndex < visibleTracks.length - 1) {
      setCurrentTrackIndex(currentTrackIndex + 1);
      onSelectTrack(visibleTracks[currentTrackIndex + 1].id);
    }
  };

  if (!currentTrack) {
    return (
      <MobileContainer title="Mixer">
        <div className="text-center py-12 text-slate-500">
          <i className="fas fa-sliders-h text-4xl mb-4 opacity-30"></i>
          <p>Aucune piste à mixer</p>
        </div>
      </MobileContainer>
    );
  }

  const insertPlugins = currentTrack.plugins.filter(p =>
    p.type !== 'MELODIC_SAMPLER' && p.type !== 'DRUM_SAMPLER'
  );

  return (
    <MobileContainer
      title="Mixer"
      headerAction={
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrevTrack}
            disabled={currentTrackIndex === 0}
            className="w-8 h-8 rounded-lg bg-white/5 disabled:opacity-30 flex items-center justify-center"
          >
            <i className="fas fa-chevron-left text-xs"></i>
          </button>
          <span className="text-xs text-slate-400 min-w-[60px] text-center">
            {currentTrackIndex + 1} / {visibleTracks.length}
          </span>
          <button
            onClick={handleNextTrack}
            disabled={currentTrackIndex === visibleTracks.length - 1}
            className="w-8 h-8 rounded-lg bg-white/5 disabled:opacity-30 flex items-center justify-center"
          >
            <i className="fas fa-chevron-right text-xs"></i>
          </button>
        </div>
      }
    >
      <div className="space-y-6 pb-20">
        {/* Nom de la piste */}
        <div className="bg-[#14161a] rounded-xl p-4 border border-white/10">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
              style={{ backgroundColor: currentTrack.color }}
            >
              {currentTrack.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <h2 className="text-white font-bold">{currentTrack.name}</h2>
              <p className="text-xs text-slate-500">{currentTrack.type}</p>
            </div>
          </div>

          {/* Faders Volume & Pan */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-2 block">Volume</label>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.01"
                value={currentTrack.volume}
                onChange={(e) => onUpdateTrack({ ...currentTrack, volume: parseFloat(e.target.value) })}
                className="w-full"
              />
              <div className="text-center text-xs text-cyan-400 mt-1">
                {Math.round(currentTrack.volume * 100)}%
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400 mb-2 block">Pan</label>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value={currentTrack.pan}
                onChange={(e) => onUpdateTrack({ ...currentTrack, pan: parseFloat(e.target.value) })}
                className="w-full"
              />
              <div className="text-center text-xs text-cyan-400 mt-1">
                {currentTrack.pan === 0 ? 'C' : currentTrack.pan > 0 ? `R${Math.round(currentTrack.pan * 100)}` : `L${Math.round(Math.abs(currentTrack.pan) * 100)}`}
              </div>
            </div>
          </div>

          {/* Boutons Mute/Solo */}
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => onUpdateTrack({ ...currentTrack, isMuted: !currentTrack.isMuted })}
              className={`flex-1 py-3 rounded-lg font-bold text-xs transition-all ${
                currentTrack.isMuted
                  ? 'bg-orange-500 text-white'
                  : 'bg-white/5 text-slate-400'
              }`}
            >
              <i className="fas fa-volume-mute mr-2"></i>
              MUTE
            </button>
            <button
              onClick={() => onUpdateTrack({ ...currentTrack, isSolo: !currentTrack.isSolo })}
              className={`flex-1 py-3 rounded-lg font-bold text-xs transition-all ${
                currentTrack.isSolo
                  ? 'bg-yellow-500 text-black'
                  : 'bg-white/5 text-slate-400'
              }`}
            >
              <i className="fas fa-star mr-2"></i>
              SOLO
            </button>
          </div>
        </div>

        {/* Plugins/Inserts */}
        <div className="bg-[#14161a] rounded-xl p-4 border border-white/10">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-3">
            Inserts ({insertPlugins.length})
          </h3>

          <div className="space-y-2">
            {insertPlugins.map(plugin => (
              <div
                key={plugin.id}
                onClick={() => onOpenPlugin?.(currentTrack.id, plugin.id)}
                className="bg-black/30 rounded-lg p-3 flex items-center justify-between hover:bg-black/50 transition-all active:scale-95"
              >
                <div className="flex items-center gap-3 flex-1">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    plugin.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'
                  }`}>
                    <i className="fas fa-plug text-xs"></i>
                  </div>
                  <span className={`text-sm font-medium ${
                    plugin.isEnabled ? 'text-white' : 'text-slate-600'
                  }`}>
                    {plugin.name}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleBypass?.(currentTrack.id, plugin.id);
                    }}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                      plugin.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'
                    }`}
                  >
                    <i className="fas fa-power-off text-xs"></i>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemovePlugin?.(currentTrack.id, plugin.id);
                    }}
                    className="w-8 h-8 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center hover:bg-red-500/30"
                  >
                    <i className="fas fa-trash text-xs"></i>
                  </button>
                </div>
              </div>
            ))}

            {insertPlugins.length === 0 && (
              <div className="text-center py-8 text-slate-600 text-xs">
                Aucun plugin
              </div>
            )}

            {/* Boutons pour ajouter des plugins */}
            {insertPlugins.length < 6 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onRequestAddPlugin) {
                    onRequestAddPlugin(currentTrack.id, e.clientX, e.clientY);
                  }
                }}
                className="w-full py-3 rounded-lg border border-dashed border-white/10 text-slate-500 hover:border-cyan-500/50 hover:text-cyan-400 transition-all flex items-center justify-center gap-2"
              >
                <i className="fas fa-plus text-xs"></i>
                <span className="text-xs font-medium">Ajouter un plugin</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </MobileContainer>
  );
};

export default MobileMixerPage;
