/**
 * Limiteur / maximiseur NOVA (V15) : enveloppe AudioWorklet du noyau
 * `limiterCore.ts`, même code en lecture et à l'export (OfflineAudioContext).
 *
 * Latence = anticipation + filtre de détection, déclarée par `latency` (s) :
 * le moteur la compense (PDC) comme celle d'un plugin VST.
 *
 * Réglages automatisables (plafond, gain d'entrée, relâchement) : AudioParam
 * k-rate du worklet, lus à chaque bloc de 128 échantillons, en lecture comme
 * à l'export. À l'export, l'automation est posée pendant une pause du rendu
 * hors ligne ; un message du port arrivait, lui, après la reprise du rendu
 * (mesuré : un plafond automatisé de −1 à −8 dBTP restait à −1, un
 * relâchement automatisé était ignoré). L'anticipation et le
 * suréchantillonnage (qui fixent la latence déclarée au PDC) ne sont pas
 * automatisables et passent par message.
 */
import { createLimiterCore, limiterLatencySamples } from './limiterCore';
import { loadWorkletModule } from '../plugins/vocalDspUtils';
import { retireWorkletNode } from './workletGuard';

export interface LimiterParams {
  /** Plafond de sortie (dBTP). */
  ceiling: number;
  /** Gain d'entrée (dB). */
  inputGain: number;
  /** Relâchement (ms). */
  release: number;
  /** Anticipation (ms). */
  lookahead: number;
  /** Suréchantillonnage de la détection : 1, 2, 4 ou 8. */
  oversample: number;
  isEnabled: boolean;
}

export const DEFAULT_LIMITER_PARAMS: LimiterParams = { ceiling: -1, inputGain: 0, release: 100, lookahead: 3, oversample: 4, isEnabled: true };

/** Réglages automatisables : nom de l'AudioParam (= clé des réglages) → clé du cœur, bornes. */
export const LIMITER_AUDIO_PARAMS = [
  { name: 'ceiling', core: 'ceilingDb', minValue: -12, maxValue: 0, defaultValue: DEFAULT_LIMITER_PARAMS.ceiling },
  { name: 'inputGain', core: 'inputGainDb', minValue: -12, maxValue: 30, defaultValue: DEFAULT_LIMITER_PARAMS.inputGain },
  { name: 'release', core: 'releaseMs', minValue: 5, maxValue: 2000, defaultValue: DEFAULT_LIMITER_PARAMS.release },
] as const;

/** Liste de l'éditeur d'automation (registre des effets). */
export const LIMITER_AUTOMATABLE = [
  { id: 'ceiling', label: 'Plafond', min: -12, max: 0, unit: 'dBTP' },
  { id: 'inputGain', label: "Gain d'entrée", min: -12, max: 30, unit: 'dB' },
  { id: 'release', label: 'Relâchement', min: 5, max: 2000, unit: 'ms' },
];

const WORKLET_CODE = `
const createLimiterCore = (${createLimiterCore.toString()});
const __ap = ${JSON.stringify(LIMITER_AUDIO_PARAMS.map(a => ({ name: a.name, core: a.core })))};
class NovaLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ${JSON.stringify(LIMITER_AUDIO_PARAMS.map(({ core: _c, ...d }) => ({ ...d, automationRate: 'k-rate' })))};
  }
  constructor(options) {
    super();
    this.core = createLimiterCore(sampleRate);
    // Réglages initiaux passés à la construction : un message arriverait trop
    // tard dans un rendu hors ligne (export), qui démarre aussitôt.
    const init = options && options.processorOptions && options.processorOptions.params;
    if (init) this.core.setParams(init);
    this.last = __ap.map(() => NaN);
    this.patch = {};
    this.zero = new Float32Array(128);
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) this.core.setParams(d.params);
      if (d.reset) this.core.reset();
    };
  }
  process(inputs, outputs, parameters) {
    // Réglages automatisables : lus au bloc près (lecture ET export).
    let changed = false;
    for (let i = 0; i < __ap.length; i++) {
      const a = parameters[__ap[i].name];
      const v = a && a.length ? a[0] : NaN;
      if (v === v && v !== this.last[i]) { this.last[i] = v; this.patch[__ap[i].core] = v; changed = true; }
    }
    if (changed) this.core.setParams(this.patch);
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : this.zero;
    const iR = inp && inp[1] ? inp[1] : iL;
    this.core.process(iL, iR, out[0], out[1] || null, n);
    if (++this.blocks >= 12) {
      this.blocks = 0;
      this.port.postMessage(this.core.takeMeters());
    }
    return true;
  }
}
try { registerProcessor('nova-limiter-processor-v3', NovaLimiterProcessor); } catch (e) {}
`;

const toCore = (p: LimiterParams) => ({
  ceilingDb: p.ceiling, inputGainDb: p.inputGain, releaseMs: p.release, lookaheadMs: p.lookahead, oversample: p.oversample,
});
/** Réglages non automatisables (latence, structure) : seuls à passer par message. */
const structuralToCore = (p: LimiterParams) => ({ lookaheadMs: p.lookahead, oversample: p.oversample });

