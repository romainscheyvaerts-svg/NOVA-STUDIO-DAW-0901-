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
 */

/** Pré-tampon, en échantillons : absorbe les à-coups du pont sans craquement. */
export const VST_PREBUFFER_FRAMES = 2048;

export type VstNodeStatus = 'offline' | 'loading' | 'active' | 'error';

export interface VstNodeInfo {
  pluginId: string;
  status: VstNodeStatus;
  error: string | null;
  name: string;
  latencyMs: number;
  underruns: number;
}

type StateListener = (pluginId: string, stateB64: string) => void;

/** Remontée de l'état des plugins (fenêtre fermée, chargement) vers le projet. */
export const vstStateEvents = {
  listeners: new Set<StateListener>(),
  on(cb: StateListener) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; },
  emit(pluginId: string, stateB64: string) { this.listeners.forEach(cb => { try { cb(pluginId, stateB64); } catch { /* */ } }); },
};

/** Effets VST3 vivants (un par effet de piste), pour l'interface et la sauvegarde. */
export const liveVstNodes = new Map<string, VSTPluginNode>();
const infoListeners = new Set<() => void>();
export const onVstNodesChange = (cb: () => void) => { infoListeners.add(cb); return () => { infoListeners.delete(cb); }; };
const notifyInfo = () => infoListeners.forEach(cb => { try { cb(); } catch { /* */ } });

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

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

  constructor(ctx: BaseAudioContext, plugin: PluginInstance) {
    this.ctx = ctx;
    this.plugin = plugin;
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
  }

  // --- Contrat des effets du moteur --------------------------------------------

  updateParams(params: Record<string, any>) {
    if (!params) return;
    // lowLatency : ignoré (voir setMonitorBypass).
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

  getInfo(): VstNodeInfo {
    return {
      pluginId: this.plugin.id, status: this.status, error: this.error,
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
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    this.teardown();
    if (liveVstNodes.get(this.plugin.id) === this) liveVstNodes.delete(this.plugin.id);
    notifyInfo();
    try { this.input.disconnect(); } catch { /* */ }
    try { this.output.disconnect(); } catch { /* */ }
  }

  // --- Interne -----------------------------------------------------------------

  private adoptState(st: string) {
    if (st === this.knownState) return;
    this.knownState = st;
    vstStateEvents.emit(this.plugin.id, st);
  }

  private setStatus(status: VstNodeStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    notifyInfo();
  }

  private onBridgeState(s: BridgeState) {
    if (this.disposed) return;
    if (s.status === 'connected') {
      if (this.status === 'offline' || this.status === 'error') void this.start();
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
        sampleRate: this.ctx.sampleRate, stateB64: this.knownState,
      });
      if (this.disposed || seq !== this.loadSeq) { novaBridge.unloadPlugin(slotId); return; }
      this.loadedName = res.name;
      this.pluginLatencySamples = res.latencySamples + res.bufferLatencySamples;
      if (res.stateB64) this.adoptState(res.stateB64);

      this.slotUnsub?.();
      this.slotUnsub = novaBridge.onSlotEvent(slotId, (ev) => {
        if (ev.action === 'EDITOR_CLOSED' && ev.state) this.adoptState(ev.state);
        if (ev.action === 'LATENCY') {
          this.pluginLatencySamples = Number(ev.latency_samples) || 0;
          this.updateLatency(true);
        }
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
    } catch (e: any) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.teardown();
      this.setStatus('error', e?.message || 'Chargement impossible');
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
