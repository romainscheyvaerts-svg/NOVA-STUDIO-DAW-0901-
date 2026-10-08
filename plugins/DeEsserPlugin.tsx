import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { loadWorkletModule } from './vocalDspUtils';
import { termHelp } from '../utils/pluginUi';
import { createDeesserCore } from '../engine/deesserCore';
import { retireWorkletNode } from '../engine/workletGuard';

/**
 * DE-ESSER NOVA (v3, mesuré au labo : D:\1 WORK\CONTENU\nova-labo\deesser)
 * ------------------------------------------------------------------------
 * Dynamique et à bande ciblée : seule la bande des « s » est atténuée
 * (y = x + (g − 1)·bande), reconstruction exacte quand il ne travaille pas.
 * Cœur DSP : engine/deesserCore.ts (AudioWorklet, même code en lecture et à
 * l'export ; testé sous Node). 8 kHz par défaut (règle de Romain).
 *
 * Détection :
 *  - « Relative » (nouvelles instances) : la bande comparée au reste de la
 *    voix ; ne dépend pas du niveau d'enregistrement, ne touche pas les
 *    voyelles claires.
 *  - « Absolue » : seuil fixe en dB, comme l'ancien de-esser (projets
 *    existants : un réglage sans `detection` reste en absolu).
 *
 * Écoute externe (side-chain, R7) : `sidechainInput` entre sur la 2e entrée du
 * worklet ; branchée, elle remplace le signal du détecteur (le son traité reste
 * celui de la piste) ; « écouter la clé » (keyListen) fait entendre la clé.
 * Automation (R8) : seuil, seuil relatif et fréquence sont des AudioParam
 * k-rate du worklet (lus à chaque bloc de 128 échantillons, lecture et export).
 */

export type DeEsserMode = 'BELL' | 'SHELF';
export type DeEsserDetection = 'RELATIVE' | 'ABSOLUTE';

export interface DeEsserParams {
  threshold: number;   // -60 à 0 dB (détection absolue)
  frequency: number;   // 2000 à 16000 Hz
  q: number;           // 0.3 à 6 (largeur de la cloche)
  reduction: number;   // 0 à 1 (ratio et réduction maximale)
  mode: DeEsserMode;
  isEnabled: boolean;
  /** Absent = ancien projet = détection absolue. */
  detection?: DeEsserDetection;
  /** Seuil relatif (dB, bande / reste de la voix), -30 à +6. */
  relThreshold?: number;
  /** 0 normal, 1 la bande seule, 2 ce qui est retiré. */
  listen?: number;
  /** Écoute externe (side-chain, R7) : filtre de la clé (Hz) et écoute de la clé. */
  keyHpf?: number;
  keyLpf?: number;
  keyListen?: number;
}

/** Réglages automatisables (R8) : AudioParam k-rate du worklet, bornes de l'utilisateur. */
const DEESS_AP: { name: 'threshold' | 'relThreshold' | 'frequency'; min: number; max: number; def: number }[] = [
  { name: 'threshold', min: -60, max: 0, def: -25 },
  { name: 'relThreshold', min: -30, max: 6, def: -6 },
  { name: 'frequency', min: 1000, max: 20000, def: 8000 },
];

/** Réglages d'une nouvelle instance (8 kHz, détection relative). */
export const DEESSER_DEFAULTS: DeEsserParams = {
  threshold: -30, frequency: 8000, q: 1.0, reduction: 0.6, mode: 'BELL', isEnabled: true,
  detection: 'RELATIVE', relThreshold: -6, listen: 0,
};

/** Réduction maximale (dB) pour une valeur du bouton « Réduction » (0..1). */
export const deesserMaxRangeDb = (r: number) => (r > 0 ? 4 + 14 * Math.max(0, Math.min(1, r)) : 0);

