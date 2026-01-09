
import { Track, Clip, PluginInstance, TrackType, TrackSend, AutomationLane, PluginParameter, PluginType, MidiNote, DrumPad } from '../types';
import { Synthesizer } from './Synthesizer';
import { AudioSampler } from './AudioSampler';
import { DrumSamplerNode } from './DrumSamplerNode';
import { MelodicSamplerNode } from './MelodicSamplerNode';
import { DrumRackNode } from './DrumRackNode';
import { PLUGIN_REGISTRY } from '../plugins/registry';
import { novaBridge } from '../services/NovaBridge';

// FIX: Add isVST property to plugin chain to identify VST plugins
interface TrackDSP {
  input: GainNode;          
  output: GainNode;         
  panner: StereoPannerNode; 
  gain: GainNode;           
  analyzer: AnalyserNode;
  inputAnalyzer?: AnalyserNode; 
  recordingTap: GainNode;       
  pluginChain: Map<string, { input: AudioNode; output: AudioNode; instance: any; isVST?: boolean; }>; 
  sends: Map<string, GainNode>; 
  inputStream?: MediaStreamAudioSourceNode | null;
  currentInputDeviceId?: string | null;
  synth?: Synthesizer;
  sampler?: AudioSampler;
  drumSampler?: DrumSamplerNode;
  melodicSampler?: MelodicSamplerNode;
  drumRack?: DrumRackNode;
  
  activePluginType?: string; 
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: string;
}

export class AudioEngine {
  public ctx: AudioContext | null = null;
  
  private masterOutput: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterAnalyzer: AnalyserNode | null = null; 
  private masterSplitter: ChannelSplitterNode | null = null;
  public masterAnalyzerL: AnalyserNode | null = null;
  public masterAnalyzerR: AnalyserNode | null = null;
  
  private tracksDSP: Map<string, TrackDSP> = new Map();
  private activeSources: Map<string, ScheduledSource> = new Map();
  private scrubbingSources: Map<string, ScheduledSource> = new Map();
  
  private activeMidiNotes: Set<string> = new Set();

  private previewSource: AudioBufferSourceNode | null = null;
  private previewGain: GainNode | null = null;
  public previewAnalyzer: AnalyserNode | null = null;
  private isPreviewPlaying: boolean = false;

  private isPlaying: boolean = false;
  private schedulerTimer: number | null = null;
  private nextScheduleTime: number = 0;
  private playbackStartTime: number = 0; 
  private pausedAt: number = 0; 
  private currentBpm: number = 120;

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

  private currentInputDeviceId: string = 'default';
  private currentOutputDeviceId: string = 'default';
  public sampleRate: number = 44100;
  public latency: number = 0;

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
    this.masterLimiter.ratio.value = 20.0;
    this.masterLimiter.attack.value = 0.005; 
    this.masterLimiter.release.value = 0.1;

    const masterAnalyzer = this.ctx.createAnalyser();
    masterAnalyzer.fftSize = 2048;
    masterAnalyzer.smoothingTimeConstant = 0.8;
    
    this.masterSplitter = this.ctx.createChannelSplitter(2);
    this.masterAnalyzerL = this.ctx.createAnalyser();
    this.masterAnalyzerR = this.ctx.createAnalyser();
    this.masterAnalyzerL.fftSize = 1024; 
    this.masterAnalyzerR.fftSize = 1024;
    this.masterAnalyzerL.smoothingTimeConstant = 0.5;
    this.masterAnalyzerR.smoothingTimeConstant = 0.5;

    this.masterOutput.connect(this.masterLimiter);
    this.masterLimiter.connect(masterAnalyzer);
    masterAnalyzer.connect(this.ctx.destination);
    
