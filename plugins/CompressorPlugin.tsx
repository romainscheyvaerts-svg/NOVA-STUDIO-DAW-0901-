import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { PluginParameter } from '../types';
import { makeCurve, loadWorkletModule, fadeInOnInsert, isOfflineContext } from './vocalDspUtils';
import { retireWorkletNode } from '../engine/workletGuard';
import { gainDbFr, numFr, termHelp } from '../utils/pluginUi';
import { AutomationSet, MappedParam } from '../engine/automationParams';

/** Préréglages affichés en français (les clés restent celles des projets). */
const PRESET_LABELS: Record<string, string> = {
  'Vocal Smooth': 'Voix douce', 'Vocal Aggressive': 'Voix agressive', 'Mix Bus Glue': 'Colle de mix',
  'Parallel Punch': 'Punch parallèle', 'Transparent Limiter': 'Limiteur transparent',
};
const MODE_HELP: Record<string, string> = {
  CLEAN: 'Clean : compression neutre, sans couleur.', VCA: 'VCA : rapide et précis, garde le punch.',
  OPTO: 'Opto : lent et doux, très musical sur la voix.', FET: 'FET : nerveux et coloré, la voix passe devant.',
};

export interface CompressorParams {
  threshold: number;      // -60 to 0 dB
  ratio: number;          // 1:1 to 20:1
  knee: number;           // 0 to 40 dB
  attack: number;         // 0.1 to 100 ms (stored as seconds: 0.0001 to 0.1)
  release: number;        // 10 to 1000 ms (stored as seconds: 0.01 to 1.0)
  makeupGain: number;     // 0 to 24 dB (stored as linear gain)
  mix: number;            // 0 to 1 (dry/wet for parallel compression)
  scHpFreq: number;       // 20 to 500 Hz (sidechain high-pass frequency)
  lookahead: number;      // 0 to 5 ms (stored as seconds)
  autoMakeup: boolean;    // Auto-calculate makeup gain
  mode: 'CLEAN' | 'VCA' | 'OPTO' | 'FET';  // Character modes
  isEnabled: boolean;
  /**
   * Mode basse latence (piste armee pour l'enregistrement) : la pre-lecture
   * est ignoree, le compresseur n'ajoute alors aucun retard. Optionnel.
   */
  lowLatency?: boolean;
  /** Side-chain (R7) : filtre de la clé (Hz) et écoute de la clé (1 = on entend la clé). */
  keyHpf?: number;
  keyLpf?: number;
  keyListen?: number;
}

/**
 * Compresseur dans un AudioWorklet, SANS LATENCE (hors pre-lecture choisie).
 *
 * L'ancienne version reposait sur DynamicsCompressorNode, qui pose trois
 * problemes pour une voix :
 *  - 6 ms de retard fixe (sa pre-lecture interne), entendus au casque pendant
 *    la prise et compenses par un retard equivalent sur le sec ;
 *  - un gain de compensation CACHE (environ 0,6 x la reduction a 0 dBFS),
 *    ajoute au « Makeup » : 8 a 13 dB de plus sur les styles voix, et baisser
 *    le seuil rendait la voix PLUS forte ;
 *  - aucune entree de detection : le passe-haut de sidechain etait impossible.
 *
 * Ici (architecture « feed-forward, domaine log », Giannoulis/Massberg/Reiss) :
 *  - detection sur le signal filtre par le passe-haut de sidechain (scHpFreq),
 *    stereo liee ;
 *  - crete (CLEAN, FET facon 1176) ou RMS (VCA facon SSL, OPTO facon LA-2A) ;
 *  - genou doux quadratique, ratio exact : la courbe affichee est celle entendue ;
 *  - detecteur « lisse decouple » sur la reduction (pas d'ondulation sur les
 *    graves) et release dependant du programme : en OPTO, une reduction
 *    tenue longtemps se relache lentement (cellule optique du LA-2A), une
 *    crete isolee se relache vite ; effet plus discret en VCA ;
 *  - makeupGain est desormais le gain de compensation REEL (plus de gain cache).
 */
