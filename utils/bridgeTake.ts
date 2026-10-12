/**
 * Chantier C1 · Prise écrite par le pont ASIO (bridge-python/take_writer.py). Module pur.
 *
 * Dans Nova Studio, la prise n'est plus celle que la page a reconstruite à partir de la
 * WebSocket (trous si la page se fige) : c'est le fichier WAV que le pont a écrit depuis le
 * callback de la carte. La page ne garde son enregistrement que pour l'aperçu et le calage.
 *
 * Calage : la page connaît, pour son propre enregistrement, la position sur le morceau de son
 * 1er échantillon (`pos0`, avant compensation) et le n° d'image de la carte de ce même
 * échantillon (`anchorFrame`, lu dans le lecteur d'entrée ASIO). Une image F du fichier du
 * pont tombe donc à : pos0 + (F − anchorFrame) / sr − latence. C'est EXACTEMENT le calcul de
 * la prise du navigateur (AudioEngine.stopCalibratedRecording) : même début, même latence
 * compensée, même avance retirée (décompte, pré-roll).
 */

export interface WavData { sampleRate: number; channels: Float32Array[]; frames: number }

/** WAV → canaux float32 (IEEE float 32 bits au bit près ; PCM 16 / 24 / 32 bits aussi). */
export function parseWav(buf: ArrayBuffer): WavData {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV illisible');
  let o = 12;
  let fmt: { format: number; channels: number; rate: number; align: number; bits: number } | null = null;
  let dataOff = -1, dataLen = 0;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = v.getUint16(o + 8, true);
      // WAVE_FORMAT_EXTENSIBLE : le vrai format est dans le sous-format (GUID).
      if (format === 0xfffe && size >= 40) format = v.getUint16(o + 32, true);
      fmt = { format, channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), align: v.getUint16(o + 20, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data') {
      dataOff = o + 8;
      // Fichier coupé net (plantage) : ce qui est réellement là.
      dataLen = Math.min(size, buf.byteLength - dataOff);
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0 || !fmt.channels || !fmt.align) throw new Error('WAV incomplet');
  const nc = fmt.channels;
  const frames = Math.floor(dataLen / fmt.align);
  const bytes = fmt.bits / 8;
  if (fmt.format === 3 && fmt.bits === 32) {
    // Copie alignée (l'en-tête du pont fait 58 octets) ; plates-formes petit-boutistes (toutes).
    // Mono : cette copie EST le canal (une seule copie d'une longue prise en mémoire).
    const f = new Float32Array(buf.slice(dataOff, dataOff + frames * nc * 4));
    if (nc === 1) return { sampleRate: fmt.rate, channels: [f], frames };
    const channels = Array.from({ length: nc }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) channels[c][i] = f[i * nc + c];
    return { sampleRate: fmt.rate, channels, frames };
  }
  const channels = Array.from({ length: nc }, () => new Float32Array(frames));
  if (fmt.format === 1 && (bytes === 2 || bytes === 3 || bytes === 4)) {
    const scale = 1 / Math.pow(2, fmt.bits - 1);
    for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) {
      const p = dataOff + (i * nc + c) * bytes;
      let s: number;
      if (bytes === 2) s = v.getInt16(p, true);
      else if (bytes === 4) s = v.getInt32(p, true);
      else { s = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16); }
      channels[c][i] = s * scale;
    }
  } else throw new Error(`WAV : format ${fmt.format} / ${fmt.bits} bits non pris en charge`);
  return { sampleRate: fmt.rate, channels, frames };
}

export interface PlacementInput {
  /** N° d'image de la carte du 1er échantillon du fichier du pont. */
  startFrame: number;
  /** N° d'image de la carte du 1er échantillon de l'enregistrement de la page. */
  anchorFrame: number;
  /** Position (s) sur le morceau de ce 1er échantillon, avant compensation de latence. */
  pos0: number;
  /** Latence compensée pour cette piste (s) : mesurée + réglage fin + retard propre de l'entrée. */
  latency: number;
  /** Avance du son sur le départ de la lecture (images, décompte / pré-roll) : retirée. */
  lead: number;
  sampleRate: number;
  /** Images dans le fichier. */
  frames: number;
}

/**
 * Où poser le fichier du pont : `from` = 1re image du fichier gardée, `start` = position du
 * clip (s). Même arrondi que la prise du navigateur, donc même début au bit près.
 */
export function bridgeTakePlacement(p: PlacementInput): { from: number; start: number; frames: number } {
  const sr = p.sampleRate;
  const rawStart = p.pos0 + p.lead / sr;
  let start = rawStart - p.latency;
  let skip = 0;
  if (start < 0) { skip = Math.round(-start * sr); start = 0; }
  const want = p.anchorFrame + p.lead + skip;          // image de la carte du 1er échantillon gardé
  let from = want - p.startFrame;
  if (from < 0) { start += -from / sr; from = 0; }       // le pont a commencé plus tard : le clip aussi
  from = Math.min(from, p.frames);
  return { from, start, frames: p.frames - from };
}

export interface BridgeLoss { frame: number; frames: number; kind: string; at?: number; filled?: boolean }

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Nombre de blocs perdus (comme le pont : au moins 1 par perte). */
export function lostBlocks(losses: BridgeLoss[], blockSize: number): number {
  const b = Math.max(1, blockSize || 1);
  return losses.reduce((s, l) => s + Math.max(1, Math.round((l.frames || 0) / b)), 0);
}

/**
 * Message clair pour l'ingé : « 2 blocs perdus pendant la prise, à 0:43 ». `timeOf` donne la
 * position sur le morceau d'une image de la carte.
 */
export function lossMessage(losses: BridgeLoss[], blockSize: number, timeOf: (frame: number) => number): string | null {
  if (!losses?.length) return null;
  const n = lostBlocks(losses, blockSize);
  const when = [...new Set(losses.map(l => clock(timeOf(l.frame))))];
  const at = when.length > 3 ? `${when.slice(0, 3).join(', ')}…` : when.length > 1 ? `${when.slice(0, -1).join(', ')} et ${when[when.length - 1]}` : when[0];
  const card = losses.some(l => l.kind === 'asio'), disk = losses.some(l => l.kind !== 'asio');
  const why = card && disk ? 'carte son et disque' : card ? 'la carte son a sauté' : "l'écriture sur le disque a pris du retard";
  const filled = losses.every(l => l.filled !== false);
  return `⚠️ ${n} bloc${n > 1 ? 's' : ''} perdu${n > 1 ? 's' : ''} pendant la prise, à ${at} (${why})${filled ? ' : comblé' + (n > 1 ? 's' : '') + ' de silence, la suite reste calée' : ''}`;
}

/** Identifiant de prise accepté par le pont ([A-Za-z0-9_-], 64 au plus). */
export function newBridgeTakeId(now = Date.now()): string {
  return `tk-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Lecture d'une piste armée côté pont : ses entrées de la carte et comment les lire. */
export function bridgeTrackSpec(channels: number[], width: 1 | 2): { inputs: number[]; mode: 'mono' | 'stereo' | 'sum' } {
  if (width === 2) return { inputs: channels.slice(0, 2), mode: 'stereo' };
  return channels.length > 1 ? { inputs: channels, mode: 'sum' } : { inputs: channels.slice(0, 1), mode: 'mono' };
}

/** Prise écrite par le pont désactivée (secours) : localStorage nova_bridge_takes = '0'. */
export function bridgeTakesEnabled(): boolean {
  try { return localStorage.getItem('nova_bridge_takes') !== '0'; } catch { return true; }
}
