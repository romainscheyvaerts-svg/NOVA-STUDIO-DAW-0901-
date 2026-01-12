import React, { useState } from 'react';

interface SettingsPanelProps {
  bpm: number;
  onBpmChange: (bpm: number) => void;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ bpm, onBpmChange }) => {
  const [tapTimes, setTapTimes] = useState<number[]>([]);
  
  const handleTapTempo = () => {
    const now = Date.now();
    const newTaps = [...tapTimes, now].filter(t => now - t < 3000).slice(-4);
    setTapTimes(newTaps);
    
    if (newTaps.length >= 2) {
      const intervals = newTaps.slice(1).map((t, i) => t - newTaps[i]);
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const newBpm = Math.round(60000 / avgInterval);
      if (newBpm >= 40 && newBpm <= 240) {
        onBpmChange(newBpm);
      }
    }
  };
  
  return (
    <div className="p-4 space-y-6 pb-safe">
      {/* BPM Section */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-3 block font-bold">TEMPO</label>
        <div className="flex items-center justify-between">
          <button 
            onClick={() => onBpmChange(Math.max(40, bpm - 1))}
            className="w-14 h-14 rounded-xl bg-white/10 text-white text-2xl hover:bg-white/20 transition-colors active:scale-95"
          >
            -
          </button>
          <div className="text-center">
            <div className="text-white text-5xl font-bold font-mono">{bpm}</div>
            <div className="text-white/50 text-sm">BPM</div>
          </div>
          <button 
            onClick={() => onBpmChange(Math.min(240, bpm + 1))}
            className="w-14 h-14 rounded-xl bg-white/10 text-white text-2xl hover:bg-white/20 transition-colors"
          >
            +
          </button>
        </div>
        
        {/* Tap Tempo */}
        <button 
          onClick={handleTapTempo}
          className="w-full h-14 mt-4 rounded-xl bg-cyan-500/20 text-cyan-400 font-bold active:bg-cyan-500/30 transition-colors"
        >
          <i className="fas fa-hand-pointer mr-2"></i>
          TAP TEMPO
        </button>
      </div>
      
      {/* Export Section */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-3 block">EXPORT</label>
        <div className="space-y-2">
          <button className="w-full h-12 rounded-xl bg-white/10 text-white flex items-center justify-center gap-2 hover:bg-white/20 transition-colors">
            <i className="fas fa-file-audio"></i>
            Exporter WAV
          </button>
          <button className="w-full h-12 rounded-xl bg-white/10 text-white flex items-center justify-center gap-2 hover:bg-white/20 transition-colors">
            <i className="fas fa-file-audio"></i>
            Exporter MP3
          </button>
        </div>
      </div>
      
      {/* Project Section */}
      <div className="bg-white/5 rounded-2xl p-4">
        <label className="text-white/50 text-sm mb-3 block">PROJET</label>
        <div className="space-y-2">
          <button className="w-full h-12 rounded-xl bg-white/10 text-white flex items-center justify-center gap-2 hover:bg-white/20 transition-colors">
            <i className="fas fa-save"></i>
            Sauvegarder
          </button>
          <button className="w-full h-12 rounded-xl bg-white/10 text-white flex items-center justify-center gap-2 hover:bg-white/20 transition-colors">
            <i className="fas fa-folder-open"></i>
            Ouvrir projet
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
