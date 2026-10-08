/**
 * Vocodeur de phase (R13) : étirer le temps sans toucher à la hauteur, et
 * transposer un son polyphonique (beat, sample, accords) avec un
 * rééchantillonnage derrière. Logique pure, sans DOM : tourne dans un worker
 * (utils/clipTranspose.worker.ts) et dans les tests.
 *
 * Ce que font les bons moteurs (élastique de Pro Tools « Polyphonic », Logic
 * « Flex Time Polyphonic », Ableton « Complex Pro », Rubber Band) et que l'on
 * reprend ici :
 *  1. Verrouillage de phase (Laroche & Dolson, « identity phase locking ») :
 *     chaque pic du spectre avance à sa fréquence instantanée, et les cases
 *     voisines gardent leur écart de phase avec leur pic. Sans ça, le son
 *     devient « phasé », comme joué dans un tuyau.
 *  2. Attaques nettes : aux attaques (caisse claire, kick, consonnes), les
 *     cases dont l'énergie monte d'un coup reprennent la phase d'origine
 *     (remise en phase). Le reste (la 808 qui tient) continue sans rupture.
 *  3. Stéréo intacte : la rotation de phase est calculée sur la somme des
 *     canaux et appliquée telle quelle à chacun : l'écart gauche / droite ne
 *     bouge pas (pas d'image qui flotte).
 *  4. Formants (option) : pour une transposition faite ensuite par
 *     rééchantillonnage, on corrige l'enveloppe du spectre (cepstre lissé)
 *     pour qu'elle retombe à sa place après transposition : une voix ne
 *     devient pas « chipmunk ».
 *  5. Bords : la normalisation tient compte de la part de chaque fenêtre qui
 *     tombe dans le son (un segment de warp coupé net ne s'éteint pas avant
 *     son bord).
 *
 * Correspondance des temps : l'échantillon de sortie t correspond à
 * l'échantillon d'entrée t / rapport (fenêtres centrées). La sortie a
 * exactement la longueur demandée.
 */

// ─── FFT complexe radix 2 (tables précalculées par taille) ─────────────────────

interface FftPlan { n: number; rev: Uint32Array; cos: Float64Array; sin: Float64Array }
const plans = new Map<number, FftPlan>();

function plan(n: number): FftPlan {
  let p = plans.get(n);
  if (p) return p;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  p = { n, rev, cos, sin };
  plans.set(n, p);
  return p;
}

/** FFT en place (inverse = true : sans la division par n). */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sgn = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t], wi = sgn * sin[t];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

const TWO_PI = 2 * Math.PI;
const wrap = (x: number) => x - TWO_PI * Math.round(x / TWO_PI);

/** Taille de fenêtre conseillée : ~46 ms (2048 à 44,1 / 48 kHz). */
export const defaultFftSize = (sr: number): number => (sr > 70000 ? 4096 : sr < 30000 ? 1024 : 2048);

export interface PvOptions {
  fftSize?: number;
  /** Recouvrement (fenêtres par taille de fenêtre). 4 par défaut. */
  overlap?: number;
  /** Attaques (échantillons d'entrée) : remise en phase des cases qui montent d'un coup. */
  onsets?: number[];
  /** Transposition qui suivra par rééchantillonnage (rapport de fréquences) : corrige l'enveloppe pour garder les formants. */
  formantPitch?: number;
  /** Taux d'échantillonnage (sert au lissage de l'enveloppe des formants). */
  sampleRate?: number;
}

/**
 * Étire des canaux (même longueur) vers `outLen` échantillons, hauteur
 * inchangée. 1 ou 2 canaux traités ensemble ; au-delà, par paires.
 */
