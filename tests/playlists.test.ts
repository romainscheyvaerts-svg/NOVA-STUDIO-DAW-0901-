import { describe, expect, it } from 'vitest';
import {
  auditionClips, clipAtTime, deleteTake, duplicateTake, keepTake, keptLoopPasses, listLanes, mainRowClips,
  mergeIncomingTakeMeta, nextTakeNumber, patchMeta, punchedPassages, renameTake, splitLoopPasses, takeCount, takeLabel,
} from '../utils/playlists';
import { compSwipe, readComp, takeSpans } from '../utils/comping';
import { cutAroundPunch } from '../utils/punch';
import { Clip } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

const take = (n: number, start: number, dur: number, over: Partial<Clip> = {}) =>
  makeClip({ id: `t${n}-${start}`, takeNumber: n, name: `Prise ${n}`, start, duration: dur, offset: 0, bufferId: `b${n}`, fadeIn: 0.01, fadeOut: 0.01, ...over });
const at2114 = new Date(2026, 9, 7, 21, 14, 30).getTime();

describe('couloirs de prises (Playlists)', () => {
  const track = () => makeTrack({
    id: 'v',
    clips: [take(1, 4, 42, { isMuted: true }), take(2, 4, 42), take(3, 4, 30, { isMuted: true }), makeClip({ id: 'beat', name: 'Beat' })],
    takeMeta: [{ n: 2, recordedAt: at2114 }, { n: 3, name: 'Refrain propre', recordedAt: at2114, loopPass: 2 }],
  });

  it('un couloir par prise, noms lisibles « Prise 2 · 21:14 · 0:42 »', () => {
    const lanes = listLanes(track());
    expect(lanes.map(l => l.label)).toEqual(['Prise 1 · 0:42', 'Prise 2 · 21:14 · 0:42', 'Refrain propre · 21:14 · 0:30']);
    expect(lanes.map(l => [l.n, l.start, l.end, Math.round(l.used)])).toEqual([[1, 4, 46, 0], [2, 4, 46, 42], [3, 4, 34, 0]]);
    expect(lanes[2].title).toContain('tour de boucle n° 2');
    expect(lanes[1].title).toContain('entendue 0:42');
    expect(lanes[0].title).toContain('pas utilisée');
    expect(takeCount(track())).toBe(3);
    expect(nextTakeNumber(track())).toBe(4);
  });

  it('ancien projet (prises nommées « Prise N », sans takeNumber ni takeMeta) : couloirs déduits', () => {
    const t = makeTrack({ clips: [
      makeClip({ id: 'a', name: 'Prise 1', start: 0, duration: 5, isMuted: true, bufferId: 'x' }),
      makeClip({ id: 'b', name: 'Prise 2 · 1', start: 0, duration: 2, bufferId: 'y' }),
      makeClip({ id: 'c', name: 'Prise 2 · 2', start: 3, duration: 2, offset: 3, bufferId: 'y' }),
    ] });
    expect(listLanes(t).map(l => [l.n, l.label, l.clipIds])).toEqual([[1, 'Prise 1 · 0:05', ['a']], [2, 'Prise 2 · 0:04', ['b', 'c']]]);
  });

  it('takeLabel sans heure, nom vide = « Prise N »', () => {
    expect(takeLabel(4, 61, { n: 4, name: '   ' })).toBe('Prise 4 · 1:01');
  });

  it('ligne principale : les passages mutés cachés sous la voix entendue vont dans les couloirs', () => {
    const t = track();
    const shown = mainRowClips(t).map(c => c.id);
    expect(shown).toEqual(['t2-4', 'beat']);
    // Un passage muté qui dépasse (rien n'est entendu là) reste visible.
    const t2 = makeTrack({ clips: [take(1, 0, 10, { isMuted: true }), take(2, 0, 4)] });
    expect(mainRowClips(t2).map(c => c.id)).toEqual(['t1-0', 't2-0']);
    // Une seule prise : rien de caché (un clip muté exprès reste visible).
    const t3 = makeTrack({ clips: [take(1, 0, 10, { isMuted: true })] });
    expect(mainRowClips(t3)).toHaveLength(1);
  });

  it('clic sur la ligne principale : le clip entendu plutôt que la prise mutée dessous', () => {
    const cs = track().clips;
    expect(clipAtTime(cs, 10)!.id).toBe('t2-4');
    expect(clipAtTime(cs, 100)).toBeUndefined();
  });

  it('écouter une prise en solo : elle entière, les autres prises muettes, le reste intact', () => {
    const t = track();
    const cs = compSwipe(t.clips, 3, 10, 20).clips;
    const solo = auditionClips(cs, 1);
    const audible = solo.filter(c => !c.isMuted);
    expect(audible.map(c => [c.takeNumber ?? null, c.start, c.start + c.duration])).toEqual([[null, 0, 4], [1, 4, 46]]);
    expect(solo.find(c => c.id === 'beat')).toBe(cs.find(c => c.id === 'beat'));
    expect(auditionClips(cs, 9)).toBe(cs);
  });

  it('supprimer une prise entendue : la plus récente au même endroit la remplace', () => {
    const t = track();
    t.clips = compSwipe(t.clips, 3, 10, 20).clips;
    const r = deleteTake(t, 3);
    expect(r.replacedBy).toEqual([2]);
    expect(r.clips.some(c => c.takeNumber === 3)).toBe(false);
    expect(readComp(r.clips).map(s => [s.n, s.start, s.end])).toEqual([[2, 4, 46]]);
    expect(r.takeMeta.map(m => m.n)).toEqual([2]);
    expect(r.removedClipIds.length).toBeGreaterThan(0);
    // Prise non utilisée : rien à remplacer.
    expect(deleteTake(track(), 1).replacedBy).toEqual([]);
  });

  it('dupliquer une prise : nouveau couloir, même audio, muet, nom « (copie) »', () => {
    const t = track();
    t.clips = compSwipe(t.clips, 3, 10, 20).clips;
    const r = duplicateTake(t, 3, 'x')!;
    expect(r.newN).toBe(4);
    const copies = r.clips.filter(c => c.takeNumber === 4);
    expect(copies.map(c => [c.start, c.duration, c.offset, c.bufferId, !!c.isMuted])).toEqual([[4, 30, 0, 'b3', true]]);
    expect(r.takeMeta.find(m => m.n === 4)).toMatchObject({ name: 'Refrain propre (copie)', recordedAt: at2114 });
    expect(readComp(r.clips)).toEqual(readComp(t.clips)); // le comp ne change pas
    expect(duplicateTake(t, 9)).toBeNull();
  });

  it('garder une prise entière, renommer', () => {
    const cs = keepTake(track().clips, 1);
    expect(readComp(cs).map(s => s.n)).toEqual([1]);
    const m = renameTake(track().takeMeta, 1, '  Couplet 1  ');
    expect(m.find(x => x.n === 1)!.name).toBe('Couplet 1');
    expect(patchMeta(m, 1, { name: '' }).find(x => x.n === 1)!.name).toBeUndefined();
    expect(renameTake(undefined, 2, 'x'.repeat(80))[0].name).toHaveLength(40);
  });
});

