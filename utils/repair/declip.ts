/**
 * Écart 7 · Écrêtage (« déclippeur ») : la voix a saturé l'entrée (crêtes
 * coupées à plat). Les échantillons coupés sont reconstruits par interpolation
 * LSAR (utils/repair/dsp) à partir d'un modèle AR appris sur le seul son sain
 * autour, avec la contrainte physique de l'écrêtage : la vraie crête était AU
 * MOINS aussi haute que le plafond (Godsill et Rayner 1998, § 5.2 ; Janssen et
 * al. 1986). Deux passes : la seconde profite des crêtes voisines déjà réparées.
 *
 * Les crêtes reconstruites dépassent le plafond : en option, le clip est baissé
 * juste assez pour qu'aucune crête ne dépasse −1 dBFS (sinon l'export
 * réécrêterait).
 */
import { arMasked, dbToLin, linToDb, lsarFill } from './dsp';

export interface DeclipStats {
  /** Passages écrêtés trouvés (crêtes coupées). */
  runs: number;
  /** Échantillons reconstruits. */
  samples: number;
  /** Plafond trouvé (dBFS, le plus haut des deux signes). */
  ceilingDb: number | null;
  /** Gain appliqué pour éviter un nouvel écrêtage (dB, ≤ 0). */
  gainDb: number;
}

/** Au moins 2 échantillons à plat au plafond : une crête isolée n'est pas un écrêtage. */
const MIN_RUN = 2;
/**
 * Tolérance autour du plafond (relative, quelques pas d'un convertisseur 24 bits) :
 * un vrai écrêtage numérique est plat ; le sommet arrondi d'une sinusoïde grave
 * (même à 30 Hz) s'en écarte déjà de plus de 2·10⁻⁶ un échantillon plus loin.
 */
const CEIL_TOL = 2e-6;
/** Passage trop long : on ne réinvente pas 20 ms de son (rendu inchangé). */
const MAX_RUN_S = 0.02;
/** Sortie : crête maximale si la baisse est demandée. */
export const DECLIP_PEAK_DB = -1;

/** Trouve les passages écrêtés d'un canal : [début, fin) et signe. */
export function findClipRuns(x: Float32Array, sampleRate: number): { runs: { from: number; to: number; sign: 1 | -1 }[]; pos: number; neg: number } {
  let pos = 0, neg = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (v > pos) pos = v; else if (v < neg) neg = v; }
  const runs: { from: number; to: number; sign: 1 | -1 }[] = [];
  const maxRun = Math.max(MIN_RUN, Math.round(MAX_RUN_S * sampleRate));
  const tp = pos - Math.max(1e-7, pos * CEIL_TOL), tn = neg + Math.max(1e-7, -neg * CEIL_TOL);
  let i = 0;
  while (i < x.length) {
    const s = pos > 0.05 && x[i] >= tp ? 1 : neg < -0.05 && x[i] <= tn ? -1 : 0;
    if (!s) { i++; continue; }
    let j = i + 1;
    while (j < x.length && (s > 0 ? x[j] >= tp : x[j] <= tn)) j++;
    // 2 échantillons seulement : il faut qu'ils soient vraiment à plat (le sommet
    // d'une sinusoïde grave tombé entre deux échantillons ne compte pas).
    const flat = j - i > MIN_RUN || Math.abs(x[i] - x[i + 1]) <= 1e-7;
    if (j - i >= MIN_RUN && j - i <= maxRun && flat) runs.push({ from: i, to: j, sign: s as 1 | -1 });
    i = j;
  }
  return { runs, pos, neg };
}

/**
 * Reconstruit les crêtes coupées (en place sur une copie renvoyée). Les canaux
 * sont traités chacun de leur côté ; la baisse éventuelle est commune.
 */
export function declipChannels(chs: Float32Array[], sampleRate: number, o: { lowerGain?: boolean } = {}): { channels: Float32Array[]; stats: DeclipStats } {
  let runsTotal = 0, samples = 0, ceil = 0;
  const out = chs.map(ch => {
    const { runs, pos, neg } = findClipRuns(ch, sampleRate);
    if (!runs.length) return ch;
    ceil = Math.max(ceil, pos, -neg);
    const y = new Float64Array(ch);
    const bad = new Uint8Array(ch.length);
    for (const r of runs) for (let i = r.from; i < r.to; i++) bad[i] = 1;
    runsTotal += runs.length;
    // Modèle AR par bloc (2048 échantillons de son sain autour de chaque passage).
    const BLOCK = 2048;
    const models = new Map<number, Float64Array | null>();
    const modelFor = (center: number) => {
      const b = Math.floor(center / BLOCK);
      if (models.has(b)) return models.get(b)!;
      const from = Math.max(0, b * BLOCK - BLOCK / 2), to = Math.min(ch.length, (b + 1) * BLOCK + BLOCK / 2);
      let m: Float64Array | null = null;
      for (let p = 24; p >= 4 && !m; p = Math.floor(p / 2)) m = arMasked(y, from, to, p, bad);
      models.set(b, m);
      return m;
    };
    for (let pass = 0; pass < 2; pass++) {
      for (const r of runs) {
        const c = modelFor((r.from + r.to) >> 1);
        if (!c) continue;
        const before = y.slice(r.from, r.to);
        if (!lsarFill(y, r.from, r.to, c)) { y.set(before, r.from); continue; }
        // Contrainte : la vraie crête dépassait le plafond.
        const lvl = r.sign > 0 ? pos : neg;
        for (let i = r.from; i < r.to; i++) {
          if (r.sign > 0 ? y[i] < lvl : y[i] > lvl) y[i] = lvl;
          // Garde-fou : jamais plus de 4 fois le plafond (+12 dB).
          if (Math.abs(y[i]) > 4 * Math.abs(lvl)) y[i] = 4 * lvl;
        }
        if (pass === 0) samples += r.to - r.from;
      }
    }
    return Float32Array.from(y);
  });
  let gainDb = 0;
  if (runsTotal && o.lowerGain !== false) {
    let peak = 0;
    for (const ch of out) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
    const limit = dbToLin(DECLIP_PEAK_DB);
    if (peak > limit) {
      const g = limit / peak;
      gainDb = linToDb(g);
      for (let c = 0; c < out.length; c++) {
        // Un canal intact reçoit la même baisse (image stéréo gardée), sur une copie.
        const src = out[c] === chs[c] ? new Float32Array(out[c]) : out[c];
        for (let i = 0; i < src.length; i++) src[i] *= g;
        out[c] = src;
      }
    }
  }
  return { channels: out, stats: { runs: runsTotal, samples, ceilingDb: ceil > 0 ? linToDb(ceil) : null, gainDb } };
}
