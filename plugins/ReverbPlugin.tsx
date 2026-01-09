import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PluginParameter } from '../types';

export type ReverbMode = 'ROOM' | 'HALL' | 'PLATE' | 'CATHEDRAL' | 'SHIMMER';

export interface ReverbParams {
  decay: number;        // 0.1 to 15 seconds
  preDelay: number;     // 0 to 200ms (stored in seconds)
  size: number;         // 0 to 1 (room size/diffusion)
  damping: number;      // 100 to 20000 Hz (HF damping)
  mix: number;          // 0 to 1 (dry/wet)
  lowCut: number;       // 20 to 1000 Hz (HP on wet signal)
  highCut: number;      // 1000 to 20000 Hz (LP on wet signal)
  width: number;        // 0 to 2 (0=mono, 1=stereo, 2=wide)
  modRate: number;      // 0 to 5 Hz (modulation speed)
  modDepth: number;     // 0 to 1 (modulation amount)
  erLevel: number;      // 0 to 1 (early reflections level)
  freeze: boolean;      // Infinite sustain mode
  ducking: number;      // 0 to 1 (sidechain duck amount)
  mode: ReverbMode;
  isEnabled: boolean;
  name?: string;
}

export const REVERB_PRESETS: Array<Partial<ReverbParams> & { name: string }> = [
  { 
    name: "Vocal Plate", 
    decay: 1.8, preDelay: 0.025, damping: 8000, size: 0.6, mix: 0.22,
    lowCut: 200, highCut: 8000, width: 1.0, modRate: 0.5, modDepth: 0.1,
    erLevel: 0.3, ducking: 0.2, mode: 'PLATE'
  },
  { 
    name: "Tight Room", 
    decay: 0.5, preDelay: 0.008, damping: 5000, size: 0.25, mix: 0.18,
    lowCut: 150, highCut: 10000, width: 0.8, modRate: 0, modDepth: 0,
    erLevel: 0.6, ducking: 0, mode: 'ROOM'
  },
  { 
    name: "Large Hall", 
    decay: 3.5, preDelay: 0.045, damping: 6000, size: 0.85, mix: 0.28,
    lowCut: 100, highCut: 12000, width: 1.2, modRate: 0.3, modDepth: 0.15,
    erLevel: 0.4, ducking: 0.15, mode: 'HALL'
  },
  { 
    name: "Cathedral", 
    decay: 6.0, preDelay: 0.080, damping: 4000, size: 1.0, mix: 0.35,
    lowCut: 80, highCut: 8000, width: 1.5, modRate: 0.2, modDepth: 0.2,
    erLevel: 0.25, ducking: 0.25, mode: 'CATHEDRAL'
  },
  { 
    name: "Shimmer Pad", 
    decay: 8.0, preDelay: 0.060, damping: 10000, size: 0.9, mix: 0.45,
    lowCut: 300, highCut: 15000, width: 1.8, modRate: 2.0, modDepth: 0.4,
    erLevel: 0.15, ducking: 0.3, mode: 'SHIMMER'
  },
  { 
    name: "Drums Room", 
    decay: 0.8, preDelay: 0.012, damping: 7000, size: 0.4, mix: 0.2,
    lowCut: 100, highCut: 9000, width: 1.1, modRate: 0, modDepth: 0,
    erLevel: 0.5, ducking: 0.1, mode: 'ROOM'
  },
  { 
    name: "Ambient Wash", 
    decay: 10.0, preDelay: 0.100, damping: 5000, size: 1.0, mix: 0.5,
    lowCut: 200, highCut: 6000, width: 2.0, modRate: 1.5, modDepth: 0.35,
    erLevel: 0.1, ducking: 0.4, mode: 'CATHEDRAL'
  },
  { 
    name: "Snare Plate", 
    decay: 1.2, preDelay: 0.015, damping: 9000, size: 0.5, mix: 0.25,
    lowCut: 250, highCut: 12000, width: 1.0, modRate: 0.8, modDepth: 0.05,
    erLevel: 0.35, ducking: 0, mode: 'PLATE'
  }
];

