/**
 * Nova Bridge v4 — client du pont VST3 local (NovaVSTBridge.exe, ws://127.0.0.1:8765).
 *
 * - Première connexion UNIQUEMENT à la demande (« Connecter le pont VST », ou l'appli
 *   Windows) : aucun essai automatique sur un appareil qui n'a jamais vu le pont
 *   (téléphones, PC sans pont). Ensuite, reconnexion automatique (voir v10).
 * - Contrôle (JSON, requêtes numérotées) sur ce thread ; l'audio temps réel passe
 *   par un Worker dédié (public/worklets/vst-bridge-worker-v5.js) relié à chaque
 *   AudioWorklet d'effet VST3.
 * - Rendu hors temps réel (RENDER) en trame binaire pour le gel / l'export.
 * - v5 : instruments VST3 (RENDER_INSTRUMENT : notes -> audio, mode instru).
 * - v6 : LICENSE_WINDOW (fenêtre d'activation d'un plugin ramenée au premier
 *   plan sur le PC) : message au musicien, délais allongés, « C'est fait ».
 * - v7 : paramètres par valeur texte (GET_PARAMS détaillé, SET_PARAMS relu) :
 *   autotune du PC réglé sur la gamme du beat, mix piloté par Nova.
 * - v8 : séparation de stems (module optionnel Demucs installé à la demande sur le
 *   PC) : STEMS_STATUS / STEMS_INSTALL / STEMS_CANCEL / STEMS_SEPARATE.
 *
 * - v10 : pannes isolées. Un plugin qui plante, se fige ou sort des NaN passe en
 *   « panne » sur le pont (son sec, piste alignée) : événement PLUGIN_CRASHED
 *   (écouteurs du slot + onPluginCrash). Plugin qui a fait planter le pont au
 *   chargement deux fois : LOAD_PLUGIN refusé (erreur.quarantined).
 * - Reconnexion automatique : une fois connecté (ou dans l'appli Windows), une
 *   fermeture inattendue du pont (plantage, relance par le superviseur) relance
 *   des essais (1 s, 2 s, 4 s… 10 s au plus) jusqu'à disconnect(). État visible :
 *   status « reconnecting », attempt, nextRetryAt ; retryNow() pour ne pas attendre.
 *
 * Protocole complet : bridge-python/nova_bridge_server.py.
 */

import { isNovaDesktop } from '../utils/desktopApp';

export interface BridgePlugin {
  id: string;
  name: string;
  vendor: string;
  category: 'Effect' | 'Instrument' | string;
  path: string;
  uid: string;
  pluginName?: string | null;
  /** Instrument (pont v5) : true / false, null = pas encore lu par le pont. */
  isInstrument?: boolean | null;
  /** (pont v6) Fenêtre de licence vue : activation à faire, ou « nag » (revient à chaque chargement). */
  license?: 'activation' | 'nag' | null;
  /** (pont v6) Lecture en arrière-plan : ok, error, activation, hang, crash. */
  scanStatus?: string | null;
  /** Plugin d'un fichier « shell » (Waves : WaveShell1-VST3 17.1) : nom du fichier. Chargé par pluginName. */
  shell?: string | null;
  /** Nom sans variante (« C6 » pour « C6 Stereo »). */
  family?: string | null;
  /** Variante lue dans le nom : mono, stereo, mono/stereo. */
  channels?: 'mono' | 'stereo' | 'mono/stereo' | null;
  /** Plugin qui a fait planter le pont (isolé : il n'est plus chargé). */
  unstable?: boolean;
  /** (pont v10) A fait planter le pont au chargement (2 fois) : plus chargé jusqu'au prochain rescan. */
  quarantined?: boolean;
}

/** (pont v10) Un plugin chargé est tombé en panne : le pont fait passer le son sans lui. */
export interface PluginCrashEvent {
  slotId: string;
  /** exception (erreur interne), hang (ne répond plus), nan (son invalide en continu). */
  reason: 'exception' | 'hang' | 'nan' | string;
  error: string | null;
  name: string;
}

/** Attente avant le n-ième essai de reconnexion (1 s, 2 s, 4 s, 8 s, puis 10 s). */
export const reconnectDelayMs = (attempt: number): number => Math.min(10000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));

/**
 * (pont v6) Un plugin vient d'ouvrir une fenêtre d'activation / de licence au
 * chargement : le pont l'a ramenée au premier plan, le chargement l'attend.
 */
export interface LicenseWindowEvent {
  plugin: string;
  path: string;
  pluginName: string | null;
  title: string;
  status: 'activation' | 'nag';
  source: 'load' | 'render' | string;
  slotId: string | null;
}

/** Délai laissé à un chargement / rendu retenu par une fenêtre de licence. */
const LICENSE_WAIT_MS = 15 * 60 * 1000;

export type BridgeStatus = 'idle' | 'connecting' | 'connected' | 'unavailable' | 'reconnecting';

export interface BridgeState {
  status: BridgeStatus;
  error: string | null;
  version: number | null;
  pluginCount: number;
  /** Le pont sait rendre des instruments VST3 (v5 et plus). */
  instruments: boolean;
  /** Lecture des plugins en cours sur le pont (instrument ou effet ?) : [lus, total]. */
  instrumentsPending: [number, number] | null;
  /** (v7) Paramètres lisibles et réglables par leur valeur texte (« F# », « Minor »). */
  paramsText?: boolean;
  /** (v8) Le pont sait séparer un clip en stems (module optionnel, installé à la demande). */
  stems?: boolean;
  /** (v9) Plugins ARA2 (Melodyne, VocAlign) par l'hôte natif NovaARAHost. */
  ara?: boolean;
  /** (v12) Melodyne / VocAlign en insert sur une piste, comme Pro Tools (document de la piste, lecture en direct). */
  araInsert?: boolean;
  /** Reconnexion automatique : numéro de l'essai en attente (0 hors reconnexion). */
  attempt?: number;
  /** Reconnexion automatique : heure (ms, Date.now) du prochain essai. */
  nextRetryAt?: number | null;
  /** (v10) Calage « réduction cible » d'un compresseur VST (rendu hors ligne + dichotomie). */
  calibrateGr?: boolean;
  /** (v11, R9) Automation des réglages VST à l'échantillon près + écriture depuis la fenêtre du plugin. */
  automation?: boolean;
  /** (v11, R10) Clé de side-chain des VST (hôte natif du pont). */
  sidechain?: boolean;
}

/** Première version du pont qui sait caler un compresseur sur une réduction cible. */
export const BRIDGE_CALIBRATE_VERSION = 10;