const COMP_WORKLET_CODE = `
class VocalCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 100, automationRate: 'k-rate' },
      // Les réglages non automatisables (genou, attaque, release, filtre de détection,
      // pré-lecture, mode, clé) arrivent par processorOptions puis par message : chaque
      // AudioParam d'un worklet coûte à chaque bloc (≈ 0,1 ms par seconde de son).
      // Départ de lecture : compteur programmé au bloc du départ, l'état repart à neuf (comme l'export).
      { name: 'resetGen', defaultValue: 0, minValue: 0, maxValue: 1e9, automationRate: 'k-rate' }
    ];
  }
  constructor(options) {
    super();
    // Mêmes bornes et même précision (32 bits flottants) qu'un AudioParam.
    this.cfg = { knee: 12, attack: 0.003, release: 0.25, scHpFreq: 80, lookahead: 0, mode: 0, keyOn: 0, keyListen: 0 };
    const o = (options && options.processorOptions) || {};
    // Étage de sortie (couleur, anti-continu, compensation du mode) : voir tailStage().
    this.curve = o.curve ? Float32Array.from(o.curve) : null;
    this.trim = Math.fround(Number.isFinite(o.trim) ? o.trim : 1);
    this.dc = new Float64Array(8);
    this.setDcBlock(8);
    if (o.cfg) this.setCfg(o.cfg);
    this.port.onmessage = (e) => { const d = e.data || {}; if (d.cfg) this.setCfg(d.cfg);
      if (d.curve) this.curve = Float32Array.from(d.curve);
      if (Number.isFinite(d.trim)) this.trim = Math.fround(d.trim); };
    this.SIZE = 2048; this.MASK = 2047; // > 10 ms a 192 kHz
    this.bufL = new Float32Array(this.SIZE); this.bufR = new Float32Array(this.SIZE);
    this.w = 0;
    this.la = 0; this.laOld = 0; this.xf = 0;
    this.s = [0, 0, 0, 0, 0, 0, 0, 0];
    this.lastFc = -1;
    this.ms = 0; this.y1 = 0; this.yL = 0; this.charge = 0;
    this.msg = 0; this.grPeak = 0;
    this.gen = 0; this.fresh = true;
    // Veille (engine/effectSleep) : entrée muette depuis quietRun échantillons, cœur au repos.
    this.quietRun = 0; this.rest = false; this.lastFrame = -1;
    this.aQdnLog = Math.log(Math.exp(-1 / (2.5 * sampleRate)));
  }
  setCfg(c) {
    const B = { knee: [0, 40], attack: [0.00001, 1], release: [0.005, 5], scHpFreq: [10, 2000], lookahead: [0, 0.01], mode: [0, 3], keyOn: [0, 1], keyListen: [0, 1] };
    for (const k in B) {
      const v = +c[k];
      if (v === v && k in c) this.cfg[k] = Math.fround(Math.min(B[k][1], Math.max(B[k][0], v)));
    }
  }
  /**
   * Filtre anti-continu : passe-haut (fréquence en Hz, Q = 1 « dB » comme BiquadFilterNode),
   * coefficients calculés comme Chromium (third_party/blink/renderer/platform/audio/biquad.cc :
   * SetHighpassParams + SetNormalizedCoefficients), en double précision.
   */
  setDcBlock(hz) {
    const cutoff = Math.min(1, Math.max(0, Math.fround(hz) / (0.5 * sampleRate)));
    // pow10 de Chromium = fdlibm::expf (32 bits) de x·ln10.
    const resonance = Math.fround(Math.exp(Math.fround((Math.fround(1) / 20) * Math.LN10)));
    const theta = Math.PI * cutoff;
    const alpha = Math.sin(theta) / (2 * resonance);
    const cosw = Math.cos(theta);
    const beta = (1 + cosw) / 2;
    const a0inv = 1 / (1 + alpha);
    this.db0 = beta * a0inv; this.db1 = -2 * beta * a0inv; this.db2 = beta * a0inv;
    this.da1 = -2 * cosw * a0inv; this.da2 = (1 - alpha) * a0inv;
  }
  /**
   * Étage de sortie, à l'identique des nœuds natifs qu'il remplace (3 nœuds de moins par
   * compresseur) : WaveShaper sans suréchantillonnage (interpolation de Chromium, en 32 bits),
   * BiquadFilter passe-haut 8 Hz (état en double, sortie en 32 bits), Gain de compensation.
   */
  tailStage(buf, ch, n) {
    const c = this.curve;
    if (c && c.length) {
      const N = c.length, maxI = N - 1, S = Math.fround(0.5 * (N - 1)), top = Math.fround(N - 1);
      for (let i = 0; i < n; i++) {
        let v = Math.fround(Math.fround(buf[i] + 1) * S);
        if (v < 0) v = 0; else if (v > top) v = top;
        if (v !== v) v = 0;
        const i1 = v | 0;
        const i2 = i1 + 1 > maxI ? maxI : i1 + 1;
        const f = Math.fround(v - i1);
        const v1 = c[i1];
        buf[i] = Math.fround(Math.fround(f * Math.fround(c[i2] - v1)) + v1);
      }
    }
    const d = this.dc, o = ch * 4;
    const b0 = this.db0, b1 = this.db1, b2 = this.db2, a1 = this.da1, a2 = this.da2;
    let x1 = d[o], x2 = d[o + 1], y1 = d[o + 2], y2 = d[o + 3];
    const t = this.trim;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = Math.fround(b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2);
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      buf[i] = t === 1 ? y : y * t;
    }
    const F = 1.1754943508222875e-38;
    d[o] = (x1 < F && x1 > -F) ? 0 : x1; d[o + 1] = (x2 < F && x2 > -F) ? 0 : x2;
    d[o + 2] = (y1 < F && y1 > -F) ? 0 : y1; d[o + 3] = (y2 < F && y2 > -F) ? 0 : y2;
  }
  /**
   * Rattrapage après la veille (K échantillons sautés, entrée muette). Au repos, seuls le
   * détecteur (y1, yL, sous 1 dB : la charge ne fait que descendre) et la charge bougent.
   * Les 1,5 premières secondes sont recalculées échantillon par échantillon, exactement
   * comme la boucle principale (même ordre d'opérations, même remise à zéro de fin de
   * bloc) ; au-delà, formes fermées par bloc (écart de quelques ulp, très sous −200 dB).
   */
  catchUp(K) {
    const cfg = this.cfg, sr = sampleRate;
    const mode = Math.round(cfg.mode), qGain = mode === 2 ? 4 : mode === 1 ? 1 : 0;
    const aA = Math.exp(-1 / (Math.max(0.00001, cfg.attack) * sr));
    const aQdn = Math.exp(-1 / (2.5 * sr));
    let y1 = this.y1, yL = this.yL, q = this.charge;
    const blocks = Math.floor(K / 128);
    let b = 0;
    for (; b < blocks && (y1 !== 0 || yL !== 0); b++) {
      const tRel = Math.max(0.005, cfg.release) * (1 + qGain * q);
      const aR = Math.exp(-1 / (tRel * sr));
      if (b < 512) {
        for (let i = 0; i < 128; i++) {
          const r1 = aR * y1 + (1 - aR) * 0;
          y1 = 0 > r1 ? 0 : r1;
          yL = aA * yL + (1 - aA) * y1;
          q = yL > 1 ? Math.exp(-1 / sr) * q + (1 - Math.exp(-1 / sr)) : aQdn * q;
        }
      } else {
        const r128 = Math.pow(aR, 128), a128 = Math.pow(aA, 128);
        const yLn = a128 * yL + (aR !== aA ? (1 - aA) * aR * y1 * (r128 - a128) / (aR - aA) : (1 - aA) * 128 * r128 * y1);
        y1 = r128 * y1; yL = yLn; q = q * Math.pow(aQdn, 128);
      }
      if (y1 < 1e-9 && yL < 1e-9) { y1 = 0; yL = 0; }
    }
    if (b < blocks && q > 0) q *= Math.exp(this.aQdnLog * (blocks - b) * 128);
    this.y1 = y1; this.yL = yL; this.charge = q;
    this.w = (this.w + K) & this.MASK;
  }
  dcQuiet() { const d = this.dc; for (let i = 0; i < 8; i++) if (d[i] > 1e-12 || d[i] < -1e-12) return false; return true; }
  reset() {
    this.bufL.fill(0); this.bufR.fill(0); this.w = 0;
    this.xf = 0; this.s.fill(0); this.ms = 0; this.y1 = 0; this.yL = 0; this.charge = 0; this.grPeak = 0;
    this.fresh = true;
  }
  setHighpass(fc) {
    const w0 = 2 * Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(w0) / (2 * 0.7071);
    const c = Math.cos(w0), a0 = 1 + alpha;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - alpha) / a0;
    this.lastFc = fc;
  }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output[0]) return true;
    const n = output[0].length;
    const nIn = input ? input.length : 0;
    const inL = nIn > 0 ? input[0] : null;
    const inR = nIn > 1 ? input[1] : inL;
    const outL = output[0], outR = output.length > 1 ? output[1] : null;
    // Clé externe (side-chain) : la détection écoute l'entrée 2 ; le son traité reste l'entrée 1.
    const key = inputs[1];
    // Clé branchée mais muette (source à l'arrêt : entrée inactive, 0 canal) = silence,
    // pas le son de la piste : sans kick, la 808 n'est plus creusée.
    const cfg = this.cfg;
    const useKey = cfg.keyOn >= 0.5;
    if (useKey && (!this.zk || this.zk.length < n)) this.zk = new Float32Array(n);
    const kL = useKey ? (key && key[0] ? key[0] : this.zk) : null;
    const kR = useKey ? (key && key[1] ? key[1] : kL) : null;
    const listen = useKey && cfg.keyListen >= 0.5;
    // Bloc(s) sauté(s) : la chaîne dormait (veille). Les détecteurs et la « charge »
    // évoluent comme si les blocs muets avaient été calculés (voir catchUp).
    const fr = currentFrame;
    if (this.lastFrame >= 0 && fr > this.lastFrame + n) this.catchUp(fr - this.lastFrame - n);
    this.lastFrame = fr;
    if (p.resetGen && p.resetGen[0] !== this.gen) { this.gen = p.resetGen[0]; this.reset(); }
    if (cfg.scHpFreq !== this.lastFc) this.setHighpass(cfg.scHpFreq);
    const T = p.threshold[0];
    const R = Math.max(1, p.ratio[0]);
    const W = Math.max(0, cfg.knee);
    const k = 1 - 1 / R;
    const mode = Math.round(cfg.mode);
    const rms = mode === 1 || mode === 2;
    const aA = Math.exp(-1 / (Math.max(0.00001, cfg.attack) * sampleRate));
    // Release dependant du programme : la « charge » monte quand la reduction
    // dure (constante 1 s) et redescend lentement (2,5 s).
    const qGain = mode === 2 ? 4 : mode === 1 ? 1 : 0;
    const tRel = Math.max(0.005, cfg.release) * (1 + qGain * this.charge);
    const aR = Math.exp(-1 / (tRel * sampleRate));
    const aRms = Math.exp(-1 / ((mode === 2 ? 0.01 : 0.004) * sampleRate));
    const aQup = Math.exp(-1 / sampleRate), aQdn = Math.exp(-1 / (2.5 * sampleRate));
    const laT = Math.min(this.SIZE - 2, Math.max(0, Math.round(cfg.lookahead * sampleRate)));
    // Instance neuve / remise à zéro : pré-lecture posée d'emblée (pas de fondu depuis 0).
    if (this.fresh) { this.fresh = false; this.la = laT; this.laOld = laT; }
    if (laT !== this.la && this.xf <= 0) { this.laOld = this.la; this.la = laT; this.xf = 256; }
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    const s = this.s, M = this.MASK, bL = this.bufL, bR = this.bufR;
    let ms = this.ms, y1 = this.y1, yL = this.yL, q = this.charge, w = this.w, grPeak = this.grPeak;
    // Sous ce niveau (linéaire), le calculateur de gain rend exactement 0 : log10 inutile.
    // Marge relative de 1e-9 : la comparaison ne tranche que loin de la frontière, le reste
    // passe par le calcul exact (résultat identique au bit près).
    const lowDb = T - W / 2;
    const linPeak = Math.pow(10, lowDb / 20) * (1 - 1e-9);
    const linMs = Math.pow(10, (lowDb - 3.0103) / 10) * (1 - 1e-9);
    let peakIn = 0;
    for (let i = 0; i < n; i++) {
      const xl = inL ? inL[i] : 0, xr = inR ? inR[i] : 0;
      const ax = xl < 0 ? -xl : xl, ay = xr < 0 ? -xr : xr;
      if (ax > peakIn) peakIn = ax;
      if (ay > peakIn) peakIn = ay;
      // Signal de détection : la clé externe (side-chain) ou le son lui-même.
      const dl = kL ? kL[i] : xl, dr = kR ? kR[i] : xr;
      // Passe-haut de detection (n'affecte pas le son entendu)
      let hl = b0 * dl + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
      let hr = b0 * dr + b1 * s[4] + b2 * s[5] - a1 * s[6] - a2 * s[7];
      if (hl < 1e-15 && hl > -1e-15) hl = 0;
      if (hr < 1e-15 && hr > -1e-15) hr = 0;
      s[1] = s[0]; s[0] = dl; s[3] = s[2]; s[2] = hl;
      s[5] = s[4]; s[4] = dr; s[7] = s[6]; s[6] = hr;
      let lvl, below;
      if (rms) {
        ms = aRms * ms + (1 - aRms) * 0.5 * (hl * hl + hr * hr);
        if (ms < 1e-20) ms = 0;
        // +3 dB : un sinus est mesure a sa valeur crete, comme en mode crete
        below = ms + 1e-20 < linMs;
        lvl = below ? 0 : 10 * Math.log10(ms + 1e-20) + 3.0103;
      } else {
        const a = Math.max(hl < 0 ? -hl : hl, hr < 0 ? -hr : hr);
        below = a + 1e-10 < linPeak;
        lvl = below ? 0 : 20 * Math.log10(a + 1e-10);
      }
      // Calculateur de gain : genou doux quadratique (sous le genou : 0, sans calcul)
      let c = 0;
      if (!below) {
        const over = lvl - T;
        if (2 * over > W) c = k * over;
        else if (W > 0 && 2 * over > -W) { const u = over + W / 2; c = k * u * u / (2 * W); }
      }
      // Detecteur lisse decouple (sur la reduction, en dB)
      const r1 = aR * y1 + (1 - aR) * c;
      y1 = c > r1 ? c : r1;
      yL = aA * yL + (1 - aA) * y1;
      q = yL > 1 ? aQup * q + (1 - aQup) : aQdn * q;
      if (yL > grPeak) grPeak = yL;
      const g = yL === 0 ? 1 : Math.exp(-yL * 0.11512925464970229);
      bL[w] = xl; bR[w] = xr;
      let vl, vr;
      if (this.xf > 0) {
        const f = this.xf / 256;
        const iN = (w - this.la) & M, iO = (w - this.laOld) & M;
        vl = bL[iN] * (1 - f) + bL[iO] * f;
        vr = bR[iN] * (1 - f) + bR[iO] * f;
        this.xf--;
      } else {
        const iN = (w - this.la) & M;
        vl = bL[iN]; vr = bR[iN];
      }
      if (listen) { outL[i] = dl; if (outR) outR[i] = dr; }
      else { outL[i] = vl * g; if (outR) outR[i] = vr * g; }
      w = (w + 1) & M;
    }
    this.tailStage(outL, 0, n);
    if (outR) this.tailStage(outR, 1, n);
    // Veille : entrée muette (−240 dBFS) assez longtemps pour vider la pré-lecture ; détecteurs
    // résiduels (< 1e-9 dB de réduction, sans effet audible : gain 1 − 1e-10) remis à zéro.
    this.quietRun = peakIn <= 1e-12 ? this.quietRun + n : 0;
    if (this.quietRun >= this.SIZE && y1 < 1e-9 && yL < 1e-9) { y1 = 0; yL = 0; }
    this.ms = ms; this.y1 = y1; this.yL = yL; this.charge = q; this.w = w; this.grPeak = grPeak;
    // Au repos : détecteur sous 1 dB (il ne fait plus que retomber, rattrapé par catchUp).
    const rest = this.quietRun >= this.SIZE && this.xf <= 0 && y1 <= 1 && yL <= 1 && ms === 0 && !useKey
      && s[2] === 0 && s[3] === 0 && s[6] === 0 && s[7] === 0 && this.dcQuiet();
    if (rest !== this.rest) { this.rest = rest; this.port.postMessage({ rest }); }
    if (++this.msg >= 8) {
      this.msg = 0;
      this.port.postMessage({ gr: -yL, peak: -grPeak });
      this.grPeak = 0;
    }
    return true;
  }
}
try { registerProcessor('vocal-compressor-processor-r', VocalCompressorProcessor); } catch (e) {}
`;

