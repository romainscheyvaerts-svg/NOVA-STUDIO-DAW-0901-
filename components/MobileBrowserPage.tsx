import React, { useState, useRef, useEffect, useMemo } from 'react';
import MobileContainer from './MobileContainer';
import { PluginType, User, PluginMetadata } from '../types';
import { novaBridge } from '../services/NovaBridge';
import InstrumentCatalog from './InstrumentCatalog';

interface MobileBrowserPageProps {
  user: User | null;
  onAddPlugin: (trackId: string, type: PluginType, metadata?: any, options?: { openUI: boolean }) => void;
  onPurchase: (instrumentId: number) => void;
  selectedTrackId: string | null;
}

// Plugins natifs Nova
const INTERNAL_PLUGINS = [
  { id: 'AUTOTUNE', name: 'Nova Tune Pro', category: 'Pitch Correction', icon: 'fa-microphone-alt', color: '#00f2ff' },
  { id: 'PROEQ12', name: 'Pro-EQ 12', category: 'Equalizer', icon: 'fa-wave-square', color: '#3b82f6' },
  { id: 'COMPRESSOR', name: 'Leveler Pro', category: 'Dynamics', icon: 'fa-compress-alt', color: '#f97316' },
  { id: 'VOCALSATURATOR', name: 'Vocal Saturator', category: 'Saturation', icon: 'fa-fire', color: '#10b981' },
  { id: 'REVERB', name: 'Spatial Verb', category: 'Reverb', icon: 'fa-mountain-sun', color: '#6366f1' },
  { id: 'DELAY', name: 'Sync Delay', category: 'Delay', icon: 'fa-history', color: '#0ea5e9' },
  { id: 'CHORUS', name: 'Dimension Chorus', category: 'Modulation', icon: 'fa-layer-group', color: '#a855f7' },
  { id: 'FLANGER', name: 'Studio Flanger', category: 'Modulation', icon: 'fa-wind', color: '#3b82f6' },
  { id: 'DOUBLER', name: 'Vocal Doubler', category: 'Stereo', icon: 'fa-people-arrows', color: '#8b5cf6' },
  { id: 'STEREOSPREADER', name: 'Phase Guard', category: 'Stereo', icon: 'fa-arrows-alt-h', color: '#06b6d4' },
  { id: 'DEESSER', name: 'S-Killer', category: 'Dynamics', icon: 'fa-scissors', color: '#ef4444' },
  { id: 'DENOISER', name: 'Denoiser X', category: 'Restoration', icon: 'fa-broom', color: '#14b8a6' },
  { id: 'MASTERSYNC', name: 'Master Sync', category: 'Utility', icon: 'fa-sync-alt', color: '#ffffff' },
  { id: 'MELODIC_SAMPLER', name: 'Melodic Sampler', category: 'Instrument', icon: 'fa-music', color: '#22d3ee' },
  { id: 'DRUM_SAMPLER', name: 'Drum Sampler', category: 'Instrument', icon: 'fa-drum', color: '#f97316' },
  { id: 'DRUM_RACK_UI', name: 'Drum Rack', category: 'Instrument', icon: 'fa-th', color: '#f97316' }
];

/**
 * Navigateur mobile - Réplique exacte du SideBrowser2 desktop
 * Onglets: STORE (instruments), FX (plugins natifs), BRIDGE (VST3)
 */
