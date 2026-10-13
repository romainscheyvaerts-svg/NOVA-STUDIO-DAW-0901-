import React, { useState, useEffect, useRef } from 'react';
import { termHelp } from '../utils/pluginUi';
import { Faceplate, HwPresets, HwSection, HwWindow, Knob, PushButton, ToggleSwitch } from './hw';
import { retireWorkletNode } from '../engine/workletGuard';

/**
 * DENOISER PRO - Professional Noise Gate/Expander
 * Inspired by Ableton Gate, UAD Precision, Softube
 * Detection et gain dans un AudioWorklet (precis a l'echantillon, identique a l'export)
 */

export interface DenoiserParams {
  threshold: number;    // -60 to 0 dB
  range: number;        // -80 to 0 dB (how much reduction when closed)
  attack: number;       // 0.0001 to 0.1 s (0.1ms to 100ms)
  hold: number;         // 0 to 0.5 s
  release: number;      // 0.01 to 2.0 s
  scFreq: number;       // Sidechain filter freq 20-20000 Hz
  flip: boolean;        // Flip/Duck mode
  isEnabled: boolean;
  /**
   * Seuil automatique : le plugin apprend le plancher de bruit de la prise
   * (minimum du niveau sur ~5 s glissantes) et place le seuil 9 dB au-dessus.
   * threshold devient alors un MINIMUM (le seuil ne descend jamais dessous),
   * plafonne a -30 dB pour ne jamais fermer sur la voix. Optionnel.
   */
  autoThreshold?: boolean;
  /** Coupe-bas 12 dB/oct sur le son (grondements, manipulations), en Hz ; 0 = coupe. Optionnel. */
  lowCut?: number;
  /** Detection automatique d'une ronflette 50/60 Hz et coupe-bandes etroits. Optionnel. */
  humFilter?: boolean;
}

// Les presets manuels remettent les options adaptatives a zero (sinon elles
// restaient actives apres avoir choisi « Drum Gate », par exemple).
const MANUAL = { autoThreshold: false, lowCut: 0, humFilter: false };
const DENOISER_PRESETS = [
  // Reglage des styles voix : seuil appris sur le bruit de la piece, coupe-bas, anti-ronflette.
  { name: "Voix auto (pièce bruyante)", threshold: -60, range: -30, attack: 0.002, hold: 0.08, release: 0.08, scFreq: 250, flip: false, autoThreshold: true, lowCut: 80, humFilter: true },
  { name: "Anti-bruit doux", threshold: -45, range: -20, attack: 0.005, hold: 0.05, release: 0.15, scFreq: 1000, flip: false, ...MANUAL },
  { name: "Porte voix (net)", threshold: -35, range: -80, attack: 0.001, hold: 0.02, release: 0.1, scFreq: 800, flip: false, ...MANUAL },
  { name: "Porte batterie", threshold: -25, range: -80, attack: 0.0001, hold: 0.01, release: 0.05, scFreq: 100, flip: false, ...MANUAL },
  { name: "Radio / podcast", threshold: -40, range: -30, attack: 0.01, hold: 0.1, release: 0.3, scFreq: 2000, flip: false, ...MANUAL },
  { name: "Baisse auto (ducking)", threshold: -30, range: -12, attack: 0.005, hold: 0.05, release: 0.2, scFreq: 1000, flip: true, ...MANUAL },
];

