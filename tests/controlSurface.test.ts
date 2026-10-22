import { FADER_MAX_GAIN } from '../utils/faderLaw';
import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import {
  McuCodec, MCU_NOTES, decodeRelative, encodeRelative, mcuChallengeResponse, panToRing, sevenSegment,
} from '../utils/mcu';
import { HuiCodec, HUI_BUTTONS, huiEncodeRelative, huiRelative } from '../utils/hui';
import {
  abbreviate, barsCounter, dbToMeterLevel, faderToVolume, fmtDbShort, fmtPanShort, from14, lcdCell,
  smpteCounter, to14, volumeToFader,
} from '../utils/surfaceProtocol';
import { FADER_DEADBAND, HOLD_MS, SurfaceController, SurfaceHost, surfaceTracks } from '../services/ControlSurfaceController';
import { AutomationRecorder } from '../services/AutomationManager';
import { valueAtPoints } from '../utils/automationWrite';
import { guessPorts } from '../services/ControlSurface';

// --- Conversions -------------------------------------------------------------------------

describe('surfaces : conversions communes', () => {
  it('fader ↔ volume suivent l’échelle des faders de NOVA (−∞ … +12 dB, 0 dB aux 3/4)', () => {
    expect(volumeToFader(FADER_MAX_GAIN)).toBeCloseTo(1);
    expect(volumeToFader(0)).toBe(0);
    expect(volumeToFader(1)).toBe(0.75);
    for (const v of [0, 0.1, 0.5, 1, 1.2, 1.5, 2, 3.5]) expect(faderToVolume(volumeToFader(v))).toBeCloseTo(v, 6);
    expect(faderToVolume(2)).toBeCloseTo(FADER_MAX_GAIN);
    expect(to14(1)).toBe(16383);
    expect(from14(to14(0.5))).toBeCloseTo(0.5, 3);
  });

  it('vumètre 12 segments (barème Mackie)', () => {
    expect(dbToMeterLevel(-Infinity)).toBe(0);
    expect(dbToMeterLevel(null)).toBe(0);
    expect(dbToMeterLevel(-61)).toBe(0);
    expect(dbToMeterLevel(-60)).toBe(1);
    expect(dbToMeterLevel(-20)).toBe(5);
    expect(dbToMeterLevel(-6)).toBe(9);
    expect(dbToMeterLevel(0)).toBe(12);
    expect(dbToMeterLevel(3)).toBe(12);
  });

  it('noms abrégés pour l’afficheur, sans accents', () => {
    expect(abbreviate('Kick', 6)).toBe('Kick');
    expect(abbreviate('Synthé', 6)).toBe('Synthe');
    expect(abbreviate('Back 1', 6)).toBe('Back 1');
    expect(abbreviate('FX montée', 6).length).toBeLessThanOrEqual(6);
    expect(abbreviate('Ambiance', 6)).toBe('Ambinc');
    expect(lcdCell('Kick', 7)).toBe(' Kick  ');
    expect(lcdCell('Kick', 7)).toHaveLength(7);
    expect(lcdCell('Harmo 2', 4, false)).toHaveLength(4);
  });

  it('valeurs lisibles (dB, pan)', () => {
    expect(fmtDbShort(1)).toBe('0.0');
    expect(fmtDbShort(0.5)).toBe('-6.0');
    expect(fmtDbShort(0)).toBe('-inf');
    expect(fmtPanShort(0)).toBe('<C>');
    expect(fmtPanShort(-0.3)).toBe('L30');
    expect(fmtPanShort(1)).toBe('R100');
  });

  it('compteur en mesures et en temps', () => {
    const c = barsCounter(8, 2, 0.5);
    expect(c.text).toBe('  9 3 3000');
    expect(c.dots[2] && c.dots[4] && c.dots[6]).toBe(true);
    expect(barsCounter(0, 0, 0, 8).text).toHaveLength(8);
    expect(smpteCounter(3725.5).text).toBe('  10205015');
  });
});

// --- MCU ----------------------------------------------------------------------------------

