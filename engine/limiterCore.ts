/**
 * Cœur DSP du limiteur / maximiseur NOVA (V15), en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet (la fonction est sérialisée par
 * `toString()` : elle ne doit RIEN référencer en dehors d'elle-même) et dans
 * les tests vitest.
 *
 * Principe (limiteur « brickwall » à anticipation, crête vraie) :
 *  1. gain d'entrée ;
 *  2. estimation de la crête vraie entre chaque paire d'échantillons par
 *     suréchantillonnage polyphasé (sinus cardinal fenêtré, 32 coefficients
 *     par phase) : on voit les crêtes inter-échantillons que mesurent les
 *     plateformes (ITU-R BS.1770, dBTP) ;
 *  3. gain requis q[m] = plafond / crête, valable pour les deux échantillons
 *     qui encadrent l'intervalle ;
 *  4. minimum glissant sur la fenêtre d'anticipation L, relâchement
 *     exponentiel (le gain ne remonte jamais plus vite que demandé), puis
 *     moyenne glissante sur L : la courbe de gain est lisse ET, à l'instant de
 *     chaque crête, inférieure ou égale au gain requis (moyenne de valeurs qui
 *     le sont toutes) ;
 *  5. le signal est retardé d'exactement `latencySamples()` échantillons
 *     (latence déclarée au PDC), multiplié par le gain, puis écrêté au
 *     plafond par sécurité (jamais atteint en pratique).
 */

export interface LimiterCoreParams {
  /** Plafond en dB (crête vraie si oversample > 1). */
  ceilingDb: number;
  /** Gain d'entrée en dB (pousse le niveau dans le limiteur). */
  inputGainDb: number;
  /** Relâchement en ms. */
  releaseMs: number;
  /** Anticipation en ms (0,5 à 10). */
  lookaheadMs: number;
  /** Suréchantillonnage de la détection : 1 (crête échantillon), 2, 4 (crête vraie) ou 8. */
  oversample: number;
}

export interface LimiterCore {
  setParams(p: Partial<LimiterCoreParams>): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  latencySamples(): number;
  /** Mesures depuis le dernier appel : réduction de gain max (dB, ≥ 0), crête de sortie (dB). */
  takeMeters(): { grDb: number; outPeakDb: number; inPeakDb: number };
  reset(): void;
}

