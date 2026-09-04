
import { Track, Clip, PluginInstance, TrackType, TrackSend, AutomationLane, PluginParameter, PluginType, MidiNote, DrumPad } from '../types';
import { getASIOBridge, ASIOBridgeClient, ASIOConfig, AudioDevice, ASIOStats } from '../services/ASIOBridge';
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
import { DrumRackNode } from './DrumRackNode'; // NEW
import { novaBridge } from '../services/NovaBridge';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

interface TrackDSP {
  input: GainNode;          
  output: GainNode;         
  panner: StereoPannerNode; 
  gain: GainNode;           
  analyzer: AnalyserNode;
  inputAnalyzer?: AnalyserNode; 
  pluginChain: Map<string, { input: AudioNode; output: AudioNode; instance: any }>; 
  sends: Map<string, GainNode>; 
  inputStream?: MediaStreamAudioSourceNode | null;
  currentInputDeviceId?: string | null;
  synth?: Synthesizer; // PolySynth for MIDI tracks
  sampler?: AudioSampler; // Legacy/Chromatic Sampler
  drumSampler?: DrumSamplerNode; // Pro Drum Sampler (Single)
  melodicSampler?: MelodicSamplerNode; // New Pro Melodic Sampler
  drumRack?: DrumRackNode; // NEW: 30-Pad Drum Rack
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
  private masterLimiter: DynamicsCompressorNode | null = null; // SAFETY LIMITER
  private masterAnalyzer: AnalyserNode | null = null; 
  private masterSplitter: ChannelSplitterNode | null = null;
  public masterAnalyzerL: AnalyserNode | null = null;
  public masterAnalyzerR: AnalyserNode | null = null;
  
  // Graph Audio
  private tracksDSP: Map<string, TrackDSP> = new Map();
  private activeSources: Map<string, ScheduledSource> = new Map();
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
  private activeVSTPlugin: { trackId: string, pluginId: string } | null = null;

  // --- ASIO BRIDGE ---
  private asioBridge: ASIOBridgeClient | null = null;
  private asioConnected: boolean = false;
  private asioStreamActive: boolean = false;
  private asioDevices: AudioDevice[] = [];
  private asioConfig: ASIOConfig | null = null;
  private asioInputNode: MediaStreamAudioSourceNode | null = null;
  private asioOutputProcessor: ScriptProcessorNode | null = null;

  constructor() {}

  public async init() {
    if (this.ctx) return;
    
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass({ 
      latencyHint: 'interactive',
      sampleRate: 44100
    });
    
    this.sampleRate = this.ctx.sampleRate;
    this.latency = this.ctx.baseLatency;

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
    this.masterAnalyzer.connect(this.ctx.destination);
    
    this.masterAnalyzer.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyzerL, 0);
    this.masterSplitter.connect(this.masterAnalyzerR, 1);

    this.previewGain = this.ctx.createGain();
    this.previewAnalyzer = this.ctx.createAnalyser();
    this.previewAnalyzer.fftSize = 256; 
    this.previewGain.connect(this.previewAnalyzer);
    this.previewAnalyzer.connect(this.ctx.destination);

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
  
  public setLoop(active: boolean, start: number, end: number) {
    this.isLoopActive = active;
    this.loopStart = start;
    this.loopEnd = end;
  }
  
  public playTestTone() { /* ... */ }

