import React, { useState, useRef, useEffect, useLayoutEffect, PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import { ViewType, Theme, User } from '../types';
import ProMasterMeter from './ProMasterMeter';
import { LufsChip } from './meters/LoudnessPanel';
import MasterVisualizer from './MasterVisualizer';
import { midiManager } from '../services/MidiManager';
import { openMidiPanel, useComputerKeyboard, useMidiRecPrefs } from './MidiInputHost';
import { computerKeyboardStore } from '../utils/computerKeyboard';
import { MODE_LABELS } from '../utils/midiRecord';
import { playheadStore } from '../utils/playheadStore';
import { formatMesures, nomTonaliteCourt } from '../utils/musicKey';
import { formatBarsBeats } from '../utils/tempoMap';
import { useTempoMap } from './TempoLane';
import GuideControl from './GuideControl';
import { useSimpleMode, simpleModeStore } from '../utils/simpleMode';
import ThemeSwitch from './ThemeSwitch';
import { ChordLaneMenuToggle } from './ChordLane';
import SimpleModeToggle from './SimpleModeToggle';
import PunchControls from './PunchControls';
import { PunchSettings } from '../types';
import { openFeedback } from '../services/feedback';
import { MidiFileMenu, MidiMobileMenuItems } from './MidiFileMenu';
import DspMeter from './DspMeter';
import PracticeSpeed from './PracticeSpeed';
import type { Track } from '../types';
import type { SafetyContext } from '../utils/dspLoad';
import { fitBar, barItem } from '../utils/barFit';

interface TransportProps {
  /** Ouvre « Master Nova » (mastering en un clic, V15). */
  onOpenMasterNova?: () => void;
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
  /** R2 : fenêtre du métronome et du décompte, fenêtre Tempo et mesure, tap tempo. */
  onOpenMetronome?: () => void;
  onOpenTempo?: () => void;
  onTap?: () => void;
  /** Tempo tapé en cours (affiché à côté du bouton TAP). */
  tapBpm?: number | null;
  /** R3 : pistes guides (coupées d'un geste, niveau à part) et capture après coup. */
  guide?: { count: number; muted: boolean; level: number };
  onToggleGuide?: () => void;
  onGuideLevel?: (v: number) => void;
  onCapture?: () => void;
  /** Une piste est armée : la capture après coup écoute le micro pendant la lecture. */
  captureReady?: boolean;
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

  /** Compteur CPU / DSP (engine/dspMonitor) : pistes de la session, gel, garde-fous du mode sécurité. */
  dspTracks?: Track[];
  onDspFreezeTrack?: (trackId: string) => void;
  dspSafety?: SafetyContext;
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
  // Piste tempo (R2) : mesures | temps | ticks d'après la carte (changements de tempo et de mesure).
  const map = useTempoMap();
  const useMap = Math.abs(map.segments[0].bpm - bpm) < 1e-6;
  const format = (t: number) => mode === 'BARS' ? (useMap ? formatBarsBeats(map, t) : formatMesures(t + 1e-6, bpm, numerator, denominator)) : formatClock(t + 1e-6);
  useEffect(() => {
    let last = '';
    const update = () => {
      const txt = format(playheadStore.get());
      if (txt !== last && ref.current) { ref.current.textContent = txt; last = txt; }
    };
    update();
    return playheadStore.subscribe(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bpm, numerator, denominator, map]);
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
        <span className="hidden md:block text-[8px] font-bold uppercase tracking-[0.25em] hide-on-tablet-text" style={{ color: 'var(--text-secondary)' }}>
          {mode === 'BARS' ? 'Mesure' : 'Position'}
        </span>
      )}
      <span ref={ref} className="mono nova-chiffres text-[11px] md:text-[14px] font-bold text-center whitespace-pre" style={{ color: 'var(--accent-text)' }}>{format(playheadStore.get())}</span>
    </button>
  );
};

/** Tonalité + signature, compactes, à côté du tempo (connues quand le beat vient du catalogue). */
const KeyBadge: React.FC<{ projectKey?: number; projectScale?: string; numerator: number; denominator: number; onClick?: () => void }> = ({ projectKey, projectScale, numerator, denominator, onClick }) => {
  const nom = nomTonaliteCourt(projectKey, projectScale);
  const court = nomTonaliteCourt(projectKey, projectScale, true);
  return (
    <button type="button" onClick={onClick} data-testid="open-tempo" className="hidden lg:flex shrink-0 flex-col items-end leading-tight rounded-md px-1 hover:bg-white/5" title={`${nom ? `Tonalité du projet : ${nom} · ` : ''}mesure ${numerator}/${denominator}. Clic : Tempo et mesure (3/4, 6/8, 7/8, changements dans le morceau, tap tempo T) — Pro Tools : Tempo / Meter.`}>
      {nom ? (
        <span className="text-[10px] font-black whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
          <span className="hidden 2xl:inline">{nom}</span><span className="2xl:hidden">{court}</span>
        </span>
      ) : null}
      <span className="text-[8px] font-bold text-slate-500 mono nova-chiffres">{numerator}/{denominator}</span>
    </button>
  );
};

