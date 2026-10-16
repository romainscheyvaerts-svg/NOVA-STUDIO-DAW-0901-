import { describe, expect, it } from 'vitest';
import { parseMidi, writeMidi, MidiFileData, MidiFileNote } from '../utils/midiFile';
import { planMidiImport, novaToMidi, exportSources, partClip, partTrack } from '../utils/midiImport';
import { bendSemis, bendValue, planSlideBends, SLIDE_BEND_RANGE } from '../utils/midiSlides';
import { MidiNote, TrackType } from '../types';
import { makeTrack } from './helpers/fixtures';

/** 16/10/2026 : glissés par note du piano roll pro ⇄ pitch bend (+ RPN 0) dans les .mid. */

const file = (notes: MidiFileNote[], extra: Partial<MidiFileData> = {}): MidiFileData => ({
  format: 1, ppq: 960,
  tempos: [{ tick: 0, usPerQuarter: 500000, bpm: 120 }],
  timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
  tracks: [{ name: '808', notes }],
  ...extra,
});
const N = (pitch: number, startTick: number, durationTicks: number, slide = false, channel = 0, velocity = 100): MidiFileNote =>
  ({ pitch, velocity, startTick, durationTicks, channel, ...(slide ? { slide: true } : {}) });
const allNotes = (d: MidiFileData) => d.tracks.flatMap(t => t.notes);
const key = (n: MidiFileNote) => [n.pitch, n.startTick, n.durationTicks, !!n.slide];
const sorted = (l: MidiFileNote[]) => l.map(key).sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number));

