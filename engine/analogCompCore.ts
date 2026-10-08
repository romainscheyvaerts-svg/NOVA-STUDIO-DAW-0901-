/**
 * Cœur DSP des compresseurs « analogiques » de NOVA (Opto Vintage, FET 76,
 * Leveler 2A, Vox Strip), en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet (la fonction est sérialisée par
 * `toString()` : elle ne doit RIEN référencer en dehors d'elle-même) et dans
 * les tests vitest / le labo de mesure (tools/labo, via Node).
 *
 * Modèle « boîte noire » calé sur des mesures (tools/labo) : ce n'est pas un
 * compresseur générique, chaque appareil a son profil (tables mesurées) et
 * sa traduction des boutons (engine/analogCompMaps.ts). La chaîne, par canal :
 *
 *   entrée × gain -> étage d'entrée (saturation douce polynomiale + tanh)
 *   -> DÉTECTEUR : sidechain avant (feedforward) ou après (feedback) l'élément
 *      de gain, passe-haut, redressement simple ou double alternance, crête
 *      à montée / descente exponentielles, couplage stéréo éventuel
 *   -> LOI STATIQUE tabulée G(L) (genou, taux, saturation de la cellule)
 *   -> CELLULE, dans le domaine de l'atténuation A = 1/gain (linéaire) :
 *      montée exponentielle (deux étages en cascade, vitesse bornée),
 *      relâchement en pente constante + exponentielle, relâchement à deux
 *      temps (bref / long), mémoire de programme des cellules optiques
 *   -> gain = 1/A -> étage de sortie (saturation, asymétrie) -> couleur
 *      (4 biquads) -> gain de sortie -> mélange parallèle.
 *
 * Le portage Python ligne à ligne (tools/labo/modeles/analog_comp.py) sert au
 * calage ; le labo vérifie que les deux donnent la même chose.
 */

/** Indices du vecteur de paramètres internes (identiques au portage Python). */
export const AC = {
  PRE: 0, THR: 1, FB: 2, RECT: 3, DET_ATT: 4, ATT: 5, ATT_SLEW: 6, REL_SLEW: 7, REL_EXP: 8, REL2_SLEW: 9,
  HOLD: 10, MEM: 11, MEM_CH: 12, MEM_DIS: 13, IN_A2: 14, IN_A3: 15, OUT_A2: 16, OUT_A3: 17, MAKEUP: 18, MIX: 19,
  HP_B0: 20, HP_B1: 21, HP_B2: 22, HP_A1: 23, HP_A2: 24, LINK: 25, REL_DUCK: 26, IN_SAT: 27, OUT_SAT: 28,
  DET_REL: 29, ATT2: 30, REL2_FOLLOW: 31, EQ: 32, N_EQ: 4, DRIVE: 52, IN_BIAS: 53, OUT_BIAS: 54,
  FAST_ATT: 55, FAST_REL: 56, FAST_DET_REL: 57, FET_A2: 58, FINAL_SAT: 59, FINAL_BIAS: 60,
  SLOW_FRAC: 61, SLOW_ATT: 62, SLOW_REL: 63, OUT_AB: 64, IN_AB: 65, SC2: 66, OUT_KNEE: 71, XF_K: 72, XF_A: 73, XF_MODE: 74, EQ2: 80,
  /** Tour 2 : cellule multi-composantes en dB (3 x 8 : f, a, alpha, r, beta, l, vitesse max de montée), détecteur RMS, anticipation. */
  C3: 100, C3_K: 101, DET_SQ: 125, C3_ATT_DB: 126, C3_HOLD: 127,
  /** Latence DÉCLARÉE au PDC (échantillons) : avec le passe-tout fractionnaire, reproduit l'avance de phase mesurée. */
  LAT: 128,
  /** Étage de sortie TABULÉ (caractéristique de transfert mesurée) : v = asinh(u) dans [-WS_MAX, +WS_MAX], N_WS points dès WS. */
  WS_MAX: 129, WS: 130, N_WS: 257, NP: 387,
} as const;

export interface AnalogCompInternal {
  /** Vecteur de paramètres internes (AC.NP valeurs). */
  P: ArrayLike<number>;
  /** Loi statique : G (dB de réduction) tous les `dl` dB à partir de `l0` dB au-dessus du seuil. */
  tab: ArrayLike<number>;
  l0: number;
  dl: number;
}

