import { describe, it, expect, afterEach } from 'vitest';
import {
  buildTempoMap, barToTime, timeToPosition, beatsInRange, barsInRange, snapTimeToMap, gridLinesInRange, formatBarsBeats,
  upsertTempoEvent, removeTempoEvent, tempoSignature, quartersAt, isPlain44, tempoMapStore, segmentAtTime,
} from '../utils/tempoMap';
import { TapTempo, roundTapped } from '../utils/tapTempo';
import { resolveCountIn, planCountIn } from '../utils/countIn';
import { snapToGrid } from '../utils/grid';
import { formatMesures } from '../utils/musicKey';
import { novaToMidi } from '../utils/midiImport';
import { TrackType, type Track } from '../types';
import { rollSeconds, effectivePreRoll } from '../utils/punch';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('carte des tempos et des mesures', () => {
  it('4/4 sans changement : comme avant (mesure = 4 noires)', () => {
    const m = buildTempoMap(120, { numerator: 4, denominator: 4 }, []);
    expect(isPlain44(m)).toBe(true);
    close(barToTime(m, 3), 6);
    expect(timeToPosition(m, 6.25)).toMatchObject({ bar: 3, beat: 0 });
    for (const t of [0, 1.234, 7.5, 33.3]) expect(formatBarsBeats(m, t)).toBe(formatMesures(t + 1e-6, 120, 4, 4));
  });
  it('6/8 : six croches par mesure, la noire garde le tempo', () => {
    const m = buildTempoMap(120, { numerator: 6, denominator: 8 }, []);
    // croche = 0,25 s ; mesure = 1,5 s
    close(barToTime(m, 2), 3);
    const beats = beatsInRange(m, 0, 1.5);
    expect(beats.map(b => b.time)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25]);
    expect(beats.map(b => b.downbeat)).toEqual([true, false, false, false, false, false]);
  });
  it('changements de tempo et de mesure (mesure 3 : 90 BPM en 3/4 ; mesure 5 : 7/8)', () => {
    const ev = [{ id: 'a', bar: 2, bpm: 90, numerator: 3, denominator: 4 }, { id: 'b', bar: 4, numerator: 7, denominator: 8 }];
    const m = buildTempoMap(120, { numerator: 4, denominator: 4 }, ev);
    expect(m.segments.map(s => [s.bar, s.bpm, `${s.num}/${s.den}`])).toEqual([[0, 120, '4/4'], [2, 90, '3/4'], [4, 90, '7/8']]);
    close(barToTime(m, 2), 4);                 // 2 mesures de 2 s
    close(barToTime(m, 4), 4 + 2 * 2);         // 2 mesures de 3 noires à 90 = 2 s chacune
    close(barToTime(m, 5), 8 + 3.5 * (60 / 90)); // 7 croches à 90 BPM
    expect(timeToPosition(m, 4.7)).toMatchObject({ bar: 2, beat: 1 });
    // Clics de la mesure 5 (7/8) : 7 croches, accent sur la première
    const c = beatsInRange(m, 8, barToTime(m, 5));
    expect(c.length).toBe(7);
    close(c[1].time - c[0].time, (60 / 90) / 2);
    expect(c.filter(x => x.downbeat).length).toBe(1);
    expect(barsInRange(m, 0, 9).map(b => b.bar)).toEqual([0, 1, 2, 3, 4]);
    expect(segmentAtTime(m, 8.5).num).toBe(7);
  });
  it('aimantation ancrée sur les mesures (7/8, grille à la noire)', () => {
    const m = buildTempoMap(120, { numerator: 7, denominator: 8 }, []);
    // mesure de 1,75 s ; traits à 0, 0,5, 1, 1,5 puis 1,75 (mesure suivante)
    close(snapTimeToMap(m, 0.6, '1/4'), 0.5);
    close(snapTimeToMap(m, 1.7, '1/4'), 1.75);
    close(snapTimeToMap(m, 1.9, '1/4'), 1.75);
    close(snapTimeToMap(m, 2.3, '1/4'), 2.25);
    close(snapTimeToMap(m, 1.0, '1/1'), 1.75);
    const lines = gridLinesInRange(m, 0, 1.75, '1/4');
    expect(lines.map(l => l.time)).toEqual([0, 0.5, 1, 1.5, 1.75]);
  });
  it('snapToGrid suit la carte du projet (store), pas en 4/4 simple', () => {
    tempoMapStore.set(buildTempoMap(120, { numerator: 7, denominator: 8 }, []));
    close(snapToGrid(1.7, 120, '1/4', true), 1.75);
    tempoMapStore.set(buildTempoMap(120, { numerator: 4, denominator: 4 }, []));
    close(snapToGrid(1.7, 120, '1/4', true), 1.5);
  });
  it('édition : ajout, fusion, suppression ; empreinte pour la collaboration', () => {
    let ev = upsertTempoEvent([], { bar: 4, bpm: 140 });
    ev = upsertTempoEvent(ev, { bar: 4, numerator: 3, denominator: 4 });
    ev = upsertTempoEvent(ev, { bar: 2, bpm: 100 });
    expect(ev.map(e => [e.bar, e.bpm, e.numerator])).toEqual([[2, 100, undefined], [4, 140, 3]]);
    const sig1 = tempoSignature(120, { numerator: 4, denominator: 4 }, ev);
    ev = removeTempoEvent(ev, ev[0].id);
    expect(ev.length).toBe(1);
    expect(tempoSignature(120, { numerator: 4, denominator: 4 }, ev)).not.toBe(sig1);
  });
  it('noires écoulées (export MIDI) à travers un changement de tempo', () => {
    const m = buildTempoMap(120, { numerator: 4, denominator: 4 }, [{ id: 'x', bar: 1, bpm: 60 }]);
    close(quartersAt(m, 2), 4);
    close(quartersAt(m, 3), 5);
  });
  afterEach(() => tempoMapStore.set(buildTempoMap(120, { numerator: 4, denominator: 4 }, [])));
});

