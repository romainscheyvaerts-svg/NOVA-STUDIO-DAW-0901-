import React, { useEffect, useRef, useState, useCallback } from 'react';
import { fadeInOnInsert, smoothSet, TimelineLfo } from './vocalDspUtils';
import { termHelp } from '../utils/pluginUi';
import { Faceplate, HwSection, HwWindow, Knob, PushButton, ToggleSwitch } from './hw';

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
  /** LFO calé sur le morceau (même phase en lecture et à l'export). */
  lfo: TimelineLfo;
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
    
    // Fondu d'apparition (anti-clic) en direct ; aucun à l'export (le rendu démarre sur le son).
    fadeInOnInsert(this.output.gain, ctx);
    
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
    // Le setInterval « LFO aleatoire » (100 ms) n'est plus lance : ses valeurs
    // n'etaient lues nulle part, et il continuait de tourner apres le retrait
    // du plugin et pour chaque instance d'export hors ligne.
  }

  private createVoices() {
    // Voice configurations for different phase offsets
    const panPositions = [-0.8, 0.8, -0.4, 0.4];
    
    for (let i = 0; i < this.maxVoices; i++) {
      const delay = this.ctx.createDelay(0.022); // tampon court : position de lecture interpolée plus précise (lecture = export)
      delay.delayTime.value = 0.007 + i * 0.003; // Slightly offset base delays
      
      const depthGain = this.ctx.createGain();
      depthGain.gain.value = 0.002;
      const lfo = new TimelineLfo(this.ctx, depthGain, 1.2 * (1 + i * 0.03));
      
      const feedbackGain = this.ctx.createGain();
      feedbackGain.gain.value = 0;
      
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = panPositions[i];
      
      // LFO -> profondeur -> temps de retard
      depthGain.connect(delay.delayTime);
      
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
      voice.lfo.setShape(shapeMap[this.params.lfoShape] === 'triangle' ? 'triangle' : 'sine');
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
    const safe = (v: number, d: number) => Number.isFinite(v) ? v : d;
    const { rate, depth, spread, mix, feedback, lowCut, highCut, voices, mode, isEnabled } = this.params;

    // Filters
    smoothSet(this.lowCutFilter.frequency, safe(lowCut, 100), this.ctx, 0.02);
    smoothSet(this.highCutFilter.frequency, safe(highCut, 12000), this.ctx, 0.02);

    if (isEnabled) {
      // Mix (use equal-power crossfade for vibrato mode)
      const sMix = safe(mix, 0.4);
      if (mode === 'VIBRATO') {
        smoothSet(this.dryGain.gain, 0, this.ctx, 0.02);
        smoothSet(this.wetGain.gain, 1, this.ctx, 0.02);
      } else {
        smoothSet(this.dryGain.gain, Math.cos(sMix * Math.PI * 0.5), this.ctx, 0.02);
        smoothSet(this.wetGain.gain, Math.sin(sMix * Math.PI * 0.5), this.ctx, 0.02);
      }
    } else {
      smoothSet(this.dryGain.gain, 1, this.ctx, 0.02);
      smoothSet(this.wetGain.gain, 0, this.ctx, 0.02);
    }

    // Voice parameters
    const activeVoices = Math.min(voices, this.maxVoices);
    const sRate = safe(rate, 1.0);
    const sDepth = safe(depth, 0.35);
    const sSpread = safe(spread, 0.8);
    const sFeedback = safe(feedback, 0);

    // Phase offsets for different modes

    const panPositions = this.calculatePanPositions(activeVoices, sSpread);

    for (let i = 0; i < this.maxVoices; i++) {
      const voice = this.voices[i];
      const isActive = i < activeVoices && isEnabled;
      
      // Rate with slight detuning between voices for richness
      const voiceRate = sRate * (1 + i * 0.03);
      voice.lfo.setFrequency(voiceRate);
      
      // Depth - calculate based on mode
      let voiceDepth = sDepth * 0.003; // Base depth in seconds
      if (mode === 'ENSEMBLE') {
        voiceDepth *= (1 + i * 0.2); // More depth variation for ensemble
      }
      smoothSet(voice.depthGain.gain, isActive ? voiceDepth : 0, this.ctx, 0.02);
      
      // Base delay time (slightly different for each voice)
      const baseDelay = 0.007 + i * 0.003;
      smoothSet(voice.delay.delayTime, baseDelay, this.ctx, 0.02);
      
      // Feedback
      smoothSet(voice.feedbackGain.gain, isActive ? sFeedback : 0, this.ctx, 0.02);
      
      // Panning
      smoothSet(voice.panner.pan, isActive ? panPositions[i] : 0, this.ctx, 0.02);
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

  /** Modulation calée sur la ligne de temps du morceau (le moteur appelle syncTimeline). */
  public get followsTimeline(): boolean { return true; }
  public syncTimeline(origin: number, at?: number) { this.voices.forEach(v => v.lfo.sync(origin, at)); }

  public getStatus() {
    return { ...this.params };
  }
  
  /** Appele par le moteur au retrait du plugin : arrete les LFO. */
  public dispose() {
    this.destroy();
  }

  public destroy() {
    for (const voice of this.voices) {
      voice.lfo.stop();
    }
  }
}

const CHORUS_DEFAULTS: ChorusParams = { rate: 1.2, depth: 0.35, spread: 0.8, mix: 0.4, feedback: 0, lowCut: 100, highCut: 12000, mode: 'CLASSIC', lfoShape: 'SINE', voices: 2, isEnabled: true };
const CHORUS_ACCENT = '#0f766e';
const MODES: { id: ChorusMode; label: string; help: string }[] = [
  { id: 'CLASSIC', label: 'Classique', help: 'Classique : 2 voix en quadrature, le chorus de base.' },
  { id: 'TRI_CHORUS', label: 'Tri', help: 'Tri-chorus : 3 voix décalées de 120°, plus large et plus doux.' },
  { id: 'DIMENSION', label: 'Dimension', help: 'Dimension : 4 voix très larges en stéréo, effet d’espace sans ondulation marquée.' },
  { id: 'ENSEMBLE', label: 'Ensemble', help: 'Ensemble : façon section de cordes, épais et mouvant.' },
  { id: 'VIBRATO', label: 'Vibrato', help: 'Vibrato : 100 % d’effet, la hauteur ondule (plus de son d’origine).' },
];
const SHAPES: { v: number; id: LFOShape; label: string }[] = [{ v: 0, id: 'SINE', label: 'Sinus' }, { v: 1, id: 'TRIANGLE', label: 'Triangle' }, { v: 2, id: 'RANDOM', label: 'Aléatoire' }];
const pct = (v: number) => `${Math.round(v * 100)} %`;
const hzFr = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',')} kHz` : `${Math.round(v)} Hz`);
/** Réglages complétés par les valeurs du moteur (un projet ancien n'a pas tous les champs). */
const withDefaults = <T extends object>(defaults: T, p: any): T => ({ ...defaults, ...Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))) }) as T;

export const VocalChorusUI: React.FC<{ node: ChorusNode, initialParams: ChorusParams, onParamsChange?: (p: ChorusParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = withDefaults(CHORUS_DEFAULTS, params);
  const viewRef = useRef(view);
  viewRef.current = view;

  const handleParamChange = useCallback((key: keyof ChorusParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  // Image des voix : animée sur le canvas seul (la façade ne se redessine pas à chaque image).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const draw = () => {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      ctx.stroke();
      const { rate, depth, spread, voices, mode } = viewRef.current;
      const time = Date.now() * 0.001;
      const colors = ['#5eead4', '#fda4af', '#c4b5fd', '#86efac'];
      const phaseOffsets = mode === 'TRI_CHORUS' ? [0, 2.094, 4.188, 6.283] : [0, 1.571, 3.142, 4.712];
      for (let v = 0; v < Math.min(voices || 2, 4); v++) {
        ctx.beginPath();
        ctx.strokeStyle = colors[v];
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.8;
        const voiceRate = rate * (1 + v * 0.03);
        for (let i = 0; i < 100; i++) {
          const t = time + i * 0.01;
          const x = w / 2 + Math.sin(t * voiceRate * Math.PI * 2) * depth * 80;
          const y = h / 2 + Math.sin(t * voiceRate * Math.PI * 2 + spread * Math.PI + phaseOffsets[v]) * depth * 35;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.arc(w / 2, h / 2, 3, 0, Math.PI * 2);
      ctx.fill();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const modeIdx = Math.max(0, MODES.findIndex(m => m.id === view.mode));
  const shape = SHAPES.find(s => s.id === view.lfoShape) || SHAPES[0];
  return (
    <HwWindow type="CHORUS" width={600} accent="#2dd4bf" accentInk="#03201c"
      idleHelp={<>Épaissit la voix avec de légères copies qui ondulent. <span style={{ color: '#cbd2dc' }}>{MODES[modeIdx].help}</span> <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="seafoam" model="Chorus" kicker="Ensemble stéréo · 1 à 4 voix" modelStyle="serif" className="hw-touch" style={{ ['--hw-accent' as any]: CHORUS_ACCENT }}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="hw-screen flex-[1_1_260px] min-w-0">
            <div className="hw-screen-glass" style={{ height: 118 }}>
              <div className="absolute top-2 left-3 hw-silk" style={{ color: '#94a3b8', zIndex: 1 }}>Image des voix</div>
              <canvas ref={canvasRef} width={440} height={128} className="w-full h-full block" aria-label="Image des voix du chorus" />
            </div>
          </div>
          <div className="flex-[0_1_auto] mx-auto" style={{ padding: '0 34px' }}>
            <Knob paramId="mode" label="Mode" ariaLabel="Mode du chorus" size="L" cap="chicken" min={0} max={MODES.length - 1} step={1} value={modeIdx} defaultValue={0}
              detents={MODES.map((m, i) => ({ v: i, label: m.label }))} onChange={v => handleParamChange('mode', MODES[Math.round(v)]?.id || 'CLASSIC')}
              format={v => MODES[Math.round(v)]?.label || ''} hint="Caractère du chorus : nombre de voix et largeur. Le détail du mode choisi s'affiche dans la ligne d'info." />
          </div>
        </div>
        <div className="hw-rule" />
        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3">
          <Knob paramId="rate" label="Vitesse" size="M" cap="black" min={0} max={8} step={0.01} value={view.rate} defaultValue={1.2} onChange={v => handleParamChange('rate', v)}
            format={v => `${v.toFixed(2).replace('.', ',')} Hz`} hint={termHelp('Vitesse') || "Vitesse de l'ondulation (lente = douce, rapide = vibrato)."}
            scale={[{ v: 0, label: '0' }, { v: 4, label: '4' }, { v: 8, label: '8' }]} />
          <Knob paramId="depth" label="Profondeur" size="L" cap="black" min={0} max={1} step={0.01} value={view.depth} defaultValue={0.35} onChange={v => handleParamChange('depth', v)}
            format={pct} hint={termHelp('Profondeur') || "Amplitude de l'ondulation."} scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
          <Knob paramId="spread" label="Ouverture" size="M" cap="black" min={0} max={1} step={0.01} value={view.spread} defaultValue={0.8} onChange={v => handleParamChange('spread', v)}
            format={pct} hint={termHelp('Ouverture') || 'Largeur stéréo des voix.'} scale={[{ v: 0, label: '0' }, { v: 1, label: '100' }]} />
          <Knob paramId="feedback" label="Retour" size="M" cap="black" min={0} max={0.95} step={0.01} value={view.feedback} defaultValue={0} onChange={v => handleParamChange('feedback', v)}
            format={pct} hint={termHelp('Retour') || 'Réinjection : vers le flanger quand on monte.'} ticks={11} />
          <Knob paramId="mix" label="Mélange" size="M" cap="black" min={0} max={1} step={0.01} value={view.mix} defaultValue={0.4} onChange={v => handleParamChange('mix', v)}
            format={pct} hint={termHelp('Mélange') || "Part de l'effet mélangée au son d'origine."} scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
        </div>
        <div className="hw-rule" />
        <div className="flex flex-wrap items-start justify-around gap-x-4 gap-y-3">
          <ToggleSwitch label="Ondulation" paramId="lfoShape" value={shape.v} onChange={v => handleParamChange('lfoShape', SHAPES[v]?.id || 'SINE')}
            hint="Forme de l'ondulation : sinus (douce), triangle (plus régulière), aléatoire (plus naturelle)." options={SHAPES.map(s => ({ v: s.v, label: s.label }))} />
          <HwSection title="Voix">
            <div className="flex gap-1.5" role="radiogroup" aria-label="Nombre de voix" data-nova-param="voices">
              {[1, 2, 3, 4].map(v => (
                <PushButton key={v} role="radio" active={(view.voices || 2) === v} onClick={() => handleParamChange('voices', v)} text={String(v)} led={CHORUS_ACCENT}
                  ariaLabel={`${v} voix`} hint="Nombre de copies qui ondulent autour de la voix." />
              ))}
            </div>
          </HwSection>
          <HwSection title="Filtres de l'effet">
            <div className="flex gap-1">
              <Knob paramId="lowCut" label="Coupe-bas" size="S" cap="black" curve="log" min={20} max={500} step={1} value={view.lowCut} defaultValue={100}
                onChange={v => handleParamChange('lowCut', v)} format={hzFr} hint={termHelp('Coupe-bas') || "Retire les graves de l'effet (la basse reste nette)."} ticks={7} />
              <Knob paramId="highCut" label="Coupe-haut" size="S" cap="black" curve="log" min={2000} max={20000} step={10} value={view.highCut} defaultValue={12000}
                onChange={v => handleParamChange('highCut', v)} format={hzFr} hint={termHelp('Coupe-haut') || "Adoucit les aigus de l'effet."} ticks={7} />
            </div>
          </HwSection>
        </div>
      </Faceplate>
    </HwWindow>
  );
};
