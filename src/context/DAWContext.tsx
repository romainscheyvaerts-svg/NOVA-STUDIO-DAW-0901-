
import React, { createContext, useContext, useEffect, useRef } from 'react';
import { DAWState, Track, TrackType, PluginInstance, User, PluginType, ViewType } from '../types';
import { useDAWStore } from '../store/dawStore';
import { audioEngine } from '../engine/AudioEngine';

// On garde l'interface pour la compatibilité, mais elle mappe vers le store
interface DAWContextType {
  state: DAWState;
  user: User | null;
  setUser: (user: User | null) => void;
  
  play: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setBpm: (bpm: number) => void;
  toggleLoop: () => void;
  toggleDelayComp: () => void;
  setView: (view: ViewType) => void;
  
  addTrack: (type: TrackType, name?: string) => void;
  deleteTrack: (id: string) => void;
  updateTrack: (track: Track) => void;
  selectTrack: (id: string) => void;
  
  addPlugin: (trackId: string, type: PluginType, metadata?: any) => void;
  removePlugin: (trackId: string, pluginId: string) => void;
  updatePluginParams: (trackId: string, pluginId: string, params: any) => void;
  
  saveProject: () => Promise<void>;
  loadProject: (data: DAWState) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const DAWContext = createContext<DAWContextType | null>(null);

export const DAWProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // On s'abonne aux parties du store nécessaires
  // Note: Pour éviter les re-renders excessifs, on pourrait optimiser les sélecteurs,
  // mais pour l'instant on garde la compatibilité globale.
  const store = useDAWStore();
  
  // Ref pour la boucle d'animation (pour éviter de capturer le state dans la closure)
  const isPlayingRef = useRef(store.present.isPlaying);
  useEffect(() => { isPlayingRef.current = store.present.isPlaying; }, [store.present.isPlaying]);

  // Boucle d'animation (Playhead) - Optimisée pour appeler le store seulement si nécessaire
  useEffect(() => {
    let animId: number;
    const loop = () => {
      if (isPlayingRef.current) {
        const time = audioEngine.getCurrentTime();
        // On appelle l'action optimisée du store
        store.setCurrentTime(time);
        animId = requestAnimationFrame(loop);
      }
    };
    if (store.present.isPlaying) animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [store.present.isPlaying]);

  const value: DAWContextType = {
    state: store.present,
    user: store.user,
    setUser: store.setUser,

    play: store.play,
    stop: store.stop,
    seek: store.seek,
    setBpm: store.setBpm,
    toggleLoop: store.toggleLoop,
    toggleDelayComp: store.toggleDelayComp,
    setView: store.setView,

    addTrack: store.addTrack,
    deleteTrack: store.deleteTrack,
    updateTrack: store.updateTrack,
    selectTrack: store.selectTrack,

    addPlugin: store.addPlugin,
    removePlugin: store.removePlugin,
    updatePluginParams: store.updatePluginParams,

    saveProject: async () => {}, // Placeholder pour l'instant
    loadProject: store.setProjectState,

    undo: store.undo,
    redo: store.redo,
    canUndo: store.past.length > 0,
    canRedo: store.future.length > 0
  };

  return <DAWContext.Provider value={value}>{children}</DAWContext.Provider>;
};

export const useDAW = () => {
  const context = useContext(DAWContext);
  if (!context) throw new Error("useDAW must be used within a DAWProvider");
  return context;
};
