import React, { useState, useEffect, useRef, useCallback } from 'react';
import { fadeInOnInsert, smoothSet } from './vocalDspUtils';
import { Faceplate, HwSection, HwWindow, Knob, PushButton, SegmentMeter, type KnobProps } from './hw';
import { useHwCanvas, hwCtx } from './hw/screens';
import { cancelUiFrame, requestUiFrame } from '../utils/uiFrame';

/**
 * PROFESSIONAL STEREO IMAGER v3.0
 * ================================
 * Inspired by iZotope Ozone Imager, Waves S1, and brainworx bx_stereomaker
 * 
 * Features:
 * - Multi-band stereo width (Low/Mid/High)
 * - Haas effect for psychoacoustic widening
 * - Phase correlation meter
 * - Mono compatibility check
 * - Balance control
 * - Safe bass mono mode
 */

export type SpreaderMode = 'STEREO' | 'MID_SIDE' | 'HAAS' | 'CORRELATION';

export interface SpreaderParams {
  // Global
  width: number;         // 0 to 2.0 (Overall stereo width)
  balance: number;       // -1 to 1 (L/R balance)
  monoFreq: number;      // 20 to 400 Hz (below this is mono)
  
  // Multi-band widths
  lowWidth: number;      // 0 to 2.0
  midWidth: number;      // 0 to 2.0
  highWidth: number;     // 0 to 2.0
  
  // Crossover frequencies
  lowMidFreq: number;    // 100 to 500 Hz
  midHighFreq: number;   // 2000 to 8000 Hz
  
  // Haas effect
  haasDelay: number;     // 0 to 0.03 (Seconds)
  haasAmount: number;    // 0 to 1
  
  // Processing mode
  mode: SpreaderMode;
  multiBand: boolean;    // Enable multi-band processing
  safeMonoBass: boolean; // Keep bass in mono
  
  isEnabled: boolean;
}

/**
 * Q des passe-bas / passe-haut en dB (spec Web Audio) : −3,01 dB = Butterworth, −3 dB pile à la
 * fréquence réglée. Avant (22/10/2026), 0,707 était lu comme 0,707 dB (Q ≈ 1,08) : +0,7 dB À la
 * coupure des « graves en mono » au lieu de −3 dB, et des bandes qui bossaient.
 */
const BW_Q_DB = -3.0103;

