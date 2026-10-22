import { describe, expect, it } from 'vitest';
import { copyInsertToMany, insertCopyGroups, insertCopyMenuItems, nearestInsertTargets } from '../utils/insertCopy';
import { makeTrack } from './helpers/fixtures';

describe('copier un insert sur plusieurs pistes (séance de 60 pistes)', () => {
  const comp = { id: 'c1', type: 'COMPRESSOR', name: 'Compresseur', isEnabled: true, params: { threshold: -20 } } as any;
  const tracks = () => {
    const ts = Array.from({ length: 60 }, (_, i) => makeTrack({ id: `t${i}`, name: `Piste ${i + 1}`, plugins: i === 30 ? [comp] : [], outputTrackId: i >= 28 && i < 34 ? 'bus-voix' : 'master' }));
    return [...ts, makeTrack({ id: 'bus-voix', name: 'Bus Voix', type: 'BUS' as any }), makeTrack({ id: 'master', name: 'Master', type: 'BUS' as any })];
  };
  it('propose le bus de la piste et toutes les pistes ; les voisines d’abord (la 30e d’une séance de 60 est proposée)', () => {
    const all = tracks();
    const g = insertCopyGroups(all[30], all);
    expect(g[0]).toEqual({ label: 'Copier sur les pistes vers « Bus Voix »', ids: ['t28', 't29', 't31', 't32', 't33'] });
    expect(g[1].ids.length).toBe(59);
    expect(nearestInsertTargets(all[30], all, 4).map(t => t.id)).toEqual(['t31', 't29', 't32', 't28']);
    const labels = insertCopyMenuItems(all[30], comp, all, () => {}).map(i => i.label);
    expect(labels[0]).toBe('Copier sur les pistes vers « Bus Voix » (5)');
    expect(labels).toContain('Copier vers « Piste 30 »');
  });
  it('copie sur plusieurs pistes : une copie indépendante par piste, réglages compris', () => {
    const out = copyInsertToMany(tracks(), 't30', 'c1', ['t28', 't29']);
    const a = out.find(t => t.id === 't28')!.plugins[0], b = out.find(t => t.id === 't29')!.plugins[0];
    expect(a.params.threshold).toBe(-20);
    expect(a.id).not.toBe(b.id);
    expect(out.find(t => t.id === 't30')!.plugins).toHaveLength(1);
  });
});
