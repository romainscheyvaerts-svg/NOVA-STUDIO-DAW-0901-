import React, { useState, useEffect } from 'react';
import { PluginInstance, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { AutoTuneUI } from '../plugins/AutoTunePlugin';
import { AutotuneEngineNote } from './AutotuneVstPanel';
import { ProfessionalReverbUI } from '../plugins/ReverbPlugin';
import { VocalCompressorUI } from '../plugins/CompressorPlugin';
import { SyncDelayUI } from '../plugins/DelayPlugin';
import { VocalChorusUI } from '../plugins/ChorusPlugin';
import { StudioFlangerUI } from '../plugins/FlangerPlugin';
import { VocalDoublerUI } from '../plugins/DoublerPlugin';
import { StereoSpreaderUI } from '../plugins/StereoSpreaderPlugin';
import { VocalDeEsserUI } from '../plugins/DeEsserPlugin';
import { VocalDenoiserUI } from '../plugins/DenoiserPlugin';
import { ProEQ12UI } from '../plugins/ProEQ12Plugin';
import { VocalSaturatorUI } from '../plugins/VocalSaturatorPlugin';
import { MasterSyncUI } from '../plugins/MasterSyncPlugin';
import VSTPluginWindow from './VSTPluginWindow';
import SamplerEditor from './SamplerEditor'; 
import DrumSamplerEditor from './DrumSamplerEditor';
import MelodicSamplerEditor from './MelodicSamplerEditor';
import DrumRack from './DrumRack';
import FitToWidth from './FitToWidth';

interface PluginEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onUpdateParams: (params: Record<string, any>) => void;
  onClose: () => void;
  isMobile?: boolean; 
  track?: Track; // Needed for Drum Rack
  onUpdateTrack?: (track: Track) => void; // Needed for Drum Rack
  /** Gèle / dégèle la piste (effets VST3 du PC). */
  onToggleFreeze?: (trackId: string) => void;
}

