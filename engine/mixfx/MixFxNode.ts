/**
 * « Compresseur multibande » (MBCOMP) et « EQ dynamique » (DYNEQ) de NOVA : enveloppe
 * AudioWorklet des cœurs `multibandCore.ts` et `dynEqCore.ts`, même code en lecture et à
 * l'export (OfflineAudioContext).
 *
 * - Réglages automatisables : AudioParam k-rate (lus à chaque bloc de 128 échantillons, en
 *   lecture comme à l'export) ; les autres passent par message et à la construction.
 * - Latence nulle (filtres IIR, pas d'anticipation).
 * - Mesures ~30 fois par seconde : réduction par bande (multibande), gain dynamique et
 *   niveau par bande (EQ dynamique), crêtes d'entrée / sortie.
 * - Veille des effets (engine/effectSleep) : le cœur signale quand il est au repos ; au
 *   réveil, il rattrape les blocs muets sautés (enveloppes en relâchement).
 * - Clé externe (side-chain R7, 22/10/2026) : `sidechainInput` (2e entrée du worklet), câblée par
 *   le moteur (engine/sidechain.ts) comme pour le Compresseur ; chaque bande détecte dans la
 *   même bande de la clé. « Écouter la clé » : on n'entend que la clé.
 */
import { createMultibandCore } from './multibandCore';
import { createDynEqCore } from './dynEqCore';
import { MIXFX_DEFAULTS, MIXFX_SPECS, sanitizeMixFx, type MixFxKind } from './mixFxParams';
import { loadWorkletModule } from '../../plugins/vocalDspUtils';
import { retireWorkletNode } from '../workletGuard';
import { blockClockSource } from '../blockClock';

const AUTO = (kind: MixFxKind) => MIXFX_SPECS[kind].filter(s => s.auto).map(s => s.id);

/** AudioParam du processeur : union des deux effets (chaque nœud ne lit que les siens). */
const ALL_AP: { name: string; defaultValue: number }[] = [];
for (const k of ['MBCOMP', 'DYNEQ'] as MixFxKind[]) {
  for (const id of AUTO(k)) if (!ALL_AP.some(a => a.name === id)) ALL_AP.push({ name: id, defaultValue: MIXFX_DEFAULTS[k][id] ?? 0 });
}

const PROC = 'nova-mixfx-v1';

