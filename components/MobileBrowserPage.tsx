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
  onLocalImport?: (file: File, name: string) => void;
}

// Plugins natifs
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

const MobileBrowserPage: React.FC<MobileBrowserPageProps> = ({ user, onAddPlugin, onPurchase, selectedTrackId, onLocalImport }) => {
  const [activeTab, setActiveTab] = useState<'FX' | 'INSTRUMENTS' | 'VST3' | 'LOCAL'>('FX');
  const [searchTerm, setSearchTerm] = useState('');
  const [vst3Plugins, setVst3Plugins] = useState<PluginMetadata[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onLocalImport) {
      onLocalImport(file, file.name);
      e.target.value = '';
    }
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
      <div className="space-y-4 pb-24">
        {/* Onglets */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          <button
            onClick={() => setActiveTab('FX')}
            className={`shrink-0 px-4 py-2.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'FX' ? 'bg-cyan-500 text-black' : 'bg-[#14161a] text-slate-400'
            }`}
          >
            <i className="fas fa-sliders-h mr-2"></i>
            Effets
          </button>
          <button
            onClick={() => setActiveTab('INSTRUMENTS')}
            className={`shrink-0 px-4 py-2.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'INSTRUMENTS' ? 'bg-cyan-500 text-black' : 'bg-[#14161a] text-slate-400'
            }`}
          >
            <i className="fas fa-guitar mr-2"></i>
            Instruments
          </button>
          <button
            onClick={() => setActiveTab('VST3')}
            className={`shrink-0 px-4 py-2.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'VST3' ? 'bg-cyan-500 text-black' : 'bg-[#14161a] text-slate-400'
            }`}
          >
            <i className="fas fa-plug mr-2"></i>
            VST3
          </button>
          <button
            onClick={() => setActiveTab('LOCAL')}
            className={`shrink-0 px-4 py-2.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'LOCAL' ? 'bg-cyan-500 text-black' : 'bg-[#14161a] text-slate-400'
            }`}
          >
            <i className="fas fa-folder-open mr-2"></i>
            Local
          </button>
        </div>

        {/* Barre de recherche */}
        {(activeTab === 'FX' || activeTab === 'VST3') && (
          <div className="relative">
            <input
              type="text"
              placeholder={activeTab === 'FX' ? "Rechercher un effet..." : "Rechercher un VST3..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-[#14161a] border border-white/10 rounded-xl px-4 py-3 pl-10 text-white placeholder-slate-500 focus:border-cyan-500/50 focus:outline-none text-sm"
            />
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm"></i>
          </div>
        )}

        {/* Contenu FX */}
        {activeTab === 'FX' && (
          <div className="space-y-2">
            {filteredInternalPlugins.map(plugin => (
              <button
                key={plugin.id}
                onClick={() => handleAddPlugin(plugin.id as PluginType)}
                className="w-full bg-[#14161a] rounded-xl p-4 border border-white/10 hover:border-cyan-500/30 transition-all active:scale-95 flex items-center gap-3"
              >
                <div
                  className="w-12 h-12 rounded-lg flex items-center justify-center text-lg"
                  style={{ backgroundColor: `${plugin.color}15`, color: plugin.color }}
                >
                  <i className={`fas ${plugin.icon}`}></i>
                </div>
                <div className="flex-1 text-left">
                  <div className="text-white font-bold text-sm">{plugin.name}</div>
                  <div className="text-xs text-slate-500">{plugin.category}</div>
                </div>
                <i className="fas fa-plus text-cyan-400"></i>
              </button>
            ))}
            {filteredInternalPlugins.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                <i className="fas fa-search text-4xl mb-4 opacity-30"></i>
                <p>Aucun effet trouvé</p>
              </div>
            )}
          </div>
        )}

        {/* Contenu INSTRUMENTS */}
        {activeTab === 'INSTRUMENTS' && (
          <div className="bg-[#14161a] rounded-xl border border-white/10 overflow-hidden">
            <InstrumentCatalog
              user={user}
              onPurchase={onPurchase}
              compact={true}
            />
          </div>
        )}

        {/* Contenu VST3 */}
        {activeTab === 'VST3' && (
          <div className="space-y-2">
            {filteredVST3Plugins.map(plugin => (
              <button
                key={plugin.id}
                onClick={() => handleAddPlugin('VST3', { name: plugin.name, localPath: plugin.localPath })}
                className="w-full bg-[#14161a] rounded-xl p-4 border border-white/10 hover:border-cyan-500/30 transition-all active:scale-95 flex items-center gap-3"
              >
                <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
                  <i className="fas fa-plug text-lg"></i>
                </div>
                <div className="flex-1 text-left">
                  <div className="text-white font-bold text-sm">{plugin.name}</div>
                  <div className="text-xs text-slate-500">{plugin.vendor}</div>
                </div>
                <i className="fas fa-plus text-cyan-400"></i>
              </button>
            ))}
            {filteredVST3Plugins.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                <i className="fas fa-plug text-4xl mb-4 opacity-30"></i>
                <p className="text-sm">Aucun VST3 détecté</p>
                <p className="text-xs mt-2">Vérifiez le Bridge</p>
              </div>
            )}
          </div>
        )}

        {/* Contenu LOCAL */}
        {activeTab === 'LOCAL' && (
          <div className="space-y-4">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border-2 border-dashed border-cyan-500/30 rounded-xl p-8 hover:border-cyan-500/50 transition-all active:scale-95"
            >
              <div className="text-center">
                <i className="fas fa-file-import text-4xl text-cyan-400 mb-4"></i>
                <div className="text-white font-bold mb-2">Importer un fichier audio</div>
                <div className="text-xs text-slate-400">MP3, WAV, OGG, FLAC...</div>
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleFileImport}
            />

            <div className="bg-[#14161a] rounded-xl p-4 border border-white/10">
              <div className="text-xs text-slate-400 mb-2">
                <i className="fas fa-info-circle mr-2"></i>
                Les fichiers importés seront ajoutés à votre bibliothèque locale
              </div>
            </div>
          </div>
        )}
      </div>
    </MobileContainer>
  );
};

export default MobileBrowserPage;
