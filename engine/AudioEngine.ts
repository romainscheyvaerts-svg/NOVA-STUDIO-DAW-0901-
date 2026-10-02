
import { Track, Clip, PluginInstance, TrackType, TrackSend, AutomationLane, PluginParameter, PluginType, MidiNote, DrumPad, AutomationPoint } from '../types';
import { getASIOBridge, ASIOBridgeClient, ASIOConfig, AudioDevice, ASIOStats } from '../services/ASIOBridge';
import { ASIOInput } from './ASIOInput';
import { ReverbNode } from '../plugins/ReverbPlugin';
import { SyncDelayNode } from '../plugins/DelayPlugin';
import { ChorusNode } from '../plugins/ChorusPlugin';
import { FlangerNode } from '../plugins/FlangerPlugin';
import { VocalDoublerNode } from '../plugins/DoublerPlugin';
import { StereoSpreaderNode } from '../plugins/StereoSpreaderPlugin';
import { AutoTuneNode } from '../plugins/AutoTunePlugin';
import { CompressorNode } from '../plugins/CompressorPlugin';
import { DeEsserNode } from '../plugins/DeEsserPlugin';
import { DenoiserNode } from '../plugins/DenoiserPlugin';
import { ProEQ12Node } from '../plugins/ProEQ12Plugin';
import { VocalSaturatorNode } from '../plugins/VocalSaturatorPlugin';
import { MasterSyncNode } from '../plugins/MasterSyncPlugin';
import { Synthesizer } from './Synthesizer';
import { AudioSampler } from './AudioSampler';
import { DrumSamplerNode } from './DrumSamplerNode';
import { MelodicSamplerNode } from './MelodicSamplerNode';
import { interpolateCurve } from '../services/AutomationManager';
import { DrumRackNode } from './DrumRackNode'; // NEW
import { DrumPadFxBank } from './DrumPadFx';
import { NovaRecorderSession, ensureRecorderModule, encodeWav24 } from './NovaRecorder';
import { VSTPluginNode } from './VSTPluginNode';
import { isTrackFrozen, preFreezePlugins, postFreezePlugins, uncoveredClips, freezeIndex, frozenPlayback } from '../utils/freeze';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

interface TrackDSP {
  input: GainNode;          
  output: GainNode;         
  panner: StereoPannerNode; 
  gain: GainNode;           
  analyzer: AnalyserNode;
  inputAnalyzer?: AnalyserNode; 
  pluginChain: Map<string, { input: AudioNode; output: AudioNode; instance: any; connectedTo?: AudioNode }>;
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
  inputStream?: MediaStreamAudioSourceNode | null;
  currentInputDeviceId?: string | null;
  synth?: Synthesizer; // PolySynth for MIDI tracks
  sampler?: AudioSampler; // Legacy/Chromatic Sampler
  drumSampler?: DrumSamplerNode; // Pro Drum Sampler (Single)
  melodicSampler?: MelodicSamplerNode; // New Pro Melodic Sampler
  drumRack?: DrumRackNode; // NEW: 30-Pad Drum Rack
  /** Mix par pad de la batterie Make Music. */
  drumFx?: DrumPadFxBank;
  // Empreinte du cablage (plugins, routage, departs) : permet d'eviter de
  // reconstruire — et donc de couper brievement — le graphe quand rien de
  // structurel n'a change.
  graphSignature?: string;
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
  private asioOutputProcessor: ScriptProcessorNode | null = null;

  constructor() {}

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
    this.masterLimiter.connect(this.masterAnalyzer);
    // Sortie « navigateur » coupée pendant le flux ASIO : le mix part alors par
    // la carte, sinon l'artiste l'entendait deux fois (écho / effet de phase).
    this.browserOutput = this.ctx.createGain();
    this.masterAnalyzer.connect(this.browserOutput);
    this.browserOutput.connect(this.ctx.destination);
    
