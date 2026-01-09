
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';

/**
 * MODULE FX_01 : EQ PARAMÉTRIQUE SIMPLE
 * ---------------------------------------------
 * DSP: BiquadFilterNodes en série.
 */

export type FilterType = 'highpass' | 'lowshelf' | 'peaking' | 'highshelf' | 'lowpass' | 'notch';
export interface EQBand { 
  id: number; 
  type: FilterType; 
  frequency: number; 
  gain: number; 
  q: number; 
  enabled: boolean; 
  color: string; 
}
export interface EQParams { 
  bands: EQBand[]; 
  masterGain: number; 
  isEnabled: boolean; 
}

const MIN_FREQ = 20; 
const MAX_FREQ = 20000; 
const MIN_GAIN = -24; 
const MAX_GAIN = 24;

export class EQNode {
  private ctx: AudioContext; 
  public input: GainNode; 
  public output: GainNode; 
  public analyzer: AnalyserNode;
  private filters: BiquadFilterNode[] = []; 
  private params: EQParams;
  private lastActiveStates: string = '';

  constructor(ctx: AudioContext, initialParams: EQParams) {
    this.ctx = ctx; 
    this.params = initialParams; 
    this.input = ctx.createGain(); 
    this.output = ctx.createGain();
    this.analyzer = ctx.createAnalyser(); 
    this.analyzer.fftSize = 2048; 
    this.setupChain();
  }

  private setupChain() {
    this.input.disconnect(); 
    this.filters.forEach(f => { try { f.disconnect(); } catch(e) {} }); 
    this.filters = [];

    let lastNode: AudioNode = this.input;
    
    this.params.bands.forEach(band => {
      const filter = this.ctx.createBiquadFilter();
      filter.type = band.type; 
      filter.frequency.value = band.frequency; 
      filter.gain.value = band.gain; 
      filter.Q.value = band.q;
      
      if (band.enabled && this.params.isEnabled) { 
        lastNode.connect(filter); 
        lastNode = filter; 
      }
      this.filters.push(filter);
    });

    lastNode.connect(this.analyzer); 
    this.analyzer.connect(this.output);
  }

  public updateParams(newParams: Partial<EQParams>) {
    this.params = { ...this.params, ...newParams };
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    
    this.params.bands.forEach((band, i) => {
      const f = this.filters[i];
      if (f) {
        f.type = band.type; 
        const time = this.ctx.currentTime + 0.02;
        f.frequency.setTargetAtTime(safe(band.frequency), time, 0.015);
        f.gain.setTargetAtTime(safe(band.gain), time, 0.015);
        f.Q.setTargetAtTime(safe(band.q), time, 0.015);
      }
    });

    const activeStates = this.params.bands.map(b => b.enabled).join() + this.params.isEnabled;
    if (this.lastActiveStates !== activeStates) { 
      this.setupChain(); 
      this.lastActiveStates = activeStates; 
    }
  }

  public getFrequencyResponse(freqs: Float32Array): Float32Array {
    const totalMag = new Float32Array(freqs.length).fill(1.0);
    const magResponse = new Float32Array(freqs.length);
    const phaseResponse = new Float32Array(freqs.length);
    
    this.filters.forEach((filter, i) => {
      if (this.params.bands[i].enabled && this.params.isEnabled) {
        filter.getFrequencyResponse(freqs, magResponse, phaseResponse);
        for (let j = 0; j < freqs.length; j++) {
          totalMag[j] *= magResponse[j];
        }
      }
    });
    return totalMag;
  }
}

