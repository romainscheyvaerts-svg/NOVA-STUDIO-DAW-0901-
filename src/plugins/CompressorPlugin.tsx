
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PluginParameter } from '../types';

export interface CompressorParams {
  threshold: number;   
  ratio: number;       
  knee: number;        
  attack: number;      
  release: number;     
  makeupGain: number;  
  isEnabled: boolean;
}

export class CompressorNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  public compressor: DynamicsCompressorNode;
  private makeupGainNode: GainNode;
  private softClipper: WaveShaperNode;

  private params: CompressorParams = {
    threshold: -24,
    ratio: 4,
    knee: 12,
    attack: 0.003,
    release: 0.25,
    makeupGain: 1.0,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    this.makeupGainNode = ctx.createGain();
    
    this.softClipper = ctx.createWaveShaper();
    this.softClipper.curve = this.makeSoftClipCurve(20);
    this.softClipper.oversample = '4x';

    this.input.connect(this.compressor);
    this.compressor.connect(this.softClipper);
    this.softClipper.connect(this.makeupGainNode);
    this.makeupGainNode.connect(this.output);

    this.applyParams();
  }

  private makeSoftClipCurve(amount: number) {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = Math.tanh(x); 
    }
    return curve;
  }

  public updateParams(p: Partial<CompressorParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (val: number, def: number) => Number.isFinite(val) ? val : def;

    if (this.params.isEnabled) {
      this.compressor.threshold.setTargetAtTime(safe(this.params.threshold, -24), now, 0.01);
      this.compressor.ratio.setTargetAtTime(safe(this.params.ratio, 4), now, 0.01);
      this.compressor.knee.setTargetAtTime(safe(this.params.knee, 12), now, 0.01);
      this.compressor.attack.setTargetAtTime(safe(this.params.attack, 0.003), now, 0.01);
      this.compressor.release.setTargetAtTime(safe(this.params.release, 0.25), now, 0.01);
      this.makeupGainNode.gain.setTargetAtTime(safe(this.params.makeupGain, 1.0), now, 0.01);
    } else {
      this.compressor.threshold.setTargetAtTime(0, now, 0.01);
      this.compressor.ratio.setTargetAtTime(1, now, 0.01);
      this.makeupGainNode.gain.setTargetAtTime(1.0, now, 0.01);
    }
  }

  public getReduction(): number {
    return this.compressor.reduction;
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch(paramId) {
        case 'threshold': return this.compressor.threshold;
        case 'ratio': return this.compressor.ratio;
        case 'knee': return this.compressor.knee;
        case 'attack': return this.compressor.attack;
        case 'release': return this.compressor.release;
        case 'makeupGain': return this.makeupGainNode.gain;
        default: return null;
    }
  }

  public getParameters(): PluginParameter[] {
    return [
        { id: 'threshold', name: 'Threshold', type: 'float', min: -60, max: 0, value: this.params.threshold, unit: 'dB' },
        { id: 'ratio', name: 'Ratio', type: 'float', min: 1, max: 20, value: this.params.ratio, unit: ':1' },
        { id: 'makeupGain', name: 'Makeup', type: 'float', min: 0, max: 2, value: this.params.makeupGain, unit: 'x' }
    ];
  }

  public getParams() { return { ...this.params }; }
}

interface VocalCompressorUIProps {
  node: CompressorNode;
  initialParams: CompressorParams;
  onParamsChange?: (p: CompressorParams) => void;
}

