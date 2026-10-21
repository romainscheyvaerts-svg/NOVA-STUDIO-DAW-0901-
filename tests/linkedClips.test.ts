import { describe, it, expect } from 'vitest';
import { TrackType, type Clip, type Track } from '../types';
import { duplicateLinked, makeUnique, syncLinkedClips, linkCounts, isLinked, copyContent } from '../utils/linkedClips';
import { buildTempoMap, timeToQuarters } from '../utils/tempoMap';
import { followTempo } from '../utils/tempoFollow';
import { splitClipAt } from '../utils/timeSelection';

const tr = (id: string, clips: Clip[]): Track => ({ id, name: id, type: TrackType.MIDI, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0 });
const clip = (id: string, start: number, notes: [number, number, number][]): Clip => ({
  id, start, duration: 2, offset: 0, fadeIn: 0, fadeOut: 0, name: 'Motif', color: '#0ff', type: TrackType.MIDI,
  notes: notes.map(([p, s, d], i) => ({ id: `${id}-${i}`, pitch: p, start: s, duration: d, velocity: 0.8 })),
});

/** 8 copies liées du même motif (1 clip + 7 copies), sur 2 pistes. */
function eight(): Track[] {
  let clips = [clip('a', 0, [[60, 0, 0.5], [64, 0.5, 0.5]])];
  for (let i = 0; i < 6; i++) clips = duplicateLinked(clips, clips[clips.length - 1].id, { id: `a${i}` }).clips;
  const other = { ...clips[1], id: 'b0', start: 20 };
  return [tr('p', clips), tr('q', [other])];
}

const editNotes = (tracks: Track[], clipId: string, fn: (c: Clip) => Clip): Track[] =>
  tracks.map(t => (t.clips.some(c => c.id === clipId) ? { ...t, clips: t.clips.map(c => (c.id === clipId ? fn(c) : c)) } : t));

describe('clips MIDI liés (L3, écart 10)', () => {
  it('« Dupliquer en copie liée » : 8 copies du même groupe, posées à la suite', () => {
    const t = eight();
    const counts = linkCounts(t);
    expect(counts.size).toBe(1);
    expect([...counts.values()][0]).toBe(8);
    expect(t[0].clips.map(c => c.start)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(t.flatMap(x => x.clips).every(c => isLinked(c, counts))).toBe(true);
  });
  it('modifier une note dans UNE copie change les 8 copies (en une seule mise à jour)', () => {
    const t0 = eight();
    const t1 = editNotes(t0, 'a3', c => ({ ...c, notes: [...c.notes!.slice(0, 1), { ...c.notes![1], pitch: 67 }, { id: 'new', pitch: 72, start: 1.5, duration: 0.25, velocity: 1 }] }));
    const t2 = syncLinkedClips(t0, t1);
    const all = t2.flatMap(x => x.clips);
    expect(all.length).toBe(8);
    for (const c of all) expect(c.notes!.map(n => n.pitch)).toEqual([60, 67, 72]);
    // Positions et longueurs des clips intactes.
    expect(t2[0].clips.map(c => c.start)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(t2[1].clips[0].start).toBe(20);
  });
  it('« Rendre unique » détache une copie en une étape ; les autres restent liées', () => {
    const t0 = eight();
    const t1 = editNotes(t0, 'a2', makeUnique);
    expect(syncLinkedClips(t0, t1)).toBe(t1);
    const t2 = editNotes(t1, 'a2', c => ({ ...c, notes: [] }));
    const t3 = syncLinkedClips(t1, t2);
    expect(t3.flatMap(x => x.clips).filter(c => c.notes!.length === 0).map(c => c.id)).toEqual(['a2']);
    const t4 = syncLinkedClips(t3, editNotes(t3, 'a0', c => ({ ...c, notes: [c.notes![0]] })));
    expect(t4.flatMap(x => x.clips).filter(c => c.linkId).every(c => c.notes!.length === 1)).toBe(true);
    expect(linkCounts(t4).get(t4[0].clips[0].linkId!)).toBe(7);
  });
  it('plusieurs copies changées ensemble (changement de tempo) : rien n’est recopié', () => {
    const t0 = eight();
    const s = { bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, tempoEvents: [], tracks: t0, markers: [], loopStart: 0, loopEnd: 0 };
    const r = followTempo(s, { bpm: 60 }, { keepAudio: false });
    expect(syncLinkedClips(t0, r.state.tracks)).toBe(r.state.tracks);
  });
  it('clip lié coupé en deux : les deux moitiés quittent le groupe, le motif des autres reste entier', () => {
    const t0 = eight();
    const target = t0[0].clips[2];
    const [l, rr] = splitClipAt(target, target.start + 0.5, 'half');
    const t1 = [{ ...t0[0], clips: t0[0].clips.flatMap(c => (c.id === target.id ? [l as Clip, rr as Clip] : [c])) }, t0[1]];
    const t2 = syncLinkedClips(t0, t1);
    const byId = new Map(t2.flatMap(x => x.clips).map(c => [c.id, c]));
    expect(byId.get(target.id)!.linkId).toBeUndefined();
    expect(byId.get((rr as Clip).id)!.linkId).toBeUndefined();
    expect(byId.get('a0')!.notes!.length).toBe(2);
    expect(linkCounts(t2).get(byId.get('a0')!.linkId!)).toBe(7);
  });
  it('copie identique ajoutée (collage d’une copie liée, collaboration) : reste liée', () => {
    const t0 = eight();
    const t1 = [{ ...t0[0], clips: [...t0[0].clips, { ...t0[0].clips[0], id: 'z', start: 40 }] }, t0[1]];
    const t2 = syncLinkedClips(t0, t1);
    expect(t2).toBe(t1);
  });
  it('copies sous des tempos différents : la copie garde la même position MUSICALE des notes', () => {
    const m = buildTempoMap(120, { numerator: 4, denominator: 4 }, [{ id: 'e', bar: 4, bpm: 60 }]);
    const src = clip('s', 0, [[60, 0.5, 0.5]]); // noire 2 de la mesure 1, durée 1 noire
    const dst = { ...clip('d', 8, []), linkId: 'x' }; // mesure 5 (à 60 BPM : 1 s par noire)
    const out = copyContent(src, dst, m);
    expect(out.notes![0].start).toBeCloseTo(1, 9);
    expect(out.notes![0].duration).toBeCloseTo(1, 9);
    expect(timeToQuarters(m, out.start + out.notes![0].start) - timeToQuarters(m, out.start)).toBeCloseTo(1, 9);
  });
  it('l’origine sans groupe entre dans le groupe à la première copie ; un groupe d’un seul clip n’est pas « lié »', () => {
    const r = duplicateLinked([clip('solo', 0, [[60, 0, 1]])], 'solo', { id: 'c2' });
    expect(r.clips[0].linkId).toBe(r.clips[1].linkId);
    const counts = linkCounts([tr('p', [makeUnique(r.clips[0]), r.clips[1]])]);
    expect(isLinked(r.clips[1], counts)).toBe(false);
  });
  it('clip audio : pas de copie liée', () => {
    const a = { ...clip('au', 0, []), notes: undefined, type: TrackType.AUDIO } as Clip;
    expect(duplicateLinked([a], 'au').id).toBeNull();
  });
});
