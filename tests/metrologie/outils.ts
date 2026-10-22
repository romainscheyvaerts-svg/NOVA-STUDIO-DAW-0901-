/**
 * Banc de métrologie NOVA (22/10/2026) : outils de mesure partagés par tests/metrologie*.test.ts.
 *
 * Tout est mesuré sur le SON produit (signaux de test → cœur DSP ou worklet tel qu'exporté),
 * jamais en relisant les réglages. Conventions écrites ici une fois pour toutes :
 *  - niveau d'un sinus = sa CRÊTE en dBFS (0 dBFS = amplitude 1) ;
 *  - niveau RMS = 20·log10(rms) (un sinus de crête 0 dBFS vaut −3,01 dB RMS) ;
 *  - amplitude d'une raie = ajustement aux moindres carrés (sinus + cosinus) sur une fenêtre
 *    entière de périodes (indépendant de la phase, insensible au reste du spectre) ;
 *  - temps d'attaque / de relâchement = temps pour parcourir 63,2 % (constante de temps τ)
 *    ou 90 % de l'écart de gain (en dB) entre l'état de départ et l'état d'arrivée ;
 *  - crête vraie (dBTP) = crête du signal suréchantillonné ×4 (sinc fenêtré de Kaiser, 192 points,
 *    même principe que l'ITU-R BS.1770-4).
 */

export const dbOf = (lin: number) => 20 * Math.log10(Math.max(1e-30, Math.abs(lin)));
export const linOf = (db: number) => Math.pow(10, db / 20);

/** Sinus de crête `ampDb` dBFS. */
export function sine(freq: number, sr: number, n: number, ampDb = 0, phase = 0): Float32Array {
  const a = linOf(ampDb), w = (2 * Math.PI * freq) / sr;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin(w * i + phase);
  return out;
}

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruit rose (filtre de Paul Kellet), normalisé à `rmsDbTarget` dB RMS. */
export function pinkNoise(n: number, rmsDbTarget = -20, seed = 7): Float32Array {
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
  }
  const g = linOf(rmsDbTarget) / rms(out);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
export const rmsDb = (x: ArrayLike<number>, from = 0, to = x.length) => dbOf(rms(x, from, to));
export function peak(x: ArrayLike<number>, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}
export const peakDb = (x: ArrayLike<number>, from = 0, to = x.length) => dbOf(peak(x, from, to));

/**
 * Amplitude (crête) et phase d'une raie à `freq` par moindres carrés sur x[from..to)
 * (la fenêtre est réduite à un nombre entier de périodes).
 */
export function tone(x: ArrayLike<number>, freq: number, sr: number, from = 0, to = x.length): { amp: number; db: number; phase: number } {
  const per = sr / freq;
  const periods = Math.max(1, Math.floor((to - from) / per));
  const end = from + Math.round(periods * per);
  const w = (2 * Math.PI * freq) / sr;
  let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
  for (let i = from; i < Math.min(end, to); i++) {
    const s = Math.sin(w * i), c = Math.cos(w * i), v = x[i];
    ss += s * s; cc += c * c; sc += s * c; xs += v * s; xc += v * c;
  }
  const det = ss * cc - sc * sc;
  const a = (xs * cc - xc * sc) / det, b = (xc * ss - xs * sc) / det;
  const amp = Math.hypot(a, b);
  return { amp, db: dbOf(amp), phase: Math.atan2(b, a) };
}

/** Réponse (gain dB, phase rad) d'un système à `freq` : rapport des raies sortie / entrée. */
export function respAt(input: ArrayLike<number>, output: ArrayLike<number>, freq: number, sr: number, from: number, to: number) {
  const a = tone(input, freq, sr, from, to), b = tone(output, freq, sr, from, to);
  let ph = b.phase - a.phase;
  while (ph > Math.PI) ph -= 2 * Math.PI;
  while (ph < -Math.PI) ph += 2 * Math.PI;
  return { db: b.db - a.db, phase: ph };
}