export function pvStretch(chs: Float32Array[], outLen: number, opts: PvOptions = {}): Float32Array[] {
  if (chs.length > 2) {
    const out: Float32Array[] = [];
    for (let i = 0; i < chs.length; i += 2) out.push(...pvStretch(chs.slice(i, i + 2), outLen, opts));
    return out;
  }
  const inLen = chs[0]?.length || 0;
  if (!inLen || outLen <= 0) return chs.map(() => new Float32Array(Math.max(0, outLen)));
  const N = opts.fftSize ?? defaultFftSize(opts.sampleRate ?? 44100);
  const ov = opts.overlap ?? 4;
  const Hs = N / ov;
  const half = N / 2;
  const bins = half + 1;
  const ratio = outLen / inLen;
  const stereo = chs.length === 2;
  const L = chs[0], R = stereo ? chs[1] : null;

  // Fenêtre de Hann périodique (analyse = synthèse).
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
  let full = 0;
  for (let i = 0; i < N; i += Hs) full += win[i] * win[i];

  const outL = new Float64Array(outLen), outR = stereo ? new Float64Array(outLen) : null;
  const norm = new Float64Array(outLen);
  const re = new Float64Array(N), im = new Float64Array(N);
  const magM = new Float64Array(bins), phM = new Float64Array(bins);
  const prevPhM = new Float64Array(bins), prevPsi = new Float64Array(bins), prevMag = new Float64Array(bins);
  const psi = new Float64Array(bins);
  const Lr = new Float64Array(bins), Li = new Float64Array(bins), Rr = new Float64Array(bins), Ri = new Float64Array(bins);
  const peakOf = new Int32Array(bins);
  const omega = new Float64Array(bins);
  for (let b = 0; b < bins; b++) omega[b] = (TWO_PI * b) / N;

  // Formants : enveloppe lissée (cepstre), coupure ~1 ms (plus lisse que l'écart entre harmoniques d'une voix aiguë).
  const fp = opts.formantPitch && Math.abs(opts.formantPitch - 1) > 1e-4 ? opts.formantPitch : 0;
  const lifter = Math.max(8, Math.round((opts.sampleRate ?? 44100) * 0.001));
  const cre = fp ? new Float64Array(N) : null, cim = fp ? new Float64Array(N) : null;
  const env = fp ? new Float64Array(bins) : null;
  const gain = fp ? new Float64Array(bins) : null;

  const onsets = (opts.onsets || []).slice().sort((a, b) => a - b);
  let onsetIdx = 0;

  const kMin = -Math.ceil(half / Hs);
  const kMax = Math.ceil((outLen + half) / Hs);
  let first = true;
  let prevStart = 0;

  for (let k = kMin; k <= kMax; k++) {
    const sCenter = k * Hs;
    const aCenter = Math.round(sCenter / ratio);
    const aStart = aCenter - half;
    // Lecture fenêtrée (zéros hors du son) ; L + iR dans une seule FFT.
    let present = 0;
    for (let i = 0; i < N; i++) {
      const j = aStart + i;
      if (j >= 0 && j < inLen) { re[i] = L[j] * win[i]; im[i] = R ? R[j] * win[i] : 0; present++; }
      else { re[i] = 0; im[i] = 0; }
    }
    if (!present) { first = true; prevStart = aStart; continue; }
    fftInPlace(re, im);
    for (let b = 0; b < bins; b++) {
      const nb = (N - b) & (N - 1);
      if (R) {
        Lr[b] = (re[b] + re[nb]) / 2; Li[b] = (im[b] - im[nb]) / 2;
        Rr[b] = (im[b] + im[nb]) / 2; Ri[b] = -(re[b] - re[nb]) / 2;
        const mr = Lr[b] + Rr[b], mi = Li[b] + Ri[b];
        magM[b] = Math.sqrt(mr * mr + mi * mi); phM[b] = Math.atan2(mi, mr);
      } else {
        Lr[b] = re[b]; Li[b] = im[b];
        magM[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]); phM[b] = Math.atan2(im[b], re[b]);
      }
    }

    // Attaque entre la fenêtre précédente et celle-ci ?
    let onset = false;
    while (onsetIdx < onsets.length && onsets[onsetIdx] <= aCenter) {
      if (onsets[onsetIdx] > prevStart + half) onset = true;
      onsetIdx++;
    }

    if (first) {
      for (let b = 0; b < bins; b++) psi[b] = phM[b];
    } else {
      const ha = aStart - prevStart;
      // Pics du spectre (maximums locaux sur ±2 cases).
      const peaks: number[] = [];
      for (let b = 2; b < bins - 2; b++) {
        const m = magM[b];
        if (m > magM[b - 1] && m >= magM[b + 1] && m > magM[b - 2] && m >= magM[b + 2]) peaks.push(b);
      }
      if (!peaks.length) peaks.push(1);
      // Chaque case suit son pic (frontière au creux entre deux pics voisins).
      let b0 = 0;
      for (let p = 0; p < peaks.length; p++) {
        let end = bins - 1;
        if (p + 1 < peaks.length) {
          const a = peaks[p], c = peaks[p + 1];
          let lv = Infinity;
          for (let q = a; q <= c; q++) if (magM[q] < lv) { lv = magM[q]; end = q; }
        }
        for (let b = b0; b <= end; b++) peakOf[b] = peaks[p];
        b0 = end + 1;
      }
      // Phase de chaque pic : fréquence instantanée × pas de synthèse.
      for (const b of peaks) {
        let adv: number;
        if (ha > 0) {
          const d = wrap(phM[b] - prevPhM[b] - omega[b] * ha);
          adv = (omega[b] + d / ha) * Hs;
        } else adv = omega[b] * Hs;
        psi[b] = prevPsi[b] + adv;
      }
      for (let b = 0; b < bins; b++) {
        const pk = peakOf[b];
        if (pk !== b) psi[b] = psi[pk] + (phM[b] - phM[pk]);
      }
      // Remise en phase à l'attaque : seulement les cases qui montent nettement (+3,5 dB).
      if (onset) for (let b = 0; b < bins; b++) if (magM[b] > 1.5 * prevMag[b]) psi[b] = phM[b];
    }

    // Formants : gain = enveloppe là où la case atterrira après transposition / enveloppe ici.
    if (fp && cre && cim && env && gain) {
      for (let b = 0; b < bins; b++) { const v = Math.log(magM[b] + 1e-9); cre[b] = v; if (b > 0 && b < half) cre[N - b] = v; }
      cim.fill(0);
      fftInPlace(cre, cim);
      for (let q = 0; q < N; q++) {
        const keep = q < lifter || q > N - lifter;
        if (keep) { cre[q] /= N; cim[q] /= N; } else { cre[q] = 0; cim[q] = 0; }
      }
      fftInPlace(cre, cim);
      for (let b = 0; b < bins; b++) env[b] = cre[b];
      for (let b = 0; b < bins; b++) {
        const t = b * fp;
        let target: number;
        if (t >= half) target = env[half];
        else { const i0 = Math.floor(t), f = t - i0; target = env[i0] + (env[i0 + 1] - env[i0]) * f; }
        const g = target - env[b];
        gain[b] = Math.exp(Math.max(-2.76, Math.min(2.76, g))); // ±24 dB au plus
      }
    }

    // Rotation de phase (somme des canaux) appliquée à chaque canal ; spectre de sortie L + iR.
    for (let b = 0; b < bins; b++) {
      const rot = psi[b] - phM[b];
      const c = Math.cos(rot), s = Math.sin(rot);
      const g = gain ? gain[b] : 1;
      const yLr = (Lr[b] * c - Li[b] * s) * g, yLi = (Lr[b] * s + Li[b] * c) * g;
      let yRr = 0, yRi = 0;
      if (R) { yRr = (Rr[b] * c - Ri[b] * s) * g; yRi = (Rr[b] * s + Ri[b] * c) * g; }
      // W[b] = YL + i·YR ; W[N-b] = conj(YL) + i·conj(YR).
      re[b] = yLr - yRi; im[b] = yLi + yRr;
      if (b > 0 && b < half) { const nb = N - b; re[nb] = yLr + yRi; im[nb] = -yLi + yRr; }
    }
    fftInPlace(re, im, true);
    const oStart = sCenter - half;
    for (let i = 0; i < N; i++) {
      const o = oStart + i;
      if (o < 0 || o >= outLen) continue;
      const j = aStart + i;
      const w = win[i];
      outL[o] += (re[i] / N) * w;
      if (outR) outR[o] += (im[i] / N) * w;
      if (j >= 0 && j < inLen) norm[o] += w * w;
    }

    for (let b = 0; b < bins; b++) { prevPhM[b] = phM[b]; prevPsi[b] = psi[b]; prevMag[b] = magM[b]; }
    prevStart = aStart;
    first = false;
  }

  const floor = full * 0.02;
  const res = [new Float32Array(outLen)];
  if (outR) res.push(new Float32Array(outLen));
  for (let o = 0; o < outLen; o++) {
    const d = Math.max(norm[o], floor);
    res[0][o] = outL[o] / d;
    if (outR) res[1][o] = outR[o] / d;
  }
  return res;
}

