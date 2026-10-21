/**
 * L5 · écart 18 · Éditer la voix par le texte : à partir de la transcription
 * locale (Whisper sur le PC, `Clip.transcript`, utils/voiceLyrics), la prise se
 * lit comme un texte. Sélectionner des mots = sélectionner leur passage dans le
 * clip ; effacer un mot, une respiration ou un silence = une coupe propre, dans
 * le silence entre deux mots, avec de courts fondus (pas de clic à la jonction) ;
 * découper la prise par phrase ou par mot ; corriger un mot mal transcrit (le
 * texte corrigé est gardé dans le projet, avec le clip).
 *
 * « Une prise » = les clips d'une piste qui jouent le même son (même bufferId) :
 * après une coupe, le texte se lit toujours d'un bout à l'autre.
 *
 * Les coupes suivent le mode d'édition : en Shuffle, la suite de la prise recule
 * (le blanc se referme) ; sinon, un blanc reste à la place (le reste ne bouge pas
 * par rapport au beat).
 *
 * Module pur, sans DOM : tests/textEdit.test.ts.
 */
import type { BreathEdit, Clip, Track, TranscriptWord } from '../types';
import { idGenerator, splitClipsAt, type IdGen } from './timeSelection';
import { transcriptValid } from './voiceLyrics';

/** Un silence plus long que ça entre deux mots devient un élément du texte (« ⏸ 0,6 s »). */
export const MIN_PAUSE = 0.25;
/** Silence gardé quand on en efface un (la respiration naturelle entre deux phrases). */
export const KEEP_PAUSE = 0.12;
/** Fondu à chaque bord coupé (s) : 10 ms, dans le silence. */
export const CUT_FADE = 0.01;
/** Marge minimale entre une coupe et un mot (s). */
const WORD_GUARD = 0.015;

export interface WordToken {
  kind: 'word';
  clipId: string;
  /** Indice du mot dans `clip.transcript.words`. */
  index: number;
  text: string;
  /** Début de phrase (segment de la transcription). */
  b?: boolean;
  /** Temps dans le son du clip (s). */
  s: number;
  e: number;
  /** Temps du morceau (s). */
  t: number;
  te: number;
}

export interface PauseToken {
  kind: 'pause';
  clipId: string;
  s: number;
  e: number;
  t: number;
  te: number;
  /** Une respiration a été repérée dans ce silence. */
  breath?: boolean;
}

export type TextToken = WordToken | PauseToken;

const clipEnd = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration;
const toTimeline = (c: Pick<Clip, 'start' | 'offset'>, s: number) => c.start + (s - (c.offset || 0));

/** Clips d'une prise (même son, même piste, audibles), dans l'ordre du temps. */
export function takeClips(track: Pick<Track, 'clips'>, bufferId: string): Clip[] {
  return (track.clips || []).filter(c => c.bufferId === bufferId && !c.isMuted && transcriptValid(c)).sort((a, b) => a.start - b.start);
}

/**
 * Le texte d'une prise : ses mots (partie montrée de chaque clip) et les
 * silences de plus de MIN_PAUSE entre eux (respiration repérée si `breaths`
 * — zones en secondes du son — en recouvre une partie).
 */
export function takeTokens(clips: Clip[], o: { minPause?: number; breaths?: Pick<BreathEdit, 'start' | 'end'>[] } = {}): TextToken[] {
  const minPause = o.minPause ?? MIN_PAUSE;
  const out: TextToken[] = [];
  for (const c of clips) {
    if (!transcriptValid(c)) continue;
    const off = c.offset || 0, end = off + c.duration;
    const words = c.transcript.words
      .map((w, index) => ({ w, index }))
      .filter(({ w }) => w.s >= off - 0.05 && w.s < end - 0.02);
    let prevEnd = off;
    words.forEach(({ w, index }, k) => {
      const s = Math.max(off, w.s), e = Math.min(end, w.e);
      if (s - prevEnd >= minPause) out.push(pause(c, prevEnd, s, o.breaths));
      out.push({ kind: 'word', clipId: c.id, index, text: w.w, ...(w.b ? { b: true } : {}), s, e, t: toTimeline(c, s), te: toTimeline(c, e) });
      prevEnd = Math.max(prevEnd, e);
      if (k === words.length - 1 && end - prevEnd >= minPause) out.push(pause(c, prevEnd, end, o.breaths));
    });
  }
  return out;
}

