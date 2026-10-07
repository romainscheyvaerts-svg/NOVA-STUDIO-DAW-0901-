import { useEffect, useRef } from 'react';
import { produce } from 'immer';
import type { DAWState, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { automationRecorder } from '../services/AutomationManager';
import {
  isFaderParam, newLane, parsePluginParam, playedLanes, sortedPoints, staticParamValue, valueAtPoints, withStaticParamValue,
} from '../utils/automationWrite';
import { clearLive, liveKey, publishLive } from '../utils/automationLiveStore';

/**
 * Branchement des modes d'automation dans l'application (Touch, Latch, Write, Trim).
 *
 * - relie services/AutomationManager à l'état React et au moteur audio ;
 * - une seule étape d'annulation par passe (`checkpoint` au premier geste) ;
 * - pendant la lecture, publie les valeurs entendues pour que les faders
 *   suivent la courbe (utils/automationLiveStore).
 */
export interface AutomationWriteDeps {
  stateRef: React.MutableRefObject<DAWState>;
  /** Modifie le projet sans créer d'étape d'annulation. */
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  /** Range l'état actuel dans l'historique (la passe qui commence sera UNE étape). */
  checkpoint: () => void;
  /** Message court à l'écran (« Passe Write terminée : piste en Touch »). */
  notify?: (msg: string) => void;
}

export function useAutomationWrite(deps: AutomationWriteDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    automationRecorder.configure({
      getTracks: () => depsRef.current.stateRef.current.tracks,
      getTime: () => audioEngine.getCurrentTime(),
      isPlaying: () => audioEngine.getIsPlaying(),
      setOverride: (trackId, param, value, points) => audioEngine.setAutomationOverride(trackId, param, value, points),
      beginUndoStep: () => depsRef.current.checkpoint(),
      commit: ({ trackId, param, points, spec, staticValue }) => {
        depsRef.current.setSilently(prev => produce(prev, (draft: DAWState) => {
          const track = draft.tracks.find(t => t.id === trackId);
          if (!track) return;
          if (!track.automationLanes) track.automationLanes = [];
          let lane = track.automationLanes.find(l => l.parameterName === param);
          if (!lane) {
            lane = newLane(param, track.color || '#00f2ff', spec);
            track.automationLanes.push(lane);
          }
          // Première écriture : la voie s'ouvre sous la piste pour qu'on voie la courbe.
          if (!lane.points.length && points.length) lane.isExpanded = true;
          lane.points = points;
          if (parsePluginParam(param)) { lane.min = Math.min(lane.min, spec.min); lane.max = Math.max(lane.max, spec.max); }
          if (staticValue !== null && Number.isFinite(staticValue)) {
            const updated = withStaticParamValue(track as Track, param, staticValue);
            track.volume = updated.volume; track.pan = updated.pan; track.sends = updated.sends; track.plugins = updated.plugins;
          }
        }));
      },
      setTrackMode: (trackId, mode) => {
        depsRef.current.setSilently(prev => produce(prev, (draft: DAWState) => {
          const t = draft.tracks.find(x => x.id === trackId);
          if (t) t.automationMode = mode;
        }));
        const name = depsRef.current.stateRef.current.tracks.find(t => t.id === trackId)?.name || 'la piste';
        depsRef.current.notify?.(`Passe Write terminée sur ${name} : la piste repasse en Touch.`);
      },
      wallClock: () => performance.now(),
    });
    return () => automationRecorder.configure(null);
  }, []);

  // Transport (tous les chemins : lecture, pause, stop, saut, enregistrement).
  useEffect(() => {
    // L'événement part au tout début de startPlayback : la position de départ
    // n'est connue qu'à la fin de l'appel (microtâche).
    const onStart = () => { void Promise.resolve().then(() => automationRecorder.onPlay()); };
    const onStop = (e: Event) => {
      const time = (e as CustomEvent).detail?.time;
      automationRecorder.onStop(typeof time === 'number' ? time : undefined);
      clearLive();
    };
    // Fin d'appui n'importe où : relâche les réglages faits sans « appui » explicite
    // (faders de groupe, fenêtres d'effets, mixeur du téléphone).
    const down = () => automationRecorder.setPointerDown(true);
    const up = () => { automationRecorder.setPointerDown(false); automationRecorder.releaseImplicit(); };
    window.addEventListener('nova:transport-start', onStart);
    window.addEventListener('nova:transport-stop', onStop);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('nova:transport-start', onStart);
      window.removeEventListener('nova:transport-stop', onStop);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    };
  }, []);

  // Échantillonnage de l'écriture + faders qui suivent la courbe pendant la lecture.
  useEffect(() => {
    let raf = 0;
    const sorted = new WeakMap<object, ReturnType<typeof sortedPoints>>();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!audioEngine.getIsPlaying()) return;
      automationRecorder.tick();
      const time = audioEngine.getCurrentTime();
      for (const track of depsRef.current.stateRef.current.tracks) {
        for (const lane of playedLanes(track)) {
          if (!lane.points?.length || !isFaderParam(lane.parameterName)) continue;
          const param = lane.parameterName;
          const out = automationRecorder.activeOutput(track.id, param);
          if (out !== null) { publishLive(liveKey(track.id, param), out); continue; }
          let pts = sorted.get(lane.points);
          if (!pts) { pts = sortedPoints(lane.points); sorted.set(lane.points, pts); }
          publishLive(liveKey(track.id, param), valueAtPoints(pts, time, staticParamValue(track, param) ?? 0));
        }
      }
      // Paramètres en cours d'écriture sans voie (première passe).
      for (const { trackId, param } of automationRecorder.activeKeys()) {
        const out = automationRecorder.activeOutput(trackId, param);
        if (out !== null) publishLive(liveKey(trackId, param), out);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

}
