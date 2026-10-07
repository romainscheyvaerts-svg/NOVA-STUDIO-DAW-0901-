import { describe, expect, it } from 'vitest';
import { MidiCaptureBuffer, buildCapture, guessTempo, PHRASE_GAP } from '../utils/midiCapture';

/** V25 : Capture MIDI (Live) — tampon permanent, clip créé après coup. */

function rig() {
  let clock = 100;
  let transport = { playing: false, time: 0 };
  const buf = new MidiCaptureBuffer(() => clock, () => transport);
  const play = (pitch: number, at: number, len: number, vel = 100) => {
    clock = at; if (transport.playing) transport = { playing: true, time: songAt(at) };
    buf.noteOn(pitch, vel);
    clock = at + len; if (transport.playing) transport = { playing: true, time: songAt(at + len) };
    buf.noteOff(pitch);
  };
  let songStart = 0, songClockStart = 0;
  const songAt = (c: number) => songStart + (c - songClockStart);
  return {
    buf, play,
    start: (song: number) => { songStart = song; songClockStart = clock; transport = { playing: true, time: song }; buf.setPlaying(true); },
    stop: () => { transport = { playing: false, time: transport.time }; buf.setPlaying(false); },
    setClock: (c: number) => { clock = c; },
  };
}

describe('tempo deviné', () => {
  it('croches à 95 BPM jouées un peu à la main → 95 BPM (± 1)', () => {
    const beat = 60 / 95;
    const onsets = Array.from({ length: 16 }, (_, i) => 3 + i * beat / 2 + (i % 3 === 0 ? 0.008 : -0.006));
    expect(Math.abs(guessTempo(onsets)! - 95)).toBeLessThanOrEqual(1);
  });
  it('noires à 140 BPM → 140 (pas 70)', () => {
    const onsets = Array.from({ length: 12 }, (_, i) => i * (60 / 140));
    expect(Math.abs(guessTempo(onsets)! - 140)).toBeLessThanOrEqual(0.5);
  });
  it('trop peu de notes : pas de tempo', () => {
    expect(guessTempo([0, 0.5])).toBeNull();
  });
});

describe('capture à l’arrêt', () => {
  it('garde la dernière phrase (après un silence), place les notes depuis la 1re attaque', () => {
    const r = rig();
    r.play(50, 100, 0.2);                       // vieille phrase
    const t0 = 100 + PHRASE_GAP + 5;
    [60, 62, 63, 65].forEach((p, i) => r.play(p, t0 + i * 0.5, 0.4, 90 + i));
    const phrase = r.buf.lastPhrase();
    expect(phrase.map(e => e.pitch)).toEqual([60, 62, 63, 65]);
    const res = buildCapture(phrase, { bpm: 120, projectEmpty: false, at: 4.1 })!;
    expect(res.mode).toBe('stopped');
    expect(res.guessedBpm).toBeNull();
    expect(res.start).toBeCloseTo(4, 9); // calé sur la mesure la plus proche de la tête de lecture
    expect(res.notes.map(n => +n.start.toFixed(3))).toEqual([0, 0.5, 1, 1.5]);
    expect(res.notes[0].duration).toBeCloseTo(0.4, 9);
    expect(res.notes[3].velocity).toBeCloseTo(93 / 127, 9);
    expect(res.duration).toBeCloseTo(2, 9);
  });
  it('projet vide : le tempo est deviné et le clip part du début', () => {
    const r = rig();
    const beat = 60 / 88;
    for (let i = 0; i < 8; i++) r.play(60 + (i % 3), 200 + i * beat, beat * 0.8);
    const res = buildCapture(r.buf.lastPhrase(), { bpm: 120, projectEmpty: true, at: 7 })!;
    expect(Math.abs(res.guessedBpm! - 88)).toBeLessThanOrEqual(1);
    expect(res.start).toBe(0);
    expect(res.duration).toBeCloseTo((60 / res.guessedBpm!) * 4 * 2, 6);
  });
});

describe('capture pendant la lecture', () => {
  it('les notes gardent leur place dans le morceau, le clip commence à la mesure', () => {
    const r = rig();
    r.setClock(300);
    r.start(9); // lecture lancée à 9 s du morceau
    r.play(60, 300.5, 0.25);  // morceau 9,5 s
    r.play(64, 301.0, 0.25);  // morceau 10 s
    const phrase = r.buf.lastPhrase();
    expect(phrase.every(e => e.songOn !== null)).toBe(true);
    const res = buildCapture(phrase, { bpm: 120, projectEmpty: false, at: 0 })!;
    expect(res.mode).toBe('playing');
    expect(res.start).toBeCloseTo(8, 9); // mesure 5 (4 mesures de 2 s)
    expect(res.notes.map(n => +n.start.toFixed(3))).toEqual([1.5, 2]);
    expect(res.notes[0].duration).toBeCloseTo(0.25, 9);
  });
  it('une nouvelle lecture = une nouvelle prise ; le badge compte les notes en mémoire', () => {
    const r = rig();
    r.setClock(10); r.start(0); r.play(60, 10.1, 0.1); r.stop();
    r.setClock(20); r.start(4); r.play(67, 20.1, 0.1);
    expect(r.buf.lastPhrase().map(e => e.pitch)).toEqual([67]);
    expect(r.buf.size).toBe(2);
    let calls = 0; const off = r.buf.subscribe(() => calls++);
    r.play(69, 20.5, 0.1); off();
    expect(calls).toBe(1);
  });
});
