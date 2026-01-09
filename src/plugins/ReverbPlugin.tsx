
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PluginParameter } from '../types';

export type ReverbMode = 'ROOM' | 'HALL' | 'PLATE' | 'CATHEDRAL';

export interface ReverbParams {
  decay: number;      
  preDelay: number;   
  damping: number;    
  mix: number;        
  size: number;       
  mode: ReverbMode;
  isEnabled: boolean;
  name?: string;
}

export const REVERB_PRESETS = [
  { name: "Studio Booth", decay: 0.4, preDelay: 0.010, damping: 6000, size: 0.2, mix: 0.15, mode: 'ROOM' as ReverbMode },
  { name: "Modern Vocal Plate", decay: 1.4, preDelay: 0.025, damping: 12000, size: 0.6, mix: 0.20, mode: 'PLATE' as ReverbMode },
  { name: "Small Warm Room", decay: 0.8, preDelay: 0.015, damping: 4000, size: 0.3, mix: 0.18, mode: 'ROOM' as ReverbMode },
  { name: "Large Hall", decay: 2.8, preDelay: 0.040, damping: 8000, size: 0.9, mix: 0.25, mode: 'HALL' as ReverbMode },
  { name: "Cathedral", decay: 5.0, preDelay: 0.060, damping: 5000, size: 1.0, mix: 0.35, mode: 'CATHEDRAL' as ReverbMode },
];

