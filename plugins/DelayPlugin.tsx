import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { paramFr, termHelp } from '../utils/pluginUi';
import { PluginParameter } from '../types';
import { EnvelopeDucker, makeCurve, SMOOTH, setParamSmooth } from './vocalDspUtils';

/**
 * PROFESSIONAL TAPE DELAY ENGINE v3.0
 * ===================================
 * Inspired by classic tape delays (Roland Space Echo, Echoplex)
 * and modern plugins (Soundtoys EchoBoy, Valhalla Delay)
 * 
 * Features:
 * - Multi-tap delay (up to 4 taps)
 * - HP/LP filters in feedback loop
 * - Tape saturation with wow/flutter
 * - Ducking mode for cleaner mixes
 * - Stereo spread with L/R offset
 * - Freeze/infinite repeat mode
 */

export type DelayDivision = '1/1' | '1/2' | '1/2D' | '1/4' | '1/4D' | '1/4T' | '1/8' | '1/8D' | '1/8T' | '1/16' | '1/16D' | '1/16T' | '1/32';
export type DelayMode = 'DIGITAL' | 'TAPE' | 'ANALOG' | 'DIFFUSE' | 'REVERSE';

export interface DelayParams {
  division: DelayDivision;
  divisionR: DelayDivision;  // Right channel division (for stereo offset)
  feedback: number;          // 0 to 0.95
  feedbackHP: number;        // 20 to 2000 Hz (highpass in feedback)
  feedbackLP: number;        // 1000 to 20000 Hz (lowpass in feedback)
  mix: number;               // 0 to 1
  stereoWidth: number;       // 0 to 1 (0=mono, 1=full stereo)
  pingPong: boolean;
  ducking: number;           // 0 to 1 (duck delay when input is loud)
  saturation: number;        // 0 to 1 (tape saturation amount)
  modRate: number;           // 0 to 5 Hz (wow/flutter rate)
  modDepth: number;          // 0 to 1 (wow/flutter depth)
  mode: DelayMode;
  freeze: boolean;           // Infinite repeat
  multiTap: boolean;         // Enable 4 taps
  tap2Level: number;         // 0 to 1
  tap3Level: number;         // 0 to 1
  tap4Level: number;         // 0 to 1
  bpm: number;
  isEnabled: boolean;
}

const DIVISION_FACTORS: Record<DelayDivision, number> = {
  '1/1': 4,
  '1/2': 2,
  '1/2D': 3,
  '1/4': 1,
  '1/4D': 1.5,
  '1/4T': 0.6667,
  '1/8': 0.5,
  '1/8D': 0.75,
  '1/8T': 0.3333,
  '1/16': 0.25,
  '1/16D': 0.375,
  '1/16T': 0.1667,
  '1/32': 0.125,
};

/**
 * Une ligne de retard avec sa propre boucle de reinjection :
 * delay -> passe-haut -> passe-bas -> saturation -> gain de feedback.
 * Les deux lignes (G/D) sont independantes ; le mode ping-pong ne fait que
 * croiser leurs reinjections via des gains (bascule douce, pas de recablage).
 */
interface DelayLine {
  delay: DelayNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  sat: WaveShaperNode;
  fb: GainNode;
  toSelf: GainNode;   // reinjection dans la meme ligne (mode stereo)
  toOther: GainNode;  // reinjection dans l'autre ligne (mode ping-pong)
}

export class SyncDelayNode {
  private readonly createdAt: number;
  private setP(param: AudioParam, value: number, tau: number) {
    setParamSmooth(param, value, this.ctx, this.createdAt, tau);
  }
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  // Entrees : stereo (mode stereo) et mono (premiere frappe du ping-pong, multi-tap)
  private stereoIn: GainNode;
  private monoIn: GainNode;
  private inSplitter: ChannelSplitterNode;
  private inL: GainNode;     // canal G -> ligne G (mode stereo)
  private inR: GainNode;     // canal D -> ligne D (mode stereo)
  private monoToL: GainNode; // mono -> ligne G (mode ping-pong)