const WORKLET_CODE = `${blockClockSource()}const createMultibandCore = (${createMultibandCore.toString()});
const createDynEqCore = (${createDynEqCore.toString()});
const __apByKind = ${JSON.stringify({ MBCOMP: AUTO('MBCOMP'), DYNEQ: AUTO('DYNEQ') })};
const __allAp = ${JSON.stringify(ALL_AP)};
class NovaMixFxProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __allAp.map(d => ({ name: d.name, minValue: -1e5, maxValue: 1e5, defaultValue: d.defaultValue, automationRate: 'k-rate' }))
      .concat([{ name: '__resetGen', minValue: 0, maxValue: 1e9, defaultValue: 0, automationRate: 'k-rate' },
        { name: '__keyOn', minValue: 0, maxValue: 1, defaultValue: 0, automationRate: 'k-rate' },
        { name: '__keyListen', minValue: 0, maxValue: 1, defaultValue: 0, automationRate: 'k-rate' }]);
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.kind = o.kind === 'DYNEQ' ? 'DYNEQ' : 'MBCOMP';
    this.params = Object.assign({}, o.params || {});
    this.core = this.kind === 'DYNEQ' ? createDynEqCore(sampleRate) : createMultibandCore(sampleRate);
    this.core.setParams(this.params);
    this.ap = __apByKind[this.kind];
    this.last = this.ap.map(() => NaN);
    this.dirty = false;
    this.clock = { next: -1 };
    this.zero = new Float32Array(128);
    this.blocks = 0;
    this.gen = 0;
    this.rest = undefined;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.params) { Object.assign(this.params, d.params); this.dirty = true; }
      if (d.reset) this.core.reset();
    };
  }
  process(inputs, outputs, parameters) {
    // Bloc(s) sauté(s) : la chaîne dormait (veille), le cœur rattrape les blocs muets (engine/blockClock).
    const skipped = framesSkipped(this.clock, currentFrame, 128);
    if (skipped > 0) this.core.catchUp(skipped);
    // Départ de lecture : compteur programmé au bloc du départ, le cœur repart à neuf (comme l'export).
    if (parameters.__resetGen && parameters.__resetGen[0] !== this.gen) { this.gen = parameters.__resetGen[0]; this.core.reset(); }
    for (let i = 0; i < this.ap.length; i++) {
      const a = parameters[this.ap[i]];
      const v = a && a.length ? a[0] : NaN;
      if (v === v && v !== this.last[i]) { this.last[i] = v; this.params[this.ap[i]] = v; this.dirty = true; }
    }
    if (this.dirty) { this.dirty = false; try { this.core.setParams(this.params); } catch (e) {} }
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : this.zero;
    const iR = inp && inp[1] ? inp[1] : null;
    // Clé branchée mais muette (source à l'arrêt : entrée inactive, 0 canal) = silence, pas le son de la piste.
    const useKey = parameters.__keyOn && parameters.__keyOn[0] >= 0.5;
    const key = inputs[1];
    const kL = useKey ? (key && key[0] ? key[0] : this.zero) : null;
    const kR = useKey ? (key && key[1] ? key[1] : kL) : null;
    this.core.process(iL, iR, out[0], out[1] || null, n, kL, kR);
    if (useKey && parameters.__keyListen && parameters.__keyListen[0] >= 0.5) {
      out[0].set(kL.subarray(0, n));
      if (out[1]) out[1].set(kR.subarray(0, n));
    }
    if (++this.blocks >= 12) { this.blocks = 0; this.port.postMessage(this.core.takeMeters()); }
    const rest = this.core.atRest();
    if (rest !== this.rest) { this.rest = rest; this.port.postMessage({ rest }); }
    return true;
  }
}
try { registerProcessor('${PROC}', NovaMixFxProcessor); } catch (e) {}
`;

export interface MbMeters { gr: number[]; grNow: number[]; inPeakDb: number; outPeakDb: number }
export interface DynMeters { gainNow: number[]; gainPeak: number[]; levelDb: number[]; inPeakDb: number; outPeakDb: number }

const EMPTY_MB: MbMeters = { gr: [0, 0, 0, 0], grNow: [0, 0, 0, 0], inPeakDb: -120, outPeakDb: -120 };
const EMPTY_DYN: DynMeters = { gainNow: [0, 0, 0, 0], gainPeak: [0, 0, 0, 0], levelDb: [-120, -120, -120, -120], inPeakDb: -120, outPeakDb: -120 };

export class MixFxNode {
  public input: GainNode;
  public output: GainNode;
  /** Entrée de la clé de side-chain (R7), câblée par le moteur (engine/sidechain.ts). */
  public readonly sidechainInput: GainNode;
  public readonly ready: Promise<void>;
  public readonly kind: MixFxKind;
  private keyActive = false;
  private keyListen = false;
  private ctx: BaseAudioContext;
  private worklet: AudioWorkletNode | null = null;
  private params: Record<string, number>;
  private meters: any = null;
  private metersAt = 0;
  private failed = false;
  private disposed = false;
  private atRest = false;

  constructor(ctx: BaseAudioContext, kind: MixFxKind, params?: Record<string, any>) {
    this.ctx = ctx;
    this.kind = kind;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';
    this.sidechainInput = ctx.createGain();
    this.sidechainInput.channelCount = 2;
    this.sidechainInput.channelCountMode = 'explicit';
    this.sidechainInput.channelInterpretation = 'speakers';
    this.keyListen = Number(params?.keyListen) >= 0.5;
    this.params = { ...MIXFX_DEFAULTS[kind], ...sanitizeMixFx(kind, params || {}) };
    this.ready = this.init();
  }

