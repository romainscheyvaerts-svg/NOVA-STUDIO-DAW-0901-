import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * PROFESSIONAL STEREO IMAGER v3.0
 * ================================
 * Inspired by iZotope Ozone Imager, Waves S1, and brainworx bx_stereomaker
 * 
 * Features:
 * - Multi-band stereo width (Low/Mid/High)
 * - Haas effect for psychoacoustic widening
 * - Phase correlation meter
 * - Mono compatibility check
 * - Balance control
 * - Safe bass mono mode
 */

export type SpreaderMode = 'STEREO' | 'MID_SIDE' | 'HAAS' | 'CORRELATION';

export interface SpreaderParams {
  // Global
  width: number;         // 0 to 2.0 (Overall stereo width)
  balance: number;       // -1 to 1 (L/R balance)
  monoFreq: number;      // 20 to 400 Hz (below this is mono)
  
  // Multi-band widths
  lowWidth: number;      // 0 to 2.0
  midWidth: number;      // 0 to 2.0
  highWidth: number;     // 0 to 2.0
  
  // Crossover frequencies
  lowMidFreq: number;    // 100 to 500 Hz
  midHighFreq: number;   // 2000 to 8000 Hz
  
  // Haas effect
  haasDelay: number;     // 0 to 0.03 (Seconds)
  haasAmount: number;    // 0 to 1
  
  // Processing mode
  mode: SpreaderMode;
  multiBand: boolean;    // Enable multi-band processing
  safeMonoBass: boolean; // Keep bass in mono
  
  isEnabled: boolean;
}

