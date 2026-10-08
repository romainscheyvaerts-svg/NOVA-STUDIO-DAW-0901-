import { PluginInstance } from '../types';
import { novaBridge, BridgeState } from '../services/NovaBridge';

/**
 * Effet VST3 du PC dans la chaîne Web Audio, via le pont local.
 *
 * - Pont non connecté, plugin introuvable, contexte hors ligne (export) : le son
 *   passe tel quel (latence 0). Jamais de mélange sec + traité.
 * - Plugin chargé : AudioWorklet avec un pré-tampon fixe. `latency` (secondes)
 *   = pré-tampon + latence du plugin, compensée par le moteur à la lecture.
 * - updateParams({ lowLatency }) est ignoré (un effet passant par le pont ne
 *   peut pas être sans latence) ; à la place, le moteur appelle
 *   setMonitorBypass(true) quand la piste est armée : le retour casque de
 *   l'artiste reste sans retard.
 * - La fenêtre du plugin s'ouvre sur le PC (openEditor) ; à sa fermeture,
 *   l'état du plugin est remonté au projet (vstStateEvents).
 * - Plugin en panne sur le pont (PLUGIN_CRASHED : exception, figé, NaN) : passe-plat
 *   immédiat, la piste continue sans lui ; relance automatique ~1 s après, au plus
 *   VST_CRASH_RETRIES fois en 10 min pour ce plugin, puis il reste contourné
 *   (« désactivé : il plante »). Événement fenêtre « nova:vst-crash » pour l'appli.
 *   Plugin en quarantaine (il a fait planter le pont au chargement) : erreur, pas de relance.
 */

/** Pré-tampon, en échantillons : absorbe les à-coups du pont sans craquement. */
export const VST_PREBUFFER_FRAMES = 2048;

export type VstNodeStatus = 'offline' | 'loading' | 'active' | 'error';

export interface VstNodeInfo {
  pluginId: string;
  status: VstNodeStatus;
  error: string | null;
  /** (pont v7, chargement discret) Le plugin a demandé une licence / activation. */
  licenseRequired?: boolean;
  name: string;
  latencyMs: number;
  underruns: number;
}

/** D'où vient l'état : fenêtre du plugin fermée par l'artiste, chargement, réglage par Nova. */
export type VstStateSource = 'editor' | 'load' | 'nova';
type StateListener = (pluginId: string, stateB64: string, source?: VstStateSource) => void;

/** Remontée de l'état des plugins (fenêtre fermée, chargement) vers le projet. */
export const vstStateEvents = {
  listeners: new Set<StateListener>(),
  on(cb: StateListener) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; },
  emit(pluginId: string, stateB64: string, source?: VstStateSource) { this.listeners.forEach(cb => { try { cb(pluginId, stateB64, source); } catch { /* */ } }); },
};

/** Réglages posés par Nova (params.novaSettings) : résultat relu, ou échec (repli). */
export interface NovaSettingsReport {
  pluginId: string;
  name: string;
  ok: boolean;
  /** Paramètre → valeur texte relue sur le plugin. */
  readback: { name: string; text: string; ok: boolean }[];
  /** Le plugin n'a pas pu servir : licence / démo / plantage. */
  failed?: 'license' | 'load' | null;
  error?: string | null;
}
export const novaVstEvents = {
  listeners: new Set<(r: NovaSettingsReport) => void>(),
  on(cb: (r: NovaSettingsReport) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; },
  emit(r: NovaSettingsReport) { this.listeners.forEach(cb => { try { cb(r); } catch { /* */ } }); },
};

/** Effets VST3 vivants (un par effet de piste), pour l'interface et la sauvegarde. */
export const liveVstNodes = new Map<string, VSTPluginNode>();
const infoListeners = new Set<() => void>();
export const onVstNodesChange = (cb: () => void) => { infoListeners.add(cb); return () => { infoListeners.delete(cb); }; };
const notifyInfo = () => infoListeners.forEach(cb => { try { cb(); } catch { /* */ } });

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Relances automatiques après un plantage, par plugin, sur une fenêtre de 10 min. */
export const VST_CRASH_RETRIES = 2;
export const VST_CRASH_WINDOW_MS = 10 * 60 * 1000;
export const VST_CRASH_RETRY_DELAY_MS = 1000;
/** Plantages récents par plugin (survit à la reconstruction du nœud). */
const crashHistory = new Map<string, number[]>();
/** Tests : oublie les plantages mémorisés. */
export const resetVstCrashHistory = () => crashHistory.clear();