export class StereoSpreaderNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  // Multi-band crossover filters
  // Passe-haut sur le signal Side : au-dessous de cette frequence il ne reste
  // que le Mid, donc un grave strictement mono. C'est ce que promet le bouton
  // « Safe Mono Bass », qui n'etait relie a rien.
  private sideHighpass!: BiquadFilterNode;
  private lowBandLP: BiquadFilterNode;
  private lowBandLP2: BiquadFilterNode;  // 2nd order for steeper rolloff
  private midBandHP: BiquadFilterNode;
  private midBandHP2: BiquadFilterNode;
  private midBandLP: BiquadFilterNode;
  private midBandLP2: BiquadFilterNode;
  private highBandHP: BiquadFilterNode;
  private highBandHP2: BiquadFilterNode;
  // Gains de sortie de chaque bande du signal Side, et voie directe pleine bande.
  private gLow!: GainNode;
  private gMid!: GainNode;
  private gHigh!: GainNode;
  private gDirect!: GainNode;
  /** Passe-tout de compensation (Linkwitz-Riley) : bande grave (à f2), et Milieu (f1 puis f2). */
  private lowAP!: BiquadFilterNode;
  private midAP1!: BiquadFilterNode;
  private midAP2!: BiquadFilterNode;
  /** Milieu direct (pleine bande) ou passé dans les mêmes passe-tout que les Côtés (3 bandes). */
  private gMidDirect!: GainNode;
  private gMidAP!: GainNode;
  
  // Haas delay
  private haasDelayL: DelayNode;
  private haasDelayR: DelayNode;
  
  // Balance
  private balanceGainL: GainNode;
  private balanceGainR: GainNode;
  
  // Analyzers for metering
  public analyzerL: AnalyserNode;
  public analyzerR: AnalyserNode;
  public correlationAnalyzer: AnalyserNode;
  
  // Correlation meter data (calculee a la demande, voir getCorrelation)
  private correlationValue: number = 1.0;
  private corrL: Float32Array | null = null;
  private corrR: Float32Array | null = null;

  private params: SpreaderParams = {
    width: 1.0,
    balance: 0,
    monoFreq: 120,
    lowWidth: 0.8,
    midWidth: 1.2,
    highWidth: 1.5,
    lowMidFreq: 250,
    midHighFreq: 4000,
    haasDelay: 0.015,
    haasAmount: 0.0,
    mode: 'STEREO',
    multiBand: false,
    safeMonoBass: true,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Fondu d'apparition (anti-clic) en direct ; aucun à l'export (le rendu démarre sur le son).
    fadeInOnInsert(this.output.gain, ctx);
    
    // Analyzers
    this.analyzerL = ctx.createAnalyser();
    this.analyzerL.fftSize = 2048;
    this.analyzerR = ctx.createAnalyser();
    this.analyzerR.fftSize = 2048;
    this.correlationAnalyzer = ctx.createAnalyser();
    this.correlationAnalyzer.fftSize = 2048;
    
    // Crossover filters (Linkwitz-Riley style - cascaded for 24dB/oct)
    this.lowBandLP = ctx.createBiquadFilter();
    this.lowBandLP.type = 'lowpass';
    this.lowBandLP.Q.value = BW_Q_DB;
    this.lowBandLP2 = ctx.createBiquadFilter();
    this.lowBandLP2.type = 'lowpass';
    this.lowBandLP2.Q.value = BW_Q_DB;
    
    // Bande medium : passe-haut a lowMidFreq puis passe-bas a midHighFreq.
    // Un simple passe-bande (ce qu'il y avait) ne se recombine pas a plat.
    this.midBandHP = ctx.createBiquadFilter();
    this.midBandHP.type = 'highpass';
    this.midBandHP.Q.value = BW_Q_DB;
    this.midBandHP2 = ctx.createBiquadFilter();
    this.midBandHP2.type = 'highpass';
    this.midBandHP2.Q.value = BW_Q_DB;
    this.midBandLP = ctx.createBiquadFilter();
    this.midBandLP.type = 'lowpass';
    this.midBandLP.Q.value = BW_Q_DB;
    this.midBandLP2 = ctx.createBiquadFilter();
    this.midBandLP2.type = 'lowpass';
    this.midBandLP2.Q.value = BW_Q_DB;
    
    this.highBandHP = ctx.createBiquadFilter();
    this.highBandHP.type = 'highpass';
    this.highBandHP.Q.value = BW_Q_DB;
    this.highBandHP2 = ctx.createBiquadFilter();
    this.highBandHP2.type = 'highpass';
    this.highBandHP2.Q.value = BW_Q_DB;
    
    // Haas effect
    this.haasDelayL = ctx.createDelay(0.1);
    this.haasDelayR = ctx.createDelay(0.1);
    
    // Balance
    this.balanceGainL = ctx.createGain();
    this.balanceGainR = ctx.createGain();
    
    this.setupChain();
    // Plus de setInterval de mesure : il tournait 20 fois par seconde pour
    // chaque instance, y compris celles creees pour l'export hors ligne (jamais
    // arretees : le moteur appelle dispose(), pas destroy()), alors que
    // l'interface calcule sa propre correlation. getCorrelation() mesure
    // desormais a la demande.
  }

  private setupChain() {
    // Simple stereo width implementation using M/S processing
    // M = (L + R) / 2, S = (L - R) / 2
    // Output: L' = M + S*width, R' = M - S*width
    
    const splitter = this.ctx.createChannelSplitter(2);
    const merger = this.ctx.createChannelMerger(2);
    
    // Create M/S encoder
    const midSum = this.ctx.createGain();
    midSum.gain.value = 0.5;
    const sideDiff = this.ctx.createGain();
    sideDiff.gain.value = 0.5;
    const invertR = this.ctx.createGain();
    invertR.gain.value = -1;
    
    // Connect input to splitter
    this.input.connect(splitter);
    
    // Mid = (L + R) / 2
    splitter.connect(midSum, 0);
    splitter.connect(midSum, 1);
    
    // Side = (L - R) / 2
    splitter.connect(sideDiff, 0);
    splitter.connect(invertR, 1);
    invertR.connect(sideDiff);
    
    // Width control on side signal
    const sideGain = this.ctx.createGain();
    // Grave mono : on retire le Side sous monoFreq avant le reglage de largeur.
    this.sideHighpass = this.ctx.createBiquadFilter();
    this.sideHighpass.type = 'highpass';
    this.sideHighpass.Q.value = BW_Q_DB;
    // 0 Hz = passe-plat exact (spec : passe-haut à fréquence nulle). Avant (22/10/2026) : 10 Hz,
    // « transparent » en niveau mais pas en phase : les Côtés tournaient par rapport au Milieu et un
    // son placé à gauche fuyait à droite (−31 dB à 250 Hz, −20 dB à 80 Hz) même réglé à 100 %.
    this.sideHighpass.frequency.value = 0;
    sideDiff.connect(this.sideHighpass);

    // Separateur 3 bandes sur le signal Side. Le Mid reste pleine bande : c'est
    // la largeur stereo qu'on veut doser par bande, pas le contenu mono.
    // Les filtres existaient mais n'etaient ni cables ni regles ; le mode
    // « Multi-Band » de l'interface ne changeait donc rien au son.
    this.gDirect = this.ctx.createGain();
    this.gLow = this.ctx.createGain();
    this.gMid = this.ctx.createGain();
    this.gHigh = this.ctx.createGain();

    // Voie directe (mode pleine bande)
    this.sideHighpass.connect(this.gDirect);
    this.gDirect.connect(sideGain);

    // Séparateur 3 bandes du signal Côtés : Linkwitz-Riley du 4e ordre (deux Butterworth en
    // cascade), compensé par des passe-tout, et le MILIEU passé dans les mêmes passe-tout :
    //
    //   graves  = PB4(f1) · PT(f2)
    //   médiums = PH4(f1) · PB4(f2)
    //   aigus   = PH4(f1) · PH4(f2)
    //   Milieu  = PT(f1) · PT(f2)          (PT = passe-tout du 2e ordre, Q = 0,7071)
    //
    // PB4 + PH4 = PT exactement (transformée bilinéaire comprise) : avec les trois largeurs à
    // 100 %, gauche et droite ressortent en passe-tout pur (amplitude plate, image intacte).
    // À chaque coupure, les deux bandes voisines sont à −6 dB : la coupure affichée est bien
    // celle où elles pèsent autant. Avant (22/10/2026) : arbre soustractif (bande − filtre),
    // plat mais dont les coupures tombaient à 5,3 dB d'écart entre les deux bandes (le
    // « Linkwitz-Riley qui bossait de 7,55 dB » essayé avant lui l'était à cause du Q lu en dB).
    const ap = (f: number) => { const b = this.ctx.createBiquadFilter(); b.type = 'allpass'; b.frequency.value = f; b.Q.value = Math.SQRT1_2; return b; };
    this.lowAP = ap(4000);
    this.midAP1 = ap(250);
    this.midAP2 = ap(4000);

    // Graves
    this.sideHighpass.connect(this.lowBandLP);
    this.lowBandLP.connect(this.lowBandLP2);
    this.lowBandLP2.connect(this.lowAP);
    this.lowAP.connect(this.gLow);
    this.gLow.connect(sideGain);
    // Médiums
    this.sideHighpass.connect(this.midBandHP);
    this.midBandHP.connect(this.midBandHP2);
    this.midBandHP2.connect(this.midBandLP);
    this.midBandLP.connect(this.midBandLP2);
    this.midBandLP2.connect(this.gMid);
    this.gMid.connect(sideGain);
    // Aigus (après le même passe-haut f1)
    this.midBandHP2.connect(this.highBandHP);
    this.highBandHP.connect(this.highBandHP2);
    this.highBandHP2.connect(this.gHigh);
    this.gHigh.connect(sideGain);

    // Haas delay on one channel
    
    // M/S decode to stereo
    // L' = M + S
    // R' = M - S
    const invertSide = this.ctx.createGain();
    invertSide.gain.value = -1;
    sideGain.connect(invertSide);
    
    const leftMix = this.ctx.createGain();
    const rightMix = this.ctx.createGain();
    
    this.gMidDirect = this.ctx.createGain();
    this.gMidAP = this.ctx.createGain();
    this.gMidAP.gain.value = 0;
    midSum.connect(this.gMidDirect);
    midSum.connect(this.midAP1);
    this.midAP1.connect(this.midAP2);
    this.midAP2.connect(this.gMidAP);
    const midOut = this.ctx.createGain();
    this.gMidDirect.connect(midOut);
    this.gMidAP.connect(midOut);

    midOut.connect(leftMix);
    sideGain.connect(leftMix);

    midOut.connect(rightMix);
    invertSide.connect(rightMix);
    
    // Add Haas effect
    leftMix.connect(this.haasDelayL);
    rightMix.connect(this.haasDelayR);
    
    // Balance
    this.haasDelayL.connect(this.balanceGainL);
    this.haasDelayR.connect(this.balanceGainR);
    
    // Merge to output
    this.balanceGainL.connect(merger, 0, 0);
    this.balanceGainR.connect(merger, 0, 1);
    
    merger.connect(this.output);
    
    // Analyzers
    const outSplitter = this.ctx.createChannelSplitter(2);
    this.output.connect(outSplitter);
    outSplitter.connect(this.analyzerL, 0);
    outSplitter.connect(this.analyzerR, 1);
    this.output.connect(this.correlationAnalyzer);
    
    // Store reference to side gain for parameter control
    (this as any)._sideGain = sideGain;
    
    this.applyParams();
  }

  public updateParams(p: Partial<SpreaderParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    
    const width = safe(this.params.width, 1.0);
    const balance = safe(this.params.balance, 0);
    const haasDelay = safe(this.params.haasDelay, 0.015);
    const haasAmount = safe(this.params.haasAmount, 0);

    if (this.params.isEnabled) {
      // Width control
      const sideGain = (this as any)._sideGain as GainNode;
      if (sideGain) {
        smoothSet(sideGain.gain, width, this.ctx, 0.02);
      }
      
      // Haas delay (only on right channel for widening)
      smoothSet(this.haasDelayL.delayTime, 0, this.ctx, 0.02);
      smoothSet(this.haasDelayR.delayTime, haasDelay * haasAmount, this.ctx, 0.02);
      
      // Grave mono. Le bouton et sa frequence existaient dans l'interface mais
      // n'etaient jamais lus : le grave restait stereo quel que soit le reglage.
      smoothSet(this.sideHighpass.frequency, 
        this.params.safeMonoBass ? safe(this.params.monoFreq, 120) : 0, this.ctx, 0.02);

      // Separateur 3 bandes. Hors mode multibande, seule la voie directe passe :
      // on evite ainsi la rotation de phase des filtres quand ils ne servent pas.
      const f1 = safe(this.params.lowMidFreq, 250);
      const f2 = safe(this.params.midHighFreq, 4000);
      for (const f of [this.lowBandLP, this.lowBandLP2, this.midBandHP, this.midBandHP2, this.midAP1]) smoothSet(f.frequency, f1, this.ctx, 0.02);
      for (const f of [this.midBandLP, this.midBandLP2, this.highBandHP, this.highBandHP2, this.lowAP, this.midAP2]) smoothSet(f.frequency, f2, this.ctx, 0.02);

      const multi = !!this.params.multiBand;
      smoothSet(this.gDirect.gain, multi ? 0 : 1, this.ctx, 0.02);
      smoothSet(this.gMidDirect.gain, multi ? 0 : 1, this.ctx, 0.02);
      smoothSet(this.gMidAP.gain, multi ? 1 : 0, this.ctx, 0.02);
      smoothSet(this.gLow.gain, multi ? safe(this.params.lowWidth, 0.8) : 0, this.ctx, 0.02);
      smoothSet(this.gMid.gain, multi ? safe(this.params.midWidth, 1.2) : 0, this.ctx, 0.02);
      smoothSet(this.gHigh.gain, multi ? safe(this.params.highWidth, 1.5) : 0, this.ctx, 0.02);

      // Balance control
      // At balance = 0: both = 1
      // At balance = -1: L = 1, R = 0
      // At balance = +1: L = 0, R = 1
      const leftGain = balance < 0 ? 1 : 1 - balance;
      const rightGain = balance > 0 ? 1 : 1 + balance;
      smoothSet(this.balanceGainL.gain, leftGain, this.ctx, 0.02);
      smoothSet(this.balanceGainR.gain, rightGain, this.ctx, 0.02);
      
    } else {
      // Bypass: width = 1, no Haas, no balance
      const sideGain = (this as any)._sideGain as GainNode;
      if (sideGain) {
        smoothSet(sideGain.gain, 1.0, this.ctx, 0.02);
      }
      smoothSet(this.haasDelayL.delayTime, 0, this.ctx, 0.02);
      smoothSet(this.haasDelayR.delayTime, 0, this.ctx, 0.02);
      smoothSet(this.sideHighpass.frequency, 0, this.ctx, 0.02);
      smoothSet(this.gDirect.gain, 1, this.ctx, 0.02);
      smoothSet(this.gMidDirect.gain, 1, this.ctx, 0.02);
      smoothSet(this.gMidAP.gain, 0, this.ctx, 0.02);
      smoothSet(this.gLow.gain, 0, this.ctx, 0.02);
      smoothSet(this.gMid.gain, 0, this.ctx, 0.02);
      smoothSet(this.gHigh.gain, 0, this.ctx, 0.02);
      smoothSet(this.balanceGainL.gain, 1, this.ctx, 0.02);
      smoothSet(this.balanceGainR.gain, 1, this.ctx, 0.02);
    }
  }

  /** Correlation de phase L/R de la sortie (-1..1), mesuree a l'appel. */
  public getCorrelation(): number {
    const n = this.analyzerL.fftSize;
    if (!this.corrL || this.corrL.length !== n) { this.corrL = new Float32Array(n); this.corrR = new Float32Array(n); }
    const dataL = this.corrL, dataR = this.corrR!;
    this.analyzerL.getFloatTimeDomainData(dataL as any);
    this.analyzerR.getFloatTimeDomainData(dataR as any);
    let sumLR = 0, sumL2 = 0, sumR2 = 0;
    for (let i = 0; i < n; i++) {
      sumLR += dataL[i] * dataR[i];
      sumL2 += dataL[i] * dataL[i];
      sumR2 += dataR[i] * dataR[i];
    }
    const denominator = Math.sqrt(sumL2 * sumR2);
    this.correlationValue = denominator > 0 ? sumLR / denominator : 1.0;
    return this.correlationValue;
  }

  public getStatus() { return { ...this.params }; }
  
  public destroy() {
    this.dispose();
  }

  public dispose() {
    try { this.input.disconnect(); } catch (e) {}
    try { this.output.disconnect(); } catch (e) {}
  }
}

