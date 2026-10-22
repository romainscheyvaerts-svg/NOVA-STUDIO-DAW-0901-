import { describe, it, expect } from 'vitest';
import { MidiNote } from '../types';
import { glueNotes, glueWithNext, thicken, usedRows, quantizeInput, fitView, followScroll } from '../utils/pianoRollEdit';

const n = (id: string, pitch: number, start: number, duration: number, extra: Partial<MidiNote> = {}): MidiNote => ({ id, pitch, start, duration, velocity: 0.8, ...extra });

describe('piano roll pratique : souder', () => {
  it('les notes de même hauteur qui se touchent ne font plus qu’une, les autres restent', () => {
    const notes = [n('a', 60, 0, 0.5), n('b', 60, 0.5, 0.5), n('c', 60, 1.5, 0.5), n('d', 64, 0.5, 0.5)];
    const r = glueNotes(notes, null);
    expect(r.merged).toBe(1);
    expect(r.notes.map(x => [x.id, x.pitch, x.start, x.duration])).toEqual([['a', 60, 0, 1], ['d', 64, 0.5, 0.5], ['c', 60, 1.5, 0.5]]);
  });
  it('seulement la sélection ; la première garde sa vélocité et son glissé', () => {
    const notes = [n('a', 60, 0, 0.5, { velocity: 0.3, slide: true }), n('b', 60, 0.5, 0.5), n('c', 60, 1, 0.5)];
    const r = glueNotes(notes, new Set(['a', 'b']));
    expect(r.notes.find(x => x.id === 'a')).toMatchObject({ duration: 1, velocity: 0.3, slide: true });
    expect(r.notes.find(x => x.id === 'c')).toBeTruthy();
  });
  it('outil Souder : la note rejoint la suivante de même hauteur, même avec un écart', () => {
    const notes = [n('a', 60, 0, 0.25), n('b', 60, 1, 0.5), n('x', 62, 0.5, 0.25)];
    const r = glueWithNext(notes, 'a');
    expect(r.ok).toBe(true);
    expect(r.notes.map(x => x.id).sort()).toEqual(['a', 'x']);
    expect(r.notes.find(x => x.id === 'a')!.duration).toBeCloseTo(1.5);
    expect(glueWithNext(notes, 'b').ok).toBe(false);
  });
});

describe('piano roll pratique : épaissir', () => {
  it('ajoute l’octave au-dessus, un peu moins forte, sans glissé ni doublon', () => {
    let k = 0;
    const notes = [n('a', 60, 0, 1, { slide: true }), n('b', 72, 0, 1)];
    const r = thicken(notes, new Set(['a', 'b']), 12, () => `t${k++}`);
    expect(r.added.map(x => x.pitch)).toEqual([84]);           // 60 + 12 existe déjà (72)
    expect(r.added[0].velocity).toBeCloseTo(0.68);
    const r2 = thicken([n('a', 60, 0, 1, { slide: true })], null, -12, () => 'z');
    expect(r2.added[0]).toMatchObject({ pitch: 48, start: 0, duration: 1 });
    expect(r2.added[0].slide).toBeUndefined();
  });
  it('reste dans 0-127', () => {
    expect(thicken([n('a', 120, 0, 1)], null, 12).added).toEqual([]);
  });
});

describe('piano roll pratique : vue et prise', () => {
  it('replier aux notes utilisées : de l’aigu au grave, sans doublon', () => {
    expect(usedRows([n('a', 60, 0, 1), n('b', 67, 0, 1), n('c', 60, 1, 1)])).toEqual([67, 60]);
    expect(usedRows([])).toEqual([]);
  });
  it('quantification d’entrée : le début va sur la grille, la longueur reste', () => {
    const g = 0.125;
    const out = quantizeInput([{ start: 0.137, duration: 0.2 }, { start: 0.49, duration: 0.001 }], t => Math.round(t / g) * g, 0.02);
    expect(out[0].start).toBeCloseTo(0.125);
    expect(out[0].duration).toBeCloseTo(0.2);
    expect(out[1].start).toBeCloseTo(0.5);
    expect(out[1].duration).toBeCloseTo(0.02);
  });
  it('zoom sur la sélection : le passage remplit la vue, dans les bornes', () => {
    const f = fitView({ t0: 2, t1: 4, rowTop: 50, rowBottom: 59, viewW: 1000, viewH: 600, zoomMin: 20, zoomMax: 600, rowMin: 8, rowMax: 32 });
    expect(f.zoomX).toBeCloseTo(430);
    expect(f.rowH).toBe(32);
    expect(f.scrollLeft).toBeCloseTo(2 * 430 - (1000 - 860) / 2);
    expect(fitView({ t0: 0, t1: 0.001, rowTop: 0, rowBottom: 127, viewW: 800, viewH: 400, zoomMin: 20, zoomMax: 600, rowMin: 8, rowMax: 32 })).toMatchObject({ zoomX: 600, rowH: 8 });
  });
  it('suivre la lecture : on tourne la page seulement quand la tête sort de la vue', () => {
    expect(followScroll(500, 0, 1000)).toBeNull();
    expect(followScroll(990, 0, 1000)).toBe(966);
    expect(followScroll(100, 400, 1000)).toBe(76);
  });
});
