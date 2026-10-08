
import { AutomationSet, MappedParam } from '../engine/automationParams';
import React, { useEffect, useRef, useState } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { setParamSmooth } from './vocalDspUtils';
import { termHelp } from '../utils/pluginUi';

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

/**
 * Une voix doublee : retard court (10-30 ms) module par deux LFO de vitesses
 * non multiples (derive lente + petite instabilite), comme un chanteur qui
 * double sa prise : jamais exactement en place ni exactement juste.
 */
interface DoubleVoice {
  delay: DelayNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
  lfoSlow: OscillatorNode;
  lfoFast: OscillatorNode;
  depthSlow: GainNode;
  depthFast: GainNode;
}

export class VocalDoublerNode {
  private readonly createdAt: number;
  /** Réglages automatisables (R8) : largeur, niveau des doublures gauche / droite. */
  private auto = new AutomationSet();
  private autoState = '';
  private setP(param: AudioParam, value: number, tau: number) {
    setParamSmooth(param, value, this.ctx, this.createdAt, tau);
  }
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private dryGain: GainNode;
  private voiceL: DoubleVoice;
  private voiceR: DoubleVoice;

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
    this.createdAt = ctx.currentTime;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Initialize with zero gain and ramp up to avoid click on creation
    this.output.gain.setValueAtTime(0, ctx.currentTime);
    this.output.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02);
    
    this.dryGain = ctx.createGain();
    // Temps de base et vitesses differents a gauche et a droite : les deux
    // doublures ne se superposent jamais en peigne fixe.
    this.voiceL = this.createVoice(0.016, 0.23, 1.7);
    this.voiceR = this.createVoice(0.024, 0.31, 1.3);

    this.setupGraph();
  }

  private createVoice(baseDelay: number, slowHz: number, fastHz: number): DoubleVoice {
    const ctx = this.ctx;
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = baseDelay;
    // Doublure allegee dans le grave (pas d'empatement ni d'annulation de
    // phase dans le bas) et un peu plus douce dans l'aigu : elle reste
    // derriere la voix principale.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 150;
    hp.Q.value = -3.01;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    lp.Q.value = -3.01;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    const lfoSlow = ctx.createOscillator();
    lfoSlow.type = 'sine';
    lfoSlow.frequency.value = slowHz;
    const lfoFast = ctx.createOscillator();
    lfoFast.type = 'triangle';
    lfoFast.frequency.value = fastHz;
    const depthSlow = ctx.createGain();
    depthSlow.gain.value = 0;
    const depthFast = ctx.createGain();
    depthFast.gain.value = 0;
    lfoSlow.connect(depthSlow);
    lfoFast.connect(depthFast);
    depthSlow.connect(delay.delayTime);
    depthFast.connect(delay.delayTime);
    lfoSlow.start();
    lfoFast.start();
    return { delay, hp, lp, gain, panner, lfoSlow, lfoFast, depthSlow, depthFast };
  }

  private setupGraph() {
    // 1. Dry Path (Center)
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // 2. Doublures gauche et droite
    for (const v of [this.voiceL, this.voiceR]) {
      this.input.connect(v.delay);
      v.delay.connect(v.hp);
      v.hp.connect(v.lp);
      v.lp.connect(v.gain);
      v.gain.connect(v.panner);
      v.panner.connect(this.output);
    }

    this.auto.add('width', new MappedParam(this.ctx, [{ param: this.voiceL.panner.pan, map: v => -v }, { param: this.voiceR.panner.pan }], { min: 0, max: 1, value: 0, affine: true }));
    this.auto.add('gainL', new MappedParam(this.ctx, [{ param: this.voiceL.gain.gain }], { min: 0, max: 1, value: 0, affine: true }));
    this.auto.add('gainR', new MappedParam(this.ctx, [{ param: this.voiceR.gain.gain }], { min: 0, max: 1, value: 0, affine: true }));
    this.applyParams();
  }

  /** AudioParam d'un réglage automatisable (R8) : « width », « gainL », « gainR » ; sinon null. */
  public automationParam(key: string): MappedParam | null { return this.auto.get(key); }
  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  public updateParams(p: Partial<DoublerParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    const { detune, width, gainL, gainR, directOn, isEnabled } = this.params;
    const stKey = `${isEnabled ? 1 : 0}`;
    const st = { force: stKey !== this.autoState, tau: 0.05, immediate: this.ctx.currentTime <= this.createdAt };
    this.autoState = stKey;

    if (isEnabled) {
      this.setP(this.dryGain.gain, directOn ? 1.0 : 0.0, 0.05);
      this.auto.get('gainL')!.setStatic(Math.max(0, safe(gainL)), st);
      this.auto.get('gainR')!.setStatic(Math.max(0, safe(gainR)), st);
      
      const sWidth = Math.max(0, Math.min(1, safe(width)));
      this.auto.get('width')!.setStatic(sWidth, { ...st, tau: 0.1 });
      
      // Detune 0..1 => ecart de hauteur crete d'environ 0..15 cents.
      // L'ecart de hauteur d'un retard module vaut 2*pi*f*A : on calcule
      // l'amplitude A pour chaque LFO a partir de l'ecart voulu (avant :
      // 4 cents au maximum, alors que l'interface affiche 15).
      const d = Math.max(0, Math.min(1, safe(detune)));
      for (const v of [this.voiceL, this.voiceR]) {
        const slowA = (d * 0.0065) / (2 * Math.PI * v.lfoSlow.frequency.value);
        const fastA = (d * 0.0022) / (2 * Math.PI * v.lfoFast.frequency.value);
        this.setP(v.depthSlow.gain, slowA, 0.1);
        this.setP(v.depthFast.gain, fastA, 0.1);
      }
    } else {
      this.setP(this.dryGain.gain, 1.0, 0.02);
      this.auto.get('gainL')!.setStatic(0, { ...st, tau: 0.02 });
      this.auto.get('gainR')!.setStatic(0, { ...st, tau: 0.02 });
    }
  }

  public getStatus() {
    return { ...this.params };
  }

  public dispose() {
    for (const v of [this.voiceL, this.voiceR]) {
      try { v.lfoSlow.stop(); v.lfoFast.stop(); } catch (e) {}
      for (const n of [v.delay, v.hp, v.lp, v.gain, v.panner, v.lfoSlow, v.lfoFast, v.depthSlow, v.depthFast]) {
        try { n.disconnect(); } catch (e) {}
      }
    }
    try { this.dryGain.disconnect(); } catch (e) {}
  }
}

