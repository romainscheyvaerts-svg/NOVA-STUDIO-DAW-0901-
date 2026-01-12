
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Track, TrackType, DAWState, ProjectPhase, PluginInstance, PluginType, MobileTab, TrackSend, Clip, AIAction, AutomationLane, AIChatMessage, ViewMode, User, Theme, DrumPad } from './types';
import { audioEngine } from './engine/AudioEngine';
import { audioBufferRegistry } from './services/AudioBufferRegistry';
import TransportBar from './components/TransportBar';
import MobilePinchZoomContainer from './components/MobilePinchZoomContainer';
import MobileTransportFloating from './components/MobileTransportFloating';
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
import MobilePanelSystem from './components/mobile/MobilePanelSystem';
import { PanelConfig } from './components/mobile/MobilePanel';
import MixerPanel from './components/mobile/panels/MixerPanel';
import PluginsPanel from './components/mobile/panels/PluginsPanel';
import KeysPanel from './components/mobile/panels/KeysPanel';
import BrowserPanel from './components/mobile/panels/BrowserPanel';
import SettingsPanel from './components/mobile/panels/SettingsPanel';
import TrackDetailPanel from './components/mobile/panels/TrackDetailPanel';
import AutomationPanel from './components/mobile/panels/AutomationPanel';

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

const createInitialSends = (bpm: number, outputId: string = 'master'): Track[] => [
  { 
    id: 'send-delay', 
    name: 'DELAY 1/4', 
    type: TrackType.SEND, 
    color: '#00f2ff', 
    isMuted: false, 
    isSolo: false, 
    isTrackArmed: false, 
    isFrozen: false, 
    volume: 0.8, 
    pan: 0, 
    outputTrackId: outputId, 
    sends: [], 
    clips: [], 
    plugins: [createDefaultPlugins('DELAY', 1.0, bpm)], 
    automationLanes: [createDefaultAutomation('volume', '#00f2ff')], 
    totalLatency: 0 
  },
  { 
    id: 'send-verb-short', 
    name: 'VERB PRO', 
    type: TrackType.SEND, 
    color: '#10b981', 
    isMuted: false, 
    isSolo: false, 
    isTrackArmed: false, 
    isFrozen: false, 
    volume: 0.7, 
    pan: 0, 
    outputTrackId: outputId, 
    sends: [], 
    clips: [], 
    plugins: [createDefaultPlugins('REVERB', 1.0, bpm, { decay: 1.2, preDelay: 0.01, size: 0.4, mode: 'PLATE' })], 
    automationLanes: [createDefaultAutomation('volume', '#10b981')], 
    totalLatency: 0 
  },
  { 
    id: 'send-verb-long', 
    name: 'HALL SPACE', 
    type: TrackType.SEND, 
    color: '#a855f7', 
    isMuted: false, 
    isSolo: false, 
    isTrackArmed: false, 
    isFrozen: false, 
    volume: 0.6, 
    pan: 0, 
    outputTrackId: outputId, 
    sends: [], 
    clips: [], 
    plugins: [createDefaultPlugins('REVERB', 1.0, bpm, { decay: 3.5, preDelay: 0.05, size: 0.9, mode: 'HALL' })], 
    automationLanes: [createDefaultAutomation('volume', '#a855f7')], 
    totalLatency: 0 
  }
];

const createBusVox = (defaultSends: TrackSend[], bpm: number): Track => ({
  id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, color: '#fbbf24', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'master', sends: [...defaultSends], clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#fbbf24')], totalLatency: 0
});

const createBusFx = (): Track => ({
  id: 'bus-fx',
  name: 'BUS FX',
  type: TrackType.BUS,
  color: '#ec4899', // Pink
  isMuted: false,
  isSolo: false,
  isTrackArmed: false,
  isFrozen: false,
  volume: 1.0,
  pan: 0,
  outputTrackId: 'master',
  sends: [],
  clips: [],
  plugins: [],
  automationLanes: [createDefaultAutomation('volume', '#ec4899')],
  totalLatency: 0
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

const MobileBottomNav: React.FC<{ activeTab: MobileTab, onTabChange: (tab: MobileTab) => void }> = ({ activeTab, onTabChange }) => {
  const tabs: { id: MobileTab; icon: string; label: string }[] = [
    { id: 'TRACKS', icon: 'fa-layer-group', label: 'Pistes' },
    { id: 'MIX', icon: 'fa-sliders-h', label: 'Mix' },
    { id: 'REC', icon: 'fa-microphone', label: 'Rec' },
    { id: 'BROWSER', icon: 'fa-folder-open', label: 'Sons' },
    { id: 'NOVA', icon: 'fa-robot', label: 'AI' },
    { id: 'SETTINGS', icon: 'fa-cog', label: 'Config' },
  ];

  return (
    <div className="h-16 bg-[#08090b] border-t border-white/10 flex items-center justify-around z-50 px-1" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`flex flex-col items-center justify-center flex-1 py-2 rounded-lg transition-all ${
            activeTab === tab.id
              ? 'text-cyan-400 bg-cyan-500/10'
              : 'text-slate-500 active:bg-white/5'
          }`}
        >
          <i className={`fas ${tab.icon} text-base`}></i>
          <span className="text-[8px] font-bold mt-1 uppercase tracking-wide">{tab.label}</span>
        </button>
      ))}
    </div>
  );
};

// Helper function pour formater le temps
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