const MODE_LABELS: Record<DeEsserMode, { label: string; help: string }> = {
  BELL: { label: 'Ciblé (cloche)', help: 'Ciblé : baisse seulement la zone des « s » autour de la fréquence. Le plus naturel.' },
  SHELF: { label: 'Tous les aigus', help: 'Tous les aigus : baisse tout ce qui est au-dessus de la fréquence quand un « s » arrive. Plus fort.' },
};
const DETECTION_LABELS: Record<DeEsserDetection, { label: string; help: string }> = {
  RELATIVE: { label: 'Relative (suit la voix)', help: 'Réagit quand la zone des « s » domine le reste de la voix : marche quel que soit le niveau d’enregistrement et ne touche pas les voyelles claires.' },
  ABSOLUTE: { label: 'Absolue (seuil fixe)', help: 'Réagit dès que la zone des « s » dépasse un niveau fixe (comportement des anciennes versions).' },
};
const LISTEN_LABELS = [
  { label: 'Normal', help: 'Écoute le résultat.' },
  { label: 'La bande', help: 'Écoute seulement la zone surveillée : pratique pour placer la fréquence sur les « s ».' },
  { label: 'Ce qui est retiré', help: 'Écoute uniquement ce que le de-esser enlève : on doit n’y entendre que des « s ».' },
];

const WORKLET_CODE = `
const createDeesserCore = (${createDeesserCore.toString()});
const __ap = ${JSON.stringify(DEESS_AP)};
class NovaDeesserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __ap.map(d => ({ name: d.name, minValue: d.min, maxValue: d.max, defaultValue: d.def, automationRate: 'k-rate' }))
      // Écoute externe (R7) : détection sur l'entrée 2 (clé), écoute de la clé.
      .concat([{ name: '__keyOn', minValue: 0, maxValue: 1, defaultValue: 0, automationRate: 'k-rate' },
        { name: '__keyListen', minValue: 0, maxValue: 1, defaultValue: 0, automationRate: 'k-rate' }]);
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.params = Object.assign({}, o.params || {});
    this.core = createDeesserCore(sampleRate);
    this.core.setParams(this.params);
    this.dirty = false;
    this.zero = new Float32Array(128);
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) { Object.assign(this.params, d.params); this.dirty = true; }
      if (d.reset) this.core.reset();
    };
  }
  process(inputs, outputs, parameters) {
    // Réglages automatisables : l'AudioParam fait foi (automation programmée au bloc près).
    for (let i = 0; i < __ap.length; i++) {
      const a = parameters[__ap[i].name];
      const v = a && a.length ? a[0] : NaN;
      if (v === v && v !== this.params[__ap[i].name]) { this.params[__ap[i].name] = v; this.dirty = true; }
    }
    if (this.dirty) { this.dirty = false; this.core.setParams(this.params); }
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : this.zero;
    const iR = inp && inp[1] ? inp[1] : null;
    const key = inputs[1];
    // Clé branchée mais muette (source à l'arrêt : entrée inactive, 0 canal) = silence, pas le son de la piste.
    const useKey = parameters.__keyOn[0] >= 0.5;
    const kL = useKey ? (key && key[0] ? key[0] : this.zero) : null;
    const kR = useKey ? (key && key[1] ? key[1] : kL) : null;
    this.core.process(iL, iR, out[0], out[1] || null, n, kL, kR);
    if (useKey && parameters.__keyListen[0] >= 0.5) {
      // Écoute de la clé : on n'entend que la clé (filtrée par la barre « Clé »).
      out[0].set(kL.subarray(0, n));
      if (out[1]) out[1].set(kR.subarray(0, n));
    }
    if (++this.blocks >= 6) { this.blocks = 0; this.port.postMessage(this.core.takeMeters()); }
    return true;
  }
}
try { registerProcessor('nova-deesser-v3', NovaDeesserProcessor); } catch (e) {}
`;

export interface DeEsserMeters { grDb: number; grNowDb: number; detDb: number }

export class DeEsserNode {
  private ctx: BaseAudioContext;
  public input: GainNode;
  public output: GainNode;
  /** Entrée de l'écoute externe (side-chain, R7), câblée par le moteur (engine/sidechain.ts). */
  public readonly sidechainInput: GainNode;
  public readonly ready: Promise<void>;
  private worklet: AudioWorkletNode | null = null;
  private failed = false;
  private keyActive = false;
  /** Effet retiré : un worklet encore en chargement n'est pas créé (sinon il restait vivant). */
  private disposed = false;
  private meters: DeEsserMeters & { at: number } = { grDb: 0, grNowDb: 0, detDb: -120, at: 0 };
  // Projet sans « detection » = réglage d'avant la v3 : détection absolue.
  private params: DeEsserParams = { ...DEESSER_DEFAULTS, threshold: -25, detection: 'ABSOLUTE' };

