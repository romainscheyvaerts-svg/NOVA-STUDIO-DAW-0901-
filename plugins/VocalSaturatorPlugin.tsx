
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
import { Faceplate, HwWindow, Knob, Led, PushButton } from './hw';

const SAT_ACCENT = '#f0a243';

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


  // Courbe redessinée quand les réglages changent (plus de boucle à chaque image).
  useEffect(() => { draw(); }, [draw]);

  const drive = Number.isFinite(params.drive) ? params.drive : 20;
  const modeHelp = (SAT_MODES[params.mode] || { help: '' }).help;
  return (
    <HwWindow type="VOCALSATURATOR" width={540} accent={SAT_ACCENT} accentInk="#1d1003"
      idleHelp={<>Ajoute de la chaleur et du grain : la voix sonne plus pleine et plus proche. <span style={{ color: '#cbd2dc' }}>{modeHelp}</span></>}>
      <Faceplate finish="bronze" model="Saturation" kicker="Couleur analogique · bande, lampe, transistor" modelStyle="serif" style={{ ['--hw-accent' as any]: SAT_ACCENT }}>
        {/* Pas d'interrupteur interne : la barre de la fenêtre (bypass) est le seul marche / arrêt. */}
        <div className="flex items-center gap-2 mb-3" title="Lampe : elle chauffe plus quand la chaleur monte">
          <Led on={drive > 0.5} color={drive > 60 ? '#ff6a1a' : '#ffb347'} large />
          <span className="hw-silk hw-silk-soft">Lampe</span>
        </div>

        <div className="hw-screen">
          <div className="hw-screen-glass" style={{ height: 136 }}>
            <div className="absolute top-2 left-3 hw-silk" style={{ color: '#94a3b8', zIndex: 1 }}>Courbe de saturation</div>
            <canvas ref={canvasRef} width={440} height={144} className="w-full h-full block" aria-label="Courbe de saturation (entrée → sortie)" />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Type de saturation" data-nova-param="mode">
          {(['TAPE', 'TUBE', 'TRANSISTOR', 'SOFT_CLIP'] as SaturationMode[]).map(mode => (
            <PushButton key={mode} role="radio" active={params.mode === mode} onClick={() => setMode(mode)} text={SAT_MODES[mode].label}
              led={SAT_ACCENT} hint={SAT_MODES[mode].help} ariaLabel={SAT_MODES[mode].label} />
          ))}
        </div>

        <div className="hw-rule" style={{ margin: '12px 0' }} />
        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
          <Knob paramId="drive" label="Chaleur" size="L" cap="cream" min={0} max={100} step={0.5} value={drive} defaultValue={20}
            onChange={v => setParam('drive', v)} format={v => `${Math.round(v)}`} hint={[termHelp('Chaleur'), 'Quantité de saturation (le niveau reste à peu près constant).'].filter(Boolean).join(' · ')}
            scale={[{ v: 0, label: '0' }, { v: 25, label: '25' }, { v: 50, label: '50' }, { v: 75, label: '75' }, { v: 100, label: '100' }]} />
          <Knob paramId="tone" label="Couleur" size="M" cap="cream" min={-1} max={1} step={0.01} value={params.tone} defaultValue={0} bipolar
            onChange={v => setParam('tone', v)} format={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}`}
            hint={[termHelp('Couleur'), 'Vers la gauche : plus sombre ; vers la droite : plus brillant.'].filter(Boolean).join(' · ')}
            scale={[{ v: -1, label: 'Sombre' }, { v: 0, label: '0' }, { v: 1, label: 'Clair' }]} />
          <Knob paramId="mix" label="Mélange" size="M" cap="cream" min={0} max={1} step={0.01} value={params.mix} defaultValue={0.5}
            onChange={v => setParam('mix', v)} format={v => `${Math.round(v * 100)} %`} hint={[termHelp('Mélange'), 'Part du son saturé mélangée au son d’origine.'].filter(Boolean).join(' · ')}
            scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
          <Knob paramId="outputGain" label="Sortie" size="M" cap="cream" min={0} max={2} step={0.01} value={params.outputGain} defaultValue={1}
            onChange={v => setParam('outputGain', v)} format={v => String(gainDbFr(v))} hint={[termHelp('Sortie'), 'Volume en sortie de la saturation.'].filter(Boolean).join(' · ')}
            ticks={11} />
        </div>
      </Faceplate>
    </HwWindow>
  );
};

