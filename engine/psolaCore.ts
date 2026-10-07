/**
 * Cœur DSP « voix » de NOVA (V21) : détection de hauteur + transposition
 * PSOLA (Pitch-Synchronous Overlap-Add), en JavaScript pur.
 *
 * Il sert à l'Harmoniseur (1 à 4 voix dans la gamme, comme les harmonies du
 * Vocal Transformer de Logic ou le Pitcher de FL Studio) et à « Voix grave /
 * aiguë » (hauteur et formant séparés). Comme limiterCore.ts, la fonction est
 * sérialisée par `toString()` dans l'AudioWorklet : elle ne référence RIEN en
 * dehors d'elle-même (les calculs de gamme arrivent en paramètre, depuis
 * `createHarmonyMath`, lui aussi autonome). Même code en lecture, à l'export
 * (OfflineAudioContext) et dans les tests vitest.
 *
 * Principe :
 *  1. hauteur : YIN sur le signal sous-échantillonné (~12 kHz), affinée à
 *     pleine résolution (différence minimale + interpolation parabolique) ;
 *  2. marques d'analyse espacées d'une période T (voisé) ou de 5 ms (souffle,
 *     consonnes, silence) ;
 *  3. chaque voix pose des grains (2 périodes, fenêtre de Hann) espacés de
 *     T / r : la hauteur est multipliée par r ; le contenu de chaque grain
 *     garde l'enveloppe spectrale de la voix (formants préservés) ;
 *  4. formant : le grain est relu f fois plus vite (f > 1 : voix plus fine,
 *     f < 1 : plus grosse), sans changer l'espacement, donc sans changer la
 *     hauteur ;
 *  5. latence FIXE `latencySamples()` (≈ 57 ms), déclarée au PDC : le sec est
 *     retardé d'autant, et une voix non transposée retombe exactement dessus.
 */

export interface PsolaVoiceParams {
  on: boolean;
  /** Transposition fixe en demi-tons (utilisée si `degree` est null). */
  semis: number;
  /** Intervalle en degrés de la gamme (+2 = tierce au-dessus, −7 = octave en dessous), ou null. */
  degree: number | null;
  /** Formant en demi-tons (0 = formants préservés). */
  formant: number;
  /** Vrai : le formant suit la hauteur (effet « chipmunk », formants NON préservés). */
  follow: boolean;
  /** Gains de sortie gauche / droite (linéaires, panoramique déjà appliqué). */
  gainL: number;
  gainR: number;
  /** Retard d'humanisation (ms). */
  delayMs: number;
  /** Désaccord fixe (cents). */
  detune: number;
  /** Amplitude de la dérive lente de justesse (cents). */
  drift: number;
}

export interface PsolaCoreParams {
  voices: Partial<PsolaVoiceParams>[];
  /** Tonique (0 = Do … 11 = Si). */
  root: number;
  /** Intervalles de la gamme depuis la tonique (ex. [0,2,3,5,7,8,10]). */
  scale: number[];
  /** Gain du signal sec (retardé de la latence). */
  dry: number;
  /** Vrai : chaque canal est transposé séparément (stéréo) ; faux : voix en mono puis panoramique. */
  stereo: boolean;
}

export interface PsolaCore {
  setParams(p: Partial<PsolaCoreParams>): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  latencySamples(): number;
  /** Dernière hauteur détectée (note MIDI décimale, 0 = rien de chanté) et note retenue. */
  pitch(): { midi: number; note: number };
  /** Échantillons de grains arrivés trop tard (doit rester 0 : sinon la latence est trop courte). */
  lateSamples(): number;
  reset(): void;
}

