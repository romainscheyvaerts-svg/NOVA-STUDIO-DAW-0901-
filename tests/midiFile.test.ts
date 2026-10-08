import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  parseMidi, writeMidi, MidiFileData, ticksToSeconds, initialBpm, hasTempoChanges, noteCount, midiFileName, MidiParseError,
} from '../utils/midiFile';
import { planMidiImport, novaToMidi, exportSources, partClip, partTrack, gmToDrumRow, drumRowToGm } from '../utils/midiImport';
import { TrackType } from '../types';
import { makeTrack } from './helpers/fixtures';

/** V25 : lecteur / écrivain .mid maison (formats 0 et 1, running status, tempo, batterie). */

const sample = (): MidiFileData => ({
  format: 1,
  ppq: 480,
  tempos: [{ tick: 0, usPerQuarter: 428571, bpm: 60_000_000 / 428571 }],
  timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
  tracks: [
    { name: 'Piano', program: 0, notes: [
      { pitch: 60, velocity: 100, startTick: 0, durationTicks: 480, channel: 0 },
      { pitch: 64, velocity: 90, startTick: 0, durationTicks: 480, channel: 0 },
      { pitch: 67, velocity: 80, startTick: 240, durationTicks: 1200, channel: 0 },
      { pitch: 72, velocity: 1, startTick: 1920, durationTicks: 7, channel: 0 },
    ] },
    { name: 'Batterie', notes: [
      { pitch: 36, velocity: 127, startTick: 0, durationTicks: 60, channel: 9 },
      { pitch: 42, velocity: 70, startTick: 120, durationTicks: 60, channel: 9 },
      { pitch: 38, velocity: 110, startTick: 480, durationTicks: 60, channel: 9 },
    ] },
  ],
});

const strip = (d: MidiFileData) => d.tracks.map(t => ({ name: t.name, notes: t.notes.map(n => ({ ...n })) }));

describe('midiFile : écriture puis lecture', () => {
  it('format 1 : aucune perte de note, vélocité, durée ni tempo', () => {
    const src = sample();
    const bytes = writeMidi(src);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    const back = parseMidi(bytes);
    expect(back.format).toBe(1);
    expect(back.ppq).toBe(480);
    expect(back.tracks).toHaveLength(3); // piste de tempo + 2 pistes
    expect(back.tempos[0].usPerQuarter).toBe(428571);
    expect(back.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(strip({ ...back, tracks: back.tracks.slice(1) })).toEqual(strip(src));
    expect(back.tracks[1].program).toBe(0);
  });

  it('format 0 : tout dans une piste, les canaux restent séparés', () => {
    const bytes = writeMidi(sample(), { format: 0 });
    const back = parseMidi(bytes);
    expect(back.format).toBe(0);
    expect(back.tracks).toHaveLength(1);
    expect(back.tracks[0].notes).toHaveLength(7);
    expect(back.tracks[0].notes.filter(n => n.channel === 9)).toHaveLength(3);
    expect(initialBpm(back)).toBeCloseTo(140, 3);
  });

  it('avec ou sans running status, le résultat est identique (et plus court avec)', () => {
    const a = writeMidi(sample(), { runningStatus: true });
    const b = writeMidi(sample(), { runningStatus: false });
    expect(a.length).toBeLessThan(b.length);
    expect(strip(parseMidi(a))).toEqual(strip(parseMidi(b)));
  });

  it('lit un running status écrit à la main (Note On vélocité 0 = Note Off)', () => {
    // MThd format 0, 1 piste, 96 ppq ; MTrk : 90 3C 64 | 60 3C 00 | 00 3E 50 | 60 3E 00 (statut omis) | FF 2F 00
    const trk = [0x00, 0x90, 0x3c, 0x64, 0x60, 0x3c, 0x00, 0x00, 0x3e, 0x50, 0x60, 0x3e, 0x00, 0x00, 0xff, 0x2f, 0x00];
    const bytes = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk,
    ]);
    const d = parseMidi(bytes);
    expect(d.tracks[0].notes).toEqual([
      { pitch: 60, velocity: 100, startTick: 0, durationTicks: 96, channel: 0 },
      { pitch: 62, velocity: 80, startTick: 96, durationTicks: 96, channel: 0 },
    ]);
    expect(initialBpm(d)).toBe(120); // pas de tempo : 120 par défaut
  });

  it('notes empilées sur la même hauteur : la plus ancienne se ferme d’abord', () => {
    const trk = [0x00, 0x90, 0x3c, 0x40, 0x10, 0x3c, 0x50, 0x10, 0x80, 0x3c, 0x00, 0x10, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00];
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
    const n = parseMidi(bytes).tracks[0].notes;
    expect(n.map(x => [x.startTick, x.durationTicks, x.velocity])).toEqual([[0, 32, 64], [16, 32, 80]]);
  });

  it('carte des tempos : ticks → secondes avec un changement de tempo', () => {
    const tempos = [{ tick: 0, usPerQuarter: 500000, bpm: 120 }, { tick: 960, usPerQuarter: 1000000, bpm: 60 }];
    expect(ticksToSeconds(960, 480, tempos)).toBeCloseTo(1, 9);
    expect(ticksToSeconds(1440, 480, tempos)).toBeCloseTo(2, 9);
    expect(hasTempoChanges({ tempos })).toBe(true);
  });

  it('refuse un fichier qui n’est pas du MIDI', () => {
    expect(() => parseMidi(new TextEncoder().encode('RIFF....WAVEfmt '))).toThrow(MidiParseError);
  });

  it('nom de fichier propre', () => {
    expect(midiFileName('Mélodie : A/B?')).toBe('Mélodie A B.mid');
  });
});