function pause(c: Clip, s: number, e: number, breaths?: Pick<BreathEdit, 'start' | 'end'>[]): PauseToken {
  const breath = !!breaths?.some(b => Math.min(b.end, e) - Math.max(b.start, s) > 0.05);
  return { kind: 'pause', clipId: c.id, s, e, t: toTimeline(c, s), te: toTimeline(c, e), ...(breath ? { breath: true } : {}) };
}

/** Plage du morceau (s) couverte par les éléments i0 … i1. */
export function tokensSpan(tokens: TextToken[], i0: number, i1: number): { start: number; end: number } | null {
  const a = Math.max(0, Math.min(i0, i1)), b = Math.min(tokens.length - 1, Math.max(i0, i1));
  if (a > b || !tokens[a]) return null;
  return { start: tokens[a].t, end: tokens[b].te };
}

export interface CutRange { clipId: string; /** Temps du son du clip (s). */ s: number; e: number }

/**
 * Recale un point de coupe sur le son : les temps des mots de la transcription
 * sont approximatifs (quelques dizaines de ms) ; on cherche, entre `a` et `b`
 * (temps du son), l'instant le plus calme (énergie sur 10 ms). `x` : son mono.
 */
export type QuietSnap = (clipId: string, a: number, b: number, fallback: number) => number;

export function quietestPoint(x: Float32Array, sampleRate: number, a: number, b: number, fallback: number): number {
  const w = Math.max(8, Math.round(0.01 * sampleRate));
  const i0 = Math.max(0, Math.round(a * sampleRate)), i1 = Math.min(x.length, Math.round(b * sampleRate));
  if (i1 - i0 < w * 2) return fallback;
  // Somme glissante des carrés.
  let acc = 0;
  for (let i = i0; i < i0 + w; i++) acc += x[i] * x[i];
  let best = acc, at = i0;
  for (let i = i0 + w; i < i1; i++) {
    acc += x[i] * x[i] - x[i - w] * x[i - w];
    // À énergie égale (silence), on préfère le plus près du point prévu.
    const c = i - w + 1;
    if (acc < best * 0.98 || (acc <= best * 1.02 && Math.abs((c + w / 2) / sampleRate - fallback) < Math.abs((at + w / 2) / sampleRate - fallback))) { best = Math.min(best, acc); at = c; }
  }
  return (at + w / 2) / sampleRate;
}

/** Plage de recherche autour d'un silence entre deux mots (tolère l'imprécision des temps). */
const SNAP_SLACK = 0.04;

/**
 * Ce qu'il faut retirer pour effacer les éléments i0 … i1 (par clip) :
 *  - des mots : du milieu du silence d'avant au milieu du silence d'après (le
 *    rythme de la phrase est gardé : un demi-silence de chaque côté) ;
 *  - un silence ou une respiration : ramené à KEEP_PAUSE (la fin du mot d'avant
 *    et l'attaque du suivant restent intactes).
 */