describe('MCU : décodeur', () => {
  const c = new McuCodec();
  it('fader : pitch bend 14 bits par voie, canal 9 = master', () => {
    expect(c.decode([0xe0, 0x7f, 0x7f])).toEqual([{ kind: 'fader', strip: 0, value: 1 }]);
    expect(c.decode([0xe3, 0x00, 0x40])[0]).toMatchObject({ kind: 'fader', strip: 3 });
    expect((c.decode([0xe3, 0x00, 0x40])[0] as any).value).toBeCloseTo(0.5, 3);
    expect(c.decode([0xe8, 0x00, 0x00])).toEqual([{ kind: 'fader', strip: 8, value: 0 }]);
    expect(c.decode([0xe9, 0, 0])).toEqual([]);
  });
  it('toucher des faders (0x68-0x70)', () => {
    expect(c.decode([0x90, 0x68, 0x7f])).toEqual([{ kind: 'touch', strip: 0, on: true }]);
    expect(c.decode([0x90, 0x6f, 0x00])).toEqual([{ kind: 'touch', strip: 7, on: false }]);
    expect(c.decode([0x80, 0x70, 0x40])).toEqual([{ kind: 'touch', strip: 8, on: false }]);
  });
  it('boutons de tranche et globaux', () => {
    expect(c.decode([0x90, 0x02, 0x7f])).toEqual([{ kind: 'button', button: 'rec', strip: 2, pressed: true }]);
    expect(c.decode([0x90, 0x0b, 0x7f])).toEqual([{ kind: 'button', button: 'solo', strip: 3, pressed: true }]);
    expect(c.decode([0x90, 0x17, 0x00])).toEqual([{ kind: 'button', button: 'mute', strip: 7, pressed: false }]);
    expect(c.decode([0x90, 0x18, 0x7f])).toEqual([{ kind: 'button', button: 'select', strip: 0, pressed: true }]);
    expect(c.decode([0x90, 0x21, 0x7f])).toEqual([{ kind: 'button', button: 'vpotPush', strip: 1, pressed: true }]);
    expect(c.decode([0x90, 0x5e, 0x7f])).toEqual([{ kind: 'button', button: 'play', pressed: true }]);
    expect(c.decode([0x90, 0x5d, 0x7f])[0]).toMatchObject({ button: 'stop' });
    expect(c.decode([0x90, 0x5f, 0x7f])[0]).toMatchObject({ button: 'record' });
    expect(c.decode([0x90, 0x5b, 0x7f])[0]).toMatchObject({ button: 'rewind' });
    expect(c.decode([0x90, 0x5c, 0x7f])[0]).toMatchObject({ button: 'forward' });
    expect(c.decode([0x90, 0x56, 0x7f])[0]).toMatchObject({ button: 'loop' });
    expect(c.decode([0x90, 0x2f, 0x7f])[0]).toMatchObject({ button: 'bankRight' });
    expect(c.decode([0x90, 0x2e, 0x7f])[0]).toMatchObject({ button: 'bankLeft' });
    expect(c.decode([0x90, 0x31, 0x7f])[0]).toMatchObject({ button: 'channelRight' });
    expect(c.decode([0x90, 0x4d, 0x7f])[0]).toMatchObject({ button: 'autoTouch' });
    expect(c.decode([0x90, 0x4e, 0x7f])[0]).toMatchObject({ button: 'autoLatch' });
    expect(c.decode([0x90, 0x7e, 0x7f])).toEqual([]);
  });
  it('potards et molette : relatifs, bit 6 = antihoraire', () => {
    expect(c.decode([0xb0, 0x10, 0x01])).toEqual([{ kind: 'vpot', strip: 0, delta: 1 }]);
    expect(c.decode([0xb0, 0x17, 0x43])).toEqual([{ kind: 'vpot', strip: 7, delta: -3 }]);
    expect(c.decode([0xb0, 0x3c, 0x41])).toEqual([{ kind: 'jog', delta: -1 }]);
    expect(c.decode([0xb0, 0x3c, 0x05])).toEqual([{ kind: 'jog', delta: 5 }]);
    for (const d of [-20, -1, 1, 7]) expect(decodeRelative(encodeRelative(d))).toBe(d);
  });
  it('poignée de main Logic Control : réponse calculée sur le défi', () => {
    const serial = [1, 2, 3, 4, 5, 6, 7];
    const ch = [0x10, 0x22, 0x35, 0x41];
    const ev = c.decode([0xf0, 0, 0, 0x66, 0x14, 0x01, ...serial, ...ch, 0xf7]);
    const reply = ev.find(e => e.kind === 'reply') as any;
    expect(reply.messages[0]).toEqual([0xf0, 0, 0, 0x66, 0x14, 0x02, ...serial, ...mcuChallengeResponse(ch), 0xf7]);
    expect(mcuChallengeResponse(ch).every(b => b >= 0 && b <= 0x7f)).toBe(true);
    expect(ev.some(e => e.kind === 'hello')).toBe(true);
    expect(c.decode([0xf0, 0, 0, 0x66, 0x14, 0x03, ...serial, 0xf7])).toEqual([{ kind: 'hello', detail: 'confirmée' }]);
  });
});

