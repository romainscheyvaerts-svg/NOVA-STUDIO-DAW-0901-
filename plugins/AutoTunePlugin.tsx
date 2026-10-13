
import { AutomationSet, MappedParam } from '../engine/automationParams';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Faceplate, HwSection, HwWindow, Knob, PushButton, useHwHelp } from './hw';
import { retireWorkletNode } from '../engine/workletGuard';

// Export constants for use in other plugins (MasterSync)
export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = ['CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC'];
/** Libellés français des gammes (les valeurs restent celles du moteur). */
export const SCALE_LABELS: Record<string, string> = {
  CHROMATIC: 'Chromatique (toutes les notes)', MAJOR: 'Majeure', MINOR: 'Mineure', MINOR_HARMONIC: 'Mineure harmonique', PENTATONIC: 'Pentatonique',
};

// --- WORKLET CODE INLINED TO PREVENT 404 ERRORS ---
// Moteur v2 : detection YIN + transposition PSOLA (grains synchrones de la
// periode). L'ancien moteur (autocorrelation brute + deux tetes de lecture)
// se trompait d'octave, corrigeait aussi les consonnes et les silences, et ses
// deux tetes decalees filtraient la voix en peigne meme sans correction.
const WORKLET_CODE = `
const MIN_F0 = 75;     // Hz : voix graves de rap comprises
const MAX_F0 = 1000;   // Hz : aigus de chant

class AutoTuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    // Tampons circulaires (taille puissance de 2, compteurs absolus).
    this.SIZE = 16384;
    this.MASK = this.SIZE - 1;
    this.inBuf = new Float32Array(this.SIZE);
    this.acc = new Float32Array(this.SIZE);
    this.wsum = new Float32Array(this.SIZE);
    // Latence fixe : un grain de 2 periodes doit etre entierement disponible.
    this.pMax = Math.ceil(sr / MIN_F0);
    this.latency = 2 * this.pMax + 34;
    this.pUnvoiced = Math.round(sr * 0.005);
    // Analyse sur un signal filtre puis decime (moins de calcul, moins
    // d'erreurs d'octave dues aux formants).
    this.D = sr > 60000 ? 4 : 2;
    this.ar = sr / this.D;
    this.tauMin = Math.max(2, Math.floor(this.ar / MAX_F0));
    this.tauMax = Math.ceil(this.ar / MIN_F0);
    this.W = Math.max(256, Math.round(this.ar * 0.011));
    this.DSIZE = 4096;
    this.DMASK = this.DSIZE - 1;
    this.decBuf = new Float32Array(this.DSIZE);
    this.frame = new Float32Array(this.W + this.tauMax + 2);
    this.diff = new Float32Array(this.tauMax + 2);
    const fc = Math.min(2500, 0.4 * this.ar);
    const w0 = 2 * Math.PI * fc / sr;
    const alpha = Math.sin(w0) / (2 * 0.7071);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    this.lb0 = (1 - cw) / 2 / a0; this.lb1 = (1 - cw) / a0; this.lb2 = this.lb0;
    this.la1 = -2 * cw / a0; this.la2 = (1 - alpha) / a0;
    this.HOP = 256;
    this.HN = 64;
    this.histTime = new Float64Array(this.HN);
    this.histPeriod = new Float32Array(this.HN);
    const masks = [
      [0,1,2,3,4,5,6,7,8,9,10,11],
      [0,2,4,5,7,9,11],
      [0,2,3,5,7,8,10],
      [0,2,3,5,7,8,11],
      [0,3,5,7,10]
    ];
    this.scaleMask = masks.map(function (notes) {
      const m = new Uint8Array(12);
      for (let i = 0; i < notes.length; i++) m[notes[i]] = 1;
      return m;
    });
    // Mode basse latence (prise de voix) : lecture a vitesse variable avec
    // raccords synchrones de la periode, cf. llProcess.
    this.llDmin = Math.round(0.0005 * sr) + 4;
    this.llOut = new Float32Array(128);
    this.reset();
  }

  reset() {
    this.inBuf.fill(0); this.acc.fill(0); this.wsum.fill(0); this.decBuf.fill(0);
    this.inCount = 0;
    this.outCount = 0;
    this.nextSynth = 0;
    this.anaMark = -this.latency;
    this.decCount = 0; this.decPhase = 0;
    this.lx1 = 0; this.lx2 = 0; this.ly1 = 0; this.ly2 = 0;
    this.hopCounter = 0;
    this.histCount = 0;
    this.prevP1 = 0; this.prevP2 = 0; this.unvoicedRun = 0;
    this.corr = 0; this.curTarget = -1; this.heldTime = 0;
    this.lastDetectedFreq = 0; this.lastTargetFreq = 0; this.lastVoiced = false;
    this.msgCounter = 0;
    this.wasBypassed = false;
    this.llInit = false; this.llRp = 0; this.llOldRp = 0; this.llX = 0; this.llXLen = 1;
    this.llCorr = 0; this.llTarget = -1; this.llHeld = 0; this.llRatio = 1; this.llVoiced = false;
    this.llMix = -1;
  }

  static get parameterDescriptors() {
    return [
      { name: 'retuneSpeed', defaultValue: 0.1, minValue: 0.0, maxValue: 1.0 },
      { name: 'amount', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'humanize', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'rootKey', defaultValue: 0, minValue: 0, maxValue: 11 },
      { name: 'scaleType', defaultValue: 0, minValue: 0, maxValue: 4 },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'lowLatency', defaultValue: 0, minValue: 0, maxValue: 1 },
      // Départ de lecture : compteur programmé au bloc du départ, l'analyse repart à neuf (comme l'export).
      { name: 'resetGen', defaultValue: 0, minValue: 0, maxValue: 1e9, automationRate: 'k-rate' }
    ];
  }

  // YIN sur la trame decimee la plus recente. Renvoie la periode en
  // echantillons d'entree, ou 0 si la trame n'est pas voisee.
  detectPeriod() {
    const W = this.W, tMax = this.tauMax, N = W + tMax;
    if (this.decCount < N) return 0;
    const f = this.frame;
    const start = this.decCount - N;
    for (let i = 0; i < N; i++) f[i] = this.decBuf[(start + i) & this.DMASK];
    let energy = 0;
    for (let i = 0; i < W; i++) energy += f[i] * f[i];
    if (Math.sqrt(energy / W) < 0.004) return 0; // silence / souffle
    const d = this.diff;
    d[0] = 1;
    let running = 0, cand = -1, last = tMax;
    for (let tau = 1; tau <= tMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const x = f[j] - f[j + tau]; s += x * x; }
      running += s;
      d[tau] = running > 0 ? s * tau / running : 1;
      if (tau >= this.tauMin) {
        if (cand < 0) { if (d[tau] < 0.15) cand = tau; }
        else if (d[tau] < d[cand]) cand = tau;
        else { last = tau; break; }
      }
    }
    if (cand < 0) {
      // Pas de creux net : on prend le minimum global s'il reste credible.
      let best = this.tauMin;
      for (let tau = this.tauMin; tau <= tMax; tau++) if (d[tau] < d[best]) best = tau;
      if (d[best] > 0.25) return 0;
      cand = best;
      last = tMax;
    }
    let tauF = cand;
    if (cand > 1 && cand < last) {
      const a = d[cand - 1], b = d[cand], c = d[cand + 1];
      const den = a - 2 * b + c;
      if (den > 1e-12) tauF = cand + Math.max(-1, Math.min(1, 0.5 * (a - c) / den));
    }
    return tauF * this.D;
  }

  pushEstimate(time, p) {
    let stored = 0;
    if (p > 0) {
      this.unvoicedRun = 0;
      // Mediane sur 3 trames : supprime les sauts d'octave isoles. La mediane
      // represente la trame du milieu, d'ou le recul d'un pas d'analyse.
      stored = p;
      if (this.prevP1 > 0 && this.prevP2 > 0) {
        const a = p, b = this.prevP1, c = this.prevP2;
        stored = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
        time -= this.HOP;
      }
      this.prevP2 = this.prevP1; this.prevP1 = p;
    } else {
      this.unvoicedRun++;
      // Petit maintien : une trame ratee au milieu d'une note ne coupe pas la correction.
      if (this.unvoicedRun <= 2 && this.prevP1 > 0) stored = this.prevP1;
      else { this.prevP1 = 0; this.prevP2 = 0; }
    }
    const k = this.histCount % this.HN;
    this.histTime[k] = time;
    this.histPeriod[k] = stored;
    this.histCount++;
  }

  // Periode a l'instant t (interpolee entre les deux trames qui l'encadrent) :
  // la correction est appliquee au son qui a reellement ete analyse.
  lookup(t) {
    const n = Math.min(this.histCount, this.HN);
    if (n === 0) return 0;
    let k = this.histCount - 1;
    let newerT = 0, newerP = -1;
    for (let i = 0; i < n; i++, k--) {
      const idx = k % this.HN;
      const ti = this.histTime[idx], pi = this.histPeriod[idx];
      if (ti <= t) {
        if (newerP > 0 && pi > 0 && newerT > ti && Math.abs(newerP - pi) < 0.15 * pi) {
          return pi + (newerP - pi) * (t - ti) / (newerT - ti);
        }
        return pi;
      }
      newerT = ti; newerP = pi;
    }
    return this.histPeriod[(this.histCount - n) % this.HN];
  }

  nearestNote(midi, rootKey, mask) {
    let best = Math.round(midi), bestD = 1e9;
    const lo = Math.floor(midi) - 6, hi = Math.ceil(midi) + 6;
    for (let k = lo; k <= hi; k++) {
      const pc = (((k - rootKey) % 12) + 12) % 12;
      if (!mask[pc]) continue;
      const dd = Math.abs(k - midi);
      if (dd < bestD) { bestD = dd; best = k; }
    }
    return best;
  }

  // Hysteresis : on ne change de note cible que si la voix est nettement plus
  // proche de la nouvelle. Sans ca, une note tenue entre deux degres oscillait
  // d'une note a l'autre (le fameux "warble").
  chooseTarget(midi, rootKey, mask, cur) {
    const cand = this.nearestNote(midi, rootKey, mask);
    if (cur < 0 || cand === cur) return cand;
    const curPc = (((cur - rootKey) % 12) + 12) % 12;
    if (!mask[curPc]) return cand;
    if (Math.abs(midi - cur) - Math.abs(midi - cand) > 0.25) return cand;
    return cur;
  }

  placeGrains(blockEnd, speed, amount, humanize, rootKey, mask) {
    const sr = sampleRate;
    for (let guard = 0; guard < 64; guard++) {
      const ts = this.nextSynth;
      const taNom = ts - this.latency;
      const est = this.lookup(taNom);
      const voiced = est > 0;
      let P = voiced ? est : this.pUnvoiced;
      if (P > this.pMax) P = this.pMax;
      if (P < 16) P = 16;
      if (ts - P >= blockEnd) break;
      const dt = P / sr;
      let ratio = 1;
      if (voiced) {
        const f0 = sr / P;
        const midi = 69 + 12 * Math.log2(f0 / 440);
        const tgt = this.chooseTarget(midi, rootKey, mask, this.curTarget);
        if (tgt !== this.curTarget) { this.curTarget = tgt; this.heldTime = 0; }
        else this.heldTime += dt;
        const want = (tgt - midi) * 100;
        // Vitesse : 0 = instantane (effet robot), 1 = ~300 ms (naturel).
        // Humanize ralentit la correction sur les notes tenues pour garder
        // le vibrato et la vie de la voix, sans toucher aux attaques.
        let tau = 0.3 * speed * speed;
        const hold = Math.max(0, Math.min(1, (this.heldTime - 0.08) / 0.25));
        tau += humanize * humanize * 0.25 * hold;
        const a = tau < 0.0005 ? 1 : 1 - Math.exp(-dt / tau);
        this.corr += (want - this.corr) * a;
        ratio = Math.pow(2, (this.corr * amount) / 1200);
        if (ratio < 0.5) ratio = 0.5; else if (ratio > 2) ratio = 2;
        this.lastDetectedFreq = f0;
        this.lastTargetFreq = 440 * Math.pow(2, (tgt - 69) / 12);
      } else {
        // Consonnes, souffles, silences : aucune transposition.
        this.corr *= Math.exp(-dt / 0.03);
        this.curTarget = -1;
      }
      this.lastVoiced = voiced;

      // Centre d'analyse : marques espacees d'une periode (coherence de phase
      // entre grains). Hors voisement on lit exactement a la position nominale.
      let ta;
      if (voiced) {
        while (this.anaMark + P <= taNom) this.anaMark += P;
        ta = this.anaMark;
        if (taNom - ta > 0.5 * P) ta += P;
      } else {
        ta = taNom;
      }
      const limit = this.inCount - P - 2;
      while (ta > limit) ta -= P;
      this.anaMark = ta;

      const tsI = Math.round(ts);
      const base = Math.floor(ta);
      const frac = ta - base;
      const Pi = Math.floor(P);
      const invP = Math.PI / P;
      // Jamais d'ecriture dans des echantillons deja sortis.
      const kStart = Math.max(-Pi + 1, this.outCount - tsI);
      const inB = this.inBuf, acc = this.acc, ws = this.wsum, M = this.MASK;
      for (let k = kStart; k < Pi; k++) {
        const w = 0.5 + 0.5 * Math.cos(k * invP);
        const i0 = (base + k) & M;
        const s0 = inB[i0];
        const s = s0 + (inB[(i0 + 1) & M] - s0) * frac;
        const o = (tsI + k) & M;
        acc[o] += w * s;
        ws[o] += w;
      }
      this.nextSynth = ts + P / ratio;
    }
  }

  hermite(pos) {
    const i = Math.floor(pos), t = pos - i, M = this.MASK, b = this.inBuf;
    const xm1 = b[(i - 1) & M], x0 = b[i & M], x1 = b[(i + 1) & M], x2 = b[(i + 2) & M];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
  }

  // Mode basse latence (prise de voix, retour casque) : principe des
  // correcteurs temps reel historiques (Auto-Tune d'origine) : la voix est
  // relue a vitesse variable (rapport = correction voulue) et, quand la tete
  // de lecture rattrape l'ecriture (ou s'en eloigne), elle saute d'un nombre
  // entier de periodes avec un fondu enchaine : les deux tetes sont alors en
  // phase, le raccord est inaudible. Le retard reste entre llDmin (0,5 ms) et
  // llDmin + une periode (moyenne ~4 ms pour une voix a 150 Hz), au lieu des
  // ~27 ms de la PSOLA. Contrepartie : les formants suivent la correction
  // (quelques % pour un demi-ton), acceptable pour le retour casque ; la
  // lecture et l'export utilisent la PSOLA qui preserve les formants.
  llProcess(n, speed, amount, humanize, rootKey, mask) {
    const sr = sampleRate;
    const dt = n / sr;
    // Derniere estimation (pas de recul d'analyse : on suit la voix au plus pres)
    const est = this.histCount > 0 ? this.histPeriod[(this.histCount - 1) % this.HN] : 0;
    const voiced = est > 0;
    if (voiced) {
      const f0 = sr / est;
      const midi = 69 + 12 * Math.log2(f0 / 440);
      const tgt = this.chooseTarget(midi, rootKey, mask, this.llTarget);
      if (tgt !== this.llTarget) { this.llTarget = tgt; this.llHeld = 0; } else this.llHeld += dt;
      const want = (tgt - midi) * 100;
      let tau = 0.3 * speed * speed;
      const hold = Math.max(0, Math.min(1, (this.llHeld - 0.08) / 0.25));
      tau += humanize * humanize * 0.25 * hold;
      const a = tau < 0.0005 ? 1 : 1 - Math.exp(-dt / tau);
      this.llCorr += (want - this.llCorr) * a;
    } else {
      this.llCorr *= Math.exp(-dt / 0.03);
      this.llTarget = -1;
    }
    let ratio = Math.pow(2, (this.llCorr * amount) / 1200);
    if (ratio < 0.7) ratio = 0.7; else if (ratio > 1.4) ratio = 1.4;
    // Saut = une periode (au moins 2 ms pour un fondu propre) ; hors voisement, 6 ms.
    let Pj = voiced ? est : Math.round(0.006 * sr);
    const minJ = Math.round(0.002 * sr);
    if (Pj < minJ) Pj *= Math.ceil(minJ / Pj);
    const base = this.inCount - n;
    const Dmin = this.llDmin, out = this.llOut;
    if (!this.llInit) { this.llRp = base - 1 - Dmin; this.llX = 0; this.llRatio = ratio; this.llInit = true; }
    let rp = this.llRp, op = this.llOldRp, x = this.llX;
    const r0 = this.llRatio;
    for (let i = 0; i < n; i++) {
      const now = base + i;
      const rr = r0 + (ratio - r0) * (i + 1) / n;
      rp += rr;
      if (x > 0) op += rr;
      const d = now - rp;
      if (x <= 0) {
        if (d < Dmin + Pj * Math.max(0, rr - 1)) { op = rp; rp -= Pj; x = this.llXLen = Math.round(Pj); }
        else if (d > Dmin + Pj * (1 + Math.max(0, 1 - rr)) + 2) { op = rp; rp += Pj; x = this.llXLen = Math.round(Pj); }
      }
      if (now - rp < 3) rp = now - 3;
      let y = this.hermite(rp);
      if (x > 0) {
        if (now - op < 3) op = now - 3;
        // Poids de l'ancienne tete : 1 -> 0 (cosinus sureleve)
        const g = 0.5 - 0.5 * Math.cos(Math.PI * x / this.llXLen);
        y = y * (1 - g) + this.hermite(op) * g;
        x--;
      }
      out[i] = y;
    }
    this.llRp = rp; this.llOldRp = op; this.llX = x; this.llRatio = ratio;
  }

  process(inputs, outputs, parameters) {
    if (parameters.resetGen && parameters.resetGen[0] !== (this.gen || 0)) { this.gen = parameters.resetGen[0]; this.reset(); }
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    if (parameters.bypass[0] > 0.5) {
      for (let c = 0; c < output.length; c++) {
        const src = input && (input[c] || input[0]);
        if (src) output[c].set(src); else output[c].fill(0);
      }
      this.wasBypassed = true;
      return true;
    }
    if (this.wasBypassed) this.reset();
    const outData = output[0];
    const blockSize = outData.length;
    // Analyse et correction sur la somme mono, puis sortie sur tous les canaux :
    // avant, seul le canal gauche ressortait (voix a gauche uniquement).
    let channelData = null;
    if (input && input.length > 0 && input[0]) {
      channelData = input[0];
      if (input.length > 1) {
        if (!this.monoBuf || this.monoBuf.length !== channelData.length) this.monoBuf = new Float32Array(channelData.length);
        const k = 1 / input.length;
        for (let i = 0; i < channelData.length; i++) {
          let v = 0;
          for (let c = 0; c < input.length; c++) v += input[c][i];
          this.monoBuf[i] = v * k;
        }
        channelData = this.monoBuf;
      }
    }
    const speed = parameters.retuneSpeed[0];
    const amount = parameters.amount[0];
    const humanize = parameters.humanize[0];
    const rootKey = Math.round(parameters.rootKey[0]);
    const scaleIdx = Math.max(0, Math.min(4, Math.round(parameters.scaleType[0])));
    const mask = this.scaleMask[scaleIdx];

    // 1. Ecriture de l'entree + filtre/decimation pour l'analyse
    const b0 = this.lb0, b1 = this.lb1, b2 = this.lb2, a1 = this.la1, a2 = this.la2;
    for (let i = 0; i < blockSize; i++) {
      const x = channelData ? channelData[i] : 0;
      this.inBuf[this.inCount & this.MASK] = x;
      this.inCount++;
      let y = b0 * x + b1 * this.lx1 + b2 * this.lx2 - a1 * this.ly1 - a2 * this.ly2;
      if (y < 1e-15 && y > -1e-15) y = 0; // pas de denormaux
      this.lx2 = this.lx1; this.lx1 = x; this.ly2 = this.ly1; this.ly1 = y;
      if (++this.decPhase >= this.D) {
        this.decPhase = 0;
        this.decBuf[this.decCount & this.DMASK] = y;
        this.decCount++;
      }
    }

    // 2. Detection de hauteur toutes les HOP echantillons
    this.hopCounter += blockSize;
    if (this.hopCounter >= this.HOP) {
      this.hopCounter -= this.HOP;
      const p = this.detectPeriod();
      const center = (this.decCount - (this.W + this.tauMax) / 2) * this.D;
      this.pushEstimate(center, p);
    }

    // 3. Placement des grains puis lecture normalisee
    const blockEnd = this.outCount + blockSize;
    this.placeGrains(blockEnd, speed, amount, humanize, rootKey, mask);
    const M = this.MASK;
    for (let i = 0; i < blockSize; i++) {
      const idx = (this.outCount + i) & M;
      const w = this.wsum[idx];
      outData[i] = w > 1e-4 ? this.acc[idx] / w : 0;
      this.acc[idx] = 0;
      this.wsum[idx] = 0;
    }
    this.outCount = blockEnd;

    // 4. Mode basse latence, avec fondu de 20 ms entre les deux moteurs
    const llWanted = parameters.lowLatency[0] > 0.5 ? 1 : 0;
    if (this.llMix < 0) this.llMix = llWanted; // premier bloc : pas de fondu
    if (llWanted > 0 || this.llMix > 0) {
      if (this.llOut.length < blockSize) this.llOut = new Float32Array(blockSize);
      this.llProcess(blockSize, speed, amount, humanize, rootKey, mask);
      const step = 1 / (0.02 * sampleRate);
      let m = this.llMix;
      for (let i = 0; i < blockSize; i++) {
        if (m < llWanted) m = Math.min(llWanted, m + step); else if (m > llWanted) m = Math.max(llWanted, m - step);
        outData[i] = outData[i] * (1 - m) + this.llOut[i] * m;
      }
      this.llMix = m;
    } else {
      // Repartira d'un retard minimal a la prochaine activation
      this.llInit = false; this.llCorr = 0; this.llTarget = -1;
    }
    for (let c = 1; c < output.length; c++) output[c].set(outData);

    if (++this.msgCounter >= 8) {
      this.msgCounter = 0;
      this.port.postMessage({
        detectedFreq: this.lastVoiced ? this.lastDetectedFreq : 0,
        targetFreq: this.lastVoiced ? this.lastTargetFreq : 0,
        correctionCents: this.lastVoiced ? this.corr * amount : 0
      });
    }
    return true;
  }
}
// Deux AutoTune dans le meme contexte chargent deux fois le module : le second
// enregistrement leverait une erreur et ferait passer l'instance en bypass.
try { registerProcessor('auto-tune-processor-r', AutoTuneProcessor); } catch (e) {}
`;

