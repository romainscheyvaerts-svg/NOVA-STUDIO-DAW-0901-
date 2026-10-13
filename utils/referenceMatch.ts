/**
 * « Caler sur la référence » (lot 4b, Reference Matching de BandLab) : logique
 * pure, utilisable dans le navigateur, dans un Worker et dans les tests.
 *
 *  1. courbe spectrale moyenne par TIERS D'OCTAVE (50 Hz à 16 kHz, 26 bandes
 *     ISO) du mix et du morceau de référence ;
 *  2. écart = référence − mix, chaque courbe ramenée à sa moyenne (seule la
 *     FORME compte : le niveau est réglé à part, par le limiteur) ;
 *  3. écart lissé (≈ 1 octave) puis approché par une EQ de 6 bandes au plus,
 *     bornée à ±4 dB : plateau grave, 4 cloches larges, plateau aigu. Les
 *     formules des filtres sont celles des BiquadFilterNode de Web Audio, que
 *     le Pro-EQ 12 de NOVA utilise : la courbe prévue ici est celle que l'EQ
 *     natif du projet donne vraiment ;
 *  4. mesure de l'écart spectral moyen (dB) avant et après.
 *
 * Les mêmes filtres servent au « Master express » (utils/quickMaster.ts), qui
 * les applique en JavaScript pur (applyEq) sur le fichier.
 */

/** Centres ISO des tiers d'octave, de 50 Hz à 16 kHz (26 bandes). */
export const THIRD_OCTAVE_CENTERS = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];

/** Limite d'une correction automatique (dB). */
export const MATCH_MAX_DB = 4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** FFT réelle (radix 2, en place) ; renvoie |X|² des bins 0..N/2. */
function powerSpectrum(re: Float64Array): Float64Array {
  const n = re.length;
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

/**
 * Niveau moyen (dB) de chaque tiers d'octave : trames de 8192 points (Hann),
 * au plus `maxFrames` réparties sur tout le morceau, les trames quasi
 * silencieuses (intro, fin) écartées pour ne pas tirer la moyenne.
 */
export function thirdOctaveSpectrum(ch: Float32Array[], sampleRate: number, maxFrames = 240): number[] {
  const N = 8192, n = ch[0]?.length || 0;
  const acc = new Float64Array(N / 2 + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const hop = Math.max(N / 2, Math.floor((n - N) / Math.max(1, maxFrames)));
  // Énergie de chaque trame (écarte les silences).
  const starts: number[] = [], energies: number[] = [];
  for (let s = 0; s + N <= n; s += hop) {
    let e = 0;
    for (const c of ch) for (let i = s; i < s + N; i += 4) e += c[i] * c[i];
    starts.push(s); energies.push(e);
  }
  const maxE = Math.max(0, ...energies);
  let frames = 0;
  for (let f = 0; f < starts.length; f++) {
    if (energies[f] < maxE * 1e-3) continue; // 30 dB sous la trame la plus forte
    const s = starts[f];
    const fr = new Float64Array(N);
    for (let i = 0; i < N; i++) { let v = 0; for (const c of ch) v += c[s + i]; fr[i] = (v / ch.length) * win[i]; }
    const p = powerSpectrum(fr);
    for (let k = 0; k < p.length; k++) acc[k] += p[k];
    frames++;
  }
  const binHz = sampleRate / N;
  return THIRD_OCTAVE_CENTERS.map(fc => {
    const lo = fc * Math.pow(2, -1 / 6), hi = Math.min(fc * Math.pow(2, 1 / 6), sampleRate / 2 - binHz);
    let sum = 0, cnt = 0;
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k <= Math.floor(hi / binHz); k++) { sum += acc[k]; cnt++; }
    // Bande plus étroite qu'un bin (50 Hz) : bin le plus proche.
    if (!cnt) { const k = Math.max(1, Math.round(fc / binHz)); sum = acc[k] || 0; }
    return 10 * Math.log10(Math.max(1e-20, sum / Math.max(1, frames)));
  });
}

/** Courbe ramenée à sa moyenne (dB) : seule la forme compte. */
export function normalizeCurve(db: number[]): number[] {
  const m = db.reduce((a, v) => a + v, 0) / (db.length || 1);
  return db.map(v => v - m);
}

const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
};

/**
 * Écart « référence − mix » par tiers d'octave, aligné sur sa médiane : les
 * deux courbes sont mises au même niveau de la façon qui rend l'écart moyen
 * le plus petit (le niveau global ne compte pas, le limiteur s'en charge ; une
 * grosse différence de grave ne décale pas tout le reste).
 */
