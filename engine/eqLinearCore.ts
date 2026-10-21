/**
 * Cœur DSP « pro » de l'égaliseur 12 bandes NOVA (écart 12 du comparatif du 21/10/2026),
 * en JavaScript pur : traitement Mid/Side PAR BANDE et mode à phase linéaire.
 *
 * Il tourne tel quel dans l'AudioWorklet (sérialisé par `toString()` : il ne référence RIEN
 * en dehors de lui-même) et dans les tests vitest. L'égaliseur classique (filtres natifs du
 * navigateur, plugins/ProEQ12Plugin.tsx) reste utilisé tant qu'aucune bande n'est en
 * Mid / Side / Gauche / Droite et que la phase est « naturelle » : un ancien projet sonne
 * exactement comme avant.
 *
 * Canal de chaque bande : stéréo (les deux canaux), centre (Mid = (G+D)/2), côtés
 * (Side = (G−D)/2), gauche, droite. Bandes en série, dans l'ordre 1 → 12.
 *
 * 1) Phase naturelle (minimum) : chaque bande est un biquad aux formules du Web Audio
 *    (mêmes courbes que l'égaliseur classique, Q en dB pour les coupe-bas / coupe-haut),
 *    calculé en double précision, forme directe I. Une bande Mid / Side encode, filtre le
 *    canal visé, puis décode : G = M + S, D = M − S. Une bande neutre (cloche / étagère à
 *    0 dB, bande coupée) n'est PAS calculée : la sortie est l'entrée au bit près (et
 *    l'encodage M/S d'une bande neutre n'a pas lieu). Latence nulle.
 *    Sans clic : fréquence et Q glissent (log), gain glisse (dB), par sous-blocs de 32 ;
 *    marche / arrêt, solo, changement de type ou de canal : fondu dry / wet de 256 échantillons.
 *
 * 2) Phase linéaire : la réponse de toute la chaîne est une matrice 2 × 2 réelle par
 *    fréquence (produit des bandes dans l'ordre ; Mid / Side mélangent G et D), donc à
 *    phase nulle. Chaque coefficient devient un filtre RIF symétrique de 2D + 1 points
 *    (échantillonnage en fréquence sur 4D points, transformée inverse, fenêtre de Tukey),
 *    décalé de D : phase strictement linéaire, latence EXACTE de D échantillons, annoncée
 *    au moteur (PDC). Convolution par FFT à partitions uniformes de 128 (= bloc de rendu) :
 *    aucune latence en plus. Chaîne neutre : retard pur de D échantillons (exact).
 *    Un réglage changé relance le calcul des filtres PAR ÉTAPES (budget fixe par bloc : le
 *    fil audio ne prend jamais de pic), puis fondu de 256 échantillons de l'ancien vers le nouveau.
 *    D = 2048 échantillons à 44,1 / 48 kHz (« normale », ~43 ms), 4096 à 88,2 / 96 kHz ;
 *    « haute » résolution : 8192 (grave plus précis, ~171 ms à 48 kHz).
 *
 * Aucune allocation dans `process` (tout est réservé dans `setParams`).
 */

export type EqChannel = 'stereo' | 'mid' | 'side' | 'left' | 'right';
export type EqPhase = 'minimum' | 'linear';
export type EqLinQuality = 'normale' | 'haute';

export interface EqProBand {
  type?: string;
  frequency?: number;
  gain?: number;
  q?: number;
  isEnabled?: boolean;
  isSolo?: boolean;
  channel?: EqChannel | string;
}

export interface EqProParams {
  bands?: EqProBand[];
  isEnabled?: boolean;
  phase?: EqPhase | string;
  linQuality?: EqLinQuality | string;
}

export interface EqProCore {
  /** Structure et valeurs fixes (peut réserver de la mémoire : jamais appelé dans `process`). */
  setParams(p: EqProParams): void;
  /** Réglage d'une bande venu d'un AudioParam : idx = bande × 3 + (0 fréquence, 1 gain, 2 Q). */
  setAuto(idx: number, v: number): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  reset(): void;
  atRest(): boolean;
  catchUp(K: number): void;
  /** Latence (échantillons) : D en phase linéaire, 0 sinon. */
  latency(): number;
  /** Diagnostic / tests : mode du rendu linéaire (« retard », « lr », « complet ») et filtres. */
  linearInfo(): { mode: string; D: number; taps: (Float64Array | null)[]; pending: boolean };
}

/** Latence (échantillons) du mode phase linéaire, selon la fréquence d'échantillonnage et la résolution. */
export function eqLinearLatencySamples(sampleRate: number, quality?: string): number {
  if (quality === 'haute') return 8192;
  var k = sampleRate > 100000 ? 4 : sampleRate > 50000 ? 2 : 1;
  return Math.min(8192, 2048 * k);
}

/** Vrai si l'égaliseur doit passer par le cœur pro (une bande hors stéréo, ou la phase linéaire). */
export function eqProNeeded(p: EqProParams | null | undefined): boolean {
  if (!p) return false;
  if (p.phase === 'linear') return true;
  var b = p.bands || [];
  for (var i = 0; i < b.length; i++) { var c = b[i] && b[i].channel; if (c && c !== 'stereo') return true; }
  return false;
}

