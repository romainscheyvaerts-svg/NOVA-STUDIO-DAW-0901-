import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  armAlone, armedAfter, channelOffsets, channelOffsetSec, channelsOf, decodeInput, encodeInput, inputLabel, inputOptions,
  inputsMessage, missingInputs, neededInputChannels, noteArmClick, offsetsFromProbe, recordTargets, setChannelOffsets,
  sharedInputs, takeArmShift, linkedRecordMates,
} from '../utils/multiRecord';
import { compTakeGroup, deleteTakeGroup, keepTakeGroup, takeGroupLinked, takeGroupMates, takeGroupTracksAt } from '../utils/takeGroups';
import { placeTake, trimToPlan } from '../utils/multiTake';
import { mixLinkUpdates, makeGroup } from '../utils/editGroups';
import { decodeInputMessage, encodeOutputMessage, encodeOutputInterleaved, blockJoin, INPUT_MAGIC_V2 } from '../utils/asioProtocol';
import { recoveredTakeClip } from '../utils/recoverySnapshot';
import { memoryBackend, RecoveryStore } from '../utils/recoveryStore';
import { Clip, TakeMeta, Track, TrackType } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
});
afterEach(() => { delete (globalThis as any).localStorage; });

describe('R14 · entrées physiques', () => {
  it('encode / décode le sélecteur (auto, mono, stéréo) et refuse le reste', () => {
    expect(encodeInput(null)).toBe('');
    expect(encodeInput({ ch: 2 })).toBe('m:2');
    expect(encodeInput({ ch: 0, stereo: true })).toBe('s:0');
    expect(decodeInput('m:2')).toEqual({ ch: 2 });
    expect(decodeInput('s:4')).toEqual({ ch: 4, stereo: true });
    expect(decodeInput('')).toBeNull();
    expect(decodeInput('m:99')).toBeNull();
    expect(decodeInput('x:1')).toBeNull();
  });

  it('libellés clairs et options façon Pro Tools (mono 1…n puis paires 1-2, 3-4)', () => {
    expect(inputLabel(null)).toBe('Entrée des réglages');
    expect(inputLabel({ ch: 2 })).toBe('Entrée 3');
    expect(inputLabel({ ch: 0, stereo: true })).toBe('Entrées 1-2 (stéréo)');
    expect(inputLabel({ ch: 2 }, true)).toBe('In 3');
    const o = inputOptions(4);
    expect(o.map(x => x.value)).toEqual(['', 'm:0', 'm:1', 'm:2', 'm:3', 's:0', 's:2']);
    expect(inputOptions(0).filter(x => x.group === 'mono')).toHaveLength(2);
  });

  it('canaux lus, entrées nécessaires, manquantes et partagées', () => {
    expect(channelsOf({ ch: 3 })).toEqual([3]);
    expect(channelsOf({ ch: 2, stereo: true })).toEqual([2, 3]);
    expect(channelsOf(null)).toEqual([]);
    expect(neededInputChannels([{ ch: 0 }, { ch: 2, stereo: true }, null])).toBe(4);
    expect(neededInputChannels([null])).toBe(1);
    const armed = [{ trackId: 'a', spec: { ch: 0 } }, { trackId: 'b', spec: { ch: 3 } }, { trackId: 'c', spec: { ch: 0 } }, { trackId: 'd', spec: null }];
    expect(missingInputs(armed, 2)).toEqual(['b']);
    expect(sharedInputs(armed)).toEqual([{ ch: 0, trackIds: ['a', 'c'] }]);
  });

  it('message clair quand le navigateur ne donne pas assez d’entrées', () => {
    const m = inputsMessage({ names: ['Batterie OH'], available: 2, mode: 'navigateur' })!;
    expect(m).toContain('« Batterie OH »');
    expect(m).toContain('2 entrées');
    expect(m).toContain('Nova Studio');
    expect(inputsMessage({ names: [], available: 2, mode: 'asio' })).toBeNull();
    expect(inputsMessage({ names: ['A', 'B'], available: 8, mode: 'asio' })).toContain('la carte ne donne que 8 entrées');
  });
});

