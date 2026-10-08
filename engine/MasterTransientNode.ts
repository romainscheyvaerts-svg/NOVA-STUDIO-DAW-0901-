/**
 * Effet NOVA « Mastering Transient » : enveloppe AudioWorklet du cœur
 * `masterTransientCore.ts` (+ limiteur large bande final `limiterCore.ts`),
 * même code en lecture et à l'export (OfflineAudioContext).
 *
 * - Réglages automatisables (emphase, adaptatif, gain du limiteur, plafond,
 *   clipper, sortie) : AudioParam k-rate, lus à chaque bloc ; les autres
 *   (courbe par bande, vitesse…) passent par message et à la construction.
 * - Latence fixe (banc de filtres + anticipation + limiteur final), déclarée
 *   au PDC par `latency` (s).
 * - Mesures (~30 fois par seconde) : emphase et réduction max, par bande.
 */
import { createMasterTransientCore } from './masterTransientCore';
import { createLimiterCore } from './limiterCore';
import { MASTER_TRANSIENT_PROFILE } from './masterTransientProfile';
import { MT_DEFAULTS, MT_SPECS, mtToCore, sanitizeMt } from './masterTransientParams';
import { loadWorkletModule } from '../plugins/vocalDspUtils';
import { retireWorkletNode } from './workletGuard';

const AP = MT_SPECS.filter(s => s.auto).map(s => ({ name: s.id, defaultValue: MT_DEFAULTS[s.id] ?? s.min }));

const WORKLET_CODE = `
const createLimiterCore = (${createLimiterCore.toString()});
const createMasterTransientCore = (${createMasterTransientCore.toString()});
const mtToCore = (${mtToCore.toString()});
const __ap = ${JSON.stringify(AP)};
class NovaMasterTransientProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __ap.map(d => ({ name: d.name, minValue: -1e4, maxValue: 1e4, defaultValue: d.defaultValue, automationRate: 'k-rate' }));
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.params = Object.assign({}, o.params || {});
    this.core = createMasterTransientCore(sampleRate, o.profile, createLimiterCore);
    this.last = __ap.map(() => NaN);
    this.dirty = true;
    this.zero = new Float32Array(128);
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) { Object.assign(this.params, d.params); this.dirty = true; }
      if (d.reset) this.core.reset();
    };
  }
  process(inputs, outputs, parameters) {
    for (let i = 0; i < __ap.length; i++) {
      const a = parameters[__ap[i].name];
      const v = a && a.length ? a[0] : NaN;
      if (v === v && v !== this.last[i]) { this.last[i] = v; this.params[__ap[i].name] = v; this.dirty = true; }
    }
    if (this.dirty) { this.dirty = false; try { this.core.setParams(mtToCore(this.params)); } catch (e) {} }
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : this.zero;
    const iR = inp && inp[1] ? inp[1] : iL;
    this.core.process(iL, iR, out[0], out[1] || null, n);
    if (++this.blocks >= 12) { this.blocks = 0; this.port.postMessage(this.core.takeMeters()); }
    return true;
  }
}
try { registerProcessor('nova-master-transient-v1', NovaMasterTransientProcessor); } catch (e) {}
`;

export interface MtMeters { emphDb: number; grDb: number; inPeakDb: number; outPeakDb: number; bandEmphDb: number[]; bandGrDb: number[] }

const EMPTY: MtMeters = { emphDb: 0, grDb: 0, inPeakDb: -120, outPeakDb: -120, bandEmphDb: new Array(26).fill(0), bandGrDb: new Array(26).fill(0) };

/** Latence (échantillons) à une fréquence donnée, sans créer de nœud (même calcul que le cœur). */
export function masterTransientLatencySamples(sampleRate: number): number {
  const core = createMasterTransientCore(sampleRate, MASTER_TRANSIENT_PROFILE as any, createLimiterCore);
  return core.latencySamples();
}

export class MasterTransientNode {
  public input: GainNode;
  public output: GainNode;
  public readonly ready: Promise<void>;
  private ctx: BaseAudioContext;
  private worklet: AudioWorkletNode | null = null;
  private params: Record<string, number>;
  private meters: MtMeters & { at: number } = { ...EMPTY, at: 0 };
  private failed = false;
  private latSamples: number;
  /** Effet retiré : un worklet encore en chargement n'est pas créé (sinon il restait vivant). */
  private disposed = false;

  constructor(ctx: BaseAudioContext, params?: Record<string, any>) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.params = { ...MT_DEFAULTS, ...sanitizeMt(params || {}) };
    this.latSamples = masterTransientLatencySamples(ctx.sampleRate);
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, 'nova-master-transient-v1', WORKLET_CODE);
      if (this.disposed) return;
      const parameterData: Record<string, number> = {};
      for (const a of AP) parameterData[a.name] = +this.params[a.name];
      this.worklet = new AudioWorkletNode(this.ctx, 'nova-master-transient-v1', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        // Réglages et profil passés à la construction : un message arriverait trop tard à l'export.
        processorOptions: { profile: MASTER_TRANSIENT_PROFILE, params: { ...this.params } },
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.emphDb)) this.meters = { ...(d as MtMeters), at: Date.now() };
      };
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
    } catch (e) {
      console.warn('[NOVA Mastering Transient] AudioWorklet indisponible, effet contourné :', e);
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  /** Retard ajouté (s), compensé par le moteur (PDC). */
  public get latency(): number { return this.failed ? 0 : this.latSamples / this.ctx.sampleRate; }

  public updateParams(p: Record<string, any>) {
    if (!p) return;
    const clean = sanitizeMt(p);
    this.params = { ...this.params, ...clean };
    if (!this.worklet) return;
    const msg: Record<string, number> = {};
    const auto = new Set(AP.map(a => a.name));
    for (const [k, v] of Object.entries(clean)) {
      const ap = auto.has(k) ? (this.worklet.parameters as any).get(k) as AudioParam | undefined : undefined;
      if (ap) { try { ap.setValueAtTime(v, this.ctx.currentTime); } catch { ap.value = v; } }
      else msg[k] = v;
    }
    if (Object.keys(msg).length) this.worklet.port.postMessage({ params: msg });
  }

  public getParams() { return { ...this.params }; }

  /** AudioParam d'un réglage automatisable, sinon null. */
  public automationParam(key: string): AudioParam | null {
    if (!this.worklet || !AP.some(a => a.name === key)) return null;
    return (this.worklet.parameters as any).get(key) ?? null;
  }

  /** Mesures récentes ; remises à zéro après 0,5 s sans nouvelles. */
  public getMeters(): MtMeters {
    if (Date.now() - this.meters.at > 500) return EMPTY;
    const { at: _a, ...m } = this.meters;
    return m;
  }

  public isFallback() { return this.failed; }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
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