  private lineL: DelayLine;
  private lineR: DelayLine;

  // Multi-tap delays
  private tap2Delay: DelayNode;
  private tap3Delay: DelayNode;
  private tap4Delay: DelayNode;
  private tap2Gain: GainNode;
  private tap3Gain: GainNode;
  private tap4Gain: GainNode;

  // Bus wet : fusion G/D -> largeur (matrice M/S) -> chaleur -> ducking -> wet
  private wetMerger: ChannelMergerNode;
  private widthSplitter: ChannelSplitterNode;
  private widthMerger: ChannelMergerNode;
  private wLL: GainNode; private wLR: GainNode; private wRL: GainNode; private wRR: GainNode;
  private analogFilter: BiquadFilterNode;  // Adds analog warmth (hors boucle)

  // Modulation (wow/flutter)
  private modLFO1: OscillatorNode;
  private modLFO2: OscillatorNode;  // Secondary for complex modulation
  private modGain1: GainNode;
  private modGain2: GainNode;

  // Ducking (suiveur d'enveloppe natif : marche aussi a l'export)
  private duckingGain: GainNode;
  private ducker: EnvelopeDucker;

  // Mix
  private wetGain: GainNode;
  private dryGain: GainNode;

  // Metering
  public inputAnalyzer: AnalyserNode;
  public outputAnalyzer: AnalyserNode;

  private params: DelayParams;
  private curveKey = '';

  constructor(ctx: AudioContext, bpm: number) {
    this.ctx = ctx;
    this.createdAt = ctx.currentTime;
    this.params = {
      division: '1/4',
      divisionR: '1/4',
      feedback: 0.4,
      feedbackHP: 80,
      feedbackLP: 8000,
      mix: 0.3,
      stereoWidth: 1.0,
      pingPong: false,
      ducking: 0,
      saturation: 0.3,
      modRate: 0.3,       // Reduced from 0.5 - slower wobble
      modDepth: 0.05,     // Reduced from 0.15 - much subtler
      mode: 'DIGITAL',    // Start with DIGITAL mode (no modulation) for clean default
      freeze: false,
      multiTap: false,
      tap2Level: 0.5,
      tap3Level: 0.35,
      tap4Level: 0.2,
      bpm: bpm || 120,
      isEnabled: true,
    };

    // I/O
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // Initialize with zero gain and ramp up to avoid click on creation
    this.output.gain.setValueAtTime(0, ctx.currentTime);
    this.output.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02);

    // Entrees : on force la stereo (une source mono est recopiee sur G et D,
    // sinon le separateur laisserait le canal droit muet).
    this.stereoIn = ctx.createGain();
    this.stereoIn.channelCount = 2;
    this.stereoIn.channelCountMode = 'explicit';
    this.stereoIn.channelInterpretation = 'speakers';
    this.monoIn = ctx.createGain();
    this.monoIn.channelCount = 1;
    this.monoIn.channelCountMode = 'explicit';
    this.monoIn.channelInterpretation = 'speakers';
    this.inSplitter = ctx.createChannelSplitter(2);
    this.inL = ctx.createGain();
    this.inR = ctx.createGain();
    this.monoToL = ctx.createGain();

    this.lineL = this.createLine();
    this.lineR = this.createLine();

    // Multi-tap delays
    this.tap2Delay = ctx.createDelay(4.0);
    this.tap3Delay = ctx.createDelay(4.0);
    this.tap4Delay = ctx.createDelay(4.0);
    this.tap2Gain = ctx.createGain();
    this.tap3Gain = ctx.createGain();
    this.tap4Gain = ctx.createGain();
    this.tap2Gain.gain.value = 0;
    this.tap3Gain.gain.value = 0;
    this.tap4Gain.gain.value = 0;

