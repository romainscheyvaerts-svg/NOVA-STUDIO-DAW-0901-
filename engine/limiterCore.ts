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
 *
 * Plafond automatisé : le plafond de sécurité voyage dans la ligne à retard
 * avec le signal. Chaque échantillon de sortie est donc écrêté au plafond
 * qui a servi à calculer SON gain (celui en vigueur quand il a été analysé),
 * pas au plafond du moment de sa sortie : une baisse du plafond n'écrête plus
 * brutalement les ~3 ms déjà en attente, et la crête vraie de chaque
 * intervalle reste sous le plafond qui lui a été appliqué.
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
  /**
   * Loi statique à coude doux (optionnelle) : réduction (dB) selon le dépassement du plafond (dB,
   * crête détectée / plafond). Absente : limiteur « brickwall » (réduction = dépassement).
   */
  kneeOverDb?: number[];
  kneeGrDb?: number[];
  /** Lissage de la rampe d'attaque (ms, ≤ anticipation ; absent = anticipation). */
  attackMs?: number;
  /** Maintien avant relâchement (ms, 0 par défaut). */
  holdMs?: number;
  /**
   * Anticipation EFFECTIVE de la détection (ms, ≤ anticipation) : la latence reste celle de
   * `lookaheadMs` (PDC constant) ; la réduction ne commence que `detLookMs` avant la crête.
   */
  detLookMs?: number;
  /** Avec le coude doux : relâchement exponentiel en dB (vrai) ou en gain linéaire, vers la demande en cours. */
  releaseDb?: boolean;
  /** Part de la réduction appliquée (0..1, 1 par défaut) : le reste est confié aux bandes (gain adaptatif). */
  grScale?: number;
  /** Avec grScale : seule la part LENTE de la réduction (moyenne sur grSlowMs, en dB) est rendue ; les crêtes restent tenues. */
  grSlowMs?: number;
}

export interface LimiterCore {
  setParams(p: Partial<LimiterCoreParams>): void;
  /** Multiplie le temps de relâchement (sans recalculer le reste) : vitesse adaptative selon le programme. */
  setReleaseScale?(k: number): void;
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
  // dernières entrées (après gain), écrites deux fois (hpos et hpos + TAPS) : lecture contiguë sans modulo
  var histL = new Float64Array(2 * TAPS), histR = new Float64Array(2 * TAPS), hpos = 0;
  // File du minimum glissant (valeurs + indices), anneau de taille MAX_LA + 1
  var DQ = MAX_LA + TAPS + 8;
  var dqVal = new Float64Array(DQ), dqIdx = new Float64Array(DQ), dqLn = new Float64Array(DQ), dqHead = 0, dqLen = 0;
  // Moyenne glissante des gains
  var boxBuf = new Float64Array(MAX_LA + 2), boxPos = 0, boxSum = 0;
  var relGain = 1, lnRel = 0, lnMode = false;
  // Retard du signal
  var DL = MAX_LA + TAPS + 8;
  var dlL = new Float64Array(DL), dlR = new Float64Array(DL), dlPos = 0;
  var dlC = new Float64Array(DL); // plafond en vigueur à l'analyse de chaque échantillon
  var counter = 0; // index de l'échantillon d'entrée (pour le minimum glissant)
  var inGain = 1, inGainTarget = 1, gainSmooth = 1 - Math.exp(-1 / (0.01 * SR));
  var L = 1, LA = 1, relCoef = 0, ceilLin = 1, detLin = 1, os = 4, ph: Float64Array[] = [];
  var kOver: number[] | null = null, kGr: number[] | null = null, holdN = 0, age = 0;
  var relMs = 100, relScale = 1;
  var LE = 1, reqBuf = new Float64Array(MAX_LA + 4), reqLnBuf = new Float64Array(MAX_LA + 4), reqPos = 0, grS = 1, cSlow = 0, slowGr = 0;
  // coude tabulé (pas de 0,02 dB) : gain et ln(gain) sans exponentielle par échantillon
  var KSTEP = 0.02, kO0 = 0, kTpMin = 0, kG = new Float64Array(1), kLn = new Float64Array(1);
  var mGr = 1, mOut = 0, mIn = 0;

