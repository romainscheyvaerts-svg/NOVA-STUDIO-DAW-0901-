import { describe, expect, it } from 'vitest';
import { makeDrumMachine, setBars, type DrumMachine } from '../utils/drumKits';
import {
  addPattern, autoFillBar, drumRhythmSig, drumSongClips, ensurePatterns, planBars, selectPattern, setRowLength, setRowRate, setStepParam, stepChance,
  stepParamOf, whereAt,
} from '../utils/drumPatterns';
import {
  applyRecipe, clearPattern, clearRow, copyPattern, copyRow, doublePattern, fillEvery, paste, recipeChoices, recordHit, reroll, reverseRow,
  rotatePattern, rotateRow,
} from '../utils/drumEdit';
import { buildTempoMap, quartersToTime } from '../utils/tempoMap';
import { removePad } from '../utils/drumSamples';

const BPM = 120; // 1 pas = 0,125 s, 1 mesure = 2 s
const STEP = 0.125;

/** Batterie vide avec un kick sur les pas donnés. */
function kickOn(steps: number[], vel = 110): DrumMachine {
  const dm = makeDrumMachine('empty');
  return { ...dm, swing: 0, rows: dm.rows.map(r => ({ ...r, steps: r.steps.map((_, i) => (r.id === 'kick' && steps.includes(i) ? vel : 0)) })) };
}
const notesOf = (dm: DrumMachine, end = 2, map?: ReturnType<typeof buildTempoMap>) => drumSongClips(dm, BPM, end, 'c', map).flatMap(c => (c.notes || []).map(n => ({ ...n, abs: c.start + n.start })));
const ki = (dm: DrumMachine) => dm.rows.findIndex(r => r.id === 'kick');

describe('séquenceur pro : réglages par pas', () => {
  it('probabilité : tirage déterministe (lecture = export), 0 % jamais, 100 % toujours, nouvelle graine = autre tirage', () => {
    let dm = kickOn(Array.from({ length: 16 }, (_, i) => i));
    for (let i = 0; i < 16; i++) dm = setStepParam(dm, ki(dm), i, 'prob', 50);
    const a = notesOf(dm, 64 * 2).length, b = notesOf(dm, 64 * 2).length;
    expect(a).toBe(b);
    // 64 mesures × 16 pas à 50 % : entre 40 et 60 %.
    expect(a / (64 * 16)).toBeGreaterThan(0.4);
    expect(a / (64 * 16)).toBeLessThan(0.6);
    expect(notesOf(reroll(dm), 64 * 2).map(n => n.id)).not.toEqual(notesOf(dm, 64 * 2).map(n => n.id));
    const zero = setStepParam(kickOn([0]), 0, 0, 'prob', 0);
    expect(notesOf(zero, 8)).toHaveLength(0);
    expect(notesOf(setStepParam(kickOn([0]), 0, 0, 'prob', 100), 8)).toHaveLength(4);
    expect(stepChance(0, 'kick', 3, 5)).toBe(stepChance(0, 'kick', 3, 5));
  });

  it('décalage fin : +25 % d\'un pas = +31,25 ms à 120 BPM ; −50 % = −62,5 ms ; décalage de rangée', () => {
    let dm = kickOn([4, 8]);
    dm = setStepParam(dm, ki(dm), 4, 'nudge', 25);
    dm = setStepParam(dm, ki(dm), 8, 'nudge', -50);
    const n = notesOf(dm);
    expect(n[0].abs).toBeCloseTo(4 * STEP + 0.03125, 12);
    expect(n[1].abs).toBeCloseTo(8 * STEP - 0.0625, 12);
    const sh = { ...kickOn([4]), rows: kickOn([4]).rows.map(r => (r.id === 'kick' ? { ...r, shift: -20 } : r)) };
    expect(notesOf(sh)[0].abs).toBeCloseTo(4 * STEP - 0.2 * STEP, 12);
  });

  it('longueur de note : 2 pas = 250 ms, note tenue ; sans longueur : comme avant (≤ 100 ms, pas tenue)', () => {
    let dm = kickOn([0, 8]);
    dm = setStepParam(dm, ki(dm), 0, 'gate', 2);
    const n = notesOf(dm);
    expect(n[0].duration).toBeCloseTo(0.25, 12);
    expect(n[0].hold).toBe(1);
    expect(n[1].duration).toBeCloseTo(0.1, 12);
    expect(n[1].hold).toBeUndefined();
  });

  it('glisse : depuis la hauteur du coup précédent du pad, temps du sampler du pad (80 ms par défaut)', () => {
    let dm = kickOn([0, 8]);
    dm = setStepParam(dm, ki(dm), 0, 'pitch', -5);
    dm = setStepParam(dm, ki(dm), 8, 'pitch', 7);
    dm = setStepParam(dm, ki(dm), 8, 'glide', 1);
    const n = notesOf(dm);
    expect(n[0].glide).toBeUndefined();
    expect(n[1]).toMatchObject({ tune: 7, glide: 1, glideFrom: -5, glideTime: 0.08 });
    const slow = { ...dm, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, smp: { glideMs: 250 } } : r)) };
    expect(notesOf(slow)[1].glideTime).toBeCloseTo(0.25, 12);
  });

  it('les réglages par pas suivent les motifs (créer, dupliquer, revenir), la résolution et la longueur', () => {
    let dm = ensurePatterns(setStepParam(kickOn([0, 4]), 0, 4, 'prob', 30));
    const a = dm.activePattern!;
    dm = addPattern(dm);
    expect(stepParamOf(dm.rows[0], 4, 'prob')).toBe(100);
    dm = selectPattern(dm, a);
    expect(stepParamOf(dm.rows[0], 4, 'prob')).toBe(30);
    dm = addPattern(dm, { copyFrom: a });
    expect(stepParamOf(dm.rows[0], 4, 'prob')).toBe(30);
    const r32 = setRowRate(dm, 0, '32');
    expect(r32.rows[0].steps).toHaveLength(32);
    expect(stepParamOf(r32.rows[0], 8, 'prob')).toBe(30);
    const l12 = setRowLength(dm, 0, 12);
    expect(l12.rows[0].stepProb).toHaveLength(12);
    const two = setBars(dm, 2);
    expect(two.rows[0].stepProb).toHaveLength(32);
    expect(two.rows[0].stepProb![20]).toBe(30);
  });

  it('un ancien projet n\'écrit aucun nouveau champ ; l\'empreinte du rythme suit les nouveaux réglages', () => {
    const old = makeDrumMachine('trap');
    const p = ensurePatterns(old).patterns![0];
    expect(Object.keys(p).sort()).toEqual(['bars', 'color', 'id', 'name', 'ratchet', 'steps']);
    const s = drumRhythmSig(old);
    expect(drumRhythmSig(setStepParam(old, 0, 0, 'nudge', 10))).not.toBe(s);
    expect(drumRhythmSig(reroll(old))).not.toBe(s);
    expect(drumRhythmSig({ ...old, rows: old.rows.map((r, i) => (i === 0 ? { ...r, shift: 5 } : r)) })).not.toBe(s);
  });

  it('retirer un pad retire aussi ses réglages par pas de tous les motifs', () => {
    let dm = ensurePatterns(setStepParam(kickOn([0]), 0, 0, 'nudge', 10));
    dm = addPattern(dm, { copyFrom: dm.activePattern });
    const out = removePad(dm, 0);
    expect(out.patterns!.every(p => !p.nudge || !('kick' in p.nudge))).toBe(true);
  });
});

