import { Clip } from '../types';
import { compSwipe, takeSpans, TakeSpan } from './comping';
import { scoreTake, ScoreOptions, TakeScore } from './takeScore';

/**
 * « Meilleure prise » par l'IA locale (V22) : la zone chantée est découpée en
 * phrases (coupées dans les silences communs à toutes les prises, sinon toutes
 * les 2 mesures) ; dans chaque phrase, chaque prise est notée (utils/takeScore)
 * et la meilleure passe dans le comp, avec les crossfades du comp à la souris.
 * Tout se calcule dans le navigateur ; une seule étape d'annulation.
 */

export interface Phrase { start: number; end: number }
export interface PhraseChoice extends Phrase { n: number; scores: Record<number, TakeScore> }
export interface AutoCompResult {
  clips: Clip[];
  choices: PhraseChoice[];
  /** Note moyenne de chaque prise (pondérée par la durée des phrases). */
  takeScores: Record<number, TakeScore>;
}

/** Lecture de l'audio d'un morceau de prise (mono) entre deux instants du projet. */
export type SpanReader = (span: TakeSpan, from: number, to: number) => { samples: Float32Array; sampleRate: number } | null;

const STEP = 0.016;

/** Phrases : passages chantés séparés par des silences communs (≥ 250 ms). */
export function findPhrases(spans: TakeSpan[], read: SpanReader, bpm: number, minGap = 0.25, minPhrase = 1): Phrase[] {
  if (!spans.length) return [];
  const a = Math.min(...spans.map(s => s.start)), b = Math.max(...spans.map(s => s.end));
  const n = Math.max(1, Math.ceil((b - a) / STEP));
  const env = new Float32Array(n);
  for (const sp of spans) {
    const r = read(sp, sp.start, sp.end);
    if (!r) continue;
    const per = Math.max(1, Math.round(STEP * r.sampleRate));
    for (let i = 0; i * per < r.samples.length; i++) {
      let s = 0;
      const end = Math.min(r.samples.length, (i + 1) * per);
      for (let k = i * per; k < end; k++) s += r.samples[k] * r.samples[k];
      const v = Math.sqrt(s / Math.max(1, end - i * per)) * (sp.base.gain ?? 1);
      const idx = Math.floor((sp.start - a) / STEP) + i;
      if (idx >= 0 && idx < n) env[idx] = Math.max(env[idx], v);
    }
  }
  const peak = env.reduce((m, v) => Math.max(m, v), 0);
  const thr = Math.max(peak * 0.06, 1e-4);
  const phrases: Phrase[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && env[i] < thr) i++;
    if (i >= n) break;
    const s = i;
    let quiet = 0;
    while (i < n && (env[i] >= thr || quiet * STEP < minGap)) { quiet = env[i] >= thr ? 0 : quiet + 1; i++; }
    phrases.push({ start: a + s * STEP, end: a + (i - quiet) * STEP });
  }
  // Coupes au milieu des silences, phrases trop courtes fusionnées.
  const merged: Phrase[] = [];
  for (const p of phrases) {
    const last = merged[merged.length - 1];
    if (last && (p.end - p.start < minPhrase || last.end - last.start < minPhrase)) last.end = p.end;
    else merged.push({ ...p });
  }
  for (let k = 0; k + 1 < merged.length; k++) {
    const mid = (merged[k].end + merged[k + 1].start) / 2;
    merged[k].end = mid; merged[k + 1].start = mid;
  }
  // La 1re phrase part du début de l'audio, la dernière va jusqu'au bout (pas de reste de comp).
  if (merged.length) { merged[0].start = a; merged[merged.length - 1].end = b; }
  // Voix continue (pas de silence) : découpage toutes les 2 mesures.
  const bar2 = (60 / (bpm > 0 ? bpm : 120)) * 8;
  const out: Phrase[] = [];
  for (const p of merged) {
    if (p.end - p.start <= bar2 * 1.5) { out.push(p); continue; }
    const first = Math.ceil((p.start + 0.5) / bar2) * bar2;
    let cur = p.start;
    for (let t = first; t < p.end - bar2 / 2; t += bar2) { out.push({ start: cur, end: t }); cur = t; }
    out.push({ start: cur, end: p.end });
  }
  return out;
}

export function autoComp(clips: Clip[], read: SpanReader, opts: ScoreOptions, onlyTakes?: number[]): AutoCompResult {
  let spans = takeSpans(clips);
  if (onlyTakes) spans = spans.filter(s => onlyTakes.includes(s.n));
  const phrases = findPhrases(spans, read, opts.bpm);
  const choices: PhraseChoice[] = [];
  const sum: Record<number, { w: number; s: TakeScore }> = {};
  let next = clips;
  for (const ph of phrases) {
    const scores: Record<number, TakeScore> = {};
    for (const sp of spans) {
      const from = Math.max(ph.start, sp.start), to = Math.min(ph.end, sp.end);
      if (to - from < (ph.end - ph.start) * 0.8) continue;   // la prise doit couvrir la phrase
      const r = read(sp, from, to);
      if (!r || !r.samples.length) continue;
      const sc = scoreTake(r.samples, r.sampleRate, { ...opts, gain: sp.base.gain ?? 1, t0: from });
      if (!scores[sp.n] || sc.total > scores[sp.n].total) scores[sp.n] = sc;
    }
    const ns = Object.keys(scores).map(Number);
    if (!ns.length) continue;
    // À note égale : la prise la plus récente (comme Pro Tools, la dernière est active).
    const best = ns.sort((x, y) => scores[y].total - scores[x].total || y - x)[0];
    choices.push({ ...ph, n: best, scores });
    for (const n of ns) {
      const w = ph.end - ph.start;
      const acc = sum[n] || (sum[n] = { w: 0, s: { total: 0, pitch: 0, timing: 0, level: 0, noise: 0 } });
      acc.w += w;
      (Object.keys(acc.s) as (keyof TakeScore)[]).forEach(k => { acc.s[k] += scores[n][k] * w; });
    }
    const r = compSwipe(next, best, ph.start, ph.end);
    if (r.changed) next = r.clips;
  }
  const takeScores: Record<number, TakeScore> = {};
  for (const [n, { w, s }] of Object.entries(sum)) {
    takeScores[Number(n)] = { total: Math.round(s.total / w), pitch: Math.round(s.pitch / w), timing: Math.round(s.timing / w), level: Math.round(s.level / w), noise: Math.round(s.noise / w) };
  }
  return { clips: next, choices, takeScores };
}
