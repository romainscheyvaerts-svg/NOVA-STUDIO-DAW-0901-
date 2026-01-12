import React, { useState } from 'react';
import { Track, AutomationLane } from '../../../types';

interface AutomationPanelProps {
  selectedTrack: Track | null;
  onUpdateTrack?: (track: Track) => void;
}

const AutomationPanel: React.FC<AutomationPanelProps> = ({ 
  selectedTrack,
  onUpdateTrack = () => {}
}) => {
  const [selectedParam, setSelectedParam] = useState('volume');
  
  if (!selectedTrack) {
    return (
      <div className="p-8 text-center text-white/50">
        <i className="fas fa-chart-line text-4xl mb-4 block"></i>
        <p>Sélectionnez une piste pour voir les automations</p>
      </div>
    );
  }
  
  const availableParams = [
    { id: 'volume', label: 'Volume', icon: 'fa-volume-up' },
    { id: 'pan', label: 'Pan', icon: 'fa-arrows-alt-h' },
    { id: 'filter', label: 'Filter', icon: 'fa-filter' },
    { id: 'resonance', label: 'Resonance', icon: 'fa-wave-square' },
  ];
  
  const currentAutomation = selectedTrack.automationLanes.find(
    lane => lane.parameterName === selectedParam
  );
  
  return (
    <div className="flex flex-col h-full pb-safe">
      {/* Track info */}
      <div className="p-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div 
            className="w-3 h-3 rounded-full" 
            style={{ backgroundColor: selectedTrack.color }} 
          />
          <span className="text-white font-bold">{selectedTrack.name}</span>
        </div>
      </div>
      
      {/* Parameter selector */}
      <div className="p-4 border-b border-white/10">
        <label className="text-white/50 text-sm mb-2 block">PARAMÈTRE</label>
        <div className="grid grid-cols-2 gap-2">
          {availableParams.map(param => (
            <button
              key={param.id}
              onClick={() => setSelectedParam(param.id)}
              className={`h-12 rounded-xl font-bold transition-all flex items-center justify-center gap-2 ${
                selectedParam === param.id
                  ? 'bg-cyan-500 text-black'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              <i className={`fas ${param.icon}`}></i>
              {param.label}
            </button>
          ))}
        </div>
      </div>
      
      {/* Automation visualization */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="bg-white/5 rounded-2xl p-4 h-64 relative">
          {/* Placeholder automation curve visualization */}
          <div className="absolute inset-4 border border-white/20 rounded-lg">
            <div className="absolute inset-0 flex items-center justify-center text-white/30">
              <div className="text-center">
                <i className="fas fa-chart-line text-4xl mb-2 block"></i>
                <p>Courbe d'automation</p>
                {currentAutomation && (
                  <p className="text-sm mt-2">
                    {currentAutomation.points.length} points
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
        
        {/* Automation controls */}
        <div className="mt-4 space-y-2">
          <button className="w-full h-12 bg-white/10 rounded-xl text-white font-bold hover:bg-white/20 transition-colors">
            <i className="fas fa-plus mr-2"></i>
            Ajouter un point
          </button>
          <button className="w-full h-12 bg-white/10 rounded-xl text-white font-bold hover:bg-white/20 transition-colors">
            <i className="fas fa-eraser mr-2"></i>
            Effacer l'automation
          </button>
        </div>
        
        {/* Info */}
        <div className="mt-4 p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-xl">
          <p className="text-cyan-400 text-sm">
            <i className="fas fa-info-circle mr-2"></i>
            Tapez sur la grille pour ajouter des points d'automation
          </p>
        </div>
      </div>
    </div>
  );
};

export default AutomationPanel;
