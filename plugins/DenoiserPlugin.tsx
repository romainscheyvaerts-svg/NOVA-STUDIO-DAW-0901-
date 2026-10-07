import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { termHelp } from '../utils/pluginUi';

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
      { name: 'hum', defaultValue: 0, minValue: 0, maxValue: 1 }
    ];
  }
  constructor() {
    super();
    this.ms = 0; this.gain = 1; this.open = true; this.holdLeft = 0;
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
try { registerProcessor('vocal-gate-processor-v2', VocalGateProcessor); } catch (e) {}
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
      this.worklet = new AudioWorkletNode(this.ctx, 'vocal-gate-processor-v2', {
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
      try { this.worklet.port.onmessage = null; this.worklet.disconnect(); } catch (e) {}
      this.worklet = null;
    }
  }
}

// ============== UI COMPONENT ==============

interface VocalDenoiserUIProps {
  node: DenoiserNode;
  initialParams: DenoiserParams;
  onParamsChange?: (p: DenoiserParams) => void;
}

export const VocalDenoiserUI: React.FC<VocalDenoiserUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<DenoiserParams>(initialParams);
  const [status, setStatus] = useState({ reduction: 1.0, reductionDb: 0, inputLevel: -60, isOpen: true, isActive: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paramsRef = useRef(params);

  useEffect(() => { paramsRef.current = params; }, [params]);

  // Animation loop for metering
  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      setStatus(node.getStatus());
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node]);

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    
    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      const y = (i / 6) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    
    // Threshold line
    const threshY = h - ((params.threshold + 60) / 60) * h;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Range zone (below threshold)
    const rangeY = h - ((params.range + 60) / 60) * h;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
    ctx.fillRect(0, threshY, w, rangeY - threshY);
    
    // Input level meter (left side)
    const levelY = h - ((status.inputLevel + 60) / 60) * h;
    const clampedLevelY = Math.max(0, Math.min(h, levelY));
    ctx.fillStyle = status.isOpen ? '#10b981' : '#ef4444';
    ctx.fillRect(10, clampedLevelY, 20, h - clampedLevelY);
    
    // Gain reduction meter (right side)
    const grHeight = (1 - status.reduction) * h;
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(w - 30, 0, 20, grHeight);
    
    // Gate status indicator
    ctx.fillStyle = status.isOpen ? '#10b981' : '#ef4444';
    ctx.beginPath();
    ctx.arc(w / 2, 20, 8, 0, Math.PI * 2);
    ctx.fill();
    
    // Labels
    ctx.fillStyle = '#64748b';
    ctx.font = '9px monospace';
    ctx.fillText('ENTRÉE', 14, h - 5);
    ctx.fillText('RÉD.', w - 34, h - 5);
    ctx.fillText(status.isOpen ? 'OUVERTE' : 'FERMÉE', w/2 - 24, 35);
    
    // dB values
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.fillText(`${Math.round(status.inputLevel)}dB`, 5, clampedLevelY - 5);
    if (status.reductionDb < -0.5) {
      ctx.fillText(`${status.reductionDb.toFixed(1)}dB`, w - 45, grHeight + 15);
    }
    
  }, [params.threshold, params.range, status]);

  const handleParamChange = (key: keyof DenoiserParams, value: number | boolean) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const loadPreset = (index: number) => {
    const preset = DENOISER_PRESETS[index];
    const newParams = { ...params, ...preset, isEnabled: params.isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <div className="w-[520px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-teal-500/10 flex items-center justify-center text-teal-400 border border-teal-500/20 shadow-lg shadow-teal-500/5">
            <i className="fas fa-broom text-xl"></i>
          </div>
          <div>
            <h2 className="text-lg font-black text-white tracking-tight leading-none">Anti-bruit</h2>
            <p className="text-[11px] text-slate-400 mt-1">Coupe le souffle et les bruits de la pièce entre tes phrases.</p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <select
            onChange={(e) => loadPreset(parseInt(e.target.value))}
            aria-label="Préréglages de l'anti-bruit"
            className="bg-[#14161a] border border-white/10 rounded-xl px-3 py-2 text-[11px] font-bold text-white cursor-pointer hover:border-teal-500/50 transition-all"
          >
            <option value="-1">Préréglages…</option>
            {DENOISER_PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.name}</option>
            ))}
          </select>
          <button data-plugin-power 
            onClick={() => handleParamChange('isEnabled', !params.isEnabled)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-teal-500 border-teal-400 text-black shadow-lg shadow-teal-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
          >
            <i className="fas fa-power-off"></i>
          </button>
        </div>
      </div>

      {/* Visualizer */}
      <div className="h-36 bg-black/60 rounded-[28px] border border-white/5 relative overflow-hidden shadow-inner">
        <canvas ref={canvasRef} width={480} height={144} className="w-full h-full" />
      </div>

      {/* Main Controls Row 1 */}
      <div className="grid grid-cols-4 gap-4">
        <ProKnob label="Seuil" value={params.threshold} min={-60} max={0} suffix="dB" color="#14b8a6" onChange={(v) => handleParamChange('threshold', v)} />
        <ProKnob label="Plage" value={params.range} min={-80} max={0} suffix="dB" color="#f59e0b" onChange={(v) => handleParamChange('range', v)} />
        <ProKnob label="Attack" value={params.attack} min={0.0001} max={0.1} suffix="ms" factor={1000} color="#fff" onChange={(v) => handleParamChange('attack', v)} />
        <ProKnob label="Maintien" value={params.hold} min={0} max={0.5} suffix="ms" factor={1000} color="#fff" onChange={(v) => handleParamChange('hold', v)} />
      </div>

      {/* Main Controls Row 2 */}
      <div className="grid grid-cols-4 gap-4">
        <ProKnob label="Release" value={params.release} min={0.01} max={2.0} suffix="ms" factor={1000} color="#fff" onChange={(v) => handleParamChange('release', v)} />
        <ProKnob label="Filtre de détection" value={params.scFreq} min={20} max={20000} suffix="Hz" color="#8b5cf6" log onChange={(v) => handleParamChange('scFreq', v)} />
        <div className="flex flex-col items-center justify-center">
          <button
            onClick={() => handleParamChange('flip', !params.flip)}
            title={params.flip ? 'Baisse auto (ducking) : baisse le son quand il dépasse le seuil' : 'Porte (gate) : coupe le son sous le seuil (entre les phrases)'}
            className={`w-16 h-10 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all border ${params.flip ? 'bg-purple-500 border-purple-400 text-white shadow-lg shadow-purple-500/30' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
          >
            {params.flip ? 'Baisse' : 'Porte'}
          </button>
          <span className="text-[9px] font-bold text-slate-400 mt-2">Mode</span>
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className={`w-16 h-10 rounded-xl flex items-center justify-center text-[10px] font-black uppercase tracking-wider border ${status.isOpen ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : 'bg-red-500/20 border-red-500/30 text-red-400'}`}>
            {status.isOpen ? 'Ouverte' : 'Fermée'}
          </div>
          <span className="text-[9px] font-bold text-slate-400 mt-2" title="Ouverte : ta voix passe. Fermée : le bruit est coupé.">État</span>
        </div>
      </div>
    </div>
  );
};

// ============== PRO KNOB COMPONENT ==============

const ProKnob: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix: string;
  color: string;
  factor?: number;
  log?: boolean;
}> = ({ label, value, min, max, onChange, suffix, color, factor = 1, log = false }) => {
  const safeVal = Number.isFinite(value) ? value : min;
  const knob = useKnobInteraction(safeVal, onChange, { min, max, log });
  const norm = log
    ? Math.log10(safeVal / min) / Math.log10(max / min)
    : (safeVal - min) / (max - min);
  const rotation = (Math.max(0, Math.min(1, norm)) * 270) - 135;


  const displayVal = log ? Math.round(safeVal) : Math.round(safeVal * factor);

  return (
    <div className="flex flex-col items-center space-y-2" title={termHelp(label) || undefined}>
      <div
        {...knob.bind}
        className="w-14 h-14 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-teal-500/50 transition-all shadow-xl relative"
      >
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div
          className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75"
          style={{
            backgroundColor: color,
            boxShadow: `0 0 12px ${color}44`,
            transform: `rotate(${rotation}deg) translateY(2px)`
          }}
        />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[9px] font-bold text-slate-400 mb-1 whitespace-nowrap">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded-lg border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">{displayVal}{suffix}</span>
        </div>
      </div>
    </div>
  );
};
