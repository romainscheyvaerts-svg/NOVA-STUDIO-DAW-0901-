import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PluginParameter } from '../types';

export interface CompressorParams {
  threshold: number;      // -60 to 0 dB
  ratio: number;          // 1:1 to 20:1
  knee: number;           // 0 to 40 dB
  attack: number;         // 0.1 to 100 ms (stored as seconds: 0.0001 to 0.1)
  release: number;        // 10 to 1000 ms (stored as seconds: 0.01 to 1.0)
  makeupGain: number;     // 0 to 24 dB (stored as linear gain)
  mix: number;            // 0 to 1 (dry/wet for parallel compression)
  scHpFreq: number;       // 20 to 500 Hz (sidechain high-pass frequency)
  lookahead: number;      // 0 to 5 ms (stored as seconds)
  autoMakeup: boolean;    // Auto-calculate makeup gain
  mode: 'CLEAN' | 'VCA' | 'OPTO' | 'FET';  // Character modes
  isEnabled: boolean;
}

export class CompressorNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  // Core compression
  private compressor: DynamicsCompressorNode;
  private makeupGainNode: GainNode;
  
  // Parallel mix
  private dryGain: GainNode;
  private wetGain: GainNode;
  
  // Sidechain HP filter (reduces bass pumping)
  private scHighpass: BiquadFilterNode;
  
  // Lookahead delay
  private lookaheadDelay: DelayNode;
  
  // Character/saturation
  private saturationNode: WaveShaperNode;
  
  // Metering
  private inputAnalyzer: AnalyserNode;
  private outputAnalyzer: AnalyserNode;
  private inputData: Float32Array;
  private outputData: Float32Array;
  
  private params: CompressorParams = {
    threshold: -18,
    ratio: 4,
    knee: 12,
    attack: 0.003,
    release: 0.25,
    makeupGain: 1.0,
    mix: 1.0,
    scHpFreq: 80,
    lookahead: 0,
    autoMakeup: false,
    mode: 'CLEAN',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    
    // I/O
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Initialize with zero gain and ramp up to avoid click on creation
    this.output.gain.setValueAtTime(0, ctx.currentTime);
    this.output.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02);
    
    // Metering
    this.inputAnalyzer = ctx.createAnalyser();
    this.inputAnalyzer.fftSize = 256;
    this.inputData = new Float32Array(this.inputAnalyzer.frequencyBinCount);
    
    this.outputAnalyzer = ctx.createAnalyser();
    this.outputAnalyzer.fftSize = 256;
    this.outputData = new Float32Array(this.outputAnalyzer.frequencyBinCount);
    
    // Sidechain HP - insert before compressor
    this.scHighpass = ctx.createBiquadFilter();
    this.scHighpass.type = 'highpass';
    this.scHighpass.frequency.value = 80;
    this.scHighpass.Q.value = 0.707;
    
    // Lookahead delay on main signal
    this.lookaheadDelay = ctx.createDelay(0.01); // Max 10ms
    this.lookaheadDelay.delayTime.value = 0;
    
    // Core compressor
    this.compressor = ctx.createDynamicsCompressor();
    
    // Makeup gain
    this.makeupGainNode = ctx.createGain();
    
    // Saturation for character modes
    this.saturationNode = ctx.createWaveShaper();
    this.saturationNode.oversample = '4x';
    this.updateSaturationCurve('CLEAN');
    
    // Parallel compression mix
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0; // Full wet by default
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 1;
    
    this.input.connect(this.inputAnalyzer);
    
    // Dry path (for parallel compression)
    this.input.connect(this.dryGain);
    
    // Wet path (compressed)
    this.input.connect(this.scHighpass);
    this.scHighpass.connect(this.lookaheadDelay);
    this.lookaheadDelay.connect(this.compressor);
    this.compressor.connect(this.saturationNode);
    this.saturationNode.connect(this.makeupGainNode);
    this.makeupGainNode.connect(this.wetGain);
    
    // Merge dry + wet
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);
    
    // Output metering
    this.output.connect(this.outputAnalyzer);
    
    this.applyParams();
  }

  private updateSaturationCurve(mode: 'CLEAN' | 'VCA' | 'OPTO' | 'FET') {
    const samples = 44100;
    const curve = new Float32Array(samples);
    
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      
      switch (mode) {
        case 'CLEAN':
          curve[i] = x;
          break;
        case 'VCA':
          curve[i] = Math.tanh(x * 1.2) * 0.95;
          break;
        case 'OPTO':
          curve[i] = (3 * x) / (1 + 2 * Math.abs(x)) * 0.9;
          break;
        case 'FET':
          const k = 2;
          curve[i] = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * k)) * 0.85;
          break;
      }
    }
    
    this.saturationNode.curve = curve;
  }

  private calculateAutoMakeup(): number {
    const { threshold, ratio } = this.params;
    const reductionAtThreshold = Math.abs(threshold) * (1 - 1/ratio);
    return Math.pow(10, reductionAtThreshold / 40);
  }

  public updateParams(p: Partial<CompressorParams>) {
    this.params = { ...this.params, ...p };
    
    if (p.mode !== undefined) {
      this.updateSaturationCurve(this.params.mode);
    }
    
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (val: number, def: number) => Number.isFinite(val) ? val : def;

    if (this.params.isEnabled) {
      this.compressor.threshold.setTargetAtTime(safe(this.params.threshold, -18), now, 0.01);
      this.compressor.ratio.setTargetAtTime(safe(this.params.ratio, 4), now, 0.01);
      this.compressor.knee.setTargetAtTime(safe(this.params.knee, 12), now, 0.01);
      this.compressor.attack.setTargetAtTime(safe(this.params.attack, 0.003), now, 0.01);
      this.compressor.release.setTargetAtTime(safe(this.params.release, 0.25), now, 0.01);
      
      const makeup = this.params.autoMakeup 
        ? this.calculateAutoMakeup() 
        : safe(this.params.makeupGain, 1.0);
      this.makeupGainNode.gain.setTargetAtTime(makeup, now, 0.01);
      
      this.scHighpass.frequency.setTargetAtTime(safe(this.params.scHpFreq, 80), now, 0.01);
      
      this.lookaheadDelay.delayTime.setTargetAtTime(safe(this.params.lookahead, 0), now, 0.01);
      
      const wet = safe(this.params.mix, 1);
      const dry = 1 - wet;
      this.wetGain.gain.setTargetAtTime(wet, now, 0.01);
      this.dryGain.gain.setTargetAtTime(dry, now, 0.01);
      
    } else {
      this.compressor.threshold.setTargetAtTime(0, now, 0.01);
      this.compressor.ratio.setTargetAtTime(1, now, 0.01);
      this.makeupGainNode.gain.setTargetAtTime(1.0, now, 0.01);
      
      this.wetGain.gain.setTargetAtTime(0, now, 0.01);
      this.dryGain.gain.setTargetAtTime(1, now, 0.01);
    }
  }

  public getReduction(): number {
    return this.compressor.reduction;
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
    switch(paramId) {
      case 'threshold': return this.compressor.threshold;
      case 'ratio': return this.compressor.ratio;
      case 'knee': return this.compressor.knee;
      case 'attack': return this.compressor.attack;
      case 'release': return this.compressor.release;
      case 'makeupGain': return this.makeupGainNode.gain;
      case 'mix': return this.wetGain.gain;
      case 'scHpFreq': return this.scHighpass.frequency;
      default: return null;
    }
  }

  public getParams() { return { ...this.params }; }
}

