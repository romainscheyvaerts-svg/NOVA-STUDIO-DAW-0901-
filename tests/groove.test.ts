import { describe, expect, it } from 'vitest';
import { MidiNote } from '../types';
import {
  swingTemplate, PRESET_GROOVES, applyGroove, setClipGroove, commitGroove, removeGroove, extractGroove, midiOnsets, onsetLevels, grooveLengthFor,
} from '../utils/groove';
import { detectTransients } from '../utils/transients';

/** V25 : swing et groove par clip MIDI (Groove Pool de Live, swing de FL / MPC). */

const BPM = 120; // un temps = 0,5 s, une double-croche = 0,125 s
const hats = (n = 16, step = 0.125): MidiNote[] => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, pitch: 63, start: i * step, duration: 0.05, velocity: 0.8 }));

describe('swing', () => {
  it('swing 16e à 58 % : chaque 2e double-croche arrive 0,16 case plus tard (MPC)', () => {
    const t = swingTemplate(16, 58);
    const out = applyGroove(hats(), { template: t, amount: 1, velocity: 0 }, { bpm: BPM, clipStart: 0 });
    const off = 0.16 * 0.125; // 20 ms
    out.forEach((n, i) => expect(n.start).toBeCloseTo(i * 0.125 + (i % 2 ? off : 0), 9));
    // Position du contretemps dans la paire = 58 %.
    expect((out[1].start - out[0].start) / (out[2].start - out[0].start)).toBeCloseTo(0.58, 9);
  });

  it('swing 8e à 66 % : contretemps de croche en triolet ; 50 % = droit ; intensité à 50 %', () => {
    const eighths = hats(8, 0.25);
    const out = applyGroove(eighths, { template: swingTemplate(8, 66), amount: 1, velocity: 0 }, { bpm: BPM, clipStart: 0 });
    expect(out[1].start).toBeCloseTo(0.5 * 0.66, 9);
    const straight = applyGroove(eighths, { template: swingTemplate(8, 50), amount: 1, velocity: 0 }, { bpm: BPM, clipStart: 0 });
    straight.forEach((n, i) => expect(n.start).toBeCloseTo(eighths[i].start, 12));
    const half = applyGroove(eighths, { template: swingTemplate(8, 66), amount: 0.5, velocity: 0 }, { bpm: BPM, clipStart: 0 });
    expect(half[1].start - 0.25).toBeCloseTo((0.33 - 0.25) / 2, 9);
  });

  it('effet sur la vélocité : contretemps plus doux selon le réglage', () => {
    const out = applyGroove(hats(4), { template: swingTemplate(16, 58), amount: 1, velocity: 1 }, { bpm: BPM, clipStart: 0 });
    expect(out[0].velocity).toBeCloseTo(0.8, 9);
    expect(out[1].velocity).toBeCloseTo(0.8 * 0.85, 9);
    const none = applyGroove(hats(4), { template: swingTemplate(16, 58), amount: 1, velocity: 0 }, { bpm: BPM, clipStart: 0 });
    expect(none[1].velocity).toBeCloseTo(0.8, 9);
  });

  it('la grille est celle du morceau : un clip qui commence sur un contretemps swingue juste', () => {
    // Clip posé à 0,125 s : sa 1re note est un contretemps de double-croche.
    const out = applyGroove(hats(2), { template: swingTemplate(16, 58), amount: 1, velocity: 0 }, { bpm: BPM, clipStart: 0.125 });
    expect(out[0].start).toBeCloseTo(0.02, 9);
    expect(out[1].start).toBeCloseTo(0.125, 9);
  });

  it('grooves prêts : MPC 55, 58, 62 et trap « bounce »', () => {
    const ids = PRESET_GROOVES.map(g => g.id);
    expect(ids).toEqual(expect.arrayContaining(['mpc55', 'mpc58', 'mpc62', 'trap-bounce']));
    const b = PRESET_GROOVES.find(g => g.id === 'trap-bounce')!;
    expect(b.timing).toHaveLength(16);
    const out = applyGroove(hats(4), { template: b, amount: 1, velocity: 1 }, { bpm: 140, clipStart: 0 });
    expect(out[1].velocity).toBeLessThan(out[0].velocity);
  });
});

