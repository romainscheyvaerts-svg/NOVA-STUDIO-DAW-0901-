import { describe, expect, it } from 'vitest';
import { activeTakeInZone, compTakeInZone, fmtTime, listTakes, selectTakeActions, takeNumberOf } from '../utils/takes';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('takeNumberOf', () => {
  it('champ dédié prioritaire, sinon le nom « Prise N »', () => {
    expect(takeNumberOf({ takeNumber: 3, name: 'Prise 1' })).toBe(3);
    expect(takeNumberOf({ name: 'Prise 12 · 2' })).toBe(12);
    expect(takeNumberOf({ takeNumber: 0, name: 'Prise 4' })).toBe(4);
    expect(takeNumberOf({ name: 'Mon couplet' })).toBeNull();
    expect(takeNumberOf({})).toBeNull();
  });
});

describe('listTakes / selectTakeActions', () => {
  const track = () => makeTrack({
    id: 'v',
    clips: [
      makeClip({ id: 'a1', takeNumber: 1, start: 0, duration: 5, isMuted: true }),
      makeClip({ id: 'a2', takeNumber: 1, start: 6, duration: 2, isMuted: true }),
      makeClip({ id: 'b', takeNumber: 2, start: 0, duration: 8 }),
      makeClip({ id: 'c', takeNumber: 3, start: 20, duration: 4 }), // ailleurs dans le morceau
      makeClip({ id: 'beat', name: 'Beat' }),
    ],
  });

  it('regroupe les clips par prise, bornes et prise audible', () => {
    expect(listTakes(track())).toEqual([
      { n: 1, clipIds: ['a1', 'a2'], start: 0, end: 8, active: false },
      { n: 2, clipIds: ['b'], start: 0, end: 8, active: true },
      { n: 3, clipIds: ['c'], start: 20, end: 24, active: true },
    ]);
  });

  it('choisir une prise : la réactive, coupe celles qui la recouvrent, laisse les autres', () => {
    expect(selectTakeActions(track(), 1)).toEqual([
      { action: 'MUTE_CLIP', payload: { trackId: 'v', clipId: 'a1', isMuted: false } },
      { action: 'MUTE_CLIP', payload: { trackId: 'v', clipId: 'a2', isMuted: false } },
      { action: 'MUTE_CLIP', payload: { trackId: 'v', clipId: 'b', isMuted: true } },
    ]);
  });

  it('prise déjà audible : rien à faire ; prise inconnue : null', () => {
    expect(selectTakeActions(track(), 2)).toEqual([]);
    expect(selectTakeActions(track(), 7)).toBeNull();
  });
});

describe('comping par zone', () => {
  const track = () => makeTrack({
    clips: [
      makeClip({ id: 'p1', takeNumber: 1, start: 0, duration: 10, fadeIn: 0.02, fadeOut: 0.03 }),
      makeClip({ id: 'p2', takeNumber: 2, start: 0, duration: 10, isMuted: true }),
      makeClip({ id: 'beat', name: 'Beat', start: 0, duration: 10 }),
    ],
  });
  const zone = { start: 4, end: 6, label: 'refrain' };

  it('coupe aux bords de la zone : seule la prise choisie sonne dedans', () => {
    const t = track();
    const out = compTakeInZone(t, 2, zone);
    const p1 = out.filter(c => c.takeNumber === 1);
    const p2 = out.filter(c => c.takeNumber === 2);
    expect(p1.map(c => [c.start, c.duration, c.offset, !!c.isMuted])).toEqual([[0, 4, 0, false], [4, 2, 4, true], [6, 4, 6, false]]);
    expect(p2.map(c => [c.start, c.duration, c.offset, !!c.isMuted])).toEqual([[0, 4, 0, true], [4, 2, 4, false], [6, 4, 6, true]]);
    // Fondus d'origine aux vrais bords, 5 ms aux coupes
    expect([p1[0].fadeIn, p1[0].fadeOut]).toEqual([0.02, 0.005]);
    expect([p1[1].fadeIn, p1[1].fadeOut]).toEqual([0.005, 0.005]);
    expect([p1[2].fadeIn, p1[2].fadeOut]).toEqual([0.005, 0.03]);
    // Clips hors prises intacts, identifiants uniques
    expect(out).toContain(t.clips[2]);
    expect(new Set(out.map(c => c.id)).size).toBe(out.length);
    expect(activeTakeInZone({ ...t, clips: out }, zone)).toBe(2);
    expect(activeTakeInZone({ ...t, clips: out }, { start: 0, end: 4, label: '' })).toBe(1);
  });

  it('clip entièrement dans la zone : garde son id', () => {
    const t = makeTrack({ clips: [makeClip({ id: 'x', takeNumber: 1, start: 4.5, duration: 1, isMuted: true })] });
    const out = compTakeInZone(t, 1, zone);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'x', isMuted: false });
  });

  it('zone vide ou inversée : rien ne change', () => {
    const t = track();
    expect(compTakeInZone(t, 2, { start: 5, end: 5, label: '' })).toBe(t.clips);
    expect(compTakeInZone(t, 2, { start: 6, end: 4, label: '' })).toBe(t.clips);
  });

  it('activeTakeInZone : null si aucune ou plusieurs prises audibles', () => {
    const t = track();
    expect(activeTakeInZone(t, zone)).toBe(1);
    t.clips[1].isMuted = false;
    expect(activeTakeInZone(t, zone)).toBeNull();
    expect(activeTakeInZone(t, { start: 50, end: 60, label: '' })).toBeNull();
  });
});

describe('fmtTime', () => {
  it('m:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(45.9)).toBe('0:45');
    expect(fmtTime(70)).toBe('1:10');
    expect(fmtTime(600)).toBe('10:00');
  });
});