export class LimiterNode {
  public input: GainNode;
  public output: GainNode;
  public readonly ready: Promise<void>;
  private ctx: BaseAudioContext;
  private worklet: AudioWorkletNode | null = null;
  /** Limiteur retiré : un worklet encore en chargement n'est pas créé (sinon il restait vivant). */
  private disposed = false;
  private params: LimiterParams = { ...DEFAULT_LIMITER_PARAMS };
  private meters = { grDb: 0, outPeakDb: -120, inPeakDb: -120, at: 0 };
  private failed = false;

  constructor(ctx: BaseAudioContext, params?: Partial<LimiterParams>) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    if (params) this.params = { ...this.params, ...sanitize(params) };
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, 'nova-limiter-v3', WORKLET_CODE);
      if (this.disposed) return;
      const parameterData: Record<string, number> = {};
      for (const a of LIMITER_AUDIO_PARAMS) parameterData[a.name] = this.params[a.name];
      this.worklet = new AudioWorkletNode(this.ctx, 'nova-limiter-processor-v3', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        processorOptions: { params: toCore(this.params) },
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.grDb)) this.meters = { grDb: d.grDb, outPeakDb: d.outPeakDb, inPeakDb: d.inPeakDb, at: Date.now() };
      };
      // Réglages reçus pendant le chargement du module : déjà dans parameterData / processorOptions.
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
    } catch (e) {
      // Sans AudioWorklet : passe-plat (aucune latence annoncée), et on le dit.
      console.warn('[Limiteur NOVA] AudioWorklet indisponible, effet contourné :', e);
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  /** Limiteur retiré : worklet mis à la retraite (ou jamais créé s'il chargeait encore). */
  public dispose() {
    this.disposed = true;
    if (this.worklet) { retireWorkletNode(this.worklet); this.worklet = null; }
    try { this.input.disconnect(); } catch (e) { /* */ }
  }

  /** Retard ajouté (s), compensé par le moteur (PDC). */
  public get latency(): number {
    if (this.failed) return 0;
    return limiterLatencySamples(this.ctx.sampleRate, this.params.lookahead) / this.ctx.sampleRate;
  }

  public updateParams(p: Partial<LimiterParams> & Record<string, any>) {
    const clean = sanitize(p);
    this.params = { ...this.params, ...clean };
    if (!this.worklet) return;
    // Automatisables : AudioParam, pris en compte au bloc près (lecture ET export).
    for (const a of LIMITER_AUDIO_PARAMS) {
      const v = clean[a.name];
      if (v === undefined) continue;
      const ap = this.worklet.parameters.get(a.name);
      if (!ap) continue;
      try { ap.setValueAtTime(v, this.ctx.currentTime); } catch { ap.value = v; }
    }
    if (clean.lookahead !== undefined || clean.oversample !== undefined) {
      this.worklet.port.postMessage({ params: structuralToCore(this.params) });
    }
  }

  public getParams(): LimiterParams { return { ...this.params }; }

  /** AudioParam d'un réglage automatisable (l'export y programme toute la voie d'automation), sinon null. */
  public automationParam(key: string): AudioParam | null {
    if (!this.worklet || !LIMITER_AUDIO_PARAMS.some(a => a.name === key)) return null;
    return this.worklet.parameters.get(key) ?? null;
  }

  /** Mesures récentes (réduction de gain, crêtes) ; remises à zéro après 0,5 s sans nouvelles. */
  public getMeters() {
    if (Date.now() - this.meters.at > 500) return { grDb: 0, outPeakDb: -120, inPeakDb: -120 };
    return { grDb: this.meters.grDb, outPeakDb: this.meters.outPeakDb, inPeakDb: this.meters.inPeakDb };
  }

  public isFallback() { return this.failed; }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
    try { this.worklet?.disconnect(); } catch { /* idem */ }
    try { this.output.disconnect(); } catch { /* idem */ }
  }
}

function sanitize(p: Partial<LimiterParams> & Record<string, any>): Partial<LimiterParams> {
  const out: Partial<LimiterParams> = {};
  const num = (v: any, lo: number, hi: number) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : undefined);
  if (p.ceiling !== undefined) { const v = num(p.ceiling, -12, 0); if (v !== undefined) out.ceiling = v; }
  if (p.inputGain !== undefined) { const v = num(p.inputGain, -12, 30); if (v !== undefined) out.inputGain = v; }
  if (p.release !== undefined) { const v = num(p.release, 5, 2000); if (v !== undefined) out.release = v; }
  if (p.lookahead !== undefined) { const v = num(p.lookahead, 0.5, 10); if (v !== undefined) out.lookahead = v; }
  if (p.oversample !== undefined) { const v = Math.round(+p.oversample); out.oversample = v >= 8 ? 8 : v >= 4 ? 4 : v >= 2 ? 2 : 1; }
  if (p.isEnabled !== undefined) out.isEnabled = !!p.isEnabled;
  return out;
}
