import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AutomationSet, MappedParam, mixDry, mixWet, mixFromWet } from '../engine/automationParams';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { paramFr, termHelp } from '../utils/pluginUi';
import { PluginParameter } from '../types';
import { EnvelopeDucker, SMOOTH, setParamSmooth } from './vocalDspUtils';

/**
 * PROFESSIONAL REVERB ENGINE v5.0
 * ================================
 * Convolution sur une reponse impulsionnelle generee a la volee :
 * - bruit stereo decorrele, decroissance en deux bandes (damping = aigus
 *   qui meurent plus vite), montee de densite selon le mode et la taille
 * - regeneration seulement quand decay / size / damping / diffusion / mode
 *   changent, avec fondu entre deux convolveurs (aucun clic)
 * - pre-delay, EQ, largeur, modulation et ducking appliques en continu
 * - reflexions primaires alternees gauche / droite
 */

export type ReverbMode = 'ROOM' | 'HALL' | 'PLATE' | 'CATHEDRAL' | 'SHIMMER' | 'SPRING';


/** Générateur pseudo-aléatoire à graine (mulberry32) : la réponse de la réverbe ne change pas d'un rendu à l'autre. */
const seededRandom = (key: string): (() => number) => {
  let a = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 0x01000193);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface ReverbParams {
  decay: number;        // 0.1 to 15 seconds
  preDelay: number;     // 0 to 200ms (stored in seconds)
  size: number;         // 0 to 1 (room size/diffusion)
  damping: number;      // 0 to 1 (HF damping amount, 0=bright, 1=dark)
  mix: number;          // 0 to 1 (dry/wet)
  lowCut: number;       // 20 to 1000 Hz (HP on wet signal)
  highCut: number;      // 1000 to 20000 Hz (LP on wet signal)
  width: number;        // 0 to 2 (0=mono, 1=stereo, 2=wide)
  modRate: number;      // 0 to 5 Hz (modulation speed)
  modDepth: number;     // 0 to 1 (modulation amount)
  erLevel: number;      // 0 to 1 (early reflections level)
  diffusion: number;    // 0 to 1 (allpass diffusion amount)
  bassBoost: number;    // 0 to 1 (low freq enhancement in tail)
  freeze: boolean;      // Infinite sustain mode
  ducking: number;      // 0 to 1 (sidechain duck amount)
  mode: ReverbMode;
  isEnabled: boolean;
  name?: string;
  /**
   * Empreinte capturée (réponse impulsionnelle WAV, ex. /ir/make-music-vocal.wav) :
   * la reverb devient une copie par convolution d'une vraie reverb (celle du
   * studio). Decay, taille, diffusion et mode sont alors ignorés ; pré-délai,
   * filtres, largeur et mix restent actifs.
   */
  irUrl?: string;
}

// Empreintes capturées, décodées une fois par fréquence d'échantillonnage.
const capturedIrCache = new Map<string, Promise<AudioBuffer | null>>();
function loadCapturedIr(ctx: BaseAudioContext, url: string): Promise<AudioBuffer | null> {
  const key = `${ctx.sampleRate}|${url}`;
  let p = capturedIrCache.get(key);
  if (!p) {
    p = fetch(url)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`IR ${r.status}`))))
      .then(b => ctx.decodeAudioData(b))
      .catch(e => { console.warn('[Reverb] Empreinte introuvable, reverb calculée à la place', url, e); capturedIrCache.delete(key); return null; });
    capturedIrCache.set(key, p);
  }
  return p;
}
const loadedIrs = new Map<string, AudioBuffer>();

/**
 * Réponses calculées déjà prêtes (par fréquence et réglages exacts) : l'export,
 * le gel et chaque nouvelle reverb réutilisent celle déjà entendue, au lieu de
 * la recalculer (et d'en tirer une autre au hasard). Les 8 dernières suffisent.
 */
const builtIrs = new Map<string, AudioBuffer>();
const BUILT_IR_MAX = 8;
function rememberIr(key: string, ir: AudioBuffer) {
  builtIrs.delete(key);
  builtIrs.set(key, ir);
  while (builtIrs.size > BUILT_IR_MAX) builtIrs.delete(builtIrs.keys().next().value as string);
}

