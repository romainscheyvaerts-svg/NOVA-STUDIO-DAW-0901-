
import React from 'react';

export enum TrackType {
  AUDIO = 'AUDIO',
  MIDI = 'MIDI',
  BUS = 'BUS',
  SEND = 'SEND',
  SAMPLER = 'SAMPLER',
  DRUM_RACK = 'DRUM_RACK',
  DRUM_SAMPLER = 'DRUM_SAMPLER',
  MELODIC_SAMPLER = 'MELODIC_SAMPLER'
}

export type ViewType = 'ARRANGEMENT' | 'MIXER' | 'AUTOMATION' | 'PIANO_ROLL';
export type MobileTab = 'TRACKS' | 'MIX' | 'REC' | 'BROWSER' | 'NOVA' | 'SETTINGS'; 
export type EditorTool = 'SELECT' | 'SPLIT' | 'ERASE' | 'AUTOMATION' | 'DRAW';
export type ViewMode = 'DESKTOP' | 'TABLET' | 'MOBILE';
export type Theme = 'dark' | 'light';

export enum ProjectPhase {
  SETUP = 'SETUP',
  RECORDING = 'RECORDING',
  MIXING = 'MIXING',
  MASTERING = 'MASTERING'
}

export enum GuideStep {
  WELCOME = 'WELCOME',
  IMPORT_INSTRUMENTAL = 'IMPORT_INSTRUMENTAL',
  PREPARE_VOCAL = 'PREPARE_VOCAL',
  RECORDING = 'RECORDING',
  REVIEW = 'REVIEW',
  EXPORT = 'EXPORT'
}

export interface User {
  id: string;
  email: string;
  username: string;
  isVerified: boolean;
  avatar?: string;
  plan: 'FREE' | 'PRO' | 'STUDIO';
  owned_instruments?: number[];
  google_ai_api_key?: string; // Clé API Google AI sauvegardée dans Supabase
}

export interface Instrument {
  id: number;
  created_at: string;
  name: string;
  category: 'Trap' | 'Drill' | 'Boombap' | 'Afro' | 'RnB' | 'Pop' | 'Electro';
  image_url: string;
  bpm: number;
  musical_key: string;
  preview_url: string; 
  stems_url?: string;  
  price_basic: number;     
  price_premium: number;   
  price_exclusive: number; 
  is_visible: boolean; 
  stripe_link_basic?: string; 
  stripe_link_premium?: string; 
  stripe_link_exclusive?: string; 
  stripe_link_recording?: string; 
}

export interface PendingUpload {
  id: number;
  filename: string;
  download_url: string;
  is_processed: boolean;
  created_at: string;
}

export type AuthStage = 'LOGIN' | 'REGISTER' | 'VERIFY_EMAIL' | 'FORGOT_PASSWORD';

export type PluginType = 
  | 'REVERB' 
  | 'DELAY' 
  | 'CHORUS' 
  | 'FLANGER' 
  | 'DOUBLER' 
  | 'STEREOSPREADER' 
  | 'COMPRESSOR' 
  | 'AUTOTUNE' 
  | 'DEESSER' 
  | 'DENOISER' 
  | 'PROEQ12' 
  | 'VOCALSATURATOR' 
  | 'MASTERSYNC' 
  | 'VST3' 
  | 'SAMPLER' 
  | 'DRUM_SAMPLER' 
  | 'MELODIC_SAMPLER' 
  | 'DRUM_RACK_UI';

export interface PluginMetadata {
  id: string;
  name: string;
  type: PluginType;
  format: 'VST3' | 'AU' | 'VST' | 'INTERNAL';
  vendor: string;
  version: string;
  latency: number; 
  localPath?: string;
}

export interface PluginInstance {
  id: string;
  name: string;
  type: PluginType;
  isEnabled: boolean;
  params: Record<string, any>;
  latency: number; 
}

export interface TrackSend {
  id: string;          
  level: number;       
  isEnabled: boolean;
}

export interface MidiNote {
  id: string;
  pitch: number; 
  start: number; 
  duration: number; 
  velocity: number; 
  isSelected?: boolean;
}

export interface Clip {
  id: string;
  start: number;
  duration: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
  name: string;
  color: string;
  type: TrackType;
  buffer?: AudioBuffer;      // Legacy - kept for backwards compatibility
  bufferId?: string;         // NEW: Reference to AudioBufferRegistry (preferred)
  notes?: MidiNote[];
  isMuted?: boolean;
  gain?: number;
  isReversed?: boolean;
  audioRef?: string;
  isUnlicensed?: boolean;
}

export interface AutomationPoint {
  id: string;
  time: number;
  value: number;
}

export interface AutomationLane {
  id: string;
  parameterName: 'volume' | 'pan' | string;
  points: AutomationPoint[];
  color: string;
  isExpanded: boolean;
  min: number;
  max: number;
}

