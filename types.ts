
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
export type MobileTab = 'TRACKS' | 'ARRANGEMENT' | 'PLUGINS' | 'BROWSER' | 'NOVA';
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
}

export interface Instrument {
  id: number | string;  // UUID in Supabase
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

export type PluginType = 'REVERB' | 'DELAY' | 'CHORUS' | 'FLANGER' | 'DOUBLER' | 'STEREOSPREADER' | 'COMPRESSOR' | 'AUTOTUNE' | 'DEESSER' | 'DENOISER' | 'PROEQ12' | 'VOCALSATURATOR' | 'MASTERSYNC' | 'VST3' | 'SAMPLER' | 'DRUM_SAMPLER' | 'MELODIC_SAMPLER' | 'DRUM_RACK_UI';

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

// Crossfade curve types (inspired by Pro Tools)
export type CrossfadeCurve = 'LINEAR' | 'EQUAL_POWER' | 'S_CURVE' | 'EXPONENTIAL';

// Time stretch/Warp settings (inspired by Ableton)
export type WarpMode = 'OFF' | 'BEATS' | 'TONES' | 'TEXTURE' | 'REPITCH' | 'COMPLEX';

export interface WarpMarker {
  id: string;
  sampleTime: number;  // position in original audio
  beatTime: number;    // position in beats
}

export interface WarpSettings {
  enabled: boolean;
  mode: WarpMode;
  originalBpm?: number;
  markers?: WarpMarker[];
  preservePitch: boolean;
  grainSize?: number;     // for granular modes
}

// Track Group (inspired by Reaper/Pro Tools)
export interface TrackGroup {
  id: string;
  name: string;
  color: string;
  trackIds: string[];
  isCollapsed: boolean;
  // Linked parameters
  linkedVolume: boolean;
  linkedMute: boolean;
  linkedSolo: boolean;
  linkedPan: boolean;
}

export interface Clip {
  id: string;
  start: number;
  duration: number;
  offset: number; 
  fadeIn: number; 
  fadeOut: number; 
  fadeInCurve?: CrossfadeCurve;   // NEW: fade in curve type
  fadeOutCurve?: CrossfadeCurve;  // NEW: fade out curve type
  name: string;
  color: string;
  type: TrackType;
  buffer?: AudioBuffer;
  bufferId?: string; 
  notes?: MidiNote[]; 
  isMuted?: boolean;
  gain?: number;
  isReversed?: boolean; 
  audioRef?: string;
  isUnlicensed?: boolean;
  warp?: WarpSettings;            // NEW: time stretch (Ableton-style)
  groupId?: string;               // NEW: clip grouping
}

export interface AutomationPoint {
  id: string;
  time: number;
  value: number;
  curveType?: AutomationCurveType; // NEW: curve to next point
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

// DRUM RACK SPECIFIC INTERFACES
export interface DrumPad {
  id: number; // 1 to 30
  name: string;
  sampleName: string;
  volume: number; // 0 to 1
  pan: number; // -1 to 1
  isMuted: boolean;
  isSolo: boolean;
  midiNote: number; // 60 + (id - 1)
  buffer?: AudioBuffer;
  audioRef?: string; // URL for persistence
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
  drumPads?: DrumPad[];        // Only for DRUM_RACK tracks
  groupId?: string;            // NEW: Track group reference
  height?: number;             // NEW: Custom track height
  isMinimized?: boolean;       // NEW: Collapsed state
}

// Time Signature type (inspired by Reaper/Ableton)
export interface TimeSignature {
  numerator: number;   // beats per bar (4 in 4/4)
  denominator: number; // note value (4 = quarter note)
}

// Marker types (inspired by Pro Tools/Reaper)
export type MarkerType = 'MARKER' | 'REGION';

export interface Marker {
  id: string;
  name: string;
  time: number;
  type: MarkerType;
  endTime?: number;  // Only for REGION type
  color: string;
}

// Metronome settings
export interface MetronomeSettings {
  enabled: boolean;
  volume: number;        // 0-1
  countIn: number;       // bars before recording (0, 1, 2, 4)
  accentDownbeat: boolean;
  sound: 'CLICK' | 'WOODBLOCK' | 'BEEP' | 'CUSTOM';
}

// Punch recording settings (inspired by Pro Tools)
export interface PunchSettings {
  enabled: boolean;
  punchIn: number;    // time in seconds
  punchOut: number;   // time in seconds
  preRoll: number;    // seconds before punch in
  postRoll: number;   // seconds after punch out
}

// Automation curve types (inspired by Ableton/Logic)
export type AutomationCurveType = 'LINEAR' | 'EXPONENTIAL' | 'LOGARITHMIC' | 'S_CURVE' | 'HOLD';

export interface DAWState {
  id: string;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;  // NEW
  projectKey?: number; 
  projectScale?: string; 
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  isLoopActive: boolean;
  loopStart: number;
  loopEnd: number;
  tracks: Track[];
  trackGroups: TrackGroup[];      // NEW
  markers: Marker[];              // NEW
  selectedTrackId: string | null;
  currentView: ViewType;
  projectPhase: ProjectPhase;
  isLowLatencyMode: boolean; 
  isRecModeActive: boolean;
  systemMaxLatency: number; 
  recStartTime: number | null;
  isDelayCompEnabled: boolean;
  metronome: MetronomeSettings;   // NEW
  punch: PunchSettings;           // NEW
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
  | 'UPDATE_PLUGIN' 
  | 'UPDATE_TRACK' 
  | 'ADD_TRACK'
  | 'CREATE_TRACK' 
  | 'DELETE_TRACK' 
  | 'SET_VOLUME'
  | 'SET_PAN'
  | 'MUTE_TRACK'
  | 'SOLO_TRACK'
  | 'RENAME_TRACK'
  | 'OPEN_PLUGIN'
  | 'CLOSE_PLUGIN'
  | 'SET_PLUGIN_PARAM'
  | 'BYPASS_PLUGIN'
  | 'SET_SEND_LEVEL'
  | 'PREPARE_REC' 
  | 'CLEAN_MIX'
  | 'RESET_FX'
  | 'NORMALIZE_CLIP'
  | 'SPLIT_CLIP'
  | 'MUTE_CLIP'
  | 'PLAY'
  | 'STOP'
  | 'RECORD'
  | 'SEEK'
  | 'SET_LOOP'
  | 'SET_BPM'
  | 'SET_AUTOMATION'
  | 'RUN_MASTER_SYNC'
  | 'ANALYZE_INSTRU'
  | 'DUPLICATE_TRACK'
  | 'REMOVE_SILENCE'; 

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

// Nouvelle interface MIDI
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