  constructor(ctx: BaseAudioContext, params?: Partial<DeEsserParams>) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.sidechainInput = ctx.createGain();
    this.sidechainInput.channelCount = 2;
    this.sidechainInput.channelCountMode = 'explicit';
    this.sidechainInput.channelInterpretation = 'speakers';
    if (params) this.params = { ...this.params, ...DeEsserNode.clean(params) };
    this.ready = this.init();
  }

  private static clean(p: Partial<DeEsserParams>): Partial<DeEsserParams> {
    const o: any = {};
    for (const [k, v] of Object.entries(p || {})) if (v !== undefined && v !== null) o[k] = v;
    return o;
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, 'nova-deesser-v3', WORKLET_CODE);
      if (this.disposed) return;
      this.worklet = new AudioWorkletNode(this.ctx, 'nova-deesser-v3', {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData: this.apValues(),
        // Réglages passés à la construction : un message arriverait trop tard à l'export.
        processorOptions: { params: { ...this.params } },
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.grDb)) this.meters = { grDb: d.grDb, grNowDb: d.grNowDb, detDb: d.detDb, at: Date.now() };
      };
      this.input.connect(this.worklet);
      this.sidechainInput.connect(this.worklet, 0, 1);
      this.applyKey();
      this.worklet.connect(this.output);
    } catch (e) {
      console.warn('[NOVA De-esser] AudioWorklet indisponible, effet contourné :', e);
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  /** Retard ajouté (s) : aucun (pas d'anticipation), déclaré au PDC. */
  public get latency(): number { return 0; }

  /** Valeurs fixes des réglages automatisables (bornées). */
  private apValues(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const d of DEESS_AP) {
      const v = Number((this.params as any)[d.name]);
      o[d.name] = Math.max(d.min, Math.min(d.max, Number.isFinite(v) ? v : d.def));
    }
    return o;
  }

  public updateParams(p: Partial<DeEsserParams>) {
    if (!p) return;
    const clean = DeEsserNode.clean(p);
    this.params = { ...this.params, ...clean };
    if (clean.keyListen !== undefined) this.applyKey();
    if (!this.worklet) return;
    // Réglages automatisables : posés sur leur AudioParam (le worklet le lit à chaque bloc) ;
    // les autres par message. Un réglage absent (tenu par une voie d'automation) n'est pas touché.
    const msg: Record<string, any> = {};
    const now = this.ctx.currentTime;
    const ap = this.apValues();
    for (const [k, v] of Object.entries(clean)) {
      const prm = DEESS_AP.some(d => d.name === k) ? (this.worklet.parameters as any).get(k) as AudioParam | undefined : undefined;
      if (prm) { try { prm.setValueAtTime(ap[k], now); } catch { prm.value = ap[k]; } }
      else msg[k] = v;
    }
    if (Object.keys(msg).length) this.worklet.port.postMessage({ params: msg });
  }

  /** AudioParam d'un réglage automatisable (R8) : « threshold », « relThreshold », « frequency » ; sinon null. */
  public automationParam(key: string): AudioParam | null {
    if (!this.worklet || !DEESS_AP.some(d => d.name === key)) return null;
    return (this.worklet.parameters as any).get(key) ?? null;
  }

  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() {
    if (!this.worklet) return;
    const now = this.ctx.currentTime;
    const ap = this.apValues();
    for (const d of DEESS_AP) {
      const prm = (this.worklet.parameters as any).get(d.name) as AudioParam | undefined;
      if (!prm) continue;
      try { prm.cancelScheduledValues(0); prm.setValueAtTime(ap[d.name], now); } catch { prm.value = ap[d.name]; }
    }
  }

  /** Écoute externe branchée (R7) : la détection écoute `sidechainInput`. */
  public setSidechainActive(on: boolean) {
    if (on === this.keyActive) return;
    this.keyActive = on;
    this.applyKey();
  }
  public get sidechainActive() { return this.keyActive; }

  private applyKey() {
    if (!this.worklet) return;
    const prm = this.worklet.parameters as any;
    const now = this.ctx.currentTime;
    try {
      prm.get('__keyOn')?.setValueAtTime(this.keyActive ? 1 : 0, now);
      prm.get('__keyListen')?.setValueAtTime(this.keyActive && Number(this.params.keyListen) >= 0.5 ? 1 : 0, now);
    } catch { /* contexte fermé */ }
  }

  /** Réduction courante de la bande, en dB (valeur négative ou nulle). */
  public getReduction(): number {
    return -this.getMeters().grNowDb;
  }

  /** Réduction max / courante (dB, ≥ 0) et niveau détecté ; remis à zéro après 0,5 s sans nouvelles. */
  public getMeters(): DeEsserMeters {
    if (Date.now() - this.meters.at > 500) return { grDb: 0, grNowDb: 0, detDb: -120 };
    const { at: _a, ...m } = this.meters;
    return m;
  }

  public getParams() { return { ...this.params }; }

  public isFallback() { return this.failed; }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
    try { this.sidechainInput.disconnect(); } catch { /* idem */ }
    try { this.worklet?.disconnect(); } catch { /* idem */ }
    try { this.output.disconnect(); } catch { /* idem */ }
  }

  /** Effet retiré de la piste : worklet mis à la retraite (ou jamais créé s'il chargeait encore), entrées débranchées. */
  public dispose() {
    this.disposed = true;
    if (this.worklet) { retireWorkletNode(this.worklet); this.worklet = null; }
    this.disconnect();
  }
}

