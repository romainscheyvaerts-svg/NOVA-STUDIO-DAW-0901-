/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                    NOVA ASIO BRIDGE - Client TypeScript                      ║
 * ║                                                                              ║
 * ║  Service TypeScript pour connecter le DAW web au bridge ASIO Python          ║
 * ║  Permet le streaming audio bidirectionnel avec une carte son ASIO            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

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
  input_level: number;
  output_level: number;
  buffer_underruns: number;
  buffer_overruns: number;
  blocks_processed: number;
  elapsed_seconds: number;
  input_buffer_size: number;
  output_buffer_size: number;
}

// Types pour les messages WebSocket
type ASIOMessageHandler = (data: any) => void;

interface ASIOMessageHandlers {
  onDevices?: (devices: AudioDevice[], asioDevices: AudioDevice[]) => void;
  onConfigSet?: (success: boolean, config?: ASIOConfig, error?: string) => void;
  onConfig?: (config: ASIOConfig) => void;
  onStreamStarted?: (success: boolean, latency_ms?: number, error?: string) => void;
  onStreamStopped?: (success: boolean) => void;
  onStats?: (stats: ASIOStats) => void;
  onAudioInput?: (audioData: Float32Array, channels: number) => void;
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

  constructor(host: string = '127.0.0.1', port: number = 8766) {
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
          this.startPing();
          this.handlers.onConnect?.();
          resolve(true);
        };

        this.ws.onclose = () => {
          console.log('[ASIO Bridge] Disconnected');
          this.isConnected = false;
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

        case 'CONFIG_SET':
          this.handlers.onConfigSet?.(message.success, message.config, message.error);
          break;

        case 'CONFIG':
          this.handlers.onConfig?.(message.config);
          break;

        case 'STREAM_STARTED':
          this.handlers.onStreamStarted?.(message.success, message.latency_ms, message.error);
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
    try {
      const view = new DataView(data);
      const numSamples = view.getUint32(0, true);
      const numChannels = view.getUint32(4, true);

      // Extraire les données audio
      const audioData = new Float32Array(data, 8);

      this.handlers.onAudioInput?.(audioData, numChannels);
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
// AUDIO WORKLET PROCESSOR POUR LE BRIDGE
// ─────────────────────────────────────────────────────────────────

/**
 * Code pour l'AudioWorklet qui envoie/reçoit l'audio via le bridge
 * À utiliser avec registerProcessor() dans un fichier worklet séparé
 */
export const ASIOBridgeWorkletCode = `
class ASIOBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputBuffer = [];
    this.outputBuffer = [];
    
    this.port.onmessage = (event) => {
      if (event.data.type === 'output') {
        // Audio à envoyer vers les haut-parleurs
        this.outputBuffer.push(event.data.audio);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // Envoyer l'entrée au bridge (micro)
    if (input.length > 0) {
      this.port.postMessage({
        type: 'input',
        audio: input.map(ch => ch.slice())
      });
    }

    // Recevoir la sortie du bridge
    if (this.outputBuffer.length > 0 && output.length > 0) {
      const audioData = this.outputBuffer.shift();
      for (let ch = 0; ch < output.length; ch++) {
        if (audioData[ch]) {
          output[ch].set(audioData[ch]);
        }
      }
    }

    return true;
  }
}

registerProcessor('asio-bridge-processor', ASIOBridgeProcessor);
`;

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

/**
 * Créer une nouvelle instance du bridge ASIO
 */
export function createASIOBridge(host?: string, port?: number): ASIOBridgeClient {
  return new ASIOBridgeClient(host, port);
}

export default ASIOBridgeClient;