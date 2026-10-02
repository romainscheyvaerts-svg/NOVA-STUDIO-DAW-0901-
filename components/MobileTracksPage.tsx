import MonitorControl from './MonitorControl';
import { gainToDbText } from '../utils/db';
import React, { useState } from 'react';
import MobileContainer from './MobileContainer';
import { Track, Clip, TrackType, TrackSend } from '../types';
import { getValidDestinations } from './RoutingManager';

interface MobileTracksPageProps {
  tracks: Track[];
  currentTime: number;
  isPlaying: boolean;
  isRecording: boolean;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onUpdateTrack: (track: Track) => void;
  onAddClip?: (trackId: string, clip: Clip) => void;
  onEditClip?: (clip: Clip) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
  onAddPlugin?: (trackId: string) => void;
  onOpenPlugin?: (trackId: string, pluginId: string) => void;
  onToggleBypass?: (trackId: string, pluginId: string) => void;
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void;
  onImportAudioToBeat?: (file: File) => void;
  onOpenCatalog?: () => void;
}

// Horizontal Send Fader Component - Touch optimized
const MobileSendFader: React.FC<{
  send: TrackSend;
  label: string;
  color: string;
  onChange: (level: number) => void;
}> = ({ send, label, color, onChange }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(e.target.value));
  };

  const percent = (send.level / 1.5) * 100;

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="text-[9px] font-bold text-white/70 w-16 truncate uppercase">{label}</span>
      <div className="flex-1 relative">
        <div className="h-6 bg-black/40 rounded-full overflow-hidden border border-white/10">
          <div 
            className="h-full transition-all duration-75"
            style={{ 
              width: `${percent}%`, 
              backgroundColor: color,
              opacity: 0.6,
              boxShadow: send.level > 0.1 ? `0 0 10px ${color}` : 'none'
            }}
          />
        </div>
        <input
          type="range"
          min="0"
          max="1.5"
          step="0.01"
          value={send.level}
          onChange={handleChange}
          aria-label={`Envoi ${label}`}
          aria-valuetext={gainToDbText(send.level)}
          className="absolute inset-x-0 w-full opacity-0 cursor-pointer"
          style={{ top: -8, height: 40 }}
        />
      </div>
      <span className="text-[9px] font-mono tabular-nums text-white/50 w-12 text-right">{gainToDbText(send.level)}</span>
    </div>
  );
};

/**
 * Page mobile pour gérer les pistes
 * Avec sections Sends toujours accessibles (pas de long press)
 */