/** Calculs de gamme pour l'harmoniseur (autonome : sérialisé dans l'AudioWorklet). */
export function createHarmonyMath() {
  const mod12 = (n: number) => ((n % 12) + 12) % 12;
  /** Hauteurs (0-11) de la gamme, triées. */
  const pitchClasses = (root: number, scale: number[]) => {
    const out: number[] = [];
    const src = scale && scale.length ? scale : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (let i = 0; i < src.length; i++) { const pc = mod12(Math.round(root) + src[i]); if (out.indexOf(pc) < 0) out.push(pc); }
    out.sort((a, b) => a - b);
    return out;
  };
  const inScale = (note: number, pcs: number[]) => pcs.indexOf(mod12(note)) >= 0;
  /** Note de la gamme la plus proche (à égale distance : vers le bas). */
  const snap = (note: number, pcs: number[]) => {
    const n = Math.round(note);
    if (inScale(n, pcs)) return n;
    for (let d = 1; d <= 12; d++) {
      if (inScale(n - d, pcs)) return n - d;
      if (inScale(n + d, pcs)) return n + d;
    }
    return n;
  };
  /** Intervalle « nominal » en demi-tons d'un degré (gammes qui n'ont pas 7 notes). */
  const NOMINAL = [0, 2, 3.5, 5, 7, 8.5, 10.5];
  const CHROMATIC_DEG = [0, 2, 4, 5, 7, 9, 11];
  /**
   * Transposition (demi-tons entiers) qui mène la note chantée au degré voulu
   * de la gamme. La note chantée est d'abord ramenée sur la gamme (une note
   * légèrement fausse garde sa justesse relative : l'harmonie la suit).
   *  - gamme à 7 notes (majeur, mineur, dorien…) : vrais degrés (une tierce
   *    au-dessus de La en Do majeur = Do, +3 ; au-dessus de Do = Mi, +4) ;
   *  - chromatique (tonalité inconnue) : intervalles majeurs fixes ;
   *  - pentatonique, blues : note de la gamme la plus proche de l'intervalle.
   * L'octave (7 degrés) vaut toujours 12 demi-tons.
   */
  const shiftFor = (note: number, root: number, scale: number[], degree: number): number => {
    const deg = Math.round(degree);
    if (!deg) return 0;
    const pcs = pitchClasses(root, scale);
    const base = snap(note, pcs);
    const sign = deg < 0 ? -1 : 1;
    const oct = Math.trunc(Math.abs(deg) / 7);
    const rem = Math.abs(deg) % 7;
    let semis = 0;
    if (rem) {
      if (pcs.length === 7) {
        // Échelle de la gamme : on monte (ou descend) de `rem` notes.
        let n = base, steps = 0;
        while (steps < rem) { n += sign; if (inScale(n, pcs)) steps++; }
        semis = Math.abs(n - base);
      } else if (pcs.length >= 12) {
        semis = CHROMATIC_DEG[rem];
      } else {
        const want = base + sign * NOMINAL[rem];
        let best = base, bestD = 1e9;
        for (let c = base - 13; c <= base + 13; c++) {
          if (c === base || !inScale(c, pcs) || Math.sign(c - base) !== sign) continue;
          const d = Math.abs(c - want);
          if (d < bestD - 1e-9 || (Math.abs(d - bestD) < 1e-9 && Math.abs(c - base) < Math.abs(best - base))) { best = c; bestD = d; }
        }
        semis = Math.abs(best - base);
      }
    }
    // Décalage depuis la note chantée : la voix d'harmonie tombe toujours dans la gamme.
    return base + sign * (semis + 12 * oct) - Math.round(note);
  };
  return { shiftFor, snap, pitchClasses, inScale };
}

export type HarmonyMath = ReturnType<typeof createHarmonyMath>;

