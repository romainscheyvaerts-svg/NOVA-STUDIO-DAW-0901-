/**
 * Cœur DSP de l'effet NOVA « Mastering Transient » (limiteur de mastering
 * multibande à emphase des transitoires), en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet (la fonction est sérialisée par
 * `toString()` : elle ne référence RIEN en dehors d'elle-même ; le limiteur
 * large bande final lui est passé en argument) et sous Node (vitest, labo).
 *
 * Modèle boîte noire calé au labo (tools/labo/elevate) sur un limiteur de
 * mastering du commerce. Chaîne :
 *
 *  1. gain d'entrée ;
 *  2. banc de filtres auditifs : STFT (fenêtre racine de Hann, N = 512 à
 *     48 kHz, pas N/4), 26 bandes centrées sur l'échelle MEL, poids
 *     triangulaires qui se recouvrent et somment à 1 : tous gains égaux, la
 *     reconstruction est parfaitement plate (null < −150 dB) ;
 *  3. limiteur multibande : gain de poussée, seuil lié au plafond, vitesse,
 *     relâchement adapté à la bande (vitesse adaptative), écart maximal entre
 *     la réduction d'une bande et la réduction commune (gain adaptatif) ;
 *  4. façonneur de transitoires par bande (après le limiteur, comme
 *     l'original) : enveloppe rapide vue avec anticipation contre enveloppe
 *     lente ; gain = 1 + A(emphase) × dosage de la bande × s, s ∈ [0, 1]
 *     (forme et loi d'emphase mesurées) ; « adaptatif » : allonge l'emphase et
 *     la réduit sur un fond déjà fort ;
 *  5. gain par bande (égaliseur ±6 dB) ;
 *  6. synthèse (addition-recouvrement), limiteur large bande en crête vraie
 *     (plafond), clipper doux (poussée, forme), gain de sortie.
 *
 * Latence : N + anticipation × pas + latence du limiteur final ; déclarée au PDC.
 */

export interface MasterTransientParams {
  /** Emphase des transitoires (0–100 %). */
  emphasis: number;
  /** Emphase adaptative (0–100 %). */
  adaptive: number;
  /** Dosage de l'emphase par bande (26 valeurs, 0–200 %). */
  bandTransient: ArrayLike<number>;
  /** Gain par bande (26 valeurs, dB, −6…+6). */
  bandGainDb: ArrayLike<number>;
  /** Limiteur : poussée (dB, 0–12 ; 0 = limiteur au repos). */
  limitGainDb: number;
  /** Limiteur : vitesse (ms, 0–10). */
  speedMs: number;
  /** Limiteur : écart de réduction max entre bandes (dB, 0–12). */
  adaptiveGainDb: number;
  /** Limiteur : vitesse adaptative (0–100 %). */
  adaptiveSpeed: number;
  /** Plafond (dB). */
  ceilingDb: number;
  /** Plafond en crête vraie (suréchantillonnage ×4) ou crête échantillon. */
  truePeak: boolean;
  /** Clipper : poussée (dB, 0–12) et forme (0 = doux, 100 = dur). */
  clipDriveDb: number;
  clipShape: number;
  /** Gain d'entrée / de sortie (dB). */
  inputDb: number;
  outputDb: number;
  /** Modules actifs. */
  transientOn: boolean;
  limiterOn: boolean;
  clipperOn: boolean;
  /** Écoute d'une bande seule (−1 = aucune). */
  soloBand: number;
  /** Limiteur coupé : protection à 0 dBTP (vrai par défaut ; le labo la coupe pour comparer à l'original, qui laisse passer). */
  protect?: boolean;
}

