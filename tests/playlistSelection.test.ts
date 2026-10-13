import { describe, expect, it } from 'vitest';
import { selectionToNewPlaylist } from '../utils/playlistSelection';
import { playlistsOf, toggleRecentPlaylist } from '../utils/trackPlaylists';
import { makeClip, makeTrack } from './helpers/fixtures';

const lead = () => makeTrack({
  id: 'lead', name: 'LEAD A',
  clips: [makeClip({ id: 'c1', start: 0, duration: 6, offset: 0, bufferId: 'buf-1' }), makeClip({ id: 'c2', start: 6, duration: 6, offset: 6, bufferId: 'buf-1' })],
});

describe('copier / déplacer la sélection vers une nouvelle playlist', () => {
  it('copier : la nouvelle playlist contient seulement la plage, à sa place, même son ; on entend toujours la même version', () => {
    const t = lead();
    const r = selectionToNewPlaylist(t, 4, 8, { stamp: 'x', now: 1 });
    expect(r.id).toBeTruthy();
    expect(r.name).toBe('LEAD A.01');
    expect(r.clips).toBe(2);
    const { list, activeId } = playlistsOf(r.track);
    expect(activeId).toBe(t.activePlaylistId || list[0].id);
    expect(list.map(p => p.name)).toEqual(['LEAD A', 'LEAD A.01']);
    // Version qu'on entend : intacte.
    expect(r.track.clips.map(c => [c.id, c.start, c.duration])).toEqual([['c1', 0, 6], ['c2', 6, 6]]);
    // Nouvelle : 4→6 (fin de c1) et 6→8 (début de c2), offsets recalés, son gardé.
    const got = list[1].clips.map(c => [c.start, c.duration, c.offset, c.bufferId]);
    expect(got).toEqual([[4, 2, 4, 'buf-1'], [6, 2, 6, 'buf-1']]);
    expect(new Set(list[1].clips.map(c => c.id)).size).toBe(2);
    expect(list[1].clips.every(c => c.id !== 'c1' && c.id !== 'c2')).toBe(true);
  });

  it('déplacer : la plage est retirée de la version qu’on entend (un blanc), et part dans la nouvelle', () => {
    const r = selectionToNewPlaylist(lead(), 4, 8, { move: true, stamp: 'y' });
    const spans = r.track.clips.map(c => [c.start, c.start + c.duration]);
    expect(spans).toEqual([[0, 4], [8, 12]]);
    expect(playlistsOf(r.track).list[1].clips).toHaveLength(2);
  });

  it('« playlist d’avant » (Maj+←) bascule tout de suite sur la nouvelle, puis revient', () => {
    const r = selectionToNewPlaylist(lead(), 1, 2, { stamp: 'z' });
    const on = toggleRecentPlaylist(r.track);
    expect(on.activePlaylistId).toBe(r.id);
    expect(on.clips).toHaveLength(1);
    const back = toggleRecentPlaylist(on);
    expect(back.clips.map(c => c.id)).toEqual(['c1', 'c2']);
  });

  it('plage vide ou sans clip : rien ne change', () => {
    const t = lead();
    expect(selectionToNewPlaylist(t, 3, 3).track).toBe(t);
    expect(selectionToNewPlaylist(t, 20, 30).id).toBeNull();
  });

  it('une 2e copie prend le nom suivant, les versions existantes gardent leurs clips', () => {
    const a = selectionToNewPlaylist(lead(), 0, 2, { stamp: 'a' });
    const b = selectionToNewPlaylist(a.track, 2, 3, { stamp: 'b' });
    const { list } = playlistsOf(b.track);
    expect(list.map(p => p.name)).toEqual(['LEAD A', 'LEAD A.01', 'LEAD A.02']);
    expect(list[1].clips).toHaveLength(1);
    expect(list[2].clips).toHaveLength(1);
  });
});
