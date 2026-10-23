/**
 * Échelle des faders de NOVA (22/10/2026) : course de −∞ à +12 dB, comme une console de studio.
 * Module pur (tests/faderLaw.test.ts).
 *
 * Avant : la position suivait la racine du gain sur 0…1,5 (butée à +3,5 dB, 0 dB vers 82 %).
 * Maintenant : segments linéaires en dB, 0 dB aux 3/4 de la course, résolution fine autour
 * de 0 dB (5 dB tous les 10 % entre −10 et 0, 6 dB par 12,5 % au-dessus), graduations
 * +12 / +6 / 0 / −5 / −10 / −20 / −30 / −40 / −60 / −∞.
 *
 * La valeur stockée reste le gain linéaire (track.volume, niveau d'envoi…) : les anciens
 * projets gardent exactement leur niveau ; seule la position du fader à l'écran change.
 */

export const FADER_MAX_DB = 12;
/** Gain linéaire de la butée haute (+12 dB ≈ 3,98). */
export const FADER_MAX_GAIN = Math.pow(10, FADER_MAX_DB / 20);
/** Ancienne butée (+3,5 dB) : sert à reconnaître les anciennes voies d'automation. */
export const LEGACY_FADER_MAX_GAIN = 1.5;

/** Points (position 0…1, dB) de l'échelle, de haut en bas. */
const SCALE: ReadonlyArray<readonly [number, number]> = [
  [1, 12],
  [0.875, 6],
  [0.75, 0],
  [0.65, -5],
  [0.55, -10],
  [0.4, -20],
  [0.28, -30],
  [0.18, -40],
  [0.07, -60],
  [0.005, -120],
];
const FLOOR_POS = 0.005;
const FLOOR_GAIN = Math.pow(10, -120 / 20);

/** Position de 0 dB (double-clic / Alt+clic). */
export const FADER_UNITY_POS = 0.75;

/** Graduations du fader : dB (−Infinity = −∞) et position. */
export const FADER_TICKS: ReadonlyArray<{ db: number; pos: number; label: string }> = [
  ...SCALE.slice(0, -1).map(([pos, db]) => ({ db, pos, label: db > 0 ? `+${db}` : `${db}`.replace('-', '−') })),
  { db: -Infinity, pos: 0, label: '−∞' },
];

const dbOf = (g: number) => 20 * Math.log10(g);

/** Position 0…1 → dB (−Infinity en bas). */
export function faderPosToDb(pos: number): number {
  const p = Number.isFinite(pos) ? Math.max(0, Math.min(1, pos)) : 0;
  if (p <= 0) return -Infinity;
  if (p < FLOOR_POS) return dbOf(FLOOR_GAIN * p / FLOOR_POS);
  for (let i = 0; i < SCALE.length - 1; i++) {
    const [p1, d1] = SCALE[i], [p0, d0] = SCALE[i + 1];
    if (p >= p0) return p === p1 ? d1 : p === p0 ? d0 : d0 + (d1 - d0) * (p - p0) / (p1 - p0);
  }
  return -120;
}

/** Position 0…1 → gain linéaire (0 = −∞, 1 = +12 dB). */
export function faderPosToGain(pos: number): number {
  const p = Number.isFinite(pos) ? Math.max(0, Math.min(1, pos)) : 0;
  if (p <= 0) return 0;
  if (p < FLOOR_POS) return FLOOR_GAIN * p / FLOOR_POS;
  const db = faderPosToDb(p);
  // Valeurs pile sur les graduations : gain exact (0 dB = 1, pas 0,9999999).
  return db === 0 ? 1 : Math.pow(10, db / 20);
}

/** dB → position 0…1. */
export function dbToFaderPos(db: number): number {
  if (!(db > -Infinity) || Number.isNaN(db)) return 0;
  if (db >= FADER_MAX_DB) return 1;
  if (db <= -120) return Math.max(0, FLOOR_POS * Math.pow(10, db / 20) / FLOOR_GAIN);
  for (let i = 0; i < SCALE.length - 1; i++) {
    const [p1, d1] = SCALE[i], [p0, d0] = SCALE[i + 1];
    if (db >= d0) return db === d1 ? p1 : db === d0 ? p0 : p0 + (p1 - p0) * (db - d0) / (d1 - d0);
  }
  return 0;
}

/** Gain linéaire → position 0…1 (borné à la course). */
export function gainToFaderPos(g: number): number {
  if (!(g > 0) || !Number.isFinite(g)) return g === Infinity ? 1 : 0;
  if (g === 1) return FADER_UNITY_POS;
  if (g < FLOOR_GAIN) return FLOOR_POS * g / FLOOR_GAIN;
  return dbToFaderPos(dbOf(g));
}

/** Gain borné à la course du fader (0…+12 dB). */
export const clampFaderGain = (g: number): number => (Number.isFinite(g) ? Math.max(0, Math.min(FADER_MAX_GAIN, g)) : (g === Infinity ? FADER_MAX_GAIN : 0));
