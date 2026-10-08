import { PluginInstance } from '../types';
import { novaBridge, BridgeState, VstAutomatableParam } from '../services/NovaBridge';
import { vstParamCatalog, vstParamTexts, notifyVstCatalog as notifyCatalog } from '../utils/vstParamCatalog';
export { vstParamCatalog, vstParamTexts, onVstCatalogChange, vstValueText, vstParamDisplayName } from '../utils/vstParamCatalog';

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
 * - (R9) Automation : `automationParam(clé)` rend un AudioParam du worklet (valeur
 *   brute 0–1 du réglage VST). Le moteur y programme la voie d'avance, avec la même
 *   avance PDC que les effets NOVA ; chaque bloc envoyé au pont porte les changements
 *   horodatés à l'échantillon près. Réglages proposés dans « + voie » : `automatable()`
 *   (lus par le pont, noms et valeurs texte du plugin). Écriture Touch / Latch :
 *   `setWatch(true)` → les réglages bougés dans la fenêtre du plugin sont signalés
 *   (vstParamEvents) et enregistrés dans la voie par l'application.
 * - (R10) Side-chain : `sidechainInput` (2e entrée du worklet). Clé active : les
 *   blocs partent en 4 canaux, le pont alimente l'entrée side-chain du plugin
 *   (hôte natif, voir bridge-python/vst_sidechain.py).
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

/** Nombre d'AudioParam d'automation du worklet (vst-bridge-processor-v5 : p0 … p31). */
export const VST_AUTO_SLOTS = 32;

/** Réglages bougés dans la fenêtre du plugin (écriture Touch / Latch) : id de l'effet, clé, valeur brute. */
export interface VstParamChange { pluginId: string; changes: { name: string; value: number; from?: number; text?: string }[] }
export const vstParamEvents = {
  listeners: new Set<(e: VstParamChange) => void>(),
  on(cb: (e: VstParamChange) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; },
  emit(e: VstParamChange) { this.listeners.forEach(cb => { try { cb(e); } catch { /* */ } }); },
};