describe('midiImport : fichier ⇄ pistes NOVA', () => {
  it('aller-retour fichier → NOVA → fichier : mêmes notes en temps, vélocités, durées et tempo', () => {
    const src = sample();
    const plan = planMidiImport(parseMidi(writeMidi(src)), { projectBpm: 140, tempoMode: 'project', drumsToRack: false });
    expect(plan.parts.map(p => p.name)).toEqual(['Piano', 'Batterie']);
    expect(plan.parts[1].isDrums).toBe(true);
    const tracks = plan.parts.map((p, i) => partTrack(p, partClip(p, 0, plan.clipDuration, '#fff'), i));
    const out = novaToMidi(exportSources(tracks, 'all').sources, { bpm: 140, ppq: 480 });
    const back = parseMidi(writeMidi(out));
    expect(initialBpm(back)).toBeCloseTo(140, 2);
    const melo = back.tracks[1].notes.map(({ channel, ...n }) => n);
    expect(melo).toEqual(src.tracks[0].notes.map(({ channel, ...n }) => n));
    expect(back.tracks[2].notes.every(n => n.channel === 9)).toBe(true);
    expect(back.tracks[2].notes.map(n => [n.pitch, n.velocity, n.startTick, n.durationTicks])).toEqual(src.tracks[1].notes.map(n => [n.pitch, n.velocity, n.startTick, n.durationTicks]));
  });

  it('tempo du projet ou du fichier', () => {
    const d = parseMidi(writeMidi(sample()));
    const p1 = planMidiImport(d, { projectBpm: 70, tempoMode: 'project' });
    const p2 = planMidiImport(d, { projectBpm: 70, tempoMode: 'file' });
    expect(p1.bpm).toBe(70);
    expect(p2.bpm).toBeCloseTo(140, 3);
    // Note au tick 240 (une croche) : 0,428 s à 70 BPM, 0,214 s à 140 BPM.
    const at = (p: typeof p1) => p.parts[0].notes.find(n => n.pitch === 67)!.start;
    expect(at(p1)).toBeCloseTo(0.5 * 60 / 70, 6);
    expect(at(p2)).toBeCloseTo(0.5 * 60 / 140, 4);
    expect(p1.clipDuration).toBeCloseTo((60 / 70) * 4 * 2, 6); // arrondi à 2 mesures
  });

  it('canal 10 → boîte à rythmes (Kick, Snare, Hi-hat…) et retour en General MIDI', () => {
    expect([36, 38, 39, 42, 46, 49, 45].map(gmToDrumRow)).toEqual([0, 1, 2, 3, 4, 6, 5]);
    expect(['kick', 'snare', 'clap', 'hatc', 'hato'].map(id => drumRowToGm(id))).toEqual([36, 38, 39, 42, 46]);
    const plan = planMidiImport(parseMidi(writeMidi(sample())), { projectBpm: 140, tempoMode: 'project' });
    expect(plan.parts[1].notes.map(n => n.pitch)).toEqual([60, 63, 61]);
    const rows = ['kick', 'snare', 'clap', 'hatc', 'hato', 'perc', 'fx'].map(id => ({ id, name: id, sound: '' }));
    const drum = partTrack(plan.parts[1], partClip(plan.parts[1], 0, plan.clipDuration, '#f00'), 1, { drumMachine: { rows }, drumPads: [] });
    expect(drum.type).toBe(TrackType.DRUM_RACK);
    const back = novaToMidi(exportSources([drum], 'all').sources, { bpm: 140 });
    expect(back.tracks[0].notes.map(n => n.pitch)).toEqual([36, 42, 38]);
  });

  it('export d’un clip : le clip commence au tick 0 ; export d’une piste : positions absolues', () => {
    const t = makeTrack({ id: 't1', type: TrackType.MIDI, clips: [
      { id: 'c1', start: 2, duration: 2, offset: 0, fadeIn: 0, fadeOut: 0, name: 'A', color: '#fff', type: TrackType.MIDI, notes: [{ id: 'a', pitch: 60, start: 0.5, duration: 0.25, velocity: 0.5 }] },
    ] });
    const clip = exportSources([t], 'clip', 't1', 'c1');
    expect(novaToMidi(clip.sources, { bpm: 120, relativeTo: clip.relativeTo }).tracks[0].notes[0].startTick).toBe(960);
    const track = exportSources([t], 'track', 't1');
    const n = novaToMidi(track.sources, { bpm: 120 }).tracks[0].notes[0];
    expect(n.startTick).toBe(4800); // 2,5 s à 120 BPM = 5 temps = 4800 ticks à 960 ppq
    expect(n.velocity).toBe(64);
  });
});

