import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AutomationSet, MappedParam, mixDry, mixWet, mixFromWet } from '../engine/automationParams';
import { Faceplate, HwSection, HwWindow, Knob, PushButton, useHwHelp, type KnobProps } from './hw';
import { hwCtx, useHwCanvas } from './hw/screens';
import { termHelp } from '../utils/pluginUi';
import { PluginParameter } from '../types';
import { EnvelopeDucker, makeCurve, SMOOTH, setParamSmooth, fadeInOnInsert, TimelineLfo } from './vocalDspUtils';

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
  /** Réglages automatisables (R8) : mix, réinjection, couleur des échos. */
  private auto = new AutomationSet();
  private autoState = '';
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
  // LFO calés sur le morceau (même phase en lecture et à l'export)
  private modLFO1: TimelineLfo;
  private modLFO2: TimelineLfo;  // Secondary for complex modulation
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

    // Fondu d'apparition (anti-clic) en direct ; aucun à l'export (le rendu démarre sur le son).
    fadeInOnInsert(this.output.gain, ctx);

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
    this.modGain1 = ctx.createGain();
    this.modGain1.gain.value = 0;  // Start at 0 to avoid initial "wou" sound
    this.modGain2 = ctx.createGain();
    this.modGain2.gain.value = 0;  // Start at 0
    this.modLFO1 = new TimelineLfo(ctx, this.modGain1, 0.3, 0, 'sine');       // Slower default rate
    this.modLFO2 = new TimelineLfo(ctx, this.modGain2, 0.17, 0, 'triangle');  // Much slower secondary

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
    this.auto.add('mix', new MappedParam(ctx, [{ param: this.wetGain.gain, map: mixWet }, { param: this.dryGain.gain, map: mixDry }], { min: 0, max: 1, value: 0.3, inverse: mixFromWet }));
    this.auto.add('feedback', new MappedParam(ctx, [{ param: this.lineL.fb.gain }, { param: this.lineR.fb.gain }], { min: 0, max: 0.985, value: 0.4, affine: true }));
    this.auto.add('feedbackLP', new MappedParam(ctx, [{ param: this.lineL.lp.frequency }, { param: this.lineR.lp.frequency }], { min: 500, max: 20000, value: 8000, affine: true }));
    this.applyParams();
  }

  /** AudioParam d'un réglage automatisable (R8) : « mix », « feedback », « feedbackLP » ; sinon null. */
  public automationParam(key: string): MappedParam | null { return this.auto.get(key); }
  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

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
    const stKey = `${this.params.isEnabled ? 1 : 0}|${this.params.freeze ? 1 : 0}`;
    const force = stKey !== this.autoState;
    this.autoState = stKey;
    const st = { force, tau: T, immediate: now <= this.createdAt };
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
      this.auto.get('feedback')!.setStatic(fb, st);

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
      for (const line of [this.lineL, this.lineR]) this.setP(line.hp.frequency, hpF, T);
      this.auto.get('feedbackLP')!.setStatic(lpF, st);

      // Modulation - reduced values to prevent "wou wou" artifacts
      const modEnabled = this.params.mode === 'TAPE' || this.params.mode === 'ANALOG';
      const modDepth = modEnabled ? safe(this.params.modDepth, 0.05) : 0;  // Default reduced from 0.15 to 0.05
      this.modLFO1.setFrequency(Math.max(0.1, safe(this.params.modRate, 0.3)));
      this.modLFO2.setFrequency(Math.max(0.05, safe(this.params.modRate, 0.3) * 0.5));
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
      this.auto.get('mix')!.setStatic(mix, st);

    } else {
      this.auto.get('mix')!.setStatic(0, st);
    }
  }

  /** Modulation calée sur la ligne de temps du morceau (le moteur appelle syncTimeline). */
  public get followsTimeline(): boolean { return true; }
  public syncTimeline(origin: number, at?: number) { this.modLFO1.sync(origin, at); this.modLFO2.sync(origin, at); }

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
      this.modLFO1?.stop();
      this.modLFO2?.stop();
      this.ducker.disconnect();
    } catch (e) {
      // Oscillators may already be stopped
    }
  }

  public getParams() { return { ...this.params }; }
}

