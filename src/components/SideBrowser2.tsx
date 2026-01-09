
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { PluginType, User, Instrument, PluginMetadata } from '../types';
import { novaBridge } from '../services/NovaBridge';
import InstrumentCatalog from './InstrumentCatalog';

interface SideBrowser2Props {
  user: User | null;
  onLocalImport: (file: File) => void;
  onAddPlugin: (trackId: string, type: PluginType, metadata?: any, options?: { openUI: boolean }) => void;
  onPurchase: (instrumentId: number) => void;
  activeTab: 'STORE' | 'LOCAL' | 'FW' | 'BRIDGE';
  onTabChange: (tab: 'STORE' | 'LOCAL' | 'FW' | 'BRIDGE') => void;
  selectedTrackId: string | null;
}

// --- DATA: NATIVE PLUGINS ---
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

// --- Onglet Bridge (Plugins Externes) ---
const BridgeTab: React.FC<{ onAddPlugin: (trackId: string, type: PluginType, metadata: any, options?: { openUI: boolean }) => void, selectedTrackId: string | null }> = ({ onAddPlugin, selectedTrackId }) => {
    const [plugins, setPlugins] = useState<PluginMetadata[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        novaBridge.requestPlugins();
        const unsubscribe = novaBridge.subscribeToPlugins(setPlugins);
        return unsubscribe;
    }, []);

    const handleDragStart = (e: React.DragEvent, p: PluginMetadata) => {
        e.dataTransfer.setData('pluginType', 'VST3');
        e.dataTransfer.setData('pluginName', p.name);
        e.dataTransfer.setData('pluginVendor', p.vendor);
        e.dataTransfer.setData('application/nova-plugin', 'true');
        e.dataTransfer.setData('pluginLocalPath', p.localPath || ''); 
    };

    const handleClickPlugin = (p: PluginMetadata) => {
        const targetTrackId = selectedTrackId || 'track-rec-main';
        onAddPlugin(targetTrackId, 'VST3', { name: p.name, localPath: p.localPath }, { openUI: true });
    };

    const filteredPlugins = useMemo(() => plugins.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase())), [plugins, searchTerm]);

    return (
        <div className="p-4 space-y-3">
            <div className="relative">
                <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-xs text-slate-600"></i>
                <input 
                    ref={searchInputRef}
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Filtrer les plugins VST3..."
                    className="w-full h-10 bg-black/40 border border-white/10 rounded-xl pl-10 pr-4 text-xs font-medium text-white placeholder:text-slate-700 focus:outline-none focus:border-cyan-500/30 transition-all uppercase tracking-widest"
                />
            </div>
            {filteredPlugins.map(p => (
                <div 
                    key={p.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, p)}
                    onClick={() => handleClickPlugin(p)}
                    className="w-full p-3 bg-white/[0.02] border border-white/5 rounded-lg flex items-center space-x-3 transition-all cursor-pointer active:cursor-grabbing hover:bg-white/[0.04]"
                >
                    <div className="w-8 h-8 rounded-md bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20 text-xs"><i className="fas fa-plug"></i></div>
                    <div>
                        <div className="text-xs font-bold text-white truncate">{p.name}</div>
                        <div className="text-[9px] text-slate-500">{p.vendor}</div>
                    </div>
                </div>
            ))}
             {filteredPlugins.length === 0 && (
                <div className="text-center py-10 opacity-50">
                    <i className="fas fa-plug text-2xl text-slate-600 mb-2"></i>
                    <p className="text-[10px] text-slate-500">Aucun VST détecté.<br/>Vérifiez le Bridge.</p>
                </div>
            )}
        </div>
    );
};

// --- Onglet Local ---
const LocalTab: React.FC<{ onLocalImport: (file: File) => void }> = ({ onLocalImport }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    return (
        <div className="h-full flex flex-col items-center justify-center p-8 text-center opacity-60">
            <i className="fas fa-file-audio text-4xl text-slate-700 mb-6"></i>
            <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-4">Import Local</h3>
            <p className="text-xs text-slate-500 mb-6">Importez n'importe quel fichier audio (MP3, WAV, etc.) depuis votre appareil.</p>
            <button 
                onClick={() => fileInputRef.current?.click()}
                className="px-8 py-3 bg-white/10 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-cyan-500 hover:text-black transition-colors"
            >
                Parcourir
            </button>
            <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={(e) => {
                if (e.target.files?.[0]) onLocalImport(e.target.files[0]);
            }} />
        </div>
    );
};