export const REVERB_PRESETS: Array<Partial<ReverbParams> & { name: string }> = [
  { 
    name: "Vocal Plate", 
    decay: 1.8, preDelay: 0.025, damping: 0.4, size: 0.6, mix: 0.22,
    lowCut: 200, highCut: 8000, width: 1.0, modRate: 0.5, modDepth: 0.1,
    erLevel: 0.3, diffusion: 0.8, bassBoost: 0.2, ducking: 0.2, mode: 'PLATE'
  },
  { 
    name: "Tight Room", 
    decay: 0.5, preDelay: 0.008, damping: 0.6, size: 0.25, mix: 0.18,
    lowCut: 150, highCut: 10000, width: 0.8, modRate: 0, modDepth: 0,
    erLevel: 0.6, diffusion: 0.5, bassBoost: 0.1, ducking: 0, mode: 'ROOM'
  },
  { 
    name: "Large Hall", 
    decay: 3.5, preDelay: 0.045, damping: 0.5, size: 0.85, mix: 0.28,
    lowCut: 100, highCut: 12000, width: 1.2, modRate: 0.3, modDepth: 0.15,
    erLevel: 0.4, diffusion: 0.9, bassBoost: 0.3, ducking: 0.15, mode: 'HALL'
  },
  { 
    name: "Cathedral", 
    decay: 6.0, preDelay: 0.080, damping: 0.3, size: 1.0, mix: 0.35,
    lowCut: 80, highCut: 8000, width: 1.5, modRate: 0.2, modDepth: 0.2,
    erLevel: 0.25, diffusion: 0.95, bassBoost: 0.4, ducking: 0.25, mode: 'CATHEDRAL'
  },
  { 
    name: "Shimmer Pad", 
    decay: 8.0, preDelay: 0.060, damping: 0.2, size: 0.9, mix: 0.45,
    lowCut: 300, highCut: 15000, width: 1.8, modRate: 2.0, modDepth: 0.4,
    erLevel: 0.15, diffusion: 1.0, bassBoost: 0.1, ducking: 0.3, mode: 'SHIMMER'
  },
  { 
    name: "Drums Room", 
    decay: 0.8, preDelay: 0.012, damping: 0.55, size: 0.4, mix: 0.2,
    lowCut: 100, highCut: 9000, width: 1.1, modRate: 0, modDepth: 0,
    erLevel: 0.5, diffusion: 0.6, bassBoost: 0.25, ducking: 0.1, mode: 'ROOM'
  },
  { 
    name: "Ambient Wash", 
    decay: 10.0, preDelay: 0.100, damping: 0.35, size: 1.0, mix: 0.5,
    lowCut: 200, highCut: 6000, width: 2.0, modRate: 1.5, modDepth: 0.35,
    erLevel: 0.1, diffusion: 1.0, bassBoost: 0.2, ducking: 0.4, mode: 'CATHEDRAL'
  },
  { 
    name: "Snare Plate", 
    decay: 1.2, preDelay: 0.015, damping: 0.45, size: 0.5, mix: 0.25,
    lowCut: 250, highCut: 12000, width: 1.0, modRate: 0.8, modDepth: 0.05,
    erLevel: 0.35, diffusion: 0.75, bassBoost: 0.15, ducking: 0, mode: 'PLATE'
  },
  { 
    name: "Spring Reverb", 
    decay: 2.0, preDelay: 0.005, damping: 0.5, size: 0.3, mix: 0.3,
    lowCut: 300, highCut: 6000, width: 0.6, modRate: 3.0, modDepth: 0.3,
    erLevel: 0.7, diffusion: 0.4, bassBoost: 0.0, ducking: 0, mode: 'SPRING'
  },
  { 
    name: "80s Gated", 
    decay: 0.4, preDelay: 0.020, damping: 0.3, size: 0.7, mix: 0.35,
    lowCut: 100, highCut: 10000, width: 1.4, modRate: 0, modDepth: 0,
    erLevel: 0.8, diffusion: 0.5, bassBoost: 0.5, ducking: 0, mode: 'ROOM'
  },
  { 
    name: "Dark Cave", 
    decay: 5.0, preDelay: 0.120, damping: 0.8, size: 0.95, mix: 0.4,
    lowCut: 60, highCut: 3000, width: 1.6, modRate: 0.1, modDepth: 0.1,
    erLevel: 0.2, diffusion: 0.85, bassBoost: 0.6, ducking: 0.2, mode: 'CATHEDRAL'
  },
  { 
    name: "Bright Chamber", 
    decay: 1.5, preDelay: 0.030, damping: 0.15, size: 0.5, mix: 0.25,
    lowCut: 250, highCut: 16000, width: 1.0, modRate: 0.4, modDepth: 0.08,
    erLevel: 0.45, diffusion: 0.7, bassBoost: 0.0, ducking: 0.1, mode: 'ROOM'
  }
];

/**
 * Caractere de chaque mode, applique a la reponse impulsionnelle generee :
 * - attack : temps de montee de la densite (petite piece = immediat, grande salle = lent)
 * - hf / lf : multiplicateurs du temps de decroissance des aigus / des graves
 */
