import { MeterDemand } from '../engine/meterDemand';
import React, { useState, useEffect } from 'react';
import { makeCurve, loadWorkletModule, fadeInOnInsert, isOfflineContext } from './vocalDspUtils';
import { retireWorkletNode } from '../engine/workletGuard';
import { blockClockSource } from '../engine/blockClock';
import { gainDbFr, numFr, termHelp } from '../utils/pluginUi';
import { AutomationSet, MappedParam } from '../engine/automationParams';
import { Faceplate, HwPresets, HwSection, HwWindow, Knob, PushButton, SegmentMeter, VuMeter, type KnobProps } from './hw';
import { useHwCanvas, hwCtx } from './hw/screens';

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
const COMP_WORKLET_CODE = `${blockClockSource()}
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
    this.cfg = { knee: 12, attack: 0.003, release: 0.25, scHpFreq: 80, lookahead: 0, mode: 0, keyOn: 0, keyListen: 0, threshold: -18, ratio: 4 };
    const o = (options && options.processorOptions) || {};
    // Étage de sortie (couleur, anti-continu, compensation du mode) : voir tailStage().
    this.curve = o.curve ? Float32Array.from(o.curve) : null;
    this.trim = Math.fround(Number.isFinite(o.trim) ? o.trim : 1);
    this.dc = new Float64Array(8);
    this.setDcBlock(8);
    if (o.cfg) this.setCfg(o.cfg);
    // Mesure de réduction envoyée seulement si quelqu'un la lit (vumètre de la piste visible,
    // fenêtre ouverte) : 43 messages/s par instance coûtaient au fil audio ET à l'interface.
    this.metersOn = false;
    this.port.onmessage = (e) => { const d = e.data || {}; if (d.cfg) this.setCfg(d.cfg);
      if (typeof d.meters === 'boolean') { this.metersOn = d.meters; this.msg = 0; this.grPeak = 0; }
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
    this.quietRun = 0; this.rest = false; this.clock = { next: -1 };
    this.aQdnLog = Math.log(Math.exp(-1 / (2.5 * sampleRate)));
  }
  setCfg(c) {
    // threshold / ratio : version légère seulement (sinon leurs AudioParams font foi), mêmes bornes.
    const B = { knee: [0, 40], attack: [0.00001, 1], release: [0.005, 5], scHpFreq: [10, 2000], lookahead: [0, 0.01], mode: [0, 3], keyOn: [0, 1], keyListen: [0, 1],
      threshold: [-100, 0], ratio: [1, 100] };
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
    // évoluent comme si les blocs muets avaient été calculés (voir catchUp). Une étiquette
    // currentFrame en retard (Chrome sous charge) n'est pas un saut : engine/blockClock.
    const skipped = framesSkipped(this.clock, currentFrame, n);
    if (skipped > 0) this.catchUp(skipped);
    if (p.resetGen && p.resetGen[0] !== this.gen) { this.gen = p.resetGen[0]; this.reset(); }
    if (cfg.scHpFreq !== this.lastFc) this.setHighpass(cfg.scHpFreq);
    // Version légère : seuil et ratio par message (arrondis en 32 bits comme un AudioParam).
    const T = p.threshold ? p.threshold[0] : cfg.threshold;
    const R = Math.max(1, p.ratio ? p.ratio[0] : cfg.ratio);
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
    // Au repos : détecteur retombé à zéro (seule la « charge » bouge encore, rattrapée en O(1)
    // au réveil : jamais de calcul en rafale quand 40 pistes se réveillent au même refrain).
    const rest = this.quietRun >= this.SIZE && this.xf <= 0 && y1 === 0 && yL === 0 && ms === 0 && !useKey
      && s[2] === 0 && s[3] === 0 && s[6] === 0 && s[7] === 0 && this.dcQuiet();
    if (rest !== this.rest) { this.rest = rest; this.port.postMessage({ rest }); }
    if (this.metersOn && ++this.msg >= 8) {
      this.msg = 0;
      this.port.postMessage({ gr: -yL, peak: -grPeak });
      this.grPeak = 0;
    }
    return true;
  }
}
/**
 * Version légère : un seul AudioParam (départ de lecture). Chaque AudioParam d'un worklet coûte
 * à chaque bloc, même immobile. Seuil et ratio par message ; la version complète est prise dès
 * qu'une voie d'automation les demande ou qu'une clé externe est choisie (CompressorNode.ensureFull).
 */
class VocalCompressorLite extends VocalCompressorProcessor {
  static get parameterDescriptors() { return [{ name: 'resetGen', defaultValue: 0, minValue: 0, maxValue: 1e9, automationRate: 'k-rate' }]; }
}
try { registerProcessor('vocal-compressor-processor-r', VocalCompressorProcessor); } catch (e) {}
try { registerProcessor('vocal-compressor-processor-r-lite', VocalCompressorLite); } catch (e) {}
`;

