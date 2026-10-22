/**
 * Cœur DSP du « Compresseur multibande » NOVA, en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet (la fonction est sérialisée par `toString()` :
 * elle ne doit RIEN référencer en dehors d'elle-même) et dans les tests vitest.
 *
 * Banc de filtres : Linkwitz-Riley 4e ordre (deux Butterworth 2e ordre en cascade, Q = 1/√2),
 * recombinaison à phase cohérente. Pour chaque coupure, LP⁴ + HP⁴ = passe-tout du 2e ordre
 * (même fréquence, Q = 1/√2) : la bande grave reçoit le passe-tout des coupures qu'elle ne
 * traverse pas, et la somme des bandes vaut x filtré par trois passe-tout, donc une réponse
 * en amplitude PLATE (au calcul flottant près) quand rien ne compresse.
 *
 *   x ─┬─ LP1² ── AP2 ── AP3 ───────────────► bande 1
 *      └─ HP1² ─┬─ LP2² ── AP3 ─────────────► bande 2
 *               └─ HP2² ─┬─ LP3² ───────────► bande 3
 *                        └─ HP3² ───────────► bande 4
 *
 * La structure à 4 bandes tourne toujours : en mode 3 bandes, les bandes 3 et 4 sont
 * additionnées (LP3² + HP3² = AP3) et traitées par le compresseur de la bande 3. Passer de
 * 3 à 4 bandes ne change donc pas la phase (aucun clic), seulement qui compresse l'aigu.
 *
 * Compresseur de chaque bande : détecteur crête stéréo couplé (max |G|, |D|), puis enveloppe :
 *   crête p = max(|x|, p relâchée vers |x| en « relâchement » (un pôle)) ;
 *   niveau e monte vers p en « attaque » (un pôle) et suit p dès qu'elle redescend.
 * Sur un son tenu, e = la crête (le seuil affiché est le vrai seuil, à ±0,05 dB) ; attaque et
 * relâchement sont les constantes de temps (63 %) de la montée et du retour du niveau détecté.
 * (Avant le 22/10/2026 : un seul pôle à deux vitesses sur |x|, qui se calait SOUS la crête :
 * −0,8 dB à 10 / 200 ms, −15 dB à 200 / 5 ms — le seuil réel n'était pas celui affiché.)
 * Loi statique en dB à genou doux
 * (Giannoulis, Massberg et Reiss, « Digital Dynamic Range Compressor Design — A Tutorial
 * and Analysis », JAES 2012) : réduction = (1 − 1/taux) × dépassement, genou de largeur W.
 * Sous le genou, aucun logarithme n'est calculé (seuil linéaire précalculé).
 *
 * Sans clic : seuil, taux, gain de bande, contournement, solo, genou et sortie glissent
 * linéairement sur 256 échantillons ; les fréquences de coupure glissent (log) par
 * sous-blocs de 32 échantillons. Aucune allocation dans `process`. Latence nulle.
 *
 * Clé externe (side-chain, 22/10/2026) : `keyL` / `keyR` présents, chaque bande DÉTECTE dans la
 * même bande de la clé (même banc de filtres, états à part) et compresse le son de la piste :
 * le grave du beat qui se creuse sous le kick, sans toucher à ses aigus. Sans clé : inchangé.
 */

export interface MultibandCoreParams { [k: string]: number | boolean | undefined }

export interface MultibandMeters {
  /** Réduction max par bande depuis la dernière lecture (dB, ≥ 0). */
  gr: number[];
  /** Réduction courante par bande (dB, ≥ 0). */
  grNow: number[];
  inPeakDb: number;
  outPeakDb: number;
}

export interface MultibandCore {
  setParams(p: MultibandCoreParams): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number, keyL?: Float32Array | null, keyR?: Float32Array | null): void;
  takeMeters(): MultibandMeters;
  reset(): void;
  /** Au repos (veille) : filtres vides (< 1e-12), aucune réduction possible, aucun glissement en cours. */
  atRest(): boolean;
  /** Rattrapage de K échantillons muets sautés pendant la veille (enveloppes en relâchement). */
  catchUp(K: number): void;
}

