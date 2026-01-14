import React from 'react';

interface MobileTransportProps {
  isPlaying: boolean;
  isRecording: boolean;
  isLoopActive: boolean;
  currentTime: number;
  bpm: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onToggleRecord: () => void;
  onToggleLoop: () => void;
  onBpmChange: (newBpm: number) => void;
  onOpenSettings?: () => void;
}

/**
 * Barre de transport mobile compacte
 * Affiche uniquement les contrôles essentiels pour mobile
 */
const MobileTransport: React.FC<MobileTransportProps> = ({
  isPlaying,
  isRecording,
  isLoopActive,
  currentTime,
  bpm,
  onTogglePlay,
  onStop,
  onToggleRecord,
  onToggleLoop,
  onBpmChange,
  onOpenSettings
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed top-0 left-0 right-0 h-16 bg-[#0c0d10] border-b border-white/10 flex items-center justify-between px-6 z-50 safe-area-top safe-area-inset-left safe-area-inset-right">
      {/* Section gauche - Temps et BPM */}
      <div className="flex items-center gap-3">
        {/* Timer */}
        <div className="text-cyan-400 font-mono text-sm font-bold min-w-[60px]">
          {formatTime(currentTime)}
        </div>

        {/* BPM */}
        <div className="flex items-center gap-1 bg-white/5 rounded-lg px-2 py-1 border border-white/10">
          <span className="text-xs text-slate-400">BPM</span>
          <input
            type="number"
            value={bpm}
            onChange={(e) => onBpmChange(parseInt(e.target.value) || 120)}
            className="w-12 bg-transparent text-white text-xs font-bold text-center focus:outline-none"
            min="60"
            max="200"
          />
        </div>
      </div>

      {/* Section centrale - Contrôles principaux */}
      <div className="flex items-center gap-2">
        {/* Stop */}
        <button
          onClick={onStop}
          className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center active:scale-95 transition-transform"
        >
          <i className="fas fa-stop text-slate-400 text-sm"></i>
        </button>

        {/* Play/Pause */}
        <button
          onClick={onTogglePlay}
          className={`w-11 h-11 rounded-full flex items-center justify-center transition-all active:scale-95 ${
            isPlaying
              ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/30'
              : 'bg-white text-black'
          }`}
        >
          <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-base`}></i>
        </button>

        {/* Record */}
        <button
          onClick={onToggleRecord}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all active:scale-95 ${
            isRecording
              ? 'bg-red-600 text-white animate-pulse'
              : 'bg-white/5 text-slate-400'
          }`}
        >
          <i className="fas fa-circle text-sm"></i>
        </button>
      </div>

      {/* Section droite - Loop et Settings */}
      <div className="flex items-center gap-2">
        {/* Loop */}
        <button
          onClick={onToggleLoop}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all active:scale-95 ${
            isLoopActive
              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50'
              : 'bg-white/5 text-slate-400'
          }`}
        >
          <i className="fas fa-sync-alt text-xs"></i>
        </button>

        {/* Settings */}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center active:scale-95 transition-transform"
          >
            <i className="fas fa-cog text-slate-400 text-sm"></i>
          </button>
        )}
      </div>
    </div>
  );
};

export default MobileTransport;
