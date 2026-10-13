
import { AutomationSet, MappedParam } from '../engine/automationParams';
import React, { useEffect, useRef, useState } from 'react';
import { setParamSmooth, fadeInOnInsert, smoothSet, TimelineLfo } from './vocalDspUtils';
import { termHelp } from '../utils/pluginUi';
import { Faceplate, HwWindow, Knob, PushButton } from './hw';

/**
 * MODULE FX_10 : VOCAL DOUBLER
 * ---------------------------
 * Logic: Dual-tap delay (Haas Effect) with cross-modulation to simulate micro-pitch shifting.
 * Features: Independent L/R Volume, Width control, and Direct Signal Mute.
 */

export interface DoublerParams {
  detune: number;      // 0 to 1 (Scale for +/- 15 cents)
  width: number;       // 0 to 1 (Stereo Pan Spread)
  gainL: number;       // 0 to 1
  gainR: number;       // 0 to 1
  directOn: boolean;   // Keep or mute the center signal
  isEnabled: boolean;
}

/**
 * Une voix doublee : retard court (10-30 ms) module par deux LFO de vitesses
 * non multiples (derive lente + petite instabilite), comme un chanteur qui
 * double sa prise : jamais exactement en place ni exactement juste.
 */
interface DoubleVoice {
  delay: DelayNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
  /** LFO calés sur le morceau (même phase en lecture et à l'export). */
  /** Partie fixe du retard, en échantillons entiers (copie exacte) ; le retard modulé reste court. */
  pre: DelayNode;
  lfoSlow: TimelineLfo;
  lfoFast: TimelineLfo;
  slowHz: number;
  fastHz: number;
  depthSlow: GainNode;
  depthFast: GainNode;
}

export class VocalDoublerNode {
  private readonly createdAt: number;
  /** Réglages automatisables (R8) : largeur, niveau des doublures gauche / droite. */
  private auto = new AutomationSet();
  private autoState = '';
  private setP(param: AudioParam, value: number, tau: number) {
    setParamSmooth(param, value, this.ctx, this.createdAt, tau);
  }
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  
  private dryGain: GainNode;
  private voiceL: DoubleVoice;
  private voiceR: DoubleVoice;

  private params: DoublerParams = {
    detune: 0.4,
    width: 0.8,
    gainL: 0.7,
    gainR: 0.7,
    directOn: true,
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.createdAt = ctx.currentTime;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    
    // Fondu d'apparition (anti-clic) en direct ; aucun à l'export (le rendu démarre sur le son).
    fadeInOnInsert(this.output.gain, ctx);
    
    this.dryGain = ctx.createGain();
    // Temps de base et vitesses differents a gauche et a droite : les deux
    // doublures ne se superposent jamais en peigne fixe.
    this.voiceL = this.createVoice(0.016, 0.23, 1.7);
    this.voiceR = this.createVoice(0.024, 0.31, 1.3);

    this.setupGraph();
  }

  private createVoice(baseDelay: number, slowHz: number, fastHz: number): DoubleVoice {
    const ctx = this.ctx;
    // Retard de base en deux étages : une partie fixe en échantillons entiers (exacte), puis un
    // retard modulé à tampon court (12 ms) : position de lecture interpolée plus précise, la
    // lecture retombe sur l'export à moins d'1 LSB 16 bits (avant : jusqu'à 1,1 LSB à 44,1 kHz).
    const pre = ctx.createDelay(0.05);
    const preSec = Math.floor((baseDelay - 0.005) * ctx.sampleRate) / ctx.sampleRate;
    pre.delayTime.value = preSec;
    const delay = ctx.createDelay(0.012);
    delay.delayTime.value = baseDelay - preSec;
    pre.connect(delay);
    // Doublure allegee dans le grave (pas d'empatement ni d'annulation de
    // phase dans le bas) et un peu plus douce dans l'aigu : elle reste
    // derriere la voix principale.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 150;
    hp.Q.value = -3.01;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    lp.Q.value = -3.01;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    const depthSlow = ctx.createGain();
    depthSlow.gain.value = 0;
    const depthFast = ctx.createGain();
    depthFast.gain.value = 0;
    const lfoSlow = new TimelineLfo(ctx, depthSlow, slowHz, 0, 'sine');
    const lfoFast = new TimelineLfo(ctx, depthFast, fastHz, 0, 'triangle');
    depthSlow.connect(delay.delayTime);
    depthFast.connect(delay.delayTime);
    return { pre, delay, hp, lp, gain, panner, lfoSlow, lfoFast, depthSlow, depthFast, slowHz, fastHz };
  }

