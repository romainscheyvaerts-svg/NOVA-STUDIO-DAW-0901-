/**
 * Cœur DSP des effets « temps » de NOVA (V21) : tape stop, half-time, stutter,
 * comme Gross Beat (FL Studio), le Beat Repeat de Live ou les effets trap.
 * JavaScript pur, sérialisé dans l'AudioWorklet (rien en dehors de la
 * fonction), identique en lecture, à l'export et dans les tests.
 *
 * Aucune latence : la tête de lecture lit le signal qui vient d'entrer, ou un
 * peu de passé (jamais d'avance). Au repos, la sortie est l'entrée, à
 * l'échantillon près.
 *
 *  - Tape stop (`stop` = 1) : la vitesse de lecture descend de 1 à 0 en
 *    `stopBeats` temps (la hauteur descend avec, jusqu'à l'arrêt), selon une
 *    courbe réglable ; puis silence. Relâché (`stop` = 0) : redémarrage
 *    (« tape start ») en `startBeats` temps, calé pour retomber pile sur le
 *    temps réel, ou retour immédiat.
 *  - Half-time (`half` = 1) : chaque cycle de `halfBeats` temps rejoue sa
 *    première moitié à demi-vitesse (une octave plus bas, comme une bande
 *    ralentie), puis se recale sur le cycle suivant.
 *  - Stutter (`stutter` = 1) : répète la tranche de `stutterDiv` temps qui
 *    commence au déclenchement (1/16, 1/8…).
 * Les sauts de tête de lecture passent par un fondu enchaîné de 8 ms.
 */

export interface TimeFxCoreParams {
  stop: number; stopBeats: number; stopCurve: number; startBeats: number;
  half: number; halfBeats: number;
  stutter: number; stutterDiv: number;
  bpm: number;
}

export interface TimeFxCore {
  setParams(p: Partial<TimeFxCoreParams>): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  /** Vitesse de lecture actuelle (1 = normale, 0 = arrêt) et état. */
  state(): { speed: number; mode: string };
  /** Courbe du tape stop : vitesse à l'avancement u ∈ [0, 1], courbe c ∈ [−1, 1]. */
  curve(u: number, c: number): number;
  reset(): void;
}

