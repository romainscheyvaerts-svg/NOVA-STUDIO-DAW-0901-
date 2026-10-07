import { beforeEach, describe, expect, it } from 'vitest';
import {
  chooseEditMode, DEFAULT_EDIT_MODE, editModeStore, effectiveMode, moveClipStart, sanitizeEditMode, snapPoint,
  syncOffsetOf, syncPointAt, toggleShuffleLock, toSample,
} from '../utils/editModes';
import { closeRange, detachCrossfades, shuffleInsert, shuffleMove, shuffleRemove, shuffleTrimEnd, shuffleTrimStart } from '../utils/shuffle';
import {
  anchorTime, formatBars, formatMinSec, formatSamples, originalStartOf, parseBars, parseMinSec, parseSamples, parseSpot, spotStart,
} from '../utils/spotTime';
import { clipTransients, detectTransients, nextIn } from '../utils/transients';
import { findConflicts, findShortcut } from '../utils/keymap';
import { makeClip } from './helpers/fixtures';
import type { Clip } from '../types';

const BPM = 120; // grille 1/4 = 0,5 s
const grid = (mode: 'GRID' | 'SLIP' | 'SPOT' | 'SHUFFLE', gridKind: 'ABSOLUTE' | 'RELATIVE' = 'ABSOLUTE') => ({ mode, gridKind, gridSize: '1/4' });
const spans = (clips: Clip[]) => clips.slice().sort((a, b) => a.start - b.start).map(c => [c.id, +c.start.toFixed(4), +(c.start + c.duration).toFixed(4)]);
const C = (id: string, start: number, duration: number, over: Partial<Clip> = {}) => makeClip({ id, start, duration, ...over });

describe('modes Grid / Slip : position d’un clip déplacé', () => {
  it('Slip : libre, arrondi à l’échantillon (48 kHz)', () => {
    const r = moveClipStart({ settings: grid('SLIP'), bpm: BPM, origStart: 0.13, rawStart: 1.23456789 });
    expect(r).toBe(Math.round(1.23456789 * 48000) / 48000);
    expect(Math.abs(r * 48000 - Math.round(r * 48000))).toBeLessThan(1e-6);
  });
  it('Grid absolu : le début tombe sur la grille', () => {
    expect(moveClipStart({ settings: grid('GRID'), bpm: BPM, origStart: 0.13, rawStart: 1.37 })).toBeCloseTo(1.5);
  });
  it('Grid relatif : le clip garde son décalage d’origine par rapport à la grille', () => {
    const r = moveClipStart({ settings: grid('GRID', 'RELATIVE'), bpm: BPM, origStart: 0.13, rawStart: 1.37 });
    expect(r).toBeCloseTo(1.13);
    expect(((r % 0.5) + 0.5) % 0.5).toBeCloseTo(0.13);
    // vers la gauche, sans passer sous zéro : reste à 0,13 (un pas de grille plus loin)
    expect(moveClipStart({ settings: grid('GRID', 'RELATIVE'), bpm: BPM, origStart: 0.13, rawStart: -0.6 })).toBeCloseTo(0.13);
  });
  it('Grid absolu : c’est le point de synchro qui se cale, pas le début', () => {
    // point de synchro 0,2 s après le début : il doit tomber sur 1,5 s → début 1,3 s
    expect(moveClipStart({ settings: grid('GRID'), bpm: BPM, origStart: 0, rawStart: 1.37, syncOffset: 0.2 })).toBeCloseTo(1.3);
  });
  it('touche d’inversion : Grid → Slip, Slip → Grid (absolu), Shuffle reste Shuffle', () => {
    expect(effectiveMode(grid('GRID', 'RELATIVE'), true)).toBe('SLIP');
    expect(effectiveMode(grid('SLIP'), true)).toBe('GRID_ABS');
    expect(effectiveMode(grid('SPOT'), true)).toBe('GRID_ABS');
    expect(effectiveMode(grid('SHUFFLE'), true)).toBe('SHUFFLE');
    expect(moveClipStart({ settings: grid('GRID'), invert: true, bpm: BPM, origStart: 0, rawStart: 1.37 })).toBeCloseTo(1.37);
    expect(moveClipStart({ settings: grid('SLIP'), invert: true, bpm: BPM, origStart: 0, rawStart: 1.37 })).toBeCloseTo(1.5);
  });
  it('curseur, bords et sélection : grille en Grid (absolu comme relatif), échantillon sinon', () => {
    expect(snapPoint(1.37, grid('GRID', 'RELATIVE'), BPM)).toBeCloseTo(1.5);
    expect(snapPoint(1.37, grid('GRID'), BPM, true)).toBe(toSample(1.37));
    expect(snapPoint(1.37, grid('SHUFFLE'), BPM)).toBe(toSample(1.37));
  });
});