/** Profil mesuré (tools/labo/elevate/transient_fit.json -> engine/masterTransientProfile.ts). */
export interface MasterTransientProfile {
  centers: number[];
  emKnob: number[];
  emPeakDb: number[];
  /** Détecteur d'attaques : anticipation (ms), enveloppes rapide / lente, courbe, maintien et relâchement de l'emphase. */
  laMs: number; afMs: number; rfMs: number; asMs: number; rsMs: number; q: number; d0: number; p: number; wneg: number;
  holdMs: number; gsMs: number;
  adK: number; adP: number; adBg: number; adLtMs: number; adSens?: number;
  limThrDb: number; limRelK: number; limAdaptExp: number; limRelRefHz: number;
  /** Limiteur large bande final : relâchement = limFinRelMs × (0,2 + vitesse) (ms). */
  limFinRelMs?: number;
  /** Loi statique du limiteur multibande (mesurée sur sinus) : réduction (dB) selon le dépassement du plafond (dB). */
  limGrOver?: number[]; limGrDb?: number[];
  /**
   * Tour 3 : réduction COMMUNE dans le temps (gain par échantillon, crête vraie, coude doux mesuré)
   * au lieu de trames de 10 ms : l'original module le gain dans la période d'un grave à vitesse 1 ms.
   * Les bandes ne portent plus que l'écart à cette réduction commune (gain adaptatif, ± dB).
   * Relâchement = limTdRelK × (limTdRelA + vitesse) × limTdAsMul^(vitesse adaptative) (ms).
   */
  limTd?: number;
  limKneeOver?: number[]; limKneeGr?: number[];
  limLaMs?: number; limAttMs?: number; limHoldMs?: number;
  limTdRelK?: number; limTdRelA?: number; limTdAsMul?: number;
  /** Anticipation effective et rampe d'attaque selon la vitesse : a × vitesse^e (ms), bornées par limLaMs. */
  limTdLa1?: number; limTdEla?: number; limTdAtt1?: number; limTdEatt?: number; limTdRelDb?: number;
  /** Écart (dB) ajouté au niveau propre de chaque bande (crête / amplitude de trame) ; vitesse adaptative : voir limTdAs*. */
  limOwnDb?: number;
  /** Gain adaptatif : part de la réduction commune rendue aux bandes = limAdBeta × (adaptatif / 6 dB)^limAdP. */
  limAdBeta?: number; limAdP?: number; limAdGamma?: number; limAdTauMs?: number; limAdSlowMs?: number;
  /**
   * Vitesse adaptative (domaine temps) : relâchement × (centroïde spectral / 1 kHz)^(−limTdAsK × vitesse adaptative)
   * (plus vif dans l'aigu, plus lent dans le grave) ; anticipation et attaque × (1 + (limTdAsLa − 1) × vitesse adaptative).
   */
  limTdAsK?: number; limTdAsLa?: number;
  /** Suréchantillonnage de la détection crête vraie du limiteur final (4 par défaut). */
  limTdOs?: number;
  /**
   * Tour 3 : clipper mesuré = saturation instantanée y = plafond · v / (1 + |v|^k)^(1/k), v = x · poussée,
   * AVANT le plafond en crête vraie (comme l'original) ; ln k tabulé selon la poussée (dB) et la forme (%).
   */
  clipDrives?: number[]; clipShapes?: number[]; clipLogK?: number[][];
  /**
   * Tour 3 : formes MESURÉES des bandes de l'égaliseur (poids linéaires par case de la STFT 512 à 48 kHz,
   * pré-compensés du lissage de la fenêtre ; [première case, valeurs] par bande). Absent : triangles.
   */
  eqShapes?: [number, number[]][];
}

export interface MasterTransientCore {
  setParams(p: Partial<MasterTransientParams>): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  latencySamples(): number;
  /** Mesures depuis le dernier appel : emphase max (dB), réduction max du limiteur (dB), crêtes (dBFS), par bande (dB). */
  takeMeters(): { emphDb: number; grDb: number; inPeakDb: number; outPeakDb: number; bandEmphDb: number[]; bandGrDb: number[] };
  reset(): void;
}

