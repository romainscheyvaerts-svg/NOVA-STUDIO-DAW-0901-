import type { DrumMachine, DrumRow } from './drumKits';
import { STEPS_PER_BAR } from './drumPatterns';

/**
 * V16 · Tes propres samples sur les pads (comme le Drum Rack / Drum Sampler
 * d'Ableton ou le sampler de canal de FL Studio).
 *
 * - Le son d'un pad perso s'écrit `user:<id>` ; son audio vit dans le registre
 *   des buffers (`padsample-<id>`), jamais dans l'état (Immer, historique).
 * - `drumMachine.samples` garde le nom et la durée ; à la sauvegarde, ProjectIO
 *   écrit un WAV par sample (`audio/pad-<id>.wav`) et le relit à l'ouverture.
 * - Réglages par pad : gain (volume), accordage, début / fin, fondus, reverse,
 *   groupe de choke. La zone jouée est pré-calculée (logique pure ci-dessous).
 */

export interface PadSampleInfo {
  name: string;
  /** Durée du son d'origine (s). */
  duration: number;
  /** Tempo d'origine d'une boucle découpée. */
  bpm?: number;
  /** Fichier dans le projet (renseigné à la sauvegarde seulement). */
  audioRef?: string;
}

export const MAX_PADS = 30;

export const padSampleKey = (id: string) => `padsample-${id}`;
export const userRef = (id: string) => `user:${id}`;
export const userSampleId = (ref: string | undefined): string | null => (ref && ref.startsWith('user:') ? ref.slice(5) : null);

export const newSampleId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ===== Zone jouée d'un pad =====

export interface PadRegion { start: number; end: number; fadeIn: number; fadeOut: number; reverse: boolean }

const clamp01 = (v: number | undefined, d: number) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : d);

export function regionOf(r: Partial<DrumRow>): PadRegion {
  const start = clamp01(r.start, 0);
  const end = Math.max(start, clamp01(r.end, 1));
  return { start, end, fadeIn: Math.max(0, r.fadeIn || 0), fadeOut: Math.max(0, r.fadeOut || 0), reverse: !!r.reverse };
}

/** Le pad joue-t-il autre chose que le son entier, à l'endroit ? */
export const hasRegion = (r: Partial<DrumRow>) => {
  const g = regionOf(r);
  return g.start > 0 || g.end < 1 || g.fadeIn > 0 || g.fadeOut > 0 || g.reverse;
};

/** Clé de cache du son prêt à jouer d'un pad. */
export const padLoadKey = (r: Partial<DrumRow>, root: number) => {
  const g = regionOf(r);
  return `${r.sound}|${root}|${hasRegion(r) ? [g.start, g.end, g.fadeIn, g.fadeOut, g.reverse ? 1 : 0].map(v => +(+v).toFixed(5)).join(',') : ''}`;
};

/**
 * Découpe la zone jouée : début / fin (0-1), reverse, fondus (s). Un micro-fondu
 * (1 ms / 3 ms) évite le clic quand on coupe au milieu du son.
 */
export function renderRegion(channels: Float32Array[], sampleRate: number, region: PadRegion): Float32Array[] {
  const len = channels[0]?.length || 0;
  if (!len) return channels.map(() => new Float32Array(1));
  let s = Math.floor(region.start * len);
  let e = Math.ceil(region.end * len);
  s = Math.max(0, Math.min(len - 1, s));
  e = Math.max(s + 16, Math.min(len, e));
  e = Math.min(len, e);
  const n = Math.max(1, e - s);
  const out = channels.map(c => {
    const o = new Float32Array(c.subarray(s, s + n));
    if (region.reverse) o.reverse();
    return o;
  });
  // Bords : le début réel du son sonne déjà ; une coupe franche, non.
  const startCut = region.reverse ? e < len : s > 0;
  // À l'envers, le son finit sur son attaque : toujours un micro-fondu de sortie.
  const endCut = region.reverse ? true : e < len;
  const fi = Math.min(n >> 1, Math.round(Math.max(region.fadeIn, startCut ? 0.001 : 0) * sampleRate));
  const fo = Math.min(n >> 1, Math.round(Math.max(region.fadeOut, endCut ? 0.003 : 0) * sampleRate));
  out.forEach(o => {
    for (let i = 0; i < fi; i++) o[i] *= i / fi;
    for (let i = 0; i < fo; i++) o[n - 1 - i] *= i / fo;
  });
  return out;
}

/** Zone d'un clip de la session (offset, durée, reverse, gain) : le sample du pad. */
export function clipRegionChannels(channels: Float32Array[], sampleRate: number, clip: { offset?: number; duration: number; isReversed?: boolean; gain?: number }): Float32Array[] {
  const len = channels[0]?.length || 0;
  const s = Math.max(0, Math.min(len, Math.round((clip.offset || 0) * sampleRate)));
  const e = Math.max(s + 1, Math.min(len, s + Math.round(clip.duration * sampleRate)));
  const g = typeof clip.gain === 'number' ? clip.gain : 1;
  return channels.map(c => {
    const o = new Float32Array(c.subarray(s, e));
    if (clip.isReversed) o.reverse();
    if (g !== 1) for (let i = 0; i < o.length; i++) o[i] *= g;
    return o;
  });
}

