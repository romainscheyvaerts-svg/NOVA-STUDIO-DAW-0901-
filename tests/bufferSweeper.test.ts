import { describe, expect, it } from 'vitest';
import { BufferSweeper } from '../utils/bufferSweeper';

describe('Libération des sons inutiles (BufferSweeper)', () => {
  it('un son vu dans le projet puis plus cité est libéré après le délai de grâce', () => {
    const s = new BufferSweeper(60_000);
    expect(s.sweep(['a', 'b'], new Set(['a', 'b']), 0)).toEqual([]);
    expect(s.sweep(['a', 'b'], new Set(['a']), 10_000)).toEqual([]);       // b orphelin depuis 10 s
    expect(s.sweep(['a', 'b'], new Set(['a']), 69_999)).toEqual([]);
    expect(s.sweep(['a', 'b'], new Set(['a']), 70_000)).toEqual(['b']);
  });
  it('jamais vu dans le projet (opération en cours) : jamais libéré', () => {
    const s = new BufferSweeper(1000);
    for (let t = 0; t < 100_000; t += 10_000) expect(s.sweep(['tmp'], new Set(), t)).toEqual([]);
  });
  it('de nouveau cité (annuler) pendant le délai : gardé, le délai repart de zéro', () => {
    const s = new BufferSweeper(60_000);
    s.sweep(['x'], new Set(['x']), 0);
    s.sweep(['x'], new Set(), 1000);
    s.sweep(['x'], new Set(['x']), 50_000);
    expect(s.sweep(['x'], new Set(), 70_000)).toEqual([]);
    expect(s.sweep(['x'], new Set(), 130_000)).toEqual(['x']);
  });
  it('un son libéré ailleurs est oublié (pas de liste qui grossit)', () => {
    const s = new BufferSweeper(1000);
    s.sweep(['a'], new Set(['a']), 0);
    s.sweep([], new Set(), 10);
    expect((s as any).seen.size).toBe(0);
  });
});
