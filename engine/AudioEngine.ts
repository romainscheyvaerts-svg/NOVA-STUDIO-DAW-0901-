
import { getRegisteredPlugin, isTruePeakLimiter } from './pluginRegistry';
import { soloSilencedIds } from '../utils/soloMute';
import { Track, Clip, PluginInstance, TrackType, TrackSend, AutomationLane, PluginParameter, PluginType, MidiNote, DrumPad, AutomationPoint } from '../types';
import { getASIOBridge, ASIOBridgeClient, ASIOConfig, AudioDevice, ASIOStats } from '../services/ASIOBridge';
import { ASIOInput } from './ASIOInput';
import { ReverbNode } from '../plugins/ReverbPlugin';
import { SyncDelayNode } from '../plugins/DelayPlugin';
import { ChorusNode } from '../plugins/ChorusPlugin';
import { FlangerNode } from '../plugins/FlangerPlugin';
import { VocalDoublerNode } from '../plugins/DoublerPlugin';
import { StereoSpreaderNode } from '../plugins/StereoSpreaderPlugin';
import { HybridAutoTuneNode } from './HybridAutoTuneNode';
import { CompressorNode } from '../plugins/CompressorPlugin';
import { DeEsserNode } from '../plugins/DeEsserPlugin';
import { DenoiserNode } from '../plugins/DenoiserPlugin';
import { ProEQ12Node } from '../plugins/ProEQ12Plugin';
import { VocalSaturatorNode } from '../plugins/VocalSaturatorPlugin';
import { MasterSyncNode } from '../plugins/MasterSyncPlugin';
import { Synthesizer } from './Synthesizer';
import { NovaSynthNode } from './NovaSynthNode';

/** Synthé d'une piste MIDI : synthé NOVA (track.novaSynth) ou ancien synthé simple (anciens projets). */
type TrackSynth = Synthesizer | NovaSynthNode;
const makeTrackSynth = (ctx: BaseAudioContext, track: Track): TrackSynth =>
  track.novaSynth ? new NovaSynthNode(ctx, track.novaSynth) : new Synthesizer(ctx as AudioContext);
/** Notes dans l'ordre du temps (synthé NOVA : mono et glissé décidés d'après l'instant). */
const sortedNotesCache = new WeakMap<object, any[]>();
const notesInTimeOrder = <T extends { start: number }>(notes: T[]): T[] => {
  let r = sortedNotesCache.get(notes) as T[] | undefined;
  if (!r) { r = [...notes].sort((a, b) => a.start - b.start); sortedNotesCache.set(notes, r); }
  return r;
};
import { AudioSampler } from './AudioSampler';
import { DrumSamplerNode } from './DrumSamplerNode';
import { MelodicSamplerNode } from './MelodicSamplerNode';
import { loadSamplerZones, samplerSoundSig } from '../utils/samplerLoad';
import { interpolateCurve, playedLanes, parsePluginParam, valueAtPoints, sortedPoints, isWriteMode, automationModeOf } from '../utils/automationWrite';
import { DrumRackNode } from './DrumRackNode'; // NEW
import { DrumPadFxBank } from './DrumPadFx';
import { Bass808Node, planOfClips } from './Bass808Node';
import { events808 } from '../utils/bass808';
import { playableNotes, ccValueAt, ccDefault, sortPoints, SUSTAIN } from '../utils/midiCc';
import { NovaRecorderSession, ensureRecorderModule, encodeWav24 } from './NovaRecorder';
import { InputRouter, InputTap } from './InputRouter';
import { createAsioOutputTap, AsioOutputTap } from './AsioOutputTap';
import { CueMixEngine } from './CueMixEngine';
import { retireWorkletNode } from './workletGuard';
import { channelOffsets, channelOffsetSec, neededInputChannels, offsetsFromProbe, setChannelOffsets } from '../utils/multiRecord';
import { directMonitorRoutes, outputLayout } from '../utils/cueMix';
import { newTakeGroupId } from '../utils/takeGroups';
import type { CueMix, RecordInput } from '../types';
import { metronomeService } from '../services/MetronomeService';
import type { ASIOStreamInfo, ASIOLatencyResult } from '../services/ASIOBridge';
import { CaptureRing as _CaptureRing, chooseCapture, captureMinutes, captureWorkletSource, type PlayRun } from '../utils/audioCapture';
void _CaptureRing;

/** Module AudioWorklet de la capture après coup, chargé une fois par contexte. */
const flashbackLoads = new WeakMap<BaseAudioContext, Promise<void>>();
function loadFlashbackModule(ctx: AudioContext): Promise<void> {
  let p = flashbackLoads.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([captureWorkletSource()], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    flashbackLoads.set(ctx, p);
    p.catch(() => flashbackLoads.delete(ctx));
  }
  return p;
}
import { placeHumTake } from './humTake';
import { VSTPluginNode, vstParamCatalog } from './VSTPluginNode';
import { AraInsertNode } from './AraInsertNode';
import { isAraInsert } from '../utils/araInsert';
import { installWorkletGuard, installWorkletRetirement, onWorkletCrash, ownsNode, retireWorkletsOf } from './workletGuard';
import { isTrackFrozen, preFreezePlugins, postFreezePlugins, uncoveredClips, freezeIndex, frozenPlayback, isFrozenBus, isFeedCovered, busFrozenSlices } from '../utils/freeze';
import { PRE_VOLUME } from '../utils/preFxEdits';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { renderElasticAsync } from '../utils/clipTranspose';
import { computePdc, PdcNode, PDC_MAX_SECONDS } from '../utils/pdc';
import { applyGainEvents, clipGainEvents } from '../utils/fades';
import { breathSig } from '../utils/breathEnvelope';
import { gainPointsSig } from '../utils/clipGain';
import { Scrubber, type ScrubStats } from './Scrubber';
import { playheadStore } from '../utils/playheadStore';
import { auditionClips } from '../utils/playlists';
import { ChordEvent, chordSteps } from '../utils/chordDetect';
import { engineView, VOID_OUTPUT } from '../utils/trackStructure';
import { legacyAutomatable, paramsWithoutAutomated, hasPluginLane, pluginParamStaticValue } from './automationParams';
import { isMuteParam, muteGainPoints, muteLaneOf } from '../utils/muteAutomation';
import { SidechainRouter, KeyPath, KeyRoute, keyRoutes, pdcKeysFor, latencyBefore, isKeyedNode } from './sidechain';
// R11 : vrais mètres (AudioWorklet partagé) et tête de tranche (trim, Ø, mono, largeur).
import { meterBank } from './meters/meterBank';
import { buildStrip, disposeStrip, setStrip, stripParam, stripSignature, StripNodes, TRIM_PARAM, WIDTH_PARAM } from './meters/channelStrip';
import { GrPart, readGainReduction } from './meters/gainReduction';

interface TrackDSP {
  input: GainNode;          
  output: GainNode;         
  panner: StereoPannerNode; 
  gain: GainNode;           
  analyzer: AnalyserNode;
  inputAnalyzer?: AnalyserNode; 
  /** crashed : son worklet a planté (processorerror) ; l'effet est contourné et sera recréé s'il est réactivé. */
  pluginChain: Map<string, { input: AudioNode; output: AudioNode; instance: any; connectedTo?: AudioNode; bypassDelay?: DelayNode; crashed?: boolean }>;
  /** Pan propre des envois (TrackSend.pan, Pro Tools « FMP » éteint). */
  sendPanners?: Map<string, StereoPannerNode>;
  /** Effets actifs cables (ordre de la chaine) et, sur une piste gelee, ceux apres le rendu. */
  chainIds?: string[];
  postChainIds?: string[];
  /** Latence cumulée des effets actifs (s) : les clips de la piste partent d'autant plus tôt. */
  pluginLatency?: number; 
  /**
   * Piste gelee : le rendu entre ici, apres les effets compris dans le rendu
   * (frozenInput -> effets restants -> fader). postFreezeLatency : latence des
   * seuls effets restants, appliquee au clip gele.
   */
  frozenInput?: GainNode;
  frozenClipId?: string;
  postFreezeLatency?: number;
  sends: Map<string, GainNode>; 
  /**
   * Envois pré-fader (TrackSend.preFader) : prise après les effets, avant le
   * fader et le pan (gain unité, toujours câblé entre la chaîne et le fader).
   */
  preFaderTap?: GainNode;
  /**
   * Sortie de la chaîne d'effets (gain unité, avant le mute automatisé) : la
   * clé de side-chain « avant fader » y est prise (R7). Le preFaderTap qui suit
   * porte le mute automatisé (R8).
   */
  chainOut?: GainNode;
  /**
   * Compensation de latence (PDC) : retard de la sortie principale et de chaque
   * envoi pour aligner les chemins plus courts (voir utils/pdc.ts) ; outputs =
   * destinations câblées ; downLatency = latence en aval de la chaîne (s).
   */
  outDelay?: DelayNode;
  sendDelays?: Map<string, DelayNode>;
  outputs?: string[];
  downLatency?: number;
  inputStream?: MediaStreamAudioSourceNode | null;
  currentInputDeviceId?: string | null;
  synth?: TrackSynth; // Synthé NOVA ou ancien synthé simple (pistes MIDI)
  sampler?: AudioSampler; // Legacy/Chromatic Sampler
  drumSampler?: DrumSamplerNode; // Pro Drum Sampler (Single)
  melodicSampler?: MelodicSamplerNode; // New Pro Melodic Sampler
  drumRack?: DrumRackNode; // NEW: 30-Pad Drum Rack
  /** Basse 808 mélodique (piste MIDI avec track.bass808). */
  bass808?: Bass808Node;
  /** Mix par pad de la batterie Make Music. */
  drumFx?: DrumPadFxBank;
  // Empreinte du cablage (plugins, routage, departs) : permet d'eviter de
  // reconstruire — et donc de couper brievement — le graphe quand rien de
  // structurel n'a change.
  graphSignature?: string;
  /** Tête de tranche (R11) : trim, Ø, mono, largeur ; absente si la piste est neutre. */
  strip?: StripNodes | null;
}