// Un seul chargement du module par contexte audio (temps reel ou offline).
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
function loadAutoTuneModule(ctx: BaseAudioContext): Promise<void> {
  let p = moduleLoads.get(ctx);
  if (!p) {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    // Une fois le module charge, l'URL d'objet ne sert plus : sans cette
    // liberation chaque instance d'AutoTune laissait fuiter son blob.
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    moduleLoads.set(ctx, p);
    p.catch(() => moduleLoads.delete(ctx));
  }
  return p;
}

/** Latence fixe du moteur (en echantillons), identique au calcul du worklet. */
export function autoTuneLatencySamples(sampleRate: number): number {
  return 2 * Math.ceil(sampleRate / 75) + 34;
}

/**
 * Latence nominale du mode basse latence (en echantillons) : retard minimal
 * (llDmin du worklet) + une demi-periode d'une voix a 150 Hz. Le retard reel
 * varie entre llDmin et llDmin + une periode selon les raccords.
 */
export function autoTuneLowLatencySamples(sampleRate: number): number {
  return Math.round(0.0005 * sampleRate) + 4 + Math.round(sampleRate / 300);
}

export interface AutoTuneParams {
  speed: number;      // 0.0 (robot, instantane) to 1.0 (~300 ms, naturel)
  humanize: number;   // 0.0 to 1.0 : ralentit la correction sur les notes tenues
  mix: number;        // 0.0 to 1.0 : intensite de la correction (0 = voix non corrigee)
  rootKey: number;    // 0 to 11
  scale: string;      // Scale Name
  isEnabled: boolean;
  /**
   * Mode basse latence (piste armee : retour casque) : ~4 ms au lieu de ~27 ms.
   * Bascule en fondu de 20 ms. Optionnel, desactive par defaut.
   */
  lowLatency?: boolean;
}

