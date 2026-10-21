/**
 * Écart 7 · Clics de bouche (salive, langue, lèvres) : de petits claquements de
 * moins de 4 ms, que la voix « n'explique pas ». Méthode classique de
 * restauration (Vaseghi et Rayner 1990 ; Godsill et Rayner 1998, chap. 5) :
 *  1. un modèle AR (Levinson, ordre 32) prédit la voix bloc par bloc ;
 *  2. les impulsions de la glotte, qui reviennent à chaque période, sont prédites
 *     à leur tour par la période précédente ET la suivante (prédiction à long terme) ;
 *  3. un clic = ce qui reste dépasse k fois son niveau habituel (écart absolu
 *     médian du bloc et de ses voisins) ;
 *  4. le passage est reconstruit par interpolation LSAR à partir des deux côtés.
 * Hors des clics, le son est rendu tel quel, à l'échantillon près.
 */
import type { RepairStrength } from './pipeline';
import { fftInPlace } from '../../engine/phaseVocoder';
import { arLevinson, composeLtp, kth, lsarFill, lsarFillTaps, residualAt, solveSpd } from './dsp';

export interface ClickStats { count: number; samples: number }

const ORDER = 32;
const BLOCK = 2048;
/** Seuils (multiples de l'écart habituel) : Léger ne prend que les clics francs. */
export const CLICK_K: Record<RepairStrength, number> = { light: 14, medium: 9, strong: 6 };
/** Un clic de bouche dure moins de 4 ms : au-delà c'est une consonne, on n'y touche pas. */
const MAX_CLICK_S = 0.004;
/** Plancher d'écart (≈ −94 dBFS) : le silence numérique ne déclenche rien. */
const SIGMA_FLOOR = 2e-5;
/**
 * Plancher relatif : l'écart habituel compte au moins pour la crête du clip − 60 dB. Dans les
 * silences d'une vraie prise (−70 dBFS), le bruit de la pièce est « pointu » et n'est pas un
 * clic qu'on entend : seuls les claquements à plus de ~−40 dB de la crête sont pris (Moyen).
 */
const RELATIVE_FLOOR_DB = -60;
/** Le pic d'un clic dépasse au moins (k × ce rapport) fois l'écart habituel des 10 ms autour. */
const CONSONANT_RATIO = 0.8;

function median(a: Float64Array): number {
  return a.length ? kth(a, a.length >> 1) : 0; // « a » : copie de travail (réordonnée)
}

/**
 * Prédiction « à long terme » (celle des codeurs de parole CELP) : une voix chantée
 * ou rappée se répète à chaque période du fondamental ; les impulsions de la glotte
 * laissent donc dans l'erreur à court terme un pic par période, que l'on prédit
 * par la période d'avant ET par celle d'après (3 coefficients : période
 * fractionnaire). Un clic, lui, ne se répète pas.
 * `e` : erreur à court terme sur [0, e.length) ; le bloc est [from, to).
 * Renvoie la période (échantillons) et les 3 coefficients, ou null (pas de période nette).
 */
