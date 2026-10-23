/**
 * Nova Pitch · marques de période (une par cycle de la corde vocale) pour le
 * rendu TD-PSOLA (engine/pitch/render).
 *
 * 1. Suivi : la marque suivante est cherchée une période plus loin (période
 *    donnée par l'analyse de hauteur), à ±20 %, là où le cycle ressemble le plus
 *    au précédent (corrélation, légère préférence pour la période attendue).
 * 2. Recentrage sur l'impulsion glottique : pour chaque cycle, la phase du
 *    centre d'énergie (moyenne circulaire de x² sur une période) donne l'écart
 *    entre la marque et l'impulsion ; cet écart est déroulé puis LISSÉ sur
 *    ±6 cycles avant d'être appliqué. Les marques restent donc régulières
 *    (espacement = une période, à quelques échantillons près), même sur une
 *    voix aiguë avec vibrato — là où un recentrage cycle par cycle les faisait
 *    sauter (mesuré : 101 espacements faux sur 518 à 587 Hz avec vibrato,
 *    0 à 1 avec ce lissage).
 * Hors des notes : une marque toutes les ~4 ms (recopie à l'identique).
 */
import { hzOfMidi, type PitchTrack } from '../../utils/pitchAnalysis';
import type { PitchMarks } from '../../utils/pitchRender';

export type { PitchMarks };

function hzAt(track: PitchTrack, sample: number): number {
  const f = sample / track.hop;
  const i = Math.floor(f);
  const a = track.midi[i], b = track.midi[i + 1];
  const na = a === undefined || Number.isNaN(a), nb = b === undefined || Number.isNaN(b);
  if (na && nb) return 0;
  if (na) return f - i > 0.5 ? hzOfMidi(b) : 0;
  if (nb) return f - i < 0.5 ? hzOfMidi(a) : 0;
  return hzOfMidi(a + (b - a) * (f - i));
}

function corr(x: Float32Array, a: number, b: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) s += x[a + i] * x[b + i];
  return s;
}

/** Recentrage lissé des marques [from, to[ d'un passage chanté. */
function centerRun(x: Float32Array, pos: number[], from: number, to: number) {
  const K = to - from;
  if (K < 3) return;
  const phase: number[] = [];
  for (let q = 0; q < K; q++) {
    const k = from + q;
    const P = k + 1 < to ? pos[k + 1] - pos[k] : pos[k] - pos[k - 1];
    const h = Math.floor(P / 2);
    let sc = 0, ss = 0;
    for (let d = -h; d < P - h; d++) {
      const i = pos[k] + d;
      if (i < 0 || i >= x.length) continue;
      const e = x[i] * x[i];
      const a = (2 * Math.PI * d) / P;
      sc += e * Math.cos(a); ss += e * Math.sin(a);
    }
    phase.push(sc || ss ? Math.atan2(ss, sc) / (2 * Math.PI) : 0); // fraction de période, ]-0,5 ; 0,5]
  }
  // Déroulé (pas de saut de plus d'une demi-période d'un cycle à l'autre).
  for (let q = 1; q < K; q++) {
    while (phase[q] - phase[q - 1] > 0.5) phase[q] -= 1;
    while (phase[q] - phase[q - 1] < -0.5) phase[q] += 1;
  }
  // Lissage ±6 cycles, puis rappel dans ]-0,5 ; 0,5] autour de la moyenne.
  const R = 6;
  const sm = phase.map((_, q) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, q - R); j <= Math.min(K - 1, q + R); j++) { s += phase[j]; c++; }
    return s / c;
  });
  const lo = from > 0 ? pos[from - 1] : -1;
  // Un seul rappel entier pour tout le passage (jamais de saut d'une période entre deux marques).
  const shift = Math.round(sm.reduce((s, v) => s + v, 0) / K);
  const P0 = pos.slice(from, to);
  for (let q = 0; q < K; q++) {
    const k = from + q;
    const P = q + 1 < K ? P0[q + 1] - P0[q] : P0[q] - (q > 0 ? P0[q - 1] : P0[q] - 1);
    const f = sm[q] - shift;
    pos[k] = Math.min(x.length - 2, Math.max(lo + 1, Math.round(pos[k] + f * P)));
  }
  for (let k = from; k < to; k++) if (k > 0 && pos[k] <= pos[k - 1]) pos[k] = pos[k - 1] + 1;
}

export function voiceMarks(x: Float32Array, track: PitchTrack): PitchMarks {
  const n = x.length;
  const sr = track.sr;
  const pos: number[] = [0];
  const voiced: number[] = [0];
  const U = Math.max(16, Math.round(sr * 0.004));

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
    let first = a, peak = -1;
    for (let i = a; i < Math.min(b, a + Math.ceil(P)); i++) { const v = Math.abs(x[i]); if (v > peak) { peak = v; first = i; } }
    if (first <= pos[pos.length - 1]) first = pos[pos.length - 1] + Math.max(1, Math.round(P / 2));
    if (first >= b) continue;
    fillUnvoiced(first);
    const runStart = pos.length;
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
        const cc = corr(x, cur, c, L) * (1 - 0.15 * Math.abs(c - ideal) / span);
        if (cc > bestC) { bestC = cc; best = c; }
      }
      if (best <= cur || best >= b) break;
      pos.push(best); voiced.push(1);
      cur = best;
    }
    centerRun(x, pos, runStart, pos.length);
  }
  fillUnvoiced(n - 1);
  if (pos[pos.length - 1] !== n - 1 && n > 1) { pos.push(n - 1); voiced.push(0); }
  return { pos: Int32Array.from(pos), voiced: Uint8Array.from(voiced) };
}

/** Part des espacements de marques à plus de 10 % de la période analysée (contrôle qualité). */
export function irregularMarks(marks: PitchMarks, track: PitchTrack): number {
  let bad = 0, n = 0;
  for (let i = 1; i < marks.pos.length; i++) {
    if (!marks.voiced[i] || !marks.voiced[i - 1]) continue;
    const hz = hzAt(track, marks.pos[i - 1]);
    if (!hz) continue;
    n++;
    if (Math.abs(marks.pos[i] - marks.pos[i - 1] - track.sr / hz) > 0.1 * track.sr / hz) bad++;
  }
  return n ? bad / n : 0;
}