export class AutoTuneNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private worklet: AudioWorkletNode | null = null;
  private onStatusCallback: ((data: any) => void) | null = null;
  /** Réglages automatisables (R8) : vitesse, intensité, humanisation. */
  private auto = new AutomationSet();
  private autoForce = true;

  private params: AutoTuneParams = {
    speed: 0.1,
    humanize: 0.2,
    mix: 1.0,
    rootKey: 0,
    scale: 'CHROMATIC',
    isEnabled: true,
    lowLatency: false
  };

  /**
   * Le worklet se charge de maniere asynchrone : tant qu'il n'est pas pret,
   * input n'est relie a rien. Le rendu offline doit attendre cette promesse,
   * sinon la piste sort silencieuse dans l'export.
   */
  public readonly ready: Promise<void>;

  private readonly hqLatency: number;
  private readonly llLatency: number;

  /**
   * Retard introduit, en secondes, selon le mode courant : ~27 ms en PSOLA
   * (lecture, export), ~4 ms en mode basse latence. Relu par le moteur apres
   * chaque updateParams({ lowLatency }) pour la compensation de lecture.
   */
  public get latency(): number {
    if (this.failed) return 0; // passage direct : aucun retard
    return this.params.lowLatency ? this.llLatency : this.hqLatency;
  }
  private failed = false;
  private disposed = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.hqLatency = autoTuneLatencySamples(ctx.sampleRate) / ctx.sampleRate;
    this.llLatency = autoTuneLowLatencySamples(ctx.sampleRate) / ctx.sampleRate;
    this.ready = this.initWorklet();
  }

  private resetCount = 0;
  /** Départ de la lecture à `at` (début d'un bloc de rendu) : détection et resynthèse repartent à neuf. */
  public resetAt(at: number) {
    const ap = this.worklet?.parameters.get('resetGen');
    if (!ap) return;
    try { ap.setValueAtTime(++this.resetCount, Math.max(this.ctx.currentTime, at - 0.5 / this.ctx.sampleRate)); } catch { /* */ }
  }

  private async initWorklet() {
    try {
      await loadAutoTuneModule(this.ctx);
      if (this.disposed) return;

      this.worklet = new AudioWorkletNode(this.ctx, 'auto-tune-processor-r', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        parameterData: {
          retuneSpeed: this.params.speed,
          amount: this.params.mix,
          humanize: this.params.humanize,
          rootKey: this.params.rootKey,
          scaleType: Math.max(0, SCALES.indexOf(this.params.scale)),
          lowLatency: this.params.lowLatency ? 1 : 0
        }
      });

      this.worklet.port.onmessage = (event) => {
        if (this.onStatusCallback) {
          this.onStatusCallback(event.data);
        }
      };

      this.input.disconnect();
      this.input.connect(this.worklet);
      this.worklet.connect(this.output);
      const wp = this.worklet.parameters;
      this.auto.add('speed', new MappedParam(this.ctx, [{ param: wp.get('retuneSpeed')! }], { min: 0, max: 1, value: this.params.speed, affine: true }));
      this.auto.add('mix', new MappedParam(this.ctx, [{ param: wp.get('amount')! }], { min: 0, max: 1, value: this.params.mix, affine: true }));
      this.auto.add('humanize', new MappedParam(this.ctx, [{ param: wp.get('humanize')! }], { min: 0, max: 1, value: this.params.humanize, affine: true }));
      this.autoForce = true;

      this.applyParams(); 

    } catch (e) {
      console.error("[AutoTune] Worklet Load Error:", e);
      // Fallback: Bypass if fails
      this.failed = true;
      this.input.connect(this.output);
    }
  }

  public updateParams(p: Partial<AutoTuneParams>) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  private applyParams() {
    if (!this.worklet) return;

    const { speed, mix, humanize, rootKey, scale, isEnabled } = this.params;
    const params = this.worklet.parameters;
    const now = this.ctx.currentTime;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    
    params.get('bypass')?.setValueAtTime(isEnabled ? 0 : 1, now);
    // Le worklet fait lui-meme le fondu entre les deux moteurs.
    params.get('lowLatency')?.setValueAtTime(this.params.lowLatency ? 1 : 0, now);
    // Automatisables (R8) : posés seulement s'ils ont changé (une voie d'automation garde la main).
    const st = { force: this.autoForce, tau: 0.01 };
    this.autoForce = false;
    this.auto.get('speed')?.setStatic(safe(speed, 0.1), st);
    this.auto.get('mix')?.setStatic(safe(mix, 1), st);
    this.auto.get('humanize')?.setStatic(safe(humanize, 0), st);
    params.get('rootKey')?.setValueAtTime(safe(rootKey, 0), now);
    const scaleIdx = SCALES.indexOf(scale);
    params.get('scaleType')?.setValueAtTime(scaleIdx >= 0 ? scaleIdx : 0, now);
  }

  public setStatusCallback(cb: (data: any) => void) {
    this.onStatusCallback = cb;
  }

  /** AudioParam d'un réglage automatisable (R8) : « speed », « mix », « humanize » ; sinon null. */
  public automationParam(key: string): MappedParam | null { return this.auto.get(key); }
  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  /**
   * Libere le worklet : sans ca, une instance retiree de la chaine continuait
   * de calculer (son process renvoie toujours true) jusqu'a la fermeture du contexte.
   */
  public dispose() {
    this.disposed = true;
    this.onStatusCallback = null;
    try { this.input.disconnect(); } catch (e) {}
    if (this.worklet) {
      // Mis à la retraite : process() renverra false (sinon il restait calculé jusqu'à la fermeture du contexte).
      retireWorkletNode(this.worklet);
      this.worklet = null;
    }
  }
}

