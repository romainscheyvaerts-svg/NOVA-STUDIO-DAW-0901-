/**
 * Nova Bridge v4 — client du pont VST3 local (NovaVSTBridge.exe, ws://127.0.0.1:8765).
 *
 * - Connexion UNIQUEMENT à la demande de l'utilisateur (« Connecter le pont VST ») :
 *   aucun essai automatique en boucle (téléphones, PC sans pont).
 * - Contrôle (JSON, requêtes numérotées) sur ce thread ; l'audio temps réel passe
 *   par un Worker dédié (public/worklets/vst-bridge-worker-v4.js) relié à chaque
 *   AudioWorklet d'effet VST3.
 * - Rendu hors temps réel (RENDER) en trame binaire pour le gel / l'export.
 *
 * Protocole complet : bridge-python/nova_bridge_server.py.
 */

export interface BridgePlugin {
  id: string;
  name: string;
  vendor: string;
  category: 'Effect' | 'Instrument' | string;
  path: string;
  uid: string;
  pluginName?: string | null;
}

export type BridgeStatus = 'idle' | 'connecting' | 'connected' | 'unavailable';

export interface BridgeState {
  status: BridgeStatus;
  error: string | null;
  version: number | null;
  pluginCount: number;
}

export interface LoadResult {
  name: string;
  vendor: string;
  latencySamples: number;
  bufferLatencySamples: number;
  stateB64: string | null;
}

type SlotEvent =
  | { action: 'EDITOR_CLOSED'; slot_id: string; state: string | null }
  | { action: 'LATENCY'; slot_id: string; latency_samples: number };

const align4 = (n: number) => (n + 3) & ~3;

class NovaBridgeService {
  readonly url = 'ws://127.0.0.1:8765';
  private ws: WebSocket | null = null;
  private state: BridgeState = { status: 'idle', error: null, version: null, pluginCount: 0 };
  private listeners = new Set<(s: BridgeState) => void>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  private nextId = 1;
  private plugins: BridgePlugin[] = [];
  private slotListeners = new Map<string, Set<(e: SlotEvent) => void>>();
  private claimedSlots = new Set<string>();
  private worker: Worker | null = null;
  private connectPromise: Promise<boolean> | null = null;

  // --- État ---------------------------------------------------------------

  getBridgeState(): BridgeState { return this.state; }
  isConnected(): boolean { return this.state.status === 'connected'; }

