/**
 * Nova Pitch · rendu des notes retouchées (hauteur, formant, gain, timing).
 *
 * Méthode : TD-PSOLA (Moulines & Charpentier, 1990), synthèse pilotée par le
 * temps du son RENDU :
 *  1. marques de période sur la voix (utils/pitchRender.pitchMarks : une par
 *     cycle, calées par corrélation puis recentrées sur l'impulsion glottique) ;
 *  2. on avance dans le son rendu : à chaque instant t, l'instant source
 *     τ = carte(t) (engine/pitch/timeMap) choisit le grain d'origine le plus
 *     proche ; le grain suivant est posé une période visée plus loin
 *     (période réelle du grain d'origine ÷ rapport de hauteur demandé) ;
 *  3. un grain n'est jamais accéléré ni ralenti (sauf formant demandé) : les
 *     formants restent en place, pas d'effet « chipmunk » ;
 *  4. hors des notes (consonnes, souffle), les grains sont recopiés à leur
 *     place (décalés en bloc si le timing a bougé) : son identique.
 *
 * Étirement d'une note : la partie tenue est lue plus lentement (grains
 * répétés) ; son VIBRATO est rejoué à sa vitesse naturelle par une « horloge
 * de vibrato » qui avance à vitesse 1 et saute d'un nombre entier de cycles
 * (fondu entre deux cycles voisins) pour rester près de τ — au lieu d'être
 * ralenti avec le reste.
 *
 * Gain par note : enveloppe en dB, fondus de 10 ms centrés sur les bords.
 */
import type { PitchTrack } from '../../utils/pitchAnalysis';
import type { PitchMarks } from '../../utils/pitchRender';
import { dstToSrc, mapLength, srcToDst, type TimeMap } from './timeMap';

/** Horloge de vibrato d'une partie tenue étirée (échantillons). */
export interface VibClock {
  /** Partie tenue dans le son rendu. */
  t0: number;
  t1: number;
  /** Période du vibrato (échantillons). */
  P: number;
  /** Durée du raccord final vers le vibrato d'origine (échantillons). */
  F: number;
}

export interface GainSeg { a: number; b: number; db: number }

export interface RenderPlan {
  track: PitchTrack;
  /** Correction (demi-tons) par trame source : hauteur visée = midi + corr. */
  corr: Float32Array;
  /** Part vibrato de la hauteur visée (demi-tons) par trame source. */
  vib: Float32Array;
  /** Formant (demi-tons) par trame source. */
  formant?: Float32Array;
  map: TimeMap;
  clocks?: VibClock[];
  /** Gain des notes (dB), dans le temps du son rendu (échantillons). */
  gains?: GainSeg[];
}

const frameAt = (curve: Float32Array, hop: number, sample: number): number => {
  const f = sample / hop;
  const i = Math.floor(f);
  if (i < 0) return curve[0] || 0;
  if (i >= curve.length - 1) return curve[curve.length - 1] || 0;
  return curve[i] + (curve[i + 1] - curve[i]) * (f - i);
};

/** Hauteur MIDI de la source à un instant (NaN hors des notes). */
const midiAt = (track: PitchTrack, sample: number): number => {
  const f = sample / track.hop;
  const i = Math.floor(f);
  const a = track.midi[i], b = track.midi[i + 1];
  if (Number.isNaN(a) && Number.isNaN(b)) return NaN;
  if (a === undefined) return b ?? NaN;
  if (Number.isNaN(a)) return b;
  if (b === undefined || Number.isNaN(b)) return a;
  return a + (b - a) * (f - i);
};

const smooth01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
/** Part du cycle (en fin de cycle) où l'horloge fond vers le cycle voisin. */
const CLOCK_FADE = 0.4;
/** Recalage sur les marques d'origine : écart de période maximal par cycle. */
const RELOCK = 0.015;

/**
 * Correction de vibrato (demi-tons) qu'apporte l'horloge à l'instant rendu t
 * (τ = carte(t)). L'horloge avance à vitesse 1 depuis le début de la partie
 * tenue et recule (ou avance) d'une période entière de vibrato dès qu'elle
 * s'écarte de τ, avec un fondu entre les deux cycles voisins : le vibrato
 * garde sa vitesse et sa forme chantées. Sur les F derniers échantillons, elle
 * rejoint le vibrato d'origine (raccord sans saut avec la chute de la note).
 */
function clockDelta(plan: RenderPlan, c: VibClock, t: number, tau: number): number {
  const hop = plan.track.hop;
  const raw = dstToSrc(plan.map, c.t0) + (t - c.t0);
  const u = (raw - tau) / c.P;
  const m0 = Math.floor(u);
  const f = u - m0;
  const a = raw - m0 * c.P, b = raw - (m0 + 1) * c.P;
  const w = smooth01((f - (1 - CLOCK_FADE)) / CLOCK_FADE);
  const own = frameAt(plan.vib, hop, tau);
  const clock = (1 - w) * frameAt(plan.vib, hop, a) + w * frameAt(plan.vib, hop, b);
  const g = c.F > 0 ? smooth01((t - (c.t1 - c.F)) / c.F) : 0;
  return (1 - g) * (clock - own);
}

