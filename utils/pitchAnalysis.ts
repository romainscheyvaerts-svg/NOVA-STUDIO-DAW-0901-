/**
 * Justesse note par note (V19) : analyse de hauteur d'une voix et découpage
 * en notes, comme Flex Pitch (Logic), Melodyne ou le Pitch Editor de FL.
 *
 * Logique pure, sans DOM (tests/pitchEdit.test.ts) ; tourne aussi dans le
 * worker utils/pitchEdit.worker.ts.
 *
 * 1. Hauteur trame par trame (toutes les 5 ms) : YIN sur un signal
 *    ré-échantillonné à ~12 kHz (rapide), puis affinage de la période au
 *    vrai taux d'échantillonnage (précision de l'ordre du cent).
 * 2. Nettoyage : trous très courts bouchés, sauts d'octave corrigés.
 * 3. Notes : un passage chanté continu est coupé là où la hauteur change
 *    nettement de palier (pas sur le vibrato) ou là où le niveau creuse
 *    (deux syllabes sur la même note).
 */

export interface PitchTrack {
  /** Taux d'échantillonnage de l'audio analysé. */
  sr: number;
  /** Écart entre deux trames, en échantillons (la trame i est centrée sur i·hop). */
  hop: number;
  /** Nombre d'échantillons analysés. */
  length: number;
  /** Hauteur MIDI fractionnaire de chaque trame ; NaN = pas de note (souffle, consonne, silence). */
  midi: Float32Array;
  /** Niveau de chaque trame (dBFS). */
  rmsDb: Float32Array;
}

export interface PitchNote {
  /** Rang de la note (0, 1, 2…) dans l'ordre du temps. */
  index: number;
  /** Trames [i0, i1[ de la note. */
  i0: number;
  i1: number;
  /** Début et fin (s), depuis le début de l'audio analysé. */
  start: number;
  end: number;
  /** Hauteur chantée (MIDI fractionnaire, médiane du cœur de la note). */
  center: number;
  /** Écart-type de la hauteur sur la note (demi-tons) : note tenue ou instable. */
  spread: number;
}

export interface AnalyzeOptions {
  /** Hauteurs extrêmes cherchées (Hz). Voix d'homme grave → voix de tête. */
  fmin?: number;
  fmax?: number;
  /** Seuil d'apériodicité de YIN (plus bas = plus strict). */
  threshold?: number;
  /** Écart entre trames (s). */
  hopSec?: number;
}

const DEFAULTS = { fmin: 65, fmax: 1100, threshold: 0.2, hopSec: 0.005 };

export const midiOfHz = (f: number) => 69 + 12 * Math.log2(f / 440);
export const hzOfMidi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Moyenne de plusieurs canaux (ou copie du seul canal). */
export function monoOf(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const y = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) y[i] += c[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) y[i] *= k;
  return y;
}

/** Ré-échantillonnage par moyenne de paquets (assez pour estimer une hauteur). */
function decimate(x: Float32Array, f: number): Float32Array {
  if (f <= 1) return x;
  const y = new Float32Array(Math.floor(x.length / f));
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    const o = i * f;
    for (let k = 0; k < f; k++) s += x[o + k];
    y[i] = s / f;
  }
  return y;
}

/**
 * YIN grossier sur le signal ré-échantillonné : renvoie la période (en
 * échantillons du signal réduit, fractionnaire) et l'apériodicité, ou null.
 */
function yinCoarse(y: Float32Array, center: number, W: number, tauMin: number, tauMax: number, thr: number, d: Float32Array): { tau: number; ap: number } | null {
  const from = Math.round(center - (W + tauMax) / 2);
  if (from < 0 || from + W + tauMax >= y.length) return null;
  d[0] = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = y[from + i] - y[from + i + tau]; s += v * v; }
    d[tau] = s;
  }
  // Différence normalisée cumulée (CMND).
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < thr) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    // Pas sous le seuil : minimum global, gardé seulement s'il reste correct.
    let m = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < m) { m = d[tau]; best = tau; }
    if (m > thr * 1.75) return null;
  }
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
  const den = a + c - 2 * b;
  const shift = Math.abs(den) > 1e-12 ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0;
  return { tau: best + shift, ap: b };
}

