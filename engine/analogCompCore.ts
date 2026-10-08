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
  SLOW_FRAC: 61, SLOW_ATT: 62, SLOW_REL: 63, OUT_AB: 64, IN_AB: 65, SC2: 66, OUT_KNEE: 71, XF_K: 72, XF_A: 73, EQ2: 80, NP: 100,
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
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  /** Mesures depuis le dernier appel : réduction de gain max et courante (dB, ≥ 0), crêtes entrée / sortie (dBFS). */
  takeMeters(): { grDb: number; grNowDb: number; inPeakDb: number; outPeakDb: number };
  /** Atténuation courante du canal gauche (pour les tests). */
  attenuation(): number;
  reset(): void;
}

export function createAnalogCompCore(sampleRate: number): AnalogCompCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  void SR;
  var NP = 100, NEQ = 8, PEQ = 32, PEQ2 = 80;
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
  var flux = new Float64Array(2);
  var eqs = new Float64Array(2 * NEQ * 4);
  var lv = new Float64Array(2), xin = new Float64Array(2);
  var envf = new Float64Array(2), Af = new Float64Array(2), lvf = new Float64Array(2), As = new Float64Array(2);
  var mGrA = 1, mIn = 0, mOut = 0, curAe = 1;

  function reset() {
    A[0] = A[1] = 1; A2[0] = A2[1] = 1; env[0] = env[1] = 0; mem[0] = mem[1] = 0;
    yprev[0] = yprev[1] = 0; above[0] = above[1] = 0; slowOk[0] = slowOk[1] = 0;
    envf[0] = envf[1] = 0; Af[0] = Af[1] = 1; lvf[0] = lvf[1] = 0; As[0] = As[1] = 1;
    hp.fill(0); hp2.fill(0); eqs.fill(0); flux[0] = flux[1] = 0;
    mGrA = 1; mIn = 0; mOut = 0; curAe = 1;
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

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number) {
    var right = inR || inL;
    var drv = P[52] !== 0 ? P[52] : 1;
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < 2; c++) {
        var x0 = c === 0 ? inL[i] : right[i];
        var ax = x0 < 0 ? -x0 : x0;
        if (ax > mIn) mIn = ax;
        var xi = shape(x0 * P[0], P[14], P[15], P[27], P[53], P[65]);
        xin[c] = xi;
        var s = P[2] > 0.5 ? yprev[c] : xi;
        if (P[20] !== 0) {
          var h0 = c * 4;
          var o = P[20] * s + P[21] * hp[h0] + P[22] * hp[h0 + 1] - P[23] * hp[h0 + 2] - P[24] * hp[h0 + 3];
          hp[h0 + 1] = hp[h0]; hp[h0] = s; hp[h0 + 3] = hp[h0 + 2]; hp[h0 + 2] = o;
          s = o;
        }
        if (P[66] !== 0) {
          var g0 = c * 4;
          var o2 = P[66] * s + P[67] * hp2[g0] + P[68] * hp2[g0 + 1] - P[69] * hp2[g0 + 2] - P[70] * hp2[g0 + 3];
          hp2[g0 + 1] = hp2[g0]; hp2[g0] = s; hp2[g0 + 3] = hp2[g0 + 2]; hp2[g0 + 2] = o2;
          s = o2;
        }
        var r = P[3] > 0.5 ? (s > 0 ? s : 0) : (s > 0 ? s : -s);
        r = r / P[1];
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
      if (P[25] > 0.5) {
        var m = lv[0] > lv[1] ? lv[0] : lv[1]; lv[0] = m; lv[1] = m;
        var mf = lvf[0] > lvf[1] ? lvf[0] : lvf[1]; lvf[0] = mf; lvf[1] = mf;
      }
      for (var c2 = 0; c2 < 2; c2++) {
        var rr = lv[c2];
        var L = 20 * Math.log10(rr > 1e-9 ? rr : 1e-9);
        var Gt = table(L);
        if (P[61] > 0) {
          var Gs = Gt * P[61];
          Gt = Gt - Gs;
          var Ats = Math.pow(10, Gs / 20);
          var sv = As[c2];
          if (Ats > sv) sv += (Ats - sv) * P[62];
          else sv -= (sv - Ats) * P[63];
          As[c2] = sv;
        }
        var At = Math.pow(10, Gt / 20);
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
          var Atf = Math.pow(10, table(20 * Math.log10(rf > 1e-9 ? rf : 1e-9)) / 20);
          var fa = Af[c2];
          if (Atf > fa) fa += (Atf - fa) * P[55];
          else { var df = P[56]; if (df > fa - Atf) df = fa - Atf; fa -= df; }
          Af[c2] = fa;
          if (fa > a) a = fa;
        }
        var ae = a;
        if (P[11] > 0) {
          if (a > mem[c2]) mem[c2] += (a - mem[c2]) * P[12];
          else mem[c2] += (a - mem[c2]) * P[13];
          if (mem[c2] > a) ae = a + P[11] * (mem[c2] - a);
        }
        if (P[61] > 0) ae = ae * As[c2];
        if (c2 === 0) { curAe = ae; if (ae > mGrA) mGrA = ae; }
        var gg = 1 / ae;
        var xv = xin[c2];
        if (P[58] !== 0) xv = xv + P[58] * (1 - gg) * xv * xv;
        var yc = xv * gg;
        yprev[c2] = yc;
        var yo = (P[71] > 0 ? shapeK(yc * drv, P[16], P[17], P[28], P[54], P[64], P[71]) : shape(yc * drv, P[16], P[17], P[28], P[54], P[64])) * P[18];
        if (P[72] !== 0) { flux[c2] += (yo - flux[c2]) * P[73]; yo = yo + P[72] * yo * flux[c2] * flux[c2]; }
        if (P[59] > 0) yo = shape(yo, 0, 0, P[59], P[60], 0);
        for (var q = 0; q < NEQ; q++) {
          var o0 = q < 4 ? PEQ + 5 * q : PEQ2 + 5 * (q - 4);
          if (P[o0] !== 0) {
            var e0 = (c2 * NEQ + q) * 4;
            var oo = P[o0] * yo + P[o0 + 1] * eqs[e0] + P[o0 + 2] * eqs[e0 + 1] - P[o0 + 3] * eqs[e0 + 2] - P[o0 + 4] * eqs[e0 + 3];
            eqs[e0 + 1] = eqs[e0]; eqs[e0] = yo; eqs[e0 + 3] = eqs[e0 + 2]; eqs[e0 + 2] = oo;
            yo = oo;
          }
        }
        var xd = c2 === 0 ? inL[i] : right[i];
        var out = P[19] * yo + (1 - P[19]) * xd;
        if (c2 === 0) outL[i] = out; else if (outR) outR[i] = out;
        var ao = out < 0 ? -out : out;
        if (ao > mOut) mOut = ao;
      }
    }
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