const PluginEditor: React.FC<PluginEditorProps> = ({ plugin, trackId, onClose, onUpdateParams, isMobile, track, onUpdateTrack, onToggleFreeze }) => {
  const [nodeInstance, setNodeInstance] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Polling effect to wait for DSP node creation
  useEffect(() => {
    // Skip polling for special plugin types that don't need DSP nodes
    if (['VST3', 'SAMPLER', 'DRUM_SAMPLER', 'MELODIC_SAMPLER', 'DRUM_RACK_UI'].includes(plugin.type)) {
      return;
    }

    let attempts = 0;
    const maxAttempts = 30; // 3 seconds timeout (30 * 100ms)
    let timer: any;

    const pollForNode = async () => {
      const node = audioEngine.getPluginNodeInstance(trackId, plugin.id);
      if (node) {
        // Check for async initialization promise
        if (node.ready && typeof node.ready.then === 'function') {
          try {
            await node.ready;
            setNodeInstance(node);
          } catch (err) {
            console.error(`[PluginEditor] Async init failed for ${plugin.name}`, err);
            setError("Le processeur DSP du plugin a échoué à s'initialiser.");
          }
        } else {
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
  }, [trackId, plugin.id, plugin.type, plugin.name, retryCount]);

  const handleRetry = () => {
    setError(null);
    setNodeInstance(null);
    setRetryCount(prev => prev + 1);
  };
  
  // Téléphone : les éditeurs ont des largeurs fixes (480-900 px) et leur bouton
  // de fermeture finissait hors écran, sans autre moyen de sortir. Plein écran
  // défilable, barre de fermeture fixe, contenu ajusté à la largeur.
  const mobileShell = (content: React.ReactNode) => (
      <div className="fixed inset-0 z-[300] overflow-y-auto bg-[#0c0d10] pt-14 pb-8">
          <div className="fixed top-0 left-0 right-0 z-[310] h-12 bg-black/90 backdrop-blur-xl border-b border-white/10 flex items-center justify-between pl-4 pr-1">
              <span className="text-xs font-black text-white uppercase tracking-widest truncate">{plugin.name}</span>
              <button onClick={onClose} aria-label="Fermer" className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10">
                  <i className="fas fa-times"></i>
              </button>
          </div>
          <FitToWidth>{content}</FitToWidth>
      </div>
  );

  // --- SPECIAL CASE: VST3 EXTERNALS ---
  if (plugin.type === 'VST3') {
      const vstWindow = <VSTPluginWindow plugin={plugin} onClose={onClose} trackId={trackId} track={track} onToggleFreeze={onToggleFreeze} />;
      if (isMobile) return mobileShell(vstWindow);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-lg">
                  {vstWindow}
              </div>
          </div>
      );
  }

  // --- SPECIAL CASE: INSTRUMENTS ---
  if (plugin.type === 'SAMPLER') {
      if (isMobile) return mobileShell(<SamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px]">
                  <SamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />
              </div>
          </div>
      );
  }

  if (plugin.type === 'DRUM_SAMPLER') {
      if (isMobile) return mobileShell(<DrumSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px]">
                  <DrumSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />
              </div>
          </div>
      );
  }

  if (plugin.type === 'MELODIC_SAMPLER') {
      if (isMobile) return mobileShell(<MelodicSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px]">
                  <MelodicSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />
              </div>
          </div>
      );
  }

  if (plugin.type === 'DRUM_RACK_UI') {
      if (!track || !onUpdateTrack) {
          return <div className="p-10 text-white bg-red-900 rounded">Error: Track Data Missing</div>;
      }
      if (isMobile) return mobileShell(<DrumRack track={track} onUpdateTrack={onUpdateTrack} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px] relative">
                  <button aria-label="Fermer" title="Fermer" onClick={onClose} className="absolute top-4 right-4 z-50 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"><i className="fas fa-times"></i></button>
                  <DrumRack track={track} onUpdateTrack={onUpdateTrack} />
              </div>
          </div>
      );
  }

  // Error state with retry button
  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-[300]">
        <div className="bg-[#0f1115] border border-red-500/30 p-10 rounded-[32px] text-center w-80 shadow-2xl relative">
          <button aria-label="Fermer" title="Fermer" onClick={onClose} className="absolute top-4 right-4 text-white"><i className="fas fa-times"></i></button>
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

  // Loading state with spinner
  if (!nodeInstance) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-[300]">
        <div className="bg-[#0f1115] border border-white/10 p-10 rounded-[32px] text-center w-80 shadow-2xl relative">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin mb-4 mx-auto"></div>
            <p className="text-slate-500 font-black uppercase text-[10px] tracking-widest animate-pulse">Initialisation DSP...</p>
          </div>
          <button aria-label="Fermer" title="Fermer" onClick={onClose} className="absolute top-4 right-4 text-slate-500 hover:text-white"><i className="fas fa-times"></i></button>
        </div>
      </div>
    );
  }

  const renderPluginUI = () => {
    switch(plugin.type) {
      case 'AUTOTUNE': return <><AutotuneEngineNote pluginId={plugin.id} /><AutoTuneUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} /></>;
      case 'REVERB': return <ProfessionalReverbUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'COMPRESSOR': return <VocalCompressorUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'DELAY': return <SyncDelayUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'CHORUS': return <VocalChorusUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'FLANGER': return <StudioFlangerUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'DOUBLER': return <VocalDoublerUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'STEREOSPREADER': return <StereoSpreaderUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'DEESSER': return <VocalDeEsserUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'DENOISER': return <VocalDenoiserUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'PROEQ12': return <ProEQ12UI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'VOCALSATURATOR': return <VocalSaturatorUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      case 'MASTERSYNC': return <MasterSyncUI node={nodeInstance} initialParams={plugin.params as any} onParamsChange={onUpdateParams} />;
      default: return <div className="p-20 text-white">Plugin UI Not Found</div>;
    }
  };

  if (isMobile) {
    return mobileShell(
      <div className="shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden rounded-none">
        {renderPluginUI()}
      </div>
    );
  }

  return (
    <div className={`relative group/plugin ${isMobile ? 'w-full h-full flex flex-col items-center justify-center pt-16' : ''}`}>
      {/* Header Bar */}
      <div className={`absolute left-0 right-0 h-12 bg-black/90 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-6 z-50 shadow-2xl ${isMobile ? 'top-0 fixed' : '-top-14 rounded-full border border-white/10'}`}>
         <div className="flex items-center space-x-3">
            <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></div>
            <span className="text-[10px] font-black text-white uppercase tracking-widest">{plugin.name} // NODE ACTIVE</span>
         </div>
         <button aria-label="Fermer" title="Fermer" onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 hover:bg-red-500 text-slate-500 hover:text-white transition-all flex items-center justify-center">
            <i className="fas fa-times text-xs"></i>
         </button>
      </div>
      
      {/* Container */}
      <div className={`shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden ${isMobile ? 'rounded-none scale-[0.85] origin-top' : 'rounded-[40px]'}`}>
        {renderPluginUI()}
      </div>
    </div>
  );
};
export default PluginEditor;
