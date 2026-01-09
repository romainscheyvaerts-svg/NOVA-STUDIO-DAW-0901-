
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
}

const TransportBar: React.FC<PropsWithChildren<TransportProps>> = ({ 
  isPlaying, onTogglePlay, onStop, isRecording, onToggleRecord, isLoopActive, onToggleLoop, bpm, onBpmChange, currentTime, 
  currentView, onChangeView, noArmedTrackError, statusMessage, currentTheme, onToggleTheme, 
  onOpenSaveMenu, onOpenLoadMenu, onExportMix, onShareProject, onOpenAudioEngine, isDelayCompEnabled, onToggleDelayComp,
  onUndo, onRedo, canUndo, canRedo, 
  user, onOpenAuth, onLogout, 
  children
}) => {
  const [isEditingBpm, setIsEditingBpm] = useState(false);
  const [tempBpm, setTempBpm] = useState(bpm.toString());
  const [midiActive, setMidiActive] = useState(false);
  const [midiDeviceName, setMidiDeviceName] = useState<string | null>(null);
  const bpmInputRef = useRef<HTMLInputElement>(null);

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
    <div className="h-16 border-b flex items-center px-2 md:px-4 justify-between z-50 shadow-sm relative shrink-0 transition-all" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}>
      {noArmedTrackError && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-4 py-2 bg-red-600 text-white text-[10px] font-black uppercase rounded-lg shadow-2xl animate-bounce z-[100]">
          <i className="fas fa-exclamation-triangle mr-2"></i> Record Error
        </div>
      )}

      {/* LEFT CONTROLS */}
      <div className="flex items-center space-x-3">
          <div className="hidden md:flex items-center space-x-2">
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
    </div>
  );
};

export default TransportBar;
