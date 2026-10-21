
import React, { useEffect, useRef, useState } from 'react';
import { fadeInOnInsert, smoothSet, TimelineLfo } from './vocalDspUtils';
import { termHelp } from '../utils/pluginUi';
import { Faceplate, HwWindow, Knob, ToggleSwitch } from './hw';
import { cancelUiFrame, requestUiFrame } from '../utils/uiFrame';

/**
 * MODULE FX_09 : STUDIO FLANGER
 * ----------------------------
 * Logic: Ultra-short modulated delay (1-15ms) with high feedback.
 * Features: Phase Inversion for subtractive flanging and Manual offset.
 */

export interface FlangerParams {
  rate: number;       // 0.1 to 10 Hz
  depth: number;      // 0 to 1
  feedback: number;   // 0 to 0.9
  manual: number;     // 0 to 1 (Base delay offset)
  mix: number;        // 0 to 1
  invertPhase: boolean;
  isEnabled: boolean;
}

export class FlangerNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private delayNode: DelayNode;
  /** LFO calé sur le morceau (même phase en lecture et à l'export). */
  private lfo!: TimelineLfo;
  private depthGain: GainNode;
  private feedbackGain: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;

  private params: FlangerParams = {
    rate: 0.5,
    depth: 0.5,
    feedback: 0.7,
    manual: 0.3,
    mix: 0.5,
    invertPhase: false,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Fondu d'apparition (anti-clic) en direct ; aucun à l'export (le rendu démarre sur le son).
    fadeInOnInsert(this.output.gain, ctx);
    
    this.delayNode = ctx.createDelay(0.021); // tampon court : position de lecture interpolée plus précise (lecture = export)
    this.depthGain = ctx.createGain();
    this.feedbackGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.setupGraph();
  }

  private setupGraph() {
    // Dry Path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Wet Path
    this.input.connect(this.delayNode);
    this.delayNode.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Feedback Loop
    this.delayNode.connect(this.feedbackGain);
    this.feedbackGain.connect(this.delayNode);

    // Modulation
    this.lfo = new TimelineLfo(this.ctx, this.depthGain, Number.isFinite(this.params.rate) ? this.params.rate : 0.5);
    this.depthGain.connect(this.delayNode.delayTime);

    this.applyParams();
  }

  public updateParams(p: Partial<FlangerParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    // Securisation des valeurs pour éviter le crash "non-finite"
    const safeNum = (val: number, def: number) => Number.isFinite(val) ? val : def;

    const rate = safeNum(this.params.rate, 0.5);
    const depth = safeNum(this.params.depth, 0.5);
    const feedback = safeNum(this.params.feedback, 0.0);
    const manual = safeNum(this.params.manual, 0.005);
    const mix = safeNum(this.params.mix, 0.5);
    const { invertPhase, isEnabled } = this.params;

    if (isEnabled) {
      const baseDelay = 0.001 + (manual * 0.014); // 1ms to 15ms
      smoothSet(this.delayNode.delayTime, baseDelay, this.ctx, 0.03);
      this.lfo.setFrequency(rate);
      smoothSet(this.depthGain.gain, 0.005 * depth, this.ctx, 0.03);
      
      const fbValue = invertPhase ? -feedback : feedback;
      smoothSet(this.feedbackGain.gain, fbValue, this.ctx, 0.03);
      
      smoothSet(this.dryGain.gain, 1 - mix * 0.5, this.ctx, 0.02);
      smoothSet(this.wetGain.gain, mix, this.ctx, 0.02);
    } else {
      smoothSet(this.dryGain.gain, 1, this.ctx, 0.02);
      smoothSet(this.wetGain.gain, 0, this.ctx, 0.02);
      smoothSet(this.feedbackGain.gain, 0, this.ctx, 0.02);
    }
  }

  /** Modulation calée sur la ligne de temps du morceau (le moteur appelle syncTimeline). */
  public get followsTimeline(): boolean { return true; }
  public syncTimeline(origin: number, at?: number) { this.lfo.sync(origin, at); }

  public getStatus() {
    return { ...this.params };
  }

  public dispose() {
    try {
      this.lfo.stop();
    } catch (e) {
      // LFO may already be stopped
    }
    try {
      this.feedbackGain.disconnect();
      this.delayNode.disconnect();
      this.depthGain.disconnect();
      this.dryGain.disconnect();
      this.wetGain.disconnect();
      this.input.disconnect();
      this.output.disconnect();
    } catch (e) {}
  }
}

