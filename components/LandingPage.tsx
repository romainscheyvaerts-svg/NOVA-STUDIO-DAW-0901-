import { openFeedback } from '../services/feedback';
import { dailyChallengeId } from '../utils/dailyChallenge';
import React, { useState, useEffect, useRef } from 'react';
import { User, Instrumental, DAWState } from '../types';
import { supabaseManager } from '../services/SupabaseManager';
import { audioEngine } from '../engine/AudioEngine';
import { ProjectIO } from '../services/ProjectIO';
import AuthScreen from './AuthScreen';
import InstallAppButton from './InstallAppButton';
import { SavedSessionMeta, formatAgo } from '../utils/sessionStore';
import { DESKTOP_APP_DOWNLOAD_URL, getNovaDesktop, isNovaDesktop } from '../utils/desktopApp';
import { tonaliteFr } from '../utils/keyName';
import { ThemeToggleButton } from './ThemeSwitch';
import CachedImage from './CachedImage';
import CatalogUnavailable from './CatalogUnavailable';
import { fetchAudioPreview } from '../utils/audioCache';
import { catalogStatus, isQuotaError } from '../utils/catalogStatus';

interface LandingPageProps {
  user: User | null;
  onEnterStudio: () => void;
  onEnterWithInstrumental: (instrumental: Instrumental) => void;
  /** Mélodie : projet « instru sur mélodie » (batterie, puis voix si on veut). */
  onEnterWithMelody?: (melody: Instrumental) => void;
  onEnterWithAudioFile: (file: File) => void;
  onEnterWithProject: (project: DAWState) => void;
  /** Session sauvegardée automatiquement sur l'appareil (null si aucune). */
  savedSession?: SavedSessionMeta | null;
  onResumeSession?: () => void;
  /** Historique des versions gardées sur l'appareil. */
  onOpenVersions?: () => void;
  onLogin: (user: User) => void;
  onLogout: () => void;
  /** « Nouveau projet depuis un modèle » (modèles de session). */
  onOpenTemplates?: () => void;
}

