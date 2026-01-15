import React, { useState } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip } from '../types';
import TrackHeader from './TrackHeader';
import { getValidDestinations, getRouteLabel } from './RoutingManager';

interface MobileTracksPageProps {
  tracks: Track[];
  currentTime: number;
  isPlaying: boolean;
  isRecording: boolean;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onUpdateTrack: (track: Track) => void;
  onAddClip?: (trackId: string, clip: Clip) => void;
  onEditClip?: (clip: Clip) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
  onAddPlugin?: (trackId: string) => void;
  onOpenPlugin?: (trackId: string, pluginId: string) => void;
  onToggleBypass?: (trackId: string, pluginId: string) => void;
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void;
}

/**
 * Page mobile pour gérer les pistes (arrangement)
 * Inspiré de Logic Pro iPad - Vue liste verticale
 */
const MobileTracksPage: React.FC<MobileTracksPageProps> = ({
  tracks,
  currentTime,
  isPlaying,
  isRecording,
  selectedTrackId,
  onSelectTrack,
  onUpdateTrack,
  onRemovePlugin,
  onAddPlugin,
  onOpenPlugin,
  onToggleBypass,
  onRequestAddPlugin
}) => {
  const visibleTracks = tracks.filter(t => t.id !== 'master');

  return (
    <MobileContainer title="Pistes">
      <div className="space-y-3 pb-20">
        {visibleTracks.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <i className="fas fa-music text-4xl mb-4 opacity-30"></i>
            <p>Aucune piste</p>
            <p className="text-xs mt-2">Créez une piste pour commencer</p>
          </div>
        )}

        {visibleTracks.map(track => (
          <div
            key={track.id}
            className={`rounded-xl overflow-hidden transition-all ${
              selectedTrackId === track.id
                ? 'bg-cyan-500/10 ring-2 ring-cyan-500/50'
                : 'bg-[#14161a]'
            }`}
            onClick={() => onSelectTrack(track.id)}
          >
            <TrackHeader
              track={track}
              isSelected={selectedTrackId === track.id}
              onUpdate={onUpdateTrack}
              onRemovePlugin={onRemovePlugin}
              onAddPlugin={onAddPlugin}
              onOpenPlugin={onOpenPlugin}
              onToggleBypass={onToggleBypass}
              onSelectTrack={onSelectTrack}
            />

            {/* Clips de la piste */}
            <div className="px-4 pb-2">
              <div className="flex items-center gap-2 overflow-x-auto">
                {track.clips.length === 0 ? (
                  <div className="text-xs text-slate-600 py-2">
                    Aucun clip
                  </div>
                ) : (
                  track.clips.map(clip => (
                    <div
                      key={clip.id}
                      className="shrink-0 h-12 rounded-lg px-3 flex items-center justify-center text-xs font-medium"
                      style={{
                        width: `${Math.max(80, clip.duration * 20)}px`,
                        backgroundColor: `${track.color}40`,
                        borderLeft: `3px solid ${track.color}`
                      }}
                    >
                      <div className="truncate">{clip.name || 'Clip'}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Section Routing/Connexions (I/O) */}
            <div className="px-4 pb-3 border-t border-white/5 pt-3">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">
                Connexions
              </div>
              <div className="space-y-2">
                {/* INPUT - Uniquement pour la piste REC */}
                {track.id === 'track-rec-main' && (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-500/20 border border-green-500/30">
                      <i className="fas fa-arrow-right text-green-400 text-sm"></i>
                    </div>
                    <div className="flex-1">
                      <div className="text-[10px] text-slate-500 mb-1 font-bold uppercase">Input</div>
                      <select
                        value={track.inputDeviceId || 'none'}
                        onChange={(e) => {
                          e.stopPropagation();
                          onUpdateTrack({ ...track, inputDeviceId: e.target.value });
                        }}
                        className="w-full px-3 py-2 bg-black/60 border border-white/10 rounded-lg text-xs font-bold text-green-400 focus:border-green-500/50 focus:outline-none"
                      >
                        <option value="none">No Input</option>
                        <option value="mic-default">Mic / Line 1</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* OUTPUT - Toutes les pistes */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30">
                    <i className="fas fa-arrow-left text-amber-400 text-sm"></i>
                  </div>
                  <div className="flex-1">
                    <div className="text-[10px] text-slate-500 mb-1 font-bold uppercase">Output</div>
                    <select
                      value={track.outputTrackId || 'master'}
                      onChange={(e) => {
                        e.stopPropagation();
                        onUpdateTrack({ ...track, outputTrackId: e.target.value });
                      }}
                      className="w-full px-3 py-2 bg-black/60 border border-white/10 rounded-lg text-xs font-bold text-amber-400 focus:border-amber-500/50 focus:outline-none"
                    >
                      {getValidDestinations(track.id, tracks).map(dest => (
                        <option key={dest.id} value={dest.id}>
                          {dest.id === 'master' ? 'STEREO OUT (MASTER)' : dest.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* Section Plugins avec bouton + */}
            <div className="px-4 pb-4 border-t border-white/5 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                  Plugins ({track.plugins.length})
                </span>
                {onRequestAddPlugin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestAddPlugin(track.id, e.clientX, e.clientY);
                    }}
                    className="w-7 h-7 rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 active:bg-cyan-500/40 flex items-center justify-center text-cyan-400 transition-all"
                  >
                    <i className="fas fa-plus text-xs"></i>
                  </button>
                )}
              </div>

              {/* Liste des plugins */}
              {track.plugins.length === 0 ? (
                <div className="text-xs text-slate-600 text-center py-3 bg-white/5 rounded-lg border border-dashed border-white/10">
                  <i className="fas fa-plug text-lg mb-1 opacity-30"></i>
                  <p>Aucun plugin</p>
                  <p className="text-[10px] mt-1 opacity-70">Tap + pour ajouter</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {track.plugins.map(plugin => (
                    <div
                      key={plugin.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onOpenPlugin) onOpenPlugin(track.id, plugin.id);
                      }}
                      className={`p-2 rounded-lg border transition-all ${
                        plugin.isEnabled
                          ? 'bg-gradient-to-br from-cyan-500/10 to-blue-500/10 border-cyan-500/30'
                          : 'bg-white/5 border-white/10 opacity-50'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold text-cyan-400 uppercase">
                          {plugin.type}
                        </span>
                        {onToggleBypass && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleBypass(track.id, plugin.id);
                            }}
                            className={`w-4 h-4 rounded-full ${
                              plugin.isEnabled ? 'bg-cyan-500' : 'bg-slate-600'
                            }`}
                          />
                        )}
                      </div>
                      <div className="text-[9px] text-slate-400 truncate">
                        Tap to edit
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </MobileContainer>
  );
};

export default MobileTracksPage;