  subscribe(cb: (s: BridgeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => { this.listeners.delete(cb); };
  }

  private setBridgeState(patch: Partial<BridgeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(cb => { try { cb(this.state); } catch { /* écouteur fautif */ } });
  }

  // --- Connexion ----------------------------------------------------------

  /** Un seul essai (3 s). Renvoie true si le pont répond. */
  connect(): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    if (this.connectPromise) return this.connectPromise;
    this.setBridgeState({ status: 'connecting', error: null });
    this.connectPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        if (!ok) this.setBridgeState({ status: 'unavailable', error: error || null });
        resolve(ok);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch {
        done(false, 'Connexion impossible');
        return;
      }
      ws.binaryType = 'arraybuffer';
      const timer = window.setTimeout(() => { try { ws.close(); } catch { /* */ } done(false, 'Pas de réponse'); }, 3000);
      ws.onopen = async () => {
        window.clearTimeout(timer);
        this.ws = ws;
        try {
          const hello = await this.request({ action: 'HELLO' }, 3000);
          this.setBridgeState({ status: 'connected', error: null, version: hello.version ?? null });
          this.ensureWorker();
          done(true);
          this.listPlugins().catch(() => { /* liste demandée plus tard */ });
        } catch (e: any) {
          done(false, e?.message || 'Pont incompatible');
          try { ws.close(); } catch { /* */ }
        }
      };
      ws.onmessage = (ev) => this.onMessage(ev);
      ws.onerror = () => { /* onclose suit */ };
      ws.onclose = () => {
        window.clearTimeout(timer);
        const wasConnected = this.ws === ws;
        if (wasConnected) this.ws = null;
        this.pending.forEach(p => { window.clearTimeout(p.timer); p.reject(new Error('Pont VST déconnecté')); });
        this.pending.clear();
        if (wasConnected) {
          this.worker?.postMessage({ type: 'close' });
          this.setBridgeState({ status: 'idle', error: 'Le pont VST a été fermé.' });
        }
        done(false, 'Pont VST introuvable');
      };
    });
    return this.connectPromise;
  }

  disconnect() {
    this.worker?.postMessage({ type: 'close' });
    if (this.ws) { try { this.ws.close(); } catch { /* */ } }
  }

  private onMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      this.onBinary(ev.data);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && typeof msg.req_id === 'number' && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id)!;
      this.pending.delete(msg.req_id);
      window.clearTimeout(p.timer);
      if (msg.success === false) p.reject(new Error(msg.error || 'Erreur du pont VST'));
      else p.resolve(msg);
      return;
    }
    if (msg && (msg.action === 'EDITOR_CLOSED' || msg.action === 'LATENCY') && msg.slot_id) {
      this.slotListeners.get(String(msg.slot_id))?.forEach(cb => { try { cb(msg); } catch { /* */ } });
    }
  }

  private onBinary(buf: ArrayBuffer) {
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 2) return;
    const dv = new DataView(buf);
    const jlen = dv.getUint32(4, true);
    let meta: any;
    try { meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jlen))); } catch { return; }
    const p = this.pending.get(meta.req_id);
    if (!p) return;
    this.pending.delete(meta.req_id);
    window.clearTimeout(p.timer);
    if (!meta.success) { p.reject(new Error(meta.error || 'Rendu VST impossible')); return; }
    const off = align4(8 + jlen);
    const nch = meta.nch || 2;
    const nframes = meta.nframes || 0;
    const inter = new Float32Array(buf, off, nframes * nch);
    const channels = Array.from({ length: nch }, () => new Float32Array(nframes));
    for (let i = 0; i < nframes; i++) for (let c = 0; c < nch; c++) channels[c][i] = inter[i * nch + c];
    p.resolve({ ...meta, channels });
  }

  /** Requête JSON avec réponse (req_id). */
  request(msg: Record<string, any>, timeoutMs = 15000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Pont VST non connecté'));
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error('Le pont VST ne répond pas'));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...msg, req_id }));
    });
  }

  // --- Plugins ------------------------------------------------------------

  getCachedPlugins(): BridgePlugin[] { return this.plugins; }

  async listPlugins(rescan = false): Promise<BridgePlugin[]> {
    const r = await this.request({ action: 'GET_PLUGIN_LIST', rescan }, rescan ? 120000 : 30000);
    this.plugins = (r.plugins || []).map((p: any) => ({
      id: String(p.id ?? p.path),
      name: p.name || 'Plugin',
      vendor: p.vendor || '',
      category: p.category || 'Effect',
      path: p.path,
      uid: p.uid || '',
      pluginName: p.plugin_name ?? null,
    }));
    this.setBridgeState({ pluginCount: this.plugins.length });
    return this.plugins;
  }

  /** Identifiant de slot unique (un même id de plugin peut exister deux fois après un copier-coller). */
  claimSlot(pluginId: string): string {
    let id = pluginId.slice(0, 200);
    let n = 2;
    while (this.claimedSlots.has(id)) id = `${pluginId.slice(0, 196)}#${n++}`;
    this.claimedSlots.add(id);
    return id;
  }

  releaseSlot(slotId: string) { this.claimedSlots.delete(slotId); }

  onSlotEvent(slotId: string, cb: (e: SlotEvent) => void): () => void {
    let set = this.slotListeners.get(slotId);
    if (!set) { set = new Set(); this.slotListeners.set(slotId, set); }
    set.add(cb);
    return () => { set!.delete(cb); if (set!.size === 0) this.slotListeners.delete(slotId); };
  }

  async loadPlugin(opts: { slotId: string; path: string; pluginName?: string | null; sampleRate: number; stateB64?: string | null }): Promise<LoadResult> {
    const r = await this.request({
      action: 'LOAD_PLUGIN', slot_id: opts.slotId, path: opts.path, plugin_name: opts.pluginName || null,
      sample_rate: Math.round(opts.sampleRate), state: opts.stateB64 || null,
    }, 60000);
    return {
      name: r.name || '', vendor: r.vendor || '',
      latencySamples: Number(r.latency_samples) || 0,
      bufferLatencySamples: Number(r.buffer_latency_samples) || 0,
      stateB64: r.state || null,
    };
  }

  unloadPlugin(slotId: string) {
    if (this.isConnected()) this.request({ action: 'UNLOAD_PLUGIN', slot_id: slotId }).catch(() => { /* déjà parti */ });
  }

  async getPluginState(slotId: string): Promise<string | null> {
    const r = await this.request({ action: 'GET_STATE', slot_id: slotId });
    return r.state || null;
  }

  async setPluginState(slotId: string, stateB64: string): Promise<boolean> {
    const r = await this.request({ action: 'SET_STATE', slot_id: slotId, state: stateB64 });
    return !!r.success;
  }

  showEditor(slotId: string) { return this.request({ action: 'SHOW_EDITOR', slot_id: slotId }); }
  closeEditor(slotId: string) { return this.request({ action: 'CLOSE_EDITOR', slot_id: slotId }).catch(() => undefined); }

  /**
   * Rendu hors temps réel d'un buffer complet à travers un plugin (instance
   * temporaire côté pont). slotId : reprend les réglages de l'instance en cours.
   * La sortie est alignée sur l'entrée (latence du plugin compensée) et dure
   * entrée + queue.
   */
  async render(opts: {
    slotId?: string | null; path?: string; pluginName?: string | null; stateB64?: string | null;
    sampleRate: number; channels: Float32Array[]; tailSeconds?: number;
  }): Promise<Float32Array[]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Pont VST non connecté');
    const nch = Math.max(1, Math.min(2, opts.channels.length));
    const nframes = opts.channels[0]?.length || 0;
    const req_id = this.nextId++;
    const meta = JSON.stringify({
      action: 'RENDER', req_id, slot_id: opts.slotId || null, path: opts.path || null,
      plugin_name: opts.pluginName || null, state: opts.stateB64 || null,
      sample_rate: Math.round(opts.sampleRate), nch, nframes, tail_seconds: opts.tailSeconds || 0,
    });
    const j = new TextEncoder().encode(meta);
    const off = align4(8 + j.length);
    const buf = new ArrayBuffer(off + nframes * nch * 4);
    const u8 = new Uint8Array(buf);
    u8[0] = 2;
    new DataView(buf).setUint32(4, j.length, true);
    u8.set(j, 8);
    const inter = new Float32Array(buf, off, nframes * nch);
    for (let c = 0; c < nch; c++) {
      const ch = opts.channels[c];
      for (let i = 0; i < nframes; i++) inter[i * nch + c] = ch[i];
    }
    // Le rendu d'un long morceau peut prendre du temps sur un gros plugin.
    const timeoutMs = 60000 + (nframes / Math.max(1, opts.sampleRate)) * 4000;
    const res = await new Promise<any>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(req_id); reject(new Error('Rendu VST trop long')); }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      ws.send(buf);
    });
    return res.channels as Float32Array[];
  }

  // --- Audio temps réel ---------------------------------------------------

  private ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker(`${import.meta.env.BASE_URL}worklets/vst-bridge-worker-v4.js`);
    }
    this.worker.postMessage({ type: 'init', url: this.url });
  }

  /** Relie un AudioWorklet d'effet au Worker audio : renvoie le port à transférer au worklet. */
  attachAudio(slotId: string): MessagePort | null {
    if (!this.worker) return null;
    const ch = new MessageChannel();
    this.worker.postMessage({ type: 'attach', slotId, port: ch.port1 }, [ch.port1]);
    return ch.port2;
  }

  detachAudio(slotId: string) {
    this.worker?.postMessage({ type: 'detach', slotId });
  }
}

export const novaBridge = new NovaBridgeService();
(globalThis as any).__novaBridge = novaBridge; // diagnostic (tests, console)
