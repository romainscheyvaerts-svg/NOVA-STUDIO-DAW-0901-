import { describe, it, expect } from 'vitest';
import { planDuplicate } from '../utils/duplicateClips';

/** Ctrl+D (tour « édition et navigation », 22/10/2026). */
describe('dupliquer des clips', () => {
  let n = 0;
  const id = () => `d${++n}`;
  it('un clip : la copie se pose juste après, sans trou', () => {
    expect(planDuplicate([{ trackId: 't', clip: { id: 'a', start: 2, duration: 4 } }], id)).toEqual([{ trackId: 't', clipId: 'a', start: 6, id: 'd1' }]);
  });
  it('plusieurs clips : en bloc après la fin de la sélection, écarts gardés', () => {
    const p = planDuplicate([
      { trackId: 't1', clip: { id: 'a', start: 0, duration: 4 } },
      { trackId: 't1', clip: { id: 'b', start: 4, duration: 4 } },
      { trackId: 't2', clip: { id: 'c', start: 1, duration: 2 } },
    ], id);
    expect(p.map(x => [x.clipId, x.start])).toEqual([['a', 8], ['b', 12], ['c', 9]]);
  });
  it('sans sélection : rien', () => {
    expect(planDuplicate([])).toEqual([]);
  });
});
