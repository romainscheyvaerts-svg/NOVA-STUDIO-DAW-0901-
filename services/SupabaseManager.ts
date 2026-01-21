
import { supabase, catalogSupabase } from './supabase';
import { User, DAWState, Clip, Instrument, Instrumental, PendingUpload, Track } from '../types';
import { audioBufferToWav } from './AudioUtils';
import { audioEngine } from '../engine/AudioEngine';
import { SessionSerializer } from './SessionSerializer';

export class SupabaseManager {
  private static instance: SupabaseManager;
  private currentUser: any = null;
  
  // Auto-Save State
  private autoSaveIntervalId: number | null = null;
  private uploadedBlobsCache: Map<string, string> = new Map(); // Cache local: BlobURL -> RemoteURL

  private constructor() {
    // Écouteur d'état de session au démarrage
    if (supabase) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        this.currentUser = session?.user || null;
      });

      supabase.auth.onAuthStateChange((_event, session) => {
        this.currentUser = session?.user || null;
      });
    }
  }

  public static getInstance(): SupabaseManager {
    if (!SupabaseManager.instance) {
      SupabaseManager.instance = new SupabaseManager();
    }
    return SupabaseManager.instance;
  }
  // FIX: Added missing 'getPublicInstrumentUrl' method to resolve errors in InstrumentCatalog component.
  /**
   * ACCÈS DIRECT STORAGE SUPABASE
   * Récupère l'URL publique d'un fichier dans le bucket 'instruments'.
   * Gère les chemins relatifs (stockés en DB) ou les URLs complètes.
   * Utilise le projet CATALOGUE (mxdrxpzxbgybchzzvpkf) pour les instruments.
   */
  public getPublicInstrumentUrl(pathOrUrl: string): string {
    if (!pathOrUrl) return '';
    
    // Si c'est un blob local, le retourner tel quel
    if (pathOrUrl.startsWith('blob:')) {
        return pathOrUrl;
    }
    
    // ==== GESTION DES URLs GOOGLE DRIVE ====
    // Détecter les URLs Google Drive et les convertir vers l'Edge Function proxy
    if (pathOrUrl.includes('drive.google.com') || pathOrUrl.includes('docs.google.com')) {
        const fileId = this.extractDriveFileId(pathOrUrl);
        if (fileId) {
            // Utiliser l'Edge Function Supabase comme proxy
            const proxyUrl = `https://sqduhfckgvyezdiubeei.supabase.co/functions/v1/stream-drive-audio?id=${fileId}`;
            return proxyUrl;
        } else {
            console.warn("[SupabaseManager] Impossible d'extraire l'ID du fichier Drive:", pathOrUrl);
            return pathOrUrl;
        }
    }
    
    // Si c'est déjà une URL HTTPS (autre que Drive), la retourner telle quelle
    if (pathOrUrl.startsWith('http')) {
        return pathOrUrl;
    }

    // Sinon, on génère l'URL publique depuis le bucket 'instruments' du projet CATALOGUE
    if (catalogSupabase) {
        const { data } = catalogSupabase.storage.from('instruments').getPublicUrl(pathOrUrl);
        return data.publicUrl;
    }

    return pathOrUrl;
  }

  /**
   * Extrait l'ID du fichier depuis une URL Google Drive
   */
  private extractDriveFileId(url: string): string | null {
    // Format: /file/d/FILE_ID/
    const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return fileMatch[1];
    
    // Format: ?id=FILE_ID (docs.google.com/uc?export=download&id=XXX)
    const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];
    
    // Format: /folders/FILE_ID
    const folderMatch = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) return folderMatch[1];
    
    // Format: open?id=FILE_ID
    const openMatch = url.match(/open\?id=([a-zA-Z0-9_-]+)/);
    if (openMatch) return openMatch[1];
    
    return null;
  }
  /**
   * Nettoie une chaîne pour en faire un nom de fichier sûr pour le Storage.
   * Minuscules, alphanumérique et tirets uniquement.
   */
  private sanitizeFilename(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9\-_]/g, '_').replace(/_+/g, '_');
  }

  // --- AUTO-SAVE ROUTINE (4 MINUTES) ---

  public startAutoSave(getState: () => DAWState) {
    this.stopAutoSave();
    console.log("[AutoSave] Timer démarré (4 min).");
    
    this.autoSaveIntervalId = window.setInterval(async () => {
        const currentState = getState();
        if (!currentState.isPlaying && !currentState.isRecording && this.currentUser) {
            console.log("[AutoSave] Déclenchement de la sauvegarde automatique...");
            await this.autoSaveProject(currentState);
        } else {
            console.log("[AutoSave] Reporté (Lecture/Enregistrement en cours ou utilisateur non connecté).");
        }
    }, 240000); 
  }

  public stopAutoSave() {
    if (this.autoSaveIntervalId) {
        clearInterval(this.autoSaveIntervalId);
        this.autoSaveIntervalId = null;
    }
  }

  private isCatalogUrl(url: string): boolean {
      if (!url) return false;
      // Check if the URL points to the 'instruments' bucket (public catalog)
      return url.includes('/instruments/') && !url.startsWith('blob:');
  }

  public async autoSaveProject(state: DAWState) {
    if (!supabase || !state.id) return;
    
    // Récupération sécurisée de l'utilisateur
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    try {
        const backupState: DAWState = JSON.parse(JSON.stringify(SessionSerializer.serializeSession(state)));
        const uploadPromises: Promise<void>[] = [];
        const BUCKET_NAME = 'project-assets';
        
        // Si le projet est un brouillon (proj-1), on crée un dossier temporaire unique
        // Sinon on utilise l'ID réel du projet pour grouper les fichiers
        const projectId = state.id.includes('proj-1') ? `draft_${Date.now()}` : state.id;

        // 1. Process Timeline Clips
        state.tracks.forEach((track, tIdx) => {
            track.clips.forEach((clip, cIdx) => {
                if (clip.type === 'AUDIO' && clip.audioRef) {
                    // Skip catalog instruments
                    if (this.isCatalogUrl(clip.audioRef)) {
                        backupState.tracks[tIdx].clips[cIdx].audioRef = clip.audioRef;
                        return;
                    }

                    if (clip.audioRef.startsWith('blob:')) {
                        if (this.uploadedBlobsCache.has(clip.audioRef)) {
                             // Utilisation du cache si déjà uploadé
                             backupState.tracks[tIdx].clips[cIdx].audioRef = this.uploadedBlobsCache.get(clip.audioRef)!;
                        } else {
                             if (clip.buffer) {
                                 uploadPromises.push((async () => {
                                     const wavBlob = audioBufferToWav(clip.buffer!);
                                     const safeClipId = this.sanitizeFilename(clip.id);
                                     const filename = `${safeClipId}_autosave_${Date.now()}.wav`;
                                     const path = `${user.id}/${projectId}/${filename}`;

                                     const { error } = await supabase!.storage
                                         .from(BUCKET_NAME)
                                         .upload(path, wavBlob, { upsert: true });

                                     if (!error) {
                                         const { data: { publicUrl } } = supabase!.storage.from(BUCKET_NAME).getPublicUrl(path);
                                         backupState.tracks[tIdx].clips[cIdx].audioRef = publicUrl;
                                         this.uploadedBlobsCache.set(clip.audioRef!, publicUrl);
                                     }
                                 })());
                             }
                        }
                    }
                }
            });

            // 2. Process Drum Pads (for Drum Racks)
            if (track.type === 'DRUM_RACK' && track.drumPads) {
                track.drumPads.forEach((pad, pIdx) => {
                     // Check if pad has a valid audio source
                     if (pad.audioRef && pad.buffer) {
                         // Skip catalog instruments
                         if (this.isCatalogUrl(pad.audioRef)) {
                             if(backupState.tracks[tIdx].drumPads) {
                                 backupState.tracks[tIdx].drumPads![pIdx].audioRef = pad.audioRef;
                             }
                             return;
                         }

                         if (pad.audioRef.startsWith('blob:')) {
                             if (this.uploadedBlobsCache.has(pad.audioRef)) {
                                 if (backupState.tracks[tIdx].drumPads) {
                                    backupState.tracks[tIdx].drumPads![pIdx].audioRef = this.uploadedBlobsCache.get(pad.audioRef)!;
                                 }
                             } else {
                                 uploadPromises.push((async () => {
                                     const wavBlob = audioBufferToWav(pad.buffer!);
                                     const safeName = this.sanitizeFilename(pad.sampleName || `pad_${pad.id}`);
                                     const filename = `drum_${safeName}_${Date.now()}.wav`;
                                     const path = `${user.id}/${projectId}/${filename}`;

                                     const { error } = await supabase!.storage
                                         .from(BUCKET_NAME)
                                         .upload(path, wavBlob, { upsert: true });

                                     if (!error) {
                                         const { data: { publicUrl } } = supabase!.storage.from(BUCKET_NAME).getPublicUrl(path);
                                         if (backupState.tracks[tIdx].drumPads) {
                                            backupState.tracks[tIdx].drumPads![pIdx].audioRef = publicUrl;
                                         }
                                         this.uploadedBlobsCache.set(pad.audioRef!, publicUrl);
                                     }
                                 })());
                             }
                         }
                     }
                });
            }
        });

        if (uploadPromises.length > 0) {
            console.log(`[AutoSave] Upload de ${uploadPromises.length} nouveaux fichiers...`);
            await Promise.all(uploadPromises);
        }

        // Insertion en base avec user_id explicite pour satisfaire la policy RLS
        const { error } = await supabase
            .from('project_backups')
            .insert({
                project_id: state.id,
                project_data: backupState,
                user_id: user.id // CRITIQUE pour RLS
            });

        if (error) {
            console.error("[AutoSave] Erreur DB:", error);
        } else {
            console.log("[AutoSave] Snapshot sauvegardé avec succès.");
        }

    } catch (e) {
        console.error("[AutoSave] Echec critique:", e);
    }
  }

  // --- GESTION DES SESSIONS UTILISATEUR (CLOUD SAVE MANUEL) ---

  public async saveUserSession(state: DAWState, onProgress?: (percent: number, message: string) => void) {
    if (!supabase) throw new Error("Supabase non configuré");
    
    // VERIFICATION STRICTE DE L'UTILISATEUR ACTUEL
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
        throw new Error("Session expirée. Veuillez vous reconnecter avant de sauvegarder.");
    }

    const stateClone: DAWState = {
        ...state,
        tracks: state.tracks.map(t => ({
            ...t,
            clips: t.clips.map(c => ({ ...c })),
            drumPads: t.drumPads ? t.drumPads.map(p => ({ ...p })) : undefined
        }))
    };

    if (onProgress) onProgress(10, "Analyse des fichiers audio...");
    // On passe l'ID utilisateur confirmé à la méthode d'upload
    await this.processProjectAssets(stateClone, state, user.id, onProgress);

    const sessionData = SessionSerializer.serializeSession(stateClone);
    
    if (onProgress) onProgress(90, "Sauvegarde de la session...");

    const isNewProject = state.id === 'proj-1' || !state.id.includes('-');

    const payload: any = {
      user_id: user.id, // Use verified ID
      name: state.name,
      data: sessionData,
      updated_at: new Date().toISOString()
    };

    if (!isNewProject) {
        payload.id = state.id;
    }

    const { data, error } = await supabase
      .from('projects')
      .upsert(payload, { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      console.error("Erreur Sauvegarde Cloud:", error);
      throw new Error(`Erreur Cloud: ${error.message}`);
    }

    return data; 
  }

  /**
   * Parcourt clips et drum pads. Upload les fichiers locaux vers 'project-assets'.
   * IGNORE les fichiers provenant du bucket 'instruments'.
   */
  private async processProjectAssets(
      stateClone: DAWState, 
      originalState: DAWState,
      userId: string, // ID Utilisateur validé
      onProgress?: (percent: number, message: string) => void
  ) {
      const itemsToUpload: { 
          type: 'CLIP' | 'PAD',
          trackIndex: number, 
          itemIndex: number, 
          name: string, 
          buffer: AudioBuffer,
          id: string
      }[] = [];

      // 1. Scan Clips
      stateClone.tracks.forEach((track, tIdx) => {
          track.clips.forEach((clip, cIdx) => {
              const originalClip = originalState.tracks[tIdx].clips[cIdx];
              
              const isLocalBlob = clip.audioRef && clip.audioRef.startsWith('blob:');
              const hasBuffer = !!originalClip.buffer;
              const isCatalog = this.isCatalogUrl(clip.audioRef || '');
              const isAlreadyCloud = clip.audioRef && clip.audioRef.startsWith('http') && !isCatalog;

              if (clip.type === 'AUDIO' && (hasBuffer || isLocalBlob) && !isAlreadyCloud && !isCatalog) {
                  if (originalClip.buffer) {
                      itemsToUpload.push({ 
                          type: 'CLIP',
                          trackIndex: tIdx, 
                          itemIndex: cIdx, 
                          name: clip.name, 
                          buffer: originalClip.buffer,
                          id: clip.id
                      });
                  }
              }
          });

          // 2. Scan Drum Pads
          if (track.type === 'DRUM_RACK' && track.drumPads && originalState.tracks[tIdx].drumPads) {
              track.drumPads.forEach((pad, pIdx) => {
                  const originalPad = originalState.tracks[tIdx].drumPads![pIdx];
                  
                  const isLocalBlob = pad.audioRef && pad.audioRef.startsWith('blob:');
                  const hasBuffer = !!originalPad.buffer;
                  const isCatalog = this.isCatalogUrl(pad.audioRef || '');
                  const isAlreadyCloud = pad.audioRef && pad.audioRef.startsWith('http') && !isCatalog;
                  
                  if ((hasBuffer || isLocalBlob) && !isAlreadyCloud && !isCatalog) {
                      if (originalPad.buffer) {
                           itemsToUpload.push({
                               type: 'PAD',
                               trackIndex: tIdx,
                               itemIndex: pIdx,
                               name: pad.sampleName,
                               buffer: originalPad.buffer,
                               id: `pad_${pad.id}_${Date.now()}`
                           });
                      }
                  }
              });
          }
      });

      const total = itemsToUpload.length;
      if (total === 0) return;

      const BUCKET_NAME = 'project-assets';
      const projectId = (stateClone.id && stateClone.id !== 'proj-1') ? stateClone.id : `new_${Date.now()}`;

      for (let i = 0; i < total; i++) {
          const item = itemsToUpload[i];
          const progress = 10 + Math.round((i / total) * 80);
          if (onProgress) onProgress(progress, `Upload audio (${i + 1}/${total}) : ${item.name}`);

          try {
              const wavBlob = audioBufferToWav(item.buffer);
              const safeId = this.sanitizeFilename(item.id);
              const filename = `${safeId}.wav`;
              const path = `${userId}/${projectId}/${filename}`;

              const { error: uploadError } = await supabase!.storage
                  .from(BUCKET_NAME)
                  .upload(path, wavBlob, {
                      cacheControl: '3600',
                      upsert: true
                  });

              if (uploadError) throw uploadError;

              const { data: { publicUrl } } = supabase!.storage.from(BUCKET_NAME).getPublicUrl(path);

              // Update Ref in State Clone
              if (item.type === 'CLIP') {
                  stateClone.tracks[item.trackIndex].clips[item.itemIndex].audioRef = publicUrl;
              } else {
                  if (stateClone.tracks[item.trackIndex].drumPads) {
                      stateClone.tracks[item.trackIndex].drumPads![item.itemIndex].audioRef = publicUrl;
                  }
              }
              
              // Cache locally
              const originalRef = item.type === 'CLIP' 
                  ? originalState.tracks[item.trackIndex].clips[item.itemIndex].audioRef 
                  : originalState.tracks[item.trackIndex].drumPads![item.itemIndex].audioRef;
                  
              if (originalRef) this.uploadedBlobsCache.set(originalRef, publicUrl);

          } catch (e) {
              console.error(`Erreur upload ${item.name}`, e);
          }
      }
  }

  /**
   * SAUVEGARDER SOUS (SAVE AS COPY)
   */
  public async saveProjectAsCopy(state: DAWState, newName: string) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Veuillez vous connecter pour sauvegarder dans le cloud.");

    const stateCopy = { ...state, name: newName };
    const sessionData = SessionSerializer.serializeSession(stateCopy);

    const payload = {
      user_id: user.id,
      name: newName,
      data: sessionData,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('projects')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("Erreur Save As Copy:", error);
      throw new Error(`Erreur Copie: ${error.message}`);
    }

    return data;
  }

  // --- RÉCUPÉRATION DU DERNIER BACKUP AUTOMATIQUE ---
  
  /**
   * Charge le dernier backup automatique pour l'utilisateur connecté.
   * Utilisé au démarrage pour récupérer le travail après un rafraîchissement.
   */
  public async loadLatestAutoBackup(): Promise<DAWState | null> {
    if (!supabase) return null;
    
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    
    try {
      const { data, error } = await supabase
        .from('project_backups')
        .select('project_data, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (error || !data) {
        console.log("[AutoBackup] Aucun backup trouvé pour cet utilisateur");
        return null;
      }
      
      // Vérifier que le backup n'est pas trop vieux (max 24h)
      const backupDate = new Date(data.created_at);
      const now = new Date();
      const hoursOld = (now.getTime() - backupDate.getTime()) / (1000 * 60 * 60);
      
      if (hoursOld > 24) {
        console.log(`[AutoBackup] Backup trop ancien (${hoursOld.toFixed(1)}h), ignoré`);
        return null;
      }
      
      console.log(`[AutoBackup] Backup trouvé (${hoursOld.toFixed(1)}h), chargement...`);
      
      const loadedState = data.project_data as DAWState;
      await this.hydrateAudioBuffers(loadedState);
      
      return loadedState;
    } catch (e) {
      console.error("[AutoBackup] Erreur chargement backup:", e);
      return null;
    }
  }
  
  /**
   * Supprime les vieux backups (garde seulement les 5 derniers)
   */
  public async cleanOldBackups(): Promise<void> {
    if (!supabase) return;
    
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    
    try {
      // Récupérer tous les backups triés par date
      const { data: backups } = await supabase
        .from('project_backups')
        .select('id, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      
      if (!backups || backups.length <= 5) return;
      
      // Supprimer tous sauf les 5 plus récents
      const toDelete = backups.slice(5).map(b => b.id);
      
      if (toDelete.length > 0) {
        const { error } = await supabase
          .from('project_backups')
          .delete()
          .in('id', toDelete);
        
        if (!error) {
          console.log(`[AutoBackup] ${toDelete.length} vieux backups supprimés`);
        }
      }
    } catch (e) {
      console.error("[AutoBackup] Erreur nettoyage:", e);
    }
  }

  public async listUserSessions() {
    if (!supabase || !this.currentUser) return [];

    const { data, error } = await supabase
      .from('projects')
      .select('id, name, updated_at')
      .eq('user_id', this.currentUser.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  public async loadUserSession(sessionId: string): Promise<DAWState | null> {
    if (!supabase || !this.currentUser) return null;

    const { data, error } = await supabase
      .from('projects')
      .select('data, id, name')
      .eq('id', sessionId)
      .single();

    if (error) throw error;
    
    if (data) {
        const loadedState = data.data as DAWState;
        await this.hydrateAudioBuffers(loadedState);
        loadedState.id = data.id;
        loadedState.name = data.name;
        this.uploadedBlobsCache.clear();
        return loadedState;
    }
    return null;
  }

  private async hydrateAudioBuffers(state: DAWState) {
      await audioEngine.init();
      const promises: Promise<void>[] = [];

      state.tracks.forEach(track => {
          // 1. Hydrate Clips
          track.clips.forEach(clip => {
              if (clip.audioRef && !clip.buffer) {
                  const p = fetch(clip.audioRef)
                      .then(res => {
                          if (!res.ok) throw new Error(`HTTP ${res.status}`);
                          return res.arrayBuffer();
                      })
                      .then(arrayBuffer => audioEngine.ctx!.decodeAudioData(arrayBuffer))
                      .then(audioBuffer => {
                          clip.buffer = audioBuffer;
                      })
                      .catch(e => {
                          console.warn(`[Load] Impossible de charger le clip ${clip.name} (${clip.audioRef})`, e);
                          clip.name = `⚠️ ${clip.name} (Offline)`;
                          clip.color = '#555';
                      });
                  promises.push(p);
              }
          });
          
          // 2. Hydrate Drum Pads
          if (track.type === 'DRUM_RACK' && track.drumPads) {
              track.drumPads.forEach(pad => {
                  if (pad.audioRef && !pad.buffer) {
                      promises.push(this.fetchAndDecode(pad.audioRef).then(buf => {
                          if (buf) pad.buffer = buf;
                      }));
                  }
              });
          }
      });

      if (promises.length > 0) {
          await Promise.allSettled(promises);
      }
      
      // Update engine with loaded pads
      state.tracks.forEach(track => {
          if (track.type === 'DRUM_RACK') {
              audioEngine.updateTrack(track, state.tracks);
          }
      });
  }
  
  private async fetchAndDecode(url: string): Promise<AudioBuffer | null> {
      try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const arrayBuffer = await res.arrayBuffer();
          return await audioEngine.ctx!.decodeAudioData(arrayBuffer);
      } catch (e) {
          console.warn(`[Load] Fetch error for ${url}`, e);
          return null;
      }
  }
  
  public async getPendingUploads(): Promise<PendingUpload[]> {
    // Utilise le projet catalogue pour les pending uploads
    if (!catalogSupabase) return [];
    const { data, error } = await catalogSupabase.from('pending_uploads').select('*').eq('is_processed', false).order('created_at', { ascending: false });
    if (error) { console.error("Erreur récupération pending uploads:", error); return []; }
    return data as PendingUpload[];
  }

  public async addPendingUpload(filename: string, downloadUrl: string): Promise<void> {
    if (!catalogSupabase) throw new Error("Supabase non configuré");
    const { error } = await catalogSupabase.from('pending_uploads').insert({
        filename,
        download_url: downloadUrl,
        is_processed: false
    });
    if (error) { 
        console.error("Erreur ajout pending upload:", error); 
        throw error; 
    }
  }

  public async markUploadAsProcessed(ids: number[]) {
      // Utilise le projet catalogue
      if (!catalogSupabase || ids.length === 0) return;
      const { error } = await catalogSupabase.from('pending_uploads').update({ is_processed: true }).in('id', ids);
      if (error) { console.error("Erreur mise à jour pending uploads:", error); throw error; }
  }

  public async checkUserLicense(instrumentId: number): Promise<boolean> {
    if (!supabase || !this.currentUser) return false;
    try {
      const { data, error } = await supabase.from('user_licenses').select('id').eq('user_id', this.currentUser.id).eq('instrument_id', instrumentId).maybeSingle();
      if (error) { console.error("Erreur vérification licence:", error); return false; }
      return !!data; 
    } catch (e) { console.error("Exception vérification licence:", e); return false; }
  }

  public async signUp(email: string, password: string) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  public async signIn(email: string, password: string) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  public async signOut() {
    this.stopAutoSave(); 
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  public async resetPasswordForEmail(email: string) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if (error) throw error;
  }

  public getUser() { return this.currentUser; }

  public async uploadAudioFile(file: Blob, filename: string, projectName: string): Promise<string> {
    if (!supabase || !this.currentUser) throw new Error("Utilisateur non connecté");
    const safeProjectName = this.sanitizeFilename(projectName);
    const safeFilename = this.sanitizeFilename(filename.replace(/\.wav$/i, '')) + '.wav';
    const path = `${this.currentUser.id}/${safeProjectName}/${safeFilename}`;
    const BUCKET_NAME = 'audio-files'; 
    const { data, error } = await supabase.storage.from(BUCKET_NAME).upload(path, file, { cacheControl: '3600', upsert: true });
    if (error) { console.error("Erreur Upload Storage:", error); throw error; }
    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
    return publicUrlData.publicUrl;
  }

  public async uploadStoreFile(file: File, folder: 'covers' | 'previews' | 'stems'): Promise<string> {
    // Utilise le projet catalogue pour le bucket instruments
    if (!catalogSupabase) throw new Error("Catalogue Supabase non configuré");
    const safeName = this.sanitizeFilename(file.name.replace(/\.[^/.]+$/, ""));
    const extension = file.name.split('.').pop() || '';
    const filename = `${Date.now()}-${safeName}.${extension}`;
    const path = `${folder}/${filename}`;
    const BUCKET_NAME = 'instruments'; 
    const { data, error } = await catalogSupabase.storage.from(BUCKET_NAME).upload(path, file, { cacheControl: '3600', upsert: false });
    if (error) { console.error(`Erreur upload ${folder}:`, error); throw error; }
    const { data: publicUrlData } = catalogSupabase.storage.from(BUCKET_NAME).getPublicUrl(path);
    return publicUrlData.publicUrl;
  }

  // =============================================
  // CATALOGUE INSTRUMENTALS (Projet 2: mxdrxpzxbgybchzzvpkf)
  // Table: instrumentals (nouveau système avec Google Drive)
  // =============================================

  /**
   * Récupère tous les instrumentaux depuis la table "instrumentals"
   */
  public async getInstrumentals(): Promise<Instrumental[]> {
    console.log("[SupabaseManager] getInstrumentals() - catalogSupabase:", !!catalogSupabase);
    if (!catalogSupabase) {
      console.error("[SupabaseManager] catalogSupabase non initialisé!");
      return [];
    }
    
    try {
      const { data, error } = await catalogSupabase
        .from('instrumentals')
        .select('*')
        .order('created_at', { ascending: false });
      
      console.log("[SupabaseManager] getInstrumentals() - data:", data?.length, "error:", error);
      
      if (error) { 
        console.error("Erreur lecture instrumentals:", error); 
        return []; 
      }
      return (data || []) as Instrumental[];
    } catch (e) {
      console.error("[SupabaseManager] Exception getInstrumentals:", e);
      return [];
    }
  }

  /**
   * Récupère uniquement les instrumentaux actifs (is_active = true)
   */
  public async getActiveInstrumentals(): Promise<Instrumental[]> {
    console.log("[SupabaseManager] getActiveInstrumentals() - catalogSupabase:", !!catalogSupabase);
    if (!catalogSupabase) {
      console.error("[SupabaseManager] catalogSupabase non initialisé!");
      return [];
    }
    
    try {
      const { data, error } = await catalogSupabase
        .from('instrumentals')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      
      console.log("[SupabaseManager] getActiveInstrumentals() - data:", data?.length, "error:", error);
      
      if (error) { 
        console.error("Erreur lecture instrumentals actifs:", error); 
        return []; 
      }
      return (data || []) as Instrumental[];
    } catch (e) {
      console.error("[SupabaseManager] Exception getActiveInstrumentals:", e);
      return [];
    }
  }

  /**
   * Met à jour le statut is_active d'un instrumental
   */
  public async updateInstrumentalActive(id: string, isActive: boolean): Promise<void> {
    console.log("[SupabaseManager] updateInstrumentalActive:", id, isActive);
    if (!catalogSupabase) throw new Error("Catalogue non configuré");
    
    const { data, error } = await catalogSupabase
      .from('instrumentals')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select();
    
    console.log("[SupabaseManager] updateInstrumentalActive result:", { data, error });
    
    if (error) {
      console.error("[SupabaseManager] Erreur updateInstrumentalActive:", error);
      throw new Error(`Erreur mise à jour: ${error.message}. Vérifiez les politiques RLS sur la table instrumentals (UPDATE).`);
    }
  }

  /**
   * Met à jour un instrumental
   */
  public async updateInstrumental(id: string, updates: Partial<Instrumental>): Promise<void> {
    console.log("[SupabaseManager] updateInstrumental:", id, updates);
    if (!catalogSupabase) throw new Error("Catalogue non configuré");
    
    const { data, error } = await catalogSupabase
      .from('instrumentals')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select();
    
    console.log("[SupabaseManager] updateInstrumental result:", { data, error });
    
    if (error) {
      console.error("[SupabaseManager] Erreur updateInstrumental:", error);
      throw new Error(`Erreur mise à jour: ${error.message}. Vérifiez les politiques RLS sur la table instrumentals (UPDATE).`);
    }
  }

  /**
   * Construit l'URL de téléchargement Google Drive à partir du drive_file_id
   */
  public getDriveDownloadUrl(driveFileId: string): string {
    return `https://drive.google.com/uc?export=download&id=${driveFileId}`;
  }

  /**
   * Construit l'URL de preview Google Drive via l'Edge Function stream-instrumental
   */
  public getDrivePreviewUrl(driveFileId: string): string {
    // Utiliser l'Edge Function proxy pour streamer depuis Google Drive
    return `https://mxdrxpzxbgybchzzvpkf.supabase.co/functions/v1/stream-instrumental?fileId=${driveFileId}`;
  }

  // =============================================
  // ANCIENNE TABLE INSTRUMENTS (pour compatibilité)
  // =============================================

  public async addInstrument(instrument: Omit<Instrument, 'id' | 'created_at'>) {
    if (!catalogSupabase) throw new Error("Catalogue Supabase non configuré");
    const { data, error } = await catalogSupabase.from('instruments').insert([instrument]).select();
    if (error) { console.error("Erreur insertion beat:", error); throw error; }
    return data;
  }

  public async updateInstrument(id: number | string, updates: Partial<Instrument>) {
    if (!catalogSupabase) throw new Error("Catalogue Supabase non configuré");
    const { data, error } = await catalogSupabase.from('instruments').update(updates).eq('id', id).select();
    if (error) { console.error("Erreur mise à jour beat:", error); throw error; }
    return data;
  }

  public async getInstruments(): Promise<Instrument[]> {
    if (!catalogSupabase) return [];
    const { data, error } = await catalogSupabase.from('instruments').select('*').order('created_at', { ascending: false });
    if (error) { console.error("Erreur lecture catalogue:", error); throw error; }
    return data as Instrument[];
  }

  public async getInstrumentById(id: number | string): Promise<Instrument | null> {
    if (!catalogSupabase) return null;
    const { data, error } = await catalogSupabase.from('instruments').select('*').eq('id', id).single();
    if (error) { console.error("Erreur lecture instrument:", error); return null; }
    return data as Instrument;
  }

  public async updateInstrumentVisibility(id: number | string, isVisible: boolean) {
    if (!catalogSupabase) throw new Error("Catalogue Supabase non configuré");
    const { error } = await catalogSupabase.from('instruments').update({ is_visible: isVisible }).eq('id', id);
    if (error) throw error;
  }

  public async deleteInstrument(id: number | string) {
    if (!catalogSupabase) throw new Error("Catalogue Supabase non configuré");
    const { error } = await catalogSupabase.from('instruments').delete().eq('id', id);
    if (error) throw error;
  }

  // ===== DEFAULT TEMPLATE MANAGEMENT =====
  
  public async saveDefaultTemplate(template: any): Promise<void> {
    if (!supabase) throw new Error('Supabase not initialized');
    
    // Supprimer l'ancien template s'il existe
    await supabase
      .from('default_templates')
      .delete()
      .eq('id', 'default');
    
    // Insérer le nouveau template
    const { error } = await supabase
      .from('default_templates')
      .insert({
        id: 'default',
        template_data: template,
        updated_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('[SupabaseManager] Error saving template:', error);
      throw error;
    }
    
    console.log('[SupabaseManager] Default template saved successfully');
  }
  
  public async loadDefaultTemplate(): Promise<any | null> {
    if (!supabase) return null;
    
    try {
      const { data, error } = await supabase
        .from('default_templates')
        .select('template_data')
        .eq('id', 'default')
        .single();
      
      if (error || !data) {
        console.log('[SupabaseManager] No default template found');
        return null;
      }
      
      console.log('[SupabaseManager] Default template loaded');
      return data.template_data;
    } catch (e) {
      console.error('[SupabaseManager] Error loading template:', e);
      return null;
    }
  }
}

export const supabaseManager = SupabaseManager.getInstance();
