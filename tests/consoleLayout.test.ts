import { describe, expect, it } from 'vitest';
import { consoleSections, insertAreaHeight } from '../utils/insertRows';

describe('console à la taille de la séance', () => {
  it('lignes d\'effets : la plus longue chaîne + 1, entre 4 et 8 ; au doigt 5', () => {
    expect(consoleSections(0, false, false, false)).toEqual({ insertRows: 4, showSends: false });
    expect(consoleSections(2, false, false, false).insertRows).toBe(4);
    expect(consoleSections(5, true, false, false)).toEqual({ insertRows: 6, showSends: true });
    expect(consoleSections(12, false, false, false).insertRows).toBe(8);
    expect(consoleSections(1, false, true, false).insertRows).toBe(5);
    expect(consoleSections(1, false, false, true).showSends).toBe(true);
  });
  it('hauteur de la zone d\'effets : 4 lignes ≈ 117 px (avant : 200 px réservés)', () => {
    expect(insertAreaHeight(4, false)).toBe(117);
    expect(insertAreaHeight(8, false)).toBe(205);
    expect(insertAreaHeight(4, true)).toBe(212);
  });
});
