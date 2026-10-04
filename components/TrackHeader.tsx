
import React, { useState, useRef, useEffect } from 'react';
import { AutotuneBadge } from './AutotuneVstPanel';
import { useCollabRole, requestVolumeLock } from '../utils/collabStore';
import { useSimpleMode } from '../utils/simpleMode';
import { gainToDbText, panToText } from '../utils/db';
import { useKnobInteraction } from '../hooks/useKnobInteraction';

/**
 * Glissière horizontale « position absolue » (clic = la valeur sous le pointeur),
 * avec Maj enfoncée = réglage fin relatif, double-clic = valeur par défaut.
 * pos : 0…1 sur la largeur de l'élément.
 */
const dragHorizontal = (e: React.MouseEvent, startPos: number, apply: (pos: number) => void, onEnd?: () => void) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  let pos = startPos;
  let lastX = e.clientX;
  if (!e.shiftKey) { pos = clamp((e.clientX - rect.left) / rect.width); apply(pos); }
  const onMouseMove = (m: MouseEvent) => {
    pos = m.shiftKey ? clamp(pos + ((m.clientX - lastX) / rect.width) * 0.1) : clamp((m.clientX - rect.left) / rect.width);
    lastX = m.clientX;
    apply(pos);
  };
  const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); onEnd?.(); };
  window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
};
import { Track, PluginType, PluginInstance, TrackType, TrackSend } from '../types';
import { isPluginBaked, isFreezeStale, isTrackFrozen } from '../utils/freeze';
import { useRecFrozen } from '../utils/recFreezeStore';
import { useInstrumentStatus } from '../utils/instrumentStore';
import MonitorControl from './MonitorControl';

interface TrackHeaderProps {
  track: Track;
  onUpdate: (track: Track, altKey?: boolean) => void;
  isSelected: boolean;
  onSelect: () => void;
  onDropPlugin?: (trackId: string, type: PluginType, metadata?: any) => void;
  onMovePlugin?: (sourceTrackId: string, destTrackId: string, pluginId: string) => void;
  onSelectPlugin?: (trackId: string, plugin: PluginInstance) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void;
  onContextMenu: (e: React.MouseEvent, trackId: string) => void;
  onDragStartTrack: (trackId: string) => void;
  onDragOverTrack: (trackId: string) => void;
  onDropTrack: () => void;
  isDraggingOver?: boolean;
  onSwapInstrument?: (trackId: string) => void;
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
  // Molette / double-clic (0 dB) partagés avec les autres potards
  const knob = useKnobInteraction(send.level / 1.5, (p) => onChange(p * 1.5), { min: 0, max: 1, defaultValue: 1 / 1.5, wheelStep: 0.01 });

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (e.detail >= 2) { knob.handleDoubleClick(); return; }
    dragHorizontal(e, send.level / 1.5, (p) => onChange(p * 1.5));
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
      ref={knob.wheelRef}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      role="slider"
      aria-label={`Envoi ${label}`}
      aria-valuetext={gainToDbText(send.level)}
      title={`Envoi ${label} : glisser (Maj = fin), molette, double-clic = 0 dB`}
      className="relative h-5 bg-black/60 rounded-md overflow-hidden border border-white/5 cursor-ew-resize group/fader transition-all hover:border-white/20 touch-none"
    >
      <div 
        className="absolute inset-y-0 left-0 transition-all duration-75"
        style={{ width: `${percent}%`, backgroundColor: color, opacity: 0.3 }}
      />
      <div 
        className="absolute inset-y-0 left-0 border-r transition-all duration-75"
        style={{ width: `${percent}%`, borderColor: color, boxShadow: send.level > 0.05 ? `0 0 8px ${color}` : 'none' }}
      />
      <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
        <span className="text-[9px] font-bold text-white/70 uppercase tracking-tight">{label}</span>
        <span className="text-[9px] font-mono tabular-nums text-white/50">{gainToDbText(send.level)}</span>
      </div>
    </div>
  );
};


