
import React, { useState, useEffect, useRef, useCallback } from 'react';

// Export constants for use in other plugins (MasterSync)
export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = ['CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC'];

// --- WORKLET CODE INLINED TO PREVENT 404 ERRORS ---
const WORKLET_CODE = `
class AutoTuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.bufferMask = this.bufferSize - 1;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.analysisBuffer = new Float32Array(1024);
    this.analysisIndex = 0;
    this.lastDetectedFreq = 440;
    this.framesSinceLastAnalysis = 0;
    this.phase = 0;
    this.grainSize = 2048;
    this.currentRatio = 1.0;
    this.scales = {
      'CHROMATIC': [0,1,2,3,4,5,6,7,8,9,10,11],
      'MAJOR': [0,2,4,5,7,9,11],
      'MINOR': [0,2,3,5,7,8,10],
      'MINOR_HARMONIC': [0,2,3,5,7,8,11],
      'PENTATONIC': [0,3,5,7,10]
    };
  }
  static get parameterDescriptors() {
    return [
      { name: 'retuneSpeed', defaultValue: 0.1, minValue: 0.0, maxValue: 1.0 },
      { name: 'amount', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'rootKey', defaultValue: 0, minValue: 0, maxValue: 11 },
      { name: 'scaleType', defaultValue: 0, minValue: 0, maxValue: 4 },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 }
    ];
  }
  detectPitch(buffer, sampleRate) {
    const SIZE = buffer.length;
    let bestOffset = -1;
    let bestCorrelation = 0;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return 0;
    const minPeriod = 44; 
    const maxPeriod = 551;
    for (let offset = minPeriod; offset < maxPeriod; offset++) {
      let correlation = 0;
      for (let i = 0; i < SIZE - maxPeriod; i += 2) { 
        correlation += buffer[i] * buffer[i + offset];
      }
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = offset;
      }
    }
    if (bestCorrelation > 0.01 && bestOffset > 0) {
      return sampleRate / bestOffset;
    }
    return 0;
  }
  getNearestFreq(inputFreq, rootKey, scaleIdx) {
    if (inputFreq <= 0) return inputFreq;
    const midi = 69 + 12 * Math.log2(inputFreq / 440);
    const note = Math.round(midi);
    const noteInOctave = note % 12;
    const scaleNames = ['CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC'];
    const currentScale = this.scales[scaleNames[scaleIdx]] || this.scales['CHROMATIC'];
    const normalizedNote = (noteInOctave - rootKey + 12) % 12;
    let minDiff = Infinity;
    let targetNormalized = normalizedNote;
    for (let i = 0; i < currentScale.length; i++) {
      const scaleNote = currentScale[i];
      let diff = Math.abs(normalizedNote - scaleNote);
      if (diff > 6) diff = 12 - diff;
      if (diff < minDiff) {
        minDiff = diff;
        targetNormalized = scaleNote;
      }
    }
    let octaveShift = 0;
    const rawDiff = targetNormalized - normalizedNote;
    if (rawDiff > 6) octaveShift = -1;
    if (rawDiff < -6) octaveShift = 1;
    const targetMidi = (Math.floor(midi / 12) + octaveShift) * 12 + targetNormalized + rootKey;
    return 440 * Math.pow(2, (targetMidi - 69) / 12);
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (parameters.bypass[0] > 0.5) {
      if (input[0]) output[0].set(input[0]);
      return true;
    }
    if (!input || !input[0]) return true;
    const channelData = input[0];
    const outData = output[0];
    const blockSize = channelData.length;
    const retuneSpeed = parameters.retuneSpeed[0];
    const rootKey = Math.round(parameters.rootKey[0]);
    const scaleType = Math.round(parameters.scaleType[0]);
    const amount = parameters.amount[0];
    if (this.analysisIndex + blockSize < this.analysisBuffer.length) {
      this.analysisBuffer.set(channelData, this.analysisIndex);
      this.analysisIndex += blockSize;
    } else {
      const detected = this.detectPitch(this.analysisBuffer, sampleRate);
      if (detected > 0) {
        this.lastDetectedFreq = detected;
      }
      this.analysisIndex = 0;
    }
    const targetFreq = this.getNearestFreq(this.lastDetectedFreq, rootKey, scaleType);
    let targetRatio = 1.0;
    if (this.lastDetectedFreq > 0 && targetFreq > 0) {
      targetRatio = targetFreq / this.lastDetectedFreq;
    }
    targetRatio = Math.max(0.5, Math.min(2.0, targetRatio));
    const smoothing = 1.0 - (retuneSpeed * 0.95); 
    this.currentRatio += (targetRatio - this.currentRatio) * smoothing;
    for (let i = 0; i < blockSize; i++) {
      this.buffer[this.writeIndex] = channelData[i];
      this.phase += (1.0 - this.currentRatio) / this.grainSize; 
      if (this.phase < 0) this.phase += 1;
      if (this.phase >= 1) this.phase -= 1;
      const offsetA = this.phase * this.grainSize;
      const offsetB = ((this.phase + 0.5) % 1) * this.grainSize;
      let readIdxA = this.writeIndex - offsetA;
      let readIdxB = this.writeIndex - offsetB;
      if (readIdxA < 0) readIdxA += this.bufferSize;
      if (readIdxB < 0) readIdxB += this.bufferSize;
      const idxA_Int = Math.floor(readIdxA);
      const fracA = readIdxA - idxA_Int;
      const sampleA = this.buffer[idxA_Int & this.bufferMask] * (1 - fracA) + 
                      this.buffer[(idxA_Int + 1) & this.bufferMask] * fracA;
      const idxB_Int = Math.floor(readIdxB);
      const fracB = readIdxB - idxB_Int;
      const sampleB = this.buffer[idxB_Int & this.bufferMask] * (1 - fracB) + 
                      this.buffer[(idxB_Int + 1) & this.bufferMask] * fracB;
      let weightA = 0.5 * (1 - Math.cos(2 * Math.PI * this.phase));
      let weightB = 0.5 * (1 - Math.cos(2 * Math.PI * ((this.phase + 0.5) % 1)));
      const wetSignal = (sampleA * weightA) + (sampleB * weightB);
      outData[i] = (wetSignal * amount) + (channelData[i] * (1 - amount));
      this.writeIndex = (this.writeIndex + 1) & this.bufferMask;
    }
    if (this.framesSinceLastAnalysis++ > 5) {
      this.port.postMessage({
        detectedFreq: this.lastDetectedFreq,
        targetFreq: targetFreq,
        correctionCents: 1200 * Math.log2(targetRatio || 1)
      });
      this.framesSinceLastAnalysis = 0;
    }
    return true;
  }
}
registerProcessor('auto-tune-processor', AutoTuneProcessor);
`;

