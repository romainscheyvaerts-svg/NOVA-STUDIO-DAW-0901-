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
import { salvageJson, repairProject } from '../utils/projectRepair';

/** Rapport de réparation posé sur l'état chargé (propriété non énumérable). */
export const REPAIR_REPORT = '__repairReport';

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
            // Ligne de gain rendue dans le fichier : le son d'origine voyage aussi (« Revenir »).
            const grSrcId = clip.gainRender?.sourceBufferId;
            if (grSrcId && sClip.gainRender) {
                const srcBuf = audioBufferRegistry.get(grSrcId);
                if (srcBuf && !isUnlicensedStoreBeat) {
                    const filename = `${grSrcId}.wav`;
                    if (!written.has(filename)) {
                        written.add(filename);
                        if (audioFolder) audioFolder.file(filename, wavOf(srcBuf));
                    }
                    sClip.gainRender.sourceRef = `audio/${filename}`;
                }
                delete sClip.gainRender.sourceBufferId;
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
            // Transposition / étirement / warp (R13) : le son d'origine voyage aussi (rouvrir le réglage, revenir).
            const elSrcId = clip.elastic?.sourceBufferId;
            if (elSrcId && sClip.elastic) {
                const srcBuf = audioBufferRegistry.get(elSrcId);
                if (srcBuf && !isUnlicensedStoreBeat) {
                    const filename = `${elSrcId}.wav`;
                    if (!written.has(filename)) {
                        written.add(filename);
                        if (audioFolder) audioFolder.file(filename, wavOf(srcBuf));
                    }
                    sClip.elastic.sourceRef = `audio/${filename}`;
                }
                delete sClip.elastic.sourceBufferId;
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
    
    // R21 · Clips retirés de la timeline gardés dans la liste des clips : leur son voyage aussi.
    if (Array.isArray(state.clipBin) && state.clipBin.length) {
        const kept: any[] = [];
        state.clipBin.forEach((c, i) => {
            const sc = serializableState.clipBin[i];
            const buf = c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined;
            if (c.bufferId && !buf) return; // son déjà libéré : rien à garder
            if (buf) {
                const filename = `${c.bufferId}.wav`;
                if (!written.has(filename)) { written.add(filename); if (audioFolder) audioFolder.file(filename, wavOf(buf)); }
                sc.audioRef = `audio/${filename}`;
                delete sc.bufferId;
            }
            delete sc.buffer;
            kept.push(sc);
        });
        if (kept.length) serializableState.clipBin = kept; else delete serializableState.clipBin;
    }

    // 3. Ajout du fichier JSON d'état
    zip.file("project.json", JSON.stringify(serializableState, null, 2));
    
    // 4. Génération du Blob final
    return await zip.generateAsync({ type: "blob" });
  }

  /**
   * Charge un projet depuis un fichier ZIP.
   */
  public static async loadProject(file: File | Blob, opts: { bufferPrefix?: string } = {}): Promise<DAWState> {
    // R21 · Import depuis une session : les sons du projet importé sont enregistrés sous
    // un préfixe, ils n'écrasent jamais ceux du projet ouvert (mêmes identifiants de clips).
    const reg = (b: AudioBuffer, key?: string) => audioBufferRegistry.register(b, opts.bufferPrefix && key ? `${opts.bufferPrefix}${key}` : key);
    // Projet abîmé (écriture interrompue, son manquant, identifiants en double…) :
    // il s'ouvre quand même, réparé (utils/projectRepair), avec un rapport lisible
    // par ProjectIO.repairReportOf(état). On ne lève que si RIEN n'est récupérable.
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (e) {
        throw new Error("Archive illisible : ce fichier n'est pas un projet NOVA ou il est trop abîmé pour être ouvert.");
    }
    const files = Object.keys(zip.files).filter(f => !zip.files[f].dir);
    const audioFiles = files.filter(f => /\.(wav|mp3|ogg|oga|flac|m4a|aac|webm)$/i.test(f));
    const preReport: string[] = [];

    // 1. Lecture du JSON (tronqué : lu jusqu'à la dernière valeur complète)
    const jsonFile = zip.file("project.json");
    let loadedState: any = null;
    let truncated = false;
    if (jsonFile) {
        const jsonContent = await jsonFile.async("string");
        const s = salvageJson(jsonContent);
        loadedState = s.value && typeof s.value === 'object' && !Array.isArray(s.value) ? s.value : null;
        truncated = s.truncated;
        if (s.truncated && loadedState) preReport.push("Fichier projet incomplet (écriture interrompue) : tout ce qui était lisible a été repris.");
    }
    if (!loadedState || !Array.isArray(loadedState.tracks)) {
        // Rien de lisible dans le JSON, mais des sons dans l'archive : on les remet sur des pistes.
        if (audioFiles.length) {
            loadedState = { ...(loadedState || {}), tracks: audioFiles.map((ref, i) => ({
                id: `recup-${i + 1}`, name: `Son récupéré ${i + 1}`, type: 'AUDIO', outputTrackId: 'master',
                clips: [{ id: `recup-clip-${i + 1}`, name: ref.split('/').pop()!.replace(/\.[^.]+$/, ''), start: 0, duration: 1, offset: 0, fadeIn: 0, fadeOut: 0, type: 'AUDIO', color: '#64748b', audioRef: ref, __salvaged: true }],
            })) };
            preReport.push(`${jsonFile ? 'Fichier projet illisible' : 'Fichier projet absent'} : ${audioFiles.length} son${audioFiles.length > 1 ? 's' : ''} de l'archive remis sur des pistes « Son récupéré » (placement d'origine perdu).`);
        } else if (!jsonFile) {
            throw new Error("Fichier project.json manquant dans l'archive : aucun projet ni aucun son à récupérer.");
        } else if (!loadedState || truncated) {
            throw new Error("Fichier projet corrompu : rien n'a pu être récupéré (ni pistes ni sons).");
        } else {
            throw new Error("Format de projet invalide : aucune piste dans ce fichier.");
        }
    }

    const fixed = repairProject(loadedState, { audioRefs: new Set(files) });
    if (fixed.fatal || !fixed.state) throw new Error(`Fichier projet corrompu : ${fixed.fatal || 'illisible'}`);
    loadedState = fixed.state;
    const report = [...preReport, ...fixed.report];
    let unreadable = 0;
    const unreadableTracks = new Set<string>();

    // Initialisation moteur si nécessaire
    await audioEngine.init();

    // 2. Reconstruction des AudioBuffers via Registry (un décodage par fichier)
    const decoded = new Map<string, string>();
    const failed = new Set<string>();
    for (const track of loadedState.tracks) {
        for (const clip of track.clips) {
            if (clip.audioRef) {
                const audioFile = zip.file(clip.audioRef);
                const already = decoded.get(clip.audioRef);
                if (already) {
                    clip.bufferId = already;
                    delete clip.buffer;
                } else if (audioFile && !failed.has(clip.audioRef)) {
                    try {
                        const arrayBuffer = await audioFile.async("arraybuffer");
                        // Décodage WebAudio
                        const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);

                        // Enregistrer dans le registry et stocker l'ID
                        const bufferId = reg(audioBuffer, clip.id);
                        clip.bufferId = bufferId;
                        decoded.set(clip.audioRef, bufferId);
                        if (clip.__salvaged) clip.duration = audioBuffer.duration;
                    } catch (e) {
                        // Son abîmé : le clip reste à sa place, hors ligne ; le reste du projet s'ouvre.
                        console.warn(`[ProjectIO] Son illisible : ${clip.audioRef}`, e);
                        failed.add(clip.audioRef);
                        clip.isOffline = true;
                        unreadable++;
                        unreadableTracks.add(track.name);
                    }

                    // NE PAS mettre le buffer directement sur le clip (Immer incompatible)
                    delete clip.buffer;
                } else if (audioFile) {
                    clip.isOffline = true;
                    unreadable++;
                    unreadableTracks.add(track.name);
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
            delete clip.__salvaged;
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
                        ae.sourceBufferId = reg(srcBuf, `${clip.id}-ara-origine`);
                        decoded.set(ref, ae.sourceBufferId);
                    } catch (e) {
                        console.warn(`[ProjectIO] Prise d'origine illisible : ${ref}`, e);
                    }
                }
            }
            // Son d'origine d'un clip dont la ligne de gain a été rendue (utils/clipGain).
            const gr = clip.gainRender;
            if (gr?.sourceRef) {
                const ref = gr.sourceRef;
                delete gr.sourceRef;
                const already = decoded.get(ref);
                const srcFile = zip.file(ref);
                if (already) gr.sourceBufferId = already;
                else if (srcFile) {
                    try {
                        const srcBuf = await audioEngine.ctx!.decodeAudioData(await srcFile.async("arraybuffer"));
                        gr.sourceBufferId = reg(srcBuf, `${clip.id}-gain-origine`);
                        decoded.set(ref, gr.sourceBufferId);
                    } catch (e) {
                        console.warn(`[ProjectIO] Son d'origine illisible : ${ref}`, e);
                    }
                }
            }
            // Son d'origine d'un clip transposé / étiré / recalé (R13).
            const el = clip.elastic;
            if (el?.sourceRef) {
                const ref = el.sourceRef;
                delete el.sourceRef;
                const already = decoded.get(ref);
                const srcFile = zip.file(ref);
                if (already) el.sourceBufferId = already;
                else if (srcFile) {
                    try {
                        const srcBuf = await audioEngine.ctx!.decodeAudioData(await srcFile.async("arraybuffer"));
                        el.sourceBufferId = reg(srcBuf, `${clip.id}-elastic-origine`);
                        decoded.set(ref, el.sourceBufferId);
                    } catch (e) {
                        console.warn(`[ProjectIO] Son d'origine illisible : ${ref}`, e);
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
                        suite.sourceBufferId = reg(srcBuf, `${clip.id}-audiosuite-origine`);
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
                        pe.sourceBufferId = reg(srcBuf, `${clip.id}-justesse-origine`);
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
            (b, k) => audioBufferRegistry.register(b, k)); // clé = celle du pad (pas de préfixe)

        // Rendu gelé : décodé à la fréquence de l'appareil (rééchantillonné si
        // le téléphone tourne en 48 kHz et le PC en 44,1 kHz).
        if (track.frozenClip?.audioRef) {
            const audioFile = zip.file(track.frozenClip.audioRef);
            delete track.frozenClip.audioRef;
            if (audioFile) {
                try {
                    const audioBuffer = await audioEngine.ctx!.decodeAudioData(await audioFile.async("arraybuffer"));
                    track.frozenClip.bufferId = reg(audioBuffer, track.frozenClip.id);
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
                    sf.clip.bufferId = reg(audioBuffer, sf.clip.id);
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
                bc.bufferId = reg(audioBuffer, `${bc.id}-base`);
                decoded.set(ref, bc.bufferId);
            } catch (e) {
                console.warn(`[ProjectIO] Son d'origine illisible (${track.name})`, e);
            }
        }
    }
    // R21 · Sons des clips de la liste (hors timeline).
    if (Array.isArray(loadedState.clipBin)) {
        const kept: any[] = [];
        for (const c of loadedState.clipBin) {
            if (!c || typeof c !== 'object' || typeof c.id !== 'string') continue;
            const ref = c.audioRef;
            delete c.audioRef;
            if (ref) {
                const already = decoded.get(ref);
                const f = zip.file(ref);
                if (already) c.bufferId = already;
                else if (f) {
                    try {
                        const b = await audioEngine.ctx!.decodeAudioData(await f.async("arraybuffer"));
                        c.bufferId = reg(b, c.id);
                        decoded.set(ref, c.bufferId);
                    } catch { c.isOffline = true; }
                } else c.isOffline = true;
            }
            kept.push(c);
        }
        loadedState.clipBin = kept;
    }
    if (unreadable) {
        const list = [...unreadableTracks];
        report.push(`${unreadable} clip${unreadable > 1 ? 's' : ''} dont le son est abîmé (illisible) : gardé${unreadable > 1 ? 's' : ''} hors ligne (${list.slice(0, 3).map(x => `« ${x} »`).join(', ')}${list.length > 3 ? '…' : ''}).`);
    }
    if (report.length) {
        console.warn('[ProjectIO] Projet réparé :', report);
        // Non énumérable : jamais sérialisé ni recopié dans l'historique (JSON, spread, immer).
        Object.defineProperty(loadedState, REPAIR_REPORT, { value: report, enumerable: false, configurable: true, writable: true });
    }
    return loadedState as DAWState;
  }

  /**
   * Rapport de réparation du dernier chargement (« 3 clips en double renommés »…),
   * null si le projet était intact. À lire juste après loadProject : l'état
   * recopié (spread, immer) ne le garde pas.
   */
  public static repairReportOf(state: unknown): string[] | null {
    const r = state && typeof state === 'object' ? (state as any)[REPAIR_REPORT] : null;
    return Array.isArray(r) && r.length ? r : null;
  }
}
