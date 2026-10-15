import { describe, it, expect } from 'vitest';
import { MidiNote } from '../types';
import {
  GRID_CHOICES, gridSec, snapTime, floorTime, paintNotes, splitNoteAt, duplicateRight, duplicateSpan, copyNotes, pasteNotes,
  humanize, randomVelocity, toggleSlide, absorbedSlides, slideOrigins, velocityColor,
} from '../utils/pianoRollPro';
import { quantize } from '../utils/midiTools';
import { buildChord, isInScale, snapToScale, scaleRows, chordLabelFr } from '../utils/scales';
import { plan808 } from '../utils/bass808';

const BPM = 120; // un temps = 0,5 s, une mesure = 2 s
const n = (id: string, pitch: number, start: number, duration = 0.25, velocity = 0.8, extra: Partial<MidiNote> = {}): MidiNote => ({ id, pitch, start, duration, velocity, ...extra });
let k = 0;
const ids = () => `t${k++}`;

describe('grille', () => {
  it('propose 1/1 à 1/64 et les triolets', () => {
    const idsList = GRID_CHOICES.map(g => g.id);
    ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/4T', '1/8T', '1/16T', '1/32T'].forEach(id => expect(idsList).toContain(id));
    expect(gridSec('1/16', BPM)).toBeCloseTo(0.125);
    expect(gridSec('1/64', BPM)).toBeCloseTo(0.03125);
    expect(gridSec('1/8T', BPM)).toBeCloseTo(0.5 / 3);
    expect(gridSec('1/16T', BPM) * 6).toBeCloseTo(0.5); // 6 triolets de doubles par temps
  });

  it('cale sur la grille du morceau, même quand le clip commence hors grille', () => {
    expect(snapTime(0.3, 0.125)).toBeCloseTo(0.25);
    // Clip à 0,05 s : la case la plus proche de 0,3 s dans le morceau est 0,375 s → 0,325 s dans le clip.
    expect(snapTime(0.3, 0.125, 0.05)).toBeCloseTo(0.325);
    expect(floorTime(0.24, 0.125)).toBeCloseTo(0.125);
    // Magnétisme coupé : temps inchangé.
    expect(snapTime(0.3, 0.125, 0, false)).toBe(0.3);
  });
});

describe('quantification (force, swing, fins)', () => {
  const notes = [n('a', 60, 0.02), n('b', 62, 0.27), n('c', 64, 0.49, 0.2), n('d', 65, 0.77)];
  it('100 % : pile sur la grille 1/8', () => {
    const q = quantize(notes, null, { bpm: BPM }, { grid: '1/8', strength: 1, swing: 50 });
    expect(q.map(x => +x.start.toFixed(4))).toEqual([0, 0.25, 0.5, 0.75]);
  });
  it('50 % : à mi-chemin', () => {
    const q = quantize(notes, null, { bpm: BPM }, { grid: '1/8', strength: 0.5, swing: 50 });
    expect(q.find(x => x.id === 'a')!.start).toBeCloseTo(0.01);
    expect(q.find(x => x.id === 'b')!.start).toBeCloseTo(0.26);
  });
  it('swing 66 % : les contretemps reculent d’un tiers de case (ternaire)', () => {
    const q = quantize(notes, null, { bpm: BPM }, { grid: '1/8', strength: 1, swing: 66 });
    expect(q.find(x => x.id === 'a')!.start).toBeCloseTo(0);
    expect(q.find(x => x.id === 'b')!.start).toBeCloseTo(0.25 + 0.32 * 0.25, 3);
    expect(q.find(x => x.id === 'c')!.start).toBeCloseTo(0.5);
  });
  it('triolets 1/8T et fins de notes', () => {
    const q = quantize([n('a', 60, 0.18, 0.15)], null, { bpm: BPM }, { grid: '1/8T', strength: 1, swing: 50, ends: true });
    expect(q[0].start).toBeCloseTo(1 / 6);
    expect(q[0].start + q[0].duration).toBeCloseTo(2 / 6);
  });
  it('seule la sélection bouge', () => {
    const q = quantize(notes, new Set(['b']), { bpm: BPM }, { grid: '1/8', strength: 1, swing: 50 });
    expect(q.find(x => x.id === 'a')!.start).toBe(0.02);
    expect(q.find(x => x.id === 'b')!.start).toBeCloseTo(0.25);
  });
  it('grilles 1/1, 1/2 et 1/4T reconnues', () => {
    expect(quantize([n('a', 60, 1.1)], null, { bpm: BPM }, { grid: '1/1', strength: 1, swing: 50 })[0].start).toBeCloseTo(2);
    expect(quantize([n('a', 60, 0.4)], null, { bpm: BPM }, { grid: '1/2', strength: 1, swing: 50 })[0].start).toBeCloseTo(0);
    expect(quantize([n('a', 60, 0.3)], null, { bpm: BPM }, { grid: '1/4T', strength: 1, swing: 50 })[0].start).toBeCloseTo(1 / 3);
  });
});

