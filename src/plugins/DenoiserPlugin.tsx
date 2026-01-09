
import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface DenoiserParams {
  threshold: number;   
  reduction: number;   
  release: number;     
  isEnabled: boolean;
}

export class DenoiserNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private sideChainFilter: BiquadFilterNode;
  private analyzer: AnalyserNode;
  private gainNode: GainNode;
  private processor: ScriptProcessorNode;

  private params: DenoiserParams = {
    threshold: -45,
    reduction: 0.8,
    release: 0.15,
    isEnabled: true
  };

  private currentGain: number = 1.0;
  private noiseLevel: number = -100;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.gainNode = ctx.createGain();
    this.sideChainFilter = ctx.createBiquadFilter();
    this.sideChainFilter.type = 'highpass';
    this.sideChainFilter.frequency.value = 1000; 
    this.analyzer = ctx.createAnalyser();
    this.analyzer.fftSize = 512;
    this.processor = ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => this.process(e);
    this.setupChain();
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.gainNode);
    this.gainNode.connect(this.output);
    this.input.connect(this.sideChainFilter);
    this.sideChainFilter.connect(this.analyzer);
    this.sideChainFilter.connect(this.processor);
    this.processor.connect(this.ctx.destination); 
  }

  private process(e: AudioProcessingEvent) {
    const input = e.inputBuffer.getChannelData(0);
    if (!this.params.isEnabled) {
      this.gainNode.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.01);
      this.currentGain = 1.0;
      return;
    }
    
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    this.noiseLevel = db;
    
    let targetGain = 1.0;
    if (db < this.params.threshold) {
      const diff = this.params.threshold - db;
      targetGain = Math.max(0.01, 1.0 - (this.params.reduction * (diff / 20))); 
    }
    
    const timeConstant = targetGain < this.currentGain ? 0.005 : this.params.release;
    const alpha = 1 - Math.exp(-input.length / (this.ctx.sampleRate * timeConstant));
    this.currentGain += (targetGain - this.currentGain) * alpha;
    
    this.gainNode.gain.setTargetAtTime(this.currentGain, this.ctx.currentTime, 0.01);
  }

  public updateParams(p: Partial<DenoiserParams>) { this.params = { ...this.params, ...p }; }
  public getStatus() { return { reduction: this.currentGain, noiseLevel: this.noiseLevel, isActive: this.currentGain < 0.95 }; }
  public getParams() { return { ...this.params }; }
}

interface VocalDenoiserUIProps {
  node: DenoiserNode;
  initialParams: DenoiserParams;
  onParamsChange?: (p: DenoiserParams) => void;
  trackId?: string;
  pluginId?: string;
}

export const VocalDenoiserUI: React.FC<VocalDenoiserUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<DenoiserParams>(initialParams);
  const [status, setStatus] = useState({ reduction: 1.0, noiseLevel: -60, isActive: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof DenoiserParams | null>(null);
  const paramsRef = useRef(initialParams);

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

  const togglePower = () => {
      const newVal = !params.isEnabled;
      const newParams = { ...params, isEnabled: newVal };
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
        <button onClick={togglePower} className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-teal-500 border-teal-400 text-black shadow-lg shadow-teal-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}><i className="fas fa-power-off"></i></button>
      </div>
      <div className="h-32 bg-black/60 rounded-[28px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <canvas ref={canvasRef} width={320} height={128} className="w-full h-full opacity-80" />
      </div>
      <div className="grid grid-cols-3 gap-4 px-2">
        <DenoiserKnob label="Threshold" value={params.threshold} min={-60} max={-10} suffix="dB" color="#14b8a6" onMouseDown={(e) => handleMouseDown('threshold', e)} displayVal={Math.round(params.threshold)} />
        <DenoiserKnob label="Reduction" value={params.reduction} min={0} max={1.0} factor={100} suffix="%" color="#14b8a6" onMouseDown={(e) => handleMouseDown('reduction', e)} displayVal={Math.round(params.reduction * 100)} />
        <DenoiserKnob label="Release" value={params.release} min={0.01} max={1.0} factor={1000} suffix="ms" color="#fff" onMouseDown={(e) => handleMouseDown('release', e)} displayVal={Math.round(params.release * 1000)} />
      </div>
    </div>
  );
};

const DenoiserKnob: React.FC<{ label: string, value: number, onMouseDown: (e: React.MouseEvent) => void, color: string, min: number, max: number, suffix: string, displayVal: number, factor?: number }> = ({ label, value, onMouseDown, color, min, max, suffix, displayVal }) => {
  const norm = (value - min) / (max - min);
  const rotation = (norm * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-2 group">
      <div onMouseDown={onMouseDown} className="w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-teal-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 8px ${color}66` }} />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center"><span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span><div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[45px]"><span className="text-[8px] font-mono font-bold text-white">{displayVal}{suffix}</span></div></div>
    </div>
  );
};
