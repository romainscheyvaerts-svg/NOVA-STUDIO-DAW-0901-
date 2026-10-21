/**
 * Écart 7 (réparation de la voix) : briques de signal communes, sans DOM.
 *  - biquads et filtrage aller-retour (phase nulle : rien ne bouge dans le temps) ;
 *  - modèle autorégressif (AR) d'un passage, par moindres carrés sur les seuls
 *    échantillons sains (méthode de covariance « masquée ») ou par Levinson ;
 *  - interpolation LSAR (Janssen, Veldhuis et Vries 1986 ; Godsill et Rayner,
 *    « Digital Audio Restoration », 1998, chap. 5) : les échantillons abîmés
 *    sont remplacés par ceux qui rendent l'erreur de prédiction AR la plus
 *    petite possible, en tenant compte des deux côtés du trou.
 *
 * Utilisé par les clics de bouche (utils/repair/mouthClicks) et l'écrêtage
 * (utils/repair/declip).
 */

// ─── Biquads ────────────────────────────────────────────────────────────────────

export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** Passe-bas RBJ (Audio EQ Cookbook, R. Bristow-Johnson). */
export function lowpass(f: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * f) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
}

/** Coupe-bande RBJ (notch) de largeur `bw` Hz à −3 dB. */
export function notch(f: number, bw: number, sr: number): Biquad {
  const w = (2 * Math.PI * f) / sr, cw = Math.cos(w), q = Math.max(0.5, f / Math.max(0.05, bw)), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: 1 / a0, b1: (-2 * cw) / a0, b2: 1 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
}

/** Butterworth d'ordre 4 = deux biquads (Q de Butterworth). */
export const BUTTER4_Q = [0.5411961001461969, 1.3065629648763766];

/** Filtre en place, dans le sens du temps (forme directe transposée II). */
export function runBiquad(x: Float64Array, f: Biquad, backward = false): void {
  let z1 = 0, z2 = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const i = backward ? n - 1 - k : k;
    const v = x[i];
    const y = f.b0 * v + z1;
    z1 = f.b1 * v - f.a1 * y + z2;
    z2 = f.b2 * v - f.a2 * y;
    x[i] = y;
  }
}

/**
 * Filtrage aller-retour (phase nulle) d'une cascade de biquads. `pad` échantillons
 * sont ajoutés de chaque côté : par réflexion impaire (comme filtfilt de SciPy),
 * ou, si `period` est donné, par répétition périodique (le bourdonnement continue
 * sans rupture : pas de résidu au début ni à la fin du clip).
 */
export function filtfilt(x: Float32Array | Float64Array, filters: Biquad[], pad: number, period?: number): Float64Array {
  const n = x.length;
  let p = Math.max(0, Math.min(Math.floor(pad), n - 1));
  // Prolongement périodique : un seul décalage entier S ≈ m·T (le plus proche d'un
  // entier parmi quelques multiples), pour que x[i] ≈ x[i ± S] sans saut de phase.
  let shift = 0;
  if (period && period >= 1 && n > period + 1 && p > 0) {
    const mMin = Math.max(1, Math.ceil(p / period));
    let best = Infinity;
    for (let m = mMin; m < mMin + 60 && m * period < n; m++) {
      const err = Math.abs(m * period - Math.round(m * period));
      if (err < best - 1e-9) { best = err; shift = Math.round(m * period); }
    }
    if (!shift) { shift = Math.floor(Math.floor((n - 1) / period) * period); p = Math.min(p, shift); }
  }
  const y = new Float64Array(n + 2 * p);
  for (let i = 0; i < n; i++) y[p + i] = x[i];
  for (let i = 0; i < p; i++) {
    if (shift) {
      y[i] = x[i - p + shift];
      y[n + p + i] = x[n + i - shift];
    } else {
      y[p - 1 - i] = 2 * x[0] - x[Math.min(n - 1, i + 1)];
      y[n + p + i] = 2 * x[n - 1] - x[Math.max(0, n - 2 - i)];
    }
  }
  for (const f of filters) runBiquad(y, f);
  for (const f of filters) runBiquad(y, f, true);
  return y.subarray(p, p + n);
}

// ─── Petits outils ──────────────────────────────────────────────────────────────

export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (v: number) => 20 * Math.log10(Math.max(1e-12, v));

