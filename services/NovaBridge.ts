
import { PluginMetadata } from '../types';

export interface NovaStatus {
  isConnected: boolean;
  pluginCount: number;
  lastMessage: string;
}

export interface PluginParameter {
  name: string;
  value: number;
  display_name: string;
}

class NovaBridgeService {
  private ws: WebSocket | null = null;
  private url: string = 'ws://localhost:8765/ws';
  
  private listeners: ((status: NovaStatus) => void)[] = [];
  private pluginListeners: ((plugins: PluginMetadata[]) => void)[] = [];
  private uiListeners: Set<(image: string) => void> = new Set();
  private audioProcessedListeners: Set<(channels: Float32Array[]) => void> = new Set();
  
  // Paramètres VST
  private paramListeners: Set<(params: PluginParameter[]) => void> = new Set();
  private currentParams: PluginParameter[] = [];
  private loadedPluginName: string = '';
  
  private pingInterval: number | null = null;
  private reconnectTimer: number | null = null;

  // --- AUDIO STREAMING ---
  private audioWorkletNode: AudioWorkletNode | null = null;
  private audioCtx: AudioContext | null = null;

  private state: NovaStatus = {
    isConnected: false,
    pluginCount: 0,
    lastMessage: 'Déconnecté'
  };

  private plugins: PluginMetadata[] = [];

  constructor() {
    console.log('🔧 [Nova Bridge] Service Initialized');
  }

