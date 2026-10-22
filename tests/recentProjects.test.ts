// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { indexIsIncomplete, matchesQuery, mergeRecents, readRecentIndex, rememberRecent } from '../utils/recentProjects';

const e = (projectId: string, versionId: number, name = projectId) => ({ projectId, name, savedAt: versionId, versionId, tracks: 4, takes: 2, beatTitle: null });

describe('Projets récents (Ouvrir un projet › Récents)', () => {
  beforeEach(() => localStorage.clear());

  it('un projet par ligne, le dernier enregistré en tête', () => {
    rememberRecent(e('A', 100));
    rememberRecent(e('B', 200));
    rememberRecent(e('A', 300, 'A renommé'));
    const idx = readRecentIndex();
    expect(idx.map(x => x.projectId)).toEqual(['A', 'B']);
    expect(idx[0]).toMatchObject({ name: 'A renommé', versionId: 300 });
  });

  it("recoupé avec les versions présentes : un projet effacé de l'appareil n'apparaît pas", () => {
    rememberRecent(e('A', 100)); rememberRecent(e('B', 200));
    const l = mergeRecents({ index: readRecentIndex(), deviceIds: new Set([200]) });
    expect(l.map(x => x.projectId)).toEqual(['B']);
  });

  it('le projet ouvert est retiré de la liste ; le disque complète (Nova Studio), la plus récente gagne', () => {
    rememberRecent(e('A', 100)); rememberRecent(e('B', 200));
    const disk = [
      { projectId: 'C', name: 'Client C', latest: { id: 50, savedAt: 50, tracks: 8, takes: 0, beatTitle: 'Drill' } },
      { projectId: 'A', name: 'A', latest: { id: 400, savedAt: 400, tracks: 5, takes: 1, beatTitle: null } },
    ];
    const l = mergeRecents({ index: readRecentIndex(), deviceIds: new Set([100, 200]), disk, excludeProjectId: 'B' });
    expect(l.map(x => [x.projectId, x.source, x.versionId])).toEqual([['A', 'disque', 400], ['C', 'disque', 50]]);
  });

  it("index absent (1re ouverture après la mise à jour) : refait depuis les versions", () => {
    const ids = new Set([100, 200]);
    expect(indexIsIncomplete([], ids)).toBe(true);
    const l = mergeRecents({ index: [], deviceIds: ids, fallback: [
      { id: 100, projectId: 'A', name: 'A', savedAt: 100, tracks: 1, takes: 0, beatTitle: null },
      { id: 200, projectId: 'A', name: 'A', savedAt: 200, tracks: 2, takes: 0, beatTitle: null },
    ] });
    expect(l).toHaveLength(1);
    expect(l[0].versionId).toBe(200);
    rememberRecent(e('A', 200));
    expect(indexIsIncomplete(readRecentIndex(), ids)).toBe(false);
  });

  it('recherche sans accents ni casse', () => {
    expect(matchesQuery({ name: 'Séance Kaaris', beatTitle: null }, 'seance')).toBe(true);
    expect(matchesQuery({ name: 'Mix', beatTitle: 'Drill UK' }, 'drill')).toBe(true);
    expect(matchesQuery({ name: 'Mix', beatTitle: null }, 'trap')).toBe(false);
  });
});