export function createLimiterCore(sampleRate: number): LimiterCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var TAPS = 32; // coefficients par phase
  var HALF = TAPS / 2; // retard de la détection (échantillons)
  var MAX_LA = Math.ceil(0.0105 * SR) + 2; // anticipation max (10 ms) + marge

  var p: LimiterCoreParams = { ceilingDb: -1, inputGainDb: 0, releaseMs: 100, lookaheadMs: 3, oversample: 4 };

  // --- Filtres polyphasés de suréchantillonnage, par facteur ---
  var phaseCache: { [os: number]: Float64Array[] } = {};
  function besselI0(x: number) {
    var sum = 1, term = 1, k = 1;
    while (term > 1e-12 * sum && k < 200) { var h = x / (2 * k); term *= h * h; sum += term; k++; }
    return sum;
  }
  function phases(os: number): Float64Array[] {
    if (phaseCache[os]) return phaseCache[os];
    var out: Float64Array[] = [];
    var beta = 8.6;
    var i0b = besselI0(beta);
    for (var k = 1; k < os; k++) {
      var frac = k / os;
      var h = new Float64Array(TAPS);
      var sum = 0;
      for (var j = 0; j < TAPS; j++) {
        // échantillon x[m + j - HALF + 1], position relative au point interpolé
        var t = (j - HALF + 1) - frac;
        var sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        var r = t / (HALF + 0.5);
        var w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
        h[j] = sinc * w;
        sum += h[j];
      }
      for (var j2 = 0; j2 < TAPS; j2++) h[j2] /= sum;
      out.push(h);
    }
    phaseCache[os] = out;
    return out;
  }

  // --- États ---
  var histL = new Float64Array(TAPS), histR = new Float64Array(TAPS), hpos = 0; // dernières entrées (après gain)
  // File du minimum glissant (valeurs + indices), anneau de taille MAX_LA + 1
  var DQ = MAX_LA + TAPS + 8;
  var dqVal = new Float64Array(DQ), dqIdx = new Float64Array(DQ), dqHead = 0, dqLen = 0;
  // Moyenne glissante des gains
  var boxBuf = new Float64Array(MAX_LA + 2), boxPos = 0, boxSum = 0;
  var relGain = 1;
  // Retard du signal
  var DL = MAX_LA + TAPS + 8;
  var dlL = new Float64Array(DL), dlR = new Float64Array(DL), dlPos = 0;
  var counter = 0; // index de l'échantillon d'entrée (pour le minimum glissant)
  var inGain = 1, inGainTarget = 1, gainSmooth = 1 - Math.exp(-1 / (0.01 * SR));
  var L = 1, relCoef = 0, ceilLin = 1, detLin = 1, os = 4, ph: Float64Array[] = [];
  var mGr = 1, mOut = 0, mIn = 0;

  function derive() {
    var la = Math.max(0.5, Math.min(10, +p.lookaheadMs || 3));
    var newL = Math.max(1, Math.min(MAX_LA, Math.round(la * SR / 1000)));
    if (newL !== L) {
      L = newL;
      // La moyenne repart sur L valeurs au gain courant (pas de saut).
      for (var i = 0; i < boxBuf.length; i++) boxBuf[i] = relGain;
      boxSum = relGain * L; boxPos = 0;
    }
    var rel = Math.max(1, Math.min(2000, +p.releaseMs || 100));
    relCoef = 1 - Math.exp(-1 / (rel * 0.001 * SR));
    ceilLin = Math.pow(10, Math.max(-24, Math.min(0, +p.ceilingDb)) / 20);
    var o = Math.round(+p.oversample || 4);
    os = o >= 8 ? 8 : o >= 4 ? 4 : o >= 2 ? 2 : 1;
    ph = os > 1 ? phases(os) : [];
    // Marge interne : les crêtes situées ENTRE deux points suréchantillonnés
    // (très aigus) dépassent l'estimation d'au plus quelques centièmes de dB.
    detLin = ceilLin * (os >= 8 ? 0.9977 : os >= 4 ? 0.9886 : os >= 2 ? 0.9441 : 1);
    inGainTarget = Math.pow(10, Math.max(-24, Math.min(36, +p.inputGainDb || 0)) / 20);
  }

  function reset() {
    histL.fill(0); histR.fill(0); hpos = 0;
    dqHead = 0; dqLen = 0;
    relGain = 1; for (var i = 0; i < boxBuf.length; i++) boxBuf[i] = 1; boxSum = L; boxPos = 0;
    dlL.fill(0); dlR.fill(0); dlPos = 0; counter = 0;
    inGain = inGainTarget;
  }

  derive();
  inGain = inGainTarget;
  reset();

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number) {
    var right = inR || inL;
    for (var i = 0; i < n; i++) {
      inGain += (inGainTarget - inGain) * gainSmooth;
      var xl = inL[i] * inGain, xr = right[i] * inGain;
      var ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      if (ax > mIn) mIn = ax;

      // 1. Historique pour l'interpolation ; m = n - HALF (échantillon au centre).
      histL[hpos] = xl; histR[hpos] = xr;
      hpos = (hpos + 1) % TAPS;
      // histX[(hpos + j) % TAPS] = x[n - TAPS + 1 + j]  → x[m + j - HALF + 1] avec m = n - HALF
      var cL = histL[(hpos + HALF - 1) % TAPS], cR = histR[(hpos + HALF - 1) % TAPS];
      var tp = Math.max(cL < 0 ? -cL : cL, cR < 0 ? -cR : cR);
      for (var k = 0; k < ph.length; k++) {
        var h = ph[k], sl = 0, sr = 0;
        for (var j = 0; j < TAPS; j++) { var idx = (hpos + j) % TAPS; sl += h[j] * histL[idx]; sr += h[j] * histR[idx]; }
        if (sl < 0) sl = -sl; if (sr < 0) sr = -sr;
        if (sl > tp) tp = sl; if (sr > tp) tp = sr;
      }
      // 2. Gain requis pour l'intervalle [m, m+1].
      var req = tp > detLin ? detLin / tp : 1;

      // 3. Minimum glissant de req sur [k - HALF - 1, k + L - 1 + HALF] (file monotone) :
      //    autour de chaque crête, la courbe de gain est PLATE sur toute la
      //    longueur du filtre d'interpolation, donc la crête vraie du signal
      //    limité vaut exactement gain × crête vraie de l'entrée.
      while (dqLen > 0 && dqVal[(dqHead + dqLen - 1) % DQ] >= req) dqLen--;
      var tail = (dqHead + dqLen) % DQ;
      dqVal[tail] = req; dqIdx[tail] = counter; dqLen++;
      var W = L + 2 * HALF + 1;
      while (dqLen > 0 && dqIdx[dqHead] <= counter - W) { dqHead = (dqHead + 1) % DQ; dqLen--; }
      var held = dqVal[dqHead];
      counter++;

      // 4. Relâchement (le gain remonte doucement, jamais au-dessus du minimum).
      var up = relGain + (1 - relGain) * relCoef;
      relGain = held < up ? held : up;

      // 5. Moyenne glissante sur L.
      boxSum += relGain - boxBuf[boxPos];
      boxBuf[boxPos] = relGain;
      boxPos++; if (boxPos >= L) boxPos = 0;
      var g = boxSum / L;
      if (g > 1) g = 1;

      // 6. Signal retardé : x[k] avec k = m - (L - 1 + HALF), m = n - HALF → retard 2·HALF + L - 1.
      dlL[dlPos] = cL; dlR[dlPos] = cR;
      var rd = (dlPos - (L - 1 + HALF) + DL) % DL;
      dlPos = (dlPos + 1) % DL;
      var yl = dlL[rd] * g, yr = dlR[rd] * g;
      // Sécurité : écrêtage au plafond (inaudible, ne sert qu'aux arrondis).
      if (yl > ceilLin) yl = ceilLin; else if (yl < -ceilLin) yl = -ceilLin;
      if (yr > ceilLin) yr = ceilLin; else if (yr < -ceilLin) yr = -ceilLin;
      outL[i] = yl;
      if (outR) outR[i] = yr;
      if (g < mGr) mGr = g;
      var ay = Math.max(yl < 0 ? -yl : yl, yr < 0 ? -yr : yr);
      if (ay > mOut) mOut = ay;
    }
  }

  return {
    setParams: function (np: Partial<LimiterCoreParams>) {
      for (var key in np) { if ((np as any)[key] !== undefined && (np as any)[key] !== null) (p as any)[key] = (np as any)[key]; }
      derive();
    },
    process: process,
    // Détection centrée HALF échantillons en arrière, puis anticipation L - 1 + HALF.
    latencySamples: function () { return 2 * HALF + L - 1; },
    takeMeters: function () {
      var r = { grDb: -20 * Math.log10(Math.max(1e-6, mGr)), outPeakDb: 20 * Math.log10(Math.max(1e-9, mOut)), inPeakDb: 20 * Math.log10(Math.max(1e-9, mIn)) };
      mGr = 1; mOut = 0; mIn = 0;
      return r;
    },
    reset: reset,
  };
}

/** Latence (échantillons) pour des réglages donnés, sans créer de noyau (PDC). */
export function limiterLatencySamples(sampleRate: number, lookaheadMs: number): number {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var MAX_LA = Math.ceil(0.0105 * SR) + 2;
  var la = Math.max(0.5, Math.min(10, +lookaheadMs || 3));
  var L = Math.max(1, Math.min(MAX_LA, Math.round(la * SR / 1000)));
  return 32 + L - 1;
}
