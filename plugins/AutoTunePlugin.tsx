

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
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
      { name: 'lowLatency', defaultValue: 0, minValue: 0, maxValue: 1 }
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
try { registerProcessor('auto-tune-processor', AutoTuneProcessor); } catch (e) {}
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

  private async initWorklet() {
    try {
      await loadAutoTuneModule(this.ctx);
      if (this.disposed) return;

      this.worklet = new AudioWorkletNode(this.ctx, 'auto-tune-processor', {
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
    params.get('retuneSpeed')?.setTargetAtTime(safe(speed, 0.1), now, 0.01);
    params.get('amount')?.setTargetAtTime(safe(mix, 1), now, 0.01);
    params.get('humanize')?.setTargetAtTime(safe(humanize, 0), now, 0.01);
    params.get('rootKey')?.setValueAtTime(safe(rootKey, 0), now);
    const scaleIdx = SCALES.indexOf(scale);
    params.get('scaleType')?.setValueAtTime(scaleIdx >= 0 ? scaleIdx : 0, now);
  }

  public setStatusCallback(cb: (data: any) => void) {
    this.onStatusCallback = cb;
  }

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

export const AutoTuneUI: React.FC<AutoTuneUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<AutoTuneParams>(initialParams);
  const paramsRef = useRef<AutoTuneParams>(initialParams); // Ref to hold latest params for event listeners
  const [vizData, setVizData] = useState({ detectedFreq: 0, targetFreq: 0, correctionCents: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof AutoTuneParams | null>(null);

  // Sync ref with state
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    node.setStatusCallback((data) => {
      setVizData(data);
    });
    return () => node.setStatusCallback(() => {});
  }, [node]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frameId: number;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h); 
      ctx.stroke();

      ctx.fillStyle = 'rgba(0, 242, 255, 0.05)';
      ctx.fillRect(w/2 - 20, 0, 40, h);

      if (vizData.detectedFreq > 50) {
        const offset = Math.max(-100, Math.min(100, vizData.correctionCents));
        const x = (w / 2) + (offset / 100) * (w / 2 * 0.8); 

        ctx.strokeStyle = '#00f2ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(w/2, h/2 - 20); ctx.lineTo(w/2, h/2 + 20);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, h/2, 8, 0, Math.PI * 2);
        ctx.fillStyle = paramsRef.current.isEnabled ? '#ffffff' : '#555';
        ctx.fill();
        
        ctx.beginPath();
        ctx.moveTo(x, h/2);
        ctx.lineTo(w/2, h/2);
        ctx.strokeStyle = `rgba(0, 242, 255, ${Math.abs(offset) / 100})`;
        ctx.stroke();
      }

      frameId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frameId);
  }, [vizData]);

  const updateParam = (key: keyof AutoTuneParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const lastTouchY = useRef<number>(0);

  const handleMouseDown = (param: keyof AutoTuneParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const handleTouchStart = (param: keyof AutoTuneParams, e: React.TouchEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    lastTouchY.current = e.touches[0].clientY;
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 150;
    
    // FIX #310: Use ref to get current state, do not use functional update for side effects
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    
    if (typeof currentVal !== 'number') return;
    
    const newVal = Math.max(0, Math.min(1, currentVal + delta));
    const newParams = { ...currentParams, [activeParam.current!]: newVal };
    
    setParams(newParams);
    node.updateParams(newParams);
    
    if (onParamsChange) {
        // We call this directly, assuming parent handles it efficiently or debounces if needed.
        // The issue #310 comes from calling this inside setParams(prev => ... here ...).
        onParamsChange(newParams);
    }
  }, [node, onParamsChange]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging.current || !activeParam.current || e.touches.length === 0) return;
    e.preventDefault();

    const currentY = e.touches[0].clientY;
    const delta = -(currentY - lastTouchY.current) / 150;
    lastTouchY.current = currentY;

    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];

    if (typeof currentVal !== 'number') return;

    const newVal = Math.max(0, Math.min(1, currentVal + delta));
    const newParams = { ...currentParams, [activeParam.current!]: newVal };

    setParams(newParams);
    node.updateParams(newParams);

    if (onParamsChange) {
        onParamsChange(newParams);
    }
  }, [node, onParamsChange]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
    document.body.style.cursor = 'default';
  }, []);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  const getNoteName = (freq: number) => {
    if (freq <= 0) return '--';
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    return NOTES[midi % 12] || '--';
  };

  return (
    <div className="w-[480px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
            <i className="fas fa-microphone-alt text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Nova <span className="text-cyan-400">Tune</span></h2>
            <p className="text-[9px] font-bold text-slate-500 tracking-wide mt-2">Correction de justesse en temps réel</p>
          </div>
        </div>
        <button data-plugin-power 
          onClick={() => updateParam('isEnabled', !params.isEnabled)}
          title={params.isEnabled ? 'Autotune actif : clic pour le couper' : 'Autotune coupé : clic pour le réactiver'}
          aria-label={params.isEnabled ? "Couper l'autotune" : "Activer l'autotune"}
          aria-pressed={params.isEnabled}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off"></i>
        </button>
      </div>

      <div className="h-44 bg-black/60 rounded-[32px] border border-white/5 relative flex flex-col items-center justify-center overflow-hidden shadow-inner group">
        <canvas ref={canvasRef} width={400} height={176} className="absolute inset-0 opacity-60" />
        <div className="relative text-center z-10 pointer-events-none">
           <span className="block text-[9px] font-black text-cyan-500/50 uppercase tracking-[0.3em] mb-2">Note visée</span>
           <span className="text-7xl font-black text-white font-mono tracking-tighter leading-none text-shadow-glow">
             {vizData.targetFreq > 0 ? getNoteName(vizData.targetFreq) : '--'}
           </span>
           <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">
             Chantée : {getNoteName(vizData.detectedFreq)}
           </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 bg-white/[0.02] p-6 rounded-[24px] border border-white/5">
        <div className="space-y-3">
          <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest ml-1">Tonalité</label>
          <select 
            value={params.rootKey} 
            onChange={(e) => updateParam('rootKey', parseInt(e.target.value))}
            className="w-full bg-[#14161a] border border-white/10 rounded-xl p-3 text-[11px] font-black text-white hover:border-cyan-500/50 outline-none appearance-none cursor-pointer"
          >
            {NOTES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </div>
        <div className="space-y-3">
          <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest ml-1">Gamme</label>
          <select 
            value={params.scale} 
            onChange={(e) => updateParam('scale', e.target.value as any)}
            className="w-full bg-[#14161a] border border-white/10 rounded-xl p-3 text-[11px] font-black text-white hover:border-cyan-500/50 outline-none appearance-none cursor-pointer"
          >
            {SCALES.map(s => <option key={s} value={s}>{SCALE_LABELS[s] || s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-8 pt-2">
        <TuneKnob label="Vitesse" value={params.speed} defaultValue={0.1} onChange={(v) => updateParam('speed', v)} factor={100} suffix="%" inverseLabel={true} />
        <TuneKnob label="Naturel" value={params.humanize} defaultValue={0.2} onChange={(v) => updateParam('humanize', v)} factor={100} suffix="%" />
        <TuneKnob label="Dosage" value={params.mix} defaultValue={1} onChange={(v) => updateParam('mix', v)} factor={100} suffix="%" />
      </div>
    </div>
  );
};

const TuneKnob: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  defaultValue?: number;
  factor: number;
  suffix: string;
  inverseLabel?: boolean
}> = ({ label, value, onChange, defaultValue, factor, suffix, inverseLabel }) => {
  const knob = useKnobInteraction(value, onChange, { min: 0, max: 1, sensitivity: 150, defaultValue });
  const rotation = (value * 270) - 135;
  let displayValue = `${Math.round(value * factor)}${suffix}`;
  if (inverseLabel) {
      // Meme courbe que le worklet : constante de temps = 300 ms x vitesse^2.
      // L'ancien affichage etait inverse (plus lent affichait moins de ms).
      if (value < 0.05) displayValue = "ROBOT";
      else displayValue = `${Math.round(300 * value * value)}ms`;
  }

  return (
    <div className="flex flex-col items-center space-y-3 group cursor-ns-resize touch-none" {...knob.bind}>
      <div className="relative w-16 h-16 rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center shadow-lg group-hover:border-cyan-500/50 transition-colors">
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div
          className="absolute w-1.5 h-6 bg-current rounded-full origin-bottom bottom-1/2 transition-transform duration-75"
          style={{ transform: `rotate(${rotation}deg)`, color: '#00f2ff', boxShadow: `0 0 10px #00f2ff` }}
        />
      </div>
      <div className="text-center">
        <span className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[50px]">
          <span className="text-[9px] font-mono font-bold text-white">{displayValue}</span>
        </div>
      </div>
    </div>
  );
};