const MobileTracksPage: React.FC<MobileTracksPageProps> = ({
  tracks,
  currentTime,
  isPlaying,
  isRecording,
  selectedTrackId,
  onSelectTrack,
  onUpdateTrack,
  onRemovePlugin,
  onOpenPlugin,
  onToggleBypass,
  onRequestAddPlugin,
  onImportAudioToBeat,
  onOpenCatalog
}) => {
  const [expandedSends, setExpandedSends] = useState<Record<string, boolean>>({});
  const [expandedFx, setExpandedFx] = useState<Record<string, boolean>>({});
  const [showBeatImportMenu, setShowBeatImportMenu] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportAudioToBeat) {
      onImportAudioToBeat(file);
      setShowBeatImportMenu(false);
    }
    if (e.target) e.target.value = '';
  };
  
  const visibleTracks = tracks.filter(t => t.id !== 'master');

  const toggleSends = (trackId: string) => {
    setExpandedSends(prev => ({ ...prev, [trackId]: !prev[trackId] }));
  };

  const handleSendChange = (track: Track, sendId: string, level: number) => {
    const newSends = track.sends.map(s => 
      s.id === sendId ? { ...s, level } : s
    );
    onUpdateTrack({ ...track, sends: newSends });
  };

  const canHaveSends = (track: Track) => {
    return (track.type === TrackType.AUDIO || track.type === TrackType.BUS || 
            track.type === TrackType.MIDI || track.type === TrackType.SAMPLER || 
            track.type === TrackType.DRUM_RACK) && 
           track.id !== 'instrumental' && track.id !== 'master';
  };

  return (
    <MobileContainer title="Pistes">
      <div className="space-y-3 pb-20">
        {visibleTracks.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <i className="fas fa-music text-4xl mb-4 opacity-30"></i>
            <p>Aucune piste</p>
            <p className="text-xs mt-2">Créez une piste pour commencer</p>
          </div>
        )}

        {visibleTracks.map(track => (
          <div
            key={track.id}
            className={`rounded-xl overflow-hidden transition-all ${
              selectedTrackId === track.id
                ? 'bg-cyan-500/10 ring-2 ring-cyan-500/50'
                : 'bg-[#14161a]'
            }`}
            onClick={() => onSelectTrack(track.id)}
          >
            {/* Track Header */}
            <div 
              className="p-3 flex items-center justify-between"
              style={{ borderLeft: `4px solid ${track.color}` }}
            >
              <div className="flex items-center gap-3">
                <div 
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${track.color}30` }}
                >
                  <i className={`fas ${
                    track.type === TrackType.MIDI ? 'fa-music' :
                    track.type === TrackType.DRUM_RACK ? 'fa-th' :
                    track.type === TrackType.BUS ? 'fa-layer-group' :
                    track.type === TrackType.SEND ? 'fa-magic' :
                    'fa-wave-square'
                  } text-xs`} style={{ color: track.color }}></i>
                </div>
                <div>
                  <span className="text-sm font-bold text-white">{track.name}</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-slate-500 uppercase">{track.type}</span>
                    {track.isMuted && <span className="text-[10px] font-semibold bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">M</span>}
                    {track.isSolo && <span className="text-[10px] font-semibold bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">S</span>}
                  </div>
                </div>
              </div>

              {/* Quick Controls : 32 px visibles, zone tactile 40 px (.nova-hit) */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isMuted: !track.isMuted }); }}
                  aria-label={`Muet : ${track.name}`}
                  aria-pressed={!!track.isMuted}
                  className={`nova-hit w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                    track.isMuted ? 'bg-red-500 text-white' : 'bg-white/5 text-slate-500'
                  }`}
                >
                  <span className="text-[10px] font-bold">M</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isSolo: !track.isSolo }); }}
                  aria-label={`Solo : ${track.name}`}
                  aria-pressed={!!track.isSolo}
                  className={`nova-hit w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                    track.isSolo ? 'bg-yellow-500 text-black' : 'bg-white/5 text-slate-500'
                  }`}
                >
                  <span className="text-[10px] font-bold">S</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setExpandedFx(prev => ({ ...prev, [track.id]: !prev[track.id] })); }}
                  aria-expanded={!!expandedFx[track.id]}
                  className={`nova-hit h-8 px-2 rounded-lg flex items-center justify-center gap-0.5 text-[10px] font-black transition-all ${
                    expandedFx[track.id] ? 'bg-cyan-500 text-black' : track.plugins.length ? 'bg-cyan-500/15 text-cyan-300' : 'bg-white/5 text-slate-500'
                  }`}
                  aria-label="Effets de la piste"
                >
                  FX{track.plugins.length ? <span className="opacity-80">{track.plugins.length}</span> : <i className="fas fa-plus text-[7px] ml-0.5" />}
                </button>
                {canHaveSends(track) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleSends(track.id); }}
                    aria-label="Envois (delay, réverbes)"
                    title="Envois"
                    aria-expanded={!!expandedSends[track.id]}
                    className={`nova-hit w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                      expandedSends[track.id] ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-500'
                    }`}
                  >
                    <i className="fas fa-sliders-h text-[10px]"></i>
                  </button>
                )}
                {track.type === TrackType.AUDIO && track.id !== 'instrumental' && !track.instrumentId && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isTrackArmed: !track.isTrackArmed }); }}
                    aria-label={track.isTrackArmed ? 'Couper le micro' : 'Activer le micro'}
                    aria-pressed={!!track.isTrackArmed}
                    className={`nova-hit w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                      track.isTrackArmed ? 'bg-red-600 text-white animate-pulse' : 'bg-white/5 text-slate-500'
                    }`}
                  >
                    <span className="text-[10px] font-bold">R</span>
                  </button>
                )}
              </div>
            </div>

            {/* Effets : accès direct, juste sous l'en-tête */}
            {expandedFx[track.id] && (
              <div className="px-4 pb-2 flex gap-2 overflow-x-auto no-scrollbar" onClick={e => e.stopPropagation()}>
                {track.plugins.map(p => (
                  <button key={p.id} type="button" onClick={() => onOpenPlugin?.(track.id, p.id)}
                    className={`shrink-0 h-9 px-3 rounded-lg text-[12px] font-bold border ${p.isEnabled ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' : 'border-white/10 bg-white/5 text-slate-500 line-through'}`}>
                    {p.name || p.type}
                  </button>
                ))}
                {onRequestAddPlugin && (
                  <button type="button" onClick={(e) => onRequestAddPlugin(track.id, e.clientX, e.clientY)}
                    className="shrink-0 h-9 px-3 rounded-lg text-[12px] font-bold bg-cyan-500 text-black">
                    <i className="fas fa-plus mr-1 text-[10px]" /> Effet
                  </button>
                )}
              </div>
            )}

            {/* Retour casque de la piste qui enregistre */}
            {track.isTrackArmed && (
              <div className="px-4 pb-2"><MonitorControl trackId={track.id} /></div>
            )}

            {/* Volume Fader */}
            <div className="px-4 pb-2" data-nova-target={`vol-${track.id}`}>
              <div className="flex items-center gap-3">
                <i className="fas fa-volume-up text-slate-500 text-xs"></i>
                <div className="flex-1 relative">
                  <div className="h-3 bg-black/40 rounded-full overflow-hidden">
                    <div 
                      className="h-full transition-all"
                      style={{ 
                        width: `${(track.volume / 1.5) * 100}%`,
                        backgroundColor: track.color 
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.01"
                    value={track.volume}
                    onChange={(e) => {
                      e.stopPropagation();
                      onUpdateTrack({ ...track, volume: parseFloat(e.target.value) });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Volume ${track.name}`}
                    aria-valuetext={gainToDbText(track.volume)}
                    // 40 px de zone tactile (la hauteur globale des range était de 4-6 px)
                    className="absolute inset-x-0 w-full opacity-0 cursor-pointer"
                    style={{ top: -14, height: 40 }}
                  />
                </div>
                <span className="text-[10px] font-mono text-slate-400 w-10 text-right">
                  {gainToDbText(track.volume)}
                </span>
              </div>
            </div>

            {/* Sends Section - Expands with simple tap */}
            {canHaveSends(track) && expandedSends[track.id] && (
              <div className="px-4 pb-3 border-t border-white/5 pt-3 bg-black/20">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">
                  <i className="fas fa-share-alt mr-1"></i> Sends
                </div>
                <div className="space-y-1">
                  <MobileSendFader
                    send={track.sends.find(s => s.id === 'send-delay') || { id: 'send-delay', level: 0, isEnabled: true }}
                    label="Delay 1/4"
                    color="#00f2ff"
                    onChange={(lvl) => handleSendChange(track, 'send-delay', lvl)}
                  />
                  <MobileSendFader
                    send={track.sends.find(s => s.id === 'send-verb-short') || { id: 'send-verb-short', level: 0, isEnabled: true }}
                    label="Verb Pro"
                    color="#10b981"
                    onChange={(lvl) => handleSendChange(track, 'send-verb-short', lvl)}
                  />
                  <MobileSendFader
                    send={track.sends.find(s => s.id === 'send-verb-long') || { id: 'send-verb-long', level: 0, isEnabled: true }}
                    label="Hall Space"
                    color="#a855f7"
                    onChange={(lvl) => handleSendChange(track, 'send-verb-long', lvl)}
                  />
                </div>
              </div>
            )}

            {/* Clips de la piste */}
            {track.clips.length > 0 && (
              <div className="px-4 pb-2 border-t border-white/5 pt-2">
                <div className="flex items-center gap-2 overflow-x-auto py-1">
                  {track.clips.map(clip => (
                    <div
                      key={clip.id}
                      className="shrink-0 h-10 rounded-lg px-3 flex items-center justify-center text-xs font-medium"
                      style={{
                        width: `${Math.max(80, clip.duration * 20)}px`,
                        backgroundColor: `${track.color}40`,
                        borderLeft: `3px solid ${track.color}`
                      }}
                    >
                      <div className="truncate text-white/80">{clip.name || 'Clip'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Section Routing/Connexions (I/O) */}
            <div className="px-4 pb-3 border-t border-white/5 pt-3">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">
                Connexions
              </div>
              <div className="space-y-2">
                {/* Sélecteur d entrée retiré : il n était relié à rien (« No Input » inquiétait). Le micro se choisit dans Réglages audio. */}

                {/* OUTPUT - Toutes les pistes */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30">
                    <i className="fas fa-arrow-left text-amber-400 text-sm"></i>
                  </div>
                  <div className="flex-1">
                    <div className="text-[10px] text-slate-500 mb-1 font-bold uppercase">Output</div>
                    <select
                      value={track.outputTrackId || 'master'}
                      onChange={(e) => {
                        e.stopPropagation();
                        onUpdateTrack({ ...track, outputTrackId: e.target.value });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full px-3 py-2 bg-black/60 border border-white/10 rounded-lg text-xs font-bold text-amber-400 focus:border-amber-500/50 focus:outline-none"
                    >
                      {getValidDestinations(track.id, tracks).map(dest => (
                        <option key={dest.id} value={dest.id}>
                          {dest.id === 'master' ? 'STEREO OUT (MASTER)' : dest.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Bouton Import Audio - Uniquement pour la piste BEAT */}
                  {track.id === 'instrumental' && (onImportAudioToBeat || onOpenCatalog) && (
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowBeatImportMenu(!showBeatImportMenu);
                        }}
                        aria-label="Importer un beat (catalogue ou fichier)"
                        title="Importer un beat"
                        className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400 hover:bg-cyan-500/30 active:scale-95 transition-all"
                      >
                        <i className="fas fa-file-audio text-sm"></i>
                      </button>
                      
                      {/* Menu dropdown import */}
                      {showBeatImportMenu && (
                        <div className="absolute right-0 top-12 z-50 w-48 bg-[#1a1d24] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onOpenCatalog) {
                                onOpenCatalog();
                                setShowBeatImportMenu(false);
                              }
                            }}
                            className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/5 active:bg-white/10 transition-all"
                          >
                            <i className="fas fa-music text-cyan-400"></i>
                            <span className="text-sm text-white font-medium">Catalogue</span>
                          </button>
                          <div className="h-px bg-white/5"></div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              fileInputRef.current?.click();
                            }}
                            className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/5 active:bg-white/10 transition-all"
                          >
                            <i className="fas fa-folder-open text-amber-400"></i>
                            <span className="text-sm text-white font-medium">Fichier local</span>
                          </button>
                        </div>
                      )}
                      
                      {/* Input file caché */}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/*"
                        onChange={handleFileSelect}
                        className="hidden"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Section Plugins avec bouton + */}
            <div className="px-4 pb-4 border-t border-white/5 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                  Plugins ({track.plugins.length})
                </span>
                {onRequestAddPlugin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestAddPlugin(track.id, e.clientX, e.clientY);
                    }}
                    aria-label="Ajouter un effet"
                    title="Ajouter un effet"
                    className="nova-hit w-8 h-8 rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 active:bg-cyan-500/40 flex items-center justify-center text-cyan-400 transition-all"
                  >
                    <i className="fas fa-plus text-xs"></i>
                  </button>
                )}
              </div>

              {/* Liste des plugins - CLICKABLE pour ouvrir */}
              {track.plugins.length === 0 ? (
                <div 
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onRequestAddPlugin) onRequestAddPlugin(track.id, 200, 400);
                  }}
                  className="text-xs text-slate-600 text-center py-4 bg-white/5 rounded-lg border border-dashed border-white/10 cursor-pointer hover:bg-white/10 transition-all"
                >
                  <i className="fas fa-plug text-lg mb-1 opacity-30"></i>
                  <p>Aucun plugin</p>
                  <p className="text-[10px] mt-1 opacity-70">Tap pour ajouter</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {track.plugins.map(plugin => (
                    <div
                      key={plugin.id}
                      className={`relative p-3 rounded-lg border transition-all ${
                        plugin.isEnabled
                          ? 'bg-gradient-to-br from-cyan-500/10 to-blue-500/10 border-cyan-500/30'
                          : 'bg-white/5 border-white/10 opacity-50'
                      }`}
                    >
                      {/* Bouton de suppression */}
                      {onRemovePlugin && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Supprimer ${plugin.name || plugin.type} ?`)) {
                              onRemovePlugin(track.id, plugin.id);
                            }
                          }}
                          aria-label={`Supprimer ${plugin.name || plugin.type}`}
                          className="nova-hit absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 hover:bg-red-600 active:bg-red-700 flex items-center justify-center text-white shadow-lg z-10 transition-all"
                        >
                          <i className="fas fa-times text-[10px]"></i>
                        </button>
                      )}
                      
                      {/* Zone cliquable pour ouvrir le plugin */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          console.log('[MobileTracksPage] Opening plugin:', track.id, plugin.id);
                          if (onOpenPlugin) onOpenPlugin(track.id, plugin.id);
                        }}
                        className="w-full text-left active:scale-95 transition-transform"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-bold text-cyan-400 uppercase">
                            {plugin.type}
                          </span>
                          {onToggleBypass && (
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleBypass(track.id, plugin.id);
                              }}
                              className={`w-4 h-4 rounded-full ${
                                plugin.isEnabled ? 'bg-cyan-500' : 'bg-slate-600'
                              }`}
                            />
                          )}
                        </div>
                        <div className="text-[9px] text-slate-400 truncate">
                          {plugin.name || 'Tap to edit'}
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </MobileContainer>
  );
};

export default MobileTracksPage;
