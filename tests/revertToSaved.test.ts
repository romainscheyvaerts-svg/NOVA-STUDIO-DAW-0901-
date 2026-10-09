import { describe, expect, it } from 'vitest';
import { findSavedVersion, savedAgo, savedVersionsToKeep } from '../utils/revertToSaved';
import { RecoveryStore, memoryBackend, versionsToPrune } from '../utils/recoveryStore';

const v = (id: number, reason: any, projectId = 'p', extra: any = {}) => ({ id, savedAt: id, reason, projectId, name: 'S', tracks: 1, takes: 0, beatTitle: null, hasLyrics: false, needsCatalogBeat: false, ...extra });

describe('Revenir à la version enregistrée (Pro Tools : Revert to Saved)', () => {
  it('cible : la dernière sauvegarde voulue (sauvegarde ou version nommée), jamais une sauvegarde auto', () => {
    const list = [v(10, 'manual'), v(20, 'auto'), v(30, 'named', 'p', { versionNumber: 2 }), v(40, 'auto'), v(50, 'manual', 'autre')];
    expect(findSavedVersion(list as any, 'p')?.id).toBe(30);
    expect(findSavedVersion([v(1, 'auto'), v(2, 'take')] as any, 'p')).toBeNull();
  });

  it('le ménage automatique garde la dernière sauvegarde de chaque projet', () => {
    const keep = savedVersionsToKeep([v(1, 'manual'), v(2, 'manual'), v(3, 'auto'), v(4, 'manual', 'q')] as any);
    expect([...keep].sort()).toEqual([2, 4]);
  });

  it('dans le magasin : 30 sauvegardes auto après la sauvegarde, elle est toujours là', async () => {
    let now = 1_000_000;
    const store = new RecoveryStore(memoryBackend(), () => now);
    const base = { projectId: 'p', name: 'S', json: '{}', tracks: 1, takes: 0, beatTitle: null, hasLyrics: false, needsCatalogBeat: false, audioIds: [], getAudio: () => null } as any;
    const saved = await store.saveVersion({ ...base, reason: 'manual' });
    for (let i = 0; i < 30; i++) { now += 15_000; await store.saveVersion({ ...base, reason: 'auto' }); }
    const list = await store.listVersions('p');
    expect(list.some(x => x.id === saved!.versionId)).toBe(true);
    expect(versionsToPrune(list, now).length).toBeGreaterThan(0); // les auto en trop, elles, partent
    expect(findSavedVersion(list, 'p')?.id).toBe(saved!.versionId);
  });

  it('« il y a 12 min (14:32) »', () => {
    const t = new Date(2026, 9, 9, 14, 32).getTime();
    expect(savedAgo(t, t + 12 * 60000)).toMatch(/^il y a 12 min \(14:32\)$/);
    expect(savedAgo(t, t + 20000)).toMatch(/^à l’instant/);
    expect(savedAgo(t, t + 86_400_000)).toMatch(/^hier à 14:32$/);
  });
});