export function cutRangesFor(tokens: TextToken[], clips: Clip[], i0: number, i1: number, snap?: QuietSnap): CutRange[] {
  const a = Math.max(0, Math.min(i0, i1)), b = Math.min(tokens.length - 1, Math.max(i0, i1));
  const byClip = new Map<string, number[]>();
  for (let i = a; i <= b; i++) { const l = byClip.get(tokens[i].clipId) || []; l.push(i); byClip.set(tokens[i].clipId, l); }
  const out: CutRange[] = [];
  for (const [clipId, idx] of byClip) {
    const c = clips.find(x => x.id === clipId);
    if (!c) continue;
    const off = c.offset || 0, end = off + c.duration;
    const first = tokens[idx[0]], last = tokens[idx[idx.length - 1]];
    const words = c.transcript?.words || [];
    let s: number, e: number;
    if (first.kind === 'pause') s = Math.min(first.e, first.s + KEEP_PAUSE / 2);
    else {
      const prev = prevWordEnd(words, first.index);
      s = prev === null || prev < off ? Math.max(off, first.s - 0.03) : mid(prev, first.s);
      if (snap && prev !== null && prev >= off) s = snap(clipId, Math.max(off, prev - SNAP_SLACK), Math.min(end, first.s + SNAP_SLACK), s);
    }
    if (last.kind === 'pause') e = Math.max(last.s, last.e - KEEP_PAUSE / 2);
    else {
      const next = nextWordStart(words, last.index);
      e = next === null || next > end ? Math.min(end, last.e + 0.03) : mid(last.e, next);
      if (snap && next !== null && next <= end) e = snap(clipId, Math.max(off, last.e - SNAP_SLACK), Math.min(end, next + SNAP_SLACK), e);
    }
    s = Math.max(off, s); e = Math.min(end, e);
    if (e - s > 0.005) out.push({ clipId, s, e });
  }
  return out;
}

/** Point de coupe dans le silence [a, b] : au milieu, à une marge des mots si possible. */
function mid(a: number, b: number): number {
  const m = (a + b) / 2;
  if (b - a > 2 * WORD_GUARD) return Math.min(b - WORD_GUARD, Math.max(a + WORD_GUARD, m));
  return m;
}
const prevWordEnd = (words: TranscriptWord[], i: number) => (i > 0 ? words[i - 1].e : null);
const nextWordStart = (words: TranscriptWord[], i: number) => (i < words.length - 1 ? words[i + 1].s : null);

/**
 * Applique des coupes à la piste : chaque passage est retiré de son clip, les
 * bords coupés reçoivent un fondu court ; `ripple` (Shuffle) : ce qui suit sur
 * la piste recule d'autant (le blanc se referme), sinon un blanc reste.
 */
