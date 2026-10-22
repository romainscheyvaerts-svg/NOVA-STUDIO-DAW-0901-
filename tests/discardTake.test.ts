import { describe, expect, it } from 'vitest';
import { findConflicts, KEYMAP } from '../utils/keymap';

/**
 * Séance d'enregistrement voix (audit du 22/10/2026) : jeter la prise en cours (Ctrl+.).
 */

describe('Jeter la prise en cours (Ctrl+.)', () => {
  it('raccourci déclaré, sans conflit', () => {
    const d = KEYMAP.find(s => s.id === 'nova.discardTake')!;
    expect(d.keys).toEqual(['ctrl+.', 'ctrl+numdec']);
    expect(findConflicts().filter(c => c.includes('ctrl+.') || c.includes('ctrl+numdec'))).toEqual([]);
  });
});