export function curveDiff(mixCurve: number[], refCurve: number[]): number[] {
  const n = Math.min(mixCurve.length, refCurve.length);
  const d = Array.from({ length: n }, (_, i) => refCurve[i] - mixCurve[i]);
  const m = median(d);
  return d.map(v => v - m);
}

/**
 * Écart spectral moyen (dB, valeur absolue, 50 Hz – 16 kHz) entre deux
 * courbes, formes seulement. `smooth` > 0 : écart d'ÉQUILIBRE TONAL (courbes
 * lissées sur ±smooth tiers d'octave), sans le détail des notes jouées.
 */
export function spectralDistance(a: number[], b: number[], smooth = 0): number {
  const d = smooth > 0 ? curveDiff(smoothCurve(a, smooth), smoothCurve(b, smooth)) : curveDiff(a, b);
  return d.reduce((s, v) => s + Math.abs(v), 0) / (d.length || 1);
}

/** Lissage triangulaire sur ±`half` bandes (2 = environ une octave et demie de large). */
export function smoothCurve(db: number[], half = 2): number[] {
  return db.map((_, i) => {
    let s = 0, w = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= db.length) continue;
      const wk = half + 1 - Math.abs(k);
      s += db[j] * wk; w += wk;
    }
    return s / w;
  });
}

// ---------------------------------------------------------------------------
// Filtres (formules de la spécification Web Audio, BiquadFilterNode)
// ---------------------------------------------------------------------------

export type EqType = 'highpass' | 'lowshelf' | 'peaking' | 'highshelf';
export interface EqBand { type: EqType; freq: number; q: number; gainDb: number }
export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