interface AutoTuneUIProps {
  node: AutoTuneNode;
  initialParams: AutoTuneParams;
  onParamsChange?: (p: AutoTuneParams) => void;
}

// ── Fenêtre ─────────────────────────────────────────────────────────────────

const AT_ACCENT = '#c6f432';
/** Notes de chaque gamme (mêmes masques que le worklet). */
const AT_SCALE_NOTES: Record<string, number[]> = {
  CHROMATIC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], MAJOR: [0, 2, 4, 5, 7, 9, 11], MINOR: [0, 2, 3, 5, 7, 8, 10],
  MINOR_HARMONIC: [0, 2, 3, 5, 7, 8, 11], PENTATONIC: [0, 3, 5, 7, 10],
};
const AT_SCALE_SHORT: Record<string, string> = { CHROMATIC: 'Chromatique', MAJOR: 'Majeure', MINOR: 'Mineure', MINOR_HARMONIC: 'Min. harmonique', PENTATONIC: 'Pentatonique' };
const AT_SCALE_HINT: Record<string, string> = {
  CHROMATIC: 'Toutes les notes : la voix est ramenée au demi-ton le plus proche (sûr si tu ne connais pas la tonalité).',
  MAJOR: 'Gamme majeure de la tonalité choisie.', MINOR: 'Gamme mineure naturelle de la tonalité choisie (la plus courante en rap).',
  MINOR_HARMONIC: 'Mineure harmonique : comme la mineure, avec la 7e relevée (couleur orientale).',
  PENTATONIC: 'Pentatonique mineure : 5 notes seulement, correction très marquée et « sûre ».',
};
const NOTE_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const noteOf = (freq: number) => (freq > 0 ? ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12 : -1);
const speedText = (v: number) => (v < 0.05 ? 'Robot' : `${Math.round(300 * v * v)} ms`);

