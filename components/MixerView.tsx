
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { gainToDbText, panToText } from '../utils/db';
import { Track, TrackType, PluginInstance, TrackSend, PluginType, TrackGroup } from '../types';
import { SmartKnob } from './SmartKnob';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { getValidDestinations, getRouteLabel } from './RoutingManager';
import { PluginName } from './PluginName';
import { pluginDisplayName } from '../utils/pluginLabel';
import AutomationModeSelector from './AutomationModeSelector';
import { automationRecorder } from '../services/AutomationManager';
import { useLiveParam } from '../utils/automationLiveStore';
import { sendColor, sendHelp, sendLabel, trackDisplayName } from '../utils/sendLabels';
import InsertListPopover from './InsertListPopover';
import { MIXER_INSERT_ROWS, splitInserts } from '../utils/insertRows';
import { FloatingMenu, handlePluginModifierClick, InactiveStripVeil, MixerStructureButtons, pluginStateClass, pluginStateHelp, pluginStateMenuItems, SendSlotsPopover, SendViewPicker, SendViewStrip, TrackIOSelectors, useLongPress, VcaStrip } from './TrackStructure';
import { sendSlots, shownTrackIds } from '../utils/trackStructure';
import TrackMeter from './meters/TrackMeter';
import StripHead from './meters/StripHead';
import { loudnessPanel } from './meters/LoudnessPanel';
import { MASTER_OUT } from '../engine/meters/meterBank';

// Track Group Colors (inspired by Pro Tools)
const GROUP_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', 
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
];

// R11 : l'ancien VUMeter lisait le SPECTRE (getByteFrequencyData) et la droite
// recopiait la gauche. Les tranches utilisent désormais de vrais mètres
// AudioWorklet (components/meters/TrackMeter.tsx).

/** Même envoi : même destination ET même emplacement (Pro Tools : deux envois a et d vers RV PLATE). */
const sameSend = (a: TrackSend, b: TrackSend) => a.id === b.id && (a.slot ?? null) === (b.slot ?? null);

const SendKnob: React.FC<{ send: TrackSend, track: Track, allTracks: Track[], onUpdate: (t: Track) => void }> = ({ send, track, allTracks, onUpdate }) => {
  // Pendant la lecture, l'envoi suit son automation.
  const shownLevel = useLiveParam(track.id, `send::${send.id}`, send.level);
  const getSendColor = sendColor;

  return (
    <div className="flex flex-col items-center justify-center min-w-0" title={`Envoi vers ${sendLabel(send.id, allTracks)}${sendHelp(send.id) ? ` : ${sendHelp(send.id)}` : ''}`}>
       <SmartKnob 
          id={`${track.id}-send-${send.id}${send.slot !== undefined ? `-${send.slot}` : ''}`}
          targetId={track.id}
          paramId={`send::${send.id}`} 
          label={sendLabel(send.id, allTracks, true)}
          value={shownLevel}
          min={0}
          max={1.5}
          size={26} // Slightly bigger
          color={getSendColor(send.id)}
          defaultValue={1}
          format={gainToDbText}
          onChange={(val) => {
              const newSends = track.sends.map(s => sameSend(s, send) ? { ...s, level: val } : s);
              onUpdate({ ...track, sends: newSends });
          }}
       />
       {/* Pré / post-fader (Pro Tools « PRE ») : pré = le fader de la piste ne change pas l'envoi. */}
       <button
          type="button"
          onClick={() => onUpdate({ ...track, sends: track.sends.map(s => sameSend(s, send) ? { ...s, preFader: !s.preFader } : s) })}
          aria-pressed={!!send.preFader}
          aria-label={send.preFader ? `Envoi vers ${sendLabel(send.id, allTracks)} : pré-fader (touche pour le passer après le fader)` : `Envoi vers ${sendLabel(send.id, allTracks)} : post-fader (touche pour le passer avant le fader)`}
          title={send.preFader ? 'Pré-fader : l’envoi part avant le fader (le fader ne le change pas). Touche pour repasser en post-fader.' : 'Post-fader : l’envoi suit le fader de la piste. Touche pour le passer en pré-fader.'}
          className={`mt-0.5 px-1 rounded text-[7px] font-black leading-[12px] tracking-wider ${send.preFader ? 'bg-amber-400/90 text-black' : 'text-slate-600 hover:text-slate-300'}`}
       >{send.preFader ? 'PRÉ' : 'POST'}</button>
    </div>
  );
};

