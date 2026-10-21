/**
 * Enveloppe AudioWorklet du cœur « pro » de l'égaliseur 12 bandes (engine/eqLinearCore.ts) :
 * Mid / Side par bande et phase linéaire. Même code en lecture et à l'export (OfflineAudioContext).
 *
 * Utilisée par `ProEQ12Node` (plugins/ProEQ12Plugin.tsx) seulement quand une bande est hors
 * stéréo ou que la phase linéaire est choisie : sinon aucun worklet n'existe (rien à calculer).
 *
 * - Fréquence, gain et Q de chaque bande : AudioParam k-rate (« b3Freq », « b3Gain », « b3Q »),
 *   pilotés par les mêmes réglages automatisables que les filtres de l'égaliseur classique ;
 * - le reste (type, canal, marche, solo, phase, résolution) : à la construction puis par message ;
 * - veille des effets : le cœur dit quand il est au repos ; au réveil il rattrape les blocs sautés ;
 * - départ de lecture (`resetAt`) : le cœur repart de l'état d'une instance neuve (= l'export).
 */
import { createEqProCore, eqLinearLatencySamples, eqProNeeded, type EqProParams } from './eqLinearCore';
import { loadWorkletModule } from '../plugins/vocalDspUtils';
import { retireWorkletNode } from './workletGuard';
import { blockClockSource } from './blockClock';

const PROC = 'nova-eqpro-v1';
const NB = 12;
const AP_NAMES: string[] = [];
for (let b = 1; b <= NB; b++) AP_NAMES.push(`b${b}Freq`, `b${b}Gain`, `b${b}Q`);

const WORKLET_CODE = `${blockClockSource()}const createEqProCore = (${createEqProCore.toString()});
const __ap = ${JSON.stringify(AP_NAMES)};
class NovaEqProProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __ap.map(n => ({ name: n, minValue: -1e6, maxValue: 1e6, defaultValue: /Freq$/.test(n) ? 1000 : /Q$/.test(n) ? 1 : 0, automationRate: 'k-rate' }))
      .concat([{ name: '__resetGen', minValue: 0, maxValue: 1e9, defaultValue: 0, automationRate: 'k-rate' }]);
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.core = createEqProCore(sampleRate);
    this.core.setParams(o.params || {});
    this.last = new Float64Array(__ap.length).fill(NaN);
    this.clock = { next: -1 };
    this.zero = new Float32Array(128);
    this.gen = 0;
    this.rest = undefined;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) {
        this.core.setParams(d.params);
        // Les AudioParam restent la référence de fréquence / gain / Q (automation) : relus au bloc suivant.
        this.last.fill(NaN);
      }
    };
  }
  process(inputs, outputs, parameters) {
    const skipped = framesSkipped(this.clock, currentFrame, 128);
    if (skipped > 0) this.core.catchUp(skipped);
    if (parameters.__resetGen && parameters.__resetGen[0] !== this.gen) { this.gen = parameters.__resetGen[0]; this.core.reset(); }
    for (let i = 0; i < __ap.length; i++) {
      const a = parameters[__ap[i]];
      const v = a && a.length ? a[0] : NaN;
      if (v === v && v !== this.last[i]) { this.last[i] = v; this.core.setAuto(i, v); }
    }
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : this.zero;
    const iR = inp && inp[1] ? inp[1] : null;
    this.core.process(iL, iR, out[0], out[1] || null, n);
    const rest = this.core.atRest();
    if (rest !== this.rest) { this.rest = rest; this.port.postMessage({ rest }); }
    return true;
  }
}
try { registerProcessor('${PROC}', NovaEqProProcessor); } catch (e) {}
`;

/** Réglages envoyés au cœur (structure + valeurs fixes). */
export function eqProCoreParams(p: Record<string, any>): EqProParams {
  return {
    bands: (p.bands || []).map((b: any) => ({ type: b?.type, frequency: b?.frequency, gain: b?.gain, q: b?.q, isEnabled: b?.isEnabled, isSolo: b?.isSolo, channel: b?.channel })),
    isEnabled: p.isEnabled,
    phase: p.phase === 'linear' ? 'linear' : 'minimum',
    linQuality: p.linQuality === 'haute' ? 'haute' : 'normale',
  };
}

export { eqProNeeded, eqLinearLatencySamples };

export class EqProWorklet {
  public node: AudioWorkletNode | null = null;
  public readonly ready: Promise<void>;
  public failed = false;
  private disposed = false;
  private atRest = false;
  private resetCount = 0;
  private lastSent = '';

  constructor(private ctx: BaseAudioContext, params: Record<string, any>, values: number[]) {
    this.ready = this.init(params, values);
  }

  private async init(params: Record<string, any>, values: number[]) {
    try {
      await loadWorkletModule(this.ctx, PROC, WORKLET_CODE);
      if (this.disposed) return;
      const parameterData: Record<string, number> = {};
      AP_NAMES.forEach((n, i) => { if (Number.isFinite(values[i])) parameterData[n] = values[i]; });
      const cp = eqProCoreParams(params);
      this.lastSent = JSON.stringify(cp);
      this.node = new AudioWorkletNode(this.ctx, PROC, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        // Réglages passés à la construction : un message arriverait trop tard à l'export.
        processorOptions: { params: cp },
      });
      this.node.port.onmessage = (e) => { const d = e.data || {}; if (typeof d.rest === 'boolean') this.atRest = d.rest; };
    } catch (e) {
      console.warn('[NOVA Égaliseur] AudioWorklet indisponible : Mid / Side et phase linéaire contournés.', e);
      this.failed = true;
    }
  }

  /** AudioParam k-rate d'un réglage de bande (« b3Gain »…), ou null. */
  public param(key: string): AudioParam | null {
    if (!this.node) return null;
    return ((this.node.parameters as any).get(key) as AudioParam | undefined) ?? null;
  }

  /** Structure changée (type, canal, marche, phase…) : envoyée seulement si elle a bougé. */
  public send(params: Record<string, any>) {
    if (!this.node) return;
    const cp = eqProCoreParams(params);
    const s = JSON.stringify(cp);
    if (s === this.lastSent) return;
    this.lastSent = s;
    this.node.port.postMessage({ params: cp });
  }

  public resetAt(at: number) {
    const ap = this.param('__resetGen');
    if (!ap) return;
    try { ap.setValueAtTime(++this.resetCount, Math.max(this.ctx.currentTime, at - 0.5 / this.ctx.sampleRate)); } catch { /* contexte fermé */ }
  }

  public isAtRest() { return !!this.node && !this.failed && this.atRest; }

  public dispose() {
    this.disposed = true;
    if (this.node) { try { this.node.disconnect(); } catch { /* */ } retireWorkletNode(this.node); this.node = null; }
  }
}

/** Noms des AudioParam du processeur, dans l'ordre du cœur (bande × 3 + champ). */
export const EQ_PRO_PARAM_NAMES = AP_NAMES;