const LandingPage: React.FC<LandingPageProps> = ({ 
  user, 
  onEnterStudio, 
  onEnterWithInstrumental, 
  onEnterWithMelody,
  onEnterWithAudioFile, 
  onEnterWithProject,
  savedSession,
  onResumeSession,
  onOpenVersions,
  onLogin,
  onLogout,
  onOpenTemplates
}) => {
  const [instrumentals, setInstrumentals] = useState<Instrumental[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // Ecoute d'un beat : le chargement peut prendre plusieurs secondes sur une
  // grosse piste. Sans retour visuel, le clic donne l'impression de ne rien faire.
  const [loadingPreviewId, setLoadingPreviewId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [cloudProjects, setCloudProjects] = useState<any[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const isAdmin = user?.email?.toLowerCase() === 'romain.scheyvaerts@gmail.com';

  // Défi du jour : la même prod que sur le site (Beat Swipe), pour tout le monde.
  const challenge = React.useMemo(() => {
    const beats = instrumentals.filter(i => (i as any).kind === 'beat' && (i.preview_url || i.drive_file_id));
    const id = dailyChallengeId(beats.map(b => String(b.id)));
    return beats.find(b => String(b.id) === id) || null;
  }, [instrumentals]);

  // Charger le catalogue d'instrumentaux. En cas d'échec (quota Supabase dépassé,
  // hors ligne) : message clair et nouvel essai automatique avec un délai croissant
  // (jamais de boucle), sans recharger la page.
  const [catalogTry, setCatalogTry] = useState(0);
  useEffect(() => {
    let alive = true;
    const fetchInstrumentals = async () => {
      setLoading(prev => prev || instrumentals.length === 0);
      try {
        const data = await supabaseManager.getActiveInstrumentals();
        if (!alive) return;
        setInstrumentals(data);
        setCatalogError(null);
      } catch (error: any) {
        if (!alive) return;
        console.warn('Catalogue indisponible :', error?.message || error);
        setCatalogError(error?.message || 'Connexion au catalogue impossible');
      } finally {
        if (alive) setLoading(false);
      }
    };
    fetchInstrumentals();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogTry]);

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

  // Extrait en cours de chargement (le clic suivant l'annule) et son adresse blob:.
  const previewSeq = useRef(0);
  const previewBlobUrl = useRef<string | null>(null);

  // Stopper la lecture
  const stopPlayback = () => {
    previewSeq.current++;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (previewBlobUrl.current) { URL.revokeObjectURL(previewBlobUrl.current); previewBlobUrl.current = null; }
    audioEngine.stopPreview();
    setPlayingId(null);
    setLoadingPreviewId(null);
  };

  // Lecture preview d'un instrumental
  const togglePlay = (inst: Instrumental, e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Re-cliquer pendant le chargement annule (avant : ça relançait le
    // chargement et affichait « Lecture impossible » à tort).
    if (playingId === inst.id || loadingPreviewId === inst.id) {
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

    // Aucun fichier associe : on le dit, au lieu de laisser le bouton inerte.
    if (!url) {
      setPreviewError(`« ${inst.title} » n'a pas de fichier audio`);
      setTimeout(() => setPreviewError(null), 3500);
      return;
    }

    setPreviewError(null);
    setLoadingPreviewId(inst.id);
    const seq = ++previewSeq.current;

    // Écoute = le début du fichier seulement (plage HTTP, ~30 s), gardé en cache :
    // avant, chaque écoute téléchargeait le beat entier depuis le catalogue.
    fetchAudioPreview(url).then(({ data, mime }) => {
      if (seq !== previewSeq.current) return; // annulé (re-clic, autre beat)
      const blobUrl = URL.createObjectURL(new Blob([data], { type: mime }));
      previewBlobUrl.current = blobUrl;
      startPreviewAudio(inst, blobUrl);
    }).catch((err: any) => {
      if (seq !== previewSeq.current || err?.name === 'AbortError') return;
      setLoadingPreviewId(null);
      setPlayingId(null);
      setPreviewError(isQuotaError(err?.status, err?.message) || catalogStatus.get()?.kind === 'quota'
        ? 'Écoute momentanément indisponible : le catalogue est restreint. Tu peux travailler avec tes propres fichiers.'
        : `Lecture impossible : « ${inst.title} » est injoignable`);
      setTimeout(() => setPreviewError(null), 4500);
    });
  };

  const startPreviewAudio = (inst: Instrumental, url: string) => {
    const audio = new Audio(url);
    audio.volume = 0.8;
    audioRef.current = audio;

    // On n'affiche « en lecture » qu'au premier son reellement emis.
    audio.onplaying = () => { setLoadingPreviewId(null); setPlayingId(inst.id); };
    audio.onended = () => { setPlayingId(null); setLoadingPreviewId(null); };
    audio.onerror = () => {
      if (audioRef.current !== audio) return; // ancienne pré-écoute, déjà remplacée
      setLoadingPreviewId(null);
      setPlayingId(null);
      setPreviewError(`Lecture impossible : « ${inst.title} » est injoignable`);
      setTimeout(() => setPreviewError(null), 3500);
    };

    audio.play().catch((err: any) => {
      // Interrompue par un stop ou une autre pré-écoute : ce n'est pas une erreur.
      if (audioRef.current !== audio || err?.name === 'AbortError') return;
      setLoadingPreviewId(null);
      setPlayingId(null);
      setPreviewError(`Lecture impossible : « ${inst.title} »`);
      setTimeout(() => setPreviewError(null), 3500);
    });
  };

  // Sélectionner un instrumental et ouvrir le DAW
  // Deux bibliothèques : instrus complètes (poser sa voix) et mélodies (faire l'instru).
  const [shelf, setShelf] = useState<'BEATS' | 'MELODIES'>('BEATS');
  const isMelody = (i: Instrumental) => i.kind === 'melody';
  const shown = instrumentals.filter(i => (shelf === 'MELODIES') === isMelody(i));
  const handleSelectInstrumental = (inst: Instrumental) => {
    stopPlayback();
    if (isMelody(inst) && onEnterWithMelody) onEnterWithMelody(inst);
    else onEnterWithInstrumental(inst);
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
        setPreviewError(`Ce projet n'a pas pu être ouvert : ${error?.message || 'fichier illisible'}`); setTimeout(() => setPreviewError(null), 6000);
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
      setPreviewError(`Ce projet n'a pas pu être chargé : ${error?.message || 'erreur réseau'}`); setTimeout(() => setPreviewError(null), 6000);
    }
  };

  // Image de couverture
  const getCoverImage = (inst: Instrumental): string => {
    return inst.cover_image_url || 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20150%20150%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%230e7490%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%234c1d95%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22150%22%20height%3D%22150%22%20fill%3D%22url(%23g)%22%2F%3E%3Ctext%20x%3D%2275%22%20y%3D%2288%22%20font-size%3D%2240%22%20text-anchor%3D%22middle%22%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.7%22%3E%E2%99%AA%3C%2Ftext%3E%3C%2Fsvg%3E';
  };

  return (
    <div className="nova-grille fixed inset-0 bg-nv-bg flex flex-col overflow-hidden">
      {/* Echec d'ecoute : le bouton revenait a son etat initial sans rien dire */}
      {previewError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[2000] px-4 py-2.5 rounded-xl
                        bg-red-500/15 border border-red-500/40 text-red-200 text-xs font-semibold
                        shadow-2xl backdrop-blur-sm flex items-center gap-2">
          <i className="fas fa-circle-exclamation"></i>
          {previewError}
        </div>
      )}

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
      <header className="nova-brandbar shrink-0 flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/5 bg-nv-bg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center">
            <i className="fas fa-wave-square text-white text-sm"></i>
          </div>
          <div>
            <h1 className="text-lg font-black text-white tracking-tight">
              NOVA <span className="text-cyan-400">STUDIO</span>
            </h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Studio d'enregistrement</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
        <ThemeToggleButton />
        <InstallAppButton />
        {/* Bouton connexion / menu utilisateur */}
        {user && user.id !== 'guest' ? (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs font-bold text-white">{user.username || user.email}</p>
              <p className="text-[10px] text-slate-500">{!user.plan || /^free$/i.test(user.plan) ? 'Gratuit' : user.plan}</p>
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
            className="px-4 py-2.5 bg-cyan-500 rounded-lg text-sm font-bold text-black hover:opacity-90 transition-all shadow-lg shadow-cyan-500/20"
          >
            {/* Texte noir sur l'accent : le blanc sur le dégradé cyan → bleu ne faisait que 3:1. */}
            <i className="fas fa-user mr-2"></i>
            Connexion
          </button>
        )}
        </div>
      </header>

      {/* Contenu principal */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Sidebar gauche - Actions principales */}
        <aside className="w-full md:w-72 shrink-0 border-b md:border-b-0 md:border-r border-white/5 bg-nv-bg flex flex-col">
          <div className="p-4 space-y-3">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Démarrer</h2>

            {/* Reprise de la dernière session (sauvegarde automatique sur l'appareil) */}
            {savedSession && onResumeSession && (
              <button
                onClick={onResumeSession}
                className="w-full flex items-center gap-4 p-4 bg-gradient-to-r from-emerald-500/15 to-cyan-500/10 border border-emerald-400/40 rounded-xl hover:border-emerald-400/70 transition-all group"
              >
                <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                  <i className="fas fa-rotate-left text-emerald-300 text-lg"></i>
                </div>
                <div className="text-left min-w-0">
                  <p className="text-sm font-bold text-white">Reprendre ma session</p>
                  <p className="text-[11px] text-slate-300 truncate">
                    {[savedSession.beatTitle, savedSession.takes ? `${savedSession.takes} prise${savedSession.takes > 1 ? "s" : ""}` : null, savedSession.hasLyrics ? "paroles" : null].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-[10px] text-slate-500">{formatAgo(savedSession.savedAt)}</p>
                </div>
              </button>
            )}
            {savedSession && onOpenVersions && (
              <button type="button" onClick={onOpenVersions} className="w-full min-h-11 -mt-1 text-[12px] text-slate-400 hover:text-white underline">
                🕘 Autres versions de la session
              </button>
            )}
            
            {/* Défi du jour */}
            {challenge && (
              <button
                onClick={() => onEnterWithInstrumental(challenge)}
                className="w-full flex items-center gap-4 p-4 bg-gradient-to-r from-amber-400/15 to-pink-500/15 border border-pink-400/40 rounded-xl hover:border-pink-400/70 transition-all group"
              >
                <div className="w-12 h-12 rounded-xl overflow-hidden bg-pink-500/20 flex items-center justify-center shrink-0">
                  {challenge.cover_image_url ? <CachedImage src={challenge.cover_image_url} fallback={getCoverImage({ ...challenge, cover_image_url: null })} alt="" className="w-full h-full object-cover" /> : <span className="text-xl">🎯</span>}
                </div>
                <div className="text-left min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-300">🎯 Défi du jour</p>
                  <p className="text-sm font-bold text-white truncate">{String(challenge.title || '').split('|')[0].trim()}</p>
                  <p className="text-[11px] text-slate-300">Pose 4 mesures dessus, partage, fais voter.</p>
                </div>
              </button>
            )}

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
                <p className="text-[11px] text-slate-400">Projet vierge</p>
              </div>
            </button>

            {/* Nouveau projet depuis un modèle de session */}
            {onOpenTemplates && (
              <button
                onClick={onOpenTemplates}
                data-testid="landing-templates"
                className="w-full flex items-center gap-4 p-4 bg-white/[0.02] border border-white/10 rounded-xl hover:border-cyan-500/30 hover:bg-white/[0.05] transition-all group"
              >
                <div className="w-12 h-12 rounded-xl bg-teal-500/20 flex items-center justify-center group-hover:bg-teal-500/30 transition-all">
                  <i className="fas fa-layer-group text-teal-300 text-lg" aria-hidden="true"></i>
                </div>
                <div className="text-left">
                  <p className="text-sm font-bold text-white">Depuis un modèle</p>
                  <p className="text-[11px] text-slate-400">Session voix Make Music : lead, double, backs, retours et master déjà réglés</p>
                </div>
              </button>
            )}

            {/* Bouton Ouvrir fichier audio */}
            <button
              onClick={handleOpenAudioFile}
              className="w-full flex items-center gap-4 p-4 bg-white/[0.02] border border-white/10 rounded-xl hover:border-cyan-500/30 hover:bg-white/[0.05] transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center group-hover:bg-purple-500/30 transition-all">
                <i className="fas fa-file-audio text-purple-400 text-lg"></i>
              </div>
              <div className="text-left">
                <p className="text-sm font-bold text-white">Ouvrir Audio <span className="ml-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-[9px] font-black text-violet-200 align-middle">⭐ Nova Pro</span></p>
                <p className="text-[11px] text-slate-400">Ta propre instru (MP3, WAV…) · 5 €/mois</p>
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
                <p className="text-[11px] text-slate-400">Depuis ton ordinateur ou ton compte</p>
              </div>
            </button>

            {/* Application Windows (masquée sur téléphone et dans l'application elle-même) */}
            {!isNovaDesktop() && (
              <a
                href={DESKTOP_APP_DOWNLOAD_URL}
                download
                title="Installe Nova Studio sur ton PC : il s'ouvre sans Internet, les ponts ASIO et VST démarrent tout seuls, ta session est sauvegardée à la fermeture. Un compte Make Music gratuit est demandé au premier démarrage ; l'export est inclus avec Nova Pro (sinon 2 € par projet)."
                className="hidden md:flex w-full items-center gap-4 p-4 bg-white/[0.02] border border-white/10 rounded-xl hover:border-sky-400/40 hover:bg-white/[0.05] transition-all group"
              >
                <div className="w-12 h-12 rounded-xl bg-sky-500/15 flex items-center justify-center group-hover:bg-sky-500/25 transition-all">
                  <i className="fab fa-windows text-sky-300 text-lg" aria-hidden="true"></i>
                </div>
                <div className="text-left min-w-0">
                  <p className="text-sm font-bold text-white">Nova Studio pour Windows</p>
                  <p className="text-[11px] text-slate-400">Télécharger l'appli PC · ASIO + VST</p>
                  <p className="text-[10px] text-slate-500">Windows 10/11 · environ 36 Mo</p>
                  <p className="text-[10px] text-slate-400">Compte gratuit requis pour démarrer · export inclus avec Nova Pro</p>
                </div>
                <i className="fas fa-download ml-auto text-slate-500 group-hover:text-sky-300 transition-colors" aria-hidden="true"></i>
              </a>
            )}
          </div>

          {/* Footer sidebar */}
          <div className="nova-signature mt-auto p-4 border-t border-white/5">
            <button type="button" onClick={() => openFeedback()} data-nova-action="feedback-accueil" title="Signaler un bug ou proposer une idée (Ctrl+Maj+B)"
              className="w-full mb-2 min-h-10 rounded-lg text-[12px] font-bold text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
              <i className="fas fa-comment-dots mr-1.5" aria-hidden="true"></i>Signaler un bug / une idée
            </button>
            <p className="text-[9px] text-slate-600 text-center">
              © 2026 Nova Studio{getNovaDesktop() ? ` • Windows v${getNovaDesktop()!.version}` : ''}
            </p>
          </div>
        </aside>

        {/* Zone centrale - Catalogue d'instrumentaux */}
        <section className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-white/5 bg-nv-bg/50">
            <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-white/[0.06] bg-white/[0.03] p-1" role="tablist" aria-label="Bibliothèque">
              <button type="button" role="tab" aria-selected={shelf === 'BEATS'} onClick={() => setShelf('BEATS')}
                className={`nova-hit-tactile h-9 px-4 rounded-lg text-[12px] font-bold transition-all ${shelf === 'BEATS' ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(34,211,238,0.45)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>
                🎧 Instrus <span className={`ml-1 rounded-md px-1.5 py-0.5 text-[10px] mono ${shelf === 'BEATS' ? 'bg-cyan-400/15 text-cyan-300' : 'bg-white/5 text-slate-500'}`}>{instrumentals.filter(i => !isMelody(i)).length}</span>
              </button>
              <button type="button" role="tab" aria-selected={shelf === 'MELODIES'} onClick={() => setShelf('MELODIES')}
                className={`nova-hit-tactile h-9 px-4 rounded-lg text-[12px] font-bold transition-all ${shelf === 'MELODIES' ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(167,139,250,0.5)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>
                🎹 Mélodies <span className={`ml-1 rounded-md px-1.5 py-0.5 text-[10px] mono ${shelf === 'MELODIES' ? 'bg-violet-400/15 text-violet-300' : 'bg-white/5 text-slate-500'}`}>{instrumentals.filter(isMelody).length}</span>
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              {shelf === 'MELODIES'
                ? 'Choisis une mélodie : je t\'ouvre un projet pour faire ton instru dessus (batterie calée sur son tempo), puis tu peux y poser ta voix.'
                : 'Choisis une instru pour poser ta voix dessus.'}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {!loading && instrumentals.length > 0 && (
              <CatalogUnavailable compact onRetry={() => setCatalogTry(n => n + 1)} />
            )}
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
              </div>
            ) : catalogError && instrumentals.length === 0 ? (
              <CatalogUnavailable
                onRetry={() => setCatalogTry(n => n + 1)}
                actions={[
                  { label: 'Nouveau projet vierge', icon: 'fa-plus', onClick: onEnterStudio },
                  { label: 'Ouvrir un projet de cet appareil', icon: 'fa-folder-open', onClick: () => setShowLoadModal(true) },
                  { label: 'Importer ton instru (MP3, WAV…)', icon: 'fa-file-audio', onClick: handleOpenAudioFile },
                ]}
              />
            ) : shown.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500">
                <i className="fas fa-music text-4xl mb-4 text-slate-700"></i>
                <p className="text-sm">Aucun instrumental disponible</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {shown.map((inst) => (
                  <div
                    key={inst.id}
                    role="button"
                    tabIndex={0}
                    aria-label={isMelody(inst) ? `Faire une instru sur la mélodie « ${inst.title} »` : `Poser ma voix sur « ${inst.title} »`}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSelectInstrumental(inst); } }}
                    onClick={() => handleSelectInstrumental(inst)}
                    className={`group relative bg-nv-surface border rounded-xl overflow-hidden cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.8)] ${
                      playingId === inst.id ? 'border-cyan-500/70 ring-1 ring-cyan-400/40' : 'border-white/[0.06] hover:border-white/15'
                    }`}
                  >
                    {/* Cover */}
                    <div className="relative aspect-square">
                      <CachedImage
                        src={inst.cover_image_url}
                        fallback={getCoverImage({ ...inst, cover_image_url: null })}
                        alt={inst.title}
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                      {/* Overlay au hover */}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        {isMelody(inst) ? (
                          <span className="px-3 py-2 rounded-full bg-violet-600 text-white text-[11px] font-black shadow-lg">🥁 Faire une instru</span>
                        ) : (
                          <div className="w-14 h-14 rounded-full bg-cyan-500 flex items-center justify-center shadow-lg">
                            <i className="fas fa-arrow-right text-white text-lg"></i>
                          </div>
                        )}
                      </div>
                      {/* Bouton Play */}
                      <button
                        type="button"
                        aria-label={playingId === inst.id ? `Mettre en pause « ${inst.title} »` : `Écouter « ${inst.title} »`}
                        onKeyDown={(e) => e.stopPropagation()}
                        onClick={(e) => togglePlay(inst, e)}
                        className={`absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                          playingId === inst.id || loadingPreviewId === inst.id
                            ? 'bg-cyan-500 text-black'
                            : 'bg-black/55 text-white border border-white/15 backdrop-blur-md hover:bg-cyan-400 hover:border-cyan-300 hover:text-black'
                        }`}
                      >
                        <i className={`fas ${
                          loadingPreviewId === inst.id ? 'fa-spinner fa-spin'
                          : playingId === inst.id ? 'fa-pause' : 'fa-play'
                        } text-sm`}></i>
                      </button>
                    </div>

                    {/* Info */}
                    <div className="p-3 flex flex-col gap-2">
                      <h3 className="text-[13px] font-bold text-white truncate leading-tight">{inst.title}</h3>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] leading-none">
                        <span className="mono rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-1 text-slate-300 whitespace-nowrap">{inst.bpm ? `${inst.bpm} BPM` : 'Tempo auto'}</span>
                        {inst.key && (
                          <span className="mono rounded-md border border-cyan-400/25 bg-cyan-400/[0.06] px-1.5 py-1 text-cyan-300 whitespace-nowrap">
                            {tonaliteFr(inst.key)}
                          </span>
                        )}
                        <span className="truncate text-slate-400">{inst.genre || (isMelody(inst) ? 'Mélodie' : 'Beat')}</span>
                      </div>
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
            <button aria-label="Fermer" title="Fermer"
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
              onClose={() => setShowAuthModal(false)}
            />
          </div>
        </div>
      )}

      {/* Modal Charger Projet */}
      {showLoadModal && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4" onClick={() => setShowLoadModal(false)}>
          <div className="bg-nv-surface border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase tracking-widest">Charger un Projet</h3>
              <button aria-label="Fermer" title="Fermer" onClick={() => setShowLoadModal(false)} className="text-slate-500 hover:text-white">
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
