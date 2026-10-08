/**
 * Traduction des boutons des compresseurs analogiques NOVA en paramètres
 * internes du cœur (engine/analogCompCore.ts), à partir du profil mesuré de
 * chaque appareil (engine/analogProfiles.ts, généré par le labo).
 *
 * Fonction PURE et autonome (sérialisée par `toString()` dans l'AudioWorklet) :
 * aucune référence extérieure. Miroir exact de tools/labo/modeles/*_profil.py.
 */
import type { AnalogCompInternal } from './analogCompCore';

export type AnalogKind = 'OPTO_VINTAGE' | 'FET76' | 'LEVELER2A' | 'VOXSTRIP';

export function buildAnalogInternal(kind: string, p: Record<string, number>, prof: any, sampleRate: number): AnalogCompInternal {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var P = new Float64Array(100);
  function num(v: any, d: number) { var x = +v; return x === x && isFinite(x) ? x : d; }
  function interp(x: number, xs: number[], ys: number[]) {
    var n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    for (var i = 1; i < n; i++) {
      if (x <= xs[i]) { var t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + (ys[i] - ys[i - 1]) * t; }
    }
    return ys[n - 1];
  }
  function interpLog(x: number, xs: number[], ys: number[]) {
    var ls: number[] = [];
    for (var i = 0; i < ys.length; i++) ls.push(Math.log(Math.max(ys[i], 1e-9)));
    return Math.exp(interp(x, xs, ls));
  }
  function coef(ms: number) { return ms <= 0 ? 1 : 1 - Math.exp(-1 / (ms * 0.001 * SR)); }
  function biquad(kindB: string, fc: number, q: number, gainDb: number): number[] {
    var w0 = 2 * Math.PI * fc / SR, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    var b: number[], a: number[];
    if (kindB === 'hp') { b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + al, -2 * cw, 1 - al]; }
    else if (kindB === 'lp') { b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + al, -2 * cw, 1 - al]; }
    else if (kindB === 'peak') { b = [1 + al * A, -2 * cw, 1 - al * A]; a = [1 + al / A, -2 * cw, 1 - al / A]; }
    else if (kindB === 'lowshelf') {
      var sa = 2 * Math.sqrt(A) * al;
      b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)];
      a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa];
    } else if (kindB === 'highshelf') {
      var sb = 2 * Math.sqrt(A) * al;
      b = [A * ((A + 1) + (A - 1) * cw + sb), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sb)];
      a = [(A + 1) - (A - 1) * cw + sb, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sb];
    } else if (kindB === 'hp1') {
      var wt = Math.tan(Math.PI * fc / SR), h0 = 1 / (1 + wt);
      return [h0, -h0, 0, (wt - 1) / (wt + 1), 0];
    } else return [0, 0, 0, 0, 0];
    return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
  }
  function setEq(slot: number, bq: number[]) { var o = slot < 4 ? 32 + 5 * slot : 80 + 5 * (slot - 4); for (var k = 0; k < 5; k++) P[o + k] = bq[k]; }
  function setHp(bq: number[]) { for (var k = 0; k < 5; k++) P[20 + k] = bq[k]; }
  /** Table G(L) interpolée entre les courbes mesurées les plus proches du bouton. */
  function tableFor(x: number, knobs: number[], tables: number[][]) {
    var n = knobs.length;
    if (x <= knobs[0]) return tables[0].slice();
    if (x >= knobs[n - 1]) return tables[n - 1].slice();
    var j = 1;
    while (j < n && knobs[j] < x) j++;
    var t = (x - knobs[j - 1]) / (knobs[j] - knobs[j - 1]);
    var out: number[] = [];
    for (var i = 0; i < tables[j].length; i++) out.push(tables[j - 1][i] * (1 - t) + tables[j][i] * t);
    return out;
  }

  P[0] = 1; P[5] = 1; P[18] = 1; P[19] = 1; P[1] = 1e6;
  var tab: number[] = [0, 0];

  if (kind === 'OPTO_VINTAGE') {
    // Seuil = niveau (dBFS crête, sinus) où la réduction atteint 1 dB au taux 4:1
    P[1] = Math.pow(10, num(p.threshold, -30) / 20);
    var ratio = Math.min(10, Math.max(2, num(p.ratio, 4)));
    tab = tableFor(ratio, prof.ratioKnob, prof.tables);
    P[2] = 0;
    P[3] = prof.rectHalf ? 1 : 0;
    P[29] = prof.detRelMs > 0 ? coef(prof.detRelMs) : 0;
    var mode = Math.round(num(p.mode, 2));
    if (mode === 0 && prof.fixDetRelMs) P[29] = coef(prof.fixDetRelMs);
    var knob = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    var att = num(p.attack, 5), rel = num(p.release, 5);
    var relSlew = interpLog(rel, knob, prof.relSlew);
    if (mode === 2) {
      var ca = coef(interpLog(att, prof.attKnob, prof.attMs));
      P[5] = ca; P[30] = ca;
      P[6] = interpLog(att, prof.attKnob, prof.attSlew) / SR;
      P[7] = relSlew / SR;
      P[10] = -1;
    } else if (mode === 0) {
      P[5] = coef(prof.fixAttMs); P[30] = P[5];
      P[7] = prof.fixRelSlew / SR;
      P[10] = -1;
    } else {
      // FIX./MAN. : cellule lente (ATTACK = temps de charge, RELEASE manuel) en
      // parallèle d'une cellule rapide fixe ; la réduction suit la plus forte.
      var cf = coef(interpLog(att, prof.fmKnob, prof.fmAttMs));
      P[5] = cf; P[30] = 0; P[6] = 0;
      P[29] = coef(prof.fastDetRelMs);
      P[7] = relSlew / SR;
      P[10] = -1;
      P[55] = coef(prof.fastAttMs);
      P[56] = prof.fastRelSlew / SR;
      P[57] = coef(prof.fastDetRelMs);
    }
    P[31] = coef(prof.cellRelFollowMs);
    P[18] = Math.pow(10, num(p.output, 0) / 20);
    if (num(p.vintage, 0) >= 0.5 && prof.vintageEq) {
      P[18] *= Math.pow(10, prof.vintageGainDb / 20);
      for (var q = 0; q < prof.vintageEq.length && q < 4; q++) {
        var v = prof.vintageEq[q];
        setEq(q, biquad(v[0], v[1], v[2], v[3]));
      }
    }
    P[19] = Math.min(1, Math.max(0, num(p.mix, 100) / 100));
    var sc = Math.round(num(p.scLowCut, 0));
    if (sc > 0) {
      var f = prof.scFilters && prof.scFilters[String(sc)];
      setHp(f ? biquad('hp', f[0], f[1], 0) : biquad('hp', sc, 0.7071, 0));
    }
    P[25] = 0;
    return { P: P, tab: tab, l0: prof.l0, dl: prof.dl };
  }
  if (kind === 'VOXSTRIP') {
    var dv = prof.defaults || {};
    var pv = function (k: string) { return num(p[k], num(dv[k], 0)); };
    var gin = interp(pv('input'), prof.inKnob, prof.inGainDb);
    P[0] = Math.pow(10, gin / 20);
    if (pv('compOn') >= 0.5) {
      var th = pv('compThresh');
      var thr2 = interp(th, prof.thKnob, prof.thrTh);
      tab = tableFor(th, prof.thKnob, prof.tablesTh);
      var g5 = interp(5, prof.inKnob, prof.inGainDb);
      P[1] = Math.pow(10, (thr2 + g5) / 20);
    } else { tab = []; for (var z2 = 0; z2 < prof.tablesTh[0].length; z2++) tab.push(0); P[1] = 1e6; }
    var ai = Math.max(0, Math.min(4, Math.round(pv('attack')))), rj = Math.max(0, Math.min(4, Math.round(pv('release'))));
    P[5] = coef(prof.attMs[ai][rj]); P[30] = P[5];
    P[8] = coef(prof.relMs[ai][rj]); P[10] = -1;
    P[61] = prof.slowFrac; P[62] = coef(prof.slowAttMs); P[63] = coef(prof.slowRelMs);
    var slot = 0;
    var lc = Math.round(pv('lowCut'));
    if (lc > 0) setEq(slot++, biquad('hp1', lc, 0.7071, 0));
    if (pv('eqOn') >= 0.5) {
      var bands: [string, string, string][] = [['lo', 'loFreq', 'loPeak'], ['mid', 'midFreq', 'midDip'], ['hi', 'hiFreq', 'hiPeak']];
      for (var bi = 0; bi < 3; bi++) {
        var rowsB = prof[bands[bi][0]], kv = pv(bands[bi][2]);
        if (!rowsB || Math.abs(kv) < 1e-3) continue;
        var row = rowsB[Math.max(0, Math.min(rowsB.length - 1, Math.round(pv(bands[bi][1]))))];
        var av = Math.abs(kv), qv: number, gv: number;
        if (av <= 5) { qv = row[1]; gv = row[3] * av / 5; } else { var tt = (av - 5) / 5; qv = row[1] + (row[2] - row[1]) * tt; gv = row[3] + (row[4] - row[3]) * tt; }
        setEq(slot++, biquad(prof[bands[bi][0] + 'Kind'], row[0], Math.max(qv, 0.1), kv > 0 ? gv : -Math.abs(gv)));
      }
    }
    for (var eb = 0; eb < prof.eqBase.length && slot < 8; eb++) { var e4 = prof.eqBase[eb]; setEq(slot++, biquad(e4[0], e4[1], e4[2], e4[3])); }
    P[16] = prof.outA2; P[17] = prof.outA3; P[28] = prof.outSat; P[54] = prof.outBias; P[64] = prof.outAb; P[71] = prof.outKnee;
    if (pv('transformer') >= 0.5) { P[72] = prof.xfK; P[73] = 1 - Math.exp(-2 * Math.PI * prof.xfFc / SR); }
    P[18] = Math.pow(10, pv('output') / 20);
    P[19] = Math.min(1, Math.max(0, num(p.mix, 100) / 100));
    P[25] = 0;
    return { P: P, tab: tab, l0: prof.l0, dl: prof.dl };
  }
  if (kind === 'LEVELER2A') {
    var pr = num(p.peakReduction, 50);
    var thrL: number;
    if (num(p.limit, 0) >= 0.5) {
      var prl = Math.max(pr, prof.limKnob[0]);
      thrL = interp(prl, prof.limKnob, prof.thrLim);
      tab = tableFor(prl, prof.limKnob, prof.tablesLim);
      if (pr < prof.limKnob[0]) thrL = interp(pr, prof.prKnob, prof.thrPr) + (prof.thrLim[0] - interp(prof.limKnob[0], prof.prKnob, prof.thrPr));
    } else {
      thrL = interp(pr, prof.prKnob, prof.thrPr);
      tab = tableFor(pr, prof.prKnob, prof.tablesPr);
    }
    // filtre du détecteur selon l'accentuation des aigus : [g0, fc_hp, q_hp, fc_pk, q_pk, g_pk]
    var em = num(p.emphasis, 0), scp: number[] = [];
    for (var ci = 0; ci < 6; ci++) { var col: number[] = []; for (var ri = 0; ri < prof.sc.length; ri++) col.push(prof.sc[ri][ci]); scp.push(interp(em, prof.emphKnob, col)); }
    P[1] = Math.pow(10, (thrL - scp[0]) / 20);
    setHp(biquad('hp', scp[1], scp[2], 0));
    var pk = biquad('peak', scp[3], scp[4], scp[5]);
    for (var k3 = 0; k3 < 5; k3++) P[66 + k3] = pk[k3];
    P[3] = prof.rectHalf ? 1 : 0;
    P[29] = prof.detRelMs > 0 ? coef(prof.detRelMs) : 0;
    P[5] = coef(prof.attMs); P[30] = P[5]; P[8] = coef(prof.relMs); P[10] = -1;
    P[61] = prof.slowFrac; P[62] = coef(prof.slowAttMs); P[63] = coef(prof.slowRelMs);
    P[52] = Math.pow(10, interp(num(p.gain, 50), prof.gainKnob, prof.gainDb) / 20);
    P[18] = 1;
    P[16] = prof.outA2; P[17] = prof.outA3; P[28] = prof.outSat; P[54] = prof.outBias; P[64] = prof.outAb; P[71] = prof.outKnee || 0;
    for (var q3 = 0; q3 < prof.eq.length && q3 < 4; q3++) { var e3 = prof.eq[q3]; setEq(q3, biquad(e3[0], e3[1], e3[2], e3[3])); }
    P[19] = Math.min(1, Math.max(0, num(p.mix, 100) / 100));
    P[25] = 0;
    return { P: P, tab: tab, l0: prof.l0, dl: prof.dl };
  }
  if (kind === 'FET76') {
    // Bouton ENTRÉE (gain mesuré, non linéaire) -> niveau interne ; seuil interne fixe
    P[0] = Math.pow(10, interp(num(p.input, -24), prof.inKnob, prof.inGainDb) / 20);
    P[1] = Math.pow(10, prof.tRefDb / 20);
    var r = num(p.ratio, 4);
    if (r < 1) { tab = []; for (var z = 0; z < prof.tables[0].length; z++) tab.push(0); }
    else {
      var bj = 0;
      for (var k2 = 1; k2 < prof.ratios.length; k2++) if (Math.abs(r - prof.ratios[k2]) < Math.abs(r - prof.ratios[bj])) bj = k2;
      tab = prof.tables[bj].slice();
    }
    P[3] = prof.rectHalf ? 1 : 0;
    P[29] = prof.detRelMs > 0 ? coef(prof.detRelMs) : 0;
    var relK = num(p.release, 4);
    var fa = num(p.slo, 0) >= 0.5 ? prof.sloAttMs : interpLog(num(p.attack, 4), prof.attKnob, prof.attMs);
    P[5] = coef(fa);
    var relMs = interpLog(relK, prof.relKnob, prof.relMs);
    P[7] = 0; P[8] = coef(relMs); P[10] = -1;
    P[61] = prof.slowFrac; P[62] = coef(prof.slowAttMs); P[63] = coef(relMs * prof.slowRelK);
    P[16] = prof.outA2; P[17] = prof.outA3; P[28] = prof.outSat; P[54] = prof.outBias; P[64] = prof.outAb;
    P[58] = prof.fetA2;
    P[18] = Math.pow(10, interp(num(p.output, -24), prof.outKnob, prof.outGainDb) / 20);
    P[59] = prof.finalSat || 0;
    for (var q2 = 0; q2 < prof.eq.length && q2 < 4; q2++) { var e = prof.eq[q2]; setEq(q2, biquad(e[0], e[1], e[2], e[3])); }
    P[19] = Math.min(1, Math.max(0, num(p.mix, 100) / 100));
    P[25] = 0;
    return { P: P, tab: tab, l0: prof.l0, dl: prof.dl };
  }
  return { P: P, tab: tab, l0: -12, dl: 1 };
}