export interface VstCrashDetail {
  pluginId: string;
  name: string;
  reason: string;
  error: string | null;
  willRetry: boolean;
  /** Message prêt à afficher. */
  message: string;
}

const crashReasonLabel = (reason: string): string =>
  reason === 'hang' ? 'il ne répondait plus' : reason === 'nan' ? 'son invalide' : 'erreur interne';

export class VSTPluginNode {
  public readonly input: GainNode;
  public readonly output: GainNode;
  /** Latence totale (s) : pré-tampon + plugin. 0 quand le son passe tel quel. */
  public latency = 0;

  private ctx: BaseAudioContext;
  private plugin: PluginInstance;
  private worklet: AudioWorkletNode | null = null;
  private slotId: string | null = null;
  private status: VstNodeStatus = 'offline';
  private error: string | null = null;
  private loadedName = '';
  private pluginLatencySamples = 0;
  private monitorBypass = false;
  private knownState: string | null = null;
  private underruns = 0;
  private disposed = false;
  private loadSeq = 0;
  private unsubs: (() => void)[] = [];
  private slotUnsub: (() => void) | null = null;
  private latencyListener: (() => void) | null = null;
  private statusListeners = new Set<(s: VstNodeStatus) => void>();
  private licenseRequired = false;
  /** Réglages de Nova déjà appliqués (JSON) : réappliqués s'ils changent (Annuler, nouveau mix). */
  private knownSettings = 'null';
  private readonly quiet: boolean;
  /** Plantage à répétition ou quarantaine : plus de relance automatique (reconnexion comprise). */
  private crashDisabled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * opts.quiet : plugin posé par NOVA lui-même (autotune du PC) : chargement
   * discret (aucune fenêtre de licence ne surgit, voir NovaBridge.loadPlugin).
   */
  constructor(ctx: BaseAudioContext, plugin: PluginInstance, opts: { quiet?: boolean } = {}) {
    this.ctx = ctx;
    this.plugin = plugin;
    this.quiet = !!opts.quiet || !!plugin.params?.novaQuiet;
    this.knownSettings = JSON.stringify(plugin.params?.novaSettings || null);
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.knownState = plugin.params?.stateB64 || null;
    // Tant que le flux n'est pas prêt : passe-plat direct.
    this.input.connect(this.output);

    // Export / gel : un OfflineAudioContext ne peut pas attendre le pont. Les
    // effets VST3 y sont rendus à part (rendu gelé), ce nœud reste neutre.
    const realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    if (!realtime || !plugin.params?.localPath) return;

    liveVstNodes.set(plugin.id, this);
    notifyInfo();
    this.unsubs.push(novaBridge.subscribe((s: BridgeState) => this.onBridgeState(s)));
    // Licence activée (« C'est fait ») : un chargement raté est relancé.
    this.unsubs.push(novaBridge.onLicenseDone((path) => {
      if (path === plugin.params?.localPath && this.status === 'error' && novaBridge.isConnected()) void this.start();
    }));
  }

  // --- Contrat des effets du moteur --------------------------------------------

  updateParams(params: Record<string, any>) {
    if (!params) return;
    // lowLatency : ignoré (voir setMonitorBypass).
    if ('novaSettings' in params) {
      const js = JSON.stringify(params.novaSettings || null);
      if (js !== this.knownSettings) {
        this.knownSettings = js;
        this.plugin = { ...this.plugin, params: { ...this.plugin.params, novaSettings: params.novaSettings } };
        if (this.status === 'active') void this.applyNovaSettings();
      }
    }
    const next = params.stateB64;
    if (typeof next === 'string' && next && next !== this.knownState) {
      this.knownState = next;
      // Annuler / rétablir, ou un autre écran a changé l'état : on le pousse au pont.
      if (this.status === 'active' && this.slotId) novaBridge.setPluginState(this.slotId, next).catch(() => { /* */ });
    }
  }

  /** Piste armée : le son passe tel quel (retour casque sans retard). */
  setMonitorBypass(on: boolean) {
    if (this.monitorBypass === on) return;
    this.monitorBypass = on;
    this.worklet?.port.postMessage({ type: 'bypass', on });
    this.updateLatency(false);
  }

  setLatencyListener(cb: (() => void) | null) { this.latencyListener = cb; }