export class ReverbNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  // Pre-delay
  private preDelayNode: DelayNode;
  
  // Convolver
  private convolver: ConvolverNode;
  
  // EQ on wet signal
  private lowCutFilter: BiquadFilterNode;
  private highCutFilter: BiquadFilterNode;
  private dampingFilter: BiquadFilterNode;
  
  // Input filter
  private inputFilter: BiquadFilterNode;
  
  // Stereo width processing
  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  private midGain: GainNode;
  private sideGain: GainNode;
  
  // Modulation
  private modLFO: OscillatorNode;
  private modGain: GainNode;
  private modDelay: DelayNode;
  
  // Mix
  private wetGain: GainNode;
  private dryGain: GainNode;
  
  // Ducking (sidechain compression simulation)
  private duckingGain: GainNode;
  private duckingAnalyzer: AnalyserNode;
  private duckingData: Float32Array;
  private duckingInterval: number | null = null;
  
  // Metering
  public inputAnalyzer: AnalyserNode;
  public outputAnalyzer: AnalyserNode;
  private inputData: Float32Array;
  private outputData: Float32Array;
  
  // Early reflections (simple tapped delay)
  private erDelays: DelayNode[];
  private erGains: GainNode[];
  private erMix: GainNode;
  
  // Freeze buffer
  private freezeBuffer: AudioBuffer | null = null;
  private isFrozen: boolean = false;
  
  private params: ReverbParams = {
    decay: 2.5,
    preDelay: 0.025,
    size: 0.7,
    damping: 10000,
    mix: 0.3,
    lowCut: 100,
    highCut: 12000,
    width: 1.0,
    modRate: 0.5,
    modDepth: 0.1,
    erLevel: 0.3,
    freeze: false,
    ducking: 0,
    mode: 'HALL',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    
    // I/O
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Metering
    this.inputAnalyzer = ctx.createAnalyser();
    this.inputAnalyzer.fftSize = 256;
    this.inputData = new Float32Array(this.inputAnalyzer.frequencyBinCount);
    
    this.outputAnalyzer = ctx.createAnalyser();
    this.outputAnalyzer.fftSize = 256;
    this.outputData = new Float32Array(this.outputAnalyzer.frequencyBinCount);
    
    // Ducking analyzer
    this.duckingAnalyzer = ctx.createAnalyser();
    this.duckingAnalyzer.fftSize = 256;
    this.duckingData = new Float32Array(this.duckingAnalyzer.frequencyBinCount);
    this.duckingGain = ctx.createGain();
    
    // Pre-delay
    this.preDelayNode = ctx.createDelay(1.0);
    
    // Convolver
    this.convolver = ctx.createConvolver();
    
    // EQ filters
    this.inputFilter = ctx.createBiquadFilter();
    this.inputFilter.type = 'highpass';
    this.inputFilter.frequency.value = 80;
    
    this.lowCutFilter = ctx.createBiquadFilter();
    this.lowCutFilter.type = 'highpass';
    this.lowCutFilter.frequency.value = 100;
    this.lowCutFilter.Q.value = 0.707;
    
    this.highCutFilter = ctx.createBiquadFilter();
    this.highCutFilter.type = 'lowpass';
    this.highCutFilter.frequency.value = 12000;
    this.highCutFilter.Q.value = 0.707;
    
    this.dampingFilter = ctx.createBiquadFilter();
    this.dampingFilter.type = 'lowpass';
    this.dampingFilter.frequency.value = 10000;
    
    // Stereo width (mid-side processing)
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.midGain = ctx.createGain();
    this.sideGain = ctx.createGain();
    
    // Modulation LFO
    this.modLFO = ctx.createOscillator();
    this.modLFO.type = 'sine';
    this.modLFO.frequency.value = 0.5;
    this.modGain = ctx.createGain();
    this.modGain.gain.value = 0.002; // Small pitch modulation
    this.modDelay = ctx.createDelay(0.05);
    this.modDelay.delayTime.value = 0.01;
    
    this.modLFO.connect(this.modGain);
    this.modGain.connect(this.modDelay.delayTime);
    this.modLFO.start();
    
    // Early reflections (4 taps)
    this.erDelays = [];
    this.erGains = [];
    this.erMix = ctx.createGain();
    
    const erTimes = [0.012, 0.019, 0.027, 0.038];
    const erAmps = [0.8, 0.6, 0.5, 0.4];
    
    for (let i = 0; i < 4; i++) {
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = erTimes[i];
      const gain = ctx.createGain();
      gain.gain.value = erAmps[i];
      this.erDelays.push(delay);
      this.erGains.push(gain);
    }
    
    // Mix
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    
    this.setupChain();
    this.updateImpulseResponse();
    this.startDuckingProcess();
  }

  private setupChain() {
    // Input metering
    this.input.connect(this.inputAnalyzer);
    
    // Ducking analyzer
    this.input.connect(this.duckingAnalyzer);
    
    // Dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    
    // Wet path
    this.input.connect(this.inputFilter);
    
    // Early reflections
    for (let i = 0; i < this.erDelays.length; i++) {
      this.inputFilter.connect(this.erDelays[i]);
      this.erDelays[i].connect(this.erGains[i]);
      this.erGains[i].connect(this.erMix);
    }
    
    // Late reflections (convolver path)
    this.inputFilter.connect(this.preDelayNode);
    this.preDelayNode.connect(this.modDelay);
    this.modDelay.connect(this.convolver);
    this.convolver.connect(this.dampingFilter);
    
    // EQ on reverb tail
    this.dampingFilter.connect(this.lowCutFilter);
    this.lowCutFilter.connect(this.highCutFilter);
    
    // Stereo width processing
    this.highCutFilter.connect(this.splitter);
    this.erMix.connect(this.splitter);
    
    // Mid = (L + R) / 2, Side = (L - R) / 2
    // For simplicity, we'll adjust the balance
    this.splitter.connect(this.midGain, 0);
    this.splitter.connect(this.midGain, 1);
    this.splitter.connect(this.sideGain, 0);
    this.splitter.connect(this.sideGain, 1);
    
    this.midGain.connect(this.merger, 0, 0);
    this.midGain.connect(this.merger, 0, 1);
    this.sideGain.connect(this.merger, 0, 0);
    this.sideGain.connect(this.merger, 0, 1);
    
    // Through ducking to wet gain
    this.merger.connect(this.duckingGain);
    this.duckingGain.connect(this.wetGain);
    this.wetGain.connect(this.output);
    
    // Output metering
    this.output.connect(this.outputAnalyzer);
    
    this.updateRouting();
  }

  private startDuckingProcess() {
    this.duckingInterval = window.setInterval(() => {
      if (this.params.ducking > 0) {
        this.duckingAnalyzer.getFloatTimeDomainData(this.duckingData);
        let max = 0;
        for (let i = 0; i < this.duckingData.length; i++) {
          const abs = Math.abs(this.duckingData[i]);
          if (abs > max) max = abs;
        }
        // Duck reverb when input is loud
        const duckAmount = Math.min(1, max * 3) * this.params.ducking;
        const targetGain = 1 - duckAmount;
        this.duckingGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.02);
      } else {
        this.duckingGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      }
    }, 1000 / 60);
  }

  private updateRouting() {
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    
    if (this.params.isEnabled) {
      const mix = safe(this.params.mix, 0.3);
      this.dryGain.gain.setTargetAtTime(1 - (mix * 0.5), now, 0.02);
      this.wetGain.gain.setTargetAtTime(mix, now, 0.02);
      this.erMix.gain.setTargetAtTime(safe(this.params.erLevel, 0.3), now, 0.02);
      
      // Width: 0 = mono, 1 = stereo, 2 = wide
      const width = safe(this.params.width, 1);
      this.midGain.gain.setTargetAtTime(2 - width, now, 0.02);
      this.sideGain.gain.setTargetAtTime(width, now, 0.02);
      
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public updateParams(p: Partial<ReverbParams>) {
    const oldDecay = this.params.decay;
    const oldSize = this.params.size;
    const oldMode = this.params.mode;
    const wasFreeze = this.params.freeze;
    
    this.params = { ...this.params, ...p };
    
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;

    // Pre-delay
    this.preDelayNode.delayTime.setTargetAtTime(safe(this.params.preDelay, 0.025), now, 0.02);
    
    // Damping
    this.dampingFilter.frequency.setTargetAtTime(safe(this.params.damping, 10000), now, 0.02);
    
    // EQ
    this.lowCutFilter.frequency.setTargetAtTime(safe(this.params.lowCut, 100), now, 0.02);
    this.highCutFilter.frequency.setTargetAtTime(safe(this.params.highCut, 12000), now, 0.02);
    
    // Modulation
    this.modLFO.frequency.setTargetAtTime(safe(this.params.modRate, 0.5), now, 0.02);
    this.modGain.gain.setTargetAtTime(safe(this.params.modDepth, 0.1) * 0.01, now, 0.02);
    
    this.updateRouting();

    // Regenerate IR if needed
    if (this.params.decay !== oldDecay || this.params.size !== oldSize || this.params.mode !== oldMode) {
      if (!this.params.freeze) {
        this.updateImpulseResponse();
      }
    }
    
    // Handle freeze toggle
    if (this.params.freeze && !wasFreeze) {
      this.activateFreeze();
    } else if (!this.params.freeze && wasFreeze) {
      this.deactivateFreeze();
    }
  }

  private activateFreeze() {
    // Store current buffer and switch to infinite decay
    this.freezeBuffer = this.convolver.buffer;
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * 10; // 10 seconds of freeze
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    
    // Create sustained noise
    for (let c = 0; c < 2; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        channel[i] = (Math.random() * 2 - 1) * 0.3;
      }
    }
    this.convolver.buffer = buffer;
    this.isFrozen = true;
  }

  private deactivateFreeze() {
    if (this.freezeBuffer) {
      this.convolver.buffer = this.freezeBuffer;
    } else {
      this.updateImpulseResponse();
    }
    this.isFrozen = false;
  }

  private updateImpulseResponse() {
    if (this.isFrozen) return;
    
    const sampleRate = this.ctx.sampleRate;
    const duration = Math.min(this.params.decay, 15);
    const length = Math.floor(sampleRate * duration);
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let density = this.params.size * 2500;
    let decayPower = 5;
    
    switch (this.params.mode) {
      case 'ROOM':
        density *= 0.6;
        decayPower = 8;
        break;
      case 'HALL':
        density *= 1.0;
        decayPower = 5;
        break;
      case 'PLATE':
        density *= 2.5;
        decayPower = 6;
        break;
      case 'CATHEDRAL':
        density *= 0.8;
        decayPower = 3;
        break;
      case 'SHIMMER':
        density *= 3.0;
        decayPower = 4;
        break;
    }

    for (let c = 0; c < 2; c++) {
      const channel = c === 0 ? left : right;
      let k = 0;
      while (k < length) {
        const step = Math.round(sampleRate / density * (0.5 + Math.random()));
        if (k + step >= length) break;
        k += step;
        const time = k / sampleRate;
        const envelope = Math.pow(1 - time / duration, decayPower);
        const sign = Math.random() > 0.5 ? 1 : -1;
        const spread = c === 0 ? 1 : (0.85 + Math.random() * 0.3);
        channel[k] = sign * envelope * spread * 0.85;
      }
    }
    
    this.convolver.buffer = buffer;
  }

  public getInputLevel(): number {
    this.inputAnalyzer.getFloatTimeDomainData(this.inputData);
    let max = 0;
    for (let i = 0; i < this.inputData.length; i++) {
      const abs = Math.abs(this.inputData[i]);
      if (abs > max) max = abs;
    }
    return max > 0 ? 20 * Math.log10(max) : -100;
  }

  public getOutputLevel(): number {
    this.outputAnalyzer.getFloatTimeDomainData(this.outputData);
    let max = 0;
    for (let i = 0; i < this.outputData.length; i++) {
      const abs = Math.abs(this.outputData[i]);
      if (abs > max) max = abs;
    }
    return max > 0 ? 20 * Math.log10(max) : -100;
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch (paramId) {
      case 'mix': return this.wetGain.gain;
      case 'preDelay': return this.preDelayNode.delayTime;
      case 'damping': return this.dampingFilter.frequency;
      case 'lowCut': return this.lowCutFilter.frequency;
      case 'highCut': return this.highCutFilter.frequency;
      default: return null;
    }
  }

  public getParams() { return { ...this.params }; }
  
  public destroy() {
    if (this.duckingInterval) {
      clearInterval(this.duckingInterval);
    }
    this.modLFO.stop();
  }
}

