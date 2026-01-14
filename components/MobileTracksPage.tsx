import React, { useState } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip } from '../types';
import TrackHeader from './TrackHeader';

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
  onToggleBypass
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
            <div className="px-4 pb-4">
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
          </div>
        ))}
      </div>
    </MobileContainer>
  );
};

export default MobileTracksPage;
