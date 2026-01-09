
import React, { useRef, useEffect, useState } from 'react';
import { useDAW } from '../context/DAWContext';
import { Track, TrackType, TrackSend, PluginInstance, PluginType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { SmartKnob } from './SmartKnob';
import { getValidDestinations, getRouteLabel } from './RoutingManager';

// -- Widgets --
const VUMeter: React.FC<{ analyzer: AnalyserNode | null }> = ({ analyzer }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!analyzer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const data = new Uint8Array(analyzer.frequencyBinCount);
    let frame: number;
    const draw = () => {
      analyzer.getByteFrequencyData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
      const level = Math.min(1, (sum / data.length / 128) * 1.8);
      const w = canvas.width; const h = canvas.height;
      ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#1e2229'; ctx.fillRect(0, 0, w, h);
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#22c55e'); grad.addColorStop(0.7, '#eab308'); grad.addColorStop(0.9, '#ef4444');
      ctx.fillStyle = grad; ctx.fillRect(0, h - (level * h), w, level * h);
      frame = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frame);
  }, [analyzer]);
  return <canvas ref={canvasRef} width={6} height={120} className="rounded-full overflow-hidden" />;
};

// -- Components --
const ChannelStrip: React.FC<{ 
  track: Track, 
  allTracks: Track[],
  isMaster?: boolean,
  onOpenPlugin?: (trackId: string, p: PluginInstance) => void,
  onToggleBypass?: (trackId: string, pluginId: string) => void,
  onRemovePlugin?: (trackId: string, pluginId: string) => void,
  onDropPlugin?: (trackId: string, type: PluginType, metadata?: any) => void,
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void
}> = ({ track, allTracks, isMaster = false, onOpenPlugin, onToggleBypass, onRemovePlugin, onDropPlugin, onRequestAddPlugin }) => {
  
  const { updateTrack } = useDAW();
  
  const [isDragOver, setIsDragOver] = useState(false);
  const faderTrackRef = useRef<HTMLDivElement>(null);
  
  const analyzer = isMaster ? audioEngine.masterAnalyzerL : audioEngine.getTrackAnalyzer(track.id);
  const analyzerR = isMaster ? audioEngine.masterAnalyzerR : analyzer; 

  const handleVolInteraction = (clientY: number, rect: DOMRect) => {
      const p = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      updateTrack({...track, volume: p * p * 1.5});
  };

  const onVolMouseDown = (e: React.MouseEvent) => {
      const rect = faderTrackRef.current!.getBoundingClientRect();
      handleVolInteraction(e.clientY, rect);
      const move = (m: MouseEvent) => handleVolInteraction(m.clientY, rect);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); 
    e.stopPropagation();
    if (e.dataTransfer.types.includes('application/nova-plugin') || e.dataTransfer.types.includes('pluginid')) {
        setIsDragOver(true);
        e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    const pluginType = e.dataTransfer.getData('pluginType') as PluginType;
    if (pluginType && onDropPlugin) {
        onDropPlugin(track.id, pluginType);
    }
  };

  const handleFXClick = (e: React.MouseEvent, p: PluginInstance) => {
    e.stopPropagation();
    onOpenPlugin?.(track.id, p);
  };

  const handleEmptySlotClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRequestAddPlugin) onRequestAddPlugin(track.id, e.clientX, e.clientY);
  };

  return (
    <div 
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={`flex-shrink-0 bg-[#0c0e12] border-r border-white/5 flex flex-col h-full ${isMaster ? 'w-64 border-l-2 border-cyan-500/20' : 'w-44'} ${isDragOver ? 'bg-cyan-500/20' : ''}`}
    >
      
      {/* Plugin Rack */}
      <div className="h-40 bg-black/20 border-b border-white/5 p-2 space-y-1.5 overflow-y-auto custom-scroll" onClick={handleEmptySlotClick}>
         {track.plugins.length === 0 && (
             <div className="h-full flex items-center justify-center text-slate-700 text-[8px] font-mono pointer-events-none">
                EMPTY RACK
             </div>
         )}
         {track.plugins.map(p => (
          <div key={p.id} className="relative group/fxslot w-full h-8 mb-1 fx-slot">
            <button 
              onClick={(e) => handleFXClick(e, p)}
              className={`w-full h-full bg-black/40 rounded border border-white/5 text-[9px] font-black hover:border-cyan-500/40 transition-all px-2 text-left truncate flex items-center pr-12 ${p.isEnabled ? 'text-cyan-400' : 'text-slate-600'}`}
            >
               {p.name || p.type}
            </button>
            <div className="absolute right-1 top-0 bottom-0 flex items-center space-x-1">
               <button onClick={(e) => { e.stopPropagation(); onToggleBypass?.(track.id, p.id); }} className={`w-5 h-5 rounded flex items-center justify-center transition-all ${p.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'}`}><i className="fas fa-power-off text-[7px]"></i></button>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onRemovePlugin?.(track.id, p.id); }} className="delete-fx absolute -right-2 top-0 bottom-0 w-6 bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover/fxslot:opacity-100 transition-opacity z-10"><i className="fas fa-times text-[8px]"></i></button>
          </div>
        ))}
      </div>

      {/* CONTROLS */}
      <div className="flex-1 p-3 flex flex-col">
        {!isMaster && (
             <div className="mb-2">
                 <SmartKnob id={`${track.id}-pan`} targetId={track.id} label="PAN" value={track.pan} min={-1} max={1} size={32} onChange={(v) => updateTrack({...track, pan: v})} />
             </div>
        )}

        <div className="flex-1 flex space-x-3 px-2">
           <div className="flex-1 relative flex flex-col items-center">
              <div 
                ref={faderTrackRef} 
                onMouseDown={onVolMouseDown}
                className="h-full bg-black/40 rounded-full border border-white/5 relative cursor-pointer group"
                style={{ width: 40 }}
              >
                 <div className="absolute left-1/2 -translate-x-1/2 w-9 h-14 bg-[#1e2229] rounded border border-white/20 shadow-2xl z-20 flex items-center justify-center" style={{ bottom: `calc(${(Math.sqrt(track.volume / 1.5))*100}% - 28px)` }}>
                    <div className="w-full h-0.5 bg-cyan-500" />
                 </div>
              </div>
           </div>
           <div className="flex space-x-1">
              <VUMeter analyzer={analyzer} />
              <VUMeter analyzer={analyzerR} />
           </div>
        </div>

        <div className="mt-4 flex space-x-2">
           <button onClick={() => updateTrack({...track, isMuted: !track.isMuted})} className={`flex-1 h-8 rounded text-[9px] font-black border ${track.isMuted ? 'bg-amber-500 text-black' : 'bg-white/5 text-slate-600'}`}>MUTE</button>
           <button onClick={() => updateTrack({...track, isSolo: !track.isSolo})} className={`flex-1 h-8 rounded text-[9px] font-black border ${track.isSolo ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-600'}`}>SOLO</button>
        </div>
        
        <div className="mt-3 text-center">
           <span className="text-[9px] font-black uppercase text-white truncate block">{track.name}</span>
        </div>
      </div>
    </div>
  );
};

