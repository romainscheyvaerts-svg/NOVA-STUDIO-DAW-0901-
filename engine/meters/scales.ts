/**
 * Échelles des vumètres (R11), au choix comme dans Pro Tools (Préférences >
 * Affichage > Type de mètre) : Sample Peak Pro Tools, dBFS linéaire, VU et
 * K-System de Bob Katz (K-20 / K-14 / K-12).
 *
 *  - crête : la barre suit la crête échantillon (retombée rapide), le RMS
 *    est dessiné à l'intérieur, plus sombre ;
 *  - RMS (VU, K) : la barre suit le RMS intégré sur 300 ms, la crête est un
 *    trait fin au-dessus.
 */

export type MeterScaleId = 'pt' | 'dbfs' | 'vu' | 'k20' | 'k14' | 'k12';

export interface MeterScale {
  id: MeterScaleId;
  label: string;
  hint: string;
  ballistics: 'peak' | 'rms';
  /** Bas et haut de la course, en dBFS. */
  floorDb: number;
  topDb: number;
  /** Zéro de l'échelle (VU : −18 dBFS ; K-20 : −20 dBFS…), en dBFS. */
  refDb: number;
  /** Points (dBFS → fraction de la course), interpolés linéairement. */
  curve: [number, number][];
  /** Graduations (dBFS, étiquette). */
  marks: { db: number; label: string }[];
  /** Couleurs : vert sous `amberDb`, ambre jusqu'à `redDb`, rouge au-dessus (dBFS). */
  amberDb: number;
  redDb: number;
}

const k = (id: 'k20' | 'k14' | 'k12', ref: number): MeterScale => ({
  id, label: `K-${-ref}`, ballistics: 'rms',
  hint: `K-System ${-ref} (Bob Katz) : 0 = ${ref} dBFS RMS, le haut = 0 dBFS. ${ref === -20 ? 'Musique dynamique, film, classique.' : ref === -14 ? 'Pop, rock, la plupart des mixes.' : 'Radio, mastering très fort.'} Vert sous 0, ambre jusqu'à +4, rouge au-dessus.`,
  floorDb: ref - 24, topDb: 0, refDb: ref,
  curve: [[ref - 24, 0], [0, 1]],
  marks: [-ref, 12, 8, 4, 0, -4, -8, -12, -20].filter((v, i, a) => v <= -ref && a.indexOf(v) === i).map(v => ({ db: ref + v, label: v > 0 ? `+${v}` : String(v) })),
  amberDb: ref, redDb: ref + 4,
});

export const METER_SCALES: MeterScale[] = [
  {
    id: 'pt', label: 'Sample Peak', ballistics: 'peak',
    hint: 'Échelle de Pro Tools (Sample Peak) : crête échantillon par canal, plus de place en haut de la course.',
    floorDb: -60, topDb: 0, refDb: 0,
    curve: [[-60, 0], [-50, 0.06], [-40, 0.13], [-30, 0.25], [-24, 0.35], [-18, 0.48], [-12, 0.64], [-6, 0.82], [-3, 0.91], [0, 1]],
    marks: [0, -3, -6, -12, -18, -24, -30, -40, -60].map(d => ({ db: d, label: d === 0 ? '0' : String(-d) })),
    amberDb: -12, redDb: -3,
  },
  {
    id: 'dbfs', label: 'dBFS', ballistics: 'peak',
    hint: 'Crête en dBFS, course linéaire de −60 à 0 dB.',
    floorDb: -60, topDb: 0, refDb: 0,
    curve: [[-60, 0], [0, 1]],
    marks: [0, -6, -12, -18, -24, -36, -48, -60].map(d => ({ db: d, label: d === 0 ? '0' : String(-d) })),
    amberDb: -12, redDb: -3,
  },
  {
    id: 'vu', label: 'VU', ballistics: 'rms',
    hint: 'VU-mètre : RMS intégré sur 300 ms, 0 VU = −18 dBFS (alignement des consoles et des plugins analogiques).',
    floorDb: -38, topDb: -15, refDb: -18,
    curve: [[-38, 0], [-28, 0.3], [-25, 0.42], [-23, 0.52], [-21, 0.63], [-19, 0.76], [-18, 0.82], [-15, 1]],
    marks: [3, 0, -3, -5, -7, -10, -20].map(v => ({ db: -18 + v, label: v > 0 ? `+${v}` : String(v) })),
    amberDb: -18, redDb: -16,
  },
  k('k20', -20),
  k('k14', -14),
  k('k12', -12),
];

export const scaleById = (id: string | null | undefined): MeterScale => METER_SCALES.find(s => s.id === id) || METER_SCALES[0];

/** Position (0 = bas, 1 = haut) d'un niveau en dBFS sur l'échelle. */
export function scaleFrac(s: MeterScale, dbfs: number): number {
  const c = s.curve;
  if (!(dbfs > c[0][0])) return 0;
  if (dbfs >= c[c.length - 1][0]) return 1;
  for (let i = 1; i < c.length; i++) {
    if (dbfs <= c[i][0]) {
      const [d0, f0] = c[i - 1], [d1, f1] = c[i];
      return f0 + (f1 - f0) * (dbfs - d0) / (d1 - d0);
    }
  }
  return 1;
}

/** Valeur lue dans l'unité de l'échelle (VU / K : relative au zéro de l'échelle). */
export function scaleReading(s: MeterScale, dbfs: number): string {
  if (!(dbfs > -120)) return '−∞';
  const v = dbfs - s.refDb;
  const t = v.toFixed(1).replace('.', ',').replace('-', '−');
  return v > 0.05 && s.refDb !== 0 ? `+${t}` : t;
}
