import React from 'react';

interface MobileTransportBarProps {
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  onPlay: () => void;
  onStop: () => void;
  onRecord: () => void;
}

const MobileTransportBar: React.FC<MobileTransportBarProps> = ({ 
  isPlaying, 
  isRecording, 
  currentTime, 
  onPlay, 
  onStop, 
  onRecord 
}) => {
  const formatTime = (t: number) => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const ms = Math.floor((t % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-16 bg-black/80 backdrop-blur-xl border-b border-white/10 flex items-center justify-center px-5">
      <div className="flex items-center gap-4">
        {/* Stop */}
        <button 
          onClick={onStop} 
          className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center active:bg-white/20 transition-colors"
        >
          <i className="fas fa-stop text-white"></i>
        </button>
        
        {/* Play/Pause */}
        <button 
          onClick={onPlay} 
          className="w-16 h-16 rounded-full bg-cyan-500 flex items-center justify-center shadow-lg shadow-cyan-500/30 active:scale-95 transition-transform"
        >
          <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-black text-xl`}></i>
        </button>
        
        {/* Record */}
        <button 
          onClick={onRecord} 
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95 ${
            isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/10 active:bg-white/20'
          }`}
        >
          <i className="fas fa-circle text-red-500"></i>
        </button>
        
        {/* Time Display */}
        <div className="bg-black/60 px-4 py-2 rounded-xl">
          <span className="text-white font-mono text-lg">{formatTime(currentTime)}</span>
        </div>
      </div>
    </div>
  );
};

export default MobileTransportBar;