// Porte de bruit echantillon par echantillon dans un AudioWorklet (v2 : seuil
// automatique sur plancher de bruit appris, coupe-bas, anti-ronflette 50/60 Hz ;
// nom de processeur change pour ne pas heurter un module v1 deja charge).
// L'ancienne version pilotait le gain depuis un setInterval (60 Hz) qui lisait
// un AnalyserNode : reaction a ~16 ms pres, coupures en debut de mot, et a
// l'export (rendu hors ligne plus rapide que le temps reel) le gain changeait
// a des instants sans rapport avec la musique.
const GATE_WORKLET_CODE = `
class VocalGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -100, maxValue: 0 },
      { name: 'range', defaultValue: -40, minValue: -100, maxValue: 0 },
      { name: 'attack', defaultValue: 0.005, minValue: 0.00005, maxValue: 1 },
      { name: 'hold', defaultValue: 0.05, minValue: 0, maxValue: 2 },
      { name: 'release', defaultValue: 0.15, minValue: 0.005, maxValue: 5 },
      { name: 'scFreq', defaultValue: 1000, minValue: 20, maxValue: 20000 },
      { name: 'flip', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'auto', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'lowCut', defaultValue: 0, minValue: 0, maxValue: 400 },
      { name: 'hum', defaultValue: 0, minValue: 0, maxValue: 1 },
      // Départ de lecture : compteur programmé au bloc du départ, tout repart à neuf (comme l'export).
      { name: 'resetGen', defaultValue: 0, minValue: 0, maxValue: 1e9, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.gen = 0;
    this.initState();
  }
  // État de départ = état de repos (porte FERMÉE, comme après un silence) : un export qui démarre
  // sur du son s'ouvre avec la même attaque qu'en lecture (avant : ouverte d'emblée à l'export).
  initState() {
    this.ms = 0; this.gain = -1; this.open = false; this.holdLeft = 0; this.blocks = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.lastFc = -1; this.msg = 0; this.levelDb = -100;
    // Plancher de bruit appris (statistiques de minimum) : niveau lisse 20 ms,
    // minimum par tranche de 0,4 s, minimum glissant sur 12 tranches (~5 s).
    this.ms20 = 0; this.subLen = Math.round(0.4 * sampleRate / 128); this.subCount = 0;
    this.subMin = 1e9; this.ring = new Float32Array(12).fill(1e9); this.ringPos = 0;
    this.learned = 0; this.floorDb = -100; this.thrEff = -40;
    // Coupe-bas (grondements, manipulation du telephone), par canal
    this.lcFc = -1; this.lc = [new Float64Array(4), new Float64Array(4)];
    // Ronflette secteur : detection 50/60 Hz pendant les silences, puis
    // coupe-bandes etroits sur le fondamental et 3 harmoniques.
    this.gN = Math.round(0.25 * sampleRate); this.gCount = 0;
    this.gFreqs = [];
    for (const F of [50, 60]) for (let h = 1; h <= 3; h++) for (const d of [0, -8, 8]) this.gFreqs.push(h * F + d);
    this.gC = this.gFreqs.map(f => 2 * Math.cos(2 * Math.PI * f / sampleRate));
    this.gS1 = new Float64Array(this.gFreqs.length); this.gS2 = new Float64Array(this.gFreqs.length);
    this.humVotes = [0, 0]; this.humFreq = 0; this.humMix = 0; this.notch = null;
  }
  setHighpass(fc) {
    const w0 = 2 * Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(w0) / (2 * 0.7071);
    const c = Math.cos(w0), a0 = 1 + alpha;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - alpha) / a0;
    this.lastFc = fc;
  }
  setLowCut(fc) {
    const w0 = 2 * Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(w0) / (2 * 0.7071);
    const c = Math.cos(w0), a0 = 1 + alpha;
    this.lk = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0];
    this.lcFc = fc;
  }
  setNotches(F) {
    this.notch = [];
    for (let h = 1; h <= 4; h++) {
      const f = h * F;
      if (f > sampleRate * 0.45) break;
      const w0 = 2 * Math.PI * f / sampleRate, alpha = Math.sin(w0) / (2 * 12), c = Math.cos(w0), a0 = 1 + alpha;
      this.notch.push({ k: [1 / a0, -2 * c / a0, 1 / a0, -2 * c / a0, (1 - alpha) / a0], s: [new Float64Array(4), new Float64Array(4)] });
    }
  }
  // Fin d'une fenetre de 0,25 s de silence : y a-t-il une raie a 50 ou 60 Hz ?
  checkHum() {
    const n = this.gN;
    const pow = this.gFreqs.map((f, i) => {
      const s1 = this.gS1[i], s2 = this.gS2[i], c = this.gC[i];
      return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
    });
    for (let m = 0; m < 2; m++) {
      let tone = 0, side = 0;
      for (let h = 0; h < 3; h++) { const b = (m * 3 + h) * 3; tone += pow[b]; side += 0.5 * (pow[b + 1] + pow[b + 2]); }
      // Raie nette (+12 dB sur ses voisines) et audible (> -80 dBFS)
      if (tone > 16 * side && tone > 1e-8) this.humVotes[m]++; else this.humVotes[m] = Math.max(0, this.humVotes[m] - 1);
    }
    if (!this.humFreq) {
      if (this.humVotes[0] >= 2 && this.humVotes[0] >= this.humVotes[1]) { this.humFreq = 50; this.setNotches(50); }
      else if (this.humVotes[1] >= 2) { this.humFreq = 60; this.setNotches(60); }
    }
    this.gS1.fill(0); this.gS2.fill(0); this.gCount = 0;
  }
  process(inputs, outputs, p) {
    if (p.resetGen && p.resetGen[0] !== this.gen) { this.gen = p.resetGen[0]; this.initState(); }
    const input = inputs[0], output = outputs[0];
    if (!output || !output[0]) return true;
    const n = output[0].length;
    const hasIn = !!(input && input.length > 0 && input[0]);
    if (p.bypass[0] > 0.5) {
      for (let c = 0; c < output.length; c++) {
        const src = hasIn ? (input[c] || input[0]) : null;
        if (src) output[c].set(src); else output[c].fill(0);
      }
      this.gain = 1; this.open = true;
      return true;
    }
    const fc = p.scFreq[0];
    if (fc !== this.lastFc) this.setHighpass(fc);
    const lowCut = p.lowCut[0];
    const useLc = lowCut >= 20;
    if (useLc && lowCut !== this.lcFc) this.setLowCut(lowCut);
    const auto = p.auto[0] > 0.5;
    const humOn = p.hum[0] > 0.5;
    // Seuil automatique : plancher appris + 9 dB, jamais sous le seuil regle
    // (qui devient un minimum) ni au-dessus de -30 dB (la voix passe toujours).
    let thr = p.threshold[0];
    if (auto && this.learned >= 2) thr = Math.max(thr, Math.min(this.floorDb + 9, -30));
    this.thrEff = thr;
    const closeThr = thr - 4;  // hysteresis : pas de claquements autour du seuil
    const rangeLin = Math.pow(10, p.range[0] / 20);
    if (this.gain < 0) this.gain = rangeLin;
    const aAtt = 1 - Math.exp(-1 / (Math.max(0.00005, p.attack[0]) * sampleRate));
    const aRel = 1 - Math.exp(-1 / (Math.max(0.005, p.release[0]) * sampleRate));
    // Detection 3 ms ; 10 ms en seuil automatique, ou le seuil est proche du
    // bruit : un bruit grave detecte sur 3 ms fluctue de +-10 dB et rouvrait la
    // porte. Une attaque franche franchit le seuil en moins d'1 ms quand meme.
    const aDet = 1 - Math.exp(-1 / ((auto ? 0.01 : 0.003) * sampleRate));
    const a20 = 1 - Math.exp(-1 / (0.02 * sampleRate));
    const holdN = Math.round(p.hold[0] * sampleRate);
    const flip = p.flip[0] > 0.5;
    const chans = hasIn ? input.length : 0;
    const humStep = 1 / (0.1 * sampleRate);
    const nG = this.gFreqs.length;
    let g = this.gain, ms = this.ms, ms20 = this.ms20, hm = this.humMix;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < chans; c++) x += input[c][i];
      if (chans > 1) x /= chans;
      // Detection sur la voix filtree (passe-haut : ignore les grondements)
      let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      if (y < 1e-15 && y > -1e-15) y = 0;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      ms += (y * y - ms) * aDet;
      if (ms < 1e-20) ms = 0;
      ms20 += (y * y - ms20) * a20;
      const db = ms > 0 ? 10 * Math.log10(ms) : -200;
      const above = this.open ? db > closeThr : db > thr;
      const wantOpen = flip ? !above : above;
      if (wantOpen) { this.open = true; this.holdLeft = holdN; }
      else if (this.holdLeft > 0) this.holdLeft--;
      else this.open = false;
      const target = this.open ? 1 : rangeLin;
      g += (target - g) * (target > g ? aAtt : aRel);
      // Analyse de ronflette sur les passages fermes uniquement (bruit seul)
      if (humOn && !this.humFreq) {
        if (!this.open && !flip) {
          for (let k = 0; k < nG; k++) { const s0 = x + this.gC[k] * this.gS1[k] - this.gS2[k]; this.gS2[k] = this.gS1[k]; this.gS1[k] = s0; }
          if (++this.gCount >= this.gN) this.checkHum();
        } else if (this.gCount > 0) { this.gS1.fill(0); this.gS2.fill(0); this.gCount = 0; }
      }
      const hTarget = humOn && this.humFreq ? 1 : 0;
      if (hm < hTarget) hm = Math.min(hTarget, hm + humStep); else if (hm > hTarget) hm = Math.max(hTarget, hm - humStep);
      for (let c = 0; c < output.length; c++) {
        const src = hasIn ? (input[c] || input[0]) : null;
        let v = src ? src[i] : 0;
        if (useLc) {
          const s = this.lc[c & 1], k = this.lk;
          let o = k[0] * v + k[1] * s[0] + k[2] * s[1] - k[3] * s[2] - k[4] * s[3];
          if (o < 1e-15 && o > -1e-15) o = 0;
          s[1] = s[0]; s[0] = v; s[3] = s[2]; s[2] = o; v = o;
        }
        if (this.notch && hm > 0) {
          let w = v;
          for (let j = 0; j < this.notch.length; j++) {
            const nt = this.notch[j], s = nt.s[c & 1], k = nt.k;
            let o = k[0] * w + k[1] * s[0] + k[2] * s[1] - k[3] * s[2] - k[4] * s[3];
            if (o < 1e-15 && o > -1e-15) o = 0;
            s[1] = s[0]; s[0] = w; s[3] = s[2]; s[2] = o; w = o;
          }
          v = v + (w - v) * hm;
        }
        output[c][i] = v * g;
      }
    }
    this.gain = g; this.ms = ms; this.ms20 = ms20; this.humMix = hm;
    // Plancher de bruit : minimum du niveau lisse, par tranches
    // (premiers 100 ms ignores : le lissage part de zero ; le silence numerique
    // pur ne compte pas comme bruit)
    const lvl = ms20 > 1e-11 ? 10 * Math.log10(ms20) : -200;
    this.blocks = (this.blocks || 0) + 1;
    if (lvl > -110 && this.blocks * 128 > 0.1 * sampleRate && lvl < this.subMin) this.subMin = lvl;
    if (++this.subCount >= this.subLen) {
      const got = this.subMin < 1e8;
      this.ring[this.ringPos] = this.subMin; this.ringPos = (this.ringPos + 1) % this.ring.length;
      this.subMin = 1e9; this.subCount = 0;
      if (got && this.learned < 1e6) this.learned++;
      let mn = 1e9; for (let k = 0; k < this.ring.length; k++) if (this.ring[k] < mn) mn = this.ring[k];
      // Le minimum sous-estime la moyenne du bruit : +3 dB de correction.
      const est = mn + 3;
      if (mn > 1e8) { /* rien appris (silence numerique) */ }
      else if (this.learned <= 2) this.floorDb = est;
      else this.floorDb += (est - this.floorDb) * (est < this.floorDb ? 0.5 : 0.35);
    }
    this.levelDb = ms > 0 ? 10 * Math.log10(ms) : -100;
    if (++this.msg >= 8) {
      this.msg = 0;
      this.port.postMessage({ gain: g, levelDb: this.levelDb, open: this.open, floorDb: this.floorDb, thresholdDb: this.thrEff, humHz: this.humFreq });
    }
    return true;
  }
}
try { registerProcessor('vocal-gate-processor-v3', VocalGateProcessor); } catch (e) {}
`;

const gateModuleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
function loadGateModule(ctx: BaseAudioContext): Promise<void> {
  let p = gateModuleLoads.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([GATE_WORKLET_CODE], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    gateModuleLoads.set(ctx, p);
    p.catch(() => gateModuleLoads.delete(ctx));
  }
  return p;
}

export class DenoiserNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private worklet: AudioWorkletNode | null = null;
  private disposed = false;

  private params: DenoiserParams = {
    threshold: -40,
    range: -40,
    attack: 0.005,
    hold: 0.05,
    release: 0.15,
    scFreq: 1000,
    flip: false,
    isEnabled: true,
    autoThreshold: false,
    lowCut: 0,
    humFilter: false
  };

  private noiseFloorDb: number = -100;
  private thresholdDb: number = -40;
  private humHz: number = 0;

  private currentGain: number = 1.0;
  private inputLevel: number = -100;
  private isGateOpen: boolean = true;

  /**
   * Le worklet se charge de maniere asynchrone ; le rendu hors ligne attend
   * cette promesse. En attendant, le son passe tel quel (pas de silence).
   */
  public readonly ready: Promise<void>;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
    this.ready = this.initWorklet();
  }

  private async initWorklet() {
    try {
      await loadGateModule(this.ctx);
      if (this.disposed) return;
      this.worklet = new AudioWorkletNode(this.ctx, 'vocal-gate-processor-v3', {
        numberOfInputs: 1,
        numberOfOutputs: 1
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.gain)) this.currentGain = d.gain;
        if (Number.isFinite(d.levelDb)) this.inputLevel = d.levelDb;
        this.isGateOpen = !!d.open;
        if (Number.isFinite(d.floorDb)) this.noiseFloorDb = d.floorDb;
        if (Number.isFinite(d.thresholdDb)) this.thresholdDb = d.thresholdDb;
        if (Number.isFinite(d.humHz)) this.humHz = d.humHz;
      };
      this.applyParams();
      this.input.disconnect();
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
    } catch (e) {
      console.error('[Denoiser] Worklet Load Error:', e);
      // Le passage direct reste en place : la voix n'est jamais coupee.
    }
  }

  private resetCount = 0;
  /** Départ de la lecture à `at` (début d'un bloc de rendu) : porte, filtres et apprentissage repartent à neuf. */
  public resetAt(at: number) {
    const ap = this.worklet?.parameters.get('resetGen');
    if (!ap) return;
    try { ap.setValueAtTime(++this.resetCount, Math.max(this.ctx.currentTime, at - 0.5 / this.ctx.sampleRate)); } catch { /* */ }
  }

  private applyParams() {
    if (!this.worklet) return;
    const prm = this.worklet.parameters;
    const now = this.ctx.currentTime;
    const p = this.params;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    prm.get('threshold')?.setValueAtTime(Math.max(-100, Math.min(0, safe(p.threshold, -40))), now);
    prm.get('range')?.setValueAtTime(Math.max(-100, Math.min(0, safe(p.range, -40))), now);
    prm.get('attack')?.setValueAtTime(Math.max(0.00005, Math.min(1, safe(p.attack, 0.005))), now);
    prm.get('hold')?.setValueAtTime(Math.max(0, Math.min(2, safe(p.hold, 0.05))), now);
    prm.get('release')?.setValueAtTime(Math.max(0.005, Math.min(5, safe(p.release, 0.15))), now);
    prm.get('scFreq')?.setValueAtTime(Math.max(20, Math.min(20000, safe(p.scFreq, 1000))), now);
    prm.get('flip')?.setValueAtTime(p.flip ? 1 : 0, now);
    prm.get('bypass')?.setValueAtTime(p.isEnabled === false ? 1 : 0, now);
    prm.get('auto')?.setValueAtTime(p.autoThreshold ? 1 : 0, now);
    prm.get('lowCut')?.setValueAtTime(Math.max(0, Math.min(400, safe(p.lowCut as number, 0))), now);
    prm.get('hum')?.setValueAtTime(p.humFilter ? 1 : 0, now);
  }

  public updateParams(p: Partial<DenoiserParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  public getStatus() {
    const grDb = 20 * Math.log10(Math.max(this.currentGain, 0.0001));
    return {
      reduction: this.currentGain,
      reductionDb: grDb,
      inputLevel: this.inputLevel,
      isOpen: this.isGateOpen,
      isActive: this.currentGain < 0.95,
      /** Plancher de bruit appris (dB, detection) et seuil effectif. */
      noiseFloorDb: this.noiseFloorDb,
      thresholdDb: this.thresholdDb,
      /** 50 ou 60 si une ronflette a ete detectee et filtree, sinon 0. */
      humHz: this.humHz
    };
  }

  public getParams() { return { ...this.params }; }

  public dispose() {
    this.disposed = true;
    try { this.input.disconnect(); } catch (e) {}
    if (this.worklet) {
      // Mis à la retraite : process() renverra false (sinon il restait calculé jusqu'à la fermeture du contexte).
      retireWorkletNode(this.worklet);
      this.worklet = null;
    }
  }
}

