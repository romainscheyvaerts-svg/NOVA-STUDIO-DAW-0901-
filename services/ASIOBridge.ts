/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                    NOVA ASIO BRIDGE - Client TypeScript                      ║
 * ║                                                                              ║
 * ║  Service TypeScript pour connecter le DAW web au bridge ASIO Python          ║
 * ║  Permet le streaming audio bidirectionnel avec une carte son ASIO            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import { decodeFileChunk, decodeInputMessage, encodeOutputInterleaved, encodeOutputMessage, FileChunk, InputBlock, joinFileChunks } from '../utils/asioProtocol';
import type { BridgeLoss } from '../utils/bridgeTake';

// Types pour la configuration ASIO
export interface ASIOConfig {
  device_name: string | null;
  sample_rate: number;
  block_size: number;
  input_channels: number;
  output_channels: number;
}

// Types pour les périphériques audio
export interface AudioDevice {
  id: number;
  name: string;
  max_input_channels: number;
  max_output_channels: number;
  default_sample_rate: number;
  hostapi: string;
  is_asio: boolean;
}

// Types pour les statistiques
export interface ASIOStats {
  is_running: boolean;
  sample_rate: number;
  block_size: number;
  latency_ms: number;
  /** Attente actuelle dans la file de sortie du pont (ms). */
  queue_ms?: number;
  input_level: number;
  output_level: number;
  buffer_underruns: number;
  buffer_overruns: number;
  blocks_processed: number;
  elapsed_seconds: number;
  input_buffer_size: number;
  output_buffer_size: number;
  /** R15 : canaux réellement ouverts et latences du pilote, séparées. */
  input_channels?: number;
  output_channels?: number;
  input_latency_ms?: number;
  output_latency_ms?: number;
  frames_in?: number;
}

/** R15 : flux démarré (ou recréé après un changement de tampon). */
export interface ASIOStreamInfo {
  latency_ms?: number;
  input_latency_ms?: number;
  output_latency_ms?: number;
  block_size?: number;
  sample_rate?: number;
  input_channels?: number;
  output_channels?: number;
}

/** R15 : latence aller-retour mesurée par entrée (échantillons, null = pas de retour). */
export interface ASIOLatencyResult {
  success: boolean;
  delays?: (number | null)[];
  sample_rate?: number;
  block_size?: number;
  input_latency_ms?: number;
  output_latency_ms?: number;
  error?: string;
}

/** Chantier C1 · Prise écrite par le pont : un fichier par piste. */
export interface BridgeTakeFile { track_id: string; path: string; frames: number; channels: number; inputs: number[]; mode: string }
export interface BridgeTakeInfo {
  success: boolean;
  take_id: string;
  error?: string;
  status?: string;
  sample_rate?: number;
  block_size?: number;
  start_frame?: number;
  end_frame?: number;
  dir?: string;
  meta?: string;
  files?: BridgeTakeFile[];
  losses?: BridgeLoss[];
  lost_blocks?: number;
  lost_frames?: number;
}
export interface BridgeTakeTrack { track_id: string; name: string; inputs: number[]; mode: 'mono' | 'stereo' | 'sum' }
export interface BridgeFetched {
  buffer: ArrayBuffer;
  path: string;
  meta: { sample_rate?: number; start_frame?: number; end_frame?: number; anchor?: any; losses?: BridgeLoss[]; lost_blocks?: number; status?: string; block_size?: number };
}