describe('MCU : encodeur', () => {
  const c = new McuCodec();
  it('moteurs des faders', () => {
    expect(c.fader(0, 1)).toEqual([[0xe0, 0x7f, 0x7f]]);
    expect(c.fader(8, 0)).toEqual([[0xe8, 0, 0]]);
    const [[st, lsb, msb]] = c.fader(5, 0.5);
    expect(st).toBe(0xe5);
    expect(from14((msb << 7) | lsb)).toBeCloseTo(0.5, 3);
  });
  it('voyants', () => {
    expect(c.led('mute', 3, true)).toEqual([[0x90, 0x13, 0x7f]]);
    expect(c.led('rec', 0, false)).toEqual([[0x90, 0x00, 0x00]]);
    expect(c.led('play', undefined, true)).toEqual([[0x90, MCU_NOTES.play!, 0x7f]]);
    expect(c.led('mute', undefined, true)).toBeNull();
  });
  it('anneau du potard (pan)', () => {
    expect(panToRing(-1)).toBe(1);
    expect(panToRing(0)).toBe(6);
    expect(panToRing(1)).toBe(11);
    expect(c.vpotPan(2, 0)).toEqual([[0xb0, 0x32, 6]]);
  });
  it('afficheur LCD : SysEx, 7 caractères par tranche, ligne du bas à 56', () => {
    expect(c.lcd(0, 0, ' Kick  ')).toEqual([[0xf0, 0, 0, 0x66, 0x14, 0x12, 0, 32, 75, 105, 99, 107, 32, 32, 0xf7]]);
    expect(c.lcd(3, 1, 'x')[0][6]).toBe(56 + 21);
    expect(c.lcd(1, 0, 'Synthé')[0].slice(7, 14).map(b => String.fromCharCode(b)).join('')).toBe('Synthe ');
  });
  it('vumètres : channel pressure (tranche << 4) | niveau', () => {
    expect(c.meter(0, 12)).toEqual([[0xd0, 0x0c]]);
    expect(c.meter(7, 5)).toEqual([[0xd0, 0x75]]);
    expect(c.meter(2, 99)).toEqual([[0xd0, 0x2c]]);
  });
  it('compteur 7 segments : CC 0x40 = chiffre de droite, seuls les chiffres changés partent', () => {
    expect(sevenSegment('1')).toBe(0x31);
    expect(sevenSegment('A')).toBe(0x01);
    expect(sevenSegment(' ')).toBe(0x20);
    expect(sevenSegment('3', true)).toBe(0x73);
    const a = barsCounter(0, 0, 0);
    const full = c.timecode(a.text, a.dots, null, null);
    expect(full).toHaveLength(10);
    expect(full.find(m => m[1] === 0x40)![2]).toBe(0x30);            // ticks : 0
    expect(full.find(m => m[1] === 0x47)![2]).toBe(0x31 | 0x40);     // mesure « 1 » + point
    const b = barsCounter(0, 1, 0);
    const diff = c.timecode(b.text, b.dots, a.text, a.dots);
    expect(diff).toEqual([[0xb0, 0x45, 0x32 | 0x40]]);
  });
  it('remise à zéro : faders en bas, afficheur vide', () => {
    const r = c.reset();
    expect(r).toContainEqual([0xe0, 0, 0]);
    expect(r).toContainEqual([0xe8, 0, 0]);
    expect(r.some(m => m[0] === 0xf0 && m.length === 6 + 1 + 112 + 1)).toBe(true);
  });
});

// --- HUI ----------------------------------------------------------------------------------

