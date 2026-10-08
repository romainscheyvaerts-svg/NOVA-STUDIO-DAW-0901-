import { describe, expect, it } from 'vitest';
import {
  midiTimestampToContextTime, foldLoop, MidiTakeRecorder, applyMidiTake, applyLoopTake, eraseMidiZone,
  quantizeRecNotes, normalizeMidiRecPrefs, PICKUP, ClockOffset,
} from '../utils/midiRecord';
import { Clip, TrackType } from '../types';

/** R16 : enregistrement MIDI armé (timing, remplacer / fusionner / boucle, punch, quantification). */

const BPM = 120;
const beat = 0.5;
const bar = 2;

const midiClip = (id: string, start: number, duration: number, notes: [number, number, number][]): Clip => ({
  id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#fff', type: TrackType.MIDI,
  notes: notes.map(([pitch, s, d], i) => ({ id: `${id}-${i}`, pitch, start: s, duration: d, velocity: 0.8 })),
});

const opts = { bar, stamp: 't', takeNumber: 1, name: 'Prise MIDI 1', color: '#0ff' };

describe('conversion des horodatages Web MIDI', () => {
  it('passe par getOutputTimestamp : la latence de sortie est compensée et l’arrivée tardive ne compte pas', () => {
    // À performance.now() = 10 000 ms, on entendait le son du temps contexte 5,000 s.
    const stamp = { contextTime: 5, performanceTime: 10000 };
    // Note émise à 10 250 ms, traitée 30 ms plus tard (gigue) : seule l'émission compte.
    const t = midiTimestampToContextTime(10250, { stamp, ctxNow: 5.29, perfNow: 10280 });
    expect(t).toBeCloseTo(5.25, 9);
  });

  it('sans getOutputTimestamp : maintenant − âge du message − latence de sortie', () => {
    const t = midiTimestampToContextTime(1000, { stamp: null, ctxNow: 3, perfNow: 1020, outputLatency: 0.012 });
    expect(t).toBeCloseTo(3 - 0.02 - 0.012, 9);
  });

  it('applique le décalage MIDI (MIDI Input Offset) et tolère un horodatage absent', () => {
    const stamp = { contextTime: 5, performanceTime: 10000 };
    expect(midiTimestampToContextTime(10100, { stamp, ctxNow: 0, perfNow: 0, offsetMs: 8 })).toBeCloseTo(5.092, 9);
    expect(midiTimestampToContextTime(0, { stamp, ctxNow: 9, perfNow: 10500 })).toBeCloseTo(5.5, 9);
  });

  it('une gigue d’arrivée de ±20 ms laisse les positions à moins d’1 ms', () => {
    const stamp = { contextTime: 2, performanceTime: 50000 };
    const anchor = 2 - 0; // le morceau commence au temps contexte 2 s
    const targets = Array.from({ length: 16 }, (_, i) => i * 0.25 + (i % 3 === 0 ? 0.003 : i % 3 === 1 ? -0.007 : 0.0011));
    for (const pos of targets) {
      const ts = stamp.performanceTime + (anchor + pos - stamp.contextTime) * 1000;
      const arrival = ts + 20 * Math.sin(pos * 13);
      const ctx = midiTimestampToContextTime(ts, { stamp, ctxNow: stamp.contextTime + (arrival - stamp.performanceTime) / 1000, perfNow: arrival });
      expect(Math.abs(ctx - anchor - pos)).toBeLessThan(0.001);
    }
  });
});

describe('boucle', () => {
  it('replie le temps linéaire sur la boucle, tour par tour', () => {
    const loop = { start: 2, end: 4 };
    expect(foldLoop(1, loop)).toEqual({ pass: 0, pos: 1 });
    expect(foldLoop(3, loop)).toEqual({ pass: 0, pos: 3 });
    expect(foldLoop(4.5, loop)).toEqual({ pass: 1, pos: 2.5 });
    expect(foldLoop(7.25, loop)).toEqual({ pass: 2, pos: 3.25 });
  });
  it('une note jouée juste avant la fin du tour tombe sur le temps 1 du tour suivant', () => {
    const loop = { start: 2, end: 4 };
    expect(foldLoop(3.98, loop, PICKUP)).toEqual({ pass: 1, pos: 2 });
    expect(foldLoop(5.99, loop, PICKUP)).toEqual({ pass: 2, pos: 2 });
  });
});