function pitchPredictor(e: Float64Array, from: number, to: number, minLag: number, maxLag: number): { lag: number; beta: [number, number, number] } | null {
  const len = to - from, M = e.length;
  if (len < 256) return null;
  let e0 = 0; for (let t = from; t < to; t++) e0 += e[t] * e[t];
  if (e0 <= 1e-20) return null;
  // Recherche grossière de la période sur le signal décimé par D (somme de D échantillons) :
  // z(T) = Σ_{t∈bloc} e_t·e_{t+T} pour T dans [−maxLag, maxLag] (passé et futur), par FFT.
  const D = 4;
  const Md = Math.floor(M / D), fd = Math.floor(from / D), td = Math.floor(to / D);
  const minD = Math.max(1, Math.floor(minLag / D)), maxD = Math.ceil(maxLag / D);
  let N = 1; while (N < Md + maxD + 2) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < Md; i++) { let v = 0; for (let j = 0; j < D; j++) v += e[i * D + j]; ar[i] = v; }
  for (let i = fd; i < td; i++) br[i] = ar[i];
  fftInPlace(ar, ai); fftInPlace(br, bi);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] + ai[k] * bi[k], im = ai[k] * br[k] - ar[k] * bi[k]; ar[k] = r; ai[k] = im; }
  fftInPlace(ar, ai, true);
  const zd = (T: number) => ar[((T % N) + N) % N] / N;
  let bestV = 0;
  const vals = new Float64Array(maxD + 2);
  for (let T = minD; T <= maxD; T++) { vals[T] = zd(T) + zd(-T); if (vals[T] > bestV) bestV = vals[T]; }
  // Plus petite période presque aussi forte que la meilleure (pas l'octave en dessous).
  let coarse = -1;
  for (let T = minD; T <= maxD; T++) if (vals[T] >= 0.85 * bestV && vals[T] >= vals[T - 1] && vals[T] >= vals[T + 1]) { coarse = T; break; }
  if (coarse < 0 || bestV <= 0) return null;
  // Affinage à l'échantillon près, corrélation directe (passé + futur) autour de D·période.
  const c = (T: number) => {
    let acc = 0;
    for (let t = from; t < to; t++) { const p = t - T, q = t + T; acc += e[t] * ((p >= 0 ? e[p] : 0) + (q < M ? e[q] : 0)); }
    return acc;
  };
  let best = -1, bv = -Infinity;
  for (let T = Math.max(minLag, coarse * D - D); T <= Math.min(maxLag, coarse * D + D); T++) { const v = c(T); if (v > bv) { bv = v; best = T; } }
  if (best < 0 || best + 1 > maxLag) return null;
  // Coefficients par moindres carrés pondérés robustes (Huber, 4 passes) sur les
  // lignes « avant » et « arrière » : un clic dans le bloc ne fausse pas la
  // prédiction des impulsions (ses lignes perdent leur poids).
  const T = best;
  // Lignes « avant » (e_t ≈ Σ β e_{t−T+1−i}) et « arrière » (e_t ≈ Σ β e_{t+T−1+i}), mises à plat.
  let R = 0;
  const cap = 2 * len;
  const Y = new Float64Array(cap), X0 = new Float64Array(cap), X1 = new Float64Array(cap), X2 = new Float64Array(cap);
  for (let t = from; t < to; t++) {
    if (t - T - 1 >= 0) { Y[R] = e[t]; X0[R] = e[t - T + 1]; X1[R] = e[t - T]; X2[R] = e[t - T - 1]; R++; }
    if (t + T + 1 < M) { Y[R] = e[t]; X0[R] = e[t + T - 1]; X1[R] = e[t + T]; X2[R] = e[t + T + 1]; R++; }
  }
  if (R < 64) return null;
  let beta: [number, number, number] = [0, 0, 0];
  const w = new Float64Array(R).fill(1);
  const resid = new Float64Array(R);
  const work = new Float64Array(R);
  for (let pass = 0; pass < 4; pass++) {
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, r0 = 0, r1 = 0, r2 = 0;
    for (let k = 0; k < R; k++) {
      const wk = w[k], y = Y[k], x0 = X0[k], x1 = X1[k], x2 = X2[k];
      r0 += wk * y * x0; r1 += wk * y * x1; r2 += wk * y * x2;
      a00 += wk * x0 * x0; a01 += wk * x0 * x1; a02 += wk * x0 * x2;
      a11 += wk * x1 * x1; a12 += wk * x1 * x2; a22 += wk * x2 * x2;
    }
    const tr = a00 + a11 + a22;
    if (tr <= 1e-24) return null;
    const rg = tr * 1e-6;
    const sol = solveSpd(new Float64Array([a00 + rg, a01, a02, a01, a11 + rg, a12, a02, a12, a22 + rg]), new Float64Array([r0, r1, r2]), 3);
    if (!sol) return null;
    beta = [sol[0], sol[1], sol[2]];
    for (let k = 0; k < R; k++) resid[k] = Math.abs(Y[k] - (beta[0] * X0[k] + beta[1] * X1[k] + beta[2] * X2[k]));
    work.set(resid);
    const scale = 1.4826 * kth(work, R >> 1) * 4 + 1e-12;
    for (let k = 0; k < R; k++) w[k] = resid[k] <= scale ? 1 : scale / resid[k];
  }
  // Utile seulement si la prédiction retire vraiment quelque chose (énergie robuste : sans les 1 % les plus forts).
  const trimmed = (vals: Float64Array) => { work.set(vals); const lim = kth(work, Math.floor(R * 0.99)); let acc = 0; for (let k = 0; k < R; k++) if (vals[k] <= lim) acc += vals[k] * vals[k]; return acc; };
  const before = new Float64Array(R);
  for (let k = 0; k < R; k++) before[k] = Math.abs(Y[k]);
  if (!(trimmed(resid) < 0.9 * trimmed(before))) return null;
  return { lag: T, beta };
}

