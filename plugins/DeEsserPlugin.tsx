
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createEnvelopeFollower, makeCurve } from './vocalDspUtils';

/**
 * MODULE FX_12 : PRO VOCAL DE-ESSER (v2.0)
 * ---------------------------------------
 * DSP: Advanced Split-Band processing with commutable Bell/Shelf modes.
 * Features: High-precision Q control, real-time GR Meter, and dynamic response curve.
 */

export type DeEsserMode = 'BELL' | 'SHELF';

export interface DeEsserParams {
  threshold: number;   // -60 to 0 dB
  frequency: number;   // 2000 to 12000 Hz
  q: number;           // 0.1 to 10.0 (Bell bandwidth)
  reduction: number;   // 0.0 to 1.0 (Mapping to compressor ratio/range)
  mode: DeEsserMode;
  isEnabled: boolean;
}

export class DeEsserNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  // EQ dynamique : une cloche (BELL) ou une etagere aigue (SHELF) dont le gain
  // en dB est pilote par le detecteur. A 0 dB le filtre est strictement neutre.
  // (L'ancienne version passait la bande dans un DynamicsCompressorNode : sa
  // pre-lecture de 6 ms dephasait la bande et son gain de compensation
  // automatique remontait les « s » faibles ; le mode SHELF, somme
  // passe-bas + passe-haut, creusait en permanence la frequence choisie.)
  private eqFilter: BiquadFilterNode;
  // Detection : filtre de bande -> redressement + lissage -> courbe de gain (dB)
  private detectFilter: BiquadFilterNode;
  private follower: ReturnType<typeof createEnvelopeFollower>;
  private gainComputer: WaveShaperNode;
  private enableGain: GainNode;
  private grMeter: AnalyserNode;
  private grData: Float32Array;
  private curveKey = '';
  public analyzer: AnalyserNode;

  private params: DeEsserParams = {
    threshold: -25,
    frequency: 6500,
    q: 1.0,
    reduction: 0.6,
    mode: 'BELL',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.eqFilter = ctx.createBiquadFilter();
    this.eqFilter.type = 'peaking';
    this.eqFilter.gain.value = 0;
    this.detectFilter = ctx.createBiquadFilter();
    this.detectFilter.type = 'bandpass';
    // Lissage ~60 Hz : reagit en quelques ms sur un « s » sans moduler la voix.
    this.follower = createEnvelopeFollower(ctx, 60);
    this.gainComputer = ctx.createWaveShaper();
    this.enableGain = ctx.createGain();
    this.grMeter = ctx.createAnalyser();
    this.grMeter.fftSize = 256;
    this.grData = new Float32Array(this.grMeter.fftSize);
    this.analyzer = ctx.createAnalyser();
    this.analyzer.fftSize = 512;
    this.setupChain();
  }

  private setupChain() {
    this.input.disconnect();
    // Chemin audio
    this.input.connect(this.eqFilter);
    this.eqFilter.connect(this.analyzer);
    this.analyzer.connect(this.output);
    // Chaine de commande (gain en dB ajoute au gain de base 0 dB du filtre)
    this.input.connect(this.detectFilter);
    this.detectFilter.connect(this.follower.input);
    this.follower.output.connect(this.gainComputer);
    this.gainComputer.connect(this.enableGain);
    this.enableGain.connect(this.eqFilter.gain);
    this.enableGain.connect(this.grMeter);
    this.applyParams();
  }

  /**
   * Courbe enveloppe -> reduction en dB : seuil, ratio 1..20 et reduction
   * maximale 4..18 dB selon « reduction », genou doux de 6 dB.
   */
  private updateGainCurve() {
    const T = Number.isFinite(this.params.threshold) ? this.params.threshold : -25;
    const r = Number.isFinite(this.params.reduction) ? Math.max(0, Math.min(1, this.params.reduction)) : 0.6;
    const key = `${T.toFixed(2)}:${r.toFixed(3)}`;
    if (key === this.curveKey) return;
    this.curveKey = key;
    const ratio = 1 + r * 19;
    const maxRange = r > 0 ? 4 + 14 * r : 0;
    const knee = 6;
    const slope = 1 / ratio - 1;
    this.gainComputer.curve = makeCurve(32769, x => {
      if (x <= 0 || r <= 0) return 0;
      const over = 20 * Math.log10(x) - T;
      let gr = 0;
      if (over >= knee / 2) gr = slope * over;
      else if (over > -knee / 2) gr = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      return Math.max(gr, -maxRange);
    });
  }

  public updateParams(p: Partial<DeEsserParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const { frequency, q, mode, isEnabled } = this.params;
    const freq = Number.isFinite(frequency) ? Math.max(1000, Math.min(16000, frequency)) : 6500;
    const qv = Number.isFinite(q) ? Math.max(0.1, Math.min(10, q)) : 1;
    if (mode === 'SHELF') {
      if (this.eqFilter.type !== 'highshelf') this.eqFilter.type = 'highshelf';
      if (this.detectFilter.type !== 'highpass') this.detectFilter.type = 'highpass';
      this.detectFilter.Q.setTargetAtTime(-3.01, now, 0.02);
    } else {
      if (this.eqFilter.type !== 'peaking') this.eqFilter.type = 'peaking';
      if (this.detectFilter.type !== 'bandpass') this.detectFilter.type = 'bandpass';
      this.eqFilter.Q.setTargetAtTime(qv, now, 0.02);
      this.detectFilter.Q.setTargetAtTime(qv, now, 0.02);
    }
    this.eqFilter.frequency.setTargetAtTime(freq, now, 0.02);
    this.detectFilter.frequency.setTargetAtTime(freq, now, 0.02);
    this.updateGainCurve();
    this.enableGain.gain.setTargetAtTime(isEnabled ? 1 : 0, now, 0.02);
  }

  /** Reduction de gain actuelle de la bande, en dB (valeur negative). */
  public getReduction(): number {
    this.grMeter.getFloatTimeDomainData(this.grData as any);
    let min = 0;
    for (let i = 0; i < this.grData.length; i++) if (this.grData[i] < min) min = this.grData[i];
    return min;
  }

  public getParams() { return { ...this.params }; }

  public dispose() {
    for (const n of [this.input, this.eqFilter, this.detectFilter, ...this.follower.nodes, this.gainComputer, this.enableGain, this.grMeter, this.analyzer]) {
      try { n.disconnect(); } catch (e) {}
    }
  }
}