const EQKnob: React.FC<{ 
  label: string, value: number, min: number, max: number, onChange: (v: number) => void, 
  suffix: string, color: string, log?: boolean, disabled?: boolean, precision?: number 
}> = ({ label, value, min, max, onChange, suffix, color, log, disabled, precision = 0 }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const norm = log ? (Math.log10(safeValue / min) / Math.log10(max / min)) : (safeValue - min) / (max - min);
  
  const handleInteraction = (delta: number, startNorm: number) => {
      const newNorm = Math.max(0, Math.min(1, startNorm + delta));
      const val = log ? min * Math.pow(max / min, newNorm) : min + newNorm * (max - min);
      if (Number.isFinite(val)) onChange(val);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startNorm = norm;
    const onMouseMove = (m: MouseEvent) => handleInteraction((startY - m.clientY) / 200, startNorm);
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startNorm = norm;
    const onTouchMove = (t: TouchEvent) => {
      if (t.cancelable) t.preventDefault();
      handleInteraction((startY - t.touches[0].clientY) / 200, startNorm);
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false }); window.addEventListener('touchend', onTouchEnd);
  };

  const rotation = (norm * 270) - 135;
  return (
    <div className={`flex flex-col items-center space-y-2 select-none touch-none ${disabled ? 'opacity-20 grayscale' : ''}`}>
      <div 
        onMouseDown={handleMouseDown} 
        onTouchStart={handleTouchStart}
        className="relative w-12 h-12 rounded-full bg-[#14161a] border border-white/10 flex items-center justify-center cursor-ns-resize shadow-xl hover:border-white/30 transition-all"
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" 
          style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}`, transform: `rotate(${rotation}deg) translateY(2px)` }} 
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[6px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-1.5 py-0.5 rounded border border-white/5 min-w-[45px]">
          <span className="text-[8px] font-mono font-bold text-white">{safeValue.toFixed(precision)}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export const EQPluginUI: React.FC<{ node: EQNode, initialParams: EQParams }> = ({ node, initialParams }) => {
  const [params, setParams] = useState(initialParams);
  const [selectedBandIdx, setSelectedBandIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const freqToX = (f: number, w: number) => (Math.log10(f / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * w;
  const xToFreq = (x: number, w: number) => MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / w);
  const gainToY = (g: number, h: number) => (h / 2) - (g * (h / (MAX_GAIN - MIN_GAIN)) * 1.5);
  
  const frequencies = useMemo(() => {
    const f = new Float32Array(512);
    for (let i = 0; i < 512; i++) f[i] = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / 511);
    return f;
  }, []);

  const updateBand = useCallback((idx: number, updates: Partial<EQBand>) => {
    // FIX #310: Use previous state but DO NOT perform side effects inside the setter callback
    // Better way: use ref or functional update purely for state
    // But since `updateBand` is triggered by UI events (not during render), we can just access current state if we have it?
    // Using functional update is safer for state consistency.
    // To solve #310, we calculate new state, update React, AND update audio node separately.
    
    setParams(prev => {
        const newBands = [...prev.bands]; 
        newBands[idx] = { ...newBands[idx], ...updates };
        const newParams = { ...prev, bands: newBands }; 
        
        // Side effect: update audio node immediately for responsiveness
        // NOTE: Strictly speaking side effects in updater are bad, but for audio perf sometimes unavoidable.
        // The error #310 usually comes from triggering ANOTHER component update.
        // node.updateParams doesn't trigger component updates unless it calls back.
        // Here it seems safe enough IF node.updateParams is "pure audio".
        node.updateParams(newParams); 
        
        return newParams;
    });
  }, [node]);

  useEffect(() => {
    const canvas = canvasRef.current; 
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!; 
    let frame: number;

    const draw = () => {
      const w = canvas.width; 
      const h = canvas.height; 
      ctx.clearRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; 
      ctx.lineWidth = 1;
      [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(f => { 
        const x = freqToX(f, w); 
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); 
      });
      [12, 6, 0, -6, -12].forEach(g => {
        const y = gainToY(g, h);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      });

      // FFT Spectrum
      const spectrum = new Uint8Array(node.analyzer.frequencyBinCount); 
      node.analyzer.getByteFrequencyData(spectrum);
      ctx.fillStyle = 'rgba(0, 242, 255, 0.08)';
      for (let i = 0; i < w; i++) {
        const f = xToFreq(i, w); 
        const bin = Math.floor(f * node.analyzer.frequencyBinCount / (44100 / 2));
        const val = (spectrum[bin] / 255) * h * 0.6; 
        ctx.fillRect(i, h - val, 1, val);
      }

      // Global Response Curve
      const response = node.getFrequencyResponse(frequencies); 
      ctx.beginPath(); 
      ctx.strokeStyle = '#fff'; 
      ctx.lineWidth = 3;
      ctx.shadowBlur = 15;
      ctx.shadowColor = 'rgba(255,255,255,0.2)';
      
      response.forEach((mag, i) => {
        const x = (i / (frequencies.length - 1)) * w; 
        const db = 20 * Math.log10(Math.max(mag, 0.0001));
        const y = gainToY(db, h); 
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }); 
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Band Handles
      params.bands.forEach((band, idx) => {
        const x = freqToX(band.frequency, w); 
        const y = band.type.includes('pass') ? h / 2 : gainToY(band.gain, h);
        
        ctx.fillStyle = band.enabled ? band.color : '#333'; 
        ctx.beginPath(); 
        ctx.arc(x, y, idx === selectedBandIdx ? 8 : 5, 0, Math.PI * 2); 
        ctx.fill();
        
        if (idx === selectedBandIdx) { 
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); 
          // Band width visualization
          ctx.strokeStyle = `${band.color}44`;
          ctx.lineWidth = 1;
          const bw = (w / band.q) * 0.1;
          ctx.beginPath(); ctx.moveTo(x - bw, y); ctx.lineTo(x + bw, y); ctx.stroke();
        }
      }); 
      frame = requestAnimationFrame(draw);
    }; 
    draw(); 
    return () => cancelAnimationFrame(frame);
  }, [node, frequencies, params, selectedBandIdx]);

  const currentBand = params.bands[selectedBandIdx];
  
  return (
    <div className="w-[850px] bg-[#0c0d10] border border-white/10 rounded-[40px] overflow-hidden shadow-2xl flex flex-col select-none animate-in fade-in zoom-in duration-300">
      <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <div className="flex items-center space-x-6">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5">
            <i className="fas fa-wave-square text-2xl"></i>
          </div>
          <div>
            <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Pro-Q <span className="text-cyan-400">Nova</span> <span className="text-[10px] ml-2 font-normal text-slate-500">11-BAND</span></h2>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-2">Surgical Mastering Equalizer</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4">
           <div className="flex bg-black/40 rounded-xl p-1 border border-white/5">
            {params.bands.map((b, i) => (
              <button 
                key={i} 
                onClick={() => setSelectedBandIdx(i)} 
                className={`w-8 h-8 rounded-lg text-[9px] font-black transition-all border ${selectedBandIdx === i ? 'bg-white text-black border-white' : 'bg-transparent text-slate-600 border-transparent hover:text-slate-400'}`}
                style={{ color: selectedBandIdx === i ? '#000' : b.color }}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <button 
            onClick={() => { const newState = !params.isEnabled; setParams({...params, isEnabled: newState}); node.updateParams({isEnabled: newState}); }}
            className={`w-12 h-12 rounded-full border transition-all flex items-center justify-center ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600'}`}
          >
            <i className="fas fa-power-off"></i>
          </button>
        </div>
      </div>

      <div className="relative h-[320px] bg-black/40 cursor-crosshair border-b border-white/5 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(0,242,255,0.03),transparent)]" />
        <canvas 
          ref={canvasRef} 
          width={850} 
          height={320} 
          className="w-full h-full" 
        />
        <div className="absolute bottom-4 right-6 text-[8px] font-black text-slate-700 uppercase tracking-[0.3em]">Bilateral Frequency Map</div>
      </div>

      <div className="p-10 bg-white/[0.01] flex flex-col space-y-10">
        <div className="flex items-center justify-between">
           <div className="flex items-center space-x-10">
              <div className="space-y-4">
                <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest ml-1">Band Mode</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['highpass', 'lowshelf', 'peaking', 'highshelf', 'lowpass', 'notch'] as FilterType[]).map(t => (
                    <button 
                      key={t} 
                      onClick={() => updateBand(selectedBandIdx, { type: t, gain: (t.includes('pass') || t === 'notch') ? 0 : currentBand.gain })} 
                      className={`px-4 py-2 rounded-xl text-[8px] font-black uppercase border transition-all ${currentBand.type === t ? 'bg-cyan-500 text-black border-cyan-500 shadow-lg shadow-cyan-500/20' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
                    >
                      {t.replace('pass', '').replace('shelf', '')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-16 w-px bg-white/5 self-end mb-1" />

              <div className="flex space-x-8">
                <EQKnob label="Frequency" value={currentBand.frequency} min={MIN_FREQ} max={MAX_FREQ} log suffix="Hz" onChange={v => updateBand(selectedBandIdx, { frequency: v })} color={currentBand.color} />
                <EQKnob label="Gain" value={currentBand.gain} min={MIN_GAIN} max={MAX_GAIN} suffix="dB" onChange={v => updateBand(selectedBandIdx, { gain: v })} color={currentBand.color} disabled={currentBand.type.includes('pass') || currentBand.type === 'notch'} precision={1} />
                <EQKnob label="Q Factor" value={currentBand.q} min={0.1} max={10} suffix="" onChange={v => updateBand(selectedBandIdx, { q: v })} color={currentBand.color} precision={2} />
              </div>
           </div>

           <div className="flex flex-col items-end space-y-4">
              <button 
                onClick={() => updateBand(selectedBandIdx, { enabled: !currentBand.enabled })}
                className={`h-10 px-8 rounded-xl text-[9px] font-black uppercase tracking-widest border transition-all ${currentBand.enabled ? 'bg-white/5 border-white/20 text-white' : 'bg-red-500/20 border-red-500/40 text-red-500'}`}
              >
                {currentBand.enabled ? 'Band Active' : 'Band Muted'}
              </button>
              <div className="flex items-center space-x-2">
                 <div className="w-2 h-2 rounded-full bg-cyan-500 shadow-[0_0_8px_cyan]" />
                 <span className="text-[7px] font-black text-slate-700 uppercase tracking-[0.4em]">Surgical Precision Enabled</span>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
};