describe('fichiers .mid réels d’autres DAW', () => {
  const fx = (f: string) => readFileSync(path.join(__dirname, 'fixtures', 'midi', f));

  it('Ableton (format 0, 96 ppq, sans tempo) : lu, importé, réexporté sans perte', () => {
    const d = parseMidi(fx('ableton-piano.mid'));
    expect(d.format).toBe(0);
    expect(d.ppq).toBe(96);
    expect(noteCount(d)).toBeGreaterThan(50);
    const plan = planMidiImport(d, { projectBpm: 98, tempoMode: 'project' });
    expect(plan.parts[0].name).toBe('PIANO 6');
    const tracks = plan.parts.map((p, i) => partTrack(p, partClip(p, 0, plan.clipDuration, '#fff'), i));
    const back = parseMidi(writeMidi(novaToMidi(exportSources(tracks, 'all').sources, { bpm: 98 })));
    const beats = (ppq: number) => (n: { startTick: number; durationTicks: number; pitch: number; velocity: number }) => [n.pitch, n.velocity, +(n.startTick / ppq).toFixed(4), +(n.durationTicks / ppq).toFixed(4)];
    const orig = d.tracks.flatMap(t => t.notes).map(beats(d.ppq)).sort();
    const again = back.tracks.flatMap(t => t.notes).map(beats(back.ppq)).sort();
    expect(again).toEqual(orig);
  });

  it('format 1 avec carte de tempos et batterie (canal 10)', () => {
    const d = parseMidi(fx('cover-drums.mid'));
    expect(d.format).toBe(1);
    expect(d.ppq).toBe(480);
    expect(d.tempos.length).toBeGreaterThan(3);
    expect(hasTempoChanges(d)).toBe(true);
    // Cet outil range la batterie sur le canal 11 : reconnue par le nom de la piste.
    const drums = d.tracks.flatMap(t => t.notes);
    expect(drums.length).toBeGreaterThan(100);
    const plan = planMidiImport(d, { projectBpm: 128, tempoMode: 'file' });
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].isDrums).toBe(true);
    expect(plan.parts[0].notes.every(n => n.pitch >= 60 && n.pitch <= 66)).toBe(true);
    // En mode « fichier », la dernière note tombe à son instant réel (carte des tempos).
    const lastTick = Math.max(...drums.map(n => n.startTick));
    const lastSec = Math.max(...plan.parts.flatMap(p => p.notes.map(n => n.start)));
    expect(lastSec).toBeCloseTo(ticksToSeconds(lastTick, d.ppq, d.tempos), 6);
  });
});
