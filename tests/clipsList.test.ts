import { describe, expect, it } from 'vitest';
import { addToBin, clearUnused, clipRows, filterRows, placeClip, removedClips, unusedClips } from '../utils/clipsList';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { TrackType } from '../types';

function song() {
  return makeState([
    makeTrack({ id: 'lead', name: 'LEAD', clips: [makeClip({ id: 'c1', name: 'Lead prise 1', start: 2, duration: 4, bufferId: 'b-lead' }), makeClip({ id: 'c2', name: 'Lead prise 1.1', start: 8, duration: 1, bufferId: 'b-lead', offset: 6 })] }),
    makeTrack({ id: 'keys', name: 'KEYS', type: TrackType.MIDI, clips: [makeClip({ id: 'm1', name: 'Accords', type: TrackType.MIDI, start: 0, duration: 4, notes: [{ id: 'n', pitch: 60, start: 0, duration: 1, velocity: 90 }] })] }),
    makeTrack({ id: 'master', name: 'MASTER', clips: [] }),
  ]);
}

describe('R21 · liste des clips de la session', () => {
  it('lignes : clips audio et MIDI, piste, durée, son d’origine commun', () => {
    const rows = clipRows(song());
    expect(rows.map(r => r.clipId)).toEqual(['c1', 'c2', 'm1']);
    expect(rows[1].source).toBe('Lead prise 1');
    expect(rows[2]).toMatchObject({ kind: 'midi', notes: 1, trackName: 'KEYS', used: true });
  });

  it('recherche (sans accents) et tri', () => {
    const rows = clipRows(song());
    expect(filterRows(rows, 'accord').map(r => r.clipId)).toEqual(['m1']);
    expect(filterRows(rows, 'LEAD', 'duration').map(r => r.clipId)).toEqual(['c2', 'c1']);
    expect(filterRows(rows, '', 'name', -1).map(r => r.name)[0]).toBe('Lead prise 1.1');
    expect(filterRows(rows, '', 'start', 1, 'midi').map(r => r.clipId)).toEqual(['m1']);
  });

  it('clip supprimé de la timeline : gardé dans la liste (pas les morceaux d’une coupe)', () => {
    const s = song();
    // Suppression de c2 : son son est encore joué par c1 → ce n'est qu'une coupe.
    const t1 = s.tracks.map(t => (t.id === 'lead' ? { ...t, clips: t.clips.filter(c => c.id !== 'c2') } : t));
    expect(removedClips(s.tracks, t1)).toEqual([]);
    // Suppression des deux : le son n'est plus joué → dans la réserve.
    const t2 = s.tracks.map(t => (t.id === 'lead' ? { ...t, clips: [] } : t.id === 'keys' ? { ...t, clips: [] } : t));
    const gone = removedClips(s.tracks, t2, 7);
    expect(gone.map(c => c.id)).toEqual(['c1', 'c2', 'm1']);
    expect(gone[0]).toMatchObject({ fromTrackId: 'lead', fromTrackName: 'LEAD', removedAt: 7 });
    const s2 = { ...s, tracks: t2, clipBin: addToBin(undefined, gone) };
    expect(unusedClips(s2)).toHaveLength(3);
    expect(clipRows(s2).filter(r => !r.used)).toHaveLength(3);
  });

  it('glisser vers une piste : copie d’un clip de la timeline, retour d’un clip de la réserve ; type de piste vérifié', () => {
    let s: any = song();
    const gone = removedClips(s.tracks, s.tracks.map((t: any) => (t.id === 'lead' ? { ...t, clips: [] } : t)), 1);
    s = { ...s, tracks: s.tracks.map((t: any) => (t.id === 'lead' ? { ...t, clips: [] } : t)), clipBin: gone };
    const r = placeClip(s, 'b:c1', 'lead', 10, 'nouveau');
    expect(r.error).toBeUndefined();
    expect(r.state.tracks[0].clips[0]).toMatchObject({ id: 'c1', start: 10, bufferId: 'b-lead' });
    expect(r.state.clipBin.map((c: any) => c.id)).toEqual(['c2']);
    const copy = placeClip(r.state, 't:keys:m1', 'keys', 8, 'm-copie');
    expect(copy.state.tracks[1].clips.map((c: any) => [c.id, c.start])).toEqual([['m1', 0], ['m-copie', 8]]);
    expect(placeClip(r.state, 't:keys:m1', 'lead', 0, 'x').error).toMatch(/piste MIDI/);
  });

  it('« Supprimer les clips inutilisés » : la réserve seulement, la timeline intacte', () => {
    const s = song();
    const t2 = s.tracks.map(t => (t.id === 'lead' ? { ...t, clips: [] } : t));
    const s2 = { ...s, tracks: t2, clipBin: removedClips(s.tracks, t2) };
    const r = clearUnused(s2);
    expect(r.removed).toBe(2);
    expect(r.state.clipBin).toEqual([]);
    expect(r.state.tracks).toBe(t2);
    expect(clearUnused(r.state).removed).toBe(0);
  });
});