  /** Changements d'état (chargé, erreur, pont fermé). */
  onStatus(cb: (s: VstNodeStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  getInfo(): VstNodeInfo {
    return {
      pluginId: this.plugin.id, status: this.status, error: this.error, licenseRequired: this.licenseRequired,
      name: this.loadedName || this.plugin.name, underruns: this.underruns,
      latencyMs: Math.round(this.latency * 1000),
    };
  }

  /** Ouvre la fenêtre du plugin sur le PC. */
  async openEditor(): Promise<void> {
    if (this.status !== 'active' || !this.slotId) throw new Error('Plugin pas encore chargé sur le pont');
    await novaBridge.showEditor(this.slotId);
  }

  /** Relit l'état du plugin sur le pont (avant une sauvegarde). */
  async syncState(): Promise<string | null> {
    if (this.status !== 'active' || !this.slotId) return null;
    const st = await novaBridge.getPluginState(this.slotId);
    if (st) this.adoptState(st);
    return st;
  }

  getSlotId(): string | null { return this.status === 'active' ? this.slotId : null; }

  dispose() {
    this.disposed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    this.teardown();
    if (liveVstNodes.get(this.plugin.id) === this) liveVstNodes.delete(this.plugin.id);
    notifyInfo();
    try { this.input.disconnect(); } catch { /* */ }
    try { this.output.disconnect(); } catch { /* */ }
  }

  // --- Interne -----------------------------------------------------------------

  private adoptState(st: string, source: VstStateSource = 'load') {
    if (st === this.knownState) return;
    this.knownState = st;
    vstStateEvents.emit(this.plugin.id, st, source);
  }

  /**
   * Réglages posés par Nova (mix piloté par le chat) : envoyés au plugin par leur
   * nom et leur valeur texte / réelle, RELUS, puis l'état du plugin est enregistré
   * dans le projet. Rien n'ouvre la fenêtre du plugin.
   */
  private async applyNovaSettings() {
    const settings = this.plugin.params?.novaSettings as { name: string; text?: string; real?: number }[] | undefined;
    const slotId = this.slotId;
    if (!settings || !settings.length || !slotId || this.status !== 'active') return;
    try {
      const res = await novaBridge.setParams(slotId, settings);
      const readback = res.results.map(r => ({ name: r.name, text: r.text || '', ok: !!r.ok }));
      if (this.slotId !== slotId) return;
      const st = await novaBridge.getPluginState(slotId).catch(() => null);
      if (st) this.adoptState(st, 'nova');
      novaVstEvents.emit({ pluginId: this.plugin.id, name: this.loadedName || this.plugin.name, ok: readback.every(r => r.ok), readback });
    } catch (e: any) {
      novaVstEvents.emit({ pluginId: this.plugin.id, name: this.loadedName || this.plugin.name, ok: false, readback: [], error: e?.message || null });
    }
  }

  private setStatus(status: VstNodeStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    notifyInfo();
    this.statusListeners.forEach(cb => { try { cb(status); } catch { /* écouteur fautif */ } });
  }

  /**
   * Le pont signale une panne de CE plugin : passe-plat tout de suite (la piste
   * continue), relance si le plafond n'est pas atteint.
   */
  private onCrash(reason: string, error: string | null) {
    if (this.disposed) return;
    const now = Date.now();
    const id = this.plugin.id;
    const recent = (crashHistory.get(id) || []).filter(t => now - t < VST_CRASH_WINDOW_MS);
    const willRetry = recent.length < VST_CRASH_RETRIES;
    recent.push(now);
    crashHistory.set(id, recent);
    const name = this.loadedName || this.plugin.name || 'Le plugin';
    this.teardown();
    const message = willRetry
      ? `${name} a planté (${crashReasonLabel(reason)}) : relance…`
      : `${name} désactivé : il plante (${recent.length} fois en 10 min). Le son passe sans lui.`;
    this.crashDisabled = !willRetry;
    this.setStatus('error', message);
    const detail: VstCrashDetail = { pluginId: id, name, reason, error, willRetry, message };
    try {
      if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent('nova:vst-crash', { detail }));
    } catch { /* hors navigateur */ }
    if (!willRetry) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed && !this.crashDisabled && novaBridge.isConnected()) void this.start();
    }, VST_CRASH_RETRY_DELAY_MS);
  }

  private onBridgeState(s: BridgeState) {
    if (this.disposed) return;
    if (s.status === 'connected') {
      if ((this.status === 'offline' || this.status === 'error') && !this.crashDisabled) void this.start();
    } else if (this.status !== 'offline') {
      this.teardown();
      this.setStatus('offline');
    }
  }

  private async ensureWorklet(): Promise<AudioWorkletNode> {
    if (this.worklet) return this.worklet;
    let p = workletLoaded.get(this.ctx);
    if (!p) {
      // Chemin relatif à la base du build (le DAW n'est pas toujours servi à la racine).
      p = this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/vst-bridge-processor-v4.js`);
      workletLoaded.set(this.ctx, p);
    }
    await p;
    const node = new AudioWorkletNode(this.ctx, 'vst-bridge-processor-v4', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { prebufferFrames: VST_PREBUFFER_FRAMES },
    });
    node.port.onmessage = (e) => {
      if (e.data?.type === 'stats') {
        if (e.data.underruns !== this.underruns) { this.underruns = e.data.underruns; notifyInfo(); }
      }
    };
    this.worklet = node;
    return node;
  }

  private async start() {
    const seq = ++this.loadSeq;
    const path = this.plugin.params?.localPath;
    if (!path) return;
    this.setStatus('loading');
    try {
      const node = await this.ensureWorklet();
      if (this.disposed || seq !== this.loadSeq) return;
      if (!this.slotId) this.slotId = novaBridge.claimSlot(this.plugin.id);
      const slotId = this.slotId;
      const res = await novaBridge.loadPlugin({
        slotId, path, pluginName: this.plugin.params?.pluginName || null,
        sampleRate: this.ctx.sampleRate, stateB64: this.knownState, quiet: this.quiet,
      });
      this.licenseRequired = false;
      if (this.disposed || seq !== this.loadSeq) { novaBridge.unloadPlugin(slotId); return; }
      this.loadedName = res.name;
      this.pluginLatencySamples = res.latencySamples + res.bufferLatencySamples;
      if (res.stateB64) this.adoptState(res.stateB64);

      this.slotUnsub?.();
      this.slotUnsub = novaBridge.onSlotEvent(slotId, (ev) => {
        if (ev.action === 'EDITOR_CLOSED' && ev.state) this.adoptState(ev.state, 'editor');
        if (ev.action === 'LATENCY') {
          this.pluginLatencySamples = Number(ev.latency_samples) || 0;
          this.updateLatency(true);
        }
        if (ev.action === 'PLUGIN_CRASHED' && this.slotId === slotId) this.onCrash(String(ev.reason || 'exception'), ev.error ?? null);
      });

      const port = novaBridge.attachAudio(slotId);
      if (!port) throw new Error('Flux audio du pont indisponible');
      node.port.postMessage({ type: 'port', port }, [port]);
      node.port.postMessage({ type: 'bypass', on: this.monitorBypass });
      // Bascule passe-plat -> worklet
      try { this.input.disconnect(this.output); } catch { /* */ }
      this.input.connect(node);
      node.connect(this.output);
      node.port.postMessage({ type: 'active', on: true });
      this.setStatus('active');
      this.updateLatency(true);
      if (this.plugin.params?.novaSettings) void this.applyNovaSettings();
    } catch (e: any) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.teardown();
      this.licenseRequired = !!e?.licenseRequired;
      // (pont v10) Il a fait planter le pont au chargement : plus de relance automatique.
      if (e?.quarantined) this.crashDisabled = true;
      this.setStatus('error', e?.message || 'Chargement impossible');
      // Plugin posé par Nova : le projet repasse sur l'effet de NOVA (voir App, VST_MIX_FALLBACK).
      if (this.plugin.params?.novaSlot) {
        novaVstEvents.emit({ pluginId: this.plugin.id, name: this.plugin.name, ok: false, readback: [], failed: this.licenseRequired ? 'license' : 'load', error: e?.message || null });
      }
    }
  }

  /** Retour au passe-plat (pont fermé, erreur, destruction). */
  private teardown() {
    this.loadSeq++;
    this.slotUnsub?.();
    this.slotUnsub = null;
    if (this.worklet) {
      this.worklet.port.postMessage({ type: 'active', on: false });
      try { this.input.disconnect(this.worklet); } catch { /* */ }
      try { this.worklet.disconnect(); } catch { /* */ }
    }
    try { this.input.disconnect(this.output); } catch { /* */ }
    this.input.connect(this.output);
    if (this.slotId) {
      novaBridge.detachAudio(this.slotId);
      novaBridge.unloadPlugin(this.slotId);
      novaBridge.releaseSlot(this.slotId);
      this.slotId = null;
    }
    const had = this.latency;
    this.latency = 0;
    if (had !== 0) this.latencyListener?.();
  }

  private updateLatency(notify: boolean) {
    const sr = this.ctx.sampleRate || 48000;
    const next = (this.status === 'active' && !this.monitorBypass)
      ? (VST_PREBUFFER_FRAMES + this.pluginLatencySamples) / sr
      : 0;
    if (Math.abs(next - this.latency) < 1e-9) return;
    this.latency = next;
    notifyInfo();
    if (notify) this.latencyListener?.();
  }
}
