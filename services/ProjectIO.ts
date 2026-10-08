import JSZip from 'jszip';
import { DAWState, Clip } from '../types';
import { wavOf } from './AudioUtils';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { shouldPersistFrozen } from './VstFreeze';
import { novaBridge } from './NovaBridge';
import { isTrackFrozen, FREEZE_SAME_SOUND, FREEZE_OTHER_SOUND } from '../utils/freeze';
import { getEditAuthor, SESSION_SCHEMA_VERSION, stampJournal } from '../utils/preFxEdits';
import { padSampleFiles, restorePadSamples } from '../utils/drumSamples';

export class ProjectIO {
  
  /**
   * Sauvegarde l'état actuel et les fichiers audio dans un ZIP.
   * EXCLUSION INTELLIGENTE : Les fichiers audio des instruments du store non achetés ne sont PAS inclus.
   */
  public static async saveProject(state: DAWState, ownedInstrumentIds: (string | number)[] = []): Promise<Blob> {
    const zip = new JSZip();
    
    // 1. Clonage de l'état pour modification (on retire les buffers lourds du JSON)
    const serializableState = JSON.parse(JSON.stringify(state));
    // Format de session : les anciennes versions ignorent simplement les champs ajoutés.
    serializableState.schemaVersion = SESSION_SCHEMA_VERSION;
    const author = getEditAuthor() || (novaBridge.isConnected() ? "l'ingé" : "l'artiste");
    
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
                // Rendu gelé : le son rendu est-il celui du clip ? Les identifiants des sons
                // changent à la réouverture : on garde seulement « même son » / « autre son ».
                if (sClip.freezeRef && typeof sClip.freezeRef.buf === 'string') {
                    sClip.freezeRef.buf = sClip.freezeRef.buf === clip.bufferId ? FREEZE_SAME_SOUND : FREEZE_OTHER_SOUND;
                }
                
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
                        const wavBlob = wavOf(buffer);
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

            // Justesse note par note (V19) : la prise d'origine voyage avec le
            // projet, pour revenir en arrière ou retoucher après réouverture.
            const srcId = clip.pitchEdit?.sourceBufferId;
            if (srcId && sClip.pitchEdit) {
                const srcBuf = audioBufferRegistry.get(srcId);
                if (srcBuf && !isUnlicensedStoreBeat) {
                    const filename = `${srcId}.wav`;
                    if (!written.has(filename)) {
                        written.add(filename);
                        if (audioFolder) audioFolder.file(filename, wavOf(srcBuf));
                    }
                    sClip.pitchEdit.sourceRef = `audio/${filename}`;
                }
                delete sClip.pitchEdit.sourceBufferId;
            }
            // Melodyne / VocAlign (ARA) : la prise d'origine voyage aussi (l'archive ARA est dans le JSON).
            const araSrcId = clip.araEdit?.sourceBufferId;
            if (araSrcId && sClip.araEdit) {
                const srcBuf = audioBufferRegistry.get(araSrcId);
                if (srcBuf && !isUnlicensedStoreBeat) {
                    const filename = `${araSrcId}.wav`;
                    if (!written.has(filename)) {
                        written.add(filename);
                        if (audioFolder) audioFolder.file(filename, wavOf(srcBuf));
                    }
                    sClip.araEdit.sourceRef = `audio/${filename}`;
                }
                delete sClip.araEdit.sourceBufferId;
            }
            // AudioSuite (R6) : la prise d'origine voyage aussi (« Revenir à l'original » après réouverture).
            const asSrcId = clip.audioSuite?.sourceBufferId;
            if (asSrcId && sClip.audioSuite) {
                const srcBuf = audioBufferRegistry.get(asSrcId);
                if (srcBuf && !isUnlicensedStoreBeat) {
                    const filename = `${asSrcId}.wav`;
                    if (!written.has(filename)) {
                        written.add(filename);
                        if (audioFolder) audioFolder.file(filename, wavOf(srcBuf));
                    }
                    sClip.audioSuite.sourceRef = `audio/${filename}`;
                }
                delete sClip.audioSuite.sourceBufferId;
            }
        }

        // Samples perso des pads de batterie (V16) : un WAV par sample.
        for (const f of padSampleFiles(track, k => audioBufferRegistry.get(k))) {
            if (!written.has(f.filename)) { written.add(f.filename); if (audioFolder) audioFolder.file(f.filename, wavOf(f.buffer)); }
            sTrack.drumMachine.samples[f.id].audioRef = `audio/${f.filename}`;
        }

