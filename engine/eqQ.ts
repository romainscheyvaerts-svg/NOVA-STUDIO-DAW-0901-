/**
 * Q des bandes de l'égaliseur 12 bandes : convention « v2 » (métrologie du 22/10/2026).
 *
 * Mesures avant correction (banc tests/metrologieEQ.test.ts, rapport nova-metrologie) :
 *  - coupe-bas / coupe-haut : le Q affiché (« Q 1,00 ») était passé tel quel au filtre du
 *    navigateur, qui le lit en DÉCIBELS de résonance. Un coupe-bas « 200 Hz, Q 1 » coupait à
 *    −3 dB à 150 Hz avec une bosse de +2 dB vers 260 Hz ; le coupe-haut « 18 kHz » à 19 kHz.
 *    Le réglage plat (Butterworth) était impossible à obtenir (bouton de 0,1 à 10 dB) ;
 *  - cloches et encoches : la largeur suivait la formule du navigateur sans compensation de la
 *    transformation bilinéaire : une cloche « Q 1 » à 10 kHz mesurait Q 1,48 (44,1 kHz), à
 *    16 kHz Q 3,0 (trois fois plus étroite qu'affiché).
 *
 * Convention v2 (affiché = mesuré) :
 *  - coupe-bas / coupe-haut : Q LINÉAIRE (gain au point de coupure = Q). Q 0,71 (Butterworth,
 *    valeur par défaut) = −3 dB pile à la fréquence affichée, aucune bosse, 12 dB/octave ;
 *    Q 1 = 0 dB à la fréquence (+1,25 dB de bosse) ; Q 2 = +6 dB.
 *  - cloche : Q = largeur entre les points à mi-gain (en dB) ; encoche : largeur à −3 dB.
 *    La largeur est compensée (transformation bilinéaire inversée exactement, voir eqDigitalQ) :
 *    mesurée = affichée (< 0,1 %) tant que la cloche tient sous 0,75 × Nyquist (son bord haut à
 *    mi-gain). Plus haut, un filtre du 2e ordre ne peut pas suivre une cloche qui dépasse
 *    Nyquist : c'est alors le bord BAS (la partie audible) qui est exact, et l'écran dessine la
 *    vraie courbe (jamais une promesse).
 *  - étagères : pente fixe (S = 1, la plus raide sans bosse), le Q n'a pas d'effet (filtres
 *    du navigateur) : la fenêtre ne l'affiche plus.
 *
 * Anciens projets (réglages sans `qVersion: 2`) : traduits UNE fois à l'ouverture,
 *  - coupe-bas / coupe-haut à Q ≤ 1 (réglage d'usine 1, préréglages 0,7 / 0,71 : tous voulaient
 *    une coupe simple) → Butterworth (0,7071) : CORRECTION, le son change (la coupure tombe
 *    enfin à la fréquence affichée) ;
 *  - coupe-bas / coupe-haut à Q > 1 (résonance choisie à l'oreille) → 10^(Q/20) : même son
 *    au bit près, la fenêtre affiche enfin le vrai Q ;
 *  - cloches / encoches → Q équivalent : même son au bit près (à la fréquence d'échantillonnage
 *    du contexte), la fenêtre affiche la vraie largeur.
 *
 * Ce module est pur (aucun nœud audio). engine/eqLinearCore.ts recopie `eqDigitalQ` (il est
 * sérialisé dans l'AudioWorklet) : le test de métrologie vérifie que les deux sont identiques.
 */

export const EQ_Q_VERSION = 2;
/** Q de Butterworth (réponse la plus plate) : −3 dB pile à la fréquence de coupure. */
export const BUTTERWORTH_Q = Math.SQRT1_2;

export type EqBandType = 'peaking' | 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'notch' | string;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const isPassType = (t: EqBandType) => t === 'highpass' || t === 'lowpass';
export const isBellType = (t: EqBandType) => t === 'peaking' || t === 'notch';
export const isShelfType = (t: EqBandType) => t === 'lowshelf' || t === 'highshelf';