describe('export MIDI avec la piste tempo', () => {
  it('écrit les changements de tempo et de mesure, notes placées en noires', () => {
    const m = buildTempoMap(120, { numerator: 4, denominator: 4 }, [{ id: 'x', bar: 1, bpm: 60, numerator: 3, denominator: 4 }]);
    const track = { id: 't', name: 'Piano', type: TrackType.MIDI, clips: [] } as unknown as Track;
    const clip = { id: 'c', start: 0, duration: 4, notes: [{ id: 'n1', pitch: 60, start: 2, duration: 1, velocity: 0.8 }, { id: 'n2', pitch: 62, start: 3, duration: 1, velocity: 0.8 }] } as any;
    const d = novaToMidi([{ track, clips: [clip] }], { bpm: 120, tempoMap: m, ppq: 960 });
    expect(d.tempos.map(t => [t.tick, Math.round(t.bpm)])).toEqual([[0, 120], [4 * 960, 60]]);
    expect(d.timeSignatures.map(t => [t.tick, t.numerator, t.denominator])).toEqual([[0, 4, 4], [4 * 960, 3, 4]]);
    expect(d.tracks[0].notes.map(n => [n.startTick, n.durationTicks])).toEqual([[4 * 960, 960], [5 * 960, 960]]);
  });
});

describe('tap tempo', () => {
  it('128 BPM tapé, une tape ratée écartée, pause de 2 s = on recommence', () => {
    const tap = new TapTempo();
    const iv = 60000 / 128;
    let t = 1000;
    expect(tap.tap(t)).toBeNull();
    for (let i = 0; i < 6; i++) { t += i === 3 ? iv * 1.6 : iv; tap.tap(t); }
    expect(roundTapped(tap.bpm()!)).toBe(128);
    t += 2500;
    expect(tap.tap(t)).toBeNull();
    expect(tap.tap(t + 500)).toBe(120);
  });
  it('arrondi à l\'entier proche seulement', () => {
    expect(roundTapped(127.9)).toBe(128);
    expect(roundTapped(127.6)).toBe(127.6);
  });
});

describe('décompte', () => {
  it('lit enfin le réglage (avant : toujours 4 temps)', () => {
    expect(resolveCountIn({ countIn: 0 }, true)).toEqual({ count: 1, unit: 'bars' });          // ancien projet
    expect(resolveCountIn({ countIn: 2, countInUnit: 'bars' }, true)).toEqual({ count: 2, unit: 'bars' });
    expect(resolveCountIn({ countIn: 0, countInUnit: 'bars' }, true)).toEqual({ count: 0, unit: 'bars' });
    expect(resolveCountIn({ countIn: 2, countInUnit: 'beats' }, true)).toEqual({ count: 2, unit: 'beats' });
    expect(resolveCountIn({ countIn: 4, countInUnit: 'bars' }, false).count).toBe(0);
  });
  it('2 mesures en 3/4 à 90 BPM = 6 clics de 0,667 s, accent à chaque mesure', () => {
    const m = buildTempoMap(90, { numerator: 3, denominator: 4 }, []);
    const p = planCountIn(m, 0, { count: 2, unit: 'bars' });
    expect(p.clicks.length).toBe(6);
    close(p.duration, 4);
    expect(p.clicks.map(c => c.accent)).toEqual([true, false, false, true, false, false]);
    expect(p.clicks.map(c => c.label)).toEqual([1, 2, 3, 1, 2, 3]);
  });
  it('suit la mesure de l\'endroit où la prise commence (6/8 après la mesure 3)', () => {
    const m = buildTempoMap(120, { numerator: 4, denominator: 4 }, [{ id: 'e', bar: 2, numerator: 6, denominator: 8 }]);
    const p = planCountIn(m, 5, { count: 1, unit: 'bars' });
    expect(p.clicks.length).toBe(6);
    close(p.beatSec, 0.25);
    const q = planCountIn(m, 0, { count: 2, unit: 'beats' });
    expect(q.clicks.map(c => c.label)).toEqual([2, 1]);
  });
});

describe('pré-roll en secondes', () => {
  it('prioritaire sur les mesures quand il est réglé', () => {
    expect(rollSeconds({ preRollBars: 2 }, 'pre', 120)).toBe(4);
    expect(rollSeconds({ preRollBars: 2, preRollSec: 1.5 }, 'pre', 120)).toBe(1.5);
    expect(effectivePreRoll({ preRollSec: 3, preRollOn: true }, false, 120)).toBe(3);
  });
});
