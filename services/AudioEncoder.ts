
/**
 * AUDIO ENCODER SERVICE
 * Gère le post-traitement (DSP) et l'encodage des fichiers audio.
 */

export type AudioFormat = 'WAV' | 'MP3';
export type BitDepth = '16' | '24' | '32';

export class AudioEncoder {

  /**
   * Normalise le buffer audio à un niveau cible (ex: -0.1 dB).
   * Modifie le buffer en place.
   */
  public static normalizeBuffer(buffer: AudioBuffer, targetDb: number = -0.1) {
      const targetLinear = Math.pow(10, targetDb / 20);
      let maxPeak = 0;

      // 1. Scan pour trouver le pic absolu
      for (let c = 0; c < buffer.numberOfChannels; c++) {
          const data = buffer.getChannelData(c);
          for (let i = 0; i < data.length; i++) {
              const abs = Math.abs(data[i]);
              if (abs > maxPeak) maxPeak = abs;
          }
      }

      if (maxPeak === 0) return;

      // 2. Calcul du gain de normalisation
      const ratio = targetLinear / maxPeak;

      // 3. Application du gain si nécessaire
      if (ratio < 1.0 || ratio > 1.0) { // Si on doit changer le volume
          console.log(`[DSP] Normalizing Peak ${(20*Math.log10(maxPeak)).toFixed(2)}dB -> ${targetDb}dB (Ratio: ${ratio.toFixed(4)})`);
          for (let c = 0; c < buffer.numberOfChannels; c++) {
              const data = buffer.getChannelData(c);
              for (let i = 0; i < data.length; i++) {
                  data[i] *= ratio;
              }
          }
      }
  }

  /**
   * Applique un Dithering TPDF (Triangular Probability Density Function)
   * Indispensable avant la réduction de bit depth pour éviter la distorsion de quantification.
   */
  public static applyDither(buffer: AudioBuffer, targetBitDepth: number) {
      if (targetBitDepth >= 32) return; // Pas de dither pour le float 32

      const channels = buffer.numberOfChannels;
      // Amplitude d'un bit au niveau cible
      const q = 1 / Math.pow(2, targetBitDepth); 
      
      console.log(`[DSP] Applying TPDF Dither for ${targetBitDepth}-bit depth`);

      for (let c = 0; c < channels; c++) {
          const data = buffer.getChannelData(c);
          // On garde l'état du bruit précédent pour le High-Pass (Noise Shaping) si on voulait pousser plus loin,
          // mais ici TPDF standard est requis : Noise = Rand() - Rand()
          
          for (let i = 0; i < data.length; i++) {
              const r1 = Math.random();
              const r2 = Math.random();
              const triangularNoise = (r1 - r2) * q; // Bruit triangulaire d'amplitude 1 LSB
              
              data[i] += triangularNoise;
          }
      }
  }

  /**
   * Encode un AudioBuffer en fichier WAV
   */
  public static encodeWAV(buffer: AudioBuffer, bitDepth: BitDepth): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    let bitsPerSample = parseInt(bitDepth);
    
    const isFloat = bitDepth === '32';
    if (isFloat) bitsPerSample = 32;

    const samples = buffer.getChannelData(0); // Left
    const samplesR = numChannels > 1 ? buffer.getChannelData(1) : null;
    const length = samples.length;

    const blockAlign = numChannels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    
    const bufferLength = 44 + dataSize;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    // --- WAV HEADER ---
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, isFloat ? 3 : 1, true); // AudioFormat (1=PCM, 3=Float)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // --- DATA WRITING ---
    let offset = 44;
    
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        // Get sample (-1 to 1)
        const s = channel === 0 ? samples[i] : (samplesR ? samplesR[i] : samples[i]);
        
        // Clipping safety (Hard limit at 0dBFS before int conversion)
        const sClamped = Math.max(-1, Math.min(1, s));

        if (bitsPerSample === 16) {
          // 16-bit signed
          view.setInt16(offset, sClamped < 0 ? sClamped * 0x8000 : sClamped * 0x7FFF, true);
          offset += 2;
        } 
        else if (bitsPerSample === 24) {
          // 24-bit signed
          const v = sClamped < 0 ? sClamped * 0x800000 : sClamped * 0x7FFFFF;
          view.setUint8(offset, (v) & 0xFF);
          view.setUint8(offset + 1, (v >> 8) & 0xFF);
          view.setUint8(offset + 2, (v >> 16) & 0xFF);
          offset += 3;
        }
        else if (bitsPerSample === 32) {
          // 32-bit Float
          view.setFloat32(offset, sClamped, true);
          offset += 4;
        }
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  private static writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