const DoublerKnob: React.FC<{ 
  label: string, value: number, onChange: (v: number) => void, suffix?: string, factor?: number, defaultValue?: number 
}> = ({ label, value, onChange, suffix, factor = 1, defaultValue = 0.5 }) => {
  const safeValue = Number.isFinite(value) ? value : defaultValue || 0;
  const knob = useKnobInteraction(safeValue, onChange, { min: 0, max: 1, defaultValue, sensitivity: 150 });



  const rotation = (safeValue * 270) - 135;

  return (
    <div className="flex flex-col items-center space-y-2 select-none group touch-none" title={termHelp(label) || undefined}>
      <div 
        {...knob.bind}
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
        <span className="block text-[9px] font-bold text-slate-400 mb-1 whitespace-nowrap">{label}</span>
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
            <h2 className="text-xl font-black text-white tracking-tight leading-none">Doubleur</h2>
            <p className="text-[12px] text-slate-400 mt-2">Simule une 2e prise à gauche et à droite : la voix s'élargit.</p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button 
            onClick={() => handleParamChange('directOn', !params.directOn)}
            aria-pressed={params.directOn}
            title="Voix d'origine : l'entendre au centre en plus des doublures (coupée = seulement les doublures)"
            className={`px-3 py-2 rounded-xl text-[11px] font-bold transition-all border ${params.directOn ? 'bg-white/10 text-white' : 'bg-red-500/20 border-red-500/40 text-red-500'}`}
          >
            Voix d'origine : {params.directOn ? 'oui' : 'non'}
          </button>
          <button data-plugin-power 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-violet-500 border-violet-400 text-black shadow-lg shadow-violet-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <i className="fas fa-power-off"></i>
          </button>
        </div>
      </div>

      <div className="h-32 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group">
        <div className="absolute top-4 left-6 text-[7px] font-black text-slate-600 uppercase tracking-widest z-10">Image stéréo</div>
        <canvas ref={canvasRef} width={400} height={128} className="w-full h-full opacity-60" />
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex space-x-16 text-[6px] font-black text-slate-700 uppercase">
           <span>Gauche</span>
           <span>Centre</span>
           <span>Droite</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 px-2">
        <DoublerKnob label="Désaccord" value={params.detune} factor={15} suffix="ct" onChange={v => handleParamChange('detune', v)} defaultValue={0.4} />
        <DoublerKnob label="Écart G/D" value={params.width} factor={100} suffix="%" onChange={v => handleParamChange('width', v)} defaultValue={0.8} />
        <DoublerKnob label="Volume gauche" value={params.gainL} factor={100} suffix="%" onChange={v => handleParamChange('gainL', v)} defaultValue={0.7} />
        <DoublerKnob label="Volume droite" value={params.gainR} factor={100} suffix="%" onChange={v => handleParamChange('gainR', v)} defaultValue={0.7} />
      </div>

      <p className="pt-4 border-t border-white/5 text-[11px] text-slate-400" title="Effet Haas : doublures décalées de 16 ms (gauche) et 24 ms (droite)">Doublures décalées de 16 ms à gauche et 24 ms à droite.</p>
    </div>
  );
};
