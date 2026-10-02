/**
 * Crêtes de forme d'onde pré-calculées, indépendantes du zoom.
 *
 * Avant, les crêtes étaient recalculées pour chaque largeur de clip à l'écran
 * (clé de cache = largeur) : chaque cran de zoom rebalayait tout le buffer, et
 * le tracé couvrait le clip entier même hors de l'écran. Ici chaque buffer est
 * résumé une seule fois en tableaux min/max à plusieurs résolutions
 * (256, 1024, 4096, 16384 échantillons par case) ; l'affichage ne lit que les
 * cases des pixels visibles, dans la résolution la plus grossière qui suffit.
 */

const BASE = 256;
const FACTOR = 4;
const LEVELS = 4;

interface PeakLevel {
  /** Échantillons par case. */
  spp: number;
  min: Float32Array;
  max: Float32Array;
}

const cache = new WeakMap<AudioBuffer, PeakLevel[]>();

const buildLevels = (buffer: AudioBuffer): PeakLevel[] => {
  const data = buffer.getChannelData(0);
  const n = Math.ceil(data.length / BASE);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    const a = i * BASE;
    const b = Math.min(a + BASE, data.length);
    for (let s = a; s < b; s++) {
      const v = data[s];
      if (v < lo) lo = v;
      else if (v > hi) hi = v;
    }
    min[i] = lo; max[i] = hi;
  }
  const levels: PeakLevel[] = [{ spp: BASE, min, max }];
  for (let l = 1; l < LEVELS; l++) {
    const prev = levels[l - 1];
    const m = Math.ceil(prev.min.length / FACTOR);
    const mn = new Float32Array(m);
    const mx = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      let lo = 0, hi = 0;
      const end = Math.min((i + 1) * FACTOR, prev.min.length);
      for (let j = i * FACTOR; j < end; j++) {
        if (prev.min[j] < lo) lo = prev.min[j];
        if (prev.max[j] > hi) hi = prev.max[j];
      }
      mn[i] = lo; mx[i] = hi;
    }
    levels.push({ spp: prev.spp * FACTOR, min: mn, max: mx });
  }
  return levels;
};

const levelsFor = (buffer: AudioBuffer): PeakLevel[] => {
  let levels = cache.get(buffer);
  if (!levels) { levels = buildLevels(buffer); cache.set(buffer, levels); }
  return levels;
};

let scratch = new Float32Array(2048);

/**
 * Enveloppe (0..1, amplitude crête × 1.3 comme l'ancien tracé) des pixels
 * [pxFrom, pxTo) d'un clip de `widthPx` pixels couvrant les échantillons
 * [startSample, endSample) du buffer. `reversed` lit la portion miroir (clip
 * inversé). Le tableau renvoyé est réutilisé d'un appel à l'autre.
 */
export const visibleEnvelope = (
  buffer: AudioBuffer, startSample: number, endSample: number,
  widthPx: number, pxFrom: number, pxTo: number, reversed: boolean
): Float32Array => {
  const count = Math.max(0, pxTo - pxFrom);
  if (scratch.length < count) scratch = new Float32Array(Math.ceil(count * 1.5));
  const out = scratch;
  const len = buffer.length;
  const spp = (endSample - startSample) / widthPx;
  const levels = spp >= BASE ? levelsFor(buffer) : null;
  let level: PeakLevel | null = null;
  if (levels) {
    for (const lv of levels) { if (lv.spp <= spp) level = lv; }
  }
  const data = level ? null : buffer.getChannelData(0);

  for (let i = 0; i < count; i++) {
    const px = pxFrom + i;
    let a = startSample + Math.floor(px * spp);
    let b = Math.min(startSample + Math.floor((px + 1) * spp), len);
    if (reversed) {
      const na = Math.max(0, len - b);
      const nb = Math.max(0, len - a);
      a = na; b = nb;
    }
    let peak = 0;
    if (level) {
      const i0 = Math.floor(a / level.spp);
      const i1 = Math.min(level.max.length, Math.ceil(b / level.spp));
      for (let k = i0; k < i1; k++) {
        const v = Math.max(-level.min[k], level.max[k]);
        if (v > peak) peak = v;
      }
    } else if (data) {
      for (let s = a; s < b; s++) {
        const v = Math.abs(data[s]);
        if (v > peak) peak = v;
      }
    }
    out[i] = Math.min(1, peak * 1.3);
  }
  return out;
};
