
import { AutomationSet, MappedParam } from '../engine/automationParams';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { gainDbFr, termHelp } from '../utils/pluginUi';

const SAT_MODES: Record<string, { label: string; help: string }> = {
  TAPE: { label: 'Bande', help: 'Bande (tape) : chaleur douce et ronde, comme un magnéto analogique.' },
  TUBE: { label: 'Lampe', help: 'Lampe (tube) : grain chaud et riche, la voix gagne en épaisseur.' },
  TRANSISTOR: { label: 'Transistor', help: 'Transistor : grain plus dur et brillant, la voix devient agressive.' },
  SOFT_CLIP: { label: 'Écrêtage doux', help: 'Écrêtage doux (soft clip) : arrondit les crêtes, la voix paraît plus forte sans claquer.' },
};
import { loadWorkletModule, setParamSmooth } from './vocalDspUtils';
import { retireWorkletNode } from '../engine/workletGuard';

/**
 * MODULE FX_03 : VOCAL SATURATOR (ANALOG COLORATION v2.0)
 * -----------------------------------------------------
 * DSP: Drive -> Shaper (ADAA, sans latence) -> compensation de niveau -> Tilt Tone
 *      -> 3-Band EQ -> Mix.
 */

export type SaturationMode = 'TUBE' | 'TAPE' | 'TRANSISTOR' | 'SOFT_CLIP';

export interface SaturatorParams {
  drive: number;      // 0 to 100
  mix: number;        // 0 to 1
  tone: number;       // -1.0 to 1.0 (Tilt)
  eqLow: number;      // -12 to 12 dB (200Hz)
  eqMid: number;      // -12 to 12 dB (1.5kHz)
  eqHigh: number;     // -12 to 12 dB (8kHz)
  mode: SaturationMode;
  isEnabled: boolean;
  outputGain: number; // Added to interface to match usage
}

/**
 * Etage de saturation sans latence : anti-repliement par ADAA du 1er ordre
 * (« antiderivative anti-aliasing », Parker/Zavalishin/Le Bivic 2016).
 *
 * Le WaveShaperNode surechantillonne x4 retardait la voie saturee de 4 ms
 * (192 echantillons a 48 kHz, mesure) sans retard equivalent sur le sec :
 * au mix 0,3 a 0,7 des styles, la voix etait filtree en peigne (creux tous les
 * 250 Hz) et le retard s'entendait au casque pendant la prise. L'ADAA calcule
 * la moyenne exacte de la courbe entre deux echantillons (primitive tabulee),
 * ce qui attenue fortement les harmoniques repliees pour un retard d'un
 * demi-echantillon seulement (~0,01 ms).
 */
const ADAA_WORKLET_CODE = `
class AdaaShaperProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.f = null; this.F = null; this.n = 0;
    this.prev = [0, 0]; this.pending = null;
    // Courbe initiale passee a la creation : disponible des le premier bloc
    // (un message du port peut arriver apres le debut d'un rendu hors ligne).
    const init = options && options.processorOptions && options.processorOptions.curve;
    if (init && init.length > 1) this.load(Float32Array.from(init));
    this.port.onmessage = (e) => { if (e.data && e.data.curve) this.pending = e.data.curve; };
  }
  load(curve) {
    const n = curve.length;
    const h = 2 / (n - 1);
    const F = new Float64Array(n);
    for (let i = 1; i < n; i++) F[i] = F[i - 1] + 0.5 * h * (curve[i - 1] + curve[i]);
    this.f = curve; this.F = F; this.n = n; this.h = h;
  }
  // Courbe (interpolation lineaire, prolongee a plat hors de [-1, 1])
  fv(x) {
    const f = this.f, n = this.n;
    if (x <= -1) return f[0];
    if (x >= 1) return f[n - 1];
    const u = (x + 1) / this.h; const j = Math.min(n - 2, Math.floor(u)); const t = u - j;
    return f[j] + (f[j + 1] - f[j]) * t;
  }
  // Primitive exacte de la courbe lineaire par morceaux
  Fv(x) {
    const f = this.f, F = this.F, n = this.n, h = this.h;
    if (x <= -1) return f[0] * (x + 1);
    if (x >= 1) return F[n - 1] + f[n - 1] * (x - 1);
    const u = (x + 1) / h; const j = Math.min(n - 2, Math.floor(u)); const d = (u - j) * h;
    return F[j] + f[j] * d + 0.5 * (f[j + 1] - f[j]) / h * d * d;
  }
  process(inputs, outputs) {
    if (this.pending) { this.load(this.pending); this.pending = null; }
    const input = inputs[0], output = outputs[0];
    if (!output || !output[0]) return true;
    const nIn = input ? input.length : 0;
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      const src = nIn > 0 ? (input[c] || input[0]) : null;
      if (!src || !this.f) { if (src) out.set(src); else out.fill(0); this.prev[c] = 0; continue; }
      let xp = this.prev[c] || 0, Fp = this.Fv(xp);
      for (let i = 0; i < out.length; i++) {
        const x = src[i];
        const dx = x - xp;
        let y;
        if (dx > 1e-5 || dx < -1e-5) {
          const Fx = this.Fv(x);
          y = (Fx - Fp) / dx;
          Fp = Fx;
        } else {
          y = this.fv(0.5 * (x + xp));
          Fp = this.Fv(x);
        }
        out[i] = y;
        xp = x;
      }
      this.prev[c] = xp;
    }
    return true;
  }
}
try { registerProcessor('adaa-shaper-processor', AdaaShaperProcessor); } catch (e) {}
`;

