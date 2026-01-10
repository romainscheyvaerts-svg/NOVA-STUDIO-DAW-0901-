
/**
 * VST Bridge Audio Processor
 * Gère le streaming audio bidirectionnel entre le DAW et le serveur VST
 */

class VSTBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Buffer pour l'audio traité reçu du serveur
    this.processedBuffer = [];
    this.bufferSize = 128;
    this.samplesSent = 0;
    
    // Écouter les messages du thread principal
    this.port.onmessage = (event) => {
      if (event.data.type === 'processed') {
        // Audio traité reçu du serveur
        const channels = event.data.channels;
        
        // Convertir en Float32Array et stocker
        this.processedBuffer = channels.map(ch => new Float32Array(ch));
      }
    };
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || input.length === 0) return true;
    
    // ÉTAPE 1: Envoyer l'audio d'entrée au serveur
    const inputSamples = [];
    for (let channel = 0; channel < input.length; channel++) {
      inputSamples.push(input[channel].slice()); // Clone
    }
    
    // Envoyer au thread principal toutes les 128 samples (pour éviter spam)
    // Ici on envoie à chaque process block (128 samples par défaut)
    this.samplesSent += input[0].length;
    if (this.samplesSent >= this.bufferSize) {
      this.port.postMessage({
        type: 'audio',
        samples: inputSamples
      });
      this.samplesSent = 0;
    }
    
    // ÉTAPE 2: Utiliser l'audio traité reçu du serveur
    if (this.processedBuffer.length > 0) {
      for (let channel = 0; channel < output.length; channel++) {
        if (this.processedBuffer[channel]) {
          // Copier les samples traités vers la sortie
          const len = Math.min(output[channel].length, this.processedBuffer[channel].length);
          output[channel].set(this.processedBuffer[channel].subarray(0, len));
          
          // Supprimer les samples utilisés
          this.processedBuffer[channel] = this.processedBuffer[channel].subarray(len);
        }
      }
      
      // Nettoyer le buffer si vide
      if (this.processedBuffer[0] && this.processedBuffer[0].length === 0) {
        this.processedBuffer = [];
      }
    } else {
      // Pas d'audio traité disponible -> passer l'audio d'origine (bypass temporaire pour éviter coupure)
      // Ou silence si on veut être strict sur la latence.
      // Bypass pour meilleure UX lors du chargement/latence réseau.
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].set(input[channel]);
      }
    }
    
    return true;
  }
}

registerProcessor('vst-bridge-processor', VSTBridgeProcessor);
