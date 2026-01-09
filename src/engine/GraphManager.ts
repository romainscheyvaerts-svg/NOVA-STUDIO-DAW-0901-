
import { Track, TrackType, PluginInstance } from '../types';
import { PLUGIN_REGISTRY } from '../plugins/registry';
import { Synthesizer } from './Synthesizer';
import { AudioSampler } from './AudioSampler';
import { DrumSamplerNode } from './DrumSamplerNode';
import { MelodicSamplerNode } from './MelodicSamplerNode';
import { DrumRackNode } from './DrumRackNode';
import { novaBridge } from '../services/NovaBridge';

export interface TrackDSP {
  input: GainNode;          
  output: GainNode;         
  panner: StereoPannerNode; 
  gain: GainNode;           
  analyzer: AnalyserNode;       
  inputAnalyzer?: AnalyserNode;  
  recordingTap: GainNode;       
  pluginChain: Map<string, { input: AudioNode; output: AudioNode; instance: any; isVST?: boolean }>; 
  sends: Map<string, GainNode>; 
  
  synth?: Synthesizer; 
  sampler?: AudioSampler; 
  drumRack?: DrumRackNode; 
  drumSampler?: DrumSamplerNode;
  melodicSampler?: MelodicSamplerNode;
  
  activePluginType?: string; 
}

export class GraphManager {
  private ctx: AudioContext;
  public tracksDSP: Map<string, TrackDSP> = new Map();
  
  public masterOutput: GainNode;
  public masterLimiter: DynamicsCompressorNode;
  public masterAnalyzerL: AnalyserNode;
  public masterAnalyzerR: AnalyserNode;
  private masterSplitter: ChannelSplitterNode;
  
  public previewGain: GainNode;
  public previewAnalyzer: AnalyserNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    
    // Master Chain Setup
    this.masterOutput = this.ctx.createGain();
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -0.5; 
    this.masterLimiter.ratio.value = 20.0;
    this.masterLimiter.attack.value = 0.005;

    const masterAnalyzer = this.ctx.createAnalyser();
    this.masterSplitter = this.ctx.createChannelSplitter(2);
    this.masterAnalyzerL = this.ctx.createAnalyser();
    this.masterAnalyzerR = this.ctx.createAnalyser();

    this.masterOutput.connect(this.masterLimiter);
    this.masterLimiter.connect(masterAnalyzer);
    masterAnalyzer.connect(this.ctx.destination);
    
