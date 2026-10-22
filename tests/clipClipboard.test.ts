import { describe, it, expect } from 'vitest';
import { buildClipboard, planPaste } from '../utils/clipClipboard';

/** Copier / couper / coller plusieurs clips (tour « édition et navigation », 22/10/2026). */
const clip = (id: string, start: number) => ({ id, name: id, type: 'AUDIO', start, duration: 2, offset: 0 }) as any;
const tracks = [
  { id: 'lead', type: 'AUDIO', clips: [clip('a', 10), clip('b', 14)] },
  { id: 'double', type: 'AUDIO', clips: [clip('c', 11)] },
  { id: 'synth', type: 'MIDI', clips: [] },
  { id: 'back', type: 'AUDIO', clips: [] },
  { id: 'master', type: 'BUS', clips: [] },
] as any[];

describe('presse-papiers de plusieurs clips', () => {
  it('tous les clips, avec leurs écarts et leurs pistes relatives', () => {
    const e = buildClipboard(tracks, [{ trackId: 'lead', clipId: 'a' }, { trackId: 'lead', clipId: 'b' }, { trackId: 'double', clipId: 'c' }]);
    expect(e.map(x => [x.clip.id, x.dt, x.dTrack])).toEqual([['a', 0, 0], ['b', 4, 0], ['c', 1, 1]]);
  });
  it('collé à la tête de lecture sur la piste choisie ; piste d’un autre type : reste sur la piste choisie', () => {
    const e = buildClipboard(tracks, [{ trackId: 'lead', clipId: 'a' }, { trackId: 'double', clipId: 'c' }]);
    expect(planPaste(tracks, e, 'double', 60).map(p => [p.clip.id, p.trackId, p.start])).toEqual([['a', 'double', 60], ['c', 'double', 61]]);
    expect(planPaste(tracks, e, 'lead', 30).map(p => [p.clip.id, p.trackId, p.start])).toEqual([['a', 'lead', 30], ['c', 'double', 31]]);
  });
});
