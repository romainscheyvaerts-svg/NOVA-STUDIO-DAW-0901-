import { describe, expect, it } from 'vitest';
import { splitInserts } from '../utils/insertRows';

describe('splitInserts (B5 : effets de la console)', () => {
  const fx = ['Anti-bruit', 'Nova Tune', 'Égaliseur', 'Comp', 'Comp 2', 'De-esser', 'Saturation', 'Doubleur'];
  it('les 8 effets de « Trap autotune » tiennent tous à la souris', () => {
    expect(splitInserts(fx, 8)).toEqual({ shown: fx, hidden: [] });
  });
  it('au doigt (5 lignes) : 4 effets + « +4 »', () => {
    const r = splitInserts(fx, 5);
    expect(r.shown).toEqual(fx.slice(0, 4));
    expect(r.hidden).toHaveLength(4);
  });
  it('9 effets à la souris : 7 + « +2 »', () => {
    const r = splitInserts([...fx, 'Stéréo'], 8);
    expect(r.shown).toHaveLength(7);
    expect(r.hidden).toEqual(['Doubleur', 'Stéréo']);
  });
  it('aucun effet', () => {
    expect(splitInserts([], 8)).toEqual({ shown: [], hidden: [] });
  });
});