/** Réponse d'un biquad normalisé (b0, b1, b2, a1, a2) : gain dB et phase. */
export function biquadDb(c: ArrayLike<number>, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
  const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/**
 * Fréquence (Hz) où `fn` (dB, monotone sur [lo, hi]) croise `target`, par dichotomie en log.
 * Renvoie NaN si pas de croisement.
 */
export function crossing(fn: (f: number) => number, target: number, lo: number, hi: number, iters = 60): number {
  let a = lo, b = hi;
  const fa = fn(a) - target, fb = fn(b) - target;
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (Math.sign(fa) === Math.sign(fb)) return NaN;
  for (let i = 0; i < iters; i++) {
    const m = Math.sqrt(a * b), fm = fn(m) - target;
    if (Math.sign(fm) === Math.sign(fa)) a = m; else b = m;
  }
  return Math.sqrt(a * b);
}

/** Maximum de `fn` sur [lo, hi] (balayage log puis affinage) : { f, db }. */
export function maxOf(fn: (f: number) => number, lo: number, hi: number, steps = 2000) {
  let bf = lo, bv = -Infinity;
  for (let i = 0; i <= steps; i++) { const f = lo * Math.pow(hi / lo, i / steps); const v = fn(f); if (v > bv) { bv = v; bf = f; } }
  let a = bf / Math.pow(hi / lo, 1 / steps), b = bf * Math.pow(hi / lo, 1 / steps);
  for (let i = 0; i < 80; i++) {
    const m1 = a * Math.pow(b / a, 1 / 3), m2 = a * Math.pow(b / a, 2 / 3);
    if (fn(m1) < fn(m2)) a = m1; else b = m2;
  }
  const f = Math.sqrt(a * b);
  return { f, db: fn(f) };
}

/** Pente (dB/octave) de `fn` entre f et 2f. */
export const slopePerOct = (fn: (f: number) => number, f: number) => fn(2 * f) - fn(f);

/** Écart relatif (%) entre une valeur mesurée et la valeur affichée. */
export const ecartPct = (mesure: number, affiche: number) => (100 * (mesure - affiche)) / affiche;

/**
 * Temps (s) pour qu'une courbe de gain (dB, un point par échantillon à partir de `start`)
 * parcoure `pct` % de l'écart entre sa valeur en `start` et sa valeur finale `final`.
 */
export function timeToPct(gainDb: ArrayLike<number>, start: number, sr: number, pct: number, final?: number): number {
  const g0 = gainDb[start];
  const g1 = final ?? gainDb[gainDb.length - 1];
  const target = g0 + (g1 - g0) * (pct / 100);
  const up = g1 > g0;
  for (let i = start; i < gainDb.length; i++) {
    if (up ? gainDb[i] >= target : gainDb[i] <= target) {
      // Interpolation linéaire entre i−1 et i.
      if (i === start) return 0;
      const a = gainDb[i - 1], b = gainDb[i];
      const fr = b === a ? 0 : (target - a) / (b - a);
      return (i - 1 - start + fr) / sr;
    }
  }
  return NaN;
}

// ── Crête vraie (×4) ─────────────────────────────────────────────────────────────────────────
function besselI0(x: number) { let s = 1, t = 1; for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; }
let tpTaps: Float64Array[] | null = null;
/** Filtre polyphase ×4 (48 points par phase, Kaiser β = 8). */
function tpFilter(): Float64Array[] {
  if (tpTaps) return tpTaps;
  const OS = 4, PER = 48, N = OS * PER, beta = 8;
  const h = new Float64Array(N);
  const c = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const t = (i - c) / OS;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (i - c) / c;
    h[i] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
  }
  tpTaps = [];
  for (let p = 0; p < OS; p++) { const ph = new Float64Array(PER); for (let k = 0; k < PER; k++) ph[k] = h[k * OS + p]; tpTaps.push(ph); }
  return tpTaps;
}
/** Crête vraie (linéaire) de x, suréchantillonnage ×4. */
export function truePeak(x: ArrayLike<number>): number {
  const ph = tpFilter();
  const PER = ph[0].length;
  let p = peak(x);
  for (let i = 0; i < x.length; i++) {
    for (let q = 0; q < ph.length; q++) {
      let s = 0;
      const h = ph[q];
      for (let k = 0; k < PER; k++) { const j = i - k + PER / 2; if (j >= 0 && j < x.length) s += h[k] * x[j]; }
      const a = Math.abs(s);
      if (a > p) p = a;
    }
  }
  return p;
}
export const truePeakDb = (x: ArrayLike<number>) => dbOf(truePeak(x));