/** Bouton « Envois a-j » : les 10 envois de la piste (niveau, pan, mute, pré / post). */
const SendsButton: React.FC<{ track: Track, allTracks: Track[] }> = ({ track, allTracks }) => {
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const used = sendSlots(track.sends).filter(Boolean).length;
    return (
        <>
            <button type="button" data-testid={`sends-open-${track.id}`} onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}
                title="Envois a à j (Pro Tools : 10 envois par piste, avec pan et mute)"
                className="h-6 [@media(pointer:coarse)]:h-8 rounded border border-white/5 bg-black/60 px-2 flex items-center text-[8px] font-black text-slate-500 hover:border-white/20">
                <span className="mr-2">Envois</span><span className="flex-1 text-left font-mono text-cyan-300">a-j · {used}/10</span><i className="fas fa-caret-down text-[8px] text-slate-600" />
            </button>
            {anchor && <SendSlotsPopover track={track} all={allTracks} anchor={anchor} onClose={() => setAnchor(null)} />}
        </>
    );
};

const IOSection: React.FC<{ track: Track, allTracks: Track[], onUpdate: (t: Track) => void }> = ({ track, allTracks, onUpdate }) => {
    
    return (
        <div className="flex flex-col space-y-1 mb-2 px-1">
            {/* INPUT SELECTOR - Uniquement visible pour la piste REC */}
            {track.id === 'track-rec-main' && (
                <div className="relative group/io">
                    <div className="h-6 bg-black/60 [[data-theme=light]_&]:bg-nv-surface rounded flex items-center px-2 border border-white/5 cursor-pointer hover:border-white/20">
                        <span className="text-[8px] font-black text-slate-500 mr-2" title="Entrée : d'où vient le son enregistré">Entrée</span>
                        <span className="text-[8px] font-mono text-cyan-400 truncate flex-1">
                            {track.inputDeviceId === 'mic-default' ? 'Micro 1' : (track.inputDeviceId ? 'Externe' : 'Aucune')}
                        </span>
                        <i className="fas fa-caret-down text-[8px] text-slate-600"></i>
                    </div>
                    <select 
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        value={track.inputDeviceId || 'none'}
                        onChange={(e) => onUpdate({ ...track, inputDeviceId: e.target.value === 'none' ? undefined : e.target.value })}
                    >
                        <option value="none">Pas d'entrée</option>
                        <option value="mic-default">Mic / Line 1</option>
                    </select>
                </div>
            )}

            {/* ENTRÉE / SORTIE façon Pro Tools : master, bus nommés, pistes (utils/trackStructure). */}
            <TrackIOSelectors track={track} allTracks={allTracks} />
            <SendsButton track={track} allTracks={allTracks} />
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
  onReorderPlugins?: (trackId: string, fromIndex: number, toIndex: number) => void,
  /** Ouvrir tout de suite le renommage (nouveau bus, audit G20). */
  autoRename?: boolean,
  onRenameDone?: () => void,
  /** Send View (Pro Tools) : envoi a-j affiché en grand (null : vue normale). */
  sendViewSlot?: number | null
}> = ({ track, allTracks, onUpdate, isMaster = false, onOpenPlugin, onToggleBypass, onRemovePlugin, onDropPlugin, onRequestAddPlugin, onCopyPluginToTrack, onReorderPlugins, autoRename, onRenameDone, sendViewSlot = null }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  // Menu d'un effet (clic droit, appui long) : actif / bypass / inactif.
  const [fxMenu, setFxMenu] = useState<{ x: number; y: number; p: PluginInstance } | null>(null);
  const { consumed: fxConsumed, ...fxLpHandlers } = useLongPress((x, y) => { const id = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-fx-id]')?.getAttribute('data-fx-id'); const p = track.plugins.find(pl => pl.id === id); if (p) setFxMenu({ x, y, p }); });
  // Renommer la tranche : double-clic sur le nom (G12), ou tout de suite pour un nouveau bus.
  const [renaming, setRenaming] = useState(!!autoRename);
  useEffect(() => { if (autoRename) setRenaming(true); }, [autoRename]);
  const faderTrackRef = useRef<HTMLDivElement>(null);
  const [insertList, setInsertList] = useState<DOMRect | null>(null);
  const insertRows = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? MIXER_INSERT_ROWS.touch : MIXER_INSERT_ROWS.mouse;
  const { shown: shownInserts, hidden: hiddenInserts } = splitInserts(track.plugins, insertRows);
  

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

  // Fader de volume : course en racine du gain (0…1.5), glissement RELATIF
  // (le fader ne saute plus sous le clic), Maj = fin, molette, double-clic = 0 dB.
  // Pendant la lecture, fader et pan suivent l'automation (comme la console Pro Tools).
  const shownVolume = useLiveParam(track.id, 'volume', track.volume);
  const shownPan = useLiveParam(track.id, 'pan', track.pan);
  const faderPos = Math.sqrt(Math.max(0, shownVolume) / 1.5);
  const fader = useKnobInteraction(faderPos, (p) => onUpdate({ ...track, volume: p * p * 1.5 }), {
      min: 0, max: 1, defaultValue: Math.sqrt(1 / 1.5), wheelStep: 0.005,
      sensitivity: Math.max(120, faderTrackRef.current?.clientHeight || 300),
      // Automation Touch / Latch / Write / Trim : l'appui et le relâchement bornent l'écriture.
      onStart: () => automationRecorder.touch(track.id, 'volume'),
      onEnd: () => automationRecorder.release(track.id, 'volume'),
  });

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
      data-inactive={track.isInactive ? '1' : undefined}
      className={`relative flex-shrink-0 bg-[#0c0e12] border-r border-white/5 flex flex-col h-full transition-all touch-manipulation ${isMaster ? 'w-64 border-l-2 border-cyan-500/20' : track.type === TrackType.BUS ? 'w-48 bg-[#14161a]' : 'w-44'} ${isDragOver ? 'bg-cyan-500/20' : ''}`}
    >
      
      {!isMaster && <InactiveStripVeil track={track} all={allTracks} />}
      {!isMaster && sendViewSlot !== null && (
        <div className="h-[104px] shrink-0 bg-cyan-500/[0.04] border-b border-white/[0.04] p-2 overflow-hidden"><SendViewStrip track={track} all={allTracks} slot={sendViewSlot} /></div>
      )}
      {!isMaster && sendViewSlot === null && (track.type === TrackType.AUDIO || track.type === TrackType.SAMPLER) && (
        <div className="h-[104px] shrink-0 bg-black/20 border-b border-white/[0.04] p-2 grid grid-cols-3 gap-2 items-start overflow-hidden">
          {track.sends.map((s, i) => <SendKnob key={`${s.id}-${s.slot ?? i}`} send={s} track={track} allTracks={allTracks} onUpdate={onUpdate} />)}
        </div>
      )}
      
      {/* Effets : tous visibles (8 lignes à la souris, 5 au doigt), sinon « +N »
          qui ouvre la liste complète (audit B5). Hauteur fixe : les faders restent alignés. */}
      <div className="h-[200px] shrink-0 border-b border-white/[0.04] px-2 pt-1.5 pb-2 flex flex-col gap-0.5 overflow-hidden">
        <div className="flex items-center justify-between px-1 mb-0.5">
          <span className="text-[8px] font-black text-slate-500 uppercase leading-3">{track.type === TrackType.BUS ? 'Effets du bus' : (isMaster ? 'Chaîne du master' : 'Effets')}</span>
          {track.plugins.length >= insertRows && (
            <button type="button" onClick={handleEmptySlotClick} title="Ajouter un effet" aria-label={`Ajouter un effet sur ${track.name}`}
              className="nova-hit-tactile w-4 h-3 rounded text-[8px] leading-3 text-slate-500 hover:text-cyan-300"><i className="fas fa-plus"></i></button>
          )}
        </div>
        {shownInserts.map((p, idx) => (
          <div 
            key={p.id} 
            className="relative group/fxslot w-full h-5 [@media(pointer:coarse)]:h-8 fx-slot"
            data-fx-id={p.id}
            data-fx-state={p.isInactive ? 'inactive' : p.isEnabled ? 'active' : 'bypass'}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setFxMenu({ x: e.clientX, y: e.clientY, p }); }}
            {...fxLpHandlers}
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
              onClick={(e) => { if (fxConsumed()) return; if (handlePluginModifierClick(e, track.id, p, () => onToggleBypass?.(track.id, p.id))) return; handleFXClick(e, p); }}
              title={pluginStateHelp(p)}
              aria-label={`Ouvrir ${pluginDisplayName(p)} (${track.name})`}
              className={`w-full h-full bg-black/40 [[data-theme=light]_&]:bg-nv-surface rounded border border-white/5 text-[10px] font-black hover:border-cyan-500/40 transition-all px-1.5 text-left truncate flex items-center pr-12 cursor-grab active:cursor-grabbing ${p.isEnabled && !p.isInactive ? 'text-cyan-400' : 'text-slate-600'} ${pluginStateClass(p)}`}
            >
               <i className="fas fa-grip-vertical text-slate-700 mr-1.5 text-[8px]"></i>
               <PluginName plugin={p} className="font-semibold" />
            </button>
            <div className="absolute right-1 top-0 bottom-0 flex items-center space-x-0.5">
               {/* Move Up/Down Buttons (toujours visibles au doigt : pas de survol) */}
               <div className="flex flex-col opacity-0 group-hover/fxslot:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                  <button 
                    onClick={(e) => { e.stopPropagation(); if (idx > 0 && onReorderPlugins) onReorderPlugins(track.id, idx, idx - 1); }}
                    className={`w-4 h-2.5 rounded-t flex items-center justify-center text-[6px] ${idx > 0 ? 'text-slate-500 hover:text-cyan-400 hover:bg-cyan-500/20' : 'text-slate-800 cursor-not-allowed'}`}
                    disabled={idx === 0}
                    title="Monter"
                  >
                    <i className="fas fa-chevron-up"></i>
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); if (idx < track.plugins.length - 1 && onReorderPlugins) onReorderPlugins(track.id, idx, idx + 1); }}
                    className={`w-4 h-2.5 rounded-b flex items-center justify-center text-[6px] ${idx < track.plugins.length - 1 ? 'text-slate-500 hover:text-cyan-400 hover:bg-cyan-500/20' : 'text-slate-800 cursor-not-allowed'}`}
                    disabled={idx === track.plugins.length - 1}
                    title="Descendre"
                  >
                    <i className="fas fa-chevron-down"></i>
                  </button>
               </div>
               <button onClick={(e) => { e.stopPropagation(); onToggleBypass?.(track.id, p.id); }} title={p.isEnabled ? 'Désactiver l\'effet' : 'Activer l\'effet'} aria-label={`${p.isEnabled ? 'Désactiver' : 'Activer'} ${p.type}`} aria-pressed={p.isEnabled} className={`w-4 h-4 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:h-8 rounded flex items-center justify-center transition-all ${p.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'}`}><i className="fas fa-power-off text-[7px]"></i></button>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onRemovePlugin?.(track.id, p.id); }} className="delete-fx" title="Retirer l'effet" aria-label={`Retirer ${p.type}`}><i className="fas fa-times"></i></button>
          </div>
        ))}
        {hiddenInserts.length > 0 && (
          <button type="button" data-testid={`mixer-inserts-plus-${track.id}`}
            onClick={(e) => { e.stopPropagation(); setInsertList((e.currentTarget as HTMLElement).getBoundingClientRect()); }}
            title={`Encore ${hiddenInserts.length} effet${hiddenInserts.length > 1 ? 's' : ''} : ${hiddenInserts.map(p => p.name || p.type).join(', ')}`}
            aria-label={`Voir les ${track.plugins.length} effets de ${track.name}`}
            className="w-full h-5 [@media(pointer:coarse)]:h-8 shrink-0 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-bold text-cyan-300 hover:bg-cyan-500/20">
            +{hiddenInserts.length} effet{hiddenInserts.length > 1 ? 's' : ''}
          </button>
        )}
        {track.plugins.length < insertRows && (
          <button
            onClick={handleEmptySlotClick}
            title="Ajouter un effet"
            aria-label={`Ajouter un effet sur ${track.name}`}
            className="w-full h-5 [@media(pointer:coarse)]:h-8 shrink-0 rounded border border-dashed border-white/15 bg-black/5 opacity-80 hover:opacity-100 hover:border-cyan-500/50 transition-all flex items-center justify-center gap-1 text-[9px] text-slate-400"
          >
            <i className="fas fa-plus text-[8px]"></i>{track.plugins.length === 0 && <span>Effet</span>}
          </button>
        )}
        {fxMenu && (
          <FloatingMenu x={fxMenu.x} y={fxMenu.y} title={fxMenu.p.name || fxMenu.p.type} onClose={() => setFxMenu(null)}
            items={pluginStateMenuItems(track.id, fxMenu.p, () => onOpenPlugin?.(track.id, fxMenu.p))} />
        )}
        {insertList && (
          <InsertListPopover anchor={insertList} title={`Effets de ${track.name}`} plugins={track.plugins}
            onOpen={(p) => onOpenPlugin?.(track.id, p)} onToggle={(p) => onToggleBypass?.(track.id, p.id)}
            onAdd={onRequestAddPlugin ? (x, y) => onRequestAddPlugin(track.id, x, y) : undefined}
            onClose={() => setInsertList(null)} />
        )}
      </div>

      <div className="flex-1 p-3 flex flex-col">
        {/* I/O SECTION */}
        {!isMaster && (
            <IOSection track={track} allTracks={allTracks} onUpdate={onUpdate} />
        )}
        {!isMaster && (
            <div className="mb-2 px-1"><AutomationModeSelector track={track} onUpdate={onUpdate} variant="mixer" /></div>
        )}

        {/* Tête de tranche (R11) : Ø, mono, trim d'entrée, largeur (avant les inserts). */}
        <div className="mb-2"><StripHead track={track} onUpdate={onUpdate} /></div>

        <div className="mb-2 flex flex-col items-center">
           <SmartKnob id={`${track.id}-pan`} targetId={track.id} paramId="pan" label="Pan" value={shownPan} min={-1} max={1} size={36} color="#06b6d4" defaultValue={0} format={panToText} onChange={(val) => onUpdate({...track, pan: val})} />
        </div>

        <div className="flex-1 flex space-x-3 px-2">
           <div className="flex-1 relative flex flex-col items-center">
              <div 
                data-nova-target={`vol-${track.id}`}
                {...fader.bind}
                ref={(el) => { faderTrackRef.current = el; fader.wheelRef(el); }}
                title="Volume : glisser (Maj = fin), molette, double-clic = 0 dB"
                role="slider"
                aria-label={`Volume ${track.name}`}
                aria-valuetext={gainToDbText(shownVolume)}
                className="h-full bg-black/40 rounded-full border border-white/5 relative cursor-pointer touch-none group/fader"
                style={{ width: 'var(--fader-width)' }}
              >
                 <div className={`absolute left-1/2 -translate-x-1/2 rounded border border-white/20 shadow-2xl z-20 flex items-center justify-center ${track.type === TrackType.BUS ? 'w-10 h-16 bg-amber-500 border-amber-400' : 'w-9 h-14 bg-nv-raised'}`} style={{ bottom: `calc(${(Math.sqrt(shownVolume / 1.5))*100}% - 28px)` }}>
                    <div className={`w-full h-0.5 ${track.type === TrackType.BUS ? 'bg-black' : 'bg-cyan-500'}`} />
                 </div>
              </div>
           </div>
           {/* Vrais mètres G / D (R11) + réduction de gain des dynamiques de la piste. */}
           <TrackMeter pointId={isMaster ? MASTER_OUT : track.id} grTrackId={track.id} showReadout
             label={isMaster ? 'Sortie master' : track.name} className={isMaster ? 'w-[44px]' : 'w-[30px]'} />
        </div>

        <div className="mt-2 text-center text-[10px] font-mono tabular-nums text-slate-300">{gainToDbText(shownVolume)}</div>
        {isMaster && (
          <button type="button" onClick={() => loudnessPanel.toggle()} data-testid="mixer-loudness"
            title="Fenêtre Loudness : LUFS intégré / court terme / momentané, LRA, crête vraie, corrélation, goniomètre, spectre"
            className="nova-hit-tactile mt-2 h-7 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-bold text-cyan-300 hover:bg-cyan-500/20">
            <i className="fas fa-wave-square mr-1 text-[9px]" />Loudness
          </button>
        )}
        <div className="mt-2 flex space-x-2">
           <button onClick={() => onUpdate({...track, isMuted: !track.isMuted})} aria-pressed={!!track.isMuted} aria-label={`Muet : ${track.name}`} className={`nova-hit-tactile flex-1 h-8 rounded text-[9px] font-black border ${track.isMuted ? 'bg-amber-500 text-black border-amber-400' : 'bg-white/[0.06] border-transparent text-slate-400 hover:text-white'}`} title="Couper le son de cette tranche">Muet</button>
           <button onClick={() => onUpdate({...track, isSolo: !track.isSolo})} aria-pressed={!!track.isSolo} aria-label={`Solo : ${track.name}`} className={`nova-hit-tactile flex-1 h-8 rounded text-[9px] font-black border ${track.isSolo ? 'bg-cyan-500 text-black border-cyan-400' : 'bg-white/[0.06] border-transparent text-slate-400 hover:text-white'}`} title="N'écouter que cette tranche">Solo</button>
        </div>
        
        <div className={`mt-3 h-10 rounded-lg flex items-center px-2 text-[9px] font-black uppercase border truncate relative ${track.type === TrackType.BUS ? 'bg-amber-500/10 border-transparent text-amber-400' : 'bg-white/[0.05] border-transparent text-white'}`}>
           <div className="w-1.5 h-full mr-2 rounded-full shrink-0" style={{ backgroundColor: track.color }} />
           {renaming && !isMaster ? (
             <input ref={el => { if (el && document.activeElement !== el) { el.focus({ preventScroll: true }); el.select(); } }} defaultValue={track.name} aria-label={`Nouveau nom de ${track.name}`} data-testid={`strip-rename-${track.id}`}
               onKeyDown={e => {
                 if (e.key === 'Enter') e.currentTarget.blur();
                 if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false); onRenameDone?.(); }
               }}
               onBlur={e => { const v = e.currentTarget.value.trim(); setRenaming(false); onRenameDone?.(); if (v && v !== track.name) onUpdate({ ...track, name: v }); }}
               className="min-w-0 flex-1 bg-black/60 border border-cyan-500/50 rounded px-1 text-[11px] font-bold normal-case text-white outline-none" />
           ) : (
             <span className="truncate" title={isMaster ? undefined : `${trackDisplayName(track, allTracks)} : double-clic pour renommer`}
               onDoubleClick={() => { if (!isMaster) setRenaming(true); }}>{trackDisplayName(track, allTracks)}</span>
           )}
        </div>
      </div>
    </div>
  );
};

