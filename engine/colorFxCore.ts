/**
 * Cœurs DSP « couleur » de NOVA (V21), en JavaScript pur, sérialisés dans
 * l'AudioWorklet (rien en dehors des fonctions), identiques en lecture, à
 * l'export et dans les tests. Aucune latence.
 *
 *  - Filtre DJ : un seul bouton, passe-bas à gauche, passe-haut à droite,
 *    transparent au centre (comme le filtre des tables de mixage DJ, l'Auto
 *    Filter de Live ou le DJ Filter de Logic). Filtres à variables d'état
 *    « TPT » (Zavalishin) : balayage sans craquement, résonance réglable.
 *  - Lo-fi / téléphone / radio : bande passante (coupe-bas + coupe-haut),
 *    saturation légère, réduction d'échantillonnage et de résolution
 *    (bitcrush), souffle (comme Bitcrusher de Logic, Redux de Live ou
 *    Lo-fi de FL Studio).
 */

export interface DjFilterCoreParams {
  /** −1 = passe-bas fermé … 0 = transparent … +1 = passe-haut fermé. */
  filter: number;
  /** Résonance 0 … 1. */
  resonance: number;
  /** Pente : 12 ou 24 dB/octave. */
  slope: number;
  /** Gain de sortie (dB). */
  output: number;
}

export function createDjFilterCore(sampleRate: number) {
  const sr = sampleRate;
  let P: DjFilterCoreParams = { filter: 0, resonance: 0.2, slope: 24, output: 0 };
  const DZ = 0.02;                                        // zone morte au centre
  const smoothK = 1 - Math.exp(-1 / (0.02 * sr));          // lissage du bouton (20 ms)
  let xs = 0;                                             // position lissée
  // Deux étages × deux canaux : états ic1, ic2.
  const ic = new Float64Array(8);
  let a1 = [0, 0], a2 = [0, 0], a3 = [0, 0], kk = [1.414, 1.414];
  let isHp = false, wet = 0, outG = 1;
  let counter = 0;

  /** Fréquence de coupure pour une position t ∈ [0, 1] (0 = ouvert). */
  const cutoff = (t: number, hp: boolean) => hp ? 20 * Math.pow(9000 / 20, t) : 20000 * Math.pow(70 / 20000, t);

  const design = () => {
    const ax = Math.abs(xs);
    isHp = xs > 0;
    const t = Math.max(0, Math.min(1, (ax - DZ) / (1 - DZ)));
    const x = Math.max(0, Math.min(1, (ax - DZ) / 0.08));
    wet = x * x * (3 - 2 * x);
    const fc = Math.min(sr * 0.49, cutoff(t, isHp));
    const g = Math.tan(Math.PI * fc / sr);
    const res = Math.max(0, Math.min(1, P.resonance));
    const qs = P.slope >= 24 ? [0.5412, 1.3066 + res * 6] : [0.7071 + res * 7, 0];
    for (let s = 0; s < 2; s++) {
      const q = qs[s] || 0.7071;
      const k = 1 / q;
      kk[s] = k;
      a1[s] = 1 / (1 + g * (g + k)); a2[s] = g * a1[s]; a3[s] = g * a2[s];
    }
    outG = Math.pow(10, (P.output || 0) / 20) / (1 + res * 0.6 * wet);
  };
  design();

  const stage = (x: number, s: number, ch: number) => {
    const o = (s * 2 + ch) * 2;
    const v3 = x - ic[o + 1];
    const v1 = a1[s] * ic[o] + a2[s] * v3;
    const v2 = ic[o + 1] + a2[s] * ic[o] + a3[s] * v3;
    ic[o] = 2 * v1 - ic[o]; ic[o + 1] = 2 * v2 - ic[o + 1];
    return isHp ? x - kk[s] * v1 - v2 : v2;
  };

  const process = (iL: Float32Array, iR: Float32Array | null, oL: Float32Array, oR: Float32Array | null, n: number) => {
    const target = Math.max(-1, Math.min(1, P.filter || 0));
    const two = P.slope >= 24;
    for (let j = 0; j < n; j++) {
      xs += (target - xs) * smoothK;
      if (Math.abs(target - xs) < 1e-5) xs = target;
      if ((counter++ & 15) === 0) design();
      const l = iL[j], r = iR ? iR[j] : l;
      if (wet <= 0) {
        // Transparent : on garde les filtres « à jour » sans les entendre.
        oL[j] = l * outG; if (oR) oR[j] = r * outG;
        stage(l, 0, 0); stage(r, 0, 1); if (two) { stage(l, 1, 0); stage(r, 1, 1); }
        continue;
      }
      let fl = stage(l, 0, 0), fr = stage(r, 0, 1);
      if (two) { fl = stage(fl, 1, 0); fr = stage(fr, 1, 1); }
      oL[j] = (l + (fl - l) * wet) * outG;
      if (oR) oR[j] = (r + (fr - r) * wet) * outG;
    }
  };

  return {
    setParams: (q: Partial<DjFilterCoreParams>) => { P = { ...P, ...q }; },
    process,
    cutoffHz: () => { const ax = Math.abs(xs); return ax <= DZ ? 0 : cutoff(Math.max(0, Math.min(1, (ax - DZ) / (1 - DZ))), xs > 0); },
    reset: () => { ic.fill(0); xs = P.filter || 0; design(); },
  };
}