export function createMasterTransientCore(sampleRate: number, profile: MasterTransientProfile, makeLimiter?: (sr: number) => any): MasterTransientCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var NB = 26;
  var prof = profile;
  // Trame de synthèse : 512 à 48 kHz (≈ 10,7 ms), puissance de 2 la plus proche aux autres fréquences.
  var N = 512;
  while (N * 48000 < 512 * SR * 0.75) N *= 2;
  while (N > 128 && N * 48000 > 512 * SR * 1.5) N /= 2;
  var H = N / 4, NH = N / 2 + 1;
  // Trame de détection : 4 fois plus courte, pas de Nd/4 (≈ 0,7 ms à 48 kHz).
  var Nd = N / 4, Hd = Nd / 4, NHd = Nd / 2 + 1;
  var laS = (+prof.laMs || 0) * 0.001 * SR;
  // trames de synthèse retenues pour que la détection (anticipation comprise) soit prête
  var LA = Math.max(0, Math.ceil((laS + Nd / 2 + H / 2 - N / 2) / H));

  var p: MasterTransientParams = {
    emphasis: 27, adaptive: 50, bandTransient: [], bandGainDb: [], limitGainDb: 0, speedMs: 1, adaptiveGainDb: 0,
    adaptiveSpeed: 0, ceilingDb: -0.1, truePeak: true, clipDriveDb: 0, clipShape: 0, inputDb: 0, outputDb: 0,
    transientOn: true, limiterOn: true, clipperOn: true, soloBand: -1,
  };
  var bandT = new Float64Array(NB), bandGainLin = new Float64Array(NB);
  for (var b0 = 0; b0 < NB; b0++) { bandT[b0] = 100; bandGainLin[b0] = 1; }

  // ── FFT complexe radix 2 (en place), une par taille ───────────────────
  function makeFft(n: number) {
    var LOG = 0; while ((1 << LOG) < n) LOG++;
    var rev = new Int32Array(n);
    for (var i = 0; i < n; i++) { var r = 0; for (var k = 0; k < LOG; k++) r |= ((i >> k) & 1) << (LOG - 1 - k); rev[i] = r; }
    var cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
    for (var t = 0; t < n / 2; t++) { cs[t] = Math.cos(2 * Math.PI * t / n); sn[t] = Math.sin(2 * Math.PI * t / n); }
    return function (re: Float64Array, im: Float64Array, inv: boolean) {
      for (var i = 0; i < n; i++) { var j = rev[i]; if (j > i) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; } }
      var sg = inv ? 1 : -1;
      for (var size = 2; size <= n; size <<= 1) {
        var half = size >> 1, step = n / size;
        for (var st = 0; st < n; st += size) {
          for (var k = 0; k < half; k++) {
            var wr = cs[k * step], wi = sg * sn[k * step];
            var a = st + k, bb = a + half;
            var xr = re[bb] * wr - im[bb] * wi, xi = re[bb] * wi + im[bb] * wr;
            re[bb] = re[a] - xr; im[bb] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
        }
      }
    };
  }
  var fft = makeFft(N), fftD = makeFft(Nd);

  // ── Fenêtres et poids des bandes (triangulaires, somme = 1) ───────────
  var C = prof.centers;
  function weights(n: number) {
    var nh = n / 2 + 1, lo = new Int32Array(nh), w = new Float64Array(nh);
    for (var k = 0; k < nh; k++) {
      var f = k * SR / n;
      if (f >= C[NB - 1]) { lo[k] = NB - 2; w[k] = 0; continue; }
      var j = 0; while (j < NB - 2 && C[j + 1] <= f) j++;
      lo[k] = j; w[k] = 1 - (f - C[j]) / (C[j + 1] - C[j]);
    }
    return { lo: lo, w: w };
  }
  var WM = weights(N), bLo = WM.lo, wLo = WM.w;
  // égaliseur : poids mesurés par case (interpolés en fréquence si la fréquence d'échantillonnage diffère)
  var eqM: Float64Array[] | null = null, eqBin = new Float64Array(NH), eqFlat = true;
  if (prof.eqShapes && prof.eqShapes.length === NB) {
    eqM = [];
    for (var be = 0; be < NB; be++) {
      var sh = prof.eqShapes[be], row = new Float64Array(NH);
      for (var ke = 0; ke < NH; ke++) {
        var pos = ke * SR / N / 93.75 - sh[0], i0 = Math.floor(pos), t0 = pos - i0;
        var v0 = i0 >= 0 && i0 < sh[1].length ? sh[1][i0] : 0, v1 = i0 + 1 >= 0 && i0 + 1 < sh[1].length ? sh[1][i0 + 1] : 0;
        row[ke] = v0 + (v1 - v0) * t0;
      }
      eqM.push(row);
    }
  }
  eqBin.fill(1);
  var WD = weights(Nd), bLoD = WD.lo, wLoD = WD.w;
  var win = new Float64Array(N), winD = new Float64Array(Nd);
  for (var w0 = 0; w0 < N; w0++) win[w0] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * w0 / N));
  for (var w1 = 0; w1 < Nd; w1++) winD[w1] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w1 / Nd);
  var olaNorm = 1 / ((N / H) / 2);

  // ── États ─────────────────────────────────────────────────────────────
  var inBufL = new Float64Array(N), inBufR = new Float64Array(N), inPos = 0, count = 0;
  var QN = LA + 1; // trames de synthèse en attente
  var qRe: Float64Array[] = [], qIm: Float64Array[] = [];
  for (var q0 = 0; q0 < QN; q0++) { qRe.push(new Float64Array(N)); qIm.push(new Float64Array(N)); }
  var qHead = 0, qFill = 0;
  var re = new Float64Array(N), im = new Float64Array(N), reD = new Float64Array(Nd), imD = new Float64Array(Nd);
  var OUTN = 2 * N + LA * H + H;
  var accL = new Float64Array(OUTN), accR = new Float64Array(OUTN);
  var LAT = N + LA * H; // latence du banc de filtres (échantillons)
  var E = new Float64Array(NB), Ed = new Float64Array(NB), Emain = new Float64Array(NB), Ptot = 0;
  // bandes graves (centre < 1 kHz) : la petite trame est trop grossière en fréquence (cases de 375 Hz à 48 kHz) ;
  // leur détection prend l'énergie de la dernière grande trame (cases de 94 Hz)
  var LOWB = 7;
  var Pf = new Float64Array(NB), Ps = new Float64Array(NB), Lt = new Float64Array(NB), Sv = new Float64Array(NB), age = new Float64Array(NB);
  var HISTN = 4 * (LA + 2) * (H / Hd) + 64;
  var Shist = new Float64Array(HISTN * NB), jLast = -1;
  var gLim = new Float64Array(NB), gCom = 1, curGr = new Float64Array(NB), devB = new Float64Array(NB);
  var glB = new Float64Array(NB).fill(1), gaB = new Float64Array(NB).fill(1);
  var tdOn = !!(prof.limTd && makeLimiter);
  // tour 3 : la crête d'une bande dépasse son amplitude « sinus » estimée sur la trame (facteur de crête)
  var ownK = Math.pow(10, (prof.limOwnDb || 0) / 20), tdScale = 1;
  var asK = 0;
  var cDev = 1 - (prof.limAdTauMs ? Math.exp(-H / (prof.limAdTauMs * 0.001 * SR)) : 0);
  var G = new Float64Array(NB), gBin = new Float64Array(NH);
  var limiter: any = makeLimiter ? makeLimiter(SR) : null;
  var tmp = { l: new Float32Array(128), r: new Float32Array(128) };
  var dlyL = new Float64Array(1), dlyR = new Float64Array(1), dlyPos = 0;
  var mIn = 0, mOut = 0, mEmph = 1, mGr = 1;
  var bandEmphMax = new Float64Array(NB), bandGrMax = new Float64Array(NB);

  var EPS = 1e-9; // plancher d'énergie (≈ −120 dBFS) : le silence ne déclenche rien
  var d0e = 1, cAf = 1, cRf = 1, cAs = 1, cRs = 1, cGs = 1, cLt = 1, holdHops = 0, qExp = 1, emA = 0, adA = 0;
  var gin = 1, gout = 1, limG = 1, limThr = 1, agDb = 0, cRelB = new Float64Array(NB);
  var clipKw = 0.5, clipKnee0 = 0.5, clipDrive = 1, ceilLin = 1, clipMeas = false, clipKexp = 4;
  function coefD(ms: number) { return ms <= 0 ? 1 : 1 - Math.exp(-Hd / (ms * 0.001 * SR)); }
  function coefM(ms: number) { return ms <= 0 ? 1 : 1 - Math.exp(-H / (ms * 0.001 * SR)); }
  function interp(x: number, xs: number[], ys: number[]) {
    var n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    for (var i = 1; i < n; i++) if (x <= xs[i]) { var t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + (ys[i] - ys[i - 1]) * t; }
    return ys[n - 1];
  }
  function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }
  /** Gain du limiteur multibande pour une amplitude a : loi statique mesurée (réduction selon le dépassement du plafond), puis limitation. */
  function kneeGain(a: number) {
    var xs = prof.limGrOver, ys = prof.limGrDb;
    if (!xs || !xs.length) return a > limThr ? limThr / a : 1;
    var over = 20 * Math.log10(a / limThr + 1e-12);
    if (over <= xs[0]) return 1;
    var n = xs.length;
    var gr = over >= xs[n - 1] ? ys[n - 1] + (over - xs[n - 1]) : interp(over, xs, ys);
    return Math.pow(10, -gr / 20);
  }

  function derive() {
    var a = clamp(+p.adaptive || 0, 0, 100) / 100;
    adA = a;
    var stretch = 1 + prof.adK * Math.pow(a, prof.adP);
    cAf = coefD(prof.afMs); cRf = coefD(prof.rfMs); cAs = coefD(prof.asMs); cRs = coefD(prof.rsMs);
    cGs = coefD(prof.gsMs * stretch); cLt = coefD(prof.adLtMs);
    holdHops = prof.holdMs * 0.001 * SR / Hd;
    d0e = prof.d0 / (1 + (prof.adSens || 0) * a);
    qExp = prof.q > 0 ? prof.q : 1;
    emA = p.transientOn ? Math.pow(10, interp(clamp(+p.emphasis || 0, 0, 100), prof.emKnob, prof.emPeakDb) / 20) - 1 : 0;
    for (var b = 0; b < NB; b++) {
      var bt = p.bandTransient && p.bandTransient.length === NB ? +p.bandTransient[b] : 100;
      bandT[b] = clamp(bt === bt ? bt : 100, 0, 200);
      var bg = p.bandGainDb && p.bandGainDb.length === NB ? +p.bandGainDb[b] : 0;
      bandGainLin[b] = Math.pow(10, clamp(bg === bg ? bg : 0, -6, 6) / 20);
    }
    eqFlat = true;
    for (var bq = 0; bq < NB; bq++) if (bandGainLin[bq] !== 1) eqFlat = false;
    if (eqM) {
      for (var kq = 0; kq < NH; kq++) { var sq = 0; for (var bq2 = 0; bq2 < NB; bq2++) sq += eqM[bq2][kq] * bandGainLin[bq2]; eqBin[kq] = sq; }
    }
    gin = Math.pow(10, clamp(+p.inputDb || 0, -24, 24) / 20);
    gout = Math.pow(10, clamp(+p.outputDb || 0, -24, 24) / 20);
    limG = p.limiterOn ? Math.pow(10, clamp(+p.limitGainDb || 0, 0, 12) / 20) : 1;
    ceilLin = Math.pow(10, clamp(+p.ceilingDb, -12, 0) / 20);
    limThr = ceilLin * Math.pow(10, prof.limThrDb / 20);
    agDb = p.limiterOn ? clamp(+p.adaptiveGainDb || 0, 0, 12) : 0;
    tdScale = 1 - clamp((prof.limAdBeta || 0) * Math.pow(agDb / 6, prof.limAdP || 1), 0, 1);
    var sp = clamp(+p.speedMs, 0, 10);
    var as = clamp(+p.adaptiveSpeed || 0, 0, 100) / 100;
    for (var b2 = 0; b2 < NB; b2++) {
      // relâchement : vitesse × facteur ; vitesse adaptative = plus lent dans le grave, plus vif dans l'aigu
      cRelB[b2] = coefM((0.2 + sp) * prof.limRelK * Math.pow(prof.limRelRefHz / Math.max(C[b2], 40), prof.limAdaptExp * as));
    }
    clipDrive = p.clipperOn ? Math.pow(10, clamp(+p.clipDriveDb || 0, 0, 12) / 20) : 1;
    clipKw = 0.5 * (1 - clamp(+p.clipShape || 0, 0, 100) / 100);
    clipKnee0 = 1 - clipKw;
    clipMeas = !!(prof.clipLogK && prof.clipDrives && prof.clipShapes) && p.clipperOn && clipDrive > 1.0001;
    if (clipMeas) {
      // ln k : interpolation bilinéaire (poussée en dB, forme en %)
      var dds = prof.clipDrives as number[], shs = prof.clipShapes as number[], lk = prof.clipLogK as number[][];
      var dv = clamp(+p.clipDriveDb || 0, dds[0], dds[dds.length - 1]), sv = clamp(+p.clipShape || 0, shs[0], shs[shs.length - 1]);
      var di = 0; while (di < dds.length - 2 && dds[di + 1] < dv) di++;
      var si = 0; while (si < shs.length - 2 && shs[si + 1] < sv) si++;
      var td = (dv - dds[di]) / (dds[di + 1] - dds[di]), ts = (sv - shs[si]) / (shs[si + 1] - shs[si]);
      var l0 = lk[di][si] + (lk[di][si + 1] - lk[di][si]) * ts, l1 = lk[di + 1][si] + (lk[di + 1][si + 1] - lk[di + 1][si]) * ts;
      clipKexp = Math.exp(l0 + (l1 - l0) * td);
    }
    // Limiteur large bande final : plafond (simple protection à 0 dBTP quand le limiteur est coupé).
    // Anticipation fixe : la latence ne change jamais (PDC), crête vraie ou non.
    asK = (prof.limTdAsK || 0) * as;
    var laMul = Math.max(0.05, 1 + ((prof.limTdAsLa || 1) - 1) * as);
    if (limiter && prof.limTd) {
      // Tour 3 : réduction commune par échantillon (coude doux mesuré) ; anticipation fixe (PDC)
      var on = !!p.limiterOn && limG > 1.0001;
      limiter.setParams({
        ceilingDb: p.limiterOn ? clamp(+p.ceilingDb, -12, 0) : 0, inputGainDb: 0, lookaheadMs: prof.limLaMs || 1.5,
        releaseMs: Math.max(0.02, (prof.limTdRelK || 1) * ((prof.limTdRelA || 0) + sp) * Math.pow(prof.limTdAsMul || 1, as)),
        oversample: p.truePeak ? (prof.limTdOs || 4) : 1, kneeOverDb: on ? prof.limKneeOver : [], kneeGrDb: on ? prof.limKneeGr : [],
        detLookMs: prof.limTdLa1 ? Math.min(prof.limLaMs || 1.5, prof.limTdLa1 * laMul * Math.pow(Math.max(sp, 0.1), prof.limTdEla || 0)) : 0,
        attackMs: prof.limTdAtt1 ? prof.limTdAtt1 * laMul * Math.pow(Math.max(sp, 0.1), prof.limTdEatt || 0) : (prof.limAttMs || 0),
        holdMs: on ? (prof.limHoldMs || 0) : 0, releaseDb: !!prof.limTdRelDb, grScale: tdScale, grSlowMs: prof.limAdSlowMs || 0,
      });
    } else if (limiter) limiter.setParams({ ceilingDb: p.limiterOn ? clamp(+p.ceilingDb, -12, 0) : 0, inputGainDb: 0, releaseMs: Math.max(1, (prof.limFinRelMs || 30) * (0.2 + sp)), lookaheadMs: 1.5, oversample: p.truePeak ? 4 : 1 });
  }

  function resetState() {
    inBufL.fill(0); inBufR.fill(0); inPos = 0; count = 0; qHead = 0; qFill = 0;
    for (var q = 0; q < QN; q++) { qRe[q].fill(0); qIm[q].fill(0); }
    accL.fill(0); accR.fill(0);
    Pf.fill(EPS); Ps.fill(Math.pow(EPS, qExp)); Lt.fill(EPS); Emain.fill(0); Sv.fill(0); age.fill(0); Shist.fill(0); jLast = -1;
    gLim.fill(1); gCom = 1; curGr.fill(0); devB.fill(0); glB.fill(1); gaB.fill(1);
    if (limiter) limiter.reset();
  }

  /** Détection (tous les Hd échantillons) : énergie par bande sur les Nd derniers échantillons, enveloppes, emphase S. */
  function detectHop() {
    var st = (inPos + N - Nd) % N;
    for (var i = 0; i < Nd; i++) { var ix = (st + i) % N; reD[i] = inBufL[ix] * winD[i]; imD[i] = inBufR[ix] * winD[i]; }
    fftD(reD, imD, false);
    Ed.fill(0);
    for (var k = 0; k < NHd; k++) {
      var kr = k === 0 ? 0 : Nd - k;
      var pk = 0.5 * (reD[k] * reD[k] + imD[k] * imD[k] + reD[kr] * reD[kr] + imD[kr] * imD[kr]);
      var w = wLoD[k], bl = bLoD[k];
      Ed[bl] += w * pk; Ed[bl + 1] += (1 - w) * pk;
    }
    for (var lb = 0; lb < LOWB; lb++) Ed[lb] = Emain[lb];
    var j = (count + N - Nd) / Hd; // index absolu de la trame de détection (même numérotation que le modèle du labo)
    var o = (j % HISTN) * NB;
    var eps = EPS;
    for (var b = 0; b < NB; b++) {
      var gl = glB[b]; // l'emphase suit le limiteur (comme l'original)
      var e = Ed[b] * gl * gl * gin * gin + eps;
      var pf = Pf[b];
      pf = e > pf ? pf + (e - pf) * cAf : pf + (e - pf) * cRf;
      Pf[b] = pf;
      var eq = qExp === 1 ? pf : Math.pow(pf, qExp);
      var ps = Ps[b];
      ps = eq > ps ? ps + (eq - ps) * cAs : ps + (eq - ps) * cRs;
      Ps[b] = ps;
      var d = 10 / qExp * Math.log10((eq + eps) / (ps + eps));
      var s = d > 0 ? 1 - Math.exp(-Math.pow(d / d0e, prof.p)) : 0;
      if (prof.wneg > 0 && d < 0) s += prof.wneg * (1 - Math.exp(-Math.pow(-d / d0e, prof.p)));
      if (adA > 0) {
        var lt = Lt[b] + (pf - Lt[b]) * cLt;
        Lt[b] = lt;
        var rlt = lt / (pf + eps); if (rlt > 1) rlt = 1;
        s = s * (1 - prof.adBg * adA * Math.sqrt(rlt));
      }
      var sv = Sv[b];
      if (s >= sv) { sv = s; age[b] = 0; }
      else { age[b] += 1; if (age[b] > holdHops) sv += (s - sv) * cGs; }
      Sv[b] = sv;
      Shist[o + b] = sv;
    }
    jLast = j;
  }

  /** Synthèse (tous les H échantillons) : analyse de la trame la plus récente, synthèse de la trame vieille de LA pas. */
  function hop() {
    for (var i = 0; i < N; i++) { var ix = (inPos + i) % N; re[i] = inBufL[ix] * win[i]; im[i] = inBufR[ix] * win[i]; }
    fft(re, im, false);
    var slot = (qHead + qFill) % QN;
    if (qFill === QN) { slot = qHead; qHead = (qHead + 1) % QN; } else qFill++;
    qRe[slot].set(re); qIm[slot].set(im);
    // énergie par bande de la trame la plus récente (détection des graves, limiteur)
    E.fill(0);
    Ptot = 0;
    for (var k = 0; k < NH; k++) {
      var kr = k === 0 ? 0 : N - k;
      var pk = 0.5 * (re[k] * re[k] + im[k] * im[k] + re[kr] * re[kr] + im[kr] * im[kr]);
      var w = wLo[k], bl = bLo[k];
      E[bl] += w * pk; E[bl + 1] += (1 - w) * pk;
      Ptot += pk;
    }
    for (var lb = 0; lb < LOWB; lb++) Emain[lb] = E[lb];
    if (asK !== 0 && limiter && limiter.setReleaseScale) {
      // vitesse adaptative : centroïde spectral de la trame la plus récente
      var ce = 0, cs = 1e-20;
      for (var bc = 0; bc < NB; bc++) { ce += E[bc] * C[bc]; cs += E[bc]; }
      var cent = ce / cs;
      limiter.setReleaseScale(Math.pow((cent > 20 ? cent : 20) / 1000, -asK));
    }
    // ── limiteur multibande (sur la trame la plus récente : il anticipe de LA trames) ──
    if (p.limiterOn && limG > 1.0001) {
      var ampK = 2 / N; // amplitude (sinus) ≈ 2·√E / N
      var aTot = ampK * Math.sqrt(Ptot) * limG * gin;
      var gtc = kneeGain(aTot);
      gCom = gtc < gCom ? gtc : gCom + (gtc - gCom) * cRelB[8];
      var rc = -20 * Math.log10(gCom);
      for (var b = 0; b < NB; b++) {
        var a = ampK * Math.sqrt(E[b]) * limG * gin * ownK;
        var gt = kneeGain(a);
        var g = gLim[b];
        g = gt < g ? gt : g + (gt - g) * cRelB[b];
        gLim[b] = g;
        // gain adaptatif : la réduction d'une bande s'écarte d'au plus agDb de la réduction commune
        var dev = clamp((tdOn ? (prof.limAdGamma !== undefined ? prof.limAdGamma : 1) : 1) * (-20 * Math.log10(g) - rc), -agDb, agDb);
        var rr = rc + dev;
        curGr[b] = rr > 0 ? rr : 0;
        // tour 3 : la réduction commune est faite dans le temps (limiteur final) ; la bande ne porte que l'écart,
        // ou, avec le gain adaptatif (limAdBeta), ce que la part commune réduite ne fait plus
        var dv = tdOn ? (prof.limAdBeta && !prof.limAdSlowMs ? Math.max(0, -20 * Math.log10(g) - tdScale * rc) : dev) : 0;
        // écart lissé (l'adaptation des bandes est lente : moyenne sur limAdTauMs)
        devB[b] = cDev < 1 ? devB[b] + (dv - devB[b]) * cDev : dv;
        // gains linéaires de la trame, calculés UNE fois (la détection les relit 4 fois par trame)
        glB[b] = curGr[b] > 0 ? Math.pow(10, -curGr[b] / 20) : 1;
        gaB[b] = tdOn ? (devB[b] !== 0 ? Math.pow(10, -devB[b] / 20) : 1) : glB[b];
      }
    } else if (curGr[0] !== 0 || curGr[NB - 1] !== 0) {
      curGr.fill(0); gLim.fill(1); gCom = 1; devB.fill(0); glB.fill(1); gaB.fill(1);
    }
    if (qFill < QN) return; // file pas encore pleine : rien à synthétiser
    // ── emphase de la trame m = la plus ancienne de la file ──
    var m = count / H - LA;
    var jc = (m * H + N / 2 + laS - Nd / 2) / Hd;
    var j0 = Math.ceil(jc - (H / 2) / Hd), j1 = Math.floor(jc + (H / 2) / Hd);
    if (j1 > jLast) j1 = jLast;
    if (j0 < 0) j0 = 0;
    if (j0 < jLast - HISTN + 1) j0 = jLast - HISTN + 1;
    for (var b4 = 0; b4 < NB; b4++) {
      var smx = 0;
      for (var jj = j0; jj <= j1; jj++) { var v = Shist[(jj % HISTN) * NB + b4]; if (v > smx) smx = v; }
      var ge = 1 + emA * bandT[b4] / 100 * smx;
      var gl2 = glB[b4];
      var ga = gaB[b4];
      G[b4] = ge * ga * (eqM ? 1 : bandGainLin[b4]) * limG * gin;
      if (p.soloBand >= 0 && p.soloBand < NB && p.soloBand !== b4) G[b4] = 0;
      if (ge > mEmph) mEmph = ge;
      if (gl2 < mGr) mGr = gl2;
      var ed = 20 * Math.log10(ge); if (ed > bandEmphMax[b4]) bandEmphMax[b4] = ed;
      if (curGr[b4] > bandGrMax[b4]) bandGrMax[b4] = curGr[b4];
    }
    for (var k2 = 0; k2 < NH; k2++) gBin[k2] = wLo[k2] * G[bLo[k2]] + (1 - wLo[k2]) * G[bLo[k2] + 1];
    if (eqM && !eqFlat) for (var k4 = 0; k4 < NH; k4++) gBin[k4] *= eqBin[k4];
    var sr = qRe[qHead], si = qIm[qHead];
    for (var k3 = 0; k3 < N; k3++) {
      var gg = gBin[k3 <= N / 2 ? k3 : N - k3];
      re[k3] = sr[k3] * gg; im[k3] = si[k3] * gg;
    }
    fft(re, im, true);
    // addition-recouvrement : la trame m couvre les échantillons d'entrée [mH − N, mH)
    var s0 = m * H - N;
    var base = ((s0 % OUTN) + OUTN) % OUTN;
    for (var i2 = 0; i2 < N; i2++) {
      var o = (base + i2) % OUTN;
      var wv = win[i2] * olaNorm / N;
      accL[o] += re[i2] * wv; accR[o] += im[i2] * wv;
    }
  }

  /** Clipper doux : identité sous le coude, puis tangente hyperbolique jusqu'au plafond (forme 100 % = écrêtage dur). */
  /** Saturation mesurée (profil clipLogK) : plafond · v / (1 + |v|^k)^(1/k). */
  function measClip(x: number) {
    var v = x * clipDrive, av = v < 0 ? -v : v;
    if (av < 1e-9) return x * clipDrive * ceilLin;
    var y = av / Math.pow(1 + Math.pow(av, clipKexp), 1 / clipKexp);
    return (v < 0 ? -y : y) * ceilLin;
  }

  function softClip(x: number) {
    if (!p.clipperOn || clipDrive <= 1.0001) return x;
    var v = x * clipDrive / ceilLin, av = v < 0 ? -v : v;
    if (av <= clipKnee0) return x * clipDrive;
    var y = clipKw > 1e-6 ? clipKnee0 + clipKw * Math.tanh((av - clipKnee0) / clipKw) : 1;
    return (v < 0 ? -y : y) * ceilLin;
  }

  derive();
  resetState();

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number) {
    var right = inR || inL;
    if (tmp.l.length < n) { tmp.l = new Float32Array(n); tmp.r = new Float32Array(n); }
    var tl = tmp.l, tr = tmp.r;
    for (var i = 0; i < n; i++) {
      var xl = inL[i], xr = right[i];
      var ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      if (ax > mIn) mIn = ax;
      inBufL[inPos] = xl; inBufR[inPos] = xr;
      inPos = (inPos + 1) % N;
      // sortie : échantillon d'entrée count − LAT (complet : toutes ses trames sont synthétisées)
      var pp = count - LAT;
      if (pp >= 0) { var o = pp % OUTN; tl[i] = accL[o]; tr[i] = accR[o]; accL[o] = 0; accR[o] = 0; }
      else { tl[i] = 0; tr[i] = 0; }
      count++;
      if (count % Hd === 0) detectHop();
      if (count % H === 0) hop();
    }
    // clipper mesuré : avant le plafond en crête vraie (le limiteur final rattrape les crêtes entre échantillons)
    if (clipMeas) for (var jc = 0; jc < n; jc++) { tl[jc] = measClip(tl[jc]); tr[jc] = measClip(tr[jc]); }
    // limiteur large bande (plafond), clipper, gain de sortie
    if (limiter) {
      if (p.limiterOn || p.protect !== false) limiter.process(tl, tr, tl, tr, n);
      else {
        // sans protection (labo) : simple retard de la même durée (latence inchangée)
        var dl = limiter.latencySamples();
        if (dlyL.length !== dl + 1) { dlyL = new Float64Array(dl + 1); dlyR = new Float64Array(dl + 1); dlyPos = 0; }
        for (var q = 0; q < n; q++) {
          dlyL[dlyPos] = tl[q]; dlyR[dlyPos] = tr[q];
          var rp = (dlyPos + 1) % (dl + 1);
          tl[q] = dlyL[rp]; tr[q] = dlyR[rp];
          dlyPos = rp;
        }
      }
    }
    for (var j = 0; j < n; j++) {
      var yl = (clipMeas ? tl[j] : softClip(tl[j])) * gout, yr = (clipMeas ? tr[j] : softClip(tr[j])) * gout;
      outL[j] = yl; if (outR) outR[j] = yr;
      var ay = Math.max(yl < 0 ? -yl : yl, yr < 0 ? -yr : yr);
      if (ay > mOut) mOut = ay;
    }
  }

  return {
    setParams: function (np: Partial<MasterTransientParams>) {
      for (var key in np) { var v = (np as any)[key]; if (v !== undefined && v !== null) (p as any)[key] = v; }
      derive();
    },
    process: process,
    latencySamples: function () { return LAT + (limiter ? limiter.latencySamples() : 0); },
    takeMeters: function () {
      var r = {
        emphDb: 20 * Math.log10(mEmph), grDb: -20 * Math.log10(Math.max(1e-6, mGr)),
        inPeakDb: 20 * Math.log10(Math.max(1e-9, mIn)), outPeakDb: 20 * Math.log10(Math.max(1e-9, mOut)),
        bandEmphDb: Array.prototype.slice.call(bandEmphMax), bandGrDb: Array.prototype.slice.call(bandGrMax),
      };
      mIn = 0; mOut = 0; mEmph = 1; mGr = 1; bandEmphMax.fill(0); bandGrMax.fill(0);
      return r;
    },
    reset: resetState,
  };
}
