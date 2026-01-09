
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

/**
 * MODULE FX_01 : PRO-EQ 12 (SURGICAL GRADE)
 */

export type ProEQFilterType = 'peaking' | 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'notch';

export interface ProEQBand {
  id: number;
  type: ProEQFilterType;
  frequency: number;
  gain: number;
  q: number;
  isEnabled: boolean;
  isSolo: boolean;
  color?: string;
}

export interface ProEQ12Params {
  bands: ProEQBand[];
  isEnabled: boolean;
  masterGain: number;
}

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const DB_SCALE = 30; 
const MAX_GAIN = DB_SCALE;
const MIN_GAIN = -DB_SCALE;

export class ProEQ12Node {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  public preAnalyzer: AnalyserNode;
  public postAnalyzer: AnalyserNode;
  private filters: BiquadFilterNode[] = [];
  private params: ProEQ12Params;

  constructor(ctx: AudioContext, initialParams: ProEQ12Params) {
    this.ctx = ctx;
    this.params = initialParams;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.preAnalyzer = ctx.createAnalyser();
    this.preAnalyzer.fftSize = 4096;
    this.preAnalyzer.smoothingTimeConstant = 0.85;
    this.postAnalyzer = ctx.createAnalyser();
    this.postAnalyzer.fftSize = 4096;
    this.postAnalyzer.smoothingTimeConstant = 0.85;
    this.setupFilters();
  }

  private setupFilters() {
    this.input.disconnect();
    this.preAnalyzer.disconnect();
    this.filters.forEach(f => f.disconnect());
    this.postAnalyzer.disconnect();
    this.filters = [];

    this.input.connect(this.preAnalyzer);
    let lastNode: AudioNode = this.preAnalyzer;
    const soloIdx = this.params.bands.findIndex(b => b.isSolo && b.isEnabled);

    for (let i = 0; i < 12; i++) {
      const band = this.params.bands[i];
      const filter = this.ctx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.frequency;
      filter.gain.value = band.gain;
      filter.Q.value = band.q;
      const active = soloIdx === -1 ? (band.isEnabled && this.params.isEnabled) : (i === soloIdx);
      if (active) { 
        lastNode.connect(filter); 
        lastNode = filter; 
      }
      this.filters.push(filter);
    }
    lastNode.connect(this.postAnalyzer);
    this.postAnalyzer.connect(this.output);
  }

  public updateParams(p: Partial<ProEQ12Params>) {
    const reconnectNeeded = p.isEnabled !== undefined || p.bands?.some((b, i) => b.isEnabled !== this.params.bands[i].isEnabled || b.isSolo !== this.params.bands[i].isSolo || b.type !== this.params.bands[i].type);
    this.params = { ...this.params, ...p };
    
    if (reconnectNeeded) {
      this.setupFilters();
    } else {
      const now = this.ctx.currentTime;
      const safe = (v: number) => Number.isFinite(v) ? v : 0;
      this.params.bands.forEach((band, i) => {
        const f = this.filters[i];
        if (f) {
          f.frequency.setTargetAtTime(safe(band.frequency), now, 0.04);
          f.gain.setTargetAtTime(safe(band.gain), now, 0.04);
          f.Q.setTargetAtTime(safe(band.q), now, 0.04);
        }
      });
    }
  }

