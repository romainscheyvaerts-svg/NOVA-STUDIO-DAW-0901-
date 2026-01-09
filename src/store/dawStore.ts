import { create } from 'zustand';
import { produce } from 'immer';
import { DAWState, Track, TrackType, ProjectPhase, PluginInstance, AutomationLane, User, PluginType, ViewType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { AUDIO_CONFIG, UI_CONFIG } from '../utils/constants';

// --- HELPERS ---
const generateId = (prefix: string = 'id') => `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const createDefaultState = (): DAWState => ({
  id: 'proj-1',
  name: 'New Project',
  bpm: 120,
  isPlaying: false,
  isRecording: false,
  currentTime: 0,
  isLoopActive: false,
  loopStart: 0,
  loopEnd: 8,
  tracks: [],
  selectedTrackId: null,
  currentView: 'ARRANGEMENT',
  projectPhase: ProjectPhase.SETUP,
  isLowLatencyMode: false,
  isRecModeActive: false,
  systemMaxLatency: 0,
  recStartTime: null,
  isDelayCompEnabled: false
});

// --- STORE INTERFACE ---
interface DAWStore {
  // State
  present: DAWState;
  past: DAWState[];
  future: DAWState[];
  user: User | null;

  // Actions
  setUser: (user: User | null) => void;
  setProjectState: (state: DAWState) => void;
  
  // Transport
  play: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setBpm: (bpm: number) => void;
  toggleLoop: () => void;
  toggleDelayComp: () => void;
  setView: (view: ViewType) => void;
  setCurrentTime: (time: number) => void;

  // Tracks
  addTrack: (type: TrackType, name?: string) => void;
  deleteTrack: (id: string) => void;
  updateTrack: (track: Track) => void;
  selectTrack: (id: string) => void;

  // Plugins
  addPlugin: (trackId: string, type: PluginType, metadata?: any) => void;
  removePlugin: (trackId: string, pluginId: string) => void;
  updatePluginParams: (trackId: string, pluginId: string, params: any) => void;

  // History
  undo: () => void;
  redo: () => void;
}

// --- STORE CREATION ---
export const useDAWStore = create<DAWStore>((set, get) => ({
  present: createDefaultState(),
  past: [],
  future: [],
  user: null,

  setUser: (user) => set({ user }),

  setProjectState: (newState) => {
      set({ present: newState, past: [], future: [] });
      
      // Init Audio Engine with full state
      audioEngine.init().then(() => {
          newState.tracks.forEach(t => audioEngine.updateTrack(t, newState.tracks));
      });
  },

  setCurrentTime: (time) => set(produce((state: DAWStore) => {
      state.present.currentTime = time;
  })),

  play: async () => {
    await audioEngine.init();
    if (audioEngine.ctx?.state === 'suspended') await audioEngine.ctx.resume();

    const isPlaying = get().present.isPlaying;
    if (isPlaying) {
      audioEngine.stopAll();
      set(produce((state: DAWStore) => { state.present.isPlaying = false; }));
    } else {
      audioEngine.startPlayback(get().present.currentTime, get().present.tracks);
      set(produce((state: DAWStore) => { state.present.isPlaying = true; }));
    }
  },

  stop: () => {
    audioEngine.stopAll();
    audioEngine.seekTo(0, get().present.tracks, false);
    set(produce((state: DAWStore) => {
        state.present.isPlaying = false;
        state.present.currentTime = 0;
        state.present.isRecording = false;
    }));
  },

  seek: (time) => {
    audioEngine.seekTo(time, get().present.tracks, get().present.isPlaying);
    set(produce((state: DAWStore) => { state.present.currentTime = time; }));
  },

  setBpm: (bpm) => set(produce((state: DAWStore) => {
      state.past.push(state.present);
      state.present.bpm = bpm;
      state.future = [];
      // FIX: The method `setBpm` was missing on the `audioEngine` instance. It has been added to allow the store to update the engine's BPM.
      audioEngine.setBpm(bpm);
  })),

  toggleLoop: () => set(produce((state: DAWStore) => {
      state.present.isLoopActive = !state.present.isLoopActive;
  })),

  toggleDelayComp: () => set(produce((state: DAWStore) => {
      state.present.isDelayCompEnabled = !state.present.isDelayCompEnabled;
      audioEngine.setDelayCompensation(state.present.isDelayCompEnabled);
  })),

  setView: (view) => set(produce((state: DAWStore) => {
      state.present.currentView = view;
  })),

  // --- TRACK ACTIONS ---

  addTrack: (type, name) => {
    set(produce((state: DAWStore) => {
        state.past.push(state.present);
        state.future = [];

        const newTrack: Track = {
            id: generateId('track'),
            name: name || `${type} Track`,
            type,
            color: UI_CONFIG.TRACK_COLORS[state.present.tracks.length % UI_CONFIG.TRACK_COLORS.length],
            isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
            volume: 1.0, pan: 0, outputTrackId: 'master',
            sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0
        };
        state.present.tracks.push(newTrack);
        
        setTimeout(() => audioEngine.updateTrack(newTrack, state.present.tracks), 0);
    }));
  },

  deleteTrack: (id) => {
    set(produce((state: DAWStore) => {
        state.past.push(state.present);
        state.future = [];
        state.present.tracks = state.present.tracks.filter(t => t.id !== id);
        if (state.present.selectedTrackId === id) state.present.selectedTrackId = null;
    }));
  },

  updateTrack: (track) => {
    // ATOMIC OPTIMIZATION
    const currentTrack = get().present.tracks.find(t => t.id === track.id);
    
    // FIX: The methods `setTrackVolume` and `setTrackPan` were missing on the `audioEngine` instance. They have been added for atomic updates to avoid full graph rebuilds on simple changes. A null check for `currentTrack` was also added for safety.
    if (currentTrack && (currentTrack.volume !== track.volume || currentTrack.isMuted !== track.isMuted)) {
        // FIX: The method `setTrackVolume` was missing on the `audioEngine` instance. It has been added for atomic updates to avoid full graph rebuilds on simple changes. A null check for `currentTrack` was also added for safety.
        audioEngine.setTrackVolume(track.id, track.volume, track.isMuted);
    }
    if (currentTrack && currentTrack.pan !== track.pan) {
        // FIX: The method `setTrackPan` was missing on the `audioEngine` instance. It has been added for atomic updates to avoid full graph rebuilds on simple changes. A null check for `currentTrack` was also added for safety.
        audioEngine.setTrackPan(track.id, track.pan);
    }
    
    set(produce((state: DAWStore) => {
        state.past.push(state.present);
        state.future = [];
        
        const idx = state.present.tracks.findIndex(t => t.id === track.id);
        if (idx !== -1) {
            state.present.tracks[idx] = track;
            
            // The full graph update is still necessary for structural changes, but less critical for simple tweaks.
            // We can debounce or optimize this further if needed.
            audioEngine.updateTrack(track, state.present.tracks);
        }
    }));
  },

  selectTrack: (id) => set(produce((state: DAWStore) => {
      state.present.selectedTrackId = id;
  })),

  // --- PLUGINS ---

  addPlugin: (trackId, type, metadata) => {
      set(produce((state: DAWStore) => {
          state.past.push(state.present);
          state.future = [];

          const track = state.present.tracks.find(t => t.id === trackId);
          if (track) {
              const newPlugin: PluginInstance = {
                  id: generateId('pl'),
                  name: metadata?.name || type,
                  type: type,
                  isEnabled: true,
                  params: metadata?.localPath ? { localPath: metadata.localPath } : {},
                  latency: 0
              };
              track.plugins.push(newPlugin);
              audioEngine.updateTrack(track, state.present.tracks);
          }
      }));
  },

  removePlugin: (trackId, pluginId) => {
      set(produce((state: DAWStore) => {
          state.past.push(state.present);
          state.future = [];

          const track = state.present.tracks.find(t => t.id === trackId);
          if (track) {
              track.plugins = track.plugins.filter(p => p.id !== pluginId);
              audioEngine.updateTrack(track, state.present.tracks);
          }
      }));
  },

  updatePluginParams: (trackId, pluginId, params) => {
      set(produce((state: DAWStore) => {
          const track = state.present.tracks.find(t => t.id === trackId);
          if (track) {
              const plugin = track.plugins.find(p => p.id === pluginId);
              if (plugin) {
                  plugin.params = { ...plugin.params, ...params };
                  
                  // Atomic Update via AudioEngine -> GraphManager
                  const node = audioEngine.getPluginNodeInstance(trackId, pluginId);
                  if (node && node.updateParams) node.updateParams(params);
              }
          }
      }));
  },

  // --- HISTORY ---

  undo: () => set(produce((state: DAWStore) => {
      if (state.past.length === 0) return;
      const previous = state.past[state.past.length - 1];
      const newPast = state.past.slice(0, -1);
      
      state.future.unshift(state.present);
      state.present = previous;
      state.past = newPast;

      state.present.tracks.forEach(t => audioEngine.updateTrack(t, state.present.tracks));
  })),

  redo: () => set(produce((state: DAWStore) => {
      if (state.future.length === 0) return;
      const next = state.future[0];
      const newFuture = state.future.slice(1);

      state.past.push(state.present);
      state.present = next;
      state.future = newFuture;

      state.present.tracks.forEach(t => audioEngine.updateTrack(t, state.present.tracks));
  }))

}));