/**
 * Fenêtre « Stéréo », dessinée comme un processeur d'image stéréo de studio (kit
 * plugins/hw) : façade blanc nacré, écran goniomètre (image stéréo), corrélation
 * de phase sur une échelle de LED et un afficheur, gros bouton Largeur, modules
 * « Graves en mono » et « 3 bandes » avec boutons-poussoirs à LED.
 * L'image et la corrélation s'animent hors React (canvas + rAF) : la façade ne se
 * redessine plus à chaque image. Mêmes réglages, mêmes bornes, mêmes paramètres
 * envoyés au moteur qu'avant (preuve : tests/pluginsFin.test.ts) ; l'affichage
 * suit enfin les valeurs par défaut du moteur (« Graves en mono » allumé, largeur 0 %
 * affichée 0 % et non 100 %).
 */
const STEREO_ACCENT = '#0891b2';
/** Valeurs du moteur quand le projet ne précise rien (StereoSpreaderNode). */
export const SPREADER_DEFAULTS: SpreaderParams = {
  width: 1.0, balance: 0, monoFreq: 120, lowWidth: 0.8, midWidth: 1.2, highWidth: 1.5, lowMidFreq: 250, midHighFreq: 4000,
  haasDelay: 0.015, haasAmount: 0.0, mode: 'STEREO', multiBand: false, safeMonoBass: true, isEnabled: true,
};
const ST_HINTS = {
  width: 'Largeur stéréo : 0 % = mono, 100 % = image d’origine, 200 % = très large. Au-delà de 130 %, vérifie la compatibilité mono.',
  balance: 'Balance : déplace l’image vers la gauche ou la droite.',
  haasDelay: 'Décalage Haas : petit retard sur le côté droit (0 à 30 ms) qui élargit sans toucher au volume. Se règle avec la dose.',
  haasAmount: 'Dose Haas : part du décalage appliquée. 0 % = pas d’effet Haas.',
  safeMonoBass: 'Graves en mono : les graves restent au centre (kick, 808, basse), comme en club et sur un téléphone.',
  monoFreq: 'Fréquence sous laquelle le son est remis en mono quand « Graves en mono » est enfoncé.',
  multiBand: '3 bandes : règle la largeur des graves, des médiums et des aigus séparément.',
  lowWidth: 'Largeur des graves (sous la 1re coupure).',
  midWidth: 'Largeur des médiums (entre les deux coupures).',
  highWidth: 'Largeur des aigus (au-dessus de la 2e coupure).',
  lowMidFreq: 'Coupure graves / médiums.',
  midHighFreq: 'Coupure médiums / aigus.',
  corr: 'Compatibilité mono (corrélation de phase) : +1 = mono parfait, 0 = très large, sous 0 = des sons s’annulent quand on écoute en mono (téléphone, club).',
};
const pctW = (v: number) => `${Math.round(v * 100)} %`;
const corrState = (c: number) => (c > 0.8 ? { t: 'Compatible mono', col: '#16a34a' } : c > 0.5 ? { t: 'Bonne image', col: '#16a34a' } : c > 0 ? { t: 'Très large', col: '#d97706' } : { t: 'Problème de phase', col: '#dc2626' });

