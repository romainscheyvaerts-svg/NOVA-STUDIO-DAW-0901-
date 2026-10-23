/**
 * Nova Pitch · notes de la voix : forme de chaque note et découpage modifiable.
 *
 * Logique pure (worker, tests). Une note trouvée par l'analyse
 * (utils/pitchAnalysis.segmentNotes) reçoit ici :
 *  - sa partie TENUE [s0, s1[ (la voyelle) : c'est la seule qui s'étire quand
 *    on allonge ou raccourcit la note ; l'attaque (glissade, consonne voisée,
 *    montée du niveau) et la chute gardent leur vitesse ;
 *  - son vibrato (vitesse en Hz, amplitude en cents), mesuré sur le résidu
 *    rapide de la hauteur (hauteur − dérive lente) par autocorrélation ;
 *  - sa dérive (pente lente, cents par seconde).
 *
 * Le découpage (couper / fusionner des notes) est une couche par-dessus
 * l'analyse : des instants de coupe et de fusion, rejoués à chaque ouverture.
 */
import { centerOf, type PitchNote, type PitchTrack } from '../../utils/pitchAnalysis';

export interface NoteShape {
  /** Partie tenue (s, depuis le début de la région analysée). */
  s0: number;
  s1: number;
  /** Vitesse du vibrato (Hz) ; 0 = pas de vibrato net. */
  vibRate: number;
  /** Amplitude du vibrato (cents, crête). */
  vibDepth: number;
  /** Dérive lente (cents par seconde, pente moyenne). */
  driftCents: number;
}

const medianOf = (v: number[]): number => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Moyenne glissante (±r) qui ignore les NaN. */
function smoothNaN(v: Float32Array | number[], r: number): Float32Array {
  const n = v.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) if (!Number.isNaN(v[k])) { s += v[k]; c++; }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

/** Note construite sur les trames [i0, i1[ (centre perçu sur le cœur de la note). */
export function noteFromFrames(track: PitchTrack, i0: number, i1: number, index = 0): PitchNote {
  const hopSec = track.hop / track.sr;
  const len = i1 - i0;
  const t = Math.floor(len * 0.15);
  const w: number[] = [];
  for (let k = i0 + t; k < i1 - t; k++) if (!Number.isNaN(track.midi[k])) w.push(track.midi[k]);
  if (!w.length) for (let k = i0; k < i1; k++) if (!Number.isNaN(track.midi[k])) w.push(track.midi[k]);
  const c = centerOf(w);
  let acc = 0, cnt = 0;
  for (let k = i0; k < i1; k++) if (!Number.isNaN(track.midi[k])) { acc += (track.midi[k] - c) ** 2; cnt++; }
  return { index, i0, i1, start: i0 * hopSec, end: i1 * hopSec, center: c, spread: cnt ? Math.sqrt(acc / cnt) : 0 };
}

/**
 * Forme d'une note : partie tenue, vibrato, dérive.
 * Partie tenue : on retire l'attaque tant que la hauteur lissée n'est pas
 * posée (à plus de 35 cents du centre) ou que le niveau monte encore (plus de
 * 12 dB sous le niveau de la note), avec au moins 20 ms ; même chose à la fin.
 * Si la partie tenue fait moins de 30 % de la note (note très courte ou très
 * mouvante), on garde le milieu (60 %).
 */