const TransportBar: React.FC<PropsWithChildren<TransportProps>> = ({
  isPlaying, onTogglePlay, onStop, isRecording, onToggleRecord, isLoopActive, onToggleLoop, isPunchActive = false, onTogglePunch,
  punch, onUpdatePunch, onToggleQuickPunch,
  isMetronomeEnabled = false, onToggleMetronome, onOpenMetronome, onOpenTempo, onTap, tapBpm, guide, onToggleGuide, onGuideLevel, onCapture, captureReady, bpm, onBpmChange, currentTime,
  timeSignature, projectKey, projectScale,
  currentView, onChangeView, noArmedTrackError, statusMessage, currentTheme, onToggleTheme,
  onOpenSaveMenu, onOpenLoadMenu, onOpenCollab, collabLabel, onOpenTakeHome, takeHomeLabel, onExportMix, onOpenMasterNova, onShareProject, onOpenAudioEngine, isDelayCompEnabled, onToggleDelayComp,
  onUndo, onRedo, canUndo, canRedo,
  user, onOpenAuth, onLogout,
  isSidebarOpen, onToggleSidebar, isMobileLayout = false,
  onImportAudio,
  dspTracks, onDspFreezeTrack, dspSafety,
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

  useComputerKeyboard();
  const kbOn = computerKeyboardStore.on;
  const midiPrefs = useMidiRecPrefs();
  useEffect(() => midiManager.onDevicesChange(() => setMidiDeviceName(midiManager.getActiveDeviceName())), []);
  // Repli selon la place RÉELLE (utils/barFit) : à chaque changement de taille de la barre
  // ou d'un de ses groupes (fenêtre, CAPTURER qui apparaît, TAP 128…), les éléments
  // secondaires se replient dans le menu ☰ ; les essentiels restent. Avant, des seuils
  // figés laissaient le BPM et le bouton Tempo sortir de l'écran (1600 px, 1920 px).
  const barRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<string[]>([]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      const f = fitBar(bar);
      setFolded(prev => (prev.join('|') === f.join('|') ? prev : f));
    };
    run();
    if (typeof ResizeObserver === 'undefined') return;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
    const ro = new ResizeObserver(schedule);
    ro.observe(bar);
    Array.from(bar.children).forEach(c => ro.observe(c));
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);
  // Infobulle du menu : ce qui y a été replié, en clair.
  const FOLD_LABELS: Record<string, string> = {
    navigateur: 'navigateur', historique: 'annuler / rétablir', ouvrir: 'ouvrir', sauver: 'sauvegarder', import: 'importer',
    'midi-fichiers': 'MIDI', partager: 'partager', master: 'Master Nova', exporter: 'exporter', audio: 'réglages audio',
    pdc: 'PDC', punch: 'punch', guide: 'guide', capturer: 'capturer', 'metronome-reglages': 'clic et décompte', tap: 'tap tempo',
    vues: simple ? 'mode avancé' : 'vues', feedback: 'signaler un bug', theme: 'thème', compte: 'compte', affichage: "mode d'affichage", 'midi-clavier': 'MIDI', 'midi-absent': 'MIDI',
  };
  const foldedNames = folded.map(f => FOLD_LABELS[f]).filter(Boolean);

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
      // Champ prérempli avec le tempo ACTUEL : il gardait celui de l'ouverture du studio (120), et le
      // quitter sans rien taper remettait le morceau à 120 BPM (mélodie à 94 → 120).
      // preventDefault : sinon ce même appui (sur un bloc non focalisable) retirait aussitôt le focus
      // du champ qui venait de s'ouvrir, et il se refermait : « double-clic pour saisir » ne marchait pas.
      e.preventDefault();
      setTempBpm(String(bpm)); setIsEditingBpm(true);
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
    <div ref={barRef} data-testid="transport-bar" className="nova-verre nova-verre-haut h-16 flex items-center gap-2 px-2 md:px-4 justify-between z-50 relative shrink-0 transition-all border-b" style={{ borderColor: 'var(--border-dim)' }}>
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
      <div className="flex items-center space-x-2 shrink-0">
          {/* MENU ☰ : toujours là sous 1536 px, et dès qu'un élément de la barre y est replié */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            data-testid="transport-menu"
            className="nova-bar-menu 2xl:hidden w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-white/[0.06] text-white hover:bg-white/10 transition-all"
            title={foldedNames.length ? `Menu (aussi : ${foldedNames.join(', ')})` : 'Menu'}
            aria-label={isMobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            aria-expanded={isMobileMenuOpen}
          >
            <i className={`fas ${isMobileMenuOpen ? 'fa-times' : 'fa-bars'} text-lg`}></i>
          </button>

          <div className="hidden md:flex items-center space-x-2">
            <button {...barItem('navigateur', 22)}
              onClick={onToggleSidebar} 
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors border ${isSidebarOpen ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
              title={isSidebarOpen ? "Masquer le navigateur" : "Afficher le navigateur"}
              aria-label={isSidebarOpen ? "Masquer le navigateur" : "Afficher le navigateur"}
              aria-pressed={!!isSidebarOpen}
            >
              <i className="fas fa-columns text-xs"></i>
            </button>
             <div {...barItem('historique', 25)} className="flex items-center space-x-1 pr-1">
                <button onClick={onUndo} disabled={!canUndo} title="Annuler (Ctrl+Z)" aria-label="Annuler" className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${canUndo ? 'bg-white/[0.05] hover:bg-white/10' : 'opacity-30 cursor-not-allowed'}`} style={{ color: canUndo ? 'var(--text-primary)' : 'var(--text-secondary)' }}><i className="fas fa-undo text-[10px]"></i></button>
                <button onClick={onRedo} disabled={!canRedo} title="Rétablir (Ctrl+Y)" aria-label="Rétablir" className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${canRedo ? 'bg-white/[0.05] hover:bg-white/10' : 'opacity-30 cursor-not-allowed'}`} style={{ color: canRedo ? 'var(--text-primary)' : 'var(--text-secondary)' }}><i className="fas fa-redo text-[10px]"></i></button>
             </div>
             
             {/* FILE ACTIONS GROUP */}
             <div className="flex items-center space-x-1 pr-1">
                {/* OPEN / LOAD */}
                <button {...barItem('ouvrir', 16)} onClick={onOpenLoadMenu} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-white" title="Ouvrir un projet" aria-label="Ouvrir un projet">
                    <i className="fas fa-folder-open text-[10px]"></i>
                    <span {...barItem('libelle-ouvrir', 2)} className="text-[10px] font-bold tracking-wide">Ouvrir</span>
                </button>

                {/* SAVE */}
                <button {...barItem('sauver', 17)} onClick={onOpenSaveMenu} className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-white" title="Sauvegarder" aria-label="Sauvegarder">
                    <i className="fas fa-save text-[10px]"></i>
                    <span {...barItem('libelle-sauver', 2)} className="text-[10px] font-bold tracking-wide">Sauver</span>
                </button>

                {/* ✨ NOUVEAU IMPORT AUDIO */}
                {onImportAudio && !simple && (
                    <>
                        <button {...barItem('import', 18)}
                            onClick={() => audioImportInputRef.current?.click()}
                            className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-white"
                            title="Importer un fichier audio"
                            aria-label="Importer un fichier audio"
                        >
                            <i className="fas fa-file-import text-[10px]"></i>
                            <span {...barItem('libelle-import', 2)} className="text-[10px] font-bold tracking-wide">Import</span>
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
                {/* Fichiers .mid et Capture MIDI (V25) */}
                {!simple && <div {...barItem('midi-fichiers', 19)} className="flex"><MidiFileMenu /></div>}
             </div>
             
             {/* SHARE (Only if logged in) */}
             {user && (
                 <button {...barItem('partager', 15)} onClick={onShareProject} title="Partager le projet" aria-label="Partager le projet" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-white"><i className="fas fa-share-alt text-[10px]"></i><span {...barItem('libelle-partager', 2)} className="text-[10px] font-bold tracking-wide">Partager</span></button>
             )}
             
             {/* MASTER NOVA (V15) */}
             {onOpenMasterNova && <button {...barItem('master', 24)} onClick={onOpenMasterNova} data-nova-open-master="" title="Master Nova : mastering en un clic pour Spotify, Apple Music, YouTube… (comme le Mastering Assistant de Logic)" aria-label="Master Nova" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400 hover:text-black"><i className="fas fa-crown text-[10px]"></i><span {...barItem('libelle-master', 4)} className="text-[10px] font-bold tracking-wide">Master</span></button>}

             {/* EXPORT BUTTON */}
             <button {...barItem('exporter', 28)} onClick={onExportMix} title="Exporter le mix" aria-label="Exporter le mix" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500 hover:text-black"><i className="fas fa-compact-disc text-[10px]"></i><span {...barItem('libelle-exporter', 4)} className="text-[10px] font-bold tracking-wide">Exporter</span></button>
             
             {/* ENGINE BUTTON */}
             <button {...barItem('audio', 14)} onClick={onOpenAudioEngine} title="Réglages audio (carte son, latence)" aria-label="Réglages audio" className="h-8 px-3 rounded-lg flex items-center space-x-2 transition-all bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-white"><i className="fas fa-microchip text-[10px]"></i><span {...barItem('libelle-audio', 2)} className="text-[10px] font-bold tracking-wide">Audio</span></button>
             
             {/* PDC Toggle */}
             {!simple && <button {...barItem('pdc', 20)} onClick={onToggleDelayComp} aria-pressed={!!isDelayCompEnabled} aria-label="Compensation de latence des effets (PDC)" className={`h-8 px-2 rounded-lg flex items-center space-x-1 transition-all border ${isDelayCompEnabled ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`} title="PDC = calage de latence : NOVA retarde les autres pistes pour que les effets lents (VST, autotune) restent pile en rythme. Laisse-le allumé.">
                <div className={`w-1.5 h-1.5 rounded-full ${isDelayCompEnabled ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`}></div>
                <span className="text-[9px] font-black uppercase tracking-wider">PDC</span>
             </button>}

             {/* MIDI (R16) : clavier branché, clavier de l'ordinateur, mode de prise, MIDI Learn */}
             <button type="button" data-nova-midi-button="" onClick={openMidiPanel} {...barItem(midiDeviceName ? 'midi-clavier' : 'midi-absent', midiDeviceName ? 21 : 3)}
               className={`h-8 px-2 rounded-lg flex items-center justify-center gap-1.5 border transition-all ${midiActive ? 'bg-green-500 text-black border-green-400 shadow-lg shadow-green-500/30' : kbOn ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}
               title={`MIDI : ${midiDeviceName ? `clavier « ${midiDeviceName} »` : 'aucun clavier MIDI détecté'}${kbOn ? ' · clavier de l’ordinateur actif (Ctrl+Maj+K)' : ''} · prise ${MODE_LABELS[midiPrefs.mode].label.toLowerCase()}. Clic : réglages MIDI, MIDI Learn.`}
               aria-label={midiDeviceName ? `MIDI : clavier ${midiDeviceName}` : 'Réglages MIDI'}>
                 <i className={`fas ${kbOn ? 'fa-keyboard' : 'fa-plug'} text-[10px]`}></i>
                 <span className="text-[9px] font-black uppercase tracking-wider">MIDI</span>
                 {midiDeviceName && <span {...barItem('libelle-midi', 2)} className="text-[8px] font-black uppercase max-w-[80px] truncate">{midiDeviceName}</span>}
             </button>
          </div>
      </div>

      {/* CENTER: TRANSPORT */}
      <div className="flex flex-1 md:flex-none md:shrink-0 justify-center items-center space-x-2">
        <div {...barItem('vumetre', 6)} className="hidden md:block"><ProMasterMeter /></div>
        {/* LUFS du master en direct (R11) : ouvre la fenêtre Loudness. */}
        <div className="hidden lg:block"><LufsChip /></div>
        
        <div className="flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-1.5 rounded-2xl" style={{ backgroundColor: 'var(--bg-item)' }}>
          <button onClick={onStop} title="Stop (Échap)" aria-label="Stop" className="nova-hit w-8 h-8 text-slate-600 hover:text-white transition-colors hide-on-tablet-text" style={{ color: 'var(--text-secondary)' }}><i className="fas fa-stop text-xs"></i></button>
          <button onClick={onTogglePlay} title="Lecture / pause (raccourci : barre d'espace)" aria-label={isPlaying ? 'Pause' : 'Lecture'} aria-pressed={isPlaying} className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-150 ${isPlaying ? 'text-black nova-halo' : 'bg-white text-black hover:scale-105 shadow-md shadow-black/30'}`} style={isPlaying ? { backgroundColor: 'var(--accent-neon)' } : undefined}><i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-base`}></i></button>
          <button onClick={onToggleLoop} title="Boucle (L)" aria-label="Boucle" aria-pressed={isLoopActive} className={`nova-hit-tactile hidden md:flex w-8 h-8 rounded-lg items-center justify-center transition-all ${isLoopActive ? 'text-cyan-400' : 'text-slate-600 hover:text-white'}`} style={{ backgroundColor: isLoopActive ? 'rgba(0,242,255,0.2)' : 'transparent', color: isLoopActive ? 'var(--accent-text)' : 'var(--text-secondary)' }}><i className="fas fa-sync-alt text-xs"></i></button>
          {/* Lecture ralentie (R13) : 50 à 100 %, hauteur gardée. */}
          <PracticeSpeed className="hidden md:block" />
          {dspTracks ? <DspMeter tracks={dspTracks} onFreezeTrack={onDspFreezeTrack} safety={dspSafety || { isRecording, bridgeConnected: false }} compact={isMobileLayout} /> : <OverloadBadge />}
          {onTogglePunch && !simple && (
            <PunchControls foldPrio={27} punch={punch} bpm={bpm} isPunchActive={isPunchActive} onTogglePunch={onTogglePunch}
              onUpdatePunch={onUpdatePunch} onToggleQuickPunch={onToggleQuickPunch} />
          )}
          <button onClick={onToggleMetronome} onContextMenu={e => { if (onOpenMetronome) { e.preventDefault(); onOpenMetronome(); } }} title="Métronome (pavé 7). Clic droit ou ▾ : son, volume, accent, décompte (Pro Tools : Click/Countoff Options)" aria-label="Métronome" aria-pressed={isMetronomeEnabled} className={`nova-hit-tactile hidden md:flex w-8 h-8 rounded-lg items-center justify-center transition-all ${isMetronomeEnabled ? 'text-cyan-400' : 'text-slate-600 hover:text-white'}`} style={{ backgroundColor: isMetronomeEnabled ? 'rgba(0,242,255,0.2)' : 'transparent', color: isMetronomeEnabled ? 'var(--accent-text)' : 'var(--text-secondary)' }}><i className="fas fa-drum text-xs"></i></button>
          {onOpenMetronome && (
            <button {...barItem('metronome-reglages', 30)} type="button" onClick={onOpenMetronome} data-testid="open-metronome" aria-label="Réglages du métronome et du décompte"
              title="Clic et décompte : son, volume, accent, prise seulement, sortie, décompte en mesures ou en temps, pré-roll (Pro Tools : Click/Countoff Options)"
              className="nova-hit-tactile hidden md:flex h-8 w-4 -ml-1.5 rounded-md items-center justify-center text-slate-500 hover:text-white">
              <i className="fas fa-caret-down text-[10px]" aria-hidden="true"></i>
            </button>
          )}
          {guide && guide.count > 0 && onToggleGuide && onGuideLevel && (
            <div {...barItem('guide', 29)} className="hidden md:flex"><GuideControl count={guide.count} muted={guide.muted} level={guide.level} onToggle={onToggleGuide} onLevel={onGuideLevel} /></div>
          )}
          {onCapture && captureReady && !isRecording && (
            <button {...barItem('capturer', 32)} type="button" onClick={onCapture} data-testid="capture-take"
              title="Capturer la dernière prise (Maj+R) : ce que tu viens de chanter pendant la lecture, sans avoir appuyé sur REC, posé au bon endroit (Logic : Capture as Recording / Flashback Capture)."
              aria-label="Capturer la dernière prise"
              className="nova-hit-tactile hidden md:flex h-8 px-2 rounded-lg items-center text-[9px] font-black tracking-wider border border-amber-500/40 text-amber-300 hover:bg-amber-500/15">
              <i className="fas fa-history" aria-hidden="true"></i><span {...barItem('libelle-capturer', 9)} className="ml-1">CAPTURER</span>
            </button>
          )}
          <button data-nova-target="rec" onClick={onToggleRecord} title="Enregistrer ta voix : le micro s'active tout seul, décompte puis enregistrement (raccourci : R)" aria-label={isRecording ? "Arrêter l'enregistrement" : 'Enregistrer'} aria-pressed={isRecording} className={`h-12 px-4 2xl:px-6 rounded-xl flex items-center space-x-2 border transition-all ${isRecording ? 'bg-red-600 border-red-400 text-white nova-halo-rouge nova-pouls' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: isRecording ? '#ef4444' : 'var(--border-dim)', borderColor: isRecording ? '#f87171' : 'transparent' }}><div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-white' : 'bg-red-600'}`}></div><span className="hidden md:inline font-black uppercase text-[10px] tracking-widest hide-on-tablet-text">{punch?.quickPunch && !simple ? 'QP' : 'Rec'}</span></button>
        </div>
        
        <PlayheadClock bpm={bpm} numerator={tsNum} denominator={tsDen} />
      </div>

      {/* RIGHT SIDE CONTROLS (espacements serrés : à 1600 px le BPM sortait de l'écran, audit G23) */}
      <div className="flex items-center space-x-2 shrink-0 pr-1">
        
        {/* VISUALIZER : le premier replié quand la place manque */}
        <div {...barItem('visualiseur', 1)} className="hidden md:block opacity-80 hover:opacity-100 transition-opacity">
           <MasterVisualizer />
        </div>

        {/* VIEW SWITCHER & THEME - Hidden on mobile/tablet (already in bottom nav) */}
        {simple ? (
          <button {...barItem('vues', 26)} type="button" onClick={() => simpleModeStore.setPref(false)} title="Afficher la console, les effets, les VST et l'automation (rien n'est perdu)"
            className="hidden md:flex shrink-0 whitespace-nowrap h-9 items-center gap-2 px-3 rounded-xl border border-white/10 bg-white/5 text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-white hover:bg-white/10">
            <i className="fas fa-sliders-h"></i> Mode avancé
          </button>
        ) : (
        <div {...barItem('vues', 26)} className="hidden md:flex items-center space-x-1 rounded-xl p-1" style={{ backgroundColor: 'var(--bg-item)' }}>
            <button onClick={() => onChangeView('ARRANGEMENT')} aria-pressed={currentView === 'ARRANGEMENT'} className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${currentView === 'ARRANGEMENT' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'ARRANGEMENT' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'ARRANGEMENT' ? '#000' : 'var(--text-secondary)' }}>Pistes</button>
            <button onClick={() => onChangeView('MIXER')} aria-pressed={currentView === 'MIXER'} className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${currentView === 'MIXER' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'MIXER' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'MIXER' ? '#000' : 'var(--text-secondary)' }}>Console</button>
            <button onClick={() => onChangeView('AUTOMATION')} aria-pressed={currentView === 'AUTOMATION'} className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${currentView === 'AUTOMATION' ? 'bg-[#00f2ff] text-black' : 'text-slate-500 hover:text-white'}`} style={{ backgroundColor: currentView === 'AUTOMATION' ? 'var(--accent-neon)' : 'transparent', color: currentView === 'AUTOMATION' ? '#000' : 'var(--text-secondary)' }}>Auto</button>
        </div>
        )}

        {/* SIGNALER UN BUG / UNE IDÉE : discret, toujours là (Ctrl+Maj+B) */}
        <button
            type="button"
            onClick={() => openFeedback()}
            data-nova-action="feedback"
            {...barItem('feedback', 10)}
            className="nova-hit-tactile w-9 h-9 rounded-full hidden sm:flex items-center justify-center border transition-all text-slate-400 hover:text-white hover:bg-white/10"
            title="Signaler un bug ou proposer une idée (Ctrl+Maj+B)"
            aria-label="Signaler un bug ou proposer une idée"
            style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}
        >
            <i className="fas fa-comment-dots text-[13px]" aria-hidden="true"></i>
        </button>

        {/* THEME TOGGLE */}
        {/* Sous 768 px, thème / compte / mode sont dans le menu : dans la barre ils
            la faisaient déborder (déconnexion et mode hors de l'écran en 390 px). */}
        <button {...barItem('theme', 11)}
            onClick={onToggleTheme}
            className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 hidden md:flex items-center justify-center transition-all"
            title="Changer le thème"
            aria-label={currentTheme === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre'}
            style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}
        >
            <i className={`fas ${currentTheme === 'dark' ? 'fa-sun text-amber-400' : 'fa-moon text-slate-300'}`}></i>
        </button>

        {/* TONALITÉ + SIGNATURE */}
        <KeyBadge projectKey={projectKey} projectScale={projectScale} numerator={tsNum} denominator={tsDen} onClick={onOpenTempo} />
        {onTap && (
          <button {...barItem('tap', 31)} type="button" onPointerDown={e => { e.preventDefault(); onTap(); }} data-testid="transport-tap"
            title="Tap tempo : tape au rythme de la prod (ou touche T, comme dans Pro Tools). Le tempo s'affiche, « Tempo et mesure » pour l'appliquer."
            aria-label="Tap tempo"
            className="hidden sm:flex shrink-0 whitespace-nowrap nova-hit-tactile h-8 px-2 rounded-lg items-center text-[9px] font-black tracking-wider border border-white/10 text-slate-400 hover:text-white select-none touch-manipulation">
            TAP{tapBpm ? <span className="ml-1 mono text-amber-300">{tapBpm}</span> : null}
          </button>
        )}

        {/* BPM CONTROL */}
        <div data-testid="transport-bpm" className="hidden sm:flex shrink-0 flex-col items-end cursor-ns-resize group" onMouseDown={handleBpmMouseDown} title="Tempo : glisser vers le haut ou le bas, double-clic pour saisir">

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
            <div {...barItem('compte', 12)} className="hidden md:flex items-center space-x-2 bg-black/30 rounded-full pl-1 pr-1 py-1 border border-white/10" style={{ backgroundColor: 'var(--bg-item)' }}>
                <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-[10px] font-black text-white shadow-lg shadow-cyan-500/20">{user.username.charAt(0).toUpperCase()}</div>
                <button onClick={onLogout} title="Se déconnecter" aria-label="Se déconnecter" className="w-7 h-7 rounded-full bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center justify-center transition-all"><i className="fas fa-sign-out-alt text-[10px]"></i></button>
            </div>
        ) : (
            <button {...barItem('compte', 12)} onClick={onOpenAuth} aria-label="Connexion" title="Se connecter" className="h-8 px-4 rounded-full bg-white/10 hover:bg-cyan-500 hover:text-black text-white text-[9px] font-black uppercase tracking-widest transition-all border border-white/10 hidden md:flex items-center space-x-2"><i className="fas fa-user-circle"></i></button>
        )}

        {/* View Switcher for mobile/tablet injection from parent */}
        <div {...barItem('affichage', 13)} className="hidden md:block">{children}</div>
      </div>

      {/* MOBILE DROPDOWN MENU */}
      {/* Rendu dans <body> : dans la barre (empilement z-50) le tiroir passait sous
          les boutons flottants (Piste voix, Collaborer, onglets) et se coupait. */}
      {isMobileMenuOpen && createPortal(<>
        <div className="fixed inset-x-0 top-16 bottom-0 z-[540] bg-black/50" onClick={() => setIsMobileMenuOpen(false)} aria-hidden="true" />
        <div role="dialog" aria-label="Menu" className="fixed top-16 left-0 right-0 md:right-auto md:w-[400px] z-[550] max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b md:border-r border-white/10 shadow-2xl" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)', touchAction: 'pan-y' }}>
          <div className="p-4 space-y-3" style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>

            {/* Téléphone : métronome et boucle (masqués dans la barre sous 768 px) */}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => onToggleMetronome?.()} aria-pressed={isMetronomeEnabled} className={`px-3 py-3 rounded-xl text-[12px] font-semibold transition-colors ${isMetronomeEnabled ? 'bg-cyan-500 text-black' : 'bg-white/[0.04] text-slate-200'}`}>
                <i className="fas fa-drum block mb-1"></i>
                Métronome
              </button>
              <button onClick={() => onToggleLoop?.()} aria-pressed={isLoopActive} className={`px-3 py-3 rounded-xl text-[12px] font-semibold transition-colors ${isLoopActive ? 'bg-cyan-500 text-black' : 'bg-white/[0.04] text-slate-200'}`}>
                <i className="fas fa-sync-alt block mb-1"></i>
                Boucle
              </button>
            </div>
            {/* R3 : capture après coup et piste guide, à portée de doigt (freestyle au téléphone) */}
            {((onCapture && captureReady) || (guide && guide.count > 0 && onToggleGuide)) && (
              <div className="grid grid-cols-2 gap-2">
                {onCapture && captureReady && <button type="button" onClick={() => { onCapture(); setIsMobileMenuOpen(false); }} data-testid="menu-capture" className="min-h-12 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[12px] font-bold"><i className="fas fa-history mr-1.5" aria-hidden="true"></i>Capturer la dernière prise</button>}
                {guide && guide.count > 0 && onToggleGuide && <button type="button" onClick={onToggleGuide} aria-pressed={!guide.muted} data-testid="menu-guide" className={`min-h-12 rounded-xl text-[12px] font-bold border ${guide.muted ? 'border-white/10 text-slate-400' : 'bg-amber-500/15 border-amber-500/40 text-amber-200'}`}><i className="fas fa-headphones mr-1.5" aria-hidden="true"></i>{guide.muted ? 'Rallumer le guide' : 'Couper le guide'}</button>}
              </div>
            )}

            {/* R16 : MIDI au téléphone (clavier USB sur Android, clavier de l'ordinateur sur tablette) */}
            <button type="button" data-testid="menu-midi" onClick={() => { openMidiPanel(); setIsMobileMenuOpen(false); }}
              className="w-full min-h-12 rounded-xl bg-white/[0.04] border border-white/10 text-slate-200 text-[12px] font-bold text-left px-3 flex items-center gap-2">
              <i className="fas fa-keyboard text-cyan-300" aria-hidden="true"></i>
              <span>MIDI : enregistrer depuis ton clavier{midiDeviceName ? ` (${midiDeviceName})` : ''}</span>
            </button>

            {/* Mode simple / avancé : en haut du menu, facile à retrouver */}
            <SimpleModeToggle onDone={() => setIsMobileMenuOpen(false)} />

            {/* Thème Sombre / Clair / Auto : en haut aussi. Avant, « Changer le thème »
                était tout en bas du menu (hors de l'écran sur téléphone). */}
            <ThemeSwitch />

            {/* Affichage : piste d'accords (V20). Pas sur téléphone (version simple). */}
            {!isMobileLayout && <ChordLaneMenuToggle onDone={() => setIsMobileMenuOpen(false)} />}

            {/* VIEW SWITCHER (inutile en mise en page téléphone : on navigue par onglets) */}
            {!isMobileLayout && !simple && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Vues</div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => { onChangeView('ARRANGEMENT'); setIsMobileMenuOpen(false); }} className={`px-3 py-3 rounded-xl text-[12px] font-semibold transition-colors ${currentView === 'ARRANGEMENT' ? 'bg-cyan-500 text-black' : 'bg-white/[0.04] text-slate-300'}`}>
                  <i className="fas fa-grip-horizontal block mb-1"></i>
                  Pistes
                </button>
                <button onClick={() => { onChangeView('MIXER'); setIsMobileMenuOpen(false); }} className={`px-3 py-3 rounded-xl text-[12px] font-semibold transition-colors ${currentView === 'MIXER' ? 'bg-cyan-500 text-black' : 'bg-white/[0.04] text-slate-300'}`}>
                  <i className="fas fa-sliders-h block mb-1"></i>
                  Console
                </button>
                <button onClick={() => { onChangeView('AUTOMATION'); setIsMobileMenuOpen(false); }} className={`px-3 py-3 rounded-xl text-[12px] font-semibold transition-colors ${currentView === 'AUTOMATION' ? 'bg-cyan-500 text-black' : 'bg-white/[0.04] text-slate-300'}`}>
                  <i className="fas fa-project-diagram block mb-1"></i>
                  Auto
                </button>
              </div>
            </div>
            )}

            {/* VIEW MODE SWITCHER (PC/MOBILE) */}
            {children && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Mode d'affichage</div>
                <div className="group vm-labeled [&>div]:ml-0 [&>div]:border-0 [&>div]:pl-0">
                  {children}
                </div>
              </div>
            )}

            {/* UNDO / REDO */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Historique</div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => { onUndo?.(); setIsMobileMenuOpen(false); }} disabled={!canUndo} className={`min-h-12 px-4 py-3 rounded-xl font-semibold transition-colors ${canUndo ? 'bg-white/[0.06] text-white' : 'bg-white/[0.03] text-slate-500 opacity-60 cursor-not-allowed'}`}>
                  <i className="fas fa-undo mr-2"></i>Annuler
                </button>
                <button onClick={() => { onRedo?.(); setIsMobileMenuOpen(false); }} disabled={!canRedo} className={`min-h-12 px-4 py-3 rounded-xl font-semibold transition-colors ${canRedo ? 'bg-white/[0.06] text-white' : 'bg-white/[0.03] text-slate-500 opacity-60 cursor-not-allowed'}`}>
                  <i className="fas fa-redo mr-2"></i>Refaire
                </button>
              </div>
            </div>

            {/* FILE ACTIONS */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Fichiers</div>
              <div className="space-y-2">
                <button onClick={() => { onOpenLoadMenu?.(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                  <i className="w-5 text-center text-amber-400 fas fa-folder-open"></i>
                  <span>Ouvrir un projet</span>
                </button>
                <button onClick={() => { onOpenSaveMenu?.(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                  <i className="w-5 text-center text-green-400 fas fa-save"></i>
                  <span>Sauvegarder</span>
                </button>
                {onImportAudio && !simple && (
                  <button onClick={() => { audioImportInputRef.current?.click(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                    <i className="w-5 text-center text-slate-300 fas fa-file-import"></i>
                    <span>Importer un fichier audio</span>
                  </button>
                )}
                {user && (
                  <button onClick={() => { onShareProject?.(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                    <i className="w-5 text-center text-blue-400 fas fa-share-alt"></i>
                    <span>Partager</span>
                  </button>
                )}
                {onOpenMasterNova && (
                  <button onClick={() => { onOpenMasterNova(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                    <i className="w-5 text-center text-amber-300 fas fa-crown"></i>
                    <span>Master Nova</span>
                  </button>
                )}
                <button onClick={() => { onExportMix?.(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                  <i className="w-5 text-center text-purple-400 fas fa-compact-disc"></i>
                  <span>Exporter</span>
                </button>
                <MidiMobileMenuItems onDone={() => setIsMobileMenuOpen(false)} />
                {onOpenTakeHome && (
                  <button onClick={() => { onOpenTakeHome(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                    <i className="w-5 text-center text-cyan-300 fas fa-cloud-arrow-up"></i>
                    <span>{takeHomeLabel || 'Emporter la session'}</span>
                  </button>
                )}
                {onOpenCollab && (
                  <button onClick={() => { onOpenCollab(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                    <i className="w-5 text-center text-violet-300 fas fa-user-group"></i>
                    <span>{collabLabel || 'Collaborer'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* SETTINGS */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Paramètres</div>
              <div className="space-y-2">
                <button onClick={() => { onOpenAudioEngine?.(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                  <i className="w-5 text-center text-orange-400 fas fa-microchip"></i>
                  <span>{simple ? 'Réglages audio (micro, latence)' : 'Réglages audio (moteur, latence)'}</span>
                </button>
                {!simple && <button onClick={() => { onToggleDelayComp?.(); setIsMobileMenuOpen(false); }} aria-pressed={!!isDelayCompEnabled} className={`w-full min-h-12 px-4 py-3 rounded-xl font-semibold transition-colors flex items-center gap-3 ${isDelayCompEnabled ? 'bg-cyan-500/15 text-cyan-300' : 'bg-white/[0.04] text-slate-300'}`}>
                  <span className="w-5 flex justify-center"><span className={`w-2 h-2 rounded-full ${isDelayCompEnabled ? 'bg-cyan-400' : 'bg-slate-500'}`}></span></span>
                  <span>Compensation de latence (PDC)</span>
                </button>}
                {onTogglePunch && !simple && <button onClick={() => { onTogglePunch(); setIsMobileMenuOpen(false); }} aria-pressed={isPunchActive} title="REC ne remplace que la zone rouge de la règle (Pro Tools : punch-in / punch-out). Pré-roll, post-roll : bouton ▾ du punch dans la barre."
                  className={`w-full min-h-12 px-4 py-3 rounded-xl font-semibold transition-colors flex items-center gap-3 ${isPunchActive ? 'bg-red-500/15 text-red-300' : 'bg-white/[0.04] text-slate-300'}`}>
                  <span className="w-5 flex justify-center"><span className={`w-2 h-2 rounded-full ${isPunchActive ? 'bg-red-400' : 'bg-slate-500'}`}></span></span>
                  <span>Punch-in / punch-out</span>
                </button>}
                {!simple && midiDeviceName && (
                  <p role="status" className="px-4 text-[12px] text-slate-400"><i className="fas fa-plug mr-2 text-green-400" aria-hidden="true"></i>Clavier MIDI : {midiDeviceName}</p>
                )}
                {!isMobileLayout && (
                <button onClick={() => { onToggleSidebar?.(); setIsMobileMenuOpen(false); }} className={`w-full min-h-12 px-4 py-3 rounded-xl font-semibold transition-colors flex items-center gap-3 ${isSidebarOpen ? 'bg-cyan-500/15 text-cyan-300' : 'bg-white/[0.04] text-slate-300'}`}>
                  <i className="w-5 text-center fas fa-columns"></i>
                  <span>{isSidebarOpen ? 'Masquer' : 'Afficher'} le navigateur</span>
                </button>
                )}
              </div>
            </div>

            {/* BPM CONTROL */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Tempo (BPM)</div>
              {(onTap || onOpenTempo || onOpenMetronome) && (
                <div className="grid grid-cols-3 gap-2">
                  {onTap && <button type="button" onPointerDown={e => { e.preventDefault(); onTap(); }} data-testid="menu-tap" className="min-h-12 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-200 font-black select-none touch-manipulation">TAP{tapBpm ? <span className="ml-1">{tapBpm}</span> : null}</button>}
                  {onOpenTempo && <button type="button" onClick={() => { onOpenTempo(); setIsMobileMenuOpen(false); }} className="min-h-12 rounded-xl bg-white/[0.04] text-slate-100 text-[12px] font-semibold">Tempo et mesure</button>}
                  {onOpenMetronome && <button type="button" onClick={() => { onOpenMetronome(); setIsMobileMenuOpen(false); }} className="min-h-12 rounded-xl bg-white/[0.04] text-slate-100 text-[12px] font-semibold">Clic et décompte</button>}
                </div>
              )}
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
                  <div onClick={() => { setTempBpm(String(bpm)); setIsEditingBpm(true); }} className="text-3xl font-black text-cyan-400 cursor-pointer">{bpm}</div>
                )}
                <button onClick={() => onBpmChange(Math.min(999, bpm + 1))} aria-label="Tempo +1" className="w-10 h-10 rounded-lg bg-white/10 text-white font-bold">+</button>
              </div>
            </div>

            {/* AIDE : signaler un bug ou proposer une idée */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5 px-1">Aide</div>
              <button onClick={() => { openFeedback(); setIsMobileMenuOpen(false); }} data-nova-action="feedback-menu" className="w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3">
                <i className="w-5 text-center text-slate-400 fas fa-comment-dots"></i>
                <span>Signaler un bug / proposer une idée</span>
              </button>
              <button onClick={() => { openFeedback({ tab: 'historique' }); setIsMobileMenuOpen(false); }} className="w-full px-4 py-2 rounded-lg text-slate-400 text-[12px] font-bold transition-all flex items-center justify-center space-x-2 hover:text-white">
                <i className="fas fa-inbox"></i>
                <span>Mes signalements</span>
              </button>
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
                <button onClick={() => { onOpenAuth?.(); setIsMobileMenuOpen(false); }} className="w-full min-h-12 px-4 py-3 rounded-xl bg-cyan-500/10 text-cyan-300 font-semibold transition-colors flex items-center justify-center gap-3">
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