describe('accords et gammes', () => {
  it('accord mineur 7 et ses renversements', () => {
    expect(buildChord(57, 'MIN7')).toEqual([57, 60, 64, 67]);
    expect(buildChord(57, 'MIN7', { inversion: 1 })).toEqual([60, 64, 67, 69]);
    expect(buildChord(57, 'MIN7', { inversion: 2 })).toEqual([64, 67, 69, 72]);
    expect(chordLabelFr(buildChord(57, 'MIN7'))).toBe('La mineur 7');
    // Renversements reconnus (retour affiché quand on pose l'accord).
    expect(chordLabelFr([60, 64, 69])).toBe('La mineur (1er renversement)');
    expect(chordLabelFr([64, 69, 72])).toBe('La mineur (2e renversement)');
  });
  it('accord de la gamme : triades justes en La mineur', () => {
    // Degré II de La mineur = Si diminué ; degré III = Do majeur.
    expect(buildChord(59, 'SCALE', { root: 9, scale: 'MINOR', snap: true })).toEqual([59, 62, 65]);
    expect(buildChord(60, 'SCALE', { root: 9, scale: 'MINOR', snap: true })).toEqual([60, 64, 67]);
    buildChord(61, 'SCALE', { root: 9, scale: 'MINOR', snap: true }).forEach(p => expect(isInScale(p, 9, 'MINOR')).toBe(true));
  });
  it('aimant et « seulement la gamme »', () => {
    expect(snapToScale(61, 9, 'MINOR')).toBe(60); // Do# → Do en La mineur
    const rows = scaleRows(9, 'MINOR', true);
    expect(rows.every(p => isInScale(p, 9, 'MINOR'))).toBe(true);
    expect(rows[0]).toBeGreaterThan(rows[rows.length - 1]); // de haut en bas
  });
});

describe('glissés (FL : Slide notes)', () => {
  it('un glissé posé pendant une note tenue est porté (ni attaque ni relâchement)', () => {
    const host = n('h', 36, 0, 2);
    const sl = n('s', 43, 1, 0.2, 0.8, { slide: true });
    const alone = n('x', 48, 3, 0.5, 0.8, { slide: true });
    const notes = [host, sl, alone];
    const abs = absorbedSlides(notes);
    expect(abs.has(sl)).toBe(true);
    expect(abs.has(alone)).toBe(false); // rien ne sonne : jouée comme une note normale
    expect(abs.has(host)).toBe(false);
    // Mémorisé : même tableau, même ensemble.
    expect(absorbedSlides(notes)).toBe(abs);
  });
  it('les glissés s’enchaînent : chacun part de la hauteur du précédent', () => {
    const notes = [n('h', 36, 0, 4), n('s1', 43, 1, 0.2, 0.8, { slide: true }), n('s2', 31, 2, 0.2, 0.8, { slide: true })];
    const o = slideOrigins(notes);
    expect(o.get('s1')).toBe(36);
    expect(o.get('s2')).toBe(43);
  });
  it('un glissé qui commence pile à la fin d’une note n’est pas porté', () => {
    const notes = [n('h', 36, 0, 1), n('s', 43, 1, 0.2, 0.8, { slide: true })];
    expect(absorbedSlides(notes).size).toBe(0);
  });
  it('basculer : tout glissé, puis tout normal', () => {
    const notes = [n('a', 36, 0), n('b', 38, 1, 0.25, 0.8, { slide: true })];
    const on = toggleSlide(notes, new Set(['a', 'b']));
    expect(on.on).toBe(true);
    expect(on.notes.every(x => x.slide)).toBe(true);
    const off = toggleSlide(on.notes, new Set(['a', 'b']));
    expect(off.on).toBe(false);
    expect(off.notes.every(x => !('slide' in x))).toBe(true);
  });
  it('808 : le glissé fait glisser la voix sans la rejouer ni la prolonger', () => {
    const v = plan808([{ pitch: 36, start: 0, duration: 2, velocity: 0.9 }, { pitch: 43, start: 1, duration: 0.2, velocity: 0.9, slide: true }], false);
    expect(v).toHaveLength(1);
    expect(v[0].steps).toEqual([{ t: 0, pitch: 36 }, { t: 1, pitch: 43 }]);
    expect(v[0].end).toBe(2);
    // Sans glissé ni réglage « glide » : la 2e note coupe la première (comportement d'avant).
    const w = plan808([{ pitch: 36, start: 0, duration: 2, velocity: 0.9 }, { pitch: 43, start: 1, duration: 0.2, velocity: 0.9 }], false);
    expect(w).toHaveLength(2);
  });
});