/** Niveau de reference de la compensation de drive : sinus crete -14 dBFS (voix deja compressee). */
const DRIVE_REF_AMPLITUDE = 0.2;

export class VocalSaturatorNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private driveGain: GainNode;
  // Repli (et passage avant chargement du worklet) : courbe sans surechantillonnage,
  // donc sans latence.
  private shaper: WaveShaperNode;
  private adaa: AudioWorkletNode | null = null;
  /** Saturation retirée : un worklet encore en chargement n'est pas créé (sinon il restait vivant). */
  private disposed = false;
  private curve: Float32Array = new Float32Array([-1, 1]);
  private autoGain: GainNode;
  private dcBlock: BiquadFilterNode;
  private tiltLow: BiquadFilterNode;
  private tiltHigh: BiquadFilterNode;
  private eqLowNode: BiquadFilterNode;
  private eqMidNode: BiquadFilterNode;
  private eqHighNode: BiquadFilterNode;
  private wetGain: GainNode;
  private dryGain: GainNode;
  private makeupGain: GainNode;
  private readonly createdAt: number;
  /** Réglages automatisables (R8) : mélange, couleur (tilt), gain de sortie. */
  private auto = new AutomationSet();
  private autoState = '';

  /** Pret quand l'etage ADAA est en place (le rendu hors ligne attend cette promesse). */
  public readonly ready: Promise<void>;
  /** Aucun retard ajoute (l'ADAA decale de 0,5 echantillon, negligeable). */
  public readonly latency = 0;

  private params: SaturatorParams = {
    drive: 20,
    mix: 0.5,
    tone: 0.0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    mode: 'TAPE',
    isEnabled: true,
    outputGain: 1.0
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.createdAt = ctx.currentTime;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.driveGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = 'none';
    this.autoGain = ctx.createGain();
    // Une courbe asymetrique cree une composante continue : on la retire.
    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 10;
    this.tiltLow = ctx.createBiquadFilter();
    this.tiltLow.type = 'lowshelf';
    this.tiltLow.frequency.value = 800;
    this.tiltHigh = ctx.createBiquadFilter();
    this.tiltHigh.type = 'highshelf';
    this.tiltHigh.frequency.value = 1200;
    this.eqLowNode = ctx.createBiquadFilter();
    this.eqLowNode.type = 'lowshelf';
    this.eqLowNode.frequency.value = 200;
    this.eqMidNode = ctx.createBiquadFilter();
    this.eqMidNode.type = 'peaking';
    this.eqMidNode.frequency.value = 1500;
    this.eqMidNode.Q.value = 1.0;
    this.eqHighNode = ctx.createBiquadFilter();
    this.eqHighNode.type = 'highshelf';
    this.eqHighNode.frequency.value = 8000;
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.makeupGain = ctx.createGain();
    this.setupChain();
    this.generateCurve();
    this.auto.add('mix', new MappedParam(ctx, [{ param: this.wetGain.gain }, { param: this.dryGain.gain, map: v => 1 - v }], { min: 0, max: 1, value: 0.5, affine: true }));
    this.auto.add('tone', new MappedParam(ctx, [{ param: this.tiltHigh.gain, map: v => v * 12 }, { param: this.tiltLow.gain, map: v => -v * 12 }], { min: -1, max: 1, value: 0, affine: true }));
    this.auto.add('outputGain', new MappedParam(ctx, [{ param: this.makeupGain.gain }], { min: 0, max: 4, value: 1, affine: true }));
    this.applyParams();
    this.ready = this.initWorklet();
  }

  private setupChain() {
    // -- DRY PATH --
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.makeupGain);

    // -- WET PATH --
    this.input.connect(this.driveGain);
    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.dcBlock);
    this.dcBlock.connect(this.autoGain);
    this.autoGain.connect(this.tiltLow);
    this.tiltLow.connect(this.tiltHigh);
    this.tiltHigh.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighNode);
    this.eqHighNode.connect(this.wetGain);
    this.wetGain.connect(this.makeupGain);

    this.makeupGain.connect(this.output);
  }

  private async initWorklet() {
    try {
      await loadWorkletModule(this.ctx, 'adaa-shaper', ADAA_WORKLET_CODE);
      if (this.disposed) return;
      const node = new AudioWorkletNode(this.ctx, 'adaa-shaper-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { curve: Array.from(this.curve) }
      });
      this.adaa = node;
      // Bascule de l'etage de courbe : meme courbe, meme niveau, meme retard (~0).
      this.driveGain.connect(node);
      node.connect(this.dcBlock);
      try { this.driveGain.disconnect(this.shaper); } catch (e) {}
    } catch (e) {
      console.warn('[VocalSaturator] ADAA indisponible, courbe simple :', e);
    }
  }

  /** AudioParam d'un réglage automatisable (R8) : « mix », « tone », « outputGain » ; sinon null. */
  public automationParam(key: string): MappedParam | null { return this.auto.get(key); }
  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  public updateParams(p: Partial<SaturatorParams>) {
    const oldMode = this.params.mode;
    const oldDrive = this.params.drive;
    this.params = { ...this.params, ...p };

    if (this.params.mode !== oldMode || this.params.drive !== oldDrive) {
      this.generateCurve();
    }
    this.applyParams();
  }

  private safeDrive() {
    const d = Number(this.params.drive);
    return Number.isFinite(d) ? Math.max(0, Math.min(100, d)) : 20;
  }

  private generateCurve() {
    const n = 4096;
    const curve = new Float32Array(n);
    const drive = 1 + (this.safeDrive() / 10);
    for (let i = 0; i < n; i++) {
      // Echantillonnage exact de [-1, 1] (x = 0 tombe sur le milieu de la table)
      const x = (i * 2) / (n - 1) - 1;

      if (this.params.mode === 'TUBE') {
        // Asymetrie douce (harmoniques paires). L'ancienne alternance positive
        // en racine carree ecrasait les petits signaux (pente nulle en 0) et
        // sonnait comme une distorsion de croisement sur les fins de phrase.
        const b = 0.1;
        const t0 = Math.tanh(drive * b);
        const norm = (Math.tanh(drive * (1 + b)) - Math.tanh(drive * (b - 1))) / 2;
        curve[i] = (Math.tanh(drive * (x + b)) - t0) / norm;
      }
      else if (this.params.mode === 'TRANSISTOR') {
        // Ecretage plus dur et symetrique (harmoniques impaires). Ce mode n'avait
        // pas de courbe : la voie saturee etait muette (presets Drill / Telephone).
        const shape = (v: number) => (drive * v) / Math.pow(1 + Math.pow(Math.abs(drive * v), 2.5), 0.4);
        curve[i] = shape(x) / shape(1);
      }
      else if (this.params.mode === 'SOFT_CLIP') {
        const gainX = x * drive * 0.5;
        curve[i] = Math.abs(gainX) < 1 ? gainX - (Math.pow(gainX, 3) / 3) : (gainX > 0 ? 0.66 : -0.66);
        curve[i] *= 1.5;
      }
      else {
        // TAPE (et valeur inconnue) : tangente hyperbolique normalisee
        curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
      }
    }
    this.curve = curve;
    this.shaper.curve = curve;
    if (this.adaa) this.adaa.port.postMessage({ curve });
  }

  /**
   * Compensation de niveau du drive : gain efficace de « pre-gain + courbe »
   * pour un sinus de reference (crete -14 dBFS, niveau typique d'une voix
   * compressee), inverse ensuite. Avant, la voie saturee sortait 6 a 14 dB
   * plus fort que le sec (drive 15 a 40) : monter le drive montait surtout le
   * volume. Desormais le drive change la couleur (harmoniques, arrondi des
   * cretes) a niveau quasi constant, comme les saturateurs de reference.
   */
  private driveCompensation(pre: number): number {
    const c = this.curve, n = c.length;
    const lookup = (x: number) => {
      if (x <= -1) return c[0];
      if (x >= 1) return c[n - 1];
      const u = (x + 1) * (n - 1) / 2; const j = Math.min(n - 2, Math.floor(u)); const t = u - j;
      return c[j] + (c[j + 1] - c[j]) * t;
    };
    const N = 256;
    let mean = 0;
    const ys = new Float64Array(N);
    for (let i = 0; i < N; i++) { ys[i] = lookup(pre * DRIVE_REF_AMPLITUDE * Math.sin(2 * Math.PI * (i + 0.5) / N)); mean += ys[i]; }
    mean /= N;
    let e = 0;
    for (let i = 0; i < N; i++) e += (ys[i] - mean) * (ys[i] - mean);
    const rmsOut = Math.sqrt(e / N);
    const rmsIn = DRIVE_REF_AMPLITUDE / Math.SQRT2;
    return rmsOut > 1e-9 ? rmsIn / rmsOut : 1;
  }

  private applyParams() {
    const { tone, mix, outputGain, isEnabled } = this.params;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    const set = (prm: AudioParam, v: number) => setParamSmooth(prm, v, this.ctx, this.createdAt, 0.02);
    const stKey = `${isEnabled ? 1 : 0}`;
    const st = { force: stKey !== this.autoState, tau: 0.02, immediate: this.ctx.currentTime <= this.createdAt };
    this.autoState = stKey;

    if (isEnabled) {
      const pre = 1 + (this.safeDrive() / 25);
      set(this.driveGain.gain, pre);
      set(this.autoGain.gain, this.driveCompensation(pre));

      const sTone = Math.max(-1, Math.min(1, safe(tone)));
      this.auto.get('tone')!.setStatic(sTone, st);

      set(this.eqLowNode.gain, safe(this.params.eqLow));
      set(this.eqMidNode.gain, safe(this.params.eqMid));
      set(this.eqHighNode.gain, safe(this.params.eqHigh));

      const sMix = Math.max(0, Math.min(1, safe(mix)));
      this.auto.get('mix')!.setStatic(sMix, st);
      this.auto.get('outputGain')!.setStatic(Math.max(0, Number.isFinite(outputGain) ? outputGain : 1), st);
    } else {
      this.auto.get('mix')!.setStatic(0, st);
      this.auto.get('outputGain')!.setStatic(1, st);
    }
  }

  public getParams() { return { ...this.params }; }

  public dispose() {
    this.disposed = true;
    try { this.input.disconnect(); } catch (e) {}
    if (this.adaa) {
      retireWorkletNode(this.adaa);
      this.adaa = null;
    }
  }
}