/**
 * Écran de Nova Tune : note visée en grand, note chantée, et aiguille de la
 * correction (± 100 cents). Les messages du moteur (~45 par seconde) sont lus
 * dans une boucle d'image qui écrit directement dans l'écran : la façade ne se
 * redessine pas.
 */
const TuneScreen: React.FC<{ node: AutoTuneNode; enabled: boolean }> = ({ node, enabled }) => {
  const data = useRef({ detectedFreq: 0, targetFreq: 0, correctionCents: 0, at: 0 });
  const needle = useRef<SVGGElement | null>(null);
  const target = useRef<HTMLSpanElement | null>(null);
  const sung = useRef<HTMLSpanElement | null>(null);
  const cents = useRef<HTMLSpanElement | null>(null);
  const help = useHwHelp('at-screen', 'Écran de justesse', 'En grand : la note visée. Dessous : la note chantée. L’aiguille montre la correction appliquée, en cents (100 cents = un demi-ton).', undefined);
  useEffect(() => {
    node?.setStatusCallback?.((d: any) => { data.current = { ...data.current, ...(d || {}), at: performance.now() }; });
    let raf = 0;
    let shown = { ang: 999, t: '', s: '', c: '' };
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const d = data.current;
      const live = t - d.at < 400 && d.detectedFreq > 50;
      const c = live ? Math.max(-100, Math.min(100, d.correctionCents || 0)) : 0;
      const ang = Math.round(c * 0.6 * 10) / 10;
      const tn = live && d.targetFreq > 0 ? NOTES[noteOf(d.targetFreq)] : '--';
      const sn = live ? `Chantée : ${NOTES[noteOf(d.detectedFreq)]} (${NOTE_FR[noteOf(d.detectedFreq)]})` : 'En attente de voix…';
      const ct = live ? `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(Math.round(c))} cents` : '';
      if (ang !== shown.ang && needle.current) needle.current.setAttribute('transform', `rotate(${ang} 100 104)`);
      if (tn !== shown.t && target.current) target.current.textContent = tn;
      if (sn !== shown.s && sung.current) sung.current.textContent = sn;
      if (ct !== shown.c && cents.current) cents.current.textContent = ct;
      shown = { ang, t: tn, s: sn, c: ct };
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); node?.setStatusCallback?.(() => {}); };
  }, [node]);
  const ticks = [];
  for (let k = -100; k <= 100; k += 10) {
    const a = ((k * 0.6 - 90) * Math.PI) / 180;
    const r0 = k % 50 === 0 ? 74 : 80;
    ticks.push(<line key={k} x1={100 + Math.cos(a) * r0} y1={104 + Math.sin(a) * r0} x2={100 + Math.cos(a) * 88} y2={104 + Math.sin(a) * 88}
      stroke={k === 0 ? AT_ACCENT : 'rgba(226,232,240,0.6)'} strokeWidth={k % 50 === 0 ? 2 : 1} />);
  }
  return (
    <div className="relative h-full w-full flex flex-col items-center justify-start pt-1.5" onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}
      style={{ opacity: enabled ? 1 : 0.5 }} data-nova-tune-screen>
      <svg viewBox="0 0 200 112" style={{ width: 'min(100%, 230px)', flex: 'none' }} aria-hidden="true">
        <path d="M 22 104 A 78 78 0 0 1 178 104" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="14" />
        <path d="M 87 27 A 78 78 0 0 1 113 27" fill="none" stroke={AT_ACCENT} strokeOpacity="0.35" strokeWidth="14" />
        {ticks}
        <text x="22" y="100" fill="rgba(226,232,240,0.75)" fontSize="8" fontWeight="700" textAnchor="middle">−100</text>
        <text x="178" y="100" fill="rgba(226,232,240,0.75)" fontSize="8" fontWeight="700" textAnchor="middle">+100</text>
        <g ref={needle} transform="rotate(0 100 104)">
          <line x1="100" y1="104" x2="100" y2="20" stroke="#f8fafc" strokeWidth="2" strokeLinecap="round" />
        </g>
        <circle cx="100" cy="104" r="4" fill="#f8fafc" />
      </svg>
      <div className="relative z-10 -mt-1 flex flex-col items-center pointer-events-none">
        <span className="hw-silk" style={{ color: AT_ACCENT, fontSize: 9 }}>Note visée</span>
        <span ref={target} className="font-mono font-black leading-none" style={{ fontSize: 40, color: '#f8fafc', textShadow: `0 0 18px ${AT_ACCENT}55` }}>--</span>
        <span ref={sung} className="mt-1 text-[11px] font-bold" style={{ color: '#cbd5e1' }}>En attente de voix…</span>
        <span ref={cents} className="text-[10px] font-mono font-bold" style={{ color: AT_ACCENT, minHeight: 13 }} />
      </div>
    </div>
  );
};