/** Événements bruts (statut, données) d'une piste, running status compris. */
function rawEvents(bytes: Uint8Array, trackIndex: number): { tick: number; status: number; d1: number; d2: number }[] {
  let p = 14, t = -1;
  while (p < bytes.length) {
    const len = (bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7];
    if (++t === trackIndex) {
      const out: { tick: number; status: number; d1: number; d2: number }[] = [];
      let q = p + 8, tick = 0, st = 0;
      const end = q + len;
      const vlq = () => { let v = 0, c; do { c = bytes[q++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
      while (q < end) {
        tick += vlq();
        let s = bytes[q];
        if (s & 0x80) q++; else s = st;
        if (s === 0xff) { q++; const l = vlq(); q += l; continue; }
        st = s;
        const d1 = bytes[q++];
        const d2 = (s & 0xf0) === 0xc0 || (s & 0xf0) === 0xd0 ? 0 : bytes[q++];
        out.push({ tick, status: s, d1, d2 });
      }
      return out;
    }
    p += 8 + len;
  }
  return [];
}

describe('glissés → pitch bend → glissés (fichier .mid)', () => {
  it('808 : deux glissés sur une note tenue, positions et hauteurs exactes à la relecture', () => {
    const src = [N(36, 0, 3840), N(43, 960, 480, true), N(31, 2400, 960, true), N(38, 3840, 960)];
    const bytes = writeMidi(file(src));
    const back = parseMidi(bytes);
    expect(sorted(allNotes(back))).toEqual(sorted(src));
    expect(allNotes(back).every(n => n.channel === 0)).toBe(true);
    // Aucune Note On pour les glissés : seulement l'hôte et la note suivante.
    const ev = rawEvents(bytes, 1);
    const ons = ev.filter(e => (e.status & 0xf0) === 0x90 && e.d2 > 0).map(e => e.d1);
    expect(ons).toEqual([36, 38]);
    // RPN 0 en tête de piste : CC101 0, CC100 0, CC6 = 24, CC38 0, puis RPN nul.
    const cc = ev.filter(e => (e.status & 0xf0) === 0xb0);
    expect(cc.slice(0, 6).map(e => [e.tick, e.d1, e.d2])).toEqual([[0, 101, 0], [0, 100, 0], [0, 6, SLIDE_BEND_RANGE], [0, 38, 0], [0, 101, 127], [0, 100, 127]]);
    // Pitch bend : +7 demi-tons à la fin du 1er glissé, −5 à la fin du 2e, centre avant la note suivante.
    const pb = ev.filter(e => (e.status & 0xf0) === 0xe0).map(e => ({ tick: e.tick, semis: bendSemis((e.d2 << 7) | e.d1, SLIDE_BEND_RANGE) }));
    expect(pb.find(e => e.tick === 1440)!.semis).toBeCloseTo(7, 2);
    expect(pb.filter(e => e.tick === 3360).pop()!.semis).toBeCloseTo(-5, 2);
    expect(pb[pb.length - 1]).toEqual({ tick: 3840, semis: 0 });
    // La rampe monte régulièrement (pas de saut).
    const ramp = pb.filter(e => e.tick > 960 && e.tick <= 1440).map(e => e.semis);
    expect(ramp.length).toBeGreaterThan(10);
    ramp.slice(1).forEach((v, i) => expect(v).toBeGreaterThan(ramp[i]));
  });

  it('glissés enchaînés bout à bout et glissé qui dépasse la fin de la note', () => {
    const src = [N(48, 0, 1920), N(50, 480, 240, true), N(53, 720, 240, true), N(55, 1440, 960, true)];
    expect(sorted(allNotes(parseMidi(writeMidi(file(src)))))).toEqual(sorted(src));
  });

  it('glissé plus grand que ±24 : la plage annoncée s’élargit (±36), hauteur exacte', () => {
    const src = [N(30, 0, 1920), N(60, 480, 480, true)];
    const bytes = writeMidi(file(src));
    const cc6 = rawEvents(bytes, 1).find(e => (e.status & 0xf0) === 0xb0 && e.d1 === 6)!;
    expect(cc6.d2).toBe(36);
    expect(sorted(allNotes(parseMidi(bytes)))).toEqual(sorted(src));
  });

  it('accord : la note glissée part sur un canal libre (une note par canal), rendue à la piste à la relecture', () => {
    const src = [N(60, 0, 1920), N(64, 0, 1920), N(67, 960, 480, true)];
    const plan = planSlideBends(file(src).tracks, 960);
    expect(plan.moved).toBe(1);
    const moved = plan.notes[0].find(n => n.channel !== 0)!;
    expect(moved.pitch).toBe(60); // l'hôte = la plus récente ; à départ égal, la première (comme le piano roll)
    const bytes = writeMidi(file(src));
    const ev = rawEvents(bytes, 1);
    // Les bends ne touchent que le canal de l'hôte.
    expect(new Set(ev.filter(e => (e.status & 0xf0) === 0xe0).map(e => e.status & 0x0f))).toEqual(new Set([moved.channel]));
    const back = allNotes(parseMidi(bytes));
    expect(sorted(back)).toEqual(sorted(src));
    expect(back.every(n => n.channel === 0)).toBe(true);
  });

  it('plus aucun canal libre : l’hôte reste sur son canal (compté), le fichier reste valide', () => {
    const tracks = Array.from({ length: 15 }, (_, i) => ({ name: `P${i}`, notes: [N(60, 0, 1920, false, i === 9 ? 15 : i), N(64, 0, 1920, false, i === 9 ? 15 : i), ...(i === 0 ? [N(67, 960, 480, true)] : [])] }));
    const plan = planSlideBends(tracks, 960);
    expect(plan.shared).toBe(1);
    expect(plan.moved).toBe(0);
    expect(() => parseMidi(writeMidi({ ...file([]), tracks }))).not.toThrow();
  });

  it('note glissée sans note tenue : écrite comme une note normale', () => {
    const back = parseMidi(writeMidi(file([N(60, 0, 480), N(62, 960, 480, true)])));
    expect(allNotes(back).map(key)).toEqual([[60, 0, 480, false], [62, 960, 480, false]]);
  });

  it('fichier d’un autre DAW : plage GM ±2 sans RPN, vibrato ignoré, bend vers un demi-ton entier relu en glissé', () => {
    // Écrit à la main : note 40 (0 → 1920), vibrato ±0,3 demi-ton, puis rampe jusqu'à +2 (plage GM par défaut).
    const vib = [480, 520, 560, 600].map((t, i) => ({ tick: t, v: bendValue(i % 2 ? -0.3 : 0.3, 2) }));
    const ramp = [960, 1000, 1040, 1080, 1120].map((t, i) => ({ tick: t, v: bendValue((2 * i) / 4, 2) }));
    const body: number[] = [0x00, 0x90, 40, 100];
    let last = 0;
    const push = (tick: number, bytes: number[]) => { let d = tick - last; last = tick; const v = [d & 0x7f]; while ((d >>= 7) > 0) v.unshift((d & 0x7f) | 0x80); body.push(...v, ...bytes); };
    [...vib, { tick: 640, v: 8192 }, ...ramp].forEach(e => push(e.tick, [0xe0, e.v & 0x7f, e.v >> 7]));
    push(1920, [0x80, 40, 0]);
    push(1920, [0xff, 0x2f, 0x00]);
    const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x03, 0xc0];
    const trk = [0x4d, 0x54, 0x72, 0x6b, (body.length >> 24) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
    const notes = allNotes(parseMidi(new Uint8Array([...hdr, ...trk])));
    // Vibrato : pas de glissé ; rampe : glissé 40 → 42, de son point de départ (960) à sa fin (1120).
    expect(notes.map(key)).toEqual([[40, 0, 1920, false], [42, 960, 160, true]]);
  });
});

describe('glissés ⇄ pistes NOVA (export / import .mid)', () => {
  const clipOf = (notes: MidiNote[]) => ({ id: 'c1', start: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, name: 'Clip', color: '#fff', type: TrackType.MIDI, notes });
  const line: MidiNote[] = [
    { id: 'h', pitch: 36, start: 0, duration: 2, velocity: 0.9 },
    { id: 's1', pitch: 41, start: 0.5, duration: 0.25, velocity: 0.8, slide: true },
    { id: 's2', pitch: 34, start: 1.25, duration: 0.5, velocity: 0.8, slide: true },
    { id: 'n2', pitch: 38, start: 2, duration: 1, velocity: 0.7 },
    { id: 'solo', pitch: 43, start: 3.25, duration: 0.25, velocity: 0.6, slide: true }, // seul : joué comme une note normale
  ];

  it('Synthé NOVA : export → import, positions (s) et hauteurs exactes, glissés gardés', () => {
    const t = makeTrack({ id: 'syn', type: TrackType.MIDI, name: '808 LEAD', novaSynth: {} as any, clips: [clipOf(line)] });
    const data = novaToMidi(exportSources([t], 'all').sources, { bpm: 120 });
    expect(data.tracks[0].notes.filter(n => n.slide).length).toBe(2);
    const plan = planMidiImport(parseMidi(writeMidi(data)), { projectBpm: 120, tempoMode: 'project' });
    expect(plan.parts).toHaveLength(1);
    const got = plan.parts[0].notes.map(n => ({ p: n.pitch, s: +n.start.toFixed(6), d: +n.duration.toFixed(6), slide: !!n.slide })).sort((a, b) => a.s - b.s);
    expect(got).toEqual(line.map(n => ({ p: n.pitch, s: n.start, d: n.duration, slide: n.id === 's1' || n.id === 's2' })));
    // Réimporté puis réexporté : mêmes octets (aller-retour stable).
    const t2 = partTrack(plan.parts[0], partClip(plan.parts[0], 0, plan.clipDuration, '#fff'), 0);
    const again = novaToMidi(exportSources([{ ...t2, novaSynth: {} as any }], 'all').sources, { bpm: 120 });
    again.tracks[0].name = data.tracks[0].name;
    expect(Array.from(writeMidi(again))).toEqual(Array.from(writeMidi(data)));
  });

  it('808 : idem ; piano (instrument sans glissé) : notes normales, comme on l’entend', () => {
    const t808 = makeTrack({ id: 'b', type: TrackType.MIDI, bass808: { style: 'clean', glideTime: 0.1 } as any, clips: [clipOf(line)] });
    expect(novaToMidi(exportSources([t808], 'all').sources, { bpm: 120 }).tracks[0].notes.filter(n => n.slide).length).toBe(2);
    const piano = makeTrack({ id: 'p', type: TrackType.MIDI, clips: [clipOf(line)] });
    const d = novaToMidi(exportSources([piano], 'all').sources, { bpm: 120 });
    expect(d.tracks[0].notes.some(n => n.slide)).toBe(false);
    expect(allNotes(parseMidi(writeMidi(d)))).toHaveLength(5);
  });

  it('notes muettes : un glissé muet n’est pas exporté et ne fait rien glisser', () => {
    const muted = line.map(n => (n.id === 's1' ? { ...n, muted: true } : n));
    const t = makeTrack({ id: 'syn', type: TrackType.MIDI, novaSynth: {} as any, clips: [clipOf(muted)] });
    const back = allNotes(parseMidi(writeMidi(novaToMidi(exportSources([t], 'all').sources, { bpm: 120 }))));
    expect(back.filter(n => n.slide).map(n => n.pitch)).toEqual([34]);
  });
});
