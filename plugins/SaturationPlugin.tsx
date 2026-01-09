
import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * MODULE FX_03 : VOCAL SATURATION ENGINE
 * --------------------------------------
 * DSP: High-quality waveshaping with oversampling.
 * Modes: 
 * - TAPE: Warm odd-harmonics using hyperbolic tangent.
 * - TUBE: Asymmetric harmonics for vintage vacuum character.
 * - SOFT-CLIP: Transparent peak limiting.
 */

export type SaturationMode = 'TAPE' | 'TUBE' | 'SOFT_CLIP';

export interface SaturationParams {
  drive: number;      // 1.0 to 10.0
  tone: number;       // -1.0 to 1.0 (Tilt EQ)
  mix: number;        // 0.0 to 1.0
  outputGain: number; // 0.0 to 2.0
  mode: SaturationMode;
  isEnabled: boolean;
}

export class SaturationNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  private driveGain: GainNode;
  private shaper: WaveShaperNode;
  private tiltLow: BiquadFilterNode;
  private tiltHigh: BiquadFilterNode;
  private wetGain: GainNode;
  private dryGain: GainNode;
  private makeupGain: GainNode;

  private params: SaturationParams = {
    drive: 2.5,
    tone: 0.0,
    mix: 0.6,
    outputGain: 1.0,
    mode: 'TAPE',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.driveGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';

    this.tiltLow = ctx.createBiquadFilter();
    this.tiltLow.type = 'lowshelf';
    this.tiltLow.frequency.value = 800;

    this.tiltHigh = ctx.createBiquadFilter();
    this.tiltHigh.type = 'highshelf';
    this.tiltHigh.frequency.value = 1200;

    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.makeupGain = ctx.createGain();

    this.setupChain();
    this.updateCurve();
  }

  private setupChain() {
    this.input.disconnect();

    // -- DRY PATH --
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.makeupGain);

    // -- WET PATH --
    this.input.connect(this.driveGain);
    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.tiltLow);
    this.tiltLow.connect(this.tiltHigh);
    this.tiltHigh.connect(this.wetGain);
    this.wetGain.connect(this.makeupGain);

    this.makeupGain.connect(this.output);

    this.applyParams();
  }

  public updateParams(p: Partial<SaturationParams>) {
    const oldMode = this.params.mode;
    const oldDrive = this.params.drive;
    this.params = { ...this.params, ...p };

    if (this.params.mode !== oldMode || this.params.drive !== oldDrive) {
      this.updateCurve();
    }
    this.applyParams();
  }

  private updateCurve() {
    const n = 4096;
    const curve = new Float32Array(n);
    const drive = this.params.drive;

    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;

      if (this.params.mode === 'TAPE') {
        curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
      } 
      else if (this.params.mode === 'TUBE') {
        const absX = Math.abs(x);
        if (x < 0) {
          curve[i] = - (1 - Math.exp(-absX * drive)) / (1 - Math.exp(-drive));
        } else {
          curve[i] = (Math.pow(absX, 0.5) * (1 - Math.exp(-absX * drive))) / (1 - Math.exp(-drive));
        }
      } 
      else if (this.params.mode === 'SOFT_CLIP') {
        const gainX = x * drive * 0.5;
        curve[i] = Math.abs(gainX) < 1 ? gainX - (Math.pow(gainX, 3) / 3) : (gainX > 0 ? 0.66 : -0.66);
        curve[i] *= 1.5;
      }
    }
    this.shaper.curve = curve;
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const { drive, tone, mix, outputGain, isEnabled } = this.params;

    if (isEnabled) {
      this.driveGain.gain.setTargetAtTime(isFinite(drive * 0.5) ? drive * 0.5 : 1.0, now, 0.02);
      this.tiltLow.gain.setTargetAtTime(isFinite(-tone * 12) ? -tone * 12 : 0, now, 0.02);
      this.tiltHigh.gain.setTargetAtTime(isFinite(tone * 12) ? tone * 12 : 0, now, 0.02);
      this.dryGain.gain.setTargetAtTime(isFinite(1 - mix) ? 1 - mix : 1.0, now, 0.02);
      this.wetGain.gain.setTargetAtTime(isFinite(mix) ? mix : 0.0, now, 0.02);
      this.makeupGain.gain.setTargetAtTime(isFinite(outputGain) ? outputGain : 1.0, now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1.0, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0.0, now, 0.02);
      this.makeupGain.gain.setTargetAtTime(1.0, now, 0.02);
    }
  }

  public getParams() { return { ...this.params }; }
}

interface VocalSaturationUIProps {
  node: SaturationNode;
  initialParams: SaturationParams;
}

/**
 * VOCAL SATURATION UI (Converted to Functional Component for fix)
 */