const MODE_SHAPES: Record<ReverbMode, { attack: (size: number) => number; hf: number; lf: number; spring?: boolean }> = {
  ROOM:      { attack: s => 0.003 + 0.012 * s, hf: 0.9,  lf: 1.0 },
  HALL:      { attack: s => 0.008 + 0.05 * s,  hf: 1.0,  lf: 1.1 },
  PLATE:     { attack: () => 0.002,            hf: 1.2,  lf: 0.85 },
  CATHEDRAL: { attack: s => 0.02 + 0.09 * s,   hf: 0.85, lf: 1.2 },
  SHIMMER:   { attack: s => 0.015 + 0.05 * s,  hf: 1.35, lf: 0.8 },
  SPRING:    { attack: () => 0.002,            hf: 0.75, lf: 0.7, spring: true },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const safeNum = (v: number, def: number) => (Number.isFinite(v) ? v : def);

export class ReverbNode {
  private readonly createdAt: number;
  private setP(param: AudioParam, value: number, tau: number) {
    setParamSmooth(param, value, this.ctx, this.createdAt, tau);
  }
  /** Réglages automatisables (R8) : mix et pré-délai. */
  private auto = new AutomationSet();
  /** Mix automatisé : la voie d'effet reste branchée même si le mix fixe vaut 0. */
  private mixAutomated = false;
  private autoState = '';
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  // Deux convolveurs en alternance : la nouvelle reponse est chargee dans
  // celui qui est muet puis on fond de l'un a l'autre. Remplacer le buffer du
  // convolveur actif coupait net la queue (clic) a chaque reglage.
  private convA: ConvolverNode;
  private convB: ConvolverNode;
  private convGainA: GainNode;
  private convGainB: GainNode;
  private activeConv: 'A' | 'B' = 'A';
  private preDelayNode: DelayNode;

  // Modulation legere de la queue (evite le cote statique d'une convolution)
  private modDelay: DelayNode;
  private modLFO: OscillatorNode;
  private modDepthGain: GainNode;

  // EQ on wet signal
  private lowCutFilter: BiquadFilterNode;
  private highCutFilter: BiquadFilterNode;
  private bassBoostFilter: BiquadFilterNode;

  // Largeur (matrice M/S sur le wet)
  private widthSplitter: ChannelSplitterNode;
  private widthMerger: ChannelMergerNode;
  private wLL: GainNode; private wLR: GainNode; private wRL: GainNode; private wRR: GainNode;

  // Ducking : la reverb se retire pendant que la voix chante
  private duckGain: GainNode;
  private ducker: EnvelopeDucker;

  // Mix
  private wetGain: GainNode;
  private dryGain: GainNode;

  // Early reflections (6 taps, alternes gauche/droite)
  private erDelays: DelayNode[] = [];
  private erGains: GainNode[] = [];
  private erPanners: StereoPannerNode[] = [];
  private erMix: GainNode;

  // Metering
  public inputAnalyzer: AnalyserNode;
  public outputAnalyzer: AnalyserNode;
  private inputData: Float32Array;
  private outputData: Float32Array;

  // Regeneration de la reponse impulsionnelle
  private irKey = '';
  private lastIrTime = 0;
  private irTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly isOffline: boolean;

  /**
   * Branches débranchées quand elles ne peuvent rien ajouter au son : la queue
   * (reverb coupée ou mix à 0), les réflexions primaires (niveau 0) et la
   * modulation (profondeur 0). Le navigateur ne les calcule alors plus. Une
   * branche est rebranchée dès qu'elle sert ; débranchée tout de suite si rien
   * n'a encore sonné (export, gel), sinon après la fin du fondu.
   */
  private links!: Record<'wet' | 'er' | 'mod', { on: boolean; timer: ReturnType<typeof setTimeout> | null; connect: () => void; disconnect: () => void }>;

  private params: ReverbParams = {
    decay: 2.5,
    preDelay: 0.025,
    size: 0.7,
    damping: 0.5,
    mix: 0.3,
    // Valeurs par defaut pensees pour la voix : on coupe le grave qui
    // embourbe et l'extreme aigu qui siffle dans la queue.
    lowCut: 160,
    highCut: 10000,
    width: 1.0,
    modRate: 0.5,
    modDepth: 0.1,
    erLevel: 0.3,
    diffusion: 0.8,
    bassBoost: 0,
    freeze: false,
    ducking: 0,
    mode: 'HALL',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.createdAt = ctx.currentTime;
    this.isOffline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

    // I/O
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = 1.0;

    // Metering
    this.inputAnalyzer = ctx.createAnalyser();
    this.inputAnalyzer.fftSize = 256;
    this.inputData = new Float32Array(this.inputAnalyzer.frequencyBinCount);

    this.outputAnalyzer = ctx.createAnalyser();
    this.outputAnalyzer.fftSize = 256;
    this.outputData = new Float32Array(this.outputAnalyzer.frequencyBinCount);

    // Pre-delay
    this.preDelayNode = ctx.createDelay(0.5);
    this.preDelayNode.delayTime.value = 0.025;

    // Convolvers (main reverb)
    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    this.convGainA = ctx.createGain();
    this.convGainB = ctx.createGain();
    this.convGainA.gain.value = 1;
    this.convGainB.gain.value = 0;

    // Modulation
    this.modDelay = ctx.createDelay(0.05);
    this.modDelay.delayTime.value = 0.005;
    this.modLFO = ctx.createOscillator();
    this.modLFO.type = 'sine';
    this.modLFO.frequency.value = 0.5;
    this.modDepthGain = ctx.createGain();
    this.modDepthGain.gain.value = 0;
    this.modLFO.connect(this.modDepthGain);
    this.modLFO.start();

    // EQ filters
    this.lowCutFilter = ctx.createBiquadFilter();
    this.lowCutFilter.type = 'highpass';
    this.lowCutFilter.frequency.value = 160;
    this.lowCutFilter.Q.value = 0.707;

    this.highCutFilter = ctx.createBiquadFilter();
    this.highCutFilter.type = 'lowpass';
    this.highCutFilter.frequency.value = 10000;
    this.highCutFilter.Q.value = 0.707;

    this.bassBoostFilter = ctx.createBiquadFilter();
    this.bassBoostFilter.type = 'lowshelf';
    this.bassBoostFilter.frequency.value = 200;
    this.bassBoostFilter.gain.value = 0;

    // Width
    this.widthSplitter = ctx.createChannelSplitter(2);
    this.widthMerger = ctx.createChannelMerger(2);
    this.wLL = ctx.createGain(); this.wLR = ctx.createGain();
    this.wRL = ctx.createGain(); this.wRR = ctx.createGain();

    // Ducking
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;

    // Early reflections
    this.erMix = ctx.createGain();
    this.erMix.gain.value = 0.3;

    const erConfig = [
      { time: 0.012, gain: 0.6 },
      { time: 0.022, gain: 0.5 },
      { time: 0.035, gain: 0.4 },
      { time: 0.048, gain: 0.3 },
      { time: 0.065, gain: 0.2 },
      { time: 0.085, gain: 0.15 }
    ];

    erConfig.forEach((er, i) => {
      const delay = ctx.createDelay(0.25);
      delay.delayTime.value = er.time;
      const gain = ctx.createGain();
      gain.gain.value = er.gain;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i % 2 === 0 ? -1 : 1) * (0.35 + 0.1 * i);
      this.erDelays.push(delay);
      this.erGains.push(gain);
      this.erPanners.push(pan);
    });

    // Mix
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();

    this.links = {
      wet: { on: false, timer: null, connect: () => this.input.connect(this.preDelayNode), disconnect: () => this.input.disconnect(this.preDelayNode) },
      er: { on: false, timer: null, connect: () => this.erDelays.forEach(d => this.input.connect(d)), disconnect: () => this.erDelays.forEach(d => this.input.disconnect(d)) },
      mod: { on: false, timer: null, connect: () => this.modDepthGain.connect(this.modDelay.delayTime), disconnect: () => this.modDepthGain.disconnect(this.modDelay.delayTime) },
    };
    this.setupChain();
    this.auto.add('mix', new MappedParam(ctx, [{ param: this.wetGain.gain, map: mixWet }, { param: this.dryGain.gain, map: mixDry }], { min: 0, max: 1, value: 0.3, inverse: mixFromWet }));
    this.auto.add('preDelay', new MappedParam(ctx, [{ param: this.preDelayNode.delayTime }], { min: 0, max: 0.45, value: 0.025, affine: true }));
    this.ducker = new EnvelopeDucker(ctx, this.input, this.duckGain.gain);
    this.regenerateImpulse(true);
    this.applyLiveParams();
  }

  /**
   * Reponse impulsionnelle procedurale : bruit stereo decorrele (gauche et
   * droite independants) decoupe en deux bandes qui decroissent a des vitesses
   * differentes. Damping raccourcit la queue des aigus comme dans une vraie
   * piece, au lieu de simplement baisser le volume (ancien comportement, qui
   * donnait une queue de souffle blanc metallique). Le temps « decay » est un
   * vrai RT60 (-60 dB), et la reponse n'est plus tronquee a -26 dB.
   */
  private buildImpulse(): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const p = this.params;
    const captured = p.irUrl ? loadedIrs.get(`${sr}|${p.irUrl}`) : undefined;
    if (captured) return captured;
    const decay = clamp(safeNum(p.decay, 2.5), 0.1, 15);
    const size = clamp(safeNum(p.size, 0.7), 0, 1);
    const damping = clamp(safeNum(p.damping, 0.5), 0, 1);
    const diffusion = clamp(safeNum(p.diffusion, 0.8), 0, 1);
    const shape = MODE_SHAPES[p.mode] || MODE_SHAPES.HALL;

    const length = Math.max(64, Math.floor(sr * Math.min(10, decay * 1.1 + 0.05)));
    const ir = this.ctx.createBuffer(2, length, sr);
    const rtLow = decay * shape.lf;
    const rtHigh = Math.max(0.05, decay * (1 - 0.8 * damping) * shape.hf);
    const kLow = Math.exp(-6.9078 / (rtLow * sr));
    const kHigh = Math.exp(-6.9078 / (rtHigh * sr));
    const split = 1 - Math.exp(-2 * Math.PI * 2500 / sr); // separation grave/aigu (2 poles a 2,5 kHz)
    const attack = Math.max(0.001, shape.attack(size));
    const attackN = Math.floor(attack * sr);
    const earlyN = Math.floor(0.08 * sr);

    // Bruit REPRODUCTIBLE : mêmes réglages = même réponse, à chaque rendu (export,
    // gel, Commit, bus imprimé : deux rendus du même son sont identiques à
    // l'échantillon près). Gauche et droite restent décorrélées (graines différentes).
    const sig = this.irSignature();
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      const random = seededRandom(`${sig}|${sr}|${ch}`);
      let lp1 = 0, lp2 = 0, eL = 1, eH = 1;
      for (let i = 0; i < length; i++) {
        let n = random() + random() - 1;
        // Debut de queue plus « granuleux » quand la diffusion est faible
        if (i < earlyN && diffusion < 1) {
          const sparse = random() < 0.1 ? 1.8 : diffusion;
          const w = i / earlyN;
          n *= sparse + (1 - sparse) * w;
        }
        // Separation a 12 dB/oct : la bande lente ne laisse pas fuir d'aigus,
        // sinon le damping ne s'entendait presque pas.
        lp1 += split * (n - lp1);
        lp2 += split * (lp1 - lp2);
        let v = lp2 * eL + (n - lp2) * eH;
        eL *= kLow;
        eH *= kHigh;
        if (i < attackN) {
          const s = Math.sin(0.5 * Math.PI * (i / attackN));
          v *= s * s;
        }
        data[i] = v;
      }
      if (shape.spring) {
        // Ressort : retours periodiques (~30 ms) caracteristiques du « boing »
        const d = Math.round(sr * (0.029 + 0.004 * ch));
        for (let i = d; i < length; i++) data[i] += 0.55 * data[i - d];
      }
    }
    return ir;
  }

  /** Promesse résolue quand l'empreinte capturée est chargée (export hors ligne). */
  public ready?: Promise<void>;

  /** Charge l'empreinte capturée puis la met en place. */
  private ensureCapturedIr() {
    const url = this.params.irUrl;
    if (!url) return;
    const key = `${this.ctx.sampleRate}|${url}`;
    if (loadedIrs.has(key)) return;
    this.ready = loadCapturedIr(this.ctx, url).then(buf => {
      if (buf) loadedIrs.set(key, buf);
      if (this.params.irUrl === url) { this.irKey = ''; this.regenerateImpulse(true); }
    });
  }

  private irSignature() {
    const p = this.params;
    if (p.irUrl) return `ir|${p.irUrl}|${loadedIrs.has(`${this.ctx.sampleRate}|${p.irUrl}`) ? 1 : 0}`;
    return [
      Math.round(clamp(safeNum(p.decay, 2.5), 0.1, 15) * 50),
      Math.round(clamp(safeNum(p.size, 0.7), 0, 1) * 50),
      Math.round(clamp(safeNum(p.damping, 0.5), 0, 1) * 50),
      Math.round(clamp(safeNum(p.diffusion, 0.8), 0, 1) * 20),
      p.mode
    ].join('|');
  }

  /** Charge une nouvelle reponse si les reglages qui la definissent ont change. */
  private regenerateImpulse(immediate = false) {
    this.ensureCapturedIr();
    const key = this.irSignature();
    if (key === this.irKey) return;
    if (this.irTimer) { clearTimeout(this.irTimer); this.irTimer = null; }
    const now = Date.now();
    // Hors ligne (export) : tout de suite, le rendu demarre juste apres.
    // En direct : au plus toutes les 250 ms pendant qu'on tourne un bouton.
    if (!immediate && !this.isOffline && this.ctx.currentTime > this.createdAt && now - this.lastIrTime < 250) {
      this.irTimer = setTimeout(() => { this.irTimer = null; this.regenerateImpulse(true); }, 250 - (now - this.lastIrTime));
      return;
    }
    this.irKey = key;
    this.lastIrTime = now;
    const ir = this.impulse();
    // Empreinte capturée : son niveau est calibré dans le fichier, le convolveur
    // ne doit pas le renormaliser (il le ramène sinon à un niveau arbitraire).
    const captured = !!this.params.irUrl && loadedIrs.get(`${this.ctx.sampleRate}|${this.params.irUrl}`) === ir;
    const t = this.ctx.currentTime;
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (this.silentSoFar || (!this.convA.buffer && !this.convB.buffer)) {
      // Rien n'a encore sonné (création, début d'export ou de gel) : la réponse
      // remplace celle du convolveur actif, l'autre est vidé. Avant, l'ancienne
      // réponse restait chargée dans le convolveur muet, qui calculait quand
      // même toute sa convolution : le rendu des reverbs coûtait le double.
      const active = this.activeConv === 'A' ? this.convA : this.convB;
      const idle = this.activeConv === 'A' ? this.convB : this.convA;
      active.normalize = !captured;
      active.buffer = ir;
      if (idle.buffer) idle.buffer = null;
      return;
    }
    const nextIsA = this.activeConv === 'B';
    const incoming = nextIsA ? this.convA : this.convB;
    const incomingGain = nextIsA ? this.convGainA : this.convGainB;
    const outgoingGain = nextIsA ? this.convGainB : this.convGainA;
    incoming.normalize = !captured;
    incoming.buffer = ir;
    incomingGain.gain.cancelScheduledValues(t);
    outgoingGain.gain.cancelScheduledValues(t);
    if (t <= this.createdAt) {
      // Rien n'a encore sonne (creation, debut d'export) : bascule immediate
      incomingGain.gain.setValueAtTime(1, t);
      outgoingGain.gain.setValueAtTime(0, t);
    } else {
      incomingGain.gain.setTargetAtTime(1, t, 0.05);
      outgoingGain.gain.setTargetAtTime(0, t, 0.05);
    }
    this.activeConv = nextIsA ? 'A' : 'B';
    // Fondu fini (0,6 s = 12 constantes de temps, -104 dB) : on vide le convolveur
    // sortant, qui sinon convoluerait pour rien jusqu'au prochain réglage.
    const outgoing = nextIsA ? this.convB : this.convA;
    const until = t + 0.6;
    outgoingGain.gain.setValueAtTime(0, until);
    if (!this.isOffline) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        if (this.ctx.currentTime >= until && (this.activeConv === 'A' ? this.convB : this.convA) === outgoing) outgoing.buffer = null;
      }, 700);
    }
  }

  /** Réponse à charger : empreinte capturée, ou réponse calculée (gardée en cache). */
  private impulse(): AudioBuffer {
    const p = this.params;
    if (p.irUrl && loadedIrs.has(`${this.ctx.sampleRate}|${p.irUrl}`)) return this.buildImpulse();
    const key = [this.ctx.sampleRate, safeNum(p.decay, 2.5), safeNum(p.size, 0.7), safeNum(p.damping, 0.5), safeNum(p.diffusion, 0.8), p.mode].join('|');
    const hit = builtIrs.get(key);
    if (hit) { rememberIr(key, hit); return hit; }
    const ir = this.buildImpulse();
    rememberIr(key, ir);
    return ir;
  }

  /** Rien n'a encore sonné : création, ou export / gel avant le début du rendu. */
  private get silentSoFar() { return this.ctx.currentTime <= this.createdAt; }

  private setLink(key: 'wet' | 'er' | 'mod', need: boolean) {
    const l = this.links[key];
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    if (need) { if (!l.on) { l.connect(); l.on = true; } return; }
    if (!l.on) return;
    const cut = () => { try { l.disconnect(); } catch (e) { /* déjà débranché */ } l.on = false; };
    if (this.silentSoFar) cut();
    // En direct : après la fin du fondu (SMOOTH) ; hors ligne pendant le rendu, on garde.
    else if (!this.isOffline) l.timer = setTimeout(() => { l.timer = null; cut(); }, 600);
  }

  private setupChain() {
    // Input metering
    this.input.connect(this.inputAnalyzer);

    // === DRY PATH ===
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // === WET PATH ===
    // Input -> PreDelay -> Convolvers A/B -> Mod -> EQ -> Width -> Duck -> Wet
    this.setLink('wet', true);
    this.preDelayNode.connect(this.convA);
    this.preDelayNode.connect(this.convB);
    this.convA.connect(this.convGainA);
    this.convB.connect(this.convGainB);
    this.convGainA.connect(this.modDelay);
    this.convGainB.connect(this.modDelay);
    this.modDelay.connect(this.bassBoostFilter);
    this.bassBoostFilter.connect(this.lowCutFilter);
    this.lowCutFilter.connect(this.highCutFilter);
    this.highCutFilter.connect(this.widthSplitter);
    this.widthSplitter.connect(this.wLL, 0);
    this.widthSplitter.connect(this.wLR, 0);
    this.widthSplitter.connect(this.wRL, 1);
    this.widthSplitter.connect(this.wRR, 1);
    this.wLL.connect(this.widthMerger, 0, 0);
    this.wRL.connect(this.widthMerger, 0, 0);
    this.wLR.connect(this.widthMerger, 0, 1);
    this.wRR.connect(this.widthMerger, 0, 1);
    this.widthMerger.connect(this.duckGain);
    this.duckGain.connect(this.wetGain);

    // Early reflections : alternees G/D et passees dans le meme EQ que la
    // queue (avant, des echos pleine bande au centre sonnaient « slapback »).
    this.setLink('er', true);
    this.setLink('mod', true);
    for (let i = 0; i < this.erDelays.length; i++) {
      this.erDelays[i].connect(this.erGains[i]);
      this.erGains[i].connect(this.erPanners[i]);
      this.erPanners[i].connect(this.erMix);
    }
    this.erMix.connect(this.bassBoostFilter);

    this.wetGain.connect(this.output);

    // Output metering
    this.output.connect(this.outputAnalyzer);
  }

  /** Reglages appliques en continu (sans regenerer la reponse). */
  private applyLiveParams() {
    const now = this.ctx.currentTime;
    const T = SMOOTH;
    const p = this.params;

    const stKey = `${p.isEnabled ? 1 : 0}`;
    const force = stKey !== this.autoState;
    this.autoState = stKey;
    this.auto.get('preDelay')?.setStatic(clamp(safeNum(p.preDelay, 0.025), 0, 0.45), { force, tau: T });
    this.setP(this.lowCutFilter.frequency, clamp(safeNum(p.lowCut, 160), 20, 2000), T);
    this.setP(this.highCutFilter.frequency, clamp(safeNum(p.highCut, 10000), 500, 20000), T);
    this.setP(this.bassBoostFilter.gain, clamp(safeNum(p.bassBoost, 0), 0, 1) * 12, T);

    // Modulation : ~0 a 3 ms de balayage, quelques cents au plus
    const rate = clamp(safeNum(p.modRate, 0.5), 0.05, 5);
    const depth = clamp(safeNum(p.modDepth, 0.1), 0, 1);
    this.setP(this.modLFO.frequency, rate, 0.05);
    this.setP(this.modDepthGain.gain, depth * 0.0015, 0.05);

    // Largeur : 0 = mono, 1 = stereo, 2 = elargi
    const w = clamp(safeNum(p.width, 1), 0, 2);
    const a = (1 + w) / 2, b = (1 - w) / 2;
    this.setP(this.wLL.gain, a, T);
    this.setP(this.wRR.gain, a, T);
    this.setP(this.wLR.gain, b, T);
    this.setP(this.wRL.gain, b, T);

    this.updateERTimings();
    this.ducker.setAmount(p.isEnabled ? safeNum(p.ducking, 0) : 0, this.silentSoFar);

    const wetOn = !!p.isEnabled && (this.mixAutomated || clamp(safeNum(p.mix, 0.3), 0, 1) > 0);
    this.setLink('wet', wetOn);
    this.setLink('er', wetOn && clamp(safeNum(p.erLevel, 0.3), 0, 1) > 0);
    this.setLink('mod', wetOn && depth > 0);

    if (p.isEnabled) {
      const mix = clamp(safeNum(p.mix, 0.3), 0, 1);
      // Use equal-power crossfade for smoother mix (automatisable : posé seulement s'il a changé)
      this.auto.get('mix')?.setStatic(mix, { force, tau: T, immediate: this.ctx.currentTime <= this.createdAt });
      this.setP(this.erMix.gain, clamp(safeNum(p.erLevel, 0.3), 0, 1), T);
    } else {
      this.auto.get('mix')?.setStatic(0, { force, tau: T });
    }
  }

  /** AudioParam d'un réglage automatisable (R8) : « mix », « preDelay » ; sinon null. */
  public automationParam(key: string): MappedParam | null {
    const mp = this.auto.get(key);
    if (mp && key === 'mix' && !this.mixAutomated) {
      this.mixAutomated = true;
      if (this.params.isEnabled) { this.setLink('wet', true); this.setLink('er', clamp(safeNum(this.params.erLevel, 0.3), 0, 1) > 0); }
    }
    return mp;
  }
  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  public updateParams(p: Partial<ReverbParams>) {
    this.params = { ...this.params, ...p };
    // Avant, la reponse n'etait recalculee que si un seul appel changeait le
    // decay de plus de 0,3 s : en tournant le bouton (petits pas), jamais.
    this.regenerateImpulse();
    this.applyLiveParams();
  }

  private updateERTimings() {
    // Adjust early reflection timings based on mode
    let timeMult = 1.0;

    switch (this.params.mode) {
      case 'ROOM': timeMult = 0.6; break;
      case 'HALL': timeMult = 1.0; break;
      case 'PLATE': timeMult = 0.4; break;
      case 'CATHEDRAL': timeMult = 1.8; break;
      case 'SHIMMER': timeMult = 1.2; break;
      case 'SPRING': timeMult = 0.3; break;
    }

    const baseERTimes = [0.012, 0.022, 0.035, 0.048, 0.065, 0.085];
    const now = this.ctx.currentTime;
    const size = clamp(safeNum(this.params.size, 0.7), 0, 1);
    const width = clamp(safeNum(this.params.width, 1), 0, 2);

    for (let i = 0; i < this.erDelays.length && i < baseERTimes.length; i++) {
      this.setP(this.erDelays[i].delayTime, baseERTimes[i] * timeMult * (0.8 + size * 0.4), SMOOTH);
      const pan = (i % 2 === 0 ? -1 : 1) * clamp((0.35 + 0.1 * i) * width, 0, 1);
      this.setP(this.erPanners[i].pan, pan, SMOOTH);
    }
  }

  public getInputLevel(): number {
    this.inputAnalyzer.getFloatTimeDomainData(this.inputData as any);
    let max = 0;
    for (let i = 0; i < this.inputData.length; i++) {
      const abs = Math.abs(this.inputData[i]);
      if (abs > max) max = abs;
    }
    return max > 0 ? 20 * Math.log10(max) : -100;
  }

  public getOutputLevel(): number {
    this.outputAnalyzer.getFloatTimeDomainData(this.outputData as any);
    let max = 0;
    for (let i = 0; i < this.outputData.length; i++) {
      const abs = Math.abs(this.outputData[i]);
      if (abs > max) max = abs;
    }
    return max > 0 ? 20 * Math.log10(max) : -100;
  }

  public getAudioParam(paramId: string): AudioParam | null {
    switch (paramId) {
      case 'mix': return this.wetGain.gain;
      case 'preDelay': return this.preDelayNode.delayTime;
      case 'lowCut': return this.lowCutFilter.frequency;
      case 'highCut': return this.highCutFilter.frequency;
      case 'bassBoost': return this.bassBoostFilter.gain;
      default: return null;
    }
  }

  public getParams() { return { ...this.params }; }

  /**
   * Properly dispose of all audio nodes and connections
   */
  public dispose() {
    try {
      if (this.irTimer) { clearTimeout(this.irTimer); this.irTimer = null; }
      if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
      for (const l of Object.values(this.links)) if (l.timer) { clearTimeout(l.timer); l.timer = null; }
      try { this.modLFO.stop(); } catch (e) {}
      this.ducker.disconnect();
      const nodes: AudioNode[] = [
        this.input, this.output, this.dryGain, this.wetGain, this.preDelayNode,
        this.convA, this.convB, this.convGainA, this.convGainB, this.modDelay, this.modLFO,
        this.modDepthGain, this.bassBoostFilter, this.lowCutFilter, this.highCutFilter,
        this.widthSplitter, this.widthMerger, this.wLL, this.wLR, this.wRL, this.wRR,
        this.duckGain, this.inputAnalyzer, this.outputAnalyzer, this.erMix,
        ...this.erDelays, ...this.erGains, ...this.erPanners
      ];
      for (const n of nodes) { try { n.disconnect(); } catch (e) {} }

      this.erDelays = [];
      this.erGains = [];
      this.erPanners = [];

    } catch (e) {
      console.error('[ReverbNode] Dispose error:', e);
    }
  }

  // Alias for backward compatibility
  public destroy() {
    this.dispose();
  }
}