const COMPRESSOR_PRESETS: Record<string, Partial<CompressorParams>> = {
  'Vocal Smooth': {
    threshold: -20,
    ratio: 3,
    knee: 20,
    attack: 0.015,
    release: 0.2,
    mix: 1.0,
    scHpFreq: 100,
    lookahead: 0.002,
    mode: 'OPTO'
  },
  'Vocal Aggressive': {
    threshold: -15,
    ratio: 6,
    knee: 6,
    attack: 0.002,
    release: 0.1,
    mix: 1.0,
    scHpFreq: 150,
    lookahead: 0.001,
    mode: 'FET'
  },
  'Mix Bus Glue': {
    threshold: -16,
    ratio: 2,
    knee: 30,
    attack: 0.03,
    release: 0.3,
    mix: 0.5,
    scHpFreq: 80,
    lookahead: 0,
    mode: 'VCA'
  },
  'Parallel Punch': {
    threshold: -30,
    ratio: 8,
    knee: 0,
    attack: 0.001,
    release: 0.15,
    mix: 0.3,
    scHpFreq: 60,
    lookahead: 0,
    mode: 'FET'
  },
  'Transparent Limiter': {
    threshold: -6,
    ratio: 20,
    knee: 0,
    attack: 0.0005,
    release: 0.05,
    mix: 1.0,
    scHpFreq: 20,
    lookahead: 0.005,
    mode: 'CLEAN'
  }
};

