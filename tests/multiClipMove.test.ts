import { describe, it, expect } from 'vitest';
import { multiShiftFor, planMultiShift } from '../utils/multiClipMove';

/** Sélection multiple glissée vers une autre piste (tour « édition et navigation », 22/10/2026). */
const order = [
  { id: 'lead', kind: 'AUDIO' }, { id: 'double', kind: 'AUDIO' }, { id: 'back', kind: 'AUDIO' }, { id: 'synth', kind: 'MIDI' }, { id: 'adlib', kind: 'AUDIO' },
];

describe('glisser une sélection de clips vers une autre piste', () => {
  it('toute la sélection descend du même nombre de pistes', () => {
    const items = [{ trackId: 'lead', clipId: 'a' }, { trackId: 'double', clipId: 'b' }];
    expect(multiShiftFor(order, 'double', 'back')).toBe(1);
    expect(planMultiShift(order, items, 1)).toEqual({ shift: 1, dest: { a: 'double', b: 'back' } });
  });
  it('hors des pistes ou sur une piste d’un autre type : refusé', () => {
    const items = [{ trackId: 'lead', clipId: 'a' }, { trackId: 'double', clipId: 'b' }];
    expect(planMultiShift(order, items, -1)).toBeNull();
    expect(planMultiShift(order, items, 2)).toBeNull(); // b tomberait sur la piste MIDI
  });
  it('décalage nul : chaque clip reste (ou revient) sur sa piste', () => {
    const items = [{ trackId: 'lead', clipId: 'a' }, { trackId: 'adlib', clipId: 'c' }];
    expect(planMultiShift(order, items, 0)).toEqual({ shift: 0, dest: { a: 'lead', c: 'adlib' } });
  });
});
