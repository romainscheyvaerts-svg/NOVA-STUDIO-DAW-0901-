import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { Track, TrackType, DAWState, ProjectPhase, PluginInstance, PluginType, MobileTab, TrackSend, Clip, AIAction, AutomationLane, AIChatMessage, ViewMode, User, Theme, DrumPad, Marker, TrackGroup, CollabRole } from './types';
import { audioEngine } from './engine/AudioEngine';
import TransportBar from './components/TransportBar';
import MobileTransport from './components/MobileTransport';
import AdminTemplateButton from './components/AdminTemplateButton';
import ArrangementView from './components/ArrangementView';
const MixerView = lazy(() => import('./components/MixerView').then(m => ({ default: React.memo(m.default) })));
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
import { dailyChallengeId } from './utils/dailyChallenge';
import { detectSections, sectionColor } from './utils/songSections';
import { SessionSerializer } from './services/SessionSerializer';
// import { getAIProductionAssistance } from './services/AIService'; 
import { novaBridge, BridgePlugin } from './services/NovaBridge';
import { clearInstrumentRender, instrumentFromPlugin, isInstrumentRenderCurrent } from './services/VstInstrument';
import { useVstInstruments } from './hooks/useVstInstruments';
import VstInstrumentPicker from './components/VstInstrumentPicker';
import Bass808Controls from './components/Bass808Controls';
import { BASS808_TRACK_ID, kit808Style, starter808Notes } from './utils/bass808';
import LicenseNotice from './components/LicenseNotice';
import { vstStateEvents } from './engine/VSTPluginNode';
import { renderTrackFreeze, renderTrackPreview, tracksNeedingVstRender, renderRangeFor, syncLiveVstStates, FreezeResult, applyFreezeResult, busesNeedingVstRender, renderBusFreeze, applyBusFreezeResult, BusFreezeResult } from './services/VstFreeze';
import { canBakeTrack, hasVst, freezeSignature, trackBufferIds } from './utils/freeze';
import { getEditAuthor, setEditAuthor } from './utils/preFxEdits';
import { usePreFxReplay } from './hooks/usePreFxReplay';
import { mergeSessionEdits } from './utils/preFxMerge';
import PreFxReplayPanel from './components/PreFxReplayPanel';
import FrozenEditsNotice from './components/FrozenEditsNotice';
import { recFreezeStore } from './utils/recFreezeStore';
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
import { openBuyBeat, openProMix, openStudioSession, openBattle, getCatalogBeat } from './utils/studioLinks';
import { parseLocalCommand } from './utils/novaCommands';
import { listTakes, selectTakeActions, takeNumberOf, compTakeInZone, activeTakeInZone, CompZone } from './utils/takes';
import { playheadStore } from './utils/playheadStore';
import { useLatestCallback } from './utils/useLatestCallback';
import RecordingCoach from './components/RecordingCoach';
import LyricsPrompter from './components/LyricsPrompter';
import MicLevelMeter from './components/MicLevelMeter';
import WelcomeSteps from './components/WelcomeSteps';
import ShareClipModal from './components/ShareClipModal';
import TakeHomeModal from './components/TakeHomeModal';
import ProGateModal from './components/ProGateModal';
import CollabPanel, { CollabMessage } from './components/CollabPanel';
import { CollabClient, CollabMember, CollabOp, ROLE_LABEL, ensureBuffers, uploadBuffers, contentOf, contentBufferIds, mixOf, sigOf, ownsContent } from './services/Collab';
import { collabRoleStore } from './utils/collabStore';
import { localCollabOutboxStore } from './utils/collabOutbox';
import { applyMixFields, touchesPlugins, changedFields, fieldSig, fieldSigsOf, legacyMixToFields, LwwClock, MixFields, mixFieldsOf } from './utils/collabMerge';
import { CollabStatus, collabStatusView } from './utils/collabStatus';
import RemoteIngePanel from './components/RemoteIngePanel';
import LiveVstRemotePanel from './components/LiveVstRemotePanel';
import { useRemoteInge } from './hooks/useRemoteInge';
import { parseRemoteLink } from './utils/remoteInge';
import { applyRemoteVstParams, catalogOf, LIVE_VST_KINDS, LiveVstDeps, readRemoteVstParams, VstCatalogEntry, VstParamAck, VstParamsReply, VstRemoteRequests } from './services/LiveVstRemote';
import { liveVstNodes } from './engine/VSTPluginNode';
import { anchorClipsToWindow, applyPreviewOnEngineer, clearPreviewOnEngineer, hasArtistVst, LIVE_PREVIEW_KINDS, PREVIEW_TAIL, PreviewScheduler, PreviewState, PreviewTracker, previewView, previewWindowOf } from './services/LivePreview';
import { openCheckout, waitPaid, billingStatus, hasPlan, verifyPayment } from './services/Billing';
import { catalogSupabase } from './services/supabase';
import { fetchAudio } from './utils/audioCache';
import { gainToDbText } from './utils/db';
import { isNovaDesktop } from './utils/desktopApp';
import { AutotuneVstManager } from './components/AutotuneVstPanel';
import { handleNovaVstAction, VST_ACTIONS } from './services/NovaVstMix';
import { novaVstEvents } from './engine/VSTPluginNode';
import {
  pushSession, pullSession, parseLink, createCloudSession, cloudProjectId, CloudConflictError, LocalCloudSession,
  getLocalCloudSession, setLocalCloudSession, CloudLink, adoptSiteSession, sessionUrl, signInAccount,
} from './services/SessionCloud';
import DrumMachinePanel from './components/DrumMachinePanel';
import ShortcutsHelp from './components/ShortcutsHelp';
import { DrumMachine, makeDrumMachineLib, drumPadsFor, drumClipFor, suggestDrumKit, DRUM_KITS } from './utils/drumKits';
import { loadDrumSound } from './utils/drumSounds';
import { saveSession, loadSession, getSessionMeta, SavedSessionMeta, formatAgo } from './utils/sessionStore';
import VocalToolsPanel from './components/VocalToolsPanel';
import NextStepCard, { NextStepAction } from './components/NextStepCard';
import { track, trackOnce } from './utils/analytics';
import { simpleModeStore, useSimpleMode } from './utils/simpleMode';
import { planRecording, trimTake, cutAroundPunch, punchXfadeSec, punchFromRange, quickPunchStopDelay, hasPunchZone } from './utils/punch';
import { editSelectionStore } from './utils/editSelection';
import { useEditCommands } from './hooks/useEditCommands';

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
  else if (/\bMIN\b|MINOR|\bM\b(?!AJ)/.test(texte)) scale = 'MINOR';
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

/** Empreinte de la reverb voix du studio (public/ir), relative à la base du site. */
const MAKE_MUSIC_VOCAL_IR = `${import.meta.env.BASE_URL}ir/make-music-vocal.wav`;

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
    // Reverb des voix du studio : empreinte de la reverb utilisée chez Make Music
    // (Slate VerbSuite Classics, FG-480 « Silica Beads », preset NKF), capturée
    // avec bridge-python/capture_ir.py. Pré-délai, EQ et chorus sont dans l'empreinte.
    plugins: [createDefaultPlugins('REVERB', 1.0, bpm, {
      irUrl: MAKE_MUSIC_VOCAL_IR, name: 'Make Music · FG-480 Silica Beads',
      decay: 1.2, preDelay: 0, size: 0.4, mode: 'PLATE', erLevel: 0, modDepth: 0, bassBoost: 0,
      lowCut: 20, highCut: 20000, width: 1, ducking: 0,
    })],
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
    // Le rendu gele est desormais sauvegarde (effets VST3 du PC rendus dans
    // l'audio) : on le garde. Seule une piste gelee SANS son audio repasse en direct.
    tracks: tracks.map(t => (t.isFrozen && !t.frozenClip ? { ...t, isFrozen: false } : t)),
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
  // lastChangeAt : heure de la dernière modification RÉELLE du projet (pas une
  // sélection ni un changement de vue), pour l'anti-rebond des entrées.
  const [history, setHistory] = useState<{ past: DAWState[]; present: DAWState; future: DAWState[]; lastChangeAt?: number }>({ past: [], present: initialState, future: [] });
  const MAX_HISTORY = 100;
  const HISTORY_DEBOUNCE_MS = 300; // Debounce 300ms pour éviter trop d'entrées

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
    // L'heure est prise ici (le reducer reste pur) ; l'anti-rebond se mesure
    // depuis la dernière modification réelle : sélectionner une piste juste
    // avant un glisser ne fond plus ce glisser dans l'entrée précédente.
    const maintenant = Date.now();

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
      const antiRebond = maintenant - (curr.lastChangeAt || 0) < HISTORY_DEBOUNCE_MS;
      if (antiRebond) return { ...curr, present: newState, lastChangeAt: maintenant };

      const cleanedPresentForHistory = cleanStateForHistory(curr.present);

      return { past: [...curr.past, cleanedPresentForHistory].slice(-MAX_HISTORY), present: newState, future: [], lastChangeAt: maintenant };
    });
  }, []);

  const setVisualState = useCallback((updater: Partial<DAWState>) => { setHistory(curr => ({ ...curr, present: { ...curr.present, ...updater } })); }, []);
  // Projet modifié SANS étape d'annulation (rendu d'un instrument VST qui suit les notes).
  const setSilently = useCallback((fn: (prev: DAWState) => DAWState) => { setHistory(curr => ({ ...curr, present: fn(curr.present) })); }, []);

  // Annuler / rétablir ne touche QUE au projet. Restaurer l'état entier
  // ramenait aussi isPlaying / isRecording / currentTime de l'instantané :
  // Ctrl+Z pendant la lecture affichait « arrêté » alors que le son
  // continuait, et pendant une prise il basculait l'enregistrement.
  const PROJECT_KEYS = ['tracks', 'bpm', 'name', 'markers', 'trackGroups', 'timeSignature', 'isLoopActive', 'loopStart', 'loopEnd', 'vocalMixStyle'] as const;
  const withProjectOf = (base: DAWState, snap: DAWState): DAWState => {
    const out: any = { ...base };
    for (const k of PROJECT_KEYS) out[k] = (snap as any)[k];
    return out as DAWState;
  };
  const undo = useCallback(() => { setHistory(curr => { if (curr.past.length === 0 || curr.present.isRecording) return curr; const snap = curr.past[curr.past.length - 1]; return { past: curr.past.slice(0, -1), present: withProjectOf(curr.present, snap), future: [cleanStateForHistory(curr.present), ...curr.future] }; }); }, []);
  const redo = useCallback(() => { setHistory(curr => { if (curr.future.length === 0 || curr.present.isRecording) return curr; const snap = curr.future[0]; return { past: [...curr.past, cleanStateForHistory(curr.present)], present: withProjectOf(curr.present, snap), future: curr.future.slice(1) }; }); }, []);

  // Un son supprimé doit rester en mémoire tant qu'une étape d'annulation y fait
  // référence : sinon Ctrl+Z ramenait un clip muet.
  const historyRef = useRef(history);
  historyRef.current = history;
  const isBufferInHistory = useCallback((bufferId: string) => {
    const h = historyRef.current;
    return [...h.past, ...h.future].some(s => s.tracks.some(t => trackBufferIds(t).includes(bufferId)));
  }, []);
  // Prochaine modification = nouvelle étape d'annulation, même dans l'anti-rebond.
  const breakHistory = useCallback(() => setHistory(curr => ({ ...curr, lastChangeAt: 0 })), []);
  return { state: history.present, setState, setVisualState, setSilently, undo, redo, isBufferInHistory, breakHistory, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
};