// ── Worklet tel qu'il tourne dans le navigateur (code source sérialisé) ───────────────────────
export interface WorkletRun {
  /** Classe(s) enregistrée(s) par registerProcessor, par nom. */
  classes: Record<string, any>;
  scope: any;
}

/**
 * Exécute le code d'un module AudioWorklet (chaîne) dans une portée simulée : sampleRate,
 * currentFrame, currentTime, AudioWorkletProcessor (port avec messages relevés), registerProcessor.
 */
export function loadWorkletCode(code: string, sampleRate: number): WorkletRun {
  const scope: any = { sampleRate, currentFrame: 0, currentTime: 0, classes: {} as Record<string, any> };
  scope.AudioWorkletProcessor = class {
    port: any;
    constructor() {
      const msgs: any[] = [];
      this.port = { onmessage: null, postMessage: (m: any) => { msgs.push(m); }, messages: msgs };
    }
  };
  scope.registerProcessor = (name: string, cls: any) => { scope.classes[name] = cls; };
  // eslint-disable-next-line no-new-func
  new Function('scope', `with (scope) { ${code} }`)(scope);
  return { classes: scope.classes, scope };
}

/**
 * Fait tourner un processeur sur des entrées (canaux), par blocs de 128, et renvoie les sorties.
 * `params` : valeurs fixes des AudioParams (nom → valeur) ; les descripteurs absents prennent leur défaut.
 * `onBlock(i)` : appelé avant chaque bloc (pour changer un réglage, envoyer un message…).
 */
export function runProcessor(run: WorkletRun, proc: any, inputs: Float32Array[][], nOut = 2, params: Record<string, number> = {}, onBlock?: (blockStart: number) => void): Float32Array[][] {
  const cls = proc.constructor;
  const desc: any[] = cls.parameterDescriptors || [];
  const n = inputs[0][0].length;
  const outs: Float32Array[][] = [Array.from({ length: nOut }, () => new Float32Array(n))];
  const pv: Record<string, Float32Array> = {};
  for (const d of desc) pv[d.name] = new Float32Array([params[d.name] ?? d.defaultValue ?? 0]);
  for (let b = 0; b < n; b += 128) {
    run.scope.currentFrame = b;
    run.scope.currentTime = b / run.scope.sampleRate;
    onBlock?.(b);
    for (const d of desc) if (d.name in params) pv[d.name][0] = params[d.name];
    const len = Math.min(128, n - b);
    const ins = inputs.map(chs => chs.map(c => { const a = new Float32Array(128); a.set(c.subarray(b, b + len)); return a; }));
    const os = [Array.from({ length: nOut }, () => new Float32Array(128))];
    proc.process(ins, os, pv);
    for (let c = 0; c < nOut; c++) outs[0][c].set(os[0][c].subarray(0, len), b);
  }
  return outs[0];
}

/** Envoie un message au processeur comme `node.port.postMessage` (appel direct de onmessage). */
export function sendMsg(proc: any, data: any) { proc.port.onmessage?.({ data }); }

/** Ligne de tableau du rapport : réglage, affiché, mesuré, écart, verdict. */
export interface LigneMesure { effet: string; reglage: string; affiche: string; mesure: string; ecart: string; ok: boolean }
export const lignes: LigneMesure[] = [];
export function noter(l: LigneMesure) { lignes.push(l); return l; }
export const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : String(v));

// ── Ajouts du banc limiteur / gates / multibande (fork dyn-B) ────────────────────────────────
const tpCache: Record<string, Float64Array[]> = {};
/**
 * Crête vraie (linéaire) avec un filtre d'arbitrage réglable : suréchantillonnage `os`,
 * `perPhase` points par phase, fenêtre de Kaiser `beta`. Par défaut ×8, 128 points, β = 10
 * (bande de transition étroite : juste jusqu'à ~0,47·fs, plus fin que la mesure ×4 des plateformes).
 */
