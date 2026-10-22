import { TrackType, type Clip, type Track } from '../types';
import { clipGainAt } from './fades';

/**
 * Suiveur d'enveloppe (modulateur, 22/10/2026) : le NIVEAU d'une piste source fait bouger un
 * réglage d'une autre piste (la grosse caisse creuse la basse, la voix ferme une nappe…).
 *
 * Le niveau est lu dans les clips audio de la source (gain du clip, fondus, ligne de gain compris,
 * avant ses effets et son fader : une source coupée ou muette pilote quand même, comme une clé de
 * side-chain) : crête par bloc de 1 ms, ramenée à 0…1 en dB (−60 dBFS → 0, 0 dBFS → 1), puis suiveur
 * à attaque / relâchement (un pôle, en dB : un relâchement de 120 ms retombe vraiment en ~3 × 120 ms).
 * Calculé une fois (mémorisé), puis la courbe s'ajoute à la voie comme un LFO (utils/modulators) :
 * la même en lecture et à l'export, rien de plus qui tourne pendant la lecture.
 *
 * Module pur : tests/envelopeFollower.test.ts.
 */

/** Taille d'un bloc de mesure (s). */
export const ENV_BLOCK_SEC = 0.001;
/** Niveau le plus bas pris en compte (dBFS) : en dessous, le suiveur vaut 0 ; à 0 dBFS, il vaut 1. */
export const ENV_FLOOR_DB = -60;

export interface EnvSource {
  start: number;
  duration: number;
  offset: number;
  channels: Float32Array[];
  sampleRate: number;
  /** Gain du clip à l'instant t du clip (fondus, ligne de gain). */
  gainAt: (t: number) => number;
  reversed?: boolean;
}

/** Clips audio d'une piste qui sonnent (avec leur son chargé), prêts pour le suiveur. */
export function envSourcesOf(track: Pick<Track, 'clips'> | undefined, bufferOf: (c: Clip) => AudioBuffer | undefined): EnvSource[] {
  const out: EnvSource[] = [];
  for (const c of track?.clips || []) {
    if (c.isMuted || c.type === TrackType.MIDI) continue;
    const b = bufferOf(c);
    if (!b || !(c.duration > 0)) continue;
    const ch: Float32Array[] = [];
    for (let k = 0; k < b.numberOfChannels; k++) ch.push(b.getChannelData(k));
    out.push({ start: c.start, duration: c.duration, offset: c.offset || 0, channels: ch, sampleRate: b.sampleRate, reversed: !!c.isReversed, gainAt: (t: number) => clipGainAt(c, t) });
  }
  return out;
}

/**
 * Crête (linéaire) par bloc de ENV_BLOCK_SEC, du début du morceau à `end` : somme des clips
 * qui se recouvrent (fondu enchaîné), gain du clip au milieu du bloc.
 */
export function blockPeaks(sources: EnvSource[], end: number): Float32Array {
  const n = Math.max(0, Math.ceil(end / ENV_BLOCK_SEC));
  const out = new Float32Array(n);
  for (const s of sources) {
    const sr = s.sampleRate, len = s.channels[0]?.length || 0;
    const b0 = Math.max(0, Math.floor(s.start / ENV_BLOCK_SEC));
    const b1 = Math.min(n, Math.ceil((s.start + s.duration) / ENV_BLOCK_SEC));
    for (let b = b0; b < b1; b++) {
      const t0 = Math.max(s.start, b * ENV_BLOCK_SEC), t1 = Math.min(s.start + s.duration, (b + 1) * ENV_BLOCK_SEC);
      if (t1 <= t0) continue;
      const i0 = Math.floor((t0 - s.start + s.offset) * sr), i1 = Math.min(len, Math.ceil((t1 - s.start + s.offset) * sr));
      let m = 0;
      for (const x of s.channels) for (let i = Math.max(0, i0); i < i1; i++) { const v = Math.abs(x[s.reversed ? len - 1 - i : i]); if (v > m) m = v; }
      if (m > 0) out[b] += m * Math.abs(s.gainAt((t0 + t1) / 2 - s.start));
    }
  }
  return out;
}

/**
 * Suiveur à attaque / relâchement (ms) : niveau 0…1 (en dB) par bloc, montée en `attack`,
 * retombée en `release` (constantes de temps : 63 % du chemin parcouru).
 */
export function followEnvelope(peaks: Float32Array, attackMs: number, releaseMs: number): Float32Array {
  const coef = (ms: number) => (ms > 0 ? 1 - Math.exp(-(ENV_BLOCK_SEC * 1000) / ms) : 1);
  const a = coef(attackMs), r = coef(releaseMs);
  const out = new Float32Array(peaks.length);
  let e = 0;
  for (let i = 0; i < peaks.length; i++) {
    const x = envUnit(peaks[i]);
    e += (x - e) * (x > e ? a : r);
    // Retombé à moins d'un dix-millième de la course (sous le plancher) : 0, les paliers restent plats.
    if (x === 0 && e < 1e-4) e = 0;
    out[i] = e;
  }
  return out;
}

/** Niveau linéaire → 0…1 (ENV_FLOOR_DB → 0, 0 dBFS → 1, linéaire en dB). */
export const envUnit = (level: number): number => {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.max(0, Math.min(1, (db - ENV_FLOOR_DB) / -ENV_FLOOR_DB));
};

/** Valeur 0…1 du suiveur (followEnvelope) à l'instant t, interpolée entre deux blocs. */
export function envUnitAt(env: Float32Array, t: number): number {
  const x = t / ENV_BLOCK_SEC - 0.5;
  if (!(x > 0)) return env[0] || 0;
  const i = Math.floor(x);
  if (i >= env.length - 1) return env[env.length - 1] || 0;
  return env[i] + (env[i + 1] - env[i]) * (x - i);
}