export const ProfessionalReverbUI: React.FC<{ 
  node: ReverbNode, 
  initialParams: ReverbParams, 
  onParamsChange?: (p: ReverbParams) => void,
  trackId?: string,
  pluginId?: string
}> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<ReverbParams>(initialParams);
  const [inputLevel, setInputLevel] = useState(-100);
  const [outputLevel, setOutputLevel] = useState(-100);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleParamChange = (key: keyof ReverbParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const loadPreset = (index: number) => {
    const preset = REVERB_PRESETS[index];
    if (preset) {
      const newParams = { ...params, ...preset };
      setParams(newParams);
      node.updateParams(newParams);
      if (onParamsChange) onParamsChange(newParams);
    }
  };

  // Animation loop for metering and visualization
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    let animId = 0;

    const draw = () => {
      // Update meters
      setInputLevel(node.getInputLevel());
      setOutputLevel(node.getOutputLevel());
      
      ctx.clearRect(0, 0, w, h);
      
      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const duration = params.decay;
      const displayTime = Math.min(8, duration * 1.5);
      
      // Early reflections visualization
      ctx.fillStyle = '#818cf8';
      const erTimes = [0.012, 0.019, 0.027, 0.038];
      erTimes.forEach(t => {
        const x = (t / displayTime) * w;
        const erHeight = params.erLevel * (h - 40) * 0.6;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x - 1, h - 20 - erHeight, 3, erHeight);
      });
      ctx.globalAlpha = 1;

      // Decay envelope
      ctx.beginPath();
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#6366f166';
      ctx.moveTo(0, h - 20);
      
      for (let x = 0; x < w; x++) {
        const t = (x / w) * displayTime;
        if (t > duration) break;
        const envelope = Math.pow(1 - t / duration, 4);
        const noise = (Math.random() * 0.1 * envelope);
        const y = (h - 20) - ((envelope + noise) * (h - 40));
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Pre-delay marker
      const preDelayX = (params.preDelay / displayTime) * w;
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(preDelayX, 0);
      ctx.lineTo(preDelayX, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Freeze indicator
      if (params.freeze) {
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 12px monospace';
        ctx.fillText('FREEZE', w - 60, 20);
      }
      
      animId = requestAnimationFrame(draw);
    };
    
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [node, params]);

  // Level meter component
  const LevelMeter: React.FC<{ level: number; label: string }> = ({ level, label }) => {
    const percent = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
    return (
      <div className="flex flex-col items-center">
        <span className="text-[6px] font-black text-slate-600 uppercase mb-1">{paramFr(label)}</span>
        <div className="w-3 h-24 bg-black/60 rounded relative overflow-hidden border border-white/5">
          <div 
            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-indigo-500 via-indigo-400 to-cyan-400 transition-all duration-75"
            style={{ height: `${percent}%` }}
          />
        </div>
        <span className="text-[7px] font-mono text-slate-500 mt-1">{Math.round(level)}</span>
      </div>
    );
  };

  return (
    <div className="w-[680px] bg-nv-bg border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/20">
            <i className="fas fa-mountain-sun text-xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black text-white tracking-tight">Réverbe</h2>
            <p className="text-[11px] text-slate-400 mt-1">Place la voix dans une pièce : de la petite cabine à la grande salle.</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* Freeze toggle */}
          <button
            onClick={() => handleParamChange('freeze', !params.freeze)}
            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all border ${
              params.freeze 
                ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/30' 
                : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'
            }`}
          >
            <i className="fas fa-snowflake mr-2"></i>Figer
          </button>
          
          {/* Power */}
          <button data-plugin-power 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${
              params.isEnabled 
                ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg shadow-indigo-500/30' 
                : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'
            }`}
          >
            <i className="fas fa-power-off text-sm"></i>
          </button>
        </div>
      </div>

      {/* Mode & Preset selectors */}
      <div className="flex items-center justify-between">
        <div className="flex bg-black/40 p-1 rounded-2xl border border-white/5">
          {(['ROOM', 'HALL', 'PLATE', 'CATHEDRAL', 'SHIMMER', 'SPRING'] as ReverbMode[]).map(m => (
            <button 
              key={m}
              onClick={() => handleParamChange('mode', m)}
              className={`px-3 py-1.5 rounded-xl text-[8px] font-black uppercase transition-all ${
                params.mode === m 
                  ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' 
                  : 'text-slate-500 hover:text-white'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        
        <select 
          onChange={(e) => loadPreset(parseInt(e.target.value))}
          className="bg-nv-surface border border-white/10 rounded-xl px-4 py-2 text-[9px] font-black text-white hover:border-indigo-500/50 outline-none cursor-pointer"
          defaultValue="-1"
        >
          <option disabled value="-1">Préréglages</option>
          {REVERB_PRESETS.map((p, i) => (
            <option key={i} value={i}>{p.name.toUpperCase()}</option>
          ))}
        </select>
      </div>

      {/* Visualization + Meters */}
      <div className="flex space-x-4">
        <div className="flex-1 h-36 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden">
          <canvas ref={canvasRef} width={520} height={144} className="w-full h-full" />
          <div className="absolute top-2 left-3 text-[7px] font-black text-slate-600 uppercase tracking-widest">
            Réponse de la salle
          </div>
        </div>
        
        <div className="flex space-x-2 bg-black/40 rounded-[24px] border border-white/5 p-3">
          <LevelMeter level={inputLevel} label="IN" />
          <LevelMeter level={outputLevel} label="OUT" />
        </div>
      </div>

      {/* Main controls row 1 */}
      <div className="grid grid-cols-6 gap-4">
        <ReverbKnob label="Durée" value={params.decay} min={0.1} max={15} suffix="s" color="#6366f1" onChange={v => handleParamChange('decay', v)} />
        <ReverbKnob label="Pre-Delay" value={params.preDelay} min={0} max={0.2} factor={1000} suffix="ms" color="#6366f1" onChange={v => handleParamChange('preDelay', v)} />
        <ReverbKnob label="Taille" value={params.size} min={0} max={1} factor={100} suffix="%" color="#6366f1" onChange={v => handleParamChange('size', v)} />
        <ReverbKnob label="Amorti" value={params.damping} min={0} max={1} factor={100} suffix="%" color="#6366f1" onChange={v => handleParamChange('damping', v)} />
        <ReverbKnob label="Diffusion" value={params.diffusion ?? 0.8} min={0} max={1} factor={100} suffix="%" color="#818cf8" onChange={v => handleParamChange('diffusion', v)} />
        <ReverbKnob label="Mix" value={params.mix} min={0} max={1} factor={100} suffix="%" color="#22d3ee" onChange={v => handleParamChange('mix', v)} />
      </div>

      {/* Advanced controls row 2 */}
      <div className="grid grid-cols-7 gap-3 pt-4 border-t border-white/5">
        <ReverbKnob label="ER Level" value={params.erLevel} min={0} max={1} factor={100} suffix="%" color="#818cf8" onChange={v => handleParamChange('erLevel', v)} />
        <ReverbKnob label="Coupe-bas" value={params.lowCut} min={20} max={1000} log suffix="Hz" color="#f43f5e" onChange={v => handleParamChange('lowCut', v)} />
        <ReverbKnob label="Coupe-haut" value={params.highCut} min={1000} max={20000} log suffix="Hz" color="#f43f5e" onChange={v => handleParamChange('highCut', v)} />
        <ReverbKnob label="Bass Boost" value={params.bassBoost ?? 0} min={0} max={1} factor={100} suffix="%" color="#f97316" onChange={v => handleParamChange('bassBoost', v)} />
        <ReverbKnob label="Largeur" value={params.width} min={0} max={2} factor={100} suffix="%" color="#a855f7" onChange={v => handleParamChange('width', v)} />
        <ReverbKnob label="Mod" value={params.modDepth} min={0} max={1} factor={100} suffix="%" color="#a855f7" onChange={v => handleParamChange('modDepth', v)} />
        <ReverbKnob label="Ducking" value={params.ducking} min={0} max={1} factor={100} suffix="%" color="#10b981" onChange={v => handleParamChange('ducking', v)} />
      </div>
    </div>
  );
};

const ReverbKnob: React.FC<{ 
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix: string;
  color: string;
  log?: boolean;
  factor?: number;
}> = ({ label, value, min, max, onChange, suffix, color, log, factor = 1 }) => {
  const safeVal = Number.isFinite(value) ? value : min;
  const knob = useKnobInteraction(safeVal, onChange, { min, max, log });
  const norm = log 
    ? Math.max(0, Math.min(1, Math.log10(safeVal / min) / Math.log10(max / min)))
    : (safeVal - min) / (max - min);



  const displayValue = log ? Math.round(safeVal) : Math.round(safeVal * factor * 10) / 10;

  return (
    <div className="flex flex-col items-center space-y-2 select-none touch-none">
      <div 
        {...knob.bind}
        className="relative w-11 h-11 rounded-full bg-nv-surface border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-indigo-500/50 transition-all shadow-xl"
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-4 -ml-0.5 -mt-4 origin-bottom rounded-full transition-transform duration-75"
          style={{ 
            backgroundColor: color,
            boxShadow: `0 0 8px ${color}44`,
            transform: `rotate(${(norm * 270) - 135}deg) translateY(2px)` 
          }}
        />
      </div>
      <div className="text-center">
        <span className="block text-[9px] font-bold text-slate-400 mb-1 whitespace-nowrap" title={termHelp(paramFr(label)) || undefined}>{paramFr(label)}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[44px]">
          <span className="text-[8px] font-mono font-bold text-white">{displayValue}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export default ProfessionalReverbUI;
