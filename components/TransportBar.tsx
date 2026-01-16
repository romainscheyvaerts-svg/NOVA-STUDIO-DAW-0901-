import React, { useState, useRef, useEffect, PropsWithChildren } from 'react';
import { ViewType, Theme, User } from '../types';
import { MasterMeter } from './MeterWidgets';
import MasterVisualizer from './MasterVisualizer';
import { midiManager } from '../services/MidiManager';

interface TransportProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  isRecording: boolean;
  onToggleRecord: () => void;
  isLoopActive: boolean;
  onToggleLoop: () => void;
  bpm: number;
  onBpmChange: (newBpm: number) => void;
  currentTime: number;
  currentView: ViewType;
  onChangeView: (view: ViewType) => void;
  noArmedTrackError?: boolean;
  statusMessage?: string | null;
  currentTheme?: Theme;
  onToggleTheme?: () => void;
  
  // Modal Triggers
  onOpenSaveMenu?: () => void;
  onOpenLoadMenu?: () => void;
  
  onExportMix?: () => void; 
  onShareProject?: () => void;

  // Engine Props
  onOpenAudioEngine?: () => void;
  isDelayCompEnabled?: boolean;
  onToggleDelayComp?: () => void;

  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  user?: User | null;
  onOpenAuth?: () => void; 
  onLogout?: () => void;

  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;

  // Import Audio (nouveau système)
  onImportAudio?: (file: File) => void;
}

