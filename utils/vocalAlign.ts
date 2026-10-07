/**
 * Alignement NOVA des doubles sur la voix lead (repli de VocAlign).
 *
 * Comme VocAlign en mode simple : on compare l'enveloppe et les attaques du
 * guide (la lead) et du double, on trouve la meilleure correspondance dans le
 * temps (DTW, déformation temporelle dynamique, limitée à ±maxShift), puis on
 * ré-étire le double par morceaux (WSOLA à vitesse variable : la hauteur ne
 * bouge pas) pour que ses attaques tombent sur celles du guide.
 *
 * Tout est pur (Float32Array → Float32Array) : testable et utilisable dans un
 * worker. Rien n'est destructif : l'appelant garde le double d'origine.
 */

export interface AlignOptions {
  /** Pas d'analyse (s). */
  hop?: number;
  /** Décalage maximal cherché (s) : au-delà ce n'est plus un double, c'est une autre phrase. */
  maxShift?: number;
  /** Rigueur 0..1 (1 = colle au plus près, 0.5 = garde un peu de flottement naturel). */
  tightness?: number;
}

export interface AlignResult {
  channels: Float32Array[];
  /** Carte temps du guide → temps du double (s), un point par pas d'analyse. */
  map: Float32Array;
  hop: number;
  /** Décalage moyen corrigé (ms, valeur absolue). */
  meanShiftMs: number;
  maxShiftMs: number;
}

const EPS = 1e-9;

function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

/**
 * Caractéristiques par trame : énergie (log), attaques (flux d'énergie positif)
 * et brillance (énergie de la dérivée, qui marque les consonnes).
 */
export function alignFeatures(x: Float32Array, sr: number, hop = 0.01): Float32Array[] {
  const h = Math.max(1, Math.round(hop * sr));
  const w = h * 2;
  const n = Math.max(1, Math.ceil(x.length / h));
  const energy = new Float32Array(n), bright = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0, d = 0;
    const a = k * h - (w >> 1);
    for (let i = 0; i < w; i++) {
      const j = a + i;
      if (j <= 0 || j >= x.length) continue;
      const v = x[j];
      e += v * v;
      const dv = v - x[j - 1];
      d += dv * dv;
    }
    energy[k] = Math.log10(e / w + EPS);
    bright[k] = Math.log10(d / w + EPS);
  }
  const onset = new Float32Array(n);
  for (let k = 1; k < n; k++) onset[k] = Math.max(0, energy[k] - energy[k - 1]);
  return [normalize(energy), normalize(onset), normalize(bright)];
}

function normalize(v: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  m /= v.length || 1;
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - m) ** 2;
  s = Math.sqrt(s / (v.length || 1)) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] - m) / s;
  return out;
}

/**
 * DTW bornée (bande ±band trames) : pour chaque trame du guide, la trame du
 * double qui lui correspond. Pas de pente > 2 (pas de saut brusque).
 */
