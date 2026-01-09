
import React, { useEffect, useRef, useState } from 'react';
import { PluginParameter } from '../types';

export type DelayDivision = '1/4' | '1/8' | '1/8D' | '1/16' | '1/4T';

export interface DelayParams {
  division: DelayDivision;
  feedback: number;   
  damping: number;    
  mix: number;        
  pingPong: boolean;
  bpm: number;
  isEnabled: boolean;
}

const DIVISION_FACTORS: Record<DelayDivision, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8D': 0.75,
  '1/16': 0.25,
  '1/4T': 0.3333,
};

export class SyncDelayNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private delayNodeL: DelayNode;
  private delayNodeR: DelayNode;
  private feedbackGain: GainNode;
  private dampingFilter: BiquadFilterNode;
  private tapeSaturator: WaveShaperNode;
  private driftLFO: OscillatorNode;
  private driftGain: GainNode; 
  private panL: StereoPannerNode;
  private panR: StereoPannerNode;
  private wetGain: GainNode;
  private dryGain: GainNode;

  private params: DelayParams;

  constructor(ctx: AudioContext, initialBpm: number) {
    this.ctx = ctx;
    this.params = {
      division: '1/4',
      feedback: 0.4,
      damping: 5000,
      mix: 0.3,
      pingPong: false,
      bpm: initialBpm,
      isEnabled: true,
    };

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    this.delayNodeL = ctx.createDelay(4.0);
    this.delayNodeR = ctx.createDelay(4.0);
    this.feedbackGain = ctx.createGain();
    this.dampingFilter = ctx.createBiquadFilter();
    this.dampingFilter.type = 'lowpass';
    
    this.tapeSaturator = ctx.createWaveShaper();
    this.tapeSaturator.curve = this.makeDistortionCurve(50); 
    this.tapeSaturator.oversample = '4x';

    this.driftLFO = ctx.createOscillator();
    this.driftLFO.type = 'sine';
    this.driftLFO.frequency.value = 0.2; 
    this.driftGain = ctx.createGain();
    this.driftGain.gain.value = 0.0005; 
    this.driftLFO.connect(this.driftGain);
    this.driftLFO.start();

    this.panL = ctx.createStereoPanner();
    this.panR = ctx.createStereoPanner();
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();

    this.setupChain();
  }

  private makeDistortionCurve(amount: number) {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.delayNodeL);
    this.driftGain.connect(this.delayNodeL.delayTime);
    this.driftGain.connect(this.delayNodeR.delayTime);
    this.dampingFilter.connect(this.tapeSaturator);
    this.tapeSaturator.connect(this.feedbackGain);
    this.updateRouting();
    this.panL.connect(this.wetGain);
    this.panR.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.applyParams();
  }

  private updateRouting() {
    this.feedbackGain.disconnect();
    this.delayNodeL.disconnect();
    this.delayNodeR.disconnect();
    this.delayNodeL.connect(this.dampingFilter);

    if (this.params.pingPong) {
      this.feedbackGain.connect(this.delayNodeR);
      this.delayNodeR.connect(this.dampingFilter); 
      this.delayNodeL.connect(this.panL);
      this.delayNodeR.connect(this.panR);
      this.panL.pan.value = -0.8;
      this.panR.pan.value = 0.8;
    } else {
      this.feedbackGain.connect(this.delayNodeL);
      this.delayNodeL.connect(this.panL);
      this.delayNodeL.connect(this.panR);
      this.panL.pan.value = 0;
      this.panR.pan.value = 0;
    }
  }

  public updateParams(p: Partial<DelayParams>) {
    const oldPingPong = this.params.pingPong;
    this.params = { ...this.params, ...p };
    if (p.pingPong !== undefined && p.pingPong !== oldPingPong) {
      this.updateRouting();
    }
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const beatDuration = 60 / (this.params.bpm || 120);
    const delaySeconds = beatDuration * DIVISION_FACTORS[this.params.division];
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;

    if (this.params.isEnabled) {
      this.delayNodeL.delayTime.setTargetAtTime(delaySeconds, now, 0.05);
      this.delayNodeR.delayTime.setTargetAtTime(delaySeconds, now, 0.05);
      this.feedbackGain.gain.setTargetAtTime(safe(this.params.feedback, 0), now, 0.02);
      this.dampingFilter.frequency.setTargetAtTime(safe(this.params.damping, 5000), now, 0.02);
      const mix = safe(this.params.mix, 0);
      this.dryGain.gain.setTargetAtTime(1 - mix * 0.5, now, 0.02);
      this.wetGain.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public getParameters(): PluginParameter[] {
    return [
      { id: 'feedback', name: 'Feedback', type: 'float', min: 0, max: 0.95, value: this.params.feedback, unit: '%' },
      { id: 'mix', name: 'Dry/Wet', type: 'float', min: 0, max: 1, value: this.params.mix, unit: '%' },
      { id: 'damping', name: 'Damping', type: 'float', min: 100, max: 20000, value: this.params.damping, unit: 'Hz' }
    ];
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch (paramId) {
      case 'feedback': return this.feedbackGain.gain;
      case 'mix': return this.wetGain.gain;
      case 'damping': return this.dampingFilter.frequency;
      default: return null;
    }
  }

  public getParams() { return this.params; }
}

export const SyncDelayUI: React.FC<{ node: SyncDelayNode, initialParams: DelayParams, onParamsChange?: (p: DelayParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = (key: keyof DelayParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frameId = 0;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const beatDuration = 60 / params.bpm;
      const delayTime = beatDuration * DIVISION_FACTORS[params.division] * 1000;
      const progress = (Date.now() % delayTime) / delayTime;

      ctx.beginPath();
      ctx.strokeStyle = `rgba(0, 242, 255, ${1 - progress})`;
      ctx.lineWidth = 4;
      ctx.arc(w / 2, h / 2, progress * 40, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = params.isEnabled ? '#00f2ff' : '#334155';
      ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 5; i++) {
        const x = (w / 6) * i;
        const opacity = Math.pow(params.feedback, i);
        const flicker = 0.8 + Math.random() * 0.2; 
        ctx.fillStyle = `rgba(0, 242, 255, ${opacity * 0.3 * flicker})`;
        ctx.fillRect(x - 2, h / 2 - 10, 4, 20);
      }

      frameId = requestAnimationFrame(draw);
    };
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [params.bpm, params.division, params.feedback, params.isEnabled]);

  return (
    <div className="w-[550px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-history text-2xl"></i>
          </div>
          <div>
            <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Tape <span className="text-cyan-400">Delay</span></h2>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-2">Saturated Tape Echo Engine</p>
          </div>
        </div>
        
        <div className="flex space-x-3">
          <button 
            onClick={() => handleParamChange('pingPong', !params.pingPong)}
            className={`px-4 h-10 rounded-xl text-[9px] font-black uppercase transition-all border ${params.pingPong ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            Ping-Pong
          </button>
          <button 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <i className="fas fa-power-off"></i>
          </button>
        </div>
      </div>

      <div className="h-32 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <canvas ref={canvasRef} width={470} height={128} className="w-full h-full" />
        <div className="absolute bottom-4 right-6 text-[8px] font-mono text-cyan-500/40 uppercase tracking-[0.3em]">
          {params.bpm} BPM // {params.division} TAPE
        </div>
      </div>

      <div className="flex bg-black/40 p-1 rounded-2xl border border-white/5 justify-between">
        {(['1/4', '1/8', '1/8D', '1/16', '1/4T'] as DelayDivision[]).map(d => (
          <button 
            key={d}
            onClick={() => handleParamChange('division', d)}
            className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${params.division === d ? 'bg-white text-black shadow-lg shadow-white/10' : 'text-slate-500 hover:text-white'}`}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-8">
        <DelayKnob label="Feedback" value={params.feedback} min={0} max={0.95} factor={100} suffix="%" color="#00f2ff" onChange={v => handleParamChange('feedback', v)} />
        <DelayKnob label="Damping" value={params.damping} min={100} max={20000} log suffix="Hz" color="#00f2ff" onChange={v => handleParamChange('damping', v)} />
        <DelayKnob label="Dry/Wet" value={params.mix} min={0} max={1} factor={100} suffix="%" color="#fff" onChange={v => handleParamChange('mix', v)} />
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
