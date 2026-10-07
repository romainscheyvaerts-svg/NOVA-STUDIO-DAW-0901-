import { describe, it, expect } from 'vitest';
import { isInScale, snapToScale, scaleRows, buildChord, diatonicChord, keyLabelFr, noteNameFr, chordLabelFr } from '../utils/scales';
import { ComputerKeyboard, NoteRecorder, isComputerKeyboardCode, octaveBase } from '../utils/computerKeyboard';

describe('gammes', () => {
  it('reconnaît les notes de Fa# mineur', () => {
    // Fa# mineur : Fa# Sol# La Si Do# Ré Mi
    const inKey = [66, 68, 69, 71, 73, 74, 76];
    inKey.forEach(p => expect(isInScale(p, 6, 'MINOR')).toBe(true));
    [65, 67, 70, 72, 75].forEach(p => expect(isInScale(p, 6, 'MINOR')).toBe(false));
  });

  it('tout est dans la gamme en chromatique ou sans gamme', () => {
    for (let p = 0; p < 12; p++) { expect(isInScale(60 + p, 0, 'CHROMATIC')).toBe(true); expect(isInScale(60 + p, 0, undefined)).toBe(true); }
  });

  it("l'aimant ramène sur la note la plus proche (vers le bas à égalité)", () => {
    expect(snapToScale(61, 0, 'MAJOR')).toBe(60); // Do# → Do
    expect(snapToScale(61, 0, 'MAJOR', 'up')).toBe(62);
    expect(snapToScale(66, 0, 'MAJOR')).toBe(65); // Fa# → Fa
    expect(snapToScale(64, 0, 'MAJOR')).toBe(64);
    expect(snapToScale(127, 0, 'MINOR_HARMONIC')).toBeLessThanOrEqual(127);
  });

  it('montrer seulement la gamme : 7 lignes par octave en mineur', () => {
    const rows = scaleRows(9, 'MINOR', true, 60, 71);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBeGreaterThan(rows[rows.length - 1]);
    expect(scaleRows(9, 'MINOR', false, 60, 71)).toHaveLength(12);
  });

  it('noms français', () => {
    expect(keyLabelFr(6, 'MINOR')).toBe('Fa# mineur');
    expect(keyLabelFr(undefined, 'MINOR')).toBe('');
    expect(noteNameFr(60)).toBe('Do3');
    expect(noteNameFr(69)).toBe('La3');
  });
});

describe('accords', () => {
  it('accords nommés', () => {
    expect(buildChord(60, 'MAJOR')).toEqual([60, 64, 67]);
    expect(buildChord(60, 'MIN7')).toEqual([60, 63, 67, 70]);
    expect(buildChord(60, 'MAJOR', { inversion: 1 })).toEqual([64, 67, 72]);
  });

  it("l'accord de la gamme suit la tonalité (La mineur)", () => {
    expect(diatonicChord(57, 9, 'MINOR')).toEqual([57, 60, 64]); // La mineur
    expect(diatonicChord(60, 9, 'MINOR')).toEqual([60, 64, 67]); // Do majeur (III)
    expect(diatonicChord(59, 9, 'MINOR')).toEqual([59, 62, 65]); // Si diminué (II)
    expect(chordLabelFr(diatonicChord(57, 9, 'MINOR'))).toBe('La mineur');
  });

  it("toutes les notes de l'accord de la gamme sont dans la gamme", () => {
    for (let p = 48; p < 72; p++) {
      buildChord(p, 'SCALE', { root: 6, scale: 'MINOR', snap: true }).forEach(n => expect(isInScale(n, 6, 'MINOR')).toBe(true));
    }
  });

  it('avec l’aimant, la fondamentale d’un accord nommé est ramenée dans la gamme', () => {
    expect(buildChord(61, 'MAJOR', { root: 0, scale: 'MAJOR', snap: true })[0]).toBe(60);
    expect(buildChord(61, 'MAJOR', { root: 0, scale: 'MAJOR', snap: false })[0]).toBe(61);
  });
});

describe("clavier de l'ordinateur", () => {
  it('A = Do3 (60), W = Do#, K = Do4', () => {
    const k = new ComputerKeyboard();
    expect(k.keyDown('KeyA')).toEqual({ type: 'noteOn', pitch: 60, velocity: 100 });
    expect(k.keyDown('KeyW')).toMatchObject({ pitch: 61 });
    expect(k.keyDown('KeyK')).toMatchObject({ pitch: 72 });
  });

  it('pas de nouvelle note à la répétition automatique', () => {
    const k = new ComputerKeyboard();
    k.keyDown('KeyA');
    expect(k.keyDown('KeyA', true).type).toBe('none');
    expect(k.keyDown('KeyA').type).toBe('none');
    expect(k.keyUp('KeyA')).toEqual({ type: 'noteOff', pitch: 60 });
    expect(k.keyUp('KeyA').type).toBe('none');
  });

  it('octave Z / X et vélocité C / V', () => {
    const k = new ComputerKeyboard();
    k.keyDown('KeyX');
    expect(k.keyDown('KeyA')).toMatchObject({ pitch: 72 });
    k.keyDown('KeyZ'); k.keyDown('KeyZ');
    expect(octaveBase(k.state.octave)).toBe(48);
    k.keyDown('KeyV');
    expect(k.state.velocity).toBe(127);
    k.keyDown('KeyC'); k.keyDown('KeyC');
    expect(k.state.velocity).toBe(80);
  });

  it("relâche la note jouée même si l'octave a changé entre-temps", () => {
    const k = new ComputerKeyboard();
    k.keyDown('KeyA');
    k.keyDown('KeyX');
    expect(k.keyUp('KeyA')).toEqual({ type: 'noteOff', pitch: 60 });
  });

  it('ne capte que ses touches (Q, espace, flèches restent libres)', () => {
    expect(isComputerKeyboardCode('KeyA')).toBe(true);
    expect(isComputerKeyboardCode('KeyZ')).toBe(true);
    expect(isComputerKeyboardCode('KeyQ')).toBe(false);
    expect(isComputerKeyboardCode('Space')).toBe(false);
    expect(isComputerKeyboardCode('ArrowUp')).toBe(false);
  });

  it('enregistre la durée de chaque note', () => {
    const r = new NoteRecorder();
    r.noteOn(60, 1.0, 100);
    r.noteOn(64, 1.5, 80);
    r.noteOff(60, 2.0);
    expect(r.pending(2.5)).toHaveLength(2);
    const notes = r.finish(3.0);
    expect(notes).toEqual([
      { pitch: 60, start: 1.0, duration: 1.0, velocity: 100 },
      { pitch: 64, start: 1.5, duration: 1.5, velocity: 80 },
    ]);
    expect(r.finish(4)).toEqual([]);
  });
});