export function dtwPath(g: Float32Array[], d: Float32Array[], band: number): Int32Array {
  const n = g[0].length, m = d[0].length;
  const W = 2 * band + 1;
  const INF = 1e30;
  const cost = new Float64Array(n * W).fill(INF);
  const from = new Int8Array(n * W); // 0 diag, 1 du guide seul (le double ralentit), 2 du double seul
  const wts = [1, 1.5, 0.6];
  const local = (i: number, j: number) => {
    let c = 0;
    for (let f = 0; f < g.length; f++) c += wts[f] * Math.abs(g[f][i] - d[f][j]);
    return c;
  };
  const idx = (i: number, j: number) => {
    const o = j - i + band;
    return o < 0 || o >= W ? -1 : i * W + o;
  };
  for (let i = 0; i < n; i++) {
    for (let o = 0; o < W; o++) {
      const j = i + o - band;
      if (j < 0 || j >= m) continue;
      const c = local(i, j);
      if (i === 0 && j === 0) { cost[i * W + o] = c; continue; }
      let best = INF, dir = 0;
      const a = i > 0 && j > 0 ? idx(i - 1, j - 1) : -1;
      if (a >= 0 && cost[a] + 2 * c < best) { best = cost[a] + 2 * c; dir = 0; }
      const b = i > 0 ? idx(i - 1, j) : -1;
      if (b >= 0 && cost[b] + c * 1.2 < best) { best = cost[b] + c * 1.2; dir = 1; }
      const e = j > 0 ? idx(i, j - 1) : -1;
      if (e >= 0 && cost[e] + c * 1.2 < best) { best = cost[e] + c * 1.2; dir = 2; }
      if (best < INF) { cost[i * W + o] = best; from[i * W + o] = dir; }
    }
  }
  // Fin : la meilleure case de la dernière trame du guide.
  let i = n - 1, bestO = -1, bestC = INF;
  for (let o = 0; o < W; o++) {
    const j = i + o - band;
    if (j < 0 || j >= m) continue;
    if (cost[i * W + o] < bestC) { bestC = cost[i * W + o]; bestO = o; }
  }
  const path = new Int32Array(n).fill(-1);
  if (bestO < 0) { for (let k = 0; k < n; k++) path[k] = Math.min(m - 1, k); return path; }
  let j = i + bestO - band;
  while (i >= 0 && j >= 0) {
    if (path[i] < 0) path[i] = j;
    const k = idx(i, j);
    if (k < 0 || (i === 0 && j === 0)) break;
    const dir = from[k];
    if (dir === 0) { i--; j--; } else if (dir === 1) { i--; } else { j--; }
  }
  for (let k = 0; k < n; k++) if (path[k] < 0) path[k] = k > 0 ? path[k - 1] : 0;
  return path;
}

/** Carte lissée, croissante, pente bornée [0.5, 2], en secondes. */
export function smoothMap(path: Int32Array, hop: number, tightness = 1, maxShift = 0.25): Float32Array {
  const n = path.length;
  const off = new Float32Array(n);
  for (let k = 0; k < n; k++) off[k] = (path[k] - k) * hop;
  // Médiane glissante (élimine les sauts isolés) puis moyenne glissante.
  const med = new Float32Array(n);
  const R = 4;
  const buf: number[] = [];
  for (let k = 0; k < n; k++) {
    buf.length = 0;
    for (let q = Math.max(0, k - R); q <= Math.min(n - 1, k + R); q++) buf.push(off[q]);
    buf.sort((a, b) => a - b);
    med[k] = buf[buf.length >> 1];
  }
  const A = Math.max(1, Math.round(0.03 / hop));
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - A); q <= Math.min(n - 1, k + A); q++) { s += med[q]; c++; }
    sm[k] = Math.max(-maxShift, Math.min(maxShift, (s / c) * tightness));
  }
  const map = new Float32Array(n);
  for (let k = 0; k < n; k++) map[k] = k * hop + sm[k];
  for (let k = 1; k < n; k++) {
    const lo = map[k - 1] + 0.5 * hop, hi = map[k - 1] + 2 * hop;
    map[k] = Math.min(hi, Math.max(lo, map[k]));
  }
  return map;
}

/**
 * WSOLA à vitesse variable : la sortie suit le temps du guide, chaque trame
 * est lue dans le double à l'instant donné par la carte (± une petite
 * recherche de forme d'onde pour des raccords sans phasing).
 */
