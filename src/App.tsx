import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Track, TrackType, DAWState, ProjectPhase, PluginInstance, PluginType, MobileTab, TrackSend, Clip, AIAction, AutomationLane, AIChatMessage, ViewMode, User, Theme, DrumPad } from './types';
import { audioEngine } from './engine/AudioEngine';
import TransportBar from './components/TransportBar';
import ArrangementView from './components/ArrangementView';
import MixerView from './components/MixerView';
import PluginEditor from './components/PluginEditor';
import ChatAssistant from './components/ChatAssistant';
import ViewModeSwitcher from './components/ViewModeSwitcher';
import ContextMenu from './components/ContextMenu';
import TouchInteractionManager from './components/TouchInteractionManager';
import GlobalClipMenu from './components/GlobalClipMenu'; 
import TrackCreationBar from './components/TrackCreationBar';
import AuthScreen from './components/AuthScreen';
import AutomationEditorView from './components/AutomationEditorView';
import ShareModal from './components/ShareModal';
import SaveProjectModal from './components/SaveProjectModal';
import LoadProjectModal from './components/LoadProjectModal';
import ExportModal from './components/ExportModal'; 
import AudioSettingsPanel from './components/AudioSettingsPanel'; 
import PluginManager from './components/PluginManager'; 
import { supabaseManager } from './services/SupabaseManager';
import { SessionSerializer } from './services/SessionSerializer';
import { getAIProductionAssistance } from './services/AIService';
import { novaBridge } from './services/NovaBridge';
import { ProjectIO } from './services/ProjectIO';
import PianoRoll from './components/PianoRoll';
import { midiManager } from './services/MidiManager';
import { AUDIO_CONFIG, UI_CONFIG } from './utils/constants';
import SideBrowser2 from './components/SideBrowser2';
import { produce } from 'immer';

const AVAILABLE_FX_MENU = [
    { id: 'MASTERSYNC', name: 'Master Sync', icon: 'fa-sync-alt' },
    { id: 'VOCALSATURATOR', name: 'Vocal Saturator', icon: 'fa-fire' },
    { id: 'PROEQ12', name: 'Pro-EQ 12', icon: 'fa-wave-square' },
    { id: 'AUTOTUNE', name: 'Auto-Tune Pro', icon: 'fa-microphone-alt' },
    { id: 'DENOISER', name: 'Denoiser', icon: 'fa-broom' },
    { id: 'COMPRESSOR', name: 'Leveler', icon: 'fa-compress-alt' },
    { id: 'REVERB', name: 'Spatial Verb', icon: 'fa-mountain-sun' },
    { id: 'DELAY', name: 'Sync Delay', icon: 'fa-history' },
    { id: 'CHORUS', name: 'Vocal Chorus', icon: 'fa-layer-group' },
    { id: 'FLANGER', name: 'Studio Flanger', icon: 'fa-wind' },
    { id: 'DOUBLER', name: 'Vocal Doubler', icon: 'fa-people-arrows' },
    { id: 'STEREOSPREADER', name: 'Phase Guard', icon: 'fa-arrows-alt-h' },
    { id: 'DEESSER', name: 'S-Killer', icon: 'fa-scissors' }
];

const createDefaultAutomation = (param: string, color: string): AutomationLane => ({
  id: `auto-${Date.now()}-${Math.random()}`,
  parameterName: param, points: [], color: color, isExpanded: false, min: 0, max: 1.5
});

