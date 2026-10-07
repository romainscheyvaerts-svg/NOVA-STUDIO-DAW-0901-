import { describe, expect, it } from 'vitest';
import { compJunctions, compSwipe, compTapRange, compUsage, compWholeTake, readComp, takeAt, takeSpans } from '../utils/comping';
import { clipGainAt } from '../utils/fades';
import { Clip } from '../types';
import { makeClip } from './helpers/fixtures';

const take = (n: number, start: number, dur: number, over: Partial<Clip> = {}) =>
  makeClip({ id: `t${n}-${start}`, takeNumber: n, name: `Prise ${n}`, start, duration: dur, offset: 0, bufferId: `b${n}`, fadeIn: 0.01, fadeOut: 0.01, ...over });
const beat = () => makeClip({ id: 'beat', name: 'Beat', start: 0, duration: 10, bufferId: 'beat' });
const geo = (cs: Clip[]) => cs.map(c => [c.takeNumber, +c.start.toFixed(4), +(c.start + c.duration).toFixed(4), !!c.isMuted]);
const audibleOf = (cs: Clip[]) => cs.filter(c => c.takeNumber && !c.isMuted).sort((a, b) => a.start - b.start);

describe('comp à la souris (balayage sur un couloir)', () => {
  const base = () => [take(1, 0, 10, { isMuted: true }), take(2, 0, 10), beat()];

  it('la zone balayée passe dans la piste principale, crossfades de 20 ms centrés aux raccords', () => {
    const r = compSwipe(base(), 1, 4, 6);
    expect(r.changed).toBe(true);
    expect(r.zone).toEqual({ start: 4, end: 6 });
    expect(geo(audibleOf(r.clips))).toEqual([[2, 0, 4.01, false], [1, 3.99, 6.01, false], [2, 5.99, 10, false]]);
    const [a, b, c] = audibleOf(r.clips);
    // Bon audio au bon endroit : offset = position dans l'enregistrement.
    expect(b.offset).toBeCloseTo(3.99, 6);
    expect(c.offset).toBeCloseTo(5.99, 6);
    expect([a.fadeOut, a.fadeOutCurve, b.fadeIn, b.fadeInCurve, b.fadeOut, c.fadeIn]).toEqual([0.02, 'EQUAL_POWER', 0.02, 'EQUAL_POWER', 0.02, 0.02]);
    // Fondus d'origine aux vrais bords de la prise.
    expect([a.fadeIn, c.fadeOut]).toEqual([0.01, 0.01]);
    expect(takeAt(r.clips, 5)).toBe(1);
    expect(takeAt(r.clips, 2)).toBe(2);
    expect(compJunctions(r.clips)).toEqual([{ at: 4, from: 2, to: 1 }, { at: 6, from: 1, to: 2 }]);
  });

  it('rien n’est effacé : chaque prise garde tout son audio dans son couloir (passages mutés)', () => {
    const cs = base();
    const r = compSwipe(cs, 1, 4, 6);
    const spans = takeSpans(r.clips);
    expect(spans.map(s => [s.n, s.start, s.end])).toEqual([[1, 0, 10], [2, 0, 10]]);
    expect(geo(r.clips.filter(c => c.isMuted))).toEqual([[1, 0, 4, true], [1, 6, 10, true], [2, 4, 6, true]]);
    expect(r.clips).toContain(cs[2]); // le beat ne bouge pas
    expect(new Set(r.clips.map(c => c.id)).size).toBe(r.clips.length);
  });

  it('puissance constante dans le crossfade (pas de creux ni de bosse)', () => {
    const r = compSwipe(base(), 1, 4, 6);
    const [a, b] = audibleOf(r.clips);
    for (let t = 3.99; t <= 4.01; t += 0.002) {
      const ga = clipGainAt(a, t - a.start), gb = clipGainAt(b, t - b.start);
      expect(ga * ga + gb * gb).toBeCloseTo(1, 2);
    }
  });

  it('refaire le même balayage ne change rien (mêmes pièces, mêmes identifiants)', () => {
    const r1 = compSwipe(base(), 1, 4, 6);
    const r2 = compSwipe(r1.clips, 1, 4, 6);
    expect(geo(r2.clips)).toEqual(geo(r1.clips));
    expect(r2.clips.map(c => c.id).sort()).toEqual(r1.clips.map(c => c.id).sort());
  });

  it('balayages successifs : 2 zones, puis on rend une partie à l’autre prise', () => {
    let cs = compSwipe(base(), 1, 1, 2).clips;
    cs = compSwipe(cs, 1, 5, 7).clips;
    expect(readComp(cs).map(s => [s.n, s.start, s.end])).toEqual([[2, 0, 1], [1, 1, 2], [2, 2, 5], [1, 5, 7], [2, 7, 10]]);
    cs = compSwipe(cs, 2, 6, 8).clips;
    expect(readComp(cs).map(s => [s.n, s.start, s.end])).toEqual([[2, 0, 1], [1, 1, 2], [2, 2, 5], [1, 5, 6], [2, 6, 10]]);
    expect(compUsage(cs).get(1)).toBeCloseTo(2, 6);
  });

  it('la zone est bornée à l’audio de la prise ; trop courte ou vide : rien ne change', () => {
    const cs = [...base(), take(3, 2, 1, { isMuted: true })];
    const r = compSwipe(cs, 3, 0, 10);
    expect(r.zone).toEqual({ start: 2, end: 3 });
    expect(readComp(r.clips).map(s => [s.n, s.start, s.end])).toEqual([[2, 0, 2], [3, 2, 3], [2, 3, 10]]);
    expect(compSwipe(cs, 3, 20, 30)).toMatchObject({ changed: false, zone: null });
    expect(compSwipe(cs, 1, 4, 4.02)).toMatchObject({ changed: false });
    expect(compSwipe(cs, 9, 0, 10).clips).toBe(cs);
  });

  it('au bord de l’audio d’une prise, le crossfade glisse du côté où il y a du son', () => {
    const cs = [take(1, 0, 4, { isMuted: true }), take(2, 0, 10)];
    const r = compSwipe(cs, 1, 0, 4);
    const [a, b] = audibleOf(r.clips);
    expect([a.takeNumber, a.start, a.start + a.duration, a.fadeOut]).toEqual([1, 0, 4, 0.02]);
    expect(b.takeNumber).toBe(2);
    expect(b.start).toBeCloseTo(3.98, 6);
    expect(b.fadeIn).toBeCloseTo(0.02, 6);
  });

  it('garder toute une prise ; tap sur un couloir = le passage du comp à cet endroit', () => {
    const w = compWholeTake(base(), 1);
    expect(readComp(w.clips).map(s => [s.n, s.start, s.end])).toEqual([[1, 0, 10]]);
    const cs = compSwipe(base(), 1, 4, 6).clips;
    expect(compTapRange(cs, 1, 8)).toEqual({ start: 6, end: 10 });
    expect(compTapRange(cs, 2, 5)).toEqual({ start: 4, end: 6 });
    expect(compTapRange(cs, 3, 5)).toBeNull();
  });

  it('prises découpées par le retrait des blancs : recollées par source, trous respectés', () => {
    const p = (s: number, d: number, m: boolean) => take(1, s, d, { id: `p1-${s}`, offset: s, isMuted: m });
    const cs = [p(0, 2, true), p(3, 2, true), take(2, 0, 10)];
    expect(takeSpans(cs).filter(s => s.n === 1).map(s => [s.start, s.end])).toEqual([[0, 2], [3, 5]]);
    const r = compSwipe(cs, 1, 0, 5);
    expect(readComp(r.clips).map(s => [s.n, s.start, s.end])).toEqual([[1, 0, 2], [1, 3, 5], [2, 5, 10]]);
  });

  it('deux balayages bout à bout sur la même prise : un seul clip, pas de creux au milieu', () => {
    let cs = compSwipe(base(), 1, 2, 4).clips;
    cs = compSwipe(cs, 1, 4, 6).clips;
    const t1 = audibleOf(cs).filter(c => c.takeNumber === 1);
    expect(t1).toHaveLength(1);
    expect([+t1[0].start.toFixed(3), +(t1[0].start + t1[0].duration).toFixed(3)]).toEqual([1.99, 6.01]);
  });
});