export function warpChannels(channels: Float32Array[], sr: number, map: Float32Array, hop: number, outLength: number): Float32Array[] {
  const N = 1024, H = N >> 1, TOL = 160;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  const x = mono(channels);
  const out = channels.map(() => new Float32Array(outLength + N));
  const norm = new Float32Array(outLength + N);
  const at = (tOut: number) => {
    const f = tOut / hop;
    const k = Math.floor(f);
    if (k >= map.length - 1) return map[map.length - 1] + (tOut - (map.length - 1) * hop);
    if (k < 0) return tOut;
    return map[k] + (map[k + 1] - map[k]) * (f - k);
  };
  let prevSrc = -1;
  for (let o = 0; o < outLength; o += H) {
    const ideal = Math.round(at(o / sr) * sr);
    let src = ideal;
    if (prevSrc >= 0) {
      // Continuation naturelle de la trame précédente : prevSrc + H.
      const cont = prevSrc + H;
      let best = -Infinity;
      for (let dlt = -TOL; dlt <= TOL; dlt += 4) {
        const s = ideal + dlt;
        let c = 0;
        for (let i = 0; i < H; i += 8) {
          const a = cont + i, b = s + i;
          if (a < 0 || b < 0 || a >= x.length || b >= x.length) continue;
          c += x[a] * x[b];
        }
        if (c > best) { best = c; src = s; }
      }
    }
    prevSrc = src;
    for (let ch = 0; ch < channels.length; ch++) {
      const inp = channels[ch], dst = out[ch];
      for (let i = 0; i < N; i++) {
        const j = src + i;
        if (j < 0 || j >= inp.length) continue;
        dst[o + i] += inp[j] * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[o + i] += win[i];
  }
  return out.map(c => {
    const r = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) r[i] = norm[i] > 1e-3 ? c[i] / norm[i] : 0;
    return r;
  });
}

/** Aligne `dub` sur `guide` (mêmes fréquences d'échantillonnage, mêmes instants de départ). */
export function alignToGuide(guide: Float32Array[], dub: Float32Array[], sr: number, opts: AlignOptions = {}): AlignResult {
  const hop = opts.hop ?? 0.01;
  const maxShift = opts.maxShift ?? 0.25;
  const g = alignFeatures(mono(guide), sr, hop);
  const d = alignFeatures(mono(dub), sr, hop);
  const path = dtwPath(g, d, Math.round(maxShift / hop));
  const map = smoothMap(path, hop, opts.tightness ?? 1, maxShift);
  const outLength = dub[0].length;
  const channels = warpChannels(dub, sr, map, hop, outLength);
  let sum = 0, mx = 0;
  for (let k = 0; k < map.length; k++) {
    const s = Math.abs(map[k] - k * hop) * 1000;
    sum += s;
    mx = Math.max(mx, s);
  }
  return { channels, map, hop, meanShiftMs: sum / Math.max(1, map.length), maxShiftMs: mx };
}

/** Attaques (s) : montées d'énergie franches après un creux. Sert aux mesures avant / après. */
export function detectOnsets(x: Float32Array, sr: number, hop = 0.005, thresholdDb = 12): number[] {
  const h = Math.max(1, Math.round(hop * sr));
  const n = Math.floor(x.length / h);
  const db = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = 0; i < h; i++) { const v = x[k * h + i]; e += v * v; }
    db[k] = 10 * Math.log10(e / h + 1e-12);
  }
  const out: number[] = [];
  let floor = db[0], armed = true;
  for (let k = 1; k < n; k++) {
    floor = Math.min(floor + 0.15, db[k]);
    if (armed && db[k] - floor > thresholdDb) {
      out.push(k * hop);
      armed = false;
    } else if (!armed && db[k] < floor + 3) {
      armed = true;
    }
    if (!armed) floor = Math.min(floor, db[k]);
  }
  return out;
}

/** Écart moyen (ms) entre chaque attaque de `a` et l'attaque la plus proche de `b`. */
export function onsetError(a: number[], b: number[], within = 0.2): { meanMs: number; maxMs: number; matched: number } {
  let s = 0, mx = 0, c = 0;
  for (const t of a) {
    let best = Infinity;
    for (const u of b) best = Math.min(best, Math.abs(u - t));
    if (best <= within) { s += best; mx = Math.max(mx, best); c++; }
  }
  return { meanMs: c ? (s / c) * 1000 : 0, maxMs: mx * 1000, matched: c };
}
