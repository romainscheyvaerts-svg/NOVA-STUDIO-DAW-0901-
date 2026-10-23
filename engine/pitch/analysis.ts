/**
 * Nova Pitch · analyse d'une voix (hors ligne) et son cache.
 *
 * Hauteur : le détecteur commun de NOVA (engine/pitch/detect.ts, le même que
 * Nova Tune) : YIN (de Cheveigné & Kawahara, 2002) après passe-bas et
 * sous-échantillonnage, portes de voisement absolue et relative, garde
 * d'octave par continuité (idée du suivi de pYIN), affinage de la période au
 * taux plein. Mesuré : ≤ 0,02 cent sur voix de synthèse tenue (45 à 80 MIDI).
 * Ici, une trame toutes les 5 ms, posée sur la grille de l'éditeur (trame i
 * centrée sur i·hop), puis nettoyée (trous courts bouchés, éclats isolés et
 * bords de passage douteux retirés). Notes : paliers de hauteur et creux de
 * niveau (segmentNotes). Forme de chaque note (partie tenue, vibrato,
 * dérive) : engine/pitch/notes.
 *
 * Le résultat est gardé en mémoire (clé : son + région) et rangé dans la
 * sauvegarde .zip du projet (fichier `pitch/<clip>.bin`) : on ne réanalyse pas
 * une voix déjà vue.
 */
import { cleanTrack, monoOf, segmentNotes, type PitchNote, type PitchTrack } from '../../utils/pitchAnalysis';
import { detectPitchTrack } from './detect';

export interface VoiceAnalysis {
  track: PitchTrack;
  /** Notes trouvées par l'analyse (avant coupes / fusions de l'utilisateur). */
  notes: PitchNote[];
}

/** Plage de hauteur cherchée pour une voix (Hz) : voix d'homme grave → voix de tête. */
const VOICE_RANGE: [number, number] = [65, 1100];

/** Courbe de hauteur d'une voix sur la grille de l'éditeur (une trame toutes les 5 ms). */
export function voiceTrack(x: Float32Array, sr: number, onProgress?: (p: number) => void): PitchTrack {
  const hop = Math.max(16, Math.round(0.005 * sr));
  const frames = Math.max(0, Math.floor(x.length / hop) + 1);
  const rmsDb = new Float32Array(frames);
  const half = Math.round(0.01 * sr);
  for (let i = 0; i < frames; i++) {
    const c = i * hop;
    const a = Math.max(0, c - half), b = Math.min(x.length, c + half);
    let s = 0;
    for (let k = a; k < b; k++) s += x[k] * x[k];
    const r = b > a ? Math.sqrt(s / (b - a)) : 0;
    rmsDb[i] = r > 1e-9 ? 20 * Math.log10(r) : -180;
  }
  const det = detectPitchTrack(x, sr, { hop, fMin: VOICE_RANGE[0], fMax: VOICE_RANGE[1], onProgress });
  // Trames du détecteur (centres réguliers, décalés d'une constante) → grille i·hop.
  const midi = new Float32Array(frames).fill(NaN);
  const dt = hop / sr;
  let k = 0;
  for (let i = 0; i < frames; i++) {
    const t = i * dt;
    while (k + 1 < det.length && det[k + 1].time <= t) k++;
    const A = det[k], B = det[k + 1];
    if (!A) continue;
    if (B && A.voiced && B.voiced && t >= A.time) midi[i] = A.midi + ((B.midi - A.midi) * (t - A.time)) / Math.max(1e-9, B.time - A.time);
    else if (A.voiced && Math.abs(t - A.time) <= dt / 2) midi[i] = A.midi;
    else if (B?.voiced && Math.abs(B.time - t) <= dt / 2) midi[i] = B.midi;
  }
  cleanTrack(midi);
  return { sr, hop, length: x.length, midi, rmsDb };
}

export function analyzeVoice(channels: Float32Array[], sr: number, onProgress?: (p: number) => void): VoiceAnalysis {
  const track = voiceTrack(monoOf(channels), sr, onProgress ? p => onProgress(0.95 * p) : undefined);
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
