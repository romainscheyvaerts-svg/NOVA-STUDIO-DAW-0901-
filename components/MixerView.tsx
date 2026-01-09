
import React, { useRef, useEffect, useState } from 'react';
import { Track, TrackType, PluginInstance, TrackSend, PluginType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { SmartKnob } from './SmartKnob';
import { getValidDestinations, getRouteLabel } from './RoutingManager';

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
      // Slightly boost visual level for better feedback
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

const SendKnob: React.FC<{ send: TrackSend, track: Track, onUpdate: (t: Track) => void }> = ({ send, track, onUpdate }) => {
  const getSendColor = (id: string) => {
    if (id === 'send-delay') return '#00f2ff';
    if (id === 'send-verb-short') return '#6366f1';
    return '#a855f7';
  };

  return (
    <div className="flex flex-col items-center justify-center">
       <SmartKnob 
          id={`${track.id}-send-${send.id}`}
          targetId={track.id}
          paramId={`send::${send.id}`} 
          label={send.id.replace('send-', '').substring(0, 4)}
          value={send.level}
          min={0}
          max={1.5}
          size={26} // Slightly bigger
          color={getSendColor(send.id)}
          onChange={(val) => {
              const newSends = track.sends.map(s => s.id === send.id ? { ...s, level: val } : s);
              onUpdate({ ...track, sends: newSends });
          }}
       />
    </div>
  );
};

const IOSection: React.FC<{ track: Track, allTracks: Track[], onUpdate: (t: Track) => void }> = ({ track, allTracks, onUpdate }) => {
    const validDestinations = getValidDestinations(track.id, allTracks);
    
    return (
        <div className="flex flex-col space-y-1 mb-2 px-1">
            {/* INPUT SELECTOR */}
            <div className="relative group/io">
                <div className="h-6 bg-black/60 rounded flex items-center px-2 border border-white/5 cursor-pointer hover:border-white/20">
                    <span className="text-[8px] font-black text-slate-500 mr-2">IN</span>
                    <span className="text-[8px] font-mono text-cyan-400 truncate flex-1">
                        {track.inputDeviceId === 'mic-default' ? 'MIC 1' : (track.inputDeviceId ? 'EXT' : 'NO IN')}
                    </span>
                    <i className="fas fa-caret-down text-[8px] text-slate-600"></i>
                </div>
                <select 
                    className="absolute inset-0 opacity-0 cursor-pointer"
                    value={track.inputDeviceId || 'none'}
                    onChange={(e) => onUpdate({ ...track, inputDeviceId: e.target.value === 'none' ? undefined : e.target.value })}
                >
                    <option value="none">No Input</option>
                    <option value="mic-default">Mic / Line 1</option>
                </select>
            </div>

            {/* OUTPUT SELECTOR */}
            <div className="relative group/io">
                <div className="h-6 bg-black/60 rounded flex items-center px-2 border border-white/5 cursor-pointer hover:border-white/20">
                    <span className="text-[8px] font-black text-slate-500 mr-2">OUT</span>
                    <span className="text-[8px] font-mono text-amber-400 truncate flex-1">
                        {getRouteLabel(track.outputTrackId, allTracks)}
                    </span>
                    <i className="fas fa-caret-down text-[8px] text-slate-600"></i>
                </div>
                <select 
                    className="absolute inset-0 opacity-0 cursor-pointer"
                    value={track.outputTrackId || 'master'}
                    onChange={(e) => onUpdate({ ...track, outputTrackId: e.target.value })}
                >
                    {validDestinations.map(dest => (
                        <option key={dest.id} value={dest.id}>{dest.name}</option>
                    ))}
                </select>
            </div>
        </div>
    );
};

const ChannelStrip: React.FC<{ 
  track: Track,
  allTracks: Track[],
  onUpdate: (t: Track) => void, 
  isMaster?: boolean, 
  onOpenPlugin?: (trackId: string, p: PluginInstance) => void,
  onToggleBypass?: (trackId: string, pluginId: string) => void,
  onRemovePlugin?: (trackId: string, pluginId: string) => void,
  onDropPlugin?: (trackId: string, type: PluginType, metadata?: any) => void,
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void
}> = ({ track, allTracks, onUpdate, isMaster = false, onOpenPlugin, onToggleBypass, onRemovePlugin, onDropPlugin, onRequestAddPlugin }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const faderTrackRef = useRef<HTMLDivElement>(null);
  
  // Use Engine Analyzers: Master uses Left/Right, Tracks use single
  const analyzer = isMaster ? audioEngine.masterAnalyzerL : audioEngine.getTrackAnalyzer(track.id);
  // For master right channel
  const analyzerR = isMaster ? audioEngine.masterAnalyzerR : analyzer; 

  const handleFXClick = (e: React.MouseEvent | React.TouchEvent, p: PluginInstance) => {
    e.stopPropagation();
    onOpenPlugin?.(track.id, p);
  };

  const handleEmptySlotClick = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    let clientX = 0;
    let clientY = 0;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    }
    if (onRequestAddPlugin) onRequestAddPlugin(track.id, clientX, clientY);
  };

  // Logic Volume Interaction
  const handleVolInteraction = (clientY: number, rect: DOMRect) => {
      const p = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onUpdate({...track, volume: p * p * 1.5});
  };

  const onVolMouseDown = (e: React.MouseEvent) => {
      const rect = faderTrackRef.current!.getBoundingClientRect();
      handleVolInteraction(e.clientY, rect);
      const move = (m: MouseEvent) => handleVolInteraction(m.clientY, rect);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const onVolTouchStart = (e: React.TouchEvent) => {
      e.stopPropagation(); 
      const rect = faderTrackRef.current!.getBoundingClientRect();
      handleVolInteraction(e.touches[0].clientY, rect);
  };

  const onVolTouchMove = (e: React.TouchEvent) => {
      const rect = faderTrackRef.current!.getBoundingClientRect();
      handleVolInteraction(e.touches[0].clientY, rect);
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

  return (
    <div 
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className={`flex-shrink-0 bg-[#0c0e12] border-r border-white/5 flex flex-col h-full transition-all touch-manipulation ${isMaster ? 'w-64 border-l-2 border-cyan-500/20' : track.type === TrackType.BUS ? 'w-48 bg-[#14161a]' : 'w-44'} ${isDragOver ? 'bg-cyan-500/20' : ''}`}
    >
      
      {!isMaster && (track.type === TrackType.AUDIO || track.type === TrackType.SAMPLER) && (
        <div className="h-20 bg-black/40 border-b border-white/5 p-2 grid grid-cols-3 gap-2 items-center">
          {track.sends.map(s => <SendKnob key={s.id} send={s} track={track} onUpdate={onUpdate} />)}
        </div>
      )}
      
      <div className={`${track.type === TrackType.BUS ? 'h-52' : 'h-40'} bg-black/20 border-b border-white/5 p-2 space-y-1.5 overflow-y-auto custom-scroll`}>
        <span className="text-[7px] font-black text-slate-600 uppercase px-1 mb-1 block">{track.type === TrackType.BUS ? 'Bus Inserts' : (isMaster ? 'Master Chain' : 'Inserts')}</span>
        {track.plugins.map(p => (
          <div key={p.id} className="relative group/fxslot w-full h-8 mb-1 fx-slot">
            <button 
              onClick={(e) => handleFXClick(e, p)}
              onTouchStart={(e) => handleFXClick(e, p)}
              className={`w-full h-full bg-black/40 rounded border border-white/5 text-[9px] font-black hover:border-cyan-500/40 transition-all px-2 text-left truncate flex items-center pr-12 ${p.isEnabled ? 'text-cyan-400' : 'text-slate-600'}`}
            >
               {p.type}
            </button>
            <div className="absolute right-1 top-0 bottom-0 flex items-center space-x-1">
               <button onClick={(e) => { e.stopPropagation(); onToggleBypass?.(track.id, p.id); }} onTouchStart={(e) => { e.stopPropagation(); onToggleBypass?.(track.id, p.id); }} className={`w-5 h-5 rounded flex items-center justify-center transition-all ${p.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'}`}><i className="fas fa-power-off text-[7px]"></i></button>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onRemovePlugin?.(track.id, p.id); }} onTouchStart={(e) => { e.stopPropagation(); onRemovePlugin?.(track.id, p.id); }} className="delete-fx"><i className="fas fa-times"></i></button>
          </div>
        ))}
        {/* Empty slots (+) removed */}
      </div>

      <div className="flex-1 p-3 flex flex-col">
        {/* I/O SECTION */}
        {!isMaster && (
            <IOSection track={track} allTracks={allTracks} onUpdate={onUpdate} />
        )}

        <div className="mb-2 flex flex-col items-center">
           <SmartKnob id={`${track.id}-pan`} targetId={track.id} paramId="pan" label="PAN" value={track.pan} min={-1} max={1} size={36} color="#06b6d4" onChange={(val) => onUpdate({...track, pan: val})} />
        </div>

        <div className="flex-1 flex space-x-3 px-2">
           <div className="flex-1 relative flex flex-col items-center">
              <div 
                ref={faderTrackRef} 
                onMouseDown={onVolMouseDown}
                onTouchStart={onVolTouchStart}
                onTouchMove={onVolTouchMove}
                className="h-full bg-black/40 rounded-full border border-white/5 relative cursor-pointer touch-none group/fader"
                style={{ width: 'var(--fader-width)' }}
              >
                 <div className={`absolute left-1/2 -translate-x-1/2 rounded border border-white/20 shadow-2xl z-20 flex items-center justify-center ${track.type === TrackType.BUS ? 'w-10 h-16 bg-amber-500 border-amber-400' : 'w-9 h-14 bg-[#1e2229]'}`} style={{ bottom: `calc(${(Math.sqrt(track.volume / 1.5))*100}% - 28px)` }}>
                    <div className={`w-full h-0.5 ${track.type === TrackType.BUS ? 'bg-black' : 'bg-cyan-500'}`} />
                 </div>
              </div>
           </div>
           <div className="flex space-x-1">
              <VUMeter analyzer={analyzer} />
              <VUMeter analyzer={analyzerR} />
           </div>
        </div>

        <div className="mt-4 flex space-x-2">
           <button onClick={() => onUpdate({...track, isMuted: !track.isMuted})} onTouchStart={() => onUpdate({...track, isMuted: !track.isMuted})} className={`flex-1 h-8 rounded text-[9px] font-black border ${track.isMuted ? 'bg-amber-500 text-black border-amber-400' : 'bg-white/5 border-white/5 text-slate-600'}`}>MUTE</button>
           <button onClick={() => onUpdate({...track, isSolo: !track.isSolo})} onTouchStart={() => onUpdate({...track, isSolo: !track.isSolo})} className={`flex-1 h-8 rounded text-[9px] font-black border ${track.isSolo ? 'bg-cyan-500 text-black border-cyan-400' : 'bg-white/5 border-white/5 text-slate-600'}`}>SOLO</button>
        </div>
        
        <div className={`mt-3 h-10 rounded-lg flex items-center px-2 text-[9px] font-black uppercase border truncate relative ${track.type === TrackType.BUS ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-black/40 border-white/10 text-white'}`}>
           <div className="w-1.5 h-full mr-2 rounded-full" style={{ backgroundColor: track.color }} />
           <span className="truncate">{track.name}</span>
        </div>
      </div>
    </div>
  );
};

