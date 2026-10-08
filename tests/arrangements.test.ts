import { describe, expect, it } from 'vitest';
import {
  addMutedRange, arrangementSections, arrangementSummary, moveSection, newArrangement, renderArrangement, resolveArrangement,
  sanitizeArrangements, START_SECTION, toggleMutedClips, MUTE_FADE,
} from '../utils/arrangements';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { DAWState } from '../types';

/** Intro 0-2, Couplet 2-6, Refrain 6-10, Outro 10-12 (fin du morceau). */
function song(): DAWState {
  const lane = { id: 'l', parameterName: 'volume', color: '#fff', isExpanded: false, min: 0, max: 1, points: [{ id: 'a', time: 0, value: 0.2 }, { id: 'b', time: 12, value: 1 }] };
  return makeState([
    makeTrack({ id: 'beat', name: 'BEAT', sends: [], clips: [makeClip({ id: 'c-beat', start: 0, duration: 12, bufferId: 'b1' })] }),
    makeTrack({ id: 'lead', name: 'LEAD', sends: [], automationLanes: [lane], clips: [makeClip({ id: 'c-lead', start: 2, duration: 8, bufferId: 'b2' })] }),
    makeTrack({ id: 'master', name: 'MASTER', sends: [], clips: [] }),
  ], {
    markers: [
      { id: 'm-intro', name: 'Intro', time: 0, type: 'MARKER', color: '#64748b', number: 1 },
      { id: 'm-c', name: 'Couplet', time: 2, type: 'MARKER', color: '#22d3ee', number: 2 },
      { id: 'm-r', name: 'Refrain', time: 6, type: 'MARKER', color: '#f59e0b', number: 3 },
      { id: 'm-o', name: 'Outro', time: 10, type: 'MARKER', color: '#a855f7', number: 4 },
    ],
    chords: [{ id: 'k1', start: 6, end: 10, root: 0, quality: 'maj' as any }],
  });
}

describe('R21 · arrangements multiples', () => {
  it('sections : celles des repères, plus le début quand le 1er repère est plus loin', () => {
    expect(arrangementSections(song()).map(s => s.name)).toEqual(['Intro', 'Couplet', 'Refrain', 'Outro']);
    const s = song();
    s.markers = s.markers.filter(m => m.id !== 'm-intro');
    const secs = arrangementSections(s);
    expect(secs[0]).toMatchObject({ id: START_SECTION, name: 'Début', start: 0, end: 2 });
  });

  it('nouvel arrangement = ordre de la timeline ; rendu identique à la timeline', () => {
    const s = song();
    const a = newArrangement(s, 'Explicite');
    expect(a.sections).toEqual(['m-intro', 'm-c', 'm-r', 'm-o']);
    const r = renderArrangement(s, a);
    expect(r.report.length).toBeCloseTo(12, 9);
    const lead = r.state.tracks.find(t => t.id === 'lead')!;
    // Coupé aux bords des sections, mais bout à bout aux mêmes instants.
    const spans = lead.clips.map(c => [c.start, c.start + c.duration, c.offset]);
    expect(spans).toEqual([[2, 6, 0], [6, 10, 4]]);
  });

  it('radio edit : le refrain doublé, l’outro retirée ; longueur, sections, repères et accords', () => {
    const s = song();
    let a = newArrangement(s, 'Radio edit');
    a = { ...a, sections: ['m-c', 'm-r', 'm-r'] };
    const r = renderArrangement(s, a);
    expect(r.report.length).toBeCloseTo(12, 9);
    expect(r.report.sections.map(x => [x.name, x.start, x.end])).toEqual([['Couplet', 0, 4], ['Refrain', 4, 8], ['Refrain', 8, 12]]);
    expect(r.state.markers.map(m => [m.name, m.time])).toEqual([['Couplet', 0], ['Refrain', 4], ['Refrain', 8]]);
    expect(r.state.chords!.map(c => [c.start, c.end])).toEqual([[4, 8], [8, 12]]);
    const beat = r.state.tracks.find(t => t.id === 'beat')!;
    expect(beat.clips.map(c => [c.start, c.duration, c.offset])).toEqual([[0, 4, 2], [4, 4, 6], [8, 4, 6]]);
    const ids = r.state.tracks.flatMap(t => t.clips.map(c => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    // Automation : la courbe du refrain est rejouée deux fois.
    const lane = r.state.tracks.find(t => t.id === 'lead')!.automationLanes[0];
    expect(lane.points.length).toBeGreaterThan(0);
    expect(r.state.loopEnd).toBeCloseTo(12, 9);
    // La timeline d'origine n'est pas touchée.
    expect(s.tracks[0].clips).toHaveLength(1);
    expect(arrangementSummary(s, a)).toBe('Couplet → Refrain → Refrain · 0:12,0');
  });

  it('version clean : passage coupé avec fondus de 5 ms, clip coupé en entier', () => {
    const s = song();
    let a = newArrangement(s, 'Clean');
    a = addMutedRange(a, 3, 3.5, ['lead']);
    a = toggleMutedClips(a, ['c-beat']);
    const r = renderArrangement(s, a);
    const lead = r.state.tracks.find(t => t.id === 'lead')!;
    const cut = lead.clips.find(c => Math.abs(c.start - 3) < 1e-9)!;
    expect(cut.isMuted).toBe(true);
    expect(cut.duration).toBeCloseTo(0.5, 9);
    const before = lead.clips.find(c => Math.abs(c.start + c.duration - 3) < 1e-9)!;
    const after = lead.clips.find(c => Math.abs(c.start - 3.5) < 1e-9)!;
    expect(before.fadeOut).toBeCloseTo(MUTE_FADE, 9);
    expect(after.fadeIn).toBeCloseTo(MUTE_FADE, 9);
    expect(r.state.tracks.find(t => t.id === 'beat')!.clips.every(c => c.isMuted)).toBe(true);
    expect(r.report.muted).toBe(2);
    // Rétablir le clip.
    expect(toggleMutedClips(a, ['c-beat']).mutedClipIds).toEqual([]);
  });

  it('section disparue (repère supprimé) : signalée, ignorée au rendu', () => {
    const s = song();
    const a = { ...newArrangement(s, 'X'), sections: ['m-c', 'm-zz'] };
    const r = resolveArrangement(s, a);
    expect(r.missing).toEqual(['m-zz']);
    expect(renderArrangement(s, a).report.length).toBeCloseTo(4, 9);
  });

  it('déplacer une section, relire un fichier', () => {
    const a = { ...newArrangement(song(), 'A'), sections: ['a', 'b', 'c'] };
    expect(moveSection(a, 2, 0).sections).toEqual(['c', 'a', 'b']);
    const back = sanitizeArrangements(JSON.parse(JSON.stringify([a, { id: 3 }, null, { id: 'x', sections: ['m', 5] }])));
    expect(back).toHaveLength(2);
    expect(back[1].sections).toEqual(['m']);
  });
});