const createDefaultPlugins = (type: PluginType, mix: number = 0.3, bpm: number = AUDIO_CONFIG.DEFAULT_BPM, paramsOverride: any = {}): PluginInstance => {
  let params: any = { isEnabled: true };
  let name: string = type;

  if (type === 'DELAY') params = { division: '1/4', feedback: 0.4, damping: 5000, mix, pingPong: false, bpm, isEnabled: true };
  if (type === 'REVERB') params = { decay: 2.5, preDelay: 0.02, damping: 12000, mix, size: 0.7, mode: 'HALL', isEnabled: true };
  if (type === 'COMPRESSOR') params = { threshold: -18, ratio: 4, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1.0, isEnabled: true };
  if (type === 'AUTOTUNE') params = { speed: 0.1, humanize: 0.2, mix: 1.0, rootKey: 0, scale: 'CHROMATIC', isEnabled: true };
  if (type === 'CHORUS') params = { rate: 1.2, depth: 0.35, spread: 0.5, mix: 0.4, isEnabled: true };
  if (type === 'FLANGER') params = { rate: 0.5, depth: 0.5, feedback: 0.7, manual: 0.3, mix: 0.5, invertPhase: false, isEnabled: true };
  if (type === 'DOUBLER') params = { detune: 0.4, width: 0.8, gainL: 0.7, gainR: 0.7, directOn: true, isEnabled: true };
  if (type === 'STEREOSPREADER') params = { width: 1.0, haasDelay: 0.015, lowBypass: 0.8, isEnabled: true };
  if (type === 'DEESSER') params = { threshold: -25, frequency: 6500, q: 1.0, reduction: 0.6, mode: 'BELL', isEnabled: true };
  if (type === 'DENOISER') params = { threshold: -45, reduction: 0.8, release: 0.15, isEnabled: true };
  if (type === 'VOCALSATURATOR') params = { drive: 20, mix: 0.5, tone: 0.0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TAPE', isEnabled: true, outputGain: 1.0 };
  if (type === 'MASTERSYNC') params = { detectedBpm: 120, detectedKey: 0, isMinor: false, isAnalyzing: false, analysisProgress: 0, isEnabled: true, hasResult: false };
  if (type === 'PROEQ12') {
     const defaultFreqs = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
     const defaultBands = Array.from({ length: 12 }, (_, i) => ({
      id: i, type: (i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking') as any, 
      frequency: defaultFreqs[i], gain: 0, q: 1.0, isEnabled: true, isSolo: false
     }));
     params = { isEnabled: true, masterGain: 1.0, bands: defaultBands };
  }
  
  if (type === 'MELODIC_SAMPLER') {
      name = 'Melodic Sampler';
      params = { rootKey: 60, fineTune: 0, glide: 0.05, loop: true, loopStart: 0, loopEnd: 1, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5, filterCutoff: 20000, filterRes: 0, velocityToFilter: 0.5, lfoRate: 4, lfoAmount: 0, lfoDest: 'PITCH', saturation: 0, bitCrush: 0, chorus: 0, width: 0.5, isEnabled: true };
  }
  if (type === 'DRUM_SAMPLER') {
      name = 'Drum Sampler';
      params = { gain: 0, transpose: 0, fineTune: 0, sampleStart: 0, sampleEnd: 1, attack: 0.005, hold: 0.05, decay: 0.2, sustain: 0, release: 0.1, cutoff: 20000, resonance: 0, pan: 0, velocitySens: 0.8, reverse: false, normalize: false, chokeGroup: 1, isEnabled: true };
  }

  params = { ...params, ...paramsOverride };
  return { id: `pl-${Date.now()}-${Math.random()}`, name, type, isEnabled: true, params, latency: 0 };
};

const createInitialSends = (bpm: number): Track[] => [];

const createBusVox = (defaultSends: TrackSend[], bpm: number): Track => ({
  id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, color: '#fbbf24', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'master', sends: [...defaultSends], clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#fbbf24')], totalLatency: 0
});

const SaveOverlay: React.FC<{ progress: number; message: string }> = ({ progress, message }) => (
  <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
    <div className="w-64 space-y-4 text-center">
      <div className="w-16 h-16 mx-auto rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin"></div>
      <h3 className="text-xl font-black text-white uppercase tracking-widest">{message}</h3>
      <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-cyan-500 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
      </div>
      <span className="text-xs font-mono text-cyan-400">{progress}%</span>
    </div>
  </div>
);

const MobileBottomNav: React.FC<{ activeTab: MobileTab, onTabChange: (tab: MobileTab) => void }> = ({ activeTab, onTabChange }) => (
    <div className="h-16 bg-[#0c0d10] border-t border-white/10 flex items-center justify-around z-50">
        <button onClick={() => onTabChange('PROJECT')} className={`flex flex-col items-center space-y-1 ${activeTab === 'PROJECT' ? 'text-cyan-400' : 'text-slate-500'}`}>
            <i className="fas fa-project-diagram text-lg"></i>
            <span className="text-[9px] font-black uppercase">Arrangement</span>
        </button>
        <button onClick={() => onTabChange('MIXER')} className={`flex flex-col items-center space-y-1 ${activeTab === 'MIXER' ? 'text-cyan-400' : 'text-slate-500'}`}>
            <i className="fas fa-sliders-h text-lg"></i>
            <span className="text-[9px] font-black uppercase">Mixer</span>
        </button>
        <button onClick={() => onTabChange('NOVA')} className={`flex flex-col items-center space-y-1 ${activeTab === 'NOVA' ? 'text-cyan-400' : 'text-slate-500'}`}>
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/30 -mt-6 border-4 border-[#0c0d10]">
                <i className="fas fa-robot text-white text-lg"></i>
            </div>
            <span className="text-[9px] font-black uppercase">AI Nova</span>
        </button>
        <button onClick={() => onTabChange('AUTOMATION')} className={`flex flex-col items-center space-y-1 ${activeTab === 'AUTOMATION' ? 'text-cyan-400' : 'text-slate-500'}`}>
            <i className="fas fa-wave-square text-lg"></i>
            <span className="text-[9px] font-black uppercase">Auto</span>
        </button>
    </div>
);

const useUndoRedo = (initialState: DAWState) => {
  const [history, setHistory] = useState<{ past: DAWState[]; present: DAWState; future: DAWState[]; }>({ past: [], present: initialState, future: [] });
  const MAX_HISTORY = 100;
  const setState = useCallback((updater: DAWState | ((prev: DAWState) => DAWState)) => {
    setHistory(curr => {
      const newState = typeof updater === 'function' ? updater(curr.present) : updater;
      if (newState === curr.present) return curr;
      const isTimeUpdateOnly = newState.currentTime !== curr.present.currentTime && newState.tracks === curr.present.tracks && newState.isPlaying === curr.present.isPlaying;
      if (isTimeUpdateOnly) return { ...curr, present: newState };
      return { past: [...curr.past, curr.present].slice(-MAX_HISTORY), present: newState, future: [] };
    });
  }, []);
  const setVisualState = useCallback((updater: Partial<DAWState>) => { setHistory(curr => ({ ...curr, present: { ...curr.present, ...updater } })); }, []);
  const undo = useCallback(() => { setHistory(curr => { if (curr.past.length === 0) return curr; return { past: curr.past.slice(0, -1), present: curr.past[curr.past.length - 1], future: [curr.present, ...curr.future] }; }); }, []);
  const redo = useCallback(() => { setHistory(curr => { if (curr.future.length === 0) return curr; return { past: [...curr.past, curr.present], present: curr.future[0], future: curr.future.slice(1) }; }); }, []);
  return { state: history.present, setState, setVisualState, undo, redo, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
};

export default function App() {
  const [user, setUser] = useState<User | null>(null); 
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [saveState, setSaveState] = useState<{ isSaving: boolean; progress: number; message: string }>({ isSaving: false, progress: 0, message: '' });
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isPluginManagerOpen, setIsPluginManagerOpen] = useState(false); 
  const [isAudioSettingsOpen, setIsAudioSettingsOpen] = useState(false);
  const [isSaveMenuOpen, setIsSaveMenuOpen] = useState(false); 
  const [isLoadMenuOpen, setIsLoadMenuOpen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [midiEditorOpen, setMidiEditorOpen] = useState<{trackId: string, clipId: string} | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeSideBrowserTab, setActiveSideBrowserTab] = useState<'STORE' | 'LOCAL' | 'FW' | 'BRIDGE'>('STORE');

  useEffect(() => {
      const u = supabaseManager.getUser();
      if(u) setUser(u);
  }, []);

  const initialState: DAWState = {
    id: 'proj-1', name: 'STUDIO_SESSION', bpm: AUDIO_CONFIG.DEFAULT_BPM, isPlaying: false, isRecording: false, currentTime: 0,
    isLoopActive: false, loopStart: 0, loopEnd: 0,
    tracks: [
      { id: 'instrumental', name: 'BEAT', type: TrackType.AUDIO, color: '#eab308', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 0.7, pan: 0, outputTrackId: 'master', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#eab308')], totalLatency: 0 },
      { id: 'track-rec-main', name: 'REC', type: TrackType.AUDIO, color: '#ff0000', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#ff0000')], totalLatency: 0 },
      createBusVox(createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), AUDIO_CONFIG.DEFAULT_BPM), 
      ...createInitialSends(AUDIO_CONFIG.DEFAULT_BPM)
    ],
    selectedTrackId: 'track-rec-main', currentView: 'ARRANGEMENT', projectPhase: ProjectPhase.SETUP, isLowLatencyMode: false, isRecModeActive: false, systemMaxLatency: 0, recStartTime: null,
    isDelayCompEnabled: false
  };

  const { state, setState, setVisualState, undo, redo, canUndo, canRedo } = useUndoRedo(initialState);
  
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  const toggleTheme = () => { setTheme(prev => prev === 'dark' ? 'light' : 'dark'); };

  const toggleSidebar = () => setIsSidebarOpen(prev => !prev);

  useEffect(() => { novaBridge.connect(); }, []);
  const stateRef = useRef(state); 
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { if (audioEngine.ctx) state.tracks.forEach(t => audioEngine.updateTrack(t, state.tracks)); }, [state.tracks]); 
  
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (stateRef.current.isPlaying) {
         const time = audioEngine.getCurrentTime();
         const { isLoopActive, loopStart, loopEnd, tracks } = stateRef.current;
         
         if (isLoopActive && loopEnd > loopStart && time >= loopEnd) {
           audioEngine.seekTo(loopStart, tracks, true);
           setVisualState({ currentTime: loopStart });
         } else {
           setVisualState({ currentTime: time });
         }
         
         animId = requestAnimationFrame(updateLoop);
      }
    };
    if (state.isPlaying) { animId = requestAnimationFrame(updateLoop); }
    return () => cancelAnimationFrame(animId);
  }, [state.isPlaying, setVisualState]);

  const [activePlugin, setActivePlugin] = useState<{trackId: string, plugin: PluginInstance} | null>(null);
  const [externalImportNotice, setExternalImportNotice] = useState<string | null>(null);
  const [aiNotification, setAiNotification] = useState<string | null>(null);
  const [addPluginMenu, setAddPluginMenu] = useState<{ trackId: string, x: number, y: number } | null>(null);
  const [automationMenu, setAutomationMenu] = useState<{ x: number, y: number, trackId: string, paramId: string, paramName: string, min: number, max: number } | null>(null);
  const [noArmedTrackError, setNoArmedTrackError] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('nova_view_mode');
    if (saved) return saved as ViewMode;
    return window.innerWidth < 768 ? 'MOBILE' : (window.innerWidth < 1024 ? 'TABLET' : 'DESKTOP');
  });
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>('PROJECT');
  const handleViewModeChange = (mode: ViewMode) => { setViewMode(mode); localStorage.setItem('nova_view_mode', mode); };
  useEffect(() => { document.body.setAttribute('data-view-mode', viewMode); }, [viewMode]);
  const isMobile = viewMode === 'MOBILE';
  const ensureAudioEngine = async () => {
    const wasUninitialized = !audioEngine.ctx;
    if (!audioEngine.ctx) await audioEngine.init();
    if (audioEngine.ctx?.state === 'suspended') await audioEngine.ctx.resume();
    if (wasUninitialized && audioEngine.ctx) {
      stateRef.current.tracks.forEach(t => audioEngine.updateTrack(t, stateRef.current.tracks));
    }
  };

  const handleLogout = async () => { await supabaseManager.signOut(); setUser(null); };
  const handleBuyLicense = (instrumentId: number) => { if (!user) return; const updatedUser = { ...user, owned_instruments: [...(user.owned_instruments || []), instrumentId] }; setUser(updatedUser); setAiNotification(`✅ Licence achetée avec succès ! Export débloqué.`); };
  
  const handleSaveCloud = async (projectName: string) => { /* ... */ };
  const handleSaveAsCopy = async (n: string) => { /* ... */ };
  const handleSaveLocal = async (n: string) => { SessionSerializer.downloadLocalJSON(stateRef.current, n); };
  const handleLoadCloud = async (id: string) => { /* ... */ };
  const handleLoadLocalFile = async (f: File) => { /* ... */ };
  const handleShareProject = async (e: string) => { setIsShareModalOpen(false); };
  const handleExportMix = async () => { setIsExportMenuOpen(true); };

  const handleEditClip = (trackId: string, clipId: string, action: string, payload?: any) => {
    setState(produce((draft: DAWState) => {
      const track = draft.tracks.find(t => t.id === trackId);
      if (!track) return;
      let newClips = [...track.clips];
      const idx = newClips.findIndex(c => c.id === clipId);
      if (idx === -1 && action !== 'PASTE') return;
      switch(action) {
        case 'UPDATE_PROPS': if(idx > -1) newClips[idx] = { ...newClips[idx], ...payload }; break;
        case 'DELETE': if(idx > -1) newClips.splice(idx, 1); break;
        case 'MUTE': if(idx > -1) newClips[idx] = { ...newClips[idx], isMuted: !newClips[idx].isMuted }; break;
        case 'DUPLICATE': if(idx > -1) newClips.push({ ...newClips[idx], id: `clip-dup-${Date.now()}`, start: newClips[idx].start + newClips[idx].duration + 0.1 }); break;
        case 'RENAME': if(idx > -1) newClips[idx] = { ...newClips[idx], name: payload.name }; break;
        case 'SPLIT': 
            if(idx > -1) {
              const clip = newClips[idx];
              const splitTime = payload.time;
              if (splitTime > clip.start && splitTime < clip.start + clip.duration) {
                  const firstDuration = splitTime - clip.start;
                  const secondDuration = clip.duration - firstDuration;
                  newClips[idx] = { ...clip, duration: firstDuration };
                  newClips.push({ ...clip, id: `clip-split-${Date.now()}`, start: splitTime, duration: secondDuration, offset: clip.offset + firstDuration });
              }
            }
            break;
      }
      track.clips = newClips;
    }));
  };

  const handleUpdateBpm = useCallback((newBpm: number) => { setState(prev => ({ ...prev, bpm: Math.max(20, Math.min(999, newBpm)) })); }, [setState]);
  
  const handleUpdateTrack = useCallback((updatedTrack: Track) => {
    const previousTrack = stateRef.current.tracks.find(t => t.id === updatedTrack.id);

    // Handle Arm/Disarm side effect
    if (previousTrack && previousTrack.isTrackArmed !== updatedTrack.isTrackArmed) {
        if (updatedTrack.isTrackArmed) {
            audioEngine.armTrack(updatedTrack.id);
            // Disarm all other tracks
            setState(produce(draft => {
                draft.tracks.forEach(t => {
                    if (t.id !== updatedTrack.id) t.isTrackArmed = false;
                });
            }));
        } else {
            audioEngine.disarmTrack();
        }
    }

    setState(produce(draft => {
        const trackIndex = draft.tracks.findIndex(t => t.id === updatedTrack.id);
        if (trackIndex !== -1) {
            draft.tracks[trackIndex] = updatedTrack;
        }
    }));
  }, [setState]);

  const handleUpdatePluginParams = useCallback((trackId: string, pluginId: string, params: Record<string, any>) => {
    setState(produce((draft: DAWState) => {
      const track = draft.tracks.find(t => t.id === trackId);
      if (track) {
          const plugin = track.plugins.find(p => p.id === pluginId);
          if (plugin) plugin.params = { ...plugin.params, ...params };
      }
    }));
    const pluginNode = audioEngine.getPluginNodeInstance(trackId, pluginId);
    if (pluginNode && pluginNode.updateParams) { pluginNode.updateParams(params); }
  }, [setState]);

  const handleSeek = useCallback((time: number) => { setVisualState({ currentTime: time }); audioEngine.seekTo(time, stateRef.current.tracks, stateRef.current.isPlaying); }, [setVisualState]);
  
  const handleTogglePlay = useCallback(async () => {
      await ensureAudioEngine();
      if (stateRef.current.isPlaying) {
        audioEngine.stopAll();
        setVisualState({ isPlaying: false });
      } else {
        audioEngine.startPlayback(stateRef.current.currentTime, stateRef.current.tracks);
        setVisualState({ isPlaying: true });
      }
  }, [setVisualState]);

  const handleStop = useCallback(async () => {
    audioEngine.stopAll();
    audioEngine.seekTo(0, stateRef.current.tracks, false);
    setState(prev => ({ ...prev, isPlaying: false, currentTime: 0, isRecording: false }));
  }, [setState]);

  const handleToggleRecord = useCallback(async () => {
    await ensureAudioEngine();
    const currentState = stateRef.current;
    
    // Stop recording
    if (currentState.isRecording) {
      audioEngine.stopAll();
      const result = await audioEngine.stopRecording();
      setState(produce(draft => {
        draft.isRecording = false;
        draft.isPlaying = false;
        draft.recStartTime = null;
        if (result) {
          const track = draft.tracks.find(t => t.id === result.trackId);
          if (track) {
            track.clips.push(result.clip);
          }
        }
      }));
      return;
    }
  
    // Start recording
    const armedTrack = currentState.tracks.find(t => t.isTrackArmed);
    if (armedTrack) {
      const success = await audioEngine.startRecording(currentState.currentTime, armedTrack.id);
      if (success) {
        // Auto-start playback when recording begins
        audioEngine.startPlayback(currentState.currentTime, currentState.tracks);
        setState(produce(draft => {
          draft.isRecording = true;
          draft.isPlaying = true;
          draft.recStartTime = draft.currentTime;
        }));
      }
    } else {
      setNoArmedTrackError(true);
      setTimeout(() => setNoArmedTrackError(false), 2000);
    }
  }, [setState]);


  const handleDuplicateTrack = useCallback((trackId: string) => { /* ... */ }, [setState]);

  const handleCreateTrack = useCallback((type: TrackType, name?: string, initialPluginType?: PluginType) => {
      setState(produce((draft: DAWState) => {
          let drumPads: DrumPad[] | undefined = undefined;
          if (type === TrackType.DRUM_RACK) {
              drumPads = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Pad ${i + 1}`, sampleName: 'Empty', volume: 0.8, pan: 0, isMuted: false, isSolo: false, midiNote: 60 + i }));
          }
          const plugins: PluginInstance[] = [];
          if (initialPluginType) { plugins.push(createDefaultPlugins(initialPluginType, 1.0, draft.bpm)); }
          const newTrack: Track = {
              id: `track-${Date.now()}`, name: name || `${type} TRACK`, type, color: UI_CONFIG.TRACK_COLORS[draft.tracks.length % UI_CONFIG.TRACK_COLORS.length], isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins, automationLanes: [], totalLatency: 0, drumPads
          };
          draft.tracks.push(newTrack);
      }));
  }, [setState]);

  const handleDeleteTrack = useCallback((trackId: string) => { /* ... */ }, [setState]);
  const handleRemovePlugin = useCallback((tid: string, pid: string) => { /* ... */ }, [setState, activePlugin]);
  
  const handleAddPluginFromContext = useCallback(async (tid: string, type: PluginType, metadata?: any, options?: { openUI: boolean }) => {
    const newPlugin = createDefaultPlugins(type, 0.5, stateRef.current.bpm, metadata);
    
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === tid);
        if (track) {
            track.plugins.push(newPlugin);
        }
    }));

    if (options?.openUI) {
        await ensureAudioEngine();
        setTimeout(() => {
            setActivePlugin({ trackId: tid, plugin: newPlugin });
        }, 50);
    }
  }, [setState]);

  const handleUniversalAudioImport = async (source: string | File, name: string) => { /* ... */ };
  useEffect(() => { (window as any).DAW_CORE = { handleAudioImport: (url: string, name: string) => handleUniversalAudioImport(url, name) }; }, []);

  const handleMoveClip = useCallback((sourceTrackId: string, destTrackId: string, clipId: string) => { /* ... */ }, [setState]);
  const handleCreatePatternAndOpen = useCallback((trackId: string, time: number) => { /* ... */ }, [setState]);
  const handleSwapInstrument = useCallback((trackId: string) => { /* ... */ }, []);
  const handleAddBus = useCallback(() => { handleCreateTrack(TrackType.BUS, "Group Bus"); }, [handleCreateTrack]);
  const handleToggleBypass = useCallback((trackId: string, pluginId: string) => { /* ... */ }, [setState]);
  const handleCreateAutomationLane = useCallback(() => { /* ... */ }, [automationMenu, setState]);
  const handleToggleDelayComp = useCallback(() => { /* ... */ }, [state.isDelayCompEnabled, setState]);
  const handleLoadDrumSample = useCallback(async (trackId: string, padId: number, file: File) => { /* ... */ }, [setState]);

  useEffect(() => {
    (window as any).DAW_CONTROL = {
      // ... (All functions mapped) ...
      loadDrumSample: handleLoadDrumSample
    };
  }, [handleUpdateBpm, handleUpdateTrack, handleTogglePlay, handleStop, handleSeek, handleDuplicateTrack, handleCreateTrack, handleDeleteTrack, handleToggleBypass, handleLoadDrumSample, handleEditClip]);

  const executeAIAction = (a: AIAction) => { /* ... */ };

  if (!user) { return <AuthScreen onAuthenticated={(u) => { setUser(u); setIsAuthOpen(false); }} />; }

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden relative transition-colors duration-300" style={{ backgroundColor: 'var(--bg-main)', color: 'var(--text-primary)' }}>
      {saveState.isSaving && <SaveOverlay progress={saveState.progress} message={saveState.message} />}

      <div className="relative z-50">
        <TransportBar
          isPlaying={state.isPlaying}
          currentTime={state.currentTime}
          bpm={state.bpm}
          onBpmChange={handleUpdateBpm}
          isRecording={state.isRecording}
          isLoopActive={state.isLoopActive}
          onToggleLoop={() => setState(p => {
            const newLoopActive = !p.isLoopActive;
            if (newLoopActive && p.loopEnd <= p.loopStart) {
              const barDuration = (60 / p.bpm) * 4;
              return { ...p, isLoopActive: true, loopStart: 0, loopEnd: barDuration * 4 };
            }
            return { ...p, isLoopActive: newLoopActive };
          })}
          onStop={handleStop}
          onTogglePlay={handleTogglePlay}
          onToggleRecord={handleToggleRecord}
          currentView={state.currentView}
          onChangeView={v => setState(s => ({...s, currentView: v}))}
          statusMessage={externalImportNotice}
          noArmedTrackError={noArmedTrackError}
          currentTheme={theme}
          onToggleTheme={toggleTheme}
          onOpenSaveMenu={() => setIsSaveMenuOpen(true)}
          onOpenLoadMenu={() => setIsLoadMenuOpen(true)}
          onExportMix={handleExportMix}
          onShareProject={() => setIsShareModalOpen(true)}
          onOpenAudioEngine={() => setIsAudioSettingsOpen(true)}
          isDelayCompEnabled={state.isDelayCompEnabled}
          onToggleDelayComp={handleToggleDelayComp}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          user={user}
          onOpenAuth={() => setIsAuthOpen(true)}
          onLogout={handleLogout}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        >
          <div className="ml-4 border-l border-white/5 pl-4"><ViewModeSwitcher currentMode={viewMode} onChange={handleViewModeChange} /></div>
        </TransportBar>
      </div>
      
      <TrackCreationBar onCreateTrack={handleCreateTrack} />
      <TouchInteractionManager />
      <GlobalClipMenu />

      <div className="flex-1 flex overflow-hidden relative">
        {isSidebarOpen && !isMobile && (
            <aside className="shrink-0 z-10">
                <SideBrowser2 
                    user={user}
                    activeTab={activeSideBrowserTab}
                    onTabChange={setActiveSideBrowserTab}
                    onLocalImport={(file) => handleUniversalAudioImport(file, file.name)}
                    onAddPlugin={handleAddPluginFromContext}
                    onPurchase={handleBuyLicense}
                    selectedTrackId={state.selectedTrackId}
                />
            </aside>
        )}
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
          {((!isMobile && state.currentView === 'ARRANGEMENT') || (isMobile && activeMobileTab === 'PROJECT')) && (
            <ArrangementView 
               tracks={state.tracks} currentTime={state.currentTime} 
               isLoopActive={state.isLoopActive} loopStart={state.loopStart} loopEnd={state.loopEnd}
               onSetLoop={(start, end) => setState(prev => ({ ...prev, loopStart: start, loopEnd: end, isLoopActive: true }))} 
               onSeek={handleSeek} bpm={state.bpm} 
               selectedTrackId={state.selectedTrackId} onSelectTrack={id => setState(p => ({ ...p, selectedTrackId: id }))} 
               onUpdateTrack={handleUpdateTrack} onReorderTracks={() => {}} 
               onDropPluginOnTrack={(trackId, type, metadata) => handleAddPluginFromContext(trackId, type, metadata, { openUI: true })} 
               onSelectPlugin={async (tid, p) => { await ensureAudioEngine(); setActivePlugin({trackId:tid, plugin:p}); }} 
               onRemovePlugin={handleRemovePlugin} 
               onRequestAddPlugin={(tid, x, y) => setAddPluginMenu({ trackId: tid, x, y })} 
               onAddTrack={handleCreateTrack} onDuplicateTrack={handleDuplicateTrack} onDeleteTrack={handleDeleteTrack} 
               onFreezeTrack={(tid) => {}} 
               onImportFile={(file) => handleUniversalAudioImport(file, file.name)}
               onEditClip={handleEditClip} isRecording={state.isRecording} recStartTime={state.recStartTime}
               onMoveClip={handleMoveClip}
               onEditMidi={(trackId, clipId) => setMidiEditorOpen({ trackId, clipId })}
               onCreatePattern={handleCreatePatternAndOpen}
               onSwapInstrument={handleSwapInstrument}
            /> 
          )}
          
          {((!isMobile && state.currentView === 'MIXER') || (isMobile && activeMobileTab === 'MIXER')) && (
             <MixerView 
                tracks={state.tracks} 
                onUpdateTrack={handleUpdateTrack} 
                onOpenPlugin={async (tid, p) => { await ensureAudioEngine(); setActivePlugin({trackId:tid, plugin:p}); }} 
                onDropPluginOnTrack={(trackId, type, metadata) => handleAddPluginFromContext(trackId, type, metadata, { openUI: true })}
                onRemovePlugin={handleRemovePlugin}
                onAddBus={handleAddBus}
                onToggleBypass={handleToggleBypass}
                onRequestAddPlugin={(tid, x, y) => setAddPluginMenu({ trackId: tid, x, y })}
             />
          )}

          {((!isMobile && state.currentView === 'AUTOMATION') || (isMobile && activeMobileTab === 'AUTOMATION')) && (
             <AutomationEditorView 
               tracks={state.tracks} currentTime={state.currentTime} bpm={state.bpm} zoomH={40} 
               onUpdateTrack={handleUpdateTrack} onSeek={handleSeek}
             />
          )}
        </main>
      </div>
      
      {isMobile && <MobileBottomNav activeTab={activeMobileTab} onTabChange={setActiveMobileTab} />}

      {isSaveMenuOpen && <SaveProjectModal isOpen={isSaveMenuOpen} onClose={() => setIsSaveMenuOpen(false)} currentName={state.name} user={user} onSaveCloud={handleSaveCloud} onSaveLocal={handleSaveLocal} onSaveAsCopy={handleSaveAsCopy} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isLoadMenuOpen && <LoadProjectModal isOpen={isLoadMenuOpen} onClose={() => setIsLoadMenuOpen(false)} user={user} onLoadCloud={handleLoadCloud} onLoadLocal={handleLoadLocalFile} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isExportMenuOpen && <ExportModal isOpen={isExportMenuOpen} onClose={() => setIsExportMenuOpen(false)} projectState={state} />}
      {isAuthOpen && <AuthScreen onAuthenticated={(u) => { setUser(u); setIsAuthOpen(false); }} />}
      
      {addPluginMenu && <ContextMenu x={addPluginMenu.x} y={addPluginMenu.y} onClose={() => setAddPluginMenu(null)} items={AVAILABLE_FX_MENU.map(fx => ({ label: fx.name, icon: fx.icon, onClick: () => handleAddPluginFromContext(addPluginMenu.trackId, fx.id as PluginType, {}, { openUI: true }) }))} />}
      {automationMenu && <ContextMenu x={automationMenu.x} y={automationMenu.y} onClose={() => setAutomationMenu(null)} items={[{ label: `Automate: ${automationMenu.paramName}`, icon: 'fa-wave-square', onClick: handleCreateAutomationLane }]} />}
      
      {midiEditorOpen && state.tracks.find(t => t.id === midiEditorOpen.trackId) && (
          <div className="fixed inset-0 z-[250] bg-[#0c0d10] flex flex-col animate-in slide-in-from-bottom-10 duration-200">
             <PianoRoll track={state.tracks.find(t => t.id === midiEditorOpen.trackId)!} clipId={midiEditorOpen.clipId} bpm={state.bpm} currentTime={state.currentTime} onUpdateTrack={handleUpdateTrack} onClose={() => setMidiEditorOpen(null)} />
          </div>
      )}
      
      {activePlugin && (
        <div className={`fixed inset-0 flex items-center justify-center z-[200] ${isMobile ? 'bg-[#0c0d10]' : 'bg-black/60 backdrop-blur-sm'}`} onMouseDown={() => !isMobile && setActivePlugin(null)}>
           <div className={`relative ${isMobile ? 'w-full h-full p-4 overflow-y-auto' : ''}`} onMouseDown={e => e.stopPropagation()}>
              <PluginEditor plugin={activePlugin.plugin} trackId={activePlugin.trackId} onClose={() => setActivePlugin(null)} onUpdateParams={(p) => handleUpdatePluginParams(activePlugin.trackId, activePlugin.plugin.id, p)} isMobile={isMobile} track={state.tracks.find(t => t.id === activePlugin.trackId)} onUpdateTrack={handleUpdateTrack} />
           </div>
        </div>
      )}

      {isPluginManagerOpen && <PluginManager onClose={() => setIsPluginManagerOpen(false)} onPluginsDiscovered={(plugins) => { console.log("Plugins refreshed:", plugins.length); setIsPluginManagerOpen(false); }} />}
      {isAudioSettingsOpen && <AudioSettingsPanel onClose={() => setIsAudioSettingsOpen(false)} />}
      
      <div className={isMobile && activeMobileTab !== 'NOVA' ? 'hidden' : ''}>
        <ChatAssistant onSendMessage={(msg) => getAIProductionAssistance(state, msg)} onExecuteAction={executeAIAction} externalNotification={aiNotification} isMobile={isMobile} forceOpen={isMobile && activeMobileTab === 'NOVA'} onClose={() => setActiveMobileTab('PROJECT')} />
      </div>
      
      {isShareModalOpen && user && <ShareModal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} onShare={handleShareProject} projectName={state.name} />}
    </div>
  );
}
