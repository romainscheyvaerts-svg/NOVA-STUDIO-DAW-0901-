/**
 * Détection de hauteur de NOVA — module PUR et réutilisable (Nova Tune, éditeur de notes,
 * accordeur, analyses hors ligne).
 *
 * `createPitchDetector` ne référence RIEN en dehors d'elle-même : elle est sérialisée par
 * `toString()` dans l'AudioWorklet de Nova Tune (même code en lecture, à l'export et dans les
 * tests). `detectPitchTrack` l'applique à un tampon entier (hors ligne).
 *
 * Algorithme (sources publiques, voir CONTENU/nova-tune/RECHERCHE.md) :
 *  1. filtre passe-bas (Butterworth ordre 2) + sous-échantillonnage ×2 (×4 au-delà de 60 kHz) :
 *     moins de calcul, moins d'erreurs d'octave dues aux formants ;
 *  2. YIN (de Cheveigné & Kawahara, JASA 2002) : différence cumulée normalisée d'(τ), premier
 *     creux sous le seuil (0,15), à défaut le minimum global s'il reste crédible (< 0,25) ;
 *  3. portes de voisement : absolue (−60 dBFS RMS) et RELATIVE au niveau récent de la voix
 *     (−40 dB) : souffle, bruit de pièce et fins de mots ne sont pas « chantés » ;
 *  4. garde d'octave par continuité (idée du suivi de pYIN, Mauch & Dixon 2014, en version
 *     causale) : un saut d'octave (ou de quinte+octave) isolé est remplacé par le creux de d'
 *     proche de la hauteur précédente s'il est crédible ; un vrai saut est accepté après 6 trames
 *     (~32 ms) ;
 *  5. affinage à pleine résolution (minimum de la fonction de différence autour de la période
 *     trouvée + interpolation parabolique), comme le cœur PSOLA de NOVA.
 *
 * Les options par défaut reproduisent l'analyse de Nova Tune (trame 24 ms à 48 kHz, plage
 * 75–1000 Hz). `setRange` restreint la recherche (type de voix) sans changer la trame ni la latence.
 */

export interface PitchDetectorOptions {
  /** Plus basse fondamentale cherchée (Hz) : fixe la longueur de la trame. Défaut 75. */
  fMin?: number;
  /** Plus haute fondamentale cherchée (Hz). Défaut 1000. */
  fMax?: number;
  /** Seuil YIN sur d'(τ). Défaut 0,15. */
  threshold?: number;
  /** Porte absolue : trame muette sous ce niveau RMS (dBFS). Défaut −60. */
  silenceDb?: number;
  /** Porte relative : trame muette si elle est à plus de N dB sous le niveau récent de la voix. Défaut 40 ; 0 = sans. */
  relativeGateDb?: number;
  /** Garde d'octave par continuité. Défaut vrai. */
  octaveGuard?: boolean;
  /** Affinage à pleine résolution. Défaut vrai. */
  refine?: boolean;
  /** Sans creux sous le seuil : minimum global accepté s'il est sous cette valeur. Défaut 0,25. */
  fallbackThreshold?: number;
  /**
   * Analyse « historique » de Nova Tune (avant le 22/10/2026) : porte absolue −48 dBFS sur le
   * signal filtré, ni porte relative, ni garde d'octave, ni affinage. Sert de référence aux tests.
   */
  legacy?: boolean;
}

export interface PitchEstimate {
  /** Période en échantillons d'ENTRÉE (0 = trame non voisée). */
  period: number;
  /** Fondamentale (Hz), 0 si non voisée. */
  f0: number;
  /** Note MIDI décimale (69 = La 440 Hz), 0 si non voisée. */
  midi: number;
  /** Fiabilité 0–1 (1 − apériodicité d' au creux retenu). */
  confidence: number;
  voiced: boolean;
  /** Niveau RMS de la trame (linéaire). */
  rms: number;
}