// ── Fenêtre ─────────────────────────────────────────────────────────────────

const fr = (v: number, d = 1) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtHz = (hz: number) => (hz >= 1000 ? `${fr(hz / 1000, hz >= 10000 ? 1 : 1)} kHz` : `${Math.round(hz)} Hz`);

/** Réponse (dB) du de-esser à la fréquence f pour une réduction de grDb dB (même formule que le cœur). */
export function deesserResponseDb(f: number, p: Pick<DeEsserParams, 'mode' | 'frequency' | 'q'>, grDb: number, sr = 48000): number {
  const g = Math.pow(10, -grDb / 20);
  const fc = Math.max(500, Math.min(sr * 0.45, p.frequency || 8000));
  const w0 = 2 * Math.PI * fc / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const qq = p.mode === 'SHELF' ? 0.5 : Math.max(0.1, Math.min(10, p.q || 1));
  const al = sw / (2 * qq), a0 = 1 + al;
  let b0: number, b1: number, b2: number;
  if (p.mode === 'SHELF') { b0 = (1 + cw) / 2 / a0; b1 = -(1 + cw) / a0; b2 = (1 + cw) / 2 / a0; } else { b0 = al / a0; b1 = 0; b2 = -al / a0; }
  const a1 = -2 * cw / a0, a2 = (1 - al) / a0;
  const w = 2 * Math.PI * f / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  const den = dr * dr + di * di;
  const hr = (nr * dr + ni * di) / den, hi = (ni * dr - nr * di) / den;
  const yr = 1 + (g - 1) * hr, yi = (g - 1) * hi;
  return 10 * Math.log10(yr * yr + yi * yi + 1e-30);
}

interface VocalDeEsserUIProps {
  node: DeEsserNode;
  initialParams: DeEsserParams;
  onParamsChange?: (p: DeEsserParams) => void;
}

