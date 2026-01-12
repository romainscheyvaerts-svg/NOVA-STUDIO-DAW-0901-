import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * DENOISER PRO - Professional Noise Gate/Expander
 * Inspired by Ableton Gate, UAD Precision, Softube
 * Uses AnalyserNode-based detection (no deprecated ScriptProcessorNode)
 */

export interface DenoiserParams {
  threshold: number;    // -60 to 0 dB
  range: number;        // -80 to 0 dB (how much reduction when closed)
  attack: number;       // 0.0001 to 0.1 s (0.1ms to 100ms)
  hold: number;         // 0 to 0.5 s
  release: number;      // 0.01 to 2.0 s
  scFreq: number;       // Sidechain filter freq 20-20000 Hz
  flip: boolean;        // Flip/Duck mode
  isEnabled: boolean;
  // FIX: Add missing 'reduction' property
  reduction: number;
}

const DENOISER_PRESETS = [
  { name: "Gentle Denoise", threshold: -45, range: -20, attack: 0.005, hold: 0.05, release: 0.15, scFreq: 1000, flip: false },
  { name: "Vocal Gate", threshold: -35, range: -80, attack: 0.001, hold: 0.02, release: 0.1, scFreq: 800, flip: false },
  { name: "Drum Gate", threshold: -25, range: -80, attack: 0.0001, hold: 0.01, release: 0.05, scFreq: 100, flip: false },
  { name: "Broadcast", threshold: -40, range: -30, attack: 0.01, hold: 0.1, release: 0.3, scFreq: 2000, flip: false },
  { name: "Ducking", threshold: -30, range: -12, attack: 0.005, hold: 0.05, release: 0.2, scFreq: 1000, flip: true },
];

export class DenoiserNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private gainNode: GainNode;
  private sideChainFilter: BiquadFilterNode;
  private analyzer: AnalyserNode;
  private processingInterval: number | null = null;
  private timeDomainData: Uint8Array;

  private params: DenoiserParams = {
    threshold: -40,
    range: -40,
    attack: 0.005,
    hold: 0.05,
    release: 0.15,
    scFreq: 1000,
    flip: false,
    isEnabled: true,
    // FIX: Provide a default value for the new 'reduction' property
    reduction: 0.8,
  };

  private currentGain: number = 1.0;
  private noiseLevel: number = -100;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    
    // Create nodes
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.gainNode = ctx.createGain();
    
    // Sidechain path
    this.sideChainFilter = ctx.createBiquadFilter();
    this.sideChainFilter.type = 'highpass';
    this.sideChainFilter.frequency.value = this.params.scFreq;
    this.sideChainFilter.Q.value = 0.7;
    
    // Analyzer for level detection
    this.analyzer = ctx.createAnalyser();
    this.analyzer.fftSize = 2048;
    this.analyzer.smoothingTimeConstant = 0.8;
    this.timeDomainData = new Uint8Array(this.analyzer.frequencyBinCount);
    
    this.setupChain();
    this.startProcessing();
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.gainNode);
    this.gainNode.connect(this.output);
    
    this.input.connect(this.sideChainFilter);
    this.sideChainFilter.connect(this.analyzer);
  }

  private startProcessing() {
    // Use setInterval instead of deprecated ScriptProcessorNode
    this.processingInterval = window.setInterval(() => this.process(), 20);
  }

  private process() {
    if (!this.params.isEnabled) {
      this.gainNode.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
      this.currentGain = 1.0;
      return;
    }
    
    // Get audio data from analyzer
    this.analyzer.getByteTimeDomainData(this.timeDomainData);
    
    // Calculate RMS from time domain data
    let sum = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      const normalized = (this.timeDomainData[i] - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / this.timeDomainData.length);
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    this.noiseLevel = db;
    
    let targetGain = 1.0;
    if (db < this.params.threshold) {
      const diff = this.params.threshold - db;
      targetGain = Math.max(0.01, 1.0 - (this.params.reduction * (diff / 20))); 
    }
    
    const timeConstant = targetGain < this.currentGain ? this.params.attack : this.params.release;
    const alpha = 1 - Math.exp(-0.02 / timeConstant);
    this.currentGain += (targetGain - this.currentGain) * alpha;
    
    this.gainNode.gain.setTargetAtTime(this.currentGain, this.ctx.currentTime, 0.02);
  }

  public updateParams(p: Partial<DenoiserParams>) {
    this.params = { ...this.params, ...p };
    this.sideChainFilter.frequency.setTargetAtTime(this.params.scFreq, this.ctx.currentTime, 0.02);
  }

  public getStatus() {
    return { reduction: this.currentGain, noiseLevel: this.noiseLevel, isActive: this.currentGain < 0.95 };
  }

  public getParams() { return { ...this.params }; }

  public dispose() {
    if (this.processingInterval !== null) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    try {
      this.input.disconnect();
      this.gainNode.disconnect();
      this.sideChainFilter.disconnect();
      this.analyzer.disconnect();
    } catch(e) {}
  }
}

// ============== UI COMPONENT ==============