interface VocalDeEsserUIProps {
  node: DeEsserNode;
  initialParams: DeEsserParams;
  onParamsChange?: (p: DeEsserParams) => void;
}

/**
 * VOCAL DE-ESSER UI (Converted to Functional Component for fix)
 */
export const VocalDeEsserUI: React.FC<VocalDeEsserUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<DeEsserParams>(initialParams);
  const paramsRef = useRef<DeEsserParams>(initialParams);
  const [reduction, setReduction] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof DeEsserParams | null>(null);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const { frequency, q, mode } = params;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    for (let i = 1; i < 10; i++) {
      const x = (i / 10) * w;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    const freqX = ((Math.log10(frequency || 6500) - Math.log10(2000)) / (Math.log10(12000) - Math.log10(2000))) * w;
    if (mode === 'SHELF') {
      ctx.moveTo(0, h/2);
      ctx.lineTo(freqX, h/2);
      ctx.lineTo(w, 20);
    } else {
      const qVal = q || 1.0;
      ctx.moveTo(0, h/2);
      ctx.lineTo(freqX - 40/qVal, h/2);
      ctx.lineTo(freqX, 20);
      ctx.lineTo(freqX + 40/qVal, h/2);
      ctx.lineTo(w, h/2);
    }
    ctx.stroke();
  }, [params]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      setReduction(node.getReduction());
      draw();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node, draw]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 200;
    
    // FIX #310: Access current state via ref
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    if (typeof currentVal !== 'number') return;
    
    let min = 0, max = 1;
    if (activeParam.current === 'threshold') { min = -60; max = 0; }
    if (activeParam.current === 'frequency') { min = 2000; max = 12000; }
    if (activeParam.current === 'q') { min = 0.1; max = 10.0; }
    if (activeParam.current === 'reduction') { min = 0; max = 1.0; }
    
    const newVal = Math.max(min, Math.min(max, currentVal + delta * (max - min)));
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

  const handleMouseDown = (param: keyof DeEsserParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const updateMode = (m: DeEsserMode) => {
    const newParams = { ...params, mode: m };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const togglePower = () => {
    const isEnabled = !params.isEnabled;
    const newParams = { ...params, isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[500px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-400 border border-red-500/20 shadow-lg shadow-red-500/5">
            <i className="fas fa-scissors text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">S-Killer <span className="text-red-400">Pro</span></h2>
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">Dynamic Sibilance Suppression</p>
          </div>
        </div>
        <button 
          onClick={togglePower}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-red-500 border-red-400 text-black shadow-lg shadow-red-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>
      <div className="h-32 bg-black/60 rounded-[28px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <canvas ref={canvasRef} width={420} height={128} className="w-full h-full opacity-60" />
        <div className="absolute top-4 left-6 flex flex-col">
           <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">S-Frequency: {Math.round(params.frequency)} Hz</span>
        </div>
        <div className="absolute right-6 top-1/2 -translate-y-1/2 w-4 h-24 bg-black/40 rounded-full border border-white/5 overflow-hidden">
           <div className="w-full bg-red-500 transition-all duration-75" style={{ height: `${Math.min(100, Math.abs(reduction) * 10)}%` }} />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4 px-2">
        <DeEsserKnob label="Threshold" value={params.threshold} min={-60} max={0} suffix="dB" color="#ef4444" onMouseDown={(e) => handleMouseDown('threshold', e)} displayVal={Math.round(params.threshold)} />
        <DeEsserKnob label="Frequency" value={params.frequency} min={2000} max={12000} suffix="Hz" color="#ef4444" onMouseDown={(e) => handleMouseDown('frequency', e)} displayVal={Math.round(params.frequency)} />
        <DeEsserKnob label="Q Factor" value={params.q} min={0.1} max={10.0} suffix="" color="#ef4444" onMouseDown={(e) => handleMouseDown('q', e)} displayVal={Number(params.q.toFixed(1))} />
        <DeEsserKnob label="Reduction" value={params.reduction} min={0} max={1.0} factor={100} suffix="%" color="#fff" onMouseDown={(e) => handleMouseDown('reduction', e)} displayVal={Math.round(params.reduction * 100)} />
      </div>
      <div className="flex bg-black/40 p-1 rounded-2xl border border-white/5">
        {(['BELL', 'SHELF'] as DeEsserMode[]).map(m => (
          <button key={m} onClick={() => updateMode(m)} className={`flex-1 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${params.mode === m ? 'bg-red-500 text-white shadow-lg shadow-red-500/40' : 'text-slate-500 hover:text-white'}`}>{m}</button>
        ))}
      </div>
    </div>
  );
};

const DeEsserKnob: React.FC<{ label: string, value: number, onMouseDown: (e: React.MouseEvent) => void, color: string, min: number, max: number, suffix: string, displayVal: number, factor?: number }> = ({ label, value, onMouseDown, color, min, max, suffix, displayVal }) => {
  const norm = (value - min) / (max - min);
  const rotation = (norm * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-2 group">
      <div onMouseDown={onMouseDown} className="w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-red-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color }} />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5"><span className="text-[8px] font-mono font-bold text-white">{displayVal}{suffix}</span></div>
      </div>
    </div>
  );
};
