import { describe, expect, it } from 'vitest';
import { alignToGuide, detectOnsets, onsetError } from '../utils/vocalAlign';

const SR = 22050;

/** « Syllabes » : salves harmoniques avec attaque rapide et chute, aux instants donnés. */
function voice(onsets: number[], durations: number[], len: number, seed = 1, detune = 0): Float32Array {
  const x = new Float32Array(Math.round(len * SR));
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647) - 0.5;
  onsets.forEach((t0, k) => {
    const f = 180 + 40 * (k % 5) + detune;
    const n0 = Math.round(t0 * SR), n = Math.round(durations[k] * SR);
    for (let i = 0; i < n && n0 + i < x.length; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 3);
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
      // Petite consonne au début (bruit) : comme une vraie attaque de voix.
      if (t < 0.02) v += rnd() * 1.5;
      x[n0 + i] += 0.3 * env * v;
    }
  });
  return x;
}

describe('alignement NOVA des doubles (repli VocAlign)', () => {
  const onsets = [0.3, 0.75, 1.1, 1.6, 2.05, 2.5, 3.1, 3.5];
  const durs = [0.35, 0.3, 0.4, 0.35, 0.3, 0.45, 0.3, 0.4];
  const shifts = [0.03, 0.08, -0.05, 0.06, 0.04, -0.07, 0.05, 0.08]; // 30 à 80 ms, dans les deux sens
  const guide = voice(onsets, durs, 4.2, 7);
  const dub = voice(onsets.map((t, k) => t + shifts[k]), durs, 4.2, 11, 3);

  it('détecte les attaques des deux prises', () => {
    expect(detectOnsets(guide, SR).length).toBe(onsets.length);
    expect(detectOnsets(dub, SR).length).toBe(onsets.length);
  });

  it('ramène les attaques du double sur celles du guide', () => {
    const before = onsetError(detectOnsets(guide, SR), detectOnsets(dub, SR));
    const res = alignToGuide([guide], [dub], SR, { maxShift: 0.15 });
    const after = onsetError(detectOnsets(guide, SR), detectOnsets(res.channels[0], SR));
    expect(before.meanMs).toBeGreaterThan(40);
    expect(after.matched).toBe(onsets.length);
    expect(after.meanMs).toBeLessThan(15);
    expect(after.meanMs).toBeLessThan(before.meanMs / 3);
    expect(res.channels[0].length).toBe(dub.length);
  });

  it('un double déjà calé reste (presque) intact', () => {
    const res = alignToGuide([guide], [guide.slice()], SR);
    expect(res.meanShiftMs).toBeLessThan(5);
  });
});
