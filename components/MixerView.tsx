
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Track, TrackType, PluginInstance, TrackSend, PluginType, TrackGroup } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { SmartKnob } from './SmartKnob';
import { getValidDestinations, getRouteLabel } from './RoutingManager';

// Track Group Colors (inspired by Pro Tools)
const GROUP_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', 
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
];

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
            {/* INPUT SELECTOR - Uniquement visible pour la piste REC */}
            {track.id === 'track-rec-main' && (
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
            )}

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
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void,
  onCopyPluginToTrack?: (sourceTrackId: string, plugin: PluginInstance, destTrackId: string) => void,
  onReorderPlugins?: (trackId: string, fromIndex: number, toIndex: number) => void
}> = ({ track, allTracks, onUpdate, isMaster = false, onOpenPlugin, onToggleBypass, onRemovePlugin, onDropPlugin, onRequestAddPlugin, onCopyPluginToTrack, onReorderPlugins }) => {
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
        {track.plugins.map((p, idx) => (
          <div 
            key={p.id} 
            className="relative group/fxslot w-full h-8 mb-1 fx-slot"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('pluginData', JSON.stringify(p));
              e.dataTransfer.setData('sourceTrackId', track.id);
              e.dataTransfer.setData('pluginIndex', String(idx));
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer.types.includes('plugindata') || e.dataTransfer.types.includes('sourcetrackid')) {
                e.currentTarget.classList.add('border-cyan-500', 'border-2');
              }
            }}
            onDragLeave={(e) => {
              e.currentTarget.classList.remove('border-cyan-500', 'border-2');
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.classList.remove('border-cyan-500', 'border-2');
              
              const sourceTrackId = e.dataTransfer.getData('sourceTrackId');
              const pluginDataStr = e.dataTransfer.getData('pluginData');
              const fromIndex = parseInt(e.dataTransfer.getData('pluginIndex'), 10);
              
              if (pluginDataStr && sourceTrackId) {
                const pluginData = JSON.parse(pluginDataStr) as PluginInstance;
                
                // Same track = reorder
                if (sourceTrackId === track.id && onReorderPlugins) {
                  onReorderPlugins(track.id, fromIndex, idx);
                } 
                // Different track = copy
                else if (sourceTrackId !== track.id && onCopyPluginToTrack) {
                  onCopyPluginToTrack(sourceTrackId, pluginData, track.id);
                }
              }
            }}
          >
            <button 
              onClick={(e) => handleFXClick(e, p)}
              onTouchStart={(e) => handleFXClick(e, p)}
              className={`w-full h-full bg-black/40 rounded border border-white/5 text-[9px] font-black hover:border-cyan-500/40 transition-all px-2 text-left truncate flex items-center pr-20 cursor-grab active:cursor-grabbing ${p.isEnabled ? 'text-cyan-400' : 'text-slate-600'}`}
            >
               <i className="fas fa-grip-vertical text-slate-700 mr-2 text-[8px]"></i>
               {p.type}
            </button>
            <div className="absolute right-1 top-0 bottom-0 flex items-center space-x-0.5">
               {/* Move Up/Down Buttons */}
               <div className="flex flex-col opacity-0 group-hover/fxslot:opacity-100 transition-opacity">
                  <button 
                    onClick={(e) => { e.stopPropagation(); if (idx > 0 && onReorderPlugins) onReorderPlugins(track.id, idx, idx - 1); }}
                    className={`w-4 h-3 rounded-t flex items-center justify-center text-[6px] ${idx > 0 ? 'text-slate-500 hover:text-cyan-400 hover:bg-cyan-500/20' : 'text-slate-800 cursor-not-allowed'}`}
                    disabled={idx === 0}
                    title="Move Up"
                  >
                    <i className="fas fa-chevron-up"></i>
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); if (idx < track.plugins.length - 1 && onReorderPlugins) onReorderPlugins(track.id, idx, idx + 1); }}
                    className={`w-4 h-3 rounded-b flex items-center justify-center text-[6px] ${idx < track.plugins.length - 1 ? 'text-slate-500 hover:text-cyan-400 hover:bg-cyan-500/20' : 'text-slate-800 cursor-not-allowed'}`}
                    disabled={idx === track.plugins.length - 1}
                    title="Move Down"
                  >
                    <i className="fas fa-chevron-down"></i>
                  </button>
               </div>
               <button onClick={(e) => { e.stopPropagation(); onToggleBypass?.(track.id, p.id); }} onTouchStart={(e) => { e.stopPropagation(); onToggleBypass?.(track.id, p.id); }} className={`w-5 h-5 rounded flex items-center justify-center transition-all ${p.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'}`}><i className="fas fa-power-off text-[7px]"></i></button>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onRemovePlugin?.(track.id, p.id); }} onTouchStart={(e) => { e.stopPropagation(); onRemovePlugin?.(track.id, p.id); }} className="delete-fx"><i className="fas fa-times"></i></button>
          </div>
        ))}
        {/* Boutons + pour ajouter des plugins */}
        {Array.from({ length: Math.max(0, 6 - track.plugins.length) }).map((_, i) => (
          <button
            key={`empty-${i}`}
            onClick={handleEmptySlotClick}
            onTouchStart={handleEmptySlotClick}
            className="w-full h-8 rounded border border-dashed border-white/10 bg-black/5 opacity-40 hover:opacity-100 hover:border-cyan-500/50 transition-all flex items-center justify-center"
          >
            <i className="fas fa-plus text-[8px] text-slate-600"></i>
          </button>
        ))}
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

