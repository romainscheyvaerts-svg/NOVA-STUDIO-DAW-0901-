import React, { useState, useEffect, useRef, useCallback } from 'react';
// FIX: The AutoTuneNode class, though imported, was not re-exported, causing an import error in the AudioEngine. It is now exported from this module to maintain consistency with other plugins.
import { AutoTuneNode } from './autotune-pro/AutoTuneNode';
export { AutoTuneNode };
import { NOTES, SCALES } from '../utils/constants';

export interface AutoTuneParams {
  speed: number;      
  humanize: number;   
  mix: number;        
  rootKey: number;    
  scale: string;      
  isEnabled: boolean;
}

interface AutoTuneUIProps {
  node: AutoTuneNode;
  initialParams: AutoTuneParams;
  onParamsChange?: (p: AutoTuneParams) => void;
}

export const AutoTuneUI: React.FC<AutoTuneUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<AutoTuneParams>(initialParams);
  const paramsRef = useRef<AutoTuneParams>(initialParams); // Ref to hold latest params for event listeners
  const [vizData, setVizData] = useState({ detectedFreq: 0, targetFreq: 0, correctionCents: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof AutoTuneParams | null>(null);

  // Sync ref with state
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    node.setStatusCallback((data) => {
      setVizData(data);
    });
    return () => node.setStatusCallback(() => {});
  }, [node]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frameId: number;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h); 
      ctx.stroke();

      ctx.fillStyle = 'rgba(0, 242, 255, 0.05)';
      ctx.fillRect(w/2 - 20, 0, 40, h);

      if (vizData.detectedFreq > 50) {
        const offset = Math.max(-100, Math.min(100, vizData.correctionCents));
        const x = (w / 2) + (offset / 100) * (w / 2 * 0.8); 

        ctx.strokeStyle = '#00f2ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(w/2, h/2 - 20); ctx.lineTo(w/2, h/2 + 20);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, h/2, 8, 0, Math.PI * 2);
        ctx.fillStyle = paramsRef.current.isEnabled ? '#ffffff' : '#555';
        ctx.fill();
        
        ctx.beginPath();
        ctx.moveTo(x, h/2);
        ctx.lineTo(w/2, h/2);
        ctx.strokeStyle = `rgba(0, 242, 255, ${Math.abs(offset) / 100})`;
        ctx.stroke();
      }

      frameId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frameId);
  }, [vizData]);

  const updateParam = (key: keyof AutoTuneParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const handleMouseDown = (param: keyof AutoTuneParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  // FIX: Refactored to avoid calling onParamsChange within the setState callback, which is a React anti-pattern (#310) that can lead to stale state and unpredictable behavior. The side effect is now correctly separated from the state update.
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 150;
    
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    
    if (typeof currentVal !== 'number') return;
    
    const newVal = Math.max(0, Math.min(1, currentVal + delta));
    const newParams = { ...currentParams, [activeParam.current!]: newVal };
    
    setParams(newParams);
    node.updateParams(newParams);
    
    if (onParamsChange) {
        onParamsChange(newParams);
    }
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

  const getNoteName = (freq: number) => {
    if (freq <= 0) return '--';
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    return NOTES[midi % 12] || '--';
  };

  return (
    <div className="w-[480px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-microphone-alt text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Auto-Tune <span className="text-cyan-400">Pro</span></h2>
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">Real-Time DSP Worklet</p>
          </div>
        </div>
        <button 
          onClick={() => updateParam('isEnabled', !params.isEnabled)}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>

      <div className="h-44 bg-black/60 rounded-[32px] border border-white/5 relative flex flex-col items-center justify-center overflow-hidden shadow-inner group">
        <canvas ref={canvasRef} width={400} height={176} className="absolute inset-0 opacity-60" />
        <div className="relative text-center z-10 pointer-events-none">
           <span className="block text-[9px] font-black text-cyan-500/50 uppercase tracking-[0.5em] mb-2">Correction Target</span>
           <span className="text-7xl font-black text-white font-mono tracking-tighter leading-none text-shadow-glow">
             {vizData.targetFreq > 0 ? getNoteName(vizData.targetFreq) : '--'}
           </span>
           <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">
             In: {getNoteName(vizData.detectedFreq)}
           </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 bg-white/[0.02] p-6 rounded-[24px] border border-white/5">
        <div className="space-y-3">
          <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest ml-1">Key</label>
          <select 
            value={params.rootKey} 
            onChange={(e) => updateParam('rootKey', parseInt(e.target.value))}
            className="w-full bg-[#14161a] border border-white/10 rounded-xl p-3 text-[11px] font-black text-white hover:border-cyan-500/50 outline-none appearance-none cursor-pointer"
          >
            {NOTES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </div>
        <div className="space-y-3">
          <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest ml-1">Scale</label>
          <select 
            value={params.scale} 
            onChange={(e) => updateParam('scale', e.target.value as any)}
            className="w-full bg-[#14161a] border border-white/10 rounded-xl p-3 text-[11px] font-black text-white hover:border-cyan-500/50 outline-none appearance-none cursor-pointer"
          >
            {SCALES.map(s => <option key={s} value={s}>{s.replace('_', ' ').toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-8 pt-2">
        <TuneKnob label="Retune Speed" value={params.speed} onMouseDown={(e) => handleMouseDown('speed', e)} factor={100} suffix="%" inverseLabel={true} />
        <TuneKnob label="Humanize" value={params.humanize} onMouseDown={(e) => handleMouseDown('humanize', e)} factor={100} suffix="%" />
        <TuneKnob label="Amount" value={params.mix} onMouseDown={(e) => handleMouseDown('mix', e)} factor={100} suffix="%" />
      </div>
    </div>
  );
};

const TuneKnob: React.FC<{ label: string, value: number, onMouseDown: (e: React.MouseEvent) => void, factor: number, suffix: string, inverseLabel?: boolean }> = ({ label, value, onMouseDown, factor, suffix, inverseLabel }) => {
  const rotation = (value * 270) - 135;
  let displayValue = `${Math.round(value * factor)}${suffix}`;
  if (inverseLabel) {
      if (value < 0.1) displayValue = "ROBOT";
      else if (value > 0.9) displayValue = "NATURAL";
      else displayValue = `${Math.round((1-value) * 100)}ms`; 
  }

  return (
    <div className="flex flex-col items-center space-y-3 group cursor-ns-resize" onMouseDown={onMouseDown}>
      <div className="relative w-16 h-16 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center shadow-lg group-hover:border-cyan-500/50 transition-colors">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute w-1.5 h-6 bg-current rounded-full origin-bottom bottom-1/2 transition-transform duration-75"
          style={{ transform: `rotate(${rotation}deg)`, color: '#00f2ff', boxShadow: `0 0 10px #00f2ff` }}
        />
      </div>
      <div className="text-center">
        <span className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">{displayValue}</span>
        </div>
      </div>
    </div>
  );
};
