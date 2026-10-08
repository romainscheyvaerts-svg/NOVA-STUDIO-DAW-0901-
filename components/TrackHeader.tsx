
import React, { useState, useRef, useEffect } from 'react';
import { openSessionPanel } from '../utils/r21Bus';
import TrackMeter from './meters/TrackMeter';
import { AutotuneBadge } from './AutotuneVstPanel';
import { useCollabRole, requestVolumeLock, useCollabLive } from '../utils/collabStore';
import { requestRemoteSend, useRemoteBadge } from '../utils/remoteStore';
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
import { isPluginBaked, isFreezeStale, isTrackFrozen, freezeDrift } from '../utils/freeze';
import { useFreezeRefreshBusy } from '../hooks/useFrozenRefresh';
import { useRecFrozen } from '../utils/recFreezeStore';
import { useInstrumentStatus } from '../utils/instrumentStore';
import { openSynthPanel } from '../utils/synthPanelStore';
import { openSamplerPanel } from '../utils/samplerPanelStore';
import { isMidiRecordTrack } from '../utils/midiRecord';
import MonitorControl from './MonitorControl';
import InputSelect from './InputSelect';
import { noteArmClick } from '../utils/multiRecord';
import { PluginName } from './PluginName';
import TrackInsertStrip from './TrackInsertStrip';
import { TrackStructureBadge, TrackStructureInline } from './TrackStructure';
import AutomationModeSelector from './AutomationModeSelector';
import { automationRecorder } from '../services/AutomationManager';
import { useLiveParam } from '../utils/automationLiveStore';
import { SEND_LABELS } from '../utils/sendLabels';

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
  // Pendant la lecture, l'envoi suit son automation (comme la console Pro Tools).
  const shown = useLiveParam(trackId, `send::${send.id}`, send.level);
  const handleInteraction = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left;
    const progress = Math.max(0, Math.min(1, x / rect.width));
    onChange(progress * 1.5);
  };
  // Molette / double-clic (0 dB) partagés avec les autres potards
  const knob = useKnobInteraction(shown / 1.5, (p) => onChange(p * 1.5), { min: 0, max: 1, defaultValue: 1 / 1.5, wheelStep: 0.01 });

  const param = `send::${send.id}`;
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (e.detail >= 2) { knob.handleDoubleClick(); return; }
    // Automation (Touch / Latch…) : l'appui et le relâchement bornent l'écriture.
    automationRecorder.touch(trackId, param);
    dragHorizontal(e, shown / 1.5, (p) => onChange(p * 1.5), () => automationRecorder.release(trackId, param));
  };
  
  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    automationRecorder.touch(trackId, param);
    const rect = e.currentTarget.getBoundingClientRect();
    handleInteraction(e.touches[0].clientX, rect);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    handleInteraction(e.touches[0].clientX, rect);
  };

  const percent = (shown / 1.5) * 100;

  return (
    <div
      ref={knob.wheelRef}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => automationRecorder.release(trackId, param)}
      role="slider"
      aria-label={`Envoi ${label}`}
      aria-valuetext={gainToDbText(shown)}
      title={`Envoi ${label} : glisser (Maj = fin), molette, double-clic = 0 dB`}
      className="relative h-5 bg-black/60 rounded-md overflow-hidden border border-white/5 cursor-ew-resize group/fader transition-all hover:border-white/20 touch-none"
    >
      <div 
        className="absolute inset-y-0 left-0 transition-all duration-75"
        style={{ width: `${percent}%`, backgroundColor: color, opacity: 0.3 }}
      />
      <div 
        className="absolute inset-y-0 left-0 border-r transition-all duration-75"
        style={{ width: `${percent}%`, borderColor: color, boxShadow: shown > 0.05 ? `0 0 8px ${color}` : 'none' }}
      />
      <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
        <span className="text-[9px] font-bold text-white/70 uppercase tracking-tight">{label}</span>
        <span className="text-[9px] font-mono tabular-nums text-white/50">{gainToDbText(shown)}</span>
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

  // Pendant la lecture, volume et pan suivent leur automation (comme Pro Tools en Read / Touch).
  const shownVolume = useLiveParam(track.id, 'volume', track.volume);
  const shownPan = useLiveParam(track.id, 'pan', track.pan);
  // Pan : glisser vertical, Maj = fin, molette, double-clic = centre
  const panKnob = useKnobInteraction(shownPan, (v) => onUpdate({ ...track, pan: Math.abs(v) < 0.005 ? 0 : v }), {
    min: -1, max: 1, sensitivity: 200, defaultValue: 0,
    onStart: () => automationRecorder.touch(track.id, 'pan'), onEnd: () => automationRecorder.release(track.id, 'pan'),
  });
  // Volume : molette et double-clic = 0 dB (course en racine du gain)
  const volKnob = useKnobInteraction(Math.sqrt(Math.max(0, shownVolume) / 1.5), (p) => onUpdate({ ...track, volume: p * p * 1.5 }), { min: 0, max: 1, defaultValue: Math.sqrt(1 / 1.5), wheelStep: 0.005 });

  const handleVolumeInteraction = (clientX: number, rect: DOMRect) => {
      const x = clientX - rect.left;
      const progress = Math.max(0, Math.min(1, x / rect.width));
      onUpdate({ ...track, volume: progress * progress * 1.5 });
  };

  const handleVolumeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (e.detail >= 2) { volKnob.handleDoubleClick(); return; }
    setIsAdjustingVolume(true);
    automationRecorder.touch(track.id, 'volume');
    dragHorizontal(e, Math.sqrt(Math.max(0, shownVolume) / 1.5), (p) => onUpdate({ ...track, volume: p * p * 1.5 }), () => { setIsAdjustingVolume(false); automationRecorder.release(track.id, 'volume'); });
  };

  const handleVolumeTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    setIsAdjustingVolume(true);
    automationRecorder.touch(track.id, 'volume');
    const rect = e.currentTarget.getBoundingClientRect();
    handleVolumeInteraction(e.touches[0].clientX, rect);
  };

  const handleVolumeTouchMove = (e: React.TouchEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    handleVolumeInteraction(e.touches[0].clientX, rect);
  };

  const handleVolumeTouchEnd = () => { setIsAdjustingVolume(false); automationRecorder.release(track.id, 'volume'); };

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
  // « Feat à distance » : à qui est la piste, et qui enregistre dessus en ce moment.
  const collabLive = useCollabLive();
  const recBy = collabRole ? collabLive.recs[track.id] : undefined;
  const ownerName = collabRole && track.collabOwnerKey ? (track.collabOwnerKey === collabLive.meKey ? 'à toi' : track.collabOwnerName || '') : '';
  const remote = useRemoteBadge(track.id);
  // Mode simple : ni effets ni envois dans l'en-tête (Mix auto s'en charge).
  const { simple } = useSimpleMode();
  const recFrozen = useRecFrozen(track.id);
  // Instrument VST du PC : son rendu suit les notes (pas un gel classique).
  const inst = track.vstInstrument;
  const instStatus = useInstrumentStatus(track.id);
  const freezeStale = !inst && isFreezeStale(track);
  // Rendu gelé périmé : un clip a changé depuis le gel (hooks/useFrozenRefresh le refait dès que possible).
  const freezeDriftNow = frozen && !inst ? freezeDrift(track) : null;
  const refreezing = useFreezeRefreshBusy(track.id);
  const outdatedPill = freezeDriftNow ? (
    <span data-testid={`freeze-outdated-${track.id}`} role="status"
      title={refreezing ? 'Nouveau rendu de la piste gelée en cours…'
        : freezeDriftNow.content.length
          ? 'Gel à refaire : le son d’un clip a changé, le rendu gelé joue encore l’ancien. Il sera refait tout seul dès que possible (pont VST connecté) ; sinon dégèle la piste pour l’entendre.'
          : 'Gel à refaire : des clips ont changé depuis le gel (gain, fondus, découpes, nouvelle prise). Tu les entends déjà à peu près ; le rendu exact sera refait dès que possible (pont VST connecté) ou au dégel.'}
      className={`shrink-0 inline-flex items-center whitespace-nowrap h-4 rounded px-1 text-[9px] font-black leading-4 ${freezeDriftNow.content.length ? 'bg-amber-500/20 text-amber-300' : 'bg-cyan-500/10 text-cyan-300/80'}`}>
      {refreezing ? <><i className="fas fa-circle-notch fa-spin mr-0.5 text-[7px]" aria-hidden></i>regel…</> : 'gel à refaire'}
    </span>
  ) : null;
  // Piste armée : ligne d'entrée complète (⚙) au lieu des effets.
  const [showInputRow, setShowInputRow] = useState(false);
  // Ligne des effets affichée (l'indicateur « gel à refaire » s'y range, sinon à côté du nom).
  const insertStripShown = !(track.isTrackArmed && showInputRow) && !(canHaveSends && showSends && !simple) && (insertPlugins.length > 0 || track.isTrackArmed);

  return (
    <div 
      data-nova-target={`track-${track.id}`}
      data-track-header={track.id}
      data-track-name={track.name}
      data-armed={track.isTrackArmed ? '1' : '0'}
      data-selected={isSelected ? '1' : '0'}
      data-clips={track.clips.length}
      onClick={onSelect}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, track.id); }}
      onDragOver={handleDragOver}
      onDragLeave={() => { setIsDragOverFX(false); }}
      onDrop={handleOnDrop}
      className={`group border-b border-white/[0.06] px-3 py-2 flex flex-col h-full relative transition-all ${isSelected ? 'bg-white/[0.08]' : 'bg-transparent'} ${isDragOverFX ? 'ring-2 ring-cyan-500 bg-cyan-500/10' : ''} ${frozen ? 'bg-cyan-500/[0.03]' : ''}${isDraggingOver ? 'border-t-2 border-t-cyan-500 bg-cyan-500/5' : ''}`}
      style={{ borderLeft: `3px solid ${track.color}`, boxShadow: isSelected ? `inset 6px 0 14px -10px ${track.color}` : undefined, scrollMarginTop: 44, scrollMarginBottom: 8 }}
    >
      <TrackStructureBadge track={track} />
      {/* Vrai mètre G / D de la piste + réduction de gain (R11), au bord droit comme dans Pro Tools. */}
      <div className="absolute right-0.5 top-1.5 bottom-1.5 w-[9px] z-20" data-testid={`header-meter-${track.id}`}>
        <TrackMeter pointId={track.id} grTrackId={track.id} grText={false} marks={false} label={track.name} className="w-full" />
      </div>
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center truncate flex-1 pr-2">
          <div 
            draggable 
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('trackId', track.id); onDragStartTrack(track.id); }}
            className="cursor-grab active:cursor-grabbing text-slate-500 hover:text-cyan-500 mr-2 flex-shrink-0 transition-colors p-1 flex items-center space-x-2"
          >
            <i className="fas fa-grip-vertical text-[10px]"></i>
            <span className="relative"><i className={`fas ${getTrackIcon()} text-[10px] ${isSelected ? 'text-white' : ''}`}></i>
            {/* Ingé à distance : où en est la piste (« Chez l'ingé… », « Mise à jour reçue ») ; sans prendre la place du nom. */}
            {remote.badge?.label && (
              <span data-testid={`remote-badge-${track.id}`} role="img" aria-label={`Ingé à distance : ${remote.badge.label}`} title={`Ingé à distance : ${remote.badge.label}`}
                className={`absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full flex items-center justify-center text-[7px] ring-1 ring-black/60 ${remote.badge.tone === 'ok' ? 'bg-emerald-500 text-black' : remote.badge.tone === 'warn' ? 'bg-amber-400 text-black' : remote.badge.tone === 'busy' ? 'bg-sky-400 text-black animate-pulse' : 'bg-slate-500 text-white'}`}>
                <i className="fas fa-headphones"></i>
              </span>
            )}
            </span>
          </div>

          <div className="min-w-0 overflow-hidden flex items-center gap-1.5">
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
                className={`min-w-[3.5rem] text-[12px] font-bold tracking-wide truncate cursor-text ${isSelected ? 'text-white' : 'text-slate-400'}`}
              >
                {track.name}
                {track.comment && (
                  <button type="button" data-testid={`header-comment-${track.id}`} aria-label={`Commentaire : ${track.comment}`}
                    title={`💬 ${track.comment} — Pro Tools : Comments (clic : notes de la session)`}
                    onClick={e => { e.stopPropagation(); openSessionPanel('notes'); }}
                    className="ml-1 align-middle text-[9px] text-amber-300 hover:text-amber-200"><i className="fas fa-comment-alt" /></button>
                )}
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
            {!isRenaming && <TrackStructureInline track={track} />}
            {/* Piste guide (R3) : pastille ; clic = couper / rallumer CE guide (jamais exporté). */}
            {!isRenaming && track.isGuide && (
              <button type="button" data-testid={`guide-pill-${track.id}`} aria-pressed={!track.guideMuted}
                onClick={(e) => { e.stopPropagation(); onUpdate({ ...track, guideMuted: !track.guideMuted }); }}
                title={`Piste guide : ${track.guideMuted ? 'coupée' : `entendue à ${Math.round((track.guideLevel ?? 0.7) * 100)} %`}. Jamais exportée, mixée ni masterisée. Clic : couper / rallumer.`}
                className={`shrink-0 h-5 px-1.5 rounded text-[9px] font-black border ${track.guideMuted ? 'text-slate-500 border-white/10 line-through' : 'text-amber-300 border-amber-500/50 bg-amber-500/15'}`}>
                GUIDE
              </button>
            )}
            {!isRenaming && !insertStripShown && outdatedPill}
            {/* Feat à distance : propriétaire (son nom, sa couleur) et pastille REC quand il enregistre (piste verrouillée). */}
            {!isRenaming && recBy && (
              <span data-testid={`collab-rec-${track.id}`} role="status" title={`${recBy} enregistre sur cette piste : elle est verrouillée pour les autres`}
                className="shrink-0 inline-flex items-center gap-1 h-4 rounded bg-red-600 px-1 text-[9px] font-black uppercase text-white animate-pulse">
                <i className="fas fa-lock text-[7px]" aria-hidden></i>REC {recBy}
              </span>
            )}
            {!isRenaming && !recBy && ownerName && (
              <span data-testid={`collab-owner-${track.id}`} title={ownerName === 'à toi' ? 'Ta piste : les autres l’entendent, personne ne peut l’écraser' : `Piste de ${ownerName} : seul(e) ${ownerName} peut y enregistrer`}
                className="shrink-0 max-w-[5.5rem] truncate h-4 rounded px-1 text-[9px] font-black leading-4"
                style={{ color: track.collabOwnerColor || '#e2e8f0', backgroundColor: `${track.collabOwnerColor || '#94a3b8'}26` }}>
                {ownerName}
              </span>
            )}
            {/* Synthé NOVA (V24) : pastille de l'instrument de la piste MIDI, ouvre son écran
                (dans la ligne du nom : visible quelle que soit la hauteur de la piste ; le nom
                du son est dans l'infobulle et en tête de l'écran du synthé). */}
            {!isRenaming && track.type === TrackType.MIDI && !track.bass808 && !track.vstInstrument && !track.drumMachine && !instrumentPlugin && (
              <button type="button" data-testid={`synth-pill-${track.id}`}
                onClick={(e) => { e.stopPropagation(); if (track.melodicSampler) openSamplerPanel(track.id); else openSynthPanel(track.id); }}
                title={track.melodicSampler ? `Sampler : ${track.melodicSampler.sampleName || 'vide'} (ouvrir le son et les réglages)` : `Synthé NOVA : ${track.novaSynth?.name || 'synthé simple'} (ouvrir les sons et réglages)`}
                aria-label={track.melodicSampler ? `Ouvrir le sampler de ${track.name}` : `Ouvrir le synthé de ${track.name}`}
                className="nova-hit-tactile shrink-0 w-6 h-6 rounded-md border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 flex items-center justify-center">
                <i className="fas fa-sliders-h text-[9px]"></i>
              </button>
            )}
            {/* Ingé à distance : où en est la piste (« Chez l'ingé… », « Mise à jour reçue »), et l'envoyer. */}
            {!isRenaming && remote.role === 'artist' && remote.badge?.canSend && (
              <button type="button" onClick={(e) => { e.stopPropagation(); requestRemoteSend(track.id); }}
                title="Envoyer cette piste à l'ingé (audio brut + tes éditions)" aria-label={`Envoyer ${track.name} à l'ingé`}
                className="shrink-0 w-5 h-5 rounded bg-cyan-500/20 text-cyan-200 text-[9px] hover:bg-cyan-500/30">
                <i className="fas fa-paper-plane"></i>
              </button>
            )}
            {/* G13 : le compte d'effets est sur le bouton FX ; l'ancien badge « FX 8 » en double mangeait le nom. */}
          </div>
        </div>
        
        {/* Écran tactile en mode PC (iPad paysage) : boutons espacés au pas de 40 px, zones .nova-hit-tactile */}
        <div className="flex nova-hit-gap shrink-0">
          {track.id !== 'master' && (!simple || insertPlugins.length > 0) && (
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
                className={`nova-hit-tactile relative w-7 h-7 rounded-md flex items-center justify-center transition-all border text-[9px] font-black ${fxMenu ? 'bg-cyan-500 border-cyan-400 text-black' : insertPlugins.length ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25' : 'bg-white/[0.06] border-transparent text-slate-400 hover:text-white'}`}
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
                          <PluginName plugin={p} showDetail className="max-w-full" />
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
            className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all border ${track.isMuted ? 'bg-red-600 border-red-500 text-white shadow-[0_0_8px_rgba(220,38,38,0.4)]' : 'bg-white/[0.06] border-transparent text-slate-400 hover:text-white'}`}
          >
            <span className="text-[11px] font-bold">M</span>
          </button>
          <button
            title={track.isSolo ? "Réentendre toutes les pistes" : "N'écouter que cette piste"}
            aria-label={`Solo : ${track.name}`}
            aria-pressed={!!track.isSolo}
            onClick={handleSoloToggle}
            className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all border ${track.isSolo ? 'bg-amber-400 border-amber-300 text-black shadow-[0_0_8px_rgba(251,191,36,0.4)]' : 'bg-white/[0.06] border-transparent text-slate-400 hover:text-white'}`}
          >
            <span className="text-[11px] font-bold">S</span>
          </button>

          {canHaveSends && !simple && (
            <button
                onClick={(e) => { e.stopPropagation(); setShowSends(!showSends); }}
                title="Envois : écho et reverbs"
                aria-label={`Envois de ${track.name}`}
                aria-expanded={showSends}
                className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all ${showSends ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-slate-400 hover:text-white'}`}
            >
                <i className="fas fa-sliders-h text-[10px]"></i>
            </button>
          )}

          {/* Bouton micro : sur toutes les pistes voix (pas le beat, pas les bus) */}
          {track.type === TrackType.AUDIO && track.id !== 'instrumental' && !track.instrumentId && (
              <button
                onClick={(e) => { e.stopPropagation(); noteArmClick(e); onUpdate({...track, isTrackArmed: !track.isTrackArmed}) }}
                className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all ${track.isTrackArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/[0.06] text-slate-400 hover:text-white'} ${!track.isTrackArmed && (recBy || (ownerName && ownerName !== 'à toi')) ? 'opacity-40' : ''}`}
                title={recBy ? `${recBy} enregistre sur cette piste : verrouillée` : ownerName && ownerName !== 'à toi' ? `Piste de ${ownerName} : enregistre sur ta propre piste` : track.isTrackArmed ? "Micro actif sur cette piste — appuie sur le bouton rouge REC en haut pour enregistrer (toutes les pistes armées enregistrent ensemble)" : "Armer : cette piste enregistre aussi (plusieurs pistes armées = plusieurs micros). Maj+clic : armer celle-ci seule"}
                aria-label={`Armer l'enregistrement : ${track.name}`}
                aria-pressed={!!track.isTrackArmed}
              >
                <span className="text-[11px] font-bold">R</span>
              </button>
          )}

          {/* Armement MIDI (R16) : synthé, 808, batterie, sampler, instrument VST */}
          {isMidiRecordTrack(track) && (
              <button
                data-nova-arm-midi={track.id}
                onClick={(e) => { e.stopPropagation(); onUpdate({...track, isTrackArmed: !track.isTrackArmed}) }}
                className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center transition-all ${track.isTrackArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/[0.06] text-slate-400 hover:text-white'} ${!track.isTrackArmed && (recBy || (ownerName && ownerName !== 'à toi')) ? 'opacity-40' : ''}`}
                title={recBy ? `${recBy} enregistre sur cette piste : verrouillée` : track.isTrackArmed ? "Piste armée : ton clavier MIDI (ou celui de l'ordinateur, Ctrl+Maj+K) joue dessus. REC enregistre ce que tu joues." : "Armer la piste : ton clavier MIDI joue et enregistre dessus (comme le bouton d'armement de Pro Tools, l'armement d'enregistrement de Live, le Record de FL)"}
                aria-label={`Armer l'enregistrement MIDI : ${track.name}`}
                aria-pressed={!!track.isTrackArmed}
              >
                <i className="fas fa-circle text-[8px]"></i>
              </button>
          )}
        </div>
      </div>
      
      {/* Autotune du PC : « Auto-Tune Pro · F# mineur » (ou l'autotune de NOVA en repli). */}
      {/* Piste armée : la ligne des effets laisse place au retour casque ; l'autotune reste visible ici. */}
      {track.isTrackArmed && showInputRow && <AutotuneBadge track={track} onOpen={(e) => { const at = track.plugins.find(x => x.type === 'AUTOTUNE'); if (at) handleFXClick(e, at); }} />}
      {/* Piste armée : réglages d'entrée complets sur demande (⚙), sinon ses effets restent visibles. */}
      {track.isTrackArmed && showInputRow && (
        <div className="mt-1 relative z-10 flex items-center gap-1">
          <div className="shrink-0 max-w-[72px]"><InputSelect track={track} compact /></div>
          <div className="min-w-0 flex-1"><MonitorControl compact trackId={track.id} /></div>
          <button type="button" onClick={(e) => { e.stopPropagation(); setShowInputRow(false); }}
            title="Revenir aux effets de la piste" aria-label="Revenir aux effets de la piste"
            className="shrink-0 h-5 rounded bg-cyan-500/20 px-1.5 text-[10px] font-bold text-cyan-200">FX</button>
        </div>
      )}

      <div ref={controlsRef} className={`${canHaveSends && showSends && !simple ? 'hidden' : 'flex'} items-center space-x-2 mt-1 bg-white/[0.03] p-1.5 rounded-lg relative z-10`}>
        {/* Mode d'automation (Read vert, Touch/Latch jaune, Write rouge) — masqué en mode simple. */}
        {!simple && track.id !== 'master' && <AutomationModeSelector track={track} onUpdate={onUpdate} />}
        <div
          {...panKnob.bind}
          title={`Panoramique ${panToText(shownPan)} : glisser (Maj = fin), molette, double-clic = centre`}
          role="slider"
          aria-label={`Panoramique ${track.name}`}
          aria-valuetext={panToText(shownPan)}
          className="nova-hit-tactile relative w-7 h-7 rounded-full bg-nv-raised border border-white/10 flex items-center justify-center cursor-ns-resize shadow-sm hover:border-cyan-500/30 transition-all touch-none group/pan"
        >
          <div className="w-0.5 h-3 bg-cyan-400 rounded-full" style={{ transform: `rotate(${shownPan * 140}deg) translateY(-1px)` }} />
        </div>
        {/* Valeur du panoramique lisible (F2) : « C », « G 30 », « D 30 ». */}
        <span className="w-7 shrink-0 text-[9px] font-mono tabular-nums text-slate-400 pointer-events-none" aria-hidden="true">{panToText(track.pan)}</span>
        
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
            aria-valuetext={gainToDbText(shownVolume)}
            className={`nova-hit-tactile h-3 relative cursor-ew-resize group/vol touch-none ${track.volumeLock && collabRole && collabRole !== 'artist' ? 'pointer-events-none opacity-60' : ''}`}
          >
            {/* Cadre arrondi à part : son overflow-hidden coupait la zone tactile (.nova-hit-tactile) */}
            <div className="h-full bg-black/60 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${isAdjustingVolume ? 'brightness-150' : 'brightness-100'}`}
                style={{
                  width: `${(Math.sqrt(shownVolume / 1.5)) * 100}%`,
                  backgroundColor: track.color,
                  boxShadow: isAdjustingVolume ? `0 0 10px ${track.color}` : 'none'
                }}
              />
            </div>
          </div>
          </div>
          {/* Valeur à droite, hors de la barre colorée (F2) : lisible à tout volume. */}
          <span className="w-12 shrink-0 text-right text-[9px] font-mono tabular-nums text-slate-300 pointer-events-none">{gainToDbText(shownVolume)}</span>
        </div>
      </div>
      
      {canHaveSends && showSends && !simple && (
        // G24 : les envois prennent la place de la ligne volume / effets DANS la piste
        // (avant, le panneau flottait par-dessus la piste suivante et cachait son volume).
        <div data-testid={`sends-panel-${track.id}`}
          className="relative mt-1 p-1 bg-[#08090b] rounded-lg border border-cyan-500/30 space-y-0.5 animate-in fade-in duration-150 z-10"
        >
            <HorizontalSendFader trackId={track.id} label={SEND_LABELS['send-delay'].label} color={SEND_LABELS['send-delay'].color} send={track.sends.find(s => s.id === 'send-delay') || { id: 'send-delay', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-delay', lvl)} />
            <HorizontalSendFader trackId={track.id} label={SEND_LABELS['send-verb-short'].label} color={SEND_LABELS['send-verb-short'].color} send={track.sends.find(s => s.id === 'send-verb-short') || { id: 'send-verb-short', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-verb-short', lvl)} />
            <HorizontalSendFader trackId={track.id} label={SEND_LABELS['send-verb-long'].label} color={SEND_LABELS['send-verb-long'].color} send={track.sends.find(s => s.id === 'send-verb-long') || { id: 'send-verb-long', level: 0, isEnabled: true }} onChange={(lvl) => handleSendChange('send-verb-long', lvl)} />
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
                              {instrumentPlugin.type === 'DRUM_RACK_UI' ? 'Batterie 30 pads' : (instrumentPlugin.type === 'DRUM_SAMPLER' ? 'Échantillon de batterie' : 'Échantillonneur mélodique')}
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
      {/* Les effets restent visibles même en mode simple : on doit toujours voir ce qui traite la voix. */}
      {insertStripShown && (
        <TrackInsertStrip
          leading={track.isTrackArmed ? <span className="flex shrink-0 items-center gap-1"><span className="max-w-[46px]"><InputSelect track={track} compact /></span><MonitorControl mini trackId={track.id} onExpand={() => setShowInputRow(true)} /></span> : outdatedPill || undefined}
          trackId={track.id}
          plugins={insertPlugins}
          isBaked={(p) => isPluginBaked(track, track.plugins.indexOf(p))}
          onOpen={(e, p) => handleFXClick(e, p)}
          onToggle={(e, p) => togglePluginBypass(e, p)}
          onRemove={(e, id) => handleRemoveFX(e, id)}
          onDragStart={(e, id) => handleFXDragStart(e, id)}
          onShowAll={() => setFxMenu(true)}
          idle={track.clips.length === 0 && !track.isTrackArmed}
        />
      )}
    </div>
  );
};
export default TrackHeader;