// --- Onglet FW (Future Wave - Native Plugins) ---
const FWTab: React.FC<{ onAddPlugin: (trackId: string, type: PluginType, metadata: any, options: { openUI: boolean }) => void, selectedTrackId: string | null }> = ({ onAddPlugin, selectedTrackId }) => {
    const [searchTerm, setSearchTerm] = useState('');
    
    const handleDragStart = (e: React.DragEvent, p: typeof INTERNAL_PLUGINS[0]) => {
        e.dataTransfer.setData('pluginType', p.id);
        e.dataTransfer.setData('pluginName', p.name);
        e.dataTransfer.setData('application/nova-plugin', 'true');
    };

    const handleClickPlugin = (p: typeof INTERNAL_PLUGINS[0]) => {
        const targetTrackId = selectedTrackId || 'track-rec-main'; // Fallback sur la piste REC
        onAddPlugin(targetTrackId, p.id as PluginType, undefined, { openUI: true });
    };

    const filtered = useMemo(() => INTERNAL_PLUGINS.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase())), [searchTerm]);

    return (
        <div className="p-4 space-y-4">
             <div className="relative">
                <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-xs text-slate-600"></i>
                <input 
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Chercher un effet..."
                    className="w-full h-10 bg-black/40 border border-white/10 rounded-xl pl-10 pr-4 text-xs font-medium text-white placeholder:text-slate-700 focus:outline-none focus:border-cyan-500/30 transition-all uppercase tracking-widest"
                />
            </div>

            <div className="space-y-2">
                <h3 className="text-[9px] font-black text-slate-600 uppercase tracking-widest pl-1">Nova Native Modules</h3>
                {filtered.map(p => (
                    <div 
                        key={p.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, p)}
                        onClick={() => handleClickPlugin(p)}
                        className="w-full p-3 bg-white/[0.02] border border-white/5 rounded-lg flex items-center space-x-3 transition-all cursor-pointer active:cursor-grabbing hover:bg-white/[0.06] hover:border-white/10 group"
                    >
                        <div 
                            className="w-9 h-9 rounded-lg flex items-center justify-center border text-sm shadow-lg group-hover:scale-110 transition-transform"
                            style={{ backgroundColor: `${p.color}15`, color: p.color, borderColor: `${p.color}20` }}
                        >
                            <i className={`fas ${p.icon}`}></i>
                        </div>
                        <div>
                            <div className="text-xs font-bold text-white truncate group-hover:text-cyan-400 transition-colors">{p.name}</div>
                            <div className="text-[9px] text-slate-500 uppercase tracking-wide">{p.category}</div>
                        </div>
                        <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                            <i className="fas fa-plus text-[10px] text-slate-400"></i>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};


// --- Composant Principal ---
const SideBrowser2: React.FC<SideBrowser2Props> = ({ user, onLocalImport, onAddPlugin, onPurchase, activeTab, onTabChange, selectedTrackId }) => {
  return (
    <div className="w-80 h-full flex flex-col bg-[#0c0d10] border-r border-white/5 shadow-2xl">
      {/* Tab Bar */}
      <div className="grid grid-cols-4 gap-1 p-2 bg-black/40 border-b border-white/5 shrink-0">
        <TabButton icon="fa-store" label="Store" isActive={activeTab === 'STORE'} onClick={() => onTabChange('STORE')} />
        <TabButton icon="fa-folder" label="Local" isActive={activeTab === 'LOCAL'} onClick={() => onTabChange('LOCAL')} />
        <TabButton icon="fa-atom" label="FW" isActive={activeTab === 'FW'} onClick={() => onTabChange('FW')} />
        <TabButton icon="fa-plug" label="Bridge" isActive={activeTab === 'BRIDGE'} onClick={() => onTabChange('BRIDGE')} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scroll">
        {activeTab === 'STORE' && <InstrumentCatalog user={user} onPurchase={onPurchase} />}
        {activeTab === 'LOCAL' && <LocalTab onLocalImport={onLocalImport} />}
        {activeTab === 'FW' && <FWTab onAddPlugin={onAddPlugin} selectedTrackId={selectedTrackId} />}
        {activeTab === 'BRIDGE' && <BridgeTab onAddPlugin={onAddPlugin} selectedTrackId={selectedTrackId} />}
      </div>
    </div>
  );
};

const TabButton: React.FC<{ icon: string, label: string, isActive: boolean, onClick: () => void }> = ({ icon, label, isActive, onClick }) => (
  <button 
    onClick={onClick} 
    className={`py-3 text-[9px] font-black uppercase rounded-lg transition-all flex flex-col items-center space-y-1 ${isActive ? 'bg-white/10 text-cyan-400' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'}`}
  >
    <i className={`fas ${icon} text-sm`}></i>
    <span>{label}</span>
  </button>
);

export default SideBrowser2;
