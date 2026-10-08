/**
 * Compresseurs « analogiques » NOVA (Opto Vintage, FET 76, Leveler 2A, Vox
 * Strip) : enveloppe AudioWorklet du cœur `analogCompCore.ts`, même code en
 * lecture et à l'export (OfflineAudioContext).
 *
 * - Réglages automatisables : AudioParam k-rate (lus à chaque bloc de 128
 *   échantillons, en lecture comme à l'export) ; les autres (mode, filtre de
 *   détection…) passent par message et à la construction.
 * - La traduction des boutons en paramètres internes (analogCompMaps.ts) et
 *   le profil mesuré de l'appareil (analogProfiles.ts) voyagent dans le
 *   worklet : la traduction est refaite dans le thread audio dès qu'un
 *   réglage bouge.
 * - Latence : 0 ou 1 échantillon déclaré au PDC selon l'appareil (tour 2 du
 *   labo : l'original a une légère avance de phase, reproduite par un
 *   passe-tout fractionnaire plus cette latence compensée).
 * - VU de réduction de gain : réduction max et courante, ~30 fois par seconde.
 * - Side-chain (R7) : même interface que le Compresseur (`sidechainInput`,
 *   `setSidechainActive`) ; la clé entre sur la 2e entrée du worklet et remplace
 *   le signal du détecteur ; « écouter la clé » (keyListen) fait entendre la clé.
 */
import { createAnalogCompCore } from './analogCompCore';
import { buildAnalogInternal } from './analogCompMaps';
import { ANALOG_PROFILES } from './analogProfiles';
import { ANALOG_SPECS, sanitizeAnalog } from './analogCompParams';
import { loadWorkletModule } from '../plugins/vocalDspUtils';
import { retireWorkletNode } from './workletGuard';

const AUDIO_PARAMS = (kind: string) => (ANALOG_SPECS[kind]?.specs || []).filter(s => s.auto);

/** Tous les AudioParam du processeur (union des appareils ; chaque nœud n'utilise que les siens). */
const ALL_AP: { name: string; defaultValue: number }[] = [];
for (const k of Object.keys(ANALOG_SPECS)) {
  for (const s of AUDIO_PARAMS(k)) {
    if (!ALL_AP.some(a => a.name === s.id)) ALL_AP.push({ name: s.id, defaultValue: ANALOG_SPECS[k].defaults[s.id] ?? s.min });
  }
}

const WORKLET_CODE = `
const createAnalogCompCore = (${createAnalogCompCore.toString()});
const buildAnalogInternal = (${buildAnalogInternal.toString()});
const __apByKind = ${JSON.stringify(Object.fromEntries(Object.keys(ANALOG_SPECS).map(k => [k, AUDIO_PARAMS(k).map(s => s.id)])))};
const __allAp = ${JSON.stringify(ALL_AP)};
class NovaAnalogCompProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __allAp.map(d => ({ name: d.name, minValue: -1e4, maxValue: 1e4, defaultValue: d.defaultValue, automationRate: 'k-rate' }))
      // Side-chain (R7) : détection sur l'entrée 2 (clé externe), écoute de la clé.
      .concat([{ name: '__keyOn', minValue: 0, maxValue: 1, defaultValue: 0, automationRate: 'k-rate' },
        { name: '__keyListen', minValue: 0, maxValue: 1, defaultValue: 0, automationRate: 'k-rate' }]);
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.kind = o.kind;
    this.profile = o.profile;
    this.params = Object.assign({}, o.params || {});
    this.core = createAnalogCompCore(sampleRate);
    this.ap = __apByKind[this.kind] || [];
    this.last = this.ap.map(() => NaN);
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
    for (let i = 0; i < this.ap.length; i++) {
      const a = parameters[this.ap[i]];
      const v = a && a.length ? a[0] : NaN;
      if (v === v && v !== this.last[i]) { this.last[i] = v; this.params[this.ap[i]] = v; this.dirty = true; }
    }
    if (this.dirty) {
      this.dirty = false;
      try { this.core.setInternal(buildAnalogInternal(this.kind, this.params, this.profile, sampleRate)); } catch (e) {}
    }
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : this.zero;
    const iR = inp && inp[1] ? inp[1] : iL;
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
    if (++this.blocks >= 12) { this.blocks = 0; this.port.postMessage(this.core.takeMeters()); }
    return true;
  }
}
try { registerProcessor('nova-analog-comp-v1', NovaAnalogCompProcessor); } catch (e) {}
`;

export interface AnalogMeters { grDb: number; grNowDb: number; inPeakDb: number; outPeakDb: number }

export class AnalogCompNode {
  public input: GainNode;
  public output: GainNode;
  /** Entrée de la clé de side-chain (R7), câblée par le moteur (engine/sidechain.ts). */
  public readonly sidechainInput: GainNode;
  public readonly ready: Promise<void>;
  public readonly kind: string;
  private ctx: BaseAudioContext;
  private worklet: AudioWorkletNode | null = null;
  private params: Record<string, number | boolean>;
  private meters: AnalogMeters & { at: number } = { grDb: 0, grNowDb: 0, inPeakDb: -120, outPeakDb: -120, at: 0 };
  private failed = false;
  /** Latence déclarée (échantillons) : avance de phase mesurée du plugin d'origine (passe-tout + PDC). */
  private latSamples = 0;
  private keyActive = false;
  /** Effet retiré : un worklet encore en chargement n'est pas créé (sinon il restait vivant). */
  private disposed = false;
  private keyListen = false;