const TransportBar: React.FC<PropsWithChildren<TransportProps>> = ({
  isPlaying, onTogglePlay, onStop, isRecording, onToggleRecord, isLoopActive, onToggleLoop, bpm, onBpmChange, currentTime,
  currentView, onChangeView, noArmedTrackError, statusMessage, currentTheme, onToggleTheme,
  onOpenSaveMenu, onOpenLoadMenu, onExportMix, onShareProject, onOpenAudioEngine, isDelayCompEnabled, onToggleDelayComp,
  onUndo, onRedo, canUndo, canRedo,
  user, onOpenAuth, onLogout,
  isSidebarOpen, onToggleSidebar,
  onImportAudio,
  children
}) => {
  const [isEditingBpm, setIsEditingBpm] = useState(false);
  const [tempBpm, setTempBpm] = useState(bpm.toString());
  const [midiActive, setMidiActive] = useState(false);
  const [midiDeviceName, setMidiDeviceName] = useState<string | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const bpmInputRef = useRef<HTMLInputElement>(null);
  const audioImportInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
     // Check for MIDI device on mount
     const name = midiManager.getActiveDeviceName();
     if (name) setMidiDeviceName(name);

     // Listen for MIDI activity
     const unsubscribe = midiManager.addNoteListener((cmd, note, vel) => {
         setMidiActive(true);
         setMidiDeviceName(midiManager.getActiveDeviceName());
         setTimeout(() => setMidiActive(false), 200);
     });
     
     return unsubscribe;
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const cents = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${cents.toString().padStart(2, '0')}`;
  };

  const handleBpmMouseDown = (e: React.MouseEvent) => {
    if (e.detail === 2) { 
      setIsEditingBpm(true);
      return;
    }
    const startY = e.clientY;
    const startBpm = bpm;
    const onMouseMove = (m: MouseEvent) => {
      const delta = Math.floor((startY - m.clientY) / 5);
      if (delta !== 0) {
        onBpmChange(Math.max(20, Math.min(999, startBpm + delta)));
      }
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  useEffect(() => {
    if (isEditingBpm) bpmInputRef.current?.focus();
  }, [isEditingBpm]);

  return (
    <div className="h-16 flex items-center px-2 md:px-4 justify-between z-50 shadow-sm relative shrink-0 transition-all" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}>
      {noArmedTrackError && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-4 py-2 bg-red-600 text-white text-[10px] font-black uppercase rounded-lg shadow-2xl animate-bounce z-[100]">
          <i className="fas fa-exclamation-triangle mr-2"></i> Record Error
        </div>
      )}

      {/* LEFT CONTROLS */}
      <div className="flex items-center space-x-3">
          {/* MOBILE HAMBURGER MENU BUTTON */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden w-10 h-10 rounded-lg flex items-center justify-center bg-white/10 border border-white/20 text-white hover:bg-white/20 transition-all"
            title="Menu"
          >
            <i className={`fas ${isMobileMenuOpen ? 'fa-times' : 'fa-bars'} text-lg`}></i>
          </button>

          <div className="hidden md:flex items-center space-x-2">
            <button 
              onClick={onToggleSidebar} 
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors border ${isSidebarOpen ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
              title={isSidebarOpen ? "Masquer le navigateur" : "Afficher le navigateur"}
            >
              <i className="fas fa-columns text-xs"></i>
            </button>
            <div className="h-6 w-px bg-white/5" style={{ backgroundColor: 'var(--border-dim)' }}></div>
             <div className="flex items-center space-x-1 pr-2 border-r border-white/5" style={{ borderColor: 'var(--border-dim)' }}>
                <button onClick={onUndo} disabled={!canUndo} className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all border border-white/10 ${canUndo ? 'bg-white/5 hover:bg-cyan-500 hover:text-black' : 'opacity-30 cursor-not-allowed'}`} style={{ color: canUndo ? 'var(--text-primary)' : 'var(--text-secondary)' }}><i className="fas fa-undo text-[10px]"></i></button>
                <button onClick={onRedo} disabled={!canRedo} className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all border border-white/10 ${canRedo ? 'bg-white/5 hover:bg-cyan-500 hover:text-black' : 'opacity-30 cursor-not-allowed'}`} style={{ color: canRedo ? 'var(--text-primary)' : 'var(--text-secondary)' }}><i className="fas fa-redo text-[10px]"></i></button>
             </div>
             
             {/* FILE ACTIONS GROUP */}
             <div className="flex items-center space-x-1 pr-2 border-r border-white/5" style={{ borderColor: 'var(--border-dim)' }}>
                {/* OPEN / LOAD */}
                <button onClick={onOpenLoadMenu} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/5 hover:bg-amber-500 hover:text-black text-amber-400" title="Ouvrir un projet">
                    <i className="fas fa-folder-open text-[10px]"></i>
                    <span className="hidden xl:inline text-[9px] font-black uppercase">Ouvrir</span>
                </button>

                {/* SAVE */}
                <button onClick={onOpenSaveMenu} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/5 hover:bg-green-500 hover:text-black text-green-400" title="Sauvegarder">
                    <i className="fas fa-save text-[10px]"></i>
                    <span className="hidden xl:inline text-[9px] font-black uppercase">Sauver</span>
                </button>

                {/* ✨ NOUVEAU IMPORT AUDIO */}
                {onImportAudio && (
                    <>
                        <button
                            onClick={() => audioImportInputRef.current?.click()}
                            className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/5 hover:bg-cyan-500 hover:text-black text-cyan-400"
                            title="Importer un fichier audio"
                        >
                            <i className="fas fa-file-import text-[10px]"></i>
                            <span className="hidden xl:inline text-[9px] font-black uppercase">Import</span>
                        </button>
                        <input
                            ref={audioImportInputRef}
                            type="file"
                            accept="audio/*"
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                    onImportAudio(file);
                                    // Reset input pour permettre de réimporter le même fichier
                                    e.target.value = '';
                                }
                            }}
                        />
                    </>
                )}
             </div>
             
             {/* SHARE (Only if logged in) */}
             {user && (
                 <button onClick={onShareProject} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-black"><i className="fas fa-share-alt text-[10px]"></i><span className="hidden xl:inline text-[9px] font-black uppercase">Share</span></button>
             )}
             
             {/* EXPORT BUTTON */}
             <button onClick={onExportMix} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-purple-500/10 text-purple-400 hover:bg-purple-500 hover:text-black"><i className="fas fa-compact-disc text-[10px]"></i><span className="hidden xl:inline text-[9px] font-black uppercase">Export</span></button>
             
             {/* ENGINE BUTTON */}
             <button onClick={onOpenAudioEngine} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-orange-500/10 text-orange-400 hover:bg-orange-500 hover:text-black"><i className="fas fa-microchip text-[10px]"></i><span className="hidden xl:inline text-[9px] font-black uppercase">Engine</span></button>
             
             {/* PDC Toggle */}
             <button onClick={onToggleDelayComp} className={`h-8 px-2 rounded-lg flex items-center space-x-1 transition-all border ${isDelayCompEnabled ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`} title="Delay Compensation (PDC)">
                <div className={`w-1.5 h-1.5 rounded-full ${isDelayCompEnabled ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`}></div>
                <span className="text-[9px] font-black uppercase tracking-wider">PDC</span>
             </button>

             {/* MIDI INDICATOR */}
             <div className={`h-8 px-2 rounded-lg flex items-center justify-center space-x-2 border transition-all ${midiActive ? 'bg-green-500 text-black border-green-400 shadow-lg shadow-green-500/30' : 'bg-white/5 border-white/10 text-slate-600'}`} title={midiDeviceName || "No MIDI Device"}>
                 <i className="fas fa-plug text-[10px]"></i>
                 {midiDeviceName && <span className="hidden xl:inline text-[8px] font-black uppercase max-w-[80px] truncate">{midiDeviceName}</span>}
             </div>
          </div>
      </div>

      {/* CENTER: TRANSPORT */}
      <div className="flex flex-1 md:flex-none justify-center items-center space-x-2 md:space-x-4">
        <div className="hidden xl:block"><MasterMeter /></div>
        
        <div className="flex items-center space-x-2 md:space-x-3 bg-black/40 px-3 md:px-4 py-1.5 rounded-xl border border-white/5" style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}>
          <button onClick={onStop} className="w-8 h-8 text-slate-600 hover:text-white transition-colors hide-on-tablet-text" style={{ color: 'var(--text-secondary)' }}><i className="fas fa-stop text-xs"></i></button>
          <button onClick={onTogglePlay} className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isPlaying ? 'text-black shadow-lg shadow-[#00f2ff]/30' : 'bg-white text-black hover:scale-105'}`} style={{ backgroundColor: isPlaying ? 'var(--accent-neon)' : '#fff' }}><i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-sm`}></i></button>
          <button onClick={onToggleLoop} className={`hidden md:flex w-8 h-8 rounded-lg items-center justify-center transition-all ${isLoopActive ? 'text-cyan-400' : 'text-slate-600 hover:text-white'}`} style={{ backgroundColor: isLoopActive ? 'rgba(0,242,255,0.2)' : 'transparent', color: isLoopActive ? 'var(--accent-neon)' : 'var(--text-secondary)' }}><i className="fas fa-sync-alt text-xs"></i></button>
          <button onClick={onToggleRecord} className={`h-10 px-3 md:px-5 rounded-xl flex items-center space-x-2 md:space-x-2 border transition-all ${isRecording ? 'bg-red-600 border-red-400 text-white shadow-lg shadow-red-600/40 animate-pulse' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: isRecording ? '#ef4444' : 'var(--border-dim)', borderColor: isRecording ? '#f87171' : 'var(--border-highlight)' }}><div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-white' : 'bg-red-600'}`}></div><span className="hidden md:inline font-black uppercase text-[10px] tracking-widest hide-on-tablet-text">Rec</span></button>
        </div>
        
        <div className="flex flex-col items-center min-w-[60px] md:min-w-[80px]">
             <span className="hidden md:block text-[7px] text-slate-600 font-black uppercase tracking-[0.3em] hide-on-tablet-text" style={{ color: 'var(--text-secondary)' }}>Timeline</span>
             <span className="mono text-[11px] md:text-[14px] font-bold text-center" style={{ color: 'var(--accent-neon)' }}>{formatTime(currentTime)}</span>
        </div>
      </div>

      {/* RIGHT SIDE CONTROLS */}
      <div className="flex items-center space-x-3 md:space-x-4">
        
        {/* VISUALIZER (Only on very large screens to save space) */}
        <div className="hidden 2xl:block opacity-80 hover:opacity-100 transition-opacity">
           <MasterVisualizer />
        </div>

        {/* VIEW SWITCHER & THEME */}
        <div className="hidden lg:flex items-center space-x-1 bg-black/40 rounded-xl p-1 border border-white/5" style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}>
            <button onClick={() => onChangeView('ARRANGEMENT')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${currentView === 'ARRANGEMENT' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'ARRANGEMENT' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'ARRANGEMENT' ? '#000' : 'var(--text-secondary)' }}>Arrangement</button>
            <button onClick={() => onChangeView('MIXER')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${currentView === 'MIXER' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'MIXER' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'MIXER' ? '#000' : 'var(--text-secondary)' }}>Mixer</button>
            <button onClick={() => onChangeView('AUTOMATION')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${currentView === 'AUTOMATION' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'AUTOMATION' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'AUTOMATION' ? '#000' : 'var(--text-secondary)' }}>Auto</button>
        </div>

        {/* THEME TOGGLE */}
        <button 
            onClick={onToggleTheme}
            className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-all"
            title="Changer le thème"
            style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}
        >
            <i className={`fas ${currentTheme === 'dark' ? 'fa-sun text-amber-400' : 'fa-moon text-slate-300'}`}></i>
        </button>

        {/* BPM CONTROL */}
        <div className="hidden sm:flex flex-col items-end cursor-ns-resize group" onMouseDown={handleBpmMouseDown}>
           <div className="flex items-center space-x-2">
              {isEditingBpm ? (
                <input ref={bpmInputRef} type="text" value={tempBpm} onChange={(e) => setTempBpm(e.target.value.replace(/[^0-9.]/g, ''))} onBlur={() => { setIsEditingBpm(false); onBpmChange(parseFloat(tempBpm) || 120); }} onKeyDown={(e) => e.key === 'Enter' && bpmInputRef.current?.blur()} className="w-10 md:w-12 bg-white/10 border border-cyan-500/50 rounded text-center text-[10px] md:text-[11px] font-black text-white outline-none" />
              ) : (
                <span className="text-[10px] md:text-[11px] font-black transition-colors" style={{ color: 'var(--text-primary)' }}>{bpm}</span>
              )}
              <span className="text-[7px] text-slate-500 font-bold uppercase tracking-widest hide-on-tablet-text">BPM</span>
           </div>
           <div className="hidden md:block w-14 h-1 rounded-full mt-1 overflow-hidden" style={{ backgroundColor: 'var(--border-dim)' }}><div className="h-full transition-all duration-300" style={{ width: `${Math.min(100, (bpm / 250) * 100)}%`, backgroundColor: 'var(--accent-neon)' }}></div></div>
        </div>
        
        {/* LOGIN / USER SECTION */}
        {user ? (
            <div className="flex items-center space-x-2 bg-black/30 rounded-full pl-1 pr-1 py-1 border border-white/10" style={{ backgroundColor: 'var(--bg-item)' }}>
                <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-[10px] font-black text-white shadow-lg shadow-cyan-500/20">{user.username.charAt(0).toUpperCase()}</div>
                <button onClick={onLogout} className="w-7 h-7 rounded-full bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center justify-center transition-all"><i className="fas fa-sign-out-alt text-[10px]"></i></button>
            </div>
        ) : (
            <button onClick={onOpenAuth} className="h-8 px-4 rounded-full bg-white/10 hover:bg-cyan-500 hover:text-black text-white text-[9px] font-black uppercase tracking-widest transition-all border border-white/10 flex items-center space-x-2"><i className="fas fa-user-circle"></i></button>
        )}

        {/* View Switcher for mobile/tablet injection from parent */}
        {children}
      </div>

      {/* MOBILE DROPDOWN MENU */}
      {isMobileMenuOpen && (
        <div className="md:hidden absolute top-full left-0 right-0 bg-[#0a0b0d] border-b border-white/10 shadow-2xl z-[100] max-h-[80vh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}>
          <div className="p-4 space-y-3">

            {/* VIEW SWITCHER */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Vues</div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => { onChangeView('ARRANGEMENT'); setIsMobileMenuOpen(false); }} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${currentView === 'ARRANGEMENT' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-grip-horizontal block mb-1"></i>
                  Arrangement
                </button>
                <button onClick={() => { onChangeView('MIXER'); setIsMobileMenuOpen(false); }} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${currentView === 'MIXER' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-sliders-h block mb-1"></i>
                  Mixer
                </button>
                <button onClick={() => { onChangeView('AUTOMATION'); setIsMobileMenuOpen(false); }} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${currentView === 'AUTOMATION' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-project-diagram block mb-1"></i>
                  Auto
                </button>
              </div>
            </div>

            {/* VIEW MODE SWITCHER (PC/MOBILE) */}
            {children && (
              <div className="space-y-2">
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Mode d'affichage</div>
                <div className="bg-white/5 p-3 rounded-lg">
                  {children}
                </div>
              </div>
            )}

            {/* UNDO / REDO */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Historique</div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => { onUndo?.(); setIsMobileMenuOpen(false); }} disabled={!canUndo} className={`px-4 py-3 rounded-lg font-black transition-all ${canUndo ? 'bg-white/10 text-white' : 'bg-white/5 text-slate-600 opacity-50'}`}>
                  <i className="fas fa-undo mr-2"></i>Annuler
                </button>
                <button onClick={() => { onRedo?.(); setIsMobileMenuOpen(false); }} disabled={!canRedo} className={`px-4 py-3 rounded-lg font-black transition-all ${canRedo ? 'bg-white/10 text-white' : 'bg-white/5 text-slate-600 opacity-50'}`}>
                  <i className="fas fa-redo mr-2"></i>Refaire
                </button>
              </div>
            </div>

            {/* FILE ACTIONS */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Fichiers</div>
              <div className="space-y-2">
                <button onClick={() => { onOpenLoadMenu?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-amber-500/10 text-amber-400 font-black transition-all flex items-center justify-center space-x-2">
                  <i className="fas fa-folder-open"></i>
                  <span>Ouvrir un projet</span>
                </button>
                <button onClick={() => { onOpenSaveMenu?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-green-500/10 text-green-400 font-black transition-all flex items-center justify-center space-x-2">
                  <i className="fas fa-save"></i>
                  <span>Sauvegarder</span>
                </button>
                {user && (
                  <button onClick={() => { onShareProject?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-blue-500/10 text-blue-400 font-black transition-all flex items-center justify-center space-x-2">
                    <i className="fas fa-share-alt"></i>
                    <span>Partager</span>
                  </button>
                )}
                <button onClick={() => { onExportMix?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-purple-500/10 text-purple-400 font-black transition-all flex items-center justify-center space-x-2">
                  <i className="fas fa-compact-disc"></i>
                  <span>Exporter</span>
                </button>
              </div>
            </div>

            {/* SETTINGS */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Paramètres</div>
              <div className="space-y-2">
                <button onClick={() => { onOpenAudioEngine?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-orange-500/10 text-orange-400 font-black transition-all flex items-center justify-center space-x-2">
                  <i className="fas fa-microchip"></i>
                  <span>Moteur Audio (Engine)</span>
                </button>
                <button onClick={() => { onToggleDelayComp?.(); setIsMobileMenuOpen(false); }} className={`w-full px-4 py-3 rounded-lg font-black transition-all flex items-center justify-center space-x-2 ${isDelayCompEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-400'}`}>
                  <div className={`w-2 h-2 rounded-full ${isDelayCompEnabled ? 'bg-cyan-400' : 'bg-slate-600'}`}></div>
                  <span>Delay Compensation (PDC)</span>
                </button>
                <button onClick={() => { onToggleTheme?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-white/5 text-white font-black transition-all flex items-center justify-center space-x-2">
                  <i className={`fas ${currentTheme === 'dark' ? 'fa-sun' : 'fa-moon'}`}></i>
                  <span>Changer le thème</span>
                </button>
                <button onClick={() => { onToggleSidebar?.(); setIsMobileMenuOpen(false); }} className={`w-full px-4 py-3 rounded-lg font-black transition-all flex items-center justify-center space-x-2 ${isSidebarOpen ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-columns"></i>
                  <span>{isSidebarOpen ? 'Masquer' : 'Afficher'} le navigateur</span>
                </button>
              </div>
            </div>

            {/* BPM CONTROL */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Tempo (BPM)</div>
              <div className="bg-white/5 p-4 rounded-lg flex items-center justify-center space-x-3">
                <button onClick={() => onBpmChange(Math.max(20, bpm - 1))} className="w-10 h-10 rounded-lg bg-white/10 text-white font-bold">-</button>
                {isEditingBpm ? (
                  <input
                    ref={bpmInputRef}
                    type="text"
                    value={tempBpm}
                    onChange={(e) => setTempBpm(e.target.value.replace(/[^0-9.]/g, ''))}
                    onBlur={() => { setIsEditingBpm(false); onBpmChange(parseFloat(tempBpm) || 120); }}
                    onKeyDown={(e) => e.key === 'Enter' && bpmInputRef.current?.blur()}
                    className="w-20 bg-white/10 border border-cyan-500/50 rounded text-center text-2xl font-black text-white outline-none"
                  />
                ) : (
                  <div onClick={() => setIsEditingBpm(true)} className="text-3xl font-black text-cyan-400 cursor-pointer">{bpm}</div>
                )}
                <button onClick={() => onBpmChange(Math.min(999, bpm + 1))} className="w-10 h-10 rounded-lg bg-white/10 text-white font-bold">+</button>
              </div>
            </div>

            {/* USER SECTION */}
            <div className="space-y-2 border-t border-white/10 pt-3">
              {user ? (
                <div className="flex items-center justify-between bg-white/5 p-4 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-sm font-black text-white">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-black text-white">{user.username}</div>
                      <div className="text-xs text-slate-500">{user.email}</div>
                    </div>
                  </div>
                  <button onClick={() => { onLogout?.(); setIsMobileMenuOpen(false); }} className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 font-black">
                    <i className="fas fa-sign-out-alt mr-2"></i>Déconnexion
                  </button>
                </div>
              ) : (
                <button onClick={() => { onOpenAuth?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-cyan-500/10 text-cyan-400 font-black transition-all flex items-center justify-center space-x-2">
                  <i className="fas fa-user-circle"></i>
                  <span>Se connecter</span>
                </button>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
};

export default TransportBar;