/**
 * Rend tous les canaux. `marks` : marques de période de la source (mono),
 * calculées une fois par analyse. Longueur du résultat : celle de la carte.
 */
export function renderVoice(channels: Float32Array[], marks: PitchMarks, plan: RenderPlan): Float32Array[] {
  const n = channels[0]?.length || 0;
  const N = Math.max(1, mapLength(plan.map));
  const outs = channels.map(() => new Float32Array(N));
  if (!n) return outs;
  const { track, map } = plan;
  const sr = track.sr;
  const pos = marks.pos;
  const K = pos.length;
  const clocks = (plan.clocks || []).slice().sort((a, b) => a.t0 - b.t0);
  let ci = 0;

  // ---- Plan de synthèse : (instant rendu, marque source) ----
  const at: number[] = [];
  const src: number[] = [];
  let lastT = -Infinity;
  // Index de la marque la plus proche de τ (τ croît avec t : recherche en avant).
  let kk = 0;
  const nearest = (tau: number, lo: number, hi: number) => {
    if (kk < lo) kk = lo;
    if (kk > hi) kk = hi;
    while (kk > lo && pos[kk] > tau) kk--;
    while (kk < hi && Math.abs(pos[kk + 1] - tau) <= Math.abs(pos[kk] - tau)) kk++;
    return kk;
  };
  const targetAt = (t: number, tau: number): number => {
    const m = midiAt(track, tau);
    if (Number.isNaN(m)) return NaN;
    let p = m + frameAt(plan.corr, track.hop, tau);
    while (ci < clocks.length && clocks[ci].t1 < t) ci++;
    const c = clocks[ci];
    if (c && t >= c.t0 && t <= c.t1) p += clockDelta(plan, c, t, tau);
    return p;
  };

  let k = 0;
  while (k < K) {
    const v = marks.voiced[k];
    let b = k;
    while (b + 1 < K && marks.voiced[b + 1] === v) b++;
    // Début et fin de la série dans le son rendu.
    let t = srcToDst(map, pos[k]);
    const tEnd = b + 1 < K ? srcToDst(map, pos[b + 1]) : N - 1 + 1e-6;
    if (t <= lastT) t = lastT + 1;
    const runHi = b;
    while (t < tEnd - 1e-6 || (b + 1 >= K && t <= N - 1)) {
      if (t > N - 1) break;
      const tau = dstToSrc(map, t);
      const j = nearest(tau, k, runHi);
      at.push(t); src.push(j); lastT = t;
      let step: number;
      const Pa = j + 1 < K ? pos[j + 1] - pos[j] : j > 0 ? pos[j] - pos[j - 1] : 1;
      if (v) {
        const target = targetAt(t, tau);
        const own = midiAt(track, pos[j]);
        if (Number.isNaN(target) || Number.isNaN(own) || Math.abs(target - midiAt(track, tau)) < 1e-7) {
          // Hauteur d'origine et temps à vitesse 1 : on revient en douceur sur les marques
          // (au plus 1,5 % de période par cycle, ≈ 25 cents, le temps d'une attaque) pour que
          // tout ce qui suit une retouche soit de nouveau le son d'origine, aligné à l'échantillon.
          step = Pa;
          if (j + 1 < K && Math.abs(dstToSrc(map, t + Pa) - tau - Pa) < 1e-3) {
            const want = srcToDst(map, pos[j + 1]) - t;
            step = Pa + Math.max(-RELOCK * Pa, Math.min(RELOCK * Pa, want - Pa));
          }
        } else {
          // Période d'origine du grain (espacement réel des marques : suit les micro-variations
          // de la voix) divisée par le rapport de hauteur demandé. Mesuré sur une vraie voix : bien
          // plus juste que la période déduite de la courbe d'analyse (lissée).
          step = Pa / Math.pow(2, (target - midiAt(track, tau)) / 12);
        }
        // Garde-fou : jamais plus de 2 octaves d'écart avec la période d'origine.
        step = Math.max(Pa / 4, Math.min(Pa * 4, step));
      } else {
        // Hors des notes : grain suivant à la place rendue de la marque suivante (alignement à
        // l'échantillon là où rien ne bouge), sans dépasser l'espacement d'origine (étirement :
        // grains répétés, jamais de trou).
        const nextAt = j + 1 < K ? srcToDst(map, pos[j + 1]) : t + Pa;
        step = Math.max(1, Math.min(Pa, nextAt - t));
      }
      if (step <= 0) break;
      t += step;
    }
    k = b + 1;
  }

  // ---- Recollement des grains ----
  const J = at.length;
  const wsum = new Float32Array(N);
  const formant = plan.formant;
  for (let q = 0; q < J; q++) {
    const s = Math.round(at[q]);
    const kq = src[q];
    const m = pos[kq];
    const prev = q > 0 ? Math.round(at[q - 1]) : s;
    const next = q + 1 < J ? Math.round(at[q + 1]) : s;
    const Pa = Math.max(kq + 1 < K ? pos[kq + 1] - pos[kq] : 0, kq > 0 ? pos[kq] - pos[kq - 1] : 0);
    const voicedGrain = marks.voiced[kq] === 1;
    const fs = voicedGrain && formant ? frameAt(formant, track.hop, m) : 0;
    const fr = Math.abs(fs) >= 0.05 ? Math.pow(2, Math.max(-12, Math.min(12, fs)) / 12) : 1;
    let L = s - prev, R = next - s;
    if (Pa > 0) { L = Math.min(L, Math.max(1, Pa)) || L; R = Math.min(R, Math.max(1, Pa)) || R; }
    const lo = q === 0 ? -s : -L;
    const hi = q === J - 1 ? N - 1 - s : R;
    for (let d = lo; d <= hi; d++) {
      const o = s + d;
      if (o < 0 || o >= N) continue;
      if (d === hi && q !== J - 1 && R > 0) continue; // le bord appartient au grain suivant
      let i = m + d;
      let frac = 0;
      if (fr !== 1) { const x = m + d * fr; i = Math.floor(x); frac = x - i; if (i < 0 || i + 1 >= n) continue; }
      else if (i < 0 || i >= n) continue;
      let w: number;
      if (d < 0) w = q === 0 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * d) / L);
      else if (d > 0) w = q === J - 1 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * d) / R);
      else w = 1;
      wsum[o] += w;
      if (frac) for (let c = 0; c < channels.length; c++) outs[c][o] += (channels[c][i] + (channels[c][i + 1] - channels[c][i]) * frac) * w;
      else for (let c = 0; c < channels.length; c++) outs[c][o] += channels[c][i] * w;
    }
  }
  for (let o = 0; o < N; o++) {
    const w = wsum[o];
    if (w > 1e-3 && Math.abs(w - 1) > 1e-6) {
      const g = 1 / Math.max(0.2, w);
      for (let c = 0; c < outs.length; c++) outs[c][o] *= g;
    }
  }

  // ---- Gain des notes ----
  if (plan.gains?.length) {
    const env = gainEnvelope(plan.gains, N, sr);
    for (let c = 0; c < outs.length; c++) { const y = outs[c]; for (let o = 0; o < N; o++) y[o] *= env[o]; }
  }
  return outs;
}

