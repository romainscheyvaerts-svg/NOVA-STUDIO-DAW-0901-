import { describe, expect, it } from 'vitest';
import {
  consolidatePlan, copyRange, cutRange, deleteRange, duplicateRange, extractRange, idGenerator, makeSelection, pasteRange,
  removeRange, replaceWithConsolidated, selLength, separateAtSelection, shiftSelection, splitClipAt, tracksBetween, ClipsByTrack,
} from '../utils/timeSelection';
import { TrackType } from '../types';
import { makeClip } from './helpers/fixtures';

const gen = () => idGenerator('t');
const spans = (clips: { start: number; duration: number }[]) =>
  clips.map(c => [Math.round(c.start * 1000) / 1000, Math.round((c.start + c.duration) * 1000) / 1000]).sort((a, b) => a[0] - b[0]);

describe('sélection', () => {
  it('normalisée ; un point = pas de plage', () => {
    expect(makeSelection(5, 2, ['a'])).toEqual({ start: 2, end: 5, trackIds: ['a'] });
    expect(makeSelection(2, 2, ['a'])).toBeNull();
    expect(makeSelection(1, 2, [])).toBeNull();
    expect(selLength({ start: 1, end: 3.5, trackIds: [] })).toBe(2.5);
  });
  it('pistes entre deux pistes (glisser vertical)', () => {
    expect(tracksBetween(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
    expect(tracksBetween(['a', 'b'], 'b', 'zz')).toEqual(['b']);
  });
  it('nudge de la sélection, jamais sous zéro', () => {
    expect(shiftSelection({ start: 1, end: 2, trackIds: [] }, -3)).toMatchObject({ start: 0, end: 1 });
  });
});

describe('séparer', () => {
  it('coupe un clip audio sans fondu à la coupe, offsets continus', () => {
    const c = makeClip({ id: 'c', start: 2, duration: 4, offset: 1, fadeIn: 0.5, fadeOut: 0.5, fadeOutCurve: 'S_CURVE' });
    const [a, b] = splitClipAt(c, 3, 'c2')!;
    expect(a).toMatchObject({ id: 'c', start: 2, duration: 1, offset: 1, fadeIn: 0.5, fadeOut: 0 });
    expect(a.fadeOutCurve).toBeUndefined();
    expect(b).toMatchObject({ id: 'c2', start: 3, duration: 3, offset: 2, fadeIn: 0, fadeOut: 0.5, fadeOutCurve: 'S_CURVE' });
    expect(splitClipAt(c, 2, 'x')).toBeNull();
  });
  it('MIDI : notes réparties et recalées', () => {
    const c = makeClip({ type: TrackType.MIDI, start: 0, duration: 4, notes: [
      { id: 'n1', pitch: 60, start: 0.5, duration: 1, velocity: 100 },
      { id: 'n2', pitch: 62, start: 1.5, duration: 1, velocity: 100 },
      { id: 'n3', pitch: 64, start: 3, duration: 0.5, velocity: 100 },
    ] as any });
    const [a, b] = splitClipAt(c, 2, 'c2')!;
    expect(a.notes!.map(n => [n.start, n.duration])).toEqual([[0.5, 1], [1.5, 0.5]]);
    expect(b.notes!.map(n => [n.start, n.duration])).toEqual([[1, 0.5]]);
    expect(b.offset).toBe(0);
  });
  it('Ctrl+E : aux deux bords, sur les pistes sélectionnées seulement', () => {
    const by: ClipsByTrack = { a: [makeClip({ start: 0, duration: 10 })], b: [makeClip({ start: 0, duration: 10 })] };
    const out = separateAtSelection(by, { start: 2, end: 5, trackIds: ['a'] }, gen());
    expect(spans(out.a)).toEqual([[0, 2], [2, 5], [5, 10]]);
    expect(out.b).toBeUndefined();
    expect(spans(separateAtSelection(by, { start: 4, end: 4, trackIds: ['b'] }, gen()).b)).toEqual([[0, 4], [4, 10]]);
  });
});

describe('couper / copier / coller / supprimer / dupliquer', () => {
  const by = (): ClipsByTrack => ({
    v: [makeClip({ id: 'v1', start: 0, duration: 4 }), makeClip({ id: 'v2', start: 6, duration: 4, offset: 2 })],
    b: [makeClip({ id: 'b1', start: 0, duration: 12 })],
    x: [makeClip({ id: 'x1', start: 0, duration: 12 })],
  });
  const sel = { start: 3, end: 7, trackIds: ['v', 'b'] };

  it('supprimer laisse un blanc et ne touche pas aux autres pistes', () => {
    const out = deleteRange(by(), sel, gen());
    expect(spans(out.v)).toEqual([[0, 3], [7, 10]]);
    expect(spans(out.b)).toEqual([[0, 3], [7, 12]]);
    expect(out.x).toBeUndefined();
    const v2 = out.v.find(c => c.start === 7)!;
    expect(v2.offset).toBeCloseTo(3);   // audio continu
  });

  it('copier : contenu de la plage recalé sur 0', () => {
    const cb = copyRange(by(), sel, gen());
    expect(cb.length).toBe(4);
    expect(spans(cb.lanes[0])).toEqual([[0, 1], [3, 4]]);
    expect(spans(cb.lanes[1])).toEqual([[0, 4]]);
    expect(cb.lanes[1][0].offset).toBe(3);
  });

  it('couper = copier + supprimer', () => {
    const { clips, clipboard } = cutRange(by(), sel, gen());
    expect(spans(clips.v)).toEqual([[0, 3], [7, 10]]);
    expect(spans(clipboard.lanes[0])).toEqual([[0, 1], [3, 4]]);
  });

  it('coller remplace la zone collée (comme Pro Tools), couloir i → piste i', () => {
    const src = by();
    const cb = copyRange(src, sel, gen());
    const out = pasteRange(src, cb, 20, ['x', 'v'], gen());
    expect(spans(out.x)).toEqual([[0, 12], [20, 21], [23, 24]]);
    expect(spans(out.v)).toEqual([[0, 4], [6, 10], [20, 24]]);
    // Collage par-dessus du contenu existant : il est remplacé.
    const over = pasteRange(src, cb, 1, ['b'], gen());
    expect(spans(over.b)).toEqual([[0, 1], [1, 2], [4, 5], [5, 12]]);
    // Identifiants neufs.
    const ids = out.x.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('dupliquer : copie juste après la plage, la sélection suit', () => {
    const { clips, selection } = duplicateRange(by(), sel, gen());
    expect(selection).toMatchObject({ start: 7, end: 11 });
    expect(spans(clips.b)).toEqual([[0, 7], [7, 11], [11, 12]]);
    expect(spans(clips.v)).toEqual([[0, 4], [6, 7], [7, 8], [10, 11]]);
  });

  it('extraire ne garde que l\'intérieur', () => {
    expect(spans(extractRange([makeClip({ start: 0, duration: 2 })], 3, 4, gen()))).toEqual([]);
  });

  it('removeRange sans clip : liste vide', () => {
    expect(removeRange([], 1, 2, gen())).toEqual([]);
  });
});

describe('consolider', () => {
  it('plan : morceaux audibles relatifs à la plage', () => {
    const clips = [
      makeClip({ id: 'a', start: 0, duration: 4, bufferId: 'x' }),
      makeClip({ id: 'b', start: 5, duration: 4, bufferId: 'x' }),
      makeClip({ id: 'm', start: 0, duration: 10, bufferId: 'x', isMuted: true }),
    ];
    const plan = consolidatePlan(clips, 2, 6);
    expect(plan.map(p => [p.clip.id, p.at, p.from, p.to])).toEqual([['a', 0, 2, 4], ['b', 3, 0, 1]]);
  });
  it('remplacement : bords coupés, prises mutées gardées', () => {
    const clips = [
      makeClip({ id: 'a', start: 0, duration: 4 }),
      makeClip({ id: 'b', start: 5, duration: 4 }),
      makeClip({ id: 'm', start: 0, duration: 10, isMuted: true }),
    ];
    const cons = makeClip({ id: 'cons', start: 2, duration: 4 });
    const out = replaceWithConsolidated(clips, 2, 6, cons, gen());
    expect(spans(out.filter(c => !c.isMuted))).toEqual([[0, 2], [2, 6], [6, 9]]);
    expect(out.find(c => c.id === 'm')).toBeTruthy();
  });
});