describe('R14 · armement de plusieurs pistes', () => {
  const tracks = [{ id: 'a', isTrackArmed: true }, { id: 'b', isTrackArmed: false }, { id: 'c', isTrackArmed: true }];

  it('armer n’en désarme plus d’autre ; Maj+clic = la piste seule ; préférence exclusive inversée', () => {
    expect(armedAfter(tracks, 'b', true, false)).toEqual(['a', 'b', 'c']);
    expect(armedAfter(tracks, 'b', true, true)).toEqual(['b']);
    expect(armedAfter(tracks, 'a', false, false)).toEqual(['c']);
    expect(armAlone(false, false)).toBe(false);
    expect(armAlone(true, false)).toBe(true);
    expect(armAlone(false, true)).toBe(true);
    expect(armAlone(true, true)).toBe(false);
  });

  it('Maj lu une seule fois, et seulement juste après le clic', () => {
    noteArmClick({ shiftKey: true });
    expect(takeArmShift()).toBe(true);
    expect(takeArmShift()).toBe(false);
    noteArmClick({ shiftKey: true });
    expect(takeArmShift(Date.now() + 5000)).toBe(false);
  });

  it('REC enregistre les pistes audio armées, dans l’ordre (pas le beat, pas le MIDI)', () => {
    const ts = [
      makeTrack({ id: 'instrumental', isTrackArmed: true }),
      makeTrack({ id: 'v1', isTrackArmed: true }),
      makeTrack({ id: 'm1', type: TrackType.MIDI, isTrackArmed: true }),
      makeTrack({ id: 'v2', isTrackArmed: false }),
      makeTrack({ id: 'v3', isTrackArmed: true }),
    ];
    expect(recordTargets(ts).map(t => t.id)).toEqual(['v1', 'v3']);
  });

  it('armement lié par groupe (R12) : les autres membres audio, seulement si l’attribut est coché', () => {
    const ts = [makeTrack({ id: 'lead' }), makeTrack({ id: 'dbl' }), makeTrack({ id: 'beat', id2: 1 } as any), makeTrack({ id: 'syn', type: TrackType.MIDI })];
    const g = makeGroup([], { trackIds: ['lead', 'dbl', 'syn'], kind: 'edit' });
    expect(linkedRecordMates({ tracks: ts, trackGroups: [g] }, 'lead')).toEqual([]);
    const gl = { ...g, linkedRecord: true };
    expect(linkedRecordMates({ tracks: ts, trackGroups: [gl] }, 'lead')).toEqual(['dbl']);
    expect(linkedRecordMates({ tracks: ts, trackGroups: [gl], groupSettings: { suspended: true } }, 'lead')).toEqual([]);
    expect(linkedRecordMates({ tracks: ts, trackGroups: [gl] }, 'lead', true)).toEqual([]);
    const ups = mixLinkUpdates({ ...ts[0], isTrackArmed: false }, { ...ts[0], isTrackArmed: true }, { groups: [gl], tracks: ts });
    expect(ups.map(t => [t.id, t.isTrackArmed])).toEqual([['dbl', true]]);
  });
});

describe('R14 / R15 · latence par entrée', () => {
  it('retard propre (moyenne en stéréo), gardé sur l’appareil, valeurs folles ignorées', () => {
    setChannelOffsets({ 2: 0.54, 3: 1.0 });
    store.set('nova_input_latency_ms', JSON.stringify({ 2: 0.54, 3: 1, 5: 9999, x: 1 }));
    const o = channelOffsets();
    expect(o).toEqual({ 2: 0.54, 3: 1 });
    expect(channelOffsetSec([2], o)).toBeCloseTo(0.00054, 8);
    expect(channelOffsetSec([2, 3], o)).toBeCloseTo(0.00077, 8);
    expect(channelOffsetSec([], o)).toBe(0);
  });

  it('mesure du pont → retard propre = aller-retour mesuré − latence annoncée', () => {
    // 44,1 kHz, pilote annonce 600 échantillons (13,605 ms) ; l'entrée 3 arrive 24 échantillons après.
    const rep = 600 / 44100;
    const o = offsetsFromProbe([600, 600, 624, null], 44100, rep);
    expect(o[0]).toBeCloseTo(0, 3);
    expect(o[2]).toBeCloseTo(24 / 44.1, 2);
    expect(3 in o).toBe(false);
  });
});