/** Première version du pont qui héberge les plugins ARA (Melodyne, VocAlign). */
export const BRIDGE_ARA_VERSION = 9;
/** Première version du pont qui pose Melodyne / VocAlign en insert de piste (comme Pro Tools). */ const BRIDGE_ARA_INSERT_VERSION = 12;

export interface AraStatus {
  host: boolean;
  plugins: Partial<Record<'melodyne' | 'vocalign', { path: string; name?: string; label?: string }>>;
}

export interface AraClipIn {
  id: string; name: string; track?: string; role?: 'edit' | 'dub' | 'guide' | 'context';
  start?: number; persistentId?: string; channels: Float32Array[];
}

export interface AraRender { clipId: string; channels: Float32Array[]; sampleRate: number }

export interface AraOpenResult {
  sessionId: string; pluginName?: string; pluginVersion?: string; restored: boolean; analysisSeconds?: number;
  notes: Record<string, { count: number; voiced: number; mean_abs_cents?: number; notes?: number[][] }>;
}

export interface AraEvent { session_id: string; event: string; [k: string]: any }

/** Adresse du pont : 8765, ou une autre pour les essais (localStorage « nova.bridge.url », en local seulement). */
const bridgeUrl = (): string => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('nova.bridge.url') : null;
    if (v && /^ws:\/\/127\.0\.0\.1:\d+$/.test(v)) return v;
  } catch { /* stockage indisponible */ }
  return 'ws://127.0.0.1:8765';
};

/** Première version du pont qui sépare les stems (Demucs). */
export const BRIDGE_STEMS_VERSION = 8;

/** État du module « séparation de stems » sur le PC (STEMS_STATUS). */
export interface StemsModuleStatus {
  installed: boolean;
  installing: boolean;
  /** Dernier événement d'installation reçu (progression, erreur, fin). */
  install: StemsEvent | null;
  variant: 'cpu' | 'cuda' | null;
  sizeBytes: number | null;
  outputRoot: string | null;
}

/** Événement du pont (STEMS_EVENT) : installation ou séparation en cours. */
export interface StemsEvent {
  kind: 'install' | 'separate';
  event: 'progress' | 'done' | 'error' | 'cancelled' | 'device' | 'fallback' | string;
  jobId?: string | null;
  pct?: number;
  message?: string;
  step?: string;
  device?: string;
}

export interface SeparatedStem {
  key: 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other' | string;
  label: string;
  channels: Float32Array[];
  sampleRate: number;
  /** WAV écrit sur le PC (Documents\Nova Studio\Stems\…). */
  path: string;
}

export interface SeparationResult {
  stems: SeparatedStem[];
  seconds: number;
  device: string;
  outdir: string;
}

/** Erreur de séparation : code « not_installed », « cancelled » ou « error ». */
export class StemsError extends Error {
  constructor(message: string, readonly code: 'not_installed' | 'cancelled' | 'error' | 'unavailable') {
    super(message);
  }
}

/** Première version du pont qui règle les paramètres par valeur texte. */
export const BRIDGE_PARAMS_TEXT_VERSION = 7;

/** Résultat d'un réglage groupé (SET_PARAMS) : valeurs relues sur le plugin. */
export interface SetParamsResult {
  results: { name: string; ok: boolean; text?: string; value?: number; error?: string }[];
  latencySamples: number;
  latencyChanged: boolean;
}

/** Première version du pont qui automatise les réglages des VST (R9) et alimente leur side-chain (R10). */
export const BRIDGE_AUTOMATION_VERSION = 11;

/** Réglage automatisable d'un VST (« + voie »), valeur brute 0–1. */
export interface VstAutomatableParam {
  name: string;
  displayName: string;
  value: number;
  text: string;
  label?: string;
  numSteps?: number;
  isBoolean?: boolean;
}

/** Voie d'automation envoyée avec un rendu hors ligne : images depuis le début du son, valeurs brutes 0–1. */
export interface VstAutomationLane { name: string; frames: number[]; values: number[] }

/** Première version du pont qui rend les instruments VST3. */
export const BRIDGE_INSTRUMENTS_VERSION = 5;

export interface InstrumentNote {
  pitch: number;
  /** Secondes depuis le début du rendu. */
  start: number;
  duration: number;
  /** 0–1 */
  velocity: number;
}

/** Message MIDI de contrôleur (R16) : pitch bend, CC, aftertouch, à `time` s du début du rendu. */
export interface InstrumentController {
  time: number;
  status: number;
  data1: number;
  data2: number;
}

export interface LoadResult {
  name: string;
  vendor: string;
  latencySamples: number;
  bufferLatencySamples: number;
  stateB64: string | null;
  isInstrument: boolean;
  /** (v11, R10) Entrée clé du plugin : null = l'hôte du pont ne sait pas l'alimenter ; 0 = aucune ; 2 = stéréo. */
  sidechainInputs: number | null;
}

export type SlotEvent =
  | { action: 'EDITOR_CLOSED'; slot_id: string; state: string | null }
  | { action: 'LATENCY'; slot_id: string; latency_samples: number }
  | { action: 'PLUGIN_CRASHED'; slot_id: string; reason: string; error: string | null; name: string }
  /** (v11) Réglages bougés dans la fenêtre du plugin (écriture Touch / Latch). */
  | { action: 'PARAM_CHANGED'; slot_id: string; changes: { name: string; value: number; from?: number; text?: string }[] };

const align4 = (n: number) => (n + 3) & ~3;

class NovaBridgeService {
  readonly url = bridgeUrl();
  private ws: WebSocket | null = null;
  private state: BridgeState = { status: 'idle', error: null, version: null, pluginCount: 0, instruments: false, instrumentsPending: null };
  private listeners = new Set<(s: BridgeState) => void>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  private nextId = 1;
  private plugins: BridgePlugin[] = [];
  private slotListeners = new Map<string, Set<(e: SlotEvent) => void>>();
  private claimedSlots = new Set<string>();
  private worker: Worker | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private stemsListeners = new Set<(e: StemsEvent) => void>();
  /** Stems reçus (trames STEMS_STEM) en attendant la réponse finale, par req_id. */
  private stemFrames = new Map<number, SeparatedStem[]>();
  /** req_id de chaque séparation en cours (délai prolongé à chaque progression). */
  private stemsJobs = new Map<string, number>();
  /** Sons rendus par un plugin ARA (trames ARA_RENDERED) en attendant la réponse finale. */
  private araFrames = new Map<number, AraRender[]>();
  private araListeners = new Set<(e: AraEvent) => void>();
  private araInsertListeners = new Map<string, Set<(e: any) => void>>();