export function biquadCoeffs(band: EqBand, sampleRate: number): Biquad {
  const f = clamp(band.freq, 1, sampleRate / 2 - 1);
  const w0 = 2 * Math.PI * f / sampleRate, cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, band.gainDb / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (band.type === 'peaking') {
    const al = sw / (2 * Math.max(1e-4, band.q));
    b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  } else if (band.type === 'lowshelf' || band.type === 'highshelf') {
    // Web Audio : plateaux sans Q (pente S = 1).
    const al = sw / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    if (band.type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
      a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
      a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
    }
  } else {
    // Passe-haut Web Audio : Q en dB.
    const al = sw / (2 * Math.pow(10, band.q / 20));
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Réponse en amplitude (dB) d'un filtre à la fréquence f. */
export function biquadMagDb(c: Biquad, f: number, sampleRate: number): number {
  const w = 2 * Math.PI * f / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  return 10 * Math.log10(Math.max(1e-30, (nr * nr + ni * ni) / (dr * dr + di * di)));
}

/** Réponse (dB) d'une chaîne de bandes à chaque fréquence demandée. */
export function eqResponseDb(bands: EqBand[], freqs: number[], sampleRate: number): number[] {
  const cs = bands.map(b => biquadCoeffs(b, sampleRate));
  return freqs.map(f => cs.reduce((a, c) => a + biquadMagDb(c, f, sampleRate), 0));
}

/**
 * Applique une chaîne de bandes à des canaux (copie), en double précision,
 * forme transposée directe II : mêmes filtres que le Pro-EQ 12.
 */
export function applyEq(ch: Float32Array[], sampleRate: number, bands: EqBand[]): Float32Array[] {
  const active = bands.filter(b => b.type === 'highpass' || Math.abs(b.gainDb) > 1e-3).map(b => biquadCoeffs(b, sampleRate));
  return ch.map(x => {
    const y = new Float32Array(x.length);
    if (!active.length) { y.set(x); return y; }
    const n = x.length;
    const buf = new Float64Array(n);
    for (let i = 0; i < n; i++) buf[i] = x[i];
    for (const c of active) {
      let z1 = 0, z2 = 0;
      const { b0, b1, b2, a1, a2 } = c;
      for (let i = 0; i < n; i++) {
        const xi = buf[i];
        const yi = b0 * xi + z1;
        z1 = b1 * xi - a1 * yi + z2;
        z2 = b2 * xi - a2 * yi;
        buf[i] = yi;
      }
    }
    for (let i = 0; i < n; i++) y[i] = buf[i];
    return y;
  });
}

// ---------------------------------------------------------------------------
// Correction d'EQ : 6 bandes larges, ±4 dB, ajustées aux moindres carrés
// ---------------------------------------------------------------------------

/** Les 6 bandes de correction (fréquences fixes, larges : une correction douce, pas chirurgicale). */
export const MATCH_BANDS: Omit<EqBand, 'gainDb'>[] = [
  { type: 'lowshelf', freq: 90, q: 0.7 },
  { type: 'peaking', freq: 220, q: 0.9 },
  { type: 'peaking', freq: 560, q: 0.9 },
  { type: 'peaking', freq: 1400, q: 0.9 },
  { type: 'peaking', freq: 3500, q: 0.9 },
  { type: 'highshelf', freq: 8000, q: 0.7 },
];

/** Poids des bandes de mesure : les extrêmes (50-63 Hz, 16 kHz) comptent moins (peu fiables, peu d'énergie). */
const weightOf = (fc: number) => (fc < 70 ? 0.5 : fc > 13000 ? 0.5 : 1);

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

/**
 * Gains des 6 bandes qui approchent `target` (dB par tiers d'octave) au sens
 * des moindres carrés pondérés, avec une légère pénalité (douceur), bornés à
 * ±maxDb. Quelques passes de Gauss-Newton : la réponse en dB d'un filtre
 * n'est pas exactement proportionnelle à son gain.
 */
export function fitEqToCurve(target: number[], sampleRate: number, maxDb = MATCH_MAX_DB, bandsDef = MATCH_BANDS): EqBand[] {
  const freqs = THIRD_OCTAVE_CENTERS.filter(f => f < sampleRate / 2);
  const t = target.slice(0, freqs.length);
  const w = freqs.map(weightOf);
  const nb = bandsDef.length;
  // Inconnues : les gains des bandes, plus un décalage global libre (le niveau
  // est réglé ensuite par le limiteur : seule la FORME de la correction compte).
  let g = new Array(nb).fill(0);
  let off = 0;
  const lambda = 0.08;
  for (let it = 0; it < 5; it++) {
    const cur = eqResponseDb(bandsDef.map((b, i) => ({ ...b, gainDb: g[i] })), freqs, sampleRate);
    // Jacobien numérique (réponse de chaque bande pour +1 dB autour du point courant).
    const J = bandsDef.map((b, i) => {
      const plus = eqResponseDb([{ ...b, gainDb: g[i] + 0.5 }], freqs, sampleRate);
      const minus = eqResponseDb([{ ...b, gainDb: g[i] - 0.5 }], freqs, sampleRate);
      return plus.map((v, k) => v - minus[k]);
    });
    J.push(freqs.map(() => 1));
    const r = t.map((v, k) => v - cur[k] - off);
    const m = nb + 1;
    const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => {
      let s = 0;
      for (let k = 0; k < freqs.length; k++) s += w[k] * J[i][k] * J[j][k];
      return s + (i === j && i < nb ? lambda : 0);
    }));
    const b = Array.from({ length: m }, (_, i) => {
      let s = 0;
      for (let k = 0; k < freqs.length; k++) s += w[k] * J[i][k] * r[k];
      return s - (i < nb ? lambda * g[i] * 0.5 : 0);
    });
    const d = solve(A, b);
    g = g.map((v, i) => v + d[i]);
    off += d[nb];
    // Correction centrée (un même gain sur toutes les bandes n'est qu'un changement de niveau),
    // puis bornée : jamais plus de ±maxDb sur une bande.
    const mid = (Math.max(...g) + Math.min(...g)) / 2;
    g = g.map(v => clamp(v - mid, -maxDb, maxDb));
    off += mid;
  }
  return bandsDef.map((b, i) => ({ ...b, gainDb: Math.round(g[i] * 10) / 10 }));
}

/** Écart moyen pondéré (dB) entre la courbe voulue et la réponse de l'EQ, au meilleur niveau près. */
function fitError(target: number[], bands: EqBand[], sampleRate: number): number {
  const freqs = THIRD_OCTAVE_CENTERS.filter(f => f < sampleRate / 2);
  const resp = eqResponseDb(bands, freqs, sampleRate);
  const d = freqs.map((_, k) => target[k] - resp[k]);
  const m = median(d);
  let s = 0, w = 0;
  freqs.forEach((f, k) => { const wk = weightOf(f); s += wk * Math.abs(d[k] - m); w += wk; });
  return s / w;
}

/**
 * Comme fitEqToCurve, mais les fréquences (±1/2 octave autour de la position
 * de départ) et la largeur des cloches (Q de 0,7 à 1,4) s'adaptent à l'écart :
 * toujours 6 bandes, toujours larges, toujours ±maxDb au plus.
 */