export interface AutoTuneParams {
  speed: number;      // 0.0 to 1.0 (Mapped to retuneSpeed)
  humanize: number;   // Visual only for now (or maps to granular window size)
  mix: number;        // 0.0 to 1.0
  rootKey: number;    // 0 to 11
  scale: string;      // Scale Name
  isEnabled: boolean;
}

export class AutoTuneNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private worklet: AudioWorkletNode | null = null;
  private onStatusCallback: ((data: any) => void) | null = null;

  private params: AutoTuneParams = {
    speed: 0.1,
    humanize: 0.2,
    mix: 1.0,
    rootKey: 0,
    scale: 'CHROMATIC',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.initWorklet();
  }

  private async initWorklet() {
    try {
      // Create a Blob from the inlined code
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      
      await this.ctx.audioWorklet.addModule(url);

      this.worklet = new AudioWorkletNode(this.ctx, 'auto-tune-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        parameterData: {
          retuneSpeed: this.params.speed,
          amount: this.params.mix,
          rootKey: this.params.rootKey,
          scaleType: SCALES.indexOf(this.params.scale)
        }
      });

      this.worklet.port.onmessage = (event) => {
        if (this.onStatusCallback) {
          this.onStatusCallback(event.data);
        }
      };

      this.input.disconnect();
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
      
      this.applyParams(); 

    } catch (e) {
      console.error("[AutoTune] Worklet Load Error:", e);
      // Fallback: Bypass if fails
      this.input.connect(this.output);
    }
  }

  public updateParams(p: Partial<AutoTuneParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    if (!this.worklet) return;

    const { speed, mix, rootKey, scale, isEnabled } = this.params;
    const params = this.worklet.parameters;
    const now = this.ctx.currentTime;
    
    params.get('bypass')?.setValueAtTime(isEnabled ? 0 : 1, now);
    params.get('retuneSpeed')?.setTargetAtTime(speed, now, 0.01);
    params.get('amount')?.setTargetAtTime(mix, now, 0.01);
    params.get('rootKey')?.setValueAtTime(rootKey, now);
    const scaleIdx = SCALES.indexOf(scale);
    params.get('scaleType')?.setValueAtTime(scaleIdx >= 0 ? scaleIdx : 0, now);
  }

  public setStatusCallback(cb: (data: any) => void) {
    this.onStatusCallback = cb;
  }
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
        const x = (w / 2) + (offset / 100) * (w / 2); 

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

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 150;
    
    // FIX #310: Use ref to get current state, do not use functional update for side effects
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    
    if (typeof currentVal !== 'number') return;
    
    const newVal = Math.max(0, Math.min(1, currentVal + delta));
    const newParams = { ...currentParams, [activeParam.current!]: newVal };
    
    setParams(newParams);
    node.updateParams(newParams);
    
    if (onParamsChange) {
        // We call this directly, assuming parent handles it efficiently or debounces if needed.
        // The issue #310 comes from calling this inside setParams(prev => ... here ...).
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
    <div className="flex flex-col items-center space-y-3 group">
      <div 
        onMouseDown={onMouseDown} 
        className="w-16 h-16 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75" 
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: '#00f2ff', boxShadow: '0 0 10px #00f2ff' }} 
        />
        <div className="absolute inset-5 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1.5">{label}</span>
        <div className="bg-black/60 px-3 py-1 rounded-lg border border-white/5 min-w-[55px]">
          <span className="text-[10px] font-mono font-bold text-cyan-400">{displayValue}</span>
        </div>
      </div>
    </div>
  );
};