  // --- État ---------------------------------------------------------------

  getBridgeState(): BridgeState { return this.state; }
  isConnected(): boolean { return this.state.status === 'connected'; }

  subscribe(cb: (s: BridgeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => { this.listeners.delete(cb); };
  }

  private setBridgeState(patch: Partial<BridgeState>) {
    // Rien de neuf (ex. la même liste relue) : on ne prévient personne. Avant, chaque
    // GET_PLUGIN_LIST renvoyait un nouvel état ; un écouteur qui relit la liste à chaque
    // changement (catalogue VST de l'artiste en direct) bouclait sans fin
    // (« Maximum update depth exceeded », pont VST sollicité en continu).
    const same = (a: unknown, b: unknown) => a === b
      || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));
    if ((Object.keys(patch) as (keyof BridgeState)[]).every(k => same(this.state[k], patch[k]))) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(cb => { try { cb(this.state); } catch { /* écouteur fautif */ } });
  }

  // --- Connexion ----------------------------------------------------------

  // --- Reconnexion automatique -------------------------------------------
  /** Déjà connecté au moins une fois : une fermeture inattendue relance des essais. */
  private everConnected = false;
  /** disconnect() appelé : plus aucun essai automatique. */
  private manualClose = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private crashListeners = new Set<(e: PluginCrashEvent) => void>();

  /** Un plugin chargé est tombé en panne sur le pont (pont v10). */
  onPluginCrash(cb: (e: PluginCrashEvent) => void): () => void {
    this.crashListeners.add(cb);
    return () => { this.crashListeners.delete(cb); };
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private wantsAutoReconnect(): boolean {
    if (this.manualClose) return false;
    try { return this.everConnected || isNovaDesktop(); } catch { return this.everConnected; }
  }

  private scheduleReconnect(error: string | null) {
    this.clearReconnectTimer();
    this.reconnectAttempt++;
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.setBridgeState({ status: 'reconnecting', error, attempt: this.reconnectAttempt, nextRetryAt: Date.now() + delay, instrumentsPending: null });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect(true);
    }, delay);
  }

  /** Reconnexion en attente : on essaie tout de suite. */
  retryNow(): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    this.clearReconnectTimer();
    return this.tryConnect(this.state.status === 'reconnecting');
  }

  /** Un seul essai (3 s). Renvoie true si le pont répond. */
  connect(): Promise<boolean> {
    this.manualClose = false;
    if (this.isConnected()) return Promise.resolve(true);
    if (this.connectPromise) return this.connectPromise;
    this.clearReconnectTimer();
    return this.tryConnect(false);
  }

  private tryConnect(auto: boolean): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    if (this.connectPromise) return this.connectPromise;
    if (!auto) this.setBridgeState({ status: 'connecting', error: null });
    this.connectPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        if (ok) {
          this.everConnected = true;
          this.reconnectAttempt = 0;
          this.clearReconnectTimer();
        } else if (this.wantsAutoReconnect()) {
          // Pont relancé par le superviseur (appli Windows) ou de retour plus tard : on réessaie.
          this.scheduleReconnect(auto ? (this.state.error || error || null) : (error || null));
        } else {
          this.setBridgeState({ status: 'unavailable', error: error || null, attempt: 0, nextRetryAt: null });
        }
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
          this.setBridgeState({
            status: 'connected', error: null, version: hello.version ?? null, attempt: 0, nextRetryAt: null,
            instruments: !!hello.instruments && (Number(hello.version) || 0) >= BRIDGE_INSTRUMENTS_VERSION,
            paramsText: !!hello.params_text && (Number(hello.version) || 0) >= BRIDGE_PARAMS_TEXT_VERSION,
            stems: !!hello.stems && (Number(hello.version) || 0) >= BRIDGE_STEMS_VERSION,
            ara: !!hello.ara && (Number(hello.version) || 0) >= BRIDGE_ARA_VERSION,
            araInsert: !!hello.ara_insert && (Number(hello.version) || 0) >= BRIDGE_ARA_INSERT_VERSION,
            calibrateGr: !!hello.calibrate_gr && (Number(hello.version) || 0) >= BRIDGE_CALIBRATE_VERSION,
            automation: !!hello.automation && (Number(hello.version) || 0) >= BRIDGE_AUTOMATION_VERSION,
            sidechain: !!hello.sidechain && (Number(hello.version) || 0) >= BRIDGE_AUTOMATION_VERSION,
          });
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
        this.stemFrames.clear();
        this.stemsJobs.clear();
        if (wasConnected) {
          this.worker?.postMessage({ type: 'close' });
          if (this.wantsAutoReconnect()) {
            // Fermeture inattendue (pont planté, relancé) : essais automatiques.
            this.reconnectAttempt = 0;
            this.scheduleReconnect('Le pont VST s\'est fermé : reconnexion automatique…');
          } else {
            this.setBridgeState({ status: 'idle', error: 'Le pont VST a été fermé.', instrumentsPending: null, attempt: 0, nextRetryAt: null });
          }
        }
        done(false, 'Pont VST introuvable');
      };
    });
    return this.connectPromise;
  }

  /** Fermeture voulue : plus de reconnexion automatique (jusqu'au prochain connect()). */
  disconnect() {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    if (this.state.status === 'reconnecting') this.setBridgeState({ status: 'idle', error: null, attempt: 0, nextRetryAt: null });
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
      if (msg.success === false) {
        const err: Error & { licenseRequired?: boolean; unstable?: boolean; quarantined?: boolean } = new Error(msg.error || 'Erreur du pont VST');
        // (v7) Chargement discret refusé par une fenêtre de licence / démo.
        if (msg.license_required) err.licenseRequired = true;
        // Plugin qui plante le pont (isolé par le pont, qui continue) : à ne pas recharger.
        if (msg.unstable) err.unstable = true;
        if (msg.quarantined) err.quarantined = true;
        p.reject(err);
      } else p.resolve(msg);
      return;
    }
    if (msg && msg.action === 'STEMS_EVENT') {
      this.onStemsEventMsg(msg);
      return;
    }
    if (msg && msg.action === 'ARA_EVENT') {
      if (msg.slot_id) this.araInsertListeners.get(String(msg.slot_id))?.forEach(cb => { try { cb(msg); } catch { /* écouteur fautif */ } });
      this.araListeners.forEach(cb => { try { cb(msg); } catch { /* écouteur fautif */ } });
      return;
    }
    if (msg && msg.action === 'LICENSE_WINDOW') {
      this.onLicenseWindowMsg(msg);
      return;
    }
    if (msg && (msg.action === 'EDITOR_CLOSED' || msg.action === 'LATENCY' || msg.action === 'PLUGIN_CRASHED' || msg.action === 'PARAM_CHANGED') && msg.slot_id) {
      this.slotListeners.get(String(msg.slot_id))?.forEach(cb => { try { cb(msg); } catch { /* */ } });
    }
    if (msg && msg.action === 'PLUGIN_CRASHED' && msg.slot_id) {
      const e: PluginCrashEvent = { slotId: String(msg.slot_id), reason: String(msg.reason || 'exception'), error: msg.error ?? null, name: String(msg.name || 'Le plugin') };
      this.crashListeners.forEach(cb => { try { cb(e); } catch { /* écouteur fautif */ } });
    }
  }

  private onBinary(buf: ArrayBuffer) {
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 2) return;
    const dv = new DataView(buf);
    const jlen = dv.getUint32(4, true);
    let meta: any;
    try { meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jlen))); } catch { return; }
    const off = align4(8 + jlen);
    const deinterleave = () => {
      const nch = meta.nch || 2;
      const nframes = meta.nframes || 0;
      const inter = new Float32Array(buf, off, nframes * nch);
      const channels = Array.from({ length: nch }, () => new Float32Array(nframes));
      for (let i = 0; i < nframes; i++) for (let c = 0; c < nch; c++) channels[c][i] = inter[i * nch + c];
      return channels;
    };
    // (v8) Un stem séparé : mis de côté jusqu'à la réponse finale STEMS_SEPARATE.
    if (meta.action === 'STEMS_STEM') {
      if (!this.pending.has(meta.req_id)) return;
      const list = this.stemFrames.get(meta.req_id) || [];
      list.push({ key: String(meta.key), label: String(meta.label || meta.key), channels: deinterleave(),
        sampleRate: Number(meta.sample_rate) || 44100, path: String(meta.path || '') });
      this.stemFrames.set(meta.req_id, list);
      return;
    }
    // (v9) Un clip rendu par Melodyne / VocAlign : gardé jusqu'à la réponse finale.
    if (meta.action === 'ARA_RENDERED') {
      if (!this.pending.has(meta.req_id)) return;
      const list = this.araFrames.get(meta.req_id) || [];
      list.push({ clipId: String(meta.clip_id), channels: deinterleave(), sampleRate: Number(meta.sample_rate) || 44100 });
      this.araFrames.set(meta.req_id, list);
      return;
    }
    const p = this.pending.get(meta.req_id);
    if (!p) return;
    this.pending.delete(meta.req_id);
    window.clearTimeout(p.timer);
    if (meta.action === 'ARA_COMMIT' || meta.action === 'ARA_ALIGN') {
      const renders = this.araFrames.get(meta.req_id) || [];
      this.araFrames.delete(meta.req_id);
      if (!meta.success) p.reject(new Error(meta.error || 'Rendu du plugin impossible'));
      else p.resolve({ ...meta, renders });
      return;
    }
    if (meta.action === 'STEMS_SEPARATE') {
      const stems = this.stemFrames.get(meta.req_id) || [];
      this.stemFrames.delete(meta.req_id);
      if (!meta.success) {
        const code = meta.code === 'not_installed' || meta.code === 'cancelled' ? meta.code : 'error';
        p.reject(new StemsError(meta.error || 'Séparation impossible', code));
      } else p.resolve({ ...meta, stems });
      return;
    }
    if (!meta.success) { p.reject(new Error(meta.error || 'Rendu VST impossible')); return; }
    p.resolve({ ...meta, channels: deinterleave() });
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
      isInstrument: typeof p.is_instrument === 'boolean' ? p.is_instrument : (p.category === 'Instrument' ? true : null),
      license: p.license === 'activation' || p.license === 'nag' ? p.license : null,
      scanStatus: p.scan_status ?? null,
      ...(p.shell ? { shell: String(p.shell), family: p.family ?? null, channels: p.channels ?? null } : {}),
      ...(p.unstable ? { unstable: true } : {}),
      ...(p.quarantined ? { quarantined: true } : {}),
    }));
    const prog = Array.isArray(r.probe_progress) ? r.probe_progress : null;
    this.setBridgeState({
      pluginCount: this.plugins.length,
      instrumentsPending: r.instruments_pending ? [Number(prog?.[0]) || 0, Number(prog?.[1]) || 0] : null,
    });
    return this.plugins;
  }

  /** Instruments VST3 du PC (la liste suit la lecture faite par le pont). */
  getCachedInstruments(): BridgePlugin[] { return this.plugins.filter(p => p.isInstrument === true); }

  /** Plugins pas encore lus parce qu'ils demandent une activation (peut-être des instruments). */
  getCachedToActivate(): BridgePlugin[] {
    return this.plugins.filter(p => p.isInstrument !== true && p.isInstrument !== false && (!!p.license || p.scanStatus === 'activation'));
  }

  // --- Fenêtres de licence (pont v6) ---------------------------------------

  private licenseListeners = new Set<(e: LicenseWindowEvent) => void>();
  private licenseDoneListeners = new Set<(path: string) => void>();

  /** Un plugin a ouvert sa fenêtre d'activation (ramenée au premier plan sur le PC). */
  onLicenseWindow(cb: (e: LicenseWindowEvent) => void): () => void {
    this.licenseListeners.add(cb);
    return () => { this.licenseListeners.delete(cb); };
  }

  /** « C'est fait » : le musicien a activé le plugin, les chargements / rendus ratés sont relancés. */
  onLicenseDone(cb: (path: string) => void): () => void {
    this.licenseDoneListeners.add(cb);
    return () => { this.licenseDoneListeners.delete(cb); };
  }

  licenseDone(path: string) {
    this.licenseDoneListeners.forEach(cb => { try { cb(path); } catch { /* écouteur fautif */ } });
  }

  private onLicenseWindowMsg(msg: any) {
    // Le chargement / rendu attend la fermeture de la fenêtre : on lui laisse le temps.
    this.pending.forEach((p, id) => {
      window.clearTimeout(p.timer);
      p.timer = window.setTimeout(() => {
        this.pending.delete(id);
        p.reject(new Error('Le pont VST ne répond pas'));
      }, LICENSE_WAIT_MS);
    });
    const e: LicenseWindowEvent = {
      plugin: String(msg.plugin || 'Le plugin'), path: String(msg.path || ''), pluginName: msg.plugin_name ?? null,
      title: String(msg.title || ''), status: msg.status === 'nag' ? 'nag' : 'activation',
      source: msg.source || 'load', slotId: msg.slot_id ?? null,
    };
    this.plugins = this.plugins.map(p => (p.path === e.path ? { ...p, license: e.status } : p));
    // (v7) Chargement discret posé par NOVA (autotune, mix auto) : la fenêtre a été
    // fermée par le pont, le plugin passe « non disponible » ; rien à montrer.
    if (msg.quiet) return;
    this.licenseListeners.forEach(cb => { try { cb(e); } catch { /* écouteur fautif */ } });
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

  /**
   * quiet (pont v7) : chargement décidé par NOVA (autotune, mix auto) ; une fenêtre
   * de licence / démo est fermée par le pont et le chargement échoue
   * (erreur.licenseRequired) au lieu de faire surgir une fenêtre.
   */
  async loadPlugin(opts: { slotId: string; path: string; pluginName?: string | null; sampleRate: number; stateB64?: string | null; quiet?: boolean; ara?: string | null }): Promise<LoadResult> {
    const r = await this.request({
      action: 'LOAD_PLUGIN', slot_id: opts.slotId, path: opts.path, plugin_name: opts.pluginName || null,
      sample_rate: Math.round(opts.sampleRate), state: opts.stateB64 || null, ...(opts.quiet ? { quiet: true } : {}),
      // (v12) Insert ARA (Melodyne, VocAlign) : servi par l'hôte natif, comme dans Pro Tools.
      ...(opts.ara ? { ara: opts.ara } : {}),
    }, opts.quiet || opts.ara ? 180000 : 60000);
    return {
      name: r.name || '', vendor: r.vendor || '',
      latencySamples: Number(r.latency_samples) || 0,
      bufferLatencySamples: Number(r.buffer_latency_samples) || 0,
      stateB64: r.state || null,
      isInstrument: !!r.is_instrument,
      sidechainInputs: typeof r.sidechain_inputs === 'number' ? r.sidechain_inputs : null,
    };
  }

  unloadPlugin(slotId: string) {
    if (this.isConnected()) this.request({ action: 'UNLOAD_PLUGIN', slot_id: slotId }).catch(() => { /* déjà parti */ });
  }

  async getPluginState(slotId: string): Promise<string | null> {
    const r = await this.request({ action: 'GET_STATE', slot_id: slotId });
    return r.state || null;
  }

  /** Empreinte de l'état (sans l'état) : suivi léger d'une fenêtre de plugin ouverte. */
  async getPluginStateHash(slotId: string): Promise<string | null> {
    const r = await this.request({ action: 'GET_STATE', slot_id: slotId, hash_only: true });
    return r.hash || null;
  }

  async setPluginState(slotId: string, stateB64: string): Promise<boolean> {
    const r = await this.request({ action: 'SET_STATE', slot_id: slotId, state: stateB64 });
    return !!r.success;
  }

  /** (v7) Paramètres du plugin chargé : clé, valeur brute, valeur texte, choix possibles. */
  async getParams(slotId: string, names?: string[]): Promise<any[]> {
    // Passe par le thread des plugins du pont, après les chargements en cours (≈ 5 s chacun).
    const r = await this.request({ action: 'GET_PARAMS', slot_id: slotId, ...(names ? { names } : {}) }, 120000);
    return Array.isArray(r.parameters) ? r.parameters : [];
  }

  /** (v7) Réglage groupé par texte / valeur réelle / brute ; renvoie les valeurs relues. */
  async setParams(slotId: string, params: { name: string; text?: string; real?: number; value?: number }[]): Promise<SetParamsResult> {
    if (!this.state.paramsText) throw new Error('Mets à jour le pont VST (version 7) pour régler les plugins.');
    const r = await this.request({ action: 'SET_PARAMS', slot_id: slotId, params: params.map(({ name, text, real, value }) => ({ name, text, real, value })) }, 120000);
    return { results: r.results || [], latencySamples: Number(r.latency_samples) || 0, latencyChanged: !!r.latency_changed };
  }

  // --- Automation des VST (v11, R9) ---------------------------------------------

  /** Réglages automatisables du plugin chargé (lus sans conversion texte : rapide même pour 700 réglages). */
  async automatable(slotId: string): Promise<VstAutomatableParam[]> {
    if (!this.state.automation) return [];
    const r = await this.request({ action: 'AUTOMATABLE', slot_id: slotId }, 60000);
    return (Array.isArray(r.parameters) ? r.parameters : []).map((p: any) => ({
      name: String(p.name), displayName: String(p.display_name || p.name), value: Number(p.value) || 0, text: String(p.text ?? ''),
      ...(p.label ? { label: String(p.label) } : {}), ...(typeof p.num_steps === 'number' ? { numSteps: p.num_steps } : {}),
      ...(p.is_boolean ? { isBoolean: true } : {}),
    }));
  }

  /** Table index → réglage des blocs temps réel (les valeurs automatisées partent avec l'audio). */
  async setAutomationMap(slotId: string, names: string[]): Promise<{ missing: string[] }> {
    const r = await this.request({ action: 'SET_AUTOMATION_MAP', slot_id: slotId, names }, 30000);
    return { missing: Array.isArray(r.missing) ? r.missing : [] };
  }

  /** Texte affiché par le plugin pour les valeurs brutes 0, 1/steps, … 1. */
  async paramTexts(slotId: string, names: string[], steps = 100): Promise<Record<string, string[]>> {
    const r = await this.request({ action: 'PARAM_TEXTS', slot_id: slotId, names, steps }, 60000);
    return r.texts || {};
  }

  /** Écriture : signaler les réglages bougés dans la fenêtre du plugin (PARAM_CHANGED). */
  async watchParams(slotId: string, on: boolean): Promise<void> {
    if (!this.state.automation) return;
    await this.request({ action: 'WATCH_PARAMS', slot_id: slotId, on }, 30000);
  }

  async automationStats(slotId: string): Promise<{ applied: number; skipped: number; watching: boolean }> {
    const r = await this.request({ action: 'AUTOMATION_STATS', slot_id: slotId });
    return { applied: Number(r.applied) || 0, skipped: Number(r.skipped) || 0, watching: !!r.watching };
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
    /** (v11, R9) Automation rejouée à l'échantillon près pendant le rendu. */
    automation?: VstAutomationLane[];
    /** (v11, R10) Clé de side-chain (2 canaux, même longueur que le son). */
    key?: Float32Array[] | null;
  }): Promise<Float32Array[]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Pont VST non connecté');
    const main = opts.channels.slice(0, 2);
    const nframes = main[0]?.length || 0;
    // Clé : son en 4 canaux (principal G/D puis clé G/D), comme les blocs temps réel.
    const key = opts.key && opts.key.length ? [opts.key[0], opts.key[1] || opts.key[0]] : null;
    const chans = key ? [main[0], main[1] || main[0], key[0], key[1]] : main;
    const nch = Math.max(1, chans.length);
    const req_id = this.nextId++;
    const meta = JSON.stringify({
      action: 'RENDER', req_id, slot_id: opts.slotId || null, path: opts.path || null,
      plugin_name: opts.pluginName || null, state: opts.stateB64 || null,
      sample_rate: Math.round(opts.sampleRate), nch, nframes, tail_seconds: opts.tailSeconds || 0,
      ...(opts.automation && opts.automation.length ? { automation: opts.automation } : {}),
      ...(key ? { sidechain: true } : {}),
    });
    const buf = encodeType2Frame(meta, chans.map(c => (c.length === nframes ? c : padTo(c, nframes))));
    // Le rendu d'un long morceau peut prendre du temps sur un gros plugin.
    const timeoutMs = 60000 + (nframes / Math.max(1, opts.sampleRate)) * 4000;
    const res = await new Promise<any>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(req_id); reject(new Error('Rendu VST trop long')); }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      ws.send(buf);
    });
    return res.channels as Float32Array[];
  }

  /**
   * (v10) Calage « réduction cible » d'un compresseur VST de la piste : le pont
   * rend la voix hors ligne, cherche par dichotomie la valeur de `param`
   * (valeur réelle du plugin, entre lo et hi ; sense = +1 si monter le réglage
   * comprime plus) qui donne `targetDb` de réduction max au VU, puis pose ce
   * réglage sur l'instance de la piste.
   */
  async calibrateGr(opts: { slotId: string; param: string; lo: number; hi: number; sense: 1 | -1; targetDb: number;
    sampleRate: number; channels: Float32Array[] }): Promise<{ value: number; text?: string; grDb: number; reached: boolean; why?: string; steps: { value: number; gr_db: number }[] }> {
    if (!this.state.calibrateGr) throw new Error('Mets à jour Nova Studio pour Windows pour caler tes compresseurs VST.');
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Pont VST non connecté');
    const nch = Math.max(1, Math.min(2, opts.channels.length));
    const nframes = opts.channels[0]?.length || 0;
    const req_id = this.nextId++;
    const meta = JSON.stringify({
      action: 'CALIBRATE_GR', req_id, slot_id: opts.slotId, param: opts.param, lo: opts.lo, hi: opts.hi, sense: opts.sense,
      target_db: opts.targetDb, sample_rate: Math.round(opts.sampleRate), nch, nframes,
    });
    const buf = encodeType2Frame(meta, opts.channels.slice(0, nch));
    const timeoutMs = 60000 + (nframes / Math.max(1, opts.sampleRate)) * 4000 * 14;
    const res = await new Promise<any>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(req_id); reject(new Error('Calage trop long')); }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      ws.send(buf);
    });
    return { value: Number(res.value), text: res.text, grDb: Number(res.gr_db), reached: !!res.reached, why: res.why, steps: res.steps || [] };
  }

  /**
   * Instrument VST3 (pont v5) : notes -> audio stéréo, hors temps réel.
   * slotId : son réglé dans l'instance chargée (fenêtre comprise) ; sinon
   * instance temporaire avec path / stateB64. Durée = lengthSeconds + tailSeconds.
   */
  async renderInstrument(opts: {
    slotId?: string | null; path?: string; pluginName?: string | null; stateB64?: string | null;
    sampleRate: number; notes: InstrumentNote[]; controllers?: InstrumentController[]; lengthSeconds: number; tailSeconds?: number;
  }): Promise<Float32Array[]> {
    if (!this.state.instruments) throw new Error('Mets à jour le pont VST pour utiliser tes instruments.');
    const seconds = opts.lengthSeconds + (opts.tailSeconds || 0);
    const r = await this.request({
      action: 'RENDER_INSTRUMENT', slot_id: opts.slotId || null, path: opts.path || null,
      plugin_name: opts.pluginName || null, state: opts.slotId ? null : (opts.stateB64 || null),
      sample_rate: Math.round(opts.sampleRate), notes: opts.notes,
      // Pont plus ancien : champ ignoré (les notes seules sont rendues).
      ...(opts.controllers && opts.controllers.length ? { controllers: opts.controllers } : {}),
      length_seconds: opts.lengthSeconds, tail_seconds: opts.tailSeconds || 0,
    }, 60000 + seconds * 4000);
    return r.channels as Float32Array[];
  }

  // --- Séparation de stems (pont v8) ----------------------------------------

  /** Progression de l'installation du module ou d'une séparation. */
  onStemsEvent(cb: (e: StemsEvent) => void): () => void {
    this.stemsListeners.add(cb);
    return () => { this.stemsListeners.delete(cb); };
  }

  private onStemsEventMsg(msg: any) {
    const e: StemsEvent = {
      kind: msg.kind === 'install' ? 'install' : 'separate', event: String(msg.event || 'progress'),
      jobId: msg.job_id ?? null, pct: typeof msg.pct === 'number' ? msg.pct : undefined,
      message: msg.message, step: msg.step, device: msg.device,
    };
    // Une séparation qui avance n'a pas expiré : on repousse son délai.
    const reqId = e.jobId ? this.stemsJobs.get(e.jobId) : undefined;
    const p = reqId !== undefined ? this.pending.get(reqId) : undefined;
    if (p && reqId !== undefined) {
      window.clearTimeout(p.timer);
      p.timer = window.setTimeout(() => {
        this.pending.delete(reqId);
        this.stemFrames.delete(reqId);
        p.reject(new StemsError('Le pont ne donne plus de nouvelles de la séparation', 'error'));
      }, STEMS_SILENCE_MS);
    }
    this.stemsListeners.forEach(cb => { try { cb(e); } catch { /* écouteur fautif */ } });
  }

  private requireStems() {
    if (!this.isConnected()) throw new StemsError('Pont non connecté', 'unavailable');
    if (!this.state.stems) throw new StemsError('Mets à jour Nova Studio pour Windows pour séparer les stems.', 'unavailable');
  }

  async stemsStatus(): Promise<StemsModuleStatus> {
    this.requireStems();
    const r = await this.request({ action: 'STEMS_STATUS' });
    return parseStemsStatus(r);
  }

  /** Installe le module (Demucs + PyTorch) sur le PC, en arrière-plan. */
  async stemsInstall(variant: 'cpu' | 'cuda' | 'auto' = 'cpu'): Promise<StemsModuleStatus> {
    this.requireStems();
    const r = await this.request({ action: 'STEMS_INSTALL', variant });
    return parseStemsStatus(r);
  }

  async stemsCancel(target: { jobId: string } | { install: true }): Promise<boolean> {
    if (!this.isConnected()) return false;
    const r = await this.request('install' in target ? { action: 'STEMS_CANCEL', install: true }
      : { action: 'STEMS_CANCEL', job_id: target.jobId });
    return !!r.cancelled;
  }

  /** Sépare un buffer (voix / instru ou 4 stems). Rejette avec StemsError. */
  async separateStems(opts: {
    jobId: string; channels: Float32Array[]; sampleRate: number; stems: 2 | 4; project?: string; clip?: string;
  }): Promise<SeparationResult> {
    this.requireStems();
    const ws = this.ws!;
    const req_id = this.nextId++;
    const buf = buildType2Frame({
      action: 'STEMS_SEPARATE', req_id, job_id: opts.jobId, stems: opts.stems,
      sample_rate: Math.round(opts.sampleRate), project: opts.project || 'Projet', clip: opts.clip || 'clip',
    }, opts.channels);
    this.stemsJobs.set(opts.jobId, req_id);
    try {
      const res = await new Promise<any>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(req_id);
          this.stemFrames.delete(req_id);
          reject(new StemsError('Le pont ne répond pas à la séparation', 'error'));
        }, STEMS_SILENCE_MS);
        this.pending.set(req_id, { resolve, reject, timer });
        ws.send(buf);
      });
      return { stems: res.stems, seconds: Number(res.seconds) || 0, device: String(res.device || 'cpu'), outdir: String(res.outdir || '') };
    } finally {
      this.stemsJobs.delete(opts.jobId);
    }
  }

  // --- Plugins ARA : Melodyne, VocAlign (pont v9) ----------------------------

  onAraEvent(cb: (e: AraEvent) => void): () => void {
    this.araListeners.add(cb);
    return () => { this.araListeners.delete(cb); };
  }

  async araStatus(): Promise<AraStatus> {
    if (!this.isConnected() || !this.state.ara) return { host: false, plugins: {} };
    const r = await this.request({ action: 'ARA_STATUS' }, 40000);
    return { host: !!r.host, plugins: r.plugins || {} };
  }

  /** Requête binaire (clips audio à la suite) ; la réponse arrive en JSON ou en trames. */
  private sendAraFrame(meta: Record<string, any>, clips: { channels: Float32Array[] }[], timeoutMs: number): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Pont VST non connecté'));
    const req_id = this.nextId++;
    const buf = encodeMultiClipFrame({ ...meta, req_id }, clips.map(c => c.channels));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(req_id);
        this.araFrames.delete(req_id);
        reject(new Error('Le plugin ne répond pas'));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      ws.send(buf);
    });
  }

  /** Ouvre des clips dans Melodyne (fenêtre du plugin sur le PC, notes déjà analysées). */
  async araOpen(opts: { sessionId: string; plugin: 'melodyne'; sampleRate: number; tempo: number; archive?: string; clips: AraClipIn[]; offscreen?: boolean }): Promise<AraOpenResult> {
    const seconds = opts.clips.reduce((a, c) => a + (c.channels[0]?.length || 0), 0) / opts.sampleRate;
    const r = await this.sendAraFrame({
      action: 'ARA_OPEN', session_id: opts.sessionId, plugin: opts.plugin, sample_rate: Math.round(opts.sampleRate),
      tempo: opts.tempo, archive_b64: opts.archive || '', offscreen: !!opts.offscreen,
      clips: opts.clips.map(c => ({ id: c.id, name: c.name, track: c.track || c.name, role: c.role || 'edit', start: c.start || 0,
        persistent_id: c.persistentId || c.id, nch: Math.min(2, c.channels.length), nframes: c.channels[0]?.length || 0 })),
    }, opts.clips, 120000 + seconds * 2000);
    return { sessionId: r.session_id, pluginName: r.plugin_name, pluginVersion: r.plugin_version, restored: !!r.restored,
      analysisSeconds: r.analysis_seconds, notes: r.notes || {} };
  }

  /** VocAlign : cale les doubles sur le guide. interactive : fenêtre ouverte, puis araCommit(). */
  async araAlign(opts: { sessionId: string; sampleRate: number; interactive: boolean; guide: AraClipIn; dubs: AraClipIn[] }): Promise<{ waiting: boolean; renders: AraRender[] }> {
    const meta = (c: AraClipIn) => ({ id: c.id, name: c.name, nch: Math.min(2, c.channels.length), nframes: c.channels[0]?.length || 0 });
    const seconds = (opts.guide.channels[0]?.length || 0) / opts.sampleRate;
    const r = await this.sendAraFrame({
      action: 'ARA_ALIGN', session_id: opts.sessionId, sample_rate: Math.round(opts.sampleRate), interactive: opts.interactive,
      guide: meta(opts.guide), dubs: opts.dubs.map(meta),
    }, [opts.guide, ...opts.dubs], 120000 + seconds * 3000 * Math.max(1, opts.dubs.length));
    return { waiting: !!r.waiting, renders: r.renders || [] };
  }

  /** « Valider » : rendu des clips de la session (et archive ARA de Melodyne). */
  async araCommit(sessionId: string, timeoutMs = 600000): Promise<{ renders: AraRender[]; archive?: string }> {
    const r = await this.request({ action: 'ARA_COMMIT', session_id: sessionId }, timeoutMs);
    return { renders: r.renders || [], archive: r.archive_b64 || undefined };
  }

  async araShow(sessionId: string): Promise<void> { await this.request({ action: 'ARA_SHOW', session_id: sessionId }); }

  async araClose(sessionId: string): Promise<void> {
    if (!this.isConnected()) return;
    try { await this.request({ action: 'ARA_CLOSE', session_id: sessionId }); } catch { /* déjà fermée */ }
  }

  // --- Insert ARA sur une piste (pont v12, comme Pro Tools) -----------------------

  /** Évènements d'un insert ARA (transport demandé par le plugin, retouches, fenêtre fermée). */
  onAraInsertEvent(slotId: string, cb: (e: any) => void): () => void {
    let set = this.araInsertListeners.get(slotId);
    if (!set) { set = new Set(); this.araInsertListeners.set(slotId, set); }
    set.add(cb);
    return () => { set!.delete(cb); if (set!.size === 0) this.araInsertListeners.delete(slotId); };
  }

  /** Un fichier son de la piste confié à l'insert (une fois par son). */
  async araInsertSource(slotId: string, src: { id: string; name: string; sampleRate: number; channels: Float32Array[] }): Promise<void> {
    const ch = src.channels.slice(0, 2);
    await this.sendAraFrame({
      action: 'ARA_INSERT_SOURCE', slot_id: slotId, id: src.id, name: src.name, sample_rate: Math.round(src.sampleRate),
      nch: ch.length, nframes: ch[0]?.length || 0,
    }, [{ channels: ch }], 120000 + (ch[0]?.length || 0) / Math.max(1, src.sampleRate) * 1000);
  }

  /** Document ARA de la piste (sons, clips, tempo, accords) ; applied=false + missing : sons à envoyer d'abord. */
  async araInsertDoc(slotId: string, doc: Record<string, any>): Promise<{ applied: boolean; missing?: string[]; [k: string]: any }> {
    const r = await this.request({ action: 'ARA_INSERT_DOC', slot_id: slotId, ...doc }, 180000);
    return { ...r, applied: r.applied !== false, missing: Array.isArray(r.missing) ? r.missing.map(String) : undefined };
  }

  async araInsertState(slotId: string, opts: { notes?: boolean; waitAnalysisS?: number } = {}): Promise<any> {
    return this.request({ action: 'ARA_INSERT_STATE', slot_id: slotId, notes: opts.notes !== false,
      ...(opts.waitAnalysisS !== undefined ? { wait_analysis_s: opts.waitAnalysisS } : {}) }, 60000 + (opts.waitAnalysisS || 0) * 1000);
  }

  /** Éditeur du plugin : ancré dans l'appli (dock, bounds), flottant (float) ou masqué (hide). */
  async araInsertEditor(slotId: string, opts: { mode: 'dock' | 'bounds' | 'float' | 'hide'; parent?: number; x?: number; y?: number; w?: number; h?: number; visible?: boolean; release?: boolean; offscreen?: boolean }): Promise<any> {
    return this.request({ action: 'ARA_INSERT_EDITOR', slot_id: slotId, ...opts }, 60000);
  }

  async araInsertSelect(slotId: string, regions: string[]): Promise<void> {
    await this.request({ action: 'ARA_INSERT_SELECT', slot_id: slotId, regions }, 30000);
  }

  /** Rendu hors ligne de la piste à travers l'insert ARA (export, gel, bounce) : temps du morceau. */
  async araInsertRender(slotId: string, start: number, duration: number, sampleRate: number): Promise<Float32Array[]> {
    const r = await this.request({ action: 'ARA_INSERT_RENDER', slot_id: slotId, start, duration, sample_rate: Math.round(sampleRate) },
      120000 + duration * 4000);
    return r.channels as Float32Array[];
  }

  async araInsertParams(slotId: string): Promise<{ id: number; title: string; value: number; text: string }[]> {
    const r = await this.request({ action: 'ARA_INSERT_PARAMS', slot_id: slotId }, 30000);
    return r.params || [];
  }

  async araInsertParam(slotId: string, p: { title?: string; id?: number; value: number }): Promise<{ text: string; value: number }> {
    const r = await this.request({ action: 'ARA_INSERT_PARAM', slot_id: slotId, ...p }, 30000);
    return { text: String(r.text ?? ''), value: Number(r.value) || 0 };
  }

  /** Capture PNG de la fenêtre du plugin (preuves, assistance). */
  async araInsertSnapshot(slotId: string, path: string): Promise<any> {
    return this.request({ action: 'ARA_INSERT_SNAPSHOT', slot_id: slotId, path }, 30000);
  }

  // --- Audio temps réel ---------------------------------------------------

  private ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker(`${import.meta.env.BASE_URL}worklets/vst-bridge-worker-v5.js`);
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