const MobileBrowserPage: React.FC<MobileBrowserPageProps> = ({
  user,
  onAddPlugin,
  onPurchase,
  selectedTrackId
}) => {
  const [activeTab, setActiveTab] = useState<'STORE' | 'FX' | 'BRIDGE'>('STORE');
  const [searchTerm, setSearchTerm] = useState('');
  const [vst3Plugins, setVst3Plugins] = useState<PluginMetadata[]>([]);

  // Charger les plugins VST3
  useEffect(() => {
    novaBridge.requestPlugins();
    const unsubscribe = novaBridge.subscribeToPlugins(setVst3Plugins);
    return unsubscribe;
  }, []);

  const handleAddPlugin = (type: PluginType, metadata?: any) => {
    const targetTrackId = selectedTrackId || 'track-rec-main';
    onAddPlugin(targetTrackId, type, metadata, { openUI: true });
  };

  // Filtrer les plugins natifs
  const filteredInternalPlugins = useMemo(() =>
    INTERNAL_PLUGINS.filter(p =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.category.toLowerCase().includes(searchTerm.toLowerCase())
    ), [searchTerm]
  );

  // Filtrer les VST3
  const filteredVST3Plugins = useMemo(() =>
    vst3Plugins.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase())),
    [vst3Plugins, searchTerm]
  );

  return (
    <MobileContainer title="Navigateur">
      <div className="space-y-4 pb-20">
        {/* Onglets - Même structure que SideBrowser2 */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setActiveTab('STORE')}
            className={`py-4 rounded-xl text-xs font-black uppercase transition-all flex flex-col items-center gap-2 ${
              activeTab === 'STORE'
                ? 'bg-cyan-500 text-black'
                : 'bg-[#14161a] text-slate-500'
            }`}
          >
            <i className="fas fa-store text-lg"></i>
            Store
          </button>
          <button
            onClick={() => setActiveTab('FX')}
            className={`py-4 rounded-xl text-xs font-black uppercase transition-all flex flex-col items-center gap-2 ${
              activeTab === 'FX'
                ? 'bg-cyan-500 text-black'
                : 'bg-[#14161a] text-slate-500'
            }`}
          >
            <i className="fas fa-atom text-lg"></i>
            FX
          </button>
          <button
            onClick={() => setActiveTab('BRIDGE')}
            className={`py-4 rounded-xl text-xs font-black uppercase transition-all flex flex-col items-center gap-2 ${
              activeTab === 'BRIDGE'
                ? 'bg-cyan-500 text-black'
                : 'bg-[#14161a] text-slate-500'
            }`}
          >
            <i className="fas fa-plug text-lg"></i>
            Bridge
          </button>
        </div>

        {/* Contenu STORE - Catalogue d'instruments */}
        {activeTab === 'STORE' && (
          <div className="rounded-xl overflow-hidden -mx-2">
            <InstrumentCatalog
              user={user}
              onPurchase={onPurchase}
            />
          </div>
        )}

        {/* Contenu FX - Plugins natifs Nova */}
        {activeTab === 'FX' && (
          <div className="space-y-4">
            {/* Barre de recherche */}
            <div className="relative">
              <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
              <input
                type="text"
                placeholder="Chercher un effet..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[#14161a] border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-slate-600 focus:border-cyan-500/50 focus:outline-none text-sm"
              />
            </div>

            {/* Liste des plugins natifs */}
            <div className="space-y-2">
              <h3 className="text-[10px] font-black text-slate-600 uppercase tracking-widest px-1">
                Nova Native Modules
              </h3>
              {filteredInternalPlugins.map(plugin => (
                <button
                  key={plugin.id}
                  onClick={() => handleAddPlugin(plugin.id as PluginType)}
                  className="w-full bg-[#14161a] rounded-xl p-4 border border-white/10 hover:border-cyan-500/30 hover:bg-white/5 transition-all active:scale-95 flex items-center gap-3"
                >
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-lg border"
                    style={{
                      backgroundColor: `${plugin.color}15`,
                      color: plugin.color,
                      borderColor: `${plugin.color}20`
                    }}
                  >
                    <i className={`fas ${plugin.icon}`}></i>
                  </div>
                  <div className="flex-1 text-left">
                    <div className="text-white font-bold text-sm">{plugin.name}</div>
                    <div className="text-xs text-slate-500 uppercase tracking-wide">{plugin.category}</div>
                  </div>
                  <i className="fas fa-plus text-slate-400 text-xs"></i>
                </button>
              ))}
              {filteredInternalPlugins.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <i className="fas fa-search text-4xl mb-4 opacity-30"></i>
                  <p>Aucun effet trouvé</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Contenu BRIDGE - Plugins VST3 */}
        {activeTab === 'BRIDGE' && (
          <div className="space-y-4">
            {/* Barre de recherche */}
            <div className="relative">
              <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
              <input
                type="text"
                placeholder="Filtrer les plugins VST3..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[#14161a] border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-slate-600 focus:border-cyan-500/50 focus:outline-none text-sm"
              />
            </div>

            {/* Liste des VST3 */}
            <div className="space-y-2">
              {filteredVST3Plugins.map(plugin => (
                <button
                  key={plugin.id}
                  onClick={() => handleAddPlugin('VST3', { name: plugin.name, localPath: plugin.localPath })}
                  className="w-full bg-[#14161a] rounded-xl p-4 border border-white/10 hover:border-cyan-500/30 hover:bg-white/5 transition-all active:scale-95 flex items-center gap-3"
                >
                  <div className="w-11 h-11 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20">
                    <i className="fas fa-plug text-lg"></i>
                  </div>
                  <div className="flex-1 text-left">
                    <div className="text-white font-bold text-sm">{plugin.name}</div>
                    <div className="text-xs text-slate-500">{plugin.vendor}</div>
                  </div>
                  <i className="fas fa-plus text-slate-400 text-xs"></i>
                </button>
              ))}
              {filteredVST3Plugins.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <i className="fas fa-plug text-4xl mb-4 opacity-30"></i>
                  <p className="text-sm">Aucun VST3 détecté</p>
                  <p className="text-xs mt-2 text-slate-600">Vérifiez le Bridge</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </MobileContainer>
  );
};

export default MobileBrowserPage;