  public getFrequencyResponse(freqs: Float32Array): Float32Array {
    const totalMag = new Float32Array(freqs.length).fill(1.0);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    this.filters.forEach((f, i) => {
      if (this.params.bands[i].isEnabled && this.params.isEnabled) {
        f.getFrequencyResponse(freqs, mag, phase);
        for (let j = 0; j < freqs.length; j++) totalMag[j] *= mag[j];
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
  
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startNorm = norm;
    const onMouseMove = (m: MouseEvent) => {
      const delta = (startY - m.clientY) / 200;
      const newNorm = Math.max(0, Math.min(1, startNorm + delta));
      const val = log ? min * Math.pow(max / min, newNorm) : min + newNorm * (max - min);
      onChange(val);
    };
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startNorm = norm;
    const onTouchMove = (t: TouchEvent) => {
      if (t.cancelable) t.preventDefault();
      const delta = (startY - t.touches[0].clientY) / 200;
      const newNorm = Math.max(0, Math.min(1, startNorm + delta));
      const val = log ? min * Math.pow(max / min, newNorm) : min + newNorm * (max - min);
      onChange(val);
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false }); window.addEventListener('touchend', onTouchEnd);
  };

  const rotation = (norm * 270) - 135;
  return (
    <div className={`flex flex-col items-center space-y-2 select-none touch-none ${disabled ? 'opacity-20 grayscale' : ''}`}>
      <div onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} className="relative w-12 h-12 rounded-full bg-[#14161a] border border-white/10 flex items-center justify-center cursor-ns-resize shadow-xl hover:border-white/30 transition-all">
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}`, transform: `rotate(${rotation}deg) translateY(2px)` }} />
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

export const ProEQ12UI: React.FC<{ node: ProEQ12Node, initialParams: ProEQ12Params, onParamsChange?: (p: ProEQ12Params) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const [selectedBandIdx, setSelectedBandIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const freqToX = (f: number, w: number) => (Math.log10(f / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * w;
  const xToFreq = (x: number, w: number) => MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / w);
  const dbToY = (db: number, h: number) => h - (Math.max(0, Math.min(1, (db + DB_SCALE) / (DB_SCALE * 2))) * h);
  const yToDb = (y: number, h: number) => ((1 - (y / h)) * (DB_SCALE * 2)) - DB_SCALE;

  const frequencies = useMemo(() => {
    const f = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) f[i] = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / 1023);
    return f;
  }, []);

  const updateBand = useCallback((idx: number, updates: Partial<ProEQBand>) => {
    // Refactored to avoid side-effects inside setState
    const newBands = [...params.bands];
    newBands[idx] = { ...newBands[idx], ...updates };
    const newParams = { ...params, bands: newBands };
    
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  const handleGraphInteraction = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect(); 
    if (!rect) return;
    const x = clientX - rect.left; 
    const y = clientY - rect.top;
    
    // Find band
    let closestIdx = -1; let minDist = 30;
    params.bands.forEach((b, i) => {
      const bx = freqToX(b.frequency, rect.width); 
      const by = b.type.includes('pass') ? rect.height / 2 : dbToY(b.gain, rect.height);
      const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2);
      if (dist < minDist) { minDist = dist; closestIdx = i; }
    });

    if (closestIdx !== -1) {
      setSelectedBandIdx(closestIdx);
      return { idx: closestIdx, startX: clientX, startY: clientY, startFreq: params.bands[closestIdx].frequency, startGain: params.bands[closestIdx].gain };
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const data = handleGraphInteraction(e.clientX, e.clientY);
    if (!data) return;
    const rect = canvasRef.current!.getBoundingClientRect();

    const onMouseMove = (m: MouseEvent) => {
      const dx = m.clientX - data.startX; 
      const dy = data.startY - m.clientY;
      const curX = freqToX(data.startFreq, rect.width) + dx;
      const newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToFreq(Math.max(0, Math.min(rect.width, curX)), rect.width)));
      let newGain = data.startGain + (dy / (rect.height / 2)) * MAX_GAIN;
      if (params.bands[data.idx].type.includes('pass')) newGain = 0;
      else newGain = Math.max(-DB_SCALE, Math.min(DB_SCALE, newGain));
      updateBand(data.idx, { frequency: newFreq, gain: newGain });
    };
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    const data = handleGraphInteraction(touch.clientX, touch.clientY);
    if (!data) return;
    const rect = canvasRef.current!.getBoundingClientRect();

    const onTouchMove = (t: TouchEvent) => {
      if (t.cancelable) t.preventDefault();
      const m = t.touches[0];
      const dx = m.clientX - data.startX; 
      const dy = data.startY - m.clientY;
      const curX = freqToX(data.startFreq, rect.width) + dx;
      const newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToFreq(Math.max(0, Math.min(rect.width, curX)), rect.width)));
      let newGain = data.startGain + (dy / (rect.height / 2)) * MAX_GAIN;
      if (params.bands[data.idx].type.includes('pass')) newGain = 0;
      else newGain = Math.max(-DB_SCALE, Math.min(DB_SCALE, newGain));
      updateBand(data.idx, { frequency: newFreq, gain: newGain });
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false }); window.addEventListener('touchend', onTouchEnd);
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && (canvas.width !== rect.width || canvas.height !== rect.height)) { canvas.width = rect.width; canvas.height = rect.height; }
    const w = canvas.width; const h = canvas.height;

    ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1; ctx.strokeStyle = '#1e2229'; ctx.beginPath();
    [30, 60, 100, 200, 500, 1000, 2000, 5000, 10000, 15000].forEach(f => { const x = freqToX(f, w); ctx.moveTo(x, 0); ctx.lineTo(x, h); });
    [-18, -12, -6, 0, 6, 12, 18].forEach(db => { const y = dbToY(db, h); ctx.moveTo(0, y); ctx.lineTo(w, y); });
    ctx.stroke();
    
    ctx.strokeStyle = '#334155'; ctx.beginPath(); const zeroY = dbToY(0, h); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();

    const binCount = node.preAnalyzer.frequencyBinCount;
    const postData = new Uint8Array(binCount);
    node.postAnalyzer.getByteFrequencyData(postData);
    const step = Math.ceil(binCount / w); 
    
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < binCount; i += step) {
        const freq = i * (node.preAnalyzer.context.sampleRate / 2) / binCount;
        if (freq < MIN_FREQ) continue; if (freq > MAX_FREQ) break;
        const x = freqToX(freq, w);
        const y = h - ((postData[i] / 255) * h); 
        ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fillStyle = 'rgba(6, 182, 212, 0.2)'; ctx.fill();

    const resp = node.getFrequencyResponse(frequencies);
    ctx.beginPath(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    for(let i=0; i<frequencies.length; i++) {
        const x = freqToX(frequencies[i], w);
        const db = 20 * Math.log10(Math.max(resp[i], 0.00001));
        const y = dbToY(db, h);
        if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    params.bands.forEach((b, i) => {
      const x = freqToX(b.frequency, w);
      const y = b.type.includes('pass') ? h / 2 : dbToY(b.gain, h);
      ctx.beginPath(); ctx.arc(x, y, selectedBandIdx === i ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = b.isEnabled ? (selectedBandIdx === i ? '#fff' : 'rgba(255,255,255,0.7)') : '#333';
      ctx.fill();
      if (selectedBandIdx === i) {
        ctx.strokeStyle = '#00f2ff'; ctx.lineWidth = 2; ctx.stroke();
      }
    });
  }, [node, frequencies, params, selectedBandIdx]);

  useEffect(() => {
    let animFrame = 0; const loop = () => { draw(); animFrame = requestAnimationFrame(loop); };
    animFrame = requestAnimationFrame(loop); return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const currentBand = params.bands[selectedBandIdx];
  
  return (
    <div className="w-[850px] bg-[#0c0d10] border border-white/10 rounded-[40px] overflow-hidden shadow-2xl flex flex-col select-none animate-in fade-in zoom-in duration-300">
      <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <div className="flex items-center space-x-6">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5"><i className="fas fa-wave-square text-2xl"></i></div>
          <div><h2 className="text-2xl font-black italic text-white uppercase tracking-tighter leading-none">Pro-Q <span className="text-cyan-400">Nova</span> <span className="text-[10px] ml-2 font-normal text-slate-500">11-BAND</span></h2><p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-2">Surgical Mastering Equalizer</p></div>
        </div>
        
        <div className="flex items-center space-x-4">
           <div className="flex bg-black/40 rounded-xl p-1 border border-white/5">
            {params.bands.map((b, i) => (
              <button 
                key={i} 
                onClick={() => setSelectedBandIdx(i)} 
                className={`w-8 h-8 rounded-lg text-[9px] font-black transition-all border ${selectedBandIdx === i ? 'bg-white text-black border-white' : 'bg-transparent text-slate-600 border-transparent hover:text-slate-400'}`}
                style={{ color: selectedBandIdx === i ? '#000' : b.color || '#fff' }}
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

      <div ref={containerRef} className="relative h-[320px] bg-black/40 cursor-crosshair border-b border-white/5 overflow-hidden" onWheel={(e) => { const delta = e.deltaY > 0 ? -0.1 : 0.1; updateBand(selectedBandIdx, { q: Math.max(0.1, Math.min(10, currentBand.q + delta)) }); }}>
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(0,242,255,0.03),transparent)]" />
        <canvas ref={canvasRef} className="w-full h-full touch-none" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
        <div className="absolute bottom-4 right-6 text-[8px] font-black text-slate-700 uppercase tracking-[0.3em]">Bilateral Frequency Map</div>
      </div>

      <div className="p-10 bg-white/[0.01] flex flex-col space-y-10">
        <div className="flex items-center justify-between">
           <div className="flex items-center space-x-10">
              <div className="space-y-4">
                <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest ml-1">Band Mode</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['highpass', 'lowshelf', 'peaking', 'highshelf', 'lowpass', 'notch'] as ProEQFilterType[]).map(t => (
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
                <EQKnob label="Frequency" value={currentBand.frequency} min={MIN_FREQ} max={MAX_FREQ} log suffix="Hz" onChange={v => updateBand(selectedBandIdx, { frequency: v })} color={currentBand.color || '#fff'} />
                <EQKnob label="Gain" value={currentBand.gain} min={MIN_GAIN} max={MAX_GAIN} suffix="dB" onChange={v => updateBand(selectedBandIdx, { gain: v })} color={currentBand.color || '#fff'} disabled={currentBand.type.includes('pass') || currentBand.type === 'notch'} precision={1} />
                <EQKnob label="Q Factor" value={currentBand.q} min={0.1} max={10} suffix="" onChange={v => updateBand(selectedBandIdx, { q: v })} color={currentBand.color || '#fff'} precision={2} />
              </div>
           </div>

           <div className="flex flex-col items-end space-y-4">
              <button 
                onClick={() => updateBand(selectedBandIdx, { isEnabled: !currentBand.isEnabled })}
                className={`h-10 px-8 rounded-xl text-[9px] font-black uppercase tracking-widest border transition-all ${currentBand.isEnabled ? 'bg-white/5 border-white/20 text-white' : 'bg-red-500/20 border-red-500/40 text-red-500'}`}
              >
                {currentBand.isEnabled ? 'Band Active' : 'Band Muted'}
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
