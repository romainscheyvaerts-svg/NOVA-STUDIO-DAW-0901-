import { describe, expect, it } from 'vitest';
import { nextSectionIndex, placeTake, takeSection } from '../utils/multiTake';
import { Clip, Marker, TakeMeta } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * Séance d'enregistrement voix (audit du 22/10/2026) : prises nommées d'après la section du morceau (« Couplet 2 · Prise 3 »).
 */

const mk = (m: Partial<Marker>): Marker => ({ id: `m-${m.name}-${m.time}`, name: 'Marqueur', time: 0, type: 'MARKER', color: '#fff', ...m });

describe('Nommage auto des prises par section (« Couplet 2 · Prise 3 »)', () => {
  const markers = [mk({ name: 'Intro', time: 0 }), mk({ name: 'Couplet 1', time: 8 }), mk({ name: 'Refrain', time: 30 }), mk({ name: 'Marqueur 4', time: 50 })];
  it('la section qui couvre le plus la prise (élan d’une mesure avant le couplet compris)', () => {
    expect(takeSection(markers, 6, 28)).toBe('Couplet 1');
    expect(takeSection(markers, 31, 40)).toBe('Refrain');
    expect(takeSection(markers, 2, 4)).toBe('Intro');
  });
  it('repère au nom par défaut, de sélection, ou pas de repère : pas de section', () => {
    expect(takeSection(markers, 52, 60)).toBeNull();
    expect(takeSection([], 0, 4)).toBeNull();
    expect(takeSection([mk({ name: 'Couplet 2', time: 0, selection: { end: 10, trackIds: [] } })], 1, 5)).toBeNull();
    expect(takeSection([mk({ name: 'Repère 2', time: 0 })], 1, 5)).toBeNull();
  });
  it('région : elle compte jusqu’à sa fin', () => {
    expect(takeSection([mk({ name: 'Pont', time: 10, type: 'REGION', endTime: 14 }), mk({ name: 'Outro', time: 20 })], 15, 19)).toBeNull();
    expect(takeSection([mk({ name: 'Pont', time: 10, type: 'REGION', endTime: 14 })], 10.5, 13)).toBe('Pont');
  });
  it('rang dans la section : les prises renommées à la main ne comptent pas', () => {
    const meta: TakeMeta[] = [{ n: 1, name: 'Couplet 1 · Prise 1' }, { n: 2, name: 'Couplet 1 · Prise 2' }, { n: 3, name: 'Refrain · Prise 1' }, { n: 4, name: 'la bonne' }];
    expect(nextSectionIndex(meta, 'Couplet 1')).toBe(3);
    expect(nextSectionIndex(meta, 'Refrain')).toBe(2);
    expect(nextSectionIndex(meta, 'Pont')).toBe(1);
  });
  const rec = (start: number, duration: number) => makeClip({ id: `rec-${start}-${duration}`, start, duration, offset: 0, fadeIn: 0.01, fadeOut: 0.01 });
  it('placeTake : clip, couloir et annonce portent le nom ; le numéro de couloir reste global', () => {
    const tr = makeTrack({ clips: [makeClip({ takeNumber: 1, name: 'Prise 1', bufferId: 'b1' })], takeMeta: [{ n: 1 }] });
    const p = placeTake(tr, rec(8, 10), { rec: null, xfade: 0.01, wall: 1, stamp: 's', section: 'Couplet 1' });
    expect(p.takeName).toBe('Couplet 1 · Prise 1');
    const added = p.clips.find(c => c.takeNumber === 2) as Clip;
    expect(added.name).toBe('Couplet 1 · Prise 1');
    expect(p.takeMeta!.find(m => m.n === 2)!.name).toBe('Couplet 1 · Prise 1');
    const tr2 = { ...tr, clips: p.clips, takeMeta: p.takeMeta };
    const p2 = placeTake(tr2, rec(8, 10), { rec: null, xfade: 0.01, wall: 2, stamp: 't', section: 'Couplet 1' });
    expect(p2.takeName).toBe('Couplet 1 · Prise 2');
    expect(p2.firstTake).toBe(3);
  });
  it('Loop Record dans une section : « Couplet 1 · Prises 1 à 3 »', () => {
    const p = placeTake(makeTrack({ clips: [] }), rec(0, 12.5), { rec: { in: null, out: null, isPunch: false, loop: { start: 0, end: 4 }, wall: 5000 }, xfade: 0.01, wall: 1, stamp: 's', section: 'Couplet 1' });
    expect(p.takeName).toBe('Couplet 1 · Prises 1 à 3');
    expect(p.takeMeta!.map(m => m.name)).toEqual(['Couplet 1 · Prise 1', 'Couplet 1 · Prise 2', 'Couplet 1 · Prise 3']);
  });
  it('sans section : « Prise N » comme avant (aucun nom stocké)', () => {
    const p = placeTake(makeTrack({ clips: [] }), rec(0, 4), { rec: null, xfade: 0.01, wall: 1, stamp: 's' });
    expect(p.takeName).toBe('Prise 1');
    expect(p.takeMeta![0].name).toBeUndefined();
  });
});