const dlNum = (v: number, def: number) => (Number.isFinite(v) ? v : def);
// ── Fenêtre ─────────────────────────────────────────────────────────────────

const DL_ACCENT = '#ffa24c';
/** Valeurs du moteur quand le projet n'en donne pas (affichage seulement). */
const DL_DEFAULTS: Partial<DelayParams> = {
  division: '1/4', divisionR: '1/4', feedback: 0.4, feedbackHP: 80, feedbackLP: 8000, mix: 0.3, stereoWidth: 1, pingPong: false, ducking: 0,
  saturation: 0.3, modRate: 0.3, modDepth: 0.05, mode: 'DIGITAL', freeze: false, multiTap: false, tap2Level: 0.5, tap3Level: 0.35, tap4Level: 0.2, bpm: 120,
};
const DL_MODES: { id: DelayMode; label: string; hint: string }[] = [
  { id: 'DIGITAL', label: 'Numérique', hint: 'Répétitions propres et nettes, sans couleur.' },
  { id: 'TAPE', label: 'Bande', hint: 'Écho à bande : répétitions chaudes qui s’usent, léger pleurage.' },
  { id: 'ANALOG', label: 'Analogique', hint: 'Écho analogique : plus sombre et rond, chaque répétition se salit.' },
  { id: 'DIFFUSE', label: 'Diffus', hint: 'Répétitions adoucies qui se fondent dans une nappe.' },
];
/** Temps proposés (du plus long au plus court). D = pointée, T = triolet. */
const DL_DIVS: DelayDivision[] = ['1/4', '1/4D', '1/8', '1/8D', '1/8T', '1/16', '1/16D', '1/32'];
const divName = (d: DelayDivision) => {
  const base = d.replace(/[DT]$/, '');
  const note: Record<string, string> = { '1/1': 'ronde', '1/2': 'blanche', '1/4': 'noire', '1/8': 'croche', '1/16': 'double croche', '1/32': 'triple croche' };
  return `${d} (${note[base] || base}${d.endsWith('D') ? ' pointée' : d.endsWith('T') ? ' en triolet' : ''})`;
};
const dlPct = (v: number) => `${Math.round((v || 0) * 100)} %`;
const dlHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kHz` : `${Math.round(hz)} Hz`);
const dlMs = (s: number) => `${Math.round(s * 1000)} ms`;

/**
 * Écran de l'écho : les répétitions dans le temps (hauteur = niveau), gauche
 * au-dessus, droite en dessous, calées sur la grille du tempo. Dessiné quand
 * un réglage change seulement.
 */
const DelayScreen: React.FC<{ p: DelayParams; tL: number; tR: number }> = ({ p, tL, tR }) => {
  const { wrapRef, canvasRef, size } = useHwCanvas();
  const help = useHwHelp('dl-screen', 'Répétitions', 'Chaque barre est une répétition : en haut le côté gauche, en bas le côté droit. Elles baissent selon « Répétitions » ; la grille montre les temps du morceau.', undefined);
  useEffect(() => {
    const c = hwCtx(canvasRef.current, size);
    if (!c) return;
    const { w, h } = size;
    c.clearRect(0, 0, w, h);
    const mid = h / 2, pad = 16;
    const beat = 60 / Math.max(20, Math.min(400, Number(p.bpm) || 120));
    const fb = p.freeze ? 0.985 : Math.max(0, Math.min(0.95, Number.isFinite(p.feedback) ? p.feedback : 0.4));
    const T = Math.max(beat * 2, Math.min(8, Math.max(tL, tR) * 8.5));
    const xOf = (t: number) => 8 + (t / T) * (w - 16);
    // Grille des temps
    c.font = '600 9px Inter, system-ui, sans-serif'; c.textAlign = 'center';
    for (let k = 0; k * beat <= T + 1e-6; k++) {
      const x = Math.round(xOf(k * beat)) + 0.5;
      c.strokeStyle = k % 4 === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
      c.beginPath(); c.moveTo(x, 6); c.lineTo(x, h - 6); c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.2)'; c.beginPath(); c.moveTo(0, mid + 0.5); c.lineTo(w, mid + 0.5); c.stroke();
    // Son d'origine
    c.fillStyle = '#f6edd6'; c.fillRect(xOf(0) - 1.5, pad, 3, h - 2 * pad);
    const bar = (t: number, lvl: number, up: boolean, col: string) => {
      if (t > T || lvl < 0.01) return;
      const hh = Math.min(1, lvl) * (mid - pad);
      const x = xOf(t);
      c.fillStyle = col; c.globalAlpha = 0.35 + 0.65 * Math.min(1, lvl);
      c.fillRect(x - 2.5, up ? mid - hh : mid, 5, hh);
      c.globalAlpha = 1;
    };
    const L = '#ffa24c', R = '#7dd3fc';
    let tp = 0;
    for (let n = 1; n <= 40; n++) {
      const lvl = Math.pow(fb, n - 1);
      if (p.pingPong) {
        // Ping-pong : première frappe à gauche, puis chaque répétition change de côté (temps G puis D).
        tp += n % 2 === 1 ? tL : tR;
        bar(tp, lvl, n % 2 === 1, n % 2 === 1 ? L : R);
      } else {
        bar(n * tL, lvl, true, L);
        bar(n * tR, lvl, false, R);
      }
    }
    if (p.multiTap) {
      const taps: [number, number][] = [[0.25, dlNum(p.tap4Level, 0.2)], [0.5, dlNum(p.tap2Level, 0.5)], [0.75, dlNum(p.tap3Level, 0.35)]];
      for (const [f, lv] of taps) { bar(tL * f, lv, true, '#fde68a'); bar(tL * f, lv, false, '#fde68a'); }
    }
    c.fillStyle = 'rgba(246,237,214,0.8)'; c.textAlign = 'left';
    c.fillText('G', 4, 13); c.fillText('D', 4, h - 5);
  }, [p.bpm, p.feedback, p.freeze, p.pingPong, p.multiTap, p.tap2Level, p.tap3Level, p.tap4Level, tL, tR, size]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={wrapRef} className="relative h-full w-full" onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}>
      <canvas ref={canvasRef} className="hw-screen-canvas" aria-label="Répétitions de l’écho dans le temps, côté gauche en haut et côté droit en bas" />
      {p.freeze && <span className="hw-screen-label" style={{ right: 8, top: 6, color: '#7dd3fc' }}>Figé : les répétitions tournent sans fin</span>}
    </div>
  );
};

export const SyncDelayUI: React.FC<{ node: SyncDelayNode, initialParams: DelayParams, onParamsChange?: (p: DelayParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const paramsRef = useRef(params);
  const base = useRef<Partial<DelayParams>>((() => { try { return node?.getParams?.() || {}; } catch { return {}; } })());
  const v = { ...DL_DEFAULTS, ...base.current, ...params } as DelayParams;

  const apply = useCallback((patch: Partial<DelayParams>) => {
    const next = { ...paramsRef.current, ...patch } as DelayParams;
    paramsRef.current = next;
    setParams(next);
    node.updateParams(next);
    onParamsChange?.(next);
  }, [node, onParamsChange]);

  const bpm = Math.max(20, Math.min(400, Number(v.bpm) || 120));
  const beat = 60 / bpm;
  const tL = Math.min(3.99, beat * (DIVISION_FACTORS[v.division] ?? 1));
  const divR = (v.divisionR || v.division) as DelayDivision;
  const tR = Math.min(3.99, beat * (DIVISION_FACTORS[divR] ?? 1));
  const divs = (cur: DelayDivision) => (DL_DIVS.includes(cur) ? DL_DIVS : [...DL_DIVS, cur].sort((a, b) => (DIVISION_FACTORS[b] ?? 0) - (DIVISION_FACTORS[a] ?? 0)));
  const listL = divs(v.division), listR = divs(divR);
  const modOn = v.mode === 'TAPE' || v.mode === 'ANALOG';
  const help = (label: string, h: string) => [h, termHelp(label)].filter(Boolean).join(' · ');
  const K = (id: keyof DelayParams, o: Partial<KnobProps> & { min: number; max: number; def: number }) => {
    const { def, ...rest } = o;
    const raw = Number((v as any)[id]);
    return (
      <Knob key={id as string} paramId={id as string} size="S" cap="cream" arc={DL_ACCENT} ticks={11} defaultValue={def}
        value={Number.isFinite(raw) ? raw : def} onChange={x => apply({ [id]: x } as any)} {...rest} />
    );
  };
  const toggle = (id: 'pingPong' | 'multiTap' | 'freeze', text: string, hint: string) => (
    <PushButton key={id} active={!!v[id]} onClick={() => apply({ [id]: !v[id] } as any)} text={text} led={DL_ACCENT} hint={hint}
      valueText={v[id] ? 'enfoncé' : 'relevé'} dataAttrs={{ 'data-nova-param': id }} />
  );

  return (
    <HwWindow type="DELAY" width={740} accent={DL_ACCENT} accentInk="#1f0f02"
      idleHelp={<>Écho calé sur le tempo du morceau : répète la fin des mots en rythme avec le beat. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="black" className="hw-finish-sea" model="Écho" kicker="Delay calé sur le tempo · bande, analogique, numérique" modelStyle="serif" style={{ ['--hw-accent' as any]: DL_ACCENT }}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
          <div className="flex items-center gap-2.5">
            <span className="hw-led hw-led-lg hw-led-blink" data-on={v.isEnabled !== false ? 'true' : 'false'} style={{ ['--led' as any]: DL_ACCENT, ['--hw-blink' as any]: `${tL}s` }}
              title="Voyant de tempo : clignote à chaque répétition" aria-hidden="true" />
            <span className="hw-lcd hw-lcd-amber" data-nova-delay-time>{v.division} <small>{dlMs(tL)}{divR !== v.division ? ` · D ${divR} ${dlMs(tR)}` : ''} · {Math.round(bpm)} BPM</small></span>
          </div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Type d’écho">
            {DL_MODES.map(m => (
              <PushButton key={m.id} role="radio" active={v.mode === m.id} onClick={() => apply({ mode: m.id })} text={m.label} led={DL_ACCENT} hint={m.hint}
                valueText={v.mode === m.id ? 'choisi' : undefined} dataAttrs={{ 'data-nova-mode': m.id }} />
            ))}
          </div>
        </div>

        <div className="hw-screen">
          <div className="hw-screen-glass" style={{ height: 120 }}><DelayScreen p={v} tL={tL} tR={tR} /></div>
        </div>

        <div className="mt-3 flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
          <Knob paramId="division" label="Temps" ariaLabel="Temps de l’écho (gauche)" size="L" cap="cream" value={listL.indexOf(v.division)} min={0} max={listL.length - 1}
            detents={listL.map((d, i) => ({ v: i, label: d.replace('D', '.') }))} defaultValue={0}
            onChange={i => apply({ division: listL[Math.round(i)] })} format={i => divName(listL[Math.round(i)] || v.division)}
            hint="Écart entre le mot et sa répétition, en notes du tempo (D / « . » = pointée, T = triolet)." />
          <Knob paramId="divisionR" label="Temps D" ariaLabel="Temps de l’écho (droite)" size="M" cap="cream" value={listR.indexOf(divR)} min={0} max={listR.length - 1}
            detents={listR.map((d, i) => ({ v: i, label: d.replace('D', '.') }))} defaultValue={0}
            onChange={i => apply({ divisionR: listR[Math.round(i)] })} format={i => divName(listR[Math.round(i)] || divR)}
            hint="Temps du côté droit (stéréo décalée). Sans effet en ping-pong, où les répétitions alternent." />
          <Knob paramId="feedback" label="Répétitions" size="L" cap="cream" arc={DL_ACCENT} min={0} max={0.95} step={0.01} value={dlNum(v.feedback, 0.4)} defaultValue={0.4}
            onChange={x => apply({ feedback: x })} format={dlPct} scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 0.95, label: '95' }]}
            hint={help('Répétitions', 'Nombre de répétitions : bas = un seul écho, haut = de longues traînes.')} />
          <Knob paramId="mix" label="Mélange" size="L" cap="cream" arc={DL_ACCENT} min={0} max={1} step={0.01} value={dlNum(v.mix, 0.3)} defaultValue={0.3}
            onChange={x => apply({ mix: x })} format={dlPct} scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]}
            hint={help('Mélange', 'Part d’écho. En départ (bus de retour), mets 100 %.')} />
        </div>

        <div className="mt-3 flex flex-wrap items-start justify-center gap-x-4 gap-y-2">
          {toggle('pingPong', 'Ping-pong', 'Les répétitions sautent de gauche à droite.')}
          {toggle('multiTap', 'Multi-répétitions', 'Ajoute trois répétitions entre deux temps (¼, ½ et ¾ du temps).')}
          {toggle('freeze', 'Figer', 'Les répétitions tournent sans fin (transitions). Relâche pour revenir.')}
        </div>

        <div className="hw-rule" style={{ margin: '12px 0 10px' }} />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <HwSection title="Couleur des répétitions" className="flex-[3_1_220px] min-w-0">
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('feedbackHP', { label: 'Coupe-bas', min: 20, max: 2000, def: 80, curve: 'log', step: 1, format: dlHz, hint: help('Coupe-bas', 'Retire les graves des répétitions (plus clair, moins de boue).') })}
              {K('feedbackLP', { label: 'Coupe-haut', min: 1000, max: 20000, def: 8000, curve: 'log', step: 10, format: dlHz, hint: help('Coupe-haut', 'Retire les aigus : chaque répétition est plus sombre que la précédente.') })}
              {K('saturation', { label: 'Saturation', min: 0, max: 1, def: 0.3, step: 0.01, format: dlPct, hint: 'Grain des répétitions fortes (modes Bande et Analogique).' })}
            </div>
          </HwSection>
          <HwSection title="Mouvement et espace" className="flex-[4_1_300px] min-w-0">
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('modRate', { label: 'Pleurage', ariaLabel: 'Vitesse du pleurage', min: 0, max: 5, def: 0.3, step: 0.01, format: x => `${x.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Hz`,
                hint: `Vitesse de l’ondulation de la bande.${modOn ? '' : ' Actif en modes Bande et Analogique seulement.'}` })}
              {K('modDepth', { label: 'Profondeur', ariaLabel: 'Profondeur du pleurage', min: 0, max: 1, def: 0.05, step: 0.01, format: dlPct,
                hint: `Intensité de l’ondulation.${modOn ? '' : ' Actif en modes Bande et Analogique seulement.'}` })}
              {K('stereoWidth', { label: 'Largeur', ariaLabel: 'Largeur stéréo', min: 0, max: 1, def: 1, step: 0.01, format: dlPct, hint: help('Largeur stéréo', '0 % = répétitions au centre, 100 % = gauche et droite séparées.') })}
              {K('ducking', { label: 'Retrait', ariaLabel: 'Retrait sous la voix', min: 0, max: 1, def: 0, step: 0.01, format: dlPct, hint: help('Retrait sous la voix', 'Les échos se retirent quand tu chantes et reviennent entre les phrases.') })}
            </div>
          </HwSection>
        </div>
        {v.multiTap && (
          <HwSection title="Multi-répétitions" className="mt-2">
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('tap4Level', { label: '¼ du temps', ariaLabel: 'Niveau de la répétition à ¼', min: 0, max: 1, def: 0.2, step: 0.01, format: dlPct, hint: 'Niveau de la répétition placée au quart du temps.' })}
              {K('tap2Level', { label: '½ du temps', ariaLabel: 'Niveau de la répétition à ½', min: 0, max: 1, def: 0.5, step: 0.01, format: dlPct, hint: 'Niveau de la répétition placée à la moitié du temps.' })}
              {K('tap3Level', { label: '¾ du temps', ariaLabel: 'Niveau de la répétition à ¾', min: 0, max: 1, def: 0.35, step: 0.01, format: dlPct, hint: 'Niveau de la répétition placée aux trois quarts du temps.' })}
            </div>
          </HwSection>
        )}
      </Faceplate>
    </HwWindow>
  );
};
