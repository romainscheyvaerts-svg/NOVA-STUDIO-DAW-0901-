import React from 'react';

interface MobileTransportBarProps {
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onToggleRecord: () => void;
  onOpenSettings?: () => void;
}

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

/**
 * Simplified transport bar for mobile
 * Only essential controls: Play/Pause, Stop, Record, Time display
 * Height: ~50px
 */
const MobileTransportBar: React.FC<MobileTransportBarProps> = ({
  isPlaying,
  isRecording,
  currentTime,
  onTogglePlay,
  onStop,
  onToggleRecord,
  onOpenSettings,
}) => {
  return (
    <div
      className="h-14 bg-[#08090b] border-b border-white/10 flex items-center justify-between px-4 flex-shrink-0"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Left: Settings/Menu Button */}
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center active:bg-white/10 transition-colors"
        >
          <i className="fas fa-bars text-slate-400 text-lg"></i>
        </button>
      )}

      {/* Center: Transport Controls */}
      <div className="flex items-center gap-2">
        {/* Stop */}
        <button
          onClick={onStop}
          className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center active:bg-white/10 transition-colors"
        >
          <i className="fas fa-stop text-slate-400 text-sm"></i>
        </button>

        {/* Play/Pause - Main button */}
        <button
          onClick={onTogglePlay}
          className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all shadow-lg ${
            isPlaying
              ? 'bg-cyan-500 shadow-cyan-500/30'
              : 'bg-gradient-to-tr from-cyan-500 to-blue-600 shadow-cyan-500/20'
          }`}
        >
          <i
            className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-white text-lg ${
              !isPlaying ? 'ml-0.5' : ''
            }`}
          ></i>
        </button>

        {/* Record */}
        <button
          onClick={onToggleRecord}
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
            isRecording
              ? 'bg-red-500 shadow-red-500/30 animate-pulse'
              : 'bg-white/5 active:bg-white/10'
          }`}
        >
          <i className={`fas fa-circle text-sm ${isRecording ? 'text-white' : 'text-red-500'}`}></i>
        </button>
      </div>

      {/* Right: Time Display */}
      <div className="font-mono text-sm text-cyan-400 font-bold min-w-[70px] text-right">
        {formatTime(currentTime)}
      </div>
    </div>
  );
};

export default MobileTransportBar;