// Track Group Header Panel (inspired by Pro Tools/Reaper)
const TrackGroupHeader: React.FC<{
  group: TrackGroup;
  tracks: Track[];
  onUpdate: (group: TrackGroup) => void;
  onDelete: () => void;
  onToggleCollapse: () => void;
}> = ({ group, tracks, onUpdate, onDelete, onToggleCollapse }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(group.name);
  
  const groupTracks = tracks.filter(t => group.trackIds.includes(t.id));
  const isAnyMuted = groupTracks.some(t => t.isMuted);
  const isAnySoloed = groupTracks.some(t => t.isSolo);
  
  return (
    <div 
      className="flex-shrink-0 w-10 flex flex-col h-full border-r transition-all"
      style={{ 
        backgroundColor: group.color + '15', 
        borderColor: group.color + '40' 
      }}
    >
      {/* Group Header */}
      <div 
        className="h-8 flex items-center justify-center cursor-pointer border-b"
        style={{ backgroundColor: group.color, borderColor: group.color }}
        onClick={onToggleCollapse}
        title={group.isCollapsed ? 'Expand Group' : 'Collapse Group'}
      >
        <i className={`fas ${group.isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'} text-[10px] text-black`}></i>
      </div>
      
      {/* Group Name (Vertical) */}
      <div className="flex-1 flex items-center justify-center py-2">
        {isEditing ? (
          <input
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onBlur={() => { onUpdate({ ...group, name: tempName }); setIsEditing(false); }}
            onKeyDown={(e) => e.key === 'Enter' && (onUpdate({ ...group, name: tempName }), setIsEditing(false))}
            className="w-full h-6 bg-black/50 border-none text-[9px] font-bold text-center text-white outline-none"
            autoFocus
          />
        ) : (
          <span 
            className="writing-vertical rotate-180 text-[9px] font-black uppercase tracking-wider cursor-pointer"
            style={{ color: group.color }}
            onClick={() => setIsEditing(true)}
          >
            {group.name}
          </span>
        )}
      </div>
      
      {/* Group Controls */}
      <div className="space-y-1 p-1 border-t" style={{ borderColor: group.color + '40' }}>
        {/* Linked Mute */}
        <button
          onClick={() => onUpdate({ ...group, linkedMute: !group.linkedMute })}
          className={`w-full h-6 rounded text-[8px] font-black ${group.linkedMute ? 'text-black' : 'text-slate-600'}`}
          style={{ backgroundColor: group.linkedMute ? group.color : 'transparent' }}
          title="Link Mute"
        >
          M
        </button>
        
        {/* Linked Solo */}
        <button
          onClick={() => onUpdate({ ...group, linkedSolo: !group.linkedSolo })}
          className={`w-full h-6 rounded text-[8px] font-black ${group.linkedSolo ? 'text-black' : 'text-slate-600'}`}
          style={{ backgroundColor: group.linkedSolo ? group.color : 'transparent' }}
          title="Link Solo"
        >
          S
        </button>
        
        {/* Linked Volume */}
        <button
          onClick={() => onUpdate({ ...group, linkedVolume: !group.linkedVolume })}
          className={`w-full h-6 rounded text-[8px] font-black ${group.linkedVolume ? 'text-black' : 'text-slate-600'}`}
          style={{ backgroundColor: group.linkedVolume ? group.color : 'transparent' }}
          title="Link Volume"
        >
          V
        </button>
      </div>
      
      {/* Delete Group */}
      <button
        onClick={onDelete}
        className="h-8 flex items-center justify-center text-slate-600 hover:text-red-500 transition-colors border-t"
        style={{ borderColor: group.color + '40' }}
        title="Delete Group"
      >
        <i className="fas fa-times text-[10px]"></i>
      </button>
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
  onAddBus?: () => void,
  // NEW: Track Groups (inspired by Pro Tools/Reaper)
  trackGroups?: TrackGroup[],
  onCreateGroup?: (trackIds: string[]) => void,
  onUpdateGroup?: (group: TrackGroup) => void,
  onDeleteGroup?: (groupId: string) => void
}> = ({ 
  tracks, onUpdateTrack, onOpenPlugin, onToggleBypass, onRemovePlugin, 
  onDropPluginOnTrack, onRequestAddPlugin, onAddBus,
  trackGroups = [], onCreateGroup, onUpdateGroup, onDeleteGroup
}) => {
  const audioTracks = tracks.filter(t => t.type === TrackType.AUDIO || t.type === TrackType.SAMPLER || t.type === TrackType.MIDI);
  const busTracks = tracks.filter(t => t.type === TrackType.BUS && t.id !== 'master');
  const sendTracks = tracks.filter(t => t.type === TrackType.SEND);
  const masterTrack = tracks.find(t => t.id === 'master');

  // Get selected tracks for grouping
  const [selectedForGroup, setSelectedForGroup] = useState<Set<string>>(new Set());
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  
  // Handle linked group actions
  const handleGroupedTrackUpdate = useCallback((track: Track, update: Partial<Track>) => {
    const trackGroup = trackGroups.find(g => g.trackIds.includes(track.id));
    
    if (trackGroup) {
      // Apply linked updates to all tracks in group
      if (trackGroup.linkedVolume && 'volume' in update) {
        const volumeRatio = (update.volume || 0) / track.volume;
        trackGroup.trackIds.forEach(tid => {
          const t = tracks.find(tr => tr.id === tid);
          if (t) onUpdateTrack({ ...t, volume: Math.min(1.5, t.volume * volumeRatio) });
        });
        return;
      }
      if (trackGroup.linkedMute && 'isMuted' in update) {
        trackGroup.trackIds.forEach(tid => {
          const t = tracks.find(tr => tr.id === tid);
          if (t) onUpdateTrack({ ...t, isMuted: update.isMuted! });
        });
        return;
      }
      if (trackGroup.linkedSolo && 'isSolo' in update) {
        trackGroup.trackIds.forEach(tid => {
          const t = tracks.find(tr => tr.id === tid);
          if (t) onUpdateTrack({ ...t, isSolo: update.isSolo! });
        });
        return;
      }
    }
    
    // Default: just update the single track
    onUpdateTrack({ ...track, ...update });
  }, [trackGroups, tracks, onUpdateTrack]);
  
  return (
    <div className="flex-1 flex overflow-x-auto bg-[#08090b] custom-scroll h-full snap-x snap-mandatory">
      {/* Track Groups Panel (inspired by Pro Tools) */}
      {trackGroups.length > 0 && (
        <div className="flex border-r border-white/10 bg-black/20">
          {trackGroups.map(group => (
            <TrackGroupHeader
              key={group.id}
              group={group}
              tracks={tracks}
              onUpdate={(g) => onUpdateGroup?.(g)}
              onDelete={() => onDeleteGroup?.(group.id)}
              onToggleCollapse={() => onUpdateGroup?.({ ...group, isCollapsed: !group.isCollapsed })}
            />
          ))}
        </div>
      )}
      
      {audioTracks.map(t => {
        const trackGroup = trackGroups.find(g => g.trackIds.includes(t.id));
        if (trackGroup?.isCollapsed) return null; // Hide if group is collapsed
        
        return (
          <div key={t.id} className="snap-start relative">
            {/* Group color indicator */}
            {trackGroup && (
              <div 
                className="absolute top-0 left-0 w-1 h-full z-10"
                style={{ backgroundColor: trackGroup.color }}
              />
            )}
            <ChannelStrip 
              track={t} 
              allTracks={tracks} 
              onUpdate={(updatedTrack) => handleGroupedTrackUpdate(t, updatedTrack)} 
              onOpenPlugin={onOpenPlugin} 
              onToggleBypass={onToggleBypass} 
              onRemovePlugin={onRemovePlugin} 
              onDropPlugin={onDropPluginOnTrack} 
              onRequestAddPlugin={onRequestAddPlugin} 
            />
          </div>
        );
      })}
      
      {/* ADD BUS / CREATE GROUP Section */}
      <div className="flex flex-col items-center justify-center px-2 border-r border-white/5 min-w-[60px] space-y-3">
         <button onClick={onAddBus} className="w-12 h-12 rounded-2xl border border-dashed border-amber-500/30 text-amber-500 hover:bg-amber-500/10 flex items-center justify-center transition-all group" title="Add Bus Track">
            <i className="fas fa-plus group-hover:scale-125 transition-transform"></i>
         </button>
         <span className="text-[8px] font-black text-amber-600 uppercase writing-vertical rotate-180">ADD BUS</span>
         
         {/* Create Group Button (inspired by Pro Tools) */}
         {onCreateGroup && (
           <>
             <div className="w-8 h-px bg-white/10 my-1"></div>
             <button 
               onClick={() => setShowGroupMenu(!showGroupMenu)}
               className="w-10 h-10 rounded-xl border border-dashed border-purple-500/30 text-purple-400 hover:bg-purple-500/10 flex items-center justify-center transition-all relative"
               title="Create Track Group"
             >
               <i className="fas fa-layer-group text-[11px]"></i>
             </button>
             <span className="text-[7px] font-black text-purple-500 uppercase writing-vertical rotate-180">GROUP</span>
             
             {/* Group Creation Menu */}
             {showGroupMenu && (
               <div className="absolute left-16 bottom-20 bg-[#1a1c22] border border-white/20 rounded-xl shadow-2xl z-[100] p-3 w-64">
                 <div className="text-[10px] font-black uppercase text-slate-400 mb-3">Create Track Group</div>
                 
                 <div className="space-y-2 max-h-40 overflow-y-auto mb-3">
                   {audioTracks.map(t => (
                     <label 
                       key={t.id}
                       className={`flex items-center space-x-2 p-2 rounded cursor-pointer transition-all ${selectedForGroup.has(t.id) ? 'bg-purple-500/20' : 'hover:bg-white/5'}`}
                     >
                       <input
                         type="checkbox"
                         checked={selectedForGroup.has(t.id)}
                         onChange={(e) => {
                           const newSet = new Set(selectedForGroup);
                           if (e.target.checked) newSet.add(t.id);
                           else newSet.delete(t.id);
                           setSelectedForGroup(newSet);
                         }}
                         className="accent-purple-500"
                       />
                       <div className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }}></div>
                       <span className="text-[10px] font-bold text-white truncate">{t.name}</span>
                     </label>
                   ))}
                 </div>
                 
                 <div className="flex space-x-2">
                   <button
                     onClick={() => setShowGroupMenu(false)}
                     className="flex-1 py-2 rounded bg-white/5 text-slate-400 text-[10px] font-bold"
                   >
                     Cancel
                   </button>
                   <button
                     onClick={() => {
                       if (selectedForGroup.size >= 2) {
                         onCreateGroup(Array.from(selectedForGroup));
                         setSelectedForGroup(new Set());
                         setShowGroupMenu(false);
                       }
                     }}
                     disabled={selectedForGroup.size < 2}
                     className={`flex-1 py-2 rounded text-[10px] font-bold ${selectedForGroup.size >= 2 ? 'bg-purple-500 text-white' : 'bg-white/5 text-slate-600'}`}
                   >
                     Create ({selectedForGroup.size})
                   </button>
                 </div>
               </div>
             )}
           </>
         )}
      </div>

      {busTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onUpdate={(updatedTrack) => onUpdateTrack(updatedTrack)} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      <div className="w-4 bg-black/30 border-r border-white/5" />
      {sendTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onUpdate={onUpdateTrack} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>)}
      <div className="w-10 bg-black/50 border-r border-white/5" />
      <div className="snap-start"><ChannelStrip track={masterTrack || { id: 'master', name: 'MASTER BUS', type: TrackType.BUS, color: '#00f2ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0 }} allTracks={tracks} onUpdate={() => {}} isMaster={true} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} /></div>
    </div>
  );
};
export default MixerView;
