/**
 * Limiteur / maximiseur NOVA (V15) : enveloppe AudioWorklet du noyau
 * `limiterCore.ts`, même code en lecture et à l'export (OfflineAudioContext).
 *
 * Latence = anticipation + filtre de détection, déclarée par `latency` (s) :
 * le moteur la compense (PDC) comme celle d'un plugin VST.
 */
import { createLimiterCore, limiterLatencySamples } from './limiterCore';
import { loadWorkletModule } from '../plugins/vocalDspUtils';

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

const WORKLET_CODE = `
const createLimiterCore = (${createLimiterCore.toString()});
class NovaLimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.core = createLimiterCore(sampleRate);
    // Réglages initiaux passés à la construction : un message arriverait trop
    // tard dans un rendu hors ligne (export), qui démarre aussitôt.
    const init = options && options.processorOptions && options.processorOptions.params;
    if (init) this.core.setParams(init);
    this.zero = new Float32Array(128);
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) this.core.setParams(d.params);
      if (d.reset) this.core.reset();
    };
  }
  process(inputs, outputs) {
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
try { registerProcessor('nova-limiter-processor', NovaLimiterProcessor); } catch (e) {}
`;

const toCore = (p: LimiterParams) => ({
  ceilingDb: p.ceiling, inputGainDb: p.inputGain, releaseMs: p.release, lookaheadMs: p.lookahead, oversample: p.oversample,
});

export class LimiterNode {
  public input: GainNode;
  public output: GainNode;
  public readonly ready: Promise<void>;
  private ctx: BaseAudioContext;
  private worklet: AudioWorkletNode | null = null;
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
      await loadWorkletModule(this.ctx, 'nova-limiter-v2', WORKLET_CODE);
      this.worklet = new AudioWorkletNode(this.ctx, 'nova-limiter-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { params: toCore(this.params) },
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.grDb)) this.meters = { grDb: d.grDb, outPeakDb: d.outPeakDb, inPeakDb: d.inPeakDb, at: Date.now() };
      };
      this.worklet.port.postMessage({ params: toCore(this.params) });
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
    } catch (e) {
      // Sans AudioWorklet : passe-plat (aucune latence annoncée), et on le dit.
      console.warn('[Limiteur NOVA] AudioWorklet indisponible, effet contourné :', e);
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  /** Retard ajouté (s), compensé par le moteur (PDC). */
  public get latency(): number {
    if (this.failed) return 0;
    return limiterLatencySamples(this.ctx.sampleRate, this.params.lookahead) / this.ctx.sampleRate;
  }

  public updateParams(p: Partial<LimiterParams> & Record<string, any>) {
    this.params = { ...this.params, ...sanitize(p) };
    this.worklet?.port.postMessage({ params: toCore(this.params) });
  }

  public getParams(): LimiterParams { return { ...this.params }; }

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
