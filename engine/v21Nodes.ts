/**
 * Nœuds audio des effets V21 (Harmoniseur, Voix grave / aiguë, Tape stop &
 * half-time, Filtre DJ, Lo-fi). Chacun enveloppe un cœur DSP en JavaScript
 * pur (psolaCore, timeFxCore, colorFxCore) dans un AudioWorklet : même code
 * en lecture et à l'export (OfflineAudioContext). Sans AudioWorklet, l'effet
 * est contourné (passe-plat, aucune latence annoncée) et la fenêtre le dit.
 *
 * Latence exacte déclarée par `latency` (s) : le moteur la compense (PDC).
 */
import { createPsolaCore, createHarmonyMath, psolaLatencySamples } from './psolaCore';
import { createTimeFxCore } from './timeFxCore';
import { createDjFilterCore, createLofiCore } from './colorFxCore';
import { loadWorkletModule } from '../plugins/vocalDspUtils';
import { V21Type, V21_DEFAULTS, sanitizeV21 } from './v21Params';
import { scaleIntervals } from '../utils/scales';

/** Code d'un processeur AudioWorklet autour d'un cœur `make(sampleRate)` ({ setParams, process, reset, meters? }). */
const processorCode = (name: string, defs: string, make: string) => `
${defs}
const __make = (${make});
class NovaV21Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.core = __make(sampleRate);
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
    if (this.core.meters && ++this.blocks >= 12) { this.blocks = 0; this.port.postMessage(this.core.meters()); }
    return true;
  }
}
try { registerProcessor('${name}', NovaV21Processor); } catch (e) {}
`;

const PSOLA_DEFS = `const createHarmonyMath = (${createHarmonyMath.toString()});\nconst createPsolaCore = (${createPsolaCore.toString()});`;
const PSOLA_MAKE = `(sr) => { const c = createPsolaCore(sr, createHarmonyMath()); c.meters = () => ({ pitch: c.pitch() }); return c; }`;

interface WorkletSpec {
  type: V21Type;
  key: string;
  processor: string;
  code: string;
  /** Réglages de l'effet → réglages du cœur. */
  toCore: (p: Record<string, any>, sr: number) => Record<string, any>;
  /** Latence (échantillons) ; 0 par défaut. */
  latencySamples?: (sr: number) => number;
}

const db = (v: any, floor = -59.5) => (Number.isFinite(+v) && +v > floor ? Math.pow(10, +v / 20) : 0);
const on = (v: any) => +v >= 0.5 || v === true;

/** Réglages de l'harmoniseur → voix du cœur PSOLA. */
export function harmonizerToCore(p: Record<string, any>) {
  const n = Math.max(1, Math.min(4, Math.round(+p.voices || 1)));
  const hum = Math.max(0, Math.min(1, +p.humanize || 0));
  const DELAY = [9, 14, 18, 11], DET = [7, -8, 5, -6];
  const voices = [1, 2, 3, 4].map((i, k) => {
    const pan = Math.max(-1, Math.min(1, +p[`v${i}Pan`] || 0));
    const th = (pan + 1) * Math.PI / 4;
    const g = db(p[`v${i}Level`] ?? -6);
    return {
      on: k < n, semis: 0, degree: Math.round(+p[`v${i}Deg`] || 0), formant: +p.formant || 0, follow: !on(p.preserve ?? 1),
      gainL: g * Math.SQRT2 * Math.cos(th), gainR: g * Math.SQRT2 * Math.sin(th),
      delayMs: hum * DELAY[k], detune: hum * DET[k], drift: hum * 10,
    };
  });
  return { voices, dry: db(p.dry ?? 0), root: ((Math.round(+p.rootKey || 0) % 12) + 12) % 12, scale: scaleIntervals(p.scale), stereo: false };
}

/** Réglages de « Voix grave / aiguë » → une voix stéréo du cœur PSOLA. */
export function voiceShiftToCore(p: Record<string, any>) {
  const mix = Math.max(0, Math.min(1, p.mix ?? 1));
  const out = db(p.output ?? 0);
  const link = on(p.link);
  const pitch = +p.pitch || 0;
  return {
    voices: [{ on: true, semis: pitch, degree: null, formant: +p.formant || 0, follow: link, gainL: mix * out, gainR: mix * out, delayMs: 0, detune: 0, drift: 0 }],
    dry: (1 - mix) * out, stereo: true, root: 0, scale: [],
  };
}