describe('Loop Record : un couloir par tour de boucle', () => {
  it('3 tours complets + un bout : 4 prises, le dernier tour complet est entendu', () => {
    // Prise recalée : commence 5 ms avant la boucle (moitié du crossfade du pré-roll).
    const passes = splitLoopPasses({ start: 3.995, duration: 0.005 + 12 + 1.5, offset: 0.2 }, 4, 8);
    expect(passes.map(p => [p.pass, p.start, +p.duration.toFixed(3), +p.offset.toFixed(3), p.complete])).toEqual([
      [1, 3.995, 4.005, 0.2, true], [2, 4, 4, 4.205, true], [3, 4, 4, 8.205, true], [4, 4, 1.5, 12.205, false],
    ]);
    expect(keptLoopPasses(passes)).toMatchObject({ active: 3 });
    expect(keptLoopPasses(passes).kept).toHaveLength(4);
  });

  it('un bout de tour trop court est jeté ; arrêt pendant le 1er tour = une prise normale', () => {
    const passes = splitLoopPasses({ start: 4, duration: 8.3, offset: 0 }, 4, 8);
    expect(keptLoopPasses(passes).kept.map(p => p.pass)).toEqual([1, 2]);
    expect(keptLoopPasses(passes).active).toBe(2);
    const one = splitLoopPasses({ start: 4, duration: 2, offset: 0 }, 4, 8);
    expect(one).toEqual([{ pass: 1, start: 4, duration: 2, offset: 0, complete: false }]);
    expect(keptLoopPasses(one)).toEqual({ kept: one, active: 1 });
  });
});

describe('punch sur une piste à prises', () => {
  it('le passage remplacé reste (muté) dans le couloir de l’ancienne prise', () => {
    const old = [take(1, 0, 10)];
    const cut = cutAroundPunch(old, 4, 6, 0.01, 's');
    const kept = punchedPassages(old, 4, 6, 's');
    expect(kept.map(c => [c.takeNumber, c.start, c.duration, c.offset, c.isMuted])).toEqual([[1, 4, 2, 4, true]]);
    const all = [...cut.clips, ...kept];
    expect(takeSpans(all).map(s => [s.n, s.start, s.end])).toEqual([[1, 0, 10]]);
    // Clips mutés ou hors zone : rien.
    expect(punchedPassages([take(1, 0, 10, { isMuted: true }), take(2, 7, 2)], 4, 6, 's')).toEqual([]);
  });
});

describe('collaboration : takeMeta, champ ajouté à l’op « content »', () => {
  it('reçu d’une version récente : nettoyé ; reçu d’une ancienne (absent) : on garde le local', () => {
    const local = [{ n: 1, name: 'Couplet' }];
    expect(mergeIncomingTakeMeta(local, undefined)).toBe(local);
    expect(mergeIncomingTakeMeta(local, [{ n: 2, name: 'Refrain', recordedAt: 5, junk: 1 }, { name: 'sans n' }, null]))
      .toEqual([{ n: 2, name: 'Refrain', recordedAt: 5 }]);
  });
});