    masterAnalyzer.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyzerL, 0);
    this.masterSplitter.connect(this.masterAnalyzerR, 1);

    // Preview Channel (Browser/Store)
    this.previewGain = this.ctx.createGain();
    this.previewAnalyzer = this.ctx.createAnalyser();
    this.previewAnalyzer.fftSize = 256; 
    this.previewGain.connect(this.previewAnalyzer);
    this.previewAnalyzer.connect(this.ctx.destination);
  }

  // --- VST STREAMING LOGIC ---
  public async toggleVSTStreaming(trackId: string, pluginId: string, enable: boolean) {
      const dsp = this.tracksDSP.get(trackId);
      if (!dsp) return;

      const pluginEntry = dsp.pluginChain.get(pluginId);
      if (!pluginEntry || !pluginEntry.isVST) return;

      if (enable) {
          console.log(`[Graph] Enabling VST Streaming for ${pluginId} on ${trackId}`);
          
          // Break bypass
          pluginEntry.input.disconnect();
          pluginEntry.output.disconnect();

          // Inject Worklet
          await novaBridge.initAudioStreaming(this.ctx, pluginEntry.input, pluginEntry.output);
      } else {
          novaBridge.stopAudioStreaming();
          // Restore bypass
          pluginEntry.input.connect(pluginEntry.output);
      }
  }

  public setTrackVolume(trackId: string, volume: number, isMuted: boolean) {
    const dsp = this.tracksDSP.get(trackId);
    if (dsp) {
      const targetGain = isMuted ? 0 : volume;
      dsp.gain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.015);
    }
  }

  public setTrackPan(trackId: string, pan: number) {
    const dsp = this.tracksDSP.get(trackId);
    if (dsp) {
      dsp.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.015);
    }
  }
  
  public setBpm(bpm: number) {
    this.tracksDSP.forEach(dsp => {
      dsp.pluginChain.forEach(p => {
        if (p.instance.updateParams) {
          p.instance.updateParams({ bpm });
        }
      });
    });
  }

  public updateTrackGraph(track: Track, currentBpm: number) {
    let dsp = this.tracksDSP.get(track.id);
    
    if (!dsp) {
      dsp = this.createTrackDSP(track);
      this.tracksDSP.set(track.id, dsp);
    }

    this.updateInstruments(track, dsp, currentBpm);
    this.rebuildPluginChain(track, dsp, currentBpm);
    this.updateRouting(track, dsp);

    this.setTrackVolume(track.id, track.volume, track.isMuted);
    this.setTrackPan(track.id, track.pan);
  }

  private createTrackDSP(track: Track): TrackDSP {
      const dsp: TrackDSP = {
        input: this.ctx.createGain(),
        output: this.ctx.createGain(),
        gain: this.ctx.createGain(),
        panner: this.ctx.createStereoPanner(),
        analyzer: this.ctx.createAnalyser(),
        inputAnalyzer: this.ctx.createAnalyser(),
        recordingTap: this.ctx.createGain(),
        pluginChain: new Map(),
        sends: new Map(),
        activePluginType: undefined
      };
      
      // Default PolySynth for MIDI tracks
      if (track.type === TrackType.MIDI) { 
          dsp.synth = new Synthesizer(this.ctx); 
          dsp.synth.output.connect(dsp.input); 
          dsp.activePluginType = 'SYNTH';
      }
      
      return dsp;
  }

  private updateInstruments(track: Track, dsp: TrackDSP, bpm: number) {
      // Check for specific instrument plugins
      const instrumentPlugin = track.plugins.find(p => ['MELODIC_SAMPLER', 'DRUM_SAMPLER', 'SAMPLER', 'DRUM_RACK_UI'].includes(p.type));
      
      if (instrumentPlugin) {
          dsp.activePluginType = instrumentPlugin.type;
          
          if (instrumentPlugin.type === 'DRUM_RACK_UI' && !dsp.drumRack) {
               dsp.drumRack = new DrumRackNode(this.ctx);
               dsp.drumRack.output.connect(dsp.input);
          }
          
          if (instrumentPlugin.type === 'MELODIC_SAMPLER' && !dsp.melodicSampler) {
               dsp.melodicSampler = new MelodicSamplerNode(this.ctx);
               dsp.melodicSampler.output.connect(dsp.input);
          }

          if (instrumentPlugin.type === 'DRUM_SAMPLER' && !dsp.drumSampler) {
               dsp.drumSampler = new DrumSamplerNode(this.ctx);
               dsp.drumSampler.output.connect(dsp.input);
          }

          // Update State
          if (track.type === TrackType.DRUM_RACK && dsp.drumRack && track.drumPads) {
              dsp.drumRack.updatePadsState(track.drumPads);
          }
          
          if (dsp.melodicSampler && instrumentPlugin.params) {
              dsp.melodicSampler.updateParams(instrumentPlugin.params);
          }
          
          if (dsp.drumSampler && instrumentPlugin.params) {
              dsp.drumSampler.updateParams(instrumentPlugin.params);
          }
      }
  }

  private rebuildPluginChain(track: Track, dsp: TrackDSP, currentBpm: number) {
    dsp.input.disconnect();
    
    let head: AudioNode = dsp.input;
    const currentPluginIds = new Set<string>();

    track.plugins.forEach(plugin => {
        if (!plugin.isEnabled) return;
        // Skip instruments (handled separately)
        if (['MELODIC_SAMPLER', 'DRUM_SAMPLER', 'SAMPLER', 'DRUM_RACK_UI'].includes(plugin.type)) return;

        currentPluginIds.add(plugin.id);
        let pEntry = dsp.pluginChain.get(plugin.id);

        if (!pEntry) {
            const instance = this.createPluginNode(plugin, currentBpm);
            if (instance) {
                pEntry = { 
                    input: instance.input, 
                    output: instance.output, 
                    instance: instance.node,
                    isVST: plugin.type === 'VST3' 
                };
                dsp.pluginChain.set(plugin.id, pEntry);
            }
        } else {
            if (pEntry.instance.updateParams) {
                pEntry.instance.updateParams(plugin.params);
            }
        }

        if (pEntry) {
            head.connect(pEntry.input);
            head = pEntry.output;
        }
    });
    
    // Cleanup removed plugins
    dsp.pluginChain.forEach((val, id) => {
        if (!currentPluginIds.has(id)) {
            val.input.disconnect();
            val.output.disconnect();
            if (val.instance.dispose) val.instance.dispose();
            dsp.pluginChain.delete(id);
        }
    });
    
    // Final Output Chain
    head.connect(dsp.gain); 
    dsp.gain.connect(dsp.panner); 
    dsp.panner.connect(dsp.analyzer); 
    dsp.analyzer.connect(dsp.output);
  }

  private updateRouting(track: Track, dsp: TrackDSP) {
    const now = this.ctx.currentTime;
    
    dsp.output.disconnect();
    let destNode: AudioNode = this.masterOutput;
    
    if (track.outputTrackId && track.outputTrackId !== 'master') {
        const destDSP = this.tracksDSP.get(track.outputTrackId);
        if (destDSP) destNode = destDSP.input;
    }
    dsp.output.connect(destNode);
    
    // Sends
    track.sends.forEach(send => {
       if (!send.isEnabled || send.level <= 0) {
           const existing = dsp.sends.get(send.id);
           if (existing) { existing.disconnect(); dsp.sends.delete(send.id); }
           return;
       }

       let sendNode = dsp.sends.get(send.id);
       if (!sendNode) {
           sendNode = this.ctx.createGain();
           dsp.sends.set(send.id, sendNode);
           dsp.output.connect(sendNode);
       }

       const destDSP = this.tracksDSP.get(send.id);
       if (destDSP) {
           sendNode.disconnect();
           sendNode.connect(destDSP.input);
           sendNode.gain.setTargetAtTime(send.level, now, 0.02);
       }
    });
  }

  private createPluginNode(plugin: PluginInstance, bpm: number) {
    const entry = PLUGIN_REGISTRY[plugin.type];
    if (entry) {
        try {
            if (plugin.type === 'VST3') {
                const input = this.ctx.createGain();
                const output = this.ctx.createGain();
                input.connect(output); // Default Bypass
                return { input, output, node: {} };
            }

            const node = entry.factory(this.ctx, plugin.params, bpm);
            if (node.updateParams) node.updateParams(plugin.params);
            
            if (node.input && node.output) {
                return { input: node.input, output: node.output, node };
            }
        } catch (e) {
            console.error(`Failed to create plugin ${plugin.type}`, e);
        }
    }
    return null;
  }
}
