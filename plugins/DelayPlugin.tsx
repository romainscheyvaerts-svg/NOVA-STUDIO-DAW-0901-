import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PluginParameter } from '../types';

/**
 * PROFESSIONAL TAPE DELAY ENGINE v3.0
 * ===================================
 * Inspired by classic tape delays (Roland Space Echo, Echoplex)
 * and modern plugins (Soundtoys EchoBoy, Valhalla Delay)
 * 
 * Features:
 * - Multi-tap delay (up to 4 taps)
 * - HP/LP filters in feedback loop
 * - Tape saturation with wow/flutter
 * - Ducking mode for cleaner mixes
 * - Stereo spread with L/R offset
 * - Freeze/infinite repeat mode
 */

export type DelayDivision = '1/1' | '1/2' | '1/2D' | '1/4' | '1/4D' | '1/4T' | '1/8' | '1/8D' | '1/8T' | '1/16' | '1/16D' | '1/16T' | '1/32';
export type DelayMode = 'DIGITAL' | 'TAPE' | 'ANALOG' | 'DIFFUSE' | 'REVERSE';

export interface DelayParams {
  division: DelayDivision;
  divisionR: DelayDivision;  // Right channel division (for stereo offset)
  feedback: number;          // 0 to 0.95
  feedbackHP: number;        // 20 to 2000 Hz (highpass in feedback)
  feedbackLP: number;        // 1000 to 20000 Hz (lowpass in feedback)
  mix: number;               // 0 to 1
  stereoWidth: number;       // 0 to 1 (0=mono, 1=full stereo)
  pingPong: boolean;
  ducking: number;           // 0 to 1 (duck delay when input is loud)
  saturation: number;        // 0 to 1 (tape saturation amount)
  modRate: number;           // 0 to 5 Hz (wow/flutter rate)
  modDepth: number;          // 0 to 1 (wow/flutter depth)
  mode: DelayMode;
  freeze: boolean;           // Infinite repeat
  multiTap: boolean;         // Enable 4 taps
  tap2Level: number;         // 0 to 1
  tap3Level: number;         // 0 to 1
  tap4Level: number;         // 0 to 1
  bpm: number;
  isEnabled: boolean;
}

const DIVISION_FACTORS: Record<DelayDivision, number> = {
  '1/1': 4,
  '1/2': 2,
  '1/2D': 3,
  '1/4': 1,
  '1/4D': 1.5,
  '1/4T': 0.6667,
  '1/8': 0.5,
  '1/8D': 0.75,
  '1/8T': 0.3333,
  '1/16': 0.25,
  '1/16D': 0.375,
  '1/16T': 0.1667,
  '1/32': 0.125,
};