  private setupGraph() {
    // 1. Dry Path (Center)
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // 2. Doublures gauche et droite
    for (const v of [this.voiceL, this.voiceR]) {
      this.input.connect(v.pre);
      v.delay.connect(v.hp);
      v.hp.connect(v.lp);
      v.lp.connect(v.gain);
      v.gain.connect(v.panner);
      v.panner.connect(this.output);
    }

    this.auto.add('width', new MappedParam(this.ctx, [{ param: this.voiceL.panner.pan, map: v => -v }, { param: this.voiceR.panner.pan }], { min: 0, max: 1, value: 0, affine: true }));
    this.auto.add('gainL', new MappedParam(this.ctx, [{ param: this.voiceL.gain.gain }], { min: 0, max: 1, value: 0, affine: true }));
    this.auto.add('gainR', new MappedParam(this.ctx, [{ param: this.voiceR.gain.gain }], { min: 0, max: 1, value: 0, affine: true }));
    this.applyParams();
  }

  /** AudioParam d'un réglage automatisable (R8) : « width », « gainL », « gainR » ; sinon null. */
  public automationParam(key: string): MappedParam | null { return this.auto.get(key); }
  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  public updateParams(p: Partial<DoublerParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;
    const { detune, width, gainL, gainR, directOn, isEnabled } = this.params;
    const stKey = `${isEnabled ? 1 : 0}`;
    const st = { force: stKey !== this.autoState, tau: 0.05, immediate: this.ctx.currentTime <= this.createdAt };
    this.autoState = stKey;

    if (isEnabled) {
      this.setP(this.dryGain.gain, directOn ? 1.0 : 0.0, 0.05);
      this.auto.get('gainL')!.setStatic(Math.max(0, safe(gainL)), st);
      this.auto.get('gainR')!.setStatic(Math.max(0, safe(gainR)), st);
      
      const sWidth = Math.max(0, Math.min(1, safe(width)));
      this.auto.get('width')!.setStatic(sWidth, { ...st, tau: 0.1 });
      
      // Detune 0..1 => ecart de hauteur crete d'environ 0..15 cents.
      // L'ecart de hauteur d'un retard module vaut 2*pi*f*A : on calcule
      // l'amplitude A pour chaque LFO a partir de l'ecart voulu (avant :
      // 4 cents au maximum, alors que l'interface affiche 15).
      const d = Math.max(0, Math.min(1, safe(detune)));
      for (const v of [this.voiceL, this.voiceR]) {
        const slowA = (d * 0.0065) / (2 * Math.PI * v.slowHz);
        const fastA = (d * 0.0022) / (2 * Math.PI * v.fastHz);
        this.setP(v.depthSlow.gain, slowA, 0.1);
        this.setP(v.depthFast.gain, fastA, 0.1);
      }
    } else {
      this.setP(this.dryGain.gain, 1.0, 0.02);
      this.auto.get('gainL')!.setStatic(0, { ...st, tau: 0.02 });
      this.auto.get('gainR')!.setStatic(0, { ...st, tau: 0.02 });
    }
  }

  /** Modulation calée sur la ligne de temps du morceau (le moteur appelle syncTimeline). */
  public get followsTimeline(): boolean { return true; }
  public syncTimeline(origin: number, at?: number) {
    for (const v of [this.voiceL, this.voiceR]) { v.lfoSlow.sync(origin, at); v.lfoFast.sync(origin, at); }
  }

  public getStatus() {
    return { ...this.params };
  }

  public dispose() {
    for (const v of [this.voiceL, this.voiceR]) {
      v.lfoSlow.stop(); v.lfoFast.stop();
      for (const n of [v.pre, v.delay, v.hp, v.lp, v.gain, v.panner, v.depthSlow, v.depthFast]) {
        try { n.disconnect(); } catch (e) {}
      }
    }
    try { this.dryGain.disconnect(); } catch (e) {}
  }
}

const DOUBLER_DEFAULTS: DoublerParams = { detune: 0.4, width: 0.8, gainL: 0.7, gainR: 0.7, directOn: true, isEnabled: true };
const DOUBLER_ACCENT = '#f2b84b';
const pct = (v: number) => `${Math.round(v * 100)} %`;