/** Clavier d'une octave : clic = tonalité ; point vert = note de la gamme. */
const KeyPiano: React.FC<{ root: number; scale: string; onPick: (n: number) => void }> = ({ root, scale, onPick }) => {
  const inScale = new Set((AT_SCALE_NOTES[scale] || AT_SCALE_NOTES.CHROMATIC).map(i => (i + root) % 12));
  const whites = [0, 2, 4, 5, 7, 9, 11];
  const blacks: [number, number][] = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]; // note, position après la n-ième touche blanche
  const help = useHwHelp('at-key', 'Tonalité', 'Touche la note de base du morceau. Les points verts montrent les notes de la gamme vers lesquelles la voix est ramenée.', `${NOTES[root]} (${NOTE_FR[root]})`);
  const key = (n: number, style: React.CSSProperties, black: boolean) => (
    <button key={n} type="button" role="radio" aria-checked={root === n} aria-label={`${NOTES[n]} (${NOTE_FR[n]})`} data-in={inScale.has(n) ? 'true' : 'false'}
      className={`hw-piano-key ${black ? 'hw-piano-black' : 'hw-piano-white'}`} style={style} onClick={() => onPick(n)} title={`Tonalité : ${NOTES[n]} (${NOTE_FR[n]})`}
      tabIndex={root === n ? 0 : -1}
      onKeyDown={e => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        onPick((root + d + 12) % 12);
      }}>
      {NOTES[n]}
    </button>
  );
  const ww = 100 / 7;
  return (
    <div className="hw-piano" role="radiogroup" aria-label="Tonalité" onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave} onFocus={help.onFocus} onBlur={help.onBlur} data-nova-param="rootKey">
      {whites.map((n, i) => key(n, { left: `calc(${i * ww}% + 1px)`, width: `calc(${ww}% - 2px)` }, false))}
      {blacks.map(([n, pos]) => key(n, { left: `calc(${pos * ww}% - ${ww * 0.3}%)`, width: `${ww * 0.6}%` }, true))}
    </div>
  );
};

