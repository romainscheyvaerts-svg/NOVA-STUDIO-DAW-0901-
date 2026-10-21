/**
 * L5 · écart 18 · Éditer la voix par le texte : texte d'une prise, effacer un
 * mot / un silence (coupe propre, sans clic), découper par phrase et par mot,
 * corriger un mot. Preuves sur une prise synthétique dont on connaît les mots.
 */
import { describe, expect, it } from 'vitest';
import { applyCuts, cutRangesFor, quietestPoint, renameWord, splitTake, splitTimes, takeClips, takeTokens, tokensSpan, KEEP_PAUSE, type QuietSnap, type WordToken } from '../utils/textEdit';
import { clipGainAt } from '../utils/fades';
import { TrackType, type Clip, type Track, type TranscriptWord } from '../types';

const SR = 48000;

/** Prise : des « mots » (sons harmoniques avec attaque et chute de 10 ms) séparés de silences (bruit à −80 dBFS). */
function take(words: { s: number; e: number; b?: boolean; w?: string }[], seconds: number) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let seed = 3;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i < n; i++) x[i] = 1e-4 * r();
  words.forEach((w, k) => {
    const f0 = 150 + 20 * (k % 5);
    const a = Math.round(w.s * SR), b = Math.round(w.e * SR);
    for (let i = a; i < b; i++) {
      const t = (i - a) / SR, rem = (b - i) / SR;
      const env = Math.min(1, t / 0.01, rem / 0.01);
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h;
      x[i] += 0.3 * env * v;
    }
  });
  const transcript = { version: 1 as const, language: 'fr', model: 'test', bufferId: 'b1', at: 1, words: words.map((w, k) => ({ w: w.w || `mot${k + 1}`, s: w.s, e: w.e, ...(w.b ? { b: true } : {}) })) as TranscriptWord[] };
  const clip: Clip = { id: 'c1', trackId: 't1', name: 'Couplet', type: TrackType.AUDIO, bufferId: 'b1', start: 10, offset: 0, duration: seconds, transcript } as Clip;
  const track = { id: 't1', name: 'Voix', clips: [clip] } as unknown as Track;
  return { x, clip, track };
}

/** Rendu d'une liste de clips (même son) sur la timeline, fondus compris (comme la lecture). */
function render(clips: Clip[], x: Float32Array, from: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (const c of clips) {
    const n = Math.round(c.duration * SR);
    for (let i = 0; i < n; i++) {
      const src = Math.round((c.offset || 0) * SR) + i;
      const dst = Math.round((c.start - from) * SR) + i;
      if (src < 0 || src >= x.length || dst < 0 || dst >= out.length) continue;
      out[dst] += x[src] * clipGainAt(c, i / SR);
    }
  }
  return out;
}
const dbfs = (v: number) => 20 * Math.log10(Math.max(1e-12, v));

const WORDS = [
  { s: 0.30, e: 0.62, b: true, w: 'Je' }, { s: 0.70, e: 1.05, w: "j'arrive" }, { s: 1.12, e: 1.40, w: 'demain' },
  { s: 2.10, e: 2.45, b: true, w: 'Sur' }, { s: 2.52, e: 2.90, w: 'la' }, { s: 2.94, e: 3.40, w: 'prod' },
];

describe('Texte de la prise', () => {
  it('mots et silences, dans l’ordre, aux temps du morceau', () => {
    const { clip, track } = take(WORDS, 4);
    const tk = takeTokens(takeClips(track, 'b1'), { breaths: [{ start: 1.6, end: 1.9 }] });
    expect(tk.map(t => (t.kind === 'word' ? t.text : t.breath ? 'R' : '_'))).toEqual(['_', 'Je', "j'arrive", 'demain', 'R', 'Sur', 'la', 'prod', '_']);
    const span = tokensSpan(tk, 2, 3)!;
    expect(span.start).toBeCloseTo(clip.start + 0.70, 6);
    expect(span.end).toBeCloseTo(clip.start + 1.40, 6);
  });
});

