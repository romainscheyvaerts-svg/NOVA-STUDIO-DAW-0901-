/**
 * Cœur DSP du « Gate rythmique » (V21) : un motif de 16 pas calé sur le tempo
 * coupe et rouvre le son (Gross Beat de FL Studio, Trance Gate, ShaperBox).
 *
 * JavaScript pur et AUTONOME : la fonction est sérialisée telle quelle dans
 * l'AudioWorklet (aucune référence extérieure). Même code en lecture et à
 * l'export. Aucune latence : le gain est appliqué échantillon par échantillon.
 *
 * L'horloge (`setClock`) donne la position dans le morceau (s) au début du
 * bloc suivant : le motif suit la grille du projet, quel que soit l'endroit
 * où la lecture démarre. Les bords de pas sont adoucis par une attaque et un
 * relâchement (filtre à un pôle) : jamais de clic.
 */
export interface GateCoreParams {
  /** Niveau de chaque pas (0 = fermé, 1 = ouvert), 16 valeurs. */
  steps: number[];
  /** Pas par temps : 2 = croches, 4 = doubles croches, 3 / 6 = triolets, 8 = triples croches. */
  rate: number;
  /** Longueur du motif (pas). */
  length: number;
  /** Profondeur (0 → 1) : 1 = un pas fermé est muet. */
  depth: number;
  /** Attaque et relâchement (ms). */
  attack: number;
  release: number;
  bpm: number;
}

export function createGateCore(sr: number) {
  let P: GateCoreParams = { steps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], rate: 4, length: 16, depth: 1, attack: 2, release: 20, bpm: 120 };
  let g = 1;
  let clock = 0;
  let step = 0;
  let aC = 1, rC = 1;
  const coef = (ms: number) => 1 - Math.exp(-1 / Math.max(1, (ms || 0) * 0.001 * sr));
  const clampN = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : a);
  const setParams = (p: Partial<GateCoreParams>) => {
    P = Object.assign({}, P, p || {});
    P.rate = clampN(+P.rate || 4, 1, 16);
    P.length = Math.round(clampN(+P.length || 16, 1, 16));
    P.depth = clampN(+P.depth, 0, 1);
    P.bpm = clampN(+P.bpm || 120, 20, 400);
    aC = coef(clampN(+P.attack, 0, 200));
    rC = coef(clampN(+P.release, 0, 1000));
  };
  setParams({});
  /** Pas joué à la position `t` (s du morceau). */
  const stepAt = (t: number) => {
    const per = 60 / P.bpm / P.rate;
    const k = Math.floor(t / per + 1e-9);
    return ((k % P.length) + P.length) % P.length;
  };
  return {
    setParams,
    /** Position (s dans le morceau) du premier échantillon du prochain bloc. */
    setClock(t: number) { if (Number.isFinite(t)) clock = t; },
    reset() { g = 1; },
    stepAt,
    /** Gain visé à la position `t`. */
    targetAt(t: number) {
      const lvl = clampN(+P.steps[stepAt(t)], 0, 1);
      return 1 - P.depth * (1 - lvl);
    },
    process(iL: Float32Array, iR: Float32Array, oL: Float32Array, oR: Float32Array | null, n: number) {
      const per = 60 / P.bpm / P.rate;
      const len = P.length, depth = P.depth, steps = P.steps;
      const dt = 1 / sr;
      for (let i = 0; i < n; i++) {
        const t = clock + i * dt;
        const k = Math.floor(t / per + 1e-9);
        const s = ((k % len) + len) % len;
        const lv = +steps[s];
        const target = 1 - depth * (1 - (lv > 1 ? 1 : lv < 0 || !(lv === lv) ? 0 : lv));
        g += (target - g) * (target > g ? aC : rC);
        oL[i] = iL[i] * g;
        if (oR) oR[i] = iR[i] * g;
        if (i === 0) step = s;
      }
      clock += n * dt;
    },
    meters() { return { step, gain: g }; },
  };
}