/** Effets VST3 vivants (un par effet de piste), pour l'interface et la sauvegarde. */
export const liveVstNodes = new Map<string, VSTPluginNode>();
const infoListeners = new Set<() => void>();
export const onVstNodesChange = (cb: () => void) => { infoListeners.add(cb); return () => { infoListeners.delete(cb); }; };
const notifyInfo = () => infoListeners.forEach(cb => { try { cb(); } catch { /* */ } });

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Capacités du pont connecté (v11 : automation, side-chain) ; vide si inconnues. */
const bridgeCaps = (): Partial<BridgeState> => {
  try { return (novaBridge as any).getBridgeState?.() || {}; } catch { return {}; }
};

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
  /** (R9) Réglage → index de l'AudioParam du worklet ; réglages déclarés au pont pour ce chargement. */
  private autoIndex = new Map<string, number>();
  private autoArmed = new Set<string>();
  private autoMapSeq = 0;
  private watchWanted = false;
  private watchOn = false;
  private textsAsked = new Set<string>();
  private paramStats = { paramsSent: 0, paramBlocks: 0 };
  /** (R10) Entrée de clé (side-chain) : branchée sur la 2e entrée du worklet. */
  public readonly sidechainInput: GainNode;
  private sidechainOn = false;

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
    this.sidechainInput = ctx.createGain();
    this.sidechainInput.channelCount = 2;
    this.sidechainInput.channelCountMode = 'explicit';
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

  // --- Automation (R9) -----------------------------------------------------------

  /**
   * AudioParam d'automation d'un réglage VST (valeur brute 0–1), ou null (plugin
   * pas chargé, pont sans automation, plus de place : 32 réglages par effet).
   * Le réglage est déclaré au pont ; ses valeurs partent avec l'audio dès que
   * le pont l'a enregistré.
   */
  automationParam(key: string): AudioParam | null {
    const w = this.worklet;
    if (!w || !key || !bridgeCaps().automation) return null;
    let idx = this.autoIndex.get(key);
    if (idx === undefined) {
      if (this.autoIndex.size >= VST_AUTO_SLOTS) return null;
      const used = new Set(this.autoIndex.values());
      idx = 0;
      while (used.has(idx)) idx++;
      this.autoIndex.set(key, idx);
      this.requestTexts([key]);
    }
    if (!this.autoArmed.has(key) && this.status === 'active') void this.syncAutomationMap();
    return (w.parameters as any).get(`p${idx}`) || null;
  }

  /** Réglages déclarés au pont (index → clé) puis armés dans le worklet. */
  private async syncAutomationMap() {
    const slotId = this.slotId;
    const w = this.worklet;
    if (!slotId || !w || this.status !== 'active') return;
    const seq = ++this.autoMapSeq;
    const names: string[] = [];
    this.autoIndex.forEach((i, k) => { names[i] = k; });
    for (let i = 0; i < names.length; i++) if (!names[i]) names[i] = '';
    try {
      await novaBridge.setAutomationMap(slotId, names);
    } catch { return; }
    if (seq !== this.autoMapSeq || this.slotId !== slotId || this.status !== 'active') return;
    this.autoIndex.forEach((i, k) => {
      if (this.autoArmed.has(k)) return;
      this.autoArmed.add(k);
      w.port.postMessage({ type: 'arm', index: i, on: true });
    });
  }

  /**
   * Valeur posée tout de suite (départ de lecture à l'arrêt, fin d'écriture, plus de
   * 32 réglages automatisés) : sur l'AudioParam s'il existe, sinon par le pont.
   */
  setParamNow(key: string, raw: number) {
    if (!Number.isFinite(raw)) return;
    const v = Math.max(0, Math.min(1, raw));
    const ap = this.autoIndex.has(key) ? this.automationParam(key) : null;
    if (ap) {
      try { const now = this.ctx.currentTime; ap.cancelScheduledValues(now); ap.setValueAtTime(v, now); } catch { /* */ }
      return;
    }
    if (this.status === 'active' && this.slotId) novaBridge.setParams(this.slotId, [{ name: key, value: v }]).catch(() => { /* */ });
  }

  /** Réglages automatisables (« + voie ») : catalogue en cache, relu au chargement. */
  automatable(): VstAutomatableParam[] { return vstParamCatalog.get(this.plugin.id) || []; }

  private async loadAutomatable() {
    const slotId = this.slotId;
    if (!slotId || !bridgeCaps().automation) return;
    try {
      const list = await novaBridge.automatable(slotId);
      if (this.slotId !== slotId) return;
      vstParamCatalog.set(this.plugin.id, list);
      notifyCatalog();
      // Voies existantes : leurs unités (textes du plugin).
      this.requestTexts([...this.autoIndex.keys()]);
    } catch { /* plugin occupé : la liste viendra au prochain chargement */ }
  }

  /** Textes du plugin pour ces réglages (unités affichées dans les voies). */
  requestTexts(keys: string[]) {
    const slotId = this.slotId;
    const want = keys.filter(k => k && !this.textsAsked.has(k) && !vstParamTexts.has(`${this.plugin.id}::${k}`));
    if (!slotId || !want.length || this.status !== 'active') return;
    want.forEach(k => this.textsAsked.add(k));
    novaBridge.paramTexts(slotId, want, 100).then(texts => {
      Object.entries(texts).forEach(([k, t]) => { if (Array.isArray(t) && t.length) vstParamTexts.set(`${this.plugin.id}::${k}`, t); });
      notifyCatalog();
    }).catch(() => { want.forEach(k => this.textsAsked.delete(k)); });
  }

  /** Écriture Touch / Latch / Write : signaler les réglages bougés dans la fenêtre du plugin. */
  setWatch(on: boolean) {
    this.watchWanted = on;
    void this.applyWatch();
  }

  private async applyWatch() {
    const slotId = this.slotId;
    const want = this.watchWanted && this.status === 'active' && !!slotId;
    if (want === this.watchOn || !slotId) return;
    this.watchOn = want;
    try { await novaBridge.watchParams(slotId, want); } catch { this.watchOn = false; }
  }

  /** Statistiques d'automation du worklet (valeurs envoyées). */
  getParamStats() { return { ...this.paramStats }; }

  // --- Side-chain (R10) -----------------------------------------------------------

  /** Clé branchée par le moteur (SidechainRouter) : les blocs partent avec la clé. */
  setSidechainActive(on: boolean) {
    this.sidechainOn = on;
    this.worklet?.port.postMessage({ type: 'sidechain', on: on && this.status === 'active' });
  }
  isSidechainActive() { return this.sidechainOn; }

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
    try { this.sidechainInput.disconnect(); } catch { /* */ }
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
      p = this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/vst-bridge-processor-v5.js`);
      workletLoaded.set(this.ctx, p);
    }
    await p;
    const node = new AudioWorkletNode(this.ctx, 'vst-bridge-processor-v5', {
      // 2e entrée : clé de side-chain (R10).
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { prebufferFrames: VST_PREBUFFER_FRAMES },
    });
    node.port.onmessage = (e) => {
      if (e.data?.type === 'stats') {
        this.paramStats = { paramsSent: Number(e.data.paramsSent) || 0, paramBlocks: Number(e.data.paramBlocks) || 0 };
        if (e.data.underruns !== this.underruns) { this.underruns = e.data.underruns; notifyInfo(); }
      }
    };
    this.sidechainInput.connect(node, 0, 1);
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
        if (ev.action === 'PARAM_CHANGED' && Array.isArray(ev.changes) && ev.changes.length) {
          vstParamEvents.emit({ pluginId: this.plugin.id, changes: ev.changes.map(c => ({ name: String(c.name), value: Number(c.value), ...(typeof c.from === 'number' ? { from: c.from } : {}), text: c.text })) });
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
      node.port.postMessage({ type: 'sidechain', on: this.sidechainOn });
      this.setStatus('active');
      this.updateLatency(true);
      if (this.plugin.params?.novaSettings) void this.applyNovaSettings();
      // (R9) Nouvelle instance : réglages automatisés redéclarés, catalogue relu, écriture reprise.
      this.autoArmed.clear();
      if (this.autoIndex.size) void this.syncAutomationMap();
      void this.loadAutomatable();
      this.watchOn = false;
      void this.applyWatch();
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
      // Réglages à redéclarer au prochain chargement (nouvelle instance sur le pont).
      this.autoArmed.forEach(k => { const i = this.autoIndex.get(k); if (i !== undefined) this.worklet!.port.postMessage({ type: 'arm', index: i, on: false }); });
      this.autoArmed.clear();
      this.autoMapSeq++;
      this.watchOn = false;
      this.textsAsked.clear();
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