    this.masterAnalyzer.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyzerL, 0);
    this.masterSplitter.connect(this.masterAnalyzerR, 1);

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
  public measureRecordLatency(): { total: number; mode: 'asio' | 'navigateur' } {
    if (!this.ctx) return { total: 0, mode: 'navigateur' };
    const sr = this.ctx.sampleRate;
    if (this.isUsingASIOInput() && this.asioStreamActive) {
      // pilote (entrée + sortie) + file de sortie du pont + tampon d'envoi (2 × 256)
      // + tampon d'entrée de Nova + réseau local
      const fill = this.asioInput?.fillSec ?? 0.03;
      const total = (this.latency || 0) + this.asioQueueSec + 512 / sr + fill + 0.002;
      return { total: Math.min(0.5, total), mode: 'asio' };
    }
    const out = (this.ctx.baseLatency || 0) + ((this.ctx as any).outputLatency || 0);
    let inp = 0.01;
    try {
      const s = this.activeMonitorStream?.getAudioTracks()[0]?.getSettings() as any;
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

  /** Retour direct dans le pont ASIO quand la voix arrive par la carte son. */
  private syncDirectMonitor() {
    if (!this.asioBridge || !this.asioConnected) return;
    const direct = this.isUsingASIOInput() && this.asioStreamActive && !!this.monitoringTrackId;
    this.asioBridge.setMonitor(direct && this.inputMonitoring, this.monitorLevel, this.asioInput ? this.getASIOInputChannel() : -1);
    // Le retour logiciel est coupé : sinon la voix serait entendue deux fois (avec du retard)
    if (direct && this.monitorGain && this.ctx) this.monitorGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
  }

  public setLoop(active: boolean, start: number, end: number) {
    this.isLoopActive = active;
    this.loopStart = start;
    this.loopEnd = end;
  }
  
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
   */
  public async renderProject(tracks: Track[], totalDuration: number, startOffset: number = 0, targetSampleRate: number = 44100, onProgress?: (progress: number) => void, options: { preFader?: boolean } = {}): Promise<AudioBuffer> {
    const totalSamples = Math.ceil(totalDuration * targetSampleRate);
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
      input: GainNode;
      gain: GainNode;
      panner: StereoPannerNode;
      output: GainNode;
      sends: Map<string, GainNode>;
      synth?: Synthesizer;
      sampler?: AudioSampler;
      drumRack?: DrumRackNode;
    }
    const rendered = new Map<string, RenderTrack>();
    // Certains plugins (AutoTune) s'initialisent de maniere asynchrone : on
    // attend qu'ils soient prets avant de lancer le rendu.
    const pendingPlugins: Promise<unknown>[] = [];

    // --- 1. Une chaine par piste : input -> [plugins] -> gain -> panner -> output
    for (const track of tracks) {
      const input = offlineCtx.createGain();
      // Meme regle qu'en lecture : la chaine est stereo des l'entree, sinon une
      // piste mono changeait de niveau selon qu'elle porte un plugin ou non.
      input.channelCount = 2;
      input.channelCountMode = 'explicit';
      input.channelInterpretation = 'speakers';
      const gain = offlineCtx.createGain();
      const panner = offlineCtx.createStereoPanner();
      const output = offlineCtx.createGain();

      let head: AudioNode = input;
      // Piste gelee : meme cablage qu'en lecture (rendu -> effets restants).
      const frozen = isTrackFrozen(track);
      const prePlugins = frozen ? (uncoveredClips(track).length > 0 ? preFreezePlugins(track) : []) : (track.plugins || []);
      const postPlugins = frozen ? postFreezePlugins(track) : [];
      let offlineLatency = 0;
      let postLatency = 0;
      let frozenInput: GainNode | undefined;
      const addPlugin = (plugin: PluginInstance, isPost: boolean) => {
        if (!plugin.isEnabled) return;
        try {
          const entry = this.createPluginNode(plugin, this.currentBpm, renderCtx);
          if (!entry) return;
          if (entry.node?.ready instanceof Promise) pendingPlugins.push(entry.node.ready);
          head.connect(entry.input);
          head = entry.output;
          const l = entry.node?.latency;
          if (typeof l === 'number' && l > 0 && l < 0.5) {
            offlineLatency += l;
            if (isPost) postLatency += l;
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
      head.connect(gain);
      gain.connect(panner);
      panner.connect(output);

      // Le solo ne concerne que les pistes sources : un bus ne doit pas etre coupe.
      const silenced = track.isMuted || soloSilenced.has(track.id);
      gain.gain.value = silenced ? 0 : (options.preFader ? 1 : track.volume);
      panner.pan.value = options.preFader ? 0 : track.pan;

      const rt: RenderTrack = {
        input, gain, panner, output, sends: new Map(), latency: offlineLatency,
        frozenInput, frozenClipId: frozen ? track.frozenClip!.id : undefined, postLatency,
      };

      // Instruments (pistes MIDI / sampler / drum rack)
      if (track.type === TrackType.MIDI) {
        rt.synth = new Synthesizer(renderCtx);
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
      rt.output.connect(dest ? dest.input : masterGain);

      (track.sends || []).forEach(send => {
        if (!send.id || !send.isEnabled || send.level <= 0) return;
        if (send.id === track.id) return;
        const target = rendered.get(send.id);
        if (!target) return;
        const sendGain = offlineCtx.createGain();
        sendGain.gain.value = send.level;
        rt.panner.connect(sendGain);
        sendGain.connect(target.input);
        rt.sends.set(send.id, sendGain);
      });
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
      if (options.preFader) continue; // gel : volume/pan appliques a la lecture

      (track.automationLanes || []).forEach(lane => {
        const cible = this.cibleAutomation(lane.parameterName, rt.gain.gain, rt.panner.pan, rt.sends);
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
      totalClips += this.getPlayableClips(track).filter(c => !c.isMuted).length;
    });

    // --- 4. Clips audio (toutes les pistes qui en portent, bus et sends inclus)
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;

      for (const clip of this.getPlayableClips(track)) {
        if (clip.isMuted) continue;
        if (clip.type === TrackType.MIDI) continue; // traite plus bas

        let buffer = clip.buffer;
        if (!buffer && clip.bufferId) buffer = audioBufferRegistry.get(clip.bufferId);
        if (!buffer) {
          console.warn(`[Render] Buffer introuvable pour le clip ${clip.id}`);
          continue;
        }

        const isFrozenRender = !!rt.frozenInput && (clip.id === rt.frozenClipId || !!clip.isFreezeSlice);
        const clipStartInProject = clip.start - startOffset - ((isFrozenRender ? rt.postLatency : rt.latency) || 0);
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
        const remainingDuration = Math.min(clip.duration, totalDuration - startTime, buffer.duration - offsetIntoClip);

        if (remainingDuration > 0 && offsetIntoClip < buffer.duration) {
          if (clip.fadeIn > 0) {
            clipGain.gain.setValueAtTime(0, startTime);
            clipGain.gain.linearRampToValueAtTime(clip.gain ?? 1.0, startTime + clip.fadeIn);
          }
          if (clip.fadeOut > 0) {
            const fadeOutStart = startTime + remainingDuration - clip.fadeOut;
            if (fadeOutStart > startTime) {
              clipGain.gain.setValueAtTime(clip.gain ?? 1.0, fadeOutStart);
              clipGain.gain.linearRampToValueAtTime(0, startTime + remainingDuration);
            }
          }
          source.start(startTime, offsetIntoClip, remainingDuration);
        }

        processedClips++;
        if (onProgress) onProgress(Math.round((processedClips / Math.max(1, totalClips)) * 80));
      }
    }

    // --- 5. Clips MIDI : on rejoue les notes sur l'instrument de la piste
    for (const track of tracks) {
      const rt = rendered.get(track.id)!;
      if (!rt.synth && !rt.sampler && !rt.drumRack) continue;
      // Piste gelee : seules les notes ajoutees apres le rendu sont rejouees.
      for (const clip of (isTrackFrozen(track) ? uncoveredClips(track) : (track.clips || []))) {
        if (clip.isMuted || clip.type !== TrackType.MIDI || !clip.notes) continue;

        for (const note of clip.notes) {
          const noteStart = clip.start + note.start - startOffset;
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
            rt.drumRack.trigger(note.pitch, note.velocity, attackAt);
          }
        }
        processedClips++;
        if (onProgress) onProgress(Math.round((processedClips / Math.max(1, totalClips)) * 80));
      }
    }

    if (pendingPlugins.length > 0) {
      await Promise.all(pendingPlugins.map(pr => pr.catch(() => undefined)));
    }

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
  public async armTrack(trackId: string): Promise<string | null> {
    if (!this.ctx) await this.init();
    if (this.ctx!.state !== 'running' && this.ctx!.state !== 'closed') await this.ctx!.resume();
    if (this.armingPromise) await this.armingPromise;
    this.armingPromise = this._armTrackInternal(trackId);
    await this.armingPromise;
    this.armingPromise = null;
    const erreur = this.derniereErreurArmement;
    this.derniereErreurArmement = null;
    return erreur;
  }

  private derniereErreurArmement: string | null = null;

  private async _armTrackInternal(trackId: string) {
    this.disarmTrack();
    this.monitoringTrackId = trackId;
    
    let dsp = this.tracksDSP.get(trackId);
    
    let attempts = 0;
    const maxAttempts = 10;
    while (!dsp && attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 15)); // 15ms entre checks
        dsp = this.tracksDSP.get(trackId);
        attempts++;
    }
    
    if (!dsp) {
      console.error("[AudioEngine] ARM FAILED - No DSP for track:", trackId);
      this.monitoringTrackId = null;
      this.derniereErreurArmement = "Piste indisponible pour l'enregistrement.";
      return;
    }

    try {
      // Le peripherique choisi dans les reglages audio n'etait jamais transmis :
      // l'enregistrement utilisait toujours l'entree par defaut du systeme.
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (this.currentInputDeviceId && this.currentInputDeviceId !== 'default') {
        audioConstraints.deviceId = { exact: this.currentInputDeviceId };
      }

      try {
        this.activeMonitorStream = await this.openInputStream(audioConstraints);
      } catch (deviceError) {
        // Peripherique debranche ou refuse : on retombe sur l'entree par defaut
        // plutot que d'echouer completement l'armement.
        console.warn("[AudioEngine] Entree demandee indisponible, repli sur le peripherique par defaut", deviceError);
        this.activeMonitorStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      }
      this.monitorSource = this.ctx!.createMediaStreamSource(this.activeMonitorStream);
      this.wireMonitor(dsp);
      this.setTrackLowLatency(trackId, true);
      this.syncDirectMonitor();
      this.startLatencyWatch();
      console.log("[AudioEngine] Track armed OK:", trackId);
    } catch (e: any) {
      console.error("[AudioEngine] ARM ERROR:", e);
      this.monitoringTrackId = null;
      this.activeMonitorStream = null;
      // On traduit les cas courants plutot que de renvoyer un nom technique.
      const nom = e?.name || '';
      if (nom === 'NotAllowedError' || nom === 'SecurityError') {
        this.derniereErreurArmement = "Micro refusé. Autorisez-le dans votre navigateur puis réessayez.";
      } else if (nom === 'NotFoundError' || nom === 'OverconstrainedError') {
        this.derniereErreurArmement = "Aucun micro détecté. Branchez-en un puis réessayez.";
      } else if (nom === 'NotReadableError') {
        this.derniereErreurArmement = "Micro déjà utilisé par une autre application.";
      } else {
        this.derniereErreurArmement = `Micro inaccessible : ${e?.message || 'erreur inconnue'}`;
      }
    }
  }

  /** Micro → indicateur de niveau (toujours) et → piste via le gain de retour. */
  private wireMonitor(dsp: { input: AudioNode; inputAnalyzer?: AnalyserNode }) {
    if (!this.monitorSource || !this.ctx) return;
    if (dsp.inputAnalyzer) this.monitorSource.connect(dsp.inputAnalyzer);
    if (this.monitorGain) { try { this.monitorGain.disconnect(); } catch { /* déjà déconnecté */ } }
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = this.inputMonitoring ? this.monitorLevel : 0;
    this.monitorSource.connect(this.monitorGain);
    this.monitorGain.connect(dsp.input);
  }

  /** Active / coupe le retour du micro dans le casque. */
  public setInputMonitoring(on: boolean) {
    this.inputMonitoring = on;
    if (this.monitorGain && this.ctx) this.monitorGain.gain.setTargetAtTime(on ? this.monitorLevel : 0, this.ctx.currentTime, 0.01);
    this.syncDirectMonitor();
    try { window.dispatchEvent(new CustomEvent('nova:monitoring', { detail: on })); } catch { /* */ }
  }

  /** Volume du retour casque (la prise enregistrée n'est pas affectée). */
  public setMonitorLevel(level: number) {
    this.monitorLevel = Math.min(2, Math.max(0, level));
    try { localStorage.setItem('nova_monitor_level', String(this.monitorLevel)); } catch { /* */ }
    if (this.monitorGain && this.ctx && this.inputMonitoring) this.monitorGain.gain.setTargetAtTime(this.monitorLevel, this.ctx.currentTime, 0.01);
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

  public setRecordingFreeze(trackId: string, freeze: { clip: Clip; upTo: number; clipIds: string[] } | null) {
    if (freeze) this.recFreezes.set(trackId, freeze); else this.recFreezes.delete(trackId);
    const dsp = this.tracksDSP.get(trackId);
    if (dsp) dsp.graphSignature = undefined; // recâblage au prochain updateTrack
  }

  public setDelayCompensationSuspended(on: boolean) { this.pdcSuspended = on; }

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

  public getTrackLatency(trackId: string): number { return this.tracksDSP.get(trackId)?.pluginLatency || 0; }

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
  }

  public disarmTrack() {
    if (this.monitoringTrackId) this.setTrackLowLatency(this.monitoringTrackId, false);
    this.stopLatencyWatch();
    if (this.asioBridge && this.asioConnected) this.asioBridge.setMonitor(false, this.monitorLevel, -1);
    if (this.monitorGain) {
      try { this.monitorGain.disconnect(); } catch { /* déjà déconnecté */ }
      this.monitorGain = null;
    }
    if (this.monitorSource) {
      this.monitorSource.disconnect();
      this.monitorSource = null;
    }
    if (this.activeMonitorStream) {
      this.stopInputStream(this.activeMonitorStream);
      this.activeMonitorStream = null;
    }
    this.monitoringTrackId = null;
  }

  public async startRecording(currentTime: number, trackId: string): Promise<boolean> {
    console.log("[AudioEngine] startRecording called - stream:", !!this.activeMonitorStream, "recording:", this.recordingTrackId);
    
    if (!this.activeMonitorStream) {
      console.error("[AudioEngine] REC FAILED - No monitor stream! Arm track first.");
      return false;
    }
    if (this.recordingTrackId) {
      console.error("[AudioEngine] REC FAILED - Already recording on:", this.recordingTrackId);
      return false;
    }
    
    // Enregistreur interne (AudioWorklet) : position exacte + son sans compression.
    try {
      if (this.ctx && this.ctx.audioWorklet) {
        await ensureRecorderModule(this.ctx);
        const src: AudioNode | null = (this.isUsingASIOInput() && this.asioInput?.getNode()) || this.monitorSource;
        if (src) {
          this.recSource = src;
          this.recSession = new NovaRecorderSession(this.ctx, src);
          this.recPlayStart = this.isPlaying ? this.playbackStartTime : null;
          this.recStartTime = currentTime;
          this.recordingTrackId = trackId;
          this.latencySamples = [];
          if (!this.latencyTimer) this.startLatencyWatch();
          console.log("[AudioEngine] Recording started (enregistreur calé) on track:", trackId);
          return true;
        }
      }
    } catch (e) {
      console.warn("[AudioEngine] Enregistreur calé indisponible, repli sur MediaRecorder", e);
      this.recSession = null;
      this.recSource = null;
    }

    try {
      this.mediaRecorder = new MediaRecorder(this.activeMonitorStream);
      this.audioChunks = [];
      this.recStartTime = currentTime;
      this.recordingTrackId = trackId;
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      this.mediaRecorder.start();
      console.log("[AudioEngine] Recording started OK on track:", trackId);
      return true;
    } catch (e) {
      console.error("[AudioEngine] REC ERROR:", e);
      this.recordingTrackId = null;
      return false;
    }
  }

  public async stopRecording(): Promise<{ clip: Clip, trackId: string } | null> {
    if (this.recSession && this.recordingTrackId && this.ctx) return this.stopCalibratedRecording();
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive' || !this.recordingTrackId) {
      return null;
    }
    
    const trackIdToRearm = this.monitoringTrackId; // Sauvegarder pour ré-armement
    
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
        this.recStartTime = 0;
        this.mediaRecorder = null;
        
        if (blob.size === 0) {
          // Ré-armer la piste pour permettre un nouvel enregistrement
          if (trackIdToRearm) {
            await this.rearmTrackForNextRecording(trackIdToRearm);
          }
          resolve(null);
          return;
        }
        
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
          
          // Ré-armer la piste pour permettre un nouvel enregistrement
          if (trackIdToRearm) {
            await this.rearmTrackForNextRecording(trackIdToRearm);
          }
          
          resolve({ clip: clipData, trackId });
        } catch (e) {
          console.error("Error processing recorded audio:", e);
          // Ré-armer même en cas d'erreur
          if (trackIdToRearm) {
            await this.rearmTrackForNextRecording(trackIdToRearm);
          }
          resolve(null);
        }
      };
      this.mediaRecorder.stop();
    });
  }

  /**
   * Fin d'une prise de l'enregistreur calé : la prise est replacée exactement
   * où elle aurait dû être (position de lecture au début de la prise, moins la
   * latence moyenne mesurée pendant la prise, plus le réglage fin manuel).
   */
  private async stopCalibratedRecording(): Promise<{ clip: Clip, trackId: string } | null> {
    const ctx = this.ctx!;
    const trackId = this.recordingTrackId!;
    const session = this.recSession!;
    const src = this.recSource!;
    const recordedAt = this.recStartTime;
    const playStart = this.recPlayStart ?? (this.isPlaying ? this.playbackStartTime : null);
    this.recPlayStart = null;
    this.recSession = null;
    this.recSource = null;
    this.recordingTrackId = null;
    this.recStartTime = 0;

    const { samples, firstFrame } = await session.stop(src);
    if (!samples.length) return null;
    const sr = ctx.sampleRate;

    // Position de chaque échantillon sur la timeline : (frame / sr) − début de lecture.
    let lead = 0;
    let rawStart = recordedAt;
    if (playStart !== null && firstFrame >= 0) {
      const playCtxAtStart = playStart + recordedAt;        // instant (horloge) où la lecture a démarré
      lead = Math.max(0, Math.round((playCtxAtStart - firstFrame / sr) * sr));
      rawStart = (firstFrame + lead) / sr - playStart;
    }
    const measured = this.latencySamples.length
      ? this.latencySamples.reduce((s, v) => s + v, 0) / this.latencySamples.length
      : this.measureRecordLatency().total;
    const latency = measured + this.recOffsetMs / 1000;
    let start = rawStart - latency;
    let skip = 0;
    if (start < 0) { skip = Math.round(-start * sr); start = 0; }

    const body = samples.subarray(Math.min(samples.length, lead + skip));
    if (body.length < sr * 0.05) return null;
    const buffer = ctx.createBuffer(1, body.length, sr);
    buffer.copyToChannel(body, 0);
    const blob = encodeWav24(body, sr);
    console.log(`[AudioEngine] Prise replacée : latence ${Math.round(latency * 1000)} ms (mesurée ${Math.round(measured * 1000)} ms, réglage ${this.recOffsetMs} ms)`);
    try { window.dispatchEvent(new CustomEvent('nova:take-aligned', { detail: { ms: Math.round(latency * 1000) } })); } catch { /* */ }

    return {
      trackId,
      clip: {
        id: `rec-${Date.now()}`,
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
    };
  }

  /**
   * Ré-arme la piste avec un nouveau MediaStream pour permettre plusieurs enregistrements consécutifs.
   * Le MediaRecorder ne peut pas être réutilisé après stop(), donc on doit recréer le stream.
   */
  private async rearmTrackForNextRecording(trackId: string): Promise<void> {
    console.log("[AudioEngine] Re-arming track for next recording:", trackId);
    
    // Fermer l'ancien stream proprement
    if (this.monitorSource) {
      try { this.monitorSource.disconnect(); } catch (e) {}
      this.monitorSource = null;
    }
    if (this.activeMonitorStream) {
      this.stopInputStream(this.activeMonitorStream);
      this.activeMonitorStream = null;
    }
    
    // Recréer un nouveau stream
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) {
      console.warn("[AudioEngine] Cannot rearm - DSP not found for track:", trackId);
      this.monitoringTrackId = null;
      return;
    }
    
    try {
      // Même entrée que l'armement initial : sans deviceId, la 2e prise passait
      // sur le micro par défaut au lieu de l'interface choisie.
      const constraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (this.currentInputDeviceId && this.currentInputDeviceId !== 'default') {
        constraints.deviceId = { exact: this.currentInputDeviceId };
      }
      try {
        this.activeMonitorStream = await this.openInputStream(constraints);
      } catch {
        this.activeMonitorStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      }
      this.monitorSource = this.ctx!.createMediaStreamSource(this.activeMonitorStream);
      this.wireMonitor(dsp);
      this.monitoringTrackId = trackId;
      console.log("[AudioEngine] Track re-armed OK:", trackId);
    } catch (e) {
      console.error("[AudioEngine] Re-arm ERROR:", e);
      this.monitoringTrackId = null;
      this.activeMonitorStream = null;
    }
  }

  public startPlayback(startOffset: number, tracks: Track[]) {
    if (!this.ctx) return;
    if (this.isPlaying) this.stopAll();
    // L'extrait du catalogue jouait en même temps que le projet : on le coupe
    // (lecteur interne ici, lecteur <audio> du catalogue via l'événement).
    this.stopPreview();
    window.dispatchEvent(new Event('nova:transport-start'));

    this.isPlaying = true;
    this.pendingLoopWrap = null;
    this.pausedAt = startOffset;
    this.nextScheduleTime = this.ctx.currentTime + 0.01; 
    this.playbackStartTime = this.ctx.currentTime - startOffset;
    if (this.recSession && this.recPlayStart === null) this.recPlayStart = this.playbackStartTime; 

    // Valeur correcte au demarrage : sans ca, une piste dont tous les points
    // d'automation sont anterieurs au point de depart gardait la valeur du
    // dernier rebuild du graphe au lieu de la valeur automatisee.
    tracks.forEach(track => this.applyAutomation(track, startOffset));

    this.liveTracks = tracks;
    this.clipSigs = this.computeClipSigs(tracks);
    this.schedulerTimer = window.setInterval(() => {
      this.scheduler(this.liveTracks || tracks);
    }, this.LOOKAHEAD_MS);
  }

  public stopAll() {
    // On memorise la position reelle d'arret : sans ca getCurrentTime() renvoyait
    // apres un stop la position de DEPART de la lecture, pas celle de l'arret.
    if (this.isPlaying) this.pausedAt = this.getCurrentTime();
    this.isPlaying = false;
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
        if (dsp.synth) dsp.synth.releaseAll();
        if (dsp.sampler) dsp.sampler.stopAll();
        if (dsp.drumSampler) dsp.drumSampler.stop();
        if (dsp.melodicSampler) dsp.melodicSampler.stopAll();
    });
    this.activeMidiNotes.clear();
    if (this.ctx) {
      const now = this.ctx.currentTime;
      this.tracksDSP.forEach(dsp => {
        try {
          dsp.gain.gain.cancelScheduledValues(now);
          dsp.gain.gain.setValueAtTime(dsp.gain.gain.value, now);
          dsp.panner.pan.cancelScheduledValues(now);
          dsp.panner.pan.setValueAtTime(dsp.panner.pan.value, now);
        } catch (e) {}
      });
    }
    this.stopScrubbing();
  }

  public seekTo(time: number, tracks: Track[], wasPlaying: boolean) {
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

  public scrub(tracks: Track[], time: number, velocity: number) { /* ... */ }
  public stopScrubbing() { /* ... */ }

  private computeClipSigs(tracks: Track[]): Map<string, string> {
    const m = new Map<string, string>();
    tracks.forEach(t => this.getPlayableClips(t).forEach(c => {
      m.set(c.id, `${t.id}|${c.start}|${c.offset}|${c.duration}|${c.isMuted ? 1 : 0}|${c.bufferId || ''}|${c.gain ?? 1}|${c.fadeIn}|${c.fadeOut}|${c.isReversed ? 1 : 0}`);
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
  public setLiveTracks(tracks: Track[]) {
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
        this.scheduleAutomation(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
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
      if (dsp.sampler) dsp.sampler.stopAll();
      if (dsp.drumSampler) dsp.drumSampler.stop();
      if (dsp.melodicSampler) dsp.melodicSampler.stopAll();
    });
    this.activeMidiNotes.clear();

    // Les rampes d'automation programmees au-dela du point de bouclage doivent
    // etre annulees, sinon elles continuent de piloter le gain apres le retour.
    this.tracksDSP.forEach(dsp => {
      try {
        dsp.gain.gain.cancelScheduledValues(boundaryContextTime);
        dsp.panner.pan.cancelScheduledValues(boundaryContextTime);
      } catch (e) {}
    });

    const previousStartTime = this.playbackStartTime;
    this.playbackStartTime = boundaryContextTime - this.loopStart;
    this.pendingLoopWrap = { atContextTime: boundaryContextTime, previousStartTime };

    tracks.forEach(track => this.applyAutomation(track, this.loopStart));
  }

  /** Clips reellement joues : le rendu gele remplace les clips d'origine. */
  private getPlayableClips(track: Track): Clip[] {
    track = this.eff(track);
    if (isTrackFrozen(track)) { const p = frozenPlayback(track); return [...p.render, ...p.live]; }
    return track.clips || [];
  }

  private scheduleClips(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number, maxLatency: number, latencies: Map<string, number>) {
      tracks.map(t => this.eff(t)).forEach(track => {
      if (track.isMuted) return; 
      const isFrozenRender = isTrackFrozen(track);
      if (!isFrozenRender && track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS && track.type !== TrackType.SEND) return;

      this.getPlayableClips(track).forEach(clip => {
        const sourceKey = `${clip.id}`; 
        if (this.activeSources.has(sourceKey)) return;
        
        const clipEnd = clip.start + clip.duration;
        const lat = this.pdcSuspended ? 0 : (this.tracksDSP.get(track.id)?.pluginLatency || 0);
        const overlapsWindow = clip.start < projectWindowEnd + lat && clipEnd > projectWindowStart;
        if (overlapsWindow) {
           this.playClipSource(track.id, clip, contextScheduleTime, projectWindowStart);
        }
      });
    });
  }

  private scheduleMidi(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number) {
      tracks.map(t => this.eff(t)).forEach(track => {
        if (track.isMuted) return;
        if (track.type !== TrackType.MIDI && track.type !== TrackType.SAMPLER && track.type !== TrackType.DRUM_RACK) return;
        // Piste gelee : seules les notes ajoutees apres le rendu sont jouees.
        const midiClips = isTrackFrozen(track) ? uncoveredClips(track) : track.clips;

        midiClips.forEach(clip => {
           if (clip.type !== TrackType.MIDI || !clip.notes) return;
           
           const clipEnd = clip.start + clip.duration;
           if (clip.start >= projectWindowEnd || clipEnd <= projectWindowStart) return;

           clip.notes.forEach(note => {
               const noteAbsStart = clip.start + note.start;
               const noteAbsEnd = noteAbsStart + note.duration;

               if (noteAbsStart >= projectWindowStart && noteAbsStart < projectWindowEnd) {
                   const timeOffset = noteAbsStart - projectWindowStart;
                   const scheduleTime = contextScheduleTime + timeOffset;
                   this.triggerTrackAttack(track.id, note.pitch, note.velocity, scheduleTime);
               }

               if (noteAbsEnd >= projectWindowStart && noteAbsEnd < projectWindowEnd) {
                   const timeOffset = noteAbsEnd - projectWindowStart;
                   const scheduleTime = contextScheduleTime + timeOffset;
                   this.triggerTrackRelease(track.id, note.pitch, scheduleTime);
               }
           });
        });
      });
  }
  
  public triggerTrackAttack(trackId: string, pitch: number, velocity: number, time: number = 0) {
      if (!this.ctx) return;
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;
      
      const now = Math.max(time, this.ctx.currentTime);
      
      if (dsp.synth) dsp.synth.triggerAttack(pitch, velocity, now);
      else if (dsp.melodicSampler) dsp.melodicSampler.triggerAttack(pitch, velocity, now);
      else if (dsp.drumSampler) dsp.drumSampler.trigger(velocity, now);
      else if (dsp.drumRack) dsp.drumRack.trigger(pitch, velocity, now);
      else if (dsp.sampler) dsp.sampler.triggerAttack(pitch, velocity, now);
  }

  public triggerTrackRelease(trackId: string, pitch: number, time: number = 0) {
      if (!this.ctx) return;
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;
      
      const now = Math.max(time, this.ctx.currentTime);
      
      if (dsp.synth) dsp.synth.triggerRelease(pitch, now);
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
    sends: Map<string, GainNode>
  ): AudioParam | null {
    if (nomParametre === 'volume') return gain;
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

  private scheduleAutomation(tracks: Track[], start: number, end: number, when: number) {
    tracks.forEach(track => {
        const dsp = this.tracksDSP.get(track.id);
        if (!dsp) return;
        // L'automation partage le noeud de gain avec le fader/mute/solo : sans ce
        // garde-fou, une piste mutee (ou coupee par un solo) redevenait audible
        // des qu'elle portait de l'automation de volume.
        if (track.isMuted || this.soloSilencedIds.has(track.id)) return;
        
        track.automationLanes.forEach(lane => {
            if (lane.points.length === 0) return;
            
            lane.points.forEach((point, index) => {
                if (point.time >= start && point.time < end) {
                    const scheduleTime = when + (point.time - start);
                    
                    const ancre = this.cibleAutomation(lane.parameterName, dsp.gain.gain, dsp.panner.pan, dsp.sends);
                    if (ancre) ancre.setValueAtTime(point.value, scheduleTime);
                    
                    const nextPoint = lane.points[index + 1];
                    if (nextPoint) {
                        // On programme la rampe meme si le point suivant sort de la
                        // fenetre : sinon la valeur restait en palier jusqu'a lui.
                        const nextScheduleTime = when + (nextPoint.time - start);
                        const cible = this.cibleAutomation(lane.parameterName, dsp.gain.gain, dsp.panner.pan, dsp.sends);
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
        const pt = projectTime + (this.pdcSuspended ? 0 : ((isFrozenRender ? dsp.postFreezeLatency : dsp.pluginLatency) || 0));
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
        const clipZero = when - playedSoFar;               // instant où le clip serait à 0
        const clipEnd = clipZero + clip.duration;
        const fi = Math.min(clip.fadeIn || 0, clip.duration);
        const fo = Math.min(clip.fadeOut || 0, clip.duration - fi);
        const gainAt = (t: number) => {                     // t = position dans le clip (s)
            let g = clipGain;
            if (fi > 0 && t < fi) g *= Math.max(0, t / fi);
            if (fo > 0 && t > clip.duration - fo) g *= Math.max(0, (clip.duration - t) / fo);
            return g;
        };
        gainNode.gain.setValueAtTime(gainAt(playedSoFar), when);
        if (fi > 0 && playedSoFar < fi) gainNode.gain.linearRampToValueAtTime(gainAt(fi), clipZero + fi);
        if (fo > 0) {
            const foStart = clip.duration - fo;
            if (playedSoFar < foStart) gainNode.gain.setValueAtTime(gainAt(foStart), clipZero + foStart);
            gainNode.gain.linearRampToValueAtTime(0, clipEnd);
        }
        
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
      case 'AUTOTUNE': node = new AutoTuneNode(ctx); break;
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
      case 'VST3': node = new VSTPluginNode(ctx, plugin); break;
      default:
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

    if (track.type === TrackType.MIDI) {
      dsp.synth = new Synthesizer(this.ctx);
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
    const audible = new Set(tracks.filter(t => t.isSolo).map(t => t.id));
    if (audible.size === 0) return new Set();

    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tracks) {
        if (audible.has(t.id)) continue;
        const feedsAudible =
          (!!t.outputTrackId && audible.has(t.outputTrackId)) ||
          (t.sends || []).some(sd => sd.isEnabled && sd.level > 0 && audible.has(sd.id));
        if (feedsAudible) { audible.add(t.id); changed = true; }
      }
    }
    return new Set(tracks.filter(t => this.isSourceTrackType(t) && !audible.has(t.id)).map(t => t.id));
  }

  /** Tout ce qui impose de recabler le graphe de la piste. */
  private graphSignatureOf(track: Track): string {
    return [
      track.type,
      isTrackFrozen(track)
        ? `frozen:${freezeIndex(track)}:${uncoveredClips(track).length > 0 ? 1 : 0}:${track.frozenClip!.id}`
        : 'live',
      track.outputTrackId || '',
      track.plugins.map(p => `${p.id}:${p.isEnabled ? 1 : 0}`).join(','),
      (track.sends || []).map(sd => `${sd.id}:${sd.isEnabled ? 1 : 0}`).join(',')
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
    try { dsp.sampler?.stopAll(); } catch (e) {}
    try { dsp.drumSampler?.stop(); } catch (e) {}
    try { dsp.melodicSampler?.stopAll(); } catch (e) {}

    dsp.pluginChain.forEach(entry => {
      try { entry.input.disconnect(); entry.output.disconnect(); } catch (e) {}
      try { entry.instance?.dispose?.(); } catch (e) {}
    });
    dsp.pluginChain.clear();

    dsp.sends.forEach(g => { try { g.disconnect(); } catch (e) {} });
    dsp.sends.clear();

    [dsp.input, dsp.gain, dsp.panner, dsp.analyzer, dsp.output, dsp.inputAnalyzer]
      .forEach(n => { try { n?.disconnect(); } catch (e) {} });

    this.tracksDSP.delete(trackId);
  }

  public updateTrack(track: Track, allTracks: Track[]) {
    if (!this.ctx) return;
    track = this.eff(track);

    // Pre-cree les DSP de toutes les pistes: sinon une piste routee vers un bus
    // declare APRES elle dans le tableau retombait silencieusement sur le master.
    allTracks.forEach(t => this.ensureTrackDSP(t));
    this.soloSilencedIds = this.computeSoloSilencedIds(allTracks);

    const dsp = this.ensureTrackDSP(track);
    if (!dsp) return;
    
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
    const signature = this.graphSignatureOf(track);
    if (dsp.graphSignature === signature) {
      const t = this.ctx.currentTime;
      const target = (track.isMuted || this.soloSilencedIds.has(track.id)) ? 0 : track.volume;
      dsp.gain.gain.setTargetAtTime(target, t, 0.015);
      dsp.panner.pan.setTargetAtTime(track.pan, t, 0.015);

      // Seuls les effets cables ont une entree (sur une piste gelee : ceux
      // apres le rendu, qui restent reglables).
      track.plugins.forEach(p => {
        const entry = dsp.pluginChain.get(p.id);
        if (entry && entry.instance && typeof entry.instance.updateParams === 'function') {
          entry.instance.updateParams(p.params);
        }
      });
      (track.sends || []).forEach(send => {
        const sendGain = dsp.sends.get(send.id);
        if (sendGain) sendGain.gain.setTargetAtTime(send.isEnabled ? send.level : 0, t, 0.015);
      });
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
    
    // NOTE: We do NOT disconnect plugin inputs/outputs here as that would break
    // the plugin's internal graph. The plugins manage their own internal connections.
    // We only disconnect the chain between plugins below by rebuilding it.
    
    let head: AudioNode = dsp.input;
    // Sorties d'effets cablees au passage precedent : on ne coupe QUE ces liens
    // (pas le graphe interne des effets). Sans ca, reordonner ou geler une chaine
    // laissait l'ancien lien en place et doublait le signal.
    dsp.pluginChain.forEach(entry => {
      if (entry.connectedTo) {
        try { entry.output.disconnect(entry.connectedTo); } catch (e) {}
        entry.connectedTo = undefined;
      }
    });
    const link = (from: AudioNode, to: AudioNode) => {
      from.connect(to);
      dsp!.pluginChain.forEach(entry => { if (entry.output === from) entry.connectedTo = to; });
    };

    // Piste gelee : rendu -> effets restants -> fader. Les effets compris dans
    // le rendu ne servent plus qu'aux clips ajoutes apres le rendu ; s'il n'y en
    // a pas, ils sont liberes (CPU, et instances du pont VST).
    const frozen = isTrackFrozen(track);
    const prePlugins = frozen ? (uncoveredClips(track).length > 0 ? preFreezePlugins(track) : []) : track.plugins;
    const postPlugins = frozen ? postFreezePlugins(track) : [];
    const currentPluginIds = new Set<string>();
    const chainIds: string[] = [];
    const postIds: string[] = [];
    // Piste armée : effets en mode basse latence (retour casque sans retard).
    const lowLatency = this.lowLatencyTracks.has(track.id);

    const wire = (plugin: PluginInstance, isPost: boolean) => {
      currentPluginIds.add(plugin.id);
      let pEntry = dsp!.pluginChain.get(plugin.id);
      if (!pEntry) {
        const instance = this.createPluginNode(plugin, this.currentBpm);
        if (instance) {
          pEntry = { input: instance.input, output: instance.output, instance: instance.node };
          dsp!.pluginChain.set(plugin.id, pEntry);
          if (instance.node instanceof VSTPluginNode) {
            const trackId = track.id;
            instance.node.setLatencyListener(() => this.recomputeTrackLatency(trackId));
            if (lowLatency) instance.node.setMonitorBypass(true);
          } else if (lowLatency && instance.node?.updateParams) {
            instance.node.updateParams({ ...plugin.params, lowLatency: true });
          }
        }
      } else if (pEntry.instance && pEntry.instance.updateParams) {
        pEntry.instance.updateParams({ ...plugin.params, lowLatency });
      }
      if (pEntry && plugin.isEnabled) {
        link(head, pEntry.input);
        head = pEntry.output;
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
    this.recomputeTrackLatency(track.id);

    dsp.pluginChain.forEach((val, id) => {
      if (!currentPluginIds.has(id)) {
        try {
          val.input.disconnect();
          val.output.disconnect();
          if (val.instance.dispose) {
              val.instance.dispose();
          }
        } catch (e) {}
        dsp!.pluginChain.delete(id);
      }
    });

    link(head, dsp.gain);
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
    if (track.outputTrackId && track.outputTrackId !== track.id) {
      // 'master' est desormais une vraie piste (fader + inserts master).
      // Si elle n'existe pas (ancien projet), on retombe sur la sortie master du moteur.
      const destDSP = this.tracksDSP.get(track.outputTrackId);
      if (destDSP) destNode = destDSP.input;
    }
    dsp.output.connect(destNode);
    
    // === SEND ROUTING - Connect to send/bus tracks ===
    // First, disconnect all existing sends
    dsp.sends.forEach((sendGain, sendId) => {
      try { sendGain.disconnect(); } catch (e) {}
    });
    
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
        const sendLevel = send.isEnabled ? send.level : 0;
        sendGain.gain.setTargetAtTime(sendLevel, now + fadeTime, 0.015);
        
        // Connect from after panner (post-fader send) to send gain
        dsp!.panner.connect(sendGain);
        
        // Find the destination send/bus track and connect
        const destSendDSP = this.tracksDSP.get(send.id);
        if (destSendDSP) {
          sendGain.connect(destSendDSP.input);
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
  }

  private applyAutomation(track: Track, time: number) {
    const dsp = this.tracksDSP.get(track.id);
    if (!dsp || !this.ctx) return;
    if (track.isMuted || this.soloSilencedIds.has(track.id)) return;
    
    track.automationLanes.forEach(lane => {
        if (lane.points.length === 0) return;
        
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
        const cible = this.cibleAutomation(lane.parameterName, dsp.gain.gain, dsp.panner.pan, dsp.sends);
        if (cible) cible.setValueAtTime(value, now);
    });
}

  public getTrackPluginParameters(trackId: string): { pluginId: string, pluginName: string, params: PluginParameter[] }[] { return []; }
  public getMasterAnalyzer() { return this.masterAnalyzer; }
  /** Où envoyer les sons de service (décompte) : le master, pour qu'ils sortent aussi en ASIO. */
  public getMonitorBus(): AudioNode | null { return this.masterOutput || this.ctx?.destination || null; }

  public getTrackAnalyzer(trackId: string) { const dsp = this.tracksDSP.get(trackId); if (!dsp) return null; if (this.monitoringTrackId === trackId && dsp.inputAnalyzer) return dsp.inputAnalyzer; return dsp.analyzer; }
  public getPluginNodeInstance(trackId: string, pluginId: string) { return this.tracksDSP.get(trackId)?.pluginChain.get(pluginId)?.instance || null; }
  public setRecMode(active: boolean) { this.isRecMode = active; }
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
      },
      onDevices: (devices, asioDevices) => {
        this.asioDevices = asioDevices;
        console.log('[AudioEngine] Périphériques ASIO détectés:', asioDevices.length);
      },
      onConfigSet: (success, config) => {
        if (success && config) this.applyASIOConfig(config);
      },
      onConfig: (config) => this.applyASIOConfig(config),
      onStreamStarted: (success, latency_ms) => {
        if (success) {
          this.asioStreamActive = true;
          // latency_ms est en millisecondes ; this.latency est en SECONDES,
          // comme ctx.baseLatency. Sans conversion les deux se melangeaient.
          this.latency = (latency_ms || 0) / 1000;
          console.log(`[AudioEngine] Stream ASIO démarré - Latence: ${latency_ms}ms`);
          // Piste déjà armée sur le micro du navigateur : elle bascule sur la carte.
          if (this.monitoringTrackId && !this.isUsingASIOInput() && !this.recordingTrackId) {
            void this.armTrack(this.monitoringTrackId);
          }
        }
      },
      onStreamStopped: () => {
        this.asioStreamActive = false;
        this.restoreBrowserOutput();
        console.log('[AudioEngine] Stream ASIO arrêté');
        // Piste armée sur la carte : retour au micro du navigateur pour ne pas rester muet.
        if (this.monitoringTrackId && this.isUsingASIOInput() && !this.recordingTrackId) {
          void this.armTrack(this.monitoringTrackId);
        }
      },
      onAudioInput: (audioData, channels) => {
        this.handleASIOInput(audioData, channels);
      },
      onStats: (stats) => {
        this.latency = (stats.latency_ms || 0) / 1000;
        this.asioQueueSec = (stats.queue_ms || 0) / 1000;
        if (stats.sample_rate && this.asioInput) this.asioInput.sourceRate = stats.sample_rate;
      }
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
    
    // Créer un ScriptProcessor pour envoyer l'audio vers ASIO
    if (this.ctx && !this.asioOutputProcessor) {
      this.asioOutputProcessor = this.ctx.createScriptProcessor(256, 2, 2);
      this.asioOutputProcessor.onaudioprocess = (e) => {
        if (this.asioStreamActive && this.asioBridge) {
          const channelData = [
            e.inputBuffer.getChannelData(0),
            e.inputBuffer.getChannelData(1)
          ];
          this.asioBridge.sendAudioFromWorklet(channelData);
        }
        // Sortie du processeur silencieuse : le mix part par la carte. (Le copier
        // ici le faisait aussi sortir par le navigateur, en double.)
        for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
          e.outputBuffer.getChannelData(ch).fill(0);
        }
      };

      // Mix après le limiteur (ce que l'on entend) → carte. Le processeur doit
      // être relié à la destination pour tourner, mais il n'y envoie que du silence.
      const tap = this.masterAnalyzer || this.masterOutput;
      if (tap) {
        tap.connect(this.asioOutputProcessor);
        this.asioOutputProcessor.connect(this.ctx.destination);
      }
    }
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
    
    if (this.asioOutputProcessor) {
      const tap = this.masterAnalyzer || this.masterOutput;
      try { tap?.disconnect(this.asioOutputProcessor); } catch (e) {}
      try {
        this.asioOutputProcessor.disconnect();
      } catch (e) {}
      this.asioOutputProcessor = null;
    }
    this.restoreBrowserOutput();

    this.asioStreamActive = false;
  }

  /**
   * Gérer l'audio entrant du bridge ASIO (entrée micro/instrument)
   */
  private handleASIOInput(audioData: Float32Array, channels: number): void {
    // Le son de la carte arrive en continu ; il n'est entendu / enregistré que
    // si une piste est armée (le flux sert alors de « micro »).
    this.asioInputReceived = true;
    this.asioInput?.push(audioData, channels);
  }

  /**
   * Source d'entrée pour armer une piste : la carte son via le pont ASIO quand
   * son flux tourne, sinon le micro du navigateur (getUserMedia).
   */
  private async openInputStream(constraints: MediaTrackConstraints): Promise<MediaStream> {
    if (this.asioStreamActive && this.asioConnected && this.ctx) {
      this.ensureASIOInput();
      console.log('[AudioEngine] Entrée ASIO utilisée pour la piste armée');
      return this.asioInput!.getStream();
    }
    return navigator.mediaDevices.getUserMedia({ audio: constraints });
  }

  private ensureASIOInput() {
    if (this.asioInput || !this.ctx) return;
    this.asioInput = new ASIOInput(this.ctx, this.asioConfig?.sample_rate || 44100);
    this.asioInput.setChannel(this.getASIOInputChannel());
  }

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

  public setTrackVolume(trackId: string, volume: number, isMuted: boolean) {
    const dsp = this.tracksDSP.get(trackId);
    if (dsp && this.ctx) {
        const targetGain = (isMuted || this.soloSilencedIds.has(trackId)) ? 0 : volume;
        dsp.gain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.015);
    }
  }

  public setTrackPan(trackId: string, pan: number) {
    const dsp = this.tracksDSP.get(trackId);
    if (dsp && this.ctx) {
        dsp.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.015);
    }
  }
}

export const audioEngine = new AudioEngine();