describe('groove non destructif, puis appliqué (Commit Groove)', () => {
  it('régler, changer, retirer : on repart toujours des notes d’origine ; une retouche à la main est gardée', () => {
    const clip = { start: 0, notes: hats(8) };
    const a = setClipGroove(clip, { template: swingTemplate(16, 62), amount: 1, velocity: 0 }, BPM);
    expect(a.groove.source).toEqual(clip.notes);
    expect(a.notes[1].start).toBeCloseTo(0.125 + 0.24 * 0.125, 9);
    // Nouveau réglage sur le clip déjà groové : calcul depuis la source, pas de cumul.
    const b = setClipGroove({ start: 0, notes: a.notes, groove: a.groove }, { template: swingTemplate(16, 55), amount: 1, velocity: 0 }, BPM);
    expect(b.notes[1].start).toBeCloseTo(0.125 + 0.1 * 0.125, 9);
    // Retouche : la note 4 (temps 2, sans décalage) est montée d'un demi-ton dans le piano roll.
    const edited = b.notes.map(n => (n.id === 'h4' ? { ...n, pitch: 64 } : n));
    const back = removeGroove({ start: 0, notes: edited, groove: b.groove }, BPM);
    expect(back.groove).toBeUndefined();
    back.notes.forEach((n, i) => expect(n.start).toBeCloseTo(i * 0.125, 9));
    expect(back.notes[4].pitch).toBe(64);
  });

  it('Appliquer le groove : les notes groovées restent, la source part', () => {
    const a = setClipGroove({ start: 0, notes: hats(4) }, { template: swingTemplate(16, 58), amount: 1, velocity: 0 }, BPM);
    const c = commitGroove({ notes: a.notes });
    expect(c.groove).toBeUndefined();
    expect(c.notes[1].start).toBeCloseTo(0.145, 9);
  });
});

describe('groove extrait d’une boucle', () => {
  it('d’un clip MIDI : positions et vélocités des attaques, puis appliqué à un autre clip', () => {
    // Boucle « jouée » : contretemps 30 ms en retard et plus doux, sur 2 mesures.
    const loop: MidiNote[] = hats(32).map((n, i) => ({ ...n, start: n.start + (i % 2 ? 0.03 : 0), velocity: i % 2 ? 0.5 : 1 }));
    const tpl = extractGroove(midiOnsets({ start: 0, notes: loop }), { bpm: BPM, lengthBeats: grooveLengthFor(4, BPM) });
    expect(tpl.lengthBeats).toBe(8);
    expect(tpl.timing[1]).toBeCloseTo(0.24, 3); // 30 ms / 125 ms
    expect(tpl.timing[0]).toBe(0);
    expect(tpl.velocity[1]).toBeCloseTo(0.5, 3);
    const other = applyGroove(hats(4), { template: tpl, amount: 1, velocity: 1 }, { bpm: BPM, clipStart: 0 });
    expect(other[1].start - 0.125).toBeCloseTo(0.03, 3);
    expect(other[1].velocity).toBeCloseTo(0.4, 3);
  });

  it('d’une boucle audio (attaques détectées par utils/transients)', () => {
    const sr = 22050;
    const x = new Float32Array(sr * 3);
    // 8 coups par temps de croche, les contretemps 25 ms en retard et deux fois plus faibles.
    const hits: number[] = [];
    // (un temps de silence au début : le détecteur compare à ce qui précède)
    for (let i = 0; i < 8; i++) hits.push(0.5 + i * 0.25 + (i % 2 ? 0.025 : 0));
    hits.forEach((t, i) => { const a = i % 2 ? 0.4 : 0.8; for (let k = 0; k < 400; k++) x[Math.round(t * sr) + k] = a * Math.exp(-k / 120) * (k % 2 ? 1 : -1); });
    const times = detectTransients(x, sr);
    expect(times).toHaveLength(8);
    const levels = onsetLevels(x, sr, times);
    const tpl = extractGroove(times.map((time, i) => ({ time, level: levels[i] })), { bpm: BPM, stepsPerBeat: 2, lengthBeats: 4 });
    expect(tpl.timing[1] * 0.25).toBeCloseTo(0.025, 2);
    expect(tpl.velocity[1]).toBeCloseTo(0.5, 1);
  });
});
