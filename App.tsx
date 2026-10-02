import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Track, TrackType, DAWState, ProjectPhase, PluginInstance, PluginType, MobileTab, TrackSend, Clip, AIAction, AutomationLane, AIChatMessage, ViewMode, User, Theme, DrumPad, Marker, TrackGroup } from './types';
import { audioEngine } from './engine/AudioEngine';
import TransportBar from './components/TransportBar';
import MobileTransport from './components/MobileTransport';
import AdminTemplateButton from './components/AdminTemplateButton';
import ArrangementView from './components/ArrangementView';
const MixerView = lazy(() => import('./components/MixerView'));
// Charge a la demande : PluginEditor tire les 13 interfaces de plugins,
// soit plus de 8000 lignes qui ne servent qu'a l'ouverture d'un effet.
const PluginEditor = lazy(() => import('./components/PluginEditor'));
import ChatAssistant from './components/ChatAssistant';
import ViewModeSwitcher from './components/ViewModeSwitcher';
import ContextMenu from './components/ContextMenu';
import TouchInteractionManager from './components/TouchInteractionManager';
import TrackCreationBar from './components/TrackCreationBar';
const AuthScreen = lazy(() => import('./components/AuthScreen'));
const AutomationEditorView = lazy(() => import('./components/AutomationEditorView'));
const ShareModal = lazy(() => import('./components/ShareModal'));
const SaveProjectModal = lazy(() => import('./components/SaveProjectModal'));
const LoadProjectModal = lazy(() => import('./components/LoadProjectModal'));
const ExportModal = lazy(() => import('./components/ExportModal'));

const AudioSettingsPanel = lazy(() => import('./components/AudioSettingsPanel'));

const PluginManager = lazy(() => import('./components/PluginManager'));

import { supabaseManager } from './services/SupabaseManager';
import { SessionSerializer } from './services/SessionSerializer';
// import { getAIProductionAssistance } from './services/AIService'; 
import { novaBridge } from './services/NovaBridge';
import { ProjectIO } from './services/ProjectIO';
const PianoRoll = lazy(() => import('./components/PianoRoll'));
import { midiManager } from './services/MidiManager';
import { AUDIO_CONFIG, UI_CONFIG } from './utils/constants';
import SideBrowser2 from './components/SideBrowser2';
import { produce } from 'immer';
import { metronomeService } from './services/MetronomeService';
import { audioBufferRegistry } from './utils/audioBufferRegistry';
import { etirerBufferAsync, facteurPourTempo } from './utils/timeStretch';
import MobileTracksPage from './components/MobileTracksPage';
import MobileArrangementPage from './components/MobileArrangementPage';
import MobilePluginsPage from './components/MobilePluginsPage';
import MobileMixerPage from './components/MobileMixerPage';
import MobileBrowserPage from './components/MobileBrowserPage';
import MobileBottomNav from './components/MobileBottomNav';
import LandingPage from './components/LandingPage';
import { saveBlob } from './utils/saveBlob';
import { stripSilenceFromClip, StripSilenceResult } from './utils/stripSilence';
import { findVocalMixStyle, suggestVocalMixStyle, VOCAL_MIX_STYLES } from './utils/vocalPresets';
import { takeDraggedBeat } from './utils/beatDrag';
import { detectKey } from './utils/keyDetect';
import { AudioAnalysisEngine } from './engine/AudioAnalysisEngine';
import { getVocalRole, findTrackForRole, ROLE_MIX, VocalRole } from './utils/vocalRoles';
import { analyseMix, takeStats, levelsForAI } from './utils/mixAnalysis';
import { novaSpotlight } from './utils/novaSpotlight';
import { openBuyBeat, openProMix, openStudioSession, getCatalogBeat } from './utils/studioLinks';
import { parseLocalCommand } from './utils/novaCommands';
import { listTakes, selectTakeActions } from './utils/takes';
import RecordingCoach from './components/RecordingCoach';
import LyricsPrompter from './components/LyricsPrompter';
import MicLevelMeter from './components/MicLevelMeter';
import WelcomeSteps from './components/WelcomeSteps';
import ShareClipModal from './components/ShareClipModal';
import DrumMachinePanel from './components/DrumMachinePanel';
import { DrumMachine, makeDrumMachine, drumPadsFor, drumClipFor, suggestDrumKit, DRUM_KITS } from './utils/drumKits';
import { loadDrumSound } from './utils/drumSounds';
import { saveSession, loadSession, getSessionMeta, SavedSessionMeta } from './utils/sessionStore';
import VocalToolsPanel from './components/VocalToolsPanel';

const AVAILABLE_FX_MENU = [
    { id: 'MASTERSYNC', name: 'Master Sync', icon: 'fa-sync-alt' },
    { id: 'VOCALSATURATOR', name: 'Vocal Saturator', icon: 'fa-fire' },
    { id: 'PROEQ12', name: 'Pro-EQ 12', icon: 'fa-wave-square' },
    { id: 'AUTOTUNE', name: 'Auto-Tune Pro', icon: 'fa-microphone-alt' },
    { id: 'DENOISER', name: 'Denoiser', icon: 'fa-broom' },
    { id: 'COMPRESSOR', name: 'Leveler', icon: 'fa-compress-alt' },
    { id: 'REVERB', name: 'Spatial Verb', icon: 'fa-mountain-sun' },
    { id: 'DELAY', name: 'Sync Delay', icon: 'fa-history' },
    { id: 'CHORUS', name: 'Vocal Chorus', icon: 'fa-layer-group' },
    { id: 'FLANGER', name: 'Studio Flanger', icon: 'fa-wind' },
    { id: 'DOUBLER', name: 'Vocal Doubler', icon: 'fa-people-arrows' },
    { id: 'DEESSER', name: 'S-Killer', icon: 'fa-scissors' }
];

const createDefaultAutomation = (param: string, color: string): AutomationLane => ({
  id: `auto-${Date.now()}-${Math.random()}`,
  parameterName: param, points: [], color: color, isExpanded: false, min: 0, max: 1.5
});

/**
 * Lit la tonalite annoncee par le catalogue et la traduit pour l'AutoTune.
 *
 * Le catalogue melange les ecritures : « F# minor », « B MIN », « Bb min »,
 * « C # minor », « B HAMONIC minor ». Cette information etait affichee sur la
 * fiche du beat mais jamais exploitee : on chargeait un instrumental en fa#
 * mineur et l'AutoTune restait en do chromatique, donc inutilisable tel quel
 * pour quelqu'un qui ne connait pas la theorie.
 *
 * @returns null si la tonalite est absente ou illisible.
 */
/** Parties d'une session voix, dans l'ordre où un ingé son les fait poser. */
export type SessionPart = 'lead' | 'back' | 'harmony' | 'adlib';
const SESSION_LABEL: Record<SessionPart, string> = { lead: 'Voix principale', back: 'Backs', harmony: 'Harmonies', adlib: 'Ad-libs' };
const SESSION_TRACK_NAME: Record<SessionPart, string> = { lead: 'VOIX', back: 'BACKS', harmony: 'HARMONIES', adlib: 'AD-LIBS' };
const SESSION_BRIEF: Record<SessionPart, string> = {
  lead: "🎤 On commence par ta voix principale (le lead) sur la piste {piste} : c'est elle qui porte le morceau. Pose ton couplet d'une traite, même si tu te trompes : on garde la meilleure prise. Appuie sur REC, décompte, et vas-y.",
  back: "🎤 Les backs, sur la piste {piste} : rechante juste les fins de phrase et les punchlines par-dessus ton lead, avec la même énergie, pour les appuyer. Ton lead reste audible pour te caler. Je te remets 2 s avant ton premier passage.",
  harmony: "🎶 Les harmonies, sur la piste {piste} : au refrain, chante la même mélodie un peu plus haut (ou plus bas). Si c'est dur, double simplement ton refrain plus doucement, ça marche aussi.",
  adlib: "🔥 Les ad-libs, sur la piste {piste} : petits mots courts et pleins d'énergie (« yeah », « ok », « skrr »…) dans les trous entre tes phrases. Pas sur les mots du lead !",
};
/** Message de Nova poussé par le studio, avec boutons de réponse. */
export interface NovaFeedMessage {
  id: string;
  content: string;
  choices?: { label: string; action?: AIAction; actions?: AIAction[] }[];
}

const NOMS_NOTES = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const NOMS_GAMMES: Record<string, string> = { MAJOR: 'majeur', MINOR: 'mineur', MINOR_HARMONIC: 'mineur harmonique', PENTATONIC: 'pentatonique', CHROMATIC: 'chromatique' };
/** « La mineur », pour les messages à l'artiste. */
const nomTonalite = (rootKey?: number, scale?: string) =>
  typeof rootKey === 'number' ? `${NOMS_NOTES[((rootKey % 12) + 12) % 12]} ${NOMS_GAMMES[scale || 'MINOR'] || ''}`.trim() : '';

