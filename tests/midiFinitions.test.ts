import { describe, expect, it } from 'vitest';
import { parseMidi, writeMidi, MidiFileData } from '../utils/midiFile';
import { novaToMidi, partClip, partTrack, planMidiImport } from '../utils/midiImport';
import { buildCapture, MidiCaptureBuffer, placeCapture } from '../utils/midiCapture';
import { makeClip } from './helpers/fixtures';
import { TrackType } from '../types';

describe('capture MIDI à l’arrêt : un clip à part (comme Ableton)', () => {
  const bar = 2; // 120 BPM, 4/4
  const midiClip = (id: string, start: number, duration: number) => makeClip({ id, start, duration, type: TrackType.MIDI, notes: [] });

  it('piste libre à la tête de lecture : le clip se pose là, sans toucher aux autres', () => {
    expect(placeCapture([midiClip('a', 8, 2)], { start: 2, duration: 2, mode: 'stopped' }, bar)).toEqual({ hostId: null, start: 2 });
  });

  it('un clip couvre déjà la tête de lecture : jamais mélangé, posé juste après (mesure suivante)', () => {
    expect(placeCapture([midiClip('a', 0, 3)], { start: 2, duration: 2, mode: 'stopped' }, bar)).toEqual({ hostId: null, start: 4 });
    // Deux clips à la suite : après les deux.
    expect(placeCapture([midiClip('a', 0, 4), midiClip('b', 4, 2)], { start: 2, duration: 2, mode: 'stopped' }, bar)).toEqual({ hostId: null, start: 6 });
    // Trou trop court entre deux clips : on passe au suivant.
    expect(placeCapture([midiClip('a', 0, 4), midiClip('b', 5, 1)], { start: 2, duration: 2, mode: 'stopped' }, bar)).toEqual({ hostId: null, start: 6 });
  });

  it('pendant la lecture : les notes vont dans le clip qui couvre déjà ce passage (inchangé)', () => {
    expect(placeCapture([midiClip('a', 0, 8)], { start: 2, duration: 2, mode: 'playing' }, bar)).toEqual({ hostId: 'a', start: 2 });
    expect(placeCapture([], { start: 2, duration: 2, mode: 'playing' }, bar)).toEqual({ hostId: null, start: 2 });
  });

  it('de bout en bout : une phrase jouée à l’arrêt donne un clip « stopped » posé par placeCapture', () => {
    let clock = 10;
    const buf = new MidiCaptureBuffer(() => clock, () => ({ playing: false, time: 0 }));
    for (let i = 0; i < 4; i++) { clock = 10 + i * 0.5; buf.noteOn(60 + i, 100); clock += 0.25; buf.noteOff(60 + i); }
    const res = buildCapture(buf.lastPhrase(), { bpm: 120, projectEmpty: false, at: 2 })!;
    expect(res.mode).toBe('stopped');
    expect(placeCapture([midiClip('a', 0, 4)], res, bar).start).toBe(4);
  });
});

describe('batterie .mid : l’aller-retour garde les notes General MIDI d’origine', () => {
  // Caisse claire électrique (40), charley au pied (44), rimshot (37), ride (51), tom (45) : elles partagent des pads.
  const file = (): MidiFileData => ({
    format: 1, ppq: 960,
    tempos: [{ tick: 0, usPerQuarter: 500000, bpm: 120 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    tracks: [{ name: 'Drums', notes: [36, 38, 40, 42, 44, 46, 37, 51, 45, 39].map((pitch, i) => ({ pitch, velocity: 100, startTick: i * 240, durationTicks: 60, channel: 9 })) }],
  });

  it('import (pads de la boîte à rythmes) puis export : mêmes notes 36, 38, 40, 42, 44, 46, 37, 51, 45, 39', () => {
    const plan = planMidiImport(parseMidi(writeMidi(file())), { projectBpm: 120, tempoMode: 'project' });
    const part = plan.parts[0];
    expect(part.isDrums).toBe(true);
    // Sur les pads : 40 rejoint la caisse claire (pad 2), 44 le charley fermé…
    expect(part.notes.map(n => n.pitch)).toEqual([60, 61, 61, 63, 63, 64, 66, 66, 65, 62]);
    const clip = partClip(part, 0, plan.clipDuration, '#f97316');
    const track = partTrack(part, clip, 0, { drumMachine: { rows: [] }, drumPads: [] });
    const back = parseMidi(writeMidi(novaToMidi([{ track, clips: [clip] }], { bpm: 120 })));
    const drums = back.tracks.find(t => t.notes.length)!; // (piste de tempo en tête au format 1)
    expect(drums.notes.map(n => n.pitch)).toEqual([36, 38, 40, 42, 44, 46, 37, 51, 45, 39]);
    expect(drums.notes.every(n => n.channel === 9)).toBe(true);
  });

  it('une note déplacée sur un autre pad prend la note de ce pad ; une note dessinée garde la règle des pads', () => {
    const plan = planMidiImport(file(), { projectBpm: 120, tempoMode: 'project' });
    const part = plan.parts[0];
    const notes = part.notes.map(n => (n.gm === 40 ? { ...n, pitch: 60 } : n)); // 40 glissée sur le kick
    notes.push({ id: 'neuve', pitch: 61, start: 3, duration: 0.05, velocity: 0.8 }); // dessinée sur la caisse claire
    const clip = { ...partClip(part, 0, plan.clipDuration, '#f97316'), notes };
    const track = partTrack(part, clip, 0, { drumMachine: { rows: [] }, drumPads: [] });
    const out = novaToMidi([{ track, clips: [clip] }], { bpm: 120 }).tracks[0].notes.map(n => n.pitch);
    expect(out).not.toContain(40);
    expect(out.filter(p => p === 36)).toHaveLength(2);
    expect(out.filter(p => p === 38)).toHaveLength(2);
  });
});
