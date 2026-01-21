import { PluginMetadata } from '../types';

export interface NovaStatus {
  isConnected: boolean;
  pluginCount: number;
  lastMessage: string;
  activeSlots: number;
}

export interface PluginParameter {
  name: string;
  value: number;
  display_name: string;
}

export interface VSTSlotInfo {
  slotId: string;
  pluginName: string;
  pluginPath: string;
  isLoaded: boolean;
  parameters: PluginParameter[];
  audioWorkletNode: AudioWorkletNode | null;
}

/**
 * Nova Bridge Service v3.0
 * 
 * Service de communication avec le bridge Python VST3.
 * Supporte 100+ instances de plugins simultanées via un système de slots.
 */
class NovaBridgeService {
  private ws: WebSocket | null = null;
  private url: string = 'ws://localhost:8765';
  
  // Status listeners
  private listeners: ((status: NovaStatus) => void)[] = [];
  private pluginListeners: ((plugins: PluginMetadata[]) => void)[] = [];
  
  // Multi-instance support: Map of slot listeners
  private slotUiListeners: Map<string, Set<(image: string) => void>> = new Map();
  private slotAudioListeners: Map<string, Set<(channels: Float32Array[]) => void>> = new Map();
  private slotParamListeners: Map<string, Set<(params: PluginParameter[]) => void>> = new Map();
  private slotErrorListeners: Map<string, Set<(error: string) => void>> = new Map();
  
  // Legacy single-plugin listeners (backward compatibility)
  private legacyUiListeners: Set<(image: string) => void> = new Set();
  private legacyAudioListeners: Set<(channels: Float32Array[]) => void> = new Set();
  private legacyParamListeners: Set<(params: PluginParameter[]) => void> = new Set();
  
  // Active VST slots management (support 100+ simultaneous instances)
  private activeSlots: Map<string, VSTSlotInfo> = new Map();
  private maxSlots: number = 128;
  
  // Legacy single plugin state (backward compatibility)
  private currentParams: PluginParameter[] = [];
  private loadedPluginName: string = '';
  
  private pingInterval: number | null = null;
  private reconnectTimer: number | null = null;

  // --- AUDIO STREAMING ---
  private audioWorkletNodes: Map<string, AudioWorkletNode> = new Map();
  private audioCtx: AudioContext | null = null;
  private workletReady: boolean = false;
  
  // Legacy single worklet (backward compatibility)
  private audioWorkletNode: AudioWorkletNode | null = null;

  private state: NovaStatus = {
    isConnected: false,
    pluginCount: 0,
    lastMessage: 'Déconnecté',
    activeSlots: 0
  };

  private plugins: PluginMetadata[] = [];

  constructor() {
    console.log('🔧 [Nova Bridge] Service Initialized (Multi-Instance v3.0)');
  }

  public connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        console.log('✅ [Nova Bridge] Connected');
        this.updateState({ isConnected: true, lastMessage: 'Connecté' });
        this.startHeartbeat();
        
        // Request plugin list after connection
        setTimeout(() => {
          this.requestPlugins();
          console.log('📋 [Nova Bridge] Requested plugin list');
        }, 500);
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
    const slotId = msg.slot_id || 'default';
    
