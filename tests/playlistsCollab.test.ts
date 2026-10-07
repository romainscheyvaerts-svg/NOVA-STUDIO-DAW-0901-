import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { contentBufferIds, contentOf, sigOf } from '../services/Collab';
import { compSwipe, readComp } from '../utils/comping';
import { listLanes, mergeIncomingTakeMeta } from '../utils/playlists';
import { Clip, Track } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * Collaboration : les couloirs et le comp voyagent dans l'op « content ».
 * - L'audio des prises et le comp sont dans `clips` (champ connu de toutes les versions).
 * - Les infos des couloirs sont dans `takeMeta` (champ ajouté).
 */

const take = (n: number, start: number, dur: number, over: Partial<Clip> = {}) =>
  makeClip({ id: `t${n}`, takeNumber: n, name: `Prise ${n}`, start, duration: dur, bufferId: `b${n}`, ...over });

const voice = (): Track => {
  const t = makeTrack({ id: 'voix', name: 'LEAD', clips: [take(1, 0, 10, { isMuted: true }), take(2, 0, 10), take(3, 0, 10, { isMuted: true })] });
  t.clips = compSwipe(t.clips, 1, 2, 4).clips;
  t.clips = compSwipe(t.clips, 3, 6, 8).clips;
  t.takeMeta = [{ n: 1, name: 'Couplet calme', recordedAt: 1 }, { n: 3, loopPass: 3 }];
  return t;
};

/** Ce que fait une ANCIENNE version à la réception (App.tsx avant les couloirs) : champs connus seulement. */
function oldApply(local: Track, ct: any): Track {
  const t: any = { ...local };
  t.name = ct.name ?? t.name;
  t.color = ct.color ?? t.color;
  if (ct.collabOwner) t.collabOwner = ct.collabOwner;
  if (ct.drumMachine !== undefined) t.drumMachine = ct.drumMachine;
  if (ct.drumPads !== undefined) t.drumPads = ct.drumPads;
  if (ct.bass808 !== undefined) t.bass808 = ct.bass808;
  t.clips = Array.isArray(ct.clips) ? ct.clips : t.clips;
  return t;
}

/** Ce que fait la version actuelle (App.tsx, case 'content'). */
function newApply(local: Track, ct: any): Track {
  const t = oldApply(local, ct);
  t.takeMeta = mergeIncomingTakeMeta(local.takeMeta, ct.takeMeta);
  return t;
}

const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('op « content » : couloirs de prises, rétrocompatible', () => {
  it('le contenu porte les prises (clips), le comp (mutes, crossfades) et takeMeta ; l’audio de toutes les prises est envoyé', () => {
    const c = wire(contentOf(voice()));
    expect(c.takeMeta).toEqual([{ n: 1, name: 'Couplet calme', recordedAt: 1 }, { n: 3, loopPass: 3 }]);
    expect(readComp(c.clips).map((s: any) => [s.n, s.start, s.end])).toEqual([[2, 0, 2], [1, 2, 4], [2, 4, 6], [3, 6, 8], [2, 8, 10]]);
    expect(contentBufferIds(voice()).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('une ANCIENNE version ignore takeMeta sans casser : elle reçoit les clips et joue le même comp', () => {
    const before = makeTrack({ id: 'voix', clips: [] });
    const got = oldApply(before, wire(contentOf(voice())));
    expect('takeMeta' in got).toBe(false);
    expect(readComp(got.clips)).toEqual(readComp(voice().clips));
    // Ce qu'elle entend : les clips non mutés, avec leurs fondus (crossfades).
    const audible = (cs: Clip[]) => cs.filter(x => !x.isMuted).map(x => [x.takeNumber, x.start, x.duration, x.offset, x.fadeIn, x.fadeOut]);
    expect(audible(got.clips)).toEqual(audible(voice().clips));
  });

  it('la version actuelle reçoit couloirs et comp ; d’une ancienne version (sans takeMeta) elle garde ses noms', () => {
    const got = newApply(makeTrack({ id: 'voix' }), wire(contentOf(voice())));
    const labels = listLanes(got).map(l => l.label);
    expect(labels[0]).toMatch(/^Couplet calme · \d\d:\d\d · 0:10$/);
    expect(labels.slice(1)).toEqual(['Prise 2 · 0:10', 'Prise 3 · 0:10']);
    expect(got.takeMeta).toEqual(voice().takeMeta);
    // Contenu envoyé par une ancienne version : pas de takeMeta.
    const old = wire(contentOf(voice()));
    delete old.takeMeta;
    const kept = newApply(voice(), old);
    expect(kept.takeMeta).toEqual(voice().takeMeta);
  });

  it('piste sans prise : contenu (et empreinte) identiques à ceux d’une ancienne version ; renommer une prise se renvoie', () => {
    const beat = makeTrack({ id: 'b', clips: [makeClip({ id: 'x', bufferId: 'bx' })] });
    expect('takeMeta' in wire(contentOf(beat))).toBe(false);
    expect(sigOf(contentOf(beat))).toBe(sigOf(contentOf({ ...beat, takeMeta: [] })));
    const v = voice();
    expect(sigOf(contentOf({ ...v, takeMeta: [{ n: 1, name: 'Autre nom' }] }))).not.toBe(sigOf(contentOf(v)));
  });
});
