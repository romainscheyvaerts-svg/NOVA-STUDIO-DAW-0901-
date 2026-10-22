/**
 * Nova Pitch · analyse d'une voix (hors ligne) et son cache.
 *
 * Hauteur : YIN (de Cheveigné & Kawahara, 2002) sur le signal réduit à
 * ~12 kHz puis affinage de la période au taux plein (utils/pitchAnalysis) :
 * trames de 5 ms, justesse mesurée ≤ 0,05 cent sur sinus et voix de synthèse
 * tenues. Voisement : seuil de niveau + seuil d'apériodicité, trous courts
 * bouchés, éclats isolés retirés, sauts d'octave corrigés. Notes : paliers de
 * hauteur et creux de niveau (segmentNotes). Forme de chaque note (partie
 * tenue, vibrato, dérive) : engine/pitch/notes.
 *
 * Le résultat est gardé en mémoire (clé : son + région) et rangé dans la
 * sauvegarde .zip du projet (fichier `pitch/<clip>.bin`) : on ne réanalyse pas
 * une voix déjà vue.
 */
import { analyzePitch, monoOf, segmentNotes, type PitchNote, type PitchTrack } from '../../utils/pitchAnalysis';

export interface VoiceAnalysis {
  track: PitchTrack;
  /** Notes trouvées par l'analyse (avant coupes / fusions de l'utilisateur). */
  notes: PitchNote[];
}

export function analyzeVoice(channels: Float32Array[], sr: number, onProgress?: (p: number) => void): VoiceAnalysis {
  const track = analyzePitch(monoOf(channels), sr, { onProgress: onProgress ? p => onProgress(0.95 * p) : undefined });
  const notes = segmentNotes(track);
  onProgress?.(1);
  return { track, notes };
}

/** Clé de cache d'une région de son (s). */
export const analysisKey = (bufferId: string, start: number, end: number) => `${bufferId}|${start.toFixed(4)}|${end.toFixed(4)}`;

const cache = new Map<string, VoiceAnalysis>();
const MAX_ENTRIES = 24;

export const analysisCache = {
  get: (key: string) => cache.get(key),
  has: (key: string) => cache.has(key),
  set(key: string, a: VoiceAnalysis) {
    cache.delete(key);
    cache.set(key, a);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  },
  delete: (key: string) => cache.delete(key),
  clear: () => cache.clear(),
  keys: () => Array.from(cache.keys()),
};

// ---------------------------------------------------------------------------
// Rangement binaire (sauvegarde .zip)
// ---------------------------------------------------------------------------

const MAGIC = 0x3150564e; // « NVP1 »

/** Analyse → octets (en-tête JSON + hauteur et niveau en float32). */
export function encodeAnalysis(a: VoiceAnalysis, extra: Record<string, unknown> = {}): Uint8Array {
  const { track, notes } = a;
  const header = JSON.stringify({ v: 1, sr: track.sr, hop: track.hop, length: track.length, frames: track.midi.length, notes, ...extra });
  const hb = new TextEncoder().encode(header);
  const pad = (4 - ((8 + hb.length) % 4)) % 4;
  const off = 8 + hb.length + pad;
  const out = new Uint8Array(off + track.midi.length * 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, hb.length, true);
  out.set(hb, 8);
  new Float32Array(out.buffer, off, track.midi.length).set(track.midi);
  new Float32Array(out.buffer, off + track.midi.length * 4, track.midi.length).set(track.rmsDb);
  return out;
}

/** Octets → analyse (null si le fichier n'est pas reconnu). */
export function decodeAnalysis(bytes: Uint8Array): { analysis: VoiceAnalysis; extra: Record<string, any> } | null {
  try {
    const buf = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    const hl = dv.getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hl)));
    if (h.v !== 1 || !(h.frames >= 0)) return null;
    const pad = (4 - ((8 + hl) % 4)) % 4;
    const off = buf.byteOffset + 8 + hl + pad;
    if (8 + hl + pad + h.frames * 8 > buf.byteLength) return null;
    const midi = new Float32Array(buf.buffer.slice(off, off + h.frames * 4));
    const rmsDb = new Float32Array(buf.buffer.slice(off + h.frames * 4, off + h.frames * 8));
    const { v: _v, sr, hop, length, frames: _f, notes, ...extra } = h;
    return { analysis: { track: { sr, hop, length, midi, rmsDb }, notes }, extra };
  } catch {
    return null;
  }
}
