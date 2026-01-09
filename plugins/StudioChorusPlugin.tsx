
import React, { useEffect, useRef, useState } from 'react';

/**
 * MODULE FX_08 : PROFESSIONAL VOCAL CHORUS
 * ---------------------------------------
 * Logic: 3-voice parallel modulated delays with phase-shifted LFOs.
 * Features: High-precision Dry/Wet mix and Stereo Imager (Spread).
 */

export interface ChorusParams {
  rate: number;       // 0.1 to 5 Hz
  depth: number;      // 0 to 1
  spread: number;     // 0 to 1 (Stereo Width)
  mix: number;        // 0 to 1 (Dry/Wet)
  isEnabled: boolean;
}

export class ChorusNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private dryGain: GainNode;
  private wetGain: GainNode;
  
  private voices: {
    delay: DelayNode;
    lfo: OscillatorNode;
    depthGain: GainNode;
    panner: StereoPannerNode;
  }[] = [];

  private params: ChorusParams = {
    rate: 1.2,
    depth: 0.35,
    spread: 0.5,
    mix: 0.4,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.setupGraph();
  }

  private setupGraph() {
    // Basic routing
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    // Create 3 voices
    const voiceConfigs = [
      { baseDelay: 0.025, pan: -0.8 },
      { baseDelay: 0.030, pan: 0.0 },
      { baseDelay: 0.035, pan: 0.8 }
    ];

    voiceConfigs.forEach((cfg, i) => {
      const delay = this.ctx.createDelay(0.1);
      const lfo = this.ctx.createOscillator();
      const depthGain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner();

      lfo.type = 'sine';
      lfo.frequency.value = this.params.rate;
      
      this.input.connect(delay);
      lfo.connect(depthGain);
      depthGain.connect(delay.delayTime);
      delay.connect(panner);
      panner.connect(this.wetGain);

      lfo.start();
      this.voices.push({ delay, lfo, depthGain, panner });
    });

    this.applyParams();
  }

  public updateParams(p: Partial<ChorusParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const { rate, depth, spread, mix, isEnabled } = this.params;

    // Mix logic: Constant power-ish scaling
    if (isEnabled) {
      this.dryGain.gain.setTargetAtTime(1 - (mix * 0.5), now, 0.02);
      this.wetGain.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }

    this.voices.forEach((v, i) => {
      // Frequency modulation
      v.lfo.frequency.setTargetAtTime(rate, now, 0.03);
      
      // Depth modulation (adjusting delay time amplitude)
      v.depthGain.gain.setTargetAtTime(0.003 * depth, now, 0.03);

      // Stereo Spread
      const panBase = [ -0.8, 0, 0.8 ];
      v.panner.pan.setTargetAtTime(panBase[i] * spread, now, 0.05);
    });
  }

  public getStatus() {
    return { ...this.params };
  }
}

const ChorusKnob: React.FC<{ 
  label: string, value: number, onChange: (v: number) => void, suffix?: string, factor?: number, defaultValue?: number 
}> = ({ label, value, onChange, suffix, factor = 1, defaultValue = 0.5 }) => {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startValue = value;
    const onMouseMove = (m: MouseEvent) => {
      const deltaY = (startY - m.clientY) / 200;
      const newValue = Math.max(0, Math.min(1, startValue + deltaY));
      onChange(newValue);
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

  const rotation = (value * 270) - 135;

  return (
    <div className="flex flex-col items-center space-y-2 select-none group">
      <div 
        onMouseDown={handleMouseDown}
        onDoubleClick={() => onChange(defaultValue)}
        className="w-16 h-16 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-pointer hover:border-cyan-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-2 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75"
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: '#00f2ff', boxShadow: '0 0 10px #00f2ff' }}
        />
        <div className="absolute inset-5 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-3 py-1 rounded-lg border border-white/5">
          <span className="text-[10px] font-mono font-bold text-cyan-400">
            {Math.round(value * factor)}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};

export const VocalChorusUI: React.FC<{ node: ChorusNode, initialParams: ChorusParams, onParamsChange?: (p: ChorusParams) => void }> = ({ node, initialParams, onParamsChange }) => {
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
        const time = Date.now() * 0.001;
        const { rate, depth, spread } = params;

        const drawWave = (color: string, offset: number, ampMult: number) => {
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          for (let x = 0; x < w; x++) {
            const phase = x * 0.04 + time * rate * 6 + offset;
            const y = h/2 + Math.sin(phase) * (25 * depth * ampMult);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };

        drawWave('rgba(255, 255, 255, 0.2)', 0, 0.5);
        drawWave('rgba(0, 242, 255, 0.6)', -spread * 2, 1);
        drawWave('rgba(139, 92, 246, 0.6)', spread * 2, 1);
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
      }

      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [params]);

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
          <div className="w-16 h-16 rounded-[24px] bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5">
            <i className="fas fa-layer-group text-3xl"></i>
          </div>
          <div>
            <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Vocal <span className="text-cyan-400">Chorus</span></h2>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mt-2">Analog Multi-Voice Imager</p>
          </div>
        </div>
        <button 
          onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-all border-2 ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off text-lg"></i>
        </button>
      </div>

      <div className="h-36 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <div className="absolute top-4 left-8 text-[8px] font-black text-slate-600 uppercase tracking-widest z-10">LFO Phase Analysis</div>
        <canvas ref={canvasRef} width={440} height={144} className="w-full h-full opacity-80" />
        <div className="absolute inset-0 bg-gradient-to-t from-cyan-500/5 to-transparent pointer-events-none" />
      </div>

      <div className="grid grid-cols-4 gap-6">
        <ChorusKnob label="Rate" value={params.rate / 5} factor={5} suffix="Hz" onChange={v => handleParamChange('rate', v * 5)} defaultValue={0.24} />
        <ChorusKnob label="Depth" value={params.depth} factor={100} suffix="%" onChange={v => handleParamChange('depth', v)} defaultValue={0.35} />
        <ChorusKnob label="Spread" value={params.spread} factor={100} suffix="%" onChange={v => handleParamChange('spread', v)} defaultValue={0.5} />
        <ChorusKnob label="Mix" value={params.mix} factor={100} suffix="%" onChange={v => handleParamChange('mix', v)} defaultValue={0.4} />
      </div>

      <div className="pt-8 border-t border-white/5 flex justify-between items-center text-slate-700">
        <div className="flex flex-col">
          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Stereo Width</span>
          <span className="text-[11px] font-mono font-bold text-cyan-400/60 mt-1">{Math.round(params.spread * 100)}% Wide</span>
        </div>
        <div className="flex items-center space-x-3">
           <div className={`w-2.5 h-2.5 rounded-full ${params.isEnabled ? 'bg-cyan-500 shadow-[0_0_10px_#00f2ff] animate-pulse' : 'bg-slate-800'}`} />
           <span className="text-[9px] font-black text-slate-500 uppercase tracking-[0.3em]">Quantum Engine v1.4</span>
        </div>
      </div>
    </div>
  );
};