const take = (n: number, over: Partial<Clip> = {}) => makeClip({ takeNumber: n, name: `Prise ${n}`, bufferId: `buf-${n}`, ...over });

describe('R14 · groupes de prises', () => {
  const mk = (id: string, metaGroup: string | undefined, clips: Clip[], n = 2) =>
    makeTrack({ id, clips, takeMeta: [{ n: 1 }, { n, ...(metaGroup ? { group: metaGroup } : {}) }] as TakeMeta[] });

  it('les prises d’un même passage sont jumelles (même groupe), sur les autres pistes', () => {
    const a = mk('a', 'g1', [take(1, { start: 0, duration: 8, isMuted: true }), take(2, { start: 0, duration: 8 })]);
    const b = mk('b', 'g1', [take(1, { start: 0, duration: 8, isMuted: true }), take(5, { start: 0, duration: 8 })], 5);
    const c = mk('c', 'autre', [take(2, { start: 0, duration: 8 })]);
    expect(takeGroupMates([a, b, c], 'a', 2)).toEqual([{ trackId: 'b', n: 5 }]);
    expect(takeGroupMates([a, b, c], 'a', 1)).toEqual([]);
    expect(takeGroupLinked({})).toBe(true);
    expect(takeGroupLinked({ suspended: true })).toBe(false);
    expect(takeGroupLinked({ invert: true })).toBe(false);
  });

  it('comp d’un passage : la jumelle suit (même zone), sauf groupes coupés', () => {
    const a = mk('a', 'g1', [take(1, { start: 0, duration: 8 }), take(2, { start: 0, duration: 8, isMuted: true })]);
    const b = mk('b', 'g1', [take(1, { start: 0, duration: 8 }), take(2, { start: 0, duration: 8, isMuted: true })]);
    const { results, mates } = compTakeGroup([a, b], 'a', 2, 2, 4);
    expect(mates).toBe(1);
    for (const id of ['a', 'b']) {
      const clips = results.get(id)!.clips.filter(c => !c.isMuted);
      const two = clips.filter(c => c.takeNumber === 2);
      expect(two).toHaveLength(1);
      expect(two[0].start).toBeCloseTo(2 - 0.01, 2);
    }
    const solo = compTakeGroup([a, b], 'a', 2, 2, 4, false);
    expect(solo.results.has('b')).toBe(false);
  });

  it('garder / supprimer une prise : les jumelles aussi', () => {
    const a = mk('a', 'g1', [take(1, { start: 0, duration: 8 }), take(2, { start: 0, duration: 8, isMuted: true })]);
    const b = mk('b', 'g1', [take(1, { start: 0, duration: 8 }), take(2, { start: 0, duration: 8, isMuted: true })]);
    const kept = keepTakeGroup([a, b], 'a', 2);
    expect([...kept.keys()]).toEqual(['a', 'b']);
    kept.forEach(clips => expect(clips.filter(c => !c.isMuted).every(c => c.takeNumber === 2)).toBe(true));
    const del = deleteTakeGroup([a, b], 'a', 2);
    expect([...del.keys()]).toEqual(['a', 'b']);
    del.forEach(r => expect(r.clips.some(c => c.takeNumber === 2)).toBe(false));
  });

  it('coupe à la tête de lecture : pistes dont le clip joué est du même passage', () => {
    const a = mk('a', 'g1', [take(2, { start: 0, duration: 8 })]);
    const b = mk('b', 'g1', [take(2, { start: 0, duration: 8 })]);
    const c = makeTrack({ id: 'c', clips: [take(1, { start: 0, duration: 8 })] });
    expect(takeGroupTracksAt([a, b, c], 'a', 3)).toEqual(['b']);
    expect(takeGroupTracksAt([a, b, c], 'a', 9)).toEqual([]);
  });
});