const FLANGER_DEFAULTS: FlangerParams = { rate: 0.5, depth: 0.5, feedback: 0.7, manual: 0.3, mix: 0.5, invertPhase: false, isEnabled: true };
const FLANGER_ACCENT = '#e879f9';
const pct = (v: number) => `${Math.round(v * 100)} %`;

export const StudioFlangerUI: React.FC<{ node: FlangerNode, initialParams: FlangerParams, onParamsChange?: (p: FlangerParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view: FlangerParams = { ...FLANGER_DEFAULTS, ...Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))) } as FlangerParams;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Balayage animé sur le canvas seul (la façade ne se redessine pas à chaque image).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const draw = () => {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const time = Date.now() * 0.001;
      const { manual, rate, depth, feedback } = viewRef.current;
      ctx.lineWidth = 2;
      const baseOffset = (manual + Math.sin(time * rate * 2 * Math.PI) * depth * 0.2) * 50;
      for (let i = 0; i < 15; i++) {
        const x = (baseOffset + (i * 30)) % w;
        const alpha = 0.15 + (feedback * 0.6);
        ctx.strokeStyle = `rgba(240, 171, 252, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(x, 10); ctx.lineTo(x, h - 10);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgba(240, 171, 252, ${alpha * 0.3})`;
        ctx.beginPath();
        ctx.moveTo(x + 5, 20); ctx.lineTo(x + 5, h - 20);
        ctx.stroke();
        ctx.lineWidth = 2;
      }
      frame = requestUiFrame(draw);
    };
    frame = requestUiFrame(draw);
    return () => cancelUiFrame(frame);
  }, []);

  const handleParamChange = (key: keyof FlangerParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const K = (key: keyof FlangerParams, label: string, o: Record<string, any>) => (
    <Knob paramId={key} label={label} size="M" cap="silver" min={0} max={1} step={0.01} value={view[key] as number} defaultValue={FLANGER_DEFAULTS[key] as number}
      onChange={v => handleParamChange(key, v)} format={pct} hint={termHelp(label) || undefined} ticks={11} {...o} />
  );
  return (
    <HwWindow type="FLANGER" width={560} accent={FLANGER_ACCENT} accentInk="#200524"
      idleHelp={<>Effet « avion » qui balaie le son : à doser léger sur la voix. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="plum" model="Flanger" kicker="Balayage à retard court · effet « avion »" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: FLANGER_ACCENT }}>
        <div className="hw-screen">
          <div className="hw-screen-glass" style={{ height: 96 }}>
            <div className="absolute top-2 left-3 hw-silk" style={{ color: '#94a3b8', zIndex: 1 }}>Balayage</div>
            <canvas ref={canvasRef} width={480} height={96} className="w-full h-full block" aria-label="Balayage du flanger" />
          </div>
        </div>
        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3 mt-3">
          {K('rate', 'Vitesse', { max: 10, format: (v: number) => `${v.toFixed(2).replace('.', ',')} Hz`, scale: [{ v: 0, label: '0' }, { v: 5, label: '5' }, { v: 10, label: '10' }], hint: termHelp('Vitesse') || 'Vitesse du balayage.' })}
          {K('depth', 'Profondeur', { size: 'L', scale: [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }], hint: termHelp('Profondeur') || 'Amplitude du balayage.' })}
          {K('feedback', 'Retour', { size: 'L', scale: [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }], hint: termHelp('Retour') || 'Résonance : plus il monte, plus le « avion » siffle.' })}
          {K('manual', 'Position', { format: (v: number) => `${(1 + v * 14).toFixed(1).replace('.', ',')} ms`, hint: 'Retard de base (1 à 15 ms) : place la note du balayage, grave ou aiguë.' })}
          {K('mix', 'Mélange', { scale: [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }], hint: termHelp('Mélange') || "Part de l'effet mélangée au son d'origine." })}
        </div>
        <div className="hw-rule" />
        <div className="flex justify-center">
          <ToggleSwitch label="Phase" paramId="invertPhase" value={view.invertPhase ? 1 : 0} onChange={v => handleParamChange('invertPhase', v === 1)}
            hint="Inversée : le balayage creuse le son (plus creux, plus « tuyau ») au lieu de le renforcer."
            options={[{ v: 0, label: 'Normale' }, { v: 1, label: 'Inversée' }]} />
        </div>
      </Faceplate>
    </HwWindow>
  );
};