export interface LofiCoreParams {
  /** Résolution (bits) : 16 = intacte. */
  bits: number;
  /** Fréquence d'échantillonnage simulée (Hz) : ≥ 44 100 = intacte. */
  rate: number;
  /** Coupe-bas (Hz) : 20 = aucun. */
  lowCut: number;
  /** Coupe-haut (Hz) : ≥ 20 000 = aucun. */
  highCut: number;
  /** Saturation 0 … 1. */
  drive: number;
  /** Souffle 0 … 1. */
  noise: number;
  /** Dosage 0 … 1. */
  mix: number;
  /** Gain de sortie (dB). */
  output: number;
}

export function createLofiCore(sampleRate: number) {
  const sr = sampleRate;
  let P: LofiCoreParams = { bits: 16, rate: 48000, lowCut: 20, highCut: 20000, drive: 0, noise: 0, mix: 1, output: 0 };
  // Biquads (RBJ) : 2 coupe-bas + 2 coupe-haut (24 dB/oct), par canal.
  type Bq = { b0: number; b1: number; b2: number; a1: number; a2: number; on: boolean };
  const off: Bq = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, on: false };
  let hp: Bq[] = [off, off], lp: Bq[] = [off, off];
  const z = new Float64Array(24);
  const coefs = (type: 'hp' | 'lp', fc: number, q: number): Bq => {
    const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q), a0 = 1 + a;
    if (type === 'lp') return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, on: true };
    return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, on: true };
  };
  let driveK = 1, q = 0, step = 1, noiseAmp = 0, outG = 1, mix = 1;
  const design = () => {
    hp = P.lowCut > 25 ? [coefs('hp', P.lowCut, 0.5412), coefs('hp', P.lowCut, 1.3066)] : [off, off];
    lp = P.highCut < 19500 && P.highCut < sr * 0.45 ? [coefs('lp', P.highCut, 0.5412), coefs('lp', P.highCut, 1.3066)] : [off, off];
    driveK = 1 + 6 * Math.max(0, Math.min(1, P.drive || 0));
    const bits = Math.max(1, Math.min(16, P.bits || 16));
    q = bits >= 16 ? 0 : Math.pow(2, bits - 1);
    step = P.rate > 0 && P.rate < sr * 0.98 ? Math.max(0.0005, P.rate / sr) : 1;
    noiseAmp = (P.noise || 0) > 0 ? Math.pow(10, (-66 + 40 * Math.min(1, P.noise)) / 20) : 0;
    outG = Math.pow(10, (P.output || 0) / 20);
    mix = Math.max(0, Math.min(1, P.mix ?? 1));
  };
  design();
  const run = (x: number, b: Bq, o: number) => {
    if (!b.on) return x;
    const y = b.b0 * x + z[o];
    z[o] = b.b1 * x - b.a1 * y + z[o + 1];
    z[o + 1] = b.b2 * x - b.a2 * y;
    return y;
  };
  let phase = 1, holdL = 0, holdR = 0;
  let seed = 0x2468ace;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const shape = (x: number) => (driveK > 1.0001 ? Math.tanh(driveK * x) / driveK * (1 + 0.15 * (driveK - 1) / 6) : x);

  const process = (iL: Float32Array, iR: Float32Array | null, oL: Float32Array, oR: Float32Array | null, n: number) => {
    for (let j = 0; j < n; j++) {
      const l = iL[j], r = iR ? iR[j] : l;
      let yl = run(run(l, hp[0], 0), hp[1], 2), yr = run(run(r, hp[0], 4), hp[1], 6);
      yl = shape(yl); yr = shape(yr);
      // Coupe-haut AVANT l'échantillonneur (comme un vrai téléphone : pas de repliement au-dessus de la bande)…
      yl = run(run(yl, lp[0], 16), lp[1], 18); yr = run(run(yr, lp[0], 20), lp[1], 22);
      // Réduction d'échantillonnage (échantillonneur-bloqueur) : repliement voulu, comme un vieux sampler.
      if (step < 1) {
        phase += step;
        if (phase >= 1) { phase -= Math.floor(phase); holdL = yl; holdR = yr; }
        yl = holdL; yr = holdR;
      }
      if (q > 0) { yl = Math.round(yl * q) / q; yr = Math.round(yr * q) / q; }
      // … et après (lisse les marches de l'échantillonneur et du bitcrush).
      yl = run(run(yl, lp[0], 8), lp[1], 10); yr = run(run(yr, lp[0], 12), lp[1], 14);
      if (noiseAmp > 0) { yl += noiseAmp * rnd(); yr += noiseAmp * rnd(); }
      oL[j] = (l + (yl - l) * mix) * outG;
      if (oR) oR[j] = (r + (yr - r) * mix) * outG;
    }
  };
  return {
    setParams: (p: Partial<LofiCoreParams>) => { P = { ...P, ...p }; design(); },
    process,
    reset: () => { z.fill(0); phase = 1; holdL = holdR = 0; seed = 0x2468ace; },
  };
}