describe('prise', () => {
  it('garde la position exacte et la durée de chaque note', () => {
    const r = new MidiTakeRecorder({ recStart: 0 });
    r.noteOn(60, 100, 1.0012); r.noteOff(60, 1.4);
    r.noteOn(64, 90, 1.5); r.noteOff(64, 1.75);
    const t = r.finish(3);
    expect(t.passes).toHaveLength(1);
    expect(t.passes[0].notes.map(n => [n.pitch, +n.start.toFixed(4), +n.duration.toFixed(4), n.velocity])).toEqual([[60, 1.0012, 0.3988, 100], [64, 1.5, 0.25, 90]]);
  });

  it('punch : seules les notes de la zone sont gardées ; une note un peu en avance est ramenée au point d’entrée', () => {
    const r = new MidiTakeRecorder({ recStart: 0, keepFrom: 2, keepTo: 4 });
    r.noteOn(50, 100, 1); r.noteOff(50, 1.2);       // pré-roll : jetée
    r.noteOn(52, 100, 1.98); r.noteOff(52, 2.2);    // 20 ms en avance : ramenée à 2
    r.noteOn(55, 100, 3.8); r.noteOff(55, 4.6);     // dépasse la sortie : coupée à 4
    r.noteOn(57, 100, 4.2); r.noteOff(57, 4.4);     // post-roll : jetée
    const n = r.finish(5).passes[0].notes;
    expect(n.map(x => [x.pitch, +x.start.toFixed(3), +x.duration.toFixed(3)])).toEqual([[52, 2, 0.2], [55, 3.8, 0.2]]);
  });

  it('décompte : rien n’est écrit avant le début de la prise', () => {
    const r = new MidiTakeRecorder({ recStart: 4, keepFrom: 4 });
    r.noteOn(60, 100, 3.5); r.noteOff(60, 3.6);
    r.noteOn(62, 100, 4.0); r.noteOff(62, 4.2);
    expect(r.finish(6).passes[0].notes.map(n => n.pitch)).toEqual([62]);
  });

  it('enregistre le pitch bend, la modulation et le sustain, avec la valeur tenue au début de la zone', () => {
    const r = new MidiTakeRecorder({ recStart: 0, keepFrom: 1 });
    r.control('cc64', 127, 0.5); // pédale enfoncée pendant le pré-roll
    r.control('pb', 0, 1.1); r.control('pb', 4096, 1.2); r.control('pb', 8191, 1.3); r.control('pb', 0, 1.6);
    r.control('cc1', 64, 1.5);
    r.control('cc64', 0, 2);
    const t = r.finish(3).passes[0];
    expect(t.cc.cc64).toEqual([{ t: 1, v: 127 }, { t: 2, v: 0 }]);
    expect(t.cc.pb.map(p => p.v)).toEqual([0, 4096, 8191, 0]);
    expect(t.cc.cc1).toEqual([{ t: 1.5, v: 64 }]);
  });

  it('boucle de 4 tours : chaque tour a ses notes, aux mêmes positions dans la boucle', () => {
    const loop = { start: 0, end: 2 };
    const r = new MidiTakeRecorder({ recStart: 0, loop });
    for (let k = 0; k < 4; k++) {
      r.noteOn(36 + k, 100, k * 2 + 0.5); r.noteOff(36 + k, k * 2 + 0.7);
    }
    const t = r.finish(8);
    expect(t.passes.map(p => [p.pass, p.notes[0].pitch, +p.notes[0].start.toFixed(3), p.complete])).toEqual([[0, 36, 0.5, true], [1, 37, 0.5, true], [2, 38, 0.5, true], [3, 39, 0.5, true]]);
  });

  it('une note tenue au-delà de la fin de boucle s’arrête à la fin du tour', () => {
    const r = new MidiTakeRecorder({ recStart: 0, loop: { start: 0, end: 2 } });
    r.noteOn(60, 100, 1.5); r.noteOff(60, 2.5);
    expect(r.finish(3).passes[0].notes[0].duration).toBeCloseTo(0.5, 9);
  });
});

