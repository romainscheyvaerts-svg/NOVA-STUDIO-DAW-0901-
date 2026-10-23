/**
 * Nova Pitch · carte du temps : où chaque instant du son rendu va chercher le
 * son d'origine, quand on allonge, raccourcit ou déplace des notes.
 *
 * Carte affine par morceaux (points d'ancrage source → rendu, en échantillons) :
 *  - dans une note, l'ATTAQUE [début, s0] et la CHUTE [s1, fin] sont recopiées à
 *    vitesse 1 (décalées en bloc) : consonnes voisées, glissades et attaques
 *    gardent leur durée ; seule la partie tenue [s0, s1] (la voyelle) s'étire ;
 *  - entre deux notes, le blanc (consonnes sourdes « s », « t », souffle,
 *    silence) est recopié à vitesse 1. S'il doit changer de durée, l'écart est
 *    pris dans sa partie la plus calme (silence) ; le reste suit en bloc ;
 *  - les décalages sont arrondis à l'échantillon : hors des notes retouchées,
 *    le son rendu est le son d'origine, aligné à l'échantillon près.
 *
 * Logique pure (worker, tests).
 */

export interface TimeMap {
  /** Ancrages (échantillons) : src strictement croissant, dst strictement croissant. */
  src: Float64Array;
  dst: Float64Array;
}

export interface TimingNote {
  /** Début / fin de la note dans la source (échantillons). */
  start: number;
  end: number;
  /** Partie tenue dans la source (échantillons). */
  s0: number;
  s1: number;
  /** Décalage du début et de la fin (échantillons, entiers). */
  d0: number;
  d1: number;
}

/** Zone calme d'un blanc [a, b[ (échantillons) assez large pour absorber `delta` : [z0, z1[. */
export type QuietFinder = (a: number, b: number, delta: number) => [number, number];

/** Rapport d'étirement minimal de la partie tenue (en deçà, toute la note se resserre). */
export const MIN_SUSTAIN_RATIO = 0.2;

export const identityMap = (n: number): TimeMap => ({ src: Float64Array.from([0, Math.max(1, n)]), dst: Float64Array.from([0, Math.max(1, n)]) });

/** Longueur du son rendu (échantillons). */
export const mapLength = (m: TimeMap): number => Math.round(m.dst[m.dst.length - 1]);

function interp(xs: Float64Array, ys: Float64Array, x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const span = xs[hi] - xs[lo];
  return span > 0 ? ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / span : ys[lo];
}

/** Instant source (échantillons) d'un instant du son rendu. */
export const dstToSrc = (m: TimeMap, t: number): number => interp(m.dst, m.src, t);
/** Instant du son rendu d'un instant source. */
export const srcToDst = (m: TimeMap, s: number): number => interp(m.src, m.dst, s);

/** Vrai si la carte est l'identité (rien ne bouge dans le temps). */
export const isIdentity = (m: TimeMap): boolean => {
  for (let i = 0; i < m.src.length; i++) if (Math.abs(m.src[i] - m.dst[i]) > 1e-9) return false;
  return true;
};

/**
 * Carte du temps d'une région de `n` échantillons. `extend` : échantillons
 * ajoutés (ou retirés) à la fin (option « décaler la suite »).
 */
export function buildTimeMap(notes: TimingNote[], n: number, extend: number, quiet: QuietFinder): TimeMap {
  const src: number[] = [0];
  const dst: number[] = [0];
  const push = (s: number, d: number) => {
    const ls = src[src.length - 1], ld = dst[dst.length - 1];
    if (s <= ls + 1e-9) {
      // Même instant source : on garde le plus tardif côté rendu (jamais en arrière).
      if (Math.abs(s - ls) <= 1e-9 && d > ld && src.length > 1) dst[dst.length - 1] = d;
      return;
    }
    src.push(s); dst.push(Math.max(d, ld + 1e-3));
  };
  // Pas de décalage d'un blanc : zone calme qui absorbe l'écart.
  const gap = (a: number, b: number, offA: number, offB: number) => {
    if (Math.abs(offA - offB) < 0.5 || b <= a) return;
    const delta = offB - offA;
    let [z0, z1] = quiet(a, b, delta);
    z0 = Math.max(a, Math.min(b, z0)); z1 = Math.max(z0, Math.min(b, z1));
    if (z1 - z0 + delta < 1) { z0 = a; z1 = b; }
    push(z0, z0 + offA);
    push(z1, z1 + offB);
  };
  let prevEnd = 0, prevOff = 0;
  const sorted = [...notes].sort((p, q) => p.start - q.start);
  for (const nt of sorted) {
    const S = Math.max(prevEnd, Math.min(n, nt.start));
    const E = Math.max(S, Math.min(n, nt.end));
    if (E <= S) continue;
    // Le début ne passe jamais avant la fin (rendue) de ce qui précède.
    const d0 = Math.max(nt.d0, prevEnd + prevOff - S);
    let d1 = nt.d1;
    if (E + d1 <= S + d0 + 1) d1 = S + d0 + 1 - E;
    gap(prevEnd, S, prevOff, d0);
    push(S, S + d0);
    const s0 = Math.max(S, Math.min(E, nt.s0)), s1 = Math.max(s0, Math.min(E, nt.s1));
    const sus = s1 - s0;
    const susOut = s1 + d1 - (s0 + d0);
    if (sus > 0 && s0 > S && s1 < E && (d0 !== d1) && susOut >= MIN_SUSTAIN_RATIO * sus) {
      push(s0, s0 + d0);
      push(s1, s1 + d1);
    } else if (sus > 0 && d0 === d1) {
      // Note déplacée en bloc : rien à étirer.
    }
    push(E, E + d1);
    prevEnd = E; prevOff = d1;
  }
  gap(prevEnd, n, prevOff, extend);
  push(n, n + extend);
  return { src: Float64Array.from(src), dst: Float64Array.from(dst) };
}

/**
 * Zone calme : la fenêtre de `w` échantillons d'énergie minimale dans [a, b[,
 * d'après le niveau par trame (dB). `w` = max(2·|écart|, |écart| + 10 ms, 40 ms),
 * borné au blanc.
 */
export function quietFinder(rmsDb: Float32Array, hop: number, sr: number): QuietFinder {
  return (a, b, delta) => {
    const need = Math.max(2 * Math.abs(delta), Math.abs(delta) + 0.01 * sr, 0.04 * sr);
    const w = Math.min(b - a, need);
    if (w >= b - a) return [a, b];
    const f0 = Math.max(0, Math.floor(a / hop)), f1 = Math.min(rmsDb.length - 1, Math.ceil(b / hop));
    const wf = Math.max(1, Math.round(w / hop));
    let best = a, bestE = Infinity;
    for (let f = f0; f + wf <= f1; f++) {
      let e = 0;
      for (let k = f; k < f + wf; k++) e += Math.pow(10, rmsDb[k] / 10);
      if (e < bestE) { bestE = e; best = f * hop; }
    }
    const z0 = Math.max(a, Math.min(b - w, best));
    return [z0, z0 + w];
  };
}