/** Fréquence effectivement utilisée (mêmes bornes que le moteur). */
export const eqFreq = (f: number, sr: number) => clamp(Number.isFinite(f) ? f : 1000, 10, sr * 0.495);
export const eqQ = (q: number) => clamp(Number.isFinite(q) ? q : 1, 0.0001, 1000);

/**
 * Q « numérique » d'une cloche ou d'une encoche (v2) : le Q à donner aux formules du navigateur
 * pour que la largeur MESURÉE soit `q`.
 *
 * Une cloche (ou encoche) du Web Audio est la transformée bilinéaire d'un prototype analogique
 * dont les bords à mi-gain Ωb < 1 < Ωh vérifient Ωb·Ωh = 1 et Ωh − Ωb = 1/Q ; ses bords numériques
 * sont fb = fe/π·atan(Ωb·t0), fh = fe/π·atan(t0/Ωb) avec t0 = tan(π·f0/fe). On choisit Ωb :
 *  - cloche qui tient sous 0,75 × Nyquist (bord haut analogique f0/ωb) : largeur EXACTE,
 *    log2(fh/fb) = largeur voulue (Newton gardé, < 1e-12) ;
 *  - cloche qui dépasse Nyquist : bord BAS exact (fb = f0·ωb, la partie audible de la cloche ne
 *    s'élargit pas ; le haut est écrasé contre Nyquist, l'écran le montre) ;
 *  - entre les deux : passage progressif (moyenne géométrique, poids en S).
 */
export function eqDigitalQ(q: number, f: number, sr: number): number {
  const Q = eqQ(q), f0 = eqFreq(f, sr), nyq = sr / 2;
  const t0 = Math.tan((Math.PI * f0) / sr);
  const ob = Math.sqrt(1 + 1 / (4 * Q * Q)) - 1 / (2 * Q);
  const fh = f0 / ob;
  const qOf = (u: number) => u / (1 - u * u);
  const uLow = Math.tan((Math.PI * f0 * ob) / sr) / t0;
  if (fh >= nyq) return qOf(uLow);
  const target = 2 * Math.asinh(1 / (2 * Q));
  let lo = 1e-15, hi = 1 - 1e-15, u = ob;
  for (let it = 0; it < 80; it++) {
    const A1 = Math.atan(t0 / u), A2 = Math.atan(u * t0);
    const g = Math.log(A1) - Math.log(A2) - target;
    if (Math.abs(g) < 1e-13) break;
    if (g > 0) lo = u; else hi = u;
    const d = -t0 / ((u * u + t0 * t0) * A1) - t0 / ((1 + u * u * t0 * t0) * A2);
    let nu = u - g / d;
    if (!(nu > lo && nu < hi)) nu = 0.5 * (lo + hi);
    u = nu;
  }
  const qEx = qOf(u);
  if (fh <= 0.75 * nyq) return qEx;
  const t = clamp((nyq - fh) / (0.25 * nyq), 0, 1);
  const w = t * t * (3 - 2 * t);
  return Math.exp(w * Math.log(qEx) + (1 - w) * Math.log(qOf(uLow)));
}

/** Valeur à poser sur `BiquadFilterNode.Q` (v2) pour une bande de type `type`. */
export function eqNativeQ(type: EqBandType, q: number, f: number, sr: number): number {
  if (isPassType(type)) return 20 * Math.log10(eqQ(q));
  if (isBellType(type)) return eqDigitalQ(q, f, sr);
  return eqQ(q);
}