export function fitEqAdaptive(target: number[], sampleRate: number, maxDb = MATCH_MAX_DB): EqBand[] {
  let defs = MATCH_BANDS.map(b => ({ ...b }));
  let best = fitEqToCurve(target, sampleRate, maxDb, defs);
  let err = fitError(target, best, sampleRate);
  const fMul = [0.71, 0.84, 1.19, 1.41];
  const qs = [0.7, 1, 1.4];
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < defs.length; i++) {
      const base = MATCH_BANDS[i];
      const tries: Omit<EqBand, 'gainDb'>[] = [];
      for (const k of fMul) tries.push({ ...defs[i], freq: Math.round(base.freq * k) });
      if (defs[i].type === 'peaking') for (const q of qs) tries.push({ ...defs[i], q });
      for (const tr of tries) {
        const cand = defs.map((d, j) => (j === i ? tr : d));
        const bands = fitEqToCurve(target, sampleRate, maxDb, cand);
        const e = fitError(target, bands, sampleRate);
        if (e < err - 1e-3) { err = e; best = bands; defs = cand; }
      }
    }
  }
  return best;
}

export interface ReferenceMatch {
  /** Bandes de correction (6), gains bornés à ±4 dB. */
  bands: EqBand[];
  /** Écart spectral moyen avant (dB) et écart prévu après la correction (dB). */
  before: number;
  predicted: number;
  /** Écart voulu (référence − mix, lissé, en dB par tiers d'octave). */
  wanted: number[];
}

/**
 * Correction d'EQ qui rapproche la forme du mix de celle de la référence.
 * `amount` (0..1) dose la correction (1 = tout l'écart lissé, borné à ±4 dB).
 */
export function matchToReference(mixCurve: number[], refCurve: number[], sampleRate: number, amount = 1, maxDb = MATCH_MAX_DB): ReferenceMatch {
  const a = clamp(amount, 0, 1);
  const wanted = smoothCurve(curveDiff(mixCurve, refCurve), 1).map(v => v * a);
  const bands = fitEqAdaptive(wanted, sampleRate, maxDb);
  const freqs = THIRD_OCTAVE_CENTERS.filter(f => f < sampleRate / 2);
  const resp = eqResponseDb(bands, freqs, sampleRate);
  const after = mixCurve.slice(0, freqs.length).map((v, i) => v + resp[i]);
  return { bands, before: spectralDistance(mixCurve.slice(0, freqs.length), refCurve.slice(0, freqs.length)), predicted: spectralDistance(after, refCurve.slice(0, freqs.length)), wanted };
}

/**
 * Courbe cible (dB par tiers d'octave) à partir de points d'ancrage
 * (fréquence → dB), interpolés en fréquence logarithmique.
 */
export function curveFromAnchors(anchors: [number, number][]): number[] {
  const pts = [...anchors].sort((x, y) => x[0] - y[0]);
  return THIRD_OCTAVE_CENTERS.map(f => {
    if (f <= pts[0][0]) return pts[0][1];
    if (f >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) {
      if (f <= pts[i][0]) {
        const [f0, d0] = pts[i - 1], [f1, d1] = pts[i];
        const t = Math.log(f / f0) / Math.log(f1 / f0);
        return d0 + (d1 - d0) * t;
      }
    }
    return 0;
  });
}

/**
 * Réglages du Pro-EQ 12 de NOVA pour ces bandes (master d'un projet) :
 * passe-haut à 22 Hz comme Master Nova, puis les 6 bandes, le reste coupé.
 */
export function proEq12ParamsFor(bands: EqBand[]): Record<string, any> {
  const out: any[] = [{ id: 0, type: 'highpass', frequency: 22, gain: 0, q: 0.7, isEnabled: true, isSolo: false }];
  bands.slice(0, 6).forEach((b, i) => out.push({ id: i + 1, type: b.type, frequency: b.freq, gain: b.gainDb, q: b.q, isEnabled: true, isSolo: false }));
  while (out.length < 12) {
    const i = out.length;
    out.push({ id: i, type: i === 11 ? 'lowpass' : 'peaking', frequency: [6000, 8000, 10000, 12000, 18000][i - 7] || 18000, gain: 0, q: 1, isEnabled: false, isSolo: false });
  }
  return { isEnabled: true, masterGain: 1, bands: out };
}

/** Phrase lisible d'une bande (« +2,1 dB vers 220 Hz »). */
export const matchBandLabel = (b: EqBand) => {
  const g = `${b.gainDb > 0 ? '+' : b.gainDb < 0 ? '−' : ''}${Math.abs(b.gainDb).toFixed(1).replace('.', ',')} dB`;
  const f = b.freq >= 1000 ? `${(b.freq / 1000).toString().replace('.', ',')} kHz` : `${b.freq} Hz`;
  const where = b.type === 'lowshelf' ? `sous ${f}` : b.type === 'highshelf' ? `au-dessus de ${f}` : `vers ${f}`;
  return `${g} ${where}`;
};
