/**
 * Banc de mesure de Nova Tune (22/10/2026) : MÊMES signaux et MÊMES analyses que la mesure
 * boîte noire de la référence du marché (tools/novatune/boite_noire.py), pour comparer chiffre
 * à chiffre (CONTENU/nova-tune/boite_noire/mesures*.json).
 *
 *  - vowelTrack : voyelle additive à formants FIXES (700 / 1220 / 2600 Hz), hauteur midi(t) ;
 *  - pitchTrack : hauteur par trame (NSDF de McLeod, fenêtre 30 ms, pas 5 ms, pic interpolé) ;
 *  - centroid   : centre de gravité spectral 200–5000 Hz (déplacement des formants) ;
 *  - autotune   : rendu hors ligne d'un AutoTuneNode (mini Web Audio de tests/helpers).
 */
import { installMiniWebAudio, MiniOfflineAudioContext } from './miniWebAudio';

export const FORMANTS: [number, number][] = [[700, 110], [1220, 120], [2600, 160]];

function envFormants(f: number) {
  let g = 0;
  for (const [fc, bw] of FORMANTS) g += 1 / Math.sqrt(1 + ((f - fc) / (bw / 2)) ** 2);
  return g / Math.max(1, f / 1000);
}

/** Voyelle de hauteur midi(t) (une valeur par échantillon), crête `amp`, fondus de 10 ms. */
export function vowelTrack(midi: ArrayLike<number>, sr = 48000, amp = 0.25, fmax = 6000): Float32Array {
  const n = midi.length;
  const out = new Float64Array(n);
  let fmin = Infinity;
  const f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) { f0[i] = 440 * Math.pow(2, (midi[i] - 69) / 12); fmin = Math.min(fmin, f0[i]); }
  const kmax = Math.floor(fmax / fmin);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * f0[i] / sr;
    let s = 0;
    for (let k = 1; k <= kmax; k++) {
      const fk = k * f0[i];
      if (fk >= fmax) break;
      s += envFormants(fk) * Math.sin(k * ph) / Math.pow(k, 0.3);
    }
    out[i] = s;
  }
  let pk = 1e-12;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  const y = new Float32Array(n);
  const fade = Math.round(0.01 * sr);
  for (let i = 0; i < n; i++) {
    let g = amp / pk;
    if (i < fade) g *= i / fade;
    if (i >= n - fade) g *= (n - 1 - i) / fade;
    y[i] = out[i] * g;
  }
  return y;
}

export const constMidi = (m: number, seconds: number, sr = 48000) => new Float64Array(Math.round(seconds * sr)).fill(m);

// ─── FFT (radix 2, en place) ────────────────────────────────────────────────