describe('R14 · ranger une prise par piste', () => {
  const rec = (start: number, duration: number) => makeClip({ id: `rec-${start}-${duration}`, start, duration, offset: 0, fadeIn: 0.01, fadeOut: 0.01 });

  it('prise simple : nommée, ancienne prise coupée, couloir avec groupe', () => {
    const tr = makeTrack({ clips: [take(1, { start: 0, duration: 10 })], takeMeta: [{ n: 1 }] as TakeMeta[] });
    const p = placeTake(tr, rec(2, 4), { rec: null, xfade: 0.01, group: 'tg-1', wall: 1000, stamp: 's' });
    expect(p.takeName).toBe('Prise 2');
    expect(p.mutedOld).toBe(1);
    expect(p.clips[0].isMuted).toBe(true);
    const added = p.clips[1];
    expect(added.takeNumber).toBe(2);
    expect(added.bufferId).toBe('rec-2-4');
    expect((added as any).buffer).toBeUndefined();
    expect(p.takeMeta!.find(m => m.n === 2)).toMatchObject({ group: 'tg-1', recordedAt: 1000 });
  });

  it('punch : l’ancienne prise est découpée autour de la zone, le passage remplacé reste muet dans son couloir', () => {
    const tr = makeTrack({ clips: [take(1, { start: 0, duration: 10 })] });
    const c = rec(3, 6);
    expect(trimToPlan(c, { in: 4, out: 6, isPunch: true }, 0.01)).not.toBeNull();
    const p = placeTake(tr, c, { rec: { in: 4, out: 6, isPunch: true }, xfade: 0.01, wall: 1, stamp: 's' });
    const old = p.clips.filter(x => x.takeNumber === 1);
    expect(old.filter(x => !x.isMuted).map(x => [Number(x.start.toFixed(3)), Number((x.start + x.duration).toFixed(3))])).toEqual([[0, 4.005], [5.995, 10]]);
    expect(old.some(x => x.isMuted)).toBe(true);
    expect(trimToPlan(rec(0, 1), { in: 4, out: 6, isPunch: true }, 0.01)).toBeNull();
  });

  it('Loop Record : un couloir par tour, le dernier tour complet joue, groupe sur chaque tour', () => {
    const tr = makeTrack({ clips: [] });
    const p = placeTake(tr, rec(0, 12.5), { rec: { in: null, out: null, isPunch: false, loop: { start: 0, end: 4 }, wall: 5000 }, xfade: 0.01, group: 'tg-2', wall: 1, stamp: 's' });
    expect(p.loopCount).toBe(3);
    expect(p.activeTake).toBe(3);
    expect(p.clips.filter(c => !c.isMuted).map(c => c.takeNumber)).toEqual([3]);
    expect(p.takeMeta!.map(m => m.group)).toEqual(['tg-2-t1', 'tg-2-t2', 'tg-2-t3']);
  });
});

