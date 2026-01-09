
import { audioEngine } from '../engine/AudioEngine';

declare const lamejs: any;

export class AudioConverter {

  /**
   * Convertit n'importe quel fichier audio (WAV, etc.) en MP3 optimisé (128kbps)
   * pour le streaming "Preview".
   */
  public static async convertToMp3(file: File | Blob): Promise<Blob> {
    // 1. Décoder le fichier source via Web Audio API
    const arrayBuffer = await file.arrayBuffer();
    
    // Initialiser l'audio engine si besoin (pour avoir un contexte)
    if (!audioEngine.ctx) await audioEngine.init();
    const audioCtx = audioEngine.ctx!;
    
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    // 2. Préparer l'encodeur LAME
    // MP3 standard : 44.1kHz, Stereo, 128kbps
    const sampleRate = 44100; // Force 44.1k for standard MP3 compatibility
    const channels = audioBuffer.numberOfChannels;
    const kbps = 128; 

    // Nécessite lamejs chargé dans index.html
    if (typeof lamejs === 'undefined') {
        throw new Error("LameJS library not found. Cannot encode MP3.");
    }

    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
    const mp3Data: Int8Array[] = [];

    // 3. Traitement par blocs (Chunk processing)
    // LameJS attend des entiers signés 16-bit (Int16)
    // WebAudio fournit des Float32 (-1.0 à 1.0)
    
    const left = audioBuffer.getChannelData(0);
    const right = channels > 1 ? audioBuffer.getChannelData(1) : left; // Fallback mono->stereo if needed
    
    const sampleBlockSize = 1152; // Multiples de 576 pour MP3
    
    for (let i = 0; i < left.length; i += sampleBlockSize) {
      const leftChunk = left.subarray(i, i + sampleBlockSize);
      const rightChunk = right.subarray(i, i + sampleBlockSize);
      
      // Convertir Float32 -> Int16
      const leftInt16 = this.float32ToInt16(leftChunk);
      const rightInt16 = channels > 1 ? this.float32ToInt16(rightChunk) : leftInt16;

      // Encoder le bloc
      const mp3buf = channels > 1 
        ? mp3encoder.encodeBuffer(leftInt16, rightInt16)
        : mp3encoder.encodeBuffer(leftInt16);
        
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }

    // 4. Finaliser l'encodage
    const endBuf = mp3encoder.flush();
    if (endBuf.length > 0) {
      mp3Data.push(endBuf);
    }

    // 5. Créer le Blob final
    return new Blob(mp3Data, { type: 'audio/mp3' });
  }

  private static float32ToInt16(float32: Float32Array): Int16Array {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      // Clamp entre -1 et 1
      const s = Math.max(-1, Math.min(1, float32[i]));
      // Convertir en 16-bit PCM (s < 0 ? s * 0x8000 : s * 0x7FFF)
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }
}