describe('HUI : décodeur et encodeur', () => {
  it('fader 14 bits : poids fort puis poids faible', () => {
    const h = new HuiCodec();
    expect(h.decode([0xb0, 0x02, 0x40])).toEqual([]);
    const ev = h.decode([0xb0, 0x22, 0x00]);
    expect(ev[0]).toMatchObject({ kind: 'fader', strip: 2 });
    expect((ev[0] as any).value).toBeCloseTo(0.5, 3);
    expect(h.fader(2, 0.5)).toEqual([[0xb0, 0x02, 0x40], [0xb0, 0x22, 0x00]]);
    expect(h.fader(8, 1)).toEqual([]);
  });
  it('boutons par zone / port, toucher = port 0', () => {
    const h = new HuiCodec();
    expect(h.decode([0xb0, 0x0f, 0x03])).toEqual([]);
    expect(h.decode([0xb0, 0x2f, 0x40])).toEqual([{ kind: 'touch', strip: 3, on: true }]);
    expect(h.decode([0xb0, 0x2f, 0x00])).toEqual([{ kind: 'touch', strip: 3, on: false }]);
    expect(h.decode([0xb0, 0x2f, 0x42])).toEqual([{ kind: 'button', button: 'mute', strip: 3, pressed: true }]);
    expect(h.decode([0xb0, 0x2f, 0x47])).toEqual([{ kind: 'button', button: 'rec', strip: 3, pressed: true }]);
    h.decode([0xb0, 0x0f, 0x0e]);
    expect(h.decode([0xb0, 0x2f, 0x44])).toEqual([{ kind: 'button', button: 'play', pressed: true }]);
    expect(h.decode([0xb0, 0x2f, 0x43])).toEqual([{ kind: 'button', button: 'stop', pressed: true }]);
    h.decode([0xb0, 0x0f, 0x0a]);
    expect(h.decode([0xb0, 0x2f, 0x43])).toEqual([{ kind: 'button', button: 'bankRight', pressed: true }]);
  });
  it('ping, potards, molette', () => {
    const h = new HuiCodec();
    expect(h.decode([0x90, 0x00, 0x7f])).toEqual([{ kind: 'hello', detail: 'ping' }]);
    expect(h.query()).toEqual([[0x90, 0, 0]]);
    expect(h.decode([0xb0, 0x41, 0x42])).toEqual([{ kind: 'vpot', strip: 1, delta: 2 }]);
    expect(h.decode([0xb0, 0x41, 0x01])).toEqual([{ kind: 'vpot', strip: 1, delta: -1 }]);
    expect(h.decode([0xb0, 0x0d, 0x41])).toEqual([{ kind: 'jog', delta: 1 }]);
    for (const d of [-9, -1, 1, 12]) expect(huiRelative(huiEncodeRelative(d))).toBe(d);
  });
  it('voyants, afficheurs, vumètres, compteur', () => {
    const h = new HuiCodec();
    expect(h.led('solo', 5, true)).toEqual([[0xb0, 0x0c, 5], [0xb0, 0x2c, 0x43]]);
    const [z, p] = HUI_BUTTONS.play!;
    expect(h.led('play', undefined, false)).toEqual([[0xb0, 0x0c, z], [0xb0, 0x2c, p]]);
    expect(h.lcd(4, 0, 'Kick')).toEqual([[0xf0, 0, 0, 0x66, 0x05, 0x00, 0x10, 4, 75, 105, 99, 107, 0xf7]]);
    expect(h.meter(1, 7)).toEqual([[0xa0, 1, 7], [0xa0, 1, 0x17]]);
    const t = barsCounter(11, 2, 0, 8);
    const msg = h.timecode(t.text, t.dots, null, null)[0];
    expect(msg.slice(0, 7)).toEqual([0xf0, 0, 0, 0x66, 0x05, 0x00, 0x11]);
    expect(msg.length).toBe(7 + 8 + 1);
    expect(h.timecode(t.text, t.dots, t.text, t.dots)).toEqual([]);
  });
});

// --- Contrôleur -----------------------------------------------------------------------------

const mk = (i: number, extra: Partial<Track> = {}): Track => ({
  id: `t${i}`, name: `Piste ${i + 1}`, type: 'AUDIO' as any, color: '#0ff', isMuted: false, isSolo: false, isTrackArmed: false,
  isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...extra,
} as Track);