export function createMultibandCore(sampleRate: number): MultibandCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var NB = 4;
  var RAMP = 256;
  var SUB = 32;
  // --- banc de filtres : coefficients par coupure (LP, HP, AP) et états DF-I ---------
  // C[k*15 + t*5 + i] : k = coupure 0..2, t = 0 LP, 1 HP, 2 AP.
  var C = new Float64Array(45);
  // 15 étages par canal : 0-1 LP1, 2-3 HP1, 4-5 LP2, 6-7 HP2, 8 AP2 (grave), 9-10 LP3, 11-12 HP3, 13 AP3 (grave), 14 AP3 (bande 2)
  var S = new Float64Array(15 * 2 * 4);
  // États du même banc de filtres pour la clé externe (side-chain).
  var KS = new Float64Array(15 * 2 * 4);
  var fCur = new Float64Array(3), fTgt = new Float64Array(3);
  var gliding = false;
  // --- réglages lissés : [cur, tgt, step, count] par réglage --------------------------
  // par bande b : 0 seuil (dB), 1 k = 1 − 1/taux, 2 gain de bande (linéaire), 3 contournement (0/1), 4 solo (poids 0/1)
  // globaux : 20 genou (dB), 21 sortie (linéaire)
  var NP = 22;
  var Pc = new Float64Array(NP), Pt = new Float64Array(NP), Ps = new Float64Array(NP);
  var Pn = new Int32Array(NP);
  var ramping = 0;
  // --- détecteurs ------------------------------------------------------------------------
  var env = new Float64Array(NB), pk = new Float64Array(NB);
  var cA = new Float64Array(NB), cR = new Float64Array(NB);
  var grNow = new Float64Array(NB), grMax = new Float64Array(NB);
  var linLo = new Float64Array(NB);
  var inPk = 0, outPk = 0;
  var bands = 3;
  var enabled = true;
  var first = true;

  function coef(ms: number) { return 1 - Math.exp(-1 / (Math.max(0.01, ms) * 0.001 * SR)); }
  function num(v: any, d: number) { var x = +v; return x === x && isFinite(x) ? x : d; }
  function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }

  function design(k: number, f: number) {
    var fc = clamp(f, 20, SR * 0.45);
    var w0 = 2 * Math.PI * fc / SR, cw = Math.cos(w0), sw = Math.sin(w0);
    var al = sw / (2 * Math.SQRT1_2), a0 = 1 + al;
    var a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    var o = k * 15;
    // passe-bas Butterworth
    C[o] = (1 - cw) / 2 / a0; C[o + 1] = (1 - cw) / a0; C[o + 2] = C[o]; C[o + 3] = a1; C[o + 4] = a2;
    // passe-haut Butterworth
    C[o + 5] = (1 + cw) / 2 / a0; C[o + 6] = -(1 + cw) / a0; C[o + 7] = C[o + 5]; C[o + 8] = a1; C[o + 9] = a2;
    // passe-tout (LP⁴ + HP⁴ du Linkwitz-Riley)
    C[o + 10] = a2; C[o + 11] = a1; C[o + 12] = 1; C[o + 13] = a1; C[o + 14] = a2;
  }

  function setP(i: number, v: number, instant: boolean) {
    if (instant) { Pc[i] = v; Pt[i] = v; Pn[i] = 0; return; }
    if (v === Pt[i] && (Pn[i] > 0 || Pc[i] === v)) return;
    Pt[i] = v;
    if (Pc[i] === v) { if (Pn[i] > 0) { Pn[i] = 0; ramping--; } return; }
    Ps[i] = (v - Pc[i]) / RAMP;
    if (Pn[i] === 0) ramping++;
    Pn[i] = RAMP;
  }

  function updateLinLo() {
    var W = Math.min(Pc[20], Pt[20]);
    for (var b = 0; b < NB; b++) {
      var t = Math.min(Pc[b * 5], Pt[b * 5]);
      // Taux 1:1 (k = 0 partout) : jamais de réduction, le logarithme n'est jamais calculé.
      linLo[b] = (Pc[b * 5 + 1] <= 0 && Pt[b * 5 + 1] <= 0) ? Infinity : Math.pow(10, (t - W / 2) / 20) * (1 - 1e-9);
    }
  }

  function setParams(p: MultibandCoreParams) {
    var inst = first;
    bands = num(p.bands, 3) >= 3.5 ? 4 : 3;
    enabled = p.isEnabled !== false;
    var anySolo = false;
    for (var b = 0; b < NB; b++) {
      var on = b < bands && num(p['b' + (b + 1) + 'Solo'], 0) >= 0.5;
      if (on) anySolo = true;
    }
    for (var b2 = 0; b2 < NB; b2++) {
      var pre = 'b' + (b2 + 1);
      setP(b2 * 5, clamp(num(p[pre + 'Thr'], 0), -80, 12), inst);
      var ratio = clamp(num(p[pre + 'Ratio'], 1), 1, 100);
      setP(b2 * 5 + 1, ratio >= 100 ? 1 : 1 - 1 / ratio, inst);
      setP(b2 * 5 + 2, Math.pow(10, clamp(num(p[pre + 'Gain'], 0), -36, 36) / 20), inst);
      setP(b2 * 5 + 3, num(p[pre + 'Byp'], 0) >= 0.5 ? 1 : 0, inst);
      var solo = b2 < bands && num(p[pre + 'Solo'], 0) >= 0.5;
      // Mode 3 bandes : la bande 4 suit la bande 3 (même compresseur, même solo).
      setP(b2 * 5 + 4, !anySolo || solo ? 1 : 0, inst);
      cA[b2] = coef(clamp(num(p[pre + 'Att'], 10), 0.05, 500));
      cR[b2] = coef(clamp(num(p[pre + 'Rel'], 200), 1, 5000));
    }
    setP(20, clamp(num(p.knee, 6), 0, 24), inst);
    setP(21, Math.pow(10, clamp(num(p.output, 0), -36, 36) / 20), inst);
    var xs = [clamp(num(p.x1, 200), 20, 20000), clamp(num(p.x2, 4000), 20, 20000), clamp(num(p.x3, 10000), 20, 20000)];
    // Coupures strictement croissantes (≥ 1/3 d'octave d'écart).
    if (xs[1] < xs[0] * 1.26) xs[1] = xs[0] * 1.26;
    if (xs[2] < xs[1] * 1.26) xs[2] = xs[1] * 1.26;
    for (var k = 0; k < 3; k++) {
      var f = Math.min(xs[k], SR * 0.45);
      fTgt[k] = f;
      if (inst) { fCur[k] = f; design(k, f); }
      else if (fCur[k] !== f) gliding = true;
    }
    updateLinLo();
  }

  function glideStep() {
    var still = false;
    for (var k = 0; k < 3; k++) {
      if (fCur[k] === fTgt[k]) continue;
      var lc = Math.log(fCur[k]), lt = Math.log(fTgt[k]);
      var d = lt - lc;
      // Pas borné (≤ 2 % de fréquence par sous-bloc de 32) : les passe-tout qui portent les autres
      // bandes ne sautent jamais (un grand saut de coefficients s'entendait en déplaçant une coupure).
      var st = d * 0.1;
      if (st > 0.02) st = 0.02; else if (st < -0.02) st = -0.02;
      if (d < 2e-4 && d > -2e-4) fCur[k] = fTgt[k];
      else { fCur[k] = Math.exp(lc + st); still = true; }
      design(k, fCur[k]);
    }
    gliding = still;
  }

  // Tampons de travail (alloués une fois) : entrée, intermédiaires, 4 bandes × 2 canaux × 128.
  var BLK = 128;
  var X = new Float64Array(BLK), T1 = new Float64Array(BLK), HI = new Float64Array(BLK), H = new Float64Array(BLK);
  var BB = new Float64Array(2 * NB * BLK);
  var KB = new Float64Array(2 * NB * BLK);

  // Un étage biquad DF-I sur len échantillons (coefficients et état en variables locales : rapide).
  function stage(ci: number, St: Float64Array, si: number, src: Float64Array, so: number, dst: Float64Array, dof: number, len: number) {
    var b0 = C[ci], b1 = C[ci + 1], b2 = C[ci + 2], a1 = C[ci + 3], a2 = C[ci + 4];
    var x1 = St[si], x2 = St[si + 1], y1 = St[si + 2], y2 = St[si + 3];
    for (var j = 0; j < len; j++) {
      var x = src[so + j];
      var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      dst[dof + j] = y;
    }
    St[si] = x1; St[si + 1] = x2; St[si + 2] = y1; St[si + 3] = y2;
  }

  // Banc de filtres d'un canal : X → 4 bandes dans B (canal c), états St (son : S → BB ; clé : KS → KB).
  function split(c: number, len: number, St: Float64Array, B: Float64Array) {
    var so = c * 60, o = c * NB * BLK;
    stage(0, St, so + 4, X, 0, T1, 0, len); stage(0, St, so, T1, 0, B, o, len);                 // LP1² → grave
    stage(5, St, so + 12, X, 0, T1, 0, len); stage(5, St, so + 8, T1, 0, HI, 0, len);           // HP1²
    stage(15, St, so + 20, HI, 0, T1, 0, len); stage(15, St, so + 16, T1, 0, B, o + BLK, len);  // LP2² → bande 2
    stage(20, St, so + 28, HI, 0, T1, 0, len); stage(20, St, so + 24, T1, 0, H, 0, len);        // HP2²
    stage(25, St, so + 32, B, o, B, o, len);                                                    // AP2 (grave)
    stage(30, St, so + 40, H, 0, T1, 0, len); stage(30, St, so + 36, T1, 0, B, o + 2 * BLK, len); // LP3² → bande 3
    stage(35, St, so + 48, H, 0, T1, 0, len); stage(35, St, so + 44, T1, 0, B, o + 3 * BLK, len); // HP3² → bande 4
    stage(40, St, so + 52, B, o, B, o, len);                                                    // AP3 (grave)
    stage(40, St, so + 56, B, o + BLK, B, o + BLK, len);                                        // AP3 (bande 2)
    if (bands === 3) { for (var j = 0; j < len; j++) { B[o + 2 * BLK + j] += B[o + 3 * BLK + j]; } }
  }

  var LN10_20 = Math.LN10 / 20, DB_PER_LN = 20 / Math.LN10;

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number, keyL?: Float32Array | null, keyR?: Float32Array | null) {
    // Réglages posés avant le premier bloc (construction, export) : appliqués tout de suite.
    first = false;
    var right = inR || inL;
    var stereo = !!inR;
    // Clé externe : la détection lit ses bandes (KB) ; clé mono = même bande des deux côtés.
    var key = !!keyL;
    var kStereo = key && !!keyR && keyR !== keyL;
    var D = key ? KB : BB;
    var i = 0;
    while (i < n) {
      if (gliding) glideStep();
      var len = Math.min(n - i, gliding ? SUB : BLK);
      if (ramping > 0) updateLinLo();
      // --- banc de filtres, par étage sur tout le morceau de bloc ---
      for (var j = 0; j < len; j++) X[j] = inL[i + j];
      split(0, len, S, BB);
      if (stereo) { for (var j2 = 0; j2 < len; j2++) X[j2] = right[i + j2]; split(1, len, S, BB); }
      var oR = stereo ? NB * BLK : 0;
      var oK = 0;
      if (key) {
        for (var j3 = 0; j3 < len; j3++) X[j3] = (keyL as Float32Array)[i + j3];
        split(0, len, KS, KB);
        if (kStereo) { for (var j4 = 0; j4 < len; j4++) X[j4] = (keyR as Float32Array)[i + j4]; split(1, len, KS, KB); oK = NB * BLK; }
      } else oK = oR;
      for (var t = 0; t < len; t++, i++) {
        var xl = inL[i], xr = right[i];
        var axl = xl < 0 ? -xl : xl, axr = xr < 0 ? -xr : xr;
        if (axl > inPk) inPk = axl;
        if (axr > inPk) inPk = axr;
        // --- réglages lissés ---
        if (ramping > 0) {
          for (var q = 0; q < NP; q++) {
            if (Pn[q] > 0) { Pc[q] += Ps[q]; if (--Pn[q] === 0) { Pc[q] = Pt[q]; ramping--; } }
          }
        }
        var W = Pc[20];
        var yl = 0, yr = 0;
        for (var b = 0; b < bands; b++) {
          var sl = BB[b * BLK + t], sr = BB[oR + b * BLK + t];
          var dl = D[b * BLK + t], dr = D[oK + b * BLK + t];
          var lv = dl < 0 ? -dl : dl, lr = dr < 0 ? -dr : dr;
          if (lr > lv) lv = lr;
          var p1 = pk[b];
          p1 = lv > p1 ? lv : p1 + (lv - p1) * cR[b];
          pk[b] = p1;
          var e = env[b];
          e = p1 > e ? e + (p1 - e) * cA[b] : p1;
          env[b] = e;
          var gr = 0;
          if (e > linLo[b]) {
            var over = DB_PER_LN * Math.log(e) - Pc[b * 5];
            var k2 = Pc[b * 5 + 1];
            if (over >= W / 2) gr = k2 * over;
            else if (over > -W / 2) gr = k2 * (over + W / 2) * (over + W / 2) / (2 * W);
          }
          var byp = Pc[b * 5 + 3];
          var grm = byp !== 0 ? gr * (1 - byp) : gr;
          grNow[b] = grm;
          if (grm > grMax[b]) grMax[b] = grm;
          var g = gr > 0 ? Math.exp(-gr * LN10_20) * Pc[b * 5 + 2] : Pc[b * 5 + 2];
          if (byp !== 0) g = byp + (1 - byp) * g;
          var w = Pc[b * 5 + 4] * g;
          yl += w * sl; yr += w * sr;
        }
        var og = Pc[21];
        yl *= og; yr *= og;
        if (!enabled) { yl = xl; yr = xr; }
        var ayl = yl < 0 ? -yl : yl, ayr = yr < 0 ? -yr : yr;
        if (ayl > outPk) outPk = ayl;
        if (ayr > outPk) outPk = ayr;
        outL[i] = yl;
        if (outR) outR[i] = yr;
      }
    }
    for (var z = 0; z < NB; z++) { if (env[z] < 1e-30) env[z] = 0; if (pk[z] < 1e-30) pk[z] = 0; }
  }

  function reset() {
    S.fill(0); KS.fill(0); env.fill(0); pk.fill(0); grNow.fill(0); grMax.fill(0); inPk = 0; outPk = 0;
    // Réglages et coupures posés tout de suite (instance neuve).
    for (var q = 0; q < NP; q++) { Pc[q] = Pt[q]; Pn[q] = 0; }
    ramping = 0;
    for (var k = 0; k < 3; k++) { fCur[k] = fTgt[k]; design(k, fCur[k]); }
    gliding = false;
    updateLinLo();
  }

  setParams({});

  var dbOf = function (x: number) { return x > 1e-6 ? 20 * Math.log10(x) : -120; };

  return {
    setParams: setParams,
    process: process,
    takeMeters: function () {
      var r = { gr: [grMax[0], grMax[1], grMax[2], grMax[3]], grNow: [grNow[0], grNow[1], grNow[2], grNow[3]], inPeakDb: dbOf(inPk), outPeakDb: dbOf(outPk) };
      for (var b = 0; b < NB; b++) grMax[b] = grNow[b];
      inPk = 0; outPk = 0;
      return r;
    },
    reset: reset,
    atRest: function () {
      if (ramping > 0 || gliding) return false;
      for (var i = 0; i < S.length; i++) { var v = S[i]; if (v > 1e-12 || v < -1e-12) return false; }
      // Enveloppes sous le genou : aucune réduction, la sortie d'une entrée muette est muette.
      for (var b = 0; b < NB; b++) if (env[b] > linLo[b] * 0.5 || pk[b] > linLo[b] * 0.5 || grNow[b] !== 0) return false;
      return true;
    },
    catchUp: function (K: number) {
      // Entrée muette : chaque crête relâche, le niveau la suit (même calcul que process jusqu'à 512 blocs).
      var blocks = Math.floor(K / 128);
      for (var b = 0; b < NB; b++) {
        var p = pk[b], e = env[b];
        for (var k = 0; k < blocks && (p !== 0 || e !== 0); k++) {
          if (k < 512) { for (var j = 0; j < 128; j++) { p += (0 - p) * cR[b]; e = p > e ? e + (p - e) * cA[b] : p; } }
          else { p *= Math.pow(1 - cR[b], 128); e = p > e ? e + (p - e) * (1 - Math.pow(1 - cA[b], 128)) : p; }
          if (p < 1e-30) p = 0;
          if (e < 1e-30) e = 0;
        }
        pk[b] = p; env[b] = e;
      }
    },
  };
}
