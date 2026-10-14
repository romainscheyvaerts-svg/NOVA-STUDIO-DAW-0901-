import { describe, expect, it } from 'vitest';
import { blockClockSource, framesSkipped, type BlockClockState } from '../engine/blockClock';

/** Rejoue une suite d'étiquettes currentFrame ; renvoie les sauts vus à chaque bloc. */
const replay = (fn: typeof framesSkipped, labels: number[], n = 128) => {
  const st: BlockClockState = { next: -1 };
  return { skips: labels.map(f => fn(st, f, n)), st };
};

describe('Horloge des blocs d’un worklet (engine/blockClock)', () => {
  it('étiquettes justes : aucun saut', () => {
    expect(replay(framesSkipped, [0, 128, 256, 384]).skips).toEqual([0, 0, 0, 0]);
  });

  it('chaîne décâblée (veille) : les blocs sautés sont comptés comme avant', () => {
    // Ancienne règle : currentFrame − dernier − 128 = 1024 − 128 − 128 = 768.
    const { skips, st } = replay(framesSkipped, [0, 128, 1024, 1152]);
    expect(skips).toEqual([0, 0, 768, 0]);
    expect(st.next).toBe(1280);
  });

  it('Chrome sous charge : même currentFrame sur plusieurs blocs puis rattrapage, ce n’est PAS une veille', () => {
    // Mesuré le 14/10/2026 : étiquettes en retard de 128 puis 256, puis justes.
    const { skips, st } = replay(framesSkipped, [0, 128, 128, 128, 512, 640]);
    expect(skips).toEqual([0, 0, 0, 0, 0, 0]);
    expect(st.next).toBe(768);
    // L'ancienne règle y voyait 256 échantillons sautés (rattrapage sur un signal réel).
    let last = -1; const old: number[] = [];
    for (const f of [0, 128, 128, 128, 512, 640]) { old.push(last >= 0 && f > last + 128 ? f - last - 128 : 0); last = f; }
    expect(old.reduce((a, b) => a + b, 0)).toBe(256);
  });

  it('veille pendant une rafale en retard : seul le vrai saut est rattrapé', () => {
    const { skips } = replay(framesSkipped, [0, 128, 128, 2048, 2176]);
    // Blocs calculés : 0, 128, 256 (étiqueté 128) ; la veille reprend à 2048 : 2048 − 384 sautés.
    expect(skips).toEqual([0, 0, 0, 1664, 0]);
  });

  it('le code injecté dans les worklets se comporte pareil', () => {
    const injected = new Function(`${blockClockSource()}return framesSkipped;`)() as typeof framesSkipped;
    const labels = [0, 128, 128, 128, 512, 4096, 4224, 4224, 4480];
    expect(replay(injected, labels).skips).toEqual(replay(framesSkipped, labels).skips);
  });
});