export const VocalDoublerUI: React.FC<{ node: VocalDoublerNode, initialParams: DoublerParams, onParamsChange?: (p: DoublerParams) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view: DoublerParams = { ...DOUBLER_DEFAULTS, ...Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))) } as DoublerParams;

  // Image stéréo : redessinée seulement quand un réglage change (plus de boucle à chaque image).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const { width, gainL, gainR, directOn } = view;
    const cx = w / 2, cy = h - 18;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 10;
    ctx.shadowColor = DOUBLER_ACCENT;
    if (directOn) {
      ctx.beginPath(); ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.moveTo(cx, cy); ctx.lineTo(cx, 26); ctx.stroke();
    }
    ctx.beginPath(); ctx.strokeStyle = `rgba(242, 184, 75, ${Math.max(0.08, gainL)})`;
    ctx.moveTo(cx, cy); ctx.lineTo(cx - width * (w / 2.5), 34); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = `rgba(242, 184, 75, ${Math.max(0.08, gainR)})`;
    ctx.moveTo(cx, cy); ctx.lineTo(cx + width * (w / 2.5), 34); ctx.stroke();
    ctx.shadowBlur = 0;
  }, [view.width, view.gainL, view.gainR, view.directOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleParamChange = (key: keyof DoublerParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  return (
    <HwWindow type="DOUBLER" width={560} accent={DOUBLER_ACCENT} accentInk="#1d1403"
      idleHelp={<>Simule une 2e prise à gauche et à droite : la voix s'élargit. Doublures décalées de 16 ms à gauche et 24 ms à droite. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="forest" model="Doubleur" kicker="Double prise · gauche / droite" modelStyle="serif" className="hw-touch" style={{ ['--hw-accent' as any]: DOUBLER_ACCENT }}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="hw-screen flex-[1_1_240px] min-w-0">
            <div className="hw-screen-glass" style={{ height: 110 }}>
              <div className="absolute top-2 left-3 hw-silk" style={{ color: '#94a3b8', zIndex: 1 }}>Image stéréo</div>
              <canvas ref={canvasRef} width={400} height={110} className="w-full h-full block" aria-label="Image stéréo des doublures" />
              <div className="absolute bottom-1.5 left-3 right-3 flex justify-between hw-silk" style={{ color: '#94a3b8' }}><span>Gauche</span><span>Centre</span><span>Droite</span></div>
            </div>
          </div>
          <div className="mx-auto">
            <PushButton active={!!view.directOn} onClick={() => handleParamChange('directOn', !view.directOn)} text="Voix d'origine" label="Au centre" led={DOUBLER_ACCENT}
              hint="Entendre la voix d'origine au centre en plus des doublures (relevé = seulement les doublures)." valueText={view.directOn ? 'gardée' : 'coupée'} />
          </div>
        </div>
        <div className="hw-rule" />
        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3">
          <Knob paramId="detune" label="Désaccord" size="L" cap="cream" min={0} max={1} step={0.01} value={view.detune} defaultValue={0.4}
            onChange={v => handleParamChange('detune', v)} format={v => `±${Math.round(v * 15)} cents`} hint={termHelp('Désaccord') || "Petite différence de justesse des doublures (jusqu'à ±15 cents)."}
            scale={[{ v: 0, label: '0' }, { v: 0.5, label: '7' }, { v: 1, label: '15' }]} />
          <Knob paramId="width" label="Écart G/D" size="L" cap="cream" min={0} max={1} step={0.01} value={view.width} defaultValue={0.8}
            onChange={v => handleParamChange('width', v)} format={pct} hint={termHelp('Écart G/D') || 'Écart des doublures entre la gauche et la droite.'}
            scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
          <div className="flex gap-x-2">
          <Knob paramId="gainL" label="Gauche" ariaLabel="Volume gauche" size="M" cap="cream" min={0} max={1} step={0.01} value={view.gainL} defaultValue={0.7}
            onChange={v => handleParamChange('gainL', v)} format={pct} hint="Volume de la doublure de gauche." ticks={11} />
          <Knob paramId="gainR" label="Droite" ariaLabel="Volume droite" size="M" cap="cream" min={0} max={1} step={0.01} value={view.gainR} defaultValue={0.7}
            onChange={v => handleParamChange('gainR', v)} format={pct} hint="Volume de la doublure de droite." ticks={11} />
          </div>
        </div>
      </Faceplate>
    </HwWindow>
  );
};