export interface PitchDetector {
  /** Ajoute n échantillons (mono). */
  push(x: ArrayLike<number>, n?: number): void;
  /** Analyse la trame qui se termine au dernier échantillon reçu. */
  estimate(): PitchEstimate;
  /** Position (échantillon d'entrée, absolue depuis le départ) du centre de la dernière trame analysable. */
  center(): number;
  /** Longueur de la trame d'analyse (échantillons d'entrée). */
  frameLength(): number;
  /** Échantillons reçus depuis le départ. */
  count(): number;
  /** Plage de recherche active (Hz), bornée à [fMin, fMax] ; sans effet sur la trame. */
  setRange(fLo: number, fHi: number): void;
  reset(): void;
}

export function createPitchDetector(sampleRate: number, opts?: PitchDetectorOptions): PitchDetector {
  const o = opts || {};
  const sr = sampleRate;
  const legacy = !!o.legacy;
  const F_MIN = o.fMin || 75;
  const F_MAX = o.fMax || 1000;
  const THR = o.threshold || 0.15;
  const GATE_ABS = legacy ? 0.004 : Math.pow(10, (o.silenceDb === undefined ? -60 : o.silenceDb) / 20);
  const GATE_REL = legacy ? 0 : (o.relativeGateDb === undefined ? 40 : o.relativeGateDb);
  const GUARD = legacy ? false : o.octaveGuard !== false;
  const REFINE = legacy ? false : o.refine !== false;
  const FALLBACK = legacy ? 0.25 : (o.fallbackThreshold || 0.25);
  const D = sr > 60000 ? 4 : 2;
  const ar = sr / D;
  const tauMinAll = Math.max(2, Math.floor(ar / F_MAX));
  const tauMax = Math.ceil(ar / F_MIN);
  const W = Math.max(256, Math.round(ar * 0.011));
  const N = W + tauMax;
  let pw = 1; while (pw < 4 * N) pw <<= 1;
  const DSIZE = pw, DMASK = DSIZE - 1;
  let pf = 1; while (pf < (N + 8) * D + 64) pf <<= 1;
  const FSIZE = pf, FMASK = FSIZE - 1;
  const decBuf = new Float32Array(DSIZE);
  const full = new Float32Array(FSIZE);
  const frame = new Float32Array(N + 2);
  const d = new Float32Array(tauMax + 2);
  const fine = new Float64Array(4 * D + 8);
  // Passe-bas d'analyse (Butterworth ordre 2).
  const fc = Math.min(2500, 0.4 * ar);
  const w0 = 2 * Math.PI * fc / sr;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - alpha) / a0;

  let tauLo = tauMinAll, tauHi = tauMax;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let inCount = 0, decCount = 0, decPhase = 0;
  let level = 0, lastEstIn = 0;
  let prevDec = 0, prevRms = 0, unvoicedFrames = 99, pending = 0;

  const reset = () => {
    decBuf.fill(0); full.fill(0);
    x1 = x2 = y1 = y2 = 0;
    inCount = 0; decCount = 0; decPhase = 0;
    level = 0; lastEstIn = 0;
    prevDec = 0; prevRms = 0; unvoicedFrames = 99; pending = 0;
  };

  const push = (x: ArrayLike<number>, n?: number) => {
    const len = n === undefined ? x.length : n;
    for (let i = 0; i < len; i++) {
      const v = x[i];
      full[inCount & FMASK] = v;
      inCount++;
      let y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      if (y < 1e-15 && y > -1e-15) y = 0; // pas de dénormaux
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      if (++decPhase >= D) {
        decPhase = 0;
        decBuf[decCount & DMASK] = y;
        decCount++;
      }
    }
  };

  /** Dernier τ pour lequel d' est calculé (trame en cours). */
  let done = 0;
  /** Creux local de d' le plus profond dans [c − r, c + r] (borné à la plage), ou −1. */
  const dipNear = (c: number, r: number) => {
    const lo = Math.max(tauLo, Math.floor(c - r)), hi = Math.min(done - 1, Math.ceil(c + r));
    let best = -1;
    for (let t = lo; t <= hi; t++) if (t > 1 && d[t] <= d[t - 1] && d[t] <= d[t + 1] && (best < 0 || d[t] < d[best])) best = t;
    return best;
  };

  const NONE = (rms: number): PitchEstimate => ({ period: 0, f0: 0, midi: 0, confidence: 0, voiced: false, rms });

  const estimate = (): PitchEstimate => {
    if (decCount < N) return NONE(0);
    const start = decCount - N;
    for (let i = 0; i < N; i++) frame[i] = decBuf[(start + i) & DMASK];
    let energy = 0;
    for (let i = 0; i < W; i++) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / W);
    // Niveau récent de la voix : crête du RMS, retombée de 1,5 s.
    const dtIn = inCount - lastEstIn;
    lastEstIn = inCount;
    level = Math.max(rms, level * Math.exp(-dtIn / (1.5 * sr)));
    const gated = rms < GATE_ABS || (GATE_REL > 0 && rms < level * Math.pow(10, -GATE_REL / 20));
    if (gated) { unvoicedFrames++; return NONE(rms); }
    // YIN : différence cumulée normalisée.
    d[0] = 1;
    // d'(τ) n'est calculé que jusqu'où il sert (`ext`) : le premier creux sous le seuil,
    // descendu jusqu'à son fond ; plus loin seulement si la garde d'octave ou le repli le demandent.
    let running = 0;
    done = 0;
    const ext = (upTo: number) => {
      const lim = Math.min(tauHi, upTo);
      for (let tau = done + 1; tau <= lim; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const x = frame[j] - frame[j + tau]; s += x * x; }
        running += s;
        d[tau] = running > 0 ? s * tau / running : 1;
      }
      if (lim > done) done = lim;
    };
    let cand = -1, last = tauHi;
    for (let tau = 1; tau <= tauHi; tau++) {
      ext(tau);
      if (tau < tauLo) continue;
      if (cand < 0) { if (d[tau] < THR) cand = tau; }
      else if (d[tau] < d[cand]) cand = tau;
      else { last = tau; break; }
    }
    if (cand < 0) {
      // Pas de creux net : minimum global s'il reste crédible.
      let best = tauLo;
      for (let tau = tauLo; tau <= tauHi; tau++) if (d[tau] < d[best]) best = tau;
      // Voix rauque / éraillée : creux moins net, accepté jusqu'à 0,4 s'il prolonge la note de la
      // trame précédente (à moins d'un demi-ton) ; le bruit, lui, ne tient pas une hauteur.
      const keeps = !legacy && prevDec > 0 && unvoicedFrames <= 2 && Math.abs(Math.log2(best / prevDec)) < 0.042;
      if (d[best] > (keeps ? Math.max(FALLBACK, 0.4) : FALLBACK)) { unvoicedFrames++; return NONE(rms); }
      cand = best;
      last = tauHi;
    }
    // Garde d'octave : saut ≥ ~10 demi-tons depuis la trame voisée précédente (≤ 3 trames plus tôt).
    if (GUARD && prevDec > 0 && unvoicedFrames <= 3) {
      const jump = Math.abs(Math.log2(cand / prevDec));
      // Fin de note : la voix s'arrête et seule une résonance (formant, salle) sonne encore,
      // loin de la note chantée et nettement plus faible : ce n'est pas une note.
      if (jump > 1 && rms < 0.5 * prevRms) { unvoicedFrames++; prevRms = rms; return NONE(rms); }
      if (jump > 0.8 && pending < 6) {
        ext(Math.ceil(prevDec * 1.19) + 2);
        const alt = dipNear(prevDec, prevDec * 0.19);
        if (alt > 0 && d[alt] < Math.max(0.35, d[cand] + 0.1)) { cand = alt; last = done; pending++; }
        else pending = 0;
      } else pending = 0;
    } else pending = 0;
    let tauF = cand;
    if (cand > 1 && cand < last) {
      const a = d[cand - 1], b = d[cand], c = d[cand + 1];
      const den = a - 2 * b + c;
      if (den > 1e-12) tauF = cand + Math.max(-1, Math.min(1, 0.5 * (a - c) / den));
    }
    let period = tauF * D;
    if (REFINE) {
      // Affinage à pleine résolution sur la même trame (signal non filtré).
      const f0i = start * D - 2 * D;
      const Wf = W * D;
      const lo = Math.max(2, Math.floor(period) - D), hi = Math.min(tauMax * D + D, Math.ceil(period) + D);
      let best = -1, bestV = Infinity;
      for (let tau = lo; tau <= hi; tau++) {
        let s = 0;
        for (let j = 0; j < Wf; j++) { const x = full[(f0i + j) & FMASK] - full[(f0i + j + tau) & FMASK]; s += x * x; }
        fine[tau - lo] = s;
        if (s < bestV) { bestV = s; best = tau; }
      }
      if (best > lo && best < hi) {
        const a = fine[best - 1 - lo], b = fine[best - lo], c = fine[best + 1 - lo];
        const den = a - 2 * b + c;
        period = best + (den > 1e-20 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0);
      }
    }
    prevDec = period / D;
    prevRms = rms;
    unvoicedFrames = 0;
    const f0 = sr / period;
    return { period, f0, midi: 69 + 12 * Math.log2(f0 / 440), confidence: Math.max(0, Math.min(1, 1 - d[cand])), voiced: true, rms };
  };

  const setRange = (fLo: number, fHi: number) => {
    const lo = Math.max(F_MIN, Math.min(fLo || F_MIN, F_MAX));
    const hi = Math.max(lo * 1.5, Math.min(fHi || F_MAX, F_MAX));
    tauLo = Math.max(tauMinAll, Math.floor(ar / hi));
    tauHi = Math.min(tauMax, Math.ceil(ar / lo));
  };

  return {
    push,
    estimate,
    center: () => (decCount - N / 2) * D,
    frameLength: () => N * D,
    count: () => inCount,
    setRange,
    reset,
  };
}