describe('séquenceur pro : tempo et rampes', () => {
  it('carte des tempos à tempo constant : mêmes instants que sans carte', () => {
    const dm = kickOn([0, 3, 6, 10]);
    const plain = notesOf(dm, 4);
    const mapped = notesOf(dm, 4, buildTempoMap(BPM, { numerator: 4, denominator: 4 }, []));
    expect(mapped.map(n => +n.abs.toFixed(9))).toEqual(plain.map(n => +n.abs.toFixed(9)));
  });

  it('changement de tempo et rampe : chaque coup tombe sur sa position musicale', () => {
    const dm = kickOn([0, 4, 8, 12]);
    const map = buildTempoMap(BPM, { numerator: 4, denominator: 4 }, [{ id: 'a', bar: 1, bpm: 90 }, { id: 'b', bar: 3, bpm: 150, ramp: true }]);
    const n = notesOf(dm, quartersToTime(map, 16), map);
    expect(n).toHaveLength(16);
    n.forEach((x, k) => expect(x.abs).toBeCloseTo(quartersToTime(map, k), 9));
    const w = whereAt(dm, BPM, quartersToTime(map, 9.5), map)!;
    expect(w.bar).toBe(2);
    expect(w.pos16).toBeCloseTo(6, 9);
  });
});