const lireTonalite = (brut?: string | null): { rootKey: number; scale: string } | null => {
  if (!brut) return null;
  const texte = String(brut).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!texte) return null;

  // Note fondamentale : lettre, puis alteration eventuelle (# ou B/BEMOL),
  // en tolerant une espace entre les deux (« C # minor »).
  const m = texte.match(/^([A-G])\s*(#|B|♭)?/);
  if (!m) return null;

  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let root = base[m[1]];
  if (root === undefined) return null;
  if (m[2] === '#') root = (root + 1) % 12;
  else if (m[2] === 'B' || m[2] === '♭') root = (root + 11) % 12;

  // Mode. On teste l'harmonique avant le mineur simple, la chaine contenant les deux.
  // « HAMONIC » est une faute presente telle quelle dans le catalogue.
  let scale = 'MAJOR';
  if (/HARMONIC|HAMONIC/.test(texte)) scale = 'MINOR_HARMONIC';
  else if (/MIN|MINOR|M(?!AJ)/.test(texte)) scale = 'MINOR';
  else if (/PENTA/.test(texte)) scale = 'PENTATONIC';
  else if (/MAJ/.test(texte)) scale = 'MAJOR';
  else scale = 'MINOR'; // le catalogue est massivement en mineur

  return { rootKey: root, scale };
};

const createDefaultPlugins = (type: PluginType, mix: number = 0.3, bpm: number = AUDIO_CONFIG.DEFAULT_BPM, paramsOverride: any = {}): PluginInstance => {
  let params: any = { isEnabled: true };
  let name: string = paramsOverride?.name || type;

  if (type === 'DELAY') params = { division: '1/4', feedback: 0.4, feedbackLP: 5000, feedbackHP: 150, mix, pingPong: false, bpm, isEnabled: true };
  if (type === 'REVERB') params = { decay: 2.5, preDelay: 0.02, damping: 0.4, mix, size: 0.7, mode: 'HALL', isEnabled: true };
  // makeupGain ≈ +4 dB : le compresseur n'ajoute plus de gain caché (ancien DynamicsCompressor)
  if (type === 'COMPRESSOR') params = { threshold: -18, ratio: 4, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1.6, isEnabled: true };
  if (type === 'AUTOTUNE') params = { speed: 0.1, humanize: 0.2, mix: 1.0, rootKey: 0, scale: 'CHROMATIC', isEnabled: true };
  if (type === 'CHORUS') params = { rate: 1.2, depth: 0.35, spread: 0.5, mix: 0.4, isEnabled: true };
  if (type === 'FLANGER') params = { rate: 0.5, depth: 0.5, feedback: 0.7, manual: 0.3, mix: 0.5, invertPhase: false, isEnabled: true };
  if (type === 'DOUBLER') params = { detune: 0.4, width: 0.8, gainL: 0.7, gainR: 0.7, directOn: true, isEnabled: true };
  if (type === 'STEREOSPREADER') params = { width: 1.0, haasDelay: 0.015, lowBypass: 0.8, isEnabled: true };
  if (type === 'DEESSER') params = { threshold: -25, frequency: 6500, q: 1.0, reduction: 0.6, mode: 'BELL', isEnabled: true };
  if (type === 'DENOISER') params = { threshold: -45, range: -20, attack: 0.005, hold: 0.05, release: 0.15, scFreq: 1000, flip: false, isEnabled: true };
  if (type === 'VOCALSATURATOR') params = { drive: 20, mix: 0.5, tone: 0.0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TAPE', isEnabled: true, outputGain: 1.0 };
  if (type === 'MASTERSYNC') params = { detectedBpm: 120, detectedKey: 0, isMinor: false, isAnalyzing: false, analysisProgress: 0, isEnabled: true, hasResult: false };
  if (type === 'PROEQ12') {
     const defaultFreqs = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
     const defaultBands = Array.from({ length: 12 }, (_, i) => ({
      id: i, type: (i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking') as any, 
      frequency: defaultFreqs[i], gain: 0, q: 1.0, isEnabled: true, isSolo: false
     }));
     params = { isEnabled: true, masterGain: 1.0, bands: defaultBands };
  }
  
  if (type === 'MELODIC_SAMPLER') {
      name = 'Melodic Sampler';
      params = { rootKey: 60, fineTune: 0, glide: 0.05, loop: true, loopStart: 0, loopEnd: 1, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5, filterCutoff: 20000, filterRes: 0, velocityToFilter: 0.5, lfoRate: 4, lfoAmount: 0, lfoDest: 'PITCH', saturation: 0, bitCrush: 0, chorus: 0, width: 0.5, isEnabled: true };
  }
  if (type === 'DRUM_SAMPLER') {
      name = 'Drum Sampler';
      params = { gain: 0, transpose: 0, fineTune: 0, sampleStart: 0, sampleEnd: 1, attack: 0.005, hold: 0.05, decay: 0.2, sustain: 0, release: 0.1, cutoff: 20000, resonance: 0, pan: 0, velocitySens: 0.8, reverse: false, normalize: false, chokeGroup: 1, isEnabled: true };
  }

  params = { ...params, ...paramsOverride };
  return { id: `pl-${Date.now()}-${Math.random()}`, name, type, isEnabled: true, params, latency: 0 };
};

const createInitialSends = (bpm: number, outputId: string = 'master'): Track[] => [
  { 
    id: 'send-delay', 
    name: 'DELAY 1/4', 
    type: TrackType.SEND, 
    color: '#00f2ff', 
    isMuted: false, 
    isSolo: false, 
    isTrackArmed: false, 
    isFrozen: false, 
    volume: 0.8, 
    pan: 0, 
    outputTrackId: outputId, 
    sends: [], 
    clips: [], 
    plugins: [createDefaultPlugins('DELAY', 1.0, bpm)], 
    automationLanes: [createDefaultAutomation('volume', '#00f2ff')], 
    totalLatency: 0 
  },
  { 
    id: 'send-verb-short', 
    name: 'VERB PRO', 
    type: TrackType.SEND, 
    color: '#10b981', 
    isMuted: false, 
    isSolo: false, 
    isTrackArmed: false, 
    isFrozen: false, 
    volume: 0.7, 
    pan: 0, 
    outputTrackId: outputId, 
    sends: [], 
    clips: [], 
    plugins: [createDefaultPlugins('REVERB', 1.0, bpm, { decay: 1.2, preDelay: 0.01, size: 0.4, mode: 'PLATE' })], 
    automationLanes: [createDefaultAutomation('volume', '#10b981')], 
    totalLatency: 0 
  },
  { 
    id: 'send-verb-long', 
    name: 'HALL SPACE', 
    type: TrackType.SEND, 
    color: '#a855f7', 
    isMuted: false, 
    isSolo: false, 
    isTrackArmed: false, 
    isFrozen: false, 
    volume: 0.6, 
    pan: 0, 
    outputTrackId: outputId, 
    sends: [], 
    clips: [], 
    plugins: [createDefaultPlugins('REVERB', 1.0, bpm, { decay: 3.5, preDelay: 0.05, size: 0.9, mode: 'HALL' })], 
    automationLanes: [createDefaultAutomation('volume', '#a855f7')], 
    totalLatency: 0 
  }
];

/**
 * Remet a niveau un projet sauvegarde avant l'ajout de la piste MASTER et des
 * champs timeSignature / trackGroups / markers / metronome / punch.
 * Sans ca, ouvrir un ancien projet laissait le fader master inerte et le
 * metronome / les marqueurs sur des valeurs undefined.
 */
const migrateLoadedState = (loaded: DAWState): DAWState => {
  const tracks = loaded.tracks ? [...loaded.tracks] : [];
  if (!tracks.some(t => t.id === 'master')) tracks.push(createMasterTrack());
  return {
    ...loaded,
    // Le rendu gele n'est pas persiste (il vit en memoire) : a l'ouverture on
    // repasse sur la chaine normale plutot que de laisser une piste muette.
    tracks: tracks.map(t => (t.isFrozen ? { ...t, isFrozen: false, frozenClip: undefined } : t)),
    timeSignature: loaded.timeSignature || { numerator: 4, denominator: 4 },
    trackGroups: loaded.trackGroups || [],
    markers: loaded.markers || [],
    metronome: loaded.metronome || { enabled: false, volume: 0.7, countIn: 0, accentDownbeat: true, sound: 'CLICK' },
    punch: loaded.punch || { enabled: false, punchIn: 0, punchOut: 0, preRoll: 0, postRoll: 0 }
  };
};

const createMasterTrack = (): Track => ({
  id: 'master', name: 'MASTER BUS', type: TrackType.BUS, color: '#00f2ff', isMuted: false, isSolo: false,
  isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: '', sends: [], clips: [],
  plugins: [], automationLanes: [createDefaultAutomation('volume', '#00f2ff')], totalLatency: 0
});

const createBusVox = (defaultSends: TrackSend[], bpm: number): Track => ({
  id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, color: '#fbbf24', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'master', sends: [...defaultSends], clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#fbbf24')], totalLatency: 0
});

const createBusFx = (): Track => ({
  id: 'bus-fx',
  name: 'BUS FX',
  type: TrackType.BUS,
  color: '#ec4899', 
  isMuted: false,
  isSolo: false,
  isTrackArmed: false,
  isFrozen: false,
  volume: 1.0,
  pan: 0,
  outputTrackId: 'master',
  sends: [],
  clips: [],
  plugins: [],
  automationLanes: [createDefaultAutomation('volume', '#ec4899')],
  totalLatency: 0
});

const SaveOverlay: React.FC<{ progress: number; message: string }> = ({ progress, message }) => (
  <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
    <div className="w-64 space-y-4 text-center">
      <div className="w-16 h-16 mx-auto rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin"></div>
      <h3 className="text-xl font-black text-white uppercase tracking-widest">{message}</h3>
      <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-cyan-500 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
      </div>
      <span className="text-xs font-mono text-cyan-400">{progress}%</span>
    </div>
  </div>
);

const useUndoRedo = (initialState: DAWState) => {
  const [history, setHistory] = useState<{ past: DAWState[]; present: DAWState; future: DAWState[]; }>({ past: [], present: initialState, future: [] });
  const MAX_HISTORY = 100;
  const HISTORY_DEBOUNCE_MS = 300; // Debounce 300ms pour éviter trop d'entrées
  const lastHistoryUpdateRef = useRef<number>(0);

  const cleanStateForHistory = (stateToClean: DAWState): DAWState => {
    return produce(stateToClean, draft => {
        draft.tracks.forEach(track => {
            track.clips.forEach(clip => {
                delete clip.buffer;
            });
            if (track.drumPads) {
                track.drumPads.forEach(pad => {
                    delete pad.buffer;
                });
            }
        });
    });
  };

  const setState = useCallback((updater: DAWState | ((prev: DAWState) => DAWState)) => {
    // L'anti-rebond est decide ICI, hors du reducer. Il etait calcule a
    // l'interieur en mutant lastHistoryUpdateRef : sous StrictMode React invoque
    // l'updater deux fois, la seconde passe voyait 0 ms ecoulee, repartait en
    // anti-rebond et ecrasait l'entree d'historique. Resultat : Ctrl+Z ne
    // restaurait presque jamais rien. Un reducer doit rester pur.
    const maintenant = Date.now();
    const antiRebond = maintenant - lastHistoryUpdateRef.current < HISTORY_DEBOUNCE_MS;
    if (!antiRebond) lastHistoryUpdateRef.current = maintenant;

    setHistory(curr => {
      const newState = typeof updater === 'function' ? updater(curr.present) : updater;
      if (newState === curr.present) return curr;

      // L'historique ne retient que les modifications reelles du projet.
      // Auparavant, selectionner une piste ou changer de vue creait une entree :
      // on obtenait des Ctrl+Z qui ne faisaient rien, puis un seul qui sautait
      // par-dessus plusieurs editions. Immer ne recree que les references
      // modifiees, une comparaison d'identite suffit donc.
      const modificationReelle =
        newState.tracks !== curr.present.tracks ||
        newState.bpm !== curr.present.bpm ||
        newState.name !== curr.present.name ||
        newState.markers !== curr.present.markers ||
        newState.trackGroups !== curr.present.trackGroups ||
        newState.timeSignature !== curr.present.timeSignature ||
        newState.isLoopActive !== curr.present.isLoopActive ||
        newState.loopStart !== curr.present.loopStart ||
        newState.loopEnd !== curr.present.loopEnd;

      if (!modificationReelle) return { ...curr, present: newState };

      // Changements rapproches : on met a jour le present sans nouvelle entree.
      if (antiRebond) return { ...curr, present: newState };

      const cleanedPresentForHistory = cleanStateForHistory(curr.present);

      return { past: [...curr.past, cleanedPresentForHistory].slice(-MAX_HISTORY), present: newState, future: [] };
    });
  }, []);

  const setVisualState = useCallback((updater: Partial<DAWState>) => { setHistory(curr => ({ ...curr, present: { ...curr.present, ...updater } })); }, []);
  const undo = useCallback(() => { setHistory(curr => { if (curr.past.length === 0) return curr; return { past: curr.past.slice(0, -1), present: curr.past[curr.past.length - 1], future: [curr.present, ...curr.future] }; }); }, []);
  const redo = useCallback(() => { setHistory(curr => { if (curr.future.length === 0) return curr; return { past: [...curr.past, curr.present], present: curr.future[0], future: curr.future.slice(1) }; }); }, []);
  return { state: history.present, setState, setVisualState, undo, redo, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
};

export default function App() {
  // Landing Page state - Always show landing on startup
  const [showLanding, setShowLanding] = useState(true);
  
  // Pending data from landing page to load after entering studio
  const [pendingInstrumental, setPendingInstrumental] = useState<any>(null);
  // Chargement d'un beat du catalogue (défini plus bas, appelé depuis l'accueil).
  const loadCatalogBeatRef = useRef<((inst: any) => Promise<void>) | null>(null);
  const [pendingAudioFile, setPendingAudioFile] = useState<File | null>(null);
  const [pendingProject, setPendingProject] = useState<any>(null);

  const handleEnterStudio = () => {
    setShowLanding(false);
  };
  
  const handleEnterWithInstrumental = (instrumental: any) => {
    setPendingInstrumental(instrumental);
    setShowLanding(false);
  };
  
  const handleEnterWithAudioFile = (file: File) => {
    setPendingAudioFile(file);
    setShowLanding(false);
  };
  
  const handleEnterWithProject = (project: any) => {
    setPendingProject(project);
    setShowLanding(false);
  };

  // Dernière session sauvegardée sur l'appareil (« Reprendre ma session »)
  const [savedSessionMeta, setSavedSessionMeta] = useState<SavedSessionMeta | null>(null);
  useEffect(() => { getSessionMeta().then(setSavedSessionMeta).catch(() => {}); }, []);
  // Après une reprise : le beat du catalogue n'est pas dans la sauvegarde (licence),
  // on le recharge depuis le catalogue.
  const restoreBeatAfterResumeRef = useRef(false);

  const handleResumeSession = async () => {
    const saved = await loadSession();
    if (!saved) { setSavedSessionMeta(null); return; }
    try {
      const project = await ProjectIO.loadProject(new File([saved.blob], 'session.novaproj.zip'));
      restoreBeatAfterResumeRef.current = true;
      handleEnterWithProject(project);
    } catch (e) {
      console.error('[Session] Reprise impossible', e);
      setAiNotification("La session sauvegardée n'a pas pu être rouverte.");
      setShowLanding(false);
    }
  };

  // Ouverture depuis le site : /daw?beat=<id> → studio direct, beat chargé.
  useEffect(() => {
    let beatId: string | null = null;
    try { beatId = new URLSearchParams(window.location.search).get('beat'); } catch { /* */ }
    if (!beatId) return;
    supabaseManager.getActiveInstrumentals().then(list => {
      const inst = list.find((i: any) => String(i.id) === beatId);
      if (inst) handleEnterWithInstrumental(inst);
    }).catch(() => {});
  }, []);

  // Utilisateur par défaut pour éviter l'écran noir (temporaire)
  const defaultUser: User = {
    id: 'guest',
    email: 'guest@novastudio.app',
    username: 'Guest User',
    isVerified: true,
    plan: 'FREE',
    owned_instruments: []
  };

  const [user, setUser] = useState<User | null>(defaultUser);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [saveState, setSaveState] = useState<{ isSaving: boolean; progress: number; message: string }>({ isSaving: false, progress: 0, message: '' });
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isPluginManagerOpen, setIsPluginManagerOpen] = useState(false); 
  const [isAudioSettingsOpen, setIsAudioSettingsOpen] = useState(false);
  const [isSaveMenuOpen, setIsSaveMenuOpen] = useState(false); 
  const [isLoadMenuOpen, setIsLoadMenuOpen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [midiEditorOpen, setMidiEditorOpen] = useState<{trackId: string, clipId: string} | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeSideBrowserTab, setActiveSideBrowserTab] = useState<'STORE' | 'FX' | 'BRIDGE'>('STORE');

  useEffect(() => {
      const u = supabaseManager.getUser();
      if(u) setUser(u);
  }, []);

  // Démarrer l'auto-save quand l'utilisateur est connecté (pas guest)
  useEffect(() => {
    if (user && user.id !== 'guest') {
      // Démarrer le backup automatique
      supabaseManager.startAutoSave(() => stateRef.current);
      console.log("[AutoBackup] Système de backup automatique démarré pour", user.email);
      
      // Nettoyer les vieux backups (garder les 5 derniers)
      supabaseManager.cleanOldBackups();
      
      return () => {
        supabaseManager.stopAutoSave();
      };
    }
  }, [user]);

  // Charger le dernier backup automatique au démarrage si connecté
  const [showBackupRecovery, setShowBackupRecovery] = useState(false);
  const [pendingBackup, setPendingBackup] = useState<any>(null);
  
  useEffect(() => {
    if (showLanding) return; // Pas encore entré dans le studio
    if (!user || user.id === 'guest') return; // Pas connecté
    
    const checkForBackup = async () => {
      try {
        const backup = await supabaseManager.loadLatestAutoBackup();
        if (backup) {
          console.log("[AutoBackup] Backup récent trouvé, proposer restauration...");
          setPendingBackup(backup);
          setShowBackupRecovery(true);
        }
      } catch (e) {
        console.error("[AutoBackup] Erreur vérification backup:", e);
      }
    };
    
    // Petit délai pour laisser le studio se charger
    const timer = setTimeout(checkForBackup, 1000);
    return () => clearTimeout(timer);
  }, [showLanding, user]);

  // Charger les données pendantes de la landing page après l'entrée dans le studio
  useEffect(() => {
    if (showLanding) return; // Toujours sur la landing page
    
    const loadPendingData = async () => {
      // Charger un projet complet
      if (pendingProject) {
        handleLoadProject(pendingProject);
        setPendingProject(null);
        return;
      }

      // Charger un fichier audio local
      if (pendingAudioFile) {
        await handleNewAudioImport(pendingAudioFile);
        setPendingAudioFile(null);
        return;
      }

      // Charger un instrumental depuis le catalogue
      if (pendingInstrumental) {
        await loadCatalogBeatRef.current?.(pendingInstrumental);
        setPendingInstrumental(null);
      }
    };

    // Petit délai pour laisser le studio se charger
    const timer = setTimeout(loadPendingData, 500);
    return () => clearTimeout(timer);
  }, [showLanding, pendingProject, pendingAudioFile, pendingInstrumental]);

  const initialState: DAWState = {
    id: 'proj-1', name: 'STUDIO_SESSION', bpm: AUDIO_CONFIG.DEFAULT_BPM, isPlaying: false, isRecording: false, currentTime: 0,
    isLoopActive: false, loopStart: 0, loopEnd: 8,
    tracks: [
      { id: 'instrumental', name: 'BEAT', type: TrackType.AUDIO, color: '#eab308', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 0.7, pan: 0, outputTrackId: 'master', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#eab308')], totalLatency: 0 },
      { id: 'track-rec-main', name: 'REC', type: TrackType.AUDIO, color: '#ff0000', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#ff0000')], totalLatency: 0 },
      { id: 'lead-couplet', name: 'LEAD COUPLET', type: TrackType.AUDIO, color: '#3b82f6', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#3b82f6')], totalLatency: 0 },
      { id: 'lead-refrain', name: 'LEAD REFRAIN', type: TrackType.AUDIO, color: '#60a5fa', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#60a5fa')], totalLatency: 0 },
      { id: 'back-1', name: 'BACK 1', type: TrackType.AUDIO, color: '#a855f7', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#a855f7')], totalLatency: 0 },
      { id: 'back-2', name: 'BACK 2', type: TrackType.AUDIO, color: '#c084fc', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'bus-vox', sends: createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), clips: [], plugins: [], automationLanes: [createDefaultAutomation('volume', '#c084fc')], totalLatency: 0 },
      createBusVox(createInitialSends(AUDIO_CONFIG.DEFAULT_BPM).map(s => ({ id: s.id, level: 0, isEnabled: true })), AUDIO_CONFIG.DEFAULT_BPM), 
      createBusFx(),
      ...createInitialSends(AUDIO_CONFIG.DEFAULT_BPM, 'bus-fx'),
      createMasterTrack()
    ],
    selectedTrackId: 'track-rec-main', currentView: 'ARRANGEMENT', projectPhase: ProjectPhase.SETUP, isLowLatencyMode: false, isRecModeActive: false, systemMaxLatency: 0, recStartTime: null,
    // Recalage de la prise sur le beat (latence de sortie) : actif par défaut,
    // sans quoi la voix arrivait en retard.
    isDelayCompEnabled: true,
    timeSignature: { numerator: 4, denominator: 4 },
    trackGroups: [],
    markers: [],
    metronome: { enabled: false, volume: 0.7, countIn: 0, accentDownbeat: true, sound: 'CLICK' },
    punch: { enabled: false, punchIn: 0, punchOut: 0, preRoll: 0, postRoll: 0 }
  };

  const { state, setState, setVisualState, undo, redo, canUndo, canRedo } = useUndoRedo(initialState);
  
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  const toggleTheme = () => { setTheme(prev => prev === 'dark' ? 'light' : 'dark'); };

  const toggleSidebar = () => setIsSidebarOpen(prev => !prev);
    // Bridge VST (ws://localhost) plus connecté automatiquement : l'onglet
    // Bridge est retiré (le DAW sert aux voix). La fenêtre VST, si un projet
    // en contient une, se connecte elle-même.
  // Presse-papiers de clips (partage entre l'arrangement desktop et mobile).
  const clipboardClipRef = useRef<Clip | null>(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // --- Protection contre la perte de travail ---
  // Fermer l'onglet ou recharger detruisait toute la session sans le moindre
  // avertissement, alors que le projet ne vit qu'en memoire.
  const hasUnsavedChangesRef = useRef(false);
  const unsavedMountRef = useRef(false);


  // Ref to track atomic updates (volume/pan only) to skip expensive graph rebuild
  const skipEngineUpdateRef = useRef(false);

  useEffect(() => {
    if (skipEngineUpdateRef.current) {
      skipEngineUpdateRef.current = false; // Reset flag
      return; // Skip rebuild for atomic updates
    }
    if (audioEngine.ctx) state.tracks.forEach(t => audioEngine.updateTrack(t, state.tracks));
  }, [state.tracks]); 
  useEffect(() => { audioEngine.setLoop(state.isLoopActive, state.loopStart, state.loopEnd); }, [state.isLoopActive, state.loopStart, state.loopEnd]);
  // Le reglage de compensation n'etait jamais transmis au moteur.
  useEffect(() => { audioEngine.setDelayCompensation(state.isDelayCompEnabled); }, [state.isDelayCompEnabled]);

  // Metronome : reglages, tempo et signature suivent l'etat du projet.
  useEffect(() => { metronomeService.setSettings(state.metronome); }, [state.metronome]);
  useEffect(() => { metronomeService.setBpm(state.bpm); }, [state.bpm]);
  useEffect(() => { metronomeService.setTimeSignature(state.timeSignature); }, [state.timeSignature]);
  useEffect(() => {
    // On aligne le clic sur la position reelle du playhead au demarrage.
    if (state.isPlaying && state.metronome.enabled) metronomeService.start(audioEngine.getCurrentTime());
    else metronomeService.stop();
  }, [state.isPlaying, state.metronome.enabled]);
  
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (stateRef.current.isPlaying) {
         const time = audioEngine.getCurrentTime();
         setVisualState({ currentTime: time });
         animId = requestAnimationFrame(updateLoop);
      }
    };
    if (state.isPlaying) { animId = requestAnimationFrame(updateLoop); }
    return () => cancelAnimationFrame(animId);
  }, [state.isPlaying, setVisualState]);

  const [activePlugin, setActivePlugin] = useState<{trackId: string, plugin: PluginInstance} | null>(null);
  const [externalImportNotice, setExternalImportNotice] = useState<string | null>(null);
  const [aiNotification, setAiNotification] = useState<string | null>(null);

  // Nettoyage automatique des blancs après chaque prise (réglable, mémorisé).
  const [autoCleanSilence, setAutoCleanSilenceState] = useState<boolean>(() => {
    try { return localStorage.getItem('nova_auto_clean') !== '0'; } catch { return true; }
  });
  const autoCleanRef = useRef(autoCleanSilence);

  // Retour du micro dans le casque (réponse à « Tu as un casque ? », modifiable).
  const [inputMonitoring, setInputMonitoringState] = useState<boolean>(() => {
    try { return localStorage.getItem('nova_headphones') === '1'; } catch { return false; }
  });
  useEffect(() => { audioEngine.setInputMonitoring(inputMonitoring); }, [inputMonitoring]);
  const setInputMonitoring = (on: boolean) => {
    setInputMonitoringState(on);
    try { localStorage.setItem('nova_headphones', on ? '1' : '0'); } catch { /* stockage indisponible */ }
  };
  const [countInEnabled, setCountInEnabledState] = useState<boolean>(() => {
    try { return localStorage.getItem('nova_count_in') !== '0'; } catch { return true; }
  });
  const setCountInEnabled = (on: boolean) => {
    setCountInEnabledState(on);
    try { localStorage.setItem('nova_count_in', on ? '1' : '0'); } catch { /* stockage indisponible */ }
  };
  autoCleanRef.current = autoCleanSilence;
  const setAutoCleanSilence = (on: boolean) => {
    setAutoCleanSilenceState(on);
    try { localStorage.setItem('nova_auto_clean', on ? '1' : '0'); } catch { /* stockage indisponible */ }
    setAiNotification(on ? '🧹 Nettoyage auto des blancs activé' : 'Nettoyage auto des blancs désactivé');
  };
  const [addPluginMenu, setAddPluginMenu] = useState<{ trackId: string, x: number, y: number } | null>(null);
  const [automationMenu, setAutomationMenu] = useState<{ x: number, y: number, trackId: string, paramId: string, paramName: string, min: number, max: number } | null>(null);
  const [noArmedTrackError, setNoArmedTrackError] = useState(false);
  // Mode choisi par l'utilisateur (sélecteur) ; sinon déduit de l'écran.
  // localStorage peut être bloqué (iframe, navigation stricte) : sans try/catch
  // la lecture faisait planter le DAW avant même le premier affichage.
  const readSavedViewMode = (): ViewMode | null => {
    try {
      const v = localStorage.getItem('nova_view_mode');
      return v === 'MOBILE' || v === 'TABLET' || v === 'DESKTOP' ? v : null;
    } catch { return null; }
  };
  // Un téléphone en paysage (≈ 844 px) passait en TABLET, dont les vues sont
  // utilisables seulement à la souris : écran tactile + petit côté < 600 px = MOBILE.
  const autoViewMode = (): ViewMode => {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    if (window.innerWidth < 768 || (coarse && shortSide < 600)) return 'MOBILE';
    return window.innerWidth < 1024 ? 'TABLET' : 'DESKTOP';
  };
  const [viewMode, setViewMode] = useState<ViewMode>(() => readSavedViewMode() ?? autoViewMode());
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>('TRACKS');
  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem('nova_view_mode', mode); } catch { /* stockage indisponible */ }
  };
  // Sans choix manuel, le mode suit la rotation et le redimensionnement.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { if (!readSavedViewMode()) setViewMode(autoViewMode()); }, 200);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { document.body.setAttribute('data-view-mode', viewMode); }, [viewMode]);
  const isMobile = viewMode === 'MOBILE';
  const isMobileRef = useRef(isMobile); isMobileRef.current = isMobile;
  const activeTabRef = useRef(activeMobileTab); activeTabRef.current = activeMobileTab;

  // Messages de Nova (avec boutons de réponse) poussés dans le chat par le studio :
  // bilan de prise, consignes de session, écoute du mix.
  const [novaFeed, setNovaFeed] = useState<NovaFeedMessage[]>([]);
  const [novaUnread, setNovaUnread] = useState(false);
  const postNova = useCallback((content: string, choices?: NovaFeedMessage['choices']) => {
    setNovaFeed(prev => [...prev.slice(-40), { id: `nova-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, content, choices }]);
    if (isMobileRef.current && activeTabRef.current !== 'NOVA') setNovaUnread(true);
  }, []);
  useEffect(() => { if (activeMobileTab === 'NOVA') setNovaUnread(false); }, [activeMobileTab]);

  // Partie de la session en cours : lead, backs, harmonies, ad-libs.
  const [sessionPart, setSessionPart] = useState<SessionPart>('lead');
  const coachAfterTakeRef = useRef<((trackId: string, buffer: AudioBuffer, takeName: string, start: number) => void) | null>(null);
  // Contexte audio déjà raccordé au métronome et aux pistes. Le moteur peut être
  // initialisé ailleurs (aperçu d'un beat du catalogue, armement, import…) :
  // l'ancien test « wasUninitialized » sautait alors le raccordement et le
  // métronome restait muet toute la session.
  const wiredCtxRef = useRef<AudioContext | null>(null);
  const ensureAudioEngine = async () => {
    if (!audioEngine.ctx) await audioEngine.init();
    // resume() ne se résout qu'après un geste reconnu par le navigateur : l'attendre
    // sans limite bloquait l'ouverture des plugins (rien ne se passait au tap).
    // L'audio reprendra au prochain toucher (AudioEngine.hookAutoResume).
    await Promise.race([audioEngine.resume().catch(() => {}), new Promise(r => setTimeout(r, 300))]);
    if (audioEngine.ctx && wiredCtxRef.current !== audioEngine.ctx) {
      wiredCtxRef.current = audioEngine.ctx;
      stateRef.current.tracks.forEach(t => audioEngine.updateTrack(t, stateRef.current.tracks));
      // Le metronome partage le contexte audio du moteur.
      metronomeService.init(audioEngine.ctx);
      metronomeService.setSettings(stateRef.current.metronome);
      metronomeService.setBpm(stateRef.current.bpm);
      metronomeService.setTimeSignature(stateRef.current.timeSignature);
    }
  };

  const handleLogout = async () => { await supabaseManager.signOut(); setUser(null); };
  const handleBuyLicense = (instrumentId: string | number) => { if (!user) return; const updatedUser = { ...user, owned_instruments: [...(user.owned_instruments || []), instrumentId] }; setUser(updatedUser); setAiNotification(`✅ Licence achetée avec succès ! Export débloqué.`); };
  
  const handleSaveCloud = async (projectName: string) => { 
    if (!user) {
      setAiNotification("⚠️ Connectez-vous pour sauvegarder dans le cloud");
      return;
    }
    setSaveState({ isSaving: true, progress: 10, message: 'Préparation...' });
    try {
      setSaveState(s => ({ ...s, progress: 30, message: 'Sauvegarde cloud...' }));
      const stateToSave = { ...stateRef.current, name: projectName };
      const saved = await supabaseManager.saveUserSession(stateToSave, (percent, message) => {
        setSaveState(s => ({ ...s, progress: Math.max(30, percent), message }));
      });
      setSaveState(s => ({ ...s, progress: 100, message: '✅ Sauvegardé !' }));
      hasUnsavedChangesRef.current = false;
      // On garde l'UUID renvoye par Supabase: les sauvegardes suivantes mettent a jour
      // le meme projet au lieu d'en creer un nouveau a chaque fois.
      setState(prev => ({ ...prev, name: projectName, id: saved?.id || prev.id }));
      setAiNotification(`✅ Projet "${projectName}" sauvegardé dans le cloud`);
    } catch (e: any) {
      console.error('[Cloud Save Error]', e);
      setAiNotification(`❌ Erreur: ${e.message}`);
    } finally {
      setTimeout(() => setSaveState({ isSaving: false, progress: 0, message: '' }), 1500);
    }
  };
  
  const handleSaveAsCopy = async (n: string) => { 
    if (!user) {
      setAiNotification("⚠️ Connectez-vous pour sauvegarder une copie");
      return;
    }
    setSaveState({ isSaving: true, progress: 10, message: 'Création de la copie...' });
    try {
      const copyName = `${n} (Copy)`;
      const stateToSave = { ...stateRef.current, id: `proj-${Date.now()}`, name: copyName };
      setSaveState(s => ({ ...s, progress: 50, message: 'Sauvegarde...' }));
      await supabaseManager.saveUserSession(stateToSave, (percent, message) => {
        setSaveState(s => ({ ...s, progress: Math.max(50, percent), message }));
      }, true);
      setSaveState(s => ({ ...s, progress: 100, message: '✅ Copie créée !' }));
      hasUnsavedChangesRef.current = false;
      setAiNotification(`✅ Copie "${copyName}" créée dans le cloud`);
    } catch (e: any) {
      console.error('[Cloud Copy Error]', e);
      setAiNotification(`❌ Erreur: ${e.message}`);
    } finally {
      setTimeout(() => setSaveState({ isSaving: false, progress: 0, message: '' }), 1500);
    }
  };
  
  const handleSaveLocal = async (n: string) => { 
    setSaveState({ isSaving: true, progress: 10, message: 'Préparation du projet...' });
    try {
      // Récupérer les IDs des instruments possédés (pour exclusion licence)
      const ownedIds = user?.owned_instruments || [];
      setSaveState(s => ({ ...s, progress: 40, message: 'Création du fichier ZIP...' }));
      
      // Utiliser ProjectIO pour créer un ZIP avec les audios
      const zipBlob = await ProjectIO.saveProject(stateRef.current, ownedIds);
      
      setSaveState(s => ({ ...s, progress: 80, message: 'Téléchargement...' }));
      
      // Télécharger le fichier (feuille de partage sur téléphone)
      await saveBlob(zipBlob, `${n || 'NovaProject'}.novaproj.zip`);
      
      setSaveState(s => ({ ...s, progress: 100, message: '✅ Téléchargé !' }));
      setAiNotification(`✅ Projet "${n}" exporté avec les audios`);
      hasUnsavedChangesRef.current = false;
    } catch (e: any) {
      console.error('[Local Save Error]', e);
      setAiNotification(`❌ Erreur: ${e.message}`);
    } finally {
      setTimeout(() => setSaveState({ isSaving: false, progress: 0, message: '' }), 1500);
    }
  };
  
  const handleLoadProject = useCallback((rawState: DAWState) => {
    const loadedState = migrateLoadedState(rawState);
    ensureAudioEngine().then(() => {
        // On libère l'audio de l'ancien projet, mais pas celui que ProjectIO
        // vient de décoder pour CE projet : clear() effaçait toutes les prises
        // d'un projet ouvert depuis un fichier ou une session sauvegardée.
        const keep = new Set<string>();
        loadedState.tracks.forEach(t => t.clips.forEach(c => { if (c.bufferId) keep.add(c.bufferId); }));
        audioBufferRegistry.removeMany(audioBufferRegistry.ids().filter(id => !keep.has(id)));
        
        loadedState.tracks.forEach(track => {
            track.clips.forEach(clip => {
                if (clip.buffer) {
                    audioBufferRegistry.register(clip.buffer, clip.id);
                    clip.bufferId = clip.id;
                    delete (clip as Partial<Clip>).buffer;
                }
            });
            track.drumPads?.forEach(pad => {
                if (pad.buffer) {
                    audioEngine.loadDrumRackSample(track.id, pad.id, pad.buffer);
                    delete (pad as Partial<DrumPad>).buffer;
                }
            });
        });

        setState(loadedState);
        audioEngine.setBpm(loadedState.bpm);

        setTimeout(() => {
            loadedState.tracks.forEach(t => audioEngine.updateTrack(t, loadedState.tracks));
        }, 100);
    });
  }, [setState]);

  const handleLoadLocalFile = useCallback(async (file: File) => {
      setExternalImportNotice("Chargement du projet...");
      try {
          const loadedProject = await ProjectIO.loadProject(file);
          if (loadedProject) {
              handleLoadProject(loadedProject);
              setExternalImportNotice("✅ Projet chargé !");
          }
      } catch (e: any) {
          setExternalImportNotice(`❌ Erreur: ${e.message}`);
      } finally {
          setTimeout(() => setExternalImportNotice(null), 3000);
      }
  }, [handleLoadProject]);

  const handleLoadCloud = useCallback(async (id: string) => {
      setExternalImportNotice("Chargement depuis le cloud...");
      try {
          const loadedProject = await supabaseManager.loadUserSession(id);
          if (loadedProject) {
              handleLoadProject(loadedProject);
              setExternalImportNotice("✅ Projet cloud chargé !");
          }
      } catch (e: any) {
          setExternalImportNotice(`❌ Erreur: ${e.message}`);
      } finally {
          setTimeout(() => setExternalImportNotice(null), 3000);
      }
  }, [handleLoadProject]);

  const handleShareProject = async (e: string) => { setIsShareModalOpen(false); };
  const handleExportMix = async () => { setIsExportMenuOpen(true); };

  /**
   * Libere un buffer uniquement si plus aucun clip ne l'utilise.
   * Copier/coller et dupliquer partagent le meme bufferId : supprimer une copie
   * supprimait l'audio de toutes les autres.
   */
  const releaseBufferIfUnused = useCallback((bufferId: string | undefined, excludeClipIds: string[]) => {
    if (!bufferId) return;
    const stillUsed = stateRef.current.tracks.some(t =>
      [...t.clips, ...(t.frozenClip ? [t.frozenClip] : [])]
        .some(c => c.bufferId === bufferId && !excludeClipIds.includes(c.id))
    );
    if (!stillUsed) audioBufferRegistry.remove(bufferId);
  }, []);

  /** Evite de lancer deux etirements concurrents sur le meme clip. */
  const calagesEnCoursRef = useRef<Set<string>>(new Set());

  /**
   * Cale un clip sur un tempo donne. L'etirement part TOUJOURS du buffer
   * d'origine : reetirer un buffer deja etire degraderait le son un peu plus a
   * chaque changement de tempo.
   */
  const caleClipSurTempo = useCallback(async (
    trackId: string, clipId: string, bpmCible: number, silencieux = false
  ) => {
    const cle = `${trackId}:${clipId}`;
    if (calagesEnCoursRef.current.has(cle)) return;

    const track = stateRef.current.tracks.find(t => t.id === trackId);
    const clip = track?.clips.find(c => c.id === clipId);
    if (!clip || !clip.warp || !audioEngine.ctx) return;

    // Reference d'origine : figee au premier calage, reutilisee ensuite.
    const sourceBufferId = clip.warp.sourceBufferId ?? clip.bufferId;
    const sourceBpm = clip.warp.sourceBpm ?? clip.warp.originalBpm;
    const sourceDuration = clip.warp.sourceDuration ?? clip.duration;
    const sourceOffset = clip.warp.sourceOffset ?? (clip.offset || 0);
    const sourceFadeIn = clip.warp.sourceFadeIn ?? (clip.fadeIn || 0);
    const sourceFadeOut = clip.warp.sourceFadeOut ?? (clip.fadeOut || 0);
    if (!sourceBufferId || !sourceBpm) return;

    const buffer = audioBufferRegistry.get(sourceBufferId);
    if (!buffer) return;

    const facteur = facteurPourTempo(sourceBpm, bpmCible);
    if (Math.abs(facteur - 1) < 0.001 && clip.bufferId === sourceBufferId) return;

    calagesEnCoursRef.current.add(cle);
    if (!silencieux) setExternalImportNotice(`Calage sur ${Math.round(bpmCible)} BPM...`);
    try {
      const etire = await etirerBufferAsync(audioEngine.ctx, buffer, facteur);
      const nouvelId = `stretch-${clipId}-${Date.now()}`;
      audioBufferRegistry.register(etire, nouvelId);

      setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(x => x.id === trackId);
        const c = t?.clips.find(x => x.id === clipId);
        if (!c) return;
        c.bufferId = nouvelId;
        c.duration = sourceDuration * facteur;
        c.offset = sourceOffset * facteur;
        c.fadeIn = sourceFadeIn * facteur;
        c.fadeOut = sourceFadeOut * facteur;
        c.warp = {
          ...(c.warp || { mode: 'BEATS', preservePitch: true }),
          enabled: true,
          originalBpm: bpmCible,
          sourceBufferId, sourceBpm, sourceDuration, sourceOffset, sourceFadeIn, sourceFadeOut
        };
      }));
      if (!silencieux) setExternalImportNotice(`✅ Calé sur ${Math.round(bpmCible)} BPM`);
    } catch (e: any) {
      console.error('[warp]', e);
      if (!silencieux) setExternalImportNotice(`❌ Calage impossible : ${e?.message || 'erreur'}`);
    } finally {
      calagesEnCoursRef.current.delete(cle);
      if (!silencieux) setTimeout(() => setExternalImportNotice(null), 2500);
    }

    // Le tempo a pu continuer de bouger pendant le calcul (glissement du
    // controle de tempo). On ne peut pas se contenter d'ignorer les demandes
    // arrivees entre-temps, sinon le clip reste cale sur un tempo perime : on
    // relance sur la valeur courante.
    const bpmCourant = stateRef.current.bpm;
    const clipAJour = stateRef.current.tracks.find(t => t.id === trackId)?.clips.find(c => c.id === clipId);
    if (clipAJour?.warp?.enabled && Math.abs((clipAJour.warp.originalBpm ?? bpmCourant) - bpmCourant) > 0.01) {
      caleClipSurTempoRef.current?.(trackId, clipId, bpmCourant, true);
    }
  }, [setState]);

  // Reference stable pour permettre la relance ci-dessus sans dependance circulaire.
  const caleClipSurTempoRef = useRef<typeof caleClipSurTempo | null>(null);
  useEffect(() => { caleClipSurTempoRef.current = caleClipSurTempo; }, [caleClipSurTempo]);

  /**
   * Suivi automatique du tempo : les clips deja cales se reetirent quand le
   * tempo du projet change. On attend la fin du geste, sinon glisser le controle
   * de tempo lancerait des dizaines d'etirements.
   */
  useEffect(() => {
    const bpm = state.bpm;
    const minuteur = setTimeout(() => {
      stateRef.current.tracks.forEach(t => t.clips.forEach(c => {
        if (c.warp?.enabled && c.warp.originalBpm !== undefined
            && Math.abs(c.warp.originalBpm - bpm) > 0.01) {
          caleClipSurTempo(t.id, c.id, bpm, true);
        }
      }));
    }, 500);
    return () => clearTimeout(minuteur);
  }, [state.bpm, caleClipSurTempo]);

  const handleEditClip = (trackId: string, clipId: string, action: string, payload?: any) => {
    if (action === 'NORMALIZE') {
      const track = stateRef.current.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      const buffer = clip?.buffer || (clip?.bufferId ? audioBufferRegistry.get(clip.bufferId) : null);
      if (!clip || !buffer) return;
      let peak = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
      }
      if (peak <= 0) return;
      // -0.3 dBFS de marge pour eviter l'ecretage.
      action = 'UPDATE_PROPS';
      payload = { gain: Math.min(8, 0.966 / peak) };
    }

    if (action === 'FIT_TEMPO') {
      const track = stateRef.current.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (!clip?.warp?.originalBpm) return;
      // Premier calage : on fige la reference d'origine pour pouvoir toujours
      // reetirer depuis le buffer intact.
      caleClipSurTempo(trackId, clipId, stateRef.current.bpm, true);
      return;
    }

    if (action === 'COPY' || action === 'CUT') {
      const track = stateRef.current.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (clip) clipboardClipRef.current = { ...clip };
      if (action === 'COPY') return;
      // CUT : on copie puis on supprime via la branche DELETE ci-dessous.
      action = 'DELETE';
    }

    setState(produce((draft: DAWState) => {
      const track = draft.tracks.find(t => t.id === trackId);
      if (!track) return;
      let newClips = [...track.clips];
      const idx = newClips.findIndex(c => c.id === clipId);
      if (idx === -1 && action !== 'PASTE') return;
      
      switch(action) {
        case 'PASTE': {
            const source = clipboardClipRef.current;
            if (!source) return;
            const start = Math.max(0, payload?.time ?? 0);
            newClips.push({ ...source, id: `clip-paste-${Date.now()}`, start });
            break;
        }
        case 'UPDATE_PROPS': if(idx > -1) newClips[idx] = { ...newClips[idx], ...payload }; break;
        case 'DELETE': 
            if(idx > -1) {
                const clipToDelete = newClips[idx];
                const bufferId = clipToDelete.bufferId;
                newClips.splice(idx, 1);
                if (bufferId) setTimeout(() => releaseBufferIfUnused(bufferId, []), 0);
            }
            break;
        case 'MUTE': if(idx > -1) newClips[idx] = { ...newClips[idx], isMuted: !newClips[idx].isMuted }; break;
        // payload.start permet de deposer la copie a un endroit precis
        // (Alt+glisser laisse une copie a la position d'origine).
        case 'DUPLICATE': if(idx > -1) newClips.push({ ...newClips[idx], id: `clip-dup-${Date.now()}`, start: payload?.start ?? (newClips[idx].start + newClips[idx].duration + 0.1) }); break;
        case 'RENAME': if(idx > -1) newClips[idx] = { ...newClips[idx], name: payload.name }; break;
        case 'SPLIT': 
            if(idx > -1) {
              const clip = newClips[idx];
              const splitTime = payload.time;
              if (splitTime > clip.start && splitTime < clip.start + clip.duration) {
                  const firstDuration = splitTime - clip.start;
                  const secondDuration = clip.duration - firstDuration;
                  newClips[idx] = { ...clip, duration: firstDuration };
                  newClips.push({ ...clip, id: `clip-split-${Date.now()}`, start: splitTime, duration: secondDuration, offset: clip.offset + firstDuration });
              }
            }
            break;
      }
      track.clips = newClips;
    }));
  };

  const handleUpdateBpm = useCallback((newBpm: number) => { 
    // On borne AVANT d'informer le moteur : sinon un tempo hors limites etait
    // envoye aux plugins synchronises alors que l'etat affichait la valeur bornee.
    const bpm = Math.max(20, Math.min(999, Number.isFinite(newBpm) ? newBpm : 120));
    audioEngine.setBpm(bpm);
    setState(prev => ({ ...prev, bpm })); 
  }, [setState]);
  
  const handleUpdateTrack = useCallback((updatedTrack: Track) => {
    const previousTrack = stateRef.current.tracks.find(t => t.id === updatedTrack.id);

    if (previousTrack && previousTrack.isTrackArmed !== updatedTrack.isTrackArmed) {
        if (updatedTrack.isTrackArmed) {
            // Une seule piste armee a la fois
            setState(produce(draft => {
                draft.tracks.forEach(t => {
                    if (t.id !== updatedTrack.id) t.isTrackArmed = false;
                });
            }));
            // Si le micro est refuse ou absent, on le dit et on desarme : sinon
            // la piste paraissait prete et l'enregistrement echouait en silence.
            audioEngine.armTrack(updatedTrack.id).then(erreur => {
                if (!erreur) return;
                setAiNotification(`🎤 ${erreur}`);
                setTimeout(() => setAiNotification(null), 5000);
                setState(produce(draft => {
                    const t = draft.tracks.find(x => x.id === updatedTrack.id);
                    if (t) t.isTrackArmed = false;
                }));
            });
        } else {
            audioEngine.disarmTrack();
        }
    }

    // Detect atomic updates (volume/pan only) to avoid expensive graph rebuild
    if (previousTrack) {
        const isVolumeOnlyChange = previousTrack.volume !== updatedTrack.volume &&
            previousTrack.pan === updatedTrack.pan &&
            previousTrack.isMuted === updatedTrack.isMuted &&
            previousTrack.isSolo === updatedTrack.isSolo &&
            previousTrack.plugins.length === updatedTrack.plugins.length;

        const isPanOnlyChange = previousTrack.pan !== updatedTrack.pan &&
            previousTrack.volume === updatedTrack.volume &&
            previousTrack.isMuted === updatedTrack.isMuted &&
            previousTrack.isSolo === updatedTrack.isSolo &&
            previousTrack.plugins.length === updatedTrack.plugins.length;

        if (isVolumeOnlyChange || isPanOnlyChange) {
            // Use atomic methods for better performance
            if (isVolumeOnlyChange) {
                audioEngine.setTrackVolume(updatedTrack.id, updatedTrack.volume, updatedTrack.isMuted);
            }
            if (isPanOnlyChange) {
                audioEngine.setTrackPan(updatedTrack.id, updatedTrack.pan);
            }
            // Set flag to skip full graph rebuild in useEffect
            skipEngineUpdateRef.current = true;
        }
    }

    setState(produce(draft => {
        const trackIndex = draft.tracks.findIndex(t => t.id === updatedTrack.id);
        if (trackIndex !== -1) {
            draft.tracks[trackIndex] = updatedTrack;
        }
    }));
  }, [setState]);

  const handleUpdatePluginParams = useCallback((trackId: string, pluginId: string, params: Record<string, any>) => {
    setState(produce((draft: DAWState) => {
      const track = draft.tracks.find(t => t.id === trackId);
      if (track) {
          const plugin = track.plugins.find(p => p.id === pluginId);
          if (plugin) plugin.params = { ...plugin.params, ...params };
      }
    }));
    const pluginNode = audioEngine.getPluginNodeInstance(trackId, pluginId);
    if (pluginNode && pluginNode.updateParams) { pluginNode.updateParams(params); }
  }, [setState]);

  const handleSeek = useCallback((time: number) => { 
    // Pendant une prise, déplacer la lecture la désynchroniserait.
    if (stateRef.current.isRecording) return;
    setVisualState({ currentTime: time });
    audioEngine.seekTo(time, stateRef.current.tracks, stateRef.current.isPlaying);
    // Le clic doit repartir sur la grille a la nouvelle position.
    if (stateRef.current.isPlaying && stateRef.current.metronome.enabled) {
      metronomeService.stop();
      metronomeService.start(time);
    }
  }, [setVisualState]);
  
  const handleTogglePlay = useCallback(async () => {
      // Pendant une prise, Lecture / Espace la terminent (sinon la lecture
      // redémarrait alors que l'enregistreur continuait : prise décalée).
      if (stateRef.current.isRecording) { await toggleRecordRef.current?.(); return; }
      await ensureAudioEngine();
      if (stateRef.current.isPlaying) {
        audioEngine.stopAll();
        setVisualState({ isPlaying: false });
      } else {
        audioEngine.startPlayback(stateRef.current.currentTime, stateRef.current.tracks);
        setVisualState({ isPlaying: true });
      }
  }, [setVisualState]);

  /**
   * Récupère la prise en cours et l'ajoute à la piste armée :
   * - nommée « Prise N » ;
   * - les anciennes prises qu'elle recouvre sont coupées (mute), sinon une
   *   nouvelle prise doublait la voix ;
   * - blancs retirés si le nettoyage auto est actif (non destructif).
   */
  const finalizeRecording = useCallback(async () => {
    const result = await audioEngine.stopRecording();
    let cleaned: StripSilenceResult | null = null;
    let takeName = '';
    let mutedOld = 0;
    let takeGain = 1;
    let takeGainDb = 0;
    if (result && result.clip.buffer) {
      const track = stateRef.current.tracks.find(t => t.id === result.trackId);
      const takeNumber = 1 + (track?.clips || []).reduce((max, c) => {
        const m = /^Prise (\d+)/.exec(c.name || '');
        return m ? Math.max(max, parseInt(m[1], 10)) : max;
      }, 0);
      takeName = `Prise ${takeNumber}`;
      result.clip.name = takeName;
      if (autoCleanRef.current) {
        cleaned = stripSilenceFromClip({ ...result.clip, bufferId: result.clip.id }, result.clip.buffer);
      }
      // Niveau automatique : qu'on chante fort ou doucement, chaque prise arrive
      // au même niveau dans le mix (-20 dBFS moyen sur la voix), sans saturer.
      const lv = takeStats(result.clip.buffer);
      if (!lv.silent && lv.rmsDb > -60) {
        let g = -20 - lv.rmsDb;
        g = Math.min(g, -1 - lv.peakDb);          // jamais au-dessus de -1 dBFS en crête
        g = Math.max(-6, Math.min(12, g));
        if (Math.abs(g) >= 1) { takeGain = Math.pow(10, g / 20); takeGainDb = g; }
      }
    }
    setState(produce(draft => {
      draft.isRecording = false;
      draft.recStartTime = null;
      if (result && result.clip.buffer) {
        const clip = result.clip;
        const clipId = clip.id;
        audioBufferRegistry.registerWithUrl(clip.buffer, clip.audioRef!, clipId);

        const toStore = (c: Clip): Clip => { const x: Clip = { ...c, bufferId: clipId, gain: (c.gain ?? 1) * takeGain }; delete x.buffer; return x; };
        const track = draft.tracks.find(t => t.id === result.trackId);
        if (track) {
          const takeStart = clip.start;
          const takeEnd = clip.start + clip.duration;
          track.clips.forEach(c => {
            if (!c.isMuted && c.start < takeEnd && c.start + c.duration > takeStart) { c.isMuted = true; mutedOld++; }
          });
          if (cleaned) track.clips.push(...cleaned.clips.map(toStore));
          else track.clips.push(toStore(clip));
        }
      }
    }));
    if (result && result.clip.buffer) {
      const parts: string[] = [`🎤 ${takeName} enregistrée`];
      if (cleaned) parts.push(`${cleaned.removedSec.toFixed(1)} s de blanc retirées`);
      if (takeGainDb) parts.push(`niveau ajusté (${takeGainDb > 0 ? '+' : ''}${Math.round(takeGainDb)} dB)`);
      if (mutedOld) parts.push(`l'ancienne prise est coupée`);
      parts.push('▶ pour l\'écouter · Annuler pour revenir');
      setAiNotification(parts.join(' — '));
      const buf = result.clip.buffer;
      const start = result.clip.start;
      setTimeout(() => coachAfterTakeRef.current?.(result.trackId, buf, takeName, start), 120);
    }
    return result;
  }, [setState]);

  /** Retire les blancs d'un clip, ou de tous les clips audio d'une piste. */
  const handleCleanSilences = useCallback((trackId: string, clipId?: string) => {
    const track = stateRef.current.tracks.find(t => t.id === trackId);
    if (!track) return;
    let removed = 0;
    let touched = 0;
    const next: Clip[] = [];
    for (const c of track.clips) {
      const target = c.type === TrackType.AUDIO && (!clipId || c.id === clipId);
      const buf = target ? (c.bufferId ? audioBufferRegistry.get(c.bufferId) : c.buffer) : undefined;
      const res = buf ? stripSilenceFromClip(c, buf) : null;
      if (res) { next.push(...res.clips); removed += res.removedSec; touched++; }
      else next.push(c);
    }
    if (!touched) {
      setAiNotification('🧹 Aucun blanc à retirer ici');
      return;
    }
    setState(produce((draft: DAWState) => {
      const tr = draft.tracks.find(t => t.id === trackId);
      if (tr) tr.clips = next as any;
    }));
    setAiNotification(`🧹 ${removed.toFixed(1)} s de blanc retirées sur ${track.name} (Annuler pour revenir)`);
  }, [setState]);

  /**
   * Mix automatique : applique un style (chaîne d'effets, envois, équilibre
   * voix / beat) à toutes les pistes voix. L'Auto-Tune reçoit la tonalité du
   * beat quand elle est connue, sinon il corrige en chromatique.
   */
  const handleApplyMixStyle = useCallback((styleId: string): boolean => {
    const style = findVocalMixStyle(styleId);
    if (!style) {
      setAiNotification(`Style « ${styleId} » inconnu`);
      return false;
    }
    const st = stateRef.current;
    const keyKnown = typeof st.projectKey === 'number' && !!st.projectScale;
    let voiceTracks = 0;
    const sideCount: Record<string, number> = {};
    setState(produce((draft: DAWState) => {
      draft.vocalMixStyle = style.id;
      draft.tracks.forEach(t => {
        if (t.id === 'instrumental') { t.volume = style.beatVolume; return; }
        if (t.type !== TrackType.AUDIO || t.instrumentId) return;
        voiceTracks++;
        // Comme un ingé son : le lead devant et au centre, les voix secondaires
        // plus basses, ouvertes à gauche / à droite et un peu plus « loin ».
        const role = getVocalRole(t as Track);
        const rmRole = role === 'back' || role === 'harmony' || role === 'adlib' ? role : 'lead';
        const rm = ROLE_MIX[rmRole];
        const side = rmRole === 'lead' ? 0 : ((sideCount[rmRole] = (sideCount[rmRole] || 0) + 1) % 2 === 1 ? -1 : 1);
        t.volume = Math.round(style.voiceVolume * rm.volume * 100) / 100;
        t.pan = side * rm.pan;
        t.plugins = style.chain.map(item => {
          const extra = item.type === 'AUTOTUNE'
            ? { rootKey: keyKnown ? st.projectKey : 0, scale: keyKnown ? st.projectScale : 'CHROMATIC' }
            : {};
          // Copie profonde : les réglages du style ne doivent jamais être partagés avec l'état (gelé par Immer).
          const pl = createDefaultPlugins(item.type, item.params.mix ?? 0.3, st.bpm, { ...structuredClone(item.params), ...extra });
          if (item.type === 'PROEQ12' && rm.highpass && pl.params.bands?.[0]) {
            pl.params.bands[0].frequency = Math.max(pl.params.bands[0].frequency, rm.highpass);
          }
          return pl;
        }) as any;
        const fx = style.id === 'voix-brute' ? 0 : 1;
        const levels: Record<string, number> = {
          'send-delay': Math.min(1, style.sends.delay + fx * rm.delayAdd),
          'send-verb-short': Math.min(1, style.sends.verbShort + fx * rm.verbAdd),
          'send-verb-long': style.sends.verbLong,
        };
        Object.entries(levels).forEach(([id, level]) => {
          const s = t.sends.find(x => x.id === id);
          if (s) { s.level = level; s.isEnabled = true; }
          else if (draft.tracks.some(x => x.id === id)) t.sends.push({ id, level, isEnabled: true });
        });
      });
    }));
    setAiNotification(`${style.emoji} Mix « ${style.name} » appliqué sur tes pistes voix — Annuler pour revenir`);
    return true;
  }, [setState]);

  // Panneau « Outils voix » (styles de mix, nettoyage, options d'enregistrement)
  const [vocalToolsOpen, setVocalToolsOpen] = useState(false);
  // Incrémenté pour que Nova ouvre le chat et propose les styles de mix.
  const [mixGuideRequest, setMixGuideRequest] = useState(0);

  /** Piste voix visée par les outils : la sélectionnée, sinon la première avec des prises. */
  const getTargetVoiceTrack = (): Track | undefined => {
    const st = stateRef.current;
    const isVoice = (t?: Track) => !!t && t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;
    const sel = st.tracks.find(t => t.id === st.selectedTrackId);
    if (isVoice(sel) && sel!.clips.length) return sel;
    return st.tracks.find(t => isVoice(t) && t.clips.length > 0) || (isVoice(sel) ? sel : undefined);
  };

  // Début de la dernière prise : à l'arrêt on y revient, pour la réécouter.
  const recStartRef = useRef<number | null>(null);

  /** Piste où l'on peut enregistrer une voix (pas le beat, pas un bus/send). */
  const isVoiceTrack = (t?: Track | null): t is Track =>
    !!t && t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;

  /** Arme une piste voix (une seule à la fois) ; false si le micro est inaccessible. */
  const armForRecording = useCallback(async (trackId: string): Promise<boolean> => {
    setState(produce(draft => {
      draft.tracks.forEach(t => { t.isTrackArmed = t.id === trackId; });
      draft.selectedTrackId = trackId;
    }));
    const erreur = await audioEngine.armTrack(trackId);
    if (erreur) {
      setAiNotification(`🎤 ${erreur}`);
      setState(produce(draft => {
        const t = draft.tracks.find(x => x.id === trackId);
        if (t) t.isTrackArmed = false;
      }));
      return false;
    }
    return true;
  }, [setState]);

  /**
   * L'ingé son prépare la partie suivante de la session : choisit (ou crée) la
   * bonne piste, l'arme, se cale sur le début du lead et briefe l'artiste.
   */
  const prepareSessionPart = useCallback(async (part: SessionPart) => {
    await ensureAudioEngine();
    let track = findTrackForRole(stateRef.current.tracks, part);
    if (!track) {
      const id = `track-${part}-${Date.now()}`;
      const st = stateRef.current;
      const leadT = findTrackForRole(st.tracks, 'lead');
      const rm = ROLE_MIX[part];
      const color = part === 'harmony' ? '#ec4899' : part === 'adlib' ? '#f97316' : '#a855f7';
      setState(produce((draft: DAWState) => {
        const leadD = draft.tracks.find(t => t.id === leadT?.id);
        const newTrack: Track = {
          id, name: SESSION_TRACK_NAME[part], type: TrackType.AUDIO, color,
          isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
          volume: rm.volume, pan: -rm.pan,
          outputTrackId: draft.tracks.some(t => t.id === 'bus-vox') ? 'bus-vox' : 'master',
          // Même traitement que le lead (style de mix), envois compris.
          sends: leadD ? leadD.sends.map(s => ({ ...s })) : [],
          clips: [],
          plugins: leadD ? leadD.plugins.map(p => ({ ...JSON.parse(JSON.stringify(p)), id: `pl-${Date.now()}-${Math.random()}` })) : [],
          automationLanes: [createDefaultAutomation('volume', color)],
          totalLatency: 0,
        };
        let idx = -1;
        draft.tracks.forEach((t, i) => { if (t.type === TrackType.AUDIO && !t.instrumentId) idx = i; });
        draft.tracks.splice(idx + 1, 0, newTrack);
      }));
      await new Promise(r => setTimeout(r, 80));
      track = stateRef.current.tracks.find(t => t.id === id);
    }
    if (!track) return;
    setSessionPart(part);
    const leadT = findTrackForRole(stateRef.current.tracks, 'lead');
    const leadClips = leadT?.clips.filter(c => !c.isMuted) || [];
    const leadStart = part !== 'lead' && leadClips.length ? Math.min(...leadClips.map(c => c.start)) : null;
    if (leadStart !== null) handleSeek(Math.max(0, leadStart - 2));
    const ok = await armForRecording(track.id);
    if (!ok) return;
    postNova(SESSION_BRIEF[part].replace('{piste}', track.name), [
      { label: '🔴 Lancer la prise', action: { action: 'RECORD', payload: {} } },
      ...(leadStart !== null ? [{ label: '▶ Réécouter mon lead', actions: [{ action: 'SEEK', payload: { time: leadStart } }, { action: 'PLAY', payload: {} }] as AIAction[] }] : []),
    ]);
    if (!isMobileRef.current) novaSpotlight('rec', 'Appuie ici quand tu es prêt', 5000);
  }, [setState, handleSeek, armForRecording, postNova]);

  /** Étape suivante de la session après une prise (bouton « continuer quand même »). */
  const suiteSession = (role: VocalRole): NonNullable<NovaFeedMessage['choices']> => {
    if (role === 'lead') return [{ label: '➡️ Continuer : les backs', action: { action: 'PREPARE_PART', payload: { part: 'back' } } }];
    if (role === 'back') return [{ label: '➡️ Continuer : harmonies', action: { action: 'PREPARE_PART', payload: { part: 'harmony' } } }];
    return [{ label: '🎧 Écoute mon mix', action: { action: 'ANALYZE_MIX', payload: {} } }];
  };

  /** Bilan de l'ingé son juste après une prise, avec la suite de la session. */
  coachAfterTakeRef.current = (trackId, buffer, takeName, start) => {
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (!t) return;
    const role = getVocalRole(t);
    const s = takeStats(buffer);
    const replay = { label: '▶ Réécouter', actions: [{ action: 'SEEK', payload: { time: start } }, { action: 'PLAY', payload: {} }] as AIAction[] };
    const redo = { label: '🔁 Refaire', actions: [{ action: 'SEEK', payload: { time: start } }, { action: 'RECORD', payload: {} }] as AIAction[] };
    if (s.silent || s.rmsDb < -50) {
      postNova(audioEngine.isUsingASIOInput()
        ? `🤔 ${takeName} : je n'ai presque rien reçu de la carte son. Vérifie que le micro est sur la bonne entrée (Engine → Entrée du micro), que le gain de la carte est monté et, pour un micro statique, que l'48 V est activé.`
        : `🤔 ${takeName} : je n'ai presque rien entendu. Vérifie que ton micro est branché et autorisé, puis rapproche-toi.`, [redo]);
      return;
    }
    // Première prise du lead : style appliqué même si la prise est à refaire,
    // pour que l'artiste entende tout de suite le rendu « produit ».
    let autoStyleNote = '';
    if (role === 'lead' && !stateRef.current.vocalMixStyle && (s.peakDb > -0.3 || s.rmsDb < -38)) {
      const sid = suggestVocalMixStyle(stateRef.current.bpm, stateRef.current.beatGenre, stateRef.current.beatTitle);
      handleApplyMixStyle(sid);
      autoStyleNote = ` J'ai quand même mis le style « ${findVocalMixStyle(sid)?.name} » pour que tu entendes le rendu.`;
    }
    if (s.peakDb > -0.3) {
      postNova(`⚠️ ${takeName} sature par moments (ça grésille, ça ne se rattrape pas au mix). Recule d'une main du micro ou chante un peu moins fort, et refais-la.${autoStyleNote}`, [replay, redo, ...suiteSession(role)]);
      return;
    }
    if (s.rmsDb < -38) {
      postNova(`🔉 ${takeName} est très faible : rapproche-toi du micro (une main de distance). Remontée au mix, elle ramènerait du souffle.${autoStyleNote}`, [replay, redo, ...suiteSession(role)]);
      return;
    }
    // Voix secondaire posée avec les réglages d'origine : on la place comme un ingé son.
    let placed = '';
    if (role !== 'lead' && role !== 'beat' && role !== 'other' && t.volume === 1 && t.pan === 0) {
      const rm = ROLE_MIX[role];
      handleUpdateTrack({ ...t, volume: rm.volume, pan: -rm.pan });
      placed = ` Je l'ai baissée (${Math.round(rm.volume * 100)} %) et décalée à gauche pour qu'elle soutienne ton lead sans le couvrir.`;
    }
    const st = stateRef.current;
    const next: NovaFeedMessage['choices'] = [replay];
    let text = `✅ ${takeName} : bon niveau, prise propre.${placed}`;
    if (role === 'lead' && !st.vocalMixStyle) {
      // Première prise : on fait entendre tout de suite une voix « produite ».
      const sid = suggestVocalMixStyle(st.bpm, st.beatGenre, st.beatTitle);
      handleApplyMixStyle(sid);
      const style = findVocalMixStyle(sid);
      text += ` Pour que tu entendes ta voix comme sur un vrai son, j'ai mis le style « ${style?.name} », adapté à ce beat. Réécoute ! Tu peux en essayer un autre, ou passer aux backs.`;
      const replayMix = { label: '▶ Réécouter avec le mix', actions: [{ action: 'SEEK', payload: { time: start } }, { action: 'PLAY', payload: {} }] as AIAction[] };
      next.splice(0, next.length, replayMix);
      VOCAL_MIX_STYLES.filter(s => s.id !== sid && s.id !== 'voix-brute').slice(0, 3)
        .forEach(s => next.push({ label: `${s.emoji} ${s.name}`, action: { action: 'APPLY_MIX_STYLE', payload: { style: s.id } } }));
      next.push(redo, { label: '➡️ Faire les backs', action: { action: 'PREPARE_PART', payload: { part: 'back' } } });
    } else if (role === 'lead') {
      text += " Réécoute-la. Si elle te va, on passe aux backs pour appuyer tes fins de phrase ; sinon refais-en une, l'ancienne est gardée (coupée).";
      next.push(redo, { label: '➡️ Faire les backs', action: { action: 'PREPARE_PART', payload: { part: 'back' } } });
    } else if (role === 'back') {
      text += ' On ajoute des harmonies au refrain, des ad-libs, ou j\'écoute ton mix ?';
      next.push({ label: '➡️ Harmonies', action: { action: 'PREPARE_PART', payload: { part: 'harmony' } } },
        { label: '➡️ Ad-libs', action: { action: 'PREPARE_PART', payload: { part: 'adlib' } } },
        { label: '🎧 Écoute mon mix', action: { action: 'ANALYZE_MIX', payload: {} } });
    } else if (role === 'harmony') {
      text += ' Des ad-libs pour finir, ou j\'écoute ton mix ?';
      next.push({ label: '➡️ Ad-libs', action: { action: 'PREPARE_PART', payload: { part: 'adlib' } } },
        { label: '🎧 Écoute mon mix', action: { action: 'ANALYZE_MIX', payload: {} } });
    } else {
      next.push(redo, { label: '🎧 Écoute mon mix', action: { action: 'ANALYZE_MIX', payload: {} } });
    }
    postNova(text, next);
  };

  /** Nova « écoute » le mix et donne ses retours d'ingé son, réglage par réglage. */
  const handleAnalyzeMix = useCallback(() => {
    const st = stateRef.current;
    const report = analyseMix(
      st.tracks,
      c => (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined) || c.buffer || audioEngine.getAudioBuffer(c.id),
      st.vocalMixStyle
    );
    postNova(report.summary);
    // Après les conseils : la suite logique pour un rendu pro.
    setTimeout(() => {
      const beat = getCatalogBeat(stateRef.current.tracks);
      postNova("🎧 Le mix auto te donne un bon aperçu. Pour un son prêt à sortir, nos ingés son peuvent mixer ta voix sur l'instru." + (beat ? ` Et pour l'utiliser, il te faut la licence de « ${beat.title} ».` : ""), [
        { label: "🎚️ Faire mixer par un pro", action: { action: "OPEN_STUDIO_OFFER", payload: { offer: "mix" } } },
        { label: "🎙️ L'enregistrer au studio", action: { action: "OPEN_STUDIO_OFFER", payload: { offer: "session" } } },
        { label: "📲 Partager un extrait", action: { action: "OPEN_SHARE", payload: {} } },
        ...(beat ? [{ label: "🛒 Acheter cette instru", action: { action: "OPEN_STUDIO_OFFER", payload: { offer: "beat" } } as AIAction }] : []),
      ]);
    }, 400);
    report.issues.slice(0, 4).forEach(iss => {
      const icon = iss.severity === 'bad' ? '🔴' : iss.severity === 'warn' ? '🟠' : '💡';
      postNova(`${icon} ${iss.title}. ${iss.detail}`, [
        ...(iss.target ? [{ label: '👉 Montre-moi', action: { action: 'HIGHLIGHT', payload: { target: iss.target, text: iss.spotlightText } } as AIAction }] : []),
        ...(iss.fix ? [{ label: `✅ ${iss.fix.label}`, actions: iss.fix.actions }] : []),
      ]);
    });
    // Plusieurs corrections possibles : un seul geste pour tout appliquer.
    const allFixes = report.issues.filter(i => i.fix && i.fix.actions.every(a => a.action !== 'OPEN_MIX_STYLES')).flatMap(i => i.fix!.actions);
    if (allFixes.length > 1) {
      postNova("Je peux tout corriger d'un coup (Annuler pour revenir) :", [
        { label: '✨ Tout corriger', actions: allFixes },
      ]);
    }
    return report;
  }, [postNova]);

  // Décompte : 4 temps au tempo du beat avant que la prise démarre.
  const [countInBeat, setCountInBeat] = useState<number | null>(null);
  const countInCancelRef = useRef(false);
  const runCountIn = useCallback(async (bpm: number): Promise<boolean> => {
    const ctx = audioEngine.ctx;
    const beat = 60 / Math.max(40, Math.min(240, bpm || 120));
    countInCancelRef.current = false;
    if (ctx) {
      const t0 = ctx.currentTime + 0.05;
      for (let i = 0; i < 4; i++) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = i === 0 ? 1500 : 1000;
        g.gain.setValueAtTime(0.0001, t0 + i * beat);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + i * beat + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * beat + 0.08);
        // Par le master : le décompte sort aussi par la carte son en ASIO.
        osc.connect(g).connect(audioEngine.getMonitorBus() || ctx.destination);
        osc.start(t0 + i * beat);
        osc.stop(t0 + i * beat + 0.1);
      }
    }
    for (let i = 4; i >= 1; i--) {
      if (countInCancelRef.current) { setCountInBeat(null); return false; }
      setCountInBeat(i);
      await new Promise(r => setTimeout(r, beat * 1000));
    }
    setCountInBeat(null);
    return !countInCancelRef.current;
  }, []);

  // Casque : demandé une fois, avant la première prise. Avec casque on entend
  // sa voix (retour) ; sur haut-parleurs le retour reste coupé (larsen).
  const [headphonePromptOpen, setHeadphonePromptOpen] = useState(false);
  const toggleRecordRef = useRef<(() => Promise<void>) | null>(null);

  const handleToggleRecord = useCallback(async () => {
    await ensureAudioEngine();
    const currentState = stateRef.current;

    // Pendant le décompte : REC l'annule.
    if (countInBeat !== null) { countInCancelRef.current = true; return; }

    if (currentState.isRecording) {
        audioEngine.stopAll();
        metronomeService.stop();
        await finalizeRecording();
        // Retour au début de la prise : prêt à la réécouter.
        const back = recStartRef.current ?? stateRef.current.currentTime;
        audioEngine.seekTo(back, stateRef.current.tracks, false);
        setState(prev => ({ ...prev, isPlaying: false, currentTime: back }));
        return;
    }

    // Armement automatique : plus besoin de trouver le bouton R d'abord.
    let armedTrack = currentState.tracks.find(t => t.isTrackArmed);
    if (!armedTrack) {
      const selected = currentState.tracks.find(t => t.id === currentState.selectedTrackId);
      const target = isVoiceTrack(selected)
        ? selected
        : currentState.tracks.find(t => t.id === 'track-rec-main') ?? currentState.tracks.find(t => isVoiceTrack(t));
      if (!target) {
        setNoArmedTrackError(true);
        setTimeout(() => setNoArmedTrackError(false), 2000);
        return;
      }
      if (!(await armForRecording(target.id))) return;
      armedTrack = target;
    }

    // Première prise : question casque (la prise repart après la réponse).
    let headphonesAsked = false;
    try { headphonesAsked = localStorage.getItem('nova_headphones') !== null; } catch { headphonesAsked = true; }
    if (!headphonesAsked) { setHeadphonePromptOpen(true); return; }

    // Décompte (désactivable).
    let countIn = true;
    try { countIn = localStorage.getItem('nova_count_in') !== '0'; } catch { /* défaut : oui */ }
    if (countIn && !(await runCountIn(currentState.bpm))) return;

    const startAt = stateRef.current.currentTime;
    const success = await audioEngine.startRecording(startAt, armedTrack.id);
    if (success) {
      recStartRef.current = startAt;
      audioEngine.startPlayback(startAt, stateRef.current.tracks);
      setState(produce(draft => {
        draft.isRecording = true;
        draft.isPlaying = true;
        draft.recStartTime = draft.currentTime;
      }));
    } else {
      setAiNotification("🎤 L'enregistrement n'a pas pu démarrer. Vérifie que le micro est autorisé, puis réessaie.");
    }
  }, [setState, finalizeRecording, armForRecording, runCountIn, countInBeat]);
  toggleRecordRef.current = handleToggleRecord;

  const answerHeadphones = useCallback((hasHeadphones: boolean) => {
    try { localStorage.setItem('nova_headphones', hasHeadphones ? '1' : '0'); } catch { /* stockage indisponible */ }
    audioEngine.setInputMonitoring(hasHeadphones);
    setInputMonitoringState(hasHeadphones);
    setHeadphonePromptOpen(false);
    // On enchaîne sur la prise demandée.
    setTimeout(() => { void toggleRecordRef.current?.(); }, 50);
  }, []);

  const handleStop = useCallback(async () => {
    countInCancelRef.current = true;
    metronomeService.stop();
    const wasRecording = stateRef.current.isRecording;
    audioEngine.stopAll();
    // STOP pendant un enregistrement conserve la prise et revient à son début.
    if (wasRecording) {
      await finalizeRecording();
      const back = recStartRef.current ?? 0;
      audioEngine.seekTo(back, stateRef.current.tracks, false);
      setState(prev => ({ ...prev, isPlaying: false, currentTime: back, isRecording: false }));
      return;
    }
    audioEngine.seekTo(0, stateRef.current.tracks, false);
    setState(prev => ({ ...prev, isPlaying: false, currentTime: 0, isRecording: false }));
  }, [setState, finalizeRecording]);

  const handleDuplicateTrack = useCallback((trackId: string) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === trackId);
        if (!track) return;
        
        const newTrack: Track = {
            ...track,
            id: `track-${Date.now()}`,
            name: `${track.name} (Copy)`,
            clips: track.clips.map(clip => ({
                ...clip,
                id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            })),
            plugins: track.plugins.map(plugin => ({
                ...plugin,
                id: `plugin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            })),
            automationLanes: [],
            // La copie ne fait pas partie du groupe de l'originale.
            groupId: undefined
        };
        
        const index = draft.tracks.findIndex(t => t.id === trackId);
        draft.tracks.splice(index + 1, 0, newTrack);
    }));
  }, [setState]);

  const handleCreateTrack = useCallback((type: TrackType, name?: string, initialPluginType?: PluginType) => {
      setState(produce((draft: DAWState) => {
          let drumPads: DrumPad[] | undefined = undefined;
          if (type === TrackType.DRUM_RACK) {
              drumPads = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Pad ${i + 1}`, sampleName: 'Empty', volume: 0.8, pan: 0, isMuted: false, isSolo: false, midiNote: 60 + i }));
          }
          const plugins: PluginInstance[] = [];
          if (initialPluginType) { plugins.push(createDefaultPlugins(initialPluginType, 1.0, draft.bpm)); }
          const newTrack: Track = {
              id: `track-${Date.now()}`, name: name || `${type} TRACK`, type, color: UI_CONFIG.TRACK_COLORS[draft.tracks.length % UI_CONFIG.TRACK_COLORS.length], isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1.0, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins, automationLanes: [], totalLatency: 0, drumPads
          };
          draft.tracks.push(newTrack);
      }));
  }, [setState]);

  const handleDeleteTrack = useCallback((trackId: string) => {
    if (trackId === 'track-rec-main') {
        console.warn("La piste d'enregistrement principale ne peut pas être supprimée.");
        setAiNotification(`⚠️ La piste "REC" est protégée et ne peut être supprimée.`);
        setTimeout(() => setAiNotification(null), 3000);
        return;
    }

    // Clean up audio buffers before deleting track to prevent memory leaks
    const track = stateRef.current.tracks.find(t => t.id === trackId);
    if (track) {
        const removedClipIds = track.clips.map(c => c.id);
        const bufferIds = track.clips.map(c => c.bufferId).filter(Boolean) as string[];
        // Apres la mise a jour du state, on ne libere que les buffers devenus orphelins.
        setTimeout(() => bufferIds.forEach(id => releaseBufferIfUnused(id, removedClipIds)), 0);
    }

    // Libere la chaine audio : sans ca la piste supprimee restait cablee a sa
    // destination et continuait de sonner (queues de reverb, bus d'effets...).
    audioEngine.disposeTrack(trackId);

    setState(produce((draft: DAWState) => {
        const trackIndex = draft.tracks.findIndex(t => t.id === trackId);
        if (trackIndex > -1) {
            draft.tracks.splice(trackIndex, 1);
            if (draft.selectedTrackId === trackId) {
                draft.selectedTrackId = draft.tracks[0]?.id || null;
            }
        }

        // Nettoyage des references orphelines vers la piste supprimee.
        draft.tracks.forEach(t => {
            if (t.outputTrackId === trackId) t.outputTrackId = 'master';
            if (t.sends) t.sends = t.sends.filter(sd => sd.id !== trackId);
        });
        draft.trackGroups = draft.trackGroups
            .map(g => ({ ...g, trackIds: g.trackIds.filter(id => id !== trackId) }))
            .filter(g => g.trackIds.length > 1);
    }));
  }, [setState]);
  
  const handleRemovePlugin = useCallback((tid: string, pid: string) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === tid);
        if (!track) return;
        
        const index = track.plugins.findIndex(p => p.id === pid);
        if (index !== -1) {
            track.plugins.splice(index, 1);
        }
    }));
    
    if (activePlugin?.plugin.id === pid) {
        setActivePlugin(null);
    }
  }, [setState, activePlugin]);
  
  const handleAddPluginFromContext = useCallback(async (tid: string, type: PluginType, metadata?: any, options?: { openUI: boolean }) => {
    // L'AutoTune s'accorde d'office sur la tonalite du projet, deduite de
    // l'instrumental charge. Sans ca il demarrait en do chromatique.
    let reglages = metadata;
    if (type === 'AUTOTUNE' && stateRef.current.projectKey !== undefined) {
      reglages = {
        ...(metadata || {}),
        rootKey: stateRef.current.projectKey,
        scale: stateRef.current.projectScale || 'MINOR'
      };
    }
    const newPlugin = createDefaultPlugins(type, 0.5, stateRef.current.bpm, reglages);

    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === tid);
        if (track) {
            track.plugins.push(newPlugin);
        }
    }));

    // Visual feedback for user
    const pluginName = metadata?.name || type;
    setAiNotification(`✅ Plugin "${pluginName}" ajouté avec succès`);
    setTimeout(() => setAiNotification(null), 2000);

    if (options?.openUI) {
        await ensureAudioEngine();
        setTimeout(() => {
            setActivePlugin({ trackId: tid, plugin: newPlugin });
        }, 50);
    }
  }, [setState]);

  // ANCIEN SYSTÈME D'IMPORT SUPPRIMÉ - Remplacé par handleNewAudioImport

  // ✨ NOUVEAU SYSTÈME D'IMPORT AUDIO - Simple et fiable
  const handleNewAudioImport = useCallback(async (file: File) => {
    try {
      // 1. Initialiser l'audio engine
      await ensureAudioEngine();
      if (!audioEngine.ctx) {
        alert('❌ Erreur: Audio engine non initialisé');
        return;
      }

      // 2. Lire le fichier audio
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioEngine.ctx.decodeAudioData(arrayBuffer);

      // 3. Créer un clip ID unique
      const clipId = `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const audioRef = URL.createObjectURL(file);

      // 4. Enregistrer dans le registry
      audioBufferRegistry.registerWithUrl(audioBuffer, audioRef, clipId);

      // 5. Créer le clip
      const newClip: Clip = {
        id: clipId,
        name: file.name.replace(/\.[^/.]+$/, ''),
        type: TrackType.AUDIO,
        start: stateRef.current.currentTime,
        duration: audioBuffer.duration,
        offset: 0,
        bufferId: clipId,
        audioRef,
        color: '#3b82f6',
        fadeIn: 0,
        fadeOut: 0,
        gain: 1.0,
        isMuted: false
      };

      // 6. Créer une nouvelle piste audio et ajouter le clip
      setState(produce((draft: DAWState) => {
        const trackId = `track-${Date.now()}`;
        const newTrack: Track = {
          id: trackId,
          name: file.name.substring(0, 20),
          type: TrackType.AUDIO,
          color: UI_CONFIG.TRACK_COLORS[draft.tracks.length % UI_CONFIG.TRACK_COLORS.length],
          isMuted: false,
          isSolo: false,
          isTrackArmed: false,
          isFrozen: false,
          volume: 1.0,
          pan: 0,
          outputTrackId: 'master',
          sends: [],
          clips: [newClip],
          plugins: [],
          automationLanes: [],
          totalLatency: 0
        };

        // Insérer la nouvelle piste juste après la piste master (position 1)
        draft.tracks.splice(1, 0, newTrack);
        draft.selectedTrackId = trackId;
      }));

      console.log(`✅ [Import] Fichier importé: ${file.name} (${audioBuffer.duration.toFixed(2)}s)`);
      alert(`✅ Importé: ${file.name}`);

    } catch (error: any) {
      console.error('❌ [Import Error]', error);
      alert(`❌ Erreur d'import: ${error.message || 'Fichier non valide'}`);
    }
  }, [setState]);

  const handleMoveClip = useCallback((sourceTrackId: string, destTrackId: string, clipId: string) => {
    setState(produce((draft: DAWState) => {
        const sourceTrack = draft.tracks.find(t => t.id === sourceTrackId);
        const destTrack = draft.tracks.find(t => t.id === destTrackId);
        if (!sourceTrack || !destTrack) return;
        
        const clipIndex = sourceTrack.clips.findIndex(c => c.id === clipId);
        if (clipIndex === -1) return;
        
        const [clip] = sourceTrack.clips.splice(clipIndex, 1);
        destTrack.clips.push(clip);
    }));
  }, [setState]);
  /** Deplace la piste source juste avant la piste de destination. */
  /**
   * Decale d'un meme delta un ensemble de clips (deplacement d'une selection
   * multiple). Une seule mise a jour d'etat pour tout le groupe : sinon chaque
   * clip declenchait son propre rendu et sa propre entree d'historique.
   */
  const handleMoveClipsBy = useCallback((items: {trackId:string, clipId:string, start:number}[], delta: number) => {
    if (!items.length) return;
    setState(produce((draft: DAWState) => {
      items.forEach(it => {
        const track = draft.tracks.find(t => t.id === it.trackId);
        const clip = track?.clips.find(c => c.id === it.clipId);
        if (clip) clip.start = Math.max(0, it.start + delta);
      });
    }));
  }, [setState]);

  const handleReorderTracks = useCallback((sourceTrackId: string, destTrackId: string) => {
    if (sourceTrackId === destTrackId) return;
    setState(produce(draft => {
      const from = draft.tracks.findIndex(t => t.id === sourceTrackId);
      if (from === -1) return;
      const [moved] = draft.tracks.splice(from, 1);
      const to = draft.tracks.findIndex(t => t.id === destTrackId);
      if (to === -1) { draft.tracks.splice(from, 0, moved); return; }
      draft.tracks.splice(to, 0, moved);
    }));
  }, [setState]);

  /**
   * Gele / degele une piste : rend son audio avec ses effets, puis lit ce rendu
   * a la place de la chaine complete (economie de CPU). Les clips et plugins
   * d'origine ne sont jamais supprimes, degeler les reactive tels quels.
   */
  const handleFreezeTrack = useCallback(async (trackId: string) => {
    const track = stateRef.current.tracks.find(t => t.id === trackId);
    if (!track) return;

    if (track.isFrozen) {
      let frozenBufferId: string | undefined;
      setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(tr => tr.id === trackId);
        if (!t) return;
        frozenBufferId = t.frozenClip?.bufferId;
        t.isFrozen = false;
        delete t.frozenClip;
      }));
      if (frozenBufferId) setTimeout(() => releaseBufferIfUnused(frozenBufferId, []), 0);
      setAiNotification(`🔥 "${track.name}" dégelée`);
      setTimeout(() => setAiNotification(null), 2500);
      return;
    }

    const trackEnd = track.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
    if (trackEnd <= 0) {
      setAiNotification("⚠️ Rien à geler sur cette piste");
      setTimeout(() => setAiNotification(null), 2500);
      return;
    }

    await ensureAudioEngine();
    setAiNotification(`❄️ Gel de "${track.name}"...`);
    try {
      // On rend la piste seule, sans son bus ni ses departs : le gel ne fige
      // que ce que la piste produit elle-meme.
      const isolated: Track = { ...track, isFrozen: false, outputTrackId: '', sends: [], isMuted: false, isSolo: false };
      const buffer = await audioEngine.renderProject([isolated], trackEnd, 0, 44100);
      const clipId = `frozen-${trackId}-${Date.now()}`;
      audioBufferRegistry.register(buffer, clipId);

      setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(tr => tr.id === trackId);
        if (!t) return;
        t.isFrozen = true;
        t.frozenClip = {
          id: clipId,
          start: 0,
          duration: trackEnd,
          offset: 0,
          fadeIn: 0,
          fadeOut: 0,
          name: `${t.name} (frozen)`,
          color: t.color,
          type: TrackType.AUDIO,
          bufferId: clipId,
          isMuted: false,
          gain: 1
        };
      }));
      setAiNotification(`❄️ "${track.name}" gelée`);
    } catch (e: any) {
      console.error('[Freeze]', e);
      setAiNotification(`❌ Gel impossible : ${e?.message || 'erreur'}`);
    } finally {
      setTimeout(() => setAiNotification(null), 2500);
    }
  }, [setState]);

  /** Cree un clip MIDI vide sur une piste instrument et ouvre le piano roll. */
  const handleCreatePatternAndOpen = useCallback((trackId: string, time: number) => {
    const track = stateRef.current.tracks.find(t => t.id === trackId);
    if (!track) return;
    const barDuration = (60 / stateRef.current.bpm) * 4; // 1 mesure en 4/4
    const clipId = `clip-midi-${Date.now()}`;
    setState(produce((draft: DAWState) => {
      const t = draft.tracks.find(tr => tr.id === trackId);
      if (!t) return;
      t.clips.push({
        id: clipId,
        start: Math.max(0, time),
        duration: barDuration,
        offset: 0,
        fadeIn: 0,
        fadeOut: 0,
        name: 'Pattern',
        color: t.color,
        type: TrackType.MIDI,
        notes: [],
        isMuted: false,
        gain: 1
      });
      draft.selectedTrackId = trackId;
    }));
    setMidiEditorOpen({ trackId, clipId });
  }, [setState]);

  /** Ouvre le navigateur d'instruments sur la piste concernee. */
  const handleSwapInstrument = useCallback((trackId: string) => {
    setState(prev => ({ ...prev, selectedTrackId: trackId }));
    if (isMobile) {
      setActiveMobileTab('BROWSER');
    } else {
      setIsSidebarOpen(true);
      setActiveSideBrowserTab('STORE');
    }
    setAiNotification("🎹 Choisis un instrument dans le navigateur");
    setTimeout(() => setAiNotification(null), 2500);
  }, [setState, isMobile]);
  const handleAddBus = useCallback(() => { handleCreateTrack(TrackType.BUS, "Group Bus"); }, [handleCreateTrack]);
  const handleToggleBypass = useCallback((trackId: string, pluginId: string) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === trackId);
        if (!track) return;
        
        const plugin = track.plugins.find(p => p.id === pluginId);
        if (plugin) {
            plugin.isEnabled = !plugin.isEnabled;
        }
    }));
  }, [setState]);

  // ✨ Copy plugin to another track (with all parameters)
  const handleCopyPluginToTrack = useCallback((sourceTrackId: string, plugin: PluginInstance, destTrackId: string) => {
    setState(produce((draft: DAWState) => {
        const destTrack = draft.tracks.find(t => t.id === destTrackId);
        if (!destTrack) return;
        
        // Create new plugin copy with new ID but same params
        const copiedPlugin: PluginInstance = {
            ...plugin,
            id: `pl-copy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            params: { ...plugin.params }
        };
        
        destTrack.plugins.push(copiedPlugin);
    }));
    
    setAiNotification(`✅ Plugin "${plugin.type}" copié vers la piste`);
    setTimeout(() => setAiNotification(null), 2000);
  }, [setState]);

  // ✨ Reorder plugins on a track (affects audio chain)
  const handleReorderPlugins = useCallback((trackId: string, fromIndex: number, toIndex: number) => {
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === trackId);
        if (!track || fromIndex < 0 || toIndex < 0 || fromIndex >= track.plugins.length || toIndex >= track.plugins.length) return;
        
        // Remove plugin from original position
        const [movedPlugin] = track.plugins.splice(fromIndex, 1);
        // Insert at new position
        track.plugins.splice(toIndex, 0, movedPlugin);
    }));
    
    // Force audio engine rebuild for this track
    setTimeout(() => {
        const updatedTrack = stateRef.current.tracks.find(t => t.id === trackId);
        if (updatedTrack) {
            audioEngine.updateTrack(updatedTrack, stateRef.current.tracks);
        }
    }, 50);
  }, [setState]);
  // --- Groupes de pistes (l'interface existait dans le mixer, sans aucun handler)
  const GROUP_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
                        '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'];

  const handleCreateGroup = useCallback((trackIds: string[]) => {
    if (!trackIds || trackIds.length < 2) return;
    setState(produce((draft: DAWState) => {
      const index = draft.trackGroups.length;
      const id = `grp-${Date.now()}`;
      draft.trackGroups.push({
        id,
        name: `Groupe ${index + 1}`,
        color: GROUP_COLORS[index % GROUP_COLORS.length],
        trackIds: [...trackIds],
        isCollapsed: false,
        linkedVolume: true,
        linkedMute: true,
        linkedSolo: true,
        linkedPan: false
      });
      // Une piste n'appartient qu'a un seul groupe.
      draft.trackGroups.forEach(g => {
        if (g.id !== id) g.trackIds = g.trackIds.filter(tid => !trackIds.includes(tid));
      });
      draft.trackGroups = draft.trackGroups.filter(g => g.id === id || g.trackIds.length > 0);
      draft.tracks.forEach(t => { if (trackIds.includes(t.id)) t.groupId = id; });
    }));
  }, [setState]);

  const handleUpdateGroup = useCallback((group: TrackGroup) => {
    setState(produce((draft: DAWState) => {
      const idx = draft.trackGroups.findIndex(g => g.id === group.id);
      if (idx > -1) draft.trackGroups[idx] = group;
    }));
  }, [setState]);

  const handleDeleteGroup = useCallback((groupId: string) => {
    setState(produce((draft: DAWState) => {
      draft.trackGroups = draft.trackGroups.filter(g => g.id !== groupId);
      draft.tracks.forEach(t => { if (t.groupId === groupId) delete t.groupId; });
    }));
  }, [setState]);

  const handleCreateAutomationLane = useCallback(() => {
    if (!automationMenu) return;
    
    setState(produce((draft: DAWState) => {
        const track = draft.tracks.find(t => t.id === automationMenu.trackId);
        if (!track) return;
        
        const newLane: AutomationLane = {
            id: `lane-${Date.now()}`,
            parameterName: automationMenu.paramName || 'volume',
            points: [],
            color: '#00f2ff',
            isExpanded: true,
            min: automationMenu.min,
            max: automationMenu.max,
        };
        
        track.automationLanes.push(newLane);
    }));
    
    setAutomationMenu(null);
  }, [automationMenu, setState]);
  // --- Marqueurs (l'affichage et le menu existaient dans ArrangementView,
  // mais rien ne permettait d'en creer et les props n'etaient jamais passees).
  const MARKER_COLORS = ['#00f2ff', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#eab308'];

  const handleAddMarker = useCallback((time: number, name?: string) => {
    setState(produce((draft: DAWState) => {
      const index = draft.markers.length;
      draft.markers.push({
        id: `mk-${Date.now()}-${index}`,
        name: name || `Marqueur ${index + 1}`,
        time: Math.max(0, time),
        type: 'MARKER',
        color: MARKER_COLORS[index % MARKER_COLORS.length]
      });
      draft.markers.sort((a, b) => a.time - b.time);
    }));
  }, [setState]);

  const handleUpdateMarker = useCallback((marker: Marker) => {
    setState(produce((draft: DAWState) => {
      const idx = draft.markers.findIndex(m => m.id === marker.id);
      if (idx > -1) draft.markers[idx] = marker;
      draft.markers.sort((a, b) => a.time - b.time);
    }));
  }, [setState]);

  const handleDeleteMarker = useCallback((markerId: string) => {
    setState(produce((draft: DAWState) => {
      draft.markers = draft.markers.filter(m => m.id !== markerId);
    }));
  }, [setState]);

  const handleToggleMetronome = useCallback(async () => {
    await ensureAudioEngine();
    setState(prev => ({ ...prev, metronome: { ...prev.metronome, enabled: !prev.metronome.enabled } }));
  }, [setState]);

  const handleToggleDelayComp = useCallback(() => {
    setState(prev => ({ ...prev, isDelayCompEnabled: !prev.isDelayCompEnabled }));
  }, [setState]);

  useEffect(() => {
    if (!unsavedMountRef.current) { unsavedMountRef.current = true; return; }
    hasUnsavedChangesRef.current = true;
  }, [state.tracks, state.bpm, state.name, state.trackGroups, state.markers]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedChangesRef.current) return;
      // On n'ennuie pas l'utilisateur si le projet est encore vide. Les pistes de
      // depart (SEND) portent des effets par defaut : elles ne comptent pas comme
      // du travail utilisateur.
      const hasContent = stateRef.current.tracks.some(t =>
        t.clips.length > 0 || (t.type !== TrackType.SEND && t.plugins.length > 0)
      );
      if (!hasContent) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /**
   * Raccourcis clavier globaux (transport, historique, sauvegarde).
   * Ils manquaient entierement : impossible de lancer la lecture a la barre
   * d'espace ou d'annuler au clavier, ce que fait n'importe quel DAW.
   * Les raccourcis lies a un clip (S, M, Suppr, Ctrl+C/V/X/D) restent geres par
   * ArrangementView / PianoRoll, on ne les intercepte pas ici.
   */
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node || !node.tagName) return false;
      const tag = node.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;

      // Lecture / pause : la barre d'espace ne doit ni defiler la page ni
      // re-declencher le bouton qui a le focus.
      if (e.code === 'Space' && !mod) {
        e.preventDefault();
        handleTogglePlay();
        return;
      }

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); setIsSaveMenuOpen(true); return; }

      if (mod) return; // on ne capture aucun autre raccourci systeme

      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); handleToggleRecord(); return; }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setState(prev => ({ ...prev, isLoopActive: !prev.isLoopActive }));
        return;
      }
      if (e.key === 'Home') { e.preventDefault(); handleSeek(0); return; }
      if (e.key === 'Escape' && stateRef.current.isPlaying) { e.preventDefault(); handleStop(); return; }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay, handleToggleRecord, handleStop, handleSeek, undo, redo, setState]);

  const handleRequestAddPlugin = useCallback((trackId: string, x: number, y: number) => {
    setAddPluginMenu({ trackId, x, y });
  }, []);

  /**
   * @param instrumentId identifiant de l'instrumental du catalogue, quand
   *        l'audio en provient. Il marque la piste comme sous licence : sans
   *        lui, rien ne relie le beat charge a l'achat et l'export ne peut pas
   *        etre conditionne.
   */
  const handleUniversalAudioImport = useCallback(async (source: string | File, name: string, forcedTrackId?: string, startTime?: number, sourceBpm?: number, instrumentId?: string | number) => {
      console.log('[handleUniversalAudioImport] Début import:', name);
      setExternalImportNotice(`Chargement: ${name}...`);
      try {
          await ensureAudioEngine();

          let audioBuffer: AudioBuffer;
          let audioRef: string;

          if (source instanceof File) {
              audioRef = URL.createObjectURL(source);
              const arrayBuffer = await source.arrayBuffer();
              audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          } else {
              audioRef = source;
              const response = await fetch(source);
              if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
              const arrayBuffer = await response.arrayBuffer();
              audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          }

          const clipName = name.replace(/\.[^/.]+$/, '');
          const clipId = `clip-${Date.now()}`;

          // IMPORTANT: Register buffer in registry OUTSIDE of React state
          // This avoids Immer proxy issues with native AudioBuffer objects.
          // On indexe par clipId (et non par URL) et on confie l'Object URL au
          // registre pour qu'il soit revoque a la suppression du clip : sinon
          // chaque fichier importe fuitait une Object URL jusqu'au rechargement.
          const bufferId = source instanceof File
              ? audioBufferRegistry.registerWithUrl(audioBuffer, audioRef, clipId)
              : audioBufferRegistry.register(audioBuffer, clipId);
          const clipDuration = audioBuffer.duration;
          const clipStart = startTime ?? stateRef.current.currentTime;
          const clipColor = UI_CONFIG.TRACK_COLORS[stateRef.current.tracks.length % UI_CONFIG.TRACK_COLORS.length];

          setState(produce((draft: DAWState) => {
              let targetTrackId: string | null = null;
              let isNewTrackNeeded = false;

              if (forcedTrackId) {
                  targetTrackId = forcedTrackId;
              } else {
                  const beatTrack = draft.tracks.find(t => t.id === 'instrumental');
                  if (beatTrack && beatTrack.clips.length === 0) {
                      targetTrackId = 'instrumental';
                  } else {
                      isNewTrackNeeded = true;
                      targetTrackId = `track-audio-${Date.now()}`;
                  }
              }

              // Create clip WITHOUT AudioBuffer - only bufferId reference
              const newClip: Clip = {
                  id: clipId,
                  name: clipName,
                  type: TrackType.AUDIO,
                  start: clipStart,
                  duration: clipDuration,
                  offset: 0,
                  bufferId: bufferId,  // Reference to registry, NOT the actual buffer
                  audioRef,
                  // Tempo d'origine du fichier : permet de proposer « Caler sur
                  // le tempo » plus tard, sans redemander l'info a l'utilisateur.
                  ...(sourceBpm && sourceBpm > 0
                    ? { warp: { enabled: false, mode: 'BEATS' as const, originalBpm: sourceBpm, preservePitch: true } }
                    : {}),
                  color: clipColor,
                  fadeIn: 0,
                  fadeOut: 0,
                  gain: 1.0,
                  isMuted: false
              };

              // Marquage licence : la piste qui recoit un beat du catalogue porte
              // son identifiant, ce qui permet de verifier l'achat a l'export.
              if (instrumentId !== undefined && targetTrackId) {
                  const pisteCible = draft.tracks.find(t => t.id === targetTrackId);
                  if (pisteCible) pisteCible.instrumentId = instrumentId;
              }

              if (isNewTrackNeeded) {
                  const newTrack: Track = {
                      id: targetTrackId!,
                      name: name.substring(0, 20),
                      type: TrackType.AUDIO,
                      color: UI_CONFIG.TRACK_COLORS[draft.tracks.length % UI_CONFIG.TRACK_COLORS.length],
                      isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
                      volume: 1.0, pan: 0, outputTrackId: 'master',
                      sends: [], clips: [newClip], plugins: [], automationLanes: [], totalLatency: 0
                  };
                  draft.tracks.splice(1, 0, newTrack);
                  draft.selectedTrackId = targetTrackId;
              } else {
                  const track = draft.tracks.find(t => t.id === targetTrackId);
                  if (track) {
                      track.clips.push(newClip);
                      draft.selectedTrackId = targetTrackId;
                  }
              }
          }));

          setExternalImportNotice(`✅ Importé: ${clipName}`);
          console.log(`[AudioImport] Successfully imported: ${clipName} (bufferId: ${bufferId})`);
          // Rendu pour l'appelant (analyse du beat : tonalité, BPM).
          return audioBuffer;

      } catch (e: any) {
          console.error("[Import Error]", e);
          setExternalImportNotice(`❌ Erreur: ${e.message || "Import échoué"}`);
      } finally {
          setTimeout(() => setExternalImportNotice(null), 3000);
      }
  }, [setState, ensureAudioEngine]);

  /**
   * Charge un beat du catalogue sur la piste BEAT en REMPLAÇANT le précédent
   * (avant, un glisser-déposer en ajoutait un second par-dessus), et cale le
   * tempo et la tonalité annoncés (utiles à l'Auto-Tune).
   */
  /**
   * Tonalité du projet ET de tous les Auto-Tune, en une seule étape d'historique :
   * la gamme indiquée sur le beat règle la correction sans que l'artiste y touche.
   */
  const applyProjectKey = (rootKey: number, scale: string) => {
    setState(produce((draft: DAWState) => {
      draft.projectKey = rootKey;
      draft.projectScale = scale;
      draft.tracks.forEach(t => t.plugins.forEach(p => {
        if (p.type === 'AUTOTUNE') { p.params.rootKey = rootKey; p.params.scale = scale; }
      }));
    }));
  };

  // Reprise d'une session : on recharge le beat du catalogue (non sauvegardé).
  useEffect(() => {
    if (showLanding || !restoreBeatAfterResumeRef.current) return;
    const timer = setTimeout(async () => {
      restoreBeatAfterResumeRef.current = false;
      const beat = stateRef.current.tracks.find(t => t.id === 'instrumental');
      if (!beat || beat.instrumentId === undefined) return;
      if (beat.clips.some(c => c.bufferId && audioBufferRegistry.get(c.bufferId))) return;
      try {
        const list = await supabaseManager.getActiveInstrumentals();
        const inst = list.find((i: any) => String(i.id) === String(beat.instrumentId));
        if (inst) await loadCatalogBeatRef.current?.(inst);
      } catch { /* hors ligne : le beat reste à recharger à la main */ }
      setAiNotification('💾 Session reprise : tes prises et tes paroles sont là.');
    }, 900);
    return () => clearTimeout(timer);
  }, [showLanding]);

  // Sauvegarde automatique sur l'appareil, quelques secondes après chaque
  // changement (jamais pendant la lecture ou une prise : ça couperait le son).
  const [lyricsOpen, setLyricsOpen] = useState(false);
  // Extrait 30 s / démo taguée
  const [shareOpen, setShareOpen] = useState(false);

  // ===== Batterie Make Music (piste PERCUSSIONS) =====
  const [drumsOpen, setDrumsOpen] = useState(false);
  const DRUM_TRACK_ID = 'track-drums';

  /** Fin de la boucle de batterie : fin du beat / de la mélodie, au moins 8 mesures. */
  const drumLoopEnd = (st: DAWState) => {
    const beat = st.tracks.find(t => t.id === 'instrumental');
    const beatEnd = beat ? Math.max(0, ...beat.clips.map(c => c.start + c.duration)) : 0;
    const bar = (60 / st.bpm) * 4;
    return Math.max(beatEnd, bar * 8);
  };

  /** Applique un motif : pads + clip régénérés (une étape d'historique). */
  const applyDrumMachine = useCallback((dm: DrumMachine) => {
    setState(produce((draft: DAWState) => {
      let t = draft.tracks.find(x => x.id === DRUM_TRACK_ID);
      const clip = drumClipFor(dm, draft.bpm, 0, drumLoopEnd(draft as DAWState), `clip-drums-${Date.now()}`);
      if (!t) {
        const newTrack: Track = {
          id: DRUM_TRACK_ID, name: 'PERCUSSIONS', type: TrackType.DRUM_RACK, color: '#f97316',
          isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 0.85, pan: 0,
          outputTrackId: 'master', sends: [], clips: [], plugins: [],
          automationLanes: [createDefaultAutomation('volume', '#f97316')], totalLatency: 0,
        } as Track;
        const beatIdx = draft.tracks.findIndex(x => x.id === 'instrumental');
        draft.tracks.splice(beatIdx + 1, 0, newTrack);
        t = draft.tracks.find(x => x.id === DRUM_TRACK_ID)!;
      }
      t.drumMachine = dm as any;
      t.drumPads = drumPadsFor(dm) as any;
      t.clips = [clip as any];
    }));
  }, [setState]);

  const handleSetDrumKit = useCallback((kitId?: string) => {
    const st = stateRef.current;
    const id = kitId && DRUM_KITS.some(k => k.id === kitId) ? kitId : suggestDrumKit(st.bpm, st.beatGenre, st.beatTitle);
    applyDrumMachine(makeDrumMachine(id));
    const kit = DRUM_KITS.find(k => k.id === id);
    setAiNotification(`🥁 Batterie « ${kit?.name} » posée, calée sur le tempo (${Math.round(st.bpm)} BPM)${typeof st.projectKey === 'number' ? ' et la tonalité' : ''}. Lance la lecture !`);
  }, [applyDrumMachine]);

  const handleRemoveDrums = useCallback(() => {
    setState(produce((draft: DAWState) => { draft.tracks = draft.tracks.filter(t => t.id !== DRUM_TRACK_ID); }));
    setAiNotification('Batterie retirée (Annuler pour la remettre).');
  }, [setState]);

  // Sons des pads : générés / chargés puis donnés au moteur (808 accordée sur la tonalité).
  const loadedPads = useRef(new Map<string, string>());
  useEffect(() => {
    const t = state.tracks.find(x => x.id === DRUM_TRACK_ID);
    if (!t?.drumMachine || !audioEngine.ctx) return;
    const ctx = audioEngine.ctx;
    const root = typeof state.projectKey === 'number' ? state.projectKey : 0;
    const timer = setTimeout(() => {
      t.drumMachine!.rows.forEach((r, i) => {
        const key = `${r.sound}|${root}`;
        const padKey = `${t.id}:${i + 1}`;
        if (loadedPads.current.get(padKey) === key && audioEngine.getDrumRackNode(t.id)?.getBuffers().has(i + 1)) return;
        loadDrumSound(r.sound, ctx, root).then(buf => {
          audioEngine.loadDrumRackSample(t.id, i + 1, buf);
          loadedPads.current.set(padKey, key);
        }).catch(() => { /* son indisponible */ });
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [state.tracks, state.projectKey]);

  // Tempo ou longueur du beat changés : la boucle de batterie suit.
  const drumTempoRef = useRef<number>(state.bpm);
  useEffect(() => {
    const t = stateRef.current.tracks.find(x => x.id === DRUM_TRACK_ID);
    if (!t?.drumMachine) { drumTempoRef.current = state.bpm; return; }
    if (drumTempoRef.current === state.bpm) return;
    drumTempoRef.current = state.bpm;
    applyDrumMachine(t.drumMachine);
  }, [state.bpm, applyDrumMachine]);

  // Première visite du studio : les 3 gestes à connaître.
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  useEffect(() => {
    if (showLanding) return;
    let seen = true;
    try { seen = localStorage.getItem('nova_welcome_seen') === '1'; } catch { /* */ }
    if (!seen) {
      const t = setTimeout(() => setWelcomeOpen(true), 1200);
      return () => clearTimeout(t);
    }
  }, [showLanding]);
  const closeWelcome = () => {
    setWelcomeOpen(false);
    try { localStorage.setItem('nova_welcome_seen', '1'); } catch { /* */ }
  };
  const autosaveTimer = useRef<number | null>(null);
  const autosaveNotified = useRef(false);
  const autosaveNow = useCallback(async () => {
    const st = stateRef.current;
    if (st.isRecording) return;
    const voiceTakes = st.tracks.filter(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId)
      .reduce((n, t) => n + t.clips.filter(c => /^Prise \d+/.test(c.name || '')).length, 0);
    const hasAudio = st.tracks.some(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId && t.clips.length > 0);
    if (!hasAudio && !(st.lyrics || '').trim()) return; // rien à garder : on n'écrase pas une session précédente
    try {
      const blob = await ProjectIO.saveProject(st, user?.owned_instruments || []);
      const beatClip = st.tracks.find(t => t.id === 'instrumental')?.clips[0];
      await saveSession(blob, {
        savedAt: Date.now(),
        beatTitle: beatClip?.name?.replace(/^🚫\s*/, '').replace(/\s*\(Licence requise\)$/, '') || null,
        takes: voiceTakes,
        hasLyrics: !!(st.lyrics || '').trim(),
      });
      if (!autosaveNotified.current) {
        autosaveNotified.current = true;
        setAiNotification("💾 Ta session est sauvegardée automatiquement sur cet appareil : tu la retrouveras en revenant (« Reprendre ma session »).");
      }
    } catch (e) {
      console.warn('[Session] Sauvegarde auto impossible', e);
    }
  }, [user]);
  useEffect(() => {
    if (showLanding || state.isPlaying || state.isRecording) return;
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => { void autosaveNow(); }, 4000);
    return () => { if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current); };
  }, [state.tracks, state.lyrics, state.isPlaying, state.isRecording, showLanding, autosaveNow]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden' && !showLanding) void autosaveNow(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [autosaveNow, showLanding]);

  // Un extrait du catalogue démarre : le projet en lecture se met en pause
  // (sauf pendant une prise, qu'on ne coupe jamais).
  useEffect(() => {
    const onPreview = () => {
      if (stateRef.current.isPlaying && !stateRef.current.isRecording) {
        audioEngine.stopAll();
        setVisualState({ isPlaying: false });
      }
    };
    window.addEventListener('nova:preview-start', onPreview);
    return () => window.removeEventListener('nova:preview-start', onPreview);
  }, [setVisualState]);

  const handleLoadCatalogBeat = async (inst: any) => {
    let audioUrl = '';
    if (inst?.preview_url) audioUrl = supabaseManager.getPublicInstrumentUrl(inst.preview_url);
    else if (inst?.drive_file_id) audioUrl = supabaseManager.getDrivePreviewUrl(inst.drive_file_id);
    if (!audioUrl) {
      setAiNotification("Ce beat n'a pas de fichier audio disponible.");
      return;
    }
    if (stateRef.current.isPlaying) { audioEngine.stopAll(); setVisualState({ isPlaying: false }); }
    // L'extrait de ce beat (ou d'un autre) s'arrête : on passe au beat dans le projet.
    window.dispatchEvent(new Event('nova:transport-start'));
    setState(produce((draft: DAWState) => {
      const beat = draft.tracks.find(t => t.id === 'instrumental');
      if (beat) beat.clips = [];
    }));
    setAiNotification(`⏳ Chargement de « ${inst.title} »…`);
    const beatBuffer = await handleUniversalAudioImport(audioUrl, inst.title, 'instrumental', 0, inst.bpm, inst.id);
    if (inst.bpm) handleUpdateBpm(inst.bpm);
    setState(prev => ({ ...prev, beatGenre: inst.genre || undefined, beatTitle: inst.title || undefined }));
    let tonalite = lireTonalite(inst.key);
    let ecoute = false;
    // Beat sans tonalité ou sans BPM dans le catalogue : on les détecte à l'écoute.
    if (!tonalite || !inst.bpm) {
      const buf = beatBuffer || undefined;
      if (buf) {
        if (!tonalite) {
          const d = await detectKey(buf).catch(() => null);
          if (d) { tonalite = { rootKey: d.rootKey, scale: d.scale }; ecoute = true; }
        }
        if (!inst.bpm) {
          const debut = Math.min(10, buf.duration * 0.2);
          const bpm = await AudioAnalysisEngine.detectBPMAdvanced(buf, debut, Math.min(30, buf.duration * 0.6)).catch(() => 0);
          if (bpm >= 60 && bpm <= 200) handleUpdateBpm(bpm);
        }
      }
    }
    if (tonalite) applyProjectKey(tonalite.rootKey, tonalite.scale);
    audioEngine.seekTo(0, stateRef.current.tracks, false);
    setState(prev => ({ ...prev, currentTime: 0 }));
    setAiNotification(tonalite
      ? `🎵 « ${inst.title} » est prêt (${nomTonalite(tonalite.rootKey, tonalite.scale)}${ecoute ? ", détectée à l'écoute" : ''}) — l'Auto-Tune est réglé sur cette gamme. Appuie sur REC pour poser ta voix`
      : `🎵 « ${inst.title} » est prêt — appuie sur REC pour poser ta voix (gamme inconnue : l'Auto-Tune corrige sur toutes les notes)`);
    if (isMobile) setActiveMobileTab('TRACKS');
    // Mélodie du studio (sans batterie) : on propose d'en poser une, adaptée.
    if (inst.kind === 'melody' || /melod|sample/i.test(`${inst.genre || ''}`)) {
      const st = stateRef.current;
      const sid = suggestDrumKit(st.bpm, inst.genre, inst.title);
      const others = DRUM_KITS.filter(k => k.id !== sid && ['trap', 'drill', 'boombap', 'rnb', 'afro'].includes(k.id)).slice(0, 2);
      const first = DRUM_KITS.find(k => k.id === sid)!;
      postNova(`🎹 « ${inst.title} » est une mélodie, sans batterie. Je te pose une batterie calée sur son tempo et sa tonalité ? Tu pourras modifier chaque pas.`, [
        { label: `${first.emoji} Batterie ${first.name}`, action: { action: 'ADD_DRUMS', payload: { kit: sid } } },
        ...others.map(k => ({ label: `${k.emoji} ${k.name}`, action: { action: 'ADD_DRUMS', payload: { kit: k.id } } as AIAction })),
      ]);
    }
  };
  loadCatalogBeatRef.current = handleLoadCatalogBeat;

  const handleLoadDrumSample = useCallback(async (trackId: string, padId: number, file: File) => {
    try {
        await ensureAudioEngine();
        
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
        const audioRef = URL.createObjectURL(file);
        
        audioEngine.loadDrumRackSample(trackId, padId, audioBuffer);
        
        setState(produce((draft: DAWState) => {
            const track = draft.tracks.find(t => t.id === trackId);
            if (!track || !track.drumPads) return;
            
            const pad = track.drumPads.find(p => p.id === padId);
            if (pad) {
                pad.sampleName = file.name.replace(/\.[^/.]+$/, '');
                pad.audioRef = audioRef;
                delete pad.buffer;
            }
        }));
        
        console.log(`[DrumSample] Loaded ${file.name} on pad ${padId}`);
    } catch (error) {
        console.error('[DrumSample] Error loading sample:', error);
    }
}, [setState]);

  useEffect(() => {
    (window as any).DAW_CONTROL = {
      loadDrumSample: handleLoadDrumSample,
      getState: () => stateRef.current,
      getInstrumentalBuffer: () => {
          const instru = stateRef.current.tracks.find(t => t.id === 'instrumental');
          const clip = instru?.clips[0];
          if(clip && clip.bufferId) return audioEngine.getAudioBuffer(clip.bufferId) || null;
          return null;
      },
      editClip: handleEditClip,
      setBpm: handleUpdateBpm,
      syncAutoTuneScale: (rootKey: number, scale: string) => applyProjectKey(rootKey, scale)
    };
    // Dépôt d'un fichier ou d'un beat sur l'en-tête d'une piste (TrackHeader) :
    // cet objet n'existait pas, le dépôt ne faisait rien.
    (window as any).DAW_CORE = {
      handleAudioImport: (source: string | File, name: string, trackId: string) => {
        const beat = takeDraggedBeat(source);
        if (beat) return loadCatalogBeatRef.current?.(beat);
        return handleUniversalAudioImport(source, name, trackId);
      }
    };
  }, [handleUpdateBpm, handleUpdateTrack, handleTogglePlay, handleStop, handleSeek, handleDuplicateTrack, handleCreateTrack, handleDeleteTrack, handleToggleBypass, handleLoadDrumSample, handleEditClip, setState, handleUniversalAudioImport]);

  /**
   * Applique une action renvoyée par l'assistant IA.
   * Le catalogue d'actions est décrit dans api/chat.ts : les deux doivent rester alignés.
   */
  const executeAIAction = useCallback((a: AIAction) => {
    if (!a || !a.action) return;
    const p = (a.payload || {}) as any;
    const tracks = stateRef.current.tracks;

    /** Retrouve une piste par id, à défaut par nom (l'IA peut se tromper de casse). */
    const findTrack = (id?: string): Track | undefined => {
      if (!id) return undefined;
      return tracks.find(t => t.id === id)
        || tracks.find(t => t.name.toLowerCase() === String(id).toLowerCase());
    };

    /** Retrouve un plugin par id ou par type sur une piste. */
    const findPlugin = (track: Track, ref?: string) => {
      if (!ref) return undefined;
      return track.plugins.find(pl => pl.id === ref)
        || track.plugins.find(pl => pl.type === String(ref).toUpperCase());
    };

    const clamp = (v: any, min: number, max: number, fallback: number) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    };

    const notify = (msg: string) => {
      setAiNotification(msg);
      setTimeout(() => setAiNotification(null), 2500);
    };

    /** Mutation ciblée sur une piste, via son id. */
    const patchTrack = (trackId: string, mutate: (t: Track) => void) => {
      setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(tr => tr.id === trackId);
        if (t) mutate(t);
      }));
    };

    switch (a.action) {
      case 'SET_VOLUME': {
        const t = findTrack(p.trackId);
        if (!t) return;
        patchTrack(t.id, tr => { tr.volume = clamp(p.volume, 0, 1.5, tr.volume); });
        break;
      }

      case 'SET_PAN': {
        const t = findTrack(p.trackId);
        if (!t) return;
        patchTrack(t.id, tr => { tr.pan = clamp(p.pan, -1, 1, tr.pan); });
        break;
      }

      case 'MUTE_TRACK': {
        const t = findTrack(p.trackId);
        if (!t) return;
        patchTrack(t.id, tr => { tr.isMuted = p.isMuted === undefined ? !tr.isMuted : !!p.isMuted; });
        break;
      }

      case 'SOLO_TRACK': {
        const t = findTrack(p.trackId);
        if (!t) return;
        patchTrack(t.id, tr => { tr.isSolo = p.isSolo === undefined ? !tr.isSolo : !!p.isSolo; });
        break;
      }

      case 'RENAME_TRACK': {
        const t = findTrack(p.trackId);
        if (!t || !p.name) return;
        patchTrack(t.id, tr => { tr.name = String(p.name).slice(0, 40); });
        break;
      }

      case 'ADD_TRACK':
      case 'CREATE_TRACK': {
        const type = (String(p.type || 'AUDIO').toUpperCase() as TrackType);
        // Pas de piste MIDI : le DAW sert aux voix (aucun outil de composition).
        const valid = [TrackType.AUDIO, TrackType.BUS, TrackType.SEND];
        handleCreateTrack(valid.includes(type) ? type : TrackType.AUDIO, p.name);
        break;
      }

      case 'DELETE_TRACK': {
        const t = findTrack(p.trackId);
        if (t) handleDeleteTrack(t.id);
        break;
      }

      case 'DUPLICATE_TRACK': {
        const t = findTrack(p.trackId);
        if (t) handleDuplicateTrack(t.id);
        break;
      }

      case 'UPDATE_TRACK': {
        const t = findTrack(p.trackId);
        if (!t) return;
        handleUpdateTrack({
          ...t,
          ...(p.volume !== undefined ? { volume: clamp(p.volume, 0, 1.5, t.volume) } : {}),
          ...(p.pan !== undefined ? { pan: clamp(p.pan, -1, 1, t.pan) } : {}),
          ...(p.isMuted !== undefined ? { isMuted: !!p.isMuted } : {}),
          ...(p.isSolo !== undefined ? { isSolo: !!p.isSolo } : {}),
          ...(p.name ? { name: String(p.name).slice(0, 40) } : {})
        });
        break;
      }

      case 'UPDATE_PLUGIN': {
        const t = findTrack(p.trackId);
        const type = String(p.pluginType || p.type || '').toUpperCase() as PluginType;
        if (!t || !type) return;
        const existing = findPlugin(t, type);
        if (existing) {
          handleUpdatePluginParams(t.id, existing.id, { ...existing.params, ...(p.params || {}) });
        } else {
          // L'effet n'est pas encore sur la piste : on le crée avec les réglages demandés.
          const plugin = createDefaultPlugins(type, 0.5, stateRef.current.bpm);
          plugin.params = { ...plugin.params, ...(p.params || {}) };
          patchTrack(t.id, tr => { tr.plugins.push(plugin); });
          notify(`✅ ${type} ajouté sur ${t.name}`);
        }
        break;
      }

      case 'SET_PLUGIN_PARAM': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const plugin = findPlugin(t, p.pluginId || p.pluginType);
        if (!plugin || !p.param) return;
        handleUpdatePluginParams(t.id, plugin.id, { ...plugin.params, [p.param]: p.value });
        break;
      }

      case 'BYPASS_PLUGIN': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const plugin = findPlugin(t, p.pluginId || p.pluginType);
        if (!plugin) return;
        const target = p.isEnabled === undefined ? !plugin.isEnabled : !!p.isEnabled;
        if (target !== plugin.isEnabled) handleToggleBypass(t.id, plugin.id);
        break;
      }

      case 'OPEN_PLUGIN': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const plugin = findPlugin(t, p.pluginId || p.pluginType);
        if (!plugin) return;
        ensureAudioEngine().then(() => setActivePlugin({ trackId: t.id, plugin }));
        break;
      }

      case 'CLOSE_PLUGIN':
        setActivePlugin(null);
        break;

      case 'RESET_FX': {
        const target = findTrack(p.trackId);
        setState(produce((draft: DAWState) => {
          draft.tracks.forEach(tr => {
            if (target && tr.id !== target.id) return;
            tr.plugins = [];
          });
        }));
        notify(target ? `🧹 Effets retirés sur ${target.name}` : '🧹 Tous les effets ont été retirés');
        break;
      }

      case 'SET_SEND_LEVEL': {
        const t = findTrack(p.trackId);
        if (!t || !p.sendId) return;
        patchTrack(t.id, tr => {
          const send = tr.sends.find(s => s.id === p.sendId);
          if (send) {
            send.level = clamp(p.level, 0, 1, send.level);
            send.isEnabled = true;
          }
        });
        break;
      }

      case 'PLAY':
        if (!stateRef.current.isPlaying) handleTogglePlay();
        break;

      case 'STOP':
        handleStop();
        break;

      case 'RECORD':
        if (isMobileRef.current && activeTabRef.current === 'NOVA') setActiveMobileTab('TRACKS');
        handleToggleRecord();
        break;

      case 'SEEK':
        handleSeek(Math.max(0, Number(p.time) || 0));
        break;

      case 'SET_LOOP': {
        const start = Math.max(0, Number(p.start) || 0);
        const end = Math.max(start + 0.1, Number(p.end) || start + 4);
        setState(prev => ({
          ...prev,
          loopStart: start,
          loopEnd: end,
          isLoopActive: p.active === undefined ? true : !!p.active
        }));
        break;
      }

      case 'SET_BPM':
        handleUpdateBpm(clamp(p.bpm, 20, 999, stateRef.current.bpm));
        break;

      case 'MUTE_CLIP': {
        const t = findTrack(p.trackId);
        if (!t || !p.clipId) return;
        const clip = t.clips.find(c => c.id === p.clipId);
        if (!clip) return;
        const target = p.isMuted === undefined ? !clip.isMuted : !!p.isMuted;
        if (target !== clip.isMuted) handleEditClip(t.id, clip.id, 'MUTE');
        break;
      }

      case 'SPLIT_CLIP': {
        const t = findTrack(p.trackId);
        if (!t || !p.clipId) return;
        handleEditClip(t.id, p.clipId, 'SPLIT', { time: Number(p.time) || 0 });
        break;
      }

      case 'NORMALIZE_CLIP': {
        const t = findTrack(p.trackId);
        if (!t || !p.clipId) return;
        handleEditClip(t.id, p.clipId, 'NORMALIZE');
        notify('📊 Clip normalisé');
        break;
      }

      case 'PREPARE_REC': {
        const t = findTrack(p.trackId) || tracks.find(tr => tr.id === stateRef.current.selectedTrackId);
        if (!t) return;
        // Vrai armement (micro ouvert) : avant, la piste paraissait armée sans
        // micro, et l'enregistrement échouait en silence.
        setState(produce((draft: DAWState) => { draft.isRecModeActive = true; }));
        void armForRecording(t.id).then(ok => { if (ok) notify(`🔴 Micro prêt sur ${t.name} — appuie sur REC`); });
        break;
      }

      case 'CLEAN_MIX': {
        setState(produce((draft: DAWState) => {
          draft.tracks.forEach(tr => {
            tr.isMuted = false;
            tr.isSolo = false;
            tr.pan = 0;
            if (tr.type === TrackType.AUDIO) tr.volume = 0.8;
          });
        }));
        notify('🧼 Mix remis à plat');
        break;
      }

      // ---- Effets ----
      case 'REMOVE_PLUGIN': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const plugin = findPlugin(t, p.pluginId || p.pluginType);
        if (!plugin) return;
        handleRemovePlugin(t.id, plugin.id);
        break;
      }

      case 'MOVE_PLUGIN': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const plugin = findPlugin(t, p.pluginId || p.pluginType);
        if (!plugin) return;
        const from = t.plugins.findIndex(pl => pl.id === plugin.id);
        const to = Math.max(0, Math.min(t.plugins.length - 1, Number(p.toIndex)));
        if (from > -1 && Number.isFinite(to)) handleReorderPlugins(t.id, from, to);
        break;
      }

      case 'COPY_PLUGIN': {
        const src = findTrack(p.sourceTrackId);
        const dest = findTrack(p.destTrackId);
        if (!src || !dest) return;
        const plugin = findPlugin(src, p.pluginId || p.pluginType);
        if (!plugin) return;
        handleCopyPluginToTrack(src.id, plugin, dest.id);
        break;
      }

      // ---- Piste ----
      case 'SET_TRACK_OUTPUT': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const destId = p.outputTrackId === 'master' ? 'master' : (findTrack(p.outputTrackId)?.id || '');
        if (!destId || destId === t.id) return;
        patchTrack(t.id, tr => { tr.outputTrackId = destId; });
        break;
      }

      case 'ARM_TRACK': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const armed = p.armed === undefined ? !t.isTrackArmed : !!p.armed;
        if (armed) void armForRecording(t.id);
        else handleUpdateTrack({ ...t, isTrackArmed: false });
        break;
      }

      case 'FREEZE_TRACK': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const wantFrozen = p.frozen === undefined ? !t.isFrozen : !!p.frozen;
        if (wantFrozen !== t.isFrozen) handleFreezeTrack(t.id);
        break;
      }

      // ---- Marqueurs ----
      case 'ADD_MARKER':
        handleAddMarker(Math.max(0, Number(p.time) ?? stateRef.current.currentTime), p.name);
        break;

      case 'DELETE_MARKER': {
        const mk = stateRef.current.markers.find(m => m.id === p.markerId || m.name === p.name);
        if (mk) handleDeleteMarker(mk.id);
        break;
      }

      case 'GOTO_MARKER': {
        const mk = stateRef.current.markers.find(m => m.id === p.markerId || m.name === p.name);
        if (mk) handleSeek(mk.time);
        break;
      }

      // ---- Métronome / signature ----
      case 'SET_METRONOME': {
        ensureAudioEngine().then(() => {
          setState(prev => ({
            ...prev,
            metronome: {
              ...prev.metronome,
              ...(p.enabled !== undefined ? { enabled: !!p.enabled } : {}),
              ...(p.volume !== undefined ? { volume: clamp(p.volume, 0, 1, prev.metronome.volume) } : {}),
              ...(p.countIn !== undefined ? { countIn: clamp(p.countIn, 0, 4, prev.metronome.countIn) } : {}),
              ...(p.accentDownbeat !== undefined ? { accentDownbeat: !!p.accentDownbeat } : {})
            }
          }));
        });
        break;
      }

      case 'SET_TIME_SIGNATURE': {
        const num = clamp(p.numerator, 1, 32, stateRef.current.timeSignature.numerator);
        const den = [1, 2, 4, 8, 16].includes(Number(p.denominator)) ? Number(p.denominator) : stateRef.current.timeSignature.denominator;
        setState(prev => ({ ...prev, timeSignature: { numerator: num, denominator: den } }));
        break;
      }

      // ---- Groupes ----
      case 'CREATE_GROUP': {
        const ids = (p.trackIds || []).map((id: string) => findTrack(id)?.id).filter(Boolean) as string[];
        if (ids.length >= 2) handleCreateGroup(ids);
        break;
      }

      case 'DELETE_GROUP': {
        const g = stateRef.current.trackGroups.find(gr => gr.id === p.groupId || gr.name === p.name);
        if (g) handleDeleteGroup(g.id);
        break;
      }

      case 'UPDATE_GROUP': {
        const g = stateRef.current.trackGroups.find(gr => gr.id === p.groupId || gr.name === p.name);
        if (!g) return;
        handleUpdateGroup({
          ...g,
          ...(p.name ? { name: String(p.name).slice(0, 40) } : {}),
          ...(p.linkedVolume !== undefined ? { linkedVolume: !!p.linkedVolume } : {}),
          ...(p.linkedMute !== undefined ? { linkedMute: !!p.linkedMute } : {}),
          ...(p.linkedSolo !== undefined ? { linkedSolo: !!p.linkedSolo } : {}),
          ...(p.linkedPan !== undefined ? { linkedPan: !!p.linkedPan } : {})
        });
        break;
      }

      // ---- Clips ----
      case 'DELETE_CLIP': {
        const t = findTrack(p.trackId);
        if (t && p.clipId) handleEditClip(t.id, p.clipId, 'DELETE');
        break;
      }

      case 'DUPLICATE_CLIP': {
        const t = findTrack(p.trackId);
        if (t && p.clipId) handleEditClip(t.id, p.clipId, 'DUPLICATE');
        break;
      }

      case 'RENAME_CLIP': {
        const t = findTrack(p.trackId);
        if (t && p.clipId && p.name) handleEditClip(t.id, p.clipId, 'RENAME', { name: String(p.name).slice(0, 60) });
        break;
      }

      case 'MOVE_CLIP': {
        const t = findTrack(p.trackId);
        if (!t || !p.clipId) return;
        if (p.destTrackId && findTrack(p.destTrackId)?.id !== t.id) {
          const dest = findTrack(p.destTrackId)!;
          handleMoveClip(t.id, dest.id, p.clipId);
          if (p.start !== undefined) handleEditClip(dest.id, p.clipId, 'UPDATE_PROPS', { start: Math.max(0, Number(p.start) || 0) });
        } else if (p.start !== undefined) {
          handleEditClip(t.id, p.clipId, 'UPDATE_PROPS', { start: Math.max(0, Number(p.start) || 0) });
        }
        break;
      }

      case 'SET_CLIP_GAIN': {
        const t = findTrack(p.trackId);
        if (!t || !p.clipId) return;
        handleEditClip(t.id, p.clipId, 'UPDATE_PROPS', { gain: clamp(p.gain, 0, 4, 1) });
        break;
      }

      case 'SET_CLIP_FADE': {
        const t = findTrack(p.trackId);
        if (!t || !p.clipId) return;
        const clip = t.clips.find(c => c.id === p.clipId);
        if (!clip) return;
        handleEditClip(t.id, p.clipId, 'UPDATE_PROPS', {
          ...(p.fadeIn !== undefined ? { fadeIn: clamp(p.fadeIn, 0, clip.duration, clip.fadeIn) } : {}),
          ...(p.fadeOut !== undefined ? { fadeOut: clamp(p.fadeOut, 0, clip.duration, clip.fadeOut) } : {})
        });
        break;
      }

      // ---- MIDI ----
      case 'CREATE_PATTERN':
      case 'ADD_NOTES':
      case 'CLEAR_NOTES': {
        // Composition MIDI retirée : le DAW sert à essayer sa voix sur les instrus.
        setAiNotification("🎤 Nova Studio sert à enregistrer ta voix sur les instrus — pas de composition ici.");
        break;
      }

      // ---- Automation ----
      case 'SET_AUTOMATION': {
        const t = findTrack(p.trackId);
        const param = String(p.parameter || p.paramId || 'volume');
        if (!t || !Array.isArray(p.points) || p.points.length === 0) return;
        const isPan = param === 'pan';
        const points = p.points
          .slice(0, 256)
          .map((pt: any, i: number) => ({
            id: `ap-${Date.now()}-${i}`,
            time: Math.max(0, Number(pt.time) || 0),
            value: clamp(pt.value, isPan ? -1 : 0, isPan ? 1 : 1.5, isPan ? 0 : 1)
          }))
          .sort((a: any, b: any) => a.time - b.time);
        patchTrack(t.id, tr => {
          let lane = tr.automationLanes.find(l => l.parameterName === param);
          if (!lane) {
            lane = { id: `auto-${Date.now()}`, parameterName: param, points: [], color: tr.color, isExpanded: true, min: isPan ? -1 : 0, max: isPan ? 1 : 1.5 };
            tr.automationLanes.push(lane);
          }
          lane.points = points;
          lane.isExpanded = true;
        });
        notify(`📈 Automation ${param} écrite sur ${t.name}`);
        break;
      }

      case 'CLEAR_AUTOMATION': {
        const t = findTrack(p.trackId);
        if (!t) return;
        const param = p.parameter ? String(p.parameter) : null;
        patchTrack(t.id, tr => {
          tr.automationLanes.forEach(l => { if (!param || l.parameterName === param) l.points = []; });
        });
        break;
      }

      // ---- Catalogue ----
      case 'LOAD_BEAT': {
        const query = String(p.name || p.title || '').trim().toLowerCase();
        if (!query) return;
        notify(`🔎 Recherche de "${p.name}"...`);
        (async () => {
          try {
            const catalogue = await supabaseManager.getActiveInstrumentals();
            const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const q = norm(query);
            const match = catalogue.find(i => norm(i.title || '') === q)
              || catalogue.find(i => norm(i.title || '').includes(q))
              || catalogue.find(i => q.includes(norm(i.title || '')));

            if (!match) { notify(`❌ Aucun beat "${p.name}" dans le catalogue`); return; }

            let audioUrl = '';
            if (match.preview_url) audioUrl = supabaseManager.getPublicInstrumentUrl(match.preview_url);
            else if (match.drive_file_id) audioUrl = supabaseManager.getDrivePreviewUrl(match.drive_file_id);
            if (!audioUrl) { notify(`❌ "${match.title}" n'a pas de fichier audio`); return; }

            await loadCatalogBeatRef.current?.(match);
          } catch (e: any) {
            console.error('[AI] LOAD_BEAT', e);
            notify(`❌ Chargement impossible : ${e?.message || 'erreur'}`);
          }
        })();
        break;
      }

      // ---- Vue et projet ----
      case 'SET_VIEW': {
        const view = String(p.view || '').toUpperCase();
        if (['ARRANGEMENT', 'MIXER', 'AUTOMATION'].includes(view)) {
          setState(prev => ({ ...prev, currentView: view as any }));
          // Sur téléphone on navigue par onglets : currentView n'y est pas affiché.
          if (document.body.getAttribute('data-view-mode') === 'MOBILE' && (view === 'MIXER' || view === 'ARRANGEMENT')) {
            setActiveMobileTab(view as MobileTab);
          }
        }
        break;
      }

      case 'TOGGLE_LOOP':
        setState(prev => ({ ...prev, isLoopActive: p.active === undefined ? !prev.isLoopActive : !!p.active }));
        break;

      case 'SET_PROJECT_KEY': {
        const st = stateRef.current;
        const key = p.key !== undefined ? Math.round(clamp(p.key, 0, 11, 0)) : (st.projectKey ?? 0);
        const scaleIn = String(p.scale || st.projectScale || 'MINOR').toUpperCase().replace(/\s+/g, '_');
        const scale = ['MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC', 'CHROMATIC'].includes(scaleIn)
          ? scaleIn : /MAJ/.test(scaleIn) ? 'MAJOR' : 'MINOR';
        applyProjectKey(key, scale);
        notify(`🎼 Tonalité : ${nomTonalite(key, scale)} — Auto-Tune réglé`);
        break;
      }

      case 'UNDO':
        if (canUndo) undo();
        break;

      case 'REDO':
        if (canRedo) redo();
        break;

      case 'SAVE_PROJECT':
        handleSaveCloud(String(p.name || stateRef.current.name || 'STUDIO_SESSION'));
        break;

      case 'OPEN_EXPORT':
        setIsExportMenuOpen(true);
        break;

      // ---- Outils voix ----
      case 'APPLY_MIX_STYLE': {
        handleApplyMixStyle(String(p.style || p.styleId || p.name || ''));
        break;
      }

      case 'OPEN_LYRICS':
        setLyricsOpen(true);
        break;

      case 'OPEN_SHARE':
        setShareOpen(true);
        break;

      case 'ADD_DRUMS':
        void ensureAudioEngine().then(() => handleSetDrumKit(p.kit ? String(p.kit) : undefined));
        if (p.open !== false) setDrumsOpen(true);
        break;

      case 'OPEN_DRUMS':
        setDrumsOpen(true);
        break;

      case 'REMOVE_DRUMS':
        handleRemoveDrums();
        break;

      case 'OPEN_MIX_STYLES':
        setVocalToolsOpen(true);
        break;

      case 'REMOVE_SILENCE':
      case 'CLEAN_SILENCE': {
        const t = findTrack(p.trackId) || getTargetVoiceTrack();
        if (!t) { notify("Il n'y a pas encore de prise à nettoyer"); return; }
        handleCleanSilences(t.id, p.clipId);
        break;
      }

      case 'SET_AUTO_CLEAN':
        setAutoCleanSilence(p.enabled !== false);
        break;

      case 'PREPARE_PART': {
        const part = String(p.part || '').toLowerCase();
        const map: Record<string, SessionPart> = { lead: 'lead', back: 'back', backs: 'back', harmony: 'harmony', harmonies: 'harmony', harmonie: 'harmony', adlib: 'adlib', adlibs: 'adlib', 'ad-libs': 'adlib' };
        void prepareSessionPart(map[part] || 'lead');
        break;
      }

      case 'ANALYZE_MIX':
        handleAnalyzeMix();
        break;

      case 'OPEN_STUDIO_OFFER':
        if (String(p.offer) === 'beat') openBuyBeat(stateRef.current.tracks);
        else if (String(p.offer) === 'session') openStudioSession();
        else openProMix();
        break;

      case 'HIGHLIGHT': {
        const target = String(p.target || '');
        if (!target) return;
        const show = () => { if (!novaSpotlight(target, p.text ? String(p.text) : undefined)) notify("Je ne trouve pas ce réglage à l'écran"); };
        if (isMobileRef.current) {
          // Le chat couvre l'écran sur téléphone : on va sur l'onglet où se trouve le réglage.
          setActiveMobileTab(target.startsWith('vol-') ? 'MIXER' : 'TRACKS');
          setTimeout(show, 400);
        } else show();
        break;
      }

      default:
        // Actions non encore prises en charge (RUN_MASTER_SYNC, ANALYZE_INSTRU) :
        // on le dit plutôt que d'échouer en silence.
        console.warn('[AI] Action non prise en charge :', a.action, a.payload);
        notify(`⚠️ Action "${a.action}" pas encore disponible`);
        break;
    }
  }, [setState, handleCreateTrack, handleDeleteTrack, handleDuplicateTrack, handleUpdateTrack,
      handleUpdatePluginParams, handleToggleBypass, handleTogglePlay, handleStop, handleToggleRecord,
      handleSeek, handleUpdateBpm, handleRemovePlugin, handleReorderPlugins, handleCopyPluginToTrack,
      handleFreezeTrack, handleAddMarker, handleDeleteMarker, handleCreateGroup, handleUpdateGroup,
      handleDeleteGroup, handleCreatePatternAndOpen, handleMoveClip, handleSaveCloud, undo, redo,
      canUndo, canRedo, handleUniversalAudioImport, handleApplyMixStyle, handleCleanSilences,
      prepareSessionPart, handleAnalyzeMix, handleSetDrumKit, handleRemoveDrums]);

  const envoyerAuChatbot = async (messageUtilisateur: string) => {
    // Ordres simples (« monte ma voix », « style trap », « refais la prise »…) :
    // exécutés tout de suite, sans attendre l'IA ni dépendre du réseau.
    const local = parseLocalCommand(messageUtilisateur, stateRef.current);
    if (local) return { text: local.text, actions: local.actions };
    try {
        // Préparer un résumé de l'état du DAW pour le contexte
        const currentState = stateRef.current;
        const stateSummary = {
            bpm: currentState.bpm,
            isPlaying: currentState.isPlaying,
            isRecording: currentState.isRecording,
            currentTime: Math.round(currentState.currentTime * 100) / 100,
            selectedTrackId: currentState.selectedTrackId,
            trackCount: currentState.tracks.length,
            currentView: currentState.currentView,
            timeSignature: currentState.timeSignature,
            metronome: currentState.metronome,
            isLoopActive: currentState.isLoopActive,
            loopStart: currentState.loopStart,
            loopEnd: currentState.loopEnd,
            projectKey: currentState.projectKey,
            projectScale: currentState.projectScale,
            vocalMixStyle: currentState.vocalMixStyle || null,
            autoCleanSilence: autoCleanRef.current,
            sessionPart,
            // Ce que « l'oreille » de Nova mesure : niveaux réels des prises et du beat.
            mixLevels: (() => {
              try {
                const r = analyseMix(currentState.tracks, c => (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined) || c.buffer || audioEngine.getAudioBuffer(c.id), currentState.vocalMixStyle);
                return { levels: levelsForAI(r), issues: r.issues.map(i => ({ title: i.title, target: i.target, fix: i.fix?.actions })) };
              } catch { return null; }
            })(),
            markers: currentState.markers.map(m => ({ id: m.id, name: m.name, time: m.time })),
            trackGroups: currentState.trackGroups.map(g => ({ id: g.id, name: g.name, trackIds: g.trackIds })),
            // Les id sont indispensables : les actions de l'IA ciblent les pistes,
            // les clips et les effets par identifiant.
            tracks: currentState.tracks.map(t => ({
                id: t.id,
                name: t.name,
                role: getVocalRole(t),
                type: t.type,
                volume: Math.round(t.volume * 100) / 100,
                pan: t.pan,
                isMuted: t.isMuted,
                isSolo: t.isSolo,
                isTrackArmed: t.isTrackArmed,
                isFrozen: t.isFrozen,
                outputTrackId: t.outputTrackId,
                sends: t.sends.map(s => ({ id: s.id, level: s.level, isEnabled: s.isEnabled })),
                plugins: t.plugins.map(p => ({ id: p.id, type: p.type, isEnabled: p.isEnabled })),
                clips: t.clips.map(c => ({ id: c.id, name: c.name, type: c.type, start: c.start, duration: c.duration, isMuted: c.isMuted, noteCount: c.notes?.length || 0 })),
                automation: t.automationLanes.filter(l => l.points.length > 0).map(l => ({ parameter: l.parameterName, pointCount: l.points.length }))
            }))
        };

        // Détecter si on est sur GitHub Pages (pas d'API backend)
        // Dans ce cas, utiliser l'API Vercel directement
        const isGitHubPages = window.location.hostname.includes('github.io');
        const apiBaseUrl = isGitHubPages 
            ? 'https://nova-studio-daw-0901.vercel.app'  // URL Vercel
            : '';  // URL relative (même domaine)
        
        const body = JSON.stringify({ message: messageUtilisateur, state: stateSummary });
        const ask = (base: string) => fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        let response = await ask(apiBaseUrl).catch(() => null);
        let data: any = response ? await response.clone().json().catch(() => ({})) : {};
        // Déploiement sans clé d'IA (ou API injoignable) : on passe par le
        // déploiement de référence, qui en a une. Sans ça Nova restait muet.
        if (!response || !response.ok || data?.error === 'API key missing') {
            const FALLBACK = 'https://nova-studio-daw-0901.vercel.app';
            if (window.location.origin !== FALLBACK) {
                response = await ask(FALLBACK).catch(() => null);
                data = response ? await response.json().catch(() => ({})) : {};
            }
        }
        if (!response || !response.ok) {
            throw new Error(data?.error || `Erreur serveur: ${response?.status ?? 'réseau'}`);
        }
        
        return {
            text: data.text || "J'ai bien reçu ton message.",
            actions: data.actions || []
        };

    } catch (error: any) {
        console.error("Erreur Chatbot:", error);
        return {
            text: `Erreur de connexion: ${error.message || 'Serveur inaccessible'}`,
            actions: []
        };
    }
  };

  // Auth temporairement désactivée pour éviter écran noir
  // if (!user) { return <AuthScreen onAuthenticated={(u) => { setUser(u); setIsAuthOpen(false); }} />; }

  // Afficher la Landing Page si c'est la première visite
  if (showLanding) {
    return (
      <LandingPage 
        user={user}
        onEnterStudio={handleEnterStudio}
        onEnterWithInstrumental={handleEnterWithInstrumental}
        onEnterWithAudioFile={handleEnterWithAudioFile}
        onEnterWithProject={handleEnterWithProject}
        savedSession={savedSessionMeta}
        onResumeSession={handleResumeSession}
        onLogin={(u) => setUser(u)}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden relative transition-colors duration-300" style={{ backgroundColor: 'var(--bg-main)', color: 'var(--text-primary)' }}>
      {saveState.isSaving && <SaveOverlay progress={saveState.progress} message={saveState.message} />}

      {/* TransportBar - Desktop, Tablet ET Mobile avec menu hamburger */}
      <div className="relative z-50">
        <TransportBar
          isPlaying={state.isPlaying} currentTime={state.currentTime} bpm={state.bpm} onBpmChange={handleUpdateBpm}
          isRecording={state.isRecording} isLoopActive={state.isLoopActive}
          onToggleLoop={() => setState(p => ({ ...p, isLoopActive: !p.isLoopActive }))}
          isMetronomeEnabled={state.metronome.enabled}
          onToggleMetronome={handleToggleMetronome}
          onStop={handleStop} onTogglePlay={handleTogglePlay} onToggleRecord={handleToggleRecord}
          currentView={state.currentView} onChangeView={v => setState(s => ({...s, currentView: v}))}
          statusMessage={externalImportNotice} noArmedTrackError={noArmedTrackError}
          currentTheme={theme} onToggleTheme={toggleTheme}
          onOpenSaveMenu={() => setIsSaveMenuOpen(true)} onOpenLoadMenu={() => setIsLoadMenuOpen(true)}
          onExportMix={handleExportMix} onShareProject={() => setIsShareModalOpen(true)}
          onOpenAudioEngine={() => setIsAudioSettingsOpen(true)} isDelayCompEnabled={state.isDelayCompEnabled}
          onToggleDelayComp={handleToggleDelayComp} onUndo={undo} onRedo={redo} canUndo={canUndo} canRedo={canRedo}
          user={user} onOpenAuth={() => setIsAuthOpen(true)} onLogout={handleLogout}
          isSidebarOpen={isSidebarOpen} onToggleSidebar={toggleSidebar}
          onImportAudio={handleNewAudioImport}
          isMobileLayout={isMobile}
        >
          <div className="ml-4 border-l border-white/5 pl-4"><ViewModeSwitcher currentMode={viewMode} onChange={handleViewModeChange} /></div>
        </TransportBar>
      </div>
      
      {/* Admin Template Button - Visible uniquement pour l'admin */}
      {user && user.email.toLowerCase() === 'romain.scheyvaerts@gmail.com' && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[100]">
          <AdminTemplateButton user={user} tracks={state.tracks} bpm={state.bpm} />
        </div>
      )}
      
      {/* Sur téléphone, le « + » ne sert que dans Pistes et Arrangement ; ailleurs
          il couvrait du contenu (saisie du chat Nova, liste des effets). */}
      {(!isMobile || activeMobileTab === 'TRACKS' || activeMobileTab === 'ARRANGEMENT') && (
        <TrackCreationBar
          onCreateTrack={handleCreateTrack}
          onOpenVocalTools={() => setVocalToolsOpen(true)}
          onOpenLyrics={() => setLyricsOpen(o => !o)}
          lyricsOpen={lyricsOpen}
          currentStyleId={state.vocalMixStyle}
        />
      )}
      <TouchInteractionManager />

      <div className="flex-1 flex overflow-hidden relative">
        {isSidebarOpen && !isMobile && (
            <aside className="shrink-0 z-10">
                <SideBrowser2
                    user={user} activeTab={activeSideBrowserTab} onTabChange={setActiveSideBrowserTab}
                    onAddPlugin={handleAddPluginFromContext}
                    onPurchase={handleBuyLicense} selectedTrackId={state.selectedTrackId}
                    onLoadBeat={handleLoadCatalogBeat}
                />
            </aside>
        )}
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
          {/* Mode Desktop/Tablet - Vues classiques */}
          {!isMobile && (
            <>
              {state.currentView === 'ARRANGEMENT' && (
                <ArrangementView
                   tracks={state.tracks} currentTime={state.currentTime} isLoopActive={state.isLoopActive} loopStart={state.loopStart} loopEnd={state.loopEnd}
                   onSetLoop={(start, end) => setState(prev => ({ ...prev, loopStart: start, loopEnd: end, isLoopActive: true }))}
                   onSeek={handleSeek} bpm={state.bpm} selectedTrackId={state.selectedTrackId} onSelectTrack={id => setState(p => ({ ...p, selectedTrackId: id }))}
                   onUpdateTrack={handleUpdateTrack} onReorderTracks={handleReorderTracks}
                   onDropPluginOnTrack={(trackId, type, metadata) => handleAddPluginFromContext(trackId, type, metadata, { openUI: true })}
                   onSelectPlugin={async (tid, p) => { await ensureAudioEngine(); setActivePlugin({trackId:tid, plugin:p}); }}
                   onRemovePlugin={handleRemovePlugin} onRequestAddPlugin={(tid, x, y) => setAddPluginMenu({ trackId: tid, x, y })}
                   onAddTrack={handleCreateTrack} onDuplicateTrack={handleDuplicateTrack} onDeleteTrack={handleDeleteTrack}
                   onFreezeTrack={handleFreezeTrack}
                   onEditClip={handleEditClip} isRecording={state.isRecording} isPlaying={state.isPlaying} recStartTime={state.recStartTime}
                   onMoveClip={handleMoveClip} onEditMidi={(trackId, clipId) => setMidiEditorOpen({ trackId, clipId })}
                   onCreatePattern={handleCreatePatternAndOpen} onSwapInstrument={handleSwapInstrument}
                   onMoveClipsBy={handleMoveClipsBy}
                   onAudioDrop={(trackId, url, name, time) => {
                     // Beat du catalogue : même chemin que « Essayer » (remplace le beat, règle tempo et Auto-Tune).
                     const beat = takeDraggedBeat(url);
                     if (beat) return loadCatalogBeatRef.current?.(beat);
                     return handleUniversalAudioImport(url, name, trackId, time);
                   }}
                   markers={state.markers} onAddMarker={handleAddMarker}
                   onUpdateMarker={handleUpdateMarker} onDeleteMarker={handleDeleteMarker}
                />
              )}

              {state.currentView === 'MIXER' && (
                 <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-[11px]"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement…</div>}><MixerView
                    tracks={state.tracks} onUpdateTrack={handleUpdateTrack}
                    onOpenPlugin={async (tid, p) => { await ensureAudioEngine(); setActivePlugin({trackId:tid, plugin:p}); }}
                    onDropPluginOnTrack={(trackId, type, metadata) => handleAddPluginFromContext(trackId, type, metadata, { openUI: true })}
                    onRemovePlugin={handleRemovePlugin} onAddBus={handleAddBus} onToggleBypass={handleToggleBypass}
                    onRequestAddPlugin={(tid, x, y) => setAddPluginMenu({ trackId: tid, x, y })}
                    onCopyPluginToTrack={handleCopyPluginToTrack} onReorderPlugins={handleReorderPlugins}
                    trackGroups={state.trackGroups} onCreateGroup={handleCreateGroup}
                    onUpdateGroup={handleUpdateGroup} onDeleteGroup={handleDeleteGroup}
                 /></Suspense>
              )}

              {state.currentView === 'AUTOMATION' && (
                 <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-[11px]"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement…</div>}><AutomationEditorView
                   tracks={state.tracks} currentTime={state.currentTime} bpm={state.bpm} zoomH={40}
                   onUpdateTrack={handleUpdateTrack} onSeek={handleSeek}
                 /></Suspense>
              )}
            </>
          )}

          {/* Mode Mobile - Nouveau système de pages */}
          {isMobile && (
            <>
              {activeMobileTab === 'TRACKS' && (
                <MobileTracksPage
                  tracks={state.tracks}
                  currentTime={state.currentTime}
                  isPlaying={state.isPlaying}
                  isRecording={state.isRecording}
                  selectedTrackId={state.selectedTrackId}
                  onSelectTrack={id => setState(p => ({ ...p, selectedTrackId: id }))}
                  onUpdateTrack={handleUpdateTrack}
                  onRemovePlugin={handleRemovePlugin}
                  onOpenPlugin={async (tid, p) => { await ensureAudioEngine(); const plugin = state.tracks.find(t => t.id === tid)?.plugins.find(pl => pl.id === p); if (plugin) setActivePlugin({trackId: tid, plugin}); }}
                  onToggleBypass={handleToggleBypass}
                  onRequestAddPlugin={handleRequestAddPlugin}
                  onImportAudioToBeat={(file: File) => handleUniversalAudioImport(file, file.name, 'instrumental', 0)}
                  onOpenCatalog={() => setActiveMobileTab('BROWSER')}
                />
              )}

              {activeMobileTab === 'ARRANGEMENT' && (
                <MobileArrangementPage
                  tracks={state.tracks}
                  currentTime={state.currentTime}
                  isPlaying={state.isPlaying}
                  bpm={state.bpm}
                  selectedTrackId={state.selectedTrackId}
                  onSelectTrack={id => setState(p => ({ ...p, selectedTrackId: id }))}
                  onSeek={handleSeek}
                  onUpdateClip={(trackId, clipId, updates) => handleEditClip(trackId, clipId, 'UPDATE_PROPS', updates)}
                  onSelectClip={(trackId, clip) => setState(p => ({ ...p, selectedTrackId: trackId }))}
                  onTogglePlay={handleTogglePlay}
                  onStop={handleStop}
                  onUpdateTrack={handleUpdateTrack}
                  onDeleteClip={(trackId, clipId) => handleEditClip(trackId, clipId, 'DELETE')}
                  onDuplicateClip={(trackId, clipId) => handleEditClip(trackId, clipId, 'DUPLICATE')}
                  onSplitClip={(trackId, clipId, splitTime) => handleEditClip(trackId, clipId, 'SPLIT', { time: splitTime })}
                  onCopyClip={(trackId, clip) => handleEditClip(trackId, clip.id, 'COPY')}
                  onPasteClip={(trackId, time) => handleEditClip(trackId, '', 'PASTE', { time })}
                  onUpdateSend={(trackId, sendId, level, isEnabled) => setState(produce((draft: DAWState) => {
                    const t = draft.tracks.find(tr => tr.id === trackId);
                    const send = t?.sends.find(sd => sd.id === sendId);
                    if (send) { send.level = level; send.isEnabled = isEnabled; }
                  }))}
                  onRequestAddPlugin={handleRequestAddPlugin}
                />
              )}

              {activeMobileTab === 'MIXER' && (
                <MobileMixerPage
                  tracks={state.tracks}
                  selectedTrackId={state.selectedTrackId}
                  onSelectTrack={id => setState(p => ({ ...p, selectedTrackId: id }))}
                  onUpdateTrack={handleUpdateTrack}
                  onRemovePlugin={handleRemovePlugin}
                  onOpenPlugin={async (tid, p) => { await ensureAudioEngine(); const plugin = state.tracks.find(t => t.id === tid)?.plugins.find(pl => pl.id === p); if (plugin) setActivePlugin({trackId: tid, plugin}); }}
                  onToggleBypass={handleToggleBypass}
                  onRequestAddPlugin={handleRequestAddPlugin}
                />
              )}

              {activeMobileTab === 'PLUGINS' && (
                <MobilePluginsPage
                  tracks={state.tracks}
                  onOpenPlugin={async (tid, p) => { await ensureAudioEngine(); const plugin = state.tracks.find(t => t.id === tid)?.plugins.find(pl => pl.id === p); if (plugin) setActivePlugin({trackId: tid, plugin}); }}
                  onToggleBypass={handleToggleBypass}
                  onRemovePlugin={handleRemovePlugin}
                />
              )}

              {activeMobileTab === 'BROWSER' && (
                <MobileBrowserPage
                  user={user}
                  onAddPlugin={handleAddPluginFromContext}
                  onPurchase={handleBuyLicense}
                  onLoadBeat={handleLoadCatalogBeat}
                  selectedTrackId={state.selectedTrackId}
                />
              )}
            </>
          )}
        </main>
      </div>
      
      {/* Avancement des imports et des calages.
          Le message existait deja mais n'etait affiche nulle part : il etait
          passe a TransportBar en prop statusMessage, declaree et destructuree,
          puis jamais rendue. Charger un beat ouvrait donc un studio vide
          pendant plusieurs secondes, sans le moindre signe d'activite. */}
      {externalImportNotice && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[1500] px-4 py-2.5 rounded-xl
                        bg-[#14161a]/95 border border-white/10 shadow-2xl backdrop-blur-sm
                        flex items-center gap-2.5 text-[12px] font-medium text-slate-200
                        animate-in fade-in slide-in-from-top-2 duration-200">
          {!/^[✅❌]/.test(externalImportNotice) && (
            <i className="fas fa-circle-notch fa-spin text-cyan-400"></i>
          )}
          <span>{externalImportNotice}</span>
        </div>
      )}

      {isMobile && <MobileBottomNav activeTab={activeMobileTab} onTabChange={setActiveMobileTab} novaBadge={novaUnread} />}

      <VocalToolsPanel
        open={vocalToolsOpen}
        onClose={() => setVocalToolsOpen(false)}
        currentStyleId={state.vocalMixStyle}
        onApplyStyle={handleApplyMixStyle}
        canClean={!!getTargetVoiceTrack()?.clips.length}
        onCleanSilences={() => { const t = getTargetVoiceTrack(); if (t) handleCleanSilences(t.id); }}
        autoClean={autoCleanSilence}
        onAutoCleanChange={setAutoCleanSilence}
        countIn={countInEnabled}
        onCountInChange={setCountInEnabled}
        monitoring={inputMonitoring}
        onMonitoringChange={setInputMonitoring}
        isPlaying={state.isPlaying}
        onTogglePlay={handleTogglePlay}
        hasCatalogBeat={!!getCatalogBeat(state.tracks)}
        onBuyBeat={() => openBuyBeat(stateRef.current.tracks)}
        onProMix={openProMix}
        onBookSession={openStudioSession}
        onShare={() => { setVocalToolsOpen(false); setShareOpen(true); }}
        onOpenDrums={() => { setVocalToolsOpen(false); setDrumsOpen(true); }}
        hasDrums={!!state.tracks.find(t => t.id === DRUM_TRACK_ID)}
        takeGroups={state.tracks.filter(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId)
          .map(t => ({ trackId: t.id, trackName: t.name, takes: listTakes(t) }))}
        onSelectTake={(trackId, n, listen) => {
          const t = stateRef.current.tracks.find(x => x.id === trackId);
          if (!t) return;
          (selectTakeActions(t, n) || []).forEach(a => executeAIAction(a));
          const take = listTakes(t).find(x => x.n === n);
          if (listen && take) { handleSeek(take.start); if (!stateRef.current.isPlaying) void handleTogglePlay(); }
        }}
        onAskNova={() => { setVocalToolsOpen(false); if (isMobile) setActiveMobileTab('NOVA'); setMixGuideRequest(n => n + 1); }}
      />

      <WelcomeSteps
        open={welcomeOpen}
        beatLoaded={!!state.tracks.find(t => t.id === 'instrumental')?.clips.length}
        isMobile={isMobile}
        onPickBeat={() => {
          closeWelcome();
          if (isMobile) setActiveMobileTab('BROWSER');
          else { setIsSidebarOpen(true); setActiveSideBrowserTab('STORE'); }
        }}
        onClose={closeWelcome}
      />

      <LyricsPrompter
        open={lyricsOpen}
        onClose={() => setLyricsOpen(false)}
        lyrics={state.lyrics || ''}
        onLyricsChange={text => setState(prev => ({ ...prev, lyrics: text }))}
        start={state.lyricsStart ?? 0}
        onStartChange={t => setState(prev => ({ ...prev, lyricsStart: Math.max(0, t) }))}
        speed={state.lyricsSpeed ?? 16}
        onSpeedChange={v => setState(prev => ({ ...prev, lyricsSpeed: v }))}
        isPlaying={state.isPlaying}
        isRecording={state.isRecording}
        currentTime={state.currentTime}
      />

      <RecordingCoach
        isRecording={state.isRecording}
        trackId={state.tracks.find(t => t.isTrackArmed)?.id || null}
        trackName={state.tracks.find(t => t.isTrackArmed)?.name}
        partLabel={SESSION_LABEL[sessionPart]}
      />

      {/* Décompte avant la prise (tap = annuler) */}
      {countInBeat !== null && (
        <button
          type="button"
          onClick={() => { countInCancelRef.current = true; }}
          className="fixed inset-0 z-[600] flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm"
          aria-label="Annuler le décompte"
        >
          <span className="text-[9rem] leading-none font-black text-white drop-shadow-[0_0_30px_rgba(239,68,68,0.6)]">{countInBeat}</span>
          <span className="mt-4 text-sm font-bold text-red-300 uppercase tracking-widest">Prépare-toi… (touche pour annuler)</span>
        </button>
      )}

      {/* Casque : demandé avant la première prise */}
      {headphonePromptOpen && (
        <div className="fixed inset-0 z-[600] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="casque-titre">
          <div className="w-full max-w-sm rounded-3xl bg-[#14161a] border border-white/10 p-6 text-center shadow-2xl">
            <div className="text-5xl mb-3">🎧</div>
            <h2 id="casque-titre" className="text-lg font-black text-white mb-2">Tu as un casque ou des écouteurs ?</h2>
            <p className="text-sm text-slate-300 mb-5">
              Avec un casque, tu entends ta voix pendant que tu enregistres. Sans casque, on coupe ce retour
              pour éviter le larsen : tu entends seulement le beat.
            </p>
            {/* Test du micro avant la toute première prise */}
            <div className="mb-5">
              <MicLevelMeter trackId={state.tracks.find(t => t.isTrackArmed)?.id || null} />
            </div>
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => answerHeadphones(true)} className="h-12 rounded-xl bg-cyan-500 text-black font-black">
                Oui, j'ai un casque
              </button>
              <button type="button" onClick={() => answerHeadphones(false)} className="h-12 rounded-xl bg-white/10 text-white font-bold">
                Non, haut-parleurs
              </button>
            </div>
            <p className="mt-3 text-xs text-slate-400">Conseil : un casque filaire donne le meilleur résultat (le Bluetooth ajoute du retard).</p>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
      {isSaveMenuOpen && <SaveProjectModal isOpen={isSaveMenuOpen} onClose={() => setIsSaveMenuOpen(false)} currentName={state.name} user={user} onSaveCloud={handleSaveCloud} onSaveLocal={handleSaveLocal} onSaveAsCopy={handleSaveAsCopy} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isLoadMenuOpen && <LoadProjectModal isOpen={isLoadMenuOpen} onClose={() => setIsLoadMenuOpen(false)} user={user} onLoadCloud={handleLoadCloud} onLoadLocal={handleLoadLocalFile} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isExportMenuOpen && <ExportModal isOpen={isExportMenuOpen} onClose={() => setIsExportMenuOpen(false)} projectState={state} ownedInstrumentIds={user?.owned_instruments || []} onOpenShare={() => { setIsExportMenuOpen(false); setShareOpen(true); }} />}
      <DrumMachinePanel
        open={drumsOpen}
        onClose={() => setDrumsOpen(false)}
        dm={(state.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine) || null}
        onChange={dm => applyDrumMachine(dm)}
        onKit={kitId => { void ensureAudioEngine().then(() => handleSetDrumKit(kitId)); }}
        onRemove={() => { handleRemoveDrums(); setDrumsOpen(false); }}
        onAudition={ri => { void ensureAudioEngine().then(() => audioEngine.triggerTrackAttack(DRUM_TRACK_ID, 60 + ri, 1)); }}
        isPlaying={state.isPlaying}
        onTogglePlay={handleTogglePlay}
        bpm={state.bpm}
        clipStart={0}
      />
      <ShareClipModal open={shareOpen} onClose={() => setShareOpen(false)} state={state} onBuyBeat={() => openBuyBeat(stateRef.current.tracks)} />
      {isAuthOpen && <AuthScreen onAuthenticated={(u) => { setUser(u); setIsAuthOpen(false); }} />}
      </Suspense>
      
      {addPluginMenu && <ContextMenu x={addPluginMenu.x} y={addPluginMenu.y} onClose={() => setAddPluginMenu(null)} items={AVAILABLE_FX_MENU.map(fx => ({ label: fx.name, icon: fx.icon, onClick: () => handleAddPluginFromContext(addPluginMenu.trackId, fx.id as PluginType, {}, { openUI: true }) }))} />}
      {automationMenu && <ContextMenu x={automationMenu.x} y={automationMenu.y} onClose={() => setAutomationMenu(null)} items={[{ label: `Automate: ${automationMenu.paramName}`, icon: 'fa-wave-square', onClick: handleCreateAutomationLane }]} />}
      
      {midiEditorOpen && state.tracks.find(t => t.id === midiEditorOpen.trackId) && (
          <div className="fixed inset-0 z-[250] bg-[#0c0d10] flex flex-col animate-in slide-in-from-bottom-10 duration-200">
             <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-[11px]"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement de l'éditeur…</div>}>
               <PianoRoll track={state.tracks.find(t => t.id === midiEditorOpen.trackId)!} clipId={midiEditorOpen.clipId} bpm={state.bpm} currentTime={state.currentTime} onUpdateTrack={handleUpdateTrack} onClose={() => setMidiEditorOpen(null)} />
             </Suspense>
          </div>
      )}
      
      {activePlugin && (
        <div className={`fixed inset-0 flex items-center justify-center z-[200] ${isMobile ? 'bg-[#0c0d10]' : 'bg-black/60 backdrop-blur-sm'}`} onMouseDown={() => !isMobile && setActivePlugin(null)}>
           <div className={`relative ${isMobile ? 'w-full h-full p-4 overflow-y-auto' : ''}`} onMouseDown={e => e.stopPropagation()}>
              <Suspense fallback={<div className="w-64 h-32 flex items-center justify-center text-slate-400 text-[11px] bg-[#14161a] border border-white/10 rounded-2xl"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement…</div>}>
              <PluginEditor plugin={activePlugin.plugin} trackId={activePlugin.trackId} onClose={() => setActivePlugin(null)} onUpdateParams={(p) => handleUpdatePluginParams(activePlugin.trackId, activePlugin.plugin.id, p)} isMobile={isMobile} track={state.tracks.find(t => t.id === activePlugin.trackId)} onUpdateTrack={handleUpdateTrack} />
              </Suspense>
           </div>
        </div>
      )}

      <Suspense fallback={null}>
      {isPluginManagerOpen && <PluginManager onClose={() => setIsPluginManagerOpen(false)} onPluginsDiscovered={(plugins) => { console.log("Plugins refreshed:", plugins.length); setIsPluginManagerOpen(false); }} />}
      {isAudioSettingsOpen && <AudioSettingsPanel onClose={() => setIsAudioSettingsOpen(false)} />}
      </Suspense>
      
      <div className={isMobile && activeMobileTab !== 'NOVA' ? 'hidden' : ''}>
        <ChatAssistant
            onSendMessage={envoyerAuChatbot}
            onExecuteAction={executeAIAction}
            projectState={state}
            externalNotification={aiNotification}
            isMobile={isMobile}
            forceOpen={isMobile && activeMobileTab === 'NOVA'}
            mixGuideRequest={mixGuideRequest}
            novaFeed={novaFeed}
            onClose={() => setActiveMobileTab('TRACKS')}
        />
      </div>
      
      {isShareModalOpen && user && <ShareModal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} onShare={handleShareProject} projectName={state.name} />}
      
      {/* Modal Récupération de Backup Automatique */}
      {showBackupRecovery && pendingBackup && (
        <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-white/5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-xl bg-amber-500/20 flex items-center justify-center">
                  <i className="fas fa-clock-rotate-left text-amber-400 text-xl"></i>
                </div>
                <div>
                  <h3 className="text-lg font-black text-white">Backup trouvé !</h3>
                  <p className="text-xs text-slate-500">Votre travail précédent a été récupéré</p>
                </div>
              </div>
              <p className="text-sm text-slate-400">
                Nous avons trouvé une sauvegarde automatique de votre session précédente. 
                Voulez-vous restaurer ce projet ?
              </p>
            </div>
            
            <div className="p-4 bg-black/20 space-y-3">
              <button
                onClick={() => {
                  handleLoadProject(pendingBackup);
                  setShowBackupRecovery(false);
                  setPendingBackup(null);
                  setAiNotification("✅ Backup restauré avec succès !");
                }}
                className="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-bold rounded-xl hover:opacity-90 transition-all flex items-center justify-center gap-2"
              >
                <i className="fas fa-check"></i>
                Restaurer le backup
              </button>
              
              <button
                onClick={() => {
                  setShowBackupRecovery(false);
                  setPendingBackup(null);
                }}
                className="w-full py-3 px-4 bg-white/5 border border-white/10 text-slate-400 font-medium rounded-xl hover:bg-white/10 hover:text-white transition-all flex items-center justify-center gap-2"
              >
                <i className="fas fa-times"></i>
                Ignorer et commencer un nouveau projet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