export function createPsolaCore(sampleRate: number, math: { shiftFor: (note: number, root: number, scale: number[], degree: number) => number }): PsolaCore {
  const sr = sampleRate;
  // --- Constantes de détection -------------------------------------------------
  const F0_MIN = 70, F0_MAX = 1000;
  const FORMANT_MIN = 0.5, FORMANT_MAX = 2;   // ±12 demi-tons
  const MAX_HUMAN_MS = 30;
  const D = Math.max(1, Math.floor(sr / 12000));        // sous-échantillonnage de l'analyse
  const srd = sr / D;
  const TAU_MAX = Math.ceil(srd / F0_MIN);
  const TAU_MIN = Math.max(2, Math.floor(srd / F0_MAX));
  const W = TAU_MAX;                                     // fenêtre d'intégration YIN
  const M = W + TAU_MAX + 2;                             // trame d'analyse (sous-échantillonnée)
  const HOP = 64;                                        // une analyse toutes les 64 × D échantillons
  const TMAX = Math.ceil(sr / F0_MIN);
  const TU = Math.max(32, Math.round(sr * 0.005));       // pas des marques non voisées (5 ms)
  const LAG = Math.max(Math.ceil(M * D / 2) + HOP * D + 8, TMAX + 16);
  const LAT = LAG + Math.ceil(TMAX / 2) + Math.ceil(TMAX / FORMANT_MIN) + 64;
  const SILENCE = Math.pow(10, -55 / 20);
  const YIN_THR = 0.15;

  const pow2 = (x: number) => { let p = 1; while (p < x) p <<= 1; return p; };
  const N = pow2(4 * (LAT + Math.ceil(TMAX / FORMANT_MIN) * 2 + Math.ceil(sr * MAX_HUMAN_MS / 1000)) + 4096);
  const MASK = N - 1;
  const ND = pow2(M * 4);
  const MASKD = ND - 1;

  // Anneaux d'entrée (gauche, droite, mono) et de sortie (accumulateurs).
  const inL = new Float32Array(N), inR = new Float32Array(N), inM = new Float32Array(N);
  const accL = new Float32Array(N), accR = new Float32Array(N);
  const dec = new Float32Array(ND);
  const yinD = new Float64Array(TAU_MAX + 2);
  const dvBuf = new Float64Array(4 * D + 8);

  // Fenêtre de Hann tabulée (centrée, u ∈ [−1, 1]).
  const HANN_N = 2048;
  const hann = new Float32Array(HANN_N + 2);
  for (let i = 0; i <= HANN_N + 1; i++) { const u = Math.min(1, i / HANN_N); hann[i] = 0.5 + 0.5 * Math.cos(Math.PI * u); }

  // Filtre anti-repliement de l'analyse : Butterworth ordre 4 (deux biquads).
  const lpCoefs = (fc: number, q: number) => {
    const w = 2 * Math.PI * fc / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    const a0 = 1 + a;
    return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0 };
  };
  const fcDec = 0.4 * srd;
  const bq1 = lpCoefs(Math.min(fcDec, sr * 0.45), 0.5412), bq2 = lpCoefs(Math.min(fcDec, sr * 0.45), 1.3066);
  let z11 = 0, z12 = 0, z21 = 0, z22 = 0;

  // Trames d'analyse.
  const FR = 64;
  const frC = new Float64Array(FR), frT = new Float64Array(FR), frMidi = new Float64Array(FR);
  let frCount = 0, frCursor = 0;

  // Marques d'analyse.
  const MK = 1024;
  const mkPos = new Float64Array(MK), mkT = new Float64Array(MK), mkMidi = new Float64Array(MK), mkNote = new Float64Array(MK);
  const mkVoiced = new Uint8Array(MK);
  let mkCount = 0;

  // Voix.
  const MAXV = 4;
  const vS = new Float64Array(MAXV), vK = new Float64Array(MAXV), vStarted = new Uint8Array(MAXV);
  const vLastR = new Float64Array(MAXV);

  let nIn = 0;          // échantillons d'entrée reçus
  let nDec = 0;         // échantillons sous-échantillonnés
  let lastFrameDec = 0; // nDec de la dernière analyse
  let heldNote = -1;
  let lastMidi = 0;
  let late = 0;

  let P: PsolaCoreParams = { voices: [], root: 0, scale: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], dry: 1, stereo: false };
  let V: PsolaVoiceParams[] = [];
  const voiceDefaults: PsolaVoiceParams = { on: false, semis: 0, degree: null, formant: 0, follow: false, gainL: 0.707, gainR: 0.707, delayMs: 0, detune: 0, drift: 0 };

  const ringAt = (buf: Float32Array, x: number) => {
    // Interpolation d'Hermite à 4 points.
    const i = Math.floor(x), t = x - i;
    const y0 = buf[(i - 1) & MASK], y1 = buf[i & MASK], y2 = buf[(i + 1) & MASK], y3 = buf[(i + 2) & MASK];
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  };

  /** Analyse YIN de la dernière trame ; pousse (centre, période, note). */
  const analyse = () => {
    const e = nDec;
    if (e < M) return;
    const s0 = e - M;
    // Énergie de la trame.
    let en = 0;
    for (let j = 0; j < W + TAU_MAX; j++) { const x = dec[(s0 + j) & MASKD]; en += x * x; }
    const rms = Math.sqrt(en / (W + TAU_MAX));
    let T = 0;
    if (rms > SILENCE) {
      // Fonction de différence et moyenne cumulée normalisée (YIN).
      let run = 0;
      let found = -1;
      yinD[0] = 1;
      for (let tau = 1; tau <= TAU_MAX; tau++) {
        let d = 0;
        for (let j = 0; j < W; j++) { const a = dec[(s0 + j) & MASKD] - dec[(s0 + j + tau) & MASKD]; d += a * a; }
        run += d;
        yinD[tau] = run > 0 ? d * tau / run : 1;
      }
      for (let tau = TAU_MIN; tau < TAU_MAX; tau++) {
        if (yinD[tau] < YIN_THR) {
          while (tau + 1 < TAU_MAX && yinD[tau + 1] < yinD[tau]) tau++;
          found = tau; break;
        }
      }
      if (found > 0) {
        const a = yinD[found - 1], b = yinD[found], c = yinD[found + 1];
        const den = a - 2 * b + c;
        const frac = den > 1e-12 ? 0.5 * (a - c) / den : 0;
        const t0 = (found + Math.max(-0.5, Math.min(0.5, frac))) * D;
        // Affinage à pleine résolution, sur la même trame.
        const f0 = s0 * D, Wf = W * D;
        const lo = Math.max(2, Math.floor(t0) - D), hi = Math.min(TMAX + D, Math.ceil(t0) + D);
        let best = -1, bestV = Infinity;
        const dv = dvBuf;
        for (let tau = lo; tau <= hi; tau++) {
          let d = 0;
          for (let j = 0; j < Wf; j++) { const x = inM[(f0 + j) & MASK] - inM[(f0 + j + tau) & MASK]; d += x * x; }
          dv[tau - lo] = d;
          if (d < bestV) { bestV = d; best = tau; }
        }
        if (best > lo && best < hi) {
          const a2 = dv[best - 1 - lo], b2 = dv[best - lo], c2 = dv[best + 1 - lo];
          const den2 = a2 - 2 * b2 + c2;
          T = best + (den2 > 1e-20 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a2 - c2) / den2)) : 0);
        } else T = t0;
      }
    }
    const k = frCount % FR;
    frC[k] = (e - M / 2) * D;
    frT[k] = T;
    frMidi[k] = T > 0 ? 69 + 12 * Math.log2(sr / T / 440) : 0;
    frCount++;
    lastMidi = frMidi[k];
  };

  /** Trame dont le centre est le plus proche de p. */
  const frameAt = (p: number) => {
    if (frCursor < frCount - FR) frCursor = frCount - FR;
    if (frCursor < 0) frCursor = 0;
    while (frCursor + 1 < frCount && Math.abs(frC[(frCursor + 1) % FR] - p) <= Math.abs(frC[frCursor % FR] - p)) frCursor++;
    return frCursor % FR;
  };

  const pushMark = (p: number) => {
    const f = frameAt(p);
    const T = frT[f];
    const k = mkCount % MK;
    mkPos[k] = p;
    if (T > 0) {
      const midi = frMidi[f];
      // Hystérésis : la note retenue ne change que si la voix s'en éloigne nettement.
      if (heldNote < 0 || Math.abs(midi - heldNote) > 0.65) heldNote = Math.round(midi);
      mkT[k] = T; mkVoiced[k] = 1; mkMidi[k] = midi; mkNote[k] = heldNote;
    } else {
      mkT[k] = TU; mkVoiced[k] = 0; mkMidi[k] = 0; mkNote[k] = heldNote;
    }
    mkCount++;
  };

  const makeMarks = () => {
    if (!frCount) return;
    const cLatest = frC[(frCount - 1) % FR];
    if (!mkCount) { pushMark(Math.max(TMAX + 4, frC[0])); }
    for (let guard = 0; guard < 4096; guard++) {
      const last = (mkCount - 1) % MK;
      const p = mkPos[last] + mkT[last];
      if (p > cLatest) break;
      pushMark(p);
    }
  };

  const addGrain = (a: number, T: number, s: number, f: number, gL: number, gR: number, stereo: boolean, nOut: number) => {
    const half = T / f;
    const m0 = Math.ceil(s - half), m1 = Math.floor(s + half);
    const scale = HANN_N / T;
    for (let m = m0; m <= m1; m++) {
      const u = (m - s) * f;
      const au = Math.abs(u) * scale;
      if (au >= HANN_N) continue;
      if (m < nOut) { late++; continue; }
      const ai = au | 0, at = au - ai;
      const w = hann[ai] + (hann[ai + 1] - hann[ai]) * at;
      const x = a + u;
      if (stereo) {
        accL[m & MASK] += gL * w * ringAt(inL, x);
        accR[m & MASK] += gR * w * ringAt(inR, x);
      } else {
        const y = w * ringAt(inM, x);
        accL[m & MASK] += gL * y;
        accR[m & MASK] += gR * y;
      }
    }
  };

  const synthVoices = (nOut: number) => {
    if (!mkCount) return;
    const first = Math.max(0, mkCount - MK + 8);
    for (let v = 0; v < V.length && v < MAXV; v++) {
      const vp = V[v];
      if (!vp.on || (vp.gainL === 0 && vp.gainR === 0)) continue;
      const dly = Math.max(0, Math.min(MAX_HUMAN_MS, vp.delayMs)) * sr / 1000;
      // Voix qui démarre : elle part de la marque la plus récente (rien d'ancien à rattraper).
      if (!vStarted[v]) { vStarted[v] = 1; vK[v] = mkCount - 1; vS[v] = mkPos[(mkCount - 1) % MK] + LAT + dly; }
      for (let guard = 0; guard < 4096; guard++) {
        const target = vS[v] - LAT - dly;
        let k = vK[v];
        if (k < first) k = first;
        while (k + 1 < mkCount && Math.abs(mkPos[(k + 1) % MK] - target) <= Math.abs(mkPos[k % MK] - target)) k++;
        vK[v] = k;
        const i = k % MK;
        const a = mkPos[i], T = mkT[i];
        if (k === mkCount - 1 && target > a + T * 0.5) break;     // la marque suivante n'est pas encore connue
        let r = 1;
        const voiced = mkVoiced[i] === 1;
        const tSec = vS[v] / sr;
        if (voiced) {
          let semis = vp.semis;
          if (vp.degree !== null && vp.degree !== undefined && Number.isFinite(vp.degree)) semis = math.shiftFor(mkNote[i], P.root, P.scale, vp.degree);
          const drift = vp.drift ? vp.drift * (0.6 * Math.sin(2 * Math.PI * 0.37 * tSec + v * 1.7) + 0.4 * Math.sin(2 * Math.PI * 0.83 * tSec + v * 2.9)) : 0;
          r = Math.pow(2, (semis + (vp.detune + drift) / 100) / 12);
          vLastR[v] = r;
        }
        const rf = vp.follow ? (voiced ? r : (vLastR[v] || Math.pow(2, vp.semis / 12))) : 1;
        let f = rf * Math.pow(2, vp.formant / 12);
        f = Math.max(FORMANT_MIN, Math.min(FORMANT_MAX, f));
        const g = Math.sqrt(f / r);
        addGrain(a, T, vS[v], f, vp.gainL * g, vp.gainR * g, P.stereo, nOut);
        if (voiced && Math.abs(r - 1) > 1e-9) vS[v] += T / r;
        else vS[v] = a + LAT + dly + T;   // recalage exact sur les marques (latence exacte)
      }
    }
  };

  const process = (iL: Float32Array, iR: Float32Array | null, oL: Float32Array, oR: Float32Array | null, n: number) => {
    const nOut = nIn;
    for (let j = 0; j < n; j++) {
      const l = iL[j];
      const r = iR ? iR[j] : l;
      const idx = (nIn + j) & MASK;
      inL[idx] = l; inR[idx] = r;
      const m = 0.5 * (l + r);
      inM[idx] = m;
      // Filtre + sous-échantillonnage pour l'analyse.
      const y1 = bq1.b0 * m + z11; z11 = bq1.b1 * m - bq1.a1 * y1 + z12; z12 = bq1.b2 * m - bq1.a2 * y1;
      const y2 = bq2.b0 * y1 + z21; z21 = bq2.b1 * y1 - bq2.a1 * y2 + z22; z22 = bq2.b2 * y1 - bq2.a2 * y2;
      if ((nIn + j) % D === 0) {
        dec[nDec & MASKD] = y2;
        nDec++;
        // L'affinage relit le signal plein débit : la trame s'arrête D échantillons avant celui-ci (déjà écrit).
        if (nDec - lastFrameDec >= HOP) { analyse(); lastFrameDec = nDec; }
      }
    }
    nIn += n;
    makeMarks();
    synthVoices(nOut);
    const dry = P.dry;
    for (let j = 0; j < n; j++) {
      const o = (nOut + j) & MASK;
      const d = (nOut + j - LAT) & MASK;
      const dl = nOut + j - LAT >= 0 ? inL[d] : 0;
      const dr = nOut + j - LAT >= 0 ? inR[d] : 0;
      oL[j] = accL[o] + dry * dl;
      if (oR) oR[j] = accR[o] + dry * dr;
      accL[o] = 0; accR[o] = 0;
    }
  };

  const setParams = (p: Partial<PsolaCoreParams>) => {
    P = { ...P, ...p };
    if (p.voices) {
      V = p.voices.slice(0, MAXV).map((v, i) => {
        const prev = V[i];
        const nv = { ...voiceDefaults, ...(prev || {}), ...v };
        // Voix (re)mise en marche : elle repart des marques courantes.
        if (!nv.on || (prev && !prev.on)) vStarted[i] = 0;
        return nv;
      });
      for (let i = V.length; i < MAXV; i++) vStarted[i] = 0;
    }
  };

  const reset = () => {
    inL.fill(0); inR.fill(0); inM.fill(0); accL.fill(0); accR.fill(0); dec.fill(0);
    nIn = 0; nDec = 0; lastFrameDec = 0; frCount = 0; frCursor = 0; mkCount = 0; heldNote = -1; lastMidi = 0; late = 0;
    z11 = z12 = z21 = z22 = 0;
    vStarted.fill(0); vLastR.fill(0);
  };

  return {
    setParams,
    process,
    latencySamples: () => LAT,
    pitch: () => ({ midi: lastMidi, note: lastMidi > 0 ? heldNote : 0 }),
    lateSamples: () => late,
    reset,
  };
}

const latencyCache = new Map<number, number>();
/** Latence (échantillons) du cœur PSOLA à cette fréquence d'échantillonnage (calculée une fois). */
export function psolaLatencySamples(sampleRate: number): number {
  let l = latencyCache.get(sampleRate);
  if (l === undefined) { l = createPsolaCore(sampleRate, createHarmonyMath()).latencySamples(); latencyCache.set(sampleRate, l); }
  return l;
}