/** Menu « Créer un groupe » ancré à son bouton (G21), recalé dans l'écran, liste entière visible. */
const groupMenuPos = (btn: HTMLElement | null, rows: number): React.CSSProperties => {
  const vh = window.innerHeight, vw = window.innerWidth, w = 256;
  const h = Math.min(vh - 16, 130 + rows * 36);
  const r = btn?.getBoundingClientRect();
  if (!r) return { left: 8, top: 8, maxHeight: vh - 16 };
  const left = r.right + 8 + w <= vw - 8 ? r.right + 8 : Math.max(8, r.left - 8 - w);
  const top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, vh - 8 - h));
  return { left, top, maxHeight: vh - 16 };
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
        title={group.isCollapsed ? 'Déplier le groupe' : 'Replier le groupe'}
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
          title="Lier les mute"
          aria-label="Lier les mute du groupe"
          aria-pressed={!!group.linkedMute}
        >
          M
        </button>
        
        {/* Linked Solo */}
        <button
          onClick={() => onUpdate({ ...group, linkedSolo: !group.linkedSolo })}
          className={`w-full h-6 rounded text-[8px] font-black ${group.linkedSolo ? 'text-black' : 'text-slate-600'}`}
          style={{ backgroundColor: group.linkedSolo ? group.color : 'transparent' }}
          title="Lier les solo"
          aria-label="Lier les solo du groupe"
          aria-pressed={!!group.linkedSolo}
        >
          S
        </button>
        
        {/* Linked Volume */}
        <button
          onClick={() => onUpdate({ ...group, linkedVolume: !group.linkedVolume })}
          className={`w-full h-6 rounded text-[8px] font-black ${group.linkedVolume ? 'text-black' : 'text-slate-600'}`}
          style={{ backgroundColor: group.linkedVolume ? group.color : 'transparent' }}
          title="Lier les volumes"
          aria-label="Lier les volumes du groupe"
          aria-pressed={!!group.linkedVolume}
        >
          V
        </button>
      </div>
      
      {/* Delete Group */}
      <button
        onClick={onDelete}
        className="h-8 flex items-center justify-center text-slate-600 hover:text-red-500 transition-colors border-t"
        style={{ borderColor: group.color + '40' }}
        title="Supprimer le groupe"
        aria-label="Supprimer le groupe"
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
  onCopyPluginToTrack?: (sourceTrackId: string, plugin: PluginInstance, destTrackId: string) => void,
  onReorderPlugins?: (trackId: string, fromIndex: number, toIndex: number) => void,
  // NEW: Track Groups (inspired by Pro Tools/Reaper)
  trackGroups?: TrackGroup[],
  onCreateGroup?: (trackIds: string[]) => void,
  onUpdateGroup?: (group: TrackGroup) => void,
  onDeleteGroup?: (groupId: string) => void,
  /** Send View (Pro Tools) : envoi a-j affiché en grand dans chaque tranche (null : vue normale). */
  sendViewSlot?: number | null
}> = ({
  tracks, onUpdateTrack, onOpenPlugin, onToggleBypass, onRemovePlugin,
  onDropPluginOnTrack, onRequestAddPlugin, onAddBus,
  onCopyPluginToTrack, onReorderPlugins,
  trackGroups = [], onCreateGroup, onUpdateGroup, onDeleteGroup, sendViewSlot = null
}) => {
  // Pistes masquées : hors de la console (comme Pro Tools) ; dossiers simples sans tranche ; VCA à part.
  // (masquée elle-même, ou dans un dossier masqué / replié).
  const shown = shownTrackIds(tracks);
  const audioTracks = tracks.filter(t => shown.has(t.id) && (t.type === TrackType.AUDIO || t.type === TrackType.SAMPLER || t.type === TrackType.MIDI));
  const busTracks = tracks.filter(t => t.type === TrackType.BUS && t.id !== 'master' && shown.has(t.id) && !t.isVca && t.folder?.kind !== 'basic');
  const sendTracks = tracks.filter(t => t.type === TrackType.SEND && shown.has(t.id));
  const vcaTracks = tracks.filter(t => t.isVca && shown.has(t.id));
  const masterTrack = tracks.find(t => t.id === 'master');

  // Get selected tracks for grouping
  const [selectedForGroup, setSelectedForGroup] = useState<Set<string>>(new Set());
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const groupBtnRef = useRef<HTMLButtonElement>(null);
  const mixerScrollRef = useRef<HTMLDivElement>(null);
  // Nouveau bus (G20) : on le montre et on ouvre son renommage tout de suite.
  const busWanted = useRef(false);
  const knownBuses = useRef<Set<string>>(new Set(busTracks.map(t => t.id)));
  const [renameBusId, setRenameBusId] = useState<string | null>(null);
  const busKey = busTracks.map(t => t.id).join('|');
  useEffect(() => {
    const fresh = busTracks.find(t => !knownBuses.current.has(t.id));
    knownBuses.current = new Set(busTracks.map(t => t.id));
    if (fresh && busWanted.current) {
      busWanted.current = false;
      setRenameBusId(fresh.id);
      // Défilement de la console seulement (scrollIntoView faisait aussi glisser toute la page),
      // en laissant le bus à gauche du master collé à droite.
      requestAnimationFrame(() => {
        const c = mixerScrollRef.current;
        const el = c?.querySelector<HTMLElement>(`[data-strip-id="${CSS.escape(fresh.id)}"]`);
        const master = c?.querySelector<HTMLElement>('[data-strip-id="master"]');
        if (!c || !el) return;
        const visibleW = c.clientWidth - (master?.offsetWidth || 0);
        c.scrollTo({ left: Math.max(0, el.offsetLeft - Math.max(0, (visibleW - el.offsetWidth) / 2)), behavior: 'smooth' });
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busKey]);
  
  // Groupes de mix : App les applique pour toutes les vues (R12, utils/editGroups.mixLinkUpdates :
  // volume et pan relatifs, muet, solo, envois, mode d'automation ; groupes actifs ; Maj+Ctrl inverse).
  const handleGroupedTrackUpdate = useCallback((_previous: Track, updated: Track) => {
    onUpdateTrack(updated);
  }, [onUpdateTrack]);
  
  return (
    <div ref={mixerScrollRef} className="flex-1 flex overflow-x-auto bg-[#08090b] custom-scroll h-full snap-x snap-mandatory">
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
              onCopyPluginToTrack={onCopyPluginToTrack}
              onReorderPlugins={onReorderPlugins}
              sendViewSlot={sendViewSlot}
            />
          </div>
        );
      })}
      
      {/* ADD BUS / CREATE GROUP Section */}
      <div className="flex flex-col items-center justify-center px-2 border-r border-white/5 min-w-[88px] space-y-2 overflow-y-auto">
         <button onClick={() => { busWanted.current = true; onAddBus?.(); }} className="w-12 h-12 rounded-2xl border border-dashed border-amber-500/30 text-amber-500 hover:bg-amber-500/10 flex items-center justify-center transition-all group" title="Ajouter un bus (piste de regroupement : plusieurs pistes y passent pour être traitées ensemble)" aria-label="Ajouter un bus">
            <i className="fas fa-plus group-hover:scale-125 transition-transform"></i>
         </button>
         <span className="text-[10px] font-bold text-amber-500 whitespace-nowrap">+ Bus</span>
         <MixerStructureButtons tracks={tracks} />
         <SendViewPicker slot={sendViewSlot} />
         
         {/* Create Group Button (inspired by Pro Tools) */}
         {onCreateGroup && (
           <>
             <div className="w-8 h-px bg-white/10 my-1"></div>
             <button 
               ref={groupBtnRef}
               onClick={() => setShowGroupMenu(!showGroupMenu)}
               className="w-10 h-10 rounded-xl border border-dashed border-purple-500/30 text-purple-400 hover:bg-purple-500/10 flex items-center justify-center transition-all relative"
               title="Créer un groupe de pistes"
               aria-label="Créer un groupe de pistes"
               aria-expanded={showGroupMenu}
             >
               <i className="fas fa-layer-group text-[11px]"></i>
             </button>
             <span className="text-[10px] font-bold text-purple-400 whitespace-nowrap">Grouper</span>
             
             {/* Group Creation Menu */}
             {showGroupMenu && (
               <div data-testid="group-menu" className="fixed bg-[#1a1c22] border border-white/20 rounded-xl shadow-2xl z-[700] p-3 w-64 flex flex-col"
                 style={groupMenuPos(groupBtnRef.current, audioTracks.length)}>
                 <div className="text-[11px] font-bold text-slate-300 mb-1">Créer un groupe</div>
                 <p className="text-[10px] text-slate-500 mb-2">Coche les pistes qui bougent ensemble (volume, muet, solo).</p>
                 
                 <div className="space-y-1 min-h-0 overflow-y-auto mb-3">
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
                     Annuler
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
                     Créer ({selectedForGroup.size})
                   </button>
                 </div>
               </div>
             )}
           </>
         )}
      </div>

      {busTracks.map(t => <div key={t.id} data-strip-id={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} autoRename={renameBusId === t.id} onRenameDone={() => setRenameBusId(null)} onUpdate={(updatedTrack) => onUpdateTrack(updatedTrack)} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} onCopyPluginToTrack={onCopyPluginToTrack} onReorderPlugins={onReorderPlugins} sendViewSlot={sendViewSlot} /></div>)}
      <div className="w-4 bg-black/30 border-r border-white/5" />
      {sendTracks.map(t => <div key={t.id} className="snap-start"><ChannelStrip track={t} allTracks={tracks} onUpdate={onUpdateTrack} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} onCopyPluginToTrack={onCopyPluginToTrack} onReorderPlugins={onReorderPlugins} sendViewSlot={sendViewSlot} /></div>)}
      {vcaTracks.length > 0 && <div className="w-2 bg-black/30 border-r border-white/5" />}
      {vcaTracks.map(v => <div key={v.id} className="snap-start"><VcaStrip vca={v} all={tracks} /></div>)}
      <div className="w-10 shrink-0 bg-black/50 border-r border-white/5" />
      {/* Master toujours visible à droite (G20), comme Logic / Pro Tools. */}
      <div className="snap-start sticky right-0 z-20 shrink-0 shadow-[-16px_0_24px_rgba(0,0,0,0.65)] [[data-theme=light]_&]:shadow-[-10px_0_18px_rgba(15,23,42,0.08)]" data-strip-id="master"><ChannelStrip track={masterTrack || { id: 'master', name: 'MASTER BUS', type: TrackType.BUS, color: '#00f2ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0 }} allTracks={tracks} onUpdate={onUpdateTrack} isMaster={true} onOpenPlugin={onOpenPlugin} onToggleBypass={onToggleBypass} onRemovePlugin={onRemovePlugin} onDropPlugin={onDropPluginOnTrack} onRequestAddPlugin={onRequestAddPlugin} onCopyPluginToTrack={onCopyPluginToTrack} onReorderPlugins={onReorderPlugins} /></div>
    </div>
  );
};
export default MixerView;