/** Goniomètre + corrélation : tout est dessiné hors React (canvas, LED, afficheur). */
const StereoScope: React.FC<{ node: StereoSpreaderNode; width: number }> = ({ node, width }) => {
  const { wrapRef, canvasRef, size } = useHwCanvas();
  const corr = useRef(1);
  const lcd = useRef<HTMLSpanElement | null>(null);
  const led = useRef<HTMLSpanElement | null>(null);
  const live = useRef({ size, width });
  live.current = { size, width };
  useEffect(() => {
    let raf = 0, lastTxt = '', lastAt = 0;
    let dL: Float32Array | null = null, dR: Float32Array | null = null;
    const loop = (t: number) => {
      raf = requestUiFrame(loop);
      const aL = node?.analyzerL, aR = node?.analyzerR;
      if (!aL || !aR) return;
      const n = aL.fftSize;
      if (!dL || dL.length !== n) { dL = new Float32Array(n); dR = new Float32Array(n); }
      try { aL.getFloatTimeDomainData(dL as any); aR.getFloatTimeDomainData(dR as any); } catch { return; }
      let sLR = 0, sL = 0, sR = 0;
      for (let i = 0; i < n; i++) { sLR += dL[i] * dR![i]; sL += dL[i] * dL[i]; sR += dR![i] * dR![i]; }
      const den = Math.sqrt(sL * sR);
      const c = den > 0 ? sLR / den : 1;
      corr.current = c;
      const { size: sz, width: wd } = live.current;
      const ctx = hwCtx(canvasRef.current, sz);
      if (ctx) {
        const w = sz.w, h = sz.h, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
        ctx.moveTo(cx - R * 0.7, cy - R * 0.7); ctx.lineTo(cx + R * 0.7, cy + R * 0.7); ctx.moveTo(cx + R * 0.7, cy - R * 0.7); ctx.lineTo(cx - R * 0.7, cy + R * 0.7);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(34,211,238,0.18)';
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = c > 0 ? 'rgba(103,232,249,0.75)' : 'rgba(248,113,113,0.8)';
        ctx.lineWidth = 1.4;
        const k = R * 0.85;
        for (let i = 0; i < n; i += 2) {
          const M = (dL[i] + dR![i]) * 0.707, S = (dL[i] - dR![i]) * 0.707;
          const px = cx + S * k, py = cy - M * k;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        // Repère de largeur réglée (bas de l'écran).
        const wv = Math.max(0, Math.min(2, wd)) * R * 0.5;
        ctx.fillStyle = 'rgba(34,211,238,0.28)';
        ctx.fillRect(cx - wv, h - 12, wv * 2, 5);
      }
      if (t - lastAt > 120) {
        lastAt = t;
        const st = corrState(c);
        const txt = `${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(2).replace('.', ',')} · ${st.t}`;
        if (txt !== lastTxt && lcd.current) { lcd.current.textContent = txt; lastTxt = txt; }
        if (led.current) { led.current.style.setProperty('--led', st.col); led.current.dataset.on = 'true'; }
      }
    };
    raf = requestUiFrame(loop);
    return () => cancelUiFrame(raf);
  }, [node, canvasRef]);
  return (
    <div className="flex flex-col gap-2 w-full min-w-0">
      <div className="hw-screen">
        <div ref={wrapRef} className="hw-screen-glass" style={{ height: 168 }}>
          <span className="hw-screen-label" style={{ top: 6, left: 8 }}>Image stéréo</span>
          <span className="hw-screen-label" style={{ bottom: 6, left: 8 }}>G</span>
          <span className="hw-screen-label" style={{ bottom: 6, right: 8 }}>D</span>
          <canvas ref={canvasRef} className="hw-screen-canvas" aria-label="Image stéréo (goniomètre)" />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2" title={ST_HINTS.corr}>
        <SegmentMeter label="Phase" min={-1} max={1} segments={20} length={150} holdMs={0} read={() => corr.current}
          colorAt={v => (v > 0.5 ? '#22c55e' : v > 0 ? '#f59e0b' : '#ef4444')} hint={ST_HINTS.corr}
          scale={[{ v: -1, label: '−1' }, { v: 0, label: '0' }, { v: 1, label: '+1' }]} />
        <span className="flex items-center gap-2">
          <span ref={led} className="hw-led" data-on="false" style={{ ['--led' as any]: '#16a34a' }} aria-hidden="true" />
          <span className="hw-lcd" data-nova-corr aria-live="off"><span ref={lcd}>+1,00 · Compatible mono</span></span>
        </span>
      </div>
    </div>
  );
};

export const StereoSpreaderUI: React.FC<{ node: StereoSpreaderNode, initialParams: SpreaderParams, onParamsChange?: (p: SpreaderParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<SpreaderParams>(initialParams);
  // Ce que le moteur applique vraiment (valeurs du projet, sinon celles du moteur).
  const view: SpreaderParams = { ...SPREADER_DEFAULTS, ...Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v)))) } as SpreaderParams;

  // Mêmes envois qu'avant : réglages du projet + la valeur changée, au moteur et au projet.
  const updateParam = useCallback((key: keyof SpreaderParams, val: any) => {
    const newParams = { ...params, [key]: val };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  const K = (id: keyof SpreaderParams, label: string, o: Pick<KnobProps, 'min' | 'max'> & Partial<KnobProps>) => (
    <Knob paramId={id} label={label} hint={(ST_HINTS as any)[id]} value={view[id] as number} defaultValue={SPREADER_DEFAULTS[id] as number}
      onChange={v => updateParam(id, v)} cap="graphite" arc={STEREO_ACCENT} {...o} />
  );
  const widthScale = [{ v: 0, label: '0' }, { v: 1, label: '100' }, { v: 2, label: '200' }];
  const hz = (v: number) => (v >= 1000 ? `${numFrSt(v / 1000, 1)} kHz` : `${Math.round(v)} Hz`);

  return (
    <HwWindow type="STEREOSPREADER" width={620} accent={STEREO_ACCENT} accentInk="#ffffff"
      idleHelp={<>Élargit ou resserre l’image stéréo, sans casser le son en mono. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="pearl" model="Stéréo" kicker="Image stéréo · compatibilité mono" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: STEREO_ACCENT }}>
        <div className="flex flex-wrap sm:flex-nowrap items-start gap-4">
          <div className="w-full sm:flex-1 min-w-0"><StereoScope node={node} width={view.width} /></div>
          <div className="flex flex-row sm:flex-col items-center justify-center gap-5 sm:gap-2 w-full sm:w-auto">
            {K('width', 'Largeur', { size: 'XL', min: 0, max: 2, step: 0.01, format: pctW, ariaLabel: 'Largeur stéréo', cap: 'silver', scale: widthScale })}
            {K('balance', 'Balance', { size: 'M', min: -1, max: 1, step: 0.01, bipolar: true,
              format: v => (Math.abs(v) < 0.005 ? 'centre' : `${v < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v) * 100)}`), scale: [{ v: -1, label: 'G' }, { v: 0, label: '0' }, { v: 1, label: 'D' }] })}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <HwSection title="Effet Haas">
            <div className="flex flex-wrap items-start justify-around gap-2">
              {K('haasDelay', 'Décalage', { size: 'M', min: 0, max: 0.03, step: 0.0005, format: v => `${numFrSt(v * 1000, 1)} ms`, ariaLabel: 'Décalage Haas',
                scale: [{ v: 0, label: '0' }, { v: 0.015, label: '15' }, { v: 0.03, label: '30' }] })}
              {K('haasAmount', 'Dose', { size: 'M', min: 0, max: 1, step: 0.01, format: v => `${Math.round(v * 100)} %`, ariaLabel: 'Dose Haas',
                scale: [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }] })}
            </div>
          </HwSection>
          <HwSection title="Graves en mono">
            <div className="flex flex-wrap items-start justify-around gap-2">
              <div className="pt-5" data-nova-param="safeMonoBass">
                <PushButton role="checkbox" active={!!view.safeMonoBass} onClick={() => updateParam('safeMonoBass', !view.safeMonoBass)} text="Mono"
                  led="#16a34a" ariaLabel="Graves en mono" hint={ST_HINTS.safeMonoBass} dark />
              </div>
              {K('monoFreq', 'Sous', { size: 'M', min: 20, max: 400, step: 1, curve: 'log', format: hz, ariaLabel: 'Graves en mono sous', disabled: !view.safeMonoBass,
                scale: [{ v: 20, label: '20' }, { v: 120, label: '120' }, { v: 400, label: '400' }] })}
            </div>
          </HwSection>
        </div>
        <HwSection title="Largeur sur 3 bandes" className="mt-3">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3">
            <div className="pt-5" data-nova-param="multiBand">
              <PushButton role="checkbox" active={!!view.multiBand} onClick={() => updateParam('multiBand', !view.multiBand)} text="3 bandes"
                led={STEREO_ACCENT} ariaLabel="Largeur sur 3 bandes" hint={ST_HINTS.multiBand} dark />
            </div>
            {K('lowWidth', 'Graves', { size: 'M', min: 0, max: 2, step: 0.01, format: pctW, ariaLabel: 'Largeur des graves', disabled: !view.multiBand, scale: widthScale })}
            {K('lowMidFreq', 'Coupure', { size: 'S', min: 100, max: 500, step: 1, curve: 'log', format: hz, ariaLabel: 'Coupure graves / médiums', disabled: !view.multiBand, ticks: 6 })}
            {K('midWidth', 'Médiums', { size: 'M', min: 0, max: 2, step: 0.01, format: pctW, ariaLabel: 'Largeur des médiums', disabled: !view.multiBand, scale: widthScale })}
            {K('midHighFreq', 'Coupure', { size: 'S', min: 2000, max: 8000, step: 10, curve: 'log', format: hz, ariaLabel: 'Coupure médiums / aigus', disabled: !view.multiBand, ticks: 6 })}
            {K('highWidth', 'Aigus', { size: 'M', min: 0, max: 2, step: 0.01, format: pctW, ariaLabel: 'Largeur des aigus', disabled: !view.multiBand, scale: widthScale })}
          </div>
        </HwSection>
      </Faceplate>
    </HwWindow>
  );
};

const numFrSt = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

export default StereoSpreaderUI;