export const VocalSaturationUI: React.FC<VocalSaturationUIProps> = ({ node, initialParams }) => {
  const [params, setParams] = useState<SaturationParams>(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof SaturationParams | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    const { drive, mode } = params;

    ctx.beginPath();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#facc1544';

    for (let i = 0; i < w; i++) {
      const x = (i / w) * 2 - 1;
      let y = 0;

      if (mode === 'TAPE') {
        y = Math.tanh(x * drive) / Math.tanh(drive);
      } else if (mode === 'TUBE') {
        const absX = Math.abs(x);
        if (x < 0) {
          y = - (1 - Math.exp(-absX * drive)) / (1 - Math.exp(-drive));
        } else {
          y = (Math.pow(absX, 0.5) * (1 - Math.exp(-absX * drive))) / (1 - Math.exp(-drive));
        }
      } else if (mode === 'SOFT_CLIP') {
        const gainX = x * drive * 0.5;
        y = Math.abs(gainX) < 1 ? gainX - (Math.pow(gainX, 3) / 3) : (gainX > 0 ? 0.66 : -0.66);
        y *= 1.5;
      }

      const py = (h / 2) - (y * (h / 2.2));
      if (i === 0) ctx.moveTo(i, py);
      else ctx.lineTo(i, py);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [params]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      draw();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    
    const delta = -e.movementY / 150;
    setParams(prev => {
      const current = prev[activeParam.current!];
      if (typeof current !== 'number') return prev;

      let min = 0, max = 1;
      if (activeParam.current === 'drive') { min = 1; max = 10; }
      if (activeParam.current === 'tone') { min = -1; max = 1; }
      if (activeParam.current === 'outputGain') { min = 0; max = 2; }

      const newVal = Math.max(min, Math.min(max, current + delta * (max - min)));
      const newParams = { ...prev, [activeParam.current!]: newVal };
      node.updateParams(newParams);
      return newParams;
    });
  }, [node]);

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

  const handleMouseDown = (param: keyof SaturationParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const setMode = (mode: SaturationMode) => {
    const newParams = { ...params, mode };
    setParams(newParams);
    node.updateParams(newParams);
  };

  const togglePower = () => {
    const isEnabled = !params.isEnabled;
    const newParams = { ...params, isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
  };

  return (
    <div className="w-[520px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-yellow-500/10 flex items-center justify-center text-yellow-400 border border-yellow-500/20 shadow-lg shadow-yellow-500/5">
            <i className="fas fa-fire text-2xl"></i>
          </div>
          <div>
            <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Vocal <span className="text-yellow-400">Heat</span></h2>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-2">Harmonic Multi-Stage Saturation</p>
          </div>
        </div>
        <button 
          onClick={togglePower}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-yellow-500 border-yellow-400 text-black shadow-lg shadow-yellow-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>

      <div className="flex bg-black/40 p-1.5 rounded-2xl border border-white/5 space-x-1">
        {(['TAPE', 'TUBE', 'SOFT_CLIP'] as SaturationMode[]).map(m => (
          <button 
            key={m} 
            onClick={() => setMode(m)}
            className={`flex-1 py-3 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${params.mode === m ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/40' : 'text-slate-500 hover:text-white'}`}
          >
            {m.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="h-44 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <div className="absolute top-4 left-6 flex flex-col">
           <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Transfer Curve</span>
           <span className="text-[10px] font-mono text-yellow-500/50 uppercase">{params.mode} ALGORITHM</span>
        </div>
        <canvas ref={canvasRef} width={420} height={176} className="w-full h-full opacity-80 transition-opacity group-hover:opacity-100" />
        <div className="absolute bottom-4 right-6 text-[8px] font-black text-slate-800 uppercase tracking-[0.2em]">Non-Linear Response Map</div>
      </div>

      <div className="grid grid-cols-4 gap-4 px-2">
        <SatKnob label="Drive" value={(params.drive - 1) / 9} factor={100} suffix="%" color="#facc15" onMouseDown={(e) => handleMouseDown('drive', e)} displayVal={Math.round((params.drive-1)/9 * 100)} />
        <SatKnob label="Tilt Tone" value={(params.tone + 1) / 2} factor={100} suffix="%" color="#facc15" onMouseDown={(e) => handleMouseDown('tone', e)} displayVal={Math.round(params.tone * 100)} />
        <SatKnob label="Dry / Wet" value={params.mix} factor={100} suffix="%" color="#fff" onMouseDown={(e) => handleMouseDown('mix', e)} displayVal={Math.round(params.mix * 100)} />
        <SatKnob label="Output" value={params.outputGain / 2} factor={200} suffix="%" color="#fff" onMouseDown={(e) => handleMouseDown('outputGain', e)} displayVal={Math.round(params.outputGain * 100)} />
      </div>

      <div className="pt-6 border-t border-white/5 flex justify-between items-center text-slate-700">
         <div className="flex flex-col">
            <span className="text-[7px] font-black text-slate-700 uppercase tracking-widest">Processing</span>
            <span className="text-[9px] font-black text-slate-400 uppercase">32-Bit Floating Point</span>
         </div>
         <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-yellow-500 shadow-[0_0_10px_#facc15]' : 'bg-slate-800'}`} />
            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Analog Model Active</span>
         </div>
      </div>
    </div>
  );
};

const SatKnob: React.FC<{ label: string, value: number, onMouseDown: (e: React.MouseEvent) => void, color: string, factor: number, suffix: string, displayVal: number }> = ({ label, value, onMouseDown, color, factor, suffix, displayVal }) => {
  const rotation = (value * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-3 group">
      <div 
        onMouseDown={onMouseDown} 
        className="w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-yellow-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75" 
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 10px ${color}` }} 
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1.5">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">{displayVal}{suffix}</span>
        </div>
      </div>
    </div>
  );
};