export class ReverbNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private preDelayNode: DelayNode;
  private convolver: ConvolverNode;
  private dampingFilter: BiquadFilterNode;
  private inputFilter: BiquadFilterNode; 
  private wetGain: GainNode;
  private dryGain: GainNode;
  
  private params: ReverbParams = {
    decay: 2.5,
    preDelay: 0.02,
    damping: 12000,
    mix: 0.3,
    size: 0.7,
    mode: 'HALL',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    this.preDelayNode = ctx.createDelay(1.0);
    this.convolver = ctx.createConvolver();
    this.dampingFilter = ctx.createBiquadFilter();
    this.dampingFilter.type = 'lowpass';
    this.inputFilter = ctx.createBiquadFilter();
    this.inputFilter.type = 'highpass';
    this.inputFilter.frequency.value = 150; 

    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();

    this.setupChain();
    this.updateImpulseResponse();
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.inputFilter);
    this.inputFilter.connect(this.preDelayNode);
    this.preDelayNode.connect(this.convolver);
    this.convolver.connect(this.dampingFilter);
    this.dampingFilter.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.updateRouting();
  }

  private updateRouting() {
    const now = this.ctx.currentTime;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    if (this.params.isEnabled) {
      const mix = safe(this.params.mix);
      this.dryGain.gain.setTargetAtTime(1 - (mix * 0.5), now, 0.02);
      this.wetGain.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public updateParams(p: Partial<ReverbParams>) {
    const oldDecay = this.params.decay;
    const oldSize = this.params.size;
    const oldMode = this.params.mode;
    this.params = { ...this.params, ...p };
    
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;

    this.preDelayNode.delayTime.setTargetAtTime(safe(this.params.preDelay, 0.02), now, 0.02);
    this.dampingFilter.frequency.setTargetAtTime(safe(this.params.damping, 12000), now, 0.02);
    
    this.updateRouting();

    if (this.params.decay !== oldDecay || this.params.size !== oldSize || this.params.mode !== oldMode) {
      this.updateImpulseResponse();
    }
  }

  private updateImpulseResponse() {
    const sampleRate = this.ctx.sampleRate;
    const duration = this.params.decay;
    const length = sampleRate * duration;
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let density = this.params.size * 2000; 
    if (this.params.mode === 'PLATE') density *= 2; 
    if (this.params.mode === 'ROOM') density *= 0.5; 

    const decayConstant = this.params.mode === 'CATHEDRAL' ? 4 : (this.params.mode === 'PLATE' ? 6 : 8);

    for (let c = 0; c < 2; c++) {
      const channel = c === 0 ? left : right;
      let k = 0;
      while (k < length) {
        const step = Math.round(sampleRate / density * (0.5 + Math.random())); 
        if (k + step >= length) break;
        k += step;
        const time = k / sampleRate;
        const envelope = Math.pow(1 - time / duration, decayConstant);
        const sign = Math.random() > 0.5 ? 1 : -1;
        const spread = c === 0 ? 1 : (0.9 + Math.random() * 0.2);
        channel[k] = sign * envelope * spread * 0.8;
      }
    }
    this.convolver.buffer = buffer;
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch (paramId) {
      case 'mix': return this.wetGain.gain;
      case 'preDelay': return this.preDelayNode.delayTime;
      case 'damping': return this.dampingFilter.frequency;
      default: return null;
    }
  }

  public getParameters(): PluginParameter[] {
    return [
      { id: 'mix', name: 'Wet Level', type: 'float', min: 0, max: 1, value: this.params.mix, unit: '%' },
      { id: 'preDelay', name: 'Pre-Delay', type: 'float', min: 0, max: 0.2, value: this.params.preDelay, unit: 's' },
      { id: 'damping', name: 'Damping', type: 'float', min: 100, max: 20000, value: this.params.damping, unit: 'Hz' }
    ];
  }

  public getParams() { return this.params; }
}

export const ProfessionalReverbUI: React.FC<{ 
  node: ReverbNode, 
  initialParams: ReverbParams, 
  onParamsChange?: (p: ReverbParams) => void,
  trackId?: string,
  pluginId?: string
}> = ({ node, initialParams, onParamsChange, trackId, pluginId }) => {
  const [params, setParams] = useState(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = (key: keyof ReverbParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const loadPreset = (index: number) => {
    const preset = REVERB_PRESETS[index];
    const newParams = { ...params, ...preset };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    let animId = 0;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath();
      for(let x=0; x<w; x+=30) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      ctx.stroke();

      ctx.beginPath();
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.moveTo(0, h - 20);
      
      const duration = params.decay;
      const displayTime = 6; 
      
      for(let x=0; x<w; x++) {
        const t = (x / w) * displayTime;
        if (t > duration) break;
        const envelope = Math.pow(1 - t / duration, 4);
        const noise = (Math.random() * 0.15 * envelope);
        const y = (h - 20) - ((envelope + noise) * (h - 40));
        ctx.lineTo(x, y);
      }
      ctx.stroke();

      const preDelayX = (params.preDelay / displayTime) * w;
      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); 
      ctx.moveTo(preDelayX, 0); 
      ctx.lineTo(preDelayX, h); 
      ctx.stroke();
      ctx.setLineDash([]);
      
      animId = requestAnimationFrame(draw);
    };
    
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [params.decay, params.preDelay]);

  return (
    <div className="w-[600px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/20">
            <i className="fas fa-mountain-sun text-2xl"></i>
          </div>
          <div>
            <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Spatial <span className="text-indigo-400">Verb</span></h2>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-2">Velvet Noise Engine v2.0</p>
          </div>
        </div>
        
        <div className="flex flex-col space-y-3 items-end">
           <div className="flex bg-black/40 p-1 rounded-2xl border border-white/5">
            {(['ROOM', 'HALL', 'PLATE', 'CATHEDRAL'] as ReverbMode[]).map(m => (
              <button 
                key={m}
                onClick={() => handleParamChange('mode', m)}
                className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase transition-all ${params.mode === m ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-500 hover:text-white'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="w-full">
            <select 
              value={REVERB_PRESETS.findIndex(p => p.name === params.name)}
              onChange={(e) => loadPreset(parseInt(e.target.value))}
              className="w-full bg-[#14161a] border border-white/10 rounded-xl p-2 text-[10px] font-black text-white hover:border-indigo-500 focus:border-indigo-500 outline-none appearance-none transition-all cursor-pointer text-center"
            >
              <option disabled value="-1">— VOICE PRESETS —</option>
              {REVERB_PRESETS.map((p, i) => (
                <option key={i} value={i}>{p.name.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="h-44 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden group shadow-inner">
        <canvas ref={canvasRef} width={520} height={176} className="w-full h-full opacity-80 group-hover:opacity-100 transition-opacity" />
      </div>

      <div className="grid grid-cols-5 gap-6">
        <ReverbKnob label="Decay" paramId="decay" trackId={trackId} pluginId={pluginId} value={params.decay} min={0.1} max={10} suffix="s" color="#6366f1" onChange={v => handleParamChange('decay', v)} />
        <ReverbKnob label="Pre-Delay" paramId="preDelay" trackId={trackId} pluginId={pluginId} value={params.preDelay} min={0} max={0.2} factor={1000} suffix="ms" color="#6366f1" onChange={v => handleParamChange('preDelay', v)} />
        <ReverbKnob label="Damping" paramId="damping" trackId={trackId} pluginId={pluginId} value={params.damping} min={100} max={20000} log suffix="Hz" color="#6366f1" onChange={v => handleParamChange('damping', v)} />
        <ReverbKnob label="Diffusion" paramId="size" trackId={trackId} pluginId={pluginId} value={params.size} min={0} max={1} factor={100} suffix="%" color="#6366f1" onChange={v => handleParamChange('size', v)} />
        <ReverbKnob label="Dry/Wet" paramId="mix" trackId={trackId} pluginId={pluginId} value={params.mix} min={0} max={1} factor={100} suffix="%" color="#00f2ff" onChange={v => handleParamChange('mix', v)} />
      </div>

      <div className="pt-8 border-t border-white/5 flex justify-between items-center">
        <button 
          onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
          className={`h-12 px-8 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border ${params.isEnabled ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg shadow-indigo-500/20' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          {params.isEnabled ? 'Effect Active' : 'Bypass'}
        </button>
      </div>
    </div>
  );
};

const ReverbKnob: React.FC<{ 
  label: string, value: number, min: number, max: number, 
  onChange: (v: number) => void, suffix: string, color: string, 
  log?: boolean, factor?: number,
  trackId?: string, pluginId?: string, paramId?: string
}> = ({ label, value, min, max, onChange, suffix, color, log, factor = 1 }) => {
  const safeVal = Number.isFinite(value) ? value : min;
  const norm = log 
    ? (Math.log10(safeVal / min) / Math.log10(max / min)) 
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
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'ns-resize';
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

  return (
    <div className="flex flex-col items-center space-y-3 select-none touch-none">
      <div 
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="relative w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-indigo-500/50 transition-all shadow-xl group"
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
            {Math.round(safeVal * factor * 10) / 10}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};