const MODE_INDEX: Record<CompressorParams['mode'], number> = { CLEAN: 0, VCA: 1, OPTO: 2, FET: 3 };

export class CompressorNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  // Etage de compression : AudioWorklet (sans latence). Si le worklet ne peut
  // pas se charger, repli sur DynamicsCompressorNode (ancien comportement).
  private worklet: AudioWorkletNode | null = null;
  /** Compresseur retiré : un worklet encore en chargement n'est pas créé (sinon il restait vivant). */
  private disposed = false;
  private compressor: DynamicsCompressorNode | null = null;
  private compIn: GainNode;
  private makeupGainNode: GainNode;

  // Parallel mix
  private dryGain: GainNode;
  private wetGain: GainNode;

  // Character/saturation
  private saturationNode: WaveShaperNode;
  private dcBlock: BiquadFilterNode;
  private modeTrim: GainNode;

  // Retard du sec = latence de la voie compressee (0 sauf pre-lecture), pour
  // que le mix parallele ne filtre pas la voix en peigne.
  private dryDelay: DelayNode;

  // Metering
  private inputAnalyzer: AnalyserNode;
  private outputAnalyzer: AnalyserNode;
  private inputData: Float32Array;
  private outputData: Float32Array;
  private reduction = 0;

  /** Pret quand le worklet est charge (le rendu hors ligne attend cette promesse). */
  public readonly ready: Promise<void>;

  /**
   * Entrée de la clé externe (side-chain, R7) : le moteur y branche la piste
   * ou le bus choisi, filtré et recalé (PDC). Muette tant qu'aucune clé n'est choisie.
   */
  public readonly sidechainInput: GainNode;
  private keyActive = false;

  /** Réglages automatisables (R8) : seuil, ratio, mix, gain de compensation. */
  private auto = new AutomationSet();

  private params: CompressorParams = {
    threshold: -18,
    ratio: 4,
    knee: 12,
    attack: 0.003,
    release: 0.25,
    makeupGain: 1.0,
    mix: 1.0,
    scHpFreq: 80,
    lookahead: 0,
    autoMakeup: false,
    mode: 'CLEAN',
    isEnabled: true,
    lowLatency: false
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    // I/O
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    // Muet jusqu'a ce que l'etage de compression soit en place (quelques ms),
    // puis montee de 20 ms : ni clic ni bouffee non compressee a l'insertion.
    this.output.gain.value = 0;

    // Metering
    this.inputAnalyzer = ctx.createAnalyser();
    this.inputAnalyzer.fftSize = 256;
    this.inputData = new Float32Array(this.inputAnalyzer.frequencyBinCount);

    this.outputAnalyzer = ctx.createAnalyser();
    this.outputAnalyzer.fftSize = 256;
    this.outputData = new Float32Array(this.outputAnalyzer.frequencyBinCount);

    this.compIn = ctx.createGain();
    this.makeupGainNode = ctx.createGain();

    // Saturation for character modes (sans surechantillonnage : il ajoute
    // une latence, et les courbes douces aliasent tres peu)
    this.saturationNode = ctx.createWaveShaper();
    this.saturationNode.oversample = 'none';
    this.updateSaturationCurve('CLEAN');
    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 8;
    this.modeTrim = ctx.createGain();
    this.dryDelay = ctx.createDelay(0.05);
    this.dryDelay.delayTime.value = 0;

    // Parallel compression mix
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0; // Full wet by default
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 1;

    this.sidechainInput = ctx.createGain();
    this.sidechainInput.channelCount = 2;
    this.sidechainInput.channelCountMode = 'explicit';
    this.sidechainInput.channelInterpretation = 'speakers';

    // Mix et gain de compensation : automatisables (lois affines : sec = 1 − mix).
    this.auto.add('mix', new MappedParam(ctx, [{ param: this.wetGain.gain }, { param: this.dryGain.gain, map: v => 1 - v }], { min: 0, max: 1, value: 1, affine: true }));
    this.auto.add('makeupGain', new MappedParam(ctx, [{ param: this.makeupGainNode.gain }], { min: 0, max: 16, value: 1, affine: true }));

    // Vumètres d'entrée / sortie : branchés seulement quand la fenêtre les lit (voir taps()).

    // Dry path (for parallel compression), aligne sur la voie compressee
    this.input.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);

    // Wet path : entree -> [compression] -> couleur -> compensation
    // Étage de couleur natif (WaveShaper -> passe-haut -> compensation) : seulement pour le
    // repli DynamicsCompressor ; le worklet le calcule lui-même (voir tailStage).
    this.saturationNode.connect(this.dcBlock);
    this.dcBlock.connect(this.modeTrim);
    this.makeupGainNode.connect(this.wetGain);

    // Merge dry + wet
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);


    this.applyParams();
    this.ready = this.initWorklet();
  }

  private async initWorklet() {
    try {
      await loadWorkletModule(this.ctx, 'vocal-compressor-r', COMP_WORKLET_CODE);
      if (this.disposed) return;
      this.worklet = new AudioWorkletNode(this.ctx, 'vocal-compressor-processor-r', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        // Réglages fixes posés à la création : un message arriverait trop tard à l'export.
        processorOptions: { cfg: this.workletCfg(), curve: Array.from(this.curveData), trim: this.trimTarget() },
      });
      this.cfgKey = JSON.stringify(this.workletCfg());
      this.sidechainInput.connect(this.worklet, 0, 1);
      const wp = this.worklet.parameters;
      this.auto.add('threshold', new MappedParam(this.ctx, [{ param: wp.get('threshold')! }], { min: -60, max: 0, value: -18, affine: true }));
      this.auto.add('ratio', new MappedParam(this.ctx, [{ param: wp.get('ratio')! }], { min: 1, max: 20, value: 4, affine: true }));
      this.worklet.port.onmessage = (e) => {
        const d = e.data || {};
        if (Number.isFinite(d.peak)) this.reduction = d.peak;
        if (typeof d.rest === 'boolean') this.atRest = d.rest;
      };
      this.input.connect(this.worklet);
      this.worklet.connect(this.makeupGainNode);
    } catch (e) {
      console.warn('[Compressor] Worklet indisponible, repli sur DynamicsCompressorNode :', e);
      this.compressor = this.ctx.createDynamicsCompressor();
      this.input.connect(this.compressor);
      this.compressor.connect(this.saturationNode);
      this.modeTrim.connect(this.makeupGainNode);
      this.auto.add('threshold', new MappedParam(this.ctx, [{ param: this.compressor.threshold }], { min: -60, max: 0, value: -18, affine: true }));
      this.auto.add('ratio', new MappedParam(this.ctx, [{ param: this.compressor.ratio }], { min: 1, max: 20, value: 4, affine: true }));
    }
    this.applyParams(true, true);
    // Fondu d'apparition en direct seulement : à l'export, le rendu démarre sur le son.
    fadeInOnInsert(this.output.gain, this.ctx);
  }

  /** Cœur au repos (entrée muette, détecteurs à zéro) : la chaîne peut dormir (engine/effectSleep). */
  private atRest = false;
  public isAtRest(): boolean { return !!this.worklet && !this.compressor && !this.keyActive && this.atRest; }
  /**
   * Vumètres (prises d'analyse) : une prise branchée est calculée à chaque bloc et tire la
   * chaîne même en veille. Branchés à la première lecture par la fenêtre, débranchés 3 s
   * après la dernière, et toujours pendant la veille.
   */
  private sleeping = false;
  private tapsOn = false;
  private tapsReadAt = 0;
  private tapsTimer: ReturnType<typeof setInterval> | null = null;
  private setTaps(on: boolean) {
    if (on === this.tapsOn) return;
    this.tapsOn = on;
    try {
      if (on) { this.input.connect(this.inputAnalyzer); this.output.connect(this.outputAnalyzer); }
      else { this.input.disconnect(this.inputAnalyzer); this.output.disconnect(this.outputAnalyzer); }
    } catch { /* déjà dans cet état */ }
  }
  private readTaps() {
    this.tapsReadAt = Date.now();
    if (this.sleeping || this.disposed) return;
    this.setTaps(true);
    if (!this.tapsTimer) this.tapsTimer = setInterval(() => {
      if (Date.now() - this.tapsReadAt > 3000 || this.disposed) {
        this.setTaps(false);
        if (this.tapsTimer) { clearInterval(this.tapsTimer); this.tapsTimer = null; }
      }
    }, 1000);
  }
  public setSleeping(on: boolean) {
    if (on === this.sleeping) return;
    this.sleeping = on;
    if (on) this.setTaps(false);
    else if (Date.now() - this.tapsReadAt < 3000) this.setTaps(true);
  }

  private resetCount = 0;
  /** Départ de la lecture à `at` (début d'un bloc) : détecteur, pré-lecture et charge repartent à neuf. */
  public resetAt(at: number) {
    const ap = this.worklet?.parameters.get('resetGen');
    if (!ap) return;
    try { ap.setValueAtTime(++this.resetCount, Math.max(this.ctx.currentTime, at - 0.5 / this.ctx.sampleRate)); } catch { /* */ }
  }

  /** Retard ajoute par le plugin, en secondes (0 sauf pre-lecture choisie). */
  public get latency(): number {
    return this.effectiveLookahead() + (this.compressor ? 0.006 : 0);
  }

  private effectiveLookahead(): number {
    if (this.params.lowLatency || !this.params.isEnabled) return 0;
    const l = Number(this.params.lookahead);
    return Number.isFinite(l) ? Math.max(0, Math.min(0.01, l)) : 0;
  }

  /**
   * Couleur harmonique par mode. Toutes les courbes ont une pente 1 a
   * l'origine : un signal faible garde son niveau. Avant, OPTO amplifiait
   * x2,7 (+8,6 dB) et FET x1,7 : changer de mode changeait surtout le volume,
   * avec une distorsion forte des signaux faibles en OPTO.
   */
  private updateSaturationCurve(mode: 'CLEAN' | 'VCA' | 'OPTO' | 'FET') {
    let fn: (x: number) => number;
    switch (mode) {
      case 'VCA':
        // Legere compression des cretes (harmoniques impaires discretes)
        fn = x => Math.tanh(1.4 * x) / 1.4;
        break;
      case 'OPTO': {
        // Asymetrique douce : harmoniques paires, son « chaud »
        const k = 1.2, b = 0.1;
        const t0 = Math.tanh(k * b), slope = k * (1 - t0 * t0);
        fn = x => (Math.tanh(k * (x + b)) - t0) / slope;
        break;
      }
      case 'FET':
        // Plus mordant : arrondit franchement les cretes
        fn = x => Math.tanh(1.8 * x) / 1.8;
        break;
      default:
        fn = x => x;
    }
    this.curveData = makeCurve(8193, fn);
    this.saturationNode.curve = this.curveData;
    this.worklet?.port.postMessage({ curve: this.curveData });
  }
  private curveData: Float32Array = makeCurve(8193, x => x);
  /** Compensation de niveau du mode (1 en écoute de la clé). */
  private trimTarget(): number {
    const listen = this.keyActive && Number(this.params.keyListen) >= 0.5;
    return listen || !this.params.isEnabled ? 1 : this.modeDynamics().trim;
  }

  /**
   * Caractere dynamique de chaque mode, applique aux reglages utilisateur :
   * OPTO lent et doux, FET rapide et dur, VCA tel quel, CLEAN neutre.
   * trimDb compense la perte de crete due a la saturation du mode (mesure :
   * sur une voix compressee, le mode change la couleur, pas le niveau).
   */
  private modeDynamics() {
    const safe = (val: number, def: number) => Number.isFinite(val) ? val : def;
    let attack = Math.max(0.0001, safe(this.params.attack, 0.003));
    let release = Math.max(0.01, safe(this.params.release, 0.25));
    let knee = Math.max(0, Math.min(40, safe(this.params.knee, 12)));
    let trimDb = 0;
    switch (this.params.mode) {
      case 'VCA':
        trimDb = 0.3;
        break;
      case 'OPTO':
        attack = Math.max(0.01, attack * 1.5);
        release = Math.max(0.06, release);
        knee = Math.max(knee, 10);
        trimDb = 0.3;
        break;
      case 'FET':
        attack = Math.max(0.0002, attack * 0.5);
        release = Math.max(0.03, release * 0.75);
        knee = Math.min(knee, 4);
        trimDb = 0.6;
        break;
    }
    return { attack: Math.min(1, attack), release: Math.min(1, release), knee, trim: Math.pow(10, trimDb / 20) };
  }

  private calculateAutoMakeup(): number {
    const { threshold, ratio } = this.params;
    const reductionAtThreshold = Math.abs(threshold) * (1 - 1/ratio);
    return Math.pow(10, reductionAtThreshold / 40);
  }

  public updateParams(p: Partial<CompressorParams>) {
    const oldMode = this.params.mode;
    this.params = { ...this.params, ...p };

    if (this.params.mode !== oldMode) {
      this.updateSaturationCurve(this.params.mode);
    }

    this.applyParams();
  }

  private lastTrim = NaN;
  private postTrim(t: number) {
    if (!this.worklet || t === this.lastTrim) return;
    this.lastTrim = t;
    this.worklet.port.postMessage({ trim: t });
  }

  /** Réglages fixes du cœur (worklet), dans les bornes de ses anciens AudioParams. */
  private cfgKey = '';
  private workletCfg() {
    const safe = (val: number, def: number) => Number.isFinite(val) ? val : def;
    const dyn = this.modeDynamics();
    const listen = this.keyActive && safe(Number(this.params.keyListen), 0) >= 0.5;
    return { knee: dyn.knee, attack: dyn.attack, release: dyn.release, scHpFreq: Math.max(10, Math.min(2000, safe(this.params.scHpFreq, 80))),
      lookahead: this.effectiveLookahead(), mode: MODE_INDEX[this.params.mode] ?? 0, keyOn: this.keyActive ? 1 : 0, keyListen: listen ? 1 : 0 };
  }

  /**
   * Voies câblées seulement si elles comptent (chaque nœud câblé est calculé à chaque bloc) :
   *  - voie sèche (retard + gain) : mix < 1 ou mix automatisé ; à mix = 1 elle n'ajoute que des zéros.
   * (La courbe du mode CLEAN reste câblée : son interpolation n'est pas l'identité au bit près,
   * 2,3 LSB16 mesurés sans elle.)
   */
  private dryWired = true;
  private dryTimer: ReturnType<typeof setTimeout> | null = null;
  private mixAutomated = false;
  private syncPaths(look: number) {
    if (!this.worklet) return;
    const mix = Number(this.params.mix);
    const wantDry = this.mixAutomated || !this.params.isEnabled || !(Number.isFinite(mix) && mix >= 1) || look > 0;
    if (wantDry && !this.dryWired) {
      if (this.dryTimer) { clearTimeout(this.dryTimer); this.dryTimer = null; }
      try { this.input.connect(this.dryDelay); } catch { /* */ }
      this.dryWired = true;
    } else if (!wantDry && this.dryWired) {
      // En direct, la voie sèche n'est retirée qu'une fois son gain arrivé à 0 (fin du glissement).
      const cut = () => { this.dryTimer = null; if (this.dryWired && !this.disposed && this.params.mix >= 1 && !this.mixAutomated) { try { this.input.disconnect(this.dryDelay); } catch { /* */ } this.dryWired = false; } };
      if (isOfflineContext(this.ctx) || this.ctx.currentTime <= 0) cut();
      else if (!this.dryTimer) this.dryTimer = setTimeout(cut, 250);
    }
  }

  /** immediate : valeurs posees sans lissage (mise en place du worklet) ; force : réglages fixes reposés même inchangés. */
  private stateKey = '';
  private applyParams(immediate = false, force = false) {
    const now = this.ctx.currentTime;
    // Export (contexte hors ligne) : réglages posés tels quels, sans glissement depuis les valeurs par défaut.
    if (isOfflineContext(this.ctx)) immediate = true;
    const safe = (val: number, def: number) => Number.isFinite(val) ? val : def;
    const set = (prm: AudioParam | undefined, v: number, tau = 0.01) => {
      if (!prm || !Number.isFinite(v)) return;
      if (immediate) { prm.cancelScheduledValues(now); prm.setValueAtTime(v, now); }
      else prm.setTargetAtTime(v, now, tau);
    };
    const dyn = this.modeDynamics();
    const threshold = Math.max(-100, Math.min(0, safe(this.params.threshold, -18)));
    const ratio = Math.max(1, Math.min(20, safe(this.params.ratio, 4)));
    const look = this.effectiveLookahead();
    const listen = this.keyActive && safe(Number(this.params.keyListen), 0) >= 0.5;
    // Bascule actif / bypass / écoute de la clé : les réglages fixes sont reposés.
    const key = `${this.params.isEnabled ? 1 : 0}|${listen ? 1 : 0}`;
    if (key !== this.stateKey) { this.stateKey = key; force = true; }
    const st = { force, immediate };

    // Seuil et ratio automatisables (R8) : posés seulement s'ils ont changé.
    this.auto.get('threshold')?.setStatic(this.compressor && !this.params.isEnabled ? 0 : threshold, st);
    this.auto.get('ratio')?.setStatic(this.compressor && !this.params.isEnabled ? 1 : ratio, st);
    if (this.worklet) {
      // Réglages fixes du cœur : par message, seulement s'ils ont changé (le worklet fait
      // lui-même un fondu quand la pré-lecture change).
      const cfg = this.workletCfg();
      const ck = JSON.stringify(cfg);
      if (ck !== this.cfgKey || force) { this.cfgKey = ck; this.worklet.port.postMessage({ cfg }); }
      set(this.dryDelay.delayTime, look, 0.005);
      this.syncPaths(look);
    } else if (this.compressor) {
      set(this.compressor.knee, dyn.knee);
      set(this.compressor.attack, dyn.attack);
      set(this.compressor.release, dyn.release);
      this.dryDelay.delayTime.setTargetAtTime(Math.floor(0.006 * this.ctx.sampleRate) / this.ctx.sampleRate, now, 0.01);
    }

    const mix = this.auto.get('mix')!, makeup = this.auto.get('makeupGain')!;
    if (listen) {
      // Écoute de la clé : on n'entend que la clé (ni sec, ni gain de compensation).
      set(this.modeTrim.gain, 1);
      this.postTrim(1);
      makeup.setStatic(1, { force: true, immediate });
      mix.setStatic(1, { force: true, immediate });
    } else if (this.params.isEnabled) {
      set(this.modeTrim.gain, dyn.trim);
      this.postTrim(dyn.trim);
      const mk = this.params.autoMakeup
        ? this.calculateAutoMakeup()
        : safe(this.params.makeupGain, 1.0);
      makeup.setStatic(Math.max(0, mk), st);
      mix.setStatic(Math.max(0, Math.min(1, safe(this.params.mix, 1))), st);
    } else {
      makeup.setStatic(1, st);
      mix.setStatic(0, st);
    }
  }

  /** AudioParam d'un réglage automatisable (R8) : seuil, ratio, mix, gain de compensation ; sinon null. */
  public automationParam(key: string): MappedParam | null {
    // Mix automatisé : la voie sèche reste câblée (la courbe peut quitter 1).
    if (key === 'mix' && !this.mixAutomated) { this.mixAutomated = true; this.syncPaths(this.effectiveLookahead()); }
    return this.auto.get(key);
  }

  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  /** Clé externe branchée (R7) : la détection écoute `sidechainInput`. */
  public setSidechainActive(on: boolean) {
    if (on === this.keyActive) return;
    this.keyActive = on;
    this.applyParams();
  }
  public get sidechainActive() { return this.keyActive; }

  /** Reduction de gain la plus forte depuis la derniere lecture (dB, <= 0). */
  public getReduction(): number {
    if (this.compressor) return this.compressor.reduction;
    return this.reduction;
  }

  public getInputLevel(): number {
    this.readTaps();
    this.inputAnalyzer.getFloatTimeDomainData(this.inputData as any);
    let max = 0;
    for (let i = 0; i < this.inputData.length; i++) {
      const abs = Math.abs(this.inputData[i]);
      if (abs > max) max = abs;
    }
    return max > 0 ? 20 * Math.log10(max) : -100;
  }

  public getOutputLevel(): number {
    this.readTaps();
    this.outputAnalyzer.getFloatTimeDomainData(this.outputData as any);
    let max = 0;
    for (let i = 0; i < this.outputData.length; i++) {
      const abs = Math.abs(this.outputData[i]);
      if (abs > max) max = abs;
    }
    return max > 0 ? 20 * Math.log10(max) : -100;
  }

  public getAudioParam(paramId: string): AudioParam | null {
    const wp = this.worklet?.parameters;
    switch(paramId) {
      case 'threshold': return wp?.get('threshold') ?? this.compressor?.threshold ?? null;
      case 'ratio': return wp?.get('ratio') ?? this.compressor?.ratio ?? null;
      case 'knee': return wp?.get('knee') ?? this.compressor?.knee ?? null;
      case 'attack': return wp?.get('attack') ?? this.compressor?.attack ?? null;
      case 'release': return wp?.get('release') ?? this.compressor?.release ?? null;
      case 'makeupGain': return this.makeupGainNode.gain;
      case 'mix': return this.wetGain.gain;
      case 'scHpFreq': return wp?.get('scHpFreq') ?? null;
      default: return null;
    }
  }

  public getParams() { return { ...this.params }; }

  public dispose() {
    this.disposed = true;
    if (this.tapsTimer) { clearInterval(this.tapsTimer); this.tapsTimer = null; }
    if (this.dryTimer) { clearTimeout(this.dryTimer); this.dryTimer = null; }
    try { this.input.disconnect(); } catch (e) {}
    // Clé de side-chain (R7) : plus rien n'entre dans le worklet retiré.
    try { this.sidechainInput.disconnect(); } catch (e) {}
    if (this.worklet) {
      retireWorkletNode(this.worklet);
      this.worklet = null;
    }
  }
}