/** Coefficients normalisés [b0, b1, b2, a1, a2] d'une bande (v2), formules du Web Audio. */
export function eqBandCoefs(type: EqBandType, f: number, gain: number, q: number, sr: number): number[] {
  const f0 = eqFreq(f, sr);
  const w0 = (2 * Math.PI * f0) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, (Number.isFinite(gain) ? gain : 0) / 40);
  const Qn = eqNativeQ(type, q, f, sr);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (isPassType(type)) {
    const al = sw / (2 * Math.pow(10, Qn / 20));
    const lp = type === 'lowpass';
    b0 = lp ? (1 - cw) / 2 : (1 + cw) / 2; b1 = lp ? 1 - cw : -(1 + cw); b2 = b0;
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else if (type === 'notch') {
    const al = sw / (2 * Qn); b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else if (isShelfType(type)) {
    const al = (sw / 2) * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
      a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
      a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
    }
  } else {
    const al = sw / (2 * Qn); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Module (dB) de coefficients normalisés à la fréquence f. */
export function coefsDb(c: ArrayLike<number>, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
  const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
}

/** Réponse (dB) d'une bande (v2) à la fréquence f : la courbe que la fenêtre dessine. */
export function eqBandDb(b: { type?: string; frequency?: number; gain?: number; q?: number }, f: number, sr: number): number {
  return coefsDb(eqBandCoefs(b.type || 'peaking', b.frequency ?? 1000, b.gain ?? 0, b.q ?? 1, sr), f, sr);
}

/**
 * Fréquence à −3 dB d'un coupe-bas / coupe-haut (v2), mesurée sur sa courbe (dichotomie) :
 * = la fréquence affichée à Q 0,71, ailleurs à un Q plus résonant.
 */
export function eqPassMinus3Hz(type: EqBandType, f: number, q: number, sr: number): number {
  const c = eqBandCoefs(type, f, 0, q, sr);
  const fn = (x: number) => coefsDb(c, x, sr) + 3.0103;
  const f0 = eqFreq(f, sr), top = sr * 0.4999;
  // Coupe-bas : la courbe monte de −∞ vers 0 ; on cherche le DERNIER passage sous −3 dB en partant du grave.
  let lo = type === 'highpass' ? 1 : f0 / 64, hi = type === 'highpass' ? Math.min(top, f0 * 64) : top;
  if (type === 'highpass') { if (fn(lo) > 0) return lo; } else if (fn(hi) > 0) return hi;
  for (let i = 0; i < 80; i++) {
    const m = Math.sqrt(lo * hi);
    const below = fn(m) < 0;
    if (type === 'highpass') { if (below) lo = m; else hi = m; } else { if (below) hi = m; else lo = m; }
  }
  return Math.sqrt(lo * hi);
}

/** Q v2 d'une cloche / encoche dont le Q « navigateur » (ancien réglage) était `qOld`. */
function invertDigitalQ(qOld: number, f: number, sr: number): number {
  const target = eqQ(qOld);
  let lo = Math.log(0.0001), hi = Math.log(1000);
  if (eqDigitalQ(Math.exp(lo), f, sr) >= target) return Math.exp(lo);
  if (eqDigitalQ(Math.exp(hi), f, sr) <= target) return Math.exp(hi);
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (eqDigitalQ(Math.exp(m), f, sr) < target) lo = m; else hi = m;
  }
  return Math.exp((lo + hi) / 2);
}

/** Traduction d'une bande d'un ancien projet vers la convention v2 (voir l'en-tête). */
export function legacyBandToV2<B extends { type?: string; frequency?: number; q?: number }>(b: B, sr: number): B {
  if (!b || typeof b !== 'object') return b;
  const t = b.type || 'peaking';
  const q = Number(b.q);
  if (!Number.isFinite(q)) return b;
  if (isPassType(t)) return { ...b, q: q <= 1 ? BUTTERWORTH_Q : Math.pow(10, q / 20) };
  if (isBellType(t)) return { ...b, q: invertDigitalQ(q, Number(b.frequency), sr) };
  return b;
}

/**
 * Réglages d'égaliseur en convention v2 : renvoyés tels quels s'ils y sont déjà, sinon traduits
 * (copie, l'objet reçu n'est jamais modifié). `sr` : fréquence d'échantillonnage du contexte.
 */
export function eqParamsV2<T extends { bands?: any[]; qVersion?: number }>(p: T, sr: number): T {
  if (!p || typeof p !== 'object' || (p as any).qVersion === EQ_Q_VERSION) return p;
  if (!Array.isArray(p.bands)) return { ...p, qVersion: EQ_Q_VERSION };
  return { ...p, qVersion: EQ_Q_VERSION, bands: p.bands.map(b => legacyBandToV2(b, sr)) };
}
