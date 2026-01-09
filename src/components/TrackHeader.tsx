
import React, { useState, useRef, useEffect } from 'react';
import { Track, TrackType, TrackSend } from '../types';

interface TrackHeaderProps {
  track: Track;
  onUpdate: (track: Track, altKey?: boolean) => void;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent, trackId: string) => void;
  onDragStartTrack: (trackId: string) => void;
  onDragOverTrack: (trackId: string) => void;
  onDropTrack: () => void;
  isDraggingOver?: boolean;
  onSwapInstrument?: (trackId: string) => void;
  // Removed Plugin Props
}

const HorizontalSendFader: React.FC<{ 
  send: TrackSend, 
  trackId: string,
  color: string, 
  label: string, 
  onChange: (level: number) => void 
}> = ({ send, trackId, color, label, onChange }) => {
  const handleInteraction = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left;
    const progress = Math.max(0, Math.min(1, x / rect.width));
    onChange(progress * 1.5); 
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    handleInteraction(e.clientX, rect);
    const onMouseMove = (m: MouseEvent) => handleInteraction(m.clientX, rect);
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    handleInteraction(e.touches[0].clientX, rect);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    handleInteraction(e.touches[0].clientX, rect);
  };

  const percent = (send.level / 1.5) * 100;

  return (
    <div 
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      className="relative h-5 bg-black/60 rounded-md overflow-hidden border border-white/5 cursor-ew-resize group/fader mb-1 last:mb-0 transition-all hover:border-white/20 touch-none"
    >
      <div 
        className="absolute inset-y-0 left-0 transition-all duration-75"
        style={{ width: `${percent}%`, backgroundColor: color, opacity: 0.25 }}
      />
      <div 
        className="absolute inset-y-0 left-0 border-r-2 transition-all duration-75"
        style={{ width: `${percent}%`, borderColor: color, boxShadow: send.level > 0.05 ? `0 0 10px ${color}` : 'none' }}
      />
      <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
        <span className="text-[7px] font-black text-white/80 uppercase tracking-tighter">{label}</span>
        <span className="text-[7px] font-mono text-white/40">{Math.round((send.level / 1.5) * 100)}%</span>
      </div>
    </div>
  );
};

