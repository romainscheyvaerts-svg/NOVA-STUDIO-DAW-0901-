
import React, { useEffect, useRef, useState } from 'react';

export interface ChorusParams {
  rate: number;       
  depth: number;      
  spread: number;     
  mix: number;        
  isEnabled: boolean;
}

export class ChorusNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private dryGain: GainNode;
  private wetGain: GainNode;
  private hpf: BiquadFilterNode;
  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  private delayL: DelayNode;
  private delayR: DelayNode;
  private lfoL: OscillatorNode;
  private lfoR: OscillatorNode;
  private depthL: GainNode;
  private depthR: GainNode;

  private params: ChorusParams = {
    rate: 1.2,
    depth: 0.35,
    spread: 0.8,
    mix: 0.4,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 150; 
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.delayL = ctx.createDelay(0.1);
    this.delayR = ctx.createDelay(0.1);
    this.lfoL = ctx.createOscillator();
    this.lfoR = ctx.createOscillator();
    this.depthL = ctx.createGain();
    this.depthR = ctx.createGain();
    this.setupGraph();
  }

  private setupGraph() {
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    this.input.connect(this.hpf);
    this.hpf.connect(this.splitter);
    
    this.splitter.connect(this.delayL, 0);
    this.lfoL.connect(this.depthL);
    this.depthL.connect(this.delayL.delayTime);
    this.delayL.connect(this.merger, 0, 0);
    
    this.splitter.connect(this.delayR, 1);
    this.splitter.connect(this.delayR, 0); 
    
    this.lfoR.connect(this.depthR);
    this.depthR.connect(this.delayR.delayTime);
    this.delayR.connect(this.merger, 0, 1);
    
    this.merger.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.lfoL.type = 'sine';
    this.lfoR.type = 'sine'; 
    this.lfoL.start();
    this.lfoR.start();
    this.applyParams();
  }

  public updateParams(p: Partial<ChorusParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number, d: number) => Number.isFinite(v) ? v : d;
    const { rate, depth, spread, mix, isEnabled } = this.params;

    if (isEnabled) {
      const sMix = safe(mix, 0.5);
      this.dryGain.gain.setTargetAtTime(1 - (sMix * 0.5), now, 0.02);
      this.wetGain.gain.setTargetAtTime(sMix, now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }

    const base = 0.015;
    this.delayL.delayTime.setTargetAtTime(base, now, 0.02);
    this.delayR.delayTime.setTargetAtTime(base, now, 0.02);

    const sRate = safe(rate, 1.0);
    this.lfoL.frequency.setTargetAtTime(sRate, now, 0.02);
    this.lfoR.frequency.setTargetAtTime(sRate, now, 0.02);

    const sDepth = safe(depth, 0.5);
    const depthVal = 0.002 * sDepth;
    this.depthL.gain.setTargetAtTime(depthVal, now, 0.02);
    
    const sSpread = safe(spread, 0.5);
    const rightPhaseMult = sSpread > 0.5 ? -1 : 1; 
    this.depthR.gain.setTargetAtTime(depthVal * rightPhaseMult, now, 0.02);
  }

  public getStatus() { return { ...this.params }; }
}

const ChorusKnob: React.FC<{ label: string, value: number, onChange: (v: number) => void, suffix?: string, factor?: number, defaultValue?: number }> = ({ label, value, onChange, suffix, factor = 1, defaultValue = 0.5 }) => {
  const safeValue = Number.isFinite(value) ? value : defaultValue || 0.5;
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY; const startValue = safeValue;
    const onMouseMove = (m: MouseEvent) => {
      const deltaY = (startY - m.clientY) / 200;
      onChange(Math.max(0, Math.min(1, startValue + deltaY)));
    };
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };
  const rotation = (safeValue * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-2 select-none group touch-none">
      <div onMouseDown={handleMouseDown} onDoubleClick={() => onChange(defaultValue || 0.5)} className="w-16 h-16 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-2 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: '#00f2ff', boxShadow: '0 0 10px #00f2ff' }} />
      </div>
      <div className="text-center"><span className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span><div className="bg-black/60 px-3 py-1 rounded-lg border border-white/5"><span className="text-[10px] font-mono font-bold text-cyan-400">{Math.round(safeValue * factor)}{suffix}</span></div></div>
    </div>
  );
};

export const VocalChorusUI: React.FC<{ node: ChorusNode, initialParams: ChorusParams, onParamsChange?: (p: ChorusParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const handleParamChange = (key: keyof ChorusParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };
  return (
    <div className="w-[520px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-6">
          <div className="w-16 h-16 rounded-[24px] bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5"><i className="fas fa-layer-group text-3xl"></i></div>
          <div><h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Dimension <span className="text-cyan-400">Chorus</span></h2><p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mt-2">Quadrature Phase Imager</p></div>
        </div>
        <button onClick={() => handleParamChange('isEnabled', !params.isEnabled)} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all border-2 ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}><i className="fas fa-power-off text-lg"></i></button>
      </div>
      <div className="grid grid-cols-4 gap-6">
        <ChorusKnob label="Rate" value={params.rate / 5} factor={5} suffix="Hz" onChange={v => handleParamChange('rate', v * 5)} defaultValue={0.24} />
        <ChorusKnob label="Depth" value={params.depth} factor={100} suffix="%" onChange={v => handleParamChange('depth', v)} defaultValue={0.35} />
        <ChorusKnob label="Spread" value={params.spread} factor={100} suffix="%" onChange={v => handleParamChange('spread', v)} defaultValue={0.5} />
        <ChorusKnob label="Mix" value={params.mix} factor={100} suffix="%" onChange={v => handleParamChange('mix', v)} defaultValue={0.4} />
      </div>
    </div>
  );
};
