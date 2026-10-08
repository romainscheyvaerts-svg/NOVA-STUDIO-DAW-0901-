/**
 * Cœur de mesure des vumètres NOVA (R11), en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet des mètres (la fonction est
 * sérialisée par `toString()` : elle ne doit RIEN référencer en dehors
 * d'elle-même) et dans les tests vitest.
 *
 * Par point de mesure (piste, bus, master), gauche et droite SÉPARÉS :
 *  - crête échantillon ;
 *  - crête vraie (ITU-R BS.1770-4, annexe 2) : suréchantillonnage ×4 par
 *    filtre polyphasé (sinus cardinal, fenêtre de Kaiser) entre chaque paire
 *    d'échantillons ;
 *  - énergie (somme des carrés) pour le RMS / VU / K-System ;
 *  - sommes L·R, L², R² pour la corrélation de phase ;
 *  - (master) énergie pondérée K (filtre en plateau + passe-haut RLB,
 *    BS.1770-4) par sous-blocs de 100 ms : le LUFS momentané (400 ms), court
 *    terme (3 s), intégré (portillons) et le LRA se calculent dessus
 *    (engine/meters/loudness.ts) ;
 *  - (master) points décimés pour le goniomètre.
 *
 * Coût : la crête vraie est la seule partie lourde (3 phases × TAPS produits
 * par échantillon et par canal). Sur les pistes (`tpGate`), l'interpolation
 * n'est calculée qu'entre deux échantillons dont le plus fort est à moins de
 * 6 dB de la crête vraie déjà trouvée dans la période : un dépassement
 * inter-échantillons de plus de 6 dB n'existe pas en musique (le pire cas
 * classique, un sinus à fs/4 déphasé de 45°, dépasse de 3 dB). Le master,
 * lui, calcule toujours tout.
 */

export interface MeterCoreOptions {
  /** Énergie pondérée K par sous-blocs de 100 ms (LUFS). */
  loudness?: boolean;
  /** Points du goniomètre (paires L, R décimées). */
  gonio?: boolean;
  /** Coefficients par phase du filtre de crête vraie (8 sur les pistes, 16 sur le master). */
  tpTaps?: number;
  /** Saute l'interpolation loin de la crête courante (voir l'en-tête). */
  tpGate?: boolean;
}

export interface MeterTake {
  /** Échantillons mesurés depuis la dernière lecture. */
  n: number;
  /** Crête échantillon (linéaire) gauche, droite. */
  peakL: number; peakR: number;
  /** Crête vraie (linéaire, ≥ crête échantillon). */
  tpL: number; tpR: number;
  /** Sommes des carrés (RMS = sqrt(sum / n)). */
  sumL: number; sumR: number;
  /** Somme des produits L·R (corrélation = lr / sqrt(sumL · sumR)). */
  lr: number;
  /** Énergies des sous-blocs de 100 ms terminés (Σ canaux de la moyenne des carrés pondérés K). */
  k: number[];
  /** Goniomètre : L0, R0, L1, R1… */
  gonio: number[];
  /** Faux : source mono (droite = gauche). */
  stereo: boolean;
}

export interface MeterCore {
  /** R peut être null (mono : la droite recopie la gauche, c'est le seul cas). */
  process(L: Float32Array, R: Float32Array | null, n: number): void;
  take(): MeterTake;
  reset(): void;
}