function rig(n = 20, opts: { recorder?: AutomationRecorder } = {}) {
  let tracks: Track[] = [...Array.from({ length: n }, (_, i) => mk(i)), mk(99, { id: 'master', name: 'MASTER', type: 'BUS' as any })];
  const env = { now: 0, time: 0, playing: false, recording: false, loop: false, selected: 't0' as string | null, live: new Map<string, number>(),
    sent: [] as number[][], calls: [] as string[], meters: new Map<string, number>() };
  const host: SurfaceHost = {
    getTracks: () => tracks,
    getSelectedTrackId: () => env.selected,
    getTime: () => env.time,
    isPlaying: () => env.playing,
    isRecording: () => env.recording,
    isLoopActive: () => env.loop,
    position: (t) => { const beatSec = 0.5; const beats = t / beatSec; const whole = Math.floor(beats + 1e-9); return { bar: Math.floor(whole / 4), beat: whole % 4, frac: beats - whole, beatSec, barSec: 2 }; },
    barTime: (bar) => bar * 2,
    liveValue: (id, p) => env.live.get(`${id}|${p}`),
    meterDb: (id) => env.meters.get(id) ?? null,
    updateTrack: (t) => {
      const prev = tracks.find(x => x.id === t.id);
      if (prev && opts.recorder) opts.recorder.captureTrackUpdate(prev, t);
      tracks = tracks.map(x => (x.id === t.id ? t : x));
    },
    selectTrack: (id) => { env.selected = id; },
    automationTouch: (id, p, on) => { env.calls.push(`${on ? 'touch' : 'release'}:${id}:${p}`); if (opts.recorder) { if (on) opts.recorder.touch(id, p); else opts.recorder.release(id, p); } },
    setAutomationMode: (id, mode) => { tracks = tracks.map(x => (x.id === id ? { ...x, automationMode: mode } : x)); env.calls.push(`mode:${id}:${mode}`); },
    play: () => { env.playing = true; env.calls.push('play'); opts.recorder?.onPlay(); },
    stop: () => { env.playing = false; env.calls.push('stop'); opts.recorder?.onStop(env.time); },
    record: () => { env.recording = !env.recording; env.calls.push('record'); },
    toggleLoop: () => { env.loop = !env.loop; },
    seek: (t) => { env.time = t; env.calls.push(`seek:${t}`); },
    now: () => env.now,
  };
  const codec = new McuCodec();
  const ctl = new SurfaceController(codec, (m) => env.sent.push(m), host);
  const lcdTop = () => {
    const row = Array(56).fill(' ');
    for (const m of env.sent) if (m[0] === 0xf0 && m[5] === 0x12 && m[6] < 56) m.slice(7, -1).forEach((b, i) => { row[m[6] + i] = String.fromCharCode(b); });
    return row.join('');
  };
  const faderMsgs = (strip: number) => env.sent.filter(m => m[0] === (0xe0 | strip));
  return { ctl, env, host, tracks: () => tracks, lcdTop, faderMsgs };
}

