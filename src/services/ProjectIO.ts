

import JSZip from 'jszip';
import { DAWState, Clip } from '../types';
import { audioBufferToWav } from '../services/AudioUtils';
import { audioEngine } from '../engine/AudioEngine';
import { SessionSerializer } from '../services/SessionSerializer';

export class ProjectIO {
  
  /**
   * Sauvegarde l'état actuel et les fichiers audio dans un ZIP.
   * EXCLUSION INTELLIGENTE : Les fichiers audio des instruments du store non achetés ne sont PAS inclus.
   */
  public static async saveProject(state: DAWState, ownedInstrumentIds: number[] = []): Promise<Blob> {
    const zip = new JSZip();
    
    // 1. Clonage de l'état pour modification (on retire les buffers lourds du JSON)
    const serializableState = JSON.parse(JSON.stringify(SessionSerializer.serializeSession(state)));
    
    const audioFolder = zip.folder("audio");
    
    // 2. Itération sur les pistes et clips pour extraire l'audio
    for (let tIndex = 0; tIndex < state.tracks.length; tIndex++) {
        const track = state.tracks[tIndex];
        const sTrack = serializableState.tracks[tIndex]; // Track correspondante dans l'objet serializable
        
        // VÉRIFICATION LICENCE : 
        // Si la piste est liée à un instrument du store (instrumentId présent)
        // ET que l'utilisateur ne possède pas cet ID, on n'exporte pas le fichier audio.
        const isUnlicensedStoreBeat = track.instrumentId !== undefined && !ownedInstrumentIds.includes(track.instrumentId);

        for (let cIndex = 0; cIndex < track.clips.length; cIndex++) {
            const clip = track.clips[cIndex];
            const sClip = sTrack.clips[cIndex];
            
            if (clip.buffer) {
                const filename = `${clip.id}.wav`;
                
                // On met à jour la référence dans le JSON quoi qu'il arrive
                // (Comme ça la structure du projet reste intacte)
                sClip.audioRef = `audio/${filename}`;
                delete sClip.buffer; 

                // SAUVEGARDE CONDITIONNELLE DU FICHIER WAV
                if (!isUnlicensedStoreBeat) {
                    // Conversion AudioBuffer -> WAV Blob
                    const wavBlob = audioBufferToWav(clip.buffer);
                    if (audioFolder) {
                        audioFolder.file(filename, wavBlob);
                    }
                } else {
                    console.log(`[ProjectIO] Exclusion audio (Licence manquante) pour : ${track.name}`);
                    // On marque le clip comme "unlicensed" dans le JSON pour l'info
                    sClip.isUnlicensed = true;
                }
            }
        }
    }
    
    // 3. Ajout du fichier JSON d'état
    zip.file("project.json", JSON.stringify(serializableState, null, 2));
    
    // 4. Génération du Blob final
    return await zip.generateAsync({ type: "blob" });
  }

  /**
   * Charge un projet depuis un fichier ZIP.
   */
  public static async loadProject(file: File): Promise<DAWState> {
    const zip = await JSZip.loadAsync(file);
    
    // 1. Lecture du JSON
    const jsonFile = zip.file("project.json");
    if (!jsonFile) throw new Error("Fichier project.json manquant dans l'archive.");
    
    const jsonContent = await jsonFile.async("string");
    
    // FIX: Added a try-catch block for robust JSON parsing. This prevents application crashes if the project file is corrupted or invalid by throwing a user-friendly error.
    let loadedState: any;
    try {
        loadedState = JSON.parse(jsonContent);
    } catch (e) {
        throw new Error("Fichier projet corrompu");
    }
    
    // Validate and sanitize project state
    loadedState = this.validateProjectState(loadedState);
    
    // Initialisation moteur si nécessaire
    await audioEngine.init();
    
    // 2. Reconstruction des AudioBuffers
    for (const track of loadedState.tracks) {
        for (const clip of track.clips) {
            if (clip.audioRef) {
                const audioFile = zip.file(clip.audioRef);
                if (audioFile) {
                    const arrayBuffer = await audioFile.async("arraybuffer");
                    // Décodage WebAudio
                    const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
                    clip.buffer = audioBuffer;
                } else {
                    console.warn(`[ProjectIO] Fichier audio manquant : ${clip.audioRef}`);
                    // Si le fichier manque (ex: non exporté car pas de licence), on laisse buffer undefined
                    // L'UI devra gérer l'affichage d'un clip "Offline"
                    if (clip.isUnlicensed) {
                        clip.name = `🚫 ${clip.name} (Licence requise)`;
                        clip.color = '#555555'; // Griser le clip
                    }
                }
                // Nettoyage de la ref interne
                delete clip.audioRef;
            }
        }
    }
    
    return loadedState as DAWState;
  }

