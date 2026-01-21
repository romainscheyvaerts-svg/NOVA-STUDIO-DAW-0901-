import React, { useState, useEffect, useRef } from 'react';
import { User, Instrumental, DAWState } from '../types';
import { supabaseManager } from '../services/SupabaseManager';
import { audioEngine } from '../engine/AudioEngine';
import { ProjectIO } from '../services/ProjectIO';
import AuthScreen from './AuthScreen';

interface LandingPageProps {
  user: User | null;
  onEnterStudio: () => void;
  onEnterWithInstrumental: (instrumental: Instrumental) => void;
  onEnterWithAudioFile: (file: File) => void;
  onEnterWithProject: (project: DAWState) => void;
  onLogin: (user: User) => void;
  onLogout: () => void;
}

const LandingPage: React.FC<LandingPageProps> = ({ 
  user, 
  onEnterStudio, 
  onEnterWithInstrumental, 
  onEnterWithAudioFile, 
  onEnterWithProject,
  onLogin,
  onLogout 
}) => {
  const [instrumentals, setInstrumentals] = useState<Instrumental[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [cloudProjects, setCloudProjects] = useState<any[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const isAdmin = user?.email?.toLowerCase() === 'romain.scheyvaerts@gmail.com';

  // Charger le catalogue d'instrumentaux
  useEffect(() => {
    const fetchInstrumentals = async () => {
      setLoading(true);
      try {
        const data = await supabaseManager.getActiveInstrumentals();
        setInstrumentals(data);
      } catch (error) {
        console.error('Failed to load instrumentals:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchInstrumentals();
  }, []);

  // Charger les projets cloud si connecté
  useEffect(() => {
    if (user && user.id !== 'guest') {
      loadCloudProjects();
    }
  }, [user]);

  const loadCloudProjects = async () => {
    setLoadingProjects(true);
    try {
      const projects = await supabaseManager.listUserSessions();
      setCloudProjects(projects || []);
    } catch (error) {
      console.error('Failed to load cloud projects:', error);
    } finally {
      setLoadingProjects(false);
    }
  };

  // Stopper la lecture
  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    audioEngine.stopPreview();
    setPlayingId(null);
  };

  // Lecture preview d'un instrumental
  const togglePlay = (inst: Instrumental, e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (playingId === inst.id) {
      stopPlayback();
      return;
    }

    stopPlayback();

    let url = '';
    if (inst.preview_url) {
      url = supabaseManager.getPublicInstrumentUrl(inst.preview_url);
    } else if (inst.drive_file_id) {
      url = supabaseManager.getDrivePreviewUrl(inst.drive_file_id);
    }

    if (!url) return;

    setPlayingId(inst.id);
    const audio = new Audio(url);
    audio.volume = 0.8;
    audioRef.current = audio;
    audio.onended = () => setPlayingId(null);
    audio.play().catch(() => setPlayingId(null));
  };

  // Sélectionner un instrumental et ouvrir le DAW
  const handleSelectInstrumental = (inst: Instrumental) => {
    stopPlayback();
    onEnterWithInstrumental(inst);
  };

  // Ouvrir un fichier audio local
  const handleOpenAudioFile = () => {
    fileInputRef.current?.click();
  };

  const handleAudioFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onEnterWithAudioFile(file);
    }
  };

  // Ouvrir une sauvegarde locale
  const handleOpenLocalProject = () => {
    projectInputRef.current?.click();
  };

  const handleProjectFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const project = await ProjectIO.loadProject(file);
        if (project) {
          onEnterWithProject(project);
        }
      } catch (error: any) {
        alert(`Erreur de chargement: ${error.message}`);
      }
    }
  };

  // Charger un projet cloud
  const handleLoadCloudProject = async (projectId: string) => {
    try {
      const project = await supabaseManager.loadUserSession(projectId);
      if (project) {
        onEnterWithProject(project);
      }
    } catch (error: any) {
      alert(`Erreur: ${error.message}`);
    }
  };

  // Image de couverture
  const getCoverImage = (inst: Instrumental): string => {
    return inst.cover_image_url || 'https://via.placeholder.com/150?text=Beat';
  };

  return (
    <div className="fixed inset-0 bg-[#0a0b0d] flex flex-col overflow-hidden">
      {/* Inputs cachés */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleAudioFileChange}
      />
      <input
        ref={projectInputRef}
        type="file"
        accept=".novaproj.zip,.zip,.json"
        className="hidden"
        onChange={handleProjectFileChange}
      />

      {/* Header avec bouton connexion */}
      <header className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#0c0d10]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center">
            <i className="fas fa-waveform-lines text-white text-sm"></i>
          </div>
          <div>
            <h1 className="text-lg font-black text-white tracking-tight">
              NOVA <span className="text-cyan-400">STUDIO</span>
            </h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Digital Audio Workstation</p>
          </div>
        </div>

        {/* Bouton connexion / menu utilisateur */}
        {user && user.id !== 'guest' ? (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs font-bold text-white">{user.username || user.email}</p>
              <p className="text-[10px] text-slate-500">{user.plan || 'FREE'}</p>
            </div>
            <button
              onClick={onLogout}
              className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-white/10 transition-all"
            >
              <i className="fas fa-sign-out-alt mr-2"></i>
              Déconnexion
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowAuthModal(true)}
            className="px-4 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-500 rounded-lg text-sm font-bold text-white hover:opacity-90 transition-all shadow-lg shadow-cyan-500/20"
          >
            <i className="fas fa-user mr-2"></i>
            Connexion
          </button>
        )}
      </header>

      {/* Contenu principal */}
      <main className="flex-1 flex overflow-hidden">
        {/* Sidebar gauche - Actions principales */}
        <aside className="w-72 shrink-0 border-r border-white/5 bg-[#0c0d10] flex flex-col">
          <div className="p-4 space-y-3">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Démarrer</h2>
            
            {/* Bouton Nouveau projet */}
            <button
              onClick={onEnterStudio}
              className="w-full flex items-center gap-4 p-4 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/30 rounded-xl hover:border-cyan-500/50 hover:bg-cyan-500/20 transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-cyan-500/20 flex items-center justify-center group-hover:bg-cyan-500/30 transition-all">
                <i className="fas fa-plus text-cyan-400 text-lg"></i>
              </div>
              <div className="text-left">
                <p className="text-sm font-bold text-white">Nouveau Projet</p>
                <p className="text-[10px] text-slate-500">Projet vierge</p>
              </div>
            </button>

            {/* Bouton Ouvrir fichier audio */}
            <button
              onClick={handleOpenAudioFile}
              className="w-full flex items-center gap-4 p-4 bg-white/[0.02] border border-white/10 rounded-xl hover:border-cyan-500/30 hover:bg-white/[0.05] transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center group-hover:bg-purple-500/30 transition-all">
                <i className="fas fa-file-audio text-purple-400 text-lg"></i>
              </div>
              <div className="text-left">
                <p className="text-sm font-bold text-white">Ouvrir Audio</p>
                <p className="text-[10px] text-slate-500">Fichier MP3, WAV...</p>
              </div>
            </button>

            {/* Bouton Charger Sauvegarde */}
            <button
              onClick={() => setShowLoadModal(true)}
              className="w-full flex items-center gap-4 p-4 bg-white/[0.02] border border-white/10 rounded-xl hover:border-cyan-500/30 hover:bg-white/[0.05] transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-amber-500/20 flex items-center justify-center group-hover:bg-amber-500/30 transition-all">
                <i className="fas fa-folder-open text-amber-400 text-lg"></i>
              </div>
              <div className="text-left">
                <p className="text-sm font-bold text-white">Charger Projet</p>
                <p className="text-[10px] text-slate-500">Local ou Cloud</p>
              </div>
            </button>
          </div>

          {/* Footer sidebar */}
          <div className="mt-auto p-4 border-t border-white/5">
            <p className="text-[9px] text-slate-600 text-center">
              © 2026 Nova Studio • v1.0.0
            </p>
          </div>
        </aside>

        {/* Zone centrale - Catalogue d'instrumentaux */}
        <section className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-white/5 bg-[#0c0d10]/50">
            <h2 className="text-sm font-black text-white uppercase tracking-widest">
              <i className="fas fa-music text-cyan-400 mr-2"></i>
              Catalogue Instrumentaux
            </h2>
            <p className="text-[10px] text-slate-500 mt-1">
              Cliquez sur un beat pour l'importer et ouvrir le studio
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
              </div>
            ) : instrumentals.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500">
                <i className="fas fa-music text-4xl mb-4 text-slate-700"></i>
                <p className="text-sm">Aucun instrumental disponible</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {instrumentals.map((inst) => (
                  <div
                    key={inst.id}
                    onClick={() => handleSelectInstrumental(inst)}
                    className={`group relative bg-[#14161a] border rounded-xl overflow-hidden cursor-pointer transition-all hover:scale-[1.02] hover:shadow-xl hover:shadow-cyan-500/10 ${
                      playingId === inst.id ? 'border-cyan-500 ring-2 ring-cyan-500/30' : 'border-white/5 hover:border-cyan-500/30'
                    }`}
                  >
                    {/* Cover */}
                    <div className="relative aspect-square">
                      <img
                        src={getCoverImage(inst)}
                        alt={inst.title}
                        className="w-full h-full object-cover"
                      />
                      {/* Overlay au hover */}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <div className="w-14 h-14 rounded-full bg-cyan-500 flex items-center justify-center shadow-lg">
                          <i className="fas fa-arrow-right text-white text-lg"></i>
                        </div>
                      </div>
                      {/* Bouton Play */}
                      <button
                        onClick={(e) => togglePlay(inst, e)}
                        className={`absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                          playingId === inst.id
                            ? 'bg-cyan-500 text-black'
                            : 'bg-black/70 text-white hover:bg-cyan-500 hover:text-black'
                        }`}
                      >
                        <i className={`fas ${playingId === inst.id ? 'fa-pause' : 'fa-play'} text-sm`}></i>
                      </button>
                    </div>

                    {/* Info */}
                    <div className="p-3">
                      <h3 className="text-xs font-bold text-white truncate">{inst.title}</h3>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                        <span>{inst.bpm || '?'} BPM</span>
                        <span>•</span>
                        <span className="truncate">{inst.genre || 'Beat'}</span>
                      </div>
                      {inst.key && (
                        <span className="inline-block mt-2 px-2 py-0.5 bg-cyan-500/10 text-cyan-400 text-[9px] rounded-full">
                          {inst.key}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Modal Connexion */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative">
            <button
              onClick={() => setShowAuthModal(false)}
              className="absolute -top-2 -right-2 w-8 h-8 bg-white/10 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-red-500 transition-all z-10"
            >
              <i className="fas fa-times"></i>
            </button>
            <AuthScreen
              onAuthenticated={(u) => {
                onLogin(u);
                setShowAuthModal(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Modal Charger Projet */}
      {showLoadModal && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4" onClick={() => setShowLoadModal(false)}>
          <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase tracking-widest">Charger un Projet</h3>
              <button onClick={() => setShowLoadModal(false)} className="text-slate-500 hover:text-white">
                <i className="fas fa-times"></i>
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Charger depuis fichier local */}
              <button
                onClick={() => { setShowLoadModal(false); handleOpenLocalProject(); }}
                className="w-full flex items-center gap-4 p-4 bg-white/[0.02] border border-white/10 rounded-xl hover:border-cyan-500/30 hover:bg-white/[0.05] transition-all"
              >
                <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
                  <i className="fas fa-hdd text-purple-400 text-lg"></i>
                </div>
                <div className="text-left">
                  <p className="text-sm font-bold text-white">Charger depuis l'ordinateur</p>
                  <p className="text-[10px] text-slate-500">Fichier .novaproj.zip</p>
                </div>
                <i className="fas fa-chevron-right text-slate-600 ml-auto"></i>
              </button>

              {/* Projets Cloud */}
              <div className="border-t border-white/5 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold text-slate-400 uppercase">Projets Cloud</h4>
                  {user && user.id !== 'guest' && (
                    <button onClick={loadCloudProjects} className="text-[10px] text-cyan-400 hover:text-cyan-300">
                      <i className="fas fa-sync-alt mr-1"></i>Actualiser
                    </button>
                  )}
                </div>

                {!user || user.id === 'guest' ? (
                  <div className="text-center py-6">
                    <i className="fas fa-cloud text-3xl text-slate-700 mb-3"></i>
                    <p className="text-xs text-slate-500">Connectez-vous pour accéder à vos projets cloud</p>
                    <button
                      onClick={() => { setShowLoadModal(false); setShowAuthModal(true); }}
                      className="mt-3 px-4 py-2 bg-cyan-500 text-black text-xs font-bold rounded-lg hover:bg-cyan-400 transition-all"
                    >
                      Se connecter
                    </button>
                  </div>
                ) : loadingProjects ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="w-6 h-6 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
                  </div>
                ) : cloudProjects.length === 0 ? (
                  <div className="text-center py-6">
                    <i className="fas fa-folder-open text-3xl text-slate-700 mb-3"></i>
                    <p className="text-xs text-slate-500">Aucun projet sauvegardé</p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {cloudProjects.map((project) => (
                      <button
                        key={project.id}
                        onClick={() => { setShowLoadModal(false); handleLoadCloudProject(project.id); }}
                        className="w-full flex items-center gap-3 p-3 bg-white/[0.02] border border-white/5 rounded-lg hover:border-cyan-500/30 hover:bg-white/[0.05] transition-all"
                      >
                        <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                          <i className="fas fa-cloud text-cyan-400"></i>
                        </div>
                        <div className="text-left flex-1 min-w-0">
                          <p className="text-xs font-bold text-white truncate">{project.name || 'Sans nom'}</p>
                          <p className="text-[10px] text-slate-500">
                            {new Date(project.updated_at || project.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <i className="fas fa-chevron-right text-slate-600"></i>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LandingPage;