  private async init() {
    try {
      await loadWorkletModule(this.ctx, PROC, WORKLET_CODE);
      if (this.disposed) return;
      const parameterData: Record<string, number> = {};
      for (const id of AUTO(this.kind)) parameterData[id] = +this.params[id];
      this.worklet = new AudioWorkletNode(this.ctx, PROC, {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        parameterData,
        // Réglages passés à la construction : un message arriverait trop tard à l'export.
        processorOptions: { kind: this.kind, params: { ...this.params } },
      });
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (typeof d.rest === 'boolean') { this.atRest = d.rest; return; }
        if (Number.isFinite(d.inPeakDb)) { this.meters = d; this.metersAt = Date.now(); }
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

  /** Latence ajoutée (s) : aucune. */
  public get latency(): number { return 0; }

  public updateParams(p: Record<string, any>) {
    if (!p) return;
    if (p.keyListen !== undefined) { const l = Number(p.keyListen) >= 0.5; if (l !== this.keyListen) { this.keyListen = l; this.applyKey(); } }
    const clean = sanitizeMixFx(this.kind, p);
    this.params = { ...this.params, ...clean };
    if (!this.worklet) return;
    const msg: Record<string, number> = {};
    const auto = new Set(AUTO(this.kind));
    for (const [k, v] of Object.entries(clean)) {
      const ap = auto.has(k) ? (this.worklet.parameters as any).get(k) as AudioParam | undefined : undefined;
      if (ap) { try { ap.setValueAtTime(v, this.ctx.currentTime); } catch { ap.value = v; } }
      else msg[k] = v;
    }
    if (Object.keys(msg).length) this.worklet.port.postMessage({ params: msg });
  }

  public getParams() { return { ...this.params }; }

  /** Clé externe branchée (R7) : chaque bande détecte dans la clé. */
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

  private resetCount = 0;
  /** Départ de la lecture à `at` (début d'un bloc de rendu) : le cœur repart de l'état d'une instance neuve. */
  public resetAt(at: number) {
    const ap = this.worklet ? ((this.worklet.parameters as any).get('__resetGen') as AudioParam | undefined) : undefined;
    if (!ap) return;
    try { ap.setValueAtTime(++this.resetCount, Math.max(this.ctx.currentTime, at - 0.5 / this.ctx.sampleRate)); } catch { /* contexte fermé */ }
  }

  /** AudioParam d'un réglage automatisable (lecture et export y programment la voie), sinon null. */
  public automationParam(key: string): AudioParam | null {
    if (!this.worklet || !AUTO(this.kind).includes(key)) return null;
    return (this.worklet.parameters as any).get(key) ?? null;
  }

  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() {
    if (!this.worklet) return;
    const now = this.ctx.currentTime;
    for (const id of AUTO(this.kind)) {
      const prm = (this.worklet.parameters as any).get(id) as AudioParam | undefined;
      if (!prm) continue;
      try { prm.cancelScheduledValues(0); prm.setValueAtTime(+this.params[id], now); } catch { prm.value = +this.params[id]; }
    }
  }

  /** Cœur au repos (veille des effets, engine/effectSleep). */
  public isAtRest(): boolean { return !!this.worklet && !this.failed && this.atRest; }

  /** Mesures récentes ; remises à zéro après 0,5 s sans nouvelles. */
  public getMeters(): MbMeters | DynMeters {
    const empty = this.kind === 'DYNEQ' ? EMPTY_DYN : EMPTY_MB;
    if (!this.meters || Date.now() - this.metersAt > 500) return empty;
    return this.meters;
  }

  public isFallback() { return this.failed; }

  public disconnect() {
    try { this.input.disconnect(); } catch { /* déjà débranché */ }
    try { this.sidechainInput.disconnect(); } catch { /* idem */ }
    try { this.worklet?.disconnect(); } catch { /* idem */ }
    try { this.output.disconnect(); } catch { /* idem */ }
  }

  /** Effet retiré de la piste : worklet mis à la retraite (ou jamais créé s'il chargeait encore). */
  public dispose() {
    this.disposed = true;
    if (this.worklet) { retireWorkletNode(this.worklet); this.worklet = null; }
    this.disconnect();
  }
}
