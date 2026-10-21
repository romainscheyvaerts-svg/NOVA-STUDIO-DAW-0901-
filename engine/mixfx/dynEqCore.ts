/**
 * Cœur DSP de l'« EQ dynamique » NOVA (anti-résonances), en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet (sérialisé par `toString()` : il ne référence RIEN
 * en dehors de lui-même) et dans les tests vitest.
 *
 * Chaque bande est une cloche dont le gain bouge avec le niveau DANS la bande, bandes en
 * série. Même principe que le de-esser NOVA (engine/deesserCore.ts) :
 *
 *   bande  b = F(x)    F = passe-bande à gain unité au centre (RBJ « constant 0 dB peak »)
 *   sortie y = x + (g − 1)·b
 *
 * C'est une cloche de gain g au centre, de largeur Q. Le même filtre sert au détecteur (ce
 * qu'on entend avec « Écouter la bande ») : un seul biquad par bande et par canal, aucun
 * coefficient recalculé quand le gain bouge (le gain n'est qu'un multiplicateur). Sous le
 * seuil, g = 1 exactement : y = x À L'ÉCHANTILLON PRÈS (aucune coloration, aucun déphasage).
 *
 * Loi de gain (dB) : au-dessus du seuil, le gain va vers la « plage » au rythme du dépassement
 * (1 dB de dépassement = 1 dB de gain, genou doux de 3 dB), sans jamais la dépasser :
 *   plage < 0 : atténuation (le niveau de la bande est tenu au seuil, au plus |plage| dB) ;
 *   plage > 0 : renfort quand la bande dépasse le seuil (au plus plage dB).
 * Détecteur crête stéréo couplé, attaque / relâchement par bande. Latence nulle.
 *
 * Sans clic : seuil, plage, marche/arrêt, écoute et sortie glissent sur 256 échantillons ;
 * fréquence et Q glissent (log) par sous-blocs de 32 échantillons. Aucune allocation dans
 * `process`.
 */

export interface DynEqCoreParams { [k: string]: number | boolean | undefined }

export interface DynEqMeters {
  /** Gain dynamique courant par bande (dB, négatif = atténuation). */
  gainNow: number[];
  /** Plus forte variation depuis la dernière lecture, par bande (dB, signe de la plage). */
  gainPeak: number[];
  /** Niveau détecté dans chaque bande (dBFS). */
  levelDb: number[];
  inPeakDb: number;
  outPeakDb: number;
}

export interface DynEqCore {
  setParams(p: DynEqCoreParams): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  takeMeters(): DynEqMeters;
  reset(): void;
  atRest(): boolean;
  catchUp(K: number): void;
}

