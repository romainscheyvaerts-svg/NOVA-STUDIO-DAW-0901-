import { describe, expect, it } from 'vitest';
import { drumClipFor, makeDrumMachine, DrumMachine } from '../utils/drumKits';
import {
  addPattern, autoFillBar, commitActive, deletePattern, drumRhythmSig, drumSongClips, duplicatePattern, ensurePatterns,
  placePattern, planBars, recolorPattern, renamePattern, selectPattern, songBars, songFromSections, whereAt, GROOVES,
} from '../utils/drumPatterns';

const BPM = 120; // 1 mesure = 2 s, 1 pas = 0,125 s
const bar = 2;

/** Motif minimal : un kick sur le 1er pas (A) ou sur le 3e temps (B). */
function twoPatterns(): { dm: DrumMachine; a: string; b: string } {
  let dm = makeDrumMachine('empty');
  dm = { ...dm, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, steps: r.steps.map((_, i) => (i === 0 ? 110 : 0)) } : r)) };
  dm = ensurePatterns(dm);
  const a = dm.activePattern!;
  dm = addPattern(dm);
  const b = dm.activePattern!;
  dm = { ...dm, rows: dm.rows.map(r => (r.id === 'snare' ? { ...r, steps: r.steps.map((_, i) => (i === 8 ? 100 : 0)) } : r)) };
  return { dm, a, b };
}

describe('motifs : migration et banque', () => {
  it('un ancien projet (motif unique) devient le motif A, sans rien perdre', () => {
    const old = makeDrumMachine('trap');
    const dm = ensurePatterns(old);
    expect(dm.patterns).toHaveLength(1);
    expect(dm.patterns![0].name).toBe('A');
    expect(dm.patterns![0].steps.kick).toEqual(old.rows.find(r => r.id === 'kick')!.steps);
    // rendu identique à l'ancien générateur
    const before = drumClipFor(old, BPM, 0, 16, 'x');
    const after = drumSongClips(old, BPM, 16, 'x');
    expect(after).toHaveLength(1);
    expect(after[0].notes!.map(n => [n.pitch, +n.start.toFixed(6), +n.velocity.toFixed(6)]))
      .toEqual(before.notes!.map(n => [n.pitch, +n.start.toFixed(6), +n.velocity.toFixed(6)]));
  });

  it('créer, passer d\'un motif à l\'autre : chaque motif garde ses pas', () => {
    const { dm, a, b } = twoPatterns();
    expect(dm.patterns!.map(p => p.name)).toEqual(['A', 'B']);
    const backToA = selectPattern(dm, a);
    expect(backToA.rows.find(r => r.id === 'kick')!.steps[0]).toBe(110);
    expect(backToA.rows.find(r => r.id === 'snare')!.steps[8]).toBe(0);
    const backToB = selectPattern(backToA, b);
    expect(backToB.rows.find(r => r.id === 'snare')!.steps[8]).toBe(100);
    expect(backToB.rows.find(r => r.id === 'kick')!.steps[0]).toBe(0);
  });

  it('dupliquer, renommer, colorer, supprimer', () => {
    let { dm, a } = twoPatterns();
    dm = duplicatePattern(dm, a);
    expect(dm.patterns).toHaveLength(3);
    expect(dm.rows.find(r => r.id === 'kick')!.steps[0]).toBe(110);
    const c = dm.activePattern!;
    dm = renamePattern(dm, c, '  Refrain  ');
    dm = recolorPattern(dm, c, '#123456');
    expect(dm.patterns!.find(p => p.id === c)).toMatchObject({ name: 'Refrain', color: '#123456' });
    dm = placePattern(dm, c, 2, 4, 4);
    dm = deletePattern(dm, c);
    expect(dm.patterns).toHaveLength(2);
    expect(dm.song!.every(x => x !== c)).toBe(true);
    expect(dm.patterns!.some(p => p.id === dm.activePattern)).toBe(true);
    // jamais le dernier
    let one = ensurePatterns(makeDrumMachine('trap'));
    one = deletePattern(one, one.activePattern!);
    expect(one.patterns).toHaveLength(1);
  });

  it('motif de 4 mesures', () => {
    let { dm } = twoPatterns();
    dm = commitActive({ ...dm, bars: 4, rows: dm.rows.map(r => ({ ...r, steps: [...r.steps, ...new Array(48).fill(0)], ratchet: [...r.ratchet, ...new Array(48).fill(1)] })) });
    expect(dm.patterns!.find(p => p.id === dm.activePattern)!.bars).toBe(4);
    expect(dm.patterns!.find(p => p.id === dm.activePattern)!.steps.kick).toHaveLength(64);
  });
});

