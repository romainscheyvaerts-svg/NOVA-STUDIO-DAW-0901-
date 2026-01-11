
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Track, TrackType, DAWState, ProjectPhase, PluginInstance, PluginType, MobileTab, TrackSend, Clip, AIAction, AutomationLane, AIChatMessage, ViewMode, User, Theme, DrumPad } from './types';
import { audioEngine } from './engine/AudioEngine';
import { audioBufferRegistry } from './services/AudioBufferRegistry';
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

          {/* Mobile: Tracks View */}
          {isMobile && activeMobileTab === 'TRACKS' && (
            <MobileTracksView
              tracks={state.tracks}
              selectedTrackId={state.selectedTrackId}
              onSelectTrack={(id) => setState(p => ({ ...p, selectedTrackId: id }))}
              onUpdateTrack={handleUpdateTrack}
              isPlaying={state.isPlaying}
              currentTime={state.currentTime}
            />
          )}

          {/* Mobile: Mix View */}
          {isMobile && activeMobileTab === 'MIX' && (
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
        <ChatAssistant onSendMessage={(msg) => getAIProductionAssistance(state, msg)} onExecuteAction={executeAIAction} externalNotification={aiNotification} isMobile={isMobile} forceOpen={isMobile && activeMobileTab === 'NOVA'} onClose={() => setActiveMobileTab('TRACKS')} />
      </div>
      
      {isShareModalOpen && user && <ShareModal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} onShare={handleShareProject} projectName={state.name} />}
    </div>
  );
}