describe('séquenceur pro : remplissages publiés', () => {
  const base = () => {
    let dm = makeDrumMachine('trap');
    dm = { ...dm, rows: [...dm.rows, { ...dm.rows[0], id: 'crash', name: 'Crash', steps: new Array(16).fill(0), ratchet: new Array(16).fill(1) }, { ...dm.rows[0], id: 'tom', name: 'Tom', steps: new Array(16).fill(0), ratchet: new Array(16).fill(1) }] };
    return dm;
  };
  it('« 2 temps » : 4 doubles de tom (64, 72, 80, 88) puis le roulement de caisse claire', () => {
    const rows = base().rows.map(r => ({ id: r.id, steps: r.steps, ratchet: r.ratchet }));
    const out = autoFillBar(rows, 'toms');
    expect(out.find(r => r.id === 'tom')!.steps.slice(8, 12)).toEqual([64, 72, 80, 88]);
    // Roulement sur la caisse claire, ou le clap si c'est lui qui joue (kit trap).
    expect(out.filter(r => r.id === 'snare' || r.id === 'clap').some(r => r.steps.slice(12).join() === '72,88,104,122')).toBe(true);
    // Par défaut : comme avant.
    expect(autoFillBar(rows)).toEqual(autoFillBar(rows, 'roll'));
  });
  it('crash sur le 1 de la mesure qui suit le fill', () => {
    const dm = { ...base(), fill: { every: 4 as const, crash: true } };
    const ci = dm.rows.findIndex(r => r.id === 'crash');
    const crashes = notesOf(dm, 16).filter(n => n.pitch === 60 + ci).map(n => +n.abs.toFixed(6));
    expect(crashes).toEqual([8]);
    expect(planBars(dm, 8).map(p => p.fill)).toEqual([false, false, false, true, false, false, false, true]);
  });
});

describe('séquenceur pro : gestes d\'édition', () => {
  it('décaler, inverser (le décalage fin change de sens), effacer', () => {
    let dm = setStepParam(kickOn([0, 5]), 0, 5, 'nudge', 20);
    const r = rotateRow(dm, 0, 1);
    expect(r.rows[0].steps[1]).toBe(110);
    expect(r.rows[0].stepNudge![6]).toBe(20);
    expect(rotateRow(r, 0, -1).rows[0]).toEqual(dm.rows[0]);
    const rev = reverseRow(dm, 0);
    expect(rev.rows[0].steps[15]).toBe(110);
    expect(rev.rows[0].stepNudge![10]).toBe(-20);
    expect(rotatePattern(dm, -1).rows[0].steps[15]).toBe(110);
    expect(clearRow(dm, 0).rows[0].steps.every(v => !v)).toBe(true);
    expect(clearRow(dm, 0).rows[0].stepNudge).toBeUndefined();
    expect(clearPattern(dm).rows.every(x => x.steps.every(v => !v))).toBe(true);
  });
  it('doubler la longueur : 1 → 2 → 4 → 8 mesures, contenu recopié', () => {
    let dm = kickOn([0]);
    dm = doublePattern(doublePattern(doublePattern(dm)));
    expect(dm.bars).toBe(8);
    expect(dm.rows[0].steps).toHaveLength(128);
    expect(dm.rows[0].steps.filter(v => v).length).toBe(8);
    expect(doublePattern(dm)).toBe(dm);
    // 8 mesures → 8 coups sur 16 s.
    expect(notesOf(ensurePatterns(dm), 16)).toHaveLength(8);
  });
  it('remplir tous les N pas, copier / coller un motif ou une rangée', () => {
    let dm = fillEvery(kickOn([]), 0, 4);
    expect(dm.rows[0].steps.map(v => (v ? 1 : 0)).join('')).toBe('1000100010001000');
    copyRow(dm, 0);
    dm = paste(dm, 1)!;
    expect(dm.rows[1].steps).toEqual(dm.rows[0].steps);
    copyPattern(dm);
    const other = paste(kickOn([3]), 0)!;
    expect(other.rows[0].steps).toEqual(dm.rows[0].steps);
  });
  it('rythmes publiés : motif d\'une recette sourcée, au bon pas, avec son swing ; rôles sans pad listés', () => {
    expect(recipeChoices().length).toBe(18);
    expect(recipeChoices().every(c => c.src.length > 0)).toBe(true);
    const { dm, missing } = applyRecipe(makeDrumMachine('trap'), 'boombap', 0, 'replace');
    expect(dm.bars).toBe(2);
    expect(dm.swing).toBe(0.3);
    const kick = dm.rows.find(r => r.id === 'kick')!;
    // « x.o...x...x.....|x.....x...x..... » [27]
    expect(kick.steps.map(v => (v >= 100 ? 'x' : v > 0 ? 'o' : '.')).join('')).toBe('x.o...x...x.....x.....x...x.....');
    expect(Array.isArray(missing)).toBe(true);
    const nw = applyRecipe(ensurePatterns(makeDrumMachine('trap')), 'drill-uk', 2, 'new').dm;
    expect(nw.patterns).toHaveLength(2);
    expect(nw.rows.find(r => r.id === 'hatc')!.rate).toBe('16t');
  });
  it('enregistrement en direct : quantifié au pas le plus proche, ou avec le décalage fin', () => {
    let dm = kickOn([]);
    dm = recordHit(dm, 0, 4.2, true);
    expect(dm.rows[0].steps[4]).toBe(110);
    expect(dm.rows[0].stepNudge).toBeUndefined();
    dm = recordHit(dm, 0, 16 + 7.7, false, 90);
    expect(dm.rows[0].steps[8]).toBe(90);
    expect(dm.rows[0].stepNudge![8]).toBe(-30);
  });
});