export function noteShape(track: PitchTrack, note: PitchNote): NoteShape {
  const hopSec = track.hop / track.sr;
  const { i0, i1 } = note;
  const len = i1 - i0;
  const dev = new Float32Array(len);
  for (let i = 0; i < len; i++) { const m = track.midi[i0 + i]; dev[i] = Number.isNaN(m) ? NaN : m - note.center; }
  const r = Math.max(2, Math.round(0.07 / hopSec));
  const slow = smoothNaN(smoothNaN(dev, r), r);
  let maxDb = -Infinity;
  for (let i = i0; i < i1; i++) maxDb = Math.max(maxDb, track.rmsDb[i]);
  const settled = (i: number) => !Number.isNaN(dev[i]) && Math.abs(slow[i]) < 0.35 && track.rmsDb[i0 + i] >= maxDb - 12;
  const minEdge = Math.min(Math.round(0.02 / hopSec), Math.floor(len / 4));
  let a = minEdge;
  while (a < len && !settled(a)) a++;
  let b = len - minEdge;
  while (b > a && !settled(b - 1)) b--;
  if (b - a < 0.3 * len) { a = Math.round(0.2 * len); b = len - Math.round(0.2 * len); }

  // Vibrato : résidu rapide sur la partie tenue, autocorrélation entre 3,5 et 9 Hz.
  const res: number[] = [];
  for (let i = a; i < b; i++) res.push(Number.isNaN(dev[i]) || Number.isNaN(slow[i]) ? 0 : dev[i] - slow[i]);
  let vibRate = 0, vibDepth = 0;
  if (res.length > 8) {
    let e = 0;
    for (const v of res) e += v * v;
    const rms = Math.sqrt(e / res.length);
    vibDepth = rms * Math.SQRT2 * 100;
    const fps = 1 / hopSec;
    const lo = Math.max(2, Math.floor(fps / 9)), hi = Math.ceil(fps / 3.5);
    if (res.length > hi * 1.5 && rms > 0) {
      const ac = (lag: number) => {
        let s = 0;
        for (let i = 0; i + lag < res.length; i++) s += res[i] * res[i + lag];
        return s / ((res.length - lag) * rms * rms);
      };
      let best = -1, bestV = -Infinity;
      const vals: number[] = [];
      for (let lag = lo - 1; lag <= hi + 1; lag++) vals.push(ac(lag));
      for (let lag = lo; lag <= hi; lag++) {
        const v = vals[lag - lo + 1];
        if (v > bestV && v >= vals[lag - lo] && v >= vals[lag - lo + 2]) { bestV = v; best = lag; }
      }
      if (best > 0 && bestV >= 0.35 && vibDepth >= 8) {
        const y0 = vals[best - lo], y1 = vals[best - lo + 1], y2 = vals[best - lo + 2];
        const den = y0 + y2 - 2 * y1;
        const shift = Math.abs(den) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (y0 - y2) / (2 * den))) : 0;
        vibRate = fps / (best + shift);
      }
    }
    if (!vibRate) vibDepth = Math.min(vibDepth, 8);
  }

  // Dérive : pente de la hauteur lissée (moindres carrés).
  let sx = 0, sy = 0, sxx = 0, sxy = 0, c = 0;
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(slow[i])) continue;
    const x = i * hopSec, y = slow[i] * 100;
    sx += x; sy += y; sxx += x * x; sxy += x * y; c++;
  }
  const den = c * sxx - sx * sx;
  const driftCents = c > 2 && Math.abs(den) > 1e-12 ? (c * sxy - sx * sy) / den : 0;

  return { s0: (i0 + a) * hopSec, s1: (i0 + b) * hopSec, vibRate, vibDepth, driftCents };
}

// ---------------------------------------------------------------------------
// Découpage modifiable : couper / fusionner
// ---------------------------------------------------------------------------

export interface NoteLayout {
  /** Instants (s, région) où une note est coupée en deux. */
  cuts?: number[];
  /** Instants (s, région) de frontières retirées (deux notes fusionnées). */
  joins?: number[];
}

/** Notes après fusions puis coupes (rangées par ordre de temps, renumérotées). */
export function applyLayout(track: PitchTrack, base: PitchNote[], layout?: NoteLayout): PitchNote[] {
  const hopSec = track.hop / track.sr;
  let notes = base.map(n => ({ ...n }));
  for (const t of layout?.joins || []) {
    let best = -1, bestD = 0.025;
    for (let k = 0; k + 1 < notes.length; k++) {
      const d = Math.abs(notes[k + 1].start - t);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) continue;
    const merged = noteFromFrames(track, notes[best].i0, notes[best + 1].i1);
    notes.splice(best, 2, merged);
  }
  for (const t of layout?.cuts || []) {
    const c = Math.round(t / hopSec);
    const k = notes.findIndex(n => c - n.i0 >= 3 && n.i1 - c >= 3);
    if (k < 0) continue;
    const n = notes[k];
    notes.splice(k, 1, noteFromFrames(track, n.i0, c), noteFromFrames(track, c, n.i1));
  }
  notes = notes.sort((a, b) => a.i0 - b.i0);
  return notes.map((n, i) => ({ ...n, index: i }));
}

/** Couper la note qui contient l'instant t (s, région) : renvoie le nouveau découpage, ou null. */
export function cutAt(track: PitchTrack, notes: PitchNote[], layout: NoteLayout | undefined, t: number): NoteLayout | null {
  const hopSec = track.hop / track.sr;
  const c = Math.round(t / hopSec);
  if (!notes.some(n => c - n.i0 >= 3 && n.i1 - c >= 3)) return null;
  // Une fusion au même endroit est simplement retirée.
  const joins = (layout?.joins || []).filter(j => Math.abs(j - t) > 0.025);
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { ...(joins.length ? { joins } : {}), cuts: [...(layout?.cuts || []), r(c * hopSec)].sort((a, b) => a - b) };
}

/** Fusionner les notes k et k+1 : renvoie le nouveau découpage, ou null. */
export function joinAfter(notes: PitchNote[], layout: NoteLayout | undefined, k: number): NoteLayout | null {
  if (k < 0 || k + 1 >= notes.length) return null;
  const t = notes[k + 1].start;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  // Une coupe à cet endroit : on la retire au lieu d'ajouter une fusion.
  const cuts = layout?.cuts || [];
  const near = cuts.findIndex(c => Math.abs(c - t) <= 0.012);
  if (near >= 0) {
    const rest = cuts.filter((_, i) => i !== near);
    return { ...(layout?.joins?.length ? { joins: layout.joins } : {}), ...(rest.length ? { cuts: rest } : {}) };
  }
  return { ...(cuts.length ? { cuts } : {}), joins: [...(layout?.joins || []), r(t)].sort((a, b) => a - b) };
}

/** Le découpage ne change rien. */
export const isEmptyLayout = (l?: NoteLayout) => !l || (!(l.cuts?.length) && !(l.joins?.length));

export { medianOf };