/** Résout A·x = b (A symétrique définie positive, n×n dense, ligne par ligne). Renvoie null si singulière. */
export function solveSpd(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

// ─── Modèle AR ──────────────────────────────────────────────────────────────────

/**
 * Coefficients c (c[0] = 1) tels que e_t = Σ c_k x_{t−k} soit l'erreur de
 * prédiction : méthode d'autocorrélation (fenêtre de Hann + Levinson-Durbin),
 * toujours stable. Pour la détection des clics.
 */
export function arLevinson(x: Float32Array | Float64Array, from: number, to: number, p: number): Float64Array {
  const n = Math.max(0, to - from);
  const c = new Float64Array(p + 1); c[0] = 1;
  if (n <= p * 2) return c;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  const r = new Float64Array(p + 1);
  for (let k = 0; k <= p; k++) { let s = 0; for (let i = k; i < n; i++) s += w[i] * w[i - k]; r[k] = s; }
  if (r[0] <= 1e-20) return c;
  r[0] *= 1 + 1e-9; // très léger plancher de bruit : modèle bien conditionné
  let err = r[0];
  const tmp = new Float64Array(p + 1);
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += c[j] * r[i - j];
    const k = -acc / err;
    tmp.set(c);
    for (let j = 1; j < i; j++) c[j] = tmp[j] + k * tmp[i - j];
    c[i] = k;
    err *= 1 - k * k;
    if (err <= 0) break;
  }
  return c;
}

/**
 * Coefficients AR par moindres carrés sur les seules lignes dont les p+1
 * échantillons sont sains (`bad[i]` vrai = abîmé). Renvoie null s'il n'y a pas
 * assez de lignes saines. Pour l'écrêtage : le modèle n'apprend que le vrai son.
 */
export function arMasked(x: Float32Array | Float64Array, from: number, to: number, p: number, bad: Uint8Array | null): Float64Array | null {
  const R = new Float64Array(p * p), r = new Float64Array(p);
  let rows = 0, run = 0;
  for (let t = Math.max(0, from); t < to; t++) {
    if (bad && bad[t]) { run = 0; continue; }
    run++;
    if (run <= p) continue;
    rows++;
    const xt = x[t];
    for (let i = 0; i < p; i++) {
      const xi = x[t - 1 - i];
      r[i] += xt * xi;
      for (let j = 0; j <= i; j++) R[i * p + j] += xi * x[t - 1 - j];
    }
  }
  if (rows < p + 4) return null;
  let tr = 0;
  for (let i = 0; i < p; i++) { for (let j = 0; j < i; j++) R[j * p + i] = R[i * p + j]; tr += R[i * p + i]; }
  if (tr <= 1e-20) return null;
  const ridge = (tr / p) * 1e-7;
  for (let i = 0; i < p; i++) { R[i * p + i] += ridge; r[i] = -r[i]; }
  const a = solveSpd(R, r, p);
  if (!a) return null;
  const c = new Float64Array(p + 1); c[0] = 1;
  for (let i = 0; i < p; i++) c[i + 1] = a[i];
  return c;
}

/**
 * Interpolation LSAR du trou [g0, g1) de `x` (modifié en place) avec le modèle
 * `c`. Les autres échantillons servent tels quels. Système bande (largeur p)
 * résolu par Cholesky bande : O(L·p²).
 */
export function lsarFill(x: Float32Array | Float64Array, g0: number, g1: number, c: Float64Array): boolean {
  const p = c.length - 1;
  const n = x.length;
  const L = g1 - g0;
  if (L <= 0) return false;
  const bw = p; // demi-largeur de bande
  const B = new Float64Array(L * (bw + 1)); // B[i][i-d] rangé en i*(bw+1)+d
  const rhs = new Float64Array(L);
  const t0 = Math.max(g0, p), t1 = Math.min(g1 + p, n);
  for (let t = t0; t < t1; t++) {
    // Partie connue de l'erreur de prédiction de la ligne t.
    let known = 0;
    for (let k = 0; k <= p; k++) {
      const idx = t - k;
      if (idx < g0 || idx >= g1) known += c[k] * x[idx];
    }
    const jLo = Math.max(0, t - g0 - p), jHi = Math.min(L - 1, t - g0);
    for (let j = jLo; j <= jHi; j++) {
      const cj = c[t - g0 - j];
      rhs[j] -= cj * known;
      for (let i = j; i <= jHi; i++) B[i * (bw + 1) + (i - j)] += c[t - g0 - i] * cj;
    }
  }
  // Cholesky bande en place.
  for (let i = 0; i < L; i++) {
    for (let d = Math.min(bw, i); d >= 0; d--) {
      const j = i - d;
      let s = B[i * (bw + 1) + d];
      const kLo = Math.max(0, i - bw, j - bw);
      for (let k = kLo; k < j; k++) s -= B[i * (bw + 1) + (i - k)] * B[j * (bw + 1) + (j - k)];
      if (d === 0) {
        if (!(s > 1e-30)) return false;
        B[i * (bw + 1)] = Math.sqrt(s);
      } else B[i * (bw + 1) + d] = s / B[j * (bw + 1)];
    }
  }
  const y = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    let s = rhs[i];
    for (let k = Math.max(0, i - bw); k < i; k++) s -= B[i * (bw + 1) + (i - k)] * y[k];
    y[i] = s / B[i * (bw + 1)];
  }
  for (let i = L - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k <= Math.min(L - 1, i + bw); k++) s -= B[k * (bw + 1) + (k - i)] * y[k];
    y[i] = s / B[i * (bw + 1)];
  }
  for (let i = 0; i < L; i++) { const v = y[i]; if (!Number.isFinite(v)) return false; }
  for (let i = 0; i < L; i++) x[g0 + i] = y[i];
  return true;
}