export function createDynEqCore(sampleRate: number): DynEqCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var NB = 4;
  var RAMP = 256;
  var SUB = 32;
  var KNEE = 3;
  // Passe-bande de chaque bande (b0, b2 = −b0, a1, a2 ; b1 = 0) et état DF-I par canal.
  var B0 = new Float64Array(NB), A1 = new Float64Array(NB), A2 = new Float64Array(NB);
  var S = new Float64Array(NB * 2 * 4);
  var fCur = new Float64Array(NB), fTgt = new Float64Array(NB), qCur = new Float64Array(NB), qTgt = new Float64Array(NB);
  var gliding = false;
  // Réglages lissés par bande b : 0 seuil (dB), 1 plage (dB), 2 marche (0/1), 3 écoute (0/1) ; global 16 : sortie (linéaire).
  var NP = 17;
  var Pc = new Float64Array(NP), Pt = new Float64Array(NP), Ps = new Float64Array(NP);
  var Pn = new Int32Array(NP);
  var ramping = 0;
  var env = new Float64Array(NB);
  var cA = new Float64Array(NB), cR = new Float64Array(NB);
  var linLo = new Float64Array(NB);
  var gNow = new Float64Array(NB), gPk = new Float64Array(NB);
  var inPk = 0, outPk = 0;
  var enabled = true;
  var first = true;

  function coef(ms: number) { return 1 - Math.exp(-1 / (Math.max(0.01, ms) * 0.001 * SR)); }
  function num(v: any, d: number) { var x = +v; return x === x && isFinite(x) ? x : d; }
  function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }

  function design(b: number) {
    var fc = clamp(fCur[b], 20, SR * 0.45);
    var w0 = 2 * Math.PI * fc / SR, cw = Math.cos(w0), sw = Math.sin(w0);
    var al = sw / (2 * clamp(qCur[b], 0.1, 40)), a0 = 1 + al;
    B0[b] = al / a0; A1[b] = -2 * cw / a0; A2[b] = (1 - al) / a0;
  }

  function setP(i: number, v: number, inst: boolean) {
    if (inst) { Pc[i] = v; Pt[i] = v; if (Pn[i] > 0) ramping--; Pn[i] = 0; return; }
    if (v === Pt[i] && (Pn[i] > 0 || Pc[i] === v)) return;
    Pt[i] = v;
    if (Pc[i] === v) { if (Pn[i] > 0) { Pn[i] = 0; ramping--; } return; }
    Ps[i] = (v - Pc[i]) / RAMP;
    if (Pn[i] === 0) ramping++;
    Pn[i] = RAMP;
  }

  function updateLinLo() {
    for (var b = 0; b < NB; b++) {
      var t = Math.min(Pc[b * 4], Pt[b * 4]);
      linLo[b] = Math.pow(10, (t - KNEE / 2) / 20) * (1 - 1e-9);
    }
  }

  function setParams(p: DynEqCoreParams) {
    var inst = first;
    enabled = p.isEnabled !== false;
    var listen = Math.round(num(p.listen, 0));
    for (var b = 0; b < NB; b++) {
      var pre = 'd' + (b + 1);
      var on = num(p[pre + 'On'], b === 0 ? 1 : 0) >= 0.5;
      setP(b * 4, clamp(num(p[pre + 'Thr'], -20), -80, 12), inst);
      setP(b * 4 + 1, clamp(num(p[pre + 'Range'], 0), -30, 30), inst);
      setP(b * 4 + 2, on ? 1 : 0, inst);
      setP(b * 4 + 3, listen === b + 1 ? 1 : 0, inst);
      cA[b] = coef(clamp(num(p[pre + 'Att'], 5), 0.05, 500));
      cR[b] = coef(clamp(num(p[pre + 'Rel'], 100), 1, 5000));
      var f = Math.min(clamp(num(p[pre + 'Freq'], 1000), 20, 20000), SR * 0.45);
      var q = clamp(num(p[pre + 'Q'], 2), 0.1, 40);
      fTgt[b] = f; qTgt[b] = q;
      if (inst) { fCur[b] = f; qCur[b] = q; design(b); }
      else if (fCur[b] !== f || qCur[b] !== q) gliding = true;
    }
    setP(16, Math.pow(10, clamp(num(p.output, 0), -36, 36) / 20), inst);
    updateLinLo();
  }

  function towards(cur: number, tgt: number) {
    var lc = Math.log(cur), lt = Math.log(tgt), d = lt - lc;
    // Pas borné (≤ 2 % par sous-bloc de 32 échantillons) : la cloche se déplace sans sauter.
    var st = d * 0.1;
    if (st > 0.02) st = 0.02; else if (st < -0.02) st = -0.02;
    return d < 2e-4 && d > -2e-4 ? tgt : Math.exp(lc + st);
  }

  function glideStep() {
    var still = false;
    for (var b = 0; b < NB; b++) {
      if (fCur[b] === fTgt[b] && qCur[b] === qTgt[b]) continue;
      fCur[b] = towards(fCur[b], fTgt[b]);
      qCur[b] = towards(qCur[b], qTgt[b]);
      if (fCur[b] !== fTgt[b] || qCur[b] !== qTgt[b]) still = true;
      design(b);
    }
    gliding = still;
  }

  var LN10_20 = Math.LN10 / 20, DB_PER_LN = 20 / Math.LN10;

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number) {
    first = false;
    var right = inR || inL;
    var stereo = !!inR;
    var i = 0;
    while (i < n) {
      var end = n;
      if (gliding) { glideStep(); end = Math.min(n, i + SUB); }
      if (ramping > 0) updateLinLo();
      for (; i < end; i++) {
        var xl = inL[i], xr = right[i];
        var axl = xl < 0 ? -xl : xl, axr = xr < 0 ? -xr : xr;
        if (axl > inPk) inPk = axl;
        if (axr > inPk) inPk = axr;
        if (ramping > 0) {
          for (var q = 0; q < NP; q++) {
            if (Pn[q] > 0) { Pc[q] += Ps[q]; if (--Pn[q] === 0) { Pc[q] = Pt[q]; ramping--; } }
          }
        }
        var yl = xl, yr = xr;
        var lisL = 0, lisR = 0, lisW = 0;
        for (var b = 0; b < NB; b++) {
          var on = Pc[b * 4 + 2], lw = Pc[b * 4 + 3];
          // Bande coupée, ou plage à 0 dB (rien à faire) et pas écoutée : aucun calcul.
          if ((on === 0 || (Pc[b * 4 + 1] === 0 && Pn[b * 4 + 1] === 0)) && lw === 0) continue;
          var bb0 = B0[b], ba1 = A1[b], ba2 = A2[b];
          var so = b * 8;
          // passe-bande, gauche
          var bl = bb0 * yl - bb0 * S[so + 1] - ba1 * S[so + 2] - ba2 * S[so + 3];
          S[so + 1] = S[so]; S[so] = yl; S[so + 3] = S[so + 2]; S[so + 2] = bl;
          var br = bl;
          if (stereo) {
            br = bb0 * yr - bb0 * S[so + 5] - ba1 * S[so + 6] - ba2 * S[so + 7];
            S[so + 5] = S[so + 4]; S[so + 4] = yr; S[so + 7] = S[so + 6]; S[so + 6] = br;
          }
          var lv = bl < 0 ? -bl : bl, lr = br < 0 ? -br : br;
          if (lr > lv) lv = lr;
          var e = env[b];
          e += (lv - e) * (lv > e ? cA[b] : cR[b]);
          env[b] = e;
          var gdb = 0;
          var range = Pc[b * 4 + 1];
          if (e > linLo[b] && range !== 0) {
            var over = DB_PER_LN * Math.log(e) - Pc[b * 4];
            var d = 0;
            if (over >= KNEE / 2) d = over;
            else if (over > -KNEE / 2) d = (over + KNEE / 2) * (over + KNEE / 2) / (2 * KNEE);
            var lim = range < 0 ? -range : range;
            if (d > lim) d = lim;
            gdb = range < 0 ? -d : d;
          }
          if (on !== 1) gdb *= on;
          gNow[b] = gdb;
          if ((gdb < 0 ? -gdb : gdb) > (gPk[b] < 0 ? -gPk[b] : gPk[b])) gPk[b] = gdb;
          if (lw !== 0) { lisL += lw * bl; lisR += lw * br; lisW += lw; }
          if (gdb !== 0) {
            var gm1 = Math.exp(gdb * LN10_20) - 1;
            yl += gm1 * bl; yr += gm1 * br;
          }
        }
        if (lisW !== 0) {
          var keep = lisW >= 1 ? 0 : 1 - lisW;
          yl = keep * yl + lisL; yr = keep * yr + lisR;
        }
        var og = Pc[16];
        if (og !== 1) { yl *= og; yr *= og; }
        if (!enabled) { yl = xl; yr = xr; }
        var ayl = yl < 0 ? -yl : yl, ayr = yr < 0 ? -yr : yr;
        if (ayl > outPk) outPk = ayl;
        if (ayr > outPk) outPk = ayr;
        outL[i] = yl;
        if (outR) outR[i] = stereo ? yr : yl;
      }
    }
    for (var z = 0; z < NB; z++) {
      if (env[z] < 1e-30) env[z] = 0;
      // Bande au repos (coupée ou plage 0 dB, plus écoutée) : filtre remis à zéro ; elle repartira
      // d'un état propre, en fondu (marche ou plage qui glissent depuis 0).
      var idle = (Pc[z * 4 + 2] === 0 && Pn[z * 4 + 2] === 0) || (Pc[z * 4 + 1] === 0 && Pn[z * 4 + 1] === 0);
      if (idle && Pc[z * 4 + 3] === 0 && Pn[z * 4 + 3] === 0) { for (var s = 0; s < 8; s++) S[z * 8 + s] = 0; env[z] = 0; gNow[z] = 0; }
    }
  }

  function reset() {
    S.fill(0); env.fill(0); gNow.fill(0); gPk.fill(0); inPk = 0; outPk = 0;
    for (var q = 0; q < NP; q++) { Pc[q] = Pt[q]; Pn[q] = 0; }
    ramping = 0;
    for (var b = 0; b < NB; b++) { fCur[b] = fTgt[b]; qCur[b] = qTgt[b]; design(b); }
    gliding = false;
    updateLinLo();
  }

  setParams({});

  var dbOf = function (x: number) { return x > 1e-6 ? 20 * Math.log10(x) : -120; };

  return {
    setParams: setParams,
    process: process,
    takeMeters: function () {
      var r = { gainNow: [gNow[0], gNow[1], gNow[2], gNow[3]], gainPeak: [gPk[0], gPk[1], gPk[2], gPk[3]],
        levelDb: [dbOf(env[0]), dbOf(env[1]), dbOf(env[2]), dbOf(env[3])], inPeakDb: dbOf(inPk), outPeakDb: dbOf(outPk) };
      for (var b = 0; b < NB; b++) gPk[b] = gNow[b];
      inPk = 0; outPk = 0;
      return r;
    },
    reset: reset,
    atRest: function () {
      if (ramping > 0 || gliding) return false;
      for (var i = 0; i < S.length; i++) { var v = S[i]; if (v > 1e-12 || v < -1e-12) return false; }
      for (var b = 0; b < NB; b++) if (env[b] > linLo[b] * 0.5 || gNow[b] !== 0) return false;
      return true;
    },
    catchUp: function (K: number) {
      var blocks = Math.floor(K / 128);
      for (var b = 0; b < NB; b++) {
        var e = env[b];
        for (var k = 0; k < blocks && e !== 0; k++) {
          if (k < 512) { for (var j = 0; j < 128; j++) e += (0 - e) * cR[b]; }
          else e *= Math.pow(1 - cR[b], 128);
          if (e < 1e-30) e = 0;
        }
        env[b] = e;
      }
    },
  };
}