const MixerView: React.FC<{ 
  tracks: Track[], 
  onUpdateTrack: (t: Track) => void, 
  onOpenPlugin?: (tid: string, p: PluginInstance) => void, 
  onToggleBypass?: (tid: string, pid: string) => void, 
  onRemovePlugin?: (tid: string, pid: string) => void, 
  onDropPluginOnTrack?: (tid: string, type: PluginType, metadata?: any) => void, 
  onRequestAddPlugin?: (tid: string, x: number, y: number) => void,
  onAddBus?: () => void
}> = ({ tracks, onUpdateTrack, onOpenPlugin, onToggleBypass, onRemovePlugin, onDropPluginOnTrack, onRequestAddPlugin, onAddBus }) => {
  const audioTracks = tracks.filter(t => t.type === TrackType.AUDIO || t.type === TrackType.SAMPLER || t.type === TrackType.MIDI);
  const busTracks = tracks.filter(t => t.type === TrackType.BUS && t.id !== 'master');
  const sendTracks = tracks.filter(t => t.type === TrackType.SEND);
  const masterTrack = tracks.find(t => t.id === 'master');

  return (
    <div className="flex-1 flex overflow-x-auto bg-[#08090b] custom-scroll h-full snap-x snap-mandatory">
      {audioTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onUpdate={onUpdateTrack} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      
      <div className="flex flex-col items-center justify-center px-2 border-r border-white/5 min-w-[60px] space-y-4">
         <button onClick={onAddBus} className="w-12 h-12 rounded-2xl border border-dashed border-amber-500/30 text-amber-500 hover:bg-amber-500/10 flex items-center justify-center transition-all group">
            <i className="fas fa-plus group-hover:scale-125 transition-transform"></i>
         </button>
         <span className="text-[8px] font-black text-amber-600 uppercase writing-vertical rotate-180">ADD BUS</span>
      </div>

      {busTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onUpdate={onUpdateTrack} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      <div className="w-4 bg-black/30 border-r border-white/5" />
      {sendTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onUpdate={onUpdateTrack} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      <div className="w-10 bg-black/50 border-r border-white/5" />
      <div className="snap-start"><ChannelStrip track={masterTrack || { id: 'master', name: 'MASTER BUS', type: TrackType.BUS, color: '#00f2ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0 }} allTracks={tracks} onUpdate={() => {}} isMaster={true} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>
    </div>
  );
};
export default MixerView;
