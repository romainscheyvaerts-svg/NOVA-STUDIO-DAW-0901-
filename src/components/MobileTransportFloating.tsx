import React from 'react';

interface MobileTransportFloatingProps {
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onToggleRecord: () => void;
}

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

/**
 * Floating transport controls for mobile - always visible
 */
const MobileTransportFloating: React.FC<MobileTransportFloatingProps> = ({
  isPlaying,
  isRecording,
  currentTime,
  onTogglePlay,
  onStop,
  onToggleRecord
}) => {
  return (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2 bg-black/80 backdrop-blur-xl rounded-full px-3 py-2 border border-white/10 shadow-2xl">
      {/* Stop */}
      <button
        onClick={onStop}
        className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center active:bg-white/20 transition-colors"
      >
        <i className="fas fa-stop text-white text-sm"></i>
      </button>

      {/* Play/Pause - Main button */}
      <button
        onClick={onTogglePlay}
        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-lg ${
          isPlaying
            ? 'bg-cyan-500 shadow-cyan-500/30'
            : 'bg-gradient-to-tr from-cyan-500 to-blue-600 shadow-cyan-500/20'
        }`}
      >
        <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-white text-lg ${!isPlaying ? 'ml-0.5' : ''}`}></i>
      </button>

      {/* Record */}
      <button
        onClick={onToggleRecord}
        className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
          isRecording
            ? 'bg-red-500 shadow-red-500/30 animate-pulse'
            : 'bg-white/10 active:bg-white/20'
        }`}
      >
        <i className={`fas fa-circle text-sm ${isRecording ? 'text-white' : 'text-red-500'}`}></i>
      </button>

      {/* Time display */}
      <div className="font-mono text-sm text-white/90 px-2 min-w-[70px] text-center">
        {formatTime(currentTime)}
      </div>
    </div>
  );
};

export default MobileTransportFloating;