describe('contrôleur de surface', () => {
  it('tranches dans l’ordre de la console (sans master ni pistes masquées)', () => {
    const t = [mk(0), mk(1, { type: 'BUS' as any }), mk(2, { type: 'SEND' as any }), mk(3), mk(4, { id: 'master', type: 'BUS' as any }), mk(5, { isVca: true, type: 'BUS' as any } as any)];
    expect(surfaceTracks(t).map(x => x.id)).toEqual(['t0', 't3', 't1', 't2']);
    expect(surfaceTracks(t, new Set(['t3'])).map(x => x.id)).toEqual(['t3']);
  });

  it('banque suivante : noms des pistes 9 à 16 sur l’afficheur', () => {
    const r = rig();
    r.ctl.tick();
    expect(r.lcdTop().slice(0, 14)).toBe(lcdCell('Piste 1', 7) + lcdCell('Piste 2', 7));
    r.ctl.handleMidi([0x90, 0x2f, 0x7f]);
    r.ctl.handleMidi([0x90, 0x2f, 0x00]);
    expect(r.ctl.getBank()).toBe(8);
    r.env.now += 200; r.ctl.tick();
    const top = r.lcdTop();
    expect(top).toBe(Array.from({ length: 8 }, (_, i) => lcdCell(`Piste ${i + 9}`, 7)).join(''));
    // Dernière banque : pistes 17 à 20 puis cases vides ; pas au-delà.
    r.ctl.handleMidi([0x90, 0x2f, 0x7f]); r.ctl.handleMidi([0x90, 0x2f, 0x7f]);
    expect(r.ctl.getBank()).toBe(16);
    r.ctl.handleMidi([0x90, 0x30, 0x7f]);
    expect(r.ctl.getBank()).toBe(15);
    r.ctl.handleMidi([0x90, 0x2e, 0x7f]); r.ctl.handleMidi([0x90, 0x2e, 0x7f]); r.ctl.handleMidi([0x90, 0x2e, 0x7f]);
    expect(r.ctl.getBank()).toBe(0);
  });

  it('fader bougé → volume de la piste (avec la banque)', () => {
    const r = rig();
    r.ctl.handleMidi([0xe2, ...(() => { const v = to14(volumeToFader(0.5)); return [v & 0x7f, v >> 7]; })()]);
    expect(r.tracks().find(t => t.id === 't2')!.volume).toBeCloseTo(0.5, 3);
    r.ctl.handleMidi([0x90, 0x2f, 0x7f]);
    r.ctl.handleMidi([0xe0, 0, 0]);
    expect(r.tracks().find(t => t.id === 't8')!.volume).toBe(0);
    r.ctl.handleMidi([0xe8, 0x7f, 0x7f]);
    expect(r.tracks().find(t => t.id === 'master')!.volume).toBeCloseTo(FADER_MAX_GAIN);
  });

  it('faders motorisés : suivent l’automation, jamais pendant le toucher, sans écho', () => {
    const r = rig();
    r.ctl.tick();
    const v0 = r.faderMsgs(1).length;
    expect(v0).toBe(1);
    // Automation entendue : le moteur suit.
    r.env.playing = true;
    r.env.live.set('t1|volume', 0.25);
    r.env.now += 40; r.ctl.tick();
    let last = r.faderMsgs(1).at(-1)!;
    expect(faderToVolume(from14((last[2] << 7) | last[1]))).toBeCloseTo(0.25, 2);
    // Fader touché : plus rien n'est envoyé à ce fader, même si la courbe bouge.
    r.ctl.handleMidi([0x90, 0x69, 0x7f]);
    expect(r.env.calls).toContain('touch:t1:volume');
    const before = r.faderMsgs(1).length;
    for (let i = 0; i < 20; i++) { r.env.live.set('t1|volume', 0.25 + i * 0.05); r.env.now += 33; r.ctl.tick(); }
    expect(r.faderMsgs(1).length).toBe(before);
    // Relâché : il reçoit la valeur entendue.
    r.ctl.handleMidi([0x90, 0x69, 0x00]);
    expect(r.env.calls).toContain('release:t1:volume');
    r.env.now += 33; r.ctl.tick();
    last = r.faderMsgs(1).at(-1)!;
    expect(faderToVolume(from14((last[2] << 7) | last[1]))).toBeCloseTo(0.25 + 19 * 0.05, 2);
    // Écho : une position reçue n'est pas renvoyée.
    r.env.live.delete('t1|volume');
    r.env.playing = false;
    const pos = to14(volumeToFader(0.7));
    r.ctl.handleMidi([0xe1, pos & 0x7f, pos >> 7]);
    const n = r.faderMsgs(1).length;
    for (let i = 0; i < 20; i++) { r.env.now += 33; r.ctl.tick(); }
    expect(r.faderMsgs(1).length).toBe(n);
  });

  it('surface sans capteur de toucher : un fader qui bouge est tenu HOLD_MS', () => {
    const r = rig();
    r.ctl.tick();
    r.env.playing = true;
    const pos = to14(volumeToFader(0.4));
    r.ctl.handleMidi([0xe3, pos & 0x7f, pos >> 7]);
    const n = r.faderMsgs(3).length;
    r.env.live.set('t3|volume', 1.2);
    r.env.now += HOLD_MS - 50; r.ctl.tick();
    expect(r.faderMsgs(3).length).toBe(n);
    r.env.now += 100; r.ctl.tick();
    expect(r.faderMsgs(3).length).toBe(n + 1);
    expect(FADER_DEADBAND).toBeGreaterThan(0);
  });

  it('doigt déjà posé au lancement de la lecture : l’écriture démarre quand même', () => {
    const r = rig();
    r.ctl.handleMidi([0x90, 0x68, 0x7f]);
    r.ctl.tick();
    expect(r.env.calls.filter(c => c === 'touch:t0:volume')).toHaveLength(1);
    r.env.playing = true;
    r.env.now += 33; r.ctl.tick();
    expect(r.env.calls.filter(c => c === 'touch:t0:volume')).toHaveLength(2);
    r.env.now += 33; r.ctl.tick();
    expect(r.env.calls.filter(c => c === 'touch:t0:volume')).toHaveLength(2);
  });

  it('mute, solo, rec, select et leurs voyants', () => {
    const r = rig();
    r.ctl.handleMidi([0x90, 0x10, 0x7f]);
    r.ctl.handleMidi([0x90, 0x09, 0x7f]);
    r.ctl.handleMidi([0x90, 0x02, 0x7f]);
    r.ctl.handleMidi([0x90, 0x1b, 0x7f]);
    expect(r.tracks()[0].isMuted).toBe(true);
    expect(r.tracks()[1].isSolo).toBe(true);
    expect(r.tracks()[2].isTrackArmed).toBe(true);
    expect(r.env.selected).toBe('t3');
    r.ctl.tick();
    expect(r.env.sent).toContainEqual([0x90, 0x10, 0x7f]);
    expect(r.env.sent).toContainEqual([0x90, 0x09, 0x7f]);
    expect(r.env.sent).toContainEqual([0x90, 0x02, 0x7f]);
    expect(r.env.sent).toContainEqual([0x90, 0x1b, 0x7f]);
    expect(r.env.sent).toContainEqual([0x90, 0x18, 0x00]);
  });

  it('transport, boucle, retour / avance d’une mesure, molette', () => {
    const r = rig();
    r.ctl.handleMidi([0x90, 0x5e, 0x7f]);
    expect(r.env.playing).toBe(true);
    r.ctl.handleMidi([0x90, 0x5d, 0x7f]);
    expect(r.env.playing).toBe(false);
    r.ctl.handleMidi([0x90, 0x56, 0x7f]);
    expect(r.env.loop).toBe(true);
    r.ctl.handleMidi([0x90, 0x5f, 0x7f]);
    expect(r.env.recording).toBe(true);
    r.env.recording = false;
    r.env.time = 3;
    r.ctl.handleMidi([0x90, 0x5c, 0x7f]); r.ctl.handleMidi([0x90, 0x5c, 0x00]);
    expect(r.env.time).toBe(4);
    r.ctl.handleMidi([0x90, 0x5b, 0x7f]); r.ctl.handleMidi([0x90, 0x5b, 0x00]);
    expect(r.env.time).toBe(2);
    r.ctl.handleMidi([0xb0, 0x3c, 0x04]);
    expect(r.env.time).toBeCloseTo(2 + 4 * 0.125);
    // Maintenu : répète.
    r.ctl.handleMidi([0x90, 0x5c, 0x7f]);
    const t1 = r.env.time;
    r.env.now += 1000; r.ctl.tick();
    expect(r.env.time).toBeGreaterThan(t1);
    r.ctl.handleMidi([0x90, 0x5c, 0x00]);
    r.ctl.tick();
    expect(r.env.sent).toContainEqual([0x90, 0x56, 0x7f]); // voyant boucle
  });

  it('potard : panoramique, appui = centre', () => {
    const r = rig();
    r.ctl.handleMidi([0xb0, 0x10, 0x02]);
    expect(r.tracks()[0].pan).toBeCloseTo(0.04);
    r.ctl.handleMidi([0xb0, 0x10, 0x05]);
    expect(r.tracks()[0].pan).toBeCloseTo(0.24); // tour rapide : pas doublé
    r.ctl.handleMidi([0xb0, 0x10, 0x46]);
    expect(r.tracks()[0].pan).toBeCloseTo(0);
    r.ctl.handleMidi([0xb0, 0x10, 0x41]);
    r.ctl.handleMidi([0x90, 0x20, 0x7f]);
    expect(r.tracks()[0].pan).toBe(0);
  });

  it('vumètres : niveau envoyé tant qu’il y a du signal', () => {
    const r = rig();
    r.env.meters.set('t0', -6);
    r.env.meters.set('t1', -Infinity);
    r.ctl.tick();
    expect(r.env.sent).toContainEqual([0xd0, 0x09]);
    expect(r.env.sent).toContainEqual([0xd0, 0x10]);
    const n = r.env.sent.filter(m => m[0] === 0xd0 && m[1] >> 4 === 0).length;
    r.env.now += 400; r.ctl.tick();
    expect(r.env.sent.filter(m => m[0] === 0xd0 && m[1] >> 4 === 0).length).toBe(n + 1);
    const z = r.env.sent.filter(m => m[0] === 0xd0 && m[1] >> 4 === 1).length;
    r.env.now += 400; r.ctl.tick();
    expect(r.env.sent.filter(m => m[0] === 0xd0 && m[1] >> 4 === 1).length).toBe(z); // silence : pas de renvoi
  });

  it('modes d’automation de la piste sélectionnée', () => {
    const r = rig();
    r.ctl.handleMidi([0x90, 0x4d, 0x7f]);
    expect(r.tracks()[0].automationMode).toBe('touch');
    r.ctl.handleMidi([0x90, 0x4e, 0x7f]);
    expect(r.tracks()[0].automationMode).toBe('latch');
    r.ctl.handleMidi([0x90, 0x4a, 0x7f]);
    expect(r.tracks()[0].automationMode).toBe('read');
    r.ctl.handleMidi([0x90, 0x4a, 0x7f]);
    expect(r.tracks()[0].automationMode).toBe('off');
  });

  it('détection par le nom des ports', () => {
    const g = guessPorts([{ id: '1', name: 'Clavier 49' }, { id: '2', name: 'X-Touch' }, { id: '3', name: 'X-Touch-Ext' }], [{ id: 'a', name: 'Clavier 49' }, { id: 'b', name: 'X-Touch' }]);
    expect(g.input?.name).toBe('X-Touch');
    expect(g.output?.name).toBe('X-Touch');
    expect(g.protocol).toBe('mcu');
    expect(guessPorts([{ id: '1', name: 'FaderPort HUI' }], [{ id: '1', name: 'FaderPort HUI' }]).protocol).toBe('hui');
    expect(guessPorts([{ id: '1', name: 'Clavier' }], []).input).toBeNull();
  });
});