const COMPRESSOR_PRESETS: Record<string, Partial<CompressorParams>> = {
  'Vocal Smooth': {
    threshold: -20,
    ratio: 3,
    knee: 20,
    attack: 0.015,
    release: 0.2,
    mix: 1.0,
    scHpFreq: 100,
    lookahead: 0, // voix : aucune latence (la pre-lecture retarde le retour casque)
    mode: 'OPTO'
  },
  'Vocal Aggressive': {
    threshold: -15,
    ratio: 6,
    knee: 6,
    attack: 0.002,
    release: 0.1,
    mix: 1.0,
    scHpFreq: 150,
    lookahead: 0,
    mode: 'FET'
  },
  'Mix Bus Glue': {
    threshold: -16,
    ratio: 2,
    knee: 30,
    attack: 0.03,
    release: 0.3,
    mix: 0.5,
    scHpFreq: 80,
    lookahead: 0,
    mode: 'VCA'
  },
  'Parallel Punch': {
    threshold: -30,
    ratio: 8,
    knee: 0,
    attack: 0.001,
    release: 0.15,
    mix: 0.3,
    scHpFreq: 60,
    lookahead: 0,
    mode: 'FET'
  },
  'Transparent Limiter': {
    threshold: -6,
    ratio: 20,
    knee: 0,
    attack: 0.0005,
    release: 0.05,
    mix: 1.0,
    scHpFreq: 20,
    lookahead: 0.005,
    mode: 'CLEAN'
  }
};

