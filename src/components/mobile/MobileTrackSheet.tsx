import React, { useState } from 'react';
import { Track, PluginType } from '../../types';
import MobileBottomSheet from './MobileBottomSheet';
import { useBottomSheet } from '../../hooks/useBottomSheet';

interface MobileTrackSheetProps {
  track: Track;
  isOpen: boolean;
  onClose: () => void;
  onUpdateTrack: (track: Track) => void;
  onAddPlugin?: (trackId: string, type: PluginType) => void;
  onDeleteTrack?: (trackId: string) => void;
}

/**
 * Bottom sheet for editing track details
 * Opens when tapping on a track
 */
const MobileTrackSheet: React.FC<MobileTrackSheetProps> = ({
  track,
  isOpen,
  onClose,
  onUpdateTrack,
  onAddPlugin,
  onDeleteTrack,
}) => {
  const [trackName, setTrackName] = useState(track.name);
  const [isEditingName, setIsEditingName] = useState(false);

  const {
    state,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    getHeight,
    isDragging,
  } = useBottomSheet({
    onClose,
    defaultState: 'half',
  });

  const handleNameSave = () => {
    if (trackName.trim() && trackName !== track.name) {
      onUpdateTrack({ ...track, name: trackName.trim() });
    }
    setIsEditingName(false);
  };

  const colors = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e',
  ];

  return (
    <MobileBottomSheet
      isOpen={isOpen}
      state={state}
      onClose={onClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      height={getHeight()}
      isDragging={isDragging}
      title="Track Details"
    >
      <div className="px-6 pb-6 space-y-6">
        {/* Track Name */}
        <div>
          <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">
            Track Name
          </label>
          {isEditingName ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={trackName}
                onChange={(e) => setTrackName(e.target.value)}
                onBlur={handleNameSave}
                onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
                className="flex-1 px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white font-bold"
                autoFocus
              />
            </div>
          ) : (
            <button
              onClick={() => setIsEditingName(true)}
              className="w-full px-4 py-3 bg-white/10 rounded-xl text-white font-bold text-left hover:bg-white/15 transition-colors"
            >
              {track.name}
            </button>
          )}
        </div>

        {/* M/S/R Buttons */}
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => onUpdateTrack({ ...track, isMuted: !track.isMuted })}
            className={`py-6 rounded-xl font-black text-sm uppercase transition-all ${
              track.isMuted
                ? 'bg-red-500/30 border-2 border-red-500 text-red-400'
                : 'bg-white/10 border-2 border-white/10 text-slate-400'
            }`}
          >
            <i className="fas fa-volume-mute text-2xl mb-2 block"></i>
            Mute
          </button>

          <button
            onClick={() => onUpdateTrack({ ...track, isSolo: !track.isSolo })}
            className={`py-6 rounded-xl font-black text-sm uppercase transition-all ${
              track.isSolo
                ? 'bg-yellow-500/30 border-2 border-yellow-500 text-yellow-400'
                : 'bg-white/10 border-2 border-white/10 text-slate-400'
            }`}
          >
            <i className="fas fa-headphones text-2xl mb-2 block"></i>
            Solo
          </button>

          <button
            onClick={() => onUpdateTrack({ ...track, isTrackArmed: !track.isTrackArmed })}
            className={`py-6 rounded-xl font-black text-sm uppercase transition-all ${
              track.isTrackArmed
                ? 'bg-red-500/30 border-2 border-red-500 text-red-400 animate-pulse'
                : 'bg-white/10 border-2 border-white/10 text-slate-400'
            }`}
          >
            <i className="fas fa-circle text-2xl mb-2 block"></i>
            Record
          </button>
        </div>

        {/* Volume Slider */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold text-slate-500 uppercase">Volume</label>
            <span className="text-sm font-mono text-cyan-400">{Math.round(track.volume * 100)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.01"
            value={track.volume}
            onChange={(e) => onUpdateTrack({ ...track, volume: parseFloat(e.target.value) })}
            className="w-full h-3 rounded-full appearance-none bg-white/10"
            style={{
              accentColor: track.color,
            }}
          />
        </div>

        {/* Pan Slider */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold text-slate-500 uppercase">Pan</label>
            <span className="text-sm font-mono text-cyan-400">
              {track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.abs(Math.round(track.pan * 100))}` : `R${Math.round(track.pan * 100)}`}
            </span>
          </div>
          <input
            type="range"
            min="-1"
            max="1"
            step="0.01"
            value={track.pan}
            onChange={(e) => onUpdateTrack({ ...track, pan: parseFloat(e.target.value) })}
            className="w-full h-3 rounded-full appearance-none bg-white/10"
            style={{
              accentColor: track.color,
            }}
          />
        </div>

        {/* Color Picker */}
        <div>
          <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">
            Track Color
          </label>
          <div className="grid grid-cols-9 gap-2">
            {colors.map((color) => (
              <button
                key={color}
                onClick={() => onUpdateTrack({ ...track, color })}
                className={`w-full aspect-square rounded-lg transition-all ${
                  track.color === color
                    ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0c0d10] scale-110'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="space-y-3 pt-4 border-t border-white/10">
          <button
            onClick={() => {
              // TODO: Open plugin browser
              onClose();
            }}
            className="w-full py-4 rounded-xl bg-cyan-500/20 border border-cyan-500/50 text-cyan-400 font-bold flex items-center justify-center gap-2 hover:bg-cyan-500/30 transition-colors"
          >
            <i className="fas fa-magic"></i>
            Add Plugin
          </button>

          <button
            onClick={() => {
              // TODO: Open automation editor
              onClose();
            }}
            className="w-full py-4 rounded-xl bg-purple-500/20 border border-purple-500/50 text-purple-400 font-bold flex items-center justify-center gap-2 hover:bg-purple-500/30 transition-colors"
          >
            <i className="fas fa-wave-square"></i>
            Automation
          </button>

          {onDeleteTrack && (
            <button
              onClick={() => {
                if (confirm(`Delete track "${track.name}"?`)) {
                  onDeleteTrack(track.id);
                  onClose();
                }
              }}
              className="w-full py-4 rounded-xl bg-red-500/20 border border-red-500/50 text-red-400 font-bold flex items-center justify-center gap-2 hover:bg-red-500/30 transition-colors"
            >
              <i className="fas fa-trash"></i>
              Delete Track
            </button>
          )}
        </div>
      </div>
    </MobileBottomSheet>
  );
};

export default MobileTrackSheet;
