import React from 'react';
import { Track, PluginInstance } from '../../../types';

interface PluginsPanelProps {
  selectedTrack: Track | null;
  onUpdateTrack: (track: Track) => void;
  onOpenPlugin: (trackId: string, plugin: PluginInstance) => void;
}

const PluginsPanel: React.FC<PluginsPanelProps> = ({ 
  selectedTrack, 
  onUpdateTrack, 
  onOpenPlugin 
}) => {
  if (!selectedTrack) {
    return (
      <div className="p-8 text-center text-white/50">
        <i className="fas fa-hand-pointer text-4xl mb-4 block"></i>
        <p>Sélectionnez une piste pour voir ses plugins</p>
      </div>
    );
  }
  
  const handleTogglePlugin = (pluginId: string) => {
    const updatedPlugins = selectedTrack.plugins.map(p => 
      p.id === pluginId ? { ...p, isEnabled: !p.isEnabled } : p
    );
    onUpdateTrack({ ...selectedTrack, plugins: updatedPlugins });
  };
  
  return (
    <div className="p-4 pb-safe">
      <div className="mb-4 flex items-center gap-3">
        <div 
          className="w-3 h-3 rounded-full" 
          style={{ backgroundColor: selectedTrack.color }} 
        />
        <span className="text-white font-bold">{selectedTrack.name}</span>
      </div>
      
      <div className="space-y-2">
        {selectedTrack.plugins.map((plugin, index) => (
          <div 
            key={plugin.id}
            className="bg-white/5 rounded-xl p-4 flex items-center justify-between hover:bg-white/10 transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="w-6 h-6 rounded bg-white/10 text-white/50 text-xs flex items-center justify-center">
                {index + 1}
              </span>
              <span className="text-white">{plugin.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleTogglePlugin(plugin.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
                  plugin.isEnabled 
                    ? 'bg-cyan-500 text-black' 
                    : 'bg-white/10 text-white/50'
                }`}
              >
                {plugin.isEnabled ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => onOpenPlugin(selectedTrack.id, plugin)}
                className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
              >
                <i className="fas fa-sliders-h text-white/70"></i>
              </button>
            </div>
          </div>
        ))}
        
        {selectedTrack.plugins.length === 0 && (
          <div className="text-center py-8 text-white/30">
            <i className="fas fa-puzzle-piece text-3xl mb-2 block"></i>
            <p>Aucun plugin sur cette piste</p>
          </div>
        )}
        
        {/* Add plugin button */}
        <button 
          className="w-full h-14 border-2 border-dashed border-white/20 rounded-xl text-white/50 flex items-center justify-center gap-2 hover:border-cyan-500/50 hover:text-cyan-400 transition-all"
        >
          <i className="fas fa-plus"></i>
          <span>Ajouter un plugin</span>
        </button>
      </div>
    </div>
  );
};

export default PluginsPanel;