  public connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        console.log('✅ [Nova Bridge] Connected');
        this.updateState({ isConnected: true, lastMessage: 'Connecté' });
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
        } catch (e) {
            // Ignorer les erreurs de parsing json isolées
        }
      };

      this.ws.onclose = (e) => {
        if (this.state.isConnected) {
             console.log(`🔌 [Nova Bridge] Connection lost`);
        }
        this.stopHeartbeat();
        this.updateState({ isConnected: false, lastMessage: 'Déconnecté' });
        
        if (!this.reconnectTimer) {
            this.reconnectTimer = window.setTimeout(() => {
                this.reconnectTimer = null;
                this.connect();
            }, 5000);
        }
      };

      this.ws.onerror = () => {
        if (this.state.isConnected) {
            console.warn('❌ [Nova Bridge] Erreur de communication.');
        }
        this.updateState({ isConnected: false, lastMessage: 'Erreur Connexion' });
      };

    } catch (e) {
      console.error('❌ [Nova Bridge] Init Exception');
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.send({ action: 'PING' });
        }
    }, 5000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
    }
  }

  private handleMessage(msg: any) {
    switch (msg.action) {
        case 'GET_PLUGIN_LIST':
            if (Array.isArray(msg.plugins)) {
                this.handlePluginList(msg.plugins);
            }
            break;
        
        case 'LOAD_PLUGIN':
            if (msg.success) {
                this.loadedPluginName = msg.name || '';
                this.updateState({ lastMessage: `Chargé: ${msg.name}` });
                
                if (Array.isArray(msg.parameters)) {
                    this.currentParams = msg.parameters;
                    this.notifyParams();
                }
            } else {
                console.error('[Nova Bridge] Load Error:', msg.error);
                this.updateState({ lastMessage: `Erreur: ${msg.error}` });
            }
            break;
        
        case 'PARAMS':
            if (Array.isArray(msg.parameters)) {
                this.currentParams = msg.parameters;
                this.notifyParams();
            }
            break;
        
        case 'PARAM_CHANGED':
            const param = this.currentParams.find(p => p.name === msg.name);
            if (param) {
                param.value = msg.value;
                this.notifyParams();
            }
            break;
        
        case 'UNLOAD_PLUGIN':
            this.loadedPluginName = '';
            this.currentParams = [];
            this.notifyParams();
            this.updateState({ lastMessage: 'Plugin déchargé' });
            break;
        
        case 'UI_FRAME':
            if (msg.image) {
                this.notifyUI(msg.image);
            }
            break;
        
        case 'AUDIO_PROCESSED':
            if (Array.isArray(msg.channels)) {
                const processedChannels = msg.channels.map(
                    (ch: number[]) => new Float32Array(ch)
                );
                
                // 1. Notify generic listeners
                this.notifyAudioProcessed(processedChannels);

                // 2. Send to AudioWorklet if active (DAW streaming)
                if (this.audioWorkletNode) {
                    this.audioWorkletNode.port.postMessage({
                        type: 'processed',
                        channels: msg.channels
                    });
                }
            }
            break;

        case 'PONG':
            break;
    }
  }

  private handlePluginList(rawList: any[]) {
     this.plugins = rawList.map((p: any, idx: number) => ({
        id: p.id !== undefined ? String(p.id) : `vst-${idx}`,
        name: p.name || 'Unknown',
        vendor: 'VST3',
        type: 'VST3',
        format: 'VST3',
        version: '1.0',
        latency: 0,
        localPath: p.path 
     }));
     
     this.updateState({ pluginCount: this.plugins.length, lastMessage: 'Liste Reçue' });
     this.notifyPlugins();
  }

  private send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
    }
  }

  // --- AUDIO STREAMING METHODS ---

  public processAudio(channels: Float32Array[], sampleRate: number = 44100): void {
      const channelsData = channels.map(ch => Array.from(ch));
      this.send({
          action: 'PROCESS_AUDIO',
          channels: channelsData,
          sampleRate: sampleRate
      });
  }

  public subscribeToAudioProcessed(callback: (channels: Float32Array[]) => void) {
      this.audioProcessedListeners.add(callback);
      return () => { this.audioProcessedListeners.delete(callback); };
  }

  private notifyAudioProcessed(channels: Float32Array[]) {
      this.audioProcessedListeners.forEach(cb => cb(channels));
  }

  public async initAudioStreaming(
    audioContext: AudioContext,
    trackDSPInput: AudioNode,
    trackDSPOutput: AudioNode
  ): Promise<void> {
    this.audioCtx = audioContext;
    
    try {
      // Assuming VSTBridgeProcessor is available at this path
      await this.audioCtx.audioWorklet.addModule('/worklets/VSTBridgeProcessor.js');
      
      this.audioWorkletNode = new AudioWorkletNode(this.audioCtx, 'vst-bridge-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      
      trackDSPInput.connect(this.audioWorkletNode);
      this.audioWorkletNode.connect(trackDSPOutput);
      
      this.audioWorkletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio') {
          this.processAudio(event.data.samples, this.audioCtx?.sampleRate || 44100);
        }
      };
      
      console.log('✅ [Nova Bridge] Audio streaming initialized');
    } catch (error) {
      console.error('❌ [Nova Bridge] Failed to init audio streaming:', error);
    }
  }

  public stopAudioStreaming() {
    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect();
      this.audioWorkletNode = null;
    }
    console.log('🛑 [Nova Bridge] Audio streaming stopped');
  }

  // --- API PUBLIQUE COMMANDES ---

  public loadPlugin(path: string, sampleRate: number = 44100) {
      this.send({ action: 'LOAD_PLUGIN', path, sample_rate: sampleRate });
  }

  public unloadPlugin() {
      this.send({ action: 'UNLOAD_PLUGIN' });
  }

  public click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') {
      this.send({ action: 'CLICK', x, y, button });
  }

  public drag(x1: number, y1: number, x2: number, y2: number) {
      this.send({ action: 'DRAG', x1, y1, x2, y2 });
  }

  public scroll(x: number, y: number, delta: number) {
      this.send({ action: 'SCROLL', x, y, delta });
  }

  public setWindowRect(x: number, y: number, width: number, height: number) {
      this.send({ action: 'SET_WINDOW_RECT', x, y, width, height });
  }

  public requestPlugins() {
      this.send({ action: 'GET_PLUGIN_LIST' });
  }

  // --- Parameter Management ---

  public setParam(name: string, value: number) {
      this.send({ action: 'SET_PARAM', name, value });
      
      const param = this.currentParams.find(p => p.name === name);
      if (param) {
          param.value = value;
          this.notifyParams();
      }
  }

  public requestParams() {
      this.send({ action: 'GET_PARAMS' });
  }

  public subscribeToParams(callback: (params: PluginParameter[]) => void) {
      this.paramListeners.add(callback);
      if (this.currentParams.length > 0) {
          callback(this.currentParams);
      }
      return () => { this.paramListeners.delete(callback); };
  }

  private notifyParams() {
      this.paramListeners.forEach(cb => cb(this.currentParams));
  }

  public getLoadedPluginName(): string {
      return this.loadedPluginName;
  }

  public getParams(): PluginParameter[] {
      return this.currentParams;
  }

  // --- Subscriptions ---

  public subscribe(callback: (status: NovaStatus) => void) {
    this.listeners.push(callback);
    callback(this.state);
    return () => { this.listeners = this.listeners.filter(cb => cb !== callback); };
  }

  public subscribeToPlugins(callback: (plugins: PluginMetadata[]) => void) {
    this.pluginListeners.push(callback);
    if (this.plugins.length > 0) callback(this.plugins);
    return () => { this.pluginListeners = this.pluginListeners.filter(cb => cb !== callback); };
  }

  public subscribeToUI(callback: (image: string) => void) {
    this.uiListeners.add(callback);
    return () => { this.uiListeners.delete(callback); };
  }

  private updateState(partial: Partial<NovaStatus>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach(cb => cb(this.state));
  }

  private notifyPlugins() {
    this.pluginListeners.forEach(cb => cb(this.plugins));
  }

  private notifyUI(image: string) {
    this.uiListeners.forEach(cb => cb(image));
  }
}

export const novaBridge = new NovaBridgeService();
