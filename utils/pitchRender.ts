/**
 * Justesse note par note (V19) : rendu de la correction de hauteur.
 *
 * Méthode : TD-PSOLA (Pitch-Synchronous Overlap-Add), la référence pour une
 * voix seule.
 *  1. On pose des marques de période sur la voix (une par cycle de la
 *     corde vocale), calées d'un cycle à l'autre par corrélation.
 *  2. Chaque marque porte un « grain » : deux périodes de son, fenêtrées.
 *     Le grain contient l'empreinte du conduit vocal (les formants).
 *  3. On recolle les grains à un nouvel espacement : plus serré = plus aigu,
 *     plus large = plus grave. Le grain lui-même n'est jamais accéléré ni
 *     ralenti : les formants ne bougent pas (pas d'effet « chipmunk »).
 *  4. Chaque grain est pris à l'endroit du même instant (synthèse calée sur
 *     le temps d'origine) : la durée ne change pas d'un échantillon.
 *
 * Les fenêtres de deux grains voisins sont complémentaires (leur somme vaut
 * 1 en tout point) : sans correction, la sortie est identique à l'entrée, et
 * le passage d'une note à l'autre ne crée pas de clic. Souffle et consonnes
 * (sans hauteur) sont recopiés tels quels.
 *
 * Même rendu en lecture et à l'export : le résultat est un nouvel audio
 * (rendu hors ligne une fois), joué comme n'importe quel clip.
 */
import type { PitchTrack } from './pitchAnalysis';
import { hzOfMidi } from './pitchAnalysis';

export interface PitchMarks {
  /** Positions des marques (échantillons), croissantes ; la première vaut 0, la dernière length − 1. */
  pos: Int32Array;
  /** 1 si la marque est dans une note (grain périodique), 0 sinon. */
  voiced: Uint8Array;
}

/** Hauteur (Hz) à un instant, interpolée entre trames ; 0 si pas de note. */
function hzAt(track: PitchTrack, sample: number): number {
  const f = sample / track.hop;
  const i = Math.floor(f);
  const a = track.midi[i], b = track.midi[i + 1];
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (Number.isNaN(a)) return f - i > 0.5 ? hzOfMidi(b) : 0;
  if (Number.isNaN(b)) return f - i < 0.5 ? hzOfMidi(a) : 0;
  return hzOfMidi(a + (b - a) * (f - i));
}

/** Corrélation de deux tranches de même longueur. */
function corr(x: Float32Array, a: number, b: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) s += x[a + i] * x[b + i];
  return s;
}

/**
 * Marques de période. Dans les notes : une par cycle, la suivante cherchée à
 * ±20 % de la période attendue là où le cycle ressemble le plus au
 * précédent. Ailleurs : une marque toutes les ~4 ms (recopie à l'identique).
 */
export function pitchMarks(x: Float32Array, track: PitchTrack): PitchMarks {
  const n = x.length;
  const sr = track.sr;
  const pos: number[] = [0];
  const voiced: number[] = [0];
  const U = Math.max(16, Math.round(sr * 0.004));

  // Passages chantés, en échantillons.
  const runs: [number, number][] = [];
  const m = track.midi;
  for (let i = 0; i < m.length; i++) {
    if (Number.isNaN(m[i])) continue;
    let j = i;
    while (j < m.length && !Number.isNaN(m[j])) j++;
    const a = Math.max(0, Math.round((i - 0.5) * track.hop)), b = Math.min(n - 1, Math.round((j - 0.5) * track.hop));
    if (b - a > 0) runs.push([a, b]);
    i = j;
  }

  const fillUnvoiced = (to: number) => {
    const from = pos[pos.length - 1];
    const gap = to - from;
    if (gap <= 0) return;
    const k = Math.max(1, Math.round(gap / U));
    for (let q = 1; q < k; q++) { pos.push(Math.round(from + (gap * q) / k)); voiced.push(0); }
  };

  for (const [a, b] of runs) {
    const f0 = hzAt(track, a + 1) || hzAt(track, a + track.hop);
    if (!f0) continue;
    let P = sr / f0;
    // Première marque : crête de la première période.
    let first = a, peak = -1;
    for (let i = a; i < Math.min(b, a + Math.ceil(P)); i++) { const v = Math.abs(x[i]); if (v > peak) { peak = v; first = i; } }
    if (first <= pos[pos.length - 1]) first = pos[pos.length - 1] + Math.max(1, Math.round(P / 2));
    if (first >= b) continue;
    fillUnvoiced(first);
    pos.push(first); voiced.push(1);
    let cur = first;
    for (;;) {
      const hz = hzAt(track, cur + P / 2) || hzAt(track, cur);
      if (!hz) break;
      P = sr / hz;
      const ideal = cur + P;
      if (ideal >= b) break;
      const L = Math.round(P);
      const span = Math.max(1, Math.round(P * 0.2));
      let best = Math.round(ideal), bestC = -Infinity;
      for (let c = Math.round(ideal) - span; c <= Math.round(ideal) + span; c++) {
        if (c <= cur || c + L >= n || cur + L >= n) continue;
        // Préférence légère pour la période attendue (évite les sauts de cycle).
        const cc = corr(x, cur, c, L) * (1 - 0.15 * Math.abs(c - ideal) / span);
        if (cc > bestC) { bestC = cc; best = c; }
      }
      if (best <= cur || best >= b) break;
      pos.push(best); voiced.push(1);
      cur = best;
    }
  }
  fillUnvoiced(n - 1);
  if (pos[pos.length - 1] !== n - 1 && n > 1) { pos.push(n - 1); voiced.push(0); }
  return { pos: Int32Array.from(pos), voiced: Uint8Array.from(voiced) };
}

