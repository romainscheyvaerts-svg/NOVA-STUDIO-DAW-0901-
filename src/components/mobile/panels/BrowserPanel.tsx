import React, { useState } from 'react';

interface BrowserPanelProps {
  onSelectSample?: (url: string, name: string) => void;
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({ 
  onSelectSample = () => {} 
}) => {
  const [category, setCategory] = useState('drums');
  
  const categories = [
    { id: 'drums', icon: 'fa-drum', label: 'Drums' },
    { id: 'bass', icon: 'fa-guitar', label: 'Bass' },
    { id: 'synth', icon: 'fa-wave-square', label: 'Synth' },
    { id: 'vocals', icon: 'fa-microphone', label: 'Vocals' },
    { id: 'fx', icon: 'fa-magic', label: 'FX' },
  ];
  
  // Sample data for demonstration
  const samples = {
    drums: [
      { name: 'Kick 808 Hard', duration: '0.8s', rate: '44.1kHz' },
      { name: 'Snare Tight', duration: '0.5s', rate: '44.1kHz' },
      { name: 'Hi-Hat Closed', duration: '0.2s', rate: '44.1kHz' },
      { name: 'Clap Vintage', duration: '0.4s', rate: '44.1kHz' },
    ],
    bass: [
      { name: 'Sub Bass 1', duration: '2.0s', rate: '44.1kHz' },
      { name: 'Bass Pluck', duration: '1.5s', rate: '44.1kHz' },
    ],
    synth: [
      { name: 'Lead Saw', duration: '3.0s', rate: '44.1kHz' },
      { name: 'Pad Warm', duration: '5.0s', rate: '44.1kHz' },
    ],
    vocals: [
      { name: 'Vocal Chop 1', duration: '1.2s', rate: '44.1kHz' },
      { name: 'Vocal Phrase', duration: '2.5s', rate: '44.1kHz' },
    ],
    fx: [
      { name: 'Riser Impact', duration: '2.0s', rate: '44.1kHz' },
      { name: 'White Noise', duration: '1.0s', rate: '44.1kHz' },
    ],
  };
  
  const currentSamples = samples[category as keyof typeof samples] || [];
  
  return (
    <div className="flex flex-col h-full pb-safe">
      {/* Category tabs */}
      <div className="flex gap-2 p-4 overflow-x-auto">
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setCategory(cat.id)}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-bold transition-all ${
              category === cat.id 
                ? 'bg-cyan-500 text-black' 
                : 'bg-white/10 text-white/70 hover:bg-white/20'
            }`}
          >
            <i className={`fas ${cat.icon} mr-2`}></i>
            {cat.label}
          </button>
        ))}
      </div>
      
      {/* Sample list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {currentSamples.map((sample, index) => (
          <div 
            key={index}
            className="bg-white/5 rounded-xl p-4 flex items-center justify-between active:bg-white/10 transition-colors"
          >
            <div className="flex items-center gap-3">
              <button className="w-10 h-10 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center hover:bg-cyan-500/30 transition-colors">
                <i className="fas fa-play text-sm"></i>
              </button>
              <div>
                <div className="text-white font-medium">{sample.name}</div>
                <div className="text-white/50 text-xs">
                  {sample.duration} • {sample.rate}
                </div>
              </div>
            </div>
            <button 
              onClick={() => onSelectSample('', sample.name)}
              className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
            >
              <i className="fas fa-plus text-white/70"></i>
            </button>
          </div>
        ))}
        
        {currentSamples.length === 0 && (
          <div className="text-center py-8 text-white/30">
            <i className="fas fa-folder-open text-3xl mb-2 block"></i>
            <p>Aucun sample dans cette catégorie</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowserPanel;