/** Sans nouvelles du pont pendant une séparation (pas une durée totale). */
const STEMS_SILENCE_MS = 120000;

function parseStemsStatus(r: any): StemsModuleStatus {
  const ev = r.install;
  return {
    installed: !!r.installed, installing: !!r.installing,
    install: ev ? { kind: 'install', event: String(ev.event || 'progress'), pct: ev.pct, message: ev.message, step: ev.step } : null,
    variant: r.variant === 'cuda' ? 'cuda' : r.variant === 'cpu' ? 'cpu' : null,
    sizeBytes: typeof r.size_bytes === 'number' ? r.size_bytes : null,
    outputRoot: r.output_root || null,
  };
}

/** Trame binaire type 2 : en-tête JSON + float32 entrelacés (voir nova_bridge_server.py). */
export function encodeType2Frame(meta: string, channels: Float32Array[]): ArrayBuffer {
  const nch = channels.length;
  const nframes = channels[0]?.length || 0;
  const j = new TextEncoder().encode(meta);
  const off = align4(8 + j.length);
  const buf = new ArrayBuffer(off + nframes * nch * 4);
  const u8 = new Uint8Array(buf);
  u8[0] = 2;
  new DataView(buf).setUint32(4, j.length, true);
  u8.set(j, 8);
  const inter = new Float32Array(buf, off, nframes * nch);
  for (let c = 0; c < nch; c++) {
    const ch = channels[c];
    for (let i = 0; i < nframes; i++) inter[i * nch + c] = ch[i];
  }
  return buf;
}