interface VocalSaturationUIProps {
  node: VocalSaturatorNode;
  initialParams: SaturatorParams;
  // Remonte les reglages vers le projet (sans ca, les reglages du saturateur
  // etaient perdus a la fermeture de l'UI et absents des sauvegardes).
  onParamsChange?: (params: SaturatorParams) => void;
}

/**
 * VOCAL SATURATION UI (Converted to Functional Component for fix)
 */
export const VocalSaturatorUI: React.FC<VocalSaturationUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<SaturatorParams>(initialParams);
  const hasMounted = useRef(false);

  // Persiste les parametres dans l'etat du projet a chaque changement.
  useEffect(() => {
    if (!hasMounted.current) { hasMounted.current = true; return; }
    onParamsChange?.(params);
  }, [params, onParamsChange]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof SaturatorParams | null>(null);
  const lastTouchY = useRef<number>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    const { mode } = params;
    // Meme echelle que generateCurve (1 + drive/10) : la courbe affichee est
    // celle qu'on entend.
    const drive = 1 + (Number.isFinite(params.drive) ? params.drive : 20) / 10;

    ctx.beginPath();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#facc1544';

    for (let i = 0; i < w; i++) {
      const x = (i / w) * 2 - 1;
      let y = 0;

      if (mode === 'TAPE') {
        y = Math.tanh(x * drive) / Math.tanh(drive);
      } else if (mode === 'TUBE') {
        // Meme courbe que le moteur audio
        const b = 0.1;
        const norm = (Math.tanh(drive * (1 + b)) - Math.tanh(drive * (b - 1))) / 2;
        y = (Math.tanh(drive * (x + b)) - Math.tanh(drive * b)) / norm;
      } else if (mode === 'TRANSISTOR') {
        const shape = (v: number) => (drive * v) / Math.pow(1 + Math.pow(Math.abs(drive * v), 2.5), 0.4);
        y = shape(x) / shape(1);
      } else if (mode === 'SOFT_CLIP') {
        const gainX = x * drive * 0.5;
        y = Math.abs(gainX) < 1 ? gainX - (Math.pow(gainX, 3) / 3) : (gainX > 0 ? 0.66 : -0.66);
        y *= 1.5;
      }

      const py = (h / 2) - (y * (h / 2.2));
      if (i === 0) ctx.moveTo(i, py);
      else ctx.lineTo(i, py);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [params]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      draw();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    
    const delta = -e.movementY / 150;
    setParams(prev => {
      const current = prev[activeParam.current!];
      if (typeof current !== 'number') return prev;

      let min = 0, max = 1;
      // Drive sur 0-100 comme les reglages enregistres (l'ancien 1-10 ramenait
      // d'un coup un drive de preset 25 a 10 des qu'on touchait le bouton).
      if (activeParam.current === 'drive') { min = 0; max = 100; }
      if (activeParam.current === 'tone') { min = -1; max = 1; }
      if (activeParam.current === 'outputGain') { min = 0; max = 2; }
      if (['eqLow', 'eqMid', 'eqHigh'].includes(activeParam.current)) { min = -12; max = 12; }

      const newVal = Math.max(min, Math.min(max, current + delta * (max - min)));
      const newParams = { ...prev, [activeParam.current!]: newVal };
      node.updateParams(newParams);
      return newParams;
    });
  }, [node]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging.current || !activeParam.current || e.touches.length === 0) return;
    e.preventDefault();

    const currentY = e.touches[0].clientY;
    const delta = -(currentY - lastTouchY.current) / 150;
    lastTouchY.current = currentY;

    setParams(prev => {
      const current = prev[activeParam.current!];
      if (typeof current !== 'number') return prev;

      let min = 0, max = 1;
      // Drive sur 0-100 comme les reglages enregistres (l'ancien 1-10 ramenait
      // d'un coup un drive de preset 25 a 10 des qu'on touchait le bouton).
      if (activeParam.current === 'drive') { min = 0; max = 100; }
      if (activeParam.current === 'tone') { min = -1; max = 1; }
      if (activeParam.current === 'outputGain') { min = 0; max = 2; }
      if (['eqLow', 'eqMid', 'eqHigh'].includes(activeParam.current)) { min = -12; max = 12; }

      const newVal = Math.max(min, Math.min(max, current + delta * (max - min)));
      const newParams = { ...prev, [activeParam.current!]: newVal };
      node.updateParams(newParams);
      return newParams;
    });
  }, [node]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
    document.body.style.cursor = 'default';
  }, []);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  const handleMouseDown = (param: keyof SaturatorParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const handleTouchStart = (param: keyof SaturatorParams, e: React.TouchEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    lastTouchY.current = e.touches[0].clientY;
  };

  const setParam = (key: keyof SaturatorParams, value: number) => {
    setParams(prev => {
      const newParams = { ...prev, [key]: value };
      node.updateParams(newParams);
      return newParams;
    });
  };

  const setMode = (mode: SaturationMode) => {
    const newParams = { ...params, mode };
    setParams(newParams);
    node.updateParams(newParams);
  };

  const togglePower = () => {
    const isEnabled = !params.isEnabled;
    const newParams = { ...params, isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
  };

  return (
    <div className="w-[520px] bg-nv-bg border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none text-white">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-yellow-500/10 flex items-center justify-center text-yellow-400 border border-yellow-500/20 shadow-lg shadow-yellow-500/5">
            <i className="fas fa-fire text-2xl"></i>
          </div>
          <div>
            <h2 className="text-2xl font-black tracking-tight leading-none">Saturation</h2>
            <p className="text-[12px] text-slate-400 mt-2">Ajoute de la chaleur et du grain : la voix sonne plus pleine et plus proche.</p>
          </div>
        </div>
        <button data-plugin-power
          onClick={togglePower}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-all border-2 ${params.isEnabled ? 'bg-yellow-500 border-yellow-400 text-black shadow-lg shadow-yellow-500/30' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off text-lg"></i>
        </button>
      </div>

      <div className="h-36 bg-black/60 rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner">
        <div className="absolute top-4 left-8 text-[8px] font-black text-slate-600 uppercase tracking-widest z-10">Courbe de saturation</div>
        <canvas ref={canvasRef} width={440} height={144} className="w-full h-full opacity-80" />
        <div className="absolute inset-0 bg-gradient-to-t from-yellow-500/5 to-transparent pointer-events-none" />
      </div>

      <div className="flex justify-center space-x-3">
        {(['TAPE', 'TUBE', 'TRANSISTOR', 'SOFT_CLIP'] as SaturationMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setMode(mode)}
            title={SAT_MODES[mode].help}
            aria-pressed={params.mode === mode}
            className={`px-4 py-2 rounded-xl text-[11px] font-bold transition-all ${params.mode === mode ? 'bg-yellow-500 text-black' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
          >
            {SAT_MODES[mode].label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-4">
        <SatKnob label="Chaleur" value={(Number.isFinite(params.drive) ? params.drive : 20) / 100} defaultValue={0.2} onChange={(v) => setParam('drive', v * 100)} color="#facc15" suffix="" displayVal={Math.round(Number.isFinite(params.drive) ? params.drive : 20)} />
        <SatKnob label="Couleur" value={(params.tone + 1) / 2} defaultValue={0.5} onChange={(v) => setParam('tone', v * 2 - 1)} color="#facc15" suffix="" displayVal={Math.round(params.tone * 100)} />
        <SatKnob label="Mélange" value={params.mix} defaultValue={0.5} onChange={(v) => setParam('mix', v)} color="#facc15" suffix="%" displayVal={Math.round(params.mix * 100)} />
        <SatKnob label="Sortie" value={params.outputGain / 2} defaultValue={0.5} onChange={(v) => setParam('outputGain', v * 2)} color="#facc15" suffix="" displayVal={gainDbFr(params.outputGain)} />
      </div>

      <p className="pt-4 border-t border-white/5 text-[11px] text-slate-400">{(SAT_MODES[params.mode] || { help: '' }).help}</p>
    </div>
  );
};

const SatKnob: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  defaultValue?: number;
  color: string;
  suffix: string;
  displayVal: number | string;
}> = ({ label, value, onChange, defaultValue, color, suffix, displayVal }) => {
  const safeValue = Number.isFinite(value) ? value : 0;
  const knob = useKnobInteraction(safeValue, onChange, { min: 0, max: 1, sensitivity: 150, defaultValue });
  const rotation = (safeValue * 270) - 135;
  return (
    <div className="flex flex-col items-center space-y-3 group touch-none" title={termHelp(label) || undefined}>
      <div {...knob.bind} className="w-14 h-14 rounded-full bg-nv-surface border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-yellow-500/50 transition-all shadow-xl relative">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1.5 h-6 -ml-0.75 -mt-6 origin-bottom rounded-full transition-transform duration-75" style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color, boxShadow: `0 0 8px ${color}66` }} />
        <div className="absolute inset-4 rounded-full bg-nv-raised border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[9px] font-bold text-slate-400 mb-1.5 whitespace-nowrap">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[45px]"><span className="text-[9px] font-mono font-bold text-white">{displayVal}{suffix}</span></div>
      </div>
    </div>
  );
};