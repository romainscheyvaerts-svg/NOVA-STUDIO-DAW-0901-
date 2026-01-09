
import React, { useEffect, useRef, useState } from 'react';

export interface FlangerParams {
  rate: number;       
  depth: number;      
  feedback: number;   
  manual: number;     
  mix: number;        
  invertPhase: boolean;
  isEnabled: boolean;
}

export class FlangerNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private delayNode: DelayNode;
  private lfo: OscillatorNode;
  private depthGain: GainNode;
  private feedbackGain: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;

  private params: FlangerParams = {
    rate: 0.5,
    depth: 0.5,
    feedback: 0.7,
    manual: 0.3,
    mix: 0.5,
    invertPhase: false,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delayNode = ctx.createDelay(0.1);
    this.lfo = ctx.createOscillator();
    this.depthGain = ctx.createGain();
    this.feedbackGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.setupGraph();
  }

  private setupGraph() {
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.delayNode);
    this.delayNode.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.delayNode.connect(this.feedbackGain);
    this.feedbackGain.connect(this.delayNode);
    this.lfo.type = 'sine';
    this.lfo.connect(this.depthGain);
    this.depthGain.connect(this.delayNode.delayTime);
    this.lfo.start();
    this.applyParams();
  }

  public updateParams(p: Partial<FlangerParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safeNum = (val: number, def: number) => Number.isFinite(val) ? val : def;
    const { rate, depth, feedback, manual, mix, invertPhase, isEnabled } = this.params;
    if (isEnabled) {
      const baseDelay = 0.001 + (manual * 0.014);
      this.delayNode.delayTime.setTargetAtTime(baseDelay, now, 0.03);
      this.lfo.frequency.setTargetAtTime(rate, now, 0.03);
      this.depthGain.gain.setTargetAtTime(0.005 * depth, now, 0.03);
      const fbValue = invertPhase ? -feedback : feedback;
      this.feedbackGain.gain.setTargetAtTime(fbValue, now, 0.03);
      this.dryGain.gain.setTargetAtTime(1 - mix * 0.5, now, 0.02);
      this.wetGain.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
      this.feedbackGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public getStatus() { return { ...this.params }; }
}

const FlangerKnob: React.FC<{ label: string, value: number, onChange: (v: number) => void, suffix?: string, factor?: number, defaultValue?: number }> = ({ label, value, onChange, suffix, factor = 1, defaultValue = 0.5 }) => {
  const safeValue = Number.isFinite(value) ? value : defaultValue || 0;
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY; const startValue = safeValue;
    const onMouseMove = (m: MouseEvent) => onChange(Math.max(0, Math.min(1, startValue + (startY - m.clientY) / 200)));
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); document.body.style.cursor = 'default'; };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'ns-resize';
  };
  const rotation = (safeValue * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-2 select-none touch-none group">
      <div onMouseDown={handleMouseDown} onDoubleClick={() => onChange(defaultValue || 0.5)} className="w-14 h-14 rounded-full bg-[#111318] border-2 border-white/5 flex items-center justify-center cursor-ns-resize hover:border-blue-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40" />
        <div className="absolute top-1/2 left-1/2 w-1.5 h-5 -ml-0.75 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: '#3b82f6', boxShadow: '0 0 8px #3b82f6' }} />
      </div>
      <div className="text-center"><span className="block text-[7px] font-black text-slate-600 uppercase tracking-widest mb-1">{label}</span><div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5"><span className="text-[9px] font-mono font-bold text-blue-400">{Math.round(safeValue * factor)}{suffix}</span></div></div>
    </div>
  );
};

export const StudioFlangerUI: React.FC<{ node: FlangerNode, initialParams: FlangerParams, onParamsChange?: (p: FlangerParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const handleParamChange = (key: keyof FlangerParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };
  return (
    <div className="w-[480px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20 shadow-lg shadow-blue-500/5"><i className="fas fa-wind text-2xl"></i></div>
          <div><h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Studio <span className="text-blue-400">Flanger</span></h2><p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">High-Feedback Jet Engine</p></div>
        </div>
        <div className="flex items-center space-x-4">
          <button onClick={() => handleParamChange('invertPhase', !params.invertPhase)} className={`px-3 py-2 rounded-xl text-[8px] font-black uppercase transition-all border ${params.invertPhase ? 'bg-blue-500 text-black' : 'bg-white/5 border-white/10 text-slate-500'}`}>Phase Inv</button>
          <button onClick={() => handleParamChange('isEnabled', !params.isEnabled)} className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-blue-500 border-blue-400 text-black shadow-lg shadow-blue-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}><i className="fas fa-power-off"></i></button>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-4">
        <FlangerKnob label="Rate" value={params.rate / 10} factor={10} suffix="Hz" onChange={v => handleParamChange('rate', v * 10)} defaultValue={0.05} />
        <FlangerKnob label="Depth" value={params.depth} factor={100} suffix="%" onChange={v => handleParamChange('depth', v)} defaultValue={0.5} />
        <FlangerKnob label="Feedback" value={params.feedback} factor={90} suffix="%" onChange={v => handleParamChange('feedback', v)} defaultValue={0.7} />
        <FlangerKnob label="Manual" value={params.manual} factor={15} suffix="ms" onChange={v => handleParamChange('manual', v)} defaultValue={0.3} />
        <FlangerKnob label="Mix" value={params.mix} factor={100} suffix="%" onChange={v => handleParamChange('mix', v)} defaultValue={0.5} />
      </div>
    </div>
  );
};
