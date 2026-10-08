/**
 * R15 · Protocole binaire du pont ASIO (bridge-python/asio_bridge.py). Module pur.
 *
 * Entrée (pont → DAW) :
 *  - v1 : u32 images, u32 canaux, float32 entrelacés ;
 *  - v2 : 'NVI2', u32 images, u32 canaux, u32 fréquence, u64 n° de la 1re image
 *    (depuis le démarrage du flux), f64 heure du convertisseur, float32 entrelacés
 *    (en-tête de 32 octets). Le n° d'image permet de recaler à l'échantillon près et
 *    de remplacer un bloc perdu par du silence (les pistes restent alignées).
 * Sortie (DAW → pont), v2 : 'NVO2', u32 images, u32 canaux, une sortie de la carte
 * par canal (i32, -1 = ignoré), float32 entrelacés. Master sur 1-2, mixes casque
 * sur leurs paires.
 */

export const INPUT_MAGIC_V2 = 0x3249564e;   // 'NVI2' lu en petit-boutiste
export const OUTPUT_MAGIC_V2 = 0x324f564e;  // 'NVO2'
export const INPUT_HEADER_V2 = 32;

export interface InputBlock {
  frames: number;
  channels: number;
  /** Échantillons entrelacés (vue sur le message : à copier si gardés). */
  data: Float32Array;
  /** v2 seulement. */
  sampleRate?: number;
  frameIndex?: number;
  adcTime?: number;
}

export function decodeInputMessage(buf: ArrayBuffer): InputBlock {
  const v = new DataView(buf);
  if (buf.byteLength >= INPUT_HEADER_V2 && v.getUint32(0, true) === INPUT_MAGIC_V2) {
    const frames = v.getUint32(4, true), channels = v.getUint32(8, true);
    const sampleRate = v.getUint32(12, true);
    // u64 : sûr jusqu'à 2^53 images (plus de 6 000 ans à 48 kHz)
    const frameIndex = v.getUint32(16, true) + v.getUint32(20, true) * 4294967296;
    const adcTime = v.getFloat64(24, true);
    const n = Math.min(frames * channels, Math.floor((buf.byteLength - INPUT_HEADER_V2) / 4));
    return { frames, channels, sampleRate, frameIndex, adcTime, data: new Float32Array(buf, INPUT_HEADER_V2, n) };
  }
  const frames = v.getUint32(0, true), channels = Math.max(1, v.getUint32(4, true));
  const n = Math.min(frames * channels, Math.floor((buf.byteLength - 8) / 4));
  return { frames, channels, data: new Float32Array(buf, 8, n) };
}

/** Message de sortie v2 : canaux (non entrelacés) + sortie de la carte de chacun. */
export function encodeOutputMessage(channels: Float32Array[], dests: number[]): ArrayBuffer {
  const nch = channels.length;
  const frames = nch ? channels[0].length : 0;
  const head = 12 + 4 * nch;
  const buf = new ArrayBuffer(head + frames * nch * 4);
  const v = new DataView(buf);
  v.setUint32(0, OUTPUT_MAGIC_V2, true);
  v.setUint32(4, frames, true);
  v.setUint32(8, nch, true);
  for (let c = 0; c < nch; c++) v.setInt32(12 + 4 * c, dests[c] ?? -1, true);
  const out = new Float32Array(buf, head);
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) out[i * nch + c] = channels[c][i];
  return buf;
}

/** Message de sortie v2 depuis des échantillons déjà entrelacés (images × canaux). */
export function encodeOutputInterleaved(interleaved: Float32Array, channels: number, dests: number[]): ArrayBuffer {
  const nch = Math.max(1, channels);
  const frames = Math.floor(interleaved.length / nch);
  const head = 12 + 4 * nch;
  const buf = new ArrayBuffer(head + frames * nch * 4);
  const v = new DataView(buf);
  v.setUint32(0, OUTPUT_MAGIC_V2, true);
  v.setUint32(4, frames, true);
  v.setUint32(8, nch, true);
  for (let c = 0; c < nch; c++) v.setInt32(12 + 4 * c, dests[c] ?? -1, true);
  new Float32Array(buf, head, frames * nch).set(interleaved.subarray(0, frames * nch));
  return buf;
}

/**
 * Raccord d'un bloc horodaté avec le précédent : images à insérer en silence (bloc
 * perdu), à retirer au début (recouvrement), ou rien.
 */
export function blockJoin(expected: number | null, frameIndex: number | undefined, frames: number, maxGap: number): { pad: number; skip: number; reset: boolean } {
  if (expected === null || frameIndex === undefined) return { pad: 0, skip: 0, reset: false };
  const d = frameIndex - expected;
  if (d === 0) return { pad: 0, skip: 0, reset: false };
  // Trou énorme ou retour en arrière (flux recréé) : on repart de ce bloc.
  if (d > maxGap || d < -frames) return { pad: 0, skip: 0, reset: true };
  if (d > 0) return { pad: d, skip: 0, reset: false };
  return { pad: 0, skip: Math.min(frames, -d), reset: false };
}