  function derive() {
    var la = Math.max(0.5, Math.min(10, +p.lookaheadMs || 3));
    LA = Math.max(1, Math.min(MAX_LA, Math.round(la * SR / 1000)));
    var le = +(p.detLookMs as number) > 0 ? Math.min(la, +(p.detLookMs as number)) : la;
    LE = Math.max(1, Math.min(LA, Math.round(le * SR / 1000)));
    var am = +(p.attackMs as number) > 0 ? Math.min(le, +(p.attackMs as number)) : le;
    var newL = Math.max(1, Math.min(LE, Math.round(am * SR / 1000)));
    kOver = p.kneeOverDb && p.kneeGrDb && p.kneeOverDb.length >= 2 && p.kneeOverDb.length === p.kneeGrDb.length ? p.kneeOverDb : null;
    kGr = kOver ? (p.kneeGrDb as number[]) : null;
    var lnPrev = lnMode, lnPrevVal = lnRel;
    lnMode = !!(kOver && p.releaseDb);
    if (lnMode !== lnPrev) { lnRel = lnMode ? Math.log(relGain > 1e-9 ? relGain : 1e-9) : 0; if (!lnMode) relGain = Math.exp(lnPrevVal); L = -1; }
    if (kOver && kGr) {
      var nk0 = kOver.length, nt = Math.max(2, Math.ceil((kOver[nk0 - 1] - kOver[0]) / KSTEP) + 1);
      kO0 = kOver[0];
      kG = new Float64Array(nt); kLn = new Float64Array(nt);
      for (var it = 0, jt = 1; it < nt; it++) {
        var ovt = kO0 + it * KSTEP;
        while (jt < nk0 - 1 && kOver[jt] < ovt) jt++;
        var grt = ovt >= kOver[nk0 - 1] ? kGr[nk0 - 1] + (ovt - kOver[nk0 - 1]) : kGr[jt - 1] + (kGr[jt] - kGr[jt - 1]) * (ovt - kOver[jt - 1]) / (kOver[jt] - kOver[jt - 1]);
        kLn[it] = -0.11512925464970229 * grt; kG[it] = Math.exp(kLn[it]);
      }
    }
    holdN = Math.max(0, Math.round((+(p.holdMs as number) || 0) * SR / 1000));
    grS = p.grScale !== undefined && +p.grScale >= 0 && +p.grScale < 1 ? +p.grScale : 1;
    cSlow = +(p.grSlowMs as number) > 0 ? 1 - Math.exp(-1 / (+(p.grSlowMs as number) * 0.001 * SR)) : 0;
    if (newL !== L) {
      L = newL;
      // La moyenne repart sur L valeurs au gain courant (pas de saut).
      var bv = lnMode ? lnRel : relGain;
      for (var i = 0; i < boxBuf.length; i++) boxBuf[i] = bv;
      boxSum = bv * L; boxPos = 0;
    }
    // avec le coude doux (gain qui suit l'onde, mesuré sur l'original), le relâchement descend sous la milliseconde
    var rel = Math.max(p.kneeOverDb && p.kneeOverDb.length >= 2 ? 0.02 : 1, Math.min(2000, +p.releaseMs || 100));
    relMs = rel;
    relCoef = 1 - Math.exp(-1 / (rel * relScale * 0.001 * SR));
    ceilLin = Math.pow(10, Math.max(-24, Math.min(0, +p.ceilingDb)) / 20);
    kTpMin = kOver ? ceilLin * Math.pow(10, kO0 / 20) : 0;
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
    relGain = 1; age = 0; for (var i = 0; i < boxBuf.length; i++) boxBuf[i] = lnMode ? 0 : 1; boxSum = lnMode ? 0 : L; boxPos = 0;
    reqBuf.fill(1); reqLnBuf.fill(0); reqPos = 0; slowGr = 0; lnRel = 0;
    dlL.fill(0); dlR.fill(0); dlC.fill(ceilLin); dlPos = 0; counter = 0;
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
      histL[hpos] = xl; histR[hpos] = xr; histL[hpos + TAPS] = xl; histR[hpos + TAPS] = xr;
      hpos = (hpos + 1) % TAPS;
      // histX[(hpos + j) % TAPS] = x[n - TAPS + 1 + j]  → x[m + j - HALF + 1] avec m = n - HALF
      var cL = histL[hpos + HALF - 1], cR = histR[hpos + HALF - 1];
      var tp = Math.max(cL < 0 ? -cL : cL, cR < 0 ? -cR : cR);
      for (var k = 0; k < ph.length; k++) {
        var h = ph[k], sl = 0, sr = 0;
        for (var j = 0; j < TAPS; j++) { var idx = hpos + j; sl += h[j] * histL[idx]; sr += h[j] * histR[idx]; }
        if (sl < 0) sl = -sl; if (sr < 0) sr = -sr;
        if (sl > tp) tp = sl; if (sr > tp) tp = sr;
      }
      // 2. Gain requis pour l'intervalle [m, m+1].
      var req = tp > detLin ? detLin / tp : 1, lnReq = 0;
      if (kOver && kGr) {
        // coude doux mesuré : réduction selon le dépassement du plafond (jamais moins que le brickwall)
        if (tp > kTpMin) {
          var ov = 8.685889638065035 * Math.log(tp / ceilLin), fk = (ov - kO0) / KSTEP, kg: number, kl: number;
          var nt2 = kG.length;
          if (fk >= nt2 - 1) { kl = kLn[nt2 - 1] - 0.11512925464970229 * (ov - (kO0 + (nt2 - 1) * KSTEP)); kg = Math.exp(kl); }
          else { var ik = fk > 0 ? Math.floor(fk) : 0, tk = fk > 0 ? fk - ik : 0; kg = kG[ik] + (kG[ik + 1] - kG[ik]) * tk; kl = kLn[ik] + (kLn[ik + 1] - kLn[ik]) * tk; }
          if (kg < req) { req = kg; lnReq = kl; } else if (req < 1) lnReq = Math.log(req);
        } else if (req < 1) lnReq = Math.log(req);
      }

      // 3. Minimum glissant de req sur [k - HALF - 1, k + L - 1 + HALF] (file monotone) :
      //    autour de chaque crête, la courbe de gain est PLATE sur toute la
      //    longueur du filtre d'interpolation, donc la crête vraie du signal
      //    limité vaut exactement gain × crête vraie de l'entrée.
      if (LE < LA) {
        // anticipation effective plus courte : la demande est retardée de LA − LE (latence inchangée)
        var RB = reqBuf.length;
        reqBuf[reqPos] = req; reqLnBuf[reqPos] = lnReq;
        var rdp = (reqPos - (LA - LE) + RB) % RB;
        req = reqBuf[rdp]; lnReq = reqLnBuf[rdp];
        reqPos = (reqPos + 1) % RB;
      }
      while (dqLen > 0 && dqVal[(dqHead + dqLen - 1) % DQ] >= req) dqLen--;
      var tail = (dqHead + dqLen) % DQ;
      dqVal[tail] = req; dqLn[tail] = lnReq; dqIdx[tail] = counter; dqLen++;
      var W = LE + 2 * HALF + 1;
      while (dqLen > 0 && dqIdx[dqHead] <= counter - W) { dqHead = (dqHead + 1) % DQ; dqLen--; }
      var held = dqVal[dqHead], heldLn = dqLn[dqHead];
      counter++;

      // 4. Relâchement (le gain remonte doucement, jamais au-dessus du minimum).
      var g: number;
      if (lnMode) {
        // coude doux + relâchement en dB : tout en ln(gain) (une seule exponentielle par échantillon)
        if (heldLn < lnRel) { lnRel = heldLn; age = 0; }
        else if (age < holdN) age++;
        else lnRel += (heldLn - lnRel) * relCoef;
        // 5. Moyenne glissante sur L (des ln : rampe d'attaque géométrique, toujours ≤ la demande à la crête)
        boxSum += lnRel - boxBuf[boxPos];
        boxBuf[boxPos] = lnRel;
        boxPos++; if (boxPos >= L) boxPos = 0;
        var gln = boxSum / L;
        if (gln > 0) gln = 0;
        if (grS !== 1) {
          var grl = -gln;
          if (cSlow > 0) {
            slowGr += (grl - slowGr) * cSlow;
            grl -= (1 - grS) * (slowGr < grl ? slowGr : grl);
          } else grl *= grS;
          gln = -grl;
        }
        g = gln < 0 ? Math.exp(gln) : 1;
      } else {
        if (held < relGain) { relGain = held; age = 0; }
        else if (age < holdN) age++;
        else if (kOver) relGain += (held - relGain) * relCoef; // coude doux : retour vers la demande EN COURS
        else { var up = relGain + (1 - relGain) * relCoef; relGain = held < up ? held : up; }
        // 5. Moyenne glissante sur L.
        boxSum += relGain - boxBuf[boxPos];
        boxBuf[boxPos] = relGain;
        boxPos++; if (boxPos >= L) boxPos = 0;
        g = boxSum / L;
        if (g > 1) g = 1;
        if (grS !== 1) {
          var grd = g < 1 ? -Math.log(g) : 0;
          if (cSlow > 0) {
            slowGr += (grd - slowGr) * cSlow;
            var sl = slowGr < grd ? slowGr : grd;
            grd -= (1 - grS) * sl;
          } else grd *= grS;
          g = Math.exp(-grd);
        }
      }

      // 6. Signal retardé : x[k] avec k = m - (L - 1 + HALF), m = n - HALF → retard 2·HALF + L - 1.
      dlL[dlPos] = cL; dlR[dlPos] = cR; dlC[dlPos] = ceilLin;
      var rd = (dlPos - (LA - 1 + HALF) + DL) % DL;
      dlPos = (dlPos + 1) % DL;
      var yl = dlL[rd] * g, yr = dlR[rd] * g, cl = dlC[rd];
      // Sécurité : écrêtage au plafond de CET échantillon (inaudible, ne sert qu'aux arrondis).
      if (yl > cl) yl = cl; else if (yl < -cl) yl = -cl;
      if (yr > cl) yr = cl; else if (yr < -cl) yr = -cl;
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
    setReleaseScale: function (k: number) {
      var kk = k > 0.01 ? (k < 100 ? k : 100) : 0.01;
      if (kk === relScale) return;
      relScale = kk;
      relCoef = 1 - Math.exp(-1 / (relMs * relScale * 0.001 * SR));
    },
    // Détection centrée HALF échantillons en arrière, puis anticipation L - 1 + HALF.
    latencySamples: function () { return 2 * HALF + LA - 1; },
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