export class SyncDelayNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  // Main delay lines
  private delayNodeL: DelayNode;
  private delayNodeR: DelayNode;
  
  // Multi-tap delays
  private tap2Delay: DelayNode;
  private tap3Delay: DelayNode;
  private tap4Delay: DelayNode;
  private tap2Gain: GainNode;
  private tap3Gain: GainNode;
  private tap4Gain: GainNode;
  
  // Feedback network
  private feedbackGain: GainNode;
  private feedbackHP: BiquadFilterNode;
  private feedbackLP: BiquadFilterNode;
  
  // Saturation/character
  private tapeSaturator: WaveShaperNode;
  private analogFilter: BiquadFilterNode;  // Adds analog warmth
  
  // Modulation (wow/flutter)
  private modLFO1: OscillatorNode;
  private modLFO2: OscillatorNode;  // Secondary for complex modulation
  private modGain1: GainNode;
  private modGain2: GainNode;
  
  // Ducking
  private duckingAnalyzer: AnalyserNode;
  private duckingGain: GainNode;
  private duckingData: Float32Array;
  private duckingInterval: number | null = null;
  
  // Stereo processing
  private panL: StereoPannerNode;
  private panR: StereoPannerNode;
  private stereoSplitter: ChannelSplitterNode;
  private stereoMerger: ChannelMergerNode;
  
  // Mix
  private wetGain: GainNode;
  private dryGain: GainNode;
  
  // Metering
  public inputAnalyzer: AnalyserNode;
  public outputAnalyzer: AnalyserNode;

  private params: DelayParams;

  constructor(ctx: AudioContext, bpm: number) {
    this.ctx = ctx;
    this.params = {
      division: '1/4',
      divisionR: '1/4',
      feedback: 0.4,
      feedbackHP: 80,
      feedbackLP: 8000,
      mix: 0.3,
      stereoWidth: 1.0,
      pingPong: false,
      ducking: 0,
      saturation: 0.3,
      modRate: 0.5,
      modDepth: 0.15,
      mode: 'TAPE',
      freeze: false,
      multiTap: false,
      tap2Level: 0.5,
      tap3Level: 0.35,
      tap4Level: 0.2,
      bpm: bpm || 120,
      isEnabled: true,
    };

    // I/O
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Initialize with zero gain and ramp up to avoid click on creation
    this.output.gain.setValueAtTime(0, ctx.currentTime);
    this.output.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02);
    
    // Main delay lines (up to 4 seconds)
    this.delayNodeL = ctx.createDelay(4.0);
    this.delayNodeR = ctx.createDelay(4.0);
    
    // Multi-tap delays
    this.tap2Delay = ctx.createDelay(4.0);
    this.tap3Delay = ctx.createDelay(4.0);
    this.tap4Delay = ctx.createDelay(4.0);
    this.tap2Gain = ctx.createGain();
    this.tap3Gain = ctx.createGain();
    this.tap4Gain = ctx.createGain();
    
    // Feedback network with filters
    this.feedbackGain = ctx.createGain();
    this.feedbackHP = ctx.createBiquadFilter();
    this.feedbackHP.type = 'highpass';
    this.feedbackHP.frequency.value = 80;
    this.feedbackHP.Q.value = 0.5;
    
    this.feedbackLP = ctx.createBiquadFilter();
    this.feedbackLP.type = 'lowpass';
    this.feedbackLP.frequency.value = 8000;
    this.feedbackLP.Q.value = 0.5;
    
    // Saturation
    this.tapeSaturator = ctx.createWaveShaper();
    this.tapeSaturator.oversample = '4x';
    this.updateSaturationCurve();
    
    // Analog warmth filter
    this.analogFilter = ctx.createBiquadFilter();
    this.analogFilter.type = 'lowshelf';
    this.analogFilter.frequency.value = 300;
    this.analogFilter.gain.value = 2;
    
    // Modulation LFOs
    this.modLFO1 = ctx.createOscillator();
    this.modLFO1.type = 'sine';
    this.modLFO1.frequency.value = 0.5;
    this.modGain1 = ctx.createGain();
    this.modGain1.gain.value = 0.0008;
    
    this.modLFO2 = ctx.createOscillator();
    this.modLFO2.type = 'triangle';
    this.modLFO2.frequency.value = 0.37;
    this.modGain2 = ctx.createGain();
    this.modGain2.gain.value = 0.0003;
    
    this.modLFO1.connect(this.modGain1);
    this.modLFO2.connect(this.modGain2);
    this.modLFO1.start();
    this.modLFO2.start();
    
    // Ducking
    this.duckingAnalyzer = ctx.createAnalyser();
    this.duckingAnalyzer.fftSize = 256;
    this.duckingData = new Float32Array(this.duckingAnalyzer.frequencyBinCount);
    this.duckingGain = ctx.createGain();
    
    // Stereo processing
    this.panL = ctx.createStereoPanner();
    this.panR = ctx.createStereoPanner();
    this.stereoSplitter = ctx.createChannelSplitter(2);
    this.stereoMerger = ctx.createChannelMerger(2);
    
    // Mix
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    
    // Metering
    this.inputAnalyzer = ctx.createAnalyser();
    this.inputAnalyzer.fftSize = 256;
    this.outputAnalyzer = ctx.createAnalyser();
    this.outputAnalyzer.fftSize = 256;

    this.setupChain();
    this.startDuckingProcess();
  }

  private updateSaturationCurve() {
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const amount = this.params.saturation * 100 + 10;
    
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      
      switch (this.params.mode) {
        case 'TAPE':
          // Soft tape saturation with asymmetry
          curve[i] = Math.tanh(x * (1 + amount * 0.02)) * 0.95;
          break;
        case 'ANALOG':
          // Tube-like saturation
          const k = amount * 0.5;
          curve[i] = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * k)) / (1 - Math.exp(-k));
          break;
        case 'DIGITAL':
          // Clean digital (no saturation)
          curve[i] = x;
          break;
        case 'DIFFUSE':
          // Slight soft clipping for smearing effect
          curve[i] = x - (Math.pow(x, 3) / 3);
          break;
        case 'REVERSE':
          // Clean for reverse delay
          curve[i] = x;
          break;
        default:
          curve[i] = Math.tanh(x * 1.5);
      }
    }
    
    this.tapeSaturator.curve = curve;
  }

  private setupChain() {
    this.input.disconnect();
    
    // Input metering
    this.input.connect(this.inputAnalyzer);
    
    // Ducking analyzer
    this.input.connect(this.duckingAnalyzer);
    
    // Dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    
    // Wet path - main tap
    this.input.connect(this.delayNodeL);
    
    // Modulation connections
    this.modGain1.connect(this.delayNodeL.delayTime);
    this.modGain2.connect(this.delayNodeL.delayTime);
    this.modGain1.connect(this.delayNodeR.delayTime);
    this.modGain2.connect(this.delayNodeR.delayTime);
    
    // Multi-tap connections
    this.input.connect(this.tap2Delay);
    this.input.connect(this.tap3Delay);
    this.input.connect(this.tap4Delay);
    this.tap2Delay.connect(this.tap2Gain);
    this.tap3Delay.connect(this.tap3Gain);
    this.tap4Delay.connect(this.tap4Gain);
    
    // Feedback chain
    this.feedbackHP.connect(this.feedbackLP);
    this.feedbackLP.connect(this.analogFilter);
    this.analogFilter.connect(this.tapeSaturator);
    this.tapeSaturator.connect(this.feedbackGain);
    
    this.updateRouting();
    
    // Output through ducking
    this.duckingGain.connect(this.wetGain);
    this.wetGain.connect(this.output);
    
    // Output metering
    this.output.connect(this.outputAnalyzer);
    
    this.applyParams();
  }

  private updateRouting() {
    // Disconnect existing routing
    this.feedbackGain.disconnect();
    this.delayNodeL.disconnect();
    this.delayNodeR.disconnect();
    this.panL.disconnect();
    this.panR.disconnect();
    
    if (this.params.pingPong) {
      // Ping-pong: L -> R -> L alternating
      this.delayNodeL.connect(this.feedbackHP);
      this.delayNodeL.connect(this.panL);
      
      this.feedbackGain.connect(this.delayNodeR);
      this.delayNodeR.connect(this.feedbackHP);
      this.delayNodeR.connect(this.panR);
      
      const width = this.params.stereoWidth;
      this.panL.pan.value = -0.9 * width;
      this.panR.pan.value = 0.9 * width;
      
      this.panL.connect(this.duckingGain);
      this.panR.connect(this.duckingGain);
      
    } else {
      // Stereo delay with independent L/R times
      this.delayNodeL.connect(this.feedbackHP);
      this.feedbackGain.connect(this.delayNodeL);
      
      // For stereo mode, also connect R
      this.input.connect(this.delayNodeR);
      this.delayNodeR.connect(this.feedbackHP);
      
      // Stereo width via panning
      const width = this.params.stereoWidth;
      this.delayNodeL.connect(this.panL);
      this.delayNodeR.connect(this.panR);
      this.panL.pan.value = -0.5 * width;
      this.panR.pan.value = 0.5 * width;
      
      this.panL.connect(this.duckingGain);
      this.panR.connect(this.duckingGain);
    }
    
    // Connect multi-taps to ducking gain
    if (this.params.multiTap) {
      this.tap2Gain.connect(this.duckingGain);
      this.tap3Gain.connect(this.duckingGain);
      this.tap4Gain.connect(this.duckingGain);
    }
  }

  private startDuckingProcess() {
    this.duckingInterval = window.setInterval(() => {
      if (this.params.ducking > 0 && this.params.isEnabled) {
        this.duckingAnalyzer.getFloatTimeDomainData(this.duckingData);
        let rms = 0;
        for (let i = 0; i < this.duckingData.length; i++) {
          rms += this.duckingData[i] * this.duckingData[i];
        }
        rms = Math.sqrt(rms / this.duckingData.length);
        
        const duckAmount = Math.min(1, rms * 5) * this.params.ducking;
        const targetGain = Math.max(0.05, 1 - duckAmount * 0.9);
        this.duckingGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.02);
      } else {
        this.duckingGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
      }
    }, 1000 / 60);
  }

  public updateParams(p: Partial<DelayParams>) {
    const oldPingPong = this.params.pingPong;
    const oldMode = this.params.mode;
    const oldMultiTap = this.params.multiTap;
    
    this.params = { ...this.params, ...p };
    
    // Update routing if needed
    if (p.pingPong !== undefined && p.pingPong !== oldPingPong) {
      this.updateRouting();
    }
    if (p.multiTap !== undefined && p.multiTap !== oldMultiTap) {
      this.updateRouting();
    }
    
    // Update saturation curve if mode changed
    if (p.mode !== undefined && p.mode !== oldMode) {
      this.updateSaturationCurve();
    }
    if (p.saturation !== undefined) {
      this.updateSaturationCurve();
    }
    
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const beatDuration = 60 / (this.params.bpm || 120);
    const delayL = beatDuration * DIVISION_FACTORS[this.params.division];
    const delayR = beatDuration * DIVISION_FACTORS[this.params.divisionR || this.params.division];
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;

    if (this.params.isEnabled) {
      // Main delay times
      this.delayNodeL.delayTime.setTargetAtTime(delayL, now, 0.05);
      this.delayNodeR.delayTime.setTargetAtTime(delayR, now, 0.05);
      
      // Multi-tap times (fractions of main delay)
      if (this.params.multiTap) {
        this.tap2Delay.delayTime.setTargetAtTime(delayL * 0.5, now, 0.05);
        this.tap3Delay.delayTime.setTargetAtTime(delayL * 0.75, now, 0.05);
        this.tap4Delay.delayTime.setTargetAtTime(delayL * 0.25, now, 0.05);
        this.tap2Gain.gain.setTargetAtTime(safe(this.params.tap2Level, 0.5), now, 0.02);
        this.tap3Gain.gain.setTargetAtTime(safe(this.params.tap3Level, 0.35), now, 0.02);
        this.tap4Gain.gain.setTargetAtTime(safe(this.params.tap4Level, 0.2), now, 0.02);
      } else {
        this.tap2Gain.gain.setTargetAtTime(0, now, 0.02);
        this.tap3Gain.gain.setTargetAtTime(0, now, 0.02);
        this.tap4Gain.gain.setTargetAtTime(0, now, 0.02);
      }
      
      // Feedback with freeze mode
      const fb = this.params.freeze ? 0.98 : safe(this.params.feedback, 0.4);
      this.feedbackGain.gain.setTargetAtTime(fb, now, 0.02);
      
      // Feedback filters
      this.feedbackHP.frequency.setTargetAtTime(safe(this.params.feedbackHP, 80), now, 0.02);
      this.feedbackLP.frequency.setTargetAtTime(safe(this.params.feedbackLP, 8000), now, 0.02);
      
      // Modulation
      const modEnabled = this.params.mode === 'TAPE' || this.params.mode === 'ANALOG';
      const modDepth = modEnabled ? safe(this.params.modDepth, 0.15) : 0;
      this.modLFO1.frequency.setTargetAtTime(safe(this.params.modRate, 0.5), now, 0.02);
      this.modLFO2.frequency.setTargetAtTime(safe(this.params.modRate, 0.5) * 0.73, now, 0.02);
      this.modGain1.gain.setTargetAtTime(modDepth * 0.002, now, 0.02);
      this.modGain2.gain.setTargetAtTime(modDepth * 0.0008, now, 0.02);
      
      // Analog warmth based on mode
      const warmth = this.params.mode === 'TAPE' ? 3 : (this.params.mode === 'ANALOG' ? 4 : 0);
      this.analogFilter.gain.setTargetAtTime(warmth, now, 0.02);
      
      // Mix with equal-power crossfade
      const mix = safe(this.params.mix, 0.3);
      this.dryGain.gain.setTargetAtTime(Math.cos(mix * Math.PI * 0.5), now, 0.02);
      this.wetGain.gain.setTargetAtTime(Math.sin(mix * Math.PI * 0.5), now, 0.02);
      
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public getParameters(): PluginParameter[] {
    return [
      { id: 'feedback', name: 'Feedback', type: 'float', min: 0, max: 0.95, value: this.params.feedback, unit: '%' },
      { id: 'mix', name: 'Dry/Wet', type: 'float', min: 0, max: 1, value: this.params.mix, unit: '%' },
      { id: 'feedbackLP', name: 'Tone', type: 'float', min: 1000, max: 20000, value: this.params.feedbackLP, unit: 'Hz' }
    ];
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch (paramId) {
      case 'feedback': return this.feedbackGain.gain;
      case 'mix': return this.wetGain.gain;
      case 'feedbackLP': return this.feedbackLP.frequency;
      case 'feedbackHP': return this.feedbackHP.frequency;
      default: return null;
    }
  }

  public dispose() {
    try {
      if (this.modLFO1) {
        this.modLFO1.stop();
        this.modLFO1.disconnect();
      }
      if (this.modLFO2) {
        this.modLFO2.stop();
        this.modLFO2.disconnect();
      }
      if (this.duckingInterval) {
        clearInterval(this.duckingInterval);
      }
    } catch (e) {
      // Oscillators may already be stopped
    }
  }

  public getParams() { return { ...this.params }; }
}

export const SyncDelayUI: React.FC<{ node: SyncDelayNode, initialParams: DelayParams, onParamsChange?: (p: DelayParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = useCallback((key: keyof DelayParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  // Visualization
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frameId = 0;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = (w / 8) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const beatDuration = 60 / params.bpm;
      const delayTimeL = beatDuration * DIVISION_FACTORS[params.division] * 1000;
      const delayTimeR = beatDuration * DIVISION_FACTORS[params.divisionR || params.division] * 1000;
      const progress = (Date.now() % delayTimeL) / delayTimeL;

      // Animated pulse
      if (params.isEnabled) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(0, 242, 255, ${(1 - progress) * 0.5})`;
        ctx.lineWidth = 3;
        ctx.arc(60, h / 2, 20 + progress * 25, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Center dot
      ctx.beginPath();
      ctx.fillStyle = params.isEnabled ? '#00f2ff' : '#334155';
      ctx.arc(60, h / 2, 6, 0, Math.PI * 2);
      ctx.fill();

      // Delay taps visualization
      const numTaps = params.multiTap ? 6 : (params.pingPong ? 6 : 4);
      const startX = 120;
      const spacing = (w - 160) / numTaps;

      for (let i = 1; i <= numTaps; i++) {
        const x = startX + (i - 1) * spacing;
        const feedbackDecay = Math.pow(params.feedback, i);
        const flicker = params.mode === 'TAPE' ? (0.9 + Math.random() * 0.2) : 1;
        const height = feedbackDecay * (h - 40) * flicker;
        
        // Pan indicator for ping-pong
        let color = '#00f2ff';
        if (params.pingPong) {
          color = i % 2 === 0 ? '#ff6b6b' : '#00f2ff';
        }
        
        // Gradient bar
        const gradient = ctx.createLinearGradient(x, h/2 - height/2, x, h/2 + height/2);
        gradient.addColorStop(0, color);
        gradient.addColorStop(0.5, `${color}99`);
        gradient.addColorStop(1, color);
        
        ctx.fillStyle = gradient;
        ctx.globalAlpha = feedbackDecay * 0.6;
        ctx.fillRect(x - 3, h/2 - height/2, 6, height);
        ctx.globalAlpha = 1;
        
        // Tap number
        ctx.fillStyle = '#334155';
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${i}`, x, h - 8);
      }

      // Mode indicator
      ctx.fillStyle = '#334155';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${params.mode}`, 10, 15);
      
      // BPM and timing
      ctx.textAlign = 'right';
      ctx.fillText(`${params.bpm} BPM`, w - 10, 15);
      ctx.fillText(`${params.division}`, w - 10, h - 8);

      frameId = requestAnimationFrame(draw);
    };
    
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [params]);

  return (
    <div className="w-[620px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-history text-xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">
              Echo <span className="text-cyan-400">Engine</span>
              <span className="text-[8px] ml-2 font-normal text-slate-600">v3.0</span>
            </h2>
            <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Multi-Tap Delay Processor</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          <button 
            onClick={() => handleParamChange('freeze', !params.freeze)}
            className={`px-3 h-8 rounded-xl text-[8px] font-black uppercase transition-all border ${params.freeze ? 'bg-purple-500 border-purple-400 text-white shadow-lg shadow-purple-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            <i className="fas fa-snowflake mr-1"></i>Freeze
          </button>
          <button 
            onClick={() => handleParamChange('pingPong', !params.pingPong)}
            className={`px-3 h-8 rounded-xl text-[8px] font-black uppercase transition-all border ${params.pingPong ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            Ping-Pong
          </button>
          <button 
            onClick={() => handleParamChange('multiTap', !params.multiTap)}
            className={`px-3 h-8 rounded-xl text-[8px] font-black uppercase transition-all border ${params.multiTap ? 'bg-amber-500 border-amber-400 text-black shadow-lg shadow-amber-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            Multi-Tap
          </button>
          <button 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <i className="fas fa-power-off text-sm"></i>
          </button>
        </div>
      </div>

      {/* Mode Selector */}
      <div className="flex bg-black/40 p-1 rounded-xl border border-white/5">
        {(['DIGITAL', 'TAPE', 'ANALOG', 'DIFFUSE'] as DelayMode[]).map(m => (
          <button 
            key={m}
            onClick={() => handleParamChange('mode', m)}
            className={`flex-1 py-2 rounded-lg text-[8px] font-black uppercase transition-all ${params.mode === m ? 'bg-cyan-500 text-black shadow-lg' : 'text-slate-500 hover:text-white'}`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Visualization */}
      <div className="h-28 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden shadow-inner">
        <canvas ref={canvasRef} width={580} height={112} className="w-full h-full" />
      </div>

      {/* Time Division */}
      <div className="flex bg-black/40 p-1 rounded-xl border border-white/5 justify-between">
        {(['1/4', '1/4D', '1/8', '1/8D', '1/8T', '1/16', '1/16D', '1/32'] as DelayDivision[]).map(d => (
          <button 
            key={d}
            onClick={() => handleParamChange('division', d)}
            className={`flex-1 py-2 rounded-lg text-[8px] font-black uppercase transition-all ${params.division === d ? 'bg-white text-black shadow-lg' : 'text-slate-500 hover:text-white'}`}
          >
            {d}
          </button>
        ))}
      </div>

      {/* Main Controls */}
      <div className="grid grid-cols-5 gap-4">
        <DelayKnob label="Feedback" value={params.feedback} min={0} max={0.95} factor={100} suffix="%" color="#00f2ff" onChange={v => handleParamChange('feedback', v)} />
        <DelayKnob label="Tone LP" value={params.feedbackLP || 8000} min={1000} max={20000} log suffix="Hz" color="#00f2ff" onChange={v => handleParamChange('feedbackLP', v)} />
        <DelayKnob label="Saturation" value={params.saturation || 0.3} min={0} max={1} factor={100} suffix="%" color="#f59e0b" onChange={v => handleParamChange('saturation', v)} />
        <DelayKnob label="Width" value={params.stereoWidth || 1} min={0} max={1} factor={100} suffix="%" color="#a855f7" onChange={v => handleParamChange('stereoWidth', v)} />
        <DelayKnob label="Mix" value={params.mix} min={0} max={1} factor={100} suffix="%" color="#fff" onChange={v => handleParamChange('mix', v)} />
      </div>

      {/* Advanced Toggle */}
      <button 
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center justify-center space-x-2 py-2 text-[8px] font-black text-slate-500 uppercase tracking-widest hover:text-white transition-colors"
      >
        <span>{showAdvanced ? 'Hide' : 'Show'} Advanced</span>
        <i className={`fas fa-chevron-${showAdvanced ? 'up' : 'down'} text-[6px]`}></i>
      </button>

      {/* Advanced Controls */}
      {showAdvanced && (
        <div className="grid grid-cols-5 gap-4 pt-4 border-t border-white/5">
          <DelayKnob label="Tone HP" value={params.feedbackHP || 80} min={20} max={2000} log suffix="Hz" color="#f43f5e" onChange={v => handleParamChange('feedbackHP', v)} />
          <DelayKnob label="Mod Rate" value={params.modRate || 0.5} min={0} max={5} suffix="Hz" color="#8b5cf6" onChange={v => handleParamChange('modRate', v)} />
          <DelayKnob label="Mod Depth" value={params.modDepth || 0.15} min={0} max={1} factor={100} suffix="%" color="#8b5cf6" onChange={v => handleParamChange('modDepth', v)} />
          <DelayKnob label="Ducking" value={params.ducking || 0} min={0} max={1} factor={100} suffix="%" color="#10b981" onChange={v => handleParamChange('ducking', v)} />
          <div className="flex flex-col items-center justify-center">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest mb-2">R. Time</span>
            <select 
              value={params.divisionR || params.division}
              onChange={(e) => handleParamChange('divisionR', e.target.value as DelayDivision)}
              className="bg-[#14161a] border border-white/10 rounded-lg px-2 py-1 text-[9px] font-black text-white w-full cursor-pointer hover:border-cyan-500/50 transition-all"
            >
              {(['1/4', '1/4D', '1/8', '1/8D', '1/16'] as DelayDivision[]).map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="pt-4 border-t border-white/5 flex justify-between items-center text-slate-700">
        <div className="flex items-center space-x-4">
          <div className="flex flex-col">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Engine</span>
            <span className="text-[9px] font-black text-slate-400">{params.mode} DSP</span>
          </div>
          {params.multiTap && (
            <div className="flex flex-col">
              <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Taps</span>
              <span className="text-[9px] font-black text-amber-400">4 Active</span>
            </div>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-cyan-500 shadow-[0_0_10px_#00f2ff] animate-pulse' : 'bg-slate-800'}`} />
          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">
            {params.freeze ? 'FROZEN' : (params.pingPong ? 'STEREO' : 'MONO')}
          </span>
        </div>
      </div>
    </div>
  );
};

const DelayKnob: React.FC<{ 
  label: string, value: number, min: number, max: number, 
  onChange: (v: number) => void, suffix: string, color: string, 
  log?: boolean, factor?: number 
}> = ({ label, value, min, max, onChange, suffix, color, log, factor = 1 }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const norm = log 
    ? (Math.log10(safeValue / min) / Math.log10(max / min)) 
    : (safeValue - min) / (max - min);

  const calculateValue = (delta: number, startNorm: number) => {
      const newNorm = Math.max(0, Math.min(1, startNorm + delta / 200));
      return log ? min * Math.pow(max / min, newNorm) : min + newNorm * (max - min);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startNorm = norm;
    const onMouseMove = (m: MouseEvent) => onChange(calculateValue(startY - m.clientY, startNorm));
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startNorm = norm;
    const onTouchMove = (t: TouchEvent) => {
        if (t.cancelable) t.preventDefault();
        onChange(calculateValue(startY - t.touches[0].clientY, startNorm));
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  return (
    <div className="flex flex-col items-center space-y-3 select-none touch-none">
      <div 
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="relative w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl"
      >
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75"
          style={{ 
            backgroundColor: color,
            boxShadow: `0 0 12px ${color}44`,
            transform: `rotate(${(norm * 270) - 135}deg) translateY(2px)` 
          }}
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-600 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">
            {Math.round(safeValue * factor * 10) / 10}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};