describe('point de synchro', () => {
  it('posé en temps du fichier : il suit le clip déplacé et sort du clip rogné', () => {
    const c = C('a', 2, 4, { offset: 1 });
    const sp = syncPointAt(c, 2.5)!;
    expect(sp).toBeCloseTo(1.5);
    expect(syncOffsetOf({ ...c, syncPoint: sp })).toBeCloseTo(0.5);
    expect(syncOffsetOf({ ...c, start: 10, syncPoint: sp })).toBeCloseTo(0.5);       // déplacé : même attaque
    expect(syncOffsetOf({ ...c, offset: 1.6, duration: 3.4, syncPoint: sp })).toBeNull(); // rogné au-delà
    expect(syncPointAt(c, 7)).toBeNull();
  });
});

describe('Shuffle', () => {
  const abc = () => [C('A', 0, 4), C('B', 4, 4), C('C', 8, 4)];
  it('supprimer : les suivants se recollent', () => {
    expect(spans(shuffleRemove(abc(), ['B']))).toEqual([['A', 0, 4], ['C', 4, 8]]);
    // avec des trous : la suite recule de la longueur du clip supprimé
    expect(spans(shuffleRemove([C('A', 0, 2), C('B', 4, 2), C('C', 10, 2)], ['B']))).toEqual([['A', 0, 2], ['C', 8, 10]]);
    // deux clips d'un coup
    expect(spans(shuffleRemove(abc(), ['A', 'B']))).toEqual([['C', 0, 4]]);
  });
  it('les prises cachées qui suivent reculent aussi (couloirs alignés)', () => {
    const r = shuffleRemove([...abc(), C('T', 8, 4, { isMuted: true })], ['B']);
    expect(spans(r)).toEqual([['A', 0, 4], ['C', 4, 8], ['T', 4, 8]]);
  });
  it('crossfades remis proprement : jonction au milieu, fondus enlevés, nouveau crossfade anti-clic', () => {
    const xf = [C('A', 0, 4.01, { fadeOut: 0.02, bufferId: 'a' }), C('B', 3.99, 4.01, { offset: 0, fadeIn: 0.02, bufferId: 'b' }), C('C', 8, 4, { offset: 1, bufferId: 'c' })];
    const d = detachCrossfades(xf, 'B');
    expect(spans(d)).toEqual([['A', 0, 4], ['B', 4, 8], ['C', 8, 12]]);
    expect(d.find(c => c.id === 'A')!.fadeOut).toBe(0);
    const r = shuffleRemove(xf, ['B'], { autoXfade: true, curve: 'EQUAL_POWER', bufferDuration: () => 20 });
    const a = r.find(c => c.id === 'A')!, c = r.find(c => c.id === 'C')!;
    expect(a.start + a.duration).toBeCloseTo(4.005, 6);
    expect(c.start).toBeCloseTo(3.995, 6);
    expect(a.fadeOut).toBeCloseTo(0.01);
    expect(c.fadeIn).toBeCloseTo(0.01);
    // sans la préférence : jonction franche
    expect(spans(shuffleRemove(xf, ['B']))).toEqual([['A', 0, 4], ['C', 4, 8]]);
  });
  it('rogner la fin : la suite suit', () => {
    expect(spans(shuffleTrimEnd(abc(), 'A', 3))).toEqual([['A', 0, 3], ['B', 3, 7], ['C', 7, 11]]);
    // rallonger, limité par l'audio disponible
    expect(spans(shuffleTrimEnd(abc(), 'A', 9, { bufferDuration: () => 5 }))).toEqual([['A', 0, 5], ['B', 5, 9], ['C', 9, 13]]);
  });
  it('rogner le début : le clip reste en place, son audio commence plus tard, la suite recule', () => {
    const r = shuffleTrimStart(abc(), 'A', 1);
    expect(spans(r)).toEqual([['A', 0, 3], ['B', 3, 7], ['C', 7, 11]]);
    expect(r.find(c => c.id === 'A')!.offset).toBeCloseTo(1);
  });
  it('coller / insérer : pousse le reste, coupe un clip traversé', () => {
    expect(spans(shuffleInsert(abc(), [C('X', 4, 2)], 4))).toEqual([['A', 0, 4], ['X', 4, 6], ['B', 6, 10], ['C', 10, 14]]);
    let k = 0;
    const r = shuffleInsert([C('A', 0, 4), C('B', 4, 4)], [C('X', 2, 2)], 2, { makeId: () => `A2-${++k}` });
    expect(spans(r)).toEqual([['A', 0, 2], ['X', 2, 4], ['A2-1', 4, 6], ['B', 6, 10]]);
    expect(r.find(c => c.id === 'A2-1')!.offset).toBeCloseTo(2);
  });
  it('coller dans un crossfade ou à 5 ms d’un bord : à la jonction, sans miette', () => {
    const xf = [C('A', 0, 2.01, { fadeOut: 0.01, bufferId: 'a' }), C('B', 2, 2, { fadeIn: 0.01, offset: 1, bufferId: 'b' })];
    // 2,005 s : dans le crossfade → jonction à 2,005 (milieu), aucun morceau de moins de 20 ms
    const r = shuffleInsert(xf, [C('X', 2.005, 1)], 2.005);
    expect(r.every(c => c.duration >= 0.02 - 1e-9)).toBe(true);
    expect(spans(r)).toEqual([['A', 0, 2.005], ['X', 2.005, 3.005], ['B', 3.005, 5]]);
    // 1,995 s : 5 ms avant la fin de A (bord) → même résultat
    const r2 = shuffleInsert(xf, [C('Y', 1.995, 1)], 1.995);
    expect(r2.length).toBe(3);
    expect(r2.every(c => c.duration >= 0.02 - 1e-9)).toBe(true);
  });
  it('déplacer : le clip s’insère au bord le plus proche, les clips s’échangent', () => {
    expect(spans(shuffleMove(abc(), 'B', 10.5).clips)).toEqual([['A', 0, 4], ['C', 4, 8], ['B', 8, 12]]);
    expect(spans(shuffleMove(abc(), 'A', 3).clips)).toEqual([['B', 0, 4], ['A', 4, 8], ['C', 8, 12]]);
    // petit mouvement : il reste à sa place
    expect(spans(shuffleMove(abc(), 'B', 4.7).clips)).toEqual([['A', 0, 4], ['B', 4, 8], ['C', 8, 12]]);
  });
  it('plage effacée : la suite recule de la longueur de la plage', () => {
    const afterDelete = [C('A1', 0, 2), C('A2', 3, 1, { offset: 3 }), C('B', 4, 4)];
    expect(spans(closeRange(afterDelete, 2, 3))).toEqual([['A1', 0, 2], ['A2', 2, 3], ['B', 3, 7]]);
  });
  it('une opération Shuffle rend une seule nouvelle liste (une étape d’annulation, une opération de collaboration)', () => {
    const before = abc();
    const snapshot = JSON.stringify(before);
    const after = shuffleRemove(before, ['A']);
    expect(JSON.stringify(before)).toBe(snapshot);  // rien de modifié sur place
    expect(after).not.toBe(before);
    expect(spans(after)).toEqual([['B', 0, 4], ['C', 4, 8]]);
  });
});

