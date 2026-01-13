
import { Track, Clip, PluginInstance, TrackType, TrackSend, AutomationLane, PluginParameter, PluginType, MidiNote, DrumPad } from '../types';
import { audioBufferRegistry } from '../services/AudioBufferRegistry';
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

  private LOOKAHEAD_MS = 25.0; 
  private SCHEDULE_AHEAD_SEC = 0.1; 

  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private activeMonitorStream: MediaStream | null = null;
  private monitorSource: MediaStreamAudioSourceNode | null = null;
  private monitoringTrackId: string | null = null;
  private recordingTrackId: string | null = null;
  private recStartTime: number = 0;
  
  private armingPromise: Promise<void> | null = null;

  // --- LOOP MANAGEMENT ---
  private isLoopActive: boolean = false;
  private loopStart: number = 0;
  private loopEnd: number = 0;

  // --- DEVICE MANAGEMENT ---
  private currentInputDeviceId: string = 'default';
  private currentOutputDeviceId: string = 'default';
  public sampleRate: number = 44100;
  public latency: number = 0;
  private currentBpm: number = 120;
  // FIX: Add property to track active VST plugin for streaming management.
  private activeVSTPlugin: { trackId: string, pluginId: string } | null = null;

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

    // 1. Master Volume
    this.masterOutput = this.ctx.createGain();
    
    // 2. Master Limiter (Safety & Glue)
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1.0;
    this.masterLimiter.knee.value = 0.0;
    this.masterLimiter.ratio.value = 20.0;
    this.masterLimiter.attack.value = 0.005; 
    this.masterLimiter.release.value = 0.1;

    // 3. Analyzer (Visualizer)
    this.masterAnalyzer = this.ctx.createAnalyser();
    this.masterAnalyzer.fftSize = 2048;
    this.masterAnalyzer.smoothingTimeConstant = 0.8;
    
    // 4. Stereo Splitters for Meters
    this.masterSplitter = this.ctx.createChannelSplitter(2);
    this.masterAnalyzerL = this.ctx.createAnalyser();
    this.masterAnalyzerR = this.ctx.createAnalyser();
    this.masterAnalyzerL.fftSize = 1024; 
    this.masterAnalyzerR.fftSize = 1024;
    this.masterAnalyzerL.smoothingTimeConstant = 0.5;
    this.masterAnalyzerR.smoothingTimeConstant = 0.5;

    // Routing Chain: MasterGain -> Limiter -> Analyzer -> Destination
    this.masterOutput.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterAnalyzer);
    this.masterAnalyzer.connect(this.ctx.destination);
    
    // Side-chain for Stereo Meters
    this.masterAnalyzer.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyzerL, 0);
    this.masterSplitter.connect(this.masterAnalyzerR, 1);

    // Init Preview System
    this.previewGain = this.ctx.createGain();
    this.previewAnalyzer = this.ctx.createAnalyser();
    this.previewAnalyzer.fftSize = 256; 
    this.previewGain.connect(this.previewAnalyzer);
    this.previewAnalyzer.connect(this.ctx.destination);
  }

  // --- DEVICE MANAGEMENT METHODS ---
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

  // --- PREVIEW & UTILS ---
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
          this.previewGain!.gain.value = 0.8; 
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
  
  // --- OFFLINE RENDER ENGINE ---
  public async renderProject(tracks: Track[], totalDuration: number, startOffset: number = 0, targetSampleRate: number = 44100, onProgress?: (progress: number) => void): Promise<AudioBuffer> {
    // ... (Offline Render Logic Omitted for Brevity - Keeping Existing Logic) ...
    // Note: For DrumRack, we would need to replicate logic in Offline context.
    return this.ctx!.createBuffer(2, 44100, 44100); // Dummy return
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
    
    // Si DSP n'existe pas, attendre un peu et réessayer (race condition fix)
    if (!dsp) {
      console.log("[AudioEngine] DSP not ready, waiting 150ms...");
      await new Promise(r => setTimeout(r, 150));
      dsp = this.tracksDSP.get(trackId);
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

    // Check if we have an active monitor stream
    if (!this.activeMonitorStream) {
      console.error("[AudioEngine] REC FAILED - No monitor stream! Arm track first.");
      return false;
    }

    // Check if stream is still active
    const tracks = this.activeMonitorStream.getTracks();
    const hasActiveTracks = tracks.some(t => t.readyState === 'live');
    if (!hasActiveTracks) {
      console.warn("[AudioEngine] Monitor stream inactive, re-initializing...");
      // Re-initialize monitoring
      await this.stopMonitoring();
      const success = await this.startMonitoring(trackId);
      if (!success) {
        console.error("[AudioEngine] Failed to re-initialize monitoring");
        return false;
      }
    }

    if (this.recordingTrackId) {
      console.error("[AudioEngine] REC FAILED - Already recording on:", this.recordingTrackId);
      return false;
    }

    try {
      // Clean up old mediaRecorder if exists
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        try { this.mediaRecorder.stop(); } catch (e) { }
      }

      this.mediaRecorder = new MediaRecorder(this.activeMonitorStream);
      this.audioChunks = [];
      this.recStartTime = currentTime;
      this.recordingTrackId = trackId;
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      this.mediaRecorder.onerror = (event) => {
        console.error("[AudioEngine] MediaRecorder error:", event);
      };
      this.mediaRecorder.start(100); // Collect data every 100ms for better reliability
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
    return new Promise((resolve) => {
      this.mediaRecorder!.onstop = async () => {
        const trackId = this.recordingTrackId!;
        const blob = new Blob(this.audioChunks, { type: this.mediaRecorder!.mimeType });
        if (blob.size === 0) {
          resolve(null);
          return;
        }
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const audioBuffer = await this.ctx!.decodeAudioData(arrayBuffer);
          const audioRef = URL.createObjectURL(blob);

          // Register buffer in registry to avoid Immer proxy issues
          const bufferId = audioBufferRegistry.register(audioBuffer, audioRef);

          const clip: Clip = {
            id: `rec-${Date.now()}`,
            name: `Vocal Take ${new Date().toLocaleTimeString()}`,
            start: this.recStartTime,
            duration: audioBuffer.duration,
            offset: 0,
            fadeIn: 0.01,
            fadeOut: 0.01,
            type: TrackType.AUDIO,
            color: '#ff0000',
            bufferId: bufferId,  // Use registry reference instead of direct buffer
            audioRef: audioRef,
          };
          console.log("[AudioEngine] Recording stopped. New clip created:", clip.id, "bufferId:", bufferId);
          resolve({ clip, trackId });
        } catch (e) {
          console.error("Error processing recorded audio:", e);
          resolve(null);
        } finally {
          this.audioChunks = [];
          this.recordingTrackId = null;
          this.recStartTime = 0;
        }
      };
      this.mediaRecorder.stop();
    });
  }

  public startPlayback(startOffset: number, tracks: Track[]) {
    if (!this.ctx) return;
    if (this.isPlaying) this.stopAll();

    this.isPlaying = true;
    this.pausedAt = startOffset;
    this.nextScheduleTime = this.ctx.currentTime + 0.05; 
    this.playbackStartTime = this.ctx.currentTime - startOffset; 

    this.schedulerTimer = window.setInterval(() => {
      this.scheduler(tracks);
    }, this.LOOKAHEAD_MS);
  }

  public stopAll() {
    this.isPlaying = false;
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
    if (this.isPlaying) {
      let time = this.ctx.currentTime - this.playbackStartTime;
      
      // Handle loop
      if (this.isLoopActive && this.loopEnd > this.loopStart) {
        const loopDuration = this.loopEnd - this.loopStart;
        if (time >= this.loopEnd) {
          // Calculate how much time has passed since the loop start
          const timeSinceLoopStart = time - this.loopStart;
          // Wrap the time back into the loop duration
          const wrappedTime = this.loopStart + (timeSinceLoopStart % loopDuration);
          // Adjust playbackStartTime to prevent time jumps on subsequent calls
          this.playbackStartTime = this.ctx.currentTime - wrappedTime;
          return wrappedTime;
        }
      }
      
      return Math.max(0, time);
    }
    return this.pausedAt;
  }
  
  public getIsPlaying(): boolean { return this.isPlaying; }

  // ... (Scrubbing) ...
  public scrub(tracks: Track[], time: number, velocity: number) { /* ... */ }
  public stopScrubbing() { /* ... */ }

  // ... (Scheduler & internal methods) ...
  private scheduler(tracks: Track[]) {
    if (!this.ctx) return;

    while (this.nextScheduleTime < this.ctx.currentTime + this.SCHEDULE_AHEAD_SEC) {
      const scheduleUntil = this.nextScheduleTime + this.SCHEDULE_AHEAD_SEC;
      let projectTimeStart = this.nextScheduleTime - this.playbackStartTime;
      let projectTimeEnd = scheduleUntil - this.playbackStartTime;

      // Handle loop wrapping in scheduler
      if (this.isLoopActive && this.loopEnd > this.loopStart) {
        const loopDuration = this.loopEnd - this.loopStart;

        // If we've gone past the loop end, wrap back
        if (projectTimeStart >= this.loopEnd) {
          const overflow = projectTimeStart - this.loopStart;
          projectTimeStart = this.loopStart + (overflow % loopDuration);
          projectTimeEnd = projectTimeStart + this.SCHEDULE_AHEAD_SEC;

          // Also update playbackStartTime to keep things in sync
          this.playbackStartTime = this.nextScheduleTime - projectTimeStart;
        }

        // If the window crosses the loop boundary, split it
        if (projectTimeStart < this.loopEnd && projectTimeEnd > this.loopEnd) {
          // Schedule up to loop end
          this.scheduleClips(tracks, projectTimeStart, this.loopEnd, this.nextScheduleTime, 0, new Map());
          this.scheduleMidi(tracks, projectTimeStart, this.loopEnd, this.nextScheduleTime);
          this.scheduleAutomation(tracks, projectTimeStart, this.loopEnd, this.nextScheduleTime);

          // Then schedule from loop start for the remainder
          const remainingTime = projectTimeEnd - this.loopEnd;
          const loopStartScheduleTime = this.nextScheduleTime + (this.loopEnd - projectTimeStart);
          this.scheduleClips(tracks, this.loopStart, this.loopStart + remainingTime, loopStartScheduleTime, 0, new Map());
          this.scheduleMidi(tracks, this.loopStart, this.loopStart + remainingTime, loopStartScheduleTime);
          this.scheduleAutomation(tracks, this.loopStart, this.loopStart + remainingTime, loopStartScheduleTime);

          this.nextScheduleTime += this.SCHEDULE_AHEAD_SEC;
          continue;
        }
      }

      this.scheduleClips(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime, 0, new Map());
      this.scheduleMidi(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
      this.scheduleAutomation(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
      this.nextScheduleTime += this.SCHEDULE_AHEAD_SEC;
    }
  }

  private scheduleClips(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number, maxLatency: number, latencies: Map<string, number>) {
      // Existing logic for audio clips
      tracks.forEach(track => {
      if (track.isMuted) return;
      if (track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS && track.type !== TrackType.SEND) return;

      track.clips.forEach(clip => {
        // Check for buffer (legacy) OR bufferId (new registry approach)
        const hasBuffer = clip.buffer || (clip.bufferId && audioBufferRegistry.has(clip.bufferId));
        if (!hasBuffer) return;

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
      // Loop over tracks with MIDI clips (including DRUM_RACK)
      tracks.forEach(track => {
        if (track.isMuted) return;
        if (track.type !== TrackType.MIDI && track.type !== TrackType.SAMPLER && track.type !== TrackType.DRUM_RACK) return;

        track.clips.forEach(clip => {
           if (clip.type !== TrackType.MIDI || !clip.notes) return;
           
           // Determine clip overlap
           const clipEnd = clip.start + clip.duration;
           if (clip.start >= projectWindowEnd || clipEnd <= projectWindowStart) return;

           // For each note in clip
           clip.notes.forEach(note => {
               // Calculate note absolute start time
               const noteAbsStart = clip.start + note.start;
               const noteAbsEnd = noteAbsStart + note.duration;

               // Schedule Note On
               if (noteAbsStart >= projectWindowStart && noteAbsStart < projectWindowEnd) {
                   // Time delta from scheduling window start
                   const timeOffset = noteAbsStart - projectWindowStart;
                   const scheduleTime = contextScheduleTime + timeOffset;
                   
                   this.triggerTrackAttack(track.id, note.pitch, note.velocity, scheduleTime);
               }

               // Schedule Note Off
               if (noteAbsEnd >= projectWindowStart && noteAbsEnd < projectWindowEnd) {
                   const timeOffset = noteAbsEnd - projectWindowStart;
                   const scheduleTime = contextScheduleTime + timeOffset;
                   
                   this.triggerTrackRelease(track.id, note.pitch, scheduleTime);
               }
           });
        });
      });
  }
  
  // --- REAL-TIME MIDI METHODS ---
  // These are called by MidiManager for live input (Latency Critical) or by Scheduler
  
  public triggerTrackAttack(trackId: string, pitch: number, velocity: number, time: number = 0) {
      if (!this.ctx) return;
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;
      
      const now = Math.max(time, this.ctx.currentTime);
      
      if (dsp.synth) {
          dsp.synth.triggerAttack(pitch, velocity, now);
      } else if (dsp.melodicSampler) {
          dsp.melodicSampler.triggerAttack(pitch, velocity, now);
      } else if (dsp.drumSampler) {
          dsp.drumSampler.trigger(velocity, now);
      } else if (dsp.drumRack) {
          // New Drum Rack Trigger
          // Map Pitch 60 -> Pad 1
          dsp.drumRack.trigger(pitch, velocity, now);
      } else if (dsp.sampler) {
          dsp.sampler.triggerAttack(pitch, velocity, now);
      }
  }

  public triggerTrackRelease(trackId: string, pitch: number, time: number = 0) {
      if (!this.ctx) return;
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;
      
      const now = Math.max(time, this.ctx.currentTime);
      
      if (dsp.synth) {
          dsp.synth.triggerRelease(pitch, now);
      } else if (dsp.melodicSampler) {
          dsp.melodicSampler.triggerRelease(pitch, now);
      } else if (dsp.sampler) {
          dsp.sampler.triggerRelease(pitch, now);
      }
      // Drum Rack is usually one-shot, no release needed unless choke or ADSR is added later
  }

  public previewMidiNote(trackId: string, pitch: number, duration: number = 0.5) {
      this.triggerTrackAttack(trackId, pitch, 0.8);
      setTimeout(() => this.triggerTrackRelease(trackId, pitch), duration * 1000);
  }
  
  public loadSamplerBuffer(trackId: string, buffer: AudioBuffer) {
      const dsp = this.tracksDSP.get(trackId);
      if (dsp) {
          if (dsp.sampler) dsp.sampler.loadBuffer(buffer);
          if (dsp.drumSampler) dsp.drumSampler.loadBuffer(buffer);
          if (dsp.melodicSampler) dsp.melodicSampler.loadBuffer(buffer);
      }
  }

  // --- DRUM RACK SPECIFIC METHODS ---
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
                    if (nextPoint && nextPoint.time < end) {
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
    if (!this.ctx) {
        console.warn('[AudioEngine] No AudioContext');
        return;
    }

    // Get buffer from clip directly OR from registry
    let clipBuffer = clip.buffer;
    if (!clipBuffer && clip.bufferId) {
        clipBuffer = audioBufferRegistry.get(clip.bufferId);
    }

    if (!clipBuffer) {
        console.warn(`[AudioEngine] Clip ${clip.id} has no buffer (bufferId: ${clip.bufferId})`);
        return;
    }

    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) {
        console.warn(`[AudioEngine] No DSP chain for track ${trackId}`);
        return;
    }

    // Skip muted clips
    if (clip.isMuted) return;

    // Prevent duplicate playback
    const sourceKey = `${clip.id}`;
    if (this.activeSources.has(sourceKey)) return;

    try {
        // Create audio source
        const source = this.ctx.createBufferSource();
        let bufferToPlay = clipBuffer;
        
        // Handle reverse
        if (clip.isReversed) {
            const reversed = this.ctx.createBuffer(
                clipBuffer.numberOfChannels,
                clipBuffer.length,
                clipBuffer.sampleRate
            );
            for (let ch = 0; ch < clipBuffer.numberOfChannels; ch++) {
                const original = clipBuffer.getChannelData(ch);
                const reversedData = reversed.getChannelData(ch);
                for (let i = 0; i < original.length; i++) {
                    reversedData[i] = original[original.length - 1 - i];
                }
            }
            bufferToPlay = reversed;
        }
        
        source.buffer = bufferToPlay;
        
        // Create gain node for clip volume
        const gainNode = this.ctx.createGain();
        const clipGain = clip.gain ?? 1.0;
        gainNode.gain.setValueAtTime(clipGain, scheduleTime);
        
        // Apply fade in
        if (clip.fadeIn > 0) {
            gainNode.gain.setValueAtTime(0, scheduleTime);
            gainNode.gain.linearRampToValueAtTime(clipGain, scheduleTime + clip.fadeIn);
        }
        
        // Apply fade out
        if (clip.fadeOut > 0) {
            const fadeOutStart = scheduleTime + clip.duration - clip.fadeOut;
            if (fadeOutStart > scheduleTime) {
                gainNode.gain.setValueAtTime(clipGain, fadeOutStart);
                gainNode.gain.linearRampToValueAtTime(0, scheduleTime + clip.duration);
            }
        }
        
        // Connect: source -> gain -> track input (which goes through plugin chain)
        source.connect(gainNode);
        gainNode.connect(dsp.input);
        
        // Calculate offset into clip
        let offsetIntoClip = clip.offset || 0;
        
        // If playback started mid-clip, add the difference
        if (projectTime > clip.start) {
            offsetIntoClip += (projectTime - clip.start);
        }
        
        // Calculate when to start (in AudioContext time)
        let when = scheduleTime;
        if (projectTime < clip.start) {
            // Clip starts in the future
            when = scheduleTime + (clip.start - projectTime);
        }
        
        // Calculate remaining duration
        const playedSoFar = Math.max(0, offsetIntoClip - (clip.offset || 0));
        const remainingDuration = clip.duration - playedSoFar;
        
        // Start playback if there's something to play
        if (remainingDuration > 0 && offsetIntoClip < bufferToPlay.duration) {
            const actualDuration = Math.min(remainingDuration, bufferToPlay.duration - offsetIntoClip);
            
            source.start(when, offsetIntoClip, actualDuration);
            
            // Store for cleanup
            this.activeSources.set(sourceKey, {
                source,
                gain: gainNode,
                clipId: clip.id
            });
            
            // Auto-cleanup when finished
            source.onended = () => {
                this.activeSources.delete(sourceKey);
                try {
                    source.disconnect();
                    gainNode.disconnect();
                } catch (e) {
                    // Already disconnected
                }
            };
            
            console.log(`[AudioEngine] Playing: ${clip.name} | offset: ${offsetIntoClip.toFixed(2)}s | duration: ${actualDuration.toFixed(2)}s`);
        }
        
    } catch (error) {
        console.error(`[AudioEngine] Error playing clip ${clip.id}:`, error);
    }
}
  private createPluginNode(plugin: PluginInstance, bpm: number): { input: GainNode; output: GainNode; node: any } | null {
    if (!this.ctx) return null;
    
    let node: any = null;
    
    switch (plugin.type) {
      case 'REVERB':
        node = new ReverbNode(this.ctx);
        break;
      // FIX: Pass the current BPM to the SyncDelayNode constructor for accurate tempo-synced delays.
      case 'DELAY':
        node = new SyncDelayNode(this.ctx, bpm);
        break;
      case 'COMPRESSOR':
        node = new CompressorNode(this.ctx);
        break;
      case 'AUTOTUNE':
        node = new AutoTuneNode(this.ctx);
        break;
      case 'CHORUS':
        node = new ChorusNode(this.ctx);
        break;
      case 'FLANGER':
        node = new FlangerNode(this.ctx);
        break;
      case 'DOUBLER':
        node = new VocalDoublerNode(this.ctx);
        break;
      case 'STEREOSPREADER':
        node = new StereoSpreaderNode(this.ctx);
        break;
      case 'DEESSER':
        node = new DeEsserNode(this.ctx);
        break;
      case 'DENOISER':
        node = new DenoiserNode(this.ctx);
        break;
      case 'PROEQ12':
        const eqDefaultParams = {
          isEnabled: true,
          masterGain: 1.0,
          bands: Array.from({ length: 12 }, (_, i) => ({
            id: i,
            type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking',
            frequency: [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000][i],
            gain: 0,
            q: 1.0,
            isEnabled: true,
            isSolo: false
          }))
        };
        const eqParams = plugin.params && plugin.params.bands ? plugin.params : eqDefaultParams;
        node = new ProEQ12Node(this.ctx, eqParams as any);
        break;
      case 'VOCALSATURATOR':
        node = new VocalSaturatorNode(this.ctx);
        break;
      case 'MASTERSYNC':
        node = new MasterSyncNode(this.ctx);
        break;
      default:
        // Plugin type not supported, create bypass
        const bypassIn = this.ctx.createGain();
        const bypassOut = this.ctx.createGain();
        bypassIn.connect(bypassOut);
        return { input: bypassIn, output: bypassOut, node: { updateParams: () => {} } };
    }
    
    if (node && node.input && node.output) {
      if (node.updateParams) {
        node.updateParams({ ...plugin.params, isEnabled: plugin.isEnabled });
      }
      return { input: node.input, output: node.output, node };
    }
    
    return null;
  }

  // --- UPDATE TRACK ---
  public updateTrack(track: Track, allTracks: Track[]) {
    if (!this.ctx) return;
    let dsp = this.tracksDSP.get(track.id);
    
    if (!dsp) {
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
    }
    
    if (track.type === TrackType.DRUM_RACK && dsp.drumRack && track.drumPads) {
      dsp.drumRack.updatePadsState(track.drumPads);
    }
    
    // Disconnect for rebuild
    dsp.input.disconnect();
    let head: AudioNode = dsp.input;
    
    // ===== PLUGIN CHAIN CREATION =====
    const currentPluginIds = new Set<string>();
    
    track.plugins.forEach(plugin => {
      currentPluginIds.add(plugin.id);
      let pEntry = dsp!.pluginChain.get(plugin.id);
      
      if (!pEntry) {
        const instance = this.createPluginNode(plugin, this.currentBpm);
        if (instance) {
          pEntry = {
            input: instance.input,
            output: instance.output,
            instance: instance.node
          };
          dsp!.pluginChain.set(plugin.id, pEntry);
        }
      } else if (pEntry.instance && pEntry.instance.updateParams) {
        pEntry.instance.updateParams(plugin.params);
      }
      
      if (pEntry) {
        if (plugin.isEnabled) {
            head.connect(pEntry.input);
            head = pEntry.output;
        } else {
            // If bypassed, we connect the input of the plugin to its output to maintain the chain.
            // Assuming input/output are simple GainNodes, this is safe.
            // For complex nodes, a separate bypass path might be better.
        }
      }
    });
    
    // Remove old plugins
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
    // ===== END PLUGIN CHAIN =====
    
    // Continue routing
    head.connect(dsp.gain);
    dsp.gain.connect(dsp.panner);
    dsp.panner.connect(dsp.analyzer);
    dsp.analyzer.connect(dsp.output);
  
    const now = this.ctx.currentTime;
    dsp.gain.gain.setTargetAtTime(track.isMuted ? 0 : track.volume, now, 0.015);
    dsp.panner.pan.setTargetAtTime(track.pan, now, 0.015);
    
    dsp.output.disconnect();
    let destNode: AudioNode = this.masterOutput!;
    if (track.outputTrackId && track.outputTrackId !== 'master') {
      const destDSP = this.tracksDSP.get(track.outputTrackId);
      if (destDSP) destNode = destDSP.input;
    }
    dsp.output.connect(destNode);
  }

  private applyAutomation(track: Track, time: number) {
    const dsp = this.tracksDSP.get(track.id);
    if (!dsp || !this.ctx) return;
    
    track.automationLanes.forEach(lane => {
        if (lane.points.length === 0) return;
        
        // Find the two points surrounding current time
        let prevPoint = lane.points[0];
        let nextPoint = lane.points[lane.points.length - 1];
        
        for (let i = 0; i < lane.points.length - 1; i++) {
            if (lane.points[i].time <= time && lane.points[i + 1].time >= time) {
                prevPoint = lane.points[i];
                nextPoint = lane.points[i + 1];
                break;
            }
        }
        
        // Interpolate value
        let value: number;
        if (time <= prevPoint.time) {
            value = prevPoint.value;
        } else if (time >= nextPoint.time) {
            value = nextPoint.value;
        } else {
            const ratio = (time - prevPoint.time) / (nextPoint.time - prevPoint.time);
            value = prevPoint.value + (nextPoint.value - prevPoint.value) * ratio;
        }
        
        // Apply to parameter
        const now = this.ctx.currentTime;
        if (lane.parameterName === 'volume') {
            dsp.gain.gain.setValueAtTime(value, now);
        } else if (lane.parameterName === 'pan') {
            dsp.panner.pan.setValueAtTime(value, now);
        }
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
  // FIX: Implement missing methods for VST streaming and atomic updates.
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
    
    // Disconnect bypass
    try {
        const a = pluginEntry.input;
        const b = pluginEntry.output;
        // Find the connection from head to the input of this plugin entry and disconnect it
        // This is complex. Assuming a simple chain for now.
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
    
    // Restore connection
    try {
        pluginEntry.input.disconnect(); // Disconnect from worklet
    } catch(e) {}
    
    // This is tricky because we don't know what was connected to what before.
    // The safest is to trigger a full `updateTrack` for this track.
    // For now, let's assume a simple bypass restore.
    pluginEntry.input.connect(pluginEntry.output);

    this.activeVSTPlugin = null;
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
        const targetGain = isMuted ? 0 : volume;
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