export function createEqProCore(sampleRate: number): EqProCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var NB = 12;
  var SUB = 32;
  var XRAMP = 256;
  var BLK = 128;
  var GLIDE = 1 - Math.exp(-SUB / (0.015 * SR));
  var TYPES = ['peaking', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch'];
  var CHANS = ['stereo', 'mid', 'side', 'left', 'right'];

  // ---- réglages par bande ----
  var tType = new Int32Array(NB), tCh = new Int32Array(NB), tEn = new Uint8Array(NB);
  var fT = new Float64Array(NB), gT = new Float64Array(NB), qT = new Float64Array(NB);
  var phaseLin = false;
  var quality = 'normale';
  var first = true;

  function num(v: any, d: number) { var x = +v; return x === x && isFinite(x) ? x : d; }
  function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }
  function isGainType(t: number) { return t <= 2; }

  /** Coefficients normalisés (b0, b1, b2, a1, a2) d'un biquad du Web Audio, dans `o` à partir de `k`. */
  function coefs(type: number, f: number, g: number, q: number, o: Float64Array, k: number) {
    var f0 = clamp(f, 10, SR * 0.495);
    var w0 = 2 * Math.PI * f0 / SR, cw = Math.cos(w0), sw = Math.sin(w0);
    var Q = Math.max(0.0001, q);
    var A = Math.pow(10, g / 40);
    var b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0, al = 0;
    if (type === 3 || type === 4) {
      al = sw / (2 * Math.pow(10, Q / 20));
      if (type === 4) { b0 = (1 - cw) / 2; b1 = 1 - cw; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); }
      b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    } else if (type === 5) {
      al = sw / (2 * Q); b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
    } else if (type === 1 || type === 2) {
      al = (sw / 2) * Math.SQRT2; var sA = 2 * Math.sqrt(A) * al;
      if (type === 1) {
        b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
        a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
        a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
      }
    } else {
      al = sw / (2 * Q); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    }
    o[k] = b0 / a0; o[k + 1] = b1 / a0; o[k + 2] = b2 / a0; o[k + 3] = a1 / a0; o[k + 4] = a2 / a0;
  }

  // =====================================================================================
  // Phase naturelle : biquads en série, Mid / Side par bande
  // =====================================================================================
  var cType = new Int32Array(NB), cCh = new Int32Array(NB);
  var fC = new Float64Array(NB), gC = new Float64Array(NB), qC = new Float64Array(NB);
  var mix = new Float64Array(NB), mixT = new Float64Array(NB);
  var C = new Float64Array(NB * 5);
  // État DF-I : 2 voies par bande × (x1, x2, y1, y2).
  var ST = new Float64Array(NB * 8);
  var gliding = new Uint8Array(NB);
  var bL = new Float64Array(BLK), bR = new Float64Array(BLK);
  var minRest = true;

  function bandNeutralTarget(b: number) { return isGainType(tType[b]) && Math.abs(gT[b]) < 1e-9; }

  function minTargets(snap: boolean) {
    for (var b = 0; b < NB; b++) {
      var sameCfg = cType[b] === tType[b] && cCh[b] === tCh[b];
      if (snap) {
        cType[b] = tType[b]; cCh[b] = tCh[b];
        fC[b] = fT[b]; gC[b] = gT[b]; qC[b] = qT[b];
        mix[b] = mixT[b] = tEn[b] ? 1 : 0;
        gliding[b] = 0;
        coefs(cType[b], fC[b], gC[b], qC[b], C, b * 5);
        continue;
      }
      if (!sameCfg && mix[b] > 0) mixT[b] = 0;       // fondu de sortie, puis nouvelle configuration
      else {
        if (!sameCfg) { cType[b] = tType[b]; cCh[b] = tCh[b]; fC[b] = fT[b]; gC[b] = gT[b]; qC[b] = qT[b]; for (var z = 0; z < 8; z++) ST[b * 8 + z] = 0; coefs(cType[b], fC[b], gC[b], qC[b], C, b * 5); }
        mixT[b] = tEn[b] ? 1 : 0;
      }
      if (fC[b] !== fT[b] || gC[b] !== gT[b] || qC[b] !== qT[b]) gliding[b] = 1;
    }
  }

  function glideStep(b: number) {
    var lf = Math.log(fT[b] / fC[b]);
    fC[b] = Math.abs(lf) < 1e-5 ? fT[b] : fC[b] * Math.exp(lf * GLIDE);
    var lq = Math.log(qT[b] / qC[b]);
    qC[b] = Math.abs(lq) < 1e-5 ? qT[b] : qC[b] * Math.exp(lq * GLIDE);
    var dg = gT[b] - gC[b];
    gC[b] = Math.abs(dg) < 1e-4 ? gT[b] : gC[b] + dg * GLIDE;
    if (fC[b] === fT[b] && qC[b] === qT[b] && gC[b] === gT[b]) gliding[b] = 0;
    coefs(cType[b], fC[b], gC[b], qC[b], C, b * 5);
  }

  /** Biquad d'une voie sur x[j0..j1) en place (DF-I, double précision), avec fondu dry/wet. */
  function runLane(b: number, lane: number, x: Float64Array, j0: number, j1: number) {
    var k = b * 5, s = b * 8 + lane * 4;
    var b0 = C[k], b1 = C[k + 1], b2 = C[k + 2], a1 = C[k + 3], a2 = C[k + 4];
    var x1 = ST[s], x2 = ST[s + 1], y1 = ST[s + 2], y2 = ST[s + 3];
    var m = mix[b], mt = mixT[b], step = 1 / XRAMP;
    for (var j = j0; j < j1; j++) {
      var xi = x[j];
      var y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
      if (m !== mt) { m = mt > m ? Math.min(mt, m + step) : Math.max(mt, m - step); }
      x[j] = m === 1 ? y : xi + m * (y - xi);
    }
    // Résidus sous le plancher des nombres flottants : état ramené à zéro (repos exact).
    if (Math.abs(y1) < 1e-25 && Math.abs(y2) < 1e-25 && Math.abs(x1) < 1e-25 && Math.abs(x2) < 1e-25) { x1 = x2 = y1 = y2 = 0; }
    ST[s] = x1; ST[s + 1] = x2; ST[s + 2] = y1; ST[s + 3] = y2;
    return m;
  }

  /** Bande neutre (non calculée) : son état suit l'entrée (un biquad à 0 dB recopie l'entrée), reprise sans clic. */
  function trackLane(b: number, lane: number, x: Float64Array, j1: number) {
    var s = b * 8 + lane * 4;
    var x1 = j1 >= 1 ? x[j1 - 1] : 0, x2 = j1 >= 2 ? x[j1 - 2] : 0;
    ST[s] = x1; ST[s + 1] = x2; ST[s + 2] = x1; ST[s + 3] = x2;
  }

  var tmpM = new Float64Array(BLK), tmpS = new Float64Array(BLK);

  function processMin(n: number) {
    var busy = false;
    for (var j0 = 0; j0 < n; j0 += SUB) {
      var j1 = Math.min(n, j0 + SUB);
      for (var b = 0; b < NB; b++) {
        if (mix[b] === 0 && mixT[b] === 0) {
          // Bande au repos ; une nouvelle configuration attendait la fin du fondu : elle est prise.
          if (cType[b] !== tType[b] || cCh[b] !== tCh[b]) { cType[b] = tType[b]; cCh[b] = tCh[b]; fC[b] = fT[b]; gC[b] = gT[b]; qC[b] = qT[b]; gliding[b] = 0; for (var z = 0; z < 8; z++) ST[b * 8 + z] = 0; coefs(cType[b], fC[b], gC[b], qC[b], C, b * 5); if (tEn[b]) mixT[b] = 1; }
          if (mixT[b] === 0) {
            // Bande coupée : ses réglages sont posés tels quels (elle repartira de là, sans glissement).
            if (gliding[b]) { fC[b] = fT[b]; gC[b] = gT[b]; qC[b] = qT[b]; gliding[b] = 0; coefs(cType[b], fC[b], gC[b], qC[b], C, b * 5); }
            continue;
          }
        }
        if (gliding[b]) glideStep(b);
        var ch = cCh[b];
        var neutral = isGainType(cType[b]) && gC[b] === 0 && !gliding[b] && mix[b] === 1 && mixT[b] === 1;
        busy = true;
        if (ch === 0) {
          if (neutral) { trackLane(b, 0, bL, j1); trackLane(b, 1, bR, j1); continue; }
          runLane(b, 0, bL, j0, j1); mix[b] = runLane(b, 1, bR, j0, j1);
        } else if (ch === 3 || ch === 4) {
          var X = ch === 3 ? bL : bR;
          if (neutral) { trackLane(b, 0, X, j1); continue; }
          mix[b] = runLane(b, 0, X, j0, j1);
        } else {
          // Mid / Side : encodage, filtre du canal visé, décodage (G = M + S, D = M − S).
          var T = ch === 1 ? tmpM : tmpS;
          for (var j = j0; j < j1; j++) { tmpM[j] = (bL[j] + bR[j]) * 0.5; tmpS[j] = (bL[j] - bR[j]) * 0.5; }
          if (neutral) { trackLane(b, 0, T, j1); continue; }
          mix[b] = runLane(b, 0, T, j0, j1);
          for (var jj = j0; jj < j1; jj++) { bL[jj] = tmpM[jj] + tmpS[jj]; bR[jj] = tmpM[jj] - tmpS[jj]; }
        }
        if (mix[b] === 0 && mixT[b] === 0) { for (var z2 = 0; z2 < 8; z2++) ST[b * 8 + z2] = 0; }
      }
    }
    var rest = true;
    for (var i = 0; i < NB * 8; i++) if (ST[i] !== 0) { rest = false; break; }
    if (rest) for (var b2 = 0; b2 < NB; b2++) if (gliding[b2] || mix[b2] !== mixT[b2]) { rest = false; break; }
    minRest = rest;
    return busy;
  }

  // =====================================================================================
  // Phase linéaire : RIF symétriques, convolution FFT à partitions uniformes
  // =====================================================================================
  var D = 0, NF = 0, H = 0, L = 0, P = 0;
  // Tables de la grande FFT de conception (taille NF = 4D) et de la FFT de convolution (256).
  var bigRe = new Float64Array(0), bigIm = new Float64Array(0), bigCos = new Float64Array(0), bigSin = new Float64Array(0), bigRev = new Int32Array(0);
  var c1 = new Float64Array(0), s1 = new Float64Array(0), c2 = new Float64Array(0), s2 = new Float64Array(0);
  var TM = [new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0)];
  var taps = [new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0)];
  var win = new Float64Array(0);
  var K2 = 256, KH = 129;
  var fRe = new Float64Array(K2), fIm = new Float64Array(K2), fCos = new Float64Array(K2 / 2), fSin = new Float64Array(K2 / 2), fRev = new Int32Array(K2);
  // Jeux de filtres (spectres des partitions) : actif et en préparation.
  var setSpec = [new Float64Array(0), new Float64Array(0)];
  var setOn = [new Uint8Array(4), new Uint8Array(4)];
  var setIdent = [1, 1];
  var cur = 0;
  // Historique des spectres d'entrée (G, D), anneau de P cases.
  var fdlRe = [new Float64Array(0), new Float64Array(0)], fdlIm = [new Float64Array(0), new Float64Array(0)];
  var slotZero = new Uint8Array(0);
  var fdlPos = 0;
  var frameL = new Float64Array(K2), frameR = new Float64Array(K2);
  // Ligne à retard (chaîne neutre) : D + 128 échantillons par canal.
  var dl = [new Float64Array(0), new Float64Array(0)], dlPos = 0, dlLen = 0;
  var yA = [new Float64Array(BLK), new Float64Array(BLK)], yB = [new Float64Array(BLK), new Float64Array(BLK)];
  var accLr = new Float64Array(KH), accLi = new Float64Array(KH), accRr = new Float64Array(KH), accRi = new Float64Array(KH);
  var zeroBlocks = 0;
  var xf = 0;           // échantillons restants du fondu entre jeux
  var linReady = false;

  function fftTables(n: number, cosT: Float64Array, sinT: Float64Array, rev: Int32Array) {
    for (var i = 0; i < n / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / n); sinT[i] = Math.sin(2 * Math.PI * i / n); }
    var bits = Math.round(Math.log(n) / Math.LN2);
    for (var k = 0; k < n; k++) { var r = 0, x = k; for (var q = 0; q < bits; q++) { r = (r << 1) | (x & 1); x >>= 1; } rev[k] = r; }
  }
  function bitrev(re: Float64Array, im: Float64Array, rev: Int32Array, n: number) {
    for (var i = 0; i < n; i++) { var j = rev[i]; if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  }
  /** Une passe de papillons (taille de groupe `len`) : FFT directe (sign = −1) ou inverse (+1), sans normalisation. */
  function fftPass(re: Float64Array, im: Float64Array, cosT: Float64Array, sinT: Float64Array, n: number, len: number, sign: number) {
    var half = len >> 1, stride = n / len;
    for (var i = 0; i < n; i += len) {
      for (var k = 0; k < half; k++) {
        var wr = cosT[k * stride], wi = sign * sinT[k * stride];
        var a = i + k, b = a + half;
        var tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  function fft(re: Float64Array, im: Float64Array, cosT: Float64Array, sinT: Float64Array, rev: Int32Array, n: number, sign: number) {
    bitrev(re, im, rev, n);
    for (var len = 2; len <= n; len <<= 1) fftPass(re, im, cosT, sinT, n, len, sign);
  }
  fftTables(K2, fCos, fSin, fRev);

  function allocLinear(d: number) {
    if (d === D) return;
    D = d; NF = 4 * D; H = NF / 2 + 1; L = 2 * D + 1; P = Math.ceil(L / BLK);
    bigRe = new Float64Array(NF); bigIm = new Float64Array(NF);
    bigCos = new Float64Array(NF / 2); bigSin = new Float64Array(NF / 2); bigRev = new Int32Array(NF);
    fftTables(NF, bigCos, bigSin, bigRev);
    c1 = new Float64Array(H); s1 = new Float64Array(H); c2 = new Float64Array(H); s2 = new Float64Array(H);
    for (var k = 0; k < H; k++) { var w = 2 * Math.PI * k / NF; c1[k] = Math.cos(w); s1[k] = Math.sin(w); c2[k] = Math.cos(2 * w); s2[k] = Math.sin(2 * w); }
    for (var e = 0; e < 4; e++) { TM[e] = new Float64Array(H); taps[e] = new Float64Array(L); }
    // Fenêtre de Tukey (α = 0,5) sur |n| ≤ D : plate au centre, effilée sur le dernier quart.
    win = new Float64Array(D + 1);
    for (var i = 0; i <= D; i++) { var r = i / D; win[i] = r <= 0.5 ? 1 : 0.5 * (1 + Math.cos(Math.PI * (r - 0.5) / 0.5)); }
    setSpec = [new Float64Array(4 * P * KH * 2), new Float64Array(4 * P * KH * 2)];
    setOn = [new Uint8Array(4), new Uint8Array(4)]; setIdent = [1, 1]; cur = 0;
    fdlRe = [new Float64Array(P * KH), new Float64Array(P * KH)]; fdlIm = [new Float64Array(P * KH), new Float64Array(P * KH)];
    slotZero = new Uint8Array(P); for (var p = 0; p < P; p++) slotZero[p] = 1;
    fdlPos = 0; frameL.fill(0); frameR.fill(0);
    dlLen = D + BLK; dl = [new Float64Array(dlLen), new Float64Array(dlLen)]; dlPos = 0;
    zeroBlocks = 1e9; xf = 0;
    job.active = false;
  }

  // ---- calcul des filtres par étapes ----
  var job = { active: false, stage: 0, idx: 0, e: 0, pass: 0, ident: 0, on: new Uint8Array(4) };
  // Copie des réglages au départ du calcul (le calcul porte sur un état cohérent).
  var jType = new Int32Array(NB), jCh = new Int32Array(NB), jEn = new Uint8Array(NB), jF = new Float64Array(NB), jG = new Float64Array(NB), jQ = new Float64Array(NB);
  var jC = new Float64Array(NB * 5);
  var designed = new Float64Array(NB * 6).fill(NaN);
  var linDirty = true;

  function sigDiffers() {
    for (var b = 0; b < NB; b++) {
      var k = b * 6;
      if (designed[k + 2] !== tEn[b]) return true;
      // Bande coupée : ses réglages ne comptent pas dans les filtres.
      if (tEn[b] && (designed[k] !== tType[b] || designed[k + 1] !== tCh[b] || designed[k + 3] !== fT[b] || designed[k + 4] !== gT[b] || designed[k + 5] !== qT[b])) return true;
    }
    return false;
  }

  function startJob() {
    for (var b = 0; b < NB; b++) {
      jType[b] = tType[b]; jCh[b] = tCh[b]; jEn[b] = tEn[b]; jF[b] = fT[b]; jG[b] = gT[b]; jQ[b] = qT[b];
      var k = b * 6; designed[k] = tType[b]; designed[k + 1] = tCh[b]; designed[k + 2] = tEn[b]; designed[k + 3] = fT[b]; designed[k + 4] = gT[b]; designed[k + 5] = qT[b];
      if (jEn[b]) coefs(jType[b], jF[b], jG[b], jQ[b], jC, b * 5);
    }
    job.active = true; job.stage = 0; job.idx = 0; job.e = 0; job.pass = 0;
    linDirty = false;
  }

  /** Avance le calcul d'au plus `budget` opérations (≈ multiplications). Renvoie vrai quand il est fini. */
  function stepJob(budget: number): boolean {
    var spent = 0;
    while (job.active && spent < budget) {
      if (job.stage === 0) {
        // Matrice 2 × 2 (base G / D) de la chaîne, par paquets de 512 fréquences.
        var k0 = job.idx, k1 = Math.min(H, k0 + 512);
        var LL = TM[0], LR = TM[1], RL = TM[2], RR = TM[3];
        for (var k = k0; k < k1; k++) { LL[k] = 1; LR[k] = 0; RL[k] = 0; RR[k] = 1; }
        for (var b = 0; b < NB; b++) {
          if (!jEn[b]) continue;
          if (jType[b] <= 2 && Math.abs(jG[b]) < 1e-9) continue;
          var o = b * 5, B0 = jC[o], B1 = jC[o + 1], B2 = jC[o + 2], A1 = jC[o + 3], A2 = jC[o + 4], ch = jCh[b];
          for (var kk = k0; kk < k1; kk++) {
            var nr = B0 + B1 * c1[kk] + B2 * c2[kk], ni = B1 * s1[kk] + B2 * s2[kk];
            var dr = 1 + A1 * c1[kk] + A2 * c2[kk], di = A1 * s1[kk] + A2 * s2[kk];
            var a = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
            if (ch === 0) { LL[kk] *= a; LR[kk] *= a; RL[kk] *= a; RR[kk] *= a; }
            else if (ch === 3) { LL[kk] *= a; LR[kk] *= a; }
            else if (ch === 4) { RL[kk] *= a; RR[kk] *= a; }
            else {
              // Mid : 0,5·[[a+1, a−1], [a−1, a+1]] ; Side : 0,5·[[1+a, 1−a], [1−a, 1+a]] ; nouvelle matrice = bande · matrice.
              var p = 0.5 * (a + 1), q = ch === 1 ? 0.5 * (a - 1) : 0.5 * (1 - a);
              var ll = LL[kk], lr = LR[kk], rl = RL[kk], rr = RR[kk];
              LL[kk] = p * ll + q * rl; LR[kk] = p * lr + q * rr; RL[kk] = q * ll + p * rl; RR[kk] = q * lr + p * rr;
            }
          }
          spent += (k1 - k0) * 30;
        }
        spent += (k1 - k0) * 4;
        job.idx = k1;
        if (k1 >= H) {
          // Quels filtres faut-il ? (diagonale seule, ou chaîne neutre = retard pur)
          var ident = 1, on = job.on; on[0] = on[1] = on[2] = on[3] = 0;
          for (var e = 0; e < 4; e++) {
            var Te = TM[e], idv = (e === 0 || e === 3) ? 1 : 0;
            for (var k2 = 0; k2 < H; k2++) { var v = Te[k2]; if (v !== idv) { ident = 0; } if (v !== 0) on[e] = 1; }
          }
          job.ident = ident;
          job.stage = ident ? 3 : 1; job.e = 0; job.idx = 0; job.pass = 0;
        }
      } else if (job.stage === 1) {
        // Filtre RIF du coefficient e : transformée inverse de la réponse réelle et paire (par passes).
        var e1 = job.e;
        while (e1 < 4 && !job.on[e1]) e1++;
        job.e = e1;
        if (e1 >= 4) { job.stage = 2; job.e = 0; job.idx = 0; continue; }
        if (job.pass === 0) {
          var Tm = TM[e1];
          for (var k3 = 0; k3 < H; k3++) { bigRe[k3] = Tm[k3]; bigIm[k3] = 0; }
          for (var k4 = H; k4 < NF; k4++) { bigRe[k4] = Tm[NF - k4]; bigIm[k4] = 0; }
          bitrev(bigRe, bigIm, bigRev, NF);
          job.pass = 2;
          spent += NF * 3;
        } else if (job.pass <= NF) {
          fftPass(bigRe, bigIm, bigCos, bigSin, NF, job.pass, 1);
          job.pass <<= 1;
          spent += NF * 5;
        } else {
          // Fenêtre et symétrie imposée (phase strictement linéaire), centre en D.
          var t = taps[e1], sc = 1 / NF;
          t[D] = bigRe[0] * sc * win[0];
          for (var i = 1; i <= D; i++) { var h = 0.5 * (bigRe[i] + bigRe[NF - i]) * sc * win[i]; t[D + i] = h; t[D - i] = h; }
          job.e = e1 + 1; job.pass = 0;
          spent += D * 4;
        }
      } else if (job.stage === 2) {
        // Spectres des partitions de 128 du filtre e (FFT 256), par paquets de 8.
        var e2 = job.e;
        while (e2 < 4 && !job.on[e2]) e2++;
        job.e = e2;
        if (e2 >= 4) { job.stage = 3; continue; }
        var nxt = 1 - cur, spec = setSpec[nxt], tp = taps[e2];
        var p1 = Math.min(P, job.idx + 8);
        for (var pp = job.idx; pp < p1; pp++) {
          for (var z = 0; z < K2; z++) { var ti = pp * BLK + z; fRe[z] = (z < BLK && ti < L) ? tp[ti] : 0; fIm[z] = 0; }
          fft(fRe, fIm, fCos, fSin, fRev, K2, -1);
          var base = ((e2 * P + pp) * KH) * 2;
          for (var z2 = 0; z2 < KH; z2++) { spec[base + 2 * z2] = fRe[z2]; spec[base + 2 * z2 + 1] = fIm[z2]; }
        }
        spent += (p1 - job.idx) * 4000;
        job.idx = p1;
        if (p1 >= P) { job.e = e2 + 1; job.idx = 0; }
      } else {
        // Jeu prêt : fondu de l'ancien vers le nouveau (immédiat avant le premier son).
        var nx = 1 - cur;
        setIdent[nx] = job.ident;
        for (var e3 = 0; e3 < 4; e3++) setOn[nx][e3] = job.ident ? 0 : job.on[e3];
        job.active = false;
        if (!linReady) { cur = nx; linReady = true; xf = 0; }
        else xf = XRAMP;
        return true;
      }
    }
    return !job.active;
  }

  /** Spectre d'un bloc d'entrée G/D (une FFT complexe pour les deux canaux réels) rangé dans l'historique. */
  function pushInput(inL: Float32Array, inR: Float32Array | null, n: number) {
    var silent = true;
    for (var i = 0; i < BLK; i++) {
      frameL[i] = frameL[i + BLK]; frameR[i] = frameR[i + BLK];
      var l = i < n ? inL[i] : 0, r = i < n ? (inR ? inR[i] : l) : 0;
      frameL[i + BLK] = l; frameR[i + BLK] = r;
      if (l !== 0 || r !== 0) silent = false;
      // Ligne à retard (chaîne neutre).
      dl[0][dlPos] = l; dl[1][dlPos] = r; dlPos = dlPos + 1 === dlLen ? 0 : dlPos + 1;
    }
    fdlPos = fdlPos === 0 ? P - 1 : fdlPos - 1;
    var prevSilent = zeroBlocks > 0;
    zeroBlocks = silent ? zeroBlocks + 1 : 0;
    // Trame entièrement nulle (bloc courant et précédent) : spectre nul, rien à calculer.
    if (silent && prevSilent) { slotZero[fdlPos] = 1; return; }
    for (var j = 0; j < K2; j++) { fRe[j] = frameL[j]; fIm[j] = frameR[j]; }
    fft(fRe, fIm, fCos, fSin, fRev, K2, -1);
    var o = fdlPos * KH, Lr = fdlRe[0], Li = fdlIm[0], Rr = fdlRe[1], Ri = fdlIm[1];
    for (var k = 0; k < KH; k++) {
      var m = (K2 - k) & (K2 - 1);
      var zr = fRe[k], zi = fIm[k], cr = fRe[m], ci = fIm[m];
      Lr[o + k] = 0.5 * (zr + cr); Li[o + k] = 0.5 * (zi - ci);
      Rr[o + k] = 0.5 * (zi + ci); Ri[o + k] = -0.5 * (zr - cr);
    }
    slotZero[fdlPos] = 0;
  }

  /** Sortie du jeu `s` pour le bloc courant, dans yo[0], yo[1]. */
  function convolve(s: number, yo: Float64Array[]) {
    if (setIdent[s]) {
      // Retard pur de D : l'échantillon i du bloc sort D échantillons plus tard.
      var start = dlPos - BLK - D;
      while (start < 0) start += dlLen;
      for (var i = 0; i < BLK; i++) { var q = start + i; if (q >= dlLen) q -= dlLen; yo[0][i] = dl[0][q]; yo[1][i] = dl[1][q]; }
      return;
    }
    var spec = setSpec[s], on = setOn[s];
    accLr.fill(0); accLi.fill(0); accRr.fill(0); accRi.fill(0);
    var any = false;
    var Lr = fdlRe[0], Li = fdlIm[0], Rr = fdlRe[1], Ri = fdlIm[1];
    for (var p = 0; p < P; p++) {
      var slot = fdlPos + p; if (slot >= P) slot -= P;
      if (slotZero[slot]) continue;
      any = true;
      var xo = slot * KH;
      for (var e = 0; e < 4; e++) {
        if (!on[e]) continue;
        var hb = ((e * P + p) * KH) * 2;
        // e : 0 = G→G, 1 = D→G, 2 = G→D, 3 = D→D.
        var xr = (e === 0 || e === 2) ? Lr : Rr, xi = (e === 0 || e === 2) ? Li : Ri;
        var ar = e < 2 ? accLr : accRr, ai = e < 2 ? accLi : accRi;
        for (var k = 0; k < KH; k++) {
          var hr = spec[hb + 2 * k], hi = spec[hb + 2 * k + 1], a = xr[xo + k], b = xi[xo + k];
          ar[k] += hr * a - hi * b; ai[k] += hr * b + hi * a;
        }
      }
    }
    if (!any) { yo[0].fill(0); yo[1].fill(0); return; }
    // Z = YG + j·YD sur tout le spectre (symétrie hermitienne), une FFT inverse pour les deux canaux.
    for (var k2 = 0; k2 < K2; k2++) {
      var lr: number, li: number, rr: number, ri: number;
      if (k2 < KH) { lr = accLr[k2]; li = accLi[k2]; rr = accRr[k2]; ri = accRi[k2]; }
      else { var m = K2 - k2; lr = accLr[m]; li = -accLi[m]; rr = accRr[m]; ri = -accRi[m]; }
      fRe[k2] = lr - ri; fIm[k2] = li + rr;
    }
    fft(fRe, fIm, fCos, fSin, fRev, K2, 1);
    var sc = 1 / K2;
    for (var i2 = 0; i2 < BLK; i2++) { yo[0][i2] = fRe[i2 + BLK] * sc; yo[1][i2] = fIm[i2 + BLK] * sc; }
  }

  var JOB_BUDGET = 260000;

  function linRest() {
    if (job.active || xf > 0 || linDirty) return false;
    return zeroBlocks > P + Math.ceil(dlLen / BLK) + 1;
  }

  function processLinBlock(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, off: number, n: number) {
    var sl = off ? inL.subarray(off, off + n) : inL;
    var sr = inR ? (off ? inR.subarray(off, off + n) : inR) : null;
    pushInput(sl, sr, n);
    if (linDirty && !job.active && xf === 0) { if (sigDiffers()) startJob(); else linDirty = false; }
    if (job.active) stepJob(JOB_BUDGET);
    if (zeroBlocks > P + Math.ceil(dlLen / BLK) + 1 && xf === 0) {
      for (var z = 0; z < n; z++) { outL[off + z] = 0; if (outR) outR[off + z] = 0; }
      return;
    }
    convolve(cur, yA);
    if (xf > 0) {
      convolve(1 - cur, yB);
      for (var i = 0; i < n; i++) {
        var w = (XRAMP - xf + i + 1) / XRAMP; if (w > 1) w = 1;
        yA[0][i] = yA[0][i] + w * (yB[0][i] - yA[0][i]); yA[1][i] = yA[1][i] + w * (yB[1][i] - yA[1][i]);
      }
      xf -= n;
      if (xf <= 0) { xf = 0; cur = 1 - cur; }
    }
    for (var j = 0; j < n; j++) { outL[off + j] = yA[0][j]; if (outR) outR[off + j] = yA[1][j]; }
  }

  // =====================================================================================
  // Bascule phase naturelle / linéaire : fondu de sortie puis d'entrée (un bloc chacun)
  // =====================================================================================
  var modeLin = false;     // mode en cours de rendu
  var swFade = 0;          // 0 : rien ; 1 : sortie en fondu ; 2 : entrée en fondu

  /** Bascule effective : la phase naturelle repart d'un état vide (ses filtres n'ont pas tourné). */
  function switchTo(lin: boolean) {
    if (!lin && modeLin) { for (var i = 0; i < ST.length; i++) ST[i] = 0; minTargets(true); }
    modeLin = lin;
  }

  var czIn = new Float32Array(BLK), czOut = new Float32Array(BLK);

  function api_setParams(p: EqProParams) {
    var bands = (p && p.bands) || [];
    var anySolo = -1;
    for (var b = 0; b < NB; b++) { var bb = bands[b]; if (bb && bb.isSolo && bb.isEnabled !== false) { anySolo = b; break; } }
    var gOn = !p || p.isEnabled !== false;
    for (var i = 0; i < NB; i++) {
      var x = bands[i] || {};
      var ti = TYPES.indexOf(String(x.type || 'peaking')); tType[i] = ti < 0 ? 0 : ti;
      var ci = CHANS.indexOf(String(x.channel || 'stereo')); tCh[i] = ci < 0 ? 0 : ci;
      tEn[i] = gOn && (anySolo >= 0 ? anySolo === i : x.isEnabled !== false) ? 1 : 0;
      fT[i] = clamp(num(x.frequency, 1000), 10, SR * 0.495);
      qT[i] = clamp(num(x.q, 1), 0.0001, 1000);
      gT[i] = clamp(num(x.gain, 0), -40, 40);
      // Bande sans gain (coupe-bas, coupe-haut, encoche) : son gain n'existe pas.
      if (!isGainType(tType[i])) gT[i] = 0;
    }
    var wantLin = !!p && p.phase === 'linear';
    var q = p && p.linQuality === 'haute' ? 'haute' : 'normale';
    if (wantLin) {
      var d = eqLinD(q);
      if (d !== D) { allocLinear(d); linReady = false; }
      quality = q;
      if (sigDiffers()) linDirty = true;
      // À la création (et à l'export) : filtres calculés tout de suite. Ensuite : par étapes, dans `process`.
      if (first && linDirty) { startJob(); stepJob(1e15); }
    }
    phaseLin = wantLin;
    if (first) {
      first = false; modeLin = wantLin; swFade = 0;
      minTargets(true);
      return;
    }
    minTargets(false);
    if (modeLin !== wantLin && swFade === 0) swFade = 1;
  }

  function eqLinD(q: string) {
    if (q === 'haute') return 8192;
    var k = SR > 100000 ? 4 : SR > 50000 ? 2 : 1;
    return Math.min(8192, 2048 * k);
  }

  function api_setAuto(idx: number, v: number) {
    var b = (idx / 3) | 0, f = idx - b * 3;
    if (b < 0 || b >= NB || !(v === v)) return;
    if (f === 0) v = clamp(v, 10, SR * 0.495);
    else if (f === 1) v = isGainType(tType[b]) ? clamp(v, -40, 40) : 0;
    else v = clamp(v, 0.0001, 1000);
    var arr = f === 0 ? fT : f === 1 ? gT : qT;
    if (arr[b] === v) return;
    arr[b] = v;
    if (first) return;
    if (fC[b] !== fT[b] || gC[b] !== gT[b] || qC[b] !== qT[b]) gliding[b] = 1;
    if (phaseLin) linDirty = true;
  }

  function api_process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number) {
    if (modeLin) {
      // Blocs de 128 (le bloc de rendu du Web Audio) ; un reste éventuel passe par un bloc partiel.
      for (var off = 0; off < n; off += BLK) processLinBlock(inL, inR, outL, outR, off, Math.min(BLK, n - off));
    } else {
      for (var o2 = 0; o2 < n; o2 += BLK) {
        var m = Math.min(BLK, n - o2);
        for (var i = 0; i < m; i++) { bL[i] = inL[o2 + i]; bR[i] = inR ? inR[o2 + i] : inL[o2 + i]; }
        processMin(m);
        for (var j = 0; j < m; j++) { outL[o2 + j] = bL[j]; if (outR) outR[o2 + j] = bR[j]; }
      }
      // Phase linéaire en attente (bascule) : l'historique d'entrée continue d'avancer.
      if (phaseLin && D > 0) {
        for (var o3 = 0; o3 < n; o3 += BLK) pushInput(o3 ? inL.subarray(o3) : inL, inR ? (o3 ? inR.subarray(o3) : inR) : null, Math.min(BLK, n - o3));
        if (linDirty && !job.active && xf === 0) { if (sigDiffers()) startJob(); else linDirty = false; }
        if (job.active) stepJob(JOB_BUDGET);
      }
    }
    if (swFade === 1) {
      for (var a = 0; a < n; a++) { var g = 1 - (a + 1) / n; outL[a] *= g; if (outR) outR[a] *= g; }
      // Phase linéaire demandée : on attend que ses filtres soient prêts.
      if (!phaseLin || (linReady && !job.active)) { switchTo(phaseLin); swFade = 2; }
      else { for (var a2 = 0; a2 < n; a2++) { outL[a2] = 0; if (outR) outR[a2] = 0; } swFade = 3; }
    } else if (swFade === 3) {
      for (var a3 = 0; a3 < n; a3++) { outL[a3] = 0; if (outR) outR[a3] = 0; }
      if (!phaseLin || (linReady && !job.active)) { switchTo(phaseLin); swFade = 2; }
    } else if (swFade === 2) {
      for (var c = 0; c < n; c++) { var g2 = (c + 1) / n; outL[c] *= g2; if (outR) outR[c] *= g2; }
      swFade = 0;
    }
  }

  function api_reset() {
    for (var i = 0; i < ST.length; i++) ST[i] = 0;
    // Réglages en cours : posés tels quels (repos exact, comme une instance neuve).
    modeLin = phaseLin; swFade = 0;
    minTargets(true);
    if (D > 0) {
      for (var c = 0; c < 2; c++) { fdlRe[c].fill(0); fdlIm[c].fill(0); dl[c].fill(0); }
      for (var p = 0; p < P; p++) slotZero[p] = 1;
      frameL.fill(0); frameR.fill(0); fdlPos = 0; dlPos = 0; zeroBlocks = 1e9;
      if (phaseLin) {
        // Calcul en cours ou réglage changé : terminé tout de suite, jeu posé sans fondu.
        if (job.active) stepJob(1e15);
        if (xf > 0) { cur = 1 - cur; xf = 0; }
        if (linDirty || sigDiffers()) { linReady = false; startJob(); stepJob(1e15); }
      }
    }
    minRest = true;
  }

  return {
    setParams: api_setParams,
    setAuto: api_setAuto,
    process: api_process,
    reset: api_reset,
    atRest: function () { return swFade === 0 && (modeLin ? linRest() : minRest); },
    catchUp: function (K: number) {
      if (K <= 0) return;
      if (modeLin ? linRest() : minRest) return;
      var nb = Math.min(Math.ceil(K / BLK), modeLin ? P + Math.ceil(dlLen / BLK) + 4 : 64);
      for (var i = 0; i < nb; i++) api_process(czIn, czIn, czOut, czOut, BLK);
    },
    latency: function () { return phaseLin ? D || eqLinD(quality) : 0; },
    linearInfo: function () {
      var mode = setIdent[cur] ? 'retard' : (setOn[cur][1] || setOn[cur][2]) ? 'complet' : 'lr';
      var t: (Float64Array | null)[] = [];
      for (var e = 0; e < 4; e++) t.push(!setIdent[cur] && setOn[cur][e] ? taps[e] : null);
      return { mode: mode, D: D, taps: t, pending: job.active || linDirty || xf > 0 };
    },
  };
}
