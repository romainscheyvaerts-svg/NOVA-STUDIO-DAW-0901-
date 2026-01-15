import React, { useEffect, useRef, useState, useCallback } from 'react';

/**
 * PROFESSIONAL DIMENSION CHORUS v3.0
 * ==================================
 * Inspired by classic hardware:
 * - Roland Dimension D (BBD-based chorus)
 * - Boss CE-1 Chorus Ensemble
 * - TC Electronic Corona
 * 
 * Features:
 * - Tri-Chorus mode (3 independent voices)
 * - Multiple LFO shapes (Sine, Triangle, Random)
 * - Low-cut filter to keep bass tight
 * - High-cut filter to reduce harshness
 * - Feedback for flanging effects
 * - Stereo spread control
 */

export type ChorusMode = 'CLASSIC' | 'TRI_CHORUS' | 'DIMENSION' | 'ENSEMBLE' | 'VIBRATO';
export type LFOShape = 'SINE' | 'TRIANGLE' | 'RANDOM';

export interface ChorusParams {
  rate: number;       // 0.1 to 8 Hz
  depth: number;      // 0 to 1
  spread: number;     // 0 to 1 (Stereo Width / Phase Offset)
  mix: number;        // 0 to 1 (Dry/Wet)
  feedback: number;   // 0 to 0.95 (for flanger-like effects)
  lowCut: number;     // 20 to 500 Hz
  highCut: number;    // 2000 to 20000 Hz
  mode: ChorusMode;
  lfoShape: LFOShape;
  voices: number;     // 1 to 4
  isEnabled: boolean;
}

// Voice structure for multi-voice chorus
interface ChorusVoice {
  delay: DelayNode;
  lfo: OscillatorNode;
  depthGain: GainNode;
  feedbackGain: GainNode;
  panner: StereoPannerNode;
}