export function createTimeFxCore(sampleRate: number): TimeFxCore {
  const sr = sampleRate;
  const pow2 = (x: number) => { let p = 1; while (p < x) p <<= 1; return p; };
  const N = pow2(Math.ceil(sr * 11));          // 11 s de passé (half-time sur 8 temps à 50 BPM)
  const MASK = N - 1;
  const bufL = new Float32Array(N), bufR = new Float32Array(N);
  const XF = Math.max(16, Math.round(sr * 0.008));

  let P: TimeFxCoreParams = { stop: 0, stopBeats: 1, stopCurve: 0, startBeats: 0, half: 0, halfBeats: 4, stutter: 0, stutterDiv: 0.25, bpm: 120 };

  /**
   * Vitesse du tape stop. c = 0 : décroissance linéaire (platine qu'on freine) ;
   * c > 0 : la vitesse tient puis plonge (bande qui s'arrête) ; c < 0 : chute
   * rapide puis longue traîne.
   */
  const curve = (u: number, c: number) => {
    const x = Math.max(0, Math.min(1, u));
    const cc = Math.max(-1, Math.min(1, c || 0));
    if (cc >= 0) return 1 - Math.pow(x, 1 + 3 * cc);
    return Math.pow(1 - x, 1 + 3 * -cc);
  };
  /** Gain de sortie selon la vitesse : s'éteint en douceur près de l'arrêt (pas de « bosse » continue). */
  const ampOf = (speed: number) => { const x = Math.min(1, Math.max(0, speed / 0.12)); return x * x * (3 - 2 * x); };

  let n = 0;                 // index du dernier échantillon écrit + 1
  let mode = 'live';         // live | stopping | stopped | starting | half | stutter
  let p = 0;                 // tête de lecture (index d'entrée, décimal)
  let speed = 1;
  let u = 0, durS = 1, s0 = 1;
  let c0 = 0, cycle = 1;     // half-time
  let st0 = 0, sliceLen = 1; // stutter
  let xfP = 0, xfSpeed = 0, xfAmp = 0, xfLeft = 0;

  const beat = () => 60 / Math.max(20, Math.min(400, P.bpm || 120)) * sr;

  const read = (buf: Float32Array, x: number) => {
    // Jamais au-delà du dernier échantillon écrit (n − 1).
    const last = n - 1;
    if (x >= last) return buf[last & MASK];
    const i = Math.floor(x), t = x - i;
    const y0 = buf[(i - 1) & MASK], y1 = buf[i & MASK], y2 = buf[(i + 1) & MASK];
    const y3 = i + 2 <= last ? buf[(i + 2) & MASK] : y2;
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  };

  /** Saut de la tête : l'ancienne continue et s'efface pendant XF échantillons. */
  const jump = (newP: number, newSpeed: number) => {
    xfP = p; xfSpeed = speed; xfAmp = ampOf(speed) * (mode === 'stopped' ? 0 : 1); xfLeft = XF;
    p = newP; speed = newSpeed;
  };

  const wanted = () => (P.stop >= 0.5 ? 'stop' : P.stutter >= 0.5 ? 'stutter' : P.half >= 0.5 ? 'half' : 'live');

  /** Transitions, évaluées au début de chaque bloc (les réglages arrivent entre deux blocs). */
  const transitions = () => {
    const w = wanted();
    const isStopFamily = mode === 'stopping' || mode === 'stopped';
    if (w === 'stop') {
      if (!isStopFamily) {
        s0 = mode === 'starting' ? speed : mode === 'half' ? 0.5 : 1;
        if (mode === 'half') s0 = 0.5;
        u = 0; durS = Math.max(1, (P.stopBeats > 0 ? P.stopBeats : 1) * beat());
        if (mode === 'live') p = n - 1;
        mode = 'stopping';
      }
      return;
    }
    if (isStopFamily) {
      // Relâché : redémarrage calé sur le temps réel, ou retour immédiat.
      const S = Math.max(0, P.startBeats || 0) * beat();
      if (S >= 64) {
        jump(n - 1 - S / 2, 0);
        mode = 'starting'; u = 0; durS = S;
      } else {
        jump(n - 1, 1); mode = 'live';
      }
      return;
    }
    if (mode === 'starting') return;            // le redémarrage va au bout
    if (w === 'stutter' && mode !== 'stutter') {
      sliceLen = Math.max(32, (P.stutterDiv > 0 ? P.stutterDiv : 0.25) * beat());
      if (mode !== 'live') jump(n - 1, 1);
      st0 = n - 1; mode = 'stutter';
      return;
    }
    if (w === 'half' && mode !== 'half') {
      cycle = Math.max(256, (P.halfBeats > 0 ? P.halfBeats : 4) * beat());
      if (mode !== 'live') jump(n - 1, 0.5); else { p = n - 1; speed = 0.5; }
      c0 = n - 1; mode = 'half';
      return;
    }
    if (w === 'live' && mode !== 'live') { jump(n - 1, 1); mode = 'live'; }
  };

  const process = (iL: Float32Array, iR: Float32Array | null, oL: Float32Array, oR: Float32Array | null, len: number) => {
    transitions();
    for (let j = 0; j < len; j++) {
      const l = iL[j], r = iR ? iR[j] : l;
      bufL[n & MASK] = l; bufR[n & MASK] = r;
      n++;
      const now = n - 1;
      let yl = 0, yr = 0;
      if (mode === 'live') {
        p = now; speed = 1; yl = l; yr = r;
      } else if (mode === 'stopping') {
        u += 1 / durS;
        speed = s0 * curve(u, P.stopCurve);
        if (u >= 1) { speed = 0; mode = 'stopped'; }
        p += speed;
        const a = ampOf(speed);
        yl = a * read(bufL, p); yr = a * read(bufR, p);
      } else if (mode === 'stopped') {
        speed = 0;
      } else if (mode === 'starting') {
        u += 1 / durS;
        speed = Math.min(1, u);
        p += speed;
        if (u >= 1) { mode = 'live'; speed = 1; if (Math.abs(p - now) > 0.5) jump(now, 1); p = now; yl = l; yr = r; }
        else { const a = ampOf(speed); yl = a * read(bufL, p); yr = a * read(bufR, p); }
      } else if (mode === 'half') {
        if (now - c0 >= cycle) { c0 += cycle; jump(now, 0.5); }
        p = c0 + (now - c0) * 0.5; speed = 0.5;
        yl = read(bufL, p); yr = read(bufR, p);
      } else if (mode === 'stutter') {
        const k = (now - st0) % sliceLen;
        if (k < 1 && now > st0) jump(st0, 1);
        p = st0 + k; speed = 1;
        yl = read(bufL, p); yr = read(bufR, p);
      }
      if (xfLeft > 0) {
        const g = xfLeft / XF;
        xfP += xfSpeed;
        const ol = xfAmp * read(bufL, xfP), or = xfAmp * read(bufR, xfP);
        yl = yl * (1 - g) + ol * g; yr = yr * (1 - g) + or * g;
        xfLeft--;
      }
      oL[j] = yl;
      if (oR) oR[j] = yr;
    }
  };

  return {
    setParams: (q) => { P = { ...P, ...q }; },
    process,
    state: () => ({ speed, mode }),
    curve,
    reset: () => { bufL.fill(0); bufR.fill(0); n = 0; mode = 'live'; p = 0; speed = 1; xfLeft = 0; },
  };
}