export interface DrumPad {
  id: number; 
  name: string;
  sampleName: string;
  volume: number; 
  pan: number; 
  isMuted: boolean;
  isSolo: boolean;
  midiNote: number; 
  buffer?: AudioBuffer;
  audioRef?: string; 
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  color: string;
  isMuted: boolean;
  isSolo: boolean;
  isTrackArmed: boolean;
  isFrozen: boolean;
  volume: number;
  pan: number;
  inputDeviceId?: string; 
  outputTrackId: string;  
  instrumentId?: number; 
  sends: TrackSend[];
  clips: Clip[];
  plugins: PluginInstance[];
  automationLanes: AutomationLane[];
  totalLatency: number;
  events?: any[]; 
  drumPads?: DrumPad[]; 
}

export interface DAWState {
  id: string;
  name: string;
  bpm: number;
  projectKey?: number; 
  projectScale?: string; 
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  isLoopActive: boolean;
  loopStart: number;
  loopEnd: number;
  tracks: Track[];
  selectedTrackId: string | null;
  currentView: ViewType;
  projectPhase: ProjectPhase;
  isLowLatencyMode: boolean; 
  isRecModeActive: boolean;
  systemMaxLatency: number; 
  recStartTime: number | null;
  isDelayCompEnabled: boolean;
}

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  icon?: string;
  danger?: boolean;
  component?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
}

export type AIChatRole = 'user' | 'assistant' | 'system';

export interface AIChatMessage {
  id: string;
  role: AIChatRole;
  content: string;
  timestamp: number;
  isCommand?: boolean;
  executedAction?: string;
}

export type AIActionType =
  // Track Management
  | 'UPDATE_TRACK'
  | 'ADD_TRACK'
  | 'CREATE_TRACK'
  | 'DELETE_TRACK'
  | 'SET_VOLUME'
  | 'SET_PAN'
  | 'MUTE_TRACK'
  | 'SOLO_TRACK'
  | 'RENAME_TRACK'
  | 'DUPLICATE_TRACK'
  | 'ARM_TRACK'
  // Plugin Management
  | 'UPDATE_PLUGIN'
  | 'OPEN_PLUGIN'
  | 'CLOSE_PLUGIN'
  | 'SET_PLUGIN_PARAM'
  | 'BYPASS_PLUGIN'
  | 'REMOVE_PLUGIN'
  | 'ADD_PLUGIN'
  // Send/Bus Management
  | 'SET_SEND_LEVEL'
  | 'CREATE_BUS'
  | 'ROUTE_TO_BUS'
  // Session Templates
  | 'SETUP_SESSION'
  // Clip Operations
  | 'NORMALIZE_CLIP'
  | 'SPLIT_CLIP'
  | 'MUTE_CLIP'
  | 'DELETE_CLIP'
  | 'DUPLICATE_CLIP'
  | 'SET_CLIP_GAIN'
  | 'REVERSE_CLIP'
  | 'CUT_CLIP'
  | 'COPY_CLIP'
  | 'PASTE_CLIP'
  | 'FADE_IN_CLIP'
  | 'FADE_OUT_CLIP'
  | 'CROSSFADE_CLIPS'
  | 'REDUCE_BREATHS'
  | 'AUTO_FADE'
  // Transport
  | 'PLAY'
  | 'STOP'
  | 'RECORD'
  | 'SEEK'
  | 'SET_LOOP'
  | 'TOGGLE_LOOP'
  | 'SET_BPM'
  // Automation
  | 'SET_AUTOMATION'
  | 'ADD_AUTOMATION_LANE'
  | 'ADD_AUTOMATION_POINT'
  // Analysis & AI
  | 'RUN_MASTER_SYNC'
  | 'ANALYZE_INSTRU'
  | 'REMOVE_SILENCE'
  | 'DETECT_SONG_STRUCTURE'
  | 'DETECT_ISSUES'
  | 'START_LIVE_COACHING'
  | 'STOP_LIVE_COACHING'
  // Mix Presets
  | 'APPLY_VOCAL_CHAIN'
  | 'APPLY_MIX_PRESET'
  | 'CLEAN_MIX'
  | 'RESET_FX'
  | 'PREPARE_REC'
  // View Control
  | 'CHANGE_VIEW'
  | 'SELECT_TRACK'
  // Export
  | 'EXPORT_MIX'; 

export interface AIAction {
  action: AIActionType;
  payload: any;
  description?: string;
}

export interface PluginParameter {
  id: string;
  name: string;
  type: 'float' | 'int' | 'boolean' | 'string';
  min: number;
  max: number;
  value: any;
  unit?: string;
}

export interface VSTFrameData {
  pluginId: string;
  image: string; 
  width: number;
  height: number;
}

export interface MidiDevice {
  id: string;
  name: string;
  manufacturer?: string;
  state: 'connected' | 'disconnected';
  type: 'input' | 'output';
}

declare global {
  interface Window {
    DAW_CONTROL: any;
    gridSize: string;
    isSnapEnabled: boolean;
    clipClipboard: any;
    DAW_CORE: any;
  }
}