    switch (msg.action) {
        case 'GET_PLUGIN_LIST':
            if (Array.isArray(msg.plugins)) {
                this.handlePluginList(msg.plugins);
            }
            break;
        
        case 'LOAD_PLUGIN':
            if (msg.success) {
                // Update slot info
                const slotInfo: VSTSlotInfo = {
                    slotId: slotId,
                    pluginName: msg.name || '',
                    pluginPath: '',
                    isLoaded: true,
                    parameters: msg.parameters || [],
                    audioWorkletNode: this.audioWorkletNodes.get(slotId) || null
                };
                this.activeSlots.set(slotId, slotInfo);
                
                // Legacy compatibility
                this.loadedPluginName = msg.name || '';
                if (Array.isArray(msg.parameters)) {
                    this.currentParams = msg.parameters;
                    this.notifyParams(slotId, msg.parameters);
                }
                
                this.updateState({ 
                    lastMessage: `Chargé: ${msg.name}`,
                    activeSlots: this.activeSlots.size
                });
                
                console.log(`✅ [Nova Bridge] Plugin loaded: ${msg.name} (slot: ${slotId})`);
            } else {
                const errorMsg = msg.error || 'Failed to load plugin';
                console.error('[Nova Bridge] Load Error:', errorMsg);
                
                // Notify error listeners
                this.notifyLoadError(slotId, errorMsg);
                
                this.updateState({ lastMessage: `Erreur: ${errorMsg}` });
            }
            break;
        
        case 'PARAMS':
            if (Array.isArray(msg.parameters)) {
                // Update slot params
                const slot = this.activeSlots.get(slotId);
                if (slot) {
                    slot.parameters = msg.parameters;
                }
                
                // Legacy
                this.currentParams = msg.parameters;
                this.notifyParams(slotId, msg.parameters);
            }
            break;
        
        case 'PARAM_CHANGED':
            // Update slot params
            const slotData = this.activeSlots.get(slotId);
            if (slotData) {
                const param = slotData.parameters.find(p => p.name === msg.name);
                if (param) param.value = msg.value;
            }
            
            // Legacy
            const legacyParam = this.currentParams.find(p => p.name === msg.name);
            if (legacyParam) {
                legacyParam.value = msg.value;
                this.notifyParams(slotId, this.currentParams);
            }
            break;
        
        case 'UNLOAD_PLUGIN':
            // Remove slot
            this.activeSlots.delete(slotId);
            this.audioWorkletNodes.delete(slotId);
            
            // Legacy
            if (slotId === 'default') {
                this.loadedPluginName = '';
                this.currentParams = [];
            }
            
            this.notifyParams(slotId, []);
            this.updateState({ 
                lastMessage: `Plugin déchargé (slot: ${slotId})`,
                activeSlots: this.activeSlots.size
            });
            break;
        
        case 'UI_FRAME':
            if (msg.image) {
                this.notifyUI(slotId, msg.image);
            }
            break;
        
        case 'AUDIO_PROCESSED':
            if (Array.isArray(msg.channels)) {
                const processedChannels = msg.channels.map(
                    (ch: number[]) => new Float32Array(ch)
                );
                
                // Notify slot-specific listeners
                this.notifyAudioProcessed(slotId, processedChannels);

                // Send to AudioWorklet if active
                const workletNode = this.audioWorkletNodes.get(slotId) || this.audioWorkletNode;
                if (workletNode) {
                    workletNode.port.postMessage({
                        type: 'processed',
                        channels: msg.channels,
                        slotId: slotId
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
        vendor: p.vendor || 'VST3',
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

  // ═══════════════════════════════════════════════════════════════
  // MULTI-INSTANCE API - New methods for managing multiple plugins
  // ═══════════════════════════════════════════════════════════════

  /**
   * Load a plugin into a specific slot
   * @param path Path to the VST3 plugin
   * @param sampleRate Sample rate (default 44100)
   * @param slotId Unique slot identifier (e.g., "track1_fx0")
   */
  public loadPluginToSlot(path: string, sampleRate: number = 44100, slotId: string) {
      if (this.activeSlots.size >= this.maxSlots) {
          console.error(`[Nova Bridge] Max slots reached (${this.maxSlots})`);
          return;
      }
      this.send({ action: 'LOAD_PLUGIN', path, sample_rate: sampleRate, slot_id: slotId });
  }

  /**
   * Unload a plugin from a specific slot
   * @param slotId Slot identifier
   */
  public unloadPluginFromSlot(slotId: string) {
      this.send({ action: 'UNLOAD_PLUGIN', slot_id: slotId });
  }

  /**
   * Process audio through a specific slot
   * @param channels Audio channels
   * @param sampleRate Sample rate
   * @param slotId Slot identifier
   */
  public processAudioForSlot(channels: Float32Array[], sampleRate: number = 44100, slotId: string): void {
      const channelsData = channels.map(ch => Array.from(ch));
      this.send({
          action: 'PROCESS_AUDIO',
          channels: channelsData,
          sampleRate: sampleRate,
          slot_id: slotId
      });
  }

  /**
   * Set parameter for a specific slot
   * @param name Parameter name
   * @param value Parameter value
   * @param slotId Slot identifier
   */
  public setParamForSlot(name: string, value: number, slotId: string) {
      this.send({ action: 'SET_PARAM', name, value, slot_id: slotId });
      
      const slot = this.activeSlots.get(slotId);
      if (slot) {
          const param = slot.parameters.find(p => p.name === name);
          if (param) {
              param.value = value;
              this.notifyParams(slotId, slot.parameters);
          }
      }
  }

  /**
   * UI interaction for a specific slot
   */
  public clickOnSlot(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', slotId: string) {
      this.send({ action: 'CLICK', x, y, button, slot_id: slotId });
  }

  public dragOnSlot(x1: number, y1: number, x2: number, y2: number, slotId: string) {
      this.send({ action: 'DRAG', x1, y1, x2, y2, slot_id: slotId });
  }

  public scrollOnSlot(x: number, y: number, delta: number, slotId: string) {
      this.send({ action: 'SCROLL', x, y, delta, slot_id: slotId });
  }

  /**
   * Subscribe to UI frames for a specific slot
   */
  public subscribeToSlotUI(slotId: string, callback: (image: string) => void) {
      if (!this.slotUiListeners.has(slotId)) {
          this.slotUiListeners.set(slotId, new Set());
      }
      this.slotUiListeners.get(slotId)!.add(callback);
      return () => {
          this.slotUiListeners.get(slotId)?.delete(callback);
      };
  }

  /**
   * Subscribe to processed audio for a specific slot
   */
  public subscribeToSlotAudio(slotId: string, callback: (channels: Float32Array[]) => void) {
      if (!this.slotAudioListeners.has(slotId)) {
          this.slotAudioListeners.set(slotId, new Set());
      }
      this.slotAudioListeners.get(slotId)!.add(callback);
      return () => {
          this.slotAudioListeners.get(slotId)?.delete(callback);
      };
  }

  /**
   * Subscribe to parameters for a specific slot
   */
  public subscribeToSlotParams(slotId: string, callback: (params: PluginParameter[]) => void) {
      if (!this.slotParamListeners.has(slotId)) {
          this.slotParamListeners.set(slotId, new Set());
      }
      this.slotParamListeners.get(slotId)!.add(callback);
      
      // Send current params immediately
      const slot = this.activeSlots.get(slotId);
      if (slot && slot.parameters.length > 0) {
          callback(slot.parameters);
      }
      
      return () => {
          this.slotParamListeners.get(slotId)?.delete(callback);
      };
  }

  /**
   * Get slot info
   */
  public getSlotInfo(slotId: string): VSTSlotInfo | undefined {
      return this.activeSlots.get(slotId);
  }

  /**
   * Get all active slots
   */
  public getActiveSlots(): Map<string, VSTSlotInfo> {
      return new Map(this.activeSlots);
  }

  /**
   * Initialize audio streaming for a specific slot
   */
  public async initAudioStreamingForSlot(
    audioContext: AudioContext,
    trackDSPInput: AudioNode,
    trackDSPOutput: AudioNode,
    slotId: string
  ): Promise<void> {
    this.audioCtx = audioContext;
    
    try {
      // Load worklet module if not already loaded
      if (!this.workletReady) {
        await this.audioCtx.audioWorklet.addModule('/worklets/VSTBridgeProcessor.js');
        this.workletReady = true;
      }
      
      const workletNode = new AudioWorkletNode(this.audioCtx, 'vst-bridge-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { slotId }
      });
      
      trackDSPInput.connect(workletNode);
      workletNode.connect(trackDSPOutput);
      
      workletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio') {
          this.processAudioForSlot(event.data.samples, this.audioCtx?.sampleRate || 44100, slotId);
        }
      };
      
      this.audioWorkletNodes.set(slotId, workletNode);
      
      console.log(`✅ [Nova Bridge] Audio streaming initialized for slot: ${slotId}`);
    } catch (error) {
      console.error(`❌ [Nova Bridge] Failed to init audio streaming for slot ${slotId}:`, error);
    }
  }

  /**
   * Stop audio streaming for a specific slot
   */
  public stopAudioStreamingForSlot(slotId: string) {
    const workletNode = this.audioWorkletNodes.get(slotId);
    if (workletNode) {
      workletNode.disconnect();
      this.audioWorkletNodes.delete(slotId);
      console.log(`🛑 [Nova Bridge] Audio streaming stopped for slot: ${slotId}`);
    }
  }

  // Notify helpers for multi-instance
  private notifyUI(slotId: string, image: string) {
      // Slot-specific listeners
      this.slotUiListeners.get(slotId)?.forEach(cb => cb(image));
      
      // Legacy listeners (backward compatibility)
      if (slotId === 'default') {
          this.legacyUiListeners.forEach(cb => cb(image));
      }
  }

  private notifyAudioProcessed(slotId: string, channels: Float32Array[]) {
      // Slot-specific listeners
      this.slotAudioListeners.get(slotId)?.forEach(cb => cb(channels));
      
      // Legacy listeners (backward compatibility)
      if (slotId === 'default') {
          this.legacyAudioListeners.forEach(cb => cb(channels));
      }
  }

  private notifyParams(slotId: string, params: PluginParameter[]) {
      // Slot-specific listeners
      this.slotParamListeners.get(slotId)?.forEach(cb => cb(params));
      
      // Legacy listeners (backward compatibility)
      if (slotId === 'default') {
          this.legacyParamListeners.forEach(cb => cb(params));
      }
  }

  private notifyLoadError(slotId: string, error: string) {
      // Slot-specific error listeners
      this.slotErrorListeners.get(slotId)?.forEach(cb => cb(error));
  }

  /**
   * Subscribe to load errors for a specific slot
   */
  public subscribeToSlotError(slotId: string, callback: (error: string) => void) {
      if (!this.slotErrorListeners.has(slotId)) {
          this.slotErrorListeners.set(slotId, new Set());
      }
      this.slotErrorListeners.get(slotId)!.add(callback);
      return () => {
          this.slotErrorListeners.get(slotId)?.delete(callback);
      };
  }

  // ═══════════════════════════════════════════════════════════════
  // LEGACY API - Backward compatible methods (single plugin)
  // ═══════════════════════════════════════════════════════════════

  public processAudio(channels: Float32Array[], sampleRate: number = 44100): void {
      this.processAudioForSlot(channels, sampleRate, 'default');
  }

  public subscribeToAudioProcessed(callback: (channels: Float32Array[]) => void) {
      this.legacyAudioListeners.add(callback);
      return () => { this.legacyAudioListeners.delete(callback); };
  }

  public async initAudioStreaming(
    audioContext: AudioContext,
    trackDSPInput: AudioNode,
    trackDSPOutput: AudioNode
  ): Promise<void> {
    this.audioCtx = audioContext;
    
    try {
      if (!this.workletReady) {
        await this.audioCtx.audioWorklet.addModule('/worklets/VSTBridgeProcessor.js');
        this.workletReady = true;
      }
      
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
      
      console.log('✅ [Nova Bridge] Audio streaming initialized (legacy)');
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

  public loadPlugin(path: string, sampleRate: number = 44100) {
      this.loadPluginToSlot(path, sampleRate, 'default');
  }

  public unloadPlugin() {
      this.unloadPluginFromSlot('default');
  }

  public click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') {
      this.clickOnSlot(x, y, button, 'default');
  }

  public drag(x1: number, y1: number, x2: number, y2: number) {
      this.dragOnSlot(x1, y1, x2, y2, 'default');
  }

  public scroll(x: number, y: number, delta: number) {
      this.scrollOnSlot(x, y, delta, 'default');
  }

  public setWindowRect(x: number, y: number, width: number, height: number) {
      this.send({ action: 'SET_WINDOW_RECT', x, y, width, height, slot_id: 'default' });
  }

  public requestPlugins() {
      this.send({ action: 'GET_PLUGIN_LIST' });
  }

  public setParam(name: string, value: number) {
      this.setParamForSlot(name, value, 'default');
  }

  public requestParams() {
      this.send({ action: 'GET_PARAMS', slot_id: 'default' });
  }

  public subscribeToParams(callback: (params: PluginParameter[]) => void) {
      this.legacyParamListeners.add(callback);
      if (this.currentParams.length > 0) {
          callback(this.currentParams);
      }
      return () => { this.legacyParamListeners.delete(callback); };
  }

  public getLoadedPluginName(): string {
      return this.loadedPluginName;
  }

  public getParams(): PluginParameter[] {
      return this.currentParams;
  }

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
    this.legacyUiListeners.add(callback);
    return () => { this.legacyUiListeners.delete(callback); };
  }

  private updateState(partial: Partial<NovaStatus>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach(cb => cb(this.state));
  }

  private notifyPlugins() {
    this.pluginListeners.forEach(cb => cb(this.plugins));
  }
}

export const novaBridge = new NovaBridgeService();