export function applyCuts(clips: Clip[], ranges: CutRange[], o: { ripple: boolean; fade?: number; gen?: IdGen }): Clip[] {
  const fade = o.fade ?? CUT_FADE;
  const gen = o.gen || idGenerator('tx');
  let out = [...clips];
  // De droite à gauche : les temps des coupes suivantes restent valables.
  const timed = ranges.map(r => {
    const c = out.find(x => x.id === r.clipId);
    return c ? { r, T0: toTimeline(c, r.s), T1: toTimeline(c, r.e) } : null;
  }).filter(Boolean).sort((x, y) => y!.T0 - x!.T0) as { r: CutRange; T0: number; T1: number }[];
  for (const { r, T0, T1 } of timed) {
    const c = out.find(x => x.id === r.clipId);
    if (!c) continue;
    const others = out.filter(x => x !== c);
    const parts = splitClipsAt([c], [T0, T1], gen);
    const kept = parts.filter(p => !(p.start >= T0 - 1e-6 && clipEnd(p) <= T1 + 1e-6)).map(p => {
      const q = { ...p };
      // Bords nés de la coupe : fondus courts (dans le silence).
      if (Math.abs(clipEnd(q) - T0) < 1e-6) { q.fadeOut = Math.min(fade, q.duration / 2); q.fadeOutCurve = 'EQUAL_POWER'; }
      if (Math.abs(q.start - T1) < 1e-6) { q.fadeIn = Math.min(fade, q.duration / 2); q.fadeInCurve = 'EQUAL_POWER'; }
      return q;
    });
    const len = T1 - T0;
    out = [...others, ...kept].map(x => (o.ripple && x.start >= T1 - 1e-6 ? { ...x, start: Math.max(0, x.start - len) } : x));
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Où découper une prise : par phrase (avant chaque début de phrase de la
 * transcription ; sans repère de phrase, à chaque silence de plus de 0,35 s), ou
 * par mot (entre chaque mot). Instants du morceau, au milieu du silence.
 */
export function splitTimes(tokens: TextToken[], clips: Clip[], by: 'phrase' | 'word', snap?: QuietSnap): number[] {
  const words = tokens.filter((t): t is WordToken => t.kind === 'word');
  const hasMarks = words.some((w, k) => k > 0 && w.b);
  const out: number[] = [];
  for (let k = 1; k < words.length; k++) {
    const p = words[k - 1], w = words[k];
    if (p.clipId !== w.clipId) continue; // déjà coupé là
    const gap = w.s - p.e;
    const isBoundary = by === 'word' || (hasMarks ? !!w.b : gap >= 0.35);
    if (!isBoundary) continue;
    const c = clips.find(x => x.id === w.clipId)!;
    const off = c.offset || 0;
    const m = mid(p.e, w.s);
    out.push(toTimeline(c, snap ? snap(c.id, Math.max(off, p.e - SNAP_SLACK), Math.min(off + c.duration, w.s + SNAP_SLACK), m) : m));
  }
  return out;
}

/** Découpe les clips de la prise aux instants donnés (fondus courts aux bords nés de la découpe). */
export function splitTake(clips: Clip[], takeIds: string[], times: number[], o: { fade?: number; gen?: IdGen } = {}): Clip[] {
  const fade = o.fade ?? CUT_FADE;
  const gen = o.gen || idGenerator('tx');
  const take = clips.filter(c => takeIds.includes(c.id));
  const rest = clips.filter(c => !takeIds.includes(c.id));
  const cut = splitClipsAt(take, times, gen).map(c => {
    const q = { ...c };
    if (times.some(t => Math.abs(clipEnd(q) - t) < 1e-6)) { q.fadeOut = Math.min(fade, q.duration / 2); q.fadeOutCurve = 'EQUAL_POWER'; }
    if (times.some(t => Math.abs(q.start - t) < 1e-6)) { q.fadeIn = Math.min(fade, q.duration / 2); q.fadeInCurve = 'EQUAL_POWER'; }
    return q;
  });
  return [...rest, ...cut].sort((a, b) => a.start - b.start);
}

/**
 * Corrige le texte d'un mot (mal transcrit) dans tous les clips de la prise qui
 * le portent (même son, même instant) ; le temps du mot ne bouge pas.
 */
export function renameWord(clips: Clip[], takeIds: string[], at: { s: number; e: number }, text: string): Clip[] {
  const w = text.trim();
  if (!w) return clips;
  return clips.map(c => {
    if (!takeIds.includes(c.id) || !c.transcript) return c;
    let hit = false;
    const words = c.transcript.words.map(x => (Math.abs(x.s - at.s) < 1e-4 && Math.abs(x.e - at.e) < 1e-4 ? (hit = true, { ...x, w, p: 1 }) : x));
    return hit ? { ...c, transcript: { ...c.transcript, words } } : c;
  });
}

/** Texte lisible d'une plage d'éléments (« j'arrive ⏸ 0,6 s »). */
export function tokensText(tokens: TextToken[], i0: number, i1: number): string {
  const a = Math.min(i0, i1), b = Math.max(i0, i1);
  return tokens.slice(a, b + 1).map(t => (t.kind === 'word' ? t.text : t.breath ? '(respiration)' : '(silence)')).join(' ');
}

/** Description d'une coupe pour le message (« « j'arrive » effacé : 0,42 s retirées »). */
export function cutSummary(tokens: TextToken[], i0: number, i1: number, ranges: CutRange[], ripple: boolean): string {
  const total = ranges.reduce((s, r) => s + (r.e - r.s), 0);
  const what = tokensText(tokens, i0, i1);
  const sec = total.toFixed(2).replace('.', ',');
  return `« ${what.length > 40 ? `${what.slice(0, 40)}…` : what} » effacé : ${sec} s retirée${total >= 2 ? 's' : ''}${ripple ? ', la suite de la prise a reculé' : ', un blanc reste à la place'}.`;
}