describe('placement dans le morceau', () => {
  it('couplet = A, refrain = B : un clip par motif, chacun avec ses notes', () => {
    let { dm, a, b } = twoPatterns();
    dm = placePattern(dm, a, 0, 4, 8);
    dm = placePattern(dm, b, 4, 8, 8);
    expect(songBars(dm, 8)).toEqual([a, a, a, a, b, b, b, b]);
    const clips = drumSongClips(dm, BPM, 8 * bar, 'c');
    expect(clips.map(c => [c.name, c.start, c.duration])).toEqual([['Motif A', 0, 8], ['Motif B', 8, 8]]);
    // A : kick (note 60) au début de chaque mesure ; B : caisse claire (61) au 3e temps
    expect(clips[0].notes!.map(n => [n.pitch, n.start])).toEqual([[60, 0], [60, 2], [60, 4], [60, 6]]);
    expect(clips[1].notes!.map(n => [n.pitch, n.start])).toEqual([[61, 1], [61, 3], [61, 5], [61, 7]]);
  });

  it('silence (\'\') : pas de clip sur ces mesures ; au-delà du placement, le dernier motif continue', () => {
    let { dm, a } = twoPatterns();
    dm = placePattern(dm, a, 0, 2, 4);
    dm = placePattern(dm, '', 2, 3, 4);
    const clips = drumSongClips(dm, BPM, 6 * bar, 'c');
    expect(clips.map(c => [c.start, c.duration])).toEqual([[0, 4], [6, 6]]);
  });

  it('sections du morceau → motifs (les parties pleines prennent le refrain)', () => {
    const { dm, a, b } = twoPatterns();
    const out = songFromSections(dm, [{ start: 0, end: 4, kind: 'intro' }, { start: 4, end: 12, kind: 'part' }, { start: 12, end: 16, kind: 'part', full: true }], BPM, 8, { base: a, full: b, intro: '' });
    expect(songBars(out, 8)).toEqual(['', '', a, a, a, a, b, b]);
  });

  it('un motif de 2 mesures placé deux fois rejoue ses deux mesures dans l\'ordre', () => {
    let dm = ensurePatterns(makeDrumMachine('empty'));
    dm = { ...dm, bars: 2, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, steps: Array.from({ length: 32 }, (_, i) => (i === 0 || i === 20 ? 100 : 0)), ratchet: new Array(32).fill(1) } : { ...r, steps: new Array(32).fill(0), ratchet: new Array(32).fill(1) })) };
    const plan = planBars(dm, 4);
    expect(plan.map(p => p.barInPattern)).toEqual([0, 1, 0, 1]);
    const notes = drumSongClips(dm, BPM, 4 * bar, 'c')[0].notes!;
    expect(notes.map(n => n.start)).toEqual([0, 2.5, 4, 6.5]);
  });
});

describe('fill de fin de phrase', () => {
  it('auto toutes les 4 mesures : roulement de caisse claire sur le dernier temps de la mesure 4', () => {
    let dm = makeDrumMachine('empty');
    dm = { ...dm, rows: dm.rows.map(r => (r.id === 'snare' ? { ...r, steps: r.steps.map((_, i) => (i === 4 || i === 12 ? 100 : 0)) } : r)) };
    dm = { ...ensurePatterns(dm), fill: { every: 4 } };
    expect(planBars(dm, 8).map(p => p.fill)).toEqual([false, false, false, true, false, false, false, true]);
    const notes = drumSongClips(dm, BPM, 8 * bar, 'c')[0].notes!;
    const snareIn = (b: number) => notes.filter(n => n.pitch === 61 && n.start >= b * bar + 1.5 - 1e-6 && n.start < (b + 1) * bar - 1e-6).length;
    expect(snareIn(3)).toBeGreaterThanOrEqual(4);
    expect(snareIn(2)).toBeLessThan(snareIn(3));
  });

  it('fill = un motif choisi (sa dernière mesure)', () => {
    let { dm, a, b } = twoPatterns();
    dm = selectPattern(dm, a);
    dm = { ...placePattern(dm, a, 0, 8, 8), fill: { every: 8, patternId: b } };
    const notes = drumSongClips(dm, BPM, 8 * bar, 'c')[0].notes!;
    expect(notes.filter(n => n.start >= 14).map(n => [n.pitch, n.start])).toEqual([[61, 15]]);
  });

  it('autoFillBar ne touche pas l\'entrée', () => {
    const rows = [{ id: 'snare', steps: new Array(16).fill(0), ratchet: new Array(16).fill(1) }];
    const out = autoFillBar(rows);
    expect(rows[0].steps.every(v => v === 0)).toBe(true);
    expect(out[0].steps.slice(12)).toEqual([72, 88, 104, 122]);
  });
});

