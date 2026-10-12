import { useEffect, useRef } from 'react';
import type { DAWState, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { meterBank } from '../engine/meters/meterBank';
import { automationRecorder } from '../services/AutomationManager';
import { controlSurface } from '../services/ControlSurface';
import type { SurfaceHost } from '../services/ControlSurfaceController';
import type { AutomationMode } from '../utils/automationWrite';
import { getLive, liveKey } from '../utils/automationLiveStore';
import { playheadStore } from '../utils/playheadStore';
import { scrubControl } from '../utils/scrubControl';
import { barToTime, tempoMapStore, timeToPosition } from '../utils/tempoMap';
import { shownTrackIds } from '../utils/trackStructure';

/**
 * Branche une surface de contrôle (MCU / HUI, services/ControlSurface) sur NOVA :
 * les faders et boutons passent par les MÊMES fonctions que la souris (volume
 * via handleUpdateTrack : groupes, automation Touch / Latch, annulation).
 */
export interface ControlSurfaceDeps {
  stateRef: React.MutableRefObject<DAWState>;
  updateTrack: (t: Track) => void;
  selectTrack: (id: string) => void;
  togglePlay: () => void;
  stop: () => void;
  toggleRecord: () => void;
  seek: (t: number) => void;
  toggleLoop: () => void;
  undo: () => void;
  toggleMetronome: () => void;
  addMarker: (t: number) => void;
  notify: (msg: string) => void;
}

export function useControlSurface(deps: ControlSurfaceDeps) {
  const ref = useRef(deps);
  ref.current = deps;

  useEffect(() => {
    const st = () => ref.current.stateRef.current;
    const host: SurfaceHost = {
      getTracks: () => st().tracks,
      shownIds: () => shownTrackIds(st().tracks),
      getSelectedTrackId: () => st().selectedTrackId || null,
      getTime: () => (audioEngine.getIsPlaying() ? audioEngine.getCurrentTime() : playheadStore.get()),
      isPlaying: () => audioEngine.getIsPlaying(),
      isRecording: () => !!st().isRecording,
      isLoopActive: () => !!st().isLoopActive,
      isClickOn: () => !!st().metronome?.enabled,
      position: (t) => {
        const p = timeToPosition(tempoMapStore.get(), t);
        return { bar: p.bar, beat: p.beat, frac: p.frac, beatSec: p.seg.beatSec, barSec: p.seg.barSec };
      },
      barTime: (bar) => barToTime(tempoMapStore.get(), bar),
      liveValue: (id, param) => getLive(liveKey(id, param)),
      meterDb: (id) => {
        const v = meterBank.view(id);
        if (!v) return null;
        return Math.max(v.peak[0], v.peak[1]);
      },
      updateTrack: (t) => ref.current.updateTrack(t),
      selectTrack: (id) => ref.current.selectTrack(id),
      automationTouch: (id, param, on) => { if (on) automationRecorder.touch(id, param); else automationRecorder.release(id, param); },
      setAutomationMode: (id, mode: AutomationMode) => {
        const t = st().tracks.find(x => x.id === id);
        if (!t) return;
        automationRecorder.stopTrack(id);
        ref.current.updateTrack({ ...t, automationMode: mode });
        ref.current.notify(`🎚️ ${t.name} : automation en ${mode === 'off' ? 'Off' : mode.charAt(0).toUpperCase() + mode.slice(1)}.`);
      },
      play: () => ref.current.togglePlay(),
      stop: () => ref.current.stop(),
      record: () => ref.current.toggleRecord(),
      toggleLoop: () => ref.current.toggleLoop(),
      seek: (t) => ref.current.seek(t),
      undo: () => ref.current.undo(),
      addMarker: (t) => ref.current.addMarker(t),
      toggleClick: () => ref.current.toggleMetronome(),
      scrub: { begin: (t) => scrubControl.begin(t), move: (t) => scrubControl.move(t), end: () => scrubControl.end() },
      notify: (m) => ref.current.notify(m),
      now: () => performance.now(),
    };
    controlSurface.setHost(host);
    void controlSurface.autoStart();
    const bye = () => controlSurface.shutdown();
    window.addEventListener('pagehide', bye);
    // Accès pour les tests de bout en bout (navigateur headless) et la console.
    (window as any).__novaSurface = {
      snapshot: () => controlSurface.getSnapshot(),
      controller: () => controlSurface.getController(),
      updateTrack: (t: Track) => ref.current.updateTrack(t),
    };
    return () => {
      window.removeEventListener('pagehide', bye);
      controlSurface.setHost(null);
      delete (window as any).__novaSurface;
    };
  }, []);
}
