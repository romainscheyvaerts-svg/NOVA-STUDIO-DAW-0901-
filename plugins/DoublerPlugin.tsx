
import React, { useEffect, useRef, useState } from 'react';

/**
 * MODULE FX_10 : VOCAL DOUBLER
 * ---------------------------
 * Logic: Dual-tap delay (Haas Effect) with cross-modulation to simulate micro-pitch shifting.
 * Features: Independent L/R Volume, Width control, and Direct Signal Mute.
 */

export interface DoublerParams {
  detune: number;      // 0 to 1 (Scale for +/- 15 cents)
  width: number;       // 0 to 1 (Stereo Pan Spread)
  gainL: number;       // 0 to 1
  gainR: number;       // 0 to 1
  directOn: boolean;   // Keep or mute the center signal
  isEnabled: boolean;
}

export class VocalDoublerNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private dryGain: GainNode;
  private wetGainL: GainNode;
  private wetGainR: GainNode;
  
  private delayL: DelayNode;
  private delayR: DelayNode;
  
  private modL: OscillatorNode;
  private modR: OscillatorNode;
  private modGainL: GainNode;
  private modGainR: GainNode;
  
  private pannerL: StereoPannerNode;
  private pannerR: StereoPannerNode;

  private params: DoublerParams = {
    detune: 0.4,
    width: 0.8,
    gainL: 0.7,
    gainR: 0.7,
    directOn: true,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    this.dryGain = ctx.createGain();
    this.wetGainL = ctx.createGain();
    this.wetGainR = ctx.createGain();
    
    this.delayL = ctx.createDelay(0.1);
    this.delayR = ctx.createDelay(0.1);
    
    this.modL = ctx.createOscillator();
    this.modR = ctx.createOscillator();
    this.modGainL = ctx.createGain();
    this.modGainR = ctx.createGain();
    
    this.pannerL = ctx.createStereoPanner();
    this.pannerR = ctx.createStereoPanner();

    this.setupGraph();
  }

  private setupGraph() {
    // 1. Dry Path (Center)
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // 2. Left Path (Asymmetric Delay 12ms)
    this.input.connect(this.delayL);
    this.delayL.connect(this.wetGainL);
    this.wetGainL.connect(this.pannerL);
    this.pannerL.connect(this.output);

    // 3. Right Path (Asymmetric Delay 28ms)
    this.input.connect(this.delayR);
    this.delayR.connect(this.wetGainR);
    this.wetGainR.connect(this.pannerR);
    this.pannerR.connect(this.output);

    // 4. Modulation (Slow LFO for micro-pitch drift)
    this.modL.type = 'sine';
    this.modR.type = 'sine';
    this.modL.frequency.value = 0.2; // Very slow drift
    this.modR.frequency.value = 0.25;
    
    this.modL.connect(this.modGainL);
    this.modGainL.connect(this.delayL.delayTime);
    
    this.modR.connect(this.modGainR);
    this.modGainR.connect(this.delayR.delayTime);
    
    this.modL.start();
    this.modR.start();

    this.applyParams();
  }

  public updateParams(p: Partial<DoublerParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    const { detune, width, gainL, gainR, directOn, isEnabled } = this.params;

    if (isEnabled) {
      this.dryGain.gain.setTargetAtTime(directOn ? 1.0 : 0.0, now, 0.05);
      this.wetGainL.gain.setTargetAtTime(safe(gainL), now, 0.05);
      this.wetGainR.gain.setTargetAtTime(safe(gainR), now, 0.05);
      
      const sWidth = safe(width);
      this.pannerL.pan.setTargetAtTime(-sWidth, now, 0.1);
      this.pannerR.pan.setTargetAtTime(sWidth, now, 0.1);
      
      const sDetune = safe(detune);
      this.modGainL.gain.setTargetAtTime(0.0005 + (sDetune * 0.0015), now, 0.1);
      this.modGainR.gain.setTargetAtTime(0.0005 + (sDetune * 0.0015), now, 0.1);
      
      this.delayL.delayTime.setTargetAtTime(0.012, now, 0.05);
      this.delayR.delayTime.setTargetAtTime(0.028, now, 0.05);
    } else {
      this.dryGain.gain.setTargetAtTime(1.0, now, 0.02);
      this.wetGainL.gain.setTargetAtTime(0, now, 0.02);
      this.wetGainR.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public getStatus() {
    return { ...this.params };
  }
}

const DoublerKnob: React.FC<{ 
  label: string, value: number, onChange: (v: number) => void, suffix?: string, factor?: number, defaultValue?: number 
}> = ({ label, value, onChange, suffix, factor = 1, defaultValue = 0.5 }) => {
  const safeValue = Number.isFinite(value) ? value : defaultValue || 0;

  const handleInteraction = (delta: number, startVal: number) => {
      const newVal = Math.max(0, Math.min(1, startVal + delta));
      if (Number.isFinite(newVal)) onChange(newVal);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startValue = safeValue;
    const onMouseMove = (m: MouseEvent) => handleInteraction((startY - m.clientY) / 150, startValue);
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startValue = safeValue;
    const onTouchMove = (t: TouchEvent) => {
        if(t.cancelable) t.preventDefault();
        handleInteraction((startY - t.touches[0].clientY) / 150, startValue);
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  const rotation = (safeValue * 270) - 135;

  return (
    <div className="flex flex-col items-center space-y-2 select-none group touch-none">
      <div 
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onDoubleClick={() => onChange(defaultValue || 0.5)}
        className="w-14 h-14 rounded-full bg-[#121418] border-2 border-white/5 flex items-center justify-center cursor-pointer hover:border-violet-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75"
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: '#a855f7', boxShadow: '0 0 10px #a855f7' }}
        />
        <div className="absolute inset-4 rounded-full bg-[#1a1c22] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-600 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[45px]">
          <span className="text-[9px] font-mono font-bold text-violet-400">
            {Math.round(safeValue * factor)}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};

export const VocalDoublerUI: React.FC<{ node: VocalDoublerNode, initialParams: DoublerParams, onParamsChange?: (p: DoublerParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frame: number;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (params.isEnabled) {
        const { width, gainL, gainR, directOn } = params;
        const centerX = w / 2;
        const centerY = h - 20;

        ctx.lineWidth = 4;
        ctx.lineCap = 'round';

        if (directOn) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
          ctx.moveTo(centerX, centerY);
          ctx.lineTo(centerX, 30);
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.strokeStyle = `rgba(168, 85, 247, ${gainL})`;
        ctx.moveTo(centerX, centerY);
        const lx = centerX - (width * (w / 2.5));
        ctx.lineTo(lx, 40);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = `rgba(168, 85, 247, ${gainR})`;
        ctx.moveTo(centerX, centerY);
        const rx = centerX + (width * (w / 2.5));
        ctx.lineTo(rx, 40);
        ctx.stroke();

        ctx.shadowBlur = 10;
        ctx.shadowColor = '#a855f7';
      }

      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [params]);

  const handleParamChange = (key: keyof DoublerParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[500px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-violet-500/10 flex items-center justify-center text-violet-400 border border-violet-500/20 shadow-lg shadow-violet-500/5">
            <i className="fas fa-people-arrows text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Vocal <span className="text-violet-400">Doubler</span></h2>
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">Haas-Based Stereo Imager</p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button 
            onClick={() => handleParamChange('directOn', !params.directOn)}
            className={`px-3 py-2 rounded-xl text-[8px] font-black uppercase transition-all border ${params.directOn ? 'bg-white/10 text-white' : 'bg-red-500/20 border-red-500/40 text-red-500'}`}
          >
            Direct: {params.directOn ? 'ON' : 'OFF'}
          </button>
          <button 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-violet-500 border-violet-400 text-black shadow-lg shadow-violet-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <i className="fas fa-power-off"></i>
          </button>
        </div>
      </div>

      <div className="h-32 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <div className="absolute top-4 left-6 text-[7px] font-black text-slate-600 uppercase tracking-widest z-10">Stereo Projection</div>
        <canvas ref={canvasRef} width={400} height={128} className="w-full h-full opacity-60" />
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex space-x-16 text-[6px] font-black text-slate-700 uppercase">
           <span>Left</span>
           <span>Center</span>
           <span>Right</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 px-2">
        <DoublerKnob label="Fine Tune" value={params.detune} factor={15} suffix="ct" onChange={v => handleParamChange('detune', v)} defaultValue={0.4} />
        <DoublerKnob label="Width" value={params.width} factor={100} suffix="%" onChange={v => handleParamChange('width', v)} defaultValue={0.8} />
        <DoublerKnob label="Gain L" value={params.gainL} factor={100} suffix="%" onChange={v => handleParamChange('gainL', v)} defaultValue={0.7} />
        <DoublerKnob label="Gain R" value={params.gainR} factor={100} suffix="%" onChange={v => handleParamChange('gainR', v)} defaultValue={0.7} />
      </div>

      <div className="pt-6 border-t border-white/5 flex justify-between items-center text-slate-700">
        <div className="flex flex-col">
          <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest">Haas Offset</span>
          <span className="text-[9px] font-mono text-violet-400/60 mt-1">12ms / 28ms</span>
        </div>
        <div className="flex items-center space-x-2">
           <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-violet-500 shadow-[0_0_8px_#a855f7]' : 'bg-slate-800'}`} />
           <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">DualCore Engine v1.1</span>
        </div>
      </div>
    </div>
  );
};