describe('groove et swing', () => {
  it('MPC : les doubles-croches impaires arrivent en retard, moins fortes ; dosage 0 = droit', () => {
    let dm = makeDrumMachine('empty');
    dm = { ...dm, rows: dm.rows.map(r => (r.id === 'hatc' ? { ...r, steps: new Array(16).fill(100) } : r)) };
    const straight = drumSongClips(dm, BPM, bar, 'c')[0].notes!;
    const mpc = drumSongClips({ ...dm, groove: 'mpc' }, BPM, bar, 'c')[0].notes!;
    expect(mpc[1].start - straight[1].start).toBeCloseTo(0.33 * 0.125, 5);
    expect(mpc[1].velocity).toBeLessThan(straight[1].velocity);
    expect(mpc[0].start).toBe(0);
    const off = drumSongClips({ ...dm, groove: 'mpc', grooveAmount: 0 }, BPM, bar, 'c')[0].notes!;
    expect(off.map(n => n.start)).toEqual(straight.map(n => n.start));
    expect(GROOVES.every(g => g.timing.length === 16 && g.velocity.length === 16)).toBe(true);
  });

  it('l\'empreinte change avec le motif, le placement, le groove, le fill', () => {
    const { dm, a } = twoPatterns();
    const s = drumRhythmSig(dm);
    expect(drumRhythmSig(dm)).toBe(s);
    expect(drumRhythmSig(placePattern(dm, a, 0, 1, 4))).not.toBe(s);
    expect(drumRhythmSig({ ...dm, groove: 'shuffle' })).not.toBe(s);
    expect(drumRhythmSig({ ...dm, fill: { every: 4 } })).not.toBe(s);
    // un réglage de son ne régénère pas le clip
    expect(drumRhythmSig({ ...dm, rows: dm.rows.map(r => ({ ...r, volume: 0.1 })) })).toBe(s);
  });

  it('tête de lecture : motif et pas joués à un instant', () => {
    let { dm, a, b } = twoPatterns();
    dm = placePattern(placePattern(dm, a, 0, 2, 4), b, 2, 4, 4);
    expect(whereAt(dm, BPM, 0.3)).toEqual({ bar: 0, patternId: a, step: 2 });
    expect(whereAt(dm, BPM, 5)).toEqual({ bar: 2, patternId: b, step: 8 });
  });
});

import { padIndexForCode, padKeyLabel, isTypingTarget } from '../utils/padKeys';
describe('pads au clavier', () => {
  it('touches physiques : rangée du milieu = pads 1 à 10, libellé AZERTY par défaut', () => {
    expect(padIndexForCode('KeyA', 8)).toBe(0);
    expect(padIndexForCode('KeyK', 8)).toBe(7);
    expect(padIndexForCode('KeyL', 8)).toBe(-1);
    expect(padIndexForCode('KeyQ', 30)).toBe(10);
    expect(padIndexForCode('Space', 30)).toBe(-1);
    expect(padKeyLabel('KeyA')).toBe('Q');
    expect(padKeyLabel('KeyA', new Map([['KeyA', 'a']]))).toBe('A');
    expect(padKeyLabel('KeyD')).toBe('D');
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' } as any)).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' } as any)).toBe(true);
  });
});

describe('créer un motif ne change pas ce que joue le morceau', () => {
  it('sans placement, A reste partout quand on crée B (comme dans FL Studio)', () => {
    let dm = makeDrumMachine('empty');
    dm = { ...dm, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, steps: r.steps.map((_, i) => (i === 0 ? 110 : 0)) } : r)) };
    const a = ensurePatterns(dm).activePattern!;
    const withB = addPattern(dm);
    expect(songBars(withB, 4)).toEqual([a, a, a, a]);
    expect(drumSongClips(withB, BPM, 4 * bar, 'c')[0].notes!.length).toBe(4);
  });
});