/** Repère les clics d'un canal : [début, fin) en échantillons. */
export function detectClicks(x: Float32Array, sampleRate: number, strength: RepairStrength): { events: { from: number; to: number }[]; models: Float64Array[]; pitch: (ReturnType<typeof pitchPredictor>)[] } {
  const n = x.length;
  const nb = Math.ceil(n / BLOCK);
  const models: Float64Array[] = [];
  const pitch: (ReturnType<typeof pitchPredictor>)[] = [];
  const sig = new Float64Array(nb);
  const det = new Float32Array(n);
  const minLag = Math.round(sampleRate / 500), maxLag = Math.round(sampleRate / 60);
  for (let b = 0; b < nb; b++) {
    const from = b * BLOCK, to = Math.min(n, from + BLOCK);
    // 1. Erreur de prédiction à court terme (enveloppe de la voix retirée), avec le
    //    modèle du bloc, calculée aussi une période avant et après le bloc (même
    //    modèle partout : les impulsions gardent la même forme d'une période à l'autre).
    const c = arLevinson(x, Math.max(0, from - BLOCK / 2), Math.min(n, to + BLOCK / 2), ORDER);
    models.push(c);
    const e0 = Math.max(0, from - maxLag - 2), e1 = Math.min(n, to + maxLag + 2);
    const e = new Float64Array(e1 - e0);
    for (let t = Math.max(e0, ORDER); t < e1; t++) e[t - e0] = residualAt(x, t, c); // avant ORDER : pas de prédiction possible (0)
    // 2. Prédiction à long terme, vers l'avant ET vers l'arrière : un clic doit
    //    surprendre dans les deux sens (son « écho » une période plus loin ne compte pas).
    const lp = pitchPredictor(e, from - e0, to - e0, minLag, maxLag);
    pitch.push(lp);
    const abs = new Float64Array(to - from);
    for (let t = from; t < to; t++) {
      const i = t - e0;
      let d = Math.abs(e[i]);
      if (lp) {
        const { lag: T, beta: [b0, b1, b2] } = lp;
        const hasF = i - T - 1 >= 0, hasB = i + T + 1 < e.length;
        const fwd = hasF ? Math.abs(e[i] - (b0 * e[i - T + 1] + b1 * e[i - T] + b2 * e[i - T - 1])) : Infinity;
        const bwd = hasB ? Math.abs(e[i] - (b0 * e[i + T - 1] + b1 * e[i + T] + b2 * e[i + T + 1])) : Infinity;
        if (hasF || hasB) d = Math.min(fwd, bwd);
      }
      det[t] = d;
      abs[t - from] = d;
    }
    sig[b] = 1.4826 * median(abs);
  }
  const k = CLICK_K[strength] ?? CLICK_K.medium;
  const maxLen = Math.max(8, Math.round(MAX_CLICK_S * sampleRate));
  const gap = Math.max(4, Math.round(0.0005 * sampleRate));
  // Un claquement de bouche dure au moins ~0,2 ms (10 échantillons à 48 kHz).
  const minRaw = Math.max(3, Math.round(0.0002 * sampleRate));
  const before = 6, after = Math.max(12, Math.round(0.0004 * sampleRate));
  const side = Math.round(0.01 * sampleRate);
  const events: { from: number; to: number }[] = [];
  let cur: { from: number; to: number } | null = null;
  // Écart local : médiane du bloc et de ses deux voisins (une attaque de voix ne fait pas un clic).
  let peak = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; }
  const floor = Math.max(SIGMA_FLOOR, peak * Math.pow(10, RELATIVE_FLOOR_DB / 20));
  const thrB = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    const a = sig[Math.max(0, b - 1)], m = sig[b], c = sig[Math.min(nb - 1, b + 1)];
    const med = Math.max(Math.min(a, m), Math.min(Math.max(a, m), c));
    thrB[b] = k * Math.max(floor, med);
  }
  for (let t = ORDER; t < n; t++) {
    if (det[t] <= thrB[(t / BLOCK) | 0]) continue;
    if (cur && t - cur.to <= gap) cur.to = t + 1;
    else { if (cur) events.push(cur); cur = { from: t, to: t + 1 }; }
  }
  if (cur) events.push(cur);
  const out: { from: number; to: number }[] = [];
  for (const e of events) {
    const from = Math.max(0, e.from - before), to = Math.min(n, e.to + after);
    if (to - from > maxLen + before + after) continue; // trop long : pas un clic
    if (e.to - e.from < minRaw) continue; // une pointe d'un échantillon ou deux : reste d'impulsion de la glotte, pas un claquement
    // Consonne (« t », « k », « ch ») : l'attaque est suivie ou précédée d'un souffle bruité, lui
    // aussi imprévisible. Un clic, lui, tombe dans un son bien prédit : l'écart habituel juste
    // autour (10 ms de chaque côté) doit rester petit devant le pic.
    let pk = 0;
    for (let t = e.from; t < e.to; t++) if (det[t] > pk) pk = det[t];
    const around = new Float64Array(2 * side);
    let m = 0;
    for (let t = e.from - side; t < e.from; t++) if (t >= 0) around[m++] = det[t];
    for (let t = e.to; t < e.to + side; t++) if (t < n) around[m++] = det[t];
    if (m > 16) {
      const loc = 1.4826 * kth(around.subarray(0, m), m >> 1);
      if (pk < k * CONSONANT_RATIO * Math.max(floor, loc)) continue;
    }
    const last = out[out.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return { events: out, models, pitch };
}

/** Retire les clics de bouche d'un canal (copie). */
export function removeClicks(x: Float32Array, sampleRate: number, strength: RepairStrength): { channel: Float32Array; stats: ClickStats } {
  const { events, models, pitch } = detectClicks(x, sampleRate, strength);
  if (!events.length) return { channel: x, stats: { count: 0, samples: 0 } };
  const y = new Float64Array(x);
  let count = 0, samples = 0;
  for (const e of events) {
    const b = Math.min(models.length - 1, Math.floor(((e.from + e.to) >> 1) / BLOCK));
    const c = models[b], lp = pitch[b];
    if (e.from < c.length || e.to + c.length > x.length) continue; // collé au bord : rien à quoi se raccrocher
    const keep = y.slice(e.from, e.to);
    // Voix voisée : modèle complet (enveloppe + période) si la période d'avant ou d'après existe ;
    // sinon l'enveloppe seule.
    const ltpOk = lp && e.from - lp.lag - c.length - 2 >= 0 || (lp && e.to + lp.lag + c.length + 2 <= x.length);
    const ok = (ltpOk && lsarFillTaps(y, e.from, e.to, composeLtp(c, lp!.lag, lp!.beta))) || lsarFill(y, e.from, e.to, c);
    if (ok) { count++; samples += e.to - e.from; } else y.set(keep, e.from);
  }
  return { channel: Float32Array.from(y), stats: { count, samples } };
}
