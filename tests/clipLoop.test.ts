import { describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { TrackType } from '../types';
import { clipGainAt } from '../utils/fades';
import { dbToLin } from '../utils/clipGain';
import { buildLoop, healBlocker, healPair, healTrack, loopBase, loopCount, loopTrim, repeatClips, unloop } from '../utils/clipLoop';
import { makeClip, makeTrack } from './helpers/fixtures';

vi.mock('../services/supabase', () => ({ catalogSupabase: { channel: () => ({}), removeChannel: async () => 'ok' } }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { contentBufferIds, contentOf } from '../services/Collab';
import { sanitizeIncomingClips } from '../utils/collabMerge';

const audio = (over: Partial<Clip> = {}) => makeClip({ bufferId: 'buf', ...over });

/** Découpe comme App (« Séparer ») : le second morceau continue le son du premier. */
const split = (c: Clip, at: number): [Clip, Clip] => {
  const first = at - c.start;
  return [{ ...c, duration: first }, { ...c, id: `${c.id}-b`, start: at, duration: c.duration - first, offset: c.offset + first }];
};

/** Son joué à l'instant T de la timeline : quel clip, quel instant du fichier, quel gain. */
const playedAt = (clips: Clip[], T: number) => {
  const c = clips.filter(x => !x.isMuted && T >= x.start && T < x.start + x.duration);
  return c.map(x => ({ buf: x.bufferId, src: +(x.offset + (T - x.start)).toFixed(9), g: +clipGainAt(x, T - x.start).toFixed(9) }));
};

describe('Heal Separation', () => {
  const orig = audio({ id: 'v', start: 4, offset: 0.5, duration: 6, fadeIn: 0.05, fadeOut: 0.2, fadeOutCurve: 'S_CURVE', gain: dbToLin(-2),
    gainPoints: [{ t: 1, db: 0 }, { t: 3, db: -9 }, { t: 5, db: 2 }], breaths: [{ start: 2, end: 2.4, gainDb: -15 }] });

  it('découper puis recoller redonne exactement le clip d’origine (et le même son)', () => {
    const [a, b] = split(orig, 7.25);
    expect(healBlocker(a, b)).toBeNull();
    const r = healPair(a, b);
    expect(r.exact).toBe(true);
    expect(r.clip).toMatchObject({ id: 'v', start: 4, offset: 0.5, duration: 6, fadeIn: 0.05, fadeOut: 0.2, fadeOutCurve: 'S_CURVE', gain: orig.gain });
    expect(r.clip.gainPoints).toEqual(orig.gainPoints);
    expect(r.clip.breaths).toEqual(orig.breaths);
    for (let T = 4; T < 10; T += 0.0137) expect(playedAt([r.clip], T)).toEqual(playedAt([orig], T));
  });

  it('plusieurs découpes et un crossfade à une jonction : tout se recolle', () => {
    const [a, rest] = split(orig, 5.5);
    const [b, c] = split(rest, 8);
    // Crossfade posé sur la jonction b|c (chevauchement de 20 ms, fondus croisés).
    const bx = { ...b, duration: b.duration + 0.01, fadeOut: 0.02 };
    const cx = { ...c, start: c.start - 0.01, offset: c.offset - 0.01, duration: c.duration + 0.01, fadeIn: 0.02 };
    const r = healTrack([a, bx, cx, audio({ id: 'autre', bufferId: 'x', start: 20 })]);
    expect(r.healed).toBe(2);
    const v = r.clips.find(x => x.id === 'v')!;
    expect(v).toMatchObject({ start: 4, offset: 0.5, fadeIn: 0.05, fadeOut: 0.2 });
    expect(v.duration).toBeCloseTo(6, 9);
    expect(r.clips.find(x => x.id === 'autre')).toBeDefined();
    for (let T = 4; T < 9.99; T += 0.0137) expect(playedAt([v], T)).toEqual(playedAt([orig], T));
  });

  it('refuse ce qui ne vient pas du même fichier, ce qui a été déplacé, un trou', () => {
    const [a, b] = split(orig, 7);
    expect(healBlocker(a, { ...b, bufferId: 'autre' })).toMatch(/même fichier/);
    expect(healBlocker(a, { ...b, start: b.start + 0.5 })).toMatch(/déplacés|trou/);
    expect(healBlocker(a, { ...b, start: b.start + 0.5, offset: b.offset + 0.5 })).toMatch(/trou/);
    expect(healBlocker(a, { ...b, type: TrackType.MIDI })).toMatch(/audio/);
    const r = healTrack([a, { ...b, bufferId: 'autre' }]);
    expect(r.healed).toBe(0);
    expect(r.reason).toMatch(/même fichier/);
  });

  it('gains différents : recollé, gain ramené dans la ligne avec une rampe de 5 ms (pas de clic)', () => {
    const [a, b] = split(audio({ start: 0, duration: 4 }), 2);
    const r = healPair({ ...a, gain: dbToLin(-6) }, b);
    expect(r.exact).toBe(false);
    expect(20 * Math.log10(clipGainAt(r.clip, 1))).toBeCloseTo(-6, 6);
    expect(20 * Math.log10(clipGainAt(r.clip, 3))).toBeCloseTo(0, 6);
  });
});

describe('boucle de clip', () => {
  const base = audio({ id: 'drum', start: 2, offset: 0.1, duration: 1, fadeIn: 0.01, fadeOut: 0.03 });

  it('tirer le bord jusqu’à 3,5 tours : 4 itérations, la dernière partielle, même son à chaque tour', () => {
    const it = buildLoop(base, 2 + 3.5);
    expect(it.map(c => [c.start, +c.duration.toFixed(9)])).toEqual([[2, 1], [3, 1], [4, 1], [5, 0.5]]);
    expect(it.every(c => c.offset === 0.1 && c.bufferId === 'buf')).toBe(true);
    expect(it[0].id).toBe('drum');
    expect(new Set(it.map(c => c.loop!.id)).size).toBe(1);
    expect(it.map(c => c.loop!.index)).toEqual([0, 1, 2, 3]);
    expect(it[0].fadeIn).toBe(0.01);              // l'entrée d'origine au début
    expect(it[1].fadeIn).toBe(0);
    expect(it[3].fadeOut).toBe(0.03);             // la sortie d'origine à la fin
    // Chaque tour joue le même passage du fichier.
    for (const k of [0, 1, 2]) expect(playedAt(it, 2.5 + k)[0].src).toBeCloseTo(0.6, 9);
  });

  it('fondus aux jonctions : sans marge dans le fichier, deux fondus courts bout à bout', () => {
    const it = loopCount(base, 3, { xfade: 0.01 });
    expect(it).toHaveLength(3);
    expect(it[0].fadeOut).toBeCloseTo(0.005, 9);
    expect(it[1].fadeIn).toBeCloseTo(0.005, 9);
    expect(it[1].fadeOut).toBeCloseTo(0.005, 9);
    expect(it[2].fadeOut).toBe(0.03);
    // Le gain s'annule à la jonction puis remonte (pas de saut).
    expect(clipGainAt(it[0], 0.9999)).toBeLessThan(0.05);
    expect(clipGainAt(it[1], 0.0001)).toBeLessThan(0.05);
  });

  it('fondus aux jonctions : avec de la marge, un vrai crossfade centré (aucun creux en puissance égale)', () => {
    const it = loopCount(base, 2, { xfade: 0.02, bufferDuration: 5, curve: 'EQUAL_POWER' });
    expect(it[1].start).toBeCloseTo(2.99, 9);
    expect(it[0].start + it[0].duration).toBeCloseTo(3.01, 9);
    expect(it[0].fadeOut).toBeCloseTo(0.02, 9);
    expect(it[1].fadeIn).toBeCloseTo(0.02, 9);
  });

  it('Loop Trim refait les itérations depuis le clip d’origine ; défaire la boucle le rend', () => {
    const track = buildLoop(base, 6);
    const longer = loopTrim(track, track[2].id, 7.25)!;
    expect(longer.remove).toEqual(track.map(c => c.id));
    expect(longer.add).toHaveLength(6);
    expect(longer.add[5].duration).toBeCloseTo(0.25, 9);
    const shorter = loopTrim(longer.add, longer.add[0].id, 2.6)!;
    expect(shorter.add).toHaveLength(1);
    expect(shorter.add[0].loop).toBeUndefined();
    expect(shorter.add[0].duration).toBeCloseTo(0.6, 9);
    const u = unloop(longer.add, longer.add[3].id)!;
    expect(u.add).toEqual([loopBase(longer.add[0])]);
    expect(u.add[0]).toMatchObject({ id: 'drum', duration: 1, fadeIn: 0.01, fadeOut: 0.03 });
  });

  it('Répéter n fois : copies collées, écarts gardés', () => {
    const a = audio({ id: 'a', start: 1, duration: 1 }), b = audio({ id: 'b', start: 2.5, duration: 0.5 });
    const r = repeatClips([a, b], 3);
    expect(r).toHaveLength(6);
    expect(r.map(c => c.start)).toEqual([3, 4.5, 5, 6.5, 7, 8.5]);
    expect(new Set(r.map(c => c.id)).size).toBe(6);
  });
});

describe('collaboration : gain de clip, Heal et boucle voyagent avec la piste', () => {
  const [a, b] = split(audio({ id: 'v', bufferId: 'rec-1', start: 0, duration: 4, gainPoints: [{ t: 1, db: -6 }, { t: 2, db: 0, curve: 0.4 }] }), 2);
  const healed = healPair(a, b).clip;
  const loop = buildLoop(audio({ id: 'l', bufferId: 'boucle', start: 10, duration: 1 }), 12.5, { xfade: 0.004 });
  const rendered = audio({ id: 'r', bufferId: 'r-gain-1', gain: 1, gainRender: { sourceBufferId: 'rec-2', gainPoints: [{ t: 0, db: -3 }], gain: 0.8 } });
  const voice = makeTrack({ id: 'track-rec-main', name: 'Voix', clips: [healed, ...loop, rendered] });

  it('le contenu envoyé garde la ligne, les tours de boucle et le rendu ; l’audio envoyé est celui joué', () => {
    const wire = JSON.parse(JSON.stringify(contentOf(voice)));
    const got = sanitizeIncomingClips(wire.clips) as Clip[];
    expect(got.find(c => c.id === 'v')!.gainPoints).toEqual(healed.gainPoints);
    expect(got.find(c => c.id === 'v')!.duration).toBe(4);
    expect(got.filter(c => c.loop).map(c => c.loop!.index)).toEqual([0, 1, 2]);
    expect(got.find(c => c.id === 'r')!.gainRender!.gain).toBe(0.8);
    expect(contentBufferIds(voice).sort()).toEqual(['boucle', 'r-gain-1', 'rec-1']);
    // Même son chez l'autre.
    for (let T = 0; T < 13; T += 0.05) expect(playedAt(got, T)).toEqual(playedAt(voice.clips, T));
  });

  it('à la réception, une ligne abîmée est réparée (triée, bornée) sans faire taire le clip', () => {
    const bad = sanitizeIncomingClips([
      { id: 'x', gainPoints: [{ t: 2, db: 99 }, { t: 1, db: -3 }, { t: NaN, db: 0 }, null] },
      { id: 'y', gainPoints: 'nimporte' },
      { id: 'z', loop: { id: 3 } },
      { id: 'w', gainRender: { gainPoints: null } },
    ] as any[]);
    expect(bad[0].gainPoints).toEqual([{ t: 1, db: -3 }, { t: 2, db: 24 }]);
    expect('gainPoints' in bad[1]).toBe(false);
    expect('loop' in bad[2]).toBe(false);
    expect('gainRender' in bad[3]).toBe(false);
  });
});