// Vue mobile des pistes
const MobileTracksView: React.FC<{
  tracks: Track[];
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
  onUpdateTrack: (track: Track) => void;
  isPlaying: boolean;
  currentTime: number;
}> = ({ tracks, selectedTrackId, onSelectTrack, onUpdateTrack, isPlaying, currentTime }) => {
  const mainTracks = tracks.filter(t =>
    t.type === TrackType.AUDIO || t.type === TrackType.MIDI || t.type === TrackType.DRUM_RACK
  );

  return (
    <div className="flex-1 overflow-y-auto bg-[#0c0d10]">
      <div className="sticky top-0 z-10 bg-[#08090b] border-b border-white/10 p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${isPlaying ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          <span className="font-mono text-lg text-white">{formatTime(currentTime)}</span>
        </div>
        <span className="text-xs text-slate-500">{mainTracks.length} pistes</span>
      </div>

      <div className="p-3 space-y-2">
        {mainTracks.map(track => (
          <div
            key={track.id}
            onClick={() => onSelectTrack(track.id)}
            className={`p-4 rounded-xl border transition-all active:scale-[0.98] ${
              selectedTrackId === track.id
                ? 'bg-white/10 border-cyan-500/50'
                : 'bg-white/5 border-white/5'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: track.color + '30' }}
                >
                  <i className={`fas ${
                    track.type === TrackType.AUDIO ? 'fa-waveform' :
                    track.type === TrackType.DRUM_RACK ? 'fa-drum' : 'fa-music'
                  } text-white`}></i>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">{track.name}</h3>
                  <p className="text-[10px] text-slate-500">{track.clips.length} clips</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isMuted: !track.isMuted }); }}
                  className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    track.isMuted ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-slate-500'
                  }`}
                >
                  <i className="fas fa-volume-mute text-sm"></i>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...track, isSolo: !track.isSolo }); }}
                  className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    track.isSolo ? 'bg-yellow-500/20 text-yellow-400' : 'bg-white/5 text-slate-500'
                  }`}
                >
                  <span className="text-xs font-black">S</span>
                </button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <i className="fas fa-volume-up text-slate-500 text-xs"></i>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.01"
                value={track.volume}
                onChange={(e) => onUpdateTrack({ ...track, volume: parseFloat(e.target.value) })}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 h-2 rounded-full appearance-none bg-white/10"
                style={{ accentColor: track.color }}
              />
              <span className="text-[10px] font-mono text-slate-400 w-8">{Math.round(track.volume * 100)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Vue mobile d'enregistrement
const MobileRecordView: React.FC<{
  tracks: Track[];
  isRecording: boolean;
  isPlaying: boolean;
  currentTime: number;
  onToggleRecord: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onUpdateTrack: (track: Track) => void;
}> = ({ tracks, isRecording, isPlaying, currentTime, onToggleRecord, onTogglePlay, onStop, onUpdateTrack }) => {
  const armedTrack = tracks.find(t => t.isTrackArmed);
  const recordableTracks = tracks.filter(t => t.type === TrackType.AUDIO || t.type === TrackType.MIDI);

  return (
    <div className="flex-1 flex flex-col bg-[#0c0d10] overflow-hidden">
      <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-8">
        <div className="text-center">
          <span className="font-mono text-4xl font-bold text-white">{formatTime(currentTime)}</span>
          <p className="text-xs text-slate-500 mt-2">
            {isRecording ? '● ENREGISTREMENT EN COURS' : 'Prêt à enregistrer'}
          </p>
        </div>

        <button
          onClick={onToggleRecord}
          className={`w-32 h-32 rounded-full flex items-center justify-center transition-all shadow-2xl ${
            isRecording
              ? 'bg-red-500 shadow-red-500/50 animate-pulse'
              : armedTrack
                ? 'bg-gradient-to-br from-red-600 to-red-700 shadow-red-500/30 active:scale-95'
                : 'bg-slate-700 cursor-not-allowed'
          }`}
          disabled={!armedTrack && !isRecording}
        >
          <i className={`fas ${isRecording ? 'fa-stop' : 'fa-circle'} text-white text-4xl`}></i>
        </button>

        <div className="flex items-center gap-4">
          <button
            onClick={onStop}
            className="w-14 h-14 rounded-full bg-white/10 flex items-center justify-center active:bg-white/20"
          >
            <i className="fas fa-stop text-white"></i>
          </button>
          <button
            onClick={onTogglePlay}
            className={`w-14 h-14 rounded-full flex items-center justify-center ${
              isPlaying ? 'bg-cyan-500' : 'bg-white/10'
            } active:scale-95`}
          >
            <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-white`}></i>
          </button>
        </div>

        {!armedTrack && !isRecording && (
          <p className="text-center text-sm text-amber-400 bg-amber-500/10 px-4 py-2 rounded-xl">
            <i className="fas fa-exclamation-triangle mr-2"></i>
            Sélectionnez une piste ci-dessous
          </p>
        )}
      </div>

      <div className="bg-[#08090b] border-t border-white/10 p-4">
        <p className="text-[10px] font-bold text-slate-500 uppercase mb-3">Piste à enregistrer</p>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {recordableTracks.map(track => (
            <button
              key={track.id}
              onClick={() => {
                recordableTracks.forEach(t => {
                  if (t.id === track.id) {
                    onUpdateTrack({ ...t, isTrackArmed: !t.isTrackArmed });
                  } else if (t.isTrackArmed) {
                    onUpdateTrack({ ...t, isTrackArmed: false });
                  }
                });
              }}
              className={`flex-shrink-0 px-4 py-3 rounded-xl border transition-all ${
                track.isTrackArmed
                  ? 'bg-red-500/20 border-red-500 text-red-400'
                  : 'bg-white/5 border-white/10 text-slate-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: track.color }}></div>
                <span className="text-xs font-bold whitespace-nowrap">{track.name}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// Vue mobile du navigateur de sons
const MobileBrowserView: React.FC<{
  onImportAudio: (file: File) => void;
  onAddPlugin: (trackId: string, type: PluginType) => void;
  selectedTrackId: string | null;
}> = ({ onImportAudio, onAddPlugin, selectedTrackId }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeSection, setActiveSection] = useState<'SAMPLES' | 'FX'>('SAMPLES');

  const fxList = [
    { type: 'REVERB', name: 'Reverb', icon: 'fa-mountain-sun', color: '#10b981' },
    { type: 'DELAY', name: 'Delay', icon: 'fa-history', color: '#3b82f6' },
    { type: 'COMPRESSOR', name: 'Compressor', icon: 'fa-compress-alt', color: '#f59e0b' },
    { type: 'AUTOTUNE', name: 'Auto-Tune', icon: 'fa-microphone-alt', color: '#ec4899' },
    { type: 'VOCALSATURATOR', name: 'Saturator', icon: 'fa-fire', color: '#ef4444' },
    { type: 'PROEQ12', name: 'EQ Pro', icon: 'fa-wave-square', color: '#8b5cf6' },
    { type: 'CHORUS', name: 'Chorus', icon: 'fa-layer-group', color: '#06b6d4' },
    { type: 'DEESSER', name: 'De-Esser', icon: 'fa-scissors', color: '#84cc16' },
  ];

  return (
    <div className="flex-1 flex flex-col bg-[#0c0d10] overflow-hidden">
      <div className="flex border-b border-white/10">
        <button
          onClick={() => setActiveSection('SAMPLES')}
          className={`flex-1 py-4 text-sm font-bold transition-all ${
            activeSection === 'SAMPLES' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500'
          }`}
        >
          <i className="fas fa-file-audio mr-2"></i>Samples
        </button>
        <button
          onClick={() => setActiveSection('FX')}
          className={`flex-1 py-4 text-sm font-bold transition-all ${
            activeSection === 'FX' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500'
          }`}
        >
          <i className="fas fa-magic mr-2"></i>Effets
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeSection === 'SAMPLES' ? (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.ogg,.flac"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onImportAudio(file);
                e.target.value = '';
              }}
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-6 rounded-2xl border-2 border-dashed border-cyan-500/30 bg-cyan-500/5 flex flex-col items-center justify-center gap-2 active:bg-cyan-500/10"
            >
              <i className="fas fa-cloud-upload-alt text-3xl text-cyan-400"></i>
              <span className="text-sm font-bold text-cyan-400">Importer un fichier audio</span>
              <span className="text-[10px] text-slate-500">MP3, WAV, OGG, FLAC</span>
            </button>

            <div className="text-center py-8">
              <i className="fas fa-folder-open text-4xl text-slate-700 mb-3"></i>
              <p className="text-sm text-slate-500">Les samples cloud arrivent bientôt...</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {fxList.map(fx => (
              <button
                key={fx.type}
                onClick={() => {
                  if (selectedTrackId) {
                    onAddPlugin(selectedTrackId, fx.type as PluginType);
                  }
                }}
                disabled={!selectedTrackId}
                className={`p-4 rounded-xl border transition-all ${
                  selectedTrackId
                    ? 'bg-white/5 border-white/10 active:bg-white/10'
                    : 'bg-white/2 border-white/5 opacity-50'
                }`}
              >
                <div
                  className="w-12 h-12 rounded-xl mb-3 flex items-center justify-center mx-auto"
                  style={{ backgroundColor: fx.color + '20' }}
                >
                  <i className={`fas ${fx.icon} text-xl`} style={{ color: fx.color }}></i>
                </div>
                <span className="text-xs font-bold text-white block">{fx.name}</span>
              </button>
            ))}

            {!selectedTrackId && (
              <div className="col-span-2 text-center py-4">
                <p className="text-xs text-amber-400">
                  <i className="fas fa-info-circle mr-1"></i>
                  Sélectionnez une piste dans l'onglet Pistes
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Vue mobile des paramètres
const MobileSettingsView: React.FC<{
  bpm: number;
  onBpmChange: (bpm: number) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenAudioSettings: () => void;
}> = ({ bpm, onBpmChange, theme, onToggleTheme, onOpenAudioSettings }) => {
  return (
    <div className="flex-1 overflow-y-auto bg-[#0c0d10] p-4 space-y-4">
      <div className="bg-white/5 rounded-2xl p-5 border border-white/10">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-white">Tempo</h3>
            <p className="text-[10px] text-slate-500">Vitesse du projet</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onBpmChange(Math.max(20, bpm - 1))}
              className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center active:bg-white/20"
            >
              <i className="fas fa-minus text-white text-sm"></i>
            </button>
            <span className="font-mono text-2xl font-bold text-cyan-400 w-16 text-center">{bpm}</span>
            <button
              onClick={() => onBpmChange(Math.min(999, bpm + 1))}
              className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center active:bg-white/20"
            >
              <i className="fas fa-plus text-white text-sm"></i>
            </button>
          </div>
        </div>
        <input
          type="range"
          min="20"
          max="300"
          value={bpm}
          onChange={(e) => onBpmChange(parseInt(e.target.value))}
          className="w-full h-2 rounded-full appearance-none bg-white/10"
        />
      </div>

      <div className="bg-white/5 rounded-2xl p-5 border border-white/10">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white">Thème</h3>
            <p className="text-[10px] text-slate-500">{theme === 'dark' ? 'Mode sombre' : 'Mode clair'}</p>
          </div>
          <button
            onClick={onToggleTheme}
            className={`w-14 h-8 rounded-full transition-all ${
              theme === 'light' ? 'bg-cyan-500' : 'bg-white/20'
            } relative`}
          >
            <div className={`absolute top-1 w-6 h-6 rounded-full bg-white shadow transition-all ${
              theme === 'light' ? 'right-1' : 'left-1'
            }`}>
              <i className={`fas ${theme === 'light' ? 'fa-sun' : 'fa-moon'} text-xs text-slate-700 absolute inset-0 flex items-center justify-center`}></i>
            </div>
          </button>
        </div>
      </div>

      <button
        onClick={onOpenAudioSettings}
        className="w-full bg-white/5 rounded-2xl p-5 border border-white/10 flex items-center justify-between active:bg-white/10"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <i className="fas fa-cog text-purple-400"></i>
          </div>
          <div className="text-left">
            <h3 className="text-sm font-bold text-white">Paramètres Audio</h3>
            <p className="text-[10px] text-slate-500">Carte son, latence, buffer</p>
          </div>
        </div>
        <i className="fas fa-chevron-right text-slate-500"></i>
      </button>

      <div className="text-center py-6">
        <p className="text-[10px] text-slate-600">Nova DAW v2.0 - Mobile Edition</p>
      </div>
    </div>
  );
};

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
    isLoopActive: false, loopStart: 0, loopEnd: 8,
    tracks: [
      { id: 'instrumental', name: 'BEAT', type: TrackType.AUDIO, color: '#eab308', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 0.7, pan: 0, outputTrackId: 'master', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#eab308')], totalLatency: 0 },
      { id: 'track-rec-main', name: 'REC', type: TrackType.AUDIO, color: '#ff0000', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#ff0000')], totalLatency: 0 },
      { id: 'lead-couplet', name: 'LEAD COUPLET', type: TrackType.AUDIO, color: '#3b82f6', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#3b82f6')], totalLatency: 0 },
      { id: 'lead-refrain', name: 'LEAD REFRAIN', type: TrackType.AUDIO, color: '#60a5fa', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#60a5fa')], totalLatency: 0 },
      { id: 'back-1', name: 'BACK 1', type: TrackType.AUDIO, color: '#a855f7', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#a855f7')], totalLatency: 0 },
      { id: 'back-2', name: 'BACK 2', type: TrackType.AUDIO, color: '#c084fc', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#c084fc')], totalLatency: 0 },
      createBusVox(createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), AUDIO_CONFIG.DEFAULT_BPM), 
      createBusFx(),
      ...createInitialSends(AUDIO_CONFIG.DEFAULT_BPM, 'bus-fx')
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
  const globalFileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { if (audioEngine.ctx) state.tracks.forEach(t => audioEngine.updateTrack(t, state.tracks)); }, [state.tracks]); 
  useEffect(() => { audioEngine.setLoop(state.isLoopActive, state.loopStart, state.loopEnd); }, [state.isLoopActive, state.loopStart, state.loopEnd]);
  
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (stateRef.current.isPlaying) {
         const time = audioEngine.getCurrentTime();
         setVisualState({ currentTime: time });
         animId = requestAnimationFrame(updateLoop);
      }
    };
    if (state.isPlaying) { animId = requestAnimationFrame(updateLoop); }
    return () => cancelAnimationFrame(animId);
  }, [state.isPlaying, setVisualState]);

  const [activePlugin, setActivePlugin] = useState<{trackId: string, plugin: PluginInstance} | null>(null);
  const [clipboardClip, setClipboardClip] = useState<{ clip: Clip; sourceTrackId: string } | null>(null);
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
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>('TRACKS');
  const handleViewModeChange = (mode: ViewMode) => { setViewMode(mode); localStorage.setItem('nova_view_mode', mode); };
  useEffect(() => { document.body.setAttribute('data-view-mode', viewMode); }, [viewMode]);
  const isMobile = viewMode === 'MOBILE';
  
  // Mobile Panel System Configuration
  const MOBILE_PANELS: PanelConfig[] = [
    { 
      id: 'mixer', 
      title: 'Mix', 
      icon: 'fa-sliders-h', 
      component: MixerPanel, 
      defaultHeight: 'half', 
      canResize: true 
    },
    { 
      id: 'keys', 
      title: 'Clavier', 
      icon: 'fa-piano-keyboard', 
      component: KeysPanel, 
      defaultHeight: 'full', 
      canResize: true 
    },
    { 
      id: 'plugins', 
      title: 'Plugins', 
      icon: 'fa-puzzle-piece', 
      component: PluginsPanel, 
      defaultHeight: 'half', 
      canResize: true 
    },
    { 
      id: 'browser', 
      title: 'Sons', 
      icon: 'fa-folder', 
      component: BrowserPanel, 
      defaultHeight: 'half', 
      canResize: true 
    },
    { 
      id: 'settings', 
      title: 'Options', 
      icon: 'fa-cog', 
      component: SettingsPanel, 
      defaultHeight: 'half', 
      canResize: false 
    },
  ];
  
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
    // Handle CUT and COPY outside of produce to access setClipboardClip
    if (action === 'CUT' || action === 'COPY') {
      const track = state.tracks.find(t => t.id === trackId);
      if (!track) return;
      const clip = track.clips.find(c => c.id === clipId);
      if (!clip) return;

      // Store clip in clipboard
      setClipboardClip({ clip: { ...clip }, sourceTrackId: trackId });
      setAiNotification(`📋 Clip "${clip.name}" copié`);
      setTimeout(() => setAiNotification(null), 2000);

      // If CUT, also delete the clip
      if (action === 'CUT') {
        setState(produce((draft: DAWState) => {
          const t = draft.tracks.find(tr => tr.id === trackId);
          if (t) {
            t.clips = t.clips.filter(c => c.id !== clipId);
          }
        }));
      }
      return;
    }

    // Handle PASTE - needs clipboard access
    if (action === 'PASTE') {
      if (!clipboardClip) {
        setAiNotification(`⚠️ Rien à coller`);
        setTimeout(() => setAiNotification(null), 2000);
        return;
      }

      setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === trackId);
        if (!track) return;

        const pasteTime = payload?.time ?? stateRef.current.currentTime;
        const newClip: Clip = {
          ...clipboardClip.clip,
          id: `clip-paste-${Date.now()}`,
          start: pasteTime,
        };
        track.clips.push(newClip);
      }));

      setAiNotification(`✅ Clip collé à ${payload?.time?.toFixed(2) ?? stateRef.current.currentTime.toFixed(2)}s`);
      setTimeout(() => setAiNotification(null), 2000);
      return;
    }

    setState(produce((draft: DAWState) => {
      const track = draft.tracks.find(t => t.id === trackId);
      if (!track) return;
      let newClips = [...track.clips];
      const idx = newClips.findIndex(c => c.id === clipId);
      if (idx === -1) return;

      switch(action) {
        case 'UPDATE_PROPS':
          if(idx > -1) newClips[idx] = { ...newClips[idx], ...payload };
          break;
        case 'DELETE':
          if(idx > -1) newClips.splice(idx, 1);
          break;
        case 'MUTE':
          if(idx > -1) newClips[idx] = { ...newClips[idx], isMuted: !newClips[idx].isMuted };
          break;
        case 'DUPLICATE':
          if(idx > -1) newClips.push({ ...newClips[idx], id: `clip-dup-${Date.now()}`, start: newClips[idx].start + newClips[idx].duration + 0.1 });
          break;
        case 'RENAME':
          if(idx > -1) newClips[idx] = { ...newClips[idx], name: payload.name };
          break;
        case 'SPLIT':
          if(idx > -1) {
            const clip = newClips[idx];
            const splitTime = payload.time;
            if (splitTime > clip.start && splitTime < clip.start + clip.duration) {
              const firstDuration = splitTime - clip.start;
              const secondDuration = clip.duration - firstDuration;
              newClips[idx] = { ...clip, duration: firstDuration };
              newClips.push({ ...clip, id: `clip-split-${Date.now()}`, start: splitTime, duration: secondDuration, offset: (clip.offset || 0) + firstDuration });
            }
          }
          break;
        case 'REVERSE':
          if(idx > -1) {
            newClips[idx] = { ...newClips[idx], isReversed: !newClips[idx].isReversed };
          }
          break;
        case 'SET_GAIN':
          if(idx > -1 && payload?.gain !== undefined) {
            newClips[idx] = { ...newClips[idx], gain: payload.gain };
          }
          break;
        case 'NORMALIZE':
          if(idx > -1) {
            // Reset gain to 1.0 (normalized)
            newClips[idx] = { ...newClips[idx], gain: 1.0 };
          }
          break;
      }
      track.clips = newClips;
    }));
  };

  const handleUpdateBpm = useCallback((newBpm: number) => { setState(prev => ({ ...prev, bpm: Math.max(20, Math.min(999, newBpm)) })); }, [setState]);
  
  const handleUpdateTrack = useCallback((updatedTrack: Track) => {
    const previousTrack = stateRef.current.tracks.find(t => t.id === updatedTrack.id);

    if (previousTrack && previousTrack.isTrackArmed !== updatedTrack.isTrackArmed) {
        if (updatedTrack.isTrackArmed) {
            audioEngine.armTrack(updatedTrack.id);
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
  
    const armedTrack = currentState.tracks.find(t => t.isTrackArmed);
    if (armedTrack) {
      const success = await audioEngine.startRecording(currentState.currentTime, armedTrack.id);
      if (success) {
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


  const handleDuplicateTrack = useCallback((trackId: string) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === trackId);
        if (!track) return;
        
        const newTrack: Track = {
            ...track,
            id: `track-${Date.now()}`,
            name: `${track.name} (Copy)`,
            clips: track.clips.map(clip => ({
                ...clip,
                id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            })),
            plugins: track.plugins.map(plugin => ({
                ...plugin,
                id: `plugin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            })),
            automationLanes: []
        };
        
        const index = draft.tracks.findIndex(t => t.id === trackId);
        draft.tracks.splice(index + 1, 0, newTrack);
    }));
  }, [setState]);

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

  const handleDeleteTrack = useCallback((trackId: string) => {
    if (trackId === 'track-rec-main') {
        console.warn("La piste d'enregistrement principale ne peut pas être supprimée.");
        setAiNotification(`⚠️ La piste "REC" est protégée et ne peut être supprimée.`);
        setTimeout(() => setAiNotification(null), 3000);
        return;
    }
    setState(produce((draft: DAWState) => {
        const trackIndex = draft.tracks.findIndex(t => t.id === trackId);
        if (trackIndex > -1) {
            draft.tracks.splice(trackIndex, 1);
            if (draft.selectedTrackId === trackId) {
                draft.selectedTrackId = draft.tracks[0]?.id || null;
            }
        }
    }));
  }, [setState]);
  
  const handleRemovePlugin = useCallback((tid: string, pid: string) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === tid);
        if (!track) return;
        
        const index = track.plugins.findIndex(p => p.id === pid);
        if (index !== -1) {
            track.plugins.splice(index, 1);
        }
    }));
    
    if (activePlugin?.plugin.id === pid) {
        setActivePlugin(null);
    }
  }, [setState, activePlugin]);
  
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

  const handleUniversalAudioImport = async (source: string | File, name: string, forcedTrackId?: string, startTime?: number) => {
      setExternalImportNotice(`Chargement: ${name}...`);
      try {
          await ensureAudioEngine();

          let audioBuffer: AudioBuffer;
          let audioRef: string;

          if (source instanceof File) {
              audioRef = URL.createObjectURL(source);
              const arrayBuffer = await source.arrayBuffer();
              audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          } else {
              audioRef = source;
              const response = await fetch(source);
              if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
              const arrayBuffer = await response.arrayBuffer();
              audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          }

          // IMPORTANT: Register buffer in registry OUTSIDE of React state
          // This avoids Immer proxy issues with native AudioBuffer objects
          const bufferId = audioBufferRegistry.register(audioBuffer, audioRef);

          const clipName = name.replace(/\.[^/.]+$/, '');
          const clipId = `clip-${Date.now()}`;
          const clipDuration = audioBuffer.duration;
          const clipStart = startTime ?? stateRef.current.currentTime;
          const clipColor = UI_CONFIG.TRACK_COLORS[stateRef.current.tracks.length % UI_CONFIG.TRACK_COLORS.length];

          setState(produce((draft: DAWState) => {
              let targetTrackId: string | null = null;
              let isNewTrackNeeded = false;

              if (forcedTrackId) {
                  targetTrackId = forcedTrackId;
              } else {
                  const beatTrack = draft.tracks.find(t => t.id === 'instrumental');
                  if (beatTrack && beatTrack.clips.length === 0) {
                      targetTrackId = 'instrumental';
                  } else {
                      isNewTrackNeeded = true;
                      targetTrackId = `track-audio-${Date.now()}`;
                  }
              }

              // Create clip WITHOUT AudioBuffer - only bufferId reference
              const newClip: Clip = {
                  id: clipId,
                  name: clipName,
                  type: TrackType.AUDIO,
                  start: clipStart,
                  duration: clipDuration,
                  offset: 0,
                  bufferId: bufferId,  // Reference to registry, NOT the actual buffer
                  audioRef,
                  color: clipColor,
                  fadeIn: 0,
                  fadeOut: 0,
                  gain: 1.0,
                  isMuted: false
              };

              if (isNewTrackNeeded) {
                  const newTrack: Track = {
                      id: targetTrackId!,
                      name: name.substring(0, 20),
                      type: TrackType.AUDIO,
                      color: UI_CONFIG.TRACK_COLORS[draft.tracks.length % UI_CONFIG.TRACK_COLORS.length],
                      isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
                      volume: 1.0, pan: 0, outputTrackId: 'master',
                      sends: [], clips: [newClip], plugins: [], automationLanes: [], totalLatency: 0
                  };
                  draft.tracks.splice(1, 0, newTrack);
                  draft.selectedTrackId = targetTrackId;
              } else {
                  const track = draft.tracks.find(t => t.id === targetTrackId);
                  if (track) {
                      track.clips.push(newClip);
                      draft.selectedTrackId = targetTrackId;
                  }
              }
          }));

          setExternalImportNotice(`✅ Importé: ${clipName}`);
          console.log(`[AudioImport] Successfully imported: ${clipName} (bufferId: ${bufferId})`);

      } catch (e: any) {
          console.error("[Import Error]", e);
          setExternalImportNotice(`❌ Erreur: ${e.message || "Import échoué"}`);
      } finally {
          setTimeout(() => setExternalImportNotice(null), 3000);
      }
  };

  useEffect(() => { 
      (window as any).DAW_CORE = { 
          handleAudioImport: (url: string | File, name: string, trackId?: string) => handleUniversalAudioImport(url, name, trackId) 
      }; 
  }, [handleUniversalAudioImport]);

  const handleMoveClip = useCallback((sourceTrackId: string, destTrackId: string, clipId: string) => {
    setState(produce((draft: DAWState) => {
        const sourceTrack = draft.tracks.find(t => t.id === sourceTrackId);
        const destTrack = draft.tracks.find(t => t.id === destTrackId);
        if (!sourceTrack || !destTrack) return;
        
        const clipIndex = sourceTrack.clips.findIndex(c => c.id === clipId);
        if (clipIndex === -1) return;
        
        const [clip] = sourceTrack.clips.splice(clipIndex, 1);
        destTrack.clips.push(clip);
    }));
  }, [setState]);
  const handleCreatePatternAndOpen = useCallback((trackId: string, time: number) => { /* ... */ }, [setState]);
  const handleSwapInstrument = useCallback((trackId: string) => { /* ... */ }, []);
  const handleAddBus = useCallback(() => { handleCreateTrack(TrackType.BUS, "Group Bus"); }, [handleCreateTrack]);
  const handleToggleBypass = useCallback((trackId: string, pluginId: string) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === trackId);
        if (!track) return;
        
        const plugin = track.plugins.find(p => p.id === pluginId);
        if (plugin) {
            plugin.isEnabled = !plugin.isEnabled;
        }
    }));
  }, [setState]);
  const handleCreateAutomationLane = useCallback(() => {
    if (!automationMenu) return;
    
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === automationMenu.trackId);
        if (!track) return;
        
        const newLane: AutomationLane = {
            id: `lane-${Date.now()}`,
            parameterName: automationMenu.paramName || 'volume',
            points: [],
            color: '#00f2ff',
            isExpanded: true,
            min: automationMenu.min,
            max: automationMenu.max,
        };
        
        track.automationLanes.push(newLane);
    }));
    
    setAutomationMenu(null);
  }, [automationMenu, setState]);
  const handleToggleDelayComp = useCallback(() => { /* ... */ }, [state.isDelayCompEnabled, setState]);
  const handleLoadDrumSample = useCallback(async (trackId: string, padId: number, file: File) => {
    try {
        await ensureAudioEngine();
        
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
        const audioRef = URL.createObjectURL(file);
        
        setState(produce((draft: DAWState) => {
            const track = draft.tracks.find(t => t.id === trackId);
            if (!track || !track.drumPads) return;
            
            const pad = track.drumPads.find(p => p.id === padId);
            if (pad) {
                pad.sampleName = file.name.replace(/\.[^/.]+$/, '');
                pad.buffer = audioBuffer;
                pad.audioRef = audioRef;
            }
        }));
        
        // Also update the DrumRack node in AudioEngine
        audioEngine.loadDrumRackSample(trackId, padId, audioBuffer);
        
        console.log(`[DrumSample] Loaded ${file.name} on pad ${padId}`);
    } catch (error) {
        console.error('[DrumSample] Error loading sample:', error);
    }
}, [setState, ensureAudioEngine]);

  useEffect(() => {
    (window as any).DAW_CONTROL = {
      // ... (All functions mapped) ...
      loadDrumSample: handleLoadDrumSample
    };
  }, [handleUpdateBpm, handleUpdateTrack, handleTogglePlay, handleStop, handleSeek, handleDuplicateTrack, handleCreateTrack, handleDeleteTrack, handleToggleBypass, handleLoadDrumSample, handleEditClip]);

  const executeAIAction = useCallback((a: AIAction) => {
    console.log('[AI Action]', a.action, a.payload);

    switch (a.action) {
      // === TRANSPORT ===
      case 'PLAY':
        handleTogglePlay();
        break;
      case 'STOP':
        handleStop();
        break;
      case 'RECORD':
        handleToggleRecord();
        break;
      case 'SEEK':
        if (a.payload?.time !== undefined) handleSeek(a.payload.time);
        break;
      case 'SET_BPM':
        if (a.payload?.bpm) handleUpdateBpm(a.payload.bpm);
        break;
      case 'SET_LOOP':
        setState(prev => ({
          ...prev,
          isLoopActive: true,
          loopStart: a.payload?.start ?? prev.loopStart,
          loopEnd: a.payload?.end ?? prev.loopEnd
        }));
        break;
      case 'TOGGLE_LOOP':
        setState(prev => ({ ...prev, isLoopActive: !prev.isLoopActive }));
        break;

      // === TRACK MANAGEMENT ===
      case 'SET_VOLUME':
        if (a.payload?.trackId) {
          const track = stateRef.current.tracks.find(t => t.id === a.payload.trackId);
          if (track) handleUpdateTrack({ ...track, volume: a.payload.volume ?? track.volume });
        }
        break;
      case 'SET_PAN':
        if (a.payload?.trackId) {
          const track = stateRef.current.tracks.find(t => t.id === a.payload.trackId);
          if (track) handleUpdateTrack({ ...track, pan: a.payload.pan ?? track.pan });
        }
        break;
      case 'MUTE_TRACK':
        if (a.payload?.trackId) {
          const track = stateRef.current.tracks.find(t => t.id === a.payload.trackId);
          if (track) handleUpdateTrack({ ...track, isMuted: a.payload.isMuted ?? !track.isMuted });
        }
        break;
      case 'SOLO_TRACK':
        if (a.payload?.trackId) {
          const track = stateRef.current.tracks.find(t => t.id === a.payload.trackId);
          if (track) handleUpdateTrack({ ...track, isSolo: a.payload.isSolo ?? !track.isSolo });
        }
        break;
      case 'RENAME_TRACK':
        if (a.payload?.trackId && a.payload?.name) {
          const track = stateRef.current.tracks.find(t => t.id === a.payload.trackId);
          if (track) handleUpdateTrack({ ...track, name: a.payload.name });
        }
        break;
      case 'DUPLICATE_TRACK':
        if (a.payload?.trackId) handleDuplicateTrack(a.payload.trackId);
        break;
      case 'DELETE_TRACK':
        if (a.payload?.trackId) handleDeleteTrack(a.payload.trackId);
        break;
      case 'ADD_TRACK':
      case 'CREATE_TRACK':
        handleCreateTrack(
          a.payload?.type || TrackType.AUDIO,
          a.payload?.name,
          a.payload?.pluginType
        );
        break;
      case 'ARM_TRACK':
        if (a.payload?.trackId) {
          const track = stateRef.current.tracks.find(t => t.id === a.payload.trackId);
          if (track) handleUpdateTrack({ ...track, isTrackArmed: a.payload.isArmed ?? true });
        }
        break;
      case 'SELECT_TRACK':
        if (a.payload?.trackId) {
          setState(prev => ({ ...prev, selectedTrackId: a.payload.trackId }));
        }
        break;

      // === PLUGIN MANAGEMENT ===
      case 'ADD_PLUGIN':
      case 'OPEN_PLUGIN':
        if (a.payload?.trackId && a.payload?.type) {
          handleAddPluginFromContext(
            a.payload.trackId,
            a.payload.type as PluginType,
            a.payload.params || {},
            { openUI: a.action === 'OPEN_PLUGIN' }
          );
        }
        break;
      case 'REMOVE_PLUGIN':
        if (a.payload?.trackId && a.payload?.pluginId) {
          handleRemovePlugin(a.payload.trackId, a.payload.pluginId);
        }
        break;
      case 'BYPASS_PLUGIN':
        if (a.payload?.trackId && a.payload?.pluginId) {
          handleToggleBypass(a.payload.trackId, a.payload.pluginId);
        }
        break;
      case 'SET_PLUGIN_PARAM':
      case 'UPDATE_PLUGIN':
        if (a.payload?.trackId && a.payload?.pluginId && a.payload?.params) {
          handleUpdatePluginParams(a.payload.trackId, a.payload.pluginId, a.payload.params);
        }
        break;
      case 'CLOSE_PLUGIN':
        setActivePlugin(null);
        break;

      // === CLIP OPERATIONS ===
      case 'NORMALIZE_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'NORMALIZE');
        }
        break;
      case 'SPLIT_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'SPLIT', { time: a.payload.time ?? stateRef.current.currentTime });
        }
        break;
      case 'MUTE_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'MUTE');
        }
        break;
      case 'DELETE_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'DELETE');
        }
        break;
      case 'DUPLICATE_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'DUPLICATE');
        }
        break;
      case 'SET_CLIP_GAIN':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'SET_GAIN', { gain: a.payload.gain });
        }
        break;
      case 'REVERSE_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'REVERSE');
        }
        break;
      case 'CUT_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'CUT');
        }
        break;
      case 'COPY_CLIP':
        if (a.payload?.trackId && a.payload?.clipId) {
          handleEditClip(a.payload.trackId, a.payload.clipId, 'COPY');
        }
        break;
      case 'PASTE_CLIP':
        if (a.payload?.trackId) {
          handleEditClip(a.payload.trackId, '', 'PASTE', { time: a.payload.time ?? stateRef.current.currentTime });
        }
        break;

      // === SEND/BUS MANAGEMENT ===
      case 'SET_SEND_LEVEL':
        if (a.payload?.trackId && a.payload?.sendId) {
          setState(produce((draft: DAWState) => {
            const track = draft.tracks.find(t => t.id === a.payload.trackId);
            if (track) {
              const send = track.sends.find(s => s.id === a.payload.sendId);
              if (send) {
                send.level = a.payload.level ?? send.level;
                send.isEnabled = a.payload.isEnabled ?? send.isEnabled;
              }
            }
          }));
        }
        break;
      case 'CREATE_BUS':
        handleCreateTrack(TrackType.BUS, a.payload?.name || 'New Bus');
        break;
      case 'ROUTE_TO_BUS':
        if (a.payload?.trackId && a.payload?.busId) {
          setState(produce((draft: DAWState) => {
            const track = draft.tracks.find(t => t.id === a.payload.trackId);
            if (track) {
              track.outputTrackId = a.payload.busId;
            }
          }));
          setAiNotification(`Piste routée vers ${a.payload.busId}`);
          setTimeout(() => setAiNotification(null), 2000);
        }
        break;

      // === SESSION TEMPLATES ===
      case 'SETUP_SESSION':
        setupSessionTemplate(a.payload?.template || 'vocal_full');
        break;

      // === VIEW CONTROL ===
      case 'CHANGE_VIEW':
        if (a.payload?.view) {
          setState(prev => ({ ...prev, currentView: a.payload.view }));
        }
        break;

      // === MIX PRESETS ===
      case 'APPLY_VOCAL_CHAIN':
        applyVocalChainPreset(a.payload?.trackId, a.payload?.preset || 'default');
        break;
      case 'APPLY_MIX_PRESET':
        applyMixPreset(a.payload?.preset || 'balanced');
        break;
      case 'CLEAN_MIX':
        cleanMix();
        break;
      case 'RESET_FX':
        resetAllFx(a.payload?.trackId);
        break;
      case 'PREPARE_REC':
        prepareForRecording(a.payload?.trackId);
        break;

      // === ANALYSIS ===
      case 'RUN_MASTER_SYNC':
      case 'ANALYZE_INSTRU':
        // These would trigger the MasterSync plugin analysis
        const instruTrack = stateRef.current.tracks.find(t => t.id === 'instrumental');
        if (instruTrack) {
          handleAddPluginFromContext('instrumental', 'MASTERSYNC', {}, { openUI: true });
        }
        break;

      // === EXPORT ===
      case 'EXPORT_MIX':
        setIsExportMenuOpen(true);
        break;

      default:
        console.warn('[AI Action] Unhandled action:', a.action);
    }
  }, [handleTogglePlay, handleStop, handleToggleRecord, handleSeek, handleUpdateBpm, setState, handleUpdateTrack, handleDuplicateTrack, handleDeleteTrack, handleCreateTrack, handleAddPluginFromContext, handleRemovePlugin, handleToggleBypass, handleUpdatePluginParams, handleEditClip]);

  // === MIX PRESET FUNCTIONS ===
  const applyVocalChainPreset = useCallback((trackId?: string, preset: string = 'default') => {
    const targetTrackId = trackId || state.selectedTrackId || 'track-rec-main';
    const track = stateRef.current.tracks.find(t => t.id === targetTrackId);
    if (!track) return;

    // Remove existing plugins first
    track.plugins.forEach(p => handleRemovePlugin(targetTrackId, p.id));

    // Define presets
    const presets: Record<string, { plugins: { type: PluginType; params: Record<string, any> }[] }> = {
      'default': {
        plugins: [
          { type: 'DENOISER', params: { threshold: -40, reduction: 0.7, release: 0.15 } },
          { type: 'COMPRESSOR', params: { threshold: -18, ratio: 4, knee: 8, attack: 0.005, release: 0.15, makeupGain: 1.2 } },
          { type: 'PROEQ12', params: { bands: [
            { id: 0, type: 'highpass', frequency: 80, isEnabled: true, gain: 0, q: 0.7 },
            { id: 3, type: 'peaking', frequency: 250, isEnabled: true, gain: -3, q: 1.5 },
            { id: 6, type: 'peaking', frequency: 3000, isEnabled: true, gain: 2, q: 1.2 },
            { id: 9, type: 'peaking', frequency: 8000, isEnabled: true, gain: 1.5, q: 1.0 }
          ]}},
          { type: 'DEESSER', params: { threshold: -25, frequency: 6500, q: 1.0, reduction: 0.5 } }
        ]
      },
      'telephone': {
        plugins: [
          // Aggressive EQ: narrow bandwidth (300-3000Hz) with resonant peaks for classic phone sound
          { type: 'PROEQ12', params: { bands: [
            { id: 0, type: 'highpass', frequency: 300, isEnabled: true, gain: 0, q: 1.5 },  // Sharp HP
            { id: 11, type: 'lowpass', frequency: 3000, isEnabled: true, gain: 0, q: 1.5 },  // Sharp LP
            { id: 2, type: 'peaking', frequency: 800, isEnabled: true, gain: 5, q: 1.5 },   // Low-mid resonance
            { id: 4, type: 'peaking', frequency: 1200, isEnabled: true, gain: 8, q: 2.0 },  // Nasal honk
            { id: 6, type: 'peaking', frequency: 2000, isEnabled: true, gain: 4, q: 1.2 },  // Upper-mid presence
            { id: 8, type: 'peaking', frequency: 200, isEnabled: true, gain: -8, q: 0.7 },  // Cut low rumble
            { id: 9, type: 'peaking', frequency: 4000, isEnabled: true, gain: -12, q: 0.5 } // Cut highs harshly
          ]}},
          // Hard compression for that squashed phone dynamic
          { type: 'COMPRESSOR', params: { threshold: -20, ratio: 12, knee: 0, attack: 0.001, release: 0.05, makeupGain: 1.2 } },
          // Heavy saturation for distortion/crunch
          { type: 'VOCALSATURATOR', params: { drive: 70, mix: 0.8, tone: 0.2, mode: 'TAPE' } }
        ]
      },
      'radio': {
        plugins: [
          { type: 'PROEQ12', params: { bands: [
            { id: 0, type: 'highpass', frequency: 200, isEnabled: true, gain: 0, q: 0.7 },
            { id: 11, type: 'lowpass', frequency: 8000, isEnabled: true, gain: 0, q: 0.7 },
            { id: 4, type: 'peaking', frequency: 800, isEnabled: true, gain: 3, q: 1.0 }
          ]}},
          { type: 'COMPRESSOR', params: { threshold: -12, ratio: 6, attack: 0.001, release: 0.1 } }
        ]
      },
      'aggressive': {
        plugins: [
          { type: 'COMPRESSOR', params: { threshold: -15, ratio: 8, knee: 4, attack: 0.001, release: 0.08, makeupGain: 1.5 } },
          { type: 'VOCALSATURATOR', params: { drive: 50, mix: 0.4, tone: 0.2, mode: 'TAPE' } },
          { type: 'PROEQ12', params: { bands: [
            { id: 0, type: 'highpass', frequency: 100, isEnabled: true, gain: 0, q: 0.7 },
            { id: 5, type: 'peaking', frequency: 2500, isEnabled: true, gain: 4, q: 1.2 },
            { id: 8, type: 'peaking', frequency: 5000, isEnabled: true, gain: 2, q: 1.0 }
          ]}}
        ]
      },
      'soft': {
        plugins: [
          { type: 'DENOISER', params: { threshold: -35, reduction: 0.6, release: 0.2 } },
          { type: 'COMPRESSOR', params: { threshold: -24, ratio: 2, knee: 20, attack: 0.02, release: 0.3 } },
          { type: 'REVERB', params: { mix: 0.15, decay: 1.5, preDelay: 0.02, mode: 'PLATE' } },
          { type: 'CHORUS', params: { rate: 0.8, depth: 0.2, mix: 0.15 } }
        ]
      },
      'autotune': {
        plugins: [
          { type: 'AUTOTUNE', params: { speed: 0.0, humanize: 0.1, mix: 1.0, scale: 'CHROMATIC' } },
          { type: 'COMPRESSOR', params: { threshold: -18, ratio: 4, attack: 0.005, release: 0.15 } },
          { type: 'DELAY', params: { division: '1/8', feedback: 0.2, mix: 0.15 } }
        ]
      }
    };

    const selectedPreset = presets[preset] || presets['default'];

    // Add plugins with delay to ensure proper initialization
    selectedPreset.plugins.forEach((p, i) => {
      setTimeout(() => {
        handleAddPluginFromContext(targetTrackId, p.type, p.params, { openUI: false });
      }, i * 100);
    });

    setAiNotification(`Preset vocal "${preset}" appliqué sur ${track.name}`);
    setTimeout(() => setAiNotification(null), 3000);
  }, [state.selectedTrackId, handleRemovePlugin, handleAddPluginFromContext]);

  const applyMixPreset = useCallback((preset: string = 'balanced') => {
    const presets: Record<string, { description: string; settings: { trackPattern: RegExp; volume: number; pan: number; sends: { id: string; level: number }[] }[] }> = {
      'balanced': {
        description: 'Mix équilibré standard',
        settings: [
          { trackPattern: /instrumental|beat/i, volume: 0.7, pan: 0, sends: [{ id: 'send-delay', level: 0.1 }, { id: 'send-verb-short', level: 0.15 }] },
          { trackPattern: /rec|lead|main/i, volume: 1.0, pan: 0, sends: [{ id: 'send-delay', level: 0.2 }, { id: 'send-verb-short', level: 0.25 }] },
          { trackPattern: /back|double|harm/i, volume: 0.6, pan: 0, sends: [{ id: 'send-verb-long', level: 0.3 }] }
        ]
      },
      'vocal_forward': {
        description: 'Voix en avant, instru en retrait',
        settings: [
          { trackPattern: /instrumental|beat/i, volume: 0.55, pan: 0, sends: [{ id: 'send-delay', level: 0.05 }] },
          { trackPattern: /rec|lead|main/i, volume: 1.2, pan: 0, sends: [{ id: 'send-delay', level: 0.15 }, { id: 'send-verb-short', level: 0.2 }] },
          { trackPattern: /back|double|harm/i, volume: 0.5, pan: 0, sends: [{ id: 'send-verb-short', level: 0.2 }] }
        ]
      },
      'wide_stereo': {
        description: 'Mix large et spatial',
        settings: [
          { trackPattern: /instrumental|beat/i, volume: 0.7, pan: 0, sends: [{ id: 'send-verb-long', level: 0.25 }] },
          { trackPattern: /rec|lead|main/i, volume: 0.95, pan: 0, sends: [{ id: 'send-delay', level: 0.25 }, { id: 'send-verb-short', level: 0.3 }, { id: 'send-verb-long', level: 0.15 }] },
          { trackPattern: /back.*1|double.*1|left/i, volume: 0.55, pan: -0.6, sends: [{ id: 'send-verb-long', level: 0.4 }] },
          { trackPattern: /back.*2|double.*2|right/i, volume: 0.55, pan: 0.6, sends: [{ id: 'send-verb-long', level: 0.4 }] }
        ]
      }
    };

    const selectedPreset = presets[preset] || presets['balanced'];

    setState(produce((draft: DAWState) => {
      selectedPreset.settings.forEach(setting => {
        draft.tracks.forEach(track => {
          if (setting.trackPattern.test(track.name)) {
            track.volume = setting.volume;
            track.pan = setting.pan;
            setting.sends.forEach(sendSetting => {
              const send = track.sends.find(s => s.id === sendSetting.id);
              if (send) {
                send.level = sendSetting.level;
                send.isEnabled = true;
              }
            });
          }
        });
      });
    }));

    setAiNotification(`Preset mix "${preset}" appliqué: ${selectedPreset.description}`);
    setTimeout(() => setAiNotification(null), 3000);
  }, [setState]);

  const cleanMix = useCallback(() => {
    setState(produce((draft: DAWState) => {
      draft.tracks.forEach(track => {
        if (track.type === TrackType.AUDIO || track.type === TrackType.MIDI) {
          track.isMuted = false;
          track.isSolo = false;
          track.volume = 1.0;
          track.pan = 0;
        }
      });
    }));
    setAiNotification('Mix nettoyé: volumes et panoramiques réinitialisés');
    setTimeout(() => setAiNotification(null), 3000);
  }, [setState]);

  const resetAllFx = useCallback((trackId?: string) => {
    if (trackId) {
      const track = stateRef.current.tracks.find(t => t.id === trackId);
      if (track) {
        track.plugins.forEach(p => handleRemovePlugin(trackId, p.id));
        setAiNotification(`Tous les effets supprimés de ${track.name}`);
      }
    } else {
      stateRef.current.tracks.forEach(track => {
        track.plugins.forEach(p => handleRemovePlugin(track.id, p.id));
      });
      setAiNotification('Tous les effets supprimés de toutes les pistes');
    }
    setTimeout(() => setAiNotification(null), 3000);
  }, [handleRemovePlugin]);

  const prepareForRecording = useCallback((trackId?: string) => {
    const targetTrackId = trackId || 'track-rec-main';
    setState(produce((draft: DAWState) => {
      // Désarmer toutes les pistes
      draft.tracks.forEach(t => { t.isTrackArmed = false; });
      // Armer la piste cible
      const track = draft.tracks.find(t => t.id === targetTrackId);
      if (track) {
        track.isTrackArmed = true;
        draft.selectedTrackId = targetTrackId;
      }
      // Mettre le curseur au début
      draft.currentTime = 0;
    }));
    audioEngine.armTrack(targetTrackId);
    setAiNotification(`Prêt à enregistrer sur ${targetTrackId}`);
    setTimeout(() => setAiNotification(null), 3000);
  }, [setState]);

  // === SESSION TEMPLATES ===
  const setupSessionTemplate = useCallback((template: string = 'vocal_full') => {
    const templates: Record<string, { tracks: { name: string; volume: number; pan: number; outputTrackId: string; sends: { id: string; level: number }[] }[] }> = {
      'vocal_full': {
        tracks: [
          { name: 'DOUBLE L', volume: 0.5, pan: -0.65, outputTrackId: 'bus-vox', sends: [{ id: 'send-delay', level: 0.1 }] },
          { name: 'DOUBLE R', volume: 0.5, pan: 0.65, outputTrackId: 'bus-vox', sends: [{ id: 'send-delay', level: 0.1 }] },
          { name: 'BACKS', volume: 0.4, pan: 0, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-short', level: 0.3 }] },
          { name: 'AD-LIBS', volume: 0.35, pan: 0, outputTrackId: 'bus-vox', sends: [{ id: 'send-delay', level: 0.2 }, { id: 'send-verb-short', level: 0.2 }] },
          { name: 'AMBIANCE', volume: 0.25, pan: 0, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-long', level: 0.7 }] }
        ]
      },
      'minimal': {
        tracks: [
          { name: 'BACK', volume: 0.45, pan: 0, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-short', level: 0.25 }] }
        ]
      },
      'chorus_stack': {
        tracks: [
          { name: 'STACK 1 L', volume: 0.4, pan: -0.8, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-long', level: 0.4 }] },
          { name: 'STACK 1 R', volume: 0.4, pan: 0.8, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-long', level: 0.4 }] },
          { name: 'STACK 2 L', volume: 0.35, pan: -0.5, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-long', level: 0.5 }] },
          { name: 'STACK 2 R', volume: 0.35, pan: 0.5, outputTrackId: 'bus-vox', sends: [{ id: 'send-verb-long', level: 0.5 }] }
        ]
      },
      'adlibs_setup': {
        tracks: [
          { name: 'ADLIB CENTER', volume: 0.35, pan: 0, outputTrackId: 'bus-vox', sends: [{ id: 'send-delay', level: 0.3 }] },
          { name: 'ADLIB LEFT', volume: 0.3, pan: -0.7, outputTrackId: 'bus-vox', sends: [{ id: 'send-delay', level: 0.25 }, { id: 'send-verb-short', level: 0.2 }] },
          { name: 'ADLIB RIGHT', volume: 0.3, pan: 0.7, outputTrackId: 'bus-vox', sends: [{ id: 'send-delay', level: 0.25 }, { id: 'send-verb-short', level: 0.2 }] }
        ]
      }
    };

    const selectedTemplate = templates[template] || templates['vocal_full'];

    setState(produce((draft: DAWState) => {
      selectedTemplate.tracks.forEach((trackConfig, index) => {
        const newTrackId = `track-${Date.now()}-${index}`;
        const newTrack: Track = {
          id: newTrackId,
          name: trackConfig.name,
          type: TrackType.AUDIO,
          color: UI_CONFIG.TRACK_COLORS[(draft.tracks.length + index) % UI_CONFIG.TRACK_COLORS.length],
          isMuted: false,
          isSolo: false,
          isTrackArmed: false,
          isFrozen: false,
          volume: trackConfig.volume,
          pan: trackConfig.pan,
          outputTrackId: trackConfig.outputTrackId,
          sends: trackConfig.sends.map(s => ({ id: s.id, level: s.level, isEnabled: true })),
          clips: [],
          plugins: [],
          automationLanes: [],
          totalLatency: 0
        };
        draft.tracks.push(newTrack);
      });
    }));

    setAiNotification(`Session "${template}" créée avec ${selectedTemplate.tracks.length} pistes ! 🎤`);
    setTimeout(() => setAiNotification(null), 3000);
  }, [setState]);

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
              // Si on active le loop et qu'il n'y a pas de région définie, créer une région de 4 mesures
              if (newLoopActive && p.loopEnd <= p.loopStart) {
                  const barDuration = (60 / p.bpm) * 4; // Durée d'une mesure
                  return {
                      ...p,
                      isLoopActive: true,
                      loopStart: 0,
                      loopEnd: barDuration * 4 // 4 mesures
                  };
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
          onToggleSidebar={toggleSidebar}
        >
          <div className="ml-4 border-l border-white/5 pl-4"><ViewModeSwitcher currentMode={viewMode} onChange={handleViewModeChange} /></div>
        </TransportBar>
      </div>
      
      <TrackCreationBar onCreateTrack={handleCreateTrack} />
      <TouchInteractionManager />
      <GlobalClipMenu />

      {/* Floating Import Audio Button */}
      <div className="fixed top-20 right-4 z-[100]">
        <input
          ref={globalFileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.ogg,.flac,.aac,.m4a"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              handleUniversalAudioImport(file, file.name);
              e.target.value = '';
            }
          }}
        />
        <button
          onClick={() => globalFileInputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-emerald-500/25 transition-all hover:scale-105 active:scale-95 border border-emerald-400/30"
        >
          <i className="fas fa-file-audio"></i>
          <span className={isMobile ? 'hidden' : ''}>Importer Audio</span>
        </button>
      </div>

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
          {/* Desktop: ArrangementView */}
          {!isMobile && state.currentView === 'ARRANGEMENT' && (
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
               onAudioDrop={(trackId, url, name, time) => handleUniversalAudioImport(url, name, trackId, time)}
            />
          )}

          {/* Desktop: MixerView */}
          {!isMobile && state.currentView === 'MIXER' && (
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

          {/* Desktop: AutomationView */}
          {!isMobile && state.currentView === 'AUTOMATION' && (
             <AutomationEditorView
               tracks={state.tracks} currentTime={state.currentTime} bpm={state.bpm} zoomH={40}
               onUpdateTrack={handleUpdateTrack} onSeek={handleSeek}
             />
          )}

          {/* Mobile: Tracks View with Panel System */}
          {isMobile && activeMobileTab === 'TRACKS' && (
            <MobilePanelSystem 
              panels={MOBILE_PANELS}
              panelProps={{
                mixer: {
                  tracks: state.tracks,
                  onUpdateTrack: handleUpdateTrack,
                },
                keys: {
                  onNoteOn: (note: number) => {
                    // TODO: Connect to MIDI engine
                    console.log('Note On:', note);
                  },
                  onNoteOff: (note: number) => {
                    // TODO: Connect to MIDI engine
                    console.log('Note Off:', note);
                  },
                },
                plugins: {
                  selectedTrack: state.tracks.find(t => t.id === state.selectedTrackId) || null,
                  onUpdateTrack: handleUpdateTrack,
                  onOpenPlugin: async (trackId: string, plugin: PluginInstance) => {
                    await ensureAudioEngine();
                    setActivePlugin({ trackId, plugin });
                  },
                },
                browser: {
                  onSelectSample: (url: string, name: string) => {
                    console.log('Sample selected:', name);
                    // TODO: Add sample to selected track
                  },
                },
                settings: {
                  bpm: state.bpm,
                  onBpmChange: handleUpdateBpm,
                },
              }}
            >
              <MobileTracksView
                tracks={state.tracks}
                selectedTrackId={state.selectedTrackId}
                onSelectTrack={(id) => setState(p => ({ ...p, selectedTrackId: id }))}
                onUpdateTrack={handleUpdateTrack}
                isPlaying={state.isPlaying}
                currentTime={state.currentTime}
              />
            </MobilePanelSystem>
          )}

          {/* Mobile: Mix View with Pinch-to-Zoom */}
          {isMobile && activeMobileTab === 'MIX' && (
            <MobilePinchZoomContainer className="flex-1">
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
            </MobilePinchZoomContainer>
          )}

          {/* Mobile: Record View */}
          {isMobile && activeMobileTab === 'REC' && (
            <MobileRecordView
              tracks={state.tracks}
              isRecording={state.isRecording}
              isPlaying={state.isPlaying}
              currentTime={state.currentTime}
              onToggleRecord={handleToggleRecord}
              onTogglePlay={handleTogglePlay}
              onStop={handleStop}
              onUpdateTrack={handleUpdateTrack}
            />
          )}

          {/* Mobile: Browser View */}
          {isMobile && activeMobileTab === 'BROWSER' && (
            <MobileBrowserView
              onImportAudio={(file) => handleUniversalAudioImport(file, file.name)}
              onAddPlugin={(tid, type) => handleAddPluginFromContext(tid, type, {}, { openUI: true })}
              selectedTrackId={state.selectedTrackId}
            />
          )}

          {/* Mobile: Settings View */}
          {isMobile && activeMobileTab === 'SETTINGS' && (
            <MobileSettingsView
              bpm={state.bpm}
              onBpmChange={handleUpdateBpm}
              theme={theme}
              onToggleTheme={toggleTheme}
              onOpenAudioSettings={() => setIsAudioSettingsOpen(true)}
            />
          )}
        </main>
      </div>
      
      {/* Mobile: Floating Transport (visible on all tabs except REC) */}
      {isMobile && activeMobileTab !== 'REC' && (
        <MobileTransportFloating
          isPlaying={state.isPlaying}
          isRecording={state.isRecording}
          currentTime={state.currentTime}
          onTogglePlay={handleTogglePlay}
          onStop={handleStop}
          onToggleRecord={handleToggleRecord}
        />
      )}

      {isMobile && <MobileBottomNav activeTab={activeMobileTab} onTabChange={setActiveMobileTab} />}

      {isSaveMenuOpen && <SaveProjectModal isOpen={isSaveMenuOpen} onClose={() => setIsSaveMenuOpen(false)} currentName={state.name} user={user} onSaveCloud={handleSaveCloud} onSaveLocal={handleSaveLocal} onSaveAsCopy={handleSaveAsCopy} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isLoadMenuOpen && <LoadProjectModal isOpen={isLoadMenuOpen} onClose={() => setIsLoadMenuOpen(false)} user={user} onLoadCloud={handleLoadCloud} onLoadLocal={handleLoadLocalFile} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isExportMenuOpen && <ExportModal isOpen={isExportMenuOpen} onClose={() => setIsExportMenuOpen(false)} projectState={state} user={user} onOpenAuth={() => setIsAuthOpen(true)} />}
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
        <ChatAssistant onSendMessage={(msg) => getAIProductionAssistance(state, msg)} onExecuteAction={executeAIAction} externalNotification={aiNotification} isMobile={isMobile} forceOpen={isMobile && activeMobileTab === 'NOVA'} onClose={() => setActiveMobileTab('TRACKS')} />
      </div>
      
      {isShareModalOpen && user && <ShareModal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} onShare={handleShareProject} projectName={state.name} />}
    </div>
  );
}
