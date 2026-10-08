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
import { V21Type, V21_DEFAULTS, V21_SPECS, sanitizeV21 } from './v21Params';
import { scaleIntervals } from '../utils/scales';

/**
 * Code d'un processeur AudioWorklet autour d'un cœur `make(sampleRate)`
 * ({ setParams, process, reset, meters? }).
 *
 * Les réglages automatisables sont des AudioParam (k-rate) : à l'export,
 * l'automation est posée pendant une pause du rendu hors ligne et prise en
 * compte AU BLOC PRÈS, sans dépendre d'un message du port (qui arrive après
 * la reprise du rendu : mesuré, le half-time automatisé était ignoré). Les
 * autres réglages (gamme, tempo) passent par message. `toCore` (autonome,
 * sérialisé) traduit les réglages de l'effet pour le cœur.
 */
type Desc = { name: string; defaultValue: number; minValue: number; maxValue: number };
/**
 * `chord` (Harmoniseur seulement) : AudioParam a-rate « accord en cours »
 * (codé tonique × 4096 + masque, 0 = aucun), programmé d'avance par le moteur
 * sur la piste d'accords, en lecture comme à l'export : lu à l'échantillon
 * près et remis au cœur (`chordIn`), qui le range avec l'entrée.
 */
const processorCode = (name: string, defs: string, make: string, toCore: string, descriptors: Desc[], chord = false) => `
${defs}
const __make = (${make});
const __toCore = (${toCore});
const __desc = ${JSON.stringify([...descriptors.map(d => ({ ...d, automationRate: 'k-rate' })), ...(chord ? [{ name: 'chord', defaultValue: 0, minValue: 0, maxValue: 49151, automationRate: 'a-rate' }] : [])])};
const __names = __desc.filter(d => d.name !== 'chord').map(d => d.name);
class NovaV21Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return __desc; }
  constructor(options) {
    super();
    this.core = __make(sampleRate);
    // Réglages initiaux passés à la construction : un message arriverait trop
    // tard dans un rendu hors ligne (export), qui démarre aussitôt.
    const init = options && options.processorOptions && options.processorOptions.params;
    this.ep = Object.assign({}, init || {});
    this.core.setParams(__toCore(this.ep, sampleRate));
    this.dirty = false;
    this.zero = new Float32Array(128);
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) { Object.assign(this.ep, d.params); this.dirty = true; }
      if (d.reset) this.core.reset();
    };
  }
  process(inputs, outputs, parameters) {
    for (let i = 0; i < __names.length; i++) {
      const a = parameters[__names[i]];
      if (a && a.length) { const v = a[0]; if (this.ep[__names[i]] !== v) { this.ep[__names[i]] = v; this.dirty = true; } }
    }
    if (this.dirty) { this.dirty = false; this.core.setParams(__toCore(this.ep, sampleRate)); }
    if (this.core.chordIn && parameters.chord) this.core.chordIn(parameters.chord);
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
const PSOLA_MAKE = `(sr) => { const c = createPsolaCore(sr, createHarmonyMath()); c.meters = () => ({ pitch: c.pitch(), chord: c.chord() }); return c; }`;

/**
 * Réglages de l'harmoniseur → voix du cœur PSOLA. Autonome (sérialisé dans
 * l'AudioWorklet) : la gamme arrive déjà en intervalles (`_scale`).
 */
export function harmonizerToCore(p: Record<string, any>) {
  const db = (v: any) => (Number.isFinite(+v) && +v > -59.5 ? Math.pow(10, +v / 20) : 0);
  const n = Math.max(1, Math.min(4, Math.round(+p.voices || 1)));
  const hum = Math.max(0, Math.min(1, +p.humanize || 0));
  const preserve = p.preserve === undefined ? true : (+p.preserve >= 0.5 || p.preserve === true);
  const DELAY = [9, 14, 18, 11], DET = [7, -8, 5, -6];
  const voices = [1, 2, 3, 4].map((i, k) => {
    const pan = Math.max(-1, Math.min(1, +p['v' + i + 'Pan'] || 0));
    const th = (pan + 1) * Math.PI / 4;
    const lv = p['v' + i + 'Level'];
    const g = db(lv === undefined ? -6 : lv);
    return {
      on: k < n, semis: 0, degree: Math.round(+p['v' + i + 'Deg'] || 0), formant: +p.formant || 0, follow: !preserve,
      gainL: g * Math.SQRT2 * Math.cos(th), gainR: g * Math.SQRT2 * Math.sin(th),
      delayMs: hum * DELAY[k], detune: hum * DET[k], drift: hum * 10,
    };
  });
  const scale = Array.isArray(p._scale) && p._scale.length ? p._scale : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  // Suivre la piste d'accords : coché par défaut (sans accord posé, la gamme seule).
  const follow = p.followChords === undefined ? true : (+p.followChords >= 0.5 || p.followChords === true);
  return { voices, dry: db(p.dry === undefined ? 0 : p.dry), root: ((Math.round(+p.rootKey || 0) % 12) + 12) % 12, scale, stereo: false, follow };
}

/** Réglages de « Voix grave / aiguë » → une voix stéréo du cœur PSOLA (autonome). */
export function voiceShiftToCore(p: Record<string, any>) {
  const mix = Math.max(0, Math.min(1, p.mix === undefined ? 1 : +p.mix));
  const out = Number.isFinite(+p.output) ? Math.pow(10, +p.output / 20) : 1;
  const link = +p.link >= 0.5 || p.link === true;
  const pitch = +p.pitch || 0;
  return {
    voices: [{ on: true, semis: pitch, degree: null, formant: +p.formant || 0, follow: link, gainL: mix * out, gainR: mix * out, delayMs: 0, detune: 0, drift: 0 }],
    dry: (1 - mix) * out, stereo: true, root: 0, scale: [],
  };
}

export function timeFxToCore(p: Record<string, any>) {
  return { stop: +p.stop || 0, stopBeats: +p.stopBeats || 1, stopCurve: +p.stopCurve || 0, startBeats: +p.startBeats || 0, half: +p.half || 0, halfBeats: +p.halfBeats || 4, stutter: +p.stutter || 0, stutterDiv: +p.stutterDiv || 0.25, bpm: +p.bpm || 120 };
}
export function djFilterToCore(p: Record<string, any>) {
  return { filter: +p.filter || 0, resonance: p.resonance === undefined ? 0.25 : +p.resonance, slope: +p.slope >= 18 ? 24 : 12, output: +p.output || 0 };
}
export function lofiToCore(p: Record<string, any>) {
  return { bits: +p.bits || 16, rate: +p.rate || 48000, lowCut: +p.lowCut || 20, highCut: +p.highCut || 20000, drive: +p.drive || 0, noise: +p.noise || 0, mix: p.mix === undefined ? 1 : +p.mix, output: +p.output || 0 };
}

interface WorkletSpec {
  key: string;
  processor: string;
  code: string;
  /** Noms des AudioParam (réglages automatisables). */
  audioParams: string[];
  /** Latence (échantillons) ; 0 par défaut. */
  latencySamples?: (sr: number) => number;
  /** AudioParam « chord » (accord en cours, piste d'accords). */
  chord?: boolean;
}

const descriptorsOf = (type: V21Type) => {
  const d = V21_DEFAULTS[type]();
  return V21_SPECS[type].map(s => ({ name: s.id, defaultValue: typeof d[s.id] === 'number' ? d[s.id] : s.min, minValue: s.min, maxValue: s.max }));
};

const makeSpec = (type: V21Type, processor: string, defs: string, make: string, toCore: (p: Record<string, any>) => any, latencySamples?: (sr: number) => number, chord = false): WorkletSpec => {
  const desc = descriptorsOf(type);
  // Clé (et nom du processeur) versionnée : un module déjà chargé sous l'ancien code n'est pas réutilisé.
  const proc = chord ? `${processor}-c` : processor;
  return { key: `${proc}-2`, processor: proc, code: processorCode(proc, defs, make, toCore.toString(), desc, chord), audioParams: desc.map(d => d.name), latencySamples, chord };
};

let SPECS: Record<V21Type, WorkletSpec> | null = null;
const specs = (): Record<V21Type, WorkletSpec> => {
  if (!SPECS) SPECS = {
    HARMONIZER: makeSpec('HARMONIZER', 'nova-v21-harmonizer', PSOLA_DEFS, PSOLA_MAKE, harmonizerToCore, psolaLatencySamples, true),
    VOICESHIFT: makeSpec('VOICESHIFT', 'nova-v21-voiceshift', PSOLA_DEFS, PSOLA_MAKE, voiceShiftToCore, psolaLatencySamples),
    TIMEFX: makeSpec('TIMEFX', 'nova-v21-timefx', `const createTimeFxCore = (${createTimeFxCore.toString()});`, `(sr) => { const c = createTimeFxCore(sr); c.meters = () => c.state(); return c; }`, timeFxToCore),
    DJFILTER: makeSpec('DJFILTER', 'nova-v21-djfilter', `const createDjFilterCore = (${createDjFilterCore.toString()});`, `(sr) => { const c = createDjFilterCore(sr); c.meters = () => ({ cutoff: c.cutoffHz() }); return c; }`, djFilterToCore),
    LOFI: makeSpec('LOFI', 'nova-v21-lofi', `const createLofiCore = (${createLofiCore.toString()});`, `(sr) => createLofiCore(sr)`, lofiToCore),
  };
  return SPECS;
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
    this.spec = specs()[type];
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.params = this.withScale({ ...V21_DEFAULTS[type](), ...sanitizeV21(type, params || {}), ...(bpm ? { bpm } : {}) });
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, this.spec.key, this.spec.code);
      const parameterData: Record<string, number> = {};
      for (const k of this.spec.audioParams) if (Number.isFinite(+this.params[k])) parameterData[k] = +this.params[k];
      this.worklet = new AudioWorkletNode(this.ctx, this.spec.processor, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        processorOptions: { params: this.params },
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
    const clean = sanitizeV21(this.type, p);
    this.params = this.withScale({ ...this.params, ...clean });
    if (!this.worklet) return;
    // Réglages automatisables : AudioParam, pris en compte au bloc près (lecture ET export).
    const msg: Record<string, any> = {};
    for (const [k, v] of Object.entries(clean)) {
      const ap = this.spec.audioParams.includes(k) ? (this.worklet.parameters as any).get(k) as AudioParam | undefined : undefined;
      if (ap && typeof v === 'number') { try { ap.setValueAtTime(v, this.ctx.currentTime); } catch { ap.value = v; } }
      else msg[k] = v;
    }
    if ('scale' in clean) msg._scale = this.params._scale;
    if (Object.keys(msg).length) this.worklet.port.postMessage({ params: msg });
  }

  /** La gamme (texte) est traduite ici en intervalles pour le cœur. */
  private withScale(p: Record<string, any>) {
    if (this.type === 'HARMONIZER') p._scale = scaleIntervals(p.scale);
    return p;
  }

  public getParams() { const { _scale, ...rest } = this.params; return rest; }

  /**
   * AudioParam « accord en cours » (Harmoniseur ; null sinon ou tant que
   * l'AudioWorklet n'est pas prêt). Le moteur y programme la piste d'accords
   * d'avance (encodeChord), en avance de la latence comme l'automation.
   */
  public chordParam(): AudioParam | null {
    if (!this.spec.chord || !this.worklet) return null;
    return ((this.worklet.parameters as any).get('chord') as AudioParam | undefined) || null;
  }

  /** Vrai : l'harmoniseur suit la piste d'accords (réglage « Suivre la piste d'accords », coché par défaut). */
  public followsChords(): boolean {
    const f = this.params.followChords;
    return this.spec.chord === true && (f === undefined || f === true || +f >= 0.5);
  }

  /** Mesures récentes (hauteur détectée, vitesse de bande, coupure) ; vides après 0,5 s sans nouvelles. */
  public getMeters(): any { return Date.now() - this.metersAt > 500 ? {} : this.meters; }

  public isFallback() { return this.failed; }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
    try { this.worklet?.disconnect(); } catch { /* idem */ }
    try { this.output.disconnect(); } catch { /* idem */ }
  }
}