export class ChorusNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private dryGain: GainNode;
  private wetGain: GainNode;
  
  // Filters
  private lowCutFilter: BiquadFilterNode;
  private highCutFilter: BiquadFilterNode;
  
  // Multiple voices for tri-chorus
  private voices: ChorusVoice[] = [];
  private maxVoices = 4;
  
  // Random LFO (for S&H style modulation)
  private randomLFOInterval: number | null = null;
  private randomLFOValues: number[] = [0, 0, 0, 0];
  
  // Metering
  public analyzerL: AnalyserNode;
  public analyzerR: AnalyserNode;

  private params: ChorusParams = {
    rate: 1.2,
    depth: 0.35,
    spread: 0.8,
    mix: 0.4,
    feedback: 0,
    lowCut: 100,
    highCut: 12000,
    mode: 'CLASSIC',
    lfoShape: 'SINE',
    voices: 2,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    
    // Filters
    this.lowCutFilter = ctx.createBiquadFilter();
    this.lowCutFilter.type = 'highpass';
    this.lowCutFilter.frequency.value = 100;
    this.lowCutFilter.Q.value = 0.5;
    
    this.highCutFilter = ctx.createBiquadFilter();
    this.highCutFilter.type = 'lowpass';
    this.highCutFilter.frequency.value = 12000;
    this.highCutFilter.Q.value = 0.5;
    
    // Analyzers for visualization
    this.analyzerL = ctx.createAnalyser();
    this.analyzerL.fftSize = 256;
    this.analyzerR = ctx.createAnalyser();
    this.analyzerR.fftSize = 256;
    
    // Create voices
    this.createVoices();
    this.setupGraph();
    this.startRandomLFO();
  }

  private createVoices() {
    // Voice configurations for different phase offsets
    const phaseOffsets = [0, 0.25, 0.5, 0.75]; // In cycles (0-1)
    const panPositions = [-0.8, 0.8, -0.4, 0.4];
    
    for (let i = 0; i < this.maxVoices; i++) {
      const delay = this.ctx.createDelay(0.1);
      delay.delayTime.value = 0.007 + i * 0.003; // Slightly offset base delays
      
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 1.2;
      
      const depthGain = this.ctx.createGain();
      depthGain.gain.value = 0.002;
      
      const feedbackGain = this.ctx.createGain();
      feedbackGain.gain.value = 0;
      
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = panPositions[i];
      
      // Connect LFO to delay time
      lfo.connect(depthGain);
      depthGain.connect(delay.delayTime);
      
      // Start LFO with phase offset
      const startTime = this.ctx.currentTime;
      lfo.start(startTime);
      
      this.voices.push({
        delay,
        lfo,
        depthGain,
        feedbackGain,
        panner
      });
    }
  }

  private setupGraph() {
    // Dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    
    // Wet path through filters
    this.input.connect(this.lowCutFilter);
    this.lowCutFilter.connect(this.highCutFilter);
    
    // Connect each voice
    for (let i = 0; i < this.maxVoices; i++) {
      const voice = this.voices[i];
      
      // Input -> Delay -> Panner -> Wet output
      this.highCutFilter.connect(voice.delay);
      voice.delay.connect(voice.panner);
      voice.panner.connect(this.wetGain);
      
      // Feedback path
      voice.delay.connect(voice.feedbackGain);
      voice.feedbackGain.connect(voice.delay);
    }
    
    this.wetGain.connect(this.output);
    
    // Output to analyzers
    const splitter = this.ctx.createChannelSplitter(2);
    this.output.connect(splitter);
    splitter.connect(this.analyzerL, 0);
    splitter.connect(this.analyzerR, 1);
    
    this.applyParams();
  }

  private startRandomLFO() {
    // Update random LFO values at rate-dependent intervals
    this.randomLFOInterval = window.setInterval(() => {
      if (this.params.lfoShape === 'RANDOM') {
        for (let i = 0; i < this.maxVoices; i++) {
          this.randomLFOValues[i] = (Math.random() - 0.5) * 2;
        }
      }
    }, 100); // Update every 100ms
  }

  public updateParams(p: Partial<ChorusParams>) {
    const oldMode = this.params.mode;
    const oldShape = this.params.lfoShape;
    
    this.params = { ...this.params, ...p };
    
    // Update LFO shapes if changed
    if (p.lfoShape !== undefined && p.lfoShape !== oldShape) {
      this.updateLFOShapes();
    }
    
    // Update voice count and parameters based on mode
    if (p.mode !== undefined && p.mode !== oldMode) {
      this.updateModeParameters();
    }
    
    this.applyParams();
  }

  private updateLFOShapes() {
    const shapeMap: Record<LFOShape, OscillatorType> = {
      'SINE': 'sine',
      'TRIANGLE': 'triangle',
      'RANDOM': 'sine' // Random uses sine but with S&H modulation
    };
    
    for (const voice of this.voices) {
      voice.lfo.type = shapeMap[this.params.lfoShape];
    }
  }

  private updateModeParameters() {
    // Preset parameters based on mode
    switch (this.params.mode) {
      case 'CLASSIC':
        // Standard chorus - 2 voices, moderate settings
        this.params.voices = 2;
        this.params.feedback = 0;
        break;
      case 'TRI_CHORUS':
        // Roland Dimension D style - 3 voices with specific phase relationships
        this.params.voices = 3;
        this.params.feedback = 0;
        break;
      case 'DIMENSION':
        // Rich dimensional effect - 4 voices
        this.params.voices = 4;
        this.params.feedback = 0.1;
        break;
      case 'ENSEMBLE':
        // String ensemble style - wider depth
        this.params.voices = 4;
        this.params.depth = Math.max(this.params.depth, 0.6);
        this.params.feedback = 0.15;
        break;
      case 'VIBRATO':
        // 100% wet, single voice
        this.params.voices = 1;
        this.params.mix = 1.0;
        this.params.feedback = 0;
        break;
    }
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number, d: number) => Number.isFinite(v) ? v : d;
    const { rate, depth, spread, mix, feedback, lowCut, highCut, voices, mode, isEnabled } = this.params;

    // Filters
    this.lowCutFilter.frequency.setTargetAtTime(safe(lowCut, 100), now, 0.02);
    this.highCutFilter.frequency.setTargetAtTime(safe(highCut, 12000), now, 0.02);

    if (isEnabled) {
      // Mix (use equal-power crossfade for vibrato mode)
      const sMix = safe(mix, 0.4);
      if (mode === 'VIBRATO') {
        this.dryGain.gain.setTargetAtTime(0, now, 0.02);
        this.wetGain.gain.setTargetAtTime(1, now, 0.02);
      } else {
        this.dryGain.gain.setTargetAtTime(Math.cos(sMix * Math.PI * 0.5), now, 0.02);
        this.wetGain.gain.setTargetAtTime(Math.sin(sMix * Math.PI * 0.5), now, 0.02);
      }
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }

    // Voice parameters
    const activeVoices = Math.min(voices, this.maxVoices);
    const sRate = safe(rate, 1.0);
    const sDepth = safe(depth, 0.35);
    const sSpread = safe(spread, 0.8);
    const sFeedback = safe(feedback, 0);

    // Phase offsets for different modes
    const phaseOffsets = mode === 'TRI_CHORUS' 
      ? [0, 0.33, 0.67, 1] // Equal 120° spacing
      : [0, 0.25, 0.5, 0.75]; // 90° spacing

    const panPositions = this.calculatePanPositions(activeVoices, sSpread);

    for (let i = 0; i < this.maxVoices; i++) {
      const voice = this.voices[i];
      const isActive = i < activeVoices && isEnabled;
      
      // Rate with slight detuning between voices for richness
      const voiceRate = sRate * (1 + i * 0.03);
      voice.lfo.frequency.setTargetAtTime(voiceRate, now, 0.02);
      
      // Depth - calculate based on mode
      let voiceDepth = sDepth * 0.003; // Base depth in seconds
      if (mode === 'ENSEMBLE') {
        voiceDepth *= (1 + i * 0.2); // More depth variation for ensemble
      }
      voice.depthGain.gain.setTargetAtTime(isActive ? voiceDepth : 0, now, 0.02);
      
      // Base delay time (slightly different for each voice)
      const baseDelay = 0.007 + i * 0.003;
      voice.delay.delayTime.setTargetAtTime(baseDelay, now, 0.02);
      
      // Feedback
      voice.feedbackGain.gain.setTargetAtTime(isActive ? sFeedback : 0, now, 0.02);
      
      // Panning
      voice.panner.pan.setTargetAtTime(isActive ? panPositions[i] : 0, now, 0.02);
    }
  }

  private calculatePanPositions(numVoices: number, spread: number): number[] {
    const positions: number[] = [];
    
    for (let i = 0; i < this.maxVoices; i++) {
      if (numVoices === 1) {
        positions.push(0);
      } else if (numVoices === 2) {
        positions.push(i === 0 ? -spread : spread);
      } else {
        // Distribute evenly across stereo field
        const normalized = (i / (numVoices - 1)) * 2 - 1; // -1 to 1
        positions.push(normalized * spread);
      }
    }
    
    return positions;
  }

  public getStatus() {
    return { ...this.params };
  }
  
  public destroy() {
    if (this.randomLFOInterval) {
      clearInterval(this.randomLFOInterval);
    }
    for (const voice of this.voices) {
      try {
        voice.lfo.stop();
      } catch (e) {
        // LFO may already be stopped
      }
    }
  }
}