/** Code du worklet tel qu'il est chargé (banc de métrologie : tests/metrologieCompresseurs.test.ts). */
export const __compWorkletCodeForTests = () => COMP_WORKLET_CODE;

/**
 * Réglages RÉELLEMENT appliqués par le cœur selon le caractère (métrologie du 22/10/2026) :
 * OPTO lent et doux, FET rapide et dur, VCA tel quel, CLEAN neutre. Fonction pure, partagée par
 * le moteur (même calcul qu'avant, son identique au bit près) et par la fenêtre, qui affiche ces
 * valeurs : un « 3 ms » réglé en FET agit à 1,5 ms, un genou de 12 dB en FET est un genou de 4 dB.
 *  - trimDb : compensation de niveau du caractère (perte de crête de sa saturation) ;
 *  - rmsMs : détection RMS (VCA, OPTO), moyenne de cette constante de temps ; 0 = détection crête ;
 *  - releaseMax : facteur de relâche « dépendant du programme » quand la réduction dure (×2 VCA, ×5 OPTO).
 */
export function compModeDynamics(p: Partial<CompressorParams>) {
  const safe = (val: any, def: number) => Number.isFinite(val) ? val as number : def;
  let attack = Math.max(0.0001, safe(p.attack, 0.003));
  let release = Math.max(0.01, safe(p.release, 0.25));
  let knee = Math.max(0, Math.min(40, safe(p.knee, 12)));
  let trimDb = 0;
  switch (p.mode) {
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
  const rmsMs = p.mode === 'OPTO' ? 10 : p.mode === 'VCA' ? 4 : 0;
  const releaseMax = p.mode === 'OPTO' ? 5 : p.mode === 'VCA' ? 2 : 1;
  return { attack: Math.min(1, attack), release: Math.min(1, release), knee, trimDb, trim: Math.pow(10, trimDb / 20), rmsMs, releaseMax };
}

/**
 * Courbe statique du cœur (genou doux quadratique, ratio exact) : sortie (dB) pour une entrée (dB),
 * avant le gain de compensation. C'est celle que dessine l'écran (avec le genou EFFECTIF du caractère).
 */
export function compCurveOutDb(inDb: number, threshold: number, ratio: number, knee: number): number {
  const k = 1 - 1 / Math.max(1, ratio), over = inDb - threshold;
  if (2 * over > knee) return inDb - k * over;
  if (knee > 0 && 2 * over > -knee) { const u = over + knee / 2; return inDb - k * u * u / (2 * knee); }
  return inDb;
}

/** Gain auto (dB) : la moitié de la réduction qu'aurait un sinus à 0 dBFS (seuil et ratio du réglage). */
export const compAutoMakeupDb = (threshold: number, ratio: number) => (Math.abs(threshold) * (1 - 1 / ratio)) / 2;

/**
 * Temps (s) pour que la réduction redescende de 63 % après un son fort : détecteur « lisse découplé »
 * (relâche τR puis lissage d'attaque τA en cascade), réponse 1 − (τR·e^(−t/τR) − τA·e^(−t/τA)) / (τR − τA).
 * C'est la relâche que l'on MESURE (égale à τR seulement si l'attaque est très courte).
 */
export function compRelease63(release: number, attack: number): number {
  const R = Math.max(1e-6, release), A = Math.max(1e-7, attack);
  if (Math.abs(R - A) < 1e-9 * R) return 2.1461932206 * R; // τ double : (1 + t/τ)·e^(−t/τ) = e^(−1)
  const rest = (t: number) => (R * Math.exp(-t / R) - A * Math.exp(-t / A)) / (R - A);
  let lo = 0, hi = 20 * (R + A);
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (rest(m) > Math.exp(-1)) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

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

  // Metering (fenêtre ouverte seulement : créés à la première lecture, voir setTaps)
  private inputAnalyzer: AnalyserNode | null = null;
  private outputAnalyzer: AnalyserNode | null = null;
  private inputData: Float32Array = new Float32Array(128);
  private outputData: Float32Array = new Float32Array(128);
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
      this.worklet = this.makeWorklet(this.full || this.keyActive);
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

  /**
   * Version complète du worklet (seuil et ratio en AudioParams, clé externe) ou légère (par
   * message, même son au bit près). Légère par défaut ; complète dès qu'une voie d'automation
   * ou une clé la demande.
   */
  private full = false;
  private metersWanted = false;
  private makeWorklet(full: boolean): AudioWorkletNode {
    this.full = full;
    const cfg = this.workletCfg();
    const w = new AudioWorkletNode(this.ctx, full ? 'vocal-compressor-processor-r' : 'vocal-compressor-processor-r-lite', {
      numberOfInputs: full ? 2 : 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: { resetGen: this.resetCount },
      // Réglages fixes posés à la création : un message arriverait trop tard à l'export.
      processorOptions: { cfg, curve: Array.from(this.curveData), trim: this.trimTarget() },
    });
    this.cfgKey = JSON.stringify(cfg);
    if (full) {
      this.sidechainInput.connect(w, 0, 1);
      const wp = w.parameters;
      this.auto.add('threshold', new MappedParam(this.ctx, [{ param: wp.get('threshold')! }], { min: -60, max: 0, value: -18, affine: true }));
      this.auto.add('ratio', new MappedParam(this.ctx, [{ param: wp.get('ratio')! }], { min: 1, max: 20, value: 4, affine: true }));
    }
    w.port.onmessage = (e) => {
      const d = e.data || {};
      if (Number.isFinite(d.peak)) this.reduction = d.peak;
      if (typeof d.rest === 'boolean') this.atRest = d.rest;
    };
    if (this.metersWanted) w.port.postMessage({ meters: true });
    this.input.connect(w);
    w.connect(this.makeupGainNode);
    return w;
  }
  /**
   * Passe à la version complète (seuil ou ratio automatisé, clé externe). Le nouveau cœur part
   * de l'état d'une instance neuve, comme au départ de la lecture ; l'ancien est retiré dans la
   * même tâche (aucun bloc doublé ni manquant).
   */
  private ensureFull() {
    if (this.full || !this.worklet || this.disposed) return;
    const old = this.worklet;
    this.worklet = this.makeWorklet(true);
    this.atRest = false;
    retireWorkletNode(old);
    this.applyParams(true, true);
    if (this.lastResetAt > this.ctx.currentTime) this.resetAt(this.lastResetAt);
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
    if (on && !this.inputAnalyzer) {
      // ~300 Ko par analyseur : créés seulement quand la fenêtre lit ses vumètres.
      this.inputAnalyzer = this.ctx.createAnalyser(); this.inputAnalyzer.fftSize = 256;
      this.outputAnalyzer = this.ctx.createAnalyser(); this.outputAnalyzer.fftSize = 256;
    }
    try {
      if (on) { this.input.connect(this.inputAnalyzer!); this.output.connect(this.outputAnalyzer!); }
      else if (this.inputAnalyzer) { this.input.disconnect(this.inputAnalyzer); this.output.disconnect(this.outputAnalyzer!); }
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
  private lastResetAt = -1;
  /** Départ de la lecture à `at` (début d'un bloc) : détecteur, pré-lecture et charge repartent à neuf. */
  public resetAt(at: number) {
    this.lastResetAt = at;
    const ap = this.worklet?.parameters.get('resetGen');
    if (!ap) return;
    try { ap.setValueAtTime(++this.resetCount, Math.max(this.ctx.currentTime, at - 0.5 / this.ctx.sampleRate)); } catch { /* */ }
  }

  /** Retard ajoute par le plugin, en secondes (0 sauf pre-lecture choisie). */
  public get latency(): number {
    return this.effectiveLookahead() + (this.compressor ? 0.006 : 0);
  }

  /**
   * Pré-lecture réelle (s) : un nombre ENTIER d'échantillons, arrondi exactement comme le cœur
   * (réglage en 32 bits × fréquence). Avant le 22/10/2026, la latence annoncée au PDC et le retard
   * de la voie sèche gardaient la valeur brute (5 ms à 44,1 kHz = 220,5 échantillons annoncés pour
   * 220 réels) : décalage d'un demi-échantillon avec les autres pistes, et filtrage en peigne du
   * mélange parallèle (voie sèche retardée par interpolation). Le son compressé ne change pas.
   */
  private effectiveLookahead(): number {
    if (this.params.lowLatency || !this.params.isEnabled) return 0;
    const l = Number(this.params.lookahead);
    const raw = Number.isFinite(l) ? Math.max(0, Math.min(0.01, l)) : 0;
    const sr = this.ctx.sampleRate;
    return Math.round(Math.fround(raw) * sr) / sr;
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
    return compModeDynamics(this.params);
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
    // Seuil et ratio (version légère du worklet) : bornés comme leur réglage automatisable (MappedParam).
    const threshold = Math.max(-60, Math.min(0, Math.max(-100, Math.min(0, safe(this.params.threshold, -18)))));
    const ratio = Math.max(1, Math.min(20, Math.max(1, Math.min(20, safe(this.params.ratio, 4)))));
    return { knee: dyn.knee, attack: dyn.attack, release: dyn.release, scHpFreq: Math.max(10, Math.min(2000, safe(this.params.scHpFreq, 80))),
      lookahead: this.effectiveLookahead(), mode: MODE_INDEX[this.params.mode] ?? 0, keyOn: this.keyActive ? 1 : 0, keyListen: listen ? 1 : 0,
      threshold, ratio };
  }

  /**
   * Voies câblées seulement si elles comptent (chaque nœud câblé est calculé à chaque bloc) :
   *  - voie sèche (retard + gain) : mix < 1 ou mix automatisé ; à mix = 1 elle n'ajoute que des zéros.
   * (La courbe du mode CLEAN reste câblée : son interpolation n'est pas l'identité au bit près,
   * 2,3 LSB16 mesurés sans elle.)
   */
  private dryWired = true;
  private wetWired = true;
  private pathTimer: ReturnType<typeof setTimeout> | null = null;
  private mixAutomated = false;
  /** Voie sèche utile : mélange < 1 (ou automatisé), effet contourné, ou pré-lecture. */
  private dryNeeded(look = this.effectiveLookahead()): boolean {
    const mix = Number(this.params.mix);
    return this.mixAutomated || !this.params.isEnabled || !(Number.isFinite(mix) && mix >= 1) || look > 0;
  }
  /** Gain de mélange (voie compressée) utile : mélange < 1 (ou automatisé) ou effet contourné ; à 1 c'est une copie. */
  private wetNeeded(): boolean {
    const mix = Number(this.params.mix);
    return this.mixAutomated || !this.params.isEnabled || !(Number.isFinite(mix) && mix >= 1);
  }
  private setDry(on: boolean) {
    if (on === this.dryWired) return;
    try { if (on) this.input.connect(this.dryDelay); else this.input.disconnect(this.dryDelay); } catch { /* */ }
    this.dryWired = on;
  }
  private setWet(on: boolean) {
    if (on === this.wetWired) return;
    // Jamais deux chemins à la fois (le son doublerait un instant) : l'ancien est coupé d'abord.
    try {
      if (on) { this.makeupGainNode.disconnect(this.output); this.makeupGainNode.connect(this.wetGain); }
      else { this.makeupGainNode.disconnect(this.wetGain); this.makeupGainNode.connect(this.output); }
    } catch { /* */ }
    this.wetWired = on;
  }
  /**
   * Ajout d'une voie : tout de suite (son gain part de sa valeur actuelle). Retrait : tout de
   * suite à la mise en place (sortie encore muette) et à l'export, sinon 250 ms plus tard
   * (fin du glissement du mélange).
   */
  private syncPaths(look: number, immediate = false) {
    if (!this.worklet) return;
    const wantDry = this.dryNeeded(look), wantWet = this.wetNeeded();
    if (wantDry) this.setDry(true);
    if (wantWet) this.setWet(true);
    if ((wantDry || !this.dryWired) && (wantWet || !this.wetWired)) {
      if (this.pathTimer) { clearTimeout(this.pathTimer); this.pathTimer = null; }
      return;
    }
    const cut = () => {
      this.pathTimer = null;
      if (this.disposed || !this.worklet) return;
      if (!this.dryNeeded()) this.setDry(false);
      if (!this.wetNeeded()) this.setWet(false);
    };
    if (immediate || isOfflineContext(this.ctx) || this.ctx.currentTime <= 0) cut();
    else if (!this.pathTimer) this.pathTimer = setTimeout(cut, 250);
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
      this.syncPaths(look, immediate);
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
    if (key === 'threshold' || key === 'ratio') this.ensureFull();
    return this.auto.get(key);
  }

  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() { this.auto.restoreStatic(); }

  /** Clé externe branchée (R7) : la détection écoute `sidechainInput`. */
  public setSidechainActive(on: boolean) {
    if (on === this.keyActive) return;
    this.keyActive = on;
    if (on) this.ensureFull();
    this.applyParams();
  }
  public get sidechainActive() { return this.keyActive; }

  /** Reduction de gain la plus forte depuis la derniere lecture (dB, <= 0). */
  public getReduction(): number {
    if (this.compressor) return this.compressor.reduction;
    this.meterDemand.read();
    return this.reduction;
  }
  /** Mesure demandée au worklet seulement pendant qu'on la lit (coupée 1,5 s après la dernière lecture). */
  private meterDemand = new MeterDemand(on => {
    this.metersWanted = on;
    if (!on) this.reduction = 0;
    try { this.worklet?.port.postMessage({ meters: on }); } catch { /* worklet libéré */ }
  });

  public getInputLevel(): number {
    this.readTaps();
    if (!this.inputAnalyzer) return -100;
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
    if (!this.outputAnalyzer) return -100;
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
    if (this.pathTimer) { clearTimeout(this.pathTimer); this.pathTimer = null; }
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

/**
 * Fenêtre du Compresseur, dessinée comme un compresseur de studio (kit plugins/hw) :
 * façade bleu pétrole, écran de la courbe de compression, VU à aiguille de la
 * réduction de gain, échelles de LED d'entrée et de sortie (animés hors React),
 * caractères Clean / VCA / Opto / FET en boutons-poussoirs, préréglages dans la
 * barre d'outils. Aide : infobulles + ligne d'info.
 * Seule l'apparence a changé : mêmes réglages, mêmes bornes, mêmes préréglages et
 * mêmes paramètres envoyés au moteur (preuve : tests/pluginsFin.test.ts).
 */
const COMP_ACCENT = '#fb923c';
const COMP_MODES: { v: CompressorParams['mode']; label: string }[] = [
  { v: 'CLEAN', label: 'Clean' }, { v: 'VCA', label: 'VCA' }, { v: 'OPTO', label: 'Opto' }, { v: 'FET', label: 'FET' },
];
const PRESET_HINTS: Record<string, string> = {
  'Vocal Smooth': 'Opto 3:1, attaque lente : la voix reste naturelle et régulière.',
  'Vocal Aggressive': 'FET 6:1, attaque rapide : la voix passe devant le beat.',
  'Mix Bus Glue': 'VCA 2:1, mélange 50 % : soude le mix sans l’écraser.',
  'Parallel Punch': 'FET 8:1 mélangé à 30 % : du punch sans perdre les attaques.',
  'Transparent Limiter': 'Clean 20:1 avec 5 ms d’anticipation : un plafond propre (ajoute 5 ms de retard, compensé).',
};
const COMP_PRESETS = Object.entries(COMPRESSOR_PRESETS).map(([id, params]) => ({ id, name: PRESET_LABELS[id] || id, hint: PRESET_HINTS[id], params }));
const COMP_HINTS = {
  threshold: termHelp('Seuil'),
  ratio: termHelp('Ratio'),
  knee: termHelp('Genou'),
  attack: `${termHelp('Attack')} Valeur affichée = constante de temps : 63 % de la réduction est atteinte en ce temps (90 % en 2,3 fois ce temps).`,
  release: `${termHelp('Release')} Valeur affichée = constante de temps de la relâche ; la relâche réellement mesurée (63 %) est indiquée sous les boutons.`,
  makeupGain: `${termHelp('Gain de sortie')} Grisé quand « Gain auto » est enfoncé.`,
  mix: termHelp('Mélange'),
  lookahead: termHelp('Anticipation'),
  scHpFreq: "Filtre de détection : le compresseur ignore les graves sous cette fréquence pour décider quand agir (le kick ou la 808 ne le font plus « pomper »). Le son lui-même n'est pas filtré.",
  autoMakeup: 'Gain auto : NOVA remonte tout seul le volume perdu par la compression.',
  vu: 'Réduction de gain : de combien (dB) le compresseur baisse le son en ce moment. Sur une voix, 3 à 6 dB au VU, c’est bien.',
};
const signedFr = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + numFr(Math.abs(v), d);
const msFr = (s: number) => { const ms = s * 1000; return `${ms < 10 ? numFr(ms, 1) : numFr(ms, 0)} ms`; };
/** Durée lisible (ms jusqu'à 1 s, puis s). */
const durFr = (s: number) => (s >= 1 ? `${numFr(s, s >= 10 ? 0 : 2)} s` : msFr(s));

/**
 * Ce que le compresseur fait VRAIMENT avec ces réglages (métrologie du 22/10/2026) : attaque
 * (constante de temps, 63 %), relâche mesurée à 63 % (relâche + lissage d'attaque), genou,
 * détection et compensation du caractère. Mêmes calculs que le moteur (compModeDynamics).
 */
export function compRealText(p: Partial<CompressorParams>): string {
  const d = compModeDynamics(p);
  const parts = [`attaque ${msFr(d.attack)}`, `relâche ${durFr(compRelease63(d.release, d.attack))} (63 %)`];
  if (d.releaseMax > 1) parts[1] += `, jusqu’à ${durFr(compRelease63(d.release * d.releaseMax, d.attack))} si la réduction dure`;
  parts.push(`genou ${numFr(d.knee, d.knee % 1 ? 1 : 0)} dB`);
  parts.push(d.rmsMs ? `détection RMS (moyenne ${numFr(d.rmsMs, 0)} ms)` : 'détection crête');
  if (d.trimDb) parts.push(`${signedFr(d.trimDb)} dB de compensation du caractère`);
  return `Réel : ${parts.join(' · ')}`;
}

/** Écran de la courbe de compression : redessiné quand un réglage change, jamais à chaque image. */
const CompCurve: React.FC<{ threshold: number; ratio: number; knee: number; mode: string }> = React.memo(({ threshold, ratio, knee, mode }) => {
  const { wrapRef, canvasRef, size } = useHwCanvas();
  useEffect(() => {
    const ctx = hwCtx(canvasRef.current, size);
    if (!ctx) return;
    const w = size.w, h = size.h;
    ctx.clearRect(0, 0, w, h);
    const X = (db: number) => ((db + 60) / 60) * w;
    const Y = (db: number) => h - ((db + 60) / 60) * h;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let db = -60; db <= 0; db += 12) {
      ctx.beginPath(); ctx.moveTo(X(db), 0); ctx.lineTo(X(db), h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, Y(db)); ctx.lineTo(w, Y(db)); ctx.stroke();
    }
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(251,146,60,0.45)';
    ctx.beginPath(); ctx.moveTo(X(threshold), 0); ctx.lineTo(X(threshold), h); ctx.stroke();
    // Courbe du cœur (genou doux quadratique, ratio exact) avec le genou EFFECTIF du caractère : celle qu'on entend.
    ctx.beginPath();
    ctx.strokeStyle = COMP_ACCENT;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(251,146,60,0.45)';
    for (let i = 0; i <= w; i++) {
      const inDb = (i / w) * 60 - 60;
      const y = Y(compCurveOutDb(inDb, threshold, ratio, knee));
      if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [size, threshold, ratio, knee, canvasRef]);
  return (
    <div ref={wrapRef} className="hw-screen-glass" style={{ height: 150 }} data-nova-comp-curve>
      <span className="hw-screen-label" style={{ top: 6, left: 8 }}>Courbe · seuil <b>{numFr(threshold, 0)} dB</b></span>
      <span className="hw-screen-label" style={{ bottom: 6, right: 8 }}>{mode} · <b>{numFr(ratio, 1)}:1</b></span>
      <canvas ref={canvasRef} className="hw-screen-canvas" aria-label={`Courbe de compression : seuil ${numFr(threshold, 0)} dB, ratio ${numFr(ratio, 1)}:1`} />
    </div>
  );
});

export const VocalCompressorUI: React.FC<VocalCompressorUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<CompressorParams>(() => withCompressorDefaults(initialParams));

  // Mêmes envois qu'avant : réglages complets au moteur et au projet.
  const updateParam = (key: keyof CompressorParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  // Préréglage : seules ses valeurs vont au moteur, les réglages complets au projet (comme avant).
  const applyPreset = (presetName: string) => {
    const preset = COMPRESSOR_PRESETS[presetName];
    if (preset) {
      const newParams = { ...params, ...preset };
      setParams(newParams);
      node.updateParams(preset);
      if (onParamsChange) onParamsChange(newParams);
    }
  };

  const K = (id: 'threshold' | 'ratio' | 'knee' | 'attack' | 'release' | 'makeupGain' | 'mix' | 'lookahead' | 'scHpFreq', label: string, o: Pick<KnobProps, 'min' | 'max'> & Partial<KnobProps>) => (
    <Knob paramId={id} label={label} hint={COMP_HINTS[id]} value={params[id] as number} onChange={v => updateParam(id, v)} cap="cream" arc={COMP_ACCENT} {...o} />
  );
  const latencyMs = node && Number.isFinite(node.latency) ? node.latency * 1000 : 0;
  const levelColor = (v: number) => (v > -1 ? '#ef4444' : v > -9 ? '#facc15' : '#4ade80');
  const dbText = (v: number) => (v > -59.5 ? `${signedFr(v)} dB` : '— dB');

  return (
    <HwWindow type="COMPRESSOR" width={660} accent={COMP_ACCENT} accentInk="#1c0d02" latencyMs={latencyMs}
      toolbar={<HwPresets presets={COMP_PRESETS} current={params} onApply={pr => applyPreset(pr.id)} />}
      idleHelp={<>Rend le volume de la voix plus régulier pour qu’elle reste devant le beat. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="petrol" model="Compresseur" kicker="Compresseur de studio · 4 caractères" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: COMP_ACCENT }}>
        <div className="flex flex-wrap sm:flex-nowrap items-stretch gap-3">
          <div className="hw-screen w-full sm:flex-1 min-w-0">
            <CompCurve threshold={params.threshold} ratio={params.ratio} knee={compModeDynamics(params).knee} mode={COMP_MODES.find(m => m.v === params.mode)?.label || params.mode} />
          </div>
          <div className="flex items-center justify-center gap-3 w-full sm:w-auto" aria-label="Mesures du compresseur">
            <VuMeter read={() => -(node?.getReduction?.() || 0)} mode="gr" caption="Réduction de gain" readout hint={COMP_HINTS.vu}
              dataAttrs={{ 'data-nova-gr-vu': '' }} style={{ width: 196, flex: '0 1 196px' }} />
            <SegmentMeter label="Entrée" orientation="vertical" min={-60} max={0} segments={16} length={118} holdMs={1200} fallPerSec={24}
              read={() => node?.getInputLevel?.() ?? -100} colorAt={levelColor} hint="Crête d'entrée (dB)"
              scale={[{ v: -60, label: '−60' }, { v: -24, label: '−24' }, { v: 0, label: '0' }]} format={(_v, hold) => dbText(hold)} />
            <SegmentMeter label="Sortie" orientation="vertical" min={-60} max={0} segments={16} length={118} holdMs={1200} fallPerSec={24}
              read={() => node?.getOutputLevel?.() ?? -100} colorAt={levelColor} hint="Crête de sortie (dB)"
              scale={[{ v: -60, label: '−60' }, { v: -24, label: '−24' }, { v: 0, label: '0' }]} format={(_v, hold) => dbText(hold)} />
          </div>
        </div>

        <HwSection title="Caractère" className="mt-3">
          <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Caractère du compresseur" data-nova-param="mode">
            {COMP_MODES.map(m => (
              <PushButton key={m.v} role="radio" active={params.mode === m.v} onClick={() => updateParam('mode', m.v)} text={m.label} led={COMP_ACCENT}
                ariaLabel={`Caractère ${m.label}`} hint={MODE_HELP[m.v]} dark />
            ))}
          </div>
        </HwSection>

        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3 mt-3">
          {K('threshold', 'Seuil', { size: 'L', min: -60, max: 0, step: 0.1, defaultValue: -18, format: v => `${signedFr(v)} dB`,
            scale: [{ v: -60, label: '−60' }, { v: -40, label: '−40' }, { v: -20, label: '−20' }, { v: 0, label: '0' }] })}
          {K('ratio', 'Ratio', { size: 'L', min: 1, max: 20, step: 0.1, curve: 'log', defaultValue: 4, format: v => `${numFr(v, 1)}:1`,
            scale: [{ v: 1, label: '1' }, { v: 2, label: '2' }, { v: 4, label: '4' }, { v: 10, label: '10' }, { v: 20, label: '20' }] })}
          {K('knee', 'Genou', { size: 'M', min: 0, max: 40, step: 0.5, defaultValue: 12, format: v => `${numFr(v, v % 1 ? 1 : 0)} dB`,
            scale: [{ v: 0, label: '0' }, { v: 20, label: '20' }, { v: 40, label: '40' }] })}
          {K('attack', 'Attaque', { size: 'M', min: 0.0001, max: 0.1, curve: 'log', defaultValue: 0.003, format: msFr, ariaLabel: 'Attaque (attack)',
            scale: [{ v: 0.0001, label: '0,1' }, { v: 0.003, label: '3' }, { v: 0.1, label: '100' }], sub: 'ms' })}
          {K('release', 'Relâche', { size: 'M', min: 0.01, max: 1, curve: 'log', defaultValue: 0.25, format: msFr, ariaLabel: 'Relâche (release)',
            scale: [{ v: 0.01, label: '10' }, { v: 0.1, label: '100' }, { v: 1, label: '1k' }], sub: 'ms' })}
        </div>
        <p className="hw-silk hw-silk-soft mt-2" style={{ textAlign: 'center', textTransform: 'none', letterSpacing: '0.02em' }} data-nova-comp-reel aria-live="polite">
          {compRealText(params)}
        </p>

        <HwSection title="Sortie et mélange" className="mt-3">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3">
            {K('makeupGain', 'Sortie', { size: 'M', min: 0.25, max: 4, curve: 'log', defaultValue: 1.6, disabled: params.autoMakeup, ariaLabel: 'Gain de sortie',
              format: v => (params.autoMakeup ? `auto · ${signedFr(compAutoMakeupDb(params.threshold, params.ratio))} dB` : gainDbFr(v)), scale: [{ v: 0.25, label: '−12' }, { v: 1, label: '0' }, { v: 4, label: '+12' }] })}
            <div className="flex flex-col items-center gap-1 pt-4" data-nova-param="autoMakeup">
              <PushButton role="checkbox" active={!!params.autoMakeup} onClick={() => updateParam('autoMakeup', !params.autoMakeup)} text="Auto" label="Gain auto"
                led="#4ade80" ariaLabel="Gain de sortie automatique" hint={COMP_HINTS.autoMakeup} dark valueText={params.autoMakeup ? 'enfoncé (gain automatique)' : 'relevé'} />
            </div>
            {K('mix', 'Mélange', { size: 'M', min: 0, max: 1, step: 0.01, defaultValue: 1, format: v => `${Math.round(v * 100)} %`,
              scale: [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }] })}
            {K('lookahead', 'Anticip.', { size: 'S', min: 0, max: 0.005, step: 0.0001, defaultValue: 0, format: v => `${numFr(v * 1000, 1)} ms`, ariaLabel: 'Anticipation (lookahead)', ticks: 6 })}
            {K('scHpFreq', 'Détection', { size: 'S', min: 20, max: 500, step: 1, curve: 'log', defaultValue: 80, format: v => `${Math.round(v)} Hz`, ariaLabel: 'Filtre de détection (coupe-bas)', ticks: 6 })}
          </div>
        </HwSection>
      </Faceplate>
    </HwWindow>
  );
};

export default VocalCompressorUI;