describe('Effacer en éditant le texte', () => {
  it('Shuffle : le mot disparaît, la suite recule, jonction sans clic (pic < −60 dBFS)', () => {
    const { x, clip, track } = take(WORDS, 4);
    const clips = takeClips(track, 'b1');
    const tk = takeTokens(clips);
    const i = tk.findIndex(t => t.kind === 'word' && t.text === "j'arrive");
    const ranges = cutRangesFor(tk, clips, i, i);
    expect(ranges).toHaveLength(1);
    // Coupe au milieu des silences voisins : [0,66 ; 1,085].
    expect(ranges[0].s).toBeCloseTo(0.66, 3);
    expect(ranges[0].e).toBeCloseTo(1.085, 3);
    const after = applyCuts(clips, ranges, { ripple: true });
    expect(after).toHaveLength(2);
    expect(after[1].start).toBeCloseTo(clip.start + 0.66, 6);
    const y = render(after, x, clip.start, 4);
    // Jonction : ±5 ms autour, rien au-dessus du bruit (pic < −60 dBFS).
    const j = Math.round(0.66 * SR);
    let pk = 0; for (let k = j - 240; k < j + 240; k++) pk = Math.max(pk, Math.abs(y[k]));
    console.log(`[texte] jonction : pic ${dbfs(pk).toFixed(1)} dBFS`);
    expect(dbfs(pk)).toBeLessThan(-60);
    // « demain » joue maintenant juste après « Je » (0,66 + 0,035 s).
    const d0 = Math.round((0.66 + (1.12 - 1.085)) * SR);
    let e = 0; for (let k = d0 + 480; k < d0 + 4800; k++) e += y[k] * y[k];
    expect(e).toBeGreaterThan(1);
    // Durée totale raccourcie de la coupe.
    const lastEnd = Math.max(...after.map(c => c.start + c.duration));
    expect(lastEnd).toBeCloseTo(clip.start + 4 - (1.085 - 0.66), 6);
  });

  it('Slip : un blanc reste, la suite ne bouge pas par rapport au beat', () => {
    const { clip, track } = take(WORDS, 4);
    const clips = takeClips(track, 'b1');
    const tk = takeTokens(clips);
    const i = tk.findIndex(t => t.kind === 'word' && t.text === 'la');
    const after = applyCuts(clips, cutRangesFor(tk, clips, i, i), { ripple: false });
    const right = after.find(c => c.start > clip.start + 2.5)!;
    expect(right.start).toBeCloseTo(clip.start + (2.90 + 2.94) / 2, 6);
    expect(right.offset).toBeCloseTo((2.90 + 2.94) / 2, 6);
    expect(right.fadeIn).toBeCloseTo(0.01, 6);
  });

  it('effacer un silence (ou une respiration) le ramène à 0,12 s, mots intacts', () => {
    const { x, clip, track } = take(WORDS, 4);
    const clips = takeClips(track, 'b1');
    const tk = takeTokens(clips);
    const i = tk.findIndex((t, k) => t.kind === 'pause' && k > 1);
    const pause = tk[i];
    const ranges = cutRangesFor(tk, clips, i, i);
    expect(ranges[0].e - ranges[0].s).toBeCloseTo(pause.e - pause.s - KEEP_PAUSE, 6);
    const after = applyCuts(clips, ranges, { ripple: true });
    const tk2 = takeTokens(after);
    const w1 = tk2.find(t => t.kind === 'word' && t.text === 'demain') as WordToken;
    const w2 = tk2.find(t => t.kind === 'word' && t.text === 'Sur') as WordToken;
    expect(w2.t - w1.te).toBeCloseTo(KEEP_PAUSE, 3);
    // Les mots gardés sonnent comme avant (« Sur » rendu = original).
    const y = render(after, x, clip.start, 4);
    const a = Math.round((w2.t - clip.start) * SR), src = Math.round(2.10 * SR);
    let err = 0; for (let k = 0; k < Math.round(0.3 * SR); k++) err = Math.max(err, Math.abs(y[a + k] - x[src + k]));
    expect(err).toBeLessThan(1e-6);
  });

  it('plusieurs mots d’un coup, puis une 2e coupe sur les morceaux : le texte se relit d’un bout à l’autre', () => {
    const { track } = take(WORDS, 4);
    let clips = takeClips(track, 'b1');
    let tk = takeTokens(clips);
    const a = tk.findIndex(t => t.kind === 'word' && t.text === "j'arrive"), b = tk.findIndex(t => t.kind === 'word' && t.text === 'demain');
    clips = applyCuts(clips, cutRangesFor(tk, clips, a, b), { ripple: true });
    tk = takeTokens(clips);
    expect(tk.filter(t => t.kind === 'word').map(t => (t as WordToken).text)).toEqual(['Je', 'Sur', 'la', 'prod']);
    const p = tk.findIndex(t => t.kind === 'word' && t.text === 'prod');
    clips = applyCuts(clips, cutRangesFor(tk, clips, p, p), { ripple: true });
    expect(takeTokens(clips).filter(t => t.kind === 'word').map(t => (t as WordToken).text)).toEqual(['Je', 'Sur', 'la']);
  });
});