/** Onglet ouvert au retour de Stripe (?nova_paid=…) : confirme et invite à revenir au studio. */
function PaymentReturn({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<'wait' | 'ok' | 'ko'>('wait');
  useEffect(() => {
    let live = true;
    (async () => {
      for (let i = 0; i < 10 && live; i++) {
        try { const r = await verifyPayment(sessionId); if (r.paid) { setState('ok'); return; } } catch { /* */ }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (live) setState('ko');
    })();
    return () => { live = false; };
  }, [sessionId]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0b0d10] p-6 text-center text-white">
      <div className="max-w-sm space-y-3">
        <p className="text-4xl">{state === 'ok' ? '✅' : state === 'ko' ? '⏳' : '…'}</p>
        <h1 className="text-xl font-black">{state === 'ok' ? 'Paiement validé' : state === 'ko' ? 'Paiement en cours de validation' : 'Vérification du paiement…'}</h1>
        <p className="text-sm text-slate-300">{state === 'ok' ? "Tu peux fermer cet onglet : le studio s'est débloqué tout seul." : 'Reviens au studio : il se débloque dès que Stripe confirme.'}</p>
        <button type="button" onClick={() => window.close()} className="mt-2 h-11 rounded-xl bg-cyan-500 px-5 text-sm font-black text-black">Fermer cet onglet</button>
      </div>
    </div>
  );
}

export default function App() {
  const paidParam = (() => { try { return new URLSearchParams(window.location.search).get('nova_paid'); } catch { return null; } })();
  if (paidParam && /^cs_(test|live)_[A-Za-z0-9]+$/.test(paidParam)) return <PaymentReturn sessionId={paidParam} />;
  return <Studio />;
}

function Studio() {
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
  // « Faire une instru sur cette mélodie » (accueil, site ?melody=<id>)
  const pendingMelodyModeRef = useRef(false);
  const startMelodyProjectRef = useRef<((inst: any) => Promise<void>) | null>(null);
  const handleEnterWithMelody = (melody: any) => {
    pendingMelodyModeRef.current = true;
    setPendingInstrumental(melody);
    setShowLanding(false);
  };
  
  const handleEnterWithAudioFile = (file: File) => {
    setPendingAudioFile(file);
    setShowLanding(false);
  };
  
  const handleEnterWithProject = (project: any) => {
    // Le beat du catalogue n'est jamais dans le fichier (licence) : on le
    // recharge depuis le catalogue, comme pour « Reprendre ma session ».
    // Avant, un projet rouvert depuis un .zip affichait « 🚫 Licence requise »
    // et la piste du beat restait muette.
    restoreBeatAfterResumeRef.current = true;
    setPendingProject(project);
    setShowLanding(false);
  };

  // Dernière session sauvegardée sur l'appareil (« Reprendre ma session »)
  const [savedSessionMeta, setSavedSessionMeta] = useState<SavedSessionMeta | null>(null);
  useEffect(() => { getSessionMeta().then(setSavedSessionMeta).catch(() => {}); }, []);
  // Après une reprise : le beat du catalogue n'est pas dans la sauvegarde (licence),
  // on le recharge depuis le catalogue.
  const restoreBeatAfterResumeRef = useRef(false);
  const restoreCatalogBeatRef = useRef<(done: string) => Promise<void>>(async () => {});

  const handleResumeSession = async () => {
    const saved = await loadSession();
    if (!saved) { setSavedSessionMeta(null); return; }
    try {
      const project = await ProjectIO.loadProject(new File([saved.blob], 'session.novaproj.zip'));
      restoreBeatAfterResumeRef.current = true;
      handleEnterWithProject(project);
    } catch (e) {
      console.error('[Session] Reprise impossible, essai de la sauvegarde précédente', e);
      // La dernière sauvegarde est abîmée : on reprend l'avant-dernière.
      const prev = await loadSession('previous');
      if (prev) {
        try {
          const project = await ProjectIO.loadProject(new File([prev.blob], 'session.novaproj.zip'));
          restoreBeatAfterResumeRef.current = true;
          handleEnterWithProject(project);
          setAiNotification(`La dernière sauvegarde était abîmée : j'ai repris la précédente (${formatAgo(prev.savedAt)}).`);
          return;
        } catch { /* les deux sont illisibles */ }
      }
      setAiNotification("La session sauvegardée n'a pas pu être rouverte.");
      setShowLanding(false);
    }
  };

  // Message affiché sur l'accueil (Nova n'y est pas encore visible).
  const [landingNotice, setLandingNotice] = useState<string | null>(null);

  // Ouverture depuis le site : /daw?melody=<id> → projet « instru sur mélodie ».
  useEffect(() => {
    let melodyId: string | null = null;
    try { melodyId = new URLSearchParams(window.location.search).get('melody'); } catch { /* */ }
    if (!melodyId) return;
    supabaseManager.getActiveInstrumental(melodyId).then(inst => {
      if (inst) handleEnterWithMelody(inst);
      else setLandingNotice("Cette mélodie n'est plus disponible : choisis-en une autre ci-dessous.");
    }).catch(() => setLandingNotice("⚠️ La mélodie n'a pas pu être chargée (connexion ?). Recharge la page pour réessayer."));
  }, []);

  // Ouverture depuis le site : /daw?beat=<id> → studio direct, beat chargé.
  useEffect(() => {
    let beatId: string | null = null;
    try { beatId = new URLSearchParams(window.location.search).get('beat'); } catch { /* */ }
    if (!beatId) return;
    supabaseManager.getActiveInstrumental(beatId).then(inst => {
      if (inst) handleEnterWithInstrumental(inst);
      else setLandingNotice("Ce beat n'est plus disponible : choisis-en un autre ci-dessous.");
    }).catch(() => setLandingNotice("⚠️ Le beat n'a pas pu être chargé (connexion ?). Recharge la page pour réessayer."));
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
        const ok = await handleNewAudioImport(pendingAudioFile);
        setPendingAudioFile(null);
        // Nova Pro refusé : retour à l'accueil plutôt qu'un studio vide.
        if (ok === false) {
          setShowLanding(true);
          setLandingNotice("Importer ta propre instru fait partie de Nova Pro (5 €/mois). Les instrus et mélodies du catalogue restent gratuites.");
        }
        return;
      }

      // Charger un instrumental depuis le catalogue
      if (pendingInstrumental) {
        const melodyMode = pendingMelodyModeRef.current;
        pendingMelodyModeRef.current = false;
        if (melodyMode) await startMelodyProjectRef.current?.(pendingInstrumental);
        else await loadCatalogBeatRef.current?.(pendingInstrumental);
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

  const { state, setState, setVisualState, setSilently, undo, redo, isBufferInHistory, breakHistory, canUndo, canRedo } = useUndoRedo(initialState);
  
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


  // Pistes dont seul le volume / pan a changé (déjà appliqué au moteur) : pas de
  // reconstruction pour ELLES. Avant, un drapeau global sautait toute la mise à
  // jour suivante, et un effet ajouté au même moment n'arrivait jamais au moteur.
  const atomicTracksRef = useRef(new Map<string, Track>());

  // Pistes deja transmises au moteur (par reference) et signature du routage.
  // Avant, chaque modification (renommer, deplacer un clip...) rappelait
  // updateTrack sur TOUTES les pistes, donc updateParams sur chaque effet.
  const engineTracksRef = useRef<Map<string, Track> | null>(null);
  const engineRoutingRef = useRef('');
  useEffect(() => {
    const atomic = atomicTracksRef.current;
    atomicTracksRef.current = new Map();
    if (!audioEngine.ctx) return;
    // Routage, solo et envois agissent sur les autres pistes (bus, pistes
    // rendues muettes par un solo) : dans ce cas on met tout a jour, comme avant.
    const routing = state.tracks.map(t =>
      `${t.id}>${t.outputTrackId || ''}|${t.isSolo ? 1 : 0}|${t.isFrozen ? 1 : 0}|${(t.sends || []).map(sd => `${sd.id}:${sd.isEnabled ? 1 : 0}:${sd.level}`).join(',')}`
    ).join(';');
    const previous = engineTracksRef.current;
    const full = !previous || routing !== engineRoutingRef.current;
    state.tracks.forEach(t => {
      if (!full && atomic.get(t.id) === t) return; // volume / pan déjà réglés directement
      if (full || previous!.get(t.id) !== t) audioEngine.updateTrack(t, state.tracks);
    });
    engineTracksRef.current = new Map(state.tracks.map(t => [t.id, t]));
    engineRoutingRef.current = routing;
  }, [state.tracks]); 
  useEffect(() => { audioEngine.setLoop(state.isLoopActive, state.loopStart, state.loopEnd); }, [state.isLoopActive, state.loopStart, state.loopEnd]);
  // Le reglage de compensation n'etait jamais transmis au moteur.
  useEffect(() => { audioEngine.setDelayCompensation(state.isDelayCompEnabled); }, [state.isDelayCompEnabled]);
  // Les modifications faites pendant la lecture s'entendent immédiatement.
  useEffect(() => { audioEngine.setLiveTracks(state.tracks); }, [state.tracks]);

  // Metronome : reglages, tempo et signature suivent l'etat du projet.
  useEffect(() => { metronomeService.setSettings(state.metronome); }, [state.metronome]);
  useEffect(() => { metronomeService.setBpm(state.bpm); }, [state.bpm]);
  useEffect(() => { metronomeService.setTimeSignature(state.timeSignature); }, [state.timeSignature]);
  useEffect(() => {
    // On aligne le clic sur la position reelle du playhead au demarrage.
    if (state.isPlaying && state.metronome.enabled) metronomeService.start(audioEngine.getCurrentTime());
    else metronomeService.stop();
  }, [state.isPlaying, state.metronome.enabled]);
  
  // Tete de lecture : pendant la lecture la position va dans playheadStore (hors
  // de l'etat React) ; seuls les composants qui l'affichent sont rafraichis.
  // state.currentTime n'est mis a jour qu'a l'arret, a la pause et aux sauts.
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (stateRef.current.isPlaying) {
         playheadStore.set(audioEngine.getCurrentTime());
         animId = requestAnimationFrame(updateLoop);
      }
    };
    if (state.isPlaying) { animId = requestAnimationFrame(updateLoop); }
    return () => cancelAnimationFrame(animId);
  }, [state.isPlaying]);
  // A l'arret, la tete de lecture suit la position validee (stop, pause, saut,
  // fin de prise, annulation, chargement). isPlaying fait partie des
  // dependances : un stop qui revient a la meme position (0) doit aussi la recaler.
  useEffect(() => { if (!state.isPlaying) playheadStore.set(state.currentTime); }, [state.currentTime, state.isPlaying]);

  /** Met la lecture en pause et valide la position atteinte dans l'etat. */
  const pausePlayback = useCallback(() => {
    audioEngine.stopAll();
    const t = audioEngine.getCurrentTime();
    playheadStore.set(t);
    setVisualState({ isPlaying: false, currentTime: t });
  }, [setVisualState]);

  const [activePlugin, setActivePlugin] = useState<{trackId: string, plugin: PluginInstance} | null>(null);
  const [externalImportNotice, setExternalImportNotice] = useState<string | null>(null);
  // Chaque annonce a son identifiant : la même phrase deux fois de suite
  // (« Aucun blanc à retirer ici ») était avalée la seconde fois.
  const [aiNotice, setAiNotice] = useState<{ text: string; id: number } | null>(null);
  const setAiNotification = useCallback((text: string | null) => {
    setAiNotice(text ? { text, id: Date.now() + Math.random() } : null);
  }, []);
  // Nova Pro (5 €/mois) : importer ses propres instrus + collaborer. Défini plus bas.
  const requireProRef = useRef<(reason: string) => Promise<boolean>>(async () => true);

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
  // Bouton « Retour casque » des pistes : il demande ici d'allumer / couper le retour.
  useEffect(() => {
    const onSet = (e: Event) => {
      const on = !!(e as CustomEvent).detail;
      setInputMonitoringState(on);
      try { localStorage.setItem('nova_headphones', on ? '1' : '0'); } catch { /* */ }
    };
    window.addEventListener('nova:set-monitoring', onSet);
    return () => window.removeEventListener('nova:set-monitoring', onSet);
  }, []);
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
  // Sur téléphone on ouvre l'Arrangement : les prises y apparaissent avec leur
  // forme d'onde (« Pistes » est une vue de routage où on ne les voyait pas).
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>('ARRANGEMENT');
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
  // Carte « Et maintenant ? » (définie plus bas, appelée après une prise ou un export).
  const showNextStepRef = useRef<(trigger: 'take' | 'export') => void>(() => {});
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

  const handleLogout = async () => {
    // Au studio (pont VST) : pistes VST gelées + session sauvegardée avant de se déconnecter.
    if (novaBridge.isConnected() && !showLanding) {
      try { await bakeVstBeforeSave(); await autosaveNow(); } catch (e) { console.warn('[Déconnexion] gel', e); }
    }
    await supabaseManager.signOut(); setUser(null);
    // Appli Windows : « Déconnexion » ferme aussi le compte Make Music → la porte de connexion revient.
    if (isNovaDesktop()) { try { await catalogSupabase.auth.signOut(); } catch { /* hors ligne */ } }
  };
  const handleBuyLicense = (instrumentId: string | number) => { if (!user) return; const updatedUser = { ...user, owned_instruments: [...(user.owned_instruments || []), instrumentId] }; setUser(updatedUser); setAiNotification(`✅ Licence achetée avec succès ! Export débloqué.`); };
  
  const handleSaveCloud = async (projectName: string) => { 
    if (!user) {
      setAiNotification("⚠️ Connectez-vous pour sauvegarder dans le cloud");
      return;
    }
    setSaveState({ isSaving: true, progress: 10, message: 'Préparation...' });
    try {
      // Effets VST3 du PC rendus dans l'audio : le projet continue sur téléphone.
      const baked = await bakeVstBeforeSave(message => setSaveState(s => ({ ...s, message })));
      setSaveState(s => ({ ...s, progress: 30, message: 'Sauvegarde cloud...' }));
      const stateToSave = { ...baked, name: projectName };
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
      const baked = await bakeVstBeforeSave(message => setSaveState(s => ({ ...s, message })));
      const stateToSave = { ...baked, id: `proj-${Date.now()}`, name: copyName };
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
      // Effets VST3 du PC rendus dans l'audio : le projet continue sur téléphone.
      const baked = await bakeVstBeforeSave(message => setSaveState(s => ({ ...s, message })));
      setSaveState(s => ({ ...s, progress: 40, message: 'Création du fichier ZIP...' }));
      
      // Utiliser ProjectIO pour créer un ZIP avec les audios
      const zipBlob = await ProjectIO.saveProject(baked, ownedIds);
      
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
        // (rendus gelés, rendus d'envois VST, sons d'origine de la photo du gel compris)
        loadedState.tracks.forEach(t => trackBufferIds(t).forEach(id => keep.add(id)));
        audioBufferRegistry.removeMany(audioBufferRegistry.ids().filter(id => !keep.has(id)));
        
        loadedState.tracks.forEach(track => {
            track.clips.forEach(clip => {
                if (clip.buffer) {
                    audioBufferRegistry.register(clip.buffer, clip.id);
                    clip.bufferId = clip.id;
                    delete (clip as Partial<Clip>).buffer;
                }
            });
            // Rendu gele charge depuis le cloud
            if (track.frozenClip?.buffer) {
                audioBufferRegistry.register(track.frozenClip.buffer, track.frozenClip.id);
                track.frozenClip.bufferId = track.frozenClip.id;
                delete (track.frozenClip as Partial<Clip>).buffer;
            }
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
              setTimeout(() => { void restoreCatalogBeatRef.current('📂 Projet ouvert : tes prises et tes paroles sont là.'); }, 900);
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
  const handleExportMix = async () => {
    // Identifiant stable du projet (l'achat « mes pistes seules » y est rattaché).
    if (!/^(cloud-|proj-[a-z0-9]{8,})/.test(stateRef.current.id || '')) {
      const id = `proj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      setVisualState({ id });
      stateRef.current = { ...stateRef.current, id };
    }
    setIsExportMenuOpen(true);
  };

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
      // Rendus d'envois VST, sons d'origine de la photo du gel (éditions pré-effet).
      || trackBufferIds({ ...t, clips: [], frozenClip: undefined }).includes(bufferId)
    );
    if (!stillUsed && !isBufferInHistory(bufferId)) audioBufferRegistry.remove(bufferId);
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
        case 'DUPLICATE': if(idx > -1) newClips.push({ ...newClips[idx], id: `clip-dup-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, start: payload?.start ?? (newClips[idx].start + newClips[idx].duration + 0.1) }); break;
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
            previousTrack.plugins === updatedTrack.plugins && previousTrack.sends === updatedTrack.sends && previousTrack.clips === updatedTrack.clips;

        const isPanOnlyChange = previousTrack.pan !== updatedTrack.pan &&
            previousTrack.volume === updatedTrack.volume &&
            previousTrack.isMuted === updatedTrack.isMuted &&
            previousTrack.isSolo === updatedTrack.isSolo &&
            previousTrack.plugins === updatedTrack.plugins && previousTrack.sends === updatedTrack.sends && previousTrack.clips === updatedTrack.clips;

        if (isVolumeOnlyChange || isPanOnlyChange) {
            // Use atomic methods for better performance
            if (isVolumeOnlyChange) {
                audioEngine.setTrackVolume(updatedTrack.id, updatedTrack.volume, updatedTrack.isMuted);
            }
            if (isPanOnlyChange) {
                audioEngine.setTrackPan(updatedTrack.id, updatedTrack.pan);
            }
            // Cette piste-là n'a pas besoin d'être reconstruite.
            atomicTracksRef.current.set(updatedTrack.id, updatedTrack);
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
    playheadStore.set(time);
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
      if (stateRef.current.isRecording) {
        // QuickPunch : Espace sort de l'enregistrement ET arrête la lecture.
        if (punchRecRef.current?.quick) { await quickPunchOutRef.current?.(true); return; }
        await toggleRecordRef.current?.(); return;
      }
      await ensureAudioEngine();
      if (stateRef.current.isPlaying) {
        pausePlayback();
      } else {
        audioEngine.startPlayback(stateRef.current.currentTime, stateRef.current.tracks);
        setVisualState({ isPlaying: true });
      }
  }, [setVisualState, pausePlayback]);

  /**
   * Récupère la prise en cours et l'ajoute à la piste armée :
   * - nommée « Prise N » ;
   * - les anciennes prises qu'elle recouvre sont coupées (mute), sinon une
   *   nouvelle prise doublait la voix ;
   * - blancs retirés si le nettoyage auto est actif (non destructif).
   */
  const finalizeRecording = useCallback(async () => {
    const result = await audioEngine.stopRecording();
    const rec = punchRecRef.current;
    punchRecRef.current = null;
    // Punch (zone ou QuickPunch) et pré-roll : on ne garde que la fenêtre utile,
    // élargie d'un demi-crossfade de chaque côté (utils/punch).
    const punch = rec?.isPunch ? rec : null;
    const xfade = punchXfadeSec(stateRef.current.punch);
    let punchIn = 0, punchOut = 0;
    if (rec) {
      // La boucle avait été suspendue pendant le punch : on la remet.
      const st = stateRef.current;
      if (rec.isPunch) audioEngine.setLoop(st.isLoopActive, st.loopStart, st.loopEnd);
      if (result && result.clip.buffer) {
        const c = result.clip;
        const t = trimTake(c, rec.in, rec.out, rec.isPunch ? xfade : 0.01);
        if (!t) {
          setState(produce(draft => { draft.isRecording = false; draft.recStartTime = null; }));
          setAiNotification(rec.isPunch ? 'Punch : rien n\'a été enregistré dans la zone (la prise s\'est arrêtée avant).' : 'Rien n\'a été enregistré après le pré-roll.');
          return null;
        }
        Object.assign(c, t);
        punchIn = rec.in ?? c.start;
        punchOut = rec.out ?? (c.start + c.duration);
      }
    }
    let cleaned: StripSilenceResult | null = null;
    let takeName = '';
    let mutedOld = 0;
    let takeGain = 1;
    let takeGainDb = 0;
    if (result && result.clip.buffer) {
      const track = stateRef.current.tracks.find(t => t.id === result.trackId);
      const takeNumber = 1 + (track?.clips || []).reduce((max, c) => Math.max(max, takeNumberOf(c) ?? 0), 0);
      takeName = `Prise ${takeNumber}`;
      result.clip.name = takeName;
      result.clip.takeNumber = takeNumber;
      if (autoCleanRef.current && !punch) {
        cleaned = stripSilenceFromClip({ ...result.clip, bufferId: result.clip.id }, result.clip.buffer);
      }
      // Niveau automatique : qu'on chante fort ou doucement, chaque prise arrive
      // au même niveau dans le mix (-20 dBFS moyen sur la voix), sans saturer.
      const lv = takeStats(result.clip.buffer);
      // En punch, la nouvelle partie garde le niveau de la prise qu'elle complète.
      if (!punch && !lv.silent && lv.rmsDb > -60) {
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
          if (punch && punchOut > punchIn) {
            // Punch : l'ancienne prise est découpée autour de la zone (avant /
            // après gardés, le passage remplacé retiré — Annuler le rend), avec
            // un crossfade à puissance égale centré sur chaque point de punch.
            const cut = cutAroundPunch(track.clips as Clip[], punchIn, punchOut, xfade, Date.now().toString(36));
            mutedOld += cut.replaced;
            track.clips = cut.clips as any;
          } else {
            track.clips.forEach(c => {
              if (!c.isMuted && c.start < takeEnd && c.start + c.duration > takeStart) { c.isMuted = true; mutedOld++; }
            });
          }
          if (cleaned) track.clips.push(...cleaned.clips.map(toStore));
          else track.clips.push(toStore(clip));
        }
      }
    }));
    if (result && result.clip.buffer) {
      const parts: string[] = [`🎤 ${takeName} enregistrée`];
      if (cleaned) parts.push(`${cleaned.removedSec.toFixed(1)} s de blanc retirées`);
      if (takeGainDb) parts.push(`niveau ajusté (${takeGainDb > 0 ? '+' : ''}${Math.round(takeGainDb)} dB)`);
      if (mutedOld) parts.push(punch ? 'passage remplacé dans l\'ancienne prise' : `l'ancienne prise est coupée`);
      parts.push('▶ pour l\'écouter · Annuler pour revenir');
      setAiNotification(parts.join(' — '));
      const buf = result.clip.buffer;
      const start = result.clip.start;
      // QuickPunch : la lecture continue, pas de carte de coaching au milieu.
      if (!rec?.quick) setTimeout(() => coachAfterTakeRef.current?.(result.trackId, buf, takeName, start), 120);
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
  const handleApplyMixStyle = useCallback((styleId: string, auto = false): boolean => {
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
    track('mix_style_applied', { style: style.id, auto });
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
    const level = s.silent || s.rmsDb < -50 ? 'silent' : s.peakDb > -0.3 ? 'clip' : s.rmsDb < -38 ? 'low' : 'ok';
    track('take_recorded', { n: listTakes(t).length, role, level });
    trackOnce('first_take', { role, level });
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
      breakHistory(); // Ctrl+Z retire le style, pas la prise
      handleApplyMixStyle(sid, true);
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
      breakHistory(); // Ctrl+Z retire le style, pas la prise
      handleApplyMixStyle(sid, true);
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
    // Première bonne prise du lead : la suite possible (achat, mix pro, partage).
    if (role === 'lead') setTimeout(() => showNextStepRef.current('take'), 2500);
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
    // Décompte annulé : les clics déjà programmés ne doivent plus sonner.
    const clicks: GainNode[] = [];
    const silence = () => clicks.forEach(g => { try { g.disconnect(); } catch { /* déjà coupé */ } });
    if (ctx) {
      const t0 = ctx.currentTime + 0.05;
      for (let i = 0; i < 4; i++) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        clicks.push(g);
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
      if (countInCancelRef.current) { silence(); setCountInBeat(null); return false; }
      setCountInBeat(i);
      await new Promise(r => setTimeout(r, beat * 1000));
    }
    setCountInBeat(null);
    if (countInCancelRef.current) silence();
    return !countInCancelRef.current;
  }, []);

  // Casque : demandé une fois, avant la première prise. Avec casque on entend
  // sa voix (retour) ; sur haut-parleurs le retour reste coupé (larsen).
  const [headphonePromptOpen, setHeadphonePromptOpen] = useState(false);
  const toggleRecordRef = useRef<(() => Promise<void>) | null>(null);

  // ===== QuickPunch (Pro Tools) : entrer / sortir de l'enregistrement pendant la lecture
  const quickPunchOutRef = useRef<((stopTransport: boolean) => Promise<void>) | null>(null);
  const quickPunchIn = useCallback(async () => {
    const st = stateRef.current;
    let armed = st.tracks.find(t => t.isTrackArmed);
    if (!armed) {
      const sel = st.tracks.find(t => t.id === st.selectedTrackId);
      const target = isVoiceTrack(sel) ? sel : st.tracks.find(t => t.id === 'track-rec-main') ?? st.tracks.find(t => isVoiceTrack(t));
      if (!target) { setNoArmedTrackError(true); setTimeout(() => setNoArmedTrackError(false), 2000); return; }
      if (!(await armForRecording(target.id))) return;
      armed = target;
    }
    // Boucle suspendue pendant la prise : un retour au début décalerait l'audio.
    audioEngine.setLoop(false, st.loopStart, st.loopEnd);
    const at = audioEngine.getCurrentTime();
    const ok = await audioEngine.startRecording(at, armed.id);
    if (!ok) {
      audioEngine.setLoop(st.isLoopActive, st.loopStart, st.loopEnd);
      setAiNotification("🎤 QuickPunch : l'enregistrement n'a pas pu démarrer. Vérifie que le micro est autorisé.");
      return;
    }
    punchRecRef.current = { in: at, out: null, isPunch: true, autoStopAt: null, quick: true };
    recStartRef.current = at;
    track('rec_started', { role: getVocalRole(armed), punch: true, quick: true });
    setState(produce(draft => { draft.isRecording = true; draft.recStartTime = at; }));
  }, [setState, armForRecording]);
  quickPunchOutRef.current = async (stopTransport: boolean) => {
    const z = punchRecRef.current;
    if (!z?.quick || z.stopping) return;
    const now = audioEngine.getCurrentTime();
    z.out = Math.max((z.in ?? now) + 0.05, now);
    z.stopping = true;
    if (stopTransport) { metronomeService.stop(); pausePlayback(); }
    // La prise arrive en retard de la latence : on capte encore un peu avant d'arrêter l'enregistreur.
    const lat = audioEngine.measureRecordLatency().total + audioEngine.getRecordOffsetMs() / 1000;
    await new Promise(r => setTimeout(r, quickPunchStopDelay(lat, punchXfadeSec(stateRef.current.punch)) * 1000));
    await finalizeRecording();
  };

  const handleToggleRecordInner = useCallback(async () => {
    await ensureAudioEngine();
    const currentState = stateRef.current;

    // Pendant le décompte : REC l'annule.
    if (countInBeat !== null) { countInCancelRef.current = true; return; }

    // QuickPunch (comme dans Pro Tools) : pendant la lecture, REC entre dans
    // l'enregistrement et en ressort sans arrêter la lecture.
    if (currentState.isRecording && punchRecRef.current?.quick) { await quickPunchOutRef.current?.(false); return; }
    if (!currentState.isRecording && currentState.isPlaying && currentState.punch?.quickPunch) { await quickPunchIn(); return; }

    if (currentState.isRecording) {
        audioEngine.stopAll();
        metronomeService.stop();
        await finalizeRecording();
        // Retour au début de la prise : prêt à la réécouter.
        const back = recStartRef.current ?? playheadStore.get();
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

    // Punch et pré-roll (utils/punch) : la lecture repart avant le point
    // d'entrée, seule la zone est gardée, arrêt auto après le post-roll.
    const st0 = stateRef.current;
    const plan = planRecording({ playhead: playheadStore.get(), punch: st0.punch, bpm: st0.bpm, ts: st0.timeSignature });
    const startAt = plan.startAt;
    punchRecRef.current = null;
    if (plan.isPunch || plan.keepFrom !== null) {
      if (plan.isPunch) audioEngine.setLoop(false, st0.loopStart, st0.loopEnd);
      audioEngine.seekTo(startAt, st0.tracks, false);
      playheadStore.set(startAt);
      punchRecRef.current = { in: plan.keepFrom, out: plan.keepTo, isPunch: plan.isPunch, autoStopAt: plan.autoStopAt };
    }
    const success = await audioEngine.startRecording(startAt, armedTrack.id);
    if (success) {
      recStartRef.current = startAt;
      track('rec_started', { role: getVocalRole(armedTrack), punch: !!punchRecRef.current });
      audioEngine.startPlayback(startAt, stateRef.current.tracks);
      setState(produce(draft => {
        draft.isRecording = true;
        draft.isPlaying = true;
        draft.currentTime = startAt;
        draft.recStartTime = startAt;
      }));
    } else {
      punchRecRef.current = null;
      if (plan.isPunch) audioEngine.setLoop(st0.isLoopActive, st0.loopStart, st0.loopEnd);
      setAiNotification("🎤 L'enregistrement n'a pas pu démarrer. Vérifie que le micro est autorisé, puis réessaie.");
    }
  }, [setState, finalizeRecording, armForRecording, runCountIn, countInBeat]);
  // Deux appuis rapides sur REC lançaient deux décomptes et deux prises (la
  // seconde affichait une erreur alors que l'enregistrement tournait).
  const recBusyRef = useRef(false);
  const handleToggleRecord = useCallback(async () => {
    if (recBusyRef.current) { countInCancelRef.current = true; return; }
    recBusyRef.current = true;
    try { await handleToggleRecordInner(); } finally { recBusyRef.current = false; }
  }, [handleToggleRecordInner]);
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
    // QuickPunch : le point de sortie est l'instant du STOP (relevé avant l'arrêt).
    if (wasRecording && punchRecRef.current?.quick) {
      await quickPunchOutRef.current?.(true);
      const back = recStartRef.current ?? 0;
      audioEngine.seekTo(back, stateRef.current.tracks, false);
      setState(prev => ({ ...prev, isPlaying: false, currentTime: back, isRecording: false }));
      return;
    }
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

  // Punch : la prise s'arrête toute seule à la fin du post-roll (utils/punch).
  useEffect(() => {
    if (!state.isRecording) return;
    const id = setInterval(() => {
      const z = punchRecRef.current;
      if (!z || z.stopping || z.quick || z.autoStopAt === null) return;
      if (audioEngine.getCurrentTime() > z.autoStopAt) { z.stopping = true; void toggleRecordRef.current?.(); }
    }, 50);
    return () => clearInterval(id);
  }, [state.isRecording]);

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
  
  /**
   * Reverbs et délais : toujours sur une piste d'envoi, jamais en insert d'une
   * piste source. Ainsi une piste peut être gelée (VST du PC rendus) et rester
   * éditable ailleurs (iPad, navigateur) sans figer l'ambiance, et toutes les
   * voix partagent la même reverb. Reverb native → « VERB PRO » (notre reverb),
   * délai natif → « DELAY 1/4 », reverb / délai VST → nouvelle piste d'envoi.
   * Renvoie la piste d'envoi et l'effet, ou null si l'aiguillage ne s'applique pas.
   */
  const routeAmbienceToSend = useCallback((tid: string, plugin: PluginInstance, displayName: string): { sendId: string; name: string; plugin: PluginInstance; created: boolean } | null => {
    const st = stateRef.current;
    const src = st.tracks.find(t => t.id === tid);
    if (!src || src.type === TrackType.SEND || src.id === 'master') return null;
    const label = `${displayName} ${plugin.params?.name || ''} ${plugin.params?.pluginName || ''}`;
    const isAmbience = plugin.type === 'REVERB' || plugin.type === 'DELAY' ||
      (plugin.type === 'VST3' && /verb|hall|plate|room|space|delay|echo|écho/i.test(label));
    if (!isAmbience) return null;
    const isDelay = plugin.type === 'DELAY' || (plugin.type === 'VST3' && /delay|echo|écho/i.test(label));
    let sendId = plugin.type === 'REVERB' ? 'send-verb-short' : plugin.type === 'DELAY' ? 'send-delay' : `send-aux-${Date.now().toString(36)}`;
    // La piste d'envoi est préparée ici (l'état React est mis à jour plus tard).
    const existing = st.tracks.find(t => t.id === sendId && t.type === TrackType.SEND);
    const newSend: Track | null = existing ? null : (createInitialSends(st.bpm).find(t => t.id === sendId) || {
      id: sendId, name: (plugin.params?.name || displayName || (isDelay ? 'DELAY' : 'REVERB')).toUpperCase().slice(0, 16),
      type: TrackType.SEND, color: isDelay ? '#00f2ff' : '#10b981', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], clips: [],
      plugins: [{ ...plugin, params: { ...plugin.params, mix: 1 } }],
      automationLanes: [createDefaultAutomation('volume', isDelay ? '#00f2ff' : '#10b981')], totalLatency: 0,
    });
    const sendTrack = (existing || newSend)!;
    const usedPlugin = sendTrack.plugins.find(p => p.type === plugin.type) || sendTrack.plugins[0] || plugin;
    setState(produce((draft: DAWState) => {
      if (newSend && !draft.tracks.some(t => t.id === sendId)) {
        const at = draft.tracks.findIndex(t => t.id === 'master');
        draft.tracks.splice(at >= 0 ? at : draft.tracks.length, 0, newSend);
      }
      const t = draft.tracks.find(tr => tr.id === tid);
      if (t) {
        const sd = t.sends.find(x => x.id === sendId);
        // Départ -10 dB par défaut s'il était fermé.
        if (sd) { if (!(sd.level > 0.01)) sd.level = 0.32; sd.isEnabled = true; }
        else t.sends.push({ id: sendId, level: 0.32, isEnabled: true });
      }
    }));
    return { sendId, name: sendTrack.name, plugin: usedPlugin, created: !!newSend };
  }, [setState]);

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

    // Ingé à distance : verrou d'enregistrement (reverb / délai VST) et règle des envois.
    const remoteCheck = remoteRef.current?.checkAdd(tid, newPlugin, !!metadata?.forceInsert);
    const blocked = remoteCheck && remoteCheck.ok === false ? remoteCheck : null;
    if (blocked) {
      const msg = `⛔ ${blocked.message}`;
      setAiNotification(msg);
      setTimeout(() => setAiNotice(n => (n?.text === msg ? null : n)), 9000);
      if (blocked.code === 'vst-temporal-recording') return;
    }
    const insertOk = metadata?.forceInsert && !blocked;
    const routed = insertOk ? null : routeAmbienceToSend(tid, newPlugin, metadata?.name || type);
    if (routed) {
      const sendName = routed.name;
      const what = metadata?.name || (type === 'REVERB' ? 'La reverb' : type === 'DELAY' ? 'Le délai' : type);
      setAiNotification(`🌫️ ${what} passe par la piste d'envoi « ${sendName} » (départ -10 dB, réglable dans la piste ou la console). La voix reste gelable et éditable partout ; pour une autre reverb, remplace l'effet sur la piste d'envoi.`);
      if (options?.openUI || routed.created) {
        await ensureAudioEngine();
        setTimeout(() => setActivePlugin({ trackId: routed.sendId, plugin: routed.plugin }), 80);
      }
      return;
    }

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
    if (!(await requireProRef.current('Importer un son de ton ordinateur (une instru venue d\'ailleurs) fait partie de Nova Pro.'))) return false;
    try {
      // 1. Initialiser l'audio engine
      await ensureAudioEngine();
      if (!audioEngine.ctx) {
        setAiNotification('❌ Le moteur audio n\x27est pas prêt : appuie sur Play une fois puis réessaie');
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
        start: playheadStore.get(),
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
      setAiNotification(`✅ Importé : ${file.name}`);

    } catch (error: any) {
      console.error('❌ [Import Error]', error);
      setAiNotification(`❌ Import impossible : ${error.message || 'fichier non valide'}`);
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
    const notify = (msg: string, ms = 2500) => { setAiNotification(msg); setTimeout(() => setAiNotification(null), ms); };

    // Ingé à distance, chez l'artiste : le rendu vient de l'ingé (ses VST) ; la prise brute se reprend dans le panneau.
    if (track.remote && stateRef.current.remoteInge?.role === 'artist' && track.remote.appliedSig && track.isFrozen) {
      notify(`🎧 « ${track.name} » joue les effets de l'ingé (ses VST, que tu n'as pas). Pour réentendre ta prise brute : « Revenir à ma prise brute » dans le panneau Ingé à distance (👥).`, 6000);
      return;
    }
    // Instrument VST du PC : la piste est déjà lue depuis son rendu, mis à jour tout seul.
    if (track.vstInstrument) {
      notify(`🎹 « ${track.name} » joue ${track.vstInstrument.name} : son rendu se met à jour tout seul quand tu modifies les notes.`, 4000);
      return;
    }

    if (track.isFrozen) {
      // Sans le pont, une piste dont les VST3 sont dans le rendu ne peut pas
      // repasser en direct : les VST3 ne sonneraient plus.
      if (hasVst(track) && !novaBridge.isConnected()) {
        notify("🔌 Cette piste utilise des effets VST de ton PC : connecte le pont VST (onglet VST) pour la dégeler.", 4000);
        return;
      }
      let frozenBufferId: string | undefined;
      setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(tr => tr.id === trackId);
        if (!t) return;
        t.isFrozen = false;
        delete t.frozenAuto;
        // Avec des VST3, le rendu reste en cache : la prochaine sauvegarde le
        // réutilise s'il est encore à jour.
        if (!hasVst(t)) {
          frozenBufferId = t.frozenClip?.bufferId;
          delete t.frozenClip;
          delete t.frozenUpToPluginIndex;
          delete t.frozenClipIds;
          delete t.frozenSourceSig;
          delete t.frozenPluginSig;
        }
      }));
      if (frozenBufferId) setTimeout(() => releaseBufferIfUnused(frozenBufferId, []), 0);
      notify(`🔥 "${track.name}" dégelée`);
      // Éditions faites pendant le gel (ailleurs) : rejouées avant les effets, on le montre.
      setTimeout(() => preFxAnnounceRef.current?.([trackId]), 0);
      return;
    }

    if (!canBakeTrack(track)) {
      notify("Le beat ne peut pas être gelé (licence).");
      return;
    }
    if ((track.clips || []).length === 0) {
      notify("⚠️ Rien à geler sur cette piste");
      return;
    }
    if (hasVst(track) && !novaBridge.isConnected()) {
      notify("🔌 Connecte le pont VST (onglet VST) pour geler une piste avec des effets VST.", 4000);
      return;
    }

    await ensureAudioEngine();
    setAiNotification(`❄️ Gel de "${track.name}"...`);
    try {
      // Rendu PRE-fader de tous les effets : le fader, le pan et les départs
      // restent appliqués à la lecture (avant, ils l'étaient deux fois).
      const r = await renderTrackFreeze(track, (track.plugins || []).length - 1);
      let oldBufferId: string | undefined;
      setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(tr => tr.id === trackId);
        if (!t) return;
        oldBufferId = t.frozenClip?.bufferId;
        t.isFrozen = true;
        delete t.frozenAuto; // gel voulu (CPU) : il reste gelé partout
        applyFreezeResult(t, r, getEditAuthor() || undefined);
      }));
      if (oldBufferId && oldBufferId !== r.clip.bufferId) setTimeout(() => releaseBufferIfUnused(oldBufferId, []), 0);
      notify(`❄️ "${track.name}" gelée`);
    } catch (e: any) {
      console.error('[Freeze]', e);
      notify(`❌ Gel impossible : ${e?.message || 'erreur'}`);
    }
  }, [setState]);

  // --- Effets VST3 : état remonté au projet, rendu à la sauvegarde ----------------

  // État d'un VST3 (fenêtre du plugin fermée, chargement) : enregistré dans le
  // projet (params.stateB64), pour le retrouver à la réouverture et le rendre.
  useEffect(() => vstStateEvents.on((pluginId, stateB64, source) => {
    const update = produce((draft: DAWState) => {
      draft.tracks.forEach(t => t.plugins.forEach(p => {
        if (p.id === pluginId && p.type === 'VST3' && p.params?.stateB64 !== stateB64) {
          p.params.stateB64 = stateB64;
          // Réglé à la main dans la fenêtre du plugin : les réglages de Nova ne le réécrasent plus.
          if (source === 'editor' && p.params.novaSettings) delete p.params.novaSettings;
        }
      }));
    });
    // Chargement / réglage par Nova : conséquence, pas une étape d'annulation de plus.
    if (source === 'load' || source === 'nova') setSilently(update); else setState(update);
  }), [setState, setSilently]);

  /**
   * Avant une sauvegarde (fichier ou cloud), pont connecté : rend les effets
   * VST3 de chaque piste dans son audio (pas le beat), pour que le projet
   * continue sur un téléphone. Les rendus à jour sont réutilisés.
   * Renvoie l'état à sauvegarder.
   */
  const bakeVstBeforeSave = useCallback(async (onStep?: (msg: string) => void): Promise<DAWState> => {
    if (!novaBridge.isConnected()) return stateRef.current;
    const states = await syncLiveVstStates();
    let base = stateRef.current;
    if (states.size > 0) {
      base = produce(base, (draft: DAWState) => {
        draft.tracks.forEach(t => t.plugins.forEach(p => {
          const st = states.get(p.id);
          if (st && p.type === 'VST3') p.params.stateB64 = st;
        }));
      });
    }
    const todo = tracksNeedingVstRender(base.tracks);
    const results = new Map<string, FreezeResult>();
    const by = getEditAuthor() || "l'ingé";
    for (const t of todo) {
      onStep?.(`Rendu des effets VST : ${t.name}…`);
      try {
        results.set(t.id, await renderTrackFreeze(t, renderRangeFor(t), onStep));
      } catch (e) {
        console.warn(`[Save] Rendu VST impossible (${t.name})`, e);
      }
    }
    const old: string[] = [];
    let next = results.size === 0 ? base : produce(base, (draft: DAWState) => {
      draft.tracks.forEach(t => {
        const r = results.get(t.id);
        if (!r) return;
        if (t.frozenClip?.bufferId) old.push(t.frozenClip.bufferId);
        applyFreezeResult(t, r, by);
      });
    });
    // Bus / envois à effets VST (reverb VST de l'ingé) : rendus par source, après les pistes.
    const busResults: BusFreezeResult[] = [];
    for (const bus of busesNeedingVstRender(next.tracks)) {
      try { busResults.push(await renderBusFreeze(bus, next.tracks, onStep)); } catch (e) { console.warn(`[Save] Rendu du bus VST impossible (${bus.name})`, e); }
    }
    if (busResults.length) next = produce(next, (draft: DAWState) => { busResults.forEach(r => old.push(...applyBusFreezeResult(draft.tracks, r, by))); });
    if (next === stateRef.current) return next;
    setState(next);
    stateRef.current = next;
    setTimeout(() => old.forEach(id => releaseBufferIfUnused(id, [])), 0);
    return next;
  }, [setState]);

  // --- Gel automatique le temps d'une prise -----------------------------------------
  // Piste armée : les AUTRES pistes dont les effets ajoutent plus de 10 ms (VST3
  // du pont, Auto-Tune haute qualité…) sont lues depuis un rendu sans latence,
  // et la compensation de latence est suspendue. Au désarmement, tout revient.
  // Seulement dans le moteur : le projet n'est pas modifié.
  const REC_FREEZE_THRESHOLD_S = 0.010;
  const recFreezeCacheRef = useRef<Map<string, FreezeResult>>(new Map());
  const recFreezeRunRef = useRef(0);
  const armedTrackId = state.tracks.find(t => t.isTrackArmed)?.id || null;

  useEffect(() => {
    const run = ++recFreezeRunRef.current;
    const clear = () => {
      const ids = Array.from(recFreezeStore.get());
      ids.forEach(id => audioEngine.setRecordingFreeze(id, null));
      audioEngine.setDelayCompensationSuspended(false);
      recFreezeStore.set(new Set());
      recFreezeStore.setPending(new Set());
      const st = stateRef.current;
      ids.forEach(id => { const t = st.tracks.find(tr => tr.id === id); if (t) audioEngine.updateTrack(t, st.tracks); });
    };
    // Changement de piste armée : on repart de zéro (la nouvelle piste armée
    // ne doit pas rester figée). Les rendus en cache rendent ça immédiat.
    clear();
    if (!armedTrackId || !audioEngine.ctx) return;

    audioEngine.setDelayCompensationSuspended(true);
    let slowTimer: number | null = null;
    (async () => {
      const st = stateRef.current;
      const heavy = st.tracks.filter(t =>
        t.id !== armedTrackId && canBakeTrack(t) && !t.isFrozen && (t.clips || []).length > 0 &&
        audioEngine.getTrackLatency(t.id) > REC_FREEZE_THRESHOLD_S);
      if (heavy.length === 0) return;
      // Réglages faits dans les fenêtres des VST3 : relus avant le rendu.
      if (novaBridge.isConnected()) await syncLiveVstStates().catch(() => null);
      // Rendu de plus de 300 ms : petit ❄️ animé sur les pistes concernées.
      slowTimer = window.setTimeout(() => {
        if (run === recFreezeRunRef.current) recFreezeStore.setPending(new Set(heavy.map(t => t.id)));
      }, 300);
      const applied = new Set(recFreezeStore.get());
      for (const t of heavy) {
        if (run !== recFreezeRunRef.current) return;
        // Dernier effet qui ajoute de la latence : tout jusqu'à lui est rendu.
        const lats = audioEngine.getTrackPluginLatencies(t.id);
        let upTo = -1;
        t.plugins.forEach((p, i) => { if ((lats.get(p.id) || 0) > 0) upTo = i; });
        if (upTo < 0) continue;
        const cur = stateRef.current.tracks.find(tr => tr.id === t.id) || t;
        const sig = freezeSignature(cur.clips || [], cur.plugins || [], upTo);
        let r = recFreezeCacheRef.current.get(t.id);
        if (!r || r.sig !== sig || r.upTo !== upTo || !audioBufferRegistry.has(r.clip.bufferId!)) {
          try {
            const fresh = await renderTrackFreeze(cur, upTo);
            if (r?.clip.bufferId) audioBufferRegistry.remove(r.clip.bufferId);
            r = fresh;
            recFreezeCacheRef.current.set(t.id, r);
          } catch (e) {
            console.warn(`[Prise] Gel automatique impossible (${t.name})`, e);
            continue;
          }
        }
        if (run !== recFreezeRunRef.current) return;
        if (!r) continue;
        audioEngine.setRecordingFreeze(t.id, { clip: r.clip, upTo: r.upTo, clipIds: r.clipIds });
        const now = stateRef.current;
        const live = now.tracks.find(tr => tr.id === t.id);
        if (live) audioEngine.updateTrack(live, now.tracks);
        applied.add(t.id);
        recFreezeStore.set(applied);
      }
      if (slowTimer) window.clearTimeout(slowTimer);
      if (run === recFreezeRunRef.current) recFreezeStore.setPending(new Set());
      if (run !== recFreezeRunRef.current || applied.size === 0) return;
      let shown = false;
      try { shown = localStorage.getItem('nova_rec_freeze_explained') === '1'; } catch { /* */ }
      if (!shown) {
        try { localStorage.setItem('nova_rec_freeze_explained', '1'); } catch { /* */ }
        setAiNotification("❄️ J'ai figé les pistes avec des effets lourds le temps de la prise : ton retour casque reste sans retard. Elles redeviennent modifiables juste après.");
        setTimeout(() => setAiNotification(null), 6000);
      }
    })();
    return () => { if (slowTimer) window.clearTimeout(slowTimer); };
  }, [armedTrackId]);

  /** Cree un clip MIDI vide sur une piste instrument et ouvre le piano roll. */
  /** Mode instru : nouvelle piste MIDI (synthé) avec un motif de 4 mesures, piano roll ouvert. */
  const handleNewMidiTrack = useCallback(() => {
    const st = stateRef.current;
    const trackId = `track-midi-${Date.now().toString(36)}`;
    const clipId = `clip-midi-${Date.now().toString(36)}`;
    const bar = (60 / (st.bpm || 120)) * 4;
    const start = Math.floor(playheadStore.get() / bar) * bar;
    const color = UI_CONFIG.TRACK_COLORS[st.tracks.length % UI_CONFIG.TRACK_COLORS.length];
    setState(produce((draft: DAWState) => {
      const n = draft.tracks.filter(t => t.type === TrackType.MIDI).length + 1;
      const track: Track = {
        id: trackId, name: `SYNTHÉ ${n}`, type: TrackType.MIDI, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
        volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
        clips: [{ id: clipId, start, duration: bar * 4, offset: 0, fadeIn: 0, fadeOut: 0, name: 'Motif', color, type: TrackType.MIDI, notes: [], isMuted: false, gain: 1 }],
      };
      // Sous la mélodie et la batterie, au-dessus des voix.
      const at = draft.tracks.findIndex(t => t.id === 'track-rec-main');
      draft.tracks.splice(at >= 0 ? at : draft.tracks.length, 0, track);
    }));
    setTimeout(() => setMidiEditorOpen({ trackId, clipId }), 50);
    setAiNotification('🎹 Piste MIDI créée : dessine tes notes dans le piano roll (clic pour poser, glisser pour allonger).');
  }, [setState]);

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

  // Région (marqueur avec début et fin) : cale une partie du morceau et le prompteur.
  const handleAddRegion = useCallback((start: number, end: number, name?: string) => {
    const id = `rg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setState(produce((draft: DAWState) => {
      const index = draft.markers.length;
      draft.markers.push({
        id, name: name || `Partie ${draft.markers.filter(m => m.type === 'REGION').length + 1}`,
        time: Math.max(0, Math.min(start, end)), endTime: Math.max(start, end), type: 'REGION',
        color: MARKER_COLORS[index % MARKER_COLORS.length],
      });
      draft.markers.sort((a, b) => a.time - b.time);
    }));
    return id;
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
      // Un curseur (swing, volume d'un pad…) n'est pas une saisie : l'espace garde la lecture.
      if (tag === 'input') return !['range', 'button'].includes((node as HTMLInputElement).type);
      return tag === 'textarea' || tag === 'select' || node.isContentEditable;
    };

    // Fenêtre au premier plan (la plus haute) qui a un bouton « Fermer ».
    const CLOSE_SEL = 'button[aria-label^="Fermer"], button[title^="Fermer"]';
    const topOverlayClose = (): HTMLButtonElement | null => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"], .fixed.inset-0'))
        .filter(el => el.getClientRects().length > 0 && el.querySelector(CLOSE_SEL));
      if (!els.length) return null;
      const z = (el: HTMLElement) => Number(getComputedStyle(el).zIndex) || 0;
      const top = els.reduce((a, b) => (z(b) >= z(a) ? b : a));
      return top.querySelector<HTMLButtonElement>(CLOSE_SEL);
    };
    // Vraie fenêtre ouverte (export, sauvegarde, paiement…). Les panneaux de
    // travail (batterie, piano roll : data-nova-transport) n'en sont pas.
    const blockingOverlay = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="dialog"], .fixed.inset-0'))
      .some(el => !el.closest('[data-nova-transport]') && (el.getAttribute('aria-modal') === 'true' || (el.getClientRects().length > 0 && !!el.querySelector(CLOSE_SEL))));
    // Espace géré ici : le bouton qui a le focus ne doit pas se « cliquer » en plus au relâchement.
    let spaceDown = false;
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space' && spaceDown) { spaceDown = false; e.preventDefault(); } };

    const onKeyDown = (e: KeyboardEvent) => {
      // Échap ferme la fenêtre ouverte (export, sauvegarde, casque, Nova Pro…).
      if (e.key === 'Escape' && !e.defaultPrevented) {
        const btn = topOverlayClose();
        if (btn) { e.preventDefault(); btn.click(); return; }
      }
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      // Fenêtre modale ouverte : R, espace, Entrée… n'agissent plus sur le projet derrière.
      if (!mod && blockingOverlay()) return;
      // Batterie / piano roll ouverts : seule la barre d'espace (lecture / pause) passe.
      if (!mod && e.code !== 'Space' && document.querySelector('[data-nova-transport]')) return;
      // Entrée sur un bouton : on laisse le bouton s'activer (clavier).
      if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.closest('button, a, [role="button"]')) return;

      // Lecture / pause : la barre d'espace ne doit ni defiler la page ni
      // re-declencher le bouton qui a le focus.
      if (e.code === 'Space' && !mod) {
        e.preventDefault();
        if (e.repeat) return;
        spaceDown = true;
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
      if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); handleSeek(0); return; }
      if (e.key === 'End') {
        e.preventDefault();
        const end = Math.max(0, ...stateRef.current.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)));
        handleSeek(end);
        return;
      }
      // , / . : une mesure en arrière / en avant (Maj : un temps)
      if (e.key === ',' || e.key === '.' || e.key === ';' || e.key === ':') {
        e.preventDefault();
        const beat = 60 / (stateRef.current.bpm || 120);
        const step = e.shiftKey ? beat : beat * 4;
        const dir = (e.key === ',' || e.key === ';') ? -1 : 1;
        const t = audioEngine.getIsPlaying() ? audioEngine.getCurrentTime() : stateRef.current.currentTime;
        handleSeek(Math.max(0, Math.round((t + dir * step) / step) * step));
        return;
      }
      // K : repère à la tête de lecture
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const t = audioEngine.getIsPlaying() ? audioEngine.getCurrentTime() : stateRef.current.currentTime;
        handleAddMarker(t);
        return;
      }
      if (e.key === '?') { e.preventDefault(); setShortcutsOpen(v => !v); return; }
      if (e.key === 'Escape' && stateRef.current.isPlaying) { e.preventDefault(); handleStop(); return; }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [handleTogglePlay, handleToggleRecord, handleStop, handleSeek, handleAddMarker, undo, redo, setState]);

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
      // Fichier de l'utilisateur (pas le catalogue) : Nova Pro.
      if (instrumentId === undefined && (source instanceof File || String(source).startsWith('blob:'))) {
        if (!(await requireProRef.current('Importer un son de ton ordinateur (une instru venue d\'ailleurs) fait partie de Nova Pro.'))) return null as any;
      }
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
              // Cache local : un beat déjà écouté se rouvre sans réseau.
              const arrayBuffer = await fetchAudio(source);
              audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          }

          const clipName = name.replace(/\.[^/.]+$/, '');
          // Unique même si plusieurs fichiers arrivent dans la même milliseconde.
          const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const clipId = `clip-${uid}`;

          // IMPORTANT: Register buffer in registry OUTSIDE of React state
          // This avoids Immer proxy issues with native AudioBuffer objects.
          // On indexe par clipId (et non par URL) et on confie l'Object URL au
          // registre pour qu'il soit revoque a la suppression du clip : sinon
          // chaque fichier importe fuitait une Object URL jusqu'au rechargement.
          const bufferId = source instanceof File
              ? audioBufferRegistry.registerWithUrl(audioBuffer, audioRef, clipId)
              : audioBufferRegistry.register(audioBuffer, clipId);
          const clipDuration = audioBuffer.duration;
          const clipStart = startTime ?? playheadStore.get();
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
                      targetTrackId = `track-audio-${uid}`;
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

          setExternalImportNotice(`✅ Importé : ${clipName}`);
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

  // Reprise d'une session / projet ouvert : on recharge le beat du catalogue (non sauvegardé).
  restoreCatalogBeatRef.current = async (done: string) => {
    const beat = stateRef.current.tracks.find(t => t.id === 'instrumental');
    if (!beat || beat.instrumentId === undefined) return;
    if (beat.clips.some(c => c.bufferId && audioBufferRegistry.get(c.bufferId))) return;
    try {
      const list = await supabaseManager.getActiveInstrumentals();
      const inst = list.find((i: any) => String(i.id) === String(beat.instrumentId));
      if (inst) await loadCatalogBeatRef.current?.(inst);
      else { setAiNotification("Ce beat n'est plus au catalogue : choisis-en un autre (tes prises sont gardées)."); return; }
    } catch {
      setAiNotification("⚠️ Le beat n'a pas pu être rechargé (connexion ?). Tes prises sont là : recharge le beat depuis le catalogue.");
      return;
    }
    setAiNotification(done);
  };
  useEffect(() => {
    if (showLanding || !restoreBeatAfterResumeRef.current) return;
    const timer = setTimeout(() => {
      restoreBeatAfterResumeRef.current = false;
      void restoreCatalogBeatRef.current('💾 Session reprise : tes prises et tes paroles sont là.');
    }, 900);
    return () => clearTimeout(timer);
  }, [showLanding]);

  // Sauvegarde automatique sur l'appareil, quelques secondes après chaque
  // changement (jamais pendant la lecture ou une prise : ça couperait le son).
  const [lyricsOpen, setLyricsOpen] = useState(false);
  // Extrait 30 s / démo taguée
  const [shareOpen, setShareOpen] = useState(false);
  // Comping : zones où garder une prise (parties du morceau, boucle).
  const compZones = useMemo<CompZone[]>(() => {
    const zones: CompZone[] = [];
    if (state.loopEnd > state.loopStart + 0.2) zones.push({ start: state.loopStart, end: state.loopEnd, label: 'La boucle' });
    (state.markers || []).filter(m => m.type === 'REGION' && typeof m.endTime === 'number' && m.endTime! > m.time)
      .forEach(m => zones.push({ start: m.time, end: m.endTime!, label: m.name }));
    return zones;
  }, [state.loopStart, state.loopEnd, state.markers]);
  const handleCompTake = useCallback((trackId: string, n: number, zone: CompZone) => {
    setState(produce((draft: DAWState) => {
      const t = draft.tracks.find(x => x.id === trackId);
      if (t) t.clips = compTakeInZone(t as Track, n, zone);
    }));
    setAiNotification(`🎚️ Prise ${n} gardée sur « ${zone.label} » (les autres prises restent dessous, Annuler pour revenir).`);
  }, [setState]);

  // Punch-in / punch-out (utils/punch) : points indépendants de la boucle, posés
  // dans la règle ou depuis la sélection ; pré/post-roll réglables ; QuickPunch.
  const punchRecRef = useRef<{ in: number | null; out: number | null; isPunch: boolean; autoStopAt: number | null; quick?: boolean; stopping?: boolean } | null>(null);
  /** Réglages du punch : pas une édition du projet (pas d'étape d'annulation, comme Pro Tools). */
  const handleUpdatePunch = useCallback((patch: Partial<DAWState['punch']>) => {
    const p = { ...stateRef.current.punch, ...patch };
    if (p.preRollBars !== undefined) p.preRoll = p.preRollBars * (240 / (stateRef.current.bpm || 120));
    if (p.postRollBars !== undefined) p.postRoll = p.postRollBars * (240 / (stateRef.current.bpm || 120));
    setVisualState({ punch: p });
  }, [setVisualState]);
  const handleTogglePunch = useCallback(() => {
    const st = stateRef.current;
    if (st.punch?.enabled) {
      setVisualState({ punch: { ...st.punch, enabled: false } });
      setAiNotification('Punch désactivé : REC enregistre de nouveau à partir de la tête de lecture.');
      return;
    }
    // Zone : la sélection de plage, sinon les points déjà posés, sinon la boucle.
    const sel = editSelectionStore.get().time;
    let next = sel ? punchFromRange(st.punch, sel.start, sel.end) : null;
    if (!next && hasPunchZone(st.punch)) next = { ...st.punch, enabled: true };
    if (!next && st.loopEnd > st.loopStart + 0.2) next = punchFromRange(st.punch, st.loopStart, st.loopEnd);
    if (!next) {
      setAiNotification('Punch : pose d\'abord la zone à refaire. Sélectionne une plage (moitié haute d\'un clip) ou clic droit dans la règle → « Punch-in ici » / « Punch-out ici ».');
      return;
    }
    setVisualState({ punch: next });
    setAiNotification(`🎯 Punch : REC ne remplace que ${next.punchIn.toFixed(2)} s → ${next.punchOut.toFixed(2)} s (crossfades aux bords). Règle le pré-roll et le post-roll à côté du bouton PUNCH.`);
  }, [setVisualState]);
  const handleToggleQuickPunch = useCallback(() => {
    const on = !stateRef.current.punch?.quickPunch;
    handleUpdatePunch({ quickPunch: on });
    setAiNotification(on
      ? '⚡ QuickPunch activé : lance la lecture, puis REC (ou R) pour entrer dans l\'enregistrement et REC pour en sortir, sans arrêter la musique.'
      : 'QuickPunch désactivé.');
  }, [handleUpdatePunch]);
  // Commandes d'édition Pro Tools (hooks/useEditCommands) : appelables par le clavier, les menus, l'IA.
  const editCommands = useEditCommands({ stateRef, setState, notify: setAiNotification, togglePunch: handleTogglePunch, toggleQuickPunch: handleToggleQuickPunch });

  // Aide-mémoire des raccourcis (touche « ? »)
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
      // Le clip n'est régénéré que si le rythme change (pas pour un réglage de son ou de mix).
      const sig = (m: DrumMachine) => JSON.stringify([m.bars, m.swing, m.rows.map(r => [r.steps, r.ratchet])]);
      const end = drumLoopEnd(draft as DAWState);
      const prev = t.drumMachine as DrumMachine | undefined;
      const cur = t.clips[0];
      if (!prev || !cur || sig(prev) !== sig(dm) || Math.abs(cur.start + cur.duration - end) > 0.01 || prev.bpmUsed !== draft.bpm) {
        t.clips = [drumClipFor(dm, draft.bpm, 0, end, `clip-drums-${Date.now()}`) as any];
      }
      t.drumMachine = { ...dm, bpmUsed: draft.bpm } as any;
      t.drumPads = drumPadsFor(dm) as any;
    }));
  }, [setState]);

  const handleSetDrumKit = useCallback((kitId?: string) => {
    const st = stateRef.current;
    const id = kitId && DRUM_KITS.some(k => k.id === kitId) ? kitId : suggestDrumKit(st.bpm, st.beatGenre, st.beatTitle);
    applyDrumMachine(makeDrumMachineLib(id));
    // La 808 prend le son du kit (saturée en drill).
    setState(produce((draft: DAWState) => {
      const b = draft.tracks.find(t => t.id === BASS808_TRACK_ID)?.bass808;
      if (b) b.style = kit808Style(id);
    }));
    const kit = DRUM_KITS.find(k => k.id === id);
    setAiNotification(`🥁 Batterie « ${kit?.name} » posée, calée sur le tempo (${Math.round(st.bpm)} BPM)${typeof st.projectKey === 'number' ? ' et la tonalité' : ''}. Lance la lecture !`);
  }, [applyDrumMachine, setState]);

  const handleRemoveDrums = useCallback(() => {
    setState(produce((draft: DAWState) => { draft.tracks = draft.tracks.filter(t => t.id !== DRUM_TRACK_ID); }));
    setAiNotification('Batterie retirée (Annuler pour la remettre).');
  }, [setState]);

  // ===== Basse 808 mélodique : piste MIDI jouée au piano roll (utils/bass808.ts) =====
  const handleOpen808 = useCallback(() => {
    const st = stateRef.current;
    setDrumsOpen(false);
    const bar = (60 / (st.bpm || 120)) * 4;
    const ex = st.tracks.find(t => t.id === BASS808_TRACK_ID);
    const exClip = ex?.clips.find(c => c.type === TrackType.MIDI);
    if (ex && exClip) { setMidiEditorOpen({ trackId: ex.id, clipId: exClip.id }); return; }
    const kitId = (st.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine | undefined)?.kitId;
    const clipId = `clip-808-${Date.now().toString(36)}`;
    const color = '#d946ef';
    const clip: Clip = { id: clipId, start: 0, duration: bar * 4, offset: 0, fadeIn: 0, fadeOut: 0, name: '808', color, type: TrackType.MIDI,
      notes: starter808Notes({ projectKey: st.projectKey, bpm: st.bpm, bars: 4, kitId }), isMuted: false, gain: 1 };
    setState(produce((draft: DAWState) => {
      const t = draft.tracks.find(x => x.id === BASS808_TRACK_ID);
      if (t) { t.clips.push(clip); return; }
      const track: Track = {
        id: BASS808_TRACK_ID, name: '808', type: TrackType.MIDI, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
        volume: 0.85, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
        bass808: { style: kit808Style(kitId), glide: true }, clips: [clip],
      };
      // Sous la batterie (sinon sous la mélodie).
      const at = Math.max(draft.tracks.findIndex(x => x.id === DRUM_TRACK_ID), draft.tracks.findIndex(x => x.id === 'instrumental'));
      draft.tracks.splice(at + 1, 0, track);
    }));
    setTimeout(() => setMidiEditorOpen({ trackId: BASS808_TRACK_ID, clipId }), 50);
    setAiNotification(`🔊 808 posée${typeof st.projectKey === 'number' ? ' sur la tonique du morceau' : ''} : dessine ta ligne au piano roll. Deux notes qui se chevauchent glissent (slide).`);
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
  const autosaveBusy = useRef(false);
  const autosavePending = useRef(false);
  const autosaveNow = useCallback(async () => {
    if (autosaveBusy.current) { autosavePending.current = true; return; }
    const st = stateRef.current;
    if (st.isRecording) return;
    autosaveBusy.current = true;
    const voiceTakes = st.tracks.filter(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId)
      .reduce((n, t) => n + t.clips.filter(c => takeNumberOf(c) !== null).length, 0);
    const hasAudio = st.tracks.some(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId && t.clips.length > 0);
    if (!hasAudio && !(st.lyrics || '').trim()) { autosaveBusy.current = false; return; } // rien à garder : on n'écrase pas une session précédente
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
    } finally {
      autosaveBusy.current = false;
      if (autosavePending.current) { autosavePending.current = false; setTimeout(() => { void autosaveNowRef.current?.(); }, 500); }
    }
  }, [user]);
  const autosaveNowRef = useRef<(() => Promise<void>) | null>(null);
  autosaveNowRef.current = autosaveNow;
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

  // --- Session à emporter (en ligne) -------------------------------------------------
  // Le client enregistre au studio, continue chez lui (iPad, ordinateur), revient :
  // la session vit en ligne (Supabase Make Music, audio compris, jamais le beat
  // non acheté). Sur l'appareil lié, chaque modification est synchronisée.
  const [cloudSession, setCloudSessionState] = useState<LocalCloudSession | null>(() => getLocalCloudSession());
  const cloudRef = useRef<LocalCloudSession | null>(cloudSession);
  const setCloudSession = useCallback((s: LocalCloudSession | null) => {
    cloudRef.current = s; setCloudSessionState(s); setLocalCloudSession(s);
  }, []);
  const [takeHomeOpen, setTakeHomeOpen] = useState(false);
  const [cloudProgress, setCloudProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudConflict, setCloudConflict] = useState<CloudConflictError | null>(null);
  const cloudBusyRef = useRef(false);
  const cloudDirtyRef = useRef(false);
  const cloudQuietUntilRef = useRef(0);
  const isCloudProject = !!cloudSession && state.id === cloudProjectId(cloudSession.id);

  const syncCloud = useCallback(async (opts: { interactive?: boolean; force?: boolean; bake?: boolean } = {}): Promise<boolean> => {
    if (cloudBusyRef.current) { cloudDirtyRef.current = true; return false; }
    if (stateRef.current.isRecording) return false;
    cloudBusyRef.current = true;
    cloudDirtyRef.current = false;
    const progress = opts.interactive ? (pct: number, msg: string) => setCloudProgress({ pct, msg }) : undefined;
    if (opts.interactive) { setCloudError(null); progress!(1, 'Préparation…'); }
    try {
      let cur = cloudRef.current;
      if (cur && stateRef.current.id !== cloudProjectId(cur.id)) {
        // Un autre projet est ouvert : il n'écrase jamais la session en ligne.
        if (!opts.interactive) return false;
        cur = null;
      }
      if (!cur) {
        const c = await createCloudSession(stateRef.current.name || 'Session');
        cur = { id: c.id, secret: c.secret, version: 0, name: stateRef.current.name || 'Session', syncedAt: 0 };
        setVisualState({ id: cloudProjectId(c.id) });
        stateRef.current = { ...stateRef.current, id: cloudProjectId(c.id) };
        setCloudSession(cur);
      }
      // Au studio (pont VST connecté) : les effets VST sont rendus avant l'envoi,
      // pour que la session sonne pareil sur l'iPad (pistes gelées, éditables).
      const st = (opts.bake || opts.interactive) && novaBridge.isConnected()
        ? await bakeVstBeforeSave(msg => progress?.(2, msg))
        : stateRef.current;
      // En collaboration, seul l'artiste écrit l'instantané (les autres passent par le journal).
      const collabNow = collabRef.current;
      const r = await pushSession({ ...st, id: cloudProjectId(cur.id), collabSeq: collabNow?.client.lastSeq ?? st.collabSeq }, user?.owned_instruments || [], { id: cur.id, secret: cur.secret }, cur.version, progress, { force: opts.force || collabNow?.role === 'artist' });
      setCloudSession({ ...cur, version: r.version, name: st.name || cur.name, syncedAt: Date.now() });
      if (opts.interactive) setTimeout(() => setCloudProgress(null), 1500);
      return true;
    } catch (e: any) {
      if (e instanceof CloudConflictError) setCloudConflict(e);
      else {
        console.warn('[Session en ligne]', e);
        if (opts.interactive) setCloudError(e?.message || 'Envoi impossible');
      }
      if (opts.interactive) setCloudProgress(null);
      return false;
    } finally {
      cloudBusyRef.current = false;
      if (cloudDirtyRef.current) setTimeout(() => { void syncCloudRef.current({}); }, 3000);
    }
  }, [bakeVstBeforeSave, user, setCloudSession, setVisualState]);
  const syncCloudRef = useRef(syncCloud);
  syncCloudRef.current = syncCloud;

  // Synchronisation automatique 20 s après la dernière modification (hors lecture / prise).
  useEffect(() => {
    if (!isCloudProject || showLanding || state.isPlaying || state.isRecording) return;
    if (Date.now() < cloudQuietUntilRef.current) return;
    if (collabRef.current && collabRef.current.role !== 'artist') return;
    const t = window.setTimeout(() => { void syncCloudRef.current({}); }, 20000);
    return () => window.clearTimeout(t);
  }, [state.tracks, state.lyrics, state.bpm, state.markers, state.name, state.isPlaying, state.isRecording, showLanding, isCloudProject]);
  // Onglet caché / application mise en arrière-plan (iPad) : on envoie tout de suite.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden' && isCloudProject) void syncCloudRef.current({}); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [isCloudProject]);

  /** Ouvre une session en ligne (lien du client, compte Make Music). */
  const openCloudSession = useCallback(async (link: CloudLink) => {
    setCloudError(null);
    setCloudProgress({ pct: 1, msg: 'Ouverture de la session…' });
    try {
      const { state: project, info } = await pullSession(link, (pct, msg) => setCloudProgress({ pct, msg }));
      const secret = link.secret || parseLink(info.link)?.secret;
      cloudQuietUntilRef.current = Date.now() + 15000; // le chargement (beat…) n'est pas une modification
      restoreBeatAfterResumeRef.current = true;
      handleEnterWithProject({ ...project, id: cloudProjectId(info.id) });
      setCloudSession({ id: info.id, secret, version: info.version, name: info.name, syncedAt: Date.now() });
      const when = info.updated_at ? formatAgo(Date.parse(info.updated_at)) : '';
      setAiNotification(`☁️ Session « ${info.name} » ouverte${info.updated_from ? ` (dernière modification ${when} sur ${info.updated_from})` : ''}. Tes modifications se synchronisent toutes seules.`);
      try { const u = new URL(window.location.href); u.searchParams.delete('session'); window.history.replaceState(null, '', u.toString()); } catch { /* */ }
    } catch (e: any) {
      setShowLanding(false);
      setAiNotification(`⚠️ Session en ligne impossible à ouvrir : ${e?.message || 'lien invalide'}`);
    } finally {
      setTimeout(() => setCloudProgress(null), 600);
    }
  }, [setCloudSession]);

  // Ouverture par lien : /daw?session=<id>.<clé> (QR code, WhatsApp, espace client).
  useEffect(() => {
    let raw: string | null = null;
    try { raw = new URLSearchParams(window.location.search).get('session'); } catch { /* */ }
    const link = parseLink(raw);
    if (!link) return;
    let role: string | null = null;
    try { role = new URLSearchParams(window.location.search).get('role'); } catch { /* */ }
    if (role === 'artist' || role === 'engineer' || role === 'beatmaker') pendingCollabRoleRef.current = role;
    void openCloudSession(link);
  }, []);

  // --- Collaboration à distance (artiste, ingé son, beatmaker) -----------------------
  const COLLAB_ACTIVE_KEY = 'nova_collab_active';
  const [collabOpen, setCollabOpen] = useState(false);
  const collabOpenRef = useRef(false);
  collabOpenRef.current = collabOpen;
  const [collab, setCollab] = useState<{ client: CollabClient; role: CollabRole; name: string } | null>(null);
  const collabRef = useRef(collab);
  collabRef.current = collab;
  const [collabOnline, setCollabOnline] = useState<CollabMember[]>([]);
  const [collabMessages, setCollabMessages] = useState<CollabMessage[]>([]);
  const [collabBusy, setCollabBusy] = useState<string | null>(null);
  const pendingCollabRoleRef = useRef<CollabRole | null>(null);
  // Signatures connues (envoyées ou reçues) par domaine : rien n'est renvoyé en écho.
  const knownSigRef = useRef(new Map<string, string>());
  const knownFreezeRef = useRef(new Map<string, string>());
  const remoteTouchedRef = useRef(new Set<string>());
  const contentDirtyRef = useRef(new Set<string>());
  const mixTimersRef = useRef(new Map<string, number>());
  // Mix champ par champ (règle : dernière écriture gagne, par paramètre ; utils/collabMerge).
  const knownFieldsRef = useRef(new Map<string, Record<string, string>>());
  /** Champs modifiés ici, pas encore mis en file (250 ms) : jamais écrasés par ceux de l'autre. */
  const pendingMixRef = useRef(new Map<string, Set<string>>());
  const lwwRef = useRef(new LwwClock());
  const freezeDirtyRef = useRef(new Set<string>());
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peerSeenAt, setPeerSeenAt] = useState<number | null>(null);
  /** Mix envoyé (ingé) / reçu (artiste) : l'aperçu des VST de l'artiste suit (voir plus bas). */
  const onLocalMixRef = useRef<((trackId: string, fields: MixFields) => void) | null>(null);
  const onRemoteMixRef = useRef<((trackId: string, fields: MixFields) => void) | null>(null);

  // En direct : VST de l'artiste réglés à distance par l'ingé (services/LiveVstRemote).
  const vstReqsRef = useRef(new VstRemoteRequests<any>());
  const [artistVstCatalog, setArtistVstCatalog] = useState<VstCatalogEntry[] | null>(null);
  const liveVstDeps: LiveVstDeps = useMemo(() => ({
    isConnected: () => novaBridge.isConnected(),
    paramsText: () => !!novaBridge.getBridgeState().paramsText,
    slotOf: (id: string) => liveVstNodes.get(id)?.getSlotId() || null,
    setParams: (slot, params) => novaBridge.setParams(slot, params),
    getParams: (slot) => novaBridge.getParams(slot),
    syncState: async (id) => (await liveVstNodes.get(id)?.syncState()) || null,
  }), []);

  // En direct : l'ingé ENTEND les VST de l'artiste (services/LivePreview). Le pont de
  // l'artiste rend la piste sur une fenêtre du morceau, l'aperçu joue chez l'ingé.
  const previewWantedRef = useRef(new Set<string>());
  const previewTrackerRef = useRef(new PreviewTracker());
  const [previewStates, setPreviewStates] = useState<Record<string, PreviewState>>({});
  const syncPreviewStates = useCallback(() => setPreviewStates(previewTrackerRef.current.all()), []);
  const previewSchedRef = useRef<PreviewScheduler | null>(null);
  if (!previewSchedRef.current) {
    previewSchedRef.current = new PreviewScheduler({
      blockedReason: () => (stateRef.current.isRecording ? "l'artiste enregistre une prise" : null),
      onState: (trackId, st, message) => {
        collabRef.current?.client.queue(`pvs:${trackId}`, 'vst_preview_state', { trackId, state: st, ...(message ? { message } : {}) });
      },
      run: async (trackId, win) => {
        const c = collabRef.current;
        if (!c || c.role !== 'artist') return;
        const t = stateRef.current.tracks.find(x => x.id === trackId);
        if (!t || !hasArtistVst(t)) throw new Error("Il n'y a plus de VST de l'artiste sur cette piste.");
        if (!novaBridge.isConnected()) throw new Error("Le pont VST de l'artiste n'est pas connecté : il doit ouvrir NOVA Studio pour Windows.");
        const w = win || previewWindowOf(t, stateRef.current.currentTime || 0, null);
        const r = await renderTrackPreview(t, w, PREVIEW_TAIL);
        try {
          const audio = await uploadBuffers(c.client.link, [r.clip.bufferId!], (sent, total) => c.client.reportUpload(sent, total));
          const { buffer: _b, ...clip } = r.clip as Clip & { buffer?: AudioBuffer };
          c.client.queue(`pv:${trackId}`, 'vst_preview', { trackId, clip, upTo: r.upTo, refs: anchorClipsToWindow(t.clips || [], r.clip.id, w), win: w, audio });
        } finally {
          audioBufferRegistry.remove(r.clip.bufferId!);
        }
      },
    });
  }
  /** Ingé : fenêtre écoutée (boucle active, sinon autour de la tête de lecture). */
  const previewWinFor = (trackId: string) => {
    const st = stateRef.current;
    const t = st.tracks.find(x => x.id === trackId);
    return t ? previewWindowOf(t, st.currentTime || 0, st.isLoopActive ? { start: st.loopStart, end: st.loopEnd } : null) : undefined;
  };
  /** Ingé : demande un aperçu à jour (bouton, arrivée dans la session). */
  const requestArtistPreview = useCallback((trackId: string) => {
    const c = collabRef.current;
    if (!c || c.role !== 'engineer') return;
    const win = previewWinFor(trackId);
    previewTrackerRef.current.expect(trackId, win);
    syncPreviewStates();
    c.client.queue(`pvg:${trackId}`, 'vst_preview_get', { trackId, ...(win ? { win } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPreviewStates]);

  // --- Instruments VST3 du PC sur les pistes MIDI (mode instru) ---------------------
  // Les notes sont rendues par le pont et jouées comme un rendu gelé (sauvegardé,
  // exporté, envoyé en collaboration) : le son du VST se joue aussi sans pont.
  const notifyInstrument = useCallback((msg: string, ms = 5000) => {
    setAiNotification(msg);
    setTimeout(() => setAiNotification(null), ms);
  }, []);
  const vstInstruments = useVstInstruments({
    tracks: state.tracks, bpm: state.bpm, stateRef, setSilently,
    canRender: (t) => { const c = collabRef.current; return !c || ownsContent(t, c.role); },
    releaseBuffer: (id) => releaseBufferIfUnused(id, []),
    notify: (msg) => notifyInstrument(msg, 6000),
  });

  const handleChooseInstrument = useCallback((trackId: string, p: BridgePlugin) => {
    track('vst_instrument_chosen', { name: String((p as any).name || '') });
    let old: string | undefined;
    setState(produce((d: DAWState) => {
      const t = d.tracks.find(x => x.id === trackId);
      if (!t) return;
      // Ancien son retiré : le synthé Nova joue en attendant le rendu du nouveau.
      if (t.vstInstrument || t.isFrozen) { old = t.frozenClip?.bufferId; clearInstrumentRender(t); }
      t.vstInstrument = instrumentFromPlugin(p);
    }));
    if (old) setTimeout(() => releaseBufferIfUnused(old, []), 0);
    notifyInstrument(`🎹 ${p.name} sur ta piste : clique « Choisir le son » pour ouvrir sa fenêtre sur ton PC.`);
  }, [setState, notifyInstrument]);

  const handleUseSynth = useCallback((trackId: string) => {
    let old: string | undefined;
    setState(produce((d: DAWState) => {
      const t = d.tracks.find(x => x.id === trackId);
      if (!t?.vstInstrument) return;
      old = t.frozenClip?.bufferId;
      clearInstrumentRender(t);
      delete t.vstInstrument;
    }));
    if (old) setTimeout(() => releaseBufferIfUnused(old, []), 0);
  }, [setState]);

  /** Ce que tout le monde a déjà (rien n'est renvoyé). mix:false : le mix est suivi champ par champ à part. */
  const rememberTrack = (t: Track, opts: { mix?: boolean } = {}) => {
    if (opts.mix !== false || !knownFieldsRef.current.has(t.id)) knownFieldsRef.current.set(t.id, fieldSigsOf(mixFieldsOf(t)));
    knownSigRef.current.set('content:' + t.id, sigOf(contentOf(t)));
    if (t.frozenClip) knownFreezeRef.current.set(t.id, t.frozenClip.id);
  };

  /** Applique une opération reçue d'un collaborateur. */
  const applyCollabOp = useCallback(async (o: CollabOp) => {
    const c = collabRef.current;
    if (!c) return;
    const p = o.op || {};
    const touch = (id: string) => remoteTouchedRef.current.add(id);
    // Chacun son domaine : une opération hors de ses droits est ignorée (avant,
    // n'importe quel membre pouvait écraser les prises ou le mix d'un autre).
    const existing = typeof p.trackId === 'string' ? stateRef.current.tracks.find(x => x.id === p.trackId) : undefined;
    const refuse = (why: string) => { console.warn('[Collab] opération refusée', o.kind, o.role, why); };
    if (!o.replay) setPeerSeenAt(Date.now());
    if ((o.kind === 'mix' || o.kind === 'freeze') && o.role !== 'engineer') return refuse('réservé à l’ingé son');
    if (o.kind === 'lock' && !(o.role === 'artist' || (o.role === 'engineer' && !p.lock))) return refuse('verrou');
    if (o.kind === 'content' && existing && !ownsContent(existing, o.role)) return refuse('piste d’un autre rôle');
    // En direct : l'ingé règle les VST hébergés par le pont du PC de l'artiste.
    if (LIVE_PREVIEW_KINDS.has(o.kind)) {
      if (o.replay) return; // ancien aperçu : l'ingé en redemande un à jour
      if (o.kind === 'vst_preview_get' && o.role === 'engineer' && c.role === 'artist') {
        previewWantedRef.current.add(String(p.trackId));
        previewSchedRef.current?.request(String(p.trackId), p.win);
      } else if (o.kind === 'vst_preview_state' && o.role === 'artist' && c.role === 'engineer') {
        previewTrackerRef.current.remote(String(p.trackId), p.state === 'waiting' || p.state === 'error' ? p.state : 'rendering', typeof p.message === 'string' ? p.message.slice(0, 300) : undefined);
        syncPreviewStates();
      } else if (o.kind === 'vst_preview' && o.role === 'artist' && c.role === 'engineer') {
        if (!lwwRef.current.accept(`preview:${p.trackId}`, o.seq)) return;
        await ensureBuffers(c.client.link, p.audio);
        let released: string[] = [];
        let posed = false;
        touch(p.trackId);
        setSilently(produce((d: DAWState) => {
          const t = d.tracks.find(x => x.id === p.trackId);
          const r = t ? applyPreviewOnEngineer(t as Track, p) : null;
          if (r) { released = r.released; posed = true; }
        }));
        setTimeout(() => released.forEach(id => releaseBufferIfUnused(id, [])), 0);
        previewTrackerRef.current.ready(String(p.trackId), p.win);
        syncPreviewStates();
        void posed;
      }
      return;
    }
    if (LIVE_VST_KINDS.has(o.kind)) {
      if ((o.kind === 'vst_param' || o.kind === 'vst_params_get') && o.role === 'engineer' && c.role === 'artist') {
        // Demande d'avant notre arrivée (rattrapage du journal) : l'ingé n'attend plus la réponse.
        if (o.replay) return;
        const reply = o.kind === 'vst_param' ? await applyRemoteVstParams(p, liveVstDeps) : await readRemoteVstParams(p, liveVstDeps);
        c.client.queue(`${o.kind}:${p.reqId}`, o.kind === 'vst_param' ? 'vst_param_ack' : 'vst_params', reply as unknown as Record<string, unknown>);
        if (o.kind === 'vst_param' && (reply as VstParamAck).ok) {
          // L'ingé n'a pas ce VST : son pont rend un aperçu (~1 s après le dernier réglage).
          previewWantedRef.current.add(String(p.trackId));
          previewSchedRef.current?.request(String(p.trackId), p.win);
        }
        if (o.kind === 'vst_param' && (reply as VstParamAck).ok) setAiNotification(`🎛️ ${o.author_name} (ingé) a réglé ${(existing?.plugins.find(x => x.id === p.pluginId)?.name) || 'un VST'} sur ton PC.`);
      } else if ((o.kind === 'vst_param_ack' || o.kind === 'vst_params') && o.role === 'artist' && c.role === 'engineer') {
        if (o.kind === 'vst_param_ack' && p.ok && typeof p.stateB64 === 'string') {
          // État relu chez l'artiste : notre prochain envoi de mix ne le réécrase pas.
          setSilently(produce((d: DAWState) => { d.tracks.forEach(t => t.plugins.forEach(x => { if (x.id === p.pluginId && x.type === 'VST3') x.params = { ...x.params, stateB64: p.stateB64 }; })); }));
        }
        vstReqsRef.current.resolve(String(p.reqId), p);
      } else if (o.kind === 'vst_catalog' && o.role === 'artist' && c.role === 'engineer') {
        setArtistVstCatalog(Array.isArray(p.plugins) ? p.plugins.slice(0, 400) : []);
      }
      return;
    }
    switch (o.kind) {
      case 'chat': {
        const text = String(p.text || '').slice(0, 2000);
        setCollabMessages(m => [...m.slice(-199), { id: String(o.seq), from: o.author_name, role: o.role, text, at: Date.parse(o.created_at || '') || Date.now() }]);
        if (!collabOpenRef.current && !o.replay) setAiNotification(`💬 ${o.author_name} (${ROLE_LABEL[o.role] || o.role}) : ${text.slice(0, 140)}`);
        break;
      }
      case 'mix': {
        // Champ par champ : le plus récent du journal gagne ; un champ modifié ici et
        // pas encore parti n'est pas écrasé (le nôtre partira après et gagnera partout).
        const tid = String(p.trackId || '');
        const fields: MixFields = p.fields && typeof p.fields === 'object' ? p.fields : legacyMixToFields(p.mix);
        const pend = pendingMixRef.current.get(tid);
        const queued = (c.client.outbox.peek('mix:' + tid)?.fields || {}) as MixFields;
        const ok = new Set(Object.keys(fields).filter(f => lwwRef.current.accept(`${tid}:${f}`, o.seq) && !pend?.has(f) && !(f in queued)));
        if (!ok.size) break;
        const known = { ...(knownFieldsRef.current.get(tid) || {}) };
        ok.forEach(f => { known[f] = fieldSig(fields[f]); });
        knownFieldsRef.current.set(tid, known);
        setState(produce((d: DAWState) => { const t = d.tracks.find(x => x.id === tid); if (t) applyMixFields(t as Track, fields, f => ok.has(f)); }));
        onRemoteMixRef.current?.(tid, fields);
        break;
      }
      case 'lock': {
        if (!lwwRef.current.accept(`lock:${p.trackId}`, o.seq)) break;
        touch(p.trackId);
        setState(produce((d: DAWState) => {
          const t = d.tracks.find(x => x.id === p.trackId);
          if (!t) return;
          if (p.lock) { t.volumeLock = p.lock; t.volume = p.lock.volume; } else delete t.volumeLock;
        }));
        if (p.lock) setAiNotification(`🔒 ${o.author_name} a verrouillé le volume de « ${stateRef.current.tracks.find(x => x.id === p.trackId)?.name || 'une piste'} » : c'est le volume qu'il / elle veut.`);
        else setAiNotification(`🔓 Volume déverrouillé par ${o.author_name} (${ROLE_LABEL[o.role] || o.role}).`);
        break;
      }
      case 'content': {
        // Version plus ancienne arrivée en retard : ignorée.
        if (!lwwRef.current.accept(`content:${p.trackId}`, o.seq)) break;
        await ensureBuffers(c.client.link, p.audio);
        touch(p.trackId);
        setState(produce((d: DAWState) => {
          const ct = p.content || {};
          let t = d.tracks.find(x => x.id === p.trackId);
          if (!t) {
            // Piste créée par un collaborateur (batterie, basse, piste d'envoi…)
            t = {
              id: p.trackId, name: ct.name || 'PISTE', type: ct.type || TrackType.AUDIO, color: ct.color || '#94a3b8',
              isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
              outputTrackId: ct.outputTrackId || 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
            } as Track;
            const at = d.tracks.findIndex(x => x.type === TrackType.BUS || x.type === TrackType.SEND || x.id === 'master');
            d.tracks.splice(at >= 0 ? at : d.tracks.length, 0, t);
            if (p.mix) Object.assign(t, { volume: p.mix.volume ?? 1, pan: p.mix.pan ?? 0, sends: p.mix.sends || [], plugins: p.mix.plugins || [] });
          }
          t.name = ct.name ?? t.name;
          t.color = ct.color ?? t.color;
          if (ct.collabOwner) t.collabOwner = ct.collabOwner;
          if (ct.drumMachine !== undefined) t.drumMachine = ct.drumMachine;
          if (ct.drumPads !== undefined) t.drumPads = ct.drumPads;
          if (ct.bass808 !== undefined) t.bass808 = ct.bass808;
          t.clips = Array.isArray(ct.clips) ? ct.clips : t.clips;
          // Instrument VST du beatmaker : on reçoit le rendu de ses notes.
          if (ct.vstInstrument) {
            const keep = t.vstInstrument?.path === ct.vstInstrument.path ? t.vstInstrument.stateB64 : undefined;
            t.vstInstrument = { ...ct.vstInstrument, ...(keep ? { stateB64: keep } : {}) };
            const r = ct.instrumentRender;
            if (r?.frozenClip) {
              t.isFrozen = true;
              t.frozenClip = r.frozenClip;
              t.frozenUpToPluginIndex = -1;
              t.frozenClipIds = r.frozenClipIds;
              t.frozenSourceSig = r.frozenSourceSig;
              delete t.frozenPluginSig;
            } else clearInstrumentRender(t);
          } else if (t.vstInstrument) {
            clearInstrumentRender(t);
            delete t.vstInstrument;
          }
        }));
        break;
      }
      case 'freeze': {
        // Piste gelée par l'ingé son avec ses VST : on reçoit le rendu, la piste reste éditable.
        if (!lwwRef.current.accept(`freeze:${p.trackId}`, o.seq)) break;
        await ensureBuffers(c.client.link, p.audio);
        touch(p.trackId);
        setState(produce((d: DAWState) => {
          const t = d.tracks.find(x => x.id === p.trackId);
          if (!t) return;
          t.frozenClip = p.frozenClip;
          t.frozenUpToPluginIndex = p.frozenUpToPluginIndex;
          t.frozenClipIds = p.frozenClipIds;
          t.frozenSourceSig = p.frozenSourceSig;
          t.frozenPluginSig = p.frozenPluginSig;
          t.isFrozen = true;
          const refs = p.refs || {};
          t.clips = t.clips.map(cl => (refs[cl.id] ? { ...cl, freezeRef: refs[cl.id] } : cl));
        }));
        setAiNotification(`❄️ ${o.author_name} a gelé « ${stateRef.current.tracks.find(x => x.id === p.trackId)?.name || 'une piste'} » avec ses effets : tu l'entends telle qu'il / elle la règle, et tu peux toujours éditer tes prises.`);
        break;
      }
      default:
        break;
    }
  }, [setState]);

  /** Envoie le contenu d'une piste (prises, motifs) avec son audio. */
  const sendTrackContent = useCallback(async (trackId: string) => {
    const c = collabRef.current;
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (!c || !t) return;
    const content = contentOf(t);
    const audio = await uploadBuffers(c.client.link, contentBufferIds(t), (sent, total) => c.client.reportUpload(sent, total));
    const isNew = !knownFieldsRef.current.has(t.id);
    await c.client.send('content', { trackId, content, audio, ...(isNew ? { mix: mixOf(t) } : {}) });
    knownSigRef.current.set('content:' + t.id, sigOf(content));
    if (isNew) knownFieldsRef.current.set(t.id, fieldSigsOf(mixFieldsOf(t)));
    if (c.role === 'artist' && previewWantedRef.current.has(t.id) && hasArtistVst(t)) previewSchedRef.current?.request(t.id);
  }, []);

  const sendFreeze = useCallback(async (trackId: string) => {
    const c = collabRef.current;
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (!c || !t?.frozenClip?.bufferId) return;
    const audio = await uploadBuffers(c.client.link, [t.frozenClip.bufferId], (sent, total) => c.client.reportUpload(sent, total));
    const { buffer: _b, ...frozenClip } = t.frozenClip as Clip & { buffer?: AudioBuffer };
    const refs: Record<string, unknown> = {};
    t.clips.forEach(cl => { if (cl.freezeRef) refs[cl.id] = cl.freezeRef; });
    await c.client.send('freeze', {
      trackId, frozenClip, frozenUpToPluginIndex: t.frozenUpToPluginIndex, frozenClipIds: t.frozenClipIds,
      frozenSourceSig: t.frozenSourceSig, frozenPluginSig: t.frozenPluginSig, refs, audio,
    });
  }, []);

  // Détection des modifications locales, selon le rôle.
  useEffect(() => {
    const c = collabRef.current;
    if (!c) return;
    for (const t of state.tracks) {
      // Reçu de l'autre : contenu / gel connus (le mix, lui, est suivi champ par champ à la réception).
      if (remoteTouchedRef.current.has(t.id)) { rememberTrack(t, { mix: false }); remoteTouchedRef.current.delete(t.id); continue; }
      const isNew = !knownSigRef.current.has('content:' + t.id);
      if (isNew) {
        // Piste créée ici pendant la collaboration : elle appartient à son créateur.
        if (t.id !== 'instrumental' && !t.collabOwner && (c.role !== 'artist' || t.type !== TrackType.AUDIO)) {
          setState(produce((d: DAWState) => { const x = d.tracks.find(y => y.id === t.id); if (x) x.collabOwner = c.role; }));
          continue;
        }
        contentDirtyRef.current.add(t.id);
        continue;
      }
      if (c.role === 'engineer') {
        // Seuls les réglages modifiés partent (les autres ne sont jamais écrasés chez l'artiste).
        const changed = changedFields(knownFieldsRef.current.get(t.id), mixFieldsOf(t));
        const names = Object.keys(changed);
        if (names.length) {
          knownFieldsRef.current.set(t.id, { ...(knownFieldsRef.current.get(t.id) || {}), ...fieldSigsOf(changed) });
          const pend = pendingMixRef.current.get(t.id) || new Set<string>();
          names.forEach(n => pend.add(n));
          pendingMixRef.current.set(t.id, pend);
          const old = mixTimersRef.current.get(t.id);
          if (old) window.clearTimeout(old);
          mixTimersRef.current.set(t.id, window.setTimeout(() => {
            mixTimersRef.current.delete(t.id);
            const wanted = pendingMixRef.current.get(t.id);
            pendingMixRef.current.delete(t.id);
            const cur = stateRef.current.tracks.find(x => x.id === t.id);
            const cc = collabRef.current;
            if (!cur || !cc || !wanted?.size) return;
            const all = mixFieldsOf(cur);
            const fields: MixFields = {};
            wanted.forEach(f => { if (f in all) fields[f] = all[f]; });
            if (!Object.keys(fields).length) return;
            // File d'envoi : hors ligne, ça part au retour du réseau (rien ne se perd).
            cc.client.queue('mix:' + t.id, 'mix', { trackId: t.id, fields });
            onLocalMixRef.current?.(t.id, fields);
          }, 250));
        }
        // Gel avec ses VST (pas l'aperçu reçu de l'artiste) : le rendu part chez l'artiste.
        if (t.isFrozen && t.frozenClip && !t.livePreview && knownFreezeRef.current.get(t.id) !== t.frozenClip.id) {
          knownFreezeRef.current.set(t.id, t.frozenClip.id);
          void sendFreeze(t.id).catch(e => { console.warn('[Collab] gel', e); freezeDirtyRef.current.add(t.id); });
        }
      }
      if (ownsContent(t, c.role) && knownSigRef.current.get('content:' + t.id) !== sigOf(contentOf(t))) contentDirtyRef.current.add(t.id);
    }
  }, [state.tracks, collab, setState, sendFreeze]);

  // Toutes les 10 s : prises et pistes modifiées envoyées (jamais pendant une prise).
  useEffect(() => {
    if (!collab) return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy || stateRef.current.isRecording || (contentDirtyRef.current.size === 0 && freezeDirtyRef.current.size === 0)) return;
      busy = true;
      const ids = Array.from(contentDirtyRef.current);
      contentDirtyRef.current.clear();
      for (const tid of ids) {
        try { await sendTrackContent(tid); } catch (e) { console.warn('[Collab] contenu', e); contentDirtyRef.current.add(tid); }
      }
      // Gels de l'ingé pas partis (réseau coupé pendant l'envoi) : renvoyés.
      const fz = Array.from(freezeDirtyRef.current);
      freezeDirtyRef.current.clear();
      for (const tid of fz) {
        try { await sendFreeze(tid); } catch (e) { console.warn('[Collab] gel', e); freezeDirtyRef.current.add(tid); }
      }
      busy = false;
    }, 10000);
    return () => window.clearInterval(id);
  }, [collab, sendTrackContent, sendFreeze]);

  /** Démarre (ou rejoint) la collaboration avec un rôle. */
  // --- Nova Pro : verrou des fonctions payantes ---------------------------------------
  const [proGate, setProGate] = useState<{ reason: string; resolve: (ok: boolean) => void } | null>(null);
  const proOkRef = useRef<{ at: number; ok: boolean } | null>(null);
  requireProRef.current = async (reason: string) => {
    const c = proOkRef.current;
    if (c?.ok && Date.now() - c.at < 10 * 60_000) return true;
    const st = await billingStatus();
    const ok = hasPlan(st, 'collab');
    proOkRef.current = { at: Date.now(), ok };
    if (ok) return true;
    track('pro_gate_shown', { reason: /import/i.test(reason) ? 'import' : reason.slice(0, 40) });
    return new Promise<boolean>(resolve => setProGate({ reason, resolve }));
  };

  const [collabGate, setCollabGate] = useState<'login' | 'subscribe' | null>(null);
  /** quiet : reprise automatique après un rechargement de la page (pas de fenêtre de connexion). */
  const startCollab = useCallback(async (role: CollabRole, name: string, opts: { quiet?: boolean } = {}) => {
    if (remoteRef.current?.active) await remoteRef.current.leave(false);
    setCollabBusy(opts.quiet ? 'Reconnexion à la collaboration…' : 'Mise en ligne de la session…');
    setCollabGate(null);
    try {
      // Collaboration = compte Make Music + abonnement 5 €/mois (vérifié aussi par le serveur).
      const st = await billingStatus();
      const { data: who } = await catalogSupabase.auth.getUser();
      if (!who?.user) { if (!opts.quiet) setCollabGate('login'); pendingStartRef.current = { role, name }; return; }
      if (!hasPlan(st, 'collab')) { if (!opts.quiet) { track('pro_gate_shown', { reason: 'collab' }); setCollabGate('subscribe'); } pendingStartRef.current = { role, name }; return; }
      if (!(cloudRef.current && stateRef.current.id === cloudProjectId(cloudRef.current.id))) {
        const ok = await syncCloudRef.current({ interactive: true });
        if (!ok) throw new Error("la session n'a pas pu être mise en ligne");
      }
      const cs = cloudRef.current!;
      setCollabBusy('Connexion aux collaborateurs…');
      const client = new CollabClient({ id: cs.id, secret: cs.secret }, role, name,
        (op) => applyCollabOp(op),
        (online) => setCollabOnline(online),
        // File d'envoi gardée dans le navigateur : un rechargement ne perd rien.
        { outboxStore: localCollabOutboxStore(`nova_collab_outbox_${cs.id}_${role}`) });
      client.onFailure = (o) => setAiNotification(`⚠️ Une modification de ${o.author_name} n'a pas pu être reçue (connexion). Demande-lui de la renvoyer, ou recharge la session (panneau Collaboration).`);
      client.onSent = (kind, op, seq) => {
        const tid = typeof op.trackId === 'string' ? op.trackId : '';
        if (kind === 'mix' && op.fields && typeof op.fields === 'object') Object.keys(op.fields).forEach(f => lwwRef.current.note(`${tid}:${f}`, seq));
        else if (kind === 'content' || kind === 'lock' || kind === 'freeze') lwwRef.current.note(`${kind}:${tid}`, seq);
        else if (kind === 'chat' && typeof op.localId === 'string') setCollabMessages(m => m.map(x => (x.id === op.localId ? { ...x, pending: false } : x)));
      };
      client.onStatus(s => setCollabStatus(s));
      lwwRef.current.clear();
      // Le projet en cours devient la base : on ne renvoie pas ce que tout le monde a déjà.
      stateRef.current.tracks.forEach(t => rememberTrack(t));
      setCollab({ client, role, name });
      collabRef.current = { client, role, name };
      collabRoleStore.set(role);
      await client.join(stateRef.current.collabSeq || 0);
      try { localStorage.setItem(COLLAB_ACTIVE_KEY, JSON.stringify({ sessionId: cs.id, role, name })); } catch { /* */ }
      track('collab_started', { role });
      if (opts.quiet) setAiNotification(`👥 Collaboration reprise (${ROLE_LABEL[role]}) : les modifications manquées ont été rattrapées.`);
      else setAiNotification(`👥 Collaboration ouverte (${ROLE_LABEL[role]}). ${role === 'artist' ? 'Tes prises partent toutes les 10 s chez l\'ingé son.' : role === 'engineer' ? 'Tes réglages partent en direct chez l\'artiste ; avec tes VST, gèle la piste pour l\'envoyer.' : 'Tes pistes partent toutes les 10 s chez les autres.'}`);
    } catch (e: any) {
      const msg = String(e?.message || 'erreur');
      if (/Connecte-toi/.test(msg) && !opts.quiet) setCollabGate('login');
      else if (/Abonnement/.test(msg) && !opts.quiet) setCollabGate('subscribe');
      else setAiNotification(opts.quiet
        ? `⚠️ Reconnexion à la collaboration impossible (${msg}). Ouvre « Collaborer » pour réessayer.`
        : `⚠️ Collaboration impossible : ${msg}. Vérifie ta connexion puis réessaie.`);
      pendingStartRef.current = { role, name };
      void collabRef.current?.client.leave();
      collabRoleStore.set(null);
      setCollab(null);
      setCollabStatus(null);
      collabRef.current = null;
    } finally {
      setCollabBusy(null);
    }
  }, [applyCollabOp]);
  const pendingStartRef = useRef<{ role: CollabRole; name: string } | null>(null);
  const collabPayCancelRef = useRef(false);
  const subscribeCollab = useCallback(async () => {
    try {
      collabPayCancelRef.current = false;
      const sid = await openCheckout('collab');
      setCollabBusy('En attente du paiement (onglet Stripe)…');
      // Fermer le panneau arrête l'attente (avant : bouton bloqué 20 minutes).
      const ok = await waitPaid(sid, () => collabPayCancelRef.current);
      setCollabBusy(null);
      if (ok) {
        track('pro_subscribed', { from: 'collab' });
        setCollabGate(null);
        setAiNotification('✅ Abonnement collaboration actif : bienvenue !');
        const p = pendingStartRef.current;
        if (p) void startCollab(p.role, p.name);
      }
    } catch (e: any) {
      setCollabBusy(null);
      setAiNotification(`⚠️ Abonnement impossible : ${e?.message || 'erreur'}`);
    }
  }, [startCollab]);

  /** keepResume : on garde la reprise automatique (« Recharger la session »). */
  const leaveCollab = useCallback(async (opts: { keepResume?: boolean } = {}) => {
    const c = collabRef.current;
    collabRoleStore.set(null);
    setCollab(null);
    collabRef.current = null;
    setCollabOnline([]);
    setCollabStatus(null);
    setPeerSeenAt(null);
    mixTimersRef.current.forEach(t => window.clearTimeout(t));
    mixTimersRef.current.clear();
    pendingMixRef.current.clear();
    contentDirtyRef.current.clear();
    freezeDirtyRef.current.clear();
    knownFieldsRef.current.clear();
    lwwRef.current.clear();
    leaveLivePreviewRef.current?.();
    if (!opts.keepResume) { try { localStorage.removeItem(COLLAB_ACTIVE_KEY); } catch { /* */ } }
    if (c) await c.client.leave();
  }, []);
  const leaveLivePreviewRef = useRef<(() => void) | null>(null);
  leaveLivePreviewRef.current = () => {
    previewSchedRef.current?.dispose();
    previewWantedRef.current.clear();
    previewTrackerRef.current.clear();
    setPreviewStates({});
    // Les aperçus reçus de l'artiste disparaissent (la piste rejoue sans ses VST).
    if (stateRef.current.tracks.some(t => t.livePreview)) {
      const released: string[] = [];
      setSilently(produce((d: DAWState) => { d.tracks.forEach(t => { const b = clearPreviewOnEngineer(t as Track); if (b) released.push(b); }); }));
      setTimeout(() => released.forEach(id => releaseBufferIfUnused(id, [])), 0);
    }
  };
  onLocalMixRef.current = (trackId, fields) => {
    // Ingé : effets changés sur une piste avec un VST de l'artiste → son pont refait l'aperçu.
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    if (collabRef.current?.role === 'engineer' && t && touchesPlugins(fields) && hasArtistVst(t)) {
      previewTrackerRef.current.expect(trackId, previewWinFor(trackId));
      syncPreviewStates();
    }
  };
  onRemoteMixRef.current = (trackId, fields) => {
    // Artiste : l'ingé a changé les effets d'une piste qui passe par mes VST → nouvel aperçu.
    if (collabRef.current?.role !== 'artist' || !touchesPlugins(fields)) return;
    setTimeout(() => {
      const t = stateRef.current.tracks.find(x => x.id === trackId);
      if (t && hasArtistVst(t)) { previewWantedRef.current.add(trackId); previewSchedRef.current?.request(trackId); }
    }, 0);
  };
  // Diagnostic en lecture seule (console, tests de bout en bout) : état de la collaboration.
  useEffect(() => {
    (window as any).__novaCollab = {
      status: () => collabRef.current?.client.getStatus() ?? null,
      role: () => collabRef.current?.role ?? null,
      previews: () => previewTrackerRef.current.all(),
      track: (idOrName: string) => {
        const t = stateRef.current.tracks.find(x => x.id === idOrName || x.name === idOrName);
        return t ? {
          id: t.id, name: t.name, volume: t.volume, pan: t.pan, isMuted: t.isMuted, isFrozen: !!t.isFrozen,
          plugins: (t.plugins || []).map(x => ({ id: x.id, type: x.type, name: x.name })), livePreview: t.livePreview || null,
        } : null;
      },
    };
    return () => { delete (window as any).__novaCollab; };
  }, []);
  // Délais d'attente de l'aperçu (pont de l'artiste qui ne répond pas → message clair).
  useEffect(() => {
    if (!collab || collab.role !== 'engineer') return;
    const id = window.setInterval(() => { if (previewTrackerRef.current.tick()) syncPreviewStates(); }, 3000);
    return () => window.clearInterval(id);
  }, [collab, syncPreviewStates]);
  // Prise terminée : les aperçus qui attendaient partent.
  useEffect(() => { if (!state.isRecording) previewSchedRef.current?.resume(); }, [state.isRecording]);
  // Ingé qui arrive : un aperçu pour chaque piste qui a déjà un VST de l'artiste.
  useEffect(() => {
    if (!collab || collab.role !== 'engineer') return;
    const t = window.setTimeout(() => {
      stateRef.current.tracks.filter(hasArtistVst).forEach(x => { if (!x.livePreview) requestArtistPreview(x.id); });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [collab, requestArtistPreview]);

  // Page rechargée en pleine collaboration : on rejoint tout seul (même rôle), le
  // journal rattrape ce qui a été manqué, la file d'envoi repart.
  const resumeCollabTriedRef = useRef('');
  useEffect(() => {
    if (collab || showLanding || !cloudSession || state.id !== cloudProjectId(cloudSession.id) || pendingCollabRoleRef.current) return;
    let saved: { sessionId: string; role: CollabRole; name: string } | null = null;
    try { saved = JSON.parse(localStorage.getItem(COLLAB_ACTIVE_KEY) || 'null'); } catch { /* */ }
    if (!saved || saved.sessionId !== cloudSession.id || resumeCollabTriedRef.current === cloudSession.id) return;
    const s = saved;
    const t = window.setTimeout(() => {
      resumeCollabTriedRef.current = cloudSession.id;
      void startCollab(s.role, s.name || ROLE_LABEL[s.role], { quiet: true });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [state.id, cloudSession, collab, showLanding, startCollab]);

  /** « Recharger la session » : on repart de la version en ligne, puis on rejoint. */
  const reloadCollabSession = useCallback(async () => {
    const cs = cloudRef.current;
    if (!cs) return;
    await leaveCollab({ keepResume: true });
    resumeCollabTriedRef.current = '';
    await openCloudSession({ id: cs.id, secret: cs.secret });
  }, [leaveCollab, openCloudSession]);

  // En direct, côté artiste avec le pont : la liste de ses VST part chez l'ingé.
  const catalogSigRef = useRef('');
  useEffect(() => {
    if (!collab || collab.role !== 'artist') { catalogSigRef.current = ''; return; }
    let stop = false;
    const publish = async () => {
      if (!novaBridge.isConnected()) return;
      const list = catalogOf(await novaBridge.listPlugins().catch(() => novaBridge.getCachedPlugins()));
      const sig = sigOf(list.map(x => x.path + x.pluginName));
      if (stop || !list.length || sig === catalogSigRef.current) return;
      catalogSigRef.current = sig;
      await collabRef.current?.client.send('vst_catalog', { plugins: list }).catch(() => { catalogSigRef.current = ''; });
    };
    void publish();
    const unsub = novaBridge.subscribe(() => { void publish(); });
    return () => { stop = true; unsub(); };
  }, [collab]);

  /** Ingé (en direct) : demande à l'artiste de lire / régler un de ses VST. */
  const askArtistVst = useCallback(async <T,>(kind: 'vst_param' | 'vst_params_get', body: Record<string, unknown>): Promise<T> => {
    const c = collabRef.current;
    if (!c) throw new Error('Collaboration fermée');
    const { reqId, promise } = vstReqsRef.current.create();
    const trackId = String(body.trackId || '');
    const win = kind === 'vst_param' ? previewWinFor(trackId) : undefined;
    try {
      await c.client.send(kind, { ...body, reqId, ...(win ? { win } : {}) });
    } catch {
      vstReqsRef.current.resolve(reqId, null);
      throw new Error("Pas de connexion : ta demande n'est pas partie chez l'artiste. Réessaie quand le réseau revient.");
    }
    if (kind === 'vst_param') { previewTrackerRef.current.expect(trackId, win); syncPreviewStates(); }
    // Le canal en direct peut manquer la réponse : on relit le journal en attendant.
    const poll = window.setInterval(() => { void c.client.catchUp(); }, 2500);
    try { return await promise; } finally { window.clearInterval(poll); }
  }, []);

  // --- Mode « Ingé à distance (ses propres VST) » : chacun sa session ---------------------
  const remoteGate = useCallback(async (interactive: boolean) => {
    const { data: who } = await catalogSupabase.auth.getUser();
    if (!who?.user) { if (interactive) { setCollabGate('login'); setCollabOpen(true); } return false; }
    const st = await billingStatus();
    if (!hasPlan(st, 'collab')) { if (interactive) { track('pro_gate_shown', { reason: 'collab' }); setCollabGate('subscribe'); setCollabOpen(true); } return false; }
    return true;
  }, []);
  const remote = useRemoteInge({
    tracks: state.tracks, remoteInge: state.remoteInge, isRecording: state.isRecording, showLanding,
    stateRef, setState, setSilently,
    notify: (msg, ms = 5000) => { setAiNotification(msg); setTimeout(() => setAiNotice(n => (n?.text === msg ? null : n)), ms); },
    gate: remoteGate,
    saveSession: async () => {
      await autosaveNow();
      if (cloudRef.current && stateRef.current.id === cloudProjectId(cloudRef.current.id)) await syncCloudRef.current({});
    },
    releaseBuffer: (id) => releaseBufferIfUnused(id, []),
    author: () => getEditAuthor(),
  });
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const pendingRemoteRef = useRef<{ role: 'artist' | 'engineer'; name: string; link?: string } | null>(null);
  const startRemote = useCallback(async (role: 'artist' | 'engineer', name: string, link?: string) => {
    pendingRemoteRef.current = { role, name, link };
    if (collabRef.current) await leaveCollab();
    const ok = await remoteRef.current.start(role, name, link);
    if (ok) { pendingRemoteRef.current = null; setRemoteLinkFromUrl(null); setCollabGate(null); }
  }, [leaveCollab]);
  // Lien d'invitation de l'ingé (?inge=…) : il garde SA session ; le panneau s'ouvre avec le lien.
  const [remoteLinkFromUrl, setRemoteLinkFromUrl] = useState<string | null>(() => {
    try { const v = new URLSearchParams(window.location.search).get('inge'); return parseRemoteLink(v) ? v : null; } catch { return null; }
  });
  useEffect(() => {
    if (!remoteLinkFromUrl || showLanding) return;
    setCollabOpen(true);
    setAiNotification("🎧 Un artiste t'invite en « Ingé à distance » : ses pistes arriveront dans cette session. Clique « Me relier à l'artiste ».");
    try { const u = new URL(window.location.href); u.searchParams.delete('inge'); window.history.replaceState(null, '', u.toString()); } catch { /* */ }
  }, [remoteLinkFromUrl, showLanding]);

  // Lien d'invitation (?session=…&role=…) : une fois la session ouverte, on rejoint avec ce rôle.
  useEffect(() => {
    const role = pendingCollabRoleRef.current;
    if (!role || collab || !cloudSession || state.id !== cloudProjectId(cloudSession.id)) return;
    pendingCollabRoleRef.current = null;
    const t = window.setTimeout(() => {
      void (async () => {
        let name = ROLE_LABEL[role];
        try { const { data } = await catalogSupabase.auth.getUser(); if (data?.user?.email) name = data.user.email.split('@')[0]; } catch { /* */ }
        await startCollab(role, name);
        setCollabOpen(true);
      })();
    }, 1500); // le projet ouvert (beat, prises) se pose d'abord
    return () => window.clearTimeout(t);
  }, [state.id, cloudSession, collab, startCollab]);

  // Verrou de volume (bouton cadenas de la piste).
  const unlockAskRef = useRef<{ trackId: string; at: number } | null>(null);
  useEffect(() => {
    const onLock = (e: Event) => {
      const trackId = String((e as CustomEvent).detail || '');
      const t = stateRef.current.tracks.find(x => x.id === trackId);
      const c = collabRef.current;
      if (!t) return;
      if (t.volumeLock && c && c.role !== 'artist') {
        // L'ingé son peut déverrouiller, mais en connaissance de cause (deuxième clic).
        const ask = unlockAskRef.current;
        if (!ask || ask.trackId !== trackId || Date.now() - ask.at > 5000) {
          unlockAskRef.current = { trackId, at: Date.now() };
          setAiNotification(`🔒 L'artiste veut ce volume sur « ${t.name} » (${gainToDbText(t.volumeLock.volume)}). Clique encore sur le cadenas pour le déverrouiller quand même.`);
          return;
        }
        unlockAskRef.current = null;
      }
      const lock = t.volumeLock ? null : { volume: t.volume, by: c?.name || 'Artiste', at: Date.now() };
      remoteTouchedRef.current.add(trackId);
      setState(produce((d: DAWState) => {
        const x = d.tracks.find(y => y.id === trackId);
        if (!x) return;
        if (lock) x.volumeLock = lock; else delete x.volumeLock;
      }));
      if (c) c.client.queue(`lock:${trackId}`, 'lock', { trackId, lock });
      setAiNotification(lock ? `🔒 Volume de « ${t.name} » verrouillé à ${gainToDbText(t.volume)}${c ? ' : l\'ingé son le voit' : ''}.` : `🔓 Volume de « ${t.name} » déverrouillé.`);
    };
    window.addEventListener('nova:volume-lock', onLock);
    return () => window.removeEventListener('nova:volume-lock', onLock);
  }, [setState]);

  // Le site (page /daw) transmet la connexion du compte Make Music au studio intégré.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!/^https:\/\/(www\.)?studiomakemusic\.com$/.test(e.origin)) return;
      const d = e.data;
      if (d?.type === 'NOVA_SITE_AUTH' && typeof d.accessToken === 'string' && typeof d.refreshToken === 'string') {
        void adoptSiteSession(d.accessToken, d.refreshToken).catch(() => {});
      }
    };
    window.addEventListener('message', onMsg);
    try { window.parent?.postMessage({ type: 'NOVA_READY_FOR_AUTH' }, '*'); } catch { /* */ }
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Application Windows : le pont VST est lancé par l'application, on s'y
  // connecte tout seul (il démarre en quelques secondes : plusieurs essais).
  // Dans le navigateur, rien ne change (bouton « Connecter » de l'onglet VST).
  useEffect(() => {
    if (!isNovaDesktop()) return;
    let stop = false;
    (async () => {
      for (let i = 0; i < 10 && !stop && !novaBridge.isConnected(); i++) {
        try { if (await novaBridge.connect()) break; } catch { /* pas encore prêt */ }
        await new Promise(r => setTimeout(r, 1500));
      }
    })();
    return () => { stop = true; };
  }, []);

  // --- Gel pré-effet : retour sur le PC de l'ingé --------------------------------------
  // Auteur des éditions (journal enregistré avec la session) : compte ou collaboration.
  // Invité (pas de compte) : pas de nom, le journal dit « l'artiste » (ou « l'ingé » au PC).
  useEffect(() => {
    const account = user && user.id !== 'guest' ? (user.username || (user.email || '').split('@')[0]) : '';
    setEditAuthor(collab?.name || account || '');
  }, [user, collab]);
  const notifyPreFx = useCallback((msg: string, ms = 4000) => { setAiNotification(msg); setTimeout(() => setAiNotification(null), ms); }, []);
  // Pont VST connecté : les pistes gelées à la sauvegarde se dégèlent (plugins présents)
  // et les éditions faites ailleurs passent avant les effets (résumé).
  const preFx = usePreFxReplay({ stateId: state.id, tracks: state.tracks, showLanding, stateRef, setState, notify: notifyPreFx });
  const preFxAnnounceRef = useRef(preFx.announce);
  preFxAnnounceRef.current = preFx.announce;

  // Session en ligne modifiée ailleurs en même temps (artiste sur la tablette, ingé
  // au studio) : on garde cette version et on y ajoute les éditions pré-effet de l'autre.
  const mergeCloudVersions = useCallback(async () => {
    const c = cloudRef.current;
    if (!c) return;
    setCloudConflict(null);
    setCloudProgress({ pct: 1, msg: "Récupération de l'autre version…" });
    try {
      const { state: theirs, info } = await pullSession({ id: c.id, secret: c.secret }, (pct, msg) => setCloudProgress({ pct, msg }));
      const m = mergeSessionEdits(stateRef.current, theirs);
      setState(prev => ({ ...prev, tracks: m.state.tracks }));
      setCloudSession({ ...c, version: info.version, syncedAt: Date.now() });
      preFx.showMerge(m, theirs);
      // La version fusionnée devient la version en ligne.
      setTimeout(() => { void syncCloudRef.current({ interactive: true }); }, 400);
    } catch (e: any) {
      setCloudError(e?.message || 'Fusion impossible');
      setTakeHomeOpen(true);
    } finally {
      setTimeout(() => setCloudProgress(null), 600);
    }
  }, [setState, setCloudSession, preFx.showMerge]);

  // Fermeture du projet (application Windows, bouton fermer) : gel des pistes VST
  // + sauvegarde locale + synchronisation en ligne, puis seulement fermeture.
  useEffect(() => {
    (window as any).__novaBeforeClose = async () => {
      try { if (novaBridge.isConnected()) await bakeVstBeforeSave(); } catch (e) { console.warn('[Fermeture] gel', e); }
      try { await autosaveNow(); } catch { /* */ }
      if (cloudRef.current && stateRef.current.id === cloudProjectId(cloudRef.current.id)) {
        // Une synchro déjà en cours : on attend qu'elle finisse, puis on renvoie.
        for (let i = 0; i < 120 && cloudBusyRef.current; i++) await new Promise(r => setTimeout(r, 500));
        try { await syncCloudRef.current({}); } catch { /* */ }
      }
    };
    return () => { delete (window as any).__novaBeforeClose; };
  }, [bakeVstBeforeSave, autosaveNow]);

  // Au studio, pont VST connecté : les pistes VST modifiées sont regelées pendant
  // les pauses (45 s sans lecture), pour que la fermeture et l'envoi soient immédiats.
  useEffect(() => {
    if (showLanding || state.isPlaying || state.isRecording || !novaBridge.isConnected() || preFx.panel) return;
    if (tracksNeedingVstRender(state.tracks).length === 0 && busesNeedingVstRender(state.tracks).length === 0) return;
    const t = window.setTimeout(() => {
      if (stateRef.current.isPlaying || stateRef.current.isRecording) return;
      void bakeVstBeforeSave().catch(e => console.warn('[Gel auto]', e));
    }, 45000);
    return () => window.clearTimeout(t);
  }, [state.tracks, state.isPlaying, state.isRecording, showLanding, bakeVstBeforeSave, preFx.panel]);

  // Un extrait du catalogue démarre : le projet en lecture se met en pause
  // (sauf pendant une prise, qu'on ne coupe jamais).
  useEffect(() => {
    const onPreview = () => {
      if (stateRef.current.isPlaying && !stateRef.current.isRecording) pausePlayback();
    };
    window.addEventListener('nova:preview-start', onPreview);
    const onNotify = (e: Event) => { const d = (e as CustomEvent).detail; if (typeof d === 'string') setAiNotification(d); };
    window.addEventListener('nova:notify', onNotify);
    return () => { window.removeEventListener('nova:preview-start', onPreview); window.removeEventListener('nova:notify', onNotify); };
  }, [pausePlayback]);

  const handleLoadCatalogBeat = async (inst: any) => {
    let audioUrl = '';
    if (inst?.preview_url) audioUrl = supabaseManager.getPublicInstrumentUrl(inst.preview_url);
    else if (inst?.drive_file_id) audioUrl = supabaseManager.getDrivePreviewUrl(inst.drive_file_id);
    if (!audioUrl) {
      setAiNotification("Ce beat n'a pas de fichier audio disponible.");
      return;
    }
    if (stateRef.current.isPlaying) pausePlayback();
    // L'extrait de ce beat (ou d'un autre) s'arrête : on passe au beat dans le projet.
    window.dispatchEvent(new Event('nova:transport-start'));
    const previousBeatClips = stateRef.current.tracks.find(t => t.id === 'instrumental')?.clips || [];
    setState(produce((draft: DAWState) => {
      const beat = draft.tracks.find(t => t.id === 'instrumental');
      if (beat) beat.clips = [];
    }));
    setAiNotification(`⏳ Chargement de « ${inst.title} »…`);
    const beatBuffer = await handleUniversalAudioImport(audioUrl, inst.title, 'instrumental', 0, inst.bpm, inst.id);
    if (!beatBuffer) {
      // Échec réseau : on remet l'ancien beat au lieu d'annoncer « prêt » sur une piste vide.
      setState(produce((draft: DAWState) => {
        const beat = draft.tracks.find(t => t.id === 'instrumental');
        if (beat && !beat.clips.length) beat.clips = previousBeatClips as any;
      }));
      setAiNotification(`⚠️ « ${inst.title} » n'a pas pu être chargé (connexion ?). Réessaie depuis la bibliothèque.`);
      return;
    }
    if (inst.bpm) handleUpdateBpm(inst.bpm);
    if (stateRef.current.projectMode !== 'BEATMAKING') track('beat_tried', { beat_id: String(inst.id ?? ''), title: String(inst.title || '') });
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
    // Repères de structure automatiques (Intro, Partie 1…, Outro) ; les
    // repères posés à la main ne sont jamais touchés.
    if (beatBuffer) {
      const sections = detectSections(beatBuffer, inst.bpm || stateRef.current.bpm);
      setState(produce((draft: DAWState) => {
        draft.markers = draft.markers.filter(m => !m.id.startsWith('auto-'));
        sections.forEach((s, i) => draft.markers.push({
          // Id stable (n° de partie) : les paroles calées dessus dans le prompteur le restent.
          id: `auto-${i}`, name: s.name, time: s.start, endTime: s.end, type: 'REGION', color: sectionColor(s),
        }));
        draft.markers.sort((a, b) => a.time - b.time);
      }));
    }
    audioEngine.seekTo(0, stateRef.current.tracks, false);
    setState(prev => ({ ...prev, currentTime: 0 }));
    setAiNotification(tonalite
      ? `🎵 « ${inst.title} » est prêt (${nomTonalite(tonalite.rootKey, tonalite.scale)}${ecoute ? ", détectée à l'écoute" : ''}) — l'Auto-Tune est réglé sur cette gamme. Appuie sur REC pour poser ta voix`
      : `🎵 « ${inst.title} » est prêt — appuie sur REC pour poser ta voix (gamme inconnue : l'Auto-Tune corrige sur toutes les notes)`);
    if (isMobile) setActiveMobileTab('ARRANGEMENT');
    // Mélodie du studio (sans batterie) : on propose d'en poser une, adaptée.
    if (stateRef.current.projectMode !== 'BEATMAKING' && (inst.kind === 'melody' || /melod|sample/i.test(`${inst.genre || ''}`))) {
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

  /**
   * Projet « instru sur mélodie » : la mélodie du studio sur sa piste, une
   * batterie posée (style deviné, tempo et tonalité de la mélodie) et la boîte
   * à rythmes ouverte. Les pistes voix restent là : on peut poser sa voix
   * ensuite sur l'instru qu'on vient de faire.
   */
  const handleStartMelodyProject = async (inst: any) => {
    track('melody_tried', { melody_id: String(inst?.id ?? ''), title: String(inst?.title || '') });
    setState(produce((draft: DAWState) => {
      draft.projectMode = 'BEATMAKING';
      draft.name = `Instru · ${String(inst.title || 'Mélodie').slice(0, 40)}`;
    }));
    stateRef.current = { ...stateRef.current, projectMode: 'BEATMAKING' };
    await handleLoadCatalogBeat(inst);
    setState(produce((draft: DAWState) => {
      const t = draft.tracks.find(x => x.id === 'instrumental');
      if (t) t.name = 'MÉLODIE';
    }));
    await ensureAudioEngine();
    // Tempo détecté à l'écoute : on laisse l'état se mettre à jour avant de le lire.
    await new Promise(r => setTimeout(r, 150));
    const st = stateRef.current;
    const kit = suggestDrumKit(st.bpm, inst.genre, inst.title);
    handleSetDrumKit(kit);
    setDrumsOpen(true);
    const others = DRUM_KITS.filter(k => k.id !== kit && ['trap', 'drill', 'boombap', 'rnb', 'afro'].includes(k.id)).slice(0, 3);
    postNova(`🥁 Mode instru : « ${inst.title} » est sur la piste MÉLODIE et je t'ai posé une batterie ${DRUM_KITS.find(k => k.id === kit)?.name || ''} calée sur son tempo (${Math.round(st.bpm)} BPM). Change les pas, les sons et le mix de chaque pad dans la boîte à rythmes. Quand ton instru te plaît, pose ta voix dessus avec REC.`, [
      ...others.map(k => ({ label: `${k.emoji} Essayer ${k.name}`, action: { action: 'ADD_DRUMS', payload: { kit: k.id } } as AIAction })),
      { label: '🎤 Poser ma voix', action: { action: 'ARM_TRACK', payload: { trackId: 'track-rec-main', armed: true } } as AIAction },
    ]);
  };
  startMelodyProjectRef.current = handleStartMelodyProject;

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
      // Pendant la lecture, la position vivante est dans playheadStore.
      getState: () => {
        const st = stateRef.current;
        return st.isPlaying ? { ...st, currentTime: playheadStore.get() } : st;
      },
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
    // Nova pilote les VST du PC (mix, liste, réglages) : services/NovaVstMix.
    if (VST_ACTIONS.has(a.action)) {
      const silent = a.action === 'VST_MIX_FALLBACK';
      void handleNovaVstAction(a, {
        getState: () => stateRef.current,
        mutate: (fn) => { if (silent) setSilently(produce(fn)); else { breakHistory(); setState(produce(fn)); } },
        notify: (msg) => { setAiNotification(msg); setTimeout(() => setAiNotification(null), 3500); },
        post: postNova,
        applyBuiltinStyle: (id) => { handleApplyMixStyle(id); },
        remoteRule: () => remoteRef.current?.mixRule() || null,
      }).catch(e => postNova(`Je n'ai pas pu toucher à tes plugins : ${e?.message || e}`));
      return;
    }
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
        // Mode instru (beatmaker) : la piste MIDI existe. En mode voix, pas de MIDI
        // pour ne pas embrouiller l'artiste.
        if (stateRef.current.projectMode === 'BEATMAKING' && (type === TrackType.MIDI || type === TrackType.SAMPLER)) { handleNewMidiTrack(); break; }
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
        if (!existing && (type === 'REVERB' || type === 'DELAY') && t.type !== TrackType.SEND && t.id !== 'master') {
          // Ambiance : réglée sur la piste d'envoi, dosée par le départ de la piste.
          const routed = routeAmbienceToSend(t.id, createDefaultPlugins(type, 0.5, stateRef.current.bpm), type);
          if (routed) {
            const { mix, ...rest } = (p.params || {}) as Record<string, any>;
            if (Object.keys(rest).length) handleUpdatePluginParams(routed.sendId, routed.plugin.id, { ...routed.plugin.params, ...rest, mix: 1 });
            if (typeof mix === 'number') patchTrack(t.id, tr => { const sd = tr.sends.find(x => x.id === routed.sendId); if (sd) sd.level = Math.max(0, Math.min(1, mix)); });
            notify(`🌫️ ${type === 'REVERB' ? 'Reverb' : 'Délai'} de ${t.name} réglé(e) via la piste d'envoi`);
            break;
          }
        }
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
        if (isMobileRef.current && activeTabRef.current === 'NOVA') setActiveMobileTab('ARRANGEMENT');
        handleToggleRecord();
        break;

      case 'SEEK':
        handleSeek(Math.max(0, Number(p.time) || 0));
        break;

      case 'COMP_TAKE': {
        // { take, zone?, trackId? } : « garde la prise 2 sur la partie 2 »
        const take = Number(p.take);
        const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const want = norm(String(p.zone || ''));
        const st = stateRef.current;
        const zones: CompZone[] = [];
        if (st.loopEnd > st.loopStart + 0.2) zones.push({ start: st.loopStart, end: st.loopEnd, label: 'La boucle' });
        (st.markers || []).filter(m => m.type === 'REGION' && typeof m.endTime === 'number' && m.endTime! > m.time)
          .forEach(m => zones.push({ start: m.time, end: m.endTime!, label: m.name }));
        const zone = want ? zones.find(z => norm(z.label) === want) || zones.find(z => norm(z.label).includes(want) || want.includes(norm(z.label))) : undefined;
        const track = (p.trackId ? findTrack(p.trackId) : undefined)
          || st.tracks.find(t => t.type === TrackType.AUDIO && listTakes(t).some(x => x.n === take));
        if (!track || !Number.isFinite(take)) { notify(`Je ne trouve pas la prise ${p.take}`); break; }
        if (want && !zone) { notify(`Je ne trouve pas la partie « ${p.zone} » (ajoute des repères de structure ou une boucle)`); break; }
        if (zone) handleCompTake(track.id, take, zone);
        else (selectTakeActions(track, take) || []).forEach(a => executeAIAction(a));
        break;
      }

      case 'OPEN_TAKE_HOME': {
        setTakeHomeOpen(true);
        break;
      }

      case 'SET_PUNCH': {
        // { start, end } en secondes : zone de boucle + punch activé
        const a = Math.max(0, Number(p.start) || 0), b = Number(p.end) || 0;
        if (b > a + 0.2) {
          setState(prev => ({ ...prev, loopStart: a, loopEnd: b, punch: { ...prev.punch, enabled: true, punchIn: a, punchOut: b } }));
        } else handleTogglePunch();
        break;
      }

      case 'GOTO_SECTION': {
        // « va au refrain » → la partie la plus pleine ; « partie 2 », « intro »…
        const regions = stateRef.current.markers.filter(m => m.type === 'REGION' && m.endTime);
        if (!regions.length) { notify("Pas de repères sur cette prod : charge une instru du catalogue"); break; }
        const want = String(p.target || '').toLowerCase();
        let m = want === 'full'
          ? regions.find(r => r.color === '#f472b6' && r.time > 0.5) || regions.find(r => r.color === '#f472b6')
          : regions.find(r => r.name.toLowerCase() === want);
        if (!m) { notify(`Je ne trouve pas « ${p.target} »`); break; }
        handleSeek(m.time);
        if (p.loop) setState(prev => ({ ...prev, loopStart: m!.time, loopEnd: m!.endTime!, isLoopActive: true }));
        break;
      }

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
        handleAddMarker(Math.max(0, Number.isFinite(Number(p.time)) && p.time !== undefined && p.time !== null && p.time !== '' ? Number(p.time) : playheadStore.get()), p.name);
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
        if (stateRef.current.projectMode === 'BEATMAKING') {
          // Mode instru : on ouvre l'outil plutôt que d'écrire les notes à la place du beatmaker.
          const midi = stateRef.current.tracks.find(t => t.type === TrackType.MIDI && t.clips.length);
          if (midi) { setMidiEditorOpen({ trackId: midi.id, clipId: midi.clips[0].id }); setAiNotification("🎹 Piano roll ouvert : clic pour poser une note, glisser pour l'allonger."); }
          else handleNewMidiTrack();
          break;
        }
        // Mode voix : le DAW sert à essayer sa voix sur les instrus.
        setAiNotification("🎤 Ici on pose sa voix sur l'instru. Pour composer (batterie, piano roll), ouvre une mélodie en mode instru depuis la bibliothèque.");
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
          // Mode simple : la console et l'automation sont en mode avancé, on y passe.
          if (view !== 'ARRANGEMENT' && simpleModeStore.get().simple) {
            simpleModeStore.setPref(false);
            notify("🎛️ Mode avancé activé pour t'ouvrir la console (menu ☰ → Mode avancé pour revenir au mode simple)");
          }
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
        // Sans compte Nova (invité), la sauvegarde en ligne passe par « Emporter
        // la session » et le compte Make Music (avant : erreur « Session expirée »).
        if (!user || user.id === 'guest') setTakeHomeOpen(true);
        else handleSaveCloud(String(p.name || stateRef.current.name || 'STUDIO_SESSION'));
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

      case 'LOAD_DAILY_CHALLENGE':
        // Même prod que le défi du jour du site (Beat Swipe).
        void supabaseManager.getActiveInstrumentals().then(list => {
          const beats = list.filter(i => (i as any).kind === 'beat' && (i.preview_url || i.drive_file_id));
          const id = dailyChallengeId(beats.map(b => String(b.id)));
          const inst = beats.find(b => String(b.id) === id);
          if (inst && loadCatalogBeatRef.current) void loadCatalogBeatRef.current(inst);
          else notify("Le défi du jour n'est pas disponible pour le moment");
        }).catch(() => notify("Catalogue indisponible"));
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
        else if (String(p.offer) === 'battle') openBattle();
        else openProMix();
        break;

      case 'HIGHLIGHT': {
        const target = String(p.target || '');
        if (!target) return;
        const show = () => { if (!novaSpotlight(target, p.text ? String(p.text) : undefined)) notify("Je ne trouve pas ce réglage à l'écran"); };
        // Réglages visibles en mode simple (sinon on passe en mode avancé pour les montrer).
        const simpleTargets = ['mix-auto', 'lyrics', 'rec', 'clock', 'beat-catalog', 'master-meter'];
        const visibleInSimple = simpleTargets.includes(target) || target.startsWith('vol-') || (!isMobileRef.current && !target.startsWith('fx-'));
        const simpleNow = simpleModeStore.get().simple;
        if (simpleNow && !visibleInSimple) {
          simpleModeStore.setPref(false);
          notify('🎛️ Mode avancé activé pour te montrer ce réglage');
        }
        if (isMobileRef.current) {
          // Le chat couvre l'écran sur téléphone : on va sur l'onglet où se trouve le réglage.
          // (en mode simple, les volumes sont sur la page Morceau)
          setActiveMobileTab(target === 'beat-catalog' ? 'BROWSER'
            : ['mix-auto', 'lyrics', 'rec', 'clock', 'master-meter'].includes(target) ? 'ARRANGEMENT'
            : target.startsWith('vol-') ? (simpleNow && visibleInSimple ? 'ARRANGEMENT' : 'MIXER') : 'TRACKS');
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

  // Un VST posé par Nova ne se charge pas (licence, démo, plantage) : l'effet de NOVA reprend.
  useEffect(() => novaVstEvents.on(r => {
    if (r.failed) executeAIAction({ action: 'VST_MIX_FALLBACK', payload: { pluginId: r.pluginId, reason: r.failed } } as AIAction);
  }), [executeAIAction]);

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
            currentTime: Math.round(playheadStore.get() * 100) / 100,
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
        // Déploiement sans clé d'IA (ou API injoignable) :
        // 1) fonction Supabase « nova-chat » (clé Gemini des secrets Supabase),
        //    Nova ne dépend plus d'un ancien déploiement Vercel ;
        if (!response || !response.ok || data?.error === 'API key missing') {
            const viaSupabase = await fetch('https://mxdrxpzxbgybchzzvpkf.supabase.co/functions/v1/nova-chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            }).catch(() => null);
            const d2: any = viaSupabase ? await viaSupabase.clone().json().catch(() => ({})) : {};
            if (viaSupabase && viaSupabase.ok) { response = viaSupabase; data = d2; }
        }
        // 2) en dernier recours, le déploiement de référence.
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
            // Message compréhensible et actionnable (avant : « Erreur de connexion: Erreur serveur: réseau »).
            text: navigator.onLine === false
              ? "📡 Pas de connexion internet : je ne peux pas répondre aux questions libres pour l'instant. Reconnecte-toi puis renvoie ton message. Les boutons (Mix auto, Mes paroles, tempo…) marchent toujours."
              : "😕 Je n'arrive pas à joindre mon serveur pour l'instant. Réessaie dans un moment (renvoie ton message). Les boutons ci-dessus et les demandes simples (« mets le tempo à 90 », « mix trap ») marchent toujours.",
            actions: []
        };
    }
  };

  // --- Gestionnaires d'identite stable pour les vues memoisees ---
  // (ArrangementView, MixerView) : des fonctions flechees recreees a chaque
  // rendu d'App annulaient React.memo. Elles appellent toujours la derniere
  // version (pas de fermeture perimee).
  const onSetLoopStable = useLatestCallback((start: number, end: number) => setState(prev => ({ ...prev, loopStart: start, loopEnd: end, isLoopActive: true })));
  const onSelectTrackStable = useLatestCallback((id: string) => setState(p => ({ ...p, selectedTrackId: id })));
  const onDropPluginOpenUI = useLatestCallback((trackId: string, type: PluginType, metadata?: any) => handleAddPluginFromContext(trackId, type, metadata, { openUI: true }));
  const onOpenPluginUI = useLatestCallback(async (tid: string, p: PluginInstance) => { await ensureAudioEngine(); setActivePlugin({ trackId: tid, plugin: p }); });
  const onRequestAddPluginMenu = useLatestCallback((tid: string, x: number, y: number) => setAddPluginMenu({ trackId: tid, x, y }));
  const onEditClipStable = useLatestCallback(handleEditClip);
  const onEditMidiStable = useLatestCallback((trackId: string, clipId: string) => setMidiEditorOpen({ trackId, clipId }));
  const onArrangementAudioDrop = useLatestCallback((trackId: string, url: string, name: string, time: number) => {
    // Beat du catalogue : même chemin que « Essayer » (remplace le beat, règle tempo et Auto-Tune).
    const beat = takeDraggedBeat(url);
    if (beat) return loadCatalogBeatRef.current?.(beat);
    // Id vide = nouvelle piste (fichiers en trop d'un dépôt multiple).
    return handleUniversalAudioImport(url, name, trackId || undefined, time);
  });

  // --- Mode simple (artiste) ------------------------------------------------------
  // Mode instru, ingé son et beatmaker : tous les outils, d'office.
  const { simple: simpleMode } = useSimpleMode();
  useEffect(() => {
    simpleModeStore.setForced(state.projectMode === 'BEATMAKING' || collab?.role === 'engineer' || collab?.role === 'beatmaker');
  }, [state.projectMode, collab?.role]);
  // Onglets Pistes / Mixer / FX absents du mode simple : retour au morceau.
  useEffect(() => {
    if (simpleMode && (activeMobileTab === 'TRACKS' || activeMobileTab === 'MIXER' || activeMobileTab === 'PLUGINS')) setActiveMobileTab('ARRANGEMENT');
  }, [simpleMode, activeMobileTab]);
  const shownView = simpleMode ? 'ARRANGEMENT' : state.currentView;

  // --- Mesure d'audience (parcours) ------------------------------------------------
  useEffect(() => {
    const melody = (() => { try { return new URLSearchParams(window.location.search).has('melody'); } catch { return false; } })();
    const dev = autoViewMode();
    trackOnce('daw_open', {
      mode: melody || stateRef.current.projectMode === 'BEATMAKING' ? 'beatmaking' : 'vocal',
      device: dev === 'MOBILE' ? 'phone' : dev === 'TABLET' ? 'tablet' : 'desktop',
      desktop_app: isNovaDesktop(),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (lyricsOpen) track('lyrics_opened'); }, [lyricsOpen]);
  useEffect(() => { if (shareOpen) track('share_opened'); }, [shareOpen]);
  useEffect(() => { if (isExportMenuOpen) track('export_opened'); }, [isExportMenuOpen]);
  useEffect(() => { if (takeHomeOpen) track('takehome_opened'); }, [takeHomeOpen]);

  // --- Carte « Et maintenant ? » (une fois par session et par déclencheur) ----------
  const [nextStep, setNextStep] = useState<'take' | 'export' | null>(null);
  const nextStepSeenRef = useRef(new Set<string>());
  showNextStepRef.current = (trigger) => {
    if (nextStepSeenRef.current.has(trigger)) return;
    nextStepSeenRef.current.add(trigger);
    setNextStep(trigger);
    track('next_step_card_shown', { trigger });
  };
  const nextStepActions = useMemo((): NextStepAction[] => {
    if (!nextStep) return [];
    const beat = getCatalogBeat(state.tracks);
    const owned = !!beat && (user?.owned_instruments || []).map(String).includes(beat.id);
    const list: NextStepAction[] = beat && !owned ? ['buy_beat'] : [];
    if (nextStep === 'take') list.push('pro_mix', 'share', 'studio');
    else list.push('pro_mix', 'studio', 'share');
    return list.slice(0, 3);
  }, [nextStep, state.tracks, user]);
  const handleNextStep = (a: NextStepAction) => {
    track('next_step_clicked', { action: a, trigger: nextStep || '' });
    setNextStep(null);
    if (a === 'buy_beat') openBuyBeat(stateRef.current.tracks);
    else if (a === 'pro_mix') openProMix();
    else if (a === 'studio') openStudioSession();
    else setShareOpen(true);
  };

  // Auth temporairement désactivée pour éviter écran noir
  // if (!user) { return <AuthScreen onAuthenticated={(u) => { setUser(u); setIsAuthOpen(false); }} />; }

  // Afficher la Landing Page si c'est la première visite
  if (showLanding) {
    return (
      <>
      {landingNotice && (
        <div className="fixed top-3 inset-x-0 z-[999] flex justify-center px-4 pointer-events-none">
          <div role="status" className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-amber-400/40 bg-[#14161a] px-4 py-3 text-[13px] text-amber-100 shadow-2xl">
            <span>{landingNotice}</span>
            <button type="button" aria-label="Fermer" onClick={() => setLandingNotice(null)} className="w-8 h-8 shrink-0 rounded-lg bg-white/10 text-white">✕</button>
          </div>
        </div>
      )}
      <LandingPage 
        user={user}
        onEnterStudio={handleEnterStudio}
        onEnterWithInstrumental={handleEnterWithInstrumental}
        onEnterWithMelody={handleEnterWithMelody}
        onEnterWithAudioFile={handleEnterWithAudioFile}
        onEnterWithProject={handleEnterWithProject}
        savedSession={savedSessionMeta}
        onResumeSession={handleResumeSession}
        onLogin={(u) => setUser(u)}
        onLogout={handleLogout}
      />
      </>
    );
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden relative transition-colors duration-300" style={{ backgroundColor: 'var(--bg-main)', color: 'var(--text-primary)' }}>
      {saveState.isSaving && <SaveOverlay progress={saveState.progress} message={saveState.message} />}

      {/* TransportBar - Desktop, Tablet ET Mobile avec menu hamburger */}
      <div className="relative z-50">
        <TransportBar
          onOpenCollab={() => setCollabOpen(true)}
          collabLabel={remote.active ? 'Ingé à distance' : collab ? `Collaboration · ${collabOnline.length || 1} en ligne` : 'Collaborer à distance'}
          onOpenTakeHome={() => setTakeHomeOpen(true)}
          takeHomeLabel={isCloudProject ? `En ligne · ${cloudSession?.syncedAt ? formatAgo(cloudSession.syncedAt) : 'à envoyer'}` : 'Emporter la session'}
          isPlaying={state.isPlaying} currentTime={state.currentTime} bpm={state.bpm} onBpmChange={handleUpdateBpm}
          timeSignature={state.timeSignature} projectKey={state.projectKey} projectScale={state.projectScale}
          isRecording={state.isRecording} isLoopActive={state.isLoopActive}
          isPunchActive={!!state.punch?.enabled} onTogglePunch={handleTogglePunch}
          punch={state.punch} onUpdatePunch={handleUpdatePunch} onToggleQuickPunch={handleToggleQuickPunch}
          onToggleLoop={() => setState(p => ({ ...p, isLoopActive: !p.isLoopActive }))}
          isMetronomeEnabled={state.metronome.enabled}
          onToggleMetronome={handleToggleMetronome}
          onStop={handleStop} onTogglePlay={handleTogglePlay} onToggleRecord={handleToggleRecord}
          currentView={shownView} onChangeView={v => setState(s => ({...s, currentView: v}))}
          statusMessage={externalImportNotice} noArmedTrackError={noArmedTrackError}
          currentTheme={theme} onToggleTheme={toggleTheme}
          onOpenSaveMenu={() => setIsSaveMenuOpen(true)} onOpenLoadMenu={() => setIsLoadMenuOpen(true)}
          onExportMix={handleExportMix} onShareProject={() => setShareOpen(true)}
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
      {/* Sur ordinateur / tablette, elle est posée dans le bandeau du bas (sous la
          grille) : flottante, elle cachait des clips et la rangée MUTE / SOLO du mixer. */}
      {isMobile && (activeMobileTab === 'TRACKS' || activeMobileTab === 'ARRANGEMENT') && (
        <TrackCreationBar
          onCreateTrack={handleCreateTrack}
          beatmaking={state.projectMode === 'BEATMAKING' || collab?.role === 'beatmaker'}
          onOpenDrums={() => setDrumsOpen(true)}
          onNewMidiTrack={handleNewMidiTrack}
          onOpen808={handleOpen808}
          onOpenVocalTools={() => setVocalToolsOpen(true)}
          onOpenLyrics={() => setLyricsOpen(o => !o)}
          lyricsOpen={lyricsOpen}
          currentStyleId={state.vocalMixStyle}
        />
      )}
      <TouchInteractionManager />
      {/* Fenêtre d'activation de licence d'un VST ouverte sur le PC (pont VST) */}
      <LicenseNotice />

      <div className="flex-1 flex overflow-hidden relative">
        {isSidebarOpen && !isMobile && (
            <aside className="shrink-0 z-10">
                <SideBrowser2
                    user={user} activeTab={activeSideBrowserTab} onTabChange={setActiveSideBrowserTab}
                    onAddPlugin={handleAddPluginFromContext}
                    onPurchase={handleBuyLicense} selectedTrackId={state.selectedTrackId}
                    onLoadBeat={handleLoadCatalogBeat} onMakeBeat={(m: any) => { void startMelodyProjectRef.current?.(m); }}
                />
            </aside>
        )}
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
          {/* Mode Desktop/Tablet - Vues classiques */}
          {!isMobile && (
            <>
              {shownView === 'ARRANGEMENT' && (
                <ArrangementView
                   tracks={state.tracks} isLoopActive={state.isLoopActive} loopStart={state.loopStart} loopEnd={state.loopEnd}
                   onSetLoop={onSetLoopStable}
                   onSeek={handleSeek} bpm={state.bpm} selectedTrackId={state.selectedTrackId} onSelectTrack={onSelectTrackStable}
                   onUpdateTrack={handleUpdateTrack} onReorderTracks={handleReorderTracks}
                   onDropPluginOnTrack={onDropPluginOpenUI}
                   onSelectPlugin={onOpenPluginUI}
                   onRemovePlugin={handleRemovePlugin} onRequestAddPlugin={onRequestAddPluginMenu}
                   onAddTrack={handleCreateTrack} onDuplicateTrack={handleDuplicateTrack} onDeleteTrack={handleDeleteTrack}
                   onFreezeTrack={handleFreezeTrack}
                   onEditClip={onEditClipStable} isRecording={state.isRecording} isPlaying={state.isPlaying} recStartTime={state.recStartTime}
                   onMoveClip={handleMoveClip} onEditMidi={onEditMidiStable}
                   onCreatePattern={handleCreatePatternAndOpen} onSwapInstrument={handleSwapInstrument}
                   onMoveClipsBy={handleMoveClipsBy}
                   onAudioDrop={onArrangementAudioDrop}
                   punch={state.punch} onUpdatePunch={handleUpdatePunch} editCommands={editCommands}
                   markers={state.markers} onAddMarker={handleAddMarker}
                   onUpdateMarker={handleUpdateMarker} onDeleteMarker={handleDeleteMarker} onAddRegion={handleAddRegion}
                />
              )}

              {shownView === 'MIXER' && (
                 <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-[11px]"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement…</div>}><MixerView
                    tracks={state.tracks} onUpdateTrack={handleUpdateTrack}
                    onOpenPlugin={onOpenPluginUI}
                    onDropPluginOnTrack={onDropPluginOpenUI}
                    onRemovePlugin={handleRemovePlugin} onAddBus={handleAddBus} onToggleBypass={handleToggleBypass}
                    onRequestAddPlugin={onRequestAddPluginMenu}
                    onCopyPluginToTrack={handleCopyPluginToTrack} onReorderPlugins={handleReorderPlugins}
                    trackGroups={state.trackGroups} onCreateGroup={handleCreateGroup}
                    onUpdateGroup={handleUpdateGroup} onDeleteGroup={handleDeleteGroup}
                 /></Suspense>
              )}

              {shownView === 'AUTOMATION' && (
                 <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-[11px]"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement…</div>}><AutomationEditorView
                   tracks={state.tracks} currentTime={state.currentTime} bpm={state.bpm} zoomH={40}
                   onUpdateTrack={handleUpdateTrack} onSeek={handleSeek}
                 /></Suspense>
              )}
            </>
          )}

          {/* Bandeau du bas (ordinateur / tablette) : Collaborer, session en ligne et
              les gestes voix (Piste voix, Paroles, Mix auto). Il prend sa propre place
              sous la grille : plus rien ne flotte sur les clips ni sur le catalogue. */}
          {!isMobile && (
            <div data-nova-dock className="shrink-0 h-16 flex items-center gap-3 pl-3 pr-28 border-t" style={{ borderColor: 'var(--border-dim)', backgroundColor: 'var(--bg-surface)' }}>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => setCollabOpen(o => !o)} aria-pressed={collabOpen}
                  title="Collaborer à distance : artiste, ingé son, beatmaker"
                  className={`h-10 rounded-full border px-3 text-[11px] font-bold whitespace-nowrap transition-colors ${collabOpen ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'}`}>
                  {remote.active ? `🎧 Ingé à distance${remote.peerName ? ' · en ligne' : ''}` : `👥 ${collab ? `${collabOnline.length || 1} en ligne · Chat` : 'Collaborer'}`}
                </button>
                {isCloudProject && (
                  <button type="button" onClick={() => setTakeHomeOpen(true)}
                    title="Session en ligne : lien, QR code, compte client"
                    className="h-10 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 text-[11px] font-bold text-cyan-200 whitespace-nowrap">
                    ☁️ En ligne · {cloudSession?.syncedAt ? formatAgo(cloudSession.syncedAt) : 'à envoyer'}
                  </button>
                )}
              </div>
              <div className="flex min-w-0 flex-1 justify-center">
                <TrackCreationBar
                  docked
                  onCreateTrack={handleCreateTrack}
                  beatmaking={state.projectMode === 'BEATMAKING' || collab?.role === 'beatmaker'}
                  onOpenDrums={() => setDrumsOpen(true)}
                  onNewMidiTrack={handleNewMidiTrack}
                  onOpen808={handleOpen808}
                  onOpenVocalTools={() => setVocalToolsOpen(true)}
                  onOpenLyrics={() => setLyricsOpen(o => !o)}
                  lyricsOpen={lyricsOpen}
                  currentStyleId={state.vocalMixStyle}
                />
              </div>
            </div>
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
                  onLoadBeat={handleLoadCatalogBeat} onMakeBeat={(m: any) => { void startMelodyProjectRef.current?.(m); }}
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
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[540] px-4 py-2.5 rounded-xl
                        bg-[#14161a]/95 border border-white/10 shadow-2xl backdrop-blur-sm
                        flex items-center gap-2.5 text-[12px] font-medium text-slate-200
                        animate-in fade-in slide-in-from-top-2 duration-200">
          {!/^[✅❌]/.test(externalImportNotice) && (
            <i className="fas fa-circle-notch fa-spin text-cyan-400"></i>
          )}
          <span>{externalImportNotice}</span>
        </div>
      )}

      {isMobile && <MobileBottomNav activeTab={activeMobileTab} onTabChange={setActiveMobileTab} novaBadge={novaUnread}
        onToggleLyrics={() => setLyricsOpen(o => !o)} lyricsOpen={lyricsOpen} />}

      <NextStepCard
        open={!!nextStep && !state.isRecording && countInBeat === null && !(isMobile && activeMobileTab === 'NOVA')}
        trigger={nextStep || 'take'}
        actions={nextStepActions}
        beatTitle={getCatalogBeat(state.tracks)?.title}
        isMobile={isMobile}
        besideSidebar={isSidebarOpen}
        onAction={handleNextStep}
        onClose={() => setNextStep(null)}
      />

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
        compZones={compZones}
        onCompTake={(trackId, n, zone) => handleCompTake(trackId, n, zone)}
        activeTakeInZone={(trackId, zone) => { const t = state.tracks.find(x => x.id === trackId); return t ? activeTakeInZone(t, zone) : null; }}
        onAskNova={() => { setVocalToolsOpen(false); if (isMobile) setActiveMobileTab('NOVA'); setMixGuideRequest(n => n + 1); }}
      />

      <WelcomeSteps
        open={welcomeOpen}
        beatLoaded={!!state.tracks.find(t => t.id === 'instrumental')?.clips.length}
        beatLoading={externalImportNotice?.startsWith('Chargement') ? externalImportNotice.replace(/^Chargement\s*:\s*/, '').replace(/\.{3}$/, '') : null}
        isMobile={isMobile}
        beatmaking={state.projectMode === 'BEATMAKING'}
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
        regions={state.markers.filter(m => m.type === 'REGION' && (m.endTime ?? 0) > m.time)}
        regionMap={state.lyricsRegions || {}}
        onRegionMapChange={map => setState(prev => ({ ...prev, lyricsRegions: map }))}
        onCreateRegion={(name) => {
          // Nouvelle région : la boucle si elle est active, sinon 8 mesures depuis la tête de lecture.
          const st = stateRef.current;
          const bar = (60 / (st.bpm || 120)) * 4;
          const t0 = st.isLoopActive && st.loopEnd > st.loopStart ? st.loopStart : playheadStore.get();
          const t1 = st.isLoopActive && st.loopEnd > st.loopStart ? st.loopEnd : t0 + bar * 8;
          return handleAddRegion(t0, t1, name);
        }}
        bpm={state.bpm}
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
              <button type="button" aria-label="Fermer (plus tard)" onClick={() => setHeadphonePromptOpen(false)} className="h-10 rounded-xl text-slate-400 text-sm underline">
                Plus tard (pas d'enregistrement)
              </button>
            </div>
            <p className="mt-3 text-xs text-slate-400">Conseil : un casque filaire donne le meilleur résultat (le Bluetooth ajoute du retard).</p>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
      {isSaveMenuOpen && <SaveProjectModal isOpen={isSaveMenuOpen} onClose={() => setIsSaveMenuOpen(false)} currentName={state.name} user={user && user.id !== 'guest' ? user : null} onSaveCloud={handleSaveCloud} onSaveLocal={handleSaveLocal} onSaveAsCopy={handleSaveAsCopy} onOpenAuth={() => setIsAuthOpen(true)} onTakeHome={() => setTakeHomeOpen(true)} />}
      {isLoadMenuOpen && <LoadProjectModal isOpen={isLoadMenuOpen} onClose={() => setIsLoadMenuOpen(false)} user={user} onLoadCloud={handleLoadCloud} onLoadLocal={handleLoadLocalFile} onOpenAuth={() => setIsAuthOpen(true)} />}
      {isExportMenuOpen && <ExportModal isOpen={isExportMenuOpen} onClose={() => setIsExportMenuOpen(false)} projectState={state} projectKey={state.id} ownedInstrumentIds={user?.owned_instruments || []} onOpenShare={() => { setIsExportMenuOpen(false); setShareOpen(true); }}
        onExported={() => setTimeout(() => showNextStepRef.current('export'), 1800)} />}
      <DrumMachinePanel
        open={drumsOpen}
        onClose={() => setDrumsOpen(false)}
        dm={(state.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine) || null}
        onChange={dm => applyDrumMachine(dm)}
        onKit={kitId => { void ensureAudioEngine().then(() => handleSetDrumKit(kitId)); }}
        onRemove={() => { handleRemoveDrums(); setDrumsOpen(false); }}
        onAudition={ri => {
          // Le son choisi est chargé avant d'être joué (sample de la bibliothèque au premier clic).
          void ensureAudioEngine().then(async () => {
            const row = (stateRef.current.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine | undefined)?.rows[ri];
            if (row && audioEngine.ctx) {
              try {
                const pk = stateRef.current.projectKey;
                const buf = await loadDrumSound(row.sound, audioEngine.ctx, typeof pk === "number" ? pk : 0);
                audioEngine.loadDrumRackSample(DRUM_TRACK_ID, ri + 1, buf);
              } catch { /* son indisponible */ }
            }
            audioEngine.triggerTrackAttack(DRUM_TRACK_ID, 60 + ri, 1);
          });
        }}
        isPlaying={state.isPlaying}
        onTogglePlay={handleTogglePlay}
        bpm={state.bpm}
        clipStart={0}
        onOpen808={handleOpen808}
        has808={state.tracks.some(t => t.id === BASS808_TRACK_ID)}
      />
      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <TakeHomeModal
        open={takeHomeOpen}
        onClose={() => setTakeHomeOpen(false)}
        session={isCloudProject ? cloudSession : null}
        progress={cloudProgress}
        error={cloudError}
        onSync={() => { void syncCloud({ interactive: true }); }}
        onForget={() => { setCloudSession(null); setTakeHomeOpen(false); setAiNotification('Cet appareil n\'est plus lié à la session en ligne (elle reste disponible avec son lien).'); }}
      />
      {cloudProgress && !takeHomeOpen && (
        <div className="fixed inset-x-0 top-3 z-[660] flex justify-center px-4 pointer-events-none" role="status">
          <div className="w-full max-w-sm rounded-2xl border border-cyan-500/30 bg-[#0d1117]/95 p-3 shadow-2xl">
            <div className="flex justify-between text-[11px] font-bold text-cyan-200"><span>☁️ {cloudProgress.msg}</span><span>{cloudProgress.pct}%</span></div>
            <div className="mt-1.5 h-1.5 rounded-full bg-black/50 overflow-hidden"><div className="h-full bg-cyan-500 transition-all" style={{ width: `${cloudProgress.pct}%` }} /></div>
          </div>
        </div>
      )}
      {/* Sur téléphone, ces pastilles recouvraient le chat Nova, le menu et la barre
          d'ajout de piste : elles passent dans le menu ☰. */}
      {/* Ordinateur / tablette : la pastille « En ligne » est dans le bandeau du bas. */}
      <ProGateModal
        open={!!proGate}
        reason={proGate?.reason || ''}
        onDone={(ok) => { const g = proGate; setProGate(null); if (ok) { track('pro_subscribed', { from: 'gate' }); proOkRef.current = { at: Date.now(), ok: true }; setAiNotification('⭐ Nova Pro actif : tu peux importer tes instrus et collaborer.'); } g?.resolve(ok); }}
      />
      <RemoteIngePanel open={collabOpen && (remote.active || !!(remote.connecting && !collab))} onClose={() => setCollabOpen(false)} remote={remote} />
      <CollabPanel
        open={collabOpen && !remote.active && !(remote.connecting && !collab)}
        onClose={() => { setCollabOpen(false); if (!collab) { collabPayCancelRef.current = true; setCollabBusy(null); } }}
        active={!!collab}
        role={collab?.role || null}
        name={collab?.name || ''}
        members={collabOnline}
        messages={collabMessages}
        busy={collabBusy}
        status={collab && collabStatus ? collabStatusView(collabStatus, { othersOnline: collabOnline.filter(m => m.member_key !== collab.client.memberKey).length, peerSeenAt }) : null}
        onRetry={() => { void collabRef.current?.client.retryNow(); }}
        onReload={() => { void reloadCollabSession(); }}
        inviteUrl={(r) => (cloudSession?.secret ? `${sessionUrl({ id: cloudSession.id, secret: cloudSession.secret })}&role=${r}` : null)}
        onStart={(r, n) => { void startCollab(r, n); }}
        gate={collabGate}
        onSignIn={async (email, password) => {
          await signInAccount(email, password);
          setCollabGate(null);
          const r = pendingRemoteRef.current;
          if (r) { void startRemote(r.role, r.name, r.link); return; }
          const p = pendingStartRef.current;
          if (p) void startCollab(p.role, p.name);
        }}
        onStartRemote={(r, n, l) => { void startRemote(r, n, l); }}
        remoteBusy={remote.connecting}
        remoteError={remote.error}
        remoteLinkFromUrl={remoteLinkFromUrl}
        savedRemote={state.remoteInge ? { role: state.remoteInge.role } : null}
        liveVst={collab?.role === 'engineer' ? (
          <LiveVstRemotePanel
            tracks={state.tracks}
            catalog={artistVstCatalog}
            selectedTrackId={state.selectedTrackId}
            previews={state.tracks.filter(hasArtistVst).map(t => ({ trackId: t.id, name: t.name, view: previewView(previewStates[t.id]) }))}
            onRefreshPreview={(trackId) => requestArtistPreview(trackId)}
            onRead={(trackId, pluginId) => askArtistVst<VstParamsReply>('vst_params_get', { trackId, pluginId })}
            onSet={(trackId, pluginId, name, value) => {
              const num = Number(value.replace(',', '.'));
              const setting = value !== '' && Number.isFinite(num) && /^-?[\d.,]+$/.test(value.trim()) ? { name, real: num } : { name, text: value };
              return askArtistVst<VstParamAck>('vst_param', { trackId, pluginId, params: [setting] });
            }}
            onAdd={(entry, trackId) => {
              const plugin: PluginInstance = {
                id: `vst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: entry.name, type: 'VST3', isEnabled: true, latency: 0,
                params: { name: entry.name, vendor: entry.vendor, localPath: entry.path, pluginName: entry.pluginName || undefined },
              };
              setState(produce((d: DAWState) => { const t = d.tracks.find(x => x.id === trackId); if (t) t.plugins.push(plugin); }));
              setAiNotification(`🎛️ ${entry.name} (VST de l'artiste) ajouté sur ta piste : il se charge sur son PC. Règle-le ici (« Lire ses réglages »).`);
            }}
          />
        ) : null}
        onSubscribe={() => { void subscribeCollab(); }}
        onLeave={() => { void leaveCollab(); }}
        onSend={(text) => {
          const c = collabRef.current;
          if (!c) return;
          const localId = `me-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          setCollabMessages(m => [...m.slice(-199), { id: localId, from: c.name, role: c.role, text, at: Date.now(), mine: true, pending: true }]);
          // File d'envoi : hors ligne, le message part au retour du réseau (« envoi… » en attendant).
          c.client.queue(`chat:${localId}`, 'chat', { text, localId });
        }}
      />
      {/* « Collaborer » (ordinateur / tablette) : dans le bandeau du bas ; flottant,
          il recouvrait le bas du catalogue Beat Store. */}
      {!showLanding && <FrozenEditsNotice tracks={state.tracks} bridgeConnected={preFx.bridgeConnected} projectId={state.id} compact={isMobile} />}
      {preFx.panel && (
        <PreFxReplayPanel data={preFx.panel} onClose={preFx.close} onRefreeze={preFx.refreeze}
          onRevert={preFx.revertTrack} onRestore={preFx.restoreTrack} onRetry={preFx.retry} onTakeTheirs={preFx.takeTheirs} />
      )}
      {cloudConflict && (
        <div className="fixed inset-0 z-[670] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
          <div className="w-full max-w-md rounded-3xl border border-amber-500/30 bg-[#121418] p-6 shadow-2xl space-y-4">
            <h2 id="conflict-title" className="text-lg font-black text-white">⚠️ Session modifiée ailleurs</h2>
            <p className="text-[13px] text-slate-300">
              La session en ligne a été modifiée {cloudConflict.updatedFrom ? `sur ${cloudConflict.updatedFrom} ` : ''}{cloudConflict.updatedAt ? formatAgo(Date.parse(cloudConflict.updatedAt)) : ''}, après ta dernière synchronisation.
            </p>
            {state.tracks.some(t => t.freezeBase) && (
              <button type="button" className="h-12 w-full rounded-xl bg-cyan-500 text-[13px] font-black text-black"
                onClick={() => { void mergeCloudVersions(); }}>
                Fusionner : garder les éditions des deux (recommandé)
              </button>
            )}
            <button type="button" className={`h-12 w-full rounded-xl text-[13px] font-black ${state.tracks.some(t => t.freezeBase) ? 'bg-white/10 text-white' : 'bg-cyan-500 text-black'}`}
              onClick={() => { const c = cloudRef.current; setCloudConflict(null); if (c) void openCloudSession({ id: c.id, secret: c.secret }); }}>
              Ouvrir la version la plus récente
            </button>
            <button type="button" className="h-12 w-full rounded-xl bg-white/10 text-[13px] font-black text-white"
              onClick={() => { setCloudConflict(null); void syncCloud({ interactive: true, force: true }); setTakeHomeOpen(true); }}>
              Garder ma version (remplace celle en ligne)
            </button>
            <p className="text-[11px] text-slate-500">Ta version reste aussi sauvegardée sur cet appareil (« Reprendre ma session »).</p>
          </div>
        </div>
      )}
      <ShareClipModal open={shareOpen} onClose={() => setShareOpen(false)} state={state} onBuyBeat={() => openBuyBeat(stateRef.current.tracks)} />
      {isAuthOpen && <AuthScreen onAuthenticated={(u) => { setUser(u); setIsAuthOpen(false); }} onClose={() => setIsAuthOpen(false)} />}
      </Suspense>
      
      {addPluginMenu && <ContextMenu x={addPluginMenu.x} y={addPluginMenu.y} onClose={() => setAddPluginMenu(null)} items={AVAILABLE_FX_MENU.map(fx => ({ label: fx.name, icon: fx.icon, onClick: () => handleAddPluginFromContext(addPluginMenu.trackId, fx.id as PluginType, {}, { openUI: true }) }))} />}
      {automationMenu && <ContextMenu x={automationMenu.x} y={automationMenu.y} onClose={() => setAutomationMenu(null)} items={[{ label: `Automate: ${automationMenu.paramName}`, icon: 'fa-wave-square', onClick: handleCreateAutomationLane }]} />}
      
      {midiEditorOpen && state.tracks.find(t => t.id === midiEditorOpen.trackId) && (
          <div data-nova-transport="" className="fixed inset-0 z-[250] bg-[#0c0d10] flex flex-col animate-in slide-in-from-bottom-10 duration-200">
             <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-[11px]"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement de l'éditeur…</div>}>
               <PianoRoll track={state.tracks.find(t => t.id === midiEditorOpen.trackId)!} clipId={midiEditorOpen.clipId} bpm={state.bpm} currentTime={state.currentTime} onUpdateTrack={handleUpdateTrack} onClose={() => setMidiEditorOpen(null)}
                 isPlaying={state.isPlaying} onTogglePlay={handleTogglePlay}
                 projectKey={state.projectKey} projectScale={state.projectScale} onSetProjectKey={applyProjectKey} allTracks={state.tracks}
                 toolbarExtra={(() => {
                   // Mode instru seulement : le mode voix reste épuré.
                   const t = state.tracks.find(x => x.id === midiEditorOpen.trackId);
                   if (t?.bass808) return <Bass808Controls value={t.bass808} onChange={v => handleUpdateTrack({ ...t, bass808: v })} />;
                   if (!t || t.type !== TrackType.MIDI || !(state.projectMode === 'BEATMAKING' || collab?.role === 'beatmaker')) return null;
                   return (
                     <VstInstrumentPicker
                       track={t}
                       stale={!!t.vstInstrument && !isInstrumentRenderCurrent(t, state.bpm)}
                       onChoose={(p) => handleChooseInstrument(t.id, p)}
                       onUseSynth={() => handleUseSynth(t.id)}
                       onRetry={() => vstInstruments.retry(t.id)}
                       onError={(msg) => notifyInstrument(`🎹 ${msg}`)}
                     />
                   );
                 })()}
               />
             </Suspense>
          </div>
      )}
      
      {activePlugin && (
        <div className={`fixed inset-0 flex items-center justify-center z-[200] ${isMobile ? 'bg-[#0c0d10]' : 'bg-black/60 backdrop-blur-sm'}`} onMouseDown={() => !isMobile && setActivePlugin(null)}>
           <div className={`relative ${isMobile ? 'w-full h-full p-4 overflow-y-auto' : ''}`} onMouseDown={e => e.stopPropagation()}>
              <Suspense fallback={<div className="w-64 h-32 flex items-center justify-center text-slate-400 text-[11px] bg-[#14161a] border border-white/10 rounded-2xl"><i className="fas fa-circle-notch fa-spin mr-2"></i>Chargement…</div>}>
              <PluginEditor key={`${activePlugin.trackId}:${activePlugin.plugin.id}`} plugin={activePlugin.plugin} trackId={activePlugin.trackId} onClose={() => setActivePlugin(null)} onUpdateParams={(p) => handleUpdatePluginParams(activePlugin.trackId, activePlugin.plugin.id, p)} isMobile={isMobile} track={state.tracks.find(t => t.id === activePlugin.trackId)} onUpdateTrack={handleUpdateTrack} onToggleFreeze={handleFreezeTrack} onToggleBypass={handleToggleBypass} onOpenPlugin={(tid, p) => setActivePlugin({ trackId: tid, plugin: p })} />
              </Suspense>
           </div>
        </div>
      )}

      <Suspense fallback={null}>
      {isPluginManagerOpen && <PluginManager onClose={() => setIsPluginManagerOpen(false)} onPluginsDiscovered={(plugins) => { console.log("Plugins refreshed:", plugins.length); setIsPluginManagerOpen(false); }} />}
      {isAudioSettingsOpen && <AudioSettingsPanel onClose={() => setIsAudioSettingsOpen(false)} />}
      <AutotuneVstManager />
      </Suspense>
      
      <div className={isMobile && activeMobileTab !== 'NOVA' ? 'hidden' : ''}>
        <ChatAssistant
            onSendMessage={envoyerAuChatbot}
            onExecuteAction={executeAIAction}
            projectState={state}
            externalNotification={aiNotice?.text ?? null}
            externalNotificationId={aiNotice?.id}
            suppressAutoOpen={drumsOpen || !!midiEditorOpen || isExportMenuOpen || collabOpen || takeHomeOpen}
            isMobile={isMobile}
            forceOpen={isMobile && activeMobileTab === 'NOVA'}
            onRequestOpen={isMobile ? () => setActiveMobileTab('NOVA') : undefined}
            mixGuideRequest={mixGuideRequest}
            novaFeed={novaFeed}
            onClose={() => setActiveMobileTab('ARRANGEMENT')}
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