    // Bus wet
    this.wetMerger = ctx.createChannelMerger(2);
    this.widthSplitter = ctx.createChannelSplitter(2);
    this.widthMerger = ctx.createChannelMerger(2);
    this.wLL = ctx.createGain(); this.wLR = ctx.createGain();
    this.wRL = ctx.createGain(); this.wRR = ctx.createGain();

    // Analog warmth filter : sorti de la boucle de feedback. Dedans, son
    // +3/+4 dB dans le grave faisait depasser un gain de boucle de 1 et le
    // delai partait en auto-oscillation des que le feedback montait.
    this.analogFilter = ctx.createBiquadFilter();
    this.analogFilter.type = 'lowshelf';
    this.analogFilter.frequency.value = 300;
    this.analogFilter.gain.value = 0;

    // Modulation LFOs
    this.modLFO1 = ctx.createOscillator();
    this.modLFO1.type = 'sine';
    this.modLFO1.frequency.value = 0.3;  // Slower default rate
    this.modGain1 = ctx.createGain();
    this.modGain1.gain.value = 0;  // Start at 0 to avoid initial "wou" sound

    this.modLFO2 = ctx.createOscillator();
    this.modLFO2.type = 'triangle';
    this.modLFO2.frequency.value = 0.17;  // Much slower secondary
    this.modGain2 = ctx.createGain();
    this.modGain2.gain.value = 0;  // Start at 0

    this.modLFO1.connect(this.modGain1);
    this.modLFO2.connect(this.modGain2);
    this.modLFO1.start();
    this.modLFO2.start();

    // Ducking
    this.duckingGain = ctx.createGain();
    this.duckingGain.gain.value = 1;

    // Mix
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();

    // Metering
    this.inputAnalyzer = ctx.createAnalyser();
    this.inputAnalyzer.fftSize = 256;
    this.outputAnalyzer = ctx.createAnalyser();
    this.outputAnalyzer.fftSize = 256;

