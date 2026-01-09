
import { DAWState, Track, ProjectPhase } from '../types';
import { audioEngine } from '../engine/AudioEngine';

/**
 * SESSION MANAGER : Le chef d'orchestre technique du DAW
 * Gère les transitions critiques entre Mixage et Enregistrement.
 */
export class SessionManager {
  
  /**
   * Prépare le projet pour une prise de voix (Latence Zéro)
   */
  public static prepareForRecording(state: DAWState): DAWState {
    const updatedTracks = state.tracks.map(track => {
      // 1. Identifier les pistes qui causent de la latence (PDC > 0)
      const hasLatencyPlugins = track.plugins.some(p => p.latency > 0 && p.isEnabled);
      
      if (hasLatencyPlugins && track.id !== 'track-rec') {
        // Geler la piste : on désactive les plugins lourds mais on garde le gain
        return {
          ...track,
          isFrozen: true,
          plugins: track.plugins.map(p => ({
            ...p,
            isEnabled: p.latency === 0 // On ne garde que les plugins à latence zéro (EQ, Gain)
          }))
        };
      }
      return track;
    });

    // 2. Désactiver globalement la PDC dans le moteur audio
    audioEngine.setRecMode(true);

    return {
      ...state,
      tracks: updatedTracks,
      isRecModeActive: true,
      projectPhase: ProjectPhase.RECORDING,
      isRecording: true
    };
  }

  /**
   * Restaure le projet pour le mixage (PDC Active)
   */
  public static finalizeRecording(state: DAWState): DAWState {
    const restoredTracks = state.tracks.map(track => {
      if (track.isFrozen) {
        return {
          ...track,
          isFrozen: false,
          plugins: track.plugins.map(p => ({
            ...p,
            isEnabled: true // On réactive tout
          }))
        };
      }
      return track;
    });

    // Réactiver la PDC
    audioEngine.setRecMode(false);

    return {
      ...state,
      tracks: restoredTracks,
      isRecModeActive: false,
      projectPhase: ProjectPhase.MIXING,
      isRecording: false
    };
  }
}