export function createMeterCore(sampleRate: number, options?: MeterCoreOptions): MeterCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var opt = options || {};
  var LOUD = !!opt.loudness;
  var GONIO = !!opt.gonio;
  var GATE = !!opt.tpGate;
  var TAPS = Math.max(4, Math.min(32, Math.round(opt.tpTaps || 12)));
  if (TAPS % 2) TAPS++;
  var HALF = TAPS / 2;

  // --- Filtres polyphasés (phases 1/4, 2/4, 3/4 ; la phase 0 est l'échantillon) ---
  function besselI0(x: number) {
    var sum = 1, term = 1, k = 1;
    while (term > 1e-12 * sum && k < 200) { var h = x / (2 * k); term *= h * h; sum += term; k++; }
    return sum;
  }
  var COEF = new Float64Array(3 * TAPS);
  (function () {
    var beta = 7.0, i0b = besselI0(beta);
    for (var ph = 1; ph < 4; ph++) {
      var frac = ph / 4, s = 0;
      for (var j = 0; j < TAPS; j++) {
        // Échantillon j de la fenêtre ; le point interpolé est entre HALF-1 et HALF.
        var t = (j - HALF + 1) - frac;
        var sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        var r = t / (HALF + 0.5);
        var w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
        COEF[(ph - 1) * TAPS + j] = sinc * w;
        s += sinc * w;
      }
      for (var j2 = 0; j2 < TAPS; j2++) COEF[(ph - 1) * TAPS + j2] /= s; // gain unité au continu
    }
  })();

  // --- Pondération K (mêmes formules que pyloudnorm / utils/loudness.ts) ---
  var shB0 = 0, shB1 = 0, shB2 = 0, shA1 = 0, shA2 = 0, hpB0 = 1, hpB1 = -2, hpB2 = 1, hpA1 = 0, hpA2 = 0;
  (function () {
    var G = 3.999843853973347, Q = 0.7071752369554196, f0 = 1681.974450955533;
    var K = Math.tan(Math.PI * f0 / SR);
    var Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    var a0 = 1 + K / Q + K * K;
    shB0 = (Vh + Vb * K / Q + K * K) / a0; shB1 = 2 * (K * K - Vh) / a0; shB2 = (Vh - Vb * K / Q + K * K) / a0;
    shA1 = 2 * (K * K - 1) / a0; shA2 = (1 - K / Q + K * K) / a0;
    var Q2 = 0.5003270373238773, f2 = 38.13547087602444;
    var K2 = Math.tan(Math.PI * f2 / SR);
    var a02 = 1 + K2 / Q2 + K2 * K2;
    hpA1 = 2 * (K2 * K2 - 1) / a02; hpA2 = (1 - K2 / Q2 + K2 * K2) / a02;
  })();
  var SUB = Math.max(1, Math.round(0.1 * SR)); // sous-bloc de 100 ms

  // --- États ---
  var hist = [new Float64Array(2 * TAPS), new Float64Array(2 * TAPS)];
  var hpos = [0, 0];
  // Filtre K : x1, x2, y1, y2 du plateau puis du passe-haut, par canal
  var kst = [new Float64Array(8), new Float64Array(8)];
  var kbuf = new Float64Array(128);
  var subAcc = 0, subN = 0;
  var gStep = 2, gCount = 0;

  var n = 0, peak = [0, 0], tp = [0, 0], sum = [0, 0], lr = 0, kOut: number[] = [], gOut: number[] = [], stereo = false;

  function channel(ch: number, X: Float32Array, len: number) {
    var h = hist[ch], p = hpos[ch];
    var pk = peak[ch], tpm = tp[ch], s = sum[ch];
    var c = COEF, T = TAPS, H = HALF, gate = GATE;
    for (var i = 0; i < len; i++) {
      var x = X[i];
      var ax = x < 0 ? -x : x;
      if (ax > pk) pk = ax;
      s += x * x;
      h[p] = x; h[p + T] = x;
      p++; if (p === T) p = 0;
      // Fenêtre h[p .. p+T-1] (la plus ancienne en p) ; intervalle entre H-1 et H.
      var a = h[p + H - 1], b = h[p + H];
      var aa = a < 0 ? -a : a, ab = b < 0 ? -b : b;
      var m = aa > ab ? aa : ab;
      if (m > tpm) tpm = m;
      if (m > 1e-7 && (!gate || m + m >= tpm)) {
        for (var ph = 0; ph < 3; ph++) {
          var o = ph * T, y = 0;
          for (var j = 0; j < T; j++) y += h[p + j] * c[o + j];
          if (y < 0) y = -y;
          if (y > tpm) tpm = y;
        }
      }
    }
    hpos[ch] = p; peak[ch] = pk; tp[ch] = tpm; sum[ch] = s;
  }

  function kweight(ch: number, X: Float32Array, len: number, add: boolean) {
    var st = kst[ch];
    var x1 = st[0], x2 = st[1], y1 = st[2], y2 = st[3], u1 = st[4], u2 = st[5], v1 = st[6], v2 = st[7];
    for (var i = 0; i < len; i++) {
      var x = X[i];
      var y = shB0 * x + shB1 * x1 + shB2 * x2 - shA1 * y1 - shA2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      var v = hpB0 * y + hpB1 * u1 + hpB2 * u2 - hpA1 * v1 - hpA2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      if (add) kbuf[i] += v * v; else kbuf[i] = v * v;
    }
    // Évite les dénormaux dans le silence
    if (Math.abs(y1) < 1e-20) { y1 = 0; y2 = 0; }
    if (Math.abs(v1) < 1e-20) { v1 = 0; v2 = 0; }
    st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2; st[4] = u1; st[5] = u2; st[6] = v1; st[7] = v2;
  }

  function process(L: Float32Array, R: Float32Array | null, len: number) {
    if (len <= 0) return;
    n += len;
    channel(0, L, len);
    if (R && R !== L) {
      stereo = true;
      channel(1, R, len);
      var acc = 0;
      for (var i = 0; i < len; i++) acc += L[i] * R[i];
      lr += acc;
    } else {
      // Mono : la droite est la gauche (pas de calcul en double).
      peak[1] = peak[0]; tp[1] = tp[0]; sum[1] = sum[0]; lr = sum[0];
      hpos[1] = hpos[0];
    }
    if (LOUD) {
      if (kbuf.length < len) kbuf = new Float64Array(len);
      kweight(0, L, len, false);
      // Canal droit : poids 1,0 (BS.1770) ; une source mono compte une fois.
      if (R && R !== L) kweight(1, R, len, true);
      for (var k = 0; k < len; k++) {
        subAcc += kbuf[k];
        if (++subN === SUB) { kOut.push(subAcc / SUB); subAcc = 0; subN = 0; }
      }
    }
    if (GONIO && gOut.length < 2048) {
      var Rr = R || L;
      for (var g = 0; g < len; g++) {
        if (++gCount >= gStep) { gCount = 0; gOut.push(L[g], Rr[g]); }
      }
    }
  }

  function take(): MeterTake {
    var t: MeterTake = {
      n: n, peakL: peak[0], peakR: peak[1],
      tpL: Math.max(tp[0], peak[0]), tpR: Math.max(tp[1], peak[1]),
      sumL: sum[0], sumR: sum[1], lr: lr, k: kOut, gonio: gOut, stereo: stereo,
    };
    n = 0; peak = [0, 0]; tp = [0, 0]; sum = [0, 0]; lr = 0; kOut = []; gOut = []; stereo = false;
    return t;
  }

  function reset() {
    hist[0].fill(0); hist[1].fill(0); hpos = [0, 0];
    kst[0].fill(0); kst[1].fill(0); subAcc = 0; subN = 0;
    take();
  }

  return { process: process, take: take, reset: reset };
}