export const AutoTuneUI: React.FC<AutoTuneUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<AutoTuneParams>(initialParams);
  const paramsRef = useRef<AutoTuneParams>(initialParams);

  const updateParam = useCallback((key: keyof AutoTuneParams, value: any) => {
    const next = { ...paramsRef.current, [key]: value };
    paramsRef.current = next;
    setParams(next);
    node.updateParams(next);
    onParamsChange?.(next);
  }, [node, onParamsChange]);

  const num = (v: any, def: number) => (Number.isFinite(+v) ? +v : def);
  const scale = SCALES.includes(params.scale) ? params.scale : 'CHROMATIC';
  const root = Math.max(0, Math.min(11, Math.round(num(params.rootKey, 0))));

  return (
    <HwWindow type="AUTOTUNE" width={620} accent={AT_ACCENT} accentInk="#152003"
      idleHelp={<>Ramène la voix sur les notes justes. Choisis la tonalité et la gamme du morceau, puis la vitesse : rapide = effet robot, lente = correction naturelle. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="black" className="hw-finish-carbon" model="Nova Tune" kicker="Correction de justesse en temps réel" modelStyle="wide" style={{ ['--hw-accent' as any]: AT_ACCENT }}>
        <div className="hw-screen">
          <div className="hw-screen-glass" style={{ height: 222 }}><TuneScreen node={node} enabled={params.isEnabled !== false} /></div>
        </div>

        <HwSection title={`Tonalité · ${NOTES[root]} ${AT_SCALE_SHORT[scale].toLowerCase()}`} className="mt-3">
          <KeyPiano root={root} scale={scale} onPick={n => updateParam('rootKey', n)} />
          <div className="mt-3 grid grid-cols-3 sm:grid-cols-5 gap-1.5" role="radiogroup" aria-label="Gamme">
            {SCALES.map(s => (
              <PushButton key={s} role="radio" active={scale === s} onClick={() => updateParam('scale', s)} text={AT_SCALE_SHORT[s]} led={AT_ACCENT} dark
                hint={AT_SCALE_HINT[s]} ariaLabel={SCALE_LABELS[s] || s} valueText={scale === s ? 'choisie' : undefined} dataAttrs={{ 'data-nova-scale': s }} />
            ))}
          </div>
        </HwSection>

        <div className="hw-rule" style={{ margin: '12px 0 8px' }} />
        <div className="flex flex-wrap items-center justify-around gap-x-2 gap-y-2">
          <Knob paramId="humanize" label="Naturel" ariaLabel="Naturel (humanisation)" size="M" cap="graphite" arc={AT_ACCENT} min={0} max={1} step={0.01}
            value={num(params.humanize, 0.2)} defaultValue={0.2} onChange={v => updateParam('humanize', v)} format={v => `${Math.round(v * 100)} %`} ticks={11}
            hint="Laisse vivre les notes tenues (vibrato) en corrigeant plus doucement quand la note dure." />
          <Knob paramId="speed" label="Vitesse" ariaLabel="Vitesse de correction" size="XL" cap="graphite" arc={AT_ACCENT} min={0} max={1} step={0.005}
            value={num(params.speed, 0.1)} defaultValue={0.1} onChange={v => updateParam('speed', v)} format={speedText} sub="Temps de correction (ms)"
            scale={[{ v: 0, label: '0' }, { v: Math.sqrt(25 / 300), label: '25' }, { v: 0.5, label: '75' }, { v: Math.sqrt(150 / 300), label: '150' }, { v: 1, label: '300' }]}
            hint="À gauche (0 ms) : effet robot, la note saute d’un coup. À droite : correction lente et naturelle." />
          <Knob paramId="mix" label="Dosage" ariaLabel="Dosage de la correction" size="M" cap="graphite" arc={AT_ACCENT} min={0} max={1} step={0.01}
            value={num(params.mix, 1)} defaultValue={1} onChange={v => updateParam('mix', v)} format={v => `${Math.round(v * 100)} %`} ticks={11}
            hint="Force de la correction : 100 % = note juste, 50 % = à mi-chemin, 0 % = voix d’origine." />
        </div>
      </Faceplate>
    </HwWindow>
  );
};