/** Enveloppe de gain (linéaire) : chaque note à son gain, fondus de 10 ms centrés sur ses bords. */
export function gainEnvelope(gains: GainSeg[], N: number, sr: number): Float32Array {
  const env = new Float32Array(N).fill(1);
  const h = Math.max(1, Math.round(0.005 * sr));
  for (const g of gains) {
    if (Math.abs(g.db) < 0.05) continue;
    const lin = Math.pow(10, g.db / 20) - 1;
    const a = Math.round(g.a), b = Math.round(g.b);
    for (let o = Math.max(0, a - h); o < Math.min(N, b + h); o++) {
      const up = o < a + h ? smooth01((o - (a - h)) / (2 * h)) : 1;
      const down = o > b - h ? smooth01(((b + h) - o) / (2 * h)) : 1;
      env[o] += lin * Math.min(up, down);
    }
  }
  return env;
}

/**
 * Hauteur visée (MIDI) trame par trame dans le temps du son RENDU (même pas
 * que l'analyse) : ce que le rendu doit produire. NaN hors des notes.
 * `withEdits` = false : hauteur chantée, replacée dans le temps rendu.
 */
export function outputPitchCurve(plan: RenderPlan, withEdits = true): Float32Array {
  const { track, map } = plan;
  const N = mapLength(map);
  const frames = Math.floor(N / track.hop) + 1;
  const out = new Float32Array(frames);
  const clocks = (plan.clocks || []).slice().sort((a, b) => a.t0 - b.t0);
  let ci = 0;
  for (let i = 0; i < frames; i++) {
    const t = i * track.hop;
    const tau = dstToSrc(map, t);
    const m = midiAt(track, tau);
    if (Number.isNaN(m) || !withEdits) { out[i] = m; continue; }
    let p = m + frameAt(plan.corr, track.hop, tau);
    while (ci < clocks.length && clocks[ci].t1 < t) ci++;
    const c = clocks[ci];
    if (c && t >= c.t0 && t <= c.t1) p += clockDelta(plan, c, t, tau);
    out[i] = p;
  }
  return out;
}