describe('Spot : formats de position', () => {
  const ctx = { bpm: BPM, sr: 48000 };
  it('mesures|temps|ticks (960 ticks par temps)', () => {
    expect(formatBars(8, ctx)).toBe('5|1|000');
    expect(formatBars(8.75, ctx)).toBe('5|2|480');
    expect(parseBars('5|1|000', ctx)).toBeCloseTo(8);
    expect(parseBars('5|2|480', ctx)).toBeCloseTo(8.75);
    expect(parseBars('5 2', ctx)).toBeCloseTo(8.5);
    expect(parseBars('0|1|000', ctx)).toBeNull();
    expect(parseBars('5|5|000', ctx)).toBeNull();
  });
  it('min:sec.ms', () => {
    expect(formatMinSec(8.25)).toBe('0:08.250');
    expect(formatMinSec(62.5)).toBe('1:02.500');
    expect(parseMinSec('1:02.5')).toBeCloseTo(62.5);
    expect(parseMinSec('0:08,25')).toBeCloseTo(8.25);
    expect(parseMinSec('12.5')).toBeCloseTo(12.5);
    expect(parseMinSec('1:75')).toBeNull();
    expect(parseMinSec('abc')).toBeNull();
  });
  it('échantillons', () => {
    expect(formatSamples(8, ctx)).toBe('384000');
    expect(parseSamples('384 000', ctx)).toBeCloseTo(8);
    expect(parseSamples('12.5', ctx)).toBeNull();
  });
  it('reconnaît le format tapé même si un autre est choisi', () => {
    expect(parseSpot('5|1|000', 'MINSEC', ctx)).toEqual({ time: 8, format: 'BARS' });
    expect(parseSpot('0:08.000', 'SAMPLES', ctx)).toEqual({ time: 8, format: 'MINSEC' });
  });
  it('début, fin, point de synchro, position d’origine', () => {
    const c = { start: 2, duration: 4, offset: 1, syncPoint: 1.5, originStart: 3 };
    expect(anchorTime(c, 'SYNC')).toBeCloseTo(2.5);
    expect(spotStart(c, 'START', 8)).toBeCloseTo(8);
    expect(spotStart(c, 'SYNC', 8)).toBeCloseTo(7.5);
    expect(spotStart(c, 'END', 8)).toBeCloseTo(4);
    expect(spotStart(c, 'END', 3)).toBeNull();
    expect(originalStartOf(c)).toBeCloseTo(4);
    expect(originalStartOf({ start: 2, duration: 4 })).toBeNull();
  });
});