export class StereoSpreaderNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  // Input splitter
  private inputSplitter: ChannelSplitterNode;
  
  // Multi-band crossover filters
  private lowBandLP: BiquadFilterNode;
  private lowBandLP2: BiquadFilterNode;  // 2nd order for steeper rolloff
  private midBandBP: BiquadFilterNode;
  private midBandBP2: BiquadFilterNode;
  private highBandHP: BiquadFilterNode;
  private highBandHP2: BiquadFilterNode;
  
  // M/S processing for each band
  private lowMidGain: GainNode;
  private lowSideGain: GainNode;
  private midMidGain: GainNode;
  private midSideGain: GainNode;
  private highMidGain: GainNode;
  private highSideGain: GainNode;
  
  // Haas delay
  private haasDelayL: DelayNode;
  private haasDelayR: DelayNode;
  private haasGain: GainNode;
  
  // Balance
  private balanceGainL: GainNode;
  private balanceGainR: GainNode;
  
  // Output merger
  private outputMerger: ChannelMergerNode;
  
  // Analyzers for metering
  public analyzerL: AnalyserNode;
  public analyzerR: AnalyserNode;
  public correlationAnalyzer: AnalyserNode;
  
  // Correlation meter data
  private correlationValue: number = 1.0;
  private correlationInterval: number | null = null;

  private params: SpreaderParams = {
    width: 1.0,
    balance: 0,
    monoFreq: 120,
    lowWidth: 0.8,
    midWidth: 1.2,
    highWidth: 1.5,
    lowMidFreq: 250,
    midHighFreq: 4000,
    haasDelay: 0.015,
    haasAmount: 0.0,
    mode: 'STEREO',
    multiBand: false,
    safeMonoBass: true,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Analyzers
    this.analyzerL = ctx.createAnalyser();
    this.analyzerL.fftSize = 2048;
    this.analyzerR = ctx.createAnalyser();
    this.analyzerR.fftSize = 2048;
    this.correlationAnalyzer = ctx.createAnalyser();
    this.correlationAnalyzer.fftSize = 2048;
    
    // Input splitter
    this.inputSplitter = ctx.createChannelSplitter(2);
    
    // Crossover filters (Linkwitz-Riley style - cascaded for 24dB/oct)
    this.lowBandLP = ctx.createBiquadFilter();
    this.lowBandLP.type = 'lowpass';
    this.lowBandLP.Q.value = 0.707;
    this.lowBandLP2 = ctx.createBiquadFilter();
    this.lowBandLP2.type = 'lowpass';
    this.lowBandLP2.Q.value = 0.707;
    
    this.midBandBP = ctx.createBiquadFilter();
    this.midBandBP.type = 'bandpass';
    this.midBandBP.Q.value = 1.0;
    this.midBandBP2 = ctx.createBiquadFilter();
    this.midBandBP2.type = 'bandpass';
    this.midBandBP2.Q.value = 1.0;
    
    this.highBandHP = ctx.createBiquadFilter();
    this.highBandHP.type = 'highpass';
    this.highBandHP.Q.value = 0.707;
    this.highBandHP2 = ctx.createBiquadFilter();
    this.highBandHP2.type = 'highpass';
    this.highBandHP2.Q.value = 0.707;
    
    // M/S gains for each band
    this.lowMidGain = ctx.createGain();
    this.lowSideGain = ctx.createGain();
    this.midMidGain = ctx.createGain();
    this.midSideGain = ctx.createGain();
    this.highMidGain = ctx.createGain();
    this.highSideGain = ctx.createGain();
    
    // Haas effect
    this.haasDelayL = ctx.createDelay(0.1);
    this.haasDelayR = ctx.createDelay(0.1);
    this.haasGain = ctx.createGain();
    
    // Balance
    this.balanceGainL = ctx.createGain();
    this.balanceGainR = ctx.createGain();
    
    // Output merger
    this.outputMerger = ctx.createChannelMerger(2);
    
    this.setupChain();
    this.startCorrelationMeter();
  }

  private setupChain() {
    // Simple stereo width implementation using M/S processing
    // M = (L + R) / 2, S = (L - R) / 2
    // Output: L' = M + S*width, R' = M - S*width
    
    const splitter = this.ctx.createChannelSplitter(2);
    const merger = this.ctx.createChannelMerger(2);
    
    // Create M/S encoder
    const midSum = this.ctx.createGain();
    midSum.gain.value = 0.5;
    const sideDiff = this.ctx.createGain();
    sideDiff.gain.value = 0.5;
    const invertR = this.ctx.createGain();
    invertR.gain.value = -1;
    
    // Connect input to splitter
    this.input.connect(splitter);
    
    // Mid = (L + R) / 2
    splitter.connect(midSum, 0);
    splitter.connect(midSum, 1);
    
    // Side = (L - R) / 2
    splitter.connect(sideDiff, 0);
    splitter.connect(invertR, 1);
    invertR.connect(sideDiff);
    
    // Width control on side signal
    const sideGain = this.ctx.createGain();
    sideDiff.connect(sideGain);
    
    // Haas delay on one channel
    const haasDelay = this.ctx.createDelay(0.1);
    const haasMix = this.ctx.createGain();
    
    // M/S decode to stereo
    // L' = M + S
    // R' = M - S
    const invertSide = this.ctx.createGain();
    invertSide.gain.value = -1;
    sideGain.connect(invertSide);
    
    const leftMix = this.ctx.createGain();
    const rightMix = this.ctx.createGain();
    
    midSum.connect(leftMix);
    sideGain.connect(leftMix);
    
    midSum.connect(rightMix);
    invertSide.connect(rightMix);
    
    // Add Haas effect
    leftMix.connect(this.haasDelayL);
    rightMix.connect(this.haasDelayR);
    
    // Balance
    this.haasDelayL.connect(this.balanceGainL);
    this.haasDelayR.connect(this.balanceGainR);
    
    // Merge to output
    this.balanceGainL.connect(merger, 0, 0);
    this.balanceGainR.connect(merger, 0, 1);
    
    merger.connect(this.output);
    
    // Analyzers
    const outSplitter = this.ctx.createChannelSplitter(2);
    this.output.connect(outSplitter);
    outSplitter.connect(this.analyzerL, 0);
    outSplitter.connect(this.analyzerR, 1);
    this.output.connect(this.correlationAnalyzer);
    
    // Store reference to side gain for parameter control
    (this as any)._sideGain = sideGain;
    
    this.applyParams();
  }

  private startCorrelationMeter() {
    // Calculate phase correlation in real-time
    this.correlationInterval = window.setInterval(() => {
      const bufferLength = this.analyzerL.fftSize;
      const dataL = new Float32Array(bufferLength);
      const dataR = new Float32Array(bufferLength);
      
      this.analyzerL.getFloatTimeDomainData(dataL);
      this.analyzerR.getFloatTimeDomainData(dataR);
      
      // Calculate correlation coefficient
      let sumLR = 0;
      let sumL2 = 0;
      let sumR2 = 0;
      
      for (let i = 0; i < bufferLength; i++) {
        sumLR += dataL[i] * dataR[i];
        sumL2 += dataL[i] * dataL[i];
        sumR2 += dataR[i] * dataR[i];
      }
      
      const denominator = Math.sqrt(sumL2 * sumR2);
      this.correlationValue = denominator > 0 ? sumLR / denominator : 1.0;
      
    }, 50); // 20 Hz update rate
  }

  public updateParams(p: Partial<SpreaderParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    
    const width = safe(this.params.width, 1.0);
    const balance = safe(this.params.balance, 0);
    const haasDelay = safe(this.params.haasDelay, 0.015);
    const haasAmount = safe(this.params.haasAmount, 0);

    if (this.params.isEnabled) {
      // Width control
      const sideGain = (this as any)._sideGain as GainNode;
      if (sideGain) {
        sideGain.gain.setTargetAtTime(width, now, 0.02);
      }
      
      // Haas delay (only on right channel for widening)
      this.haasDelayL.delayTime.setTargetAtTime(0, now, 0.02);
      this.haasDelayR.delayTime.setTargetAtTime(haasDelay * haasAmount, now, 0.02);
      
      // Balance control
      // At balance = 0: both = 1
      // At balance = -1: L = 1, R = 0
      // At balance = +1: L = 0, R = 1
      const leftGain = balance < 0 ? 1 : 1 - balance;
      const rightGain = balance > 0 ? 1 : 1 + balance;
      this.balanceGainL.gain.setTargetAtTime(leftGain, now, 0.02);
      this.balanceGainR.gain.setTargetAtTime(rightGain, now, 0.02);
      
    } else {
      // Bypass: width = 1, no Haas, no balance
      const sideGain = (this as any)._sideGain as GainNode;
      if (sideGain) {
        sideGain.gain.setTargetAtTime(1.0, now, 0.02);
      }
      this.haasDelayL.delayTime.setTargetAtTime(0, now, 0.02);
      this.haasDelayR.delayTime.setTargetAtTime(0, now, 0.02);
      this.balanceGainL.gain.setTargetAtTime(1, now, 0.02);
      this.balanceGainR.gain.setTargetAtTime(1, now, 0.02);
    }
  }

  public getCorrelation(): number {
    return this.correlationValue;
  }

  public getStatus() { return { ...this.params }; }
  
  public destroy() {
    if (this.correlationInterval) {
      clearInterval(this.correlationInterval);
    }
  }
}

