
import React, { useState, useEffect, Suspense } from 'react';
import { PluginInstance, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { PLUGIN_REGISTRY } from '../plugins/registry';

interface PluginEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onUpdateParams: (params: Record<string, any>) => void;
  onClose: () => void;
  isMobile?: boolean; 
  track?: Track; // Needed for Drum Rack
  onUpdateTrack?: (track: Track) => void; // Needed for Drum Rack
}

const PluginEditor: React.FC<PluginEditorProps> = ({ plugin, trackId, onClose, onUpdateParams, isMobile, track, onUpdateTrack }) => {
  const [nodeInstance, setNodeInstance] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds timeout
    let timer: any;

    const pollForNode = async () => {
        const node = audioEngine.getPluginNodeInstance(trackId, plugin.id);
        if (node) {
            // NEW: Check for async initialization promise
            if (node.ready && typeof node.ready.then === 'function') {
                try {
                    await node.ready; // Wait for the node to be fully initialized
                    setNodeInstance(node);
                } catch (err) {
                    console.error(`[PluginEditor] Async init failed for ${plugin.name}`, err);
                    setError("Le processeur DSP du plugin a échoué à s'initialiser.");
                }
            } else {
                // It's a synchronous node, ready immediately
                setNodeInstance(node);
            }
        } else {
            attempts++;
            if (attempts >= maxAttempts) {
                setError("Timeout du moteur de plugin. Le noeud DSP n'a pas pu être créé.");
            } else {
                timer = setTimeout(pollForNode, 100);
            }
        }
    };

    pollForNode();
    return () => clearTimeout(timer);
  }, [trackId, plugin.id, retryCount]);

  const handleRetry = () => {
      setError(null);
      setNodeInstance(null);
      setRetryCount(prev => prev + 1);
  };
  
  const renderPluginUI = () => {
    const entry = PLUGIN_REGISTRY[plugin.type];
    if (!entry || !entry.ui) {
        return <div className="p-20 text-white">Interface du plugin introuvable</div>;
    }

    const PluginUI = entry.ui;
    
    // Props specific to certain plugins
    const commonProps = {
        node: nodeInstance,
        initialParams: plugin.params,
        onParamsChange: onUpdateParams,
        trackId: trackId,
        pluginId: plugin.id,
    };
    
    // Drum Rack needs track data
    if (plugin.type === 'DRUM_RACK_UI') {
        if (!track || !onUpdateTrack) return <div className="p-10 bg-red-900 rounded">Error: Track Data Missing for Drum Rack</div>;
        return <PluginUI track={track} onUpdateTrack={onUpdateTrack} />;
    }
    
    return <PluginUI {...commonProps} />;
  };

  const LoadingFallback = () => (
      <div className="fixed inset-0 flex items-center justify-center z-[300]">
          <div className="bg-[#0f1115] border border-white/10 p-10 rounded-[32px] text-center w-80 shadow-2xl relative">
             <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                 <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin mb-4 mx-auto"></div>
                 <p className="text-slate-500 font-black uppercase text-[10px] tracking-widest animate-pulse">Initialisation DSP...</p>
             </div>
             <button onClick={onClose} className="absolute top-4 right-4 text-slate-500 hover:text-white"><i className="fas fa-times"></i></button>
          </div>
      </div>
  );

  if (error) {
     return (
        <div className="fixed inset-0 flex items-center justify-center z-[300]">
            <div className="bg-[#0f1115] border border-red-500/30 p-10 rounded-[32px] text-center w-80 shadow-2xl relative">
                <button onClick={onClose} className="absolute top-4 right-4 text-white"><i className="fas fa-times"></i></button>
                <i className="fas fa-bug text-4xl text-red-500 mb-4"></i>
                <p className="text-red-400 font-bold text-xs mb-4">{error}</p>
                <button 
                    onClick={handleRetry}
                    className="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-white transition-all"
                >
                    Réessayer
                </button>
            </div>
        </div>
     );
  }

  if (!nodeInstance) {
    return <LoadingFallback />;
  }

  return (
    <div className={`relative group/plugin ${isMobile ? 'w-full h-full flex flex-col items-center justify-center pt-16' : ''}`}>
      {/* Header Bar */}
      <div className={`absolute left-0 right-0 h-12 bg-black/90 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-6 z-50 shadow-2xl ${isMobile ? 'top-0 fixed' : '-top-14 rounded-full border border-white/10'}`}>
         <div className="flex items-center space-x-3">
            <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></div>
            <span className="text-[10px] font-black text-white uppercase tracking-widest">{plugin.name} // NODE ACTIVE</span>
         </div>
         <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 hover:bg-red-500 text-slate-500 hover:text-white transition-all flex items-center justify-center">
            <i className="fas fa-times text-xs"></i>
         </button>
      </div>
      
      {/* Container with Suspense for lazy loading UIs */}
      <div className={`shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden ${isMobile ? 'rounded-none scale-[0.85] origin-top' : 'rounded-[40px]'}`}>
        <Suspense fallback={<div className="w-[480px] h-[400px] bg-[#0c0d10] flex items-center justify-center"><div className="w-8 h-8 border-t-cyan-500 border-2 rounded-full animate-spin"></div></div>}>
            {renderPluginUI()}
        </Suspense>
      </div>
    </div>
  );
};
export default PluginEditor;