const TrackHeader: React.FC<TrackHeaderProps> = ({ 
  track, onUpdate, isSelected, onSelect, onContextMenu,
  onDragStartTrack, onDragOverTrack, onDropTrack, isDraggingOver, onSwapInstrument
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [showSends, setShowSends] = useState(false);
  const [isAdjustingVolume, setIsAdjustingVolume] = useState(false);
  const [newName, setNewName] = useState(track.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [isRenaming]);

  const handleNameSubmit = () => {
    setIsRenaming(false);
    if (newName.trim() && newName !== track.name) {
      onUpdate({ ...track, name: newName });
    }
  };

  const handleSendChange = (sendId: string, level: number) => {
    const newSends = track.sends.map(s => s.id === sendId ? { ...s, level } : s);
    onUpdate({ ...track, sends: newSends });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); 
    e.stopPropagation();
    
    if (e.dataTransfer.types.includes('trackid')) {
        onDragOverTrack(track.id);
        e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleOnDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer.getData('trackId')) {
      onDropTrack();
    }
  };

  // --- PAN CONTROL ---
  const handlePanMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const startY = e.clientY;
    const startPan = track.pan;
    const onMouseMove = (m: MouseEvent) => {
      const delta = (startY - m.clientY) / 100;
      onUpdate({ ...track, pan: Math.max(-1, Math.min(1, startPan + delta)) });
    };
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handlePanTouchStart = (e: React.TouchEvent) => {
      e.stopPropagation();
  };

  // --- VOLUME CONTROL ---
  const handleVolumeInteraction = (clientX: number, rect: DOMRect) => {
      const x = clientX - rect.left;
      const progress = Math.max(0, Math.min(1, x / rect.width));
      onUpdate({ ...track, volume: progress * progress * 1.5 });
  };

  const handleVolumeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    setIsAdjustingVolume(true);
    const rect = e.currentTarget.getBoundingClientRect();
    handleVolumeInteraction(e.clientX, rect);
    const onMouseMove = (m: MouseEvent) => handleVolumeInteraction(m.clientX, rect);
    const onMouseUp = () => { setIsAdjustingVolume(false); window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleVolumeTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    setIsAdjustingVolume(true);
    const rect = e.currentTarget.getBoundingClientRect();
    handleVolumeInteraction(e.touches[0].clientX, rect);
  };

  const handleVolumeTouchMove = (e: React.TouchEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    handleVolumeInteraction(e.touches[0].clientX, rect);
  };

  const handleVolumeTouchEnd = () => setIsAdjustingVolume(false);

  const toggleAutomation = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    let lanes = [...track.automationLanes];
    if (lanes.length === 0) {
      lanes.push({ 
          id: `auto-${Date.now()}`, 
          parameterName: 'volume', 
          points: [{ id: 'p-init', time: 0, value: track.volume }], 
          color: track.color, 
          isExpanded: true, 
          min: 0, 
          max: 1.5 
      });
    } else {
      lanes = lanes.map(l => ({ ...l, isExpanded: !l.isExpanded }));
    }
    onUpdate({ ...track, automationLanes: lanes });
  };

  const handleMuteToggle = (e: React.MouseEvent | React.TouchEvent) => { e.stopPropagation(); onUpdate({ ...track, isMuted: !track.isMuted }); };
  const handleSoloToggle = (e: React.MouseEvent | React.TouchEvent) => { e.stopPropagation(); onUpdate({ ...track, isSolo: !track.isSolo }); };

  const canHaveSends = (track.type === TrackType.AUDIO || track.type === TrackType.BUS || track.type === TrackType.MIDI || track.type === TrackType.SAMPLER || track.type === TrackType.DRUM_RACK) && track.id !== 'instrumental' && track.id !== 'master';
  const isAudio = track.type === TrackType.AUDIO;
  const isMidiOrSampler = track.type === TrackType.MIDI || track.type === TrackType.SAMPLER || track.type === TrackType.DRUM_RACK;

  const getTrackIcon = () => {
      if (track.type === TrackType.MIDI) return 'fa-music';
      if (track.type === TrackType.SAMPLER) return 'fa-wave-square';
      if (track.type === TrackType.DRUM_RACK) return 'fa-th';
      if (track.type === TrackType.BUS) return 'fa-layer-group';
      if (track.type === TrackType.SEND) return 'fa-magic';
      return 'fa-wave-square';
  };

  return (
    <div 
      onClick={onSelect}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, track.id); }}
      onDragOver={handleDragOver}
      onDrop={handleOnDrop}
      className={`group border-b border-white/[0.03] p-3 flex flex-col h-full relative transition-all ${isSelected ? 'bg-white/[0.08]' : 'bg-transparent'} ${track.isFrozen ? 'opacity-60 grayscale' : ''} ${isDraggingOver ? 'border-t-2 border-t-cyan-500 bg-cyan-500/5' : ''}`}
      style={{ borderLeft: `4px solid ${track.color}` }}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center truncate flex-1 pr-2">
          {/* Drag Handle & Type Icon */}
          <div 
            draggable 
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('trackId', track.id); onDragStartTrack(track.id); }}
            className="cursor-grab active:cursor-grabbing text-slate-500 hover:text-cyan-500 mr-2 flex-shrink-0 transition-colors p-1 flex items-center space-x-2"
          >
            <i className="fas fa-grip-vertical text-[10px]"></i>
            <i className={`fas ${getTrackIcon()} text-[10px] ${isSelected ? 'text-white' : ''}`}></i>
          </div>

          <div className="truncate">
            {isRenaming ? (
              <input 
                ref={nameInputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={handleNameSubmit}
                onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
                className="bg-black/60 border border-cyan-500/50 rounded px-1 text-[10px] font-black uppercase text-white outline-none w-full"
              />
            ) : (
              <span 
                onDoubleClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                className={`text-[10px] font-black uppercase tracking-widest truncate cursor-text ${isSelected ? 'text-white' : 'text-slate-500'}`}
              >
                {track.name} {track.isFrozen && <i className="fas fa-snowflake text-[8px] ml-1 text-cyan-400"></i>}
              </span>
            )}
          </div>
        </div>
        
        {/* BOUTONS ACTIONS */}
        <div className="flex space-x-1 shrink-0">
          <button 
            onClick={handleMuteToggle}
            onTouchStart={handleMuteToggle}
            className={`w-7 h-7 rounded-md flex items-center justify-center transition-all border ${track.isMuted ? 'bg-red-600 border-red-500 text-white shadow-[0_0_8px_rgba(220,38,38,0.4)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <span className="text-[9px] font-black">M</span>
          </button>
          <button 
            onClick={handleSoloToggle}
            onTouchStart={handleSoloToggle}
            className={`w-7 h-7 rounded-md flex items-center justify-center transition-all border ${track.isSolo ? 'bg-amber-400 border-amber-300 text-black shadow-[0_0_8px_rgba(251,191,36,0.4)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <span className="text-[9px] font-black">S</span>
          </button>
          
          {canHaveSends && (
            <button 
              onClick={(e) => { e.stopPropagation(); setShowSends(!showSends); }} 
              onTouchStart={(e) => { e.stopPropagation(); setShowSends(!showSends); }}
              className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${showSends ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-600 hover:text-white'}`}
            >
              <i className="fas fa-sliders-h text-[10px]"></i>
            </button>
          )}

          {(isAudio || isMidiOrSampler) && (
              <button 
                onClick={(e) => { e.stopPropagation(); onUpdate({...track, isTrackArmed: !track.isTrackArmed}) }} 
                onTouchStart={(e) => { e.stopPropagation(); onUpdate({...track, isTrackArmed: !track.isTrackArmed}) }} 
                className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${track.isTrackArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/5 text-slate-600 hover:text-white'}`}
                title="Arm Track for Recording"
              >
                <span className="text-[9px] font-black">R</span>
              </button>
          )}
        </div>
      </div>
      
      {/* Horizontal Sends Panel */}
      {canHaveSends && showSends && (
        <div className="flex flex-col bg-black/40 rounded-lg p-2 border border-cyan-500/20 mb-2 animate-in slide-in-from-top-1 space-y-1">
          <HorizontalSendFader trackId={track.id} label="Delay 1/4" color="#00f2ff" send={track.sends.find(s => s.id === 'send-delay') || { id: 'send-delay', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-delay', lvl)} />
          <HorizontalSendFader trackId={track.id} label="Verb Pro" color="#10b981" send={track.sends.find(s => s.id === 'send-verb-short') || { id: 'send-verb-short', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-verb-short', lvl)} />
          <HorizontalSendFader trackId={track.id} label="Hall Space" color="#a855f7" send={track.sends.find(s => s.id === 'send-verb-long') || { id: 'send-verb-long', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-verb-long', lvl)} />
        </div>
      )}

      {/* ZONE DES CONTRÔLES : Panoramique et Volume */}
      <div className="flex items-center space-x-3 mt-1 bg-black/20 p-2 rounded-lg border border-white/5 relative z-10">
        <div 
          onMouseDown={handlePanMouseDown}
          onTouchStart={handlePanTouchStart}
          onDoubleClick={(e) => { e.stopPropagation(); onUpdate({...track, pan: 0}); }}
          className="relative w-7 h-7 rounded-full bg-black border border-white/10 flex items-center justify-center cursor-ns-resize shadow-lg hover:border-cyan-500/30 transition-all touch-none group/pan"
        >
          <div className="w-0.5 h-3 bg-cyan-400 rounded-full" style={{ transform: `rotate(${track.pan * 140}deg) translateY(-1px)` }} />
        </div>
        
        <div className="flex-1 flex flex-col justify-center h-6 relative">
          <div 
            onMouseDown={handleVolumeMouseDown}
            onTouchStart={handleVolumeTouchStart}
            onTouchMove={handleVolumeTouchMove}
            onTouchEnd={handleVolumeTouchEnd}
            className="h-3 bg-black/60 rounded-full overflow-hidden relative cursor-ew-resize group/vol touch-none"
          >
            {/* Jauge de volume visuelle */}
            <div 
              className={`h-full transition-all duration-75 ${isAdjustingVolume ? 'brightness-150' : 'brightness-100'}`} 
              style={{ 
                width: `${(Math.sqrt(track.volume / 1.5)) * 100}%`, 
                backgroundColor: track.color,
                boxShadow: isAdjustingVolume ? `0 0 10px ${track.color}` : 'none'
              }} 
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[7px] font-mono text-white/40 pointer-events-none group-hover/vol:text-white/80 transition-colors uppercase">
              {Math.round(track.volume * 100)}%
            </span>
          </div>
        </div>
      </div>
      
      {/* Plugin Grid Removed */}
    </div>
  );
};
export default TrackHeader;