export const VocalDeEsserUI: React.FC<VocalDeEsserUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<DeEsserParams>(() => ({
    ...DEESSER_DEFAULTS, threshold: -25, detection: 'ABSOLUTE', ...(initialParams || {}),
  } as DeEsserParams));
  const paramsRef = useRef(params);
  const [meter, setMeter] = useState({ now: 0, hold: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holdRef = useRef({ v: 0, at: 0 });

  useEffect(() => { paramsRef.current = params; }, [params]);

  const apply = useCallback((patch: Partial<DeEsserParams>) => {
    const next = { ...paramsRef.current, ...patch } as DeEsserParams;
    paramsRef.current = next;
    setParams(next);
    node?.updateParams?.(patch);
    onParamsChange?.(next);
  }, [node, onParamsChange]);

  // VU de réduction (~30 i/s) avec maximum tenu 2 s
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      const m = node?.getMeters ? node.getMeters() : { grNowDb: -(node?.getReduction?.() || 0), grDb: 0 };
      const now = Math.max(0, m.grNowDb || 0, m.grDb || 0);
      const h = holdRef.current;
      if (now >= h.v || t - h.at > 2000) { h.v = now; h.at = t; }
      setMeter(prev => (Math.abs(prev.now - now) > 0.05 || Math.abs(prev.hold - h.v) > 0.05 ? { now, hold: h.v } : prev));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node]);

  // Courbe : réduction maximale (pointillés) et réduction en cours (pleine)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const fmin = 1000, fmax = 20000, top = 26, dbMax = 20;
    const xOf = (f: number) => (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;
    const yOf = (db: number) => top + (-db / dbMax) * (h - top - 16);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(203,213,225,0.75)';
    ctx.font = '10px system-ui, sans-serif';
    for (const f of [2000, 4000, 8000, 16000]) {
      const x = xOf(f);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, h - 3);
    }
    for (const d of [-6, -12, -18]) {
      const y = yOf(d);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(`${d} dB`, 2, y - 2);
    }
    const draw = (gr: number, style: string, dash: number[], width: number) => {
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = 0; i <= w; i += 2) {
        const f = fmin * Math.pow(fmax / fmin, i / w);
        const y = yOf(deesserResponseDb(f, params, gr));
        if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    draw(deesserMaxRangeDb(params.reduction), 'rgba(248,113,113,0.55)', [4, 4], 1.5);
    draw(meter.now, '#f87171', [], 2.5);
    const xf = xOf(params.frequency);
    ctx.fillStyle = '#fca5a5';
    ctx.beginPath(); ctx.arc(xf, yOf(0), 4, 0, Math.PI * 2); ctx.fill();
  }, [params, meter.now]);

  const relative = params.detection !== 'ABSOLUTE';
  const listen = Math.round(params.listen || 0);
  const pct = (x: number) => `${Math.min(100, (x / 20) * 100)}%`;

  return (
    <div data-nova-plugin="DEESSER" className="w-[min(540px,calc(100vw-16px))] bg-[#0c0d10] border border-white/10 rounded-[28px] p-5 sm:p-7 shadow-2xl flex flex-col gap-5 select-none text-white">
      <div className="flex justify-between items-start gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 shrink-0 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-300 border border-red-500/25">
            <i className="fas fa-scissors text-xl" aria-hidden="true"></i>
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-black tracking-tight leading-none">De-esser <span className="text-red-300">· NOVA</span></h2>
            <p className="text-[12px] text-slate-300 mt-1.5 leading-snug">Adoucit les « s » et les « ch » qui sifflent : seule leur zone est baissée, le reste de la voix est intact.</p>
          </div>
        </div>
        <button data-plugin-power type="button" onClick={() => apply({ isEnabled: !params.isEnabled })} aria-pressed={params.isEnabled}
          aria-label={params.isEnabled ? 'Désactiver le de-esser' : 'Activer le de-esser'}
          className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-red-400 border-red-300 text-black shadow-lg shadow-red-500/30' : 'bg-white/5 border-white/15 text-slate-400 hover:text-white'}`}>
          <i className="fas fa-power-off" aria-hidden="true"></i>
        </button>
      </div>

      <div data-nova-gr title="Réduction appliquée à la zone des « s », en dB (maximum tenu 2 s)">
        <div className="flex items-baseline justify-between text-[12px] mb-1">
          <span className="font-bold text-slate-200">Réduction des « s »</span>
          <span className="font-mono font-black tabular-nums">{meter.now > 0.05 ? `−${fr(meter.now)}` : '0,0'} dB <span className="text-slate-400 font-normal">· max {meter.hold > 0.05 ? `−${fr(meter.hold)}` : '0,0'} dB</span></span>
        </div>
        <div className="relative h-3.5 rounded-full bg-white/10 overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-red-400 rounded-full" style={{ width: pct(meter.now) }} />
          <div className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: pct(meter.hold) }} />
        </div>
        <div className="flex justify-between text-[10px] text-slate-400 mt-0.5 font-mono"><span>0</span><span>5</span><span>10</span><span>15</span><span>20 dB</span></div>
      </div>

      <div className="h-32 bg-black/50 rounded-2xl border border-white/10 relative overflow-hidden">
        <canvas ref={canvasRef} width={480} height={128} className="w-full h-full" aria-label="Courbe de réduction : pointillés = réduction maximale, trait plein = réduction en cours" />
        <span className="absolute top-1.5 left-3 text-[11px] font-bold text-slate-200 bg-black/50 px-1.5 rounded">Zone des « s » : {fmtHz(params.frequency)}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <DeEsserKnob label="Fréquence" value={params.frequency} min={2000} max={16000} log defaultValue={8000} onChange={v => apply({ frequency: v })} display={fmtHz(params.frequency)} help="Centre de la zone des « s » (8 kHz par défaut). Astuce : « Écoute : la bande » pour la placer." />
        <DeEsserKnob label="Largeur" value={params.mode === 'SHELF' ? 1 : params.q} min={0.3} max={6} defaultValue={1} disabled={params.mode === 'SHELF'} onChange={v => apply({ q: v })} display={params.mode === 'SHELF' ? '—' : `Q ${fr(params.q)}`} help="Plus la valeur est haute, plus la zone traitée est étroite." />
        {relative ? (
          <DeEsserKnob key="rel" label="Sensibilité" value={-(params.relThreshold ?? -6)} min={-6} max={30} defaultValue={6} onChange={v => apply({ relThreshold: -v })} display={`${fr(-(params.relThreshold ?? -6), 0)} dB`} help="Seuil relatif : plus la valeur est haute, plus le de-esser attrape de « s » (6 dB conseillé)." />
        ) : (
          <DeEsserKnob key="abs" label="Seuil" value={params.threshold} min={-60} max={0} defaultValue={-25} onChange={v => apply({ threshold: v })} display={`${fr(params.threshold, 0)} dB`} help="Niveau de la zone des « s » au-delà duquel le de-esser agit." />
        )}
        <DeEsserKnob label="Réduction" value={params.reduction} min={0} max={1} defaultValue={0.6} onChange={v => apply({ reduction: v })} display={`${Math.round(params.reduction * 100)} % · ${fr(deesserMaxRangeDb(params.reduction), 0)} dB max`} help="Force et réduction maximale appliquée aux « s »." />
      </div>

      <Segmented label="Détection" options={(['RELATIVE', 'ABSOLUTE'] as DeEsserDetection[]).map(d => ({ v: d, ...DETECTION_LABELS[d] }))} value={relative ? 'RELATIVE' : 'ABSOLUTE'} onChange={v => apply({ detection: v as DeEsserDetection })} />
      <Segmented label="Zone traitée" options={(['BELL', 'SHELF'] as DeEsserMode[]).map(m => ({ v: m, ...MODE_LABELS[m] }))} value={params.mode} onChange={v => apply({ mode: v as DeEsserMode })} />
      <Segmented label="Écoute" options={LISTEN_LABELS.map((l, i) => ({ v: String(i), ...l }))} value={String(listen)} onChange={v => apply({ listen: Number(v) })} />
      {listen > 0 && <p className="-mt-3 text-[11px] text-amber-300" role="status">Écoute de contrôle active : repasse sur « Normal » avant d’exporter.</p>}
      {node?.isFallback?.() && <p className="text-[11px] text-red-300">Ce navigateur ne peut pas charger l’effet : il est contourné (aucun traitement).</p>}
    </div>
  );
};