const SPECS: Record<V21Type, WorkletSpec> = {
  HARMONIZER: { type: 'HARMONIZER', key: 'nova-v21-psola-1', processor: 'nova-v21-psola', code: processorCode('nova-v21-psola', PSOLA_DEFS, PSOLA_MAKE), toCore: harmonizerToCore, latencySamples: psolaLatencySamples },
  VOICESHIFT: { type: 'VOICESHIFT', key: 'nova-v21-psola-1', processor: 'nova-v21-psola', code: processorCode('nova-v21-psola', PSOLA_DEFS, PSOLA_MAKE), toCore: voiceShiftToCore, latencySamples: psolaLatencySamples },
  TIMEFX: {
    type: 'TIMEFX', key: 'nova-v21-timefx-1', processor: 'nova-v21-timefx',
    code: processorCode('nova-v21-timefx', `const createTimeFxCore = (${createTimeFxCore.toString()});`, `(sr) => { const c = createTimeFxCore(sr); c.meters = () => c.state(); return c; }`),
    toCore: p => ({ stop: +p.stop || 0, stopBeats: +p.stopBeats || 1, stopCurve: +p.stopCurve || 0, startBeats: +p.startBeats || 0, half: +p.half || 0, halfBeats: +p.halfBeats || 4, stutter: +p.stutter || 0, stutterDiv: +p.stutterDiv || 0.25, bpm: +p.bpm || 120 }),
  },
  DJFILTER: {
    type: 'DJFILTER', key: 'nova-v21-djfilter-1', processor: 'nova-v21-djfilter',
    code: processorCode('nova-v21-djfilter', `const createDjFilterCore = (${createDjFilterCore.toString()});`, `(sr) => { const c = createDjFilterCore(sr); c.meters = () => ({ cutoff: c.cutoffHz() }); return c; }`),
    toCore: p => ({ filter: +p.filter || 0, resonance: +(p.resonance ?? 0.25), slope: +p.slope >= 18 ? 24 : 12, output: +p.output || 0 }),
  },
  LOFI: {
    type: 'LOFI', key: 'nova-v21-lofi-1', processor: 'nova-v21-lofi',
    code: processorCode('nova-v21-lofi', `const createLofiCore = (${createLofiCore.toString()});`, `(sr) => createLofiCore(sr)`),
    toCore: p => ({ bits: +p.bits || 16, rate: +p.rate || 48000, lowCut: +p.lowCut || 20, highCut: +p.highCut || 20000, drive: +p.drive || 0, noise: +p.noise || 0, mix: +(p.mix ?? 1), output: +p.output || 0 }),
  },
};

export class V21EffectNode {
  public input: GainNode;
  public output: GainNode;
  public readonly ready: Promise<void>;
  public readonly type: V21Type;
  private ctx: BaseAudioContext;
  private spec: WorkletSpec;
  private worklet: AudioWorkletNode | null = null;
  private params: Record<string, any>;
  private meters: any = {};
  private metersAt = 0;
  private failed = false;

  constructor(ctx: BaseAudioContext, type: V21Type, params?: Record<string, any>, bpm?: number) {
    this.ctx = ctx;
    this.type = type;
    this.spec = SPECS[type];
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.params = { ...V21_DEFAULTS[type](), ...sanitizeV21(type, params || {}), ...(bpm ? { bpm } : {}) };
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, this.spec.key, this.spec.code);
      this.worklet = new AudioWorkletNode(this.ctx, this.spec.processor, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { params: this.spec.toCore(this.params, this.ctx.sampleRate) },
      });
      this.worklet.port.onmessage = (e) => { this.meters = e.data || {}; this.metersAt = Date.now(); };
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
    } catch (e) {
      console.warn(`[NOVA ${this.type}] AudioWorklet indisponible, effet contourné :`, e);
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  /** Retard ajouté (s), compensé par le moteur (PDC). Toujours le même, quels que soient les réglages. */
  public get latency(): number {
    if (this.failed || !this.spec.latencySamples) return 0;
    return this.spec.latencySamples(this.ctx.sampleRate) / this.ctx.sampleRate;
  }

  public updateParams(p: Record<string, any>) {
    if (!p) return;
    this.params = { ...this.params, ...sanitizeV21(this.type, p) };
    this.worklet?.port.postMessage({ params: this.spec.toCore(this.params, this.ctx.sampleRate) });
  }

  public getParams() { return { ...this.params }; }

  /** Mesures récentes (hauteur détectée, vitesse de bande, coupure) ; vides après 0,5 s sans nouvelles. */
  public getMeters(): any { return Date.now() - this.metersAt > 500 ? {} : this.meters; }

  public isFallback() { return this.failed; }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
    try { this.worklet?.disconnect(); } catch { /* idem */ }
    try { this.output.disconnect(); } catch { /* idem */ }
  }
}
