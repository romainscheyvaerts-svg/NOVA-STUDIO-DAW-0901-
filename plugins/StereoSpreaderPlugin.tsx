
import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface SpreaderParams {
  width: number;      // 0 to 2.0 (Side Gain)
  haasDelay: number;  // 0 to 0.03 (Seconds)
  lowBypass: number;  // 0 to 1 (Frequency mix below 200Hz)
  isEnabled: boolean;
}

export class StereoSpreaderNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  private midGain: GainNode;
  private sideGain: GainNode;
  private midSum: GainNode;
  private sideDiff: GainNode;
  private lpFilter: BiquadFilterNode;
  private hpFilter: BiquadFilterNode;
  private delayNode: DelayNode;
  public analyzerL: AnalyserNode;
  public analyzerR: AnalyserNode;

  private params: SpreaderParams = {
    width: 1.0,
    haasDelay: 0.015,
    lowBypass: 0.8,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.analyzerL = ctx.createAnalyser();
    this.analyzerR = ctx.createAnalyser();
    this.analyzerL.fftSize = 1024;
    this.analyzerR.fftSize = 1024;
    this.lpFilter = ctx.createBiquadFilter();
    this.hpFilter = ctx.createBiquadFilter();
    this.lpFilter.type = 'lowpass';
    this.lpFilter.frequency.value = 200;
    this.hpFilter.type = 'highpass';
    this.hpFilter.frequency.value = 200;
    this.delayNode = ctx.createDelay(0.1);
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.midSum = ctx.createGain();
    this.midSum.gain.value = 0.5;
    this.sideDiff = ctx.createGain();
    this.sideDiff.gain.value = 0.5;
    this.midGain = ctx.createGain();
    this.sideGain = ctx.createGain();
    this.setupChain();
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.lpFilter);
    this.lpFilter.connect(this.output); 
    this.input.connect(this.hpFilter);
    this.hpFilter.connect(this.splitter);
    this.splitter.connect(this.midSum, 0);
    this.splitter.connect(this.midSum, 1);
    const invR = this.ctx.createGain();
    invR.gain.value = -1;
    this.splitter.connect(this.sideDiff, 0);
    this.splitter.connect(invR, 1);
    invR.connect(this.sideDiff);
    this.midSum.connect(this.midGain);
    this.sideDiff.connect(this.sideGain);
    this.sideGain.connect(this.delayNode);
    const decL = this.ctx.createGain();
    const decR = this.ctx.createGain();
    const decInvSide = this.ctx.createGain();
    decInvSide.gain.value = -1;
    this.midGain.connect(decL);
    this.delayNode.connect(decL);
    this.midGain.connect(decR);
    this.delayNode.connect(decInvSide);
    decInvSide.connect(decR);
    this.merger.disconnect(); 
    decL.connect(this.merger, 0, 0);
    decR.connect(this.merger, 0, 1);
    this.merger.connect(this.output);
    const splitOut = this.ctx.createChannelSplitter(2);
    this.output.connect(splitOut);
    splitOut.connect(this.analyzerL, 0);
    splitOut.connect(this.analyzerR, 1);
    this.applyParams();
  }

  public updateParams(p: Partial<SpreaderParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    const width = safe(this.params.width, 1.0);
    const haas = safe(this.params.haasDelay, 0.0);

    if (this.params.isEnabled) {
      this.sideGain.gain.setTargetAtTime(width, now, 0.02);
      this.delayNode.delayTime.setTargetAtTime(haas, now, 0.02);
    } else {
      this.sideGain.gain.setTargetAtTime(1.0, now, 0.02);
      this.delayNode.delayTime.setTargetAtTime(0, now, 0.02);
    }
  }

  public getStatus() { return { ...this.params }; }
}

const SpreaderKnob: React.FC<{ label: string, value: number, onChange: (v: number) => void, factor: number, suffix: string, color: string }> = ({ label, value, onChange, factor, suffix, color }) => {
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
  return (
    <div className="flex flex-col items-center space-y-3 group touch-none select-none">
      <div onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} className="relative w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 10px ${color}` }} />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1.5">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">{Math.round(safeValue * factor)}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export const StereoSpreaderUI: React.FC<{ node: StereoSpreaderNode, initialParams: SpreaderParams, onParamsChange?: (p: SpreaderParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<SpreaderParams>(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width; const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h);
    ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
    ctx.stroke();
    const dataL = new Float32Array(node.analyzerL.fftSize);
    const dataR = new Float32Array(node.analyzerR.fftSize);
    node.analyzerL.getFloatTimeDomainData(dataL);
    node.analyzerR.getFloatTimeDomainData(dataR);
    ctx.beginPath();
    ctx.strokeStyle = '#00f2ff';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    const scale = w * 0.4;
    for (let i = 0; i < dataL.length; i += 2) {
      const L = dataL[i];
      const R = dataR[i];
      const x = (L - R) * 0.707 * scale;
      const y = (L + R) * 0.707 * scale;
      const px = w/2 + x;
      const py = h/2 - y;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }, [node]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => { draw(); animFrame = requestAnimationFrame(update); };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const updateParam = (key: keyof SpreaderParams, val: any) => {
      const newParams = { ...params, [key]: val };
      setParams(newParams);
      node.updateParams(newParams);
      if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[500px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-arrows-alt-h text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Stereo <span className="text-cyan-400">Spreader</span></h2>
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">Psychoacoustic Imager v1.0</p>
          </div>
        </div>
        <button 
          onClick={() => updateParam('isEnabled', !params.isEnabled)}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>
      <div className="h-48 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <canvas ref={canvasRef} width={420} height={192} className="w-full h-full opacity-80" />
        <div className="absolute top-4 left-6 text-[7px] font-black text-slate-700 uppercase tracking-[0.4em]">Vectorscope Analysis</div>
        <div className="absolute inset-x-0 bottom-4 flex justify-between px-10 text-[6px] font-black text-slate-800 uppercase">
          <span>Left Phase</span>
          <span>Mono Center</span>
          <span>Right Phase</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6">
        <SpreaderKnob label="Stereo Width" value={params.width / 2} factor={200} suffix="%" onChange={(v) => updateParam('width', v * 2)} color="#00f2ff" />
        <SpreaderKnob label="Haas Delay" value={params.haasDelay / 0.03} factor={30} suffix="ms" onChange={(v) => updateParam('haasDelay', v * 0.03)} color="#00f2ff" />
        <SpreaderKnob label="Low Bypass" value={params.lowBypass} factor={100} suffix="%" onChange={(v) => updateParam('lowBypass', v)} color="#fff" />
      </div>
      <div className="pt-6 border-t border-white/5 flex justify-between items-center text-slate-700">
         <div className="flex flex-col">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Processing</span>
            <span className="text-[9px] font-black text-slate-400 uppercase">Mid/Side Subtraction</span>
         </div>
         <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-cyan-500 shadow-[0_0_10px_#00f2ff]' : 'bg-slate-800'}`} />
            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">PhaseGuard™ Active</span>
         </div>
      </div>
    </div>
  );
};
