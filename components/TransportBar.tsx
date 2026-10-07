import React, { useState, useRef, useEffect, PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import { ViewType, Theme, User } from '../types';
import ProMasterMeter from './ProMasterMeter';
import MasterVisualizer from './MasterVisualizer';
import { midiManager } from '../services/MidiManager';
import { playheadStore } from '../utils/playheadStore';
import { formatMesures, nomTonaliteCourt } from '../utils/musicKey';
import { useSimpleMode, simpleModeStore } from '../utils/simpleMode';
import SimpleModeToggle from './SimpleModeToggle';
import PunchControls from './PunchControls';
import { PunchSettings } from '../types';

interface TransportProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  isRecording: boolean;
  onToggleRecord: () => void;
  isLoopActive: boolean;
  onToggleLoop: () => void;
  isPunchActive?: boolean;
  onTogglePunch?: () => void;
  /** Réglages du punch (pré/post-roll, QuickPunch) : components/PunchControls. */
  punch?: PunchSettings;
  onUpdatePunch?: (patch: Partial<PunchSettings>) => void;
  onToggleQuickPunch?: () => void;
  isMetronomeEnabled?: boolean;
  onToggleMetronome?: () => void;
  bpm: number;
  onBpmChange: (newBpm: number) => void;
  /** Signature (horloge en mesures). 4/4 par défaut. */
  timeSignature?: { numerator: number; denominator: number };
  /** Tonalité du projet (0 = Do … 11 = Si) et gamme ('MINOR', 'MAJOR'…), si connues. */
  projectKey?: number;
  projectScale?: string;
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
  /** Menu mobile : collaboration et session en ligne (plus de boutons flottants). */
  onOpenCollab?: () => void;
  collabLabel?: string;
  onOpenTakeHome?: () => void;
  takeHomeLabel?: string;
  
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
  /** Mise en page téléphone (onglets) : les vues et le navigateur latéral n'y existent pas. */
  isMobileLayout?: boolean;

  // Import Audio (nouveau système)
  onImportAudio?: (file: File) => void;
}

/** Voyant de surcharge : s'allume 4 s quand le moteur prend du retard. */
const OverloadBadge: React.FC = () => {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const hit = () => { setOn(true); if (t) clearTimeout(t); t = setTimeout(() => setOn(false), 4000); };
    window.addEventListener('nova:overload', hit);
    return () => { window.removeEventListener('nova:overload', hit); if (t) clearTimeout(t); };
  }, []);
  if (!on) return null;
  return (
    <span role="status" title="L'ordinateur n'arrive plus à suivre : ferme d'autres onglets ou gèle les pistes chargées en effets." className="hidden md:inline-flex h-6 items-center rounded-md bg-amber-500/20 px-2 text-[9px] font-black text-amber-300 border border-amber-500/40 animate-pulse">
      ⚠ SURCHARGE
    </span>
  );
};

