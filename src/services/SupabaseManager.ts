
import { supabase } from './supabase';
import { User, DAWState, PendingUpload, Instrument } from '../types';
import { audioBufferToWav } from './AudioUtils';
import { audioEngine } from '../engine/AudioEngine';
import { SessionSerializer } from './SessionSerializer';

export class SupabaseManager {
  private static instance: SupabaseManager;
  private currentUser: any = null;
  
  // Auto-Save State
  private autoSaveIntervalId: number | null = null;
  private uploadedBlobsCache: Map<string, string> = new Map();

  private constructor() {
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

  /**
   * ACCÈS DIRECT STORAGE SUPABASE
   * Récupère l'URL publique d'un fichier dans le bucket 'instruments'.
   * Gère les chemins relatifs (stockés en DB) ou les URLs complètes.
   */
  public getPublicInstrumentUrl(pathOrUrl: string): string {
    if (!pathOrUrl) return '';
    
    // Si c'est déjà une URL complète (Blob local ou HTTPS externe comme Drive/Edge Function), on la retourne telle quelle
    if (pathOrUrl.startsWith('http') || pathOrUrl.startsWith('blob:')) {
        return pathOrUrl;
    }

    // Sinon, on génère l'URL publique depuis le bucket 'instruments'
    if (supabase) {
        const { data } = supabase.storage.from('instruments').getPublicUrl(pathOrUrl);
        
        // DEBUG: Vérifiez cette ligne dans la console si l'erreur persiste
        // console.log("Generated Supabase URL:", data.publicUrl);
        
        return data.publicUrl;
    }

    return pathOrUrl;
  }

  /**
   * Nettoie une chaîne pour en faire un nom de fichier sûr.
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

  // ... (Reste des méthodes inchangées : listUserSessions, loadUserSession, hydrateAudioBuffers, etc.)

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
    if (!supabase) return [];
    const { data, error } = await supabase.from('pending_uploads').select('*').eq('is_processed', false).order('created_at', { ascending: false });
    if (error) { console.error("Erreur récupération pending uploads:", error); return []; }
    return data as PendingUpload[];
  }

  public async markUploadAsProcessed(ids: number[]) {
      if (!supabase || ids.length === 0) return;
      const { error } = await supabase.from('pending_uploads').update({ is_processed: true }).in('id', ids);
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
    if (!supabase) throw new Error("Supabase non configuré");
    const safeName = this.sanitizeFilename(file.name.replace(/\.[^/.]+$/, ""));
    const extension = file.name.split('.').pop() || '';
    const filename = `${Date.now()}-${safeName}.${extension}`;
    const path = `${folder}/${filename}`;
    const BUCKET_NAME = 'instruments'; 
    const { data, error } = await supabase.storage.from(BUCKET_NAME).upload(path, file, { cacheControl: '3600', upsert: false });
    if (error) { console.error(`Erreur upload ${folder}:`, error); throw error; }
    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
    return publicUrlData.publicUrl;
  }

  public async addInstrument(instrument: Omit<Instrument, 'id' | 'created_at'>) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { data, error } = await supabase.from('instruments').insert([instrument]).select();
    if (error) { console.error("Erreur insertion beat:", error); throw error; }
    return data;
  }

  public async updateInstrument(id: number, updates: Partial<Instrument>) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { data, error } = await supabase.from('instruments').update(updates).eq('id', id).select();
    if (error) { console.error("Erreur mise à jour beat:", error); throw error; }
    return data;
  }

  public async getInstruments(): Promise<Instrument[]> {
    if (!supabase) return [];
    const { data, error } = await supabase.from('instruments').select('*').order('created_at', { ascending: false });
    if (error) { console.error("Erreur lecture catalogue:", error); throw error; }
    return data as Instrument[];
  }

  public async getInstrumentById(id: number): Promise<Instrument | null> {
    if (!supabase) return null;
    const { data, error } = await supabase.from('instruments').select('*').eq('id', id).single();
    if (error) { console.error("Erreur lecture instrument:", error); return null; }
    return data as Instrument;
  }

  public async updateInstrumentVisibility(id: number, isVisible: boolean) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { error } = await supabase.from('instruments').update({ is_visible: isVisible }).eq('id', id);
    if (error) throw error;
  }

  public async deleteInstrument(id: number) {
    if (!supabase) throw new Error("Supabase non configuré");
    const { error } = await supabase.from('instruments').delete().eq('id', id);
    if (error) throw error;
  }
}

export const supabaseManager = SupabaseManager.getInstance();
