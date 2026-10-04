import { Clip } from '../types';

/**
 * Nettoyage des blancs d'une prise de voix (« strip silence »).
 *
 * Non destructif : l'audio n'est jamais modifié. Le clip est remplacé par des
 * clips qui ne couvrent que les passages chantés (même buffer, offsets
 * différents), avec de courts fondus pour éviter les clics. Annuler (Ctrl+Z)
 * rend le clip d'origine.
 */

export interface StripSilenceOptions {
  /** Taille de la fenêtre d'analyse (s). */
  windowSec?: number;
  /** Un blanc plus court que ça est conservé (respirations, coupures entre mots). */
  minSilenceSec?: number;
  /** Un son plus court que ça est ignoré (clic, bruit de bouche isolé). */
  minSoundSec?: number;
  /** Marge gardée avant chaque passage (attaque, respiration). */
  preRollSec?: number;
  /** Marge gardée après chaque passage (fin de mot, queue de réverb naturelle). */
  postRollSec?: number;
  /** Un passage plus court que ça (marges comprises) ne devient pas un clip à lui seul. */
  minClipSec?: number;
  /** Un passage trop court rejoint un voisin à moins de cette distance (sinon : bruit retiré). */
  joinGapSec?: number;
}

export interface VoiceSegment {
  /** Positions dans le buffer (s). */
  start: number;
  end: number;
}

const DEFAULTS: Required<StripSilenceOptions> = {
  windowSec: 0.02,
  minSilenceSec: 0.35,
  minSoundSec: 0.08,
  preRollSec: 0.08,
  postRollSec: 0.15,
  minClipSec: 0.5,
  joinGapSec: 1.5,
};

const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

/**
 * Passages chantés de [from, to] (s) dans le buffer.
 * Le seuil s'adapte à la prise : au-dessus du bruit de fond mesuré et à moins
 * de 40 dB du passage le plus fort, sans descendre sous -50 dBFS.
 */
export function detectVoiceSegments(
  buffer: AudioBuffer,
  from = 0,
  to = buffer.duration,
  options: StripSilenceOptions = {}
): VoiceSegment[] {
  const o = { ...DEFAULTS, ...options };
  const sr = buffer.sampleRate;
  const win = Math.max(1, Math.round(o.windowSec * sr));
  const first = Math.max(0, Math.floor(from * sr));
  const last = Math.min(buffer.length, Math.ceil(to * sr));
  if (last - first < win * 2) return [{ start: from, end: to }];

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const rmsDb: number[] = [];
  for (let i = first; i < last; i += win) {
    let sum = 0;
    const end = Math.min(last, i + win);
    for (let j = i; j < end; j++) {
      let v = 0;
      for (const ch of channels) v += ch[j];
      v /= channels.length;
      sum += v * v;
    }
    rmsDb.push(toDb(Math.sqrt(sum / (end - i))));
  }

  const sorted = [...rmsDb].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[sorted.length - 1];
  const threshold = Math.max(-50, noiseFloor + 8, peak - 40);
  // Prise entièrement silencieuse (ou quasi) : rien à garder.
  if (peak < -60) return [];

  // Fenêtres au-dessus du seuil → intervalles bruts
  const raw: VoiceSegment[] = [];
  let openAt = -1;
  rmsDb.forEach((db, idx) => {
    const t = (first + idx * win) / sr;
    if (db >= threshold && openAt < 0) openAt = t;
    if (db < threshold && openAt >= 0) { raw.push({ start: openAt, end: t }); openAt = -1; }
  });
  if (openAt >= 0) raw.push({ start: openAt, end: last / sr });

  // Fusion des trous trop courts pour être de vrais blancs
  const merged: VoiceSegment[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && s.start - prev.end < o.minSilenceSec) prev.end = s.end;
    else merged.push({ ...s });
  }

  // Sons trop brefs ignorés, marges ajoutées, puis re-fusion si les marges se touchent
  const padded = merged
    .filter((s) => s.end - s.start >= o.minSoundSec)
    .map((s) => ({ start: Math.max(from, s.start - o.preRollSec), end: Math.min(to, s.end + o.postRollSec) }));
  const out: VoiceSegment[] = [];
  for (const s of padded) {
    const prev = out[out.length - 1];
    if (prev && s.start <= prev.end) prev.end = Math.max(prev.end, s.end);
    else out.push(s);
  }

  // Pas de miettes sur la piste : un passage très court (mot bref, souffle)
  // rejoint le passage voisin s'il est proche ; s'il est isolé, c'est un bruit
  // (le clic de souris qui arrête REC, typiquement) et il est retiré.
  // Une prise qui ne contient que ce passage le garde. Annuler rend tout.
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.end - s.start >= o.minClipSec) continue;
      const gapPrev = i > 0 ? s.start - out[i - 1].end : Infinity;
      const gapNext = i < out.length - 1 ? out[i + 1].start - s.end : Infinity;
      if (Math.min(gapPrev, gapNext) <= o.joinGapSec) {
        if (gapPrev <= gapNext) out[i - 1].end = s.end;
        else out[i + 1].start = s.start;
      }
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return out;
}

export interface StripSilenceResult {
  clips: Clip[];
  /** Durée de blanc retirée (s). */
  removedSec: number;
}

/**
 * Remplace un clip audio par ses passages chantés.
 * Renvoie null si rien à retirer (pas de blanc significatif).
 */
export function stripSilenceFromClip(
  clip: Clip,
  buffer: AudioBuffer,
  options: StripSilenceOptions = {}
): StripSilenceResult | null {
  if (clip.isReversed) return null; // offsets inversés : on ne touche pas
  const from = clip.offset || 0;
  const to = Math.min(buffer.duration, from + clip.duration);
  const segments = detectVoiceSegments(buffer, from, to, options);
  const kept = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const removedSec = (to - from) - kept;
  // Moins de 0,3 s de blanc au total : on laisse le clip tel quel.
  if (segments.length === 0 || removedSec < 0.3) return null;

  const stamp = Date.now();
  const clips: Clip[] = segments.map((s, i) => ({
    ...clip,
    id: `${clip.id}-v${i}-${stamp}`,
    start: clip.start + (s.start - from),
    offset: s.start,
    duration: s.end - s.start,
    fadeIn: Math.min(0.01, (s.end - s.start) / 4),
    fadeOut: Math.min(0.04, (s.end - s.start) / 4),
    name: segments.length > 1 ? `${clip.name} · ${i + 1}` : clip.name,
  }));
  return { clips, removedSec };
}