/// ============== UI COMPONENT ==============

interface VocalDenoiserUIProps {
  node: DenoiserNode;
  initialParams: DenoiserParams;
  onParamsChange?: (p: DenoiserParams) => void;
}

const DENOISER_DEFAULTS: DenoiserParams = { threshold: -40, range: -40, attack: 0.005, hold: 0.05, release: 0.15, scFreq: 1000, flip: false, isEnabled: true, autoThreshold: false, lowCut: 0, humFilter: false };
const DN_ACCENT = '#34d399';
/** Préréglages dans la barre d'outils (format du kit : id, nom, réglages). */
const DN_PRESETS = DENOISER_PRESETS.map((pr, i) => { const { name, ...params } = pr; return { id: `dn${i}`, name, params }; });
const msFr = (s: number) => { const ms = s * 1000; return `${ms < 10 ? ms.toFixed(1).replace('.', ',') : Math.round(ms)} ms`; };
const hzFr = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',')} kHz` : `${Math.round(v)} Hz`);

export const VocalDenoiserUI: React.FC<VocalDenoiserUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<DenoiserParams>(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ledRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const view: DenoiserParams = { ...DENOISER_DEFAULTS, ...Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))) } as DenoiserParams;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Mesures : canvas, voyant et état écrits directement à chaque image (la façade ne se redessine pas).
  useEffect(() => {
    let animFrame = 0;
    let lastOpen: boolean | null = null;
    const update = () => {
      const status = node.getStatus();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        const { threshold, range } = viewRef.current;
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 6; i++) { const y = (i / 6) * h; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        const threshY = h - ((threshold + 60) / 60) * h;
        ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(0, threshY); ctx.lineTo(w, threshY); ctx.stroke(); ctx.setLineDash([]);
        const rangeY = h - ((range + 60) / 60) * h;
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
        ctx.fillRect(0, threshY, w, rangeY - threshY);
        const levelY = Math.max(0, Math.min(h, h - ((status.inputLevel + 60) / 60) * h));
        ctx.fillStyle = status.isOpen ? '#10b981' : '#ef4444';
        ctx.fillRect(10, levelY, 20, h - levelY);
        const grHeight = (1 - status.reduction) * h;
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(w - 30, 0, 20, grHeight);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '10px monospace';
        ctx.fillText('ENTRÉE', 36, h - 6);
        ctx.fillText('RÉDUCTION', w - 96, h - 6);
        ctx.fillText('SEUIL', 40, Math.max(12, threshY - 4));
        ctx.fillStyle = '#fff';
        ctx.fillText(`${Math.round(status.inputLevel)} dB`, 36, Math.max(24, levelY - 5));
        if (status.reductionDb < -0.5) ctx.fillText(`${status.reductionDb.toFixed(1).replace('.', ',')} dB`, w - 96, Math.min(h - 20, grHeight + 14));
      }
      if (status.isOpen !== lastOpen) {
        lastOpen = status.isOpen;
        if (ledRef.current) ledRef.current.dataset.on = status.isOpen ? 'true' : 'false';
        if (stateRef.current) stateRef.current.textContent = status.isOpen ? 'Ouverte : ta voix passe' : 'Fermée : le bruit est coupé';
      }
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node]);

  const handleParamChange = (key: keyof DenoiserParams, value: number | boolean) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const loadPreset = (preset: Record<string, any>) => {
    const newParams = { ...params, ...preset, isEnabled: params.isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <HwWindow type="DENOISER" width={620} accent={DN_ACCENT} accentInk="#03170e"
      toolbar={<HwPresets presets={DN_PRESETS} current={view as any} onApply={pr => loadPreset(pr.params)} />}
      idleHelp={<>Coupe le souffle et les bruits de la pièce entre tes phrases. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="hammer" model="Anti-bruit" kicker="Porte de bruit vocale · seuil appris" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: DN_ACCENT }}>
        <div className="flex items-center gap-2.5 mb-2" aria-live="polite" title="Ouverte : ta voix passe. Fermée : le bruit est coupé.">
          <span ref={ledRef} className="hw-led hw-led-lg" data-on="true" style={{ ['--led' as any]: DN_ACCENT }} aria-hidden="true" />
          <span className="hw-lcd"><span ref={stateRef}>Ouverte : ta voix passe</span></span>
        </div>
        <div className="hw-screen">
          <div className="hw-screen-glass" style={{ height: 130 }}>
            <canvas ref={canvasRef} width={520} height={130} className="w-full h-full block" aria-label="Niveau d'entrée, seuil et réduction" />
          </div>
        </div>
        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3 mt-3">
          <Knob paramId="threshold" label="Seuil" size="L" cap="black" min={-60} max={0} step={0.5} value={view.threshold} defaultValue={-40}
            onChange={v => handleParamChange('threshold', v)} format={v => `${v.toFixed(1).replace('.', ',')} dB`}
            hint={`${termHelp('Seuil') || 'Sous ce niveau, le son est coupé.'}${view.autoThreshold ? ' Seuil auto actif : cette valeur devient un minimum.' : ''}`}
            scale={[{ v: -60, label: '-60' }, { v: -40, label: '-40' }, { v: -20, label: '-20' }, { v: 0, label: '0' }]} />
          <Knob paramId="range" label="Plage" size="M" cap="black" min={-80} max={0} step={0.5} value={view.range} defaultValue={-40}
            onChange={v => handleParamChange('range', v)} format={v => `${v.toFixed(1).replace('.', ',')} dB`} hint={termHelp('Plage') || 'De combien le son baisse quand la porte est fermée.'}
            scale={[{ v: -80, label: '-80' }, { v: -40, label: '-40' }, { v: 0, label: '0' }]} />
          <Knob paramId="scFreq" label="Détection" ariaLabel="Filtre de détection" size="M" cap="black" curve="log" min={20} max={20000} step={1} value={view.scFreq} defaultValue={1000}
            onChange={v => handleParamChange('scFreq', v)} format={hzFr} hint={termHelp('Filtre de détection') || 'Fréquence que la porte écoute pour décider de s’ouvrir.'}
            scale={[{ v: 20, label: '20' }, { v: 1000, label: '1k' }, { v: 20000, label: '20k' }]} />
        </div>
        <HwSection title="Temps" className="mt-3">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
            <Knob paramId="attack" label="Attaque" size="M" cap="black" curve="log" min={0.0001} max={0.1} step={0.0001} value={view.attack} defaultValue={0.005}
              onChange={v => handleParamChange('attack', v)} format={msFr} hint={termHelp('Attaque') || 'Vitesse d’ouverture.'} ticks={11} />
            <Knob paramId="hold" label="Maintien" size="M" cap="black" min={0} max={0.5} step={0.001} value={view.hold} defaultValue={0.05}
              onChange={v => handleParamChange('hold', v)} format={msFr} hint={termHelp('Maintien') || 'Temps minimum d’ouverture.'} ticks={11} />
            <Knob paramId="release" label="Relâche" size="M" cap="black" curve="log" min={0.01} max={2} step={0.001} value={view.release} defaultValue={0.15}
              onChange={v => handleParamChange('release', v)} format={msFr} hint={termHelp('Relâche') || 'Vitesse de fermeture.'} ticks={11} />
          </div>
        </HwSection>
        <div className="hw-rule" />
        <div className="flex flex-wrap items-center justify-around gap-x-3 gap-y-3">
          <ToggleSwitch label="Mode" paramId="flip" value={view.flip ? 1 : 0} onChange={v => handleParamChange('flip', v === 1)}
            hint="Porte : coupe le son sous le seuil (entre les phrases). Baisse : baisse le son quand il dépasse le seuil (ducking)."
            options={[{ v: 0, label: 'Porte' }, { v: 1, label: 'Baisse' }]} />
          <PushButton active={!!view.autoThreshold} onClick={() => handleParamChange('autoThreshold', !view.autoThreshold)} text="Seuil auto" led={DN_ACCENT} dark
            hint="Apprend le bruit de la pièce et place le seuil 9 dB au-dessus (le réglage « Seuil » devient un minimum)." valueText={view.autoThreshold ? 'actif' : 'coupé'} />
          <PushButton active={!!view.humFilter} onClick={() => handleParamChange('humFilter', !view.humFilter)} text="Anti-ronflette" led={DN_ACCENT} dark
            hint="Repère une ronflette 50 / 60 Hz (câble, ampli) et la retire avec des filtres très étroits." valueText={view.humFilter ? 'actif' : 'coupé'} />
          <PushButton active={(view.lowCut || 0) > 0} onClick={() => handleParamChange('lowCut', (view.lowCut || 0) > 0 ? 0 : 80)} text={(view.lowCut || 0) > 0 ? `Coupe-bas ${Math.round(view.lowCut || 0)} Hz` : 'Coupe-bas 80 Hz'}
            led={DN_ACCENT} dark hint="Retire les grondements sous la voix (pieds du micro, manipulations), 12 dB/oct." valueText={(view.lowCut || 0) > 0 ? 'actif' : 'coupé'} />
        </div>
      </Faceplate>
    </HwWindow>
  );
};