describe('humaniser et vélocité', () => {
  const notes = [n('a', 60, 0.5), n('b', 64, 0.5), n('c', 67, 1)];
  it('reste dans les bornes et ne bouge pas un accord en morceaux', () => {
    const h = humanize(notes, null, { timingMs: 20, velocity: 0.1, length: 0.1, seed: 42 });
    const a = h.find(x => x.id === 'a')!, b = h.find(x => x.id === 'b')!, c = h.find(x => x.id === 'c')!;
    expect(a.start).toBeCloseTo(b.start, 9); // même départ : l'accord bouge d'un bloc
    for (const x of h) {
      const o = notes.find(y => y.id === x.id)!;
      expect(Math.abs(x.start - o.start)).toBeLessThanOrEqual(0.02 + 1e-9);
      expect(Math.abs(x.velocity - o.velocity)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(x.duration / o.duration).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(x.duration / o.duration).toBeLessThanOrEqual(1.1 + 1e-9);
    }
    expect(c.start).not.toBe(1);
  });
  it('reproductible avec la même graine, différent avec une autre', () => {
    const a = humanize(notes, null, { timingMs: 20, velocity: 0.1, seed: 7 });
    const b = humanize(notes, null, { timingMs: 20, velocity: 0.1, seed: 7 });
    const c = humanize(notes, null, { timingMs: 20, velocity: 0.1, seed: 8 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
  it('ne touche que la sélection', () => {
    const h = humanize(notes, new Set(['c']), { timingMs: 20, velocity: 0.1, seed: 3 });
    expect(h.find(x => x.id === 'a')).toEqual(notes[0]);
  });
  it('vélocité aléatoire entre deux bornes (hi-hats)', () => {
    const r = randomVelocity(notes, null, 0.4, 0.7, 5);
    r.forEach(x => { expect(x.velocity).toBeGreaterThanOrEqual(0.4); expect(x.velocity).toBeLessThanOrEqual(0.7); });
  });
  it('couleur selon la vélocité : violet doux → rouge fort', () => {
    expect(velocityColor(0)).toMatch(/^hsl\(265 /);
    expect(velocityColor(1)).toMatch(/^hsl\(0 /);
    expect(velocityColor(0.5, true)).toContain('42%');
  });
});

describe('pinceau, couteau, dupliquer, copier / coller', () => {
  it('le pinceau peint une note par case, sans repeindre une case occupée', () => {
    const existing = [n('e', 42, 0.25, 0.1)];
    const p = paintNotes({ from: 0, to: 0.9, pitch: 42, step: 0.125, length: 0.1, velocity: 0.7, existing, makeId: ids });
    expect(p.map(x => x.start)).toEqual([0, 0.125, 0.375, 0.5, 0.625, 0.75, 0.875]);
    // De droite à gauche : mêmes cases.
    expect(paintNotes({ from: 0.9, to: 0, pitch: 42, step: 0.125, length: 0.1, velocity: 0.7, existing, makeId: ids }).length).toBe(7);
  });
  it('le couteau coupe une note en deux (la 2e moitié n’est plus glissée)', () => {
    const r = splitNoteAt([n('a', 60, 0, 1, 0.8, { slide: true })], 'a', 0.25, () => 'b');
    expect(r.newId).toBe('b');
    expect(r.notes.map(x => [x.id, x.start, x.duration])).toEqual([['a', 0, 0.25], ['b', 0.25, 0.75]]);
    expect(r.notes[1].slide).toBeUndefined();
    // Hors de la note : rien ne change.
    expect(splitNoteAt([n('a', 60, 0, 1)], 'a', 1.5).newId).toBeNull();
  });
  it('Ctrl+B : un motif d’une mesure se recopie sur la mesure suivante', () => {
    const bar = 2, grid = 0.125;
    const motif = [n('a', 60, 0, 0.25), n('b', 62, 1.5, 0.25)]; // finit à 1,75 s, plus des 3/4 de la mesure
    expect(duplicateSpan(motif, grid, bar).span).toBe(2);
    const r = duplicateRight(motif, new Set(['a', 'b']), grid, bar, ids);
    expect(r.added.map(x => x.start)).toEqual([2, 3.5]);
    // Petit motif : arrondi à la grille.
    expect(duplicateSpan([n('a', 60, 0, 0.3)], grid, bar).span).toBeCloseTo(0.375);
  });
  it('copier / coller garde l’écart entre les notes', () => {
    const notes = [n('a', 60, 1, 0.25), n('b', 64, 1.5, 0.25), n('c', 67, 3)];
    const cb = copyNotes(notes, new Set(['a', 'b']))!;
    expect(cb.notes.map(x => x.start)).toEqual([0, 0.5]);
    expect(cb.span).toBeCloseTo(0.75);
    const r = pasteNotes(notes, cb, 4, ids);
    expect(r.added.map(x => [x.pitch, x.start])).toEqual([[60, 4], [64, 4.5]]);
    expect(r.notes).toHaveLength(5);
    expect(copyNotes(notes, new Set())).toBeNull();
  });
});