export const ProfessionalReverbUI: React.FC<{ 
  node: ReverbNode, 
  initialParams: ReverbParams, 
  onParamsChange?: (p: ReverbParams) => void,
  trackId?: string,
  pluginId?: string
}> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<ReverbParams>(initialParams);
  const [inputLevel, setInputLevel] = useState(-100);
  const [outputLevel, setOutputLevel] = useState(-100);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = (key: keyof ReverbParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const loadPreset = (index: number) => {
    const preset = REVERB_PRESETS[index];
    if (preset) {
      const newParams = { ...params, ...preset };
      setParams(newParams);
      node.updateParams(newParams);
      if (onParamsChange) onParamsChange(newParams);
    }
  };

  // Animation loop for metering and visualization
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    let animId = 0;

    const draw = () => {
      // Update meters
      setInputLevel(node.getInputLevel());
      setOutputLevel(node.getOutputLevel());
      
      ctx.clearRect(0, 0, w, h);
      
      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const duration = params.decay;
      const displayTime = Math.min(8, duration * 1.5);
      
      // Early reflections visualization
      ctx.fillStyle = '#818cf8';
      const erTimes = [0.012, 0.019, 0.027, 0.038];
      erTimes.forEach(t => {
        const x = (t / displayTime) * w;
        const erHeight = params.erLevel * (h - 40) * 0.6;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x - 1, h - 20 - erHeight, 3, erHeight);
      });
      ctx.globalAlpha = 1;

      // Decay envelope
      ctx.beginPath();
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#6366f166';
      ctx.moveTo(0, h - 20);
      
      for (let x = 0; x < w; x++) {
        const t = (x / w) * displayTime;
        if (t > duration) break;
        const envelope = Math.pow(1 - t / duration, 4);
        const noise = (Math.random() * 0.1 * envelope);
        const y = (h - 20) - ((envelope + noise) * (h - 40));
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Pre-delay marker
      const preDelayX = (params.preDelay / displayTime) * w;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(preDelayX, 0);
      ctx.lineTo(preDelayX, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Freeze indicator
      if (params.freeze) {
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 12px monospace';
        ctx.fillText('FREEZE', w - 60, 20);
      }
      
      animId = requestAnimationFrame(draw);
    };
    
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [node, params]);

  // Level meter component
  const LevelMeter: React.FC<{ level: number; label: string }> = ({ level, label }) => {
    const percent = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
    return (
      <div className="flex flex-col items-center">
        <span className="text-[6px] font-black text-slate-600 uppercase mb-1">{label}</span>
        <div className="w-3 h-24 bg-black/60 rounded relative overflow-hidden border border-white/5">
          <div 
            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-indigo-500 via-indigo-400 to-cyan-400 transition-all duration-75"
            style={{ height: `${percent}%` }}
          />
        </div>
        <span className="text-[7px] font-mono text-slate-500 mt-1">{Math.round(level)}</span>
      </div>
    );
  };

  return (
    <div className="w-[680px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/20">
            <i className="fas fa-mountain-sun text-xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter">
              Spatial <span className="text-indigo-400">Verb</span>
            </h2>
            <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">
              Algorithmic Reverb Engine v3.0
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* Freeze toggle */}
          <button
            onClick={() => handleParamChange('freeze', !params.freeze)}
            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all border ${
              params.freeze 
                ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/30' 
                : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'
            }`}
          >
            <i className="fas fa-snowflake mr-2"></i>Freeze
          </button>
          
          {/* Power */}
          <button 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${
              params.isEnabled 
                ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg shadow-indigo-500/30' 
                : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'
            }`}
          >
            <i className="fas fa-power-off text-sm"></i>
          </button>
        </div>
      </div>

      {/* Mode & Preset selectors */}
      <div className="flex items-center justify-between">
        <div className="flex bg-black/40 p-1 rounded-2xl border border-white/5">
          {(['ROOM', 'HALL', 'PLATE', 'CATHEDRAL', 'SHIMMER'] as ReverbMode[]).map(m => (
            <button 
              key={m}
              onClick={() => handleParamChange('mode', m)}
              className={`px-3 py-1.5 rounded-xl text-[8px] font-black uppercase transition-all ${
                params.mode === m 
                  ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' 
                  : 'text-slate-500 hover:text-white'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        
        <select 
          onChange={(e) => loadPreset(parseInt(e.target.value))}
          className="bg-[#14161a] border border-white/10 rounded-xl px-4 py-2 text-[9px] font-black text-white hover:border-indigo-500/50 outline-none cursor-pointer"
          defaultValue="-1"
        >
          <option disabled value="-1">PRESETS</option>
          {REVERB_PRESETS.map((p, i) => (
            <option key={i} value={i}>{p.name.toUpperCase()}</option>
          ))}
        </select>
      </div>

      {/* Visualization + Meters */}
      <div className="flex space-x-4">
        <div className="flex-1 h-36 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden">
          <canvas ref={canvasRef} width={520} height={144} className="w-full h-full" />
          <div className="absolute top-2 left-3 text-[7px] font-black text-slate-600 uppercase tracking-widest">
            Impulse Response
          </div>
        </div>
        
        <div className="flex space-x-2 bg-black/40 rounded-[24px] border border-white/5 p-3">
          <LevelMeter level={inputLevel} label="IN" />
          <LevelMeter level={outputLevel} label="OUT" />
        </div>
      </div>

      {/* Main controls row 1 */}
      <div className="grid grid-cols-6 gap-4">
        <ReverbKnob label="Decay" value={params.decay} min={0.1} max={15} suffix="s" color="#6366f1" onChange={v => handleParamChange('decay', v)} />
        <ReverbKnob label="Pre-Delay" value={params.preDelay} min={0} max={0.2} factor={1000} suffix="ms" color="#6366f1" onChange={v => handleParamChange('preDelay', v)} />
        <ReverbKnob label="Size" value={params.size} min={0} max={1} factor={100} suffix="%" color="#6366f1" onChange={v => handleParamChange('size', v)} />
        <ReverbKnob label="Damping" value={params.damping} min={1000} max={20000} log suffix="Hz" color="#6366f1" onChange={v => handleParamChange('damping', v)} />
        <ReverbKnob label="ER Level" value={params.erLevel} min={0} max={1} factor={100} suffix="%" color="#818cf8" onChange={v => handleParamChange('erLevel', v)} />
        <ReverbKnob label="Mix" value={params.mix} min={0} max={1} factor={100} suffix="%" color="#22d3ee" onChange={v => handleParamChange('mix', v)} />
      </div>

      {/* Advanced controls row 2 */}
      <div className="grid grid-cols-6 gap-4 pt-4 border-t border-white/5">
        <ReverbKnob label="Low Cut" value={params.lowCut} min={20} max={1000} log suffix="Hz" color="#f43f5e" onChange={v => handleParamChange('lowCut', v)} />
        <ReverbKnob label="High Cut" value={params.highCut} min={1000} max={20000} log suffix="Hz" color="#f43f5e" onChange={v => handleParamChange('highCut', v)} />
        <ReverbKnob label="Width" value={params.width} min={0} max={2} factor={100} suffix="%" color="#a855f7" onChange={v => handleParamChange('width', v)} />
        <ReverbKnob label="Mod Rate" value={params.modRate} min={0} max={5} suffix="Hz" color="#a855f7" onChange={v => handleParamChange('modRate', v)} />
        <ReverbKnob label="Mod Depth" value={params.modDepth} min={0} max={1} factor={100} suffix="%" color="#a855f7" onChange={v => handleParamChange('modDepth', v)} />
        <ReverbKnob label="Ducking" value={params.ducking} min={0} max={1} factor={100} suffix="%" color="#f97316" onChange={v => handleParamChange('ducking', v)} />
      </div>
    </div>
  );
};

const ReverbKnob: React.FC<{ 
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix: string;
  color: string;
  log?: boolean;
  factor?: number;
}> = ({ label, value, min, max, onChange, suffix, color, log, factor = 1 }) => {
  const safeVal = Number.isFinite(value) ? value : min;
  const norm = log 
    ? Math.max(0, Math.min(1, Math.log10(safeVal / min) / Math.log10(max / min)))
    : (safeVal - min) / (max - min);

  const calculateValue = (delta: number, startNorm: number) => {
    const newNorm = Math.max(0, Math.min(1, startNorm + delta / 200));
    return log ? min * Math.pow(max / min, newNorm) : min + newNorm * (max - min);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startNorm = norm;

    const onMouseMove = (moveEvent: MouseEvent) => {
      onChange(calculateValue(startY - moveEvent.clientY, startNorm));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startNorm = norm;

    const onTouchMove = (te: TouchEvent) => {
      if (te.cancelable) te.preventDefault();
      onChange(calculateValue(startY - te.touches[0].clientY, startNorm));
    };

    const onTouchEnd = () => {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  const displayValue = log ? Math.round(safeVal) : Math.round(safeVal * factor * 10) / 10;

  return (
    <div className="flex flex-col items-center space-y-2 select-none touch-none">
      <div 
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="relative w-11 h-11 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-indigo-500/50 transition-all shadow-xl"
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-4 -ml-0.5 -mt-4 origin-bottom rounded-full transition-transform duration-75"
          style={{ 
            backgroundColor: color,
            boxShadow: `0 0 8px ${color}44`,
            transform: `rotate(${(norm * 270) - 135}deg) translateY(2px)` 
          }}
        />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[44px]">
          <span className="text-[8px] font-mono font-bold text-white">{displayValue}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export default ProfessionalReverbUI;