/**
 * Affinage de la période au vrai taux d'échantillonnage : différence
 * quadratique autour de la période grossière, minimum interpolé.
 */
function refinePeriod(x: Float32Array, center: number, T: number, span: number): number {
  const L = Math.max(256, Math.round(2.2 * T));
  const lo = Math.max(2, Math.floor(T - span)), hi = Math.ceil(T + span);
  const from = Math.round(center - (L + hi) / 2);
  if (from < 0 || from + L + hi >= x.length) return T;
  let bestTau = -1, bestD = Infinity;
  const ds: number[] = [];
  for (let tau = lo - 1; tau <= hi + 1; tau++) {
    let s = 0;
    for (let i = 0; i < L; i++) { const v = x[from + i] - x[from + i + tau]; s += v * v; }
    ds.push(s);
    if (tau >= lo && tau <= hi && s < bestD) { bestD = s; bestTau = tau; }
  }
  if (bestTau < 0) return T;
  const k = bestTau - (lo - 1);
  const a = ds[k - 1], b = ds[k], c = ds[k + 1];
  const den = a + c - 2 * b;
  const shift = Math.abs(den) > 1e-18 ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0;
  return bestTau + shift;
}

const medianOf = (v: number[]): number => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Hauteur perçue d'une note : moyenne des trames proches de la médiane (à
 * moins de 3/4 de demi-ton). La médiane seule est biaisée sur un vibrato
 * (une sinusoïde s'attarde à ses extrêmes) : mesuré, jusqu'à 5 cents d'erreur
 * sur un vibrato de ±15 cents.
 */
export function centerOf(v: number[]): number {
  const med = medianOf(v);
  if (Number.isNaN(med)) return med;
  let s = 0, c = 0;
  for (const x of v) if (Math.abs(x - med) <= 0.75) { s += x; c++; }
  return c ? s / c : med;
}

/**
 * Hauteur trame par trame d'un signal mono. Coût mesuré : ~0,1 s de calcul
 * par 10 s de voix (dans un worker, l'interface reste fluide).
 */
export function analyzePitch(x: Float32Array, sr: number, opts: AnalyzeOptions = {}): PitchTrack {
  const o = { ...DEFAULTS, ...opts };
  const hop = Math.max(16, Math.round(o.hopSec * sr));
  const frames = Math.max(0, Math.floor(x.length / hop) + 1);
  const midi = new Float32Array(frames).fill(NaN);
  const rmsDb = new Float32Array(frames);

  // Niveau par trame (fenêtre de 20 ms).
  const half = Math.round(0.01 * sr);
  for (let i = 0; i < frames; i++) {
    const c = i * hop;
    const a = Math.max(0, c - half), b = Math.min(x.length, c + half);
    let s = 0;
    for (let k = a; k < b; k++) s += x[k] * x[k];
    const r = b > a ? Math.sqrt(s / (b - a)) : 0;
    rmsDb[i] = r > 1e-9 ? 20 * Math.log10(r) : -180;
  }
  // Seuil de présence : 45 dB sous les passages forts (et jamais sous -65 dBFS).
  const sorted = Array.from(rmsDb).sort((a, b) => a - b);
  const loud = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : -180;
  const floor = Math.max(-65, loud - 45);

  const f = Math.max(1, Math.round(sr / 12000));
  const y = decimate(x, f);
  const ysr = sr / f;
  const tauMin = Math.max(2, Math.floor(ysr / o.fmax));
  const tauMax = Math.ceil(ysr / o.fmin);
  const W = Math.max(tauMax + 32, Math.round(0.03 * ysr));
  const d = new Float32Array(tauMax + 2);

  for (let i = 0; i < frames; i++) {
    if (rmsDb[i] < floor) continue;
    const c = i * hop;
    const r = yinCoarse(y, c / f, W, tauMin, tauMax, o.threshold, d);
    if (!r) continue;
    const T = refinePeriod(x, c, r.tau * f, f + 1.5);
    const hz = sr / T;
    if (hz < o.fmin * 0.9 || hz > o.fmax * 1.1) continue;
    midi[i] = midiOfHz(hz);
  }

  cleanTrack(midi);
  return { sr, hop, length: x.length, midi, rmsDb };
}

/** Bouche les trous d'une ou deux trames, retire les éclats isolés, corrige les sauts d'octave. */
function cleanTrack(m: Float32Array) {
  const n = m.length;
  // Éclats isolés (une ou deux trames voisées seules).
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(m[i])) continue;
    let j = i;
    while (j < n && !Number.isNaN(m[j])) j++;
    if (j - i <= 2) for (let k = i; k < j; k++) m[k] = NaN;
    i = j;
  }
  // Trous courts (≤ 3 trames) entre deux hauteurs proches : interpolés.
  for (let i = 1; i < n; i++) {
    if (!Number.isNaN(m[i]) || Number.isNaN(m[i - 1])) continue;
    let j = i;
    while (j < n && Number.isNaN(m[j])) j++;
    if (j < n && j - i <= 3 && Math.abs(m[j] - m[i - 1]) < 2) {
      for (let k = i; k < j; k++) m[k] = m[i - 1] + ((m[j] - m[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  // Bords de passage : la fenêtre d'analyse y est à moitié dans le silence, la
  // hauteur trouvée part souvent en vrille (pic dessiné en fin de note). Les 3
  // trames du bord qui s'écartent de plus de 0,6 demi-ton du cœur sont retirées.
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(m[i])) continue;
    let j = i;
    while (j < n && !Number.isNaN(m[j])) j++;
    if (j - i >= 10) {
      const inner = (a: number, b: number) => { const w: number[] = []; for (let k = a; k < b; k++) w.push(m[k]); return medianOf(w); };
      const head = inner(i + 3, i + 9), tail = inner(j - 9, j - 3);
      for (let k = i + 2; k >= i; k--) if (Math.abs(m[k] - head) > 0.6) { for (let q = i; q <= k; q++) m[q] = NaN; break; }
      for (let k = j - 3; k < j; k++) if (Math.abs(m[k] - tail) > 0.6) { for (let q = k; q < j; q++) m[q] = NaN; break; }
    }
    i = j;
  }
  // Sauts d'octave : comparés à la médiane locale (9 trames).
  const out = Float32Array.from(m);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(m[i])) continue;
    const w: number[] = [];
    for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) if (!Number.isNaN(m[k])) w.push(m[k]);
    const med = medianOf(w);
    const dlt = m[i] - med;
    if (Math.abs(Math.abs(dlt) - 12) < 1.5) out[i] = m[i] - 12 * Math.sign(dlt);
  }
  m.set(out);
}

