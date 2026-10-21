import { describe, it, expect, vi, afterEach } from 'vitest';
import { TrackType, type Clip, type Track, type MidiNote } from '../types';
import { applyMidiFx, clipsWithMidiFx, freezeMidiFx, defaultSlot, sanitizeMidiFx, type MidiFxSlot } from '../engine/midiFx';
import { LiveMidiFx, type LiveIO } from '../engine/midiFx/live';
import { buildTempoMap, quartersToTime } from '../utils/tempoMap';
import { isInScale } from '../utils/scales';

const TS = { numerator: 4, denominator: 4 };
const n = (pitch: number, start: number, duration: number, velocity = 0.8, id = `n${pitch}-${start}`): MidiNote => ({ id, pitch, start, duration, velocity });
const clip = (id: string, start: number, duration: number, notes: MidiNote[]): Clip => ({ id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#fff', type: TrackType.MIDI, notes });
const track = (clips: Clip[], midiFx?: MidiFxSlot[]): Track => ({ id: 'synth', name: 'Synth', type: TrackType.MIDI, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0, ...(midiFx ? { midiFx } : {}) });
const arp = (over: Partial<NonNullable<MidiFxSlot['arp']>> = {}): MidiFxSlot => ({ ...defaultSlot('arp', 'a'), arp: { rate: '1/16', pattern: 'UP', octaves: 1, gate: 50, ...over } });

describe('effets MIDI (L3, écart 9)', () => {
  const m140 = buildTempoMap(140, TS, []);
  it('arpège en doubles-croches à 140 BPM : notes à ±1 ms de la grille du morceau (en fait < 1 µs)', () => {
    // Accord Do-Mi-Sol tenu 1 mesure, dans un clip qui commence à la mesure 2.
    const bar = 4 * 60 / 140;
    const c = clip('c', bar, bar, [n(60, 0, bar), n(64, 0, bar), n(67, 0, bar)]);
    const out = applyMidiFx(c.notes!, [arp()], { clipStart: c.start, clipDuration: c.duration, map: m140, key: null, seed: c.id });
    expect(out.length).toBe(16);
    const step = 60 / 140 / 4;
    out.forEach((x, i) => expect(Math.abs(c.start + x.start - (bar + i * step)) * 1000).toBeLessThan(1e-3));
    expect(out.slice(0, 6).map(x => x.pitch)).toEqual([60, 64, 67, 60, 64, 67]);
    expect(out[0].duration).toBeCloseTo(step / 2, 9);
  });
  it('arpège calé sur la piste tempo (rampe) et pas sur le début du clip', () => {
    const m = buildTempoMap(90, TS, [{ id: 'r', bar: 4, bpm: 120, ramp: true }]);
    const c = clip('c', 0.1, 10, [n(60, 0, 9.9)]);
    const out = applyMidiFx(c.notes!, [arp({ rate: '1/4' })], { clipStart: c.start, clipDuration: c.duration, map: m, key: null, seed: 'c' });
    // Pas à chaque noire du MORCEAU, rampe comprise (le pas 0 tombe avant le clip : il saute).
    const qs = out.map(x => c.start + x.start);
    expect(qs.length).toBeGreaterThan(10);
    qs.forEach((t, i) => expect(Math.abs(t - quartersToTime(m, i + 1))).toBeLessThan(1e-9));
  });
  it('gamme forcée : 100 % des notes dans la gamme (12 demi-tons × 5 octaves, La mineur)', () => {
    const notes = Array.from({ length: 60 }, (_, i) => n(36 + i, i * 0.1, 0.1));
    const out = applyMidiFx(notes, [{ ...defaultSlot('scale', 's'), scale: { root: 9, scale: 'MINOR', dir: 'nearest' } }], { clipStart: 0, clipDuration: 10, map: m140, key: null, seed: 'x' });
    expect(out.length).toBe(60);
    expect(out.every(x => isInScale(x.pitch, 9, 'MINOR'))).toBe(true);
  });
  it('gamme du projet par défaut ; accord dans la gamme (une touche = un accord du ton)', () => {
    const key = { root: 0, scale: 'MAJOR' };
    const fx = [defaultSlot('scale', 's'), defaultSlot('chord', 'c')];
    const out = applyMidiFx([n(62, 0, 1)], fx, { clipStart: 0, clipDuration: 2, map: m140, key, seed: 'x' });
    expect(out.map(x => x.pitch)).toEqual([62, 65, 69]); // Ré mineur dans Do majeur
    const sharp = applyMidiFx([n(61, 0, 1)], fx, { clipStart: 0, clipDuration: 2, map: m140, key, seed: 'x' });
    expect(sharp.every(x => isInScale(x.pitch, 0, 'MAJOR'))).toBe(true);
    const maj = applyMidiFx([n(60, 0, 1)], [{ ...defaultSlot('chord', 'c'), chord: { shape: 'MIN7' } }], { clipStart: 0, clipDuration: 2, map: m140, key, seed: 'x' });
    expect(maj.map(x => x.pitch)).toEqual([60, 63, 67, 70]);
  });
  it('« Figer en notes » donne EXACTEMENT les notes entendues, effets coupés', () => {
    const t = track([clip('c', 0, 2, [n(60, 0, 1.5), n(67, 0, 1.5)])], [defaultSlot('chord', 'k'), arp()]);
    const heard = clipsWithMidiFx(t, t.clips, m140, { root: 0, scale: 'MAJOR' })[0].notes!;
    const f = freezeMidiFx(t, m140, { root: 0, scale: 'MAJOR' });
    expect(f.midiFx!.every(s => !s.on)).toBe(true);
    expect(f.clips[0].notes!.map(x => [x.pitch, x.start, x.duration, x.velocity])).toEqual(heard.map(x => [x.pitch, x.start, x.duration, x.velocity]));
    // Après le gel, le moteur joue les notes du clip (aucun effet actif) : même son.
    expect(clipsWithMidiFx(f, f.clips, m140)).toBe(f.clips);
  });
  it('lecture = export : mêmes objets mémorisés tant que rien ne change ; aléatoire reproductible', () => {
    const t = track([clip('c', 0, 2, [n(60, 0, 2), n(64, 0, 2), n(67, 0, 2)])], [arp({ pattern: 'RANDOM' })]);
    const a = clipsWithMidiFx(t, t.clips, m140, null);
    const b = clipsWithMidiFx(t, t.clips, m140, null);
    expect(a[0]).toBe(b[0]);
    const t2 = { ...t, midiFx: t.midiFx!.map(s => ({ ...s })) };
    expect(clipsWithMidiFx(t2, t2.clips, m140, null)[0].notes!.map(x => x.pitch)).toEqual(a[0].notes!.map(x => x.pitch));
    // Piste sans effet actif : les clips d'origine, sans copie (coût nul).
    const off = track(t.clips, [{ ...arp(), on: false }]);
    expect(clipsWithMidiFx(off, off.clips, m140)).toBe(off.clips);
  });
  it('réglages reçus bornés (collaboration, ancien projet)', () => {
    const s = sanitizeMidiFx([{ type: 'arp', id: 'x', arp: { rate: '1/3', octaves: 9, gate: 500 } }, { type: 'boom' }, { type: 'scale', scale: { root: 14, scale: 'MINOR' } }]);
    expect(s.length).toBe(2);
    expect(s[0].arp).toEqual({ rate: '1/8', pattern: 'UP', octaves: 4, gate: 100 });
    expect(s[1].scale).toEqual({ scale: 'MINOR', dir: 'nearest' });
    expect(sanitizeMidiFx(undefined)).toEqual([]);
  });
});

describe('effets MIDI au clavier, en direct', () => {
  afterEach(() => { vi.useRealTimers(); });
  const mkIO = (clock: { t: number }, map = buildTempoMap(120, TS, [])) => {
    const ev: { k: 'on' | 'off'; p: number; at: number }[] = [];
    const io: LiveIO = {
      attack: (_t, p, _v, at) => ev.push({ k: 'on', p, at }),
      release: (_t, p, at) => ev.push({ k: 'off', p, at }),
      now: () => clock.t, songAt: () => null, map: () => map, key: () => ({ root: 0, scale: 'MAJOR' }),
    };
    return { io, ev };
  };
  it('accord tenu → arpège aux doubles-croches ; touches lâchées → plus rien ne tourne', () => {
    vi.useFakeTimers();
    const clock = { t: 10 };
    const { io, ev } = mkIO(clock);
    const L = new LiveMidiFx();
    L.setTrackFx('s', [arp({ rate: '1/16', gate: 50 })]);
    [60, 64, 67].forEach(p => L.noteOn('s', p, 0.9, io));
    expect(L.activeTimers()).toBe(1);
    for (let i = 0; i < 40; i++) { clock.t += 0.025; vi.advanceTimersByTime(25); }
    const ons = ev.filter(e => e.k === 'on');
    expect(ons.slice(0, 6).map(e => e.p)).toEqual([60, 64, 67, 60, 64, 67]);
    const step = 60 / 120 / 4;
    for (let i = 1; i < 6; i++) expect(ons[i].at - ons[i - 1].at).toBeCloseTo(step, 9);
    [60, 64, 67].forEach(p => L.noteOff('s', p, io));
    expect(L.activeTimers()).toBe(0);
  });
  it('sans arpège : gamme + accord sur chaque touche, relâchés ensemble ; piste sans effet = touche telle quelle', () => {
    const clock = { t: 1 };
    const { io, ev } = mkIO(clock);
    const L = new LiveMidiFx();
    L.setTrackFx('s', [defaultSlot('scale', 's'), defaultSlot('chord', 'c')]);
    L.noteOn('s', 61, 1, io);
    expect(ev.filter(e => e.k === 'on').every(e => isInScale(e.p, 0, 'MAJOR'))).toBe(true);
    expect(ev.filter(e => e.k === 'on').length).toBe(3);
    L.noteOff('s', 61, io);
    expect(ev.filter(e => e.k === 'off').length).toBe(3);
    expect(L.has('autre')).toBe(false);
    L.setTrackFx('s', []);
    expect(L.has('s')).toBe(false);
    expect(L.activeTimers()).toBe(0);
  });
});