/** Médiane (latences mesurées pendant une prise). */
function medianOf(v: number[]): number {
  const a = [...v].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Prise à journaliser : piste, position, latence ; `group` et `channels` en multipiste (R14). */
export interface TakeJournalMeta { trackId: string; recordedAt: number; latency: number; sampleRate: number; group?: string; channels?: number }

/** Résultat d'une prise : un clip par piste armée ; `group` = groupe de prises (passage multipiste). */
export interface TakeResult { clip: Clip; trackId: string; group?: string }

/** Journal d'une prise en cours (utils/recoveryStore.TakeJournal). */
export interface TakeJournalLike {
  push(chunk: Float32Array): void;
  /** Avance du son sur le départ de la lecture (s) : la prise récupérée est replacée au bon endroit. */
  annotate?(patch: { lead?: number }): void;
  finish(): Promise<void>;
  discard(): Promise<void>;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: string;
}

export class AudioEngine {
  public ctx: AudioContext | null = null;
  
  // Master Section
  private masterOutput: GainNode | null = null;
  private browserOutput: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null; // SAFETY LIMITER
  private masterAnalyzer: AnalyserNode | null = null; 
  private masterSplitter: ChannelSplitterNode | null = null;
  public masterAnalyzerL: AnalyserNode | null = null;
  public masterAnalyzerR: AnalyserNode | null = null;
  
  // Graph Audio
  private tracksDSP: Map<string, TrackDSP> = new Map();
  /** Buffers inverses mis en cache (clip.isReversed). */
  private reversedBufferCache: Map<string, AudioBuffer> = new Map();
  private activeSources: Map<string, ScheduledSource> = new Map();
  /** Pistes à jour pendant la lecture (les modifications s'entendent tout de suite). */
  private liveTracks: Track[] | null = null;
  private clipSigs: Map<string, string> = new Map();
  private scrubbingSources: Map<string, ScheduledSource> = new Map();
  
  // MIDI State
  private activeMidiNotes: Set<string> = new Set(); // Key: "trackId-noteId"

  // --- PREVIEW SYSTEM (STUDIO MODE) ---
  private previewSource: AudioBufferSourceNode | null = null;
  private previewGain: GainNode | null = null;
  public previewAnalyzer: AnalyserNode | null = null;
  private isPreviewPlaying: boolean = false;

  // Scheduling State
  private isPlaying: boolean = false;
  private schedulerTimer: number | null = null;
  private nextScheduleTime: number = 0;
  private playbackStartTime: number = 0; 
  private pausedAt: number = 0; 

  // Latency & Rec
  private isRecMode: boolean = false;
  private isDelayCompEnabled: boolean = false;

  private LOOKAHEAD_MS = 10.0; 
  private SCHEDULE_AHEAD_SEC = 0.05; 

  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private activeMonitorStream: MediaStream | null = null;
  private monitorSource: MediaStreamAudioSourceNode | null = null;
  // Retour casque : le micro passe par ce gain avant la piste. Coupé par défaut :
  // sur haut-parleurs le retour provoquait un larsen, et en Bluetooth la voix
  // revenait avec 150-300 ms de retard. L'enregistrement capte le flux brut,
  // il n'est pas concerné.
  private monitorGain: GainNode | null = null;
  private inputMonitoring = false;
  // --- Compensation de latence d'enregistrement ---
  private recSession: NovaRecorderSession | null = null;
  private recSource: AudioNode | null = null;
  /**
   * Journal de la prise en cours (utils/recoveryStore) : chaque morceau capté est
   * écrit sur l'appareil pendant l'enregistrement, pour la retrouver après un plantage.
   */
  private takeJournalFactory: ((m: TakeJournalMeta) => TakeJournalLike | null) | null = null;
  /** R14 : un journal par piste de la prise. */
  private recJournals = new Map<string, TakeJournalLike>();
  /** R14 : entrées des pistes armées (plusieurs à la fois), source partagée. */
  private inputRouter: InputRouter | null = null;
  /** Entrée demandée par piste armée (Track.recordInput). */
  private armedSpecs = new Map<string, RecordInput | null>();
  private armErrors = new Map<string, string>();
  /** Pistes de la prise en cours, entrée de l'enregistreur commun et groupe de prises. */
  private recordingTrackIds: string[] = [];
  private recInput: ReturnType<InputRouter['recorderInput']> = null;
  private recChannels = new Map<string, number[]>();
  private recGroup: string | undefined;
  private recLeadDone = false;
  /** Canaux max que le navigateur donne pour le micro (capabilities), 0 = inconnu. */
  private browserMaxChannels = 0;
  /** Volume / pan connus des pistes (retour direct du pont, mixes casque). */
  private trackMix = new Map<string, { id: string; volume: number; pan: number }>();
  // --- R15 · Mixes casque et sorties de la carte ---
  private cueEngine: CueMixEngine | null = null;
  private cueMixes: CueMix[] = [];
  private cueListen: string | null = null;
  /** Sortie principale : master (mainSel) + mix casque écouté ; part vers le navigateur et la carte. */
  private mainSel: GainNode | null = null;
  private mainOut: GainNode | null = null;
  private asioInputChannels = 2;
  private asioOutputChannels = 2;
  private asioBlockSize = 256;
  private asioOutLayoutSig = '';
  private asioOutParts: AudioNode[] = [];
  private configWaiters: ((m: any) => void)[] = [];
  /** Début de lecture (horloge) pendant la prise : STOP coupe la lecture avant la prise. */
  private recPlayStart: number | null = null;
  private latencySamples: number[] = [];
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  private lastLatency = 0;
  private asioQueueSec = 0;
  /** Réglage fin manuel (ms, + = la prise est avancée davantage). */
  private recOffsetMs = (() => { try { const v = parseFloat(localStorage.getItem('nova_rec_offset_ms') || ''); return Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0; } catch { return 0; } })();
  /** Volume du retour de la voix dans le casque (0-2), indépendant du niveau enregistré. */
  private monitorLevel = (() => {
    try { const v = parseFloat(localStorage.getItem('nova_monitor_level') || ''); return Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 1; } catch { return 1; }
  })();
  private monitoringTrackId: string | null = null;
  private recordingTrackId: string | null = null;
  private recStartTime: number = 0;
  
  private armingPromise: Promise<void> | null = null;

  // --- LOOP MANAGEMENT ---
  // Solo : ids des pistes SOURCES rendues muettes par le solo d'une autre piste.
  // Le solo n'etait gere que dans le chemin d'export ; en lecture live le bouton
  // s'allumait mais aucune piste n'etait coupee.
  private soloSilencedIds: Set<string> = new Set();

  private isLoopActive: boolean = false;
  private loopStart: number = 0;
  private loopEnd: number = 0;
  // Un rebouclage est programme jusqu'a SCHEDULE_AHEAD_SEC a l'avance : on garde
  // l'ancienne correspondance temps-contexte / temps-projet jusqu'a l'instant reel
  // du bouclage, sinon le playhead reviendrait au debut avant que l'audio le fasse.
  private pendingLoopWrap: { atContextTime: number; previousStartTime: number } | null = null;

  // --- DEVICE MANAGEMENT ---
  private currentInputDeviceId: string = 'default';
  private currentOutputDeviceId: string = 'default';
  public sampleRate: number = 44100;
  public latency: number = 0;
  private currentBpm: number = 120;

  // --- ASIO BRIDGE ---
  private asioBridge: ASIOBridgeClient | null = null;
  private asioConnected: boolean = false;
  private asioStreamActive: boolean = false;
  private asioDevices: AudioDevice[] = [];
  private asioConfig: ASIOConfig | null = null;
  private asioInputNode: MediaStreamAudioSourceNode | null = null;
  /** Entrée de la carte son via le pont ASIO (remplace le micro du navigateur quand le flux est actif). */
  private asioInput: ASIOInput | null = null;
  private asioInputReceived = false;
  /** Envoi vers la carte : AudioWorklet (ou ScriptProcessor sans AudioWorklet). */
  private asioOutputProcessor: AudioNode | null = null;
  private asioOutTap: AsioOutputTap | null = null;
  private asioOutGen = 0;

  constructor() {
    // Garde des worklets : un processeur qui plante est retrouvé et contourné (voir handleWorkletCrash).
    if (typeof window !== 'undefined') {
      installWorkletGuard();
      // Worklets retirés (effet enlevé, prise finie, synthé remplacé) : vraiment libérés.
      installWorkletRetirement();
      onWorkletCrash((node, processor) => this.handleWorkletCrash(node, processor));
    }
  }

  /**
   * Un worklet a levé une exception (il ne sort plus que du silence).
   * Effet de piste : contourné TOUT DE SUITE (entrée reliée à sa sortie : le son
   * sec continue), puis l'appli le passe en bypass et prévient
   * ('nova:plugin-crash'). Le réactiver recrée l'effet (voir wire()).
   * Autre module (synthé, enregistreur, entrée ASIO…) : 'nova:audio-module-crash'.
   */
  public handleWorkletCrash(node: AudioWorkletNode, processor: string): { kind: 'plugin' | 'module' | 'unknown'; trackId?: string; pluginId?: string } {
    for (const [trackId, dsp] of this.tracksDSP) {
      for (const [pluginId, entry] of dsp.pluginChain) {
        if (entry.crashed || !ownsNode(entry.instance, node)) continue;
        entry.crashed = true;
        try { entry.input.disconnect(); } catch (e) { /* déjà déconnecté */ }
        try { entry.input.connect(entry.output); } catch (e) { /* */ }
        const track = this.liveTracks?.find(t => t.id === trackId);
        const plugin = track?.plugins.find(p => p.id === pluginId);
        const detail = { trackId, pluginId, name: plugin?.name || plugin?.type || processor, trackName: track?.name || trackId, processor };
        console.error(`[AudioEngine] Effet planté contourné : ${detail.name} (${detail.trackName})`);
        try { window.dispatchEvent(new CustomEvent('nova:plugin-crash', { detail })); } catch (e) { /* hors navigateur */ }
        return { kind: 'plugin', trackId, pluginId };
      }
    }
    let module = '';
    let trackId: string | undefined;
    for (const [tid, dsp] of this.tracksDSP) {
      if (dsp.synth && ownsNode(dsp.synth, node)) { module = 'le synthé'; trackId = tid; break; }
      if (dsp.bass808 && ownsNode(dsp.bass808, node)) { module = 'la 808'; trackId = tid; break; }
    }
    if (!module && this.recSession && ownsNode(this.recSession, node)) module = "l'enregistreur";
    if (!module && this.asioInput && ownsNode(this.asioInput, node)) module = "l'entrée de la carte son";
    if (!module && this.humTake && ownsNode(this.humTake, node)) module = "l'enregistreur (fredonner)";
    // Web Audio n'expose pas le graphe : on ne peut pas recâbler un module inconnu, on prévient.
    const detail = { module: module || `le module audio « ${processor} »`, trackId, processor };
    console.error(`[AudioEngine] Module audio arrêté : ${detail.module}`);
    try { window.dispatchEvent(new CustomEvent('nova:audio-module-crash', { detail })); } catch (e) { /* hors navigateur */ }
    return { kind: module ? 'module' : 'unknown', trackId };
  }

  public async init() {
    if (this.ctx) return;

    // Preferences audio persistees : elles n'etaient appliquees que si le
    // panneau de reglages etait ouvert, et le peripherique d'entree n'etait
    // jamais reinjecte dans le moteur au rechargement.
    try {
      const savedInput = localStorage.getItem('nova_audio_input');
      const savedOutput = localStorage.getItem('nova_audio_output');
      const savedLatency = localStorage.getItem('nova_audio_latency');
      if (savedInput) this.currentInputDeviceId = savedInput;
      if (savedOutput) this.currentOutputDeviceId = savedOutput;
      if (savedLatency === 'low' || savedLatency === 'balanced' || savedLatency === 'high') {
        this.setLatencyMode(savedLatency);
      }
    } catch (e) { /* localStorage indisponible (navigation privee) */ }

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass({ 
      latencyHint: 'interactive',
      sampleRate: 44100
    });
    
    this.sampleRate = this.ctx.sampleRate;
    this.latency = this.ctx.baseLatency;
    this.hookAutoResume();

    this.masterOutput = this.ctx.createGain();
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1.0;
    this.masterLimiter.knee.value = 0.0;
    this.masterLimiter.ratio.value = 20.0;
    this.masterLimiter.attack.value = 0.005; 
    this.masterLimiter.release.value = 0.1;

    this.masterAnalyzer = this.ctx.createAnalyser();
    this.masterAnalyzer.fftSize = 2048;
    this.masterAnalyzer.smoothingTimeConstant = 0.8;
    
    this.masterSplitter = this.ctx.createChannelSplitter(2);
    this.masterAnalyzerL = this.ctx.createAnalyser();
    this.masterAnalyzerR = this.ctx.createAnalyser();
    this.masterAnalyzerL.fftSize = 1024; 
    this.masterAnalyzerR.fftSize = 1024;
    this.masterAnalyzerL.smoothingTimeConstant = 0.5;
    this.masterAnalyzerR.smoothingTimeConstant = 0.5;

    this.masterOutput.connect(this.masterLimiter);
    // R11 : le DynamicsCompressorNode de Chrome ajoute un gain de compensation
    // automatique (« makeup ») de (1 / gain à 0 dBFS)^0,6 : +0,57 dB ici, sur
    // TOUT le mix, même très en dessous du seuil. L'écoute était donc 0,57 dB
    // plus forte que l'export (qui n'a pas ce limiteur) et le LUFS lu en
    // direct ne collait pas à celui du fichier. On retire ce gain juste après.
    const safetyTrim = this.ctx.createGain();
    const fullRangeDb = this.masterLimiter.threshold.value * (1 - 1 / this.masterLimiter.ratio.value);
    safetyTrim.gain.value = Math.pow(Math.pow(10, fullRangeDb / 20), 0.6);
    this.masterLimiter.connect(safetyTrim);
    safetyTrim.connect(this.masterAnalyzer);
    // Sortie « navigateur » coupée pendant le flux ASIO : le mix part alors par
    // la carte, sinon l'artiste l'entendait deux fois (écho / effet de phase).
    this.browserOutput = this.ctx.createGain();
    // R15 : sortie principale = le master, ou un mix casque écouté à sa place.
    this.mainSel = this.ctx.createGain();
    this.mainOut = this.ctx.createGain();
    this.masterAnalyzer.connect(this.mainSel);
    this.mainSel.connect(this.mainOut);
    this.cueEngine = new CueMixEngine(this.ctx);
    this.cueEngine.listenOut.connect(this.mainOut);
    this.mainOut.connect(this.browserOutput);
    this.browserOutput.connect(this.ctx.destination);
    
    this.masterAnalyzer.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyzerL, 0);
    this.masterSplitter.connect(this.masterAnalyzerR, 1);
    // R11 : mètres du master (crête vraie, LUFS, corrélation) sur la sortie finale.
    meterBank.init(this.ctx, this.masterAnalyzer);

    this.previewGain = this.ctx.createGain();
    this.previewAnalyzer = this.ctx.createAnalyser();
    this.previewAnalyzer.fftSize = 256; 
    this.previewGain.connect(this.previewAnalyzer);
    this.previewAnalyzer.connect(this.ctx.destination);

    // La sortie sauvegardee necessite un contexte existant (setSinkId) : on
    // l'applique une fois le graphe construit.
    if (this.currentOutputDeviceId && this.currentOutputDeviceId !== 'default') {
      this.setOutputDevice(this.currentOutputDeviceId).catch(() => {});
    }

    // Auto-connect to ASIO Bridge if available (Windows only)
    // This allows users who have installed the bridge to have it connect automatically
    this.tryAutoConnectASIO();
  }

  /**
   * Tente de se connecter automatiquement au bridge ASIO si disponible.
   * N'affiche pas d'erreur si le bridge n'est pas disponible.
   * Sauvegarde/restaure l'état de connexion dans localStorage.
   */
  private async tryAutoConnectASIO(): Promise<void> {
    // Check if user previously had ASIO connected
    const wasASIOEnabled = localStorage.getItem('nova_asio_autoconnect') === 'true';
    
    if (!wasASIOEnabled) {
      // User hasn't enabled auto-connect, skip
      return;
    }

    try {
      console.log('[AudioEngine] Tentative de connexion automatique au bridge ASIO...');
      const connected = await this.connectASIO();
      
      if (connected) {
        console.log('[AudioEngine] ✅ Auto-connexion ASIO réussie!');
        
        // Restore last selected device if any
        const lastDevice = localStorage.getItem('nova_asio_device');
        if (lastDevice) {
          setTimeout(() => {
            const devices = this.getASIODevices();
            if (devices.some(d => d.name === lastDevice)) {
              this.configureASIO({ device_name: lastDevice });
              console.log(`[AudioEngine] Device ASIO restauré: ${lastDevice}`);
            }
          }, 1000);
        }
      }
    } catch (e) {
      // Silently fail - bridge is simply not running
      console.log('[AudioEngine] Bridge ASIO non disponible (auto-connect ignoré)');
    }
  }

  /**
   * Active/désactive l'auto-connexion au bridge ASIO
   */
  public setASIOAutoConnect(enabled: boolean): void {
    localStorage.setItem('nova_asio_autoconnect', enabled ? 'true' : 'false');
  }

  /**
   * Sauvegarde le device ASIO sélectionné pour le restaurer au prochain démarrage
   */
  public saveASIODevice(deviceName: string): void {
    localStorage.setItem('nova_asio_device', deviceName);
  }

  public getAudioBuffer(clipId: string): AudioBuffer | undefined {
    return audioBufferRegistry.get(clipId);
  }

  /** La piste a-t-elle vraiment son entrée ouverte (armement effectif côté moteur) ? */
  public isMonitoring(trackId: string): boolean {
    return !!this.inputRouter?.has(trackId) || !!this.armingPromise;
  }

  /** R14 : pistes armées côté moteur (entrée ouverte), dans l'ordre d'armement. */
  public armedIds(): string[] { return this.inputRouter?.ids() || []; }

  /** R14 : pistes de la prise en cours. */
  public getRecordingTrackIds(): string[] { return [...this.recordingTrackIds]; }

  /**
   * R14 : entrées des pistes armées (vumètres, messages) et nombre d'entrées que la
   * source donne (carte via le pont, ou micro du navigateur).
   */
  public getInputInfo(): { mode: 'asio' | 'navigateur'; available: number; armed: { trackId: string; channels: number[]; missing: boolean; width: 1 | 2 }[] } {
    const src = this.inputRouter?.getSource();
    const asio = this.asioStreamActive && this.asioConnected;
    const available = asio ? this.asioInputChannels : Math.max(src?.kind === 'navigateur' ? src.channels : 0, this.browserMaxChannels || 0, 2);
    return {
      mode: asio ? 'asio' : 'navigateur',
      available,
      armed: (this.inputRouter?.all() || []).map(t => ({ trackId: t.trackId, channels: [...t.channels], missing: t.missing, width: t.width })),
    };
  }

  /** Pistes qui ont une chaîne audio dans le moteur. */
  public trackIds(): string[] {
    return [...this.tracksDSP.keys()];
  }

  /** Caches du moteur dont le son d'origine a été libéré (clips inversés). */
  public pruneCaches() {
    this.reversedBufferCache.forEach((_, key) => { if (!audioBufferRegistry.has(key)) this.reversedBufferCache.delete(key); });
  }

  /** Journal des prises (récupération après plantage) : branché par l'appli. */
  public setTakeJournalFactory(f: ((m: TakeJournalMeta) => TakeJournalLike | null) | null) {
    this.takeJournalFactory = f;
  }

  /** Diagnostic (endurance, console) : tailles des structures vivantes du moteur. */
  public getDiagnostics() {
    let plugins = 0, sends = 0;
    this.tracksDSP.forEach(d => { plugins += d.pluginChain.size; sends += d.sends.size; });
    return {
      ctxState: this.ctx?.state ?? null,
      ctxTime: this.ctx?.currentTime ?? 0,
      tracksDSP: this.tracksDSP.size,
      plugins,
      sends,
      activeSources: this.activeSources.size,
      scrubbingSources: this.scrubbingSources.size,
      reversedCache: this.reversedBufferCache.size,
      activeMidiNotes: this.activeMidiNotes.size,
      pluginAutoParams: this.pluginAutoParams.size,
      isPlaying: this.isPlaying,
    };
  }

  public async setOutputDevice(deviceId: string) {
      if (!this.ctx) return;
      this.currentOutputDeviceId = deviceId;
      // @ts-ignore
      if (typeof this.ctx.setSinkId === 'function') {
          try {
              // @ts-ignore
              await this.ctx.setSinkId(deviceId);
          } catch (err) { console.error(err); }
      }
  }

  public setInputDevice(deviceId: string) { this.currentInputDeviceId = deviceId; }
  public getActiveInputDevice() { return this.currentInputDeviceId; }
  public getActiveOutputDevice() { return this.currentOutputDeviceId; }
  
  public setLatencyMode(mode: 'low' | 'balanced' | 'high') {
      if (mode === 'low') { this.LOOKAHEAD_MS = 15.0; this.SCHEDULE_AHEAD_SEC = 0.04; } 
      else if (mode === 'balanced') { this.LOOKAHEAD_MS = 25.0; this.SCHEDULE_AHEAD_SEC = 0.1; } 
      else { this.LOOKAHEAD_MS = 50.0; this.SCHEDULE_AHEAD_SEC = 0.2; }
  }

  public setDelayCompensation(enabled: boolean) { this.isDelayCompEnabled = enabled; }

  /**
   * Latence aller-retour estimee, en secondes : le retard avec lequel
   * l'interprete a entendu la lecture, plus le retard de sa propre voix a
   * l'entree. C'est de cette duree qu'une prise arrive en retard sur la grille.
   */
  public getRoundTripLatency(): number {
    if (!this.ctx) return 0;
    if (this.asioStreamActive && this.latency > 0) return this.latency;
    const base = this.ctx.baseLatency || 0;
    const output = (this.ctx as any).outputLatency || 0;
    // Garde-fou : au-dela de 500 ms la mesure n'est pas credible.
    return Math.min(0.5, base + output);
  }
  
  /**
   * Latence d'enregistrement mesurée maintenant (s) : retard avec lequel
   * l'artiste entend la lecture + retard de sa voix jusqu'à l'enregistreur.
   * C'est de cette durée qu'une prise arrive en retard sur la grille.
   */
  public measureRecordLatency(stream?: MediaStream | null): { total: number; mode: 'asio' | 'navigateur' } {
    if (!this.ctx) return { total: 0, mode: 'navigateur' };
    const sr = this.ctx.sampleRate;
    if (!stream && this.isUsingASIOInput() && this.asioStreamActive) {
      // pilote (entrée + sortie) + file de sortie du pont + tampon d'envoi (2 × 256)
      // + tampon d'entrée de Nova + réseau local
      const fill = this.asioInput?.fillSec ?? 0.03;
      const total = (this.latency || 0) + this.asioQueueSec + 512 / sr + fill + 0.002;
      return { total: Math.min(0.5, total), mode: 'asio' };
    }
    const out = (this.ctx.baseLatency || 0) + ((this.ctx as any).outputLatency || 0);
    let inp = 0.01;
    try {
      const s = (stream || this.activeMonitorStream)?.getAudioTracks()[0]?.getSettings() as any;
      if (s && typeof s.latency === 'number' && s.latency > 0) inp = s.latency;
    } catch { /* défaut 10 ms */ }
    return { total: Math.min(0.5, out + inp), mode: 'navigateur' };
  }

  /** Mesure régulière (chaque seconde) tant qu'une piste est armée. */
  private startLatencyWatch() {
    this.stopLatencyWatch();
    const tick = () => {
      if (this.asioConnected && this.asioStreamActive) this.asioBridge?.getStats();
      const m = this.measureRecordLatency();
      this.lastLatency = this.lastLatency ? this.lastLatency * 0.6 + m.total * 0.4 : m.total;
      if (this.recordingTrackId) this.latencySamples.push(m.total);
      // Capture après coup : la latence de chaque passage de lecture, comme pour une prise.
      if (this.flashbacks.size && this.isPlaying) { const r = this.flashbackRuns[this.flashbackRuns.length - 1]; if (r && r.to === null) (r.lat = r.lat || []).push(m.total); }
      try { window.dispatchEvent(new CustomEvent('nova:latency', { detail: { ms: Math.round(this.lastLatency * 1000), mode: m.mode, offsetMs: this.recOffsetMs } })); } catch { /* */ }
    };
    tick();
    this.latencyTimer = setInterval(tick, 1000);
  }

  private stopLatencyWatch() {
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    this.latencyTimer = null;
  }

  public getLastLatencyMs() { return Math.round(this.lastLatency * 1000); }
  public getRecordOffsetMs() { return this.recOffsetMs; }
  public setRecordOffsetMs(ms: number) {
    this.recOffsetMs = Math.max(-100, Math.min(100, Math.round(ms)));
    try { localStorage.setItem('nova_rec_offset_ms', String(this.recOffsetMs)); } catch { /* */ }
  }

  /** Retour direct dans le pont ASIO : la voix de la carte repart vers le casque sans passer par le DAW. */
  private directMonitorActive(): boolean {
    return !!this.asioBridge && this.asioConnected && this.isUsingASIOInput() && this.asioStreamActive && !!this.inputRouter?.size;
  }

  /** Retour casque côté DAW de chaque piste armée (coupé quand le pont fait le retour direct). */
  private monitorGainFor(): number {
    if (this.directMonitorActive()) return 0;
    return this.inputMonitoring ? this.monitorLevel : 0;
  }

  private applyMonitorGains() {
    if (this.ctx) this.inputRouter?.setMonitorGain(this.monitorGainFor(), this.ctx.currentTime);
  }

  /**
   * Retour direct dans le pont ASIO quand la voix arrive par la carte son. R15 : une
   * matrice (pistes armées → sorties 1-2 et → la paire de chaque mix casque).
   */
  private syncDirectMonitor() {
    this.applyMonitorGains();
    if (!this.asioBridge || !this.asioConnected) return;
    const direct = this.directMonitorActive();
    if (this.asioBridge.protocol >= 2) {
      const armed = (this.inputRouter?.all() || []).map(t => ({ track: this.trackMix.get(t.trackId) || { id: t.trackId, volume: 1, pan: 0 }, channels: t.channels }));
      const routes = direct ? directMonitorRoutes({ armed, mixes: this.cueMixes, monitoring: this.inputMonitoring, monitorLevel: this.monitorLevel, outputChannels: this.asioOutputChannels, listenId: this.cueListen }) : [];
      this.asioBridge.setMonitorRoutes(routes.length > 0, routes);
      try { window.dispatchEvent(new CustomEvent('nova:direct-monitor', { detail: { routes } })); } catch { /* */ }
    } else {
      this.asioBridge.setMonitor(direct && this.inputMonitoring, this.monitorLevel, this.asioInput ? this.getASIOInputChannel() : -1);
    }
  }

  public setLoop(active: boolean, start: number, end: number) {
    this.isLoopActive = active;
    this.loopStart = start;
    this.loopEnd = end;
  }

  // -------------------------------------------------------------------------
  // Capture audio après coup (R3, utils/audioCapture) : Flashback Capture de Logic
  // -------------------------------------------------------------------------
  // R14 : un anneau par piste armée (deux pour une entrée stéréo), tous sur l'horloge du
  // contexte : la capture de plusieurs pistes ressort alignée à l'échantillon.
  private flashbacks = new Map<string, { nodes: AudioWorkletNode[]; sinks: GainNode[]; extra: AudioNode[]; src: AudioNode; seconds: number }>();
  private flashbackRuns: PlayRun[] = [];
  private flashbackReq = 0;

  /** Anneaux branchés sur les entrées armées (micro ou ASIO) ; ils n'écrivent que pendant la lecture. */
  private async attachFlashback(trackId?: string) {
    const ctx = this.ctx;
    if (!ctx?.audioWorklet) return;
    for (const id of trackId ? [trackId] : this.armedIds()) {
      const tap = this.inputRouter?.tap(id);
      if (!tap) continue;
      if (this.flashbacks.get(id)?.src === tap.out) continue;
      this.detachFlashback(id);
      try {
        await loadFlashbackModule(ctx);
        if (this.inputRouter?.tap(id) !== tap || this.flashbacks.has(id)) continue;   // désarmée / déjà branchée entre-temps
        const seconds = captureMinutes() * 60;
        const capacity = Math.round(seconds * ctx.sampleRate);
        const nodes: AudioWorkletNode[] = [], sinks: GainNode[] = [], extra: AudioNode[] = [];
        const mk = () => {
          const node = new AudioWorkletNode(ctx, 'nova-flashback', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { capacity } });
          const sink = ctx.createGain();
          sink.gain.value = 0;
          node.connect(sink); sink.connect(ctx.destination);
          nodes.push(node); sinks.push(sink);
          return node;
        };
        if (tap.width === 2) {
          const sp = ctx.createChannelSplitter(2);
          tap.out.connect(sp); extra.push(sp);
          sp.connect(mk(), 0); sp.connect(mk(), 1);
        } else tap.out.connect(mk());
        this.flashbacks.set(id, { nodes, sinks, extra, src: tap.out, seconds });
        if (this.isPlaying) {
          const open = this.flashbackRuns.length && this.flashbackRuns[this.flashbackRuns.length - 1].to === null;
          if (open) nodes.forEach(n => n.port.postMessage({ type: 'on' }));
          else this.flashbackRunStart(ctx.currentTime, this.playbackStartTime);
        }
      } catch (e) {
        console.warn('[AudioEngine] Capture après coup indisponible', e);
      }
    }
  }

  private detachFlashback(trackId?: string) {
    for (const id of trackId ? [trackId] : [...this.flashbacks.keys()]) {
      const f = this.flashbacks.get(id);
      if (!f) continue;
      this.flashbacks.delete(id);
      [...f.extra, ...f.nodes].forEach(n => { try { f.src.disconnect(n); } catch { /* déjà débranché */ } });
      f.extra.forEach(n => { try { n.disconnect(); } catch { /* */ } });
      f.nodes.forEach(n => { try { n.disconnect(); } catch { /* */ } retireWorkletNode(n); });
      f.sinks.forEach(n => { try { n.disconnect(); } catch { /* */ } });
    }
    if (!this.flashbacks.size) this.flashbackRuns = [];
  }

  private flashbackPost(msg: Record<string, unknown>) {
    this.flashbacks.forEach(f => f.nodes.forEach(n => n.port.postMessage(msg)));
  }

  private flashbackRunStart(from: number, startTime: number) {
    if (!this.flashbacks.size) return;
    this.flashbackPost({ type: 'on' });
    const m = this.measureRecordLatency();
    this.flashbackRuns.push({ from, to: null, startTime, lat: [m.total] });
    if (this.flashbackRuns.length > 200) this.flashbackRuns.splice(0, this.flashbackRuns.length - 200);
  }

  /** Fin d'un passage ; au bouclage l'écriture continue (le tour suivant commence aussitôt). */
  private flashbackRunEnd(at: number, continues: boolean) {
    if (!this.flashbacks.size) return;
    const last = this.flashbackRuns[this.flashbackRuns.length - 1];
    if (last && last.to === null) last.to = at;
    if (!continues) this.flashbackPost({ type: 'off' });
  }

  /** Capture prête (piste armée et au moins un passage de lecture). */
  public hasFlashback(): boolean {
    const now = this.ctx?.currentTime ?? 0;
    return this.flashbacks.size > 0 && this.flashbackRuns.some(r => (r.to ?? now) - r.from >= 0.5);
  }

  /** Nouvelle durée de capture (réglage) : les anneaux sont recréés à la bonne taille. */
  public resizeFlashback() { if (this.flashbacks.size) { this.detachFlashback(); void this.attachFlashback(); } }

  /** Durée gardée en mémoire (s), 0 sans piste armée. */
  public flashbackSeconds(): number { return this.flashbacks.values().next().value?.seconds ?? 0; }

  /**
   * « Capturer la dernière prise » : ce que le micro a reçu pendant le dernier passage
   * de lecture (sans REC), posé au bon endroit, latence compensée comme une prise.
   * R14 : sur la 1re piste armée (voir captureLastTakes pour toutes).
   */
  public async captureLastTake(): Promise<{ clip: Clip; trackId: string } | { error: string }> {
    const r = await this.captureLastTakes();
    if ('error' in r) return r;
    return r.takes[0];
  }

  /**
   * R14 · Capture après coup de TOUTES les pistes armées : le même passage, la même
   * plage d'échantillons pour chacune (prises alignées), groupées si elles sont plusieurs.
   */
  public async captureLastTakes(): Promise<{ takes: TakeResult[]; group?: string } | { error: string }> {
    const ctx = this.ctx;
    const ids = this.armedIds().filter(id => this.flashbacks.has(id));
    if (!ctx || !ids.length) return { error: "Arme d'abord une piste (bouton R) : NOVA écoute le micro pendant la lecture." };
    if (this.recordingTrackId) return { error: "Une prise est en cours : arrête-la d'abord." };
    const sr = ctx.sampleRate;
    // Plus ancien instant gardé par TOUS les anneaux (le plus récent des plus anciens).
    let oldest: number | null = null;
    for (const id of ids) for (const n of this.flashbacks.get(id)!.nodes) {
      const info = await this.flashbackAsk(n, { type: 'info' });
      if (!info || typeof info.oldest !== 'number') { oldest = null; break; }
      oldest = Math.max(oldest ?? -Infinity, info.oldest / sr);
    }
    const pick = chooseCapture(this.flashbackRuns, ctx.currentTime, oldest);
    if (!pick) return { error: 'Rien à capturer : lance la lecture avec une piste armée et chante, puis capture.' };
    const from = Math.round(pick.from * sr), to = Math.round(pick.to * sr);
    const reads: { id: string; chans: Float32Array[]; firsts: number[] }[] = [];
    for (const id of ids) {
      const chans: Float32Array[] = [], firsts: number[] = [];
      for (const n of this.flashbacks.get(id)!.nodes) {
        const got = await this.flashbackAsk(n, { type: 'read', from, to });
        if (!got?.samples) break;
        chans.push(got.samples); firsts.push(got.firstFrame);
      }
      if (chans.length === this.flashbacks.get(id)!.nodes.length) reads.push({ id, chans, firsts });
    }
    if (!reads.length) return { error: 'Rien à capturer : la lecture était trop courte.' };
    // Plage commune à tous les anneaux : même 1er échantillon, même fin.
    const first = Math.max(...reads.flatMap(r => r.firsts));
    const end = Math.min(...reads.flatMap(r => r.chans.map((c, i) => r.firsts[i] + c.length)));
    if (end - first < sr * 0.3) return { error: 'Rien à capturer : la lecture était trop courte.' };
    // Même placement qu'une prise : position dans le morceau, moins la latence mesurée + le réglage fin.
    const firstCtx = first / sr;
    const run = this.flashbackRuns.filter(r => r.from <= firstCtx + 1e-6).pop();
    const rawStart = firstCtx - (run ? run.startTime : (pick.from - pick.songTime));
    // Même règle qu'une prise : moyenne des latences mesurées pendant le passage, plus le réglage fin.
    const lats = run?.lat?.length ? run.lat : null;
    const measured = lats ? medianOf(lats) : (this.lastLatency || this.measureRecordLatency().total);
    const latency = measured + this.recOffsetMs / 1000;
    const offs = channelOffsets();
    const group = reads.length > 1 ? newTakeGroupId() : undefined;
    const stamp = Date.now();
    const takes: TakeResult[] = [];
    reads.forEach((r, k) => {
      const lat = latency + channelOffsetSec(this.inputRouter?.tap(r.id)?.channels || [], offs);
      let start = rawStart - lat;
      let cut = 0;
      if (start < 0) { cut = Math.round(-start * sr); start = 0; }
      const bodies = r.chans.map((c, i) => c.subarray(first - r.firsts[i] + cut, end - r.firsts[i]));
      if (!bodies[0] || bodies[0].length < sr * 0.2) return;
      const buffer = ctx.createBuffer(bodies.length, bodies[0].length, sr);
      bodies.forEach((b, i) => buffer.copyToChannel(b, i));
      const blob = encodeWav24(bodies.length > 1 ? bodies : bodies[0], sr);
      try { window.dispatchEvent(new CustomEvent('nova:take-aligned', { detail: { ms: Math.round(lat * 1000), sec: lat, raw: rawStart, capture: true, trackId: r.id } })); } catch { /* */ }
      takes.push({
        trackId: r.id, ...(group ? { group } : {}),
        clip: {
          id: k ? `cap-${stamp}-t${k}` : `cap-${stamp}`, name: 'Capture', start, duration: buffer.duration, offset: 0, fadeIn: 0.01, fadeOut: 0.01,
          type: TrackType.AUDIO, color: '#f59e0b', audioRef: URL.createObjectURL(blob), buffer,
        },
      });
    });
    if (!takes.length) return { error: 'Rien à capturer.' };
    return { takes, ...(group && takes.length > 1 ? { group } : {}) };
  }

  private flashbackAsk(node: AudioWorkletNode, msg: Record<string, unknown>): Promise<any> {
    const id = ++this.flashbackReq;
    return new Promise(resolve => {
      const onMsg = (e: MessageEvent) => { if (e.data?.id === id) done(e.data); };
      const timer = setTimeout(() => done(null), 3000);
      function done(v: any) { node.port.removeEventListener('message', onMsg as any); clearTimeout(timer); resolve(v); }
      node.port.addEventListener('message', onMsg as any);
      node.port.start();
      node.port.postMessage({ ...msg, id });
    });
  }

  /**
   * Horloge de lecture (métronome R2, capture audio R3) : instant du contexte où
   * le morceau commence, bouclage déjà programmé, zone de boucle.
   */
  public getClock(): { playing: boolean; startTime: number; wrap: { at: number; prevStart: number } | null; loop: { start: number; end: number } | null } {
    const w = this.pendingLoopWrap;
    return {
      playing: this.isPlaying,
      startTime: this.playbackStartTime,
      wrap: w ? { at: w.atContextTime, prevStart: w.previousStartTime } : null,
      loop: this.isLoopActive && this.loopEnd > this.loopStart ? { start: this.loopStart, end: this.loopEnd } : null,
    };
  }

  // -------------------------------------------------------------------------
  // « Fredonne → MIDI » au micro (V20, components/AudioToMidiDialog)
  // -------------------------------------------------------------------------

  private humTake: {
    stream: MediaStream; src: MediaStreamAudioSourceNode; session: NovaRecorderSession; playStart: number; from: number;
    withBeat: boolean; timer: number; clicks: GainNode; loop: [boolean, number, number];
  } | null = null;

  /**
   * Démarre une prise « Fredonne → MIDI » : une mesure de décompte au clic,
   * puis la voix est captée par l'enregistreur calé (comme une prise
   * normale). `withBeat` (« Fredonner sur le beat ») : le MORCEAU joue,
   * depuis une mesure avant `from` (décompte sur le beat) et pendant toute la
   * prise ; sinon le clic continue seul. La boucle est suspendue le temps de
   * la prise. Renvoie l'instant (horloge) où commence la prise.
   */
  public async startHumTake(stream: MediaStream, tracks: Track[], from: number, bpm: number, beatsPerBar: number, withBeat: boolean): Promise<{ recordAt: number }> {
    await this.init();
    await this.resume();
    const ctx = this.ctx!;
    this.cancelHumTake();
    if (this.isPlaying) this.stopAll();
    await ensureRecorderModule(ctx);
    const src = ctx.createMediaStreamSource(stream);
    const session = new NovaRecorderSession(ctx, src);
    const beat = 60 / Math.max(20, bpm || 120);
    const bars = Math.max(1, Math.round(beatsPerBar || 4));
    const preRoll = beat * bars;
    const loop: [boolean, number, number] = [this.isLoopActive, this.loopStart, this.loopEnd];
    this.isLoopActive = false;
    let countInAt: number, playStart: number;
    if (withBeat) {
      // Pistes pas encore câblées (moteur jamais lancé) : on les câble, sinon la lecture serait muette.
      tracks.forEach(t => { if (!this.tracksDSP.has(t.id)) this.updateTrack(t, tracks); });
      this.startPlayback(from - preRoll, tracks);
      playStart = this.playbackStartTime;
      countInAt = playStart + from - preRoll;
    } else {
      countInAt = ctx.currentTime + 0.15;
      playStart = countInAt - (from - preRoll);
    }
    const clicks = ctx.createGain();
    clicks.connect(ctx.destination);
    // Clic : la mesure de décompte (plus aigu sur le 1er temps), puis seul s'il n'y a pas le beat.
    let k = 0;
    const tick = () => {
      const until = ctx.currentTime + 0.5;
      for (let guard = 0; guard < 64; guard++, k++) {
        const at = countInAt + k * beat;
        const countIn = k < bars;
        if (at >= until || (!countIn && withBeat)) break;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = k % bars === 0 ? 1600 : 1100;
        g.gain.setValueAtTime(countIn ? 0.35 : 0.15, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
        o.connect(g); g.connect(clicks); o.start(at); o.stop(at + 0.06);
      }
    };
    tick();
    const timer = window.setInterval(tick, 100);
    this.humTake = { stream, src, session, playStart, from, withBeat, timer, clicks, loop };
    return { recordAt: countInAt + preRoll };
  }

  /**
   * Fin de la prise « Fredonne → MIDI » : la voix est replacée comme une prise
   * normale (latence de sortie + d'entrée mesurée + réglage fin « Calage des
   * prises ») et rendue à partir de `from`. null : rien de capté.
   */
  public async stopHumTake(): Promise<{ data: Float32Array; sr: number; start: number; latency: number } | null> {
    const h = this.humTake;
    if (!h || !this.ctx) return null;
    this.humTake = null;
    const ctx = this.ctx;
    const latency = this.measureRecordLatency(h.stream).total + this.recOffsetMs / 1000;
    window.clearInterval(h.timer);
    if (h.withBeat) this.stopAll();
    [this.isLoopActive, this.loopStart, this.loopEnd] = h.loop;
    try { h.clicks.disconnect(); } catch { /* */ }
    const { samples, firstFrame } = await h.session.stop(h.src);
    try { h.src.disconnect(); } catch { /* */ }
    h.stream.getTracks().forEach(t => t.stop());
    if (!samples.length || firstFrame < 0) return null;
    const p = placeHumTake(samples, ctx.sampleRate, firstFrame, h.playStart, latency, h.from);
    console.log(`[AudioEngine] Fredonne → MIDI : prise replacée de ${Math.round(latency * 1000)} ms${h.withBeat ? ' (sur le beat)' : ''}`);
    return { data: p.data, sr: ctx.sampleRate, start: p.start, latency };
  }

  /** Abandon de la prise « Fredonne → MIDI » (fenêtre fermée). */
  public cancelHumTake() {
    const h = this.humTake;
    if (!h) return;
    this.humTake = null;
    window.clearInterval(h.timer);
    if (h.withBeat) this.stopAll();
    [this.isLoopActive, this.loopStart, this.loopEnd] = h.loop;
    try { h.clicks.disconnect(); } catch { /* */ }
    void h.session.stop(h.src).catch(() => {});
    h.stream.getTracks().forEach(t => t.stop());
  }

  public isHumTakeActive() { return !!this.humTake; }
  
  public playTestTone() { /* ... */ }

  public async playHighResPreview(url: string, onEnded?: () => void): Promise<void> { 
      await this.init(); 
      if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') await this.ctx.resume(); 
      this.stopPreview(); 
      try { 
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP: ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.ctx!.decodeAudioData(arrayBuffer); 
          this.previewSource = this.ctx!.createBufferSource(); 
          this.previewSource.buffer = audioBuffer; 
          this.previewSource.connect(this.previewGain!); 
          this.previewSource.onended = () => { 
              this.isPreviewPlaying = false; 
              if (onEnded) onEnded();
          }; 
          this.previewSource.start(0); 
          this.isPreviewPlaying = true;
          // Use a ramp to avoid click
          this.previewGain!.gain.setValueAtTime(0, this.ctx!.currentTime);
          this.previewGain!.gain.linearRampToValueAtTime(0.8, this.ctx!.currentTime + 0.01); 
      } catch (e: any) { 
          console.error("[AudioEngine] Preview Error:", e.message); 
          this.isPreviewPlaying = false;
          if (onEnded) onEnded();
          throw e; 
      } 
  }

  public stopPreview() { 
      if (this.previewSource) { 
          this.previewSource.onended = null;
          try { this.previewSource.stop(); this.previewSource.disconnect(); } catch(e) {} 
          this.previewSource = null; 
      } 
      this.isPreviewPlaying = false; 
  }
  
  public getPreviewAnalyzer() { return this.previewAnalyzer; }
  // iOS : l'état peut aussi être « interrupted » (appel, Siri, changement d'app) —
  // ne reprendre que sur « suspended » laissait l'audio muet jusqu'au rechargement.
  public async resume() { if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') { await this.ctx.resume(); } }

  private autoResumeHooked = false;
  /** Reprend le contexte au retour sur la page et au prochain geste de l'utilisateur. */
  private hookAutoResume() {
    if (this.autoResumeHooked || typeof document === 'undefined') return;
    this.autoResumeHooked = true;
    const tryResume = () => {
      const c = this.ctx;
      if (c && c.state !== 'running' && c.state !== 'closed') c.resume().catch(() => { /* attend un geste */ });
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tryResume(); });
    window.addEventListener('pageshow', tryResume);
    document.addEventListener('pointerdown', tryResume, { passive: true });
  }
  
  /**
   * Rendu offline du projet.
   *
   * Reconstruit le graphe COMPLET dans un OfflineAudioContext : chaine de plugins
   * de chaque piste, routage vers les bus, departs (sends) post-fader, pistes MIDI
   * et drum racks. Avant, cette methode se contentait d'additionner les pistes
   * AUDIO avec leur volume et leur pan : le fichier exporte ne contenait aucun
   * effet et ne ressemblait pas a ce qu'on entend dans le studio.
   */
  /**
   * @param options.preFader rendu AVANT fader/pan/automation (gel de piste : le
   *        fader et le pan restent appliques a la lecture, sinon ils l'etaient deux fois).
   * @param options.pluginAutomation avec preFader : l'automation des réglages d'effets
   *        est rejouée quand même (Commit / bounce : le rendu remplace les effets).
   */
  public async renderProject(tracks: Track[], totalDuration: number, startOffset: number = 0, targetSampleRate: number = 44100, onProgress?: (progress: number) => void, options: { preFader?: boolean; keepPreVolume?: boolean; pluginAutomation?: boolean; keepGuides?: boolean } = {}): Promise<AudioBuffer> {
    // Pistes guides (R3) : entendues pendant la prise, jamais dans un export, un master ni un mix auto.
    // (Gel d'une piste, rendu avant fader : la piste elle-même est rendue. Lecture ralentie, R13 : on les entend, comme en lecture.)
    if (!options.preFader && !options.keepGuides) tracks = tracks.filter(t => !t.isGuide);
    // Structure Pro Tools : pistes inactives, dossiers simples et VCA hors du rendu ; Muet / Solo / VCA / bus résolus.
    tracks = engineView(tracks).tracks;
    const totalSamples = Math.ceil(totalDuration * targetSampleRate);
    // Latences et compensations en échantillons entiers : un effet retarde le son d'un
    // nombre entier d'échantillons (lookahead arrondi dans le worklet). Une compensation
    // fractionnaire (3 ms = 132,3 échantillons à 44,1 kHz) faisait interpoler les sources
    // entre deux échantillons : léger filtrage des aigus, et un rendu (commit, bus
    // imprimé) ne retombait plus exactement sur l'export.
    const toSamples = (sec: number) => Math.round(sec * targetSampleRate) / targetSampleRate;
    const offlineCtx = new OfflineAudioContext(2, totalSamples, targetSampleRate);
    // Les noeuds de plugins/instruments n'utilisent que l'API BaseAudioContext.
    const renderCtx = offlineCtx as unknown as AudioContext;

    const masterGain = offlineCtx.createGain();
    masterGain.connect(offlineCtx.destination);

    // Meme regle de solo qu'en lecture live (source unique de verite).
    const soloSilenced = this.computeSoloSilencedIds(tracks);

    interface RenderTrack {
      /** Latence cumulée des effets (s), compensée comme en lecture. */
      latency?: number;
      /** Piste gelee : entree du rendu (apres les effets rendus) et latence des effets restants. */
      frozenInput?: GainNode;
      frozenClipId?: string;
      postLatency?: number;
      /** PDC : sortie principale et envois retardés ; latence en aval de la chaîne (s). */
      outDelay?: DelayNode;
      sendDelays?: Map<string, DelayNode>;
      outputs?: string[];
      down?: number;
      input: GainNode;
      gain: GainNode;
      panner: StereoPannerNode;
      output: GainNode;
      sends: Map<string, GainNode>;
      /** Sortie de la chaîne d'effets, avant le fader (clé de side-chain) ; piste muette / coupée par un solo. */
      pre?: AudioNode;
      /** Mute automatisé (R8), juste après la chaîne : envois pré-fader pris après lui. */
      muteGain?: GainNode;
      silenced?: boolean;
      /** Effets créés pour le rendu (automation de leurs paramètres). */
      pluginNodes?: Map<string, any>;
      /** Latence des effets avant chaque effet (side-chain, R7). */
      pluginOffsets?: Map<string, number>;
      synth?: TrackSynth;
      sampler?: AudioSampler;
      drumRack?: DrumRackNode;
      bass808?: Bass808Node;
      /** Sampler mélodique / instrument multi-échantillons (R18, R20). */
      melodicSampler?: MelodicSamplerNode;
      strip?: StripNodes | null;
    }
    const rendered = new Map<string, RenderTrack>();
    // Certains plugins (AutoTune) s'initialisent de maniere asynchrone : on
    // attend qu'ils soient prets avant de lancer le rendu.
    const pendingPlugins: Promise<unknown>[] = [];

    // Pistes qui reçoivent du son d'autres pistes (sortie ou envoi) : bus, retours d'effets.
    const feeders = new Set<string>();
    tracks.forEach(t => { if (t.outputTrackId) feeders.add(t.outputTrackId); (t.sends || []).forEach(sd => { if (sd.id) feeders.add(sd.id); }); });

    // --- 1. Une chaine par piste : input -> [plugins] -> gain -> panner -> output
    for (const track of tracks) {
      const input = offlineCtx.createGain();
      // Meme regle qu'en lecture : la chaine est stereo des l'entree, sinon une
      // piste mono changeait de niveau selon qu'elle porte un plugin ou non.
      input.channelCount = 2;
      input.channelCountMode = 'explicit';
      input.channelInterpretation = 'speakers';
      // Source muette (valeur 0) branchée pendant tout le rendu : la chaîne reste
      // « active ». Sinon Chrome arrête les filtres (EQ, de-esser…) dès que le
      // dernier clip de la piste est fini et coupe net leur résonance : un léger
      // clic, et un rendu (bounce, commit) ne retombait plus sur l'export.
      const keepAlive = offlineCtx.createConstantSource();
      keepAlive.offset.value = 0;
      keepAlive.connect(input);
      keepAlive.start(0);
      const gain = offlineCtx.createGain();
      const panner = offlineCtx.createStereoPanner();
      const output = offlineCtx.createGain();

      let head: AudioNode = input;
      // Tête de tranche (R11) : trim, Ø, mono, largeur, comme en lecture.
      const strip = buildStrip(offlineCtx, track);
      if (strip) { input.connect(strip.input); head = strip.output; }
      // Piste gelee : meme cablage qu'en lecture (rendu -> effets restants).
      const frozen = isTrackFrozen(track);
      // Bus d'effets gelé : ce qui y entre encore en direct (envoi ajouté ailleurs) passe par ses effets non rendus.
      // Piste vide par construction (aucun clip à jouer, rien n'y entre) : ses effets ne
      // rendraient que du silence (ou le souffle d'un Lo-fi). Le Mix auto pose 8 effets,
      // dont l'Auto-Tune, sur chaque piste voix, même vide : la démo MP3 d'un artiste
      // (1 prise, 4 pistes vides) prenait ~4 min au lieu d'environ 1 (audit UX du 08/10).
      const silentTrack = !frozen && (track.type === TrackType.AUDIO || track.type === TrackType.BUS) && !feeders.has(track.id)
        && !this.getPlayableClips(track, tracks).some(c => !c.isMuted);
      const prePlugins = silentTrack ? [] : frozen ? ((uncoveredClips(track).length > 0 || isFrozenBus(track)) ? preFreezePlugins(track) : []) : (track.plugins || []);
      const postPlugins = frozen ? postFreezePlugins(track) : [];
      let offlineLatency = 0;
      let postLatency = 0;
      let frozenInput: GainNode | undefined;
      const pluginNodes = new Map<string, any>();
      /** Latence des effets avant chaque effet (offset d'une clé de side-chain, R7). */
      const pluginOffsets = new Map<string, number>();
      const addPlugin = (plugin: PluginInstance, isPost: boolean) => {
        // Inactif : absent du rendu (aucune latence). Bypass : contourné, retardé de sa latence (comme en lecture).
        if (plugin.isInactive) return;
        try {
          const entry = this.createPluginNode(plugin, this.currentBpm, renderCtx);
          if (!entry) return;
          const l = entry.node?.latency;
          if (!plugin.isEnabled) {
            try { entry.node?.dispose?.(); } catch { /* */ }
            if (!(typeof l === 'number' && l > 0 && l < 0.5)) return;
            const bd = offlineCtx.createDelay(1);
            bd.delayTime.value = toSamples(l);
            head.connect(bd);
            head = bd;
            offlineLatency += toSamples(l);
            if (isPost) postLatency += toSamples(l);
            return;
          }
          pluginNodes.set(plugin.id, entry.node);
          pluginOffsets.set(plugin.id, offlineLatency);
          if (entry.node?.ready instanceof Promise) pendingPlugins.push(entry.node.ready);
          head.connect(entry.input);
          head = entry.output;
          if (typeof l === 'number' && l > 0 && l < 0.5) {
            offlineLatency += toSamples(l);
            if (isPost) postLatency += toSamples(l);
          }
        } catch (e) {
          console.warn(`[Render] Plugin ignore (${plugin.type}) :`, e);
        }
      };
      prePlugins.forEach(p => addPlugin(p, false));
      if (frozen) {
        frozenInput = offlineCtx.createGain();
        head.connect(frozenInput);
        head = frozenInput;
      }
      postPlugins.forEach(p => addPlugin(p, true));
      // Sortie de la chaîne (clé de side-chain avant fader) -> mute automatisé (R8) -> fader.
      const muteGain = offlineCtx.createGain();
      head.connect(muteGain);
      muteGain.connect(gain);
      const preNode = head;
      gain.connect(panner);
      panner.connect(output);

      // Le solo ne concerne que les pistes sources : un bus ne doit pas etre coupe.
      const silenced = track.isMuted || soloSilenced.has(track.id);
      gain.gain.value = silenced ? 0 : (options.preFader ? 1 : track.volume);
      panner.pan.value = options.preFader ? 0 : track.pan;

      const rt: RenderTrack = {
        input, gain, panner, output, sends: new Map(), latency: offlineLatency, pluginNodes, pluginOffsets, pre: preNode, muteGain, silenced, strip,
        frozenInput, frozenClipId: frozen ? track.frozenClip!.id : undefined, postLatency,
      };

      // Instruments (pistes MIDI / sampler / drum rack)
      if (track.type === TrackType.MIDI && track.melodicSampler) {
        // Sampler mélodique (R18) / instrument multi-échantillons (R20) : mêmes sons qu'en lecture.
        const ms = new MelodicSamplerNode(renderCtx);
        ms.setSettings(track.melodicSampler);
        ms.output.connect(input);
        rt.melodicSampler = ms;
        const live = this.tracksDSP.get(track.id)?.melodicSampler;
        if (live?.hasSound() && this.samplerSigs.get(track.id) === samplerSoundSig(track.melodicSampler)) ms.setZones(live.getZones());
        else pendingPlugins.push(loadSamplerZones(track.melodicSampler, this.ctx || renderCtx).then(z => ms.setZones(z)));
      } else if (track.type === TrackType.MIDI && track.bass808) {
        rt.bass808 = new Bass808Node(renderCtx, track.bass808.style);
        rt.bass808.setGlideTime(track.bass808.glideTime);
        rt.bass808.output.connect(input);
        pendingPlugins.push(rt.bass808.ready);
      } else if (track.type === TrackType.MIDI) {
        rt.synth = makeTrackSynth(renderCtx, track);
        // Chorus du synthé NOVA calé sur le temps du morceau (comme en lecture).
        if (rt.synth instanceof NovaSynthNode) { rt.synth.syncTimeline(-startOffset, 0); pendingPlugins.push(rt.synth.ready); }
        rt.synth.output.connect(input);
      } else if (track.type === TrackType.SAMPLER) {
        rt.sampler = new AudioSampler(renderCtx, this.currentBpm);
        const liveBuffer = this.tracksDSP.get(track.id)?.sampler?.getBuffer();
        if (liveBuffer) rt.sampler.loadBuffer(liveBuffer);
        rt.sampler.output.connect(input);
      } else if (track.type === TrackType.DRUM_RACK) {
        rt.drumRack = new DrumRackNode(renderCtx);
        if (track.drumPads) rt.drumRack.updatePadsState(track.drumPads);
        // Les buffers des pads ne sont pas conserves dans l'etat du projet :
        // on les reprend sur le drum rack live.
        const liveRack = this.tracksDSP.get(track.id)?.drumRack;
        if (liveRack) {
          liveRack.getBuffers().forEach((buf, padId) => rt.drumRack!.loadSample(padId, buf));
        }
        rt.drumRack.output.connect(input);
      }

      rendered.set(track.id, rt);
    }

    // --- 2. Routage : sortie de piste -> bus/master, et departs post-fader
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;
      const destId = track.outputTrackId;
      const dest = destId && destId !== track.id ? rendered.get(destId) : undefined;
      // Part déjà jouée depuis le rendu du bus VST gelé (tranches) : pas d'envoi direct en plus.
      rt.outputs = [];
      rt.sendDelays = new Map();
      if (!(dest && isFeedCovered(track, destId, tracks)) && destId !== VOID_OUTPUT) {
        // PDC : même alignement qu'en lecture (retard réglé après le câblage).
        rt.outDelay = offlineCtx.createDelay(PDC_MAX_SECONDS);
        rt.output.connect(rt.outDelay);
        rt.outDelay.connect(dest ? dest.input : masterGain);
        rt.outputs.push(dest ? destId! : '');
      }

      (track.sends || []).forEach(send => {
        // Un envoi à zéro mais automatisé doit exister à l'export (comme en lecture).
        const autoSend = playedLanes(track).some(l => l.parameterName === `send::${send.id}` && l.points.length > 0);
        if (!send.id || !send.isEnabled || (send.level <= 0 && !autoSend)) return;
        if (send.id === track.id) return;
        if (isFeedCovered(track, send.id, tracks)) return;
        const target = rendered.get(send.id);
        if (!target) return;
        const sendGain = offlineCtx.createGain();
        // Pré-fader : après les effets, sans le fader ni le pan (la piste muette coupe quand même l'envoi).
        // Envoi muet (Pro Tools) : câblé mais à zéro.
        sendGain.gain.value = (send.preFader && rt.silenced) || send.isMuted ? 0 : send.level;
        const ownPan = typeof send.pan === 'number';
        (send.preFader && rt.pre ? (rt.muteGain || rt.pre) : (ownPan ? rt.gain : rt.panner)).connect(sendGain);
        const sendDelay = offlineCtx.createDelay(PDC_MAX_SECONDS);
        if (ownPan) {
          const sp = offlineCtx.createStereoPanner();
          sp.pan.value = Math.max(-1, Math.min(1, send.pan!));
          sendGain.connect(sp);
          sp.connect(sendDelay);
        } else sendGain.connect(sendDelay);
        sendDelay.connect(target.input);
        rt.sendDelays!.set(send.id, sendDelay);
        rt.outputs!.push(send.id);
        rt.sends.set(send.id, sendGain);
      });
    }

    // --- 2-SC. Side-chain (R7) : clé = sortie de la chaîne (ou fader) de la source, filtrée, vers l'effet à clé.
    const offlineKeys: { route: KeyRoute; path: KeyPath }[] = [];
    for (const r of keyRoutes(tracks)) {
      const node = rendered.get(r.targetTrackId)?.pluginNodes?.get(r.pluginId);
      if (!isKeyedNode(node)) continue;
      const srcs = r.sources.filter(sid => rendered.has(sid));
      if (!srcs.length) continue;
      const path = new KeyPath(offlineCtx);
      path.setFilters(r.hpf, r.lpf);
      srcs.forEach(sid => { const rs = rendered.get(sid)!; path.setSource(sid, r.tap === 'post' ? rs.gain : (rs.pre || rs.input)); });
      path.connectTo(node.sidechainInput);
      node.setSidechainActive!(true);
      offlineKeys.push({ route: { ...r, sources: srcs }, path });
    }

    // --- 2-PDC. Compensation de latence (bus, envois, clés de side-chain) : mêmes règles qu'en lecture.
    {
      const nodes = new Map<string, PdcNode>();
      const routesR = offlineKeys.map(k => k.route);
      rendered.forEach((rt, id) => nodes.set(id, {
        latency: rt.latency || 0, outputs: rt.outputs || [],
        ...(routesR.length ? { keys: pdcKeysFor(routesR, id, (tid, pid) => rendered.get(tid)?.pluginOffsets?.get(pid) || 0) } : {}),
      }));
      const pdc = computePdc(nodes);
      offlineKeys.forEach(({ route, path }) => route.sources.forEach(sid => {
        const d = path.delayOf(sid);
        if (d) d.delayTime.value = toSamples(pdc.get(sid)?.keyDelays.get(route.pluginId) ?? 0);
      }));
      rendered.forEach((rt, id) => {
        const r = pdc.get(id);
        rt.down = r?.down || 0;
        const main = rt.outDelay ? rt.outputs?.[0] : undefined;
        if (rt.outDelay && r && main !== undefined) rt.outDelay.delayTime.value = toSamples(r.delays.get(main) ?? r.down);
        rt.sendDelays?.forEach((node, sendId) => { node.delayTime.value = toSamples(r?.delays.get(sendId) ?? 0); });
      });
      // Effets calés sur le morceau (gate rythmique) : temps 0 du rendu = startOffset du morceau.
      rendered.forEach(rt => { if (rt.pluginNodes) this.syncChainTimeline([...rt.pluginNodes.values()], -startOffset, rt.down || 0); });
    }

    // --- 2a. Batterie Make Music : mix par pad (effets + envois) aussi à l'export
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;
      if (track.type !== TrackType.DRUM_RACK || !track.drumMachine || !rt.drumRack) continue;
      const bank = new DrumPadFxBank(offlineCtx, rt.drumRack, (pl, c) => this.createPluginNode(pl, this.currentBpm, c as AudioContext));
      bank.configure(track.drumMachine.rows, id => rendered.get(id)?.input, track.isMuted ? 0 : track.volume);
      pendingPlugins.push(...bank.readyPromises());
    }

    // --- 2b. Automation (apres le cablage des departs, qu'elle peut piloter)
    // Elle etait purement ignoree au rendu : volume et pan restaient figes sur
    // leur valeur de piste, donc un fondu automatise disparaissait a l'export.
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;
      if (track.isMuted || soloSilenced.has(track.id)) continue;
      // Gel : volume/pan appliqués à la lecture ; le volume avant effets seulement si demandé (export).
      if (options.preFader && !options.keepPreVolume) continue;

      playedLanes(track).forEach(lane => {
        if (options.preFader && lane.parameterName !== PRE_VOLUME) return;
        if (isMuteParam(lane.parameterName)) {
          // Mute automatisé (R8) : en paliers, calé sur la musique (avance PDC aval de la piste).
          if (rt.muteGain && lane.points.length) this.programmerVoieHorsLigne(rt.muteGain.gain, muteGainPoints(lane.points), startOffset + toSamples(rt.down || 0), totalDuration);
          return;
        }
        const cible = this.cibleAutomation(lane.parameterName, rt.gain.gain, rt.panner.pan, rt.sends, (rt.frozenInput || rt.input).gain, rt.strip);
        if (!cible || !lane.points || lane.points.length === 0) return;

        const points = [...lane.points].sort((a, b) => a.time - b.time);
        // Le rendu peut demarrer au milieu d'un segment (export d'une boucle).
        cible.setValueAtTime(this.valeurAutomationA(points, startOffset), 0);

        points.forEach((pt, i) => {
          const suivant = points[i + 1];
          const tPoint = pt.time - startOffset;
          if (tPoint >= 0 && tPoint <= totalDuration) cible.setValueAtTime(pt.value, tPoint);
          if (!suivant) return;
          const tSuivant = suivant.time - startOffset;
          if (tSuivant <= 0 || tPoint >= totalDuration) return;
          this.programmerSegment(cible, pt, suivant, Math.max(0, tPoint), Math.min(totalDuration, tSuivant));
        });
      });
    }

    // --- 3. Comptage pour la progression
    let processedClips = 0;
    let totalClips = 0;
    tracks.forEach(track => {
      totalClips += this.getPlayableClips(track, tracks).filter(c => !c.isMuted).length;
    });

    // --- 4. Clips audio (toutes les pistes qui en portent, bus et sends inclus)
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;

      for (const clip of this.getPlayableClips(track, tracks)) {
        if (clip.isMuted) continue;
        if (clip.type === TrackType.MIDI) continue; // traite plus bas

        let buffer = clip.buffer;
        if (!buffer && clip.bufferId) buffer = audioBufferRegistry.get(clip.bufferId);
        if (!buffer) {
          console.warn(`[Render] Buffer introuvable pour le clip ${clip.id}`);
          continue;
        }

        const isFrozenRender = !!rt.frozenInput && (clip.id === rt.frozenClipId || !!clip.isFreezeSlice);
        const clipStartInProject = clip.start - startOffset - toSamples(((isFrozenRender ? rt.postLatency : rt.latency) || 0) + (rt.down || 0));
        if (clipStartInProject + clip.duration < 0) continue;
        if (clipStartInProject > totalDuration) continue;

        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;

        const clipGain = offlineCtx.createGain();
        clipGain.gain.value = clip.gain ?? 1.0;

        source.connect(clipGain);
        clipGain.connect(isFrozenRender ? rt.frozenInput! : rt.input);

        const playOffset = clip.offset || 0;
        const startTime = Math.max(0, clipStartInProject);
        const offsetIntoClip = clipStartInProject < 0 ? -clipStartInProject + playOffset : playOffset;
        // Export d'une boucle qui commence au milieu du clip : il ne reste que la fin du clip à jouer.
        const playedSoFar = Math.max(0, offsetIntoClip - playOffset);
        const remainingDuration = Math.min(clip.duration - playedSoFar, totalDuration - startTime, buffer.duration - offsetIntoClip);

        if (remainingDuration > 0 && offsetIntoClip < buffer.duration) {
          // Fondus et crossfades : même plan de gain qu'en lecture (utils/fades),
          // calé sur la position réelle dans le clip (export d'une boucle compris).
          applyGainEvents(clipGain.gain, clipGainEvents(clip, playedSoFar), startTime - playedSoFar);
          source.start(startTime, offsetIntoClip, remainingDuration);
        }

        processedClips++;
        if (onProgress) onProgress(Math.round((processedClips / Math.max(1, totalClips)) * 80));
      }
    }

    // --- 5. Clips MIDI : on rejoue les notes sur l'instrument de la piste
    // (sampler mélodique : après le chargement de ses sons, plus bas).
    const playMidiOffline = (track: Track) => {
      const rt = rendered.get(track.id)!;
      if (!rt.synth && !rt.sampler && !rt.drumRack && !rt.melodicSampler) return;
      // Piste gelee : seules les notes ajoutees apres le rendu sont rejouees.
      for (const clip of (isTrackFrozen(track) ? uncoveredClips(track) : (track.clips || []))) {
        if (clip.isMuted || clip.type !== TrackType.MIDI || !clip.notes) continue;

        // PDC : notes avancées de la latence de tout le chemin (comme en lecture).
        const lat = toSamples((rt.latency || 0) + (rt.down || 0));
        const heard = playableNotes(clip);
        for (const note of (rt.synth instanceof NovaSynthNode ? notesInTimeOrder(heard) : heard)) {
          const noteStart = clip.start + note.start - startOffset - lat;
          const noteEnd = noteStart + note.duration;
          if (noteEnd <= 0 || noteStart >= totalDuration) continue;

          const attackAt = Math.max(0, noteStart);
          const releaseAt = Math.min(totalDuration, noteEnd);

          if (rt.synth) {
            rt.synth.triggerAttack(note.pitch, note.velocity, attackAt);
            rt.synth.triggerRelease(note.pitch, releaseAt);
          } else if (rt.sampler) {
            rt.sampler.triggerAttack(note.pitch, note.velocity, attackAt);
            rt.sampler.triggerRelease(note.pitch, releaseAt);
          } else if (rt.drumRack) {
            rt.drumRack.trigger(note.pitch, note.velocity, attackAt, note);
          } else if (rt.melodicSampler) {
            rt.melodicSampler.triggerAttack(note.pitch, note.velocity, attackAt, note);
            rt.melodicSampler.triggerRelease(note.pitch, releaseAt);
          }
        }
        processedClips++;
        if (onProgress) onProgress(Math.round((processedClips / Math.max(1, totalClips)) * 80));
      }
      // Contrôleurs MIDI (R16) : pitch bend, modulation, expression… mêmes instants qu'en lecture.
      const ctlTarget = rt.synth || rt.melodicSampler;
      if (ctlTarget) this.scheduleOfflineControllers(track, ctlTarget, startOffset + toSamples((rt.latency || 0) + (rt.down || 0)), totalDuration);
    };
    for (const track of tracks) if (!rendered.get(track.id)!.melodicSampler) playMidiOffline(track);

    if (pendingPlugins.length > 0) {
      await Promise.all(pendingPlugins.map(pr => pr.catch(() => undefined)));
    }
    // --- 5a. Sampler mélodique / instruments (R18, R20) : sons chargés, notes jouées.
    for (const track of tracks) if (rendered.get(track.id)!.melodicSampler) playMidiOffline(track);

    // --- 5b. 808 : plan monophonique (glissés), une fois son son prêt
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;
      if (!rt.bass808 || !track.bass808) continue;
      const clips = isTrackFrozen(track) ? uncoveredClips(track) : (track.clips || []);
      rt.bass808.playVoices(planOfClips(clips, track.bass808), startOffset + toSamples((rt.latency || 0) + (rt.down || 0)));
    }

    // --- 5c. Automation des paramètres d'effets : mêmes valeurs qu'en lecture.
    if (!options.preFader || options.pluginAutomation) this.scheduleOfflinePluginAutomation(offlineCtx, tracks, rendered, totalDuration, startOffset);
    // --- 5d. Piste d'accords suivie par l'Harmoniseur (gel compris : elle fait partie du son de la piste).
    this.scheduleOfflineChords(tracks, rendered, totalDuration, startOffset);

    if (onProgress) onProgress(85);

    try {
      const renderedBuffer = await offlineCtx.startRendering();
      if (onProgress) onProgress(100);
      return renderedBuffer;
    } catch (error) {
      console.error('[AudioEngine] Render failed:', error);
      return offlineCtx.createBuffer(2, totalSamples, targetSampleRate);
    }
  }

  /**
   * Arme une piste pour l'enregistrement.
   * @returns null si tout va bien, sinon un message explicable a l'utilisateur.
   *
   * L'echec etait avale : micro refuse ou absent, la methode se contentait d'un
   * message en console. L'interface affichait la piste armee, puis
   * l'enregistrement echouait sans rien dire.
   */
  public async armTrack(trackId: string, opts: { spec?: RecordInput | null; alone?: boolean } = {}): Promise<string | null> {
    if (!this.ctx) await this.init();
    if (this.ctx!.state !== 'running' && this.ctx!.state !== 'closed') await this.ctx!.resume();
    if (opts.spec !== undefined) this.armedSpecs.set(trackId, opts.spec);
    else if (!this.armedSpecs.has(trackId)) this.armedSpecs.set(trackId, null);
    // Armements à la suite (plusieurs pistes d'un coup) : un à la fois, dans l'ordre.
    const prev = this.armingPromise || Promise.resolve();
    const p: Promise<void> = prev.catch(() => {}).then(() => this._armTrackInternal(trackId, !!opts.alone));
    this.armingPromise = p;
    try { await p; } finally { if (this.armingPromise === p) this.armingPromise = null; }
    const erreur = this.armErrors.get(trackId) ?? null;
    this.armErrors.delete(trackId);
    return erreur;
  }

  private async _armTrackInternal(trackId: string, alone: boolean) {
    // Maj+clic (ou armement exclusif) : la piste seule.
    if (alone) for (const id of this.armedIds()) if (id !== trackId) this.disarmTrack(id);
    let dsp = this.tracksDSP.get(trackId);
    let attempts = 0;
    while (!dsp && attempts < 10) {
      await new Promise(r => setTimeout(r, 15)); // 15ms entre checks
      dsp = this.tracksDSP.get(trackId);
      attempts++;
    }
    if (!dsp) {
      console.error("[AudioEngine] ARM FAILED - No DSP for track:", trackId);
      this.armErrors.set(trackId, "Piste indisponible pour l'enregistrement.");
      return;
    }
    try {
      await this.ensureInputSource(trackId);
      const spec = this.armedSpecs.get(trackId) ?? null;
      const tap = this.inputRouter!.arm(trackId, spec, dsp.input, dsp.inputAnalyzer, this.monitorGainFor());
      this.monitoringTrackId = trackId;
      void this.attachFlashback(trackId);
      this.setTrackLowLatency(trackId, true);
      this.syncDirectMonitor();
      if (!this.latencyTimer) this.startLatencyWatch();
      this.reportMissingInput(tap);
      console.log("[AudioEngine] Track armed OK:", trackId, tap.channels);
    } catch (e: any) {
      console.error("[AudioEngine] ARM ERROR:", e);
      this.inputRouter?.disarm(trackId);
      this.armedSpecs.delete(trackId);
      if (!this.inputRouter?.size) this.closeInputSource();
      // On traduit les cas courants plutot que de renvoyer un nom technique.
      const nom = e?.name || '';
      if (nom === 'NotAllowedError' || nom === 'SecurityError') {
        this.armErrors.set(trackId, "Micro refusé. Autorisez-le dans votre navigateur puis réessayez.");
      } else if (nom === 'NotFoundError' || nom === 'OverconstrainedError') {
        this.armErrors.set(trackId, "Aucun micro détecté. Branchez-en un puis réessayez.");
      } else if (nom === 'NotReadableError') {
        this.armErrors.set(trackId, "Micro déjà utilisé par une autre application.");
      } else {
        this.armErrors.set(trackId, `Micro inaccessible : ${e?.message || 'erreur inconnue'}`);
      }
    }
  }

  /** Entrée demandée absente de la source : l'appli l'explique (utils/multiRecord.inputsMessage). */
  private reportMissingInput(tap: InputTap) {
    if (!tap.missing) return;
    const info = this.getInputInfo();
    try { window.dispatchEvent(new CustomEvent('nova:input-missing', { detail: { trackId: tap.trackId, channels: tap.channels, available: info.available, mode: info.mode } })); } catch { /* */ }
  }

  /**
   * Source d'entrée partagée par les pistes armées : toutes les entrées de la carte
   * (pont ASIO), sinon le micro du navigateur, ouvert avec autant de canaux que les
   * pistes en demandent (multicanal quand le navigateur le permet).
   */
  private async ensureInputSource(forTrack?: string): Promise<void> {
    if (!this.ctx) return;
    const router = this.inputRouter || (this.inputRouter = new InputRouter(this.ctx));
    if (this.asioStreamActive && this.asioConnected) {
      const asio = this.ensureASIOInput();
      if (!asio) return;
      const node = await asio.whenReady();
      const cur = router.getSource();
      if (cur?.node !== node || cur.autoChannel !== this.getASIOInputChannel()) {
        if (this.recordingTrackId && cur) return;      // jamais pendant une prise
        const oldStream = this.activeMonitorStream, oldSrc = this.monitorSource;
        this.activeMonitorStream = await asio.getStream();
        this.monitorSource = null;
        router.setSource({ node, output: 1, channels: asio.channels, kind: 'asio', autoChannel: this.getASIOInputChannel() });
        try { oldSrc?.disconnect(); } catch { /* */ }
        if (oldStream && oldStream !== this.activeMonitorStream) this.stopInputStream(oldStream);
        console.log('[AudioEngine] Entrée ASIO utilisée pour les pistes armées :', asio.channels, 'entrées');
      }
      return;
    }
    const specs = [...this.armedSpecs.entries()].filter(([id]) => id === forTrack || router.has(id)).map(([, s]) => s);
    const need = neededInputChannels(specs);
    const cur = router.getSource();
    if (cur?.kind === 'navigateur' && this.activeMonitorStream && this.activeMonitorStream.getAudioTracks().some(t => t.readyState === 'live')) {
      // Assez de canaux, ou le navigateur n'en donnera pas plus : on garde le flux ouvert.
      if (cur.channels >= need || (this.browserMaxChannels > 0 && this.browserMaxChannels <= cur.channels)) return;
      if (this.recordingTrackId) return;
    }
    // Le peripherique choisi dans les reglages audio n'etait jamais transmis :
    // l'enregistrement utilisait toujours l'entree par defaut du systeme.
    const base: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const constraints: MediaTrackConstraints = { ...base, ...(need > 2 ? { channelCount: { ideal: need } } : {}) };
    if (this.currentInputDeviceId && this.currentInputDeviceId !== 'default') constraints.deviceId = { exact: this.currentInputDeviceId };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (deviceError) {
      // Peripherique debranche ou refuse : on retombe sur l'entree par defaut
      // plutot que d'echouer completement l'armement.
      console.warn("[AudioEngine] Entree demandee indisponible, repli sur le peripherique par defaut", deviceError);
      stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }
    const track = stream.getAudioTracks()[0];
    let channels = 0;
    try { channels = Number((track?.getSettings() as any)?.channelCount) || 0; } catch { /* */ }
    try { const max = Number((track as any)?.getCapabilities?.()?.channelCount?.max); if (max > 0) this.browserMaxChannels = max; } catch { /* */ }
    const src = this.ctx.createMediaStreamSource(stream);
    if (!channels) channels = src.channelCount || 2;
    if (!this.browserMaxChannels) this.browserMaxChannels = channels;
    const oldStream = this.activeMonitorStream, oldSrc = this.monitorSource;
    this.activeMonitorStream = stream;
    this.monitorSource = src;
    router.setSource({ node: src, output: 0, channels: Math.max(1, channels), kind: 'navigateur', autoChannel: -1 });
    try { oldSrc?.disconnect(); } catch { /* */ }
    if (oldStream && oldStream !== stream) this.stopInputStream(oldStream);
  }

  /** Plus aucune piste armée : le micro est fermé (le flux de la carte, partagé, reste). */
  private closeInputSource() {
    this.inputRouter?.setSource(null);
    if (this.monitorSource) { try { this.monitorSource.disconnect(); } catch { /* */ } this.monitorSource = null; }
    if (this.activeMonitorStream) { this.stopInputStream(this.activeMonitorStream); this.activeMonitorStream = null; }
  }

  /** La source a changé (flux de la carte démarré / arrêté) : les pistes armées suivent. */
  private async refreshInputSource() {
    if (!this.inputRouter?.size || this.recordingTrackId) return;
    try {
      await this.ensureInputSource();
      this.inputRouter.all().forEach(t => this.reportMissingInput(t));
      this.syncDirectMonitor();
    } catch (e) { console.warn('[AudioEngine] Entrée non rouverte', e); }
  }

  /**
   * R14 · Entrée physique d'une piste (Track.recordInput). Piste armée : recâblée tout
   * de suite (pas pendant une prise : la piste garde son entrée jusqu'à l'arrêt).
   */
  public async setTrackInput(trackId: string, spec: RecordInput | null): Promise<void> {
    const before = this.armedSpecs.get(trackId);
    this.armedSpecs.set(trackId, spec);
    if (!this.inputRouter?.has(trackId) || this.recordingTrackIds.includes(trackId)) return;
    if (JSON.stringify(before ?? null) === JSON.stringify(spec ?? null)) return;
    await this.ensureInputSource(trackId);
    const old = this.inputRouter.tap(trackId);
    const tap = this.inputRouter.setSpec(trackId, spec);
    if (tap && tap !== old) { this.detachFlashback(trackId); void this.attachFlashback(trackId); }
    this.syncDirectMonitor();
    if (tap) this.reportMissingInput(tap);
  }

  /** Active / coupe le retour du micro dans le casque. */
  public setInputMonitoring(on: boolean) {
    this.inputMonitoring = on;
    this.syncDirectMonitor();
    try { window.dispatchEvent(new CustomEvent('nova:monitoring', { detail: on })); } catch { /* */ }
  }

  /** Volume du retour casque (la prise enregistrée n'est pas affectée). */
  public setMonitorLevel(level: number) {
    this.monitorLevel = Math.min(2, Math.max(0, level));
    try { localStorage.setItem('nova_monitor_level', String(this.monitorLevel)); } catch { /* */ }
    this.syncDirectMonitor();
    try { window.dispatchEvent(new CustomEvent('nova:monitor-level', { detail: this.monitorLevel })); } catch { /* */ }
  }

  public getMonitorLevel() { return this.monitorLevel; }

  public isInputMonitoring() { return this.inputMonitoring; }

  /** Tracks armées : leurs effets tournent en mode basse latence. */
  private lowLatencyTracks = new Set<string>();

  /**
   * Gel temporaire le temps d'une prise : les pistes aux effets lourds (VST3 du
   * pont, Auto-Tune haute qualité…) sont lues depuis un rendu, sans latence.
   * Rien n'est écrit dans le projet : c'est une surcouche du moteur.
   */
  private recFreezes = new Map<string, { clip: Clip; upTo: number; clipIds: string[] }>();
  /** Compensation de latence suspendue pendant une prise (pistes figées : inutile). */
  private pdcSuspended = false;
  /** Début du passage en cours (lecture ou bouclage) : 1re fenêtre MIDI (PDC). */
  private midiRunStart: number | null = null;
  /** Dernier retard PDC demandé par nœud (delayTime.value est en retard d'un rendu). */
  private pdcSet = new WeakMap<DelayNode, number>();
  /** Side-chain (R7) : clés câblées en lecture (engine/sidechain.ts). */
  private sidechain = new SidechainRouter(() => this.ctx);

  public setRecordingFreeze(trackId: string, freeze: { clip: Clip; upTo: number; clipIds: string[] } | null) {
    if (freeze) this.recFreezes.set(trackId, freeze); else this.recFreezes.delete(trackId);
    const dsp = this.tracksDSP.get(trackId);
    if (dsp) dsp.graphSignature = undefined; // recâblage au prochain updateTrack
  }

  public setDelayCompensationSuspended(on: boolean) { this.pdcSuspended = on; this.recomputePdc(); }

  /** Latence (s) de chaque effet actif d'une piste, dans l'ordre de la chaîne. */
  public getTrackPluginLatencies(trackId: string): Map<string, number> {
    const out = new Map<string, number>();
    const dsp = this.tracksDSP.get(trackId);
    dsp?.pluginChain.forEach((entry, id) => {
      const l = entry.instance?.latency;
      out.set(id, typeof l === 'number' && l > 0 ? l : 0);
    });
    return out;
  }

  /** Latence compensée d'une piste jusqu'au master (effets de la piste + bus et envois en aval), en s. */
  public getTrackLatency(trackId: string): number {
    const d = this.tracksDSP.get(trackId);
    return d ? (d.pluginLatency || 0) + (d.downLatency || 0) : 0;
  }

  /** Piste telle que le moteur la joue (avec un éventuel gel de prise). */
  private eff(track: Track): Track {
    const f = this.recFreezes.get(track.id);
    if (!f || isTrackFrozen(track)) return track;
    // Gel le temps d'une prise : rendu entier (ancien modèle), clips non ancrés.
    return { ...track, isFrozen: true, frozenClip: f.clip, frozenUpToPluginIndex: f.upTo, frozenClipIds: f.clipIds, frozenPluginSig: undefined };
  }

  /**
   * Bascule les effets d'une piste en mode basse latence (piste armée) ou
   * pleine qualité, puis recalcule la compensation de lecture de la piste.
   * La compensation ne retarde jamais l'entrée micro : elle n'avance que la
   * lecture des prises déjà enregistrées.
   */
  private setTrackLowLatency(trackId: string, on: boolean) {
    if (on) this.lowLatencyTracks.add(trackId); else this.lowLatencyTracks.delete(trackId);
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return;
    let total = 0;
    dsp.pluginChain.forEach(entry => {
      const inst = entry.instance;
      // Effets VST3 du pont : impossible sans latence, ils sont contournés tant
      // que la piste est armée (retour casque sans retard).
      if (inst instanceof VSTPluginNode) inst.setMonitorBypass(on);
      else if (inst && typeof inst.updateParams === 'function' && 'latency' in inst) {
        try { inst.updateParams({ lowLatency: on }); } catch { /* effet sans ce mode */ }
      }
    });
    this.recomputeTrackLatency(trackId);
  }

  /**
   * Latence de compensation d'une piste : effets actifs de la chaine. Piste
   * gelee : le clip gele ne traverse que les effets restants (postFreezeLatency).
   */
  private recomputeTrackLatency(trackId: string) {
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return;
    const lat = (id: string) => {
      const l = dsp.pluginChain.get(id)?.instance?.latency;
      return (typeof l === 'number' && l > 0 && l < 0.5) ? l : 0;
    };
    const ids = dsp.chainIds || [];
    const postIds = dsp.postChainIds || [];
    dsp.pluginLatency = ids.reduce((acc, id) => acc + lat(id), 0);
    dsp.postFreezeLatency = postIds.reduce((acc, id) => acc + lat(id), 0);
    // Effets en bypass : leur retard suit leur latence (chargement d'un VST, piste armée…).
    const tNow = this.ctx?.currentTime || 0;
    ids.forEach(id => {
      const bd = dsp.pluginChain.get(id)?.bypassDelay;
      if (!bd) return;
      const v = lat(id);
      if (Math.abs((this.pdcSet.get(bd) ?? -1) - v) <= 1e-9) return;
      this.pdcSet.set(bd, v);
      bd.delayTime.cancelScheduledValues(tNow);
      bd.delayTime.setValueAtTime(v, tNow);
    });
    this.recomputePdc();
  }

  /**
   * Compensation de latence de toute la session (pistes, bus, envois), comme
   * dans les DAW : retards des sorties plus courtes + avance des clips.
   * Suspendue pendant une prise (retour casque sans retard).
   */
  private recomputePdc() {
    if (!this.ctx) return;
    const nodes = new Map<string, PdcNode>();
    // Clés de side-chain (R7) : traitées comme des sorties de la piste source (alignées sur l'effet à clé).
    const routes = this.sidechain.current();
    this.tracksDSP.forEach((d, id) => nodes.set(id, {
      latency: this.pdcSuspended ? 0 : (d.pluginLatency || 0), outputs: d.outputs || [],
      ...(routes.length ? { keys: pdcKeysFor(routes, id, (tid, pid) => this.keyOffset(tid, pid)) } : {}),
    }));
    const res = computePdc(nodes);
    const t = this.ctx.currentTime;
    const setDelay = (node: DelayNode | undefined, sec: number) => {
      if (!node) return;
      const v = this.pdcSuspended ? 0 : sec;
      // Comparer à la DERNIÈRE valeur demandée, pas à delayTime.value : celle-ci
      // n'est mise à jour qu'au rendu suivant, et une correction rapide (latence
      // connue juste après le câblage) était sautée (mesuré : envoi reverb +30 ms).
      if (Math.abs((this.pdcSet.get(node) ?? -1) - v) <= 1e-9) return;
      this.pdcSet.set(node, v);
      node.delayTime.cancelScheduledValues(t);
      node.delayTime.setValueAtTime(v, t);
    };
    this.tracksDSP.forEach((d, id) => {
      const r = res.get(id);
      d.downLatency = this.pdcSuspended || !r ? 0 : r.down;
      const main = d.outputs?.[0];
      setDelay(d.outDelay, r && main !== undefined ? (r.delays.get(main) ?? r.down) : 0);
      d.sendDelays?.forEach((node, sendId) => setDelay(node, r?.delays.get(sendId) ?? 0));
    });
    this.sidechain.applyDelays(res, setDelay, this.pdcSuspended);
    // Latences changées (effet ajouté, gel de prise…) : l'avance des gates aussi.
    this.resyncTimelineEffects();
  }

  /** Latence (s) des effets placés avant un effet à clé sur sa piste (offset de la clé, PDC). */
  private keyOffset(trackId: string, pluginId: string): number {
    if (this.pdcSuspended) return 0;
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return 0;
    return latencyBefore(dsp.chainIds || [], pluginId, id => dsp.pluginChain.get(id)?.instance?.latency);
  }

  /**
   * Side-chain (R7) : câble les clés des effets (prise « pre » = sortie de la
   * chaîne de la source, avant son mute et son fader ; « post » = après le
   * fader). Idempotent : appelé à chaque mise à jour de piste (un recâblage de
   * la source coupe ses sorties, il est réparé ici). PDC refaite si la
   * topologie des clés change.
   */
  private syncSidechains(allTracks: Track[]) {
    const routes = keyRoutes(allTracks);
    if (!routes.length && !this.sidechain.current().length) return;
    const changed = this.sidechain.sync(routes,
      (tid, pid) => this.tracksDSP.get(tid)?.pluginChain.get(pid)?.instance,
      (tid, tap) => { const d = this.tracksDSP.get(tid); return d ? (tap === 'post' ? d.gain : (d.chainOut || null)) : null; });
    if (changed) this.recomputePdc();
  }

  /**
   * Écriture d'automation (R9) : sur une piste en Touch, Latch, Write ou Trim, le pont
   * signale les réglages bougés dans la fenêtre de ses VST (enregistrés dans la voie).
   */
  private syncVstWatch(track: Track, dsp: TrackDSP) {
    const on = isWriteMode(automationModeOf(track));
    dsp.pluginChain.forEach(entry => { if (entry.instance instanceof VSTPluginNode) entry.instance.setWatch(on); });
  }

  /** Effet à clé : chemin de sa clé en lecture (mesures, QA). */
  public getSidechainPath(pluginId: string): KeyPath | null { return this.sidechain.pathOf(pluginId); }

  /**
   * Effets calés sur la ligne de temps du morceau (gate rythmique) d'une chaîne :
   * chacun reçoit l'origine du morceau MOINS son avance de compensation (latence
   * des effets qui le suivent + retard aval du bus), comme l'automation (pluginLead).
   */
  private syncChainTimeline(nodes: any[], origin: number, down: number, at?: number, pdc = true) {
    let acc = down;
    for (let k = nodes.length - 1; k >= 0; k--) {
      const n = nodes[k];
      if (n?.followsTimeline && typeof n.syncTimeline === 'function') n.syncTimeline(origin - acc, at);
      const l = n?.latency;
      if (pdc && typeof l === 'number' && l > 0 && l < 0.5) acc += l;
    }
  }

  /** Toutes les pistes en lecture : `origin` = instant du contexte où le morceau commence. */
  private syncTimelineEffects(origin: number, at?: number) {
    this.tracksDSP.forEach(d => {
      const ids = d.chainIds || [];
      if (!ids.length) return;
      this.syncChainTimeline(ids.map(id => d.pluginChain.get(id)?.instance), origin, this.pdcSuspended ? 0 : (d.downLatency || 0), at, !this.pdcSuspended);
    });
  }

  private resyncTimelineEffects() {
    if (!this.isPlaying || !this.ctx) return;
    const w = this.pendingLoopWrap;
    if (w && this.ctx.currentTime < w.atContextTime) {
      this.syncTimelineEffects(w.previousStartTime);
      this.syncTimelineEffects(this.playbackStartTime, w.atContextTime);
    } else this.syncTimelineEffects(this.playbackStartTime);
  }

  /** Désarme une piste (sans argument : toutes). La dernière désarmée ferme le micro. */
  public disarmTrack(trackId?: string) {
    const ids = trackId ? [trackId] : this.armedIds();
    for (const id of ids) {
      this.detachFlashback(id);
      this.inputRouter?.disarm(id);
      this.armedSpecs.delete(id);
      this.setTrackLowLatency(id, false);
    }
    if (!trackId) this.armedSpecs.clear();
    if (!this.inputRouter?.size) {
      this.stopLatencyWatch();
      if (this.asioBridge && this.asioConnected) {
        if (this.asioBridge.protocol >= 2) this.asioBridge.setMonitorRoutes(false, []);
        else this.asioBridge.setMonitor(false, this.monitorLevel, -1);
      }
      this.closeInputSource();
      this.monitoringTrackId = null;
    } else {
      if (!this.monitoringTrackId || !this.inputRouter.has(this.monitoringTrackId)) this.monitoringTrackId = this.armedIds().pop() || null;
      this.syncDirectMonitor();
    }
  }

  /**
   * Démarre une prise sur une ou plusieurs pistes armées (R14 : plusieurs à la fois).
   * Un seul enregistreur capte toutes les entrées : même premier échantillon pour
   * toutes les pistes, donc des prises alignées à l'échantillon près.
   */
  public async startRecording(currentTime: number, trackIds: string | string[]): Promise<boolean> {
    // Piste armée à l'instant (bouton R puis REC tout de suite, ou machine chargée) : le
    // micro s'ouvre encore. Avant, la prise échouait (« No monitor stream ») : mesuré
    // dans le soak, 1 prise sur 3 ne démarrait pas sous charge.
    if (this.armingPromise) { try { await this.armingPromise; } catch { /* erreur d'armement déjà signalée */ } }
    const wanted = Array.isArray(trackIds) ? trackIds : [trackIds];
    console.log("[AudioEngine] startRecording called - pistes:", wanted, "armées:", this.armedIds(), "recording:", this.recordingTrackId);
    if (this.recordingTrackId) {
      console.error("[AudioEngine] REC FAILED - Already recording on:", this.recordingTrackId);
      return false;
    }
    const ids = wanted.filter(id => this.inputRouter?.has(id));
    if (!ids.length) {
      console.error("[AudioEngine] REC FAILED - No armed input! Arm track first.");
      return false;
    }

    // Enregistreur interne (AudioWorklet) : position exacte + son sans compression.
    try {
      if (this.ctx && this.ctx.audioWorklet) {
        await ensureRecorderModule(this.ctx);
        const input = this.inputRouter!.recorderInput(ids);
        if (input) {
          const session = new NovaRecorderSession(this.ctx, input.node, { channels: input.channels });
          const group = input.layout.length > 1 ? newTakeGroupId() : undefined;
          const common = this.measureRecordLatency().total + this.recOffsetMs / 1000;
          const offs = channelOffsets();
          this.recChannels = new Map(input.layout.map(l => [l.trackId, [...(this.inputRouter!.tap(l.trackId)?.channels || [])]]));
          this.recJournals = new Map();
          for (const l of input.layout) {
            try {
              const j = this.takeJournalFactory?.({
                trackId: l.trackId, recordedAt: currentTime, sampleRate: this.ctx.sampleRate,
                latency: common + channelOffsetSec(this.recChannels.get(l.trackId) || [], offs),
                ...(group ? { group } : {}), ...(l.width === 2 ? { channels: 2 } : {}),
              }) || null;
              if (j) this.recJournals.set(l.trackId, j);
            } catch { /* le journal ne doit jamais empêcher la prise */ }
          }
          this.recLeadDone = false;
          if (this.recJournals.size) {
            session.onChunks = cs => {
              this.annotateLead();
              for (const l of input.layout) {
                const j = this.recJournals.get(l.trackId);
                if (!j) continue;
                if (l.width === 1) j.push(cs[l.first]);
                else {
                  // Stéréo : échantillons entrelacés G/D dans le journal.
                  const a = cs[l.first], b = cs[l.first + 1], x = new Float32Array(a.length * 2);
                  for (let i = 0; i < a.length; i++) { x[2 * i] = a[i]; x[2 * i + 1] = b ? b[i] : 0; }
                  j.push(x);
                }
              }
            };
          }
          this.recSession = session;
          this.recSource = input.node;
          this.recInput = input;
          this.recGroup = group;
          this.recPlayStart = this.isPlaying ? this.playbackStartTime : null;
          this.recStartTime = currentTime;
          this.recordingTrackIds = input.layout.map(l => l.trackId);
          this.recordingTrackId = this.recordingTrackIds[0];
          this.latencySamples = [];
          if (!this.latencyTimer) this.startLatencyWatch();
          console.log("[AudioEngine] Recording started (enregistreur calé) on tracks:", this.recordingTrackIds, `${input.channels} canaux`);
          return true;
        }
      }
    } catch (e) {
      console.warn("[AudioEngine] Enregistreur calé indisponible, repli sur MediaRecorder", e);
      this.recInput?.dispose();
      this.recInput = null;
      this.recSession = null;
      this.recSource = null;
      this.recJournals = new Map();
    }

    // Repli sans AudioWorklet : MediaRecorder sur le flux du micro, 1re piste seulement.
    if (!this.activeMonitorStream) return false;
    try {
      this.mediaRecorder = new MediaRecorder(this.activeMonitorStream);
      this.audioChunks = [];
      this.recStartTime = currentTime;
      this.recordingTrackId = ids[0];
      this.recordingTrackIds = [ids[0]];
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      this.mediaRecorder.start();
      console.log("[AudioEngine] Recording started OK on track:", ids[0]);
      return true;
    } catch (e) {
      console.error("[AudioEngine] REC ERROR:", e);
      this.recordingTrackId = null;
      this.recordingTrackIds = [];
      return false;
    }
  }

  /**
   * Journal de prise : dès que le 1er échantillon capté et le départ de la lecture sont
   * connus, l'avance du son (décompte, pré-roll) est notée. Après un plantage, la prise
   * récupérée est replacée comme une prise normale (et les pistes restent alignées).
   */
  private annotateLead() {
    if (this.recLeadDone || !this.recSession || !this.ctx) return;
    const first = this.recSession.firstFrame;
    const playStart = this.recPlayStart;
    if (first < 0 || playStart === null) return;
    this.recLeadDone = true;
    const lead = Math.max(0, (playStart + this.recStartTime) - first / this.ctx.sampleRate);
    this.recJournals.forEach(j => { try { j.annotate?.({ lead }); } catch { /* */ } });
  }

  /** Fin de la prise : la 1re piste (voir stopRecordingAll pour toutes). */
  public async stopRecording(): Promise<{ clip: Clip, trackId: string } | null> {
    const all = await this.stopRecordingAll();
    return all[0] || null;
  }

  /** R14 · Fin de la prise : un clip par piste enregistrée (même groupe si plusieurs). */
  public async stopRecordingAll(): Promise<TakeResult[]> {
    if (this.recSession && this.recordingTrackId && this.ctx) return this.stopCalibratedRecording();
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive' || !this.recordingTrackId) {
      return [];
    }
    return new Promise((resolve) => {
      this.mediaRecorder!.onstop = async () => {
        const trackId = this.recordingTrackId!;
        const blob = new Blob(this.audioChunks, { type: this.mediaRecorder!.mimeType });

        // On MEMORISE la position de depart avant de reinitialiser l'etat : elle
        // etait remise a 0 puis relue plus bas, et toutes les prises atterrissaient
        // donc au tout debut de la timeline.
        const recordedAt = this.recStartTime;

        // Reset recording state FIRST
        this.audioChunks = [];
        this.recordingTrackId = null;
        this.recordingTrackIds = [];
        this.recStartTime = 0;
        this.mediaRecorder = null;

        if (blob.size === 0) { resolve([]); return; }

        try {
          const arrayBuffer = await blob.arrayBuffer();
          const audioBuffer = await this.ctx!.decodeAudioData(arrayBuffer);
          const clipData: Clip = {
            id: `rec-${Date.now()}`,
            name: `Vocal Take ${new Date().toLocaleTimeString()}`,
            // Compensation de latence : la prise arrive en retard de la latence
            // aller-retour, on la recale donc plus tot. Le bouton PDC de la barre
            // de transport ne servait a rien jusqu'ici (drapeau jamais lu).
            start: Math.max(0, recordedAt - (this.isDelayCompEnabled ? this.getRoundTripLatency() : 0)),
            duration: audioBuffer.duration,
            offset: 0,
            fadeIn: 0.01,
            fadeOut: 0.01,
            type: TrackType.AUDIO,
            color: '#ff0000',
            audioRef: URL.createObjectURL(blob),
            buffer: audioBuffer,
          };
          console.log("[AudioEngine] Recording stopped. New clip created:", clipData);
          resolve([{ clip: clipData, trackId }]);
        } catch (e) {
          console.error("Error processing recorded audio:", e);
          resolve([]);
        }
      };
      this.mediaRecorder!.stop();
    });
  }

  /**
   * Fin d'une prise de l'enregistreur calé : chaque prise est replacée exactement
   * où elle aurait dû être (position de lecture au début de la prise, moins la
   * latence moyenne mesurée pendant la prise, plus le réglage fin manuel, plus le
   * retard propre de son entrée). Toutes les pistes partagent le même premier
   * échantillon : seules leurs entrées les décalent (compensation par canal).
   */
  private async stopCalibratedRecording(): Promise<TakeResult[]> {
    const ctx = this.ctx!;
    const session = this.recSession!;
    const src = this.recSource!;
    const input = this.recInput;
    const group = this.recGroup;
    const recChannels = this.recChannels;
    const recordedAt = this.recStartTime;
    const playStart = this.recPlayStart ?? (this.isPlaying ? this.playbackStartTime : null);
    this.recPlayStart = null;
    this.recSession = null;
    this.recSource = null;
    this.recInput = null;
    this.recGroup = undefined;
    this.recChannels = new Map();
    this.recordingTrackId = null;
    this.recordingTrackIds = [];
    this.recStartTime = 0;

    const { channels, firstFrame } = await session.stop(src);
    try { input?.dispose(); } catch { /* */ }
    const journals = this.recJournals;
    this.recJournals = new Map();
    const len = channels?.[0]?.length || 0;
    if (!channels || !len || !input) { journals.forEach(j => void j.discard()); return []; }
    // Prise terminée normalement : les journaux sont clos (effacés une fois la prise dans une version).
    journals.forEach(j => void j.finish());
    const sr = ctx.sampleRate;

    // Position de chaque échantillon sur la timeline : (frame / sr) − début de lecture.
    let lead = 0;
    let rawStart = recordedAt;
    if (playStart !== null && firstFrame >= 0) {
      const playCtxAtStart = playStart + recordedAt;        // instant (horloge) où la lecture a démarré
      lead = Math.max(0, Math.round((playCtxAtStart - firstFrame / sr) * sr));
      rawStart = (firstFrame + lead) / sr - playStart;
    }
    // Médiane des mesures (une par seconde) : un à-coup du navigateur pendant la prise (tampon
    // d'entrée vidé ou gonflé un instant) ne déplace plus toute la prise.
    const measured = this.latencySamples.length ? medianOf(this.latencySamples) : this.measureRecordLatency().total;
    const latency = measured + this.recOffsetMs / 1000;
    const offs = channelOffsets();
    const stamp = Date.now();
    const out: TakeResult[] = [];
    input.layout.forEach((l, k) => {
      const lat = latency + channelOffsetSec(recChannels.get(l.trackId) || [], offs);
      let start = rawStart - lat;
      let skip = 0;
      if (start < 0) { skip = Math.round(-start * sr); start = 0; }
      const from = Math.min(len, lead + skip);
      const bodies = (l.width === 1 ? [channels[l.first]] : [channels[l.first], channels[l.first + 1]]).map(c => c.subarray(from));
      if (bodies[0].length < sr * 0.05) return;
      const buffer = ctx.createBuffer(l.width, bodies[0].length, sr);
      bodies.forEach((b, i) => buffer.copyToChannel(b, i));
      const blob = encodeWav24(l.width === 1 ? bodies[0] : bodies, sr);
      console.log(`[AudioEngine] Prise replacée (${l.trackId}) : latence ${Math.round(lat * 1000)} ms (mesurée ${Math.round(measured * 1000)} ms, réglage ${this.recOffsetMs} ms)`);
      try { window.dispatchEvent(new CustomEvent('nova:take-aligned', { detail: { ms: Math.round(lat * 1000), sec: lat, raw: rawStart, trackId: l.trackId } })); } catch { /* */ }
      out.push({
        trackId: l.trackId,
        ...(group ? { group } : {}),
        clip: {
          id: k ? `rec-${stamp}-t${k}` : `rec-${stamp}`,
          name: `Vocal Take ${new Date().toLocaleTimeString()}`,
          start,
          duration: buffer.duration,
          offset: 0,
          fadeIn: 0.01,
          fadeOut: 0.01,
          type: TrackType.AUDIO,
          color: '#ff0000',
          audioRef: URL.createObjectURL(blob),
          buffer,
        },
      });
    });
    return out;
  }

  // ─── R13 · Lecture ralentie (Half-Speed de Pro Tools, Varispeed de Logic) ─────────
  // Le mix est rendu hors ligne par morceaux (même rendu que l'export, pistes guides
  // comprises), étiré par le vocodeur de phase (hauteur gardée) et joué dans la sortie
  // du master. La tête de lecture avance à la même vitesse. L'export n'est jamais ralenti.
  private practiceRate = 1;
  private practiceGen = 0;
  /** Pistes du projet avant résolution (engineView n'est pas à appliquer deux fois : niveau des guides). */
  private practiceRawTracks: Track[] | null = null;
  private practiceTimer: number | null = null;
  private practice: {
    gen: number; rate: number; startOffset: number;
    /** Morceaux programmés : instant du contexte, temps du projet couvert. */
    segs: { ctxAt: number; from: number; to: number }[];
    sources: AudioBufferSourceNode[];
    nextFrom: number; ctxNext: number | null; rendering: boolean;
  } | null = null;

  /** Vitesse de la lecture ralentie (0,5 à 1). Changée en cours de lecture : on repart du même endroit. */
  public setPracticeRate(rate: number) {
    const r = Math.max(0.5, Math.min(1, Math.round((Number.isFinite(rate) ? rate : 1) * 100) / 100));
    if (r === this.practiceRate) return;
    const playing = this.isPlaying && !this.recSession && !this.recordingTrackId;
    const at = playing ? this.getCurrentTime() : this.pausedAt;
    this.practiceRate = r;
    const raw = this.practiceRawTracks || this.liveTracks;
    if (playing && raw) { this.stopAll(); this.startPlayback(at, raw); }
  }
  public getPracticeRate(): number { return this.practiceRate; }
  /** Lecture ralentie en cours ? (et en attente du 1er morceau ?) */
  public getPracticeState(): { active: boolean; waiting: boolean; rate: number } {
    const p = this.practice;
    return { active: !!p, waiting: !!p && !p.segs.length, rate: this.practiceRate };
  }

  private startPractice(startOffset: number, tracks: Track[]) {
    if (!this.ctx) return;
    this.isPlaying = true;
    this.pendingLoopWrap = null;
    this.pausedAt = startOffset;
    this.liveTracks = tracks;
    this.clipSigs = this.computeClipSigs(tracks);
    const gen = ++this.practiceGen;
    this.practice = { gen, rate: this.practiceRate, startOffset, segs: [], sources: [], nextFrom: startOffset, ctxNext: null, rendering: false };
    void this.practicePump(gen);
    this.practiceTimer = window.setInterval(() => { void this.practicePump(gen); }, 200);
  }

  private stopPractice() {
    if (this.practiceTimer) { clearInterval(this.practiceTimer); this.practiceTimer = null; }
    const p = this.practice;
    if (!p) return;
    this.practiceGen++;
    p.sources.forEach(s => { try { s.stop(); s.disconnect(); } catch { /* déjà arrêtée */ } });
    this.practice = null;
  }

  /** Temps du projet joué maintenant (la tête attend si un morceau est en retard). */
  private practiceTime(): number {
    const p = this.practice!;
    const now = this.ctx!.currentTime;
    let seg: { ctxAt: number; from: number; to: number } | null = null;
    for (const s of p.segs) if (s.ctxAt <= now) seg = s;
    if (!seg) return p.startOffset;
    return Math.min(seg.to, seg.from + (now - seg.ctxAt) * p.rate);
  }

  /** Fin de ce qu'il y a à jouer (dernier clip + 2 s de queue). */
  private practiceEnd(tracks: Track[]): number {
    let end = 0;
    for (const t of tracks) for (const c of t.clips || []) end = Math.max(end, c.start + c.duration);
    return end + 2;
  }

  private async practicePump(gen: number) {
    const p = this.practice;
    const ctx = this.ctx;
    if (!p || p.gen !== gen || p.rendering || !ctx) return;
    const now = ctx.currentTime;
    if (p.ctxNext !== null && p.ctxNext - now > 5) return; // assez d'avance
    const tracks = this.practiceRawTracks || this.liveTracks || [];
    const loop = this.isLoopActive && this.loopEnd > this.loopStart + 0.05;
    const end = loop ? this.loopEnd : this.practiceEnd(tracks);
    if (p.nextFrom >= end - 1e-6) {
      if (!loop) return;
      p.nextFrom = this.loopStart;
    }
    p.rendering = true;
    const from = p.nextFrom;
    // 1er morceau court (départ rapide), puis 6 s ; chevauchement de 80 ms pour le fondu entre morceaux.
    const len = Math.min(p.segs.length ? 6 : 2.5, end - from);
    const OV = 0.08;
    const wrapsAfter = loop && from + len >= this.loopEnd - 1e-6;
    const ov = wrapsAfter ? 0.005 : OV;
    const pre = Math.min(1, from);
    const sr = ctx.sampleRate;
    try {
      const mix = await this.renderProject(tracks, pre + len + ov, from - pre, sr, undefined, { keepGuides: true });
      if (!this.practice || this.practice.gen !== gen) return;
      const a = Math.round(pre * sr), n = Math.min(mix.length - a, Math.round((len + ov) * sr));
      const chs: Float32Array[] = [];
      for (let c = 0; c < mix.numberOfChannels; c++) chs.push(mix.getChannelData(c).slice(a, a + n));
      const outLen = Math.round(n / p.rate);
      const res = await renderElasticAsync({ channels: chs, sr, segments: [{ s0: 0, s1: n, d0: 0, d1: outLen }], semitones: 0, formants: false, algo: 'poly' });
      if (!this.practice || this.practice.gen !== gen || !this.ctx) return;
      const buf = new AudioBuffer({ length: Math.max(1, outLen), numberOfChannels: res.channels.length, sampleRate: sr });
      res.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      const t0 = Math.max(p.ctxNext ?? 0, this.ctx.currentTime + 0.04);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      src.connect(g); g.connect(this.masterOutput || this.ctx.destination);
      // Fondus à puissance égale aux raccords (départ net au tout début).
      const joined = p.segs.length > 0 && p.ctxNext !== null && Math.abs(t0 - p.ctxNext) < 1e-3;
      const dur = outLen / sr;
      const fadeIn = Math.min(joined ? OV / p.rate : 0.004, dur / 2);
      const fadeOut = Math.min(ov / p.rate, dur / 2);
      const curve = (up: boolean) => { const k = new Float32Array(64); for (let i = 0; i < 64; i++) k[i] = up ? Math.sin((i / 63) * Math.PI / 2) : Math.cos((i / 63) * Math.PI / 2); return k; };
      g.gain.setValueAtTime(0, t0);
      g.gain.setValueCurveAtTime(curve(true), t0, fadeIn);
      g.gain.setValueCurveAtTime(curve(false), t0 + dur - fadeOut, fadeOut);
      src.start(t0);
      src.onended = () => { const q = this.practice; if (q) q.sources = q.sources.filter(x => x !== src); try { g.disconnect(); } catch { /* */ } };
      p.sources.push(src);
      p.segs.push({ ctxAt: t0, from, to: from + len });
      if (p.segs.length > 64) p.segs.splice(0, p.segs.length - 64);
      p.ctxNext = t0 + len / p.rate;
      p.nextFrom = from + len;
    } catch (e) {
      console.warn('[AudioEngine] Lecture ralentie : rendu impossible', e);
      try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: 'Lecture ralentie : rendu impossible, retour à la vitesse normale.' })); } catch { /* */ }
      if (this.practice?.gen === gen) { this.practiceRate = 1; const at = this.getCurrentTime(); this.stopAll(); this.pausedAt = at; }
      return;
    } finally {
      if (this.practice?.gen === gen) this.practice.rendering = false;
    }
    void this.practicePump(gen);
  }

  /**
   * @param opts.at instant du contexte où la lecture doit partir (fin du décompte, R2) ;
   *        par défaut tout de suite.
   */
  public startPlayback(startOffset: number, tracks: Track[], opts: { at?: number } = {}) {
    if (!this.ctx) return;
    // Pistes du projet telles quelles (la lecture ralentie les passe au rendu, qui les résout lui-même).
    this.practiceRawTracks = tracks;
    tracks = engineView(tracks).tracks;
    if (this.isPlaying) this.stopAll();
    // L'extrait du catalogue jouait en même temps que le projet : on le coupe
    // (lecteur interne ici, lecteur <audio> du catalogue via l'événement).
    this.stopPreview();
    window.dispatchEvent(new Event('nova:transport-start'));

    // Lecture ralentie (R13) : rendue par morceaux et étirée, hauteur gardée. Jamais pendant une prise.
    if (this.practiceRate < 0.999 && !this.recSession && !this.recordingTrackId) { this.startPractice(startOffset, tracks); return; }

    this.isPlaying = true;
    this.pendingLoopWrap = null;
    this.pausedAt = startOffset;
    this.pluginAutoSent.clear();
    this.nextScheduleTime = Math.max(this.ctx.currentTime + 0.01, opts.at ?? 0);
    // Le point de départ tombe pile au début de la 1re fenêtre : une note posée
    // exactement là (1er kick de la batterie, 1re 808) était sautée.
    this.playbackStartTime = this.nextScheduleTime - startOffset;
    this.midiRunStart = startOffset;
    this.flashbackRunStart(this.nextScheduleTime, this.playbackStartTime);
    // Synthé NOVA : chorus calé sur le temps du morceau (identique à l'export).
    this.tracksDSP.forEach(d => { if (d.synth instanceof NovaSynthNode) d.synth.syncTimeline(this.playbackStartTime, this.nextScheduleTime); });
    // Gate rythmique : motif calé sur la grille du morceau (même calcul qu'à l'export).
    this.resyncTimelineEffects();
    if (this.recSession && this.recPlayStart === null) { this.recPlayStart = this.playbackStartTime; this.annotateLead(); } 

    // Valeur correcte au demarrage : sans ca, une piste dont tous les points
    // d'automation sont anterieurs au point de depart gardait la valeur du
    // dernier rebuild du graphe au lieu de la valeur automatisee.
    tracks.forEach(track => this.applyAutomation(track, startOffset));

    this.liveTracks = tracks;
    this.clipSigs = this.computeClipSigs(tracks);
    // 1re fenêtre tout de suite (le minuteur arrivait après son début).
    this.scheduler(tracks);
    this.schedulerTimer = window.setInterval(() => {
      this.scheduler(this.liveTracks || tracks);
    }, this.LOOKAHEAD_MS);
  }

  public stopAll() {
    // On memorise la position reelle d'arret : sans ca getCurrentTime() renvoyait
    // apres un stop la position de DEPART de la lecture, pas celle de l'arret.
    const wasPlaying = this.isPlaying;
    if (this.isPlaying) this.pausedAt = this.getCurrentTime();
    if (this.isPlaying && this.ctx) this.flashbackRunEnd(this.ctx.currentTime, false);
    this.isPlaying = false;
    this.stopPractice();
    // Fin de passe d'automation (modes Touch / Latch / Write) : à la position d'arrêt.
    if (wasPlaying) { try { window.dispatchEvent(new CustomEvent('nova:transport-stop', { detail: { time: this.pausedAt } })); } catch { /* hors navigateur */ } }
    this.autoOverrides.clear();
    this.pendingLoopWrap = null;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.activeSources.forEach((src) => {
      try { src.source.stop(); src.source.disconnect(); src.gain.disconnect(); } catch (e) { }
    });
    this.activeSources.clear();
    this.tracksDSP.forEach(dsp => {
        if (dsp.synth) { dsp.synth.releaseAll(); dsp.synth.resetControllers(); }
        if (dsp.bass808) dsp.bass808.stopAll();
        if (dsp.sampler) dsp.sampler.stopAll();
        if (dsp.drumSampler) dsp.drumSampler.stop();
        if (dsp.melodicSampler) dsp.melodicSampler.stopAll();
    });
    this.activeMidiNotes.clear();
    if (this.ctx) {
      const now = this.ctx.currentTime;
      // Valeurs figées à l'arrêt : calculées d'après la piste (volume, VCA, guide, automation
      // à la position d'arrêt), pas relues sur gain.value — figée par le navigateur sur une
      // piste silencieuse, elle ramenait un ancien réglage (ex. niveau du guide changé à l'arrêt).
      const live = new Map((this.liveTracks || []).map(t => [t.id, t] as const));
      this.tracksDSP.forEach((dsp, id) => {
        try {
          const t = live.get(id);
          const vLane = t ? playedLanes(t).find(l => l.parameterName === 'volume' && l.points.length > 0) : undefined;
          const pLane = t ? playedLanes(t).find(l => l.parameterName === 'pan' && l.points.length > 0) : undefined;
          const vol = !t ? dsp.gain.gain.value
            : (t.isMuted || this.soloSilencedIds.has(id)) ? 0
            : vLane ? this.valeurAutomationA(this.sortedOf(vLane.points), this.pausedAt) : t.volume;
          const pan = !t ? dsp.panner.pan.value : pLane ? this.valeurAutomationA(this.sortedOf(pLane.points), this.pausedAt) : t.pan;
          dsp.gain.gain.cancelScheduledValues(now);
          dsp.gain.gain.setValueAtTime(vol, now);
          dsp.panner.pan.cancelScheduledValues(now);
          dsp.panner.pan.setValueAtTime(pan, now);
        } catch (e) {}
      });
      // Réglages d'effets programmés d'avance : plus rien ne doit bouger après l'arrêt.
      this.pluginAutoParams.forEach(ap => { try { const v = ap.value; ap.cancelScheduledValues(now); ap.setValueAtTime(v, now); } catch { /* effet libéré */ } });
      this.pluginAutoParams.clear();
    }
    this.stopScrubbing();
  }

  public seekTo(time: number, tracks: Track[], wasPlaying: boolean) {
    tracks = engineView(tracks).tracks;
    this.stopAll();
    this.pausedAt = time;
    tracks.forEach(track => this.applyAutomation(track, time));
    if (wasPlaying) {
      this.startPlayback(time, tracks);
    }
  }

  public getCurrentTime(): number {
    if (!this.ctx) return 0;
    if (!this.isPlaying) return this.pausedAt;
    if (this.practice) return this.practiceTime();

    const now = this.ctx.currentTime;
    let startTime = this.playbackStartTime;
    if (this.pendingLoopWrap) {
      if (now < this.pendingLoopWrap.atContextTime) {
        startTime = this.pendingLoopWrap.previousStartTime;
      } else {
        this.pendingLoopWrap = null;
      }
    }
    return Math.max(0, now - startTime);
  }
  
  public getIsPlaying(): boolean { return this.isPlaying; }

  /**
   * Instant du contexte audio qui correspond au début du morceau pour la
   * lecture en cours (avant tout retour de boucle) : prise MIDI armée (R16).
   */
  public getPlaybackOrigin(): number { return this.playbackStartTime; }

  // --- Scrub / shuttle audibles (R17, engine/Scrubber) ----------------------------
  private scrubber: Scrubber | null = null;
  private scrubberOf(): Scrubber | null {
    if (!this.ctx) return null;
    if (!this.scrubber) {
      this.scrubber = new Scrubber({
        ctx: this.ctx,
        input: (id) => this.tracksDSP.get(id)?.input || null,
        silenced: (id) => this.soloSilencedIds.has(id),
        reversed: (key, buf) => this.reversedOf(key, buf),
      });
      this.scrubber.onMove = (t) => { this.pausedAt = t; playheadStore.set(t); };
    }
    return this.scrubber;
  }

  /** Buffer inversé mis en cache (lecture à l'envers : clip inversé, scrub en arrière). */
  private reversedOf(key: string, buffer: AudioBuffer): AudioBuffer {
    let reversed = this.reversedBufferCache.get(key);
    if (!reversed || reversed.length !== buffer.length) {
      reversed = this.ctx!.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const original = buffer.getChannelData(ch);
        const out = reversed.getChannelData(ch);
        for (let i = 0, n = original.length; i < n; i++) out[i] = original[n - 1 - i];
      }
      this.reversedBufferCache.set(key, reversed);
    }
    return reversed;
  }

  /**
   * Scrub (Pro Tools : Scrubber, Ctrl+glisser) : la position audible suit `time`.
   * Grains courts fenêtrés, vitesse = vitesse du geste : voir engine/Scrubber.
   * La lecture doit être arrêtée (comme dans Pro Tools, scrubber arrête le transport).
   */
  public scrub(tracks: Track[], time: number, _velocity?: number) {
    if (this.isPlaying) return;
    this.scrubberOf()?.scrubTo(engineView(tracks).tracks, time);
  }

  /** Shuttle : défilement à vitesse constante (× temps réel, négatif = en arrière). */
  public shuttle(tracks: Track[], speed: number, from?: number) {
    if (this.isPlaying) return;
    this.scrubberOf()?.shuttle(engineView(tracks).tracks, speed, from ?? this.pausedAt);
  }

  public stopScrubbing() { this.scrubber?.stop(); }
  public isScrubbing(): boolean { return !!this.scrubber?.active; }
  public getScrubPosition(): number { return this.scrubber?.position ?? this.pausedAt; }
  public getScrubStats(): ScrubStats | null { return this.scrubber ? { ...this.scrubber.stats } : null; }

  private computeClipSigs(tracks: Track[]): Map<string, string> {
    const m = new Map<string, string>();
    tracks.forEach(t => this.livePlayableClips(t).forEach(c => {
      m.set(c.id, `${t.id}|${c.start}|${c.offset}|${c.duration}|${c.isMuted ? 1 : 0}|${c.bufferId || ''}|${c.gain ?? 1}|${c.fadeIn}|${c.fadeOut}|${c.fadeInCurve || ''}|${c.fadeOutCurve || ''}|${c.isReversed ? 1 : 0}|${breathSig(c.breaths)}|${gainPointsSig(c.gainPoints)}`);
    }));
    return m;
  }

  /**
   * Les pistes ont changé pendant la lecture (clip déplacé, coupé, supprimé,
   * prise choisie…) : on coupe les sources devenues fausses ; le planificateur
   * relance la version à jour au passage suivant (≈ 25 ms). Avant, le
   * planificateur gardait les pistes du moment du « Play » : un clip supprimé
   * continuait de sonner jusqu'à l'arrêt.
   */
  /** Pistes de la session telles que le moteur les joue (clés de side-chain des rendus VST, R10). */
  public getLiveTracks(): Track[] { return this.liveTracks || []; }

  public setLiveTracks(tracks: Track[]) {
    this.practiceRawTracks = tracks;
    tracks = engineView(tracks).tracks;
    if (!this.isPlaying || !this.ctx) { this.liveTracks = tracks; return; }
    const next = this.computeClipSigs(tracks);
    const now = this.ctx.currentTime;
    this.activeSources.forEach((src, key) => {
      const id = src.clipId || key;
      if (next.get(id) === this.clipSigs.get(id)) return;
      try {
        src.gain.gain.cancelScheduledValues(now);
        src.gain.gain.setValueAtTime(src.gain.gain.value, now);
        src.gain.gain.linearRampToValueAtTime(0, now + 0.005);
        src.source.stop(now + 0.006);
      } catch { /* déjà arrêtée */ }
      this.activeSources.delete(key);
    });
    this.clipSigs = next;
    this.liveTracks = tracks;
  }

  private lastOverloadAt = 0;
  /** Retards du planificateur (fenêtres programmées après leur début) depuis le lancement. */
  private schedulerLateTicks = 0;
  public getSchedulerLateTicks(): number { return this.schedulerLateTicks; }
  public isTransportRunning(): boolean { return this.isPlaying || !!this.recordingTrackId; }
  /** Mode de latence du planificateur (réglages audio, mode sécurité). */
  public getLatencyMode(): 'low' | 'balanced' | 'high' {
    return this.SCHEDULE_AHEAD_SEC >= 0.2 ? 'high' : this.SCHEDULE_AHEAD_SEC >= 0.1 ? 'balanced' : 'low';
  }

  private scheduler(tracks: Track[]) {
    if (!this.ctx) return;
    // Surcharge : le planificateur a pris du retard sur l'horloge audio (onglet
    // trop chargé, trop d'effets) → risque de trous / craquements.
    if (this.nextScheduleTime < this.ctx.currentTime - 0.15 && document.visibilityState === 'visible') {
      const now = performance.now();
      if (now - this.lastOverloadAt > 1000) {
        this.lastOverloadAt = now;
        try { window.dispatchEvent(new CustomEvent('nova:overload')); } catch { /* */ }
      }
    }
    // Fenêtre dont le début est déjà passé : les sons qui y tombent partent en retard
    // (compteur lu par engine/dspMonitor, indicateur CPU de la barre de transport).
    if (this.nextScheduleTime < this.ctx.currentTime - 0.003) this.schedulerLateTicks++;
    let guard = 0;
    while (this.nextScheduleTime < this.ctx.currentTime + this.SCHEDULE_AHEAD_SEC && guard++ < 64) {
      const projectTimeStart = this.nextScheduleTime - this.playbackStartTime;
      const loopActive = this.isLoopActive && this.loopEnd > this.loopStart;

      // On tronque la fenetre d'ordonnancement au point de bouclage pour ne
      // jamais programmer d'audio au-dela de la fin de boucle.
      let windowSec = this.SCHEDULE_AHEAD_SEC;
      let wrapAfterWindow = false;
      if (loopActive && projectTimeStart >= this.loopEnd) {
        windowSec = 0;            // deja au-dela (boucle activee en cours de lecture)
        wrapAfterWindow = true;
      } else if (loopActive && projectTimeStart + windowSec >= this.loopEnd) {
        windowSec = this.loopEnd - projectTimeStart;
        wrapAfterWindow = true;
      }

      if (windowSec > 0) {
        const projectTimeEnd = projectTimeStart + windowSec;
        this.scheduleClips(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime, 0, new Map());
        this.scheduleMidi(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
        this.midiRunStart = null;
        this.scheduleAutomation(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
        this.scheduleChordFollow(projectTimeStart, projectTimeEnd, this.nextScheduleTime);
        this.nextScheduleTime += windowSec;
      }

      if (wrapAfterWindow) this.wrapLoopAt(this.nextScheduleTime, tracks);
    }
  }

  /**
   * Reboucle a l'instant contextuel donne : coupe proprement tout ce qui joue et
   * recale la correspondance temps-contexte / temps-projet sur loopStart.
   */
  private wrapLoopAt(boundaryContextTime: number, tracks: Track[]) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.midiRunStart = this.loopStart;

    // Fondu de 5 ms avant la coupure pour eviter le clic.
    this.activeSources.forEach(({ source, gain }) => {
      try {
        const fadeStart = Math.max(now, boundaryContextTime - 0.005);
        gain.gain.cancelScheduledValues(fadeStart);
        gain.gain.setValueAtTime(gain.gain.value, fadeStart);
        gain.gain.linearRampToValueAtTime(0, boundaryContextTime);
      } catch (e) {}
      try { source.stop(boundaryContextTime); } catch (e) {}
    });
    this.activeSources.clear();

    this.tracksDSP.forEach(dsp => {
      if (dsp.synth) dsp.synth.releaseAll();
      if (dsp.bass808) dsp.bass808.stopAll(boundaryContextTime);
      if (dsp.sampler) dsp.sampler.stopAll();
      if (dsp.drumSampler) dsp.drumSampler.stop();
      if (dsp.melodicSampler) dsp.melodicSampler.stopAll(boundaryContextTime);
    });
    this.activeMidiNotes.clear();

    // Les rampes d'automation programmees au-dela du point de bouclage doivent
    // etre annulees, sinon elles continuent de piloter le gain apres le retour.
    this.tracksDSP.forEach(dsp => {
      try {
        dsp.gain.gain.cancelScheduledValues(boundaryContextTime);
        dsp.panner.pan.cancelScheduledValues(boundaryContextTime);
        dsp.input.gain.cancelScheduledValues(boundaryContextTime);
        dsp.frozenInput?.gain.cancelScheduledValues(boundaryContextTime);
      } catch (e) {}
    });

    const previousStartTime = this.playbackStartTime;
    this.playbackStartTime = boundaryContextTime - this.loopStart;
    this.pendingLoopWrap = { atContextTime: boundaryContextTime, previousStartTime };
    // Capture après coup : chaque tour de boucle est un passage à part.
    this.flashbackRunEnd(boundaryContextTime, true);
    this.flashbackRunStart(boundaryContextTime, this.playbackStartTime);
    this.syncTimelineEffects(this.playbackStartTime, boundaryContextTime);

    tracks.forEach(track => this.applyAutomation(track, this.loopStart));
  }

  /**
   * Écoute d'une prise en solo (couloirs de prises, comme le solo d'une
   * playlist de Pro Tools) : en lecture seulement, jamais à l'export, rien
   * n'est écrit dans le projet.
   */
  private takeAudition: { trackId: string; n: number } | null = null;
  private auditionCache: { src: Clip[]; n: number; out: Clip[] } | null = null;
  public setTakeAudition(a: { trackId: string; n: number } | null) {
    this.takeAudition = a;
    this.auditionCache = null;
    if (this.liveTracks) this.setLiveTracks(this.liveTracks);
  }
  public getTakeAudition() { return this.takeAudition; }
  private livePlayableClips(track: Track, all?: Track[]): Clip[] {
    const a = this.takeAudition;
    if (a && a.trackId === track.id && !isTrackFrozen(this.eff(track))) {
      const c = this.auditionCache;
      if (c && c.src === track.clips && c.n === a.n) return c.out;
      const out = auditionClips(track.clips || [], a.n);
      this.auditionCache = { src: track.clips, n: a.n, out };
      return out;
    }
    return this.getPlayableClips(track, all);
  }

  /** Clips reellement joues : le rendu gele remplace les clips d'origine. */
  private getPlayableClips(track: Track, all?: Track[]): Clip[] {
    track = this.eff(track);
    if (isTrackFrozen(track)) {
      const p = frozenPlayback(track);
      // Bus VST gelé : il joue les tranches des rendus d'envoi de ses sources.
      const bus = all && isFrozenBus(track) ? busFrozenSlices(track, all) : [];
      return [...p.render, ...bus, ...p.live];
    }
    return track.clips || [];
  }

  private scheduleClips(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number, maxLatency: number, latencies: Map<string, number>) {
      tracks.map(t => this.eff(t)).forEach(track => {
      // Piste muette : rien à jouer, SAUF si elle sert de clé de side-chain avant fader (kick fantôme, R7).
      if (track.isMuted && !this.sidechain.isPreKeySource(track.id)) return; 
      const isFrozenRender = isTrackFrozen(track);
      if (!isFrozenRender && track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS && track.type !== TrackType.SEND) return;

      this.livePlayableClips(track, tracks).forEach(clip => {
        const sourceKey = `${clip.id}`; 
        if (this.activeSources.has(sourceKey)) return;
        
        const clipEnd = clip.start + clip.duration;
        const lat = this.pdcSuspended ? 0 : this.getTrackLatency(track.id);
        const overlapsWindow = clip.start < projectWindowEnd + lat && clipEnd > projectWindowStart;
        if (overlapsWindow) {
           this.playClipSource(track.id, clip, contextScheduleTime, projectWindowStart);
        }
      });
    });
  }

  private scheduleMidi(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number) {
      tracks.map(t => this.eff(t)).forEach(track => {
        if (track.isMuted && !this.sidechain.isPreKeySource(track.id)) return;
        if (track.type !== TrackType.MIDI && track.type !== TrackType.SAMPLER && track.type !== TrackType.DRUM_RACK) return;
        // Piste gelee : seules les notes ajoutees apres le rendu sont jouees.
        const midiClips = isTrackFrozen(track) ? uncoveredClips(track) : track.clips;

        // Compensation de latence (PDC) : un instrument suivi d'effets à latence
        // (VST, bus, envois) joue ses notes d'autant plus tôt, comme l'audio.
        const lat = this.pdcSuspended ? 0 : this.getTrackLatency(track.id);
        const ws = projectWindowStart + lat;
        const we = projectWindowEnd + lat;
        // Boucle : rien au-delà de la fin de boucle ; 1re fenêtre d'un passage :
        // les notes des `lat` premières secondes partent tout de suite.
        const loopEnd = this.isLoopActive && this.loopEnd > this.loopStart ? this.loopEnd : Infinity;
        const firstWindow = this.midiRunStart !== null && Math.abs(projectWindowStart - this.midiRunStart) < 1e-6;

        // 808 : plan monophonique (glissés) joué dans l'ordre du temps.
        const b808 = this.tracksDSP.get(track.id)?.bass808;
        if (track.bass808 && b808) {
          const evs = events808(planOfClips(midiClips, track.bass808), ws, Math.min(we, loopEnd));
          b808.play(evs, t => contextScheduleTime + (t - ws));
          return;
        }

        const synth = this.tracksDSP.get(track.id)?.synth;
        const novaSynth = synth instanceof NovaSynthNode;
        // Contrôleurs MIDI (R16) : valeur tenue au départ (chasse), puis chaque point de la fenêtre.
        if (synth || this.tracksDSP.get(track.id)?.melodicSampler) this.scheduleControllers(track.id, midiClips, ws, Math.min(we, loopEnd), contextScheduleTime, firstWindow);
        midiClips.forEach(clip => {
           if (clip.type !== TrackType.MIDI || !clip.notes) return;
           
           const clipEnd = clip.start + clip.duration;
           // Fenêtre décalée de la latence (PDC) : un clip qui commence juste après
           // la fenêtre peut déjà avoir des notes à programmer.
           if (clip.start >= we || clipEnd <= projectWindowStart) return;

           const heard = playableNotes(clip);
           (novaSynth ? notesInTimeOrder(heard) : heard).forEach(note => {
               const noteAbsStart = clip.start + note.start;
               const noteAbsEnd = noteAbsStart + note.duration;

               if (noteAbsStart >= loopEnd) return;
               if (noteAbsStart >= ws && noteAbsStart < we) {
                   this.triggerTrackAttack(track.id, note.pitch, note.velocity, contextScheduleTime + (noteAbsStart - ws), note);
               } else if (firstWindow && lat > 0 && noteAbsStart >= projectWindowStart && noteAbsStart < ws) {
                   // Trop tard pour être calée : jouée tout de suite plutôt que perdue.
                   this.triggerTrackAttack(track.id, note.pitch, note.velocity, contextScheduleTime, note);
               }

               if (noteAbsEnd >= ws && noteAbsEnd < we) {
                   this.triggerTrackRelease(track.id, note.pitch, contextScheduleTime + (noteAbsEnd - ws));
               } else if (firstWindow && lat > 0 && noteAbsEnd >= projectWindowStart && noteAbsEnd < ws) {
                   this.triggerTrackRelease(track.id, note.pitch, contextScheduleTime);
               }
           });
        });
      });
  }
  
  /** Clés de contrôleurs présentes sur des clips (hors sustain, cuit dans les notes). */
  private ccKeysOf(clips: Clip[]): string[] {
    const keys = new Set<string>();
    for (const c of clips) {
      if (c.isMuted || !c.cc) continue;
      for (const [k, pts] of Object.entries(c.cc)) if (k !== SUSTAIN && pts && pts.length) keys.add(k);
    }
    return Array.from(keys);
  }

  /** Valeur d'un contrôleur au temps absolu t (le clip qui couvre t, sinon le dernier fini avant). */
  private ccValueOnTrack(clips: Clip[], key: string, t: number): number {
    let best: { start: number; v: number } | null = null;
    for (const c of clips) {
      if (c.isMuted || !c.cc?.[key]?.length || c.start > t + 1e-9) continue;
      const pts = sortPoints(c.cc[key]);
      const v = ccValueAt(pts, Math.min(t, c.start + c.duration) - c.start, ccDefault(key));
      if (!best || c.start >= best.start) best = { start: c.start, v };
    }
    return best ? best.v : ccDefault(key);
  }

  /** Lecture : contrôleurs des clips MIDI d'une piste dans la fenêtre [ws, we[ (temps du morceau). */
  private scheduleControllers(trackId: string, clips: Clip[], ws: number, we: number, contextScheduleTime: number, chase: boolean) {
    const keys = this.ccKeysOf(clips);
    if (!keys.length) return;
    if (chase) for (const k of keys) this.sendTrackController(trackId, k, this.ccValueOnTrack(clips, k, ws), contextScheduleTime);
    for (const c of clips) {
      if (c.isMuted || !c.cc || c.type !== TrackType.MIDI) continue;
      if (c.start >= we || c.start + c.duration <= ws) continue;
      for (const k of keys) {
        const pts = c.cc[k];
        if (!pts?.length) continue;
        for (const p of pts) {
          const at = c.start + p.t;
          if (p.t > c.duration + 1e-9 || at < ws || at >= we) continue;
          this.sendTrackController(trackId, k, p.v, contextScheduleTime + (at - ws));
        }
      }
    }
  }

  /** Export : tous les contrôleurs d'une piste (temps 0 du rendu = `from` du morceau). */
  private scheduleOfflineControllers(track: Track, synth: { setController(key: string, value: number, time: number): void }, from: number, totalDuration: number) {
    const clips = (isTrackFrozen(track) ? uncoveredClips(track) : (track.clips || [])).filter(c => c.type === TrackType.MIDI);
    const keys = this.ccKeysOf(clips);
    if (!keys.length) return;
    for (const k of keys) synth.setController(k, this.ccValueOnTrack(clips, k, from), 0);
    for (const c of clips) {
      if (c.isMuted || !c.cc) continue;
      for (const k of keys) {
        for (const p of c.cc[k] || []) {
          const at = c.start + p.t - from;
          if (p.t > c.duration + 1e-9 || at < 0 || at >= totalDuration) continue;
          synth.setController(k, p.v, at);
        }
      }
    }
  }

  /**
   * Contrôleur MIDI sur l'instrument d'une piste (R16) : clé « pb », « cc1 »,
   * « cc11 »… et valeur MIDI brute. Synthé NOVA et ancien synthé (pitch bend,
   * vibrato, expression, brillance). `time` : instant du contexte (0 = tout de suite).
   */
  public sendTrackController(trackId: string, key: string, value: number, time: number = 0) {
    if (!this.ctx) return;
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp || dsp.bass808) return;
    try { dsp.synth?.setController(key, value, Math.max(time, this.ctx.currentTime)); } catch { /* instrument sans contrôleurs */ }
    try { dsp.melodicSampler?.setController(key, value, Math.max(time, this.ctx.currentTime)); } catch { /* sampler */ }
  }

  /** `ex` : panoramique et hauteur propres à la note (R18, pas de la boîte à rythmes). */
  public triggerTrackAttack(trackId: string, pitch: number, velocity: number, time: number = 0, ex?: { pan?: number; tune?: number }) {
      if (!this.ctx) return;
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;
      
      const now = Math.max(time, this.ctx.currentTime);
      
      if (dsp.bass808) dsp.bass808.triggerAttack(pitch, velocity, now);
      else if (dsp.synth) dsp.synth.triggerAttack(pitch, velocity, now);
      else if (dsp.melodicSampler) dsp.melodicSampler.triggerAttack(pitch, velocity, now, ex);
      else if (dsp.drumSampler) dsp.drumSampler.trigger(velocity, now);
      else if (dsp.drumRack) dsp.drumRack.trigger(pitch, velocity, now, ex);
      else if (dsp.sampler) dsp.sampler.triggerAttack(pitch, velocity, now);
  }

  public triggerTrackRelease(trackId: string, pitch: number, time: number = 0) {
      if (!this.ctx) return;
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;
      
      const now = Math.max(time, this.ctx.currentTime);
      
      if (dsp.bass808) dsp.bass808.triggerRelease(pitch, now);
      else if (dsp.synth) dsp.synth.triggerRelease(pitch, now);
      else if (dsp.melodicSampler) dsp.melodicSampler.triggerRelease(pitch, now);
      else if (dsp.sampler) dsp.sampler.triggerRelease(pitch, now);
  }

  public previewMidiNote(trackId: string, pitch: number, duration: number = 0.5) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      this.triggerTrackAttack(trackId, pitch, 0.8, now);
      this.triggerTrackRelease(trackId, pitch, now + duration);
  }
  
  public loadSamplerBuffer(trackId: string, buffer: AudioBuffer) {
      const dsp = this.tracksDSP.get(trackId);
      if (dsp) {
          if (dsp.sampler) dsp.sampler.loadBuffer(buffer);
          if (dsp.drumSampler) dsp.drumSampler.loadBuffer(buffer);
          if (dsp.melodicSampler) dsp.melodicSampler.loadBuffer(buffer);
      }
  }

  public loadDrumRackSample(trackId: string, padId: number, buffer: AudioBuffer) {
      const dsp = this.tracksDSP.get(trackId);
      if (dsp && dsp.drumRack) {
          dsp.drumRack.loadSample(padId, buffer);
      }
  }
  
  public getDrumRackNode(trackId: string) { return this.tracksDSP.get(trackId)?.drumRack || null; }
  public getDrumSamplerNode(trackId: string) { return this.tracksDSP.get(trackId)?.drumSampler || null; }
  public getMelodicSamplerNode(trackId: string) { return this.tracksDSP.get(trackId)?.melodicSampler || null; }

  /** Sons chargés de chaque sampler (empreinte de samplerSoundSig) : rechargés seulement s'ils changent. */
  private samplerSigs = new Map<string, string>();
  private samplerLoading = new Set<string>();
  private samplerListeners = new Set<(trackId: string) => void>();
  /** Instrument / sample du sampler : (re)chargé si le son a changé ou n'était pas encore arrivé (collaboration, ouverture). */
  private refreshSamplerZones(trackId: string, s: import('../utils/melodicSampler').MelodicSamplerSettings, node: MelodicSamplerNode) {
    const sig = samplerSoundSig(s);
    if (this.samplerSigs.get(trackId) === sig && (node.hasSound() || this.samplerLoading.has(trackId))) return;
    if (!s.instrument && !s.sampleId) { node.setZones([]); this.samplerSigs.set(trackId, sig); return; }
    this.samplerSigs.set(trackId, sig);
    if (!this.ctx) return;
    this.samplerLoading.add(trackId);
    loadSamplerZones(s, this.ctx).then(z => {
      // Réponse périmée (le son a changé pendant le chargement) : ignorée.
      if (this.samplerSigs.get(trackId) !== sig || this.tracksDSP.get(trackId)?.melodicSampler !== node) return;
      node.setZones(z);
      this.samplerListeners.forEach(l => l(trackId));
    }).catch(() => { this.samplerSigs.delete(trackId); /* son indisponible : réessayé à la prochaine mise à jour */ })
      .finally(() => this.samplerLoading.delete(trackId));
  }
  /** Prévenu quand les sons d'un sampler sont prêts (écran du sampler). */
  public onSamplerReady(fn: (trackId: string) => void) { this.samplerListeners.add(fn); return () => { this.samplerListeners.delete(fn); }; }
  /** Recharge forcée (sample perso remplacé, son reçu d'un collaborateur) : à la prochaine mise à jour de la piste. */
  public reloadSampler(trackId: string) { this.samplerSigs.delete(trackId); }

  /**
   * Parametre audio pilote par une voie d'automation.
   *
   * L'editeur d'automation propose aussi les departs d'effets (« send::… »),
   * mais le moteur ne connaissait que volume et pan : creer une voie de depart
   * dessinait une enveloppe qui ne pilotait rien.
   */
  private cibleAutomation(
    nomParametre: string,
    gain: AudioParam,
    pan: AudioParam,
    sends: Map<string, GainNode>,
    pre?: AudioParam,
    strip?: StripNodes | null
  ): AudioParam | null {
    if (nomParametre === 'volume') return gain;
    // Tête de tranche (R11) : trim d'entrée (gain) et largeur stéréo.
    if (nomParametre === TRIM_PARAM || nomParametre === WIDTH_PARAM) return stripParam(strip, nomParametre);
    // Volume AVANT effets (tête de chaîne) : édité sur une piste gelée, il
    // attaque le compresseur et la reverb au dégel. Piste gelée : après le rendu.
    if (nomParametre === PRE_VOLUME) return pre || null;
    if (nomParametre === 'pan') return pan;
    if (nomParametre.startsWith('send::')) {
      const idDepart = nomParametre.slice('send::'.length);
      return sends.get(idDepart)?.gain || null;
    }
    return null;
  }

  /** Valeur d'une enveloppe d'automation a un instant donne, courbe comprise. */
  private valeurAutomationA(points: AutomationPoint[], temps: number): number {
    if (points.length === 0) return 1;
    if (temps <= points[0].time) return points[0].value;
    const dernier = points[points.length - 1];
    if (temps >= dernier.time) return dernier.value;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (temps >= a.time && temps <= b.time) {
        const duree = b.time - a.time;
        const r = duree > 0 ? (temps - a.time) / duree : 0;
        return interpolateCurve(a.value, b.value, r, a.curveType || 'LINEAR');
      }
    }
    return dernier.value;
  }

  /**
   * Programme un segment d'automation en suivant le type de courbe du point.
   *
   * Le moteur ne connaissait que la rampe lineaire : choisir « Exponential » ou
   * « S-Curve » changeait le trace affiche dans la voie d'automation, mais pas
   * le son. Les courbes non lineaires sont approchees par une suite de courtes
   * rampes lineaires, ce qui se compose proprement avec le reste de la
   * programmation (setValueCurveAtTime interdit tout autre evenement sur son
   * intervalle).
   */
  private programmerSegment(
    parametre: AudioParam,
    point: AutomationPoint,
    suivant: AutomationPoint,
    tDebut: number,
    tFin: number
  ) {
    const courbe = point.curveType || 'LINEAR';
    const duree = tFin - tDebut;

    // Palier : la valeur tient jusqu'au point suivant, ou elle saute.
    if (courbe === 'HOLD') {
      parametre.setValueAtTime(point.value, Math.max(tDebut, tFin - 0.001));
      parametre.setValueAtTime(suivant.value, tFin);
      return;
    }

    if (courbe === 'LINEAR' || duree <= 0) {
      parametre.linearRampToValueAtTime(suivant.value, tFin);
      return;
    }

    // Une marche toutes les 20 ms environ, borne pour rester raisonnable.
    const marches = Math.max(2, Math.min(128, Math.ceil(duree / 0.02)));
    for (let i = 1; i <= marches; i++) {
      const r = i / marches;
      parametre.linearRampToValueAtTime(
        interpolateCurve(point.value, suivant.value, r, courbe),
        tDebut + duree * r
      );
    }
  }

  // --- Automation écrite (Touch / Latch / Write / Trim) et paramètres d'effets ---------
  // Voir services/AutomationManager : pendant l'écriture, le paramètre suit le
  // fader (« override ») et la voie n'est plus rejouée ; au relâchement, elle
  // reprend depuis la position de lecture avec ses nouveaux points.
  private autoOverrides = new Map<string, number>();
  /** Dernière valeur envoyée à un effet (un appel par changement réel). */
  private pluginAutoSent = new Map<string, number>();
  /** AudioParam d'effets où l'automation est programmée d'avance en lecture (figés à l'arrêt). */
  private pluginAutoParams = new Set<AudioParam>();
  private sortedLaneCache = new WeakMap<AutomationPoint[], AutomationPoint[]>();

  private sortedOf(points: AutomationPoint[]): AutomationPoint[] {
    let s = this.sortedLaneCache.get(points);
    if (!s) { s = sortedPoints(points); this.sortedLaneCache.set(points, s); }
    return s;
  }

  public setAutomationOverride(trackId: string, param: string, value: number | null, points?: AutomationPoint[]) {
    const key = `${trackId}|${param}`;
    if (value === null) {
      if (this.autoOverrides.delete(key)) this.resumeAutomation(trackId, param, points);
      return;
    }
    this.autoOverrides.set(key, value);
    if (parsePluginParam(param)) {
      // Écriture : ce qui était programmé d'avance sur le réglage ne doit pas reprendre la main.
      const a = this.pluginAutoParam(trackId, param);
      if (a && this.ctx) { try { a.ap.cancelScheduledValues(this.ctx.currentTime); } catch { /* */ } }
      this.applyPluginAutomation(trackId, param, value);
      return;
    }
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp || !this.ctx) return;
    const track = this.liveTracks?.find(t => t.id === trackId);
    if (param === 'volume' && track && (track.isMuted || this.soloSilencedIds.has(trackId))) return;
    const cible = this.cibleAutomation(param, dsp.gain.gain, dsp.panner.pan, dsp.sends, this.preParam(dsp), dsp.strip);
    if (!cible) return;
    const now = this.ctx.currentTime;
    try { cible.cancelScheduledValues(now); cible.setTargetAtTime(value, now, 0.01); } catch { /* valeur hors limites */ }
  }

  /** Paramètre écrit ou automatisé pendant la lecture : le réglage statique ne s'applique pas. */
  private automationOwns(track: Track, param: string): boolean {
    if (this.autoOverrides.has(`${track.id}|${param}`)) return true;
    return this.isPlaying && playedLanes(track).some(l => l.parameterName === param && l.points.length > 0);
  }

  /** Valeur à appliquer à un paramètre : écrite, automatisée, sinon le réglage de la piste. */
  private automatedValue(track: Track, param: string, stat: number): number {
    const key = `${track.id}|${param}`;
    if (this.autoOverrides.has(key)) return this.autoOverrides.get(key)!;
    if (!this.isPlaying) return stat;
    const lane = playedLanes(track).find(l => l.parameterName === param && l.points.length > 0);
    return lane ? this.valeurAutomationA(this.sortedOf(lane.points), this.getCurrentTime()) : stat;
  }

  /** Fin d'écriture : la voie reprend depuis la position de lecture (rampe vers le point suivant comprise). */
  private resumeAutomation(trackId: string, param: string, points?: AutomationPoint[]) {
    if (!this.ctx) return;
    const track = this.liveTracks?.find(t => t.id === trackId);
    const lane = track && playedLanes(track).find(l => l.parameterName === param);
    if (track && !lane && !points) return;
    const pts = sortedPoints(points ?? lane?.points ?? []);
    if (!pts.length || (track && !playedLanes(track).length)) return;
    const time = this.getCurrentTime();
    if (parsePluginParam(param)) { this.applyPluginAutomation(trackId, param, valueAtPoints(pts, time, 0)); return; }
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return;
    if (param === 'volume' && track && (track.isMuted || this.soloSilencedIds.has(trackId))) return;
    const cible = this.cibleAutomation(param, dsp.gain.gain, dsp.panner.pan, dsp.sends, this.preParam(dsp), dsp.strip);
    if (!cible) return;
    const now = this.ctx.currentTime;
    const t0 = now + 0.01;
    const v = this.valeurAutomationA(pts, time);
    try {
      cible.cancelScheduledValues(now);
      cible.setValueAtTime(cible.value, now);
      cible.linearRampToValueAtTime(v, t0);
      if (!this.isPlaying) return;
      // Les points entre maintenant et la fenêtre déjà planifiée ont été sautés pendant l'écriture.
      const base = this.playbackStartTime;
      const horizon = this.nextScheduleTime - base;
      const i = pts.findIndex(p => p.time > time + 0.01);
      if (i < 0) return;
      this.programmerSegment(cible, { ...pts[Math.max(0, i - 1)], time, value: v }, pts[i], t0, Math.max(t0, base + pts[i].time));
      for (let k = i; k < pts.length && pts[k].time < horizon; k++) {
        const at = Math.max(t0, base + pts[k].time);
        cible.setValueAtTime(pts[k].value, at);
        const nx = pts[k + 1];
        if (nx) this.programmerSegment(cible, pts[k], nx, at, Math.max(at, base + nx.time));
      }
    } catch { /* paramètre déjà libéré */ }
  }

  /** Paramètre d'un effet : natif (updateParams) ou VST3 du pont (R9 : valeur brute posée tout de suite). */
  private applyPluginAutomation(trackId: string, param: string, value: number) {
    const p = parsePluginParam(param);
    if (!p || !Number.isFinite(value)) return;
    const key = `${trackId}|${param}`;
    if (this.pluginAutoSent.get(key) === value) return;
    const inst = this.tracksDSP.get(trackId)?.pluginChain.get(p.pluginId)?.instance;
    if (inst instanceof VSTPluginNode) {
      this.pluginAutoSent.set(key, value);
      inst.setParamNow(p.key, value);
      return;
    }
    if (!inst || typeof inst.updateParams !== 'function') return;
    this.pluginAutoSent.set(key, value);
    try { inst.updateParams({ [p.key]: value }); } catch { /* effet en cours de reconstruction */ }
  }

  /**
   * Avance (s) d'un effet sur le temps du projet : latence de l'effet et des
   * effets qui le suivent sur la piste. Avec la compensation (PDC), les clips
   * partent en avance de la latence de la chaîne : à l'instant t, l'entrée de
   * cet effet reçoit le son du projet à t + avance. Son automation doit donc
   * lire la voie à t + avance pour tomber pile sur la musique (sinon, mesuré,
   * le limiteur appliquait son plafond 3,6 ms trop tard). La latence en aval
   * de la piste (bus latent : les clips partent aussi en avance d'autant)
   * s'y ajoute.
   */
  private pluginLead(trackId: string, pluginId: string): number {
    if (this.pdcSuspended) return 0;
    const dsp = this.tracksDSP.get(trackId);
    const ids = dsp?.chainIds || [];
    const i = ids.indexOf(pluginId);
    if (!dsp || i < 0) return 0;
    let lead = dsp.downLatency || 0;
    for (let k = i; k < ids.length; k++) {
      const l = dsp.pluginChain.get(ids[k])?.instance?.latency;
      if (typeof l === 'number' && l > 0 && l < 0.5) lead += l;
    }
    return lead;
  }

  // -------------------------------------------------------------------------
  // Piste d'accords suivie par l'Harmoniseur
  // -------------------------------------------------------------------------

  /** Accords du projet (piste d'accords), publiés par l'application. */
  private chords: ChordEvent[] = [];
  public setChords(list: ChordEvent[] | undefined) { this.chords = Array.isArray(list) ? list : []; }
  public getChords() { return this.chords; }

  /**
   * Lecture : programme d'avance, sur l'AudioParam « chord » de chaque
   * Harmoniseur, l'accord que reçoit son entrée pendant la fenêtre
   * [when, when + (end − start)[. Comme les clips (partis en avance de la
   * latence) et l'automation des effets (pluginLead) : à l'instant τ,
   * l'entrée de l'effet reçoit le son du projet à τ − when + start + avance,
   * avance = latence de l'effet et des effets suivants + latence en aval de
   * la piste (bus). La fenêtre lit donc la piste d'accords sur
   * [start + avance, end + avance[ : tout est dans le futur, rien n'est
   * sauté même quand la latence dépasse l'avance du planificateur (mesuré :
   * sinon le changement d'accord arrivait jusqu'à 11 ms trop tard en
   * lecture). Chaque fenêtre efface ce qui suivait (arrêt, saut, boucle).
   */
  private scheduleChordFollow(start: number, end: number, when: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.tracksDSP.forEach((dsp, trackId) => {
      dsp.pluginChain.forEach((entry, pluginId) => {
        const inst = entry.instance;
        if (!inst || typeof inst.chordParam !== 'function') return;
        const ap: AudioParam | null = inst.chordParam();
        if (!ap) return;
        const lead = this.pluginLead(trackId, pluginId);
        const from = Math.max(now, when);
        const steps = chordSteps(inst.followsChords() ? this.chords : [], start + lead, end + lead);
        try {
          ap.cancelScheduledValues(from);
          ap.setValueAtTime(steps[0].code, from);
          for (let k = 1; k < steps.length; k++) {
            const at = when + (steps[k].t - lead - start);
            if (at >= from) ap.setValueAtTime(steps[k].code, at);
          }
        } catch { /* effet en cours de reconstruction */ }
      });
    });
  }

  /**
   * Export : la piste d'accords est programmée d'avance sur l'AudioParam
   * « chord » de chaque Harmoniseur du rendu (temps du contexte = temps du
   * projet − startOffset − avance), sans pause du rendu.
   */
  private scheduleOfflineChords(tracks: Track[], rendered: Map<string, { pluginNodes?: Map<string, any>; down?: number }>, totalDuration: number, startOffset: number) {
    for (const track of tracks) {
      const rt = rendered.get(track.id);
      const nodes = rt?.pluginNodes;
      if (!nodes) continue;
      let acc = 0;
      const lead = new Map<string, number>();
      for (const [id, n] of [...nodes.entries()].reverse()) {
        const l = n?.latency;
        if (typeof l === 'number' && l > 0 && l < 0.5) acc += l;
        lead.set(id, acc);
      }
      nodes.forEach((node, id) => {
        if (!node || typeof node.chordParam !== 'function') return;
        const ap: AudioParam | null = node.chordParam();
        if (!ap) return;
        const from = startOffset + (lead.get(id) || 0) + (rt?.down || 0);
        const steps = chordSteps(node.followsChords() ? this.chords : [], from, from + totalDuration);
        try {
          ap.cancelScheduledValues(0);
          ap.setValueAtTime(steps[0].code, 0);
          for (let k = 1; k < steps.length; k++) ap.setValueAtTime(steps[k].code, steps[k].t - from);
        } catch { /* */ }
      });
    }
  }

  /** AudioParam d'un réglage d'effet automatisable (limiteur, effets V21), et son avance PDC. */
  private pluginAutoParam(trackId: string, param: string): { ap: AudioParam; lead: number } | null {
    const pp = parsePluginParam(param);
    if (!pp) return null;
    const inst = this.tracksDSP.get(trackId)?.pluginChain.get(pp.pluginId)?.instance;
    // VST3 (R9) : AudioParam du worklet du pont, valeurs envoyées avec l'audio à l'échantillon près.
    if (!inst || typeof inst.automationParam !== 'function') return null;
    let ap: AudioParam | null = null;
    try { ap = inst.automationParam(pp.key); } catch { ap = null; }
    return ap ? { ap, lead: this.pluginLead(trackId, pp.pluginId) } : null;
  }

  /**
   * Lecture : voie d'automation d'un effet programmée D'AVANCE sur son AudioParam
   * pour la fenêtre [start, end[ du morceau (comme à l'export, au bloc près),
   * au lieu d'un minuteur (≈ 10 ms d'écart, mesuré). Un point du morceau à T
   * s'applique à l'instant base + T − avance (PDC).
   */
  private programPluginWindow(ap: AudioParam, pts: AutomationPoint[], start: number, end: number, when: number, lead: number) {
    const base = when - start;
    try {
      for (let k = 0; k < pts.length; k++) {
        const tp = pts[k].time - lead;
        if (tp < start || tp >= end) continue;
        const at = base + tp;
        ap.setValueAtTime(pts[k].value, at);
        const nx = pts[k + 1];
        if (nx) this.programmerSegment(ap, pts[k], nx, at, base + nx.time - lead);
      }
      this.pluginAutoParams.add(ap);
    } catch { /* valeur hors limites : le réglage de l'effet reste */ }
  }

  /** Départ de lecture / bouclage : valeur à `time` posée à l'instant `at`, puis le segment en cours. */
  private programPluginStart(ap: AudioParam, pts: AutomationPoint[], time: number, at: number, lead: number) {
    try {
      ap.cancelScheduledValues(at);
      const t = time + lead;
      const v = valueAtPoints(pts, t, 0);
      ap.setValueAtTime(v, at);
      const i = pts.findIndex(pt => pt.time > t);
      if (i > 0) this.programmerSegment(ap, { ...pts[i - 1], time: t, value: v }, pts[i], at, at + (pts[i].time - t));
      this.pluginAutoParams.add(ap);
    } catch { /* */ }
  }

  private schedulePluginAutomation(trackId: string, param: string, points: AutomationPoint[], start: number, when: number, end?: number) {
    const a = end !== undefined ? this.pluginAutoParam(trackId, param) : null;
    if (a) { this.programPluginWindow(a.ap, this.sortedOf(points), start, end!, when, a.lead); return; }
    const pp = parsePluginParam(param);
    const v = valueAtPoints(this.sortedOf(points), start + (pp ? this.pluginLead(trackId, pp.pluginId) : 0), 0);
    const key = `${trackId}|${param}`;
    if (this.pluginAutoSent.get(key) === v || !this.ctx) return;
    const delay = Math.max(0, (when - this.ctx.currentTime) * 1000);
    window.setTimeout(() => {
      if (this.isPlaying && !this.autoOverrides.has(key)) this.applyPluginAutomation(trackId, param, v);
    }, delay);
  }

  /**
   * Export : l'automation des effets est appliquée pendant le rendu hors ligne,
   * par pauses du contexte (toutes les 20 ms, seulement quand la valeur change),
   * en avance de la latence de l'effet et des effets qui le suivent (PDC :
   * voir pluginLead). Les effets natifs lisent leurs réglages automatisables
   * dans des AudioParam : la valeur posée pendant la pause vaut dès le bloc
   * suivant (un message du port arrivait après la reprise du rendu).
   */
  private scheduleOfflinePluginAutomation(
    offlineCtx: OfflineAudioContext, tracks: Track[],
    rendered: Map<string, { pluginNodes?: Map<string, any>; down?: number }>, totalDuration: number, startOffset: number
  ) {
    const STEP = 0.02;
    const quantum = 128 / offlineCtx.sampleRate;
    const events = new Map<number, (() => void)[]>();
    for (const track of tracks) {
      if (track.isMuted) continue;
      const nodes = rendered.get(track.id)?.pluginNodes;
      if (!nodes) continue;
      // Avance de chaque effet : sa latence + celle des effets suivants (même filtre que le PDC du rendu).
      const lead = new Map<string, number>();
      let acc = 0;
      for (const [id, n] of [...nodes.entries()].reverse()) {
        const l = n?.latency;
        if (typeof l === 'number' && l > 0 && l < 0.5) acc += l;
        lead.set(id, acc);
      }
      for (const lane of playedLanes(track)) {
        const p = parsePluginParam(lane.parameterName);
        const node = p && nodes.get(p.pluginId);
        if (!p || !lane.points.length || !node || typeof node.updateParams !== 'function' || node instanceof VSTPluginNode) continue;
        const pts = this.sortedOf(lane.points);
        const from = startOffset + (lead.get(p.pluginId) || 0) + (rendered.get(track.id)?.down || 0);
        // Réglage exposé en AudioParam (limiteur) : toute la voie est programmée
        // d'avance sur le paramètre, sans pause du rendu (rampes exactes, au bloc près).
        const ap: AudioParam | null = typeof node.automationParam === 'function' ? node.automationParam(p.key) : null;
        if (ap) { this.programmerVoieHorsLigne(ap, pts, from, totalDuration); continue; }
        let last = valueAtPoints(pts, from, 0);
        try { node.updateParams({ [p.key]: last }); } catch { /* */ }
        // Grille de 20 ms + instants exacts des points (un palier tombe au bloc près, pas à 20 ms près).
        const times: number[] = [];
        for (let t = STEP; t < totalDuration; t += STEP) times.push(t);
        for (const pt of pts) { const t = pt.time - from; if (t > 0 && t < totalDuration) times.push(t); }
        times.sort((x, y) => x - y);
        for (const t of times) {
          const v = valueAtPoints(pts, from + t, 0);
          if (Math.abs(v - last) < 1e-6) continue;
          last = v;
          const q = Math.round(t / quantum) * quantum;
          if (q <= 0 || q >= totalDuration) continue;
          const list = events.get(q) || [];
          list.push(() => { try { node.updateParams({ [p.key]: v }); } catch { /* */ } });
          events.set(q, list);
        }
      }
    }
    for (const [q, list] of events) {
      offlineCtx.suspend(q).then(() => { list.forEach(fn => fn()); return offlineCtx.resume(); }).catch(() => { /* */ });
    }
  }

  /** Voie d'automation programmée sur un AudioParam d'un rendu hors ligne (temps du contexte = temps du projet − from). */
  private programmerVoieHorsLigne(ap: AudioParam, pts: AutomationPoint[], from: number, totalDuration: number) {
    try {
      ap.cancelScheduledValues(0);
      ap.setValueAtTime(valueAtPoints(pts, from, 0), 0);
      const i0 = pts.findIndex(pt => pt.time > from);
      if (i0 < 0) return;
      // Segment en cours au départ : il repart de la valeur à `from`.
      if (i0 > 0) this.programmerSegment(ap, { ...pts[i0 - 1], time: from, value: valueAtPoints(pts, from, 0) }, pts[i0], 0, pts[i0].time - from);
      else ap.setValueAtTime(pts[0].value, pts[0].time - from);
      for (let k = i0; k < pts.length; k++) {
        const at = pts[k].time - from;
        if (at > totalDuration) break;
        ap.setValueAtTime(pts[k].value, at);
        const nx = pts[k + 1];
        if (nx) this.programmerSegment(ap, pts[k], nx, at, nx.time - from);
      }
    } catch { /* valeur hors limites : le réglage de l'effet reste */ }
  }

  private scheduleAutomation(tracks: Track[], start: number, end: number, when: number) {
    tracks.forEach(track => {
        const dsp = this.tracksDSP.get(track.id);
        if (!dsp) return;
        // L'automation partage le noeud de gain avec le fader/mute/solo : sans ce
        // garde-fou, une piste mutee (ou coupee par un solo) redevenait audible
        // des qu'elle portait de l'automation de volume.
        if (track.isMuted || this.soloSilencedIds.has(track.id)) return;

        // Mode Off : rien n'est rejoué ; un paramètre en cours d'écriture suit le fader.
        playedLanes(track).forEach(lane => {
            if (lane.points.length === 0 || this.autoOverrides.has(`${track.id}|${lane.parameterName}`)) return;
            if (parsePluginParam(lane.parameterName)) { this.schedulePluginAutomation(track.id, lane.parameterName, lane.points, start, when, end); return; }
            if (isMuteParam(lane.parameterName)) {
              // Mute automatisé (R8) : programmé d'avance, en paliers, calé sur la PDC de la piste.
              if (dsp.preFaderTap) this.programPluginWindow(dsp.preFaderTap.gain, muteGainPoints(lane.points), start, end, when, this.pdcSuspended ? 0 : (dsp.downLatency || 0));
              return;
            }

            lane.points.forEach((point, index) => {
                if (point.time >= start && point.time < end) {
                    const scheduleTime = when + (point.time - start);
                    
                    const ancre = this.cibleAutomation(lane.parameterName, dsp.gain.gain, dsp.panner.pan, dsp.sends, this.preParam(dsp), dsp.strip);
                    if (ancre) ancre.setValueAtTime(point.value, scheduleTime);
                    
                    const nextPoint = lane.points[index + 1];
                    if (nextPoint) {
                        // On programme la rampe meme si le point suivant sort de la
                        // fenetre : sinon la valeur restait en palier jusqu'a lui.
                        const nextScheduleTime = when + (nextPoint.time - start);
                        const cible = this.cibleAutomation(lane.parameterName, dsp.gain.gain, dsp.panner.pan, dsp.sends, this.preParam(dsp), dsp.strip);
                        if (cible) {
                            this.programmerSegment(cible, point, nextPoint, scheduleTime, nextScheduleTime);
                        }
                    }
                }
            });
        });
    });
}
  private playClipSource(trackId: string, clip: Clip, scheduleTime: number, projectTime: number) {
    if (!this.ctx) return;

    let buffer = clip.buffer;
    if (!buffer && clip.bufferId) {
        buffer = audioBufferRegistry.get(clip.bufferId);
    }
    
    if (!buffer) {
        // console.warn(`[AudioEngine] Buffer for clip ${clip.id} not found. AudioRef: ${clip.audioRef}`);
        return;
    }
    
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return;
    
    if (clip.isMuted) return;
    
    const sourceKey = `${clip.id}`;
    if (this.activeSources.has(sourceKey)) return;
    
    try {
        const source = this.ctx.createBufferSource();
        let bufferToPlay = buffer;
        
        if (clip.isReversed) {
            // Le buffer inverse etait reconstruit a CHAQUE declenchement : sur un
            // clip de plusieurs minutes cela recopiait des millions d'echantillons
            // a chaque tour de boucle. On le met en cache.
            const cacheKey = clip.bufferId || clip.id;
            let reversed = this.reversedBufferCache.get(cacheKey);
            if (!reversed || reversed.length !== buffer.length) {
                reversed = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
                for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                    const original = buffer.getChannelData(ch);
                    const reversedData = reversed.getChannelData(ch);
                    for (let i = 0; i < original.length; i++) {
                        reversedData[i] = original[original.length - 1 - i];
                    }
                }
                this.reversedBufferCache.set(cacheKey, reversed);
            }
            bufferToPlay = reversed;
        }
        
        source.buffer = bufferToPlay;
        
        const gainNode = this.ctx.createGain();
        const clipGain = clip.gain ?? 1.0;
        source.connect(gainNode);
        // Clip gele : il contient deja les effets rendus, il entre apres eux.
        const isFrozenRender = !!dsp.frozenClipId && (clip.id === dsp.frozenClipId || !!clip.isFreezeSlice) && !!dsp.frozenInput;
        gainNode.connect(isFrozenRender ? dsp.frozenInput! : dsp.input);
        
        // Compensation de latence : sans elle, une voix passée dans l'Auto-Tune
        // (~27 ms) arrivait en retard sur le beat.
        // Pendant une prise, la compensation est suspendue (pistes lourdes figées).
        const pt = projectTime + (this.pdcSuspended ? 0 : (((isFrozenRender ? dsp.postFreezeLatency : dsp.pluginLatency) || 0) + (dsp.downLatency || 0)));
        let offsetIntoClip = clip.offset || 0;
        if (pt > clip.start) {
            offsetIntoClip += (pt - clip.start);
        }
        
        let when = scheduleTime;
        if (pt < clip.start) {
            when = scheduleTime + (clip.start - pt);
        }
        
        const playedSoFar = Math.max(0, offsetIntoClip - (clip.offset || 0));
        const remainingDuration = clip.duration - playedSoFar;

        // Fondus calés sur la position RÉELLE dans le clip (comme le rendu
        // offline). Avant, ils partaient de l'instant de planification : en
        // lançant la lecture au milieu d'un clip, le fondu de sortie tombait
        // après la fin du clip et chaque reprise créait un faux fondu d'entrée.
        // Courbes de fondu (linéaire, puissance égale, exponentielle, en S) et
        // crossfades : même plan de gain qu'à l'export (utils/fades).
        const clipZero = when - playedSoFar;               // instant où le clip serait à 0
        applyGainEvents(gainNode.gain, clipGainEvents({ ...clip, gain: clipGain }, playedSoFar), clipZero);
        
        if (remainingDuration > 0 && offsetIntoClip < bufferToPlay.duration) {
            const actualDuration = Math.min(remainingDuration, bufferToPlay.duration - offsetIntoClip);
            source.start(when, offsetIntoClip, actualDuration);
            
            this.activeSources.set(sourceKey, { source, gain: gainNode, clipId: clip.id });
            
            source.onended = () => {
                // Apres un bouclage la meme cle peut deja pointer vers une NOUVELLE
                // source : on ne supprime que si l'entree correspond bien a celle-ci.
                const current = this.activeSources.get(sourceKey);
                if (current && current.source === source) this.activeSources.delete(sourceKey);
                try { source.disconnect(); gainNode.disconnect(); } catch (e) {}
            };
        } else {
            // Rien à jouer (fin du clip dépassée) : les nœuds créés ne restent pas branchés.
            try { source.disconnect(); gainNode.disconnect(); } catch (e) {}
        }
        
    } catch (error) {
        console.error(`[AudioEngine] Error playing clip ${clip.id}:`, error);
    }
}
  /**
   * @param targetCtx contexte a utiliser (permet de reconstruire la meme chaine
   *                  d'effets dans un OfflineAudioContext pour l'export).
   */
  private createPluginNode(plugin: PluginInstance, bpm: number, targetCtx?: AudioContext): { input: GainNode; output: GainNode; node: any } | null {
    const ctx = targetCtx || this.ctx;
    if (!ctx) return null;
    
    let node: any = null;
    
    switch (plugin.type) {
      case 'REVERB': node = new ReverbNode(ctx); break;
      case 'DELAY': node = new SyncDelayNode(ctx, bpm); break;
      case 'COMPRESSOR': node = new CompressorNode(ctx); break;
      // Autotune du PC (Auto-Tune Pro, MetaTune… via le pont) si l'artiste l'a
      // choisi, sinon celui de NOVA (repli automatique, voir HybridAutoTuneNode).
      case 'AUTOTUNE': node = new HybridAutoTuneNode(ctx, plugin); break;
      case 'CHORUS': node = new ChorusNode(ctx); break;
      case 'FLANGER': node = new FlangerNode(ctx); break;
      case 'DOUBLER': node = new VocalDoublerNode(ctx); break;
      case 'STEREOSPREADER': node = new StereoSpreaderNode(ctx); break;
      case 'DEESSER': node = new DeEsserNode(ctx); break;
      case 'DENOISER': node = new DenoiserNode(ctx); break;
      case 'PROEQ12':
        const eqDefaultParams = { isEnabled: true, masterGain: 1.0, bands: Array.from({ length: 12 }, (_, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency: [80,150,300,500,1000,2000,4000,6000,8000,10000,12000,18000][i], gain: 0, q: 1.0, isEnabled: true, isSolo: false })) };
        const eqParams = plugin.params && plugin.params.bands ? plugin.params : eqDefaultParams;
        node = new ProEQ12Node(ctx, eqParams as any);
        break;
      case 'VOCALSATURATOR': node = new VocalSaturatorNode(ctx); break;
      case 'MASTERSYNC': node = new MasterSyncNode(ctx); break;
      // Effet VST3 du PC via le pont local (passe-plat sans pont ou hors ligne).
      // Melodyne / VocAlign en insert (ARA, comme Pro Tools) : le plugin joue les clips de la piste.
      case 'VST3': node = isAraInsert(plugin) ? new AraInsertNode(ctx, plugin) : new VSTPluginNode(ctx, plugin); break;
      default: {
        // Effets déclarés dans le registre (engine/pluginRegistry.ts), ex. le limiteur NOVA.
        const reg = getRegisteredPlugin(plugin.type);
        if (reg) { node = reg.create(ctx, plugin, bpm); break; }
      }
        const bypassIn = ctx.createGain();
        const bypassOut = ctx.createGain();
        bypassIn.connect(bypassOut);
        return { input: bypassIn, output: bypassOut, node: { updateParams: () => {} } };
    }
    
    if (node && node.input && node.output) {
      if (node.updateParams) node.updateParams({ ...plugin.params, isEnabled: plugin.isEnabled });
      return { input: node.input, output: node.output, node };
    }
    
    return null;
  }

  /**
   * Cree (si besoin) la chaine DSP d'une piste sans la cabler.
   * Appele pour TOUTES les pistes avant le cablage afin qu'une piste
   * puisse toujours trouver la DSP de sa destination (bus / master),
   * quel que soit l'ordre du tableau de pistes.
   */
  private ensureTrackDSP(track: Track) {
    if (!this.ctx) return null;
    let dsp = this.tracksDSP.get(track.id);
    if (dsp) return dsp;

    dsp = {
      input: this.ctx.createGain(),
      output: this.ctx.createGain(),
      gain: this.ctx.createGain(),
      panner: this.ctx.createStereoPanner(),
      analyzer: this.ctx.createAnalyser(),
      pluginChain: new Map(),
      sends: new Map(),
      inputAnalyzer: this.ctx.createAnalyser()
    };

    if (track.type === TrackType.MIDI && track.melodicSampler) {
      dsp.melodicSampler = new MelodicSamplerNode(this.ctx);
      dsp.melodicSampler.output.connect(dsp.input);
    } else if (track.type === TrackType.MIDI && track.bass808) {
      dsp.bass808 = new Bass808Node(this.ctx, track.bass808.style);
      dsp.bass808.output.connect(dsp.input);
    } else if (track.type === TrackType.MIDI) {
      dsp.synth = makeTrackSynth(this.ctx, track);
      dsp.synth.output.connect(dsp.input);
    }
    if (track.type === TrackType.SAMPLER) {
      dsp.sampler = new AudioSampler(this.ctx, this.currentBpm);
      dsp.sampler.output.connect(dsp.input);
    }
    if (track.type === TrackType.DRUM_RACK) {
      dsp.drumRack = new DrumRackNode(this.ctx);
      dsp.drumRack.output.connect(dsp.input);
    }
    // Chaine forcee en stereo des l'entree de piste.
    // Sans ca, une source MONO restait mono jusqu'au panoramique, qui lui
    // appliquait sa loi equi-puissance (-3 dB au centre). Des qu'un plugin
    // convertissait le signal en stereo, cette attenuation disparaissait : poser
    // un effet, meme regle transparent, rendait la piste 3 dB plus forte.
    // Mesure avant correction : mono 0.1225 sans plugin contre 0.1724 avec.
    dsp.input.channelCount = 2;
    dsp.input.channelCountMode = 'explicit';
    dsp.input.channelInterpretation = 'speakers';

    this.tracksDSP.set(track.id, dsp);
    return dsp;
  }

  private isSourceTrackType(t: Track): boolean {
    return t.type === TrackType.AUDIO || t.type === TrackType.MIDI ||
           t.type === TrackType.SAMPLER || t.type === TrackType.DRUM_RACK;
  }

  /**
   * Pistes sources a couper quand au moins une piste est soloee.
   * On garde audibles les pistes soloees ET tout ce qui les alimente (sortie ou
   * depart d'effet) ; les bus et departs ne sont jamais coupes, sinon soloer une
   * piste audio couperait le bus par lequel elle passe.
   */
  private computeSoloSilencedIds(tracks: Track[]): Set<string> {
    // Règle pure (utils/soloMute) : pistes soloées + tout ce qui les alimente audibles ;
    // bus et retours jamais coupés ; pistes solo safe jamais coupées.
    return soloSilencedIds(tracks, t => this.isSourceTrackType(t));
  }

  /** Tout ce qui impose de recabler le graphe de la piste. */
  private graphSignatureOf(track: Track, extra = ''): string {
    return [
      extra,
      track.type,
      isTrackFrozen(track)
        ? `frozen:${freezeIndex(track)}:${uncoveredClips(track).length > 0 ? 1 : 0}:${track.frozenClip!.id}`
        : 'live',
      track.outputTrackId || '',
      track.plugins.map(p => `${p.id}:${p.isInactive ? 'x' : p.isEnabled ? 1 : 0}`).join(','),
      (track.sends || []).map(sd => `${sd.id}:${sd.isEnabled ? 1 : 0}${sd.preFader ? ':pre' : ''}${typeof sd.pan === 'number' ? ':pan' : ''}`).join(',')
    ].join('|');
  }

  /**
   * Libere la chaine DSP d'une piste supprimee. Sans ca elle restait connectee a
   * sa destination : une piste (ou un bus d'effet) supprimee continuait de sonner
   * pour le reste de la session.
   */
  public disposeTrack(trackId: string) {
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return;

    try { dsp.synth?.releaseAll(); } catch (e) {}
    try { dsp.bass808?.stopAll(); } catch (e) {}
    try { dsp.sampler?.stopAll(); } catch (e) {}
    try { dsp.drumSampler?.stop(); } catch (e) {}
    try { dsp.melodicSampler?.stopAll(); } catch (e) {}

    dsp.pluginChain.forEach(entry => {
      try { entry.input.disconnect(); entry.output.disconnect(); } catch (e) {}
      try { entry.bypassDelay?.disconnect(); } catch (e) {}
      // Avant dispose() : certains effets oublient leur worklet en se libérant.
      retireWorkletsOf(entry.instance);
      try { entry.instance?.dispose?.(); } catch (e) {}
    });
    dsp.pluginChain.clear();
    retireWorkletsOf(dsp.synth);
    retireWorkletsOf(dsp.bass808);

    dsp.sends.forEach(g => { try { g.disconnect(); } catch (e) {} });
    dsp.sends.clear();

    dsp.sendDelays?.forEach(n => { try { n.disconnect(); } catch (e) {} });
    dsp.sendPanners?.forEach(n => { try { n.disconnect(); } catch (e) {} });
    [dsp.input, dsp.chainOut, dsp.preFaderTap, dsp.gain, dsp.panner, dsp.analyzer, dsp.output, dsp.inputAnalyzer, dsp.outDelay]
      .forEach(n => { try { n?.disconnect(); } catch (e) {} });
    meterBank.detachTrack(trackId);
    disposeStrip(dsp.strip);

    this.tracksDSP.delete(trackId);
    this.recomputePdc();
  }

  public updateTrack(track: Track, allTracks: Track[]) {
    if (!this.ctx) return;
    // Structure Pro Tools (utils/trackStructure) : piste inactive, dossier simple
    // ou VCA = rien dans le moteur ; Muet / Solo de dossier, VCA et bus nommés résolus.
    {
      const src = allTracks.find(t => t.id === track.id) === track ? allTracks : allTracks.map(t => (t.id === track.id ? track : t));
      const view = engineView(src);
      this.vcaScale = view.vcaScale;
      const played = view.byId.get(track.id);
      if (!played) { if (this.tracksDSP.has(track.id)) this.disposeTrack(track.id); return; }
      track = played;
      allTracks = view.tracks;
    }
    track = this.eff(track);

    // Pre-cree les DSP de toutes les pistes: sinon une piste routee vers un bus
    // declare APRES elle dans le tableau retombait silencieusement sur le master.
    allTracks.forEach(t => this.ensureTrackDSP(t));
    this.soloSilencedIds = this.computeSoloSilencedIds(allTracks);

    const dsp = this.ensureTrackDSP(track);
    if (!dsp) return;

    // Sampler mélodique (R18) / instrument multi-échantillons (R20) : prend la place du synthé.
    if (track.type === TrackType.MIDI && track.melodicSampler) {
      if (!dsp.melodicSampler) {
        try { dsp.synth?.releaseAll(); dsp.synth?.output.disconnect(); } catch (e) {}
        try { dsp.bass808?.stopAll(); dsp.bass808?.output.disconnect(); } catch (e) {}
        const old = dsp.synth;
        if (old) setTimeout(() => { retireWorkletsOf(old); try { if (old instanceof NovaSynthNode) old.destroy(); } catch (e) {} }, 60);
        dsp.synth = undefined; dsp.bass808 = undefined;
        dsp.melodicSampler = new MelodicSamplerNode(this.ctx);
        dsp.melodicSampler.output.connect(dsp.input);
      }
      dsp.melodicSampler.setSettings(track.melodicSampler);
      this.refreshSamplerZones(track.id, track.melodicSampler, dsp.melodicSampler);
    } else if (track.type === TrackType.MIDI && dsp.melodicSampler) {
      try { dsp.melodicSampler.stopAll(); dsp.melodicSampler.output.disconnect(); dsp.melodicSampler.dispose(); } catch (e) {}
      dsp.melodicSampler = undefined;
      this.samplerSigs.delete(track.id);
      if (!track.bass808) { dsp.synth = makeTrackSynth(this.ctx, track); dsp.synth.output.connect(dsp.input); }
    }
    // Piste MIDI : synthé ou 808 selon track.bass808 (peut changer : annuler, collaboration).
    if (track.type === TrackType.MIDI && !track.melodicSampler) {
      if (track.bass808 && !dsp.bass808) {
        try { dsp.synth?.releaseAll(); dsp.synth?.output.disconnect(); } catch (e) {}
        dsp.synth = undefined;
        dsp.bass808 = new Bass808Node(this.ctx, track.bass808.style);
        dsp.bass808.output.connect(dsp.input);
      } else if (!track.bass808 && dsp.bass808) {
        try { dsp.bass808.stopAll(); dsp.bass808.output.disconnect(); } catch (e) {}
        dsp.bass808 = undefined;
        dsp.synth = makeTrackSynth(this.ctx, track);
        dsp.synth.output.connect(dsp.input);
      }
      if (track.bass808 && dsp.bass808) {
        dsp.bass808.setStyle(track.bass808.style);
        dsp.bass808.setGlideTime(track.bass808.glideTime);
      }
      // Synthé NOVA <-> ancien synthé (choix d'un préréglage, annuler, collaboration).
      if (!track.bass808 && dsp.synth) {
        const wantNova = !!track.novaSynth;
        if (wantNova !== (dsp.synth instanceof NovaSynthNode)) {
          const old = dsp.synth;
          try { old.releaseAll(); } catch (e) {}
          setTimeout(() => { retireWorkletsOf(old); try { old.output.disconnect(); if (old instanceof NovaSynthNode) old.destroy(); } catch (e) {} }, 60);
          dsp.synth = makeTrackSynth(this.ctx, track);
          dsp.synth.output.connect(dsp.input);
          if (this.isPlaying && dsp.synth instanceof NovaSynthNode) dsp.synth.syncTimeline(this.playbackStartTime, this.ctx.currentTime);
        } else if (dsp.synth instanceof NovaSynthNode && track.novaSynth) {
          dsp.synth.setSettings(track.novaSynth);
        }
      }
    }
    
    if (track.type === TrackType.DRUM_RACK && dsp.drumRack && track.drumPads) {
      dsp.drumRack.updatePadsState(track.drumPads);
      // Batterie Make Music : chaîne d'effets propre à chaque pad.
      if (track.drumMachine) {
        if (!dsp.drumFx) dsp.drumFx = new DrumPadFxBank(this.ctx, dsp.drumRack, (pl, c) => this.createPluginNode(pl, this.currentBpm, c as AudioContext));
        dsp.drumFx.configure(track.drumMachine.rows, id => this.tracksDSP.get(id)?.input, track.isMuted ? 0 : track.volume);
      }
    }

    // Le cablage n'a pas bouge (on a juste renomme la piste, deplace un clip,
    // bouge un fader...) : on met a jour les valeurs sans reconstruire le graphe.
    // Sinon la moindre edition provoquait un fondu a zero de 15 ms sur TOUTES
    // les pistes, donc un decrochage audible pendant la lecture.
    // Parts de cette piste déjà jouées depuis le rendu d'un bus VST gelé (tablette) : envoi direct coupé.
    const coveredOut = !!track.outputTrackId && isFeedCovered(track, track.outputTrackId, allTracks);
    // Envoi pré-fader : le fader ne le baisse pas, mais couper la piste (mute / solo) le coupe.
    const preSilenced = track.isMuted || this.soloSilencedIds.has(track.id);
    const sendLevelOf = (send: { id: string; isEnabled: boolean; level: number; preFader?: boolean; isMuted?: boolean }) =>
      (!send.isEnabled || send.isMuted || isFeedCovered(track, send.id, allTracks) || (send.preFader && preSilenced)) ? 0 : send.level;
    const signature = this.graphSignatureOf(track, (coveredOut ? 'covered-out' : '') + stripSignature(track));
    if (dsp.graphSignature === signature) {
      const t = this.ctx.currentTime;
      // Pendant la lecture, un paramètre automatisé garde la valeur de sa courbe.
      const target = (track.isMuted || this.soloSilencedIds.has(track.id)) ? 0 : this.automatedValue(track, 'volume', track.volume);
      // À l'arrêt : valeur posée tout de suite. Une piste sans son en cours n'est pas
      // « calculée » par le navigateur : une rampe programmée n'y avance pas, et
      // gain.value relu plus tard (arrêt, retour au début) renvoyait l'ANCIENNE valeur.
      if (!this.isPlaying) { try { dsp.gain.gain.cancelScheduledValues(t); dsp.gain.gain.setValueAtTime(target, t); } catch { /* */ } }
      else dsp.gain.gain.setTargetAtTime(target, t, 0.015);
      dsp.panner.pan.setTargetAtTime(this.automatedValue(track, 'pan', track.pan), t, 0.015);
      if (dsp.strip) setStrip(dsp.strip, track, t, !this.isPlaying, { trim: this.automationOwns(track, TRIM_PARAM), width: this.automationOwns(track, WIDTH_PARAM) });
      this.pluginAutoSent.forEach((_, k) => { if (k.startsWith(`${track.id}|`)) this.pluginAutoSent.delete(k); });

      // Seuls les effets cables ont une entree (sur une piste gelee : ceux
      // apres le rendu, qui restent reglables).
      const lanes = playedLanes(track);
      track.plugins.forEach(p => {
        const entry = dsp.pluginChain.get(p.id);
        if (entry && entry.instance && typeof entry.instance.updateParams === 'function') {
          // Réglages tenus par une voie pendant la lecture : laissés à l'automation (R8).
          entry.instance.updateParams(paramsWithoutAutomated(p.params, lanes, p.id, this.isPlaying));
          // À l'arrêt, sans voie : les réglages automatisables reviennent à leur valeur fixe.
          if (!this.isPlaying && typeof entry.instance.restoreStatic === 'function' && !hasPluginLane(lanes, p.id)) entry.instance.restoreStatic();
        }
      });
      this.resetMuteGain(track, dsp);
      (track.sends || []).forEach(send => {
        const sendGain = dsp.sends.get(send.id);
        const forcedOff = !send.isEnabled || !!send.isMuted || isFeedCovered(track, send.id, allTracks) || (!!send.preFader && preSilenced);
        if (sendGain) sendGain.gain.setTargetAtTime(forcedOff ? 0 : this.automatedValue(track, `send::${send.id}`, send.level), t, 0.015);
        if (typeof send.pan === 'number') dsp.sendPanners?.get(send.id)?.pan.setTargetAtTime(send.pan, t, 0.015);
      });
      this.syncSidechains(allTracks);
      this.syncVstWatch(track, dsp);
      return;
    }
    dsp.graphSignature = signature;

    // Fade out to prevent clicks/pops before rebuilding the audio graph
    const now = this.ctx.currentTime;
    const fadeTime = 0.015; // 15ms fade
    dsp.gain.gain.setValueAtTime(dsp.gain.gain.value, now);
    dsp.gain.gain.linearRampToValueAtTime(0, now + fadeTime);

    // CRITICAL FIX: Disconnect ALL track nodes to prevent signal accumulation
    // Note: We only disconnect track-level nodes, NOT plugin internal connections
    try { dsp.input.disconnect(); } catch (e) {}
    try { dsp.gain.disconnect(); } catch (e) {}
    try { dsp.panner.disconnect(); } catch (e) {}
    try { dsp.analyzer.disconnect(); } catch (e) {}
    try { dsp.output.disconnect(); } catch (e) {}
    if (dsp.preFaderTap) { try { dsp.preFaderTap.disconnect(); } catch (e) {} }
    
    // NOTE: We do NOT disconnect plugin inputs/outputs here as that would break
    // the plugin's internal graph. The plugins manage their own internal connections.
    // We only disconnect the chain between plugins below by rebuilding it.
    
    // Tête de tranche (R11) : entrée -> trim / Ø / mono / largeur -> effets.
    disposeStrip(dsp.strip);
    dsp.strip = buildStrip(this.ctx, track);
    let head: AudioNode = dsp.input;
    if (dsp.strip) {
      dsp.input.connect(dsp.strip.input);
      head = dsp.strip.output;
      setStrip(dsp.strip, track, now, true, { trim: this.automationOwns(track, TRIM_PARAM), width: this.automationOwns(track, WIDTH_PARAM) });
    }
    // Sorties d'effets cablees au passage precedent : on ne coupe QUE ces liens
    // (pas le graphe interne des effets). Sans ca, reordonner ou geler une chaine
    // laissait l'ancien lien en place et doublait le signal.
    dsp.pluginChain.forEach(entry => {
      if (entry.connectedTo) {
        try { entry.output.disconnect(entry.connectedTo); } catch (e) {}
        entry.connectedTo = undefined;
      }
      if (entry.bypassDelay) { try { entry.bypassDelay.disconnect(); } catch (e) {} }
    });
    const link = (from: AudioNode, to: AudioNode) => {
      from.connect(to);
      dsp!.pluginChain.forEach(entry => { if (entry.output === from) entry.connectedTo = to; });
    };

    // Piste gelee : rendu -> effets restants -> fader. Les effets compris dans
    // le rendu ne servent plus qu'aux clips ajoutes apres le rendu ; s'il n'y en
    // a pas, ils sont liberes (CPU, et instances du pont VST).
    const frozen = isTrackFrozen(track);
    // Bus d'effets gelé : ce qui y entre encore en direct (envoi ajouté ailleurs) passe par ses effets non rendus.
    const prePlugins = frozen ? ((uncoveredClips(track).length > 0 || isFrozenBus(track)) ? preFreezePlugins(track) : []) : track.plugins;
    const postPlugins = frozen ? postFreezePlugins(track) : [];
    const currentPluginIds = new Set<string>();
    const chainIds: string[] = [];
    const postIds: string[] = [];
    // Piste armée : effets en mode basse latence (retour casque sans retard).
    const lowLatency = this.lowLatencyTracks.has(track.id);

    const wire = (plugin: PluginInstance, isPost: boolean) => {
      // Effet INACTIF : ni chargé ni câblé, aucune latence (il est libéré plus bas).
      if (plugin.isInactive) return;
      currentPluginIds.add(plugin.id);
      let pEntry = dsp!.pluginChain.get(plugin.id);
      // Effet dont le worklet a planté puis réactivé : instance neuve.
      if (pEntry?.crashed && plugin.isEnabled) {
        try { pEntry.input.disconnect(); } catch (e) {}
        try { pEntry.output.disconnect(); } catch (e) {}
        try { pEntry.bypassDelay?.disconnect(); } catch (e) {}
        try { pEntry.instance?.dispose?.(); } catch (e) {}
        dsp!.pluginChain.delete(plugin.id);
        pEntry = undefined;
      }
      if (!pEntry) {
        const instance = this.createPluginNode(plugin, this.currentBpm);
        if (instance) {
          pEntry = { input: instance.input, output: instance.output, instance: instance.node };
          dsp!.pluginChain.set(plugin.id, pEntry);
          if (instance.node instanceof VSTPluginNode) {
            const trackId = track.id;
            instance.node.setLatencyListener(() => this.recomputeTrackLatency(trackId));
            if (lowLatency) instance.node.setMonitorBypass(true);
          } else if (instance.node instanceof HybridAutoTuneNode) {
            const trackId = track.id;
            instance.node.setLatencyListener(() => this.recomputeTrackLatency(trackId));
            if (lowLatency) instance.node.updateParams({ ...plugin.params, lowLatency: true });
          } else if (lowLatency && instance.node?.updateParams) {
            instance.node.updateParams({ ...plugin.params, lowLatency: true });
          }
        }
      } else if (pEntry.instance && pEntry.instance.updateParams) {
        pEntry.instance.updateParams({ ...paramsWithoutAutomated(plugin.params, playedLanes(track), plugin.id, this.isPlaying), lowLatency });
      }
      if (pEntry && plugin.isEnabled) {
        link(head, pEntry.input);
        head = pEntry.output;
        chainIds.push(plugin.id);
        if (isPost) postIds.push(plugin.id);
      } else if (pEntry) {
        // BYPASS (Pro Tools) : le son contourne l'effet, retardé de sa latence
        // (réglée par recomputeTrackLatency) : l'alignement de la session est gardé.
        if (!pEntry.bypassDelay) pEntry.bypassDelay = this.ctx!.createDelay(1);
        link(head, pEntry.bypassDelay);
        head = pEntry.bypassDelay;
        chainIds.push(plugin.id);
        if (isPost) postIds.push(plugin.id);
      }
    };

    prePlugins.forEach(p => wire(p, false));
    // Gel de prise : les effets rendus restent instanciés (non câblés) pour
    // repartir instantanément après la prise, sans recharger les VST3 du pont.
    if (frozen && prePlugins.length === 0 && this.recFreezes.has(track.id)) {
      preFreezePlugins(track).forEach(p => { if (dsp!.pluginChain.has(p.id)) currentPluginIds.add(p.id); });
    }
    if (frozen) {
      if (!dsp.frozenInput) {
        dsp.frozenInput = this.ctx.createGain();
        dsp.frozenInput.channelCount = 2;
        dsp.frozenInput.channelCountMode = 'explicit';
        dsp.frozenInput.channelInterpretation = 'speakers';
      }
      try { dsp.frozenInput.disconnect(); } catch (e) {}
      link(head, dsp.frozenInput);
      head = dsp.frozenInput;
      dsp.frozenClipId = track.frozenClip!.id;
    } else {
      dsp.frozenClipId = undefined;
      if (dsp.frozenInput) { try { dsp.frozenInput.disconnect(); } catch (e) {} }
    }
    postPlugins.forEach(p => wire(p, true));
    dsp.chainIds = chainIds;
    dsp.postChainIds = postIds;
    // Un limiteur à crête vraie sur le master remplace le limiteur de sécurité (jamais deux à la suite).
    if (track.id === 'master') this.setSafetyLimiter(!track.plugins.some(p => p.isEnabled && !p.isInactive && isTruePeakLimiter(p.type)));
    this.recomputeTrackLatency(track.id);

    dsp.pluginChain.forEach((val, id) => {
      if (!currentPluginIds.has(id)) {
        // Worklets de l'effet retiré : sinon ils restaient vivants ET calculés (fuite mesurée).
        // Avant dispose() : certains effets oublient leur worklet en se libérant.
        retireWorkletsOf(val.instance);
        try {
          val.input.disconnect();
          val.output.disconnect();
          val.bypassDelay?.disconnect();
          if (val.instance.dispose) {
              val.instance.dispose();
          }
        } catch (e) {}
        dsp!.pluginChain.delete(id);
      }
    });

    // Point pré-fader (envois PRE) : gain unité entre la chaîne et le fader.
    // chainOut (sortie de la chaîne, clé de side-chain) -> preFaderTap (mute automatisé) -> fader.
    if (!dsp.preFaderTap) dsp.preFaderTap = this.ctx.createGain();
    if (!dsp.chainOut) { dsp.chainOut = this.ctx.createGain(); dsp.chainOut.connect(dsp.preFaderTap); }
    link(head, dsp.chainOut);
    dsp.preFaderTap.connect(dsp.gain);
    this.resetMuteGain(track, dsp);
    dsp.gain.connect(dsp.panner);
    dsp.panner.connect(dsp.analyzer);
    dsp.analyzer.connect(dsp.output);

    // Fade in after rebuilding the audio graph
    const targetVolume = (track.isMuted || this.soloSilencedIds.has(track.id)) ? 0 : track.volume;
    dsp.gain.gain.setValueAtTime(0, now + fadeTime);
    dsp.gain.gain.linearRampToValueAtTime(targetVolume, now + fadeTime * 2);
    dsp.panner.pan.setTargetAtTime(track.pan, now + fadeTime, 0.015);
    
    dsp.output.disconnect();
    let destNode: AudioNode = this.masterOutput!;
    let destId = '';
    if (track.outputTrackId && track.outputTrackId !== track.id) {
      // 'master' est desormais une vraie piste (fader + inserts master).
      // Si elle n'existe pas (ancien projet), on retombe sur la sortie master du moteur.
      const destDSP = this.tracksDSP.get(track.outputTrackId);
      if (destDSP) { destNode = destDSP.input; destId = track.outputTrackId; }
    }
    // PDC : sortie -> retard -> destination (retard réglé par recomputePdc).
    if (!dsp.outDelay) dsp.outDelay = this.ctx.createDelay(PDC_MAX_SECONDS);
    try { dsp.outDelay.disconnect(); } catch (e) {}
    const outputs: string[] = [];
    // Sortie vers un bus que personne n'écoute / une piste inactive : le son part dans le vide (Pro Tools).
    if (!coveredOut && track.outputTrackId !== VOID_OUTPUT) {
      dsp.output.connect(dsp.outDelay);
      dsp.outDelay.connect(destNode);
      outputs.push(destId);
    }
    
    // === SEND ROUTING - Connect to send/bus tracks ===
    // First, disconnect all existing sends
    dsp.sends.forEach((sendGain, sendId) => {
      try { sendGain.disconnect(); } catch (e) {}
    });
    if (!dsp.sendDelays) dsp.sendDelays = new Map();
    dsp.sendDelays.forEach(node => { try { node.disconnect(); } catch (e) {} });
    if (!dsp.sendPanners) dsp.sendPanners = new Map();
    dsp.sendPanners.forEach(node => { try { node.disconnect(); } catch (e) {} });
    
    // Process each send in the track's sends array
    if (track.sends && track.sends.length > 0) {
      track.sends.forEach(send => {
        if (!send.id || !send.isEnabled) return;
        
        // Get or create the send gain node
        let sendGain = dsp!.sends.get(send.id);
        if (!sendGain) {
          sendGain = this.ctx!.createGain();
          dsp!.sends.set(send.id, sendGain);
        }
        
        // Set the send level with smooth transition
        const sendLevel = sendLevelOf(send);
        sendGain.gain.setTargetAtTime(sendLevel, now + fadeTime, 0.015);
        
        // Post-fader : après le fader et le pan ; pré-fader : après les effets, avant le fader.
        try { dsp!.panner.disconnect(sendGain); } catch (e) {}
        try { dsp!.preFaderTap?.disconnect(sendGain); } catch (e) {}
        // Pan propre de l'envoi (Pro Tools « FMP » éteint) : post-fader pris AVANT le pan de la piste.
        const ownPan = typeof send.pan === 'number';
        (send.preFader && dsp!.preFaderTap ? dsp!.preFaderTap : (ownPan ? dsp!.gain : dsp!.panner)).connect(sendGain);
        let sendTail: AudioNode = sendGain;
        if (ownPan) {
          let sp = dsp!.sendPanners!.get(send.id);
          if (!sp) { sp = this.ctx!.createStereoPanner(); dsp!.sendPanners!.set(send.id, sp); }
          sp.pan.setValueAtTime(Math.max(-1, Math.min(1, send.pan!)), now);
          sendGain.connect(sp);
          sendTail = sp;
        }
        
        // Find the destination send/bus track and connect
        const destSendDSP = this.tracksDSP.get(send.id);
        if (destSendDSP) {
          let sendDelay = dsp!.sendDelays!.get(send.id);
          if (!sendDelay) { sendDelay = this.ctx!.createDelay(PDC_MAX_SECONDS); dsp!.sendDelays!.set(send.id, sendDelay); }
          sendTail.connect(sendDelay);
          sendDelay.connect(destSendDSP.input);
          outputs.push(send.id);
          // console.log(`[AudioEngine] Send connected: ${track.name} -> ${send.id} (level: ${sendLevel})`);
        } else {
          // console.warn(`[AudioEngine] Send destination not found: ${send.id}`);
        }
      });
    }
    
    // Clean up sends that are no longer in the track's sends array
    const currentSendIds = new Set(track.sends?.map(s => s.id) || []);
    dsp.sends.forEach((sendGain, sendId) => {
      if (!currentSendIds.has(sendId)) {
        try { sendGain.disconnect(); } catch (e) {}
        dsp!.sends.delete(sendId);
      }
    });
    dsp.sendDelays.forEach((node, sendId) => {
      if (!currentSendIds.has(sendId)) { try { node.disconnect(); } catch (e) {} dsp!.sendDelays!.delete(sendId); }
    });
    dsp.sendPanners.forEach((node, sendId) => {
      if (!currentSendIds.has(sendId)) { try { node.disconnect(); } catch (e) {} dsp!.sendPanners!.delete(sendId); }
    });
    dsp.outputs = outputs;
    this.syncSidechains(allTracks);
    this.syncVstWatch(track, dsp);
    this.recomputePdc();
    // R11 : point de mesure de la piste (pré-fader : après les effets ; post : après fader et pan).
    // Pré-fader pris sur chainOut (R7/R8) : le mute automatisé agit comme le mute fixe, après ce point.
    meterBank.attachTrack(track.id, dsp.chainOut || dsp.preFaderTap!, dsp.analyzer);
    // R15 : les mixes casque reprennent la prise pré-fader (le recâblage l'a débranchée).
    this.trackMix.set(track.id, { id: track.id, volume: track.volume, pan: track.pan });
    if (this.cueMixes.length) this.cueEngine?.reconnectTrack(track.id, dsp.preFaderTap || null);
  }

  private applyAutomation(track: Track, time: number) {
    const dsp = this.tracksDSP.get(track.id);
    if (!dsp || !this.ctx) return;
    this.resetPreVolume(track, dsp);
    if (track.isMuted || this.soloSilencedIds.has(track.id)) return;

    this.resetMuteGain(track, dsp);
    playedLanes(track).forEach(lane => {
        if (lane.points.length === 0 || this.autoOverrides.has(`${track.id}|${lane.parameterName}`)) return;
        if (isMuteParam(lane.parameterName)) {
          // Mute automatisé (R8) : calé sur la musique (avance PDC de la piste).
          const ap = dsp.preFaderTap?.gain;
          if (!ap) return;
          const lead = this.pdcSuspended ? 0 : (dsp.downLatency || 0);
          if (this.isPlaying) this.programPluginStart(ap, muteGainPoints(lane.points), time, this.playbackStartTime + time, lead);
          else { try { ap.cancelScheduledValues(this.ctx!.currentTime); ap.setValueAtTime(valueAtPoints(muteGainPoints(lane.points), time + lead, 1), this.ctx!.currentTime); } catch { /* */ } }
          return;
        }
        if (parsePluginParam(lane.parameterName)) {
          // En lecture, sur un AudioParam : posé à l'instant exact du départ (ou du bouclage).
          const a = this.isPlaying ? this.pluginAutoParam(track.id, lane.parameterName) : null;
          if (a) this.programPluginStart(a.ap, this.sortedOf(lane.points), time, this.playbackStartTime + time, a.lead);
          else this.applyPluginAutomation(track.id, lane.parameterName, valueAtPoints(sortedPoints(lane.points), time, 0));
          return;
        }

        let prevPoint = lane.points[0];
        let nextPoint = lane.points[lane.points.length - 1];
        
        for (let i = 0; i < lane.points.length - 1; i++) {
            if (lane.points[i].time <= time && lane.points[i + 1].time >= time) {
                prevPoint = lane.points[i];
                nextPoint = lane.points[i + 1];
                break;
            }
        }
        
        let value: number;
        if (time <= prevPoint.time) value = prevPoint.value;
        else if (time >= nextPoint.time) value = nextPoint.value;
        else {
            const ratio = (time - prevPoint.time) / (nextPoint.time - prevPoint.time);
            value = prevPoint.value + (nextPoint.value - prevPoint.value) * ratio;
        }
        
        const now = this.ctx.currentTime;
        const cible = this.cibleAutomation(lane.parameterName, dsp.gain.gain, dsp.panner.pan, dsp.sends, this.preParam(dsp), dsp.strip);
        if (cible) cible.setValueAtTime(value, now);
    });
}

  /** Sans voie « Muet » jouée, le gain du mute automatisé revient à 1 (voie effacée, mode Off). */
  private resetMuteGain(track: Track, dsp: TrackDSP) {
    const ap = dsp.preFaderTap?.gain;
    if (!ap || !this.ctx || muteLaneOf(track)) return;
    if (Math.abs(ap.value - 1) < 1e-9 && !this.pluginAutoParams.has(ap)) return;
    try { const now = this.ctx.currentTime; ap.cancelScheduledValues(now); ap.setValueAtTime(1, now); } catch { /* */ }
    this.pluginAutoParams.delete(ap);
  }

  /** Gain « volume avant effets » : tête de chaîne, ou entrée du rendu sur une piste gelée. */
  private preParam(dsp: TrackDSP): AudioParam {
    return (dsp.frozenClipId && dsp.frozenInput ? dsp.frozenInput : dsp.input).gain;
  }

  /** Sans volume avant effets, les deux gains de tête reviennent à 1 (lane effacée, gel / dégel). */
  private resetPreVolume(track: Track, dsp: TrackDSP) {
    if (!this.ctx) return;
    const has = (track.automationLanes || []).some(l => l.parameterName === PRE_VOLUME && l.points.length > 0);
    const now = this.ctx.currentTime;
    const active = this.preParam(dsp);
    [dsp.input.gain, dsp.frozenInput?.gain].forEach(p => {
      if (!p || (has && p === active)) return;
      try { p.cancelScheduledValues(now); p.setValueAtTime(1, now); } catch (e) {}
    });
  }

  /**
   * Audio source d'une piste (ses clips audio non muets, bout à bout dans
   * l'ordre de la ligne de temps, gain de clip compris, sans les silences
   * entre clips), plafonné à `maxSeconds`. Sert au calage « Caler sur ma
   * voix » des compresseurs : on règle sur ce que la piste va vraiment chanter.
   */
  public getTrackSourceAudio(trackId: string, maxSeconds = 90): { channels: Float32Array[]; sampleRate: number } | null {
    const tracks = this.liveTracks || [];
    const track = tracks.find(t => t.id === trackId);
    if (!track) return null;
    const clips = [...(track.clips || [])].filter(c => !c.isMuted && c.type !== TrackType.MIDI).sort((a, b) => a.start - b.start);
    const parts: { buf: AudioBuffer; from: number; len: number; gain: number }[] = [];
    let sr = 0, total = 0;
    for (const c of clips) {
      const buf = c.buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined) || audioBufferRegistry.get(c.id);
      if (!buf) continue;
      if (!sr) sr = buf.sampleRate;
      if (buf.sampleRate !== sr) continue;
      const from = Math.max(0, Math.floor((c.offset || 0) * sr));
      const len = Math.max(0, Math.min(buf.length - from, Math.floor((c.duration || 0) * sr)));
      const room = Math.floor(maxSeconds * sr) - total;
      if (len <= 0 || room <= 0) continue;
      parts.push({ buf, from, len: Math.min(len, room), gain: c.gain ?? 1 });
      total += Math.min(len, room);
    }
    if (!total) return null;
    const L = new Float32Array(total), R = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      const a = p.buf.getChannelData(0), b = p.buf.numberOfChannels > 1 ? p.buf.getChannelData(1) : a;
      for (let i = 0; i < p.len; i++) { L[at + i] = a[p.from + i] * p.gain; R[at + i] = b[p.from + i] * p.gain; }
      at += p.len;
    }
    return { channels: [L, R], sampleRate: sr };
  }

  /** Réglages automatisables des effets du registre (V21 : harmoniseur, tape stop…) de la piste. */
  public getTrackPluginParameters(trackId: string): { pluginId: string, pluginName: string, params: PluginParameter[] }[] {
    const track = this.liveTracks?.find(t => t.id === trackId);
    return (track?.plugins || []).flatMap(pl => {
      if (pl.type === 'VST3') {
        // VST du PC (R9) : réglages lus par le pont (noms du plugin), valeur brute 0–1.
        const list = vstParamCatalog.get(pl.id) || [];
        if (!list.length) return [];
        return [{ pluginId: pl.id, pluginName: pl.params?.name || pl.name || 'VST', params: list.map(a => ({ id: a.name, name: a.displayName, type: 'float' as const, min: 0, max: 1, value: a.value as any, unit: a.label })) }];
      }
      const reg = getRegisteredPlugin(pl.type);
      // Effets historiques (R8) : Compresseur, EQ, Reverb, Délai, De-esser, Saturation, Doubleur, Nova Tune.
      const list = reg?.automatable?.length ? reg.automatable : legacyAutomatable(pl.type);
      if (!list.length) return [];
      return [{ pluginId: pl.id, pluginName: reg?.name || pl.name || pl.type, params: list.map(a => ({ id: a.id, name: a.label, type: 'float' as const, min: a.min, max: a.max, value: pluginParamStaticValue(pl.params, a.id) as any, unit: a.unit })) }];
    });
  }
  public getMasterAnalyzer() { return this.masterAnalyzer; }

  /**
   * Limiteur de sécurité du master (DynamicsCompressor à -1 dB) : branché par
   * défaut, effacé quand un limiteur NOVA à crête vraie est sur le master (V15).
   */
  private safetyLimiterOn = true;
  public setSafetyLimiter(on: boolean) {
    if (!this.masterOutput || !this.masterLimiter || !this.masterAnalyzer || on === this.safetyLimiterOn) return;
    this.safetyLimiterOn = on;
    try { this.masterOutput.disconnect(); } catch (e) {}
    if (on) this.masterOutput.connect(this.masterLimiter);
    else this.masterOutput.connect(this.masterAnalyzer);
  }
  public isSafetyLimiterOn() { return this.safetyLimiterOn; }

  /** Niveau d'écoute du mix (A/B : morceau de référence, comparaison à niveau égal). N'affecte pas l'export. */
  public setMixMonitorLevel(gain: number, rampSec = 0.03) {
    if (!this.ctx || !this.masterOutput) return;
    const g = Number.isFinite(gain) ? Math.max(0, Math.min(4, gain)) : 1;
    const t = this.ctx.currentTime;
    this.masterOutput.gain.cancelScheduledValues(t);
    this.masterOutput.gain.setValueAtTime(this.masterOutput.gain.value, t);
    this.masterOutput.gain.linearRampToValueAtTime(g, t + rampSec);
  }

  /** Contexte audio de lecture (lecteur du morceau de référence). */
  public getAudioContext(): AudioContext | null { return this.ctx; }

  /**
   * Collaboration : le mix master (après le limiteur de sécurité, comme on
   * l'entend) en flux, pour l'envoyer en direct à l'artiste (services/CollabRtc,
   * « Écouter le mix de l'ingé »). Créé une fois, réutilisé.
   */
  private collabMixDest: MediaStreamAudioDestinationNode | null = null;
  public getCollabMixStream(): MediaStream | null {
    if (!this.ctx || !this.masterAnalyzer) return null;
    if (!this.collabMixDest) {
      this.collabMixDest = this.ctx.createMediaStreamDestination();
      this.collabMixDest.channelCount = 2;
      this.masterAnalyzer.connect(this.collabMixDest);
    }
    return this.collabMixDest.stream;
  }

  /**
   * Collaboration : couper SA sortie le temps d'écouter le mix de l'ingé en
   * direct (sinon on entend les deux, décalés). N'affecte ni l'export ni le flux.
   */
  private collabOutputMuted = false;
  public setCollabOutputMuted(muted: boolean) {
    this.collabOutputMuted = muted;
    if (this.mainOut && this.ctx) this.mainOut.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }
  public isCollabOutputMuted() { return this.collabOutputMuted; }

  /** Entrée des mesures du master (après limiteur de sécurité) : la référence y passe pour être entendue et mesurée. */
  public getMasterMeterInput(): AudioNode | null { return this.masterAnalyzer; }
  /** Où envoyer les sons de service (décompte) : le master, pour qu'ils sortent aussi en ASIO. */
  public getMonitorBus(): AudioNode | null { return this.masterOutput || this.ctx?.destination || null; }

  public getTrackAnalyzer(trackId: string) { const dsp = this.tracksDSP.get(trackId); if (!dsp) return null; if (this.inputRouter?.has(trackId) && dsp.inputAnalyzer) return dsp.inputAnalyzer; return dsp.analyzer; }
  public getPluginNodeInstance(trackId: string, pluginId: string) { return this.tracksDSP.get(trackId)?.pluginChain.get(pluginId)?.instance || null; }
  public setRecMode(active: boolean) { this.isRecMode = active; }
  /**
   * R11 : réduction de gain des dynamiques de la piste (compresseur, de-esser,
   * limiteur…), en dB positifs, avec le détail par effet. null : aucune
   * dynamique mesurable. Sur le master, le limiteur de sécurité compte aussi.
   */
  public getTrackGainReduction(trackId: string): { db: number; parts: GrPart[] } | null {
    const dsp = this.tracksDSP.get(trackId);
    const parts: GrPart[] = [];
    dsp?.pluginChain.forEach((entry, pluginId) => {
      if (dsp.chainIds && !dsp.chainIds.includes(pluginId)) return;
      const db = readGainReduction(entry.instance);
      if (db !== null) parts.push({ pluginId, db });
    });
    if (trackId === 'master' && this.masterLimiter && this.safetyLimiterOn) {
      parts.push({ pluginId: 'safety-limiter', db: Math.abs(this.masterLimiter.reduction || 0) });
    }
    if (!parts.length) return null;
    return { db: parts.reduce((s, p) => s + p.db, 0), parts };
  }

  public getRMS(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const sample = (data[i] - 128) / 128; sum += sample * sample; }
    return Math.sqrt(sum / data.length);
  }
  // ═══════════════════════════════════════════════════════════════════════
  // ASIO BRIDGE INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Connecter au bridge ASIO Python
   * Lance la connexion WebSocket vers le serveur ASIO local
   */
  public async connectASIO(): Promise<boolean> {
    if (this.asioConnected) return true;
    
    this.asioBridge = getASIOBridge();
    
    this.asioBridge.setHandlers({
      onConnect: () => {
        console.log('[AudioEngine] ASIO Bridge connecté');
        this.asioConnected = true;
        this.asioBridge?.getDevices();
      },
      onDisconnect: () => {
        console.log('[AudioEngine] ASIO Bridge déconnecté');
        this.asioConnected = false;
        this.asioStreamActive = false;
        this.restoreBrowserOutput();
        this.teardownAsioOutput();
        // Pont perdu (Nova Studio fermé, pont arrêté) : les pistes armées repassent au micro du navigateur.
        void this.refreshInputSource();
      },
      onDevices: (devices, asioDevices) => {
        this.asioDevices = asioDevices;
        console.log('[AudioEngine] Périphériques ASIO détectés:', asioDevices.length);
      },
      onConfigSet: (success, config) => {
        if (success && config) this.applyASIOConfig(config);
      },
      onConfig: (config) => this.applyASIOConfig(config),
      onStreamStarted: (success, latency_ms, _error, info) => {
        if (success) {
          this.asioStreamActive = true;
          // latency_ms est en millisecondes ; this.latency est en SECONDES,
          // comme ctx.baseLatency. Sans conversion les deux se melangeaient.
          this.latency = (latency_ms || 0) / 1000;
          this.applyStreamInfo(info);
          console.log(`[AudioEngine] Stream ASIO démarré - Latence: ${latency_ms}ms, tampon ${this.asioBlockSize}, ${this.asioInputChannels} entrées / ${this.asioOutputChannels} sorties`);
          // Pistes déjà armées sur le micro du navigateur : elles basculent sur la carte.
          void this.refreshInputSource();
          if (this.asioOutputProcessor) this.rebuildAsioOutput();
        }
      },
      onStreamStopped: () => {
        this.asioStreamActive = false;
        this.restoreBrowserOutput();
        console.log('[AudioEngine] Stream ASIO arrêté');
        // Pistes armées sur la carte : retour au micro du navigateur pour ne pas rester muettes.
        void this.refreshInputSource();
      },
      onAudioInput: (audioData, channels, block) => {
        this.handleASIOInput(audioData, channels, block?.frameIndex, block?.sampleRate);
      },
      onStats: (stats) => {
        this.latency = (stats.latency_ms || 0) / 1000;
        this.asioQueueSec = (stats.queue_ms || 0) / 1000;
        if (stats.sample_rate && this.asioInput) this.asioInput.sourceRate = stats.sample_rate;
        if (stats.block_size) this.asioBlockSize = stats.block_size;
      },
      onConfigResult: (m) => {
        const w = this.configWaiters;
        this.configWaiters = [];
        w.forEach(f => f(m));
      },
    });

    return await this.asioBridge.connect();
  }

  /**
   * Déconnecter du bridge ASIO
   */
  public disconnectASIO(): void {
    if (this.asioBridge) {
      this.asioBridge.stopStream();
      this.asioBridge.disconnect();
      this.asioBridge = null;
    }
    this.asioConnected = false;
    this.asioStreamActive = false;
    this.restoreBrowserOutput();
  }

  /**
   * Récupérer la liste des périphériques ASIO
   */
  public getASIODevices(): AudioDevice[] {
    return this.asioDevices;
  }

  /**
   * Vérifier si le bridge ASIO est connecté
   */
  public isASIOConnected(): boolean {
    return this.asioConnected;
  }

  /**
   * Vérifier si le stream ASIO est actif
   */
  public isASIOStreamActive(): boolean {
    return this.asioStreamActive;
  }

  /**
   * Configurer le périphérique ASIO
   */
  public async configureASIO(config: Partial<ASIOConfig>): Promise<void> {
    if (!this.asioBridge || !this.asioConnected) {
      console.warn('[AudioEngine] ASIO non connecté, impossible de configurer');
      return;
    }
    this.asioBridge.setConfig(config);
  }

  /**
   * Démarrer le streaming audio ASIO
   */
  public async startASIOStream(): Promise<void> {
    if (!this.asioBridge || !this.asioConnected) {
      console.warn('[AudioEngine] ASIO non connecté');
      return;
    }
    
    // Envoi vers la carte : master sur 1-2, chaque mix casque sur sa paire (R15).
    if (this.ctx && !this.asioOutputProcessor) this.rebuildAsioOutput();
    if (this.browserOutput && this.ctx) this.browserOutput.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);

    this.asioBridge.startStream();
  }

  /** Remet le son sur la sortie du navigateur (flux ASIO arrêté ou perdu). */
  private restoreBrowserOutput() {
    if (this.browserOutput && this.ctx) this.browserOutput.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
  }

  /**
   * Arrêter le streaming audio ASIO
   */
  public stopASIOStream(): void {
    if (this.asioBridge) {
      this.asioBridge.stopStream();
    }
    
    this.teardownAsioOutput();
    this.restoreBrowserOutput();

    this.asioStreamActive = false;
  }

  /**
   * Gérer l'audio entrant du bridge ASIO (entrée micro/instrument)
   */
  private handleASIOInput(audioData: Float32Array, channels: number, frameIndex?: number, rate?: number): void {
    // Le son de la carte arrive en continu ; il n'est entendu / enregistré que
    // si une piste est armée (le flux sert alors de « micro »).
    this.asioInputReceived = true;
    // Plus d'entrées que prévu (1er bloc avant l'info du flux) : le lecteur est refait.
    if (channels > 0 && channels !== this.asioInputChannels && !this.recordingTrackId) {
      this.asioInputChannels = Math.min(32, channels);
      if (this.asioInput && this.asioInput.channels !== this.asioInputChannels) { this.resetASIOInput(); void this.refreshInputSource(); }
    }
    this.asioInput?.push(audioData, channels, frameIndex, rate);
  }

  /** Lecteur des entrées de la carte (autant de canaux que le flux en porte). */
  private ensureASIOInput(): ASIOInput | null {
    if (!this.ctx) return null;
    if (this.asioInput && this.asioInput.channels !== this.asioInputChannels && !this.recordingTrackId) this.resetASIOInput();
    if (this.asioInput) return this.asioInput;
    this.asioInput = new ASIOInput(this.ctx, this.asioConfig?.sample_rate || 44100, this.asioInputChannels);
    this.asioInput.setChannel(this.getASIOInputChannel());
    return this.asioInput;
  }

  private resetASIOInput() {
    const old = this.asioInput;
    if (!old) return;
    this.asioInput = null;
    if (this.inputRouter?.getSource()?.kind === 'asio') this.inputRouter.setSource(null);
    old.dispose();
  }

  /** Infos du flux (R15) : canaux réellement ouverts, tampon, latences du pilote. */
  private applyStreamInfo(info?: ASIOStreamInfo) {
    if (!info) return;
    if (info.input_channels) this.asioInputChannels = Math.max(1, Math.min(32, info.input_channels));
    if (info.output_channels) this.asioOutputChannels = Math.max(1, Math.min(32, info.output_channels));
    if (info.block_size) this.asioBlockSize = info.block_size;
    if (info.sample_rate && this.asioInput) this.asioInput.sourceRate = info.sample_rate;
    try { window.dispatchEvent(new CustomEvent('nova:asio-stream', { detail: { ...info, blockSize: this.asioBlockSize, inputs: this.asioInputChannels, outputs: this.asioOutputChannels } })); } catch { /* */ }
  }

  /** Infos de la carte pour l'interface (tampon réel, entrées, sorties). */
  public getASIOStreamInfo() {
    return { active: this.asioStreamActive, connected: this.asioConnected, blockSize: this.asioBlockSize, inputs: this.asioInputChannels, outputs: this.asioOutputChannels, protocol: this.asioBridge?.protocol ?? 1, latencyMs: Math.round(this.latency * 10000) / 10 };
  }

  /**
   * R15 · Taille du tampon de la carte : le pont RECRÉE le flux avec ce tampon (avant,
   * la valeur était notée mais le flux gardait l'ancien). Résolu quand le pont a
   * répondu, avec le tampon réellement obtenu.
   */
  public setASIOBufferSize(blockSize: number): Promise<{ ok: boolean; blockSize: number; restarted: boolean; error?: string }> {
    if (!this.asioBridge || !this.asioConnected) return Promise.resolve({ ok: false, blockSize: this.asioBlockSize, restarted: false, error: 'Pont ASIO non connecté' });
    if (this.recordingTrackId) return Promise.resolve({ ok: false, blockSize: this.asioBlockSize, restarted: false, error: 'Une prise est en cours : change le tampon après.' });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.configWaiters = this.configWaiters.filter(f => f !== done); resolve({ ok: false, blockSize: this.asioBlockSize, restarted: false, error: 'Pas de réponse du pont' }); }, 8000);
      const done = (m: any) => {
        clearTimeout(timer);
        const bs = Number(m?.config?.block_size) || this.asioBlockSize;
        if (m?.stream_restarted) this.asioBlockSize = bs;
        resolve({ ok: !!m?.success, blockSize: bs, restarted: !!m?.stream_restarted, error: m?.error || undefined });
      };
      this.configWaiters.push(done);
      this.asioBridge!.setConfig({ block_size: blockSize });
    });
  }

  /**
   * « Tampon plus grand » : avec la carte (pont ASIO), le VRAI tampon double (flux
   * recréé) ; sans pont, la marge de programmation du navigateur passe au maximum.
   */
  public async biggerBuffer(): Promise<{ kind: 'asio'; ok: boolean; blockSize: number; error?: string } | { kind: 'planificateur' }> {
    if (this.asioStreamActive && this.asioConnected) {
      const next = Math.min(2048, Math.max(64, this.asioBlockSize * 2));
      const r = await this.setASIOBufferSize(next);
      return { kind: 'asio', ok: r.ok && r.restarted, blockSize: r.blockSize, error: r.error };
    }
    this.setLatencyMode('high');
    return { kind: 'planificateur' };
  }

  public getLatencyModeIsMax(): boolean {
    if (this.asioStreamActive && this.asioConnected) return this.asioBlockSize >= 2048;
    return this.getLatencyMode() === 'high';
  }

  /**
   * R15 · Latence aller-retour de chaque entrée, mesurée par le pont (impulsion sur
   * les sorties 1-2, retrouvée sur les entrées). Le retard propre de chaque entrée
   * est gardé (utils/multiRecord.channelOffsets) et ajouté au calage des prises.
   */
  public async measureInputLatencies(outChannels: number[] = [0, 1]): Promise<ASIOLatencyResult & { offsetsMs?: Record<number, number> }> {
    if (!this.asioBridge || !this.asioConnected || !this.asioStreamActive) return { success: false, error: 'Lance le flux de la carte (Nova Studio) pour mesurer.' };
    const r = await this.asioBridge.measureLatency(outChannels);
    if (!r.success || !r.delays) return r;
    const reported = ((r.input_latency_ms || 0) + (r.output_latency_ms || 0)) / 1000;
    const offsetsMs = offsetsFromProbe(r.delays, r.sample_rate || this.asioConfig?.sample_rate || 44100, reported);
    if (Object.keys(offsetsMs).length) setChannelOffsets({ ...channelOffsets(), ...offsetsMs });
    return { ...r, offsetsMs };
  }

  /** Envoi vers la carte : merger (master + mixes casque) → processeur → pont. */
  private rebuildAsioOutput() {
    if (!this.ctx || !this.mainOut) return;
    const layout = outputLayout(this.cueMixes, { bridge: true, outputChannels: this.asioOutputChannels });
    const sig = JSON.stringify(layout);
    if (this.asioOutputProcessor && sig === this.asioOutLayoutSig) return;
    this.teardownAsioOutput();
    const ctx = this.ctx;
    const n = layout.dests.length;
    const merger = ctx.createChannelMerger(n);
    const sources: (AudioNode | null)[] = [this.mainOut, ...layout.mixIds.map(id => this.cueEngine?.outputOf(id) || null)];
    const parts: AudioNode[] = [merger];
    sources.forEach((s, k) => {
      if (!s) return;
      const sp = ctx.createChannelSplitter(2);
      s.connect(sp);
      sp.connect(merger, 0, 2 * k);
      sp.connect(merger, 1, 2 * k + 1);
      parts.push(sp);
    });
    const dests = layout.dests;
    this.asioOutParts = [...parts, ...sources.filter((s): s is AudioNode => !!s)];
    this.asioOutLayoutSig = sig;
    const gen = ++this.asioOutGen;
    if (ctx.audioWorklet) {
      // AudioWorklet : aucun bloc perdu quand l'interface est occupée (voir AsioOutputTap).
      this.asioOutputProcessor = merger;   // marque « envoi en place » le temps du chargement
      void createAsioOutputTap(ctx, n, block => {
        if (this.asioStreamActive && this.asioBridge) this.asioBridge.sendInterleaved(block, n, dests);
      }).then(tap => {
        if (gen !== this.asioOutGen) { tap.dispose(); return; }
        merger.connect(tap.node);
        this.asioOutTap = tap;
        this.asioOutputProcessor = tap.node;
      }).catch(e => console.warn('[AudioEngine] Envoi vers la carte indisponible', e));
      return;
    }
    const proc = ctx.createScriptProcessor(256, n, 2);
    proc.onaudioprocess = (e) => {
      if (this.asioStreamActive && this.asioBridge) {
        const ch: Float32Array[] = [];
        for (let c = 0; c < n; c++) ch.push(e.inputBuffer.getChannelData(c));
        this.asioBridge.sendChannels(ch, dests);
      }
      // Sortie du processeur silencieuse : le mix part par la carte. (Le copier
      // ici le faisait aussi sortir par le navigateur, en double.)
      for (let c = 0; c < e.outputBuffer.numberOfChannels; c++) e.outputBuffer.getChannelData(c).fill(0);
    };
    // Le processeur doit être relié à la destination pour tourner (il n'y envoie que du silence).
    merger.connect(proc);
    proc.connect(ctx.destination);
    this.asioOutputProcessor = proc;
  }

  private teardownAsioOutput() {
    if (!this.asioOutputProcessor) return;
    const proc = this.asioOutputProcessor;
    this.asioOutputProcessor = null;
    this.asioOutLayoutSig = '';
    this.asioOutGen++;
    if (this.asioOutTap) { this.asioOutTap.dispose(); this.asioOutTap = null; }
    const [merger, ...rest] = this.asioOutParts;
    // Les sources (master, mixes) ne sont débranchées QUE des séparateurs de l'envoi.
    const splitters = rest.filter(n => n instanceof ChannelSplitterNode);
    const sources = rest.filter(n => !(n instanceof ChannelSplitterNode));
    for (const s of sources) for (const sp of splitters) { try { s.disconnect(sp); } catch { /* */ } }
    splitters.forEach(sp => { try { sp.disconnect(); } catch { /* */ } });
    try { merger?.disconnect(); } catch { /* */ }
    try { proc.disconnect(); } catch { /* */ }
    if (proc instanceof ScriptProcessorNode) proc.onaudioprocess = null;
    this.asioOutParts = [];
  }

  // ─── R15 · Mixes casque ────────────────────────────────────────────────────

  /** Mixes casque du projet (et pistes, pour les niveaux par défaut et les prises pré-fader). */
  public setCueMixes(mixes: CueMix[], tracks: Track[]) {
    this.cueMixes = mixes || [];
    tracks.forEach(t => this.trackMix.set(t.id, { id: t.id, volume: t.volume, pan: t.pan }));
    if (!this.ctx || !this.cueEngine) return;
    if (this.cueMixes.length) metronomeService.addTap(this.cueEngine.clickIn);
    const sources = tracks.filter(t => this.isSourceTrackType(t) && t.id !== 'master');
    this.cueEngine.sync(this.cueMixes, sources, id => this.tracksDSP.get(id)?.preFaderTap || null);
    if (this.cueListen && !this.cueMixes.some(m => m.id === this.cueListen)) this.setCueListen(null);
    if (this.asioOutputProcessor) this.rebuildAsioOutput();
    this.syncDirectMonitor();
  }

  /** Écouter un mix casque sur la sortie principale (null = le master). */
  public setCueListen(mixId: string | null) {
    this.cueListen = mixId && this.cueMixes.some(m => m.id === mixId) ? mixId : null;
    this.cueEngine?.setListen(this.cueListen);
    if (this.mainSel && this.ctx) this.mainSel.gain.setTargetAtTime(this.cueListen ? 0 : 1, this.ctx.currentTime, 0.01);
    this.syncDirectMonitor();
    try { window.dispatchEvent(new CustomEvent('nova:cue-listen', { detail: this.cueListen })); } catch { /* */ }
  }

  public getCueListen() { return this.cueListen; }

  /** Pour l'interface des mixes casque : pont, sorties de la carte. */
  public getCueOutputInfo(): { bridge: boolean; outputChannels: number } {
    const bridge = this.asioConnected && this.asioStreamActive && (this.asioBridge?.protocol ?? 1) >= 2;
    return { bridge, outputChannels: bridge ? this.asioOutputChannels : 2 };
  }

  /** Sortie d'un mix casque (mesures, tests). */
  public getCueOutput(mixId: string): AudioNode | null { return this.cueEngine?.outputOf(mixId) || null; }

  /** Stoppe un flux d'entrée, sauf celui de l'ASIO (partagé et réutilisé à chaque prise). */
  private stopInputStream(stream: MediaStream) {
    if (this.asioInput?.owns(stream)) return;
    stream.getTracks().forEach(track => track.stop());
  }

  /** Entrée de la carte utilisée : -1 = entrées 1+2 en mono (défaut), 0 = entrée 1, 1 = entrée 2… */
  public setASIOInputChannel(channel: number) {
    try { localStorage.setItem('nova_asio_input_channel', String(channel)); } catch { /* stockage indisponible */ }
    this.ensureASIOInput();
    this.asioInput?.setChannel(channel);
    // Pistes en entrée « auto » : elles suivent le nouveau réglage.
    void this.refreshInputSource();
  }

  public getASIOInputChannel(): number {
    try { const v = localStorage.getItem('nova_asio_input_channel'); if (v !== null) return parseInt(v, 10); } catch { /* défaut */ }
    return -1;
  }

  /** Vrai si le pont a déjà envoyé du son de la carte (diagnostic « je ne m'entends pas »). */
  public isASIOInputReceiving(): boolean {
    return this.asioInputReceived;
  }

  /** La piste armée utilise-t-elle l'entrée ASIO ? */
  public isUsingASIOInput(): boolean {
    return !!this.asioInput && this.asioInput.owns(this.activeMonitorStream);
  }

  private applyASIOConfig(config: ASIOConfig) {
    this.asioConfig = config;
    if (this.asioInput && config.sample_rate) this.asioInput.sourceRate = config.sample_rate;
  }

  /**
   * Récupérer les statistiques ASIO
   */
  public getASIOStats(): void {
    if (this.asioBridge && this.asioConnected) {
      this.asioBridge.getStats();
    }
  }

  /**
   * Ouvrir le panneau de configuration du driver ASIO
   * Envoie une commande au bridge Python pour ouvrir le panneau natif
   */
  public openASIOPanel(): void {
    if (!this.asioBridge || !this.asioConnected) {
      console.warn('[AudioEngine] ASIO non connecté, impossible d\'ouvrir le panneau');
      return;
    }
    this.asioBridge.openControlPanel();
  }

  public setBpm(bpm: number) {
    this.currentBpm = bpm;
    this.tracksDSP.forEach(dsp => {
        dsp.pluginChain.forEach(p => {
            if (p.instance && typeof p.instance.updateParams === 'function') {
                p.instance.updateParams({ bpm: this.currentBpm });
            }
        });
    });
  }

  /** Gain des VCA par piste membre (utils/trackStructure, engineView). */
  private vcaScale: Map<string, number> = new Map();

  public setTrackVolume(trackId: string, volume: number, isMuted: boolean) {
    const tm = this.trackMix.get(trackId);
    if (tm) tm.volume = volume;
    volume *= this.vcaScale.get(trackId) ?? 1;
    const dsp = this.tracksDSP.get(trackId);
    const live = this.liveTracks?.find(t => t.id === trackId);
    // Read : la courbe garde la main pendant la lecture (le fader ne la combat pas).
    if (!isMuted && live && this.automationOwns(live, 'volume')) return;
    if (dsp && this.ctx) {
        const targetGain = (isMuted || this.soloSilencedIds.has(trackId)) ? 0 : volume;
        dsp.gain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.015);
    }
  }

  public setTrackPan(trackId: string, pan: number) {
    const tm = this.trackMix.get(trackId);
    if (tm && tm.pan !== pan) { tm.pan = pan; if (this.inputRouter?.has(trackId)) this.syncDirectMonitor(); }
    const live = this.liveTracks?.find(t => t.id === trackId);
    if (live && this.automationOwns(live, 'pan')) return;
    const dsp = this.tracksDSP.get(trackId);
    if (dsp && this.ctx) {
        dsp.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.015);
    }
  }
}

export const audioEngine = new AudioEngine();