export interface SegmentOptions {
  /** Écart de palier qui sépare deux notes (demi-tons). */
  stepSemis?: number;
  /** Durée minimale d'une note (s). */
  minNoteSec?: number;
  /** Creux de niveau (dB) qui sépare deux syllabes sur la même hauteur. */
  dipDb?: number;
}

/** Médiane glissante qui ignore les trames sans hauteur. */
function medianFilter(m: Float32Array, i0: number, i1: number, radius: number): Float32Array {
  const out = new Float32Array(i1 - i0);
  for (let i = i0; i < i1; i++) {
    const w: number[] = [];
    for (let k = Math.max(i0, i - radius); k <= Math.min(i1 - 1, i + radius); k++) if (!Number.isNaN(m[k])) w.push(m[k]);
    out[i - i0] = w.length ? medianOf(w) : NaN;
  }
  return out;
}

/**
 * Découpe les passages chantés en notes. Une note change quand la hauteur
 * passe d'un palier à un autre (au moins `stepSemis` d'écart entre les deux
 * paliers, chacun tenu au moins `minNoteSec`) ; le vibrato, qui oscille
 * autour d'un même centre, ne coupe pas la note.
 */
export function segmentNotes(track: PitchTrack, opts: SegmentOptions = {}): PitchNote[] {
  const step = opts.stepSemis ?? 0.7;
  const minLen = Math.max(3, Math.round((opts.minNoteSec ?? 0.06) * track.sr / track.hop));
  const dip = opts.dipDb ?? 9;
  const { midi, rmsDb } = track;
  const n = midi.length;
  const hopSec = track.hop / track.sr;

  // Passages chantés continus.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) continue;
    let j = i;
    while (j < n && !Number.isNaN(midi[j])) j++;
    if (j - i >= minLen) runs.push([i, j]);
    i = j;
  }

  const notes: PitchNote[] = [];
  for (const [r0, r1] of runs) {
    const sm = medianFilter(midi, r0, r1, 4);
    // Candidats de coupure : pente forte (palier qui change) ou creux de niveau.
    const L = r1 - r0;
    const span = Math.max(3, Math.round(0.03 / hopSec));
    const cuts: number[] = [];
    let i = span;
    while (i < L - span) {
      const jump = Math.abs(sm[i + span] - sm[i - span]);
      if (jump >= step) {
        // Point de coupure : plus forte pente locale sur la zone de saut.
        let best = i, bestSlope = 0, k = i;
        while (k < L - span && Math.abs(sm[k + span] - sm[k - span]) >= step * 0.6) {
          const sl = Math.abs(sm[Math.min(L - 1, k + 1)] - sm[Math.max(0, k - 1)]);
          if (sl > bestSlope) { bestSlope = sl; best = k; }
          k++;
        }
        cuts.push(best);
        i = Math.max(k, best + 1);
        continue;
      }
      i++;
    }
    // Creux de niveau (syllabes sur la même note).
    const win = Math.max(4, Math.round(0.06 / hopSec));
    for (let k = win; k < L - win; k++) {
      const v = rmsDb[r0 + k];
      let isMin = true, lmax = -Infinity, rmax = -Infinity;
      for (let q = k - win; q <= k + win; q++) {
        if (rmsDb[r0 + q] < v) { isMin = false; break; }
        if (q < k) lmax = Math.max(lmax, rmsDb[r0 + q]); else if (q > k) rmax = Math.max(rmax, rmsDb[r0 + q]);
      }
      if (isMin && lmax - v >= dip && rmax - v >= dip) cuts.push(k);
    }
    cuts.sort((a, b) => a - b);

    // Segments, puis fusion de ceux qui ne forment pas deux vrais paliers.
    let segs: [number, number][] = [];
    let a = 0;
    for (const c of cuts) { if (c - a >= 1) { segs.push([a, c]); a = c; } }
    segs.push([a, L]);
    const core = (s: [number, number]) => {
      const len = s[1] - s[0];
      const t = Math.floor(len * 0.15);
      const w: number[] = [];
      for (let k = s[0] + t; k < s[1] - t; k++) if (!Number.isNaN(midi[r0 + k])) w.push(midi[r0 + k]);
      return centerOf(w.length ? w : Array.from(sm.slice(s[0], s[1])).filter(v => !Number.isNaN(v)));
    };
    const isDipCut = (c: number) => {
      const v = rmsDb[r0 + c];
      let lmax = -Infinity, rmax = -Infinity;
      for (let q = Math.max(0, c - win); q < c; q++) lmax = Math.max(lmax, rmsDb[r0 + q]);
      for (let q = c + 1; q <= Math.min(L - 1, c + win); q++) rmax = Math.max(rmax, rmsDb[r0 + q]);
      return lmax - v >= dip && rmax - v >= dip;
    };
    let changed = true;
    while (changed && segs.length > 1) {
      changed = false;
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        const short = s[1] - s[0] < minLen;
        const prev = segs[k - 1], next = segs[k + 1];
        const samePrev = prev && !isDipCut(s[0]) && Math.abs(core(prev) - core(s)) < step;
        if (short || samePrev) {
          // Note trop courte : rattachée au voisin le plus proche en hauteur.
          let into = -1;
          if (samePrev) into = k - 1;
          else if (prev && next) into = Math.abs(core(prev) - core(s)) <= Math.abs(core(next) - core(s)) ? k - 1 : k + 1;
          else into = prev ? k - 1 : next ? k + 1 : -1;
          if (into < 0) continue;
          const lo = Math.min(k, into);
          segs.splice(lo, 2, [segs[lo][0], segs[lo + 1][1]]);
          changed = true;
          break;
        }
      }
    }
    for (const s of segs) {
      const i0 = r0 + s[0], i1 = r0 + s[1];
      const c = core(s);
      let acc = 0, cnt = 0;
      for (let k = i0; k < i1; k++) if (!Number.isNaN(midi[k])) { acc += (midi[k] - c) ** 2; cnt++; }
      notes.push({ index: notes.length, i0, i1, start: i0 * hopSec, end: i1 * hopSec, center: c, spread: cnt ? Math.sqrt(acc / cnt) : 0 });
    }
  }
  return notes;
}