export function truePeakOs(x: ArrayLike<number>, os = 8, perPhase = 128, beta = 10): number {
  const key = `${os}/${perPhase}/${beta}`;
  let ph = tpCache[key];
  if (!ph) {
    const N = os * perPhase, c = (N - 1) / 2, h = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const t = (i - c) / os;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = (i - c) / c;
      h[i] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
    }
    ph = [];
    for (let p = 0; p < os; p++) { const a = new Float64Array(perPhase); for (let k = 0; k < perPhase; k++) a[k] = h[k * os + p]; ph.push(a); }
    tpCache[key] = ph;
  }
  let p = peak(x);
  for (let i = 0; i < x.length; i++) {
    for (let q = 0; q < ph.length; q++) {
      let s = 0;
      const h = ph[q];
      for (let k = 0; k < perPhase; k++) { const j = i - k + perPhase / 2; if (j >= 0 && j < x.length) s += h[k] * x[j]; }
      const a = Math.abs(s);
      if (a > p) p = a;
    }
  }
  return p;
}

/** Passe un signal (stéréo) dans un cœur DSP `process(inL, inR, outL, outR, n)`, par blocs de 128. */
export function runCore(core: { process: (...a: any[]) => void }, L: Float32Array, R: Float32Array = L, onBlock?: (start: number) => void): [Float32Array, Float32Array] {
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    onBlock?.(i);
    const m = Math.min(128, n - i);
    core.process(L.subarray(i, i + m), R.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m);
  }
  return [oL, oR];
}

/** Concatène des morceaux de signal. */
export function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Gain appliqué (dB) échantillon par échantillon pour un sinus d'entrée connu : enveloppe de
 * l'amplitude de sortie (moindres carrés glissants sur une période) / amplitude d'entrée.
 */
export function gainTrack(out: ArrayLike<number>, inp: ArrayLike<number>, freq: number, sr: number, hop = 1): Float64Array {
  const per = Math.max(2, Math.round(sr / freq));
  const n = out.length, g = new Float64Array(n);
  for (let i = 0; i < n; i += hop) {
    const a = Math.max(0, i - (per >> 1)), b = Math.min(n, a + per);
    const o = rms(out, a, b), x = rms(inp, a, b);
    const v = x > 1e-12 ? dbOf(o / x) : 0;
    for (let k = i; k < Math.min(n, i + hop); k++) g[k] = v;
  }
  return g;
}

/**
 * Crête vraie selon l'ITU-R BS.1770-4 (annexe 2) : suréchantillonnage ×4, filtre de 48 points
 * (4 phases de 12), celui des mesureurs dBTP des plateformes. Linéaire.
 */
const BS1770_PHASES = [
  [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
  [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875],
  [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750, 0.9721679687500, 0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750],
];
export function truePeakBs1770(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    for (const h of BS1770_PHASES) {
      let s = 0;
      for (let k = 0; k < 12; k++) { const j = i - k; if (j >= 0) s += h[k] * x[j]; }
      const a = Math.abs(s);
      if (a > p) p = a;
    }
  }
  return p;
}

/**
 * Gain instantané (dB) par moindres carrés sur une fenêtre glissante centrée de `win` échantillons :
 * g = Σ(y·x) / Σ(x·x) (même estimateur que le labo NOVA, tools/labo/bench.py) — le stimulus x étant
 * connu exactement, l'estimation reste juste de part et d'autre d'un saut de niveau.
 */
export function gainLsDb(y: ArrayLike<number>, x: ArrayLike<number>, win: number): Float64Array {
  const n = x.length, h = Math.floor(win / 2);
  const out = new Float64Array(n);
  let num = 0, den = 0;
  // somme glissante sur [i - h, i - h + win)
  for (let i = 0; i < Math.min(win, n); i++) { num += y[i] * x[i]; den += x[i] * x[i]; }
  for (let i = 0; i < n; i++) {
    const a = i - h, b = a + win;
    if (a > 0 && b <= n) { num += y[b - 1] * x[b - 1] - y[a - 1] * x[a - 1]; den += x[b - 1] * x[b - 1] - x[a - 1] * x[a - 1]; }
    out[i] = 20 * Math.log10(Math.max(1e-9, Math.abs(num / Math.max(den, 1e-30))));
  }
  return out;
}