describe('Découper la prise', () => {
  it('par phrase : 10 prises, chaque coupe à ±20 ms du milieu du silence entre phrases, jamais dans un mot', () => {
    let good = 0, total = 0;
    for (let k = 0; k < 10; k++) {
      // 4 phrases de 3 à 5 mots, silences entre phrases de 0,3 à 0,8 s, entre mots de 30 à 90 ms.
      const words: { s: number; e: number; b?: boolean }[] = [];
      const truth: number[] = [];
      let t = 0.2;
      for (let p = 0; p < 4; p++) {
        if (p) t += 0.3 + ((k * 7 + p * 3) % 6) * 0.1;
        const nw = 3 + ((k + p) % 3);
        for (let w = 0; w < nw; w++) {
          const len = 0.18 + ((k + w) % 4) * 0.06;
          words.push({ s: t, e: t + len, ...(w === 0 ? { b: true } : {}) });
          t += len + 0.03 + ((k + w + p) % 4) * 0.02;
        }
      }
      // Bonne frontière : le milieu du silence entre la fin de la phrase et le début de la suivante.
      words.forEach((w, i) => { if (i && w.b) truth.push((words[i - 1].e + w.s) / 2); });
      const { clip, track } = take(words, t + 0.3);
      const clips = takeClips(track, 'b1');
      const times = splitTimes(takeTokens(clips), clips, 'phrase');
      expect(times).toHaveLength(3);
      times.forEach((T, i) => {
        total++;
        const s = T - clip.start;
        const inWord = words.some(w => s > w.s && s < w.e);
        if (!inWord && Math.abs(s - truth[i]) <= 0.02) good++;
      });
      const split = splitTake(clips, clips.map(c => c.id), times);
      expect(split).toHaveLength(4);
    }
    console.log(`[texte] découpe par phrase : ${good}/${total} coupes à ±20 ms d'une bonne frontière, dans un silence`);
    expect(good / total).toBeGreaterThanOrEqual(0.95);
  });

  it('temps de transcription approximatifs (±40 ms), découpe par mot (60 ms entre les mots) : la coupe est recalée dans le vrai silence', () => {
    let good = 0, total = 0, rawGood = 0;
    for (let k = 0; k < 10; k++) {
      const words: { s: number; e: number; b?: boolean }[] = [];
      let t = 0.2;
      for (let p = 0; p < 4; p++) {
        if (p) t += 0.25 + (k % 3) * 0.05;
        for (let w = 0; w < 3; w++) { words.push({ s: t, e: t + 0.25, ...(w === 0 ? { b: true } : {}) }); t += 0.25 + 0.06; }
      }
      const { x, clip, track } = take(words, t + 0.3);
      // Ce que la transcription croit : chaque mot décalé de −40 à +40 ms.
      const tr = clip.transcript!;
      tr.words = tr.words.map((w, i) => { const d = (((i * 37 + k * 11) % 9) - 4) * 0.01; return { ...w, s: w.s + d, e: w.e + d }; });
      const clips = takeClips(track, 'b1');
      const snap: QuietSnap = (_id, a, b, f) => quietestPoint(x, SR, a, b, f);
      const raw = splitTimes(takeTokens(clips), clips, 'word');
      const snapped = splitTimes(takeTokens(clips), clips, 'word', snap);
      const quiet = (T: number) => { const s = T - clip.start; return !words.some(w => s > w.s - 0.005 && s < w.e + 0.005); };
      total += snapped.length;
      good += snapped.filter(quiet).length;
      rawGood += raw.filter(quiet).length;
    }
    console.log(`[texte] temps approximatifs : ${good}/${total} coupes dans le vrai silence (sans recalage : ${rawGood}/${total})`);
    expect(good / total).toBeGreaterThanOrEqual(0.95);
  });

  it('par mot : une coupe entre chaque mot, fondus courts aux bords', () => {
    const { track } = take(WORDS, 4);
    const clips = takeClips(track, 'b1');
    const times = splitTimes(takeTokens(clips), clips, 'word');
    expect(times).toHaveLength(WORDS.length - 1);
    const split = splitTake(clips, clips.map(c => c.id), times);
    expect(split).toHaveLength(WORDS.length);
    expect(split[1].fadeIn).toBeCloseTo(0.01, 6);
    expect(split[1].fadeOut).toBeCloseTo(0.01, 6);
  });

  it('sans repères de phrase : les silences de plus de 0,35 s', () => {
    const { track } = take(WORDS.map(w => ({ s: w.s, e: w.e })), 4);
    const clips = takeClips(track, 'b1');
    expect(splitTimes(takeTokens(clips), clips, 'phrase')).toHaveLength(1);
  });
});

describe('Corriger le texte', () => {
  it('le mot corrigé est gardé dans le transcript du clip (et de ses morceaux), temps inchangé', () => {
    const { track } = take(WORDS, 4);
    let clips = takeClips(track, 'b1');
    clips = splitTake(clips, clips.map(c => c.id), [10 + 1.8]);
    clips = renameWord(clips, clips.map(c => c.id), { s: 0.70, e: 1.05 }, 'j’arrive');
    for (const c of clips) {
      const w = c.transcript!.words.find(x => x.s === 0.70)!;
      expect(w.w).toBe('j’arrive');
      expect(w.e).toBe(1.05);
    }
    const tk = takeTokens(clips);
    expect(tk.some(t => t.kind === 'word' && t.text === 'j’arrive')).toBe(true);
  });
});
