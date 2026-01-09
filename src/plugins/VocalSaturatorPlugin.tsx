
import React, { useState, useEffect, useRef, useCallback } from 'react';

export type SaturationMode = 'TUBE' | 'TAPE' | 'TRANSISTOR' | 'SOFT_CLIP';

export interface SaturatorParams {
  drive: number;      
  mix: number;        
  tone: number;       
  eqLow: number;      
  eqMid: number;      
  eqHigh: number;     
  mode: SaturationMode;
  isEnabled: boolean;
  outputGain: number; // Added to interface to match usage
}

export class VocalSaturatorNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private driveGain: GainNode;
  private shaper: WaveShaperNode;
  private autoGain: GainNode;
  private tiltLow: BiquadFilterNode;
  private tiltHigh: BiquadFilterNode;
  private eqLowNode: BiquadFilterNode;
  private eqMidNode: BiquadFilterNode;
  private eqHighNode: BiquadFilterNode;
  private wetGain: GainNode;
  private dryGain: GainNode;
  private makeupGain: GainNode;

  private params: SaturatorParams = {
    drive: 20,
    mix: 0.5,
    tone: 0.0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    mode: 'TAPE',
    isEnabled: true,
    outputGain: 1.0
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.driveGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.autoGain = ctx.createGain();
    this.tiltLow = ctx.createBiquadFilter();
    this.tiltLow.type = 'lowshelf';
    this.tiltLow.frequency.value = 800;
    this.tiltHigh = ctx.createBiquadFilter();
    this.tiltHigh.type = 'highshelf';
    this.tiltHigh.frequency.value = 800;
    this.eqLowNode = ctx.createBiquadFilter();
    this.eqLowNode.type = 'lowshelf';
    this.eqLowNode.frequency.value = 200;
    this.eqMidNode = ctx.createBiquadFilter();
    this.eqMidNode.type = 'peaking';
    this.eqMidNode.frequency.value = 1500;
    this.eqMidNode.Q.value = 1.0;
    this.eqHighNode = ctx.createBiquadFilter();
    this.eqHighNode.type = 'highshelf';
    this.eqHighNode.frequency.value = 8000;
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.makeupGain = ctx.createGain();
    this.setupChain();
    this.generateCurve();
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.driveGain);
    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.autoGain);
    this.autoGain.connect(this.tiltLow);
    this.tiltLow.connect(this.tiltHigh);
    this.tiltHigh.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighNode);
    this.eqHighNode.connect(this.wetGain);
    this.wetGain.connect(this.makeupGain);
    this.makeupGain.connect(this.output);
    this.applyParams();
  }

  public updateParams(p: Partial<SaturatorParams>) {
    const needNewCurve = p.mode !== undefined || p.drive !== undefined;
    this.params = { ...this.params, ...p };
    if (needNewCurve) this.generateCurve();
    this.applyParams();
  }

  private generateCurve() {
    const n = 4096;
    const curve = new Float32Array(n);
    const safeDrive = Number.isFinite(this.params.drive) ? this.params.drive : 20;
    const drive = 1 + (safeDrive / 10);
    const mode = this.params.mode;
    for (let i = 0; i < n; i++) {
      let x = (i * 2) / n - 1;
      if (mode === 'TAPE') curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
      else if (mode === 'TUBE') {
        if (x < 0) curve[i] = (Math.exp(x * drive * 0.5) - 1) / (Math.exp(drive * 0.5) - 1);
        else curve[i] = (x + 0.2) / (1.2) * (1 - Math.exp(-x * drive));
      } 
      else if (mode === 'TRANSISTOR') curve[i] = (2 / Math.PI) * Math.atan(drive * 2 * x);
      else curve[i] = (1.5 * x * drive) * (1 - (x * drive * x * drive) / 3);
    }
    this.shaper.curve = curve;
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    const { drive, mix, tone, eqLow, eqMid, eqHigh, isEnabled, outputGain } = this.params;
    if (isEnabled) {
      const sDrive = safe(drive);
      this.driveGain.gain.setTargetAtTime(1 + (sDrive / 25), now, 0.02);
      this.autoGain.gain.setTargetAtTime(1 / (1 + (sDrive / 60)), now, 0.02);
      const sTone = safe(tone);
      this.tiltHigh.gain.setTargetAtTime(sTone * 12, now, 0.02);
      this.tiltLow.gain.setTargetAtTime(-sTone * 12, now, 0.02);
      this.eqLowNode.gain.setTargetAtTime(safe(eqLow), now, 0.02);
      this.eqMidNode.gain.setTargetAtTime(safe(eqMid), now, 0.02);
      this.eqHighNode.gain.setTargetAtTime(safe(eqHigh), now, 0.02);
      const sMix = safe(mix);
      this.dryGain.gain.setTargetAtTime(1 - sMix, now, 0.02);
      this.wetGain.gain.setTargetAtTime(sMix, now, 0.02);
      this.makeupGain.gain.setTargetAtTime(safe(outputGain), now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public getParams() { return { ...this.params }; }
}

export const VocalSaturatorUI: React.FC<{ node: VocalSaturatorNode, initialParams: SaturatorParams, onParamsChange?: (p: SaturatorParams) => void, trackId?: string, pluginId?: string }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<SaturatorParams>(initialParams);
  const paramsRef = useRef<SaturatorParams>(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof SaturatorParams | null>(null);

  useEffect(() => { paramsRef.current = params; }, [params]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width; const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
    ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#10b98144';
    const drive = 1 + (params.drive / 10);
    const mode = params.mode;
    for(let i=0; i<w; i++) {
      let x = (i/w) * 2 - 1;
      let y = 0;
      if (mode === 'TAPE') y = Math.tanh(x * drive) / Math.tanh(drive);
      else if (mode === 'TUBE') {
        if (x < 0) y = (Math.exp(x * drive * 0.5) - 1) / (Math.exp(drive * 0.5) - 1);
        else y = (x + 0.2) / (1.2) * (1 - Math.exp(-x * drive));
      }
      else if (mode === 'TRANSISTOR') y = (2/Math.PI) * Math.atan(drive * 2 * x);
      else y = (1.5 * x * drive) * (1 - (x * drive * x * drive) / 3);
      const py = h/2 - (y * h/2.5);
      if (i === 0) ctx.moveTo(i, py); else ctx.lineTo(i, py);
    }
    ctx.stroke();
  }, [params.drive, params.mode]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => { draw(); animFrame = requestAnimationFrame(update); };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 150;
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    if (typeof currentVal !== 'number') return;
    let min = 0, max = 1;
    if (activeParam.current === 'drive') { min = 1; max = 100; }
    if (activeParam.current === 'tone') { min = -1; max = 1; }
    if (activeParam.current === 'mix') { min = 0; max = 1; }
    if (activeParam.current === 'outputGain') { min = 0; max = 2; }
    if (['eqLow', 'eqMid', 'eqHigh'].includes(activeParam.current)) { min = -12; max = 12; }
    const newVal = Math.max(min, Math.min(max, currentVal + delta * (max - min) * 0.5));
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

  const handleMouseDown = (param: keyof SaturatorParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const updateParam = (key: keyof SaturatorParams, val: any) => {
    const newParams = { ...params, [key]: val };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[500px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none text-white">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
             <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-400 border border-emerald-500/20 shadow-lg shadow-emerald-500/5"><i className="fas fa-fire text-xl"></i></div>
             <div><h2 className="text-lg font-black uppercase italic tracking-tighter leading-none">Vocal <span className="text-emerald-400">Saturator</span></h2><p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Multi-Stage Harmonic Sculptor</p></div>
        </div>
        <button onClick={() => updateParam('isEnabled', !params.isEnabled)} className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all ${params.isEnabled ? 'bg-emerald-500 text-black border-emerald-400 shadow-lg shadow-emerald-500/30' : 'bg-white/5 border-white/10 text-slate-600'}`}><i className="fas fa-power-off"></i></button>
      </div>
      <div className="flex bg-black/40 p-1 rounded-xl border border-white/5">
        {(['TUBE', 'TAPE', 'TRANSISTOR', 'SOFT_CLIP'] as SaturationMode[]).map(m => (
          <button key={m} onClick={() => updateParam('mode', m)} className={`flex-1 py-2 rounded-lg text-[8px] font-black transition-all ${params.mode === m ? 'bg-emerald-500 text-black shadow-lg' : 'text-slate-600 hover:text-white'}`}>{m.replace('_', ' ')}</button>
        ))}
      </div>
      <div className="flex space-x-8 items-center h-48">
           <div className="flex-1 h-full bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner"><canvas ref={canvasRef} width={260} height={160} className="w-full h-full opacity-80" /></div>
           <div className="flex flex-col items-center space-y-4">
              <span className="text-[8px] font-black text-slate-600 uppercase tracking-widest">Master Tone</span>
              <SatKnob label="Tone" value={(params.tone + 1) / 2} factor={100} suffix="%" color="#facc15" onMouseDown={(e) => handleMouseDown('tone', e)} displayVal={Math.round(params.tone * 100)} />
           </div>
        </div>
        <div className="grid grid-cols-4 gap-6 px-2">
           <SatKnob label="Drive" value={(params.drive)/100} onMouseDown={(e) => handleMouseDown('drive', e)} suffix="%" color="#10b981" displayVal={Math.round(params.drive)} />
           <SatKnob label="Post-Low" value={(params.eqLow + 12)/24} onMouseDown={(e) => handleMouseDown('eqLow', e)} suffix="dB" factor={24} offset={-12} color="#fff" displayVal={Math.round(params.eqLow)} />
           <SatKnob label="Post-Mid" value={(params.eqMid + 12)/24} onMouseDown={(e) => handleMouseDown('eqMid', e)} suffix="dB" factor={24} offset={-12} color="#fff" displayVal={Math.round(params.eqMid)} />
           <SatKnob label="Post-High" value={(params.eqHigh + 12)/24} onMouseDown={(e) => handleMouseDown('eqHigh', e)} suffix="dB" factor={24} offset={-12} color="#fff" displayVal={Math.round(params.eqHigh)} />
        </div>
        <div className="flex justify-between items-center pt-4 border-t border-white/5 px-2">
          <div className="flex flex-col"><span className="text-[7px] font-black text-slate-700 uppercase tracking-widest">Signal Path</span><span className="text-[8px] font-black text-slate-500 uppercase">Drive > Tilt > 3-Band EQ</span></div>
          <div className="flex space-x-6"><div className="flex flex-col items-end"><span className="text-[7px] font-black text-slate-700 uppercase">Wet Mix</span><span className="text-[10px] font-mono text-emerald-500 font-bold">{Math.round(params.mix * 100)}%</span></div><input type="range" min="0" max="1" step="0.01" value={params.mix} onChange={(e) => updateParam('mix', parseFloat(e.target.value))} className="w-24 h-1 bg-white/5 accent-emerald-500 rounded-full" /></div>
        </div>
    </div>
  );
};

const SatKnob: React.FC<{ label: string, value: number, onMouseDown: (e: React.MouseEvent) => void, color: string, suffix: string, factor?: number, offset?: number, displayVal: number }> = ({ label, value, onMouseDown, color, suffix, factor = 100, offset = 0, displayVal }) => {
  const safeValue = Number.isFinite(value) ? value : 0;
  const rotation = (safeValue * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-3 group touch-none">
      <div onMouseDown={onMouseDown} className="w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-emerald-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 8px ${color}66` }} />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1.5">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[45px]"><span className="text-[9px] font-mono font-bold text-white">{displayVal}{suffix}</span></div>
      </div>
    </div>
  );
};