  public async playHighResPreview(url: string, onEnded?: () => void): Promise<void> { 
      await this.init(); 
      if (this.ctx?.state === 'suspended') await this.ctx.resume(); 
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
  public async resume() { if (this.ctx && this.ctx.state === 'suspended') { await this.ctx.resume(); } }
  
  /**
   * Rendu offline du projet.
   *
   * Reconstruit le graphe COMPLET dans un OfflineAudioContext : chaine de plugins
   * de chaque piste, routage vers les bus, departs (sends) post-fader, pistes MIDI
   * et drum racks. Avant, cette methode se contentait d'additionner les pistes
   * AUDIO avec leur volume et leur pan : le fichier exporte ne contenait aucun
   * effet et ne ressemblait pas a ce qu'on entend dans le studio.
   */
  public async renderProject(tracks: Track[], totalDuration: number, startOffset: number = 0, targetSampleRate: number = 44100, onProgress?: (progress: number) => void): Promise<AudioBuffer> {
    const totalSamples = Math.ceil(totalDuration * targetSampleRate);
    const offlineCtx = new OfflineAudioContext(2, totalSamples, targetSampleRate);
    // Les noeuds de plugins/instruments n'utilisent que l'API BaseAudioContext.
    const renderCtx = offlineCtx as unknown as AudioContext;

    const masterGain = offlineCtx.createGain();
    masterGain.connect(offlineCtx.destination);

    // Meme regle de solo qu'en lecture live (source unique de verite).
    const soloSilenced = this.computeSoloSilencedIds(tracks);

    interface RenderTrack {
      input: GainNode;
      gain: GainNode;
      panner: StereoPannerNode;
      output: GainNode;
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
      const gain = offlineCtx.createGain();
      const panner = offlineCtx.createStereoPanner();
      const output = offlineCtx.createGain();

      let head: AudioNode = input;
      const offlinePlugins = (track.isFrozen && track.frozenClip) ? [] : (track.plugins || []);
      for (const plugin of offlinePlugins) {
        if (!plugin.isEnabled) continue;
        try {
          const entry = this.createPluginNode(plugin, this.currentBpm, renderCtx);
          if (!entry) continue;
          if (entry.node?.ready instanceof Promise) pendingPlugins.push(entry.node.ready);
          head.connect(entry.input);
          head = entry.output;
        } catch (e) {
          console.warn(`[Render] Plugin ignore (${plugin.type}) :`, e);
        }
      }
      head.connect(gain);
      gain.connect(panner);
      panner.connect(output);

      // Le solo ne concerne que les pistes sources : un bus ne doit pas etre coupe.
      const silenced = track.isMuted || soloSilenced.has(track.id);
      gain.gain.value = silenced ? 0 : track.volume;
      panner.pan.value = track.pan;

      const rt: RenderTrack = { input, gain, panner, output };

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

        const clipStartInProject = clip.start - startOffset;
        if (clipStartInProject + clip.duration < 0) continue;
        if (clipStartInProject > totalDuration) continue;

        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;

        const clipGain = offlineCtx.createGain();
        clipGain.gain.value = clip.gain ?? 1.0;

        source.connect(clipGain);
        clipGain.connect(rt.input);

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
      if (track.isFrozen && track.frozenClip) continue; // deja dans le rendu gele

      for (const clip of track.clips || []) {
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

  public async armTrack(trackId: string) {
    if (!this.ctx) await this.init();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    if (this.armingPromise) await this.armingPromise;
    this.armingPromise = this._armTrackInternal(trackId);
    await this.armingPromise;
    this.armingPromise = null;
  }

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
      return;
    }

    try {
      this.activeMonitorStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
      this.monitorSource = this.ctx!.createMediaStreamSource(this.activeMonitorStream);
      this.monitorSource.connect(dsp.input);
      console.log("[AudioEngine] Track armed OK:", trackId);
    } catch (e) {
      console.error("[AudioEngine] ARM ERROR:", e);
      this.monitoringTrackId = null;
      this.activeMonitorStream = null;
    }
  }

  public disarmTrack() {
    if (this.monitorSource) {
      this.monitorSource.disconnect();
      this.monitorSource = null;
    }
    if (this.activeMonitorStream) {
      this.activeMonitorStream.getTracks().forEach(track => track.stop());
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
            start: recordedAt,
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
      this.activeMonitorStream.getTracks().forEach(track => track.stop());
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
      this.activeMonitorStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
      this.monitorSource = this.ctx!.createMediaStreamSource(this.activeMonitorStream);
      this.monitorSource.connect(dsp.input);
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

    this.isPlaying = true;
    this.pendingLoopWrap = null;
    this.pausedAt = startOffset;
    this.nextScheduleTime = this.ctx.currentTime + 0.01; 
    this.playbackStartTime = this.ctx.currentTime - startOffset; 

    // Valeur correcte au demarrage : sans ca, une piste dont tous les points
    // d'automation sont anterieurs au point de depart gardait la valeur du
    // dernier rebuild du graphe au lieu de la valeur automatisee.
    tracks.forEach(track => this.applyAutomation(track, startOffset));

    this.schedulerTimer = window.setInterval(() => {
      this.scheduler(tracks);
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

  private scheduler(tracks: Track[]) {
    if (!this.ctx) return;
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
    if (track.isFrozen && track.frozenClip) return [track.frozenClip];
    return track.clips || [];
  }

  private scheduleClips(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number, maxLatency: number, latencies: Map<string, number>) {
      tracks.forEach(track => {
      if (track.isMuted) return; 
      const isFrozenRender = track.isFrozen && !!track.frozenClip;
      if (!isFrozenRender && track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS && track.type !== TrackType.SEND) return;

      this.getPlayableClips(track).forEach(clip => {
        const sourceKey = `${clip.id}`; 
        if (this.activeSources.has(sourceKey)) return;
        
        const clipEnd = clip.start + clip.duration;
        const overlapsWindow = clip.start < projectWindowEnd && clipEnd > projectWindowStart;
        if (overlapsWindow) {
           this.playClipSource(track.id, clip, contextScheduleTime, projectWindowStart);
        }
      });
    });
  }

  private scheduleMidi(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number) {
      tracks.forEach(track => {
        if (track.isMuted) return;
        if (track.type !== TrackType.MIDI && track.type !== TrackType.SAMPLER && track.type !== TrackType.DRUM_RACK) return;
        if (track.isFrozen && track.frozenClip) return; // deja rendu dans le clip gele

        track.clips.forEach(clip => {
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
                    
                    if (lane.parameterName === 'volume') {
                        dsp.gain.gain.setValueAtTime(point.value, scheduleTime);
                    } else if (lane.parameterName === 'pan') {
                        dsp.panner.pan.setValueAtTime(point.value, scheduleTime);
                    }
                    
                    const nextPoint = lane.points[index + 1];
                    if (nextPoint) {
                        // On programme la rampe meme si le point suivant sort de la
                        // fenetre : sinon la valeur restait en palier jusqu'a lui.
                        const nextScheduleTime = when + (nextPoint.time - start);
                        if (lane.parameterName === 'volume') {
                            dsp.gain.gain.linearRampToValueAtTime(nextPoint.value, nextScheduleTime);
                        } else if (lane.parameterName === 'pan') {
                            dsp.panner.pan.linearRampToValueAtTime(nextPoint.value, nextScheduleTime);
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
            const reversed = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                const original = buffer.getChannelData(ch);
                const reversedData = reversed.getChannelData(ch);
                for (let i = 0; i < original.length; i++) {
                    reversedData[i] = original[original.length - 1 - i];
                }
            }
            bufferToPlay = reversed;
        }
        
        source.buffer = bufferToPlay;
        
        const gainNode = this.ctx.createGain();
        const clipGain = clip.gain ?? 1.0;
        gainNode.gain.setValueAtTime(clipGain, scheduleTime);
        
        if (clip.fadeIn > 0) {
            gainNode.gain.setValueAtTime(0, scheduleTime);
            gainNode.gain.linearRampToValueAtTime(clipGain, scheduleTime + clip.fadeIn);
        }
        
        if (clip.fadeOut > 0) {
            const fadeOutStart = scheduleTime + clip.duration - clip.fadeOut;
            if (fadeOutStart > scheduleTime) {
                gainNode.gain.setValueAtTime(clipGain, fadeOutStart);
                gainNode.gain.linearRampToValueAtTime(0, scheduleTime + clip.duration);
            }
        }
        
        source.connect(gainNode);
        gainNode.connect(dsp.input);
        
        let offsetIntoClip = clip.offset || 0;
        if (projectTime > clip.start) {
            offsetIntoClip += (projectTime - clip.start);
        }
        
        let when = scheduleTime;
        if (projectTime < clip.start) {
            when = scheduleTime + (clip.start - projectTime);
        }
        
        const playedSoFar = Math.max(0, offsetIntoClip - (clip.offset || 0));
        const remainingDuration = clip.duration - playedSoFar;
        
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

  public updateTrack(track: Track, allTracks: Track[]) {
    if (!this.ctx) return;

    // Pre-cree les DSP de toutes les pistes: sinon une piste routee vers un bus
    // declare APRES elle dans le tableau retombait silencieusement sur le master.
    allTracks.forEach(t => this.ensureTrackDSP(t));
    this.soloSilencedIds = this.computeSoloSilencedIds(allTracks);

    const dsp = this.ensureTrackDSP(track);
    if (!dsp) return;
    
    if (track.type === TrackType.DRUM_RACK && dsp.drumRack && track.drumPads) {
      dsp.drumRack.updatePadsState(track.drumPads);
    }

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
    
    const currentPluginIds = new Set<string>();
    // Piste gelee : le rendu contient deja les effets, on court-circuite la chaine
    // (c'est precisement ce qui libere du CPU).
    const pluginsToApply = (track.isFrozen && track.frozenClip) ? [] : track.plugins;
    
    pluginsToApply.forEach(plugin => {
      currentPluginIds.add(plugin.id);
      let pEntry = dsp!.pluginChain.get(plugin.id);
      
      if (!pEntry) {
        const instance = this.createPluginNode(plugin, this.currentBpm);
        if (instance) {
          pEntry = { input: instance.input, output: instance.output, instance: instance.node };
          dsp!.pluginChain.set(plugin.id, pEntry);
        }
      } else if (pEntry.instance && pEntry.instance.updateParams) {
        pEntry.instance.updateParams(plugin.params);
      }
      
      if (pEntry) {
        if (plugin.isEnabled) {
            head.connect(pEntry.input);
            head = pEntry.output;
        }
      }
    });
    
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
    
    head.connect(dsp.gain);
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
        if (lane.parameterName === 'volume') dsp.gain.gain.setValueAtTime(value, now);
        else if (lane.parameterName === 'pan') dsp.panner.pan.setValueAtTime(value, now);
    });
}

  public getTrackPluginParameters(trackId: string): { pluginId: string, pluginName: string, params: PluginParameter[] }[] { return []; }
  public getMasterAnalyzer() { return this.masterAnalyzer; }
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
  public async enableVSTAudioStreaming(trackId: string, pluginId: string) {
    if (!this.ctx) await this.init();
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) {
        console.error(`[AudioEngine] VST Streaming: DSP for track ${trackId} not found.`);
        return;
    }
    
    const pluginEntry = dsp.pluginChain.get(pluginId);
    if (!pluginEntry) {
        console.error(`[AudioEngine] VST Streaming: Plugin ${pluginId} not found on track ${trackId}.`);
        return;
    }

    if (this.activeVSTPlugin && (this.activeVSTPlugin.trackId !== trackId || this.activeVSTPlugin.pluginId !== pluginId)) {
        this.disableVSTAudioStreaming();
    }
    
    try {
        const a = pluginEntry.input;
        const b = pluginEntry.output;
    } catch(e) { /* might not be connected if already disconnected */ }

    await novaBridge.initAudioStreaming(this.ctx!, pluginEntry.input, pluginEntry.output);
    this.activeVSTPlugin = { trackId, pluginId };
  }

  public disableVSTAudioStreaming() {
    if (!this.activeVSTPlugin) return;

    const { trackId, pluginId } = this.activeVSTPlugin;
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp || !dsp.pluginChain.has(pluginId)) {
        this.activeVSTPlugin = null;
        return;
    }
    const pluginEntry = dsp.pluginChain.get(pluginId)!;

    novaBridge.stopAudioStreaming();
    
    try {
        pluginEntry.input.disconnect(); // Disconnect from worklet
    } catch(e) {}
    
    pluginEntry.input.connect(pluginEntry.output);

    this.activeVSTPlugin = null;
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
      },
      onDevices: (devices, asioDevices) => {
        this.asioDevices = asioDevices;
        console.log('[AudioEngine] Périphériques ASIO détectés:', asioDevices.length);
      },
      onStreamStarted: (success, latency_ms) => {
        if (success) {
          this.asioStreamActive = true;
          this.latency = latency_ms || 0;
          console.log(`[AudioEngine] Stream ASIO démarré - Latence: ${latency_ms}ms`);
        }
      },
      onStreamStopped: () => {
        this.asioStreamActive = false;
        console.log('[AudioEngine] Stream ASIO arrêté');
      },
      onAudioInput: (audioData, channels) => {
        this.handleASIOInput(audioData, channels);
      },
      onStats: (stats) => {
        this.latency = stats.latency_ms;
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
        // Copier l'entrée vers la sortie pour le monitoring local
        for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
          e.outputBuffer.getChannelData(ch).set(e.inputBuffer.getChannelData(ch));
        }
      };
      
      // Connecter le master output au processeur ASIO
      if (this.masterOutput) {
        this.masterOutput.connect(this.asioOutputProcessor);
        this.asioOutputProcessor.connect(this.ctx.destination);
      }
    }
    
    this.asioBridge.startStream();
  }

  /**
   * Arrêter le streaming audio ASIO
   */
  public stopASIOStream(): void {
    if (this.asioBridge) {
      this.asioBridge.stopStream();
    }
    
    if (this.asioOutputProcessor) {
      try {
        this.asioOutputProcessor.disconnect();
      } catch (e) {}
      this.asioOutputProcessor = null;
    }
    
    this.asioStreamActive = false;
  }

  /**
   * Gérer l'audio entrant du bridge ASIO (entrée micro/instrument)
   */
  private handleASIOInput(audioData: Float32Array, channels: number): void {
    // L'audio d'entrée ASIO peut être routé vers les pistes armées
    // Pour l'instant, on log simplement la réception
    // Dans une version future, on créerait un MediaStream à partir des données
    if (this.monitoringTrackId) {
      // Route vers la piste armée
      // TODO: Implémenter le routing de l'audio ASIO vers les pistes
    }
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