const ChorusKnob: React.FC<{ 
  label: string, value: number, onChange: (v: number) => void, suffix?: string, factor?: number, defaultValue?: number, color?: string 
}> = ({ label, value, onChange, suffix, factor = 1, defaultValue = 0.5, color = '#00f2ff' }) => {
  const safeValue = Number.isFinite(value) ? value : defaultValue || 0.5;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startValue = safeValue;
    const onMouseMove = (m: MouseEvent) => {
      const deltaY = (startY - m.clientY) / 200;
      onChange(Math.max(0, Math.min(1, startValue + deltaY)));
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

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const startY = e.touches[0].clientY;
    const startValue = safeValue;
    const onTouchMove = (t: TouchEvent) => {
        if (t.cancelable) t.preventDefault();
        const deltaY = (startY - t.touches[0].clientY) / 200;
        onChange(Math.max(0, Math.min(1, startValue + deltaY)));
    };
    const onTouchEnd = () => {
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
    };
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
        className="w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75"
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5">
          <span className="text-[8px] font-mono font-bold" style={{ color }}>
            {Math.round(safeValue * factor * 10) / 10}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};

export const VocalChorusUI: React.FC<{ node: ChorusNode, initialParams: ChorusParams, onParamsChange?: (p: ChorusParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = useCallback((key: keyof ChorusParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  // Visualization
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
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w/2, 0);
      ctx.lineTo(w/2, h);
      ctx.moveTo(0, h/2);
      ctx.lineTo(w, h/2);
      ctx.stroke();

      if (params.isEnabled) {
        const time = Date.now() * 0.001;
        const { rate, depth, spread, voices, mode } = params;
        const safeDepth = Number.isFinite(depth) ? depth : 0.35;
        const safeRate = Number.isFinite(rate) ? rate : 1.0;
        const safeSpread = Number.isFinite(spread) ? spread : 0.8;
        const numVoices = voices || 2;

        const centerX = w/2;
        const centerY = h/2;
        
        // Draw each voice as a separate Lissajous pattern
        const colors = ['#00f2ff', '#ff6b6b', '#a855f7', '#10b981'];
        const phaseOffsets = mode === 'TRI_CHORUS' 
          ? [0, 2.094, 4.188, 6.283] // 120° spacing
          : [0, 1.571, 3.142, 4.712]; // 90° spacing
        
        for (let v = 0; v < Math.min(numVoices, 4); v++) {
          ctx.beginPath();
          ctx.strokeStyle = colors[v];
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.7;
          
          const voiceRate = safeRate * (1 + v * 0.03);
          const voicePhase = phaseOffsets[v];
          
          for (let i = 0; i < 100; i++) {
            const t = time + i * 0.01;
            const lMod = Math.sin(t * voiceRate * Math.PI * 2);
            const rMod = Math.sin(t * voiceRate * Math.PI * 2 + (safeSpread * Math.PI) + voicePhase);
            
            const x = centerX + (lMod * safeDepth * 80);
            const y = centerY + (rMod * safeDepth * 35);
            
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        
        ctx.globalAlpha = 1;
        
        // Draw center dot
        ctx.beginPath();
        ctx.fillStyle = '#fff';
        ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
        ctx.fill();
        
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(0, h/2);
        ctx.lineTo(w, h/2);
        ctx.stroke();
      }

      frame = requestAnimationFrame(draw);
    };
    
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [params]);

  return (
    <div className="w-[580px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-layer-group text-xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">
              Dimension <span className="text-cyan-400">Chorus</span>
              <span className="text-[8px] ml-2 font-normal text-slate-600">v3.0</span>
            </h2>
            <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Multi-Voice Modulation Engine</p>
          </div>
        </div>
        <button 
          onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>

      {/* Mode Selector */}
      <div className="flex bg-black/40 p-1 rounded-xl border border-white/5">
        {(['CLASSIC', 'TRI_CHORUS', 'DIMENSION', 'ENSEMBLE', 'VIBRATO'] as ChorusMode[]).map(m => (
          <button 
            key={m}
            onClick={() => handleParamChange('mode', m)}
            className={`flex-1 py-2 rounded-lg text-[7px] font-black uppercase transition-all ${params.mode === m ? 'bg-cyan-500 text-black shadow-lg' : 'text-slate-500 hover:text-white'}`}
          >
            {m.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Visualization */}
      <div className="h-32 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden shadow-inner">
        <div className="absolute top-3 left-5 text-[7px] font-black text-slate-600 uppercase tracking-widest">Lissajous Scope</div>
        <canvas ref={canvasRef} width={520} height={128} className="w-full h-full" />
        <div className="absolute bottom-3 right-5 flex items-center space-x-2">
          <span className="text-[7px] font-mono text-slate-600">{params.voices || 2} VOICES</span>
        </div>
      </div>

      {/* Main Controls */}
      <div className="grid grid-cols-5 gap-4">
        <ChorusKnob label="Rate" value={(params.rate || 1.2) / 8} factor={8} suffix="Hz" onChange={v => handleParamChange('rate', v * 8)} defaultValue={0.15} />
        <ChorusKnob label="Depth" value={params.depth || 0.35} factor={100} suffix="%" onChange={v => handleParamChange('depth', v)} defaultValue={0.35} />
        <ChorusKnob label="Spread" value={params.spread || 0.8} factor={100} suffix="%" onChange={v => handleParamChange('spread', v)} defaultValue={0.8} />
        <ChorusKnob label="Feedback" value={params.feedback || 0} factor={100} suffix="%" onChange={v => handleParamChange('feedback', v * 0.95)} defaultValue={0} color="#f59e0b" />
        <ChorusKnob label="Mix" value={params.mix || 0.4} factor={100} suffix="%" onChange={v => handleParamChange('mix', v)} defaultValue={0.4} color="#fff" />
      </div>

      {/* LFO Shape & Voices */}
      <div className="flex items-center justify-between pt-4 border-t border-white/5">
        <div className="flex items-center space-x-4">
          <div>
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest block mb-2">LFO Shape</span>
            <div className="flex bg-black/40 p-0.5 rounded-lg border border-white/5">
              {(['SINE', 'TRIANGLE', 'RANDOM'] as LFOShape[]).map(s => (
                <button 
                  key={s}
                  onClick={() => handleParamChange('lfoShape', s)}
                  className={`px-3 py-1.5 rounded-md text-[7px] font-black uppercase transition-all ${params.lfoShape === s ? 'bg-cyan-500 text-black' : 'text-slate-500 hover:text-white'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          
          <div>
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest block mb-2">Voices</span>
            <div className="flex bg-black/40 p-0.5 rounded-lg border border-white/5">
              {[1, 2, 3, 4].map(v => (
                <button 
                  key={v}
                  onClick={() => handleParamChange('voices', v)}
                  className={`w-8 py-1.5 rounded-md text-[8px] font-black transition-all ${(params.voices || 2) === v ? 'bg-cyan-500 text-black' : 'text-slate-500 hover:text-white'}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Advanced Toggle */}
        <button 
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center space-x-1 text-[7px] font-black text-slate-500 uppercase tracking-widest hover:text-white transition-colors"
        >
          <span>{showAdvanced ? 'Less' : 'More'}</span>
          <i className={`fas fa-chevron-${showAdvanced ? 'up' : 'down'} text-[6px]`}></i>
        </button>
      </div>

      {/* Advanced Controls */}
      {showAdvanced && (
        <div className="grid grid-cols-3 gap-4 pt-4 border-t border-white/5">
          <ChorusKnob label="Low Cut" value={(params.lowCut || 100) / 500} factor={500} suffix="Hz" onChange={v => handleParamChange('lowCut', Math.max(20, v * 500))} defaultValue={0.2} color="#f43f5e" />
          <ChorusKnob label="High Cut" value={(params.highCut || 12000) / 20000} factor={20} suffix="kHz" onChange={v => handleParamChange('highCut', Math.max(2000, v * 20000))} defaultValue={0.6} color="#f43f5e" />
          <div className="flex flex-col items-center justify-center">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest mb-2">Mode Info</span>
            <div className="bg-black/40 px-3 py-2 rounded-lg border border-white/5 text-center">
              <span className="text-[8px] font-mono text-cyan-400">
                {params.mode === 'TRI_CHORUS' && '3-Voice 120° Phase'}
                {params.mode === 'DIMENSION' && '4-Voice Wide Stereo'}
                {params.mode === 'ENSEMBLE' && 'String Ensemble'}
                {params.mode === 'VIBRATO' && '100% Wet Pitch Mod'}
                {params.mode === 'CLASSIC' && '2-Voice Quadrature'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="pt-4 border-t border-white/5 flex justify-between items-center">
        <div className="flex flex-col">
          <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Engine</span>
          <span className="text-[9px] font-black text-slate-400">{params.mode?.replace('_', ' ') || 'CLASSIC'}</span>
        </div>
        <div className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-cyan-500 shadow-[0_0_10px_#00f2ff] animate-pulse' : 'bg-slate-800'}`} />
          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">
            {(params.voices || 2)} Voice{(params.voices || 2) > 1 ? 's' : ''} Active
          </span>
        </div>
      </div>
    </div>
  );
};