export interface AnalogCompCore {
  setInternal(cfg: AnalogCompInternal): void;
  /**
   * keyL / keyR : clé de side-chain externe (R7) ; présente, elle remplace le
   * signal du détecteur (même étage d'entrée, en mode « avant » même pour un
   * appareil à contre-réaction : la clé ne passe pas par la cellule).
   */
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number, keyL?: Float32Array | null, keyR?: Float32Array | null): void;
  /** Mesures depuis le dernier appel : réduction de gain max et courante (dB, ≥ 0), crêtes entrée / sortie (dBFS). */
  takeMeters(): { grDb: number; grNowDb: number; inPeakDb: number; outPeakDb: number };
  /** Atténuation courante du canal gauche (pour les tests). */
  attenuation(): number;
  reset(): void;
}

export function createAnalogCompCore(sampleRate: number): AnalogCompCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  void SR;
  var NP = 387, NEQ = 8, PEQ = 32, PEQ2 = 80, NWS = 257;
  var P = new Float64Array(NP);
  var tab = new Float64Array([0, 0]);
  var l0 = -12, dl = 1;
  // P par défaut : passe-plat
  P[0] = 1; P[1] = 1e6; P[5] = 1; P[18] = 1; P[19] = 1;

  // États (2 canaux)
  var A = new Float64Array(2), A2 = new Float64Array(2), env = new Float64Array(2), mem = new Float64Array(2);
  var yprev = new Float64Array(2), above = new Float64Array(2), slowOk = new Float64Array(2);
  var hp = new Float64Array(8); // par canal : x1, x2, y1, y2
  var hp2 = new Float64Array(8);
  var flux = new Float64Array(2), fluxi = new Float64Array(2);
  var eqs = new Float64Array(2 * NEQ * 4);
  var lv = new Float64Array(2), xin = new Float64Array(2);
  var envf = new Float64Array(2), Af = new Float64Array(2), lvf = new Float64Array(2), As = new Float64Array(2);
  var gk = new Float64Array(6), hm = new Float64Array([1, 1]);
  var eqAct = new Int32Array(8);
  var mGrA = 1, mIn = 0, mOut = 0, curAe = 1;
  /** Les états des deux canaux sont identiques (après remise à zéro, tant que l'entrée reste mono). */
  var statesEq = true;

  /** Recopie l'état du canal gauche sur le droit (bloc mono traité une seule fois). */
  function copyState01() {
    A[1] = A[0]; A2[1] = A2[0]; env[1] = env[0]; mem[1] = mem[0]; yprev[1] = yprev[0]; above[1] = above[0];
    slowOk[1] = slowOk[0]; flux[1] = flux[0]; fluxi[1] = fluxi[0]; envf[1] = envf[0]; Af[1] = Af[0]; lvf[1] = lvf[0];
    As[1] = As[0]; hm[1] = hm[0]; gk[3] = gk[0]; gk[4] = gk[1]; gk[5] = gk[2];
    for (var k = 0; k < 4; k++) { hp[4 + k] = hp[k]; hp2[4 + k] = hp2[k]; }
    for (var k2 = 0; k2 < NEQ * 4; k2++) eqs[NEQ * 4 + k2] = eqs[k2];
  }

  function reset() {
    A[0] = A[1] = 1; A2[0] = A2[1] = 1; env[0] = env[1] = 0; mem[0] = mem[1] = 0;
    yprev[0] = yprev[1] = 0; above[0] = above[1] = 0; slowOk[0] = slowOk[1] = 0;
    envf[0] = envf[1] = 0; Af[0] = Af[1] = 1; lvf[0] = lvf[1] = 0; As[0] = As[1] = 1;
    hp.fill(0); hp2.fill(0); eqs.fill(0); gk.fill(0); hm[0] = hm[1] = 1; flux[0] = flux[1] = 0; fluxi[0] = fluxi[1] = 0;
    mGrA = 1; mIn = 0; mOut = 0; curAe = 1; statesEq = true;
  }
  reset();

  function shape(x: number, a2: number, a3: number, sat: number, bias: number, ab: number) {
    var y = x + a2 * x * x + a3 * x * x * x + ab * x * (x < 0 ? -x : x);
    if (sat > 0) { var tb = Math.tanh(bias); y = sat * (Math.tanh(y / sat + bias) - tb) / (1 - tb * tb); }
    return y;
  }

  /** Étage à coude réglable (k grand = coude dur), gain unité en petit signal. */
  function shapeK(x: number, a2: number, a3: number, sat: number, bias: number, ab: number, k: number) {
    var y = x + a2 * x * x + a3 * x * x * x + ab * x * (x < 0 ? -x : x);
    if (sat > 0) {
      var ab0 = bias < 0 ? -bias : bias;
      var fb = bias / Math.pow(1 + Math.pow(ab0, k), 1 / k);
      var d = Math.pow(1 + Math.pow(ab0, k), -1 / k - 1);
      var u = y / sat + bias, au = u < 0 ? -u : u;
      y = sat * (u / Math.pow(1 + Math.pow(au, k), 1 / k) - fb) / d;
    }
    return y;
  }

  /** Caractéristique de transfert mesurée y = u·h(asinh u) (gain h tabulé, interpolation cubique). */
  function wsf(u: number) {
    var m = P[129];
    var f = (Math.asinh(u) + m) / (2 * m) * (NWS - 1);
    if (f <= 0) return u * P[130];
    if (f >= NWS - 1) return u * P[130 + NWS - 1];
    var i = Math.floor(f), t = f - i;
    // interpolation cubique (Catmull-Rom) : pente continue -> aucune harmonique parasite des nœuds
    var p0 = P[130 + (i > 0 ? i - 1 : 0)], p1 = P[130 + i], p2 = P[131 + i], p3 = P[130 + (i + 2 < NWS ? i + 2 : NWS - 1)];
    return u * (p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))));
  }

  function table(L: number) {
    var f = (L - l0) / dl;
    var n = tab.length;
    if (f <= 0) return tab[0];
    if (f >= n - 1) return tab[n - 1];
    var i = Math.floor(f);
    var t = f - i;
    return tab[i] + (tab[i + 1] - tab[i]) * t;
  }

  function setInternal(cfg: AnalogCompInternal) {
    for (var k = 0; k < NP; k++) P[k] = +(cfg.P[k] || 0);
    if (!(P[1] > 0)) P[1] = 1e6;
    tab = new Float64Array(cfg.tab.length >= 2 ? cfg.tab : [0, 0]);
    l0 = +cfg.l0; dl = +cfg.dl > 0 ? +cfg.dl : 1;
  }

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number, keyL?: Float32Array | null, keyR?: Float32Array | null) {
    var right = inR || inL;
    var kRight = keyL ? (keyR || keyL) : null;
    // entrée mono (deux canaux identiques, cas d'une voix) : un seul canal calculé, recopié
    // (avec une clé externe, la clé doit elle aussi être identique sur les deux canaux)
    var mono = statesEq;
    if (mono && right !== inL) { for (var j = 0; j < n; j++) if (right[j] !== inL[j]) { mono = false; break; } }
    if (mono && keyL && kRight !== keyL) { for (var j2 = 0; j2 < n; j2++) if ((kRight as Float32Array)[j2] !== keyL[j2]) { mono = false; break; } }
    var nch = mono ? 1 : 2;
    var drv = P[52] !== 0 ? P[52] : 1;
    var c3 = P[100] > 0.5, sq = P[125] > 0.5, thr2 = P[1] * P[1];
    var xfIn = P[72] !== 0 && P[74] > 1.5;
    // invariants du bloc (performance : < 1 % d'un cœur par instance)
    var pre = P[0], inLin = P[14] === 0 && P[15] === 0 && P[27] === 0 && P[65] === 0;
    var fbOn = P[2] > 0.5, hpOn = P[20] !== 0, sc2On = P[66] !== 0, half = P[3] > 0.5, thr = P[1];
    var mix = P[19], dry = 1 - P[19];
    var nAct = 0;
    for (var q0 = 0; q0 < NEQ; q0++) { var oq = q0 < 4 ? PEQ + 5 * q0 : PEQ2 + 5 * (q0 - 4); if (P[oq] !== 0) eqAct[nAct++] = q0; }
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < nch; c++) {
        var x0 = c === 0 ? inL[i] : right[i];
        var ax = x0 < 0 ? -x0 : x0;
        if (ax > mIn) mIn = ax;
        var xi = inLin ? x0 * pre : shape(x0 * pre, P[14], P[15], P[27], P[53], P[65]);
        if (xfIn) { fluxi[c] += (xi - fluxi[c]) * P[73]; var fi = fluxi[c]; xi = xi + P[72] * fi * (fi < 0 ? -fi : fi); }
        xin[c] = xi;
        var s: number;
        if (keyL) {
          // Clé externe (side-chain) : le détecteur écoute la clé, le son traité reste l'entrée.
          var k0 = c === 0 ? keyL[i] : (kRight as Float32Array)[i];
          s = inLin ? k0 * pre : shape(k0 * pre, P[14], P[15], P[27], P[53], P[65]);
        } else s = fbOn ? yprev[c] : xi;
        if (hpOn) {
          var h0 = c * 4;
          var o = P[20] * s + P[21] * hp[h0] + P[22] * hp[h0 + 1] - P[23] * hp[h0 + 2] - P[24] * hp[h0 + 3];
          hp[h0 + 1] = hp[h0]; hp[h0] = s; hp[h0 + 3] = hp[h0 + 2]; hp[h0 + 2] = o;
          s = o;
        }
        if (sc2On) {
          var g0 = c * 4;
          var o2 = P[66] * s + P[67] * hp2[g0] + P[68] * hp2[g0 + 1] - P[69] * hp2[g0 + 2] - P[70] * hp2[g0 + 3];
          hp2[g0 + 1] = hp2[g0]; hp2[g0] = s; hp2[g0 + 3] = hp2[g0 + 2]; hp2[g0 + 2] = o2;
          s = o2;
        }
        var r: number;
        if (sq) r = s * s / thr2;
        else { r = half ? (s > 0 ? s : 0) : (s > 0 ? s : -s); r = r / thr; }
        var e = env[c];
        if (r > e) e = P[4] <= 0 ? r : e + (r - e) * P[4];
        else e = P[29] <= 0 ? r : e + (r - e) * P[29];
        env[c] = e;
        if (P[55] > 0) {
          var ef = envf[c];
          if (r > ef) ef = r; else ef = ef + (r - ef) * P[57];
          envf[c] = ef;
          lvf[c] = ef;
        }
        lv[c] = e;
      }
      if (P[25] > 0.5 && !mono) {
        var m = lv[0] > lv[1] ? lv[0] : lv[1]; lv[0] = m; lv[1] = m;
        var mf = lvf[0] > lvf[1] ? lvf[0] : lvf[1]; lvf[0] = mf; lvf[1] = mf;
      }
      for (var c2 = 0; c2 < nch; c2++) {
        var rr = lv[c2];
        var L = sq ? 4.342944819032518 * Math.log(rr > 1e-18 ? rr : 1e-18) : 8.685889638065035 * Math.log(rr > 1e-9 ? rr : 1e-9);
        var Gt = table(L);
        var ae: number;
        if (c3) {
          // cellule multi-composantes (dB) : 3 parts de la cible, montée / descente propres
          var o3 = c2 * 3;
          // P[108] : la réduction suit la PLUS FORTE des composantes (cellules en parallèle, mode F/M)
          var cmax = P[108] > 0.5;
          var gtot = cmax ? Math.max(gk[o3], gk[o3 + 1], gk[o3 + 2]) : gk[o3] + gk[o3 + 1] + gk[o3 + 2];
          var T = Gt;
          if (P[127] > 0) { if (T > gtot) hm[c2] = 0; else hm[c2] += (1 - hm[c2]) * P[127]; }
          if (P[126] !== 0 && T > gtot) T = T + P[126] * (T - gtot);
          for (var kk = 0; kk < 3; kk++) {
            var ob = 101 + 8 * kk, fk = P[ob];
            if (fk <= 0) continue;
            var tk = fk * T, gg3 = gk[o3 + kk];
            if (tk > gg3) {
              var ca3 = P[ob + 2] !== 0 ? P[ob + 1] * Math.exp(P[ob + 2] * T) : P[ob + 1];
              if (ca3 > 1) ca3 = 1;
              var dg3 = (tk - gg3) * ca3;
              if (P[ob + 6] > 0 && dg3 > P[ob + 6]) dg3 = P[ob + 6];
              gg3 += dg3;
            } else {
              var mb3 = P[ob + 4] !== 0 ? Math.exp(P[ob + 4] * gtot) : 1;
              var rr3 = P[ob + 3] * mb3;
              if (rr3 > 1) rr3 = 1;
              var dd3 = ((gg3 - tk) * rr3 + fk * P[ob + 5] * mb3) * hm[c2];
              if (dd3 > gg3 - tk) dd3 = gg3 - tk;
              gg3 -= dd3;
            }
            gk[o3 + kk] = gg3;
          }
          ae = Math.exp(0.11512925464970229 * (cmax ? Math.max(gk[o3], gk[o3 + 1], gk[o3 + 2]) : gk[o3] + gk[o3 + 1] + gk[o3 + 2]));
        } else {
        if (P[61] > 0) {
          var Gs = Gt * P[61];
          Gt = Gt - Gs;
          var Ats = Math.exp(0.11512925464970229 * Gs);
          var sv = As[c2];
          if (Ats > sv) sv += (Ats - sv) * P[62];
          else sv -= (sv - Ats) * P[63];
          As[c2] = sv;
        }
        var At = Math.exp(0.11512925464970229 * Gt);
        var a = A[c2];
        if (Gt > 0.05) above[c2] += 1;
        if (At > a) {
          var d = (At - a) * P[5];
          if (P[30] <= 0 && P[6] > 0 && d > P[6]) d = P[6];
          a += d;
          if (P[10] >= 0 && above[c2] > P[10]) slowOk[c2] = 1;
        } else {
          var sl = (P[10] >= 0 && slowOk[c2] < 0.5) ? P[9] : P[7];
          if (P[26] !== 0) sl *= Math.pow(1 / a, P[26]);
          var dd = sl + (a - At) * P[8];
          if (dd > a - At) dd = a - At;
          a -= dd;
          if (At <= 1.0000001) {
            above[c2] = 0;
            if (a <= 1.0000001) slowOk[c2] = 0;
          }
        }
        A[c2] = a;
        if (P[30] > 0) {
          var b = A2[c2];
          if (a > b) {
            var d2 = (a - b) * P[30];
            if (P[6] > 0 && d2 > P[6]) d2 = P[6];
            b += d2;
          } else {
            b += (a - b) * (P[31] > 0 ? P[31] : P[30]);
          }
          A2[c2] = b;
          a = b;
        }
        if (P[55] > 0) {
          var rf = lvf[c2];
          var Atf = Math.exp(0.11512925464970229 * table(8.685889638065035 * Math.log(rf > 1e-9 ? rf : 1e-9)));
          var fa = Af[c2];
          if (Atf > fa) fa += (Atf - fa) * P[55];
          else { var df = P[56]; if (df > fa - Atf) df = fa - Atf; fa -= df; }
          Af[c2] = fa;
          if (fa > a) a = fa;
        }
        ae = a;
        if (P[11] > 0) {
          if (a > mem[c2]) mem[c2] += (a - mem[c2]) * P[12];
          else mem[c2] += (a - mem[c2]) * P[13];
          if (mem[c2] > a) ae = a + P[11] * (mem[c2] - a);
        }
        if (P[61] > 0) ae = ae * As[c2];
        }
        if (c2 === 0) { curAe = ae; if (ae > mGrA) mGrA = ae; }
        var gg = 1 / ae;
        var xv = xin[c2];
        if (P[58] !== 0) xv = xv + P[58] * (1 - gg) * xv * xv;
        var yc = xv * gg;
        yprev[c2] = yc;
        var yo = (P[129] > 0 ? wsf(yc * drv) : P[71] > 0 ? shapeK(yc * drv, P[16], P[17], P[28], P[54], P[64], P[71]) : shape(yc * drv, P[16], P[17], P[28], P[54], P[64])) * P[18];
        if (P[72] !== 0 && !xfIn) {
          flux[c2] += (yo - flux[c2]) * P[73];
          var fx = flux[c2];
          // transformateur : mode 1 = k·φ·|φ| (mesuré sur le Vox Strip), mode 0 = k·x·φ²
          yo = P[74] > 0.5 ? yo + P[72] * fx * (fx < 0 ? -fx : fx) : yo + P[72] * yo * fx * fx;
        }
        if (P[59] > 0) yo = shape(yo, 0, 0, P[59], P[60], 0);
        for (var qa = 0; qa < nAct; qa++) {
          var q = eqAct[qa];
          var o0 = q < 4 ? PEQ + 5 * q : PEQ2 + 5 * (q - 4);
          var e0 = (c2 * NEQ + q) * 4;
          var oo = P[o0] * yo + P[o0 + 1] * eqs[e0] + P[o0 + 2] * eqs[e0 + 1] - P[o0 + 3] * eqs[e0 + 2] - P[o0 + 4] * eqs[e0 + 3];
          eqs[e0 + 1] = eqs[e0]; eqs[e0] = yo; eqs[e0 + 3] = eqs[e0 + 2]; eqs[e0 + 2] = oo;
          yo = oo;
        }
        var xd = c2 === 0 ? inL[i] : right[i];
        var out = mix * yo + dry * xd;
        if (c2 === 0) outL[i] = out; else if (outR) outR[i] = out;
        var ao = out < 0 ? -out : out;
        if (ao > mOut) mOut = ao;
      }
      if (mono && outR) outR[i] = outL[i];
    }
    if (mono) copyState01(); else statesEq = false;
  }

  return {
    setInternal: setInternal,
    process: process,
    takeMeters: function () {
      var cur = curAe;
      var r = {
        grDb: 20 * Math.log10(Math.max(1, mGrA)),
        grNowDb: 20 * Math.log10(Math.max(1, cur)),
        inPeakDb: 20 * Math.log10(Math.max(1e-9, mIn)),
        outPeakDb: 20 * Math.log10(Math.max(1e-9, mOut)),
      };
      mGrA = 1; mIn = 0; mOut = 0;
      return r;
    },
    attenuation: function () { return curAe; },
    reset: reset,
  };
}