/** Trame d'une analyse hors ligne. */
export interface PitchFrame extends PitchEstimate {
  /** Centre de la trame (s, depuis le début du tampon). */
  time: number;
}

export interface PitchTrackOptions extends PitchDetectorOptions {
  /** Pas d'analyse en échantillons (défaut : 256, soit 5,3 ms à 48 kHz). */
  hop?: number;
  /** Médiane sur 3 trames voisées (supprime les sauts isolés, comme Nova Tune). Défaut vrai. */
  median?: boolean;
  /** Plage de recherche (type de voix), Hz. */
  range?: [number, number];
  /** Avancement 0–1 (analyse longue dans un worker : barre de progression). Appelé ~50 fois. */
  onProgress?: (p: number) => void;
}

/**
 * Courbe de hauteur d'un tampon mono (hors ligne) : une trame tous les `hop` échantillons,
 * même analyse que Nova Tune. Pour l'éditeur de notes : `midi` à 0,01 demi-ton près sur voix
 * tenue (voir tests/pitchDetect.test.ts), `confidence` pour pondérer, `voiced` pour découper.
 */
export function detectPitchTrack(x: Float32Array, sampleRate: number, opts: PitchTrackOptions = {}): PitchFrame[] {
  const det = createPitchDetector(sampleRate, opts);
  if (opts.range) det.setRange(opts.range[0], opts.range[1]);
  const hop = Math.max(16, Math.round(opts.hop || 256));
  const out: PitchFrame[] = [];
  // Le tampon est prolongé d'une demi-trame de silence : la dernière trame couvre la fin.
  const tail = Math.ceil(det.frameLength() / 2);
  const total = x.length + tail;
  const zeros = new Float32Array(hop);
  const every = Math.max(hop, Math.floor(total / 50 / hop) * hop);
  for (let a = 0; a < total; a += hop) {
    if (opts.onProgress && a % every === 0) opts.onProgress(a / total);
    const n = Math.min(hop, total - a);
    if (a + n <= x.length) det.push(x.subarray(a, a + n));
    else if (a >= x.length) det.push(zeros, n);
    else { det.push(x.subarray(a)); det.push(zeros, a + n - x.length); }
    const c = det.center();
    if (c < 0) continue;
    const e = det.estimate();
    if (c / sampleRate > x.length / sampleRate) break;
    out.push({ ...e, time: c / sampleRate });
  }
  if (opts.median !== false) {
    // Médiane sur 3 trames voisées consécutives (la trame du milieu).
    const per = out.map(f => f.period);
    for (let i = 1; i + 1 < out.length; i++) {
      const a = per[i - 1], b = per[i], c = per[i + 1];
      if (!(a > 0 && b > 0 && c > 0)) continue;
      const m = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
      if (m !== b) {
        const f0 = sampleRate / m;
        out[i] = { ...out[i], period: m, f0, midi: 69 + 12 * Math.log2(f0 / 440) };
      }
    }
  }
  return out;
}