const formatClock = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const cents = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${cents.toString().padStart(2, '0')}`;
};

type ClockMode = 'TIME' | 'BARS';
const CLOCK_MODE_KEY = 'nova_clock_mode';
const lireModeHorloge = (): ClockMode => {
  try { return localStorage.getItem(CLOCK_MODE_KEY) === 'BARS' ? 'BARS' : 'TIME'; } catch { return 'TIME'; }
};

/**
 * Horloge abonnée à la tête de lecture. Le texte est écrit directement dans le
 * DOM (au centième, seulement quand il change) : aucun rendu React pendant la
 * lecture, ni de la barre de transport ni du reste du studio.
 * Clic : bascule minutes:secondes ⇄ mesures | temps | ticks (mémorisé).
 */
const PlayheadClock: React.FC<{ bpm: number; numerator: number; denominator: number; compact?: boolean }> = ({ bpm, numerator, denominator, compact = false }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<ClockMode>(lireModeHorloge);
  const format = (t: number) => mode === 'BARS' ? formatMesures(t + 1e-6, bpm, numerator, denominator) : formatClock(t + 1e-6);
  useEffect(() => {
    let last = '';
    const update = () => {
      const txt = format(playheadStore.get());
      if (txt !== last && ref.current) { ref.current.textContent = txt; last = txt; }
    };
    update();
    return playheadStore.subscribe(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bpm, numerator, denominator]);
  const toggle = () => setMode(m => {
    const next: ClockMode = m === 'TIME' ? 'BARS' : 'TIME';
    try { localStorage.setItem(CLOCK_MODE_KEY, next); } catch { /* stockage indisponible */ }
    return next;
  });
  return (
    <button
      type="button"
      onClick={toggle}
      data-nova-target="clock"
      title={mode === 'BARS' ? 'Mesures | temps | ticks (960 par temps). Clic : afficher en minutes:secondes' : 'Minutes:secondes. Clic : afficher en mesures | temps | ticks'}
      aria-label={mode === 'BARS' ? 'Position en mesures, temps et ticks. Cliquer pour afficher le temps' : 'Position en minutes et secondes. Cliquer pour afficher les mesures'}
      className="flex flex-col items-center min-w-[60px] md:min-w-[96px] min-h-[40px] justify-center px-1 rounded-lg hover:bg-white/5 transition-colors"
    >
      {!compact && (
        <span className="hidden md:block text-[7px] font-black uppercase tracking-[0.3em] hide-on-tablet-text" style={{ color: 'var(--text-secondary)' }}>
          {mode === 'BARS' ? 'Mesure' : 'Position'}
        </span>
      )}
      <span ref={ref} className="mono nova-chiffres text-[11px] md:text-[14px] font-bold text-center whitespace-pre" style={{ color: 'var(--accent-neon)' }}>{format(playheadStore.get())}</span>
    </button>
  );
};

/** Tonalité + signature, compactes, à côté du tempo (connues quand le beat vient du catalogue). */
const KeyBadge: React.FC<{ projectKey?: number; projectScale?: string; numerator: number; denominator: number }> = ({ projectKey, projectScale, numerator, denominator }) => {
  const nom = nomTonaliteCourt(projectKey, projectScale);
  const court = nomTonaliteCourt(projectKey, projectScale, true);
  return (
    <div className="hidden lg:flex flex-col items-end leading-tight" title={nom ? `Tonalité du projet : ${nom} · signature ${numerator}/${denominator}` : `Signature ${numerator}/${denominator}`}>
      {nom ? (
        <span className="text-[10px] font-black whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
          <span className="hidden 2xl:inline">{nom}</span><span className="2xl:hidden">{court}</span>
        </span>
      ) : null}
      <span className="text-[8px] font-bold text-slate-500 mono nova-chiffres">{numerator}/{denominator}</span>
    </div>
  );
};

const TransportBar: React.FC<PropsWithChildren<TransportProps>> = ({
  isPlaying, onTogglePlay, onStop, isRecording, onToggleRecord, isLoopActive, onToggleLoop, isPunchActive = false, onTogglePunch,
  punch, onUpdatePunch, onToggleQuickPunch,
  isMetronomeEnabled = false, onToggleMetronome, bpm, onBpmChange, currentTime,
  timeSignature, projectKey, projectScale,
  currentView, onChangeView, noArmedTrackError, statusMessage, currentTheme, onToggleTheme,
  onOpenSaveMenu, onOpenLoadMenu, onOpenCollab, collabLabel, onOpenTakeHome, takeHomeLabel, onExportMix, onShareProject, onOpenAudioEngine, isDelayCompEnabled, onToggleDelayComp,
  onUndo, onRedo, canUndo, canRedo,
  user, onOpenAuth, onLogout,
  isSidebarOpen, onToggleSidebar, isMobileLayout = false,
  onImportAudio,
  children
}) => {
  const tsNum = timeSignature?.numerator || 4;
  const tsDen = timeSignature?.denominator || 4;
  const [isEditingBpm, setIsEditingBpm] = useState(false);
  const [tempBpm, setTempBpm] = useState(bpm.toString());
  const [midiActive, setMidiActive] = useState(false);
  const [midiDeviceName, setMidiDeviceName] = useState<string | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const bpmInputRef = useRef<HTMLInputElement>(null);
  const audioImportInputRef = useRef<HTMLInputElement>(null);
  // Mode simple : outils de mixage, routage et import cachés (menu ☰ → Mode avancé).
  const { simple } = useSimpleMode();

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

  // Échap ferme le menu (sans arrêter la lecture au passage).
  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation(); e.preventDefault();
      setIsMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isMobileMenuOpen]);

  return (
    <div className="nova-verre nova-verre-haut h-16 flex items-center px-2 md:px-4 justify-between z-50 relative shrink-0 transition-all border-b" style={{ borderColor: 'var(--border-dim)' }}>
      {noArmedTrackError && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-4 py-3 bg-red-600 text-white
                        text-[12px] font-semibold rounded-xl shadow-2xl z-[100] max-w-sm text-center leading-relaxed">
          <i className="fas fa-microphone-slash mr-2"></i>
          Aucune piste n'est prête à enregistrer.
          <span className="block mt-1 font-normal text-white/85">
            Clique le bouton <b>R</b> d'une piste pour activer ton micro, puis reviens ici.
          </span>
        </div>
      )}

      {/* LEFT CONTROLS */}
      <div className="flex items-center space-x-2">
          {/* MOBILE HAMBURGER MENU BUTTON */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="2xl:hidden w-10 h-10 rounded-lg flex items-center justify-center bg-white/10 border border-white/20 text-white hover:bg-white/20 transition-all"
            title="Menu"
            aria-label={isMobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            aria-expanded={isMobileMenuOpen}
          >
            <i className={`fas ${isMobileMenuOpen ? 'fa-times' : 'fa-bars'} text-lg`}></i>
          </button>

          <div className="hidden xl:flex items-center space-x-2">
            <button 
              onClick={onToggleSidebar} 
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors border ${isSidebarOpen ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
              title={isSidebarOpen ? "Masquer le navigateur" : "Afficher le navigateur"}
              aria-label={isSidebarOpen ? "Masquer le navigateur" : "Afficher le navigateur"}
              aria-pressed={!!isSidebarOpen}
            >
              <i className="fas fa-columns text-xs"></i>
            </button>
            <div className="h-6 w-px bg-white/5" style={{ backgroundColor: 'var(--border-dim)' }}></div>
             <div className="flex items-center space-x-1 pr-2 border-r border-white/5" style={{ borderColor: 'var(--border-dim)' }}>
                <button onClick={onUndo} disabled={!canUndo} title="Annuler (Ctrl+Z)" aria-label="Annuler" className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all border border-white/10 ${canUndo ? 'bg-white/5 hover:bg-cyan-500 hover:text-black' : 'opacity-30 cursor-not-allowed'}`} style={{ color: canUndo ? 'var(--text-primary)' : 'var(--text-secondary)' }}><i className="fas fa-undo text-[10px]"></i></button>
                <button onClick={onRedo} disabled={!canRedo} title="Rétablir (Ctrl+Y)" aria-label="Rétablir" className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all border border-white/10 ${canRedo ? 'bg-white/5 hover:bg-cyan-500 hover:text-black' : 'opacity-30 cursor-not-allowed'}`} style={{ color: canRedo ? 'var(--text-primary)' : 'var(--text-secondary)' }}><i className="fas fa-redo text-[10px]"></i></button>
             </div>
             
             {/* FILE ACTIONS GROUP */}
             <div className="flex items-center space-x-1 pr-2 border-r border-white/5" style={{ borderColor: 'var(--border-dim)' }}>
                {/* OPEN / LOAD */}
                <button onClick={onOpenLoadMenu} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white" title="Ouvrir un projet" aria-label="Ouvrir un projet">
                    <i className="fas fa-folder-open text-[10px]"></i>
                    <span className="hidden min-[2300px]:inline text-[10px] font-bold tracking-wide">Ouvrir</span>
                </button>

                {/* SAVE */}
                <button onClick={onOpenSaveMenu} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white" title="Sauvegarder" aria-label="Sauvegarder">
                    <i className="fas fa-save text-[10px]"></i>
                    <span className="hidden min-[2300px]:inline text-[10px] font-bold tracking-wide">Sauver</span>
                </button>

                {/* ✨ NOUVEAU IMPORT AUDIO */}
                {onImportAudio && !simple && (
                    <>
                        <button
                            onClick={() => audioImportInputRef.current?.click()}
                            className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white"
                            title="Importer un fichier audio"
                            aria-label="Importer un fichier audio"
                        >
                            <i className="fas fa-file-import text-[10px]"></i>
                            <span className="hidden min-[2300px]:inline text-[10px] font-bold tracking-wide">Import</span>
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
                 <button onClick={onShareProject} title="Partager le projet" aria-label="Partager le projet" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white"><i className="fas fa-share-alt text-[10px]"></i><span className="hidden min-[2300px]:inline text-[10px] font-bold tracking-wide">Partager</span></button>
             )}
             
             {/* EXPORT BUTTON */}
             <button onClick={onExportMix} title="Exporter le mix" aria-label="Exporter le mix" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500 hover:text-black"><i className="fas fa-compact-disc text-[10px]"></i><span className="hidden 2xl:inline text-[10px] font-bold tracking-wide">Exporter</span></button>
             
             {/* ENGINE BUTTON */}
             <button onClick={onOpenAudioEngine} title="Réglages audio (carte son, latence)" aria-label="Réglages audio" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white"><i className="fas fa-microchip text-[10px]"></i><span className="hidden min-[2300px]:inline text-[10px] font-bold tracking-wide">Audio</span></button>
             
             {/* PDC Toggle */}
             {!simple && <button onClick={onToggleDelayComp} aria-pressed={!!isDelayCompEnabled} aria-label="Compensation de latence des effets (PDC)" className={`h-8 px-2 rounded-lg flex items-center space-x-1 transition-all border ${isDelayCompEnabled ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`} title="PDC = calage de latence : NOVA retarde les autres pistes pour que les effets lents (VST, autotune) restent pile en rythme. Laisse-le allumé.">
                <div className={`w-1.5 h-1.5 rounded-full ${isDelayCompEnabled ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`}></div>
                <span className="text-[9px] font-black uppercase tracking-wider">PDC</span>
             </button>}

             {/* MIDI INDICATOR */}
             {!simple && <div className={`h-8 px-2 rounded-lg ${midiDeviceName ? 'flex' : 'hidden min-[2300px]:flex'} items-center justify-center space-x-2 border transition-all ${midiActive ? 'bg-green-500 text-black border-green-400 shadow-lg shadow-green-500/30' : 'bg-white/5 border-white/10 text-slate-600'}`} title={midiDeviceName ? `MIDI : ${midiDeviceName}` : "Aucun clavier MIDI détecté"} role="status" aria-label={midiDeviceName ? `Clavier MIDI : ${midiDeviceName}` : "Aucun clavier MIDI détecté"}>
                 <i className="fas fa-plug text-[10px]"></i>
                 {midiDeviceName && <span className="hidden 2xl:inline text-[8px] font-black uppercase max-w-[80px] truncate">{midiDeviceName}</span>}
             </div>}
          </div>
      </div>

      {/* CENTER: TRANSPORT */}
      <div className="flex flex-1 md:flex-none justify-center items-center space-x-2">
        <div className="hidden xl:block"><ProMasterMeter /></div>
        
        <div className="flex items-center space-x-2 md:space-x-3 bg-black/40 px-3 md:px-4 py-1.5 rounded-xl border border-white/5" style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}>
          <button onClick={onStop} title="Stop (Échap)" aria-label="Stop" className="nova-hit w-8 h-8 text-slate-600 hover:text-white transition-colors hide-on-tablet-text" style={{ color: 'var(--text-secondary)' }}><i className="fas fa-stop text-xs"></i></button>
          <button onClick={onTogglePlay} title="Lecture / pause (raccourci : barre d'espace)" aria-label={isPlaying ? 'Pause' : 'Lecture'} aria-pressed={isPlaying} className={`w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-lg ${isPlaying ? 'text-black nova-halo' : 'bg-white text-black hover:scale-105 shadow-black/40'}`} style={{ backgroundColor: isPlaying ? 'var(--accent-neon)' : '#fff' }}><i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-base`}></i></button>
          <button onClick={onToggleLoop} title="Boucle (L)" aria-label="Boucle" aria-pressed={isLoopActive} className={`nova-hit-tactile hidden md:flex w-8 h-8 rounded-lg items-center justify-center transition-all ${isLoopActive ? 'text-cyan-400' : 'text-slate-600 hover:text-white'}`} style={{ backgroundColor: isLoopActive ? 'rgba(0,242,255,0.2)' : 'transparent', color: isLoopActive ? 'var(--accent-neon)' : 'var(--text-secondary)' }}><i className="fas fa-sync-alt text-xs"></i></button>
          <OverloadBadge />
          {onTogglePunch && !simple && (
            <PunchControls punch={punch} bpm={bpm} isPunchActive={isPunchActive} onTogglePunch={onTogglePunch}
              onUpdatePunch={onUpdatePunch} onToggleQuickPunch={onToggleQuickPunch} />
          )}
          <button onClick={onToggleMetronome} title="Métronome" aria-label="Métronome" aria-pressed={isMetronomeEnabled} className={`nova-hit-tactile hidden md:flex w-8 h-8 rounded-lg items-center justify-center transition-all ${isMetronomeEnabled ? 'text-cyan-400' : 'text-slate-600 hover:text-white'}`} style={{ backgroundColor: isMetronomeEnabled ? 'rgba(0,242,255,0.2)' : 'transparent', color: isMetronomeEnabled ? 'var(--accent-neon)' : 'var(--text-secondary)' }}><i className="fas fa-drum text-xs"></i></button>
          <button data-nova-target="rec" onClick={onToggleRecord} title="Enregistrer ta voix : le micro s'active tout seul, décompte puis enregistrement (raccourci : R)" aria-label={isRecording ? "Arrêter l'enregistrement" : 'Enregistrer'} aria-pressed={isRecording} className={`h-12 px-4 2xl:px-6 rounded-xl flex items-center space-x-2 border transition-all ${isRecording ? 'bg-red-600 border-red-400 text-white nova-halo-rouge nova-pouls' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: isRecording ? '#ef4444' : 'var(--border-dim)', borderColor: isRecording ? '#f87171' : 'var(--border-highlight)' }}><div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-white' : 'bg-red-600'}`}></div><span className="hidden md:inline font-black uppercase text-[10px] tracking-widest hide-on-tablet-text">{punch?.quickPunch && !simple ? 'QP' : 'Rec'}</span></button>
        </div>
        
        <PlayheadClock bpm={bpm} numerator={tsNum} denominator={tsDen} />
      </div>

      {/* RIGHT SIDE CONTROLS (espacements serrés : à 1600 px le BPM sortait de l'écran, audit G23) */}
      <div className="flex items-center space-x-2 shrink-0 pr-1">
        
        {/* VISUALIZER (Only on very large screens to save space) */}
        <div className="hidden min-[2200px]:block opacity-80 hover:opacity-100 transition-opacity">
           <MasterVisualizer />
        </div>

        {/* VIEW SWITCHER & THEME - Hidden on mobile/tablet (already in bottom nav) */}
        {simple ? (
          <button type="button" onClick={() => simpleModeStore.setPref(false)} title="Afficher la console, les effets, les VST et l'automation (rien n'est perdu)"
            className="hidden min-[1536px]:flex h-9 items-center gap-2 px-3 rounded-xl border border-white/10 bg-white/5 text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-white hover:bg-white/10">
            <i className="fas fa-sliders-h"></i> Mode avancé
          </button>
        ) : (
        <div className="hidden min-[1536px]:flex items-center space-x-1 bg-black/40 rounded-xl p-1 border border-white/5" style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}>
            <button onClick={() => onChangeView('ARRANGEMENT')} aria-pressed={currentView === 'ARRANGEMENT'} className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${currentView === 'ARRANGEMENT' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'ARRANGEMENT' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'ARRANGEMENT' ? '#000' : 'var(--text-secondary)' }}>Pistes</button>
            <button onClick={() => onChangeView('MIXER')} aria-pressed={currentView === 'MIXER'} className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${currentView === 'MIXER' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'MIXER' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'MIXER' ? '#000' : 'var(--text-secondary)' }}>Console</button>
            <button onClick={() => onChangeView('AUTOMATION')} aria-pressed={currentView === 'AUTOMATION'} className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${currentView === 'AUTOMATION' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'AUTOMATION' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'AUTOMATION' ? '#000' : 'var(--text-secondary)' }}>Auto</button>
        </div>
        )}

        {/* THEME TOGGLE */}
        {/* Sous 768 px, thème / compte / mode sont dans le menu : dans la barre ils
            la faisaient déborder (déconnexion et mode hors de l'écran en 390 px). */}
        <button 
            onClick={onToggleTheme}
            className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 hidden 2xl:flex items-center justify-center transition-all"
            title="Changer le thème"
            aria-label={currentTheme === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre'}
            style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}
        >
            <i className={`fas ${currentTheme === 'dark' ? 'fa-sun text-amber-400' : 'fa-moon text-slate-300'}`}></i>
        </button>

        {/* TONALITÉ + SIGNATURE */}
        <KeyBadge projectKey={projectKey} projectScale={projectScale} numerator={tsNum} denominator={tsDen} />

        {/* BPM CONTROL */}
        <div className="hidden sm:flex flex-col items-end cursor-ns-resize group" onMouseDown={handleBpmMouseDown} title="Tempo : glisser vers le haut ou le bas, double-clic pour saisir">

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
        {/* Invité (pas de compte) : « Connexion », pas d'avatar ni de déconnexion. */}
        {user && user.id !== 'guest' ? (
            <div className="hidden 2xl:flex items-center space-x-2 bg-black/30 rounded-full pl-1 pr-1 py-1 border border-white/10" style={{ backgroundColor: 'var(--bg-item)' }}>
                <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-[10px] font-black text-white shadow-lg shadow-cyan-500/20">{user.username.charAt(0).toUpperCase()}</div>
                <button onClick={onLogout} title="Se déconnecter" aria-label="Se déconnecter" className="w-7 h-7 rounded-full bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center justify-center transition-all"><i className="fas fa-sign-out-alt text-[10px]"></i></button>
            </div>
        ) : (
            <button onClick={onOpenAuth} aria-label="Connexion" className="h-8 px-4 rounded-full bg-white/10 hover:bg-cyan-500 hover:text-black text-white text-[9px] font-black uppercase tracking-widest transition-all border border-white/10 hidden 2xl:flex items-center space-x-2"><i className="fas fa-user-circle"></i></button>
        )}

        {/* View Switcher for mobile/tablet injection from parent */}
        <div className="hidden 2xl:block">{children}</div>
      </div>

      {/* MOBILE DROPDOWN MENU */}
      {/* Rendu dans <body> : dans la barre (empilement z-50) le tiroir passait sous
          les boutons flottants (Piste voix, Collaborer, onglets) et se coupait. */}
      {isMobileMenuOpen && createPortal(<>
        <div className="2xl:hidden fixed inset-x-0 top-16 bottom-0 z-[540] bg-black/50" onClick={() => setIsMobileMenuOpen(false)} aria-hidden="true" />
        <div role="dialog" aria-label="Menu" className="2xl:hidden fixed top-16 left-0 right-0 md:right-auto md:w-[400px] z-[550] max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain bg-[#0a0b0d] border-b md:border-r border-white/10 shadow-2xl" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)', touchAction: 'pan-y' }}>
          <div className="p-4 space-y-3" style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>

            {/* Téléphone : métronome et boucle (masqués dans la barre sous 768 px) */}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => onToggleMetronome?.()} aria-pressed={isMetronomeEnabled} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${isMetronomeEnabled ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300'}`}>
                <i className="fas fa-drum block mb-1"></i>
                Métronome
              </button>
              <button onClick={() => onToggleLoop?.()} aria-pressed={isLoopActive} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${isLoopActive ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300'}`}>
                <i className="fas fa-sync-alt block mb-1"></i>
                Boucle
              </button>
            </div>

            {/* Mode simple / avancé : en haut du menu, facile à retrouver */}
            <SimpleModeToggle onDone={() => setIsMobileMenuOpen(false)} />

            {/* VIEW SWITCHER (inutile en mise en page téléphone : on navigue par onglets) */}
            {!isMobileLayout && !simple && (
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Vues</div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => { onChangeView('ARRANGEMENT'); setIsMobileMenuOpen(false); }} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${currentView === 'ARRANGEMENT' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-grip-horizontal block mb-1"></i>
                  Pistes
                </button>
                <button onClick={() => { onChangeView('MIXER'); setIsMobileMenuOpen(false); }} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${currentView === 'MIXER' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-sliders-h block mb-1"></i>
                  Console
                </button>
                <button onClick={() => { onChangeView('AUTOMATION'); setIsMobileMenuOpen(false); }} className={`px-4 py-3 rounded-lg text-[11px] font-black uppercase transition-all ${currentView === 'AUTOMATION' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-project-diagram block mb-1"></i>
                  Auto
                </button>
              </div>
            </div>
            )}

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
                {onOpenTakeHome && (
                  <button onClick={() => { onOpenTakeHome(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-cyan-500/10 text-cyan-300 font-black transition-all flex items-center justify-center space-x-2">
                    <span>☁️ {takeHomeLabel || 'Emporter la session'}</span>
                  </button>
                )}
                {onOpenCollab && (
                  <button onClick={() => { onOpenCollab(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-violet-500/10 text-violet-200 font-black transition-all flex items-center justify-center space-x-2">
                    <span>👥 {collabLabel || 'Collaborer'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* SETTINGS */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Paramètres</div>
              <div className="space-y-2">
                <button onClick={() => { onOpenAudioEngine?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-orange-500/10 text-orange-400 font-black transition-all flex items-center justify-center space-x-2">
                  <i className="fas fa-microchip"></i>
                  <span>{simple ? 'Réglages audio (micro, latence)' : 'Réglages audio (moteur, latence)'}</span>
                </button>
                {!simple && <button onClick={() => { onToggleDelayComp?.(); setIsMobileMenuOpen(false); }} aria-pressed={!!isDelayCompEnabled} className={`w-full px-4 py-3 rounded-lg font-black transition-all flex items-center justify-center space-x-2 ${isDelayCompEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-400'}`}>
                  <div className={`w-2 h-2 rounded-full ${isDelayCompEnabled ? 'bg-cyan-400' : 'bg-slate-600'}`}></div>
                  <span>Compensation de latence (PDC)</span>
                </button>}
                <button onClick={() => { onToggleTheme?.(); setIsMobileMenuOpen(false); }} className="w-full px-4 py-3 rounded-lg bg-white/5 text-white font-black transition-all flex items-center justify-center space-x-2">
                  <i className={`fas ${currentTheme === 'dark' ? 'fa-sun' : 'fa-moon'}`}></i>
                  <span>Changer le thème</span>
                </button>
                {!isMobileLayout && (
                <button onClick={() => { onToggleSidebar?.(); setIsMobileMenuOpen(false); }} className={`w-full px-4 py-3 rounded-lg font-black transition-all flex items-center justify-center space-x-2 ${isSidebarOpen ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-400'}`}>
                  <i className="fas fa-columns"></i>
                  <span>{isSidebarOpen ? 'Masquer' : 'Afficher'} le navigateur</span>
                </button>
                )}
              </div>
            </div>

            {/* BPM CONTROL */}
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Tempo (BPM)</div>
              <div className="bg-white/5 p-4 rounded-lg flex items-center justify-center space-x-3">
                <button onClick={() => onBpmChange(Math.max(20, bpm - 1))} aria-label="Tempo -1" className="w-10 h-10 rounded-lg bg-white/10 text-white font-bold">-</button>
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
                <button onClick={() => onBpmChange(Math.min(999, bpm + 1))} aria-label="Tempo +1" className="w-10 h-10 rounded-lg bg-white/10 text-white font-bold">+</button>
              </div>
            </div>

            {/* USER SECTION */}
            <div className="space-y-2 border-t border-white/10 pt-3">
              {user && user.id !== 'guest' ? (
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
      </>, document.body)}
    </div>
  );
};

export default TransportBar;
