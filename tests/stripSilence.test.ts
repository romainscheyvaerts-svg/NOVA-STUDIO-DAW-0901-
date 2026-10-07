import { describe, expect, it } from 'vitest';
import { detectVoiceSegments, stripSilenceFromClip } from '../utils/stripSilence';
import { FakeAudioBuffer } from './helpers/audio';
import { makeClip } from './helpers/fixtures';

const SR = 8000;

/** Prise synthétique : bruit de fond faible + passages « chantés » [début, fin] en secondes. */
const take = (seconds: number, loud: [number, number][]) => {
  const b = new FakeAudioBuffer({ numberOfChannels: 1, length: Math.round(seconds * SR), sampleRate: SR });
  const d = b.getChannelData(0);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = 0; i < d.length; i++) d[i] = rnd() * 0.002; // ≈ -60 dBFS
  for (const [a, z] of loud) {
    for (let i = Math.round(a * SR); i < Math.round(z * SR); i++) d[i] = 0.5 * Math.sin(i * 0.3);
  }
  return b as unknown as AudioBuffer;
};

describe('detectVoiceSegments', () => {
  it('garde les vraies phrases séparées par un vrai blanc', () => {
    const segs = detectVoiceSegments(take(8, [[0.5, 2.5], [4.5, 6.5]]));
    expect(segs).toHaveLength(2);
  });

  it('pas de miettes : un mot bref proche d\'une phrase lui est rattaché', () => {
    // phrase, puis 0,15 s de son 0,8 s plus tard
    const segs = detectVoiceSegments(take(6, [[0.5, 2.5], [3.3, 3.45]]));
    expect(segs).toHaveLength(1);
    expect(segs[0].end).toBeGreaterThan(3.45);
  });

  it('un bruit très bref et isolé (clic de souris en arrêtant REC) est retiré', () => {
    const segs = detectVoiceSegments(take(8, [[0.5, 2.5], [6.5, 6.6]]));
    expect(segs).toHaveLength(1);
    expect(segs[0].end).toBeLessThan(3);
  });

  it('une prise qui ne contient qu\'un son bref le garde', () => {
    const segs = detectVoiceSegments(take(4, [[1, 1.2]]));
    expect(segs).toHaveLength(1);
  });
});

describe('stripSilenceFromClip', () => {
  it('aucun clip de moins d\'une demi-seconde sur la piste', () => {
    const buf = take(10, [[0.3, 2.2], [2.9, 3.05], [3.6, 3.75], [6.0, 8.0], [9.5, 9.58]]);
    const res = stripSilenceFromClip(makeClip({ id: 'p', name: 'Prise 1', start: 0, offset: 0, duration: 10 }), buf);
    expect(res).not.toBeNull();
    for (const c of res!.clips) expect(c.duration).toBeGreaterThanOrEqual(0.5);
    expect(res!.clips.map(c => c.name)).toEqual(['Prise 1 (partie 1)', 'Prise 1 (partie 2)', 'Prise 1 (partie 3)']);
  });
});
