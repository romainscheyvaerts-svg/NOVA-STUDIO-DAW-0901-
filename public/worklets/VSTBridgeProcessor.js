/**
 * VST Bridge Audio Processor v3.0
 * 
 * Gère le streaming audio bidirectionnel entre le DAW et le serveur VST
 * Supporte les multi-instances via système de slots
 */

class VSTBridgeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // Slot identification for multi-instance support
    this.slotId = options?.processorOptions?.slotId || 'default';
    
    // Buffer pour l'audio traité reçu du serveur
    this.processedBuffer = [];
    this.bufferSize = 128;
    this.samplesSent = 0;
    this.sequenceNumber = 0;
    
    // Ring buffer for smooth playback (reduces glitches)
    this.ringBufferSize = 4; // Number of blocks to buffer
    this.ringBuffer = [];
    this.ringWriteIndex = 0;
    this.ringReadIndex = 0;
    
    // Latency compensation
    this.inputLatency = 0;
    this.outputLatency = 0;
    
    // Statistics
    this.blocksProcessed = 0;
    this.underruns = 0;
    
    // Écouter les messages du thread principal
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
    
    // Notify main thread that processor is ready
    this.port.postMessage({
      type: 'ready',
      slotId: this.slotId
    });
  }
  
  handleMessage(data) {
    switch (data.type) {
      case 'processed':
        // Audio traité reçu du serveur
        this.receiveProcessedAudio(data.channels, data.slotId);
        break;
        
      case 'config':
        // Configuration update
        if (data.bufferSize) this.bufferSize = data.bufferSize;
        if (data.ringBufferSize) this.ringBufferSize = data.ringBufferSize;
        break;
        
      case 'reset':
        // Reset buffers
        this.processedBuffer = [];
        this.ringBuffer = [];
        this.ringWriteIndex = 0;
        this.ringReadIndex = 0;
        break;
        
      case 'getStats':
        // Return statistics
        this.port.postMessage({
          type: 'stats',
          slotId: this.slotId,
          blocksProcessed: this.blocksProcessed,
          underruns: this.underruns,
          ringBufferFill: this.getRingBufferFill()
        });
        break;
    }
  }
  
  receiveProcessedAudio(channels, slotId) {
    // Only process if this is for our slot (or no slot specified for backward compat)
    if (slotId && slotId !== this.slotId) return;
    
    // Convert to Float32Array and add to ring buffer
    const processedChannels = channels.map(ch => new Float32Array(ch));
    
    // Add to ring buffer for smooth playback
    if (this.ringBuffer.length < this.ringBufferSize) {
      this.ringBuffer.push(processedChannels);
    } else {
      // Overwrite oldest entry
      this.ringBuffer[this.ringWriteIndex] = processedChannels;
      this.ringWriteIndex = (this.ringWriteIndex + 1) % this.ringBufferSize;
    }
  }
  
  getRingBufferFill() {
    return this.ringBuffer.length;
  }
  
  getNextProcessedBlock() {
    if (this.ringBuffer.length === 0) {
      return null;
    }
    
    const block = this.ringBuffer[this.ringReadIndex];
    this.ringBuffer[this.ringReadIndex] = null;
    this.ringReadIndex = (this.ringReadIndex + 1) % Math.max(this.ringBuffer.length, 1);
    
    // Clean up null entries
    this.ringBuffer = this.ringBuffer.filter(b => b !== null);
    this.ringReadIndex = 0;
    
    return block;
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || input.length === 0) return true;
    
    this.blocksProcessed++;
    
    // ÉTAPE 1: Capturer et envoyer l'audio d'entrée au serveur
    const inputSamples = [];
    for (let channel = 0; channel < input.length; channel++) {
      inputSamples.push(input[channel].slice()); // Clone
    }
    
    // Envoyer au thread principal
    this.samplesSent += input[0].length;
    if (this.samplesSent >= this.bufferSize) {
      this.port.postMessage({
        type: 'audio',
        samples: inputSamples,
        slotId: this.slotId,
        sequence: this.sequenceNumber++
      });
      this.samplesSent = 0;
    }
    
    // ÉTAPE 2: Utiliser l'audio traité reçu du serveur
    const processedBlock = this.getNextProcessedBlock();
    
    if (processedBlock && processedBlock.length > 0) {
      // Use processed audio from server
      for (let channel = 0; channel < output.length; channel++) {
        if (processedBlock[channel]) {
          const len = Math.min(output[channel].length, processedBlock[channel].length);
          output[channel].set(processedBlock[channel].subarray(0, len));
          
          // Fill remaining with zeros if processed block is shorter
          if (len < output[channel].length) {
            output[channel].fill(0, len);
          }
        } else {
          // No data for this channel, use input as bypass
          output[channel].set(input[channel] || new Float32Array(output[channel].length));
        }
      }
    } else {
      // No processed audio available - bypass mode (pass through input)
      // This prevents silence during network latency
      this.underruns++;
      
      for (let channel = 0; channel < output.length; channel++) {
        if (input[channel]) {
          output[channel].set(input[channel]);
        } else {
          output[channel].fill(0);
        }
      }
    }
    
    return true;
  }
}

registerProcessor('vst-bridge-processor', VSTBridgeProcessor);
