import JSZip from 'jszip';
import { DAWState, Clip } from '../types';
import { audioBufferToWav } from './AudioUtils';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { shouldPersistFrozen } from './VstFreeze';

export class ProjectIO {
  
  /**
   * Sauvegarde l'état actuel et les fichiers audio dans un ZIP.
   * EXCLUSION INTELLIGENTE : Les fichiers audio des instruments du store non achetés ne sont PAS inclus.
   */
  public static async saveProject(state: DAWState, ownedInstrumentIds: (string | number)[] = []): Promise<Blob> {
    const zip = new JSZip();
    
    // 1. Clonage de l'état pour modification (on retire les buffers lourds du JSON)
    const serializableState = JSON.parse(JSON.stringify(state));
    
    const audioFolder = zip.folder("audio");
    // Un même enregistrement peut porter plusieurs clips (prise découpée par le
    // retrait des blancs) : on l'écrit une seule fois.
    const written = new Set<string>();
    
    // 2. Itération sur les pistes et clips pour extraire l'audio
    for (let tIndex = 0; tIndex < state.tracks.length; tIndex++) {
        const track = state.tracks[tIndex];
        const sTrack = serializableState.tracks[tIndex]; // Track correspondante dans l'objet serializable
        
        // VÉRIFICATION LICENCE : 
        // Si la piste est liée à un instrument du store (instrumentId présent)
        // ET que l'utilisateur ne possède pas cet ID, on n'exporte pas le fichier audio.
        // Comparaison en texte : le catalogue utilise des UUID, l'ancien schema
        // de licences des entiers.
        const possedes = (ownedInstrumentIds || []).map(id => String(id));
        const isUnlicensedStoreBeat = track.instrumentId !== undefined && !possedes.includes(String(track.instrumentId));

        for (let cIndex = 0; cIndex < track.clips.length; cIndex++) {
            const clip = track.clips[cIndex];
            const sClip = sTrack.clips[cIndex];
            
            // Récupérer le buffer depuis le registry via bufferId
            const buffer = clip.bufferId ? audioBufferRegistry.get(clip.bufferId) : clip.buffer;
            
            if (buffer) {
                const filename = `${clip.bufferId || clip.id}.wav`;
                
                // On met à jour la référence dans le JSON quoi qu'il arrive
                // (Comme ça la structure du projet reste intacte)
                sClip.audioRef = `audio/${filename}`;
                delete sClip.buffer;
                delete sClip.bufferId; // On retire la référence au registry

                // SAUVEGARDE CONDITIONNELLE DU FICHIER WAV
                if (!isUnlicensedStoreBeat) {
                    if (!written.has(filename)) {
                        written.add(filename);
                        // Conversion AudioBuffer -> WAV Blob
                        const wavBlob = audioBufferToWav(buffer);
                        if (audioFolder) {
                            audioFolder.file(filename, wavBlob);
                        }
                    }
                } else {
                    console.log(`[ProjectIO] Exclusion audio (Licence manquante) pour : ${track.name}`);
                    // On marque le clip comme "unlicensed" dans le JSON pour l'info
                    sClip.isUnlicensed = true;
                }
            }
        }

        // RENDU GELÉ (effets VST3 du PC rendus dans l'audio) : il permet de
        // continuer le projet sur un téléphone. Jamais pour le beat (licence).
        const frozenBuffer = track.frozenClip?.bufferId ? audioBufferRegistry.get(track.frozenClip.bufferId) : undefined;
        if (track.frozenClip && frozenBuffer && shouldPersistFrozen(track)) {
            const filename = `frozen-${track.id}.wav`;
            if (audioFolder) audioFolder.file(filename, audioBufferToWav(frozenBuffer));
            sTrack.frozenClip.audioRef = `audio/${filename}`;
            delete sTrack.frozenClip.buffer;
            delete sTrack.frozenClip.bufferId;
            // Ouvert ailleurs, le projet lit le rendu (sans pont, les VST3 ne sonneraient pas).
            sTrack.isFrozen = true;
        } else {
            delete sTrack.frozenClip;
            delete sTrack.frozenUpToPluginIndex;
            delete sTrack.frozenClipIds;
            delete sTrack.frozenSourceSig;
            sTrack.isFrozen = false;
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
    if (!loadedState.tracks || !Array.isArray(loadedState.tracks)) {
        throw new Error("Format de projet invalide");
    }
    
    // Initialisation moteur si nécessaire
    await audioEngine.init();
    
    // 2. Reconstruction des AudioBuffers via Registry (un décodage par fichier)
    const decoded = new Map<string, string>();
    for (const track of loadedState.tracks) {
        for (const clip of track.clips) {
            if (clip.audioRef) {
                const audioFile = zip.file(clip.audioRef);
                const already = decoded.get(clip.audioRef);
                if (already) {
                    clip.bufferId = already;
                    delete clip.buffer;
                } else if (audioFile) {
                    const arrayBuffer = await audioFile.async("arraybuffer");
                    // Décodage WebAudio
                    const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
                    
                    // Enregistrer dans le registry et stocker l'ID
                    const bufferId = audioBufferRegistry.register(audioBuffer, clip.id);
                    clip.bufferId = bufferId;
                    decoded.set(clip.audioRef, bufferId);
                    
                    // NE PAS mettre le buffer directement sur le clip (Immer incompatible)
                    delete clip.buffer;
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

        // Rendu gelé : décodé à la fréquence de l'appareil (rééchantillonné si
        // le téléphone tourne en 48 kHz et le PC en 44,1 kHz).
        if (track.frozenClip?.audioRef) {
            const audioFile = zip.file(track.frozenClip.audioRef);
            delete track.frozenClip.audioRef;
            if (audioFile) {
                try {
                    const audioBuffer = await audioEngine.ctx!.decodeAudioData(await audioFile.async("arraybuffer"));
                    track.frozenClip.bufferId = audioBufferRegistry.register(audioBuffer, track.frozenClip.id);
                    delete track.frozenClip.buffer;
                } catch (e) {
                    console.warn(`[ProjectIO] Rendu gelé illisible pour ${track.name}`, e);
                    delete track.frozenClip;
                    track.isFrozen = false;
                }
            } else {
                delete track.frozenClip;
                track.isFrozen = false;
            }
        }
    }
    
    return loadedState as DAWState;
  }
}