interface VocalCompressorUIProps {
  node: CompressorNode;
  initialParams: CompressorParams;
  onParamsChange?: (p: CompressorParams) => void;
}

export const VocalCompressorUI: React.FC<VocalCompressorUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<CompressorParams>(initialParams);
  const [reduction, setReduction] = useState(0);
  const [inputLevel, setInputLevel] = useState(-100);
  const [outputLevel, setOutputLevel] = useState(-100);
  const [inputPeak, setInputPeak] = useState(-100);
  const [outputPeak, setOutputPeak] = useState(-100);
  
  const curveCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const drawCurve = useCallback(() => {
    const canvas = curveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const { threshold, ratio, knee } = params;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for(let i = 0; i <= 6; i++) {
      const x = (i / 6) * w;
      const y = (i / 6) * h;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    
    // 1:1 reference line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Threshold line
    const threshX = ((threshold + 60) / 60) * w;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.3)';
    ctx.moveTo(threshX, 0);
    ctx.lineTo(threshX, h);
    ctx.stroke();

    // Transfer curve
    ctx.beginPath();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#f9731666';

    for(let i = 0; i <= w; i++) {
      const inputDb = (i / w) * 60 - 60;
      let outputDb = inputDb;

      if (inputDb > threshold + knee / 2) {
        outputDb = threshold + (inputDb - threshold) / ratio;
      } else if (inputDb > threshold - knee / 2) {
        const t = (inputDb - (threshold - knee / 2)) / knee;
        outputDb = inputDb + (1 / ratio - 1) * knee * t * t / 2;
      }

      const x = i;
      const y = h - ((outputDb + 60) / 60) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [params]);

  // Metering animation loop
  useEffect(() => {
    let animFrame = 0;
    let peakHoldIn = -100;
    let peakHoldOut = -100;
    let peakDecay = 0;
    
    const update = () => {
      const red = node.getReduction();
      const inLvl = node.getInputLevel();
      const outLvl = node.getOutputLevel();
      
      setReduction(red);
      setInputLevel(inLvl);
      setOutputLevel(outLvl);
      
      // Peak hold with decay
      if (inLvl > peakHoldIn) peakHoldIn = inLvl;
      if (outLvl > peakHoldOut) peakHoldOut = outLvl;
      
      peakDecay++;
      if (peakDecay > 60) { // ~1 second at 60fps
        peakHoldIn = Math.max(peakHoldIn - 1, inLvl);
        peakHoldOut = Math.max(peakHoldOut - 1, outLvl);
        peakDecay = 0;
      }
      
      setInputPeak(peakHoldIn);
      setOutputPeak(peakHoldOut);
      
      drawCurve();
      animFrame = requestAnimationFrame(update);
    };
    
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node, drawCurve]);
      

  const updateParam = (key: keyof CompressorParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const applyPreset = (presetName: string) => {
    const preset = COMPRESSOR_PRESETS[presetName];
    if (preset) {
      const newParams = { ...params, ...preset };
      setParams(newParams);
      node.updateParams(preset);
      if (onParamsChange) onParamsChange(newParams);
    }
  };

  const togglePower = () => {
    updateParam('isEnabled', !params.isEnabled);
  };

  // Meter bar component
  const MeterBar: React.FC<{ level: number; peak: number; label: string }> = ({ level, peak, label }) => {
    const levelPercent = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
    const peakPercent = Math.max(0, Math.min(100, ((peak + 60) / 60) * 100));
    
    return (
      <div className="flex flex-col items-center">
        <span className="text-[6px] font-black text-slate-600 uppercase mb-1">{label}</span>
        <div className="w-4 h-28 bg-black/60 rounded relative overflow-hidden border border-white/5">
          <div 
            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-green-500 via-yellow-500 to-red-500 transition-all duration-75"
            style={{ height: `${levelPercent}%` }}
          />
          <div 
            className="absolute left-0 right-0 h-0.5 bg-white transition-all duration-100"
            style={{ bottom: `${peakPercent}%` }}
          />
        </div>
        <span className="text-[7px] font-mono text-slate-400 mt-1">{Math.round(level)}</span>
      </div>
    );
  };

  // GR Meter
  const GRMeter: React.FC<{ reduction: number }> = ({ reduction }) => {
    const redDb = Math.abs(reduction);
    const meterPercent = Math.min(100, (redDb / 24) * 100);
    
    return (
      <div className="flex flex-col items-center">
        <span className="text-[6px] font-black text-slate-600 uppercase mb-1">GR</span>
        <div className="w-4 h-28 bg-black/60 rounded relative overflow-hidden border border-white/5">
          <div 
            className="absolute top-0 left-0 right-0 bg-orange-500 transition-all duration-75"
            style={{ height: `${meterPercent}%` }}
          />
        </div>
        <span className="text-[7px] font-mono text-orange-500 mt-1">{Math.round(redDb)}</span>
      </div>
    );
  };

  return (
    <div className="w-[580px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-orange-500/10 flex items-center justify-center text-orange-500 border border-orange-500/20">
            <i className="fas fa-compress-alt text-xl"></i>
          </div>
          <div>
            <h2 className="text-lg font-black italic text-white uppercase tracking-tighter">
              Leveler <span className="text-orange-500">Pro</span>
            </h2>
            <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">
              Professional Dynamics Processor
            </p>
          </div>
        </div>
        <button 
          onClick={togglePower}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled 
            ? 'bg-orange-500 border-orange-400 text-black shadow-lg shadow-orange-500/40' 
            : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off text-sm"></i>
        </button>
      </div>

      {/* Presets */}
      <div className="flex space-x-2">
        {Object.keys(COMPRESSOR_PRESETS).map(name => (
          <button
            key={name}
            onClick={() => applyPreset(name)}
            className="px-3 py-1.5 bg-white/5 hover:bg-orange-500/20 border border-white/10 hover:border-orange-500/50 rounded-lg text-[8px] font-black text-slate-400 hover:text-orange-400 uppercase tracking-wider transition-all"
          >
            {name}
          </button>
        ))}
      </div>

      {/* Main display: curve + meters */}
      <div className="flex space-x-4">
        {/* Transfer curve */}
        <div className="flex-1 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden h-40">
          <canvas ref={curveCanvasRef} width={400} height={160} className="w-full h-full opacity-90" />
          <div className="absolute top-3 left-4 text-[7px] font-black text-slate-600 uppercase tracking-widest">
            Transfer Curve
          </div>
          {/* Mode indicator */}
          <div className="absolute bottom-3 right-4 text-[8px] font-black text-orange-500 uppercase">
            {params.mode}
          </div>
        </div>
        
        {/* Meters */}
        <div className="flex space-x-2 bg-black/40 rounded-[24px] border border-white/5 p-3">
          <MeterBar level={inputLevel} peak={inputPeak} label="IN" />
          <GRMeter reduction={reduction} />
          <MeterBar level={outputLevel} peak={outputPeak} label="OUT" />
        </div>
      </div>

      {/* Mode selector */}
      <div className="flex items-center space-x-4">
        <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest">Character:</span>
        <div className="flex space-x-1">
          {(['CLEAN', 'VCA', 'OPTO', 'FET'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => updateParam('mode', mode)}
              className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all border ${
                params.mode === mode 
                  ? 'bg-orange-500 border-orange-400 text-black' 
                  : 'bg-white/5 border-white/10 text-slate-500 hover:text-white hover:border-white/20'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Main controls */}
      <div className="grid grid-cols-6 gap-4">
        <CompressorKnob label="Threshold" value={params.threshold} min={-60} max={0} suffix="dB" color="#f97316" onChange={(v) => updateParam('threshold', v)} displayVal={Math.round(params.threshold)} />
        <CompressorKnob label="Ratio" value={params.ratio} min={1} max={20} suffix=":1" color="#f97316" onChange={(v) => updateParam('ratio', v)} displayVal={params.ratio.toFixed(1)} />
        <CompressorKnob label="Knee" value={params.knee} min={0} max={40} suffix="dB" color="#f97316" onChange={(v) => updateParam('knee', v)} displayVal={Math.round(params.knee)} />
        <CompressorKnob label="Attack" value={params.attack} min={0.0001} max={0.1} factor={1000} suffix="ms" color="#fff" onChange={(v) => updateParam('attack', v)} displayVal={(params.attack * 1000).toFixed(1)} />
        <CompressorKnob label="Release" value={params.release} min={0.01} max={1.0} factor={1000} suffix="ms" color="#fff" onChange={(v) => updateParam('release', v)} displayVal={Math.round(params.release * 1000)} />
        <CompressorKnob label="Makeup" value={params.makeupGain} min={0.25} max={4} factor={1} suffix="x" color="#fff" onChange={(v) => updateParam('makeupGain', v)} displayVal={params.makeupGain.toFixed(2)} disabled={params.autoMakeup} />
      </div>

      {/* Advanced controls */}
      <div className="grid grid-cols-4 gap-4 pt-2 border-t border-white/5">
        <CompressorKnob label="Mix" value={params.mix} min={0} max={1} factor={100} suffix="%" color="#06b6d4" onChange={(v) => updateParam('mix', v)} displayVal={Math.round(params.mix * 100)} />
        <CompressorKnob label="SC HP" value={params.scHpFreq} min={20} max={500} suffix="Hz" color="#06b6d4" onChange={(v) => updateParam('scHpFreq', v)} displayVal={Math.round(params.scHpFreq)} />
        <CompressorKnob label="Lookahead" value={params.lookahead} min={0} max={0.005} factor={1000} suffix="ms" color="#06b6d4" onChange={(v) => updateParam('lookahead', v)} displayVal={(params.lookahead * 1000).toFixed(1)} />
        
        {/* Auto Makeup toggle */}
        <div className="flex flex-col items-center justify-center space-y-2">
          <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest">Auto Gain</span>
          <button
            onClick={() => updateParam('autoMakeup', !params.autoMakeup)}
            className={`w-14 h-7 rounded-full transition-all relative ${params.autoMakeup ? 'bg-cyan-500' : 'bg-white/10'}`}
          >
            <div className={`w-5 h-5 rounded-full bg-white absolute top-1 transition-all ${params.autoMakeup ? 'left-8' : 'left-1'}`} />
          </button>
        </div>
      </div>
    </div>
  );
};

const CompressorKnob: React.FC<{ 
  label: string;
  value: number;
  onChange: (v: number) => void;
  color: string;
  min: number;
  max: number;
  suffix: string;
  displayVal: string | number;
  factor?: number;
  disabled?: boolean;
}> = ({ label, value, onChange, color, min, max, suffix, displayVal, disabled }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const norm = (safeValue - min) / (max - min);
  const rotation = (norm * 270) - 135;

  const handleInteraction = (delta: number, startVal: number) => {
    if (disabled) return;
    const newVal = Math.max(min, Math.min(max, startVal + delta * (max - min)));
    if (Number.isFinite(newVal)) {
      onChange(newVal);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startVal = safeValue;
    const onMouseMove = (m: MouseEvent) => handleInteraction((startY - m.clientY) / 200, startVal);
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (disabled) return;
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startVal = safeValue;
    const onTouchMove = (t: TouchEvent) => {
      if (t.cancelable) t.preventDefault();
      handleInteraction((startY - t.touches[0].clientY) / 200, startVal);
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  return (
    <div className={`flex flex-col items-center space-y-2 group touch-none ${disabled ? 'opacity-40' : ''}`}>
      <div 
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className={`w-11 h-11 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center transition-all shadow-xl relative ${disabled ? 'cursor-not-allowed' : 'cursor-ns-resize hover:border-orange-500/50'}`}
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-4 -ml-0.5 -mt-4 origin-bottom rounded-full transition-transform duration-75" 
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color }} 
        />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5">
          <span className="text-[8px] font-mono font-bold text-white">{displayVal}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export default VocalCompressorUI;
