import React, { useMemo } from 'react';
import { pluginManager } from '../../services/PluginManager'; // adapte si nécessaire
import { AVAILABLE_FX_MENU } from '../../config/availablePlugins'; // fallback

interface Plugin {
  id: string;
  name: string;
  icon?: string;
  category?: string;
}

interface Props {
  selectedTrack: any | undefined;
  onAddPlugin: (trackId: string, pluginId: string) => void;
}

const MobilePluginBrowser: React.FC<Props> = ({ selectedTrack, onAddPlugin }) => {
  const availablePlugins: Plugin[] = useMemo(() => {
    try {
      const fromManager = pluginManager?.getAvailablePlugins?.();
      if (fromManager && Array.isArray(fromManager)) return fromManager;
    } catch (e) {
      console.warn('[MobilePluginBrowser] pluginManager failed:', e);
    }
    return AVAILABLE_FX_MENU || [
      { id: 'PROEQ12', name: 'Pro-EQ 12', icon: 'fa-sliders-h' },
      { id: 'REVERB', name: 'Spatial Verb', icon: 'fa-water' },
      { id: 'DELAY', name: 'Sync Delay', icon: 'fa-clock' },
      { id: 'COMPRESSOR', name: 'Leveler', icon: 'fa-compress' },
      { id: 'AUTOTUNE', name: 'Auto-Tune Pro', icon: 'fa-microphone' },
      { id: 'DENOISER', name: 'Denoiser', icon: 'fa-wind' },
      { id: 'DEESSER', name: 'DeEsser', icon: 'fa-wind' },
    ];
  }, []);

  const categories = useMemo(() => {
    const map: Record<string, Plugin[]> = {};
    availablePlugins.forEach(p => {
      const cat = p.category || 'Autres';
      (map[cat] ||= []).push(p);
    });
    return Object.entries(map).map(([name, plugins]) => ({ name, plugins }));
  }, [availablePlugins]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0d]" style={{ paddingLeft: 'max(16px, env(safe-area-inset-left))', paddingRight: 'max(16px, env(safe-area-inset-right))', paddingBottom: '100px' }}>
      <div className="sticky top-0 bg-[#0a0b0d] py-4 z-10">
        <h2 className="text-white font-bold text-lg">🎛️ Plugins</h2>
        {selectedTrack ? <p className="text-cyan-400 text-sm">Ajouter sur : {selectedTrack.name}</p> : <p className="text-white/50 text-sm">Sélectionne d'abord une piste</p>}
      </div>

      {selectedTrack && selectedTrack.plugins && selectedTrack.plugins.length > 0 && (
        <div className="mb-6">
          <h3 className="text-white/70 text-xs uppercase mb-2">Plugins actifs sur cette piste</h3>
          <div className="flex flex-wrap gap-2">
            {selectedTrack.plugins.map((plugin: any) => (
              <div key={plugin.id} className="bg-cyan-500/20 text-cyan-400 px-3 py-2 rounded-lg text-sm flex items-center gap-2">
                <i className={`fas ${plugin.icon || 'fa-plug'}`} />
                {plugin.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {categories.map(cat => (
        <div key={cat.name} className="mb-6">
          <h3 className="text-white/50 text-xs uppercase mb-3">{cat.name}</h3>
          <div className="grid grid-cols-2 gap-3">
            {cat.plugins.map(p => (
              <button
                key={p.id}
                onClick={() => selectedTrack && onAddPlugin(selectedTrack.id, p.id)}
                disabled={!selectedTrack}
                className={`p-4 rounded-xl text-left transition-all ${selectedTrack ? 'bg-white/5 active:bg-white/10 hover:bg-white/10' : 'bg-white/5 opacity-50 cursor-not-allowed'}`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-500/20 to-purple-500/20 flex items-center justify-center">
                    <i className={`fas ${p.icon || 'fa-plug'} text-cyan-400`} />
                  </div>
                  <span className="text-white font-medium text-sm">{p.name}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {!selectedTrack && (
        <div className="text-center py-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
            <i className="fas fa-hand-pointer text-white/30 text-2xl" />
          </div>
          <p className="text-white/50">Sélectionne une piste d'abord</p>
          <p className="text-white/30 text-sm">pour y ajouter des plugins</p>
        </div>
      )}
    </div>
  );
};

export default MobilePluginBrowser;