/** Trame type 2 avec plusieurs clips : audio de chaque clip entrelacé, à la suite (ARA_OPEN, ARA_ALIGN). */
export function encodeMultiClipFrame(meta: Record<string, any>, clips: Float32Array[][]): ArrayBuffer {
  const j = new TextEncoder().encode(JSON.stringify(meta));
  const off = align4(8 + j.length);
  const total = clips.reduce((a, ch) => a + (ch[0]?.length || 0) * Math.min(2, ch.length), 0);
  const buf = new ArrayBuffer(off + total * 4);
  const u8 = new Uint8Array(buf);
  u8[0] = 2;
  new DataView(buf).setUint32(4, j.length, true);
  u8.set(j, 8);
  const inter = new Float32Array(buf, off, total);
  let o = 0;
  for (const chs of clips) {
    const ch = chs.slice(0, 2);
    const n = ch[0]?.length || 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch.length; c++) inter[o++] = ch[c][i];
  }
  return buf;
}

function padTo(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(x.subarray(0, n));
  return out;
}

function buildType2Frame(meta: Record<string, any>, channels: Float32Array[]): ArrayBuffer {
  const ch = channels.slice(0, 2);
  return encodeType2Frame(JSON.stringify({ ...meta, nch: ch.length, nframes: ch[0]?.length || 0 }), ch);
}

export const novaBridge = new NovaBridgeService();
(globalThis as any).__novaBridge = novaBridge; // diagnostic (tests, console)