const MixerView: React.FC<{ 
  tracks: Track[], 
  onUpdateTrack: (t: Track) => void, 
  onAddBus?: () => void,
  onOpenPlugin?: (tid: string, p: PluginInstance) => void, 
  onToggleBypass?: (tid: string, pid: string) => void, 
  onRemovePlugin?: (tid: string, pid: string) => void, 
  onDropPluginOnTrack?: (tid: string, type: PluginType, metadata?: any) => void, 
  onRequestAddPlugin?: (tid: string, x: number, y: number) => void
}> = ({ tracks, onAddBus, onOpenPlugin, onToggleBypass, onRemovePlugin, onDropPluginOnTrack, onRequestAddPlugin }) => {
  const audioTracks = tracks.filter(t => t.type === TrackType.AUDIO || t.type === TrackType.SAMPLER || t.type === TrackType.MIDI || t.type === TrackType.DRUM_RACK || t.type === TrackType.MELODIC_SAMPLER || t.type === TrackType.DRUM_SAMPLER);
  const busTracks = tracks.filter(t => t.type === TrackType.BUS && t.id !== 'master');
  const sendTracks = tracks.filter(t => t.type === TrackType.SEND);
  const masterTrack = tracks.find(t => t.id === 'master');

  return (
    <div className="flex-1 flex overflow-x-auto bg-[#08090b] custom-scroll h-full snap-x snap-mandatory">
      {audioTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      
      <div className="flex flex-col items-center justify-center px-2 border-r border-white/5 min-w-[60px]">
         <button onClick={onAddBus} className="w-12 h-12 rounded-2xl border border-dashed border-amber-500/30 text-amber-500 hover:bg-amber-500/10 flex items-center justify-center">
            <i className="fas fa-plus"></i>
         </button>
      </div>

      {busTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      
      <div className="w-4 bg-black/30 border-r border-white/5" />
      {sendTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}

      <div className="w-10 bg-black/50 border-r border-white/5" />
      {masterTrack && <div className="snap-start"><ChannelStrip track={masterTrack} allTracks={tracks} isMaster={true} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>}
    </div>
  );
};
export default MixerView;
