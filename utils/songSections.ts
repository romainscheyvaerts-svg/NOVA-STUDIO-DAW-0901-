/**
 * Repères automatiques de structure d'une prod : Intro, Partie 1, 2, 3…, Outro.
 *
 * Mesure par mesure (au tempo du projet), on calcule l'énergie (niveau global
 * + graves : kick, 808). Les articulations se repèrent aux « cassures »
 * (mesures nettement plus calmes) et aux sauts d'énergie entre phrases de
 * 8 mesures. Le nom « couplet / refrain » n'est PAS deviné : sur des prods en
 * boucle, ce serait trop souvent faux. Les parties les plus pleines sont
 * signalées (`full`) : c'est souvent là que va le refrain.
 */

export interface SongSection {
  kind: 'intro' | 'part' | 'outro';
  name: string;
  /** Partie parmi les plus pleines du morceau (souvent le refrain). */
  full?: boolean;
  start: number; // secondes (temps de la prod)
  end: number;
}

/** Énergie par mesure, normalisée (max = 1). */
export function barEnergy(buf: AudioBuffer, bpm: number): number[] {
  const sr = buf.sampleRate;
  const bar = (240 / bpm) * sr;
  const ch = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const a = Math.exp(-2 * Math.PI * 150 / sr);
  let lp = 0;
  const out: number[] = [];
  for (let k = 0; (k + 1) * bar <= buf.length; k++) {
    let s = 0, l = 0;
    const s0 = Math.floor(k * bar), n = Math.floor(bar);
    for (let i = s0; i < s0 + n; i += 2) {
      let x = 0;
      for (const d of ch) x += d[i];
      x /= ch.length;
      lp = (1 - a) * x + a * lp;
      s += x * x;
      l += lp * lp;
    }
    out.push(Math.sqrt((s * 2) / n) + 0.8 * Math.sqrt((l * 2) / n));
  }
  const mx = Math.max(...out, 1e-9);
  return out.map(v => v / mx);
}

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };

export function detectSections(buf: AudioBuffer, bpm: number): SongSection[] {
  if (!bpm || bpm < 40 || bpm > 220 || buf.duration < 30) return [];
  const E = barEnergy(buf, bpm);
  const n = E.length;
  if (n < 16) return [];
  const barSec = 240 / bpm;
  const M = median(E);
  const quiet = (k: number) => E[k] < 0.58 * M;

  // Intro / outro : mesures calmes du début et de la fin
  let bodyStart = 0;
  while (bodyStart < n && quiet(bodyStart)) bodyStart++;
  let bodyEnd = n - 1;
  while (bodyEnd > bodyStart && quiet(bodyEnd)) bodyEnd--;
  if (bodyEnd - bodyStart < 12) return [];

  // Frontières : fin d'une cassure (1-3 mesures calmes) ou saut d'énergie net
  const cuts = new Set<number>([bodyStart]);
  for (let k = bodyStart + 1; k <= bodyEnd; k++) {
    if (!quiet(k) && quiet(k - 1)) {
      // début de la cassure = frontière (la cassure termine la partie précédente)
      let b = k - 1;
      while (b > bodyStart && quiet(b - 1)) b--;
      cuts.add(k);
      if (k - b > 3) cuts.add(b); // longue respiration = partie à part entière
    }
  }
  // Sauts d'énergie entre phrases de 8 mesures (pic local seulement)
  const nov = (k: number) => {
    const before = mean(E.slice(Math.max(bodyStart, k - 8), k));
    const after = mean(E.slice(k, Math.min(bodyEnd + 1, k + 8)));
    return Math.abs(after - before) / Math.max(before, after, 1e-9);
  };
  for (let k = bodyStart + 6; k <= bodyEnd - 5; k++) {
    const v = nov(k);
    if (v < 0.11) continue;
    let peak = true;
    for (let j = k - 3; j <= k + 3; j++) if (j !== k && j > bodyStart && j < bodyEnd && nov(j) > v) { peak = false; break; }
    if (peak) cuts.add(k);
  }
  // Frontières trop proches (< 8 mesures) : on garde la première
  const sorted = [...cuts].sort((a, b) => a - b).filter((k, i, arr) => i === 0 || k - arr[i - 1] >= 8);
  // Arrondi à la grille de 4 mesures depuis le début du corps (tolérance 1 mesure)
  const snapped = [...new Set(sorted.map(k => {
    const rel = k - bodyStart, r = Math.round(rel / 4) * 4;
    return Math.abs(r - rel) <= 1 ? bodyStart + r : k;
  }))].sort((a, b) => a - b);
  if (snapped.length < 2) return [];

  const parts = snapped.map((from, i) => ({ from, to: (snapped[i + 1] ?? bodyEnd + 1) - 1 }))
    .filter(p => p.to >= p.from);
  const energies = parts.map(p => mean(E.slice(p.from, p.to + 1)));
  const hi = Math.max(...energies), lo = Math.min(...energies);
  const contrast = (hi - lo) / hi > 0.08;
  const mid = (hi + lo) / 2;

  // Parties voisines de même énergie (< 6 % d'écart) : une seule partie
  const merged: { from: number; to: number; e: number }[] = [];
  parts.forEach((p, i) => {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.e - energies[i]) / Math.max(last.e, energies[i]) < 0.06) {
      last.e = (last.e * (last.to - last.from + 1) + energies[i] * (p.to - p.from + 1)) / (p.to - last.from + 1);
      last.to = p.to;
    } else merged.push({ from: p.from, to: p.to, e: energies[i] });
  });
  if (merged.length < 2) return [];

  const out: SongSection[] = [];
  if (bodyStart > 0) out.push({ kind: 'intro', name: 'Intro', start: 0, end: bodyStart * barSec });
  merged.forEach((p, i) => {
    out.push({
      kind: 'part', name: `Partie ${i + 1}`,
      start: p.from * barSec, end: (p.to + 1) * barSec,
      full: contrast && p.e >= mid,
    });
  });
  if (bodyEnd < n - 1) out.push({ kind: 'outro', name: 'Outro', start: (bodyEnd + 1) * barSec, end: buf.duration });
  else out[out.length - 1].end = buf.duration;
  return out;
}

export const sectionColor = (s: SongSection) =>
  s.kind !== 'part' ? '#64748b' : s.full ? '#f472b6' : '#22d3ee';
