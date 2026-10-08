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
import { createGateCore } from './gateCore';
import { createNoiseGateCore } from './noiseGateCore';
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
type Desc = { name: string; defaultValue: number; minValue: number; maxValue: number; int?: boolean };
/**
 * `chord` (Harmoniseur seulement) : AudioParam a-rate « accord en cours »
 * (codé tonique × 4096 + masque, 0 = aucun), programmé d'avance par le moteur
 * sur la piste d'accords, en lecture comme à l'export : lu à l'échantillon
 * près et remis au cœur (`chordIn`), qui le range avec l'entrée.
 */
const processorCode = (name: string, defs: string, make: string, toCore: string, descriptors: Desc[], chord = false, key = false) => `
${defs}
const __make = (${make});
const __toCore = (${toCore});
const __desc = ${JSON.stringify([...descriptors.map(d => ({ ...d, automationRate: 'k-rate' })), ...(chord ? [{ name: 'chord', defaultValue: 0, minValue: 0, maxValue: 49151, automationRate: 'a-rate' }] : []), ...(key ? KEY_DESC.map(d => ({ ...d, automationRate: 'k-rate' })) : [])])};
const __names = __desc.filter(d => d.name !== 'chord' && d.name !== 'keyOn' && d.name !== 'keyListen').map(d => d.name);
// Réglages à pas entier (interrupteurs, division…) : arrondis comme sanitizeV21, même quand une voie les fait glisser.
const __ints = __desc.filter(d => d.name !== 'chord' && d.name !== 'keyOn' && d.name !== 'keyListen').map(d => !!d.int);
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
    // Effets calés sur le morceau (gate) : position dans le morceau au début du bloc.
    if (this.core.setClock && parameters.originHi) this.core.setClock(currentTime - (parameters.originHi[0] + parameters.originLo[0]));
    for (let i = 0; i < __names.length; i++) {
      const a = parameters[__names[i]];
      if (a && a.length) { const v = __ints[i] ? Math.round(a[0]) : a[0]; if (this.ep[__names[i]] !== v) { this.ep[__names[i]] = v; this.dirty = true; } }
    }
    if (this.dirty) { this.dirty = false; this.core.setParams(__toCore(this.ep, sampleRate)); }
    if (this.core.chordIn && parameters.chord) this.core.chordIn(parameters.chord);
    // Clé externe (side-chain, R7) : entrée 2, branchée par le moteur.
    if (this.core.setKey && parameters.keyOn) {
      const k = inputs[1];
      const on = parameters.keyOn[0] >= 0.5 && !!k && k.length > 0;
      this.core.setKey(on ? k[0] : null, on ? (k[1] || k[0]) : null, on, on && parameters.keyListen[0] >= 0.5);
    }
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
/** Réglages du gate rythmique → cœur (autonome : s1…s16 → motif). */
export function gateToCore(p: Record<string, any>) {
  const steps: number[] = [];
  for (let i = 1; i <= 16; i++) { const v = +p['s' + i]; steps.push(Number.isFinite(v) ? v : 1); }
  return { steps, rate: +p.rate || 4, length: +p.length || 16, depth: p.depth === undefined ? 1 : +p.depth, attack: p.attack === undefined ? 2 : +p.attack, release: p.release === undefined ? 20 : +p.release, bpm: +p.bpm || 120, keyThreshold: p.keyThreshold === undefined ? -30 : +p.keyThreshold };
}
export function lofiToCore(p: Record<string, any>) {
  return { bits: +p.bits || 16, rate: +p.rate || 48000, lowCut: +p.lowCut || 20, highCut: +p.highCut || 20000, drive: +p.drive || 0, noise: +p.noise || 0, mix: p.mix === undefined ? 1 : +p.mix, output: +p.output || 0 };
}

/** Side-chain (R7) : clé branchée (keyOn) et écoute de la clé (keyListen). */
const KEY_DESC = [
  { name: 'keyOn', defaultValue: 0, minValue: 0, maxValue: 1 },
  { name: 'keyListen', defaultValue: 0, minValue: 0, maxValue: 1 },
];

export function noiseGateToCore(p: Record<string, any>) {
  const n = (v: any, d: number) => (Number.isFinite(+v) ? +v : d);
  return { threshold: n(p.threshold, -40), range: n(p.range, 80), attack: n(p.attack, 0.5), hold: n(p.hold, 20), release: n(p.release, 80) };
}

interface WorkletSpec {
  key: string;
  processor: string;
  code: string;
  /** Noms des AudioParam (réglages automatisables). */
  audioParams: string[];
  /** Latence (échantillons) ; 0 par défaut. */
  latencySamples?: (sr: number) => number;
  /** Calé sur la ligne de temps du morceau (originHi / originLo). */
  timeline?: boolean;
  /** AudioParam « chord » (accord en cours, piste d'accords). */
  chord?: boolean;
  /** Entrée de clé externe (side-chain, R7). */
  sidechain?: boolean;
}

const descriptorsOf = (type: V21Type) => {
  const d = V21_DEFAULTS[type]();
  return V21_SPECS[type].map(s => ({ name: s.id, defaultValue: typeof d[s.id] === 'number' ? d[s.id] : s.min, minValue: s.min, maxValue: s.max, ...(s.step >= 1 ? { int: true } : {}) }));
};

/**
 * Origine de la ligne de temps (instant du contexte où le morceau commence), en
 * deux AudioParam (partie entière + reste) : un seul float32 perdrait la
 * précision après quelques heures de contexte.
 */
const TIMELINE_DESC = [
  { name: 'originHi', defaultValue: 0, minValue: -1e9, maxValue: 1e9 },
  { name: 'originLo', defaultValue: 0, minValue: -2, maxValue: 2 },
];

const makeSpec = (type: V21Type, processor: string, defs: string, make: string, toCore: (p: Record<string, any>) => any, latencySamples?: (sr: number) => number, opts: { timeline?: boolean; chord?: boolean; key?: boolean } = {}): WorkletSpec => {
  const desc = descriptorsOf(type);
  const timeline = !!opts.timeline, chord = !!opts.chord, key = !!opts.key;
  const all = timeline ? [...desc, ...TIMELINE_DESC] : desc;
  // Clé (et nom du processeur) versionnée : un module déjà chargé sous l'ancien code n'est pas réutilisé.
  const proc = chord ? `${processor}-c` : key ? `${processor}-k` : processor;
  return { key: `${proc}-2`, processor: proc, code: processorCode(proc, defs, make, toCore.toString(), all, chord, key), audioParams: desc.map(d => d.name), latencySamples, timeline, chord, sidechain: key };
};

let SPECS: Record<V21Type, WorkletSpec> | null = null;
const specs = (): Record<V21Type, WorkletSpec> => {
  if (!SPECS) SPECS = {
    HARMONIZER: makeSpec('HARMONIZER', 'nova-v21-harmonizer', PSOLA_DEFS, PSOLA_MAKE, harmonizerToCore, psolaLatencySamples, { chord: true }),
    VOICESHIFT: makeSpec('VOICESHIFT', 'nova-v21-voiceshift', PSOLA_DEFS, PSOLA_MAKE, voiceShiftToCore, psolaLatencySamples),
    TIMEFX: makeSpec('TIMEFX', 'nova-v21-timefx', `const createTimeFxCore = (${createTimeFxCore.toString()});`, `(sr) => { const c = createTimeFxCore(sr); c.meters = () => c.state(); return c; }`, timeFxToCore),
    DJFILTER: makeSpec('DJFILTER', 'nova-v21-djfilter', `const createDjFilterCore = (${createDjFilterCore.toString()});`, `(sr) => { const c = createDjFilterCore(sr); c.meters = () => ({ cutoff: c.cutoffHz() }); return c; }`, djFilterToCore),
    LOFI: makeSpec('LOFI', 'nova-v21-lofi', `const createLofiCore = (${createLofiCore.toString()});`, `(sr) => createLofiCore(sr)`, lofiToCore),
    // Aucune latence (gain par échantillon) ; motif calé sur la ligne de temps du morceau.
    GATEFX: makeSpec('GATEFX', 'nova-v21-gate', `const createGateCore = (${createGateCore.toString()});`, `(sr) => createGateCore(sr)`, gateToCore, undefined, { timeline: true, key: true }),
    // Porte de bruit / expandeur (R7) : aucune latence, clé externe possible.
    GATE: makeSpec('GATE', 'nova-v21-noisegate', `const createNoiseGateCore = (${createNoiseGateCore.toString()});`, `(sr) => createNoiseGateCore(sr)`, noiseGateToCore, undefined, { key: true }),
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
  /** Instant du contexte où le morceau commence (effets calés sur la ligne de temps). */
  private origin = 0;
  /** Entrée de la clé externe (side-chain, R7) : Gate et Gate rythmique ; null sinon. */
  public readonly sidechainInput: GainNode | null = null;
  private keyActive = false;

  constructor(ctx: BaseAudioContext, type: V21Type, params?: Record<string, any>, bpm?: number) {
    this.ctx = ctx;
    this.type = type;
    this.spec = specs()[type];
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    if (this.spec.sidechain) {
      const k = ctx.createGain();
      k.channelCount = 2; k.channelCountMode = 'explicit'; k.channelInterpretation = 'speakers';
      (this as any).sidechainInput = k;
    }
    this.params = this.withScale({ ...V21_DEFAULTS[type](), ...sanitizeV21(type, params || {}), ...(bpm ? { bpm } : {}) });
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, this.spec.key, this.spec.code);
      const parameterData: Record<string, number> = {};
      for (const k of this.spec.audioParams) if (Number.isFinite(+this.params[k])) parameterData[k] = +this.params[k];
      if (this.spec.timeline) { const hi = Math.floor(this.origin); parameterData.originHi = hi; parameterData.originLo = this.origin - hi; }
      if (this.spec.sidechain) { parameterData.keyOn = this.keyActive ? 1 : 0; parameterData.keyListen = +this.params.keyListen >= 0.5 ? 1 : 0; }
      this.worklet = new AudioWorkletNode(this.ctx, this.spec.processor, {
        numberOfInputs: this.spec.sidechain ? 2 : 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        processorOptions: { params: this.params },
      });
      this.worklet.port.onmessage = (e) => { this.meters = e.data || {}; this.metersAt = Date.now(); };
      this.input.connect(this.worklet);
      if (this.sidechainInput) this.sidechainInput.connect(this.worklet, 0, 1);
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
    if (this.spec.sidechain && 'keyListen' in clean) {
      const ap = (this.worklet.parameters as any).get('keyListen') as AudioParam | undefined;
      try { ap?.setValueAtTime(+clean.keyListen >= 0.5 ? 1 : 0, this.ctx.currentTime); } catch { /* */ }
    }
    for (const [k, v] of Object.entries(clean)) {
      const ap = this.spec.audioParams.includes(k) ? (this.worklet.parameters as any).get(k) as AudioParam | undefined : undefined;
      if (ap && typeof v === 'number') { try { ap.setValueAtTime(v, this.ctx.currentTime); } catch { ap.value = v; } }
      else msg[k] = v;
    }
    if ('scale' in clean) msg._scale = this.params._scale;
    if (Object.keys(msg).length) this.worklet.port.postMessage({ params: msg });
  }

  /** Clé externe branchée (side-chain, R7) : la détection suit `sidechainInput`. */
  public setSidechainActive(on: boolean) {
    if (!this.spec.sidechain || on === this.keyActive) return;
    this.keyActive = on;
    const ap = this.worklet ? ((this.worklet.parameters as any).get('keyOn') as AudioParam | undefined) : undefined;
    try { ap?.setValueAtTime(on ? 1 : 0, this.ctx.currentTime); } catch { /* */ }
  }
  public get sidechainActive() { return this.keyActive; }

  /** AudioParam d'un réglage automatisable (lecture et export y programment la voie d'avance), sinon null. */
  public automationParam(key: string): AudioParam | null {
    if (!this.worklet || !this.spec.audioParams.includes(key)) return null;
    return (this.worklet.parameters as any).get(key) ?? null;
  }

  /** Effet calé sur le morceau (gate rythmique) ? */
  public get followsTimeline(): boolean { return !!this.spec.timeline; }

  /**
   * Cale l'effet sur la ligne de temps : `origin` = instant du contexte qui
   * correspond au début du morceau, MOINS l'avance de compensation de latence
   * des effets qui suivent (le son arrive ici en avance d'autant). Appelé au
   * départ de la lecture, au bouclage (`when` = instant du saut) et au début
   * de l'export (mêmes motifs aux deux).
   */
  public syncTimeline(origin: number, when?: number) {
    if (!this.spec.timeline || !Number.isFinite(origin)) return;
    this.origin = origin;
    if (!this.worklet) return;
    const hi = Math.floor(origin);
    const at = Math.max(this.ctx.currentTime, when ?? 0);
    const P = this.worklet.parameters as any;
    try { P.get('originHi').setValueAtTime(hi, at); P.get('originLo').setValueAtTime(origin - hi, at); } catch { /* contexte fermé */ }
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