const Segmented: React.FC<{ label: string; options: { v: string; label: string; help: string }[]; value: string; onChange: (v: string) => void }> = ({ label, options, value, onChange }) => (
  <div>
    <div className="text-[11px] font-bold text-slate-300 mb-1">{label}</div>
    <div className="flex bg-black/40 p-1 rounded-xl border border-white/10" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)} title={o.help}
          className={`flex-1 min-h-9 px-1 py-1.5 rounded-lg text-[11px] leading-tight font-bold transition-all ${value === o.v ? 'bg-red-400 text-black shadow' : 'text-slate-300 hover:text-white hover:bg-white/5'}`}>
          {o.label}
        </button>
      ))}
    </div>
  </div>
);

const DeEsserKnob: React.FC<{ label: string; value: number; onChange: (v: number) => void; defaultValue?: number; min: number; max: number; display: string; help?: string; log?: boolean; disabled?: boolean }> = ({ label, value, onChange, defaultValue, min, max, display, help, log, disabled }) => {
  const knob = useKnobInteraction(value, onChange, { min, max, defaultValue, log, disabled });
  const norm = log ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
  const rotation = Math.max(0, Math.min(1, norm)) * 270 - 135;
  return (
    <div className={`flex flex-col items-center gap-2 ${disabled ? 'opacity-40' : ''}`} title={[help, termHelp(label)].filter(Boolean).join(' · ') || undefined}>
      <div {...knob.bind} role="slider" aria-label={label} aria-valuetext={display} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
        className="w-12 h-12 rounded-full bg-[#14161a] border-2 border-white/15 flex items-center justify-center cursor-ns-resize hover:border-red-400/60 transition-all shadow-xl relative">
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full bg-red-400" style={{ transform: `rotate(${rotation}deg) translateY(2px)` }} />
      </div>
      <div className="text-center">
        <span className="block text-[11px] font-bold text-slate-200 mb-1 whitespace-nowrap">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/10"><span className="text-[11px] font-mono font-bold text-white whitespace-nowrap">{display}</span></div>
      </div>
    </div>
  );
};