export const VocalCompressorUI: React.FC<VocalCompressorUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<CompressorParams>(initialParams);
  const [reduction, setReduction] = useState(0);
  const curveCanvasRef = useRef<HTMLCanvasElement>(null);
  const meterCanvasRef = useRef<HTMLCanvasElement>(null);

  const drawCurve = useCallback(() => {
    const canvas = curveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const { threshold, ratio, knee } = params;

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for(let i=0; i<=4; i++) {
      const x = (i/4) * w;
      const y = (i/4) * h;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    ctx.beginPath();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#f9731644';

    for(let i=0; i<=w; i++) {
      const inputDb = (i/w) * 60 - 60;
      let outputDb = inputDb;

      if (inputDb > threshold + knee/2) {
        outputDb = threshold + (inputDb - threshold) / ratio;
      } else if (inputDb > threshold - knee/2) {
        const t = (inputDb - (threshold - knee/2)) / knee;
        outputDb = inputDb + (1/ratio - 1) * knee * t * t / 2;
      }

      const x = i;
      const y = h - ((outputDb + 60) / 60) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [params]);

  const drawMeter = useCallback(() => {
    const canvas = meterCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const redDb = Math.abs(reduction);
    const meterHeight = Math.min(h, (redDb / 20) * h);

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f97316';
    ctx.fillRect(0, 0, w, meterHeight);
  }, [reduction]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      setReduction(node.getReduction());
      drawCurve();
      drawMeter();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node, drawCurve, drawMeter]);

  const updateParam = (key: keyof CompressorParams, value: number) => {
      const newParams = { ...params, [key]: value };
      setParams(newParams);
      node.updateParams(newParams);
      if (onParamsChange) onParamsChange(newParams);
  };

  const togglePower = () => {
    const isEnabled = !params.isEnabled;
    const newParams = { ...params, isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[500px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-orange-500/10 flex items-center justify-center text-orange-500 border border-orange-500/20 shadow-lg shadow-orange-500/5">
            <i className="fas fa-compress-alt text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Leveler <span className="text-orange-500">Pro</span></h2>
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">VCA Dynamics Processor</p>
          </div>
        </div>
        <button 
          onClick={togglePower}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-orange-500 border-orange-400 text-black shadow-lg shadow-orange-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>

      <div className="flex space-x-4 h-44">
        <div className="flex-1 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden shadow-inner">
          <canvas ref={curveCanvasRef} width={360} height={176} className="w-full h-full opacity-80" />
          <div className="absolute top-4 left-6 text-[7px] font-black text-slate-600 uppercase tracking-widest">Transfer Curve</div>
        </div>
        <div className="w-12 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden shadow-inner flex flex-col items-center py-4">
           <span className="text-[6px] font-black text-slate-600 uppercase mb-2">GR</span>
           <canvas ref={meterCanvasRef} width={24} height={120} className="w-6 flex-1 rounded-full" />
           <span className="text-[7px] font-mono text-orange-500 mt-2">{Math.round(reduction)}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
         <CompressorKnob label="Threshold" value={params.threshold} min={-60} max={0} suffix="dB" color="#f97316" onChange={(v) => updateParam('threshold', v)} displayVal={Math.round(params.threshold)} />
         <CompressorKnob label="Ratio" value={params.ratio} min={1} max={20} suffix=":1" color="#f97316" onChange={(v) => updateParam('ratio', v)} displayVal={Math.round(params.ratio)} />
         <CompressorKnob label="Knee" value={params.knee} min={0} max={40} suffix="dB" color="#f97316" onChange={(v) => updateParam('knee', v)} displayVal={Math.round(params.knee)} />
         <CompressorKnob label="Attack" value={params.attack} min={0.0001} max={0.1} factor={1000} suffix="ms" color="#fff" onChange={(v) => updateParam('attack', v)} displayVal={Math.round(params.attack * 1000)} />
         <CompressorKnob label="Release" value={params.release} min={0.01} max={1.0} factor={1000} suffix="ms" color="#fff" onChange={(v) => updateParam('release', v)} displayVal={Math.round(params.release * 1000)} />
         <CompressorKnob label="Makeup" value={params.makeupGain} min={0} max={2} factor={100} suffix="%" color="#fff" onChange={(v) => updateParam('makeupGain', v)} displayVal={Math.round(params.makeupGain * 100)} />
      </div>
    </div>
  );
};

const CompressorKnob: React.FC<{ 
  label: string, value: number, onChange: (v: number) => void, color: string, min: number, max: number, suffix: string, displayVal: number, factor?: number 
}> = ({ label, value, onChange, color, min, max, suffix, displayVal }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const norm = (safeValue - min) / (max - min);
  const rotation = (norm * 270) - 135;

  const handleInteraction = (delta: number, startVal: number) => {
      const newVal = Math.max(min, Math.min(max, startVal + delta * (max - min)));
      if (Number.isFinite(newVal)) {
          onChange(newVal);
      }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startVal = safeValue;
    const onMouseMove = (m: MouseEvent) => handleInteraction((startY - m.clientY) / 200, startVal);
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
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
    <div className="flex flex-col items-center space-y-2 group touch-none">
      <div 
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-orange-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" 
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