// ===== Pads perso dans la boîte à rythmes =====

const uniqueRowId = (dm: DrumMachine, base: string) => {
  const ids = new Set(dm.rows.map(r => r.id));
  let i = 1;
  while (ids.has(`${base}${i}`)) i++;
  return `${base}${i}`;
};

/** Nom court d'un fichier (« Kick Dusty 04.wav » → « Kick Dusty 04 »). */
export const sampleLabel = (name: string) => (name || 'Sample').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 28) || 'Sample';

/**
 * Pose un sample perso : sur un pad existant (ses pas sont gardés, ses
 * réglages de zone remis à zéro) ou sur un nouveau pad en bas de la grille.
 */
export function assignSample(dm: DrumMachine, sampleId: string, info: PadSampleInfo, target: { rowIndex?: number | null }): { dm: DrumMachine; rowIndex: number } | null {
  const samples = { ...(dm.samples || {}), [sampleId]: { name: info.name, duration: info.duration, ...(info.bpm ? { bpm: info.bpm } : {}) } };
  const label = sampleLabel(info.name);
  const reset = { start: undefined, end: undefined, fadeIn: undefined, fadeOut: undefined, reverse: undefined, slice: undefined };
  if (typeof target.rowIndex === 'number' && dm.rows[target.rowIndex]) {
    const rows = dm.rows.map((r, i) => (i === target.rowIndex ? { ...r, ...reset, sound: userRef(sampleId), name: label, tune: 0, decay: 1 } : r));
    return { dm: pruneSamples({ ...dm, samples, rows }), rowIndex: target.rowIndex };
  }
  if (dm.rows.length >= MAX_PADS) return null;
  const len = STEPS_PER_BAR * (dm.bars || 1);
  const row: DrumRow = {
    id: uniqueRowId(dm, 'pad'), name: label, sound: userRef(sampleId),
    steps: new Array(len).fill(0), ratchet: new Array(len).fill(1), volume: 0.85, pan: 0,
  };
  return { dm: { ...dm, samples, rows: [...dm.rows, row] }, rowIndex: dm.rows.length };
}

/** Retire un pad (ses pas disparaissent de tous les motifs). */
export function removePad(dm: DrumMachine, rowIndex: number): DrumMachine {
  const row = dm.rows[rowIndex];
  if (!row || dm.rows.length <= 1) return dm;
  const rows = dm.rows.filter((_, i) => i !== rowIndex);
  const patterns = dm.patterns?.map(p => {
    const steps = { ...p.steps }; const ratchet = { ...p.ratchet };
    delete steps[row.id]; delete ratchet[row.id];
    const pan = p.pan ? { ...p.pan } : undefined; const pitch = p.pitch ? { ...p.pitch } : undefined;
    if (pan) delete pan[row.id];
    if (pitch) delete pitch[row.id];
    return { ...p, steps, ratchet, ...(pan ? { pan } : {}), ...(pitch ? { pitch } : {}) };
  });
  return pruneSamples({ ...dm, rows, ...(patterns ? { patterns } : {}) });
}

/** Oublie les samples qu'aucun pad n'utilise plus. */
export function pruneSamples(dm: DrumMachine): DrumMachine {
  if (!dm.samples) return dm;
  const used = new Set(dm.rows.map(r => userSampleId(r.sound)).filter(Boolean) as string[]);
  const kept = Object.fromEntries(Object.entries(dm.samples).filter(([id]) => used.has(id)));
  return { ...dm, samples: kept };
}

// ===== Sauvegarde du projet (appelé par services/ProjectIO.ts) =====

/** Samples perso d'une piste à écrire dans le projet. */
export function padSampleFiles<B>(track: { drumMachine?: DrumMachine }, getBuffer: (key: string) => B | undefined): { id: string; filename: string; buffer: B }[] {
  const s = track.drumMachine?.samples;
  if (!s) return [];
  return Object.keys(s).flatMap(id => {
    const buffer = getBuffer(padSampleKey(id));
    return buffer ? [{ id, filename: `pad-${id}.wav`, buffer }] : [];
  });
}

/** À l'ouverture : chaque sample perso est décodé et rangé dans le registre. */
export async function restorePadSamples<B>(
  track: { drumMachine?: DrumMachine },
  read: (ref: string) => Promise<B | null>,
  register: (buffer: B, key: string) => void,
): Promise<number> {
  const s = track.drumMachine?.samples;
  if (!s) return 0;
  let n = 0;
  for (const [id, info] of Object.entries(s)) {
    const ref = info.audioRef;
    delete info.audioRef;
    if (!ref) continue;
    try {
      const buf = await read(ref);
      if (buf) { register(buf, padSampleKey(id)); n++; }
    } catch { /* son illisible : le pad reste muet */ }
  }
  return n;
}