    this.setupChain();
    this.ducker = new EnvelopeDucker(ctx, this.input, this.duckingGain.gain);
    this.applyParams();
  }

  private createLine(): DelayLine {
    const ctx = this.ctx;
    const delay = ctx.createDelay(4.0);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    // Q en dB pour ces filtres : -3 dB = Butterworth, aucune bosse de
    // resonance qui pousserait la boucle au-dela de 1.
    hp.Q.value = -3.01;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 8000;
    lp.Q.value = -3.01;
    const sat = ctx.createWaveShaper();
    sat.oversample = '2x';
    const fb = ctx.createGain();
    fb.gain.value = 0;
    const toSelf = ctx.createGain();
    const toOther = ctx.createGain();
    delay.connect(hp);
    hp.connect(lp);
    lp.connect(sat);
    sat.connect(fb);
    fb.connect(toSelf);
    fb.connect(toOther);
    toSelf.connect(delay);
    return { delay, hp, lp, sat, fb, toSelf, toOther };
  }

  private updateSaturationCurve() {
    const mode = this.params.mode;
    const sat = Number.isFinite(this.params.saturation) ? Math.max(0, Math.min(1, this.params.saturation)) : 0.3;
    const key = `${mode}:${sat.toFixed(3)}`;
    if (key === this.curveKey) return;
    this.curveKey = key;
    // Toutes les courbes ont une pente 1 a l'origine : la saturation colore
    // les repetitions fortes sans changer le niveau du feedback (avant, TAPE
    // amplifiait x1,7 dans la boucle et partait en larsen des 60 % de feedback).
    // Un limiteur doux borne aussi le mode DIGITAL : jamais d'emballement.
    const soft = (x: number) => {
      const a = Math.abs(x);
      return a < 0.7 ? x : Math.sign(x) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
    };
    let fn: (x: number) => number;
    switch (mode) {
      case 'TAPE': {
        const k = 1 + 2 * sat;
        fn = x => Math.tanh(k * x) / k;
        break;
      }
      case 'ANALOG': {
        // Asymetrique (harmoniques paires), normalisee en pente et en zero.
        const k = 1 + 2.5 * sat, b = 0.2;
        const t0 = Math.tanh(k * b), slope = k * (1 - t0 * t0);
        fn = x => (Math.tanh(k * (x + b)) - t0) / slope;
        break;
      }
      case 'DIFFUSE':
        fn = x => x - (x * x * x) / 3;
        break;
      default:
        fn = soft;
    }
    const curve = makeCurve(4097, x => soft(fn(x)));
    this.lineL.sat.curve = curve;
    this.lineR.sat.curve = curve;
  }

  private setupChain() {
    // Input metering
    this.input.connect(this.inputAnalyzer);

    // Dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Entrees des lignes
    this.input.connect(this.stereoIn);
    this.input.connect(this.monoIn);
    this.stereoIn.connect(this.inSplitter);
    this.inSplitter.connect(this.inL, 0);
    this.inSplitter.connect(this.inR, 1);
    this.inL.connect(this.lineL.delay);
    this.inR.connect(this.lineR.delay);
    this.monoIn.connect(this.monoToL);
    this.monoToL.connect(this.lineL.delay);

    // Ping-pong : G -> D -> G ... (chaque repetition change de cote).
    // L'ancien cablage renvoyait toutes les repetitions dans la ligne droite.
    this.lineL.toOther.connect(this.lineR.delay);
    this.lineR.toOther.connect(this.lineL.delay);

    // Modulation connections
    this.modGain1.connect(this.lineL.delay.delayTime);
    this.modGain2.connect(this.lineL.delay.delayTime);
    this.modGain1.connect(this.lineR.delay.delayTime);
    this.modGain2.connect(this.lineR.delay.delayTime);

    // Multi-tap (depuis le mono, au centre)
    this.monoIn.connect(this.tap2Delay);
    this.monoIn.connect(this.tap3Delay);
    this.monoIn.connect(this.tap4Delay);
    this.tap2Delay.connect(this.tap2Gain);
    this.tap3Delay.connect(this.tap3Gain);
    this.tap4Delay.connect(this.tap4Gain);
    this.tap2Gain.connect(this.analogFilter);
    this.tap3Gain.connect(this.analogFilter);
    this.tap4Gain.connect(this.analogFilter);

    // Sorties des lignes -> G / D, puis largeur stereo (matrice M/S)
    this.lineL.delay.connect(this.wetMerger, 0, 0);
    this.lineR.delay.connect(this.wetMerger, 0, 1);
    this.wetMerger.connect(this.widthSplitter);
    this.widthSplitter.connect(this.wLL, 0);
    this.widthSplitter.connect(this.wLR, 0);
    this.widthSplitter.connect(this.wRL, 1);
    this.widthSplitter.connect(this.wRR, 1);
    this.wLL.connect(this.widthMerger, 0, 0);
    this.wRL.connect(this.widthMerger, 0, 0);
    this.wLR.connect(this.widthMerger, 0, 1);
    this.wRR.connect(this.widthMerger, 0, 1);
    this.widthMerger.connect(this.analogFilter);

    // Output through ducking
    this.analogFilter.connect(this.duckingGain);
    this.duckingGain.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Output metering
    this.output.connect(this.outputAnalyzer);
  }

  public updateParams(p: Partial<DelayParams>) {
    this.params = { ...this.params, ...p };
    this.updateSaturationCurve();
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    const T = SMOOTH;
    const bpm = Math.max(20, Math.min(400, safe(this.params.bpm, 120)));
    const beatDuration = 60 / bpm;
    const factor = (d: DelayDivision | undefined) => DIVISION_FACTORS[d as DelayDivision] ?? 1;
    // 4 s max (taille des DelayNode)
    const delayL = Math.min(3.99, beatDuration * factor(this.params.division));
    const delayR = Math.min(3.99, beatDuration * factor(this.params.divisionR || this.params.division));

    if (this.params.isEnabled) {
      // Main delay times (glissement doux facon bande, pas de clic)
      this.setP(this.lineL.delay.delayTime, delayL, 0.05);
      this.setP(this.lineR.delay.delayTime, delayR, 0.05);

      // Multi-tap times (fractions of main delay)
      if (this.params.multiTap) {
        this.setP(this.tap2Delay.delayTime, delayL * 0.5, 0.05);
        this.setP(this.tap3Delay.delayTime, delayL * 0.75, 0.05);
        this.setP(this.tap4Delay.delayTime, delayL * 0.25, 0.05);
        this.setP(this.tap2Gain.gain, safe(this.params.tap2Level, 0.5), T);
        this.setP(this.tap3Gain.gain, safe(this.params.tap3Level, 0.35), T);
        this.setP(this.tap4Gain.gain, safe(this.params.tap4Level, 0.2), T);
      } else {
        this.setP(this.tap2Gain.gain, 0, T);
        this.setP(this.tap3Gain.gain, 0, T);
        this.setP(this.tap4Gain.gain, 0, T);
      }

      // Feedback (borne a 0,95 ; freeze a 0,985 : le limiteur de boucle evite
      // toute explosion meme si un filtre resonne un peu)
      const fb = this.params.freeze ? 0.985 : Math.max(0, Math.min(0.95, safe(this.params.feedback, 0.4)));
      this.setP(this.lineL.fb.gain, fb, T);
      this.setP(this.lineR.fb.gain, fb, T);

      // Routage stereo / ping-pong par gains (pas de recablage => pas de clic)
      const pp = this.params.pingPong ? 1 : 0;
      this.setP(this.inL.gain, 1 - pp, T);
      this.setP(this.inR.gain, 1 - pp, T);
      this.setP(this.monoToL.gain, pp, T);
      this.setP(this.lineL.toSelf.gain, 1 - pp, T);
      this.setP(this.lineR.toSelf.gain, 1 - pp, T);
      this.setP(this.lineL.toOther.gain, pp, T);
      this.setP(this.lineR.toOther.gain, pp, T);

      // Largeur : 0 = mono, 1 = G/D separes
      const w = Math.max(0, Math.min(1, safe(this.params.stereoWidth, 1)));
      const a = (1 + w) / 2, b = (1 - w) / 2;
      this.setP(this.wLL.gain, a, T);
      this.setP(this.wRR.gain, a, T);
      this.setP(this.wLR.gain, b, T);
      this.setP(this.wRL.gain, b, T);

      // Feedback filters
      const hpF = Math.max(20, Math.min(5000, safe(this.params.feedbackHP, 80)));
      const lpF = Math.max(500, Math.min(20000, safe(this.params.feedbackLP, 8000)));
      for (const line of [this.lineL, this.lineR]) {
        this.setP(line.hp.frequency, hpF, T);
        this.setP(line.lp.frequency, lpF, T);
      }

      // Modulation - reduced values to prevent "wou wou" artifacts
      const modEnabled = this.params.mode === 'TAPE' || this.params.mode === 'ANALOG';
      const modDepth = modEnabled ? safe(this.params.modDepth, 0.05) : 0;  // Default reduced from 0.15 to 0.05
      this.setP(this.modLFO1.frequency, Math.max(0.1, safe(this.params.modRate, 0.3)), 0.05);
      this.setP(this.modLFO2.frequency, Math.max(0.05, safe(this.params.modRate, 0.3) * 0.5), 0.05);
      // Much smaller modulation depth values to avoid pitch wobble
      this.setP(this.modGain1.gain, modDepth * 0.0003, 0.1);  // Reduced from 0.002
      this.setP(this.modGain2.gain, modDepth * 0.0001, 0.1);  // Reduced from 0.0008

      // Analog warmth based on mode
      const warmth = this.params.mode === 'TAPE' ? 3 : (this.params.mode === 'ANALOG' ? 4 : 0);
      this.setP(this.analogFilter.gain, warmth, T);

      // Ducking : les echos s'effacent quand la voix chante, reviennent entre les phrases
      this.ducker.setAmount(safe(this.params.ducking, 0));

      // Mix with equal-power crossfade
      const mix = Math.max(0, Math.min(1, safe(this.params.mix, 0.3)));
      this.setP(this.dryGain.gain, Math.cos(mix * Math.PI * 0.5), T);
      this.setP(this.wetGain.gain, Math.sin(mix * Math.PI * 0.5), T);

    } else {
      this.setP(this.dryGain.gain, 1, T);
      this.setP(this.wetGain.gain, 0, T);
    }
  }

  public getParameters(): PluginParameter[] {
    return [
      { id: 'feedback', name: 'Feedback', type: 'float', min: 0, max: 0.95, value: this.params.feedback, unit: '%' },
      { id: 'mix', name: 'Dry/Wet', type: 'float', min: 0, max: 1, value: this.params.mix, unit: '%' },
      { id: 'feedbackLP', name: 'Tone', type: 'float', min: 1000, max: 20000, value: this.params.feedbackLP, unit: 'Hz' }
    ];
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch (paramId) {
      case 'feedback': return this.lineL.fb.gain;
      case 'mix': return this.wetGain.gain;
      case 'feedbackLP': return this.lineL.lp.frequency;
      case 'feedbackHP': return this.lineL.hp.frequency;
      default: return null;
    }
  }

  public dispose() {
    try {
      if (this.modLFO1) {
        this.modLFO1.stop();
        this.modLFO1.disconnect();
      }
      if (this.modLFO2) {
        this.modLFO2.stop();
        this.modLFO2.disconnect();
      }
      this.ducker.disconnect();
    } catch (e) {
      // Oscillators may already be stopped
    }
  }

  public getParams() { return { ...this.params }; }
}

