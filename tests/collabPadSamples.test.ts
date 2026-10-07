import { describe, expect, it } from 'vitest';
import { contentBufferIds } from '../services/Collab';

describe('collaboration : le son des pads perso voyage avec la batterie', () => {
  it('les samples perso de la machine à rythmes sont dans l’audio envoyé', () => {
    const t: any = { id: 'drums', clips: [{ id: 'c1', bufferId: 'b1' }], drumMachine: { rows: [], samples: { s1: { name: 'Kick perso' }, s2: { name: 'Tranche 3' } } } };
    expect(contentBufferIds(t).sort()).toEqual(['b1', 'padsample-s1', 'padsample-s2']);
  });
  it('sans samples perso, rien de plus', () => {
    const t: any = { id: 'drums', clips: [{ id: 'c1', bufferId: 'b1' }], drumMachine: { rows: [] } };
    expect(contentBufferIds(t)).toEqual(['b1']);
  });
});