  /**
   * Validate and provide default values for project state to prevent crashes
   */
  private static validateProjectState(state: any): DAWState {
    const validatedState: DAWState = {
      id: typeof state.id === 'string' ? state.id : `project-${Date.now()}`,
      name: typeof state.name === 'string' ? state.name : 'Untitled Project',
      tracks: Array.isArray(state.tracks) ? state.tracks : [],
      bpm: typeof state.bpm === 'number' && state.bpm > 0 ? state.bpm : 120,
      projectKey: typeof state.projectKey === 'number' ? state.projectKey : undefined,
      projectScale: typeof state.projectScale === 'string' ? state.projectScale : undefined,
      currentTime: typeof state.currentTime === 'number' ? state.currentTime : 0,
      isPlaying: typeof state.isPlaying === 'boolean' ? state.isPlaying : false,
      isRecording: typeof state.isRecording === 'boolean' ? state.isRecording : false,
      isLoopActive: typeof state.isLoopActive === 'boolean' ? state.isLoopActive : false,
      loopStart: typeof state.loopStart === 'number' ? state.loopStart : 0,
      loopEnd: typeof state.loopEnd === 'number' ? state.loopEnd : 8,
      selectedTrackId: typeof state.selectedTrackId === 'string' ? state.selectedTrackId : null,
      currentView: state.currentView || 'ARRANGER',
      projectPhase: state.projectPhase || 'MIXING',
      isLowLatencyMode: typeof state.isLowLatencyMode === 'boolean' ? state.isLowLatencyMode : false,
      isRecModeActive: typeof state.isRecModeActive === 'boolean' ? state.isRecModeActive : false,
      systemMaxLatency: typeof state.systemMaxLatency === 'number' ? state.systemMaxLatency : 0.1,
      recStartTime: (typeof state.recStartTime === 'number' || state.recStartTime === null) ? state.recStartTime : null,
      isDelayCompEnabled: typeof state.isDelayCompEnabled === 'boolean' ? state.isDelayCompEnabled : false,
    };

    // Validate tracks
    validatedState.tracks = validatedState.tracks.map((track: any) => ({
      id: track.id || `track-${Date.now()}-${Math.random()}`,
      name: track.name || 'Untitled Track',
      type: track.type || 'AUDIO',
      volume: typeof track.volume === 'number' ? track.volume : 0.8,
      pan: typeof track.pan === 'number' ? track.pan : 0,
      isMuted: typeof track.isMuted === 'boolean' ? track.isMuted : false,
      isSolo: typeof track.isSolo === 'boolean' ? track.isSolo : false,
      isTrackArmed: typeof track.isTrackArmed === 'boolean' ? track.isTrackArmed : false,
      isFrozen: typeof track.isFrozen === 'boolean' ? track.isFrozen : false,
      color: track.color || '#3b82f6',
      clips: Array.isArray(track.clips) ? track.clips : [],
      plugins: Array.isArray(track.plugins) ? track.plugins : [],
      automationLanes: Array.isArray(track.automationLanes) ? track.automationLanes : [],
      sends: Array.isArray(track.sends) ? track.sends : [],
      outputTrackId: track.outputTrackId || 'master',
      inputDeviceId: track.inputDeviceId || undefined,
      totalLatency: typeof track.totalLatency === 'number' ? track.totalLatency : 0,
      events: Array.isArray(track.events) ? track.events : [],
      drumPads: track.drumPads || undefined,
      instrumentId: track.instrumentId || undefined,
    }));

    return validatedState;
  }
}