/** Correction (demi-tons) à un instant, interpolée entre trames. */
function corrAt(curve: Float32Array, hop: number, sample: number): number {
  const f = sample / hop;
  const i = Math.floor(f);
  if (i < 0) return curve[0] || 0;
  if (i >= curve.length - 1) return curve[curve.length - 1] || 0;
  return curve[i] + (curve[i + 1] - curve[i]) * (f - i);
}

/**
 * Plan de synthèse : instants de sortie et grain d'origine de chacun.
 * Dans une note, on avance d'une période corrigée (période d'origine / rapport
 * de hauteur) et on prend le grain d'origine le plus proche dans le temps.
 */
export function synthesisPlan(marks: PitchMarks, curve: Float32Array, hop: number): { at: Float64Array; src: Int32Array } {
  const { pos, voiced } = marks;
  const K = pos.length;
  const at: number[] = [];
  const src: number[] = [];
  let k = 0;
  while (k < K) {
    if (!voiced[k]) { at.push(pos[k]); src.push(k); k++; continue; }
    const a = k;
    let b = k;
    while (b + 1 < K && voiced[b + 1]) b++;
    let t = pos[a];
    let j = a;
    const end = pos[b];
    while (t <= end + 1e-6) {
      while (j < b && Math.abs(pos[j + 1] - t) <= Math.abs(pos[j] - t)) j++;
      at.push(t); src.push(j);
      const Pa = j < b ? pos[j + 1] - pos[j] : j > a ? pos[j] - pos[j - 1] : 0;
      if (Pa <= 0) break;
      const beta = Math.pow(2, Math.max(-24, Math.min(24, corrAt(curve, hop, t))) / 12);
      t += Pa / beta;
    }
    k = b + 1;
  }
  return { at: Float64Array.from(at), src: Int32Array.from(src) };
}

/**
 * Applique la courbe de correction (demi-tons, une valeur par trame de
 * `track`) à tous les canaux. Les canaux gardent la même longueur.
 */
export function renderPitch(channels: Float32Array[], track: PitchTrack, curve: Float32Array, mono?: Float32Array): Float32Array[] {
  const n = channels[0]?.length || 0;
  if (!n) return channels.map(c => new Float32Array(c));
  let x = mono;
  if (!x) {
    if (channels.length === 1) x = channels[0];
    else { x = new Float32Array(n); for (const c of channels) for (let i = 0; i < n; i++) x[i] += c[i] / channels.length; }
  }
  const marks = pitchMarks(x, track);
  const { at, src } = synthesisPlan(marks, curve, track.hop);
  const J = at.length;
  const outs = channels.map(() => new Float32Array(n));
  const wsum = new Float32Array(n);
  const pos = marks.pos;

  for (let j = 0; j < J; j++) {
    const s = Math.round(at[j]);
    const m = pos[src[j]];
    const prev = j > 0 ? Math.round(at[j - 1]) : s;
    const next = j + 1 < J ? Math.round(at[j + 1]) : s;
    // Demi-fenêtres : écart avec les grains voisins de la sortie, sans dépasser
    // une période d'origine (au-delà, le grain prendrait le cycle voisin).
    const k = src[j];
    const Pa = Math.max(
      k + 1 < pos.length ? pos[k + 1] - pos[k] : 0,
      k > 0 ? pos[k] - pos[k - 1] : 0,
    );
    const voicedGrain = marks.voiced[k] === 1;
    let L = s - prev, R = next - s;
    if (voicedGrain && Pa > 0) { L = Math.min(L, Math.max(1, Math.round(Pa * 1.0))) || L; R = Math.min(R, Math.max(1, Math.round(Pa * 1.0))) || R; }
    // Bords du fichier : fenêtre pleine jusqu'au bord.
    const lo = j === 0 ? -s : -L;
    const hi = j === J - 1 ? n - 1 - s : R;
    for (let d = lo; d <= hi; d++) {
      const o = s + d, i = m + d;
      if (o < 0 || o >= n || i < 0 || i >= n) continue;
      let w: number;
      if (d < 0) w = j === 0 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * d) / L);
      else if (d > 0) w = j === J - 1 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * d) / R);
      else w = 1;
      if (d === hi && j !== J - 1 && R > 0) continue; // le bord appartient au grain suivant
      wsum[o] += w;
      for (let c = 0; c < channels.length; c++) outs[c][o] += channels[c][i] * w;
    }
  }
  // Fenêtres complémentaires : somme = 1. Elle creuse seulement quand une note
  // est fortement descendue (grains plus espacés que leur période) : on
  // compense ce creux pour garder le niveau.
  for (let o = 0; o < n; o++) {
    const w = wsum[o];
    if (w > 1e-3 && Math.abs(w - 1) > 1e-6) {
      const g = 1 / Math.max(0.2, w);
      for (let c = 0; c < outs.length; c++) outs[c][o] *= g;
    }
  }
  return outs;
}