describe('écriture d’automation au fader de la surface (enregistreur réel)', () => {
  const pass = (mode: 'touch' | 'latch') => {
    const recorder = new AutomationRecorder();
    const r = rig(10, { recorder });
    const lanePts = () => r.tracks().find(t => t.id === 't0')!.automationLanes.find(l => l.parameterName === 'volume')?.points || [];
    r.host.updateTrack({ ...r.tracks()[0], volume: 0.8, automationMode: mode });
    recorder.configure({
      getTracks: () => r.tracks(),
      getTime: () => r.env.time,
      isPlaying: () => r.env.playing,
      setOverride: () => {},
      beginUndoStep: () => {},
      commit: (c) => {
        const t = r.tracks().find(x => x.id === c.trackId)!;
        const lanes = t.automationLanes.some(l => l.parameterName === c.param)
          ? t.automationLanes.map(l => (l.parameterName === c.param ? { ...l, points: c.points } : l))
          : [...t.automationLanes, { id: 'l', parameterName: c.param, color: '', isExpanded: true, min: 0, max: 1.5, points: c.points }];
        r.host.updateTrack({ ...t, automationLanes: lanes, ...(c.staticValue !== null ? { volume: c.staticValue } : {}) });
      },
      setTrackMode: () => {},
      wallClock: () => r.env.now,
    });
    r.ctl.handleMidi([0x90, 0x5e, 0x7f]); // PLAY
    const run = (to: number, fader?: number) => {
      while (r.env.time < to - 1e-9) {
        r.env.time = Math.min(to, r.env.time + 1 / 60); r.env.now += 1000 / 60;
        if (fader !== undefined) { const v = to14(volumeToFader(fader)); r.ctl.handleMidi([0xe0, v & 0x7f, v >> 7]); }
        recorder.tick(); r.ctl.tick();
      }
    };
    run(1);
    r.ctl.handleMidi([0x90, 0x68, 0x7f]); // toucher
    run(2, 0.3);
    r.ctl.handleMidi([0x90, 0x68, 0x00]); // relâcher
    run(4);
    r.ctl.handleMidi([0x90, 0x5d, 0x7f]); // STOP
    return lanePts();
  };

  it('Touch : 0,3 pendant l’appui (1 → 2 s), retour à 0,8 après', () => {
    const pts = pass('touch');
    expect(pts.length).toBeGreaterThan(2);
    expect(valueAtPoints(pts, 0.5, 0)).toBeCloseTo(0.8, 2);
    expect(valueAtPoints(pts, 1.6, 0)).toBeCloseTo(0.3, 2);
    expect(valueAtPoints(pts, 3, 0)).toBeCloseTo(0.8, 2);
  });

  it('Latch : 0,3 gardé jusqu’à l’arrêt (4 s)', () => {
    const pts = pass('latch');
    expect(valueAtPoints(pts, 0.5, 0)).toBeCloseTo(0.8, 2);
    expect(valueAtPoints(pts, 1.6, 0)).toBeCloseTo(0.3, 2);
    expect(valueAtPoints(pts, 3.5, 0)).toBeCloseTo(0.3, 2);
  });
});
