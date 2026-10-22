
// Utilitaire pour encoder un AudioBuffer en WAV Blob
// Nécessaire pour la sauvegarde du projet

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Profondeur d'un WAV de projet (audit de nuit, 22/10/2026).
 *
 * Avant : tout son de projet (.zip, envoi au studio, séance en ligne, collaboration) était écrit en
 * 16 bits, en TRONQUANT, avec deux échelles (×32767 au-dessus de zéro, ×32768 en dessous) : une prise
 * 24 bits ou un rendu perdaient 8 bits et plus, et même un son 16 bits perdait 1 pas à chaque
 * sauvegarde puis réouverture (les échantillons positifs baissaient d'un cran à chaque cycle).
 *
 *  - 'lossless' (fichier .zip, envoi au studio) : la plus petite profondeur qui garde CHAQUE
 *    échantillon à l'identique : 16 bits si le son est déjà en 16 bits, 24 bits s'il est en 24 bits,
 *    sinon 32 bits flottants (rendus, traitements, prises rééchantillonnées). Rouvert = identique au bit près.
 *  - 16 (séances en ligne, collaboration : taille et trafic) : 16 bits arrondis au plus près, sur UNE
 *    échelle (×32768) : un son déjà en 16 bits revient identique, sans perte de cycle en cycle.
 */
export type WavDepth = 16 | 24 | 32;

const fits = (x: number, scale: number) => { const k = x * scale; return k === Math.round(k) && k >= -scale && k <= scale - 1; };

/** Plus petite profondeur qui garde chaque échantillon du son à l'identique. */
export function losslessDepth(buffer: AudioBuffer): WavDepth {
  let depth: WavDepth = 16;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const x = buffer.getChannelData(c);
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (depth === 16) { if (fits(v, 32768)) continue; depth = 24; }
      if (!fits(v, 8388608)) return 32;
    }
  }
  return depth;
}

export const audioBufferToWav = (buffer: AudioBuffer, depth: WavDepth | 'lossless' = 16): Blob => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth: WavDepth = depth === 'lossless' ? losslessDepth(buffer) : depth;
  const float = bitDepth === 32;
  const format = float ? 3 : 1; // 3 = IEEE flottant, 1 = PCM entier

  // Entrelacement de tous les canaux (avant : au-delà de 2, seul le premier
  // était écrit alors que l'en-tête annonçait N canaux, fichier illisible).
  let data: Float32Array;
  if (numChannels === 1) {
      data = buffer.getChannelData(0);
  } else {
      const channels = Array.from({ length: numChannels }, (_, c) => buffer.getChannelData(c));
      const len = channels[0].length;
      data = new Float32Array(len * numChannels);
      for (let i = 0; i < len; i++) {
          for (let c = 0; c < numChannels; c++) data[i * numChannels + c] = channels[c][i];
      }
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = data.length * bytesPerSample;
  // Flottant : bloc fmt de 18 octets (cbSize = 0) et bloc « fact » (nombre d'images), comme le veut le format.
  const fmtSize = float ? 18 : 16;
  const factBytes = float ? 12 : 0;
  const header = 12 + 8 + fmtSize + factBytes + 8;
  const arrayBuffer = new ArrayBuffer(header + dataBytes + (dataBytes % 2));
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, arrayBuffer.byteLength - 8, true);
  writeString(view, 8, 'WAVE');
  let o = 12;
  writeString(view, o, 'fmt '); view.setUint32(o + 4, fmtSize, true);
  view.setUint16(o + 8, format, true);
  view.setUint16(o + 10, numChannels, true);
  view.setUint32(o + 12, sampleRate, true);
  view.setUint32(o + 16, sampleRate * blockAlign, true);
  view.setUint16(o + 20, blockAlign, true);
  view.setUint16(o + 22, bitDepth, true);
  if (float) view.setUint16(o + 24, 0, true);
  o += 8 + fmtSize;
  if (float) { writeString(view, o, 'fact'); view.setUint32(o + 4, 4, true); view.setUint32(o + 8, data.length / numChannels, true); o += 12; }
  writeString(view, o, 'data'); view.setUint32(o + 4, dataBytes, true);
  o += 8;

  if (float) {
    for (let i = 0; i < data.length; i++, o += 4) view.setFloat32(o, data[i], true);
  } else if (bitDepth === 24) {
    for (let i = 0; i < data.length; i++, o += 3) {
      const k = Math.max(-8388608, Math.min(8388607, Math.round(data[i] * 8388608)));
      view.setUint8(o, k & 0xff); view.setUint8(o + 1, (k >> 8) & 0xff); view.setUint8(o + 2, (k >> 16) & 0xff);
    }
  } else {
    for (let i = 0; i < data.length; i++, o += 2) {
      view.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32768))), true);
    }
  }

  return new Blob([view], { type: 'audio/wav' });
};

// Un enregistrement ne change jamais une fois créé (chaque édition produit un
// nouveau buffer) : on ne l'encode en WAV qu'une fois. Avant, la sauvegarde
// automatique (toutes les 4 s après une modification) ré-encodait toutes les
// prises du projet, ce qui figeait l'interface sur les longues sessions (iPad).
const wavCache = new WeakMap<AudioBuffer, Blob>();
const wav16Cache = new WeakMap<AudioBuffer, Blob>();
/** WAV SANS PERTE d'un son de projet (.zip, envoi au studio) : relu = identique au bit près. */
export const wavOf = (buffer: AudioBuffer): Blob => {
  let wav = wavCache.get(buffer);
  if (!wav) { wav = audioBufferToWav(buffer, 'lossless'); wavCache.set(buffer, wav); }
  return wav;
};
/** WAV 16 bits (séances en ligne, collaboration : taille et trafic), sans perte de cycle en cycle. */
export const wav16Of = (buffer: AudioBuffer): Blob => {
  let wav = wav16Cache.get(buffer);
  if (!wav) { wav = audioBufferToWav(buffer, 16); wav16Cache.set(buffer, wav); }
  return wav;
};