describe('R15 · protocole du pont', () => {
  it('décode le v1 et le v2 (n° d’échantillon au-delà de 2^32)', () => {
    const v1 = new ArrayBuffer(8 + 4 * 6);
    new DataView(v1).setUint32(0, 3, true); new DataView(v1).setUint32(4, 2, true);
    new Float32Array(v1, 8).set([1, 2, 3, 4, 5, 6]);
    const a = decodeInputMessage(v1);
    expect([a.frames, a.channels, a.frameIndex]).toEqual([3, 2, undefined]);
    expect(Array.from(a.data)).toEqual([1, 2, 3, 4, 5, 6]);
    const v2 = new ArrayBuffer(32 + 4 * 4);
    const dv = new DataView(v2);
    dv.setUint32(0, INPUT_MAGIC_V2, true); dv.setUint32(4, 2, true); dv.setUint32(8, 2, true); dv.setUint32(12, 48000, true);
    dv.setUint32(16, 5, true); dv.setUint32(20, 1, true); dv.setFloat64(24, 1.5, true);
    new Float32Array(v2, 32).set([0.1, 0.2, 0.3, 0.4]);
    const b = decodeInputMessage(v2);
    expect([b.frames, b.channels, b.sampleRate, b.frameIndex, b.adcTime]).toEqual([2, 2, 48000, 4294967296 + 5, 1.5]);
    expect(b.data.length).toBe(4);
    expect(new Uint8Array(v2, 0, 4)).toEqual(new Uint8Array([78, 86, 73, 50])); // 'NVI2'
  });

  it('encode la sortie v2 : chaque canal vers sa sortie de la carte', () => {
    const buf = encodeOutputMessage([new Float32Array([1, 2]), new Float32Array([3, 4]), new Float32Array([5, 6])], [0, 1, 4]);
    const dv = new DataView(buf);
    expect(new TextDecoder().decode(new Uint8Array(buf, 0, 4))).toBe('NVO2');
    expect([dv.getUint32(4, true), dv.getUint32(8, true)]).toEqual([2, 3]);
    expect([dv.getInt32(12, true), dv.getInt32(16, true), dv.getInt32(20, true)]).toEqual([0, 1, 4]);
    expect(Array.from(new Float32Array(buf, 24))).toEqual([1, 3, 5, 2, 4, 6]);
  });

  it('raccord des blocs horodatés : trou → silence, doublon → retiré, flux recréé → on repart', () => {
    expect(blockJoin(null, 0, 256, 22050)).toEqual({ pad: 0, skip: 0, reset: false });
    expect(blockJoin(512, 512, 256, 22050)).toEqual({ pad: 0, skip: 0, reset: false });
    expect(blockJoin(512, 768, 256, 22050)).toEqual({ pad: 256, skip: 0, reset: false });
    expect(blockJoin(512, 384, 256, 22050)).toEqual({ pad: 0, skip: 128, reset: false });
    expect(blockJoin(512, 0, 256, 22050).reset).toBe(true);
    expect(blockJoin(512, 100000, 256, 22050).reset).toBe(true);
  });
});

describe('R14 · récupération d’une prise multipiste', () => {
  const meta = (over: any) => ({ takeId: 't', projectId: 'p', trackId: 'mic3', trackName: 'Micro 3', sampleRate: 44100, recordedAt: 0, latency: 0.0605, startedAt: Date.now(), endedAt: null, samples: 0, chunks: 0, ...over });

  it('replacée comme une prise : avance (décompte) retirée, ce qui tombe avant 0 s rogné (pas décalé)', () => {
    const c = recoveredTakeClip({ meta: meta({ lead: 2.0, recordedAt: 0 }), samples: new Float32Array(0), seconds: 10 }, 'b');
    expect(c.start).toBe(0);
    expect(c.offset).toBeCloseTo(2.0605, 6);
    expect(c.duration).toBeCloseTo(10 - 2.0605, 6);
    const d = recoveredTakeClip({ meta: meta({ recordedAt: 12.5, latency: 0.02 }), samples: new Float32Array(0), seconds: 3 }, 'b');
    expect([d.start, d.offset, d.duration]).toEqual([12.48, 0, 3]);
  });

  it('entrée stéréo : journal entrelacé, durée en secondes juste ; groupe et avance gardés', async () => {
    const store = new RecoveryStore(memoryBackend());
    const j = store.beginTake({ takeId: 's1', projectId: 'p', trackId: 'oh', trackName: 'OH', sampleRate: 100, recordedAt: 1, latency: 0, group: 'tg-1', channels: 2 }, 100);
    j.push(new Float32Array(200));
    j.annotate({ lead: 0.5 });
    j.push(new Float32Array(200));
    await j.finish();
    const t = await store.readTake('s1');
    expect(t!.seconds).toBeCloseTo(2, 6);
    expect(t!.meta.group).toBe('tg-1');
    expect(t!.meta.channels).toBe(2);
    expect(t!.meta.lead).toBe(0.5);
  });
});

describe('R15 · envoi entrelacé vers la carte', () => {
  it('même message qu’à partir des canaux séparés', () => {
    const a = encodeOutputMessage([new Float32Array([1, 2]), new Float32Array([3, 4])], [2, 3]);
    const b = encodeOutputInterleaved(new Float32Array([1, 3, 2, 4]), 2, [2, 3]);
    expect(new Uint8Array(b)).toEqual(new Uint8Array(a));
  });
});