interface VocalCompressorUIProps {
  node: CompressorNode;
  initialParams: CompressorParams;
  onParamsChange?: (p: CompressorParams) => void;
}

/** Réglages par défaut de la fenêtre (mêmes valeurs de repli que le moteur). */
const UI_DEFAULTS: CompressorParams = {
  threshold: -18, ratio: 4, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1, mix: 1,
  scHpFreq: 80, lookahead: 0, autoMakeup: false, mode: 'CLEAN', isEnabled: true,
};

/**
 * Réglages incomplets (projet ancien ou réparé, effet ajouté par Nova) : chaque
 * valeur manquante prend sa valeur par défaut. Avant, la fenêtre plantait
 * (« Cannot read properties of undefined (reading 'toFixed') ») — trouvé par
 * les pannes injectées (qa/pannes_injectees.py, 08/10/2026).
 */
export const withCompressorDefaults = (p: Partial<CompressorParams> | null | undefined): CompressorParams => {
  const out: any = { ...UI_DEFAULTS };
  for (const [k, v] of Object.entries(p || {})) {
    const d = (UI_DEFAULTS as any)[k];
    if (v === undefined || v === null) continue;
    if (typeof d === 'number' && !(typeof v === 'number' && Number.isFinite(v))) continue;
    out[k] = v;
  }
  return out as CompressorParams;
};

