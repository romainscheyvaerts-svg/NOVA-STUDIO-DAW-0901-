/**
 * Grosses séances (écart 25) : chercher, filtrer, « n'afficher que », épingler.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Track, TrackType } from '../types';
import { isFiltering, matchTracks, showOnly, trackColors, trackKind } from '../utils/trackFilter';
import { __resetPinsForTests, isPinned, pinnedIds, setPinsProject, togglePin } from '../utils/trackPins';

const tr = (id: string, name: string, type: TrackType = TrackType.AUDIO, o: Partial<Track> = {}): Track => ({
  id, name, type, color: '#22d3ee', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
  outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...o,
});

/** Séance de 96 pistes : 24 voix, 24 batterie, 24 MIDI, 12 bus, 12 dossiers / divers. */
function bigSession(): Track[] {
  const out: Track[] = [];
  const voix = ['Lead', 'Back', 'Harmo', 'Adlib', 'Voix couplet', 'Double'];
  for (let i = 0; i < 24; i++) out.push(tr(`v${i}`, `${voix[i % voix.length]} ${i + 1}`, TrackType.AUDIO, { color: '#a78bfa' }));
  for (let i = 0; i < 24; i++) out.push(tr(`d${i}`, `${['Kick', 'Snare', 'Hats', 'Perc'][i % 4]} ${i + 1}`, TrackType.AUDIO, { color: '#f97316' }));
  for (let i = 0; i < 24; i++) out.push(tr(`m${i}`, `Synth ${i + 1}`, TrackType.MIDI, { color: '#facc15' }));
  for (let i = 0; i < 12; i++) out.push(tr(`b${i}`, `Bus ${i + 1}`, TrackType.BUS, { color: '#60a5fa' }));
  for (let i = 0; i < 11; i++) out.push(tr(`f${i}`, `Dossier ${i + 1}`, TrackType.BUS, { folder: { kind: 'basic' } }));
  out.push(tr('beat', 'Beat', TrackType.AUDIO, { instrumentId: 'b-1' }));
  out.push(tr('master', 'Master', TrackType.BUS));
  return out;
}

describe('rôle d\'une piste', () => {
  it('voix par le nom, la chaîne voix ou la piste guide ; le reste en audio, MIDI, bus, dossier', () => {
    expect(trackKind(tr('a', 'Lead voix'))).toBe('voix');
    expect(trackKind(tr('a', 'Ad-lib refrain'))).toBe('voix');
    expect(trackKind(tr('a', 'Prise sans nom', TrackType.AUDIO, { voiceChain: {} }))).toBe('voix');
    expect(trackKind(tr('a', 'Guitare'))).toBe('audio');
    expect(trackKind(tr('a', 'Voix 808'))).toBe('audio');
    expect(trackKind(tr('beat', 'Beat', TrackType.AUDIO, { instrumentId: 'x' }))).toBe('audio');
    expect(trackKind(tr('a', 'Piano', TrackType.MELODIC_SAMPLER))).toBe('midi');
    expect(trackKind(tr('a', 'Réverbe', TrackType.BUS))).toBe('bus');
    expect(trackKind(tr('a', 'Voix', TrackType.BUS, { folder: { kind: 'routing' } }))).toBe('dossier');
  });
});

describe('filtre', () => {
  const tracks = bigSession();
  it('nom (sans accents ni majuscules, plusieurs mots), rôle, couleur, état', () => {
    expect(matchTracks(tracks, { text: 'LEAD' }).map(t => t.id)).toEqual(['v0', 'v6', 'v12', 'v18']);
    expect(matchTracks(tracks, { text: 'voix couplet 5' }).map(t => t.name)).toEqual(['Voix couplet 5']);
    expect(matchTracks(tracks, { kinds: ['voix'] }).length).toBe(24);
    expect(matchTracks(tracks, { kinds: ['bus', 'dossier'] }).length).toBe(23);
    expect(matchTracks(tracks, { colors: ['#F97316'] }).length).toBe(24);
    const t2 = tracks.map(t => (t.id === 'd3' ? { ...t, isMuted: true } : t.id === 'v2' ? { ...t, isSolo: true, isTrackArmed: true } : t));
    expect(matchTracks(t2, { state: 'muted' }).map(t => t.id)).toEqual(['d3']);
    expect(matchTracks(t2, { state: 'solo' }).map(t => t.id)).toEqual(['v2']);
    expect(matchTracks(t2, { state: 'armed' }).map(t => t.id)).toEqual(['v2']);
    expect(matchTracks(t2, { state: 'pinned' }, new Set(['m4'])).map(t => t.id)).toEqual(['m4']);
    expect(matchTracks(tracks, {}).some(t => t.id === 'master')).toBe(false);
    expect(isFiltering({})).toBe(false);
    expect(isFiltering({ kinds: ['voix'] })).toBe(true);
    expect(trackColors(tracks)).toEqual(['#a78bfa', '#f97316', '#facc15', '#60a5fa', '#22d3ee']);
  });

  it('« voix » sur 96 pistes en moins de 100 ms (mesuré : bien moins)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) matchTracks(tracks, { kinds: ['voix'], text: i % 2 ? 'lead' : '' });
    expect((performance.now() - t0) / 20).toBeLessThan(100);
  });

  it('« n\'afficher que » : masque les autres, garde les dossiers parents et le master, rien d\'autre ne change', () => {
    const t = [tr('f', 'Voix', TrackType.BUS, { folder: { kind: 'routing' } }), tr('a', 'Lead', TrackType.AUDIO, { parentFolderId: 'f' }), tr('b', 'Kick', TrackType.AUDIO, { isHidden: false }), tr('master', 'Master', TrackType.BUS)];
    const out = showOnly(t, ['a']);
    expect(out.map(x => [x.id, !!x.isHidden])).toEqual([['f', false], ['a', false], ['b', true], ['master', false]]);
    expect(out[1]).toBe(t[1]);
    expect({ ...out[2], isHidden: false }).toEqual(t[2]);
  });
});

describe('épingles', () => {
  beforeEach(() => __resetPinsForTests());
  it('par projet, 8 au plus, désépingler', () => {
    setPinsProject('p1');
    expect(togglePin('a')).toBe(true);
    expect(isPinned('a')).toBe(true);
    for (let i = 0; i < 9; i++) togglePin(`t${i}`);
    expect(pinnedIds()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    setPinsProject('p2');
    expect(pinnedIds()).toEqual([]);
    togglePin('x');
    setPinsProject('p1');
    expect(togglePin('t3')).toBe(false);
    expect(pinnedIds()).not.toContain('t3');
    expect(togglePin('t4', true)).toBe(true);
    expect(pinnedIds()[pinnedIds().length - 1]).toBe('t4');
  });
});