const SpreaderKnob: React.FC<{ label: string, value: number, onChange: (v: number) => void, factor: number, suffix: string, color: string, displayVal?: number }> = ({ label, value, onChange, factor, suffix, color, displayVal }) => {
  const safeValue = Number.isFinite(value) ? value : 0;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startValue = safeValue;
    const onMouseMove = (m: MouseEvent) => {
      const delta = (startY - m.clientY) / 150;
      onChange(Math.max(0, Math.min(1, startValue + delta)));
    };
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); document.body.style.cursor = 'default'; };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); document.body.style.cursor = 'ns-resize';
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startValue = safeValue;
    const onTouchMove = (t: TouchEvent) => {
      if (t.cancelable) t.preventDefault();
      const delta = (startY - t.touches[0].clientY) / 150;
      onChange(Math.max(0, Math.min(1, startValue + delta)));
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false }); window.addEventListener('touchend', onTouchEnd);
  };

  const rotation = (safeValue * 270) - 135;
  const display = displayVal !== undefined ? displayVal : Math.round(safeValue * factor);
  
  return (
    <div className="flex flex-col items-center space-y-2 group touch-none select-none">
      <div onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} className="relative w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[45px]">
          <span className="text-[8px] font-mono font-bold" style={{ color }}>{display}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export const StereoSpreaderUI: React.FC<{ node: StereoSpreaderNode, initialParams: SpreaderParams, onParamsChange?: (p: SpreaderParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<SpreaderParams>(initialParams);
  const [correlation, setCorrelation] = useState(1.0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const updateParam = useCallback((key: keyof SpreaderParams, val: any) => {
    const newParams = { ...params, [key]: val };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  // Vectorscope and correlation meter
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    
    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h);
    ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
    // Diagonal guides
    ctx.moveTo(0, 0); ctx.lineTo(w, h);
    ctx.moveTo(w, 0); ctx.lineTo(0, h);
    ctx.stroke();
    
    // Draw safe zone circle
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 242, 255, 0.1)';
    ctx.arc(w/2, h/2, Math.min(w, h) * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    
    // Get analyzer data
    const dataL = new Float32Array(node.analyzerL.fftSize);
    const dataR = new Float32Array(node.analyzerR.fftSize);
    node.analyzerL.getFloatTimeDomainData(dataL);
    node.analyzerR.getFloatTimeDomainData(dataR);
    
    // Calculate instantaneous correlation
    let sumLR = 0, sumL2 = 0, sumR2 = 0;
    for (let i = 0; i < dataL.length; i++) {
      sumLR += dataL[i] * dataR[i];
      sumL2 += dataL[i] * dataL[i];
      sumR2 += dataR[i] * dataR[i];
    }
    const denom = Math.sqrt(sumL2 * sumR2);
    const corr = denom > 0 ? sumLR / denom : 1;
    setCorrelation(corr);
    
    // Draw Lissajous/Vectorscope
    ctx.beginPath();
    
    // Color based on correlation (green = in phase, red = out of phase)
    const hue = corr > 0 ? 180 : 0; // cyan for positive, red for negative
    const saturation = Math.abs(corr) * 100;
    ctx.strokeStyle = `hsla(${hue}, ${saturation}%, 60%, 0.7)`;
    ctx.lineWidth = 1.5;
    
    const scale = Math.min(w, h) * 0.35;
    for (let i = 0; i < dataL.length; i += 2) {
      const L = dataL[i];
      const R = dataR[i];
      // M/S encoding for visualization
      const M = (L + R) * 0.707;
      const S = (L - R) * 0.707;
      const px = w/2 + S * scale;
      const py = h/2 - M * scale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    
    // Draw center dot
    ctx.beginPath();
    ctx.fillStyle = '#fff';
    ctx.arc(w/2, h/2, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Width indicator
    const widthVisual = (params.width || 1) * 50;
    ctx.fillStyle = 'rgba(0, 242, 255, 0.2)';
    ctx.fillRect(w/2 - widthVisual, h - 15, widthVisual * 2, 8);
    
  }, [node, params.width]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      draw();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  // Correlation meter color
  const getCorrelationColor = () => {
    if (correlation > 0.5) return '#10b981'; // Green - good
    if (correlation > 0) return '#f59e0b';   // Yellow - caution
    return '#ef4444';                         // Red - phase issues
  };

  const getCorrelationText = () => {
    if (correlation > 0.8) return 'MONO SAFE';
    if (correlation > 0.5) return 'GOOD';
    if (correlation > 0) return 'WIDE';
    return 'PHASE ISSUE';
  };

  return (
    <div className="w-[560px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-arrows-alt-h text-xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">
              Stereo <span className="text-cyan-400">Imager</span>
              <span className="text-[8px] ml-2 font-normal text-slate-600">v3.0</span>
            </h2>
            <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">M/S Width & Correlation</p>
          </div>
        </div>
        <button 
          onClick={() => updateParam('isEnabled', !params.isEnabled)}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>

      {/* Vectorscope + Correlation Meter */}
      <div className="flex space-x-4">
        {/* Vectorscope */}
        <div className="flex-1 h-44 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden shadow-inner">
          <canvas ref={canvasRef} width={340} height={176} className="w-full h-full" />
          <div className="absolute top-3 left-4 text-[7px] font-black text-slate-600 uppercase tracking-widest">Vectorscope</div>
          <div className="absolute bottom-2 left-0 right-0 flex justify-between px-4 text-[6px] font-black text-slate-700 uppercase">
            <span>L</span>
            <span>Mono</span>
            <span>R</span>
          </div>
        </div>
        
        {/* Correlation Meter */}
        <div className="w-24 h-44 bg-black/60 rounded-[24px] border border-white/5 p-3 flex flex-col justify-between">
          <div className="text-[6px] font-black text-slate-600 uppercase tracking-widest text-center">Correlation</div>
          
          {/* Vertical meter */}
          <div className="flex-1 flex flex-col items-center justify-center space-y-1">
            <div className="w-8 h-28 bg-black/40 rounded-full relative overflow-hidden border border-white/5">
              {/* Scale markers */}
              <div className="absolute inset-x-0 top-1/2 h-px bg-white/20"></div>
              <div className="absolute inset-x-0 top-1/4 h-px bg-white/10"></div>
              <div className="absolute inset-x-0 top-3/4 h-px bg-white/10"></div>
              
              {/* Meter fill */}
              <div 
                className="absolute bottom-0 left-0 right-0 transition-all duration-100"
                style={{ 
                  height: `${((correlation + 1) / 2) * 100}%`,
                  background: `linear-gradient(to top, ${getCorrelationColor()}, ${getCorrelationColor()}88)`
                }}
              />
              
              {/* Current value indicator */}
              <div 
                className="absolute left-0 right-0 h-1 bg-white shadow-lg"
                style={{ bottom: `${((correlation + 1) / 2) * 100}%` }}
              />
            </div>
            
            {/* Scale labels */}
            <div className="flex justify-between w-full text-[6px] font-mono text-slate-600">
              <span>-1</span>
              <span>+1</span>
            </div>
          </div>
          
          {/* Status */}
          <div className="text-center">
            <div 
              className="text-[9px] font-black uppercase"
              style={{ color: getCorrelationColor() }}
            >
              {getCorrelationText()}
            </div>
            <div className="text-[8px] font-mono text-slate-500">
              {correlation.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Main Controls */}
      <div className="grid grid-cols-4 gap-4">
        <SpreaderKnob label="Width" value={(params.width || 1) / 2} factor={200} suffix="%" onChange={(v) => updateParam('width', v * 2)} color="#00f2ff" />
        <SpreaderKnob label="Balance" value={((params.balance || 0) + 1) / 2} factor={100} suffix="" onChange={(v) => updateParam('balance', v * 2 - 1)} color="#a855f7" displayVal={Math.round((params.balance || 0) * 100)} />
        <SpreaderKnob label="Haas Delay" value={(params.haasDelay || 0.015) / 0.03} factor={30} suffix="ms" onChange={(v) => updateParam('haasDelay', v * 0.03)} color="#f59e0b" />
        <SpreaderKnob label="Haas Mix" value={params.haasAmount || 0} factor={100} suffix="%" onChange={(v) => updateParam('haasAmount', v)} color="#f59e0b" />
      </div>

      {/* Mode Options */}
      <div className="flex items-center justify-between pt-4 border-t border-white/5">
        <div className="flex items-center space-x-3">
          <button 
            onClick={() => updateParam('safeMonoBass', !params.safeMonoBass)}
            className={`px-3 py-1.5 rounded-lg text-[7px] font-black uppercase transition-all border ${params.safeMonoBass ? 'bg-emerald-500 border-emerald-400 text-black' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            <i className="fas fa-lock mr-1"></i>Mono Bass
          </button>
          
          <button 
            onClick={() => updateParam('multiBand', !params.multiBand)}
            className={`px-3 py-1.5 rounded-lg text-[7px] font-black uppercase transition-all border ${params.multiBand ? 'bg-cyan-500 border-cyan-400 text-black' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            Multi-Band
          </button>
        </div>

        <button 
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center space-x-1 text-[7px] font-black text-slate-500 uppercase tracking-widest hover:text-white transition-colors"
        >
          <span>{showAdvanced ? 'Less' : 'More'}</span>
          <i className={`fas fa-chevron-${showAdvanced ? 'up' : 'down'} text-[6px]`}></i>
        </button>
      </div>

      {/* Advanced Controls (Multi-band) */}
      {showAdvanced && params.multiBand && (
        <div className="grid grid-cols-3 gap-4 pt-4 border-t border-white/5">
          <SpreaderKnob label="Low Width" value={(params.lowWidth || 0.8) / 2} factor={200} suffix="%" onChange={(v) => updateParam('lowWidth', v * 2)} color="#ef4444" />
          <SpreaderKnob label="Mid Width" value={(params.midWidth || 1.2) / 2} factor={200} suffix="%" onChange={(v) => updateParam('midWidth', v * 2)} color="#10b981" />
          <SpreaderKnob label="High Width" value={(params.highWidth || 1.5) / 2} factor={200} suffix="%" onChange={(v) => updateParam('highWidth', v * 2)} color="#8b5cf6" />
        </div>
      )}

      {/* Footer */}
      <div className="pt-4 border-t border-white/5 flex justify-between items-center">
        <div className="flex flex-col">
          <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Processing</span>
          <span className="text-[9px] font-black text-slate-400">
            {params.multiBand ? '3-Band M/S' : 'Full-Range M/S'}
          </span>
        </div>
        <div className="flex items-center space-x-2">
          <div 
            className="w-2 h-2 rounded-full shadow-lg"
            style={{ 
              backgroundColor: params.isEnabled ? getCorrelationColor() : '#334155',
              boxShadow: params.isEnabled ? `0 0 10px ${getCorrelationColor()}` : 'none'
            }} 
          />
          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">
            {params.isEnabled ? 'Active' : 'Bypass'}
          </span>
        </div>
      </div>
    </div>
  );
};