// Types pour les messages WebSocket
interface ASIOMessageHandlers {
  onDevices?: (devices: AudioDevice[], asioDevices: AudioDevice[]) => void;
  onConfigSet?: (success: boolean, config?: ASIOConfig, error?: string) => void;
  onConfig?: (config: ASIOConfig) => void;
  onStreamStarted?: (success: boolean, latency_ms?: number, error?: string, info?: ASIOStreamInfo) => void;
  onStreamStopped?: (success: boolean) => void;
  onStats?: (stats: ASIOStats) => void;
  /** Bloc d'entrée (v2 : avec son n° d'échantillon dans `block`). */
  onAudioInput?: (audioData: Float32Array, channels: number, block?: InputBlock) => void;
  onConfigResult?: (message: any) => void;
  onError?: (error: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * Client ASIO Bridge pour le DAW web
 * 
 * Permet de:
 * - Se connecter au serveur ASIO Bridge Python
 * - Envoyer de l'audio vers la carte son
 * - Recevoir l'audio d'entrée de la carte son
 * - Configurer les paramètres ASIO
 */
export class ASIOBridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: ASIOMessageHandlers = {};
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;
  /** Protocole binaire négocié avec le pont : 2 = blocs horodatés et sorties multiples (R15). */
  public protocol = 1;
  /** Fonctions annoncées par le pont (HELLO_OK) : 'take_writer' = il écrit les prises lui-même. */
  public features: string[] = [];
  private latencyWaiters: ((r: ASIOLatencyResult) => void)[] = [];
  /** Réponses attendues aux commandes de prise (action + identifiant). */
  private recWaiters = new Map<string, (m: any) => void>();
  private fetches = new Map<number, { chunks: FileChunk[]; done: (r: BridgeFetched | null) => void }>();
  private fetchSeq = 1;

  constructor(host: string = '127.0.0.1', port: number = 8766) {
    // Port de test (pont simulé) : jamais celui du pont du studio par accident.
    try { const p = parseInt(localStorage.getItem('nova_asio_port') || '', 10); if (p > 0 && p < 65536) port = p; } catch { /* défaut */ }
    this.url = `ws://${host}:${port}`;
  }

  /**
   * Définir les gestionnaires d'événements
   */
  setHandlers(handlers: ASIOMessageHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Se connecter au serveur ASIO Bridge
   */
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log('[ASIO Bridge] Connected to', this.url);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.protocol = 1;
          this.features = [];
          // R15 : on annonce le protocole v2 (un ancien pont l'ignore et garde le v1).
          try { this.ws!.send(JSON.stringify({ action: 'HELLO', protocol: 2 })); } catch { /* */ }
          this.startPing();
          this.handlers.onConnect?.();
          resolve(true);
        };

        this.ws.onclose = () => {
          console.log('[ASIO Bridge] Disconnected');
          this.isConnected = false;
          this.failPending();
          this.stopPing();
          this.handlers.onDisconnect?.();
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[ASIO Bridge] Error:', error);
          this.handlers.onError?.('WebSocket error');
          resolve(false);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

      } catch (error) {
        console.error('[ASIO Bridge] Connection error:', error);
        resolve(false);
      }
    });
  }

  /**
   * Se déconnecter du serveur
   */
  disconnect(): void {
    // Déconnexion voulue : pas de reconnexion automatique derrière (elle reprenait la main
    // en silence, sans que le moteur la voie).
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * Vérifier si connecté
   */
  isConnectedToServer(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Gérer les messages entrants
   */
  private handleMessage(data: ArrayBuffer | string): void {
    // Message binaire = audio d'entrée
    if (data instanceof ArrayBuffer) {
      this.handleBinaryAudio(data);
      return;
    }

    // Message JSON
    try {
      const message = JSON.parse(data as string);
      const action = message.action;

      switch (action) {
        case 'PONG':
          // Réponse au ping - connexion active
          break;

        case 'DEVICES':
          this.handlers.onDevices?.(message.devices, message.asio_devices);
          break;

        case 'HELLO_OK':
          this.protocol = message.protocol >= 2 ? 2 : 1;
          this.features = Array.isArray(message.features) ? message.features : [];
          break;

        case 'REC_STARTED':
        case 'REC_STOPPED':
        case 'REC_ANCHORED':
        case 'REC_IMPORTED_OK': {
          const w = this.recWaiters.get(`${action}:${message.take_id}`);
          if (w) { this.recWaiters.delete(`${action}:${message.take_id}`); w(message); }
          break;
        }

        case 'REC_FETCHED': {
          const f = this.fetches.get(message.req);
          if (!f) break;
          this.fetches.delete(message.req);
          const buffer = message.success ? joinFileChunks(f.chunks) : null;
          f.done(buffer ? { buffer, path: message.path, meta: message.meta || {} } : null);
          break;
        }

        case 'CONFIG_SET':
          this.handlers.onConfigSet?.(message.success, message.config, message.error);
          this.handlers.onConfigResult?.(message);
          break;

        case 'LATENCY_MEASURED': {
          const w = this.latencyWaiters;
          this.latencyWaiters = [];
          w.forEach(f => f(message));
          break;
        }

        case 'MONITOR_SET':
          break;

        case 'CONFIG':
          this.handlers.onConfig?.(message.config);
          break;

        case 'STREAM_STARTED':
          this.handlers.onStreamStarted?.(message.success, message.latency_ms, message.error, message);
          break;

        case 'STREAM_STOPPED':
          this.handlers.onStreamStopped?.(message.success);
          break;

        case 'STATS':
          this.handlers.onStats?.(message.stats);
          break;

        default:
          console.log('[ASIO Bridge] Unknown message:', action);
      }
    } catch (error) {
      console.error('[ASIO Bridge] Error parsing message:', error);
    }
  }

  /**
   * Gérer l'audio binaire entrant
   */
  private handleBinaryAudio(data: ArrayBuffer): void {
    // Morceau d'un fichier de prise (REC_FETCH)
    const chunk = decodeFileChunk(data);
    if (chunk) {
      // La vue garde le message (à nous seuls) : pas de copie d'une longue prise.
      this.fetches.get(chunk.req)?.chunks.push(chunk);
      return;
    }
    try {
      const block = decodeInputMessage(data);
      this.handlers.onAudioInput?.(block.data, block.channels, block);
    } catch (error) {
      console.error('[ASIO Bridge] Error processing binary audio:', error);
    }
  }

  /**
   * Envoyer un message JSON
   */
  private send(data: object): void {
    if (this.isConnectedToServer()) {
      this.ws!.send(JSON.stringify(data));
    }
  }

  /**
   * Envoyer des données audio binaires
   */
  sendAudio(audioData: Float32Array, numChannels: number): void {
    if (!this.isConnectedToServer()) return;

    const numSamples = Math.floor(audioData.length / numChannels);

    // Créer le buffer: 4 bytes (samples) + 4 bytes (channels) + audio data
    const buffer = new ArrayBuffer(8 + audioData.byteLength);
    const view = new DataView(buffer);
    view.setUint32(0, numSamples, true);
    view.setUint32(4, numChannels, true);

    // Copier les données audio
    const audioView = new Float32Array(buffer, 8);
    audioView.set(audioData);

    this.ws!.send(buffer);
  }

  /**
   * R15 : plusieurs canaux, chacun vers sa sortie de la carte (master 1-2, mixes
   * casque 3-4, 5-6…). Ancien pont : seuls les 2 premiers canaux partent (1-2).
   */
  sendChannels(channelData: Float32Array[], dests: number[]): void {
    if (!this.isConnectedToServer() || channelData.length === 0) return;
    if (this.protocol >= 2) { this.ws!.send(encodeOutputMessage(channelData, dests)); return; }
    this.sendAudioFromWorklet(channelData.slice(0, 2));
  }

  /** R15 : bloc déjà entrelacé (AudioWorklet d'envoi), chaque canal vers sa sortie. */
  sendInterleaved(interleaved: Float32Array, channels: number, dests: number[]): void {
    if (!this.isConnectedToServer() || channels <= 0) return;
    if (this.protocol >= 2) { this.ws!.send(encodeOutputInterleaved(interleaved, channels, dests)); return; }
    // Ancien pont : seules les sorties 1-2.
    const frames = Math.floor(interleaved.length / channels);
    const two = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) { two[2 * i] = interleaved[i * channels]; two[2 * i + 1] = interleaved[i * channels + (channels > 1 ? 1 : 0)]; }
    this.sendAudio(two, 2);
  }

  /**
   * Envoyer des données audio via AudioWorklet
   * Compatible avec Web Audio API
   */
  sendAudioFromWorklet(channelData: Float32Array[]): void {
    if (!this.isConnectedToServer() || channelData.length === 0) return;

    const numChannels = channelData.length;
    const numSamples = channelData[0].length;

    // Interleaver les canaux
    const interleaved = new Float32Array(numSamples * numChannels);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        interleaved[i * numChannels + ch] = channelData[ch][i];
      }
    }

    this.sendAudio(interleaved, numChannels);
  }

  // ─────────────────────────────────────────────────────────────
  // API PUBLIQUE
  // ─────────────────────────────────────────────────────────────

  /**
   * Récupérer la liste des périphériques audio
   */
  getDevices(): void {
    this.send({ action: 'GET_DEVICES' });
  }

  /**
   * Configurer les paramètres audio
   */
  setConfig(config: Partial<ASIOConfig>): void {
    this.send({ action: 'SET_CONFIG', ...config });
  }

  /**
   * Récupérer la configuration actuelle
   */
  getConfig(): void {
    this.send({ action: 'GET_CONFIG' });
  }

  /**
   * Démarrer le flux audio
   */
  startStream(): void {
    this.send({ action: 'START_STREAM' });
  }

  /** Retour direct de la voix dans le pont (latence = buffer ASIO seulement). */
  setMonitor(enabled: boolean, gain: number, channel: number): void {
    this.send({ action: 'SET_MONITOR', enabled, gain, channel });
  }

  /** R15 : retour direct en matrice (voix des pistes armées → master et mixes casque). */
  setMonitorRoutes(enabled: boolean, routes: { in: number; out: number; gain: number }[]): void {
    this.send({ action: 'SET_MONITOR', enabled, routes });
  }

  /**
   * R15 : latence aller-retour de chaque entrée, mesurée par le pont (impulsion sur
   * `outChannels`, retrouvée sur les entrées : câble de boucle).
   */
  measureLatency(outChannels: number[] = [0, 1], seconds = 0.6): Promise<ASIOLatencyResult> {
    if (!this.isConnectedToServer()) return Promise.resolve({ success: false, error: 'Pont non connecté' });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.latencyWaiters = this.latencyWaiters.filter(f => f !== done); resolve({ success: false, error: 'Pas de réponse du pont' }); }, 9000);
      const done = (r: ASIOLatencyResult) => { clearTimeout(timer); resolve(r); };
      this.latencyWaiters.push(done);
      this.send({ action: 'MEASURE_LATENCY', out_channels: outChannels, seconds });
    });
  }

  // ─── Chantier C1 · prises écrites par le pont ─────────────────────────────

  /** Le pont écrit-il les prises lui-même ? */
  supportsTakeWriter(): boolean {
    return this.isConnectedToServer() && this.protocol >= 2 && this.features.includes('take_writer');
  }

  private recRequest(msg: object, reply: string, takeId: string, timeoutMs: number): Promise<any | null> {
    if (!this.isConnectedToServer()) return Promise.resolve(null);
    return new Promise(resolve => {
      const key = `${reply}:${takeId}`;
      const timer = setTimeout(() => { if (this.recWaiters.get(key) === done) this.recWaiters.delete(key); resolve(null); }, timeoutMs);
      const done = (m: any) => { clearTimeout(timer); resolve(m); };
      this.recWaiters.set(key, done);
      this.send(msg);
    });
  }

  /** Début d'une prise écrite par le pont (un WAV par piste). */
  recStart(p: { take_id: string; project_id?: string; project_name?: string; position?: number; tracks: BridgeTakeTrack[] }): Promise<BridgeTakeInfo | null> {
    return this.recRequest({ action: 'REC_START', ...p }, 'REC_STARTED', p.take_id, 4000);
  }

  /** Calage de la prise, noté par le pont dans ses métadonnées (récupération après plantage). */
  recAnchor(p: { take_id: string; frame: number; pos0: number; latency: number; offsets: Record<string, number>; lead: number; ctx_rate: number }): void {
    this.send({ action: 'REC_ANCHOR', ...p });
  }

  /** Fin de la prise : le pont ferme les fichiers et rend chemins + pertes. */
  recStop(takeId: string): Promise<BridgeTakeInfo | null> {
    return this.recRequest({ action: 'REC_STOP', take_id: takeId }, 'REC_STOPPED', takeId, 15000);
  }

  /** Fichier d'une piste d'une prise (WAV entier). */
  recFetch(takeId: string, trackId: string, timeoutMs = 120000): Promise<BridgeFetched | null> {
    if (!this.isConnectedToServer()) return Promise.resolve(null);
    const req = this.fetchSeq++ >>> 0;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.fetches.delete(req); resolve(null); }, timeoutMs);
      this.fetches.set(req, { chunks: [], done: r => { clearTimeout(timer); resolve(r); } });
      this.send({ action: 'REC_FETCH', take_id: takeId, track_id: trackId, req });
    });
  }

  /** Prise posée dans le projet : notée dans ses métadonnées. */
  recImported(takeId: string): void {
    this.send({ action: 'REC_IMPORTED', take_id: takeId });
  }

  /** Connexion perdue : toutes les attentes reçoivent « rien » (la page se rabat sur sa prise). */
  private failPending() {
    const w = [...this.recWaiters.values()];
    this.recWaiters.clear();
    w.forEach(f => f(null));
    const f = [...this.fetches.values()];
    this.fetches.clear();
    f.forEach(x => x.done(null));
  }

  /**
   * Arrêter le flux audio
   */
  stopStream(): void {
    this.send({ action: 'STOP_STREAM' });
  }

  /**
   * Récupérer les statistiques
   */
  getStats(): void {
    this.send({ action: 'GET_STATS' });
  }

  /**
   * Ouvrir le panneau de configuration du driver ASIO
   * Demande au bridge Python d'ouvrir le panneau natif du driver
   */
  openControlPanel(): void {
    this.send({ action: 'OPEN_CONTROL_PANEL' });
  }

  /**
   * Rescanner les périphériques audio
   */
  rescanDevices(): void {
    this.send({ action: 'RESCAN_DEVICES' });
  }

  // ─────────────────────────────────────────────────────────────
  // UTILITAIRES
  // ─────────────────────────────────────────────────────────────

  /**
   * Démarrer le ping périodique
   */
  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.send({ action: 'PING' });
    }, 5000);
  }

  /**
   * Arrêter le ping
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Tenter une reconnexion
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[ASIO Bridge] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    console.log(`[ASIO Bridge] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// ─────────────────────────────────────────────────────────────────
// SINGLETON INSTANCE
// ─────────────────────────────────────────────────────────────────

let asioBridgeInstance: ASIOBridgeClient | null = null;

/**
 * Récupérer l'instance singleton du bridge ASIO
 */
export function getASIOBridge(): ASIOBridgeClient {
  if (!asioBridgeInstance) {
    asioBridgeInstance = new ASIOBridgeClient();
  }
  return asioBridgeInstance;
}

export default ASIOBridgeClient;