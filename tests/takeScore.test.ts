import { describe, expect, it } from 'vitest';
import { centsOff, downsample, scoreTake, yinPitch } from '../utils/takeScore';
import { autoComp, findPhrases, SpanReader } from '../utils/autoComp';
import { readComp, takeSpans } from '../utils/comping';
import { makeClip } from './helpers/fixtures';

const SR = 48000;
/** Signal de test : notes (fréquence, début, durée) avec attaque franche, bruit de fond optionnel. */
function voice(dur: number, notes: { f: number; at: number; len: number; amp?: number }[], noise = 0.0005, seed = 1): Float32Array {
  const x = new Float32Array(Math.round(dur * SR));
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let i = 0; i < x.length; i++) x[i] = noise * 2 * rnd();
  for (const n of notes) {
    const a = Math.round(n.at * SR), b = Math.min(x.length, Math.round((n.at + n.len) * SR));
    for (let i = a; i < b; i++) {
      const t = (i - a) / SR;
      const env = Math.min(1, t / 0.005) * Math.min(1, (b - i) / SR / 0.02);
      x[i] += (n.amp ?? 0.15) * env * Math.sin(2 * Math.PI * n.f * t);
    }
  }
  return x;
}
const semis = (f: number, s: number) => f * Math.pow(2, s / 12);

describe('détection de hauteur et justesse', () => {
  it('YIN retrouve la hauteur d’une note', () => {
    const { y, sr } = downsample(voice(0.5, [{ f: 220, at: 0, len: 0.5 }], 0), SR);
    expect(yinPitch(y, 2000, sr)!).toBeCloseTo(220, 0);
    const z = downsample(voice(0.5, [{ f: 523.25, at: 0, len: 0.5 }], 0), SR);
    expect(yinPitch(z.y, 2000, z.sr)!).toBeGreaterThan(520);
    expect(yinPitch(new Float32Array(4000), 100, 16000)).toBeNull();
  });

  it('écart en cents, chromatique ou dans la gamme', () => {
    expect(centsOff(440)).toBeCloseTo(0, 3);
    expect(centsOff(semis(440, 0.3))).toBeCloseTo(30, 1);
    // Do# (277,18 Hz) en do majeur : la note juste la plus proche est à 100 cents.
    expect(centsOff(277.18, { root: 0, scale: 'MAJOR' })).toBeCloseTo(100, 0);
    expect(centsOff(277.18)).toBeLessThan(1);
  });
});

describe('note d’une prise', () => {
  const bpm = 120; // double croche = 0,125 s
  const onGrid = (f: number) => [0, 0.5, 1, 1.5].map(at => ({ f, at, len: 0.4 }));

  it('juste > fausse ; calée > en retard ; propre > bruitée ; bon niveau > trop bas', () => {
    const juste = scoreTake(voice(2, onGrid(440)), SR, { bpm });
    const fausse = scoreTake(voice(2, onGrid(semis(440, 0.4))), SR, { bpm });
    expect(juste.pitch).toBeGreaterThan(fausse.pitch + 30);
    const retard = scoreTake(voice(2, [0, 0.5, 1, 1.5].map(at => ({ f: 440, at: at + 0.06, len: 0.4 }))), SR, { bpm });
    expect(juste.timing).toBeGreaterThan(retard.timing + 30);
    const bruitee = scoreTake(voice(2, onGrid(440), 0.03), SR, { bpm });
    expect(juste.noise).toBeGreaterThan(bruitee.noise + 20);
    const basse = scoreTake(voice(2, onGrid(440).map(n => ({ ...n, amp: 0.004 }))), SR, { bpm });
    expect(juste.level).toBeGreaterThan(basse.level + 20);
    const saturee = scoreTake(voice(2, onGrid(440).map(n => ({ ...n, amp: 1.4 }))).map(v => Math.max(-1, Math.min(1, v))), SR, { bpm });
    expect(juste.level).toBeGreaterThan(saturee.level);
    expect(juste.total).toBeGreaterThan(Math.max(fausse.total, retard.total, bruitee.total, basse.total));
  });

  it('signal vide : note nulle, sans planter', () => {
    expect(scoreTake(new Float32Array(10), SR, { bpm }).total).toBe(0);
  });
});

describe('comp automatique (« Meilleure prise »)', () => {
  // 3 prises de 4 s : 2 phrases (0,1–1,5 s et 2,1–3,5 s) séparées par un silence.
  const phraseNotes = (f1: number, f2: number) => [
    ...[0.1, 0.6, 1.1].map(at => ({ f: f1, at, len: 0.35 })),
    ...[2.1, 2.6, 3.1].map(at => ({ f: f2, at, len: 0.35 })),
  ];
  const bufs: Record<string, Float32Array> = {
    b1: voice(4, phraseNotes(semis(440, 0.45), semis(440, 0.45)), 0.0005, 3),  // fausse partout
    b2: voice(4, phraseNotes(440, semis(440, 0.4)), 0.0005, 5),                 // juste sur la phrase 1
    b3: voice(4, phraseNotes(semis(440, -0.4), 440), 0.0005, 7),                // juste sur la phrase 2
  };
  const clips = () => [1, 2, 3].map(n => makeClip({ id: `t${n}`, takeNumber: n, name: `Prise ${n}`, start: 10, duration: 4, bufferId: `b${n}`, isMuted: n !== 3 }));
  const read: SpanReader = (sp, from, to) => {
    const x = bufs[sp.base.bufferId!];
    const a = Math.max(0, Math.round((from - sp.anchor) * SR)), b = Math.min(x.length, Math.round((to - sp.anchor) * SR));
    return { samples: x.subarray(a, b), sampleRate: SR };
  };

  it('phrases coupées dans le silence commun', () => {
    const ph = findPhrases(takeSpans(clips()), read, 120);
    expect(ph).toHaveLength(2);
    expect(ph[0].end).toBeGreaterThan(11.4);
    expect(ph[0].end).toBeLessThan(12.2);
    expect(ph[1].start).toBe(ph[0].end);
  });

  it('chaque phrase prend la prise la plus juste ; le comp est appliqué avec crossfades', () => {
    const r = autoComp(clips(), read, { bpm: 120 });
    expect(r.choices.map(c => c.n)).toEqual([2, 3]);
    const segs = readComp(r.clips);
    expect(segs.map(s => s.n)).toEqual([2, 3]);
    expect(r.takeScores[1].total).toBeLessThan(r.takeScores[2].total);
    expect(r.choices[0].scores[2].pitch).toBeGreaterThan(r.choices[0].scores[1].pitch);
    // Les autres prises restent dans leurs couloirs.
    expect(takeSpans(r.clips).map(s => s.n)).toEqual([1, 2, 3]);
  });
});