/** Médiane de x[from..to). */
export function median(x: ArrayLike<number>, from = 0, to = x.length): number {
  const a = Array.prototype.slice.call(x, from, to).sort((p: number, q: number) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
}

/**
 * Réponse à un saut de niveau d'un sinus (méthode du labo NOVA) : réduction de gain dans le temps,
 * temps à 63,2 % et 90 % de l'attaque (montée) et du relâchement (descente), en ms.
 * `proc(x)` rend la sortie (canal gauche) pour l'entrée x (mono, même longueur).
 */
export function stepResponse(proc: (x: Float32Array) => Float32Array, sr: number, freq: number, baseDb: number, stepDb: number, hold: number, relObs: number, pre = 1.0) {
  const n0 = Math.round(pre * sr), n1 = Math.round(hold * sr), n2 = Math.round(relObs * sr);
  const n = n0 + n1 + n2;
  const x = new Float32Array(n);
  const lo = linOf(baseDb), hi = linOf(baseDb + stepDb), w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < n; i++) x[i] = (i >= n0 && i < n0 + n1 ? hi : lo) * Math.sin(w * i);
  const y = proc(x);
  const win = Math.max(4, Math.round(sr / freq / 4));
  const g = gainLsDb(y, x, win);
  const gBase = median(g, n0 - Math.round(0.2 * sr), n0 - Math.round(0.02 * sr));
  const gr = Array.from(g, v => gBase - v);
  const grHold = median(gr, n0 + n1 - Math.max(Math.round(0.1 * hold * sr), 48), n0 + n1 - 24);
  const times = (start: number, end: number, from: number, to: number, skip = 0) => {
    const r: Record<string, number> = {};
    for (const m of [0.632, 0.9]) {
      const target = from + m * (to - from), s = Math.sign(to - from);
      let t = NaN;
      for (let i = start + skip; i < end; i++) if ((gr[i] - target) * s >= 0) { t = (i - start) / sr * 1000; break; }
      r[m === 0.632 ? 't63' : 't90'] = t;
    }
    return r;
  };
  return { grHold, attack: times(n0, n0 + n1, 0, grHold), release: times(n0 + n1, n, grHold, 0, win), gr };
}

/**
 * Amplitudes (dB crête) de plusieurs raies ajustées ENSEMBLE par moindres carrés sur x[from..to) :
 * une raie forte voisine ne fuit pas dans la mesure d'une raie faible (sondes à −50 dB d'un sinus fort).
 */
export function tonesDb(x: ArrayLike<number>, freqs: number[], sr: number, from = 0, to = x.length): number[] {
  const k = freqs.length * 2, A = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k);
  const ws = freqs.map(f => (2 * Math.PI * f) / sr), basis = new Float64Array(k);
  for (let i = from; i < to; i++) {
    for (let j = 0; j < freqs.length; j++) { basis[2 * j] = Math.sin(ws[j] * i); basis[2 * j + 1] = Math.cos(ws[j] * i); }
    const v = x[i];
    for (let r = 0; r < k; r++) { b[r] += basis[r] * v; const Ar = A[r]; for (let c = r; c < k; c++) Ar[c] += basis[r] * basis[c]; }
  }
  for (let r = 0; r < k; r++) for (let c = 0; c < r; c++) A[r][c] = A[c][r];
  // Élimination de Gauss avec pivot partiel.
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < k; r++) { const f = A[r][c] / A[c][c]; if (!f) continue; for (let cc = c; cc < k; cc++) A[r][cc] -= f * A[c][cc]; b[r] -= f * b[c]; }
  }
  const sol = new Float64Array(k);
  for (let r = k - 1; r >= 0; r--) { let s = b[r]; for (let c = r + 1; c < k; c++) s -= A[r][c] * sol[c]; sol[r] = s / A[r][r]; }
  return freqs.map((_, j) => dbOf(Math.hypot(sol[2 * j], sol[2 * j + 1])));
}