describe('Tab to Transient', () => {
  it('trouve les attaques à l’échantillon près', () => {
    const sr = 48000;
    const x = new Float32Array(sr * 2);
    for (const at of [0.5, 1.2]) {
      const i0 = Math.round(at * sr);
      for (let i = 0; i < sr * 0.2; i++) x[i0 + i] = 0.5 * Math.exp(-i / (sr * 0.05)) * Math.sin(2 * Math.PI * 220 * i / sr + 0.3);
    }
    const t = detectTransients(x, sr);
    expect(t.length).toBe(2);
    expect(Math.abs(t[0] - 0.5)).toBeLessThan(0.001);
    expect(Math.abs(t[1] - 1.2)).toBeLessThan(0.001);
    // dans un clip qui commence à 10 s avec un offset de 0,3 s
    const tl = clipTransients({ start: 10, duration: 1.5, offset: 0.3 }, t);
    expect(tl.map(v => +v.toFixed(3))).toEqual([10.2, 10.9]);
    expect(nextIn(tl, 10.2, 1)).toBeCloseTo(10.9);
    expect(nextIn(tl, 10.9, -1)).toBeCloseTo(10.2);
    expect(nextIn(tl, 10.9, 1)).toBeNull();
  });
});

describe('réglage du mode (préférence + projet)', () => {
  beforeEach(() => editModeStore.reset());
  it('F4 deux fois : Grid relatif ⇄ absolu', () => {
    editModeStore.set({ mode: 'SLIP' });
    chooseEditMode('GRID');
    expect(editModeStore.get().mode).toBe('GRID');
    const k = editModeStore.get().gridKind;
    chooseEditMode('GRID');
    expect(editModeStore.get().gridKind).not.toBe(k);
  });
  it('Shuffle Lock : impossible d’entrer en Shuffle', () => {
    chooseEditMode('SHUFFLE');
    expect(editModeStore.get().mode).toBe('SHUFFLE');
    toggleShuffleLock();
    expect(editModeStore.get().mode).toBe('SLIP');
    expect(chooseEditMode('SHUFFLE').ok).toBe(false);
    expect(editModeStore.get().mode).toBe('SLIP');
    toggleShuffleLock();
    expect(chooseEditMode('SHUFFLE').ok).toBe(true);
  });
  it('un réglage abîmé (vieux projet) est remis d’aplomb', () => {
    expect(sanitizeEditMode({ mode: 'PLOP', gridSize: '1/7' })).toEqual(DEFAULT_EDIT_MODE);
    expect(sanitizeEditMode({ mode: 'SHUFFLE', shuffleLock: true }).mode).toBe('SLIP');
  });
});

describe('raccourcis des modes', () => {
  it('F1–F4 et Alt+1–4, Tab, Ctrl+, sans conflit', () => {
    expect(findShortcut('f1', false)?.arg).toBe('SHUFFLE');
    expect(findShortcut('alt+2', false)?.arg).toBe('SLIP');
    expect(findShortcut('f3', false)?.arg).toBe('SPOT');
    expect(findShortcut('alt+4', false)?.arg).toBe('GRID');
    expect(findShortcut('tab', false)?.command).toBe('tabToTransient');
    expect(findShortcut('shift+tab', false)?.arg).toEqual({ dir: -1 });
    expect(findShortcut('ctrl+alt+arrowright', false)?.arg).toEqual({ dir: 1, clip: true });
    expect(findShortcut('ctrl+,', false)?.command).toBe('syncPoint');
    expect(findConflicts()).toEqual([]);
  });
});