// ─── Rééchantillonnage à rapport quelconque (transposition) ───────────────────

const kernels = new Map<string, { table: Float32Array; K: number; R: number }>();

function besselI0(x: number): number {
  let s = 1, t = 1;
  for (let k = 1; k < 200; k++) { const h = x / (2 * k); t *= h * h; s += t; if (t < 1e-14 * s) break; }
  return s;
}

/** Noyau sinus cardinal fenêtré (Kaiser), échantillonné finement (R points par échantillon d'entrée). */
function kernel(fc: number): { table: Float32Array; K: number; R: number } {
  const key = fc.toFixed(4);
  let k = kernels.get(key);
  if (k) return k;
  const zc = 12, beta = 8, R = 2048;
  const K = Math.ceil(zc / fc);
  const table = new Float32Array((K + 1) * R + 1);
  const ib = besselI0(beta);
  for (let i = 0; i < table.length; i++) {
    const t = i / R;
    const x = t * fc;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = t / (K + 1);
    const w = r >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / ib;
    table[i] = fc * sinc * w;
  }
  k = { table, K, R };
  kernels.set(key, k);
  return k;
}

/**
 * Lit `x` avec un pas de `step` échantillons d'entrée par échantillon de
 * sortie (step > 1 : plus aigu et plus court), sur exactement `outLen`
 * échantillons. Filtre anti-repliement quand on lit plus vite. Phase du
 * noyau au 1/2048 d'échantillon (erreur < −65 dB).
 */
export function resampleStep(x: Float32Array, step: number, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  const n = x.length;
  if (!n) return out;
  const fc = Math.min(1, 1 / step) * 0.94;
  const { table, K, R } = kernel(fc);
  for (let o = 0; o < outLen; o++) {
    const pos = o * step;
    const base = Math.floor(pos);
    const f = Math.round((pos - base) * R);
    let acc = 0, wsum = 0;
    const jLo = Math.max(-K + 1, -base), jHi = Math.min(K, n - 1 - base);
    // Poids complets (pour la normalisation), échantillons dans le son seulement.
    for (let j = -K + 1; j < jLo; j++) wsum += table[Math.abs(j * R - f)];
    for (let j = jLo; j <= jHi; j++) { const w = table[Math.abs(j * R - f)]; wsum += w; acc += x[base + j] * w; }
    for (let j = jHi + 1; j <= K; j++) wsum += table[Math.abs(j * R - f)];
    out[o] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}