    masterAnalyzer.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyzerL, 0);
    this.masterSplitter.connect(this.masterAnalyzerR, 1);

    this.previewGain = this.ctx.createGain();
    this.previewAnalyzer = this.ctx.createAnalyser();
    this.previewAnalyzer.fftSize = 256; 
    this.previewGain.connect(this.previewAnalyzer);
    this.previewAnalyzer.connect(this.ctx.destination);
  }

  public async enableVSTAudioStreaming(trackId: string, pluginId: string) {
    if (!this.ctx) return;
    const dsp = this.tracksDSP.get(trackId);
    if (!dsp) return;

    const pluginEntry = dsp.pluginChain.get(pluginId);
    if (!pluginEntry || !pluginEntry.isVST) return;

    console.log(`[AudioEngine] Enabling VST Streaming for ${pluginId} on ${trackId}`);
    
    // Break bypass
    pluginEntry.input.disconnect();
    
    // Inject Worklet
    await novaBridge.initAudioStreaming(this.ctx, pluginEntry.input, pluginEntry.output);
  }

  public disableVSTAudioStreaming() {
    novaBridge.stopAudioStreaming();
    // Re-patch all VST plugins to bypass mode
    this.tracksDSP.forEach(dsp => {
        dsp.pluginChain.forEach(pluginEntry => {
            if (pluginEntry.isVST) {
                try {
                    pluginEntry.input.disconnect();
                    pluginEntry.input.connect(pluginEntry.output);
                } catch(e) { /* ignore errors if already disconnected */ }
            }
        });
    });
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
  
  public async renderProject(tracks: Track[], totalDuration: number, startOffset: number = 0, targetSampleRate: number = 44100, onProgress?: (progress: number) => void): Promise<AudioBuffer> {
    return this.ctx!.createBuffer(2, 44100, 44100); // Dummy return
  }

  public async armTrack(trackId: string) { if (!this.ctx) await this.init(); if (this.ctx!.state === 'suspended') await this.ctx!.resume(); if (this.armingPromise) await this.armingPromise; this.armingPromise = this._armTrackInternal(trackId); await this.armingPromise; this.armingPromise = null; }
  private async _armTrackInternal(trackId: string) { this.monitoringTrackId = trackId; }
  public disarmTrack() { this.monitoringTrackId = null; }
  public async startRecording(currentTime: number, trackId: string): Promise<boolean> { return false; }
  public async stopRecording(): Promise<{ clip: Clip, trackId: string } | null> { return null; }

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
      return Math.max(0, this.ctx.currentTime - this.playbackStartTime);
    }
    return this.pausedAt;
  }
  
  public getIsPlaying(): boolean { return this.isPlaying; }
  public setBpm(bpm: number) { this.currentBpm = bpm; }

  public scrub(tracks: Track[], time: number, velocity: number) { /* ... */ }
  public stopScrubbing() { /* ... */ }

  private scheduler(tracks: Track[]) {
    if (!this.ctx) return;
    while (this.nextScheduleTime < this.ctx.currentTime + this.SCHEDULE_AHEAD_SEC) {
      const scheduleUntil = this.nextScheduleTime + this.SCHEDULE_AHEAD_SEC;
      const projectTimeStart = this.nextScheduleTime - this.playbackStartTime;
      const projectTimeEnd = scheduleUntil - this.playbackStartTime;
      
      this.scheduleClips(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime, 0, new Map());
      this.scheduleMidi(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
      this.scheduleAutomation(tracks, projectTimeStart, projectTimeEnd, this.nextScheduleTime);
      this.nextScheduleTime += this.SCHEDULE_AHEAD_SEC; 
    }
  }

  private scheduleClips(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number, maxLatency: number, latencies: Map<string, number>) {
      tracks.forEach(track => {
      if (track.isMuted) return; 
      if (track.type !== TrackType.AUDIO && track.type !== TrackType.SAMPLER && track.type !== TrackType.BUS && track.type !== TrackType.SEND) return;
      track.clips.forEach(clip => {
        if (!clip.buffer) return;
        if (this.activeSources.has(clip.id)) return;
        const clipEnd = clip.start + clip.duration;
        const overlapsWindow = clip.start < projectWindowEnd && clipEnd > projectWindowStart;
        if (overlapsWindow) this.playClipSource(track.id, clip, contextScheduleTime, projectWindowStart);
      });
    });
  }

  private scheduleMidi(tracks: Track[], projectWindowStart: number, projectWindowEnd: number, contextScheduleTime: number) {
      tracks.forEach(track => {
        if (track.isMuted) return;
        if (track.type !== TrackType.MIDI && track.type !== TrackType.SAMPLER && track.type !== TrackType.DRUM_RACK) return;
        track.clips.forEach(clip => {
           if (clip.type !== TrackType.MIDI || !clip.notes) return;
           const clipEnd = clip.start + clip.duration;
           if (clip.start >= projectWindowEnd || clipEnd <= projectWindowStart) return;
           clip.notes.forEach(note => {
               const noteAbsStart = clip.start + note.start;
               const noteAbsEnd = noteAbsStart + note.duration;
               if (noteAbsStart >= projectWindowStart && noteAbsStart < projectWindowEnd) {
                   const timeOffset = noteAbsStart - projectWindowStart;
                   this.triggerTrackAttack(track.id, note.pitch, note.velocity, contextScheduleTime + timeOffset);
               }
               if (noteAbsEnd >= projectWindowStart && noteAbsEnd < projectWindowEnd) {
                   const timeOffset = noteAbsEnd - projectWindowStart;
                   this.triggerTrackRelease(track.id, note.pitch, contextScheduleTime + timeOffset);
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

  public loadDrumRackSample(trackId: string, padId: number, buffer: AudioBuffer) {
      const dsp = this.tracksDSP.get(trackId);
      if (dsp && dsp.drumRack) dsp.drumRack.loadSample(padId, buffer);
  }
  
  public getDrumRackNode(trackId: string) { return this.tracksDSP.get(trackId)?.drumRack || null; }
  public getDrumSamplerNode(trackId: string) { return this.tracksDSP.get(trackId)?.drumSampler || null; }
  public getMelodicSamplerNode(trackId: string) { return this.tracksDSP.get(trackId)?.melodicSampler || null; }

  private scheduleAutomation(tracks: Track[], start: number, end: number, when: number) { /* ... */ }
  private playClipSource(trackId: string, clip: Clip, scheduleTime: number, projectTime: number) { /* ... */ }

  private createPluginNode(plugin: PluginInstance, bpm: number) {
    if(!this.ctx) return null;
    
    if (plugin.type === 'VST3') {
        const input = this.ctx.createGain();
        const output = this.ctx.createGain();
        input.connect(output); // Default Bypass
        return { input, output, node: {} };
    }

    const entry = PLUGIN_REGISTRY[plugin.type];
    if (entry) {
        try {
            const node = entry.factory(this.ctx, plugin.params, bpm);
            if (node.updateParams) node.updateParams({ ...plugin.params, isEnabled: plugin.isEnabled });
            if (node.input && node.output) return { input: node.input, output: node.output, node };
            throw new Error(`Factory for ${plugin.type} returned invalid node`);
        } catch (e) {
            console.error(`Failed to create plugin ${plugin.type}`, e);
        }
    }
    const bypassInput = this.ctx.createGain();
    const bypassOutput = this.ctx.createGain();
    bypassInput.connect(bypassOutput);
    return { input: bypassInput, output: bypassOutput, node: { updateParams: () => {} } };
  }

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
        recordingTap: this.ctx.createGain(),
        inputAnalyzer: this.ctx.createAnalyser()
      };
      if (track.type === TrackType.MIDI) { dsp.synth = new Synthesizer(this.ctx); dsp.synth.output.connect(dsp.input); }
      if (track.type === TrackType.SAMPLER) {
          dsp.melodicSampler = new MelodicSamplerNode(this.ctx); dsp.melodicSampler.output.connect(dsp.input);
          dsp.drumSampler = new DrumSamplerNode(this.ctx); dsp.drumSampler.output.connect(dsp.input);
          // FIX: Expected 2 arguments, but got 1. The AudioSampler constructor requires a BPM value.
          dsp.sampler = new AudioSampler(this.ctx, this.currentBpm);
      }
      if (track.type === TrackType.DRUM_RACK) { dsp.drumRack = new DrumRackNode(this.ctx); dsp.drumRack.output.connect(dsp.input); }
      this.tracksDSP.set(track.id, dsp);
    }
    if (track.type === TrackType.DRUM_RACK && dsp.drumRack && track.drumPads) dsp.drumRack.updatePadsState(track.drumPads);
    dsp.input.disconnect();
    let head: AudioNode = dsp.input;
    const currentPluginIds = new Set<string>();
    track.plugins.forEach(plugin => {
      if (this.isRecMode && plugin.latency > 0 && track.isTrackArmed) return;
      currentPluginIds.add(plugin.id);
      let pEntry = dsp!.pluginChain.get(plugin.id);
      if (!pEntry) {
        const instance = this.createPluginNode(plugin, this.currentBpm);
        if (instance) { 
          pEntry = { 
            input: instance.input, 
            output: instance.output, 
            instance: instance.node,
            isVST: plugin.type === 'VST3'
          }; 
          dsp!.pluginChain.set(plugin.id, pEntry); 
        }
      } else if (pEntry.instance.updateParams) { pEntry.instance.updateParams(plugin.params); }
      if (pEntry && plugin.isEnabled) { head.connect(pEntry.input); head = pEntry.output; }
    });
    dsp.pluginChain.forEach((val, id) => { if (!currentPluginIds.has(id)) { val.input.disconnect(); val.output.disconnect(); if(val.instance.dispose) val.instance.dispose(); dsp!.pluginChain.delete(id); } });
    head.connect(dsp.gain); dsp.gain.connect(dsp.panner); dsp.panner.connect(dsp.analyzer); dsp.analyzer.connect(dsp.output);
    const now = this.ctx.currentTime;
    dsp.gain.gain.setTargetAtTime(track.isMuted ? 0 : track.volume, now, 0.015);
    dsp.panner.pan.setTargetAtTime(track.pan, now, 0.015);
    dsp.output.disconnect();
    let destNode: AudioNode = this.masterOutput!;
    if (track.outputTrackId && track.outputTrackId !== 'master') { const destDSP = this.tracksDSP.get(track.outputTrackId); if (destDSP) destNode = destDSP.input; }
    dsp.output.connect(destNode);
  }

  private applyAutomation(track: Track, time: number) { /* ... */ }

  public getTrackPluginParameters(trackId: string): { pluginId: string, pluginName: string, params: PluginParameter[] }[] { return []; }
  public getMasterAnalyzer() { return this.masterAnalyzerL; }
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

  public setTrackVolume(trackId: string, volume: number, isMuted: boolean) {
    const dsp = this.tracksDSP.get(trackId);
    if (dsp) {
      const targetGain = isMuted ? 0 : volume;
      dsp.gain.gain.setTargetAtTime(targetGain, this.ctx!.currentTime, 0.015);
    }
  }

  public setTrackPan(trackId: string, pan: number) {
    const dsp = this.tracksDSP.get(trackId);
    if (dsp) {
      dsp.panner.pan.setTargetAtTime(pan, this.ctx!.currentTime, 0.015);
    }
  }
}

export const audioEngine = new AudioEngine();