        // RENDU GELÉ (effets VST3 du PC rendus dans l'audio) : il permet de
        // continuer le projet sur un téléphone. Jamais pour le beat (licence).
        const frozenBuffer = track.frozenClip?.bufferId ? audioBufferRegistry.get(track.frozenClip.bufferId) : undefined;
        if (track.frozenClip && frozenBuffer && shouldPersistFrozen(track)) {
            const filename = `frozen-${track.id}.wav`;
            if (audioFolder) audioFolder.file(filename, wavOf(frozenBuffer));
            sTrack.frozenClip.audioRef = `audio/${filename}`;
            delete sTrack.frozenClip.buffer;
            delete sTrack.frozenClip.bufferId;
            // Ouvert ailleurs, le projet lit le rendu (sans pont, les VST3 ne sonneraient pas).
            sTrack.isFrozen = true;
            // Rendu gardé en cache sur le PC (pas gelé à la main) : gel automatique,
            // la piste se dégèlera toute seule sur un PC qui a les plugins.
            if (!isTrackFrozen(track)) sTrack.frozenAuto = true;
        } else {
            delete sTrack.frozenClip;
            delete sTrack.frozenUpToPluginIndex;
            delete sTrack.frozenClipIds;
            delete sTrack.frozenSourceSig;
            delete sTrack.frozenPluginSig;
            delete sTrack.frozenAuto;
            sTrack.isFrozen = false;
        }

        // Rendus des envois vers un bus VST gelé (reverb de l'ingé) : gardés si le bus l'est.
        const keptSends: any[] = [];
        (track.sendFreezes || []).forEach((sf, i) => {
            const bus = state.tracks.find(b => b.id === sf.busId);
            const buf = sf.clip.bufferId ? audioBufferRegistry.get(sf.clip.bufferId) : undefined;
            if (!bus || !buf || !bus.frozenClip || bus.frozenClip.id !== sf.busRenderId || !shouldPersistFrozen(bus)) return;
            const filename = `send-${track.id}-${sf.busId}.wav`;
            if (audioFolder) audioFolder.file(filename, wavOf(buf));
            const sSf = sTrack.sendFreezes[i];
            sSf.clip.audioRef = `audio/${filename}`;
            delete sSf.clip.buffer;
            delete sSf.clip.bufferId;
            keptSends.push(sSf);
        });
        if (keptSends.length) sTrack.sendFreezes = keptSends; else delete sTrack.sendFreezes;