export const SyncDelayUI: React.FC<{ node: SyncDelayNode, initialParams: DelayParams, onParamsChange?: (p: DelayParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = useCallback((key: keyof DelayParams, value: any) => {
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
    let frameId = 0;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = (w / 8) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const beatDuration = 60 / params.bpm;
      const delayTimeL = beatDuration * DIVISION_FACTORS[params.division] * 1000;
      const delayTimeR = beatDuration * DIVISION_FACTORS[params.divisionR || params.division] * 1000;
      const progress = (Date.now() % delayTimeL) / delayTimeL;

      // Animated pulse
      if (params.isEnabled) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(0, 242, 255, ${(1 - progress) * 0.5})`;
        ctx.lineWidth = 3;
        ctx.arc(60, h / 2, 20 + progress * 25, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Center dot
      ctx.beginPath();
      ctx.fillStyle = params.isEnabled ? '#00f2ff' : '#334155';
      ctx.arc(60, h / 2, 6, 0, Math.PI * 2);
      ctx.fill();

      // Delay taps visualization
      const numTaps = params.multiTap ? 6 : (params.pingPong ? 6 : 4);
      const startX = 120;
      const spacing = (w - 160) / numTaps;

      for (let i = 1; i <= numTaps; i++) {
        const x = startX + (i - 1) * spacing;
        const feedbackDecay = Math.pow(params.feedback, i);
        const flicker = params.mode === 'TAPE' ? (0.9 + Math.random() * 0.2) : 1;
        const height = feedbackDecay * (h - 40) * flicker;
        
        // Pan indicator for ping-pong
        let color = '#00f2ff';
        if (params.pingPong) {
          color = i % 2 === 0 ? '#ff6b6b' : '#00f2ff';
        }
        
        // Gradient bar
        const gradient = ctx.createLinearGradient(x, h/2 - height/2, x, h/2 + height/2);
        gradient.addColorStop(0, color);
        gradient.addColorStop(0.5, `${color}99`);
        gradient.addColorStop(1, color);
        
        ctx.fillStyle = gradient;
        ctx.globalAlpha = feedbackDecay * 0.6;
        ctx.fillRect(x - 3, h/2 - height/2, 6, height);
        ctx.globalAlpha = 1;
        
        // Tap number
        ctx.fillStyle = '#334155';
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${i}`, x, h - 8);
      }

      // Mode indicator
      ctx.fillStyle = '#334155';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${params.mode}`, 10, 15);
      
      // BPM and timing
      ctx.textAlign = 'right';
      ctx.fillText(`${params.bpm} BPM`, w - 10, 15);
      ctx.fillText(`${params.division}`, w - 10, h - 8);

      frameId = requestAnimationFrame(draw);
    };
    
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [params]);

  return (
    <div className="w-[620px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-history text-xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black text-white tracking-tight leading-none">Écho (delay)</h2>
            <p className="text-[11px] text-slate-400 mt-1">Répète la fin des mots en rythme avec le beat.</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          <button 
            onClick={() => handleParamChange('freeze', !params.freeze)}
            className={`px-3 h-8 rounded-xl text-[8px] font-black uppercase transition-all border ${params.freeze ? 'bg-purple-500 border-purple-400 text-white shadow-lg shadow-purple-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            <i className="fas fa-snowflake mr-1"></i>Freeze
          </button>
          <button 
            onClick={() => handleParamChange('pingPong', !params.pingPong)}
            className={`px-3 h-8 rounded-xl text-[8px] font-black uppercase transition-all border ${params.pingPong ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            Ping-Pong
          </button>
          <button 
            onClick={() => handleParamChange('multiTap', !params.multiTap)}
            className={`px-3 h-8 rounded-xl text-[8px] font-black uppercase transition-all border ${params.multiTap ? 'bg-amber-500 border-amber-400 text-black shadow-lg shadow-amber-500/20' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            Multi-Tap
          </button>
          <button data-plugin-power 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <i className="fas fa-power-off text-sm"></i>
          </button>
        </div>
      </div>

      {/* Mode Selector */}
      <div className="flex bg-black/40 p-1 rounded-xl border border-white/5">
        {(['DIGITAL', 'TAPE', 'ANALOG', 'DIFFUSE'] as DelayMode[]).map(m => (
          <button 
            key={m}
            onClick={() => handleParamChange('mode', m)}
            className={`flex-1 py-2 rounded-lg text-[8px] font-black uppercase transition-all ${params.mode === m ? 'bg-cyan-500 text-black shadow-lg' : 'text-slate-500 hover:text-white'}`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Visualization */}
      <div className="h-28 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden shadow-inner">
        <canvas ref={canvasRef} width={580} height={112} className="w-full h-full" />
      </div>

      {/* Time Division */}
      <div className="flex bg-black/40 p-1 rounded-xl border border-white/5 justify-between">
        {(['1/4', '1/4D', '1/8', '1/8D', '1/8T', '1/16', '1/16D', '1/32'] as DelayDivision[]).map(d => (
          <button 
            key={d}
            onClick={() => handleParamChange('division', d)}
            className={`flex-1 py-2 rounded-lg text-[8px] font-black uppercase transition-all ${params.division === d ? 'bg-white text-black shadow-lg' : 'text-slate-500 hover:text-white'}`}
          >
            {d}
          </button>
        ))}
      </div>

      {/* Main Controls */}
      <div className="grid grid-cols-5 gap-4">
        <DelayKnob label="Feedback" value={params.feedback} min={0} max={0.95} factor={100} suffix="%" color="#00f2ff" onChange={v => handleParamChange('feedback', v)} />
        <DelayKnob label="Tone LP" value={params.feedbackLP || 8000} min={1000} max={20000} log suffix="Hz" color="#00f2ff" onChange={v => handleParamChange('feedbackLP', v)} />
        <DelayKnob label="Saturation" value={params.saturation || 0.3} min={0} max={1} factor={100} suffix="%" color="#f59e0b" onChange={v => handleParamChange('saturation', v)} />
        <DelayKnob label="Width" value={params.stereoWidth || 1} min={0} max={1} factor={100} suffix="%" color="#a855f7" onChange={v => handleParamChange('stereoWidth', v)} />
        <DelayKnob label="Mix" value={params.mix} min={0} max={1} factor={100} suffix="%" color="#fff" onChange={v => handleParamChange('mix', v)} />
      </div>

      {/* Advanced Toggle */}
      <button 
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center justify-center space-x-2 py-2 text-[8px] font-black text-slate-500 uppercase tracking-widest hover:text-white transition-colors"
      >
        <span>{showAdvanced ? 'Hide' : 'Show'} Advanced</span>
        <i className={`fas fa-chevron-${showAdvanced ? 'up' : 'down'} text-[6px]`}></i>
      </button>

      {/* Advanced Controls */}
      {showAdvanced && (
        <div className="grid grid-cols-5 gap-4 pt-4 border-t border-white/5">
          <DelayKnob label="Tone HP" value={params.feedbackHP || 80} min={20} max={2000} log suffix="Hz" color="#f43f5e" onChange={v => handleParamChange('feedbackHP', v)} />
          <DelayKnob label="Mod Rate" value={params.modRate || 0.5} min={0} max={5} suffix="Hz" color="#8b5cf6" onChange={v => handleParamChange('modRate', v)} />
          <DelayKnob label="Mod Depth" value={params.modDepth || 0.15} min={0} max={1} factor={100} suffix="%" color="#8b5cf6" onChange={v => handleParamChange('modDepth', v)} />
          <DelayKnob label="Ducking" value={params.ducking || 0} min={0} max={1} factor={100} suffix="%" color="#10b981" onChange={v => handleParamChange('ducking', v)} />
          <div className="flex flex-col items-center justify-center">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest mb-2">Temps D</span>
            <select 
              value={params.divisionR || params.division}
              onChange={(e) => handleParamChange('divisionR', e.target.value as DelayDivision)}
              className="bg-[#14161a] border border-white/10 rounded-lg px-2 py-1 text-[9px] font-black text-white w-full cursor-pointer hover:border-cyan-500/50 transition-all"
            >
              {(['1/4', '1/4D', '1/8', '1/8D', '1/16'] as DelayDivision[]).map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="pt-4 border-t border-white/5 flex justify-between items-center text-slate-700">
        <div className="flex items-center space-x-4">
          <div className="flex flex-col">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Moteur</span>
            <span className="text-[9px] font-black text-slate-400">{params.mode} DSP</span>
          </div>
          {params.multiTap && (
            <div className="flex flex-col">
              <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Répétitions</span>
              <span className="text-[9px] font-black text-amber-400">4 actives</span>
            </div>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-cyan-500 shadow-[0_0_10px_#00f2ff] animate-pulse' : 'bg-slate-800'}`} />
          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">
            {params.freeze ? 'FROZEN' : (params.pingPong ? 'STEREO' : 'MONO')}
          </span>
        </div>
      </div>
    </div>
  );
};

const DelayKnob: React.FC<{ 
  label: string, value: number, min: number, max: number, 
  onChange: (v: number) => void, suffix: string, color: string, 
  log?: boolean, factor?: number 
}> = ({ label, value, min, max, onChange, suffix, color, log, factor = 1 }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const knob = useKnobInteraction(safeValue, onChange, { min, max, log });
  const norm = log 
    ? (Math.log10(safeValue / min) / Math.log10(max / min)) 
    : (safeValue - min) / (max - min);

  return (
    <div className="flex flex-col items-center space-y-3 select-none touch-none">
      <div 
        {...knob.bind}
        className="relative w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-cyan-500/50 transition-all shadow-xl"
      >
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div 
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75"
          style={{ 
            backgroundColor: color,
            boxShadow: `0 0 12px ${color}44`,
            transform: `rotate(${(norm * 270) - 135}deg) translateY(2px)` 
          }}
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[9px] font-bold text-slate-400 mb-1 whitespace-nowrap" title={termHelp(paramFr(label)) || undefined}>{paramFr(label)}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">
            {Math.round(safeValue * factor * 10) / 10}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};