  constructor(ctx: BaseAudioContext, kind: string, params?: Record<string, any>) {
    this.ctx = ctx;
    this.kind = kind;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.sidechainInput = ctx.createGain();
    this.sidechainInput.channelCount = 2;
    this.sidechainInput.channelCountMode = 'explicit';
    this.sidechainInput.channelInterpretation = 'speakers';
    this.keyListen = Number(params?.keyListen) >= 0.5;
    this.params = { ...(ANALOG_SPECS[kind]?.defaults || {}), isEnabled: true, ...sanitizeAnalog(kind, params || {}) };
    try {
      const cfg = buildAnalogInternal(kind, this.numericParams(), ANALOG_PROFILES[kind], ctx.sampleRate);
      this.latSamples = Math.max(0, Math.round(+cfg.P[128] || 0));
    } catch { this.latSamples = 0; }
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, 'nova-analog-comp-v1', WORKLET_CODE);
      if (this.disposed) return;
      const parameterData: Record<string, number> = {};
      for (const s of AUDIO_PARAMS(this.kind)) parameterData[s.id] = +(this.params[s.id] as number);
      this.worklet = new AudioWorkletNode(this.ctx, 'nova-analog-comp-v1', {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        // Réglages et profil passés à la construction : un message arriverait trop tard à l'export.
        processorOptions: { kind: this.kind, profile: ANALOG_PROFILES[this.kind], params: this.numericParams() },
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.grDb)) this.meters = { grDb: d.grDb, grNowDb: d.grNowDb, inPeakDb: d.inPeakDb, outPeakDb: d.outPeakDb, at: Date.now() };
      };
      this.input.connect(this.worklet);
      this.sidechainInput.connect(this.worklet, 0, 1);
      this.applyKey();
      this.worklet.connect(this.output);
    } catch (e) {
      console.warn(`[NOVA ${this.kind}] AudioWorklet indisponible, effet contourné :`, e);
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  private numericParams() {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.params)) if (typeof v === 'number') o[k] = v;
    return o;
  }

  /** Retard déclaré (s), compensé par le moteur (PDC) : 0 ou 1 échantillon selon l'appareil (avance de phase
   *  mesurée du plugin d'origine, reproduite par un passe-tout fractionnaire + cette latence). */
  public get latency(): number { return this.failed ? 0 : this.latSamples / this.ctx.sampleRate; }

  public updateParams(p: Record<string, any>) {
    if (!p) return;
    if (p.keyListen !== undefined) { const l = Number(p.keyListen) >= 0.5; if (l !== this.keyListen) { this.keyListen = l; this.applyKey(); } }
    const clean = sanitizeAnalog(this.kind, p);
    this.params = { ...this.params, ...clean };
    if (!this.worklet) return;
    const msg: Record<string, number> = {};
    const auto = new Set(AUDIO_PARAMS(this.kind).map(s => s.id));
    for (const [k, v] of Object.entries(clean)) {
      if (typeof v !== 'number') continue;
      const ap = auto.has(k) ? (this.worklet.parameters as any).get(k) as AudioParam | undefined : undefined;
      if (ap) { try { ap.setValueAtTime(v, this.ctx.currentTime); } catch { ap.value = v; } }
      else msg[k] = v;
    }
    if (Object.keys(msg).length) this.worklet.port.postMessage({ params: msg });
  }

  public getParams() { return { ...this.params }; }

  /** Clé externe branchée (R7) : la détection écoute `sidechainInput`. */
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
      prm.get('__keyListen')?.setValueAtTime(this.keyActive && this.keyListen ? 1 : 0, now);
    } catch { /* contexte fermé */ }
  }

  /** AudioParam d'un réglage automatisable (lecture et export y programment la voie d'automation), sinon null. */
  public automationParam(key: string): AudioParam | null {
    if (!this.worklet || !AUDIO_PARAMS(this.kind).some(s => s.id === key)) return null;
    return (this.worklet.parameters as any).get(key) ?? null;
  }

  /** Mesures récentes (réduction de gain max / courante, crêtes) ; remises à zéro après 0,5 s sans nouvelles. */
  public getMeters(): AnalogMeters {
    if (Date.now() - this.meters.at > 500) return { grDb: 0, grNowDb: 0, inPeakDb: -120, outPeakDb: -120 };
    const { at: _a, ...m } = this.meters;
    return m;
  }

  public isFallback() { return this.failed; }

  /** Effet retiré de la piste : worklet mis à la retraite (ou jamais créé s'il chargeait encore), entrées débranchées. */
  public dispose() {
    this.disposed = true;
    if (this.worklet) { retireWorkletNode(this.worklet); this.worklet = null; }
    this.disconnect();
  }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
    try { this.sidechainInput.disconnect(); } catch { /* idem */ }
    try { this.worklet?.disconnect(); } catch { /* idem */ }
    try { this.output.disconnect(); } catch { /* idem */ }
  }
}