        // Photo du gel (éditions pré-effet) : gardée tant qu'un rendu s'y rapporte.
        // Le son d'un clip supprimé depuis le gel reste dans la session : l'ingé peut y revenir.
        const base = track.freezeBase;
        const baseLive = !!base && ((!!sTrack.frozenClip && track.frozenClip?.id === base.renderId) || keptSends.some(sf => sf.anchorId === base.renderId));
        if (base && baseLive) {
            (sTrack.freezeBase.clips || []).forEach((bc: any) => {
                const buf = bc.bufferId ? audioBufferRegistry.get(bc.bufferId) : undefined;
                if (buf && !isUnlicensedStoreBeat) {
                    const filename = `${bc.bufferId}.wav`;
                    if (!written.has(filename)) { written.add(filename); if (audioFolder) audioFolder.file(filename, wavOf(buf)); }
                    bc.audioRef = `audio/${filename}`;
                }
                delete bc.bufferId;
            });
            const journal = stampJournal(track, author);
            if (journal) sTrack.preFxJournal = journal; else delete sTrack.preFxJournal;
        } else {
            delete sTrack.freezeBase;
            delete sTrack.preFxJournal;
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
            // Rendu gelé : « même son » retrouve l'identifiant du son rechargé.
            if (clip.freezeRef?.buf === FREEZE_SAME_SOUND) {
                if (clip.bufferId) clip.freezeRef.buf = clip.bufferId; else delete clip.freezeRef.buf;
            }
            // Prise d'origine d'un clip retouché par Melodyne / VocAlign (ARA).
            const ae = clip.araEdit;
            if (ae?.sourceRef) {
                const ref = ae.sourceRef;
                delete ae.sourceRef;
                const already = decoded.get(ref);
                const srcFile = zip.file(ref);
                if (already) ae.sourceBufferId = already;
                else if (srcFile) {
                    try {
                        const srcBuf = await audioEngine.ctx!.decodeAudioData(await srcFile.async("arraybuffer"));
                        ae.sourceBufferId = audioBufferRegistry.register(srcBuf, `${clip.id}-ara-origine`);
                        decoded.set(ref, ae.sourceBufferId);
                    } catch (e) {
                        console.warn(`[ProjectIO] Prise d'origine illisible : ${ref}`, e);
                    }
                }
            }
            // Prise d'origine d'un clip traité par AudioSuite (R6).
            const suite = clip.audioSuite;
            if (suite?.sourceRef) {
                const ref = suite.sourceRef;
                delete suite.sourceRef;
                const already = decoded.get(ref);
                const srcFile = zip.file(ref);
                if (already) suite.sourceBufferId = already;
                else if (srcFile) {
                    try {
                        const srcBuf = await audioEngine.ctx!.decodeAudioData(await srcFile.async("arraybuffer"));
                        suite.sourceBufferId = audioBufferRegistry.register(srcBuf, `${clip.id}-audiosuite-origine`);
                        decoded.set(ref, suite.sourceBufferId);
                    } catch (e) {
                        console.warn(`[ProjectIO] Prise d'origine illisible : ${ref}`, e);
                    }
                }
            }
            // Prise d'origine d'un clip corrigé en justesse (V19).
            const pe = clip.pitchEdit;
            if (pe?.sourceRef) {
                const ref = pe.sourceRef;
                delete pe.sourceRef;
                const already = decoded.get(ref);
                const srcFile = zip.file(ref);
                if (already) pe.sourceBufferId = already;
                else if (srcFile) {
                    try {
                        const srcBuf = await audioEngine.ctx!.decodeAudioData(await srcFile.async("arraybuffer"));
                        pe.sourceBufferId = audioBufferRegistry.register(srcBuf, `${clip.id}-justesse-origine`);
                        decoded.set(ref, pe.sourceBufferId);
                    } catch (e) {
                        console.warn(`[ProjectIO] Prise d'origine illisible : ${ref}`, e);
                    }
                }
            }
        }

        // Samples perso des pads de batterie (V16).
        await restorePadSamples(track,
            async ref => { const f = zip.file(ref); return f ? await audioEngine.ctx!.decodeAudioData(await f.async("arraybuffer")) : null; },
            (b, k) => audioBufferRegistry.register(b, k));

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

        // Rendus d'envois (reverb VST gelée) : un rendu illisible est simplement retiré.
        if (Array.isArray(track.sendFreezes)) {
            const kept: any[] = [];
            for (const sf of track.sendFreezes) {
                const ref = sf?.clip?.audioRef;
                const audioFile = ref ? zip.file(ref) : null;
                if (!audioFile) continue;
                try {
                    const audioBuffer = await audioEngine.ctx!.decodeAudioData(await audioFile.async("arraybuffer"));
                    sf.clip.bufferId = audioBufferRegistry.register(audioBuffer, sf.clip.id);
                    delete sf.clip.audioRef;
                    delete sf.clip.buffer;
                    kept.push(sf);
                } catch (e) {
                    console.warn(`[ProjectIO] Rendu d'envoi illisible pour ${track.name}`, e);
                }
            }
            if (kept.length) track.sendFreezes = kept; else delete track.sendFreezes;
        }

        // Photo du gel : sons des clips d'origine (même fichier qu'un clip = même son).
        for (const bc of (track.freezeBase?.clips || [])) {
            const ref = bc.audioRef;
            delete bc.audioRef;
            if (!ref) continue;
            const already = decoded.get(ref);
            if (already) { bc.bufferId = already; continue; }
            const audioFile = zip.file(ref);
            if (!audioFile) continue;
            try {
                const audioBuffer = await audioEngine.ctx!.decodeAudioData(await audioFile.async("arraybuffer"));
                bc.bufferId = audioBufferRegistry.register(audioBuffer, `${bc.id}-base`);
                decoded.set(ref, bc.bufferId);
            } catch (e) {
                console.warn(`[ProjectIO] Son d'origine illisible (${track.name})`, e);
            }
        }
    }
    
    return loadedState as DAWState;
  }
}