function fft(re: Float64Array, im: Float64Array, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Hauteur par trame : { t (s), midi } ; midi = 0 si non voisé. Port exact de boite_noire.pitch_track. */
export function pitchTrack(x: ArrayLike<number>, sr = 48000, hop = 0.005, win = 0.03, fmin = 60, fmax = 1000): { t: number[]; midi: number[] } {
  const W = Math.round(win * sr), H = Math.round(hop * sr);
  const lmin = Math.floor(sr / fmax), lmax = Math.floor(sr / fmin);
  let nfft = 1; while (nfft < 2 * (W + lmax)) nfft *= 2;
  const t: number[] = [], midi: number[] = [];
  const aR = new Float64Array(nfft), aI = new Float64Array(nfft), bR = new Float64Array(nfft), bI = new Float64Array(nfft);
  const L = W + lmax + 2;
  const c2 = new Float64Array(L + 1);
  for (let a = 0; a + L <= x.length; a += H) {
    let e0 = 0;
    for (let j = 0; j < W; j++) e0 += x[a + j] * x[a + j];
    const tc = (a + W / 2) / sr;
    if (Math.sqrt(e0 / W) < 1e-4) { t.push(tc); midi.push(0); continue; }
    aR.fill(0); aI.fill(0); bR.fill(0); bI.fill(0);
    for (let j = 0; j < L; j++) aR[j] = x[a + j];
    for (let j = 0; j < W; j++) bR[j] = x[a + j];
    fft(aR, aI); fft(bR, bI);
    for (let k = 0; k < nfft; k++) { const r = bR[k] * aR[k] + bI[k] * aI[k], i = bR[k] * aI[k] - bI[k] * aR[k]; aR[k] = r; aI[k] = i; }
    fft(aR, aI, true);
    c2[0] = 0;
    for (let j = 0; j < L; j++) c2[j + 1] = c2[j] + x[a + j] * x[a + j];
    const nsdf = (l: number) => 2 * aR[l] / (e0 + (c2[l + W] - c2[l]) + 1e-20);
    let mx = -Infinity;
    for (let l = lmin; l < lmax; l++) mx = Math.max(mx, nsdf(l));
    if (mx < 0.5) { t.push(tc); midi.push(0); continue; }
    const thr = 0.8 * mx;
    let k = -1;
    for (let l = lmin + 1; l < lmax - 1; l++) { const v = nsdf(l); if (v >= thr && v >= nsdf(l - 1) && v >= nsdf(l + 1)) { k = l; break; } }
    if (k < 0) { t.push(tc); midi.push(0); continue; }
    const y0 = nsdf(k - 1), y1 = nsdf(k), y2 = nsdf(k + 1), den = y0 - 2 * y1 + y2;
    const lf = k + (Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0);
    t.push(tc); midi.push(69 + 12 * Math.log2(sr / lf / 440));
  }
  return { t, midi };
}

/** Centre de gravité spectral (Hz, 200–5000 Hz, puissance) sur 8192 échantillons (Hann). */
export function centroid(x: ArrayLike<number>, sr = 48000, from = 0): number {
  const n = 8192;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n && from + i < x.length; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  fft(re, im);
  let a = 0, b = 0;
  for (let k = 0; k <= n / 2; k++) {
    const f = k * sr / n;
    if (f <= 200 || f >= 5000) continue;
    const p = re[k] * re[k] + im[k] * im[k];
    a += f * p; b += p;
  }
  return a / b;
}

/** Retard (échantillons, fractionnaire) de y sur x par intercorrélation, |retard| ≤ maxLag. */
export function delayOf(x: ArrayLike<number>, y: ArrayLike<number>, maxLag: number): number {
  const n = Math.min(x.length, y.length);
  let nfft = 1; while (nfft < 2 * n) nfft *= 2;
  const aR = new Float64Array(nfft), aI = new Float64Array(nfft), bR = new Float64Array(nfft), bI = new Float64Array(nfft);
  for (let i = 0; i < n; i++) { aR[i] = x[i]; bR[i] = y[i]; }
  fft(aR, aI); fft(bR, bI);
  for (let k = 0; k < nfft; k++) { const r = bR[k] * aR[k] + bI[k] * aI[k], i = bI[k] * aR[k] - bR[k] * aI[k]; bR[k] = r; bI[k] = i; }
  fft(bR, bI, true);
  const at = (l: number) => bR[(l + nfft) % nfft];
  let best = 0, bv = -Infinity;
  for (let l = -maxLag; l <= maxLag; l++) if (at(l) > bv) { bv = at(l); best = l; }
  const a = at(best - 1), b = at(best), c = at(best + 1), den = a - 2 * b + c;
  return best + (Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0);
}

/** Rendu hors ligne d'un nœud d'autotune (classe passée : moteur actuel ou copie « avant »). */
export async function renderTune(NodeClass: any, sr: number, x: Float32Array, p: Record<string, any>, tail = 0.1): Promise<{ y: Float32Array; lat: number }> {
  const restore = installMiniWebAudio();
  try {
    const n = x.length + Math.round(tail * sr);
    const ctx = new MiniOfflineAudioContext(1, n, sr) as unknown as AudioContext;
    const at = new NodeClass(ctx);
    await at.ready;
    at.updateParams({ humanize: 0, mix: 1, isEnabled: true, rootKey: 0, scale: 'CHROMATIC', ...p });
    const b = ctx.createBuffer(1, x.length, sr); b.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(at.input); at.output.connect(ctx.destination); src.start(0);
    const out = await (ctx as unknown as OfflineAudioContext).startRendering();
    return { y: out.getChannelData(0), lat: Math.round(at.latency * sr) };
  } finally { restore(); }
}

/** Instant (ms) où l'écart passe sous frac × start (t en s), ou NaN. */
export function tReach(t: number[], dev: number[], frac: number, start: number): number {
  for (let i = 0; i < t.length; i++) if (t[i] > 0 && dev[i] <= frac * start) return t[i] * 1000;
  return NaN;
}

/** Profondeur crête d'une modulation (√2 × écart-type), en cents. */
export function depthCents(m: number[]): number {
  const mean = m.reduce((a, b) => a + b, 0) / m.length;
  return Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / m.length) * Math.SQRT2 * 100;
}