interface VocalDenoiserUIProps {
  node: DenoiserNode;
  initialParams: DenoiserParams;
  onParamsChange?: (p: DenoiserParams) => void;
}

export const VocalDenoiserUI: React.FC<VocalDenoiserUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<DenoiserParams>(initialParams);
  const [status, setStatus] = useState({ reduction: 1.0, noiseLevel: -60, isActive: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof DenoiserParams | null>(null);
  const paramsRef = useRef(params);

  useEffect(() => { paramsRef.current = params; }, [params]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    
    const threshY = h - ((params.threshold + 60) / 60) * h; 
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const levelY = h - ((status.noiseLevel + 60) / 60) * h;
    const clampedLevelY = Math.max(0, Math.min(h, levelY));
    
    ctx.fillStyle = status.isActive ? '#ef4444' : '#10b981';
    ctx.fillRect(w/2 - 10, clampedLevelY, 20, h - clampedLevelY);
    
    if (status.reduction < 1.0) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
        ctx.fillRect(0, 0, w, (1 - status.reduction) * h);
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.fillText(`GR: -${(20 * Math.log10(1/status.reduction)).toFixed(1)}dB`, 5, 15);
    }
  }, [params.threshold, status]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      setStatus(node.getStatus());
      draw();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node, draw]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 200;
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    if (typeof currentVal !== 'number') return;
    let min = 0, max = 1;
    if (activeParam.current === 'threshold') { min = -60; max = -10; }
    if (activeParam.current === 'release') { min = 0.01; max = 1.0; }
    if (activeParam.current === 'reduction') { min = 0; max = 1.0; }
    const newVal = Math.max(min, Math.min(max, currentVal + delta * (max - min)));
    const newParams = { ...currentParams, [activeParam.current!]: newVal };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [node, onParamsChange]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
    document.body.style.cursor = 'default';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleMouseDown = (param: keyof DenoiserParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const updateParam = (key: keyof DenoiserParams, value: number | boolean) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[400px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-teal-500/10 flex items-center justify-center text-teal-400 border border-teal-500/20 shadow-lg shadow-teal-500/5"><i className="fas fa-broom text-xl"></i></div>
          <div><h2 className="text-lg font-black italic text-white uppercase tracking-tighter leading-none">Denoiser <span className="text-teal-400">X</span></h2><p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Adaptive Noise Gate</p></div>
        </div>
        <button onClick={() => updateParam('isEnabled', !params.isEnabled)} className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-teal-500 text-black border-teal-400 shadow-lg shadow-teal-500/30' : 'bg-white/5 border-white/10 text-slate-600'}`}><i className="fas fa-power-off"></i></button>
      </div>
      <div className="h-32 bg-black/60 rounded-[28px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <canvas ref={canvasRef} width={320} height={128} className="w-full h-full opacity-80" />
      </div>
      <div className="grid grid-cols-3 gap-4 px-2">
        <ProKnob label="Threshold" value={params.threshold} min={-60} max={-10} suffix="dB" color="#14b8a6" onMouseDown={(e) => handleMouseDown('threshold', e)} displayVal={Math.round(params.threshold)} />
        <ProKnob label="Reduction" value={params.reduction} min={0} max={1.0} factor={100} suffix="%" color="#14b8a6" onMouseDown={(e) => handleMouseDown('reduction', e)} displayVal={Math.round(params.reduction * 100)} />
        <ProKnob label="Release" value={params.release} min={0.01} max={1.0} factor={1000} suffix="ms" color="#fff" onMouseDown={(e) => handleMouseDown('release', e)} displayVal={Math.round(params.release * 1000)} />
      </div>
    </div>
  );
};

// ============== PRO KNOB COMPONENT ==============

const ProKnob: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix: string;
  color: string;
  factor?: number;
  log?: boolean;
}> = ({ label, value, min, max, onChange, suffix, color, factor = 1, log = false }) => {
  const safeVal = Number.isFinite(value) ? value : min;
  const norm = log
    ? Math.log10(safeVal / min) / Math.log10(max / min)
    : (safeVal - min) / (max - min);
  const rotation = (Math.max(0, Math.min(1, norm)) * 270) - 135;

  const calculateValue = (delta: number, startNorm: number) => {
    const newNorm = Math.max(0, Math.min(1, startNorm + delta / 200));
    return log ? min * Math.pow(max / min, newNorm) : min + newNorm * (max - min);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startNorm = norm;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newVal = calculateValue(startY - moveEvent.clientY, startNorm);
      onChange(newVal);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'ns-resize';
  };

  const displayVal = log ? Math.round(safeVal) : Math.round(safeVal * factor);

  return (
    <div className="flex flex-col items-center space-y-2">
      <div
        onMouseDown={handleMouseDown}
        className="w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-teal-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75"
          style={{
            backgroundColor: color,
            boxShadow: `0 0 12px ${color}44`,
            transform: `rotate(${rotation}deg) translateY(2px)`
          }}
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-600 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">{displayVal}{suffix}</span>
        </div>
      </div>
    </div>
  );
};
