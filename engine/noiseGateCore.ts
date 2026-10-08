/**
 * Cœur DSP du « Gate » (R7) : porte de bruit / expandeur avec clé externe.
 *
 * Le son passe quand le signal de DÉTECTION dépasse le seuil, et se ferme
 * (de « plage » dB) quand il retombe dessous, après le maintien. La détection
 * suit le son lui-même ou, avec une clé (side-chain), une autre piste ou un
 * bus : un pad, une 808 ou une prod hachée au rythme du kick ou des charleys
 * (Pro Tools : Dyn3 Expander/Gate avec « Key Input », Ableton : Gate en
 * side-chain, FL : Fruity Limiter en mode gate).
 *
 * JavaScript pur et AUTONOME (sérialisé tel quel dans l'AudioWorklet), même
 * code en lecture et à l'export. Aucune latence. Hystérésis de 4 dB : pas de
 * battement autour du seuil. Écoute de la clé : on entend la clé filtrée.
 */
export interface NoiseGateCoreParams {
  /** Seuil d'ouverture (dBFS). */
  threshold: number;
  /** Atténuation quand la porte est fermée (dB, ≥ 0 ; 80 = silence). */
  range: number;
  /** Ouverture (ms). */
  attack: number;
  /** Maintien après la dernière fois au-dessus du seuil (ms). */
  hold: number;
  /** Fermeture (ms). */
  release: number;
}

export function createNoiseGateCore(sr: number) {
  let P: NoiseGateCoreParams = { threshold: -40, range: 80, attack: 1, hold: 20, release: 80 };
  let g = 1;          // gain appliqué (linéaire)
  let env = 0;        // enveloppe de détection (crête, relâchement 10 ms)
  let open = false;
  let holdLeft = 0;   // échantillons de maintien restants
  let thrOpen = 0, thrClose = 0, floor = 0, aC = 1, rC = 1, holdN = 0;
  const envRel = Math.exp(-1 / (0.01 * sr));
  let kL: Float32Array | null = null, kR: Float32Array | null = null, keyOn = false, listen = false;
  const coef = (ms: number) => 1 - Math.exp(-1 / Math.max(1, (ms || 0) * 0.001 * sr));
  const clampN = (v: number, a: number, b: number, d: number) => (Number.isFinite(+v) ? Math.max(a, Math.min(b, +v)) : d);
  const setParams = (p: Partial<NoiseGateCoreParams>) => {
    P = Object.assign({}, P, p || {});
    const T = clampN(P.threshold, -100, 0, -40);
    thrOpen = Math.pow(10, T / 20);
    thrClose = Math.pow(10, (T - 4) / 20);
    floor = Math.pow(10, -clampN(P.range, 0, 100, 80) / 20);
    aC = coef(clampN(P.attack, 0, 200, 1));
    rC = coef(clampN(P.release, 1, 3000, 80));
    holdN = Math.round(clampN(P.hold, 0, 2000, 20) * 0.001 * sr);
  };
  setParams({});
  return {
    setParams,
    /** Clé externe du bloc suivant (null = détection sur le son), écoute de la clé. */
    setKey(l: Float32Array | null, r: Float32Array | null, on: boolean, lis: boolean) { kL = l; kR = r || l; keyOn = !!on && !!l; listen = keyOn && !!lis; },
    reset() { g = 1; env = 0; open = false; holdLeft = 0; },
    process(iL: Float32Array, iR: Float32Array, oL: Float32Array, oR: Float32Array | null, n: number) {
      const dL = keyOn && kL ? kL : iL, dR = keyOn && kR ? kR : iR;
      for (let i = 0; i < n; i++) {
        const a = Math.max(Math.abs(dL[i]), Math.abs(dR[i]));
        env = a > env ? a : env * envRel + a * (1 - envRel);
        if (env >= thrOpen) { open = true; holdLeft = holdN; }
        else if (open && env < thrClose) { if (holdLeft > 0) holdLeft--; else open = false; }
        else if (open && holdLeft > 0) holdLeft--;
        const target = open ? 1 : floor;
        g += (target - g) * (target > g ? aC : rC);
        if (listen) { oL[i] = dL[i]; if (oR) oR[i] = dR[i]; }
        else { oL[i] = iL[i] * g; if (oR) oR[i] = iR[i] * g; }
      }
    },
    meters() { return { open, gain: g, keyOn }; },
  };
}