describe('modes', () => {
  const take = (pairs: [number, number, number][]) => pairs.map(([pitch, start, duration]) => ({ pitch, start, duration, velocity: 100, pass: 0 }));

  it('fusionner : les notes rejoignent le clip qui couvre le passage', () => {
    const clips = [midiClip('a', 0, 4, [[60, 0, 0.5], [62, 1, 0.5]])];
    const r = applyMidiTake(clips, take([[64, 1, 0.5]]), {}, { ...opts, mode: 'merge', range: { start: 0, end: 4 } });
    expect(r.clipId).toBe('a');
    expect(r.clips).toHaveLength(1);
    expect(r.clips[0].notes!.map(n => n.pitch).sort()).toEqual([60, 62, 64]);
    expect(r.removed).toBe(0);
  });

  it('remplacer : la zone enregistrée est effacée puis réécrite, le reste est gardé', () => {
    const clips = [midiClip('a', 0, 8, [[60, 0, 0.5], [62, 2.5, 0.5], [65, 3, 2], [67, 6, 0.5]])];
    const r = applyMidiTake(clips, take([[70, 2.5, 0.5]]), {}, { ...opts, mode: 'replace', range: { start: 2, end: 4 } });
    const notes = r.clips[0].notes!.map(n => [n.pitch, n.start, +n.duration.toFixed(3)]).sort((x, y) => x[1] - y[1]);
    expect(notes).toEqual([[60, 0, 0.5], [70, 2.5, 0.5], [67, 6, 0.5]]);
    expect(r.removed).toBe(2);
  });

  it('remplacer coupe une note qui déborde dans la zone', () => {
    const clips = [midiClip('a', 0, 8, [[48, 1, 3]])];
    const r = eraseMidiZone(clips, 2, 4);
    expect(r.clips[0].notes![0].duration).toBeCloseTo(1, 9);
  });

  it('rien d’enregistré : rien n’est effacé (un REC par erreur ne détruit rien)', () => {
    const clips = [midiClip('a', 0, 4, [[60, 0, 0.5]])];
    const r = applyMidiTake(clips, [], {}, { ...opts, mode: 'replace', range: { start: 0, end: 4 } });
    expect(r.clips).toBe(clips);
  });

  it('sans clip : nouveau clip calé sur les mesures', () => {
    const r = applyMidiTake([], take([[60, 2.3, 0.4], [62, 5.1, 0.4]]), {}, { ...opts, mode: 'merge', range: { start: 2, end: 6 } });
    const c = r.clips[0];
    expect([c.start, c.duration, c.type, c.takeNumber]).toEqual([2, 4, TrackType.MIDI, 1]);
    expect(c.notes!.map(n => +n.start.toFixed(3))).toEqual([0.3, 3.1]);
  });

  it('agrandit le clip hôte quand la prise le dépasse', () => {
    const clips = [midiClip('a', 2, 2, [[60, 0, 0.5]])];
    const r = applyMidiTake(clips, take([[62, 1.5, 0.3], [64, 4.5, 0.3]]), {}, { ...opts, mode: 'merge', range: { start: 1.5, end: 5 } });
    const c = r.clips[0];
    expect([c.start, c.duration]).toEqual([0, 6]);
    expect(c.notes!.map(n => [n.pitch, +n.start.toFixed(3)]).sort((x, y) => x[1] - y[1])).toEqual([[62, 1.5], [60, 2], [64, 4.5]]);
  });

  it('quantification à l’entrée : les débuts vont sur la grille (force réglable)', () => {
    const q = quantizeRecNotes([{ start: 0.27 }, { start: 0.49 }], 0.125, 1);
    expect(q.map(n => +n.start.toFixed(4))).toEqual([0.25, 0.5]);
    const half = quantizeRecNotes([{ start: 0.27 }], 0.25, 0.5);
    expect(half[0].start).toBeCloseTo(0.26, 9);
    const r = applyMidiTake([], take([[60, 0.27, 0.2]]), {}, { ...opts, mode: 'merge', range: { start: 0, end: 2 }, quantize: { grid: 0.125, strength: 1 } });
    expect(r.clips[0].notes![0].start).toBeCloseTo(0.25, 9);
  });

  it('contrôleurs : écrits dans le clip, et la fusion réécrit seulement le passage couvert', () => {
    const base = midiClip('a', 0, 4, [[60, 0, 1]]);
    base.cc = { pb: [{ t: 0.5, v: 1000 }, { t: 3, v: -2000 }] };
    const r = applyMidiTake([base], take([[62, 1, 0.5]]), { pb: [{ t: 1, v: 8191 }, { t: 1.5, v: 0 }] }, { ...opts, mode: 'merge', range: { start: 0, end: 4 } });
    expect(r.clips[0].cc!.pb).toEqual([{ t: 0.5, v: 1000 }, { t: 1, v: 8191 }, { t: 1.5, v: 0 }, { t: 3, v: -2000 }]);
  });
});