/** Erreur de prédiction e_t = Σ c_k x_{t−k} (t ≥ p ; avant : x_t). */
export function residualAt(x: Float32Array | Float64Array, t: number, c: Float64Array): number {
  const p = c.length - 1;
  if (t < p) return x[t];
  let s = 0;
  for (let k = 0; k <= p; k++) s += c[k] * x[t - k];
  return s;
}

/**
 * Interpolation LSAR avec un filtre de prédiction quelconque, creux (prises
 * `taps` : retard k ≥ 0 et coefficient, avec le retard 0 à 1). Sert au modèle
 * « voix » complet : enveloppe (AR court) × répétition à la période du
 * fondamental (prédiction à long terme) : le trou est rebouché avec la forme
 * de la période d'avant ET de celle d'après (Vaseghi et Rayner 1990, « Detection
 * and suppression of impulsive noise in speech communication systems »).
 * Système plein L×L (L ≤ quelques centaines), résolu par Cholesky.
 */
export function lsarFillTaps(x: Float32Array | Float64Array, g0: number, g1: number, taps: { k: number; c: number }[]): boolean {
  const L = g1 - g0;
  const n = x.length;
  if (L <= 0 || L > 600) return false;
  const maxK = taps.reduce((m, t) => Math.max(m, t.k), 0);
  const B = new Float64Array(L * L), rhs = new Float64Array(L);
  const js: number[] = [], cs: number[] = [];
  for (let t = Math.max(g0, maxK); t < Math.min(g1 + maxK, n); t++) {
    let known = 0;
    js.length = 0; cs.length = 0;
    for (const tp of taps) {
      const idx = t - tp.k;
      if (idx >= g0 && idx < g1) { js.push(idx - g0); cs.push(tp.c); } else known += tp.c * x[idx];
    }
    if (!js.length) continue;
    for (let a = 0; a < js.length; a++) {
      rhs[js[a]] -= cs[a] * known;
      for (let b = 0; b < js.length; b++) B[js[a] * L + js[b]] += cs[a] * cs[b];
    }
  }
  let tr = 0; for (let i = 0; i < L; i++) tr += B[i * L + i];
  if (!(tr > 0)) return false;
  for (let i = 0; i < L; i++) B[i * L + i] += (tr / L) * 1e-9;
  const y = solveSpd(B, rhs, L);
  if (!y) return false;
  for (let i = 0; i < L; i++) if (!Number.isFinite(y[i])) return false;
  for (let i = 0; i < L; i++) x[g0 + i] = y[i];
  return true;
}

/** Filtre composé : AR court `c` × (1 − β(z)·z^−T) de la prédiction à long terme (prises creuses). */
export function composeLtp(c: Float64Array, lag: number, beta: [number, number, number]): { k: number; c: number }[] {
  const m = new Map<number, number>();
  const add = (k: number, v: number) => m.set(k, (m.get(k) || 0) + v);
  for (let k = 0; k < c.length; k++) {
    add(k, c[k]);
    for (let i = 0; i < 3; i++) add(k + lag - 1 + i, -beta[i] * c[k]);
  }
  return [...m.entries()].filter(([, v]) => v !== 0).map(([k, v]) => ({ k, c: v }));
}

/** k-ième plus petite valeur (sélection rapide de Hoare, en place sur `a`) : la médiane sans tri complet. */
export function kth(a: Float64Array, k: number): number {
  let lo = 0, hi = a.length - 1;
  k = Math.max(0, Math.min(hi, k));
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}