const TrackHeader: React.FC<TrackHeaderProps> = ({ 
  track, onUpdate, isSelected, onSelect, onDropPlugin, onMovePlugin, onSelectPlugin, onRemovePlugin, onRequestAddPlugin, onContextMenu,
  onDragStartTrack, onDragOverTrack, onDropTrack, isDraggingOver, onSwapInstrument
}) => {
  const [isDragOverFX, setIsDragOverFX] = useState(false);
  // Menu « FX » toujours accessible (les pastilles du bas disparaissent quand la piste est basse)
  const [fxMenu, setFxMenu] = useState(false);
  const fxBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!fxMenu) return;
    const close = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (fxBtnRef.current?.parentElement?.contains(t)) return;
      setFxMenu(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('touchstart', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('touchstart', close); };
  }, [fxMenu]);
  const [isRenaming, setIsRenaming] = useState(false);
  // Double-tap sur le nom = renommer (au doigt, le double-clic n'arrive pas toujours)
  const lastNameTap = useRef(0);
  const [isAdjustingVolume, setIsAdjustingVolume] = useState(false);
  const [showSends, setShowSends] = useState(false);
  const [newName, setNewName] = useState(track.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [sendsTop, setSendsTop] = useState(95);

  useEffect(() => {
    if (controlsRef.current) {
        setSendsTop(controlsRef.current.offsetTop + controlsRef.current.offsetHeight);
    }
  }, []); 

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

  const handleFXClick = (e: React.MouseEvent | React.TouchEvent, p: PluginInstance) => {
    e.stopPropagation();
    if (onSelectPlugin) onSelectPlugin(track.id, p);
  };

  const handleRemoveFX = (e: React.MouseEvent | React.TouchEvent, pId: string) => {
    e.stopPropagation();
    if (onRemovePlugin) onRemovePlugin(track.id, pId);
  };

  const handleFXDragStart = (e: React.DragEvent, pId: string) => {
    e.dataTransfer.setData('pluginId', pId);
    e.dataTransfer.setData('sourceTrackId', track.id);
    e.dataTransfer.dropEffect = 'move';
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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); 
    e.stopPropagation();
    
    const isPlugin = e.dataTransfer.types.includes('application/nova-plugin') || e.dataTransfer.types.includes('pluginid');
    const isTrack = e.dataTransfer.types.includes('trackid');
    const isAudio = e.dataTransfer.types.includes('audio-url') || e.dataTransfer.types.includes('Files');

    if (isPlugin) {
        setIsDragOverFX(true);
        e.dataTransfer.dropEffect = 'copy';
    } else if (isTrack) {
        onDragOverTrack(track.id);
        e.dataTransfer.dropEffect = 'move';
    } else if (isAudio) {
        e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleOnDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverFX(false);

    // Audio Import (Catalog)
    const audioUrl = e.dataTransfer.getData('audio-url');
    if (audioUrl) {
        const audioName = e.dataTransfer.getData('audio-name');
        // Validate track type - only AUDIO, SAMPLER, and BUS tracks can receive audio
        if (track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS) {
            console.warn(`Cannot drop audio on ${track.type} track`);
            return;
        }
        if ((window as any).DAW_CORE) {
            (window as any).DAW_CORE.handleAudioImport(audioUrl, audioName || 'Audio', track.id);
        }
        return;
    }

    // Audio Import (Files)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        // Validate track type - only AUDIO, SAMPLER, and BUS tracks can receive audio
        if (track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS) {
            console.warn(`Cannot drop audio file on ${track.type} track`);
            return;
        }
        if ((window as any).DAW_CORE) {
            (window as any).DAW_CORE.handleAudioImport(file, file.name, track.id);
        }
        return;
    }

    const pluginType = e.dataTransfer.getData('pluginType') as PluginType;
    const pluginName = e.dataTransfer.getData('pluginName');
    const pluginVendor = e.dataTransfer.getData('pluginVendor');

    if (pluginType && onDropPlugin) {
      let metadata: any = pluginName ? { name: pluginName, vendor: pluginVendor } : undefined;
      // VST3 : chemin du plugin sur le PC, nom de classe, id (sinon le pont ne
      // savait pas quoi charger et l'effet restait muet).
      const extra = e.dataTransfer.getData('pluginMetadata');
      if (extra) { try { metadata = { ...(metadata || {}), ...JSON.parse(extra) }; } catch { /* données invalides */ } }
      onDropPlugin(track.id, pluginType, metadata);
      return;
    } 
    
    const pluginId = e.dataTransfer.getData('pluginId');
    const sourceTrackId = e.dataTransfer.getData('sourceTrackId');
    if (pluginId && sourceTrackId && onMovePlugin) {
      onMovePlugin(sourceTrackId, track.id, pluginId);
      return;
    } 
    
    if (e.dataTransfer.getData('trackId')) {
      onDropTrack();
    }
  };

  // Pan : glisser vertical, Maj = fin, molette, double-clic = centre
  const panKnob = useKnobInteraction(track.pan, (v) => onUpdate({ ...track, pan: Math.abs(v) < 0.005 ? 0 : v }), { min: -1, max: 1, sensitivity: 200, defaultValue: 0 });
  // Volume : molette et double-clic = 0 dB (course en racine du gain)
  const volKnob = useKnobInteraction(Math.sqrt(Math.max(0, track.volume) / 1.5), (p) => onUpdate({ ...track, volume: p * p * 1.5 }), { min: 0, max: 1, defaultValue: Math.sqrt(1 / 1.5), wheelStep: 0.005 });

  const handleVolumeInteraction = (clientX: number, rect: DOMRect) => {
      const x = clientX - rect.left;
      const progress = Math.max(0, Math.min(1, x / rect.width));
      onUpdate({ ...track, volume: progress * progress * 1.5 });
  };

  const handleVolumeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (e.detail >= 2) { volKnob.handleDoubleClick(); return; }
    setIsAdjustingVolume(true);
    dragHorizontal(e, Math.sqrt(Math.max(0, track.volume) / 1.5), (p) => onUpdate({ ...track, volume: p * p * 1.5 }), () => setIsAdjustingVolume(false));
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

  const togglePluginBypass = (e: React.MouseEvent | React.TouchEvent, p: PluginInstance) => {
    e.stopPropagation();
    const plugins = track.plugins.map(pl => pl.id === p.id ? { ...pl, isEnabled: !pl.isEnabled } : pl);
    onUpdate({ ...track, plugins });
  };

  const getAbbr = (type: string, name?: string) => {
    if (type === 'VST3') return name ? name.substring(0, 4).toUpperCase() : 'VST3';
    
    const map: Record<string, string> = { 
      'AUTOTUNE': 'TUNE', 'COMPRESSOR': 'COMP', 'STEREOSPREADER': 'MS', 
      'DEESSER': 'DS', 'DENOISER': 'NOISE', 'PROEQ12': 'EQ12', 'VOCALSATURATOR': 'SAT',
      'MELODIC_SAMPLER': 'KEYS', 'DRUM_SAMPLER': 'DRUM'
    };
    return map[type] || type.substring(0, 4);
  };

  const handleMuteToggle = (e: React.MouseEvent | React.TouchEvent) => { e.stopPropagation(); onUpdate({ ...track, isMuted: !track.isMuted }); };
  const handleSoloToggle = (e: React.MouseEvent | React.TouchEvent) => { e.stopPropagation(); onUpdate({ ...track, isSolo: !track.isSolo }); };

  const canHaveSends = (track.type === TrackType.AUDIO || track.type === TrackType.BUS || track.type === TrackType.MIDI || track.type === TrackType.SAMPLER || track.type === TrackType.DRUM_RACK) && track.id !== 'instrumental' && track.id !== 'master';
  const isMidiOrSampler = track.type === TrackType.MIDI || track.type === TrackType.SAMPLER || track.type === TrackType.DRUM_RACK;
  const isAudio = track.type === TrackType.AUDIO;

  const getTrackIcon = () => {
      if (track.type === TrackType.MIDI) return 'fa-music';
      if (track.type === TrackType.SAMPLER) return 'fa-wave-square';
      if (track.type === TrackType.DRUM_RACK) return 'fa-th';
      if (track.type === TrackType.BUS) return 'fa-layer-group';
      if (track.type === TrackType.SEND) return 'fa-magic';
      return 'fa-wave-square';
  };

  const drumRackFakePlugin: PluginInstance | null = track.type === TrackType.DRUM_RACK ? {
      id: 'internal-drum-rack',
      name: 'Drum Rack',
      type: 'DRUM_RACK_UI',
      isEnabled: true,
      params: {},
      latency: 0
  } : null;

  // Batterie Make Music : réglée dans son panneau (bouton Batterie), pas de pastille
  // « Drum Rack 30 » qui débordait sur la piste suivante.
  const instrumentPlugin = isMidiOrSampler && !track.drumMachine
      ? (track.plugins.find(p => p.type === 'MELODIC_SAMPLER' || p.type === 'DRUM_SAMPLER') || drumRackFakePlugin)
      : null;
      
  const insertPlugins = track.plugins.filter(p => p.id !== instrumentPlugin?.id);
  const frozen = isTrackFrozen(track);
  const collabRole = useCollabRole();
  // Mode simple : ni effets ni envois dans l'en-tête (Mix auto s'en charge).
  const { simple } = useSimpleMode();
  const recFrozen = useRecFrozen(track.id);
  // Instrument VST du PC : son rendu suit les notes (pas un gel classique).
  const inst = track.vstInstrument;
  const instStatus = useInstrumentStatus(track.id);
  const freezeStale = !inst && isFreezeStale(track);

  return (
    <div 
      data-nova-target={`track-${track.id}`}
      onClick={onSelect}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, track.id); }}
      onDragOver={handleDragOver}
      onDragLeave={() => { setIsDragOverFX(false); }}
      onDrop={handleOnDrop}
      className={`group border-b border-white/10 p-3 flex flex-col h-full relative transition-all ${isSelected ? 'bg-white/[0.08]' : 'bg-transparent'} ${isDragOverFX ? 'ring-2 ring-cyan-500 bg-cyan-500/10' : ''} ${frozen ? 'bg-cyan-500/[0.03]' : ''}${isDraggingOver ? 'border-t-2 border-t-cyan-500 bg-cyan-500/5' : ''}`}
      style={{ borderLeft: `3px solid ${track.color}`, boxShadow: isSelected ? `inset 6px 0 14px -10px ${track.color}` : undefined }}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center truncate flex-1 pr-2">
          <div 
            draggable 
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('trackId', track.id); onDragStartTrack(track.id); }}
            className="cursor-grab active:cursor-grabbing text-slate-500 hover:text-cyan-500 mr-2 flex-shrink-0 transition-colors p-1 flex items-center space-x-2"
          >
            <i className="fas fa-grip-vertical text-[10px]"></i>
            <i className={`fas ${getTrackIcon()} text-[10px] ${isSelected ? 'text-white' : ''}`}></i>
          </div>

          <div className="min-w-0 flex items-center gap-1.5">
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
                title={track.name}
                onDoubleClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                data-no-longpress
                onTouchEnd={(e) => {
                  const now = Date.now();
                  if (now - lastNameTap.current < 350) { e.preventDefault(); e.stopPropagation(); lastNameTap.current = 0; setIsRenaming(true); }
                  else lastNameTap.current = now;
                }}
                className={`text-[12px] font-bold tracking-wide truncate cursor-text ${isSelected ? 'text-white' : 'text-slate-400'}`}
              >
                {track.name}
                {frozen && !inst && <i className="fas fa-snowflake text-[8px] ml-1 text-cyan-400" role="img"
                  aria-label={track.frozenAuto ? "Piste gelée par l'ingé" : 'Piste gelée'}
                  title={track.frozenAuto ? "Piste gelée par l'ingé (ses effets VST) : tes coupes, fondus et volumes seront rejoués AVANT ses effets quand il rouvrira la session." : 'Piste gelée : lue depuis son rendu'}></i>}
                {inst && <i className="fas fa-plug text-[8px] ml-1 text-fuchsia-300" title={`Instrument VST du PC : ${inst.name}`} aria-label={`Instrument VST : ${inst.name}`}></i>}
                {inst && (instStatus.rendering || instStatus.loading) && <span role="status" className="ml-1 text-[9px] font-normal normal-case text-fuchsia-300"><i className="fas fa-circle-notch fa-spin mr-0.5"></i>rendu…</span>}
                {inst && !instStatus.rendering && instStatus.error && <i className="fas fa-exclamation-triangle text-[8px] ml-1 text-amber-400" title={`Rendu impossible (${instStatus.error}) : le synthé Nova joue les notes.`}></i>}
                {!frozen && recFrozen === 'frozen' && <i className="fas fa-snowflake text-[8px] ml-1 text-sky-300" title="Figée pendant l'enregistrement (effets à latence)" aria-label="Figée pendant l'enregistrement (effets à latence)"></i>}
                {!frozen && recFrozen === 'pending' && <i className="fas fa-snowflake text-[8px] ml-1 text-sky-300/60 animate-pulse" title="Préparation de la prise…" aria-label="Préparation de la prise"></i>}
                {freezeStale && <i className="fas fa-exclamation-triangle text-[8px] ml-1 text-amber-400" title="Les prises ont changé depuis le rendu : il sera refait à la prochaine sauvegarde sur PC (pont VST)."></i>}
              </span>
            )}
            {/* Les pastilles d effets ne tiennent pas quand la piste est basse :
                ce badge indique toujours combien d effets sont actifs. */}
            {!isRenaming && !simple && insertPlugins.length > 0 && (
              <span
                className="shrink-0 px-1 h-4 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-black leading-4"
                title={insertPlugins.map(pl => pl.name).join(" → ")}
              >
                FX {insertPlugins.length}
              </span>
            )}
          </div>
        </div>
        
        {/* Écran tactile en mode PC (iPad paysage) : boutons espacés au pas de 40 px, zones .nova-hit-tactile */}
        <div className="flex nova-hit-gap shrink-0">
          {track.id !== 'master' && !simple && (
            <div className="relative">
              <button
                ref={fxBtnRef}
                type="button"
                data-nova-target={`fx-${track.id}`}
                onClick={(e) => { e.stopPropagation(); setFxMenu(v => !v); }}
                title="Effets de la piste : ouvrir, activer, ajouter"
                aria-label={`Effets de ${track.name}`}
                aria-expanded={fxMenu}
                aria-haspopup="menu"
                className={`nova-hit-tactile relative w-7 h-7 rounded-md flex items-center justify-center transition-all border text-[9px] font-black ${fxMenu ? 'bg-cyan-500 border-cyan-400 text-black' : insertPlugins.length ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
              >
                FX
                {insertPlugins.length > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-cyan-400 text-black text-[8px] leading-[14px] text-center">{insertPlugins.length}</span>}
              </button>
              {fxMenu && (
                <div className="fixed z-[600] w-56 rounded-xl border border-white/10 bg-[#14161c] p-1.5 shadow-2xl" onClick={e => e.stopPropagation()}
                  style={(() => { const r = fxBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 232)) } : {}; })()}>
                  {insertPlugins.length === 0 && <p className="px-2 py-1.5 text-[11px] text-slate-400">Aucun effet sur cette piste.</p>}
                  {insertPlugins.map(p => {
                    const baked = isPluginBaked(track, track.plugins.indexOf(p));
                    return (
                      <div key={p.id} className="flex items-center gap-1 rounded-lg hover:bg-white/5">
                        <button type="button" disabled={baked && p.type !== 'VST3'}
                          onClick={(e) => { setFxMenu(false); handleFXClick(e, p); }}
                          className={`flex-1 min-w-0 truncate px-2 py-1.5 [@media(pointer:coarse)]:py-3 text-left text-[12px] font-semibold ${p.isEnabled ? 'text-white' : 'text-slate-500 line-through'}`}>
                          {p.name || getAbbr(p.type, p.name)}
                        </button>
                        <button type="button" disabled={baked} onClick={(e) => togglePluginBypass(e, p)}
                          title={p.isEnabled ? 'Désactiver' : 'Activer'}
                          aria-label={`${p.isEnabled ? 'Désactiver' : 'Activer'} ${p.name || p.type}`}
                          aria-pressed={p.isEnabled}
                          className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center ${p.isEnabled ? 'text-cyan-400' : 'text-slate-600'}`}>
                          <i className="fas fa-power-off text-[9px]" />
                        </button>
                      </div>
                    );
                  })}
                  {onRequestAddPlugin && (
                    <button type="button"
                      onClick={(e) => { setFxMenu(false); const r = fxBtnRef.current?.getBoundingClientRect(); onRequestAddPlugin(track.id, r ? r.left : e.clientX, r ? r.bottom + 4 : e.clientY); }}
                      className="mt-1 w-full rounded-lg bg-cyan-500/15 px-2 py-1.5 [@media(pointer:coarse)]:py-3 text-left text-[12px] font-bold text-cyan-300 hover:bg-cyan-500/25">
                      <i className="fas fa-plus mr-1.5 text-[10px]" /> Ajouter un effet
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <button
            title={track.isMuted ? "Réactiver le son de cette piste" : "Rendre cette piste muette"}
            aria-label={`Muet : ${track.name}`}
            aria-pressed={!!track.isMuted}
            onClick={handleMuteToggle}
            // Pas de onTouchStart : React l'écoute en passif, preventDefault échouait et le
            // clic qui suit rebasculait (M / S / R / envois sans effet au doigt).
            className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all border ${track.isMuted ? 'bg-red-600 border-red-500 text-white shadow-[0_0_8px_rgba(220,38,38,0.4)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <span className="text-[11px] font-bold">M</span>
          </button>
          <button
            title={track.isSolo ? "Réentendre toutes les pistes" : "N'écouter que cette piste"}
            aria-label={`Solo : ${track.name}`}
            aria-pressed={!!track.isSolo}
            onClick={handleSoloToggle}
            className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all border ${track.isSolo ? 'bg-amber-400 border-amber-300 text-black shadow-[0_0_8px_rgba(251,191,36,0.4)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <span className="text-[11px] font-bold">S</span>
          </button>

          {canHaveSends && !simple && (
            <button
                onClick={(e) => { e.stopPropagation(); setShowSends(!showSends); }}
                title="Envois (delay, réverbes)"
                aria-label={`Envois de ${track.name}`}
                aria-expanded={showSends}
                className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all ${showSends ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-600 hover:text-white'}`}
            >
                <i className="fas fa-sliders-h text-[10px]"></i>
            </button>
          )}

          {/* Bouton micro : sur toutes les pistes voix (pas le beat, pas les bus) */}
          {track.type === TrackType.AUDIO && track.id !== 'instrumental' && !track.instrumentId && (
              <button
                onClick={(e) => { e.stopPropagation(); onUpdate({...track, isTrackArmed: !track.isTrackArmed}) }}
                className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all ${track.isTrackArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/5 text-slate-600 hover:text-white'}`}
                title={track.isTrackArmed ? "Micro actif sur cette piste — appuie sur le bouton rouge REC en haut pour enregistrer" : "Enregistrer sur cette piste (sinon REC choisit la piste sélectionnée)"}
                aria-label={`Armer l'enregistrement : ${track.name}`}
                aria-pressed={!!track.isTrackArmed}
              >
                <span className="text-[11px] font-bold">R</span>
              </button>
          )}
        </div>
      </div>
      
      {/* Autotune du PC : « Auto-Tune Pro · F# mineur » (ou l'autotune de NOVA en repli). */}
      <AutotuneBadge track={track} />
      {track.isTrackArmed && <div className="mt-1 relative z-10"><MonitorControl compact trackId={track.id} /></div>}

      <div ref={controlsRef} className="flex items-center space-x-3 mt-1 bg-black/20 p-2 rounded-lg border border-white/5 relative z-10">
        <div
          {...panKnob.bind}
          title={`Panoramique ${panToText(track.pan)} : glisser (Maj = fin), molette, double-clic = centre`}
          role="slider"
          aria-label={`Panoramique ${track.name}`}
          aria-valuetext={panToText(track.pan)}
          className="nova-hit-tactile relative w-7 h-7 rounded-full bg-black border border-white/10 flex items-center justify-center cursor-ns-resize shadow-lg hover:border-cyan-500/30 transition-all touch-none group/pan"
        >
          <div className="w-0.5 h-3 bg-cyan-400 rounded-full" style={{ transform: `rotate(${track.pan * 140}deg) translateY(-1px)` }} />
        </div>
        
        <div className="flex-1 flex items-center gap-1 h-6 relative">
          {/* Verrou de volume (collaboration) : « c'est ce volume-là que veut l'artiste ». */}
          {(track.volumeLock || collabRole === 'artist') && (
            <button type="button"
              onClick={(e) => { e.stopPropagation(); requestVolumeLock(track.id); }}
              title={track.volumeLock
                ? `Volume verrouillé par l'artiste (${gainToDbText(track.volumeLock.volume)})${collabRole === 'artist' ? ' : clic pour déverrouiller' : collabRole ? ' : clic pour le déverrouiller quand même' : ''}`
                : "Verrouiller ce volume : l'ingé son verra que c'est le volume que tu veux"}
              aria-pressed={!!track.volumeLock}
              aria-label={track.volumeLock ? 'Volume verrouillé' : 'Verrouiller le volume'}
              className={`nova-hit shrink-0 w-5 h-5 rounded flex items-center justify-center text-[9px] ${track.volumeLock ? 'bg-amber-500/25 text-amber-300' : 'text-slate-500 hover:text-white'}`}>
              <i className={`fas ${track.volumeLock ? 'fa-lock' : 'fa-lock-open'}`} />
            </button>
          )}
          <div className="flex-1 flex flex-col justify-center h-6 relative">
          <div
            ref={volKnob.wheelRef}
            onMouseDown={handleVolumeMouseDown}
            onTouchStart={handleVolumeTouchStart}
            onTouchMove={handleVolumeTouchMove}
            onTouchEnd={handleVolumeTouchEnd}
            data-nova-target={`vol-${track.id}`}
            title="Volume : glisser (Maj = fin), molette, double-clic = 0 dB"
            role="slider"
            aria-label={`Volume ${track.name}`}
            aria-valuetext={gainToDbText(track.volume)}
            className={`nova-hit-tactile h-3 relative cursor-ew-resize group/vol touch-none ${track.volumeLock && collabRole && collabRole !== 'artist' ? 'pointer-events-none opacity-60' : ''}`}
          >
            {/* Cadre arrondi à part : son overflow-hidden coupait la zone tactile (.nova-hit-tactile) */}
            <div className="h-full bg-black/60 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${isAdjustingVolume ? 'brightness-150' : 'brightness-100'}`}
                style={{
                  width: `${(Math.sqrt(track.volume / 1.5)) * 100}%`,
                  backgroundColor: track.color,
                  boxShadow: isAdjustingVolume ? `0 0 10px ${track.color}` : 'none'
                }}
              />
            </div>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-mono tabular-nums text-white/70 [text-shadow:0_1px_2px_rgba(0,0,0,0.95)] pointer-events-none group-hover/vol:text-white transition-colors">
              {gainToDbText(track.volume)}
            </span>
          </div>
          </div>
        </div>
      </div>
      
      {canHaveSends && showSends && !simple && (
        <div 
          className="absolute left-3 right-3 mt-1 p-2 bg-[#08090b] rounded-lg border border-cyan-500/30 shadow-2xl space-y-1 animate-in fade-in duration-150 z-20"
          style={{ top: `${sendsTop}px` }}
        >
            <HorizontalSendFader trackId={track.id} label="Delay 1/4" color="#00f2ff" send={track.sends.find(s => s.id === 'send-delay') || { id: 'send-delay', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-delay', lvl)} />
            <HorizontalSendFader trackId={track.id} label="Verb Pro" color="#10b981" send={track.sends.find(s => s.id === 'send-verb-short') || { id: 'send-verb-short', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-verb-short', lvl)} />
            <HorizontalSendFader trackId={track.id} label="Hall Space" color="#a855f7" send={track.sends.find(s => s.id === 'send-verb-long') || { id: 'send-verb-long', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-verb-long', lvl)} />
        </div>
      )}
      
      {instrumentPlugin && (
          <div className="mt-2 relative group/inst min-h-0 overflow-hidden">
              <div className="flex w-full overflow-hidden rounded-md border border-cyan-500/30 bg-cyan-500/5 shadow-[0_0_10px_rgba(0,242,255,0.05)]">
                  <div className="w-8 flex items-center justify-center bg-cyan-500/10 border-r border-cyan-500/20 pointer-events-none">
                      <i className={`fas ${instrumentPlugin.type === 'DRUM_RACK_UI' || instrumentPlugin.type === 'DRUM_SAMPLER' ? 'fa-drum' : 'fa-music'} text-[10px] text-cyan-400`}></i>
                  </div>
                  <div className="flex-1 h-8 relative border-r border-cyan-500/20 hover:bg-white/5 transition-colors">
                      <div className="absolute inset-0 flex flex-col justify-center px-2 pointer-events-none">
                          <span className="text-[9px] font-black uppercase text-cyan-100 truncate">
                              {instrumentPlugin.type === 'DRUM_RACK_UI' ? 'Drum Rack 30' : (instrumentPlugin.type === 'DRUM_SAMPLER' ? 'Single Drum' : 'Melodic Sampler')}
                          </span>
                          <span className="text-[7px] text-slate-500 font-mono">Instrument</span>
                      </div>
                  </div>
                  <button
                      onClick={(e) => handleFXClick(e, instrumentPlugin)}
                      className="w-8 flex items-center justify-center bg-black/20 hover:bg-cyan-500/20 text-slate-500 hover:text-cyan-400 transition-colors"
                      title="Ouvrir l'éditeur"
                      aria-label="Ouvrir l'éditeur de l'instrument"
                  >
                      <i className="fas fa-sliders-h text-[9px]"></i>
                  </button>
              </div>
          </div>
      )}

      {/* Une seule ligne, défilante : avec un style de mix (5-6 effets) la grille
          passait sur deux lignes et débordait sur la piste suivante. */}
      {/* Piste armée : la ligne vumètre / retour prend la place des pastilles (le bouton FX reste). */}
      {!track.isTrackArmed && !simple && <div className="mt-2 flex gap-1 overflow-x-auto overflow-y-hidden no-scrollbar min-h-0">
        {insertPlugins.map(p => {
          // Effet compris dans le rendu gelé : lecture seule. Un VST3 reste
          // ouvrable (son panneau explique « Rendu (VST du PC) » / Dégeler).
          const baked = isPluginBaked(track, track.plugins.indexOf(p));
          const bakedVst = baked && p.type === 'VST3';
          return (
          <div
            key={p.id}
            draggable={!baked}
            onDragStart={(e) => { if (baked) return; e.stopPropagation(); handleFXDragStart(e, p.id); }}
            title={bakedVst ? "Rendu (VST du PC) : déjà inclus dans l'audio de la piste. Pour le régler, ouvre le projet sur ton PC avec le pont VST." : baked ? 'Inclus dans le rendu gelé de la piste' : undefined}
            data-fx-baked={baked ? '1' : undefined}
            className={`relative group/fxitem flex flex-col items-center fx-slot shrink-0 basis-[calc(25%-3px)] ${baked ? (bakedVst ? 'opacity-70' : 'pointer-events-none opacity-40') : ''}`}
          >
            <div className="flex w-full overflow-hidden rounded-md border border-white/5 bg-black/40">
              <button 
                onClick={(e) => handleFXClick(e, p)}
                className={`flex-1 h-7 text-[9px] font-bold uppercase truncate px-1 text-center flex items-center justify-center transition-all ${p.isEnabled ? 'text-cyan-300' : 'text-slate-600 bg-black/20'}`}
              >
                {getAbbr(p.type, p.name)}
              </button>
              <button
                disabled={baked}
                onClick={(e) => togglePluginBypass(e, p)}
                title={p.isEnabled ? 'Désactiver l\'effet' : 'Activer l\'effet'}
                aria-label={`${p.isEnabled ? 'Désactiver' : 'Activer'} ${p.name || p.type}`}
                aria-pressed={p.isEnabled}
                className={`w-4 h-6 flex items-center justify-center transition-all ${p.isEnabled ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/40' : 'bg-white/5 text-slate-800'}`}
              >
                <i className="fas fa-power-off text-[6px]"></i>
              </button>
            </div>
            {!baked && <button onClick={(e) => handleRemoveFX(e, p.id)} className="delete-fx" title="Retirer l'effet" aria-label={`Retirer ${p.name || p.type}`}><i className="fas fa-times"></i></button>}
          </div>
          );
        })}
      </div>}
    </div>
  );
};
export default TrackHeader;