describe('boucle : une prise par tour ou tout fusionner', () => {
  const loopTake = () => {
    const r = new MidiTakeRecorder({ recStart: 0, loop: { start: 0, end: 2 } });
    for (let k = 0; k < 4; k++) { r.noteOn(36 + k, 100, k * 2 + 0.5); r.noteOff(36 + k, k * 2 + 0.7); }
    return r.finish(8);
  };

  it('une prise par tour : 4 clips, le dernier tour joue, les autres sont muets', () => {
    const res = applyLoopTake([], loopTake(), { ...opts, style: 'takes' });
    expect(res.takes).toBe(4);
    expect(res.clips.map(c => [c.name, c.isMuted, c.notes![0].pitch])).toEqual([
      ['Prise 1', true, 36], ['Prise 2', true, 37], ['Prise 3', true, 38], ['Prise 4', false, 39]]);
    expect(res.clips.every(c => c.start === 0 && c.duration === 2)).toBe(true);
  });

  it('arrêter au milieu d’un tour garde le dernier tour complet comme prise active', () => {
    const r = new MidiTakeRecorder({ recStart: 0, loop: { start: 0, end: 2 } });
    r.noteOn(36, 100, 0.5); r.noteOff(36, 0.7);
    r.noteOn(37, 100, 2.5); r.noteOff(37, 2.7);
    const res = applyLoopTake([], r.finish(3), { ...opts, style: 'takes' });
    expect(res.clips.map(c => c.isMuted)).toEqual([false, true]);
  });

  it('tout fusionner : les 4 tours s’empilent dans un seul clip', () => {
    const res = applyLoopTake([], loopTake(), { ...opts, style: 'merge' });
    expect(res.clips).toHaveLength(1);
    expect(res.clips[0].notes!.map(n => n.pitch).sort()).toEqual([36, 37, 38, 39]);
    expect(res.clips[0].notes!.every(n => Math.abs(n.start - 0.5) < 1e-9)).toBe(true);
  });
});

describe('préférences', () => {
  it('valeurs par défaut et bornes', () => {
    expect(normalizeMidiRecPrefs({})).toMatchObject({ mode: 'merge', loopStyle: 'takes', thru: true, offsetMs: 0 });
    expect(normalizeMidiRecPrefs({ mode: 'loop', loopStyle: 'merge', offsetMs: 999, thru: false })).toMatchObject({ mode: 'loop', loopStyle: 'merge', offsetMs: 200, thru: false });
  });
});

void BPM; void beat;

describe('écart d’horloges stabilisé (ClockOffset)', () => {
  it('la médiane gomme le tremblement de getOutputTimestamp (±1,4 ms)', () => {
    const c = new ClockOffset();
    const truth = 12.3456;
    // Tremblement en dents de scie de ±1,4 ms, comme les blocs du son.
    for (let i = 0; i < 60; i++) c.push(truth + (((i * 37) % 29) / 28 - 0.5) * 0.0028, i * 40);
    expect(Math.abs(c.value()! - truth)).toBeLessThan(0.0002);
    const t = midiTimestampToContextTime(5000, { ctxNow: 0, perfNow: 0, clockOffset: c.value() });
    expect(Math.abs(t - (truth + 5))).toBeLessThan(0.0002);
  });
  it('oublie les vieux relevés (dérive lente des horloges)', () => {
    const c = new ClockOffset(1000);
    for (let i = 0; i < 30; i++) c.push(1, i * 40);
    for (let i = 0; i < 40; i++) c.push(1.002, 5000 + i * 40);
    expect(c.value()).toBeCloseTo(1.002, 9);
  });
});