export const VocalCompressorUI: React.FC<VocalCompressorUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<CompressorParams>(() => withCompressorDefaults(initialParams));
  const [reduction, setReduction] = useState(0);
  const [inputLevel, setInputLevel] = useState(-100);
  const [outputLevel, setOutputLevel] = useState(-100);
  const [inputPeak, setInputPeak] = useState(-100);
  const [outputPeak, setOutputPeak] = useState(-100);
  
  const curveCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const drawCurve = useCallback(() => {
    const canvas = curveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const { threshold, ratio, knee } = params;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for(let i = 0; i <= 6; i++) {
      const x = (i / 6) * w;
      const y = (i / 6) * h;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    
    // 1:1 reference line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Threshold line
    const threshX = ((threshold + 60) / 60) * w;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.3)';
    ctx.moveTo(threshX, 0);
    ctx.lineTo(threshX, h);
    ctx.stroke();

    // Transfer curve
    ctx.beginPath();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#f9731666';

    for(let i = 0; i <= w; i++) {
      const inputDb = (i / w) * 60 - 60;
      let outputDb = inputDb;

      if (inputDb > threshold + knee / 2) {
        outputDb = threshold + (inputDb - threshold) / ratio;
      } else if (inputDb > threshold - knee / 2) {
        const t = (inputDb - (threshold - knee / 2)) / knee;
        outputDb = inputDb + (1 / ratio - 1) * knee * t * t / 2;
      }

      const x = i;
      const y = h - ((outputDb + 60) / 60) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [params]);

  // Metering animation loop
  useEffect(() => {
    let animFrame = 0;
    let peakHoldIn = -100;
    let peakHoldOut = -100;
    let peakDecay = 0;
    
    const update = () => {
      const red = node.getReduction();
      const inLvl = node.getInputLevel();
      const outLvl = node.getOutputLevel();
      
      setReduction(red);
      setInputLevel(inLvl);
      setOutputLevel(outLvl);
      
      // Peak hold with decay
      if (inLvl > peakHoldIn) peakHoldIn = inLvl;
      if (outLvl > peakHoldOut) peakHoldOut = outLvl;
      
      peakDecay++;
      if (peakDecay > 60) { // ~1 second at 60fps
        peakHoldIn = Math.max(peakHoldIn - 1, inLvl);
        peakHoldOut = Math.max(peakHoldOut - 1, outLvl);
        peakDecay = 0;
      }
      
      setInputPeak(peakHoldIn);
      setOutputPeak(peakHoldOut);
      
      drawCurve();
      animFrame = requestAnimationFrame(update);
    };
    
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [node, drawCurve]);
      

  const updateParam = (key: keyof CompressorParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const applyPreset = (presetName: string) => {
    const preset = COMPRESSOR_PRESETS[presetName];
    if (preset) {
      const newParams = { ...params, ...preset };
      setParams(newParams);
      node.updateParams(preset);
      if (onParamsChange) onParamsChange(newParams);
    }
  };

  const togglePower = () => {
    updateParam('isEnabled', !params.isEnabled);
  };

  // Meter bar component
  const MeterBar: React.FC<{ level: number; peak: number; label: string }> = ({ level, peak, label }) => {
    const levelPercent = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
    const peakPercent = Math.max(0, Math.min(100, ((peak + 60) / 60) * 100));
    
    return (
      <div className="flex flex-col items-center">
        <span className="text-[6px] font-black text-slate-600 uppercase mb-1">{label}</span>
        <div className="w-4 h-28 bg-black/60 rounded relative overflow-hidden border border-white/5">
          <div 
            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-green-500 via-yellow-500 to-red-500 transition-all duration-75"
            style={{ height: `${levelPercent}%` }}
          />
          <div 
            className="absolute left-0 right-0 h-0.5 bg-white transition-all duration-100"
            style={{ bottom: `${peakPercent}%` }}
          />
        </div>
        <span className="text-[7px] font-mono text-slate-400 mt-1">{Math.round(level)}</span>
      </div>
    );
  };

  // GR Meter
  const GRMeter: React.FC<{ reduction: number }> = ({ reduction }) => {
    const redDb = Math.abs(reduction);
    const meterPercent = Math.min(100, (redDb / 24) * 100);
    
    return (
      <div className="flex flex-col items-center" title="Réduction de gain : de combien (dB) le compresseur baisse la voix en ce moment">
        <span className="text-[6px] font-black text-slate-600 uppercase mb-1">Réd.</span>
        <div className="w-4 h-28 bg-black/60 rounded relative overflow-hidden border border-white/5">
          <div 
            className="absolute top-0 left-0 right-0 bg-orange-500 transition-all duration-75"
            style={{ height: `${meterPercent}%` }}
          />
        </div>
        <span className="text-[7px] font-mono text-orange-500 mt-1">{Math.round(redDb)}</span>
      </div>
    );
  };

  return (
    <div className="w-[580px] bg-nv-bg border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-2xl bg-orange-500/10 flex items-center justify-center text-orange-500 border border-orange-500/20">
            <i className="fas fa-compress-alt text-xl"></i>
          </div>
          <div>
            <h2 className="text-lg font-black text-white tracking-tight">
              Compresseur
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Rend le volume de la voix plus régulier pour qu'elle reste devant le beat.
            </p>
          </div>
        </div>
        <button data-plugin-power 
          onClick={togglePower}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all border ${params.isEnabled 
            ? 'bg-orange-500 border-orange-400 text-black shadow-lg shadow-orange-500/40' 
            : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
        >
          <i className="fas fa-power-off text-sm"></i>
        </button>
      </div>

      {/* Presets */}
      <div className="flex space-x-2">
        {Object.keys(COMPRESSOR_PRESETS).map(name => (
          <button
            key={name}
            onClick={() => applyPreset(name)}
            className="px-3 py-1.5 bg-white/5 hover:bg-orange-500/20 border border-white/10 hover:border-orange-500/50 rounded-lg text-[8px] font-black text-slate-400 hover:text-orange-400 uppercase tracking-wider transition-all"
          >
            {PRESET_LABELS[name] || name}
          </button>
        ))}
      </div>

      {/* Main display: curve + meters */}
      <div className="flex space-x-4">
        {/* Transfer curve */}
        <div className="flex-1 bg-black/60 rounded-[24px] border border-white/5 relative overflow-hidden h-40">
          <canvas ref={curveCanvasRef} width={400} height={160} className="w-full h-full opacity-90" />
          <div className="absolute top-3 left-4 text-[7px] font-black text-slate-600 uppercase tracking-widest">
            Courbe de compression
          </div>
          {/* Mode indicator */}
          <div className="absolute bottom-3 right-4 text-[8px] font-black text-orange-500 uppercase">
            {params.mode}
          </div>
        </div>
        
        {/* Meters */}
        <div className="flex space-x-2 bg-black/40 rounded-[24px] border border-white/5 p-3">
          <MeterBar level={inputLevel} peak={inputPeak} label="Entrée" />
          <GRMeter reduction={reduction} />
          <MeterBar level={outputLevel} peak={outputPeak} label="Sortie" />
        </div>
      </div>

      {/* Mode selector */}
      <div className="flex items-center space-x-4">
        <span className="text-[9px] font-bold text-slate-400">Caractère</span>
        <div className="flex space-x-1">
          {(['CLEAN', 'VCA', 'OPTO', 'FET'] as const).map(mode => (
            <button
              key={mode}
              title={MODE_HELP[mode]}
              onClick={() => updateParam('mode', mode)}
              className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all border ${
                params.mode === mode 
                  ? 'bg-orange-500 border-orange-400 text-black' 
                  : 'bg-white/5 border-white/10 text-slate-500 hover:text-white hover:border-white/20'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Main controls */}
      <div className="grid grid-cols-6 gap-4">
        <CompressorKnob label="Seuil" defaultValue={-18} value={params.threshold} min={-60} max={0} suffix="dB" color="#f97316" onChange={(v) => updateParam('threshold', v)} displayVal={Math.round(params.threshold)} />
        <CompressorKnob label="Ratio" defaultValue={4} value={params.ratio} min={1} max={20} suffix=":1" color="#f97316" onChange={(v) => updateParam('ratio', v)} displayVal={numFr(params.ratio)} />
        <CompressorKnob label="Genou" defaultValue={12} value={params.knee} min={0} max={40} suffix="dB" color="#f97316" onChange={(v) => updateParam('knee', v)} displayVal={Math.round(params.knee)} />
        <CompressorKnob label="Attaque" defaultValue={0.003} value={params.attack} min={0.0001} max={0.1} factor={1000} suffix="ms" color="#fff" onChange={(v) => updateParam('attack', v)} displayVal={numFr(params.attack * 1000)} />
        <CompressorKnob label="Relâche" defaultValue={0.25} value={params.release} min={0.01} max={1.0} factor={1000} suffix="ms" color="#fff" onChange={(v) => updateParam('release', v)} displayVal={Math.round(params.release * 1000)} />
        <CompressorKnob label="Gain de sortie" defaultValue={1.6} value={params.makeupGain} min={0.25} max={4} factor={1} suffix="" color="#fff" onChange={(v) => updateParam('makeupGain', v)} displayVal={params.autoMakeup ? 'auto' : gainDbFr(params.makeupGain)} disabled={params.autoMakeup} />
      </div>

      {/* Advanced controls */}
      <div className="grid grid-cols-4 gap-4 pt-2 border-t border-white/5">
        <CompressorKnob label="Mélange" defaultValue={1} value={params.mix} min={0} max={1} factor={100} suffix="%" color="#06b6d4" onChange={(v) => updateParam('mix', v)} displayVal={Math.round(params.mix * 100)} />
        <CompressorKnob label="Anticipation" value={params.lookahead} min={0} max={0.005} factor={1000} suffix="ms" color="#06b6d4" onChange={(v) => updateParam('lookahead', v)} displayVal={numFr(params.lookahead * 1000)} />
        
        {/* Auto Makeup toggle */}
        <div className="flex flex-col items-center justify-center space-y-2">
          <span className="text-[9px] font-bold text-slate-400">Gain auto</span>
          <button
            onClick={() => updateParam('autoMakeup', !params.autoMakeup)}
            role="switch" aria-checked={params.autoMakeup} aria-label="Gain de sortie automatique"
            title="Gain auto : NOVA remonte tout seul le volume perdu par la compression"
            className={`w-14 h-7 rounded-full transition-all relative ${params.autoMakeup ? 'bg-cyan-500' : 'bg-white/10'}`}
          >
            <div className={`w-5 h-5 rounded-full bg-white absolute top-1 transition-all ${params.autoMakeup ? 'left-8' : 'left-1'}`} />
          </button>
        </div>
      </div>
    </div>
  );
};

const CompressorKnob: React.FC<{ 
  label: string;
  value: number;
  onChange: (v: number) => void;
  color: string;
  min: number;
  max: number;
  suffix: string;
  displayVal: string | number;
  factor?: number;
  disabled?: boolean;
  defaultValue?: number;
}> = ({ label, value, onChange, color, min, max, suffix, displayVal, disabled, defaultValue }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const knob = useKnobInteraction(safeValue, onChange, { min, max, disabled, defaultValue });
  const norm = (safeValue - min) / (max - min);
  const rotation = (norm * 270) - 135;



  return (
    <div title={termHelp(label) || undefined} className={`flex flex-col items-center space-y-2 group touch-none ${disabled ? 'opacity-40' : ''}`}>
      <div 
        {...knob.bind}
        className={`w-11 h-11 rounded-full bg-nv-surface border-2 border-white/10 flex items-center justify-center transition-all shadow-xl relative ${disabled ? 'cursor-not-allowed' : 'cursor-ns-resize hover:border-orange-500/50'}`}
      >
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-4 -ml-0.5 -mt-4 origin-bottom rounded-full transition-transform duration-75" 
          style={{ transform: `rotate(${rotation}deg) translateY(2px)`, backgroundColor: color }} 
        />
      </div>
      <div className="text-center">
        <span className="block text-[9px] font-bold text-slate-400 mb-1 whitespace-nowrap">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5">
          <span className="text-[8px] font-mono font-bold text-white">{displayVal}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export default VocalCompressorUI;
